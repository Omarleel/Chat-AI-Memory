import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {BehaviorProfileService} from './behavior-profile-service.mjs';
import { parseWhatsAppTxt, selectDirectHistory, chunkHistory, chunkEpisodes, exampleStyles, extractStylePairs, extractPersonas } from '../domain/history.mjs';

export class ImportService {
  constructor({repository, historyStore = repository, llm, neo4j, graphSync, config={}}) {
    Object.assign(this, {repository, historyStore, llm, neo4j, graphSync, config});
  }
  async importFile({path, contact, self, peer, fileName, onProgress = () => {}}) {
    let stage = 'read';
    try {
      const buffer = await readFile(path);
      if (buffer.length > 50 * 1024 * 1024) throw new Error('TXT > 50 MB: dividir antes de importar');
      const importHash = createHash('sha256').update(buffer).digest('hex');
      stage = 'parse';
      const original = parseWhatsAppTxt(buffer.toString('utf8'));
      const messages = selectDirectHistory(original, self, peer).map(m=>({...m,
        id: `msg_${createHash('sha256').update(`${contact}:${importHash}:${m.ordinal}`).digest('hex').slice(0,24)}`}));
      const detailedChunks = chunkEpisodes(messages);
      if (!detailedChunks.length) throw new Error('No se encontraron mensajes válidos');

      // Guardar mensajes estructurados en SQLite
      stage = 'messages';
      this.repository.saveImportedMessages?.(contact, importHash, messages);

      // Guardar ejemplos y pares conversacionales de estilo
      stage = 'styles';
      this.repository.saveStyles?.(contact, exampleStyles(messages, self));
      this.repository.saveStylePairs?.(contact, extractStylePairs(messages, self));

      // Guardar personalidad para ambas partes (self y peer)
      stage = 'personas';
      this.repository.savePersonas?.(contact, extractPersonas(messages, self, peer));

      const result = {
        importHash, contact, importedMessages: messages.length, chunks: detailedChunks.length,
        authors: [...new Set(original.map(m => m.author))]
      };
      const recordLink = () => this.repository.recordChatImport?.({
        contact, importHash,
        fileName: String(fileName ?? basename(path)).slice(0, 200), self, peer,
        messages: messages.length, chunks: detailedChunks.length
      });

      stage = 'check';
      if (await this.historyStore.hasImport(contact, importHash, detailedChunks.length)) {
        recordLink();
        if (this.graphSync?.enqueue) {
          this.graphSync.enqueue(contact);
          result.graphSync = 'enqueued';
        }
        return {...result, skipped: true};
      }

      // Embeddings locales en lotes. Si falla, la importación puede reintentarse y se omiten duplicados.
      const size = 32;
      for (let i = 0; i < detailedChunks.length; i += size) {
        const group = detailedChunks.slice(i, i + size);
        const texts = group.map(g => g.body);
        stage = 'embed';
        const embeddings = await this.llm.embedMany(texts);
        stage = 'vector';
        await this.historyStore.saveChunks(contact, importHash, i, texts, embeddings, group);
        onProgress(Math.min(detailedChunks.length, i + group.length), detailedChunks.length);
      }
      stage = 'register';
      recordLink();
      if(this.config.autoProfileBuild === true) {
        try {
          const profile=await new BehaviorProfileService({repository:this.repository,llm:this.llm,config:this.config})
            .rebuild(contact,{sampleLimit:32});
          result.behaviorProfile=profile;
        }catch(e){result.behaviorProfile={saved:false,reason:'model_unavailable'};}
      }
      if (this.graphSync?.enqueue) {
        this.graphSync.enqueue(contact);
        result.graphSync = 'enqueued';
      }
      return {...result, skipped: false};
    } catch (error) {
      if (error && typeof error === 'object' && !error.importStage) error.importStage = stage;
      throw error;
    }
  }
}
