import {createHash} from 'node:crypto';

const sha=s=>createHash('sha256').update(String(s)).digest('hex');
const EMOJI=/\p{Extended_Pictographic}/gu;

// Rasgos de forma, independientes del idioma y de la identidad; no miden contenido.
export function styleFeatures(text) {
  const t=String(text ?? '').trim();
  return {chars:t.length,lines:t ? t.split(/\n+/).length : 0,words:t ? t.split(/\s+/).length : 0,
    endsWithPeriod:/\.$/.test(t),upperStart:/^\p{Lu}/u.test(t),invertedMarks:/[¿¡]/.test(t),
    question:/\?/.test(t),emoji:(t.match(EMOJI) ?? []).length>0};
}

// 0 = misma forma; 1 = máxima diferencia. Longitud en escala log (×4 o más satura).
export function styleDistance(a,b) {
  const length=Math.min(1,Math.abs(Math.log((a.chars+1)/(b.chars+1)))/Math.log(4));
  const flags=['endsWithPeriod','upperStart','invertedMarks','emoji'].map(k=>a[k]===b[k]?0:1);
  const lines=(a.lines>1)===(b.lines>1)?0:1;
  const parts=[length,lines,...flags];
  return Number((parts.reduce((x,y)=>x+y,0)/parts.length).toFixed(3));
}

export function seededShuffle(items,seed) {
  return items.map((x,i)=>({x,k:sha(`${seed}:${i}`)})).sort((a,b)=>a.k<b.k?-1:1).map(o=>o.x);
}

export {selectHoldoutCases} from '../domain/holdout-cases.mjs';
