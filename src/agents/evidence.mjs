// Public, strictly allowlisted diagnostic summary for *remote* Antigravity agents.
// Actual chats, references, generated answers, source session ids and judge free-text stay local.
import { DIMENSIONS } from '../lab/quality-gate.mjs';
const scalar=x=>Number.isFinite(x)?x:null;
export function scoreSummary(x) {
  if(!x || typeof x!=='object') return null;
  return {count:scalar(x.count),overall:scalar(x.overall),dimensions:Object.fromEntries(
    DIMENSIONS.map(d=>[d,scalar(x.dimensions?.[d])]))};
}
export function reportSummary(x) {
  if(!x || typeof x!=='object')return null;
  return {status:x.status==='ok'?'ok':'not_ok',conversations:scalar(x.conversations),steps:scalar(x.steps),
    baseline:scoreSummary(x.baseline),candidate:scoreSummary(x.candidate),
    gate:{accepted:x.gate?.accepted===true,improvement:scalar(x.gate?.improvement)}};
}
export function historySummary(items) {
  return (Array.isArray(items)?items:[]).slice(-12).map(x=>({
    id:String(x.id??'').slice(0,60),signature:String(x.signature??'').slice(0,100),
    status:String(x.status??'').slice(0,40),mode:String(x.mode??'').slice(0,20),
    settings:x.settings?{
      model:String(x.settings.model??'').slice(0,100),
      temperature:scalar(x.settings.temperature),replyMaxTokens:scalar(x.settings.replyMaxTokens),
      replyReview:x.settings.replyReview===true,semanticRouter:x.settings.semanticRouter===true
    }:null,
    evaluation:reportSummary(x.report),gate:{accepted:x.gate?.accepted===true,improvement:scalar(x.gate?.improvement)}
  }));
}
export function failureSummary(items){
  return (Array.isArray(items)?items:[]).slice(0,3).map(x=>({
    continuityGain:scalar(x.continuityGain),coherenceGain:scalar(x.coherenceGain),
    languageGain:scalar(x.languageGain)
  }));
}
export function paperSummary(items) {
  return (Array.isArray(items)?items:[]).slice(0,6).map(x=>({
    // Public metadata only; abstracts may contain untrusted instructions or indirect private prompts.
    title:String(x.title??'').slice(0,160),year:scalar(x.year),doi:String(x.doi??'').slice(0,140),
    citedByCount:scalar(x.citedByCount)
  }));
}
