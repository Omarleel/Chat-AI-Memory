import {ApiError} from '../application/ports.js';

// Adaptador HTTP del puerto AdminApi contra FastAPI (/api/v1). El token solo viaja al mismo origen.
export function createHttpAdminApi({getToken, baseUrl = '', fetchImpl = (...a) => fetch(...a), onUnauthorized = () => {}, origin}) {
  const base = origin ?? globalThis.location?.origin ?? 'http://localhost';
  async function request(method, path, {query, json, form, raw = false} = {}) {
    const url = new URL(`${baseUrl}/api/v1${path}`, base);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const headers = {Authorization: `Bearer ${getToken()}`};
    let body;
    if (json !== undefined) {headers['Content-Type'] = 'application/json'; body = JSON.stringify(json);}
    if (form) body = form;
    let response;
    try {response = await fetchImpl(url, {method, headers, body});}
    catch {throw new ApiError('No se pudo conectar con FastAPI. ¿Está levantado docker compose?', {status: 0});}
    if (response.status === 401) {onUnauthorized(); throw new ApiError('Token inválido o caducado', {status: 401});}
    if (!response.ok) throw await toError(response);
    return raw ? response : response.json();
  }
  return {
    system: async () => (await request('GET', '/system')).system,
    whatsappStatus: async () => (await request('GET', '/whatsapp/status')).whatsapp,
    async whatsappQrUrl() {
      try {return URL.createObjectURL(await (await request('GET', '/whatsapp/qr.svg', {raw: true})).blob());}
      catch (error) {if (error.status === 409) return null; throw error;}
    },
    contacts: () => request('GET', '/contacts'),
    chatImports: async contact => (await request('GET', '/chats/imports', {query: {contact}})).imports,
    importChat({file, contact, self, peer}) {
      const form = new FormData();
      form.append('file', file);
      form.append('contact', contact);
      form.append('self', self);
      form.append('peer', peer);
      return request('POST', '/chats/import', {form});
    },
    preview: input => request('POST', '/preview', {json: input}),
    previewHistory: async (contact, sessionId) =>
      (await request('GET', '/preview/history', {query: {contact, session_id: sessionId, limit: 300}})).messages,
    clearPreview: async (contact, sessionId) =>
      (await request('DELETE', '/preview/history', {query: {contact, session_id: sessionId}})).deleted,
    memories: async contact => (await request('GET', '/memories', {query: {contact}})).memories,
    addMemory: (contact, fact) => request('POST', '/memories', {json: {contact, fact}}),
    deleteMemory: (contact, id) => request('DELETE', `/memories/${id}`, {query: {contact}}),
    drafts: async () => (await request('GET', '/drafts')).drafts,
    sendDraft: id => request('POST', `/drafts/${encodeURIComponent(id)}/send`),
    ragSearch: (contact, question) => request('POST', '/rag/search', {json: {contact, question}}),
    ragMetrics: async () => (await request('GET', '/rag/metrics')).metrics,
    models: async () => (await request('GET', '/models')).models,
    trainingSources: async () => (await request('GET', '/training/sources')).sources,
    trainingRunner: async () => (await request('GET', '/training/runner')).runner,
    trainingPlan: async input => (await request('POST', '/training/plan', {json: input})).plan,
    trainingJobs: async () => (await request('GET', '/training/jobs')).jobs,
    createTrainingJob: async input => (await request('POST', '/training/jobs', {json: input})).job,
    trainingJob: (id, afterLog = 0) => request('GET', `/training/jobs/${id}`, {query: {after_log: afterLog}}),
    cancelTrainingJob: async id => (await request('POST', `/training/jobs/${id}/cancel`)).job,
    calibrateReviewer: async id => (await request('POST', `/training/jobs/${id}/calibrate-reviewer`)).job,
    burstLabeling: async () => (await request('GET', '/training/cleaning')).labeling,
    startBurstLabeling: async input => (await request('POST', '/training/cleaning/label', input)).labeling,
    pauseBurstLabeling: async () => (await request('POST', '/training/cleaning/pause')).labeling,
    graphStatus: contact => request('GET', '/graph/status', {query: {contact}}),
    startGraphExtraction: async input => (await request('POST', '/graph/extraction/start', {json: input})).extraction,
    pauseGraphExtraction: async contact => (await request('POST', '/graph/extraction/pause', {json: {contact}})).paused,
    rebuildGraph: async contact => (await request('POST', '/graph/rebuild', {json: {contact}})).rebuilt,
    graphEntities: async (contact, q) => (await request('GET', '/graph/entities', {query: {contact, q}})).entities,
    graphEntity: (contact, key) => request('GET', '/graph/entity', {query: {contact, key}})
  };
}

// FastAPI devuelve {detail: "mensaje [CODIGO]. pista"} o, en validación, {detail: [{loc, msg}]}.
export async function toError(response) {
  let detail = null;
  try {detail = (await response.json())?.detail;} catch {}
  if (Array.isArray(detail)) {
    const first = detail[0];
    const where = (first?.loc ?? []).slice(1).join('.') || 'la petición';
    return new ApiError(`Dato inválido en ${where}: ${first?.msg ?? ''}`, {status: response.status});
  }
  const text = typeof detail === 'string' ? detail : `Error ${response.status}`;
  return new ApiError(text, {status: response.status, code: /\[([A-Z_]+)\]/.exec(text)?.[1] ?? null});
}
