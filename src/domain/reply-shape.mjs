// Forma típica de las respuestas del titular (por turno: mensajes seguidos del mismo autor juntos).
// Sirve de objetivo concreto para la etapa de estilo en vez de un "sé breve" genérico.
export function ownTurns(messages) {
  const turns = [];
  let current = null;
  for (const m of messages) {
    if (m.role !== 'self') {current = null; continue;}
    const text = String(m.text ?? '').trim();
    if (!text || /omitid|<Multimedia|eliminó este mensaje/i.test(text)) continue;
    if (current) current.push(text); else turns.push(current = [text]);
  }
  return turns.map(t => t.join('\n'));
}

const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;

export function replyShape(replies) {
  const texts = replies.map(r => String(r ?? '').trim()).filter(Boolean);
  if (texts.length < 20) return null;
  const chars = texts.map(t => t.length).sort((a, b) => a - b);
  const share = f => Number((texts.filter(f).length / texts.length).toFixed(2));
  return {samples: texts.length, medianChars: percentile(chars, 0.5), p75Chars: percentile(chars, 0.75), p90Chars: percentile(chars, 0.9),
    multiLine: share(t => t.includes('\n')), upperStart: share(t => /^\p{Lu}/u.test(t)), endsWithPeriod: share(t => /\.$/.test(t)),
    openingMarks: share(t => /[¿¡]/.test(t))};
}

// Descripción breve para los prompts; solo agregados, nunca frases literales.
export function describeShape(shape) {
  if (!shape) return null;
  const pct = x => `${Math.round(x * 100)} %`;
  return `Suele responder con unos ${shape.medianChars} caracteres (75 % de sus respuestas tienen ${shape.p75Chars} o menos). `
    + `Varias líneas en ${pct(shape.multiLine)} de los casos; empieza con mayúscula en ${pct(shape.upperStart)}; `
    + `termina en punto en ${pct(shape.endsWithPeriod)}; usa ¿ o ¡ en ${pct(shape.openingMarks)}.`;
}
