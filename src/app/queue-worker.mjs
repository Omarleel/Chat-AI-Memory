import { normalizePhone } from '../config.mjs';

const OPT_IN = /^(acepto ia|activar ia)$/i;
const OPT_OUT = /^(parar ia|desactivar ia|stop ia)$/i;

export class QueueWorker {
  constructor({repository, replies, whatsapp, config}) {
    Object.assign(this, {repository, replies, whatsapp, config}); this.busy = false;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // No consumir reintentos mientras se espera el QR o una reconexión.
      if (this.config.autoSend && this.config.waProvider === 'web' &&
          this.whatsapp.getStatus?.().state !== 'connected') return;
      const event = this.repository.claimNext();
      if (event) await this.process(event);
    } finally { this.busy = false; }
  }
  async process(event) {
    try {
      const phone = normalizePhone(event.contact);
      if (!this.config.allowedContacts.has(phone)) { this.repository.markIgnored(event.id); return; }
      const trimmed = event.incoming_text.trim();
      if (OPT_OUT.test(trimmed)) { this.repository.setConsent(phone, false); this.repository.markIgnored(event.id); return; }
      const joining = OPT_IN.test(trimmed);
      if (joining) this.repository.setConsent(phone, true);
      if (!this.repository.isConsented(phone)) { this.repository.markIgnored(event.id); return; }
      this.repository.saveConversation(phone, 'incoming', event.incoming_text, event.id);
      let response = event.output;
      if (!response) {
        response = joining
          ? 'Listo, quedó activado. Si quieres desactivarlo, escribe PARAR IA.' 
          : await this.replies.generate(phone, event.incoming_text);
        this.repository.saveOutput(event.id, response, this.config.autoSend ? 'ready' : 'draft');
        if(!joining && this.config.autoMemoryLearn === true && this.replies.learnFromRealMessage) {
          try {await this.replies.learnFromRealMessage(phone,event.incoming_text,event.id);}
          catch(error) {console.warn('Consolidación de memoria omitida:',error.message);}
        }
      }
      if (!this.config.autoSend) return;
      const externalId = await this.whatsapp.sendText(phone, response);
      this.repository.markSent(event.id, externalId);
    } catch (err) {
      // Conserva el texto ya generado; jamás vuelve a generar para un mismo evento si falló Meta.
      this.repository.fail(event.id, err, event.tries);
      console.error('Evento fallido:', event.id, err.message);
    }
  }
  async sendDraft(id) {
    if (this.busy) throw new Error('Procesamiento activo, vuelve a intentar');
    this.busy = true;
    try {
      const event = this.repository.getDraft(id);
      if (!event) throw new Error('Borrador inexistente');
      const phone = normalizePhone(event.contact);
      if (!this.config.allowedContacts.has(phone) || !this.repository.isConsented(phone))
        throw new Error('Contacto no autorizado o sin consentimiento');
      const externalId = await this.whatsapp.sendText(phone, event.output);
      this.repository.markSent(id, externalId);
      return externalId;
    } finally { this.busy = false; }
  }
}
