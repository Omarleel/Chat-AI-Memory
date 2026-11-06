import { extractDeterministicTriplets } from '../domain/triplet-extractor.mjs';

/**
 * Servicio de sincronización asíncrona de GraphRAG hacia Neo4j.
 * Ejecuta la extracción de entidades y relaciones en segundo plano
 * tras la importación de un chat para no bloquear la respuesta HTTP.
 */
export class GraphSyncService {
  constructor({ repository, neo4j, config = {}, knowledge = null } = {}) {
    this.repository = repository;
    this.knowledge = knowledge;
    this.neo4j = neo4j;
    this.config = config;
    this.queue = [];
    this.isProcessing = false;
  }

  enqueue(contact) {
    if (!contact || !this.neo4j || this.config.neo4jEnabled === false || this.neo4j.enabled === false) {
      return false;
    }
    const cleanContact = String(contact).trim();
    if (!this.queue.includes(cleanContact)) {
      this.queue.push(cleanContact);
    }
    // Disparar procesamiento asíncrono en segundo plano sin bloquear el hilo actual
    setImmediate(() => {
      this._processQueue().catch(err => {
        console.error('[GraphSync] Error en cola de segundo plano:', err.message);
      });
    });
    return true;
  }

  async _processQueue() {
    if (this.isProcessing || !this.queue.length) return;
    this.isProcessing = true;
    try {
      while (this.queue.length > 0) {
        const contact = this.queue.shift();
        try {
          await this.syncContact(contact);
        } catch (err) {
          console.error(`[GraphSync] Error sincronizando grafo para ${contact}:`, err.message);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async syncContact(contact) {
    if (!this.neo4j || this.config.neo4jEnabled === false || this.neo4j.enabled === false) {
      return null;
    }
    const isHealthy = typeof this.neo4j.isHealthy === 'function' ? await this.neo4j.isHealthy() : true;
    if (!isHealthy) {
      console.warn(`[GraphSync] Neo4j no disponible en ${this.config.neo4jUrl ?? ''}, omitiendo para ${contact}`);
      return null;
    }
    if (typeof this.neo4j.initSchema === 'function') {
      await this.neo4j.initSchema().catch(() => {});
    }

    console.log(`[GraphSync] Sincronizando grafo en segundo plano para contacto ${contact}...`);
    // Con el grafo de conocimiento, la proyección completa (hechos verificados + reglas) se reconstruye desde SQLite.
    if (this.knowledge) {
      const rebuilt = await this.knowledge.rebuild(contact);
      console.log(`[GraphSync] Grafo reconstruido para ${contact}: ${rebuilt.facts} hechos verificados.`);
      return {contact, ...rebuilt, status: 'success'};
    }

    // 1. Memorias autobiográficas verificadas (provenance audit)
    let syncedMemories = 0;
    if (typeof this.repository.listLearnedMemories === 'function' && typeof this.neo4j.upsertVerifiedMemory === 'function') {
      const rows = this.repository.listLearnedMemories(contact, 100000, { includeSuperseded: true }) || [];
      for (const memory of rows) {
        try {
          if (await this.neo4j.upsertVerifiedMemory(contact, memory)) syncedMemories++;
        } catch (err) {
          console.warn('[GraphSync] Error sincronizando memoria verificada:', err.message);
        }
      }
    }

    // 2. Extracción de tripletas deterministas desde mensajes importados
    let allMessages = [];
    try {
      allMessages = this.repository.db?.prepare?.(
        'SELECT id, import_hash, author, role, text, timestamp FROM imported_messages WHERE contact=? ORDER BY ordinal ASC'
      )?.all(contact) || [];
    } catch {
      allMessages = [];
    }

    const rawTriplets = [];
    const imports = typeof this.repository.listChatImports === 'function' ? this.repository.listChatImports(contact) : [];
    const namesByImport = new Map(imports.map(imp => [imp.importHash, {
      self: imp.self || this.config.selfName,
      peer: imp.peer || 'Interlocutor'
    }]));

    for (const m of allMessages) {
      const text = String(m.text ?? '').trim();
      if (text.length < 5) continue;
      const names = namesByImport.get(m.import_hash) ?? { self: this.config.selfName, peer: 'Interlocutor' };
      if (!['self', 'peer'].includes(m.role)) continue;
      const author = m.role === 'self' ? names.self : names.peer;
      const peer = m.role === 'self' ? names.peer : names.self;
      const extracted = extractDeterministicTriplets(text, { author, peer });
      for (const t of extracted) {
        if (t.object && t.object.length <= 40 && !/\b(?:mrd|xd|desde hace)\b/i.test(t.object)) {
          rawTriplets.push({
            ...t,
            date: m.timestamp,
            sourceMessageId: String(m.id)
          });
        }
      }
    }

    // Deduplicación de tripletas
    const seen = new Set();
    const dedupedTriplets = [];
    for (const t of rawTriplets) {
      const key = `${t.subject}:${t.relation}:${t.object}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        dedupedTriplets.push(t);
      }
    }

    let syncedTriplets = 0;
    if (typeof this.neo4j.upsertManyTriplets === 'function') {
      syncedTriplets = await this.neo4j.upsertManyTriplets(contact, dedupedTriplets);
    }

    const report = {
      contact,
      verifiedMemoriesSynced: syncedMemories,
      entityTripletsSynced: syncedTriplets,
      totalTriplets: dedupedTriplets.length,
      status: 'success'
    };

    console.log(`[GraphSync] Grafo sincronizado exitosamente para ${contact}: ${syncedTriplets} tripletas, ${syncedMemories} memorias.`);
    return report;
  }
}

