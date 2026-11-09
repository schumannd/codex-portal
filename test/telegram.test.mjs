import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {authorizedMessage,openTelegramStore,rotationDue} from '../src/telegram-store.mjs';
import {chunks,mergeMemory} from '../src/telegram.mjs';
const users=new Map([[1,'tg-david'],[2,'tg-saf']]);
const update=(id,user=1,type='private')=>({update_id:id,message:{from:{id:user},chat:{id:user,type},text:'hello'}});
test('Telegram permits only the two approved users in private chats',()=>{
 assert.ok(authorizedMessage(update(1),users));
 assert.equal(authorizedMessage(update(2,3),users),null);
 assert.equal(authorizedMessage(update(3,1,'group'),users),null);
 const spoof=update(4);spoof.message.chat.id=2;assert.equal(authorizedMessage(spoof,users),null);
});
test('durable inbox deduplicates updates, resumes work, and separates sessions and memory',()=>{
 const dir=mkdtempSync(join(tmpdir(),'telegram-test-'));let s=openStore(dir);
 try {
 let tg=openTelegramStore(s,users);tg.ingest([update(10),update(11,2),update(12,3)]);tg.ingest([update(10)]);
 assert.equal(tg.pending().length,2);assert.equal(tg.offset(),13);
 const a=tg.sessionFor(1),b=tg.sessionFor(2);assert.notEqual(a.account,b.account);assert.notEqual(a.session,b.session);
 s.run("UPDATE telegram_inbox SET status='running' WHERE id=10");s.db.close();s=openStore(dir);tg=openTelegramStore(s,users);
 assert.equal(tg.pending().find(j=>j.id===10).status,'pending');
 tg.commitMemory(1,'David fact\n');assert.equal(tg.state(2).memory,'');assert.equal(readFileSync(tg.exportMemory(1),'utf8'),'David fact\n');
 assert.equal(s.get('SELECT closed FROM sessions WHERE id=?',a.session).closed,1);assert.notEqual(tg.sessionFor(1).session,a.session);
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('automatic rotation requires both configured conditions',()=>{
 const s={session:'x',messages:5,lastMessage:100};assert.equal(rotationDue(s,200,50,5),true);assert.equal(rotationDue(s,120,50,5),false);assert.equal(rotationDue(s,200,50,6),false);assert.equal(rotationDue(s,200,0,5),false);
});
test('memory appends until exceeding 2000 lines, then requires a summary of at most 100 lines',async()=>{
 assert.equal(await mergeMemory('old','new',()=>assert.fail()),'old\n\nnew\n');
 let called=false;const result=await mergeMemory('fact\n'.repeat(2000),'new',async text=>{called=true;assert.ok(text.includes('new'));return 'compressed';});assert.ok(called);assert.equal(result,'compressed\n');
 await assert.rejects(mergeMemory('fact\n'.repeat(2000),'new',async()=>('too long\n'.repeat(101))),/1–100/);
});
test('Telegram reply chunks retain Unicode characters',()=>{const text='a😀'.repeat(3000);const parts=chunks(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=3500&&!/[\uD800-\uDBFF]$/.test(p)));});
