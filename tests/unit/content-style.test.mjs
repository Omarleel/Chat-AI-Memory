import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentStyleService} from '../../src/app/content-style-service.mjs';
import {profileReply,markStage,instrumentLlm,recordDiagnostic} from '../../src/app/reply-profiler.mjs';

const context={question:'Acordaste pagar el viaje?',recent:[],evidence:[],selfAuthor:'Alex',peerAuthor:'Dani',source:'simulation',style:'Informal'};
function fixture({styleValid=false,malformed=false}={}){
 const prompts=[];
 const reasoner={chatDetails:async(system,prompt)=>{
  prompts.push({system,prompt});
  if(system.includes('evidenceIds'))return {content:malformed?'{}':JSON.stringify({interpretation:'Atribuye un acuerdo',response:'No acordamos eso',evidenceIds:[]})};
  return {content:JSON.stringify({valid:system.includes('Compara también')?styleValid:true,reason:''})};
 }};
 const writer={chatDetails:async()=>({content:styleValid?'No, no quedamos en eso':'Sí, te lo pago mañana'})};
 return {service:new ContentStyleService({reasoner,writer}),prompts};
}
test('estilo que cambia una negación por deuda vuelve al contenido validado',async()=>{
 const {service}=fixture();
 const result=await profileReply(async()=>({answer:(await service.generate(context)).answer,rag:{}}),{capture:true});
 assert.equal(result.answer,'No acordamos eso');
 assert.equal(result.rag.profile.decisions.styleValid,false);
 assert.equal(result.rag.profile.decisions.styleFallback,'rejected_or_unavailable');
 assert.deepEqual(result.diagnostics.artifacts.styled,['Sí, te lo pago mañana']);
});
test('estilo equivalente se conserva y su validación recibe el contenido aprobado',async()=>{
 const {service,prompts}=fixture({styleValid:true});
 const result=await service.generate(context);
 assert.equal(result.answer,'No, no quedamos en eso');
 assert.equal(JSON.parse(prompts.at(-1).prompt.split('CONTEXTO (datos):\n')[1].split('\nBORRADOR:')[0]).baselineAnswer,'No acordamos eso');
});
test('plan inválido falla en content y no alcanza el estilizador',async()=>{
 const {service}=fixture({malformed:true});
 await assert.rejects(profileReply(()=>service.generate(context)),error=>{
  assert.equal(error.previewStage,'content');
  assert.equal(error.replyProfile.decisions.contentContractValid,false);return true;
 });
});
test('profiling concurrente conserva aislamiento y no guarda textos en métricas',async()=>{
 const client=instrumentLlm({chatModel:'test',chatDetails:async(_system,prompt)=>{
  await new Promise(resolve=>setTimeout(resolve,prompt==='secreto A'?15:1));
  return {content:prompt,evalCount:3,promptEvalCount:8};
 }});
 const run=(name,secret)=>profileReply(async()=>{
  markStage(name);recordDiagnostic('pipeline',name);
  const result=await client.chatDetails('instrucciones privadas',secret);
  return {answer:result.content,rag:{}};
 });
 const [a,b]=await Promise.all([run('content','secreto A'),run('style','secreto B')]);
 assert.equal(a.rag.profile.calls.length,1);assert.equal(b.rag.profile.calls.length,1);
 assert.equal(a.rag.profile.calls[0].stage,'content');assert.equal(b.rag.profile.calls[0].stage,'style');
 assert.equal(a.rag.profile.calls[0].outputTokens,3);
 assert.doesNotMatch(JSON.stringify([a.rag,b.rag]),/secreto|instrucciones privadas/);
 assert.equal(a.diagnostics,undefined);
});

test('el plan recibe autoría explícita y no trata borradores como mensajes reales',async()=>{
 const {service,prompts}=fixture({styleValid:true});
 await service.generate({...context,recent:[{side:'self',text:'Un dato inventado'},{side:'peer',text:'No entiendo'}]});
 const input=JSON.parse(prompts[0].prompt);
 assert.deepEqual(input.recent,[{author:'Alex',text:'Un dato inventado',origin:'generated_draft'},
  {author:'Dani',text:'No entiendo',origin:'peer_message'}]);
});

test('el plan pide hechos antes de la respuesta y lenguaje de chat sin jerga de registros',async()=>{
 const {service,prompts}=fixture({styleValid:true});
 await service.generate(context);
 const plan=prompts[0].system;
 assert.ok(plan.indexOf('"facts"')<plan.indexOf('"response"'));
 assert.match(plan,/sin mencionar registros, historial/);
 assert.match(plan,/borradores para Alex/);
});

test('cita inexistente en el plan se descarta y se registra sin abortar el turno',async()=>{
 const reasoner={chatDetails:async system=>system.includes('evidenceIds')
  ? {content:JSON.stringify({interpretation:'x',facts:[{id:'H1',claim:'inventado'}],response:'No acordamos eso',evidenceIds:['H1']})}
  : {content:'{"reason":"","valid":true}'}};
 const service=new ContentStyleService({reasoner,writer:{chatDetails:async()=>({content:'No acordamos eso'})}});
 const result=await profileReply(async()=>({answer:(await service.generate(context)).answer,rag:{}}),{capture:true});
 assert.equal(result.answer,'No acordamos eso');
 assert.equal(result.rag.profile.decisions.unknownEvidenceIds,1);
 assert.deepEqual(result.diagnostics.artifacts.plan.evidenceIds,[]);
});
test('forma real del titular y ejemplos llegan a las etapas; varias versiones de estilo, gana la más breve',async()=>{
 const {ownTurns,replyShape,describeShape}=await import('../../src/domain/reply-shape.mjs');
 const messages=Array.from({length:60},(_,i)=>({role:i%3===0?'peer':'self',text:i%3===0?'hola?':'ok'+'o'.repeat(i%5)}));
 const shape=replyShape(ownTurns(messages));
 assert.equal(shape.multiLine,1);
 assert.match(describeShape(shape),/caracteres/);
 const calls=[];
 const reasoner={chatDetails:async(system,prompt,options)=>{calls.push({who:'reasoner',system,prompt});
  if(system.includes('Devuelve JSON {"interpretation"')) return {content:JSON.stringify({interpretation:'saluda',facts:[],response:'Bien, todo tranquilo por aquí',evidenceIds:[]})};
  return {content:'{"reason":"","valid":true}'};}};
 const styledOut=['Bien, tranqui','Bien','Todo bien por aca causa'];
 const writer={chatDetails:async(system,prompt)=>{calls.push({who:'writer',system,prompt});return {content:styledOut.shift()};}};
 const {ContentStyleService}=await import('../../src/app/content-style-service.mjs');
 const service=new ContentStyleService({reasoner,writer,config:{replyCandidates:3}});
 const result=await service.generate({question:'Como estas?',recent:[],evidence:[],selfAuthor:'A',peerAuthor:'B',style:null,source:'live',
  shape,examples:[{incoming:'que haces',reply:'nada'}]});
 assert.equal(result.answer,'Bien');
 assert.match(calls.find(c=>c.system.includes('Devuelve JSON {"interpretation"')).system,/caracteres/);
 const styleCall=calls.find(c=>c.who==='writer');
 assert.deepEqual(JSON.parse(styleCall.prompt).examples,[{they:'que haces',A:'nada'}]);
 assert.equal(calls.filter(c=>c.who==='writer').length,3);
});
test('REPLY_PIPELINE=auto usa contenido+estilo solo cuando hay evidencia recuperada',async()=>{
 const {ReplyService}=await import('../../src/app/reply-service.mjs');
 const llm={embed:async()=>[1],chatDetails:async(system,prompt,options)=>{
  if(system.includes('Clasifica la necesidad')) return {content:prompt.includes('deuda')?'{"intent":"factual","requires_memory":true}':'{"intent":"casual","requires_memory":false}'};
  if(system.includes('Devuelve JSON {"interpretation"')) return {content:JSON.stringify({interpretation:'pregunta',facts:[],response:'Son 93',evidenceIds:[]})};
  if(options?.format==='json') return {content:'{"reason":"","valid":true}'};
  return {content:'93 causa'};}};
 const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[],searchByTerms:()=>[]};
 const service=new ReplyService({repository,historyStore:{search:async()=>[{body:'B: te debo 93',score:0.9,messageIds:['m1']}]},llm,
  config:{semanticRouter:true,replyReview:true,reasoningModel:'r',replyPipeline:'auto',llmRerank:false}});
 const run=async text=>(await service.previewReply('c',text,'s',true,'auto',{captureDiagnostics:true})).diagnostics.profile.decisions.pipeline;
 assert.equal(await run('cuanto es la deuda?'),'content_style');
 assert.equal(await run('hola'),'direct');
});

test('auto descarta evidencia que no sirve y el estilo redacta guiado con el hilo propio',async()=>{
 const {ReplyService}=await import('../../src/app/reply-service.mjs');
 const writes=[];
 const llm={embed:async()=>[1],chatDetails:async(system,prompt,options)=>{
  if(system.includes('Clasifica la necesidad')) return {content:'{"intent":"factual","requires_memory":true}'};
  if(system.includes('Para cada fragmento')) return {content:prompt.includes('deuda')?'{"fragments":[{"id":"H1","sameMatter":true}]}':'{"fragments":[{"id":"H1","sameMatter":false}]}'};
  if(system.includes('Devuelve JSON {"interpretation"')) return {content:JSON.stringify({interpretation:'pregunta',facts:[],response:'Son 93 soles.',evidenceIds:['H1']})};
  if(options?.format==='json') return {content:'{"reason":"","valid":true}'};
  writes.push({system,messages:options?.messages});
  return {content:'93 causa'};}};
 const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[],searchByTerms:()=>[]};
 const service=new ReplyService({repository,historyStore:{search:async()=>[{body:'B: te debo 93',score:0.9,messageIds:['m1']}]},llm,
  config:{semanticRouter:true,replyReview:true,reasoningModel:'r',replyPipeline:'auto',llmRerank:false}});
 const run=async text=>(await service.previewReply('c',text,'s',true,'auto',{captureDiagnostics:true,
  recentMessages:[{side:'peer',text:'oe'},{side:'self',text:'que fue'}]})).diagnostics.profile.decisions;
 const unrelated=await run('vamos a la playa?');
 assert.deepEqual([unrelated.pipeline,unrelated.usefulEvidence],['direct',0]);
 assert.ok(writes.length && writes.every(w=>!w.system.includes('te debo 93')),'lo descartado no llega al escritor');
 writes.length=0;
 const debt=await run('cuanto es la deuda?');
 assert.deepEqual([debt.pipeline,debt.styleMode,debt.usefulEvidence],['content_style','guided',1]);
 const guided=writes.at(-1);
 assert.match(guided.system,/QUÉ DECIR[^\n]*Son 93 soles/);
 assert.deepEqual(guided.messages.slice(1).map(m=>m.role),['user','assistant','user'],'mismo hilo ChatML que la redacción directa');
});

test('un vecino enorme (un log pegado) se recorta y no desplaza al mensaje que coincidió',async()=>{
 const {ReplyService}=await import('../../src/app/reply-service.mjs');
 const gate=[];
 const llm={embed:async()=>[1],chatDetails:async(system,prompt,options)=>{
  if(system.includes('Clasifica la necesidad')) return {content:'{"intent":"factual","requires_memory":true}'};
  if(system.includes('Para cada fragmento')) {gate.push(prompt);return {content:'{"fragments":[{"id":"H1","sameMatter":false}]}'};}
  if(options?.format==='json') return {content:'{"reason":"","valid":true}'};
  return {content:'ok'};}};
 const log='Traceback '.repeat(2000);
 const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[],searchByTerms:()=>[],
  getNeighbors:()=>[{id:'m0',timestamp:'1',author:'A',text:log},{id:'m1',timestamp:'2',author:'B',text:'te debo 93'}]};
 const service=new ReplyService({repository,historyStore:{search:async()=>[{body:'B: te debo 93',score:0.9,messageIds:['m1']}]},llm,
  config:{semanticRouter:true,replyReview:true,reasoningModel:'r',replyPipeline:'auto',llmRerank:false}});
 await service.previewReply('c','cuanto es la deuda?','s',true,'auto',{captureDiagnostics:true});
 assert.ok(gate.length);
 assert.match(gate[0],/te debo 93/);
 assert.ok(!gate[0].includes('Traceback '.repeat(30)),'el log no llega entero');
});

test('con varias versiones, la mitad se escribe libre y gana la más breve que conserva el contenido',async()=>{
 const {service}=fixture({styleValid:true});
 const service2=new ContentStyleService({reasoner:service.reasoner,writer:service.writer,config:{replyCandidates:4}});
 const calls=[];
 const writeGuided=async(content,temperature,guided)=>{calls.push(guided);return guided ? content : 'nada que ver';};
 const result=await service2.generate({...context,writeGuided});
 assert.deepEqual(calls,[false,true,false,true]);
 assert.equal(result.answer,'nada que ver','la revisión del fixture aprueba todo: gana la versión libre más breve');
});

test('REPLY_WRITER_PROMPT=training: el escritor recibe el prompt de entrenamiento y el hilo, sin penalizaciones',async()=>{
 const {ReplyService}=await import('../../src/app/reply-service.mjs');
 const {TRAINING_SYSTEM}=await import('../../src/domain/training-dataset.mjs');
 const writes=[];
 const llm={embed:async()=>[1],chatDetails:async(system,prompt,options)=>{
  if(system.includes('Clasifica la necesidad')) return {content:'{"intent":"casual","requires_memory":false}'};
  if(options?.format==='json') return {content:'{"reason":"","valid":true}'};
  writes.push({system,options});
  return {content:'Hola'};}};
 const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[],searchByTerms:()=>[]};
 const make=writerPrompt=>new ReplyService({repository,historyStore:{search:async()=>[]},llm,
  config:{semanticRouter:true,replyReview:true,reasoningModel:'r',replyPipeline:'auto',llmRerank:false,repeatPenalty:1.15,writerPrompt}});
 await make('training').previewReply('c','Hola','s',true,'auto',{recentMessages:[{side:'peer',text:'oe'},{side:'self',text:'que fue'}]});
 const w=writes.at(-1);
 assert.equal(w.system,TRAINING_SYSTEM);
 assert.deepEqual(w.options.messages.map(m=>m.role),['system','user','assistant','user']);
 assert.equal(w.options.messages[0].content,TRAINING_SYSTEM);
 assert.deepEqual([w.options.repeatPenalty,w.options.presencePenalty,w.options.frequencyPenalty],[1,0,0]);
 writes.length=0;
 await make('rules').previewReply('c','Hola','s',true,'auto',{});
 assert.notEqual(writes.at(-1).system,TRAINING_SYSTEM);
 assert.equal(writes.at(-1).options.repeatPenalty,1.15);
});

test('REPLY_WRITER_PROMPT=auto: prompt de entrenamiento solo si el modelo lo declara como SYSTEM',async()=>{
 const {ReplyService}=await import('../../src/app/reply-service.mjs');
 const {TRAINING_SYSTEM}=await import('../../src/domain/training-dataset.mjs');
 const run=async(chatModel,declared)=>{
  const writes=[];
  const llm={chatModel,embed:async()=>[1],modelSystem:async()=>declared,chatDetails:async(system,prompt,options)=>{
   if(system.includes('Clasifica la necesidad')) return {content:'{"intent":"casual","requires_memory":false}'};
   if(options?.format==='json') return {content:'{"reason":"","valid":true}'};
   writes.push(system); return {content:'Hola'};}};
  const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[],searchByTerms:()=>[]};
  await new ReplyService({repository,historyStore:{search:async()=>[]},llm,
   config:{semanticRouter:true,replyReview:true,reasoningModel:'r',replyPipeline:'auto',llmRerank:false,writerPrompt:'auto'}})
   .previewReply('c','Hola','s',true,'auto',{recentMessages:[{side:'peer',text:'oe'},{side:'self',text:'que fue'}]});
  return writes.at(-1);
 };
 assert.equal(await run('juan:q4',TRAINING_SYSTEM),TRAINING_SYSTEM,'modelo entrenado aquí');
 assert.notEqual(await run('general:7b',null),TRAINING_SYSTEM,'modelo general: reglas y contexto');
});
