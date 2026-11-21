const applicationActivities = new Map([
  ['github_repository','Working with a repository'],
  ['read_telegram_messages','Checking Telegram messages'],
  ['send_telegram_message','Sending a Telegram message'],
  ['edit_telegram_message','Editing a Telegram message'],
  ['save_contact_note','Saving a contact note']
]);

export function activityLabel(item) {
  const labels = {
    commandExecution:'Running a command', fileChange:'Editing files', webSearch:'Searching the web',
    mcpToolCall:'Using a connected tool', dynamicToolCall:'Using a tool',
    collabAgentToolCall:'Coordinating tasks', imageGeneration:'Generating an image',
    plan:'Planning the work', agentMessage:'Writing a response'
  };
  if (item?.type === 'commandExecution') {
    const actions = item.commandActions || [];
    if (actions.length && actions.every(action=>action.type==='read')) return 'Reading files';
    if (actions.length && actions.every(action=>['listFiles','search'].includes(action.type))) return 'Looking for files';
  }
  return Object.hasOwn(labels,item?.type) ? labels[item.type] : null;
}

// Subscribe before sending: app-server may complete the turn before its RPC reply arrives.
export async function sessionResponse(engine,text,{inputs=[],effort,subscribe,onActivity=()=>{},timeout=1800000}={}) {
  let finish,fail,delta='',finals=[],messages=[];
  const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});completed.catch(()=>{});
  const active = new Map();
  const observe=message=>{
    if (message.method==='item/started' || message.method==='item/completed') {
      const item = message.params.item;
      const phase = activityLabel(item);
      if (phase) {
        if (message.method==='item/started') active.set(item.id,phase);
        else active.delete(item.id);
        onActivity([...active.values()].at(-1) || 'Working on your request');
      }
    }
    if (message.method==='turn/started') onActivity('Working on your request');
    if (message.method==='portal/toolStarted') onActivity(applicationActivities.get(message.params?.tool) || 'Using a tool');
    if(message.method==='item/agentMessage/delta'){delta+=message.params.delta;onActivity('Writing a response');}
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
  try {await engine.prompt(text,inputs,effort);return await completed;}finally{clearTimeout(timer);unsubscribe();}
}
