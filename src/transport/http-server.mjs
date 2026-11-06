import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { verifyMetaSignature, inboundTextEvents } from '../infra/whatsapp.mjs';
import { normalizePhone } from '../config.mjs';
import { enqueueIncoming } from '../app/inbound-service.mjs';
import { resolve } from 'node:path';
import { handleTrainingRoutes } from './training-routes.mjs';
import { handleGraphRoutes } from './graph-routes.mjs';

const VALID_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function parseSessionId(value) {
  if (value === undefined || value === null) return 'default';
  return typeof value === 'string' && VALID_SESSION_ID.test(value) ? value : null;
}

function isAuthenticated(header, token) {
  if (!token || token.length < 32 || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
function send(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store',
    'x-content-type-options':'nosniff'});
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw Object.assign(new Error('Body demasiado grande'), {status: 413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Devuelve errores de importación accionables sin publicar rutas, cabeceras o trazas.
function classifyImportError(err, config) {
  const message = String(err?.message ?? '');
  const stage = err?.importStage ?? 'unknown';
  if (/No se encontraron mensajes válidos|No encontré mensajes|Especifica nombres distintos|TXT >/.test(message))
    return {status: 422, body: {error: message, code: 'CHAT_FORMAT_INVALID', stage,
      hint: 'Revisa que el TXT sea una exportación de WhatsApp y que self y peer sean autores exactos.'}};
  if (err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'EPERM')
    return {status: 503, body: {error: 'No se pudo leer el TXT compartido con FastAPI', code: 'UPLOAD_NOT_READABLE', stage,
      hint: 'Comprueba los volúmenes y permisos de /uploads en app y fastapi.'}};
  if (stage === 'embed' && /^Ollama 404:/.test(message))
    return {status: 503, body: {error: 'Ollama no encuentra el modelo de embeddings', code: 'EMBED_MODEL_NOT_FOUND', stage,
      hint: `Comprueba los modelos con: docker compose exec ollama ollama list. Si falta, ejecuta: docker compose exec ollama ollama pull ${config.embedModel ?? 'embeddinggemma'}`}};
  if (stage === 'embed')
    return {status: 502, body: {error: 'Falló la generación de embeddings con Ollama', code: 'OLLAMA_EMBED_FAILED', stage,
      hint: 'Revisa docker compose logs --tail=100 ollama y comprueba el modelo EMBED_MODEL.'}};
  if (/Qdrant HTTP (401|403):/.test(message))
    return {status: 502, body: {error: 'Qdrant rechazó las credenciales', code: 'QDRANT_AUTH_FAILED', stage,
      hint: 'Revisa QDRANT_API_KEY y la configuración del servicio qdrant en Docker Compose.'}};
  if (/Qdrant HTTP /.test(message) || ['vector', 'check'].includes(stage))
    return {status: 502, body: {error: 'No se pudo consultar o guardar el historial en Qdrant', code: 'QDRANT_FAILED', stage,
      hint: 'Revisa docker compose logs --tail=100 qdrant, QDRANT_COLLECTION y el modelo de embeddings.'}};
  return {status: 500, body: {error: 'Error interno al importar el historial', code: 'IMPORT_FAILED', stage,
    hint: 'Revisa docker compose logs --tail=100 app y busca Fallo importando TXT.'}};
}

// Respuestas de diagnóstico seguras para pruebas RAG; nunca exponen prompts o datos de chats.
function classifyPreviewError(err, config) {
  const message = String(err?.message ?? '');
  const stage = err?.previewStage ?? 'unknown';
  const languageStage=['chat','regenerate','route','review','content','content_review','style','style_review'].includes(stage);
  const reasoningStage=['route','review','content','content_review','style_review'].includes(stage);
  const model = languageStage ? (reasoningStage ? config.reasoningModel || config.chatModel : config.chatModel) : config.embedModel;
  if (/^Ollama 404:/.test(message))
    return {status: 503, body: {error: languageStage ? 'No está disponible el modelo de conversación de Ollama' : 'No está disponible el modelo de embeddings de Ollama',
      code: languageStage ? 'CHAT_MODEL_NOT_FOUND' : 'EMBED_MODEL_NOT_FOUND', stage,
      hint: `Revisa docker compose exec ollama ollama list. Si falta el modelo, ejecuta: docker compose exec ollama ollama pull ${model ?? 'modelo-configurado'}`}};
  if (/Qdrant HTTP (401|403):/.test(message))
    return {status: 502, body: {error: 'Qdrant rechazó la autenticación', code: 'QDRANT_AUTH_FAILED', stage,
      hint: 'Comprueba QDRANT_API_KEY y los registros de qdrant.'}};
  if (/Qdrant HTTP /.test(message) || (stage === 'search' && /dimensiones|Embedding inválido/.test(message)))
    return {status: 502, body: {error: 'La búsqueda de memoria en Qdrant ha fallado', code: 'MEMORY_SEARCH_FAILED', stage,
      hint: 'Revisa QDRANT_COLLECTION, EMBED_MODEL y docker compose logs --tail=100 qdrant.'}};
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed out|timeout/i.test(message))
    return {status: 504, body: {error: 'Se agotó el tiempo de espera durante la prueba', code: 'PREVIEW_TIMEOUT', stage,
      hint: 'Comprueba recursos de Ollama y docker compose logs --tail=100 ollama.'}};
  // Ollama respondió, pero el contenido no superó la revisión o no cumplió el contrato esperado.
  if (err?.name === 'DraftRejectedError' || err?.code === 'REVIEW_REJECTED')
    return {status: 422, body: {error: 'El borrador no superó la revisión de coherencia', code: 'REVIEW_REJECTED', stage,
      hint: 'Ollama funciona; reformula el mensaje o revisa el hilo de la sesión con debug_rag=true.'}};
  if (/inválid|incomplet|vací|Estilo incompleto/i.test(message) && languageStage)
    return {status: 502, body: {error: 'El modelo devolvió una respuesta que no cumple el formato esperado', code: 'MODEL_OUTPUT_INVALID', stage,
      hint: `Repite la prueba; si persiste, revisa el modelo ${model ?? 'configurado'} con debug_rag=true.`}};
  if (['chat','regenerate','embed','review','content','content_review','style','style_review'].includes(stage))
    return {status: 502, body: {error: 'Ollama no pudo completar la prueba', code: 'OLLAMA_PREVIEW_FAILED', stage,
      hint: 'Comprueba docker compose logs --tail=100 ollama y los modelos instalados.'}};
  if (stage === 'search')
    return {status: 502, body: {error: 'No se pudo consultar el índice de memoria', code: 'MEMORY_SEARCH_FAILED', stage,
      hint: 'Comprueba docker compose logs --tail=100 qdrant y la conectividad entre los servicios.'}};
  return {status: 500, body: {error: 'No se pudo generar el borrador de prueba', code: 'PREVIEW_FAILED', stage,
    hint: 'Revisa docker compose logs --tail=100 app y busca Fallo de preview.'}};
}

export function createHttpServer({config, repository, worker, replies, memories, imports, whatsapp, training, models, knowledge}) {
  if (config.adminToken.length < 32 || config.adminToken.startsWith('CAMBIA_'))
    throw new Error('ADMIN_TOKEN debe ser un secreto real (mínimo 32 caracteres), no el ejemplo');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return send(res, 200, {ok: true, app: 'chat-ai-memory'});
      if (config.waProvider === 'web' && path === '/webhook') return send(res, 404, {error: 'Webhook desactivado en modo WhatsApp Web'});
      if (path === '/webhook' && req.method === 'GET') {
        const valid = config.wa.verifyToken && url.searchParams.get('hub.mode') === 'subscribe' &&
          url.searchParams.get('hub.verify_token') === config.wa.verifyToken;
        if (!valid) return send(res, 403, {error: 'Verificación rechazada'});
        res.writeHead(200, {'content-type': 'text/plain'});
        return res.end(url.searchParams.get('hub.challenge') ?? '');
      }
      if (path === '/webhook' && req.method === 'POST') {
        const raw = await readBody(req);
        if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], config.wa.appSecret))
          return send(res, 403, {error: 'Firma inválida'});
        const payload = JSON.parse(raw.toString('utf8'));
        let queued = 0;
        for (const item of inboundTextEvents(payload)) {
          if (enqueueIncoming({config, repository}, item)) queued++;
        }
        return send(res, 200, {ok: true, queued});
      }
      // Todo lo demás requiere token administrativo; no se expone a interlocutores.
      if (!isAuthenticated(req.headers.authorization, config.adminToken)) return send(res, 401, {error: 'No autorizado'});
      const readJson = async () => JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (await handleTrainingRoutes({req, res, path, url, training, models, send, readJson})) return;
      if (await handleGraphRoutes({req, res, path, url, knowledge, config, send, readJson})) return;
      // Resumen de configuración para la interfaz; nunca incluye secretos ni tokens.
      if (req.method === 'GET' && path === '/api/system')
        return send(res, 200, {system: {selfName: config.selfName, chatModel: config.chatModel,
          reasoningModel: config.reasoningModel || config.chatModel, embedModel: config.embedModel,
          replyPipeline: config.replyPipeline ?? 'direct', replyCandidates: config.replyCandidates ?? 1,
          replyReview: config.replyReview === true, semanticRouter: config.semanticRouter === true,
          autoSend: config.autoSend === true, waProvider: config.waProvider ?? 'cloud',
          memoryBackend: config.memoryBackend ?? null, allowedContacts: config.allowedContacts.size}});
      if (req.method === 'GET' && path === '/api/whatsapp/status')
        return send(res, 200, {whatsapp: whatsapp?.getStatus?.() ?? {provider: config.waProvider ?? 'cloud', state: 'unknown'}});
      if (req.method === 'GET' && path === '/api/whatsapp/qr.svg') {
        const svg = await whatsapp?.getQrSvg?.();
        if (!svg) return send(res, 409, {error: 'No hay QR disponible: comprueba el estado de WhatsApp'});
        res.writeHead(200, {'content-type':'image/svg+xml; charset=utf-8', 'cache-control':'no-store',
          'x-content-type-options':'nosniff', 'content-security-policy':"default-src 'none'; sandbox"});
        return res.end(svg);
      }
      if (req.method === 'GET' && path === '/api/contacts')
        return send(res, 200, {allowlist: [...config.allowedContacts], contacts: repository.listContacts()});
      if (req.method === 'GET' && path === '/api/drafts') return send(res, 200, {drafts: repository.listDrafts()});
      const draftMatch = path.match(/^\/api\/drafts\/([\w:.-]+)\/send$/);
      if (req.method === 'POST' && draftMatch) {
        const id = await worker.sendDraft(draftMatch[1]);
        return send(res, 200, {sent: true, messageId: id});
      }
      if ((req.method === 'GET' || req.method === 'DELETE') && path === '/api/preview/history') {
        const contact = normalizePhone(url.searchParams.get('contact'));
        if (!config.allowedContacts.has(contact)) return send(res, 403, {error: 'Contacto fuera de allowlist'});
        const sessionId = parseSessionId(url.searchParams.get('session_id'));
        if (!sessionId) return send(res, 422, {error: 'session_id inválido'});
        if (req.method === 'DELETE') {
          return send(res, 200, {contact, session_id: sessionId, deleted: repository.clearPreview(contact, sessionId)});
        }
        const limit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 300)
          return send(res, 422, {error: 'limit debe ser un entero entre 1 y 300'});
        return send(res, 200, {contact, session_id: sessionId, messages: repository.recentPreview(contact, sessionId, limit)});
      }
      if (req.method === 'POST' && path === '/api/preview') {
        const data = JSON.parse((await readBody(req)).toString('utf8'));
        const contact = normalizePhone(data.contact);
        if (!config.allowedContacts.has(contact)) return send(res, 403, {error: 'Contacto fuera de allowlist'});
        if (typeof data.text !== 'string' || !data.text.trim()) return send(res, 400, {error: 'Falta text'});
        const mode = data.mode ?? 'reply'; // compatible con solicitudes antiguas
        if (mode !== 'reply' && mode !== 'memory_query')
          return send(res, 422, {error: 'Modo inválido', code: 'INVALID_PREVIEW_MODE',
            hint: 'Usa mode=reply o mode=memory_query.'});
        const sessionId = parseSessionId(data.session_id);
        if (!sessionId) return send(res, 422, {error: 'session_id inválido', code: 'INVALID_SESSION_ID'});
        if (data.debug_rag !== undefined && typeof data.debug_rag !== 'boolean')
          return send(res, 422, {error: 'debug_rag debe ser booleano'});
        if (data.rag_policy !== undefined && !['auto', 'force', 'off'].includes(data.rag_policy))
          return send(res, 422, {error: 'rag_policy debe ser auto, force u off'});
        if (mode === 'memory_query' && data.rag_policy && data.rag_policy !== 'auto')
          return send(res, 422, {error: 'rag_policy solo se aplica a reply'});
        if (data.save !== undefined && typeof data.save !== 'boolean')
          return send(res, 422, {error: 'save debe ser booleano'});
        if (data.writer_model !== undefined && data.writer_model !== null) {
          if (mode !== 'reply' || typeof data.writer_model !== 'string' || !/^[A-Za-z0-9_.:\/-]{1,80}$/.test(data.writer_model))
            return send(res, 422, {error: 'writer_model inválido o solo aplicable a reply', code: 'INVALID_WRITER_MODEL'});
          try {await models?.assertWriter(data.writer_model);}
          catch {return send(res, 422, {error: 'writer_model no está instalado en Ollama', code: 'WRITER_MODEL_NOT_FOUND'});}
        }
        if (data.recent_messages != null && (!Array.isArray(data.recent_messages) || data.recent_messages.some(m =>
          !m || typeof m !== 'object' || !(m.side || m.role) || typeof (m.text ?? m.content) !== 'string' || !(m.text ?? m.content).trim())))
          return send(res, 422, {error: 'recent_messages contiene turnos sin side/role o sin text/content', code: 'INVALID_RECENT_MESSAGES',
            hint: 'Usa [{"side":"peer","text":"..."},{"side":"self","text":"..."}] u omite el campo para usar el historial de la sesión.'});
        try {
          if (mode === 'memory_query') {
            const result = await replies.queryMemory(contact, data.text, data.debug_rag === true);
            return send(res, 200, {mode, answer: result.answer, evidence: result.evidence, sent: false, ...(result.rag ? {rag: result.rag} : {})});
          }
          // Las pruebas con modo reply usan un historial de simulación aislado.
          // En test doubles antiguos sin previewReply se conserva generate.
          const result = replies.previewReply
            ? await replies.previewReply(contact, data.text, sessionId, data.debug_rag === true, data.rag_policy ?? 'auto', {
                recentMessages: Array.isArray(data.recent_messages) ? data.recent_messages : null,
                includeRealRecent: data.include_recent === true,
                ...(data.writer_model ? {writerModel: data.writer_model} : {})
              })
            : {answer: await replies.generate(contact, data.text)};
          const answer = result.answer;
          const approved = result.approved !== false;
          // Un borrador no aprobado no entra al hilo: sus invenciones contaminarían los turnos siguientes.
          const saved = data.save !== false && approved;
          if (saved) repository.savePreviewTurn(contact, sessionId, data.text.trim().slice(0, 2500), answer);
          return send(res, 200, {mode, answer, approved, ...(approved ? {} : {review_reason: result.reviewReason ?? ''}),
            sent: false, session_id: sessionId, saved, ...(result.rag ? {rag: result.rag} : {})});
        } catch (err) {
          const diagnostic = classifyPreviewError(err, config);
          console.error(`Fallo de preview (fase=${diagnostic.body.stage}, codigo=${diagnostic.body.code}):`, err?.message);
          return send(res, diagnostic.status, {...diagnostic.body,...(data.debug_rag === true && err.replyProfile ? {profile:err.replyProfile} : {})});
        }
      }
      if (req.method === 'GET' && path === '/api/rag/metrics')
        return send(res,200,{metrics:replies.getMetrics?.() ?? {}});
      if (req.method === 'POST' && path === '/api/rag/search') {
        const data=JSON.parse((await readBody(req)).toString('utf8'));
        const contact=normalizePhone(data.contact);
        if (!config.allowedContacts.has(contact))return send(res,403,{error:'Contacto fuera de allowlist'});
        if(typeof data.question!=='string' || !data.question.trim() || data.question.length>2500)
          return send(res,422,{error:'Pregunta inválida'});
        const result=await replies.inspectRetrieval(contact,data.question);
        return send(res,200,result);
      }
      if (req.method === 'GET' && path === '/api/chats/imports') {
        const contact = normalizePhone(url.searchParams.get('contact'));
        if (!config.allowedContacts.has(contact)) return send(res, 403, {error: 'Contacto fuera de allowlist'});
        return send(res, 200, {imports: repository.listChatImports(contact)});
      }
      if (req.method === 'POST' && path === '/api/chats/import') {
        if (!imports) return send(res, 503, {error: 'Importador no disponible'});
        const data = JSON.parse((await readBody(req)).toString('utf8'));
        const contact = normalizePhone(data.contact);
        if (!config.allowedContacts.has(contact)) return send(res, 403, {error: 'Contacto fuera de allowlist'});
        // El nombre lo genera FastAPI, no se aceptan rutas arbitrarias del usuario.
        if (typeof data.filename !== 'string' || !/^upload-[a-f0-9]{32}\.txt$/.test(data.filename))
          return send(res, 400, {error: 'Archivo de importación inválido'});
        const self = typeof data.self === 'string' ? data.self.trim() : '';
        const peer = typeof data.peer === 'string' ? data.peer.trim() : '';
        if (!self || !peer || self.length > 100 || peer.length > 100 || self.toLowerCase() === peer.toLowerCase())
          return send(res, 400, {error: 'Indica nombres distintos de self y peer (máximo 100 caracteres)'});
        try {
          const result = await imports.importFile({path: resolve(process.env.UPLOAD_DIR ?? '/uploads', data.filename),
            contact, self, peer, fileName: String(data.originalFilename ?? 'chat.txt').slice(0, 200)});
          return send(res, 200, {...result, linkedTo: contact});
        } catch (err) {
          const diagnostic = classifyImportError(err, config);
          console.error(`Fallo importando TXT (fase=${diagnostic.body.stage}, codigo=${diagnostic.body.code}):`, err?.message);
          return send(res, diagnostic.status, diagnostic.body);
        }
      }
      if (req.method === 'GET' && path === '/api/memories') {
        const contact = normalizePhone(url.searchParams.get('contact'));
        if (!config.allowedContacts.has(contact)) return send(res, 403, {error: 'Contacto fuera de allowlist'});
        return send(res, 200, {memories: repository.listMemories(contact)});
      }
      if (req.method === 'POST' && path === '/api/memories') {
        const data = JSON.parse((await readBody(req)).toString('utf8'));
        const contact = normalizePhone(data.contact);
        if (!config.allowedContacts.has(contact)) return send(res, 403, {error: 'Contacto fuera de allowlist'});
        const id = memories ? await memories.add(contact, String(data.fact ?? '')) : repository.remember(contact, String(data.fact ?? ''));
        return send(res, 201, {id});
      }
      if (req.method === 'DELETE' && path === '/api/memories') {
        const contact = normalizePhone(url.searchParams.get('contact'));
        const id = Number(url.searchParams.get('id'));
        if (!config.allowedContacts.has(contact) || !Number.isSafeInteger(id)) return send(res, 403, {error: 'No autorizado'});
        return send(res, 200, {deleted: memories ? await memories.delete(contact, id) : repository.deleteMemory(contact, id)});
      }
      return send(res, 404, {error: 'Ruta no encontrada'});
    } catch (err) {
      console.error('Error HTTP:', err.message);
      return send(res, err.status ?? (err instanceof SyntaxError ? 400 : 500), {error: 'Solicitud no procesada'});
    }
  });
}
