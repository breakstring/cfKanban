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
  stdin: { contents: `export { default as Component } from './apps/web/src/components/UsagePanel.vue'; export { default as SettingsComponent } from './apps/web/src/components/AttachmentStorageSettings.vue'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
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
const { Component, SettingsComponent, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);



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

const windowListeners = new Map();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
globalThis.document = { cookie: 'cfkanban_csrf=fixture-csrf', documentElement: { lang: 'en' } };
globalThis.window = {
  location: { origin: 'https://kanban.example.test' },
  addEventListener(type, listener) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(listener); },
  removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
  dispatchEvent(event) { for (const listener of windowListeners.get(event.type) ?? []) listener(event); },
};
after(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });

const button = (host, label) => all(host).find(item => item.tag === 'button' && text(item) === label);
const byClass = (host, className) => all(host).find(item => typeof item.props.class === 'string' && item.props.class.split(' ').includes(className));
const group = (host, name) => all(host).find(item => item.tag === 'section' && item.props['aria-label'] === name);
const change = (input, value) => input.props['onUpdate:modelValue'](value);
const submit = host => all(host).find(item => item.tag === 'form').props.onSubmit({ preventDefault() {} });
const metricRow = (host, label) => all(host).find(item => item.tag === 'div' && item.children.some(child => child.tag === 'dt' && text(child) === label));
async function flush() { for (let i = 0; i < 12; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick(); } }
function visibleText(target) { return target.tag === 'details' ? '' : target.text + target.children.map(visibleText).join(''); }
function fixture(handler = () => Response.json(snapshot())) {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (path, init) => {
    const call = { path, init, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call); return handler(call, calls);
  };
  return { calls, restore() { globalThis.fetch = originalFetch; } };
}
function mount(props = {}) {
  const host = node('root'); const app = renderer.createApp({ render: () => h(Component, typeof props === 'function' ? props() : props) });
  app.mount(host); return { host, app };
}
function mountSettings(props = {}) {
  const host = node('root'); const app = renderer.createApp({ render: () => h(SettingsComponent, props) });
  app.mount(host); return { host, app };
}
function metric(key, value, { scope = 'instance', unit = 'count', start = '2026-09-19T00:00:00.000Z', end = '2026-09-19T02:00:00.000Z' } = {}) {
  return { key, value, scope, unit, period_start: start, period_end: end, observed_at: null };
}
function extendedSnapshot(status = 'fresh') {
  const value = snapshot(status);
  value.cloudflare.billing = { plan: 'paid', cycle_day: 15, period_start: '2026-09-15T00:00:00.000Z', period_end: value.cloudflare.collected_at, account_totals_enabled: true, allowances_shared: true, analytics_not_invoice: true };
  value.cloudflare.metrics.push(
    metric('workers_daily_requests', 420), metric('workers_daily_requests', 850, { scope: 'account' }),
    metric('workers_daily_cpu_microseconds', 3200, { unit: 'microseconds' }),
    metric('workers_requests', 8_000_000, { start: value.cloudflare.billing.period_start }),
    metric('workers_requests', 9_000_000, { scope: 'account', start: value.cloudflare.billing.period_start }),
    metric('r2_daily_class_a_operations', null), metric('r2_daily_class_b_operations', 0),
    metric('r2_class_a_operations', 40, { start: value.cloudflare.billing.period_start }),
    metric('d1_storage_bytes', 1024, { unit: 'bytes', start: null, end: null }),
  );
  // Retired projections can still arrive from an older service and must not revive retired UI.
  value.cloudflare.alerts = [{ metric_key: 'workers_requests', scope: 'instance', level: 'warning', value: 8_000_000, allowance: 10_000_000, percent: 80 }];
  value.public_access = { status: 'configured', hostname: 'kanban.example.test', mode: 'custom_domain', waf_profile: 'anonymous-api-filter' };
  return value;
}

test('today shows real zero and unavailable values separately, with timing details folded and no manual refresh controls', async () => {
  const f = fixture(); const v = mount();
  try {
    await until(() => text(v.host).includes('Up to date'));
    assert.match(text(v.host), /0 B \/ 1 GiB · 0% · Attachments disabled/);
    assert.equal(text(metricRow(group(v.host, 'D1'), 'D1 rows read today')), 'D1 rows read today0');
    assert.match(text(metricRow(byClass(v.host, 'usage-storage'), 'D1 storage')), /Unavailable$/);
    const details = byClass(v.host, 'usage-details'); assert.ok(details); assert.equal(details.props.open, undefined);
    assert.match(text(details), /Last collected: 2026-09-19 02:00:00 UTC/);
    assert.doesNotMatch(visibleText(v.host), /Last collected:|2026-09-19 00:00:00 UTC|Observed:/);
    assert.equal(button(v.host, 'Refresh usage'), undefined); assert.equal(button(v.host, 'Read usage'), undefined);
    assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/api/v1/admin/usage']]);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(v.host), /当日用量.*按 UTC 日统计/); assert.match(text(v.host), /暂无数据/);
    assert.match(text(v.host), /当前存储/); assert.match(text(v.host), /附件占用空间/);
    assert.equal(button(v.host, '设置上限'), undefined); assert.equal(all(v.host).some(item => item.tag === 'form'), false);
  } finally { v.app.unmount(); f.restore(); locale.value = 'en'; }
});

test('a failed refresh keeps earlier data and a later generation replaces it without requiring user checks', async () => {
  let fail = false; const version = ref(0);
  const f = fixture(() => { if (fail) throw new Error('offline'); return Response.json(snapshot()); });
  const v = mount(() => ({ refreshGeneration: version.value }));
  try {
    await until(() => text(v.host).includes('Up to date'));
    fail = true; version.value++; await flush();
    assert.match(text(v.host), /latest data is temporarily unavailable.*Earlier values are kept/);
    assert.match(text(v.host), /Showing earlier data/); assert.match(text(v.host), /0 B \/ 1 GiB/);
    fail = false; version.value++; await flush();
    assert.match(text(v.host), /Up to date/); assert.doesNotMatch(text(v.host), /Earlier values are kept/);
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  } finally { v.app.unmount(); f.restore(); }
});

test('not configured suppresses the daily metric grid and aborts its read when unmounted', async () => {
  const f = fixture(() => Response.json(snapshot('not_configured'))); const v = mount();
  try {
    await until(() => text(v.host).includes('Not configured'));
    assert.equal(byClass(v.host, 'usage-resources'), undefined);
    assert.match(text(v.host), /Connect Cloudflare above/); assert.equal(f.calls.length, 1);
    v.app.unmount(); assert.equal(f.calls[0].init.signal.aborted, true);
  } finally { v.app.unmount(); f.restore(); }
});

test('a superseded response cannot replace the latest generation or start collection', async () => {
  let finishFirst; const version = ref(0);
  const f = fixture((_call, calls) => {
    if (calls.length === 1) return new Promise(resolve => { finishFirst = resolve; });
    const value = snapshot(); value.cloudflare.metrics[0].value = 42; return Response.json(value);
  });
  const v = mount(() => ({ refreshGeneration: version.value }));
  try {
    await until(() => Boolean(finishFirst)); version.value++; await flush();
    assert.match(text(metricRow(group(v.host, 'D1'), 'D1 rows read today')), /42$/);
    finishFirst(Response.json(snapshot('stale'))); await flush();
    assert.match(text(metricRow(group(v.host, 'D1'), 'D1 rows read today')), /42$/);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(f.calls[0].init.signal.aborted, true);
  } finally { v.app.unmount(); f.restore(); }
});

test('opening stale usage shows saved data while one automatic collection carries CSRF and one idempotency key', async () => {
  let finish; const f = fixture(call => call.method === 'GET' ? Response.json(snapshot('stale')) : new Promise(resolve => { finish = resolve; }));
  const v = mount();
  try {
    await until(() => Boolean(finish));
    assert.match(text(v.host), /0 B \/ 1 GiB/); assert.match(text(v.host), /Showing earlier data/);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].path, '/api/v1/admin/usage/refresh');
    assert.deepEqual(f.calls[1].body, { mode: 'stale' });
    assert.equal(f.calls[1].init.headers.get('x-csrf-token'), 'fixture-csrf'); assert.ok(f.calls[1].init.headers.get('idempotency-key'));
    window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.length, 2);
    finish(Response.json(snapshot())); await until(() => text(v.host).includes('Up to date'));
    assert.equal(f.calls.length, 2); assert.equal(button(v.host, 'Refresh usage'), undefined);
  } finally { v.app.unmount(); f.restore(); }
});

test('pending and error snapshots collect once; disabled or already-running collection never dispatch another collection', async () => {
  for (const status of ['pending', 'error', 'not_configured', 'refreshing']) {
    const f = fixture(() => { const value = snapshot(status === 'refreshing' ? 'pending' : status); value.cloudflare.collected_at = null; value.cloudflare.refreshing = status === 'refreshing'; return Response.json(value); });
    const v = mount();
    try {
      await until(() => text(v.host).includes('0 B / 1 GiB')); await flush();
      assert.equal(f.calls.filter(call => call.method === 'POST').length, ['pending', 'error'].includes(status) ? 1 : 0, status);
      if (status === 'refreshing') assert.match(text(v.host), /Updating…/);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('automatic readback performs at most three GETs after collection and never loops POST requests', async context => {
  const f = fixture(call => { const value = snapshot('pending'); value.cloudflare.refreshing = call.method === 'POST' || f.calls.length > 2; return Response.json(value); });
  context.mock.timers.enable({ apis: ['setTimeout'] }); const v = mount();
  try {
    await flush(); assert.equal(f.calls.length, 2);
    for (const delay of [1000, 3000, 5000, 60000]) { context.mock.timers.tick(delay); await flush(); }
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'GET').length, 4);
    assert.match(text(v.host), /Updating…/);
  } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('an uncertain collection response is followed only by bounded snapshot reads', async context => {
  const f = fixture(call => { if (call.method === 'POST') throw new Error('response lost'); return Response.json(snapshot('pending')); });
  context.mock.timers.enable({ apis: ['setTimeout'] }); const v = mount();
  try {
    await flush(); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    context.mock.timers.tick(1000); await flush(); context.mock.timers.tick(60000); await flush();
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'GET').length, 2);
  } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('focus refresh respects a 60-second cooldown and does not collect a fresh snapshot', async () => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const f = fixture(); const v = mount();
  try {
    await until(() => text(v.host).includes('Up to date'));
    window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.length, 1);
    now += 59_999; window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.length, 1);
    now += 1; window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.length, 2);
    assert.equal(f.calls.every(call => call.method === 'GET'), true);
  } finally { Date.now = originalNow; v.app.unmount(); f.restore(); }
});

test('daily resource cards prefer explicit UTC-day metrics while billing totals remain inside details', async () => {
  const f = fixture(() => Response.json(extendedSnapshot())); const v = mount();
  try {
    await until(() => text(v.host).includes('Up to date'));
    assert.match(text(group(v.host, 'Workers')), /Requests420.*CPU time3,200 µs/);
    assert.doesNotMatch(text(group(v.host, 'Workers')), /8,000,000|9,000,000/);
    assert.match(text(group(v.host, 'R2')), /Class A operationsUnavailable.*Class B operations0/);
    assert.match(text(byClass(v.host, 'usage-details')), /Workers requests8,000,000/);
    assert.doesNotMatch(visibleText(v.host), /8,000,000|Shared allowance|anonymous-api-filter|WAF|Budget/);
    assert.match(text(byClass(v.host, 'usage-storage')), /D1 storage1 KiB/);
  } finally { v.app.unmount(); f.restore(); }
});

test('old-service daily fallback accepts only a complete current UTC-day window and never substitutes billing totals', async () => {
  for (const window of ['today', 'billing', 'yesterday', 'zero', 'beyond_day', 'unknown']) {
    const start = window === 'billing' ? '2026-09-15T00:00:00.000Z' : window === 'yesterday' ? '2026-09-18T00:00:00.000Z' : window === 'unknown' ? null : '2026-09-19T00:00:00.000Z';
    const end = window === 'zero' ? start : window === 'beyond_day' ? '2026-09-20T00:00:01.000Z' : window === 'unknown' ? null : '2026-09-19T02:00:00.000Z';
    const f = fixture(() => { const value = snapshot(); value.cloudflare.metrics.push(metric('workers_requests', 123, { start, end })); return Response.json(value); }); const v = mount();
    try {
      await until(() => text(v.host).includes('Up to date'));
      assert.equal(text(metricRow(group(v.host, 'Workers'), 'Requests')), `Requests${window === 'today' ? '123' : 'Unavailable'}`, window);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('daily, storage and summary values reject incompatible units without converting them into valid usage', async () => {
  const f = fixture(() => {
    const value = snapshot(); value.attachments.enabled = true;
    value.cloudflare.metrics = [
      metric('workers_daily_requests', 900, { unit: 'microseconds' }), metric('workers_daily_cpu_microseconds', 901, { unit: 'count' }),
      metric('d1_rows_read', 902, { unit: 'bytes' }), metric('d1_rows_written', 903, { unit: 'microseconds' }),
      metric('r2_daily_class_a_operations', 904, { unit: 'bytes' }), metric('r2_daily_class_b_operations', 905, { unit: 'microseconds' }),
      metric('d1_storage_bytes', 906, { unit: 'count', start: null, end: null }), metric('r2_storage_bytes', 907, { unit: 'microseconds', start: null, end: null }),
      metric('workers_requests', 908, { unit: 'bytes', start: '2026-09-15T00:00:00.000Z' }),
    ];
    return Response.json(value);
  });
  const summary = ref(false); const v = mount(() => ({ summary: summary.value }));
  try {
    await until(() => text(v.host).includes('Up to date'));
    for (const [resource, label] of [['Workers', 'Requests'], ['Workers', 'CPU time'], ['D1', 'D1 rows read today'], ['D1', 'D1 rows written today'], ['R2', 'Class A operations'], ['R2', 'Class B operations']]) {
      assert.equal(text(metricRow(group(v.host, resource), label)), `${label}Unavailable`);
    }
    assert.match(text(metricRow(byClass(v.host, 'usage-storage'), 'D1 storage')), /Unavailable$/);
    assert.doesNotMatch(visibleText(v.host), /900|901|902|903|904|905|906|907|908/);
    assert.doesNotMatch(text(byClass(v.host, 'usage-details')), /Billing-period usage/);
    summary.value = true; await nextTick();
    assert.equal(all(v.host).filter(item => item.tag === 'strong' && text(item) === 'Unavailable').length, 3);
    assert.doesNotMatch(text(v.host), /906|907/);
  } finally { v.app.unmount(); f.restore(); }
});

test('an explicit daily metric wins over an older metric even when both have the same current-day window', async () => {
  const f = fixture(() => { const value = snapshot(); value.cloudflare.metrics.push(metric('workers_requests', 777), metric('workers_daily_requests', 123)); return Response.json(value); });
  const v = mount();
  try { await until(() => text(v.host).includes('Up to date')); assert.equal(text(metricRow(group(v.host, 'Workers'), 'Requests')), 'Requests123'); }
  finally { v.app.unmount(); f.restore(); }
});

test('scheduled usage readback clears protected data and stops polling after authorization loss', async context => {
  for (const status of [401, 403]) {
    const version = ref(0); let fail = false;
    const f = fixture((_call, calls) => {
      if (!fail) return Response.json(snapshot());
      if (calls.length === 2) throw new Error('initial read unavailable');
      const id = crypto.randomUUID();
      return Response.json({ code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', category: status === 401 ? 'authentication' : 'authorization', source: 'service', message: 'not for display', recovery: 'request_owner', request_id: id, retryable: false, details: {} }, { status, headers: { 'x-request-id': id } });
    });
    context.mock.timers.enable({ apis: ['setTimeout'] }); const v = mount(() => ({ refreshGeneration: version.value }));
    try {
      await flush(); assert.ok(group(v.host, 'D1')); fail = true; version.value++; await flush(); assert.ok(group(v.host, 'D1'));
      context.mock.timers.tick(1000); await flush(); assert.equal(group(v.host, 'D1'), undefined);
      const reads = f.calls.length; context.mock.timers.tick(60000); await flush(); assert.equal(f.calls.length, reads);
      assert.equal(button(v.host, 'Set limit'), undefined);
    } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
  }
});

test('account scope is explicit and disabling account totals resets daily values to the instance', async () => {
  const version = ref(0); let enabled = true;
  const f = fixture(() => { const value = extendedSnapshot(); value.cloudflare.billing.account_totals_enabled = enabled; return Response.json(value); });
  const v = mount(() => ({ refreshGeneration: version.value }));
  try {
    await until(() => text(v.host).includes('Up to date'));
    const scope = all(byClass(v.host, 'usage-scope')).find(item => item.tag === 'select');
    change(scope, 'account'); await nextTick();
    assert.match(text(group(v.host, 'Workers')), /Requests850/); assert.doesNotMatch(text(group(v.host, 'Workers')), /420/);
    assert.match(text(byClass(v.host, 'usage-details')), /Workers requests9,000,000/);
    enabled = false; version.value++; await flush();
    assert.equal(byClass(v.host, 'usage-scope'), undefined); assert.match(text(group(v.host, 'Workers')), /Requests420/);
  } finally { v.app.unmount(); f.restore(); }
});

test('missing billing configuration leaves daily data available without scattered settings actions', async () => {
  const f = fixture(() => { const value = extendedSnapshot(); Object.assign(value.cloudflare.billing, { plan: 'unknown', cycle_day: null, account_totals_enabled: false }); return Response.json(value); });
  const v = mount();
  try {
    await until(() => text(v.host).includes('Up to date'));
    assert.match(text(group(v.host, 'Workers')), /Requests420/);
    assert.match(text(byClass(v.host, 'usage-details')), /Plan: Not specified.*Cycle start day: Not specified/);
    for (const label of ['Usage collection', 'Account totals', 'Cloudflare plan', 'Billing cycle']) assert.equal(button(v.host, label), undefined);
    assert.match(text(byClass(v.host, 'usage-details')), /Data details/);
    assert.equal(f.calls.length, 1); assert.doesNotMatch(text(v.host), /WAF|Domain & access|Budget|Shared allowance reminders/);
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(v.host), /查看当日用量不需要填写账期/);
  } finally { v.app.unmount(); f.restore(); locale.value = 'en'; }
});

test('overview stays read-only and switching a fresh summary to details does not recollect', async () => {
  const f = fixture(() => { const value = extendedSnapshot(); value.generated_at = value.cloudflare.collected_at = new Date().toISOString(); return Response.json(value); });
  const summary = ref(true); const v = mount(() => ({ summary: summary.value, onDetails() { summary.value = false; } }));
  try {
    await until(() => text(v.host).includes('Up to date'));
    assert.equal(all(v.host).filter(item => item.tag === 'dt').length, 4);
    assert.equal(button(v.host, 'Set limit'), undefined); assert.equal(byClass(v.host, 'usage-details'), undefined);
    button(v.host, 'View usage').props.onClick(); await nextTick();
    assert.equal(button(v.host, 'Set limit'), undefined); assert.ok(byClass(v.host, 'usage-details')); assert.equal(f.calls.length, 1);
    summary.value = true; await nextTick(); assert.equal(button(v.host, 'Set limit'), undefined); assert.equal(f.calls.length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('entering details after fifteen minutes marks the retained snapshot stale and performs one automatic collection', async () => {
  const originalNow = Date.now; let now = Date.parse('2026-09-19T02:00:00.000Z'); Date.now = () => now;
  let finishRead; let finishCollection;
  const f = fixture((call, calls) => {
    if (calls.length === 1) return Response.json(snapshot());
    if (call.method === 'GET') return new Promise(resolve => { finishRead = resolve; });
    return new Promise(resolve => { finishCollection = resolve; });
  });
  const summary = ref(true); const v = mount(() => ({ summary: summary.value }));
  try {
    await until(() => text(v.host).includes('Up to date'));
    now += 15 * 60 * 1000 - 1; summary.value = false; await nextTick(); assert.equal(f.calls.length, 1);
    summary.value = true; await nextTick(); now++; await nextTick(); assert.equal(f.calls.length, 1);
    summary.value = false; await until(() => Boolean(finishRead)); assert.match(text(v.host), /Showing earlier data/);
    finishRead(Response.json(snapshot('stale'))); await until(() => Boolean(finishCollection));
    assert.deepEqual(f.calls.at(-1).body, { mode: 'stale' }); finishCollection(Response.json(snapshot()));
    await until(() => text(v.host).includes('Up to date')); assert.equal(f.calls.length, 3);
  } finally { Date.now = originalNow; v.app.unmount(); f.restore(); }
});

test('storage settings load their own current values without Cloudflare and require an explicit byte-exact choice', async () => {
  let current = { configured: false, version: 1, reserved_bytes: 8192, limit_bytes: null }; let saves = 0;
  const f = fixture(call => {
    assert.equal(call.path, '/api/v1/admin/attachment-settings');
    if (call.method === 'PATCH') { current = { ...current, configured: true, version: current.version + 1, limit_bytes: call.body.limit_bytes }; return Response.json({ resource: current }); }
    return Response.json(current);
  });
  const v = mountSettings({ onSaved() { saves++; } });
  try {
    await until(() => text(v.host).includes('Not set'));
    assert.equal(all(v.host).filter(item => item.tag === 'form').length, 1);
    assert.match(text(v.host), /Reserved storage8 KiB/); assert.equal(button(v.host, 'Save storage limit').props.disabled, true);
    assert.equal(all(v.host).some(item => item.tag === 'input'), false);
    assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/api/v1/admin/attachment-settings']]);
    await submit(v.host); await nextTick(); assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
    change(all(v.host).find(item => item.tag === 'select'), 'unlimited'); await nextTick(); await submit(v.host); await flush();
    assert.match(text(v.host), /Current limitUnlimited/); assert.deepEqual(f.calls.at(-1).body, { expected_version: 1, limit_bytes: null });
    assert.ok(f.calls.at(-1).init.headers.get('idempotency-key')); assert.equal(f.calls.at(-1).init.headers.get('x-csrf-token'), 'fixture-csrf');
    assert.equal(button(v.host, 'Save storage limit').props.disabled, true); assert.equal(saves, 1);
    change(all(v.host).find(item => item.tag === 'select'), 'limited'); await nextTick();
    change(all(v.host).find(item => item.tag === 'input'), '0.0000001'); await nextTick(); await submit(v.host); await flush();
    assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1); assert.match(text(v.host), /positive capacity precise to whole bytes/);
    change(all(v.host).find(item => item.tag === 'input'), '1.5'); await nextTick(); await submit(v.host); await flush();
    assert.deepEqual(f.calls.at(-1).body, { expected_version: 2, limit_bytes: 1572864 }); assert.match(text(v.host), /Current limit1.5 MiB/);
    assert.equal(saves, 2); assert.equal(button(v.host, 'Discard changes').props.disabled, true);
    locale.value = 'zh-CN'; await nextTick(); assert.ok(button(v.host, '保存存储上限')); assert.match(text(v.host), /当前上限1.5 MiB/);
  } finally { v.app.unmount(); f.restore(); locale.value = 'en'; }
});

test('capacity conflicts update the current value, retain the exact draft and require a separate explicit CAS save', async () => {
  let writes = 0; let reads = 0; let saved;
  const f = fixture(call => {
    if (call.method === 'PATCH') {
      if (++writes === 1) { const id = '40000000-0000-4000-8000-000000000001'; return Response.json({ code: 'VERSION_CONFLICT', category: 'conflict', source: 'service', message: 'Changed', recovery: 'refresh_resource', request_id: id, retryable: false, details: {} }, { status: 409, headers: { 'x-request-id': id } }); }
      saved = call.body; return Response.json({ resource: { configured: true, version: 3, reserved_bytes: 4096, limit_bytes: saved.limit_bytes } });
    }
    return Response.json({ configured: true, version: ++reads, reserved_bytes: 4096, limit_bytes: reads === 1 ? 1073741824 : 3000000 });
  });
  const v = mountSettings();
  try {
    await until(() => text(v.host).includes('Current limit1 GiB'));
    change(all(v.host).find(item => item.tag === 'input'), '2'); await nextTick(); await submit(v.host); await flush();
    assert.match(text(v.host), /changed elsewhere.*Review it before saving your retained draft again/); assert.match(text(v.host), /Current limit2.9 MiB/);
    const input = all(v.host).find(item => item.tag === 'input'); assert.equal(input.props.value ?? input.value, '2');
    assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(button(v.host, 'Save storage limit').props.disabled, false);
    await submit(v.host); await flush(); assert.deepEqual(saved, { expected_version: 2, limit_bytes: 2097152 });
    assert.equal(all(v.host).filter(item => item.tag === 'form').length, 1); assert.match(text(v.host), /Storage limit saved/);
    change(all(v.host).find(item => item.tag === 'input'), '4'); await nextTick();
    button(v.host, 'Discard changes').props.onClick(); await nextTick();
    assert.equal(all(v.host).find(item => item.tag === 'input').props.value, '2'); assert.equal(writes, 2); assert.equal(button(v.host, 'Save storage limit').props.disabled, true);
  } finally { v.app.unmount(); f.restore(); }
});

test('an initial storage settings read failure never reports a save failure and stops when unmounted', async () => {
  const f = fixture(() => { throw new Error('isolated read failure'); }); const v = mountSettings();
  try {
    await until(() => text(v.host).includes('Current storage settings could not be read'));
    assert.doesNotMatch(text(v.host), /Could not save|This save is not confirmed/);
    assert.equal(button(v.host, 'Save storage limit').props.disabled, true);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
  } finally { v.app.unmount(); assert.equal(f.calls[0].init.signal.aborted, true); f.restore(); }
});

test('an unconfirmed storage save freezes its draft and retries the same independent request and idempotency key', async () => {
  let writes = 0;
  const f = fixture(call => {
    if (call.method === 'GET') return Response.json({ configured: true, version: 1, reserved_bytes: 4096, limit_bytes: 3000000 });
    if (++writes === 1) throw new Error('isolated response loss');
    return Response.json({ resource: { configured: true, version: 2, reserved_bytes: 4096, limit_bytes: call.body.limit_bytes } });
  });
  const v = mountSettings();
  try {
    await until(() => text(v.host).includes('Current limit2.9 MiB'));
    change(all(v.host).find(item => item.tag === 'input'), '2'); await nextTick(); await submit(v.host); await flush();
    assert.match(text(v.host), /This save is not confirmed/); assert.equal(all(v.host).find(item => item.tag === 'input').props.disabled, true);
    assert.equal(button(v.host, 'Discard changes').props.disabled, true); assert.equal(button(v.host, 'Save storage limit').props.disabled, false);
    assert.equal(writes, 1); await submit(v.host); await flush();
    const attempts = f.calls.filter(call => call.method === 'PATCH'); assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].body, attempts[1].body); assert.equal(attempts[0].init.headers.get('idempotency-key'), attempts[1].init.headers.get('idempotency-key'));
    assert.match(text(v.host), /Current limit2 MiB/); assert.match(text(v.host), /Storage limit saved/);
  } finally { v.app.unmount(); f.restore(); }
});

test('an over-limit attachment capacity explains paused uploads and continued access in both languages', async () => {
  const f = fixture(() => { const value = snapshot(); value.attachments.reserved_bytes = value.attachments.limit_bytes * 2; return Response.json(value); }); const v = mount();
  try {
    await until(() => text(v.host).includes('Storage limit reached'));
    assert.match(text(v.host), /200%/); assert.match(text(v.host), /New uploads are paused; existing attachments remain accessible/);
    assert.match(all(v.host).find(item => item.tag === 'meter').props.class, /capacity-reached/);
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(v.host), /已达到容量上限，新增上传已暂停；已有附件仍可访问/);
  } finally { v.app.unmount(); f.restore(); locale.value = 'en'; }
});

test('billing details exclude daily Workers values and require the declared billing window', async () => {
  for (const plan of ['free', 'unknown', 'paid']) {
    const f = fixture(() => {
      const value = extendedSnapshot(); value.cloudflare.billing.plan = plan;
      value.cloudflare.metrics = [
        metric('workers_requests', 123),
        metric('d1_billing_rows_read', 345, { start: '2026-09-15T00:00:00.000Z' }),
        metric('r2_class_a_operations', 456, { start: '2026-09-01T00:00:00.000Z' }),
        metric('r2_class_b_operations', 567, { start: '2026-09-15T00:00:00.000Z', end: '2026-09-20T02:00:00.000Z' }),
      ];
      return Response.json(value);
    }); const v = mount();
    try {
      await until(() => text(v.host).includes('Up to date'));
      const details = byClass(v.host, 'usage-details'); const totals = byClass(details, 'usage-metrics');
      assert.match(text(totals), /D1 rows read in billing period345/);
      for (const label of ['Workers requests', 'R2 Class A operations', 'R2 Class B operations']) assert.equal(Boolean(metricRow(totals, label)), false, `${plan}: ${label}`);
    } finally { v.app.unmount(); f.restore(); }
  }
  const f = fixture(() => {
    const value = extendedSnapshot(); value.cloudflare.billing.cycle_day = null;
    value.cloudflare.billing.period_start = null; value.cloudflare.billing.period_end = null; return Response.json(value);
  }); const v = mount();
  try { await until(() => text(v.host).includes('Up to date')); assert.doesNotMatch(text(byClass(v.host, 'usage-details')), /Billing-period usage/); }
  finally { v.app.unmount(); f.restore(); }
});
