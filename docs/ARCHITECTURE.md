# Arquitectura y responsabilidades

## Flujo principal

```text
WhatsApp Web (Baileys) / WhatsApp Cloud API
      ↓ validación, contacto permitido y consentimiento
src/main.mjs → QueueWorker → ReplyService → borrador SQLite
                                      ↘ Ollama (modelo objetivo)
                    ↕                    ↕
       SQLite (estado, FTS5)   RetrievalService
                                    ↙        ↘
                                 Qdrant     Neo4j
FastAPI (:8000) → API interna Node (:3000) → mismo estado SQLite
```

La base de datos SQLite es la autoridad de mensajes, importaciones, consentimiento, borradores, conversaciones de previsualización y memorias. Qdrant almacena representaciones recuperables y Neo4j relaciones; no reemplazan los datos de origen. El motor Node mantiene las operaciones de lectura/escritura; FastAPI no abre directamente SQLite ni almacena las reglas de negocio.

## Directorios

- `src/domain/`: parser del TXT, contexto conversacional, ranking y análisis, datos de entrenamiento y extracción de entidades.
- `src/app/`: importación, generación, recuperación, validación, consolidación de memoria y procesamiento de eventos.
- `src/infra/`: SQLite, Qdrant, Neo4j, Ollama y pasarelas WhatsApp.
- `src/transport/`: API HTTP interna y autorización.
- `api/`: FastAPI/Swagger, proxy y validación de parámetros.
- `src/agents/`: supervisor, programador, adaptador de agentes externos por CLI y grafo de decisiones.
- `src/lab/`: simulación, dataset, juez independiente, evidencia agregada, bibliografía, evaluación, registro, promoción y experimentos de código.
- `scripts/`: CLI del laboratorio, entrenamiento, conversión/despliegue y utilidades repetibles de evaluación.
- `tests/`: suites unitarias, integración y contratos Python. `examples/`: fixtures sintéticos.

## Modos de respuesta

**`reply`**: el mensaje recibido se interpreta como del interlocutor; produce una respuesta desde la perspectiva del titular. Puede usar contexto reciente y memoria cuando la política lo indique (`rag_policy=auto|force|off`). `ReplyService` separa generación, recuperación, revisión y guardias para evitar errores de perspectiva.

**`memory_query`**: el titular consulta su memoria en modo lectura, con citas sobre evidencias recuperadas (`[H*]` para historial y `[M*]` para memorias). No debe simular un diálogo ni guardar nuevos mensajes.

## Datos y límites

- SQLite: mensajes estructurados por contacto e importación, tabla FTS5, pares de estilo, perfiles, hechos aprendidos, memorias explícitas, cola y mensajes de previsualización por sesión.
- Qdrant: fragmentos de conversación, embeddings con Ollama y metadatos de recuperación; su índice se regenera a partir de fuentes disponibles.
- Neo4j: aristas y entidades extraídas, con acceso condicionado a configuración y estado del servicio.
- Ollama: modelo conversacional objetivo (`LLM_MODEL`), modelo de embeddings (`EMBED_MODEL`) y juez local opcional.

## Laboratorio separado

```text
Holdout reservado → simulación ReplyService (sin RAG)
      ↘ base y candidato → juez ciego (Ollama o NIM)
           → informe agregado → supervisor
                                  ↓
                            bibliografía opcional
                                  ↓
                              programador
                      ↙ objeción      ↘ candidato de configuración/código
                        registro de experimento → nueva evaluación
                                           ↓
                                qualityGate → aprobación humana
                                           ↓
                                aplicación manual con respaldo
```

Los agentes reciben resúmenes estructurados; el juez sí ve los textos necesarios para puntuar. `src/lab/conversation-simulator.mjs` prohíbe la recuperación RAG durante el holdout y utiliza las respuestas previas **del mismo modelo** para los siguientes turnos. El grafo no utiliza WhatsApp para evaluar.

## Coherencia de borradores e identidad

La generación usa un único contrato para ChatML y para clientes system/prompt. La identidad viene de la importación del contacto, con SELF_DISPLAY_NAME como respaldo. El perfil de comportamiento aprendido tiene prioridad sobre el perfil estadístico; las muestras aisladas solo se usan cuando falta perfil y no hay hilo activo. No se deduce la identidad del nombre del modelo.

El mensaje entrante se conserva literalmente. El contexto distingue evidencia histórica, afirmaciones del interlocutor y borradores anteriores: repetir una invención no la convierte en un recuerdo. La fuente de verdad es el chat importado y las conversaciones nuevas en vivo. Redactor, router y revisor comparten una política: negar las premisas que atribuyen al titular hechos no comprobados en esas fuentes, sin inventar detalles ni historias alternativas. Los mensajes reales nuevos conservan su autoría; las afirmaciones del interlocutor no prueban por sí solas hechos sobre el titular. Las respuestas de preview y los borradores no confirman hechos. Para preguntas abiertas sin datos, se indica que el dato no está registrado. La ruta semántica busca evidencia cuando el hilo no resuelve una atribución; no reemplaza respuestas con frases prefabricadas. Con SEMANTIC_ROUTER=false se usan el enrutamiento y las guardias por reglas.

Con SEMANTIC_ROUTER=true y REPLY_REVIEW=true, la revisión evalúa continuidad, atribución explícita de cada mensaje, fundamento y estilo (por estilo solo rechaza un tono de asistente; la brevedad es válida). `REPLY_CANDIDATES=N` genera N borradores del modelo de estilo en paralelo y el revisor los evalúa del más breve al más largo: gana el primero aprobado. Con un solo borrador rechazado, el propio modelo de estilo vuelve a redactar con la crítica; si también falla, el revisor repara una vez. Un borrador que repite el último mensaje del interlocutor se rechaza sin consultar al modelo. Si nada se aprueba, preview devuelve el borrador con `approved:false` y `review_reason`, sin guardarlo en la sesión; con `AUTO_SEND=true` el evento falla en lugar de enviarse. Una salida con formato inválido produce `MODEL_OUTPUT_INVALID`; `OLLAMA_PREVIEW_FAILED` queda para fallos de Ollama.

REASONING_MODEL permite elegir un modelo local distinto para el router y el revisor/reparador, mientras LLM_MODEL mantiene la redacción inicial. Si está vacío, se usa LLM_MODEL para ambas funciones. El modelo indicado debe existir en el mismo servidor Ollama. Un modelo entrenado para imitar una sola persona puede no generalizar a otras identidades ni seguir bien el contrato JSON; cambiar el nombre del titular no elimina ese sesgo del entrenamiento.

Las pruebas automatizadas verifican contratos y regresiones, no naturalidad humana. Antes de cambiar modelos o activar una identidad, evaluar conversaciones reservadas de varios turnos, incertidumbre, reparación de errores y variación de registro. Mantener AUTO_SEND=false. Para aplicar cambios del código montado en Docker, reiniciar app; cambios de variables de entorno requieren recrear app. No es necesario borrar historiales ni reimportar datos.

## Diagnóstico por etapas y separación de contenido/estilo

`REPLY_PIPELINE=direct` conserva el flujo existente. `REPLY_PIPELINE=content_style` requiere `REASONING_MODEL`: ese modelo redacta un plan estructurado y valida el contenido; `LLM_MODEL` aplica solamente el estilo: escribe con el mismo hilo y formato que en la redacción directa. Con `REPLY_CANDIDATES>1`, la mitad de las versiones se escriben libres y la otra mitad recibe el contenido aprobado como guía (`QUÉ DECIR`). La revisión compara cada versión con el contenido aprobado y elige la más breve que lo conserve. Pedirle que reescribiera el texto, o darle siempre el contenido, hacía que lo copiara literalmente y llegaba el tono del modelo general. En el diagnóstico sintético, la mezcla cumplió todos los criterios en 12/16 casos (13/16 reescribiendo) y el estilo en 16/16 (15/16). Solo 3/16 respuestas fueron una copia del contenido. Otra revisión compara con el contenido aprobado. Si el estilo falla, se conserva el contenido validado. Un fallo de contenido o de su revisión aborta el turno. Esta ruta siempre valida ambas etapas, incluso si REPLY_REVIEW=false; el interruptor de revisión sigue aplicando a direct.

`REPLY_PIPELINE=auto` elige por turno: con evidencia recuperada (historial, memorias o hechos del grafo) usa contenido+estilo; sin ella, redacción directa. Medición con 4 versiones: en el diagnóstico sintético con evidencia, contenido+estilo cumplió todos los criterios en 13/16 casos frente a 7/16 de la redacción directa. En el holdout sin memoria no mejoró la coherencia (7 frente a 11 según el juez), dejó 8/24 sin aprobar y tardó unos 5 s más. Por eso la elección depende de si hay evidencia.

La búsqueda casi siempre devuelve algún fragmento, aunque solo comparta palabras con el mensaje. Por eso, en `auto`, antes del contenido el modelo general marca, fragmento por fragmento, si trata del mismo asunto concreto que el último mensaje y el hilo (`usefulEvidence`, `sameMatter`). Una justificación libre o una segunda pregunta ("¿responde?") empeoraban la decisión con `qwen3.5:9b`. Si ninguno sirve, el turno va por redacción directa; si algunos sirven, solo esos pasan a la etapa de contenido. Si la decisión no es válida, se conserva toda la evidencia. Diagnóstico: `usefulEvidence` (número de fragmentos útiles o `invalid`) y `styleMode` (`guided` o `rewrite`).

La forma del titular se calcula de su historial (`src/domain/reply-shape.mjs`): mediana y percentil 75 de caracteres por turno, proporción de varias líneas, mayúsculas, punto final y signos de apertura. Con esos agregados, el plan de contenido pide lo mínimo que diría el titular y usa la evidencia (historial, memorias y hechos del grafo) respetando quién hizo qué. La etapa de estilo recibe esos agregados y pares reales de mensaje y respuesta del titular parecidos al actual (`findRelevantStylePairs`). Genera `REPLY_CANDIDATES` versiones y la revisión de estilo se queda con la más breve que conserve lo esencial: puede acortar y omitir lo secundario, pero no añadir hechos ni cambiar sujetos o negaciones. En la evaluación con holdout, la forma y los ejemplos salen solo de `train.jsonl` (`--train`).

La identidad y la fuente de verdad no cambian. Las decisiones semánticas no se sustituyen por listas de respuestas por tema. La preservación de significado depende de un revisor LLM y se debe evaluar; no es una garantía matemática.

Con `debug_rag=true`, preview incluye `rag.profile`: tiempos por etapa, llamadas, modelo utilizado, tokens cuando el proveedor los informa, carga e inferencia Ollama, reducción de contexto, decisión de recuperación y rechazos. En errores devuelve `profile` junto a `stage`. Los perfiles no contienen prompts, mensajes, contactos ni razones textuales; son locales a cada petición y no se mezclan entre peticiones concurrentes. Tiempo de llamada incluye carga, cola, evaluación del prompt e inferencia; no sumar tiempo de llamada al de la etapa porque se solapan. Los contadores Ollama incluyen una continuación automática completada cuando ocurre. Una petición fallida puede consumir trabajo que el proveedor no llega a informar.

El diagnóstico offline captura textos intermedios únicamente con una opción interna explícita, no expuesta por HTTP. Ejecutar:

```powershell
$env:AUTO_SEND='false'
npm run diagnose:replies -- --out work/diagnostic --writer MODELO_ESTILO --reasoner MODELO_GENERAL --judge OTRO_MODELO
```

Usa ocho casos sintéticos, un corpus de evidencia controlado y contexto fijo idéntico entre variantes: redacción directa con modelo de estilo, directa con modelo general y contenido más estilo. Guarda manifest.json, turns.jsonl incremental y results.json con el juicio independiente y denominadores. Solo permite Ollama en localhost; no abre bases privadas, no modifica historial, no entrena ni envía mensajes. `--repeats N`, `--limit N` y `--variants current_writer,direct_writer,direct_general,content_style,auto` permiten acotar la prueba.

La tasa de recuperación se refiere exclusivamente al corpus sintético. No mide recall de SQLite/Qdrant en los chats reales. Las tasas de rechazo del revisor y los juicios independientes son indicadores distintos. No presentar una mejora como causal o definitiva con una sola ejecución de ocho casos; completar con conversaciones reservadas y revisión humana antes de promover la configuración.

## Evaluación con conversaciones reservadas

`npm run evaluate:holdout-replies -- --out data/eval/holdout-X --writer MODELO_ESTILO --reasoner MODELO_GENERAL --judge OTRO_MODELO [--writer-q8 MODELO] [--style data/eval/self-style.json] [--cases 24]`

Usa solo `split=test`, un caso por sesión con al menos cuatro turnos reales de contexto, elegidos por hash. La recuperación está desactivada: SQLite/Qdrant contienen el chat completo y filtrarían la referencia; esta evaluación mide coherencia y estilo, el diagnóstico sintético mide recuperación. El contexto se marca como mensajes reales (`recentOrigin:'real'`, solo en scripts offline), no como borradores.

Mide por separado: rasgos de forma frente a la respuesta real (longitud, líneas, puntuación, mayúsculas, emoji; `styleDistance` 0–1), un juez local independiente (coherencia y `styleMatch` 1–5, y la coherencia que asigna a las respuestas reales como calibración) y revisión humana ciega. `rating.html` es una página local sin red que carga `blind.json`; los candidatos están barajados junto a la respuesta real y la clave queda en `blind-key.json`. Tras exportar `ratings.json`, `--score --ratings ratings.json` desvela la clave y cuenta cuántas veces se eligió cada variante como la real. Guardar resultados bajo `data/` (ignorado por git); no compartirlos.

`--style` recibe `{"summary":"..."}`: el resumen agregado del perfil, sin frases literales. Puede derivar del chat completo, por lo que es una fuga leve de nivel agregado.

## Cuantización del modelo de estilo

Con 16 GB de VRAM, un modelo de estilo Q8 (~8 GB) y un modelo de razonamiento (~6 GB) no permanecen cargados a la vez y Ollama los recarga en cada cambio de etapa. En Q4_K_M (~5 GB) ambos caben. `scripts/deploy_trained_model.ps1 -Quant q4_K_M -GgufPath data/<nombre>-q4_k_m.gguf -ModelName <nombre>:q4` convierte a F16 y cuantiza con la imagen oficial de llama.cpp: Ollama no cuantiza GGUF a K-quants al crear el modelo. Conservar el modelo Q8 para comparar con `evaluate:holdout-replies --writer-q8`.

## Interfaz web y entrenamiento de identidades

```text
Navegador → FastAPI (:8000) ─ /ui/   React + Tailwind (estático, CSP estricta)
                            └ /api/v1 → motor Node (:3000) → SQLite (training_jobs, logs)
Ejecutor local (GPU, fuera de Docker) ── sondea /api/training/runner/claim con ADMIN_TOKEN
   → descarga el dataset por partición → libera VRAM de Ollama → train_lora.py → deploy_trained_model.ps1 → Ollama
```

Capas en el motor: `src/domain/training-job.mjs` (validación, unión de chats sin cruzar sesiones entre particiones, transiciones de estado), `src/app/training-service.mjs` y `src/app/model-service.mjs` (casos de uso), `src/infra/sqlite-repository.mjs` y `src/infra/ollama.mjs` (adaptadores), `src/transport/training-routes.mjs` (HTTP). El ejecutor (`scripts/training-runner.mjs`) es otro adaptador de entrada: su lógica pura vive en `src/runner/` y sus puertos (API del motor, procesos, disco, GPU) se implementan en `src/infra/engine-api-client.mjs`, `host-processes.mjs` y `ollama-gpu.mjs`.

El dataset se reconstruye desde `imported_messages` en el momento de entregarlo: los textos no se copian a otra tabla ni salen de la máquina. Un trabajo solo mezcla chats con el mismo titular, no puede reutilizar el nombre de los modelos activos (redactor, revisor, embeddings) y exige al menos 50 ejemplos de entrenamiento. El ejecutor reclama un trabajo a la vez; si se reinicia, los trabajos que quedaron a su nombre se marcan como fallidos. La cancelación se consulta en cada envío de avance y termina el árbol de procesos. `deploy_trained_model.ps1` solo registra el modelo si la pérdida de validación mejora.

Preview acepta `writer_model` para probar una identidad instalada sin reiniciar: cambia solo el redactor; router y revisor siguen siendo `REASONING_MODEL`. Activarla de forma permanente sigue requiriendo `LLM_MODEL`/`SELF_DISPLAY_NAME` en `.env` y recrear `app`.

La UI (`ui/`) sigue la misma separación: `domain/` (reglas puras), `application/` (puerto `AdminApi`, hooks de casos de uso, contactos y navegación), `infrastructure/` (adaptador HTTP y almacenamiento del token en `sessionStorage`) y `ui/` (componentes y vistas). La raíz de composición (`main.jsx`) inyecta el adaptador; las vistas no conocen rutas HTTP.

## Grafo de conocimiento (Neo4j)

SQLite (`learned_memories`) es la fuente de los hechos; Neo4j es una proyección reconstruible (`POST /api/graph/rebuild`). Cada hecho tiene sujeto, relación de un vocabulario cerrado (`src/domain/knowledge-graph.mjs`), objeto, cita literal, autor, mensaje de origen y fecha. En Neo4j las entidades son `(:Entity {contact, key, name, type})` con clave canónica (sin tildes ni artículos) y las relaciones son tipadas (`DEBE_A`, `TRABAJA_EN`, `CUMPLEANOS`…) con esa procedencia y `origin: llm`. Las tripletas extraídas por reglas no se proyectan.

La extracción (`KnowledgeGraphService`) recorre cada chat importado en segundo plano con `REASONING_MODEL`, en lotes de 16 mensajes útiles con 4 de contexto. Es reanudable (cursor en `graph_extraction`) y se puede pausar. Cada línea lleva autor y destinatario para resolver "me/te". Un hecho se guarda solo si cumple todas estas condiciones: su cita es un substring literal del mensaje del hablante, la relación pertenece al vocabulario, el objeto es concreto, toda cifra del hecho aparece en la cita y un verificador lo aprueba. El verificador juzga un hecho por llamada (en lote, el juicio de un hecho contagiaba a sus vecinos) y ve la arista completa (sujeto, relación con su definición, objeto), la cita y los mensajes de alrededor, incluidos los siguientes, donde aparecen negaciones y correcciones. Responde criterios cerrados (`explicita`, `relacion`, `entidades`, `vigencia`, `contexto`) y el hecho se guarda solo si todos se cumplen. Cuando declara `entidades: resuelta`, sustituye un pronombre o un parentesco sin dueño por su nombre ("papá de <persona>"). `POST /api/graph/review` pasa los hechos ya guardados por el verificador actual: marca `rejected` los que no se sostienen, aplica los nombres resueltos y reconstruye la proyección. Se prioriza precisión sobre cobertura porque el bot usa estos hechos como evidencia. Los mensajes reales entrantes usan el mismo extractor cuando `AUTO_MEMORY_LEARN=true`.

Al responder, el motor busca entidades del mensaje (las del router más las palabras del propio mensaje) por clave exacta o por palabra completa. Devuelve los hechos a un salto y, para personas, los de quienes tienen con ellas una relación social (dos saltos). Las aristas repetidas (mismo sujeto, relación y objeto) llegan como una sola, con la cita más reciente y el número de menciones (`mentions`). Sin Neo4j, la búsqueda cae a SQLite por texto. La evaluación con holdout desactiva esta recuperación (`rag_policy=off`), porque el grafo se construye con el chat completo.

## Medición del revisor con etiquetas humanas

`scripts/reviewer-benchmark.mjs --build` toma conversaciones reservadas (`split=test`). Para cada una mezcla la respuesta real con borradores del redactor sin revisar y genera `items.json`, `key.json` (origen de cada respuesta) y `label.html`, una página local sin red. La persona etiqueta cada respuesta como válida, inventa, no responde o no suena al titular, y exporta `labels.json`. `--score --labels labels.json --reviewers m1,m2` ejecuta cada revisor en modo solo veredicto (`judgeOnly`), guarda los veredictos en caché y compara con las etiquetas. Informa acuerdo, precisión de lo aprobado, cobertura de lo válido, aprobaciones falsas por tipo de error y rechazos falsos, por separado para respuestas reales y borradores. No usa RAG. `--variants base,examples,short --train train.jsonl` compara el revisor sin ejemplos, con intercambios reales del titular y con aprobación breve.

### Criterio del revisor por identidad

El revisor no recibe reglas propias de una persona. Recibe `holderExamples`: intercambios reales del titular ("le escribieron → respondió"), unos relevantes al último mensaje y otros elegidos por cuantiles de longitud de su historial, de modo que la muestra refleja cuánto escribe esa persona. Con ellos no rechaza por breve o seco lo que tiene la forma habitual del titular. Los ejemplos no son hechos de la conversación ni respaldan datos. En producción salen del historial importado del contacto. En evaluación salen solo de `train`.

`REVIEW_MODE=closed` sustituye el juicio global por preguntas cerradas (`answersLast`, `addsFacts`, `mixesSpeakers`, `contradictsThread`, `assistantTone` y, en la revisión de estilo, `changesContent`). El veredicto y la crítica se derivan de esas respuestas.

`REPLY_WRITER_PROMPT=auto` (por defecto) da al escritor el mismo prompt con que se entrenó, más el hilo y sin penalizaciones de repetición, cuando el modelo lo declara como `SYSTEM` en su Modelfile (lo hace el despliegue de cada entrenamiento). Un modelo general como escritor recibe las reglas y el contexto (`rules`). Con las reglas largas, el modelo entrenado copiaba palabras de las instrucciones; las penalizaciones le impedían repetir las del hilo. La evidencia que el filtro descarta tampoco llega al escritor.

`REVIEW_SHORT_APPROVAL=shape` (desactivado por defecto) es una heurística opcional: aprueba sin consultar al revisor un borrador que no supera la mediana de longitud del propio titular y no contiene cifras. Nunca se aplica en la revisión de estilo, donde se compara contenido.

**Calibración sin etiquetas.** Las respuestas reales del titular en conversaciones reservadas deberían aprobarse. Al terminar cada entrenamiento, el motor revisa hasta 30 de ellas (`ReviewerCalibrationService`) y guarda en el resultado del trabajo solo conteos: `realApprovalRate` y `reliable` (al menos 80 %). La UI de entrenamiento lo muestra y permite repetirlo (`POST /api/training/jobs/:id/calibrate-reviewer`). `npm run calibrate:reviewer` hace lo mismo con `data/dataset`. Mide los rechazos falsos. Las aprobaciones falsas solo se miden con etiquetas humanas.

Medición de referencia con `qwen3.5:9b`: 55 respuestas etiquetadas por una persona, 20 de ellas reales.

| Revisor | Coincide con la persona | Aprob. falsas | Rech. falsos | Calibración (30 reales) |
|---|---|---|---|---|
| Sin ejemplos | 49 % | 12 | 16 | 47 % |
| Con `holderExamples` | 57 % | 12 | 11 | 60 % |
| Con ejemplos + `REVIEW_SHORT_APPROVAL=shape` | 69 % | 13 | 4 | 80 % |

Los conjuntos se solapan: los casos etiquetados forman parte de la calibración. Ninguna variante reduce las aprobaciones falsas, que son sobre todo respuestas que no encajan con el último mensaje y siguen dependiendo del revisor.
