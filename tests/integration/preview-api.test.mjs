import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../../src/transport/http-server.mjs';
import { ReplyService } from '../../src/app/reply-service.mjs';

const PHONE = '51999999999';
const TOKEN = 'A'.repeat(48);
const headers = {'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json'};
const config = {adminToken:TOKEN, waProvider:'web', wa:{}, allowedContacts:new Set([PHONE]),
  chatModel:'qwen3.5:9b', embedModel:'embeddinggemma'};

async function withPreview(error, callback) {
  const server = createHttpServer({config, repository:{}, replies:{generate: async () => {throw error;}}});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/preview`,
      {method:'POST',headers,body:JSON.stringify({contact:PHONE,text:'¿Recuerdas la conversación?'})});
    await callback(response);
  } finally {await new Promise(resolve => server.close(resolve));}
}

test('preview identifica modelo conversacional ausente y no expone texto interno', async () => {
  await withPreview(Object.assign(new Error('Ollama 404: secret debug'), {previewStage:'chat'}), async response => {
    assert.equal(response.status,503);
    const body = await response.json();
    assert.equal(body.code,'CHAT_MODEL_NOT_FOUND');
    assert.equal(body.stage,'chat');
    assert.match(body.hint,/ollama pull qwen3\.5:9b/);
    assert.doesNotMatch(JSON.stringify(body), /secret debug/);
  });
});

test('preview identifica búsqueda Qdrant fallida', async () => {
  await withPreview(Object.assign(new Error('Qdrant HTTP 500: secret debug'), {previewStage:'search'}), async response => {
    assert.equal(response.status,502);
    const body = await response.json();
    assert.equal(body.code,'MEMORY_SEARCH_FAILED');
    assert.doesNotMatch(JSON.stringify(body), /secret debug/);
  });
});

test('preview devuelve 504 si el modelo agota el tiempo', async () => {
  await withPreview(Object.assign(new Error('The operation was aborted due to timeout'), {name:'TimeoutError', previewStage:'chat'}), async response => {
    assert.equal(response.status,504);
    assert.equal((await response.json()).code,'PREVIEW_TIMEOUT');
  });
});

test('ReplyService identifica correctamente la etapa del fallo', async () => {
  const repository = {listStyles: () => [],listMemories:()=>[],recent:()=>[]};
  const store = {search: async()=>[]};
  const fail = (message) => {throw new Error(message)};
  const llm = {embed:async()=>[1,0],chat:async()=>fail('Ollama 404')};
  const service = new ReplyService({repository,historyStore:store,llm,config:{topK:5,selfName:'Alex'}});
  await assert.rejects(service.generate(PHONE,'¿Qué hablamos ayer?'),e=>e.previewStage==='chat');
  llm.embed = async()=>fail('Embeddings failed');
  await assert.rejects(service.generate(PHONE,'¿Qué hablamos ayer?'),e=>e.previewStage==='embed');
  llm.embed = async()=>[1,0];
  store.search = async()=>fail('Search failed');
  await assert.rejects(service.generate(PHONE,'¿Qué hablamos ayer?'),e=>e.previewStage==='search');
});

test('perfil de fallo content es visible solo en debug y nunca guarda un turno',async()=>{
 let saved=0;
 const error=Object.assign(new Error('contenido privado'),{previewStage:'content',replyProfile:{totalMs:12,stages:[{stage:'content',ms:12}],calls:[],decisions:{}},replyArtifacts:{content:'privado'}});
 const server=createHttpServer({config,repository:{savePreviewTurn:()=>saved++},replies:{previewReply:async()=>{throw error;}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  for(const debug of [false,true]){
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/preview`,{method:'POST',headers,
    body:JSON.stringify({contact:PHONE,text:'Hola',debug_rag:debug})});
   const body=await response.json();
   assert.equal(response.status,502);assert.equal(body.stage,'content');
   assert.equal(Boolean(body.profile),debug);
   assert.doesNotMatch(JSON.stringify(body),/privado|replyArtifacts/);
  }
  assert.equal(saved,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('rechazo de revisión y salida inválida no se reportan como caída de Ollama', async () => {
  const {DraftRejectedError}=await import('../../src/app/response-validation-service.mjs');
  await withPreview(Object.assign(new DraftRejectedError('borrador','inventa'), {previewStage:'review'}), async response => {
    assert.equal(response.status,422);
    assert.equal((await response.json()).code,'REVIEW_REJECTED');
  });
  await withPreview(Object.assign(new Error('Revisión semántica inválida'), {previewStage:'review'}), async response => {
    assert.equal(response.status,502);
    assert.equal((await response.json()).code,'MODEL_OUTPUT_INVALID');
  });
});

test('preview no aprobado se devuelve marcado y no se guarda en el hilo; recent_messages inválido es 422', async () => {
  const saved=[];
  const replies={previewReply:async()=>({answer:'borrador',approved:false,reviewReason:'inventa un plan'})};
  const server=createHttpServer({config,repository:{savePreviewTurn:(...a)=>saved.push(a)},replies});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/preview`;
    let response=await fetch(url,{method:'POST',headers,body:JSON.stringify({contact:PHONE,text:'Hay que organizar algo'})});
    const body=await response.json();
    assert.equal(response.status,200);
    assert.deepEqual([body.answer,body.approved,body.review_reason,body.saved],['borrador',false,'inventa un plan',false]);
    assert.equal(saved.length,0);
    response=await fetch(url,{method:'POST',headers,body:JSON.stringify({contact:PHONE,text:'Hola',recent_messages:[{additionalProp1:{}}]})});
    assert.equal(response.status,422);
    assert.equal((await response.json()).code,'INVALID_RECENT_MESSAGES');
  } finally {await new Promise(resolve=>server.close(resolve));}
});
