// Compara veredictos de un revisor con etiquetas humanas. Positivo = "el revisor aprueba".
// Lo que importa en producción: aprobaciones falsas (invenciones que llegan al usuario)
// y rechazos falsos (respuestas válidas que se pierden).
export function scoreReviewer({labels, verdicts, key}) {
  const rows = labels.filter(l => verdicts[l.itemId] && typeof verdicts[l.itemId].valid === 'boolean');
  const human = l => l.label === 'valid';
  const approved = rows.filter(l => verdicts[l.itemId].valid);
  const tp = approved.filter(human).length;
  const humanValid = rows.filter(human).length;
  const falseApprovals = {};
  for (const l of approved.filter(l => !human(l))) falseApprovals[l.label] = (falseApprovals[l.label] ?? 0) + 1;
  const ratio = (a, b) => b ? Number((a / b).toFixed(3)) : null;
  const byOrigin = {};
  for (const origin of ['real', 'draft']) {
    const g = rows.filter(l => key[l.itemId]?.origin === origin);
    byOrigin[origin] = {n: g.length, humanValid: g.filter(human).length, approved: g.filter(l => verdicts[l.itemId].valid).length,
      agreement: ratio(g.filter(l => verdicts[l.itemId].valid === human(l)).length, g.length)};
  }
  return {n: rows.length, agreement: ratio(rows.filter(l => verdicts[l.itemId].valid === human(l)).length, rows.length),
    approved: approved.length, humanValid,
    // De lo que aprueba, cuánto es realmente válido / de lo válido, cuánto aprueba.
    approvalPrecision: ratio(tp, approved.length), approvalRecall: ratio(tp, humanValid),
    falseApprovals, falseRejections: humanValid - tp, byOrigin};
}
