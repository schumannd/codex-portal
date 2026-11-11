import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramSender,telegramTools} from '../src/telegram-tools.mjs';
import {CodexSession} from '../src/codex.mjs';
import {resolve} from 'node:path';
test('send tool validates recipients, labels sender and waits for Telegram confirmation',async()=>{
 const sent=[],audit=[];const handler=createTelegramSender({sender:'David',recipients:{david:1,safiya:2},send:async(...args)=>{sent.push(args);return {message_id:7};},record:r=>audit.push(r)});
 const call=arguments_=>handler({tool:'send_telegram_message',arguments:arguments_,callId:'x'});
 assert.equal((await call({recipient:'stranger',text:'hi'})).success,false);assert.equal((await call({recipient:'safiya',text:''})).success,false);assert.equal(sent.length,0);
 const r=await call({recipient:'safiya',text:'David has an important message for you.'});assert.equal(r.success,true);assert.deepEqual(sent,[[2,'David says:\nDavid has an important message for you.']]);assert.equal(audit[0].messageId,7);
});
test('summary tools and failed sends cannot report successful delivery',async()=>{
 const request={tool:'send_telegram_message',arguments:{recipient:'david',text:'hi'}};
 const blocked=createTelegramSender({enabled:false,recipients:{david:1},send:()=>assert.fail()});assert.equal((await blocked(request)).success,false);
 const failed=createTelegramSender({recipients:{david:1},send:async()=>{throw Error('failure');}});assert.equal((await failed(request)).success,false);
});
test('app-server dynamic requests reach the configured tool handler',async()=>{
 let request;const events=[];
 const e=new CodexSession(process.cwd(),m=>events.push(m),resolve('test/fake-codex.mjs'),{dynamicTools:telegramTools,onToolCall:async r=>{request=r;return {success:true,contentItems:[{type:'inputText',text:'delivered'}]};}});
 try{await e.start(process.cwd());await e.prompt('[tool-test]');await new Promise(r=>setTimeout(r,70));assert.equal(request.tool,'send_telegram_message');assert.equal(events.find(m=>m.method==='test/tool-result').params.success,true);}finally{e.close();}
});
