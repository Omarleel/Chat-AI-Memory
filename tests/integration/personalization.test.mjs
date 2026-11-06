import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {SemanticDecisionService,validateLearnedFacts} from '../../src/domain/semantic-decisions.mjs';
import {MemoryConsolidationService} from '../../src/app/memory-consolidation-service.mjs';
import {RetrievalService, reciprocalRankFusion} from '../../src/app/retrieval-service.mjs';
import {chunkEpisodes} from '../../src/domain/history.mjs';
import {ReplyService} from '../../src/app/reply-service.mjs';
import {checkCitations} from '../../src/domain/grounding.mjs';

const PHONE='51955551111'; const OTHER='51955552222';
const make=(i,contact=PHONE)=>({id:`id${contact}_${i}`,ordinal:i,
  isoTimestamp:`2026-01-01T10:${String(i).padStart(2,'0')}:00`,rawTimestamp:`01/01/2026 10:${String(i).padStart(2,'0')}`,
  author:i%2?'Ana':'Luis',role:i%2?'self':'peer',text:`El evento catalogo${i} fue anunciado`});

test('router semántico interpreta seguimiento implícito y no aplica categorías estáticas',async()=>{
  const llm={chat:async()=>JSON.stringify({intent:'followup',requires_memory:true,
    entities:['La librería'],search_query:'compra anterior de librería'})};
  const result=await new SemanticDecisionService({llm}).route({text:'¿Y lo de ahí?',recent:[{side:'self',text:'Te conté lo del libro'}]});
  assert.equal(result.routeSource,'model');assert.equal(result.needsMemoryRetrieval,true);
  assert.equal(result.searchQuery,'compra anterior de librería');
});
test('router fallido recupera memoria por defecto, no la descarta',async()=>{
  const llm={chat:async()=>'{broken json'};
  const result=await new SemanticDecisionService({llm}).route({text:'¿Y eso?',recent:[]});
  assert.equal(result.routeSource,'fail_open');assert.equal(result.needsMemoryRetrieval,true);
});
test('memoria extraída debe tener cita literal de interlocutor correcto',()=>{
  const source=[{id:'r1',role:'peer',text:'Me mudé a Arequipa la semana pasada'}];
  const valid=validateLearnedFacts({facts:[
    {key:'residence',fact:'La persona se mudó a Arequipa',quote:'Me mudé a Arequipa',speaker:'peer'},
    {key:'job',fact:'Es astronauta',quote:'trabajo en NASA',speaker:'peer'},
    {key:'city',fact:'Yo vivo en Arequipa',quote:'Me mudé a Arequipa',speaker:'self'}]},source);
  assert.equal(valid.length,1);assert.equal(valid[0].sourceId,'r1');
});
test('consolidación solo acepta fuente histórica o real y no graba preview',async()=>{
  const repo=new SqliteRepository(':memory:');
  try{
    const service=new MemoryConsolidationService({repository:repo,llm:{chat:async()=>JSON.stringify({facts:[
      {key:'residence',fact:'Luis se mudó',quote:'Me mudé a Arequipa',speaker:'peer'}]})}});
    await assert.rejects(()=>service.ingest(PHONE,[{id:'p',role:'peer',text:'Me mudé a Arequipa'}],{source:'preview'}));
    assert.equal(repo.listLearnedMemories(PHONE).length,0);
    const res=await service.ingest(PHONE,[{id:'real-1',role:'peer',text:'Me mudé a Arequipa ayer'}]);
    assert.equal(res.inserted,1);assert.equal(repo.listLearnedMemories(PHONE)[0].source_id,'real-1');
    assert.equal((await service.ingest(PHONE,[{id:'real-1',role:'peer',text:'Me mudé a Arequipa ayer'}])).inserted,0);
  }finally{repo.close();}
});
test('corrección explícita versiona hechos sin borrar evidencia antigua ni mezclar contactos',()=>{
 const repo=new SqliteRepository(':memory:');
 try{
  const m=(id,fact,action='append')=>({sourceId:id,key:'residence',speaker:'peer',fact,quote:fact,action});
  repo.saveLearnedMemory(PHONE,m('1','Vivo en Lima'));
  repo.saveLearnedMemory(PHONE,m('2','Ahora vivo en Cusco','supersede'));
  repo.saveLearnedMemory(OTHER,m('3','Vivo en Iquitos'));
  assert.deepEqual(repo.listLearnedMemories(PHONE).map(x=>x.fact),['Ahora vivo en Cusco']);
  assert.equal(repo.listLearnedMemories(PHONE,20,{includeSuperseded:true}).length,2);
  assert.deepEqual(repo.listLearnedMemories(OTHER).map(x=>x.fact),['Vivo en Iquitos']);
 }finally{repo.close();}
});
test('FTS5 busca todo el historial más allá de 2000 mensajes y respeta contacto',()=>{
 const repo=new SqliteRepository(':memory:');
 try{
  const messages=Array.from({length:2105},(_,i)=>({...make(i),
    text:i===2104?'La contraseña de prueba tokenunicoastrolab no es una credencial real':`mensaje numero${i}`}));
  repo.saveImportedMessages(PHONE,'hash1',messages);
  repo.saveImportedMessages(OTHER,'hash2',[{...make(0,OTHER),text:'tokenunicoastrolab'}]);
  assert.deepEqual(repo.searchByTerms(PHONE,['tokenunicoastrolab']).map(x=>x.messageIds[0]),[messages.at(-1).id]);
  assert.equal(repo.searchByTerms(OTHER,['tokenunicoastrolab']).length,1);
  assert.equal(repo.searchByTerms(PHONE,['noexiste']).length,0);
 }finally{repo.close();}
});
test('búsqueda de estilo selecciona pares relacionados en lugar de ignorarlos por perfil',()=>{
 const repo=new SqliteRepository(':memory:');
 try{
  repo.saveStylePairs(PHONE,[{incoming:'Quieres ir al cine?',reply:'ya normal',contextType:'casual_chat',hash:'h1'},
    {incoming:'Te gusta el helado?',reply:'sí pues',contextType:'casual_chat',hash:'h2'}]);
  assert.equal(repo.searchStylePairs(PHONE,'vamos al cine')[0].reply,'ya normal');
  assert.equal(repo.searchStylePairs(OTHER,'vamos al cine').length,0);
 }finally{repo.close();}
});
test('RRF fusiona posiciones independientes de las escalas de score',()=>{
 const a={body:'A',score:0.9,messageIds:['a']}; const b={body:'B',score:0.8,messageIds:['b']};
 const r=reciprocalRankFusion([[a,b],[b,a]]);
 assert.equal(r.length,2);assert.ok(r[0].rankScore>0);
});
test('recuperación híbrida usa FTS y descarta candidato irrelevante según reranker',async()=>{
 const repo=new SqliteRepository(':memory:');
 try{
  repo.saveImportedMessages(PHONE,'hash',[{...make(0),text:'Mi cumpleaños es el 3 de mayo'}]);
  const found=await new RetrievalService({repository:repo,historyStore:{search:async()=>[
    {body:'Fútbol de ayer',score:.99,messageIds:['fake']}]},
    llm:{embed:async()=>[1,0],chat:async(_s,p)=>{
      const idx=p.indexOf('cumpleaños');
      assert.ok(idx>=0);
      return JSON.stringify({scores:[{id:1,relevance:0},{id:2,relevance:3}]});
    }},config:{topK:2,llmRerank:true}}).search({contact:PHONE,question:'¿Cuándo es mi cumpleaños?',limit:2});
  assert.equal(found.stats.rerankMethod,'llm');
  assert.equal(found.results.length,1);assert.match(found.results[0].body,/cumpleaños/);
 }finally{repo.close();}
});
test('episodios no contienen mensajes superpuestos y preservan IDs',()=>{
 const items=[{...make(0),isoTimestamp:'2026-01-01T10:00:00'},
 {...make(1),isoTimestamp:'2026-01-01T10:01:00'},
 {...make(2),isoTimestamp:'2026-01-01T18:00:00'}];
 const chunks=chunkEpisodes(items,{maxChars:1500,gapMinutes:30});
 assert.equal(chunks.length,2);assert.deepEqual(chunks.flatMap(x=>x.messageIds),items.map(x=>x.id));
});
test('integridad de citas detecta referencias a fragmentos inexistentes',()=>{
 assert.deepEqual(checkCitations('Dijo eso [H1] y [H9]',[{id:'H1'}]).invalid,['H9']);
});
test('ruta productiva semántica usa RRF y prioriza el perfil sobre diálogos ajenos',async()=>{
 const calls=[];
 const repo={listChatImports:()=>[{self:'Ana',peer:'Luis'}],getPersonas:()=>({self:{summary:'Corto',author:'Ana'},peer:null}),
  listMemories:()=>[], listLearnedMemories:()=>[],recentPreview:()=>[],
  listStyles:()=>['sí ps'], searchByTerms:()=>[],searchStylePairs:()=>[{incoming:'Vamos a nadar',reply:'sí de una'}]};
 let callsRerank=0;
 const llm={embed:async()=>[1,0],chat:async()=>{callsRerank++;return '{"scores": []}';},
  chatDetails:async(system,prompt,options)=>{
   calls.push({system,prompt,options});
   if(system.includes('Clasifica la necesidad de memoria'))
    return {content:JSON.stringify({intent:'reply',requires_memory:true,search_query:'nadar'})};
   return {content:'Vamos al agua después',doneReason:'stop',truncated:false};
  }};
 const result=await new ReplyService({repository:repo,historyStore:{search:async()=>[
  {body:'Antes jugamos en el mar',messageIds:['a'],score:.9}]},llm,
  config:{semanticRouter:true,llmRerank:false,selfName:'Ana',topK:2,replyReview:false}})
  .previewReply(PHONE,'¿Y lo de ayer?','tmp',true,'auto');
 assert.equal(result.answer,'Vamos al agua después');
 assert.equal(result.rag.retrieval.strategy,'hybrid_rrf');
 assert.equal(result.rag.retrieval_debug.decision_source,'model');
 assert.ok(calls.some(x=>x.options?.messages?.[0]?.content?.includes('Corto')));
 assert.ok(!calls.some(x=>x.options?.messages?.[0]?.content?.includes('Vamos a nadar')));
});

test('perfil conductual exige prueba literal y lo conserva por contacto',async()=>{
 const {BehaviorProfileService}=await import('../../src/app/behavior-profile-service.mjs');
 const repo=new SqliteRepository(':memory:');
 try{
  const samples=Array.from({length:4},(_,i)=>({replyId:`r${i}`,incoming:'Vamos al cine?',
    reply:`ya normal, veamos el horario ${i}`}));
  repo.getBehaviorSamples=()=>samples;
  const llm={chat:async()=>JSON.stringify({summary:'Responde breve a planes concretos',patterns:[
   {behavior:'Confirma con informalidad',evidence_id:'r1',quote:'ya normal'},
   {behavior:'Inventado',evidence_id:'r1',quote:'No existente'}]})};
  const result=await new BehaviorProfileService({repository:repo,llm}).rebuild(PHONE);
  assert.equal(result.saved,true);assert.equal(result.patterns,1);
  assert.equal(repo.getBehaviorProfile(PHONE)?.patterns[0]?.sourceId,'r1');
  assert.equal(repo.getBehaviorProfile(OTHER),null);
 }finally{repo.close();}
});

test('validador semántico preserva respuesta correcta y regenera una sola vez si detecta error',async()=>{
 const {ResponseValidationService}=await import('../../src/app/response-validation-service.mjs');
 let count=0;
 const service=new ResponseValidationService({llm:{chat:async()=>{
  count++;return count===1?'{"valid":false,"reason":"atribución invertida"}':count===2?'Sí, tú lo dijiste':'{"valid":true}';
 }}});
 const result=await service.validate({question:'Lo dije yo',answer:'Lo dijiste tú',selfAuthor:'Ana',peerAuthor:'Luis'});
 assert.equal(result.repaired,true);assert.equal(result.answer,'Sí, tú lo dijiste');assert.equal(count,3);
});
