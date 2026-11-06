// Detección de autores en una exportación TXT de WhatsApp, solo para sugerir self/peer en el formulario.
// Admite "[dd/mm/aa, hh:mm(:ss)] Autor: texto" y "dd/mm/aa, hh:mm - Autor: texto" (con o sin a. m./p. m.).
const LINE = /^‎?\[?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s?[ap]\.?\s?m\.?)?\]?\s*(?:-\s*)?([^:]{1,80}):\s/i;

export function detectAuthors(text, maxLines = 20000) {
  const counts = new Map();
  const lines = String(text).split(/\r?\n/, maxLines);
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) continue;
    const author = m[3].replace(/[‎‪-‮]/g, '').trim();
    if (author) counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, messages]) => ({name, messages}));
}
