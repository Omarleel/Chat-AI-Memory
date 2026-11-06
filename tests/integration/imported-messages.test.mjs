import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../../src/infra/sqlite-repository.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SqliteRepository guarda mensajes estructurados, consulta vecinos y estilo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-ai-memory-test-'));
  const dbPath = join(dir, 'test.sqlite');
  const repo = new SqliteRepository(dbPath);
  const contact = '51999999999';
  const importHash = 'hash1234567890';

  try {
    const messages = [
      { id: 'm1', ordinal: 0, isoTimestamp: '2026-01-01T10:00:00', rawTimestamp: '01/01/2026 10:00', author: 'Diego', role: 'peer', text: 'Hola Alex' },
      { id: 'm2', ordinal: 1, isoTimestamp: '2026-01-01T10:01:00', rawTimestamp: '01/01/2026 10:01', author: 'Alex', role: 'self', text: 'Hola Diego, qué tal' },
      { id: 'm3', ordinal: 2, isoTimestamp: '2026-01-01T10:02:00', rawTimestamp: '01/01/2026 10:02', author: 'Diego', role: 'peer', text: 'Conoces a Valeria?' },
      { id: 'm4', ordinal: 3, isoTimestamp: '2026-01-01T10:03:00', rawTimestamp: '01/01/2026 10:03', author: 'Alex', role: 'self', text: 'Sí, del grupo' },
      { id: 'm5', ordinal: 4, isoTimestamp: '2026-01-01T10:04:00', rawTimestamp: '01/01/2026 10:04', author: 'Diego', role: 'peer', text: 'Me parece tímida' }
    ];

    repo.saveImportedMessages(contact, importHash, messages);
    assert.equal(repo.countImportedMessages(contact), 5);
    assert.equal(repo.countImportedMessages(contact, importHash), 5);

    // Nombre propio según cómo se escribe a media frase en el historial.
    repo.saveImportedMessages(contact, 'hash-nombres', ['Vamos a Valdora', 'luego en Valdora', 'ya en Valdora', 'Listo', 'Listo ya', 'estoy listo', 'ya listo', 'casi listo']
      .map((text, i) => ({id: `n${i}`, ordinal: i, isoTimestamp: '2026-01-02T10:00:00', rawTimestamp: '02/01/2026 10:00', author: 'Alex', role: 'self', text})));
    assert.equal(repo.isProperNoun(contact, 'valdora'), true);
    assert.equal(repo.isProperNoun(contact, 'listo'), false);

    // Expansión de vecinos alrededor de m3 (debería incluir m2, m3, m4)
    const neighbors = repo.getNeighbors(contact, ['m3'], 1, 1);
    assert.equal(neighbors.length, 3);
    assert.equal(neighbors[0].id, 'm2');
    assert.equal(neighbors[1].id, 'm3');
    assert.equal(neighbors[2].id, 'm4');

    // Pares de estilo
    repo.saveStylePairs(contact, [
      { incoming: 'vamos pe', reply: 'ya dale', contextType: 'casual_chat', hash: 'h1' }
    ]);
    const pairs = repo.listStylePairs(contact);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].reply, 'ya dale');

    // Búsqueda por términos en mensajes
    const termMatches = repo.searchByTerms(contact, ['valeria']);
    assert.equal(termMatches.length, 1);
    assert.match(termMatches[0].body, /Conoces a Valeria/);

    // Aislamiento: borrado de contacto
    repo.eraseContact(contact);
    assert.equal(repo.countImportedMessages(contact), 0);
    assert.equal(repo.listStylePairs(contact).length, 0);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

