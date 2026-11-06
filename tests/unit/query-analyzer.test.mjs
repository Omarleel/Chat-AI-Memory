import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQuery } from '../../src/domain/query-analyzer.mjs';

test('analyzeQuery identifica intenciones y excluye autores de las entidades', () => {
  // Consulta histórica con autores del chat
  const q1 = analyzeQuery('Que ha contado Diego sobre Valeria a lo largo del tiempo?', {
    selfName: 'Alex',
    peerName: 'Diego R'
  });
  assert.equal(q1.intent, 'historical_summary');
  assert.equal(q1.isHistorical, true);
  // Diego debe estar excluido de las entidades porque es el peerName
  assert.deepEqual(q1.entities, ['valeria']);
  assert.equal(q1.targetEntity, 'valeria');

  // Consulta factual sobre cumpleaños
  const q2 = analyzeQuery('¿Cuál es el cumpleaños exacto de Valeria?', {
    selfName: 'Alex',
    peerName: 'Diego R'
  });
  assert.equal(q2.intent, 'factual_detail');
  assert.equal(q2.isFactual, true);
  assert.deepEqual(q2.entities, ['valeria']);

  // Consejo sentimental
  const q3 = analyzeQuery('Que hago con Valeria? Me gusta', {
    selfName: 'Alex',
    peerName: 'Diego R'
  });
  assert.equal(q3.intent, 'romantic_advice');
  assert.equal(q3.isRomanticAdvice, true);
  assert.equal(q3.targetEntity, 'valeria');

  // Pregunta de seguimiento breve
  const q4 = analyzeQuery('¿Por qué?');
  assert.equal(q4.intent, 'followup');
  assert.equal(q4.isFollowup, true);

  // Palabras meta/comando como "explica" o "recuerda" no son entidades
  const q5 = analyzeQuery('Explica lo que recuerda el chat sobre Bleach', {
    selfName: 'Alex',
    peerName: 'Diego'
  });
  assert.deepEqual(q5.entities, ['bleach']);
  assert.ok(!q5.entities.includes('explica'));
  assert.ok(!q5.entities.includes('recuerda'));
});

