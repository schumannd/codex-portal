#!/usr/bin/env node
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.id==='tool-request'&&m.result){console.log(JSON.stringify({method:'test/tool-result',params:m.result}));}
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='thread/start'||m.method==='thread/resume')console.log(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId||'test-thread'}}}));
 if(m.method==='turn/start') {
 if(m.params.input?.[0]?.text==='[tool-test]')console.log(JSON.stringify({id:'tool-request',method:'item/tool/call',params:{callId:'x',threadId:'test-thread',turnId:'turn',tool:'send_telegram_message',arguments:{recipient:'safiya',text:'hi'}}}));
 console.log(JSON.stringify({id:m.id,result:{turn:{id:'turn'}}}));
 console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'hello'}}));
 console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));
 }
}
