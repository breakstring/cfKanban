import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbenchPreferences } from '../src/workbench-preferences.mjs';

const target = () => Object.fromEntries(['instance_id', 'principal_id', 'workspace_id', 'project_id'].map(field => [field, randomUUID()]));
async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cfkanban-workbench-preferences-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.cfkanban');
  const directory = path.join(root, 'workbench', 'codex');
  const file = path.join(directory, 'last-project.json');
  return { home, root, directory, file, preferences: createWorkbenchPreferences({ homeDirectory: home }) };
}

test('missing preference reads create no state and valid targets round-trip as four stable IDs', async t => {
  const f = await fixture(t);
  assert.equal(await f.preferences.load(), null);
  assert.deepEqual(await readdir(f.home), []);
  const record = target();
  assert.equal(await f.preferences.save(record), true);
  assert.deepEqual(await f.preferences.load(), record);
  const bytes = await readFile(f.file, 'utf8');
  assert.deepEqual(JSON.parse(bytes), record);
  assert.deepEqual(await readdir(f.directory), ['last-project.json']);
  if (process.platform !== 'win32') {
    for (const directory of [f.root, path.dirname(f.directory), f.directory]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
  }
});

test('invalid input cannot write Credential, URL, body, snapshots, or unrelated fields', async t => {
  const f = await fixture(t);
  for (const field of ['credential', 'token', 'url', 'body', 'snapshot', 'filter', '__proto__']) {
    assert.equal(await f.preferences.save({ ...target(), [field]: 'PRIVATE_FIXTURE_MARKER' }), false);
  }
  assert.equal(await f.preferences.save({ ...target(), project_id: 'not-a-uuid' }), false);
  assert.equal(await f.preferences.save(Object.create(target())), false);
  const accessors = { ...target() };
  Object.defineProperty(accessors, 'project_id', { get() { throw new Error('Do not read input getters'); } });
  assert.equal(await f.preferences.save(accessors), false);
  assert.equal(await f.preferences.load(), null);
  assert.deepEqual(await readdir(f.home), []);
});

test('malformed, oversized, and unexpected stored fields are neither loaded nor replaced', async t => {
  const f = await fixture(t);
  assert.equal(await f.preferences.save(target()), true);
  for (const raw of ['{', 'null', '[]', 'x'.repeat(1025), JSON.stringify({ ...target(), token: 'PRIVATE_FIXTURE_MARKER' }), JSON.stringify({ ...target(), project_id: 1 })]) {
    await writeFile(f.file, raw, { mode: 0o600 });
    assert.equal(await f.preferences.load(), null);
    assert.equal(await f.preferences.save(target()), false);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
});

test('existing unsafe state permissions are neither used nor repaired', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), record = target();
  assert.equal(await f.preferences.save(record), true);
  for (const unsafe of [f.root, path.dirname(f.directory), f.directory, f.file]) {
    const original = (await lstat(unsafe)).mode & 0o777;
    await chmod(unsafe, unsafe === f.file ? 0o644 : 0o755);
    assert.equal(await f.preferences.load(), null);
    assert.equal(await f.preferences.save(target()), false);
    assert.equal((await lstat(unsafe)).mode & 0o777, unsafe === f.file ? 0o644 : 0o755);
    await chmod(unsafe, original);
  }
  assert.deepEqual(await f.preferences.load(), record);
});

test('symlink roots, descendants, file, and home ancestors are rejected without following them', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.home, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, f.root, 'dir');
  assert.equal(await f.preferences.load(), null);
  assert.equal(await f.preferences.save(target()), false);
  assert.deepEqual(await readdir(outside), []);
  await rm(f.root);
  await mkdir(f.root, { mode: 0o700 });
  await symlink(outside, path.join(f.root, 'workbench'), 'dir');
  assert.equal(await f.preferences.save(target()), false);
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(f.root, 'workbench'));
  assert.equal(await f.preferences.save(target()), true);
  const outsideFile = path.join(outside, 'target.json');
  const outsideRecord = target();
  await writeFile(outsideFile, JSON.stringify(outsideRecord), { mode: 0o600 });
  await rm(f.file);
  await symlink(outsideFile, f.file);
  assert.equal(await f.preferences.load(), null);
  assert.equal(await f.preferences.save(target()), false);
  assert.deepEqual(JSON.parse(await readFile(outsideFile, 'utf8')), outsideRecord);
  const alias = path.join(f.home, 'alias');
  await symlink(outside, alias, 'dir');
  const aliased = createWorkbenchPreferences({ homeDirectory: alias });
  assert.equal(await aliased.load(), null);
  assert.equal(await aliased.save(target()), false);
  await mkdir(path.join(outside, 'home'), { mode: 0o700 });
  const ancestorAlias = createWorkbenchPreferences({ homeDirectory: path.join(alias, 'home') });
  assert.equal(await ancestorAlias.load(), null);
  assert.equal(await ancestorAlias.save(target()), false);
  assert.deepEqual(await readdir(path.join(outside, 'home')), []);
  assert.deepEqual((await readdir(outside)).sort(), ['home', 'target.json']);
});

test('explicit state roots cannot escape home or use repositories and synchronization directories', async t => {
  const f = await fixture(t);
  for (const stateRoot of [f.home, path.dirname(f.home), path.join(f.home, 'Dropbox', '.cfkanban')]) {
    const preferences = createWorkbenchPreferences({ homeDirectory: f.home, stateRoot });
    assert.equal(await preferences.load(), null);
    assert.equal(await preferences.save(target()), false);
  }
  assert.deepEqual(await readdir(f.home), []);
  const repository = path.join(f.home, 'repository');
  await mkdir(repository, { mode: 0o700 });
  await writeFile(path.join(repository, '.git'), 'isolated-repository-fixture', { mode: 0o600 });
  const inRepository = createWorkbenchPreferences({ homeDirectory: f.home, stateRoot: path.join(repository, '.cfkanban') });
  assert.equal(await inRepository.load(), null);
  assert.equal(await inRepository.save(target()), false);
  assert.deepEqual(await readdir(repository), ['.git']);
});

test('concurrent views atomically preserve a whole record and leave no temporary files', async t => {
  const f = await fixture(t), records = Array.from({ length: 20 }, target);
  assert.equal(await f.preferences.save(records[0]), true);
  let finished = false;
  const writes = Promise.all(records.map(record => createWorkbenchPreferences({ homeDirectory: f.home }).save(record))).finally(() => { finished = true; });
  while (!finished) {
    const observed = JSON.parse(await readFile(f.file, 'utf8'));
    assert.ok(records.some(record => JSON.stringify(record) === JSON.stringify(observed)));
  }
  const results = await writes;
  assert.ok(results.some(result => result === true));
  assert.ok(results.every(result => typeof result === 'boolean'));
  const final = await f.preferences.load();
  assert.ok(records.some(record => JSON.stringify(record) === JSON.stringify(final)));
  assert.deepEqual(await readdir(f.directory), ['last-project.json']);
  const newest = target();
  assert.equal(await f.preferences.save(newest), true);
  assert.deepEqual(await f.preferences.load(), newest);
});

test('repository recommendations remain independent from each other and the global preference', async t => {
  const f = await fixture(t), firstKey = 'a'.repeat(64), secondKey = 'b'.repeat(64);
  assert.equal(await f.preferences.load(firstKey), null);
  assert.deepEqual(await readdir(f.home), []);
  const global = target(), first = target(), second = target();
  assert.equal(await f.preferences.save(global), true);
  assert.equal(await f.preferences.load(firstKey), null);
  assert.equal(await f.preferences.save(first, firstKey), true);
  assert.equal(await f.preferences.save(second, secondKey), true);
  assert.deepEqual(await f.preferences.load(), global);
  assert.deepEqual(await f.preferences.load(firstKey), first);
  assert.deepEqual(await f.preferences.load(secondKey), second);
  const directory = path.join(f.directory, 'repositories');
  assert.deepEqual((await readdir(directory)).sort(), [`${firstKey}.json`, `${secondKey}.json`]);
  for (const [key, record] of [[firstKey, first], [secondKey, second]]) {
    const file = path.join(directory, `${key}.json`);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record);
    if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  const replacement = target();
  assert.equal(await f.preferences.save(replacement, firstKey), true);
  assert.deepEqual(await f.preferences.load(firstKey), replacement);
  assert.deepEqual(await f.preferences.load(secondKey), second);
  assert.deepEqual(await f.preferences.load(), global);
});

test('invalid repository keys fail closed without reading or changing the global preference', async t => {
  const f = await fixture(t), record = target();
  assert.equal(await f.preferences.save(record), true);
  for (const key of [null, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(64)}\n`, '../last-project', '/repository', 1, {}, ['a'.repeat(64)]]) {
    assert.equal(await f.preferences.load(key), null);
    assert.equal(await f.preferences.save(target(), key), false);
  }
  assert.deepEqual(await f.preferences.load(), record);
  assert.deepEqual(await readdir(f.directory), ['last-project.json']);
});

test('repository records retain strict fields and reject malformed files without changing other buckets', async t => {
  const f = await fixture(t), key = 'a'.repeat(64), global = target();
  assert.equal(await f.preferences.save(global), true);
  assert.equal(await f.preferences.save({ ...target(), repository_key: key }, key), false);
  assert.equal(await f.preferences.save(target(), key), true);
  const file = path.join(f.directory, 'repositories', `${key}.json`);
  const raw = JSON.stringify({ ...target(), credential: 'PRIVATE_FIXTURE_MARKER' });
  await writeFile(file, raw, { mode: 0o600 });
  assert.equal(await f.preferences.load(key), null);
  assert.equal(await f.preferences.save(target(), key), false);
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.deepEqual(await f.preferences.load(), global);
});

test('repository directory and files reject unsafe permissions, symlinks, and hardlinks', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), key = 'a'.repeat(64), record = target();
  assert.equal(await f.preferences.save(record, key), true);
  const directory = path.join(f.directory, 'repositories');
  const file = path.join(directory, `${key}.json`);
  for (const unsafe of [directory, file]) {
    const original = (await lstat(unsafe)).mode & 0o777;
    await chmod(unsafe, unsafe === file ? 0o644 : 0o755);
    assert.equal(await f.preferences.load(key), null);
    assert.equal(await f.preferences.save(target(), key), false);
    assert.equal((await lstat(unsafe)).mode & 0o777, unsafe === file ? 0o644 : 0o755);
    await chmod(unsafe, original);
  }
  const outsideFile = path.join(f.home, 'outside.json');
  await link(file, outsideFile);
  assert.equal(await f.preferences.load(key), null);
  assert.equal(await f.preferences.save(target(), key), false);
  assert.deepEqual(JSON.parse(await readFile(outsideFile, 'utf8')), record);
  await rm(file);
  await symlink(outsideFile, file);
  assert.equal(await f.preferences.load(key), null);
  assert.equal(await f.preferences.save(target(), key), false);
  assert.deepEqual(JSON.parse(await readFile(outsideFile, 'utf8')), record);
  await rm(directory, { recursive: true });
  const outsideDirectory = path.join(f.home, 'outside');
  await mkdir(outsideDirectory, { mode: 0o700 });
  await symlink(outsideDirectory, directory, 'dir');
  assert.equal(await f.preferences.load(key), null);
  assert.equal(await f.preferences.save(target(), key), false);
  assert.deepEqual(await readdir(outsideDirectory), []);
});
