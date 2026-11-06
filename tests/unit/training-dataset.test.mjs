import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTrainingDataset, conversationSessions, trainingText} from '../../src/domain/training-dataset.mjs';

function messages(rows) {
  return rows.map(([role, text, time], ordinal) => ({role, text, ordinal,
    isoTimestamp: time ?? `2026-01-01T10:${String(ordinal).padStart(2, '0')}:00`}));
}
const samples = data => [...data.train, ...data.validation, ...data.test];

test('conserva todo el mensaje editado y la respuesta completa por ráfagas', () => {
  assert.equal(trainingText('Sigo descargando xd <Se editó este mensaje.>'), 'Sigo descargando xd');
  const data = buildTrainingDataset(messages([
    ['peer', 'Sigo descargando xd <Se editó este mensaje.>'], ['peer', 'Ya esta casi todo listo'],
    ['self', 'Pense que tenias fibra'], ['self', 'Sigue lento?']
  ]));
  const row = samples(data)[0];
  assert.equal(row.prompt.at(-1).content, 'Sigo descargando xd\nYa esta casi todo listo');
  assert.equal(row.completion[0].content, 'Pense que tenias fibra\nSigue lento?');
  assert.deepEqual(row.provenance.targetOrdinals, [2, 3]);
});

test('no inventa continuidad después de una pausa larga ni de un timestamp inválido', () => {
  const data = buildTrainingDataset(messages([
    ['peer', 'Vienes?', '2026-01-01T10:00:00'], ['self', 'No', '2026-01-02T11:00:00'],
    ['peer', 'Otra cosa', 'invalid'], ['self', 'Ya', '2026-01-02T11:02:00']
  ]));
  assert.equal(samples(data).length, 0);
});

test('no aprende respuestas a adjuntos ausentes ni borra su lugar en el contexto', () => {
  const ms = messages([['peer', '<Multimedia omitido>'], ['self', 'Bonita'],
    ['peer', 'Ya estas ahi?'], ['self', 'Si']]);
  const data = buildTrainingDataset(ms);
  assert.equal(data.stats.unavailableTargets, 1);
  assert.equal(samples(data).length, 1);
  assert.match(samples(data)[0].prompt[1].content, /no disponible/);
});

test('sesiones y mensajes originales quedan separados entre train, validación y test', () => {
  const ms = [];
  for (let day = 1; day <= 20; day++) ms.push(
    {ordinal: day * 2, role: 'peer', text: `Pregunta ${day}`, isoTimestamp: `2026-01-${String(day).padStart(2,'0')}T10:00:00`},
    {ordinal: day * 2 + 1, role: 'self', text: `Respuesta ${day}`, isoTimestamp: `2026-01-${String(day).padStart(2,'0')}T10:01:00`}
  );
  const data = buildTrainingDataset(ms);
  assert.deepEqual([data.train.length, data.validation.length, data.test.length], [17,2,1]);
  const seen = new Set();
  for (const split of ['train','validation','test']) for (const row of data[split]) {
    assert.ok(!seen.has(row.provenance.session));
    seen.add(row.provenance.session);
    assert.ok(Math.max(...row.provenance.contextOrdinals) < Math.min(...row.provenance.targetOrdinals));
  }
  assert.equal(conversationSessions(ms).length, 20);
});
