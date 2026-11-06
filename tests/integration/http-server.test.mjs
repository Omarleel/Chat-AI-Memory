import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SqliteRepository } from '../../src/infra/sqlite-repository.mjs';
import { createHttpServer } from '../../src/transport/http-server.mjs';

const PHONE = '51999999999';
test('HTTP completo: webhook firma, challenge, auth y cola', async () => {
  const repository = new SqliteRepository(':memory:');
  const config = {
    adminToken:'S'.repeat(48), wa:{verifyToken:'token-de-verificacion',appSecret:'secret123'},
    allowedContacts:new Set([PHONE]), autoSend:false
  };
  const worker = {sendDraft: async () => 'wamid.sent'};
  const replies = {generate: async () => 'Qué tal!'};
  const server = createHttpServer({repository, config, worker, replies});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=token-de-verificacion&hub.challenge=42`);
    assert.equal(res.status,200);
    assert.equal(await res.text(),'42');
    res = await fetch(`${base}/api/drafts`);
    assert.equal(res.status,401);
    const body = JSON.stringify({entry:[{changes:[{value:{messages:[{id:'wa.demo1',type:'text',from:PHONE,text:{body:'Hola'}}]}}]}]});
    res = await fetch(`${base}/webhook`, {method:'POST',headers:{'content-type':'application/json'},body});
    assert.equal(res.status,403);
    const signature = 'sha256=' + createHmac('sha256',config.wa.appSecret).update(body).digest('hex');
    const post = () => fetch(`${base}/webhook`,{method:'POST',headers:{'x-hub-signature-256':signature,'content-type':'application/json'},body});
    res = await post();
    assert.equal(res.status,200);
    assert.equal((await res.json()).queued,1);
    res = await post();
    assert.equal((await res.json()).queued,0);
    res = await fetch(`${base}/api/preview`,{method:'POST',headers:{'authorization':`Bearer ${config.adminToken}`,'content-type':'application/json'},
      body:JSON.stringify({contact:PHONE,text:'Qué tal?'})});
    assert.equal(res.status,200);
    const preview = await res.json();
    assert.equal(preview.sent,false);
    assert.equal(preview.mode,'reply');
  } finally {
    await new Promise(resolve => server.close(resolve));
    repository.close();
  }
});

test('endpoint de QR Web requiere autenticación y no habilita webhook Cloud', async () => {
  const repository = new SqliteRepository(':memory:');
  const token = 'A'.repeat(48);
  const config = {adminToken:token, waProvider:'web', wa:{}, allowedContacts: new Set([PHONE])};
  const whatsapp = {getStatus: () => ({provider:'web',state:'qr',hasQr:true}),
    getQrSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg" />'};
  const server = createHttpServer({config, repository, worker:{}, replies:{}, whatsapp});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/whatsapp/qr.svg`)).status,401);
    assert.equal((await fetch(`${base}/webhook`)).status,404);
    const headers = {'Authorization':`Bearer ${token}`};
    const status = await fetch(`${base}/api/whatsapp/status`,{headers});
    assert.equal((await status.json()).whatsapp.state,'qr');
    const qr = await fetch(`${base}/api/whatsapp/qr.svg`,{headers});
    assert.equal(qr.status,200);
    assert.match(qr.headers.get('content-type'),/image\/svg\+xml/);
    assert.equal(qr.headers.get('cache-control'),'no-store');
    assert.match(await qr.text(), /<svg/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    repository.close();
  }
});
