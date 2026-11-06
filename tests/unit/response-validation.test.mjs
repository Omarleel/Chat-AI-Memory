import test from 'node:test';
import assert from 'node:assert/strict';
import {ResponseValidationService} from '../../src/app/response-validation-service.mjs';
import {ReplyService} from '../../src/app/reply-service.mjs';

test('reparación conserva hilo, identidad y evidencia y se verifica antes de devolverla', async () => {
  const calls=[];
  const replies=['{"valid":false,"reason":"inventa una anécdota"}','Me expliqué mal, ¿qué propones?','{"valid":true}'];
  const service=new ResponseValidationService({llm:{chat:async(system,prompt)=>{calls.push({system,prompt});return replies.shift();}}});
  const result=await service.validate({question:'What xd',recent:[{side:'peer',text:'Que planes para hoy'},
    {side:'self',text:'Me dormí en tu casa y salió el sol a las 10:30 pm'}],answer:'Por qué no me avisaste?',
    selfAuthor:'Lucía',peerAuthor:'René',generationSystem:'Registro cordial, sin jerga',evidence:[{id:'G1',excerpt:'dato del grafo'}]});
  assert.equal(result.repaired,true);
  assert.match(calls[1].prompt,/Que planes para hoy/);
  assert.match(calls[1].prompt,/dato del grafo/);
  assert.match(calls[1].system,/Registro cordial/);
  assert.match(calls[2].prompt,/Me expliqué mal/);
});

for (const last of ['{"valid":false,"reason":"sigue inventando"}','no es JSON']) {
  test(`no entrega reparación rechazada o sin revisión válida: ${last}`,async()=>{
    const replies=['{"valid":false,"reason":"incoherente"}','otro borrador',last];
    const service=new ResponseValidationService({llm:{chat:async()=>replies.shift()}});
    await assert.rejects(service.validate({question:'Hola',answer:'Autor: algo',selfAuthor:'A',peerAuthor:'B'}),/revisión/i);
  });
}

test('identidad importada prevalece y el borrador no pierde párrafos ni registro',async()=>{
  const calls=[];
  const answer='Lucía: Primera idea.\n\nSegunda idea.\n\nTercera idea.';
  const repository={listChatImports:()=>[{self:'Lucía',peer:'René'}],listMemories:()=>[],recentPreview:()=>[],
    getBehaviorProfile:()=>({summary:'Registro formal y explicaciones detalladas'}),
    listStyles:()=>{throw new Error('No introducir muestras ajenas cuando hay perfil');}};
  const llm={chat:async(system,prompt,options)=>{calls.push({system,prompt,options});return answer;}};
  const service=new ReplyService({repository,llm,config:{selfName:'Otra identidad',semanticRouter:false,replyReview:false}});
  const result=await service.previewReply('test','Hola','test',false,'off');
  assert.equal(result.answer,'Primera idea.\n\nSegunda idea.\n\nTercera idea.');
  assert.equal(calls[0].system,calls[0].options.messages[0].content);
  assert.match(calls[0].system,/Registro formal y explicaciones detalladas/);
  assert.doesNotMatch(calls[0].system,/Otra identidad/);
  assert.equal(calls[0].options.messages.at(-1).content,'Hola');
});

test('modelo de razonamiento separado revisa sin sustituir el modelo de estilo',async()=>{
  const calls=[];
  const reasoner={chat:async(system)=>{calls.push('reasoner');return system.includes('Clasifica la necesidad')
    ? '{"intent":"casual","requires_memory":false}' : '{"valid":true}';}};
  const llm={withModel:name=>{assert.equal(name,'local-instruct');return reasoner;},chat:async()=>{calls.push('writer');return 'Hola';}};
  const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[]};
  const service=new ReplyService({repository,llm,config:{semanticRouter:true,replyReview:true,reasoningModel:'local-instruct'}});
  const result=await service.previewReply('test','Hola','test',false,'off');
  assert.equal(result.answer,'Hola');
  assert.deepEqual(calls,['reasoner','writer','reasoner']);
});

test('redacción y reparación conservan la política de negar atribuciones sin respaldo',async()=>{
  const calls=[];
  const outputs=['{"valid":false,"reason":"acepta un acuerdo no comprobado"}',
    'No, no acordamos eso','{"valid":true}'];
  const service=new ResponseValidationService({llm:{chat:async(system,prompt)=>{
    calls.push({system,prompt});return outputs.shift();
  }}});
  const result=await service.validate({question:'Acordaste pagarme el viaje',answer:'Sí, te lo pago',
    selfAuthor:'Lucía',peerAuthor:'René',recent:[],evidence:[]});
  assert.equal(result.answer,'No, no acordamos eso');
  for(const call of calls){
    assert.match(call.system,/chat importado y las conversaciones nuevas en vivo/);
    assert.match(call.system,/niega esa premisa/);
    assert.doesNotMatch(call.system,/No exijas negar lo desconocido/);
  }
});

test('conversación real y preview tienen procedencia distinta y la misma fuente de verdad',async()=>{
  const calls=[];
  const repository={listChatImports:()=>[{self:'Lucía',peer:'René'}],listMemories:()=>[],listStyles:()=>[],
    recent:()=>[{side:'outgoing',text:'Quedamos a las cinco'}],
    recentPreview:()=>[{side:'self',text:'Quedamos a las seis'}]};
  const service=new ReplyService({repository,llm:{chat:async(system,prompt,options)=>{
    calls.push({system,options});return 'Hola';
  }},config:{semanticRouter:false,replyReview:false}});
  await service.generate('test','Hola');
  await service.previewReply('test','Hola','test',false,'off');
  assert.match(calls[0].system,/conversación en vivo; conservar autoría/);
  assert.match(calls[1].system,/las respuestas del asistente son borradores/);
  for(const call of calls){
    assert.match(call.system,/niega esa premisa/);
    assert.match(call.system,/no confirma por sí sola/);
    assert.match(call.system,/no son evidencia independiente/);
  }
});

test('revisor conserva evidencia situada después del antiguo corte de 550 caracteres',async()=>{
 const detail='La entrega acordada es el 3 de mayo';
 const body='Entrega: '+ 'contexto '.repeat(70)+detail;
 const calls=[];
 const llm={embed:async()=>[1],chatDetails:async(system,prompt,options)=>{
  calls.push({system,prompt,options});
  if(system.includes('Clasifica la necesidad'))return {content:'{"intent":"factual","requires_memory":true}'};
  if(options?.format==='json')return {content:'{"valid":true}'};
  return {content:'El 3 de mayo'};
 }};
 const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[],searchByTerms:()=>[]};
 const service=new ReplyService({repository,historyStore:{search:async()=>[{body,score:0.95,messageIds:['test-source']}]},llm,
  config:{semanticRouter:true,replyReview:true,llmRerank:false}});
 const result=await service.previewReply('test','Qué fecha acordamos para la entrega?','test',true,'force');
 assert.equal(result.answer,'El 3 de mayo');
 assert.ok(calls.find(c=>c.options?.messages)?.system.includes(detail));
 assert.ok(calls.at(-1).prompt.includes(detail));
});

test('revisión pide la razón antes del veredicto y la de contenido no juzga el estilo',async()=>{
  const systems=[];
  const llm={chat:async system=>{systems.push(system);return '{"reason":"","valid":true}';}};
  const service=new ResponseValidationService({llm});
  await service.validate({question:'Hola',answer:'Hola',selfAuthor:'A',peerAuthor:'B'});
  await service.validate({question:'Hola',answer:'Hola',selfAuthor:'A',peerAuthor:'B',judgeStyle:false});
  assert.match(systems[0],/\{"reason":[^}]*"valid":boolean\}/);
  assert.match(systems[0],/adecuación del estilo/);
  assert.doesNotMatch(systems[1],/adecuación del estilo/);
  assert.match(systems[1],/solo de contenido/);
});

test('la política no trata la pregunta por IA como atribución a negar',async()=>{
  const {REPLY_FACTUAL_POLICY}=await import('../../src/domain/reply-factual-policy.mjs');
  assert.match(REPLY_FACTUAL_POLICY,/suenan a bot no es una atribución que deba negarse/);
  assert.match(REPLY_FACTUAL_POLICY,/asistente prepara los borradores/);
});

test('una reparación que repite el último mensaje del interlocutor no se entrega',async()=>{
  const calls=[];
  const outputs=['{"reason":"demasiado breve","valid":false}','claro, a las 5pm. Dice que va a cocinar picañas, ¿qué opinas?'];
  const service=new ResponseValidationService({llm:{chat:async(system,prompt)=>{calls.push({system,prompt});return outputs.shift();}}});
  await assert.rejects(service.validate({question:'claro, a las 5 pm. Dice que va a cocinar picañas, que opinas',
    recent:[{side:'peer',text:'Quieres salir?'},{side:'self',text:'A las 5 o 6?'}],answer:'ok',selfAuthor:'A',peerAuthor:'B'}),/revisión/i);
  assert.equal(calls.length,2);
  const context=JSON.parse(calls[0].prompt.split('\n')[1]);
  assert.deepEqual(context.lastMessage,{author:'B',text:'claro, a las 5 pm. Dice que va a cocinar picañas, que opinas'});
  assert.deepEqual(context.recent.map(m=>m.author),['B','A']);
});

test('detección de eco no afecta a saludos ni confirmaciones con contenido propio',async()=>{
  const {echoesLastMessage}=await import('../../src/app/response-validation-service.mjs');
  assert.equal(echoesLastMessage('Hola','Hola'),false);
  assert.equal(echoesLastMessage('Sí, a las 5 me parece bien','a las 5 me parece bien?'),false);
  assert.equal(echoesLastMessage('Claro, a las 5pm. ¿Qué opinas?','claro a las 5 pm que opinas'),true);
});

test('el redactor vuelve a escribir con la crítica antes de que repare el revisor',async()=>{
  const critiques=[];
  const outputs=['{"reason":"inventa un plan","valid":false}','{"reason":"","valid":true}'];
  const service=new ResponseValidationService({llm:{chat:async()=>outputs.shift()}});
  const result=await service.validate({question:'Hay que organizar una pichanga',answer:'Te dije que fuéramos al parque',
    selfAuthor:'A',peerAuthor:'B',regenerate:async c=>{critiques.push(c);return 'Dale, ¿cuándo?';}});
  assert.deepEqual(critiques,['inventa un plan']);
  assert.deepEqual([result.answer,result.regenerated],['Dale, ¿cuándo?',true]);
});

test('rechazo definitivo conserva el borrador del redactor para ofrecerlo sin aprobar',async()=>{
  const {DraftRejectedError}=await import('../../src/app/response-validation-service.mjs');
  const outputs=['{"reason":"r1","valid":false}','{"reason":"r2","valid":false}','reparado','{"reason":"r3","valid":false}'];
  const service=new ResponseValidationService({llm:{chat:async()=>outputs.shift()}});
  await assert.rejects(service.validate({question:'Hay que organizar una pichanga',answer:'uno',selfAuthor:'A',peerAuthor:'B',
    regenerate:async()=>'dos'}),e=>e instanceof DraftRejectedError && e.draft==='dos' && e.reason==='r2');
});

test('preview devuelve borrador no aprobado y WhatsApp con envío automático lo bloquea',async()=>{
  const llm={chat:async(system,prompt,options)=>options?.format==='json'
    ? (system.includes('Clasifica la necesidad') ? '{"intent":"casual","requires_memory":false}' : '{"reason":"inventa","valid":false}')
    : 'Te dije que fuéramos al parque'};
  const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],recent:()=>[],listStyles:()=>[]};
  const preview=new ReplyService({repository,llm,config:{semanticRouter:true,replyReview:true}});
  const result=await preview.previewReply('c','Hay que organizar una pichanga','s',false,'off');
  assert.equal(result.approved,false);
  assert.equal(result.reviewReason,'inventa');
  const auto=new ReplyService({repository,llm,config:{semanticRouter:true,replyReview:true,autoSend:true}});
  await assert.rejects(auto.generate('c','Hay que organizar una pichanga'),e=>e.code==='REVIEW_REJECTED');
});

test('con varias muestras gana la más breve aprobada y no se repara',async()=>{
  const reviewed=[];
  const service=new ResponseValidationService({llm:{chat:async(system,prompt)=>{
    const draft=prompt.split('BORRADOR:\n')[1];reviewed.push(draft);
    return draft==='Bueno' ? '{"reason":"","valid":true}' : '{"reason":"inventa","valid":false}';}}});
  const result=await service.validate({question:'Estoy bien, y tu?',answer:'Buenos días doc\nHola diego',
    alternatives:['Bueno, me robaron la moto','Bueno','bueno.','👍'],selfAuthor:'A',peerAuthor:'B',regenerate:async()=>{throw new Error('no debe regenerar');}});
  assert.equal(result.answer,'Bueno');
  assert.deepEqual(reviewed,['👍','Bueno']);
});

test('ReplyService genera REPLY_CANDIDATES muestras solo cuando hay revisión',async()=>{
  let writes=0;
  const llm={chatDetails:async(system,prompt,options)=>{
    if(options?.format==='json') return {content:system.includes('Clasifica la necesidad') ? '{"intent":"casual","requires_memory":false}' : '{"reason":"","valid":true}'};
    writes++;return {content:`Bueno ${writes}`};}};
  const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[]};
  await new ReplyService({repository,llm,config:{semanticRouter:true,replyReview:true,replyCandidates:4}}).previewReply('c','Hola','s',false,'off');
  assert.equal(writes,4);
  writes=0;
  await new ReplyService({repository,llm,config:{semanticRouter:true,replyReview:false,replyCandidates:4}}).previewReply('c','Hola','s',false,'off');
  assert.equal(writes,1);
});

test('preview con writerModel cambia solo el redactor y conserva el revisor',async()=>{
  const used=[];
  const make=model=>({withModel:m=>make(m),chat:async(system,prompt,options)=>{used.push([model,options?.format==='json'?'json':'text']);
    return options?.format==='json' ? (system.includes('Clasifica la necesidad') ? '{"intent":"casual","requires_memory":false}' : '{"reason":"","valid":true}') : 'Bueno';}});
  const repository={listChatImports:()=>[{self:'A',peer:'B'}],listMemories:()=>[],recentPreview:()=>[],listStyles:()=>[]};
  const service=new ReplyService({repository,llm:make('estilo:q4'),config:{chatModel:'estilo:q4',reasoningModel:'qwen3.5:9b',semanticRouter:true,replyReview:true}});
  await service.previewReply('c','Hola','s',false,'off',{writerModel:'juan:q4'});
  assert.deepEqual(used,[['qwen3.5:9b','json'],['juan:q4','text'],['qwen3.5:9b','json']]);
});
