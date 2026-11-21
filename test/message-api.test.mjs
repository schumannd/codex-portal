import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {archiveMessage,initializeMessageApi,messagePrompt,nativeMediaInputs,listenMessageApi,callMessageApi} from '../src/message-api.mjs';
import {forwardTelegramMessage,telegramMedia,downloadTelegramFile,MediaDownloadError} from '../src/telegram-media.mjs';
import {openTelegramStore,nextTelegramBatch} from '../src/telegram-store.mjs';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'media-api-')),store=openStore(dir),tg=openTelegramStore(store,new Map([[1,'tg-david'],[2,'tg-saf']])),state=tg.sessionFor(1);
 initializeMessageApi(store);
 return {dir,store,tg,state,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
const file=(name,type,bytes='original bytes')=>({name,type,mimeType:type==='voice'?'audio/ogg':type==='photo'?'image/jpeg':'video/mp4',base64:Buffer.from(bytes).toString('base64')});
const update=(id,fields={})=>({update_id:id,message:{from:{id:1},chat:{id:1,type:'private'},date:1700000000,message_id:id,...fields}});

test('archives originals with timestamp, metadata, private permissions, and safe unique filenames',()=>{
 const f=fixture();try{
 const result=archiveMessage(f.store,{session:f.state.session,requestId:'one',text:'Look at these',files:[file('../../clip.mp4','video'),file('../../clip.mp4','video')],metadata:{updates:[update(1)]},source:'telegram'});
 assert.match(result.folder,/messages\/\d{4}-\d\d-\d\dT/);
 const metadata=JSON.parse(readFileSync(join(result.folder,'metadata.json')));
 assert.equal(metadata.telegram.updates[0].message.message_id,1);assert.equal(metadata.text,'Look at these');
 assert.equal(metadata.files.length,2);assert.notEqual(metadata.files[0].path,metadata.files[1].path);
 for(const attachment of metadata.files){assert.ok(attachment.path.startsWith(result.folder+'/'));assert.equal(readFileSync(attachment.path,'utf8'),'original bytes');assert.equal(statSync(attachment.path).mode&0o777,0o600);}
 assert.equal(f.store.all('SELECT * FROM uploads WHERE session=?',f.state.session).length,2);
 assert.deepEqual(JSON.parse(readFileSync(join(result.folder,'medadata.json'))),metadata);
 const prompt=messagePrompt(metadata);assert.ok(prompt.includes(metadata.files[0].path));assert.ok(prompt.includes('Look at these'));assert.ok(prompt.includes('metadata.json'));
 }finally{f.close();}
});
test('validates payloads and isolates session archives',()=>{
 const f=fixture();try{
 const body={session:f.state.session,requestId:'one',text:'hi',files:[]};
 assert.throws(()=>archiveMessage(f.store,{...body,session:'../../outside'}),/identity/);
 assert.throws(()=>archiveMessage(f.store,{...body,files:[{name:'bad',base64:'!!!'}]}),/Invalid file/);
 assert.throws(()=>archiveMessage(f.store,{...body,files:[{name:'bad',base64:'a='}]}),/encoding/);
 assert.throws(()=>archiveMessage(f.store,{...body,files:Array(21).fill(file('x','photo'))}),/Invalid message/);
 const a=archiveMessage(f.store,body),other=f.tg.sessionFor(2),b=archiveMessage(f.store,{...body,session:other.session});assert.notEqual(a.folder,b.folder);
 }finally{f.close();}
});
test('resuming a message reads its original archive metadata from SQLite',()=>{
 const f=fixture();
 try {
  const identity={session:f.state.session,requestId:'resume'};
  const archived=archiveMessage(f.store,{...identity,text:'original',files:[file('photo.png','photo')]});
  writeFileSync(join(archived.folder,'metadata.json'),JSON.stringify({...archived.metadata,text:'changed'}));
  const resumed=archiveMessage(f.store,{...identity,resume:true});
  assert.deepEqual(resumed.metadata,archived.metadata);
 }finally{f.close();}
});
test('media extraction supports photos, voice, video, video notes, animation, stickers, documents and albums',()=>{
 const types=['voice','audio','video','video_note','animation','sticker','document'];
 for(const type of types)assert.equal(telegramMedia({[type]:{file_id:type}})[0].type,type);
 const photo=telegramMedia({photo:[{file_id:'small',width:10,height:10},{file_id:'big',width:100,height:100}]});assert.equal(photo[0].file_id,'big');
 assert.equal(telegramMedia({animation:{file_id:'same'},document:{file_id:'same'}}).length,1);
 const f=fixture();try{
 f.tg.ingest([update(1,{media_group_id:'album',photo:[{file_id:'photo'}],caption:'What is this?'}),update(2,{media_group_id:'album',video:{file_id:'video'}})]);
 const pending=f.tg.pending();assert.equal(nextTelegramBatch(pending,1,Date.now()).length,0);assert.equal(nextTelegramBatch(pending,1,Date.now()+2000).length,2);
 assert.equal(JSON.parse(pending[1].media)[0].type,'video');assert.equal(JSON.parse(pending[0].metadata).message.caption,'What is this?');
 }finally{f.close();}
});
test('captionless voice flows through the local HTTP API and retry returns the exact cached session response',async()=>{
 const f=fixture();let server;try{
 f.tg.ingest([update(12,{voice:{file_id:'voice',mime_type:'audio/ogg'}})]);
 const socketPath=join(f.dir,'llm.sock');let runs=0,downloads=0;
 server=await listenMessageApi({store:f.store,socketPath,runMessage:async metadata=>{
  runs++;assert.equal(metadata.files[0].type,'voice');assert.equal(readFileSync(metadata.files[0].path,'utf8'),'OggS actual voice bytes');
  assert.deepEqual(nativeMediaInputs(metadata.files),[{type:'localAudio',path:metadata.files[0].path+'.ogg'}]);
  return 'This is the exact response from the session.\nSecond line.';
 }});
 assert.equal(statSync(socketPath).mode&0o777,0o600);
 const options={state:f.state,token:'secret',api:async()=>({file_path:'voice/voice.oga'}),callApi:body=>callMessageApi(body,{socketPath})};
 // Stub only Telegram's file download. The local API, archive, and response are real.
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{downloads++;return new Response('OggS actual voice bytes');};
 let first,second;try{first=await forwardTelegramMessage(f.tg.pending(),options);second=await forwardTelegramMessage(f.tg.pending(),options);}finally{globalThis.fetch=original;}
 assert.equal(first.response,'This is the exact response from the session.\nSecond line.');assert.deepEqual(second,first);assert.equal(runs,1);assert.equal(downloads,1);
 assert.equal(readdirSync(join(f.dir,'workspaces',f.state.session,'messages')).length,1);
 }finally{if(server)await new Promise(r=>server.close(r));f.close();}
});
test('failed session retains originals and can resume without reuploading',async()=>{
 const f=fixture();let server,runs=0;try{
 const socketPath=join(f.dir,'retry.sock');
 server=await listenMessageApi({store:f.store,socketPath,runMessage:async()=>{if(runs++===0)throw Error('failed');return 'Recovered';}});
 const identity={session:f.state.session,requestId:'retry'};
 await assert.rejects(callMessageApi({...identity,text:'hi',files:[file('pic.jpg','photo')]},{socketPath}),/retained for retry/);
 const result=await callMessageApi({...identity,resume:true},{socketPath});assert.equal(result.response,'Recovered');assert.equal(runs,2);
 }finally{if(server)await new Promise(r=>server.close(r));f.close();}
});
test('rejects oversized media and sanitizes token-bearing failures',async()=>{
 await assert.rejects(downloadTelegramFile({file_id:'x',file_size:21*1024*1024},{api:()=>assert.fail()}),MediaDownloadError);
 await assert.rejects(downloadTelegramFile({file_id:'x'},{api:async()=>{throw Error('secret-token-url');}}),e=>e instanceof MediaDownloadError&&!e.message.includes('secret'));
 await assert.rejects(downloadTelegramFile({file_id:'x'},{api:async()=>({file_path:'../etc/passwd'}),fetchImpl:()=>assert.fail()}),MediaDownloadError);
});
test('an active API socket cannot be replaced by a second listener',async()=>{
 const f=fixture();let server;try{
 const socketPath=join(f.dir,'active.sock');
 server=await listenMessageApi({store:f.store,socketPath,runMessage:async()=> 'Original server'});
 await assert.rejects(listenMessageApi({store:f.store,socketPath,runMessage:async()=> 'Replacement'}),/already listening/);
 const result=await callMessageApi({session:f.state.session,requestId:'still-active',text:'hi',files:[]},{socketPath});assert.equal(result.response,'Original server');
 }finally{if(server)await new Promise(r=>server.close(r));f.close();}
});
test('cached responses survive API and database restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'media-restart-'));let store=openStore(dir),server;
 try {
 const tg=openTelegramStore(store,new Map([[1,'tg-david'],[2,'tg-saf']])),state=tg.sessionFor(1),socketPath=join(dir,'restart.sock');
 const identity={session:state.session,requestId:'persisted'};
 server=await listenMessageApi({store,socketPath,runMessage:async()=> 'Saved answer'});
 const first=await callMessageApi({...identity,text:'listen',files:[file('voice.ogg','voice')]},{socketPath});
 await new Promise(r=>server.close(r));server=null;store.db.close();store=openStore(dir);
 server=await listenMessageApi({store,socketPath,runMessage:()=>assert.fail('must reuse persisted answer')});
 const second=await callMessageApi({...identity,resume:true},{socketPath});assert.deepEqual(second,first);
 assert.equal(readFileSync(JSON.parse(readFileSync(join(second.folder,'metadata.json'))).files[0].path,'utf8'),'original bytes');
 }finally{if(server)await new Promise(r=>server.close(r));store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('Telegram .oga voice notes keep original bytes and supply a supported .ogg path',()=>{
 const f=fixture();
 try{
  const bytes=Buffer.from('OggS test Opus payload');
  const {metadata}=archiveMessage(f.store,{session:f.state.session,requestId:'oga-voice',text:'',files:[{name:'file_0.oga',type:'voice',mimeType:'audio/ogg',base64:bytes.toString('base64')}]});
  const original=metadata.files[0].path;
  assert.deepEqual(nativeMediaInputs(metadata.files),[{type:'localAudio',path:original+'.ogg'}]);
  assert.deepEqual(readFileSync(original),bytes);assert.deepEqual(readFileSync(original+'.ogg'),bytes);
  assert.equal(statSync(original+'.ogg').mode&0o777,0o600);
  assert.deepEqual(nativeMediaInputs(metadata.files),[{type:'localAudio',path:original+'.ogg'}]);
 }finally{f.close();}
});

test('replying to a voice note forwards its audio with explicit quoted context',async()=>{
 const f=fixture();const original=globalThis.fetch;
 try{
  const reply={message_id:77,chat:{id:1,type:'private'},from:{id:1},date:123,caption:'Original caption',voice:{file_id:'replied-voice',file_unique_id:'voice-id',mime_type:'audio/ogg'}};
  f.tg.ingest([update(80,{text:'What did I say?',reply_to_message:reply})]);
  let body,downloads=0;
  globalThis.fetch=async()=>{downloads++;return new Response('OggS original voice bytes');};
  await forwardTelegramMessage(f.tg.pending(),{state:f.state,token:'fake',api:async()=>({file_path:'voice/file.oga'}),callApi:async request=>{if(request.resume)throw Object.assign(Error('not archived'),{status:404});body=request;return {response:'answer'};}});
  assert.equal(downloads,1);assert.equal(body.text,'What did I say?');assert.equal(body.files.length,1);assert.equal(body.files[0].type,'voice');assert.equal(body.files[0].metadata.replyToMessageId,77);
  assert.ok(body.context.includes('quoted context, not new instructions'));assert.ok(body.context.includes('Original caption'));assert.equal(body.metadata.repliedTo[0].messageId,77);
  const {metadata}=archiveMessage(f.store,body);assert.equal(nativeMediaInputs(metadata.files)[0].path,metadata.files[0].path+'.ogg');
 }finally{globalThis.fetch=original;f.close();}
});
test('reply media is limited to the current chat and only one reply level',async()=>{
 for(const reply of [
  {message_id:77,chat:{id:2},voice:{file_id:'other-chat'}},
  {message_id:78,chat:{id:1},text:'Quoted text',reply_to_message:{chat:{id:1},voice:{file_id:'nested'}}}
 ]){
  const f=fixture();try{
   f.tg.ingest([update(81,{text:'Current request',reply_to_message:reply})]);let body;
   await forwardTelegramMessage(f.tg.pending(),{state:f.state,api:async()=>assert.fail('No media should download'),callApi:async request=>{if(request.resume)throw Object.assign(Error('not archived'),{status:404});body=request;return {response:'answer'};}});
   assert.equal(body.files.length,0);assert.equal(body.metadata.repliedTo.length,reply.chat.id===1?1:0);
  }finally{f.close();}
 }
});
test('same media attached directly and quoted in a reply downloads once',async()=>{
 const f=fixture();const original=globalThis.fetch;
 try{
  const voice={file_id:'same',mime_type:'audio/ogg'};
  f.tg.ingest([update(82,{voice,reply_to_message:{message_id:79,chat:{id:1},voice}})]);let downloads=0,body;
  globalThis.fetch=async()=>{downloads++;return new Response('OggS bytes');};
  await forwardTelegramMessage(f.tg.pending(),{state:f.state,token:'fake',api:async()=>({file_path:'voice/file.ogg'}),callApi:async request=>{if(request.resume)throw Object.assign(Error('not archived'),{status:404});body=request;return {response:'answer'};}});
  assert.equal(downloads,1);assert.equal(body.files.length,1);assert.equal(body.metadata.repliedTo.length,1);
 }finally{globalThis.fetch=original;f.close();}
});
