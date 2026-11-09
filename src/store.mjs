import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function openStore(directory = process.env.DATA_DIR || 'data') {
  process.umask(0o077);
  const data = resolve(directory); mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, 'portal.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY, publicKey BLOB, counter INTEGER, transports TEXT, account TEXT NOT NULL REFERENCES accounts(id));
    CREATE TABLE IF NOT EXISTS auth(id TEXT PRIMARY KEY, expires INTEGER, account TEXT NOT NULL REFERENCES accounts(id));
    CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, kind TEXT, challenge TEXT, expires INTEGER, account TEXT, enrollment TEXT);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, threadId TEXT, title TEXT, closed INTEGER DEFAULT 0, created INTEGER, account TEXT NOT NULL REFERENCES accounts(id));
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, payload TEXT);
    CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, session TEXT, name TEXT, path TEXT);
  `);
  // The previous local-only prototype has no deployed database to migrate. Fail closed.
  for (const table of ['keys','auth','sessions','challenges']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='account')) {
      db.close(); throw new Error('Legacy prototype database detected. Back up and migrate it before starting.');
    }
  }
  const run = (sql,...args)=>db.prepare(sql).run(...args);
  const get = (sql,...args)=>db.prepare(sql).get(...args);
  const all = (sql,...args)=>db.prepare(sql).all(...args);
  function issue(name) {
    if(typeof name!=='string'||!name.trim()||name.length>100)throw Error('Account name must contain 1–100 characters');
    name=name.trim();const existing=get('SELECT * FROM accounts WHERE name=?',name);
    if(!existing)throw Error('Account does not exist. Create it explicitly first.');
    const code=randomBytes(12).toString('hex');
    run('DELETE FROM enrollments WHERE account=?',existing.id);
    run('INSERT INTO enrollments VALUES(?,?,?)',hash(code),existing.id,Date.now()+10*60000);
    return {code,account:existing.id};
  }
  function enrollment(code) {
    if(typeof code!=='string'||!/^[a-f0-9]{24}$/.test(code))return undefined;
    return get('SELECT e.*, a.name FROM enrollments e JOIN accounts a ON a.id=e.account WHERE e.hash=? AND e.expires>?',hash(code),Date.now());
  }
  function saveCredential(enrollmentHash,account,k) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const e=get('SELECT * FROM enrollments WHERE hash=? AND account=? AND expires>?',enrollmentHash,account,Date.now());
      if(!e)throw Error('Enrollment code expired or already used');
      run('DELETE FROM enrollments WHERE hash=?',enrollmentHash);
      run('INSERT INTO keys VALUES(?,?,?,?,?)',k.id,Buffer.from(k.publicKey),k.counter,JSON.stringify(k.transports||[]),account);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function createAccount(name) {
    if(typeof name!=='string'||!name.trim()||name.length>100)throw Error('Account name must contain 1–100 characters');
    const id=randomUUID();run('INSERT INTO accounts VALUES(?,?)',id,name.trim());return id;
  }
  return {db,data,run,get,all,issue,enrollment,saveCredential,createAccount};
}
