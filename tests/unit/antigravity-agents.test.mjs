import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeAntigravityAgent, agyEnvironment, parseModelsListing, chooseModel, parseAgyAgentOutput } from '../../src/agents/antigravity-cli.mjs';
import { createSupervisor } from '../../src/agents/supervisor.mjs';
import { createProgrammer } from '../../src/agents/programmer.mjs';

const MODELS = `modelo-beta-medium   Modelo Beta (Medium)\nmodelo-alfa-thinking   Modelo Alfa (Thinking)\n`;
test('Antigravity obtiene slugs por agy models, sin inventarlos',()=>{
  const models=parseModelsListing(MODELS);
  assert.equal(chooseModel('Modelo Alfa',models),'modelo-alfa-thinking');
  assert.equal(chooseModel('modelo-beta-medium',models),'modelo-beta-medium');
  assert.throws(()=>chooseModel('modelo inexistente',models),/no disponible/);
});
test('Antigravity no hereda secretos del proceso',()=>{
  const env=agyEnvironment({PATH:'/usr/bin',HOME:'/tmp/user',ADMIN_TOKEN:'TOP_SECRET',
    WA_ACCESS_TOKEN:'ANOTHER_SECRET',PROVIDER_API_KEY:'NEVER_SEND'});
  assert.equal(env.PATH,'/usr/bin');
  assert.equal(env.HOME,'/tmp/user');
  assert.equal(Object.keys(env).length,2);
});
test('Antigravity invoca perfiles, modelo fijado, esquema y sandbox en directorio temporal',async()=>{
  let checked=false;
  const runner=async(args,opts)=>{
    if(args[0]==='models')return {stdout:MODELS};
    assert.ok(opts.cwd.includes('chat-ai-agy-'));
    await access(join(opts.cwd,'.agents','agents','supervisor','agent.md'));
    assert.ok(args.includes('--sandbox'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.equal(args[args.indexOf('--model')+1],'modelo-alfa-thinking');
    assert.equal(args[args.indexOf('--agent')+1],'supervisor');
    assert.ok(args.includes('--json-schema'));
    const prompt=args[args.indexOf('-p')+1];
    assert.match(prompt,/EVIDENCIA ESTRUCTURADA/);
    checked=true;
    return {stdout:JSON.stringify({status:'SUCCESS',structured_output:{action:'stop',diagnosis:'ok',hypothesis:'',researchQuery:'',justification:'done'}})};
  };
  const run=makeAntigravityAgent({role:'supervisor',model:'modelo-alfa-thinking',runner});
  const value=await run('Instrucciones',{round:1});
  assert.equal(value.action,'stop');assert.equal(checked,true);
});
test('Antigravity no acepta status de error ni salida sin estructura',async()=>{
  const runner=async(args)=>args[0]==='models'?{stdout:MODELS}:
    {stdout:JSON.stringify({status:'WAITING',response:'{}'})};
  const run=makeAntigravityAgent({role:'programmer',model:'modelo-beta-medium',runner});
  await assert.rejects(run('instructions',{}),/ejecución sin éxito/);
});
test('supervisor y programador reciben solo evidencia reducida, sin transcripciones',async()=>{
  const secret='SECRET_QUOTE_FROM_WHATSAPP';
  const state={objective:secret,cycles:1,instruction:{hypothesis:'less context'},
    datasetSha256:'testhash',baselineSettings:{model:'local',temperature:0.2,
      replyMaxTokens:200,replyReview:false,semanticRouter:false},
    report:{status:'ok',baseline:{count:12,overall:3,dimensions:{coherence:3}},
      candidate:{count:12,overall:4,dimensions:{coherence:4}},gate:{accepted:false,reasons:[secret]}},
    history:[{id:'x',status:'evaluated',hypothesis:secret,report:{status:'error',errors:[secret]}}],
    papers:[{title:'Scientific paper',abstract:secret}],failures:[{judgeComment:secret,id:secret,continuityGain:-1}],
    objection:secret};
  const sup=createSupervisor(async (_prompt,payload)=>{
    assert.ok(!JSON.stringify(payload).includes(secret));
    return {action:'stop',diagnosis:'ok',hypothesis:'',researchQuery:'',justification:'end'};
  });
  await sup(state);
  const prog=createProgrammer(async (_prompt,payload)=>{
    assert.ok(!JSON.stringify(payload).includes(secret));
    return {action:'challenge',reason:'different approach',hypothesis:'another'};
  });
  await prog(state);
});

test('Antigravity acepta tablas con TAB, separación simple y códigos ANSI',()=>{
  const listing=parseModelsListing('\x1b[36mmodelo-alfa-thinking\x1b[0m\tModelo Alfa (Thinking)\n'
    +'modelo-beta-high Modelo Beta (High)\n');
  assert.deepEqual(listing.map(x=>x.slug),['modelo-alfa-thinking','modelo-beta-high']);
  assert.equal(chooseModel('modelo-alfa-thinking',listing),'modelo-alfa-thinking');
});
test('Antigravity puede encontrar los modelos publicados en stderr',async()=>{
  const runner=async args=>{
    if(args[0]==='models') return {stdout:'',stderr:MODELS};
    return {stdout:JSON.stringify({status:'SUCCESS',structured_output:{action:'stop',diagnosis:'ok',hypothesis:'',researchQuery:'',justification:'done'}})};
  };
  const invoke=makeAntigravityAgent({role:'supervisor',model:'modelo-alfa-thinking',runner});
  const result=await invoke('Prueba',{});
  assert.equal(result.action,'stop');
});


test('Antigravity acepta response JSON con bloque Markdown cuando structured_output no existe', async()=>{
  const result={action:'stop',diagnosis:'ok',hypothesis:'',researchQuery:'',justification:'done'};
  const runner=async(args)=>args[0]==='models'
    ? {stdout:MODELS}
    : {stdout:JSON.stringify({status:'SUCCESS',response:`\`\`\`json\n${JSON.stringify(result,null,2)}\n\`\`\`\nComentario posterior del agente o artefacto.`})};
  const call=makeAntigravityAgent({role:'supervisor',model:'modelo-alfa-thinking',runner});
  assert.deepEqual(await call('Instrucciones',{}),result);
});

test('Antigravity también admite structured_output objeto o string JSON',()=>{
  const decision={action:'challenge',reason:'Enfoque duplicado',hypothesis:'Cambiar contexto'};
  assert.deepEqual(parseAgyAgentOutput({status:'SUCCESS',structured_output:decision,
    response:'Respuesta libre que no se debe interpretar'},'programmer'),decision);
  assert.deepEqual(parseAgyAgentOutput({status:'SUCCESS',structured_output:JSON.stringify(decision)},'programmer'),decision);
  assert.deepEqual(parseAgyAgentOutput({status:'SUCCESS',response:`  \`\`\`JSON\r\n${JSON.stringify(decision)}\r\n\`\`\`  `},'programmer'),decision);
  assert.deepEqual(parseAgyAgentOutput({status:'SUCCESS',response:JSON.stringify(decision)},'programmer'),decision);
});

test('Antigravity rechaza texto mezclado, múltiples bloques, arrays y respuestas vacías',()=>{
  const obj='{"action":"stop"}';
  for(const response of [
    `Aquí tienes:\n\`\`\`json\n${obj}\n\`\`\``,
    `\`\`\`json\n${obj}\n\`\`\`\n\`\`\`json\n${obj}\n\`\`\``,
    '[]', 'null', '', 'texto arbitrario'
  ]) {
    assert.throws(()=>parseAgyAgentOutput({status:'SUCCESS',response},'supervisor'),/JSON|objeto/);
  }
  const secret='PRIVADO_NO_MOSTRAR';
  assert.throws(()=>parseAgyAgentOutput({status:'SUCCESS',response:secret},'programmer'),err=>{
    assert.ok(!err.message.includes(secret));
    return true;
  });
});
