import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {main} from '../src/telegram.mjs';
const make=(id,fields)=>({update_id:id,message:{from:{id:1},chat:{id:1,type:'private'},message_id:id,date:1700000000,...fields}});
const updates=[make(1,{voice:{file_id:'voice',mime_type:'audio/ogg'}}),make(2,{photo:[{file_id:'small',width:1,height:1},{file_id:'photo',width:20,height:20}],caption:'Describe this photo'}),make(3,{video:{file_id:'video'}}),make(4,{video_note:{file_id:'video_note'}}),make(5,{document:{file_id:'document',file_name:'notes.txt'},caption:'/new'}),make(6,{animation:{file_id:'animation'}}),make(7,{sticker:{file_id:'sticker'}}),make(8,{audio:{file_id:'audio',mime_type:'audio/mpeg'}}),make(9,{media_group_id:'album',photo:[{file_id:'album1'}],caption:'Compare these'}),make(10,{media_group_id:'album',photo:[{file_id:'album2'}]}),make(11,{text:'What did the voice note say?',reply_to_message:{message_id:1,chat:{id:1,type:'private'},from:{id:1},voice:{file_id:'voice',mime_type:'audio/ogg'}}}),make(12,{text:'attachment smoke test'})];
const sent=[],edited=[],documents=[];let polled=false;
globalThis.fetch=async(url,options={})=>{
 if(String(url).includes('/file/bot'))return new Response('original media bytes');
 const method=String(url).split('/').at(-1),body=options.body instanceof FormData?options.body:JSON.parse(options.body||'{}');let result;
 if(method==='getMe')result={username:'test_bot'};
 else if(method==='getWebhookInfo')result={url:''};
 else if(method==='getUpdates') {
  if(!polled){polled=true;result=updates;}
  else {await new Promise(resolve=>{const timer=setTimeout(resolve,30);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});result=[];}
 }
 else if(method==='getFile')result={file_path:'files/'+body.file_id+'.bin'};
 else if(method==='sendMessage') {
  sent.push(body);writeFileSync(join(process.env.DATA_DIR,'fake-deliveries.json'),JSON.stringify(sent));
  result={message_id:100+sent.length};
 } else if (method==='editMessageText') {
  edited.push(body);
  result={message_id:body.message_id};
 } else if (method==='sendDocument') {
  const document=body.get('document');
  documents.push({name:document.name,bytes:await document.text(),chat:body.get('chat_id'),reply:JSON.parse(body.get('reply_parameters'))});
  writeFileSync(join(process.env.DATA_DIR,'fake-attachments.json'),JSON.stringify({edited,documents}));
  result={message_id:200};
  setTimeout(()=>process.kill(process.pid,'SIGTERM'),10);
 } else throw Error('Unexpected Telegram method');
 return Response.json({ok:true,result});
};
await main({progressDelay:100,progressInterval:65});
