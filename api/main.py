"""Local, token-protected Swagger API for the existing Node.js assistant.

Never connects directly to SQLite or Qdrant: the Node application is the single
owner of all state. Uploaded TXT files use a private shared Docker volume.
"""

import hmac
import os
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Path as ApiPath, Query, UploadFile, status
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, StringConstraints, field_validator

MAX_IMPORT_BYTES = 50 * 1024 * 1024
NODE_URL = os.getenv("NODE_URL", "http://app:3000").rstrip("/")
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/uploads"))
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
UI_DIR = Path(os.getenv("UI_DIR", str(Path(__file__).parent / "static")))

app = FastAPI(
    title="Chat AI Memory — API de pruebas",
    description=(
        "API administrativa local para probar WhatsApp, los borradores y la memoria. "
        "En **Authorize** introduce el `ADMIN_TOKEN` de `.env` (sin `Bearer`). "
        "Las importaciones vinculan los TXT al **contacto** (teléfono internacional), "
        "no a un chat compartido entre contactos."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    swagger_ui_parameters={"persistAuthorization": True},
)
security = HTTPBearer(auto_error=False)
Phone = Annotated[str, StringConstraints(pattern=r"^\d{8,15}$")]
PreviewSession = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", max_length=64)]
TrainingJobId = Annotated[str, ApiPath(pattern=r"^train_[a-z0-9]+_[a-f0-9]{8}$")]
ImportHash = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{16,64}$")]


# La interfaz web es estática y del mismo origen: CSP estricta, sin scripts externos ni marcos.
@app.middleware("http")
async def ui_security_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/ui"):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
    return response


async def authorize(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)]):
    if (not credentials or credentials.scheme.lower() != "bearer"
            or len(ADMIN_TOKEN) < 32
            or not hmac.compare_digest(credentials.credentials, ADMIN_TOKEN)):
        raise HTTPException(status_code=401, detail="No autorizado", headers={"WWW-Authenticate": "Bearer"})


async def backend(method: str, path: str, *, payload: dict | None = None,
                  params: dict | None = None, timeout: float = 60.0):
    """One authenticated hop; preserve controlled errors and upstream status."""
    try:
        async with httpx.AsyncClient(base_url=NODE_URL, timeout=timeout, trust_env=False) as client:
            response = await client.request(
                method, path,
                headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
                json=payload, params=params,
            )
    except (httpx.TimeoutException, httpx.RequestError) as exc:
        raise HTTPException(status_code=502, detail="El motor Node.js no está disponible") from exc
    if response.status_code >= 400:
        try:
            error = response.json()
            detail = str(error.get("error", "Error del motor Node.js"))
            if error.get("code"):
                detail += f" [{error['code']}]"
            if error.get("hint"):
                detail += f". {error['hint']}"
        except (ValueError, AttributeError):
            detail = "Error del motor Node.js"
        raise HTTPException(status_code=response.status_code, detail=detail)
    if "image/svg+xml" in response.headers.get("content-type", ""):
        return Response(content=response.content, media_type="image/svg+xml", headers={"Cache-Control": "no-store"})
    return response.json()


class PreviewRequest(BaseModel):
    contact: Phone = Field(description="Número internacional sin +; debe estar en ALLOWED_CONTACTS", examples=["51999999999"])
    text: str = Field(min_length=1, max_length=4000, examples=["¿De qué hablamos el viernes?"])
    session_id: PreviewSession = Field(
        default='default', description='Identificador independiente por prueba y contacto. default conserva el hilo entre llamadas.')
    save: bool = Field(default=True, description='Solo reply: guarda ambos turnos en SQLite. No indexa en Qdrant.')
    debug_rag: bool = Field(default=False, description='Solo administración: muestra fragmentos seleccionados y estadísticas de recuperación; puede contener texto privado.')
    rag_policy: Literal['auto', 'force', 'off'] = Field(
        default='auto',
        description=('Solo reply. auto consulta un router semántico sobre la utilidad de recuerdos; '
                     'force recupera fragmentos para comparar; off no consulta Qdrant. '
                     'No altera el historial ni el envío.'))
    mode: Literal["reply", "memory_query"] = Field(
        default="reply",
        description=("reply: el interlocutor pregunta y se redacta un mensaje breve como tu estilo; "
                     "memory_query: tú consultas PRIVADAMENTE los recuerdos, sin imitar a nadie ni enviar WhatsApp."),
    )
    recent_messages: list[dict] | None = Field(
        default=None,
        examples=[None],
        description=("Lista opcional de turnos recientes [{'side': 'peer', 'text': '...'}, {'side': 'self', 'text': '...'}]; "
                     "también admite role/content. Omítelo o usa null para usar el historial de session_id.")
    )
    writer_model: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9_.:/-]{1,80}$",
        description="Solo reply: redactor alternativo instalado en Ollama (p. ej. una identidad recién entrenada). El revisor no cambia.")
    include_recent: bool = Field(
        default=False,
        description="Si es True y no hay recent_messages ni sesión previa, toma los últimos turnos reales del chat importado."
    )

    @field_validator("recent_messages", mode="before")
    @classmethod
    def filter_recent_messages(cls, v):
        # Un turno incompleto (p. ej. el ejemplo {"additionalProp1": {}} de Swagger) se rechaza:
        # descartarlo en silencio sustituía el hilo pedido por el historial de la sesión.
        if not v:
            return None
        if not isinstance(v, list):
            raise ValueError("recent_messages debe ser una lista")
        for m in v:
            text = m.get("text", m.get("content")) if isinstance(m, dict) else None
            if not isinstance(m, dict) or not (m.get("side") or m.get("role")) or not isinstance(text, str) or not text.strip():
                raise ValueError('cada turno necesita side/role y text/content, p. ej. {"side": "peer", "text": "..."}')
        return v


class TrainingSource(BaseModel):
    contact: Phone
    importHash: ImportHash


class TrainingCleaning(BaseModel):
    timeSplit: bool = Field(default=False, description="Corta las ráfagas del titular en pausas de 2 min o más (solo train)")
    bursts: Literal["none", "llm"] = Field(default="none", description="llm: conserva solo lo que responde, según etiquetas del modelo general")


class TrainingPlanRequest(BaseModel):
    sources: list[TrainingSource] = Field(min_length=1, max_length=50)
    selfName: str | None = Field(default=None, max_length=100)
    cleaning: TrainingCleaning | None = None


class BurstLabelingRequest(BaseModel):
    sources: list[TrainingSource] = Field(min_length=1, max_length=50)
    selfName: str | None = Field(default=None, max_length=100)
    limit: int | None = Field(default=None, ge=1, le=100000)


class TrainingJobRequest(TrainingPlanRequest):
    modelName: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{1,40}$", description="Nombre del modelo en Ollama (sin etiqueta)")
    quant: Literal["q4_K_M", "q8_0"] = "q4_K_M"
    baseModel: str = Field(default="Qwen/Qwen2.5-7B-Instruct", max_length=120)
    steps: int = Field(default=400, ge=10, le=20000)
    learningRate: float = Field(default=5e-5, ge=1e-6, le=1e-3)
    maxLength: int = Field(default=1024, ge=256, le=4096)
    validateOnly: bool = Field(default=False, description="Solo audita máscaras y tokenización; no entrena ni despliega")
    keepMerged: bool = Field(default=False, description="Conserva el modelo fusionado (~15 GB) tras el despliegue")


class MemoryRequest(BaseModel):
    contact: Phone
    fact: str = Field(min_length=1, max_length=1000, examples=["Le gusta el fútbol los sábados"])


@app.get("/health", tags=["Sistema"])
async def health():
    """Solo prueba la disponibilidad de FastAPI, no la de WhatsApp."""
    return {"ok": True, "service": "fastapi"}


@app.get("/api/v1/whatsapp/status", tags=["WhatsApp"])
async def whatsapp_status(_: Annotated[None, Depends(authorize)]):
    return await backend("GET", "/api/whatsapp/status")


@app.get("/api/v1/whatsapp/qr.svg", tags=["WhatsApp"], responses={200: {"content": {"image/svg+xml": {}}}})
async def whatsapp_qr(_: Annotated[None, Depends(authorize)]):
    return await backend("GET", "/api/whatsapp/qr.svg")


@app.get("/api/v1/contacts", tags=["Contactos"])
async def contacts(_: Annotated[None, Depends(authorize)]):
    """Lista de números autorizados y estado de consentimiento."""
    return await backend("GET", "/api/contacts")


@app.get("/api/v1/drafts", tags=["Borradores"])
async def drafts(_: Annotated[None, Depends(authorize)]):
    return await backend("GET", "/api/drafts")


@app.post("/api/v1/drafts/{draft_id}/send", tags=["Borradores"])
async def send_draft(draft_id: Annotated[str, ApiPath(min_length=1, max_length=220)],
                     _: Annotated[None, Depends(authorize)]):
    """¡Envía realmente un WhatsApp! Requiere consentimiento; preferir AUTO_SEND=false."""
    # Encode each path segment; reject slash traversal regardless of client encoding.
    if "/" in draft_id or "\\" in draft_id or not all(c.isalnum() or c in "_.:-" for c in draft_id):
        raise HTTPException(status_code=422, detail="ID de borrador inválido")
    return await backend("POST", f"/api/drafts/{draft_id}/send")


@app.post("/api/v1/preview", tags=["Pruebas"])
async def preview(data: PreviewRequest, _: Annotated[None, Depends(authorize)]):
    """Dos modos SIN envío: reply simula un WhatsApp del interlocutor; memory_query responde a tu propia consulta.

    reply recupera turnos anteriores de (contact, session_id) y, por defecto, registra
    el mensaje simulado y la respuesta en SQLite, SIN contaminar WhatsApp ni Qdrant.
    debug_rag muestra fragmentos seleccionados (contenido privado).
    memory_query es de solo lectura, nunca guarda un turno de prueba y devuelve
    `evidence` con referencias H1... y M1....
    """
    return await backend("POST", "/api/preview", payload=data.model_dump(), timeout=300.0)


class RagSearchRequest(BaseModel):
    contact: Phone
    question: str = Field(min_length=1, max_length=2500)


@app.post('/api/v1/rag/search', tags=['Diagnóstico RAG'])
async def rag_search(data: RagSearchRequest, _: Annotated[None, Depends(authorize)]):
    """Consulta la recuperación sin generar respuesta ni guardar mensajes."""
    return await backend('POST', '/api/rag/search', payload=data.model_dump(), timeout=240.0)


@app.get('/api/v1/rag/metrics', tags=['Diagnóstico RAG'])
async def rag_metrics(_: Annotated[None, Depends(authorize)]):
    """Contadores agregados del proceso actual, sin textos de conversaciones."""
    return await backend('GET', '/api/rag/metrics')


@app.get('/api/v1/preview/history', tags=['Pruebas'])
async def preview_history(
    contact: Annotated[Phone, Query(description='Contacto de la simulación')],
    _: Annotated[None, Depends(authorize)],
    session_id: Annotated[PreviewSession, Query()] = 'default',
    limit: Annotated[int, Query(ge=1, le=300)] = 50,
):
    """Lee los turnos de una simulación; no incluye mensajes reales de WhatsApp."""
    return await backend('GET', '/api/preview/history', params={
        'contact': contact, 'session_id': session_id, 'limit': limit})


@app.delete('/api/v1/preview/history', tags=['Pruebas'])
async def clear_preview_history(
    contact: Annotated[Phone, Query(description='Contacto de la simulación')],
    _: Annotated[None, Depends(authorize)],
    session_id: Annotated[PreviewSession, Query()] = 'default',
):
    """Borra SOLO la simulación seleccionada, no el TXT, Qdrant ni WhatsApp."""
    return await backend('DELETE', '/api/preview/history', params={
        'contact': contact, 'session_id': session_id})


@app.get("/api/v1/memories", tags=["Memorias"])
async def memories(contact: Annotated[Phone, Query(description="Número al que pertenecen los recuerdos")],
                   _: Annotated[None, Depends(authorize)]):
    return await backend("GET", "/api/memories", params={"contact": contact})


@app.post("/api/v1/memories", tags=["Memorias"], status_code=status.HTTP_201_CREATED)
async def create_memory(data: MemoryRequest, _: Annotated[None, Depends(authorize)]):
    """Agrega un recuerdo explícito, separado del historial TXT recuperado mediante RAG."""
    return await backend("POST", "/api/memories", payload=data.model_dump(), timeout=300.0)


@app.delete("/api/v1/memories/{memory_id}", tags=["Memorias"])
async def delete_memory(memory_id: Annotated[int, ApiPath(ge=1)],
                        contact: Annotated[Phone, Query()],
                        _: Annotated[None, Depends(authorize)]):
    return await backend("DELETE", "/api/memories", params={"contact": contact, "id": memory_id})


@app.get("/api/v1/chats/imports", tags=["Historial TXT"])
async def chat_imports(contact: Annotated[Phone, Query(description="Contacto WhatsApp vinculado al chat")],
                       _: Annotated[None, Depends(authorize)]):
    """Verifica qué archivos TXT se vincularon a la memoria de este contacto."""
    return await backend("GET", "/api/chats/imports", params={"contact": contact})


@app.post("/api/v1/chats/import", tags=["Historial TXT"])
async def import_chat(
    _: Annotated[None, Depends(authorize)],
    file: Annotated[UploadFile, File(description="Exportación de un chat individual de WhatsApp, sin multimedia (.txt)")],
    contact: Annotated[Phone, Form(description="Número internacional real del interlocutor, sin +")],
    self: Annotated[str, Form(min_length=1, max_length=100, description="Nombre EXACTO de tu autor en el TXT")],
    peer: Annotated[str, Form(min_length=1, max_length=100, description="Nombre EXACTO del interlocutor en el TXT")],
):
    """Importa y asocia un TXT al contacto; indexa en Qdrant/SQLite y guarda su relación.

    Operación síncrona: un chat grande puede tardar varios minutos por los embeddings.
    El mismo TXT para el mismo contacto se reconoce por SHA-256 y no se duplica.
    """
    if not (file.filename or "").lower().endswith(".txt"):
        raise HTTPException(status_code=415, detail="Solo se admiten archivos .txt exportados de WhatsApp")
    if self.strip().casefold() == peer.strip().casefold():
        raise HTTPException(status_code=422, detail="Los nombres self y peer deben ser distintos")
    UPLOAD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp_name = f"upload-{uuid4().hex}.txt"
    temp_path = UPLOAD_DIR / temp_name
    size = 0
    try:
        with temp_path.open("xb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_IMPORT_BYTES:
                    raise HTTPException(status_code=413, detail="TXT demasiado grande: máximo 50 MiB")
                out.write(chunk)
        if not size:
            raise HTTPException(status_code=422, detail="TXT vacío")
        return await backend(
            "POST", "/api/chats/import",
            payload={"filename": temp_name, "contact": contact, "self": self.strip(),
                     "peer": peer.strip(), "originalFilename": file.filename.replace("\\", "/").split("/")[-1][:200]},
            timeout=1800.0,
        )
    finally:
        await file.close()
        temp_path.unlink(missing_ok=True)


@app.get("/api/v1/system", tags=["Sistema"])
async def system_summary(_: Annotated[None, Depends(authorize)]):
    """Configuración activa (modelos, pipeline, envío automático) sin secretos."""
    return await backend("GET", "/api/system")


@app.get("/api/v1/models", tags=["Modelos"])
async def models(_: Annotated[None, Depends(authorize)]):
    """Modelos instalados en Ollama, su uso de VRAM y su papel (redactor, revisor, embeddings)."""
    return await backend("GET", "/api/models")


@app.get("/api/v1/training/sources", tags=["Entrenamiento"])
async def training_sources(_: Annotated[None, Depends(authorize)]):
    """Chats importados que pueden formar el dataset de una identidad."""
    return await backend("GET", "/api/training/sources")


@app.get("/api/v1/training/runner", tags=["Entrenamiento"])
async def training_runner(_: Annotated[None, Depends(authorize)]):
    """Estado del ejecutor local (scripts/training-runner.mjs) que usa la GPU."""
    return await backend("GET", "/api/training/runner")


@app.post("/api/v1/training/plan", tags=["Entrenamiento"])
async def training_plan(data: TrainingPlanRequest, _: Annotated[None, Depends(authorize)]):
    """Cuenta los ejemplos de train/validation/test sin crear un trabajo ni devolver textos."""
    return await backend("POST", "/api/training/plan", payload=data.model_dump(exclude_none=True), timeout=300.0)


@app.get("/api/v1/training/cleaning", tags=["Entrenamiento"])
async def burst_labeling_status(_: Annotated[None, Depends(authorize)]):
    return await backend("GET", "/api/training/cleaning")


@app.post("/api/v1/training/cleaning/label", tags=["Entrenamiento"], status_code=status.HTTP_202_ACCEPTED)
async def start_burst_labeling(data: BurstLabelingRequest, _: Annotated[None, Depends(authorize)]):
    """Etiqueta en segundo plano las ráfagas de train con REASONING_MODEL (reanudable)."""
    return await backend("POST", "/api/training/cleaning/label", payload=data.model_dump(exclude_none=True), timeout=300.0)


@app.post("/api/v1/training/cleaning/pause", tags=["Entrenamiento"])
async def pause_burst_labeling(_: Annotated[None, Depends(authorize)]):
    return await backend("POST", "/api/training/cleaning/pause")


@app.get("/api/v1/training/jobs", tags=["Entrenamiento"])
async def training_jobs(_: Annotated[None, Depends(authorize)]):
    return await backend("GET", "/api/training/jobs")


@app.post("/api/v1/training/jobs", tags=["Entrenamiento"], status_code=status.HTTP_201_CREATED)
async def create_training_job(data: TrainingJobRequest, _: Annotated[None, Depends(authorize)]):
    """Encola un entrenamiento LoRA. Lo ejecuta el runner local; mientras entrena, Ollama libera la GPU."""
    return await backend("POST", "/api/training/jobs", payload=data.model_dump(exclude_none=True), timeout=300.0)


@app.get("/api/v1/training/jobs/{job_id}", tags=["Entrenamiento"])
async def training_job(job_id: TrainingJobId, _: Annotated[None, Depends(authorize)],
                       after_log: Annotated[int, Query(ge=0)] = 0):
    return await backend("GET", f"/api/training/jobs/{job_id}", params={"after_log": after_log})


@app.post("/api/v1/training/jobs/{job_id}/cancel", tags=["Entrenamiento"])
async def cancel_training_job(job_id: TrainingJobId, _: Annotated[None, Depends(authorize)]):
    return await backend("POST", f"/api/training/jobs/{job_id}/cancel")


@app.post("/api/v1/training/jobs/{job_id}/retry", tags=["Entrenamiento"])
async def retry_training_job(job_id: TrainingJobId, _: Annotated[None, Depends(authorize)]):
    """Vuelve a encolar un trabajo fallido; el ejecutor reanuda desde su último checkpoint."""
    return await backend("POST", f"/api/training/jobs/{job_id}/retry")


@app.post("/api/v1/training/jobs/{job_id}/calibrate-reviewer", tags=["Entrenamiento"])
async def calibrate_reviewer(job_id: TrainingJobId, _: Annotated[None, Depends(authorize)]):
    """Mide en segundo plano cuántas respuestas reales reservadas del titular rechaza el revisor."""
    return await backend("POST", f"/api/training/jobs/{job_id}/calibrate-reviewer")


class GraphContactRequest(BaseModel):
    contact: Phone


class GraphExtractionRequest(GraphContactRequest):
    importHash: ImportHash
    maxMessages: int | None = Field(default=None, ge=16, le=200000,
                                    description="Limita la tanda (piloto); sin valor recorre hasta el final o hasta pausar")


@app.get("/api/v1/graph/status", tags=["Grafo"])
async def graph_status(contact: Annotated[Phone, Query()], _: Annotated[None, Depends(authorize)]):
    """Estado de la extracción por chat importado y recuento de entidades y relaciones."""
    return await backend("GET", "/api/graph/status", params={"contact": contact})


@app.post("/api/v1/graph/extraction/start", tags=["Grafo"], status_code=status.HTTP_202_ACCEPTED)
async def graph_extraction_start(data: GraphExtractionRequest, _: Annotated[None, Depends(authorize)]):
    """Extrae hechos verificados con REASONING_MODEL en segundo plano; reanuda desde el último mensaje procesado."""
    return await backend("POST", "/api/graph/extraction/start", payload=data.model_dump(exclude_none=True))


@app.post("/api/v1/graph/extraction/pause", tags=["Grafo"])
async def graph_extraction_pause(data: GraphContactRequest, _: Annotated[None, Depends(authorize)]):
    return await backend("POST", "/api/graph/extraction/pause", payload=data.model_dump())


@app.post("/api/v1/graph/rebuild", tags=["Grafo"])
async def graph_rebuild(data: GraphContactRequest, _: Annotated[None, Depends(authorize)]):
    """Regenera la proyección en Neo4j desde SQLite (solo hechos verificados)."""
    return await backend("POST", "/api/graph/rebuild", payload=data.model_dump(), timeout=600.0)


@app.post("/api/v1/graph/review", tags=["Grafo"], status_code=status.HTTP_202_ACCEPTED)
async def graph_review(data: GraphContactRequest, _: Annotated[None, Depends(authorize)]):
    """Revisa los hechos guardados con el verificador actual (arista + contexto) y regenera la proyección al terminar."""
    return await backend("POST", "/api/graph/review", payload=data.model_dump())


@app.get("/api/v1/graph/entities", tags=["Grafo"])
async def graph_entities(contact: Annotated[Phone, Query()], _: Annotated[None, Depends(authorize)],
                         q: Annotated[str, Query(max_length=80)] = ""):
    return await backend("GET", "/api/graph/entities", params={"contact": contact, "q": q})


@app.get("/api/v1/graph/entity", tags=["Grafo"])
async def graph_entity(contact: Annotated[Phone, Query()], key: Annotated[str, Query(min_length=1, max_length=120)],
                       _: Annotated[None, Depends(authorize)]):
    """Relaciones de una entidad con su cita, autor, fecha y origen (llm verificado o reglas)."""
    return await backend("GET", "/api/graph/entity", params={"contact": contact, "key": key})


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse("/ui/" if UI_DIR.is_dir() else "/docs")


if UI_DIR.is_dir():
    app.mount("/ui", StaticFiles(directory=UI_DIR, html=True), name="ui")
