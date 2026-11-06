import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSettings } from './conversation-simulator.mjs';
const sha = data => createHash('sha256').update(data).digest('hex');
const MAP = { model:'LLM_MODEL', temperature:'MODEL_TEMPERATURE', replyMaxTokens:'REPLY_MAX_TOKENS',
  replyReview:'REPLY_REVIEW', semanticRouter:'SEMANTIC_ROUTER' };
function updateEnv(text, config) {
  for (const [key, value] of Object.entries(config)) {
    if (!(key in MAP)) continue;
    const name=MAP[key], newLine=`${name}=${value}`;
    const regex = new RegExp(`^${name}=.*$`, 'm');
    text = regex.test(text) ? text.replace(regex,newLine) : `${text.trimEnd()}\n${newLine}\n`;
  }
  return text;
}
// The automatic optimization never changes production; this explicit operation is separate.
export async function applyApproved({ registry, id, root = process.cwd(), yes = false }) {
  if (!yes) throw new Error('Debes aprobar explícitamente --apply para alterar archivos de producción');
  if (!/^[a-f0-9-]{10,50}$/i.test(id)) throw new Error('ID de experimento inválido');
  const approved=await registry.readApproved(id);
  if (!approved.humanApproved || !approved.gate?.accepted || approved.productionApplied)
    throw new Error('Experimento no aprobado, no cumple el quality gate o ya aplicado');
  const patches=approved.patches ?? [];
  const files = new Map();
  for (const patch of patches) {
    if (!/^src\/(?:app\/reply-service\.mjs|domain\/[a-z][a-z0-9-]*\.mjs)$/.test(patch.path)) throw new Error('Ruta no permitida');
    const file=resolve(root,patch.path);
    const original=files.get(file) ?? await readFile(file,'utf8');
    if (sha(original)!==patch.originalSha256) throw new Error(`El archivo cambió desde el experimento: ${patch.path}`);
    const idx=original.indexOf(patch.search);
    if (idx<0 || original.indexOf(patch.search,idx+patch.search.length)!==-1) throw new Error('Parche ambiguo o no aplicable');
    files.set(file, original.slice(0,idx)+patch.replace+original.slice(idx+patch.search.length));
  }
  const envPath=join(root,'.env');
  const currentEnv=await readFile(envPath,'utf8');
  const settings=validateSettings(approved.settings);
  const timestamp = new Date().toISOString().replace(/[:.]/g,'-');
  const backup=join(registry.dir,`backup-${id}-${timestamp}`);
  await mkdir(backup,{recursive:true,mode:0o700});
  await writeFile(join(backup,'.env'),currentEnv,{mode:0o600});
  for (const [file, content] of files) {
    const relative=file.slice(resolve(root).length+1).replaceAll('/','__');
    await copyFile(file,join(backup,relative));
  }
  for (const [file, content] of files) await writeFile(file,content);
  await writeFile(envPath,updateEnv(currentEnv,settings),{mode:0o600});
  // In approved file we don't store any sensitive values from .env.
  approved.productionApplied=true;
  approved.backupDir=backup;
  await writeFile(join(registry.dir,`approved-${id}.json`),JSON.stringify(approved,null,2),{mode:0o600});
  return {files:[...files.keys()],envUpdated:true,backup};
}
