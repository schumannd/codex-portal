import express from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore, hash } from './store.mjs';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { CodexSession } from './codex.mjs';

process.umask(0o077);
const origin = process.env.ORIGIN || 'https://app.schumann.com.de';
const rpID = new URL(origin).hostname;
const store=openStore();
const {data,db,run,get,all}=store;
const cookie = (req, name) => (req.headers.cookie || '').split('; ').find(v => v.startsWith(name + '='))?.slice(name.length + 1);
const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${origin.startsWith('https:') ? '; Secure' : ''}`;
const authName = origin.startsWith('https:') ? '__Host-portal' : 'portal';
const fail = (status, message) => Object.assign(new Error(message), { status });
function authenticated(req) { const token = cookie(req, authName); return token && get('SELECT id,account FROM auth WHERE id=? AND expires>?', hash(token), Date.now()); }
function login(res, account) { const token = randomBytes(32).toString('base64url'); run('INSERT INTO auth VALUES(?,?,?)', hash(token), Date.now() + 12*3600000,account); res.setHeader('Set-Cookie', `${authName}=${token}; ${cookieOptions}; Max-Age=43200`); }
function challenge(res, kind, value, account=null, enrollment=null) { const id = randomBytes(32).toString('base64url'); run('INSERT INTO challenges VALUES(?,?,?,?,?,?)', hash(id), kind, value, Date.now()+300000,account,enrollment); res.setHeader('Set-Cookie', `challenge=${id}; ${cookieOptions}; Max-Age=300`); }
function consume(req, kind) { const id = hash(cookie(req, 'challenge') || ''); const c = get('SELECT * FROM challenges WHERE id=?', id); run('DELETE FROM challenges WHERE id=?', id); if (!c || c.kind !== kind || c.expires < Date.now()) throw fail(400, 'Challenge expired; try again'); return c; }
const app = express(); app.disable('x-powered-by');
app.use((req,res,next) => {
  res.set({ 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=()', 'Cache-Control': 'no-store' });
  if (!['GET','HEAD'].includes(req.method) && req.headers.origin !== origin) return res.status(403).json({error:'Invalid origin'});
  next();
});
app.use(express.json({limit:'15mb'}));
// Single reverse proxy is Caddy on loopback. Rate limits use its sanitized client IP.
app.set('trust proxy', 'loopback');
const limits = new Map();
app.use('/api', (req,res,next) => { const key = req.ip; const now = Date.now(); let l=limits.get(key); if (!l || l.until<now) { l={n:0,until:now+60000}; limits.set(key,l); } if (++l.n>180) return res.status(429).json({error:'Too many requests'}); next(); });
setInterval(() => { const now=Date.now(); for (const [k,v] of limits) if(v.until<now) limits.delete(k); run('DELETE FROM auth WHERE expires<?',now); run('DELETE FROM challenges WHERE expires<?',now); },60000).unref();
app.get('/health', (_req,res) => res.json({ok:true}));
app.get('/api/auth/status', (req,res) => res.json({authenticated:!!authenticated(req)}));
app.post('/api/auth/register/options', async(req,res) => {
  const enrollment=store.enrollment(req.body.code);
  if(!enrollment)throw fail(403,'Invalid or expired enrollment code');
  const o=await generateRegistrationOptions({rpName:'Schumann Codex',rpID,userID:Buffer.from(enrollment.account),userName:enrollment.name,attestationType:'none',excludeCredentials:all('SELECT id FROM keys WHERE account=?',enrollment.account),authenticatorSelection:{residentKey:'required',userVerification:'required',authenticatorAttachment:'platform'}});
  challenge(res,'enroll',o.challenge,enrollment.account,enrollment.hash);res.json(o);
});
app.post('/api/auth/register/verify',async(req,res)=>{
  const c=consume(req,'enroll');
  const v=await verifyRegistrationResponse({response:req.body.credential,expectedChallenge:c.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true});
  if(!v.verified)throw fail(401,'Passkey verification failed');
  try{store.saveCredential(c.enrollment,c.account,v.registrationInfo.credential);}catch{throw fail(403,'Enrollment code expired or already used');}
  login(res,c.account);res.json({ok:true});
});
app.post('/api/auth/login/options', async(_req,res) => { const o=await generateAuthenticationOptions({rpID,userVerification:'required'}); challenge(res,'login',o.challenge); res.json(o); });
app.post('/api/auth/login/verify',async(req,res)=>{
  const c=consume(req,'login'); const k=get('SELECT * FROM keys WHERE id=?',req.body.id); if(!k) throw fail(401,'Unknown passkey');
  const v=await verifyAuthenticationResponse({response:req.body,expectedChallenge:c.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,credential:{id:k.id,publicKey:new Uint8Array(k.publicKey),counter:k.counter,transports:JSON.parse(k.transports)}});
  if(!v.verified) throw fail(401,'Passkey verification failed'); run('UPDATE keys SET counter=? WHERE id=?',v.authenticationInfo.newCounter,k.id); login(res,k.account); res.json({ok:true});
});
app.post('/api/auth/logout',(req,res)=>{run('DELETE FROM auth WHERE id=?',hash(cookie(req,authName)||''));res.setHeader('Set-Cookie',`${authName}=; ${cookieOptions}; Max-Age=0`);res.json({ok:true});});
app.use('/api',(req,res,next)=>{const auth=authenticated(req);if(!auth)return res.status(401).json({error:'Sign in with your passkey'});req.account=auth.account;next();});
const live=new Map(); const locks=new Set();
function event(id, payload) { run('INSERT INTO events(session,payload) VALUES(?,?)',id,JSON.stringify(payload)); }
function session(id, account) { const s=get('SELECT * FROM sessions WHERE id=? AND account=?',id,account); if(!s) throw fail(404,'Session not found'); return s; }
async function engine(s) {
  if(s.closed) throw fail(409,'Session is closed'); if(live.has(s.id)) return live.get(s.id);
  const promise=(async()=>{ const cwd=join(data,'workspaces',s.id);mkdirSync(cwd,{recursive:true});const e=new CodexSession(cwd,msg=>{event(s.id,msg);if(msg.method==='turn/completed') locks.delete(s.id);if(msg.method==='portal/disconnected') {live.delete(s.id);locks.delete(s.id);}});try {const thread=await e.start(cwd,s.threadId);run('UPDATE sessions SET threadId=? WHERE id=?',thread,s.id);return e;} catch(err){e.close();live.delete(s.id);throw err;} })();live.set(s.id,promise);return promise;
}
app.get('/api/sessions',(req,res)=>res.json(all('SELECT * FROM sessions WHERE account=? ORDER BY created DESC',req.account)));
app.post('/api/sessions',async(req,res)=>{
  if(get('SELECT count(*) AS n FROM sessions WHERE closed=0 AND account=?',req.account).n>=10) throw fail(409,'Close a session first (maximum 10 open)');
  const id=randomUUID();run('INSERT INTO sessions(id,title,created,account) VALUES(?,?,?,?)',id,String(req.body.title||'New session').slice(0,100),Date.now(),req.account);try {await engine(session(id,req.account));res.status(201).json(session(id,req.account));}catch(e){run('UPDATE sessions SET closed=1 WHERE id=?',id);throw e;}
});
app.get('/api/sessions/:id/events',(req,res)=>{session(req.params.id,req.account);const after=Number(req.query.after||0);if(!Number.isSafeInteger(after)||after<0)throw fail(400,'Invalid cursor');res.json(all('SELECT id,payload FROM events WHERE session=? AND id>? ORDER BY id LIMIT 200',req.params.id,after).map(e=>({id:e.id,...JSON.parse(e.payload)})));});
app.post('/api/sessions/:id/files',(req,res)=>{
  const s=session(req.params.id,req.account);if(s.closed)throw fail(409,'Session closed');const {name,base64}=req.body;
  if(typeof name!=='string'||name.length>200||typeof base64!=='string'||base64.length>13981016||/[^A-Za-z0-9+/=]/.test(base64))throw fail(400,'Invalid file');
  const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64)throw fail(400,'Invalid base64');if(bytes.length>10*1024*1024)throw fail(413,'Maximum file size is 10 MB');
  if(get('SELECT count(*) AS n FROM uploads WHERE session=?',s.id).n>=100)throw fail(409,'Maximum 100 files per session');
  const id=randomUUID();const dir=join(data,'workspaces',s.id,'uploads');mkdirSync(dir,{recursive:true});const path=join(dir,id+'-'+name.replace(/[^a-zA-Z0-9._-]/g,'_'));writeFileSync(path,bytes,{flag:'wx'});run('INSERT INTO uploads VALUES(?,?,?,?)',id,s.id,name,path);res.status(201).json({id,name});
});
app.post('/api/sessions/:id/prompts',async(req,res)=>{
  const s=session(req.params.id,req.account);if(locks.has(s.id))throw fail(409,'Session is busy');const {text,files=[]}=req.body;
  if(typeof text!=='string'||!text.trim()||text.length>100000||!Array.isArray(files)||files.length>20)throw fail(400,'Invalid prompt');
  const attached=files.map(id=>{const f=get('SELECT * FROM uploads WHERE id=? AND session=?',id,s.id);if(!f)throw fail(400,'Unknown attachment');return f;});
  locks.add(s.id);try{const e=await engine(s);event(s.id,{method:'portal/prompt',params:{text,files:attached.map(f=>f.name)}});const r=await e.prompt(text+(attached.length?'\n\nAttached local files (read these paths as needed):\n'+attached.map(f=>JSON.stringify(f.path)).join('\n'):''));res.status(202).json(r);}catch(e){locks.delete(s.id);throw e;}
});
app.delete('/api/sessions/:id',async(req,res)=>{const s=session(req.params.id,req.account);run('UPDATE sessions SET closed=1 WHERE id=?',s.id);const p=live.get(s.id);live.delete(s.id);if(p)(await p.catch(()=>null))?.close();locks.delete(s.id);res.json({ok:true});});
app.use('/vendor',express.static(resolve('node_modules/@simplewebauthn/browser/dist/bundle')));
app.use(express.static(resolve('public')));
app.use((err,_req,res,_next)=>{console.error(err.message);res.status(err.status||500).json({error:err.status?err.message:'Request failed; inspect server logs'});});
const server=app.listen(Number(process.env.PORT||3000),'127.0.0.1',()=>console.log('Codex portal listening on loopback'));
async function shutdown(){server.close();for(const p of live.values())(await p.catch(()=>null))?.close();process.exit(0);}process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
