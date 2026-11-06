import {createHash} from 'node:crypto';

export const TRAINING_SYSTEM = 'Escribes como el titular de este chat de WhatsApp. Continúa la conversación respondiendo al interlocutor. Conserva quién dice cada cosa, usa el contexto disponible y no inventes hechos. Devuelve solo la respuesta, con el registro informal del hilo.';

export function trainingText(text) {
  return String(text ?? '').replace(/\s*<Se editó este mensaje\.?>/gi, '').trim();
}

export function isUnavailableMessage(text) {
  return /^(?:<?(?:multimedia omitido|media omitted|imagen omitida|video omitido|audio omitido|sticker omitido|archivo adjunto)>?|(?:se )?elimin[oó] (?:este|un) mensaje\.?|mensaje eliminado\.?|llamada (?:perdida|de voz|de video)|videollamada)/i.test(String(text).trim());
}

export function conversationSessions(messages, {gapMinutes = 120} = {}) {
  const sessions = [];
  let session = null, previousTime = null;
  for (const m of messages) {
    const time = Date.parse(m.isoTimestamp);
    if (!Number.isFinite(time)) { session = null; previousTime = null; continue; }
    if (!session || time < previousTime || time - previousTime > gapMinutes * 60_000) {
      session = {id: `session-${m.ordinal}`, start: m.isoTimestamp, turns: []};
      sessions.push(session);
    }
    previousTime = time;
    const text = trainingText(m.text);
    if (!text) continue;
    const missing = isUnavailableMessage(text);
    const role = m.role === 'peer' ? 'user' : 'assistant';
    const last = session.turns.at(-1);
    const content = missing ? '[Contenido multimedia o eliminado no disponible]' : text;
    if (last?.role === role) {
      last.content += `\n${content}`;
      last.ordinals.push(m.ordinal);
      last.hasUnavailable ||= missing;
    } else {
      session.turns.push({role, content, ordinals: [m.ordinal], hasUnavailable: missing});
    }
  }
  return sessions;
}

export function buildTrainingDataset(messages, {maxTurns = 24, maxChars = 10000, gapMinutes = 120} = {}) {
  const sessions = conversationSessions(messages, {gapMinutes});
  const trainEnd = Math.floor(sessions.length * 0.85);
  const valEnd = Math.floor(sessions.length * 0.95);
  const result = {train: [], validation: [], test: [], stats: {sessions: sessions.length, unavailableTargets: 0, duplicates: 0}};
  const seen = new Set();
  sessions.forEach((session, index) => {
    const split = index < trainEnd ? 'train' : index < valEnd ? 'validation' : 'test';
    for (let i = 1; i < session.turns.length; i++) {
      const target = session.turns[i], previous = session.turns[i - 1];
      if (target.role !== 'assistant' || previous.role !== 'user') continue;
      // No enseñar a adivinar el contenido de un adjunto ausente.
      if (target.hasUnavailable || previous.hasUnavailable) {result.stats.unavailableTargets++; continue;}
      let context = session.turns.slice(Math.max(0, i - maxTurns), i);
      while (context.length > 1 && context.reduce((n, t) => n + t.content.length, 0) > maxChars) context.shift();
      if (context.reduce((n, t) => n + t.content.length, 0) > maxChars) continue;
      const prompt = [{role: 'system', content: TRAINING_SYSTEM}, ...context.map(({role, content}) => ({role, content}))];
      const completion = [{role: 'assistant', content: target.content}];
      const hash = createHash('sha256').update(JSON.stringify({prompt, completion})).digest('hex');
      if (seen.has(hash)) {result.stats.duplicates++; continue;}
      seen.add(hash);
      result[split].push({prompt, completion, provenance: {session: session.id, split, hash,
        contextOrdinals: context.flatMap(t => t.ordinals), targetOrdinals: target.ordinals}});
    }
  });
  return result;
}
