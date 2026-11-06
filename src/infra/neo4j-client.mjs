// Adaptador nativo para Neo4j utilizando la API HTTP transaccional de Cypher (:7474).
// Cumple con la restricción de Node.js 26 ESM Core sin dependencias externas pesadas.

export class Neo4jClient {
  constructor({
    baseUrl = 'http://127.0.0.1:7474',
    user = 'neo4j',
    password = 'secretpassword',
    database = 'neo4j',
    enabled = true
  } = {}) {
    this.baseUrl = String(baseUrl ?? '').replace(/\/$/, '');
    this.user = String(user ?? 'neo4j');
    this.password = String(password ?? '');
    this.database = String(database ?? 'neo4j');
    this.enabled = Boolean(enabled);
    this._authHeader = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;
  }

  async executeCypher(statements = [], timeoutMs = 15000) {
    if (!this.enabled || !statements.length) return [];
    const url = `${this.baseUrl}/db/${this.database}/tx/commit`;
    const payload = {
      statements: statements.map(s => (typeof s === 'string' ? { statement: s } : s))
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'authorization': this._authHeader
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Neo4j HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const json = await res.json();
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(`Neo4j Cypher Error: ${json.errors[0]?.message ?? 'Error desconocido'}`);
    }

    return json.results ?? [];
  }

  async initSchema() {
    if (!this.enabled) return;
    try {
      // Índice compuesto por contacto y nombre de entidad para búsquedas instantáneas
      await this.executeCypher([
        `CREATE INDEX entity_contact_name_idx IF NOT EXISTS FOR (e:Entity) ON (e.contact, e.name)`
      ]);
    } catch (err) {
      console.warn('Neo4j initSchema:', err.message);
    }
  }

  // Solo afirmaciones extraídas con cita literal verificable y guardadas en SQLite.
  async upsertVerifiedMemory(contact, m) {
    if (!this.enabled || !m?.source_id || !m?.quote || !m?.fact) return null;
    const query=`MERGE (a:Entity {contact:$contact,name:$speaker})
      MERGE (f:VerifiedMemory {contact:$contact,sqlite_id:$id})
      SET f.fact=$fact,f.memory_key=$key,f.quote=$quote,f.source_id=$sourceId,
        f.occurred_at=$occurredAt,f.status=$status,f.speaker=$speaker
      MERGE (a)-[:ASSERTED]->(f)
      RETURN f.sqlite_id AS id`;
    const result=await this.executeCypher([{statement:query,parameters:{
      contact:String(contact),id:Number(m.id),speaker:String(m.speaker),
      fact:String(m.fact),key:String(m.memory_key),quote:String(m.quote),
      sourceId:String(m.source_id),occurredAt:m.occurred_at ?? null,status:m.status ?? 'active'
    }}]);
    return result[0]?.data?.[0]?.row?.[0] ?? null;
  }
  async findVerifiedRelated({contact,entities=[],limit=10}={}) {
    if(!this.enabled || !entities.length)return [];
    const safe=entities.map(e=>String(e).toLowerCase().trim()).filter(Boolean).slice(0,8);
    if(!safe.length)return [];
    const query=`MATCH (s:Entity {contact:$contact})-[:ASSERTED]->(f:VerifiedMemory {contact:$contact,status:'active'})
      WHERE ANY(term IN $entities WHERE toLower(f.fact) CONTAINS term OR toLower(s.name) = term)
      RETURN s.name,f.memory_key,f.fact,f.occurred_at,f.source_id,f.quote
      ORDER BY f.occurred_at DESC LIMIT $limit`;
    const result=await this.executeCypher([{statement:query,parameters:{contact:String(contact),
      entities:safe,limit:Math.max(1,Math.min(25,Number(limit)||10))}}]);
    return (result[0]?.data ?? []).map(d=>({subject:d.row[0],relation:d.row[1],object:d.row[2],
      date:d.row[3],sourceId:d.row[4],quote:d.row[5],confidence:null,verified:true}));
  }

  async upsertTriplet({
    contact,
    subject,
    relation,
    object,
    confidence = 1.0,
    date = null,
    sourceMessageId = null
  }) {
    if (!this.enabled) return null;
    const sub = String(subject ?? '').trim();
    const rel = String(relation ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const obj = String(object ?? '').trim();
    if (!contact || !sub || !rel || !obj) return null;

    const safeRel = rel.replace(/[^A-Z0-9_]/g, '_') || 'FACT';
    const cypher = `
      MERGE (s:Entity {contact: $contact, name: $subject})
      MERGE (o:Entity {contact: $contact, name: $object})
      MERGE (s)-[r:${safeRel} {type: $relation}]->(o)
      ON CREATE SET 
        r.confidence = $confidence, 
        r.created_at = datetime(), 
        r.date = $date, 
        r.source = $sourceMessageId
      ON MATCH SET 
        r.confidence = $confidence, 
        r.updated_at = datetime()
      RETURN s.name AS subject, coalesce(r.type, type(r)) AS relation, o.name AS object
    `;

    const results = await this.executeCypher([{
      statement: cypher,
      parameters: {
        contact: String(contact),
        subject: sub,
        relation: rel,
        object: obj,
        confidence: Number(confidence) || 1.0,
        date: date ? String(date) : null,
        sourceMessageId: sourceMessageId ? String(sourceMessageId) : null
      }
    }]);

    const row = results[0]?.data?.[0]?.row;
    return row ? { subject: row[0], relation: row[1], object: row[2] } : null;
  }

  async upsertManyTriplets(contact, triplets = []) {
    if (!this.enabled || !Array.isArray(triplets) || !triplets.length) return 0;
    let saved = 0;
    for (const t of triplets) {
      try {
        const res = await this.upsertTriplet({ contact, ...t });
        if (res) saved++;
      } catch (err) {
        console.warn('Error guardando tripleta en Neo4j:', err.message);
      }
    }
    return saved;
  }

  async findRelated({ contact, entities = [], limit = 10 } = {}) {
    if (!this.enabled) return [];
    const normEntities = (Array.isArray(entities) ? entities : [])
      .map(e => String(e ?? '').trim().toLowerCase())
      .filter(Boolean);

    if (!normEntities.length) return [];

    const cypher = `
      MATCH (s:Entity {contact: $contact})-[r]->(o:Entity {contact: $contact})
      WHERE (toLower(s.name) IN $entities OR toLower(o.name) IN $entities)
        AND type(r) <> 'ASSERTED'
      RETURN DISTINCT s.name AS subject, coalesce(r.type, type(r)) AS relation, o.name AS object, r.confidence AS confidence, r.date AS date
      LIMIT $limit
    `;

    try {
      const results = await this.executeCypher([{
        statement: cypher,
        parameters: {
          contact: String(contact),
          entities: normEntities,
          limit: Math.max(1, Math.min(50, Number(limit) || 10))
        }
      }]);

      const data = results[0]?.data ?? [];
      return data.map(d => ({
        subject: d.row[0],
        relation: d.row[1],
        object: d.row[2],
        confidence: d.row[3],
        date: d.row[4]
      }));
    } catch {
      return [];
    }
  }

  async listAllTriplets(contact, limit = 100) {
    if (!this.enabled) return [];
    const cypher = `
      MATCH (s:Entity {contact: $contact})-[r:FACT]->(o:Entity {contact: $contact})
      RETURN s.name AS subject, r.type AS relation, o.name AS object, r.confidence AS confidence, r.date AS date
      LIMIT $limit
    `;
    try {
      const results = await this.executeCypher([{
        statement: cypher,
        parameters: { contact: String(contact), limit: Number(limit) || 100 }
      }]);
      const data = results[0]?.data ?? [];
      return data.map(d => ({
        subject: d.row[0],
        relation: d.row[1],
        object: d.row[2],
        confidence: d.row[3],
        date: d.row[4]
      }));
    } catch {
      return [];
    }
  }

  async clearContact(contact) {
    if (!this.enabled) return { deleted: 0 };
    const cypher = `
      MATCH (e:Entity {contact: $contact})
      DETACH DELETE e
    `;
    try {
      await this.executeCypher([{ statement: cypher, parameters: { contact: String(contact) } }]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // --- Grafo de conocimiento con claves canónicas (proyección derivada de SQLite) ---

  // Elimina el modelo anterior (entidades sin clave y nodos VerifiedMemory); se regenera desde SQLite.
  async dropLegacy(contact) {
    if (!this.enabled) return;
    await this.executeCypher([
      {statement: 'MATCH (e:Entity {contact:$contact}) WHERE e.key IS NULL DETACH DELETE e', parameters: {contact: String(contact)}},
      {statement: 'MATCH (f:VerifiedMemory {contact:$contact}) DETACH DELETE f', parameters: {contact: String(contact)}}
    ], 60000);
  }

  async initKnowledgeSchema() {
    if (!this.enabled) return;
    await this.executeCypher(['CREATE INDEX entity_contact_key_idx IF NOT EXISTS FOR (e:Entity) ON (e.contact, e.key)']);
  }

  // facts: [{uid, relation, subject:{key,name,type}, object:{key,name,type}, props:{...}}]; relation ya validada.
  async projectFacts(contact, facts = []) {
    if (!this.enabled || !facts.length) return 0;
    const byRelation = new Map();
    for (const f of facts) {
      if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(f.relation)) continue;
      if (!byRelation.has(f.relation)) byRelation.set(f.relation, []);
      byRelation.get(f.relation).push({uid: f.uid, sk: f.subject.key, sn: f.subject.name, st: f.subject.type,
        ok: f.object.key, on: f.object.name, ot: f.object.type, props: f.props});
    }
    const statements = [...byRelation].map(([relation, rows]) => ({
      statement: `UNWIND $rows AS row
        MERGE (s:Entity {contact:$contact, key:row.sk}) ON CREATE SET s.name=row.sn
        SET s.type = CASE WHEN s.type IS NULL OR s.type='otro' THEN row.st ELSE s.type END
        MERGE (o:Entity {contact:$contact, key:row.ok}) ON CREATE SET o.name=row.on
        SET o.type = CASE WHEN o.type IS NULL OR o.type='otro' THEN row.ot ELSE o.type END
        MERGE (s)-[r:${relation} {uid:row.uid}]->(o)
        SET r += row.props`,
      parameters: {contact: String(contact), rows}}));
    for (let i = 0; i < statements.length; i += 8) await this.executeCypher(statements.slice(i, i + 8), 120000);
    return facts.length;
  }

  async graphStats(contact) {
    if (!this.enabled) return null;
    const p = {contact: String(contact)};
    const [entities, relations, origins] = await this.executeCypher([
      {statement: 'MATCH (e:Entity {contact:$contact}) WHERE e.key IS NOT NULL RETURN coalesce(e.type,"otro"), count(*) ORDER BY count(*) DESC', parameters: p},
      {statement: 'MATCH (:Entity {contact:$contact})-[r]->(:Entity {contact:$contact}) WHERE r.uid IS NOT NULL RETURN type(r), count(*) ORDER BY count(*) DESC', parameters: p},
      {statement: 'MATCH (:Entity {contact:$contact})-[r]->(:Entity {contact:$contact}) WHERE r.uid IS NOT NULL RETURN coalesce(r.origin,"?"), count(*)', parameters: p}
    ]);
    const rows = res => (res?.data ?? []).map(d => d.row);
    return {entities: rows(entities).map(([type, n]) => ({type, n})), relations: rows(relations).map(([relation, n]) => ({relation, n})),
      origins: Object.fromEntries(rows(origins))};
  }

  async searchEntities(contact, query, limit = 20) {
    if (!this.enabled) return [];
    const [res] = await this.executeCypher([{statement: `MATCH (e:Entity {contact:$contact}) WHERE e.key CONTAINS $q
      RETURN e.key, e.name, coalesce(e.type,'otro'), COUNT { (e)--() } AS degree ORDER BY degree DESC, e.key LIMIT $limit`,
      parameters: {contact: String(contact), q: String(query), limit: Math.max(1, Math.min(100, Number(limit) || 20))}}]);
    return (res?.data ?? []).map(({row}) => ({key: row[0], name: row[1], type: row[2], degree: row[3]}));
  }

  // Relaciones de una entidad (entrantes y salientes) con su procedencia.
  async entityRelations(contact, key, limit = 100) {
    if (!this.enabled) return null;
    const [entity, rels] = await this.executeCypher([
      {statement: 'MATCH (e:Entity {contact:$contact, key:$key}) RETURN e.key, e.name, coalesce(e.type,"otro"), COUNT { (e)--() }',
        parameters: {contact: String(contact), key: String(key)}},
      {statement: `MATCH (e:Entity {contact:$contact, key:$key})-[r]-(n:Entity {contact:$contact}) WHERE r.uid IS NOT NULL
        RETURN startNode(r) = e, type(r), properties(r), n.key, n.name, coalesce(n.type,'otro')
        ORDER BY r.occurred_at DESC LIMIT $limit`,
        parameters: {contact: String(contact), key: String(key), limit: Math.max(1, Math.min(300, Number(limit) || 100))}}
    ]);
    const row = entity?.data?.[0]?.row;
    if (!row) return null;
    return {entity: {key: row[0], name: row[1], type: row[2], degree: row[3]},
      relations: (rels?.data ?? []).map(({row: r}) => ({outgoing: r[0], relation: r[1], ...r[2], other: {key: r[3], name: r[4], type: r[5]}}))};
  }

  // Recuperación: entidades que coinciden con los términos (exacta o contenida) y sus hechos a 1 salto;
  // para personas, también los hechos de las personas vinculadas por relaciones sociales (2 saltos).
  async factsAround(contact, terms = [], limit = 12, {verifiedOnly = true} = {}) {
    if (!this.enabled) return [];
    const keys = [...new Set(terms.map(String).filter(t => t.length >= 3))].slice(0, 10);
    if (!keys.length) return [];
    const [res] = await this.executeCypher([{statement: `MATCH (e:Entity {contact:$contact})
      WHERE e.key IN $keys OR ANY(k IN $keys WHERE
        e.key STARTS WITH k + ' ' OR e.key ENDS WITH ' ' + k OR e.key CONTAINS ' ' + k + ' '
        OR (size(k) >= 5 AND e.key CONTAINS k) OR (size(e.key) >= 4 AND (k STARTS WITH e.key + ' ' OR k ENDS WITH ' ' + e.key)))
      WITH e, CASE WHEN e.key IN $keys THEN 0 ELSE 1 END AS miss LIMIT 6
      CALL (e, miss) {
        MATCH (e)-[r]-(n:Entity {contact:$contact}) WHERE r.uid IS NOT NULL AND (NOT $verifiedOnly OR r.origin = 'llm')
        RETURN r, startNode(r) AS s, endNode(r) AS o, miss AS hop
        UNION
        MATCH (e)-[:AMIGO_DE|FAMILIAR_DE|PAREJA_DE|CONOCE_A]-(p:Entity {contact:$contact})-[r]-(:Entity {contact:$contact})
        WHERE r.uid IS NOT NULL AND e.type = 'persona' AND (NOT $verifiedOnly OR r.origin = 'llm')
        RETURN r, startNode(r) AS s, endNode(r) AS o, miss + 2 AS hop
      }
      WITH r, s, o, min(hop) AS hop
      ORDER BY coalesce(r.occurred_at, '') DESC
      // Una arista por (sujeto, relación, objeto): la cita más reciente y cuántas veces se mencionó.
      WITH type(r) AS rel, s, o, min(hop) AS hop, collect(r) AS rs
      RETURN rel, properties(head(rs)), s.name, o.name, hop, size(rs)
      ORDER BY hop, coalesce(head(rs).occurred_at, '') DESC LIMIT $limit`,
      parameters: {contact: String(contact), keys, verifiedOnly, limit: Math.max(1, Math.min(40, Number(limit) || 12))}}], 20000);
    return (res?.data ?? []).map(({row}) => ({relation: row[0], ...row[1], subject: row[2], object: row[3], hop: row[4], mentions: row[5]}));
  }

  async isHealthy() {
    if (!this.enabled) return false;
    try {
      const res = await this.executeCypher(['RETURN 1 AS alive'], 3000);
      return res[0]?.data?.[0]?.row?.[0] === 1;
    } catch {
      return false;
    }
  }
}
