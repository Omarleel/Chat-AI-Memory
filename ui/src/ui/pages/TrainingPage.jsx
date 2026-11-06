import {useEffect, useMemo, useRef, useState} from 'react';
import {Ban, Calculator, Cpu, FlaskConical, GraduationCap, MessageSquareText, Play, Terminal} from 'lucide-react';
import {useApi, useMutation, useQuery} from '../../application/services.jsx';
import {navigate} from '../../application/use-route.js';
import {DEFAULT_TRAINING, JOB_STAGES, JOB_STATES, calibrationVerdict, cleaningFor, labelingProgress, groupSourcesByOwner, isActiveJob, isCalibrating, modelNameError, modelTag, sourceKey} from '../../domain/training.js';
import {formatDate, formatNumber} from '../../domain/format.js';
import {Badge, Card, EmptyState, ErrorNotice, Field, Loading, Modal, Notice, PageHeader, ProgressBar, Spinner, Stat, Toggle} from '../components/primitives.jsx';

const RUNNER_CMD = 'node --env-file=.env scripts/training-runner.mjs';

export function TrainingPage({params}) {
  const api = useApi();
  const runner = useQuery(() => api.trainingRunner(), [], {intervalMs: 5000});
  const jobs = useQuery(() => api.trainingJobs(), [], {intervalMs: 5000});
  const selectedId = params.job ?? jobs.data?.find(isActiveJob)?.id ?? null;
  return (
    <>
      <PageHeader title="Entrenar identidad"
        description="Ajusta un modelo LoRA con los chats de un titular para imitar su forma de escribir. El ejecutor local usa tu GPU, registra el modelo en Ollama y luego puedes probarlo en Preview." />
      <RunnerBanner runner={runner} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <NewJobForm onCreated={job => {jobs.reload(); navigate('/entrenamiento', {job: job.id});}} />
        <div className="min-w-0 space-y-4">
          {selectedId && <JobDetail id={selectedId} onChange={() => jobs.reload({silent: true})} />}
          <JobList jobs={jobs} selectedId={selectedId} />
        </div>
      </div>
    </>
  );
}

function RunnerBanner({runner}) {
  const r = runner.data;
  if (!r) return runner.error ? <ErrorNotice error={runner.error} className="mb-4" /> : null;
  if (!r.online) return (
    <Notice kind="warning" title="Ejecutor local sin conexión" className="mb-4">
      Los trabajos quedan en cola hasta que lo inicies en el equipo con GPU, desde la carpeta del proyecto:
      <code className="mt-2 block rounded bg-black/5 px-2 py-1 font-mono text-xs dark:bg-white/10">{RUNNER_CMD}</code>
    </Notice>
  );
  if (!r.info?.python) return (
    <Notice kind="error" title="El ejecutor no encuentra Python de entrenamiento" className="mb-4">
      Crea el entorno <code>.venv-lora</code> con PyTorch CUDA, Transformers, PEFT y bitsandbytes, o define TRAINING_PYTHON en .env.
    </Notice>
  );
  return (
    <Notice kind="success" className="mb-4">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><Cpu className="h-4 w-4" />Ejecutor conectado: {r.info.name}
        {r.info.gpu && <span className="text-xs opacity-80">{r.info.gpu}</span>}</span>
    </Notice>
  );
}

// Etiquetado de ráfagas con el modelo general: reanudable, las etiquetas quedan en SQLite.
function BurstLabeling({sources}) {
  const api = useApi();
  const status = useQuery(() => api.burstLabeling(), [], {intervalMs: 5000});
  const start = useMutation(() => api.startBurstLabeling({sources}));
  const pause = useMutation(() => api.pauseBurstLabeling());
  const s = status.data;
  const running = s?.state === 'running';
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-slate-600 dark:text-slate-300">
          {s?.total ? `${formatNumber(s.labeled)} de ${formatNumber(s.total)} ráfagas etiquetadas` : 'Sin etiquetar todavía'}
          {running && ` · ${formatNumber(s.done)} en esta tanda, ${formatNumber(s.errors)} errores`}
        </span>
        {running
          ? <button className="btn-secondary" disabled={pause.pending} onClick={() => pause.run().then(() => status.reload()).catch(() => {})}>Pausar</button>
          : <button className="btn-secondary" disabled={!sources.length || start.pending} onClick={() => start.run().then(() => status.reload()).catch(() => {})}>
              {start.pending ? <Spinner /> : <FlaskConical className="h-4 w-4" />}{s?.labeled ? 'Continuar etiquetado' : 'Etiquetar ráfagas'}</button>}
      </div>
      {s?.total > 0 && <ProgressBar value={labelingProgress(s)} />}
      {s?.state === 'failed' && <Notice kind="error">{s.error}</Notice>}
      <ErrorNotice error={status.error ?? start.error ?? pause.error} />
    </div>
  );
}

function NewJobForm({onCreated}) {
  const api = useApi();
  const sources = useQuery(() => api.trainingSources());
  const system = useQuery(() => api.system());
  const [form, setForm] = useState(DEFAULT_TRAINING);
  const [picked, setPicked] = useState(() => new Set());
  const [plan, setPlan] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const set = (key, value) => {setForm(f => ({...f, [key]: value})); if (key !== 'modelName') setPlan(null);};
  const groups = useMemo(() => groupSourcesByOwner(sources.data ?? []), [sources.data]);
  const chosen = (sources.data ?? []).filter(s => picked.has(sourceKey(s)));
  const owner = chosen[0]?.self ?? null;
  const protectedModels = [system.data?.chatModel, system.data?.reasoningModel, system.data?.embedModel].filter(Boolean);
  const nameError = form.modelName ? modelNameError(form.modelName, protectedModels) : null;
  const {cleanBursts, ...fields} = form;
  const request = {...fields, cleaning: cleaningFor(cleanBursts), modelName: form.modelName.trim().toLowerCase(), steps: Number(form.steps), learningRate: Number(form.learningRate),
    maxLength: Number(form.maxLength), sources: chosen.map(({contact, importHash}) => ({contact, importHash}))};
  const planning = useMutation(() => api.trainingPlan({sources: request.sources, cleaning: request.cleaning}));
  const creating = useMutation(() => api.createTrainingJob(request));

  function toggle(s) {
    const key = sourceKey(s);
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else {
      // Un dataset mezcla solo chats del mismo titular.
      for (const k of [...next]) if ((sources.data ?? []).find(x => sourceKey(x) === k)?.self.toLowerCase() !== s.self.toLowerCase()) next.delete(k);
      next.add(key);
      if (!form.modelName) set('modelName', s.self.toLowerCase().normalize('NFD').replace(/[^a-z0-9_.-]/g, '').slice(0, 41));
    }
    setPlan(null);
    setPicked(next);
  }
  const ready = chosen.length && form.modelName && !nameError;
  return (
    <Card title="Nueva identidad" description="Elige los chats del titular; el test reservado (último 5 % de sesiones) nunca se entrena.">
      <div className="space-y-5">
        <div>
          <p className="label">Chats de origen</p>
          {sources.loading ? <Loading /> : !groups.length ? (
            <EmptyState icon={MessageSquareText} title="No hay chats importados">
              <button className="btn-secondary mt-2" onClick={() => navigate('/chats')}>Importar un chat</button>
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {groups.map(g => (
                <fieldset key={g.owner} className="min-w-0 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <legend className="px-1 text-xs font-semibold">Titular: {g.owner}</legend>
                  {g.sources.map(s => (
                    <label key={sourceKey(s)} className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={picked.has(sourceKey(s))} onChange={() => toggle(s)} />
                      <span className="min-w-0 flex-1 truncate">con <b>{s.peer}</b> <span className="text-slate-500">· +{s.contact} · {s.fileName}</span></span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-500">{formatNumber(s.messages)} msj</span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del modelo" error={nameError} hint={form.modelName && !nameError ? `Se registrará como ${modelTag(form.modelName, form.quant)}` : 'p. ej. juan'}>
            <input className="input" value={form.modelName} onChange={e => set('modelName', e.target.value)} maxLength={41} placeholder="juan" />
          </Field>
          <Field label="Cuantización" hint="Q4 cabe junto al revisor en 16 GB de VRAM">
            <select className="input" value={form.quant} onChange={e => set('quant', e.target.value)}>
              <option value="q4_K_M">Q4_K_M (≈4,7 GB, recomendado)</option>
              <option value="q8_0">Q8_0 (≈8 GB)</option>
            </select>
          </Field>
          <Field label="Pasos" hint="400 ≈ 3 200 ejemplos vistos con lote 2 × 4">
            <input className="input" type="number" min={10} max={20000} value={form.steps} onChange={e => set('steps', e.target.value)} />
          </Field>
          <Field label="Tasa de aprendizaje">
            <input className="input" type="number" step="0.000001" min={0.000001} max={0.001} value={form.learningRate} onChange={e => set('learningRate', e.target.value)} />
          </Field>
          <Field label="Contexto máximo (tokens)">
            <input className="input" type="number" min={256} max={4096} step={128} value={form.maxLength} onChange={e => set('maxLength', e.target.value)} />
          </Field>
          <Field label="Modelo base (Hugging Face)">
            <input className="input" value={form.baseModel} onChange={e => set('baseModel', e.target.value)} maxLength={120} />
          </Field>
        </div>
        <div className="space-y-3">
          <Toggle checked={form.validateOnly} onChange={v => set('validateOnly', v)} label="Solo validar"
            hint="Comprueba tokenización y máscaras sin entrenar ni desplegar (minutos)." />
          <Toggle checked={form.keepMerged} onChange={v => set('keepMerged', v)} label="Conservar modelo fusionado" hint="Ocupa ≈15 GB de disco." />
          <Toggle checked={form.cleanBursts} onChange={v => set('cleanBursts', v)} label="Limpiar ráfagas"
            hint="Solo en train: corta en pausas de 2 min y conserva lo que responde; quita lo que abre otro tema o afirma algo nuevo. Requiere etiquetar antes con el modelo general." />
          {form.cleanBursts && <BurstLabeling sources={request.sources} />}
        </div>

        {plan && (
          <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
            <Stat label="Entrenamiento" value={formatNumber(plan.counts.train)} />
            <Stat label="Validación" value={formatNumber(plan.counts.validation)} />
            <Stat label="Test reservado" value={formatNumber(plan.counts.test)} hint={`${formatNumber(plan.sessions)} sesiones`} />
            {plan.cleaning && <>
              <Stat label="Ráfagas cortadas" value={formatNumber(plan.cleaning.timeCut + plan.cleaning.llmCut)} />
              <Stat label="Ejemplos quitados" value={formatNumber(plan.cleaning.dropped)} />
              <Stat label="Sin etiquetar" value={formatNumber(plan.cleaning.unlabeled)} tone={plan.cleaning.unlabeled ? 'red' : undefined} />
            </>}
          </div>
        )}
        <ErrorNotice error={planning.error ?? creating.error} />
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" disabled={!chosen.length || planning.pending} onClick={() => planning.run().then(setPlan).catch(() => {})}>
            {planning.pending ? <Spinner /> : <Calculator className="h-4 w-4" />}Calcular dataset
          </button>
          <button className="btn-primary" disabled={!ready || creating.pending} onClick={() => setConfirm(true)}>
            {form.validateOnly ? <FlaskConical className="h-4 w-4" /> : <GraduationCap className="h-4 w-4" />}{form.validateOnly ? 'Validar' : 'Entrenar'}
          </button>
        </div>
      </div>
      <Modal open={confirm} title={form.validateOnly ? 'Validar dataset' : `Entrenar ${modelTag(form.modelName || 'x', form.quant)}`} onClose={() => setConfirm(false)}
        footer={<><button className="btn-secondary" onClick={() => setConfirm(false)}>Cancelar</button>
          <button className="btn-primary" disabled={creating.pending} onClick={async () => {
            const job = await creating.run().catch(() => null);
            setConfirm(false);
            if (job) onCreated(job);
          }}>{creating.pending ? <Spinner /> : <Play className="h-4 w-4" />}Encolar</button></>}>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>{chosen.length} chat{chosen.length === 1 ? '' : 's'} de <b>{owner}</b>, {form.steps} pasos sobre {form.baseModel}.</li>
          {!form.validateOnly && <li>Al empezar se descargan los modelos de Ollama de la GPU: el preview y WhatsApp responderán más lento hasta que termine.</li>}
          {!form.validateOnly && <li>El despliegue solo ocurre si la pérdida de validación mejora respecto al modelo base.</li>}
          <li>Usa el modelo solo con chats de esa persona y con su consentimiento.</li>
        </ul>
      </Modal>
    </Card>
  );
}

function JobList({jobs, selectedId}) {
  if (jobs.loading && !jobs.data) return <Card title="Trabajos"><Loading /></Card>;
  return (
    <Card title="Trabajos" bodyClassName="">
      <ErrorNotice error={jobs.error} className="m-4" />
      {!jobs.data?.length ? <EmptyState icon={GraduationCap} title="Sin entrenamientos todavía" /> : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {jobs.data.map(job => (
            <li key={job.id}>
              <button className={`flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50 ${job.id === selectedId ? 'bg-sky-50/60 dark:bg-sky-950/30' : ''}`}
                onClick={() => navigate('/entrenamiento', {job: job.id})}>
                <span className="font-medium">{job.tag}</span>
                <Badge tone={JOB_STATES[job.state]?.tone}>{JOB_STATES[job.state]?.label ?? job.state}</Badge>
                {job.spec?.validateOnly && <Badge tone="violet">validación</Badge>}
                <span className="ml-auto text-xs text-slate-500">{formatDate(job.createdAt)}</span>
                {isActiveJob(job) && <span className="w-full"><ProgressBar value={job.progress} /></span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// Rechazos falsos del revisor con esta identidad: respuestas reales del titular que no aprobaría.
function ReviewerCalibration({calibration: c, pending, error, onRun}) {
  const verdict = calibrationVerdict(c);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label m-0">Revisor con esta identidad{c?.reviewer ? ` · ${c.reviewer}` : ''}</p>
        <button className="btn-secondary" disabled={pending || c?.state === 'running'} onClick={onRun}>
          {pending || c?.state === 'running' ? <Spinner /> : <Calculator className="h-4 w-4" />}{c ? 'Volver a medir' : 'Medir'}</button>
      </div>
      {c?.state === 'running' && <p className="text-sm text-slate-500">Midiendo{c.total ? ` ${c.done}/${c.total}` : ''}…</p>}
      {c?.state === 'done' && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Reales aprobadas" value={c.realApprovalRate === null ? '—' : `${Math.round(c.realApprovalRate * 100)} %`} tone={c.reliable === false ? 'red' : undefined} />
          <Stat label="Rechazadas" value={`${c.rejected}/${c.judged}`} />
          <Stat label="Errores" value={formatNumber(c.errors)} />
        </div>
      )}
      {verdict && <Notice kind={verdict.kind}>{verdict.text}</Notice>}
      <ErrorNotice error={error} />
    </div>
  );
}

function JobDetail({id, onChange}) {
  const api = useApi();
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const lastLog = useRef(0);
  const lastState = useRef(null);
  const logBox = useRef(null);
  const cancel = useMutation(() => api.cancelTrainingJob(id));
  const calibrate = useMutation(() => api.calibrateReviewer(id));
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    let alive = true, timer;
    lastLog.current = 0; lastState.current = null; setLogs([]); setJob(null); setError(null);
    async function poll() {
      try {
        const r = await api.trainingJob(id, lastLog.current);
        if (!alive) return;
        if (lastState.current && lastState.current !== r.job.state) onChange();
        lastState.current = r.job.state;
        setJob(r.job);
        if (r.logs.length) {lastLog.current = r.logs.at(-1).id; setLogs(prev => [...prev, ...r.logs].slice(-1500));}
        setError(null);
        if (isActiveJob(r.job) || isCalibrating(r.job)) timer = setTimeout(poll, 3000);
      } catch (e) {if (alive) {setError(e); timer = setTimeout(poll, 8000);}}
    }
    poll();
    return () => {alive = false; clearTimeout(timer);};
  }, [id, polls]);
  useEffect(() => {const el = logBox.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;}, [logs.length]);
  if (!job) return <Card title="Trabajo">{error ? <ErrorNotice error={error} /> : <Loading />}</Card>;
  const result = job.result;
  const st = JOB_STATES[job.state];
  return (
    <Card title={job.tag} description={`${job.selfName} · ${job.spec.steps} pasos · ${job.spec.quant}${job.spec.validateOnly ? ' · solo validación' : ''}`}
      actions={<>
        {isActiveJob(job) && <button className="btn-secondary text-rose-600" disabled={cancel.pending || job.state === 'cancel_requested'}
          onClick={() => cancel.run().then(() => onChange()).catch(() => {})}><Ban className="h-4 w-4" />Cancelar</button>}
        {job.state === 'succeeded' && result?.ollamaModel && <button className="btn-primary" onClick={() => navigate('/preview', {model: result.ollamaModel})}>
          <MessageSquareText className="h-4 w-4" />Probar</button>}
      </>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={st?.tone}>{st?.label ?? job.state}</Badge>
          {job.stage && isActiveJob(job) && <span className="text-slate-500">{JOB_STAGES[job.stage]}</span>}
          <span className="text-slate-500">{job.message}</span>
        </div>
        {isActiveJob(job) && <ProgressBar value={job.progress} />}
        <ErrorNotice error={error ?? cancel.error} />
        {job.spec.datasetStats && (
          <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
            <Stat label="Entrenamiento" value={formatNumber(job.spec.datasetStats.counts.train)} />
            <Stat label="Validación" value={formatNumber(job.spec.datasetStats.counts.validation)} />
            <Stat label="Test reservado" value={formatNumber(job.spec.datasetStats.counts.test)} />
          </div>
        )}
        {result && !result.validateOnly && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Pérdida base" value={result.baselineEvalLoss?.toFixed?.(3) ?? '—'} />
            <Stat label="Pérdida final" value={result.finalEvalLoss?.toFixed?.(3) ?? '—'} tone={result.improved === false ? 'red' : undefined} />
            <Stat label="Modelo" value={result.ollamaModel ?? '—'} />
          </div>
        )}
        {result?.validateOnly && result.audit && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Ejemplos" value={formatNumber(result.audit.train)} />
            <Stat label="Tokens supervisados" value={formatNumber(result.audit.supervised_tokens)} />
            <Stat label="Recortados" value={formatNumber(result.audit.skipped_oversized_train)} />
          </div>
        )}
        {job.state === 'succeeded' && !result?.validateOnly && (
          <ReviewerCalibration calibration={result?.reviewerCalibration} pending={calibrate.pending} error={calibrate.error}
            onRun={() => calibrate.run().then(j => {setJob(j); setPolls(n => n + 1);}).catch(() => {})} />
        )}
        {job.state === 'succeeded' && !result?.validateOnly && (
          <Notice kind="info">La pérdida de validación no prueba que suene como la persona: evalúa con el holdout y revisión humana antes de activarlo como LLM_MODEL.</Notice>
        )}
        <div>
          <p className="label flex items-center gap-1.5"><Terminal className="h-3.5 w-3.5" />Registro</p>
          <pre ref={logBox} className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200">
            {logs.length ? logs.map(l => l.line).join('\n') : 'Sin salida todavía.'}
          </pre>
        </div>
      </div>
    </Card>
  );
}
