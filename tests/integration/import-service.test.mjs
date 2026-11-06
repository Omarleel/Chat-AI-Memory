import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {ImportService} from '../../src/app/import-service.mjs';

const sample = fileURLToPath(new URL('../../examples/chat-demo.txt', import.meta.url));
test('importa conversación completa, indexa ejemplos y evita importar duplicados', async () => {
  const repository = new SqliteRepository(':memory:');
  const batches = [];
  const llm = {embedMany: async texts => {
    batches.push(texts);
    return texts.map(t => [t.toLowerCase().includes('parque') ? 1 : 0, 1]);
  }};
  try {
    const service = new ImportService({repository, llm});
    const first = await service.importFile({path:sample, contact:'51999999999', self:'Alex', peer:'Diego'});
    assert.equal(first.importedMessages, 7);
    assert.ok(first.chunks >= 1);
    assert.ok(repository.listStyles('51999999999').length > 0);
    assert.ok(repository.search('51999999999', [1,1]).length > 0);
    const count = batches.length;
    const repeated = await service.importFile({path:sample, contact:'51999999999', self:'Alex', peer:'Diego'});
    assert.equal(repeated.skipped, true);
    assert.equal(batches.length, count);
  } finally {repository.close();}
});
