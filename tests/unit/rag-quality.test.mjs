import test from 'node:test';
import assert from 'node:assert/strict';
import {rankEvidence, queryAnchors} from '../../src/domain/rag-ranking.mjs';
import {ReplyService} from '../../src/app/reply-service.mjs';

const CONTACT='51999999999';
const QUESTION='Que hago con Valeria? Me gusta';

test('RAG: nombre propio descarta coincidencia semántica de otro tema y recorta chunk', () => {
  assert.deepEqual(queryAnchors('¿Qué hago con Valeria? Me gusta'), ['valeria']);
  const rank = rankEvidence(QUESTION, [
    {body:'Tú: vamonos a centro\nDiego: jugar Bleach en PS5', score:0.97},
    {body:'Diego: ir a centro mañana\nDiego: te gusta Valeria?\nTú: jaja la conozco\nDiego: vuelve a centro', score:0.52}
  ], {limit:4});
  assert.equal(rank.results.length,1);
  assert.match(rank.results[0].body,/Valeria/);
  assert.doesNotMatch(rank.results[0].body,/centro/i);
  assert.equal(rank.stats.ignoredForAnchor,1);
});

test('RAG: el nombre se rescata con búsqueda lexical y el revisor corrige una respuesta fuera de tema', async () => {
  const calls=[];
  const repo={listChatImports:()=>[{self:'Tú',peer:'Diego R'}],
    listMemories:()=>[], recentPreview:()=>[], listStyles:()=>['Oe, normal, tranqui jaja']};
  const historyStore={
    search: async(phone, vector, top) => {
      assert.equal(phone, CONTACT); assert.equal(top,20);
      return [{score:0.93,body:'Diego: mañana vamos a centro, para ver Bleach',kind:'history'}];
    },
    searchByTerms: async(phone, terms) => {
      assert.equal(phone,CONTACT); assert.deepEqual(terms,['valeria']);
      return [{kind:'history',body:'Diego: jugamos en la PS5\nDiego: Te gusta Valeria?\nTú: qué fue?\nDiego: vamos a centro',origin:'lexical'}];
    }
  };
  const llm={embed:async()=>[0.1,0.2],chat:async(system,prompt,options)=>{
    calls.push({system,prompt,options});
    return calls.length===1 ? 'Si te gusta, déjala ir a centro.' : 'Si te gusta, háblale normal y ve qué onda, sin apurarte.';
  }};
  const service = new ReplyService({repository:repo,historyStore,llm,config:{selfName:'Alex',topK:5,
    temperature:0.35,ragMinScore:0.38,replyReview:true}});
  const result=await service.previewReply(CONTACT,QUESTION,'valeria',true,'force');
  assert.equal(result.answer,'Si te gusta, háblale normal y ve qué onda, sin apurarte.');
  assert.equal(result.rag.selected.length,1);
  assert.match(result.rag.selected[0].excerpt,/Valeria/);
  assert.doesNotMatch(result.rag.selected[0].excerpt,/centro/i);
  assert.equal(result.rag.reviewEnabled,true);
  assert.equal(calls.length,2);
  assert.match(calls[0].system,/Responde al último mensaje/);
  assert.ok(calls[0].options.temperature<=0.4);
  assert.equal(calls[1].options.temperature,0.1);
  assert.match(calls[1].prompt,/MENSAJE RECIBIDO/);
});

test('RAG: ¿Por qué? utiliza exclusivamente turnos recientes de la sesión', async()=>{
  let embedded=0, searched=0;
  const messages=[{side:'peer',text:'¿Me prestas dinero?'},{side:'self',text:'No, no te presto.'}];
  const repo={listChatImports:()=>[{self:'Tú',peer:'Diego'}],listMemories:()=>[],listStyles:()=>[],
    recentPreview:()=>messages};
  const service=new ReplyService({repository:repo,historyStore:{search:async()=>{searched++;return [];}},
    llm:{embed:async()=>{embedded++;return [1,0];},chat:async()=> 'Porque prefiero no prestar plata.'},
    config:{selfName:'Alex',topK:5,replyReview:false}});
  const result=await service.previewReply(CONTACT,'¿Por qué?','dinero',true);
  assert.equal(result.rag.followupUsedConversationOnly,true);
  assert.equal(embedded,0);
  assert.equal(searched,0);
});


test('Consejo sentimental claro: auto evita RAG, fija perspectiva y corrige inversión de sujetos', async()=>{
  const requests=[];
  let embeddings=0, searches=0;
  const repo={listChatImports:()=>[{self:'Tú',peer:'Diego R'}],listMemories:()=>[],
    recentPreview:()=>[],listStyles:()=>['Oe habla con ella normal, tranqui']};
  const llm={embed:async()=>{embeddings++;return [1,0];},
    chat:async(system,prompt)=>{
      requests.push({system,prompt});
      return '¿Qué te parece que hagamos algo con Valeria? Me gusta la idea.';
    }};
  const service=new ReplyService({repository:repo,historyStore:{search:async()=>{searches++;return [];}},
    llm,config:{selfName:'Alex',topK:5,ragMinScore:0.38,temperature:0.35,replyReview:true}});
  const result=await service.previewReply(CONTACT,QUESTION,'prueba-nueva',true);
  assert.equal(embeddings,0);
  assert.equal(searches,0);
  assert.equal(result.rag.retrieval.strategy,'not_needed_for_general_advice');
  assert.equal(result.rag.retrieval.used,0);
  assert.equal(result.rag.intent.kind,'romantic_advice');
  assert.equal(result.rag.intent.viewpoint,'peer');
  assert.equal(result.rag.intent.target,'valeria');
  assert.equal(result.rag.perspectiveGuardApplied,true);
  assert.equal(result.answer,'Si te gusta, háblale tranqui y ve cómo va. No te apures.');
  assert.match(requests[0].system,/Conserva quién dice cada cosa/);
  assert.match(requests[1].prompt,/Diego R quiere consejo porque le gusta valeria/);
});

test('Con rag_policy off no consulta memoria, con force recupera, y sin pregunta de consejo sigue RAG',async()=>{
  let embedded=0, searched=0;
  const repo={listChatImports:()=>[{self:'Tú',peer:'Diego R'}],listMemories:()=>[],
    recentPreview:()=>[],listStyles:()=>[]};
  const historyStore={search:async()=>{searched++;return [{body:'Diego R: ayer hablamos de Valeria',score:0.8}];}};
  const llm={embed:async()=>{embedded++;return [1,0];},chat:async()=> 'Háblale tranqui y ve cómo va.'};
  const service=new ReplyService({repository:repo,historyStore,llm,
    config:{selfName:'Alex',topK:5,ragMinScore:0.38,replyReview:false}});
  const off=await service.previewReply(CONTACT,'¿Qué hago con Valeria? Me gusta','p',true,'off');
  assert.equal(off.rag.retrieval.strategy,'disabled_by_preview');
  assert.equal(embedded,0);
  const force=await service.previewReply(CONTACT,'¿Qué hago con Valeria? Me gusta','p',true,'force');
  assert.equal(force.rag.retrieval.strategy,'forced');
  assert.equal(embedded,1); assert.equal(searched,1);
  assert.equal(force.rag.retrieval.used,1);
  const memory=await service.previewReply(CONTACT,'¿Qué dijo Diego sobre Valeria?','p',true);
  assert.equal(memory.rag.retrieval.strategy,'semantic_and_lexical');
  assert.equal(embedded,2); assert.equal(searched,2);
});

test('Gating semántico: charla casual omite RAG y preguntas de hechos/acuerdos activan RAG', async () => {
  let embedded = 0, searched = 0;
  const repo = {
    listChatImports: () => [{ self: 'Tú', peer: 'Diego R' }],
    listMemories: () => [],
    recentPreview: () => [],
    listStyles: () => []
  };
  const historyStore = {
    search: async () => { searched++; return [{ body: 'Tú: ayer cenamos pizza', score: 0.8 }]; }
  };
  const llm = {
    embed: async () => { embedded++; return [1, 0]; },
    chat: async () => 'Tranqui'
  };
  const service = new ReplyService({
    repository: repo,
    historyStore,
    llm,
    config: { selfName: 'Alex', topK: 5, ragMinScore: 0.38, replyReview: false }
  });

  // Mensaje casual cotidiano
  const casual = await service.previewReply(CONTACT, 'oe sale dota o qué?', 'p', true);
  assert.equal(casual.rag.retrieval.strategy, 'casual_banter_skip');
  assert.equal(embedded, 0);
  assert.equal(searched, 0);

  // Mensaje con recuerdo explícito
  const recall = await service.previewReply(CONTACT, 'oe te acuerdas qué habíamos quedado?', 'p', true);
  assert.equal(recall.rag.retrieval.strategy, 'semantic_and_lexical');
  assert.equal(embedded, 1);
  assert.equal(searched, 1);
});

test('RAG: mayúscula de inicio de frase no es ancla salvo que el historial la use como nombre; palabras completas', () => {
  const isName = w => w === 'valdora';
  assert.deepEqual(queryAnchors('Listo, nos vemos', {isName}), []);
  assert.deepEqual(queryAnchors('Dale. Valdora a las 4?', {isName}), ['valdora']);
  assert.deepEqual(queryAnchors('Vamos con Valeria', {isName}), ['valeria'], 'a media frase la mayúscula sí cuenta');
  assert.deepEqual(queryAnchors('Listo'), ['listo'], 'sin historial se conserva el comportamiento previo');
  const rank = rankEvidence('Listo?', [{body:'A: Me alisto', score:0.2}], {anchors:['listo']});
  assert.equal(rank.results.length, 0, '"listo" no coincide con "alisto"');
});
