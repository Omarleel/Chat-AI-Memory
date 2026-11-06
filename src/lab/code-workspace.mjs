import { cp, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const ALLOWED = /^src\/(?:app\/reply-service\.mjs|domain\/[a-z][a-z0-9-]*\.mjs)$/;
const digest = data => createHash('sha256').update(data).digest('hex');
export function validatePatches(patches) {
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 3)
    throw new Error('Código experimental: se requieren 1..3 reemplazos');
  return patches.map((p, i) => {
    if (!ALLOWED.test(p?.path ?? '') || typeof p.search !== 'string' || typeof p.replace !== 'string' ||
      p.search.length < 12 || p.search.length > 7000 || p.replace.length > 9000)
      throw new Error(`Parche ${i} inválido; rutas permitidas solo reply-service.mjs y src/domain/*.mjs`);
    return { path:p.path, search:p.search, replace:p.replace };
  });
}
export async function prepareWorkspace(root, patches) {
  const edits = validatePatches(patches);
  const base = resolve(root);
  const workspace = await mkdtemp(join(tmpdir(), 'chat-lab-'));
  await cp(join(base, 'src'), join(workspace, 'src'), {recursive:true});
  const records = [];
  for (const edit of edits) {
    const path = resolve(workspace, edit.path);
    if (!path.startsWith(`${workspace}${sep}`)) throw new Error('Ruta fuera del sandbox');
    const original = await readFile(path, 'utf8');
    const match = original.indexOf(edit.search);
    if (match < 0 || original.indexOf(edit.search, match + edit.search.length) !== -1)
      throw new Error(`No se encontró un único bloque de reemplazo en ${edit.path}`);
    const modified = original.slice(0,match) + edit.replace + original.slice(match+edit.search.length);
    await writeFile(path, modified);
    records.push({ ...edit, originalSha256: digest(original), updatedSha256: digest(modified) });
  }
  for (const path of [...new Set(records.map(x => x.path))]) {
    execFileSync(process.execPath, ['--check', join(workspace, path)], {timeout: 10000, stdio: 'pipe'});
  }
  return { workspace, records };
}
