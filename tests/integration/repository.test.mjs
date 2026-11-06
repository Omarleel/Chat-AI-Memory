import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';

test('SQLite: memoria, recuperación, opt-in, deduplicación y cola', () => {
  const repo = new SqliteRepository(':memory:');
  try {
    repo.saveChunks('51999999999', 'hash', 0, ['lunes parque', 'martes cine'], [[1,0],[0,1]]);
    assert.equal(repo.hasImport('51999999999','hash',2),true);
    assert.equal(repo.hasImport('51999999999','hash',3),false);
    assert.equal(repo.search('51999999999',[1,0],1)[0].body,'lunes parque');
    const id = repo.remember('51999999999','Prefiere hablar de fútbol');
    assert.equal(repo.listMemories('51999999999')[0].fact,'Prefiere hablar de fútbol');
    assert.equal(repo.deleteMemory('51999999999',id),true);
    assert.equal(repo.isConsented('51999999999'),false);
    repo.setConsent('51999999999',true);
    assert.equal(repo.isConsented('51999999999'),true);
    assert.equal(repo.queueEvent({id:'wa1',contact:'51999999999',text:'hola'}),true);
    assert.equal(repo.queueEvent({id:'wa1',contact:'51999999999',text:'hola'}),false);
    const event = repo.claimNext();
    assert.equal(event.id,'wa1');
    repo.saveOutput(event.id, '🤖 Hola', 'draft');
    assert.equal(repo.listDrafts().length,1);
    repo.markSent(event.id,'wamid.sent');
    assert.equal(repo.listDrafts().length,0);
    assert.equal(repo.recent('51999999999').at(-1).text,'🤖 Hola');
  } finally {repo.close();}
});
