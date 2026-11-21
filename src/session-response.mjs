// Subscribe before sending: app-server may complete the turn before its RPC reply arrives.
export async function sessionResponse(engine,text,{inputs=[],subscribe,timeout=1800000}={}) {
  let finish,fail,delta='',finals=[],messages=[];
  const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});completed.catch(()=>{});
  const observe=message=>{
    if(message.method==='item/agentMessage/delta')delta+=message.params.delta;
    if(message.method==='item/completed'&&message.params.item?.type==='agentMessage') {
      const item=message.params.item;messages.push(item.text);
      if(item.phase==='final_answer')finals.push(item.text);
    }
    if(message.method==='portal/disconnected')fail(Error('LLM session disconnected'));
    if(message.method==='turn/completed') {
      if(message.params.turn?.status!=='completed'){fail(Error('LLM turn failed'));return;}
      const items=message.params.turn.items?.filter(i=>i.type==='agentMessage')||[];
      const finalItems=items.filter(i=>i.phase==='final_answer');
      const response=(finalItems.length?finalItems.map(i=>i.text):finals.length?finals:items.length?items.map(i=>i.text):messages.length?messages:[delta]).join('\n');
      response.trim()?finish(response):fail(Error('LLM returned an empty response'));
    }
  };
  const unsubscribe=subscribe(observe);
  const timer=setTimeout(()=>fail(Error('LLM turn timed out')),timeout);
  try {await engine.prompt(text,inputs);return await completed;}finally{clearTimeout(timer);unsubscribe();}
}
