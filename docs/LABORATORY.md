# Laboratorio LangGraph y juez independiente

## Propósito

Evaluar las respuestas de un modelo objetivo (`LLM_MODEL`) ante conversaciones reservadas y mejorar **coherencia, continuidad, conducta, registro lingüístico, factualidad y naturalidad** sin enviar mensajes por WhatsApp. La calidad se mide comparando una configuración base con una candidata.

## Roles y flujo

- **Supervisor:** analiza informes agregados, formula hipótesis contrastables, puede solicitar bibliografía de OpenAlex y decide investigar, experimentar, aceptar o detenerse.
- **Programador:** transforma la hipótesis en una configuración o en parches restringidos y puede objetar enfoques ya probados apoyándose en el historial de experimentos.
- **Juez independiente:** `persona-judge.mjs`, con Ollama local o NVIDIA NIM. Compara base y candidato con contexto y referencia real, con puntuaciones 0–5 en seis dimensiones. No modifica código.
- **LangGraph:** persiste un registro de experimentos (`data/lab`); el checkpoint `MemorySaver` solo vive durante la ejecución. `qualityGate` exige 12 turnos, tres conversaciones, mínimo 3,65/5 en cada dimensión, mejora global >= 0,15 y ninguna regresión superior a 0,15 (valores predeterminados); después se requiere aprobación humana.

Las definiciones de los roles están en `.agents/agents/supervisor/agent.md` y `.agents/agents/programmer/agent.md`.

## Proveedor de agentes

`LAB_AGENT_PROVIDER` elige quién ejecuta los roles de supervisor y programador:

- `ollama`: modelos locales del mismo servidor Ollama.
- `antigravity`: agentes externos mediante la CLI `agy`, que debe estar instalada, autenticada y en el `PATH` del proceso Node. Los identificadores de modelo deben copiarse de `agy models`; no hay sustitución automática.

```dotenv
LLM_MODEL=mi-modelo:latest
LAB_AGENT_PROVIDER=antigravity
LAB_SUPERVISOR_MODEL=ID_DEL_MODELO_SUPERVISOR
LAB_PROGRAMMER_MODEL=ID_DEL_MODELO_PROGRAMADOR
LAB_AGY_BIN=agy
LAB_OLLAMA_URL=http://127.0.0.1:11434
LAB_DATA_DIR=./data/lab
LAB_PEER_NAME=Interlocutor
AUTO_SEND=false
```

El adaptador interpreta la envoltura JSON de `agy --output-format json`: prioriza `structured_output` y también acepta que `response` contenga JSON puro o un único bloque Markdown `json`. Rechaza explicaciones fuera del JSON, varios bloques o estructuras que no sean objetos. Los errores de parseo indican el rol que falló sin imprimir conversaciones ni la salida completa.

### Juez local (Ollama)

```dotenv
LAB_JUDGE_PROVIDER=ollama
LAB_JUDGE_MODEL=gemma3:12b
```

El modelo debe estar descargado en el mismo servidor Ollama que el generador. El juez no puede ser el modelo objetivo ni el candidato.

### Juez remoto NVIDIA NIM

```dotenv
LAB_JUDGE_PROVIDER=nim
LAB_JUDGE_MODEL=ID_EXACTO_DEL_MODELO_EN_NVIDIA_BUILD
NVIDIA_API_KEY=clave_privada
LAB_JUDGE_BASE_URL=https://integrate.api.nvidia.com/v1
LAB_JUDGE_REMOTE_CONSENT=YES
```

**Requisito obligatorio:** permiso de los participantes para enviar a NVIDIA el contexto, las entradas, las respuestas generadas y las referencias reales. Sin `LAB_JUDGE_REMOTE_CONSENT=YES` el laboratorio no envía esas conversaciones. La clave nunca debe publicarse; `lab:doctor` solo verifica la configuración, no el acceso ni la cuota. El ID del modelo se copia de la página de API de NVIDIA Build y el modelo debe admitir respuestas JSON.

## Comandos

```powershell
npm run lab:doctor
# Prueba con conversaciones ficticias; no valida fidelidad humana
npm run lab:benchmark -- --dataset examples/lab-demo.jsonl --candidate-model mi-modelo:latest --min-turns 1
# Conversaciones reservadas que nunca se usaron en el entrenamiento
npm run lab:run -- --dataset data/dataset/test.jsonl --max-cycles 4 --limit 24
# Investigación opcional; solo se envían consultas bibliográficas genéricas
npm run lab:run -- --dataset data/dataset/test.jsonl --max-cycles 4 --allow-web-papers
npm run lab:status
# Solo tras revisar el experimento y registrar su aprobación
npm run lab:apply -- --id ID_DEL_EXPERIMENTO --apply
```

Para escenarios largos, `npm run lab:dialogues -- data/dataset/test.jsonl data/lab/multi-turn-test.jsonl` agrupa ejemplos contiguos cuando sus referencias enlazan; revisa los diálogos antes de usarlos. El formato `prompt`/`completion` se interpreta como **un paso por registro**, así que 24 registros no demuestran continuidad de varios turnos. También se aceptan escenarios JSONL revisados a mano con `split: "test"`, `initialContext` y `steps` (`input`, `reference`). `data/lab` contiene métricas, historial, diagnósticos y aprobaciones privadas: no lo subas a repositorios.

## Seguridad y límites

- Supervisor y programador reciben métricas y evidencia **agregada**, nunca chats, claves ni referencias privadas. El juez sí ve los textos que compara.
- `--unsafe-code-experiments` solo permite reemplazos restringidos en una copia temporal y `node --check`. **No aísla procesos**, está desactivado por defecto y requiere una máquina o VM sin datos sensibles.
- Los cambios de configuración no se aplican solos. `APROBAR` registra el candidato para su aplicación manual; no modifica el modelo LoRA.
- La aceptación automática es un control de ingeniería, no una prueba de autenticidad humana. Complétala con comparaciones ciegas y pruebas fuera del chat de origen.
- OpenAlex no recibe datos del historial, solo consultas breves preparadas por el agente.
