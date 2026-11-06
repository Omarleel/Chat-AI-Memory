import {join} from 'node:path';
import {TRAINING_SYSTEM} from '../domain/training-dataset.mjs';

// Plan de ejecución de un trabajo en el equipo con GPU. Funciones puras: sin procesos ni red.
export function jobPaths(root, job) {
  const base = join(root, 'data', 'identities', job.modelName, job.id);
  return {base, dataset: join(base, 'dataset'), adapter: join(base, 'lora'), merged: join(base, 'merged'),
    gguf: join(base, `${job.modelName}-${job.spec.quant === 'q4_K_M' ? 'q4_k_m' : 'q8'}.gguf`)};
}

export function trainingCommand(job, paths, python) {
  const args = ['scripts/train_lora.py', '--dataset', paths.dataset, '--output', paths.adapter,
    '--model', job.spec.baseModel, '--steps', String(job.spec.steps), '--learning-rate', String(job.spec.learningRate),
    '--max-length', String(job.spec.maxLength), '--overwrite', '--resume'];
  if (job.spec.validateOnly) args.push('--validate-only');
  return {command: python, args};
}

export function deployCommand(job, paths, shell = 'powershell.exe') {
  return {command: shell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/deploy_trained_model.ps1',
    '-AdapterDir', paths.adapter, '-MergedDir', paths.merged, '-GgufPath', paths.gguf,
    '-ModelName', job.spec.tag, '-Quant', job.spec.quant, '-SystemPrompt', TRAINING_SYSTEM]};
}

// Avance global: el entrenamiento ocupa la mayor parte; la barra de evaluación se ignora
// porque su total no coincide con los pasos configurados.
const RANGES = {dataset: [0, 0.03], free_gpu: [0.03, 0.05], train: [0.05, 0.85], deploy: [0.85, 0.98], cleanup: [0.98, 1]};
export function stageProgress(stage, fraction = 0) {
  const [start, end] = RANGES[stage] ?? [0, 1];
  return Number((start + (end - start) * Math.min(1, Math.max(0, fraction))).toFixed(4));
}

export function parseTrainStep(line, steps) {
  let found = null;
  for (const m of String(line).matchAll(/(\d+)\/(\d+) \[/g)) if (Number(m[2]) === steps) found = Number(m[1]);
  return found === null ? null : found / steps;
}

// Separa la salida en líneas legibles: tqdm reescribe la misma línea con \r.
export function splitOutput(buffer) {
  const parts = buffer.split(/\r\n|\n|\r/);
  return {lines: parts.slice(0, -1).map(l => l.trimEnd()).filter(Boolean), rest: parts.at(-1)};
}

export function summarizeReport(report, job) {
  return {baseModel: report?.base_model ?? job.spec.baseModel,
    baselineEvalLoss: report?.baseline?.eval_loss ?? null, finalEvalLoss: report?.final?.eval_loss ?? null,
    improved: Number.isFinite(report?.final?.eval_loss) && Number.isFinite(report?.baseline?.eval_loss)
      ? report.final.eval_loss < report.baseline.eval_loss : null,
    bestCheckpoint: report?.best_checkpoint ? String(report.best_checkpoint).split(/[\\/]/).at(-1) : null,
    audit: report?.audit ?? null};
}
