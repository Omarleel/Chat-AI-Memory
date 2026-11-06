import {buildTrainingDataset} from './training-dataset.mjs';
import {normalizeCleaning, cleaningEnabled, cleanTrainRows, holderBurstGap} from './burst-cleaning.mjs';

// Reglas de un trabajo de entrenamiento de identidad (LoRA), sin dependencias de infraestructura.
export const TRAINING_STATES = ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled'];
export const TRAINING_STAGES = ['dataset', 'free_gpu', 'train', 'deploy', 'cleanup'];
export const FINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const MODEL_NAME = /^[a-z0-9][a-z0-9_.-]{1,40}$/;
const BASE_MODEL = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMPORT_HASH = /^[a-f0-9]{16,64}$/;

export class TrainingValidationError extends Error {
  constructor(message) {super(message); this.name = 'TrainingValidationError';}
}

const fail = message => {throw new TrainingValidationError(message);};
const number = (value, fallback, min, max, label, integer = false) => {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    fail(`${label} debe estar entre ${min} y ${max}`);
  return n;
};

// Normaliza la petición: el nombre del modelo no puede pisar el redactor ni el revisor activos.
export function normalizeTrainingRequest(input, {protectedModels = []} = {}) {
  if (!input || typeof input !== 'object') fail('Petición de entrenamiento inválida');
  const modelName = String(input.modelName ?? '').trim().toLowerCase();
  if (!MODEL_NAME.test(modelName)) fail('modelName: 2-41 caracteres en minúscula (a-z, 0-9, _ . -)');
  const quant = input.quant ?? 'q4_K_M';
  if (!['q4_K_M', 'q8_0'].includes(quant)) fail('quant debe ser q4_K_M o q8_0');
  const tag = `${modelName}:${quant === 'q4_K_M' ? 'q4' : 'q8'}`;
  if (protectedModels.some(m => m === tag || m === modelName || m === `${modelName}:latest`))
    fail(`${tag} está en uso como modelo activo; elige otro nombre`);
  const selfName = String(input.selfName ?? '').trim();
  if (!selfName || selfName.length > 100) fail('selfName: nombre del titular en los chats (1-100 caracteres)');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 50) fail('Elige entre 1 y 50 chats importados');
  const seen = new Set();
  const sources = input.sources.map(s => {
    const contact = String(s?.contact ?? '').replace(/\D/g, '');
    const importHash = String(s?.importHash ?? '');
    if (!/^\d{6,20}$/.test(contact) || !IMPORT_HASH.test(importHash)) fail('Fuente inválida: contact e importHash');
    const key = `${contact}:${importHash}`;
    if (seen.has(key)) fail('Fuente repetida');
    seen.add(key);
    return {contact, importHash};
  });
  const baseModel = String(input.baseModel ?? 'Qwen/Qwen2.5-7B-Instruct').trim();
  if (!BASE_MODEL.test(baseModel) || baseModel.length > 120) fail('baseModel debe ser un repositorio organización/modelo');
  return {
    modelName, tag, quant, selfName, sources, baseModel,
    steps: number(input.steps, 400, 10, 20000, 'steps', true),
    learningRate: number(input.learningRate, 5e-5, 1e-6, 1e-3, 'learningRate'),
    maxLength: number(input.maxLength, 1024, 256, 4096, 'maxLength', true),
    cleaning: normalizeCleaning(input.cleaning),
    validateOnly: input.validateOnly === true,
    keepMerged: input.keepMerged === true
  };
}

// Une varios chats en un dataset: cada importación se divide por separado y sus sesiones
// llevan prefijo propio, así ninguna sesión queda entre particiones ni colisiona con otra.
export function buildIdentityDataset(sources, {cleaning = normalizeCleaning(), labels = new Map()} = {}) {
  const result = {train: [], validation: [], test: [], stats: {sessions: 0, unavailableTargets: 0, duplicates: 0, sources: []}};
  const cleaned = {bursts: 0, timeCut: 0, llmCut: 0, dropped: 0, unlabeled: 0, unchanged: 0};
  if (cleaningEnabled(cleaning) && !cleaning.gapMinutes) cleaning = {...cleaning, gapMinutes: holderBurstGap(sources.map(s => s.messages))};
  for (const {contact, importHash, messages} of sources) {
    const data = buildTrainingDataset(messages);
    if (cleaningEnabled(cleaning)) {
      const byOrdinal = new Map(messages.map(m => [m.ordinal, m]));
      const out = cleanTrainRows(data.train, byOrdinal, cleaning, labels);
      data.train = out.rows;
      for (const k of Object.keys(cleaned)) cleaned[k] += out.stats[k];
    }
    const prefix = `${contact}-${importHash.slice(0, 8)}`;
    for (const split of ['train', 'validation', 'test'])
      for (const row of data[split]) result[split].push({...row, provenance: {...row.provenance, session: `${prefix}-${row.provenance.session}`}});
    for (const k of ['sessions', 'unavailableTargets', 'duplicates']) result.stats[k] += data.stats[k];
    result.stats.sources.push({contact, importHash, messages: messages.length,
      train: data.train.length, validation: data.validation.length, test: data.test.length});
  }
  if (cleaningEnabled(cleaning)) result.stats.cleaning = {...cleaning, ...cleaned};
  return result;
}

// Eventos que el ejecutor local puede notificar y su efecto sobre el trabajo.
export function applyRunnerEvent(job, event) {
  if (FINAL_STATES.has(job.state)) fail('El trabajo ya terminó');
  const next = {...job};
  if (event.stage !== undefined) {
    if (!TRAINING_STAGES.includes(event.stage)) fail('Etapa desconocida');
    next.stage = event.stage;
  }
  if (event.progress !== undefined) {
    const p = Number(event.progress);
    if (!Number.isFinite(p) || p < 0 || p > 1) fail('progress debe estar entre 0 y 1');
    next.progress = p;
  }
  if (event.message !== undefined) next.message = String(event.message).slice(0, 500);
  if (event.state !== undefined) {
    if (!FINAL_STATES.has(event.state)) fail('Estado final inválido');
    next.state = event.state;
    if (event.result !== undefined) next.result = event.result;
  }
  return next;
}
