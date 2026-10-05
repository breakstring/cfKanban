import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const version = '1.9.1';
const ok = data => ({ ok: true, status: 200, data });
const fail = (code, outcome_unknown = false) => ({ ok: false, status: 0, error: { code }, ...(outcome_unknown ? { outcome_unknown: true } : {}) });
const tick = () => new Promise(resolve => setImmediate(resolve));

let modules;
async function sourceModules() {
  modules ??= (async () => {
    const result = await build({
      stdin: {
        contents: 'export { McpWorkbench } from "./packages/mcp/src/workbench.mjs"; export { createMcpAppClient, MCP_APP_PROTOCOL } from "./apps/web/src/mcp-app/client.ts";',
        resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
        loader: 'ts',
      },
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22.12', loader: { '.svg': 'text' }, logLevel: 'silent',
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  })();
  return modules;
}

function facadeFixture({ unknownCreate = false } = {}) {
  const ids = Object.fromEntries(['instance_id', 'principal_id', 'workspace_id', 'project_id'].map(field => [field, randomUUID()]));
  const principal = { id: ids.principal_id, principal_id: ids.principal_id, display_name: 'Isolated native fixture', version: 1, locale: 'en', theme: 'orange', grants: [{ workspace_id: ids.workspace_id, project_id: ids.project_id, role: 'writer' }], hidden_fixture_field: 'PRIVATE_FIXTURE_MARKER' };
  let issue = { id: randomUUID(), identifier: 'CFK-1', title: 'Initial fixture issue', body: '', version: 1, priority: 'none', status: { key: 'backlog', display_name: 'Backlog' }, project: { id: ids.project_id }, workspace: { id: ids.workspace_id }, labels: [], comments: [], allowed_actions: ['read', 'update'], hidden_fixture_field: 'PRIVATE_FIXTURE_MARKER' };
  const calls = [], receipts = new Map();
  let creations = 0;
  const createFacade = config => ({ async callTool(name, args, { signal } = {}) {
    signal?.throwIfAborted();
    calls.push({ name, args: structuredClone(args), config: structuredClone(config) });
    const binding = config?.binding;
    if (binding && (binding.instance_id !== ids.instance_id || binding.expected_principal_id !== ids.principal_id)) return fail('MCP_PRINCIPAL_BINDING_MISMATCH');
    if (binding?.project_ids.length && binding.project_ids[0] !== ids.project_id) return fail('MCP_PROJECT_BINDING_MISMATCH');
    if (name === 'cfkanban_connection_inspect') return args.instance_id
      ? ok({ instance: { instance_id: ids.instance_id, trusted_api_origin: 'https://isolated.fixture.invalid' }, principal: structuredClone(principal) })
      : ok({ candidates: [{ instance_id: ids.instance_id, trusted_api_origin: 'https://isolated.fixture.invalid' }] });
    if (name === 'cfkanban_workspaces_list') return ok({ items: [{ id: ids.workspace_id, display_name: 'Fixture workspace' }] });
    if (name === 'cfkanban_projects_list') return ok({ items: [{ id: ids.project_id, display_name: 'Fixture project' }] });
    if (name === 'cfkanban_projects_get') return ok({ id: ids.project_id, workspace_id: ids.workspace_id, display_name: 'Fixture project' });
    if (name === 'cfkanban_statuses_list') return ok({ items: ['backlog', 'todo', 'in_progress', 'done', 'canceled'].map(key => ({ key, display_name: key })) });
    if (name === 'cfkanban_issues_list') return ok({ items: !args.status || args.status.includes(issue.status.key) ? [structuredClone(issue)] : [] });
    if (name === 'cfkanban_issues_get') return ok(structuredClone(issue));
    if (name === 'cfkanban_issues_create') {
      if (receipts.has(args.idempotency_key)) return structuredClone(receipts.get(args.idempotency_key));
      creations++;
      issue = { ...issue, id: randomUUID(), identifier: `CFK-${creations + 1}`, title: args.title, body: args.body ?? '', priority: args.priority_key ?? 'none', status: { key: args.status_key ?? 'backlog', display_name: args.status_key ?? 'Backlog' } };
      const result = ok({ resource: structuredClone(issue) });
      receipts.set(args.idempotency_key, result);
      if (unknownCreate) { unknownCreate = false; return fail('NETWORK_ERROR', true); }
      return result;
    }
    assert.fail(`Unexpected fixture tool: ${name}`);
  } });
  return { ids, calls, createFacade, get creations() { return creations; }, get issue() { return structuredClone(issue); } };
}

async function nativeHost(t, fixtureOptions) {
  const { McpWorkbench, createMcpAppClient, MCP_APP_PROTOCOL } = await sourceModules();
  const f = facadeFixture(fixtureOptions), workbench = new McpWorkbench({ createFacade: f.createFacade, version });
  const forwarded = [], responses = [], clients = [], hostErrors = [];
  // Codex's native adapter forwards only the tool name and JSON arguments.
  // Any request _meta/request_meta is deliberately discarded, including the sentinel below.
  async function invoke(params) {
    const request = { name: params.name, arguments: structuredClone(params.arguments ?? {}) };
    forwarded.push(request);
    const result = await workbench.callTool(request.name, request.arguments);
    responses.push({ request, result: structuredClone(result) });
    return result;
  }
  t.after(() => { for (const view of clients) view.client.dispose(); workbench.dispose(); });
  async function open({ timeoutMs = 1000 } = {}) {
    const sent = [], snapshots = [], errors = [], settled = [], connects = [], nextIds = [];
    const listeners = new Set(), jobs = new Set();
    let drop;
    const emit = data => { for (const listener of listeners) listener({ data, source: parent }); };
    async function route(message) {
      if (message.method === 'ui/initialize') {
        emit({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: 'native-routing-fixture', version: '1' }, hostCapabilities: {}, hostContext: { locale: 'en', displayMode: 'inline' } } });
      } else if (message.method === 'tools/call') {
        const result = await invoke({ ...message.params, _meta: { 'cfkanban/viewId': 'discard-this-host-metadata' }, request_meta: { ignored: true } });
        if (drop?.(message)) { drop = undefined; return; }
        emit({ jsonrpc: '2.0', id: message.id, result });
      }
    }
    const parent = { postMessage(message, origin) {
      assert.equal(origin, '*');
      sent.push(structuredClone(message));
      const job = Promise.resolve().then(() => route(message)).catch(error => {
        hostErrors.push(error);
        if (message.id) emit({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Isolated fixture routing failed' } });
      }).finally(() => jobs.delete(job));
      jobs.add(job);
    } };
    const window = { parent, addEventListener(type, listener) { if (type === 'message') listeners.add(listener); }, removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); } };
    const client = createMcpAppClient({ window, version, timeoutMs, makeId: () => nextIds.shift() ?? randomUUID(), onConnect: locale => connects.push(locale), onSnapshot: state => snapshots.push(structuredClone(state)), onError: code => errors.push(code), onActionSettled: (message, result) => settled.push({ message, result }) });
    const view = { client, sent, snapshots, errors, settled, connects, get state() { return snapshots.at(-1); }, useActionId(id) { nextIds.push(id); }, dropNext(predicate) { drop = predicate; } };
    clients.push(view);
    await tick();
    const initial = await invoke({ name: 'cfkanban_workbench_open', arguments: {} });
    view.viewId = initial._meta['cfkanban/viewId'];
    emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: initial });
    await tick();
    assert.equal(client.connected, true);
    assert.deepEqual(connects, ['en']);
    assert.deepEqual(errors, []);
    return view;
  }
  async function bind(view) {
    assert.deepEqual(await view.client.action('select_workspace', { workspace_id: f.ids.workspace_id }), { ok: true });
    assert.deepEqual(await view.client.action('bind', { project_id: f.ids.project_id }), { ok: true });
    assert.equal(view.state.binding.project.id, f.ids.project_id);
  }
  return { f, open, bind, invoke, forwarded, responses, assertNoHostErrors() { assert.deepEqual(hostErrors, []); } };
}

test('native-like metadata dropping preserves client action routing, snapshots, and per-view action receipts', async t => {
  const h = await nativeHost(t), one = await h.open(), two = await h.open();
  assert.notEqual(one.viewId, two.viewId);
  const sharedActionId = randomUUID();
  one.useActionId(sharedActionId);
  assert.deepEqual(await one.client.action('select_workspace', { workspace_id: h.f.ids.workspace_id }), { ok: true });
  two.useActionId(sharedActionId);
  assert.deepEqual(await two.client.action('manual', {}), { ok: true });
  assert.equal(one.state.projects.length, 1);
  assert.equal(two.state.projects.length, 1);
  for (const view of [one, two]) {
    const result = await h.invoke({ name: 'cfkanban_workbench_snapshot', arguments: { view_id: view.viewId, action_id: sharedActionId } });
    assert.deepEqual(result._meta['cfkanban/actionReceipt'], { id: sharedActionId, result: { ok: true } });
  }
  assert.deepEqual(await one.client.action('bind', { project_id: h.f.ids.project_id }), { ok: true });
  assert.deepEqual(await one.client.action('view', { mode: 'list' }), { ok: true });
  assert.equal(one.state.view, 'list');
  assert.equal(one.state.board.columns.find(column => column.key === 'backlog').items[0].identifier, 'CFK-1');
  assert.equal(two.state.binding, null);
  const viewCalls = h.forwarded.filter(request => request.name === 'cfkanban_workbench_action');
  assert.ok(viewCalls.every(request => typeof request.arguments.view_id === 'string'));
  assert.ok(h.forwarded.every(request => Object.keys(request).join(',') === 'name,arguments'));
  assert.doesNotMatch(JSON.stringify([...one.snapshots, ...two.snapshots]), /binding_id|idempotency_key|PRIVATE_FIXTURE_MARKER|discard-this-host-metadata/);
  h.assertNoHostErrors();
});

test('uncertain native create retains its original receipt and key until explicit recovery; pending release is refused', async t => {
  const h = await nativeHost(t, { unknownCreate: true }), view = await h.open();
  await h.bind(view);
  const payload = { change: { title: 'Exactly one native creation', body: '**Original fixture Markdown**', priority_key: 'high' } };
  const result = await view.client.action('create_issue', payload);
  assert.equal(result.outcome_unknown, true);
  assert.equal(view.state.pending.operation, 'create');
  assert.equal(h.f.creations, 1);
  const original = h.forwarded.find(request => request.arguments.message?.action === 'create_issue').arguments.message;
  const receipt = await h.invoke({ name: 'cfkanban_workbench_snapshot', arguments: { view_id: view.viewId, action_id: original.id } });
  assert.equal(receipt._meta['cfkanban/actionReceipt'].id, original.id);
  assert.equal(receipt._meta['cfkanban/actionReceipt'].result.outcome_unknown, true);
  const release = await h.invoke({ name: 'cfkanban_workbench_release', arguments: { view_id: view.viewId } });
  assert.equal(release.structuredContent.error.code, 'PANEL_OPERATION_PENDING');
  assert.equal(release.structuredContent.outcome_unknown, true);
  const retry = await view.client.action('create_issue', payload);
  assert.equal(retry.error.code, 'EMBED_REQUEST_UNCERTAIN');
  assert.equal(retry.outcome_unknown, true);
  assert.equal(h.forwarded.at(-1).name, 'cfkanban_workbench_snapshot');
  assert.equal(h.forwarded.at(-1).arguments.action_id, original.id);
  assert.equal(h.f.calls.filter(call => call.name === 'cfkanban_issues_create').length, 1);
  assert.equal(h.forwarded.filter(request => request.arguments.message?.action === 'create_issue').length, 1);
  assert.deepEqual(await view.client.action('recover', {}), { ok: true });
  const writes = h.f.calls.filter(call => call.name === 'cfkanban_issues_create');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].args, writes[0].args);
  assert.equal(h.f.creations, 1);
  assert.equal(view.state.pending, null);
  assert.equal(view.state.issue.identifier, h.f.issue.identifier);
  assert.equal(view.state.issue.title, payload.change.title);
  assert.deepEqual(view.settled, [{ message: original, result: { ok: true } }]);
  assert.doesNotMatch(JSON.stringify(view.snapshots), /binding_id|idempotency_key|PRIVATE_FIXTURE_MARKER/);
  assert.equal((await h.invoke({ name: 'cfkanban_workbench_release', arguments: { view_id: view.viewId } })).structuredContent.ok, true);
  h.assertNoHostErrors();
});

test('a lost successful native create reply is settled by its original action receipt without automatic resubmission', async t => {
  const h = await nativeHost(t), view = await h.open();
  await h.bind(view);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    view.dropNext(message => message.params?.arguments.message?.action === 'create_issue');
    const operation = view.client.action('create_issue', { change: { title: 'One lost-response creation' } });
    await tick();
    assert.equal(h.f.creations, 1);
    t.mock.timers.tick(1000);
    await tick();
    assert.equal((await operation).outcome_unknown, true);
    const original = h.forwarded.find(request => request.arguments.message?.action === 'create_issue').arguments.message;
    t.mock.timers.tick(250);
    await tick();
    assert.equal(h.forwarded.at(-1).name, 'cfkanban_workbench_snapshot');
    assert.equal(h.forwarded.at(-1).arguments.action_id, original.id);
    assert.equal(view.state.pending, null);
    assert.equal(view.state.issue.identifier, h.f.issue.identifier);
    assert.deepEqual(view.settled, [{ message: original, result: { ok: true } }]);
    const requests = h.forwarded.length;
    t.mock.timers.tick(100_000);
    await tick();
    assert.equal(h.forwarded.length, requests);
    assert.equal(h.f.creations, 1);
    assert.equal(h.f.calls.filter(call => call.name === 'cfkanban_issues_create').length, 1);
    assert.equal(h.forwarded.filter(request => request.arguments.message?.action === 'create_issue').length, 1);
    assert.equal(view.client.connected, true);
    h.assertNoHostErrors();
  } finally { view.client.dispose(); t.mock.timers.reset(); }
});
