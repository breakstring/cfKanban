import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersistentSearchIndex } from '../src/search-cache.mjs';

async function fixture(t, options = {}) {
  const homeDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cfkanban-search-home-')));
  const stateRoot = path.join(homeDirectory, '.cfkanban');
  const identity = { instance_id: randomUUID(), principal_id: randomUUID(), trusted_api_origin: 'https://search.example.test', origin_version: 1 };
  const workspace = { id: randomUUID(), display_name: 'Development' };
  const project = { id: randomUUID(), display_name: 'Plugin', workspace, revision: 0, cursor: 'snapshot:0' };
  const documents = [{ id: randomUUID(), number: 600, identifier: 'CFK-600', title: 'Codex 插件搜索优化', project_id: project.id, revision: 0 }];
  const state = { identity, projects: [project], documents, changes: [], epoch: 'epoch-1', scope_key: 'scope-1', calls: [], after: 'delta:0' };
  const ok = data => ({ ok: true, status: 200, data, reference_identity: { ...state.identity } });
  const facade = {
    async inspectSearchIdentity() { return { ok: true, data: { ...state.identity } }; },
    async readSearchStatus(args) {
      state.calls.push(['status', args]);
      return ok({ instance_id: state.identity.instance_id, projection_version: 1, epoch: state.epoch, scope_key: state.scope_key, projects: state.projects });
    },
    async readSearchSnapshot(args) {
      state.calls.push(['snapshot', args]);
      return ok({ items: state.documents.filter(item => item.project_id === args.project_id), has_more: false, next_cursor: state.after });
    },
    async readSearchChanges(args) {
      state.calls.push(['changes', args]);
      return ok({ items: state.changes.filter(item => item.project_id === args.project_id), has_more: false, next_cursor: state.after,
        revision: state.projects.find(project => project.id === args.project_id).revision });
    },
  };
  const caches = [];
  const createCache = extra => {
    const cache = new PersistentSearchIndex({ facade, homeDirectory, stateRoot, syncIntervalMs: 1_000_000, ...options, ...extra });
    caches.push(cache);
    return cache;
  };
  const cache = createCache();
  t.after(async () => { await Promise.allSettled(caches.map(cache => cache.dispose())); await rm(homeDirectory, { recursive: true, force: true }); });
  const search = query => cache.search({ instance_id: state.identity.instance_id, query });
  const sync = async () => { cache.start({ instance_id: state.identity.instance_id }); return cache.synchronize({ instance_id: state.identity.instance_id }); };
  const file = () => path.join(stateRoot, 'search-index', state.identity.instance_id, state.identity.principal_id, 'index.sqlite3');
  return { cache, createCache, facade, state, identity, workspace, project, documents, homeDirectory, stateRoot, search, sync, file };
}

test('cold cache reports warming, then queries persistent metadata without waiting for HTTP', async t => {
  const f = await fixture(t);
  const cold = await f.search({ kind: 'title', text: '搜索' });
  assert.equal(cold.error.code, 'MCP_SEARCH_INDEX_WARMING');
  assert.equal(f.state.calls.length, 0);
  assert.equal(await f.sync(), true);
  const before = f.state.calls.length;
  const result = await f.search({ kind: 'title', text: '搜索' });
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].identifier, 'CFK-600');
  assert.deepEqual(result.reference_identity, f.identity);
  assert.equal(f.state.calls.length, before);
  assert.equal((await lstat(f.file())).mode & 0o777, 0o600);
  assert.equal((await readFile(f.file())).subarray(0, 16).toString(), 'SQLite format 3\0');
  await f.cache.dispose();
  f.facade.readSearchStatus = async () => { throw new Error('offline'); };
  const reopened = f.createCache();
  t.after(() => reopened.dispose());
  const persisted = await reopened.search({ instance_id: f.identity.instance_id, query: { kind: 'identifier', identifier: 'CFK-600' } });
  assert.equal(persisted.data.items[0].title, f.documents[0].title);
});

test('exact identifiers sort first, prefixes and literal title keywords return at most ten', async t => {
  const f = await fixture(t);
  f.state.documents = [60, ...Array.from({ length: 15 }, (_, index) => 600 + index), 6].map(number => ({
    id: randomUUID(), project_id: f.project.id, revision: 0, number, title: number === 600 ? '100%_ Search' : `Search ${number}`,
  }));
  await f.sync();
  const exact = await f.search({ kind: 'identifier', identifier: 'CFK-60' });
  assert.equal(exact.data.items.length, 10);
  assert.equal(exact.data.items[0].number, 60);
  assert.equal((await f.search({ kind: 'identifier', identifier: 'CFK-6' })).data.items.length, 1);
  assert.equal((await f.search({ kind: 'identifier', identifier: 'CFK-60', exactOnly: true })).data.items.length, 1);
  assert.equal((await f.search({ kind: 'prefix', prefix: '60' })).data.items.length, 10);
  const literal = await f.search({ kind: 'title', text: '%_' });
  assert.equal(literal.data.items.length, 1);
  assert.equal(literal.data.items[0].number, 600);
});

test('delta upsert and tombstones keep newer document revisions and leave stale metadata until sync', async t => {
  const f = await fixture(t);
  await f.sync();
  f.project.revision = 2;
  f.state.after = 'delta:2';
  f.state.changes = [{ ...f.documents[0], kind: 'upsert', title: '新的标题', revision: 2 }, { ...f.documents[0], kind: 'upsert', title: '迟到的旧标题', revision: 1 }];
  assert.equal((await f.search({ kind: 'identifier', identifier: 'CFK-600' })).data.items[0].title, f.documents[0].title);
  await f.sync();
  assert.equal((await f.search({ kind: 'identifier', identifier: 'CFK-600' })).data.items[0].title, '新的标题');
  f.project.revision = 3;
  f.state.after = 'delta:3';
  f.state.changes = [{ ...f.documents[0], kind: 'remove', title: '', revision: 3 }];
  await f.sync();
  assert.equal((await f.search({ kind: 'identifier', identifier: 'CFK-600' })).data.items.length, 0);
});

test('new project permissions snapshot pre-existing issues and revoked projects are removed at background sync', async t => {
  const f = await fixture(t);
  await f.sync();
  const added = { ...f.project, id: randomUUID(), display_name: 'Newly granted', cursor: 'snapshot:new' };
  f.state.projects.push(added);
  f.state.scope_key = 'scope-2';
  f.state.documents.push({ id: randomUUID(), project_id: added.id, revision: 0, number: 601, title: '授权前已有的事项' });
  const previousSnapshots = f.state.calls.filter(([kind]) => kind === 'snapshot').length;
  await f.sync();
  const snapshots = f.state.calls.filter(([kind]) => kind === 'snapshot');
  assert.equal(snapshots.length, previousSnapshots + 1);
  assert.equal(snapshots.at(-1)[1].project_id, added.id);
  assert.equal((await f.search({ kind: 'title', text: '已有' })).data.items[0].project.id, added.id);
  f.state.projects = [added];
  f.state.scope_key = 'scope-3';
  assert.equal((await f.search({ kind: 'identifier', identifier: 'CFK-600' })).data.items.length, 1);
  await f.sync();
  assert.equal((await f.search({ kind: 'identifier', identifier: 'CFK-600' })).data.items.length, 0);
});

test('instance, local Principal and origin changes isolate the persisted index immediately', async t => {
  const f = await fixture(t);
  await f.sync();
  f.state.identity = { ...f.identity, principal_id: randomUUID() };
  assert.equal((await f.search({ kind: 'title', text: '插件' })).error.code, 'MCP_SEARCH_INDEX_WARMING');
  f.state.identity = { ...f.identity, instance_id: randomUUID() };
  assert.equal((await f.search({ kind: 'title', text: '插件' })).error.code, 'MCP_SEARCH_INDEX_WARMING');
  f.state.identity = { ...f.identity, trusted_api_origin: 'https://moved.example.test', origin_version: 2 };
  assert.equal((await f.search({ kind: 'title', text: '插件' })).error.code, 'MCP_SEARCH_INDEX_WARMING');
});

test('unfinished snapshot is invisible and restarts from its committed page cursor', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.facade.readSearchSnapshot = async args => {
    f.state.calls.push(['snapshot', args]);
    if (args.cursor === 'snapshot:0') return { ok: true, data: { items: f.documents, has_more: true, next_cursor: 'snapshot:page2' }, reference_identity: f.identity };
    if (++attempts === 1) return { ok: false, status: 503, error: { code: 'TEMPORARY_FAILURE' } };
    return { ok: true, data: { items: [], has_more: false, next_cursor: 'delta:0' }, reference_identity: f.identity };
  };
  assert.equal(await f.sync(), false);
  assert.equal((await f.search({ kind: 'title', text: '插件' })).error.code, 'TEMPORARY_FAILURE');
  await f.cache.dispose();
  const reopened = f.createCache();
  t.after(() => reopened.dispose());
  assert.equal(await reopened.synchronize({ instance_id: f.identity.instance_id }), true);
  const snapshotCursors = f.state.calls.filter(([kind]) => kind === 'snapshot').map(([, args]) => args.cursor);
  assert.deepEqual(snapshotCursors, ['snapshot:0', 'snapshot:page2', 'snapshot:page2']);
  assert.equal((await reopened.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '插件' } })).data.items.length, 1);
});

test('sync page budget pauses at a committed cursor and resumes without exposing staging', async t => {
  const f = await fixture(t, { maxPagesPerCycle: 1 });
  assert.equal(await f.sync(), false);
  assert.equal((await f.search({ kind: 'title', text: '插件' })).error.code, 'MCP_SEARCH_INDEX_WARMING');
  assert.equal(f.state.calls.filter(([kind]) => kind === 'snapshot').length, 1);
  assert.equal(await f.sync(), true);
  assert.equal(f.state.calls.filter(([kind]) => kind === 'snapshot').length, 1);
  assert.equal((await f.search({ kind: 'title', text: '插件' })).data.items.length, 1);
});

test('expired incremental cursor rebuilds only the affected project', async t => {
  const f = await fixture(t);
  await f.sync();
  f.project.revision = 1;
  let expired = true;
  const original = f.facade.readSearchChanges;
  f.facade.readSearchChanges = args => {
    if (expired) { expired = false; return { ok: false, status: 409, error: { code: 'SEARCH_INDEX_RESET_REQUIRED' } }; }
    return original(args);
  };
  f.state.documents[0].title = '重建后的标题';
  await f.sync();
  assert.equal(f.state.calls.filter(([kind]) => kind === 'snapshot').length, 2);
  assert.equal((await f.search({ kind: 'title', text: '重建' })).data.items.length, 1);
});

test('interrupted active delta resumes remaining pages even when the project head is unchanged', async t => {
  const f = await fixture(t, { maxPagesPerCycle: 1 });
  await f.sync();
  assert.equal(await f.sync(), true);
  f.project.revision = 2;
  f.facade.readSearchChanges = async args => {
    f.state.calls.push(['changes', args]);
    const firstPage = args.after === 'delta:0';
    return { ok: true, reference_identity: f.identity, data: {
      items: [{ ...f.documents[0], kind: 'upsert', title: firstPage ? '第一页标题' : '第二页最终标题', revision: firstPage ? 1 : 2 }],
      has_more: firstPage, next_cursor: firstPage ? 'delta:1' : 'delta:2', revision: 2,
    } };
  };
  assert.equal(await f.sync(), false);
  assert.equal((await f.search({ kind: 'title', text: '第一页' })).data.items.length, 1);
  await f.cache.dispose();
  const reopened = f.createCache();
  assert.equal(await reopened.synchronize({ instance_id: f.identity.instance_id }), true);
  assert.equal(f.state.calls.filter(([kind]) => kind === 'changes').at(-1)[1].after, 'delta:1');
  assert.equal((await reopened.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '最终' } })).data.items.length, 1);
});

test('unchanged project heads use status only and cold capability errors remain actionable', async t => {
  const f = await fixture(t);
  await f.sync();
  const before = f.state.calls.length;
  await f.sync();
  assert.deepEqual(f.state.calls.slice(before).map(([kind]) => kind), ['status']);
  f.state.identity = { ...f.identity, principal_id: randomUUID() };
  f.facade.readSearchStatus = async () => ({ ok: false, status: 0, error: { code: 'MCP_SEARCH_INDEX_UNSUPPORTED' } });
  assert.equal(await f.sync(), false);
  const result = await f.search({ kind: 'title', text: '插件' });
  assert.equal(result.error.code, 'MCP_SEARCH_INDEX_UNSUPPORTED');
});

test('search cancellation returns promptly without cancelling shared background synchronization', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.cache.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '插件' } }, { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).error.code, 'MCP_REQUEST_CANCELLED');
  assert.equal(await f.sync(), true);
  assert.equal((await f.search({ kind: 'title', text: '插件' })).data.items.length, 1);
});

test('independent Worker connections share a persisted lease so only one performs snapshot HTTP', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => release = resolve);
  const original = f.facade.readSearchSnapshot;
  let started;
  const observed = new Promise(resolve => started = resolve);
  f.facade.readSearchSnapshot = async args => { started(); await gate; return original(args); };
  const other = f.createCache();
  t.after(() => other.dispose());
  const first = f.cache.synchronize({ instance_id: f.identity.instance_id });
  await observed;
  assert.equal(await other.synchronize({ instance_id: f.identity.instance_id }), false);
  release();
  assert.equal(await first, true);
  assert.equal((await other.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '插件' } })).data.items.length, 1);
  assert.equal(f.state.calls.filter(([kind]) => kind === 'snapshot').length, 1);
});

test('a separate operating-system process owns the same SQLite sync lease', async t => {
  const f = await fixture(t);
  const code = `
    import { PersistentSearchIndex } from ${JSON.stringify(new URL('../src/search-cache.mjs', import.meta.url).href)};
    let release, cache;
    process.on('message', async message => {
      if (message.kind === 'release') { release(); return; }
      if (message.kind !== 'start') return;
      const {identity,project,documents,homeDirectory,stateRoot}=message;
      const ok=data=>({ok:true,data,reference_identity:identity});
      cache=new PersistentSearchIndex({homeDirectory,stateRoot,facade:{
        inspectSearchIdentity:async()=>({ok:true,data:identity}),
        readSearchStatus:async()=>ok({projection_version:1,epoch:'epoch-1',scope_key:'scope-1',projects:[project]}),
        readSearchSnapshot:async()=>{process.send({kind:'snapshot-started'});await new Promise(resolve=>release=resolve);return ok({items:documents,has_more:false,next_cursor:'delta:0'});},
        readSearchChanges:async()=>ok({items:[],has_more:false,next_cursor:'delta:0',revision:0})
      }});
      const result=await cache.synchronize({instance_id:identity.instance_id});
      await cache.dispose();process.send({kind:'finished',result});process.disconnect();
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, HOME: f.homeDirectory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(() => child.kill());
  const waitFor = kind => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child process did not report ${kind}`)), 5000);
    const receive = message => {
      if (message.kind !== kind) return;
      clearTimeout(timeout); child.off('message', receive); resolve(message);
    };
    child.on('message', receive);
  });
  const started = waitFor('snapshot-started');
  child.send({ kind: 'start', identity: f.identity, project: f.project, documents: f.documents, homeDirectory: f.homeDirectory, stateRoot: f.stateRoot });
  await started;
  assert.equal(await f.cache.synchronize({ instance_id: f.identity.instance_id }), false);
  assert.equal(f.state.calls.length, 0);
  const finished = waitFor('finished');
  child.send({ kind: 'release' });
  assert.equal((await finished).result, true);
  assert.equal((await f.search({ kind: 'title', text: '插件' })).data.items.length, 1);
});

test('active search syncs on interval, stops when idle and resumes without waiting for a blocked refresh', async t => {
  let now = 0;
  const f = await fixture(t, { now: () => now, syncIntervalMs: 20, idleTimeoutMs: 50, hintDelayMs: 5 });
  await f.sync();
  const statusCalls = () => f.state.calls.filter(([kind]) => kind === 'status').length;
  const initial = statusCalls();
  now = 20;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(statusCalls() > initial);
  now = 100;
  const beforeIdle = statusCalls();
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal(statusCalls(), beforeIdle);
  let release;
  let began;
  const blocked = new Promise(resolve => began = resolve);
  const gate = new Promise(resolve => release = resolve);
  const original = f.facade.readSearchStatus;
  f.facade.readSearchStatus = async args => { began(); await gate; return original(args); };
  const result = await f.search({ kind: 'title', text: '插件' });
  assert.equal(result.data.items.length, 1);
  await blocked;
  const during = await f.search({ kind: 'title', text: '插件' });
  assert.equal(during.data.items.length, 1);
  release();
});

test('capacity overflow fails explicitly and rolls back the whole snapshot page', async t => {
  const f = await fixture(t, { maxDocuments: 1 });
  f.state.documents.push({ ...f.documents[0], id: randomUUID(), number: 601, title: '超过容量' });
  assert.equal(await f.sync(), false);
  assert.equal((await f.search({ kind: 'title', text: '搜索' })).error.code, 'MCP_SEARCH_INDEX_CAPACITY_EXCEEDED');
  f.state.documents.pop();
  assert.equal(await f.sync(), true);
  assert.equal((await f.search({ kind: 'title', text: '搜索' })).data.items.length, 1);
});

test('corrupt regular private SQLite is safely rebuilt and warmed from the service', async t => {
  const f = await fixture(t);
  await f.sync();
  await f.cache.dispose();
  await writeFile(f.file(), 'corrupted SQLite bytes', { mode: 0o600 });
  const reopened = f.createCache();
  const result = await reopened.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '插件' } });
  assert.equal(result.error.code, 'MCP_SEARCH_INDEX_WARMING');
  assert.equal(await reopened.synchronize({ instance_id: f.identity.instance_id }), true);
  assert.equal((await reopened.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '插件' } })).data.items.length, 1);
  assert.deepEqual((await readdir(path.dirname(f.file()))).sort(), ['index.sqlite3']);
});

test('unsafe existing directories, symlinks and hardlinks fail without repairing permissions', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await mkdir(f.stateRoot, { mode: 0o755 });
  await chmod(f.stateRoot, 0o755);
  assert.equal((await f.search({ kind: 'title', text: '插件' })).error.code, 'MCP_SEARCH_INDEX_UNAVAILABLE');
  assert.equal((await lstat(f.stateRoot)).mode & 0o777, 0o755);
  await f.cache.dispose();
  await chmod(f.stateRoot, 0o700);
  const safe = f.createCache();
  t.after(() => safe.dispose());
  await safe.synchronize({ instance_id: f.identity.instance_id });
  await safe.dispose();
  const indexFile = f.file();
  const target = path.join(f.homeDirectory, 'other.sqlite3');
  await link(indexFile, target);
  const hardlinked = f.createCache();
  t.after(() => hardlinked.dispose());
  assert.equal((await hardlinked.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '插件' } })).error.code, 'MCP_SEARCH_INDEX_UNAVAILABLE');
  await hardlinked.dispose();
  await rm(indexFile);
  await symlink(target, indexFile);
  const linked = f.createCache();
  t.after(() => linked.dispose());
  assert.equal((await linked.search({ instance_id: f.identity.instance_id, query: { kind: 'title', text: '插件' } })).error.code, 'MCP_SEARCH_INDEX_UNAVAILABLE');
});
