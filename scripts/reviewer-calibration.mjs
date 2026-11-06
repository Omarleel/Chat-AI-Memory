// Calibración del revisor sin etiquetas: qué parte de las respuestas reales reservadas del titular aprueba.
//   node --env-file=.env scripts/reviewer-calibration.mjs --reviewer qwen3.5:9b [--test data/dataset/test.jsonl]
//     [--train data/dataset/train.jsonl] [--cases 30] [--no-examples] [--short-approval]
// Lo mismo corre en el motor al terminar cada entrenamiento (POST /api/training/jobs/:id/calibrate-reviewer).
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {OllamaClient} from '../src/infra/ollama.mjs';
import {ReviewerCalibrationService} from '../src/app/reviewer-calibration-service.mjs';

const {values} = parseArgs({options: {reviewer: {type: 'string'}, test: {type: 'string'}, train: {type: 'string'}, cases: {type: 'string'},
  'no-examples': {type: 'boolean'}, 'short-approval': {type: 'boolean'}, self: {type: 'string'}, peer: {type: 'string'}, url: {type: 'string'}}});
const reviewer = values.reviewer ?? process.env.REASONING_MODEL;
if (!reviewer) throw new Error('Falta --reviewer o REASONING_MODEL');
const baseUrl = values.url ?? 'http://127.0.0.1:11434';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('Restringido a Ollama local');
if ((process.env.AUTO_SEND ?? 'false').toLowerCase() !== 'false') throw new Error('Ejecuta con AUTO_SEND=false');
const rows = async file => (await readFile(resolve(file), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const llm = new OllamaClient({baseUrl, chatModel: reviewer, embedModel: 'embeddinggemma', modelContext: 8192, maxTokens: 450, temperature: 0});
const service = new ReviewerCalibrationService({llm, config: {reviewShortApproval: values['short-approval'] ? 'shape' : 'off'}});
const summary = await service.calibrate({testRows: await rows(values.test ?? 'data/dataset/test.jsonl'),
  trainRows: await rows(values.train ?? 'data/dataset/train.jsonl'), limit: Number(values.cases ?? 30), examples: !values['no-examples'],
  selfName: values.self ?? process.env.SELF_DISPLAY_NAME ?? 'Titular', peerName: values.peer ?? process.env.LAB_PEER_NAME ?? 'Interlocutor',
  onProgress: (done, total) => process.stderr.write(`\r${done}/${total}`)});
process.stderr.write('\n');
console.log(JSON.stringify({reviewer, ...summary}));
