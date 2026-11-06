import {useState} from 'react';
import {Brain, Plus, Trash2} from 'lucide-react';
import {useApi, useMutation, useQuery} from '../../application/services.jsx';
import {useContacts} from '../../application/use-contacts.js';
import {formatDate} from '../../domain/format.js';
import {ContactPicker} from '../components/ContactPicker.jsx';
import {Card, EmptyState, ErrorNotice, Loading, PageHeader, Spinner} from '../components/primitives.jsx';

export function MemoriesPage() {
  const api = useApi();
  const contacts = useContacts();
  const memories = useQuery(() => contacts.contact ? api.memories(contacts.contact) : Promise.resolve([]), [contacts.contact]);
  const [fact, setFact] = useState('');
  const add = useMutation(() => api.addMemory(contacts.contact, fact.trim()));
  const remove = useMutation(id => api.deleteMemory(contacts.contact, id));
  return (
    <>
      <PageHeader title="Memorias" actions={<ContactPicker contacts={contacts} />}
        description="Hechos explícitos sobre el contacto, separados del historial importado. El bot puede citarlos como [M1], [M2]…" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Añadir recuerdo">
          <form className="space-y-3" onSubmit={async e => {e.preventDefault(); if (await add.run().catch(() => null)) {setFact(''); memories.reload();}}}>
            <textarea className="input min-h-[6rem]" value={fact} onChange={e => setFact(e.target.value)} maxLength={1000}
              placeholder="Le gusta el fútbol los sábados" required />
            <ErrorNotice error={add.error} />
            <button className="btn-primary w-full" disabled={!fact.trim() || add.pending || !contacts.contact}>
              {add.pending ? <Spinner /> : <Plus className="h-4 w-4" />}Guardar
            </button>
          </form>
        </Card>
        <Card title="Recuerdos guardados" className="lg:col-span-2" bodyClassName="">
          <ErrorNotice error={memories.error ?? remove.error} className="m-4" />
          {memories.loading ? <div className="px-5"><Loading /></div> : !memories.data?.length ? (
            <EmptyState icon={Brain} title="Sin recuerdos para este contacto" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {memories.data.map(m => (
                <li key={m.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                  <span className="mt-0.5 font-mono text-xs text-slate-400">#{m.id}</span>
                  <span className="flex-1 whitespace-pre-wrap">{m.fact}<span className="block text-xs text-slate-500">{formatDate(m.created_at)}</span></span>
                  <button className="btn-ghost p-1.5 text-rose-600" aria-label="Borrar" disabled={remove.pending}
                    onClick={async () => {await remove.run(m.id).catch(() => {}); memories.reload({silent: true});}}><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
