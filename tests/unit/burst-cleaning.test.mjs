import test from 'node:test';
import assert from 'node:assert/strict';
import {untilGap, keepFromKinds, cleanTrainRows, burstsToLabel, normalizeCleaning, parseBurstKinds, holderBurstGap, labelCovers} from '../../src/domain/burst-cleaning.mjs';
import {buildIdentityDataset} from '../../src/domain/training-job.mjs';
import {BurstLabelingService} from '../../src/app/burst-labeling-service.mjs';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {TrainingService} from '../../src/app/training-service.mjs';

const T0 = Date.UTC(2025, 0, 1);
const msg = (ordinal, role, text, minute) => ({ordinal, role, author: role === 'self' ? 'Alex' : 'Ana', text,
  isoTimestamp: new Date(T0 + minute * 60_000).toISOString(), rawTimestamp: String(minute)});

// Sesiones separadas por 3 h; en cada una Ana pregunta y Alex responde con una ráfaga de 3 mensajes.
function chat(sessions = 60) {
  const messages = [];
  for (let i = 0; i < sessions; i++) {
    const m = i * 180;
    messages.push(msg(messages.length, 'peer', `vienes ${i}?`, m), msg(messages.length + 1, 'self', `si ${i}`, m + 1),
      msg(messages.length + 2, 'self', `a las 8`, m + 1), msg(messages.length + 3, 'self', `ayer fui al cine`, m + (i % 5 ? 2 : 10)));
  }
  return messages;
}

test('corte por pausa y etiquetas: el primer mensaje nuevo descarta, los siguientes se cortan', () => {
  const ms = [{time: 0}, {time: 60_000}, {time: 200_000}];
  assert.equal(untilGap(ms).length, 2);
  assert.deepEqual([keepFromKinds(['responde', 'sigue', 'nuevo']), keepFromKinds(['nuevo', 'responde']), keepFromKinds(['responde', 'sigue'])], [2, 0, 2]);
  const m = flags => ({messages: flags.map((offTopic, i) => ({n: i + 1, offTopic}))});
  assert.deepEqual(parseBurstKinds(m([false, true]), 2), ['responde', 'nuevo']);
  assert.equal(parseBurstKinds({messages: [{n: 1, offTopic: 'no'}]}, 1), null);
  assert.equal(parseBurstKinds({messages: [{n: 2, offTopic: false}]}, 2), null, 'numeración fuera de orden');
  assert.equal(parseBurstKinds(m([false]), 2), null);
  assert.deepEqual(parseBurstKinds(m([false]), 2, {fillMissing: true}), ['responde', 'responde'], 'último intento: ante la duda, responde');
  assert.deepEqual(parseBurstKinds(m([false, true]), 4), ['responde', 'nuevo'], 'incompleta pero decidida');
  assert.deepEqual(normalizeCleaning({bursts: 'llm'}), {timeSplit: true, bursts: 'llm'});
});

test('la limpieza solo toca train y respeta pausas y etiquetas', () => {
  const messages = chat();
  const plain = buildIdentityDataset([{contact: '1', importHash: 'a'.repeat(64), messages}]);
  const timed = buildIdentityDataset([{contact: '1', importHash: 'a'.repeat(64), messages}], {cleaning: normalizeCleaning({timeSplit: true})});
  assert.deepEqual(timed.validation, plain.validation);
  assert.deepEqual(timed.test, plain.test);
  const cut = timed.train.filter(r => r.provenance.cleaned);
  assert.ok(cut.length > 0 && cut.every(r => !r.completion[0].content.includes('cine')), 'la línea tras 10 min se corta');
  assert.equal(timed.stats.cleaning.timeCut, cut.length);
  const byOrdinal = new Map(messages.map(m => [m.ordinal, m]));
  const labels = new Map(burstsToLabel(plain.train, byOrdinal).map(({row}, i) => [row.provenance.hash, {keep: i % 2 ? 0 : 2}]));
  const llm = cleanTrainRows(plain.train, byOrdinal, normalizeCleaning({bursts: 'llm'}), labels);
  assert.ok(llm.stats.dropped > 0 && llm.stats.unlabeled === 0);
  assert.ok(llm.rows.every(r => !r.completion[0].content.includes('cine')));
  const missing = cleanTrainRows(plain.train, byOrdinal, normalizeCleaning({bursts: 'llm'}), new Map());
  assert.ok(missing.stats.unlabeled > 0);
});

test('el etiquetado guarda una etiqueta por ráfaga y el trabajo exige etiquetas completas', async () => {
  const repository = new SqliteRepository(':memory:');
  const hash = 'd'.repeat(64);
  repository.recordChatImport({contact: '51944444444', importHash: hash, fileName: 'chat.txt', self: 'Alex', peer: 'Ana', messages: 240, chunks: 1});
  repository.saveImportedMessages('51944444444', hash, chat());
  const prompts = [];
  const llm = {chatDetails: async (system, input) => {prompts.push({system, input});
    const n = JSON.parse(input).burst.length;
    return {content: JSON.stringify({messages: Array.from({length: n}, (_, i) => ({n: i + 1, offTopic: i === n - 1}))})};}};
  const labeler = new BurstLabelingService({repository, llm, config: {reasoningModel: 'r'}, concurrency: 2});
  const service = new TrainingService({repository, burstLabeler: labeler, config: {allowedContacts: new Set(['51944444444']), reasoningModel: 'r'}});
  const input = {modelName: 'alex', sources: [{contact: '51944444444', importHash: hash}], cleaning: {bursts: 'llm'}};
  assert.throws(() => service.createJob(input), /ráfagas por etiquetar/);
  service.startBurstLabeling(input);
  while (service.burstLabelingStatus().state === 'running') await new Promise(r => setTimeout(r, 5));
  const status = service.burstLabelingStatus();
  assert.equal(status.state, 'done');
  assert.equal(status.done, status.queued);
  assert.match(prompts[0].system, /Alex envió a Ana/);
  const job = service.createJob(input);
  assert.equal(job.spec.cleaning.bursts, 'llm');
  assert.equal(job.spec.datasetStats.cleaning.unlabeled, 0);
  repository.close();
});

test('el cliente del modelo general no hereda las penalizaciones de repetición del redactor', async () => {
  const {OllamaClient} = await import('../../src/infra/ollama.mjs');
  const writer = new OllamaClient({baseUrl: 'http://127.0.0.1:1', chatModel: 'w', repeatPenalty: 1.15, presencePenalty: 0.35, frequencyPenalty: 0.25});
  const reasoner = writer.asReasoner('r');
  assert.deepEqual([reasoner.chatModel, reasoner.repeatPenalty, reasoner.presencePenalty, reasoner.frequencyPenalty], ['r', 1, 0, 0]);
  assert.equal(writer.withModel('x').repeatPenalty, 1.15);
});

test('la pausa que corta una ráfaga sale de cada titular, no de una constante', () => {
  // Alex escribe seguido (0–1 min entre líneas); Juan deja 5–6 min entre las líneas de una misma respuesta.
  // Sesiones de 8 mensajes separadas por 3 h: así hay filas de train.
  const writer = step => Array.from({length: 160}, (_, i) => msg(i, i % 4 === 0 ? 'peer' : 'self', `m${i}`, i * step + Math.floor(i / 8) * 180));
  assert.equal(holderBurstGap([chat()]), 2);
  assert.equal(holderBurstGap([writer(5.5)]), 6);
  assert.equal(holderBurstGap([chat(3)]), 2, 'con pocos datos usa el valor de respaldo');
  const slow = writer(5.5);
  const ds = buildIdentityDataset([{contact: '1', importHash: 'b'.repeat(64), messages: slow}], {cleaning: normalizeCleaning({timeSplit: true})});
  assert.equal(ds.stats.cleaning.gapMinutes, 6);
  assert.ok(ds.train.length > 0);
  assert.equal(ds.stats.cleaning.timeCut, 0, 'las líneas de Juan a 5–6 min siguen siendo una sola respuesta');
  assert.ok(cleanTrainRows([], new Map(), normalizeCleaning({bursts: 'llm', gapMinutes: 6})).rows);
  const byOrdinal = new Map(slow.map(m => [m.ordinal, m]));
  const rows = buildIdentityDataset([{contact: '1', importHash: 'b'.repeat(64), messages: slow}]).train;
  const stale = new Map(rows.map(r => [r.provenance.hash, {keep: 1, n: 1}]));
  assert.ok(cleanTrainRows(rows, byOrdinal, normalizeCleaning({bursts: 'llm', gapMinutes: 6}), stale).stats.unlabeled > 0, 'etiqueta de otra ráfaga = pendiente');
  assert.deepEqual([labelCovers({keep: 1, n: 2}, 3), labelCovers({keep: 2, n: 2}, 3), labelCovers({keep: 3, n: 3}, 2), labelCovers(null, 2)], [true, false, true, false]);
});
