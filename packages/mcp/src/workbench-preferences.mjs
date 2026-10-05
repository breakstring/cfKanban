import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveStateRoot } from '../../skill-runtime/src/paths.mjs';
import { validatePrivatePath } from '../../skill-runtime/src/state.mjs';
import { assertNoSymlinkPath, requireUuid } from '../../skill-runtime/src/utils.mjs';

const fields = ['instance_id', 'principal_id', 'workspace_id', 'project_id'];
const maxBytes = 1024;
const repositoryKeyPattern = /^[0-9a-f]{64}$/;

function targetRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== fields.length
      || fields.some(field => !descriptors[field] || !Object.hasOwn(descriptors[field], 'value'))) return null;
    return Object.fromEntries(fields.map(field => [field, requireUuid(descriptors[field].value, field)]));
  } catch { return null; }
}

function pathsFor({ homeDirectory = os.homedir(), stateRoot } = {}) {
  if (typeof homeDirectory !== 'string' || !homeDirectory.trim()
    || (stateRoot !== undefined && (typeof stateRoot !== 'string' || !stateRoot.trim()))) return null;
  const home = path.resolve(homeDirectory);
  const root = path.resolve(stateRoot ?? resolveStateRoot({ home }));
  const relative = path.relative(home, root);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  if (/\/(?:Dropbox|OneDrive|Google Drive|Library\/Mobile Documents)(?:\/|$)/i.test(root.replaceAll('\\', '/'))) return null;
  let current = home;
  const directories = relative.split(path.sep).map(segment => current = path.join(current, segment));
  directories.push(path.join(root, 'workbench'), path.join(root, 'workbench', 'codex'));
  return { home, root, directories, file: path.join(directories.at(-1), 'last-project.json') };
}

async function statsOrMissing(target) {
  try { return await lstat(target); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function validateDirectories(paths, create) {
  // Checking from the filesystem root also rejects an aliased home or a linked ancestor.
  await assertNoSymlinkPath(paths.file, path.parse(paths.home).root);
  const homeStats = await lstat(paths.home);
  if (!homeStats.isDirectory() || await statsOrMissing(path.join(paths.home, '.git'))) return false;
  for (const directory of paths.directories) {
    if (await statsOrMissing(path.join(directory, '.git'))) return false;
    let stats = await statsOrMissing(directory);
    if (!stats) {
      if (!create) return false;
      await assertNoSymlinkPath(directory, path.parse(paths.home).root);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      stats = await lstat(directory);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    await validatePrivatePath(directory, 'directory');
  }
  return true;
}

async function validateFile(paths) {
  await assertNoSymlinkPath(paths.file, path.parse(paths.home).root);
  const stats = await statsOrMissing(paths.file);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size < 1 || stats.size > maxBytes) throw new Error('Unsafe preference file');
  await validatePrivatePath(paths.file, 'file');
  return stats;
}

async function readTarget(paths) {
  let handle;
  try {
    if (!await validateDirectories(paths, false)) return null;
    const before = await validateFile(paths);
    if (!before) return null;
    handle = await open(paths.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 1 || bytesRead > maxBytes) return null;
    const after = await validateFile(paths);
    if (!after || after.dev !== opened.dev || after.ino !== opened.ino) return null;
    return targetRecord(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally { await handle?.close().catch(() => undefined); }
}

export function createWorkbenchPreferences(options = {}) {
  let paths;
  try { paths = pathsFor(options); } catch { paths = null; }
  const selectedPaths = repositoryKey => {
    if (repositoryKey === undefined) return paths;
    if (!paths || typeof repositoryKey !== 'string' || repositoryKey.length !== 64 || !repositoryKeyPattern.test(repositoryKey)) return null;
    const directory = path.join(paths.directories.at(-1), 'repositories');
    return { ...paths, directories: [...paths.directories, directory], file: path.join(directory, `${repositoryKey}.json`) };
  };
  return {
    async load(repositoryKey) {
      const selected = selectedPaths(repositoryKey);
      if (!selected) return null;
      try { return await readTarget(selected); } catch { return null; }
    },
    async save(target, repositoryKey) {
      const paths = selectedPaths(repositoryKey);
      const record = targetRecord(target);
      if (!paths || !record) return false;
      let temporary, handle;
      try {
        if (!await validateDirectories(paths, true)) return false;
        if (await validateFile(paths) && !await readTarget(paths)) return false;
        temporary = path.join(paths.directories.at(-1), `.last-project.${process.pid}.${randomUUID()}.tmp`);
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (!await validateDirectories(paths, false)) return false;
        if (await validateFile(paths) && !await readTarget(paths)) return false;
        await rename(temporary, paths.file);
        temporary = undefined;
        await validateFile(paths);
        return true;
      } catch { return false; }
      finally {
        await handle?.close().catch(() => undefined);
        if (temporary) {
          try {
            await assertNoSymlinkPath(temporary, path.parse(paths.home).root);
            await rm(temporary, { force: true });
          } catch { /* Unsafe or unavailable paths are never repaired during cleanup. */ }
        }
      }
    },
  };
}
