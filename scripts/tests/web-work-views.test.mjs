import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, afterEach } from 'node:test';
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
globalThis.window = { location: { pathname: "/app/work", search: "" }, navigator: { languages: ["en"] }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
afterEach(() => { globalThis.fetch = originalFetch; locale.value = "en"; });
after(() => { globalThis.window = originalWindow; });
const originalDocumentClass = globalThis.Document;
const originalShadowRoot = globalThis.ShadowRoot;
globalThis.Document = class {};
globalThis.ShadowRoot = class {};
after(() => { globalThis.Document = originalDocumentClass; globalThis.ShadowRoot = originalShadowRoot; });
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `export { default as WorkList } from './apps/web/src/views/WorkListView.vue'; export { default as Board } from './apps/web/src/views/ProjectBoardView.vue'; export { default as Activity } from './apps/web/src/components/ProjectActivity.vue'; export { default as Context } from './apps/web/src/components/IssueContext.vue'; export { default as Footer } from './apps/web/src/components/AppFooter.vue'; export { workListPath, workProjects } from './apps/web/src/lib/work-list.ts'; export { contextHandoff } from './apps/web/src/lib/issue-context.ts'; export { activityTargets } from './apps/web/src/lib/project-activity.ts'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', loader: { '.png': 'dataurl' },
  plugins: [{ name: 'vue-test', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
      const compiled = compileScript(descriptor, { id: 'attachment-test', inlineTemplate: true });
      return { contents: compiled.content, loader: 'ts', resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL('../../node_modules/vue/index.mjs', import.meta.url).href, external: true }));
  } }],
});
const { WorkList, Board, Activity, Context, Footer, workListPath, workProjects, contextHandoff, activityTargets, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);



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
const filter = { projects: [p1], queue: 'all', status: '', assignee: '', search: '', priorities: [], labels: [] };
const page = (items, cursor = null) => ({ items, has_more: !!cursor, next_cursor: cursor });
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

test('board filters reset every column, discard old continuation and request new pages with repeated parameters', async () => {
  const calls = []; let resolveOld;
  const labelId = '00000000-0000-4000-8000-000000000080';
  globalThis.fetch = async path => {
    calls.push(path);
    const url = new URL(path, 'https://local.test');
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
    assert.doesNotMatch(text(host), /Issue initial/); assert.match(text(host), /Filters changed/);
    resolveOld(Response.json(page([{ ...issue('obsolete'), labels: [] }]))); await pending; await nextTick();
    assert.doesNotMatch(text(host), /Issue obsolete/);
    const before = calls.length;
    await all(host).find(item => item.tag === 'form' && item.props.class === 'board-query-filters').props.onSubmit({ preventDefault() {}, stopPropagation() {} }); await nextTick();
    const queries = calls.slice(before).filter(path => new URL(path, 'https://local.test').pathname.endsWith('/issues'));
    assert.equal(queries.length, 5);
    for (const path of queries) {
      const params = new URL(path, 'https://local.test').searchParams;
      assert.deepEqual(params.getAll('priority'), ['high', 'urgent']); assert.deepEqual(params.getAll('label'), [labelId]);
      assert.equal(params.has('cursor'), false); assert.equal(params.has('blocked'), false);
    }
    assert.match(text(host), /Issue current/); assert.doesNotMatch(text(host), /Filters changed/);
  } finally { app.unmount(); }
});

for (const status of [403, 404]) {
  test(`board retains access failure after selected labels are cleared on project ${status}, then recovers on retry`, async () => {
    const calls = []; let phase = 'initial';
    const labelId = '00000000-0000-4000-8000-000000000080';
    const projectPath = `/api/v1/workspaces/${workspace}/projects/${p1}`;
    globalThis.fetch = async path => {
      calls.push(path);
      const url = new URL(path, 'https://local.test');
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
    const applyFilters = () => all(host).find(item => item.tag === 'form' && item.props.class === 'board-query-filters').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
    try {
      await until(() => text(host).includes('Issue before-access-failure'));
      await button(host, 'Choose labels').props.onClick(); await nextTick();
      all(host).find(item => item.tag === 'input' && item.props.value === labelId).props.onChange(); await nextTick();
      await applyFilters(); await nextTick();
      assert.match(text(host), /Issue before-access-failure/);
      assert.match(text(host), /Labels · 1\/20/);

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
  globalThis.fetch = async path => { calls.push(path); if (fail) throw Error('offline'); return Response.json(page([event], calls.length === 1 ? 'event-next' : null)); };
  const { app, host } = mount(Activity, { projectId: p1 });
  try {
    await until(() => text(host).includes('Issue updated'));
    assert.equal(new URL(calls[0], 'https://local.test').searchParams.get('project'), p1);
    assert.equal(new URL(calls[0], 'https://local.test').searchParams.get('limit'), '20');
    assert.doesNotMatch(text(host), /hidden payload/);
    fail = true; await button(host, 'Load more activity').props.onClick(); await nextTick();
    fail = false; await button(host, 'Retry').props.onClick(); await nextTick();
    assert.equal(new URL(calls[2], 'https://local.test').searchParams.get('after'), 'event-next');
    assert.equal(all(host).filter(item => item.tag === 'li').length, 1);
  } finally { app.unmount(); }
});

const contextFixture = () => ({ issue: issue(), truncated: true, sections: {
  body: { content: '<script>alert(1)</script>', omitted_bytes: 5, truncated: true, continuation: '/api/v1/issues/CFK-1' },
  project_context: { content: 'Project excerpt', omitted_bytes: 10, truncated: true, continuation: 'https://untrusted.test/do-not-fetch' },
  comments: { items: [{ id: '00000000-0000-4000-8000-000000000005', kind: 'completion', author: { display_name: 'Pat', principal_id: principal }, created_at: '2026-09-28T01:00:00Z', version: 1, body: 'Verified', completion: { summary: 'Verified', verification: ['Unit test'], artifacts: [{ kind: 'url', value: 'javascript:alert(1)' }], follow_ups: ['Next task'] } }], omitted_count: 3, continuation: '/api/v1/issues/CFK-1/comments' },
  relations: { items: [], omitted_count: 2, continuation: '/api/v1/issues/CFK-1/relations' },
} });
test('handoff renders safe structured sections, explicit omitted counts, local continuation and copy fallback', async () => {
  const calls = []; globalThis.fetch = async path => { calls.push(path); return Response.json(path.endsWith('/context') ? contextFixture() : { context: 'Full background' }); };
  const { app, host } = mount(Context, { identifier: 'CFK-1', scopeBoundary: 'initial-scope' });
  try {
    await until(() => text(host).includes('Project excerpt') || all(host).some(item => item.props.innerHTML?.includes('Project excerpt')));
    assert.match(text(host), /bounded excerpt|Omitted bytes/);
    const rendered = all(host).filter(item => item.props.innerHTML).map(item => item.props.innerHTML).join('');
    assert.doesNotMatch(rendered, /<script>/); assert.match(rendered, /&lt;script&gt;/);
    assert.ok(all(host).some(item => item.tag === 'a' && item.props.href === '#issue-activity'));
    assert.ok(all(host).some(item => item.tag === 'a' && item.props.href === '#issue-relations'));
    assert.ok(!all(host).some(item => item.tag === 'a' && item.props.href?.startsWith('javascript:')));
    assert.match(text(host), /Verified.*Verification.*Unit test.*Artifacts.*javascript:alert\(1\).*Follow-ups.*Next task/);
    await button(host, 'Read full project background').props.onClick(); await nextTick();
    assert.equal(calls[1], `/api/v1/workspaces/${workspace}/projects/${p1}`);
    await button(host, 'Copy handoff summary').props.onClick(); await nextTick();
    const copy = all(host).find(item => item.tag === 'textarea'); assert.ok(copy);
    assert.match(copy.props.value, /Verification: Unit test/);
    assert.match(copy.props.value, /Artifacts: javascript:alert\(1\)/);
    assert.match(copy.props.value, /Follow-ups: Next task/);
    assert.doesNotMatch(copy.props.value, /"verification"|"allowed_actions"/);
    assert.match(contextHandoff(contextFixture(), true), /省略|继续阅读|后续/);
  } finally { app.unmount(); }
});

test('handoff preserves completion evidence with an empty summary and never renders its storage JSON', async () => {
  const context = contextFixture();
  context.sections.comments.items[0].body = '';
  context.sections.comments.items[0].completion.summary = '';
  context.sections.comments.items.push({
    id: '00000000-0000-4000-8000-000000000006', kind: 'standard', version: 1,
    author: { display_name: 'Pat', principal_id: principal }, created_at: '2026-09-28T02:00:00Z',
    body: 'Ordinary follow-up', completion: null,
  });
  globalThis.fetch = async () => Response.json(context);
  const { app, host } = mount(Context, { identifier: 'CFK-1', scopeBoundary: 'initial-scope' });
  try {
    await until(() => text(host).includes('Completed'));
    assert.match(text(host), /Completed.*Verification.*Unit test.*Artifacts.*Follow-ups.*Next task/);
    assert.ok(all(host).some(item => item.props.innerHTML?.includes('Ordinary follow-up')));
    await button(host, 'Copy handoff summary').props.onClick(); await nextTick();
    const copy = all(host).find(item => item.tag === 'textarea').props.value;
    assert.match(copy, /Completed\nVerification: Unit test\nArtifacts: javascript:alert\(1\)\nFollow-ups: Next task/);
    assert.match(copy, /Ordinary follow-up/);
    assert.doesNotMatch(copy, /"summary"|"verification"|"artifacts"|"follow_ups"/);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /已完成.*验证.*Unit test.*产物.*后续.*Next task/);
    assert.match(contextHandoff(context, true), /已完成\n验证: Unit test/);
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

test('refreshing handoff during project continuation permits a fresh continuation and discards the old response', async () => {
  let resolveOld; let projectCalls = 0;
  globalThis.fetch = async path => {
    if (path.endsWith('/context')) return Response.json(contextFixture());
    projectCalls++;
    if (projectCalls === 1) return new Promise(resolve => { resolveOld = resolve; });
    return Response.json({ context: 'Current full background' });
  };
  const { app, host } = mount(Context, { identifier: 'CFK-1', scopeBoundary: 'initial-scope' });
  try {
    await until(() => !!button(host, 'Read full project background'));
    const pending = button(host, 'Read full project background').props.onClick(); await nextTick();
    assert.equal(button(host, 'Read full project background').props.disabled, true);
    await button(host, 'Refresh').props.onClick(); await nextTick();
    assert.equal(button(host, 'Read full project background').props.disabled, false);
    resolveOld(Response.json({ context: 'Obsolete background' })); await pending; await nextTick();
    assert.ok(!all(host).some(item => item.props.innerHTML?.includes('Obsolete background')));
    await button(host, 'Read full project background').props.onClick(); await nextTick();
    assert.equal(projectCalls, 2);
    assert.ok(all(host).some(item => item.props.innerHTML?.includes('Current full background')));
  } finally { app.unmount(); }
});

test('unchanged issue version still clears rendered and copyable context after a project visibility change', async () => {
  const scope = ref('two-projects'); let resolveFresh; let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      const context = contextFixture();
      context.sections.relations.items = [{ id: 'cross-project', source_identifier: 'CFK-1', target_identifier: 'CFK-99', kind: 'related', version: 1 }];
      return Response.json(context);
    }
    return new Promise(resolve => { resolveFresh = resolve; });
  };
  const Wrapper = { setup: () => () => h(Context, { identifier: 'CFK-1', scopeBoundary: scope.value }) };
  const { app, host } = mount(Wrapper);
  try {
    await until(() => text(host).includes('CFK-99'));
    await button(host, 'Copy handoff summary').props.onClick(); await nextTick();
    assert.match(all(host).find(item => item.tag === 'textarea').props.value, /CFK-99/);
    scope.value = 'one-project'; await nextTick();
    assert.doesNotMatch(text(host), /CFK-99/);
    assert.equal(button(host, 'Copy handoff summary'), undefined);
    assert.equal(all(host).find(item => item.tag === 'textarea'), undefined);
    resolveFresh(Response.json(contextFixture())); await until(() => !!button(host, 'Copy handoff summary'));
    assert.equal(calls, 2); assert.doesNotMatch(text(host), /CFK-99/);
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
