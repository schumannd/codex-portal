const frames = ['.', '..', '...', '…'];

export function telegramProgress({initialMessageId, send, edit, activity, save, signal, active=()=>true, interval=8000, initialDelay=500}) {
  let messageId = initialMessageId;
  let scheduled;
  let running;
  let finished = false;
  let frame = 0;
  let retryDelay = 0;

  async function update() {
    if (finished || signal?.aborted || !active()) return;
    const phase = await activity().catch(() => null) || 'Preparing your request';
    if (finished || signal?.aborted || !active()) return;
    const text = phase + frames[frame++ % frames.length];
    if (messageId) await edit(messageId,text);
    else {
      const sent = await send(text);
      messageId = sent.message_id;
      save(messageId);
    }
  }

  function schedule(delay) {
    scheduled = setTimeout(() => {
      if (finished || signal?.aborted || !active()) return;
      running = update().catch(error => {
        retryDelay = Math.max(0, Number(error.retryAfter) || 0) * 1000;
      }).finally(() => {
        if (!finished && !signal?.aborted) schedule(Math.max(interval,retryDelay));
        retryDelay = 0;
      });
    },delay);
  }
  schedule(initialDelay);

  return async () => {
    finished = true;
    clearTimeout(scheduled);
    await running;
    return messageId;
  };
}
