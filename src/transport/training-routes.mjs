import {TrainingValidationError} from '../domain/training-job.mjs';

const JOB_PATH = /^\/api\/training\/jobs\/(train_[a-z0-9]+_[a-f0-9]{8})(\/cancel|\/retry|\/dataset|\/events|\/calibrate-reviewer)?$/;

// Rutas administrativas de entrenamiento y modelos. Devuelve false si la ruta no le corresponde.
// Las rutas /runner y /dataset/events las usa el ejecutor local; requieren el mismo token administrativo.
export async function handleTrainingRoutes({req, res, path, url, training, models, send, readJson}) {
  if (!path.startsWith('/api/training') && path !== '/api/models') return false;
  const reply = (status, body) => {send(res, status, body); return true;};
  try {
    if (req.method === 'GET' && path === '/api/models') {
      if (!models) return reply(503, {error: 'Catálogo de modelos no disponible'});
      try {return reply(200, {models: await models.list()});}
      catch {return reply(502, {error: 'Ollama no respondió al listar modelos', code: 'OLLAMA_MODELS_FAILED'});}
    }
    if (!training) return reply(503, {error: 'Entrenamiento no disponible'});
    if (req.method === 'GET' && path === '/api/training/sources') return reply(200, {sources: training.listSources()});
    if (req.method === 'GET' && path === '/api/training/runner') return reply(200, {runner: training.runnerStatus()});
    if (req.method === 'POST' && path === '/api/training/plan') return reply(200, {plan: training.planDataset(await readJson())});
    if (req.method === 'GET' && path === '/api/training/jobs') return reply(200, {jobs: training.listJobs()});
    if (req.method === 'GET' && path === '/api/training/cleaning') return reply(200, {labeling: training.burstLabelingStatus()});
    if (req.method === 'POST' && path === '/api/training/cleaning/label') return reply(202, {labeling: training.startBurstLabeling(await readJson())});
    if (req.method === 'POST' && path === '/api/training/cleaning/pause') return reply(200, {labeling: training.pauseBurstLabeling()});
    if (req.method === 'POST' && path === '/api/training/jobs') return reply(201, {job: training.createJob(await readJson())});
    if (req.method === 'POST' && path === '/api/training/runner/heartbeat')
      return reply(200, {runner: training.heartbeat(await readJson())});
    if (req.method === 'POST' && path === '/api/training/runner/claim')
      return reply(200, {job: training.claim(await readJson())});
    const match = path.match(JOB_PATH);
    if (!match) return reply(404, {error: 'Ruta no encontrada'});
    const [, id, action] = match;
    let result;
    if (req.method === 'GET' && !action) {
      const after = Number(url.searchParams.get('after_log') ?? 0);
      result = training.getJob(id, Number.isSafeInteger(after) && after >= 0 ? after : 0);
    } else if (req.method === 'POST' && action === '/cancel') result = training.cancel(id) && {job: training.getJob(id).job};
    else if (req.method === 'POST' && action === '/retry') {
      const job = training.retry(id);
      result = job && {job};
    }
    else if (req.method === 'GET' && action === '/dataset') {
      // Cada partición se entrega como JSONL para no armar un único JSON de decenas de MB.
      const split = url.searchParams.get('split') ?? 'manifest';
      if (!['train', 'validation', 'test', 'manifest'].includes(split)) return reply(422, {error: 'split inválido'});
      const data = training.datasetFor(id);
      if (!data) return reply(404, {error: 'Trabajo inexistente o no disponible'});
      if (split === 'manifest') return reply(200, data.manifest);
      res.writeHead(200, {'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      res.end(data[split].map(row => JSON.stringify(row)).join('\n') + '\n');
      return true;
    }
    else if (req.method === 'POST' && action === '/calibrate-reviewer') {
      const job = await training.calibrateReviewer(id);
      result = job && {job};
    }
    else if (req.method === 'POST' && action === '/events') result = training.report(id, await readJson());
    else return reply(405, {error: 'Método no permitido'});
    if (!result) return reply(404, {error: 'Trabajo inexistente o no disponible'});
    return reply(200, result);
  } catch (err) {
    if (err instanceof TrainingValidationError) return reply(422, {error: err.message, code: 'TRAINING_INVALID'});
    throw err;
  }
}
