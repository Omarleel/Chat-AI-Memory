import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {QdrantHistoryStore} from '../../src/infra/qdrant-history-store.mjs';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {MemoryService} from '../../src/app/memory-service.mjs';
import {ImportService} from '../../src/app/import-service.mjs';
import {fileURLToPath} from 'node:url';
import {cosine} from '../../src/domain/history.mjs';

function within(point, filter) {
  return (filter?.must ?? []).every(c => point.payload[c.key] === c.match.value);
}
async function fakeQdrant() {
  let collection = null;
  const points = new Map();
  const indexes = new Set();
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests++;
    assert.equal(req.headers['api-key'], 'test-key');
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : {};
    const send = (code, data) => {res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(data));};
    if (req.method === 'GET' && url.pathname === '/collections/memory_test')
      return collection ? send(200, {result: {config: {params: {vectors: collection}}}}) : send(404, {status: 'not found'});
    if (req.method === 'PUT' && url.pathname === '/collections/memory_test') {
      collection = body.vectors;
      return send(200, {result: true});
    }
    if (!collection) return send(404, {});
    if (req.method === 'PUT' && url.pathname.endsWith('/index')) {
      indexes.add(body.field_name); return send(200, {result: true});
    }
    if (req.method === 'PUT' && url.pathname.endsWith('/points')) {
      for (const p of body.points) points.set(p.id, p);
      return send(200, {result: {status: 'completed'}});
    }
    if (req.method === 'POST' && url.pathname.endsWith('/points/count')) {
      return send(200, {result: {count: [...points.values()].filter(p => within(p, body.filter)).length}});
    }
    if (req.method === 'POST' && url.pathname.endsWith('/points/scroll')) {
      const selected = [...points.values()].filter(p => within(p, body.filter)).sort((a,b) => a.id.localeCompare(b.id));
      const start = body.offset ? selected.findIndex(p=>p.id===body.offset)+1 : 0;
      const page = selected.slice(start, start + body.limit);
      return send(200, {result:{points:page.map(p=>({id:p.id,payload:{body:p.payload.body}})),
        next_page_offset:start + page.length < selected.length ? page.at(-1).id : null}});
    }
    if (req.method === 'POST' && url.pathname.endsWith('/points/query')) {
      return send(200, {result: {points: [...points.values()].filter(p => within(p, body.filter))
        .map(p => ({id:p.id,payload:p.payload,score:cosine(p.vector,body.query)}))
        .filter(p => p.score >= body.score_threshold)
        .sort((a,b) => b.score-a.score).slice(0, body.limit)}});
    }
    if (req.method === 'POST' && url.pathname.endsWith('/points/delete')) {
      for (const [id,p] of points) if (within(p,body.filter)) points.delete(id);
      return send(200, {result: true});
    }
    send(404, {error: 'unknown route'});
  });
  server.listen(0,'127.0.0.1');
  await once(server, 'listening');
  return {server, url: `http://127.0.0.1:${server.address().port}`, points, indexes, countRequests: () => requests,
    close: () => new Promise(resolve => server.close(resolve))};
}

test('Qdrant: creación, dimensiones, metadatos, filtro aislado y borrado', async () => {
  const fake = await fakeQdrant();
  const store = new QdrantHistoryStore({baseUrl: fake.url, collection:'memory_test', apiKey:'test-key', embedModel:'embeddinggemma'});
  try {
    assert.equal(await store.countHistory('11111111'), 0);
    await store.saveChunks('11111111', 'sha1', 0, ['Partido en el parque', 'Cena jueves'], [[1,0], [0,1]]);
    assert.deepEqual([...fake.indexes].sort(), ['contact','embed_model','import_hash','kind','memory_id']);
    assert.equal(await store.hasImport('11111111','sha1',2), true);
    assert.equal(await store.hasImport('11111111','sha1',3), false);
    assert.equal(await store.hasImport('22222222','sha1',1), false);
    await store.saveChunks('22222222', 'sha2', 0, ['Secreto ajeno'], [[1,0]]);
    await store.saveChunks('11111111', 'sha1', 0, ['Partido en el parque', 'Cena jueves'], [[1,0], [0,1]]);
    assert.equal(await store.countHistory('11111111'), 2);
    assert.deepEqual((await store.searchByTerms('11111111', ['parque'])).map(p=>p.body), ['Partido en el parque']);
    assert.equal((await store.searchByTerms('11111111', ['Secreto'])).length,0,'no se mezclan contactos');
    const results = await store.search('11111111', [1,0], 3);
    assert.deepEqual(results.map(r => r.body), ['Partido en el parque', 'Cena jueves'].slice(0,1)); // threshold removes orthogonal vector
    assert.ok(results.every(p => !p.body.includes('Secreto ajeno')));
    await assert.rejects(() => store.saveChunks('11111111','sha3',0,['Bad'],[[0,0,1]]), /dimensiones|incompatible/i);
    await store.eraseContact('11111111');
    assert.equal(await store.countHistory('11111111'), 0);
    assert.equal(await store.countHistory('22222222'), 1);
  } finally {await fake.close();}
});

test('Qdrant: historial importado + memorias explícitas, eliminación y aislamiento', async () => {
  const fake = await fakeQdrant();
  const sqlite = new SqliteRepository(':memory:');
  const historyStore = new QdrantHistoryStore({baseUrl: fake.url, collection:'memory_test', apiKey:'test-key'});
  const llm = {embed: async () => [1,0], embedMany: async texts => texts.map(() => [1,0])};
  const sample = fileURLToPath(new URL('../../examples/chat-demo.txt', import.meta.url));
  try {
    const importer = new ImportService({repository:sqlite, historyStore, llm});
    const first = await importer.importFile({path: sample, contact:'11111111', self:'Alex', peer:'Diego'});
    assert.equal(first.skipped,false);
    assert.equal((await importer.importFile({path: sample, contact:'11111111', self:'Alex', peer:'Diego'})).skipped,true);
    assert.ok(await historyStore.countHistory('11111111'));
    const memory = new MemoryService({repository: sqlite, historyStore, llm});
    const id = await memory.add('11111111', 'El sábado acordamos ir al estadio');
    assert.equal(sqlite.listMemories('11111111').length,1);
    assert.ok((await historyStore.search('11111111',[1,0],10)).some(x => x.kind==='fact'));
    await memory.delete('11111111',id);
    assert.equal(sqlite.listMemories('11111111').length,0);
    assert.ok(!(await historyStore.search('11111111',[1,0],10)).some(x => x.kind==='fact'));
    await memory.eraseContact('11111111');
    assert.equal(await historyStore.countHistory('11111111'),0);
    assert.equal(sqlite.listStyles('11111111').length,0);
  } finally {sqlite.close(); await fake.close();}
});
