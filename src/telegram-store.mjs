import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

export function authorizedMessage(update, users) {
  const m=update.message;
  return m?.chat?.type==='private' && !m.from?.is_bot && users.has(m.from?.id) && m.chat.id===m.from.id ? m : null;
}
export function rotationDue(state, now, idleMs, minMessages) {
  return !!state?.session && idleMs>0 && minMessages>0 && state.messages>=minMessages && now-state.lastMessage>=idleMs;
}
export function openTelegramStore(store, users) {
  const {db,get,run,all,data}=store;
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_users(user INTEGER PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL, session TEXT, messages INTEGER NOT NULL DEFAULT 0, lastMessage INTEGER NOT NULL DEFAULT 0, memory TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS telegram_inbox(id INTEGER PRIMARY KEY, user INTEGER NOT NULL, chat INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS telegram_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  for(const name of ['receivedAt','messageId','replyToMessageId'])if(!db.prepare('PRAGMA table_info(telegram_inbox)').all().some(c=>c.name===name))db.exec(`ALTER TABLE telegram_inbox ADD COLUMN ${name} INTEGER`);
  for(const [id,name] of users) {
    const accountName=name==='tg-david'?'owner':'telegram-saf';
    const account=get('SELECT id FROM accounts WHERE name=?',accountName)?.id || store.createAccount(accountName);
    run('INSERT OR IGNORE INTO telegram_users(user,name,account) VALUES(?,?,?)',id,name,account);
  }
  // Retry interrupted generation; delivery resumes from its last confirmed chunk.
  run("UPDATE telegram_inbox SET status='pending' WHERE status='running'");
  function ingest(updates) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const u of updates) {
        const m=authorizedMessage(u,users);
        if(m)run('INSERT OR IGNORE INTO telegram_inbox(id,user,chat,text,receivedAt,messageId,replyToMessageId) VALUES(?,?,?,?,?,?,?)',u.update_id,m.from.id,m.chat.id,m.text||m.caption||'[Non-text message]',m.date?m.date*1000:Date.now(),m.message_id??null,m.reply_to_message?.message_id??null);
        run("INSERT INTO telegram_settings VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)",String(u.update_id+1));
      }
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function sessionFor(user) {
    let state=get('SELECT * FROM telegram_users WHERE user=?',user);
    if(!state)throw Error('Unknown Telegram user');
    if(!state.session || get('SELECT closed FROM sessions WHERE id=?',state.session)?.closed) {
      const id=randomUUID();
      run('INSERT INTO sessions(id,title,created,account) VALUES(?,?,?,?)',id,state.name,Date.now(),state.account);
      run('UPDATE telegram_users SET session=?,messages=0 WHERE user=?',id,user);
      state=get('SELECT * FROM telegram_users WHERE user=?',user);
    }
    return state;
  }
  function exportMemory(user) {
    const s=get('SELECT * FROM telegram_users WHERE user=?',user);
    const dir=join(data,'telegram',s.name);mkdirSync(dir,{recursive:true});
    const path=join(dir,'memory.txt');writeFileSync(path+'.tmp',s.memory,{mode:0o600});renameSync(path+'.tmp',path);
    return path;
  }
  function commitMemory(user,memory) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const s=get('SELECT * FROM telegram_users WHERE user=?',user);
      run('UPDATE telegram_users SET memory=?,session=NULL,messages=0 WHERE user=?',memory,user);
      if(s.session)run('UPDATE sessions SET closed=1 WHERE id=?',s.session);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    exportMemory(user);
  }
  return {ingest,sessionFor,exportMemory,commitMemory,offset:()=>Number(get("SELECT value FROM telegram_settings WHERE key='offset'")?.value||0),pending:()=>all("SELECT * FROM telegram_inbox WHERE status IN ('pending','ready') ORDER BY id"),state:user=>get('SELECT * FROM telegram_users WHERE user=?',user)};
}
