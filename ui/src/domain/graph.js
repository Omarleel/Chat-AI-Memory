// Vocabulario del grafo para la interfaz (coincide con src/domain/knowledge-graph.mjs del motor).
export const RELATION_LABELS = {
  VIVE_EN: 'vive en', TRABAJA_EN: 'trabaja en', ESTUDIA_EN: 'estudia en', LE_GUSTA: 'le gusta', NO_LE_GUSTA: 'no le gusta',
  TIENE: 'tiene', COMPRO: 'compró', VENDIO: 'vendió', DEBE_A: 'debe a', PRESTO_A: 'prestó a', FAMILIAR_DE: 'familiar de',
  PAREJA_DE: 'pareja de', AMIGO_DE: 'amigo de', CONOCE_A: 'conoce a', CUMPLEANOS: 'cumpleaños', VIAJO_A: 'viajó a',
  ASISTIO_A: 'asistió a', PLANEA: 'planea', SALUD: 'salud', OCURRIO: 'le ocurrió', PREFIERE: 'prefiere'
};
export const relationLabel = r => RELATION_LABELS[r] ?? String(r).toLowerCase().replace(/_/g, ' ');
export const EXTRACTION_STATES = {idle: ['Sin empezar', 'slate'], running: ['En curso', 'blue'], paused: ['En pausa', 'amber'],
  done: ['Completada', 'green'], failed: ['Fallida', 'red']};

// Estimación del tiempo restante a partir del ritmo medido (ms por mensaje recorrido).
export function remainingMs({processedMessages, totalMessages, elapsedMs}) {
  if (!processedMessages || !elapsedMs || processedMessages >= totalMessages) return null;
  return Math.round((elapsedMs / processedMessages) * (totalMessages - processedMessages));
}

// Disposición radial para dibujar una entidad y sus vecinos sin dependencias.
export function radialLayout(count, {cx = 200, cy = 160, r = 120} = {}) {
  return Array.from({length: count}, (_, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, count) - Math.PI / 2;
    return {x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a))};
  });
}
