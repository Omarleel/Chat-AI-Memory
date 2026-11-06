// Por debajo de esta tasa el revisor descarta demasiadas respuestas que la propia persona sí escribió.
// Es un criterio de calidad del revisor, igual para todas las identidades.
export const MIN_REAL_APPROVAL = 0.8;

// Resumen sin texto de los chats: solo conteos, para guardarlo junto al trabajo de entrenamiento.
export function summarizeCalibration(verdicts) {
  const judged = verdicts.filter(v => typeof v?.valid === 'boolean');
  const approved = judged.filter(v => v.valid).length;
  const rate = judged.length ? Number((approved / judged.length).toFixed(3)) : null;
  return {cases: verdicts.length, judged: judged.length, approved, rejected: judged.length - approved,
    errors: verdicts.length - judged.length, shortApproved: judged.filter(v => v.short).length,
    realApprovalRate: rate, reliable: rate === null ? null : rate >= MIN_REAL_APPROVAL};
}
