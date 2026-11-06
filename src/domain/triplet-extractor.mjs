// Extractor estructurado de tripletas de conocimiento: (Sujeto, Relación, Objeto)
// Combina análisis lingüístico determinista rápido con extracción estructurada vía LLM.

const norm = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const STOPWORDS_OBJECT = new Set([
  'nada', 'todo', 'eso', 'esto', 'nadie', 'algo', 'mas', 'mucho', 'uwu', 'jaja',
  'xd', 'pe', 'asi', 'bien', 'mal', 'tanto', 'como', 'los', 'las', 'unos', 'unas',
  'otro', 'otra', 'otros', 'otras', 'cuando', 'donde', 'porque', 'bastante', 'poco',
  'demasiado', 'cualquier', 'cada', 'alguien', 'ninguno', 'ninguna', 'ella', 'el',
  'ellos', 'ellas', 'ti', 'mi', 'conmigo', 'contigo', 'que', 'un', 'una', 'uno',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella'
]);

const COMMON_VERBS = new Set([
  'ser', 'estar', 'haber', 'tener', 'hacer', 'poder', 'decir', 'ir', 'ver', 'dar', 'saber',
  'querer', 'llegar', 'pasar', 'deber', 'poner', 'parecer', 'quedar', 'creer', 'hablar',
  'llevar', 'dejar', 'seguir', 'encontrar', 'llamar', 'venir', 'pensar', 'salir', 'volver',
  'tomar', 'conocer', 'vivir', 'sentir', 'tratar', 'mirar', 'contar', 'empezar', 'esperar',
  'buscar', 'existir', 'entrar', 'trabajar', 'escribir', 'perder', 'producir', 'ocurrir',
  'entender', 'pedir', 'recibir', 'recordar', 'terminar', 'permitir', 'aparecer', 'conseguir',
  'comenzar', 'servir', 'sacar', 'necesitar', 'mantener', 'leer', 'caer', 'cambiar', 'presentar',
  'crear', 'abrir', 'considerar', 'oir', 'acabar', 'ganar', 'formar', 'traer', 'partir', 'morir',
  'aceptar', 'realizar', 'suponer', 'comprender', 'lograr', 'explicar', 'preguntar', 'tocar',
  'reconocer', 'estudiar', 'alcanzar', 'nacer', 'dirigir', 'correr', 'utilizar', 'pagar', 'ayudar',
  'gustar', 'jugar', 'escuchar', 'cumplir', 'ofrecer', 'descubrir', 'levantar', 'intentar',
  'copiar', 'promocionar', 'tejer', 'vender', 'comprar', 'dormir', 'chatear', 'conversar',
  'viajar', 'manejar', 'cocinar', 'bailar', 'cantar', 'beber', 'fumar', 'aprender', 'ensenar'
]);

const CLITICS = ['me', 'te', 'se', 'nos', 'le', 'les', 'lo', 'la', 'los', 'las'];

const SPANISH_NAMES_WITH_R = new Set([
  'omar', 'cesar', 'oscar', 'edgar', 'pilar', 'arthur', 'gaspar', 'baltazar', 'walter', 'roger', 'javier', 'victor', 'hector'
]);

function isValidEntity(val) {
  if (!val || typeof val !== 'string') return false;
  const s = norm(val.trim());
  if (s.length < 3 || s.length > 30) return false;
  if (s.endsWith('mente')) return false;
  if (STOPWORDS_OBJECT.has(s)) return false;
  if (COMMON_VERBS.has(s)) return false;
  for (const clitic of CLITICS) {
    if (s.endsWith(clitic)) {
      const base = s.slice(0, -clitic.length);
      if (COMMON_VERBS.has(base) || ((base.endsWith('ar') || base.endsWith('er') || base.endsWith('ir')) && !SPANISH_NAMES_WITH_R.has(base))) return false;
    }
  }
  if ((s.endsWith('ar') || s.endsWith('er') || s.endsWith('ir')) && !SPANISH_NAMES_WITH_R.has(s)) {
    return false;
  }
  return true;
}

// Extracción determinista inmediata a partir de un mensaje individual o intercambio
export function extractDeterministicTriplets(text, { author = 'Usuario', peer = 'Interlocutor' } = {}) {
  const raw = String(text ?? '').trim();
  const normalized = norm(raw);
  const triplets = [];

  // 1. Sentimientos y atracciones
  // Ejemplos: "me gusta Ana", "De q me gusta. Ana", "mi ilusión por Ana", "estoy templado de Beatriz"
  const matchGustos = normalized.match(/(?:me\s+gusta[\s.,]+|mi\s+ilusi[oó]n\s+por[\s.,]+|estoy\s+(?:enamorad[oa]|templad[oa])\s+de[\s.,]+|me\s+atrae[\s.,]+|(?:antes\s+)?me\s+gustaba[\s.,]+)([a-zñ]{3,20})/i);
  if (matchGustos && isValidEntity(matchGustos[1])) {
    const target = matchGustos[1];
    triplets.push({
      subject: author,
      relation: 'LE_GUSTA',
      object: target.charAt(0).toUpperCase() + target.slice(1).toLowerCase(),
      confidence: 0.95
    });
  }

  // Atracción de un tercero o descrita explícitamente: "A Diego le gusta Ana", "Diego está templado de Beatriz"
  const matchGustoTercero = normalized.match(/(?:a\s+([a-zñ]{3,20})\s+le\s+gusta[\s.,]+|([a-zñ]{3,20})\s+esta\s+templad[oa]\s+de[\s.,]+)([a-zñ]{3,20})/i);
  if (matchGustoTercero) {
    const sub = matchGustoTercero[1] || matchGustoTercero[2];
    const obj = matchGustoTercero[3];
    if (isValidEntity(sub) && isValidEntity(obj) && norm(sub) !== norm(obj)) {
      triplets.push({
        subject: sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase(),
        relation: 'LE_GUSTA',
        object: obj.charAt(0).toUpperCase() + obj.slice(1).toLowerCase(),
        confidence: 0.90
      });
    }
  }

  // 2. Cumpleaños y fechas
  const matchCumple = normalized.match(/(?:mi\s+cumple(?:a[nñ]os)?\s+(?:es\s+)?(?:el\s+)?|cumple(?:a[nñ]os)?\s+(?:de\s+([a-zñ]{3,20})\s+es\s+el\s+))([0-9]{1,2}(?:\s+de\s+[a-zñ]+)?)/i);
  if (matchCumple) {
    const subject = matchCumple[1] ? matchCumple[1].charAt(0).toUpperCase() + matchCumple[1].slice(1).toLowerCase() : author;
    const date = matchCumple[2] || matchCumple[1];
    if (date && date.trim().length > 0) {
      triplets.push({
        subject,
        relation: 'CUMPLEANOS',
        object: date.trim(),
        confidence: 0.95
      });
    }
  }

  const matchCumpleHoy = normalized.match(/(?:hoy\s+es\s+el\s+cumple(?:a[nñ]os)?\s+de\s+)([a-zñ]{3,20})/i);
  if (matchCumpleHoy && isValidEntity(matchCumpleHoy[1])) {
    const who = matchCumpleHoy[1].charAt(0).toUpperCase() + matchCumpleHoy[1].slice(1).toLowerCase();
    triplets.push({
      subject: who,
      relation: 'CUMPLEANOS',
      object: 'Hoy',
      confidence: 0.90
    });
  }

  // 3. Dispositivos, consolas y compras/ventas
  const DEVICE_REGEX = /(?:comprare|me\s+compre|tengo|saque)\s+(?:una?\s+)?(ps5|ps4|ps3|switch|pc|consola|moto|auto|carro|tv|celular|iphone|laptop|redmi)/i;
  const matchCompra = normalized.match(DEVICE_REGEX);
  if (matchCompra) {
    triplets.push({
      subject: author,
      relation: 'TIENE_DISPOSITIVO',
      object: matchCompra[1].toUpperCase(),
      confidence: 0.90
    });
  }

  // Mención de posesión del interlocutor ("tu moto", "tu celular")
  const matchPosesionPeer = normalized.match(/(?:tu\s+)(ps5|ps4|ps3|switch|pc|consola|moto|auto|carro|tv|celular|iphone|laptop|redmi)/i);
  if (matchPosesionPeer) {
    triplets.push({
      subject: peer,
      relation: 'TIENE_DISPOSITIVO',
      object: matchPosesionPeer[1].toUpperCase(),
      confidence: 0.85
    });
  }

  const matchVenta = normalized.match(/(?:vendere|estoy\s+vendiendo|remato)\s+(?:este\s+|esta\s+|una?\s+)?(ps5|ps4|ps3|switch|pc|consola|moto|auto|carro|tv|celular|cel|iphone|laptop)/i);
  if (matchVenta) {
    const item = matchVenta[1].toLowerCase() === 'cel' ? 'CELULAR' : matchVenta[1].toUpperCase();
    triplets.push({
      subject: author,
      relation: 'VENDE',
      object: item,
      confidence: 0.90
    });
  }

  // 4. Trabajo, estudios y ubicación
  const matchChamba = normalized.match(/(?:trabajo\s+en|mi\s+chamba\s+es\s+en|laburo\s+en)\s+([a-zñ0-9\s]{3,30})/i);
  if (matchChamba) {
    triplets.push({
      subject: author,
      relation: 'TRABAJA_EN',
      object: matchChamba[1].trim(),
      confidence: 0.85
    });
  }

  const matchVive = normalized.match(/(?:vivo\s+en|me\s+mude\s+a)\s+([a-zñ0-9\s]{3,30})/i);
  if (matchVive) {
    triplets.push({
      subject: author,
      relation: 'VIVE_EN',
      object: matchVive[1].trim(),
      confidence: 0.85
    });
  }

  // 5. Planes y acuerdos firmes
  const matchAcuerdo = normalized.match(/(?:el\s+(?:lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)|fin\s+de\s+semana)\s+(?:jugamos|vamos|hacemos|salimos)\s+([a-zñ0-9\s]{3,30})/i);
  if (matchAcuerdo) {
    triplets.push({
      subject: author,
      relation: 'ACORDO_PLAN',
      object: raw.trim().slice(0, 80),
      confidence: 0.85
    });
  }

  return triplets;
}

// Extractor profundo vía Ollama para fragmentos de conversación más amplios
export async function extractTripletsWithLLM(llmClient, conversationChunk, { selfAuthor = 'Tú', peerAuthor = 'Contacto' } = {}) {
  const prompt = `Analiza el siguiente fragmento de conversación real de WhatsApp entre "${selfAuthor}" y "${peerAuthor}".
Tu tarea es extraer ÚNICAMENTE hechos relacionales concretos, gustos, posesiones, planes o datos personales verificados en formato JSON estricto.

Reglas:
1. Extrae solo afirmaciones explícitas (Sujeto, Relación, Objeto).
2. "subject": Quién realiza o experimenta la relación (ej: "${selfAuthor}", "${peerAuthor}", o el nombre de un tercero mencionado como "Ana").
3. "relation": Una acción o atributo en MAYÚSCULAS_CON_GUION_BAJO (ej: LE_GUSTA, TIENE, VENDE, CUMPLEANOS, VIVE_EN, TRABAJA_EN, ACORDO_PLAN).
4. "object": A quién o qué va dirigida la relación (ej: "Ana", "PS5", "15 de Agosto").
5. Si no hay hechos relacionales claros o es solo charla casual, devuelve una lista vacía [].

Fragmento:
"""
${conversationChunk}
"""

Responde ÚNICAMENTE con el arreglo JSON, sin texto explicativo:
[{"subject": "...", "relation": "...", "object": "...", "confidence": 0.9}]`;

  try {
    const raw = await llmClient.chat('Eres un extractor preciso de grafos de conocimiento en formato JSON.', prompt, {
      temperature: 0.1,
      maxTokens: 500
    });

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(item => item && typeof item === 'object' && item.subject && item.relation && item.object)
      .map(item => ({
        subject: String(item.subject).trim(),
        relation: String(item.relation).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        object: String(item.object).trim(),
        confidence: Number(item.confidence) || 0.85
      }));
  } catch {
    return [];
  }
}
