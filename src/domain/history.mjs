import { createHash } from 'node:crypto';

// Formatos habituales de exportación iOS/Android de WhatsApp (español/inglés).
const WITH_BRACKETS = /^\[(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?)\]\s+([^:]+?):\s([\s\S]*)$/i;
const WITH_DASH = /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?)\s+-\s+([^:]+?):\s([\s\S]*)$/i;
const SYSTEM_LINE = /^(?:\[\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}.*?\]|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}.*? - )/;
const MEDIA_LINE = /^<?(?:imagen omitida|video omitido|audio omitido|sticker omitido|archivo adjunto|media omitted|image omitted|video omitted|audio omitted)>?$/i;

export function cleanWhatsAppText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[\u202f\u00a0]/g, ' ');
}

export function normalizeTimestamp(raw, dateOrder = 'auto') {
  if (!raw || typeof raw !== 'string') return { iso: null, raw: String(raw ?? '') };
  const clean = cleanWhatsAppText(raw).replace(/\s+/g, ' ').trim();
  const m = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap]\.?\s*m\.?))?$/i);
  if (!m) return { iso: null, raw: clean };
  let [, p1, p2, p3, hour, min, sec, ampm] = m;
  let year = parseInt(p3, 10);
  if (year < 100) year = year < 70 ? 2000 + year : 1900 + year;
  let num1 = parseInt(p1, 10), num2 = parseInt(p2, 10);
  let day, month;
  if (num1 > 12 && num2 <= 12) { day = num1; month = num2; }
  else if (num2 > 12 && num1 <= 12) { day = num2; month = num1; }
  else if (dateOrder === 'MDY') { day = num2; month = num1; }
  else { day = num1; month = num2; }
  const ambiguous = num1 <= 12 && num2 <= 12 && dateOrder === 'auto';
  let h = parseInt(hour, 10);
  const mMin = parseInt(min, 10);
  const sSec = sec ? parseInt(sec, 10) : 0;
  if (ampm) {
    if (/p/i.test(ampm) && h < 12) h += 12;
    if (/a/i.test(ampm) && h === 12) h = 0;
  }
  const pad = n => String(n).padStart(2, '0');
  const valid = year >= 1900 && year <= 2100 && h < 24 && mMin < 60 && sSec < 60 &&
    new Date(Date.UTC(year,month-1,day)).getUTCDate() === day && month >= 1 && month <= 12;
  const iso = valid ? `${year}-${pad(month)}-${pad(day)}T${pad(h)}:${pad(mMin)}:${pad(sSec)}` : null;
  return { iso, raw: clean, year, month, day, hour: h, minute: mMin, second: sSec,
    ambiguous, dateOrder:dateOrder==='auto' ? (num1>12?'DMY':num2>12?'MDY':'unresolved_DMY_assumed') : dateOrder };
}

export function parseWhatsAppTxt(txt) {
  const messages = [];
  const cleaned = cleanWhatsAppText(txt);
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const match = line.match(WITH_BRACKETS) ?? line.match(WITH_DASH);
    if (match) {
      const [, date, time, author, content] = match;
      const rawTimestamp = `${date} ${time}`;
      const { iso } = normalizeTimestamp(rawTimestamp);
      messages.push({
        timestamp: rawTimestamp,
        rawTimestamp,
        isoTimestamp: iso,
        author: author.trim(),
        text: content.trim()
      });
    } else if (messages.length > 0 && !SYSTEM_LINE.test(line)) {
      messages[messages.length - 1].text += `\n${line}`;
    }
  }
  const direct=messages.filter(m=>m.author && m.text && !MEDIA_LINE.test(m.text));
  const formats=direct.map(m=>m.rawTimestamp.match(/^(\d{1,2})[\/-](\d{1,2})/)).filter(Boolean);
  const dmy=formats.filter(m=>Number(m[1])>12 && Number(m[2])<=12).length;
  const mdy=formats.filter(m=>Number(m[2])>12 && Number(m[1])<=12).length;
  const detected=dmy>mdy?'DMY':mdy>dmy?'MDY':null;
  for(const m of direct){
    const time=normalizeTimestamp(m.rawTimestamp,detected ?? 'auto');
    m.isoTimestamp=time.iso;
    m.dateOrder=time.dateOrder;
    m.timestampAmbiguous=time.ambiguous;
  }
  return direct;
}

export function selectDirectHistory(messages, self, peer) {
  const names = [self.toLocaleLowerCase(), peer.toLocaleLowerCase()];
  if (!self || !peer || names[0] === names[1]) throw new Error('Especifica nombres distintos: --self y --peer');
  const selected = messages.filter(m => names.includes(m.author.toLocaleLowerCase()));
  if (!selected.some(m => m.author.toLocaleLowerCase() === names[0])) throw new Error(`No encontré mensajes de --self=${self}. Revisa el nombre exacto.`);
  if (!selected.some(m => m.author.toLocaleLowerCase() === names[1])) throw new Error(`No encontré mensajes de --peer=${peer}. Revisa el nombre exacto.`);
  return selected.map((m, idx) => ({
    ...m,
    ordinal: idx,
    role: m.author.toLocaleLowerCase() === names[0] ? 'self' : 'peer'
  }));
}

export function chunkHistory(messages, maxChars = 1300, overlapMessages = 2, { detailed = false } = {}) {
  const result = [];
  let current = [];
  let currentMessages = [];
  let length = 0;
  const serialize = m => `${m.timestamp} · ${m.author}: ${m.text.slice(0, 1200)}`;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const s = serialize(msg);
    if (current.length && length + s.length + 1 > maxChars) {
      const body = current.join('\n');
      if (detailed) {
        result.push({
          body,
          messageIds: currentMessages.map(m => m.id ?? `msg_${m.ordinal ?? 0}`),
          startOrdinal: currentMessages[0]?.ordinal ?? 0,
          endOrdinal: currentMessages[currentMessages.length - 1]?.ordinal ?? 0,
          startIso: currentMessages[0]?.isoTimestamp ?? null,
          endIso: currentMessages[currentMessages.length - 1]?.isoTimestamp ?? null
        });
      } else {
        result.push(body);
      }
      current = current.slice(-overlapMessages);
      currentMessages = currentMessages.slice(-overlapMessages);
      length = current.join('\n').length;
      while (current.length && length + s.length + 1 > maxChars) {
        current.shift();
        currentMessages.shift();
        length = current.join('\n').length;
      }
    }
    current.push(s);
    currentMessages.push(msg);
    length += s.length + 1;
  }
  if (current.length) {
    const body = current.join('\n');
    if (detailed) {
      result.push({
        body,
        messageIds: currentMessages.map(m => m.id ?? `msg_${m.ordinal ?? 0}`),
        startOrdinal: currentMessages[0]?.ordinal ?? 0,
        endOrdinal: currentMessages[currentMessages.length - 1]?.ordinal ?? 0,
        startIso: currentMessages[0]?.isoTimestamp ?? null,
        endIso: currentMessages[currentMessages.length - 1]?.isoTimestamp ?? null
      });
    } else {
      result.push(body);
    }
  }
  return result;
}

// Ventanas de conversación con límites por inactividad y longitud: no comparten mensajes
// entre episodios. Los IDs permiten expansión precisa en SQLite sin duplicar hechos.
export function chunkEpisodes(messages, {maxChars=1500, gapMinutes=60}={}) {
  const chunks=[];let current=[];let lastMs=null;
  const flush=()=>{
    if(!current.length)return;
    chunks.push({body:current.map(m=>`${m.rawTimestamp ?? m.timestamp} · ${m.author}: ${m.text}`).join('\n'),
      messageIds:current.map(m=>m.id),startIso:current[0].isoTimestamp ?? null,
      endIso:current.at(-1).isoTimestamp ?? null,
      startOrdinal:current[0].ordinal,endOrdinal:current.at(-1).ordinal});
    current=[];
  };
  for(const m of messages){
    const ms=Date.parse(m.isoTimestamp ?? '') || null;
    const line=`${m.rawTimestamp ?? m.timestamp} · ${m.author}: ${m.text}`;
    const size=current.reduce((n,x)=>n+x.text.length+80,0);
    if(current.length && (size+line.length>maxChars ||
      (lastMs!==null && ms!==null && (ms-lastMs>gapMinutes*60000 || ms<lastMs)))) flush();
    current.push(m);lastMs=ms;
  }
  flush();return chunks;
}

export function exampleStyles(messages, self, count = 24) {
  const candidates = messages.filter(m => m.author.toLocaleLowerCase() === self.toLocaleLowerCase())
    .map(m => m.text.replace(/\s+/g, ' ').trim())
    .filter(t => t.length >= 8 && t.length <= 250 && !/(https?:\/\/|contraseñ|password|\b\d{6}\b)/i.test(t));
  if (candidates.length <= count) return [...new Set(candidates)];
  const stride = candidates.length / count;
  return [...new Set(Array.from({length: count}, (_, i) => candidates[Math.floor(i * stride)]))];
}

export function extractStylePairs(messages, self, maxPairs = 2000) {
  const selfLower = self.toLocaleLowerCase();
  const pairs = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const m1 = messages[i];
    const m2 = messages[i + 1];
    if (m1.author.toLocaleLowerCase() !== selfLower && m2.author.toLocaleLowerCase() === selfLower) {
      const inc = m1.text.replace(/\s+/g, ' ').trim();
      const rep = m2.text.replace(/\s+/g, ' ').trim();
      if (inc.length >= 2 && inc.length <= 200 && rep.length >= 3 && rep.length <= 250 &&
          !/<Multimedia/i.test(inc) && !/<Multimedia/i.test(rep) &&
          !/<Se editó/i.test(inc) && !/<Se editó/i.test(rep) &&
          !/(https?:\/\/|contraseñ|password|\b\d{6}\b)/i.test(rep)) {
        let contextType = 'casual_chat';
        if (/[?¿]/.test(inc)) contextType = 'question_reply';
        else if (/\b(consejo|ayuda|que hago|recomiendas)\b/i.test(inc)) contextType = 'advice_reply';
        pairs.push({
          incoming: inc,
          reply: rep,
          contextType,
          hash: createHash('sha256').update(`${inc}|||${rep}`).digest('hex')
        });
        if (pairs.length >= maxPairs * 2) break;
      }
    }
  }
  const seen = new Set();
  const unique = [];
  for (const p of pairs) {
    if (!seen.has(p.hash)) {
      seen.add(p.hash);
      unique.push(p);
      if (unique.length >= maxPairs) break;
    }
  }
  return unique;
}

export function formatCasualWhatsApp(text, persona = null, incomingQuestion = null) {
  let cleaned = String(text ?? '').trim();
  // Anti-self-identification: No responder presentándose ni usando su propio nombre
  const selfName = persona?.author;
  if (selfName) {
    const escapedName = selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp('^(?:Hola,\\s*)?Soy\\s+' + escapedName + '[.!/]?\\s*', 'i'), '');
    cleaned = cleaned.replace(new RegExp('^' + escapedName + ':\\s*', 'i'), '');
  } else {
    cleaned = cleaned.replace(/^(?:Hola,\s*)?Soy\s+[^,.!?\n]+[.!]?\s*/i, '');
  }
  
  // Cortar párrafos excesivos: WhatsApp real tiene máximo 2 líneas breves
  const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 2) {
    cleaned = lines.slice(0, 2).join('\n');
  }

  // Anti-loop: eliminar frases idénticas repetidas en la misma respuesta
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const deduped = [];
  for (const sent of sentences) {
    const norm = sent.toLowerCase().replace(/[^a-záéíóúñ0-9]/g, '');
    if (!norm) continue;
    if (seen.has(norm)) break;
    seen.add(norm);
    deduped.push(sent);
  }
  if (deduped.length > 0) {
    cleaned = deduped.join(' ');
  }

  // No reescribir léxico, puntuación o dialecto: el modelo aprende el estilo del titular.
  if (selfName && cleaned.toLowerCase().startsWith(selfName.toLowerCase() + ':'))
    cleaned = cleaned.slice(selfName.length + 1).trim();
  if (incomingQuestion && cleaned.trim() === String(incomingQuestion).trim()) return '';
  return cleaned.replace(/\s+([?!])/g, '$1').trim();
}

export function extractPersonas(messages, self, peer) {
  const selfLower = (self ?? '').toLocaleLowerCase();
  const peerLower = (peer ?? '').toLocaleLowerCase();

  const slangTokens = [
    'xd', 'xdd', 'xddd', 'tmr', 'alv', 'plox', 'pe', 'oe', 'mano', 'causa', 'bro', 'choche',
    'weon', 'wn', 'pana', 'uwu', 'owo', "':v", "v:", ":v",
    'q', 'pq', 'd', 'tb', 'tmb', 'ps', 'px', 'tmbn', 'pa', 'tas', 'ta', 'toy',
    'zzz', 'f', 'lol', 'jaja', 'jajaja', 'jajajaja', 'asi'
  ];

  const STOPWORDS = new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'u', 'e',
    'de', 'del', 'al', 'a', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'entre',
    'que', 'se', 'me', 'te', 'mi', 'tu', 'su', 'mis', 'tus', 'sus', 'lo', 'le', 'les',
    'es', 'son', 'fue', 'era', 'hay', 'ha', 'he', 'han', 'pero', 'mas', 'muy', 'ya',
    'si', 'no', 'yo', 'ella', 'nos', 'como', 'cuando', 'donde', 'quien',
    'the', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are', 'was'
  ]);

  function profileFor(authorName, role) {
    const isRole = m => {
      if (m.role) return m.role === role;
      const a = (m.author ?? '').toLocaleLowerCase();
      return role === 'self' ? a === selfLower : a === peerLower;
    };

    const targetMsgs = (messages ?? []).filter(isRole)
      .map(m => (m.text ?? '').trim())
      .filter(t => t.length > 0 && !/^<Multimedia/i.test(t));

    const total = targetMsgs.length;
    if (total === 0) {
      return {
        role,
        author: authorName,
        totalMessages: 0,
        avgLength: 25,
        lowercaseStartRate: 0.1,
        endingDotRate: 0.02,
        invertedPunctuationRate: 0,
        accentRate: 0.1,
        topSlang: ['xd', 'q', 'pe', 'tmr'],
        samplePhrases: [],
        summary: `${authorName} (${role}) sin mensajes registrados.`
      };
    }

    let totalChars = 0;
    let lowercaseStarts = 0;
    let endingDots = 0;
    let invertedPunct = 0;
    let accents = 0;
    const tokenCounts = new Map();

    for (const text of targetMsgs) {
      totalChars += text.length;
      if (/^[a-zñ]/.test(text)) lowercaseStarts++;
      if (text.endsWith('.')) endingDots++;
      if (/[¿¡]/.test(text)) invertedPunct++;
      if (/[áéíóúÁÉÍÓÚ]/.test(text)) accents++;

      const lower = text.toLowerCase();
      for (const token of slangTokens) {
        const regex = new RegExp(`(^|[\\s.,!?])${token}([\\s.,!?]|$)`, 'i');
        if (regex.test(lower)) {
          tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
        }
      }

      // Extracción dinámica de tokens informales y modismos del corpus
      const tokens = lower.match(/[\p{L}\p{N}_:'<>-]{1,12}/gu) ?? [];
      for (const t of tokens) {
        if (STOPWORDS.has(t) || t.length <= 1) continue;
        if (/(.)\1{2,}/.test(t) || /[:;xXvV38<>-]/.test(t) || t.length <= 4) {
          tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
        }
      }
    }

    const topSlang = Array.from(tokenCounts.entries())
      .filter(([_, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([token]) => token)
      .slice(0, 12);

    const cleanCandidates = targetMsgs
      .filter(t => t.length >= 6 && t.length <= 80 &&
        !/<Multimedia/i.test(t) && !/<Se editó/i.test(t) &&
        !/(https?:\/\/|contraseñ|password|\b\d{6}\b)/i.test(t) &&
        !/^(ok|si|no|ya|xd|voy|ahi)$/i.test(t));

    const cleanSamples = cleanCandidates.length <= 20
      ? cleanCandidates
      : Array.from({ length: 20 }, (_, i) => cleanCandidates[Math.floor(i * (cleanCandidates.length / 20))]);

    const avgLength = Math.round((totalChars / total) * 10) / 10;
    const endingDotRate = Math.round((endingDots / total) * 100) / 100;
    const invertedPunctuationRate = Math.round((invertedPunct / total) * 100) / 100;
    const accentRate = Math.round((accents / total) * 100) / 100;

    const isCasual = endingDotRate < 0.15 && invertedPunctuationRate < 0.10;
    const registerDesc = isCasual ? 'informal y directo de confianza' : 'formal y estructurado';
    const punctDesc = endingDotRate < 0.10 ? 'sin puntos finales formales' : 'con puntuación estándar';
    const summary = role === 'self'
      ? `${authorName} es el remitente. Escribe con registro ${registerDesc}, mensajes de longitud promedio ~${Math.round(avgLength)} caracteres, ${punctDesc}. Cero formalismos de asistente y respuestas al grano.`
      : `${authorName} es el interlocutor en el chat. Escribe con registro ${registerDesc} (~${Math.round(avgLength)} caracteres por mensaje).`;

    return {
      role,
      author: authorName,
      totalMessages: total,
      avgLength,
      lowercaseStartRate: Math.round((lowercaseStarts / total) * 100) / 100,
      endingDotRate,
      invertedPunctuationRate,
      accentRate,
      topSlang,
      samplePhrases: cleanSamples,
      summary
    };
  }

  return {
    self: profileFor(self, 'self'),
    peer: profileFor(peer, 'peer')
  };
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}
