// Intercambios reales del titular para que el revisor juzgue con el criterio de esa persona
// (cuánto escribe, qué tan seco o breve es) en lugar del criterio genérico de un asistente.
// Todo se deriva de los datos de cada identidad: no hay umbrales ni frases fijas.

const words = t => new Set(String(t ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const usable = t => t && !/omitid|<Multimedia|eliminó este mensaje|<Se editó/i.test(t);

// Pares "le escribieron → respondió" desde el historial (turnos: mensajes seguidos del mismo autor).
export function historyPairs(messages) {
  const pairs = [];
  let peer = [], self = [];
  const flush = () => {
    if (peer.length && self.length) pairs.push({incoming: peer.join('\n'), reply: self.join('\n')});
    if (self.length) peer = [];
    self = [];
  };
  for (const m of messages ?? []) {
    const text = String(m?.text ?? '').trim();
    // Un mensaje sin texto útil corta el turno: lo que siga respondería a algo que no vemos.
    if (!usable(text)) {flush(); peer = []; continue;}
    if (m.role === 'self') self.push(text);
    else {if (self.length) flush(); peer.push(text);}
  }
  flush();
  return pairs;
}

// Pares desde filas del dataset de entrenamiento (último turno del interlocutor → respuesta).
export function datasetPairs(rows) {
  return (rows ?? []).map(r => ({incoming: r.prompt?.at(-1)?.content, reply: r.completion?.[0]?.content}))
    .filter(p => usable(p.incoming) && usable(p.reply));
}

// Muestra por cuantiles de longitud: refleja la distribución real (si casi todo es "ok", casi todo sale "ok").
export function typicalPairs(pairs, n = 5) {
  const sorted = pairs.filter(p => p.reply.length <= 220).sort((a, b) => a.reply.length - b.reply.length || (a.reply < b.reply ? -1 : 1));
  if (sorted.length <= n) return sorted;
  return Array.from({length: n}, (_, i) => sorted[Math.floor((i + 0.5) * sorted.length / n)]);
}

export function relevantPairs(pairs, text, n = 3, index = null) {
  const q = words(text);
  if (!q.size) return [];
  const sets = index ?? pairs.map(p => words(p.incoming));
  return pairs.map((p, i) => [p, [...sets[i]].filter(w => q.has(w)).length])
    .filter(([p, k]) => k > 0 && p.reply.length <= 220).sort((a, b) => b[1] - a[1]).slice(0, n).map(([p]) => p);
}

// Relevantes al mensaje + típicos de la identidad, sin duplicados.
export function holderExamples({relevant = [], typical = [], limit = 8}) {
  const seen = new Set(), out = [];
  for (const p of [...relevant, ...typical]) {
    const k = `${p.incoming}\u0000${p.reply}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push({they: String(p.incoming).slice(0, 200), reply: String(p.reply).slice(0, 220)});
    if (out.length >= limit) break;
  }
  return out;
}

// Selector reutilizable sobre un conjunto fijo de pares (p. ej. solo train en una evaluación).
export function exampleSelector(pairs, {relevant = 3, typical = 5} = {}) {
  const index = pairs.map(p => words(p.incoming));
  const base = typicalPairs(pairs, typical);
  return text => holderExamples({relevant: relevantPairs(pairs, text, relevant, index), typical: base, limit: relevant + typical});
}

// Opción 3 (heurística, desactivada por defecto): aprobar sin revisor lo que no supera la
// mediana de longitud propia de la identidad y no contiene cifras. El límite sale de cada titular.
export function shortApprovalLimit(shape, mode) {
  return mode === 'shape' && Number.isFinite(shape?.medianChars) ? shape.medianChars : null;
}
export function isShortApprovable(draft, limit) {
  const t = String(draft ?? '').trim();
  return Number.isFinite(limit) && t.length > 0 && t.length <= limit && !/\p{N}/u.test(t);
}
