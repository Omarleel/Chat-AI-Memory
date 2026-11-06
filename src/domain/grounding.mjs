// Comprobación determinista de integridad de referencias. NO verifica la inferencia
// factual de la respuesta: se evalúa adicionalmente con modelo y humanos.
export function checkCitations(answer, evidence) {
  const allowed = new Set((evidence ?? []).map(x=>x.id));
  const used=[...new Set(String(answer).match(/\[(?:H|M|G)\d+\]/g) ?? [])].map(x=>x.slice(1,-1));
  return {valid:used.every(x=>allowed.has(x)), used, invalid:used.filter(x=>!allowed.has(x)),
    hasEvidence:allowed.size>0};
}
