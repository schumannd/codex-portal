import {constants, mkdirSync, openAsBlob, realpathSync} from 'node:fs';
import {open, readdir, realpath} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

const maxBytes = 50 * 1024 * 1024;
const maxFiles = 10;

export function artifactDirectory(folder) {
  return join(dirname(dirname(folder)), 'outbox', basename(folder));
}

export function prepareArtifacts(metadata) {
  if (metadata.source !== 'telegram') return null;
  const directory = artifactDirectory(metadata.folder);
  const root = dirname(directory);
  mkdirSync(root, {recursive:true, mode:0o700});
  if (realpathSync(root) !== root) return null;
  mkdirSync(directory, {recursive:true, mode:0o700});
  return realpathSync(directory) === directory ? directory : null;
}

async function withFile(directory, name, useFile) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || /[\\/\x00-\x1f\x7f]/.test(name)) return;
  let file;
  let stat;
  try {
    const path = join(directory, name);
    if (await realpath(directory) !== directory) return;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    stat = await file.stat();
    const descriptor = `/proc/self/fd/${file.fd}`;
    if (stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes &&
        await realpath(descriptor) === path) {
      return await useFile(descriptor, stat.size);
    }
  } catch (error) {
    if (!['ENOENT','ENOTDIR','ELOOP','EACCES','EPERM'].includes(error.code)) throw error;
  } finally {
    await file?.close();
  }
}

export async function collectArtifacts(directory) {
  if (!directory) return {names:[], skipped:0};
  let entries;
  try {
    if (await realpath(directory) !== directory) return {names:[], skipped:0};
    entries = await readdir(directory, {withFileTypes:true});
  } catch (error) {
    if (['ENOENT','ENOTDIR'].includes(error.code)) return {names:[], skipped:0};
    throw error;
  }
  const names = [];
  let skipped = 0;
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || !entry.isFile()) continue;
    const accepted = names.length < maxFiles && await withFile(directory, entry.name, () => true);
    if (accepted) names.push(entry.name);
    else skipped++;
  }
  return {names, skipped};
}

export async function deliverArtifact(api, route, folder, name) {
  return withFile(artifactDirectory(folder), name, async descriptor => {
    const form = new FormData();
    for (const [key,value] of Object.entries(route)) {
      form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    form.set('document', await openAsBlob(descriptor), name);
    return api('sendDocument',form,120000);
  });
}
