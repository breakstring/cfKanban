import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
const originalDocumentClass = globalThis.Document;
const originalShadowRoot = globalThis.ShadowRoot;
globalThis.Document = class {};
globalThis.ShadowRoot = class {};
after(() => { globalThis.Document = originalDocumentClass; globalThis.ShadowRoot = originalShadowRoot; });
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Component } from './apps/web/src/components/UsagePanel.vue'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
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
const { Component, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);



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
const snapshot = (status = 'fresh') => ({ generated_at: '2026-09-19T02:00:00.858Z', attachments: { enabled: false, reserved_bytes: 0, limit_bytes: 1073741824, limit_configured: true, settings_version: 1 }, cloudflare: { status, refreshing: false, collected_at: '2026-09-19T02:00:00.000Z', attempted_at: '2026-09-19T02:00:00.000Z', error: null, metrics: [{ key: 'd1_rows_read', unit: 'count', value: 0, period_start: '2026-09-19T00:00:00.000Z', period_end: '2026-09-19T02:00:00.000Z', observed_at: null }] } });

test('shows real zero separately from unknown, disabled budget, UTC window, and localized labels', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init) => { calls.push({path, init}); return Response.json(snapshot()); };
  locale.value = 'en';
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host);
    await until(() => text(host).includes('Snapshot available'));
    assert.match(text(host), /0 B \/ 1 GiB · 0% · Attachments disabled/);
    assert.match(text(host), /Budget read at: 2026-09-19 02:00:00 UTC/);
    assert.doesNotMatch(text(host), /\.858Z/);
    const details = all(host).find(item => item.tag === 'details');
    assert.ok(details); assert.equal(details.props.open, undefined);
    assert.match(text(details), /Window:.*00:00:00 UTC/);
    function visibleText(item) { return item.tag === 'details' ? '' : item.text + item.children.map(visibleText).join(''); }
    assert.doesNotMatch(visibleText(host), /Budget read at|Last attempt|Window:|Observed:/);
    assert.match(visibleText(host), /Updated/);
    assert.doesNotMatch(visibleText(host), /\d{2}:\d{2}:\d{2}/);
    const metricRows = all(host).filter(item => item.tag === 'div' && item.children.some(child => child.tag === 'dt'));
    assert.match(text(metricRows.find(item => text(item).startsWith('D1 rows read today'))), /today0$/);
    assert.match(text(metricRows.find(item => text(item).startsWith('D1 storage'))), /Unknown/);
    assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/v1/admin/usage'); assert.equal(calls[0].init.method, 'GET');
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /用量与限额/); assert.match(text(host), /未知/); assert.match(text(host), /不代表账户总用量/); assert.match(text(host), /项目配额仍在/); assert.match(text(host), /不包含当前小时/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('refresh failure retains visibly outdated data and successful retry replaces it', async () => {
  const originalFetch = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async () => { if (fail) throw Error('offline'); return Response.json(snapshot('stale')); };
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Stale snapshot'));
    fail = true;
    await all(host).find(item => item.tag === 'button').props.onClick(); await nextTick();
    assert.match(text(host), /Refresh failed.*previous snapshot/); assert.match(text(host), /0 B \/ 1 GiB/);
    fail = false;
    await all(host).find(item => item.tag === 'button').props.onClick(); await nextTick();
    assert.doesNotMatch(text(host), /Refresh failed/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('not configured suppresses obsolete cloud metrics and unmount aborts the request', async () => {
  const originalFetch = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_path, init) => { signal = init.signal; return Response.json(snapshot('not_configured')); };
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Not configured'));
    assert.doesNotMatch(text(host), /D1 rows read today/);
    app.unmount(); assert.equal(signal.aborted, true);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a superseded response cannot overwrite the latest snapshot', async () => {
  const originalFetch = globalThis.fetch;
  let completeFirst;
  let count = 0;
  globalThis.fetch = async () => ++count === 1 ? new Promise(resolve => { completeFirst = resolve; }) : Response.json(snapshot('pending'));
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host); await until(() => completeFirst);
    await all(host).find(item => item.tag === 'button').props.onClick(); await nextTick();
    assert.match(text(host), /Waiting for first snapshot/);
    completeFirst(Response.json(snapshot()));
    await new Promise(resolve => setTimeout(resolve, 20)); await nextTick();
    assert.match(text(host), /Waiting for first snapshot/); assert.doesNotMatch(text(host), /Snapshot available/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('opening shows the saved budget before a single stale collection, manual refresh uses its own mode', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const calls = [];
  let finish;
  globalThis.document = { cookie: 'cfkanban_csrf=test-csrf' };
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (init.method === 'GET') {
      const old = snapshot(); old.generated_at = '2026-09-19T02:16:00.000Z';
      return Response.json(old);
    }
    if (JSON.parse(init.body).mode === 'stale') return new Promise(resolve => { finish = resolve; });
    return Response.json(snapshot());
  };
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host); await until(() => finish);
    assert.match(text(host), /0 B \/ 1 GiB/);
    assert.equal(calls[1].path, '/api/v1/admin/usage/refresh');
    assert.equal(calls[1].init.headers.get('x-csrf-token'), 'test-csrf');
    assert.ok(calls[1].init.headers.get('idempotency-key'));
    finish(Response.json(snapshot())); await until(() => !all(host).find(item => item.tag === 'button').props.disabled);
    await all(host).find(item => item.tag === 'button').props.onClick(); await nextTick();
    assert.equal(calls.length, 3); assert.equal(JSON.parse(calls[2].init.body).mode, 'manual');
  } finally { app.unmount(); globalThis.fetch = originalFetch; globalThis.document = originalDocument; }
});

test('initial or failed snapshots collect once, while unconfigured and in-progress snapshots never poll', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ['pending', 'error', 'not_configured', 'refreshing']) {
      const calls = [];
      globalThis.fetch = async (_path, init) => {
        calls.push(init);
        const value = snapshot(state === 'refreshing' ? 'pending' : state);
        value.cloudflare.collected_at = null;
        value.cloudflare.refreshing = state === 'refreshing';
        return Response.json(value);
      };
      const app = renderer.createApp(Component); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('0 B / 1 GiB'));
        await new Promise(resolve => setTimeout(resolve, 20)); await nextTick();
        assert.equal(calls.length, ['pending', 'error'].includes(state) ? 2 : 1, state);
        if (calls.length === 2) assert.equal(JSON.parse(calls[1].body).mode, 'stale');
        if (state === 'refreshing') assert.match(text(host), /Collection is in progress/);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('Owner explicitly chooses unlimited or a byte-exact capacity without a preset budget', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (init.method === 'PATCH') return Response.json({ resource: { configured: true, version: calls.length, reserved_bytes: 0, limit_bytes: JSON.parse(init.body).limit_bytes } });
    const value = snapshot(); Object.assign(value.attachments, { limit_bytes: null, limit_configured: false, settings_version: 0 }); return Response.json(value);
  };
  const app = renderer.createApp(Component); const host = node('root');
  const click = async label => { await all(host).find(item => item.tag === 'button' && text(item) === label).props.onClick(); await nextTick(); };
  const submit = async () => { await all(host).find(item => item.tag === 'form').props.onSubmit({ preventDefault() {} }); await nextTick(); };
  try {
    app.mount(host); await until(() => text(host).includes('Not set'));
    assert.equal(all(host).some(item => item.tag === 'meter'), false);
    await click('Set limit');
    assert.equal(all(host).find(item => item.tag === 'select').props['onUpdate:modelValue'] !== undefined, true);
    await submit(); assert.equal(calls.filter(call => call.init.method === 'PATCH').length, 0);
    all(host).find(item => item.tag === 'select').props['onUpdate:modelValue']('unlimited'); await nextTick();
    await submit(); assert.match(text(host), /0 B \/ Unlimited/);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { expected_version: 0, limit_bytes: null });
    assert.ok(calls.at(-1).init.headers.get('idempotency-key'));
    assert.equal(all(host).some(item => item.tag === 'meter'), false);
    await click('Set limit');
    all(host).find(item => item.tag === 'select').props['onUpdate:modelValue']('limited'); await nextTick();
    all(host).find(item => item.tag === 'input').props['onUpdate:modelValue']('1.5');
    await submit(); assert.equal(JSON.parse(calls.at(-1).init.body).limit_bytes, 1572864);
    assert.match(text(host), /1.5 MiB/); assert.ok(all(host).some(item => item.tag === 'meter'));
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('capacity conflict retains draft and requires explicit settings readback before retry', async () => {
  const originalFetch = globalThis.fetch;
  let writes = 0;
  let saved;
  globalThis.fetch = async (path, init) => {
    if (init.method === 'PATCH') {
      writes++;
      if (writes === 1) {
        const id = '40000000-0000-4000-8000-000000000001';
        return Response.json({ code: 'VERSION_CONFLICT', category: 'conflict', source: 'service', message: 'Changed', recovery: 'refresh_resource', request_id: id, retryable: false, details: {} }, {status: 409, headers: {'x-request-id': id}});
      }
      saved = JSON.parse(init.body); return Response.json({resource: { configured: true, version: 3, reserved_bytes: 0, limit_bytes: saved.limit_bytes }});
    }
    if (path.endsWith('attachment-settings')) return Response.json({ configured: true, version: 2, reserved_bytes: 0, limit_bytes: 3000000 });
    return Response.json(snapshot());
  };
  const app = renderer.createApp(Component); const host = node('root');
  const click = async label => { await all(host).find(item => item.tag === 'button' && text(item) === label).props.onClick(); await nextTick(); };
  const submit = async () => { await all(host).find(item => item.tag === 'form').props.onSubmit({ preventDefault() {} }); await nextTick(); };
  try {
    app.mount(host); await until(() => text(host).includes('Set limit'));
    await click('Set limit');
    all(host).find(item => item.tag === 'input').props['onUpdate:modelValue']('2'); await nextTick();
    await submit(); assert.match(text(host), /Settings changed elsewhere/);
    await submit(); assert.equal(writes, 1);
    await click('Refresh settings'); await submit();
    assert.deepEqual(saved, { expected_version: 2, limit_bytes: 2097152 });
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('over-limit budget explicitly explains upload pause and preserves existing access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const value = snapshot(); value.attachments.reserved_bytes = value.attachments.limit_bytes * 2;
    return Response.json(value);
  };
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Storage limit reached'));
    assert.match(text(host), /200%/);
    assert.match(text(host), /New uploads are paused; existing attachments remain accessible/);
    assert.match(all(host).find(item => item.tag === 'meter').props.class, /capacity-reached/);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /已达到容量上限，新增上传已暂停；已有附件仍可访问/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});
