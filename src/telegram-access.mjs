import {createHmac} from 'node:crypto';
import {hash} from './store.mjs';

const inviteLifetime = 24 * 60 * 60 * 1000;
const invitePattern = /^\/start(?:@\w+)? join_([\w-]{43})$/i;

export function privateMessage(message) {
  return message?.chat?.type === 'private' && !message.from?.is_bot &&
    Number.isSafeInteger(message.from?.id) && message.from.id > 0 && message.chat.id === message.from.id;
}

export function openTelegramAccess(store, users, secret) {
  const {db, run, get, all} = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_access(
      user INTEGER PRIMARY KEY, label TEXT NOT NULL, revoked INTEGER, configured INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS telegram_invites(
      id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      expires INTEGER NOT NULL, used INTEGER, revoked INTEGER
    );
  `);
  const isAdmin = user => users.get(user) === 'tg-david';
  for (const {user} of all('SELECT user FROM telegram_access WHERE configured=1 AND revoked IS NULL')) {
    if (!users.has(user)) {
      run('UPDATE telegram_access SET revoked=? WHERE user=?', Date.now(), user);
      run("UPDATE telegram_inbox SET status='abandoned' WHERE user=? AND status IN ('pending','running','ready')", user);
    }
  }
  for (const [id, name] of users) {
    run(`INSERT INTO telegram_access(user,label,configured) VALUES(?,?,1)
      ON CONFLICT(user) DO UPDATE SET configured=1, revoked=CASE WHEN ? THEN NULL ELSE revoked END`,
      id, name === 'tg-david' ? 'David' : 'Safiya', isAdmin(id) ? 1 : 0);
  }
  const canChat = user => Boolean(get('SELECT 1 FROM telegram_access WHERE user=? AND revoked IS NULL', user));
  const tokenFor = id => createHmac('sha256', secret).update(`pydavid-invite:${id}`).digest('base64url');

  function issue(user, id, label) {
    if (!isAdmin(user)) return 'Only the admin can create invites.';
    if (!label || label.length > 80) return 'Usage: /invite Name (up to 80 characters)';
    const token = tokenFor(id);
    run('INSERT OR IGNORE INTO telegram_invites(id,digest,label,expires) VALUES(?,?,?,?)',
      id, hash(token), label, Date.now() + inviteLifetime);
    return `Invitation for ${label}. It expires after 24 hours and can be used once. To cancel it before use, type /revoke invite ${id}.`;
  }

  // Called inside the same transaction that acknowledges the Telegram update.
  function redeem(message, register) {
    const match = message.text?.match(invitePattern);
    if (!match) return undefined;
    const user = message.from.id;
    if (canChat(user)) return 'You already have access to PyDavid.';
    const invite = get(`UPDATE telegram_invites SET used=?
      WHERE digest=? AND expires>? AND used IS NULL AND revoked IS NULL RETURNING label`,
    user, hash(match[1]), Date.now());
    if (!invite) return null;
    register(user);
    run(`INSERT INTO telegram_access(user,label) VALUES(?,?)
      ON CONFLICT(user) DO UPDATE SET label=excluded.label,revoked=NULL,configured=0`, user, invite.label);
    return 'You now have access to PyDavid. Send a message or type /help to get started.';
  }

  function revoke(user, argument) {
    if (!isAdmin(user)) return 'Only the admin can revoke access.';
    const [kind, value] = argument.split(/\s+/);
    if (kind === 'invite' && /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value))) {
      const result = run('UPDATE telegram_invites SET revoked=? WHERE id=? AND used IS NULL AND revoked IS NULL',
        Date.now(), Number(value));
      return result.changes ? 'Invitation revoked.' : 'That invitation is no longer open.';
    }
    const id = Number(argument);
    if (!/^\d+$/.test(argument) || !Number.isSafeInteger(id)) {
      return 'Usage: /revoke USER_ID or /revoke invite INVITE_ID. Type /members to see IDs.';
    }
    if (isAdmin(id)) return 'The admin account cannot be revoked.';
    db.exec('BEGIN IMMEDIATE');
    try {
      const changed = run('UPDATE telegram_access SET revoked=? WHERE user=? AND revoked IS NULL', Date.now(), id);
      if (changed.changes) run("UPDATE telegram_inbox SET status='abandoned' WHERE user=? AND status IN ('pending','running','ready')", id);
      db.exec('COMMIT');
      return changed.changes ? 'Member access revoked.' : 'That member has no active access.';
    } catch (error) {db.exec('ROLLBACK');throw error;}
  }

  function members(user) {
    if (!isAdmin(user)) return 'Only the admin can list members.';
    const accounts = all('SELECT user,label FROM telegram_access WHERE revoked IS NULL ORDER BY label');
    const pending = all('SELECT id,label FROM telegram_invites WHERE expires>? AND used IS NULL AND revoked IS NULL ORDER BY id DESC',
      Date.now());
    return ['Members', ...accounts.map(row => `${row.label} · ${row.user}`),
      ...(pending.length ? ['','Open invites', ...pending.map(row => `${row.label} · invite ${row.id}`)] : [])].join('\n');
  }

  const invitation = id => get('SELECT id FROM telegram_invites WHERE id=?', id);
  return {isAdmin, canChat, issue, redeem, revoke, members, invitation, tokenFor};
}
