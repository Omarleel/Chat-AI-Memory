// Transforms explicitly held-out test.jsonl into multi-turn offline scenarios.
// No corpus import, Qdrant, training, or WhatsApp I/O.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

const input=resolve(process.argv[2]??'data/dataset/test.jsonl');
const output=resolve(process.argv[3]??'data/lab/multi-turn-test.jsonl');
const raw=await readFile(input,'utf8');
const rows=raw.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const groups=new Map();
for (const row of rows) {
  if(row.provenance?.split!=='test')throw new Error('El archivo debe contener SOLO provenance.split=test');
  if(!groups.has(row.provenance.session))groups.set(row.provenance.session,[]);
  groups.get(row.provenance.session).push(row);
}
const result=[];
for (const [session,examples] of groups) {
  let conversation=null;
  for (const row of examples) {
    const turns=(row.prompt??[]).filter(t=>t.role!=='system');
    const inputTurn=turns.at(-1), reference=row.completion?.[0];
    if(inputTurn?.role!=='user' || reference?.role!=='assistant')continue;
    // Merge only where the new prompt includes the immediately preceding reference
    // as the last assistant message; otherwise begin a new independently held-out dialogue.
    const previousAssistant=turns.at(-2);
    const adjacent=conversation && previousAssistant?.role==='assistant'
      && previousAssistant.content===conversation.steps.at(-1).reference;
    if(!adjacent){
      conversation={id:`${session}-${result.length}`,session,split:'test',
        initialContext:turns.slice(0,-1),steps:[]};
      result.push(conversation);
    }
    conversation.steps.push({input:inputTurn.content,reference:reference.content});
    // Limit turn count; a new conversation starts if it exceeds the bound.
    if(conversation.steps.length>=20)conversation=null;
  }
}
if(!result.length)throw new Error('No se encontraron diálogos test');
await mkdir(dirname(output),{recursive:true,mode:0o700});
await writeFile(output,result.map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log(`Se crearon ${result.length} diálogos de test (${result.reduce((n,x)=>n+x.steps.length,0)} turnos) en ${output}`);
console.log('No uses estas referencias para fine-tuning ni como índice RAG.');
