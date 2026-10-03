import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PanelNavigation, NAVIGATION_ENDPOINTS } from '../src/host/navigation.mjs';
import { navigationTool } from '../src/host/navigation-tool.mjs';
import { PanelBridge } from '../src/host/bridge.mjs';
import { PANEL_PROTOCOL } from '../src/shared/panel.mjs';
import { registerPanelTransport } from '../src/host/transport.mjs';

const success = data => ({ ok: true, status: 200, data });
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const session = randomUUID(), otherSession = randomUUID(), workspaceId = randomUUID(), clientId = randomUUID(), principalId = randomUUID();
  const target = { instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), identifier: 'CFK-548' };
  const operator = {}, reads = [];
  const workspace = { id: workspaceId, path: '/isolated/navigation-fixture', sessionIds: [session, otherSession] };
  const bridge = new PanelBridge({
    host: { singleUserLocal: true, hasWebServer: true, webHost: '127.0.0.1', operator },
    sessionContext: { workspaces: () => [workspace], workspace: () => workspace, inspect: async () => ({ meta: { cwd: workspace.path } }) },
    createFacade: config => ({ callTool: async (name, args, { signal }) => {
      reads.push({ name, args, binding: config?.binding, signal });
      if (options.tool) { const value = await options.tool(name, args, signal); if (value) return value; }
      if (name === 'cfkanban_connection_inspect') return success({ principal: { principal_id: principalId } });
      if (name === 'cfkanban_projects_get') return success({ id: target.project_id, workspace_id: target.workspace_id });
      if (name === 'cfkanban_issues_get') return success({ identifier: target.identifier, project: { id: target.project_id } });
      throw new Error('Unexpected fixture operation');
    } }),
  });
  const navigation = new PanelNavigation({ bridge, timeoutMs: 500, ...options });
  t.after(() => { navigation.dispose(); bridge.dispose(); });
  const input = (endpoint, value, signal = new AbortController().signal, peer = operator) => navigation.call(endpoint, { protocol: PANEL_PROTOCOL, input: value }, signal, peer);
  const subscribe = async (sessionId = session, browserClientId = clientId) => {
    const abort = new AbortController();
    const waiting = input('navigation_subscribe', { session_id: sessionId, client_id: browserClientId }, abort.signal);
    await turn();
    return { abort, waiting };
  };
  const open = (value = target, sessionId = session, signal = new AbortController().signal) => navigation.open(value, { agent: { session: { id: sessionId } }, signal });
  const ack = (request, value = { ok: true, target }, sessionId = session, browserClientId = clientId) => input('navigation_ack', { session_id: sessionId, client_id: browserClientId, request_id: request.request_id, result: value });
  return { navigation, bridge, target, session, otherSession, clientId, principalId, reads, operator, input, subscribe, open, ack };
}

test('Agent navigation is bound to the Host-provided Session and requires one live client', async t => {
  const f = fixture(t);
  assert.equal((await f.open()).error.code, 'PANEL_NAVIGATION_CLIENT_UNAVAILABLE');
  const other = await f.subscribe(f.otherSession);
  assert.equal((await f.open()).error.code, 'PANEL_NAVIGATION_CLIENT_UNAVAILABLE');
  assert.equal((await f.navigation.open(f.target, {})).error.code, 'PANEL_NAVIGATION_SESSION_REQUIRED');
  assert.equal((await f.open({ ...f.target, session_id: f.otherSession })).error.code, 'PANEL_INVALID_INPUT');
  assert.equal(f.reads.length, 0);
  other.abort.abort();
  await other.waiting;
});

test('only an exact rendered target acknowledgement returns opened after bound read-only preflight', async t => {
  const f = fixture(t), receiver = await f.subscribe(), opening = f.open();
  const request = (await receiver.waiting).data;
  assert.equal(request.session_id, f.session);
  assert.deepEqual(request.target, f.target);
  assert.equal(request.expected_principal_id, f.principalId);
  assert.ok(request.expires_at > Date.now());
  const next = await f.subscribe();
  let settled = false;
  opening.then(() => { settled = true; });
  await turn();
  assert.equal(settled, false);
  assert.deepEqual((await f.ack(request)).data, { acknowledged: true });
  assert.deepEqual(await opening, { ok: true, opened: true, surface: 'sidebar', target: f.target });
  assert.deepEqual(f.reads.map(row => row.name), ['cfkanban_connection_inspect', 'cfkanban_projects_get', 'cfkanban_issues_get']);
  for (const read of f.reads.slice(1)) assert.deepEqual(read.binding, { instance_id: f.target.instance_id, expected_principal_id: f.principalId, project_ids: [f.target.project_id] });
  assert.equal(f.bridge.bindings.size, 0);
  next.abort.abort();
  await next.waiting;
});

test('two foreground clients are ambiguous and aborting one restores exact routing', async t => {
  const f = fixture(t), first = await f.subscribe(), second = await f.subscribe(f.session, randomUUID());
  assert.equal((await f.open()).error.code, 'PANEL_NAVIGATION_CLIENT_AMBIGUOUS');
  assert.equal(f.reads.length, 0);
  second.abort.abort();
  await second.waiting;
  const opening = f.open(), request = (await first.waiting).data, next = await f.subscribe();
  await f.ack(request);
  assert.equal((await opening).opened, true);
  next.abort.abort();
});

test('Session or client mismatched acknowledgements cannot complete another request', async t => {
  const f = fixture(t), receiver = await f.subscribe(), opening = f.open(), request = (await receiver.waiting).data;
  const next = await f.subscribe();
  assert.equal((await f.ack(request, { ok: true, target: f.target }, f.otherSession)).error.code, 'PANEL_NAVIGATION_REQUEST_EXPIRED');
  assert.equal((await f.ack(request, { ok: true, target: f.target }, f.session, randomUUID())).error.code, 'PANEL_NAVIGATION_REQUEST_EXPIRED');
  assert.equal(f.navigation.pending.size, 1);
  await f.ack(request);
  assert.equal((await opening).opened, true);
  next.abort.abort();
});

test('target mismatch, malformed ack and client render failure are terminal errors', async t => {
  for (const [ackValue, code] of [
    [{ ok: true, target: { instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() } }, 'PANEL_NAVIGATION_ACK_MISMATCH'],
    [{ ok: true, target: {}, extra: 'secret-marker' }, 'PANEL_NAVIGATION_ACK_MISMATCH'],
    [{ ok: false, error: { code: 'PANEL_NAVIGATION_DRAFT_PENDING' } }, 'PANEL_NAVIGATION_DRAFT_PENDING'],
  ]) {
    const f = fixture(t), receiver = await f.subscribe(), opening = f.open(), request = (await receiver.waiting).data;
    const next = await f.subscribe();
    await f.ack(request, ackValue);
    const outcome = await opening;
    assert.equal(outcome.error.code, code);
    assert.equal(JSON.stringify(outcome).includes('secret-marker'), false);
    assert.equal(f.navigation.pending.size, 0);
    next.abort.abort();
  }
});

test('timeouts do not report opened or retain requests, and late acknowledgement is rejected', async t => {
  const f = fixture(t, { timeoutMs: 30 }), receiver = await f.subscribe(), opening = f.open(), request = (await receiver.waiting).data;
  const next = await f.subscribe();
  assert.equal((await opening).error.code, 'PANEL_NAVIGATION_TIMEOUT');
  assert.equal(f.navigation.pending.size, 0);
  assert.equal((await f.ack(request)).error.code, 'PANEL_NAVIGATION_REQUEST_EXPIRED');
  next.abort.abort();
});

test('backgrounding, tool cancellation and plugin unload remove in-flight navigation and subscriptions', async t => {
  for (const mode of ['background', 'cancel', 'dispose']) {
    const f = fixture(t), receiver = await f.subscribe(), abort = new AbortController(), opening = f.open(f.target, f.session, abort.signal);
    const request = (await receiver.waiting).data, next = await f.subscribe();
    if (mode === 'background') next.abort.abort();
    if (mode === 'cancel') abort.abort();
    if (mode === 'dispose') f.navigation.dispose();
    const outcome = await opening;
    assert.equal(outcome.ok, false);
    assert.equal(f.navigation.pending.size, 0);
    assert.equal((await f.ack(request)).ok, false);
    next.abort.abort();
    await next.waiting;
    assert.equal(f.navigation.subscriptions.size, 0);
  }
});

test('a second client arriving during render invalidates the first request', async t => {
  const f = fixture(t), receiver = await f.subscribe(), opening = f.open();
  await receiver.waiting;
  const other = await f.subscribe(f.session, randomUUID());
  assert.equal((await opening).error.code, 'PANEL_NAVIGATION_CLIENT_AMBIGUOUS');
  other.abort.abort();
});

test('permission failures and wrong Issue scope preserve structured refusal without a navigation event', async t => {
  for (const permission of [true, false]) {
    const f = fixture(t, { tool: async name => name === 'cfkanban_issues_get' ? permission ? { ok: false, error: { code: 'FORBIDDEN', message: 'secret-marker' } } : success({ project: { id: randomUUID() } }) : undefined });
    const receiver = await f.subscribe();
    const outcome = await f.open();
    assert.equal(outcome.error.code, permission ? 'FORBIDDEN' : 'PANEL_SCOPE_DENIED');
    assert.equal(JSON.stringify(outcome).includes('secret-marker'), false);
    assert.equal(f.navigation.pending.size, 0);
    assert.equal(f.navigation.subscriptions.get(f.session).size, 1);
    receiver.abort.abort();
  }
});

test('preflight has a bounded deadline and unregister aborts a hung permission check', async t => {
  for (const cancel of [false, true]) {
    const f = fixture(t, { timeoutMs: 200, preflightMs: 20, tool: name => name === 'cfkanban_projects_get' ? new Promise(() => {}) : undefined });
    const receiver = await f.subscribe(), opening = f.open();
    await turn();
    if (cancel) await f.input('navigation_unsubscribe', { session_id: f.session, client_id: f.clientId });
    assert.equal((await opening).error.code, cancel ? 'PANEL_NAVIGATION_CLIENT_UNAVAILABLE' : 'PANEL_NAVIGATION_TIMEOUT');
    assert.equal(f.reads.at(-1).signal.aborted, true);
    assert.equal(f.navigation.pending.size, 0);
    receiver.abort.abort();
  }
});

test('unload cancels subscription Session verification and RPC requires the admitted local operator', async t => {
  const f = fixture(t);
  assert.equal((await f.input('navigation_subscribe', { session_id: f.session, client_id: f.clientId }, new AbortController().signal, {})).error.code, 'PANEL_LOCAL_HOST_REQUIRED');
  f.bridge.sessions.inspect = () => new Promise(() => {});
  const subscriber = f.input('navigation_subscribe', { session_id: f.session, client_id: f.clientId });
  await turn();
  f.navigation.dispose();
  assert.equal((await subscriber).ok, false);
  assert.equal(f.navigation.subscriptions.size, 0);
});

test('navigation transport uses the existing exact admitted routes and preserves request lifetime', async t => {
  const f = fixture(t), routes = [], effects = [];
  const schemas = { RpcId: value => value, clientRequestSchema: { safeParse: value => ({ success: true, data: value }) }, serverResponseSchema: { parse: value => value } };
  registerPanelTransport({ effect: factory => effects.push(factory()), connection: { operator: f.operator, fetch: { register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } } }, f.bridge, schemas, f.navigation);
  assert.ok(NAVIGATION_ENDPOINTS.every(endpoint => routes.some(route => route.path === `/api/cfkanban-panel/${endpoint}`)));
  const endpoint = 'navigation_subscribe', path = `/api/cfkanban-panel/${endpoint}`, abort = new AbortController();
  const request = new Request(`http://127.0.0.1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ type: 'client-request', rpcId: 'subscribe-id', method: `cfkanban-panel/${endpoint}`, payload: { protocol: PANEL_PROTOCOL, input: { session_id: f.session, client_id: f.clientId } } }) });
  const response = routes.find(route => route.path === path).fetch(request);
  await turn();
  assert.equal(f.navigation.subscriptions.size, 1);
  abort.abort();
  const envelope = await (await response).json();
  assert.equal(envelope.rpcId, 'subscribe-id');
  assert.equal(envelope.result.value.error.code, 'PANEL_NAVIGATION_CANCELLED');
  assert.equal(f.navigation.subscriptions.size, 0);
  effects.reverse().forEach(dispose => dispose());
  assert.equal(routes.length, 0);
});

test('Host tool discovery exposes only explicit business target parameters and returns canonical values', async () => {
  const calls = [], navigation = { open: async (...args) => { calls.push(args); return { ok: false, error: { code: 'PANEL_NAVIGATION_CLIENT_UNAVAILABLE', message: 'No client.' } }; } };
  const tool = navigationTool(navigation, value => value);
  assert.equal(tool.name, 'cfkanban_view_open');
  assert.deepEqual(Object.keys(tool.parameters).filter(key => key !== 'additionalProperties'), ['instance_id', 'workspace_id', 'project_id', 'identifier']);
  assert.equal(tool.parameters.additionalProperties, false);
  const args = {}, exec = { agent: { session: { id: randomUUID() } }, signal: new AbortController().signal };
  const value = await tool.execute(args, exec);
  assert.deepEqual(calls, [[args, exec]]);
  assert.deepEqual(JSON.parse(tool.output.render(args, value)[0].text), value);
});
