import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, afterEach } from 'node:test';
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
globalThis.window = { location: { pathname: "/app/work", search: "" }, navigator: { languages: ["en"] }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
afterEach(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; locale.value = "en"; });
after(() => { globalThis.window = originalWindow; });
const originalDocumentClass = globalThis.Document;
const originalShadowRoot = globalThis.ShadowRoot;
globalThis.Document = class {};
globalThis.ShadowRoot = class {};
after(() => { globalThis.Document = originalDocumentClass; globalThis.ShadowRoot = originalShadowRoot; });
import { build } from 'esbuild';
import { nuxtUiTestPlugin } from './nuxt-ui-test-plugin.mjs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Search } from './apps/web/src/components/ProjectSearch.vue'; export { default as Board } from './apps/web/src/views/ProjectBoardView.vue'; export { locale } from './apps/web/src/lib/i18n.ts'; export { projectSearchCandidates, typedIssueSearch, nextSearchCandidateId } from './apps/web/src/lib/project-search.ts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  plugins: [nuxtUiTestPlugin(), { name: 'vue-test', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
      const compiled = compileScript(descriptor, { id: 'attachment-test', inlineTemplate: true });
      return { contents: compiled.content, loader: 'ts', resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL('../../node_modules/vue/index.mjs', import.meta.url).href, external: true }));
  } }],
});
const { Search, Board, locale, projectSearchCandidates, typedIssueSearch, nextSearchCandidateId } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function node(tag, text = '') { return { tag, text, children: [], props: {}, parent: null, focus() {}, getRootNode() { return {}; }, addEventListener() {}, removeEventListener() {}, get options() { return this.children; }, get tagName() { return this.tag.toUpperCase(); } }; }
const renderer = createRenderer({
  createElement: (tag) => node(tag), createText: (text) => node('#text', text), createComment: (text) => node('#comment', text),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; },
  insert(target, parent, anchor = null) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent;
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, target);
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); },
  parentNode: (target) => target.parent,
  nextSibling: (target) => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insertStaticContent(text, parent, anchor) { const target = node('#static', text); target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, target); return [target, target]; },
});
function all(target) { return [target, ...target.children.flatMap(all)]; }
function text(target) { return target.text + target.children.map(text).join(''); }
async function until(check) {
  for (let step = 0; step < 100; step++) { await new Promise((done) => setTimeout(done, 5)); await nextTick(); if (check()) return; }
  assert.fail('component did not reach expected state');
}
const workspace = '00000000-0000-4000-8000-000000000001';
const p1 = '00000000-0000-4000-8000-000000000002';
const p2 = '00000000-0000-4000-8000-000000000003';
const principal = '00000000-0000-4000-8000-000000000004';
const projects = [p1, p2].map((id, index) => ({ workspace_id: workspace, workspace_display_name: 'Team', project_id: id, project_display_name: `Project ${index}`, role: index ? 'reader' : 'writer' }));
const session = { allowed_scope: { kind: 'project_selection', projects }, principal: { id: principal, display_name: 'Pat', is_owner: false } };
const page = (items, cursor = null) => ({ items, has_more: !!cursor, next_cursor: cursor });
const workflowStatuses = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
function issueCounts(values = {}) {
  const counts = { ...Object.fromEntries(workflowStatuses.map(key => [key, 0])), ...values };
  return { counts, total_count: Object.values(counts).reduce((sum, count) => sum + count, 0), resolved_scope: {
    broad_search: false, expanded_to_all_authorized_projects: false, project_targets: [],
    projects: [{ project_id: p1, project_display_name: 'Project 0', workspace_id: workspace, workspace_display_name: 'Team' }],
    filters: { assignees: [], statuses: [] }, target_identifier: null, unresolved_project_targets: [],
    unresolved_workspace_targets: [], workspace_targets: [],
  } };
}
const submit = host => all(host).find(item => item.tag === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
const mount = (component, props) => { const app = renderer.createApp(component, props); const host = node('root'); app.mount(host); return { app, host }; };

const issue = (number, overrides = {}) => ({ id: `issue-${number}`, number, identifier: `CFK-${number}`, title: 'Ｆｉｘ 登录',
  status: { key: 'todo', display_name: 'Todo' }, priority: 'none', labels: [], workspace: { id: workspace }, project: { id: p1 },
  deleted_at: null, updated_at: '2026-10-06T00:00:00.000Z', version: 1, ...overrides });
const input = host => all(host).find(item => item.tag === 'input' && item.props.role === 'combobox');
const options = host => all(host).filter(item => item.props.role === 'option');
function fixture(items = [issue(62), issue(620)]) {
  const state = ref({ modelValue: '', issues: items, disabled: false, resetKey: 'initial' });
  const events = [];
  const Wrapper = { setup: () => () => h(Search, { ...state.value, projectId: p1, appliedSearch: 'prior search',
    'onUpdate:modelValue': value => { state.value.modelValue = value; }, onSearch: () => events.push(['search']), onOpen: value => events.push(['open', value]) }) };
  const mounted = mount(Wrapper);
  input(mounted.host).props.onFocus();
  return { ...mounted, state, events };
}
async function type(host, value) { input(host).props.onInput({ target: { value } }); await nextTick(); }
function key(host, value, extras = {}) {
  let prevented = false;
  input(host).props.onKeydown({ key: value, preventDefault() { prevented = true; }, ...extras });
  return prevented;
}

test('typed input has shared NFKC/case, Unicode, numeric-only, safe integer and byte boundaries', () => {
  for (const value of ['CFK-62', 'cfk-62', 'ＣＦＫ－６２', '62', '６２']) assert.equal(typedIssueSearch(value).kind, 'number');
  for (const value of ['登录', '😀😀', 'Fix', '  ＦＩＸ  ']) assert.equal(typedIssueSearch(value).kind, 'title');
  for (const value of ['1', 'a', '0', '01', 'CFK-01', 'CFK-x', '9007199254740992', 'a'.repeat(129), '登'.repeat(43)]) assert.equal(typedIssueSearch(value).kind, 'invalid');
  assert.equal(typedIssueSearch('CFK-1').kind, 'number');
  assert.equal(typedIssueSearch('  ').kind, 'empty');
  assert.equal(typedIssueSearch('a'.repeat(128)).kind, 'title');
});

test('real loaded candidates deduplicate latest stable IDs, exclude deleted/other Projects and truncate after ordering', () => {
  const rows = [issue(620), issue(62), ...Array.from({ length: 12 }, (_, n) => issue(621 + n)), issue(6299),
    issue(99, { title: '62 numeric title' }), issue(623, { project: { id: p2 } }), issue(624, { version: 9, deleted_at: 'deleted' }),
    issue(622, { version: 5, title: 'Latest title' }), issue(622, { version: 2, title: 'Old title' })];
  const result = projectSearchCandidates(rows, p1, typedIssueSearch('62'));
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.items.map(row => row.number), [62,620,621,622,623,625,626,627,628,629]);
  assert.equal(result.items.find(row => row.number === 622).title, 'Latest title');
  assert.deepEqual(projectSearchCandidates([issue(620), issue(621)], p1, typedIssueSearch('CFK-62')).items.map(row => row.number), [620,621]);
  assert.deepEqual(projectSearchCandidates(rows, p1, typedIssueSearch('不存在')).items, []);
  const titles = projectSearchCandidates([issue(4), issue(8), issue(1, { updated_at: '2026-10-06T01:00:00.000Z' })], p1, typedIssueSearch('ＦＩＸ'));
  assert.deepEqual(titles.items.map(row => row.number), [1,8,4]);
  assert.equal(nextSearchCandidateId(result.items, null, 'ArrowDown'), 'issue-62');
  assert.equal(nextSearchCandidateId(result.items, null, 'ArrowUp'), 'issue-629');
});

test('typing sends no requests; default Enter submits while explicit arrow selection opens and Escape clears it', async () => {
  globalThis.fetch = () => assert.fail('typing or local shortcuts must not fetch');
  const f = fixture();
  try {
    await type(f.host, '62');
    assert.equal(options(f.host).length, 2);
    assert.equal(input(f.host).props['aria-expanded'], true);
    assert.equal(input(f.host).props['aria-activedescendant'], undefined);
    assert.match(text(f.host), /currently loaded results.*currently applied search/);
    assert.equal(key(f.host, 'Enter'), false);
    submit(f.host); await nextTick();
    assert.deepEqual(f.events, [['search']]);
    await type(f.host, '62');
    assert.equal(key(f.host, 'ArrowDown'), true); await nextTick();
    assert.equal(input(f.host).props['aria-activedescendant'], 'project-search-issue-62');
    assert.equal(key(f.host, 'Enter'), true); await nextTick();
    assert.deepEqual(f.events, [['search'], ['open', 'CFK-62']]);
    await type(f.host, '62'); key(f.host, 'ArrowDown'); key(f.host, 'Escape'); await nextTick();
    assert.equal(input(f.host).props['aria-expanded'], false);
    assert.equal(input(f.host).props['aria-activedescendant'], undefined);
    key(f.host, 'Enter'); submit(f.host); assert.deepEqual(f.events.at(-1), ['search']);
  } finally { f.app.unmount(); }
});

test('IME, disabled writes, removed IDs, pointerdown and identity resets preserve safe local navigation', async () => {
  const f = fixture();
  try {
    await type(f.host, '62'); key(f.host, 'ArrowDown'); await nextTick();
    f.state.value.issues = [issue(620)]; await nextTick();
    assert.equal(input(f.host).props['aria-activedescendant'], undefined);
    input(f.host).props.onCompositionstart(); await type(f.host, '登录');
    assert.equal(key(f.host, 'Enter', { isComposing: true }), true); submit(f.host);
    assert.deepEqual(f.events, []);
    input(f.host).props.onCompositionend({ target: { value: '登录' } }); await nextTick();
    assert.equal(options(f.host).length, 1);
    let prevented = false;
    options(f.host)[0].props.onPointerdown({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    options(f.host)[0].props.onClick(); assert.deepEqual(f.events, [['open', 'CFK-620']]);
    await type(f.host, '62'); key(f.host, 'ArrowDown'); f.state.value.disabled = true; await nextTick();
    submit(f.host); key(f.host, 'Enter'); assert.equal(f.events.length, 1);
    assert.equal(input(f.host).props['aria-activedescendant'], undefined);
    f.state.value.disabled = false; f.state.value.resetKey = 'another-principal'; await nextTick();
    assert.equal(f.state.value.modelValue, ''); assert.equal(options(f.host).length, 0);
  } finally { f.app.unmount(); }
});

test('short and overlong text show input guidance and prevent Project submission; empty input can clear search', async () => {
  const f = fixture();
  try {
    for (const value of ['1', 'a', 'a'.repeat(129)]) {
      await type(f.host, value); submit(f.host); assert.deepEqual(f.events, []);
      assert.equal(options(f.host).length, 0);
      assert.ok(all(f.host).some(item => item.props.role === 'status'));
    }
    await type(f.host, '无匹配'); assert.match(text(f.host), /No match among loaded issues/);
    await type(f.host, ''); submit(f.host); assert.deepEqual(f.events, [['search']]);
    locale.value = 'zh-CN'; await type(f.host, '不存在'); assert.match(text(f.host), /已加载事项中未找到，可搜索项目/);
  } finally { f.app.unmount(); }
});

test('Board and List typing keep applied list/counts/pages unchanged; explicit submission shares typed mode', async () => {
  for (const view of ['', '?view=list']) {
    window.location.search = view;
    const calls = [];
    globalThis.fetch = async path => {
      const url = new URL(String(path), 'https://kanban.example.test'); calls.push(url);
      if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts({ backlog: 1, todo: 2 }));
      if (url.pathname.endsWith('/statuses')) return Response.json(page(workflowStatuses.map(key => ({ key, display_name: key }))));
      if (url.pathname.endsWith('/issues')) return Response.json(page(url.searchParams.get('status') === (view ? 'backlog' : 'todo') ? [issue(62, { status: { key: view ? 'backlog' : 'todo', display_name: 'Loaded' } })] : []));
      return Response.json({ id: p1, display_name: 'Search board', workspace_display_name: 'Team', deleted_at: null });
    };
    const f = mount(Board, { session, projectId: p1, workspaceId: workspace });
    try {
      await until(() => input(f.host) && !input(f.host).props.disabled);
      const before = calls.length; input(f.host).props.onFocus();
      await type(f.host, '62'); await type(f.host, '不存在'); await type(f.host, '62');
      assert.equal(calls.length, before, 'input sends zero list/count/metadata requests');
      assert.equal(options(f.host).length, 1);
      key(f.host, 'Enter'); submit(f.host);
      await until(() => calls.length > before && !input(f.host).props.disabled);
      const queries = calls.slice(before).filter(url => url.pathname.endsWith('/issues') || url.pathname.endsWith('/issues/counts'));
      assert.ok(queries.length >= 2);
      for (const url of queries) { assert.equal(url.searchParams.get('q'), '62'); assert.equal(url.searchParams.get('q_mode'), 'typed'); }
      if (view) assert.equal(queries.filter(url => url.pathname.endsWith('/issues')).length, 1, 'typing and submit do not expand unloaded groups');
    } finally { f.app.unmount(); }
  }
  window.location.search = '';
});
