import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWhatsAppTxt, selectDirectHistory, chunkHistory, cosine, exampleStyles} from '../../src/domain/history.mjs';

test('parsea exportación de WhatsApp con saltos de línea y mensajes de sistema', () => {
  const txt = '[01/02/2026, 19:30:00] Alex: Qué fue?\nlinea 2\n[01/02/2026, 19:31:00] Diego: Todo bien';
  const p = parseWhatsAppTxt(txt);
  assert.equal(p.length, 2);
  assert.equal(p[0].text, 'Qué fue?\nlinea 2');
  assert.equal(p[1].author, 'Diego');
});
test('parsea exportación Android con guion', () => {
  const p = parseWhatsAppTxt('01/02/26, 19:30 - Alex: hey\n01/02/26, 19:31 - Diego: hola');
  assert.equal(p.length, 2);
});
test('separa participantes de un chat de grupo y crea chunks', () => {
  const m = parseWhatsAppTxt('[01/02/26, 10:00] Alex: me parece\n[01/02/26, 10:01] Maria: texto privado\n[01/02/26, 10:02] Diego: yo tambien');
  const selected = selectDirectHistory(m, 'Alex', 'Diego');
  assert.equal(selected.length, 2);
  assert.ok(!chunkHistory(selected).join('').includes('texto privado'));
});
test('cosine similarity estable y muestras de estilo', () => {
  assert.equal(cosine([1,0], [1,0]), 1);
  assert.equal(cosine([1,0], [0,1]), 0);
  assert.equal(cosine([0], [1,0]), -1);
  const m = [{author:'Alex',text:'claro bro vamos al parque'}, {author:'Diego',text:'texto largo de Diego'}];
  assert.deepEqual(exampleStyles(m, 'Alex'), ['claro bro vamos al parque']);
});
