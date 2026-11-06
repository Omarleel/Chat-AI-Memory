// Ingesta completa hacia Neo4j:
// 1. Memorias autobiográficas verificadas (VerifiedMemory con citas literales).
// 2. Grafo de Entidades Social y Relacional (Sujeto -> Relación -> Objeto) entre personas, gustos, estudios y lugares.
// Uso: node --env-file=.env scripts/ingest_graph.mjs --contact <CONTACTO>
import { loadConfig, normalizePhone } from '../src/config.mjs';
import { SqliteRepository } from '../src/infra/sqlite-repository.mjs';
import { Neo4jClient } from '../src/infra/neo4j-client.mjs';
import { GraphSyncService } from '../src/app/graph-sync-service.mjs';

const config = loadConfig();
const repo = new SqliteRepository(config.databasePath);
const neo4j = new Neo4jClient({
  baseUrl: config.neo4jUrl,
  user: config.neo4jUser,
  password: config.neo4jPassword,
  enabled: true
});

try {
  const param = process.argv.indexOf('--contact');
  if (param === -1 || !process.argv[param + 1]) throw new Error('Usa --contact <número autorizado>');
  const contact = normalizePhone(process.argv[param + 1]);
  if (!config.allowedContacts.has(contact)) throw new Error('Contacto fuera de allowlist');

  const graphSync = new GraphSyncService({ repository: repo, neo4j, config });
  const report = await graphSync.syncContact(contact);
  console.log(JSON.stringify(report, null, 2));
} finally {
  repo.close();
}
