import test from 'node:test';
import assert from 'node:assert/strict';
import { replayConversations } from '../../src/lab/conversation-simulator.mjs';
import { evaluateCandidate } from '../../src/lab/evaluation-runner.mjs';
import { qualityGate } from '../../src/lab/quality-gate.mjs';
import { parseJudgeResult } from '../../src/lab/persona-judge.mjs';

const perfect={coherence:5,continuity:5,behavior:5,language:5,factuality:5,naturalness:5};
const weak={coherence:3,continuity:3,behavior:3,language:3,factuality:3,naturalness:3};
test('simulator uses generated replies as context, not future reference messages', async()=>{
  const calls=[];
  const scenarios=[{id:'c1',initialContext:[],steps:[{input:'primero',reference:'REFERENCIA_SECRETA'},
    {input:'y entonces?',reference:'CONTINUACIÓN_RESERVADA'}]}];
  const results=await replayConversations(scenarios, async(input,context)=>{
    calls.push({input,context:JSON.stringify(context)});
    return `generado:${input}`;
  });
  assert.equal(results[0].turns.length,2);
  assert.equal(calls[0].context,'[]');
  assert.match(calls[1].context,/generado:primero/);
  assert.doesNotMatch(calls[1].context,/REFERENCIA_SECRETA/);
});

test('candidate only passes quality gate when independently graded above baseline', async()=>{
  const conversations=Array.from({length:3},(_,i)=>({id:`c${i}`,sourceSession:`s${i}`,initialContext:[],
    steps:Array.from({length:4},(_,j)=>({input:`mensaje ${i} ${j}`,reference:`respuesta ${i} ${j}`}))}));
  const dataset={conversations,steps:12,sha256:'test'};
  const checked=[];
  const output=await evaluateCandidate({dataset,
    baselineGenerator:async()=> 'versión base',candidateGenerator:async()=> 'versión candidata',
    judge:async({baseline,candidate,reference})=>{
      checked.push({baseline,candidate,reference});
      return {baseline:weak,candidate:perfect};
    }});
  assert.equal(output.report.candidate.count,12);
  assert.equal(output.report.conversations,3);
  assert.equal(output.report.gate.accepted,true);
  assert.equal(checked.length,12);
  const fail=qualityGate({...output.report,candidate:output.report.baseline});
  assert.equal(fail.accepted,false);
});

test('judge rejects scores outside 0..5 or missing dimensions',()=>{
  assert.deepEqual(parseJudgeResult({A:perfect,B:weak}).A,perfect);
  assert.throws(()=>parseJudgeResult({A:{...perfect,coherence:10},B:weak}),/Juicio inválido/);
  assert.throws(()=>parseJudgeResult({A:perfect,B:{...weak,factuality:undefined}}),/Juicio inválido/);
});
