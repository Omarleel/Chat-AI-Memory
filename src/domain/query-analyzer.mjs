// Analizador estructurado de consultas.
// Extrae intención, entidades reales, términos discriminantes y restricciones temporales.

const STOP = new Set(`a al algo alguien ante antes asi aun aunque bajo bien cada como con contra cual cuales cuando de del desde donde dos el ella ellos en entre era es esa ese eso esta estas este esto fue ha hay la las le les lo los mas me mi mis muy no nos o para pero por porque que quien se si sin sobre su sus te ti tu tus un una uno unos unas y ya yo hacer hago haces quieres quiero gusto gusta gustar puedo podria seria esta estoy ir vamos vas fue fueron digo dijo dime oye oe hola gracias entonces vez ahora hoy manana mañana despues sobre cual cuales`.split(' '));

const META_COMMANDS = new Set(`explica cuentame cuenta dime recuerda distingue resume detalle menciona habla sabes sabias conoces paso paso tiempo evolucion historial chats conversacion conversaciones mensajes`.split(' '));

const norm = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function analyzeQuery(text, { selfName = '', peerName = '' } = {}) {
  const raw = String(text ?? '').trim();
  const normalized = norm(raw);
  
  // Nombres conocidos a excluir de entidades destino (son autores, no temas externos)
  const knownAuthors = new Set([
    norm(selfName),
    norm(peerName),
    ...norm(selfName).split(/\s+/),
    ...norm(peerName).split(/\s+/)
  ].filter(s => s && s.length >= 3));

  // Detectar palabras con mayúscula (posibles entidades o nombres propios)
  const capitalized = (raw.match(/\b\p{Lu}\p{L}{2,}/gu) ?? [])
    .map(norm)
    .filter(w => !STOP.has(w) && !META_COMMANDS.has(w) && w.length >= 3);

  // Entidades reales (excluye autores del chat para no sesgar hacia el remitente)
  const entities = [...new Set(capitalized.filter(w => !knownAuthors.has(w)))];

  // Términos temáticos significativos
  const words = (normalized.match(/[a-zñ0-9]{3,}/g) ?? [])
    .filter(w => !STOP.has(w) && !META_COMMANDS.has(w));
  
  // Términos discriminantes (excluyen nombres de autores conocidos a menos que sea la única palabra)
  let terms = words.filter(w => !knownAuthors.has(w));
  if (!terms.length) terms = words;
  terms = [...new Set(terms)];

  // Años mencionados (ej. 2023, 2024, 2025, 2026)
  const years = (raw.match(/\b(202[0-9])\b/g) ?? []).map(Number);

  // Clasificación de intención
  let intent = 'general';
  
  const isRomanticAdvice = /\b(me gusta|me atrae|estoy enamorad[oa]|me interesa|estoy templad[oa])\b/.test(normalized) &&
    (/\b(que (?:hago|debo hacer|le digo|le invito|le regalo|le compro|le propongo|le escribo|hacer)|como (?:hago|le hablo|me acerco)|algun consejo|que me aconsejas|que recomiendas|ayudame|que opinas|a donde (?:la llevo|lo llevo|ir)|que plan)\b/.test(normalized) || /[?¿]/.test(raw));

  const isFollowup = /^(?:¿?\s*)?(?:por\s+qu[eé]|c[oó]mo\s+as[ií]|y\s+entonces|y\s+eso|por\s+eso\??|pero\s+por\s+qu[eé])\s*[¿?!.]*$/i.test(raw);

  const isHistorical = /\b(a lo largo del tiempo|a traves del tiempo|evolucion|historia|desde cuando|como empezo|como fue|que ha contado|que dijo|resumen|a traves de los anos|a traves de los años|recuerdas cuando)\b/.test(normalized);

  const isFactual = /\b(cumpleanos|cumpleaños|nacimiento|fecha|edad|donde vive|donde trabaja|trabajo|numero|telefono|direccion|horario|que dia|a que hora|donde queda)\b/.test(normalized);

  const isGreeting = /^(?:hola|buenas|buenos dias|buenas tardes|buenas noches|que tal|como estas|oe|oe que tal|habla|habla causa)\s*[!.]*$/i.test(normalized);

  const isBanterOrCasual = /\b(tengo hambre|tengo sueno|tengo sueño|que calor|que frio|hace frio|hace calor|sale dota|sale pichanga|tas durmiendo|estas durmiendo|toy muerto|estoy muerto|responde pe|que planes|que hacemos|hacemos hoy|pasa video|manda meme|oe vago|oe sonso|oe ogro|oe responde|todo tranqui|tranqui|que fue mano)\b/.test(normalized);

  const isMemoryRecall = /\b(te acuerdas|te acordas|recuerdas|recuerda|te acordaste|que habiamos quedado|en que quedamos|como se llamaba|como era que se llamaba|que era lo que|que me dijiste|que te dije|que hablamos|de que hablamos|que conversamos|donde habiamos|a que hora habiamos|quedamos en|que hacemos el|que haciamos|que era del)\b/.test(normalized);

  const isTemporalPlan = /\b(el (?:lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)|fin de semana|finde)\b/.test(normalized);

  const hasSpecificEntityOrTopic = entities.length > 0 || /\b(ps5|ps4|ps3|switch|moto|celular|cel|consola|delivery|vender|rematar|comprar|deuda|debes|plata|cuanto|cuánto)\b/i.test(normalized);

  const needsMemoryRetrieval = isHistorical || isFactual || isMemoryRecall || isTemporalPlan || hasSpecificEntityOrTopic;

  if (isFollowup) {
    intent = 'followup';
  } else if (isRomanticAdvice) {
    intent = 'romantic_advice';
  } else if (isHistorical) {
    intent = 'historical_summary';
  } else if (isFactual) {
    intent = 'factual_detail';
  } else if (isGreeting) {
    intent = 'direct_greeting';
  }

  return {
    raw,
    normalized,
    intent,
    entities,
    targetEntity: entities[0] ?? null,
    terms,
    years,
    isFollowup,
    isRomanticAdvice,
    isHistorical,
    isMemoryRecall,
    isTemporalPlan,
    isFactual,
    isGreeting,
    isBanterOrCasual,
    needsMemoryRetrieval
  };
}

