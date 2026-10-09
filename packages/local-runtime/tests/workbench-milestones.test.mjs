import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WorkbenchBridge } from '../src/workbench/bridge.mjs';
import { WorkbenchController } from '../src/workbench/controller.mjs';
import { milestoneSummary, STATUSES, validateCheckpoint } from '../src/workbench/shared.mjs';

const ok = data => ({ ok: true, status: 200, data });
const action = (action, payload = {}) => ({ type: 'action', id: randomUUID(), action, payload });
const node = (title, status_key = 'open') => ({ id: randomUUID(), title, status_key, due_date: null });
let adapterModule;
async function adapterExports() {
  adapterModule ??= build({ entryPoints: [fileURLToPath(new URL('../src/workbench/embed-adapter.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser' })
    .then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));
  return adapterModule;
}
function fixture({ reader = false, legacy = false, unknown = false } = {}) {
  const ids = { instance_id: randomUUID(), principal_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() };
  const first = node('阶段一'), closed = node('已关闭节点', 'closed'), selected = node('不在首屏的当前节点', 'closed');
  const principal = { id: ids.principal_id, principal_id: ids.principal_id, version: 1, display_name: 'Isolated milestone user', grants: [{ ...ids, role: reader ? 'reader' : 'writer' }] };
  let issue = { id: randomUUID(), identifier: 'CFK-1', title: 'Fixture issue', version: 3, body: 'Body', priority: 'none', status: { key: 'todo' }, project: { id: ids.project_id }, workspace: { id: ids.workspace_id }, comments: [], labels: [], allowed_actions: reader ? ['read'] : ['read', 'update'], ...(legacy ? {} : { milestone: { ...selected, description: 'PRIVATE_MILESTONE_DESCRIPTION' } }) };
  const calls = [], receipts = new Map(), operator = {}, target = { instance_id: ids.instance_id, workspace_id: ids.workspace_id, project_id: ids.project_id };
  let hook, writes = 0;
  const bridge = new WorkbenchBridge({ directory: '/isolated-local-fixture', host: { singleUserLocal: true, hasWebServer: true, webHost: '127.0.0.1', operator }, directoryReader: async () => ({ status: 'configured', targets: [target] }), createFacade: config => ({ callTool: async (name, args, options) => {
    calls.push({ name, args: structuredClone(args), config: structuredClone(config) });
    if (hook) { const result = await hook(name, args, options); if (result !== undefined) return result; }
    if (name === 'cfkanban_connection_inspect') return ok({ instance: { instance_id: ids.instance_id }, principal: structuredClone(principal) });
    if (name === 'cfkanban_projects_get') return ok({ id: ids.project_id, workspace_id: ids.workspace_id, display_name: 'Project' });
    if (name === 'cfkanban_statuses_list') return ok({ items: STATUSES.map(key => ({ key, display_name: key })) });
    if (name === 'cfkanban_issues_list') return ok({ items: !args.status || args.status.includes(issue.status.key) ? [structuredClone(issue)] : [] });
    if (name === 'cfkanban_issues_get') return ok(structuredClone(issue));
    if (name === 'cfkanban_milestones_list') return legacy ? { ok: false, status: 404, error: { code: 'NOT_FOUND' } } : ok({ items: [{ ...(args.cursor ? closed : first), project_id: ids.project_id, workspace_id: ids.workspace_id, description: 'PRIVATE_MILESTONE_DESCRIPTION', progress: { total: 99 } }], next_cursor: args.cursor ? null : 'PRIVATE_MILESTONE_CURSOR', has_more: !args.cursor, resolved_scope: target });
    if (name === 'cfkanban_issues_update') {
      if (receipts.has(args.idempotency_key)) return receipts.get(args.idempotency_key);
      if (reader) return { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED' } };
      if (args.expected_version !== issue.version) return { ok: false, status: 409, error: { code: 'VERSION_CONFLICT' } };
      writes++; issue = { ...issue, version: issue.version + 1, ...(args.changes.title === undefined ? {} : { title: args.changes.title }), ...(Object.hasOwn(args.changes, 'milestone_id') ? { milestone: args.changes.milestone_id === null ? null : [first, closed, selected].find(row => row.id === args.changes.milestone_id) } : {}) };
      const result = ok({ resource: structuredClone(issue) }); receipts.set(args.idempotency_key, result);
      if (unknown) { unknown = false; return { ok: false, status: 0, error: { code: 'NETWORK_ERROR' }, outcome_unknown: true }; }
      return result;
    }
    return ok({ items: [] });
  } }) });
  const rpc = { call: async (endpoint, payload, signal) => ({ ok: true, value: await bridge.call(endpoint, payload, signal, operator) }) };
  const controller = new WorkbenchController(rpc, new AbortController().signal);
  return { ids, first, closed, selected, bridge, controller, rpc, calls, get issue() { return issue; }, get writes() { return writes; }, intercept(value) { hook = value; }, dispose() { controller.dispose(); bridge.dispose(); } };
}
async function ready(f) { await f.controller.bootstrap(); await f.controller.openIssue('CFK-1'); }

test('milestone candidates use fixed trusted scope, include closed nodes, and publish only bounded summaries', async () => {
  const f = fixture(); const { WorkbenchAdapter } = await adapterExports(); const adapter = new WorkbenchAdapter(f.controller);
  try {
    await ready(f); assert.deepEqual(adapter.snapshotMessage().state.issue.milestone, f.selected);
    assert.equal(f.calls.some(call => call.name === 'cfkanban_milestones_list'), false, 'selected node does not trigger full candidate traversal');
    assert.equal((await adapter.receive(action('milestones', { next: false }))).ok, true);
    assert.equal((await adapter.receive(action('milestones', { next: true }))).ok, true);
    assert.deepEqual(adapter.snapshotMessage().state.milestones, [f.first, f.closed]);
    assert.deepEqual(adapter.snapshotMessage().state.issue.milestone, f.selected);
    assert.doesNotMatch(JSON.stringify(adapter.snapshotMessage()), /PRIVATE_MILESTONE/);
    const reads = f.calls.filter(call => call.name === 'cfkanban_milestones_list');
    assert.equal(reads.length, 2); assert.ok(reads.every(call => call.args.project_id === f.ids.project_id && call.args.workspace_id === f.ids.workspace_id && call.args.limit === 20 && !Object.hasOwn(call.args, 'status')));
    assert.equal(reads[1].args.cursor, 'PRIVATE_MILESTONE_CURSOR');
    assert.ok(reads.every(call => call.config.binding.project_ids[0] === f.ids.project_id && call.config.binding.expected_principal_id === f.ids.principal_id));
    const invalid = await f.bridge.call('milestones', { protocol: 1, input: { binding_id: f.controller.state.binding.binding_id, project_id: randomUUID() } }, new AbortController().signal, f.bridge.host.operator);
    assert.equal(invalid.error.code, 'PANEL_INVALID_INPUT'); assert.equal(f.calls.filter(call => call.name === 'cfkanban_milestones_list').length, 2);
    assert.equal((await adapter.receive(action('mutate', { operation: 'update', change: { milestone_id: randomUUID() } }))).ok, false);
    assert.equal((await adapter.receive(action('mutate', { operation: 'update', change: { milestone_id: f.selected.id } }))).ok, true, 'current selection can be retained without its candidate page');
    assert.equal((await adapter.receive(action('mutate', { operation: 'update', change: { milestone_id: f.closed.id } }))).ok, true);
    assert.deepEqual(adapter.snapshotMessage().state.issue.milestone, f.closed);
    assert.equal((await adapter.receive(action('mutate', { operation: 'update', change: { milestone_id: null } }))).ok, true);
    assert.equal(adapter.snapshotMessage().state.issue.milestone, null);
  } finally { adapter.dispose(); f.dispose(); }
});

test('reader sees its selected milestone without candidate requests or assignment writes; legacy Issues remain editable', async () => {
  const { WorkbenchAdapter } = await adapterExports();
  for (const options of [{ reader: true }, { legacy: true }]) {
    const f = fixture(options), adapter = new WorkbenchAdapter(f.controller);
    try {
      await ready(f); const current = adapter.snapshotMessage().state.issue;
      if (options.reader) {
        assert.deepEqual(current.milestone, f.selected); assert.equal((await adapter.receive(action('milestones', { next: false }))).ok, false);
        assert.equal((await adapter.receive(action('mutate', { operation: 'update', change: { milestone_id: null } }))).ok, false);
        assert.equal(f.calls.some(call => call.name === 'cfkanban_milestones_list'), false);
      } else {
        assert.equal(Object.hasOwn(current, 'milestone'), false);
        await f.controller.loadMilestones(); assert.equal(f.controller.state.issue.identifier, 'CFK-1');
        assert.equal((await adapter.receive(action('mutate', { operation: 'update', change: { title: 'Legacy edit' } }))).ok, true);
        assert.equal(adapter.snapshotMessage().state.issue.title, 'Legacy edit'); assert.equal(Object.hasOwn(adapter.snapshotMessage().state.issue, 'milestone'), false);
      }
    } finally { adapter.dispose(); f.dispose(); }
  }
});

test('checkpoint recovery allows candidate loading for an editable supported Issue while reader and legacy Issues stay restricted', async () => {
  const { WorkbenchAdapter } = await adapterExports();
  for (const options of [{}, { reader: true }, { legacy: true }]) {
    const f = fixture(options); let resumed, adapter;
    try {
      await ready(f); const checkpoint = f.controller.getCheckpoint();
      assert.equal(Object.hasOwn(checkpoint.state.binding.project, 'workspace_id'), false);
      resumed = new WorkbenchController(f.rpc, new AbortController().signal);
      assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
      adapter = new WorkbenchAdapter(resumed);
      const permitted = !options.reader && !options.legacy;
      assert.equal((await adapter.receive(action('milestones', { next: false }))).ok, permitted);
      assert.equal(f.calls.filter(call => call.name === 'cfkanban_milestones_list').length, permitted ? 1 : 0);
      assert.equal(resumed.state.issue.identifier, 'CFK-1');
      if (permitted) assert.deepEqual(adapter.snapshotMessage().state.milestones, [f.first]);
      else if (options.reader) assert.deepEqual(adapter.snapshotMessage().state.issue.milestone, f.selected);
      else assert.equal(Object.hasOwn(adapter.snapshotMessage().state.issue, 'milestone'), false);
    } finally { adapter?.dispose(); resumed?.dispose(); f.dispose(); }
  }
});

test('uncertain assignment and clearing preserve original CAS, key and exact milestone request across checkpoint recovery', async () => {
  for (const clear of [false, true]) {
    const f = fixture({ unknown: true }); let resumed;
    try {
      await ready(f); const change = { milestone_id: clear ? null : f.first.id };
      assert.equal((await f.controller.mutate('update', change)).outcome_unknown, true);
      const checkpoint = f.controller.getCheckpoint(); assert.ok(checkpoint);
      assert.deepEqual(checkpoint.state.pending.change, change); assert.equal(checkpoint.state.pending.expected_version, 3);
      assert.deepEqual(checkpoint.state.issue.milestone, clear ? null : f.first); assert.equal(f.bridge.acceptsCheckpoint(checkpoint), true);
      const altered = structuredClone(checkpoint); altered.state.pending.change.milestone_id = randomUUID(); assert.ok(validateCheckpoint(altered)); assert.equal(f.bridge.acceptsCheckpoint(altered), false);
      const invalid = structuredClone(checkpoint); invalid.state.pending.change.milestone_id = 'invalid'; assert.equal(validateCheckpoint(invalid), null);
      resumed = new WorkbenchController(f.rpc, new AbortController().signal); assert.equal(await resumed.restoreCheckpoint(checkpoint), true);
      assert.deepEqual(resumed.state.pending, checkpoint.state.pending); assert.equal((await resumed.mutate(null, null, true)).ok, true);
      const calls = f.calls.filter(call => call.name === 'cfkanban_issues_update'); assert.equal(calls.length, 2); assert.deepEqual(calls[0].args, calls[1].args);
      assert.equal(f.writes, 1); assert.equal(resumed.state.pending, null); assert.deepEqual(resumed.state.issue.milestone, clear ? null : f.first);
    } finally { resumed?.dispose(); f.dispose(); }
  }
});

test('candidate pages reject stalled cursors and capacity; a scope change drops late results without altering details', async () => {
  const f = fixture(); try {
    await ready(f); await f.controller.loadMilestones(); const current = f.controller.state.issue;
    f.intercept((name, args) => name === 'cfkanban_milestones_list' && args.cursor ? ok({ items: [f.closed], next_cursor: args.cursor }) : undefined);
    assert.equal((await f.controller.loadMilestones(true)).error.code, 'PANEL_PAGINATION_STALLED'); assert.deepEqual(f.controller.state.milestones, [f.first]); assert.equal(f.controller.state.issue, current);
    f.intercept(name => name === 'cfkanban_milestones_list' ? ok({ items: Array.from({ length: 1001 }, () => node('Too many')), next_cursor: null }) : undefined);
    assert.equal((await f.controller.loadMilestones()).error.code, 'PANEL_CAPACITY'); assert.deepEqual(f.controller.state.milestones, [f.first]);
    let finish; f.intercept(name => name === 'cfkanban_milestones_list' ? new Promise(resolve => { finish = resolve; }) : undefined);
    const loading = f.controller.loadMilestones(); while (!finish) await new Promise(resolve => setImmediate(resolve));
    f.controller.patch({ binding: { ...f.controller.state.binding, binding_id: randomUUID(), project: { ...f.controller.state.binding.project, id: randomUUID() } } });
    finish(ok({ items: [f.closed], next_cursor: null })); await loading;
    assert.deepEqual(f.controller.state.milestones, []); assert.equal(f.controller.state.milestone_cursor, null); assert.equal(f.controller.state.issue, current);
  } finally { f.dispose(); }
});

test('permission or foreign-scope failure discards candidate data and stale pages, preserving other Issue business', async () => {
  for (const foreign of [false, true]) {
    const f = fixture(); try {
      await ready(f); await f.controller.loadMilestones(); const current = f.controller.state.issue;
      let finish; f.intercept((name, args) => name === 'cfkanban_milestones_list' && args.cursor ? new Promise(resolve => { finish = resolve; }) : name === 'cfkanban_milestones_list' ? foreign ? ok({ items: [{ ...f.first, project_id: randomUUID() }] }) : { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED' } } : undefined);
      const next = f.controller.loadMilestones(true); while (!finish) await new Promise(resolve => setImmediate(resolve));
      await f.controller.loadMilestones(); finish(ok({ items: [f.closed] })); await next;
      assert.deepEqual(f.controller.state.milestones, []); assert.equal(f.controller.state.milestone_cursor, null); assert.equal(f.controller.state.issue, current);
    } finally { f.dispose(); }
  }
});

test('milestone refresh is singleflight and continuation traversal stops at the page budget', async () => {
  const f = fixture(); try {
    await ready(f); let finish, pages = 0;
    f.intercept(name => name === 'cfkanban_milestones_list' ? new Promise(resolve => { finish = resolve; }) : undefined);
    const a = f.controller.loadMilestones(), b = f.controller.loadMilestones(); while (!finish) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(call => call.name === 'cfkanban_milestones_list').length, 1); finish(ok({ items: [f.first], next_cursor: 'page-1' })); await Promise.all([a, b]);
    f.intercept(name => name === 'cfkanban_milestones_list' ? ok({ items: [f.first], next_cursor: `page-${++pages + 1}` }) : undefined);
    for (let index = 1; index < 40; index++) assert.equal((await f.controller.loadMilestones(true)).ok, true);
    assert.equal((await f.controller.loadMilestones(true)).error.code, 'PANEL_CAPACITY'); assert.equal(f.controller.state.issue.identifier, 'CFK-1');
  } finally { f.dispose(); }
});

test('milestone DTO rejects invalid dates and checkpoints never persist private candidate cursors', () => {
  for (const due_date of ['2026-02-29', '2026-04-31', '0000-01-01']) assert.throws(() => milestoneSummary({ ...node('Node'), due_date }));
  const f = fixture(); try {
    f.controller.patch({ milestones: [f.first], milestone_cursor: 'PRIVATE_MILESTONE_CURSOR', milestones_has_more: true });
    assert.doesNotMatch(JSON.stringify(f.controller.getCheckpoint()), /PRIVATE_MILESTONE_CURSOR|milestones_has_more/);
  } finally { f.dispose(); }
});

test('malformed milestone candidates return definite input errors without losing current Issue or valid candidates', async () => {
  const f = fixture(); try {
    await ready(f); await f.controller.loadMilestones(); const issue = f.controller.state.issue;
    for (const candidate of [null, undefined, {}, [], 3, { ...f.first, title: ' padded ' }, { ...f.first, due_date: '2026-02-29' }]) {
      f.intercept(name => name === 'cfkanban_milestones_list' ? ok({ items: [candidate], next_cursor: null }) : undefined);
      const result = await f.controller.loadMilestones(); assert.equal(result.ok, false); assert.equal(result.error.code, 'PANEL_INVALID_INPUT'); assert.equal(result.outcome_unknown, undefined);
      assert.deepEqual(f.controller.state.milestones, [f.first]); assert.equal(f.controller.state.issue, issue);
    }
    const direct = new WorkbenchController({ call: async () => ({ ok: true, value: ok({ items: [null] }) }) }, new AbortController().signal);
    try {
      direct.patch({ binding: f.controller.state.binding, issue });
      assert.equal((await direct.loadMilestones()).error.code, 'PANEL_INVALID_INPUT'); assert.equal(direct.state.issue, issue);
    } finally { direct.dispose(); }
  } finally { f.dispose(); }
});
