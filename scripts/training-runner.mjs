// Ejecutor local de entrenamiento: corre en el equipo con GPU, fuera de Docker.
//   node --env-file=.env scripts/training-runner.mjs
// Reclama trabajos al motor (http://127.0.0.1:APP_PORT), entrena con .venv-lora y registra el modelo en Ollama.
import {existsSync} from 'node:fs';
import {mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TrainingRunner} from '../src/runner/training-runner.mjs';
import {EngineApiClient} from '../src/infra/engine-api-client.mjs';
import {hostProcesses, detectGpu} from '../src/infra/host-processes.mjs';
import {OllamaGpu} from '../src/infra/ollama-gpu.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const token = process.env.ADMIN_TOKEN ?? '';
if (token.length < 32) throw new Error('Define ADMIN_TOKEN en .env');
const python = process.env.TRAINING_PYTHON || join(root, '.venv-lora', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const engineUrl = process.env.TRAINING_ENGINE_URL || `http://127.0.0.1:${process.env.APP_PORT || 3000}`;
const ollamaUrl = process.env.TRAINING_OLLAMA_URL || 'http://127.0.0.1:11434';
const interval = Number(process.env.TRAINING_POLL_MS || 5000);

const files = {
  mkdir: path => mkdir(path, {recursive: true}),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  readFile: path => readFile(path, 'utf8'),
  rm: path => rm(path, {recursive: true, force: true})
};
const info = {name: `runner@${process.env.COMPUTERNAME || process.env.HOSTNAME || 'local'}`, python: existsSync(python),
  gpu: detectGpu(), version: '1'};
const runner = new TrainingRunner({engine: new EngineApiClient({baseUrl: engineUrl, token}), processes: hostProcesses, files,
  gpu: new OllamaGpu({baseUrl: ollamaUrl}), root, python, info});

console.log(`Ejecutor de entrenamiento: motor ${engineUrl}, Python ${info.python ? python : 'NO ENCONTRADO'}, GPU ${info.gpu || 'no detectada'}`);
let stopping = false;
process.on('SIGINT', () => {stopping = true; console.log('Deteniendo tras el trabajo actual…');});
while (!stopping) {
  try {
    const finished = await runner.tick();
    if (finished?.job) console.log(`Trabajo ${finished.job.id}: ${finished.job.state} — ${finished.job.message ?? ''}`);
  } catch (error) {
    console.error('Ejecutor:', error.message);
  }
  await new Promise(r => setTimeout(r, interval));
}
