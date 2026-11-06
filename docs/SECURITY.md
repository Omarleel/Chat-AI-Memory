# Privacidad, aislamiento y operación segura

## Información sensible

El `.env`, mensajes importados, SQLite real, volúmenes Docker, sesión WhatsApp, pruebas basadas en chats y diagnósticos del laboratorio pueden contener secretos o datos personales. Nunca comitearlos ni distribuirlos dentro de un paquete de código. Se excluyen mediante `.gitignore` y `.dockerignore`; **revisa la lista de archivos antes de publicar o compartir el código**.

Mantén el histórico privado bajo `imports/`, la base y cachés bajo `data/`, y los resultados bajo `data/lab`. Realiza respaldo antes de reinstalar o importar. No sustituyas volúmenes de Docker al actualizar código.

## Consentimiento y control del mensaje

- `ALLOWED_CONTACTS` limita destinatarios y el flujo de eventos exige consentimiento de contactos habilitados.
- `AUTO_SEND=false` genera borradores para revisión. El endpoint de envío de borradores se debe utilizar solamente después de autorización explícita.
- Los modos de previsualización y laboratorio **no equivalen** a una autorización de envío.
- Generar respuestas al estilo de una persona debe hacerse con consentimiento y transparencia ante los participantes; evita suplantación engañosa.

## Servicios y fronteras

- API Node y FastAPI, Qdrant, Neo4j y Ollama publicados solo en loopback por Docker Compose, salvo configuración explícita de proxy/reverse proxy. Autentica recursos administrativos con `ADMIN_TOKEN` fuerte.
- Los agentes externos del laboratorio reciben únicamente evidencia agregada. `src/agents/antigravity-cli.mjs` los ejecuta en un directorio temporal sin el repositorio ni secretos del entorno; eso no equivale a aislar el host.
- El juez Ollama puede funcionar localmente; NVIDIA NIM es **remoto** y recibe texto de evaluación. Requiere API key y `LAB_JUDGE_REMOTE_CONSENT=YES` además del consentimiento efectivo para compartir mensajes.
- No ejecutes `--unsafe-code-experiments` junto a secretos o datos sensibles: cambios de código experimentales no están aislados a nivel proceso. Usar una VM o contenedor desechable restringido.
- La bibliografía externa recibe consultas genéricas, no mensajes del chat.

## Promoción de cambios

`lab:apply` exige experimento aprobado y confirmación explícita; crea copias de archivos afectados, pero **no respalda las bases externas ni la sesión WhatsApp**. Verifica el diff, ejecuta suites completas y reinicia los servicios de forma controlada.
