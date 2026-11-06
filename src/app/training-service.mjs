import {randomBytes} from 'node:crypto';
import {normalizeTrainingRequest, buildIdentityDataset, applyRunnerEvent, TrainingValidationError, FINAL_STATES} from '../domain/training-job.mjs';
import {normalizeCleaning} from '../domain/burst-cleaning.mjs';

const RUNNER_TIMEOUT_MS = 30_000;
const MIN_TRAIN_ROWS = 50;

// Casos de uso del entrenamiento de identidad. El motor conserva SQLite como fuente de verdad:
// el ejecutor local (GPU) reclama trabajos, descarga el dataset y notifica su avance.
export class TrainingService {
  constructor({repository, config, calibrator = null, burstLabeler = null}) {
    Object.assign(this, {repository, config, calibrator, burstLabeler});
    this.runner = null;
    this.calibrating = new Set();
  }

  listSources() {
    return [...this.config.allowedContacts].flatMap(contact => this.repository.listChatImports(contact));
  }

  // Reconstruye las fuentes desde SQLite y exige que todas pertenezcan al mismo titular.
  resolveSources(input) {
    const requested = Array.isArray(input?.sources) ? input.sources : [];
    const imports = requested.map(s => {
      const contact = String(s?.contact ?? '').replace(/\D/g, '');
      if (!this.config.allowedContacts.has(contact)) throw new TrainingValidationError('Contacto fuera de allowlist');
      const found = this.repository.getChatImport(contact, String(s?.importHash ?? ''));
      if (!found) throw new TrainingValidationError('Importación inexistente');
      return found;
    });
    const owners = new Set(imports.map(i => i.self.trim().toLocaleLowerCase()));
    if (owners.size > 1) throw new TrainingValidationError('Todos los chats deben tener el mismo titular (self)');
    const selfName = String(input?.selfName ?? '').trim() || imports[0]?.self || '';
    if (imports.length && selfName.toLocaleLowerCase() !== [...owners][0])
      throw new TrainingValidationError(`selfName no coincide con el titular de los chats (${imports[0].self})`);
    return {imports, selfName};
  }

  _protectedModels() {
    return [this.config.chatModel, this.config.reasoningModel, this.config.embedModel].filter(Boolean);
  }

  _dataset(spec) {
    const cleaning = normalizeCleaning(spec.cleaning);
    return buildIdentityDataset(spec.sources.map(s => ({...s, messages: this.repository.listImportMessages(s.contact, s.importHash)})),
      {cleaning, labels: cleaning.bursts === 'llm' ? this.repository.listBurstLabels() : new Map()});
  }

  // Etiquetado de ráfagas con el modelo general, previo a entrenar con cleaning.bursts=llm.
  _labelSources(input) {
    if (!this.burstLabeler) throw new TrainingValidationError('Limpieza de ráfagas no disponible: falta REASONING_MODEL');
    const {imports, selfName} = this.resolveSources(input);
    return {selfName, sources: imports.map(i => ({contact: i.contact, importHash: i.importHash, peer: i.peer}))};
  }
  startBurstLabeling(input) {
    const {selfName, sources} = this._labelSources(input);
    const limit = Number.isSafeInteger(input?.limit) && input.limit > 0 ? input.limit : null;
    return this.burstLabeler.start({sources, selfName, limit});
  }
  burstLabelingStatus() {return this.burstLabeler ? this.burstLabeler.status() : {state: 'unavailable'};}
  pauseBurstLabeling() {return this.burstLabeler ? this.burstLabeler.pause() : {state: 'unavailable'};}

  _stats(data) {
    return {counts: {train: data.train.length, validation: data.validation.length, test: data.test.length}, ...data.stats};
  }

  planDataset(input) {
    const {selfName} = this.resolveSources(input);
    const spec = normalizeTrainingRequest({...input, selfName, modelName: input?.modelName || 'plan'}, {protectedModels: []});
    return this._stats(this._dataset(spec));
  }

  createJob(input) {
    const {selfName} = this.resolveSources(input);
    const spec = normalizeTrainingRequest({...input, selfName}, {protectedModels: this._protectedModels()});
    if (this.repository.hasActiveTrainingJob(spec.tag)) throw new TrainingValidationError(`Ya hay un entrenamiento activo para ${spec.tag}`);
    const stats = this._stats(this._dataset(spec));
    if (stats.cleaning?.unlabeled)
      throw new TrainingValidationError(`Faltan ${stats.cleaning.unlabeled} ráfagas por etiquetar: ejecuta primero el etiquetado`);
    if (stats.counts.train < MIN_TRAIN_ROWS || !stats.counts.validation)
      throw new TrainingValidationError(`Datos insuficientes: ${stats.counts.train} ejemplos de entrenamiento (mínimo ${MIN_TRAIN_ROWS}) y ${stats.counts.validation} de validación`);
    const id = `train_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    return this.repository.createTrainingJob({id, spec: {...spec, datasetStats: stats}});
  }

  listJobs() { return this.repository.listTrainingJobs(); }

  getJob(id, afterLogId = 0) {
    const job = this.repository.getTrainingJob(id);
    return job ? {job, logs: this.repository.listTrainingLogs(id, afterLogId)} : null;
  }

  cancel(id) {
    const job = this.repository.getTrainingJob(id);
    if (!job) return null;
    if (FINAL_STATES.has(job.state)) throw new TrainingValidationError('El trabajo ya terminó');
    if (job.state === 'queued') return this.repository.updateTrainingJob({...job, state: 'cancelled', message: 'Cancelado antes de empezar'});
    return this.repository.updateTrainingJob({...job, state: 'cancel_requested', message: 'Cancelación solicitada'});
  }

  // Un trabajo fallido vuelve a la cola con el mismo id: su carpeta conserva los checkpoints y el
  // ejecutor reanuda desde el último. El dataset se reconstruye igual (mismas fuentes y etiquetas).
  retry(id) {
    const job = this.repository.getTrainingJob(id);
    if (!job) return null;
    if (job.state !== 'failed') throw new TrainingValidationError('Solo se reintenta un trabajo fallido');
    if (this.repository.hasActiveTrainingJob(job.spec.tag)) throw new TrainingValidationError(`Ya hay un entrenamiento activo para ${job.spec.tag}`);
    const unlabeled = this._stats(this._dataset(job.spec)).cleaning?.unlabeled;
    if (unlabeled) throw new TrainingValidationError(`Faltan ${unlabeled} ráfagas por etiquetar: ejecuta primero el etiquetado`);
    return this.repository.requeueTrainingJob(id, 'Reintento: reanuda desde el último checkpoint');
  }

  // --- Puerto del ejecutor local ---
  heartbeat(info = {}) {
    this.runner = {lastSeen: Date.now(), info: {
      name: String(info.name ?? 'runner').slice(0, 80), python: info.python === true, gpu: String(info.gpu ?? '').slice(0, 120),
      version: String(info.version ?? '').slice(0, 20), busy: info.busy === true}};
    return this.runnerStatus();
  }

  runnerStatus() {
    if (!this.runner) return {online: false, lastSeen: null, info: null};
    return {online: Date.now() - this.runner.lastSeen < RUNNER_TIMEOUT_MS, lastSeen: new Date(this.runner.lastSeen).toISOString(), info: this.runner.info};
  }

  claim(info = {}) {
    this.heartbeat({...info, busy: false});
    // Un ejecutor solo reclama cuando está libre: lo que siga activo a su nombre quedó huérfano
    // (por ejemplo, se cerró la consola a mitad del entrenamiento).
    for (const job of this.repository.listTrainingJobs(200))
      if (job.runner === this.runner.info.name && ['running', 'cancel_requested'].includes(job.state))
        this.repository.updateTrainingJob({...job, state: job.state === 'running' ? 'failed' : 'cancelled',
          message: 'El ejecutor se reinició antes de terminar'});
    return this.repository.claimNextTrainingJob(this.runner.info.name);
  }

  // El dataset se construye en el momento: el contenido de los chats no se guarda duplicado.
  datasetFor(id) {
    const job = this.repository.getTrainingJob(id);
    if (!job || job.state !== 'running') return null;
    const data = this._dataset(job.spec);
    return {train: data.train, validation: data.validation, test: data.test,
      manifest: {format: 'conversational_prompt_completion', jobId: id, modelName: job.modelName, selfName: job.selfName,
        createdAt: new Date().toISOString(), ...this._stats(data)}};
  }

  report(id, event = {}) {
    const job = this.repository.getTrainingJob(id);
    if (!job) return null;
    const lines = Array.isArray(event.logs) ? event.logs.slice(0, 500).map(l => String(l).slice(0, 1000)) : [];
    this.repository.appendTrainingLogs(id, lines);
    if (this.runner) this.runner.lastSeen = Date.now();
    if (FINAL_STATES.has(job.state)) return {job, cancelRequested: false};
    const {logs, ...change} = event;
    const updated = Object.keys(change).length ? this.repository.updateTrainingJob(applyRunnerEvent(job, change)) : job;
    // Tras entrenar una identidad se mide cuántas respuestas reales suyas rechaza el revisor.
    if (updated.state === 'succeeded' && !updated.spec.validateOnly && this.calibrator)
      this.calibrateReviewer(id).catch(() => {});
    return {job: updated, cancelRequested: updated.state === 'cancel_requested'};
  }

  // Calibración del revisor con las conversaciones reservadas del trabajo; corre en segundo plano.
  async calibrateReviewer(id, {limit = 30} = {}) {
    const job = this.repository.getTrainingJob(id);
    if (!job) return null;
    if (!this.calibrator) throw new TrainingValidationError('Calibración no disponible: falta REASONING_MODEL');
    if (job.state !== 'succeeded') throw new TrainingValidationError('Solo se calibra un trabajo terminado con éxito');
    if (this.calibrating.has(id)) return job;
    this.calibrating.add(id);
    const save = calibration => {
      const current = this.repository.getTrainingJob(id);
      return this.repository.updateTrainingJob({...current, result: {...current.result, reviewerCalibration: calibration}});
    };
    const started = save({state: 'running', reviewer: this.config.reasoningModel, done: 0, total: null, startedAt: new Date().toISOString()});
    (async () => {
      try {
        const data = this._dataset(job.spec);
        const source = job.spec.sources[0];
        const peerName = this.repository.getChatImport(source.contact, source.importHash)?.peer || 'Interlocutor';
        let last = 0;
        const summary = await this.calibrator.calibrate({testRows: data.test, trainRows: data.train, selfName: job.selfName, peerName, limit,
          onProgress: (done, total) => {if (done - last >= 5 || done === total) {last = done; save({state: 'running', reviewer: this.config.reasoningModel, done, total});}}});
        save({state: 'done', reviewer: this.config.reasoningModel, finishedAt: new Date().toISOString(), ...summary});
      } catch (error) {
        save({state: 'failed', reviewer: this.config.reasoningModel, error: String(error?.message ?? error).slice(0, 300)});
      } finally {this.calibrating.delete(id);}
    })();
    return started;
  }
}
