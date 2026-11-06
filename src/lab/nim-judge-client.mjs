// Optional cloud judge. Only used after explicit consent to send evaluation text to NVIDIA.
// Supervisor/programmer prompts remain separate from the judge and never receive raw WhatsApp data.
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export function validateNimJudgeConfiguration({
  model, apiKey = process.env.NVIDIA_API_KEY,
  consent = process.env.LAB_JUDGE_REMOTE_CONSENT,
  baseUrl = process.env.LAB_JUDGE_BASE_URL || DEFAULT_BASE_URL
} = {}) {
  if (!model || !String(model).trim()) throw new Error('Configura LAB_JUDGE_MODEL para NVIDIA NIM');
  if (!apiKey || !String(apiKey).trim()) throw new Error('Configura NVIDIA_API_KEY en .env para el juez NVIDIA NIM');
  if (consent !== 'YES') throw new Error('NVIDIA NIM es remoto y recibirá contexto, referencias y respuestas privadas. Para autorizarlo explícitamente, configura LAB_JUDGE_REMOTE_CONSENT=YES (solo con consentimiento de los participantes)');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('LAB_JUDGE_BASE_URL inválida'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('LAB_JUDGE_BASE_URL no puede contener credenciales ni parámetros');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('LAB_JUDGE_BASE_URL debe usar HTTPS (HTTP permitido solo en localhost)');
  }
  return { model: String(model).trim(), apiKey: String(apiKey).trim(), baseUrl: url.href.replace(/\/+$/, '') };
}

export function createNimJudgeClient({
  model,
  apiKey = process.env.NVIDIA_API_KEY,
  consent = process.env.LAB_JUDGE_REMOTE_CONSENT,
  baseUrl = process.env.LAB_JUDGE_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 120000
} = {}) {
  const config = validateNimJudgeConfiguration({model, apiKey, consent, baseUrl});
  return {
    async chatDetails(system, user, overrides = {}) {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{role:'system', content:system}, {role:'user', content:user}],
          stream: false,
          temperature: overrides.temperature ?? 0.1,
          max_tokens: overrides.maxTokens ?? 1200
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403 ? 'revisa NVIDIA_API_KEY'
          : response.status === 429 ? 'límite de uso o cuota; revisa NVIDIA Build'
          : 'revisa el modelo, la conexión y la cuenta NVIDIA';
        // No copiar el cuerpo de error para no revelar datos personales o credenciales.
        throw new Error(`NVIDIA NIM HTTP ${response.status}: ${reason}`);
      }
      const json = await response.json();
      const choice = json?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('NVIDIA NIM no devolvió un juicio textual. Verifica compatibilidad del modelo con JSON y max_tokens');
      }
      if (choice.finish_reason === 'length') {
        throw new Error('NVIDIA NIM truncó el juicio JSON; aumenta max_tokens o reduce contexto');
      }
      return {content: content.trim(), done: true, doneReason: choice.finish_reason ?? 'stop'};
    }
  };
}
