import {telegramMedia} from './telegram-media.mjs';
import {openTelegramAccess,privateMessage} from './telegram-access.mjs';
import {openTelegramProjects} from './telegram-projects.mjs';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

export function authorizedMessage(update, users) {
  const m=update.message;
  return privateMessage(m) && users.has(m.from.id) ? m : null;
}
export function rotationDue(state, now, idleMs, minMessages) {
  return !!state?.session && idleMs>0 && minMessages>0 && state.messages>=minMessages && now-state.lastMessage>=idleMs;
}
export function openTelegramStore(store, users, secret = randomUUID()) {
  const {db,get,run,all,data}=store;
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_users(user INTEGER PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL, session TEXT, messages INTEGER NOT NULL DEFAULT 0, lastMessage INTEGER NOT NULL DEFAULT 0, memory TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS telegram_inbox(id INTEGER PRIMARY KEY, user INTEGER NOT NULL, chat INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS telegram_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const columns = new Set(all('PRAGMA table_info(telegram_inbox)').map(column=>column.name));
  const migrations = {
    receivedAt:'INTEGER', messageId:'INTEGER', replyToMessageId:'INTEGER', ingestedAt:'INTEGER',
    audio:'TEXT', attachmentId:'TEXT', media:'TEXT', metadata:'TEXT', mediaGroupId:'TEXT', sessionId:'TEXT',
    topic:'INTEGER', projectChoice:'TEXT', accessReply:'TEXT', progressId:'INTEGER',
    artifacts:'TEXT', markup:'TEXT', filesSent:'INTEGER NOT NULL DEFAULT 0'
  };
  for (const [name,type] of Object.entries(migrations)) {
    if (!columns.has(name)) db.exec(`ALTER TABLE telegram_inbox ADD COLUMN ${name} ${type}`);
  }
  const access = openTelegramAccess(store, users, secret);
  const projects = openTelegramProjects(store);
  function register(user, name = `tg-member-${user}`) {
    const accountName = name === 'tg-david' ? 'owner' : name === 'tg-saf' ? 'telegram-saf' : `telegram-member-${user}`;
    const account = get('SELECT id FROM accounts WHERE name=?',accountName)?.id || store.createAccount(accountName);
    const previous = get('SELECT account,name FROM telegram_users WHERE user=?',user);
    if (previous?.account !== account && previous?.name === 'tg-david') {
      run('DELETE FROM telegram_active_projects WHERE user=?',user);
      run('DELETE FROM telegram_projects WHERE user=?',user);
    }
    run(`INSERT INTO telegram_users(user,name,account) VALUES(?,?,?)
      ON CONFLICT(user) DO UPDATE SET name=excluded.name,account=excluded.account,session=NULL,
      messages=0,lastMessage=0,memory='' WHERE account<>excluded.account`,user,name,account);
  }
  for (const [id,name] of users) register(id,name);

  // Retry interrupted generation and keep already delivered chunks, files and status messages.
  run("UPDATE telegram_inbox SET status='pending' WHERE status='running'");
  function ingestMessage(update) {
    const query = update.callback_query;
    const message = query ? {...query.message, from:query.from} : update.message;
    if (!privateMessage(message) || get('SELECT 1 FROM telegram_inbox WHERE id=?',update.update_id)) return;
    const user = message.from.id;
    const topic = message.is_topic_message && Number.isSafeInteger(message.message_thread_id)
      ? message.message_thread_id : null;
    if (query) {
      const choice = typeof query.data === 'string' && query.data.match(/^project:(general|[0-9a-f-]{36})$/);
      if (!choice || !access.canChat(user)) return;
      run('INSERT INTO telegram_inbox(id,user,chat,text,projectChoice,topic) VALUES(?,?,?,?,?,?)',
        update.update_id,user,user,'/project',choice[1],topic);
      return;
    }
    const accessReply = access.redeem(message,id=>register(id,users.get(id)));
    if (accessReply === null || !access.canChat(user)) return;
    const media = telegramMedia(message);
    if (accessReply) {
      run('INSERT INTO telegram_inbox(id,user,chat,text,messageId,accessReply,topic) VALUES(?,?,?,?,?,?,?)',
        update.update_id,user,user,'/start',message.message_id ?? null,accessReply,topic);
      return;
    }
    if (!message.text && !message.caption && !media.length) return;
    run(`INSERT INTO telegram_inbox(id,user,chat,text,receivedAt,messageId,replyToMessageId,audio,media,metadata,mediaGroupId,ingestedAt,topic)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, update.update_id,user,user,message.text || message.caption || '[Non-text message]',
    message.date ? message.date*1000 : Date.now(),message.message_id ?? null,message.reply_to_message?.message_id ?? null,
    (message.voice || message.audio || message.document) ? JSON.stringify(message.voice || message.audio || message.document) : null,
    JSON.stringify(media),JSON.stringify(update),message.media_group_id || null,Date.now(),topic);
  }
  function ingest(updates) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const update of updates) {
        ingestMessage(update);
        run("INSERT INTO telegram_settings VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)",String(update.update_id+1));
      }
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK');throw error;}
  }

  function state(user, project) {
    const person = get('SELECT * FROM telegram_users WHERE user=?',user);
    if (person && project) {
      const named = projects.byId(user,project);
      if (!named) throw Error('Unknown Telegram project');
      return {...person, ...named, project:named.id};
    }
    return person;
  }
  const memoryDirectory = state => state.project
    ? join(data,'telegram',state.name,'projects',state.project)
    : join(data,'telegram',state.name);
  function updateState(s, set, ...values) {
    if (s.project) run(`UPDATE telegram_projects SET ${set} WHERE user=? AND id=?`,...values,s.user,s.project);
    else run(`UPDATE telegram_users SET ${set} WHERE user=?`,...values,s.user);
  }
  function sessionFor(user, project) {
    const current = state(user,project);
    if (!current) throw Error('Unknown Telegram user');
    if (current.session && !get('SELECT closed FROM sessions WHERE id=?',current.session)?.closed) return current;
    const id = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      run('INSERT INTO sessions(id,title,created,account) VALUES(?,?,?,?)',id,current.title || current.name,Date.now(),current.account);
      updateState(current,'session=?,messages=0',id);
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK');throw error;}
    return state(user,project);
  }
  function exportMemory(user,project) {
    const s = state(user,project);
    const dir = memoryDirectory(s);
    mkdirSync(dir,{recursive:true});
    const path = join(dir,'memory.txt');
    writeFileSync(path+'.tmp',s.memory,{mode:0o600});
    renameSync(path+'.tmp',path);
    return path;
  }
  function commitMemory(user,memory,project) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const s = state(user,project);
      updateState(s,'memory=?,session=NULL,messages=0',memory);
      if (s.session) run('UPDATE sessions SET closed=1 WHERE id=?',s.session);
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK');throw error;}
    exportMemory(user,project);
  }
  function jobActive(job) {
    return access.canChat(job.user) && get('SELECT status FROM telegram_inbox WHERE id=?',job.id)?.status !== 'abandoned';
  }
  return {
    access,projects,ingest,sessionFor,exportMemory,commitMemory,memoryDirectory,state,jobActive,
    recordMessage: s => updateState(s,'messages=messages+1,lastMessage=?',Date.now()),
    activeUsers: () => all('SELECT user FROM telegram_access WHERE revoked IS NULL').map(row=>row.user),
    offset: () => Number(get("SELECT value FROM telegram_settings WHERE key='offset'")?.value || 0),
    pending: () => all("SELECT * FROM telegram_inbox WHERE status IN ('pending','ready') ORDER BY id")
  };
}

export function nextTelegramBatch(pending,user,now=Date.now()) {
  const first=pending.find(j=>j.user===user);
  if(!first)return [];
  if(first.status==='ready'||!first.mediaGroupId)return [first];
  const jobs=pending.filter(j=>j.user===user&&j.chat===first.chat&&j.mediaGroupId===first.mediaGroupId&&j.status!=='ready');
  // Albums arrive as separate updates, sometimes across polling responses.
  if(jobs.some(j=>now-(j.ingestedAt||0)<1500))return [];
  return jobs;
}
