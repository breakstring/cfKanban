import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PanelBridge } from '../src/host/bridge.mjs';
import { PANEL_CHANNEL, PANEL_NAMESPACE, PANEL_PROTOCOL } from '../src/shared/panel.mjs';
import { PANEL_ENDPOINTS, registerPanelTransport } from '../src/host/transport.mjs';
import { PanelController, recoveryId, sessionReference } from '../src/client/controller.mjs';
import { OnlinePanelController } from '../src/client/online.mjs';
import { WorkbenchBridge } from '../../local-runtime/src/workbench/bridge.mjs';
import { WorkbenchController } from '../../local-runtime/src/workbench/controller.mjs';
import { STATUSES, validateCheckpoint } from '../../local-runtime/src/workbench/shared.mjs';
import { createMcpFacade } from '../../skill-runtime/src/mcp-facade.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';

const result = data => ({ ok: true, status: 200, data });
const clientEntry = fileURLToPath(new URL('../src/client/index.jsx', import.meta.url));

test('fixed JSON transport preserves correlation and cancellation, and refuses path/method/content drift', async () => {
  const routes = [];
  const peer = {};
  const calls = [];
  const effects = [];
  const protocol = {
    RpcId: value => value,
    clientRequestSchema: { safeParse: value => value?.type === 'client-request' && typeof value.rpcId === 'string' && typeof value.method === 'string' && Object.hasOwn(value, 'payload') ? { success: true, data: value } : { success: false } },
    serverResponseSchema: { parse: value => { assert.equal(value.type, 'server-response'); assert.equal(typeof value.rpcId, 'string'); assert.equal(typeof value.result.ok, 'boolean'); return value; } },
  };
  registerPanelTransport({ effect: factory => effects.push(factory()), connection: { operator: peer, fetch: { register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } } }, { call: async (...args) => { calls.push(args); return result({ fixture: true }); } }, protocol);
  assert.deepEqual(routes.map(route => route.path), PANEL_ENDPOINTS.map(endpoint => `${PANEL_CHANNEL}/${PANEL_NAMESPACE}/${endpoint}`));
  assert.ok(routes.every(route => route.methods.length === 1 && route.methods[0] === 'POST' && route.requestBody === 'buffered'));
  const route = routes.find(row => row.path.endsWith('/connections'));
  const envelope = { type: 'client-request', rpcId: 'correlator', method: `${PANEL_NAMESPACE}/connections`, payload: { protocol: PANEL_PROTOCOL, input: {} } };
  const abort = new AbortController();
  const request = (body = envelope, options = {}) => new Request(`http://127.0.0.1${route.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal, ...options });
  const response = await route.fetch(request());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'correlator', result: { ok: true, value: result({ fixture: true }) } });
  assert.equal(calls[0][0], 'connections');
  assert.equal(calls[0][3], peer);
  abort.abort();
  assert.equal(calls[0][2].aborted, true);
  const mismatch = await route.fetch(request({ ...envelope, method: 'mutate' }));
  assert.equal((await mismatch.json()).result.error.code, 'gateway/bad-request');
  assert.equal((await route.fetch(new Request('http://127.0.0.1/api/arbitrary', { method: 'POST' }))).status, 404);
  assert.equal((await route.fetch(request(envelope, { method: 'PUT' }))).status, 404);
  assert.equal((await route.fetch(request(envelope, { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await route.fetch(request(envelope, { body: '{invalid' }))).status, 400);
  assert.equal((await route.fetch(request({ ...envelope, payload: 'x'.repeat(1024 * 1024) }))).status, 413);
  const invalid = await route.fetch(request({ arbitrary: 'untrusted must not be echoed' }));
  assert.equal((await invalid.text()).includes('untrusted must not be echoed'), false);
  assert.equal(calls.length, 1);
  effects.reverse().forEach(dispose => dispose());
  assert.equal(routes.length, 0);
});

test('Controller uses the official single-segment /api channel and the complete namespaced endpoint', async () => {
  const routes = new Map();
  const candidate = { instance_id: randomUUID(), trusted_api_origin: 'https://isolated.fixture.invalid' };
  const protocol = { RpcId: value => value, clientRequestSchema: { safeParse: value => ({ success: true, data: value }) }, serverResponseSchema: { parse: value => value } };
  registerPanelTransport({ effect: factory => factory(), connection: { operator: {}, fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } } }, { call: async endpoint => { assert.equal(endpoint, 'connections'); return result({ candidates: [candidate] }); } }, protocol);
  const controller = new PanelController({ call: async (channel, endpoint, payload, signal) => {
    assert.equal(channel, '/api');
    assert.equal(endpoint, 'cfkanban-panel/connections');
    const path = `${channel}/${endpoint}`;
    const response = await routes.get(path).fetch(new Request(`http://127.0.0.1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'pair-correlator', method: endpoint, payload }), signal }));
    const envelope = await response.json();
    assert.equal(envelope.rpcId, 'pair-correlator');
    return envelope.result;
  } }, new AbortController().signal);
  await controller.bootstrap();
  assert.deepEqual(controller.state.candidates, [candidate]);
  assert.equal(controller.state.error, null);
  controller.dispose();
});

let adapterModule;
async function loadAdapter() {
  if (!adapterModule) {
    const output = await build({ entryPoints: [fileURLToPath(new URL('../src/client/embed-adapter.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser' });
    adapterModule = import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  }
  return adapterModule;
}
const fakePort = () => ({ messages: [], closed: false, start() {}, close() { this.closed = true; }, postMessage(value) { this.messages.push(structuredClone(value)); } });
const action = (name, payload = {}, id = randomUUID()) => ({ type: 'action', id, action: name, payload });

async function boundAdapter(f, options) {
  const { EmbedAdapter } = await loadAdapter();
  const controller = controllerFor(f);
  const binding = await f.call('bind', f.ids);
  controller.patch({ binding: binding.data });
  await controller.refresh();
  await controller.openIssue(f.issue.identifier);
  const navigated = [];
  const adapter = new EmbedAdapter(controller, f.workspaces[0].sessionIds[0], id => navigated.push(id), options);
  const port = fakePort();
  adapter.attach(port);
  return { controller, adapter, port, navigated };
}

test('thin native carrier keeps the original logo, owned opaque Document and official tab lifetime', async () => {
  const client = await build({ entryPoints: [clientEntry], bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'], loader: { '.png': 'dataurl', '.html': 'text' }, plugins: [{ name: 'isolated-document-fixture', setup(bundler) {
    bundler.onResolve({ filter: /dist-embedded\/embedded\.html$/ }, args => ({ path: args.path, namespace: 'fixture-document' }));
    bundler.onLoad({ filter: /.*/, namespace: 'fixture-document' }, () => ({ contents: '<!doctype html><title>Isolated Vue fixture</title>', loader: 'text' }));
  } }] });
  const states = [];
  const effects = [];
  let stateIndex = 0;
  let stateOverrides = new Map();
  const react = { useRef: () => ({ current: null }), useState: initializer => { const index = stateIndex++; const value = typeof initializer === 'function' ? initializer() : initializer; states.push(value); return [stateOverrides.has(index) ? stateOverrides.get(index) : value, () => {}]; }, useEffect: effect => effects.push(effect), createElement: (type, props, ...children) => ({ type, props, children }) };
  const module = { exports: {} };
  vm.runInNewContext(client.outputFiles[0].text, { module, exports: module.exports, require: () => react, AbortController, AbortSignal, TextEncoder });
  let locales;
  let nativeTab;
  module.exports.apply({ connection: { rpc: {} }, sidebarRight: {}, effect: factory => factory(), locale: { bind: () => key => key, register: (_ns, translations) => { locales = translations; return () => {}; } }, sidebarRightTabs: { register: tab => { nativeTab = tab; return () => {}; } }, slots: { inject: (_name, factory) => factory(), register: () => () => {} } });
  assert.equal(nativeTab.keepMounted, true);
  const logo = `data:image/png;base64,${(await readFile(new URL('../../../apps/web/src/assets/cfkanban-mark.png', import.meta.url))).toString('base64')}`;
  for (const language of ['en', 'zh']) {
    const t = key => locales[language][key];
    const button = module.exports.PanelButton({ open: () => {}, t });
    assert.equal(button.props['aria-label'], t('openTasks'));
    assert.equal(button.props.title, t('openTasks'));
    assert.equal(button.children[0].type, 'img');
    assert.equal(button.children[0].props.src, logo);
    assert.equal(button.children[0].props.alt, '');
  }
  const lifetime = new AbortController();
  const carrier = module.exports.PanelBody({ rpc: {}, navigate: () => {}, useTabInfo: () => ({ tab: { signal: lifetime.signal, actions: {} } }), sessionId: randomUUID(), t: key => locales.en[key] });
  assert.equal(carrier.type, 'section');
  const iframe = carrier.children.find(child => child?.type === 'iframe');
  assert.equal(iframe.props.sandbox, 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  assert.equal(iframe.props.src, undefined);
  assert.ok(iframe.props.srcDoc.startsWith('<!doctype html>'));
  assert.equal(iframe.props.referrerPolicy, 'no-referrer');
  assert.equal(iframe.props.sandbox.includes('allow-same-origin'), false);
  assert.equal(iframe.props.inert, '');
  assert.equal(carrier.children[0].children[0].props.disabled, false);
  assert.equal(carrier.children[0].children[0].props.title, locales.en.retryOnline);
  const snapshots = [
    { key: 'retryOnline', ready: false, active: false, running: false, pending_target: null, blocked: true },
    { key: 'openOnline', ready: true, active: false, running: false, pending_target: null, blocked: false },
    { key: 'recoverOnline', ready: true, active: false, running: false, pending_target: { binding_id: randomUUID() }, blocked: true },
    { key: 'recoverOnline', ready: true, active: true, running: true, pending_target: { binding_id: randomUUID() }, blocked: true },
  ];
  const iconPaths = new Map();
  for (const language of ['en', 'zh']) for (const snapshot of snapshots) {
    stateIndex = 0;
    stateOverrides = new Map([[5, snapshot], [6, true]]);
    const view = module.exports.PanelBody({ rpc: {}, useTabInfo: () => ({ tab: { signal: lifetime.signal, actions: {} } }), sessionId: randomUUID(), t: key => locales[language][key] });
    const onlineButton = view.children[0].children[0];
    assert.equal(onlineButton.props.title, locales[language][snapshot.key]);
    assert.equal(onlineButton.props['aria-label'], locales[language][snapshot.key]);
    assert.equal(onlineButton.props.disabled, snapshot.active || snapshot.running);
    assert.equal(onlineButton.props.style.width, 32);
    assert.equal(onlineButton.children.length, 1);
    const icon = onlineButton.children[0];
    assert.equal(icon.type, 'svg');
    assert.equal(icon.props['aria-hidden'], 'true');
    assert.equal(icon.props.focusable, 'false');
    iconPaths.set(snapshot.key, icon.children[0].props.d);
    assert.equal(view.children.find(child => child?.type === 'iframe').props.inert, snapshot.blocked ? '' : undefined);
  }
  assert.notEqual(iconPaths.get('openOnline'), iconPaths.get('recoverOnline'));
  states.filter(value => value?.dispose).forEach(value => value.dispose());
});

test('projection exposes business evidence and recovery references but no secret, original key or private binding', async () => {
  const f = fixture();
  const { projectSnapshot } = await loadAdapter();
  const { controller, adapter } = await boundAdapter(f);
  const key = randomUUID();
  controller.patch({
    binding: { ...controller.state.binding, secret: 'MUST_NOT_DISPLAY', binding_id: 'MUST_NOT_DISPLAY', identity: { instance: { instance_id: f.ids.instance_id, trusted_api_origin: 'https://fixture.invalid', token: 'MUST_NOT_DISPLAY' }, principal: { id: f.ids.expected_principal_id, display_name: 'Fixture', grants: 'MUST_NOT_DISPLAY' } } },
    pending: { identifier: f.issue.identifier, expected_version: 1, operation: 'comment', idempotency_key: key, change: { body: 'MUST_NOT_DISPLAY' } },
    comments: [{ id: randomUUID(), kind: 'completion', body: 'Actual summary', completion: { summary: 'Actual summary', verification: ['CAS checked'], artifacts: [{ kind: 'path', value: '/fixture/report.txt', credential: 'MUST_NOT_DISPLAY' }], follow_ups: ['Manual release remains'], cookie: 'MUST_NOT_DISPLAY' } }],
    scope_targets: [{ ...scopeTarget(f), display_name: 'Development', available: true }],
    error: { code: 'UNTRUSTED_MUST_NOT_DISPLAY', message: 'MUST_NOT_DISPLAY', details: { token: 'MUST_NOT_DISPLAY' } },
  });
  const original = structuredClone(controller.state);
  const projected = projectSnapshot(controller.state, f.workspaces[0].sessionIds[0]);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /MUST_NOT_DISPLAY|binding_id|preview_id|dsh_workspace_id|idempotency_key|request_id|grants|credential|cookie/);
  assert.equal(serialized.includes(key), false);
  assert.deepEqual(projected.pending, { identifier: 'CFK-1', expected_version: 1, operation: 'comment' });
  assert.deepEqual(projected.comments[0].completion, { summary: 'Actual summary', verification: ['CAS checked'], artifacts: [{ kind: 'path', value: '/fixture/report.txt' }], follow_ups: ['Manual release remains'] });
  assert.equal(projected.scope_targets[0].display_name, 'Development');
  assert.equal(projected.error.code, 'PANEL_REQUEST_UNCERTAIN');
  assert.equal(projected.capabilities.comment, true);
  assert.deepEqual(controller.state, original);
  adapter.dispose(); controller.dispose();
});

test('only the owned initial Document receives one port; navigation and tab disposal stop all further messages', async () => {
  const f = fixture();
  const { controller, adapter } = await boundAdapter(f);
  const transfers = [];
  const parent = fakePort();
  const child = fakePort();
  const frame = { contentWindow: { postMessage: (...args) => transfers.push(args) } };
  assert.equal(adapter.frameLoaded(frame, 'zh-CN', () => ({ port1: parent, port2: child })), true);
  assert.equal(transfers.length, 1);
  assert.deepEqual(transfers[0], [{ type: 'cfkanban.embed.connect', protocol: 1, locale: 'zh-CN' }, '*', [child]]);
  assert.equal(Object.hasOwn(transfers[0][0], 'state'), false);
  assert.equal(parent.messages[0].type, 'snapshot');
  adapter.setLocale('en');
  assert.equal(parent.messages.at(-1).state.locale, 'en');
  assert.equal(adapter.frameLoaded(frame, 'en', () => { throw new Error('Must not make another channel'); }), false);
  assert.equal(transfers.length, 1);
  assert.equal(parent.closed, true);
  assert.equal(controller.state.error.code, 'PANEL_FRAME_RELOADED');
  const before = f.calls.length;
  await adapter.receive(action('mutate', { operation: 'comment', change: { body: 'Cannot execute after navigation' } }));
  assert.equal(f.calls.length, before);
  controller.dispose();
  assert.equal(controller.listeners.size, 0);
});

test('invalid, oversized and injected action fields cannot reach the Controller or Host', async () => {
  const f = fixture();
  const { controller, adapter, port } = await boundAdapter(f);
  const before = f.calls.length;
  const invalid = [action('arbitrary_endpoint'), action('mutate', { operation: 'comment', change: { body: 'x'.repeat(65536) } }), action('mutate', { operation: 'comment', change: { body: 'valid' }, idempotency_key: randomUUID() }), action('handoff', { target: 'new', workspace_id: f.workspaces[0].id, source_session_id: randomUUID() }), action('bind', { project_id: randomUUID(), binding_id: randomUUID() })];
  for (const message of invalid) { await adapter.receive(message); assert.equal(port.messages.at(-1).result.error.code, 'PANEL_INVALID_INPUT'); assert.equal(port.messages.at(-1).id, message.id); }
  assert.equal(f.calls.length, before);
  assert.equal(f.prompts.length, 0);
  assert.equal(controller.state.pending, null);
  for (let i = 0; i < 30; i++) await adapter.receive(action('unknown_from_untrusted_frame'));
  assert.equal(port.messages.at(-1).result.error.code, 'RATE_LIMITED');
  assert.equal(f.calls.length, before);
  adapter.dispose(); controller.dispose();
});

test('same embedded action ID is singleflight, rejects payload reuse and cannot append another Comment on replay', async () => {
  const f = fixture();
  const { controller, adapter } = await boundAdapter(f);
  let release;
  const factory = f.bridge.createFacade;
  f.bridge.createFacade = config => { const facade = factory(config); return { callTool: async (...args) => { if (args[0] === 'cfkanban_comments_create') await new Promise(resolve => { release = resolve; }); return facade.callTool(...args); } }; };
  const original = action('mutate', { operation: 'comment', change: { body: 'Append exactly once' } });
  const first = adapter.receive(original);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(release);
  assert.equal((await adapter.receive(original)).error.code, 'PANEL_OPERATION_PENDING');
  assert.equal((await adapter.receive({ ...original, payload: { operation: 'comment', change: { body: 'Changed payload' } } })).error.code, 'PANEL_KEY_REUSED');
  release();
  assert.equal((await first).ok, true);
  assert.equal((await adapter.receive(original)).ok, true);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_comments_create').length, 1);
  assert.equal(controller.state.pending, null);
  adapter.dispose(); controller.dispose();
});

test('write recovery uses the retained parent key and binding; iframe cannot choose a new one or change Session', async () => {
  const f = fixture({ uncertain: true });
  const { controller, adapter } = await boundAdapter(f);
  await adapter.receive(action('mutate', { operation: 'update', change: { priority_key: 'high' } }));
  const pending = structuredClone(controller.state.pending);
  assert.ok(pending.idempotency_key);
  assert.equal((await adapter.receive(action('unbind'))).error.code, 'PANEL_INVALID_INPUT');
  controller.sessionContext(randomUUID());
  assert.deepEqual(controller.state.pending, pending);
  assert.equal((await adapter.receive(action('recover'))).ok, true);
  const writes = f.calls.filter(row => row.name === 'cfkanban_issues_update');
  assert.equal(writes.length, 2);
  assert.ok(writes.every(row => row.args.idempotency_key === pending.idempotency_key));
  assert.equal(controller.state.pending, null);
  adapter.dispose(); controller.dispose();
});

test('a stalled carrier times out without discarding the original write and then permits explicit same-key recovery', async () => {
  const f = fixture();
  const { EmbedAdapter } = await loadAdapter();
  const endpoints = [];
  let stall = true;
  let lateResolve;
  const controller = new PanelController({ call: async (_channel, method, payload, signal) => {
    const endpoint = method.split('/').at(-1);
    endpoints.push({ endpoint, input: structuredClone(payload.input), signal });
    if (stall && endpoint === 'mutate') return new Promise(resolve => { lateResolve = resolve; });
    return { ok: true, value: await f.call(endpoint, payload.input) };
  } }, new AbortController().signal, randomUUID, { requestTimeoutMs: 10 });
  controller.patch({ binding: (await f.call('bind', f.ids)).data, issue: f.issue });
  const adapter = new EmbedAdapter(controller, f.workspaces[0].sessionIds[0], () => {});
  const alive = setTimeout(() => {}, 1000);
  const uncertain = await adapter.receive(action('mutate', { operation: 'update', change: { priority_key: 'high' } }));
  clearTimeout(alive);
  assert.equal(uncertain.outcome_unknown, true);
  assert.equal(adapter.running, false);
  assert.equal(controller.state.busy, 0);
  const original = structuredClone(controller.state.pending);
  assert.ok(original.idempotency_key);
  assert.equal(endpoints[0].signal.aborted, true);
  stall = false;
  await adapter.receive(action('recover'));
  assert.deepEqual(endpoints.find(row => row.endpoint === 'recover').input, original);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
  assert.deepEqual(controller.state.pending, original);
  controller.patch({ issue: { ...f.issue, version: 7 } });
  lateResolve({ ok: true, value: { ...result({}), panel: { readback: { ...f.issue, version: 2 } } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.state.issue.version, 7);
  assert.deepEqual(controller.state.pending, original);
  adapter.dispose(); controller.dispose();
});

test('recovery refusal cannot clear an uncertain write without evidence that the original operation settled', async () => {
  for (const code of ['PANEL_BINDING_EXPIRED', 'MCP_PRINCIPAL_BINDING_MISMATCH', 'CAPABILITY_DENIED']) {
    const c = new PanelController({ call: async () => ({ ok: true, value: { ok: false, status: 403, error: { code } } }) }, new AbortController().signal);
    const write = { binding_id: randomUUID(), identifier: 'CFK-1', expected_version: 1, operation: 'comment', change: { body: 'Original append' }, idempotency_key: randomUUID() };
    c.patch({ pending: write });
    await c.mutate(null, null, true);
    assert.deepEqual(c.state.pending, write);
    assert.equal(c.canChangeBinding(), false);
    c.dispose();
  }
});

test('permission loss during recovery remains uncertain; a cached definite original failure settles without another write', async () => {
  const f = fixture({ uncertain: true });
  const c = controllerFor(f);
  c.patch({ binding: (await f.call('bind', f.ids)).data, issue: f.issue });
  await c.mutate('update', { priority_key: 'high' });
  const original = structuredClone(c.state.pending);
  const factory = f.bridge.createFacade;
  f.bridge.createFacade = config => { const facade = factory(config); return { callTool: async (name, ...args) => name === 'cfkanban_issues_update' ? { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED' } } : facade.callTool(name, ...args) }; };
  await c.mutate(null, null, true);
  assert.deepEqual(c.state.pending, original);
  const ledger = f.bridge.bindings.get(original.binding_id).operations.get(original.idempotency_key);
  assert.equal(ledger.settled, false);
  assert.equal(ledger.result.panel.original_settled, false);
  f.bridge.createFacade = factory;
  await c.mutate(null, null, true);
  assert.equal(c.state.pending, null);
  c.dispose();

  const definite = fixture();
  const definiteFactory = definite.bridge.createFacade;
  let writes = 0;
  definite.bridge.createFacade = config => { const facade = definiteFactory(config); return { callTool: async (name, ...args) => { if (name === 'cfkanban_issues_update') { writes++; return { ok: false, status: 409, error: { code: 'VERSION_CONFLICT' } }; } return facade.callTool(name, ...args); } }; };
  let loseResponse = true;
  const recovered = new PanelController({ call: async (_channel, method, payload) => {
    const endpoint = method.split('/').at(-1);
    const value = await definite.call(endpoint, payload.input);
    if (endpoint === 'mutate' && loseResponse) { loseResponse = false; throw new Error('Fixture lost definite response'); }
    return { ok: true, value };
  } }, new AbortController().signal);
  recovered.patch({ binding: (await definite.call('bind', definite.ids)).data, issue: definite.issue });
  await recovered.mutate('update', { priority_key: 'high' });
  assert.ok(recovered.state.pending);
  await recovered.mutate(null, null, true);
  assert.equal(recovered.state.pending, null);
  assert.equal(recovered.state.error.code, 'VERSION_CONFLICT');
  assert.equal(writes, 1);
  recovered.dispose();
});

test('a committed Comment stays successful when subsequent list refresh fails and the original message cannot append it again', async () => {
  const f = fixture();
  const { controller, adapter } = await boundAdapter(f);
  const factory = f.bridge.createFacade;
  f.bridge.createFacade = config => { const facade = factory(config); return { callTool: async (name, ...args) => name === 'cfkanban_issues_list' ? { ok: false, status: 503, error: { code: 'PLATFORM_UNAVAILABLE' } } : facade.callTool(name, ...args) }; };
  const message = action('mutate', { operation: 'comment', change: { body: 'Committed Comment' } });
  assert.equal((await adapter.receive(message)).ok, true);
  assert.equal(controller.state.pending, null);
  assert.equal(controller.state.error.code, 'PLATFORM_UNAVAILABLE');
  assert.equal((await adapter.receive(message)).ok, true);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_comments_create').length, 1);
  adapter.dispose(); controller.dispose();
});

test('scope selection and pagination resolve only current recommended targets and parent continuation', async () => {
  const f = fixture();
  const { controller, adapter } = await boundAdapter(f);
  const scope = scopeTarget(f);
  controller.patch({ binding: null, scope_mode: 'suggested', scope_targets: [{ ...scope, display_name: 'Development', available: true }, { ...scope, project_id: randomUUID(), available: false }], scope_next_offset: 8 });
  const calls = [];
  controller.bindScope = target => calls.push(['bind', structuredClone(target)]);
  controller.loadScopeTargets = offset => calls.push(['page', offset]);
  assert.equal((await adapter.receive(action('scope_bind', { target_id: 'invented' }))).error.code, 'PANEL_INVALID_INPUT');
  assert.equal((await adapter.receive(action('scope_bind', { target_id: controller.state.scope_targets[1].instance_id + '/' + scope.workspace_id + '/' + controller.state.scope_targets[1].project_id }))).error.code, 'PANEL_INVALID_INPUT');
  const { scopeTargetId } = await loadAdapter();
  assert.equal((await adapter.receive(action('scope_bind', { target_id: scopeTargetId(scope) }))).ok, true);
  assert.equal((await adapter.receive(action('scope_page', { next: true }))).ok, true);
  assert.deepEqual(calls, [['bind', { ...scope, display_name: 'Development', available: true }], ['page', 8]]);
  adapter.dispose(); controller.dispose();
});

test('malformed Host arrays and excessive business data produce a fixed visible snapshot error', async () => {
  const f = fixture();
  const { controller, adapter, port } = await boundAdapter(f);
  controller.patch({ comments: [{ id: randomUUID(), completion: { summary: 'Summary', artifacts: {} } }], scope_targets: null });
  assert.equal(port.messages.at(-1).type, 'snapshot');
  assert.deepEqual(port.messages.at(-1).state.comments[0].completion.artifacts, []);
  controller.patch({ issue: { ...controller.state.issue, body: 'x'.repeat(300000) } });
  assert.equal(port.messages.at(-1).type, 'snapshot');
  assert.equal(port.messages.at(-1).state.error.code, 'PANEL_CONTEXT_TOO_LARGE');
  assert.equal(port.messages.at(-1).state.capabilities.update, false);
  adapter.dispose(); controller.dispose();
});

test('rate and receipt limits are bounded while retained write receipts survive ordinary read eviction', async () => {
  const f = fixture();
  let time = 0;
  const { controller, adapter } = await boundAdapter(f, { receiptLimit: 2, now: () => time });
  const write = action('mutate', { operation: 'comment', change: { body: 'Retain original write receipt' } });
  assert.equal((await adapter.receive(write)).ok, true);
  for (let i = 0; i < 29; i++) assert.equal((await adapter.receive(action('page', { next: false }))).ok, true);
  assert.equal((await adapter.receive(action('page', { next: false }))).error.code, 'RATE_LIMITED');
  time = 10_000;
  assert.equal((await adapter.receive(write)).ok, true);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_comments_create').length, 1);
  adapter.dispose(); controller.dispose();
});

function fixture(options = {}) {
  const ids = { instance_id: randomUUID(), expected_principal_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() };
  const peer = {};
  let issue = { id: randomUUID(), identifier: 'CFK-1', title: 'Fixture', body: 'untrusted <script>alert(1)</script>', version: 1, project: { id: ids.project_id }, workspace: { id: ids.workspace_id }, status: { key: 'todo', display_name: 'Todo' }, priority: 'none', allowed_actions: options.reader ? ['read'] : ['read', 'update'], comments: [] };
  const calls = [];
  const workspaces = [{ id: randomUUID(), path: '/isolated-fixture', title: 'Fixture', sessionIds: [randomUUID()] }];
  const prompts = [];
  const creates = [];
  let pending = options.uncertain;
  const createFacade = config => ({ callTool: async (name, args) => {
    calls.push({ name, args, config });
    if (name === 'cfkanban_connection_inspect') return result({ instance: { instance_id: ids.instance_id, trusted_api_origin: 'https://isolated.fixture.invalid' }, principal: { id: ids.expected_principal_id, principal_id: ids.expected_principal_id, display_name: 'Fixture', grants: [{ workspace_id: ids.workspace_id, project_id: ids.project_id, role: options.reader ? 'reader' : 'writer' }] } });
    if (name === 'cfkanban_projects_get') return result({ id: ids.project_id, display_name: 'Project' });
    if (name === 'cfkanban_statuses_list') return result({ items: [{ key: 'todo', display_name: 'Todo' }] });
    if (name === 'cfkanban_issues_get') return result(structuredClone(issue));
    if (name === 'cfkanban_issues_list') return result({ items: [structuredClone(issue)], next_cursor: 'next-fixture', resolved_scope: { projects: [ids.project_id] } });
    if (name === 'cfkanban_issues_update') {
      if (pending) { pending = false; return { ok: false, status: 0, outcome_unknown: true, error: { code: 'NETWORK_ERROR' } }; }
      issue = { ...issue, version: issue.version + 1, priority: args.changes.priority_key ?? issue.priority };
      return result({ resource: structuredClone(issue) });
    }
    if (name === 'cfkanban_comments_create' || name === 'cfkanban_issues_complete') return result({ resource: structuredClone(issue) });
    return result({ items: [] });
  } });
  const bridge = new PanelBridge({ createFacade, ...(options.openOnline ? { openOnline: options.openOnline } : {}), host: { singleUserLocal: true, hasWebServer: true, webHost: '127.0.0.1', operator: peer }, dsh: {
    workspaces: () => workspaces, workspace: id => workspaces.find(row => row.id === id),
    inspect: async () => ({ meta: { cwd: '/isolated-fixture' } }),
  } });
  const call = (endpoint, input, overridePeer = peer) => bridge.call(endpoint, { protocol: PANEL_PROTOCOL, input }, new AbortController().signal, overridePeer);
  const bind = async () => (await call('bind', ids)).data.binding_id;
  return { ids, peer, calls, workspaces, prompts, creates, bridge, call, bind, get issue() { return issue; }, set issue(value) { issue = value; } };
}

const controllerFor = (f, endpoints = []) => new PanelController({ call: async (_channel, endpoint, payload) => { const logical = endpoint.split('/').at(-1); endpoints.push({ endpoint: logical, input: structuredClone(payload.input) }); return { ok: true, value: await f.call(logical, payload.input) }; } }, new AbortController().signal);
const scopeTarget = f => ({ instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id });

test('DSH online routes keep the original target/key, expose no ticket and lock mutations across native tabs', async () => {
  const deliveries = [];
  const f = fixture({ openOnline: async input => {
    await input.bridge.verifiedTarget(input.bindingId, input.signal, input.identifier);
    deliveries.push({ bindingId: input.bindingId, identifier: input.identifier, key: input.idempotencyKey });
    return deliveries.length === 1 ? { ok: false, outcome_unknown: true, error: { code: 'PLATFORM_UNAVAILABLE', message: 'must-not-expose-ticket', details: { token: 'must-not-expose-ticket' } } } : { ok: true, delivery: { delivered: true, url: 'must-not-expose-ticket' } };
  } });
  const binding_id = await f.bind();
  const anotherBinding = await f.bind();
  const receipt_id = randomUUID();
  const selected = { binding_id, identifier: 'CFK-1', receipt_id, recover: false };
  assert.equal((await f.call('open_online', selected, {})).error.code, 'PANEL_LOCAL_HOST_REQUIRED');
  assert.equal((await f.call('open_online', { ...selected, url: 'https://arbitrary.invalid' })).error.code, 'PANEL_INVALID_INPUT');
  assert.equal(deliveries.length, 0);
  const unknown = await f.call('open_online', selected);
  assert.equal(unknown.outcome_unknown, true);
  assert.equal(f.bridge.hasPending(), true);
  assert.equal(unknown.online.receipt_id, receipt_id);
  assert.doesNotMatch(JSON.stringify(unknown), /must-not-expose-ticket|idempotencyKey|token/);
  const before = f.calls.length;
  for (const [endpoint, input] of [['bind', f.ids], ['unbind', { binding_id }], ['identity', { instance_id: f.ids.instance_id }], ['mutate', { binding_id, identifier: 'CFK-1', expected_version: 1, operation: 'comment', change: { body: 'Do not send' }, idempotency_key: randomUUID() }], ['detail', { binding_id: anotherBinding, identifier: 'CFK-1' }]]) assert.equal((await f.call(endpoint, input)).error.code, 'PANEL_ONLINE_PENDING');
  assert.equal(f.calls.length, before);
  assert.equal((await f.call('detail', { binding_id, identifier: 'CFK-1' })).ok, true);
  assert.equal((await f.call('ack_online', { binding_id, identifier: 'CFK-1', receipt_id })).ok, false);
  assert.equal((await f.call('open_online', { ...selected, receipt_id: randomUUID(), recover: true })).ok, false);
  assert.equal(deliveries.length, 1);
  const recovered = await f.call('open_online', { ...selected, recover: true });
  assert.equal(recovered.ok, true);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].key, deliveries[1].key);
  assert.equal(deliveries[0].bindingId, deliveries[1].bindingId);
  assert.equal((await f.call('ack_online', { binding_id, identifier: 'CFK-1', receipt_id })).ok, true);
  assert.equal(f.bridge.hasPending(), false);
  f.bridge.dispose();
});

test('a reopened DSH view recovers known delivery whose reply was lost and confirms without a second launch', async () => {
  let deliveries = 0;
  const f = fixture({ openOnline: async input => { await input.bridge.verifiedTarget(input.bindingId, input.signal, input.identifier); deliveries++; return { ok: true, delivery: { delivered: true } }; } });
  const binding = (await f.call('bind', f.ids)).data;
  let drop = true;
  const rpc = { call: async (_channel, endpoint, payload, signal) => {
    const logical = endpoint.split('/').at(-1);
    const value = await f.bridge.call(logical, payload, signal, f.peer);
    if (logical === 'open_online' && drop) { drop = false; throw new Error('lost reply'); }
    return { ok: true, value };
  } };
  const first = new PanelController(rpc, new AbortController().signal);
  first.patch({ binding, issue: f.issue });
  const original = new OnlinePanelController(first);
  await original.initialize();
  assert.equal((await original.open()).outcome_unknown, true);
  const held = original.getSnapshot();
  assert.equal(original.blocked, true);
  original.dispose(); first.dispose();
  const resumedController = new PanelController(rpc, new AbortController().signal);
  const resumed = new OnlinePanelController(resumedController);
  await resumed.initialize();
  assert.equal(resumed.getSnapshot().receipt_id, held.receipt_id);
  assert.deepEqual(resumed.getSnapshot().pending_target, held.pending_target);
  const before = f.calls.length;
  assert.equal((await resumed.open()).ok, true);
  assert.ok(f.calls.slice(before).some(row => row.name === 'cfkanban_issues_get'));
  assert.equal(deliveries, 1);
  assert.equal(resumed.blocked, false);
  assert.equal(f.bridge.hasPending(), false);
  resumed.dispose(); resumedController.dispose(); f.bridge.dispose();
});

test('a lost online acknowledgement reply preserves known success and checks state without launching again', async () => {
  let deliveries = 0;
  let confirmations = 0;
  const f = fixture({ openOnline: async () => { deliveries++; return { ok: true, delivery: { delivered: true } }; } });
  const binding = (await f.call('bind', f.ids)).data;
  const controller = new PanelController({ call: async (_channel, endpoint, payload, signal) => {
    const logical = endpoint.split('/').at(-1);
    const value = await f.bridge.call(logical, payload, signal, f.peer);
    if (logical === 'ack_online') { confirmations++; throw new Error('lost acknowledgement'); }
    return { ok: true, value };
  } }, new AbortController().signal);
  controller.patch({ binding });
  const online = new OnlinePanelController(controller);
  await online.initialize();
  assert.equal((await online.open()).ok, true);
  assert.equal(online.getSnapshot().phase, 'delivered');
  assert.equal(online.blocked, true);
  assert.equal((await online.open()).ok, true);
  assert.equal(online.blocked, false);
  assert.equal(deliveries, 1);
  assert.equal(confirmations, 1);
  online.dispose(); controller.dispose(); f.bridge.dispose();
});

test('unknown DSH delivery cannot become a new launch after the original Host receipt disappears', async () => {
  let deliveries = 0;
  const f = fixture({ openOnline: async () => { deliveries++; return { ok: false, outcome_unknown: true, error: { code: 'PLATFORM_UNAVAILABLE' } }; } });
  const controller = controllerFor(f);
  controller.patch({ binding: (await f.call('bind', f.ids)).data });
  const online = new OnlinePanelController(controller);
  await online.initialize(); await online.open();
  const original = online.getSnapshot();
  const rpc = controller.rpc.call;
  controller.rpc.call = async (endpoint, payload, signal) => endpoint === 'online_state' ? { ok: true, value: result({ running: false, pending_target: null, receipt_id: null }) } : rpc(endpoint, payload, signal);
  assert.equal((await online.open()).outcome_unknown, true);
  assert.equal(online.getSnapshot().error, 'PANEL_ONLINE_RECOVERY_UNAVAILABLE');
  assert.equal(online.getSnapshot().receipt_id, original.receipt_id);
  assert.deepEqual(online.getSnapshot().pending_target, original.pending_target);
  assert.equal(deliveries, 1);
  online.dispose(); controller.dispose(); f.bridge.dispose();
});

test('old native Tab acknowledgements and recovery IDs cannot release a newer online generation', async () => {
  let deliveries = 0;
  const f = fixture({ openOnline: async () => { deliveries++; return { ok: true, delivery: { delivered: true } }; } });
  const binding_id = await f.bind();
  const first = { binding_id, receipt_id: randomUUID(), recover: false };
  assert.equal((await f.call('open_online', first)).ok, true);
  assert.equal((await f.call('ack_online', { binding_id, receipt_id: first.receipt_id })).ok, true);
  const second = { binding_id, receipt_id: randomUUID(), recover: false };
  assert.equal((await f.call('open_online', second)).ok, true);
  assert.equal((await f.call('ack_online', { binding_id, receipt_id: first.receipt_id })).ok, false);
  assert.equal((await f.call('open_online', { ...first, recover: true })).ok, false);
  assert.equal((await f.call('online_state', {})).data.receipt_id, second.receipt_id);
  assert.equal(deliveries, 2);
  f.bridge.dispose();
});

test('DSH blocks online launch throughout business write and binding preflight, before their first await completes', async () => {
  for (const operation of ['mutate', 'bind']) {
    let deliveries = 0;
    const f = fixture({ uncertain: true, openOnline: async () => { deliveries++; return { ok: true, delivery: { delivered: true } }; } });
    const binding_id = await f.bind();
    const facadeFactory = f.bridge.createFacade;
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    f.bridge.createFacade = config => {
      const facade = facadeFactory(config);
      return { async callTool(name, args, options) {
        if (name === (operation === 'mutate' ? 'cfkanban_issues_get' : 'cfkanban_projects_get')) await paused;
        return facade.callTool(name, args, options);
      } };
    };
    const pending = f.call(operation, operation === 'bind' ? f.ids : { binding_id, identifier: 'CFK-1', expected_version: 1, operation: 'update', change: { priority_key: 'high' }, idempotency_key: randomUUID() });
    assert.ok(f.bridge.activeBusiness);
    const launch = await f.call('open_online', { binding_id, receipt_id: randomUUID(), recover: false });
    assert.equal(launch.ok, false);
    assert.equal(launch.error.code, 'PANEL_OPERATION_PENDING');
    assert.equal(launch.online.pending_target, null);
    assert.equal(deliveries, 0);
    release(); await pending;
    assert.equal(f.bridge.activeBusiness, 0);
    f.bridge.dispose();
  }
});

test('an online carrier deadline retains its generation, ignores late replies and keeps the Host receipt after Tab cancellation', async () => {
  let deliveries = 0;
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const f = fixture({ openOnline: async () => { deliveries++; return { ok: true, delivery: { delivered: true } }; } });
  const binding = (await f.call('bind', f.ids)).data;
  const lifetime = new AbortController();
  let calls = 0;
  const controller = new PanelController({ call: async (_channel, endpoint, payload, signal) => {
    calls++;
    const logical = endpoint.split('/').at(-1);
    const value = await f.bridge.call(logical, payload, signal, f.peer);
    if (logical === 'open_online') await delayed;
    return { ok: true, value };
  } }, lifetime.signal, undefined, { requestTimeoutMs: 10 });
  controller.patch({ binding });
  const online = new OnlinePanelController(controller);
  await online.initialize();
  // AbortSignal.timeout 不保持事件循环存活，测试需要等到该截止时间触发。
  const alive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await online.open()).outcome_unknown, true);
  } finally {
    clearTimeout(alive);
  }
  const original = online.getSnapshot();
  assert.equal(original.active, false);
  assert.equal(online.blocked, true);
  assert.equal(deliveries, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(online.getSnapshot(), original);
  assert.equal(f.bridge.hasPending(), true);
  lifetime.abort();
  assert.equal(controller.onlineListeners.size, 0);
  const before = calls;
  await online.open();
  assert.equal(calls, before);
  assert.equal(f.bridge.hasPending(), true);
  online.dispose(); controller.dispose(); f.bridge.dispose();
});

test('a competing native view adopts only the existing Host receipt when its fresh launch is refused', async () => {
  let deliveries = 0;
  const f = fixture({ openOnline: async () => { deliveries++; return { ok: false, outcome_unknown: true, error: { code: 'PLATFORM_UNAVAILABLE' } }; } });
  const binding = (await f.call('bind', f.ids)).data;
  const controller = controllerFor(f);
  controller.patch({ binding });
  const online = new OnlinePanelController(controller);
  await online.initialize();
  const originalReceipt = randomUUID();
  await f.call('open_online', { binding_id: binding.binding_id, receipt_id: originalReceipt, recover: false });
  assert.equal((await online.open()).outcome_unknown, true);
  assert.equal(online.getSnapshot().receipt_id, originalReceipt);
  assert.equal(online.blocked, true);
  assert.equal(deliveries, 1);
  online.dispose(); controller.dispose(); f.bridge.dispose();
});

test('a fresh online generation cannot extend an expired binding, while its existing original receipt keeps recovery scope', async () => {
  let deliveries = 0;
  const f = fixture({ openOnline: async input => { await input.bridge.verifiedTarget(input.bindingId, input.signal); deliveries++; return { ok: false, outcome_unknown: true, error: { code: 'PLATFORM_UNAVAILABLE' } }; } });
  const binding_id = await f.bind();
  const selected = { binding_id, receipt_id: randomUUID(), recover: false };
  f.bridge.now = () => Date.now() + 9 * 60 * 60 * 1000;
  assert.equal((await f.call('open_online', selected)).error.code, 'PANEL_BINDING_EXPIRED');
  assert.equal(deliveries, 0);
  assert.equal(f.bridge.hasPending(), false);
  f.bridge.now = Date.now;
  assert.equal((await f.call('open_online', selected)).outcome_unknown, true);
  f.bridge.now = () => Date.now() + 9 * 60 * 60 * 1000;
  assert.equal((await f.call('open_online', { ...selected, recover: true })).outcome_unknown, true);
  assert.equal(deliveries, 2);
  f.bridge.dispose();
});

test('Workspace scope comes only from an inspected registry Session and rejects Client paths or invented targets', async () => {
  const f = fixture();
  const session_id = `session-${randomUUID()}`;
  f.workspaces[0].sessionIds[0] = session_id;
  const reads = [];
  f.bridge.scopeReader = async (...args) => { reads.push(args); return { status: 'configured', code: 'SCOPE_CONFIGURED', targets: [scopeTarget(f)] }; };
  assert.equal((await f.call('session_scope', { session_id, workspacePath: '/client-forged' })).error.code, 'PANEL_INVALID_INPUT');
  assert.equal((await f.call('session_scope', { session_id: randomUUID() })).error.code, 'PANEL_SESSION_UNAVAILABLE');
  assert.equal(reads.length, 0);
  const scope = await f.call('session_scope', { session_id });
  assert.equal(scope.ok, true);
  assert.deepEqual(reads[0][0], { workspacePath: f.workspaces[0].path });
  assert.ok(reads[0][1].signal instanceof AbortSignal);
  assert.equal(JSON.stringify(scope).includes(f.workspaces[0].path), false);
  assert.equal((await f.call('bind_scope', { session_id, target: { ...scopeTarget(f), project_id: randomUUID() } })).error.code, 'PANEL_SCOPE_TARGET_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
  f.bridge.sessions.inspect = async () => ({ meta: { cwd: '/different-fixture' } });
  assert.equal((await f.call('session_scope', { session_id })).error.code, 'PANEL_WORKSPACE_CHANGED');
  assert.equal(reads.length, 2);
});

test('scope target names are fetched only for a bounded recommended page and failures never imply bind access', async () => {
  const f = fixture();
  const targets = Array.from({ length: 19 }, () => ({ instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() }));
  f.bridge.scopeReader = async () => ({ status: 'configured', code: 'SCOPE_CONFIGURED', targets });
  const facadeFactory = f.bridge.createFacade;
  f.bridge.createFacade = config => {
    const facade = facadeFactory(config);
    return { callTool: async (name, args, options) => {
      const value = await facade.callTool(name, args, options);
      if (name === 'cfkanban_projects_get') return args.project_id === targets[1].project_id ? { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED' } } : result({ id: args.project_id, display_name: `Project ${targets.findIndex(target => target.project_id === args.project_id)}` });
      return value;
    } };
  };
  const input = { session_id: f.workspaces[0].sessionIds[0] };
  const page = await f.call('scope_targets', input);
  assert.equal(page.data.items.length, 8);
  assert.equal(page.data.next_offset, 8);
  assert.equal(page.data.items[0].display_name, 'Project 0');
  assert.equal(page.data.items[1].available, false);
  assert.equal(page.data.items[1].unavailability, 'PANEL_SCOPE_PERMISSION_DENIED');
  assert.equal(page.data.items[1].display_name, undefined);
  assert.equal(f.bridge.bindings.size, 0);
  assert.equal(f.calls.filter(call => call.name === 'cfkanban_projects_get').length, 8);
  assert.equal(f.calls.filter(call => call.name === 'cfkanban_connection_inspect').length, 8);
  for (const call of f.calls.filter(call => call.name === 'cfkanban_projects_get')) {
    assert.ok(targets.slice(0, 8).some(target => target.instance_id === call.args.instance_id && target.project_id === call.args.project_id && target.workspace_id === call.args.workspace_id));
    assert.deepEqual(call.config.binding.project_ids, [call.args.project_id]);
    assert.equal(call.config.binding.expected_principal_id, f.ids.expected_principal_id);
  }
  assert.equal(f.calls.some(call => ['cfkanban_projects_list', 'cfkanban_issues_list'].includes(call.name)), false);
  const next = await f.call('scope_targets', { ...input, offset: page.data.next_offset });
  assert.equal(next.data.items[0].display_name, 'Project 8');
  assert.equal(next.data.next_offset, 16);
  assert.equal((await f.call('scope_targets', { ...input, offset: -1 })).error.code, 'PANEL_INVALID_INPUT');
});

test('a single Workspace recommendation verifies its explicit identity and Project before automatically listing only that Project', async () => {
  const f = fixture();
  const endpoints = [];
  f.bridge.scopeReader = async () => ({ status: 'configured', code: 'SCOPE_CONFIGURED', targets: [scopeTarget(f)] });
  const controller = controllerFor(f, endpoints);
  await controller.bootstrap(f.workspaces[0].sessionIds[0]);
  assert.deepEqual(endpoints.map(call => call.endpoint), ['session_scope', 'bind_scope', 'list']);
  assert.deepEqual(endpoints[1].input.target, scopeTarget(f));
  assert.equal(controller.state.binding.project.display_name, 'Project');
  assert.equal(controller.state.scope_mode, 'suggested');
  assert.equal(controller.state.workspace_scope.source, 'workspace');
  assert.ok(f.calls.filter(call => call.name === 'cfkanban_connection_inspect').every(call => call.args.instance_id === f.ids.instance_id));
  assert.deepEqual(f.calls.find(call => call.name === 'cfkanban_issues_list').args.project_ids, [f.ids.project_id]);
  assert.equal(f.calls.some(call => ['cfkanban_projects_list', 'cfkanban_workspaces_list'].includes(call.name)), false);
  assert.equal(f.creates.length + f.prompts.length, 0);
  controller.dispose();
});

test('multiple recommendations require a choice and missing or invalid scopes fall back to manual selection without Issue aggregation', async () => {
  const f = fixture();
  const endpoints = [];
  const second = { ...scopeTarget(f), project_id: randomUUID() };
  f.bridge.scopeReader = async () => ({ status: 'configured', code: 'SCOPE_CONFIGURED', targets: [scopeTarget(f), second] });
  const controller = controllerFor(f, endpoints);
  await controller.bootstrap(f.workspaces[0].sessionIds[0]);
  assert.deepEqual(endpoints.map(call => call.endpoint), ['session_scope', 'scope_targets']);
  assert.equal(controller.state.binding, null);
  assert.equal(f.bridge.bindings.size, 0);
  assert.equal(controller.state.scope_targets.length, 2);
  assert.equal(f.calls.some(call => call.name === 'cfkanban_issues_list'), false);
  await controller.bindScope(controller.state.scope_targets[0]);
  assert.equal(controller.state.binding.project.id, f.ids.project_id);
  assert.deepEqual(endpoints.slice(-2).map(call => call.endpoint), ['bind_scope', 'list']);
  controller.dispose();
  for (const status of ['missing', 'invalid', 'empty', 'unavailable']) {
    const fallback = fixture();
    fallback.bridge.scopeReader = async () => ({ status, code: `SCOPE_${status.toUpperCase()}`, targets: [] });
    const calls = [];
    const view = controllerFor(fallback, calls);
    await view.bootstrap(fallback.workspaces[0].sessionIds[0]);
    assert.deepEqual(calls.map(call => call.endpoint), ['session_scope', 'connections']);
    assert.equal(view.state.scope_mode, 'manual');
    assert.equal(view.state.binding, null);
    assert.equal(fallback.calls.some(call => call.name === 'cfkanban_issues_list'), false);
    view.dispose();
  }
});

test('Session changes preserve the original binding and uncertain keys while a separate native Session view can apply its own scope', async () => {
  const f = fixture({ uncertain: true });
  const endpoints = [];
  f.bridge.scopeReader = async () => ({ status: 'configured', code: 'SCOPE_CONFIGURED', targets: [scopeTarget(f)] });
  const source = f.workspaces[0].sessionIds[0];
  const controller = controllerFor(f, endpoints);
  await controller.bootstrap(source);
  await controller.openIssue('CFK-1');
  await controller.mutate('update', { priority_key: 'high' });
  const pending = structuredClone(controller.state.pending);
  const binding_id = controller.state.binding.binding_id;
  const callsBefore = endpoints.length;
  const otherSession = randomUUID();
  f.workspaces[0].sessionIds.push(otherSession);
  await controller.bootstrap(otherSession);
  await controller.useManual();
  await controller.bindScope(scopeTarget(f));
  await controller.mutate('comment', { body: 'must not send' });
  assert.equal(controller.state.session_context_changed, true);
  assert.equal(controller.state.binding.binding_id, binding_id);
  assert.deepEqual(controller.state.pending, pending);
  assert.equal(endpoints.length, callsBefore);
  const separate = controllerFor(f);
  await separate.bootstrap(otherSession);
  assert.ok(separate.state.binding);
  assert.notEqual(separate.state.binding.binding_id, binding_id);
  assert.equal(separate.state.source_session_id, otherSession);
  assert.deepEqual(controller.state.pending, pending);
  controller.dispose();
  separate.dispose();
});

test('automatic scope binding failures retain a fixed reason after switching to manual setup', async () => {
  for (const [code, expected] of [['FORBIDDEN', 'PANEL_SCOPE_PERMISSION_DENIED'], ['UNAUTHORIZED', 'PANEL_SCOPE_CREDENTIAL_UNAVAILABLE'], ['STATE_PATH_INVALID', 'PANEL_SCOPE_CREDENTIAL_UNAVAILABLE'], ['MCP_LOCAL_STATE_UNAVAILABLE', 'PANEL_SCOPE_HOST_UNAVAILABLE'], ['NOT_FOUND', 'PANEL_SCOPE_STALE'], ['MCP_PRINCIPAL_BINDING_MISMATCH', 'PANEL_SCOPE_IDENTITY_CHANGED'], ['RATE_LIMITED', 'PANEL_SCOPE_TARGET_UNAVAILABLE'], ['PLATFORM_UNAVAILABLE', 'PANEL_SCOPE_TARGET_UNAVAILABLE'], ['UNRECOGNIZED_UNTRUSTED_ERROR', 'PANEL_SCOPE_TARGET_UNAVAILABLE']]) {
    const f = fixture();
    const endpoints = [];
    f.bridge.scopeReader = async () => ({ status: 'configured', code: 'SCOPE_CONFIGURED', targets: [scopeTarget(f)] });
    const facadeFactory = f.bridge.createFacade;
    f.bridge.createFacade = config => {
      const facade = facadeFactory(config);
      return { callTool: async (name, args, options) => name === 'cfkanban_projects_get' ? { ok: false, status: 403, error: { code, message: 'MUST_NOT_DISPLAY', details: { secret: 'MUST_NOT_DISPLAY' } } } : facade.callTool(name, args, options) };
    };
    const view = controllerFor(f, endpoints);
    await view.bootstrap(f.workspaces[0].sessionIds[0]);
    assert.deepEqual(endpoints.map(call => call.endpoint), ['session_scope', 'bind_scope', 'connections']);
    assert.equal(view.state.scope_mode, 'manual');
    assert.equal(view.state.scope_fallback, expected);
    assert.equal(view.state.error, null);
    assert.equal(view.state.binding, null);
    assert.equal(f.bridge.bindings.size, 0);
    assert.equal(f.calls.some(call => call.name === 'cfkanban_issues_list'), false);
    assert.equal(JSON.stringify(view.state).includes('MUST_NOT_DISPLAY'), false);
    view.dispose();
  }
});

test('failed recommended Project metadata is retried only on explicit request and never starts an Issue operation', async () => {
  const f = fixture();
  const endpoints = [];
  const second = { ...scopeTarget(f), project_id: randomUUID() };
  f.bridge.scopeReader = async () => ({ status: 'configured', code: 'SCOPE_CONFIGURED', targets: [scopeTarget(f), second] });
  const facadeFactory = f.bridge.createFacade;
  let unavailable = true;
  f.bridge.createFacade = config => {
    const facade = facadeFactory(config);
    return { callTool: async (name, args, options) => {
      if (name === 'cfkanban_projects_get' && args.project_id === second.project_id) return unavailable ? { ok: false, status: 0, error: { code: 'MCP_LOCAL_STATE_UNAVAILABLE' } } : result({ id: second.project_id, display_name: 'Skill E2E' });
      return facade.callTool(name, args, options);
    } };
  };
  const view = controllerFor(f, endpoints);
  await view.bootstrap(f.workspaces[0].sessionIds[0]);
  assert.equal(view.state.scope_targets[1].available, false);
  assert.equal(view.state.scope_targets[1].unavailability, 'PANEL_SCOPE_HOST_UNAVAILABLE');
  const callsBefore = endpoints.length;
  unavailable = false;
  await Promise.resolve();
  assert.equal(endpoints.length, callsBefore);
  await view.loadScopeTargets();
  assert.equal(view.state.scope_targets[1].available, true);
  assert.equal(view.state.scope_targets[1].display_name, 'Skill E2E');
  assert.deepEqual(endpoints.map(call => call.endpoint), ['session_scope', 'scope_targets', 'scope_targets']);
  assert.equal(f.bridge.bindings.size, 0);
  assert.equal(f.calls.some(call => call.name === 'cfkanban_issues_list' || call.name.endsWith('_create') || call.name.endsWith('_update')), false);
  assert.equal(f.creates.length + f.prompts.length, 0);
  view.dispose();
});

test('local guard refuses remote/unknown Hosts and unrelated peers before credential access', async () => {
  const f = fixture();
  for (const webHost of ['0.0.0.0', undefined]) {
    f.bridge.host.webHost = webHost;
    assert.equal((await f.call('connections', {})).error.code, 'PANEL_LOCAL_HOST_REQUIRED');
  }
  f.bridge.host.webHost = '127.0.0.1';
  assert.equal((await f.call('connections', {}, {})).error.code, 'PANEL_LOCAL_HOST_REQUIRED');
  f.bridge.host.hasWebServer = false;
  f.bridge.host.singleUserLocal = false;
  assert.equal((await f.call('connections', {})).error.code, 'PANEL_LOCAL_HOST_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('RPC rejects path/state/URL passthrough, protocol drift and out-of-scope Issues', async () => {
  const f = fixture();
  assert.equal((await f.call('identity', { instance_id: f.ids.instance_id, stateRoot: '/private' })).error.code, 'PANEL_INVALID_INPUT');
  assert.equal((await f.bridge.call('connections', { protocol: 999, input: {} }, new AbortController().signal, f.peer)).error.code, 'PANEL_VERSION_MISMATCH');
  const binding_id = await f.bind();
  f.issue = { ...f.issue, project: { id: randomUUID() } };
  assert.equal((await f.call('detail', { binding_id, identifier: 'CFK-1' })).error.code, 'PANEL_SCOPE_DENIED');
});

test('bound list preserves explicit server filters and cursor without aggregate reads', async () => {
  const f = fixture();
  const binding_id = await f.bind();
  const page = await f.call('list', { binding_id, status: 'todo', priority: 'high', assignment: 'mine', cursor: 'opaque-page' });
  assert.equal(page.data.next_cursor, 'next-fixture');
  const request = f.calls.find(row => row.name === 'cfkanban_issues_list');
  assert.deepEqual(request.args, { instance_id: f.ids.instance_id, project_ids: [f.ids.project_id], limit: 25, status: ['todo'], priority: ['high'], assignee: [f.ids.expected_principal_id], cursor: 'opaque-page' });
  assert.deepEqual(request.config.binding, { instance_id: f.ids.instance_id, expected_principal_id: f.ids.expected_principal_id, project_ids: [f.ids.project_id] });
});

test('permission and CAS refusal happen before any write', async () => {
  for (const reader of [false, true]) {
    const f = fixture({ reader });
    const binding_id = await f.bind();
    const response = await f.call('mutate', { binding_id, identifier: 'CFK-1', operation: 'update', expected_version: reader ? 1 : 2, idempotency_key: randomUUID(), change: { priority_key: 'high' } });
    assert.equal(response.error.code, reader ? 'PANEL_PERMISSION_DENIED' : 'PANEL_VERSION_CONFLICT');
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
  }
});

test('append-only Comments allow Issue version drift while update and complete preserve CAS', async () => {
  const f = fixture();
  const binding_id = await f.bind();
  f.issue = { ...f.issue, version: 2 };
  const input = { binding_id, identifier: 'CFK-1', expected_version: 1, idempotency_key: randomUUID(), operation: 'comment', change: { body: 'Reviewed Comment' } };
  assert.equal((await f.call('mutate', input)).ok, true);
  const append = f.calls.find(row => row.name === 'cfkanban_comments_create');
  assert.equal(append.args.body, 'Reviewed Comment');
  assert.equal(Object.hasOwn(append.args, 'expected_version'), false);
  for (const [operation, change] of [['update', { priority_key: 'high' }], ['complete', { summary: 'Actual evidence' }]]) {
    const refused = await f.call('mutate', { ...input, operation, change, idempotency_key: randomUUID() });
    assert.equal(refused.error.code, 'PANEL_VERSION_CONFLICT');
  }
  assert.equal(f.calls.filter(row => ['cfkanban_issues_update', 'cfkanban_issues_complete'].includes(row.name)).length, 0);
});

test('uncertain writes recover using the original request and key; payload drift is refused', async () => {
  const f = fixture({ uncertain: true });
  const binding_id = await f.bind();
  const input = { binding_id, identifier: 'CFK-1', operation: 'update', expected_version: 1, idempotency_key: randomUUID(), change: { priority_key: 'high' } };
  const uncertain = await f.call('mutate', input);
  assert.equal(uncertain.panel.recovery_required, true);
  assert.equal((await f.call('recover', { ...input, change: { priority_key: 'low' } })).error.code, 'PANEL_KEY_REUSED');
  const recovered = await f.call('recover', input);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.panel.readback.priority, 'high');
  const writes = f.calls.filter(row => row.name === 'cfkanban_issues_update');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].args, writes[1].args);
  await f.call('recover', input);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 2);
});

test('Host refuses unbind while a write is uncertain, independently of Client buttons', async () => {
  const f = fixture({ uncertain: true });
  const binding_id = await f.bind();
  const input = { binding_id, identifier: 'CFK-1', operation: 'update', expected_version: 1, idempotency_key: randomUUID(), change: { priority_key: 'high' } };
  await f.call('mutate', input);
  assert.equal((await f.call('unbind', { binding_id })).error.code, 'PANEL_OPERATION_PENDING');
  f.bridge.now = () => Date.now() + 9 * 60 * 60 * 1000;
  assert.equal((await f.call('recover', input)).ok, true);
  assert.equal((await f.call('unbind', { binding_id })).error.code, 'PANEL_BINDING_EXPIRED');
});

test('cached write receipt rechecks current identity and scope before returning business data', async () => {
  const f = fixture();
  const binding_id = await f.bind();
  const input = { binding_id, identifier: 'CFK-1', operation: 'update', expected_version: 1, idempotency_key: randomUUID(), change: { priority_key: 'high' } };
  await f.call('mutate', input);
  f.issue = { ...f.issue, project: { id: randomUUID() } };
  assert.equal((await f.call('recover', input)).error.code, 'PANEL_SCOPE_DENIED');
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 1);
});

test('Comments use the existing append-only API and completion carries actual evidence', async () => {
  const f = fixture();
  const binding_id = await f.bind();
  await f.call('mutate', { binding_id, identifier: 'CFK-1', operation: 'comment', expected_version: 1, idempotency_key: randomUUID(), change: { body: 'Verified fixture' } });
  const comment = f.calls.find(row => row.name === 'cfkanban_comments_create');
  assert.equal(Object.hasOwn(comment.args, 'expected_version'), false);
  await f.call('mutate', { binding_id, identifier: 'CFK-1', operation: 'complete', expected_version: 1, idempotency_key: randomUUID(), change: { summary: 'Implemented', verification: ['Isolated test passed'], artifacts: [{ kind: 'commit', value: 'fixture' }], follow_ups: ['Real Host smoke'] } });
  assert.deepEqual(f.calls.find(row => row.name === 'cfkanban_issues_complete').args.verification, ['Isolated test passed']);
});

test('Client retains uncertain key, excludes duplicate writes and disposes without subscriptions', async () => {
  const calls = [];
  let unknown = true;
  const controller = new PanelController({ call: async (_channel, endpoint, input) => {
    calls.push({ endpoint, input });
    if (unknown) { unknown = false; return { ok: true, value: { ok: false, outcome_unknown: true, error: { code: 'NETWORK_ERROR' } } }; }
    return { ok: true, value: result({ items: [] }) };
  } }, new AbortController().signal, () => 'fixed-key');
  controller.patch({ binding: { binding_id: randomUUID() }, issue: { identifier: 'CFK-1', version: 1 } });
  await controller.mutate('update', { priority_key: 'high' });
  assert.equal(controller.state.pending.idempotency_key, 'fixed-key');
  await controller.mutate('update', { priority_key: 'low' });
  assert.equal(calls.length, 1);
  await controller.mutate(null, null, true);
  assert.deepEqual(calls[0].input, calls[1].input);
  controller.subscribe(() => {});
  controller.dispose();
  assert.equal(controller.listeners.size, 0);
  assert.equal(controller.signal.aborted, true);
});

test('real foundation discovery and panel binding reject identity drift in an isolated fake HTTPS environment', async t => {
  const state = await createMcpStateFixture(t);
  let drift = false;
  const paths = [];
  const fetchImpl = async url => {
    const pathname = new URL(url).pathname;
    paths.push(pathname);
    let body;
    if (pathname === '/.well-known/cfkanban-instance.json') body = state.discovery;
    else if (pathname === '/api/v1/me') body = drift ? { ...state.me(state.credential), id: randomUUID(), principal_id: randomUUID() } : state.me(state.credential);
    else if (pathname === '/api/v1/workspaces') body = { items: [{ id: state.workspaceId, display_name: 'Fixture' }] };
    else if (pathname.endsWith('/statuses')) body = { items: [{ key: 'todo', display_name: 'Todo' }] };
    else body = { id: state.projectId, display_name: 'Project' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const peer = {};
  const bridge = new PanelBridge({ createFacade: config => createMcpFacade({ home: state.home, stateRoot: state.stateRoot, fetchImpl, ...config }), host: { singleUserLocal: true, hasWebServer: true, webHost: '127.0.0.1', operator: peer }, dsh: {} });
  const call = (endpoint, input) => bridge.call(endpoint, { protocol: PANEL_PROTOCOL, input }, new AbortController().signal, peer);
  const selection = { instance_id: state.instanceId, expected_principal_id: state.principalId };
  assert.equal((await call('workspaces', selection)).ok, true);
  const bound = await call('bind', { ...selection, workspace_id: state.workspaceId, project_id: state.projectId });
  assert.equal(bound.ok, true);
  drift = true;
  const refused = await call('list', { binding_id: bound.data.binding_id });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'MCP_PRINCIPAL_BINDING_MISMATCH');
  assert.equal(paths.filter(value => value === '/api/v1/issues').length, 0);
  assert.doesNotMatch(JSON.stringify(bound), /cfk_v1_/);
});
