import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WorkbenchBridge } from '../src/workbench/bridge.mjs';
import { ISSUE_COLLECTION_LIMIT, WorkbenchController } from '../src/workbench/controller.mjs';
import { STATUSES, validateCheckpoint, isSessionReference } from '../src/workbench/shared.mjs';

let adapterModule;
async function adapterExports() {
  if (!adapterModule) {
    const output = await build({ entryPoints: [fileURLToPath(new URL('../src/workbench/embed-adapter.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser' });
    adapterModule = import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  }
  return adapterModule;
}
const ok = data => ({ ok: true, status: 200, data });
const action = (action, payload = {}) => ({ type: 'action', id: randomUUID(), action, payload });
const paginationRow = (number, key = 'todo', version = 1) => ({ identifier: `CFK-${number}`, title: `Issue ${number}`, version, priority: 'none', status: { key }, allowed_actions: ['read', 'update'], body: 'Never retain a collection body' });
function paginationController(reply, view = 'board') {
  const calls = [];
  const controller = new WorkbenchController({ call: async (endpoint, payload, signal) => {
    calls.push({ endpoint, input: structuredClone(payload.input), signal });
    return { ok: true, value: await reply(endpoint, payload.input, signal) };
  } }, new AbortController().signal, () => randomUUID(), { initialView: view });
  const binding = { binding_id: randomUUID(), project: { id: randomUUID() }, identity: { instance: { instance_id: randomUUID() }, principal: { principal_id: randomUUID() } }, statuses: STATUSES.map(key => ({ key })) };
  controller.patch({ binding });
  return { controller, calls, binding };
}
function fixture({ reader = false, uncertain = false, locale = null, theme = 'orange', uncertainPreference = false, uncertainLabel = false } = {}) {
  const ids = { instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), principal_id: randomUUID() };
  const person = { principal_id: randomUUID(), display_name: 'Public writer' };
  const label = { id: randomUUID(), name: 'Existing project label' };
  const nextLabel = { id: randomUUID(), name: 'Next page label' };
  let principal = { id: ids.principal_id, principal_id: ids.principal_id, display_name: 'Fixture', version: 1, locale, theme, grants: [{ workspace_id: ids.workspace_id, project_id: ids.project_id, role: reader ? 'reader' : 'writer' }] };
  let issue = { id: randomUUID(), identifier: 'CFK-1', title: 'Work', version: 3, priority: 'none', status: { key: 'todo', display_name: 'Todo' }, project: { id: ids.project_id }, workspace: { id: ids.workspace_id }, allowed_actions: reader ? ['read'] : ['read', 'update'], comments: [], labels: [] };
  const preferenceReceipts = new Map();
  const labelReceipts = new Map();
  let unknown = uncertain;
  let denied = false;
  let scopeReads = 0;
  const calls = [];
  const operator = {};
  const target = { instance_id: ids.instance_id, workspace_id: ids.workspace_id, project_id: ids.project_id };
  const bridge = new WorkbenchBridge({ directory: '/trusted-launcher-only', host: { singleUserLocal: true, hasWebServer: true, webHost: '127.0.0.1', operator }, directoryReader: async ({ signal }) => { scopeReads++; assert.ok(signal instanceof AbortSignal); return { status: 'configured', targets: [target] }; }, createFacade: config => ({ callTool: async (name, args) => {
    calls.push({ name, args, config });
    if (denied) return { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED' } };
    if (name === 'cfkanban_connection_inspect') return ok({ instance: { instance_id: ids.instance_id, trusted_api_origin: 'https://isolated.fixture.invalid' }, principal: structuredClone(principal) });
    if (name === 'cfkanban_projects_get') return ok({ id: ids.project_id, display_name: 'Project' });
    if (name === 'cfkanban_statuses_list') return ok({ items: STATUSES.map(key => ({ key, display_name: key })) });
    if (name === 'cfkanban_issues_list') return ok({ items: !args.status || args.status.includes(issue.status.key) ? [structuredClone(issue)] : [], next_cursor: args.status?.includes('todo') && !args.cursor ? 'private-column-cursor' : null });
    if (name === 'cfkanban_issues_get') return ok(structuredClone(issue));
    if (name === 'cfkanban_assignees_list') return ok({ items: [person], next_cursor: args.cursor ? null : 'private-assignee-cursor' });
    if (name === 'cfkanban_labels_list') return ok({ items: args.cursor ? [nextLabel] : [label], next_cursor: args.cursor ? null : 'private-label-cursor' });
    if (name === 'cfkanban_profile_locale_set') {
      if (preferenceReceipts.has(args.idempotency_key)) return preferenceReceipts.get(args.idempotency_key);
      if (args.expected_version !== principal.version) return { ok: false, status: 409, error: { code: 'VERSION_CONFLICT' } };
      principal = { ...principal, locale: args.locale, version: principal.version + 1 };
      const result = ok({ resource: structuredClone(principal) });
      preferenceReceipts.set(args.idempotency_key, result);
      if (uncertainPreference) { uncertainPreference = false; return { ok: false, status: 0, outcome_unknown: true, error: { code: 'NETWORK_ERROR' } }; }
      return result;
    }
    if (['cfkanban_issues_labels_add', 'cfkanban_issues_labels_remove'].includes(name)) {
      if (labelReceipts.has(args.idempotency_key)) return labelReceipts.get(args.idempotency_key);
      if (args.expected_version !== issue.version) return { ok: false, status: 409, error: { code: 'VERSION_CONFLICT' } };
      const selected = [label, nextLabel].find(row => row.id === args.label_id);
      if (!selected) return { ok: false, status: 404, error: { code: 'NOT_FOUND' } };
      issue = { ...issue, version: issue.version + 1, labels: name === 'cfkanban_issues_labels_add' ? [...issue.labels, selected] : issue.labels.filter(row => row.id !== selected.id) };
      const result = ok({ resource: structuredClone(issue) });
      labelReceipts.set(args.idempotency_key, result);
      if (uncertainLabel) { uncertainLabel = false; return { ok: false, status: 0, outcome_unknown: true, error: { code: 'NETWORK_ERROR' } }; }
      return result;
    }
    if (name === 'cfkanban_issues_update') {
      if (unknown) { unknown = false; return { ok: false, status: 0, outcome_unknown: true, error: { code: 'NETWORK_ERROR' } }; }
      issue = { ...issue, version: issue.version + 1, priority: args.changes.priority_key ?? issue.priority, status: args.changes.status_key ? { key: args.changes.status_key, display_name: args.changes.status_key } : issue.status, assignee: args.changes.assignee_principal_id === null ? null : args.changes.assignee_principal_id ? person : issue.assignee };
      return ok({ resource: structuredClone(issue) });
    }
    return ok({ items: [] });
  } }) });
  const call = (endpoint, input = {}) => bridge.call(endpoint, { protocol: 1, input }, new AbortController().signal, operator);
  const controller = new WorkbenchController({ call: async (endpoint, payload, signal) => ({ ok: true, value: await bridge.call(endpoint, payload, signal, operator) }) }, new AbortController().signal);
  return { bridge, controller, ids, target, person, label, nextLabel, calls, call, get scopeReads() { return scopeReads; }, get issue() { return issue; }, get principal() { return principal; }, deny() { denied = true; } };
}

function interceptFacade(f, intercept) {
  const createFacade = f.bridge.createFacade;
  f.bridge.createFacade = config => {
    const facade = createFacade(config);
    return { callTool: (...args) => intercept(facade, ...args) };
  };
}

test('standalone directory scope binds without a fabricated Session and rejects Client paths and removed execution endpoints', async () => {
  const f = fixture();
  assert.equal((await f.call('workspace_scope', { directory: '/arbitrary' })).error.code, 'PANEL_INVALID_INPUT');
  assert.equal(f.scopeReads, 0);
  await f.controller.bootstrap(null);
  assert.equal(f.controller.state.source_session_id, null);
  assert.ok(f.controller.state.binding);
  assert.equal(f.controller.state.view, 'board');
  assert.equal(f.controller.state.board.columns.length, 5);
  assert.equal(f.calls.some(row => row.args.session_id), false);
  const before = f.calls.length;
  for (const endpoint of ['handoff', 'prepare_handoff', 'recover_handoff', 'associations', 'verify_session']) assert.equal((await f.call(endpoint)).error.code, 'PANEL_UNKNOWN_OPERATION');
  assert.equal(f.calls.length, before);
  assert.equal((await f.call('session_scope', { session_id: `session-${randomUUID()}` })).error.code, 'PANEL_SESSION_UNAVAILABLE');
  f.controller.dispose(); f.bridge.dispose();
});

test('board reads only explicit bounded columns and paginates one column with its retained cursor', async () => {
  const f = fixture(); await f.controller.bootstrap();
  const pages = f.calls.filter(row => row.name === 'cfkanban_issues_list');
  assert.equal(pages.length, 5);
  assert.deepEqual(pages.map(row => row.args.status[0]), STATUSES);
  assert.ok(pages.every(row => row.args.limit === 25 && row.args.project_ids.length === 1 && row.args.project_ids[0] === f.ids.project_id));
  await f.controller.boardPage('todo', true);
  const next = f.calls.filter(row => row.name === 'cfkanban_issues_list').at(-1);
  assert.equal(next.args.cursor, 'private-column-cursor');
  assert.deepEqual(next.args.status, ['todo']);
  assert.equal((await f.call('board', { binding_id: f.controller.state.binding.binding_id, cursor: 'unscoped' })).error.code, 'PANEL_INVALID_INPUT');
  f.controller.dispose(); f.bridge.dispose();
});

test('quick edits use the displayed row CAS, exact loaded assignees and the original recovery key', async () => {
  const f = fixture({ uncertain: true }); await f.controller.bootstrap();
  const { WorkbenchAdapter } = await adapterExports();
  const adapter = new WorkbenchAdapter(f.controller);
  assert.equal((await adapter.receive(action('quick_update', { identifier: 'CFK-9', change: { priority_key: 'high' } }))).error.code, 'PANEL_INVALID_INPUT');
  assert.equal((await adapter.receive(action('quick_update', { identifier: 'CFK-1', change: { assignee_principal_id: f.person.principal_id } }))).error.code, 'PANEL_INVALID_INPUT');
  await adapter.receive(action('assignees', { next: false }));
  await adapter.receive(action('assignees', { next: true }));
  const peopleReads = f.calls.filter(row => row.name === 'cfkanban_assignees_list');
  assert.equal(peopleReads.length, 2); assert.equal(peopleReads[1].args.cursor, 'private-assignee-cursor'); assert.ok(peopleReads.every(row => row.args.limit === 20));
  const unknown = await adapter.receive(action('quick_update', { identifier: 'CFK-1', change: { assignee_principal_id: f.person.principal_id, priority_key: 'high' } }));
  assert.equal(unknown.outcome_unknown, true);
  const original = structuredClone(f.controller.state.pending);
  assert.equal(original.expected_version, 3);
  assert.equal(f.controller.state.issue, null);
  assert.equal((await adapter.receive(action('view', { mode: 'list' }))).error.code, 'PANEL_INVALID_INPUT');
  assert.equal((await adapter.receive(action('recover'))).ok, true);
  const writes = f.calls.filter(row => row.name === 'cfkanban_issues_update');
  assert.equal(writes.length, 2); assert.ok(writes.every(row => row.args.idempotency_key === original.idempotency_key && row.args.expected_version === 3));
  assert.equal(f.controller.state.pending, null);
  assert.equal(f.controller.state.issue, null);
  assert.equal(f.issue.assignee.principal_id, f.person.principal_id);
  assert.equal((await adapter.receive(action('quick_update', { identifier: 'CFK-1', change: { status_key: 'done' } }))), undefined);
  adapter.dispose(); f.controller.dispose(); f.bridge.dispose();
});

test('protocol snapshot preserves unavailable current assignees and never exposes column or assignee cursors', async () => {
  const f = fixture(); await f.controller.bootstrap(); await f.controller.loadAssignees();
  f.controller.patch({ issue: { ...f.issue, assignee: { ...f.person, available: false } } });
  const { projectSnapshot, WorkbenchAdapter } = await adapterExports();
  const messages = [];
  const adapter = new WorkbenchAdapter(f.controller);
  adapter.attach({ start() {}, close() {}, postMessage(message) { messages.push(message); } });
  assert.equal(messages.at(-1).state.error, null);
  assert.equal(messages.at(-1).state.issue.assignee.available, false);
  const projected = projectSnapshot(f.controller.state, null);
  assert.equal(projected.issue.assignee.available, false);
  assert.equal(projected.assignees[0].principal_id, f.person.principal_id);
  assert.equal(projected.assignees_has_more, true);
  assert.equal(projected.board.columns.find(column => column.key === 'todo').has_more, true);
  assert.doesNotMatch(JSON.stringify(projected), /private-column-cursor|private-assignee-cursor|binding_id|idempotency_key/);
  assert.deepEqual(Object.keys(projected.capabilities).sort(), ['comment', 'complete', 'update']);
  adapter.dispose(); f.controller.dispose(); f.bridge.dispose();
});

test('reader rows never gain quick edit controls and stale displayed CAS is rejected before a write', async () => {
  for (const reader of [true, false]) {
    const f = fixture({ reader }); await f.controller.bootstrap();
    const row = f.controller.loadedIssue('CFK-1');
    assert.deepEqual(row.allowed_actions, reader ? ['read'] : ['read', 'update']);
    row.version = 2;
    const result = await f.controller.quickUpdate('CFK-1', { priority_key: 'high' });
    if (reader) assert.equal(result, undefined); else assert.equal(result.error.code, 'PANEL_VERSION_CONFLICT');
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
    f.controller.dispose(); f.bridge.dispose();
  }
});

test('memory checkpoints retain original write parameters, reject injected fields and recheck identity without clearing uncertainty', async () => {
  const f = fixture({ uncertain: true }); await f.controller.bootstrap();
  await f.controller.quickUpdate('CFK-1', { priority_key: 'high' });
  const checkpoint = f.controller.getCheckpoint();
  assert.ok(validateCheckpoint(checkpoint));
  assert.equal(checkpoint.state.pending.expected_version, 3);
  for (const altered of [{ ...checkpoint, token: 'secret' }, { ...checkpoint, state: { ...checkpoint.state, directory: '/arbitrary' } }, { ...checkpoint, state: { ...checkpoint.state, pending: { ...checkpoint.state.pending, idempotency_key: 'session-' + randomUUID() } } }]) assert.equal(validateCheckpoint(altered), null);
  const resumed = new WorkbenchController(f.controller.rpc, new AbortController().signal);
  f.deny();
  assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
  assert.deepEqual(resumed.state.pending, checkpoint.state.pending);
  assert.equal(resumed.state.error.code, 'CAPABILITY_DENIED');
  await resumed.mutate(null, null, true);
  assert.deepEqual(resumed.state.pending, checkpoint.state.pending);
  assert.equal(f.bridge.hasPending(), true);
  resumed.dispose(); f.controller.dispose(); f.bridge.dispose();
});

test('explicit initial target failure never switches to a directory recommendation or another identity', async () => {
  const f = fixture(); f.deny();
  await f.controller.bootstrap(null, { target: f.target, view: 'list' });
  assert.equal(f.scopeReads, 0);
  assert.equal(f.controller.state.binding, null);
  assert.equal(f.controller.state.error.code, 'CAPABILITY_DENIED');
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_connection_inspect').length, 1);
  assert.equal(isSessionReference(`session-${randomUUID()}`), true);
  f.controller.dispose(); f.bridge.dispose();
});

test('an explicit instance still auto applies its single directory recommendation', async () => {
  const f = fixture();
  const other = { ...f.target, instance_id: randomUUID() };
  f.bridge.directoryReader = async () => ({ status: 'configured', targets: [other, f.target] });
  await f.controller.bootstrap(null, { instance_id: f.ids.instance_id, view: 'list' });
  assert.ok(f.controller.state.binding);
  assert.equal(f.controller.state.binding.identity.instance.instance_id, f.ids.instance_id);
  assert.equal(f.controller.state.view, 'list');
  assert.deepEqual(f.controller.state.workspace_scope.targets, [f.target]);
  assert.ok(f.calls.every(row => row.args.instance_id === f.ids.instance_id));
  assert.equal(f.calls.some(row => row.name === 'cfkanban_workspaces_list'), false);
  const checkpoint = f.controller.getCheckpoint();
  assert.equal(checkpoint.state.scope_instance_id, f.ids.instance_id);
  const { projectSnapshot } = await adapterExports();
  assert.equal(Object.hasOwn(projectSnapshot(f.controller.state, null), 'scope_instance_id'), false);
  const before = f.calls.length;
  await f.controller.selectInstance(other.instance_id);
  await f.controller.bindScope(other);
  assert.equal(f.calls.length, before);
  assert.equal(f.controller.state.error.code, 'PANEL_SCOPE_DENIED');
  f.controller.dispose(); f.bridge.dispose();
});

test('an explicit instance pages only its recommended targets and never inspects other instances', async () => {
  const f = fixture();
  const matches = Array.from({ length: 9 }, (_, index) => index === 0 ? f.target : { ...f.target, project_id: randomUUID() });
  const other = { ...f.target, instance_id: randomUUID() };
  f.bridge.directoryReader = async () => ({ status: 'configured', targets: [other, ...matches.slice(0, 4), other, ...matches.slice(4)] });
  await f.controller.bootstrap(null, { instance_id: f.ids.instance_id });
  assert.equal(f.controller.state.binding, null);
  assert.equal(f.controller.state.scope_mode, 'suggested');
  assert.equal(f.controller.state.scope_targets.length, 8);
  assert.equal(f.controller.state.scope_next_offset, 8);
  assert.ok(f.controller.state.scope_targets.every(row => row.instance_id === f.ids.instance_id));
  await f.controller.loadScopeTargets(f.controller.state.scope_next_offset);
  assert.equal(f.controller.state.scope_targets.length, 1);
  assert.equal(f.controller.state.scope_next_offset, null);
  assert.ok(f.calls.every(row => row.args.instance_id === f.ids.instance_id));
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_projects_get').length, 9);
  assert.equal(f.calls.some(row => row.name === 'cfkanban_workspaces_list'), false);
  f.controller.dispose(); f.bridge.dispose();
});

test('refreshing project choices fails without discarding the current board or binding', async () => {
  const f = fixture(); await f.controller.bootstrap();
  const binding = f.controller.state.binding;
  const board = f.controller.state.board;
  const original = f.controller.rpc.call;
  f.controller.rpc.call = async (endpoint, ...args) => endpoint === 'scope_targets'
    ? { ok: true, value: { ok: false, error: { code: 'PANEL_SCOPE_HOST_UNAVAILABLE' } } }
    : original(endpoint, ...args);
  await f.controller.loadScopeTargets();
  assert.equal(f.controller.state.binding, binding);
  assert.equal(f.controller.state.board, board);
  assert.equal(f.controller.state.scope_mode, 'suggested');
  assert.equal(f.controller.state.error.code, 'PANEL_SCOPE_HOST_UNAVAILABLE');
  f.controller.dispose(); f.bridge.dispose();
});

test('a rejected project switch retains the original binding and board', async () => {
  const f = fixture(); await f.controller.bootstrap();
  const binding = f.controller.state.binding;
  const board = f.controller.state.board;
  const original = f.controller.rpc.call;
  f.controller.rpc.call = async (endpoint, ...args) => endpoint === 'bind_scope'
    ? { ok: true, value: { ok: false, error: { code: 'PANEL_SCOPE_DENIED' } } }
    : original(endpoint, ...args);
  await f.controller.bindScope({ ...f.target, project_id: randomUUID() });
  assert.equal(f.controller.state.binding, binding);
  assert.equal(f.controller.state.board, board);
  assert.equal(f.controller.state.scope_mode, 'suggested');
  assert.equal(f.controller.state.error.code, 'PANEL_SCOPE_DENIED');
  f.controller.dispose(); f.bridge.dispose();
});

test('missing matching recommendations keep manual selection in the explicit instance and invalid instances fail closed', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture();
    f.bridge.directoryReader = async () => ({ status: 'configured', targets: [{ ...f.target, instance_id: randomUUID() }] });
    if (unavailable) f.deny();
    await f.controller.bootstrap(null, { instance_id: f.ids.instance_id });
    assert.equal(f.controller.state.binding, null);
    assert.equal(f.controller.state.scope_mode, 'manual');
    assert.ok(f.calls.every(row => row.args.instance_id === f.ids.instance_id));
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_workspaces_list').length, unavailable ? 0 : 1);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_projects_get').length, 0);
    if (unavailable) assert.equal(f.controller.state.error.code, 'CAPABILITY_DENIED');
    f.controller.dispose(); f.bridge.dispose();
  }
});

test('board status filters query one matching column and clearing them restores all bounded columns', async () => {
  const f = fixture(); await f.controller.bootstrap();
  let before = f.calls.length;
  await f.controller.filter({ assignment: 'mine', status: 'todo', priority: 'high' });
  const filtered = f.calls.slice(before).filter(row => row.name === 'cfkanban_issues_list');
  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0].args.status, ['todo']);
  assert.deepEqual(filtered[0].args.priority, ['high']);
  assert.deepEqual(filtered[0].args.assignee, [f.ids.principal_id]);
  assert.deepEqual(f.controller.state.board.columns.map(row => row.key), ['todo']);
  await f.controller.boardPage('todo', true);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_list').at(-1).args.cursor, 'private-column-cursor');
  assert.deepEqual(f.controller.state.board.columns.map(row => row.key), ['todo']);
  before = f.calls.length;
  await f.controller.filter({ assignment: 'all', status: '', priority: '' });
  const cleared = f.calls.slice(before).filter(row => row.name === 'cfkanban_issues_list');
  assert.equal(cleared.length, 5);
  assert.deepEqual(cleared.map(row => row.args.status[0]), STATUSES);
  assert.deepEqual(f.controller.state.board.columns.map(row => row.key), STATUSES);
  assert.ok(cleared.every(row => row.args.limit === 25 && row.args.cursor === undefined));
  f.controller.dispose(); f.bridge.dispose();
});

test('uncertain quick edit receipts survive read eviction and replay without a new operation', async () => {
  const f = fixture({ uncertain: true }); await f.controller.bootstrap();
  const { WorkbenchAdapter } = await adapterExports();
  const adapter = new WorkbenchAdapter(f.controller, null, undefined, { receiptLimit: 2 });
  const request = action('quick_update', { identifier: 'CFK-1', change: { priority_key: 'high' } });
  const first = await adapter.receive(request);
  const pending = f.controller.state.pending;
  assert.equal(first.outcome_unknown, true);
  for (let index = 0; index < 4; index++) assert.equal((await adapter.receive(action('board_page', { status_key: 'todo', next: false }))).ok, true);
  assert.deepEqual(await adapter.receive(request), first);
  assert.equal(f.controller.state.pending, pending);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 1);
  assert.equal(adapter.receipts.has(request.id), true);
  adapter.dispose(); f.controller.dispose(); f.bridge.dispose();
});

test('Host checkpoint guard preserves the exact uncertain request instead of a valid older checkpoint', async () => {
  const f = fixture({ uncertain: true }); await f.controller.bootstrap();
  const idle = f.controller.getCheckpoint();
  assert.equal(f.bridge.acceptsCheckpoint(idle), true);
  await f.controller.quickUpdate('CFK-1', { priority_key: 'high' });
  const original = f.controller.getCheckpoint();
  assert.equal(f.bridge.acceptsCheckpoint(original), true);
  assert.equal(f.bridge.acceptsCheckpoint(idle), false);
  for (const change of [
    { idempotency_key: randomUUID() }, { identifier: 'CFK-2' }, { expected_version: 4 },
    { operation: 'comment', change: { body: 'Different operation' } }, { change: { priority_key: 'urgent' } },
  ]) {
    const older = { ...original, state: { ...original.state, pending: { ...original.state.pending, ...change } } };
    assert.ok(validateCheckpoint(older));
    assert.equal(f.bridge.acceptsCheckpoint(older), false);
  }
  const anotherBinding = randomUUID();
  const substituted = { ...original, state: { ...original.state, binding: { ...original.state.binding, binding_id: anotherBinding }, pending: { ...original.state.pending, binding_id: anotherBinding } } };
  assert.ok(validateCheckpoint(substituted));
  assert.equal(f.bridge.acceptsCheckpoint(substituted), false);
  const restored = new WorkbenchController(f.controller.rpc, new AbortController().signal);
  assert.equal(await restored.restoreCheckpoint(original), true);
  assert.deepEqual(restored.state.pending, original.state.pending);
  assert.equal((await restored.mutate(null, null, true)).ok, true);
  assert.equal(f.bridge.hasPending(), false);
  assert.equal(f.bridge.acceptsCheckpoint(restored.getCheckpoint()), true);
  assert.ok(f.calls.filter(row => row.name === 'cfkanban_issues_update').every(row => row.args.idempotency_key === original.state.pending.idempotency_key));
  restored.dispose(); f.controller.dispose(); f.bridge.dispose();
});

test('checkpoint guard retains Comment displayed version without adding Comment API CAS', async () => {
  const f = fixture(); await f.controller.bootstrap(); await f.controller.openIssue('CFK-1');
  const originalFacade = f.bridge.createFacade;
  f.bridge.createFacade = config => {
    const facade = originalFacade(config);
    return { callTool(name, args, options) {
      if (name === 'cfkanban_comments_create') { assert.equal(Object.hasOwn(args, 'expected_version'), false); return { ok: false, status: 0, outcome_unknown: true, error: { code: 'NETWORK_ERROR' } }; }
      return facade.callTool(name, args, options);
    } };
  };
  await f.controller.mutate('comment', { body: 'Reviewed append-only comment' });
  const original = f.controller.getCheckpoint();
  assert.equal(f.bridge.acceptsCheckpoint(original), true);
  const altered = { ...original, state: { ...original.state, pending: { ...original.state.pending, expected_version: 4 } } };
  assert.ok(validateCheckpoint(altered));
  assert.equal(f.bridge.acceptsCheckpoint(altered), false);
  assert.deepEqual(f.bridge.bindings.get(original.state.pending.binding_id).operations.get(original.state.pending.idempotency_key).original, original.state.pending);
  f.controller.dispose(); f.bridge.dispose();
});

test('checkpoint guard includes successful writes awaiting readback and refuses multiple pending operations', async () => {
  const f = fixture(); await f.controller.bootstrap();
  const originalFacade = f.bridge.createFacade;
  let committed = false;
  f.bridge.createFacade = config => {
    const facade = originalFacade(config);
    return { async callTool(name, args, options) {
      if (name === 'cfkanban_issues_get' && committed) return { ok: false, status: 503, error: { code: 'PLATFORM_UNAVAILABLE' } };
      const result = await facade.callTool(name, args, options);
      if (name === 'cfkanban_issues_update' && result.ok) committed = true;
      return result;
    } };
  };
  await f.controller.quickUpdate('CFK-1', { priority_key: 'high' });
  const successful = f.controller.getCheckpoint();
  assert.equal(f.bridge.hasPending(), true);
  assert.equal(f.bridge.acceptsCheckpoint(successful), true);
  assert.equal(f.bridge.acceptsCheckpoint({ ...successful, state: { ...successful.state, pending: null } }), false);
  committed = false;
  assert.equal((await f.controller.mutate(null, null, true)).ok, true);
  assert.equal(f.controller.state.pending, null);
  assert.equal(f.bridge.hasPending(), false);
  assert.equal(f.bridge.acceptsCheckpoint(f.controller.getCheckpoint()), true);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 1);
  f.controller.dispose(); f.bridge.dispose();

  const multiple = fixture({ uncertain: true }); await multiple.controller.bootstrap();
  await multiple.controller.quickUpdate('CFK-1', { priority_key: 'high' });
  const checkpoint = multiple.controller.getCheckpoint();
  const original = checkpoint.state.pending;
  const facadeFactory = multiple.bridge.createFacade;
  multiple.bridge.createFacade = config => {
    const facade = facadeFactory(config);
    return { callTool(name, args, options) { return name === 'cfkanban_issues_update' ? { ok: false, status: 0, outcome_unknown: true, error: { code: 'NETWORK_ERROR' } } : facade.callTool(name, args, options); } };
  };
  assert.equal((await multiple.call('mutate', { ...original, idempotency_key: randomUUID(), change: { priority_key: 'urgent' } })).outcome_unknown, true);
  assert.equal(multiple.bridge.acceptsCheckpoint(checkpoint), false);
  multiple.controller.dispose(); multiple.bridge.dispose();
});

test('column pagination appends unique newer summaries once per cursor and preserves other columns', async () => {
  let finish;
  const f = paginationController(async (_endpoint, input) => input.cursor ? await new Promise(resolve => { finish = resolve; }) : ok({ columns: [
    { key: 'todo', items: [paginationRow(1, 'todo', 3), paginationRow(2)], next_cursor: 'private-next' },
    { key: 'done', items: [paginationRow(9, 'done')], next_cursor: null },
  ] }));
  try {
    await f.controller.refresh();
    const done = f.controller.state.board.columns[1];
    const first = f.controller.boardPage('todo', true);
    const duplicate = f.controller.boardPage('todo', true);
    assert.equal(f.calls.length, 2);
    finish(ok({ columns: [{ key: 'todo', items: [paginationRow(1, 'todo', 2), paginationRow(2, 'todo', 5), paginationRow(3)], next_cursor: 'private-next' }] }));
    await Promise.all([first, duplicate]);
    const todo = f.controller.state.board.columns[0];
    assert.deepEqual(todo.items.map(row => [row.identifier, row.version]), [['CFK-1', 3], ['CFK-2', 5], ['CFK-3', 1]]);
    assert.equal(todo.items.some(row => Object.hasOwn(row, 'body')), false);
    assert.equal(f.controller.state.board.columns[1], done);
    await f.controller.boardPage('todo', true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.controller.state.error.code, 'PANEL_PAGINATION_STALLED');
  } finally { f.controller.dispose(); }
});

test('different column pages remain current concurrently and a failed page retains its cursor for retry', async () => {
  const finishes = new Map();
  let fail = true;
  const f = paginationController(async (_endpoint, input) => input.cursor ? input.status_key === 'todo' && fail ? (fail = false, { ok: false, error: { code: 'PLATFORM_UNAVAILABLE' } }) : await new Promise(resolve => { finishes.set(input.status_key, resolve); }) : ok({ columns: ['todo', 'done'].map((key, index) => ({ key, items: [paginationRow(index + 1, key)], next_cursor: `private-${key}` })) }));
  try {
    await f.controller.refresh();
    const original = f.controller.state.board.columns[0];
    assert.equal((await f.controller.boardPage('todo', true)).ok, false);
    assert.equal(f.controller.state.board.columns[0], original);
    const todo = f.controller.boardPage('todo', true);
    const done = f.controller.boardPage('done', true);
    finishes.get('done')(ok({ columns: [{ key: 'done', items: [paginationRow(4, 'done')], next_cursor: null }] }));
    await done;
    finishes.get('todo')(ok({ columns: [{ key: 'todo', items: [paginationRow(3)], next_cursor: null }] }));
    await todo;
    assert.deepEqual(f.controller.state.board.columns.map(column => column.items.map(row => row.identifier)), [['CFK-1', 'CFK-3'], ['CFK-2', 'CFK-4']]);
    assert.equal(f.calls.filter(call => call.input.cursor === 'private-todo').length, 2);
  } finally { f.controller.dispose(); }
});

test('collection epochs discard pages and errors after binding, filter, view or refresh changes', async () => {
  for (const change of ['binding', 'filter', 'view', 'refresh']) {
    let finish;
    let generation = 1;
    const f = paginationController(async (endpoint, input) => {
      if (input.cursor) return await new Promise(resolve => { finish = resolve; });
      if (endpoint === 'list') return ok({ items: [paginationRow(90)], next_cursor: null });
      return ok({ columns: [{ key: input.status_key ?? 'todo', items: [paginationRow(generation, input.status_key ?? 'todo')], next_cursor: 'private-old' }] });
    });
    try {
      await f.controller.refresh();
      const old = f.controller.boardPage('todo', true);
      generation = 10;
      if (change === 'binding') { f.controller.patch({ binding: { ...f.binding, binding_id: randomUUID() }, page: null, board: null }); await f.controller.refresh(); }
      if (change === 'filter') await f.controller.filter({ assignment: 'all', status: 'done', priority: '' });
      if (change === 'view') await f.controller.setView('list');
      if (change === 'refresh') await f.controller.refresh();
      const state = { board: f.controller.state.board, page: f.controller.state.page };
      finish(change === 'filter' ? { ok: false, error: { code: 'PLATFORM_UNAVAILABLE' } } : ok({ columns: [{ key: 'todo', items: [paginationRow(99)], next_cursor: null }] }));
      await old;
      assert.equal(f.controller.state.board, state.board, change);
      assert.equal(f.controller.state.page, state.page, change);
      assert.equal(f.controller.state.error, null, change);
    } finally { f.controller.dispose(); }
  }
});

test('list pages append and retain successful summaries through a failed next read', async () => {
  let fail = true;
  const f = paginationController(async (_endpoint, input) => !input.cursor ? ok({ items: [paginationRow(1, 'todo', 4)], next_cursor: 'private-list' }) : fail ? (fail = false, { ok: false, error: { code: 'PLATFORM_UNAVAILABLE' } }) : ok({ items: [paginationRow(1, 'todo', 3), paginationRow(2)], next_cursor: null }), 'list');
  try {
    await f.controller.refresh();
    const original = f.controller.state.page;
    await f.controller.refresh('private-list');
    assert.equal(f.controller.state.page, original);
    await f.controller.refresh('private-list');
    assert.deepEqual(f.controller.state.page.items.map(row => [row.identifier, row.version]), [['CFK-1', 4], ['CFK-2', 1]]);
    assert.equal(f.controller.state.page.next_cursor, null);
    assert.equal(f.controller.state.page.items.some(row => Object.hasOwn(row, 'body')), false);
  } finally { f.controller.dispose(); }
});

test('row and successful-page limits explicitly stop continuation without pretending the remote cursor ended', async () => {
  for (const view of ['list', 'board']) {
    let page = 0;
    const f = paginationController(async () => {
      const rows = Array.from({ length: 25 }, (_value, index) => paginationRow(++page * 100 + index));
      const data = { items: rows, next_cursor: `private-${page}` };
      return ok(view === 'list' ? data : { columns: [{ key: 'todo', ...data }] });
    }, view);
    try {
      await f.controller.refresh();
      for (let index = 1; index < ISSUE_COLLECTION_LIMIT / 25; index++) {
        if (view === 'list') await f.controller.refresh(f.controller.state.page.next_cursor);
        else await f.controller.boardPage('todo', true);
      }
      const collection = view === 'list' ? f.controller.state.page : f.controller.state.board.columns[0];
      assert.equal(collection.items.length, ISSUE_COLLECTION_LIMIT);
      assert.equal(collection.capacity_reached, true);
      assert.ok(collection.next_cursor);
      const before = f.calls.length;
      if (view === 'list') await f.controller.refresh(collection.next_cursor); else await f.controller.boardPage('todo', true);
      assert.equal(f.calls.length, before);
    } finally { f.controller.dispose(); }
  }
  let page = 0;
  const repeated = paginationController(async () => ok({ items: [paginationRow(1, 'todo', ++page)], next_cursor: `private-${page}` }), 'list');
  try {
    await repeated.controller.refresh();
    for (let index = 1; index < ISSUE_COLLECTION_LIMIT / 25; index++) await repeated.controller.refresh(repeated.controller.state.page.next_cursor);
    assert.equal(repeated.controller.state.page.items.length, 1);
    assert.equal(repeated.controller.state.page.capacity_reached, true);
    await repeated.controller.refresh(repeated.controller.state.page.next_cursor);
    assert.equal(repeated.calls.length, ISSUE_COLLECTION_LIMIT / 25);
  } finally { repeated.controller.dispose(); }
});

test('full projected snapshot budget rejects an append while preserving original rows and its private cursor', async () => {
  const f = paginationController(async (_endpoint, input) => ok({ columns: [{ key: 'todo', items: Array.from({ length: 25 }, (_value, index) => ({ ...paginationRow((input.cursor ? 50 : 1) + index), title: input.cursor ? 'x'.repeat(8192) : `Issue ${index}` })), next_cursor: input.cursor ? 'private-after' : 'private-original' }] }));
  const { WorkbenchAdapter } = await adapterExports();
  const adapter = new WorkbenchAdapter(f.controller);
  const messages = [];
  adapter.attach({ start() {}, close() {}, postMessage(message) { messages.push(message); } });
  try {
    await f.controller.refresh();
    f.controller.patch({ comments: Array.from({ length: 8 }, () => ({ id: randomUUID(), body: 'x'.repeat(240000) })) });
    assert.equal(messages.at(-1).state.error, null);
    const original = f.controller.state.board.columns[0];
    const result = await f.controller.boardPage('todo', true);
    assert.equal(result.error.code, 'PANEL_CAPACITY');
    const column = f.controller.state.board.columns[0];
    assert.deepEqual(column.items, original.items);
    assert.equal(column.next_cursor, 'private-original');
    assert.equal(column.capacity_reached, true);
    assert.equal(messages.at(-1).state.board.columns[0].items.length, 25);
    assert.equal(messages.at(-1).state.board.columns[0].has_more, true);
    assert.equal(messages.at(-1).state.board.columns[0].capacity_reached, true);
    assert.equal(messages.at(-1).state.error, null);
    assert.doesNotMatch(JSON.stringify(messages.at(-1)), /private-original|Never retain a collection body/);
  } finally { adapter.dispose(); f.controller.dispose(); }
});

test('pagehide during permission pre-read retains a not-sent operation and restores the exact checkpoint', async () => {
  const f = fixture(); await f.controller.bootstrap();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let pause = true;
  interceptFacade(f, async (facade, name, args, options) => {
    if (name === 'cfkanban_issues_get' && pause) {
      pause = false; entered();
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return facade.callTool(name, args, options);
  });
  const rpc = f.controller.rpc.call;
  let hostReply;
  f.controller.rpc.call = (...args) => {
    const request = rpc(...args);
    if (args[0] === 'mutate') hostReply = request;
    return request;
  };
  let resumed;
  try {
    assert.equal(f.bridge.timeoutMs, 30_000);
    const writing = f.controller.quickUpdate('CFK-1', { priority_key: 'high' });
    await started;
    const checkpoint = f.controller.getCheckpoint();
    const original = checkpoint.state.pending;
    const ledger = f.bridge.bindings.get(original.binding_id).operations.get(original.idempotency_key);
    assert.equal(ledger.stage, 'not_sent');
    assert.deepEqual(ledger.original, original);
    assert.equal(f.bridge.hasPending(), true);
    assert.equal(f.bridge.acceptsCheckpoint(checkpoint), true);
    assert.equal((await f.call('mutate', original)).error.code, 'PANEL_OPERATION_PENDING');
    f.controller.dispose();
    await writing;
    const cancelled = (await hostReply).value;
    assert.equal(cancelled.panel.write_stage, 'not_sent');
    assert.equal(cancelled.panel.original_settled, false);
    assert.equal(cancelled.panel.recovery_required, true);
    assert.equal(cancelled.outcome_unknown, undefined);
    assert.equal(ledger.running, false);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
    resumed = new WorkbenchController(f.controller.rpc, new AbortController().signal);
    assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
    assert.deepEqual(resumed.state.pending, original);
    assert.equal((await resumed.mutate(null, null, true)).ok, true);
    const writes = f.calls.filter(row => row.name === 'cfkanban_issues_update');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args.idempotency_key, original.idempotency_key);
    assert.equal(writes[0].args.expected_version, original.expected_version);
    assert.deepEqual(writes[0].args.changes, original.change);
    assert.equal(resumed.state.pending, null);
    assert.equal(resumed.canChangeBinding(), true);
    assert.equal(f.bridge.hasPending(), false);
    assert.equal((await f.call('unbind', { binding_id: original.binding_id })).ok, true);
  } finally { resumed?.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('a late permission read after cancellation cannot send a write and still recovers the original key', async () => {
  const f = fixture(); await f.controller.bootstrap();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  let pause = true;
  interceptFacade(f, async (facade, name, args, options) => {
    if (name === 'cfkanban_issues_get' && pause) {
      pause = false; entered();
      await new Promise(resolve => { release = resolve; });
    }
    return facade.callTool(name, args, options);
  });
  const input = { binding_id: f.controller.state.binding.binding_id, identifier: 'CFK-1', operation: 'update', expected_version: 3, idempotency_key: randomUUID(), change: { priority_key: 'high' } };
  try {
    const abort = new AbortController();
    const writing = f.bridge.call('mutate', { protocol: 1, input }, abort.signal, f.bridge.host.operator);
    await started; abort.abort(); release();
    const result = await writing;
    assert.equal(result.panel.write_stage, 'not_sent');
    assert.equal(result.panel.recovery_required, true);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
    assert.equal((await f.call('recover', input)).ok, true);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 1);
    assert.equal(f.bridge.hasPending(), false);
  } finally { release?.(); f.controller.dispose(); f.bridge.dispose(); }
});

test('transient permission pre-read failures keep the not-sent request for explicit same-key recovery', async () => {
  for (const failure of [{ ok: false, status: 503, error: { code: 'PLATFORM_UNAVAILABLE' } }, new Error('Untrusted path and secret must not be returned')]) {
    const f = fixture(); await f.controller.bootstrap();
    let first = true;
    interceptFacade(f, async (facade, name, args, options) => {
      if (name === 'cfkanban_issues_get' && first) {
        first = false;
        if (failure instanceof Error) throw failure;
        return failure;
      }
      return facade.callTool(name, args, options);
    });
    try {
      const result = await f.controller.quickUpdate('CFK-1', { priority_key: 'high' });
      const original = structuredClone(f.controller.state.pending);
      assert.equal(result.ok, false);
      assert.equal(result.panel.write_stage, 'not_sent');
      assert.equal(result.panel.original_settled, false);
      assert.equal(result.panel.recovery_required, true);
      assert.doesNotMatch(JSON.stringify(result), /Untrusted path|secret must/);
      assert.equal(f.bridge.hasPending(), true);
      assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
      assert.equal((await f.call('recover', { ...original, expected_version: 4 })).error.code, 'PANEL_KEY_REUSED');
      assert.equal((await f.controller.mutate(null, null, true)).ok, true);
      const writes = f.calls.filter(row => row.name === 'cfkanban_issues_update');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].args.idempotency_key, original.idempotency_key);
      assert.equal(f.controller.state.pending, null);
      assert.equal(f.bridge.hasPending(), false);
    } finally { f.controller.dispose(); f.bridge.dispose(); }
  }
});

test('definite pre-read permission and CAS failures replay a settled not-sent receipt without issuing a write', async () => {
  for (const code of ['PANEL_PERMISSION_DENIED', 'PANEL_VERSION_CONFLICT', 'CAPABILITY_DENIED']) {
    const f = fixture(); await f.controller.bootstrap();
    let first = true;
    interceptFacade(f, async (facade, name, args, options) => {
      if (name === 'cfkanban_issues_get' && first) {
        first = false;
        if (code === 'CAPABILITY_DENIED') return { ok: false, status: 403, error: { code } };
        return ok({ ...f.issue, ...(code === 'PANEL_PERMISSION_DENIED' ? { allowed_actions: ['read'] } : { version: 4 }) });
      }
      return facade.callTool(name, args, options);
    });
    let resumed;
    try {
      const result = await f.controller.quickUpdate('CFK-1', { priority_key: 'high' });
      assert.equal(result.error.code, code);
      assert.equal(result.panel.write_stage, 'not_sent');
      assert.equal(result.panel.original_settled, true);
      assert.equal(result.panel.recovery_required, false);
      assert.equal(f.controller.state.pending, null);
      assert.equal(f.bridge.hasPending(), false);
      const original = [...f.bridge.bindings.values()][0].operations.values().next().value.original;
      const checkpoint = f.controller.getCheckpoint();
      checkpoint.state.pending = original;
      resumed = new WorkbenchController(f.controller.rpc, new AbortController().signal);
      assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
      if (code === 'CAPABILITY_DENIED') f.deny();
      const replay = await resumed.mutate(null, null, true);
      assert.equal(replay.error.code, code);
      assert.equal(replay.panel.original_settled, true);
      assert.equal(replay.panel.write_stage, 'not_sent');
      assert.equal(resumed.state.pending, null);
      assert.equal(resumed.canChangeBinding(), true);
      assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
      f.deny();
      const revoked = await f.call('recover', original);
      assert.equal(revoked.error.code, 'CAPABILITY_DENIED');
      assert.equal(revoked.panel.original_settled, true);
      assert.equal(revoked.panel.readback, null);
      assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
    } finally { resumed?.dispose(); f.controller.dispose(); f.bridge.dispose(); }
  }
});

test('cancellation after send keeps uncertainty and permission loss cannot resend or settle the original comment', async () => {
  const f = fixture(); await f.controller.bootstrap(); await f.controller.openIssue('CFK-1');
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const writes = [];
  let denied = false;
  interceptFacade(f, async (facade, name, args, options) => {
    if (name === 'cfkanban_issues_get' && denied) return { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED' } };
    if (name === 'cfkanban_comments_create') {
      writes.push(structuredClone(args));
      if (writes.length === 1) {
        entered();
        await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      return ok({ resource: { id: randomUUID() } });
    }
    return facade.callTool(name, args, options);
  });
  const rpc = f.controller.rpc.call;
  let hostReply;
  f.controller.rpc.call = (...args) => {
    const request = rpc(...args);
    if (args[0] === 'mutate') hostReply = request;
    return request;
  };
  let resumed;
  try {
    const writing = f.controller.mutate('comment', { body: 'Original append-only comment' });
    await started;
    const checkpoint = f.controller.getCheckpoint();
    f.controller.dispose();
    await writing;
    assert.equal((await hostReply).value.outcome_unknown, true);
    const original = checkpoint.state.pending;
    assert.equal(f.bridge.bindings.get(original.binding_id).operations.get(original.idempotency_key).stage, 'sent');
    assert.equal(f.bridge.hasPending(), true);
    resumed = new WorkbenchController(f.controller.rpc, new AbortController().signal);
    await resumed.restoreCheckpoint(checkpoint);
    assert.equal((await f.call('recover', { ...original, expected_version: 4 })).error.code, 'PANEL_KEY_REUSED');
    denied = true;
    const refused = await resumed.mutate(null, null, true);
    assert.equal(refused.error.code, 'CAPABILITY_DENIED');
    assert.equal(refused.panel?.original_settled, undefined);
    assert.deepEqual(resumed.state.pending, original);
    assert.equal(writes.length, 1);
    denied = false;
    assert.equal((await resumed.mutate(null, null, true)).ok, true);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0]);
    assert.equal(Object.hasOwn(writes[0], 'expected_version'), false);
    assert.equal(writes[0].idempotency_key, original.idempotency_key);
    assert.equal(resumed.state.pending, null);
    assert.equal(f.bridge.hasPending(), false);
  } finally { resumed?.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('workbench projects only the verified Principal locale and theme, and refresh picks up full Web preferences', async () => {
  const { WorkbenchAdapter } = await adapterExports();
  const f = fixture({ locale: 'zh-CN', theme: 'blue' }); await f.controller.bootstrap();
  const adapter = new WorkbenchAdapter(f.controller);
  try {
    adapter.setLocale('en');
    const snapshot = adapter.snapshotMessage().state;
    assert.equal(snapshot.locale, 'zh-CN'); assert.equal(snapshot.theme, 'blue');
    assert.equal(Object.hasOwn(snapshot.binding.identity.principal, 'locale'), false);
    assert.equal(Object.hasOwn(snapshot.binding.identity.principal, 'theme'), false);
    assert.equal(Object.hasOwn(snapshot.binding.identity.principal, 'version'), false);
    f.principal.locale = 'en'; f.principal.theme = 'orange';
    await f.controller.refresh();
    assert.equal(adapter.snapshotMessage().state.locale, 'en');
    assert.equal(adapter.snapshotMessage().state.theme, 'orange');
    f.principal.locale = null;
    await f.controller.refresh(); adapter.setLocale('zh-CN');
    assert.equal(adapter.snapshotMessage().state.locale, 'zh-CN');
    const checkpoint = f.controller.getCheckpoint();
    assert.equal(Object.hasOwn(checkpoint.state.binding.identity.principal, 'locale'), false);
    assert.equal(Object.hasOwn(checkpoint.state.binding.identity.principal, 'theme'), false);
    assert.equal(Object.hasOwn(checkpoint.state.binding.identity.principal, 'version'), false);
  } finally { adapter.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('readers can save only their own language preference with profile CAS and cannot change Issue labels', async () => {
  const f = fixture({ reader: true, theme: 'blue' }); await f.controller.bootstrap(); await f.controller.openIssue('CFK-1');
  const { WorkbenchAdapter } = await adapterExports(); const adapter = new WorkbenchAdapter(f.controller);
  try {
    assert.equal((await adapter.receive(action('set_locale', { locale: 'zh-CN' }))).ok, true);
    assert.equal(f.principal.locale, 'zh-CN'); assert.equal(f.principal.theme, 'blue');
    const writes = f.calls.filter(row => row.name === 'cfkanban_profile_locale_set');
    assert.equal(writes.length, 1); assert.equal(writes[0].args.expected_version, 1);
    assert.deepEqual(Object.keys(writes[0].args).sort(), ['expected_version', 'idempotency_key', 'instance_id', 'locale']);
    assert.equal(writes[0].config.binding.expected_principal_id, f.ids.principal_id);
    assert.equal(adapter.snapshotMessage().state.locale, 'zh-CN');
    assert.equal((await adapter.receive(action('set_locale', { locale: 'zh-CN' }))).ok, true);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_profile_locale_set').length, 1);
    await adapter.receive(action('labels', { next: false }));
    assert.equal((await adapter.receive(action('mutate', { operation: 'label_add', change: { label_id: f.label.id } }))).error.code, 'PANEL_INVALID_INPUT');
    const refusedLabel = await f.call('mutate', { binding_id: f.controller.state.binding.binding_id, identifier: 'CFK-1', operation: 'label_add', expected_version: f.issue.version, idempotency_key: randomUUID(), change: { label_id: f.label.id } });
    assert.equal(refusedLabel.error.code, 'PANEL_PERMISSION_DENIED');
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_labels_add').length, 0);
    const original = { binding_id: f.controller.state.binding.binding_id, operation: 'set_locale', expected_version: f.principal.version, idempotency_key: randomUUID(), change: { locale: 'en' } };
    const before = f.calls.length;
    for (const altered of [{ ...original, identifier: 'CFK-1' }, { ...original, principal_id: randomUUID() }, { ...original, change: { locale: 'en', theme: 'orange' } }, { ...original, change: { locale: 'fr' } }]) assert.equal((await f.call('mutate', altered)).error.code, 'PANEL_INVALID_INPUT');
    assert.equal(f.calls.length, before);
    f.principal.version++;
    const stale = await f.call('mutate', original);
    assert.equal(stale.error.code, 'PANEL_VERSION_CONFLICT'); assert.equal(stale.panel.write_stage, 'not_sent');
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_profile_locale_set').length, 1);
  } finally { adapter.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('unknown language saves retain the exact profile request across refresh and permission loss before same-key recovery', async () => {
  const f = fixture({ uncertainPreference: true }); await f.controller.bootstrap();
  let denied = false;
  interceptFacade(f, async (facade, name, args, options) => denied && name === 'cfkanban_connection_inspect' ? { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED' } } : facade.callTool(name, args, options));
  let resumed;
  try {
    assert.equal((await f.controller.setLocale('zh-CN')).outcome_unknown, true);
    const checkpoint = f.controller.getCheckpoint(); const original = structuredClone(checkpoint.state.pending);
    assert.equal(original.operation, 'set_locale'); assert.equal(Object.hasOwn(original, 'identifier'), false);
    assert.equal(original.expected_version, 1); assert.equal(f.principal.version, 2); assert.equal(f.principal.locale, 'zh-CN');
    assert.equal(f.bridge.acceptsCheckpoint(checkpoint), true);
    const altered = structuredClone(checkpoint); altered.state.pending.change.theme = 'blue';
    assert.equal(validateCheckpoint(altered), null);
    altered.state.pending = { ...original, identifier: 'CFK-1' };
    assert.equal(validateCheckpoint(altered), null);
    assert.equal((await f.call('unbind', { binding_id: original.binding_id })).error.code, 'PANEL_OPERATION_PENDING');
    assert.equal((await f.call('recover', { ...original, change: { locale: 'en' } })).error.code, 'PANEL_KEY_REUSED');
    resumed = new WorkbenchController(f.controller.rpc, new AbortController().signal);
    assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
    assert.deepEqual(resumed.state.pending, original);
    denied = true;
    assert.equal((await resumed.mutate(null, null, true)).error.code, 'CAPABILITY_DENIED');
    assert.deepEqual(resumed.state.pending, original);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_profile_locale_set').length, 1);
    denied = false;
    assert.equal((await resumed.mutate(null, null, true)).ok, true);
    const writes = f.calls.filter(row => row.name === 'cfkanban_profile_locale_set');
    assert.equal(writes.length, 2); assert.deepEqual(writes[1].args, writes[0].args);
    assert.equal(f.principal.version, 2); assert.equal(resumed.state.pending, null); assert.equal(f.bridge.hasPending(), false);
    assert.equal(resumed.state.binding.identity.principal.locale, 'zh-CN');
  } finally { resumed?.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('cancelled language pre-read is checkpointed before await and resumes without creating another key', async () => {
  const f = fixture(); await f.controller.bootstrap();
  let entered;
  const started = new Promise(resolve => { entered = resolve; }); let pause = true;
  interceptFacade(f, async (facade, name, args, options) => {
    if (name === 'cfkanban_connection_inspect' && pause) { pause = false; entered(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); }
    return facade.callTool(name, args, options);
  });
  let resumed;
  try {
    const writing = f.controller.setLocale('zh-CN'); await started;
    const checkpoint = f.controller.getCheckpoint(); const original = checkpoint.state.pending;
    const ledger = f.bridge.bindings.get(original.binding_id).operations.get(original.idempotency_key);
    assert.equal(ledger.stage, 'not_sent'); assert.equal(f.bridge.acceptsCheckpoint(checkpoint), true);
    f.controller.dispose(); await writing;
    assert.equal(ledger.running, false); assert.equal(f.calls.filter(row => row.name === 'cfkanban_profile_locale_set').length, 0);
    resumed = new WorkbenchController(f.controller.rpc, new AbortController().signal);
    assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
    assert.equal((await resumed.mutate(null, null, true)).ok, true);
    const writes = f.calls.filter(row => row.name === 'cfkanban_profile_locale_set');
    assert.equal(writes.length, 1); assert.equal(writes[0].args.idempotency_key, original.idempotency_key);
    assert.equal(writes[0].args.expected_version, original.expected_version); assert.equal(f.bridge.hasPending(), false);
  } finally { resumed?.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('Issue label add/remove uses only loaded project candidates, real permissions, CAS and private pagination', async () => {
  const f = fixture(); await f.controller.bootstrap(); await f.controller.openIssue('CFK-1');
  const { WorkbenchAdapter } = await adapterExports(); const adapter = new WorkbenchAdapter(f.controller);
  try {
    assert.equal((await adapter.receive(action('mutate', { operation: 'label_add', change: { label_id: f.label.id } }))).error.code, 'PANEL_INVALID_INPUT');
    await adapter.receive(action('labels', { next: false })); await adapter.receive(action('labels', { next: true }));
    const reads = f.calls.filter(row => row.name === 'cfkanban_labels_list');
    assert.equal(reads.length, 2); assert.ok(reads.every(row => row.args.limit === 20 && row.args.project_id === f.ids.project_id && row.args.workspace_id === f.ids.workspace_id));
    assert.equal(reads[1].args.cursor, 'private-label-cursor');
    assert.doesNotMatch(JSON.stringify(adapter.snapshotMessage()), /private-label-cursor/);
    assert.deepEqual(adapter.snapshotMessage().state.labels, [f.label, f.nextLabel]);
    assert.equal((await adapter.receive(action('mutate', { operation: 'label_add', change: { label_id: randomUUID() } }))).error.code, 'PANEL_INVALID_INPUT');
    assert.equal((await adapter.receive(action('mutate', { operation: 'label_add', change: { label_id: f.label.id } }))).ok, true);
    assert.deepEqual(adapter.snapshotMessage().state.issue.labels, [f.label]);
    assert.equal((await adapter.receive(action('mutate', { operation: 'label_add', change: { label_id: f.label.id } }))).error.code, 'PANEL_INVALID_INPUT');
    assert.equal((await adapter.receive(action('mutate', { operation: 'label_remove', change: { label_id: f.nextLabel.id } }))).error.code, 'PANEL_INVALID_INPUT');
    assert.equal((await adapter.receive(action('mutate', { operation: 'label_remove', change: { label_id: f.label.id } }))).ok, true);
    assert.deepEqual(adapter.snapshotMessage().state.issue.labels, []);
    const writes = f.calls.filter(row => ['cfkanban_issues_labels_add', 'cfkanban_issues_labels_remove'].includes(row.name));
    assert.deepEqual(writes.map(row => row.args.expected_version), [3, 4]);
    assert.ok(writes.every(row => row.config.binding.project_ids[0] === f.ids.project_id));
    const input = { binding_id: f.controller.state.binding.binding_id, identifier: 'CFK-1', operation: 'label_add', expected_version: 3, idempotency_key: randomUUID(), change: { label_id: f.label.id } };
    assert.equal((await f.call('mutate', input)).error.code, 'PANEL_VERSION_CONFLICT');
    assert.equal((await f.call('mutate', { ...input, change: { label_id: f.label.id, name: 'Create another label' } })).error.code, 'PANEL_INVALID_INPUT');
    assert.equal(f.calls.filter(row => ['cfkanban_issues_labels_add', 'cfkanban_issues_labels_remove'].includes(row.name)).length, 2);
  } finally { adapter.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('unknown label outcomes keep their Issue CAS and original key across a checkpoint and identical replay', async () => {
  for (const operation of ['label_add', 'label_remove']) {
    const f = fixture({ uncertainLabel: true }); await f.controller.bootstrap(); await f.controller.openIssue('CFK-1'); await f.controller.loadLabels();
    if (operation === 'label_remove') f.issue.labels = [f.label];
    let resumed;
    try {
      assert.equal((await f.controller.mutate(operation, { label_id: f.label.id })).outcome_unknown, true);
      const checkpoint = f.controller.getCheckpoint(); const original = checkpoint.state.pending;
      assert.equal(original.operation, operation); assert.equal(original.expected_version, 3); assert.equal(f.issue.version, 4);
      assert.equal(f.bridge.acceptsCheckpoint(checkpoint), true);
      const altered = structuredClone(checkpoint); altered.state.pending.change.label_id = randomUUID();
      assert.ok(validateCheckpoint(altered)); assert.equal(f.bridge.acceptsCheckpoint(altered), false);
      resumed = new WorkbenchController(f.controller.rpc, new AbortController().signal);
      assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
      assert.deepEqual(resumed.state.pending, original);
      assert.equal((await resumed.mutate(null, null, true)).ok, true);
      const writes = f.calls.filter(row => row.name === (operation === 'label_add' ? 'cfkanban_issues_labels_add' : 'cfkanban_issues_labels_remove'));
      assert.equal(writes.length, 2); assert.deepEqual(writes[1].args, writes[0].args);
      assert.equal(f.issue.version, 4); assert.deepEqual(resumed.state.issue.labels, operation === 'label_add' ? [f.label] : []); assert.equal(resumed.state.pending, null);
    } finally { resumed?.dispose(); f.controller.dispose(); f.bridge.dispose(); }
  }
});

test('a current collection response with an older Principal version cannot replace confirmed preferences', async () => {
  const f = fixture({ locale: 'en' }); await f.controller.bootstrap();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }); let pause = true;
  interceptFacade(f, async (facade, name, args, options) => {
    const result = await facade.callTool(name, args, options);
    if (name === 'cfkanban_connection_inspect' && pause) { pause = false; entered(); await new Promise(resolve => { release = () => resolve(); }); }
    return result;
  });
  try {
    const refreshing = f.controller.refresh(); await started;
    const confirmed = { ...f.controller.state.binding.identity, principal: { ...f.principal, version: 2, locale: 'zh-CN', theme: 'blue' } };
    f.controller.patch(f.controller.identityUpdate(confirmed));
    release(); await refreshing;
    assert.equal(f.controller.state.binding.identity.principal.version, 2);
    assert.equal(f.controller.state.binding.identity.principal.locale, 'zh-CN');
    assert.equal(f.controller.state.binding.identity.principal.theme, 'blue');
    const { locale, theme, ...oldService } = confirmed.principal;
    f.controller.patch(f.controller.identityUpdate({ ...confirmed, principal: { ...oldService, version: 3 } }));
    assert.equal(f.controller.state.binding.identity.principal.locale, 'zh-CN');
    assert.equal(f.controller.state.binding.identity.principal.theme, 'blue');
    assert.deepEqual(f.controller.identityUpdate({ ...confirmed, principal: { ...oldService, principal_id: randomUUID(), id: randomUUID(), version: 100 } }), {});
  } finally { release?.(); f.controller.dispose(); f.bridge.dispose(); }
});

test('a late locale readback cannot publish older preferences after a newer full Web profile was observed', async () => {
  const f = fixture({ locale: 'en' }); await f.controller.bootstrap();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }); let committed = false; let paused = false;
  interceptFacade(f, async (facade, name, args, options) => {
    const result = await facade.callTool(name, args, options);
    if (name === 'cfkanban_profile_locale_set') committed = true;
    if (name === 'cfkanban_connection_inspect' && committed && !paused) { paused = true; entered(); await new Promise(resolve => { release = () => resolve(); }); }
    return result;
  });
  const observed = [];
  const unsubscribe = f.controller.subscribe(() => observed.push(structuredClone(f.controller.state.binding.identity.principal)));
  try {
    const saving = f.controller.setLocale('zh-CN'); await started;
    f.principal.version = 3; f.principal.locale = 'en'; f.principal.theme = 'blue';
    await f.controller.refresh(); observed.length = 0;
    release(); await saving;
    assert.ok(observed.every(principal => principal.version >= 3 && principal.locale === 'en' && principal.theme === 'blue'));
    assert.equal(f.controller.state.pending, null);
  } finally { release?.(); unsubscribe(); f.controller.dispose(); f.bridge.dispose(); }
});

test('label pages are singleflight and a first-page refresh invalidates old continuations and their errors', async () => {
  const f = fixture(); await f.controller.bootstrap();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }); let pause = true; let initialPaused = false;
  interceptFacade(f, async (facade, name, args, options) => {
    const result = await facade.callTool(name, args, options);
    if (name === 'cfkanban_labels_list' && pause) { pause = false; entered(); await new Promise(resolve => { release = () => resolve(); }); }
    return result;
  });
  try {
    const first = f.controller.loadLabels(); await started;
    const duplicate = f.controller.loadLabels();
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_labels_list').length, 1);
    release(); await Promise.all([first, duplicate]);
    let finish;
    interceptFacade(f, async (facade, name, args, options) => {
      if (name === 'cfkanban_labels_list' && args.cursor) return new Promise(resolve => { finish = resolve; });
      if (name === 'cfkanban_labels_list' && initialPaused) return new Promise(resolve => { release = () => resolve(ok({ items: [f.label], next_cursor: 'new-label-cursor' })); });
      return facade.callTool(name, args, options);
    });
    const next = f.controller.loadLabels(true); const sameNext = f.controller.loadLabels(true);
    const pending = f.controller.state.busy;
    assert.equal(pending, 1);
    initialPaused = true;
    const fresh = f.controller.loadLabels(); const nextDuringFresh = f.controller.loadLabels(true);
    assert.equal(f.controller.state.busy, 2);
    release(); await Promise.all([fresh, nextDuringFresh]);
    assert.equal(f.controller.state.label_cursor, 'new-label-cursor');
    finish({ ok: false, status: 503, error: { code: 'PLATFORM_UNAVAILABLE' } }); await Promise.all([next, sameNext]);
    assert.deepEqual(f.controller.state.labels, [f.label]);
    assert.equal(f.controller.state.label_cursor, 'new-label-cursor'); assert.equal(f.controller.state.error, null);
  } finally { release?.(); f.controller.dispose(); f.bridge.dispose(); }
});

test('Issue detail refresh reads current profile preferences and the next locale save uses that Principal version', async () => {
  const f = fixture({ locale: 'en' }); await f.controller.bootstrap(); await f.controller.openIssue('CFK-1');
  const { WorkbenchAdapter } = await adapterExports(); const adapter = new WorkbenchAdapter(f.controller);
  try {
    f.principal.theme = 'blue'; f.principal.locale = 'zh-CN'; f.principal.version = 5;
    const before = f.calls.length;
    await f.controller.openIssue('CFK-1');
    assert.deepEqual(f.calls.slice(before).map(row => row.name), ['cfkanban_connection_inspect', 'cfkanban_issues_get']);
    assert.equal(adapter.snapshotMessage().state.theme, 'blue'); assert.equal(adapter.snapshotMessage().state.locale, 'zh-CN');
    assert.equal(Object.hasOwn(f.controller.state.issue, 'identity'), false);
    assert.equal((await f.controller.setLocale('en')).ok, true);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_profile_locale_set').at(-1).args.expected_version, 5);
    assert.equal(f.principal.theme, 'blue'); assert.equal(f.principal.version, 6);
  } finally { adapter.dispose(); f.controller.dispose(); f.bridge.dispose(); }
});

test('older Service locale validation refusals are definite failures without retaining an uncertain profile write', async () => {
  for (const code of ['VALIDATION_ERROR', 'INPUT_VALIDATION_FAILED']) {
    const f = fixture(); await f.controller.bootstrap();
    interceptFacade(f, (facade, name, args, options) => name === 'cfkanban_profile_locale_set' ? { ok: false, status: 400, error: { code } } : facade.callTool(name, args, options));
    const { WorkbenchAdapter } = await adapterExports(); const adapter = new WorkbenchAdapter(f.controller);
    try {
      const result = await adapter.receive(action('set_locale', { locale: 'zh-CN' }));
      assert.equal(result.ok, false); assert.equal(result.error.code, code); assert.equal(result.outcome_unknown, undefined);
      assert.equal(f.controller.state.pending, null); assert.equal(f.bridge.hasPending(), false);
      assert.equal(f.principal.locale, null); assert.equal(f.controller.canChangeBinding(), true);
    } finally { adapter.dispose(); f.controller.dispose(); f.bridge.dispose(); }
  }
});
