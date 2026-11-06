import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator } from '../../src/lab/conversation-simulator.mjs';

test('offline replay invokes the real ReplyService and leaves no storage side effects',async()=>{
  const calls=[];
  const generator=await createGenerator({
    settings:{model:'dummy:1',temperature:0.18,replyMaxTokens:130,
      replyReview:false,semanticRouter:false},
    clientFactory:()=>({chatModel:'dummy:1',chatDetails:async(_system,_user,options)=>{
      calls.push(options);
      return {content:'ya bro, listo',truncated:false};
    }})
  });
  const answer=await generator('¿Vas a venir?',[]);
  assert.equal(answer,'ya bro, listo');
  assert.equal(calls.length,1);
  assert.equal(calls[0].maxTokens,130);
});
