import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
const runner=`
import {main} from './src/telegram.mjs';
const sent=[];let attempts=0,advanced=0,polled=0;const now=Date.now;Date.now=()=>now()+advanced;
globalThis.fetch=async(url,options={})=>{
 const method=String(url).split('/').at(-1);const body=JSON.parse(options.body||'{}');
 if(method==='getMe')return Response.json({ok:true,result:{username:'startup_test'}});
 if(method==='getWebhookInfo')return Response.json({ok:true,result:{url:''}});
 if(method==='sendMessage'){
  attempts++;
  if(process.env.TEST_RETRY==='1'&&attempts===1){return Response.json({ok:false,error_code:429,parameters:{retry_after:35}});}
  if(process.env.TEST_RETRY==='1'&&advanced<35000)throw Error('Retry ignored rate limit');
  sent.push(body);setTimeout(()=>process.kill(process.pid,'SIGTERM'),1200);
  return Response.json({ok:true,result:{message_id:123}});
 }
 if(method==='getUpdates'){
  polled++;if(process.env.TEST_RETRY==='1'){if(polled===10)advanced=34000;if(polled===20)advanced=35000;}
  await new Promise(r=>setTimeout(r,15));return Response.json({ok:true,result:[]});
 }
 throw Error('Unexpected request');
};
await main();console.log('RESULT '+JSON.stringify({sent,attempts}));
`;
async function boot(dir,retry=false){
 const child=spawn(process.execPath,['--input-type=module','-e',runner],{cwd:resolve('.'),env:{...process.env,DATA_DIR:dir,TELEGRAM_TOKEN:'fake-token',TELEGRAM_DAVID_ID:'1',TELEGRAM_SAF_ID:'2',TEST_RETRY:retry?'1':'0'},stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),8000);
 const [code]=await once(child,'exit');clearTimeout(timeout);assert.equal(code,0,errors);
 return JSON.parse(output.split('\n').find(line=>line.startsWith('RESULT ')).slice(7));
}
test('each bot start notifies David once, never Safiya or on each polling cycle',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'telegram-reboot-'));
 try{for(let i=0;i<2;i++)assert.deepEqual(await boot(dir),{sent:[{chat_id:1,text:'rebooted!'}],attempts:1});}finally{rmSync(dir,{recursive:true,force:true});}
});
test('failed startup delivery retries after Telegram rate limit without blocking polling',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'telegram-retry-'));
 try{assert.deepEqual(await boot(dir,true),{sent:[{chat_id:1,text:'rebooted!'}],attempts:2});}finally{rmSync(dir,{recursive:true,force:true});}
});
