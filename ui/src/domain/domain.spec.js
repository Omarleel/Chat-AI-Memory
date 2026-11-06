import {describe, expect, it} from 'vitest';
import {detectAuthors} from './chat-export.js';
import {calibrationVerdict, groupSourcesByOwner, modelNameError, modelTag} from './training.js';
import {isValidPhone, normalizePhone} from './contacts.js';
import {formatBytes} from './format.js';

describe('dominio de la UI', () => {
  it('detecta autores en exportaciones de WhatsApp con y sin corchetes', () => {
    const txt = ['30/5/2023, 9:19 a. m. - Diego Ruiz: hola', '30/5/2023, 9:20 a. m. - Alex: qué tal',
      '30/5/2023, 9:21 a. m. - Diego Ruiz: bien', '[01/01/24, 10:00:05] Ana: hey', 'línea continuada sin cabecera'].join('\n');
    expect(detectAuthors(txt)).toEqual([{name: 'Diego Ruiz', messages: 2}, {name: 'Alex', messages: 1}, {name: 'Ana', messages: 1}]);
  });
  it('valida nombres de modelo y evita pisar los activos', () => {
    expect(modelNameError('Juan')).toBeNull();
    expect(modelNameError('j')).toMatch(/caracteres/);
    expect(modelNameError('estilo', ['estilo:q4'])).toMatch(/activo/);
    expect(modelTag('Juan', 'q8_0')).toBe('juan:q8');
  });
  it('agrupa fuentes por titular sin distinguir mayúsculas', () => {
    const groups = groupSourcesByOwner([{self: 'Juan', contact: '1'}, {self: 'juan', contact: '2'}, {self: 'Ana', contact: '3'}]);
    expect(groups.map(g => g.sources.length)).toEqual([2, 1]);
  });
  it('normaliza teléfonos y tamaños', () => {
    expect(normalizePhone('+51 999-999-999')).toBe('51999999999');
    expect(isValidPhone('123')).toBe(false);
    expect(formatBytes(5.1 * 1024 ** 3)).toBe('5.1 GB');
  });
});

describe('grafo en la UI', async () => {
  const {radialLayout, relationLabel, remainingMs} = await import('./graph.js');
  it('estima el tiempo restante y etiqueta relaciones', () => {
    expect(remainingMs({processedMessages: 100, totalMessages: 300, elapsedMs: 1000})).toBe(2000);
    expect(remainingMs({processedMessages: 0, totalMessages: 300, elapsedMs: 0})).toBeNull();
    expect(relationLabel('DEBE_A')).toBe('debe a');
    expect(relationLabel('NUEVA_COSA')).toBe('nueva cosa');
    expect(radialLayout(4)[0]).toEqual({x: 200, y: 40});
  });
});

describe('duraciones', async () => {
  const {formatDuration} = await import('./format.js');
  it('usa minutos y horas para tiempos largos', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_300)).toBe('12.3 s');
    expect(formatDuration(3_560_100)).toBe('59 min');
    expect(formatDuration(4_000_000)).toBe('1 h 7 min');
  });
  it('interpreta la calibración del revisor', () => {
    expect(calibrationVerdict(null).kind).toBe('info');
    expect(calibrationVerdict({state: 'running'})).toBeNull();
    expect(calibrationVerdict({state: 'done', realApprovalRate: 0.5, reliable: false})).toMatchObject({kind: 'warning'});
    expect(calibrationVerdict({state: 'done', realApprovalRate: 0.9, reliable: true}).text).toMatch(/90 %/);
  });
});
