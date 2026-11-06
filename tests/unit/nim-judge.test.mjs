import test from 'node:test';
import assert from 'node:assert/strict';
import { createNimJudgeClient, validateNimJudgeConfiguration } from '../../src/lab/nim-judge-client.mjs';
import { createJudge } from '../../src/lab/persona-judge.mjs';

const model='meta/llama-3.3-70b-instruct';
const ok={model,apiKey:'nvapi-test-key',consent:'YES'};
const perfect={coherence:5,continuity:5,behavior:5,language:5,factuality:5,naturalness:5,reason:'ok'};

test('NIM requires a key and explicit consent before sending any private data',()=>{
  assert.throws(()=>validateNimJudgeConfiguration({...ok,apiKey:''}),/NVIDIA_API_KEY/);
  assert.throws(()=>validateNimJudgeConfiguration({...ok,consent:'NO'}),/LAB_JUDGE_REMOTE_CONSENT/);
  assert.throws(()=>validateNimJudgeConfiguration({...ok,baseUrl:'http://example.com/v1'}),/HTTPS/);
  assert.equal(validateNimJudgeConfiguration({...ok}).baseUrl,'https://integrate.api.nvidia.com/v1');
});

test('NIM judge sends OpenAI-compatible chat request, without leaking API key in report',async()=>{
  const calls=[];
  const client=createNimJudgeClient({...ok,fetchImpl:async(url,opts)=>{
    calls.push({url,opts});
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({A:perfect,B:perfect})},finish_reason:'stop'}]})};
  }});
  const judge=createJudge({model,provider:'nim',client});
  const result=await judge({id:'test-1',context:[],candidateContext:[],input:'hola',reference:'oe',baseline:'hola',candidate:'oe'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(calls[0].opts.headers.Authorization,'Bearer nvapi-test-key');
  const payload=JSON.parse(calls[0].opts.body);
  assert.equal(payload.model,model);
  assert.equal(payload.messages[1].role,'user');
  assert.equal(payload.stream,false);
  assert.equal(result.candidate.language,5);
  assert.doesNotMatch(JSON.stringify(result),/nvapi-test-key/);
});

test('NIM errors do not echo secret response bodies or credential',async()=>{
  const client=createNimJudgeClient({...ok,fetchImpl:async()=>({ok:false,status:401,text:async()=> 'secret transcript'} )});
  await assert.rejects(()=>client.chatDetails('s','u'),err=>{
    assert.match(err.message,/HTTP 401/);
    assert.doesNotMatch(err.message,/secret transcript|nvapi-test-key/);
    return true;
  });
});
