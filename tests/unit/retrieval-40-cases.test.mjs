// Banco de 40 casos sintéticos para regresión del índice BM25/FTS5.
// No es una medición de fidelidad humana ni reemplaza una evaluación con Ollama/Qdrant.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteRepository} from '../../src/infra/sqlite-repository.mjs';

const contact='51988888888';
const scenarios=[
 'cumpleaños','viaje','universidad','trabajo','consola','estudios','bicicleta','mascota','música','película',
 'comida','restaurante','fútbol','concierto','cita','amistad','mudanza','examen','negocio','familia',
 'vacaciones','playa','parque','escuela','lectura','proyecto','juego','entrenamiento','salud','receta',
 'regalo','reunión','compra','reparación','clases','pintura','autobús','horario','teléfono','cámara'
];

test('40 casos sintéticos con procedencia exacta e aislamiento',async t=>{
 const repo=new SqliteRepository(':memory:');
 try{
  const messages=scenarios.map((topic,i)=>({id:`source-${i}`,ordinal:i,role:i%2?'self':'peer',
    author:i%2?'Ana':'Luis',isoTimestamp:`2026-02-${String(1+i%28).padStart(2,'0')}T12:00:00`,
    rawTimestamp:`${String(1+i%28).padStart(2,'0')}/02/2026 12:00`,
    text:`El tema específico es ${topic} y su código único es referencia${i}zz` }));
  repo.saveImportedMessages(contact,'historical',messages);
  for(const [i,topic] of scenarios.entries()){
   await t.test(`${i+1}/40: consulta ${topic}`,()=>{
    const results=repo.searchByTerms(contact,[`referencia${i}zz`],3);
    assert.equal(results[0]?.messageIds[0],`source-${i}`);
    assert.equal(repo.searchByTerms('51911111111',[`referencia${i}zz`]).length,0);
   });
  }
 }finally{repo.close();}
});
