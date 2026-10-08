import { nuxtUiTestPlugin } from "./nuxt-ui-test-plugin.mjs";
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
import { createRenderer, h, nextTick, ref } from 'vue';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Component } from './apps/web/src/components/UsageHistoryPanel.vue'; export { locale } from './apps/web/src/lib/i18n.ts'; export { clearPendingRequestIntents } from './apps/web/src/lib/api.ts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [nuxtUiTestPlugin(), { name: 'vue-test', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
      const compiled = compileScript(descriptor, { id: 'attachment-test', inlineTemplate: true });
      return { contents: compiled.content, loader: 'ts', resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL('../../node_modules/vue/index.mjs', import.meta.url).href, external: true }));
  } }],
});
const { Component, locale, clearPendingRequestIntents } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);



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
const windowListeners = new Map();
const originalWindow = globalThis.window; const originalDocument = globalThis.document;
globalThis.document = { cookie: 'cfkanban_csrf=fixture-csrf', documentElement: { lang: 'en' } };
globalThis.window = { location: { origin: 'https://kanban.example.test' },
  addEventListener(type, listener) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(listener); },
  removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
  dispatchEvent(event) { for (const listener of windowListeners.get(event.type) ?? []) listener(event); } };
after(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });
const base = '/api/v1/admin/usage/history';
const generated = '2026-10-08T10:00:00.000Z';
const nextDay = day => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
function metric(day, value, overrides = {}) { return { key: 'd1_rows_read', value, unit: 'count', scope: 'instance', period_start: `${day}T00:00:00.000Z`, period_end: nextDay(day), observed_at: null, ...overrides }; }
function item(day, metrics = [metric(day, 0)]) { return { day, collected_at: generated, metrics, complete_day: true }; }
function snapshot(overrides = {}) { return { enabled: true, retention_days: 90, generated_at: generated, items: [item('2026-10-07')], missing_days: [], source: 'cloudflare_analytics', history_kind: 'utc_daily', error: null, ...overrides }; }
const problem = status => {
  const id = crypto.randomUUID();
  return Response.json({ code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', category: status === 401 ? 'authentication' : 'authorization', source: 'service', message: 'not for display', recovery: 'request_owner', request_id: id, retryable: false, details: {} }, { status, headers: { 'x-request-id': id } });
};
function fixture(handler = () => Response.json(snapshot())) {
  clearPendingRequestIntents('POST', `${base}/collect`);
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (path, init) => { const call = { path, method: init.method, init, body: init.body ? JSON.parse(init.body) : null }; calls.push(call); return handler(call, calls); };
  return { calls, restore() { globalThis.fetch = originalFetch; clearPendingRequestIntents('POST', `${base}/collect`); } };
}
function mount(props = {}) { const host = node('root'); const app = renderer.createApp({ render: () => h(Component, typeof props === 'function' ? props() : props) }); app.mount(host); return { host, app }; }
async function flush() { for (let i = 0; i < 12; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick(); } }
const button = (host, label) => all(host).find(item => item.tag === 'button' && text(item) === label);
const change = (input, value) => input.props['onUpdate:modelValue'](value);
const select = (host, label) => all(host).find(item => item.tag === 'label' && text(item).startsWith(label))?.children.find(item => item.tag === 'select');
const row = (host, day) => all(host).find(item => item.tag === 'tr' && item.children.some(child => child.tag === 'th' && text(child) === day));
const valueAt = (host, day) => text(row(host, day).children.find(item => item.tag === 'td'));
const chart = host => all(host).find(item => item.tag === 'figure');

test('disabled history stays read-only and points to the unified settings above', async () => {
  const f = fixture(() => Response.json(snapshot({ enabled: false, items: [], missing_days: ['2026-10-07'] })));
  const v = mount();
  try {
    await until(() => text(v.host).includes('Daily records are off'));
    assert.match(text(v.host), /Usage & access settings above/); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
    assert.equal(chart(v.host), undefined); assert.equal(button(v.host, 'Enable daily history'), undefined); assert.doesNotMatch(text(v.host), /Read history|Collect day|Refresh history/);
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(v.host), /每日记录已关闭.*用量与访问设置/); assert.equal(button(v.host, '开启每日记录'), undefined);
  } finally { locale.value = 'en'; v.app.unmount(); f.restore(); }
});

test('enabled history automatically collects only the latest missing complete day among the recent seven days', async () => {
  let collected = false;
  const f = fixture(call => {
    if (call.method === 'POST') { collected = true; return Response.json(snapshot()); }
    return Response.json(snapshot({ items: [item('2026-10-06'), ...(collected ? [item('2026-10-07', [metric('2026-10-07', 25)])] : [])], missing_days: collected ? ['2026-10-05', '2026-09-01'] : ['2026-10-05', '2026-10-07', '2026-09-01'] }));
  });
  const v = mount();
  try {
    await until(() => chart(v.host) && valueAt(v.host, '2026-10-07') === '25 count'); await flush();
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST', 'GET']);
    assert.deepEqual(f.calls[1].body, { day: '2026-10-07' }); assert.ok(f.calls[1].init.headers.get('idempotency-key'));
    assert.equal(f.calls[1].init.headers.get('x-csrf-token'), 'fixture-csrf');
    assert.equal(valueAt(v.host, '2026-10-05'), 'Unknown'); assert.equal(button(v.host, 'Collect day'), undefined);
  } finally { v.app.unmount(); f.restore(); }
});

test('history missing only older days or awaiting Cloudflare configuration never starts collection', async () => {
  for (const value of [snapshot({ missing_days: ['2026-09-01', '2026-09-30'] }), snapshot({ missing_days: ['2026-10-07'], error: 'not_configured' })]) {
    const f = fixture(() => Response.json(value)); const v = mount();
    try { await until(() => Boolean(chart(v.host))); await flush(); assert.equal(f.calls.length, 1); }
    finally { v.app.unmount(); f.restore(); }
  }
});

test('an uncertain collection performs at most three readbacks and never repeats the write', async context => {
  const f = fixture((call, calls) => { if (calls.length === 1) return Response.json(snapshot({ missing_days: ['2026-10-07'] })); throw new Error(call.method === 'POST' ? 'collection result lost' : 'readback unavailable'); });
  context.mock.timers.enable({ apis: ['setTimeout'] }); const v = mount();
  try {
    await flush(); assert.equal(f.calls.length, 2);
    for (const delay of [1000, 3000, 5000, 60000]) { context.mock.timers.tick(delay); await flush(); }
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'GET').length, 4);
    assert.match(text(v.host), /Updating recent history/);
  } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('a successful readback after an uncertain collection displays its record without collecting another missing day', async context => {
  const f = fixture((call, calls) => {
    if (call.method === 'POST') throw new Error('collection response lost');
    return Response.json(calls.length === 1 ? snapshot({ items: [], missing_days: ['2026-10-07', '2026-10-06'] }) : snapshot({ items: [item('2026-10-07', [metric('2026-10-07', 9)])], missing_days: ['2026-10-06'] }));
  });
  context.mock.timers.enable({ apis: ['setTimeout'] }); const v = mount();
  try {
    await flush(); context.mock.timers.tick(1000); await flush(); context.mock.timers.tick(60000); await flush();
    assert.equal(valueAt(v.host, '2026-10-07'), '9 count'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'GET').length, 2);
  } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('refreshGeneration reloads current history while the collection cooldown prevents a repeated missing-day write', async () => {
  const version = ref(0); const f = fixture(call => Response.json(snapshot({ items: [item('2026-10-07', [metric('2026-10-07', version.value ? 11 : 0)])], missing_days: ['2026-10-06'] })));
  const v = mount(() => ({ refreshGeneration: version.value }));
  try {
    await until(() => f.calls.length === 3 && chart(v.host)); await flush();
    version.value++; await until(() => valueAt(v.host, '2026-10-07') === '11 count');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.calls.at(-1).path, `${base}?days=30`);
  } finally { v.app.unmount(); f.restore(); }
});

test('changing the period invalidates earlier responses and does not trigger collection', async () => {
  let finishSeven;
  const f = fixture(call => {
    if (call.path.endsWith('days=7')) return new Promise(resolve => { finishSeven = resolve; });
    return Response.json(snapshot({ items: [item('2026-10-07', [metric('2026-10-07', call.path.endsWith('days=90') ? 90 : 30)])] }));
  });
  const v = mount();
  try {
    await until(() => Boolean(chart(v.host))); change(select(v.host, 'Period'), '7'); await until(() => Boolean(finishSeven));
    change(select(v.host, 'Period'), '90'); await flush(); assert.equal(valueAt(v.host, '2026-10-07'), '90 count');
    finishSeven(Response.json(snapshot({ items: [item('2026-10-07', [metric('2026-10-07', 7)])], missing_days: ['2026-10-06'] }))); await flush();
    assert.equal(valueAt(v.host, '2026-10-07'), '90 count'); assert.equal(f.calls.some(call => call.method === 'POST'), false);
    assert.equal(all(chart(v.host)).filter(item => item.tag === 'tbody')[0].children.filter(item => item.tag === 'tr').length, 90);
    assert.equal(f.calls.find(call => call.path.endsWith('days=7')).init.signal.aborted, true);
  } finally { v.app.unmount(); f.restore(); }
});

test('permission loss clears previously rendered data during both regular loads and automatic readbacks', async context => {
  for (const status of [401, 403]) {
    for (const stage of ['load', 'readback']) {
      const version = ref(0); let fail = false;
      const f = fixture((_call, calls) => {
        if (!fail) return Response.json(snapshot());
        if (stage === 'readback' && calls.length === 2) throw new Error('temporary error');
        return problem(status);
      });
      context.mock.timers.enable({ apis: ['setTimeout'] }); const v = mount(() => ({ refreshGeneration: version.value }));
      try {
        await flush(); assert.ok(chart(v.host)); fail = true; version.value++; await flush();
        if (stage === 'readback') { assert.ok(chart(v.host)); context.mock.timers.tick(1000); await flush(); }
        assert.equal(chart(v.host), undefined, `${stage} ${status} must clear protected history`);
        const reads = f.calls.length; context.mock.timers.tick(60000); await flush(); assert.equal(f.calls.length, reads, 'authorization failure must not keep polling');
      } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
    }
  }
});

test('daily count series retain zero and leave wrong units, incomplete windows and missing dates empty', async () => {
  const value = snapshot({ items: [
    item('2026-10-07', [metric('2026-10-07', 12)]),
    item('2026-10-06', [metric('2026-10-06', 13, { unit: 'bytes' })]),
    item('2026-10-05', [metric('2026-10-05', 14, { period_end: '2026-10-05T12:00:00.000Z' })]),
    item('2026-10-04', [metric('2026-10-04', 15, { period_start: null, period_end: null, observed_at: '2026-10-04T12:00:00.000Z' })]),
    item('2026-10-03', [metric('2026-10-03', 0)]),
  ] });
  const f = fixture(() => Response.json(value)); const v = mount();
  try {
    await until(() => Boolean(chart(v.host)));
    assert.equal(valueAt(v.host, '2026-10-07'), '12 count'); assert.equal(valueAt(v.host, '2026-10-03'), '0 count');
    for (const day of ['2026-10-06', '2026-10-05', '2026-10-04', '2026-10-02']) assert.equal(valueAt(v.host, day), 'Unknown', day);
    assert.equal(all(chart(v.host)).filter(item => item.tag === 'circle').length, 2);
    assert.equal(all(chart(v.host)).filter(item => item.tag === 'polyline').length, 2);
  } finally { v.app.unmount(); f.restore(); }
});

test('storage preserves within-day observation timestamps and rejects observations belonging to another day', async () => {
  const observed = (day, time, amount) => item(day, [metric(day, amount, { key: 'd1_storage_bytes', unit: 'bytes', period_start: null, period_end: null, observed_at: time })]);
  const f = fixture(() => Response.json(snapshot({ items: [observed('2026-10-07', '2026-10-07T11:22:33.000Z', 2048), observed('2026-10-06', '2026-10-07T00:00:00.000Z', 999)] })));
  const v = mount();
  try {
    await until(() => Boolean(chart(v.host))); assert.equal(valueAt(v.host, '2026-10-07'), '2,048 bytes');
    assert.match(text(row(v.host, '2026-10-07')), /2026-10-07 11:22:33 UTC/);
    assert.equal(valueAt(v.host, '2026-10-06'), 'Unknown'); assert.equal(all(chart(v.host)).filter(item => item.tag === 'circle').length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('scope selection displays distinct account values without issuing another API call', async () => {
  const f = fixture(() => Response.json(snapshot({ items: [item('2026-10-07', [metric('2026-10-07', 10), metric('2026-10-07', 80, { scope: 'account' })])] })));
  const v = mount();
  try {
    await until(() => Boolean(chart(v.host))); assert.equal(valueAt(v.host, '2026-10-07'), '10 count');
    change(select(v.host, 'Scope'), 'account'); await nextTick(); assert.equal(valueAt(v.host, '2026-10-07'), '80 count');
    change(select(v.host, 'Scope'), 'instance'); await nextTick(); assert.equal(valueAt(v.host, '2026-10-07'), '10 count');
    assert.equal(f.calls.length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('focus cooldown keeps a fresh history read bounded and unmount stops scheduled work', async context => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const f = fixture(); const v = mount();
  try {
    await until(() => Boolean(chart(v.host))); window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.length, 1);
    now += 60_000; window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.length, 2);
    assert.equal(f.calls.every(call => call.method === 'GET'), true); v.app.unmount();
    now += 60_000; window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.length, 2);
    assert.equal(f.calls.at(-1).init.signal.aborted, true);
  } finally { Date.now = originalNow; v.app.unmount(); f.restore(); }
});
