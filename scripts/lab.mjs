#!/usr/bin/env node
// Separate from WhatsApp engine. No sends, no imports, no writes to production unless 'apply --apply'.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadHoldout, datasetFingerprint } from '../src/lab/dataset.mjs';
import { ExperimentRegistry } from '../src/lab/experiment-registry.mjs';
import { createGenerator, validateSettings } from '../src/lab/conversation-simulator.mjs';
import { createJudge } from '../src/lab/persona-judge.mjs';
import { validateNimJudgeConfiguration } from '../src/lab/nim-judge-client.mjs';
import { evaluateCandidate } from '../src/lab/evaluation-runner.mjs';
import { applyApproved } from '../src/lab/promote.mjs';

const argv=process.argv.slice(2);
const command=argv.shift() ?? 'help';
const flag=(key, otherwise=null) => {
  const at=argv.indexOf(`--${key}`);
  if(at<0)return otherwise;
  const value=argv[at+1];
  if (!value || value.startsWith('--')) throw new Error(`Falta valor para --${key}`);
  return value;
};
const enabled=key=>argv.includes(`--${key}`);
const int=(key,otherwise,min=1,max=1000)=>{
  const number=Number(flag(key,otherwise));
  if(!Number.isInteger(number) || number<min || number>max)throw new Error(`--${key} debe ser entero ${min}..${max}`);
  return number;
};
const dir=resolve(flag('out',process.env.LAB_DATA_DIR || './data/lab'));
const registry=new ExperimentRegistry(dir);
const notify=event=>{
  if(event.phase==='judged') process.stdout.write(`\rRevisados ${event.judged}/${event.total} turnos   `);
  else console.log(`\n${JSON.stringify(event)}`);
};
function baselineSettings() {
  return validateSettings({
    model:process.env.LLM_MODEL || 'qwen3.5:9b',
    temperature:Math.min(0.28,Number(process.env.MODEL_TEMPERATURE ?? 0.28)),
    replyMaxTokens:Number(process.env.REPLY_MAX_TOKENS ?? process.env.MODEL_MAX_TOKENS ?? 220),
    replyReview:(process.env.REPLY_REVIEW ?? 'true')==='true',
    semanticRouter:(process.env.SEMANTIC_ROUTER ?? 'true')==='true'
  });
}
const help=`LABORATORIO MULTIAGENTE (no conecta a WhatsApp):
  npm run lab:benchmark -- --dataset data/dataset/test.jsonl --candidate-model mi-modelo:latest
  npm run lab:run -- --dataset data/dataset/test.jsonl --max-cycles 4
  npm run lab:status
  npm run lab:doctor
  npm run lab:apply -- --id UUID --apply

Variables: LLM_MODEL, LAB_AGENT_PROVIDER=antigravity|ollama, LAB_SUPERVISOR_MODEL,
LAB_PROGRAMMER_MODEL, LAB_JUDGE_PROVIDER=ollama|nim, LAB_JUDGE_MODEL,
LAB_AGY_BIN, LAB_OLLAMA_URL, NVIDIA_API_KEY (solo NIM).
Con antigravity, supervisor y programador se ejecutan vía 'agy' con los IDs de 'agy models'.
Modelo objetivo en Ollama; juez local u opcionalmente NVIDIA NIM remoto.
NIM REMOTO recibe texto privado del dataset; requiere LAB_JUDGE_REMOTE_CONSENT=YES.
Los textos privados nunca se envían a los agentes externos.
Opciones run: --allow-web-papers, --unsafe-code-experiments (NO aislado a nivel proceso),
              --limit N, --min-turns N, --max-cycles N, --out data/lab.
Solo --apply cambia producción, y exige una aprobación explícita anterior.`;

try {
  if(command==='help') {
    console.log(help);
  } else if(command==='doctor') {
    let langgraph = 'no instalado';
    try { const m=await import('@langchain/langgraph'); langgraph=(m.StateGraph && m.MemorySaver)?'disponible':'API incompleta'; }
    catch(e) { langgraph=e.code==='ERR_MODULE_NOT_FOUND'?'no instalado':`error: ${e.message}`; }
    let models=[],ollamaStatus='no disponible';
    const url=process.env.LAB_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
    try {
      const response=await fetch(`${url}/api/tags`,{signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      models=(await response.json()).models?.map(x=>x.name)??[];
      ollamaStatus='disponible';
    }catch(e){ollamaStatus=e.message;}
    const judgeProvider=process.env.LAB_JUDGE_PROVIDER || 'ollama';
    const requested={base:process.env.LLM_MODEL,...(judgeProvider==='ollama'?{judge:process.env.LAB_JUDGE_MODEL}:{})};
    const nimJudge=judgeProvider==='nim'?{provider:'nim',model:process.env.LAB_JUDGE_MODEL??'(sin configurar)',
      keyConfigured:Boolean(process.env.NVIDIA_API_KEY),remoteConsent:process.env.LAB_JUDGE_REMOTE_CONSENT==='YES',
      status:'configuración local únicamente; conexión no comprobada'}:null;
    const provider=process.env.LAB_AGENT_PROVIDER || 'antigravity';
    let antigravity=null;
    if(provider==='antigravity') {
      let listing=[];
      try {
        const {createAgyRunner,parseModelsListing,chooseModel}=await import('../src/agents/antigravity-cli.mjs');
        const runner=createAgyRunner({timeoutMs:12000});
        const output=await runner(['models']);
        listing=parseModelsListing(`${output.stdout ?? ''}\n${output.stderr ?? ''}`);
        const sup=process.env.LAB_SUPERVISOR_MODEL;
        const prog=process.env.LAB_PROGRAMMER_MODEL;
        antigravity={status:'disponible',supervisor:chooseModel(sup,listing),
          programmer:chooseModel(prog,listing),availableModels:listing};
      } catch(e) {antigravity={status:'no disponible',error:e.message,availableModels:listing};}
    }
    console.log(JSON.stringify({node:process.version,langgraph,provider,antigravity,
      ollama:ollamaStatus,judgeProvider,nimJudge,localModels:Object.fromEntries(Object.entries(requested).map(([k,v])=>
        [k,{model:v??'(sin configurar)',installed:models.includes(v)}]))},null,2));
  } else if(command==='status') {
    const items=await registry.readHistory();
    console.log(JSON.stringify(items.map(x=>({id:x.id,at:x.at,status:x.status,hypothesis:x.hypothesis,
      gate:x.gate,score:x.report?.candidate?.overall})),null,2));
  } else if(command==='apply') {
    const id=flag('id');
    if(!id)throw new Error('Indica --id del experimento aprobado');
    const result=await applyApproved({registry,id,root:process.cwd(),yes:enabled('apply')});
    console.log(JSON.stringify(result,null,2));
    console.log('Reinicia manualmente el servicio tras inspeccionar el diff y los backups. AUTO_SEND no ha sido modificado.');
  } else if(['run','benchmark'].includes(command)) {
    const datasetPath=flag('dataset');
    if(!datasetPath)throw new Error('Indica --dataset test.jsonl (no train.jsonl)');
    const dataset=await loadHoldout(resolve(datasetPath),{limit:int('limit',24,1,500)});
    const base=baselineSettings();
    const judgeModel=flag('judge',process.env.LAB_JUDGE_MODEL);
    const judgeProvider=flag('judge-provider',process.env.LAB_JUDGE_PROVIDER || 'ollama');
    if(!judgeModel)throw new Error('Configura LAB_JUDGE_MODEL (modelo juez distinto del modelo evaluado)');
    if(judgeModel===base.model)throw new Error('LAB_JUDGE_MODEL debe ser distinto de LLM_MODEL');
    if(judgeProvider==='nim') validateNimJudgeConfiguration({model:judgeModel});
    const judge=createJudge({model:judgeModel,provider:judgeProvider});
    const minTurns=int('min-turns',12,1,500);
    const gateOptions={minTurns};
    console.log(`Dataset test: ${JSON.stringify(datasetFingerprint(dataset))}. Sin RAG, sin WhatsApp, sin persistir turnos.`);
    await registry.init();
    const release=await registry.acquireLock();
    try {
      if(command==='benchmark') {
        const candidate=validateSettings({
          model:flag('candidate-model',base.model),
          temperature:Number(flag('temperature',base.temperature)),
          replyMaxTokens:Number(flag('max-tokens',base.replyMaxTokens)),
          replyReview:flag('review',String(base.replyReview))==='true',
          semanticRouter:flag('router',String(base.semanticRouter))==='true'
        },base);
        if(judgeModel===candidate.model)throw new Error('El juez debe ser distinto de ambos modelos evaluados');
        const result=await evaluateCandidate({ dataset, baselineGenerator:await createGenerator({settings:base}),
          candidateGenerator:await createGenerator({settings:candidate}),judge,gateOptions,onProgress:notify });
        const id=randomUUID();
        await registry.record({id,status:'benchmark',datasetSha256:dataset.sha256,
          hypothesis:'Comparación manual base vs candidato',settings:candidate,gate:result.report.gate,
          report:result.report});
        const { atomicJson }=await import('../src/lab/experiment-registry.mjs');
        await atomicJson(resolve(dir,`private-diagnostics-${id}.json`),result.diagnostics);
        console.log(`\nBenchmark ${id}: ${JSON.stringify(result.report,null,2)}`);
      } else {
        const {createOptimizationGraph}=await import('../src/agents/optimization-graph.mjs');
        const {Command}=await import('@langchain/langgraph');
        const supervisorModel=flag('supervisor',process.env.LAB_SUPERVISOR_MODEL);
        const programmerModel=flag('programmer',process.env.LAB_PROGRAMMER_MODEL);
        if((process.env.LAB_AGENT_PROVIDER || 'antigravity')==='ollama' && (!supervisorModel || !programmerModel))
          throw new Error('Con LAB_AGENT_PROVIDER=ollama, indica ambos modelos locales');
        const graph=await createOptimizationGraph({dataset,registry,baselineSettings:base,
          maxCycles:int('max-cycles',5,1,30),supervisorModel,programmerModel,judge,
          allowWebPapers:enabled('allow-web-papers'),allowCodeEdits:enabled('unsafe-code-experiments'),
          onProgress:notify,gateOptions});
        const config={configurable:{thread_id:randomUUID()},recursionLimit:120};
        const state={objective:'Mejorar coherencia, continuidad, fidelidad conductual/lingüística y naturalidad de borradores privados',
          cycles:0,datasetSha256:dataset.sha256,baselineSettings:base,history:await registry.readHistory(),
          report:null,failures:[],papers:[],objection:null,approved:false,candidate:null,
          instruction:null,programmerReply:null};
        let final=await graph.invoke(state,config);
        if(final.__interrupt__?.length) {
          const request=final.__interrupt__[0].value;
          console.log(`\nAPROBACIÓN HUMANA REQUERIDA: ${JSON.stringify(request,null,2)}`);
          const {createInterface}=await import('node:readline/promises');
          const ui=createInterface({input:process.stdin,output:process.stdout});
          let answer='';
          try { answer=await ui.question('Escribe APROBAR para registrar el candidato (otro valor rechaza): '); }
          finally { ui.close(); }
          final=await graph.invoke(new Command({resume:answer.trim()==='APROBAR'}),config);
        }
        console.log(`\nLAB FINAL: ${JSON.stringify({cycles:final.cycles,report:final.report,
          candidateId:final.candidate?.id,approved:final.approved},null,2)}`);
        console.log('Solo para aplicar manualmente: npm run lab:apply -- --id ID_APROBADO --apply');
      }
    } finally {await release();}
  } else throw new Error(`Comando desconocido: ${command}\n${help}`);
} catch(e) { console.error(`LAB ERROR: ${e.message}`); process.exitCode=1; }
