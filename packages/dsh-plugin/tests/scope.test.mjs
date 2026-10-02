import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { MAX_SCOPE_BYTES, readWorkspaceScope } from '../src/host/scope.mjs';

const target = () => ({ instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() });
async function fixture(t) {
  const created = await mkdtemp(path.join(os.tmpdir(), 'cfkanban dsh scope fixture '));
  const workspacePath = await realpath(created);
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  return { workspacePath, file: path.join(workspacePath, '.cfkanban-scope.json') };
}
const writeScope = (file, targets) => writeFile(file, JSON.stringify({ schema_version: 2, targets }));
function onlySafeResult(result, privatePath = '') {
  assert.deepEqual(Object.keys(result).sort(), ['code', 'status', 'targets']);
  assert.ok(result.targets.every(row => Object.keys(row).sort().join(',') === 'instance_id,project_id,workspace_id'));
  if (privatePath) assert.equal(JSON.stringify(result).includes(privatePath), false);
  assert.equal(JSON.stringify(result).includes('sensitive-marker'), false);
}

test('exact workspace scope returns one bounded UUID target and never changes the source', async t => {
  const f = await fixture(t), selected = target(); await writeScope(f.file, [selected]);
  const before = await readFile(f.file);
  const result = await readWorkspaceScope(f);
  assert.deepEqual(result, { status: 'configured', code: 'SCOPE_CONFIGURED', targets: [selected] });
  assert.deepEqual(await readFile(f.file), before); onlySafeResult(result, f.workspacePath);
});

test('multiple targets preserve schema order, canonicalize UUIDs and deduplicate', async t => {
  const f = await fixture(t), first = target(), second = target();
  await writeScope(f.file, [first, second, Object.fromEntries(Object.entries(first).map(([key, value]) => [key, value.toUpperCase()]))]);
  assert.deepEqual((await readWorkspaceScope(f)).targets, [first, second]);
});

test('missing and empty scope never expand to aggregate or walk a parent directory', async t => {
  const f = await fixture(t), child = path.join(f.workspacePath, 'child'); await mkdir(child);
  assert.deepEqual(await readWorkspaceScope(f), { status: 'missing', code: 'SCOPE_MISSING', targets: [] });
  await writeScope(f.file, [target()]);
  assert.deepEqual(await readWorkspaceScope({ workspacePath: child }), { status: 'missing', code: 'SCOPE_MISSING', targets: [] });
  await writeScope(f.file, []);
  assert.deepEqual(await readWorkspaceScope(f), { status: 'empty', code: 'SCOPE_EMPTY', targets: [] });
});

test('obsolete schemas, invalid UUIDs, malformed JSON and unknown fields fail without echoing input', async t => {
  const f = await fixture(t), selected = target();
  const documents = [
    '{sensitive-marker',
    JSON.stringify({ schema_version: 1, targets: [selected] }),
    JSON.stringify({ schema_version: 2, targets: [{ ...selected, project_id: 'sensitive-marker' }] }),
    JSON.stringify({ schema_version: 2, targets: [selected], secret: 'sensitive-marker' }),
    JSON.stringify({ schema_version: 2, targets: [{ ...selected, path: 'sensitive-marker' }] }),
    JSON.stringify({ schema_version: 2, targets: 'sensitive-marker' }),
    'null',
  ];
  for (const body of documents) {
    await writeFile(f.file, body); const result = await readWorkspaceScope(f);
    assert.deepEqual(result, { status: 'invalid', code: 'SCOPE_INVALID', targets: [] }); onlySafeResult(result, f.workspacePath);
  }
  await writeFile(f.file, Buffer.from([0xff, 0xfe]));
  assert.equal((await readWorkspaceScope(f)).code, 'SCOPE_INVALID');
});

test('scope symlinks and nonregular files are rejected without following their contents', async t => {
  const f = await fixture(t), elsewhere = path.join(f.workspacePath, 'elsewhere'); await writeScope(elsewhere, [target()]);
  await symlink(elsewhere, f.file);
  assert.deepEqual(await readWorkspaceScope(f), { status: 'invalid', code: 'SCOPE_FILE_UNSAFE', targets: [] });
  await rm(f.file); await mkdir(f.file);
  assert.equal((await readWorkspaceScope(f)).code, 'SCOPE_FILE_UNSAFE');
  const link = path.join(f.workspacePath, 'workspace-link'); await symlink(f.workspacePath, link, 'dir');
  assert.equal((await readWorkspaceScope({ workspacePath: link })).code, 'SCOPE_WORKSPACE_UNSAFE');
});

test('oversized files are refused and unavailable workspace errors omit paths and messages', async t => {
  const f = await fixture(t); await writeFile(f.file, ' '.repeat(MAX_SCOPE_BYTES + 1));
  assert.deepEqual(await readWorkspaceScope(f), { status: 'invalid', code: 'SCOPE_TOO_LARGE', targets: [] });
  for (const workspacePath of ['relative', path.join(f.workspacePath, 'sensitive-marker-missing'), f.file]) {
    const result = await readWorkspaceScope({ workspacePath }); assert.equal(result.targets.length, 0); onlySafeResult(result, f.workspacePath);
  }
  const abort = new AbortController(); abort.abort(new Error('sensitive-marker'));
  assert.deepEqual(await readWorkspaceScope(f, { signal: abort.signal }), { status: 'unavailable', code: 'SCOPE_CANCELED', targets: [] });
});

test('the fixed artifact layout loads its packaged schema validator without external dependencies', async t => {
  const f = await fixture(t), selected = target(), packageRoot = path.join(f.workspacePath, 'installed package with spaces');
  await writeScope(f.file, [selected]);
  const sourceRoot = path.resolve(import.meta.dirname, '../../..');
  const modulePath = path.join(packageRoot, 'src/workbench/scope.mjs');
  await mkdir(path.dirname(modulePath), { recursive: true });
  const bundled = await build({ entryPoints: [path.join(sourceRoot, 'packages/local-runtime/src/workbench/scope.mjs')], bundle: true, write: false, format: 'esm', platform: 'node' });
  await writeFile(modulePath, bundled.outputFiles[0].text);
  const installed = await import(pathToFileURL(modulePath).href);
  assert.deepEqual(await installed.readWorkspaceScope(f), { status: 'configured', code: 'SCOPE_CONFIGURED', targets: [selected] });
});
