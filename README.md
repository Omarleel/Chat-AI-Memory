# Chat AI Memory

**Versión 1.0.0**

Motor local para **importar conversaciones de WhatsApp, construir memoria por contacto y redactar borradores** con el estilo de la persona titular del chat. Todo el procesamiento ocurre en tu equipo: los modelos se sirven con Ollama, el estado vive en SQLite y, con la configuración recomendada, ningún mensaje se envía sin aprobación explícita.

## Qué incluye

- **Importación de chats** exportados en TXT, con deduplicación, separación por contacto, perfiles de estilo y búsqueda FTS5.
- **Borradores de respuesta** (`reply`) con recuperación semántica, enrutamiento, revisión de coherencia y varias versiones por mensaje.
- **Consultas a la memoria** (`memory_query`) con citas al historial y a las memorias recuperadas, en modo solo lectura.
- **Grafo de conocimiento** en Neo4j con hechos verificados, cada uno con su cita literal, autor y mensaje de origen.
- **Interfaz web** (React + Tailwind) para importar chats, probar respuestas, gestionar memorias y borradores, explorar el grafo y entrenar identidades.
- **Entrenamiento de identidades** (QLoRA) desde la interfaz, con un ejecutor local con GPU que registra el modelo resultante en Ollama.
- **Herramientas de evaluación offline**: conversaciones reservadas, revisión humana ciega, calibración del revisor y un laboratorio LangGraph que compara configuraciones.
- **Conexión con WhatsApp** mediante WhatsApp Web (QR) o WhatsApp Cloud API, con lista de contactos permitidos y consentimiento.

## Arquitectura

| Componente | Responsabilidad |
| --- | --- |
| Motor Node.js ESM (`src/`) | WhatsApp, importación, recuperación, inferencia, permisos y persistencia |
| FastAPI (`api/`) | Swagger, proxy administrativo autenticado y servidor de la UI en `/ui/` |
| UI React + Tailwind (`ui/`) | Interfaz administrativa local |
| Ejecutor de entrenamiento (`scripts/training-runner.mjs`) | Proceso con GPU, fuera de Docker, que entrena LoRA y despliega en Ollama |
| SQLite | Fuente de verdad: contactos, mensajes, borradores, sesiones, perfiles, hechos y trabajos |
| Qdrant | Índice vectorial reconstruible del historial y las memorias |
| Neo4j | Proyección reconstruible de los hechos verificados |
| Ollama | Modelo de estilo, modelo de razonamiento, embeddings y juez local |
| LangGraph (`src/agents/`, `src/lab/`) | Laboratorio offline de evaluación y propuesta de cambios |

Detalle completo en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requisitos

- Node.js **>= 26.12.1** y npm.
- Docker Compose (la configuración incluida reserva una GPU NVIDIA para Ollama).
- Python 3 con `api/requirements.txt` para FastAPI y las pruebas; PyTorch con CUDA, PEFT y bitsandbytes para entrenar.

## Puesta en marcha

```powershell
Copy-Item .env.example .env
# Edita .env: ADMIN_TOKEN, SELF_DISPLAY_NAME, ALLOWED_CONTACTS, contraseñas y modelos
npm install
docker compose up -d --build
docker compose exec ollama ollama pull embeddinggemma
```

- Interfaz web: **http://127.0.0.1:8000/ui/** (entra con el `ADMIN_TOKEN` de `.env`).
- Swagger: **http://127.0.0.1:8000/docs**.

Todos los servicios se publican solo en `127.0.0.1`.

### Importar un chat

Desde la interfaz, desde Swagger (`POST /api/v1/chats/import`) o por CLI:

```powershell
npm run import -- --file imports/chat.txt --contact 51999999999 --self "Titular" --peer "Interlocutor"
```

### Entrenar una identidad

Crea el trabajo en **Entrenar identidad** dentro de la UI y deja abierto el ejecutor en el equipo con GPU:

```powershell
npm run training:runner   # requiere el entorno .venv-lora
```

### Desarrollo de la UI

```powershell
npm run ui:dev   # http://127.0.0.1:5173/ui/, reenvía /api a FastAPI
```

## Pruebas

```powershell
npm test                          # 231 pruebas Node (unitarias e integración)
python -m pytest -q tests/python  # 18 pruebas de FastAPI y entrenamiento
npm run test:ui                   # 9 pruebas de la interfaz
```

Las pruebas usan dobles y fixtures sintéticos; no necesitan WhatsApp, Ollama ni servicios externos.

## Privacidad

- `.env`, bases de datos, chats importados, sesiones de WhatsApp, datasets y resultados de evaluación quedan fuera del control de versiones (`imports/`, `data/`).
- `AUTO_SEND=false` (valor por defecto) deja cada respuesta como borrador hasta que la apruebes.
- Imitar el estilo de una persona requiere su consentimiento y transparencia con los participantes.

Más en [docs/SECURITY.md](docs/SECURITY.md).

## Documentación

- [Estado y límites](docs/PROJECT_STATUS.md)
- [Arquitectura y componentes](docs/ARCHITECTURE.md)
- [Operación, importaciones y API](docs/OPERATIONS.md)
- [Datos, entrenamiento y evaluación reservada](docs/DATA_AND_TRAINING.md)
- [Laboratorio de evaluación](docs/LABORATORY.md)
- [Seguridad y privacidad](docs/SECURITY.md)
- [Pruebas](docs/TESTING.md)

**Nota:** ninguna métrica automática demuestra que un borrador sea indistinguible de la persona real. Evalúa con conversaciones reservadas y revisión humana.
