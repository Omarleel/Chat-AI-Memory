// Clasificación determinista y conservadora de mensajes suficientemente claros
// que no necesitan recordar hechos anteriores para responder con sentido.
import {queryAnchors} from './rag-ranking.mjs';

const normalize = value => String(value ?? '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function classifyReplyIntent(message) {
  const text = normalize(message);
  const attraction = /\b(me gusta|me atrae|estoy enamorad[oa]|me interesa|estoy templad[oa])\b/.test(text);
  const seekingAdvice = /\b(que (?:hago|debo hacer|le digo|le invito|le regalo|le compro|le propongo|le escribo|hacer)|como (?:hago|le hablo|me acerco|le digo)|algun consejo|que me aconsejas|que recomiendas|ayudame|que opinas|a donde (?:la llevo|lo llevo|ir)|que plan)\b/.test(text) || /[?¿]/.test(message);
  if (attraction && seekingAdvice) {
    return {kind: 'romantic_advice', viewpoint: 'peer', target: queryAnchors(message)[0] ?? null};
  }
  const medicalUrgency = /\b(sangr|hemorragia|caid|segundo piso|dolor (?:fuerte|agudo|pecho)|falta (?:el )?aire|no puedo respirar|asfixi|convulsion|desmayo|sobrinito|pastilla|jarabe|dosis|receta|emergencia)\b/.test(text);
  const medicalRequest = /\b(que (?:le doy|hago|tomo)|dime (?:que|cuant)|cuanto|dosis|pastilla|jarabe|medico|hospital|receta)\b/.test(text) || /[?¿]/.test(message);
  if (medicalUrgency && medicalRequest) {
    return {kind: 'medical_emergency', viewpoint: 'peer', target: null};
  }
  return {kind: 'general', viewpoint: 'peer', target: null};
}

// Verificación acotada para errores de inversión de perspectiva o respuestas absurdas
export function advicePerspectiveError(answer) {
  const text = normalize(answer);
  return /\bme gusta la idea\b|\ba mi tambien me gusta\b|\b(?:que te parece (?:si |que )?|y si )hagamos\b|\bhagamos algo con\b|\bme gusta(?: mucho)? (?:ella|el)\b|\bya lo sabes porque\b|\btu mismo le hiciste\b|\bya le invitaste\b|\bya la invitaste\b|\btu mismo sabes\b/.test(text);
}

export function conservativeAdviceFallback(query = '', intentKind = 'romantic_advice') {
  if (intentKind === 'medical_emergency') {
    const normQuery = normalize(query);
    if (/\b(sangr|caid|segundo piso|convulsion|desmayo|sobrinito)\b/.test(normQuery)) {
      return 'No le des nada mano, llévalo al hospital o a emergencia de una vez!';
    }
    return 'Anda a emergencias o al médico al toque pe, con eso no se juega.';
  }
  const normQuery = normalize(query);
  if (/\b(invit|comer|cafe|helado|regal|compr|plan|salid)\b/.test(normQuery)) {
    return 'Invítale un café o a comer algo tranqui, a ver qué tal.';
  }
  return 'Si te gusta, háblale tranqui y ve cómo va. No te apures.';
}
