import {parseModelJson} from '../domain/semantic-decisions.mjs';
import {RELATIONS, applyVerification, entityKey, extractionBatches, extractionInput, extractionPrompt, validateGraphFacts,
  verificationInput, verificationPrompt} from '../domain/knowledge-graph.mjs';

const PAGE = 400;
const MAX_CONSECUTIVE_FAILURES = 5;

// Hechos verificados → aristas del grafo. Cada arista conserva su procedencia (cita, mensaje, fecha).
export function factToEdge(m) {
  if (!m.relation || !RELATIONS[m.relation] || !m.subject || !m.object) return null;
  return {uid: `m${m.id}`, relation: m.relation,
    subject: {key: entityKey(m.subject), name: m.subject, type: m.subject_type ?? 'otro'},
    object: {key: entityKey(m.object), name: m.object, type: m.object_type ?? 'otro'},
    props: {memory_id: m.id, fact: m.fact, quote: m.quote, source_id: m.source_id, occurred_at: m.occurred_at ?? null,
      speaker: m.speaker, origin: 'llm'}};
}

// Extracción en segundo plano, reanudable y pausable. SQLite guarda hechos y cursor;
// Neo4j es una proyección que se puede reconstruir en cualquier momento.
export class KnowledgeGraphService {
  constructor({repository, neo4j = null, llm, config}) {
    Object.assign(this, {repository, neo4j, llm, config});
    this.active = null;
    // Un arranque nuevo no tiene extracciones vivas: las que quedaron "en curso" pasan a pausa.
    for (const contact of config.allowedContacts ?? [])
      for (const row of repository.listGraphExtractions?.(contact) ?? [])
        if (row.state === 'running') repository.saveGraphExtraction({...row, state: 'paused', message: 'Interrumpida por reinicio'});
  }

  get graphEnabled() {return !!this.neo4j && this.neo4j.enabled !== false && this.config.neo4jEnabled !== false;}

  status(contact) {
    const imports = this.repository.listChatImports(contact);
    const rows = new Map((this.repository.listGraphExtractions(contact) ?? []).map(r => [r.import_hash, r]));
    const review = this.lastReview?.contact === contact ? (({contact: _, stop, ...rest}) => rest)(this.lastReview) : null;
    return {active: this.active ? {contact: this.active.contact, importHash: this.active.importHash ?? null, kind: this.active.kind ?? 'extraction'} : null,
      review,
      model: this.config.reasoningModel || this.config.chatModel,
      imports: imports.map(i => {
        const r = rows.get(i.importHash);
        return {importHash: i.importHash, fileName: i.fileName, self: i.self, peer: i.peer, totalMessages: i.messages,
          state: r?.state ?? 'idle', processedMessages: r?.processed_messages ?? 0, batches: r?.batches ?? 0,
          failures: r?.failures ?? 0, inserted: r?.inserted ?? 0, elapsedMs: r?.elapsed_ms ?? 0, message: r?.message ?? null,
          cursor: r?.cursor_ordinal ?? -1, updatedAt: r?.updated_at ?? null};
      }),
      facts: this.repository.learnedMemoryStats(contact)};
  }

  // Arranca (o reanuda) la extracción de una importación. maxMessages limita la tanda (útil para pilotos).
  start(contact, importHash, {maxMessages = null} = {}) {
    if (this.active) throw Object.assign(new Error('Ya hay una extracción en curso'), {status: 409});
    const source = this.repository.getChatImport(contact, importHash);
    if (!source) throw Object.assign(new Error('Importación inexistente'), {status: 404});
    const previous = this.repository.getGraphExtraction(contact, importHash);
    if (previous?.state === 'done') throw Object.assign(new Error('Esta importación ya se procesó por completo'), {status: 409});
    const limit = maxMessages === null ? null : Math.max(16, Math.min(200000, Number(maxMessages) || 0));
    const row = this.repository.saveGraphExtraction({...(previous ?? {contact, import_hash: importHash}),
      total_messages: source.messages, state: 'running', model: this.config.reasoningModel || this.config.chatModel, message: null});
    this.active = {contact, importHash, stop: false, limit, startedAt: Date.now()};
    this._run(source, row).catch(error => {
      this.repository.saveGraphExtraction({...this.repository.getGraphExtraction(contact, importHash), state: 'failed', message: String(error.message).slice(0, 300)});
    }).finally(() => {this.active = null;});
    return this.status(contact);
  }

  pause(contact) {
    if (!this.active || this.active.contact !== contact) return false;
    this.active.stop = true;
    return true;
  }

  async _run(source, initial) {
    const {contact, importHash} = this.active;
    const names = {selfName: source.self, peerName: source.peer};
    const system = extractionPrompt(names);
    let row = initial, processedThisRun = 0, consecutive = 0;
    if (this.graphEnabled) {await this.neo4j.initKnowledgeSchema?.(); await this.neo4j.dropLegacy?.(contact);}
    while (!this.active.stop) {
      const page = this.repository.listImportMessagesAfter(contact, importHash, row.cursor_ordinal, PAGE);
      if (!page.length) {
        row = this.repository.saveGraphExtraction({...row, state: 'done', message: 'Completada'});
        return;
      }
      for (const batch of extractionBatches(page)) {
        if (this.active.stop) break;
        const began = Date.now();
        let inserted = [];
        if (batch.targets.length) {
          try {
            inserted = this._save(contact, await this._extract(system, batch, names, contact));
            consecutive = 0;
          } catch (error) {
            consecutive++;
            row = {...row, failures: row.failures + 1, message: String(error.message).slice(0, 200)};
            if (consecutive >= MAX_CONSECUTIVE_FAILURES) throw new Error(`Demasiados fallos seguidos: ${error.message}`);
          }
        }
        const covered = page.filter(m => m.ordinal > row.cursor_ordinal && m.ordinal <= batch.lastOrdinal).length;
        processedThisRun += covered;
        row = this.repository.saveGraphExtraction({...row, cursor_ordinal: batch.lastOrdinal, processed_messages: row.processed_messages + covered,
          batches: row.batches + (batch.targets.length ? 1 : 0), inserted: row.inserted + inserted.length,
          elapsed_ms: row.elapsed_ms + (Date.now() - began), state: 'running'});
        if (this.active.limit && processedThisRun >= this.active.limit) this.active.stop = true;
      }
    }
    this.repository.saveGraphExtraction({...row, state: 'paused', message: this.active.limit && processedThisRun >= this.active.limit ? 'Tanda completada' : 'Pausada'});
  }

  // Extracción + verificación de cada hecho contra su cita y su contexto. Solo lo verificado llega a SQLite.
  async _extract(system, batch, names, contact) {
    const result = await this.llm.chatDetails(system, extractionInput(batch, names), {format: 'json', temperature: 0, maxTokens: 900, allowContinuation: false});
    const facts = result.truncated ? [] : validateGraphFacts(parseModelJson(result.content), batch.targets, names);
    const kept = [];
    for (const f of facts) {
      const verdict = await this._verify(contact, f, names);
      if (verdict) kept.push(verdict);
    }
    return kept;
  }

  // Un hecho por llamada: en lote, el modelo contagia el juicio de un hecho a sus vecinos.
  // Devuelve el hecho sostenido (con entidades resueltas), false si se rechaza o null si el verificador no respondió.
  async _verify(contact, fact, names) {
    const window = this.repository.importMessageWindow?.(contact, fact.sourceId)?.messages ?? [];
    const check = await this.llm.chatDetails(verificationPrompt(names), verificationInput([fact], names, [window]),
      {format: 'json', temperature: 0, maxTokens: 500, allowContinuation: false});
    if (check.truncated) return null;
    const payload = parseModelJson(check.content);
    if (!Array.isArray(payload?.results)) return null;
    return applyVerification(payload, [fact], names)[0] ?? false;
  }

  // Revisa los hechos ya guardados con el verificador actual: rechaza los no sostenidos y resuelve entidades.
  // Comparte el turno con la extracción (una sola tarea pesada a la vez) y al terminar reconstruye la proyección.
  startReview(contact) {
    if (this.active) throw Object.assign(new Error('Ya hay una tarea del grafo en curso'), {status: 409});
    this.active = {contact, kind: 'review', stop: false, reviewed: 0, rejected: 0, renamed: 0, failures: 0, total: 0};
    this.lastReview = this.active;
    this.review(contact, this.active).catch(error => {this.lastReview.error = String(error.message).slice(0, 300);})
      .finally(() => {this.active = null;});
    return this.active;
  }

  async review(contact, progress = {stop: false, reviewed: 0, rejected: 0, renamed: 0, failures: 0}) {
    const imports = new Map(this.repository.listChatImports(contact).map(i => [i.importHash, {selfName: i.self, peerName: i.peer}]));
    const rows = this.repository.listLearnedMemories(contact, 200000).filter(m => m.relation);
    progress.total = rows.length;
    for (const m of rows) {
      if (progress.stop) break;
      const names = imports.get(this.repository.importMessageWindow(contact, m.source_id, 0, 0).importHash);
      const fact = {speaker: m.speaker, subject: m.subject, relation: m.relation, object: m.object, fact: m.fact, quote: m.quote, sourceId: m.source_id};
      let verdict = null;
      if (names) try {verdict = await this._verify(contact, fact, names);} catch {verdict = null;}
      progress.reviewed++;
      if (verdict === null) progress.failures++;
      else if (!verdict) {this.repository.reviseLearnedMemory(contact, m.id, {status: 'rejected'}); progress.rejected++;}
      else if (verdict.subject !== m.subject || verdict.object !== m.object) {
        this.repository.reviseLearnedMemory(contact, m.id, {subject: verdict.subject, object: verdict.object, key: verdict.key});
        progress.renamed++;
      }
    }
    if (this.graphEnabled && !progress.stop) progress.rebuilt = await this.rebuild(contact);
    return progress;
  }

  // Guarda en SQLite (fuente de verdad) y proyecta solo lo nuevo en Neo4j.
  _save(contact, facts) {
    const saved = facts.filter(f => this.repository.saveLearnedMemory(contact, f, {source: 'import'}));
    if (saved.length && this.graphEnabled) {
      const rows = this.repository.listLearnedMemories(contact, saved.length);
      this.neo4j.projectFacts(contact, rows.map(factToEdge).filter(Boolean)).catch(() => {});
    }
    return saved;
  }

  // Hechos de un mensaje real entrante (WhatsApp), con el mismo validador que la extracción histórica.
  async learnLive(contact, message, names) {
    const batch = {context: [], targets: [{...message, role: 'peer'}]};
    const saved = this._save(contact, await this._extract(extractionPrompt(names), batch, names, contact));
    return {inserted: saved.length};
  }

  // Reconstruye la proyección desde SQLite: solo hechos verificados.
  async rebuild(contact) {
    if (!this.graphEnabled) throw Object.assign(new Error('Neo4j está desactivado'), {status: 409});
    await this.neo4j.initKnowledgeSchema();
    await this.neo4j.clearContact(contact);
    const facts = this.repository.listLearnedMemories(contact, 200000).map(factToEdge).filter(Boolean);
    await this.neo4j.projectFacts(contact, facts);
    return {facts: facts.length};
  }

  async stats(contact) {
    return {sqlite: this.repository.learnedMemoryStats(contact), neo4j: this.graphEnabled ? await this.neo4j.graphStats(contact).catch(() => null) : null};
  }

  async searchEntities(contact, query) {
    if (!this.graphEnabled) return [];
    return this.neo4j.searchEntities(contact, entityKey(query));
  }

  async entity(contact, key) {
    if (!this.graphEnabled) return null;
    return this.neo4j.entityRelations(contact, entityKey(key));
  }

  // Hechos para una respuesta: grafo si está activo; si no, búsqueda por términos en SQLite.
  async retrieve(contact, terms, limit = 10) {
    const keys = [...new Set(terms.map(entityKey).filter(k => k.length >= 3))];
    if (!keys.length) return [];
    if (this.graphEnabled) {
      try {return await this.neo4j.factsAround(contact, keys, limit);} catch {/* respaldo SQLite */}
    }
    return this.repository.searchLearnedMemories(contact, keys, limit).map(m => ({relation: m.relation, fact: m.fact, quote: m.quote,
      source_id: m.source_id, occurred_at: m.occurred_at, speaker: m.speaker, subject: m.subject, object: m.object, origin: 'llm', hop: 0}));
  }
}
