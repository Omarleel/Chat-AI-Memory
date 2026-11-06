import test from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppWebGateway, extractWebMessage, phoneFromPnJid } from '../../src/infra/whatsapp-web.mjs';
import { enqueueIncoming } from '../../src/app/inbound-service.mjs';
import { SqliteRepository } from '../../src/infra/sqlite-repository.mjs';
import { QueueWorker } from '../../src/app/queue-worker.mjs';

const PHONE = '51999999999';
const msg = (remoteJid, body, extras = {}) => ({key: {id: 'E1', remoteJid, ...extras}, message: {conversation: body}});

test('WhatsApp Web: solo texto de chat privado entrante (PN/LID), con wrappers', () => {
  assert.equal(phoneFromPnJid(`${PHONE}@s.whatsapp.net`), PHONE);
  assert.equal(phoneFromPnJid('190324234@lid'), null);
  assert.equal(extractWebMessage(msg(`${PHONE}@s.whatsapp.net`, ' Hola ')).text, ' Hola ');
  assert.equal(extractWebMessage(msg(`${PHONE}@s.whatsapp.net`, 'hola', {fromMe: true})), null);
  assert.equal(extractWebMessage(msg('123@g.us', 'hola', {remoteJidAlt: `${PHONE}@s.whatsapp.net`})), null);
  assert.equal(extractWebMessage(msg('status@broadcast', 'hola')), null);
  assert.equal(extractWebMessage(msg(`${PHONE}@s.whatsapp.net`, '  ')), null);
  assert.equal(extractWebMessage({key: {id:'E2',remoteJid:`${PHONE}@s.whatsapp.net`},
    message:{ephemeralMessage:{message:{extendedTextMessage:{text:'texto envuelto'}}}}}).text, 'texto envuelto');
});

test('adaptador Web: QR, acceso a entrada filtrada, deduplicación y envío por número', async () => {
  const repository = new SqliteRepository(':memory:');
  const events = {};
  const sends = [];
  const fakeSocket = {
    ev: {on(name, fn) { events[name] = fn; }},
    signalRepository: {lidMapping: {getPNForLID: async jid => jid === '345@lid' ? `${PHONE}@s.whatsapp.net` : null}},
    sendMessage: async (jid, payload) => { sends.push({jid, payload}); return {key:{id:'OUT1'}}; },
    end() {}
  };
  const config = {allowedContacts: new Set([PHONE])};
  const gateway = new WhatsAppWebGateway({authDir:'/tmp/test-not-used',printQr:false}, {
    onMessage: item => enqueueIncoming({repository,config},item),
    log: {info(){},error(){}},
    dependencies: {
      baileys: {default: () => fakeSocket, useMultiFileAuthState: async () => ({state:{},saveCreds:async()=>{}}),
        DisconnectReason: {loggedOut:401}, Browsers:{ubuntu:()=>['Test','Test','1']}},
    }
  });
  try {
    await gateway.start();
    events['connection.update']({qr:'TESTQR'});
    assert.deepEqual(gateway.getStatus(), {provider:'web',state:'qr',hasQr:true});
    events['connection.update']({connection:'open'});
    assert.equal(gateway.getStatus().state,'connected');
    assert.equal(gateway.getStatus().hasQr,false);
    events['messages.upsert']({type:'append',messages:[msg(`${PHONE}@s.whatsapp.net`,'ignorado')]});
    events['messages.upsert']({type:'notify',messages:[
      msg(`${PHONE}@s.whatsapp.net`,'Hola'), msg(`${PHONE}@s.whatsapp.net`,'Hola'),
      msg('345@lid','Desde LID',{id:'E2'}), msg('777@lid','sin resolución',{id:'E3'}),
      msg('19876543210@s.whatsapp.net','otro',{id:'E4'})
    ]});
    // La recepción puede requerir un lookup LID asíncrono.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(repository.claimNext().incoming_text,'Hola');
    assert.equal(repository.claimNext().incoming_text,'Desde LID');
    assert.equal(repository.claimNext(),null);
    assert.equal(await gateway.sendText(PHONE,'Respuesta'),'web:OUT1');
    assert.deepEqual(sends,[{jid:`${PHONE}@s.whatsapp.net`,payload:{text:'Respuesta'}}]);
  } finally {gateway.stop();repository.close();}
});

test('worker con envío automático espera la conexión Web y conserva la cola', async () => {
  const repository = new SqliteRepository(':memory:');
  try {
    repository.setConsent(PHONE,true);
    repository.queueEvent({id:'new',contact:PHONE,text:'Hola'});
    const whatsapp = {getStatus:() => ({state:'qr'}),sendText:async()=>{throw new Error('no debe enviar');}};
    const worker = new QueueWorker({repository, whatsapp, replies:{generate:async()=> '🤖 IA: Hola'},
      config:{autoSend:true,waProvider:'web',allowedContacts:new Set([PHONE])}});
    await worker.tick();
    assert.equal(repository.claimNext().id,'new');
  } finally {repository.close();}
});
