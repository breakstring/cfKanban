import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({ stdin: { contents: `export { WorkbenchAdapter, projectSnapshot } from './packages/local-runtime/src/workbench/embed-adapter.mjs'; export { createEmbedClient } from './apps/web/src/embedded/client.ts'; export * from './apps/web/src/embedded/protocol.ts';`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { WorkbenchAdapter, projectSnapshot, createEmbedClient, emptySnapshot, parseRenderTarget, parseRenderCheckMessage, parseRenderedMessage, parseRenderCancelMessage, snapshotRenderTarget } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await tick(); await tick(); };
const target = () => ({ instance_id: randomUUID(), principal_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() });
const port = () => ({ messages: [], closed: false, start() {}, close() { this.closed = true; }, postMessage(value) { this.messages.push(structuredClone(value)); } });
const lastCheck = surface => surface.messages.filter(message => message.type === 'render_check').at(-1);
const acknowledge = (adapter, check, changes = {}) => adapter.receive({ ...check, type: 'rendered', ...changes });
function fixture() {
  const expected = target();
  const abort = new AbortController();
  const listeners = new Set();
  const controller = {
    signal: abort.signal,
    state: { ...emptySnapshot(), workspace_id: randomUUID(), binding: { project: { id: expected.project_id, workspace_id: expected.workspace_id }, identity: { instance: { instance_id: expected.instance_id }, principal: { principal_id: expected.principal_id } }, statuses: [{ key: 'todo' }] }, page: { items: [] } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    patch(change) { this.state = { ...this.state, ...change }; for (const listener of listeners) listener(); },
  };
  const adapter = new WorkbenchAdapter(controller);
  return { adapter, controller, expected, abort, listeners };
}
async function unsettled(promise) {
  let settled = false;
  promise.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
}

test('render receipts accept only the bounded target and dedicated message fields', () => {
  const expected = target();
  const id = randomUUID();
  assert.deepEqual(parseRenderTarget(expected), expected);
  assert.ok(parseRenderTarget({ ...expected, identifier: 'CFK-548' }));
  assert.ok(parseRenderCheckMessage({ type: 'render_check', id, target: expected }));
  assert.ok(parseRenderedMessage({ type: 'rendered', id, target: expected }));
  assert.ok(parseRenderCancelMessage({ type: 'render_cancel', id }));
  for (const invalid of [{ ...expected, identifier: '../issue' }, { ...expected, principal_id: 'name' }, { ...expected, secret: 'hidden' }, { ...expected, expected_version: 1 }, { project_id: expected.project_id }]) {
    assert.equal(parseRenderTarget(invalid), null);
    assert.equal(parseRenderedMessage({ type: 'rendered', id, target: invalid }), null);
  }
  for (const parser of [parseRenderCheckMessage, parseRenderedMessage, parseRenderCancelMessage]) {
    assert.equal(parser({ type: 'rendered', id, target: expected, operation: 'update' }), null);
    assert.equal(parser({ type: 'rendered', id: 'old', target: expected }), null);
  }
});

test('every published snapshot gets a fresh challenge and stale or wrong-target confirmations cannot complete it', async () => {
  const f = fixture();
  const surface = port();
  f.adapter.attach(surface);
  try {
    assert.equal(surface.messages[0].state.workspace_id, f.expected.workspace_id, 'the real bound Project takes precedence over a previous manual workspace');
    assert.deepEqual(snapshotRenderTarget(surface.messages[0].state), f.expected);
    const waiting = f.adapter.waitForRendered(f.expected);
    const first = lastCheck(surface);
    assert.ok(first);
    await acknowledge(f.adapter, first, { id: randomUUID() });
    await acknowledge(f.adapter, first, { target: { ...f.expected, project_id: randomUUID() } });
    await acknowledge(f.adapter, first, { unexpected: true });
    await unsettled(waiting);
    f.controller.patch({ notice: 'new snapshot of the same target' });
    const latest = lastCheck(surface);
    assert.notEqual(latest.id, first.id);
    await acknowledge(f.adapter, first);
    await unsettled(waiting);
    await acknowledge(f.adapter, latest);
    assert.deepEqual(await waiting, { ok: true, target: f.expected, receipt_id: latest.id });
    assert.equal(f.adapter.attempts.length, 0, 'render receipts do not enter the business-action dispatcher');
  } finally { f.adapter.dispose(); }
});

test('new waits replace older waits and changing the current project or Issue invalidates the receipt', async () => {
  const f = fixture();
  const surface = port();
  f.adapter.attach(surface);
  try {
    const oldWait = f.adapter.waitForRendered(f.expected);
    const oldCheck = lastCheck(surface);
    const current = f.adapter.waitForRendered(f.expected);
    assert.equal((await oldWait).error.code, 'PANEL_RENDER_REPLACED');
    await acknowledge(f.adapter, oldCheck);
    await unsettled(current);
    f.controller.patch({ issue: { identifier: 'CFK-1', title: 'Opened issue', version: 1, priority: 'none', status: { key: 'todo' } } });
    assert.equal((await current).error.code, 'PANEL_RENDER_TARGET_CHANGED');
    assert.equal((await f.adapter.waitForRendered(f.expected)).error.code, 'PANEL_RENDER_TARGET_CHANGED', 'an Issue view is not a project-only view');
    const issueTarget = { ...f.expected, identifier: 'CFK-1' };
    const issueWait = f.adapter.waitForRendered(issueTarget);
    const issueCheck = lastCheck(surface);
    f.controller.state = { ...f.controller.state, binding: { ...f.controller.state.binding, project: { id: randomUUID(), workspace_id: f.expected.workspace_id } } };
    await acknowledge(f.adapter, issueCheck);
    assert.equal((await issueWait).error.code, 'PANEL_RENDER_TARGET_CHANGED', 'receipt handling rechecks current facts even without a subscription event');
  } finally { f.adapter.dispose(); }

  const unattached = fixture();
  const waiting = unattached.adapter.waitForRendered(unattached.expected);
  unattached.controller.patch({ binding: null });
  assert.equal((await waiting).error.code, 'PANEL_RENDER_TARGET_CHANGED', 'target changes also cancel waits before the first frame attaches');
  unattached.adapter.dispose();
});

test('waiting before first attach is bounded, and cancellation, timeout, frame reload and disposal expire all old receipts', async () => {
  const f = fixture();
  const abort = new AbortController();
  const surface = port();
  try {
    const beforeAttach = f.adapter.waitForRendered(f.expected, { signal: abort.signal });
    await unsettled(beforeAttach);
    f.adapter.frameLoaded({ contentWindow: { postMessage() {} } }, 'en', () => ({ port1: surface, port2: port() }));
    const abortedCheck = lastCheck(surface);
    abort.abort();
    assert.equal((await beforeAttach).error.code, 'PANEL_RENDER_ABORTED');
    assert.deepEqual(surface.messages.at(-1), { type: 'render_cancel', id: abortedCheck.id });
    const timed = f.adapter.waitForRendered(f.expected, { timeoutMs: 10 });
    const timedCheck = lastCheck(surface);
    await acknowledge(f.adapter, abortedCheck);
    assert.equal((await timed).error.code, 'PANEL_RENDER_TIMEOUT');
    const reloaded = f.adapter.waitForRendered(f.expected);
    await acknowledge(f.adapter, timedCheck);
    await unsettled(reloaded);
    f.adapter.frameLoaded({}, 'en');
    assert.equal((await reloaded).error.code, 'PANEL_FRAME_RELOADED');
    assert.equal(surface.closed, true);
    assert.equal((await f.adapter.waitForRendered(f.expected)).error.code, 'PANEL_RENDER_UNAVAILABLE');
  } finally { f.adapter.dispose(); }

  const lifetime = fixture();
  const nextPort = port();
  lifetime.adapter.attach(nextPort);
  const unmounted = lifetime.adapter.waitForRendered(lifetime.expected);
  const abandoned = lastCheck(nextPort);
  lifetime.abort.abort();
  assert.equal((await unmounted).error.code, 'PANEL_RENDER_UNAVAILABLE');
  assert.equal(lifetime.listeners.size, 0);
  await acknowledge(lifetime.adapter, abandoned);
  assert.equal((await lifetime.adapter.waitForRendered(lifetime.expected)).error.code, 'PANEL_RENDER_UNAVAILABLE');
});

test('a detached Port cannot confirm a challenge belonging to its replacement', async () => {
  const f = fixture();
  const oldPort = port();
  const currentPort = port();
  f.adapter.attach(oldPort);
  try {
    const oldWait = f.adapter.waitForRendered(f.expected);
    f.adapter.attach(currentPort);
    assert.equal((await oldWait).error.code, 'PANEL_RENDER_UNAVAILABLE');
    const current = f.adapter.waitForRendered(f.expected);
    const message = { ...lastCheck(currentPort), type: 'rendered' };
    oldPort.onmessage({ data: message });
    await unsettled(current);
    currentPort.onmessage({ data: message });
    assert.equal((await current).ok, true);
  } finally { f.adapter.dispose(); }
});

function child(afterRender) {
  const parent = {};
  const listeners = new Set();
  const surface = { parent, addEventListener(_name, listener) { listeners.add(listener); }, removeEventListener(_name, listener) { listeners.delete(listener); } };
  const channel = new MessageChannel();
  const messages = [];
  const snapshots = [];
  const errors = [];
  const client = createEmbedClient({ window: surface, onConnect() {}, onSnapshot: value => snapshots.push(value), onError: code => errors.push(code), ...(afterRender ? { afterRender } : {}) });
  for (const listener of listeners) listener({ source: parent, data: { type: 'cfkanban.embed.connect', protocol: 1, locale: 'en' }, ports: [channel.port1] });
  channel.port2.on('message', message => messages.push(message));
  return { client, snapshots, messages, errors, parentPort: channel.port2, send: value => channel.port2.postMessage(value), close() { client.dispose(); channel.port2.close(); } };
}

test('Adapter and child complete a real MessagePort round trip only after the applied snapshot render hook', async () => {
  const f = fixture();
  let finishRender;
  const c = child(() => new Promise(resolve => { finishRender = resolve; }));
  try {
    const waiting = f.adapter.waitForRendered(f.expected);
    f.adapter.attach(c.parentPort);
    await flush();
    assert.deepEqual(snapshotRenderTarget(c.snapshots.at(-1)), f.expected);
    assert.equal(typeof finishRender, 'function');
    await unsettled(waiting);
    finishRender();
    const result = await waiting;
    assert.equal(result.ok, true);
    assert.deepEqual(result.target, f.expected);
    assert.equal(f.adapter.receipts.size, 0, 'the confirmation creates no business operation receipt');
  } finally { f.adapter.dispose(); c.close(); }
});

test('child confirms only after the current snapshot is rendered, rejecting superseded, canceled and unmounted callbacks', async () => {
  const f = fixture();
  const renders = [];
  const c = child(() => new Promise(resolve => renders.push(resolve)));
  const check = () => ({ type: 'render_check', id: randomUUID(), target: f.expected });
  try {
    c.send(check());
    await flush();
    assert.equal(renders.length, 0, 'a target cannot be confirmed before a snapshot exists');
    const snapshot = { type: 'snapshot', state: projectSnapshot(f.controller.state, null) };
    c.send(snapshot);
    const old = check();
    c.send(old);
    await flush();
    assert.equal(c.snapshots.length, 1);
    assert.equal(c.messages.length, 0);
    assert.equal(renders.length, 1);
    c.send(snapshot);
    const current = check();
    c.send(current);
    await flush();
    renders.shift()();
    await flush();
    assert.equal(c.messages.length, 0, 'a newer snapshot invalidates the older render callback');
    c.send({ type: 'render_cancel', id: old.id });
    await flush();
    renders.shift()();
    await flush();
    assert.deepEqual(c.messages, [{ ...current, type: 'rendered' }], 'cancellation of an old challenge does not cancel the current one');
    const canceled = check();
    c.send(canceled);
    await flush();
    c.send({ type: 'render_cancel', id: canceled.id });
    await flush();
    renders.shift()();
    await flush();
    assert.equal(c.messages.length, 1);
    c.send({ ...check(), target: { ...f.expected, principal_id: randomUUID() } });
    await flush();
    assert.equal(renders.length, 0, 'identity mismatch cannot start a render confirmation');
    c.send(check());
    await flush();
    c.client.dispose();
    renders.shift()();
    await flush();
    assert.equal(c.messages.length, 1);
  } finally { c.close(); f.adapter.dispose(); }
});

test('clients without a render lifecycle hook never claim that a snapshot was rendered', async () => {
  const f = fixture();
  const c = child();
  try {
    c.send({ type: 'snapshot', state: projectSnapshot(f.controller.state, null) });
    c.send({ type: 'render_check', id: randomUUID(), target: f.expected });
    await flush();
    assert.equal(c.snapshots.length, 1);
    assert.deepEqual(c.messages, []);
    assert.deepEqual(c.errors, []);
  } finally { c.close(); f.adapter.dispose(); }
});
