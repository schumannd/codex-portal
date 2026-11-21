import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionResponse} from '../src/session-response.mjs';
test('waits for completion and returns final answer without progress commentary',async()=>{
 let observe,unsubscribed=false;
 const inputs=[{type:'localImage',path:'/image.png'},{type:'localAudio',path:'/voice.ogg'}];
 const engine={prompt:async(text,attached)=>{
  assert.equal(text,'wrapped');assert.deepEqual(attached,inputs);
  observe({method:'item/completed',params:{item:{type:'agentMessage',phase:'commentary',text:'Working…'}}});
  observe({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'Actual answer'}}});
  observe({method:'turn/completed',params:{turn:{status:'completed'}}});
 }};
 const result=await sessionResponse(engine,'wrapped',{inputs,subscribe:fn=>{observe=fn;return ()=>{unsubscribed=true;};}});
 assert.equal(result,'Actual answer');assert.ok(unsubscribed);
});
test('failed, disconnected and empty turns fail with subscriptions cleaned up',async()=>{
 for(const message of [{method:'turn/completed',params:{turn:{status:'failed'}}},{method:'portal/disconnected'},{method:'turn/completed',params:{turn:{status:'completed'}}}]) {
  let observe,clean=false;
  await assert.rejects(sessionResponse({prompt:async()=>observe(message)},'x',{subscribe:fn=>{observe=fn;return ()=>{clean=true;};}}));assert.ok(clean);
 }
});
