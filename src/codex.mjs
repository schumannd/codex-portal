import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
export class CodexSession {
  constructor(cwd, onEvent, command = process.env.CODEX_BIN || 'codex', options = {}) {
    this.options = options; this.pending = new Map(); this.seq = 0; this.onEvent = onEvent;
    this.proc = spawn(command, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('TELEGRAM_'))) });
    this.proc.on('error', e => this.fail(e));
    this.proc.on('exit', () => this.fail(new Error('Codex process exited')));
    this.proc.stderr.on('data', () => {});
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && msg.method) {
        if(msg.method==='item/tool/call' && this.options.onToolCall) {
          Promise.resolve().then(()=>this.options.onToolCall(msg.params)).then(result=>this.send({id:msg.id,result})).catch(()=>this.send({id:msg.id,result:{success:false,contentItems:[{type:'inputText',text:'Tool execution failed; no delivery confirmed.'}]}}));
        } else this.send({ id: msg.id, error: { code: -32601, message: 'Interactive request not supported; operation denied' } });
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) this.onEvent(msg);
    });
    this.ready = this.rpc('initialize', { clientInfo: { name: 'schumann_portal', version: '0.1.0' }, ...(options.dynamicTools?.length?{capabilities:{experimentalApi:true}}:{}) })
      .then(() => this.send({ method: 'initialized', params: {} }));
    this.ready.catch(() => {});
  }
  send(msg) { if (!this.proc.stdin.destroyed) this.proc.stdin.write(JSON.stringify(msg) + '\n'); }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out')); }, 60000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); this.onEvent({ method: 'portal/disconnected', params: { message: error.message } }); }
  async start(cwd, threadId) {
    await this.ready;
    const params = { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', ...(this.options.developerInstructions?{developerInstructions:this.options.developerInstructions}:{}) };
    if(!threadId && this.options.dynamicTools?.length)params.dynamicTools=this.options.dynamicTools;
    const r = await this.rpc(threadId ? 'thread/resume' : 'thread/start', threadId ? { ...params, threadId, excludeTurns: true } : params);
    this.threadId = r.thread.id; return this.threadId;
  }
  prompt(text) { return this.rpc('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }] }); }
  close() { this.proc.kill('SIGTERM'); const t = setTimeout(() => this.proc.kill('SIGKILL'), 3000); t.unref(); }
}
