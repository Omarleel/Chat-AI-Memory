# Importación, dataset, entrenamiento y evaluación reservada

## Datos de origen

El parser `src/domain/history.mjs` procesa exportaciones TXT de WhatsApp; `ImportService` vincula los mensajes al contacto y registra pares de estilo, personas y fragmentos de historia. Los textos originales son privados y deben mantenerse fuera del repositorio. La importación utiliza SQLite como fuente de verdad y puede crear representaciones en Qdrant.

## Preparar un dataset reproducible

Define `SELF_DISPLAY_NAME` (titular, cuyas respuestas se supervisan) y `LAB_PEER_NAME` (interlocutor). Exporta el chat con la ruta real, explícita:

```powershell
node --env-file=.env scripts/export-training-dataset.mjs "imports/chat.txt" "data/dataset"
```

Produce `train.jsonl`, `validation.jsonl`, `test.jsonl` y `manifest.json`. Cada entrada contiene `prompt`, `completion` y procedencia. `buildTrainingDataset()` agrupa por sesiones y divide cronológicamente sin mezclar una sesión entre particiones. El exportador rechaza sobrescribir archivos existentes para evitar destruir un dataset fijado.

Reserva el `test.jsonl` **antes** del ajuste. Nunca lo reintroduzcas en train, validation o en una búsqueda de memoria de prueba. El laboratorio ejecuta las generaciones sin consultar el RAG, pero eso no elimina la contaminación si el modelo vio el test durante entrenamiento anterior.

## Entrenamiento desde la interfaz

En **Entrenar identidad** (`/ui/#/entrenamiento`) eliges chats importados del mismo titular, el nombre del modelo y los parámetros; **Calcular dataset** muestra los ejemplos de cada partición sin crear nada y **Solo validar** ejecuta `train_lora.py --validate-only`. El trabajo queda en cola en SQLite hasta que `node --env-file=.env scripts/training-runner.mjs` lo reclama. El ejecutor escribe el dataset en `data/identities/<modelo>/<trabajo>/dataset`, descarga los modelos de Ollama de la GPU (preview y WhatsApp responden más lento mientras entrena), entrena, despliega con `deploy_trained_model.ps1` y borra el modelo fusionado y el GGUF intermedio salvo que pidas conservarlos. El adaptador LoRA y `training-report.json` quedan en esa carpeta.

Variables opcionales del ejecutor: `TRAINING_PYTHON` (por defecto `.venv-lora`), `TRAINING_ENGINE_URL` (por defecto `http://127.0.0.1:APP_PORT`), `TRAINING_OLLAMA_URL` y `TRAINING_POLL_MS`. Entrena solo con chats de la persona cuya identidad se modela y con su consentimiento.

## Limpieza de ráfagas (opcional)

Un objetivo de entrenamiento con varios mensajes seguidos del titular puede enseñar al modelo a seguir escribiendo y a cambiar de tema sin que nadie lo pida. Con `cleaning: {bursts: "llm"}` (en la UI, **Limpiar ráfagas**), solo en `train`:

1. Se corta cada ráfaga en la primera pausa larga para ese titular: el menor número entero de minutos que supera al 90 % de las pausas entre sus mensajes seguidos (con menos de 30 pausas, 2 minutos). Quien escribe despacio obtiene un umbral mayor. Si la pausa cambia, las etiquetas que ya no cubren la ráfaga vuelven a quedar pendientes.
2. `REASONING_MODEL` responde, para cada mensaje restante, una pregunta sí/no (`offTopic`): ¿abre otro tema o cuenta hechos sin relación con lo que se habla? Contestar, reaccionar, explicar o dar detalles del mismo asunto es `false`; ante la duda, también. Se conserva hasta antes del primer `offTopic=true`. Si ya lo es el primero, el ejemplo se quita. Si tras un reintento la lista sigue incompleta y sin ningún `true`, lo omitido cuenta como `false`.

Con tres categorías (`responde`/`sigue`/`nuevo`), el modelo marcaba como tema nuevo el primer mensaje en el 59 % de las ráfagas, incluso respuestas directas; la pregunta binaria lo bajó al 8,5 %. Las penalizaciones de repetición del escritor no se aplican aquí porque acortaban las listas JSON.

`validation` y `test` no cambian, así la pérdida y el holdout siguen siendo comparables con el modelo anterior. Las etiquetas se guardan en SQLite (`burst_labels`, por hash de fila y sin texto). El etiquetado es reanudable y no se puede crear el trabajo mientras falten ráfagas por etiquetar: `POST /api/training/cleaning/label` y `GET /api/training/cleaning`. Como referencia, unas 5.000 ráfagas tardan cerca de una hora con `qwen3.5:9b`.

## Entrenamiento QLoRA

```powershell
python scripts/train_lora.py --dataset data/dataset --validate-only
python scripts/train_lora.py --dataset data/dataset --steps 400
```

Este procedimiento requiere dependencias de PyTorch, Transformers, PEFT, datasets y hardware CUDA. `train_lora.py` supervisa **solo la última respuesta del titular**, enmascara el resto de tokens (`-100`), recorta contexto antiguo por turnos completos y audita la separación train/validation. El modelo base de entrenamiento y parámetros son configurables en la CLI de Python; no necesariamente coincide con el modelo Ollama ya instalado.

El despliegue manual usa `scripts/merge_lora.py`, `scripts/deploy_trained_model.ps1`, la conversión GGUF de llama.cpp y Ollama en Docker. Antes de desplegar revisa las rutas, prepara `scripts/llama_cpp` en el entorno local y verifica el reporte de entrenamiento. El laboratorio multiagente no ejecuta automáticamente estos pasos.

## Evaluación

- `npm run lab:benchmark`: compara base y candidato, reproduce turnos de forma independiente sin consultar producción.
- `npm run lab:run`: experimentación supervisada, gate y aprobación humana.
- `npm run evaluate:retrieval`: casos externos con referencias para medir recuperación; solo si preparas el archivo de evaluación.
- `npm run evaluate:persona`: genera material de comparación del modelo base y el adaptado para revisión humana; requiere los insumos indicados por el script.
- `scripts/evaluate_holdout.mjs`: evaluación puntual sin RAG para diagnosticar inferencia, complementaria al juez multi-turno.

No utilices el dataset ficticio `examples/lab-demo.jsonl` como prueba de fidelidad real. Considera evaluación humana ciega, conversaciones largas y generalización a interlocutores/situaciones no presentes en el entrenamiento.
