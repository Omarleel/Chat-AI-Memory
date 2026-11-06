// Select a test group without depending on shell glob expansion (CMD/PowerShell compatible).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const group=process.argv[2];
if (!['unit','integration'].includes(group)) {
  console.error('Uso: node tests/run-group.mjs unit|integration');
  process.exit(2);
}
const dir=resolve('tests',group);
const files=readdirSync(dir).filter(name=>name.endsWith('.test.mjs')).sort()
  .map(name=>resolve(dir,name));
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:process.env});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
