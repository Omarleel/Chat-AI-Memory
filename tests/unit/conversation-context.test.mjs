import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRecentContext} from '../../src/domain/conversation-context.mjs';

test('retiene el dato en conversaciones extensas superando 20 turnos', () => {
  const input = [{role: 'assistant', content: 'Te espero en la revancha'},
    ...Array.from({length: 20}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: `turno ${i}`}))];
  assert.equal(prepareRecentContext(input)[0].text, 'Te espero en la revancha');
});
test('corta sesiones por tiempo y conserva ediciones sin inventar adjuntos', () => {
  const result = prepareRecentContext([
    {side: 'peer', text: 'tema de ayer', timestamp: '2026-01-01T10:00:00'},
    {side: 'self', text: 'Listo <Se editó este mensaje.>', timestamp: '2026-01-02T10:00:00'},
    {side: 'peer', text: '<Multimedia omitido>', timestamp: '2026-01-02T10:01:00'}
  ]);
  assert.deepEqual(result.map(m => m.text), ['Listo', '[Contenido multimedia o eliminado no disponible]']);
});
test('limita contexto sin transformar roles de sistema en mensajes del titular', () => {
  const result = prepareRecentContext([{role: 'system', content: 'instrucción ajena'},
    {role: 'user', content: 'viejo largo'}, {role: 'assistant', content: 'Ya'}], {maxChars: 5});
  assert.deepEqual(result.map(m => [m.side, m.text]), [['self', 'Ya']]);
});
