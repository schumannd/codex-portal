import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {openStore} from '../src/store.mjs';
import {callMessageApi} from '../src/message-api.mjs';
import {openTelegramStore} from '../src/telegram-store.mjs';

test('portal process receives media through its local API and runs an app-server turn',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'portal-media-'));let child;
 try {
 const store=openStore(dir),tg=openTelegramStore(store,new Map([[1,'tg-david'],[2,'tg-saf']])),state=tg.sessionFor(1);store.db.close();
 const socketPath=join(dir,'local.sock');
 child=spawn(process.execPath,['src/server.mjs'],{cwd:resolve('.'),env:{...process.env,PORT:'0',DATA_DIR:dir,LLM_API_SOCKET:socketPath,CODEX_BIN:resolve('test/fake-codex.mjs')},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',data=>{logs+=data;});child.stderr.on('data',()=>{});
 for(let i=0;i<100&&!logs.includes('listening');i++){if(child.exitCode!==null)throw Error('Portal exited');await new Promise(r=>setTimeout(r,20));}
 assert.ok(logs.includes('listening'),'portal started');
 const body={session:state.session,requestId:'telegram-real-http',text:'What do you see and hear?',source:'telegram',metadata:{message_id:10},files:[{name:'voice.ogg',type:'voice',mimeType:'audio/ogg',base64:Buffer.from('sample audio').toString('base64')},{name:'photo.jpg',type:'photo',mimeType:'image/jpeg',base64:Buffer.from('sample image').toString('base64')}]};
 const result=await callMessageApi(body,{socketPath,timeout:10000});assert.equal(result.response,'hello');
 const metadata=JSON.parse(readFileSync(join(result.folder,'metadata.json')));assert.equal(metadata.files.length,2);
 assert.equal(readFileSync(metadata.files[0].path,'utf8'),'sample audio');
 assert.deepEqual(await callMessageApi({session:state.session,requestId:body.requestId,resume:true},{socketPath}),result);
 const check=openStore(dir);
 try {
 const event=check.all('SELECT payload FROM events WHERE session=?',state.session).map(r=>JSON.parse(r.payload)).find(e=>e.method==='test/prompt');
 assert.ok(event.params.input[0].text.includes(metadata.files[0].path));
 assert.deepEqual(event.params.input.slice(1),[{type:'localAudio',path:metadata.files[0].path},{type:'localImage',path:metadata.files[1].path}]);
 }finally{check.db.close();}
 }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}rmSync(dir,{recursive:true,force:true});}
});

test('complete Telegram bot -> local LLM API -> archived media -> session -> Telegram response flow',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'telegram-roundtrip-'));let portal,bot;
 try {
 const socketPath=join(dir,'roundtrip.sock');
 const env={...process.env,PORT:'0',DATA_DIR:dir,LLM_API_SOCKET:socketPath,CODEX_BIN:resolve('test/fake-codex.mjs'),TELEGRAM_TOKEN:'fake-token',TELEGRAM_DAVID_ID:'1',TELEGRAM_SAF_ID:'2',TELEGRAM_IDLE_MINUTES:'0',TELEGRAM_MIN_MESSAGES:'0'};
 portal=spawn(process.execPath,['src/server.mjs'],{env,stdio:['ignore','pipe','pipe']});let logs='';portal.stdout.on('data',data=>{logs+=data;});portal.stderr.on('data',()=>{});
 for(let i=0;i<100&&!logs.includes('listening');i++)await new Promise(r=>setTimeout(r,20));assert.ok(logs.includes('listening'));
 bot=spawn(process.execPath,['test/fake-telegram.mjs'],{env,stdio:['ignore','ignore','pipe']});let errors='';bot.stderr.on('data',data=>{errors+=data;});
 const timeout=setTimeout(()=>bot.kill('SIGKILL'),15000);const [code]=await once(bot,'exit');clearTimeout(timeout);
 assert.equal(code,0,errors);
 const replies=JSON.parse(readFileSync(join(dir,'fake-deliveries.json')));
 const {edited,documents}=JSON.parse(readFileSync(join(dir,'fake-attachments.json')));
 assert.deepEqual(replies[0],{chat_id:1,text:'rebooted!'});
 assert.equal([...replies,...edited].filter(r=>r.text==='hello'&&r.chat_id===1).length,10);
 const progress=replies.filter(reply=>reply.reply_parameters?.message_id===12);
 assert.equal(progress.length,1);
 assert.match(progress[0].text,/Running a command/);
 const statusID=101+replies.indexOf(progress[0]);
 const updates=edited.filter(edit=>edit.message_id===statusID);
 assert.ok(updates.some(edit=>edit.text.startsWith('Running a command')&&edit.text!==progress[0].text));
 assert.equal(updates.at(-1).text,'Attachment ready');
 assert.deepEqual(documents,[{name:'report.txt',bytes:'generated attachment',chat:'1',reply:{message_id:12,allow_sending_without_reply:true}}]);
 const store=openStore(dir);
 try {
 const rows=store.all('SELECT * FROM message_requests ORDER BY requestId');assert.equal(rows.length,11);assert.equal(rows.filter(r=>r.response==='hello').length,10);
 const voice=rows.find(r=>r.requestId==='telegram-1');assert.equal(JSON.parse(readFileSync(join(voice.folder,'metadata.json'))).files[0].type,'voice');
 const album=rows.find(r=>r.requestId==='telegram-9');const meta=JSON.parse(readFileSync(join(album.folder,'metadata.json')));assert.equal(meta.files.length,2);assert.equal(meta.telegram.updates.length,2);assert.equal(meta.text,'Compare these');
 assert.equal(store.get("SELECT count(*) AS n FROM telegram_inbox WHERE status='done'").n,12);
 const reply=rows.find(r=>r.requestId==='telegram-11');const quoted=JSON.parse(readFileSync(join(reply.folder,'metadata.json')));assert.equal(quoted.files[0].telegram.replyToMessageId,1);assert.equal(quoted.telegram.repliedTo[0].messageId,1);
 assert.equal(store.get('SELECT text FROM telegram_inbox WHERE id=5').text,'/new'); // caption is user content, never a bot command
 }finally{store.db.close();}
 }finally{for(const child of [bot,portal])if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}rmSync(dir,{recursive:true,force:true});}
});
