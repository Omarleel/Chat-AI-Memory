import {Boxes, MessageSquareText, RefreshCw} from 'lucide-react';
import {useApi, useQuery} from '../../application/services.jsx';
import {navigate} from '../../application/use-route.js';
import {formatBytes, formatDate} from '../../domain/format.js';
import {Badge, Card, EmptyState, ErrorNotice, Loading, Notice, PageHeader} from '../components/primitives.jsx';

const ROLE = {writer: ['Redactor', 'green'], reasoner: ['Revisor', 'blue'], embedding: ['Embeddings', 'violet']};

export function ModelsPage() {
  const api = useApi();
  const models = useQuery(() => api.models(), [], {intervalMs: 15000});
  const vram = (models.data ?? []).reduce((n, m) => n + (m.vram ?? 0), 0);
  return (
    <>
      <PageHeader title="Modelos" description="Modelos instalados en Ollama. Los marcados como redactor y revisor son los de .env (LLM_MODEL y REASONING_MODEL)."
        actions={<button className="btn-secondary" onClick={() => models.reload()}><RefreshCw className="h-4 w-4" />Actualizar</button>} />
      <ErrorNotice error={models.error} className="mb-4" />
      <Notice kind="info" className="mb-4">
        Para activar otra identidad como redactor fija <code>LLM_MODEL</code> y <code>SELF_DISPLAY_NAME</code> en .env y recrea la app
        (<code>docker compose up -d app</code>). Antes, pruébala en Preview y evalúala con el holdout.
      </Notice>
      <Card title="Instalados" description={vram ? `En GPU ahora: ${formatBytes(vram)}` : 'Ningún modelo cargado en GPU'} bodyClassName="">
        {models.loading && !models.data ? <div className="px-5"><Loading /></div> : !models.data?.length ? <EmptyState icon={Boxes} title="Ollama no tiene modelos" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr><th className="px-5 py-2 font-medium">Modelo</th><th className="px-3 py-2 font-medium">Papel</th><th className="px-3 py-2 font-medium">Detalles</th>
                  <th className="px-3 py-2 text-right font-medium">Tamaño</th><th className="px-3 py-2 font-medium">GPU</th><th className="px-5 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {models.data.map(m => (
                  <tr key={m.name}>
                    <td className="px-5 py-2.5 font-medium">{m.name}<span className="block text-xs font-normal text-slate-500">{formatDate(m.modifiedAt)}</span></td>
                    <td className="px-3 py-2.5"><div className="flex flex-wrap gap-1">{m.roles.map(r => <Badge key={r} tone={ROLE[r][1]}>{ROLE[r][0]}</Badge>)}</div></td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{[m.family, m.parameterSize, m.quantization].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatBytes(m.size)}</td>
                    <td className="px-3 py-2.5">{m.loaded ? <Badge tone="green">{formatBytes(m.vram)}</Badge> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="px-5 py-2.5 text-right">
                      {!m.roles.includes('embedding') && !/embed/i.test(m.name) && (
                        <button className="btn-ghost text-xs" onClick={() => navigate('/preview', {model: m.name})}><MessageSquareText className="h-3.5 w-3.5" />Probar</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
