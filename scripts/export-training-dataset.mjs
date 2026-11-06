import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {parseWhatsAppTxt, selectDirectHistory} from '../src/domain/history.mjs';
import {buildTrainingDataset} from '../src/domain/training-dataset.mjs';

const input = process.argv[2];
if (!input) throw new Error('Indica un TXT explícito: node --env-file=.env scripts/export-training-dataset.mjs imports/chat.txt data/dataset');
const source = resolve(input);
const destination = resolve(process.argv[3] ?? 'data/dataset');
const raw = readFileSync(source, 'utf8');
const messages = selectDirectHistory(parseWhatsAppTxt(raw), process.env.SELF_DISPLAY_NAME || 'Titular', process.env.LAB_PEER_NAME || 'Interlocutor');
const data = buildTrainingDataset(messages);
mkdirSync(destination, {recursive: true});
for (const split of ['train', 'validation', 'test']) {
  writeFileSync(join(destination, `${split}.jsonl`), data[split].map(row => JSON.stringify(row)).join('\n') + '\n', {flag: 'wx'});
}
const manifest = {source, sourceSha256: createHash('sha256').update(raw).digest('hex'),
  format: 'conversational_prompt_completion', gapMinutes: 120, maxTurns: 24,
  messages: messages.length, ...data.stats,
  counts: Object.fromEntries(['train', 'validation', 'test'].map(k => [k, data[k].length]))};
writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), {flag: 'wx'});
console.log(JSON.stringify(manifest, null, 2));
