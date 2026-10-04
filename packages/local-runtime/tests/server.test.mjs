import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startLocalWorkbenchServer, validateDirectory } from '../src/server.mjs';
import { createOnlineOpener, resolveInitialContext, stopOnEof } from '../src/launcher.mjs';
import { WorkbenchBridge } from '../src/workbench/bridge.mjs';
import { WorkbenchController } from '../src/workbench/controller.mjs';
import { normalizeNetworkFailure } from '../../skill-runtime/src/transport.mjs';

const html = '<!doctype html><html><body><div id="app"></div></body></html>';
const browserScript = 'export const fixture=true;';
async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfkanban-local-server-'));
  const bridges = [];
  const createBridge = ({ directory: trustedDirectory, host }) => {
    const bridge = { directory: trustedDirectory, host, project: null, pending: false, writes: [], disposed: false,
      hasPending: () => bridge.pending,
      dispose: () => { bridge.disposed = true; },
      call: async (endpoint, payload, signal, operator) => {
        assert.equal(operator, host.operator);
        signal.throwIfAborted();
        if (endpoint === 'bind') bridge.project = payload.input.project_id;
        if (endpoint === 'mutate') { bridge.pending = true; bridge.writes.push(structuredClone(payload.input)); return { ok: false, outcome_unknown: true, error: { code: 'PANEL_REQUEST_UNCERTAIN' } }; }
        if (endpoint === 'recover') { assert.deepEqual(payload.input, bridge.writes.at(-1)); bridge.pending = false; return { ok: true, panel: { original_settled: true } }; }
        return { ok: true, data: { project: bridge.project, directory_bound: trustedDirectory === directory } };
      }
    };
    bridges.push(bridge);
    return bridge;
  };
  const server = await startLocalWorkbenchServer({ directory, html, browserScript, createBridge, ...options });
  async function view() {
    let localUrl;
    let response;
    let opening;
    const result = await server.deliverView(async value => { localUrl = value; opening = fetch(value, { redirect: 'manual' }); response = await opening; });
    response = await opening;
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie');
    const pathname = response.headers.get('location');
    const page = await fetch(`${server.address}${pathname}`, { headers: { cookie: cookie.split(';')[0] } });
    const source = await page.text();
    const config = JSON.parse(/<script type="application\/json" id="configuration">(.*?)<\/script>/.exec(source)[1]);
    const call = (endpoint, input = {}, headers = {}, body) => fetch(`${server.address}${pathname}api/${endpoint}`, { method: 'POST', headers: { cookie: cookie.split(';')[0], origin: server.address, 'content-type': 'application/json', 'x-cfkanban-csrf': config.csrf, ...headers }, body: body ?? JSON.stringify({ protocol: 1, input }) });
    return { localUrl, result, cookie, pathname, page, source, config, call };
  }
  return { ...server, directory, bridges, view, cleanup: async () => { await server.close({ force: true }); await rm(directory, { recursive: true, force: true }); } };
}

test('loopback admission rejects unauthenticated enumeration, foreign Origin, DNS Host and CSRF', async () => {
  const f = await fixture();
  try {
    assert.match(f.address, /^http:\/\/127\.0\.0\.1:\d+$/);
    const outsider = await fetch(`${f.address}/view/${randomUUID()}/api/connections`, { method: 'POST', body: '{}' });
    assert.equal(outsider.status, 401);
    assert.deepEqual(await outsider.json(), { ok: false, error: { code: 'LOCAL_AUTH_REQUIRED' } });
    const v = await f.view();
    assert.match(v.cookie, /HttpOnly; SameSite=Strict; Path=\/view\/[a-f0-9-]+\/;/);
    assert.equal((await v.call('connections')).status, 200);
    for (const headers of [{ origin: 'https://evil.invalid' }, { origin: 'null' }, { 'x-cfkanban-csrf': '' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await v.call('connections', {}, headers)).status, 403, JSON.stringify(headers));
    const dnsResponse = await new Promise((resolve, reject) => {
      const request = httpRequest(`${f.address}${v.pathname}api/connections`, { method: 'POST', headers: { host: 'evil.invalid', origin: f.address, cookie: v.cookie.split(';')[0], 'content-type': 'application/json', 'x-cfkanban-csrf': v.config.csrf } }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject);
      request.end(JSON.stringify({ protocol: 1, input: {} }));
    });
    assert.equal(dnsResponse, 403);
    assert.equal((await v.call('connections', {}, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await v.call('arbitrary')).status, 404);
    assert.equal((await v.call('connections', {}, {}, JSON.stringify({ protocol: 1, input: {}, path: '/tmp' }))).status, 400);
    assert.equal((await v.call('connections', {}, {}, 'x'.repeat(65_537))).status, 413);
    assert.equal((await fetch(`${f.address}${v.pathname}api/connections`, { headers: { cookie: v.cookie.split(';')[0] } })).status, 405);
    assert.equal(v.page.headers.get('access-control-allow-origin'), null);
    assert.match(v.page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(v.source, /allow-same-origin|allow-forms/);
  } finally { await f.cleanup(); }
});

test('launch is one-time, bounded, and separate views retain distinct projects and cookie paths', async () => {
  const f = await fixture();
  try {
    const a = await f.view();
    const b = await f.view();
    assert.notEqual(a.cookie.split('=')[0], b.cookie.split('=')[0]);
    assert.notEqual(a.pathname, b.pathname);
    assert.equal((await fetch(a.localUrl, { redirect: 'manual' })).status, 401);
    const projectA = randomUUID();
    const projectB = randomUUID();
    await a.call('bind', { project_id: projectA });
    await b.call('bind', { project_id: projectB });
    assert.equal((await (await a.call('list')).json()).value.data.project, projectA);
    assert.equal((await (await b.call('list')).json()).value.data.project, projectB);
    assert.equal((await a.call('list', {}, { cookie: b.cookie.split(';')[0] })).status, 401);
    assert.deepEqual(Object.keys(a.result).sort(), ['delivered', 'view_id']);
    assert.equal(f.bridges.length, 2);
    assert.ok(f.bridges.every(bridge => bridge.directory === f.directory));
  } finally { await f.cleanup(); }
  const expired = await fixture({ launchTtlMs: 10 });
  try { await assert.rejects(expired.deliverView(() => new Promise(() => {})), { code: 'LOCAL_DELIVERY_FAILED' }); }
  finally { await expired.cleanup(); }
});

test('unknown writes prevent view/service disposal and recover only the original request', async () => {
  const f = await fixture();
  try {
    const v = await f.view();
    const input = { binding_id: randomUUID(), identifier: 'CFK-548', expected_version: 2, operation: 'comment', change: { body: 'Actual fixture evidence' }, idempotency_key: randomUUID() };
    const write = await (await v.call('mutate', input)).json();
    assert.equal(write.value.outcome_unknown, true);
    for (const endpoint of ['view-close', 'shutdown']) assert.equal((await v.call(endpoint)).status, 409);
    await assert.rejects(f.close(), { code: 'LOCAL_PENDING_OPERATION', outcome_unknown: true });
    assert.equal(f.bridges[0].disposed, false);
    assert.equal(f.bridges[0].writes.length, 1);
    const recovery = await (await v.call('recover', input)).json();
    assert.equal(recovery.value.panel.original_settled, true);
    assert.equal(f.bridges[0].writes.length, 1);
    assert.equal((await v.call('shutdown')).status, 200);
    assert.deepEqual(await f.closed, { closed: true, outcome_unknown: false, recovery: 'none' });
  } finally { await f.cleanup(); }
});

test('EOF force-stop aborts the service and reports unresolved operations without replay', async () => {
  const f = await fixture();
  try {
    const v = await f.view();
    await v.call('mutate', { idempotency_key: randomUUID() });
    const stream = new PassThrough();
    const unsubscribe = stopOnEof(f, stream);
    stream.resume();
    stream.end();
    const stopped = await f.closed;
    assert.equal(stopped.outcome_unknown, true);
    assert.equal(f.bridges[0].writes.length, 1);
    assert.equal(f.bridges[0].disposed, true);
    unsubscribe();
    await assert.rejects(fetch(f.address));
  } finally { await f.cleanup(); }
});

test('idle views retain their original Bridge and pending operation until the fixed service deadline', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock });
  try {
    const ordinary = await f.view();
    const pending = await f.view();
    const project = randomUUID();
    await ordinary.call('bind', { project_id: project });
    assert.match(pending.cookie, /Max-Age=28800/);
    const input = { binding_id: randomUUID(), identifier: 'CFK-548', expected_version: 2, operation: 'comment', change: { body: 'Fixture' }, idempotency_key: randomUUID() };
    await pending.call('mutate', input);
    clock = 30 * 60_000 + 1;
    assert.equal((await (await ordinary.call('list')).json()).value.data.project, project);
    assert.equal(f.bridges[0].disposed, false);
    assert.equal((await pending.call('list', {}, { cookie: ordinary.cookie.split(';')[0] })).status, 401);
    const recovered = await pending.call('recover', input);
    assert.equal((await recovered.json()).value.panel.original_settled, true);
    assert.match(recovered.headers.get('set-cookie'), /Max-Age=27000/);
    assert.equal(f.bridges[1].writes.length, 1);
    clock = 7 * 60 * 60_000;
    assert.equal((await (await ordinary.call('list')).json()).value.data.project, project);
    assert.equal(f.bridges.length, 2);
    await pending.call('mutate', input);
    clock = 8 * 60 * 60_000;
    const expired = await pending.call('recover', input);
    assert.equal(expired.status, 410);
    assert.deepEqual(await expired.json(), { ok: false, outcome_unknown: true, error: { code: 'LOCAL_SERVICE_EXPIRED' } });
    assert.deepEqual(await f.closed, { closed: true, outcome_unknown: true, recovery: 'verify_original_operations_before_retry' });
    assert.equal(f.bridges[1].writes.length, 2);
  } finally { await f.cleanup(); }
});

test('an idle process closes only without an exchanged view; explicit view close releases its Bridge', { timeout: 5000 }, async () => {
  let clock = 0;
  const empty = await fixture({ idleTtlMs: 50, now: () => clock });
  try {
    clock = 15 * 60_000;
    assert.deepEqual(await empty.closed, { closed: true, outcome_unknown: false, recovery: 'none' });
  } finally { await empty.cleanup(); }
  clock = 0;
  const active = await fixture({ idleTtlMs: 50, now: () => clock });
  try {
    const view = await active.view();
    clock = 2 * 60 * 60_000;
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(active.bridges[0].disposed, false);
    assert.equal((await view.call('list')).status, 200);
    assert.equal((await view.call('view-close')).status, 200);
    assert.equal(active.bridges[0].disposed, true);
    assert.equal((await view.call('list')).status, 401);
    clock += 15 * 60_000;
    assert.equal((await active.closed).closed, true);
  } finally { await active.cleanup(); }
});

test('page release keeps a refresh grace period, ignores late old-page receipts, and cannot discard pending writes', { timeout: 5000 }, async () => {
  let clock = 0;
  const f = await fixture({ idleTtlMs: 50, viewReleaseGraceMs: 100, now: () => clock });
  try {
    const original = await f.view();
    const retained = await f.view();
    assert.equal((await original.call('view-release', {})).status, 400);
    assert.equal((await original.call('view-release', { page_id: original.config.page_id }, { 'x-cfkanban-csrf': '' })).status, 403);
    assert.equal((await original.call('view-release', { page_id: original.config.page_id }, { cookie: retained.cookie.split(';')[0] })).status, 401);
    assert.equal((await original.call('view-release', { page_id: original.config.page_id })).status, 200);
    clock = 50;
    const reloaded = await fetch(`${f.address}${original.pathname}`, { headers: { cookie: original.cookie.split(';')[0] } });
    const config = JSON.parse(/<script type="application\/json" id="configuration">(.*?)<\/script>/.exec(await reloaded.text())[1]);
    assert.notEqual(config.page_id, original.config.page_id);
    assert.equal((await original.call('view-release', { page_id: original.config.page_id })).status, 200);
    clock = 200;
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(f.bridges[0].disposed, false, 'a late pagehide must not release the refreshed page');
    assert.equal((await original.call('list')).status, 200);
    const pending = { idempotency_key: randomUUID() };
    await original.call('mutate', pending);
    assert.equal((await original.call('view-release', { page_id: config.page_id })).status, 409);
    clock += 200;
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(f.bridges[0].disposed, false);
    await original.call('recover', pending);
    assert.equal((await original.call('view-release', { page_id: config.page_id })).status, 200);
    clock += 200;
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(f.bridges[0].disposed, true);
    assert.equal(f.bridges[1].disposed, false);
    assert.equal((await original.call('list')).status, 401);
    assert.equal((await retained.call('list')).status, 200);
    assert.equal(f.bridges[0].writes.length, 1);
  } finally { await f.cleanup(); }
});

test('an idle retained view still uses its original Principal/Project binding and respects current identity or grant rejection', async () => {
  const instance = randomUUID();
  const principal = randomUUID();
  const workspace = randomUUID();
  const project = randomUUID();
  let activePrincipal = principal;
  let revoked = false;
  let detailReads = 0;
  let clock = 0;
  const issue = { identifier: 'CFK-123', project: { id: project }, version: 1, allowed_actions: ['read'] };
  const createFacade = options => ({ callTool: async name => {
    if (options.binding) {
      assert.deepEqual(options.binding, { instance_id: instance, expected_principal_id: principal, project_ids: [project] });
      if (activePrincipal !== principal) return { ok: false, status: 409, error: { code: 'MCP_PRINCIPAL_BINDING_MISMATCH' } };
    }
    if (name === 'cfkanban_connection_inspect') return { ok: true, data: { instance: { instance_id: instance }, principal: { principal_id: activePrincipal } } };
    if (name === 'cfkanban_projects_get') return { ok: true, data: { id: project } };
    if (name === 'cfkanban_statuses_list') return { ok: true, data: [{ key: 'todo', display_name: 'Todo' }] };
    if (name === 'cfkanban_issues_get') {
      if (revoked) return { ok: false, status: 403, error: { code: 'FORBIDDEN' } };
      detailReads++;
      return { ok: true, data: issue };
    }
    throw new Error('Unexpected synthetic facade operation');
  } });
  const retainedBridges = [];
  const f = await fixture({ now: () => clock, createFacade, createBridge: options => { const bridge = new WorkbenchBridge(options); retainedBridges.push(bridge); return bridge; } });
  try {
    const view = await f.view();
    const binding = (await (await view.call('bind', { instance_id: instance, expected_principal_id: principal, workspace_id: workspace, project_id: project })).json()).value.data;
    const input = { binding_id: binding.binding_id, identifier: issue.identifier };
    clock = 2 * 60 * 60_000;
    assert.equal((await (await view.call('detail', input)).json()).value.data.identifier, issue.identifier);
    activePrincipal = randomUUID();
    const switched = (await (await view.call('detail', input)).json()).value;
    assert.equal(switched.ok, false);
    assert.equal(switched.error.code, 'MCP_PRINCIPAL_BINDING_MISMATCH');
    assert.equal(detailReads, 1);
    activePrincipal = principal; revoked = true;
    const denied = (await (await view.call('detail', input)).json()).value;
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'FORBIDDEN');
    assert.equal(detailReads, 1);
    assert.equal(retainedBridges.length, 1);
  } finally { await f.cleanup(); }
});

test('memory checkpoint preserves the original write over reload and refuses secrets or premature clearing', async () => {
  const f = await fixture();
  try {
    const v = await f.view();
    const bindingId = randomUUID();
    const pending = { binding_id: bindingId, identifier: 'CFK-548', expected_version: 2, operation: 'comment', change: { body: 'Fixture' }, idempotency_key: randomUUID() };
    const checkpoint = { schema_version: 1, state: { binding: { binding_id: bindingId, identity: null, project: { id: randomUUID() }, statuses: [] }, pending, issue: null, view: 'board', filters: { assignment: 'all', status: '', priority: '' } } };
    assert.equal((await v.call('checkpoint', checkpoint)).status, 200);
    const restoredPage = await fetch(`${f.address}${v.pathname}`, { headers: { cookie: v.cookie.split(';')[0] } });
    const restored = JSON.parse(/<script type="application\/json" id="configuration">(.*?)<\/script>/.exec(await restoredPage.text())[1]);
    assert.deepEqual(restored.checkpoint.state.pending, pending);
    assert.equal((await v.call('checkpoint', { ...checkpoint, credential: 'not-accepted' })).status, 400);
    await v.call('mutate', pending);
    assert.equal((await v.call('checkpoint', { ...checkpoint, state: { ...checkpoint.state, pending: null } })).status, 409);
    assert.equal((await v.call('recover', pending)).status, 200);
    assert.equal((await v.call('checkpoint', { ...checkpoint, state: { ...checkpoint.state, pending: null } })).status, 200);
  } finally { await f.cleanup(); }
});

test('actual Host pending request cannot be replaced by another key, payload, version or binding checkpoint', async () => {
  const instance = randomUUID();
  const principal = randomUUID();
  const workspace = randomUUID();
  const project = randomUUID();
  let writes = 0;
  let requests = 0;
  let onlineCalls = 0;
  let releasePreflight;
  let preflightStarted;
  let issueReads = 0;
  const preflight = new Promise(resolve => { preflightStarted = resolve; });
  const issue = { identifier: 'CFK-548', version: 2, status: { key: 'todo' }, project: { id: project }, allowed_actions: ['read', 'update'] };
  const createFacade = () => ({ callTool: async name => {
    if (name === 'cfkanban_connection_inspect') return { ok: true, data: { instance: { instance_id: instance }, principal: { principal_id: principal } } };
    if (name === 'cfkanban_projects_get') return { ok: true, data: { id: project } };
    if (name === 'cfkanban_statuses_list') return { ok: true, data: [] };
    if (name === 'cfkanban_issues_get') {
      if (++issueReads === 1) { preflightStarted(); await new Promise(resolve => { releasePreflight = resolve; }); }
      return { ok: true, data: issue };
    }
    if (name === 'cfkanban_comments_create') {
      requests++;
      if (requests === 1) { writes++; return { ok: false, status: 0, outcome_unknown: true, error: { code: 'PLATFORM_UNAVAILABLE' } }; }
      return { ok: true, data: {} };
    }
    throw new Error('Unsupported isolated facade operation');
  } });
  const f = await fixture({ createFacade, createBridge: options => new WorkbenchBridge(options), openOnline: async () => { onlineCalls++; return { ok: true }; } });
  try {
    const v = await f.view();
    const bound = (await (await v.call('bind', { instance_id: instance, expected_principal_id: principal, workspace_id: workspace, project_id: project })).json()).value.data;
    const binding = { binding_id: bound.binding_id, identity: bound.identity, project: bound.project, statuses: bound.statuses };
    const pending = { binding_id: binding.binding_id, identifier: issue.identifier, expected_version: issue.version, operation: 'comment', change: { body: 'Original B' }, idempotency_key: randomUUID() };
    const checkpoint = { schema_version: 1, state: { binding, pending, issue: null, view: 'board', filters: { assignment: 'all', status: '', priority: '' } } };
    const anotherBinding = randomUUID();
    const substitutes = [
      { ...checkpoint, state: { ...checkpoint.state, pending: null } },
      { ...checkpoint, state: { ...checkpoint.state, pending: { ...pending, idempotency_key: randomUUID() } } },
      { ...checkpoint, state: { ...checkpoint.state, pending: { ...pending, expected_version: 3 } } },
      { ...checkpoint, state: { ...checkpoint.state, pending: { ...pending, change: { body: 'Changed A' } } } },
      { ...checkpoint, state: { ...checkpoint.state, binding: { ...binding, binding_id: anotherBinding }, pending: { ...pending, binding_id: anotherBinding } } },
    ];
    const writing = v.call('mutate', pending);
    await preflight;
    assert.equal((await v.call('open-online', { binding_id: binding.binding_id, identifier: pending.identifier })).status, 409);
    assert.equal(onlineCalls, 0);
    for (const value of substitutes) assert.equal((await v.call('checkpoint', value)).status, 409);
    assert.equal((await v.call('checkpoint', checkpoint)).status, 200);
    assert.equal((await v.call('shutdown')).status, 409);
    releasePreflight();
    assert.equal((await (await writing).json()).value.outcome_unknown, true);
    for (const value of substitutes) assert.equal((await v.call('checkpoint', value)).status, 409);
    assert.equal((await v.call('checkpoint', checkpoint)).status, 200);
    const restored = JSON.parse(/<script type="application\/json" id="configuration">(.*?)<\/script>/.exec(await (await fetch(`${f.address}${v.pathname}`, { headers: { cookie: v.cookie.split(';')[0] } })).text())[1]);
    assert.deepEqual(restored.checkpoint.state.pending, pending);
    assert.equal((await (await v.call('recover', restored.checkpoint.state.pending)).json()).value.panel.original_settled, true);
    assert.equal(writes, 1);
    assert.equal(requests, 2);
    assert.equal((await v.call('shutdown')).status, 409);
    assert.equal((await v.call('open-online', { binding_id: binding.binding_id, identifier: pending.identifier })).status, 409);
    assert.equal(onlineCalls, 0);
    assert.equal((await v.call('checkpoint', substitutes[0])).status, 200);
    assert.deepEqual(await (await v.call('shutdown')).json(), { ok: true, value: { ok: true } });
  } finally { await f.cleanup(); }
});

test('online admission waits for actual Project binding preflight before choosing and preserving a target', async () => {
  const instance = randomUUID();
  const principal = randomUUID();
  const workspace = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  let pauseProject = true;
  let releaseProject = () => {};
  let projectStarted;
  const preflight = new Promise(resolve => { projectStarted = resolve; });
  const launches = [];
  const createFacade = () => ({ callTool: async (name, args) => {
    if (name === 'cfkanban_connection_inspect') return { ok: true, data: { instance: { instance_id: instance }, principal: { principal_id: principal } } };
    if (name === 'cfkanban_projects_get') {
      if (args.project_id === projectB && pauseProject) {
        pauseProject = false;
        projectStarted();
        await new Promise(resolve => { releaseProject = resolve; });
      }
      return { ok: true, data: { id: args.project_id } };
    }
    if (name === 'cfkanban_statuses_list') return { ok: true, data: [] };
    throw new Error('Unsupported isolated facade operation');
  } });
  const f = await fixture({ createFacade, createBridge: options => new WorkbenchBridge(options), openOnline: async input => {
    launches.push(input);
    return launches.length === 1 ? { ok: false, outcome_unknown: true } : { ok: true };
  } });
  try {
    const v = await f.view();
    const bind = project_id => v.call('bind', { instance_id: instance, expected_principal_id: principal, workspace_id: workspace, project_id });
    const a = (await (await bind(projectA)).json()).value.data;
    const bindingB = bind(projectB);
    await preflight;
    assert.equal((await v.call('open-online', { binding_id: a.binding_id })).status, 409);
    assert.equal((await v.call('shutdown')).status, 409);
    assert.equal(launches.length, 0);
    releaseProject();
    const b = (await (await bindingB).json()).value.data;
    const checkpoint = { schema_version: 1, state: { binding: { binding_id: b.binding_id, identity: b.identity, project: b.project, statuses: b.statuses }, pending: null, issue: null, view: 'board', filters: { assignment: 'all', status: '', priority: '' } } };
    assert.equal((await v.call('checkpoint', checkpoint)).status, 200);
    const unknown = await (await v.call('open-online', { binding_id: b.binding_id })).json();
    assert.equal(unknown.value.outcome_unknown, true);
    assert.deepEqual(unknown.online_pending, { binding_id: b.binding_id });
    assert.equal((await v.call('checkpoint', checkpoint)).status, 200);
    const settled = await (await v.call('open-online', { binding_id: b.binding_id, receipt_id: unknown.online_receipt_id, recover: true })).json();
    assert.equal(settled.value.ok, true);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].bindingId, b.binding_id);
    assert.equal(launches[1].bindingId, b.binding_id);
    assert.equal(launches[0].idempotencyKey, launches[1].idempotencyKey);
    assert.equal((await v.call('ack-online', { binding_id: b.binding_id, receipt_id: settled.online_receipt_id })).status, 200);
    assert.equal((await v.call('shutdown')).status, 200);
  } finally { releaseProject(); await f.cleanup(); }
});

test('uncertain online launch retains its key across denied recovery and does not accept another target', async () => {
  const keys = [];
  const f = await fixture({ openOnline: async ({ idempotencyKey }) => {
    keys.push(idempotencyKey);
    return keys.length === 1 ? { ok: false, outcome_unknown: true } : keys.length === 2 ? { ok: false, error: { code: 'UNAUTHORIZED' } } : { ok: true, delivery: { delivered: false } };
  } });
  try {
    const v = await f.view();
    const target = { binding_id: randomUUID(), identifier: 'CFK-548' };
    assert.equal((await (await v.call('open-online', target)).json()).value.outcome_unknown, true);
    const source = await (await fetch(`${f.address}${v.pathname}`, { headers: { cookie: v.cookie.split(';')[0] } })).text();
    const restored = JSON.parse(/<script type="application\/json" id="configuration">(.*?)<\/script>/.exec(source)[1]);
    assert.deepEqual(restored.online_pending, target);
    assert.equal(Object.hasOwn(restored.online_pending, 'key'), false);
    for (const endpoint of ['bind', 'unbind', 'bind_scope', 'identity', 'mutate']) assert.equal((await v.call(endpoint, { binding_id: target.binding_id })).status, 409);
    assert.equal((await v.call('detail', { binding_id: target.binding_id, identifier: target.identifier })).status, 200);
    assert.equal((await v.call('detail', { binding_id: randomUUID(), identifier: target.identifier })).status, 409);
    assert.equal((await v.call('shutdown')).status, 409);
    assert.equal((await v.call('open-online', { ...target, identifier: 'CFK-544' })).status, 409);
    assert.equal((await (await v.call('open-online', target)).json()).value.outcome_unknown, true);
    const known = await (await v.call('open-online', target)).json();
    assert.equal(known.value.ok, true);
    assert.equal(new Set(keys).size, 1);
    assert.equal((await v.call('unbind', { binding_id: target.binding_id })).status, 409);
    assert.equal((await v.call('ack-online', { ...target, receipt_id: known.online_receipt_id })).status, 200);
    assert.equal((await v.call('unbind', { binding_id: target.binding_id })).status, 200);
    assert.equal((await v.call('shutdown')).status, 200);
  } finally { await f.cleanup(); }
});

test('request deadline aborts a stalled bridge and reports a possible write without retry', async () => {
  let signal;
  let calls = 0;
  const f = await fixture({ requestTimeoutMs: 100, createBridge: () => ({ hasPending: () => calls > 0, dispose: () => {}, call: async (_endpoint, _input, receivedSignal) => { calls++; signal = receivedSignal; await new Promise(() => {}); } }) });
  try {
    const v = await f.view();
    const result = await (await v.call('mutate', { idempotency_key: randomUUID() })).json();
    assert.equal(result.outcome_unknown, true);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    assert.equal((await v.call('shutdown')).status, 409);
  } finally { await f.cleanup(); }
});

test('trusted directory is explicit; malformed or symbolic directories do not start a service', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfkanban-local-directory-'));
  try {
    const folder = path.join(directory, 'folder');
    const link = path.join(directory, 'link');
    await mkdir(folder);
    await symlink(folder, link);
    await assert.rejects(validateDirectory(link), { code: 'LOCAL_DIRECTORY_INVALID' });
    await assert.rejects(validateDirectory('relative'), { code: 'LOCAL_DIRECTORY_INVALID' });
    const file = path.join(directory, '.cfkanban-scope.json');
    await writeFile(file, '{}');
    await assert.rejects(validateDirectory(file), { code: 'LOCAL_DIRECTORY_INVALID' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual shared Bridge reads only launcher scope and refuses browser paths or execution routes', async () => {
  const target = { instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() };
  const principal = randomUUID();
  const f = await fixture({ createBridge: options => new WorkbenchBridge(options), createFacade: () => ({ callTool: async name => name === 'cfkanban_connection_inspect' ? { ok: true, data: { principal: { id: principal } } } : { ok: true, data: { id: target.project_id, display_name: 'Fixture Project' } } }) });
  try {
    const v = await f.view();
    assert.equal((await (await v.call('workspace_scope')).json()).value.data.status, 'missing');
    await writeFile(path.join(f.directory, '.cfkanban-scope.json'), JSON.stringify({ schema_version: 2, targets: [target] }));
    const scope = (await (await v.call('workspace_scope')).json()).value;
    assert.equal(scope.data.status, 'configured');
    assert.deepEqual(scope.data.targets, [target]);
    assert.equal(JSON.stringify(scope).includes(f.directory), false);
    const overridden = (await (await v.call('workspace_scope', { directory: '/other', stateRoot: '/other' })).json()).value;
    assert.equal(overridden.error.code, 'PANEL_INVALID_INPUT');
    const available = (await (await v.call('scope_targets')).json()).value;
    assert.equal(available.data.items[0].available, true);
    assert.equal(available.data.items[0].display_name, 'Fixture Project');
    for (const endpoint of ['handoff', 'prepare_handoff', 'recover_handoff', 'associations', 'verify_session']) assert.equal((await v.call(endpoint)).status, 404);
  } finally { await f.cleanup(); }
});

test('explicit startup context fails closed and online delivery uses a freshly verified exact target', async () => {
  const instance = randomUUID();
  const principal = randomUUID();
  const workspace = randomUUID();
  const project = randomUUID();
  const calls = [];
  const createFacade = options => ({ callTool: async (name, args) => {
    calls.push({ options, name, args });
    if (name === 'cfkanban_connection_inspect') return { ok: true, data: { principal: { id: principal } } };
    if (name === 'cfkanban_issues_get') return { ok: true, data: { project: { id: project }, workspace: { id: workspace } } };
    return { ok: true, data: {} };
  } });
  await assert.rejects(resolveInitialContext({ instanceId: instance, target: { kind: 'admin' }, createFacade }), { code: 'LOCAL_TARGET_UNSUPPORTED' });
  await assert.rejects(resolveInitialContext({ instanceId: instance, target: { kind: 'project', workspace_id: workspace, project_id: 'unknown' }, createFacade }), { code: 'LOCAL_INVALID_TARGET' });
  const context = await resolveInitialContext({ instanceId: instance, target: { kind: 'issue', identifier: 'CFK-548' }, createFacade });
  assert.deepEqual(context.target, { instance_id: instance, workspace_id: workspace, project_id: project, identifier: 'CFK-548' });
  assert.ok(calls.some(call => call.options?.binding?.expected_principal_id === principal));
  let delivered;
  const opener = createOnlineOpener({ deliver: async input => { delivered = input; return { ok: true, delivery: { delivered: true }, sensitive_output: 'must-not-escape' }; } });
  const signal = new AbortController().signal;
  const key = randomUUID();
  const result = await opener({ bridge: { verifiedTarget: async (binding, receivedSignal, identifier) => { assert.equal(receivedSignal.aborted, false); assert.equal(identifier, 'CFK-548'); return { instance_id: instance, principal_id: principal, workspace_id: workspace, project_id: project, identifier }; } }, bindingId: randomUUID(), identifier: 'CFK-548', idempotencyKey: key, signal });
  assert.equal(delivered.idempotencyKey, key);
  assert.equal(delivered.expectedPrincipalId, principal);
  assert.deepEqual(delivered.target, { kind: 'issue', identifier: 'CFK-548' });
  assert.equal(delivered.delivery, 'system_browser');
  assert.equal(result.sensitive_output, undefined);
});

test('actual online opener keeps the server receipt key for normalized network failures and recovery', async () => {
  const calls = [];
  const target = { instance_id: randomUUID(), principal_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), identifier: 'CFK-548' };
  const opener = createOnlineOpener({ deliver: async input => {
    calls.push(input);
    if (calls.length === 1) return normalizeNetworkFailure();
    if (calls.length === 2) return { ...normalizeNetworkFailure(), status: null };
    if (calls.length === 3) return { ok: false, status: 403, error: { code: 'FORBIDDEN', source: 'service' } };
    return { ok: true, delivery: { delivered: false } };
  } });
  const f = await fixture({ openOnline: input => opener({ ...input, bridge: { verifiedTarget: async () => target } }) });
  try {
    const v = await f.view();
    const input = { binding_id: randomUUID(), identifier: target.identifier };
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await (await v.call('open-online', input)).json()).value.outcome_unknown, true);
      assert.equal((await v.call('shutdown')).status, 409);
    }
    const known = await (await v.call('open-online', input)).json();
    assert.equal(known.value.ok, true);
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls.map(call => call.idempotencyKey)).size, 1);
    assert.equal(calls[0].expectedPrincipalId, target.principal_id);
    assert.equal((await v.call('ack-online', { ...input, receipt_id: known.online_receipt_id })).status, 200);
    assert.equal((await v.call('shutdown')).status, 200);
  } finally { await f.cleanup(); }
});

test('online opener bounds helper network time and carries caller cancellation without replacing keys', async () => {
  let helperSignal;
  const key = randomUUID();
  const parent = new AbortController();
  const opener = createOnlineOpener({ requestTimeoutMs: 20, deliver: async input => {
    assert.equal(input.idempotencyKey, key);
    helperSignal = input.signal;
    await new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); });
  } });
  const promise = opener({ bridge: { verifiedTarget: async () => ({}) }, idempotencyKey: key, signal: parent.signal });
  // AbortSignal.timeout 不保持 Node 事件循环，fixture 使用独立短期计时器。
  const hold = setTimeout(() => {}, 100);
  try {
    const result = await promise;
    assert.equal(result.outcome_unknown, true);
    assert.equal(helperSignal.aborted, true);
  } finally { clearTimeout(hold); }
  const aborting = createOnlineOpener({ deliver: async input => { parent.abort(); input.signal.throwIfAborted(); } });
  assert.equal((await aborting({ bridge: { verifiedTarget: async () => ({}) }, idempotencyKey: key, signal: parent.signal })).outcome_unknown, true);
  assert.equal((await aborting({ bridge: {}, idempotencyKey: 'arbitrary' })).error.code, 'LOCAL_INVALID_INPUT');
});

test('actual HTTP pagehide cancellation during pre-read reloads and recovers its not-sent checkpoint', async () => {
  const instance = randomUUID(), principal = randomUUID(), workspace = randomUUID(), project = randomUUID();
  const issue = { identifier: 'CFK-548', title: 'Isolated HTTP cancellation', version: 2, priority: 'none', status: { key: 'todo' }, project: { id: project }, allowed_actions: ['read', 'update'], comments: [] };
  const writes = [];
  let pause = true, entered, bridge, hostReply;
  const started = new Promise(resolve => { entered = resolve; });
  const createFacade = () => ({ callTool: async (name, args, { signal }) => {
    if (name === 'cfkanban_connection_inspect') return { ok: true, data: { instance: { instance_id: instance }, principal: { principal_id: principal, is_owner: true } } };
    if (name === 'cfkanban_projects_get') return { ok: true, data: { id: project } };
    if (name === 'cfkanban_statuses_list') return { ok: true, data: [{ key: 'todo' }] };
    if (name === 'cfkanban_issues_list') return { ok: true, data: { items: [issue], next_cursor: null } };
    if (name === 'cfkanban_issues_get') {
      if (pause) {
        pause = false; entered();
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { ok: true, data: issue };
    }
    if (name === 'cfkanban_comments_create') {
      writes.push(structuredClone(args));
      issue.comments = [{ id: randomUUID(), body: args.body }];
      return { ok: true, data: {} };
    }
    throw new Error('Unsupported isolated HTTP facade operation');
  } });
  const f = await fixture({ createFacade, createBridge: options => {
    bridge = new WorkbenchBridge(options);
    const call = bridge.call.bind(bridge);
    bridge.call = (...args) => {
      const result = call(...args);
      if (args[0] === 'mutate') hostReply = result;
      return result;
    };
    return bridge;
  } });
  let controller, resumed;
  try {
    const v = await f.view();
    const bound = (await (await v.call('bind', { instance_id: instance, expected_principal_id: principal, workspace_id: workspace, project_id: project })).json()).value.data;
    const makeRpc = current => ({ call: async (endpoint, payload, signal) => {
      if (['mutate', 'recover'].includes(endpoint)) assert.equal((await v.call('checkpoint', current().getCheckpoint())).status, 200);
      const response = await fetch(`${f.address}${v.pathname}api/${endpoint}`, {
        method: 'POST', headers: { cookie: v.cookie.split(';')[0], origin: f.address, 'content-type': 'application/json', 'x-cfkanban-csrf': v.config.csrf },
        body: JSON.stringify(payload), signal,
      });
      return response.json();
    } });
    const lifetime = new AbortController();
    controller = new WorkbenchController(makeRpc(() => controller), lifetime.signal);
    controller.patch({ binding: bound, issue });
    assert.equal(bridge.timeoutMs, 30_000);
    assert.equal(controller.requestTimeoutMs, 45_000);
    const writing = controller.mutate('comment', { body: 'Saved before pagehide' });
    await started;
    const original = structuredClone(controller.state.pending);
    assert.equal(bridge.hasPending(), true);
    lifetime.abort();
    await writing;
    const cancelled = await hostReply;
    assert.equal(cancelled.panel.write_stage, 'not_sent');
    assert.equal(cancelled.panel.original_settled, false);
    assert.equal(writes.length, 0);
    assert.equal((await v.call('shutdown')).status, 409);
    const reload = await fetch(`${f.address}${v.pathname}`, { headers: { cookie: v.cookie.split(';')[0] } });
    const config = JSON.parse(/<script type="application\/json" id="configuration">(.*?)<\/script>/.exec(await reload.text())[1]);
    assert.deepEqual(config.checkpoint.state.pending, original);
    assert.equal((await v.call('checkpoint', { ...config.checkpoint, state: { ...config.checkpoint.state, pending: { ...original, change: { body: 'Different request' } } } })).status, 409);
    resumed = new WorkbenchController(makeRpc(() => resumed), new AbortController().signal);
    assert.equal(await resumed.restoreCheckpoint(config.checkpoint), true);
    assert.equal((await resumed.mutate(null, null, true)).ok, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].idempotency_key, original.idempotency_key);
    assert.equal(writes[0].body, original.change.body);
    assert.equal(Object.hasOwn(writes[0], 'expected_version'), false);
    assert.equal(resumed.state.pending, null);
    assert.equal(resumed.canChangeBinding(), true);
    assert.equal(bridge.hasPending(), false);
    assert.equal((await v.call('checkpoint', resumed.getCheckpoint())).status, 200);
    assert.equal((await v.call('unbind', { binding_id: original.binding_id })).status, 200);
    assert.equal((await v.call('shutdown')).status, 200);
    assert.deepEqual(await f.closed, { closed: true, outcome_unknown: false, recovery: 'none' });
  } finally { controller?.dispose(); resumed?.dispose(); await f.cleanup(); }
});
