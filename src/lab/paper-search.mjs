// Opt-in public scientific metadata search. Never submit chat history or evaluation transcripts.
const scientific = /\b(language model|persona|dialogue|conversation|memory|retrieval|role.play|fine.tun|alignment|long.context|benchmark|evaluation|consistency|rag|lora|personalization|personalized)\b/i;
export function cleanResearchQuery(query) {
  const q = String(query ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 150);
  if (!scientific.test(q) || /@|\+?\d{8,}|https?:\/\//i.test(q))
    throw new Error('Consulta de papers inválida: usa solo términos científicos públicos, sin datos de WhatsApp');
  return q;
}
export async function searchPapers(query, { enabled = false, fetchImpl = fetch } = {}) {
  if (!enabled) return { papers: [], note: 'Investigación web desactivada. Usa --allow-web-papers para habilitarla.' };
  const q = cleanResearchQuery(query);
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', q);
  url.searchParams.set('per-page', '6');
  url.searchParams.set('sort', 'publication_date:desc');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
  const json = await response.json();
  return { papers: (json.results ?? []).slice(0, 6).map(x => ({
    title: x.title ?? '', year: x.publication_year ?? null,
    doi: x.doi ?? null, url: x.primary_location?.landing_page_url ?? x.doi ?? x.id,
    citedByCount: x.cited_by_count ?? 0, abstract: abstractFromIndex(x.abstract_inverted_index)
  })), query: q };
}
function abstractFromIndex(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [token, positions] of Object.entries(index)) {
    for (const at of positions) if (Number.isInteger(at) && at < 350 && at >= 0) words[at] = token;
  }
  return words.filter(Boolean).join(' ').slice(0, 1700);
}
