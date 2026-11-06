import { OllamaClient } from '../infra/ollama.mjs';
export function makeAgent(model) {
  if (!model || !/^[a-zA-Z0-9._:/-]{1,100}$/.test(model)) throw new Error('Modelo de agente inválido');
  const llm = new OllamaClient({
    baseUrl: process.env.LAB_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    chatModel:model, modelContext:8192, maxTokens:1400, temperature:0.15
  });
  return async (system, data) => {
    let lastError;
    for (let attempt=0; attempt<2; attempt++) {
      const response = await llm.chatDetails(system, JSON.stringify(data), {
        format:'json',temperature:0.1,maxTokens:1400,allowContinuation:false
      });
      try {
        const parsed=JSON.parse(response.content.replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim());
        if(parsed && typeof parsed==='object' && !Array.isArray(parsed))return parsed;
        throw new Error('Se esperaba un objeto JSON');
      } catch(e) {lastError=e;}
    }
    throw new Error(`El agente ${model} no devolvió JSON válido: ${lastError?.message}`);
  };
}
