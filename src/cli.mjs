import { loadConfig, normalizePhone } from './config.mjs';
import { SqliteRepository } from './infra/sqlite-repository.mjs';
import { OllamaClient } from './infra/ollama.mjs';
import { QdrantHistoryStore } from './infra/qdrant-history-store.mjs';
import { MemoryService } from './app/memory-service.mjs';
import { ImportService } from './app/import-service.mjs';
import { ReplyService } from './app/reply-service.mjs';
import { MemoryConsolidationService } from './app/memory-consolidation-service.mjs';
import { BehaviorProfileService } from './app/behavior-profile-service.mjs';
import { Neo4jClient } from './infra/neo4j-client.mjs';
import { GraphSyncService } from './app/graph-sync-service.mjs';

const [command, ...argv] = process.argv.slice(2);
function flag(name, mandatory = true) {
  const at = argv.indexOf(`--${name}`);
  const value = at >= 0 ? argv[at+1] : undefined;
  if (mandatory && (!value || value.startsWith('--'))) throw new Error(`Se requiere --${name}`);
  return value;
}
async function main() {
  const config = loadConfig();
  const repository = new SqliteRepository(config.databasePath);
  const llm = new OllamaClient({baseUrl: config.ollamaUrl, chatModel: config.chatModel, embedModel: config.embedModel,
    modelContext: config.modelContext, maxTokens: config.maxTokens, temperature: config.temperature});
  const historyStore = config.memoryBackend === 'qdrant'
    ? new QdrantHistoryStore({baseUrl: config.qdrantUrl, collection: config.qdrantCollection, apiKey: config.qdrantApiKey, embedModel: config.embedModel})
    : repository;
  const neo4j = new Neo4jClient({
    baseUrl: config.neo4jUrl,
    user: config.neo4jUser,
    password: config.neo4jPassword,
    enabled: config.neo4jEnabled
  });
  const graphSync = new GraphSyncService({repository, neo4j, config});
  const memories = new MemoryService({repository, historyStore, llm});
  try {
    if (command === 'contacts') { console.table(repository.listContacts()); return; }
    if (!['import', 'preview', 'memory:add', 'memory:list', 'memory:backfill', 'persona:build', 'contact:erase'].includes(command))
      throw new Error('Usa: import | preview | memory:add | memory:list | memory:backfill | persona:build | contact:erase | contacts');
    const contact = normalizePhone(flag('contact'));
    if (!config.allowedContacts.has(contact)) throw new Error('Añade el contacto a ALLOWED_CONTACTS en .env');
    if (command === 'contact:erase') {
      if (flag('confirm') !== 'BORRAR') throw new Error('Requiere --confirm BORRAR; irreversible');
      await memories.eraseContact(contact); console.log('Datos del contacto borrados de SQLite y del índice vectorial'); return;
    }
    if (command === 'import') {
      const service = new ImportService({repository, historyStore, llm, neo4j, graphSync, config});
      const result = await service.importFile({path: flag('file'), contact, self: flag('self'), peer: flag('peer'),
        onProgress: (count,total) => console.log(`Embeddings: ${count}/${total}`)});
      console.log(JSON.stringify({...result, indexedChunksTotal: await historyStore.countHistory(contact)}, null, 2));
      if (neo4j.enabled) {
        console.log('Esperando sincronización de grafo...');
        while (graphSync.isProcessing || graphSync.queue.length > 0) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }
    if (command === 'preview') {
      const service = new ReplyService({repository, historyStore, llm, config, neo4j});
      const mode = flag('mode', false) ?? 'reply';
      if (mode === 'reply') console.log(await service.generate(contact, flag('text')));
      else if (mode === 'memory_query') console.log(JSON.stringify(await service.queryMemory(contact, flag('text')), null, 2));
      else throw new Error('Usa --mode reply o --mode memory_query');
    }
    if (command === 'memory:add') {
      const id = await memories.add(contact, flag('fact'));
      console.log(`Memoria guardada #${id}`);
    }
    if (command === 'memory:list') console.table([...repository.listMemories(contact),...repository.listLearnedMemories(contact)]);
    if (command === 'persona:build') {
      const result=await new BehaviorProfileService({repository,llm,config}).rebuild(contact);
      console.log(JSON.stringify(result,null,2));
    }
    if (command === 'memory:backfill') {
      const extractor=new MemoryConsolidationService({repository,llm,config});
      let inserted=0, processed=0;
      const max=Number(flag('max',false) ?? 240);
      if(!Number.isSafeInteger(max) || max<1 || max>100000)throw new Error('--max debe ser un entero entre 1 y 100000');
      for(let offset=0;offset<max;offset+=16) {
        const batch=repository.getImportedBatch(contact,offset,Math.min(16,max-offset));
        if(!batch.length)break;
        const result=await extractor.ingest(contact,batch,{source:'import'});
        inserted+=result.inserted;processed+=batch.length;
        console.log(`Mensajes revisados: ${processed}; nuevos recuerdos: ${inserted}`);
      }
    }
  } finally { repository.close(); }
}
main().catch(err => {console.error(`Error: ${err.message}`); process.exitCode = 1;});
