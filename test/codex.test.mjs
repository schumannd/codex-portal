import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {CodexSession} from '../src/codex.mjs';
test('initializes, starts and resumes a thread, sends prompts and receives events',async()=>{
 const events=[];const e=new CodexSession(process.cwd(),m=>events.push(m),resolve('test/fake-codex.mjs'));
 try {
 assert.equal(await e.start(process.cwd()),'test-thread');
 assert.equal((await e.prompt('hello')).turn.id,'turn');
 await new Promise(r=>setTimeout(r,50));
 assert.equal(Object.hasOwn(events.find(m=>m.method==='test/prompt').params,'effort'),false);
 assert.ok(events.some(m=>m.method==='item/agentMessage/delta'&&m.params.delta==='hello'));
 assert.ok(events.some(m=>m.method==='turn/completed'));
 }finally{e.close();}
 const resumedEvents=[];
 const resumed=new CodexSession(process.cwd(),m=>resumedEvents.push(m),resolve('test/fake-codex.mjs'));
 try {
   assert.equal(await resumed.start(process.cwd(),'saved-thread'),'saved-thread');
   await resumed.prompt('continue', [], 'high');
   const {threadId,effort}=resumedEvents.find(m=>m.method==='test/prompt').params;
   assert.equal(threadId,'saved-thread');
   assert.equal(effort,'high');
 } finally {resumed.close();}
});
test('failed subprocess rejects initialization',async()=>{
 const e=new CodexSession(process.cwd(),()=>{},'/no/such/codex');
 await assert.rejects(e.ready,/ENOENT/);e.close();
});
