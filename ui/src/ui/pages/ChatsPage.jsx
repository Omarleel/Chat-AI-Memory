import {useState} from 'react';
import {FileText, Upload} from 'lucide-react';
import {useApi, useMutation, useQuery} from '../../application/services.jsx';
import {useContacts} from '../../application/use-contacts.js';
import {detectAuthors} from '../../domain/chat-export.js';
import {formatDate, formatNumber} from '../../domain/format.js';
import {ContactPicker} from '../components/ContactPicker.jsx';
import {Card, EmptyState, ErrorNotice, Field, Loading, Notice, PageHeader, Spinner} from '../components/primitives.jsx';

const MAX_BYTES = 50 * 1024 * 1024;

export function ChatsPage() {
  const api = useApi();
  const contacts = useContacts();
  const imports = useQuery(() => contacts.contact ? api.chatImports(contacts.contact) : Promise.resolve([]), [contacts.contact]);
  return (
    <>
      <PageHeader title="Chats importados" actions={<ContactPicker contacts={contacts} />}
        description="Cada exportación TXT de WhatsApp se vincula a un contacto: alimenta la memoria (SQLite, Qdrant, Neo4j) y el dataset de entrenamiento." />
      <div className="grid gap-4 lg:grid-cols-5">
        <ImportForm contact={contacts.contact} onImported={() => imports.reload()} />
        <Card title="Historial vinculado" description={contacts.contact ? `Contacto +${contacts.contact}` : undefined} className="lg:col-span-3" bodyClassName="">
          <ErrorNotice error={imports.error} className="m-5" />
          {imports.loading ? <div className="px-5"><Loading /></div> : !imports.data?.length ? (
            <EmptyState icon={FileText} title="Sin chats para este contacto">Importa una exportación sin multimedia (.txt).</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr><th className="px-5 py-2 font-medium">Archivo</th><th className="px-3 py-2 font-medium">Titular → interlocutor</th>
                    <th className="px-3 py-2 text-right font-medium">Mensajes</th><th className="px-5 py-2 font-medium">Importado</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {imports.data.map(i => (
                    <tr key={i.importHash}>
                      <td className="max-w-[16rem] truncate px-5 py-2.5" title={i.fileName}>{i.fileName}</td>
                      <td className="px-3 py-2.5">{i.self} → {i.peer}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(i.messages)}</td>
                      <td className="px-5 py-2.5 text-slate-500">{formatDate(i.importedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function ImportForm({contact, onImported}) {
  const api = useApi();
  const [file, setFile] = useState(null);
  const [authors, setAuthors] = useState([]);
  const [self, setSelf] = useState('');
  const [peer, setPeer] = useState('');
  const [result, setResult] = useState(null);
  const upload = useMutation(input => api.importChat(input));

  async function choose(f) {
    setResult(null); upload.reset(); setFile(f); setAuthors([]);
    if (!f) return;
    // Lectura local solo para sugerir autores; el archivo se sube tal cual.
    const found = detectAuthors(await f.slice(0, 4 * 1024 * 1024).text());
    setAuthors(found);
    setSelf(found[0]?.name ?? ''); setPeer(found[1]?.name ?? '');
  }
  async function submit(e) {
    e.preventDefault();
    const r = await upload.run({file, contact, self: self.trim(), peer: peer.trim()}).catch(() => null);
    if (r) {setResult(r); onImported();}
  }
  const tooBig = file && file.size > MAX_BYTES;
  const invalid = !file || !contact || !self.trim() || !peer.trim() || self.trim().toLowerCase() === peer.trim().toLowerCase() || tooBig;
  return (
    <Card title="Importar TXT" description="WhatsApp → chat → Más → Exportar chat → Sin archivos." className="lg:col-span-2">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Archivo .txt" error={tooBig ? 'Máximo 50 MiB' : null}>
          <input type="file" accept=".txt,text/plain" className="input file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-sm dark:file:bg-slate-800"
            onChange={e => choose(e.target.files?.[0] ?? null)} disabled={upload.pending} />
        </Field>
        {file && !authors.length && <Notice kind="warning">No reconocí autores en el archivo. Escríbelos tal como aparecen en el TXT.</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <AuthorField label="Tú (titular)" value={self} onChange={setSelf} authors={authors} hint="Autor cuyas respuestas se imitan" disabled={upload.pending} />
          <AuthorField label="Interlocutor" value={peer} onChange={setPeer} authors={authors} hint={contact ? `Se vincula a +${contact}` : ''} disabled={upload.pending} />
        </div>
        <ErrorNotice error={upload.error} />
        {result && (
          <Notice kind="success" title={result.skipped ? 'Ya estaba importado' : 'Importación completada'}>
            {result.skipped ? 'El mismo TXT ya estaba vinculado a este contacto (mismo SHA-256).' : `${formatNumber(result.importedMessages ?? result.messages ?? 0)} mensajes vinculados a +${result.linkedTo}.`}
          </Notice>
        )}
        <button type="submit" className="btn-primary w-full" disabled={invalid || upload.pending}>
          {upload.pending ? <><Spinner />Importando… (puede tardar minutos por los embeddings)</> : <><Upload className="h-4 w-4" />Importar</>}
        </button>
      </form>
    </Card>
  );
}

function AuthorField({label, value, onChange, authors, hint, disabled}) {
  const listId = `authors-${label.replace(/\W/g, '')}`;
  return (
    <Field label={label} hint={hint}>
      <input className="input" list={listId} value={value} onChange={e => onChange(e.target.value)} maxLength={100} disabled={disabled} required />
      <datalist id={listId}>{authors.map(a => <option key={a.name} value={a.name}>{formatNumber(a.messages)} mensajes</option>)}</datalist>
    </Field>
  );
}
