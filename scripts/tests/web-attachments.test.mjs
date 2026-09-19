import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach, beforeEach } from 'node:test';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Component } from './apps/web/src/components/IssueAttachments.vue'; export { clearAttachmentUploadDrafts } from './apps/web/src/lib/attachment-upload-drafts.ts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'vue-test', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
      const compiled = compileScript(descriptor, { id: 'attachment-test', inlineTemplate: true });
      return { contents: compiled.content, loader: 'ts', resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL('../../node_modules/vue/index.mjs', import.meta.url).href, external: true }));
  } }],
});
const { Component, clearAttachmentUploadDrafts } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
beforeEach(clearAttachmentUploadDrafts);
afterEach(clearAttachmentUploadDrafts);
const scope = { sessionId: 'session-one', principalId: 'writer' };

function node(tag, text = '') { return { tag, text, children: [], props: {}, parent: null, focus() {} }; }
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
const list = (items = [], enabled = true) => ({ items, has_more: false, next_cursor: null, capabilities: { attachments: enabled }, limits: { max_file_bytes: 10485760, max_active_per_issue: 20, max_storage_bytes: 1073741824 } });
const pending = { id: '10000000-0000-4000-8000-000000000001', filename: 'debug.log', size_bytes: 5, state: 'pending', version: 1, deleted_at: null, uploaded_by: { principal_id: 'writer', display_name: 'Writer' }, preview_content_type: null, allowed_actions: ['read', 'upload', 'delete'] };

test('internal navigation preserves reserve and upload recovery without making a second file', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const calls = [];
  let reserveCalls = 0;
  let stored = null;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (init.method === 'POST') {
      reserveCalls++;
      if (reserveCalls === 1) throw new Error('reservation response lost');
      return Response.json({ resource: pending });
    }
    if (init.method === 'PUT') { stored = { ...pending, state: 'ready', version: 2, allowed_actions: ['read', 'download', 'delete'] }; throw new Error('upload response lost'); }
    if (path.includes('/api/v1/attachments/')) return Response.json(stored);
    return Response.json(list(stored ? [stored] : []));
  };
  let host = node('root');
  let app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true });
  const returnToIssue = async () => {
    app.unmount();
    host = node('root');
    app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true });
    app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    assert.match(text(host), /debug.log.*Upload interrupted/);
  };
  try {
    app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    const input = all(host).find((element) => element.tag === 'input');
    input.props.onChange({ target: { files: { length: 1, item: () => new File(['hello'], 'debug.log', { type: 'text/plain' }) }, value: 'fixture' } });
    await nextTick();
    const click = async (label) => { const button = all(host).find((element) => element.tag === 'button' && text(element) === label); assert.ok(button, label); await button.props.onClick(); await nextTick(); };
    await click('Upload');
    assert.match(text(host), /Upload interrupted/);
    assert.equal(input.props.disabled, true, 'another file cannot replace an uncertain reservation');
    await returnToIssue();
    await click('Retry upload');
    assert.match(text(host), /Upload interrupted/);
    await returnToIssue();
    await click('Retry upload');
    assert.doesNotMatch(text(host), /Upload interrupted/);
    assert.match(text(host), /debug.log/);
    const reserves = calls.filter((call) => call.init.method === 'POST');
    assert.equal(reserves.length, 2);
    assert.equal(reserves[0].init.headers.get('idempotency-key'), reserves[1].init.headers.get('idempotency-key'));
    assert.equal(reserves[0].init.body, reserves[1].init.body);
    assert.equal(calls.filter((call) => call.init.method === 'PUT').length, 1, 'ready readback resolves an uncertain upload');
    assert.notEqual(reserves[0].init.headers.get('idempotency-key'), calls.find((call) => call.init.method === 'PUT').init.headers.get('idempotency-key'));
  } finally { app.unmount(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('attachment readers and disabled storage never expose file selection', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    for (const { canUpload, enabled } of [{ canUpload: false, enabled: true }, { canUpload: true, enabled: false }]) {
      globalThis.fetch = async () => Response.json(list([], enabled));
      const host = node('root');
      const app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload });
      app.mount(host);
      await until(() => !text(host).includes('Loading attachments'));
      assert.equal(all(host).some((element) => element.tag === 'input'), false);
      if (!enabled) assert.match(text(host), /storage is not enabled/);
      app.unmount();
    }
  } finally { globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('returning to a pending reservation reuses the original File and PUT key', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const calls = [];
  let attempts = 0;
  let stored = pending;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (init.method === 'POST') return Response.json({ resource: pending });
    if (init.method === 'PUT') {
      if (++attempts === 1) throw new Error('network interrupted before upload completed');
      stored = { ...pending, state: 'ready', version: 2, allowed_actions: ['read', 'download', 'delete'] };
      return Response.json({ resource: stored });
    }
    if (path.includes('/api/v1/attachments/')) return Response.json(stored);
    return Response.json(list(attempts ? [stored] : []));
  };
  let host = node('root');
  let app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true });
  try {
    app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    const file = new File(['hello'], 'debug.log');
    all(host).find((element) => element.tag === 'input').props.onChange({ target: { files: { length: 1, item: () => file }, value: 'fixture' } });
    await nextTick();
    await all(host).find((element) => element.tag === 'button' && text(element) === 'Upload').props.onClick();
    app.unmount();
    host = node('root'); app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true }); app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'button' && text(element) === 'Retry upload'));
    await all(host).find((element) => element.tag === 'button' && text(element) === 'Retry upload').props.onClick();
    const uploads = calls.filter((call) => call.init.method === 'PUT');
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].init.body, file);
    assert.equal(uploads[1].init.body, file);
    assert.equal(uploads[0].init.headers.get('idempotency-key'), uploads[1].init.headers.get('idempotency-key'));
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
    assert.ok(calls.some((call) => call.path === `/api/v1/attachments/${pending.id}` && call.init.method === 'GET'));
  } finally { app.unmount(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('leaving an Issue stops a late reservation response from starting its upload', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let releaseReservation;
  let reservationStarted = false;
  let uploadCount = 0;
  let reservationSignal;
  globalThis.fetch = async (_path, init) => {
    if (init.method === 'POST') {
      reservationStarted = true;
      reservationSignal = init.signal;
      return new Promise((done) => { releaseReservation = () => done(Response.json({ resource: pending })); });
    }
    if (init.method === 'PUT') uploadCount++;
    return Response.json(list());
  };
  const host = node('root');
  const app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true });
  let unmounted = false;
  try {
    app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    all(host).find((element) => element.tag === 'input').props.onChange({ target: { files: { length: 1, item: () => new File(['hello'], 'debug.log') }, value: 'fixture' } });
    await nextTick();
    const upload = all(host).find((element) => element.tag === 'button' && text(element) === 'Upload').props.onClick();
    await until(() => reservationStarted);
    app.unmount();
    unmounted = true;
    assert.equal(reservationSignal.aborted, true);
    releaseReservation();
    await upload;
    assert.equal(uploadCount, 0);
  } finally { if (!unmounted) app.unmount(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('upload drafts stay within the Issue and session, and session teardown removes bytes and navigation warnings', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const listeners = new Map();
  globalThis.window = { addEventListener(name, handler) { listeners.set(name, handler); }, removeEventListener(name) { listeners.delete(name); } };
  globalThis.fetch = async () => Response.json(list());
  let app;
  async function open(props = {}) {
    app?.unmount();
    const host = node('root');
    app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true, ...props });
    app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    return host;
  }
  try {
    const first = await open();
    all(first).find((element) => element.tag === 'input').props.onChange({ target: { files: { length: 1, item: () => new File(['hello'], 'private-draft.log') }, value: 'fixture' } });
    await nextTick();
    assert.doesNotMatch(text(await open({ identifier: 'CFK-2' })), /private-draft.log/);
    assert.doesNotMatch(text(await open({ sessionId: 'session-two' })), /private-draft.log/);
    assert.doesNotMatch(text(await open({ principalId: 'another-principal' })), /private-draft.log/);
    assert.match(text(await open()), /private-draft.log/);
    app.unmount(); app = null;
    const warning = { prevented: false, preventDefault() { this.prevented = true; } };
    listeners.get('beforeunload')(warning);
    assert.equal(warning.prevented, true, 'reload warning remains active while another route is open');
    clearAttachmentUploadDrafts();
    assert.equal(listeners.has('beforeunload'), false);
    assert.doesNotMatch(text(await open()), /private-draft.log/, 'logout or session boundary change clears its File');
  } finally { app?.unmount(); clearAttachmentUploadDrafts(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('session teardown fences an in-flight reservation before the component unmounts', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let releaseReservation;
  let uploadCount = 0;
  globalThis.fetch = async (_path, init) => {
    if (init.method === 'POST') return new Promise((done) => { releaseReservation = () => done(Response.json({ resource: pending })); });
    if (init.method === 'PUT') uploadCount++;
    return Response.json(list());
  };
  const host = node('root');
  const app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true });
  try {
    app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    all(host).find((element) => element.tag === 'input').props.onChange({ target: { files: { length: 1, item: () => new File(['hello'], 'debug.log') }, value: 'fixture' } });
    await nextTick();
    const upload = all(host).find((element) => element.tag === 'button' && text(element) === 'Upload').props.onClick();
    await until(() => releaseReservation !== undefined);
    clearAttachmentUploadDrafts();
    releaseReservation();
    await upload;
    assert.equal(uploadCount, 0);
  } finally { app.unmount(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('verified loss of Issue access forgets a saved upload draft', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  let denied = false;
  globalThis.fetch = async () => {
    if (!denied) return Response.json(list());
    const requestId = '40000000-0000-4000-8000-000000000001';
    return Response.json({ code: 'FORBIDDEN', category: 'authorization', source: 'service', message: 'Access revoked', recovery: 'request_access', request_id: requestId, retryable: false, details: {} }, { status: 403, headers: { 'x-request-id': requestId } });
  };
  let host = node('root');
  let app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true });
  try {
    app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    all(host).find((element) => element.tag === 'input').props.onChange({ target: { files: { length: 1, item: () => new File(['hello'], 'private-draft.log') }, value: 'fixture' } });
    await nextTick();
    app.unmount();
    denied = true;
    host = node('root'); app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true }); app.mount(host);
    await until(() => !text(host).includes('Loading attachments'));
    app.unmount();
    denied = false;
    host = node('root'); app = renderer.createApp(Component, { ...scope, identifier: 'CFK-1', canUpload: true }); app.mount(host);
    await until(() => all(host).some((element) => element.tag === 'input'));
    assert.doesNotMatch(text(host), /private-draft.log/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('attachment limits distinguish issue slots from retained instance storage', async () => {
  const { presentApiProblem } = await import('../../apps/web/src/lib/error-presentation.ts');
  const problem = (code) => ({ status: 409, retryAfter: null, body: { code, category: 'business_quota', source: 'service', request_id: 'request', retryable: false, recovery: 'free_capacity_or_request_owner', details: {}, message: 'Untrusted server wording' } });
  const translated = () => 'Generic Project quota';
  const slots = presentApiProblem(problem('ISSUE_ATTACHMENT_LIMIT_REACHED'), 'en', translated);
  const storage = presentApiProblem(problem('ATTACHMENT_STORAGE_LIMIT_REACHED'), 'zh-CN', translated);
  assert.match(slots, /issue has reached its attachment limit/);
  assert.match(storage, /软删除附件不会释放存储预算/);
  assert.doesNotMatch(slots + storage, /Generic Project quota|Untrusted server wording/);
});
