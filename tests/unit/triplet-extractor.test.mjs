import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDeterministicTriplets, extractTripletsWithLLM } from '../../src/domain/triplet-extractor.mjs';

test('extractDeterministicTriplets extrae gustos y sentimientos de autor o terceros', () => {
  const t1 = extractDeterministicTriplets('oe mano, la verdad me gusta Valeria', { author: 'Diego' });
  assert.equal(t1.length, 1);
  assert.equal(t1[0].subject, 'Diego');
  assert.equal(t1[0].relation, 'LE_GUSTA');
  assert.equal(t1[0].object, 'Valeria');

  const t2 = extractDeterministicTriplets('a Diego le gusta Valeria desde el año pasado', { author: 'Alex' });
  assert.equal(t2.length, 1);
  assert.equal(t2[0].subject, 'Diego');
  assert.equal(t2[0].relation, 'LE_GUSTA');
  assert.equal(t2[0].object, 'Valeria');

  // Prueba con puntuación y formato informal de WhatsApp
  const t3 = extractDeterministicTriplets('De q me gusta. Valeria', { author: 'Diego' });
  assert.equal(t3.length, 1);
  assert.equal(t3[0].object, 'Valeria');

  const t4 = extractDeterministicTriplets('Mi ilusión por valeria', { author: 'Diego' });
  assert.equal(t4.length, 1);
  assert.equal(t4[0].object, 'Valeria');

  // Filtra falsos positivos (verbos en infinitivo o adverbios)
  const f1 = extractDeterministicTriplets('me gusta estar tranquilo', { author: 'Diego' });
  assert.equal(f1.length, 0);

  const f2 = extractDeterministicTriplets('me gusta preguntar cosas', { author: 'Diego' });
  assert.equal(f2.length, 0);

  const f3 = extractDeterministicTriplets('me gusta mucho', { author: 'Diego' });
  assert.equal(f3.length, 0);

  const f4 = extractDeterministicTriplets('me gusta físicamente', { author: 'Diego' });
  assert.equal(f4.length, 0);
});

test('extractDeterministicTriplets extrae cumpleaños y fechas de personas', () => {
  const t1 = extractDeterministicTriplets('mi cumpleaños es el 15 de agosto', { author: 'Alex' });
  assert.equal(t1.length, 1);
  assert.equal(t1[0].subject, 'Alex');
  assert.equal(t1[0].relation, 'CUMPLEANOS');
  assert.match(t1[0].object, /15 de agosto/i);

  const t2 = extractDeterministicTriplets('el cumpleaños de Valeria es el 24 de mayo', { author: 'Diego' });
  assert.equal(t2.length, 1);
  assert.equal(t2[0].subject, 'Valeria');
  assert.equal(t2[0].relation, 'CUMPLEANOS');
  assert.match(t2[0].object, /24 de mayo/i);

  const t3 = extractDeterministicTriplets('hoy es el cumple de bruno', { author: 'Diego' });
  assert.equal(t3.length, 1);
  assert.equal(t3[0].subject, 'Bruno');
  assert.equal(t3[0].relation, 'CUMPLEANOS');
});

test('extractDeterministicTriplets extrae posesiones, compras y ventas tecnológicas', () => {
  const t1 = extractDeterministicTriplets('comprare una ps5 para jugar con los panas', { author: 'Diego' });
  assert.equal(t1.length, 1);
  assert.equal(t1[0].subject, 'Diego');
  assert.equal(t1[0].relation, 'TIENE_DISPOSITIVO');
  assert.equal(t1[0].object, 'PS5');

  const t2 = extractDeterministicTriplets('vendere este cel para sacar plata', { author: 'Diego' });
  assert.equal(t2.length, 1);
  assert.equal(t2[0].subject, 'Diego');
  assert.equal(t2[0].relation, 'VENDE');
  assert.equal(t2[0].object, 'CELULAR');

  const t3 = extractDeterministicTriplets('no le pusiste gasolina a tu moto', { author: 'Alex', peer: 'Diego' });
  assert.equal(t3.length, 1);
  assert.equal(t3[0].subject, 'Diego');
  assert.equal(t3[0].relation, 'TIENE_DISPOSITIVO');
  assert.equal(t3[0].object, 'MOTO');
});

test('extractDeterministicTriplets extrae acuerdos de planes con temporalidad', () => {
  const t1 = extractDeterministicTriplets('el sábado jugamos fútbol en la noche', { author: 'Diego' });
  assert.equal(t1.length, 1);
  assert.equal(t1[0].subject, 'Diego');
  assert.equal(t1[0].relation, 'ACORDO_PLAN');
});

test('extractTripletsWithLLM parsea correctamente salida JSON estructurada del LLM', async () => {
  const mockLLM = {
    chat: async () => JSON.stringify([
      { subject: 'Diego', relation: 'TIENE_AMIGO', object: 'Alex', confidence: 0.95 },
      { subject: 'Valeria', relation: 'ESTUDIA_EN', object: 'Universidad', confidence: 0.88 }
    ])
  };

  const triplets = await extractTripletsWithLLM(mockLLM, 'Diego: soy amigo de Alex y Valeria va a la u');
  assert.equal(triplets.length, 2);
  assert.equal(triplets[0].subject, 'Diego');
  assert.equal(triplets[0].relation, 'TIENE_AMIGO');
  assert.equal(triplets[0].object, 'Alex');
  assert.equal(triplets[1].subject, 'Valeria');
  assert.equal(triplets[1].relation, 'ESTUDIA_EN');
  assert.equal(triplets[1].object, 'Universidad');
});

