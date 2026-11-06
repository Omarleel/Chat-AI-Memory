import {Phone} from 'lucide-react';

export function ContactPicker({contacts, className = ''}) {
  const {allowlist, contact, setContact, loading} = contacts;
  if (!loading && !allowlist.length)
    return <span className="text-sm text-amber-600">Sin contactos: añade números a ALLOWED_CONTACTS en .env</span>;
  return (
    <label className={`flex items-center gap-2 ${className}`}>
      <Phone className="h-4 w-4 text-slate-400" aria-hidden="true" />
      <span className="sr-only">Contacto</span>
      <select className="input w-auto min-w-[11rem]" value={contact} onChange={e => setContact(e.target.value)} disabled={loading}>
        {allowlist.map(c => <option key={c} value={c}>+{c}</option>)}
      </select>
    </label>
  );
}
