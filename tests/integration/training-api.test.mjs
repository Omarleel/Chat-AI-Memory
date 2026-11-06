import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpServer} from '../../src/transport/http-server.mjs';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {TrainingService} from '../../src/app/training-service.mjs';
import {ModelService} from '../../src/app/model-service.mjs';

const TOKEN = 'T'.repeat(48), PHONE = '51911111111', HASH = 'a'.repeat(64);
const headers = {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'};

async function withServer(callback, {previewReply = async () => ({answer: 'Bueno'})} = {}) {
  const repository = new SqliteRepository(':memory:');
  repository.recordChatImport({contact: PHONE, importHash: HASH, fileName: 'chat.txt', self: 'Juan', peer: 'Ana', messages: 240, chunks: 1});
  const messages = [];
  for (let i = 0; i < 120; i++) {
    const t = Date.UTC(2025, 0, 1) + i * 3 * 3600_000;
    messages.push({ordinal: 2 * i, isoTimestamp: new Date(t).toISOString(), rawTimestamp: 'x', author: 'Ana', role: 'peer', text: `hola ${i}`},
      {ordinal: 2 * i + 1, isoTimestamp: new Date(t + 60_000).toISOString(), rawTimestamp: 'x', author: 'Juan', role: 'self', text: `dale ${i}`});
  }
  repository.saveImportedMessages(PHONE, HASH, messages);
  const config = {adminToken: TOKEN, waProvider: 'web', wa: {}, allowedContacts: new Set([PHONE]), selfName: 'Juan',
    chatModel: 'estilo:q4', reasoningModel: 'qwen3.5:9b', embedModel: 'embeddinggemma', replyCandidates: 4, autoSend: false};
  const catalog = {listModels: async () => [{name: 'estilo:q4'}, {name: 'qwen3.5:9b'}, {name: 'embeddinggemma:latest'}, {name: 'juan:q4'}]};
  const calls = [];
  const server = createHttpServer({config, repository, worker: {}, replies: {previewReply: async (...a) => {calls.push(a); return previewReply(...a);}},
    training: new TrainingService({repository, config}), models: new ModelService({catalog, config})});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {await callback({base, calls});}
  finally {await new Promise(r => server.close(r)); repository.close();}
}

test('rutas de entrenamiento requieren token y validan la petición', async () => {
  await withServer(async ({base}) => {
    assert.equal((await fetch(`${base}/api/training/jobs`)).status, 401);
    let res = await fetch(`${base}/api/training/jobs`, {method: 'POST', headers, body: JSON.stringify({modelName: 'estilo', quant: 'q4_K_M', sources: [{contact: PHONE, importHash: HASH}]})});
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /en uso/);
    res = await fetch(`${base}/api/training/sources`, {headers});
    assert.equal((await res.json()).sources[0].self, 'Juan');
    res = await fetch(`${base}/api/training/plan`, {method: 'POST', headers, body: JSON.stringify({sources: [{contact: PHONE, importHash: HASH}]})});
    assert.equal((await res.json()).plan.counts.train, 102);
  });
});

test('el ejecutor reclama, descarga el dataset por partición e informa avance', async () => {
  await withServer(async ({base}) => {
    let res = await fetch(`${base}/api/training/jobs`, {method: 'POST', headers, body: JSON.stringify({modelName: 'juan', sources: [{contact: PHONE, importHash: HASH}]})});
    assert.equal(res.status, 201);
    const {job} = await res.json();
    res = await fetch(`${base}/api/training/runner/claim`, {method: 'POST', headers, body: JSON.stringify({name: 'runner@pc', python: true})});
    assert.equal((await res.json()).job.id, job.id);
    res = await fetch(`${base}/api/training/jobs/${job.id}/dataset?split=train`, {headers});
    assert.match(res.headers.get('content-type'), /ndjson/);
    assert.equal((await res.text()).trim().split('\n').length, 102);
    assert.equal((await fetch(`${base}/api/training/jobs/${job.id}/dataset?split=../x`, {headers})).status, 422);
    res = await fetch(`${base}/api/training/jobs/${job.id}/events`, {method: 'POST', headers, body: JSON.stringify({stage: 'train', progress: 0.3, logs: ['loss 2.1']})});
    assert.equal((await res.json()).job.stage, 'train');
    res = await fetch(`${base}/api/training/jobs/${job.id}?after_log=0`, {headers});
    assert.deepEqual((await res.json()).logs.map(l => l.line), ['loss 2.1']);
    res = await fetch(`${base}/api/training/runner`, {headers});
    assert.equal((await res.json()).runner.online, true);
    assert.equal((await fetch(`${base}/api/training/jobs/train_zz_00000000`, {headers})).status, 404);
  });
});

test('modelos, resumen del sistema y redactor alternativo en preview', async () => {
  await withServer(async ({base, calls}) => {
    let res = await fetch(`${base}/api/models`, {headers});
    const models = (await res.json()).models;
    assert.deepEqual(models.find(m => m.name === 'estilo:q4').roles, ['writer']);
    assert.deepEqual(models.find(m => m.name === 'embeddinggemma:latest').roles, ['embedding']);
    res = await fetch(`${base}/api/system`, {headers});
    const {system} = await res.json();
    assert.equal(system.replyCandidates, 4);
    assert.equal(JSON.stringify(system).includes(TOKEN), false);
    const preview = body => fetch(`${base}/api/preview`, {method: 'POST', headers, body: JSON.stringify({contact: PHONE, text: 'Hola', save: false, ...body})});
    assert.equal((await preview({writer_model: 'noexiste:q4'})).status, 422);
    assert.equal((await preview({writer_model: 'embeddinggemma'})).status, 422);
    assert.equal((await preview({writer_model: 'juan:q4'})).status, 200);
    assert.equal(calls.at(-1)[5].writerModel, 'juan:q4');
  });
});
