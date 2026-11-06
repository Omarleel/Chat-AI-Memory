import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const provided = header.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}
export function inboundTextEvents(payload) {
  const events = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        if (m?.type !== 'text' || !m.text?.body || !m.id || !m.from) continue;
        events.push({id: String(m.id), contact: String(m.from), text: m.text.body.slice(0, 4000)});
      }
    }
  }
  return events;
}
export class WhatsAppCloudGateway {
  constructor(config) { this.config = config; }
  getStatus() { return {provider: 'cloud', state: this.config.phoneId && this.config.accessToken ? 'configured' : 'unconfigured', hasQr: false}; }
  async sendText(phone, text) {
    const {version, phoneId, accessToken} = this.config;
    if (!phoneId || !accessToken) throw new Error('Faltan WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}/messages`;
    const response = await fetch(url, {method: 'POST',
      headers: {'authorization': `Bearer ${accessToken}`, 'content-type': 'application/json'},
      body: JSON.stringify({messaging_product: 'whatsapp', recipient_type: 'individual', to: phone,
        type: 'text', text: {preview_url: false, body: text.slice(0, 3900)}}),
      signal: AbortSignal.timeout(20000)});
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Meta API ${response.status}: ${JSON.stringify(json.error ?? {}).slice(0, 300)}`);
    if (!json.messages?.[0]?.id) throw new Error('Meta no devolvió el ID del mensaje enviado');
    return json.messages[0].id;
  }
}
