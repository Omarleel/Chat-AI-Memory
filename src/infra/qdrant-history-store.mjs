import {createHash} from 'node:crypto';
import {hasWord} from '../domain/rag-ranking.mjs';

// Adapter for vector memory: history fragments and curator-approved facts.
// This is a vector store, NOT a graph database. All reads filter by contact.
const uuid = (value) => {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const match = (key, value) => ({key, match: {value}});
const by = (...conditions) => ({must: conditions.map(([key, value]) => match(key, value))});
const safeCollection = (name) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('Nombre de colección Qdrant inválido');
  return name;
};
function checkVector(vector, size) {
  if (!Array.isArray(vector) || !vector.length || vector.some(v => !Number.isFinite(v)) || (size && vector.length !== size))
    throw new Error('Embedding inválido o dimensiones inconsistentes');
}

export class QdrantHistoryStore {
  constructor({baseUrl, collection = 'whatsapp_memory_v1', apiKey = '', embedModel = 'embeddinggemma', fetchImpl = fetch}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.collection = safeCollection(collection);
    this.apiKey = apiKey;
    this.embedModel = embedModel;
    this.fetch = fetchImpl;
    this.dimension = null;
  }
  get path() { return `/collections/${this.collection}`; }
  async request(method, route, body, {allow404 = false} = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetch(`${this.baseUrl}${route}`, {
          method,
          headers: {'content-type': 'application/json', ...(this.apiKey ? {'api-key': this.apiKey} : {})},
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
          signal: AbortSignal.timeout(45000)
        });
        if (allow404 && response.status === 404) return null;
        if (!response.ok) throw new Error(`Qdrant HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`);
        return response.json();
      } catch (err) {
        if (attempt === 0 && (err?.cause?.code === 'UND_ERR_SOCKET' || String(err?.message).includes('fetch failed'))) {
          continue;
        }
        throw err;
      }
    }
  }
  async details() { return this.request('GET', this.path, undefined, {allow404: true}); }
  async ensureCollection(size) {
    checkVector(Array(size).fill(0));
    if (this.dimension === size) return;
    if (this.dimension && this.dimension !== size) throw new Error(`Embeddings: ${size} dimensiones, colección: ${this.dimension}; usa otra QDRANT_COLLECTION y reimporta`);
    let existing = await this.details();
    if (!existing) {
      try { await this.request('PUT', this.path, {vectors: {size, distance: 'Cosine'}}); }
      catch (err) { existing = await this.details(); if (!existing) throw err; }
      if (!existing) {
        // Payload indexes must exist before ingestion for efficient filtered ANN search.
        for (const key of ['contact', 'import_hash', 'kind', 'embed_model']) {
          await this.request('PUT', `${this.path}/index?wait=true`, {field_name: key, field_schema: 'keyword'});
        }
        await this.request('PUT', `${this.path}/index?wait=true`, {field_name: 'memory_id', field_schema: 'integer'});
      }
    }
    existing ??= await this.details();
    const vectors = existing?.result?.config?.params?.vectors;
    const actual = vectors?.size;
    if (actual !== size || vectors?.distance !== 'Cosine')
      throw new Error(`Qdrant: colección incompatible (${actual ?? 'desconocido'} dims). Cambia QDRANT_COLLECTION y reimporta.`);
    this.dimension = actual;
  }
  async count(filter) {
    const existing = await this.details();
    if (!existing) return 0;
    const data = await this.request('POST', `${this.path}/points/count`, {filter, exact: true});
    return data.result?.count ?? 0;
  }
  async hasImport(contact, hash, expectedChunks) {
    return await this.count(by(['contact', contact], ['embed_model', this.embedModel], ['kind', 'history'], ['import_hash', hash])) >= expectedChunks;
  }
  async countHistory(contact) {
    return this.count(by(['contact', contact], ['embed_model', this.embedModel], ['kind', 'history']));
  }
  async saveChunks(contact, hash, offset, texts, vectors, chunkMetas = []) {
    if (texts.length !== vectors.length) throw new Error('Faltan embeddings del lote');
    if (!vectors.length) return;
    vectors.forEach(vector => checkVector(vector, vectors[0].length));
    await this.ensureCollection(vectors[0].length);
    const points = texts.map((body, i) => ({
      id: uuid(`history:${this.embedModel}:${contact}:${hash}:${offset + i}`),
      vector: vectors[i],
      payload: {
        kind: 'history',
        embed_model: this.embedModel,
        contact,
        import_hash: hash,
        ordinal: offset + i,
        body,
        message_ids: chunkMetas[i]?.messageIds ?? [],
        start_iso: chunkMetas[i]?.startIso ?? null,
        end_iso: chunkMetas[i]?.endIso ?? null
      }
    }));
    await this.request('PUT', `${this.path}/points?wait=true`, {points});
  }
  async saveMemory(contact, id, fact, vector) {
    checkVector(vector);
    await this.ensureCollection(vector.length);
    const point = {id: uuid(`fact:${contact}:${id}`), vector, payload: {
      kind: 'fact', embed_model: this.embedModel, contact, memory_id: id, body: `Hecho revisado: ${fact}`
    }};
    await this.request('PUT', `${this.path}/points?wait=true`, {points: [point]});
  }
  async deleteMemory(contact, id) {
    if (!await this.details()) return;
    await this.request('POST', `${this.path}/points/delete?wait=true`, {
      filter: by(['contact', contact], ['memory_id', id], ['kind', 'fact'])
    });
  }
  async search(contact, vector, limit = 5) {
    checkVector(vector);
    const existing = await this.details();
    if (!existing) return [];
    // Qdrant enforces dimension too; fail early with a useful message.
    const actual = existing.result?.config?.params?.vectors?.size;
    if (actual !== vector.length) throw new Error(`El modelo de embeddings cambió (${vector.length} vs ${actual}). Reindexa en otra colección.`);
    const data = await this.request('POST', `${this.path}/points/query`, {
      query: vector,
      filter: by(['contact', contact], ['embed_model', this.embedModel]),
      limit, with_payload: true, with_vector: false, score_threshold: 0.05
    });
    return (data.result?.points ?? []).filter(p => typeof p.payload?.body === 'string')
      .map(p => ({
        body: p.payload.body,
        score: p.score,
        kind: p.payload.kind,
        messageIds: p.payload.message_ids ?? [],
        ordinal: p.payload.ordinal,
        importHash: p.payload.import_hash,
        timestamp: p.payload.start_iso,
        startIso: p.payload.start_iso
      }));
  }
  // Recuperación lexical de nombres en índices EXISTENTES, sin reimportar. El
  // scroll solo lee payload, no vectores, y está limitado a 1000 puntos/contacto
  // para no bloquear conversaciones con historiales muy grandes.
  async searchByTerms(contact, terms, limit = 12) {
    const normalized = [...new Set(terms.map(t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()).filter(t => t.length >= 3))].slice(0, 4);
    if (!normalized.length || !await this.details()) return [];
    const results = [];
    let offset;
    for (let inspected = 0; inspected < 1000;) {
      const pageSize = Math.min(250, 1000 - inspected);
      const response = await this.request('POST', `${this.path}/points/scroll`, {
        filter: by(['contact', contact], ['embed_model', this.embedModel], ['kind', 'history']),
        limit: pageSize, with_payload: ['body'], with_vector: false,
        ...(offset === undefined ? {} : {offset})
      });
      const page = response.result?.points ?? [];
      inspected += page.length;
      for (const point of page) {
        const body = point.payload?.body;
        if (typeof body === 'string' && normalized.some(w => hasWord(body, w)))
          results.push({body, kind: 'history', origin: 'lexical'});
      }
      offset = response.result?.next_page_offset;
      if (!page.length || offset === null || offset === undefined) break;
    }
    return results.slice(0, Math.max(1, limit));
  }
  async eraseContact(contact) {
    if (!await this.details()) return;
    await this.request('POST', `${this.path}/points/delete?wait=true`, {filter: by(['contact', contact])});
  }
}
