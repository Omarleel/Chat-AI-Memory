// Libera la VRAM ocupada por Ollama antes de entrenar; los modelos se recargan bajo demanda.
export class OllamaGpu {
  constructor({baseUrl}) {this.baseUrl = baseUrl.replace(/\/$/, '');}
  async unloadModels() {
    const ps = await fetch(`${this.baseUrl}/api/ps`, {signal: AbortSignal.timeout(10000)}).then(r => r.ok ? r.json() : {models: []});
    const names = (ps.models ?? []).map(m => m.name);
    for (const model of names)
      await fetch(`${this.baseUrl}/api/generate`, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({model, keep_alive: 0}), signal: AbortSignal.timeout(30000)});
    return names;
  }
}
