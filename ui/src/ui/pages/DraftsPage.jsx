import {useState} from 'react';
import {Inbox, RefreshCw, Send} from 'lucide-react';
import {useApi, useMutation, useQuery} from '../../application/services.jsx';
import {formatDate} from '../../domain/format.js';
import {Card, EmptyState, ErrorNotice, Loading, Modal, Notice, PageHeader, Spinner} from '../components/primitives.jsx';

export function DraftsPage() {
  const api = useApi();
  const drafts = useQuery(() => api.drafts(), [], {intervalMs: 15000});
  const [target, setTarget] = useState(null);
  const [sent, setSent] = useState(null);
  const send = useMutation(id => api.sendDraft(id));
  return (
    <>
      <PageHeader title="Borradores de WhatsApp" description="Respuestas generadas para mensajes reales con AUTO_SEND=false. Revisa cada una antes de enviarla."
        actions={<button className="btn-secondary" onClick={() => drafts.reload()}><RefreshCw className="h-4 w-4" />Actualizar</button>} />
      {sent && <Notice kind="success" className="mb-4">Mensaje enviado a +{sent}.</Notice>}
      <ErrorNotice error={drafts.error} className="mb-4" />
      <Card bodyClassName="">
        {drafts.loading && !drafts.data ? <div className="px-5"><Loading /></div> : !drafts.data?.length ? (
          <EmptyState icon={Inbox} title="No hay borradores pendientes">Aparecen cuando llega un WhatsApp de un contacto autorizado con consentimiento.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {drafts.data.map(d => (
              <li key={d.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_1fr_auto] md:items-start">
                <div><p className="label">+{d.contact} · {formatDate(d.created_at)}</p><p className="whitespace-pre-wrap rounded-xl bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800">{d.incoming_text}</p></div>
                <div><p className="label">Borrador</p><p className="whitespace-pre-wrap rounded-xl bg-brand-600 px-3 py-2 text-sm text-white">{d.output}</p></div>
                <button className="btn-primary md:mt-5" onClick={() => {send.reset(); setTarget(d);}}><Send className="h-4 w-4" />Enviar</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal open={!!target} title="Enviar por WhatsApp" onClose={() => setTarget(null)}
        footer={<><button className="btn-secondary" onClick={() => setTarget(null)}>Cancelar</button>
          <button className="btn-danger" disabled={send.pending} onClick={async () => {
            const ok = await send.run(target.id).then(() => true).catch(() => false);
            if (ok) {setSent(target.contact); setTarget(null); drafts.reload({silent: true});}
          }}>{send.pending ? <Spinner /> : <Send className="h-4 w-4" />}Enviar ahora</button></>}>
        <p>Se enviará un mensaje <b>real</b> a +{target?.contact} desde tu WhatsApp:</p>
        <p className="mt-3 whitespace-pre-wrap rounded-xl bg-brand-600 px-3 py-2 text-white">{target?.output}</p>
        <ErrorNotice error={send.error} className="mt-3" />
      </Modal>
    </>
  );
}
