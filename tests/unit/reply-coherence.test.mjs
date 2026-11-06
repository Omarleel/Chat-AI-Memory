import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplyService} from '../../src/app/reply-service.mjs';
import {formatCasualWhatsApp} from '../../src/domain/history.mjs';
import {OllamaClient} from '../../src/infra/ollama.mjs';

function fixture({recent = [], detailed = true, answer = 'Avísame cuando llegues', review = false} = {}) {
  const calls = [];
  let graphCalls = 0;
  const repository = {
    listChatImports: () => [{self: 'Alex', peer: 'Diego'}],
    listMemories: () => [], listStyles: () => ['dejate de excusas'],
    recent: () => recent, recentPreview: () => recent
  };
  const record = async (system, prompt, options) => {
    calls.push({system, prompt, options});
    return answer;
  };
  const llm = {embed: async () => [1], chat: record};
  if (detailed) llm.chatDetails = async (...args) => ({content: await record(...args)});
  const service = new ReplyService({repository, llm,
    historyStore: {search: async () => []},
    neo4j: {findRelated: async () => {graphCalls++; return []; }},
    config: {selfName: 'Alex', replyReview: review}});
  return {service, calls, graphCalls: () => graphCalls};
}

for (const detailed of [true, false]) {
  test(`conserva roles y no duplica el mensaje guardado por worker (chatDetails=${detailed})`, async () => {
    const incoming = 'Recien estoy por la ruy Guzmán';
    const {service, calls} = fixture({detailed, recent: [
      {side: 'outgoing', text: 'Baja ya'}, {side: 'incoming', text: incoming}
    ]});
    await service.generate('contact', incoming);
    assert.deepEqual(calls[0].options.messages.slice(1), [
      {role: 'assistant', content: 'Baja ya'}, {role: 'user', content: incoming}
    ]);
  });
}

test('contexto explícito vacío no hereda otra conversación', async () => {
  const {service, calls} = fixture({recent: [{side: 'self', text: 'tema ajeno'}]});
  await service.previewReply('contact', 'Hola', 'session', false, 'off', {recentMessages: []});
  assert.equal(calls[0].options.messages.length, 2);
  assert.doesNotMatch(calls[0].prompt, /tema ajeno/);
});

test('off y seguimientos tampoco consultan el grafo', async () => {
  const f = fixture({recent: [{side: 'self', text: 'No tengo plata'}]});
  await f.service.previewReply('contact', 'Valeria', 'session', false, 'off');
  await f.service.previewReply('contact', '¿Por qué?', 'session', false, 'force');
  assert.equal(f.graphCalls(), 0);
  await f.service.previewReply('contact', 'Valeria', 'session', false, 'force');
  assert.equal(f.graphCalls(), 1);
});

test('no inventa una relación sentimental para reemplazar una respuesta sobre fechas', async () => {
  const {service} = fixture({answer: 'No recuerdo cuando hablamos de eso'});
  const result = await service.previewReply('contact', 'te gusta Ana?', 'session', false, 'off');
  assert.equal(result.answer, 'No recuerdo cuando hablamos de eso');
});

test('revisor recibe el hilo y las mismas reglas de coherencia', async () => {
  const {service, calls} = fixture({review: true, recent: [{side: 'self', text: 'De andar haciendo delivery'}]});
  await service.previewReply('contact', 'Cuando supuestamente estaba con ella xd', 'session', false, 'off');
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /De andar haciendo delivery/);
  assert.match(calls[1].prompt, /dejate de excusas/);
  assert.match(calls[1].system, /No inventes ubicaciones/);
  assert.doesNotMatch(calls[1].system, /2 a 8 palabras/);
});

test('el formateador no convierte frases legítimas en órdenes de llegada', () => {
  assert.equal(formatCasualWhatsApp('Ese es su humor seco'), 'Ese es su humor seco');
});

test('perfil agregado evita frases ajenas y un hilo activo evita recuerdos por simple coincidencia', async () => {
  let searched = false;
  const service = new ReplyService({
    repository: {
      listChatImports: () => [{self: 'Alex', peer: 'Diego'}],
      getPersonas: () => ({self: {summary: 'Mensajes informales breves'}}),
      listStyles: () => {throw new Error('No insertar frases ajenas');},
      findRelevantStylePairs: () => {throw new Error('No insertar diálogos ajenos');},
      listMemories: () => []
    },
    historyStore: {search: async () => {searched = true; return []; }},
    llm: {embed: async () => [1], chat: async (system) => {
      assert.match(system, /Mensajes informales breves/);
      return 'Cuanto vas a cobrar?';
    }},
    config: {selfName: 'Alex', replyReview: true}
  });
  await service.previewReply('contact', 'Lo alquila cualquiera', 's', false, 'auto', {
    recentMessages: [{side: 'peer', text: 'Como es barato'}]
  });
  assert.equal(searched, false);
});

test('continuación de Ollama conserva el diálogo original y sus roles', async () => {
  const client = new OllamaClient({maxTokens: 40});
  const requests = [];
  client.request = async (_path, body) => {
    requests.push(body);
    return requests.length === 1
      ? {message: {content: 'Avisa cuando'}, done_reason: 'length'}
      : {message: {content: 'llegues'}, done_reason: 'stop'};
  };
  const messages = [{role: 'system', content: 'reglas'}, {role: 'assistant', content: 'Baja ya'},
    {role: 'user', content: 'Estoy en camino'}];
  await client.chatDetails('fallback', 'otro contexto', {messages});
  assert.deepEqual(requests[1].messages.slice(0, 3), messages);
});

// La limpieza de respuestas no debe depender del nombre de una persona fija.
test('retira la etiqueta del titular configurado al generar un borrador', async () => {
  const {service}=fixture({answer:'Alex: oe ya fue'});
  const result=await service.previewReply('contact', 'Hola', 'session', false, 'off');
  assert.equal(result.answer, 'oe ya fue');
});
