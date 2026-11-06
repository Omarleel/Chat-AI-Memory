# Estado del proyecto — versión 1.0.0

Este documento describe **el comportamiento del código incluido**, no un cronograma ni una garantía sobre servicios externos.

## Funcionalidad

- Importación de chats exportados de WhatsApp (TXT), deduplicación, índices FTS5, perfiles de estilo y separación por contacto.
- Dos modos de previsualización: `reply` (borrador con el estilo del titular) y `memory_query` (consulta con citas a la memoria, sin simular al titular).
- Generación de respuestas con enrutamiento semántico, recuperación, revisión de coherencia, varias versiones por mensaje y separación opcional entre contenido y estilo.
- Motor con SQLite como propietario del estado, Qdrant como índice vectorial reconstruible, Neo4j para hechos verificados y Ollama para la inferencia.
- Grafo de conocimiento extraído en segundo plano, reanudable, con verificación por criterios y revisión de hechos ya guardados.
- WhatsApp Web mediante QR o WhatsApp Cloud API, lista de contactos permitidos, consentimiento, cola de eventos y aprobación de borradores.
- FastAPI como proxy autenticado con Swagger, y una interfaz web React servida en `/ui/`.
- Entrenamiento de identidades desde la interfaz: dataset por sesiones, limpieza opcional de ráfagas, QLoRA, cuantización GGUF y registro en Ollama mediante un ejecutor local con GPU.
- Evaluación offline: diagnóstico sintético por etapas, evaluación con conversaciones reservadas, revisión humana ciega, etiquetado y calibración del revisor.
- Laboratorio LangGraph con reproducción de varios turnos, comparación ciega entre base y candidato, juez independiente, compuerta de calidad, registro de experimentos y aplicación de cambios solo tras aprobación humana.

## Verificación

- 231 pruebas Node, 18 Python y 9 de la interfaz. Usan dobles y fixtures sintéticos; no validan la integración real con servicios externos.
- El runtime declarado es **Node >= 26.12.1**.
- La disponibilidad de modelos en Ollama, el juez remoto, los agentes externos del laboratorio y la conexión con WhatsApp deben comprobarse en el equipo de despliegue (`npm run lab:doctor`, benchmarks controlados).

## Limitaciones

- El laboratorio no entrena ni fusiona adaptadores LoRA; compara modelos ya registrados en Ollama.
- `--unsafe-code-experiments` trabaja sobre una copia del código, **no es un sandbox de procesos**; úsalo solo en una VM o contenedor sin credenciales ni datos sensibles.
- `MemorySaver` mantiene los checkpoints de LangGraph solo durante el proceso; el registro de `data/lab` persiste entre ejecuciones.
- Las puntuaciones de un juez LLM pueden ser inestables o sesgadas. Medir fidelidad exige revisión humana, datasets no contaminados y pruebas de generalización.
- Un modelo entrenado para imitar a una persona puede no generalizar a otras identidades.
- El juez NIM envía contexto, respuestas y referencias a un tercero; está desactivado hasta elegirlo y autorizar ese envío.

## Fuera del repositorio

Los datos reales, las bases de datos, los modelos entrenados y las credenciales **no se distribuyen** con el código.
