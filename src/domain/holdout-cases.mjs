import {createHash} from 'node:crypto';

const sha=s=>createHash('sha256').update(String(s)).digest('hex');

// Un caso por sesión, con contexto real de varios turnos; orden por hash, no elegido a mano.
export function selectHoldoutCases(rows,{limit=24,minContext=4,maxReference=220}={}) {
  const bySession=new Map();
  for(const row of rows) {
    const turns=(row.prompt ?? []).filter(m=>m.role!=='system');
    const reference=row.completion?.[0]?.content?.trim();
    if(turns.length<minContext+1 || turns.at(-1)?.role!=='user' || !reference || reference.length>maxReference) continue;
    const session=row.provenance?.session;
    if(!bySession.has(session)) bySession.set(session,[]);
    bySession.get(session).push({hash:row.provenance?.hash ?? sha(JSON.stringify(row)),
      context:turns.slice(0,-1),input:turns.at(-1).content,reference});
  }
  return [...bySession.entries()].sort(([a],[b])=>sha(a)<sha(b)?-1:1).slice(0,limit)
    .map(([,list])=>list[Math.floor(list.length/2)]);
}
