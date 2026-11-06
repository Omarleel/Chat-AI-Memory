import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createGenerator } from '../lab/conversation-simulator.mjs';
import { prepareWorkspace } from '../lab/code-workspace.mjs';
import { evaluateCandidate } from '../lab/evaluation-runner.mjs';
import { searchPapers } from '../lab/paper-search.mjs';
import { atomicJson } from '../lab/experiment-registry.mjs';
import { createSupervisor } from './supervisor.mjs';
import { createProgrammer } from './programmer.mjs';

// Lazy import: pure evaluation/test modules work without installing LangGraph yet.
export async function createOptimizationGraph({ supervisorModel, programmerModel, dataset, registry,
  root=process.cwd(), baselineSettings, maxCycles=5, allowWebPapers=false,
  allowCodeEdits=false, judge, gateOptions={}, callSupervisor, callProgrammer,
  baselineGeneratorFactory=createGenerator, candidateGeneratorFactory=createGenerator,
  onProgress=console.log, graphApi=null }={}) {
  const { Annotation, StateGraph, START, END, MemorySaver, interrupt } = graphApi ?? await import('@langchain/langgraph');
  const provider=process.env.LAB_AGENT_PROVIDER || 'antigravity';
  const agentFactory=provider==='antigravity'
    ? (await import('./antigravity-cli.mjs')).makeAntigravityAgent
    : provider==='ollama' ? null : (()=>{throw new Error(`LAB_AGENT_PROVIDER inválido: ${provider}`);})();
  const {makeAgent}=await import('./model-json.mjs');
  const agentFor=(role,model)=>provider==='antigravity'?agentFactory({role,model}):makeAgent(model);
  const supervisor=createSupervisor(callSupervisor ?? agentFor('supervisor',supervisorModel));
  const programmer=createProgrammer(callProgrammer ?? agentFor('programmer',programmerModel),{root,allowCodeEdits});
  const S = Annotation.Root({
    objective:Annotation(), cycles:Annotation(), datasetSha256:Annotation(), baselineSettings:Annotation(),
    report:Annotation(), history:Annotation(), failures:Annotation(), instruction:Annotation(),
    programmerReply:Annotation(), objection:Annotation(), papers:Annotation(), candidate:Annotation(), approved:Annotation()
  });
  const graph=new StateGraph(S)
    .addNode('supervisor', supervisor)
    .addNode('research', async state => {
      try {const result=await searchPapers(state.instruction.researchQuery,{enabled:allowWebPapers});
        return {papers:result.papers,objection:result.note??null};
      } catch(e) { return {papers:[],objection:`Investigación no disponible: ${e.message}`}; }
    })
    .addNode('programmer', programmer)
    .addNode('challenge', async state => {
      const obj={id:randomUUID(),status:'challenge',datasetSha256:state.datasetSha256,
        hypothesis:state.instruction.hypothesis,reason:state.programmerReply.reason};
      const saved=await registry.record(obj);
      onProgress({phase:'challenge',reason:obj.reason});
      return {objection:obj.reason,history:[...state.history,saved],programmerReply:null};
    })
    .addNode('experiment', async state => {
      const plan=state.programmerReply;
      const id=randomUUID();
      let workspace=null, patches=[];
      try {
        if (plan.mode==='code') {
          const prepared=await prepareWorkspace(root,plan.patches);
          workspace=prepared.workspace; patches=prepared.records;
        }
        const baselineGenerator=await baselineGeneratorFactory({root,settings:state.baselineSettings});
        const candidateGenerator=await candidateGeneratorFactory({root:workspace??root,settings:plan.settings});
        const {report,diagnostics}=await evaluateCandidate({dataset,baselineGenerator,candidateGenerator,
          judge, gateOptions, onProgress});
        const experiment={id,status: 'evaluated',datasetSha256:dataset.sha256,
          signature:plan.signature,hypothesis:plan.hypothesis,settings:plan.settings,
          mode:plan.mode,patches,gate:report.gate,report};
        const saved=await registry.record(experiment);
        // Diagnostic transcripts are private, excluded from logs, in a permissions-limited directory.
        await atomicJson(join(registry.dir,`private-diagnostics-${id}.json`),diagnostics);
        // Only judge rationales and score differences reach the optimizing agents.
        // Actual test references and chat messages stay in private diagnostics (no holdout feedback leak).
        const worst=diagnostics.map(d=>({id:d.id,
          continuityGain:d.candidate.scores.continuity-d.baseline.scores.continuity,
          coherenceGain:d.candidate.scores.coherence-d.baseline.scores.coherence,
          languageGain:d.candidate.scores.language-d.baseline.scores.language,
          judgeComment:String(d.candidate.scores.reason??'').slice(0,350)}))
          .sort((a,b)=>a.continuityGain-b.continuityGain).slice(0,3);
        onProgress({phase:'evaluated',id,gate:report.gate,baseline:report.baseline.overall,candidate:report.candidate.overall});
        return {candidate:saved,report,failures:worst,history:[...state.history,saved],objection:null,
          papers:state.papers,programmerReply:null};
      } catch(error) {
        // Failed experiments are evidence too. The supervisor can diagnose them next cycle.
        const reason=String(error?.message ?? error).slice(0,600);
        const saved=await registry.record({id,status:'failed',datasetSha256:dataset.sha256,
          signature:plan.signature,hypothesis:plan.hypothesis,settings:plan.settings,
          mode:plan.mode,patches,error:reason,gate:{accepted:false,reasons:[reason]}});
        onProgress({phase:'failed',experimentId:id,error:reason});
        return {candidate:null,report:{status:'error',errors:[reason],gate:{accepted:false,reasons:[reason]}},
          failures:[{id,judgeComment:reason}],history:[...state.history,saved],objection:reason,programmerReply:null};
      } finally {if (workspace) await rm(workspace,{recursive:true,force:true});}
    })
    .addNode('approval', state => {
      const approved=interrupt({kind:'human_review',experimentId:state.candidate?.id,
        qualityGate:state.report?.gate,metrics:state.report?.candidate,
        message:'Promocionar solo con APROBAR explícito. No se modificará producción todavía.'});
      return {approved:approved===true};
    })
    .addNode('approveRecord', async state => {
      if(!state.approved || !state.report?.gate?.accepted) return {};
      await registry.approved({...state.candidate,gate:state.report.gate});
      onProgress({phase:'approved',experimentId:state.candidate.id});
      return {};
    })
    .addEdge(START,'supervisor')
    .addConditionalEdges('supervisor', state => {
      if (state.instruction.action==='accept' && state.report?.gate?.accepted) return 'approval';
      if (state.instruction.action==='stop' || state.cycles>maxCycles) return END;
      return state.instruction.action==='research'?'research':'programmer';
    })
    .addEdge('research','programmer')
    .addConditionalEdges('programmer', state => state.programmerReply.action==='challenge'?'challenge':'experiment')
    .addEdge('challenge','supervisor')
    .addEdge('experiment','supervisor')
    .addConditionalEdges('approval', state => state.approved?'approveRecord':END)
    .addEdge('approveRecord',END);
  return graph.compile({checkpointer:new MemorySaver()});
}
