import {useState} from 'react';
import {Search} from 'lucide-react';
import {useApi, useMutation, useQuery} from '../../application/services.jsx';
import {useContacts} from '../../application/use-contacts.js';
import {formatDate, formatNumber} from '../../domain/format.js';
import {ContactPicker} from '../components/ContactPicker.jsx';
import {Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner, Stat} from '../components/primitives.jsx';

export function RagPage() {
  const api = useApi();
  const contacts = useContacts();
  const metrics = useQuery(() => api.ragMetrics(), [], {intervalMs: 20000});
  const [question, setQuestion] = useState('');
  const search = useMutation(() => api.ragSearch(contacts.contact, question.trim()));
  const [result, setResult] = useState(null);
  return (
    <>
      <PageHeader title="Búsqueda en memoria" actions={<ContactPicker contacts={contacts} />}
        description="Comprueba qué fragmentos del historial recupera el sistema para una pregunta, sin generar respuesta ni guardar nada." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <form className="flex gap-2" onSubmit={async e => {e.preventDefault(); setResult(await search.run().catch(() => null));}}>
              <input className="input" value={question} onChange={e => setQuestion(e.target.value)} maxLength={2500} placeholder="¿De qué hablamos sobre el viaje?" />
              <button className="btn-primary" disabled={!question.trim() || search.pending || !contacts.contact}>{search.pending ? <Spinner /> : <Search className="h-4 w-4" />}Buscar</button>
            </form>
            <ErrorNotice error={search.error} className="mt-3" />
          </Card>
          {result && (
            <Card title={`${result.results.length} fragmento${result.results.length === 1 ? '' : 's'}`}
              description={`Intención: ${result.decision?.intent ?? '—'} · búsqueda: «${result.decision?.searchQuery ?? question}»`} bodyClassName="">
              {!result.results.length ? <EmptyState icon={Search} title="Sin fragmentos relevantes" /> : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {result.results.map(r => (
                    <li key={r.id} className="px-5 py-3 text-sm">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{r.id}</span>
                        {(r.methods ?? []).map(m => <Badge key={m} tone="slate">{m}</Badge>)}
                        {Number.isFinite(r.relevance) && <Badge tone="blue">relevancia {r.relevance.toFixed(2)}</Badge>}
                        <span className="text-xs text-slate-500">{formatDate(r.timestamp)}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-slate-700 dark:text-slate-300">{r.excerpt}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
        <Card title="Métricas del proceso" description="Contadores desde el último arranque de la app">
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(metrics.data ?? {}).map(([k, v]) => <Stat key={k} label={k} value={formatNumber(v)} />)}
          </div>
        </Card>
      </div>
    </>
  );
}
