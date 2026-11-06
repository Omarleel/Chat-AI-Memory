import * as sqlite from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { cosine, extractPersonas } from '../domain/history.mjs';

const NOW = () => new Date().toISOString();
const LEARNED_COLUMNS = `id,memory_key,speaker,fact,quote,source_id,source_type,occurred_at,status,created_at,
  subject,subject_type,relation,object,object_type`;
function trainingRow(row) {
  if (!row) return null;
  const {spec_json, result_json, model_name, self_name, created_at, updated_at, started_at, finished_at, ...rest} = row;
  return {...rest, modelName: model_name, selfName: self_name, spec: JSON.parse(spec_json),
    result: result_json ? JSON.parse(result_json) : null,
    createdAt: created_at, updatedAt: updated_at, startedAt: started_at, finishedAt: finished_at};
}
export class SqliteRepository {
  constructor(path) {
    mkdirSync(dirname(path), {recursive: true});
    this.db = new (sqlite.Database ?? sqlite.DatabaseSync)(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS history_chunks (
        id INTEGER PRIMARY KEY, contact TEXT NOT NULL, import_hash TEXT NOT NULL,
        ordinal INTEGER NOT NULL, body TEXT NOT NULL, vector TEXT NOT NULL,
        message_ids TEXT,
        UNIQUE(contact, import_hash, ordinal));
      CREATE INDEX IF NOT EXISTS idx_history_contact ON history_chunks(contact);
      
      CREATE TABLE IF NOT EXISTS imported_messages (
        id TEXT PRIMARY KEY,
        contact TEXT NOT NULL,
        import_hash TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        timestamp TEXT,
        raw_timestamp TEXT NOT NULL,
        author TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        conversation_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imported_messages_contact ON imported_messages(contact, ordinal);
      CREATE INDEX IF NOT EXISTS idx_imported_messages_timestamp ON imported_messages(contact, timestamp);
      CREATE INDEX IF NOT EXISTS idx_imported_messages_hash ON imported_messages(contact, import_hash);
      CREATE INDEX IF NOT EXISTS idx_imported_pair ON imported_messages(contact,import_hash,ordinal);

      CREATE TABLE IF NOT EXISTS style_pairs (
        id INTEGER PRIMARY KEY,
        contact TEXT NOT NULL,
        incoming_text TEXT NOT NULL,
        reply_text TEXT NOT NULL,
        context_type TEXT NOT NULL,
        hash TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_style_pairs_contact ON style_pairs(contact, context_type);

      CREATE TABLE IF NOT EXISTS personas (
        contact TEXT NOT NULL,
        role TEXT NOT NULL,
        author TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (contact, role)
      );

      CREATE TABLE IF NOT EXISTS style_examples (
        id INTEGER PRIMARY KEY, contact TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
        UNIQUE(contact, hash));
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY, contact TEXT NOT NULL, fact TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (
        contact TEXT PRIMARY KEY, opted_in INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY, contact TEXT NOT NULL, side TEXT NOT NULL,
        text TEXT NOT NULL, external_id TEXT UNIQUE, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversation_messages(contact, id);
      
      CREATE TABLE IF NOT EXISTS preview_messages (
        id INTEGER PRIMARY KEY, contact TEXT NOT NULL, session_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('peer','self')), text TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_preview_contact_session
        ON preview_messages(contact, session_id, id);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, contact TEXT NOT NULL, incoming_text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', tries INTEGER NOT NULL DEFAULT 0,
        next_attempt TEXT NOT NULL, output TEXT, api_message_id TEXT, last_error TEXT,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_events_state ON events(state, next_attempt);
      CREATE TABLE IF NOT EXISTS chat_imports (
        contact TEXT NOT NULL, import_hash TEXT NOT NULL,
        file_name TEXT NOT NULL, self_name TEXT NOT NULL, peer_name TEXT NOT NULL,
        messages INTEGER NOT NULL, chunks INTEGER NOT NULL, imported_at TEXT NOT NULL,
        PRIMARY KEY(contact, import_hash));
      CREATE INDEX IF NOT EXISTS idx_chat_imports_contact ON chat_imports(contact, imported_at);
    `);
    
    // FTS5: índice de todo el historial, sin LIMIT ni scroll parcial en Qdrant.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS imported_fts USING fts5(
      contact UNINDEXED, message_id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS style_fts USING fts5(
      contact UNINDEXED, pair_id UNINDEXED, incoming, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS behavior_profiles (
        contact TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learned_memories (
        id INTEGER PRIMARY KEY, contact TEXT NOT NULL, memory_key TEXT NOT NULL,
        speaker TEXT NOT NULL, fact TEXT NOT NULL, quote TEXT NOT NULL,
        source_id TEXT NOT NULL, source_type TEXT NOT NULL, occurred_at TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
        UNIQUE(contact, source_id, memory_key, fact));
      CREATE INDEX IF NOT EXISTS idx_learned_scope ON learned_memories(contact,status,speaker,memory_key);
    `);
    // La migración consulta counts una vez: nunca hacer NOT EXISTS sobre 80k filas de una tabla FTS sin índice B-tree.
    const messageCount=this.db.prepare('SELECT count(*) AS n FROM imported_messages').get().n;
    const indexedCount=this.db.prepare('SELECT count(*) AS n FROM imported_fts').get().n;
    if(messageCount!==indexedCount) {
      this.db.exec(`DELETE FROM imported_fts;
        INSERT INTO imported_fts(contact,message_id,body)
        SELECT contact,id,text FROM imported_messages;`);
    }
    const stylesCount=this.db.prepare('SELECT count(*) AS n FROM style_pairs').get().n;
    const indexedStyles=this.db.prepare('SELECT count(*) AS n FROM style_fts').get().n;
    if(stylesCount!==indexedStyles) {
      this.db.exec(`DELETE FROM style_fts;
        INSERT INTO style_fts(contact,pair_id,incoming)
        SELECT contact,CAST(id AS TEXT),incoming_text FROM style_pairs;`);
    }

    // Trabajos de entrenamiento de identidad: el ejecutor local los reclama y notifica su avance.
    this.db.exec(`CREATE TABLE IF NOT EXISTS training_jobs (
        id TEXT PRIMARY KEY, model_name TEXT NOT NULL, tag TEXT NOT NULL, self_name TEXT NOT NULL,
        spec_json TEXT NOT NULL, state TEXT NOT NULL, stage TEXT, progress REAL NOT NULL DEFAULT 0,
        message TEXT, result_json TEXT, runner TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_training_jobs_state ON training_jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS training_job_logs (
        id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at TEXT NOT NULL, line TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_training_logs_job ON training_job_logs(job_id, id);
    `);
    // Hechos estructurados para el grafo: columnas opcionales sobre learned_memories (SQLite sigue siendo la fuente).
    for (const column of ['subject TEXT', 'subject_type TEXT', 'relation TEXT', 'object TEXT', 'object_type TEXT']) {
      try { this.db.exec(`ALTER TABLE learned_memories ADD COLUMN ${column}`); } catch { /* ya existe */ }
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_learned_relation ON learned_memories(contact, relation);
      CREATE TABLE IF NOT EXISTS graph_extraction (
        contact TEXT NOT NULL, import_hash TEXT NOT NULL, cursor_ordinal INTEGER NOT NULL DEFAULT -1,
        total_messages INTEGER NOT NULL DEFAULT 0, processed_messages INTEGER NOT NULL DEFAULT 0,
        batches INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'idle', model TEXT, message TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL, PRIMARY KEY(contact, import_hash));
      -- Etiquetas de limpieza de ráfagas para entrenar (por hash de fila del dataset; sin texto).
      CREATE TABLE IF NOT EXISTS burst_labels (
        row_hash TEXT PRIMARY KEY, keep INTEGER NOT NULL, kinds_json TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL);
    `);
    // Migración transparente si message_ids no existe en history_chunks preexistente
    try {
      this.db.exec('ALTER TABLE history_chunks ADD COLUMN message_ids TEXT');
    } catch {
      // Ya existe la columna
    }
  }
  close() { this.db.close(); }
  recordChatImport({contact, importHash, fileName, self, peer, messages, chunks}) {
    this.db.prepare(`INSERT INTO chat_imports(contact,import_hash,file_name,self_name,peer_name,messages,chunks,imported_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(contact,import_hash) DO NOTHING`)
      .run(contact, importHash, fileName, self, peer, messages, chunks, NOW());
  }
  listChatImports(contact) {
    return this.db.prepare(`SELECT contact,import_hash AS importHash,file_name AS fileName,
      self_name AS self,peer_name AS peer,messages,chunks,imported_at AS importedAt
      FROM chat_imports WHERE contact=? ORDER BY imported_at DESC`).all(contact);
  }
  hasImport(contact, hash, expectedChunks) {
    const {n} = this.db.prepare('SELECT COUNT(*) AS n FROM history_chunks WHERE contact=? AND import_hash=?').get(contact, hash);
    return n >= expectedChunks;
  }
  saveChunks(contact, hash, offset, texts, vectors, chunkMetas = []) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO history_chunks(contact,import_hash,ordinal,body,vector,message_ids) VALUES(?,?,?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = 0; i < texts.length; i++) {
        const meta = chunkMetas[i];
        const msgIds = meta?.messageIds ? JSON.stringify(meta.messageIds) : null;
        stmt.run(contact, hash, offset + i, texts[i], JSON.stringify(vectors[i]), msgIds);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getImportedBatch(contact, offset=0, limit=24) {
    return this.db.prepare(`SELECT id, role, text, timestamp FROM imported_messages
      WHERE contact=? ORDER BY timestamp,import_hash,ordinal LIMIT ? OFFSET ?`).all(contact,limit,offset);
  }
  saveImportedMessages(contact, importHash, messages) {
    if (!messages?.length) return;
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO imported_messages
      (id, contact, import_hash, ordinal, timestamp, raw_timestamp, author, role, text, conversation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const fts = this.db.prepare(`INSERT INTO imported_fts(contact,message_id,body) VALUES(?,?,?)`);
    const delFts = this.db.prepare('DELETE FROM imported_fts WHERE contact=? AND message_id=?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = NOW();
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const id = m.id ?? `msg_${createHash('sha256').update(`${contact}:${importHash}:${m.ordinal ?? i}`).digest('hex').slice(0,24)}`;
        stmt.run(id, contact, importHash, m.ordinal ?? i, m.isoTimestamp ?? null, m.rawTimestamp ?? m.timestamp,
          m.author, m.role ?? 'unknown', m.text, m.conversationId ?? null, now);
        delFts.run(contact, id);
        fts.run(contact, id, m.text);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  countImportedMessages(contact, importHash = null) {
    if (importHash) {
      return this.db.prepare('SELECT COUNT(*) AS n FROM imported_messages WHERE contact=? AND import_hash=?').get(contact, importHash)?.n ?? 0;
    }
    return this.db.prepare('SELECT COUNT(*) AS n FROM imported_messages WHERE contact=?').get(contact)?.n ?? 0;
  }
  getNeighbors(contact, messageIds, countBefore = 2, countAfter = 2) {
    if (!messageIds?.length) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    const targets = this.db.prepare(`SELECT contact, import_hash, ordinal FROM imported_messages
      WHERE contact=? AND id IN (${placeholders})`).all(contact, ...messageIds);
    if (!targets.length) return [];
    const results = [];
    const seen = new Set();
    for (const t of targets) {
      const minOrd = Math.max(0, t.ordinal - countBefore);
      const maxOrd = t.ordinal + countAfter;
      const neighbors = this.db.prepare(`SELECT id, ordinal, timestamp, raw_timestamp AS rawTimestamp, author, role, text
        FROM imported_messages WHERE contact=? AND import_hash=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal`)
        .all(contact, t.import_hash, minOrd, maxOrd);
      for (const n of neighbors) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          results.push(n);
        }
      }
    }
    return results.sort((a,b)=> (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || a.ordinal-b.ordinal);
  }
  saveStyles(contact, examples) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO style_examples(contact,text,hash) VALUES(?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const text of examples) stmt.run(contact, text, createHash('sha256').update(text).digest('hex'));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  listStyles(contact, limit = 16) {
    return this.db.prepare('SELECT text FROM style_examples WHERE contact=? ORDER BY id DESC LIMIT ?').all(contact, limit).map(x => x.text);
  }
  saveStylePairs(contact, pairs) {
    if (!pairs?.length) return;
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO style_pairs
      (contact, incoming_text, reply_text, context_type, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const styleFts = this.db.prepare('INSERT INTO style_fts(contact,pair_id,incoming) VALUES(?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = NOW();
      for (const p of pairs) {
        const inserted = stmt.run(contact, p.incoming, p.reply, p.contextType, p.hash, now);
        if (inserted.changes) styleFts.run(contact, String(inserted.lastInsertRowid), p.incoming);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  listStylePairs(contact, limit = 10, contextType = null) {
    if (contextType) {
      return this.db.prepare(`SELECT incoming_text AS incoming, reply_text AS reply, context_type AS contextType
        FROM style_pairs WHERE contact=? AND context_type=? ORDER BY id DESC LIMIT ?`).all(contact, contextType, limit);
    }
    return this.db.prepare(`SELECT incoming_text AS incoming, reply_text AS reply, context_type AS contextType
      FROM style_pairs WHERE contact=? ORDER BY id DESC LIMIT ?`).all(contact, limit);
  }
  findRelevantStylePairs(contact, queryText, limit = 6) {
    const rawWords = String(queryText ?? '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !['para', 'como', 'pero', 'este', 'esta', 'todo', 'nada', 'bueno', 'hola', 'bien', 'mano', 'causa', 'oyes'].includes(w));

    let matched = [];
    const seen = new Set();

    // 1. Priorizar búsqueda en imported_messages (todo el historial real del chat)
    if (rawWords.length > 0) {
      const conditions = rawWords.map(() => 'LOWER(m1.text) LIKE ?').join(' OR ');
      const params = [contact, ...rawWords.map(w => `%${w}%`), limit];
      try {
        const rows = this.db.prepare(`
          SELECT m1.text AS incoming, m2.text AS reply, 'imported_history' AS contextType
          FROM imported_messages m1
          JOIN imported_messages m2 ON m1.contact = m2.contact AND m1.import_hash = m2.import_hash AND m2.ordinal = m1.ordinal + 1
          WHERE m1.contact = ? AND m1.role = 'peer' AND m2.role = 'self'
            AND (${conditions})
            AND NOT (m1.text LIKE '%<Multimedia%' OR m2.text LIKE '%<Multimedia%' OR m2.text LIKE '%<Se editó%')
            AND LENGTH(m2.text) BETWEEN 2 AND 180
          ORDER BY m1.ordinal DESC
          LIMIT ?
        `).all(...params);
        for (const r of rows) {
          const key = `${r.incoming}|||${r.reply}`;
          if (!seen.has(key)) {
            seen.add(key);
            matched.push(r);
          }
        }
      } catch {}
    }

    // 2. Si faltan pares, complementar con style_pairs
    if (matched.length < limit && rawWords.length > 0) {
      const conditions = rawWords.map(() => '(LOWER(incoming_text) LIKE ? OR LOWER(reply_text) LIKE ?)').join(' OR ');
      const params = [contact];
      for (const w of rawWords) params.push(`%${w}%`, `%${w}%`);
      params.push(limit - matched.length);
      try {
        const extra = this.db.prepare(`
          SELECT incoming_text AS incoming, reply_text AS reply, context_type AS contextType
          FROM style_pairs
          WHERE contact=? AND (${conditions})
          ORDER BY id DESC LIMIT ?
        `).all(...params);
        for (const e of extra) {
          const key = `${e.incoming}|||${e.reply}`;
          if (!seen.has(key)) {
            seen.add(key);
            matched.push(e);
          }
        }
      } catch {}
    }

    // 3. Fallback: pares recientes de imported_messages en lugar de los mismos de 2021
    if (matched.length < limit) {
      try {
        const recentReal = this.db.prepare(`
          SELECT m1.text AS incoming, m2.text AS reply, 'recent_imported' AS contextType
          FROM imported_messages m1
          JOIN imported_messages m2 ON m1.contact = m2.contact AND m1.import_hash = m2.import_hash AND m2.ordinal = m1.ordinal + 1
          WHERE m1.contact = ? AND m1.role = 'peer' AND m2.role = 'self'
            AND NOT (m1.text LIKE '%<Multimedia%' OR m2.text LIKE '%<Multimedia%' OR m2.text LIKE '%<Se editó%')
            AND LENGTH(m2.text) BETWEEN 2 AND 120
          ORDER BY m1.ordinal DESC
          LIMIT ?
        `).all(contact, limit - matched.length);
        for (const r of recentReal) {
          const key = `${r.incoming}|||${r.reply}`;
          if (!seen.has(key)) {
            seen.add(key);
            matched.push(r);
          }
        }
      } catch {}
    }

    // 4. Último fallback a style_pairs
    if (matched.length < limit) {
      try {
        const fallback = this.db.prepare(`
          SELECT incoming_text AS incoming, reply_text AS reply, context_type AS contextType
          FROM style_pairs
          WHERE contact=?
          ORDER BY id DESC LIMIT 30
        `).all(contact);
        for (const f of fallback) {
          const key = `${f.incoming}|||${f.reply}`;
          if (!seen.has(key)) {
            seen.add(key);
            matched.push(f);
            if (matched.length >= limit) break;
          }
        }
      } catch {}
    }

    return matched;
  }
  search(contact, vector, limit = 5) {
    const rows = this.db.prepare('SELECT body, vector, message_ids FROM history_chunks WHERE contact=?').all(contact);
    return rows.map(({body, vector: v, message_ids}) => ({
      body,
      score: cosine(vector, JSON.parse(v)),
      messageIds: message_ids ? JSON.parse(message_ids) : []
    })).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0, limit);
  }
  // FTS5 BM25 usa todo el historial del contacto y preserva procedencia del mensaje.
  searchByTerms(contact, terms, limit = 20) {
    const safe = [...new Set((terms ?? []).flatMap(t=>String(t).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .match(/[\p{L}\p{N}]{2,}/gu) ?? []))].slice(0,16);
    if (!safe.length) return [];
    const expression = safe.map(t=>`"${t.replaceAll('"','')}"`).join(' OR ');
    const rows = this.db.prepare(`SELECT m.id,m.text,m.timestamp,m.raw_timestamp,m.author,m.role,
      m.import_hash,m.ordinal, bm25(imported_fts) AS bm25
      FROM imported_fts JOIN imported_messages m ON m.id=imported_fts.message_id AND m.contact=imported_fts.contact
      WHERE imported_fts MATCH ? AND imported_fts.contact=?
      ORDER BY bm25(imported_fts) LIMIT ?`).all(expression, contact, limit);
    return rows.map(m=>({body:`${m.raw_timestamp ?? m.timestamp} · ${m.author}: ${m.text}`,
      kind:'history',origin:'bm25',messageIds:[m.id],timestamp:m.timestamp,author:m.author,
      importHash:m.import_hash,ordinal:m.ordinal,bm25:m.bm25}));
  }
  // ¿Es un nombre propio en este chat? Se mira cómo se escribe la palabra en mitad de frase, donde la
  // mayúscula sí distingue: "Listo" al inicio no es un nombre, "Valdora" escrito así a media frase sí.
  isProperNoun(contact, word) {
    const w = String(word ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (!/^[\p{L}\p{N}]{2,}$/u.test(w)) return false;
    const rows = this.db.prepare(`SELECT body FROM imported_fts WHERE imported_fts MATCH ? AND contact=? LIMIT 400`).all(`"${w}"`, contact);
    let upper = 0, total = 0;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'giu');
    for (const {body} of rows) {
      const text = String(body).normalize('NFD').replace(/[̀-ͯ]/g, '');
      for (const m of text.matchAll(re)) {
        if (/^[\s¡¿"'(]*$|[.!?\n][\s¡¿"'(]*$/u.test(text.slice(0, m.index))) continue;
        total++; if (m[0][0] !== m[0][0].toLowerCase()) upper++;
      }
    }
    // Las palabras comunes casi nunca llevan mayúscula a media frase; un nombre, a menudo (no siempre en chats).
    return total >= 3 && upper / total >= 0.25;
  }
  // Búsqueda de frase exacta o conjunción para entidades compuestas
  searchByPhrase(contact, phrase, limit = 20) {
    const words = String(phrase ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    if (!words.length) return [];
    const cleanWords = words.map(w => `"${w.replaceAll('"','')}"`);
    const expression = cleanWords.length > 1
      ? `("${words.join(' ')}" OR (${cleanWords.join(' AND ')}))`
      : cleanWords[0];
    const rows = this.db.prepare(`SELECT m.id,m.text,m.timestamp,m.raw_timestamp,m.author,m.role,
      m.import_hash,m.ordinal, bm25(imported_fts) AS bm25
      FROM imported_fts JOIN imported_messages m ON m.id=imported_fts.message_id AND m.contact=imported_fts.contact
      WHERE imported_fts MATCH ? AND imported_fts.contact=?
      ORDER BY bm25(imported_fts) LIMIT ?`).all(expression, contact, limit);
    return rows.map(m=>({body:`${m.raw_timestamp ?? m.timestamp} · ${m.author}: ${m.text}`,
      kind:'history',origin:'bm25',messageIds:[m.id],timestamp:m.timestamp,author:m.author,
      importHash:m.import_hash,ordinal:m.ordinal,bm25:m.bm25}));
  }
  searchStylePairs(contact, text, limit=6) {
    const STOP = new Set(['el','la','los','las','un','una','unos','unas','de','del','al','a','en','con','por','para','que','se','me','te','mi','tu','su','lo','le','es','son','fue','este','esta','estos','estas','o','y','si','no','ya','the','in','on','at','to','for','of','and','is','dias','dia','wenos','buenos','buenas','hola','oe','pe','mano','bro','causa']);
    const terms = [...new Set(String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
      .filter(t => !STOP.has(t))
      .slice(0, 8);
    if (!terms.length) return [];
    const query = terms.map(t => `"${t}"`).join(' OR ');
    return this.db.prepare(`SELECT p.incoming_text AS incoming,p.reply_text AS reply,
      p.context_type AS contextType FROM style_fts
      JOIN style_pairs p ON p.id=CAST(style_fts.pair_id AS INTEGER)
      WHERE style_fts MATCH ? AND style_fts.contact=? ORDER BY bm25(style_fts) LIMIT ?`)
      .all(query,contact,limit);
  }
  getBehaviorSamples(contact,limit=80) {
    // Se toman ejemplos de distintas épocas, no solo los primeros mensajes del chat.
    const all=this.db.prepare(`SELECT m1.id AS incomingId,m1.text AS incoming,
      m2.id AS replyId,m2.text AS reply,m1.timestamp AS timestamp
      FROM imported_messages m1 JOIN imported_messages m2
      ON m1.contact=m2.contact AND m1.import_hash=m2.import_hash AND m2.ordinal=m1.ordinal+1
      WHERE m1.contact=? AND m1.role='peer' AND m2.role='self'
        AND LENGTH(m2.text) BETWEEN 5 AND 350
      ORDER BY m1.timestamp,m1.ordinal`).all(contact);
    if(all.length<=limit)return all;
    const stride=all.length/limit;
    return Array.from({length:limit},(_,i)=>all[Math.floor(i*stride)]);
  }
  saveBehaviorProfile(contact,profile) {
    this.db.prepare(`INSERT INTO behavior_profiles(contact,profile_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(contact) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at`)
      .run(contact,JSON.stringify(profile),NOW());
  }
  getBehaviorProfile(contact) {
    const row=this.db.prepare('SELECT profile_json FROM behavior_profiles WHERE contact=?').get(contact);
    try{return row?JSON.parse(row.profile_json):null;}catch{return null;}
  }
  saveLearnedMemory(contact, fact, {source='real'}={}) {
    if (!['real','import'].includes(source) || !fact?.sourceId || !fact.key || !fact.quote) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert=this.db.prepare(`INSERT OR IGNORE INTO learned_memories
        (contact,memory_key,speaker,fact,quote,source_id,source_type,occurred_at,created_at,
         subject,subject_type,relation,object,object_type)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(contact,fact.key,fact.speaker,fact.fact,fact.quote,
          fact.sourceId,source,fact.occurredAt ?? null,NOW(),fact.subject ?? null,fact.subjectType ?? null,
          fact.relation ?? null,fact.object ?? null,fact.objectType ?? null);
      if (insert.changes && fact.action==='supersede') {
        this.db.prepare(`UPDATE learned_memories SET status='superseded'
          WHERE contact=? AND memory_key=? AND speaker=? AND id<>? AND status='active'`)
          .run(contact,fact.key,fact.speaker,Number(insert.lastInsertRowid));
      }
      this.db.exec('COMMIT'); return insert.changes>0;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  listLearnedMemories(contact,limit=30,{includeSuperseded=false}={}) {
    return this.db.prepare(`SELECT ${LEARNED_COLUMNS} FROM learned_memories
      WHERE contact=? ${includeSuperseded?'':"AND status='active'"} ORDER BY id DESC LIMIT ?`).all(contact,limit);
  }
  listLearnedMemoriesByIds(contact, ids) {
    const clean = [...new Set(ids.map(Number).filter(Number.isSafeInteger))].slice(0, 200);
    if (!clean.length) return [];
    return this.db.prepare(`SELECT ${LEARNED_COLUMNS} FROM learned_memories WHERE contact=? AND status='active'
      AND id IN (${clean.map(() => '?').join(',')})`).all(contact, ...clean);
  }
  // Respaldo sin Neo4j: coincidencia de términos en sujeto, objeto o hecho.
  searchLearnedMemories(contact, terms, limit = 20) {
    const clean = terms.map(t => String(t).toLowerCase().trim()).filter(t => t.length >= 3).slice(0, 8);
    if (!clean.length) return [];
    const where = clean.map(() => '(lower(subject) LIKE ? OR lower(object) LIKE ? OR lower(fact) LIKE ?)').join(' OR ');
    return this.db.prepare(`SELECT ${LEARNED_COLUMNS} FROM learned_memories WHERE contact=? AND status='active' AND (${where})
      ORDER BY occurred_at DESC LIMIT ?`).all(contact, ...clean.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]), limit);
  }
  // Revisión de un hecho ya guardado: rechazo o entidades resueltas. Si la clave nueva ya existe, el hecho sobra.
  reviseLearnedMemory(contact, id, {status = 'active', subject, object, key} = {}) {
    try {
      this.db.prepare(`UPDATE learned_memories SET status=?, subject=coalesce(?,subject), object=coalesce(?,object),
        memory_key=coalesce(?,memory_key) WHERE contact=? AND id=?`).run(status, subject ?? null, object ?? null, key ?? null, contact, id);
    } catch {
      this.db.prepare(`UPDATE learned_memories SET status='superseded' WHERE contact=? AND id=?`).run(contact, id);
    }
  }
  // Mensajes alrededor de uno importado (antes y después), con su autor: el contexto con que se juzga una cita.
  importMessageWindow(contact, messageId, before = 4, after = 3) {
    const at = this.db.prepare('SELECT import_hash, ordinal FROM imported_messages WHERE contact=? AND id=?').get(contact, String(messageId));
    if (!at) return {importHash: null, messages: []};
    const messages = this.db.prepare(`SELECT id, ordinal, timestamp, author, role, text FROM imported_messages
      WHERE contact=? AND import_hash=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal`)
      .all(contact, at.import_hash, at.ordinal - before, at.ordinal + after);
    return {importHash: at.import_hash, messages};
  }
  learnedMemoryStats(contact) {
    return this.db.prepare(`SELECT coalesce(relation,'(sin tipo)') AS relation, count(*) AS n FROM learned_memories
      WHERE contact=? AND status='active' GROUP BY 1 ORDER BY n DESC`).all(contact);
  }
  listImportMessagesAfter(contact, importHash, afterOrdinal, limit = 400) {
    return this.db.prepare(`SELECT id, ordinal, timestamp, role, text FROM imported_messages
      WHERE contact=? AND import_hash=? AND ordinal>? ORDER BY ordinal LIMIT ?`).all(contact, importHash, afterOrdinal, limit);
  }
  getGraphExtraction(contact, importHash) {
    return this.db.prepare('SELECT * FROM graph_extraction WHERE contact=? AND import_hash=?').get(contact, importHash) ?? null;
  }
  listGraphExtractions(contact) {
    return this.db.prepare('SELECT * FROM graph_extraction WHERE contact=? ORDER BY updated_at DESC').all(contact);
  }
  listBurstLabels() {
    // n: mensajes de la ráfaga etiquetada; si cambia la pausa del titular, la etiqueta deja de valer.
    return new Map(this.db.prepare('SELECT row_hash AS hash, keep, kinds_json FROM burst_labels').all()
      .map(r => [r.hash, {keep: r.keep, n: JSON.parse(r.kinds_json ?? '[]').length || null}]));
  }
  saveBurstLabel({hash, keep, kinds, model}) {
    this.db.prepare(`INSERT INTO burst_labels(row_hash,keep,kinds_json,model,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(row_hash) DO UPDATE SET keep=excluded.keep,kinds_json=excluded.kinds_json,model=excluded.model,created_at=excluded.created_at`)
      .run(hash, keep, JSON.stringify(kinds), model ?? null, NOW());
  }
  saveGraphExtraction(row) {
    this.db.prepare(`INSERT INTO graph_extraction(contact,import_hash,cursor_ordinal,total_messages,processed_messages,batches,
        failures,inserted,state,model,message,elapsed_ms,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(contact,import_hash) DO UPDATE SET cursor_ordinal=excluded.cursor_ordinal,total_messages=excluded.total_messages,
        processed_messages=excluded.processed_messages,batches=excluded.batches,failures=excluded.failures,inserted=excluded.inserted,
        state=excluded.state,model=excluded.model,message=excluded.message,elapsed_ms=excluded.elapsed_ms,updated_at=excluded.updated_at`)
      .run(row.contact, row.import_hash, row.cursor_ordinal ?? -1, row.total_messages ?? 0, row.processed_messages ?? 0,
        row.batches ?? 0, row.failures ?? 0, row.inserted ?? 0, row.state ?? 'idle', row.model ?? null, row.message ?? null,
        row.elapsed_ms ?? 0, NOW());
    return this.getGraphExtraction(row.contact, row.import_hash);
  }
  remember(contact, fact) {
    const text = fact.trim();
    if (!text || text.length > 1000) throw new Error('El recuerdo debe tener entre 1 y 1000 caracteres');
    return Number(this.db.prepare('INSERT INTO memories(contact,fact,created_at) VALUES(?,?,?)').run(contact, text, NOW()).lastInsertRowid);
  }
  listMemories(contact, limit = 30) {
    return this.db.prepare('SELECT id,fact,created_at FROM memories WHERE contact=? ORDER BY id DESC LIMIT ?').all(contact, limit);
  }
  deleteMemory(contact, id) {
    return this.db.prepare('DELETE FROM memories WHERE contact=? AND id=?').run(contact, id).changes > 0;
  }
  setConsent(contact, yes) {
    this.db.prepare(`INSERT INTO contacts(contact,opted_in,updated_at) VALUES(?,?,?)
      ON CONFLICT(contact) DO UPDATE SET opted_in=excluded.opted_in,updated_at=excluded.updated_at`).run(contact, yes ? 1 : 0, NOW());
  }
  isConsented(contact) { return this.db.prepare('SELECT opted_in FROM contacts WHERE contact=?').get(contact)?.opted_in === 1; }
  listContacts() { return this.db.prepare('SELECT * FROM contacts ORDER BY contact').all(); }
  saveConversation(contact, side, text, externalId = null) {
    this.db.prepare('INSERT OR IGNORE INTO conversation_messages(contact,side,text,external_id,created_at) VALUES(?,?,?,?,?)')
      .run(contact, side, text, externalId, NOW());
  }
  recentImported(contact, limit = 12) {
    try {
      const rows = this.db.prepare(`
        SELECT author, role AS side, text, timestamp, raw_timestamp
        FROM imported_messages
        WHERE contact=?
        ORDER BY ordinal DESC LIMIT ?
      `).all(contact, limit);
      return rows.reverse();
    } catch {
      return [];
    }
  }
  recent(contact, limit = 12) {
    const conv = this.db.prepare('SELECT side,text,created_at AS createdAt FROM conversation_messages WHERE contact=? ORDER BY id DESC LIMIT ?')
      .all(contact, limit).reverse();
    if (conv.length > 0) return conv;
    return this.recentImported(contact, limit);
  }
  savePreviewTurn(contact, sessionId, incomingText, answer) {
    const insert = this.db.prepare(`INSERT INTO preview_messages(contact,session_id,side,text,created_at)
      VALUES(?,?,?,?,?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const date = NOW();
      insert.run(contact, sessionId, 'peer', incomingText, date);
      insert.run(contact, sessionId, 'self', answer, date);
      this.db.prepare(`DELETE FROM preview_messages WHERE contact=? AND session_id=? AND id NOT IN
        (SELECT id FROM preview_messages WHERE contact=? AND session_id=? ORDER BY id DESC LIMIT 300)`)
        .run(contact, sessionId, contact, sessionId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  recentPreview(contact, sessionId, limit = 16) {
    return this.db.prepare(`SELECT id, side, text, created_at AS createdAt
      FROM preview_messages WHERE contact=? AND session_id=? ORDER BY id DESC LIMIT ?`)
      .all(contact, sessionId, limit).reverse();
  }
  clearPreview(contact, sessionId) {
    return this.db.prepare('DELETE FROM preview_messages WHERE contact=? AND session_id=?')
      .run(contact, sessionId).changes;
  }
  queueEvent(event) {
    return this.db.prepare(`INSERT OR IGNORE INTO events(id,contact,incoming_text,next_attempt,created_at)
      VALUES(?,?,?,?,?)`).run(event.id, event.contact, event.text, NOW(), NOW()).changes > 0;
  }
  claimNext() {
    const expired = new Date(Date.now()-5*60*1000).toISOString();
    this.db.prepare("UPDATE events SET state='pending' WHERE state='processing' AND next_attempt < ?").run(expired);
    const row = this.db.prepare(`SELECT * FROM events
      WHERE state IN ('pending','ready') AND next_attempt <= ? ORDER BY created_at,id LIMIT 1`).get(NOW());
    if (!row) return null;
    this.db.prepare("UPDATE events SET state='processing',tries=tries+1,next_attempt=? WHERE id=?")
      .run(NOW(), row.id);
    return {...row, tries: row.tries + 1};
  }
  saveOutput(id, text, state) {
    this.db.prepare('UPDATE events SET output=?,state=?,next_attempt=?,last_error=NULL WHERE id=?').run(text, state, NOW(), id);
  }
  markSent(id, externalMessageId) {
    const row = this.db.prepare('SELECT contact,output FROM events WHERE id=?').get(id);
    if (!row || !row.output) throw new Error('El evento no tiene respuesta');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE events SET state='sent',api_message_id=?,last_error=NULL WHERE id=?").run(externalMessageId, id);
      this.saveConversation(row.contact, 'assistant', row.output, externalMessageId ?? `sent:${id}`);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  markIgnored(id) { this.db.prepare("UPDATE events SET state='ignored' WHERE id=?").run(id); }
  fail(id, error, tries) {
    const retry = tries >= 4 ? 'failed' : 'pending';
    const when = new Date(Date.now() + Math.min(60000 * 2 ** Math.max(0, tries - 1), 600000)).toISOString();
    this.db.prepare('UPDATE events SET state=?,next_attempt=?,last_error=? WHERE id=?')
      .run(retry, when, String(error).slice(0, 400), id);
  }
  savePersonas(contact, personas) {
    if (!personas) return;
    const now = NOW();
    const stmt = this.db.prepare(`
      INSERT INTO personas (contact, role, author, profile_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contact, role) DO UPDATE SET
        author = excluded.author,
        profile_json = excluded.profile_json,
        updated_at = excluded.updated_at
    `);
    if (personas.self) {
      stmt.run(contact, 'self', personas.self.author ?? 'self', JSON.stringify(personas.self), now);
    }
    if (personas.peer) {
      stmt.run(contact, 'peer', personas.peer.author ?? 'peer', JSON.stringify(personas.peer), now);
    }
  }

  getPersonas(contact) {
    const rows = this.db.prepare('SELECT role, author, profile_json FROM personas WHERE contact = ?').all(contact);
    const result = { self: null, peer: null };
    for (const r of rows) {
      try {
        result[r.role] = JSON.parse(r.profile_json);
      } catch {}
    }
    return result;
  }

  buildAndSavePersonas(contact, selfName, peerName) {
    const messages = this.db.prepare(`
      SELECT author, role, text FROM imported_messages 
      WHERE contact = ? ORDER BY ordinal ASC
    `).all(contact);
    if (!messages.length) return null;
    const personas = extractPersonas(messages, selfName, peerName);
    this.savePersonas(contact, personas);
    return personas;
  }

  listDrafts() { return this.db.prepare("SELECT id,contact,incoming_text,output,created_at FROM events WHERE state='draft' ORDER BY created_at DESC LIMIT 100").all(); }
  getDraft(id) { return this.db.prepare("SELECT * FROM events WHERE id=? AND state='draft'").get(id); }
  eraseContact(contact) {
    const tables = ['behavior_profiles','learned_memories','history_chunks','imported_messages','style_pairs','personas','style_examples','memories','contacts','conversation_messages','preview_messages','events','chat_imports'];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM imported_fts WHERE contact=?').run(contact);
      this.db.prepare('DELETE FROM style_fts WHERE contact=?').run(contact);
      for (const table of tables) this.db.prepare(`DELETE FROM ${table} WHERE contact=?`).run(contact);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  countHistory(contact) { return this.db.prepare('SELECT COUNT(*) AS n FROM history_chunks WHERE contact=?').get(contact).n; }
  // Últimos mensajes importados en orden, para calcular la forma de las respuestas del titular.
  listRecentImportedMessages(contact, limit = 6000) {
    return this.db.prepare(`SELECT role, text FROM (SELECT role, text, timestamp, ordinal, import_hash FROM imported_messages
      WHERE contact=? ORDER BY timestamp DESC, import_hash, ordinal DESC LIMIT ?) ORDER BY timestamp, import_hash, ordinal`).all(contact, limit);
  }
  getChatImport(contact, importHash) {
    return this.db.prepare(`SELECT contact,import_hash AS importHash,file_name AS fileName,self_name AS self,
      peer_name AS peer,messages,chunks,imported_at AS importedAt FROM chat_imports WHERE contact=? AND import_hash=?`)
      .get(contact, importHash) ?? null;
  }
  // Mensajes de una importación en el formato del parser, para reconstruir el dataset desde SQLite.
  listImportMessages(contact, importHash) {
    return this.db.prepare(`SELECT ordinal, timestamp AS isoTimestamp, raw_timestamp AS rawTimestamp, author, role, text
      FROM imported_messages WHERE contact=? AND import_hash=? ORDER BY ordinal`).all(contact, importHash);
  }
  createTrainingJob({id, spec}) {
    const now = NOW();
    this.db.prepare(`INSERT INTO training_jobs(id,model_name,tag,self_name,spec_json,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'queued',?,?)`).run(id, spec.modelName, spec.tag, spec.selfName, JSON.stringify(spec), now, now);
    return this.getTrainingJob(id);
  }
  getTrainingJob(id) { return trainingRow(this.db.prepare('SELECT * FROM training_jobs WHERE id=?').get(id)); }
  listTrainingJobs(limit = 50) {
    return this.db.prepare('SELECT * FROM training_jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(trainingRow);
  }
  hasActiveTrainingJob(tag) {
    return !!this.db.prepare(`SELECT 1 FROM training_jobs WHERE tag=? AND state IN ('queued','running','cancel_requested')`).get(tag);
  }
  // Reclamo atómico: un solo ejecutor y un solo trabajo activo a la vez (la GPU es compartida).
  claimNextTrainingJob(runner) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare(`SELECT 1 FROM training_jobs WHERE state IN ('running','cancel_requested')`).get()) {
        this.db.exec('COMMIT'); return null;
      }
      const row = this.db.prepare(`SELECT id FROM training_jobs WHERE state='queued' ORDER BY created_at LIMIT 1`).get();
      if (row) {
        const now = NOW();
        this.db.prepare(`UPDATE training_jobs SET state='running',stage='dataset',runner=?,started_at=?,updated_at=? WHERE id=?`)
          .run(String(runner).slice(0, 80), now, now, row.id);
      }
      this.db.exec('COMMIT');
      return row ? this.getTrainingJob(row.id) : null;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  requeueTrainingJob(id, message) {
    this.db.prepare(`UPDATE training_jobs SET state='queued',stage=NULL,progress=0,message=?,runner=NULL,result_json=NULL,
      finished_at=NULL,updated_at=? WHERE id=? AND state='failed'`).run(message, NOW(), id);
    return this.getTrainingJob(id);
  }
  updateTrainingJob(job) {
    const now = NOW();
    this.db.prepare(`UPDATE training_jobs SET state=?,stage=?,progress=?,message=?,result_json=?,updated_at=?,
      finished_at=COALESCE(finished_at,?) WHERE id=?`).run(job.state, job.stage ?? null, job.progress ?? 0, job.message ?? null,
      job.result ? JSON.stringify(job.result) : null, now,
      ['succeeded','failed','cancelled'].includes(job.state) ? now : null, job.id);
    return this.getTrainingJob(job.id);
  }
  appendTrainingLogs(jobId, lines, keep = 3000) {
    if (!lines.length) return;
    const stmt = this.db.prepare('INSERT INTO training_job_logs(job_id,at,line) VALUES(?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = NOW();
      for (const line of lines) stmt.run(jobId, now, line);
      this.db.prepare(`DELETE FROM training_job_logs WHERE job_id=? AND id NOT IN
        (SELECT id FROM training_job_logs WHERE job_id=? ORDER BY id DESC LIMIT ?)`).run(jobId, jobId, keep);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  listTrainingLogs(jobId, afterId = 0, limit = 500) {
    return this.db.prepare('SELECT id,at,line FROM training_job_logs WHERE job_id=? AND id>? ORDER BY id LIMIT ?')
      .all(jobId, afterId, limit);
  }
}
