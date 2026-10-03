import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PanelNavigation, navigateWorkbench, navigationRequest } from '../src/client/navigation.mjs';
import { PanelNavigation as HostNavigation } from '../src/host/navigation.mjs';
import { WorkbenchController } from '../../local-runtime/src/workbench/controller.mjs';

const target = () => ({ instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), identifier: 'CFK-551' });
const request = () => ({ request_id: randomUUID(), session_id: 'session-fixture', target: target(), expected_principal_id: randomUUID(), expires_at: Date.now() + 3000 });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(r = request()) {
  const calls = [];
  const life = new AbortController();
  const identity = { instance: { instance_id: r.target.instance_id }, principal: { principal_id: r.expected_principal_id } };
  const controller = {
    signal: life.signal, state: { busy: 0, pending: null, binding: null },
    canChangeBinding: () => true,
    patch(value) { Object.assign(this.state, value); },
    async selectInstance(id) { calls.push(['identity', id]); this.patch({ identity }); },
    async bind(id) { calls.push(['bind', id]); this.patch({ binding: { binding_id: randomUUID(), identity, project: { id, workspace_id: r.target.workspace_id } } }); },
    async openIssue(id) { calls.push(['issue', id]); this.patch({ issue: { identifier: id } }); },
    async refresh() { calls.push(['refresh']); },
    async request(endpoint) { calls.push([endpoint]); return { result: { ok: true } }; },
  };
  const adapter = { running: false, async waitForRendered(value) { calls.push(['render', value]); return { ok: true }; } };
  return { controller, adapter, online: { blocked: false }, request: r, signal: life.signal, isCurrent: () => true, calls, life };
}

test('an explicit Issue binds directly and waits for the matching rendered page', async () => {
  const f = fixture();
  const out = await navigateWorkbench(f);
  assert.deepEqual(out, { ok: true, target: f.request.target });
  assert.deepEqual(f.calls.map(row => row[0]), ['identity', 'bind', 'issue', 'render']);
  assert.deepEqual(f.calls.at(-1)[1], { ...f.request.target, principal_id: f.request.expected_principal_id });
  assert.equal(f.adapter.running, false);
});

test('a Project request leaves Issue details and refreshes the project view', async () => {
  const r = request(); delete r.target.identifier;
  const f = fixture(r);
  assert.equal((await navigateWorkbench(f)).ok, true);
  assert.deepEqual(f.calls.map(row => row[0]), ['identity', 'bind', 'refresh', 'render']);
  assert.equal(f.controller.state.issue, null);
});

test('pending writes and online delivery block navigation without changing the binding', async () => {
  for (const blocked of ['pending', 'online', 'busy', 'adapter']) {
    const f = fixture();
    if (blocked === 'pending') f.controller.state.pending = {};
    if (blocked === 'online') f.online.blocked = true;
    if (blocked === 'busy') f.controller.state.busy = 1;
    if (blocked === 'adapter') f.adapter.running = true;
    assert.equal((await navigateWorkbench(f)).error.code, 'PANEL_NAVIGATION_BUSY');
    assert.deepEqual(f.calls, []);
  }
});

test('identity drift and a changed Session do not report an opened page', async () => {
  const f = fixture();
  f.controller.selectInstance = async () => f.controller.patch({ identity: { principal: { id: randomUUID() } } });
  assert.equal((await navigateWorkbench(f)).error.code, 'PANEL_IDENTITY_CHANGED');
  assert.deepEqual(f.calls, []);
  const changed = fixture();
  // Callback identity is stable while the underlying foreground state changes.
  let foreground = true;
  changed.isCurrent = () => foreground;
  changed.adapter.waitForRendered = async () => { foreground = false; return { ok: true }; };
  assert.equal((await navigateWorkbench(changed)).error.code, 'PANEL_NAVIGATION_CANCELED');
});

test('render failure is returned and a reused binding avoids instance selection', async () => {
  const f = fixture();
  await f.controller.selectInstance(f.request.target.instance_id);
  await f.controller.bind(f.request.target.project_id);
  f.calls.length = 0;
  f.adapter.waitForRendered = async () => ({ ok: false, error: { code: 'PANEL_RENDER_TIMEOUT' } });
  assert.equal((await navigateWorkbench(f)).error.code, 'PANEL_RENDER_TIMEOUT');
  assert.deepEqual(f.calls.map(row => row[0]), ['issue']);
});

test('canceling a real Controller bind releases navigation immediately and ignores its late response', async t => {
  const r = request(), panelLife = new AbortController(), navigationLife = new AbortController();
  const calls = [];
  const identity = { instance: { instance_id: r.target.instance_id }, principal: { principal_id: r.expected_principal_id } };
  const wire = data => ({ ok: true, value: { ok: true, data } });
  let releaseBind, bindSignal, firstBind = true;
  const controller = new WorkbenchController({ async call(endpoint, payload, signal) {
    const input = payload.input;
    calls.push(endpoint);
    if (endpoint === 'identity') return wire(identity);
    if (endpoint === 'bind') {
      const response = wire({ binding_id: randomUUID(), identity, project: { id: input.project_id, workspace_id: input.workspace_id } });
      if (!firstBind) return response;
      firstBind = false;
      bindSignal = signal;
      return new Promise(resolve => { releaseBind = () => resolve(response); });
    }
    if (endpoint === 'list') return wire({ items: [] });
    if (endpoint === 'detail') return wire({ identifier: input.identifier, comments: [] });
    throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
  } }, panelLife.signal, undefined, { initialView: 'list' });
  t.after(() => controller.dispose());
  const adapter = { running: false, async waitForRendered() { return { ok: true }; } };
  const options = { controller, adapter, online: { blocked: false }, request: r, signal: navigationLife.signal, isCurrent: () => true };
  let outcome;
  const opening = navigateWorkbench(options).then(value => { outcome = value; });
  await tick();
  assert.equal(typeof releaseBind, 'function');
  assert.equal(controller.state.busy, 1);
  navigationLife.abort();
  await tick();
  assert.equal(outcome?.error.code, 'PANEL_NAVIGATION_CANCELED');
  assert.equal(bindSignal.aborted, true);
  assert.equal(adapter.running, false);
  assert.equal(controller.state.busy, 0);
  assert.equal(controller.state.binding, null);
  assert.equal(controller.state.error, null);
  assert.deepEqual(calls, ['identity', 'bind']);
  await opening;

  const nextRequest = { ...r, request_id: randomUUID(), target: { ...r.target, project_id: randomUUID(), identifier: 'CFK-552' } };
  const next = await navigateWorkbench({ ...options, request: nextRequest, signal: new AbortController().signal });
  assert.deepEqual(next, { ok: true, target: nextRequest.target });
  assert.equal(controller.state.binding.project.id, nextRequest.target.project_id);
  assert.equal(controller.state.issue.identifier, nextRequest.target.identifier);
  const current = controller.state;
  const finishedCalls = [...calls];
  releaseBind();
  await tick();
  assert.equal(controller.state, current);
  assert.deepEqual(calls, finishedCalls, 'the abandoned bind must not start a collection read');
  assert.equal(adapter.running, false);
  assert.equal(controller.state.busy, 0);
});

test('navigation wire rejects extra fields, arbitrary URLs and malformed identifiers', () => {
  assert.deepEqual(navigationRequest(request()).target.identifier, 'CFK-551');
  assert.throws(() => navigationRequest({ ...request(), url: 'https://example.com' }));
  const r = request(); r.target.identifier = 'https://example.com';
  assert.throws(() => navigationRequest(r));
});

test('header subscription opens once, claims its own Session and acknowledges only completion', async () => {
  const r = request(); const acks = []; let pending; let opened;
  const sidebar = { commandTarget: () => ({ sessionId: r.session_id }), isTargetCurrent: () => true,
    openTab(kind, options) { opened = { kind, options }; } };
  const rpc = { async call(_channel, endpoint, payload, signal) {
    if (endpoint.endsWith('navigation_ack')) { acks.push(payload.input); return { ok: true, value: { ok: true } }; }
    if (endpoint.endsWith('navigation_unsubscribe')) return { ok: true, value: { ok: true } };
    return new Promise((resolve, reject) => { pending = resolve; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  } };
  const navigation = new PanelNavigation(rpc, sidebar, { document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  const disconnect = navigation.connect(r.session_id);
  pending({ ok: true, value: { ok: true, data: r } });
  await tick();
  assert.equal(opened.kind, 'cfkanban');
  assert.equal(acks.length, 0);
  assert.equal(navigation.has(r.request_id, r.session_id), true);
  assert.equal(navigation.has(r.request_id, 'other-session'), false);
  assert.equal(navigation.claim(r.request_id, 'other-session'), null);
  const held = navigation.claim(r.request_id, r.session_id);
  assert.ok(held);
  assert.equal(navigation.has(r.request_id, r.session_id), true);
  assert.equal(navigation.claim(r.request_id, r.session_id), null);
  held.finish({ ok: true, target: r.target });
  await tick();
  assert.equal(acks.length, 1);
  assert.equal(navigation.has(r.request_id, r.session_id), false);
  assert.equal(new PanelNavigation(rpc, sidebar).has(r.request_id, r.session_id), false);
  assert.deepEqual(acks[0].result, { ok: true, target: r.target });
  disconnect(); await tick();
  assert.equal(navigation.requests.size, 0);
});

test('a header request for a background Session never opens the foreground sidebar', async () => {
  const r = request(); let opened = false; const acks = [];
  const navigation = new PanelNavigation({ async call(_c, _e, p) { acks.push(p.input); } }, {
    commandTarget: () => ({ sessionId: 'another-session' }), isTargetCurrent: () => true,
    openTab() { opened = true; },
  }, { document: { visibilityState: 'visible' } });
  await navigation.deliver(r, randomUUID(), new AbortController().signal);
  assert.equal(opened, false);
  assert.equal(acks[0].result.ok, false);
});

test('a late unsubscribe from a hidden client cannot cancel its resumed subscription or navigation', async t => {
  const r = request(), operator = {};
  const success = data => ({ ok: true, status: 200, data });
  const host = new HostNavigation({ bridge: {
    host: { singleUserLocal: true, hasWebServer: true, webHost: '127.0.0.1', operator },
    sessions: { workspaces: () => [{ id: 'fixture-workspace', sessionIds: [r.session_id] }] },
    async verifySession() {},
    async call() { return success({ principal: { principal_id: r.expected_principal_id } }); },
    async tool() { return success({}); },
  }, timeoutMs: 1500 });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let releaseUnsubscribe, opened;
  let delayUnsubscribe = true;
  const rpc = { async call(_channel, endpoint, payload, signal) {
    const name = endpoint.split('/').at(-1);
    if (name === 'navigation_unsubscribe' && delayUnsubscribe) {
      delayUnsubscribe = false;
      await new Promise(resolve => { releaseUnsubscribe = resolve; });
    }
    return { ok: true, value: await host.call(name, payload, signal, operator) };
  } };
  const navigation = new PanelNavigation(rpc, {
    commandTarget: () => ({ sessionId: r.session_id }), isTargetCurrent: () => true,
    openTab(_kind, options) { opened = options.params.navigation_request_id; },
  }, { document });
  const disconnect = navigation.connect(r.session_id);
  t.after(() => { disconnect(); releaseUnsubscribe?.(); host.dispose(); });
  await tick();
  const oldClientId = host.currentClient(r.session_id)[0];
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  const newClientId = host.currentClient(r.session_id)[0];
  assert.notEqual(newClientId, oldClientId);

  const opening = host.open(r.target, { agent: { session: { id: r.session_id } }, signal: new AbortController().signal });
  await tick();
  const held = navigation.claim(opened, r.session_id);
  assert.equal(held?.clientId, newClientId);
  releaseUnsubscribe();
  await tick();
  assert.equal(host.currentClient(r.session_id)[0], newClientId);
  assert.equal(host.pending.size, 1);
  held.finish({ ok: true, target: r.target });
  assert.deepEqual(await opening, { ok: true, opened: true, surface: 'sidebar', target: r.target });
});
