// Exclusively offline, explicit held-out data. Never query a production memory index here.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function turns(value, label) {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label}: se esperaba un arreglo de hasta 32 turnos`);
  return value.map((m, i) => {
    if (!['user', 'assistant'].includes(m?.role) || !nonempty(m?.content) || m.content.length > 4000)
      throw new Error(`${label}[${i}]: role=user|assistant y content no vacío (máx 4000)`);
    return { role: m.role, content: m.content.trim() };
  });
}
function convertTrainingRow(row, i) {
  if (row.provenance?.split !== 'test') throw new Error(`Línea ${i}: solo se acepta provenance.split=test`);
  const prompt = turns(row.prompt.filter(x => x.role !== 'system'), `prompt ${i}`);
  if (!prompt.length || prompt.at(-1).role !== 'user') throw new Error(`Línea ${i}: prompt debe acabar en user`);
  const answer = row.completion?.[0]?.content;
  if (!nonempty(answer) || row.completion?.[0]?.role !== 'assistant') throw new Error(`Línea ${i}: completion de assistant obligatoria`);
  const context = prompt.slice(0, -1);
  return { id: row.provenance?.hash || `case-${i}`, initialContext: context,
    steps: [{ input: prompt.at(-1).content, reference: answer.trim() }],
    split: 'test', sourceSession: row.provenance?.session ?? `case-${i}` };
}
function convertConversation(row, i) {
  if (row.split !== 'test') throw new Error(`Conversación ${i}: split=test obligatorio`);
  const initialContext = turns(row.initialContext ?? [], `initialContext ${i}`);
  if (!Array.isArray(row.steps) || row.steps.length < 1 || row.steps.length > 30)
    throw new Error(`Conversación ${i}: steps debe contener 1..30 pares`);
  const steps = row.steps.map((step, j) => {
    if (!nonempty(step?.input) || !nonempty(step?.reference) || step.input.length > 4000 || step.reference.length > 4000)
      throw new Error(`Conversación ${i}, step ${j}: input y reference obligatorios (máx 4000)`);
    return { input: step.input.trim(), reference: step.reference.trim() };
  });
  return { id: String(row.id ?? `conversation-${i}`).slice(0, 120), split: 'test',
    initialContext, steps, sourceSession: String(row.session ?? row.id ?? `conversation-${i}`) };
}
export async function loadHoldout(path, { limit = 24 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit debe estar entre 1 y 500');
  const raw = await readFile(path, 'utf8');
  if (raw.length > 25_000_000) throw new Error('Dataset demasiado grande');
  const rows = raw.split(/\r?\n/).filter(x => x.trim()).map((line, i) => {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`JSONL inválido en línea ${i + 1}`); }
    return Array.isArray(row.prompt)
      ? convertTrainingRow(row, i + 1)
      : convertConversation(row, i + 1);
  });
  if (!rows.length) throw new Error('Holdout vacío');
  // Round-robin by session so a large single chat session cannot monopolize the benchmark.
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.sourceSession)) groups.set(row.sourceSession, []);
    groups.get(row.sourceSession).push(row);
  }
  const selected = [];
  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const group of groups.values()) {
      if (selected.length >= limit) break;
      if (group.length) { selected.push(group.shift()); progressed = true; }
    }
  }
  const seen = new Set();
  for (const row of selected) {
    if (seen.has(row.id)) throw new Error('IDs de holdout duplicados');
    seen.add(row.id);
  }
  return { conversations: selected, sha256: hash(raw), totalAvailable: rows.length,
    steps: selected.reduce((n, x) => n + x.steps.length, 0) };
}
export function datasetFingerprint(dataset) {
  return { sha256: dataset.sha256, conversations: dataset.conversations.length, steps: dataset.steps };
}
