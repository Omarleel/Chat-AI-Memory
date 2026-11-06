import {useEffect, useState} from 'react';
import {Bot, Cpu, QrCode, RefreshCw, Smartphone} from 'lucide-react';
import {useApi, useQuery} from '../../application/services.jsx';
import {navigate} from '../../application/use-route.js';
import {JOB_STATES, JOB_STAGES, isActiveJob} from '../../domain/training.js';
import {formatDate} from '../../domain/format.js';
import {Badge, Card, ErrorNotice, Loading, Notice, PageHeader, ProgressBar, Stat} from '../components/primitives.jsx';

const WA_STATE = {connected: ['Conectado', 'green'], qr: ['Esperando QR', 'amber'], connecting: ['Conectando', 'blue'],
  starting: ['Iniciando', 'blue'], disconnected: ['Desconectado', 'red'], logged_out: ['Sesión cerrada', 'red'],
  stopped: ['Detenido', 'slate'], configured: ['Cloud API configurada', 'green'], unconfigured: ['Cloud API sin configurar', 'amber']};

export function DashboardPage() {
  const api = useApi();
  const system = useQuery(() => api.system());
  const runner = useQuery(() => api.trainingRunner(), [], {intervalMs: 10000});
  const jobs = useQuery(() => api.trainingJobs(), [], {intervalMs: 10000});
  const s = system.data;
  return (
    <>
      <PageHeader title="Panel" description="Estado de la instalación: identidad activa, modelos, WhatsApp y entrenamientos." />
      <ErrorNotice error={system.error} className="mb-4" />
      {s?.autoSend && <Notice kind="warning" title="AUTO_SEND=true" className="mb-4">Los borradores aprobados se envían solos por WhatsApp. Para pruebas, deja AUTO_SEND=false.</Notice>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Identidad activa" description="Definida en .env; cambiarla requiere recrear el contenedor app." className="lg:col-span-2">
          {!s ? <Loading /> : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Titular" value={s.selfName} />
              <Stat label="Redactor (estilo)" value={s.chatModel} />
              <Stat label="Revisor" value={s.reasoningModel} />
              <Stat label="Pipeline" value={s.replyPipeline} hint={`${s.replyCandidates} borrador${s.replyCandidates === 1 ? '' : 'es'} por mensaje`} />
              <Stat label="Revisión" value={s.replyReview && s.semanticRouter ? 'Activa' : 'Desactivada'} />
              <Stat label="Envío automático" value={s.autoSend ? 'Activado' : 'Desactivado'} tone={s.autoSend ? 'red' : undefined} />
              <Stat label="Embeddings" value={s.embedModel} />
              <Stat label="Memoria" value={s.memoryBackend ?? '—'} />
              <Stat label="Contactos autorizados" value={s.allowedContacts} />
            </div>
          )}
        </Card>
        <WhatsAppCard />
        <Card title="Entrenamiento" className="lg:col-span-3"
          actions={<button className="btn-secondary" onClick={() => navigate('/entrenamiento')}><Bot className="h-4 w-4" />Abrir</button>}>
          <div className="mb-4 flex items-center gap-3 text-sm">
            <Cpu className="h-4 w-4 text-slate-400" aria-hidden="true" />
            {runner.data?.online
              ? <span>Ejecutor local conectado{runner.data.info?.gpu ? ` · ${runner.data.info.gpu}` : ''}</span>
              : <span className="text-amber-600">Ejecutor local sin conexión: <code className="text-xs">node --env-file=.env scripts/training-runner.mjs</code></span>}
          </div>
          {jobs.loading && !jobs.data ? <Loading /> : !jobs.data?.length ? <p className="text-sm text-slate-500">Aún no hay entrenamientos.</p> : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {jobs.data.slice(0, 5).map(job => (
                <li key={job.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <button className="font-medium hover:underline" onClick={() => navigate('/entrenamiento', {job: job.id})}>{job.tag}</button>
                  <Badge tone={JOB_STATES[job.state]?.tone}>{JOB_STATES[job.state]?.label ?? job.state}</Badge>
                  {isActiveJob(job) && <span className="w-40"><ProgressBar value={job.progress} /></span>}
                  <span className="text-xs text-slate-500">{isActiveJob(job) ? JOB_STAGES[job.stage] ?? '' : formatDate(job.finishedAt ?? job.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function WhatsAppCard() {
  const api = useApi();
  const status = useQuery(() => api.whatsappStatus(), [], {intervalMs: 8000});
  const [qr, setQr] = useState(null);
  const needsQr = status.data?.hasQr;
  useEffect(() => {
    let url = null, alive = true;
    if (needsQr) api.whatsappQrUrl().then(u => {url = u; if (alive) setQr(u);}).catch(() => {});
    else setQr(null);
    return () => {alive = false; if (url) URL.revokeObjectURL(url);};
  }, [needsQr, status.data?.state]);
  const [label, tone] = WA_STATE[status.data?.state] ?? [status.data?.state ?? '—', 'slate'];
  return (
    <Card title="WhatsApp" description={status.data ? `Proveedor: ${status.data.provider}` : undefined}
      actions={<button className="btn-ghost p-1.5" onClick={() => status.reload()} aria-label="Actualizar"><RefreshCw className="h-4 w-4" /></button>}>
      <ErrorNotice error={status.error} />
      <div className="flex items-center gap-2 text-sm"><Smartphone className="h-4 w-4 text-slate-400" aria-hidden="true" /><Badge tone={tone}>{label}</Badge></div>
      {qr && (
        <div className="mt-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-500"><QrCode className="h-3.5 w-3.5" />WhatsApp → Dispositivos vinculados → Vincular</p>
          <img src={qr} alt="Código QR para vincular WhatsApp" className="mx-auto w-56 rounded-lg bg-white p-2" />
        </div>
      )}
    </Card>
  );
}
