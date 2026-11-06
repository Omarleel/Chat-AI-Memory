import {normalizePhone} from '../config.mjs';

// Rutas del grafo de conocimiento. Devuelve false si la ruta no le corresponde.
export async function handleGraphRoutes({req, res, path, url, knowledge, config, send, readJson}) {
  if (!path.startsWith('/api/graph')) return false;
  const reply = (status, body) => {send(res, status, body); return true;};
  if (!knowledge) return reply(503, {error: 'Grafo de conocimiento no disponible'});
  const body = req.method === 'POST' ? await readJson() : {};
  const contact = normalizePhone(req.method === 'GET' ? url.searchParams.get('contact') : body.contact);
  if (!config.allowedContacts.has(contact)) return reply(403, {error: 'Contacto fuera de allowlist'});
  try {
    if (req.method === 'GET' && path === '/api/graph/status')
      return reply(200, {enabled: knowledge.graphEnabled, extraction: knowledge.status(contact), stats: await knowledge.stats(contact)});
    if (req.method === 'POST' && path === '/api/graph/extraction/start') {
      if (typeof body.importHash !== 'string' || !/^[a-f0-9]{16,64}$/.test(body.importHash)) return reply(422, {error: 'importHash inválido'});
      const max = body.maxMessages === undefined || body.maxMessages === null ? null : Number(body.maxMessages);
      if (max !== null && (!Number.isSafeInteger(max) || max < 16 || max > 200000)) return reply(422, {error: 'maxMessages debe estar entre 16 y 200000'});
      return reply(202, {extraction: knowledge.start(contact, body.importHash, {maxMessages: max})});
    }
    if (req.method === 'POST' && path === '/api/graph/extraction/pause') return reply(200, {paused: knowledge.pause(contact)});
    if (req.method === 'POST' && path === '/api/graph/review') return reply(202, {review: knowledge.startReview(contact)});
    if (req.method === 'POST' && path === '/api/graph/rebuild') return reply(200, {rebuilt: await knowledge.rebuild(contact)});
    if (req.method === 'GET' && path === '/api/graph/entities') {
      const q = String(url.searchParams.get('q') ?? '').trim();
      if (q.length > 80) return reply(422, {error: 'Búsqueda demasiado larga'});
      return reply(200, {entities: await knowledge.searchEntities(contact, q)});
    }
    if (req.method === 'GET' && path === '/api/graph/entity') {
      const detail = await knowledge.entity(contact, String(url.searchParams.get('key') ?? '').slice(0, 120));
      return detail ? reply(200, detail) : reply(404, {error: 'Entidad inexistente'});
    }
    return reply(404, {error: 'Ruta no encontrada'});
  } catch (err) {
    if (err.status) return reply(err.status, {error: err.message});
    if (/Neo4j/.test(err.message)) return reply(502, {error: 'Neo4j no respondió', code: 'NEO4J_FAILED'});
    throw err;
  }
}
