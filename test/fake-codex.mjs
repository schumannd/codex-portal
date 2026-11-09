#!/usr/bin/env node
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='thread/start'||m.method==='thread/resume')console.log(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId||'test-thread'}}}));
 if(m.method==='turn/start') {
 console.log(JSON.stringify({id:m.id,result:{turn:{id:'turn'}}}));
 console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'hello'}}));
 console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));
 }
}
