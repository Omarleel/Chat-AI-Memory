import { resolve } from 'node:path';

function integer(name, fallback, min = 1, max = 1000000) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} debe ser entero entre ${min} y ${max}`);
  return n;
}
function real(name, fallback, min, max) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} debe estar entre ${min} y ${max}`);
  return n;
}
function bool(name) { return (process.env[name] ?? 'false').toLowerCase() === 'true'; }
export function normalizePhone(value) {
  const phone = String(value ?? '').replace(/[\s()+-]/g, '');
  if (!/^\d{8,15}$/.test(phone)) throw new Error('El teléfono debe tener entre 8 y 15 dígitos internacionales');
  return phone;
}
export function loadConfig() {
  const replyPipeline=process.env.REPLY_PIPELINE ?? 'direct';
  if(!['direct','content_style','auto'].includes(replyPipeline))throw new Error('REPLY_PIPELINE debe ser direct, content_style o auto');
  const reviewShortApproval=process.env.REVIEW_SHORT_APPROVAL ?? 'off';
  if(!['off','shape'].includes(reviewShortApproval))throw new Error('REVIEW_SHORT_APPROVAL debe ser off o shape');
  const reviewMode=process.env.REVIEW_MODE ?? 'judgment';
  if(!['judgment','closed'].includes(reviewMode))throw new Error('REVIEW_MODE debe ser judgment o closed');
  // rules: el escritor recibe reglas y contexto; training: el mismo prompt con que se entrenó el modelo de estilo;
  // auto: training si el modelo declara ese prompt como SYSTEM (lo hace el despliegue de un entrenamiento).
  const writerPrompt=process.env.REPLY_WRITER_PROMPT ?? 'auto';
  if(!['auto','rules','training'].includes(writerPrompt))throw new Error('REPLY_WRITER_PROMPT debe ser auto, rules o training');
  if(replyPipeline!=='direct' && !process.env.REASONING_MODEL?.trim())throw new Error(`${replyPipeline} requiere REASONING_MODEL`);
  const allow = (process.env.ALLOWED_CONTACTS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(normalizePhone);
  const ollama = new URL(process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434');
  const qdrant = new URL(process.env.QDRANT_URL ?? 'http://127.0.0.1:6333');
  if (!['http:', 'https:'].includes(qdrant.protocol)) throw new Error('QDRANT_URL inválida');
  const memoryBackend = process.env.MEMORY_BACKEND ?? 'qdrant';
  if (!['qdrant', 'sqlite'].includes(memoryBackend)) throw new Error('MEMORY_BACKEND debe ser qdrant o sqlite');
  if (!['http:', 'https:'].includes(ollama.protocol)) throw new Error('OLLAMA_URL inválida');
  const waProvider = (process.env.WA_PROVIDER ?? 'web').trim().toLowerCase();
  if (!['web', 'cloud'].includes(waProvider)) throw new Error('WA_PROVIDER debe ser web o cloud');
  const neo4jEnabled = bool('NEO4J_ENABLED') || Boolean(process.env.NEO4J_URL);
  let neo4jUrl = 'http://127.0.0.1:7474';
  if (process.env.NEO4J_URL) {
    const neo4j = new URL(process.env.NEO4J_URL);
    if (!['http:', 'https:'].includes(neo4j.protocol)) throw new Error('NEO4J_URL inválida');
    neo4jUrl = neo4j.toString().replace(/\/$/, '');
  }
  return Object.freeze({
    host: process.env.HOST || '127.0.0.1', port: integer('PORT', 3000, 1, 65535),
    databasePath: resolve(process.env.DB_PATH ?? './data/memory.sqlite'),
    memoryBackend, qdrantUrl: qdrant.toString().replace(/\/$/, ''),
    qdrantCollection: process.env.QDRANT_COLLECTION ?? 'whatsapp_memory',
    qdrantApiKey: process.env.QDRANT_API_KEY ?? '',
    neo4jEnabled,
    neo4jUrl,
    neo4jUser: process.env.NEO4J_USER ?? 'neo4j',
    neo4jPassword: process.env.NEO4J_PASSWORD ?? 'secretpassword',
    adminToken: process.env.ADMIN_TOKEN ?? '', selfName: (process.env.SELF_DISPLAY_NAME ?? 'Mi usuario').trim().slice(0, 60),
    allowedContacts: new Set(allow), autoSend: bool('AUTO_SEND'), waProvider,
    waWeb: {authDir: resolve(process.env.WA_WEB_AUTH_DIR ?? './data/wa-session'),
      printQr: (process.env.WA_WEB_PRINT_QR ?? 'true').toLowerCase() !== 'false'},
    ollamaUrl: ollama.toString().replace(/\/$/, ''),
    chatModel: process.env.LLM_MODEL ?? 'qwen3.5:9b', embedModel: process.env.EMBED_MODEL ?? 'embeddinggemma',
    modelContext: integer('MODEL_CONTEXT', 8192, 1024, 262144), temperature: real('MODEL_TEMPERATURE', 0.35, 0, 2),
    repeatPenalty: real('MODEL_REPEAT_PENALTY', 1.15, 0.5, 3.0),
    presencePenalty: real('MODEL_PRESENCE_PENALTY', 0.35, -2.0, 2.0),
    frequencyPenalty: real('MODEL_FREQUENCY_PENALTY', 0.25, -2.0, 2.0),
    replyReview: (process.env.REPLY_REVIEW ?? 'true').toLowerCase() !== 'false',
    autoProfileBuild:(process.env.AUTO_PROFILE_BUILD ?? 'true').toLowerCase() !== 'false',
    replyPipeline,
    reviewShortApproval,
    reviewMode,
    writerPrompt,
    reasoningModel: process.env.REASONING_MODEL?.trim() || null,
    semanticRouter: (process.env.SEMANTIC_ROUTER ?? 'true').toLowerCase() !== 'false',
    llmRerank: (process.env.RAG_LLM_RERANK ?? 'true').toLowerCase() !== 'false',
    routerMaxTokens: integer('ROUTER_MAX_TOKENS',180,32,1000),
    rerankMaxTokens: integer('RERANK_MAX_TOKENS',420,64,2000),
    autoMemoryLearn:(process.env.AUTO_MEMORY_LEARN ?? 'true').toLowerCase() !== 'false',
    ragMinScore: real('RAG_MIN_SCORE', 0.38, 0, 1),
    maxTokens: integer('MODEL_MAX_TOKENS', 220, 32, 2048),
    replyCandidates: integer('REPLY_CANDIDATES', 1, 1, 8),
    replyMaxTokens: integer('REPLY_MAX_TOKENS', Number(process.env.MODEL_MAX_TOKENS ?? 220), 32, 2048),
    memoryQueryMaxTokens: integer('MEMORY_QUERY_MAX_TOKENS', 900, 64, 4096),
    topK: integer('RAG_TOP_K', 5, 1, 20),
    wa: {version: process.env.WA_GRAPH_VERSION ?? 'v26.0', phoneId: process.env.WA_PHONE_NUMBER_ID ?? '',
      accessToken: process.env.WA_ACCESS_TOKEN ?? '', appSecret: process.env.WA_APP_SECRET ?? '',
      verifyToken: process.env.WA_VERIFY_TOKEN ?? ''}
  });
}
