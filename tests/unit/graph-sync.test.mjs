import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphSyncService } from '../../src/app/graph-sync-service.mjs';
import { ImportService } from '../../src/app/import-service.mjs';
import { SqliteRepository } from '../../src/infra/sqlite-repository.mjs';
import { fileURLToPath } from 'node:url';

const sample = fileURLToPath(new URL('../../examples/chat-demo.txt', import.meta.url));

test('GraphSyncService no encola si neo4j está deshabilitado', () => {
  const service = new GraphSyncService({
    repository: {},
    neo4j: { enabled: false },
    config: { neo4jEnabled: false }
  });
  assert.equal(service.enqueue('51999999999'), false);
  assert.equal(service.queue.length, 0);
});

test('GraphSyncService encola y procesa en segundo plano para contacto autorizado', async () => {
  const repository = new SqliteRepository(':memory:');
  const tripletsSaved = [];
  const verifiedSaved = [];

  const mockNeo4j = {
    enabled: true,
    isHealthy: async () => true,
    initSchema: async () => true,
    upsertVerifiedMemory: async (contact, mem) => {
      verifiedSaved.push({ contact, mem });
      return true;
    },
    upsertManyTriplets: async (contact, triplets) => {
      tripletsSaved.push({ contact, triplets });
      return triplets.length;
    }
  };

  try {
    const graphSync = new GraphSyncService({
      repository,
      neo4j: mockNeo4j,
      config: { neo4jEnabled: true, selfName: 'Alex' }
    });

    // Insertar mensajes estructurados directamente
    repository.saveImportedMessages('51999999999', 'hash123', [
      { ordinal: 1, role: 'self', author: 'Alex', text: 'Me gusta Diego', timestamp: '2026-10-26T12:00:00Z' },
      { ordinal: 2, role: 'peer', author: 'Diego', text: 'Tengo una PS5 nueva', timestamp: '2026-10-26T12:01:00Z' }
    ]);

    const enqueued = graphSync.enqueue('51999999999');
    assert.equal(enqueued, true);

    // Esperar a que la cola asíncrona procese en segundo plano
    while (graphSync.isProcessing || graphSync.queue.length > 0) {
      await new Promise(r => setTimeout(r, 20));
    }

    assert.equal(tripletsSaved.length, 1);
    assert.equal(tripletsSaved[0].contact, '51999999999');
    assert.ok(tripletsSaved[0].triplets.length >= 2);
    const relations = tripletsSaved[0].triplets.map(t => `${t.subject}:${t.relation}:${t.object}`);
    assert.ok(relations.some(r => r.includes('Alex:LE_GUSTA:Diego')));
    assert.ok(relations.some(r => r.includes('Diego:TIENE:PS5') || r.includes('TIENE')));
  } finally {
    repository.close();
  }
});

test('ImportService encola automáticamente la sincronización de Neo4j en segundo plano', async () => {
  const repository = new SqliteRepository(':memory:');
  const enqueuedContacts = [];
  const mockGraphSync = {
    enqueue: contact => {
      enqueuedContacts.push(contact);
      return true;
    }
  };
  const llm = {
    embedMany: async texts => texts.map(() => [1, 0])
  };

  try {
    const service = new ImportService({
      repository,
      llm,
      graphSync: mockGraphSync,
      config: { neo4jEnabled: true }
    });

    const result = await service.importFile({
      path: sample,
      contact: '51999999999',
      self: 'Alex',
      peer: 'Diego'
    });

    assert.equal(result.graphSync, 'enqueued');
    assert.deepEqual(enqueuedContacts, ['51999999999']);
  } finally {
    repository.close();
  }
});

