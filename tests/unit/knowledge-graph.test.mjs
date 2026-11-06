import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';
import {KnowledgeGraphService, factToEdge} from '../../src/app/knowledge-graph-service.mjs';
import {applyVerification, entityKey, extractionBatches, extractionInput, isExtractable, validateGraphFacts, verificationInput} from '../../src/domain/knowledge-graph.mjs';

const names = {selfName: 'Alex', peerName: 'Diego Ruiz'};
const PASS = {explicita: true, relacion: true, entidades: 'ok', vigencia: true, contexto: true};
const HASH = 'a'.repeat(64), CONTACT = '51911111111';

test('claves de entidad y filtro de mensajes útiles', () => {
  assert.equal(entityKey('La Casa de Chato!'), 'casa de chato');
  assert.equal(entityKey('Lucía'), 'lucia');
  for (const t of ['jajajaja', 'xd', 'ok', '<Multimedia omitido>', 'si si']) assert.equal(isExtractable(t), false, t);
  assert.equal(isExtractable('Mañana empiezo a trabajar en el BCP'), true);
});

test('los lotes agrupan mensajes útiles, dan contexto previo y avanzan el cursor', () => {
  const messages = Array.from({length: 40}, (_, i) => ({ordinal: i, role: i % 2 ? 'self' : 'peer', text: i % 3 ? 'jaja' : `mensaje con contenido ${i}`}));
  const batches = extractionBatches(messages, {size: 5, context: 2});
  assert.ok(batches.every(b => b.targets.length <= 5));
  assert.equal(batches.at(-1).lastOrdinal, 39);
  assert.equal(batches.reduce((n, b) => n + b.targets.length, 0), messages.filter(m => isExtractable(m.text)).length);
  assert.ok(batches[1].context.length > 0);
  const line = JSON.parse(extractionInput({context: [], targets: [{role: 'self', text: 'Me debes 93 soles'}]}, names).split('\n')[3]);
  assert.deepEqual([line.author, line.to], ['Alex', 'Diego Ruiz']);
});

test('validación: cita literal, vocabulario, participantes, objetos concretos y cifras', () => {
  const targets = [{id: 'm1', role: 'self', text: 'Me debes 93 soles', timestamp: '2025-01-01T10:00:00'},
    {id: 'm2', role: 'peer', text: 'Mañana empiezo a trabajar en el BCP', timestamp: '2025-01-02T10:00:00'}];
  const base = {speaker: 'self', subject: 'peer', relation: 'DEBE_A', object: 'self', fact: 'Diego Ruiz debe 93 soles a Alex', quote: 'Me debes 93 soles'};
  const ok = validateGraphFacts({facts: [base]}, targets, names);
  assert.deepEqual([ok[0].subject, ok[0].object, ok[0].sourceId, ok[0].objectType], ['Diego Ruiz', 'Alex', 'm1', 'persona']);
  const rejected = [
    {...base, quote: 'me debes 900 soles'},                       // no es literal
    {...base, speaker: 'peer'},                                    // la cita es de otro hablante
    {...base, relation: 'OPINA'},                                  // fuera del vocabulario
    {...base, fact: 'Diego Ruiz debe 8 soles a Alex'},          // cifra inventada
    {...base, subject: 'algo', object: 'self'},                    // sujeto vago
    {...base, object: 'que el self es amigo', subject: 'peer'}     // objeto vago
  ];
  for (const f of rejected) assert.equal(validateGraphFacts({facts: [f]}, targets, names).length, 0, JSON.stringify(f));
  assert.equal(applyVerification({results: [{i: 0, ...PASS, relacion: false}]}, ok).length, 0);
  assert.equal(applyVerification({results: [{i: 0, ...PASS}]}, ok).length, 1);
  assert.equal(applyVerification({results: [{i: 0, ...PASS, entidades: 'no'}]}, ok).length, 0);
});

test('la verificación ve la arista y su contexto, y aplica los nombres resueltos', () => {
  const fact = {speaker: 'peer', subject: 'Diego Ruiz', relation: 'FAMILIAR_DE', object: 'ella', fact: 'Ella es hermana de Diego Ruiz',
    quote: 'Ella es mi hermana', sourceId: 'm2'};
  const window = [{id: 'm1', role: 'peer', text: 'Te presento a Carla'}, {id: 'm2', role: 'peer', text: 'Ella es mi hermana'},
    {id: 'm3', role: 'self', text: 'Hola Carla'}];
  const [item] = JSON.parse(verificationInput([fact], names, [window]));
  assert.equal(item.meaning, 'relación familiar');
  assert.deepEqual(item.context.map(m => [m.author, !!m.cited]), [['Diego Ruiz', false], ['Diego Ruiz', true], ['Alex', false]]);
  const [kept] = applyVerification({results: [{i: 0, ...PASS, entidades: 'resuelta', object: 'Carla'}]}, [fact], names);
  assert.equal(applyVerification({results: [{i: 0, ...PASS, object: 'Carla'}]}, [fact], names)[0].object, 'ella', 'sin resolución declarada no renombra');
  assert.deepEqual([kept.object, kept.key], ['Carla', 'diego ruiz|FAMILIAR_DE|carla']);
  assert.equal(applyVerification({results: [{i: 0, ...PASS, entidades: 'resuelta', subject: 'peer'}]}, [{...fact, object: 'Diego Ruiz'}], names).length, 0);
});

test('la revisión rechaza lo no sostenido y renombra entidades sin dueño', async () => {
  const {repository, svc} = service({responses: [JSON.stringify({results: [{i: 0, ...PASS, entidades: 'resuelta', object: 'papá de Diego Ruiz'}]}),
    JSON.stringify({results: [{i: 0, ...PASS, relacion: false}]})]});
  const save = (key, object, quote, sourceId) => repository.saveLearnedMemory(CONTACT, {key, speaker: 'peer', subject: 'Diego Ruiz',
    relation: 'FAMILIAR_DE', object, fact: `Diego Ruiz y ${object}`, quote, sourceId}, {source: 'import'});
  const ids = repository.db.prepare('SELECT id FROM imported_messages ORDER BY ordinal').all().map(r => r.id);
  save('a', 'papa', 'Me debes 93 soles', ids[0]);
  save('b', 'BCP', 'empiezo a trabajar en el BCP', ids[2]);
  const progress = await svc.review(CONTACT);
  assert.deepEqual([progress.total, progress.rejected, progress.renamed], [2, 1, 1]);
  const active = repository.listLearnedMemories(CONTACT, 10);
  assert.deepEqual(active.map(m => m.object), ['papá de Diego Ruiz']);
  repository.close();
});

function service({responses, neo4j = null}) {
  const repository = new SqliteRepository(':memory:');
  repository.recordChatImport({contact: CONTACT, importHash: HASH, fileName: 'chat.txt', self: 'Alex', peer: 'Diego Ruiz', messages: 3, chunks: 1});
  repository.saveImportedMessages(CONTACT, HASH, [
    {ordinal: 0, isoTimestamp: '2025-01-01T10:00:00', rawTimestamp: 'x', author: 'Alex', role: 'self', text: 'Me debes 93 soles'},
    {ordinal: 1, isoTimestamp: '2025-01-01T10:01:00', rawTimestamp: 'x', author: 'Diego Ruiz', role: 'peer', text: 'jaja'},
    {ordinal: 2, isoTimestamp: '2025-01-01T10:02:00', rawTimestamp: 'x', author: 'Diego Ruiz', role: 'peer', text: 'Mañana empiezo a trabajar en el BCP'}]);
  const calls = [];
  const llm = {chatDetails: async (system, prompt) => {calls.push(system.slice(0, 20)); return {content: responses.shift() ?? '{"facts":[]}'};}};
  const config = {allowedContacts: new Set([CONTACT]), reasoningModel: 'qwen3.5:9b', neo4jEnabled: !!neo4j};
  return {repository, calls, svc: new KnowledgeGraphService({repository, neo4j, llm, config})};
}

test('la extracción guarda solo hechos verificados, avanza el cursor y termina', async () => {
  const debt = {speaker: 'self', subject: 'peer', relation: 'DEBE_A', object: 'self', fact: 'Diego Ruiz debe 93 soles a Alex', quote: 'Me debes 93 soles'};
  const job = {speaker: 'peer', subject: 'peer', relation: 'TRABAJA_EN', object: 'BCP', objectType: 'organizacion', fact: 'Diego Ruiz trabaja en el BCP', quote: 'empiezo a trabajar en el BCP'};
  const projected = [];
  const neo4j = {enabled: true, initKnowledgeSchema: async () => {}, dropLegacy: async () => {}, projectFacts: async (c, f) => {projected.push(...f); return f.length;}};
  const {repository, svc, calls} = service({neo4j, responses: [JSON.stringify({facts: [debt, job]}), JSON.stringify({results: [{i: 0, ...PASS}]}), JSON.stringify({results: [{i: 0, ...PASS, explicita: false}]})]});
  svc.start(CONTACT, HASH);
  await new Promise(r => {const t = setInterval(() => {if (!svc.active) {clearInterval(t); r();}}, 5);});
  const state = svc.status(CONTACT).imports[0];
  assert.deepEqual([state.state, state.inserted, state.processedMessages, state.cursor], ['done', 1, 3, 2]);
  assert.equal(calls.length, 3, 'extracción + una verificación por hecho');
  const stored = repository.listLearnedMemories(CONTACT, 10);
  assert.deepEqual([stored[0].relation, stored[0].subject, stored[0].object], ['DEBE_A', 'Diego Ruiz', 'Alex']);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(projected[0].relation, 'DEBE_A');
  assert.equal(projected[0].props.origin, 'llm');
  assert.throws(() => svc.start(CONTACT, HASH), /ya se procesó/);
  repository.close();
});

test('pausa respeta el cursor, un reinicio deja en pausa y la recuperación cae a SQLite sin Neo4j', async () => {
  const {repository, svc} = service({responses: []});
  svc.start(CONTACT, HASH);
  svc.pause(CONTACT);
  await new Promise(r => {const t = setInterval(() => {if (!svc.active) {clearInterval(t); r();}}, 5);});
  assert.ok(['paused', 'done'].includes(svc.status(CONTACT).imports[0].state));
  repository.saveGraphExtraction({...repository.getGraphExtraction(CONTACT, HASH), state: 'running'});
  const restarted = new KnowledgeGraphService({repository, neo4j: null, llm: {}, config: {allowedContacts: new Set([CONTACT])}});
  assert.equal(restarted.status(CONTACT).imports[0].state, 'paused');
  repository.saveLearnedMemory(CONTACT, {key: 'k', speaker: 'peer', fact: 'Diego Ruiz trabaja en el BCP', quote: 'trabajar en el BCP', sourceId: 'm3',
    subject: 'Diego Ruiz', relation: 'TRABAJA_EN', object: 'BCP'}, {source: 'import'});
  const found = await restarted.retrieve(CONTACT, ['BCP']);
  assert.equal(found[0].fact, 'Diego Ruiz trabaja en el BCP');
  assert.equal(factToEdge({id: 1, relation: 'NO_EXISTE', subject: 'a', object: 'b'}), null);
  repository.close();
});

test('términos de búsqueda del mensaje sin palabras vacías', async () => {
  const {queryTerms} = await import('../../src/domain/knowledge-graph.mjs');
  assert.deepEqual(queryTerms('Oye tu tío sigue en Italia?'), ['tio', 'italia']);
  assert.deepEqual(queryTerms('Hay que organizar una pichanga'), ['organizar', 'pichanga']);
});
