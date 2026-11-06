import {trainingText, isUnavailableMessage} from './training-dataset.mjs';

export function prepareRecentContext(messages, {maxMessages = 96, maxChars = 10000, gapMinutes = 120} = {}) {
  let recent = [];
  let previousTime = null;
  for (const message of messages.slice(-maxMessages)) {
    const side = message.side ?? message.role;
    if (!['incoming', 'peer', 'user', 'outgoing', 'self', 'assistant'].includes(side)) continue;
    const rawTime = message.createdAt ?? message.isoTimestamp ?? message.timestamp;
    const time = rawTime ? Date.parse(rawTime) : NaN;
    if (Number.isFinite(time) && previousTime !== null && (time < previousTime || time - previousTime > gapMinutes * 60000)) recent = [];
    previousTime = Number.isFinite(time) ? time : null;
    const original = trainingText(message.text ?? message.content);
    if (!original) continue;
    const text = isUnavailableMessage(original) ? '[Contenido multimedia o eliminado no disponible]' : original;
    recent.push({...message, side: ['incoming','peer','user'].includes(side) ? 'peer' : 'self', text});
  }
  let length = recent.reduce((n, m) => n + m.text.length, 0);
  while (recent.length && length > maxChars) length -= recent.shift().text.length;
  return recent;
}
