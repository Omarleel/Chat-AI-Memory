import test from 'node:test';
import assert from 'node:assert/strict';
import {historyPairs, typicalPairs, exampleSelector, shortApprovalLimit, isShortApprovable, datasetPairs} from '../../src/domain/holder-examples.mjs';
import {summarizeCalibration} from '../../src/domain/reviewer-calibration.mjs';
import {ResponseValidationService} from '../../src/app/response-validation-service.mjs';
import {ReviewerCalibrationService} from '../../src/app/reviewer-calibration-service.mjs';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {TrainingService} from '../../src/app/training-service.mjs';

test('los pares del historial agrupan ráfagas y descartan multimedia', () => {
  const pairs = historyPairs([{role: 'peer', text: 'hola'}, {role: 'peer', text: 'vienes?'}, {role: 'self', text: 'si'},
    {role: 'self', text: 'a las 8'}, {role: 'peer', text: '<Multimedia omitido>'}, {role: 'self', text: 'ok'}, {role: 'peer', text: 'chau'}]);
  assert.deepEqual(pairs, [{incoming: 'hola\nvienes?', reply: 'si\na las 8'}]);
});

test('la muestra típica sigue la distribución de longitud de cada identidad', () => {
  const terse = Array.from({length: 40}, (_, i) => ({incoming: `m${i}`, reply: i < 36 ? 'ok' : 'bueno ya, nos vemos mañana entonces'}));
  const verbose = Array.from({length: 40}, (_, i) => ({incoming: `m${i}`, reply: `respuesta larga y detallada número ${i} con varias ideas`}));
  assert.equal(typicalPairs(terse, 5).filter(p => p.reply === 'ok').length, 4);
  assert.equal(typicalPairs(verbose, 5).filter(p => p.reply.length > 30).length, 5);
});

test('el selector mezcla pares relevantes y típicos sin duplicar', () => {
  const pairs = [{incoming: 'vamos al cine', reply: 'ya'}, {incoming: 'que haces', reply: 'nada'}, {incoming: 'hola', reply: 'hola'}];
  const examples = exampleSelector(pairs, {relevant: 2, typical: 3})('el cine de mañana?');
  assert.deepEqual(examples[0], {they: 'vamos al cine', reply: 'ya'});
  assert.equal(examples.length, 3);
});

test('la aprobación breve usa el límite propio de la identidad y está apagada por defecto', () => {
  assert.equal(shortApprovalLimit({medianChars: 17}, 'off'), null);
  assert.equal(shortApprovalLimit({medianChars: 17}, 'shape'), 17);
  assert.equal(shortApprovalLimit({medianChars: 60}, 'shape'), 60);
  assert.equal(isShortApprovable('Ok', 17), true);
  assert.equal(isShortApprovable('a las 9', 17), false, 'las cifras siempre pasan por el revisor');
  assert.equal(isShortApprovable('Ok', null), false);
});

test('el revisor recibe los intercambios reales y la regla de brevedad propia', async () => {
  const calls = [];
  const reviewer = new ResponseValidationService({llm: {chat: async (system, prompt) => {calls.push({system, prompt}); return '{"reason":"ok","valid":true}';}}});
  await reviewer.validate({question: 'vienes?', answer: 'ya', selfAuthor: 'Alex', peerAuthor: 'Ana', judgeOnly: true,
    holderExamples: [{they: 'vamos?', reply: 'ya'}]});
  assert.match(calls[0].prompt, /"holderExamples":\[\{"they":"vamos\?","reply":"ya"\}\]/);
  assert.match(calls[0].system, /No rechaces un borrador por breve/);
  await reviewer.validate({question: 'vienes?', answer: 'ya', selfAuthor: 'Alex', peerAuthor: 'Ana', judgeOnly: true});
  assert.doesNotMatch(calls[1].prompt, /holderExamples/);
});

test('la aprobación breve evita el revisor salvo en la revisión de estilo', async () => {
  let calls = 0;
  const reviewer = new ResponseValidationService({llm: {chat: async () => {calls++; return '{"reason":"cambia el contenido","valid":false}';}}});
  const short = await reviewer.validate({question: 'vienes?', answer: 'Ok', selfAuthor: 'Alex', peerAuthor: 'Ana', judgeOnly: true, shortApprovalLimit: 17});
  assert.deepEqual([short.valid, short.short, calls], [true, true, 0]);
  await assert.rejects(reviewer.validate({question: 'vienes?', answer: 'Ok', baselineAnswer: 'No puedo hoy, mañana sí', allowRepair: false,
    selfAuthor: 'Alex', peerAuthor: 'Ana', shortApprovalLimit: 17}));
  assert.equal(calls, 1);
});

const row = (split, session, reply) => ({prompt: [{role: 'system', content: 's'}, ...Array.from({length: 5}, (_, i) =>
  ({role: i % 2 ? 'assistant' : 'user', content: `turno ${i}`}))], completion: [{role: 'assistant', content: reply}],
  provenance: {split, session, hash: `${session}-${reply}`}});

test('la calibración cuenta respuestas reales aprobadas sin guardar texto', async () => {
  const llm = {chat: async (_s, prompt) => /BORRADOR:\nok$/.test(prompt) ? '{"reason":"breve","valid":false}' : '{"reason":"bien","valid":true}'};
  const service = new ReviewerCalibrationService({llm});
  const testRows = ['ok', 'claro que sí', 'ok', 'mañana'].map((r, i) => row('test', `s${i}`, r));
  const summary = await service.calibrate({testRows, trainRows: [row('train', 't1', 'ya')], selfName: 'Alex'});
  assert.deepEqual([summary.judged, summary.approved, summary.realApprovalRate, summary.reliable, summary.examples], [4, 2, 0.5, false, true]);
  assert.equal(JSON.stringify(summary).includes('claro'), false);
  await assert.rejects(service.calibrate({testRows: [row('train', 'x', 'ok')], trainRows: [], selfName: 'Alex'}), /split=test/);
  assert.equal(summarizeCalibration([{valid: true}, {error: 'x'}]).errors, 1);
  assert.equal(datasetPairs([row('train', 'a', 'ya')])[0].reply, 'ya');
});

test('al terminar un entrenamiento se calibra el revisor y queda en el resultado', async () => {
  const repository = new SqliteRepository(':memory:');
  const hash = 'c'.repeat(64);
  repository.recordChatImport({contact: '51933333333', importHash: hash, fileName: 'chat.txt', self: 'Alex', peer: 'Ana', messages: 480, chunks: 1});
  const messages = [];
  for (let i = 0; i < 120; i++) {
    const t = Date.UTC(2025, 0, 1) + i * 3 * 3600_000;
    for (const [k, role, author] of [[0, 'peer', 'Ana'], [1, 'self', 'Alex'], [2, 'peer', 'Ana'], [3, 'self', 'Alex'], [4, 'peer', 'Ana'], [5, 'self', 'Alex']])
      messages.push({ordinal: messages.length, isoTimestamp: new Date(t + k * 60_000).toISOString(), rawTimestamp: String(t + k), author, role, text: `${role} ${i}.${k}`});
  }
  repository.saveImportedMessages('51933333333', hash, messages);
  const seen = [];
  const calibrator = {calibrate: async input => {seen.push(input); return {judged: 3, approved: 3, realApprovalRate: 1, reliable: true};}};
  const service = new TrainingService({repository, calibrator, config: {allowedContacts: new Set(['51933333333']), reasoningModel: 'qwen3.5:9b'}});
  const job = service.createJob({modelName: 'alex', sources: [{contact: '51933333333', importHash: hash}]});
  service.claim({name: 'runner', python: true});
  service.report(job.id, {state: 'succeeded', result: {ollamaModel: 'alex:q4'}});
  await new Promise(r => setTimeout(r, 20));
  const result = service.getJob(job.id).job.result;
  assert.equal(result.ollamaModel, 'alex:q4');
  assert.deepEqual([result.reviewerCalibration.state, result.reviewerCalibration.realApprovalRate], ['done', 1]);
  assert.deepEqual([seen[0].selfName, seen[0].peerName], ['Alex', 'Ana']);
  assert.ok(seen[0].testRows.every(r => r.provenance.split === 'test'));
  repository.close();
});

test('modo cerrado: el veredicto sale de las respuestas sí/no y la crítica nombra el problema', async () => {
  const replies = ['{"answersLast":true,"addsFacts":false,"mixesSpeakers":false,"contradictsThread":false,"assistantTone":false}',
    '{"answersLast":true,"addsFacts":true,"mixesSpeakers":false,"contradictsThread":false,"assistantTone":false}',
    '{"answersLast":true,"addsFacts":false,"mixesSpeakers":false,"contradictsThread":true,"assistantTone":false}', '{"answersLast":true}'];
  const calls = [];
  const reviewer = new ResponseValidationService({llm: {chat: async (system) => {calls.push(system); return replies.shift();}}, config: {reviewMode: 'closed'}});
  const base = {question: 'vienes?', selfAuthor: 'Alex', peerAuthor: 'Ana', judgeOnly: true};
  assert.equal((await reviewer.validate({...base, answer: 'ya'})).valid, true);
  const invented = await reviewer.validate({...base, answer: 'estoy en el gym'});
  assert.deepEqual([invented.valid, /afirma hechos/.test(invented.reason)], [false, true]);
  const contradicts = await reviewer.validate({...base, answer: 'a las 6'});
  assert.deepEqual([contradicts.valid, /contradice/.test(contradicts.reason)], [false, true]);
  await assert.rejects(reviewer.validate({...base, answer: 'x'}), /inválida/);
  assert.match(calls[0], /answersLast/);
  assert.doesNotMatch(calls[0], /"valid"/);
});
