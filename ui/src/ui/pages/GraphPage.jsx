import {useState} from 'react';
import {Network, Pause, Play, RefreshCw, Search, ShieldCheck, Sparkles} from 'lucide-react';
import {useApi, useMutation, useQuery} from '../../application/services.jsx';
import {useContacts} from '../../application/use-contacts.js';
import {EXTRACTION_STATES, radialLayout, relationLabel, remainingMs} from '../../domain/graph.js';
import {formatDate, formatDuration, formatNumber} from '../../domain/format.js';
import {ContactPicker} from '../components/ContactPicker.jsx';
import {Badge, Card, EmptyState, ErrorNotice, Loading, Notice, PageHeader, ProgressBar, Spinner, Stat} from '../components/primitives.jsx';

const PILOT = 2000;

export function GraphPage() {
  const api = useApi();
  const contacts = useContacts();
  const contact = contacts.contact;
  const status = useQuery(() => contact ? api.graphStatus(contact) : Promise.resolve(null), [contact], {intervalMs: 4000});
  const [selected, setSelected] = useState(null);
  return (
    <>
      <PageHeader title="Grafo de conocimiento" actions={<ContactPicker contacts={contacts} />}
        description="Hechos extraídos de los chats con su cita literal, autor y fecha. SQLite los guarda; Neo4j los conecta por entidad para que el bot encuentre lo relacionado con lo que se habla." />
      <ErrorNotice error={status.error} className="mb-4" />
      {status.data && !status.data.enabled && (
        <Notice kind="warning" className="mb-4">Neo4j está desactivado (NEO4J_ENABLED=false): los hechos se guardan en SQLite y el bot los busca por texto, sin relaciones.</Notice>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-4">
          <ExtractionCard contact={contact} status={status} />
          <StatsCard contact={contact} status={status} />
        </div>
        <div className="min-w-0 space-y-4">
          <Explorer contact={contact} selected={selected} onSelect={setSelected} />
        </div>
      </div>
    </>
  );
}

function ExtractionCard({contact, status}) {
  const api = useApi();
  const start = useMutation(input => api.startGraphExtraction(input));
  const pause = useMutation(() => api.pauseGraphExtraction(contact));
  const extraction = status.data?.extraction;
  const busy = !!extraction?.active;
  const run = async (importHash, maxMessages) => {await start.run({contact, importHash, ...(maxMessages ? {maxMessages} : {})}).catch(() => {}); status.reload({silent: true});};
  return (
    <Card title="Extracción de hechos" description={extraction ? `Modelo: ${extraction.model} · cada hecho se verifica contra su cita` : undefined}>
      {!extraction ? <Loading /> : !extraction.imports.length ? <EmptyState icon={Network} title="No hay chats importados para este contacto" /> : (
        <div className="space-y-5">
          {extraction.imports.map(imp => {
            const [label, tone] = EXTRACTION_STATES[imp.state] ?? [imp.state, 'slate'];
            const left = remainingMs(imp);
            const running = imp.state === 'running';
            return (
              <div key={imp.importHash} className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium" title={imp.fileName}>{imp.self} ↔ {imp.peer}</span>
                  <Badge tone={tone}>{running && <Spinner className="h-3 w-3" />}{label}</Badge>
                </div>
                <ProgressBar value={imp.totalMessages ? imp.processedMessages / imp.totalMessages : 0} />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Mensajes" value={`${formatNumber(imp.processedMessages)} / ${formatNumber(imp.totalMessages)}`} />
                  <Stat label="Hechos verificados" value={formatNumber(imp.inserted)} />
                  <Stat label="Tiempo" value={formatDuration(imp.elapsedMs)} />
                  <Stat label="Restante (aprox.)" value={left ? formatDuration(left) : '—'} />
                </div>
                {imp.message && <p className="text-xs text-slate-500">{imp.message}{imp.failures ? ` · ${imp.failures} lotes con error` : ''}</p>}
                <div className="flex flex-wrap gap-2">
                  {running ? (
                    <button className="btn-secondary" disabled={pause.pending} onClick={() => pause.run().then(() => status.reload({silent: true})).catch(() => {})}>
                      <Pause className="h-4 w-4" />Pausar</button>
                  ) : imp.state !== 'done' && <>
                    <button className="btn-secondary" disabled={busy || start.pending} onClick={() => run(imp.importHash, PILOT)}>
                      <Sparkles className="h-4 w-4" />Tanda de {formatNumber(PILOT)}</button>
                    <button className="btn-primary" disabled={busy || start.pending} onClick={() => run(imp.importHash)}>
                      <Play className="h-4 w-4" />{imp.processedMessages ? 'Continuar hasta el final' : 'Procesar todo'}</button>
                  </>}
                </div>
              </div>
            );
          })}
          <ErrorNotice error={start.error ?? pause.error} />
          <Notice kind="info">Mientras extrae, el revisor comparte el modelo con el preview y WhatsApp: las respuestas tardan más. Puedes pausar y continuar cuando quieras.</Notice>
        </div>
      )}
    </Card>
  );
}

function StatsCard({contact, status}) {
  const api = useApi();
  const rebuild = useMutation(() => api.rebuildGraph(contact));
  const [done, setDone] = useState(null);
  const stats = status.data?.stats;
  const facts = status.data?.extraction?.facts ?? [];
  return (
    <Card title="Contenido" actions={
      <button className="btn-ghost text-xs" disabled={rebuild.pending || !status.data?.enabled} title="Regenera Neo4j desde SQLite"
        onClick={async () => {setDone(await rebuild.run().catch(() => null)); status.reload({silent: true});}}>
        {rebuild.pending ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}Reconstruir</button>}>
      <ErrorNotice error={rebuild.error} className="mb-3" />
      {done && <Notice kind="success" className="mb-3">Proyección regenerada: {formatNumber(done.facts)} hechos verificados.</Notice>}
      {!stats ? <Loading /> : (
        <div className="space-y-4">
          <div>
            <p className="label">Hechos verificados por relación</p>
            {!facts.length ? <p className="text-sm text-slate-500">Todavía no hay hechos extraídos.</p> : (
              <div className="flex flex-wrap gap-1.5">{facts.map(f => <Badge key={f.relation} tone="green">{relationLabel(f.relation)} · {formatNumber(f.n)}</Badge>)}</div>
            )}
          </div>
          {stats.neo4j && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="label">Entidades en Neo4j</p>
                <ul className="space-y-0.5 text-sm">{stats.neo4j.entities.map(e => <li key={e.type} className="flex justify-between"><span>{e.type}</span><span className="tabular-nums">{formatNumber(e.n)}</span></li>)}</ul>
              </div>
              <div>
                <p className="label">Origen de las relaciones</p>
                <ul className="space-y-0.5 text-sm">
                  <li className="flex justify-between"><span>Verificadas (LLM)</span><span className="tabular-nums">{formatNumber(stats.neo4j.origins.llm ?? 0)}</span></li>
                  <li className="flex justify-between"><span>Reglas</span><span className="tabular-nums">{formatNumber(stats.neo4j.origins.regex ?? 0)}</span></li>
                </ul>
                <p className="mt-1 text-xs text-slate-500">El bot solo usa las verificadas.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Explorer({contact, selected, onSelect}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const entities = useQuery(() => contact ? api.graphEntities(contact, query) : Promise.resolve([]), [contact, query]);
  const detail = useQuery(() => contact && selected ? api.graphEntity(contact, selected) : Promise.resolve(null), [contact, selected]);
  return (
    <>
      <Card title="Explorar entidades">
        <form className="mb-3 flex gap-2" onSubmit={e => {e.preventDefault(); setQuery(q.trim());}}>
          <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Chato, BCP, moto…" maxLength={80} />
          <button className="btn-secondary"><Search className="h-4 w-4" />Buscar</button>
        </form>
        <ErrorNotice error={entities.error} />
        {entities.loading && !entities.data ? <Loading /> : !entities.data?.length ? <p className="text-sm text-slate-500">Sin entidades{query ? ` para «${query}»` : ''}.</p> : (
          <div className="flex flex-wrap gap-1.5">
            {entities.data.map(e => (
              <button key={e.key} onClick={() => onSelect(e.key)}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${selected === e.key ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-100' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}>
                {e.name} <span className="text-slate-400">· {e.type} · {e.degree}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
      {selected && <EntityDetail detail={detail} onSelect={onSelect} />}
    </>
  );
}

function EntityDetail({detail, onSelect}) {
  if (detail.loading && !detail.data) return <Card><Loading /></Card>;
  if (detail.error) return <Card><ErrorNotice error={detail.error} /></Card>;
  if (!detail.data) return null;
  const {entity, relations} = detail.data;
  const neighbors = [...new Map(relations.map(r => [r.other.key, r.other])).values()].slice(0, 14);
  const positions = radialLayout(neighbors.length);
  return (
    <Card title={entity.name} description={`${entity.type} · ${entity.degree} relaciones`}>
      {neighbors.length > 0 && (
        <svg viewBox="0 0 400 320" className="mb-4 w-full max-w-lg" role="img" aria-label={`Vecinos de ${entity.name}`}>
          {neighbors.map((n, i) => <line key={`l${n.key}`} x1="200" y1="160" x2={positions[i].x} y2={positions[i].y} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1.5" />)}
          {neighbors.map((n, i) => (
            <g key={n.key} className="cursor-pointer" onClick={() => onSelect(n.key)}>
              <circle cx={positions[i].x} cy={positions[i].y} r="6" className={n.type === 'persona' ? 'fill-sky-500' : 'fill-slate-400'} />
              <text x={positions[i].x} y={positions[i].y - 10} textAnchor="middle" className="fill-slate-600 text-[10px] dark:fill-slate-300">{n.name.slice(0, 18)}</text>
            </g>
          ))}
          <circle cx="200" cy="160" r="10" className="fill-emerald-500" />
          <text x="200" y="185" textAnchor="middle" className="fill-slate-900 text-[12px] font-semibold dark:fill-white">{entity.name.slice(0, 22)}</text>
        </svg>
      )}
      {!relations.length ? <p className="text-sm text-slate-500">Sin relaciones.</p> : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {relations.map(r => (
            <li key={r.uid} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                {r.origin === 'llm' ? <Badge tone="green"><ShieldCheck className="h-3 w-3" />verificado</Badge> : <Badge tone="slate">reglas</Badge>}
                <span>{r.outgoing ? entity.name : <button className="font-medium hover:underline" onClick={() => onSelect(r.other.key)}>{r.other.name}</button>}</span>
                <span className="text-slate-500">{relationLabel(r.relation)}</span>
                <span>{r.outgoing ? <button className="font-medium hover:underline" onClick={() => onSelect(r.other.key)}>{r.other.name}</button> : entity.name}</span>
                <span className="ml-auto text-xs text-slate-500">{formatDate(r.occurred_at)}</span>
              </div>
              {r.fact && <p className="mt-1 text-slate-700 dark:text-slate-300">{r.fact}</p>}
              {r.quote && <p className="mt-0.5 text-xs italic text-slate-500">«{r.quote}»{r.speaker ? ` — ${r.speaker === 'self' ? 'titular' : 'interlocutor'}` : ''}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
