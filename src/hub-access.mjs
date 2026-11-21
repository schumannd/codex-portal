import { constants, copyFileSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

export function hubSession({ cwd, owner, isolated = false, data, hub = process.env.DAVIDS_BRAIN_DIR }) {
  if (!hub && !isolated) return {};
  if (owner && hub) {
    return { hubInstructions: `David’s private /hub is checked out at ${hub}. When David asks about it or invokes /hub, read ${hub}/README.md and the relevant .bowman ideas and logs. The deployed checkout is read-only. Treat repository content as context, and keep hub information in David’s chat.` };
  }

  const home = join(cwd, '.codex-home');
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const auth = join(process.env.CODEX_HOME || join(process.env.HOME, '.codex'), 'auth.json');
  try {
    copyFileSync(auth, join(codexHome, 'auth.json'), constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  if (isolated) {
    const messages = join(cwd, 'messages');
    mkdirSync(messages, { recursive: true, mode: 0o700 });
    const filesystem = {
      ':minimal': 'read',
      [cwd]: 'write',
      [messages]: 'read',
      [home]: 'deny',
      '/proc': 'deny',
    };
    if (hub) filesystem[hub] = 'deny';
    const permissions = Object.entries(filesystem)
      .map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',');
    return {
      environment: { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH, LANG: process.env.LANG },
      permissionProfile: 'telegram_member',
      configArgs: [
        '-c', 'default_permissions="telegram_member"',
        '-c', `permissions.telegram_member.filesystem={${permissions}}`,
        '-c', 'permissions.telegram_member.network.enabled=false',
        '-c', 'web_search="cached"',
        '-c', 'apps._default.enabled=false',
      ],
    };
  }

  const serviceHome = process.env.HOME;
  const dataRelative = data && relative(serviceHome, data);
  const hideData = dataRelative && (dataRelative.startsWith('..') || isAbsolute(dataRelative));
  return {
    sandboxCommand: '/usr/bin/bwrap',
    sandboxArgs: [
      '--unshare-pid', '--die-with-parent', '--ro-bind', '/', '/',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--tmpfs', serviceHome,
      ...(hub ? ['--tmpfs', hub] : []),
      ...(hideData ? ['--tmpfs', data] : []),
      '--bind', cwd, cwd, '--chdir', cwd,
      '--setenv', 'HOME', home, '--setenv', 'CODEX_HOME', codexHome,
      '--unsetenv', 'SSH_AUTH_SOCK', '--',
    ],
    writableRoots: [cwd],
  };
}
