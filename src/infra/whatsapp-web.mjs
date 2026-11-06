import { normalizePhone } from '../config.mjs';

// Solo se procesan chats directos y texto nuevo, nunca grupos, estados o mensajes propios.
const PN_JID = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/;
const LID_JID = /^\d+(?::\d+)?@lid$/;
export function phoneFromPnJid(jid) {
  const match = typeof jid === 'string' && jid.match(PN_JID);
  return match ? match[1] : null;
}
export function extractWebMessage(message) {
  const key = message?.key;
  if (!key?.id || key.fromMe || typeof key.remoteJid !== 'string') return null;
  // Rechazar categorías ajenas incluso si tienen remoteJidAlt aparentemente válido.
  if (!PN_JID.test(key.remoteJid) && !LID_JID.test(key.remoteJid)) return null;
  let content = message.message;
  for (let i = 0; i < 5 && content; i++) {
    const next = content.ephemeralMessage?.message || content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message;
    if (!next) break;
    content = next;
  }
  const body = content?.conversation ?? content?.extendedTextMessage?.text;
  if (typeof body !== 'string' || !body.trim()) return null;
  return {id: String(key.id), jid: key.remoteJid, altJid: key.remoteJidAlt,
    text: body.slice(0, 4000)};
}

// Adaptador de WhatsApp Web (no oficial). El único contrato usado por QueueWorker
// es sendText(phone, text): conmutar a Cloud no toca RAG, memoria ni la cola.
export class WhatsAppWebGateway {
  constructor({authDir, printQr = true}, {onMessage, log = console, dependencies} = {}) {
    Object.assign(this, {authDir, printQr, onMessage, log, dependencies});
    this.state = 'starting';
    this.qr = null;
    this.socket = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.generation = 0;
  }
  getStatus() { return {provider: 'web', state: this.state, hasQr: Boolean(this.qr)}; }
  async getQrSvg() {
    if (!this.qr) return null;
    const {default: qrcode} = await import('qrcode');
    return qrcode.toString(this.qr, {type: 'svg', margin: 3, errorCorrectionLevel: 'M'});
  }
  async start() {
    this.stopped = false;
    await this.connect();
  }
  async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.state = 'connecting';
    this.qr = null;
    try {
      const {default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers} =
        this.dependencies?.baileys ?? await import('@whiskeysockets/baileys');
      const {state: auth, saveCreds} = await (this.dependencies?.loadAuthState ?? useMultiFileAuthState)(this.authDir);
      if (this.stopped || generation !== this.generation) return;
      const sock = makeWASocket({auth, browser: Browsers.ubuntu('Chat AI Memory'),
        markOnlineOnConnect: false, syncFullHistory: false,
      });
      this.socket = sock;
      sock.ev.on('creds.update', () => {
        Promise.resolve(saveCreds()).catch(err => this.log.error('Error al guardar sesión:', err.message));
      });
      sock.ev.on('messages.upsert', ({type, messages}) => {
        if (type !== 'notify' || this.stopped || generation !== this.generation) return;
        this.handleMessages(messages ?? [], sock).catch(err => this.log.error('Recepción WhatsApp:', err.message));
      });
      sock.ev.on('connection.update', ({connection, qr, lastDisconnect}) => {
        if (this.stopped || generation !== this.generation) return;
        if (qr) {
          this.state = 'qr'; this.qr = qr;
          this.log.info('WhatsApp Web: escanea el QR desde Dispositivos vinculados.');
          if (this.printQr) {
            const render = this.dependencies?.renderTerminalQr ?? (async code => {
              const {default: terminal} = await import('qrcode-terminal');
              terminal.generate(code, {small: true});
            });
            Promise.resolve(render(qr)).catch(err => this.log.error('Error mostrando QR:', err.message));
          }
        }
        if (connection === 'open') {
          this.state = 'connected'; this.qr = null;
          this.log.info('WhatsApp Web vinculado y conectado.');
        }
        if (connection === 'close') {
          this.socket = null; this.qr = null;
          const reason = lastDisconnect?.error?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            this.state = 'logged_out';
            this.log.error('Sesión de WhatsApp revocada. Desvincula/elimina la sesión y vuelve a escanear el QR.');
          } else {
            this.state = 'disconnected';
            this.scheduleReconnect();
          }
        }
      });
    } catch (err) {
      this.state = 'disconnected';
      this.log.error('Error conectando WhatsApp Web:', err.message);
      this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => this.log.error('Reconexión WhatsApp:', err.message));
    }, 5000);
    this.reconnectTimer.unref?.();
  }
  async resolveContact(key, sock) {
    const fromPN = phoneFromPnJid(key.jid) ?? phoneFromPnJid(key.altJid);
    if (fromPN) return fromPN;
    if (!LID_JID.test(key.jid)) return null;
    // LID no es número de teléfono. No se elude la allowlist con el LID.
    const mapped = await sock.signalRepository?.lidMapping?.getPNForLID?.(key.jid);
    return phoneFromPnJid(mapped);
  }
  async handleMessages(messages, sock) {
    for (const message of messages) {
      const event = extractWebMessage(message);
      if (!event) continue;
      try {
        const contact = await this.resolveContact(event, sock);
        if (contact) await this.onMessage?.({id: `web:${contact}:${event.id}`, contact, text: event.text});
      } catch (err) {
        this.log.error('No se pudo procesar un mensaje entrante:', err.message);
      }
    }
  }
  async sendText(phone, text) {
    if (this.state !== 'connected' || !this.socket) throw new Error('WhatsApp Web no está conectado');
    const result = await this.socket.sendMessage(`${normalizePhone(phone)}@s.whatsapp.net`, {text: text.slice(0, 3900)});
    if (!result?.key?.id) throw new Error('WhatsApp Web no devolvió el ID del mensaje enviado');
    return `web:${result.key.id}`;
  }
  stop() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.state = 'stopped';
    this.qr = null;
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      try { sock.end(new Error('Apagando el servidor')); }
      catch (err) { this.log.error('Cierre de WhatsApp:', err.message); }
    }
  }
}
