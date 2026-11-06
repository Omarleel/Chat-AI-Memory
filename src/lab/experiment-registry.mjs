import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const hashJson = item => createHash('sha256').update(JSON.stringify(item)).digest('hex');
export class ExperimentRegistry {
  constructor(dir) { this.dir = dir; }
  async init() { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }
  async readHistory() {
    await this.init();
    try { return JSON.parse(await readFile(join(this.dir, 'history.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async record(item) {
    const row = { id: item.id ?? randomUUID(), at: new Date().toISOString(), ...item };
    const history = await this.readHistory();
    history.push(row);
    await atomicJson(join(this.dir, 'history.json'), history);
    await atomicJson(join(this.dir, `experiment-${row.id}.json`), row);
    return row;
  }
  async approved(candidate) {
    await this.init();
    const approved = { ...candidate, approvedAt: new Date().toISOString(),
      humanApproved: true, productionApplied: false };
    await atomicJson(join(this.dir, `approved-${candidate.id}.json`), approved);
    return approved;
  }
  async readApproved(id) { return JSON.parse(await readFile(join(this.dir, `approved-${id}.json`), 'utf8')); }
  async acquireLock() {
    await this.init();
    const path = join(this.dir, '.running');
    const fd = await open(path, 'wx', 0o600).catch(err => {
      if (err.code === 'EEXIST') throw new Error(`Ya hay un laboratorio activo en ${this.dir}; elimina .running solo si comprobaste que terminó`);
      throw err;
    });
    await fd.writeFile(`${process.pid}\n`);
    await fd.close();
    return async () => { const { unlink } = await import('node:fs/promises'); await unlink(path).catch(() => {}); };
  }
}
export async function atomicJson(path, data) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
