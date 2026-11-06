import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jClient } from '../../src/infra/neo4j-client.mjs';
import { ReplyService } from '../../src/app/reply-service.mjs';

test('Neo4jClient maneja disabled de forma transparente', async () => {
  const client = new Neo4jClient({ enabled: false });
  assert.equal(await client.isHealthy(), false);
  assert.deepEqual(await client.findRelated({ contact: '51999999999', entities: ['Valeria'] }), []);
  assert.equal(await client.upsertTriplet({ contact: '51999999999', subject: 'A', relation: 'B', object: 'C' }), null);
});

test('Neo4jClient formatea y ejecuta Cypher con mock HTTP', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({
        results: [{
          columns: ['subject', 'relation', 'object', 'confidence', 'date'],
          data: [{
            row: ['Diego', 'LE_GUSTA', 'Valeria', 0.95, null]
          }]
        }],
        errors: []
      })
    };
  };

  try {
    const client = new Neo4jClient({
      baseUrl: 'http://localhost:7474',
      user: 'neo4j',
      password: 'password123',
      enabled: true
    });

    const related = await client.findRelated({ contact: '51999999999', entities: ['valeria'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:7474/db/neo4j/tx/commit');
    assert.match(calls[0].options.headers.authorization, /^Basic /);
    assert.equal(related.length, 1);
    assert.equal(related[0].subject, 'Diego');
    assert.equal(related[0].relation, 'LE_GUSTA');
    assert.equal(related[0].object, 'Valeria');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ReplyService integra hechos del grafo Neo4j en el prompt y en las evidencias', async () => {
  const repo = {
    listChatImports: () => [{ self: 'Alex', peer: 'Diego R' }],
    listMemories: () => [],
    recentPreview: () => [],
    listStyles: () => []
  };
  const mockNeo4j = {
    findRelated: async ({ contact, entities }) => {
      assert.ok(entities.includes('valeria'));
      return [
        { subject: 'Diego R', relation: 'LE_GUSTA', object: 'Valeria', confidence: 0.95 }
      ];
    }
  };
  const promptLog = [];
  const mockLLM = {
    embed: async () => [1, 0],
    chat: async (system, prompt) => {
      promptLog.push({ system, prompt });
      return 'Háblale normal pe';
    }
  };

  const service = new ReplyService({
    repository: repo,
    historyStore: { search: async () => [] },
    llm: mockLLM,
    config: { selfName: 'Alex', topK: 3, replyReview: false },
    neo4j: mockNeo4j
  });

  const res = await service.previewReply('51999999999', 'Qué hago con Valeria? Me gusta', 'test-graph', true, 'force');
  assert.match(res.answer, /Háblale normal/);
  assert.equal(res.rag.graph.tripletsCount, 1);
  assert.equal(res.rag.graph.triplets[0].subject, 'Diego R');
  assert.equal(res.rag.graph.triplets[0].relation, 'LE_GUSTA');
  assert.equal(res.rag.graph.triplets[0].object, 'Valeria');

  assert.match(promptLog[0].system, /CONOCIMIENTO ESTRUCTURADO/);
  assert.match(promptLog[0].system, /\(Diego R\) -> \[LE_GUSTA\] -> \(Valeria\)/);
});
