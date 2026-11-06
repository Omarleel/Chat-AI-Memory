// Ollama trata "modelo" y "modelo:latest" como el mismo.
const same = (a, b) => !!a && !!b && (a.includes(':') ? a : `${a}:latest`) === (b.includes(':') ? b : `${b}:latest`);

// Catálogo de modelos de Ollama con el papel que cumple cada uno en esta instalación.
export class ModelService {
  constructor({catalog, config}) {Object.assign(this, {catalog, config});}
  async list() {
    const models = await this.catalog.listModels();
    const roles = name => [
      same(name, this.config.chatModel) && 'writer',
      same(name, this.config.reasoningModel || this.config.chatModel) && 'reasoner',
      same(name, this.config.embedModel) && 'embedding'
    ].filter(Boolean);
    return models.map(m => ({...m, roles: roles(m.name)}));
  }
  // Un modelo de preview debe existir y no puede ser el de embeddings.
  async assertWriter(name) {
    const models = await this.catalog.listModels();
    if (same(name, this.config.embedModel) || !models.some(m => same(m.name, name)))
      throw Object.assign(new Error('Modelo no disponible en Ollama'), {status: 422});
  }
}
