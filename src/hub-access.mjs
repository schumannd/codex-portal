import { constants, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function hubSession({ cwd, owner, hub = process.env.DAVIDS_BRAIN_DIR }) {
  if (!hub) return {};
  if (owner) {
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

  return {
    sandboxCommand: '/usr/bin/bwrap',
    sandboxArgs: [
      '--unshare-pid', '--die-with-parent', '--ro-bind', '/', '/',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--tmpfs', process.env.HOME, '--tmpfs', hub,
      '--bind', cwd, cwd, '--chdir', cwd,
      '--setenv', 'HOME', home, '--setenv', 'CODEX_HOME', codexHome,
      '--unsetenv', 'SSH_AUTH_SOCK', '--',
    ],
    writableRoots: [cwd],
  };
}
