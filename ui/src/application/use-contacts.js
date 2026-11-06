import {useEffect, useState} from 'react';
import {useApi, usePrefs, useQuery} from './services.jsx';

// Contactos autorizados (ALLOWED_CONTACTS) y el contacto elegido, recordado entre vistas.
export function useContacts() {
  const api = useApi();
  const prefs = usePrefs();
  const query = useQuery(() => api.contacts());
  const allowlist = query.data?.allowlist ?? [];
  const [contact, setContact] = useState(() => prefs.get('contact', ''));
  useEffect(() => {
    if (allowlist.length && !allowlist.includes(contact)) setContact(allowlist[0]);
  }, [allowlist.join(','), contact]);
  const choose = value => {setContact(value); prefs.set('contact', value);};
  const consented = new Set((query.data?.contacts ?? []).filter(c => c.opted_in === 1).map(c => c.contact));
  return {allowlist, contact, setContact: choose, consented, loading: query.loading, error: query.error};
}
