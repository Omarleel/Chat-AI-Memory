import { loadConfig } from './config.mjs';
import { SqliteRepository } from './infra/sqlite-repository.mjs';
import { OllamaClient } from './infra/ollama.mjs';
import { QdrantHistoryStore } from './infra/qdrant-history-store.mjs';
import { Neo4jClient } from './infra/neo4j-client.mjs';
import { MemoryService } from './app/memory-service.mjs';
import { ImportService } from './app/import-service.mjs';
import { GraphSyncService } from './app/graph-sync-service.mjs';
import { WhatsAppCloudGateway } from './infra/whatsapp.mjs';
import { WhatsAppWebGateway } from './infra/whatsapp-web.mjs';
import { enqueueIncoming } from './app/inbound-service.mjs';
import { ReplyService } from './app/reply-service.mjs';
import { TrainingService } from './app/training-service.mjs';
import { ReviewerCalibrationService } from './app/reviewer-calibration-service.mjs';
import { BurstLabelingService } from './app/burst-labeling-service.mjs';
import { ModelService } from './app/model-service.mjs';
import { KnowledgeGraphService } from './app/knowledge-graph-service.mjs';
import { QueueWorker } from './app/queue-worker.mjs';
import { createHttpServer } from './transport/http-server.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseWhatsAppTxt, selectDirectHistory, extractStylePairs } from './domain/history.mjs';

const config = loadConfig();
if (config.waProvider === 'cloud' && config.autoSend && (!config.wa.accessToken || !config.wa.phoneId))
  throw new Error('AUTO_SEND=true requiere WA_ACCESS_TOKEN y WA_PHONE_NUMBER_ID');
const repository = new SqliteRepository(config.databasePath);
const llm = new OllamaClient({baseUrl: config.ollamaUrl, chatModel: config.chatModel, embedModel: config.embedModel,
  modelContext: config.modelContext, maxTokens: config.maxTokens, temperature: config.temperature, repeatPenalty: config.repeatPenalty,
  presencePenalty: config.presencePenalty, frequencyPenalty: config.frequencyPenalty});
const historyStore = config.memoryBackend === 'qdrant'
  ? new QdrantHistoryStore({baseUrl: config.qdrantUrl, collection: config.qdrantCollection, apiKey: config.qdrantApiKey, embedModel: config.embedModel})
  : repository;
const neo4j = new Neo4jClient({
  baseUrl: config.neo4jUrl,
  user: config.neo4jUser,
  password: config.neo4jPassword,
  enabled: config.neo4jEnabled
});
if (config.neo4jEnabled) {
  neo4j.initSchema().catch(err => console.warn('Neo4j initSchema:', err.message));
}
const memories = new MemoryService({repository, historyStore, llm});
const knowledge = new KnowledgeGraphService({repository, neo4j: config.neo4jEnabled ? neo4j : null,
  llm: config.reasoningModel ? llm.asReasoner(config.reasoningModel) : llm, config});
const graphSync = new GraphSyncService({repository, neo4j, config, knowledge});
const imports = new ImportService({repository, historyStore, llm, neo4j, graphSync, config});
const replies = new ReplyService({repository, historyStore, llm, config, neo4j, knowledge});
const training = new TrainingService({repository, config,
  calibrator: config.reasoningModel ? new ReviewerCalibrationService({llm: llm.asReasoner(config.reasoningModel), config}) : null,
  burstLabeler: config.reasoningModel ? new BurstLabelingService({repository, llm: llm.asReasoner(config.reasoningModel), config}) : null});
const models = new ModelService({catalog: llm, config});

// Backfill automático de mensajes estructurados si faltan en SQLite
for (const contact of config.allowedContacts) {
  try {
    const existingImports = repository.listChatImports(contact);
    for (const imp of existingImports) {
      if (repository.countImportedMessages(contact, imp.importHash) === 0) {
        const candidates = [
          resolve('./imports', imp.fileName),
          resolve('/imports', imp.fileName),
          resolve(process.env.UPLOAD_DIR ?? '/uploads', imp.fileName)
        ];
        for (const filePath of candidates) {
          try {
            const raw = await readFile(filePath, 'utf8');
            const parsed = parseWhatsAppTxt(raw);
            const selected = selectDirectHistory(parsed, imp.self, imp.peer);
            repository.saveImportedMessages(contact, imp.importHash, selected);
            // Los mensajes con índices antiguos siguen consultables vía FTS5;
            // regenerar vectores mediante una importación controlada.
            repository.saveStylePairs(contact, extractStylePairs(selected, imp.self));
            console.log(`Backfill estructurado: ${selected.length} mensajes guardados para ${imp.fileName}`);
            break;
          } catch {
            // Siguiente candidato
          }
        }
      }
    }

    // Inicializar personalidad para ambas partes si aún no existe
    const existingPersonas = repository.getPersonas?.(contact);
    if (!existingPersonas?.self || !existingPersonas?.peer) {
      const imp = existingImports[0];
      const selfName = imp?.self ?? config.selfName;
      const peerName = imp?.peer ?? 'el interlocutor';
      const created = repository.buildAndSavePersonas?.(contact, selfName, peerName);
      if (created) {
        console.log(`Perfil de personalidad generado para ${contact} (${selfName} / ${peerName})`);
      }
    }
  } catch (err) {
    console.warn('Nota de backfill:', err.message);
  }
}

const whatsapp = config.waProvider === 'web'
  ? new WhatsAppWebGateway(config.waWeb, {onMessage: event => enqueueIncoming({repository, config}, event)})
  : new WhatsAppCloudGateway(config.wa);
if (config.waProvider === 'web') await whatsapp.start();
const worker = new QueueWorker({repository, replies, whatsapp, config});
const server = createHttpServer({config, repository, worker, replies, memories, imports, whatsapp, training, models, knowledge});
const timer = setInterval(() => worker.tick().catch(err => console.error('Worker:', err.message)), 1500);
server.listen(config.port, config.host, () => {
  console.log(`Asistente local en http://${config.host}:${config.port}`);
  console.log(`WhatsApp: ${config.waProvider}; modelo: ${config.chatModel}; envío automático: ${config.autoSend}; allowlist: ${config.allowedContacts.size}`);
});
async function stop() { clearInterval(timer); whatsapp.stop?.(); await new Promise(resolve => server.close(resolve)); repository.close(); }
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
