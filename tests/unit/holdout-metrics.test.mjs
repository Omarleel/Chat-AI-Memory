import test from 'node:test';
import assert from 'node:assert/strict';
import {styleFeatures,styleDistance,seededShuffle,selectHoldoutCases} from '../../src/lab/holdout-metrics.mjs';
import {ReplyService} from '../../src/app/reply-service.mjs';

test('distancia de forma es 0 para la misma forma y crece con longitud y puntuación',()=>{
  const a=styleFeatures('ya voy'),b=styleFeatures('ya llego');
  assert.equal(styleDistance(a,a),0);
  assert.ok(styleDistance(a,b)<0.1);
  assert.ok(styleDistance(a,styleFeatures('¡Hola! Te escribo para confirmar la reunión de mañana a las cinco.'))>0.4);
});

test('barajado determinista y selección de un caso por sesión con contexto de varios turnos',()=>{
  assert.deepEqual(seededShuffle([1,2,3,4],'s'),seededShuffle([1,2,3,4],'s'));
  const turn=(role,content)=>({role,content});
  const row=(session,hash,n)=>({provenance:{split:'test',session,hash},completion:[{role:'assistant',content:'dale'}],
    prompt:[turn('system','x'),...Array.from({length:n},(_,i)=>turn(i%2?'assistant':'user',`m${i}`)),turn('user','ultimo')]});
  const cases=selectHoldoutCases([row('s1','a',4),row('s1','b',6),row('s2','c',2),row('s3','d',5)],{limit:10});
  assert.equal(cases.length,2);
  assert.ok(cases.every(c=>c.context.length>=4 && c.input==='ultimo' && c.reference==='dale'));
});

test('contexto real del holdout no se etiqueta como borrador generado',async()=>{
  const plans=[];
  const reasoner={chatDetails:async(system,prompt)=>{
    if(system.includes('evidenceIds')){plans.push(JSON.parse(prompt));return {content:JSON.stringify({interpretation:'x',facts:[],response:'dale',evidenceIds:[]})};}
    if(system.includes('Clasifica la necesidad'))return {content:'{"intent":"casual","requires_memory":false}'};
    return {content:'{"reason":"","valid":true}'};}};
  const llm={withModel:()=>reasoner,chatDetails:async()=>({content:'dale'})};
  const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[]};
  const service=new ReplyService({repository,llm,config:{semanticRouter:true,replyReview:true,reasoningModel:'r',replyPipeline:'content_style'}});
  await service.previewReply('c','vamos?','h',false,'off',{recentMessages:[{role:'assistant',content:'mañana voy'}],recentOrigin:'real'});
  await service.previewReply('c','vamos?','h',false,'off',{recentMessages:[{role:'assistant',content:'mañana voy'}]});
  assert.equal(plans[0].recent[0].origin,'live_message');
  assert.equal(plans[1].recent[0].origin,'generated_draft');
});
