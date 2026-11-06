import {join} from 'node:path';
import {jobPaths, trainingCommand, deployCommand, stageProgress, parseTrainStep, splitOutput, summarizeReport} from './training-pipeline.mjs';

export class JobCancelled extends Error {constructor() {super('Cancelado por el usuario'); this.name = 'JobCancelled';}}

// Ejecutor local: reclama trabajos al motor, prepara el dataset, entrena y despliega en Ollama.
// Puertos inyectados: engine (API del motor), processes (procesos), files (disco) y gpu (liberar VRAM).
export class TrainingRunner {
  constructor({engine, processes, files, gpu, root, python, info = {}, flushMs = 2000, log = () => {}}) {
    Object.assign(this, {engine, processes, files, gpu, root, python, info, flushMs, log});
    this.current = null;
  }

  async tick() {
    if (this.current) return null;
    // Sin Python de entrenamiento no se reclaman trabajos: quedan en cola hasta que esté listo.
    if (!this.info.python) {await this.engine.heartbeat({...this.info, busy: false}); return null;}
    const job = await this.engine.claim(this.info);
    if (!job) {await this.engine.heartbeat({...this.info, busy: false}); return null;}
    this.current = job;
    try {return await this.run(job);}
    finally {this.current = null;}
  }

  async run(job) {
    const paths = jobPaths(this.root, job);
    const reporter = new Reporter(this.engine, job.id, this.flushMs);
    // Consulta periódica aunque el proceso no escriba nada (p. ej. al cargar pesos): detecta cancelaciones.
    const poll = setInterval(() => reporter.flush(true).catch(() => {}), Math.max(this.flushMs * 5, 5000));
    try {
      await reporter.event({stage: 'dataset', progress: stageProgress('dataset'), message: 'Preparando dataset'});
      await this.files.mkdir(paths.dataset);
      for (const split of ['train', 'validation', 'test'])
        await this.files.writeFile(join(paths.dataset, `${split}.jsonl`), await this.engine.dataset(job.id, split));
      const manifest = await this.engine.dataset(job.id, 'manifest');
      await this.files.writeFile(join(paths.dataset, 'manifest.json'), JSON.stringify(manifest, null, 2));
      reporter.log(`Dataset: ${manifest.counts.train} train, ${manifest.counts.validation} validación, ${manifest.counts.test} reservados`);

      // Validar solo tokeniza en CPU: no hace falta quitarle la GPU a Ollama.
      if (!job.spec.validateOnly) {
        await reporter.event({stage: 'free_gpu', progress: stageProgress('free_gpu'), message: 'Liberando VRAM de Ollama'});
        const unloaded = await this.gpu.unloadModels();
        if (unloaded.length) reporter.log(`Modelos descargados de la GPU: ${unloaded.join(', ')}`);
      }

      await reporter.event({stage: 'train', progress: stageProgress('train'),
        message: job.spec.validateOnly ? 'Validando máscaras y tokenización' : 'Entrenando LoRA'});
      await this._exec(trainingCommand(job, paths, this.python), reporter, line => {
        const fraction = parseTrainStep(line, job.spec.steps);
        if (fraction !== null) reporter.progress(stageProgress('train', fraction));
      });

      if (job.spec.validateOnly) {
        const audit = JSON.parse(await this.files.readFile(join(this.root, 'work', 'training-mask-audit.json')));
        return await reporter.finish({state: 'succeeded', progress: 1, message: 'Validación completada', result: {validateOnly: true, audit}});
      }
      const report = JSON.parse(await this.files.readFile(join(paths.adapter, 'training-report.json')));
      const summary = summarizeReport(report, job);
      reporter.log(`Pérdida de validación: ${summary.baselineEvalLoss} → ${summary.finalEvalLoss}`);

      await reporter.event({stage: 'deploy', progress: stageProgress('deploy'), message: `Fusionando, cuantizando (${job.spec.quant}) y registrando ${job.spec.tag}`});
      await this._exec(deployCommand(job, paths), reporter);

      await reporter.event({stage: 'cleanup', progress: stageProgress('cleanup'), message: 'Limpiando archivos intermedios'});
      if (!job.spec.keepMerged) await this.files.rm(paths.merged);
      await this.files.rm(paths.gguf);
      return await reporter.finish({state: 'succeeded', progress: 1, message: `Modelo ${job.spec.tag} disponible en Ollama`,
        result: {...summary, ollamaModel: job.spec.tag, adapterDir: paths.adapter}});
    } catch (error) {
      const cancelled = error instanceof JobCancelled || reporter.cancelRequested;
      return await reporter.finish({state: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Cancelado por el usuario' : String(error?.message ?? error).slice(0, 400)});
    } finally {clearInterval(poll);}
  }

  // Ejecuta un comando, reenvía su salida y lo detiene si el usuario cancela.
  async _exec({command, args}, reporter, onLine = () => {}) {
    if (reporter.cancelRequested) throw new JobCancelled();
    const child = this.processes.spawn(command, args, {cwd: this.root});
    reporter.onCancel = () => child.kill();
    let rest = '', last = '';
    const consume = chunk => {
      const out = splitOutput(rest + chunk);
      rest = out.rest;
      for (const line of out.lines) {onLine(line); reporter.log(line); last = line;}
    };
    child.onOutput(consume);
    const code = await child.exited;
    reporter.onCancel = null;
    if (rest) consume('\n');
    if (reporter.cancelRequested) throw new JobCancelled();
    if (code !== 0) throw new Error(`${command.split(/[\\/]/).at(-1)} terminó con código ${code}: ${last.slice(0, 300)}`);
  }
}

// Agrupa logs y avance para no saturar el motor; cada envío informa si se pidió cancelar.
class Reporter {
  constructor(engine, jobId, flushMs) {
    Object.assign(this, {engine, jobId, flushMs});
    this.lines = []; this.pending = {}; this.cancelRequested = false; this.onCancel = null; this.timer = null; this.lastProgress = -1;
  }
  log(line) {
    // tqdm repite la misma barra muchas veces: se conserva una línea por cada 2 % de avance.
    const bar = /(\d+)%\|/.exec(line);
    if (bar) {const p = Number(bar[1]); if (Math.abs(p - this.lastProgress) < 2 && p !== 100) return; this.lastProgress = p;}
    else this.lastProgress = -1;
    this.lines.push(line);
    this._schedule();
  }
  progress(value) {this.pending.progress = value; this._schedule();}
  async event(change) {Object.assign(this.pending, change); await this.flush();}
  _schedule() {if (!this.timer) this.timer = setTimeout(() => this.flush().catch(() => {}), this.flushMs);}
  async flush(force = false) {
    clearTimeout(this.timer); this.timer = null;
    const logs = this.lines.splice(0), change = this.pending;
    this.pending = {};
    if (!force && !logs.length && !Object.keys(change).length) return;
    const answer = await this.engine.report(this.jobId, {...change, logs});
    if (answer?.cancelRequested && !this.cancelRequested) {this.cancelRequested = true; this.onCancel?.();}
  }
  async finish(final) {
    try {await this.flush();} catch {}
    return this.engine.report(this.jobId, {...final, logs: []});
  }
}
