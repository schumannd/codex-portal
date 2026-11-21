import {randomUUID} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const normalize = value => value.normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const repoPattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?![\w.-])/i;
const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function hubProject(name, hub = process.env.DAVIDS_BRAIN_DIR) {
  if (!hub) return null;
  const search = normalize(name);
  const ideas = join(hub, '.bowman', 'ideas');
  try {
    for (const file of readdirSync(ideas)) {
      const id = file.slice(0, -5);
      if (!file.endsWith('.json') || !uuidPattern.test(id)) continue;
      const goal = JSON.parse(readFileSync(join(ideas, file), 'utf8'));
      if (!goal.tags?.includes('top-level') || goal.archived) continue;
      let readme = '';
      try { readme = readFileSync(join(hub, 'projects', id, 'README.md'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const description = goal.description || '';
      const repo = (description.match(repoPattern) || readme.match(repoPattern))?.[1];
      const heading = readme.match(/^# (.+)$/m)?.[1];
      const aliases = readme.split('\n').find(line => line.includes('refer to the same project'))
        ?.split(' refer to the same project')[0]?.split(/,\s*(?:and\s+)?|\s+and\s+/) || [];
      const names = [goal.text, heading, repo, repo?.split('/').at(-1), ...aliases].filter(Boolean);
      if (names.some(candidate => normalize(candidate) === search)) {
        return {key: id, title: aliases[0] || heading || goal.text, repo: repo || null};
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Unable to read Telegram project index');
  }
  return null;
}

export function openTelegramProjects({db, run, get, all}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_projects(
      id TEXT PRIMARY KEY, user INTEGER NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
      repo TEXT, topic INTEGER, session TEXT, messages INTEGER NOT NULL DEFAULT 0,
      lastMessage INTEGER NOT NULL DEFAULT 0, memory TEXT NOT NULL DEFAULT '',
      UNIQUE(user,key), UNIQUE(user,topic)
    );
    CREATE TABLE IF NOT EXISTS telegram_active_projects(user INTEGER PRIMARY KEY, project TEXT NOT NULL);
  `);
  const byId = (user, id) => get('SELECT * FROM telegram_projects WHERE user=? AND id=?', user, id);
  const route = (user, topic) => topic
    ? get('SELECT * FROM telegram_projects WHERE user=? AND topic=?', user, topic)
    : get(`SELECT p.* FROM telegram_active_projects a JOIN telegram_projects p ON p.id=a.project
        WHERE a.user=? AND p.user=a.user`, user);
  const list = user => all('SELECT * FROM telegram_projects WHERE user=? ORDER BY lastMessage DESC,title', user);
  function ensure(user, name, admin) {
    const title = name.trim().replace(/\s+/g, ' ');
    const alias = normalize(title);
    if (!alias || title.length > 80) return null;
    const existing = list(user).find(project => normalize(project.title) === alias);
    const resolved = (admin && hubProject(title)) || (existing && {
      key: existing.key, title: existing.title, repo: existing.repo
    }) || {key: alias, title, repo: null};
    run(`INSERT INTO telegram_projects(id,user,key,title,repo) VALUES(?,?,?,?,?)
      ON CONFLICT(user,key) DO UPDATE SET title=excluded.title,repo=excluded.repo`,
    randomUUID(), user, resolved.key, resolved.title, resolved.repo);
    return get('SELECT * FROM telegram_projects WHERE user=? AND key=?', user, resolved.key);
  }
  function select(user, id) {
    if (!id) return run('DELETE FROM telegram_active_projects WHERE user=?', user);
    if (byId(user,id)) run(`INSERT INTO telegram_active_projects(user,project) VALUES(?,?)
      ON CONFLICT(user) DO UPDATE SET project=excluded.project`, user, id);
  }
  function setTopic(user, id, topic) {
    run('UPDATE telegram_projects SET topic=? WHERE user=? AND id=?', topic, user, id);
  }
  return {byId, route, list, ensure, select, setTopic};
}
