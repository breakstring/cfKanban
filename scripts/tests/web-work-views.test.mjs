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
  stdin: { contents: `export { default as WorkList } from './apps/web/src/views/WorkListView.vue'; export { default as Board } from './apps/web/src/views/ProjectBoardView.vue'; export { default as LabelsPage } from './apps/web/src/views/ProjectLabelsView.vue'; export { default as ManagementPage } from './apps/web/src/views/ScopedManagementView.vue'; export { default as SettingsHeader } from './apps/web/src/components/ProjectSettingsHeader.vue'; export { ownerProjectSettingsPath, ownerWorkspaceSettingsPath, ownerWorkspacesReturnPath, projectSettingsPath, projectSettingsSections } from './apps/web/src/lib/project-settings.ts'; export { default as Activity } from './apps/web/src/components/ProjectActivity.vue'; export { default as ActivityPage } from './apps/web/src/views/ProjectActivityView.vue'; export { default as DeletedPage } from './apps/web/src/views/ProjectDeletedIssuesView.vue'; export { default as Share } from './apps/web/src/components/IssueShare.vue'; export { default as Copy } from './apps/web/src/components/CopyButton.vue'; export { default as Footer } from './apps/web/src/components/AppFooter.vue'; export { navigate, registerNavigationGuard, currentPath } from './apps/web/src/lib/router.ts'; export { boardFilters, boardPath, boardReturnPath } from './apps/web/src/lib/board-navigation.ts'; export { workListPath, workProjects } from './apps/web/src/lib/work-list.ts'; export { activityTargets } from './apps/web/src/lib/project-activity.ts'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
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
const { WorkList, Board, LabelsPage, ManagementPage, SettingsHeader, ownerProjectSettingsPath, ownerWorkspaceSettingsPath, ownerWorkspacesReturnPath, projectSettingsPath, projectSettingsSections, Activity, ActivityPage, DeletedPage, Share, Copy, Footer, navigate, registerNavigationGuard, currentPath, boardFilters, boardPath, boardReturnPath, workListPath, workProjects, activityTargets, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);



function node(tag, text = '') { return { tag, text, children: [], props: {}, style: {}, parent: null, focus() {}, getRootNode() { return {}; }, addEventListener() {}, removeEventListener() {}, get options() { return this.children; }, get tagName() { return this.tag.toUpperCase(); } }; }
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
const filter = { projects: [p1], queue: 'all', status: '', assignee: '', search: '', priorities: [], labels: [] };
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
const issue = (id = 'one') => ({ id, identifier: 'CFK-1', title: `Issue ${id}`, status: { key: 'todo', display_name: 'Todo' }, priority: 'none', workspace: { id: workspace, display_name: 'Team' }, project: { id: p1, display_name: 'Project 0' }, assignee: null, version: 2 });
const button = (host, label) => all(host).find(item => item.tag === 'button' && text(item) === label);
const select = (host, label) => all(host).find(item => item.tag === 'label' && text(item).startsWith(label))?.children.find(item => item.tag === 'select');
const submit = host => all(host).find(item => item.tag === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
const chooseProjects = (host, ids) => all(host).find(item => item.tag === 'input' && item.props.type === 'checkbox').props['onUpdate:modelValue'](ids);
const mount = (component, props) => { const app = renderer.createApp(component, props); const host = node('root'); app.mount(host); return { app, host }; };

test('authenticated footer follows locale and opens public help separately without fetching session or business data', async () => {
  const calls = [];
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('footer must not fetch data'); };
  const release = JSON.parse(await readFile(new URL('../../release/version.json', import.meta.url), 'utf8'));
  const { app, host } = mount(Footer);
  try {
    for (const [language, docsLabel, newTabLabel] of [['en', 'Documentation', 'opens in a new tab'], ['zh-CN', '文档', '在新标签页打开']]) {
      locale.value = language;
      await nextTick();
      const links = all(host).filter(item => item.tag === 'a');
      assert.equal(links.length, 2);
      assert.equal(links[0].props.href, `/docs/${language}/overview/`);
      assert.equal(links[0].props['aria-label'], `${docsLabel} (${newTabLabel})`);
      assert.equal(links[1].props.href, 'https://github.com/breakstring/cfKanban');
      for (const link of links) {
        assert.equal(link.props.target, '_blank');
        assert.deepEqual(link.props.rel.split(' ').sort(), ['noopener', 'noreferrer']);
        assert.equal(link.props.onClick, undefined, 'ordinary links must not trigger SPA navigation or logout');
        assert.ok(link.props['aria-label'].includes(newTabLabel));
      }
      assert.match(text(host), /cfKanban/);
      assert.ok(text(host).includes(release.version));
    }
    assert.deepEqual(calls, []);
  } finally { app.unmount(); }
});

test('work queries require explicit current scope, preserve fixed scope, and separate candidate policies', () => {
  assert.equal(workListPath({ ...filter, projects: [] }, session), null);
  assert.equal(workListPath({ ...filter, projects: [principal] }, session), null);
  const fixed = { ...session, allowed_scope: { ...session.allowed_scope, kind: 'project', project_id: p1 } };
  assert.deepEqual(workProjects(fixed).map(project => project.project_id), [p1]);
  assert.equal(workListPath({ ...filter, projects: [p2] }, fixed), null);
  const url = new URL(workListPath({ ...filter, projects: [p2, p1, p1], queue: 'mine', status: 'in_progress' }, session), 'https://local.test');
  assert.deepEqual(url.searchParams.getAll('project'), [p1, p2]);
  assert.equal(url.searchParams.get('assignee'), principal);
  assert.equal(url.searchParams.get('status'), 'in_progress');
  assert.equal(url.searchParams.has('blocked'), false);
  for (const queue of ['unassigned', 'needs_reassignment']) {
    const candidate = new URL(workListPath({ ...filter, queue, status: 'done', assignee: principal }, session), 'https://local.test');
    assert.equal(candidate.pathname, '/api/v1/issues/candidates');
    assert.equal(candidate.searchParams.get('assignment'), queue);
    assert.equal(candidate.searchParams.has('status'), false);
    assert.equal(candidate.searchParams.has('assignee'), false);
    assert.equal(candidate.searchParams.has('blocked'), false);
  }
});

test('priority and label filters use repeated stable parameters in ordinary and candidate queries', () => {
  const labelIds = ['00000000-0000-4000-8000-000000000080', '00000000-0000-4000-8000-000000000081'];
  for (const queue of ['all', 'mine', 'unassigned', 'needs_reassignment']) {
    const url = new URL(workListPath({ ...filter, queue, priorities: ['urgent', 'high', 'urgent'], labels: [...labelIds].reverse(), assignee: 'unassigned', status: 'done' }, session), 'https://local.test');
    assert.deepEqual(url.searchParams.getAll('priority'), ['high', 'urgent']);
    assert.deepEqual(url.searchParams.getAll('label'), labelIds);
    assert.equal(url.searchParams.has('blocked'), false);
    if (queue === 'all') { assert.equal(url.searchParams.get('assignee'), 'unassigned'); assert.equal(url.searchParams.get('status'), 'done'); }
    if (queue === 'unassigned' || queue === 'needs_reassignment') { assert.equal(url.searchParams.has('assignee'), false); assert.equal(url.searchParams.has('status'), false); }
  }
  assert.equal(workListPath({ ...filter, priorities: ['invalid'] }, session), null);
  assert.equal(workListPath({ ...filter, labels: ['label name'] }, session), null);
  assert.equal(workListPath({ ...filter, labels: Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`) }, session), null);
});

test('work list loads labels only on request with project distinction, pagination and reset-safe selection', async () => {
  const calls = [];
  const firstLabel = '00000000-0000-4000-8000-000000000080';
  const nextLabel = '00000000-0000-4000-8000-000000000081';
  const otherLabel = '00000000-0000-4000-8000-000000000082';
  globalThis.fetch = async path => {
    calls.push(path);
    if (path.includes('/labels')) {
      if (path.includes(p2)) return Response.json(page([{ id: otherLabel, name: 'Shared label name' }]));
      return Response.json(path.includes('cursor=') ? page([{ id: nextLabel, name: 'Later label' }]) : page([{ id: firstLabel, name: 'Shared label name' }], 'labels-next'));
    }
    return Response.json(page([issue('filtered')], 'issues-next'));
  };
  const { app, host } = mount(WorkList, { session });
  const check = value => all(host).find(item => item.tag === 'input' && item.props.type === 'checkbox' && item.props.value === value);
  try {
    chooseProjects(host, [p1, p2]); await nextTick();
    assert.equal(calls.length, 0);
    const projectSection = name => all(host).find(item => item.tag === 'section' && item.props['aria-label'] === name);
    await button(projectSection('Team / Project 0'), 'Choose labels').props.onClick(); await nextTick();
    assert.equal(calls.length, 1); assert.ok(calls[0].includes(`${p1}/labels?limit=20`));
    await button(projectSection('Team / Project 1'), 'Choose labels').props.onClick(); await nextTick();
    assert.equal(calls.length, 2); assert.ok(calls[1].includes(p2));
    assert.ok(check(firstLabel)); assert.ok(check(otherLabel));
    check(firstLabel).props.onChange(); await nextTick();
    await button(host, 'More labels').props.onClick(); await nextTick();
    assert.equal(new URL(calls[2], 'https://local.test').searchParams.get('cursor'), 'labels-next');
    assert.ok(check(firstLabel).props.checked); check(nextLabel).props.onChange(); await nextTick();
    check('high').props.onChange(); await nextTick(); check('urgent').props.onChange(); await nextTick();
    select(host, 'Assignee').props.onChange({ target: { value: 'unassigned' } }); await nextTick();
    select(host, 'Status').props['onUpdate:modelValue']('done'); await nextTick();
    await submit(host); await nextTick();
    const query = new URL(calls.at(-1), 'https://local.test');
    assert.equal(query.pathname, '/api/v1/issues'); assert.equal(query.searchParams.get('assignee'), 'unassigned'); assert.equal(query.searchParams.get('status'), 'done');
    assert.deepEqual(query.searchParams.getAll('priority'), ['high', 'urgent']); assert.deepEqual(query.searchParams.getAll('label'), [firstLabel, nextLabel]);
    assert.match(text(host), /Issue filtered/);
    check('high').props.onChange(); await nextTick(); assert.doesNotMatch(text(host), /Issue filtered/);
    await submit(host); await nextTick(); assert.equal(new URL(calls.at(-1), 'https://local.test').searchParams.has('cursor'), false);
    chooseProjects(host, [p2]); await nextTick(); assert.equal(check(firstLabel), undefined);
    await submit(host); await nextTick(); assert.equal(new URL(calls.at(-1), 'https://local.test').searchParams.has('label'), false);
    assert.equal(new URL(calls.at(-1), 'https://local.test').searchParams.get('project'), p2);
  } finally { app.unmount(); }
});

test('late label pages are discarded on scope change and label cursor invalidation retires selection', async () => {
  const calls = []; let resolveOld; let phase = 'old';
  const labelId = '00000000-0000-4000-8000-000000000080';
  globalThis.fetch = async path => {
    calls.push(path);
    if (phase === 'old') return new Promise(resolve => { resolveOld = resolve; });
    if (phase === 'expired' || phase === 'forbidden') {
      const requestId = '00000000-0000-4000-8000-000000000098';
      if (phase === 'forbidden') return Response.json({ category: 'authorization', code: 'FORBIDDEN', details: {}, message: 'Access changed', recovery: 'request_access', request_id: requestId, retryable: false, source: 'service' }, { status: 403, headers: { 'x-request-id': requestId } });
      return Response.json({ category: 'validation', code: 'CURSOR_SCOPE_MISMATCH', details: {}, message: 'Scope changed', recovery: 'restart_list', request_id: requestId, retryable: false, source: 'service' }, { status: 400, headers: { 'x-request-id': requestId } });
    }
    return Response.json(page([{ id: labelId, name: 'Current label' }], 'labels-next'));
  };
  const { app, host } = mount(WorkList, { session });
  try {
    chooseProjects(host, [p1]); await nextTick(); const old = button(host, 'Choose labels').props.onClick(); await nextTick();
    chooseProjects(host, [p2]); await nextTick();
    phase = 'fresh'; await button(host, 'Choose labels').props.onClick(); await nextTick();
    resolveOld(Response.json(page([{ id: principal, name: 'Obsolete label' }]))); await old; await nextTick();
    assert.doesNotMatch(text(host), /Obsolete label/);
    all(host).find(item => item.tag === 'input' && item.props.value === labelId).props.onChange(); await nextTick();
    assert.match(text(host), /Labels · 1\/20/);
    phase = 'expired'; await button(host, 'More labels').props.onClick(); await nextTick();
    assert.doesNotMatch(text(host), /Current label/); assert.match(text(host), /Labels · Any/);
    phase = 'fresh'; await button(host, 'Retry labels').props.onClick(); await nextTick();
    assert.equal(new URL(calls.at(-1), 'https://local.test').searchParams.has('cursor'), false);
    all(host).find(item => item.tag === 'input' && item.props.value === labelId).props.onChange(); await nextTick();
    phase = 'forbidden'; await button(host, 'More labels').props.onClick(); await nextTick();
    assert.doesNotMatch(text(host), /Current label/); assert.match(text(host), /Labels · Any/);
  } finally { app.unmount(); }
});

test('board disables query choices until the first project load finishes', async () => {
  let resolveProject;
  globalThis.fetch = async path => {
    const url = new URL(path, 'https://local.test');
    if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts({ todo: 1 }));
    if (url.pathname.endsWith('/statuses')) return Response.json(page(['backlog', 'todo', 'in_progress', 'done', 'canceled'].map(key => ({ key, display_name: key }))));
    if (url.pathname.endsWith('/issues')) return Response.json(page(url.searchParams.get('status') === 'todo' ? [{ ...issue('initial'), labels: [] }] : []));
    return new Promise(resolve => { resolveProject = resolve; });
  };
  const { app, host } = mount(Board, { session, projectId: p1, workspaceId: workspace });
  try {
    await nextTick();
    const fieldsets = () => all(host).filter(item => item.tag === 'fieldset');
    assert.equal(fieldsets().length, 2);
    assert.ok(fieldsets().every(item => item.props.disabled), 'native fieldsets prevent a premature filter event from retiring the initial project request');
    resolveProject(Response.json({ display_name: 'Loaded project', workspace_display_name: 'Team' }));
    await until(() => text(host).includes('Loaded project'));
    assert.match(text(host), /Issue initial/);
    assert.ok(fieldsets().every(item => !item.props.disabled));
  } finally { app.unmount(); }
});

test('board columns and status choices follow locale without translating custom names or rereading data', async () => {
  const calls = [];
  const names = { backlog: 'Backlog', todo: 'Ready for team', in_progress: 'In Progress', done: 'Done', canceled: 'Canceled' };
  globalThis.fetch = async path => {
    calls.push(path);
    const url = new URL(path, 'https://local.test');
    if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts({ todo: 1 }));
    if (url.pathname.endsWith('/statuses')) return Response.json(page(workflowStatuses.map(key => ({ key, display_name: names[key] }))));
    if (url.pathname.endsWith('/issues')) return Response.json(page(url.searchParams.get('status') === 'todo' ? [{ ...issue('English business title'), labels: [], status: { key: 'todo', display_name: names.todo } }] : []));
    return Response.json({ display_name: 'English project name', workspace_display_name: 'English workspace name' });
  };
  const { app, host } = mount(Board, { session, projectId: p1, workspaceId: workspace });
  try {
    await until(() => text(host).includes('Issue English business title'));
    const columnNames = () => all(host).filter(item => item.tag === 'h2').map(text);
    const choices = () => all(host).filter(item => item.tag === 'select' && item.props['aria-label'] === (locale.value === 'zh-CN' ? '状态' : 'Status'))
      .flatMap(item => item.children.filter(child => child.tag === 'option').map(text));
    assert.deepEqual(columnNames(), ['Backlog', 'Ready for team', 'In Progress', 'Done', 'Canceled']);
    const readCount = calls.length;
    locale.value = 'zh-CN'; await nextTick();
    assert.deepEqual(columnNames(), ['待规划', 'Ready for team', '进行中', '已完成', '已取消']);
    assert.ok(choices().includes('Ready for team'));
    assert.ok(choices().includes('已完成'));
    assert.ok(!choices().includes('Done'));
    assert.match(text(host), /English project name/);
    assert.match(text(host), /Issue English business title/);
    assert.equal(calls.length, readCount, 'changing display language does not fetch or write business data');
    locale.value = 'en'; await nextTick();
    assert.deepEqual(columnNames(), ['Backlog', 'Ready for team', 'In Progress', 'Done', 'Canceled']);
    assert.equal(calls.length, readCount);
  } finally { app.unmount(); }
});

const assigneePerson = { principal_id: '00000000-0000-4000-8000-000000000081', display_name: 'Eligible writer' };
const otherAssignee = { principal_id: '00000000-0000-4000-8000-000000000082', display_name: 'Another writer' };
const boardAssigneeMenu = (host, identifier = 'CFK-1') => all(host).find(item => item.tag === 'button' && item.props['aria-label']?.startsWith(`${identifier} · ${locale.value === 'zh-CN' ? '负责人' : 'Assignee'} · `))?.parent;
function chooseBoardAssignee(host, value, identifier = 'CFK-1') {
  const menu = boardAssigneeMenu(host, identifier);
  const option = menu.children.find(item => item.tag === 'button' && (value === 'load-assignees' ? text(item) === 'Load more people' : item.props.value === value));
  assert.ok(option, 'requested candidate or continuation must be rendered');
  option.props.onClick({ preventDefault() {}, stopPropagation() {} });
  return { value: menu.props.value };
}
function assigneeBoardFixture({ rows, write, candidates, readback } = {}) {
  const calls = [];
  let current = { ...issue('assignment'), number: 1, labels: [], needs_reassignment: false, deleted_at: null, updated_at: '2026-10-02T00:00:00Z' };
  globalThis.document = { cookie: '', documentElement: { lang: 'en' }, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    const url = new URL(path, 'https://local.test');
    if (init.method === 'PATCH') {
      if (write) return write(path, init, current);
      const principalId = JSON.parse(init.body).assignee_principal_id;
      current = { ...current, version: current.version + 1, assignee: principalId === null ? null : { ...[assigneePerson, otherAssignee].find(person => person.principal_id === principalId), available: true } };
      return Response.json({ resource: current });
    }
    if (url.pathname.endsWith('/assignees')) return candidates ? candidates(url) : Response.json(page([assigneePerson, otherAssignee]));
    if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts({ todo: (rows ?? [current]).length }));
    if (url.pathname.endsWith('/statuses')) return Response.json(page(workflowStatuses.map(key => ({ key, display_name: key }))));
    if (url.pathname.endsWith('/issues')) return Response.json(page(url.searchParams.get('status') === 'todo' ? (rows ?? [current]) : []));
    if (url.pathname === '/api/v1/issues/CFK-1') return Response.json(readback ? readback(current) : current);
    return Response.json({ id: p1, display_name: 'Assignee board', workspace_display_name: 'Team', deleted_at: null });
  };
  return { calls, writes: () => calls.filter(call => call.init.method === 'PATCH'), peopleReads: () => calls.filter(call => call.path.includes('/assignees?')), current: () => current };
}

test('board assignee selection and clearing use stable IDs and confirmed CAS values without optimistic display', async () => {
  const fixture = assigneeBoardFixture();
  const { app, host } = mount(Board, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!boardAssigneeMenu(host));
    assert.equal(fixture.peopleReads().length, 0, 'unopened card controls do not fetch people');
    boardAssigneeMenu(host).props.onOpen();
    await until(() => boardAssigneeMenu(host).children.some(option => option.props.value === assigneePerson.principal_id));
    const target = chooseBoardAssignee(host, assigneePerson.principal_id);
    assert.equal(target.value, '', 'the menu keeps the last confirmed value during save');
    await until(() => boardAssigneeMenu(host).props.value === assigneePerson.principal_id);
    assert.deepEqual(JSON.parse(fixture.writes()[0].init.body), { expected_version: 2, assignee_principal_id: assigneePerson.principal_id });
    chooseBoardAssignee(host, assigneePerson.principal_id); await nextTick();
    assert.equal(fixture.writes().length, 1, 'selecting the current stable ID is a no-op');
    const clearTarget = chooseBoardAssignee(host, '');
    assert.equal(clearTarget.value, assigneePerson.principal_id);
    await until(() => boardAssigneeMenu(host).props.value === '');
    assert.deepEqual(JSON.parse(fixture.writes()[1].init.body), { expected_version: 3, assignee_principal_id: null });
    locale.value = 'zh-CN'; await nextTick();
    assert.ok(boardAssigneeMenu(host));
    assert.equal(text(boardAssigneeMenu(host).children.find(item => item.props.value === '')), '未分配');
    assert.equal(fixture.peopleReads().length, 1);
  } finally { app.unmount(); }
});

test('board cards share bounded on-demand assignee pages and preserve an absent or unavailable current assignee', async () => {
  const unavailable = { ...otherAssignee, available: false };
  let resolveFirst;
  const rows = [{ ...issue('former'), number: 1, labels: [], assignee: unavailable, needs_reassignment: true }, { ...issue('second'), identifier: 'CFK-2', number: 2, labels: [] }];
  const fixture = assigneeBoardFixture({ rows, candidates: url => url.searchParams.has('cursor')
    ? Response.json(page([assigneePerson, otherAssignee]))
    : new Promise(resolve => { resolveFirst = () => resolve(Response.json(page([assigneePerson], 'people-next'))); }) });
  const { app, host } = mount(Board, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!boardAssigneeMenu(host));
    assert.equal(boardAssigneeMenu(host).props.value, otherAssignee.principal_id);
    const preserved = boardAssigneeMenu(host).children.find(option => option.props.value === otherAssignee.principal_id);
    assert.equal(text(preserved), otherAssignee.display_name); assert.notEqual(preserved.props.disabled, undefined);
    boardAssigneeMenu(host).props.onOpen(); boardAssigneeMenu(host, 'CFK-2').props.onOpen();
    await until(() => !!resolveFirst); assert.equal(fixture.peopleReads().length, 1);
    resolveFirst();
    await until(() => boardAssigneeMenu(host).children.some(option => text(option) === 'Load more people'));
    assert.equal(boardAssigneeMenu(host).props.value, otherAssignee.principal_id);
    const target = chooseBoardAssignee(host, 'load-assignees'); assert.equal(target.value, otherAssignee.principal_id);
    await until(() => fixture.peopleReads().length === 2 && !boardAssigneeMenu(host).children.some(option => text(option) === 'Load more people'));
    assert.equal(new URL(fixture.peopleReads()[1].path, 'https://local.test').searchParams.get('cursor'), 'people-next');
    assert.ok(fixture.peopleReads().every(call => new URL(call.path, 'https://local.test').searchParams.get('limit') === '50'));
    for (const id of ['CFK-1', 'CFK-2']) assert.equal(boardAssigneeMenu(host, id).children.filter(option => option.props.value === assigneePerson.principal_id).length, 1);
    assert.equal(fixture.writes().length, 0);
  } finally { app.unmount(); }
});

test('reader board cards retain assignee names and do not expose or fetch writable people controls', async () => {
  const fixture = assigneeBoardFixture({ rows: [{ ...issue('reader'), labels: [], assignee: { ...assigneePerson, available: true } }] });
  const reader = { ...session, allowed_scope: { ...session.allowed_scope, projects: projects.map(project => ({ ...project, role: 'reader' })) } };
  const { app, host } = mount(Board, { session: reader, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => text(host).includes('Eligible writer'));
    assert.equal(boardAssigneeMenu(host), undefined);
    assert.equal(fixture.peopleReads().length, 0); assert.equal(fixture.writes().length, 0);
    assert.match(text(host), /Read-only/);
  } finally { app.unmount(); }
});

test('board assignee CAS conflict reads the single Issue and keeps the new confirmed assignee without replay', async () => {
  const fixture = assigneeBoardFixture({
    write: () => {
      const requestId = '00000000-0000-4000-8000-000000000098';
      return Response.json({ category: 'conflict', code: 'VERSION_CONFLICT', details: { current_version: 3 }, message: 'Version changed.', recovery: 'refresh_resource', request_id: requestId, retryable: false, source: 'service' }, { status: 409, headers: { 'x-request-id': requestId } });
    },
    readback: current => ({ ...current, version: 3, assignee: { ...otherAssignee, available: true } }),
  });
  const { app, host } = mount(Board, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!boardAssigneeMenu(host)); boardAssigneeMenu(host).props.onOpen();
    await until(() => boardAssigneeMenu(host).children.some(option => option.props.value === assigneePerson.principal_id));
    chooseBoardAssignee(host, assigneePerson.principal_id);
    await until(() => text(host).includes('latest fact was read back'));
    assert.equal(boardAssigneeMenu(host).props.value, otherAssignee.principal_id);
    assert.equal(fixture.writes().length, 1);
    assert.equal(fixture.calls.filter(call => call.path === '/api/v1/issues/CFK-1' && call.init.method === 'GET').length, 1);
    assert.equal(fixture.calls.filter(call => new URL(call.path, 'https://local.test').pathname.endsWith('/issues')).length, 5, 'conflict does not reload all columns');
    assert.match(all(host).find(item => item.tag === 'textarea').props.value, /assignee_principal_id/);
  } finally { app.unmount(); }
});

test('uncertain assignee writes fence the card and retry the original version, payload and idempotency key only on explicit verification', async () => {
  let attempts = 0;
  const fixture = assigneeBoardFixture({ write: (_path, _init, current) => {
    attempts += 1;
    if (attempts === 1) throw new Error('Lost response');
    return Response.json({ resource: { ...current, version: 3, assignee: { ...assigneePerson, available: true } } });
  } });
  const { app, host } = mount(Board, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!boardAssigneeMenu(host)); boardAssigneeMenu(host).props.onOpen();
    await until(() => boardAssigneeMenu(host).children.some(option => option.props.value === assigneePerson.principal_id));
    chooseBoardAssignee(host, assigneePerson.principal_id);
    await until(() => !!button(host, 'CFK-1 · Verify save'));
    assert.equal(boardAssigneeMenu(host).props.value, '');
    assert.equal(boardAssigneeMenu(host).props.disabled, true);
    assert.ok(all(host).filter(item => item.tag === 'select' && item.props['aria-label']?.startsWith('CFK-1')).every(item => item.props.disabled));
    assert.equal(all(host).find(item => item.props.class?.includes?.('issue-card') && item.tag === 'article').props.draggable, false);
    assert.ok(all(host).find(item => item.tag === 'input' && item.props.type === 'search').props.disabled);
    assert.equal(fixture.writes().length, 1);
    button(host, 'CFK-1 · Verify save').props.onClick();
    await until(() => boardAssigneeMenu(host).props.value === assigneePerson.principal_id && !boardAssigneeMenu(host).props.disabled);
    const writes = fixture.writes(); assert.equal(writes.length, 2);
    assert.equal(writes[0].init.body, writes[1].init.body);
    assert.equal(writes[0].init.headers.get('idempotency-key'), writes[1].init.headers.get('idempotency-key'));
    assert.deepEqual(JSON.parse(writes[1].init.body), { expected_version: 2, assignee_principal_id: assigneePerson.principal_id });
    assert.equal(button(host, 'CFK-1 · Verify save'), undefined);
  } finally { app.unmount(); }
});

test('candidate cursor errors clear stale people and retry the first bounded page without assignment writes', async () => {
  let phase = 'first';
  const fixture = assigneeBoardFixture({ candidates: () => {
    if (phase === 'first') return Response.json(page([assigneePerson], 'stale-people'));
    if (phase === 'fresh') return Response.json(page([otherAssignee]));
    const requestId = '00000000-0000-4000-8000-000000000098';
    return Response.json({ category: 'validation', code: 'CURSOR_SCOPE_MISMATCH', details: {}, message: 'Scope changed', recovery: 'restart_list', request_id: requestId, retryable: false, source: 'service' }, { status: 400, headers: { 'x-request-id': requestId } });
  } });
  const { app, host } = mount(Board, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!boardAssigneeMenu(host)); boardAssigneeMenu(host).props.onOpen();
    await until(() => boardAssigneeMenu(host).children.some(option => text(option) === 'Load more people'));
    phase = 'expired'; chooseBoardAssignee(host, 'load-assignees');
    await until(() => !!button(host, 'Retry loading people'));
    assert.equal(boardAssigneeMenu(host).children.some(option => option.props.value === assigneePerson.principal_id), false);
    phase = 'fresh'; button(host, 'Retry loading people').props.onClick({ preventDefault() {} });
    await until(() => boardAssigneeMenu(host).children.some(option => option.props.value === otherAssignee.principal_id));
    assert.equal(new URL(fixture.peopleReads().at(-1).path, 'https://local.test').searchParams.has('cursor'), false);
    assert.equal(fixture.writes().length, 0);
  } finally { app.unmount(); }
});

test('saving an assignee disables repeated card inputs and rejected eligibility never becomes local success', async () => {
  let resolveWrite;
  const fixture = assigneeBoardFixture({ write: () => new Promise(resolve => { resolveWrite = resolve; }) });
  const { app, host } = mount(Board, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!boardAssigneeMenu(host)); boardAssigneeMenu(host).props.onOpen();
    await until(() => boardAssigneeMenu(host).children.some(option => option.props.value === assigneePerson.principal_id));
    chooseBoardAssignee(host, assigneePerson.principal_id);
    await until(() => !!resolveWrite && boardAssigneeMenu(host).props.disabled);
    assert.equal(boardAssigneeMenu(host).props.value, '');
    assert.ok(all(host).filter(item => item.tag === 'select' && item.props['aria-label']?.startsWith('CFK-1')).every(item => item.props.disabled));
    chooseBoardAssignee(host, otherAssignee.principal_id);
    assert.equal(fixture.writes().length, 1);
    const requestId = '00000000-0000-4000-8000-000000000098';
    resolveWrite(Response.json({ category: 'conflict', code: 'ASSIGNEE_NOT_ELIGIBLE', details: {}, message: 'The selected Principal is not eligible for assignment in this Project.', recovery: 'refresh_resource', request_id: requestId, retryable: false, source: 'service' }, { status: 409, headers: { 'x-request-id': requestId } }));
    await until(() => !boardAssigneeMenu(host).props.disabled);
    assert.equal(boardAssigneeMenu(host).props.value, '');
    assert.match(text(host), /ASSIGNEE_NOT_ELIGIBLE/);
    assert.equal(boardAssigneeMenu(host).children.some(option => option.props.value === assigneePerson.principal_id), false, 'eligibility rejection invalidates cached candidates');
    assert.equal(fixture.writes().length, 1);
    assert.equal(button(host, 'CFK-1 · Verify save'), undefined);
  } finally { app.unmount(); }
});

test('assignee candidate responses arriving after writer access becomes reader access are discarded', async () => {
  let resolvePeople;
  const fixture = assigneeBoardFixture({ candidates: () => new Promise(resolve => { resolvePeople = resolve; }) });
  const currentSession = ref(session);
  const Wrapper = { setup: () => () => h(Board, { session: currentSession.value, workspaceId: workspace, projectId: p1 }) };
  const { app, host } = mount(Wrapper);
  try {
    await until(() => !!boardAssigneeMenu(host)); boardAssigneeMenu(host).props.onOpen();
    await until(() => !!resolvePeople);
    currentSession.value = { ...session, allowed_scope: { ...session.allowed_scope, projects: projects.map(project => ({ ...project, role: 'reader' })) } };
    await nextTick();
    resolvePeople(Response.json(page([assigneePerson])));
    await new Promise(resolve => setTimeout(resolve, 0)); await nextTick();
    assert.equal(boardAssigneeMenu(host), undefined);
    assert.doesNotMatch(text(host), /Eligible writer|Loading eligible people/);
    assert.equal(fixture.peopleReads().length, 1); assert.equal(fixture.writes().length, 0);
  } finally { app.unmount(); }
});

test('board filters reset every column, discard old continuation and request new pages with repeated parameters', async () => {
  const calls = []; let resolveOld;
  const labelId = '00000000-0000-4000-8000-000000000080';
  globalThis.fetch = async path => {
    calls.push(path);
    const url = new URL(path, 'https://local.test');
    if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts({ todo: 1 }));
    if (url.pathname.endsWith('/labels')) return Response.json(page([{ id: labelId, name: 'Board label' }]));
    if (url.pathname.endsWith('/statuses')) return Response.json(page(['backlog', 'todo', 'in_progress', 'done', 'canceled'].map(key => ({ key, display_name: key }))));
    if (!url.pathname.endsWith('/issues')) return Response.json({ display_name: 'Project 0', workspace_display_name: 'Team' });
    if (url.searchParams.has('cursor')) return new Promise(resolve => { resolveOld = resolve; });
    const priority = url.searchParams.get('priority');
    return Response.json(url.searchParams.get('status') === 'todo' ? page([{ ...issue(priority ? 'current' : 'initial'), labels: [] }], priority ? null : 'old-next') : page([]));
  };
  const { app, host } = mount(Board, { session, projectId: p1, workspaceId: workspace });
  const check = value => all(host).find(item => item.tag === 'input' && item.props.type === 'checkbox' && item.props.value === value);
  try {
    await until(() => text(host).includes('Issue initial'));
    assert.equal(calls.filter(path => path.includes('/labels')).length, 0);
    const pending = button(host, 'Load more').props.onClick(); await nextTick();
    await button(host, 'Choose labels').props.onClick(); await nextTick();
    check(labelId).props.onChange(); await nextTick(); check('high').props.onChange(); await nextTick(); check('urgent').props.onChange(); await nextTick();
    assert.doesNotMatch(text(host), /Issue initial/); assert.match(text(host), /Updating filtered results/);
    resolveOld(Response.json(page([{ ...issue('obsolete'), labels: [] }]))); await pending; await nextTick();
    assert.doesNotMatch(text(host), /Issue obsolete/);
    const before = calls.length;
    await until(() => text(host).includes('Issue current'));
    const queries = calls.slice(before).filter(path => new URL(path, 'https://local.test').pathname.endsWith('/issues'));
    assert.equal(queries.length, 5);
    for (const path of queries) {
      const params = new URL(path, 'https://local.test').searchParams;
      assert.deepEqual(params.getAll('priority'), ['high', 'urgent']); assert.deepEqual(params.getAll('label'), [labelId]);
      assert.equal(params.has('cursor'), false); assert.equal(params.has('blocked'), false);
    }
    const countQueries = calls.slice(before).filter(path => new URL(path, 'https://local.test').pathname.endsWith('/issues/counts'));
    assert.equal(countQueries.length, 1);
    const countParams = new URL(countQueries[0], 'https://local.test').searchParams;
    assert.deepEqual(countParams.getAll('priority'), ['high', 'urgent']); assert.deepEqual(countParams.getAll('label'), [labelId]);
    for (const key of ['status', 'limit', 'cursor', 'blocked']) assert.equal(countParams.has(key), false);
    assert.match(text(host), /Issue current/); assert.doesNotMatch(text(host), /Updating filtered results/);
  } finally { app.unmount(); }
});

test('board column totals use the independent count response rather than loaded card pages', async () => {
  const calls = [];
  const totals = { backlog: 0, todo: 137, in_progress: 7, done: 45, canceled: 3 };
  globalThis.fetch = async path => {
    calls.push(path);
    const url = new URL(path, 'https://local.test');
    if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts(totals));
    if (url.pathname.endsWith('/statuses')) return Response.json(page(workflowStatuses.map(key => ({ key, display_name: key }))));
    if (url.pathname.endsWith('/issues')) {
      if (url.searchParams.get('status') !== 'todo') return Response.json(page([]));
      return Response.json(url.searchParams.has('cursor')
        ? page([{ ...issue('second-loaded'), labels: [] }])
        : page([{ ...issue('only-loaded'), labels: [] }], 'todo-next'));
    }
    return Response.json(projectResource());
  };
  const { app, host } = mount(Board, { session, projectId: p1, workspaceId: workspace });
  const badges = () => all(host).filter(item => item.props['aria-label']?.includes('Matching issues total:'));
  try {
    await until(() => text(host).includes('Issue only-loaded') && badges().length === 5);
    assert.deepEqual(badges().map(item => text(item)), Object.values(totals).map(String));
    assert.equal(all(host).filter(item => item.tag === 'article' && item.props.class === 'issue-card').length, 1);
    const issueQueries = calls.map(path => new URL(path, 'https://local.test')).filter(url => url.pathname.endsWith('/issues'));
    assert.equal(issueQueries.length, 5);
    assert.deepEqual(issueQueries.map(url => url.searchParams.get('status')), workflowStatuses);
    assert.ok(issueQueries.every(url => url.searchParams.get('limit') === '20' && !url.searchParams.has('cursor')));
    const countQueries = calls.map(path => new URL(path, 'https://local.test')).filter(url => url.pathname.endsWith('/issues/counts'));
    assert.equal(countQueries.length, 1);
    for (const key of ['status', 'limit', 'cursor', 'deleted']) assert.equal(countQueries[0].searchParams.has(key), false);
    await button(host, 'Load more').props.onClick(); await nextTick();
    assert.match(text(host), /Issue only-loaded.*Issue second-loaded/);
    assert.deepEqual(badges().map(item => text(item)), Object.values(totals).map(String));
    assert.equal(calls.filter(path => new URL(path, 'https://local.test').pathname.endsWith('/issues/counts')).length, 1);
  } finally { app.unmount(); }
});

test('board filter changes keep unsubmitted search out of requests and reuse project metadata', async () => {
  const calls = [];
  globalThis.fetch = async path => {
    calls.push(path); const url = new URL(path, 'https://local.test');
    if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts());
    if (url.pathname.endsWith('/statuses')) return Response.json(page([]));
    if (url.pathname.endsWith('/issues')) return Response.json(page([]));
    return Response.json({ display_name: 'Board ready', context: 'Visible description' });
  };
  const { app, host } = mount(Board, { session, projectId: p1, workspaceId: workspace });
  try {
    await until(() => text(host).includes('Board ready'));
    const before = calls.length;
    all(host).find(item => item.tag === 'input' && item.props.type === 'search').props['onUpdate:modelValue']('unsubmitted text');
    all(host).find(item => item.tag === 'input' && item.props.value === 'high').props.onChange();
    await until(() => calls.length >= before + 6);
    assert.equal(calls.length, before + 6);
    assert.equal(calls.slice(before).filter(path => new URL(path, 'https://local.test').pathname.endsWith('/issues')).length, 5);
    assert.equal(calls.slice(before).filter(path => new URL(path, 'https://local.test').pathname.endsWith('/issues/counts')).length, 1);
    for (const path of calls.slice(before)) {
      const url = new URL(path, 'https://local.test');
      assert.ok(url.pathname.endsWith('/issues') || url.pathname.endsWith('/issues/counts')); assert.equal(url.searchParams.has('q'), false);
      assert.deepEqual(url.searchParams.getAll('priority'), ['high']);
      if (url.pathname.endsWith('/issues/counts')) for (const key of ['status', 'limit', 'cursor']) assert.equal(url.searchParams.has(key), false);
    }
    await submit(host); await nextTick();
    assert.ok(calls.filter(path => path.includes('/issues?')).slice(-5).every(path => new URL(path, 'https://local.test').searchParams.get('q') === 'unsubmitted text'));
    assert.equal(new URL(calls.filter(path => path.includes('/issues/counts?')).at(-1), 'https://local.test').searchParams.get('q'), 'unsubmitted text');
  } finally { app.unmount(); }
});

test('returning to the board preserves verified query values and rejects foreign return paths', () => {
  const label = '00000000-0000-4000-8000-000000000080';
  const filter = boardFilters(`priority=high&priority=urgent&priority=invalid&label=${label}&label=bad&q=hello`);
  assert.deepEqual(filter, { search: 'hello', priorities: ['high', 'urgent'], labels: [label] });
  const path = boardPath(workspace, p1, filter);
  assert.equal(boardReturnPath(workspace, p1, new URLSearchParams({from:path}).toString()), path);
  const listFilter = boardFilters(`view=list&priority=high&label=${label}&q=hello`);
  const listPath = boardPath(workspace, p1, listFilter);
  assert.equal(new URL(listPath, 'https://local.test').searchParams.get('view'), 'list');
  assert.equal(boardReturnPath(workspace, p1, new URLSearchParams({ from: listPath }).toString()), listPath);
  assert.deepEqual(boardFilters('view=foreign'), { search: '', priorities: [], labels: [] });
  for (const from of ['https://evil.invalid/', '//evil.invalid', boardPath(workspace, p2), `${boardPath(workspace,p1)}/deleted`]) {
    assert.equal(boardReturnPath(workspace,p1,new URLSearchParams({from}).toString()), boardPath(workspace,p1));
  }
});

test('board URL label selections survive initial project loading and pending filters stop on unmount', async () => {
  const label = '00000000-0000-4000-8000-000000000080';
  const calls = [];
  globalThis.fetch = async path => { calls.push(path); return Response.json(new URL(path, 'https://local.test').pathname.endsWith('/issues/counts') ? issueCounts() : path.includes('/issues?') || path.endsWith('/statuses') ? page([]) : {display_name:'Restored board'}); };
  const old = window.location.search;
  window.location.search = `?priority=high&label=${label}`;
  const {app,host} = mount(Board,{session,projectId:p1,workspaceId:workspace});
  window.location.search = old;
  await until(() => text(host).includes('Restored board'));
  assert.ok(all(host).some(item => item.tag === 'summary' && text(item) === 'Labels · 1'));
  assert.ok(calls.filter(path=>path.includes('/issues?')).every(path=>new URL(path,'https://local.test').searchParams.get('label')===label));
  const before=calls.length;
  all(host).find(item=>item.tag==='input'&&item.props.value==='urgent').props.onChange();
  app.unmount(); await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal(calls.length,before);
});

for (const status of [403, 404]) {
  test(`board retains access failure after selected labels are cleared on project ${status}, then recovers on retry`, async () => {
    const calls = []; let phase = 'initial';
    const labelId = '00000000-0000-4000-8000-000000000080';
    const projectPath = `/api/v1/workspaces/${workspace}/projects/${p1}`;
    globalThis.fetch = async path => {
      calls.push(path);
      const url = new URL(path, 'https://local.test');
      if (url.pathname.endsWith('/issues/counts')) return Response.json(issueCounts({ todo: 1 }));
      if (phase === 'denied' && url.pathname === projectPath) {
        const requestId = '00000000-0000-4000-8000-000000000098';
        return Response.json({ category: status === 403 ? 'authorization' : 'not_found', code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', details: {}, message: 'Project unavailable', recovery: 'request_access', request_id: requestId, retryable: false, source: 'service' }, { status, headers: { 'x-request-id': requestId } });
      }
      if (url.pathname.endsWith('/labels')) return Response.json(page([{ id: labelId, name: 'Selected board label' }]));
      if (url.pathname.endsWith('/statuses')) return Response.json(page(['backlog', 'todo', 'in_progress', 'done', 'canceled'].map(key => ({ key, display_name: key }))));
      if (url.pathname.endsWith('/issues')) return Response.json(page(url.searchParams.get('status') === 'todo' ? [{ ...issue(phase === 'recovered' ? 'recovered' : 'before-access-failure'), labels: [] }] : []));
      return Response.json({ display_name: 'Project 0', workspace_display_name: 'Team' });
    };
    const { app, host } = mount(Board, { session, projectId: p1, workspaceId: workspace });
    const applyFilters = async () => {
      submit(host);
      await until(() => !all(host).find(item => item.tag === 'input' && item.props.type === 'search')?.props.disabled);
    };
    try {
      await until(() => text(host).includes('Issue before-access-failure'));
      await button(host, 'Choose labels').props.onClick(); await nextTick();
      all(host).find(item => item.tag === 'input' && item.props.value === labelId).props.onChange(); await nextTick();
      await applyFilters(); await nextTick();
      assert.match(text(host), /Issue before-access-failure/);
      assert.ok(all(host).some(item => item.tag === 'summary' && text(item) === 'Labels · 1'));

      phase = 'denied'; await applyFilters(); await nextTick();
      assert.ok(session.allowed_scope.projects.some(project => project.project_id === p1));
      assert.doesNotMatch(text(host), /Issue before-access-failure|Selected board label/);
      assert.match(text(host), /Labels · Any/);
      assert.match(text(host), /This Project is no longer in the current active Project inventory\./);

      phase = 'recovered'; const beforeRetry = calls.length;
      await applyFilters(); await nextTick();
      assert.match(text(host), /Issue recovered/);
      assert.doesNotMatch(text(host), /This Project is no longer in the current active Project inventory\.|Filters changed/);
      const issueQueries = calls.slice(beforeRetry).map(path => new URL(path, 'https://local.test')).filter(url => url.pathname.endsWith('/issues'));
      assert.equal(issueQueries.length, 5);
      assert.ok(issueQueries.every(url => !url.searchParams.has('label') && !url.searchParams.has('cursor')));
    } finally { app.unmount(); }
  });
}

test('work view reads only after explicit selection and submit; filter change resets rows and cursor, failed page retries', async () => {
  const calls = []; let fail = false;
  globalThis.fetch = async path => { calls.push(path); if (fail) throw Error('offline'); return Response.json({ ...page([issue(calls.length === 1 ? 'first' : 'next')], calls.length === 1 ? 'next-page' : null), resolved_scope: { projects: [projects[0]], unresolved_project_targets: [p2] } }); };
  const { app, host } = mount(WorkList, { session });
  try {
    await nextTick(); assert.equal(calls.length, 0);
    chooseProjects(host, [p1, p2]); await nextTick(); assert.equal(calls.length, 0);
    await submit(host); await until(() => text(host).includes('Issue first'));
    assert.deepEqual(new URL(calls[0], 'https://local.test').searchParams.getAll('project'), [p1, p2]);
    assert.match(text(host), /Resolved project scope.*Project 0/);
    assert.match(text(host), /These selected projects are unavailable.*Project 1/);
    assert.match(text(host), /Reader access allows viewing/);
    fail = true; await button(host, 'Load more').props.onClick(); await nextTick();
    assert.match(text(host), /Issue first/);
    fail = false; await button(host, 'Retry').props.onClick(); await nextTick();
    assert.equal(new URL(calls[2], 'https://local.test').searchParams.get('cursor'), 'next-page');
    select(host, 'View').props['onUpdate:modelValue']('unassigned'); await nextTick();
    assert.doesNotMatch(text(host), /Issue first|Issue next/);
    assert.match(text(host), /only startable Todo/); assert.equal(select(host, 'Status'), undefined);
    await submit(host); await nextTick();
    const queue = new URL(calls.at(-1), 'https://local.test');
    assert.equal(queue.pathname, '/api/v1/issues/candidates'); assert.equal(queue.searchParams.has('cursor'), false);
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(host), /待领取|工作清单/);
  } finally { app.unmount(); }
});

test('scope changes discard old in-flight rows and never fall back to all projects', async () => {
  let resolve; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise(done => { resolve = done; }); };
  const { app, host } = mount(WorkList, { session });
  try {
    chooseProjects(host, [p1]); await nextTick(); const pending = submit(host);
    chooseProjects(host, []); await nextTick();
    resolve(Response.json(page([issue('obsolete')], 'obsolete-cursor'))); await pending; await nextTick();
    assert.doesNotMatch(text(host), /obsolete/); assert.equal(button(host, 'Show work').props.disabled, true); assert.equal(calls, 1);
  } finally { app.unmount(); }
});

test('project activity uses a bounded selected project request and retries continuation without duplicating rows', async () => {
  const calls = []; let fail = false;
  const event = { id: 'event-one', type: 'issue.updated', subject: { type: 'issue', id: 'resource-id' }, actor: { display_name: 'Pat' }, created_at: '2026-09-28T01:00:00Z', payload: { title_changed: true, unexpected: 'hidden payload' } };
  const older = { ...event, id: 'event-older', type: 'issue.created', created_at: '2026-09-27T01:00:00Z' };
  globalThis.fetch = async path => { calls.push(path); if (fail) throw Error('offline'); return Response.json(page(new URL(path, 'https://local.test').searchParams.has('after') ? [event, older] : [event], calls.length === 1 ? 'event-next' : null)); };
  const { app, host } = mount(Activity, { projectId: p1 });
  try {
    await until(() => text(host).includes('Issue updated'));
    assert.equal(new URL(calls[0], 'https://local.test').searchParams.get('project'), p1);
    assert.equal(new URL(calls[0], 'https://local.test').searchParams.get('limit'), '20');
    assert.equal(new URL(calls[0], 'https://local.test').searchParams.get('order'), 'desc');
    assert.match(text(host), /Newest project changes first/);
    assert.doesNotMatch(text(host), /hidden payload/);
    fail = true; await button(host, 'Load older activity').props.onClick(); await nextTick();
    fail = false; await button(host, 'Retry').props.onClick(); await until(() => text(host).includes('Issue created'));
    assert.equal(new URL(calls[2], 'https://local.test').searchParams.get('after'), 'event-next');
    assert.equal(new URL(calls[2], 'https://local.test').searchParams.get('order'), 'desc');
    const activityRows = all(host).filter(item => item.tag === 'li');
    assert.equal(activityRows.length, 2);
    assert.match(text(activityRows[0]), /Issue updated/); assert.match(text(activityRows[1]), /Issue created/);
    await button(host, 'Refresh').props.onClick(); await nextTick();
    assert.equal(new URL(calls[3], 'https://local.test').searchParams.has('after'), false);
    assert.equal(all(host).filter(item => item.tag === 'li').length, 1);
  } finally { app.unmount(); }
});

test('assignee filter fetches chosen projects only, retries partial failure and sends a stable selected identity', async () => {
  const calls = []; let retry = false;
  const other = '00000000-0000-4000-8000-000000000099';
  globalThis.fetch = async path => {
    calls.push(path);
    if (path.includes('/assignees')) {
      if (path.includes(p2) && !retry) throw Error('offline');
      return Response.json(page([{ principal_id: other, display_name: 'Other writer' }]));
    }
    return Response.json(page([]));
  };
  const { app, host } = mount(WorkList, { session });
  try {
    chooseProjects(host, [p1, p2]); await nextTick();
    assert.equal(calls.length, 0);
    await button(host, 'Choose other people').props.onClick(); await nextTick();
    assert.equal(calls.length, 2);
    assert.ok(calls.every(path => path.includes('/assignees?limit=20')));
    retry = true; await button(host, 'Retry people').props.onClick(); await nextTick();
    assert.equal(calls.length, 3); assert.ok(calls[2].includes(p2));
    const assignee = select(host, 'Assignee');
    assert.equal(assignee.children.filter(item => item.tag === 'option' && item.props.value === other).length, 1);
    assignee.props.onChange({ target: { value: other } }); await nextTick();
    await submit(host); await nextTick();
    assert.equal(new URL(calls[3], 'https://local.test').searchParams.get('assignee'), other);
    chooseProjects(host, [p1]); await nextTick();
    assert.equal(select(host, 'Assignee').props.value, '');
    select(host, 'View').props['onUpdate:modelValue']('mine'); await nextTick();
    select(host, 'Status').props['onUpdate:modelValue']('in_progress'); await nextTick();
    await submit(host); await nextTick();
    const mine = new URL(calls.at(-1), 'https://local.test');
    assert.equal(mine.pathname, '/api/v1/issues'); assert.equal(mine.searchParams.get('assignee'), principal); assert.equal(mine.searchParams.get('status'), 'in_progress');
  } finally { app.unmount(); }
});

test('assignee cursor visibility failure clears people, selection and failed cursor before retry', async () => {
  const calls = []; let phase = 0;
  globalThis.fetch = async path => {
    calls.push(path);
    if (phase === 1) {
      phase = 2;
      const requestId = '00000000-0000-4000-8000-000000000098';
      return Response.json({ category: 'validation', code: 'CURSOR_SCOPE_MISMATCH', details: {}, message: 'Scope changed', recovery: 'restart_list', request_id: requestId, retryable: false, source: 'service' }, { status: 400, headers: { 'x-request-id': requestId } });
    }
    return Response.json(page([{ principal_id: principal, display_name: 'Pat' }], phase === 0 ? 'people-next' : null));
  };
  const { app, host } = mount(WorkList, { session });
  try {
    chooseProjects(host, [p1]); await nextTick();
    await button(host, 'Choose other people').props.onClick(); await nextTick();
    select(host, 'Assignee').props.onChange({ target: { value: principal } }); await nextTick();
    phase = 1; await button(host, 'More people').props.onClick(); await nextTick();
    assert.equal(new URL(calls[1], 'https://local.test').searchParams.get('cursor'), 'people-next');
    assert.equal(select(host, 'Assignee').props.value, '');
    await button(host, 'Retry people').props.onClick(); await nextTick();
    assert.equal(new URL(calls[2], 'https://local.test').searchParams.has('cursor'), false);
  } finally { app.unmount(); }
});

test('activity targets link verified project UUIDs and known Issue references without treating subject UUIDs as Issue identifiers', () => {
  const event = { project: { id: p1, display_name: 'Project' }, workspace: { id: workspace, display_name: 'Team' }, subject: { type: 'issue', id: principal }, type: 'issue.created', payload: { identifier_pending: true } };
  const boardPath = `/app/w/${workspace}/p/${p1}`;
  assert.deepEqual(activityTargets(event), [{ label: 'Team / Project', path: boardPath }]);
  assert.deepEqual(activityTargets({ ...event, type: 'comment.created', payload: { issue_identifier: 'CFK-12', issue_reference: { identifier: 'CFK-12' } } }).map(target => target.path), [boardPath, '/app/issues/CFK-12']);
  assert.deepEqual(activityTargets({ ...event, type: 'issue-relation.created', payload: { source_identifier: 'CFK-1', target_identifier: 'CFK-2' } }).map(target => target.path), [boardPath, '/app/issues/CFK-1', '/app/issues/CFK-2']);
  assert.deepEqual(activityTargets({ ...event, type: 'comment.created', payload: { issue_identifier: '../../admin', issue_reference: { identifier: 'CFK-1?admin=true' } } }).map(target => target.path), [boardPath]);
  assert.deepEqual(activityTargets({ ...event, type: 'new.unknown-event', payload: { issue_identifier: 'CFK-9' } }).map(target => target.path), [boardPath]);
  assert.deepEqual(activityTargets({ ...event, workspace: { id: '//external.test', display_name: 'bad' } }), []);
});

test('activity renders target links and keeps a readable fallback plus technical details for unknown event types', async () => {
  globalThis.fetch = async () => Response.json(page([
    { id: 'unknown-event', type: 'future.event', subject: { type: 'issue', id: principal }, actor: null, created_at: '2026-09-28T01:00:00Z', project: { id: p1, display_name: 'Project' }, workspace: { id: workspace, display_name: 'Team' }, payload: {} },
    { id: 'comment-event', type: 'comment.created', subject: { type: 'comment', id: principal }, actor: null, created_at: '2026-09-28T01:00:00Z', project: { id: p1, display_name: 'Project' }, workspace: { id: workspace, display_name: 'Team' }, payload: { issue_identifier: 'CFK-12' } },
  ]));
  const { app, host } = mount(Activity, { projectId: p1 });
  try {
    await until(() => text(host).includes('future.event'));
    const rows = all(host).filter(item => item.tag === 'li');
    assert.match(text(rows[0]), /Project activity.*Team \/ Project.*Event details.*future.event/);
    assert.equal(all(rows[0]).find(item => item.tag === 'a').props.href, `/app/w/${workspace}/p/${p1}`);
    assert.ok(all(rows[1]).some(item => item.tag === 'a' && item.props.href === '/app/issues/CFK-12'));
    assert.ok(!all(host).some(item => item.tag === 'a' && item.props.href?.includes(`/issues/${principal}`)));
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(rows[0]), /项目活动.*事件详情/);
  } finally { app.unmount(); }
});

test('project page navigation preserves filtered browser history only after the draft guard allows leaving', () => {
  const previous = { location: window.location, history: window.history, scrollTo: window.scrollTo, path: currentPath.value };
  const calls = [];
  const base = boardPath(workspace, p1);
  const filtered = boardPath(workspace, p1, { search: 'current search', priorities: ['high'], labels: [] });
  const target = `${base}/activity?${new URLSearchParams({ from: filtered })}`;
  const setLocation = path => { const url = new URL(path, 'https://local.test'); window.location = { pathname: url.pathname, search: url.search }; };
  window.history = {
    replaceState(_state, _title, path) { calls.push(['replace', path]); setLocation(path); },
    pushState(_state, _title, path) { calls.push(['push', path]); setLocation(path); },
  };
  window.scrollTo = () => {};
  setLocation(base); currentPath.value = base;
  let allow = false;
  const unregister = registerNavigationGuard(() => allow);
  try {
    assert.equal(navigate(target, false, filtered), false);
    assert.deepEqual(calls, []);
    assert.equal(currentPath.value, base);
    allow = true;
    assert.equal(navigate(target, false, filtered), true);
    assert.deepEqual(calls, [['replace', filtered], ['push', target]]);
    assert.equal(currentPath.value, target);
    assert.deepEqual(boardFilters(new URL(calls[0][1], 'https://local.test').search), { search: 'current search', priorities: ['high'], labels: [] });
  } finally {
    unregister(); window.location = previous.location; window.history = previous.history; window.scrollTo = previous.scrollTo; currentPath.value = previous.path;
  }
});

test('project record pages reject mismatched scope and readers cannot read deleted issues', async () => {
  const calls = [];
  globalThis.fetch = async path => { calls.push(path); throw Error('out-of-scope pages must not fetch'); };
  for (const [component, props, message] of [
    [ActivityPage, { projectId: p1, workspaceId: principal }, /no longer available/],
    [DeletedPage, { projectId: p1, workspaceId: principal }, /need project write access/],
    [DeletedPage, { projectId: p2, workspaceId: workspace }, /need project write access/],
  ]) {
    const { app, host } = mount(component, { session, ...props });
    try { await nextTick(); assert.match(text(host), message); }
    finally { app.unmount(); }
  }
  assert.deepEqual(calls, []);
});

test('activity page verifies the project before a bounded reader activity request', async () => {
  const calls = []; let resolveProject;
  globalThis.fetch = async path => {
    calls.push(path);
    if (path.startsWith('/api/v1/events?')) return Response.json(page([]));
    return new Promise(resolve => { resolveProject = resolve; });
  };
  const returnTo = boardPath(workspace, p2, { search: '', priorities: ['high'], labels: [] });
  const navigations = [];
  const { app, host } = mount(ActivityPage, { session, projectId: p2, workspaceId: workspace, returnTo, onNavigate: path => navigations.push(path) });
  try {
    await nextTick();
    assert.deepEqual(calls, [`/api/v1/workspaces/${workspace}/projects/${p2}`]);
    resolveProject(Response.json({ display_name: 'Reader project', deleted_at: null }));
    await until(() => text(host).includes('No visible project activity.'));
    assert.equal(calls.length, 2);
    const params = new URL(calls[1], 'https://local.test').searchParams;
    assert.deepEqual(params.getAll('project'), [p2]); assert.equal(params.get('limit'), '20'); assert.equal(params.get('order'), 'desc');
    button(host, '← Back to board').props.onClick();
    assert.deepEqual(navigations, [returnTo]);
  } finally { app.unmount(); }
});

test('unmounted project record pages discard the late project read without fetching child data', async () => {
  for (const component of [ActivityPage, DeletedPage]) {
    const calls = []; const contexts = []; let resolveProject;
    globalThis.fetch = async path => { calls.push(path); return new Promise(resolve => { resolveProject = resolve; }); };
    const { app, host } = mount(component, { session, projectId: p1, workspaceId: workspace, onContext: value => contexts.push(value) });
    await nextTick(); app.unmount();
    resolveProject(Response.json({ display_name: 'Obsolete project', deleted_at: null }));
    await new Promise(resolve => setTimeout(resolve, 0)); await nextTick();
    assert.equal(calls.length, 1); assert.deepEqual(contexts, []); assert.doesNotMatch(text(host), /Obsolete project/);
  }
});

test('deleted page rejects a late tombstone response after writer access becomes reader access', async () => {
  const currentSession = ref(session); const calls = []; let resolveDeleted;
  globalThis.fetch = async path => {
    calls.push(path);
    if (new URL(path, 'https://local.test').pathname.endsWith('/issues')) return new Promise(resolve => { resolveDeleted = resolve; });
    return Response.json({ display_name: 'Project', deleted_at: null });
  };
  const Wrapper = { setup: () => () => h(DeletedPage, { session: currentSession.value, projectId: p1, workspaceId: workspace }) };
  const { app, host } = mount(Wrapper);
  try {
    await until(() => !!resolveDeleted);
    currentSession.value = { ...session, allowed_scope: { ...session.allowed_scope, projects: projects.map(project => ({ ...project, role: 'reader' })) } };
    await nextTick();
    resolveDeleted(Response.json(page([{ ...issue('obsolete'), deleted_at: '2026-09-29T00:00:00Z', restorable: true, allowed_actions: ['restore'] }])));
    await new Promise(resolve => setTimeout(resolve, 0)); await nextTick();
    assert.match(text(host), /need project write access/);
    assert.doesNotMatch(text(host), /Issue obsolete/);
    assert.equal(button(host, 'Restore'), undefined); assert.equal(calls.length, 2);
  } finally { app.unmount(); }
});

test('deleted issue pagination deduplicates and recovery reads CAS facts without automatically replaying', async () => {
  const projectPath = `/api/v1/workspaces/${workspace}/projects/${p1}`;
  const tombstone = version => ({ ...issue('deleted'), version, labels: [], deleted_at: '2026-09-29T00:00:00Z', restorable: true, allowed_actions: ['restore'], parent_status: { workspace: 'active', project: 'active' }, unavailability_reason: null });
  const unavailable = { ...tombstone(2), id: 'blocked', identifier: 'CFK-2', title: 'Parent archived', restorable: false, allowed_actions: [], parent_status: { workspace: 'deleted', project: 'active' } };
  const queries = []; const writes = []; let conflicted = false; let restored = false;
  globalThis.fetch = async (path, init) => {
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(init.body) });
      if (!conflicted) {
        conflicted = true;
        const requestId = '00000000-0000-4000-8000-000000000098';
        return Response.json({ category: 'conflict', code: 'VERSION_CONFLICT', details: { current_version: 3 }, message: 'Version changed.', recovery: 'refresh_resource', request_id: requestId, retryable: false, source: 'service' }, { status: 409, headers: { 'x-request-id': requestId } });
      }
      restored = true;
      return Response.json({ resource: { ...issue('restored'), version: 4 } });
    }
    if (path === projectPath) return Response.json({ display_name: 'Project', deleted_at: null });
    const params = new URL(path, 'https://local.test').searchParams;
    queries.push(params);
    if (restored) return Response.json(page([]));
    if (params.has('cursor')) return Response.json(page([tombstone(2), unavailable]));
    return Response.json(page([tombstone(conflicted ? 3 : 2)], conflicted ? null : 'deleted-next'));
  };
  const { app, host } = mount(DeletedPage, { session, projectId: p1, workspaceId: workspace });
  try {
    await until(() => !!button(host, 'Load more deleted issues'));
    await button(host, 'Load more deleted issues').props.onClick(); await nextTick();
    assert.equal(queries[1].get('cursor'), 'deleted-next');
    assert.ok(queries.every(query => query.get('deleted') === 'only' && query.get('limit') === '100'));
    assert.equal(all(host).filter(item => item.props.class === 'tombstone-row').length, 2);
    assert.match(text(host), /Restore the parent workspace first/);
    await button(host, 'Restore').props.onClick(); await nextTick();
    assert.deepEqual(writes, [{ path: '/api/v1/issues/CFK-1/commands/restore', body: { expected_version: 2 } }]);
    assert.match(text(host), /remote version is v3.*latest fact was read back/);
    assert.equal(queries.at(-1).has('cursor'), false);
    assert.equal(button(host, 'Restore').props.disabled, true);
    button(host, 'Dismiss').props.onClick(); await nextTick();
    await button(host, 'Restore').props.onClick(); await nextTick();
    assert.equal(writes.length, 2); assert.deepEqual(writes[1].body, { expected_version: 3 });
    assert.match(text(host), /No deleted issues\./); assert.doesNotMatch(text(host), /Issue deleted/);
  } finally { app.unmount(); }
});

for (const trigger of ['automatic', 'manual']) {
  for (const outcome of ['success', 'failure']) {
    test(`deleted issue CAS dismissal survives ${trigger} readback ${outcome}`, async () => {
      const tombstone = version => ({ ...issue(`version ${version}`), version, labels: [], deleted_at: '2026-09-29T00:00:00Z', restorable: true, allowed_actions: ['restore'], parent_status: { workspace: 'active', project: 'active' }, unavailability_reason: null });
      const writes = []; let reads = 0; let settleReadback;
      globalThis.fetch = async (path, init) => {
        if (init?.method === 'POST') {
          writes.push({ path, body: JSON.parse(init.body) });
          const requestId = '00000000-0000-4000-8000-000000000098';
          return Response.json({ category: 'conflict', code: 'VERSION_CONFLICT', details: { current_version: 3 }, message: 'Version changed.', recovery: 'refresh_resource', request_id: requestId, retryable: false, source: 'service' }, { status: 409, headers: { 'x-request-id': requestId } });
        }
        if (!new URL(path, 'https://local.test').pathname.endsWith('/issues')) return Response.json({ display_name: 'Project', deleted_at: null });
        reads += 1;
        if (reads === 1) return Response.json(page([tombstone(2)]));
        if (trigger === 'manual' && reads === 2) return Response.json(page([tombstone(3)]));
        return new Promise((resolve, reject) => {
          settleReadback = () => outcome === 'success'
            ? resolve(Response.json(page([tombstone(4)], 'readback-next')))
            : reject(new Error('Readback connection failed'));
        });
      };
      const { app, host } = mount(DeletedPage, { session, projectId: p1, workspaceId: workspace });
      try {
        await until(() => !!button(host, 'Restore'));
        const restoration = button(host, 'Restore').props.onClick();
        if (trigger === 'manual') {
          await restoration; await nextTick();
          assert.match(text(host), /latest fact was read back/);
          button(host, 'Refresh facts again').props.onClick();
        }
        await until(() => !!settleReadback);
        assert.match(text(host), /Reading the latest fact/);
        button(host, 'Dismiss').props.onClick(); await nextTick();
        assert.equal(!!button(host, 'Dismiss'), false);
        assert.equal(button(host, 'Restore').props.disabled, true, 'the active readback still fences writes');
        settleReadback();
        await restoration;
        await until(() => !all(host).some(item => item.props.role === 'status'));
        assert.equal(!!button(host, 'Dismiss'), false, 'late readback must not recreate a dismissed conflict');
        assert.doesNotMatch(text(host), /changed remotely/);
        assert.equal(button(host, 'Restore').props.disabled, false);
        assert.equal(button(host, 'Refresh').props.disabled, false);
        assert.deepEqual(writes, [{ path: '/api/v1/issues/CFK-1/commands/restore', body: { expected_version: 2 } }]);
        assert.equal(reads, trigger === 'automatic' ? 2 : 3);
        if (outcome === 'success') {
          assert.match(text(host), /Issue version 4/);
          assert.doesNotMatch(text(host), /Issue version [23]/);
          assert.equal(button(host, 'Load more deleted issues').props.disabled, false);
          assert.equal(all(host).some(item => item.props.class === 'inline-alert error-notice'), false);
        } else {
          assert.match(text(host), new RegExp(`Issue version ${trigger === 'automatic' ? 2 : 3}`));
          assert.match(text(host), /PLATFORM_UNAVAILABLE/);
          assert.equal(all(host).some(item => item.props.class === 'inline-alert error-notice'), true);
          assert.equal(button(host, 'Retry').props.disabled, false);
        }
      } finally { app.unmount(); }
    });
  }
}

function installProjectHistory(start) {
  const previous = { location: window.location, history: window.history, scrollTo: window.scrollTo, confirm: window.confirm, path: currentPath.value };
  const navigations = [];
  const setLocation = path => { const url = new URL(path, 'https://local.test'); window.location = { pathname: url.pathname, search: url.search }; };
  window.history = {
    replaceState(_state, _title, path) { navigations.push(['replace', path]); setLocation(path); },
    pushState(_state, _title, path) { navigations.push(['push', path]); setLocation(path); },
  };
  window.scrollTo = () => {};
  setLocation(start); currentPath.value = start;
  return {
    navigations,
    restore() { window.location = previous.location; window.history = previous.history; window.scrollTo = previous.scrollTo; window.confirm = previous.confirm; currentPath.value = previous.path; },
  };
}
const projectResource = (overrides = {}) => ({ id: p1, workspace_id: workspace, workspace_display_name: 'Team', display_name: 'Project 0', deleted_at: null, version: 2, allowed_actions: ['read'], ...overrides });

test('project settings tabs keep management capabilities distinct from writer access and stay in the current scope', () => {
  const resource = projectResource();
  assert.deepEqual(projectSettingsSections(session, workspace, p1, resource), ['labels', 'activity', 'deleted']);
  assert.deepEqual(projectSettingsSections(session, workspace, p2, projectResource({ id: p2 })), ['labels', 'activity']);
  const managed = projectResource({ allowed_actions: ['read', 'manage_members'] });
  assert.deepEqual(projectSettingsSections(session, workspace, p1, managed), ['management', 'members', 'labels', 'activity', 'deleted']);
  assert.deepEqual(projectSettingsSections(session, principal, p1, managed), []);
  const owner = { ...session, principal: { ...session.principal, is_owner: true }, allowed_scope: { kind: 'instance' } };
  assert.deepEqual(projectSettingsSections(owner, workspace, p1, managed), ['management', 'members', 'labels', 'activity', 'deleted']);
  assert.deepEqual(projectSettingsSections({ ...owner, allowed_scope: { kind: 'project', workspace_id: workspace, project_id: p2 } }, workspace, p1, managed), []);
  assert.deepEqual(projectSettingsSections(session, workspace, p1, null), []);
  const archived = projectResource({ deleted_at: '2026-10-01T00:00:00Z', allowed_actions: ['read', 'restore'] });
  const grant = { id: 'administrator', principal_id: principal, workspace_id: workspace, project_id: null, revoked_at: null };
  const archivedManager = { ...session, allowed_scope: { kind: 'project_selection', projects: [] }, management_grants: [grant] };
  assert.deepEqual(projectSettingsSections(archivedManager, workspace, p1, archived), ['management']);
  assert.deepEqual(projectSettingsSections({ ...archivedManager, management_grants: [{ ...grant, revoked_at: '2026-10-01T00:01:00Z' }] }, workspace, p1, archived), []);
});

test('project settings preserve legacy routes and only carry verified same-project board filters', () => {
  const filtered = boardPath(workspace, p1, { search: 'design', priorities: ['high'], labels: [] });
  for (const section of ['management', 'members', 'labels', 'activity', 'deleted']) {
    const path = projectSettingsPath(workspace, p1, section, filtered);
    const url = new URL(path, 'https://local.test');
    assert.equal(url.pathname, ['management', 'members'].includes(section) ? '/app/manage' : `${boardPath(workspace, p1)}/${section}`);
    if (['management', 'members'].includes(section)) { assert.equal(url.searchParams.get('workspace'), workspace); assert.equal(url.searchParams.get('project'), p1); }
    assert.equal(url.searchParams.get('section'), section === 'members' ? 'members' : null);
    assert.equal(url.searchParams.get('from'), filtered);
    for (const invalid of ['https://other.invalid/', boardPath(workspace, p2), `${boardPath(workspace, p1)}/activity`]) {
      assert.equal(new URL(projectSettingsPath(workspace, p1, section, invalid), 'https://local.test').searchParams.get('from'), boardPath(workspace, p1));
    }
  }
  assert.equal(new URL(projectSettingsPath(workspace, p1, 'management', filtered, true), 'https://local.test').searchParams.get('archived'), '1');
});

const instanceOwner = { ...session, principal: { ...session.principal, is_owner: true }, allowed_scope: { kind: 'instance' } };
const ownerWorkspacesPath = `/app/admin?section=workspaces&workspace=${workspace}`;

test('Owner settings return sources accept only one fixed target with instance control-plane access', () => {
  assert.equal(ownerWorkspaceSettingsPath(workspace), `/app/manage?workspace=${workspace}&section=settings&return=owner-workspaces`);
  for (const section of ['management', 'members', 'labels', 'activity', 'deleted']) {
    const url = new URL(ownerProjectSettingsPath(workspace, p1, section), 'https://local.test');
    assert.equal(url.searchParams.get('return'), 'owner-workspaces');
    assert.equal(url.searchParams.get('from'), boardPath(workspace, p1));
    assert.equal(ownerWorkspacesReturnPath(instanceOwner, workspace, url.search), ownerWorkspacesPath);
  }
  for (const query of ['', '?return=', '?return=foreign', '?return=https://evil.invalid/', '?return=owner-workspaces&return=owner-workspaces', '?return=owner-workspaces&return=foreign']) {
    assert.equal(ownerWorkspacesReturnPath(instanceOwner, workspace, query), null);
  }
  for (const limitedSession of [session, { ...instanceOwner, allowed_scope: { kind: 'workspace', workspace_id: workspace } }, { ...instanceOwner, allowed_scope: { kind: 'project', workspace_id: workspace, project_id: p1 } }]) {
    assert.equal(ownerWorkspacesReturnPath(limitedSession, workspace, '?return=owner-workspaces'), null);
  }
  assert.equal(ownerWorkspacesReturnPath(instanceOwner, workspace, '?return=owner-workspaces&workspace=foreign&from=https://evil.invalid/'), ownerWorkspacesPath);
  const injected = new URL(projectSettingsPath(workspace, p1, 'labels', '/app/admin?section=workspaces', false, 'https://evil.invalid/'), 'https://local.test');
  assert.equal(injected.searchParams.has('return'), false);
  assert.equal(injected.searchParams.get('from'), boardPath(workspace, p1));
});

test('Owner project settings preserve the fixed return target across tabs and drop it after scope loss', async () => {
  const filtered = boardPath(workspace, p1, { search: 'board filters', priorities: ['high'], labels: [] });
  const history = installProjectHistory(ownerProjectSettingsPath(workspace, p1));
  const changes = [];
  const currentSession = ref(instanceOwner);
  const resource = projectResource({ allowed_actions: ['read', 'update'] });
  globalThis.fetch = async () => { throw new Error('settings navigation must not request business data'); };
  const Wrapper = { setup: () => () => h(SettingsHeader, { session: currentSession.value, workspaceId: workspace, projectId: p1, project: resource, section: 'management', returnTo: filtered, onNavigate: path => changes.push(path) }) };
  const { app, host } = mount(Wrapper);
  try {
    for (const [label, section] of [['Members and permissions', 'members'], ['Labels', 'labels'], ['Activity', 'activity'], ['Deleted issues', 'deleted']]) {
      button(host, label).props.onClick();
      const next = new URL(changes.at(-1), 'https://local.test');
      assert.equal(next.pathname, section === 'members' ? '/app/manage' : `${boardPath(workspace, p1)}/${section}`);
      assert.equal(next.searchParams.get('return'), 'owner-workspaces');
      assert.equal(next.searchParams.get('from'), filtered);
    }
    button(host, '← Back to management').props.onClick();
    assert.equal(changes.at(-1), ownerWorkspacesPath);
    locale.value = 'zh-CN'; await nextTick();
    assert.ok(button(host, '← 返回管理中心'));
    locale.value = 'en';
    currentSession.value = { ...instanceOwner, allowed_scope: { kind: 'project', workspace_id: workspace, project_id: p1 } };
    await nextTick();
    assert.equal(button(host, '← Back to management'), undefined);
    button(host, 'Activity').props.onClick();
    assert.equal(new URL(changes.at(-1), 'https://local.test').searchParams.has('return'), false);
    button(host, '← Back to board').props.onClick();
    assert.equal(changes.at(-1), filtered);
  } finally { app.unmount(); history.restore(); }
});

for (const [Page, section] of [[LabelsPage, 'labels'], [ActivityPage, 'activity'], [DeletedPage, 'deleted']]) {
  test(`the ${section} page keeps its Owner settings source even with a board return prop`, async () => {
    const history = installProjectHistory(ownerProjectSettingsPath(workspace, p1, section));
    const filtered = boardPath(workspace, p1, { search: 'saved', priorities: [], labels: [] });
    globalThis.fetch = async path => Response.json(new URL(path, 'https://local.test').pathname === `/api/v1/workspaces/${workspace}/projects/${p1}` ? projectResource({ allowed_actions: ['read', 'update'] }) : page([]));
    const { app, host } = mount(Page, { session: instanceOwner, workspaceId: workspace, projectId: p1, returnTo: filtered, onNavigate: path => navigate(path) });
    try {
      await until(() => !!button(host, 'Management'));
      button(host, 'Management').props.onClick();
      const target = new URL(history.navigations.at(-1)[1], 'https://local.test');
      assert.equal(target.pathname, '/app/manage');
      assert.equal(target.searchParams.get('return'), 'owner-workspaces');
      assert.equal(target.searchParams.get('from'), section === 'labels' ? boardPath(workspace, p1) : filtered);
      button(host, '← Back to management').props.onClick();
      assert.deepEqual(history.navigations.at(-1), ['push', ownerWorkspacesPath]);
    } finally { app.unmount(); history.restore(); }
  });
}

test('workspace management preserves its Owner source when opening a child project', async () => {
  const history = installProjectHistory(ownerWorkspaceSettingsPath(workspace));
  globalThis.fetch = async path => {
    const pathname = new URL(path, 'https://local.test').pathname;
    return Response.json(pathname === `/api/v1/workspaces/${workspace}` ? { id: workspace, display_name: 'Team', deleted_at: null, version: 2, allowed_actions: ['read', 'update', 'create_project'] }
      : pathname.endsWith('/projects') ? page([projectResource({ allowed_actions: ['read', 'update'] })]) : page([]));
  };
  const { app, host } = mount(ManagementPage, { session: instanceOwner, workspaceId: workspace });
  try {
    await until(() => !!button(host, 'Manage'));
    assert.equal(button(host, 'Workspace settings').props['aria-current'], 'page');
    const settingsForm = all(host).find(item => item.tag === 'form' && text(item).startsWith('Settings'));
    assert.notEqual(settingsForm.style.display, 'none');
    button(host, 'Projects').props.onClick(); await nextTick();
    button(host, 'Manage').props.onClick();
    assert.deepEqual(history.navigations.at(-1), ['push', ownerProjectSettingsPath(workspace, p1)]);
    button(host, '← Back to management').props.onClick();
    assert.deepEqual(history.navigations.at(-1), ['push', ownerWorkspacesPath]);
  } finally { app.unmount(); history.restore(); }
});

test('workspace section query opens only known single sections while normal management and project pages keep their defaults', async () => {
  for (const [query, expected] of [['', 'Projects'], ['&section=projects', 'Projects'], ['&section=settings', 'Workspace settings'], ['&section=members', 'Members and permissions'], ['&section=https://evil.invalid/', 'Projects'], ['&section=settings&section=members', 'Projects']]) {
    const history = installProjectHistory(`/app/manage?workspace=${workspace}${query}`);
    globalThis.fetch = async path => Response.json(new URL(path, 'https://local.test').pathname === `/api/v1/workspaces/${workspace}` ? { id: workspace, display_name: 'Team', deleted_at: null, version: 2, allowed_actions: ['read', 'update', 'create_project'] } : page([]));
    const { app, host } = mount(ManagementPage, { session: instanceOwner, workspaceId: workspace });
    try {
      await until(() => !!button(host, 'Workspace settings'));
      assert.equal(button(host, expected).props['aria-current'], 'page');
      const settingsForm = all(host).find(item => item.tag === 'form' && text(item).startsWith('Settings'));
      assert.equal(settingsForm.style.display === 'none', expected !== 'Workspace settings');
    } finally { app.unmount(); history.restore(); }
  }
  const history = installProjectHistory(`${ownerProjectSettingsPath(workspace, p1)}&section=settings`);
  globalThis.fetch = async path => Response.json(new URL(path, 'https://local.test').pathname === `/api/v1/workspaces/${workspace}/projects/${p1}` ? projectResource({ allowed_actions: ['read', 'update'] }) : page([]));
  const { app, host } = mount(ManagementPage, { session: instanceOwner, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!button(host, 'Management'));
    assert.equal(button(host, 'Management').props['aria-current'], 'page');
    assert.equal(button(host, 'Workspace settings'), undefined);
  } finally { app.unmount(); history.restore(); }
});

test('archived settings return to the management center only with a valid Owner source', () => {
  const archived = projectResource({ deleted_at: '2026-10-01T00:00:00Z', allowed_actions: ['restore'] });
  for (const [currentSession, query, expected] of [[instanceOwner, '?return=owner-workspaces', ownerWorkspacesPath], [instanceOwner, '?return=owner-workspaces&return=owner-workspaces', '/app'], [instanceOwner, '?return=https://evil.invalid/', '/app'], [session, '?return=owner-workspaces', '/app']]) {
    const history = installProjectHistory(`/app/manage?workspace=${workspace}&project=${p1}&archived=1&${query.slice(1)}`);
    const changes = [];
    const { app, host } = mount(SettingsHeader, { session: currentSession, workspaceId: workspace, projectId: p1, project: archived, section: 'management', onNavigate: path => changes.push(path) });
    try {
      button(host, expected === '/app' ? '← Choose project' : '← Back to management').props.onClick();
      assert.deepEqual(changes, [expected]);
      for (const label of ['Members and permissions', 'Labels', 'Activity', 'Deleted issues']) assert.equal(button(host, label), undefined);
    } finally { app.unmount(); history.restore(); }
  }
});

for (const [actions, destination] of [[['read'], 'activity'], [['read', 'update', 'manage_members'], 'management']]) {
  test(`board has one project settings entry and defaults to ${destination} with its current filter`, async () => {
    const filtered = boardPath(workspace, p1, { search: 'saved search', priorities: ['high'], labels: [] });
    const history = installProjectHistory(filtered);
    globalThis.fetch = async path => Response.json(new URL(path, 'https://local.test').pathname.endsWith('/issues/counts') ? issueCounts() : path.includes('/issues?') || path.endsWith('/statuses') ? page([]) : projectResource({ allowed_actions: actions }));
    const { app, host } = mount(Board, { session, workspaceId: workspace, projectId: p1 });
    try {
      await until(() => !!button(host, 'Project settings'));
      for (const label of ['Manage project', 'Manage labels', 'Activity', 'Deleted issues']) assert.equal(button(host, label), undefined);
      all(host).find(item => item.tag === 'input' && item.props.type === 'search').props['onUpdate:modelValue']('not submitted');
      button(host, 'Project settings').props.onClick();
      const currentReturn = boardPath(workspace, p1, { search: 'saved search', priorities: ['high'], labels: [], expanded: ['backlog'] });
      assert.deepEqual(history.navigations, [
        ['replace', currentReturn],
        ['push', projectSettingsPath(workspace, p1, destination, currentReturn)],
      ]);
    } finally { app.unmount(); history.restore(); }
  });
}

test('shared project settings navigation follows permission changes, preserves board filters, and avoids unnecessary reads', async () => {
  const filtered = boardPath(workspace, p1, { search: 'current', priorities: ['urgent'], labels: [] });
  const changes = [];
  const currentSession = ref(session);
  const resource = ref(projectResource({ allowed_actions: ['read', 'manage_members'] }));
  globalThis.fetch = async () => { throw new Error('settings navigation must reuse verified project facts'); };
  const Wrapper = { setup: () => () => h(SettingsHeader, { session: currentSession.value, workspaceId: workspace, projectId: p1, project: resource.value, section: 'labels', returnTo: filtered, onNavigate: path => changes.push(path) }) };
  const { app, host } = mount(Wrapper);
  try {
    assert.equal(button(host, 'Labels').props['aria-current'], 'page');
    button(host, 'Labels').props.onClick(); assert.deepEqual(changes, []);
    button(host, 'Activity').props.onClick();
    button(host, '← Back to board').props.onClick();
    assert.deepEqual(changes, [projectSettingsPath(workspace, p1, 'activity', filtered), filtered]);
    currentSession.value = { ...session, allowed_scope: { ...session.allowed_scope, projects: projects.map(project => ({ ...project, role: 'reader' })) } };
    resource.value = projectResource(); await nextTick();
    assert.equal(button(host, 'Management'), undefined);
    assert.equal(button(host, 'Members and permissions'), undefined);
    assert.equal(button(host, 'Deleted issues'), undefined);
    assert.ok(button(host, 'Labels')); assert.ok(button(host, 'Activity'));
    locale.value = 'zh-CN'; await nextTick();
    assert.ok(button(host, '标签')); assert.ok(button(host, '项目活动'));
  } finally { app.unmount(); }
});

test('archived project management keeps only the management tab and exits to project selection', () => {
  const navigations = [];
  const owner = { ...session, principal: { ...session.principal, is_owner: true }, allowed_scope: { kind: 'instance' } };
  const { app, host } = mount(SettingsHeader, { session: owner, workspaceId: workspace, projectId: p1, project: projectResource({ deleted_at: '2026-10-01T00:00:00Z', allowed_actions: ['restore'] }), section: 'management', onNavigate: path => navigations.push(path) });
  try {
    assert.ok(button(host, 'Management'));
    for (const label of ['Members and permissions', 'Labels', 'Activity', 'Deleted issues', '← Back to board']) assert.equal(button(host, label), undefined);
    button(host, '← Choose project').props.onClick();
    assert.deepEqual(navigations, ['/app']);
  } finally { app.unmount(); }
});

test('the legacy labels page renders project settings for readers without exposing writer actions', async () => {
  const calls = [];
  globalThis.fetch = async path => {
    calls.push(path);
    return Response.json(path.includes('/labels?') ? page([{ id: 'label', name: 'Review', color: null, allowed_actions: ['read'] }]) : projectResource({ id: p2, display_name: 'Reader project' }));
  };
  const { app, host } = mount(LabelsPage, { session, workspaceId: workspace, projectId: p2 });
  try {
    await until(() => text(host).includes('Review'));
    assert.match(text(host), /Project settings/);
    assert.equal(button(host, 'Labels').props['aria-current'], 'page');
    assert.equal(button(host, 'Management'), undefined);
    assert.equal(button(host, 'Deleted issues'), undefined);
    assert.equal(button(host, 'Save'), undefined);
    assert.equal(button(host, 'Edit'), undefined);
    assert.equal(button(host, 'Delete'), undefined);
    assert.equal(all(host).some(item => item.tag === 'form'), false);
    assert.deepEqual(calls.sort(), [`/api/v1/workspaces/${workspace}/projects/${p2}`, `/api/v1/workspaces/${workspace}/projects/${p2}/labels?limit=50`].sort());
  } finally { app.unmount(); }
});

test('leaving a labels draft through project settings tabs still uses the navigation guard', async () => {
  const filtered = boardPath(workspace, p1, { search: 'retain', priorities: ['high'], labels: [] });
  const history = installProjectHistory(projectSettingsPath(workspace, p1, 'labels', filtered));
  globalThis.fetch = async path => Response.json(path.includes('/labels?') ? page([]) : projectResource());
  let allow = false; let confirmations = 0;
  window.confirm = () => { confirmations++; return allow; };
  const { app, host } = mount(LabelsPage, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!button(host, 'Activity'));
    all(host).find(item => item.tag === 'input').props['onUpdate:modelValue']('Unsaved label'); await nextTick();
    button(host, 'Activity').props.onClick();
    assert.equal(confirmations, 1); assert.deepEqual(history.navigations, []);
    allow = true; button(host, 'Activity').props.onClick();
    assert.equal(confirmations, 2);
    assert.deepEqual(history.navigations, [['push', projectSettingsPath(workspace, p1, 'activity', filtered)]]);
  } finally { app.unmount(); history.restore(); }
});

test('project management keeps its shared tabs without granting management controls to ordinary writers', async () => {
  const calls = [];
  globalThis.fetch = async path => { calls.push(path); return Response.json(projectResource()); };
  const { app, host } = mount(ManagementPage, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => text(host).includes('Management is unavailable in this session.'));
    assert.match(text(host), /Project settings/);
    assert.ok(button(host, 'Labels')); assert.ok(button(host, 'Activity')); assert.ok(button(host, 'Deleted issues'));
    assert.equal(button(host, 'Management'), undefined);
    assert.equal(all(host).some(item => item.tag === 'form'), false);
    assert.deepEqual(calls, [`/api/v1/workspaces/${workspace}/projects/${p1}`]);
  } finally { app.unmount(); }
});

for (const section of ['management', 'members']) {
  test(`project ${section} shows only its own controls and loads only the current tab's data`, async () => {
    const history = installProjectHistory(ownerProjectSettingsPath(workspace, p1, section));
    const calls = [];
    globalThis.fetch = async path => {
      const pathname = new URL(path, 'https://local.test').pathname;
      calls.push(pathname);
      return Response.json(pathname === `/api/v1/workspaces/${workspace}/projects/${p1}`
        ? projectResource({ context: 'Project notes', allowed_actions: ['read', 'update', 'delete', 'manage_status_names', 'manage_administrators', 'manage_members'] })
        : pathname.endsWith('/statuses') ? page([{ key: 'todo', display_name: 'To do', version: 2 }])
        : pathname.endsWith('/members') ? page([{ principal_id: principal, display_name: 'Current member', effective_role: 'writer', sources: [{ kind: 'project_grant', id: 'direct', role: 'writer' }] }])
        : page([]));
    };
    const { app, host } = mount(ManagementPage, { session: instanceOwner, workspaceId: workspace, projectId: p1 });
    try {
      await until(() => section === 'members' ? text(host).includes('Current member') : text(host).includes('Status names'));
      assert.equal(button(host, section === 'members' ? 'Members and permissions' : 'Management').props['aria-current'], 'page');
      if (section === 'management') {
        assert.match(text(host), /Settings.*Status names.*Project availability/);
        assert.doesNotMatch(text(host), /Administrators|Effective members|Direct memberships|Project invitations/);
        assert.deepEqual(calls.sort(), [`/api/v1/workspaces/${workspace}/projects/${p1}`, `/api/v1/workspaces/${workspace}/projects/${p1}/statuses`].sort());
      } else {
        assert.match(text(host), /Administrators.*Effective members and permission sources.*Direct memberships.*Project invitations/);
        assert.doesNotMatch(text(host), /Status names|Project availability/);
        assert.equal(all(host).some(item => item.tag === 'textarea'), false);
        for (const endpoint of ['administrators', 'members', 'administrator-candidates', 'member-candidates']) {
          assert.ok(calls.includes(`/api/v1/workspaces/${workspace}/projects/${p1}/${endpoint}`), endpoint);
        }
        assert.ok(calls.includes(`/api/v1/admin/projects/${p1}/grants`));
        assert.equal(calls.some(path => path.endsWith('/statuses')), false);
        locale.value = 'zh-CN'; await nextTick();
        assert.equal(button(host, '成员与权限').props['aria-current'], 'page');
        assert.match(text(host), /管理员.*有效成员与权限来源.*直接成员授权.*项目邀请/);
        locale.value = 'en'; await nextTick();
      }
      button(host, '← Back to management').props.onClick();
      assert.deepEqual(history.navigations.at(-1), ['push', ownerWorkspacesPath]);
    } finally { app.unmount(); history.restore(); }
  });
}

test('direct members links do not expose permission controls to ordinary writers', async () => {
  const history = installProjectHistory(projectSettingsPath(workspace, p1, 'members'));
  const calls = [];
  globalThis.fetch = async path => { calls.push(path); return Response.json(projectResource()); };
  const { app, host } = mount(ManagementPage, { session, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => text(host).includes('Management is unavailable in this session.'));
    assert.equal(button(host, 'Members and permissions'), undefined);
    assert.doesNotMatch(text(host), /Administrators|Effective members|Project invitations/);
    assert.deepEqual(calls, [`/api/v1/workspaces/${workspace}/projects/${p1}`]);
  } finally { app.unmount(); history.restore(); }
});

test('archived members links fall back to project management without fetching member data', async () => {
  const history = installProjectHistory(ownerProjectSettingsPath(workspace, p1, 'members', true));
  const calls = [];
  globalThis.fetch = async path => { calls.push(path); return Response.json(projectResource({ deleted_at: '2026-10-01T00:00:00Z', allowed_actions: ['read', 'restore'] })); };
  const { app, host } = mount(ManagementPage, { session: instanceOwner, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => !!button(host, 'Restore project'));
    assert.equal(button(host, 'Management').props['aria-current'], 'page');
    assert.equal(button(host, 'Members and permissions'), undefined);
    assert.doesNotMatch(text(host), /Administrators|Effective members|Project invitations/);
    assert.deepEqual(calls, [`/api/v1/workspaces/${workspace}/projects/${p1}?deleted=only`]);
  } finally { app.unmount(); history.restore(); }
});

test('switching from project settings drafts to members preserves the navigation guard and return context', async () => {
  const filtered = boardPath(workspace, p1, { search: 'saved filters', priorities: [], labels: [] });
  const start = projectSettingsPath(workspace, p1, 'management', filtered, false, 'owner-workspaces');
  const history = installProjectHistory(start);
  globalThis.fetch = async () => Response.json(projectResource({ context: 'Saved notes', allowed_actions: ['read', 'update', 'manage_members'] }));
  let allow = false; let confirmations = 0;
  window.confirm = () => { confirmations++; return allow; };
  const { app, host } = mount(ManagementPage, { session: instanceOwner, workspaceId: workspace, projectId: p1 });
  try {
    await until(() => all(host).some(item => item.tag === 'textarea'));
    all(host).find(item => item.tag === 'textarea').props['onUpdate:modelValue']('Unsaved project notes'); await nextTick();
    button(host, 'Members and permissions').props.onClick();
    assert.equal(confirmations, 1); assert.deepEqual(history.navigations, []);
    allow = true; button(host, 'Members and permissions').props.onClick();
    assert.equal(confirmations, 2);
    assert.deepEqual(history.navigations, [['push', projectSettingsPath(workspace, p1, 'members', filtered, false, 'owner-workspaces')]]);
  } finally { app.unmount(); history.restore(); }
});

test('workspace management remains separate from project settings tabs', async () => {
  const calls = [];
  globalThis.fetch = async path => { calls.push(path); return Response.json({ id: workspace, display_name: 'Team', deleted_at: null, allowed_actions: ['read'] }); };
  const { app, host } = mount(ManagementPage, { session, workspaceId: workspace });
  try {
    await until(() => text(host).includes('Management is unavailable in this session.'));
    assert.match(text(host), /Workspace management/);
    assert.doesNotMatch(text(host), /Project settings/);
    assert.equal(button(host, 'Labels'), undefined);
    assert.equal(button(host, 'Activity'), undefined);
    assert.equal(button(host, 'Deleted issues'), undefined);
    assert.deepEqual(calls, [`/api/v1/workspaces/${workspace}`]);
  } finally { app.unmount(); }
});


test('sharing copies only canonical ID/link and falls back to selectable original Markdown', async () => {
  const { app, host } = mount(Share, { identifier: 'CFK-42', origin: 'https://example.test' });
  try {
    const trigger = all(host).filter(item => item.tag === 'button' && item.props['aria-label'] === 'Copy issue');
    assert.equal(trigger.length, 1);
    assert.equal(text(trigger[0]), 'Copy');
    const menu = all(host).find(item => item.props.onOpen);
    assert.deepEqual(menu.props.content, { align: 'end', sideOffset: 4, collisionPadding: 8 });
    menu.props.onOpen(); await nextTick();
    await button(host, 'Copy link').props.onClick({ stopPropagation() {} }); await nextTick();
    assert.equal(all(host).find(item => item.tag === 'textarea').props.value, 'https://example.test/app/issues/CFK-42');
    assert.ok(all(host).some(item => item.props.role === 'alert'));
    assert.equal(all(host).some(item => item.props.role === 'status'), false);
    assert.doesNotMatch(text(host), /Handoff summary|Start with|Agent session/);
  } finally { app.unmount(); }
  const invalid = mount(Share, { identifier: 'CFK-42', origin: 'https://example.test/app/launch?code=must-not-copy' });
  try { assert.equal(button(invalid.host, 'Copy link'), undefined); } finally { invalid.app.unmount(); }
  const raw = '**Original**\n\n- [ ] Task';
  const copy = mount(Copy, { value: raw, label: 'Copy Markdown', showLabel: true });
  try {
    await button(copy.host, 'Copy Markdown').props.onClick({ stopPropagation() {} }); await nextTick();
    assert.equal(all(copy.host).find(item => item.tag === 'textarea').props.value, raw);
  } finally { copy.app.unmount(); }
});

function useClipboard(t, writeText) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; });
}

test('the shared copy menu writes the selected canonical value with localized success and honors disabled state', async t => {
  const writes = [];
  useClipboard(t, async value => { writes.push(value); });
  for (const [language, idLabel, linkLabel, success] of [['en', 'Copy ID', 'Copy link', 'Link copied'], ['zh-CN', '复制编号', '复制链接', '链接已复制']]) {
    locale.value = language;
    const { app, host } = mount(Share, { identifier: 'CFK-42', origin: 'https://EXAMPLE.test:443/' });
    try {
      await button(host, idLabel).props.onClick(); await nextTick();
      assert.equal(writes.at(-1), 'CFK-42');
      await button(host, linkLabel).props.onClick(); await nextTick();
      assert.equal(writes.at(-1), 'https://example.test/app/issues/CFK-42');
      assert.equal(text(all(host).find(item => item.props.role === 'status')), success);
      assert.equal(all(host).find(item => item.tag === 'textarea'), undefined);
    } finally { app.unmount(); }
  }
  locale.value = 'en';
  const disabled = mount(Share, { identifier: 'CFK-42', origin: 'https://example.test', disabled: true });
  try {
    const before = writes.length;
    assert.ok(all(disabled.host).filter(item => item.tag === 'button').every(item => item.props.disabled));
    await button(disabled.host, 'Copy ID').props.onClick();
    await button(disabled.host, 'Copy link').props.onClick();
    assert.equal(writes.length, before);
  } finally { disabled.app.unmount(); }
});

test('copy feedback ignores an old Issue result and failed retries retain the exact text without stale success', async t => {
  let settle;
  let rejectCopy = false;
  const writes = [];
  useClipboard(t, value => {
    writes.push(value);
    if (rejectCopy) return Promise.reject(new Error('Clipboard denied'));
    return new Promise(resolve => { settle = resolve; });
  });
  const props = ref({ identifier: 'CFK-42', origin: 'https://example.test' });
  const { app, host } = mount({ setup: () => () => h(Share, props.value) });
  try {
    const first = button(host, 'Copy ID').props.onClick(); await nextTick();
    await button(host, 'Copy link').props.onClick();
    assert.deepEqual(writes, ['CFK-42']);
    assert.equal(all(host).some(item => item.props.role === 'status'), false);
    props.value = { identifier: 'CFK-43', origin: 'https://other.test' }; await nextTick();
    assert.equal(all(host).find(item => item.props['aria-label'] === 'Copy issue').props.disabled, true);
    settle(); await first; await nextTick();
    assert.equal(all(host).some(item => item.props.role === 'status'), false);
    const succeeded = button(host, 'Copy link').props.onClick();
    settle(); await succeeded; await nextTick();
    assert.match(text(host), /Link copied/);
    rejectCopy = true;
    await button(host, 'Copy link').props.onClick(); await nextTick();
    assert.equal(all(host).some(item => item.props.role === 'status'), false);
    assert.equal(text(all(host).find(item => item.props['aria-label'] === 'Copy issue')), 'Copy');
    const fallback = all(host).find(item => item.tag === 'textarea');
    assert.equal(fallback.props.value, 'https://other.test/app/issues/CFK-43');
    let selected = false;
    fallback.props.onFocus({ target: { select() { selected = true; } } });
    assert.equal(selected, true);
    props.value = { identifier: 'CFK-44', origin: 'http://127.0.0.1:49152' }; await nextTick();
    assert.equal(all(host).find(item => item.tag === 'textarea'), undefined);
    assert.equal(button(host, 'Copy link'), undefined);
  } finally { app.unmount(); }
});
