import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExperimentRegistry } from '../../src/lab/experiment-registry.mjs';
import { applyApproved } from '../../src/lab/promote.mjs';

test('experiment registry persists objections and prevents parallel laboratory runs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lab-reg-'));
  try {
    const registry=new ExperimentRegistry(dir);
    const release=await registry.acquireLock();
    await assert.rejects(registry.acquireLock(),/Ya hay un laboratorio activo/);
    const challenge=await registry.record({status:'challenge',reason:'Propuesta repetida'});
    assert.equal((await registry.readHistory())[0].id,challenge.id);
    await release();
    const release2=await registry.acquireLock();await release2();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('promotion requires evidence and explicit approval, and backs up .env',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lab-promote-'));
  try {
    const registry=new ExperimentRegistry(join(root,'data','lab'));
    const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeFile(join(root,'.env'),'AUTO_SEND=false\nLLM_MODEL=baseline:latest\n',{mode:0o600});
    await registry.approved({id,settings:{model:'new:latest',temperature:0.2,
      replyMaxTokens:250,replyReview:false,semanticRouter:false},patches:[],gate:{accepted:true}});
    await assert.rejects(applyApproved({registry,id,root,yes:false}),/--apply/);
    const done=await applyApproved({registry,id,root,yes:true});
    const env=await readFile(join(root,'.env'),'utf8');
    assert.match(env,/LLM_MODEL=new:latest/);
    assert.match(env,/AUTO_SEND=false/);
    assert.equal(done.envUpdated,true);
    assert.match(await readFile(join(done.backup,'.env'),'utf8'),/LLM_MODEL=baseline:latest/);
    await assert.rejects(applyApproved({registry,id,root,yes:true}),/ya aplicado/);
  }finally{await rm(root,{recursive:true,force:true});}
});
