import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {TrainingService} from '../../src/app/training-service.mjs';
import {normalizeTrainingRequest, buildIdentityDataset, applyRunnerEvent, TrainingValidationError} from '../../src/domain/training-job.mjs';
import {TrainingRunner} from '../../src/runner/training-runner.mjs';
import {parseTrainStep, splitOutput, stageProgress, trainingCommand, deployCommand, jobPaths} from '../../src/runner/training-pipeline.mjs';
import {TRAINING_SYSTEM} from '../../src/domain/training-dataset.mjs';

const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);

// Sesiones separadas por 3 h: cada una aporta un ejemplo peer → self.
function synthetic(sessions, self = 'Juan', peer = 'Ana') {
  const messages = [];
  for (let i = 0; i < sessions; i++) {
    const t = Date.UTC(2025, 0, 1) + i * 3 * 3600_000;
    messages.push({ordinal: messages.length, isoTimestamp: new Date(t).toISOString(), rawTimestamp: String(t), author: peer, role: 'peer', text: `pregunta ${i}`});
    messages.push({ordinal: messages.length, isoTimestamp: new Date(t + 60_000).toISOString(), rawTimestamp: String(t + 60_000), author: self, role: 'self', text: `respuesta ${i}`});
  }
  return messages;
}

function seeded() {
  const repository = new SqliteRepository(':memory:');
  for (const [contact, hash, self] of [['51911111111', HASH_A, 'Juan'], ['51922222222', HASH_B, 'Juan']]) {
    repository.recordChatImport({contact, importHash: hash, fileName: 'chat.txt', self, peer: 'Ana', messages: 240, chunks: 1});
    repository.saveImportedMessages(contact, hash, synthetic(120, self));
  }
  const config = {allowedContacts: new Set(['51911111111', '51922222222']), chatModel: 'estilo:q4', reasoningModel: 'qwen3.5:9b', embedModel: 'embeddinggemma'};
  return {repository, service: new TrainingService({repository, config})};
}
const sources = [{contact: '51911111111', importHash: HASH_A}, {contact: '51922222222', importHash: HASH_B}];

test('la petición se normaliza y no puede pisar el modelo activo', () => {
  const spec = normalizeTrainingRequest({modelName: 'Juan', selfName: 'Juan', sources: [{contact: '51911111111', importHash: HASH_A}]});
  assert.deepEqual([spec.modelName, spec.tag, spec.quant, spec.steps, spec.validateOnly], ['juan', 'juan:q4', 'q4_K_M', 400, false]);
  assert.throws(() => normalizeTrainingRequest({modelName: 'estilo', selfName: 'X', sources: spec.sources}, {protectedModels: ['estilo:q4']}), TrainingValidationError);
  assert.throws(() => normalizeTrainingRequest({...spec, steps: 5}), /steps/);
  assert.throws(() => normalizeTrainingRequest({...spec, baseModel: '../etc'}), /baseModel/);
  assert.throws(() => normalizeTrainingRequest({...spec, sources: [...spec.sources, ...spec.sources]}), /repetida/);
});

test('el dataset de varios chats no comparte sesiones entre particiones', () => {
  const data = buildIdentityDataset([{contact: '1', importHash: HASH_A, messages: synthetic(40)}, {contact: '2', importHash: HASH_B, messages: synthetic(40)}]);
  const sessions = split => new Set(data[split].map(r => r.provenance.session));
  for (const [a, b] of [['train', 'validation'], ['train', 'test'], ['validation', 'test']])
    assert.equal([...sessions(a)].filter(s => sessions(b).has(s)).length, 0);
  assert.equal(data.stats.sources.length, 2);
  assert.equal(data.train.length + data.validation.length + data.test.length, 80);
});

test('crear, reclamar, informar y terminar un trabajo; el dataset sale de SQLite', () => {
  const {repository, service} = seeded();
  assert.throws(() => service.createJob({modelName: 'juan', sources: [{contact: '51999999999', importHash: HASH_A}]}), /allowlist/);
  const job = service.createJob({modelName: 'juan', sources});
  assert.equal(job.state, 'queued');
  assert.equal(job.selfName, 'Juan');
  assert.equal(job.spec.datasetStats.counts.train, 204);
  assert.throws(() => service.createJob({modelName: 'juan', sources}), /activo/);
  const claimed = service.claim({name: 'runner@pc', python: true});
  assert.equal(claimed.state, 'running');
  assert.equal(service.claim({name: 'otro', python: true}), null, 'un solo trabajo activo a la vez');
  assert.equal(service.datasetFor(job.id).train.length, 204);
  service.report(job.id, {stage: 'train', progress: 0.5, logs: ['paso 1', 'paso 2']});
  assert.deepEqual(service.getJob(job.id).logs.map(l => l.line), ['paso 1', 'paso 2']);
  assert.equal(service.cancel(job.id).state, 'cancel_requested');
  assert.equal(service.report(job.id, {logs: []}).cancelRequested, true);
  const done = service.report(job.id, {state: 'cancelled', message: 'Cancelado'});
  assert.equal(done.job.state, 'cancelled');
  assert.ok(done.job.finishedAt);
  assert.equal(service.datasetFor(job.id), null, 'el dataset solo se entrega a trabajos en curso');
  assert.throws(() => applyRunnerEvent(done.job, {stage: 'train'}), /terminó/);
  repository.close();
});

test('el titular debe coincidir con el self de los chats', () => {
  const {repository, service} = seeded();
  repository.recordChatImport({contact: '51922222222', importHash: 'c'.repeat(64), fileName: 'x.txt', self: 'Pedro', peer: 'Ana', messages: 2, chunks: 1});
  assert.throws(() => service.createJob({modelName: 'mix', sources: [sources[0], {contact: '51922222222', importHash: 'c'.repeat(64)}]}), /mismo titular/);
  assert.throws(() => service.createJob({modelName: 'juan', selfName: 'Pedro', sources}), /no coincide/);
  repository.close();
});

test('un ejecutor reiniciado marca como fallido su trabajo huérfano', () => {
  const {repository, service} = seeded();
  const job = service.createJob({modelName: 'juan', sources});
  service.claim({name: 'runner@pc', python: true});
  service.createJob({modelName: 'juan2', sources});
  const next = service.claim({name: 'runner@pc', python: true});
  assert.equal(service.getJob(job.id).job.state, 'failed');
  assert.equal(next.modelName, 'juan2');
  repository.close();
});

test('un trabajo fallido vuelve a la cola con el mismo id para reanudarse', () => {
  const {repository, service} = seeded();
  const job = service.createJob({modelName: 'juan', sources});
  assert.throws(() => service.retry(job.id), /Solo se reintenta/);
  service.claim({name: 'runner@pc', python: true});
  service.claim({name: 'runner@pc', python: true});
  assert.equal(service.getJob(job.id).job.state, 'failed');
  const requeued = service.retry(job.id);
  assert.equal(requeued.state, 'queued');
  assert.equal(requeued.finishedAt, null);
  assert.equal(service.claim({name: 'runner@pc', python: true}).id, job.id);
  assert.equal(service.retry('train_inexistente_00000000'), null);
  repository.close();
});

test('el plan de ejecución arma comandos y avance sin ejecutar nada', () => {
  const job = {id: 'train_x_00000000', modelName: 'juan', spec: {quant: 'q4_K_M', tag: 'juan:q4', baseModel: 'Qwen/Qwen2.5-7B-Instruct',
    steps: 400, learningRate: 5e-5, maxLength: 1024, validateOnly: false}};
  const paths = jobPaths('/repo', job);
  assert.match(paths.gguf, /juan-q4_k_m\.gguf$/);
  assert.deepEqual(trainingCommand(job, paths, 'py').args.slice(0, 2), ['scripts/train_lora.py', '--dataset']);
  assert.ok(trainingCommand(job, paths, 'py').args.includes('--resume'), 'reanuda desde checkpoints si existen');
  assert.ok(deployCommand(job, paths).args.includes('juan:q4'));
  assert.equal(deployCommand(job, paths).args.at(-1), TRAINING_SYSTEM, 'el modelo desplegado declara su prompt de entrenamiento');
  assert.equal(parseTrainStep(' 50%|█████     | 200/400 [10:00<10:00]', 400), 0.5);
  assert.equal(parseTrainStep('100%|██| 64/64 [00:30<00:00]', 400), null, 'la barra de evaluación no cuenta');
  assert.deepEqual(splitOutput('a\rb\nc'), {lines: ['a', 'b'], rest: 'c'});
  assert.equal(stageProgress('train', 0.5), 0.45);
});

function fakeRunner({exitCodes = [0, 0], cancelAt = null} = {}) {
  const events = [], written = {}, removed = [];
  const job = {id: 'train_x_00000000', modelName: 'juan', spec: {quant: 'q4_K_M', tag: 'juan:q4', baseModel: 'Qwen/Qwen2.5-7B-Instruct',
    steps: 10, learningRate: 5e-5, maxLength: 1024, validateOnly: false, keepMerged: false}};
  let claimed = false;
  const engine = {
    claim: async () => claimed ? null : (claimed = true, job),
    heartbeat: async () => ({}),
    dataset: async (id, split) => split === 'manifest' ? {counts: {train: 1, validation: 1, test: 1}} : '{"x":1}\n',
    report: async (id, event) => {events.push(event); return {job: {...job, ...event}, cancelRequested: cancelAt !== null && events.length >= cancelAt};}
  };
  const processes = {spawn: (command, args) => {
    let out; const code = exitCodes.shift();
    return {exited: new Promise(r => setTimeout(() => {out?.(' 50%|█| 5/10 [00:01<00:01]\rlisto\n'); r(code);}, 5)),
      onOutput: fn => {out = fn;}, kill: () => {}};
  }};
  const files = {mkdir: async () => {}, writeFile: async (p, d) => {written[p] = d;}, rm: async p => {removed.push(p);},
    readFile: async () => JSON.stringify({baseline: {eval_loss: 2}, final: {eval_loss: 1.5}, audit: {train: 1}})};
  const runner = new TrainingRunner({engine, processes, files, gpu: {unloadModels: async () => ['estilo:q4']}, root: '/repo',
    python: 'py', info: {name: 'runner@test', python: true}, flushMs: 1});
  return {runner, events, written, removed};
}

test('el ejecutor entrena, despliega y limpia los intermedios', async () => {
  const {runner, events, written, removed} = fakeRunner();
  const final = await runner.tick();
  assert.equal(final.job.state, 'succeeded');
  const last = events.at(-1);
  assert.deepEqual([last.result.ollamaModel, last.result.improved, last.result.finalEvalLoss], ['juan:q4', true, 1.5]);
  assert.ok(events.some(e => e.stage === 'free_gpu'));
  assert.ok(events.flatMap(e => e.logs ?? []).some(l => l.includes('estilo:q4')));
  assert.equal(Object.keys(written).filter(p => p.endsWith('.jsonl')).length, 3);
  assert.equal(removed.length, 2, 'borra merged y GGUF');
});

test('el ejecutor informa fallo con el código de salida y respeta la cancelación', async () => {
  const failed = fakeRunner({exitCodes: [3]});
  assert.equal((await failed.runner.tick()).job.state, 'failed');
  assert.match(failed.events.at(-1).message, /código 3/);
  const cancelled = fakeRunner({cancelAt: 2});
  assert.equal((await cancelled.runner.tick()).job.state, 'cancelled');
});
