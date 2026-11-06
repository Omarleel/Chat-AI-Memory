// Cliente del motor Node para el ejecutor local de entrenamiento (mismo token administrativo).
export class EngineApiClient {
  constructor({baseUrl, token}) {Object.assign(this, {baseUrl: baseUrl.replace(/\/$/, ''), token});}
  async request(method, path, body, {raw = false, timeoutMs = 120000} = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {method,
      headers: {authorization: `Bearer ${this.token}`, ...(body ? {'content-type': 'application/json'} : {})},
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs)});
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`Motor ${response.status}: ${detail.slice(0, 300)}`), {status: response.status});
    }
    return raw ? response.text() : response.json();
  }
  async heartbeat(info) {return (await this.request('POST', '/api/training/runner/heartbeat', info)).runner;}
  async claim(info) {return (await this.request('POST', '/api/training/runner/claim', info)).job;}
  async dataset(id, split) {
    return split === 'manifest'
      ? this.request('GET', `/api/training/jobs/${id}/dataset?split=manifest`)
      : this.request('GET', `/api/training/jobs/${id}/dataset?split=${split}`, null, {raw: true, timeoutMs: 600000});
  }
  report(id, event) {return this.request('POST', `/api/training/jobs/${id}/events`, event);}
}
