import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor } from '../../src/agents/supervisor.mjs';
import { createProgrammer } from '../../src/agents/programmer.mjs';
import { cleanResearchQuery, searchPapers } from '../../src/lab/paper-search.mjs';
import { validateSettings } from '../../src/lab/conversation-simulator.mjs';
import { validatePatches } from '../../src/lab/code-workspace.mjs';

const settings={model:'llama3.2:3b',temperature:0.2,replyMaxTokens:220,replyReview:false,semanticRouter:false};
test('supervisor cannot accept without passing quality gate',async()=>{
  const agent=createSupervisor(async()=>({action:'accept',diagnosis:'bien',hypothesis:'x',researchQuery:'',justification:'x'}));
  const res=await agent({cycles:0,history:[],papers:[],report:{gate:{accepted:false}},failures:[]});
  assert.equal(res.instruction.action,'research');
});
test('programmer can contradict repeated experiments',async()=>{
  const model=async()=>({action:'implement',reason:'try',hypothesis:'new strategy',mode:'config',settings,patches:[]});
  const prog=createProgrammer(model);
  const first=await prog({instruction:{},history:[],datasetSha256:'abc',baselineSettings:settings,papers:[]});
  assert.equal(first.programmerReply.action,'implement');
  const repeated=await prog({instruction:{},history:[{id:'old-experiment',signature:first.programmerReply.signature,
    datasetSha256:'abc',gate:{accepted:false}}],datasetSha256:'abc',baselineSettings:settings,papers:[]});
  assert.equal(repeated.programmerReply.action,'challenge');
  assert.match(repeated.programmerReply.reason,/old-experiment/);
});
test('web research input rejects personal info',async()=>{
  assert.equal(cleanResearchQuery('persona memory long context language model'),'persona memory long context language model');
  assert.throws(()=>cleanResearchQuery('persona on 519999999999'),/inválida/);
  const off=await searchPapers('persona memory language model');
  assert.equal(off.papers.length,0);
});
test('code edits have narrow file scope; settings cannot bypass allowlist',()=>{
  assert.throws(()=>validateSettings({userPrompt:'whatever'},settings),/no permitida/);
  assert.throws(()=>validatePatches([{path:'../../.env',search:'abcdefghijkl',replace:'hacked'}]),/inválido/);
});
