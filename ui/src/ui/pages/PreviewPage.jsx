import {useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, Bug, MessageSquareText, SendHorizontal, Trash2} from 'lucide-react';
import {useApi, useMutation, usePrefs, useQuery} from '../../application/services.jsx';
import {useContacts} from '../../application/use-contacts.js';
import {formatDuration} from '../../domain/format.js';
import {ContactPicker} from '../components/ContactPicker.jsx';
import {Badge, Card, EmptyState, ErrorNotice, Field, Modal, PageHeader, Spinner, Toggle} from '../components/primitives.jsx';

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function PreviewPage({params}) {
  const api = useApi();
  const prefs = usePrefs();
  const contacts = useContacts();
  const system = useQuery(() => api.system());
  const models = useQuery(() => api.models());
  const [sessionId, setSessionId] = useState(() => prefs.get('previewSession', 'default'));
  const [mode, setMode] = useState('reply');
  const [writer, setWriter] = useState(params.model ?? '');
  const [ragPolicy, setRagPolicy] = useState('auto');
  const [save, setSave] = useState(true);
  const [debug, setDebug] = useState(true);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const validSession = SESSION.test(sessionId);
  const history = useQuery(() => contacts.contact && validSession ? api.previewHistory(contacts.contact, sessionId) : Promise.resolve([]),
    [contacts.contact, sessionId, validSession]);
  useEffect(() => {if (history.data) setItems(history.data.map(m => ({...m, key: `h${m.id}`})));}, [history.data]);
  useEffect(() => {if (params.model) setWriter(params.model);}, [params.model]);

  const writerOptions = useMemo(() => (models.data ?? []).filter(m => !m.roles.includes('embedding') && !/embed/i.test(m.name)), [models.data]);
  const activeWriter = system.data?.chatModel ?? '';
  const send = useMutation(async text => {
    const body = {contact: contacts.contact, text, session_id: sessionId, mode, debug_rag: debug,
      ...(mode === 'reply' ? {save, rag_policy: ragPolicy, ...(writer && writer !== activeWriter ? {writer_model: writer} : {})} : {})};
    return api.preview(body);
  });
  const clear = useMutation(() => api.clearPreview(contacts.contact, sessionId));

  async function submit(text) {
    const key = `l${Date.now()}`;
    setItems(list => [...list, {key: `${key}p`, side: 'peer', text, mode}]);
    try {
      const r = await send.run(text);
      const item = {key: `${key}s`, side: 'self', text: r.answer, mode, approved: r.approved !== false, reason: r.review_reason,
        saved: r.saved, rag: r.rag, evidence: r.evidence, writer: r.mode === 'reply' ? (writer || activeWriter) : null};
      setItems(list => [...list, item]);
      setSelected(item);
    } catch {
      setItems(list => list.map(i => i.key === `${key}p` ? {...i, failed: true} : i));
    }
  }

  return (
    <>
      <PageHeader title="Preview" actions={<ContactPicker contacts={contacts} />}
        description="Escribe como el interlocutor y mira qué borrador redactaría el bot como titular. Nada se envía por WhatsApp." />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card bodyClassName="flex h-[calc(100vh-14rem)] min-h-[28rem] flex-col"
          title={mode === 'reply' ? `Sesión «${sessionId}»` : 'Consulta privada de memoria'}
          description={mode === 'reply' ? 'Mensajes del interlocutor a la izquierda; borradores del titular a la derecha.' : 'Preguntas tú; responde con citas del historial, sin imitar a nadie.'}
          actions={mode === 'reply' && <button className="btn-ghost text-rose-600" onClick={() => setConfirmClear(true)} disabled={!items.length}><Trash2 className="h-4 w-4" />Vaciar</button>}>
          <Conversation items={items} pending={send.pending} loading={history.loading} onSelect={setSelected} selected={selected} selfName={system.data?.selfName} />
          <ErrorNotice error={send.error} className="mx-4 mb-2" />
          <Composer onSubmit={submit} disabled={send.pending || !contacts.contact || !validSession}
            placeholder={mode === 'reply' ? 'Mensaje del interlocutor…' : '¿Qué quieres saber del historial?'} />
        </Card>
        <div className="min-w-0 space-y-4">
          <Card title="Ajustes">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                {[['reply', 'Responder'], ['memory_query', 'Consultar']].map(([value, label]) => (
                  <button key={value} className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === value ? 'bg-white shadow-sm dark:bg-slate-950' : 'text-slate-500'}`}
                    onClick={() => setMode(value)}>{label}</button>
                ))}
              </div>
              <Field label="Sesión de simulación" error={validSession ? null : 'Letras, números, _ y -'}>
                <input className="input" value={sessionId} maxLength={64}
                  onChange={e => {setSessionId(e.target.value); if (SESSION.test(e.target.value)) prefs.set('previewSession', e.target.value);}} />
              </Field>
              {mode === 'reply' && <>
                <Field label="Redactor" hint="Prueba una identidad entrenada sin reiniciar; el revisor no cambia.">
                  <select className="input" value={writer || activeWriter} onChange={e => setWriter(e.target.value)}>
                    {writerOptions.map(m => <option key={m.name} value={m.name}>{m.name}{m.name === activeWriter ? ' (activo)' : ''}</option>)}
                  </select>
                </Field>
                <Field label="Memoria (RAG)">
                  <select className="input" value={ragPolicy} onChange={e => setRagPolicy(e.target.value)}>
                    <option value="auto">Automática (el router decide)</option>
                    <option value="force">Forzar búsqueda</option>
                    <option value="off">Sin memoria</option>
                  </select>
                </Field>
                <Toggle checked={save} onChange={setSave} label="Guardar en la sesión" hint="Los borradores no aprobados nunca se guardan." />
              </>}
              <Toggle checked={debug} onChange={setDebug} label="Diagnóstico" hint="Tiempos, revisión y fragmentos recuperados (contenido privado)." />
            </div>
          </Card>
          <Diagnostics item={selected} />
        </div>
      </div>
      <Modal open={confirmClear} title="Vaciar la sesión" onClose={() => setConfirmClear(false)}
        footer={<><button className="btn-secondary" onClick={() => setConfirmClear(false)}>Cancelar</button>
          <button className="btn-danger" disabled={clear.pending} onClick={async () => {await clear.run().catch(() => {}); setConfirmClear(false); setSelected(null); history.reload();}}>
            {clear.pending && <Spinner />}Vaciar</button></>}>
        Borra solo los turnos simulados de «{sessionId}» para +{contacts.contact}. No toca el chat importado, Qdrant ni WhatsApp.
      </Modal>
    </>
  );
}

function Conversation({items, pending, loading, onSelect, selected, selfName}) {
  const end = useRef(null);
  useEffect(() => {end.current?.scrollIntoView({behavior: 'smooth', block: 'end'});}, [items.length, pending]);
  if (loading && !items.length) return <div className="flex flex-1 items-center justify-center"><Spinner className="h-5 w-5 text-slate-400" /></div>;
  return (
    <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50/60 px-4 py-4 dark:bg-slate-950/40">
      {!items.length && <EmptyState icon={MessageSquareText} title="Conversación vacía">Escribe un mensaje para empezar.</EmptyState>}
      {items.map(item => {
        const mine = item.side === 'self';
        const unapproved = mine && item.approved === false;
        const isSelected = selected?.key === item.key;
        return (
          <div key={item.key} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
            <button type="button" disabled={!item.rag && !item.reason && !item.evidence} onClick={() => onSelect(item)}
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-left text-sm shadow-sm transition
                ${mine ? (unapproved ? 'border border-dashed border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100' : 'bg-brand-600 text-white') : 'bg-white dark:bg-slate-800'}
                ${isSelected ? 'ring-2 ring-sky-400' : ''} ${item.failed ? 'opacity-50' : ''}`}>
              {mine && <span className={`mb-0.5 block text-[11px] font-medium ${unapproved ? 'text-amber-700 dark:text-amber-300' : 'text-white/75'}`}>
                {selfName ?? 'Titular'}{item.writer ? ` · ${item.writer}` : ''}{unapproved ? ' · no aprobado' : ''}{item.saved === false && !unapproved && item.mode === 'reply' ? ' · no guardado' : ''}</span>}
              {item.text}
              {item.failed && <span className="mt-1 block text-[11px] text-rose-500">Sin respuesta</span>}
            </button>
          </div>
        );
      })}
      {pending && <div className="flex justify-end"><span className="flex items-center gap-2 rounded-2xl bg-brand-600/10 px-3.5 py-2 text-sm text-brand-700 dark:text-brand-100"><Spinner />Redactando…</span></div>}
      <div ref={end} />
    </div>
  );
}

function Composer({onSubmit, disabled, placeholder}) {
  const [text, setText] = useState('');
  const submit = () => {const value = text.trim(); if (!value || disabled) return; onSubmit(value); setText('');};
  return (
    <form className="flex items-end gap-2 border-t border-slate-100 p-3 dark:border-slate-800" onSubmit={e => {e.preventDefault(); submit();}}>
      <textarea className="input max-h-40 min-h-[2.5rem] resize-y" rows={1} value={text} placeholder={placeholder} maxLength={4000}
        onChange={e => setText(e.target.value)} onKeyDown={e => {if (e.key === 'Enter' && !e.shiftKey) {e.preventDefault(); submit();}}} />
      <button className="btn-primary h-10" type="submit" disabled={disabled || !text.trim()} aria-label="Enviar"><SendHorizontal className="h-4 w-4" /></button>
    </form>
  );
}

function Diagnostics({item}) {
  if (!item) return <Card title="Diagnóstico"><p className="text-sm text-slate-500">Selecciona un borrador para ver cómo se produjo.</p></Card>;
  const profile = item.rag?.profile;
  const decisions = profile?.decisions ?? {};
  const retrieval = item.rag?.retrieval;
  return (
    <Card title="Diagnóstico" actions={<Bug className="h-4 w-4 text-slate-400" aria-hidden="true" />}>
      <div className="space-y-4 text-sm">
        {item.approved === false && (
          <div className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" />El revisor no lo aprobó</p>
            <p className="text-xs">{item.reason || 'Sin motivo'}</p>
          </div>
        )}
        {profile && <div className="flex flex-wrap gap-2">
          <Badge tone="slate">Total {formatDuration(profile.totalMs)}</Badge>
          {decisions.route && <Badge tone="blue">Intención: {decisions.route.intent}</Badge>}
          {decisions.candidates && <Badge tone="violet">Borradores revisados {decisions.candidates.reviewed}/{decisions.candidates.total}</Badge>}
          {retrieval && <Badge tone="slate">RAG: {retrieval.strategy} · {retrieval.used ?? 0} fragmentos</Badge>}
        </div>}
        {profile?.stages?.length > 0 && (
          <div>
            <p className="label">Etapas</p>
            <ul className="space-y-1">
              {profile.stages.map((s, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 truncate text-slate-500">{s.stage}</span>
                  <span className="h-1.5 rounded bg-sky-400" style={{width: `${Math.max(2, (s.ms / profile.totalMs) * 100)}%`}} />
                  <span className="tabular-nums text-slate-500">{formatDuration(s.ms)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(item.rag?.selected?.length > 0 || item.evidence?.length > 0) && (
          <div>
            <p className="label">Evidencia</p>
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {(item.evidence ?? item.rag.selected).map(e => (
                <li key={e.id} className="rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-800/60">
                  <span className="font-semibold">{e.id}</span> <span className="whitespace-pre-wrap text-slate-600 dark:text-slate-300">{String(e.excerpt ?? e.fact ?? '').slice(0, 400)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!profile && item.approved !== false && <p className="text-xs text-slate-500">Activa «Diagnóstico» para ver tiempos y evidencia.</p>}
      </div>
    </Card>
  );
}
