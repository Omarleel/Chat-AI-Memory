// Mide cuánto acierta el revisor frente a etiquetas humanas, con conversaciones reservadas (split=test).
//   1) node --env-file=.env scripts/reviewer-benchmark.mjs --build --out data/eval/reviewer-X --writer M --reasoner M
//   2) abre data/eval/reviewer-X/label.html, carga items.json y exporta labels.json
//   3) node --env-file=.env scripts/reviewer-benchmark.mjs --score --out data/eval/reviewer-X --labels labels.json --reviewers qwen3.5:9b,qwen2.5:7b
//      --variants base,examples,short: sin ejemplos / con intercambios reales del titular (solo train) / además
//      aprobación breve con la mediana propia (REVIEW_SHORT_APPROVAL=shape). --train data/dataset/train.jsonl
// Sin RAG (el índice contiene el chat completo). Los borradores salen del redactor sin revisión.
import {parseArgs} from 'node:util';
import {mkdir, writeFile, readFile, copyFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ReplyService} from '../src/app/reply-service.mjs';
import {ResponseValidationService} from '../src/app/response-validation-service.mjs';
import {OllamaClient} from '../src/infra/ollama.mjs';
import {seededShuffle, selectHoldoutCases} from '../src/lab/holdout-metrics.mjs';
import {scoreReviewer} from '../src/lab/reviewer-metrics.mjs';
import {datasetPairs, exampleSelector, shortApprovalLimit} from '../src/domain/holder-examples.mjs';
import {replyShape} from '../src/domain/reply-shape.mjs';

const {values} = parseArgs({options: {build: {type: 'boolean'}, score: {type: 'boolean'}, out: {type: 'string'}, dataset: {type: 'string'},
  writer: {type: 'string'}, reasoner: {type: 'string'}, reviewers: {type: 'string'}, labels: {type: 'string'}, cases: {type: 'string'},
  drafts: {type: 'string'}, variants: {type: 'string'}, train: {type: 'string'}, style: {type: 'string'}, self: {type: 'string'}, peer: {type: 'string'}, url: {type: 'string'}}});
if (!values.out || values.build === values.score) throw new Error('Usa --build o --score con --out DIR');
const out = resolve(values.out);
const baseUrl = values.url ?? 'http://127.0.0.1:11434';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('Restringido a Ollama local');
if ((process.env.AUTO_SEND ?? 'false').toLowerCase() !== 'false') throw new Error('Ejecuta con AUTO_SEND=false');
const client = model => new OllamaClient({baseUrl, chatModel: model, embedModel: 'embeddinggemma', modelContext: 8192, maxTokens: 220, temperature: 0.28});

if (values.build) {
  for (const k of ['writer', 'reasoner']) if (!values[k]) throw new Error(`Falta --${k}`);
  const raw = await readFile(resolve(values.dataset ?? 'data/dataset/test.jsonl'), 'utf8');
  const rows = raw.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (rows.some(r => r.provenance?.split !== 'test')) throw new Error('El dataset debe contener SOLO provenance.split=test');
  const cases = selectHoldoutCases(rows, {limit: Number(values.cases ?? 20)});
  const style = values.style ? JSON.parse(await readFile(resolve(values.style), 'utf8')).summary ?? null : null;
  const self = values.self ?? process.env.SELF_DISPLAY_NAME ?? 'Titular', peer = values.peer ?? process.env.LAB_PEER_NAME ?? 'Interlocutor';
  const repository = {listChatImports: () => [{self, peer}], getBehaviorProfile: () => style ? {summary: style} : null,
    listMemories: () => [], recentPreview: () => [], listStyles: () => []};
  const service = new ReplyService({repository, llm: client(values.writer), config: {selfName: self, chatModel: values.writer,
    reasoningModel: values.reasoner, replyPipeline: 'direct', semanticRouter: true, replyReview: false, replyMaxTokens: 220, autoMemoryLearn: false}});
  await mkdir(out, {recursive: true});
  const items = [], key = {};
  for (const [n, c] of cases.entries()) {
    const candidates = [{origin: 'real', text: c.reference}];
    for (let d = 0; d < Number(values.drafts ?? 2); d++) {
      try {
        const r = await service.previewReply('benchmark', c.input, 'benchmark', false, 'off', {recentMessages: c.context, recentOrigin: 'real'});
        if (r.answer && !candidates.some(x => x.text === r.answer)) candidates.push({origin: 'draft', text: r.answer});
      } catch (error) {console.warn(`Caso ${n}: ${error.message}`);}
    }
    const thread = c.context.slice(-10).map(m => ({who: m.role === 'assistant' ? self : peer, text: m.content}));
    for (const [i, x] of seededShuffle(candidates, c.hash).entries()) {
      const itemId = `c${String(n).padStart(2, '0')}-${String.fromCharCode(97 + i)}`;
      items.push({itemId, caseId: c.hash, thread, context: c.context, lastMessage: c.input, text: x.text});
      key[itemId] = {origin: x.origin, caseId: c.hash};
    }
    console.log(`Caso ${n + 1}/${cases.length}: ${candidates.length} respuestas`);
  }
  // El orden global también se baraja para que no se agrupen las reales y los borradores de un caso.
  const shuffled = seededShuffle(items, 'reviewer-benchmark');
  await writeFile(join(out, 'items.json'), JSON.stringify({self, peer, writer: values.writer, items: shuffled.map(({context, ...x}) => x)}, null, 2));
  await writeFile(join(out, 'cases.json'), JSON.stringify(shuffled.map(({itemId, context, lastMessage, text}) => ({itemId, context, lastMessage, text}))));
  await writeFile(join(out, 'key.json'), JSON.stringify(key, null, 2));
  await copyFile(fileURLToPath(new URL('../src/lab/review-labeling.html', import.meta.url)), join(out, 'label.html'));
  console.log(`${items.length} respuestas. Abre ${join(out, 'label.html')} y carga items.json.`);
  process.exit(0);
}

// --score: veredictos de cada revisor (cacheados) frente a las etiquetas humanas.
if (!values.labels || !values.reviewers) throw new Error('Usa --score --labels labels.json --reviewers m1,m2');
const meta = JSON.parse(await readFile(join(out, 'items.json'), 'utf8'));
const cases = JSON.parse(await readFile(join(out, 'cases.json'), 'utf8'));
const key = JSON.parse(await readFile(join(out, 'key.json'), 'utf8'));
const labels = JSON.parse(await readFile(resolve(values.labels), 'utf8')).labels ?? [];
const report = {labelled: labels.length, distribution: {}, reviewers: {}};
for (const l of labels) report.distribution[l.label] = (report.distribution[l.label] ?? 0) + 1;
// Ejemplos y forma solo desde train: los casos etiquetados salen de test.
const variants = (values.variants ?? 'base').split(',').map(v => v.trim()).filter(Boolean);
// closed: con ejemplos y preguntas cerradas (REVIEW_MODE=closed); el veredicto se deriva de las respuestas.
if (variants.some(v => !['base', 'examples', 'short', 'closed'].includes(v))) throw new Error('--variants: base, examples, short o closed');
let select = () => [], shortLimit = null;
if (variants.some(v => v !== 'base')) {
  const trainRows = (await readFile(resolve(values.train ?? 'data/dataset/train.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  if (trainRows.some(r => r.provenance?.split !== 'train')) throw new Error('--train debe contener SOLO provenance.split=train');
  const pairs = datasetPairs(trainRows);
  select = exampleSelector(pairs);
  shortLimit = shortApprovalLimit(replyShape(pairs.map(p => p.reply)), 'shape');
  console.log(`Ejemplos de ${pairs.length} pares de train; límite breve propio: ${shortLimit} caracteres`);
}
for (const model of values.reviewers.split(',').map(s => s.trim()).filter(Boolean)) for (const variant of variants) {
  const name = variant === 'base' ? model : `${model}+${variant}`;
  const cacheFile = join(out, `verdicts-${name.replace(/[^\w.-]+/g, '_')}.json`);
  const verdicts = await readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => ({}));
  const reviewer = new ResponseValidationService({llm: client(model), config: {reviewMode: variant === 'closed' ? 'closed' : 'judgment'}});
  for (const l of labels) {
    if (verdicts[l.itemId]) continue;
    const c = cases.find(x => x.itemId === l.itemId);
    if (!c) continue;
    try {
      verdicts[l.itemId] = await reviewer.validate({question: c.lastMessage, answer: c.text, evidence: [], judgeOnly: true,
        recent: c.context.map(m => ({author: m.role === 'assistant' ? meta.self : meta.peer, text: m.content, origin: 'live_message'})),
        selfAuthor: meta.self, peerAuthor: meta.peer, holderExamples: variant === 'base' ? [] : select(c.lastMessage),
        shortApprovalLimit: variant === 'short' ? shortLimit : null});
    } catch (error) {verdicts[l.itemId] = {error: error.message};}
    await writeFile(cacheFile, JSON.stringify(verdicts, null, 2));
  }
  report.reviewers[name] = scoreReviewer({labels, verdicts, key});
}
await writeFile(join(out, 'reviewer-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.distribution));
console.table(Object.fromEntries(Object.entries(report.reviewers).map(([m, r]) => [m, {n: r.n, acuerdo: r.agreement, aprueba: r.approved,
  'reales aprob.': `${r.byOrigin.real.approved}/${r.byOrigin.real.n}`,
  precisión: r.approvalPrecision, cobertura: r.approvalRecall, 'aprob. falsas': Object.values(r.falseApprovals).reduce((a, b) => a + b, 0),
  'rech. falsos': r.falseRejections}])));
