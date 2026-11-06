// Reranking conservador para chats: la semejanza vectorial aislada no basta para
// inferir hechos sobre personas. Opera sobre resultados ya filtrados por contacto.

const STOP = new Set(`a al algo alguien ante antes asi aun aunque bajo bien cada como con contra cual cuales cuando de del desde donde dos el ella ellos en entre era es esa ese eso esta estas este esto fue ha hay la las le les lo los mas me mi mis muy no nos o para pero por porque que quien se si sin sobre su sus te ti tu tus un una uno unos unas y ya yo hacer hago haces quieres quiero gusto gusta gustar puedo podria seria esta estoy ir vamos vas fue fueron digo dijo dime oye oe hola gracias entonces vez ahora hoy manana mañana despues sobre cual cuales`.split(' '));

const META_WORDS = new Set(`explica cuentame cuenta dime recuerda distingue resume detalle menciona habla sabes sabias conoces paso tiempo evolucion historial chats mensajes`.split(' '));

const norm = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const words = text => (norm(text).match(/[a-zñ0-9]{3,}/g) ?? []).filter(w => !STOP.has(w) && !META_WORDS.has(w));

const clipText = (text, max) => { const t = String(text ?? ''); return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t; };

// Fragmento con los mensajes vecinos de una coincidencia. Los vecinos son contexto: un mensaje enorme
// pegado (un log, un documento) se recorta para no ocupar el fragmento y dejar fuera el que coincidió.
export function neighborBody(neighbors, hitIds = []) {
  const hits = new Set(hitIds);
  return neighbors.map(n => `${n.rawTimestamp ?? n.timestamp} · ${n.author}: ${clipText(n.text, hits.has(n.id) ? 600 : 200)}`).join('\n');
}

// Coincidencia de palabra completa: "listo" no debe encontrar "alisto".
export const hasWord = (text, word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(norm(text));

// Palabras con mayúscula como posibles nombres propios. Al inicio de una frase la mayúscula no dice nada
// ("Listo", "Dale"): con isName (p. ej. derivado del historial) solo se conservan las que lo son.
export const queryAnchors = (text, { selfName = '', peerName = '', isName = null } = {}) => {
  const authorWords = new Set([
    ...norm(selfName).split(/\s+/),
    ...norm(peerName).split(/\s+/)
  ].filter(w => w && w.length >= 3));

  const matches = [...String(text).matchAll(/(?<![\p{L}\p{N}])\p{Lu}\p{L}{2,}/gu)]
    .filter(m => !isName || !/^[\s¡¿"'(]*$|[.!?\n][\s¡¿"'(]*$/u.test(String(text).slice(0, m.index)) || isName(norm(m[0])))
    .map(m => norm(m[0]))
    .filter(w => !STOP.has(w) && !META_WORDS.has(w) && w.length >= 4);

  // Si hay palabras que no son autores del chat, priorizarlas como anclas reales
  const nonAuthors = matches.filter(w => !authorWords.has(w));
  return [...new Set(nonAuthors.length ? nonAuthors : matches)];
};

function lexicalScore(text, queryTerms) {
  if (!queryTerms.length) return 0;
  const haystack = norm(text);
  let matched = 0;
  for (const term of queryTerms) if (haystack.includes(term)) matched++;
  return matched / queryTerms.length;
}

// Se muestran preferentemente líneas que mencionan la entidad o los conceptos
// preguntados; no se inyecta un chunk entero con temas colindantes sin relación.
function excerpt(body, terms, anchors, maxChars = 850) {
  const lines = String(body).split('\n');
  if (lines.length <= 2 && body.length <= maxChars) return String(body);
  const relevant = [];
  for (const [i, line] of lines.entries()) {
    const l = norm(line);
    const hits = anchors.length ? anchors.some(a => hasWord(l, a)) : terms.some(t => l.includes(t));
    if (hits) relevant.push(i);
  }
  if (!relevant.length) return String(body).slice(0, maxChars);
  // Hasta seis líneas pertinentes, conservando su fecha y autor originales.
  return relevant.slice(0, 6).map(i => lines[i]).join('\n').slice(0, maxChars);
}

// Comprueba si dos textos son sustancialmente duplicados (> 70% de solapamiento de líneas)
function areDuplicates(textA, textB) {
  const linesA = norm(textA).split('\n').map(l => l.replace(/^[^:]+:\s*/, '').trim()).filter(l => l.length > 5);
  const linesB = new Set(norm(textB).split('\n').map(l => l.replace(/^[^:]+:\s*/, '').trim()).filter(l => l.length > 5));
  if (!linesA.length || !linesB.size) return false;
  let matches = 0;
  for (const l of linesA) {
    if (linesB.has(l)) matches++;
  }
  return (matches / linesA.length) >= 0.65;
}

export function rankEvidence(question, candidates, {limit = 5, minScore = 0.38, selfName = '', peerName = '', sortByDate = false, anchors: givenAnchors = null} = {}) {
  const anchors = givenAnchors ?? queryAnchors(question, { selfName, peerName });
  const terms = [...new Set(words(question))];
  const uniqueBodies = [];
  const scored = [];
  let ignoredForAnchor = 0;

  for (const candidate of candidates ?? []) {
    const body = String(candidate?.body ?? '').trim();
    if (!body) continue;
    
    // Deduplicación inteligente: evitar fragmentos casi idénticos de imports duplicados
    const isDup = uniqueBodies.some(existing => areDuplicates(body, existing));
    if (isDup) continue;
    uniqueBodies.push(body);

    const semantic = Number.isFinite(candidate.score) ? candidate.score : null;
    const lexical = lexicalScore(body, terms);
    const anchorHits = anchors.filter(a => hasWord(body, a));
    if (anchors.length && !anchorHits.length) { ignoredForAnchor++; continue; }

    // Si la pregunta tiene términos de contenido (ej. "cumpleaños"), verificar que el fragmento
    // tenga al menos alguna relevancia léxica o semántica aceptable
    const contentTerms = terms.filter(t => !anchors.includes(t));
    const contentLexical = contentTerms.length ? lexicalScore(body, contentTerms) : 1;

    // Solo vector: semejanzas demasiado débiles no dan fundamento factual.
    // Con nombre explícito se acepta coincidencia literal aunque el vector sea bajo.
    if (!anchors.length && lexical < 0.34 && (semantic === null || semantic < Math.max(0.55, minScore))) continue;
    if (!anchors.length && lexical === 0 && (semantic === null || semantic < Math.max(0.55, minScore))) continue;
    if (!anchors.length && semantic !== null && semantic < minScore && lexical < 0.5) continue;
    
    // Si la pregunta busca un hecho específico con ancla pero cero coincidencia temática y vector bajo:
    if (anchors.length && contentTerms.length >= 2 && contentLexical === 0 && (semantic === null || semantic < 0.40)) {
      // Ignorar fragmentos que solo mencionan el nombre por casualidad sin relación al hecho
      continue;
    }

    const rank = 0.60 * (semantic ?? 0) + 0.40 * lexical + (anchorHits.length ? 0.3 : 0);
    scored.push({
      ...candidate,
      body: excerpt(body, terms, anchors),
      relevance: Number(rank.toFixed(3)),
      semantic,
      lexical: Number(lexical.toFixed(3)),
      origin: candidate.origin ?? 'semantic'
    });
  }

  // Ordenar por relevancia heurística
  scored.sort((a, b) => b.relevance - a.relevance);
  let selected = scored.slice(0, limit);

  // Si se solicita orden cronológico (para consultas históricas o resúmenes en el tiempo)
  if (sortByDate) {
    selected.sort((a, b) => {
      const timeA = a.timestamp ?? (a.body.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/)?.[1] ?? '');
      const timeB = b.timestamp ?? (b.body.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/)?.[1] ?? '');
      return timeA.localeCompare(timeB);
    });
  }

  return {
    results: selected,
    stats: {
      candidates: uniqueBodies.length,
      used: selected.length,
      anchors,
      ignoredForAnchor,
      minScore,
      filtered: uniqueBodies.length - scored.length
    }
  };
}
