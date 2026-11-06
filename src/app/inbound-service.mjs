import { normalizePhone } from '../config.mjs';

// Entrada común a ambos proveedores: seguridad y deduplicación idénticas.
export function enqueueIncoming({repository, config}, item) {
  try {
    const contact = normalizePhone(item.contact);
    if (!config.allowedContacts.has(contact)) return false;
    if (typeof item.id !== 'string' || !item.id || typeof item.text !== 'string' || !item.text.trim()) return false;
    return repository.queueEvent({id: item.id, contact, text: item.text.slice(0, 4000)});
  } catch {
    return false;
  }
}
