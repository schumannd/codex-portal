import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore} from '../src/store.mjs';import {openTelegramStore} from '../src/telegram-store.mjs';import {createAgentTools,contactNotes} from '../src/agent-tools.mjs';
test('shared agent reads bot replies, edits a tracked delivery and persists cross-chat instructions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-tool-'));const store=openStore(dir);const recipients={david:1,safiya:2},calls=[];
 try{const tg=openTelegramStore(store,new Map([[1,'tg-david'],[2,'tg-saf']]));tg.ingest([{update_id:10,message:{from:{id:2},chat:{type:'private',id:2},text:'What is the message?',message_id:30,date:100,reply_to_message:{message_id:20}}}]);
 const handler=createAgentTools({store,cwd:dir,recipients,viewer:'david',api:async(method,body)=>{calls.push({method,body});return {message_id:20};}});
 let r=await handler({tool:'read_telegram_messages',arguments:{contact:'safiya'}});let data=JSON.parse(r.contentItems[0].text);assert.equal(data.incoming[0].text,'What is the message?');assert.equal(data.incoming[0].replyToMessageId,20);
 await handler({tool:'send_telegram_message',arguments:{recipient:'safiya',text:'hello'}});
 r=await handler({tool:'edit_telegram_message',arguments:{contact:'safiya',messageId:20,text:'corrected'}});assert.equal(r.success,true);assert.equal(calls.at(-1).method,'editMessageText');assert.equal(store.get('SELECT text FROM telegram_deliveries WHERE messageId=20').text,'corrected');
 await handler({tool:'save_contact_note',arguments:{contact:'safiya',text:'If asked about the message, David says he loves you.'}});assert.equal(contactNotes(store,'safiya').length,1);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('read permission is explicit; untracked edits and all summary tools are rejected',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-tool-'));const store=openStore(dir);try{openTelegramStore(store,new Map([[1,'tg-david'],[2,'tg-saf']]));const options={store,cwd:dir,recipients:{david:1,safiya:2},api:()=>assert.fail()};
 const saf=createAgentTools({...options,viewer:'safiya'});assert.equal((await saf({tool:'read_telegram_messages',arguments:{contact:'david'}})).success,false);
 const david=createAgentTools({...options,viewer:'david'});assert.equal((await david({tool:'edit_telegram_message',arguments:{contact:'safiya',messageId:123,text:'x'}})).success,false);
 const summary=createAgentTools({...options,viewer:'david',enabled:false});assert.equal((await summary({tool:'save_contact_note',arguments:{contact:'safiya',text:'x'}})).success,false);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
