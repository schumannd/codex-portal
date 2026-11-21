#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.id==='tool-request'&&m.result){console.log(JSON.stringify({method:'test/tool-result',params:m.result}));}
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='thread/start'||m.method==='thread/resume')console.log(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId||'test-thread'}}}));
 if(m.method==='turn/start') {
 console.log(JSON.stringify({method:'test/prompt',params:m.params}));
 if(m.params.input?.[0]?.text==='[tool-test]')console.log(JSON.stringify({id:'tool-request',method:'item/tool/call',params:{callId:'x',threadId:'test-thread',turnId:'turn',tool:'send_telegram_message',arguments:{recipient:'safiya',text:'hi'}}}));
 console.log(JSON.stringify({id:m.id,result:{turn:{id:'turn'}}}));
 const prompt=m.params.input[0].text;
 const attachment=prompt.includes('attachment smoke test');
 if(attachment) {
  const item={id:'write',type:'commandExecution',command:'example command'};
  console.log(JSON.stringify({method:'item/started',params:{item}}));
  await sleep(400);
  console.log(JSON.stringify({method:'item/completed',params:{item}}));
  const edit={id:'edit',type:'fileChange'};
  console.log(JSON.stringify({method:'item/started',params:{item:edit}}));
  await sleep(200);
  const outbox=prompt.match(/directly in (.+)\. Do not put drafts/)[1];
  writeFileSync(join(outbox,'report.txt'),'generated attachment');
  console.log(JSON.stringify({method:'item/completed',params:{item:edit}}));
 }
 console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:attachment?'Attachment ready':'hello'}}));
 console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));
 }
}
