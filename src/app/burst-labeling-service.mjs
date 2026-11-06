import {buildTrainingDataset} from '../domain/training-dataset.mjs';
import {burstsToLabel, burstLabelSystem, burstLabelInput, parseBurstKinds, keepFromKinds, holderBurstGap, labelCovers} from '../domain/burst-cleaning.mjs';
import {parseModelJson} from '../domain/semantic-decisions.mjs';

// Etiqueta con el modelo general las ráfagas de train de un titular (qué mensajes conservar).
// Corre en segundo plano y es reanudable: las etiquetas quedan en SQLite por hash de fila.
export class BurstLabelingService {
  constructor({repository, llm, config = {}, concurrency = 3}) {
    Object.assign(this, {repository, llm, config, concurrency});
    this.state = {state: 'idle'};
    this.stopRequested = false;
  }

  status() {return {...this.state};}

  // Ráfagas de train de las fuentes, con su etiqueta si ya existe.
  inventory(sources) {
    const labels = this.repository.listBurstLabels();
    const all = sources.map(s => ({...s, messages: this.repository.listImportMessages(s.contact, s.importHash)}));
    // La misma pausa que usará el dataset: se calcula con todos los chats del titular.
    const gapMinutes = holderBurstGap(all.map(s => s.messages));
    const items = all.flatMap(s => {
      const byOrdinal = new Map(s.messages.map(m => [m.ordinal, m]));
      return burstsToLabel(buildTrainingDataset(s.messages).train, byOrdinal, gapMinutes).map(x => ({...x, peerName: s.peer}));
    });
    return {items, labels, gapMinutes, pending: items.filter(x => !labelCovers(labels.get(x.row.provenance.hash), x.burst.length))};
  }

  start({sources, selfName, limit = null}) {
    if (this.state.state === 'running') return this.status();
    const inv = this.inventory(sources);
    const {items, pending} = inv;
    const queue = limit ? pending.slice(0, limit) : pending;
    this.stopRequested = false;
    this.state = {state: 'running', selfName, model: this.config.reasoningModel ?? null, total: items.length,
      labeled: items.length - pending.length, queued: queue.length, gapMinutes: inv.gapMinutes, done: 0, errors: 0, dropped: 0, cut: 0, startedAt: new Date().toISOString()};
    this._run(queue, selfName).then(() => {
      this.state = {...this.state, state: this.stopRequested ? 'paused' : 'done', finishedAt: new Date().toISOString()};
    }).catch(error => {this.state = {...this.state, state: 'failed', error: String(error?.message ?? error).slice(0, 300)};});
    return this.status();
  }

  pause() {this.stopRequested = true; return this.status();}

  async _run(queue, selfName) {
    let next = 0;
    const worker = async () => {
      while (!this.stopRequested && next < queue.length) {
        const item = queue[next++];
        const kinds = await this.label(item, selfName).catch(() => null);
        if (!kinds) {this.state.errors++; continue;}
        const keep = keepFromKinds(kinds);
        const total = item.burst.length;
        this.repository.saveBurstLabel({hash: item.row.provenance.hash, keep, kinds, model: this.config.reasoningModel});
        this.state.done++; this.state.labeled++;
        if (keep === 0) this.state.dropped++; else if (keep < total) this.state.cut++;
      }
    };
    await Promise.all(Array.from({length: this.concurrency}, worker));
  }

  // Una ráfaga: un reintento si la salida no respeta el contrato; en el último, lo omitido cuenta como "responde".
  async label({row, burst, peerName}, selfName) {
    const system = burstLabelSystem(selfName, peerName || 'Interlocutor');
    const input = burstLabelInput(row, burst, selfName, peerName || 'Interlocutor');
    for (let attempt = 0; attempt < 2; attempt++) {
      // Sin penalizaciones de repetición: las etiquetas se repiten ("sigue", "sigue") y con ellas el modelo acortaba la lista.
      const raw = await this.llm.chatDetails(system, input, {format: 'json', temperature: 0, maxTokens: 30 + 14 * burst.length, allowContinuation: false,
        repeatPenalty: 1, presencePenalty: 0, frequencyPenalty: 0});
      const kinds = raw.truncated ? null : parseBurstKinds(parseModelJson(raw.content), burst.length, {fillMissing: attempt === 1});
      if (kinds) return kinds;
    }
    return null;
  }
}
