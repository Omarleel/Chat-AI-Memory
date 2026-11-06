import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { OllamaClient } from '../infra/ollama.mjs';

export const BASE_SETTINGS = Object.freeze({
  model: process.env.LLM_MODEL || 'qwen3.5:9b',
  temperature: 0.28, replyMaxTokens: 220, replyReview: false,
  semanticRouter: false
});
export function validateSettings(raw, fallback = BASE_SETTINGS) {
  const accepted = ['model', 'temperature', 'replyMaxTokens', 'replyReview', 'semanticRouter'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Configuración de experimento inválida');
  for (const key of Object.keys(raw)) if (!accepted.includes(key)) throw new Error(`Opción experimental no permitida: ${key}`);
  const s = { ...fallback, ...raw };
  if (typeof s.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,100}$/.test(s.model)) throw new Error('Nombre de modelo inválido');
  if (!Number.isFinite(s.temperature) || s.temperature < 0 || s.temperature > 0.28) throw new Error('temperature requiere 0..0.28 (límite actual de ReplyService)');
  if (!Number.isInteger(s.replyMaxTokens) || s.replyMaxTokens < 40 || s.replyMaxTokens > 1000) throw new Error('replyMaxTokens requiere 40..1000');
  if (typeof s.replyReview !== 'boolean' || typeof s.semanticRouter !== 'boolean') throw new Error('Opciones booleanas inválidas');
  return s;
}
export async function createGenerator({ root = process.cwd(), settings = BASE_SETTINGS, clientFactory, configOverrides = {} } = {}) {
  const current = validateSettings(settings);
  const modulePath = resolve(root, 'src/app/reply-service.mjs');
  const { ReplyService } = await import(pathToFileURL(modulePath).href);
  const config = {
    selfName: process.env.SELF_DISPLAY_NAME || 'Titular',
    chatModel: current.model, temperature: current.temperature, maxTokens: current.replyMaxTokens,
    replyMaxTokens: current.replyMaxTokens, modelContext: 8192,
    ragMinScore: 0.4, topK: 1, replyReview: current.replyReview,
    semanticRouter: current.semanticRouter,
    autoMemoryLearn: false, autoProfileBuild: false,
    ...configOverrides
  };
  const client = clientFactory ? clientFactory(current) : new OllamaClient({
    baseUrl: process.env.LAB_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    chatModel: current.model, embedModel: process.env.EMBED_MODEL || 'embeddinggemma',
    modelContext: 8192, maxTokens: current.replyMaxTokens, temperature: current.temperature,
    repeatPenalty: 1.15
  });
  const repository = {
    listChatImports: () => [{ self: config.selfName, peer: process.env.LAB_PEER_NAME || 'Interlocutor' }],
    getPersonas: () => ({ self: null, peer: null }), getBehaviorProfile: () => null,
    listMemories: () => [], listLearnedMemories: () => [], listStyles: () => [],
    listStylePairs: () => [], searchStylePairs: () => [], recentPreview: () => [],
    recent: () => []
  };
  const service = new ReplyService({ llm: client, repository, historyStore: {
    search: async () => { throw new Error('Contaminación: no se permite RAG durante holdout'); }
  }, config });
  return async (input, context) => {
    const result = await service.previewReply('lab-offline', input, 'lab-test', false, 'off', {
      recentMessages: context // explicitly disables persisted conversations
    });
    if (typeof result?.answer !== 'string' || !result.answer.trim()) throw new Error('El modelo no devolvió respuesta válida');
    return result.answer.trim();
  };
}
export async function replayConversations(conversations, generator) {
  const output = [];
  for (const c of conversations) {
    const context = c.initialContext.map(x => ({ ...x }));
    const turns = [];
    for (let index = 0; index < c.steps.length; index++) {
      const step = c.steps[index];
      const started = Date.now();
      const answer = await generator(step.input, context);
      const elapsedMs = Date.now() - started;
      turns.push({ index, input: step.input, reference: step.reference,
        context: context.map(x => ({ ...x })), answer, elapsedMs });
      context.push({role: 'user', content: step.input}, {role: 'assistant', content: answer});
    }
    output.push({ id: c.id, sourceSession: c.sourceSession, turns });
  }
  return output;
}
