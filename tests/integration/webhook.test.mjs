import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifyMetaSignature, inboundTextEvents} from '../../src/infra/whatsapp.mjs';

test('verifica una firma real y rechaza firmas incorrectas', () => {
  const b = Buffer.from('{"a":1}');
  const secret = 'demo-test-secret';
  const sig = `sha256=${createHmac('sha256',secret).update(b).digest('hex')}`;
  assert.equal(verifyMetaSignature(b,sig,secret), true);
  assert.equal(verifyMetaSignature(Buffer.from('{}'),sig,secret),false);
  assert.equal(verifyMetaSignature(b,'sha256=abcd',secret),false);
  assert.equal(verifyMetaSignature(b,sig,''),false);
});
test('extrae solo mensajes de texto entrantes', () => {
  const events = inboundTextEvents({entry:[{changes:[{value:{messages:[
    {id:'wamid.123',from:'51999999999',type:'text',text:{body:'Hola'}},
    {id:'wamid.456',from:'51999999999',type:'image',image:{id:'x'}}
  ]}}]}]});
  assert.deepEqual(events, [{id:'wamid.123',contact:'51999999999',text:'Hola'}]);
});
