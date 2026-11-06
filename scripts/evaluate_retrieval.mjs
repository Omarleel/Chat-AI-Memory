// node --env-file=.env scripts/evaluate_retrieval.mjs --file ./evaluation.jsonl
// Cada línea: {"contact":"519...", "question":"...", "expected_message_ids":["msg_..."]}
// Ground truth externo al índice de respuestas (nunca anotar con el mismo LLM evaluado).
import {readFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.mjs';
import {SqliteRepository} from '../src/infra/sqlite-repository.mjs';
import {QdrantHistoryStore} from '../src/infra/qdrant-history-store.mjs';
import {OllamaClient} from '../src/infra/ollama.mjs';
import {RetrievalService} from '../src/app/retrieval-service.mjs';
const file=process.argv[process.argv.indexOf('--file')+1];
if(!file || file.startsWith('--'))throw new Error('Uso: --file casos.jsonl');
const config=loadConfig();
const repo=new SqliteRepository(config.databasePath);
const store=config.memoryBackend==='sqlite'?repo:new QdrantHistoryStore({baseUrl:config.qdrantUrl,
  collection:config.qdrantCollection,apiKey:config.qdrantApiKey,embedModel:config.embedModel});
const llm=new OllamaClient({baseUrl:config.ollamaUrl,chatModel:config.chatModel,embedModel:config.embedModel,
  modelContext:config.modelContext,maxTokens:config.maxTokens,temperature:config.temperature});
let covered=0,total=0,matched=0,errors=0;
try {
  const cases=(await readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  for(const row of cases){
    if(!config.allowedContacts.has(row.contact))throw new Error('Caso de contacto no autorizado');
    const expected=new Set(row.expected_message_ids ?? []);
    if(!expected.size) continue;
    try{
      const result=await new RetrievalService({repository:repo,historyStore:store,llm,config})
        .search({contact:row.contact,question:row.question,limit:10});
      const found=new Set(result.results.flatMap(r=>r.messageIds ?? []));
      matched+=Number([...expected].some(id=>found.has(id)));
      for(const id of expected){covered++;if(found.has(id))total++;}
    }catch(e){errors++;console.error('Caso fallido:',e.message);}
  }
  console.log(JSON.stringify({cases:cases.length,evaluated:cases.length-errors,
    hitAt10:matched/Math.max(1,cases.length-errors),recallAt10:total/Math.max(1,covered),errors},null,2));
}finally{repo.close();}
