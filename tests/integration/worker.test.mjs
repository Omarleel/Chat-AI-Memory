import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../../src/infra/sqlite-repository.mjs';
import { QueueWorker } from '../../src/app/queue-worker.mjs';
import { ReplyService } from '../../src/app/reply-service.mjs';

const PHONE = '51999999999';
function setup(autoSend = false) {
  const repository = new SqliteRepository(':memory:');
  const calls = [];
  const llm = {
    embed: async () => [1, 0],
    chat: async (system, prompt) => {calls.push({system, prompt}); return 'Claro, hablamos al toque 😄';}
  };
  const replies = new ReplyService({repository, llm, config: {selfName:'Alex', topK:3}});
  const sends = [];
  const whatsapp = { sendText: async (phone, body) => {sends.push({phone,body}); return 'wamid.sent.' + sends.length;} };
  const config = {selfName:'Alex', allowedContacts: new Set([PHONE]), autoSend};
  const worker = new QueueWorker({repository, replies, whatsapp, config});
  return {repository, calls, sends, worker};
}

test('no responde a interlocutores sin aceptación y permite opt-in/opt-out', async () => {
  const {repository, calls, sends, worker} = setup(false);
  try {
    repository.queueEvent({id:'1',contact:PHONE,text:'hola'});
    await worker.tick();
    assert.equal(repository.listDrafts().length,0);
    assert.equal(repository.recent(PHONE).length,0);

    repository.queueEvent({id:'2',contact:PHONE,text:'ACEPTO IA'});
    await worker.tick();
    assert.equal(repository.isConsented(PHONE),true);
    assert.equal(repository.listDrafts().length,1);
    assert.match(repository.listDrafts()[0].output, /Listo, quedó activado/);
    assert.equal(sends.length,0);

    repository.queueEvent({id:'3',contact:PHONE,text:'Oe el partido dónde era?'});
    await worker.tick();
    assert.equal(calls.length,1);
    assert.equal(repository.listDrafts().find(d => d.id === '3').output, 'Claro, hablamos al toque 😄');
    assert.equal(sends.length,0);

    repository.queueEvent({id:'4',contact:PHONE,text:'PARAR IA'});
    await worker.tick();
    assert.equal(repository.isConsented(PHONE),false);
    await assert.rejects(() => worker.sendDraft('3'), /sin consentimiento/);
  } finally {repository.close();}
});

test('envío automático solo para contacto consentido; deduplica evento', async () => {
  const {repository, sends, worker} = setup(true);
  try {
    repository.setConsent(PHONE, true);
    assert.equal(repository.queueEvent({id:'message1',contact:PHONE,text:'Hola'}),true);
    assert.equal(repository.queueEvent({id:'message1',contact:PHONE,text:'Hola'}),false);
    await worker.tick();
    await worker.tick();
    assert.equal(sends.length,1);
    assert.equal(sends[0].body, 'Claro, hablamos al toque 😄');
    assert.equal(repository.recent(PHONE).length,2);
  } finally {repository.close();}
});

test('borrador enviado solamente mediante aprobación manual y opt-in', async () => {
  const {repository, sends, worker} = setup(false);
  try {
    repository.setConsent(PHONE, true);
    repository.queueEvent({id:'approve-me',contact:PHONE,text:'Qué hay?'});
    await worker.tick();
    assert.equal(sends.length,0);
    assert.ok(repository.getDraft('approve-me'));
    assert.equal(await worker.sendDraft('approve-me'),'wamid.sent.1');
    assert.equal(sends.length,1);
    assert.equal(repository.listDrafts().length,0);
    await assert.rejects(() => worker.sendDraft('approve-me'), /inexistente/);
  } finally {repository.close();}
});
