// Explicit memories have two representations: SQLite is source of truth, Qdrant is a rebuildable index.
export class MemoryService {
  constructor({repository, historyStore, llm}) { Object.assign(this, {repository, historyStore, llm}); }
  async add(contact, fact) {
    const text = String(fact ?? '').trim();
    if (!text || text.length > 1000) throw new Error('El recuerdo debe tener entre 1 y 1000 caracteres');
    // Generate the vector before committing to avoid a partially stored fact on normal embedding failure.
    const vector = this.historyStore.saveMemory ? await this.llm.embed(text) : null;
    const id = this.repository.remember(contact, text);
    try {
      if (this.historyStore.saveMemory) await this.historyStore.saveMemory(contact, id, text, vector);
      return id;
    } catch (e) {
      this.repository.deleteMemory(contact, id);
      // Index failure after a successful Qdrant write is recoverable: orphan is excluded from SQLite, retry/rebuild recommended.
      throw e;
    }
  }
  async delete(contact, id) {
    if (this.historyStore.deleteMemory) await this.historyStore.deleteMemory(contact, id);
    return this.repository.deleteMemory(contact, id);
  }
  async eraseContact(contact) {
    if (this.historyStore.eraseContact) await this.historyStore.eraseContact(contact);
    this.repository.eraseContact(contact);
  }
}
