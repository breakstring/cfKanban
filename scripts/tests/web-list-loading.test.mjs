import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { nuxtUiTestPlugin } from './nuxt-ui-test-plugin.mjs';

const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const events = new EventTarget();
const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const rootPath = `/app/w/${workspaceId}/p/${projectId}`;
const keys = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
globalThis.window = {
  navigator: { languages: ['en'] }, location: { pathname: rootPath, search: '' },
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  setTimeout, clearTimeout, scrollTo() {},
  history: { pushState(_state, _title, path) { const url = new URL(path, 'https://isolated.fixture.invalid'); window.location.pathname = url.pathname; window.location.search = url.search; }, replaceState(_state, _title, path) { this.pushState(_state, _title, path); } },
};
globalThis.document = { cookie: '', getElementById() { return null; }, documentElement: { dataset: {}, toggleAttribute() {} }, addEventListener() {}, removeEventListener() {} };
const output = await build({
  entryPoints: [new URL('../../apps/web/src/views/ProjectBoardView.vue', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [nuxtUiTestPlugin(), { name: 'list-pagination-vue', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      if (!path.endsWith('/ProjectBoardView.vue')) return { contents: 'export default {}', loader: 'js' };
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
      return { contents: compileScript(descriptor, { id: 'list-pagination-test' }).content, loader: 'ts', resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL('../../node_modules/vue/index.mjs', import.meta.url).href, external: true }));
  } }],
});
const { default: Board } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function node() { return { children: [], parent: null }; }
const renderer = createRenderer({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(target, parent) { target.parent = parent; parent.children.push(target); }, remove(target) { target.parent?.children.splice(target.parent.children.indexOf(target), 1); }, parentNode: target => target.parent, nextSibling: () => null });
const apps = new Set();
const flush = async () => { for (let i = 0; i < 24; i++) { await Promise.resolve(); await nextTick(); } };
afterEach(() => { for (const app of apps) app.unmount(); apps.clear(); globalThis.fetch = saved.fetch; });
after(() => Object.assign(globalThis, saved));
const session = { principal: { id: '33333333-3333-4333-8333-333333333333', is_owner: true, version: 1 }, session_id: 'session-fixture', allowed_scope: { kind: 'instance' } };
const row = (key, number) => ({ id: `${key}-${number}`, identifier: `CFK-${number}`, number, title: `Issue ${number}`, status: { key, display_name: key }, version: 1, priority: 'none', labels: [], deleted_at: null, updated_at: '2026-10-04T00:00:00Z' });
function fixture(query = '?view=list', otherProject = projectId) {
  window.location.pathname = `/app/w/${workspaceId}/p/${otherProject}`;
  window.location.search = query;
  const calls = [];
  const response = { intercept: null };
  globalThis.fetch = async (path, init) => {
    assert.equal(init.method, 'GET', 'loading fixtures must stay read only');
    const url = new URL(path, 'https://isolated.fixture.invalid');
    calls.push(url);
    const intercepted = await response.intercept?.(url);
    if (intercepted) return intercepted;
    if (url.pathname.endsWith('/statuses')) return Response.json({ items: keys.map(key => ({ key, display_name: key })), next_cursor: null });
    if (url.pathname.endsWith('/counts')) return Response.json({ counts: Object.fromEntries(keys.map(key => [key, key === 'done' ? 2 : 0])) });
    if (url.pathname.endsWith('/issues')) {
      const key = url.searchParams.get('status');
      const next = url.searchParams.get('cursor');
      return Response.json({ items: [row(key, next ? 2 : 1)], next_cursor: next ? null : `next-${key}`, has_more: !next });
    }
    return Response.json({ id: otherProject, display_name: 'Fixture', workspace_display_name: 'Team', deleted_at: null, allowed_actions: ['read', 'update'] });
  };
  const app = renderer.createApp({ render: () => h({ ...Board, render: () => null }, { workspaceId, projectId: otherProject, session }) });
  app.mount(node()); apps.add(app);
  return { vm: app._instance.subTree.component.setupState, calls, response, pages: () => calls.filter(url => url.pathname.endsWith('/issues')), close() { app.unmount(); apps.delete(app); } };
}

test('list starts with backlog only, first expansion loads once, collapse preserves its independent next cursor', async () => {
  const f = fixture(); await flush();
  assert.deepEqual(f.pages().map(url => url.searchParams.get('status')), ['backlog']);
  assert.equal(f.vm.columns.todo.loaded, false);
  assert.deepEqual([...f.vm.expandedGroups], ['backlog']);
  f.vm.toggleListGroup('todo'); await flush();
  const cached = f.vm.columns.todo.items;
  assert.equal(f.vm.columns.todo.cursor, 'next-todo');
  f.vm.toggleListGroup('todo'); f.vm.toggleListGroup('todo'); await flush();
  assert.equal(f.pages().length, 2);
  assert.equal(f.vm.columns.todo.items, cached);
  await f.vm.loadColumn('todo');
  assert.equal(f.pages().at(-1).searchParams.get('cursor'), 'next-todo');
  assert.equal(f.vm.columns.backlog.cursor, 'next-backlog');
  assert.equal(f.vm.columns.todo.items.length, 2);
});

test('failed first and continuation pages preserve rows and cursor and retry the same group only', async () => {
  const f = fixture(); await flush();
  let fail = true;
  f.response.intercept = url => url.pathname.endsWith('/issues') && url.searchParams.get('status') === 'done' && fail ? new Response('', { status: 503 }) : null;
  f.vm.toggleListGroup('done'); await flush();
  assert.equal(f.vm.columns.done.loaded, false); assert.ok(f.vm.columns.done.error);
  assert.equal(f.vm.columns.todo.loaded, false);
  fail = false; await f.vm.loadColumn('done');
  const cached = f.vm.columns.done.items;
  fail = true; await f.vm.loadColumn('done');
  assert.equal(f.vm.columns.done.items, cached); assert.equal(f.vm.columns.done.cursor, 'next-done');
  fail = false; await f.vm.loadColumn('done');
  assert.equal(f.pages().at(-1).searchParams.get('cursor'), 'next-done');
  assert.equal(f.vm.columns.done.cursor, null);
});

test('board loads all five columns; layout changes reuse loaded pages and list-to-board fills missing columns', async () => {
  const board = fixture(''); await flush();
  assert.deepEqual(board.pages().map(url => url.searchParams.get('status')), keys);
  board.vm.setView('list'); await flush();
  assert.equal(board.pages().length, 5);
  const cached = board.vm.columns.todo.items;
  board.vm.setView('board'); await flush();
  assert.equal(board.pages().length, 5); assert.equal(board.vm.columns.todo.items, cached);
  board.close();
  const list = fixture(); await flush();
  const backlog = list.vm.columns.backlog.items;
  list.vm.setView('board'); await flush();
  assert.deepEqual(list.pages().map(url => url.searchParams.get('status')), keys);
  assert.equal(list.vm.columns.backlog.items, backlog);
});

test('explicit status and restored expansion win over defaults; search keeps other states discoverable without fetching them', async () => {
  const selected = fixture('?view=list&status=done'); await flush();
  assert.deepEqual(selected.pages().map(url => url.searchParams.get('status')), ['done']);
  assert.deepEqual([...selected.vm.expandedGroups], ['done']); selected.close();
  const restored = fixture('?view=list&expanded=todo&expanded=done&q=search'); await flush();
  assert.deepEqual(restored.pages().map(url => url.searchParams.get('status')), ['todo', 'done']);
  assert.ok(restored.pages().every(url => url.searchParams.get('q') === 'search'));
  assert.equal(restored.vm.counts.counts.done, 2); assert.equal(restored.vm.columns.backlog.loaded, false);
  await restored.vm.load();
  assert.deepEqual([...restored.vm.expandedGroups], ['todo', 'done']);
  assert.deepEqual(restored.pages().slice(-2).map(url => url.searchParams.get('status')), ['todo', 'done']);
  restored.close();
  const next = fixture('?view=list', '44444444-4444-4444-8444-444444444444'); await flush();
  assert.deepEqual([...next.vm.expandedGroups], ['backlog']);
  assert.ok(next.pages().every(url => url.pathname.includes('44444444-4444-4444-8444-444444444444')));
});

test('filter changes clear each cursor, preserve chosen expansion, and ignore late old pages', async () => {
  const f = fixture(); await flush(); f.vm.toggleListGroup('todo'); await flush();
  let finish;
  f.response.intercept = url => url.pathname.endsWith('/issues') && url.searchParams.get('cursor') === 'next-todo' ? new Promise(resolve => { finish = resolve; }) : null;
  const old = f.vm.loadColumn('todo'); await flush();
  f.vm.priorities = ['high'];
  assert.equal(f.vm.columns.todo.cursor, null);
  await new Promise(resolve => setTimeout(resolve, 200)); await flush();
  finish(Response.json({ items: [row('todo', 99)], next_cursor: null, has_more: false })); await old;
  assert.ok(f.vm.columns.todo.items.every(issue => issue.number !== 99));
  assert.deepEqual([...f.vm.expandedGroups], ['backlog', 'todo']);
  assert.deepEqual(f.pages().slice(-2).map(url => [url.searchParams.get('status'), url.searchParams.get('priority'), url.searchParams.get('cursor')]), [['backlog', 'high', null], ['todo', 'high', null]]);
  f.vm.changeStatusFilter('done'); await new Promise(resolve => setTimeout(resolve, 200)); await flush();
  assert.equal(f.pages().at(-1).searchParams.get('status'), 'done');
  assert.deepEqual([...f.vm.expandedGroups], ['done']);
});
