# Operación e interfaces

## Requisitos

- Node.js `>=26.12.1` y npm; Python con `api/requirements.txt` para FastAPI y con dependencias de entrenamiento si usarás QLoRA.
- Docker Compose para Node, FastAPI, Qdrant, Neo4j y Ollama en contenedores (requiere GPU NVIDIA para la reserva definida en `compose.yaml`). Se admite un servicio Ollama externo con `OLLAMA_URL`.
- Opcional, para el laboratorio con agentes externos: la CLI `agy` autenticada (ver [LABORATORY.md](LABORATORY.md)).

## Primer arranque

```powershell
Copy-Item .env.example .env
# Editar ADMIN_TOKEN (32+ caracteres), QDRANT_API_KEY, NEO4J_PASSWORD,
# SELF_DISPLAY_NAME, ALLOWED_CONTACTS, modelos, URLs y AUTO_SEND=false.
npm install
docker compose up -d --build
docker compose exec ollama ollama pull embeddinggemma
```

Abre `http://127.0.0.1:8000/docs` para Swagger. `ADMIN_TOKEN` es obligatorio para recursos administrativos. Los endpoints Node se escuchan en `http://127.0.0.1:3000` en la instalación Docker predeterminada.

En WhatsApp Web, revisa `docker compose logs -f app` para el QR; también puedes obtenerlo con `GET /api/v1/whatsapp/qr.svg` (Swagger) o `GET /api/whatsapp/qr.svg` (Node) autenticados. `WA_PROVIDER=cloud` utiliza los tokens y webhook de Meta en lugar del QR.

## Carga e inspección de chats

Importa desde Swagger con `POST /api/v1/chats/import` (archivo TXT, contacto, titular, interlocutor) o CLI:

```powershell
npm run import -- --file imports/chat.txt --contact 51999999999 --self "Titular" --peer "Interlocutor"
```

Las exportaciones deben venir de chats autorizados. Los mensajes importados quedan asociados a un contacto específico; si cambias configuración de memoria o embeddings, realiza una reimportación **controlada**, respaldando antes SQLite y volúmenes.

### Endpoints FastAPI

| Operación | Endpoint |
| --- | --- |
| Estado | `GET /health`, `GET /api/v1/whatsapp/status` |
| QR (Web) | `GET /api/v1/whatsapp/qr.svg` |
| Contactos y borradores | `GET /api/v1/contacts`, `GET /api/v1/drafts` |
| Enviar borrador aprobado | `POST /api/v1/drafts/{draft_id}/send` |
| Simular respuesta o memoria | `POST /api/v1/preview` |
| Historial de simulación | `GET /api/v1/preview/history`, `DELETE /api/v1/preview/history` |
| RAG | `POST /api/v1/rag/search`, `GET /api/v1/rag/metrics` |
| Memorias | `GET/POST /api/v1/memories`, `DELETE /api/v1/memories/{memory_id}` |
| Importaciones | `GET /api/v1/chats/imports`, `POST /api/v1/chats/import` |

`preview` acepta `contact`, `text`, `session_id`, `mode=reply|memory_query`, `rag_policy=auto|force|off` y opcionalmente `recent_messages`. Los turnos de simulación solo se guardan cuando procede y `save=true`; `memory_query` es de solo lectura. El estado del borrador no implica autorización para enviarlo.

## Operación del laboratorio

```powershell
npm run lab:doctor
npm run lab:status
npm run lab:benchmark -- --dataset examples/lab-demo.jsonl --candidate-model mi-modelo:latest --min-turns 1
```

Configuración detallada, permisos y consentimiento remoto: [LABORATORY.md](LABORATORY.md). Preparación de dataset y entrenamiento: [DATA_AND_TRAINING.md](DATA_AND_TRAINING.md).

## Reinicio y limpieza de bases de datos

Para reiniciar el flujo de importación y simulación en `/preview` desde cero, puedes vaciar las bases de datos (SQLite, Qdrant y Neo4j) de dos formas:

### Opción A: Reinicio limpio de volúmenes Docker (Recomendada)
Elimina los datos de las bases de datos preservando el volumen de pesos y modelos de Ollama (`chat-ai-memory_ollama_models`) para evitar descargar nuevamente los modelos LLM:

```powershell
# 1. Detener los servicios
docker compose down

# 2. Eliminar exclusivamente los volúmenes de datos
docker volume rm chat-ai-memory_sqlite_data chat-ai-memory_qdrant_data chat-ai-memory_neo4j_data chat-ai-memory_chat_uploads

# 3. (Opcional) Si ejecutaste scripts locales fuera de Docker, elimina el SQLite local
Remove-Item data\memory.sqlite -ErrorAction SilentlyContinue

# 4. Volver a levantar todos los servicios
docker compose up -d
```
Al iniciar, Node.js inicializará automáticamente el esquema limpio de SQLite, y las colecciones en Qdrant y nodos en Neo4j se recrearán en la primera importación.

### Opción B: Limpieza en caliente (Sin apagar Docker)
Si prefieres vaciar las bases de datos mientras los contenedores continúan en ejecución:

1. **Qdrant (Vector Store)**: Eliminar la colección `chat_memory`:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:6333/collections/chat_memory" -Method Delete
   ```
2. **Neo4j (Knowledge Graph)**: Eliminar todos los nodos y relaciones vía Cypher:
   ```powershell
   docker compose exec neo4j cypher-shell -u neo4j -p secretpassword "MATCH (n) DETACH DELETE n;"
   ```
3. **SQLite**: Eliminar el archivo de base de datos dentro del contenedor y reiniciar el servicio de aplicación:
   ```powershell
   docker compose exec app rm -f /app/data/memory.sqlite
   docker compose restart app
   ```

## Despliegue y actualización con Docker

### Levantar todos los servicios
Asegúrate de que todos los servicios dependientes (`app`, `fastapi`, `qdrant`, `neo4j`, `ollama`) estén en ejecución:
```powershell
docker compose up -d
```

### Aplicar cambios de código o dependencias
- **Cambios en código fuente (`src/`, `scripts/`)**: Se reflejan de inmediato ya que están montados como volúmenes en `compose.yaml`. Si modificaste la lógica de la app o FastAPI, reinicia los contenedores correspondientes:
  ```powershell
  docker compose restart app fastapi
  ```
- **Cambios en dependencias o Dockerfiles (`package.json`, `api/requirements.txt`, `Dockerfile`)**: Reconstruye las imágenes antes de iniciar:
  ```powershell
  docker compose up -d --build
  ```

### Verificación y paneles de control
Verifica que todos los contenedores estén sanos (`healthy` o `Up`):
```powershell
docker compose ps
```

Paneles disponibles en el entorno local:
- **Qdrant Dashboard**: [http://localhost:6333/dashboard](http://localhost:6333/dashboard)
- **Neo4j Browser**: [http://localhost:7474/browser/](http://localhost:7474/browser/) (Usuario: `neo4j`, Contraseña: la definida en `NEO4J_PASSWORD` o `secretpassword`)
- **FastAPI Swagger Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)
- **Servicio Node.js**: [http://localhost:3000](http://localhost:3000)

## Respaldo y recuperación

Antes de actualizar el código o promover experimentos, respalda tu `.env`, el volumen SQLite, el índice Qdrant, Neo4j, los modelos de Ollama y las sesiones de WhatsApp. El repositorio no contiene estos elementos. `lab:apply` genera respaldos de archivos tocados, **no una instantánea de todos los servicios**.
