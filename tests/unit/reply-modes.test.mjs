import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplyService} from '../../src/app/reply-service.mjs';
import {createHttpServer} from '../../src/transport/http-server.mjs';

const PHONE = '51999999999';
const TOKEN = 'T'.repeat(48);
const config = {adminToken:TOKEN, waProvider:'web', wa:{}, selfName:'Alex', topK:3,
  allowedContacts:new Set([PHONE]), chatModel:'qwen3.5:9b', embedModel:'embeddinggemma'};
function mockService() {
  const logs = [];
  const preview = [];
  const repository = {
    listStyles: () => ['Oe sí, mañana vemos jaja', 'nos vemos al toque'],
    listMemories: () => [{id:1,fact:'Acordaron un partido de fútbol el sábado'}],
    recent: () => [{side:'incoming',text:'oye'}],
    recentPreview: (phone,session,limit=16) => preview.filter(m=>m.contact===phone && m.session===session).slice(-limit),
    savePreviewTurn: (phone,session,input,answer) => {preview.push({contact:phone,session,side:'peer',text:input},{contact:phone,session,side:'self',text:answer});},
    listChatImports: () => [{self:'Tú',peer:'Diego R'}]
  };
  const historyStore = {search: async(contact,vector,topK) => {
    assert.equal(contact,PHONE); assert.equal(topK,12);
    return [{score:0.89,kind:'history',body:'01/01/2026 · Tú: El sábado jugamos fútbol\n01/01/2026 · Diego R: Dale'}];
  }};
  const llm = {embed: async text => [0.1,0.2],chat: async (system, prompt) => {
    logs.push({system, prompt});
    return system.includes('BORRADOR') ? '🤖 Asistente IA de Alex: Oe dale, el sábado vemos jaja' :
      'Quedaron en jugar fútbol el sábado [H1].';
  }};
  return {service:new ReplyService({repository,historyStore,llm,config}), logs, repository, preview};
}

test('reply produce borradores naturales sin marca IA, y toma solo estilo self', async()=>{
  const {service,logs} = mockService();
  assert.equal(await service.generate(PHONE,'¿Qué hacemos el sábado?'), 'Oe dale, el sábado vemos jaja');
  assert.match(logs[0].system,/PERFIL DE ESTILO/);
  assert.match(logs[0].system,/"Tú" = mensajes del titular/);
  assert.match(logs[0].system,/"Diego R" = mensajes del interlocutor/);
  assert.match(logs[0].prompt,/MENSAJE NUEVO DEL INTERLOCUTOR/);
});

test('memory_query interpreta pregunta como self, devuelve evidencias y no imita estilo', async()=>{
  const {service,logs} = mockService();
  const r = await service.queryMemory(PHONE,'¿Qué acordamos hacer el sábado?');
  assert.equal(r.answer,'Quedaron en jugar fútbol el sábado [H1].');
  assert.equal(r.evidence[0].id,'M1');
  assert.equal(r.evidence[1].id,'H1');
  assert.equal(r.evidence[1].score,0.89);
  assert.match(r.evidence[1].excerpt,/fútbol/);
  assert.match(logs[0].system,/La pregunta viene de Alex, NO del interlocutor/);
  assert.match(logs[0].prompt,/AUTORES EN EL TXT: "Tú"/);
  assert.doesNotMatch(logs[0].prompt,/EJEMPLOS DE CÓMO ESCRIBE/);
});

test('preview separa modos, mantiene modo reply por defecto, y nunca envía', async()=>{
  const {service, repository} = mockService();
  const server = createHttpServer({config, repository, replies:service});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/preview`;
  const headers = {'Authorization':`Bearer ${TOKEN}`,'content-type':'application/json'};
  const send = data => fetch(base,{method:'POST',headers,body:JSON.stringify({contact:PHONE,text:'¿Qué hablamos?',...data})});
  try {
    const reply = await send({});
    assert.equal(reply.status,200);
    assert.deepEqual(await reply.json(),{mode:'reply',answer:'Oe dale, el sábado vemos jaja',approved:true,sent:false,session_id:'default',saved:true});
    const query = await send({mode:'memory_query'});
    assert.equal(query.status,200);
    const r=await query.json();
    assert.equal(r.mode,'memory_query'); assert.equal(r.sent,false);
    assert.equal(r.evidence.length,2);
    assert.match(r.answer, /\[H1\]/);
    const invalid = await send({mode:'send_now'});
    assert.equal(invalid.status,422);
    assert.equal((await invalid.json()).code,'INVALID_PREVIEW_MODE');
  } finally {await new Promise(resolve=>server.close(resolve));}
});


test('API valida rag_policy y permite comparar retrieval auto/force/off en reply',async()=>{
  const {service, repository} = mockService();
  const server = createHttpServer({config, repository, replies:service});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/preview`;
  const headers={'Authorization':`Bearer ${TOKEN}`,'content-type':'application/json'};
  const send=async(data)=>{
    const res=await fetch(base,{method:'POST',headers,body:JSON.stringify({contact:PHONE,
      session_id:'comparacion',text:'¿Qué hago con Valeria? Me gusta',save:false,debug_rag:true,...data})});
    return {status:res.status,body:await res.json()};
  };
  try {
    assert.equal((await send({rag_policy:'random'})).status,422);
    assert.equal((await send({mode:'memory_query',rag_policy:'off'})).status,422);
    const auto=await send({});
    assert.equal(auto.status,200);
    assert.equal(auto.body.rag.retrieval.strategy,'not_needed_for_general_advice');
    assert.equal(auto.body.saved,false);
    const forced=await send({rag_policy:'force'});
    assert.equal(forced.status,200);
    assert.equal(forced.body.rag.retrieval.strategy,'forced');
    assert.equal(forced.body.rag.retrieval.used,0); // El mock solo devuelve fútbol, no Valeria.
  } finally {await new Promise(resolve=>server.close(resolve));}
});
