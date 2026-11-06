// node scripts/evaluate_holdout.mjs mi-modelo data/dataset/test.jsonl data/evaluation-holdout.json
// No consultas a índices, ningún envío y ningún target en los prompts.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {ReplyService} from '../src/app/reply-service.mjs';
import {OllamaClient} from '../src/infra/ollama.mjs';

const [modelsArg = process.env.LLM_MODEL || 'mi-modelo:latest', dataset = 'data/dataset/test.jsonl', output = 'data/evaluation-holdout.json'] = process.argv.slice(2);
const raw = fs.readFileSync(dataset, 'utf8');
const available = raw.trim().split('\n').map(JSON.parse).filter(row =>
  row.provenance?.split === 'test' && row.completion[0].content.length >= 12 &&
  row.completion[0].content.length <= 220 && row.prompt.length >= 3);
if (!available.length) throw new Error('No hay muestras de test');
const selected = Array.from({length: Math.min(16, available.length)}, (_, i) =>
  available[Math.floor(i * available.length / Math.min(16, available.length))]);
const report = {datasetSha256: createHash('sha256').update(raw).digest('hex'),
  memoryRetrieval: false, temperature: 0, rows: [],
  note: 'Evaluación manual de coherencia y estilo; la igualdad literal no es una métrica de calidad.'};
for (const model of modelsArg.split(',')) {
  const llm = new OllamaClient({baseUrl: process.env.EVAL_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    chatModel: model, modelContext: 8192, maxTokens: 180, temperature: 0});
  const selfName = process.env.SELF_DISPLAY_NAME || 'Titular';
  const peerName = process.env.LAB_PEER_NAME || 'Interlocutor';
  const service = new ReplyService({llm, config: {selfName, temperature: 0, replyReview: false},
    repository: {listChatImports: () => [{self: selfName, peer: peerName}],
      listMemories: () => [], listStyles: () => [], recentPreview: () => []}});
  for (const row of selected) {
    const incoming = row.prompt.at(-1).content;
    const context = row.prompt.filter(m => m.role !== 'system').slice(0, -1);
    const started = Date.now();
    const answer = await service.previewReply('evaluation', incoming, 'holdout', true, 'off', {recentMessages: context});
    const result = {model, source: row.provenance, context, incoming,
      expected: row.completion[0].content, actual: answer.answer, latencyMs: Date.now() - started};
    report.rows.push(result);
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({model, target: row.provenance.targetOrdinals, incoming, expected: result.expected, actual: result.actual}));
  }
}
