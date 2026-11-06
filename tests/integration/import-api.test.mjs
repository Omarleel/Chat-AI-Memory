import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../../src/infra/sqlite-repository.mjs';
import { ImportService } from '../../src/app/import-service.mjs';
import { createHttpServer } from '../../src/transport/http-server.mjs';
import { fileURLToPath } from 'node:url';

const PHONE = '51999999999';
const OTHER = '51988888888';
const TXT = fileURLToPath(new URL('../../examples/chat-demo.txt', import.meta.url));
const TOKEN = 'S'.repeat(48);
const AUTH = {Authorization: `Bearer ${TOKEN}`, 'content-type':'application/json'};

test('historial TXT queda asociado al contacto, no se duplica, se lista y se borra', async () => {
  const repository = new SqliteRepository(':memory:');
  try {
    const service = new ImportService({repository, llm:{embedMany: async chunks => chunks.map(() => [1, 0])}});
    const first = await service.importFile({path:TXT,contact:PHONE,self:'Alex',peer:'Diego',fileName:'amigos.txt'});
    assert.equal(first.importedMessages, 7);
    assert.equal(first.contact, PHONE);
    assert.match(first.importHash, /^[a-f0-9]{64}$/);
    let imports = repository.listChatImports(PHONE);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].fileName, 'amigos.txt');
    assert.equal(imports[0].peer, 'Diego');
    assert.equal(repository.listChatImports(OTHER).length, 0);
    const next = await service.importFile({path:TXT,contact:PHONE,self:'Alex',peer:'Diego',fileName:'amigos.txt'});
    assert.equal(next.skipped, true);
    assert.equal(repository.listChatImports(PHONE).length, 1);
    repository.eraseContact(PHONE);
    assert.equal(repository.listChatImports(PHONE).length, 0);
    assert.equal(repository.countHistory(PHONE), 0);
  } finally {repository.close();}
});

test('HTTP importación de TXT exige token, allowlist, nombre temporal y acepta IDs con dos puntos', async () => {
  const repository = new SqliteRepository(':memory:');
  repository.setConsent(PHONE, true);
  const requests = [];
  const imports = {importFile: async args => {requests.push(args); return {skipped:false,importedMessages:7,chunks:1};}};
  const worker = {sendDraft: async id => {requests.push({draft:id}); return 'ok';}};
  const config = {adminToken:TOKEN,waProvider:'web',wa:{},allowedContacts:new Set([PHONE])};
  const server = createHttpServer({repository,config,worker,replies:{},imports});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const filename = `upload-${'a'.repeat(32)}.txt`;
    const body = (contact, file = filename) => JSON.stringify({contact, filename:file,self:'Alex',peer:'Diego',originalFilename:'chat.txt'});
    let response = await fetch(`${base}/api/chats/import`, {method:'POST',headers:{'content-type':'application/json'},body:body(PHONE)});
    assert.equal(response.status,401);
    response = await fetch(`${base}/api/chats/import`, {method:'POST',headers:AUTH,body:body(OTHER)});
    assert.equal(response.status,403);
    response = await fetch(`${base}/api/chats/import`, {method:'POST',headers:AUTH,body:body(PHONE,'../etc/passwd')});
    assert.equal(response.status,400);
    response = await fetch(`${base}/api/chats/import`, {method:'POST',headers:AUTH,body:body(PHONE)});
    assert.equal(response.status,200);
    assert.equal((await response.json()).linkedTo,PHONE);
    assert.equal(requests[0].contact, PHONE);
    assert.equal(requests[0].fileName, 'chat.txt');
    response = await fetch(`${base}/api/chats/imports?contact=${OTHER}`, {headers:AUTH});
    assert.equal(response.status,403);
    response = await fetch(`${base}/api/chats/imports?contact=${PHONE}`, {headers:AUTH});
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).imports, []);
    response = await fetch(`${base}/api/drafts/web:51999999999:123/send`, {method:'POST',headers:AUTH});
    assert.equal(response.status,200);
    assert.deepEqual(requests[1], {draft:'web:51999999999:123'});
  } finally {await new Promise(resolve => server.close(resolve));repository.close();}
});

test('importación devuelve diagnóstico seguro para modelo inexistente, Qdrant y archivo no accesible', async () => {
  const repository = new SqliteRepository(':memory:');
  const config = {adminToken: TOKEN, waProvider: 'web', wa: {}, allowedContacts: new Set([PHONE]), embedModel: 'embeddinggemma'};
  let error = Object.assign(new Error('Ollama 404: model not found'), {importStage: 'embed'});
  const imports = {importFile: async () => {throw error;}};
  const server = createHttpServer({repository, config, worker: {}, replies: {}, imports});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const filename = `upload-${'b'.repeat(32)}.txt`;
  const payload = JSON.stringify({contact: PHONE, filename, self: 'Tú', peer: 'Diego R', originalFilename: 'chat.txt'});
  try {
    const send = async () => {
      const response = await fetch(`${base}/api/chats/import`, {method: 'POST', headers: AUTH, body: payload});
      return {status: response.status, body: await response.json()};
    };
    let result = await send();
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'EMBED_MODEL_NOT_FOUND');
    assert.match(result.body.hint, /ollama pull embeddinggemma/);
    error = Object.assign(new Error('Qdrant HTTP 401: acceso no autorizado'), {importStage: 'check'});
    result = await send();
    assert.equal(result.status, 502);
    assert.equal(result.body.code, 'QDRANT_AUTH_FAILED');
    error = Object.assign(new Error('EACCES: secrets should not leak'), {code: 'EACCES', importStage: 'read'});
    result = await send();
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'UPLOAD_NOT_READABLE');
    assert.doesNotMatch(JSON.stringify(result.body), /secrets should not leak/);
  } finally {await new Promise(resolve => server.close(resolve)); repository.close();}
});
