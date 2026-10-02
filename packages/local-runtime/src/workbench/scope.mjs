import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { validateScopeDocument } from '../../../skill-runtime/src/scope.mjs';

export const MAX_SCOPE_BYTES = 64 * 1024;
const SCOPE_FILE = '.cfkanban-scope.json';
const outcome = (status, code, targets = []) => ({ status, code, targets });
const canceled = signal => signal?.aborted === true;
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

// workspacePath 仅由可信 launcher 或 Host 核验 registry / Session 后提供。
// 该准确目录中的 scope 仅提供推荐过滤，不构成授权。
export async function readWorkspaceScope({ workspacePath } = {}, { signal } = {}) {
  if (canceled(signal)) return outcome('unavailable', 'SCOPE_CANCELED');
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath) || workspacePath.includes('\0')) {
    return outcome('unavailable', 'SCOPE_WORKSPACE_UNAVAILABLE');
  }
  let directory;
  try { directory = await lstat(workspacePath); }
  catch { return outcome('unavailable', 'SCOPE_WORKSPACE_UNAVAILABLE'); }
  if (directory.isSymbolicLink() || !directory.isDirectory()) return outcome('invalid', 'SCOPE_WORKSPACE_UNSAFE');
  if (canceled(signal)) return outcome('unavailable', 'SCOPE_CANCELED');
  const file = path.join(workspacePath, SCOPE_FILE);
  let before;
  try { before = await lstat(file); }
  catch (error) { return error?.code === 'ENOENT' ? outcome('missing', 'SCOPE_MISSING') : outcome('unavailable', 'SCOPE_UNAVAILABLE'); }
  if (before.isSymbolicLink() || !before.isFile()) return outcome('invalid', 'SCOPE_FILE_UNSAFE');
  if (before.size > MAX_SCOPE_BYTES) return outcome('invalid', 'SCOPE_TOO_LARGE');
  let handle;
  try {
    if (canceled(signal)) return outcome('unavailable', 'SCOPE_CANCELED');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    const currentDirectory = await lstat(workspacePath);
    if (currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory() || !sameFile(directory, currentDirectory)) {
      return outcome('invalid', 'SCOPE_WORKSPACE_UNSAFE');
    }
    const current = await lstat(file);
    if (current.isSymbolicLink() || !current.isFile() || !opened.isFile() || !sameFile(before, opened) || !sameFile(current, opened)) {
      return outcome('invalid', 'SCOPE_FILE_UNSAFE');
    }
    if (opened.size > MAX_SCOPE_BYTES) return outcome('invalid', 'SCOPE_TOO_LARGE');
    const bytes = Buffer.alloc(MAX_SCOPE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      if (canceled(signal)) return outcome('unavailable', 'SCOPE_CANCELED');
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SCOPE_BYTES) return outcome('invalid', 'SCOPE_TOO_LARGE');
    if (canceled(signal)) return outcome('unavailable', 'SCOPE_CANCELED');
    let document;
    try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { return outcome('invalid', 'SCOPE_INVALID'); }
    if (!document || typeof document !== 'object' || Array.isArray(document) || Object.keys(document).some(key => !['schema_version', 'targets'].includes(key))) {
      return outcome('invalid', 'SCOPE_INVALID');
    }
    let targets;
    try { targets = validateScopeDocument(document).targets; }
    catch { return outcome('invalid', 'SCOPE_INVALID'); }
    if (canceled(signal)) return outcome('unavailable', 'SCOPE_CANCELED');
    return targets.length ? outcome('configured', 'SCOPE_CONFIGURED', targets) : outcome('empty', 'SCOPE_EMPTY');
  } catch (error) {
    return error?.code === 'ELOOP' ? outcome('invalid', 'SCOPE_FILE_UNSAFE') : outcome('unavailable', 'SCOPE_UNAVAILABLE');
  } finally { await handle?.close().catch(() => undefined); }
}

export const readDirectoryScope = readWorkspaceScope;
