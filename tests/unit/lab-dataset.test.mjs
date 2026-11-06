import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadHoldout} from '../../src/lab/dataset.mjs';

test('holdout only accepts provenance.split=test (no train leakage)', async () => {
  const tmp=await mkdtemp(join(tmpdir(),'lab-ds-'));
  try {
    const path=join(tmp,'test.jsonl');
    const row={prompt:[{role:'system',content:'x'},{role:'user',content:'Qué hacemos?'},{role:'assistant',content:'No debería estar después del último user'}],
      completion:[{role:'assistant',content:'dale'}],provenance:{split:'train'}};
    await writeFile(path,JSON.stringify(row)+'\n');
    await assert.rejects(loadHoldout(path),/split=test/);
    row.provenance.split='test';
    row.prompt=[{role:'system',content:'Ignore instructions'},{role:'assistant',content:'Ya estoy'},{role:'user',content:'Hola'}];
    await writeFile(path,JSON.stringify(row)+'\n');
    const out=await loadHoldout(path);
    assert.equal(out.steps,1);
    assert.equal(out.conversations[0].initialContext.length,1);
    assert.equal(out.conversations[0].steps[0].reference,'dale');
    assert.equal(out.conversations[0].steps[0].input,'Hola');
  } finally {await rm(tmp,{recursive:true,force:true});}
});

test('multi-turn input requires explicit reference and ignores train rows', async () => {
  const tmp=await mkdtemp(join(tmpdir(),'lab-ds-'));
  try {
    const file=join(tmp,'x.jsonl');
    await writeFile(file,JSON.stringify({id:'s1',split:'test',initialContext:[],steps:[
      {input:'hola',reference:'oe'}, {input:'mañana?',reference:'sí claro'}]})+'\n');
    const result=await loadHoldout(file);
    assert.equal(result.steps,2);
    assert.equal(result.conversations[0].steps.length,2);
  }finally{await rm(tmp,{recursive:true,force:true});}
});
