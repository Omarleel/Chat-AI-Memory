import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimestamp, cleanWhatsAppText, extractStylePairs } from '../../src/domain/history.mjs';

test('normaliza fechas de WhatsApp en múltiples formatos y configuraciones regionales', () => {
  // Formato español con a. m. / p. m.
  const r1 = normalizeTimestamp('27/3/2025 10:14 a. m.');
  assert.equal(r1.iso, '2025-03-27T10:14:00');
  assert.equal(r1.year, 2025);
  assert.equal(r1.month, 3);
  assert.equal(r1.day, 27);

  // Formato con p. m. (12:42 pm)
  const r2 = normalizeTimestamp('10/6/2023 12:42 p. m.');
  assert.equal(r2.iso, '2023-06-10T12:42:00');

  // Formato anglosajón M/D/YY AM/PM
  const r3 = normalizeTimestamp('9/25/26 10:23:02 AM');
  assert.equal(r3.iso, '2026-09-25T10:23:02');

  const r4 = normalizeTimestamp('8/28/26 5:00:22 PM');
  assert.equal(r4.iso, '2026-08-28T17:00:22');

  // Formato 24 horas estándar
  const r5 = normalizeTimestamp('01/02/2026, 19:30:00');
  assert.equal(r5.iso, '2026-02-01T19:30:00');
});

test('limpia caracteres invisibles unicode y no-break spaces', () => {
  const dirty = '\u200e[27/3/2025\u202f10:14\u202fa.\u202fm.]\u200e Diego: Hola';
  const clean = cleanWhatsAppText(dirty);
  assert.ok(!clean.includes('\u200e'));
  assert.ok(!clean.includes('\u202f'));
  assert.match(clean, /\[27\/3\/2025 10:14 a\. m\.\] Diego: Hola/);
});

test('extrae pares conversacionales de estilo peer -> self', () => {
  const messages = [
    { author: 'Diego', text: 'Oe qué haces este finde?', ordinal: 0 },
    { author: 'Alex', text: 'nada creo xd, por?', ordinal: 1 },
    { author: 'Diego', text: 'vamos al centro pe', ordinal: 2 },
    { author: 'Alex', text: 'ya normal, a qué hora?', ordinal: 3 }
  ];
  const pairs = extractStylePairs(messages, 'Alex');
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].incoming, 'Oe qué haces este finde?');
  assert.equal(pairs[0].reply, 'nada creo xd, por?');
  assert.equal(pairs[0].contextType, 'question_reply');
  assert.equal(pairs[1].incoming, 'vamos al centro pe');
  assert.equal(pairs[1].reply, 'ya normal, a qué hora?');
});

