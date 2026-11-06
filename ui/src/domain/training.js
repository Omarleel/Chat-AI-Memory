// Vocabulario y reglas de los trabajos de entrenamiento, compartidas por las vistas.
export const JOB_STATES = {
  queued: {label: 'En cola', tone: 'slate'},
  running: {label: 'En curso', tone: 'blue'},
  cancel_requested: {label: 'Cancelando', tone: 'amber'},
  succeeded: {label: 'Completado', tone: 'green'},
  failed: {label: 'Fallido', tone: 'red'},
  cancelled: {label: 'Cancelado', tone: 'slate'}
};
export const JOB_STAGES = {dataset: 'Dataset', free_gpu: 'Liberando GPU', train: 'Entrenamiento', deploy: 'Despliegue', cleanup: 'Limpieza'};
export const isActiveJob = job => ['queued', 'running', 'cancel_requested'].includes(job?.state);
export const isCalibrating = job => job?.result?.reviewerCalibration?.state === 'running';

// Interpreta la calibración del revisor: qué parte de las respuestas reales del titular aprobaría.
export function calibrationVerdict(c) {
  if (!c) return {kind: 'info', text: 'Mide cuántas respuestas reales reservadas de esta persona rechaza el revisor. No necesita etiquetas.'};
  if (c.state === 'failed') return {kind: 'error', text: `La medición falló: ${c.error ?? 'error desconocido'}`};
  if (c.state !== 'done' || c.realApprovalRate === null) return null;
  const pct = Math.round(c.realApprovalRate * 100);
  return c.reliable
    ? {kind: 'success', text: `Aprueba ${pct} % de lo que la persona escribió de verdad. Las aprobaciones falsas solo se miden con etiquetas humanas.`}
    : {kind: 'warning', text: `Rechaza ${100 - pct} % de lo que la persona escribió de verdad: perderás borradores válidos. Prueba otro REASONING_MODEL o REVIEW_SHORT_APPROVAL=shape y vuelve a medir.`};
}
export const DEFAULT_TRAINING = {modelName: '', quant: 'q4_K_M', baseModel: 'Qwen/Qwen2.5-7B-Instruct', steps: 400,
  learningRate: 5e-5, maxLength: 1024, validateOnly: false, keepMerged: false, cleanBursts: false};

// La limpieza de ráfagas implica cortar en pausas: las etiquetas se calculan sobre la ráfaga ya cortada.
export const cleaningFor = cleanBursts => cleanBursts ? {timeSplit: true, bursts: 'llm'} : {timeSplit: false, bursts: 'none'};
export const labelingProgress = s => s?.total ? Math.min(1, (s.labeled ?? 0) / s.total) : 0;

export function modelNameError(name, protectedModels = []) {
  const value = String(name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{1,40}$/.test(value)) return 'Usa 2-41 caracteres: minúsculas, números, _ . -';
  if (protectedModels.some(m => m.split(':')[0] === value)) return 'Ese nombre lo usa un modelo activo';
  return null;
}
export const modelTag = (name, quant) => `${String(name).trim().toLowerCase()}:${quant === 'q8_0' ? 'q8' : 'q4'}`;

// Agrupa importaciones por titular: un trabajo solo puede mezclar chats del mismo self.
export function groupSourcesByOwner(sources) {
  const groups = new Map();
  for (const s of sources) {
    const key = s.self.trim().toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, {owner: s.self, sources: []});
    groups.get(key).sources.push(s);
  }
  return [...groups.values()];
}
export const sourceKey = s => `${s.contact}:${s.importHash}`;
