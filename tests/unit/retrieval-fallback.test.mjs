import test from 'node:test';
import assert from 'node:assert/strict';
import {RetrievalService} from '../../src/app/retrieval-service.mjs';

// Regresión: si ninguna entidad aparece literalmente, el respaldo debe usar la similitud densa.
test('conserva evidencia densa aunque las entidades no aparezcan literalmente',async()=>{
  const hit={body:'Dani: Alex, te debo 40 por las entradas.',messageIds:['m1'],score:0.9};
  const weak={body:'Dani: mañana llueve',messageIds:['m2'],score:0.1};
  const service=new RetrievalService({repository:{searchByTerms:()=>[]},
    historyStore:{search:async()=>[hit,weak]},llm:{embed:async()=>[1]},config:{llmRerank:false}});
  const found=await service.search({contact:'c',question:'Entonces tú me debes los 40?',entities:['deuda'],limit:3});
  assert.deepEqual(found.results.map(r=>r.messageIds[0]),['m1']);
});
