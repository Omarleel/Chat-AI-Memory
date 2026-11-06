import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

const storage = new AsyncLocalStorage();
const ms = n => Math.round(n * 100) / 100;
export function markStage(name) {
  const trace = storage.getStore();
  if (!trace) return;
  const now = performance.now();
  if (trace.current) trace.stages.push({stage:trace.current,ms:ms(now-trace.since)});
  trace.current=name; trace.since=now;
}
export function recordDiagnostic(name, value) {
  const trace=storage.getStore();
  if (trace) trace.decisions[name]=value;
}
export function captureArtifact(name, value) {
  const trace=storage.getStore();
  if (trace?.capture) trace.artifacts[name]=structuredClone(value);
}
// No prompts, textos, teléfonos ni errores de proveedor en la telemetría pública.
export function instrumentLlm(client) {
  return new Proxy(client,{get(target,key){
    const method=target[key];
    if (key==='withModel' && typeof method==='function') return name=>instrumentLlm(method.call(target,name));
    if (!['chat','chatDetails','embed','embedMany'].includes(key) || typeof method!=='function')
      return typeof method==='function' ? method.bind(target) : method;
    return async (...args)=>{
      const trace=storage.getStore();
      if(!trace) return method.apply(target,args);
      const started=performance.now();
      const event={stage:trace.current,operation:key,model:key.startsWith('embed')?target.embedModel:target.chatModel};
      try {
        const result=await method.apply(target,args);
        Object.assign(event,{ok:true,promptTokens:result?.promptEvalCount ?? null,outputTokens:result?.evalCount ?? null,
          truncated:result?.truncated ?? false,loadMs:result?.loadMs ?? null,inferenceMs:result?.inferenceMs ?? null});
        return result;
      } catch(error) {event.ok=false;throw error;}
      finally {event.ms=ms(performance.now()-started);trace.calls.push(event);}
    };
  }});
}
export async function profileReply(fn,{capture=false}={}) {
  const started=performance.now();
  const trace={capture,artifacts:{},stages:[],calls:[],decisions:{},current:null,since:started};
  return storage.run(trace,async()=>{
    const snapshot=()=>{markStage(null);return {totalMs:ms(performance.now()-started),stages:trace.stages,
      calls:trace.calls,decisions:trace.decisions};};
    try {
      const result=await fn();
      const profile=snapshot();
      if(result.rag) result.rag.profile=profile;
      if(capture) result.diagnostics={profile,artifacts:trace.artifacts};
      return result;
    }catch(error){error.previewStage=trace.current ?? error.previewStage;error.replyProfile=snapshot();if(capture)error.replyArtifacts=trace.artifacts;throw error;}
  });
}
