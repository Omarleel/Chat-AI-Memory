import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPersonas, formatCasualWhatsApp } from '../../src/domain/history.mjs';
import { SqliteRepository } from '../../src/infra/sqlite-repository.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('extractPersonas calcula perfiles y métricas para self y peer', () => {
  const sampleMessages = [
    { author: 'Alex', text: 'Oe sigues vivo? xd', role: 'self' },
    { author: 'Diego R', text: 'q tal, toy ocupado con un trabajo', role: 'peer' },
    { author: 'Alex', text: 'ya pues xd no te pierdas plox', role: 'self' },
    { author: 'Diego R', text: 'tranqui, el examen de mañana me tiene loco :v', role: 'peer' }
  ];

  const personas = extractPersonas(sampleMessages, 'Alex', 'Diego R');
  assert.ok(personas.self);
  assert.ok(personas.peer);
  assert.equal(personas.self.author, 'Alex');
  assert.equal(personas.peer.author, 'Diego R');
  assert.equal(personas.self.totalMessages, 2);
  assert.equal(personas.peer.totalMessages, 2);
  assert.ok(personas.self.topSlang.includes('xd') || personas.self.topSlang.includes('plox') || personas.self.topSlang.includes('pues'));
  assert.ok(personas.peer.topSlang.includes('q') || personas.peer.topSlang.includes('toy') || personas.peer.topSlang.includes(':v'));
  assert.match(personas.self.summary, /Alex/);
  assert.match(personas.peer.summary, /Diego R/);
});

test('formatCasualWhatsApp respeta estilo generado sin sustituciones dialectales', () => {
  const persona={author:'Alex',endingDotRate:0.02};
  assert.equal(formatCasualWhatsApp('¿Qué haces bro?',persona),'¿Qué haces bro?');
  assert.equal(formatCasualWhatsApp('¡Hola causa!',persona),'¡Hola causa!');
  assert.equal(formatCasualWhatsApp('No pasa nada manito.',persona),'No pasa nada manito.');
  assert.equal(formatCasualWhatsApp('Alex: vale, guay',persona),'vale, guay');
});

test('SqliteRepository guarda y recupera perfiles de personas para el contacto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'personas-test-'));
  const dbPath = join(dir, 'test.sqlite');
  try {
    const repo = new SqliteRepository(dbPath);
    const personas = {
      self: { author: 'Alex', role: 'self', topSlang: ['xd', 'pe'], endingDotRate: 0.03 },
      peer: { author: 'Diego R', role: 'peer', topSlang: ['q', 'toy'], endingDotRate: 0.01 }
    };
    repo.savePersonas('51929630289', personas);

    const loaded = repo.getPersonas('51929630289');
    assert.equal(loaded.self.author, 'Alex');
    assert.equal(loaded.peer.author, 'Diego R');
    assert.deepEqual(loaded.self.topSlang, ['xd', 'pe']);
    assert.equal(loaded.self.endingDotRate, 0.03);

    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

