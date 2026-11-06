import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {ReplyService} from '../../src/app/reply-service.mjs';
import {createHttpServer} from '../../src/transport/http-server.mjs';

const A='51999999999', B='51888888888', TOKEN='T'.repeat(48);
const config={adminToken:TOKEN, allowedContacts:new Set([A,B]), selfName:'Alex',
  waProvider:'web', topK:5, chatModel:'qwen3.5:9b', embedModel:'embeddinggemma'};

async function fixture(callback) {
  const dir=mkdtempSync(join(tmpdir(),'chat-memory-preview-'));
  const path=join(dir,'memory.sqlite');
  const repo=new SqliteRepository(path);
  const prompts=[];
  let shouldFail=false;
  const llm={embed:async()=>[1,0],chat:async(system,prompt)=>{
    prompts.push({system,prompt});
    if(shouldFail) throw new Error('Modelo indisponible');
    if(system.includes('herramienta privada')) return 'El chat habla sobre fútbol [H1].';
    if(prompt.includes('Diego R: ¿Me prestas dinero?') && prompt.includes('Tú: No, no te presto.') && prompt.includes('¿Por qué?'))
      return 'Porque ahora no tengo plata.';
    return 'No, no te presto.';
  }};
  const service=new ReplyService({repository:repo,historyStore:{search:async()=>[{body:'Tú: ajá\nDiego R: hola',score:0.8}]},llm,config});
  // Evitar fragmentos de historiales reales en estas pruebas.
  repo.recordChatImport({contact:A, importHash:'h', fileName:'chat.txt', self:'Tú', peer:'Diego R', messages:2, chunks:1});
  const server=createHttpServer({config,repository:repo,replies:service});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={'authorization':`Bearer ${TOKEN}`,'content-type':'application/json'};
  const send=async(path,method='GET',data)=>{
    const response=await fetch(base+path,{method,headers, ...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json()};
  };
  try {await callback({send, repo, prompts, path, setFail:bool=>shouldFail=bool});}
  finally {await new Promise(resolve=>server.close(resolve));repo.close();rmSync(dir,{recursive:true,force:true});}
}

test('preview mantiene contexto para ¿Por qué?, sin contaminar WhatsApp ni Qdrant',async()=>fixture(async({send,repo,prompts,path})=>{
  const first=await send('/api/preview','POST',{contact:A,mode:'reply',text:'¿Me prestas dinero?'});
  assert.equal(first.status,200);
  assert.equal(first.body.answer,'No, no te presto.');
  assert.equal(first.body.saved,true);
  const second=await send('/api/preview','POST',{contact:A,mode:'reply',text:'¿Por qué?'});
  assert.equal(second.status,200);
  assert.equal(second.body.answer,'Porque ahora no tengo plata.');
  assert.match(prompts[1].prompt,/Diego R: ¿Me prestas dinero\?/);
  assert.match(prompts[1].prompt,/Tú: No, no te presto\./);
  assert.equal(repo.recent(A).length,0,'WhatsApp real debe quedar intacto');
  assert.equal(repo.countHistory(A),0,'el índice RAG permanece intacto');
  const hist=await send(`/api/preview/history?contact=${A}`);
  assert.equal(hist.status,200);
  assert.deepEqual(hist.body.messages.map(m=>m.side),['peer','self','peer','self']);
  assert.deepEqual(hist.body.messages.map(m=>m.text),['¿Me prestas dinero?','No, no te presto.','¿Por qué?','Porque ahora no tengo plata.']);
  const reopened = new SqliteRepository(path);
  assert.equal(reopened.recentPreview(A,'default').length,4,'persistencia tras reinicio de aplicación');
  reopened.close();
}));

test('sesiones y contactos aislados, memory_query y save=false no escriben',async()=>fixture(async({send,repo,prompts})=>{
  await send('/api/preview','POST',{contact:A,session_id:'prueba1',text:'¿Me prestas dinero?'});
  const other=await send('/api/preview','POST',{contact:A,session_id:'prueba2',text:'¿Por qué?'});
  assert.equal(other.body.answer,'No, no te presto.');
  const diff=await send('/api/preview','POST',{contact:B,session_id:'prueba1',text:'¿Por qué?'});
  assert.equal(diff.body.answer,'No, no te presto.');
  assert.equal(repo.recentPreview(A,'prueba1').length,2);
  assert.equal(repo.recentPreview(A,'prueba2').length,2);
  assert.equal(repo.recentPreview(B,'prueba1').length,2);
  const noSave=await send('/api/preview','POST',{contact:A,session_id:'prueba1',save:false,text:'¿Por qué?'});
  assert.equal(noSave.body.saved,false);
  assert.equal(noSave.body.answer,'Porque ahora no tengo plata.');
  assert.equal(repo.recentPreview(A,'prueba1').length,2);
  const query=await send('/api/preview','POST',{contact:A,session_id:'prueba1',mode:'memory_query',text:'¿Qué hablamos?'});
  assert.equal(query.body.sent,false);
  assert.equal(repo.recentPreview(A,'prueba1').length,2);
  assert.doesNotMatch(prompts.at(-1).prompt,/HILO ANTERIOR DE ESTA SIMULACIÓN/);
  const remove=await send(`/api/preview/history?contact=${A}&session_id=prueba1`,'DELETE');
  assert.equal(remove.body.deleted,2);
  assert.equal(repo.recentPreview(A,'prueba1').length,0);
  assert.equal(repo.recentPreview(A,'prueba2').length,2);
  assert.equal(repo.recentPreview(B,'prueba1').length,2);
}));

test('errores de generación no dejan turnos incompletos; validación segura de sesión y permisos',async()=>fixture(async({send,repo,setFail})=>{
  setFail(true);
  const result=await send('/api/preview','POST',{contact:A,text:'Hola'});
  assert.equal(result.status,502);
  assert.equal(repo.recentPreview(A,'default').length,0);
  setFail(false);
  assert.equal((await send('/api/preview','POST',{contact:A,session_id:'../trampa',text:'Hola'})).status,422);
  assert.equal((await send('/api/preview','POST',{contact:A,text:'Hola',save:'yes'})).status,422);
  assert.equal((await send(`/api/preview/history?contact=${A}&session_id=../trampa`)).status,422);
  assert.equal((await send('/api/preview/history?contact=51777777777')).status,403);
  assert.equal((await send(`/api/preview/history?contact=${A}&limit=1000`)).status,422);
}));

test('borrado de contacto borra también sesiones de preview',async()=>fixture(async({send,repo})=>{
  await send('/api/preview','POST',{contact:A,text:'Hola'});
  repo.eraseContact(A);
  assert.equal(repo.recentPreview(A,'default').length,0);
}));

test('preview nuevo no hereda mensajes ajenos al hilo salvo petición explícita', async()=>fixture(async({send,repo,prompts})=>{
  repo.saveConversation(A, 'incoming', 'Tema del otro día');
  await send('/api/preview', 'POST', {contact:A, text:'Hola', save:false, rag_policy:'off'});
  assert.doesNotMatch(prompts.at(-1).prompt, /Tema del otro día/);
  await send('/api/preview', 'POST', {contact:A, text:'Hola', save:false, rag_policy:'off', include_recent:true});
  assert.match(prompts.at(-1).prompt, /Tema del otro día/);
}));
