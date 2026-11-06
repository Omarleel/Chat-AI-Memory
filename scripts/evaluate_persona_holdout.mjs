// Evaluación de ablation sin persistir ni enviar; produces JSONL para rating humano ciego.
// node --env-file=.env scripts/evaluate_persona_holdout.mjs --file holdout.jsonl --base qwen3.5:9b --adapted mi-lora
// Cada caso: {contact,input,recent_messages:[{role:'user',content:'...'}],reference,heldout_message_ids:[...]}
// NO indexar respuestas holdout en SQLite/Qdrant/Neo4j, o se contaminará la evaluación.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadConfig} from '../src/config.mjs';
import {SqliteRepository} from '../src/infra/sqlite-repository.mjs';
import {QdrantHistoryStore} from '../src/infra/qdrant-history-store.mjs';
import {OllamaClient} from '../src/infra/ollama.mjs';
import {ReplyService} from '../src/app/reply-service.mjs';

const args=process.argv.slice(2);
const flag=name=>args[args.indexOf(`--${name}`)+1];
const file=flag('file'),base=flag('base'),adapted=flag('adapted');
if(!file || !base || !adapted || file.startsWith('--'))
  throw new Error('Uso: --file <holdout.jsonl> --base <ollama-model> --adapted <ollama-lora>');
const config=loadConfig(); const repo=new SqliteRepository(config.databasePath);
const store=config.memoryBackend==='sqlite'?repo:new QdrantHistoryStore({baseUrl:config.qdrantUrl,
  collection:config.qdrantCollection,apiKey:config.qdrantApiKey,embedModel:config.embedModel});
const rows=(await readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const results=[];
try {
 for(let i=0;i<rows.length;i++) {
  const row=rows[i];
  if(!config.allowedContacts.has(row.contact))throw new Error('Caso con contacto no autorizado');
  if(!row.input || !Array.isArray(row.heldout_message_ids) || !row.heldout_message_ids.length)
    throw new Error('Cada caso requiere input y heldout_message_ids no vacíos');
  const existing=repo.db.prepare(`SELECT id FROM imported_messages WHERE contact=? AND id IN (
    ${row.heldout_message_ids.map(()=>'?').join(',')})`).all(row.contact,...row.heldout_message_ids);
  if(existing.length)throw new Error('Holdout presente en SQLite; excluye también esos mensajes de Qdrant antes de evaluar');
  const conditions=[['base_off',base,'off'],['adapted_off',adapted,'off'],['adapted_auto',adapted,'auto']];
  for(const [variant,model,policy] of conditions) {
   const llm=new OllamaClient({baseUrl:config.ollamaUrl,chatModel:model,
    embedModel:config.embedModel,modelContext:config.modelContext,maxTokens:config.maxTokens,
    temperature:config.temperature,repeatPenalty:config.repeatPenalty});
   const replies=new ReplyService({repository:repo,historyStore:store,llm,
    config:{...config,replyReview:false,autoMemoryLearn:false}});
   const res=await replies.previewReply(row.contact,row.input,`holdout_${i}`,false,policy,
    {recentMessages:row.recent_messages ?? []});
   results.push({caseId:i,variant,response:res.answer});
  }
 }
 // Mezclados para evaluación ciega; key reversible para análisis, no citas de contenido en logs.
 const output=rows.map((row,i)=>({caseId:i,reference:row.reference ?? null,
   variants:results.filter(r=>r.caseId===i).map(r=>({variant:r.variant,answer:r.response}))}));
 const filename=`persona-evaluation-${createHash('sha256').update(file).digest('hex').slice(0,8)}.json`;
 await writeFile(filename,JSON.stringify(output,null,2));
 console.log(`Generados ${results.length} borradores para ${rows.length} casos; resultados privados en ${filename}.`);
 console.log('No interpreta estos resultados como métrica de identidad. Usa evaluación ciega y comprueba fuga Qdrant.');
}finally{repo.close();}
