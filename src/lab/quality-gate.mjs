export const DIMENSIONS = ['coherence', 'continuity', 'behavior', 'language', 'factuality', 'naturalness'];
export function mean(values) {
  return values.length ? values.reduce((a,b) => a + b,0) / values.length : null;
}
export function summaryOf(judgments) {
  if (!judgments.length) return { count: 0, dimensions: {}, overall: null };
  const dimensions = Object.fromEntries(DIMENSIONS.map(k => [k, mean(judgments.map(j => j[k]))]));
  return { count: judgments.length, dimensions, overall: mean(Object.values(dimensions)) };
}
// Evidence-based gate; not a scientific claim of indistinguishable identity.
export function qualityGate(report, { minTurns = 12, minConversations = 3, minGain = 0.15, floor = 3.65 } = {}) {
  const reasons = [];
  const baseline = report?.baseline, candidate = report?.candidate;
  if (!baseline || !candidate || report?.status !== 'ok') reasons.push('Falta una evaluación válida de ambos modelos');
  if ((candidate?.count ?? 0) < minTurns) reasons.push(`Se necesitan al menos ${minTurns} turnos evaluados`);
  if ((report?.conversations ?? 0) < minConversations) reasons.push(`Se necesitan al menos ${minConversations} conversaciones independientes`);
  if (report?.errors?.length) reasons.push('Hay errores de inferencia o evaluación');
  if (!Number.isFinite(candidate?.overall) || !Number.isFinite(baseline?.overall)) reasons.push('Puntuaciones inválidas');
  if (Number.isFinite(candidate?.overall) && Number.isFinite(baseline?.overall)) {
    if (candidate.overall - baseline.overall < minGain)
      reasons.push(`La mejora global no alcanza ${minGain} puntos`);
    for (const k of DIMENSIONS) {
      if (!Number.isFinite(candidate.dimensions?.[k]) || !Number.isFinite(baseline.dimensions?.[k])) {
        reasons.push(`Dimensión ${k} no evaluada`); continue;
      }
      if (candidate.dimensions[k] < floor) reasons.push(`${k}: por debajo de ${floor}/5`);
      if (candidate.dimensions[k] - baseline.dimensions[k] < -0.15)
        reasons.push(`${k}: regresión superior a 0.15 puntos`);
    }
  }
  return { accepted: reasons.length === 0, reasons, improvement: Number.isFinite(candidate?.overall) && Number.isFinite(baseline?.overall)
    ? Number((candidate.overall - baseline.overall).toFixed(3)) : null };
}
