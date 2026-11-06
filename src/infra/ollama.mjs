export class OllamaClient {
  constructor({baseUrl, chatModel, embedModel, modelContext, maxTokens, temperature, repeatPenalty, presencePenalty, frequencyPenalty}) {
    Object.assign(this, {baseUrl, chatModel, embedModel, modelContext, maxTokens, temperature, repeatPenalty, presencePenalty, frequencyPenalty});
  }
  withModel(chatModel) {
    return new OllamaClient({...this, chatModel});
  }
  // Modelo general para decisiones con contrato JSON (router, revisor, extracción): sin las penalizaciones
  // de repetición del redactor, que deforman salidas con valores repetidos ("false", "sigue", ...).
  asReasoner(chatModel) {
    return new OllamaClient({...this, chatModel, repeatPenalty: 1, presencePenalty: 0, frequencyPenalty: 0});
  }
  async request(path, body, timeoutMs = 120000) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  }
  // SYSTEM declarado en el Modelfile del modelo (null si no tiene): los modelos entrenados aquí llevan su prompt de entrenamiento.
  async modelSystem(name = this.chatModel) {
    const info = await this.request('/api/show', {model: name}, 10000);
    return typeof info?.system === 'string' ? info.system : null;
  }
  // Catálogo de modelos instalados y cargados en memoria, sin parámetros internos.
  async listModels() {
    const get = async path => {
      const response = await fetch(`${this.baseUrl}${path}`, {signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return response.json();
    };
    const [tags, ps] = await Promise.all([get('/api/tags'), get('/api/ps').catch(() => ({models: []}))]);
    const loaded = new Map((ps.models ?? []).map(m => [m.name, m.size_vram ?? m.size ?? 0]));
    return (tags.models ?? []).map(m => ({name: m.name, size: m.size ?? 0, modifiedAt: m.modified_at ?? null,
      family: m.details?.family ?? null, parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null, loaded: loaded.has(m.name), vram: loaded.get(m.name) ?? 0}));
  }
  async embedMany(texts) {
    if (!texts.length) return [];
    const data = await this.request('/api/embed', {model: this.embedModel, input: texts, truncate: true}, 180000);
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length)
      throw new Error('Ollama devolvió embeddings incompletos');
    return data.embeddings;
  }
  async embed(text) { return (await this.embedMany([text]))[0]; }
  async chatDetails(system, user, overrides = {}) {
    const maxPredict = overrides.maxTokens ?? this.maxTokens;
    const messages = Array.isArray(overrides.messages) && overrides.messages.length > 0
      ? overrides.messages
      : [{role: 'system', content: system}, {role: 'user', content: user}];
    const response = await this.request('/api/chat', {
      model: this.chatModel, stream: false, think: false, keep_alive: '15m',
      messages,
      ...(overrides.format ? {format:overrides.format} : {}),
      options: {
        temperature: overrides.temperature ?? this.temperature,
        top_p: overrides.topP ?? 0.85,
        ...(((overrides.repeatPenalty ?? this.repeatPenalty) != null) ? { repeat_penalty: overrides.repeatPenalty ?? this.repeatPenalty } : {}),
        ...(((overrides.presencePenalty ?? this.presencePenalty) != null) ? { presence_penalty: overrides.presencePenalty ?? this.presencePenalty } : {}),
        ...(((overrides.frequencyPenalty ?? this.frequencyPenalty) != null) ? { frequency_penalty: overrides.frequencyPenalty ?? this.frequencyPenalty } : {}),
        num_ctx: overrides.modelContext ?? this.modelContext,
        num_predict: maxPredict
      }
    });
    let content = response?.message?.content?.trim() ?? '';
    let evalCount=response?.eval_count ?? 0, promptEvalCount=response?.prompt_eval_count ?? 0;
    let loadMs=(response?.load_duration ?? 0)/1e6, inferenceMs=(response?.eval_duration ?? 0)/1e6;
    const doneReason = response?.done_reason;
    let truncated = doneReason === 'length';

    // Si terminó por límite de tokens y la frase quedó a medias, intentar una continuación breve
    if (truncated && overrides.allowContinuation !== false && content.length > 0 && !/[.!?:]\s*$/.test(content)) {
      try {
        const continuation = await this.request('/api/chat', {
          model: this.chatModel, stream: false, think: false, keep_alive: '15m',
          messages: [
            ...messages,
            {role: 'assistant', content},
            {role: 'user', content: 'Continúa y concluye brevemente la frase anterior:'}
          ],
          options: {
            temperature: overrides.temperature ?? this.temperature,
            top_p: overrides.topP ?? 0.85,
            num_ctx: overrides.modelContext ?? this.modelContext,
            num_predict: Math.min(200, maxPredict)
          }
        }, 60000);
        evalCount+=continuation?.eval_count ?? 0;
        promptEvalCount+=continuation?.prompt_eval_count ?? 0;
        loadMs+=(continuation?.load_duration ?? 0)/1e6;
        inferenceMs+=(continuation?.eval_duration ?? 0)/1e6;
        const extra = continuation?.message?.content?.trim();
        if (extra) {
          content = `${content} ${extra}`.trim();
          truncated = continuation?.done_reason === 'length';
        }
      } catch {
        // En caso de fallo de red en la continuación, se conserva el contenido inicial
      }
    }

    if (!content) throw new Error('Ollama no devolvió una respuesta textual');
    return {
      content,
      done: response?.done ?? true,
      doneReason: response?.done_reason ?? 'stop',
      loadMs, inferenceMs, evalCount, promptEvalCount,
      truncated
    };
  }
  async chat(system, user, overrides = {}) {
    const details = await this.chatDetails(system, user, overrides);
    return details.content;
  }
}
