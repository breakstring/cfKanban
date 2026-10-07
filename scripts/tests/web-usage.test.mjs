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
  stdin: { contents: `export { default as Component } from './apps/web/src/components/UsagePanel.vue'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
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
    assert.match(text(host), /Application snapshot read at: 2026-09-19 02:00:00 UTC/);
    assert.doesNotMatch(text(host), /\.858Z/);
    const details = all(host).find(item => item.tag === 'details' && item.props.class === 'usage-details');
    assert.ok(details); assert.equal(details.props.open, undefined);
    assert.match(text(details), /Window:.*00:00:00 UTC/);
    function visibleText(item) { return item.tag === 'details' ? '' : item.text + item.children.map(visibleText).join(''); }
    assert.doesNotMatch(visibleText(host), /Application snapshot read at|Last attempt|Window:|Observed:/);
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

function extendedSnapshot(status = 'fresh') {
  const value = snapshot(status);
  value.cloudflare.billing = { plan: 'paid', cycle_day: 15, period_start: '2026-09-15T00:00:00.000Z', period_end: value.cloudflare.collected_at,
    account_totals_enabled: true, warning_percent: 80, allowances_shared: true, analytics_not_invoice: true };
  const metric = (key, amount, scope = 'instance', unit = 'count') => ({ key, value: amount, scope, unit,
    period_start: value.cloudflare.billing.period_start, period_end: value.cloudflare.billing.period_end, observed_at: null });
  value.cloudflare.metrics.push(metric('workers_requests', 9_000_000, 'account'), metric('workers_requests', 8_000_000),
    metric('workers_cpu_microseconds', 3_000_000, 'instance', 'microseconds'), metric('r2_class_a_operations', null),
    metric('r2_class_b_operations', 0), metric('r2_unclassified_operations', 2), metric('d1_billing_rows_read', 123));
  value.cloudflare.alerts = [
    { metric_key: 'workers_requests', scope: 'instance', level: 'warning', value: 8_000_000, allowance: 10_000_000, percent: 80,
      period_start: value.cloudflare.billing.period_start, period_end: value.cloudflare.billing.period_end },
    { metric_key: 'workers_requests', scope: 'account', level: 'reached', value: 10_000_000, allowance: 10_000_000, percent: 100,
      period_start: value.cloudflare.billing.period_start, period_end: value.cloudflare.billing.period_end },
  ];
  value.public_access = { status: 'configured', hostname: 'kanban.example.com', mode: 'custom_domain', waf_profile: 'anonymous-api-filter',
    verified_at: '2026-09-18T23:30:00.000Z', live_verified: false };
  return value;
}

test('extended usage separates instance and account values, retains unknown classes and renders shared-allowance reminders', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return Response.json(extendedSnapshot()); };
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Shared allowance reminders'));
    const instance = all(host).find(item => item.tag === 'section' && item.props['aria-label'] === 'Instance usage');
    const account = all(host).find(item => item.tag === 'section' && item.props['aria-label'] === 'Account totals');
    assert.match(text(instance), /Workers requests8,000,000/);
    assert.doesNotMatch(text(instance), /9,000,000/);
    assert.match(text(account), /Workers requests9,000,000/);
    assert.match(text(instance), /Workers cumulative CPU3,000,000 µs/);
    assert.match(text(instance), /R2 Class A operationsUnknown/);
    assert.match(text(instance), /R2 Class B operations0/);
    assert.match(text(instance), /R2 unclassified operations2/);
    assert.match(text(instance), /D1 rows read in billing period123/);
    assert.match(text(host), /Instance contribution · Workers requests.*80% · Warning threshold reached/);
    assert.match(text(host), /Account total · Workers requests.*100% · Shared allowance reached/);
    assert.match(text(host), /Instance figures show contribution, not remaining allowance/);
    assert.match(text(host), /Analytics may be sampled or delayed and are not an invoice/);
    assert.match(text(all(host).find(item => item.tag === 'details' && item.props.class === 'usage-details')), /Billing period observation: 2026-09-15 00:00:00 UTC/);
    const settingsLink = all(host).find(item => item.tag === 'a' && item.props.href === '#connection-configuration-heading');
    assert.ok(settingsLink); assert.match(text(settingsLink), /Change plan, billing cycle, or reminders in Usage settings/);
    assert.doesNotMatch(text(host), /Cloudflare budget emails|Domain & access protection/);
    assert.equal(calls.length, 1);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /本实例贡献 · Workers 请求量/);
    assert.match(text(host), /账户总量 · Workers 请求量/);
    assert.match(text(host), /R2 未分类操作量/);
    assert.match(text(host), /累计微秒值/);
    assert.match(text(host), /不表示剩余额度/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('missing billing cycle remains unknown and account totals require opt-in', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const value = extendedSnapshot();
    Object.assign(value.cloudflare.billing, { plan: 'unknown', cycle_day: null, period_start: null, period_end: null, account_totals_enabled: false });
    value.cloudflare.metrics = value.cloudflare.metrics.filter(metric => metric.scope !== 'account').map(metric => ({ ...metric, period_start: null, period_end: null }));
    value.cloudflare.alerts = [];
    return Response.json(value);
  };
  const app = renderer.createApp(Component); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Billing cycle is not configured'));
    assert.match(text(host), /Monthly usage and allowance comparisons remain unknown/);
    assert.match(text(host), /Cloudflare Workers\/D1 plan: Unknown/);
    assert.match(text(host), /Cloudflare billing cycle, not a separate cfKanban cycle/);
    assert.match(text(host), /Free daily figures do not require it/);
    assert.match(text(host), /Change plan, billing cycle, or reminders in Usage settings/);
    assert.match(text(host), /Account totals are not enabled/);
    assert.equal(all(host).some(item => item.tag === 'section' && item.props['aria-label'] === 'Account totals'), false);
    assert.match(text(all(host).find(item => item.tag === 'details' && item.props.class === 'usage-details')), /Billing period observation: Unknown — Unknown/);
    assert.doesNotMatch(text(host), /Shared allowance reminders|Billing period starts on UTC day/);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /尚未配置账单周期/);
    assert.match(text(host), /未启用账户总量/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('R2 Standard allowance comparison explains unknown, instance-only and account confirmation scopes', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const scope of [undefined, 'unknown', 'instance', 'account']) {
      globalThis.fetch = async () => {
        const value = extendedSnapshot();
        if (scope !== undefined) value.cloudflare.billing.r2_standard_only_scope = scope;
        return Response.json(value);
      };
      const app = renderer.createApp(Component); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Workers requests'));
        if (scope === 'instance') assert.match(text(host), /Standard-only R2 usage is confirmed for this instance.*does not confirm the account totals/);
        else if (scope !== 'account') assert.match(text(host), /R2 free allowances apply only to Standard storage.*usage scope is unconfirmed/);
        else assert.doesNotMatch(text(host), /usage scope is unconfirmed|does not confirm the account totals/);
        locale.value = 'zh-CN'; await nextTick();
        if (scope === 'instance') assert.match(text(host), /仅已确认本实例的 R2 用量全部属于 Standard，不代表账户总量/);
        else if (scope !== 'account') assert.match(text(host), /R2 免费额度仅适用于 Standard 存储；尚未确认其用量范围/);
      } finally { app.unmount(); locale.value = 'en'; }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('stale, refreshing and failed usage never present retained alerts as current', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of ['stale', 'refreshing', 'failed']) {
      let failing = false;
      globalThis.fetch = async () => {
        if (failing) throw new Error('offline');
        const value = extendedSnapshot(status === 'stale' ? 'stale' : 'fresh');
        value.cloudflare.refreshing = status === 'refreshing';
        return Response.json(value);
      };
      const app = renderer.createApp(Component); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Workers requests'));
        if (status === 'failed') {
          assert.match(text(host), /Shared allowance reminders/);
          failing = true;
          await all(host).find(item => item.tag === 'button').props.onClick(); await nextTick();
          assert.match(text(host), /Refresh failed/);
          assert.match(text(host), /Stale snapshot/);
          assert.doesNotMatch(text(host), /Snapshot available/);
        }
        assert.doesNotMatch(text(host), /Shared allowance reminders/);
        assert.match(text(host), /Workers requests8,000,000/);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('usage configuration links select the shared editor without repeating budget or domain control panels', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const settings = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init }); const value = extendedSnapshot(); value.cloudflare.billing.account_totals_enabled = false; return Response.json(value);
  };
  const app = renderer.createApp(Component, { onSettings: field => settings.push(field) }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Change plan, billing cycle, or reminders'));
    const links = all(host).filter(item => item.tag === 'a' && item.props.href === '#connection-configuration-heading');
    assert.equal(links.length, 2);
    links[0].props.onClick(); links[1].props.onClick(); await nextTick();
    assert.deepEqual(settings, ['billing_plan', 'account_totals']);
    assert.doesNotMatch(text(host), /Cloudflare budget emails|Domain & access protection|deployment Agent/);
    assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'GET');
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(host), /在用量设置中修改方案、账期或提醒.*查看账户汇总设置/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('overview summary and detailed usage share one snapshot without collecting on section changes', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    const value = extendedSnapshot();
    value.generated_at = value.cloudflare.collected_at = new Date().toISOString();
    return Response.json(value);
  };
  const summary = ref(true);
  const app = renderer.createApp({ setup: () => () => h(Component, {
    summary: summary.value, observedOrigin: 'https://legacy.example.com', onDetails: () => { summary.value = false; },
  }) });
  const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Snapshot available'));
    assert.match(text(host), /Attachment budget reserved/);
    assert.equal(all(host).filter(item => item.tag === 'dt').length, 4);
    assert.doesNotMatch(text(host), /Billing cycle|Data details|Domain & access protection|Cloudflare budget emails|Set limit|Refresh usage/);
    assert.equal(calls.length, 1);
    await all(host).find(item => item.tag === 'button' && text(item) === 'View usage details').props.onClick(); await nextTick();
    assert.match(text(host), /Cloudflare Workers\/D1 plan: Paid/);
    assert.doesNotMatch(text(host), /Current site address|Domain & access protection/);
    assert.equal(calls.length, 1);
    summary.value = true; await nextTick();
    assert.doesNotMatch(text(host), /Data details|Set limit/);
    assert.equal(calls.length, 1);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /查看用量详情|附件预留预算/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('entering details rechecks the clock at fifteen minutes, hides old reminders, and collects through the existing cache path', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Date.parse('2026-09-19T02:00:00.000Z');
  Date.now = () => now;
  const calls = [];
  let finishRead;
  let finishCollection;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (calls.length === 1) return Response.json(extendedSnapshot());
    if (init.method === 'GET') return new Promise(resolve => { finishRead = resolve; });
    return new Promise(resolve => { finishCollection = resolve; });
  };
  const summary = ref(true);
  const app = renderer.createApp({ setup: () => () => h(Component, { summary: summary.value }) });
  const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Snapshot available'));
    now += 15 * 60 * 1000 - 1;
    summary.value = false; await nextTick();
    assert.equal(calls.length, 1);
    assert.match(text(host), /Shared allowance reminders/);
    summary.value = true; await nextTick();
    now += 1;
    await nextTick();
    assert.equal(calls.length, 1, 'time passage alone must not trigger background polling');
    summary.value = false; await until(() => finishRead);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, '/api/v1/admin/usage');
    assert.match(text(host), /Stale snapshot/);
    assert.doesNotMatch(text(host), /Shared allowance reminders|Snapshot available/);
    const stale = extendedSnapshot('stale'); stale.generated_at = new Date(now).toISOString();
    finishRead(Response.json(stale)); await until(() => finishCollection);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].path, '/api/v1/admin/usage/refresh');
    assert.equal(JSON.parse(calls[2].init.body).mode, 'stale');
    assert.doesNotMatch(text(host), /Shared allowance reminders/);
    const current = extendedSnapshot();
    current.generated_at = current.cloudflare.collected_at = new Date(now).toISOString();
    finishCollection(Response.json(current)); await until(() => text(host).includes('Snapshot available'));
    assert.match(text(host), /Shared allowance reminders/);
    assert.equal(calls.length, 3);
  } finally { app.unmount(); globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('a failed foreground read retains a stale snapshot and entering details retries without reviving stale reminders', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = Date.parse('2026-09-19T02:00:00.000Z');
  Date.now = () => now;
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (calls.length === 1) return Response.json(extendedSnapshot());
    throw new Error('offline');
  };
  const summary = ref(true);
  const app = renderer.createApp({ setup: () => () => h(Component, { summary: summary.value }) });
  const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Snapshot available'));
    now += 15 * 60 * 1000;
    summary.value = false; await until(() => text(host).includes('Refresh failed'));
    assert.equal(calls.length, 2);
    assert.match(text(host), /Stale snapshot/);
    assert.doesNotMatch(text(host), /Shared allowance reminders|Snapshot available/);
    assert.match(text(host), /Workers requests8,000,000/);
    summary.value = true; await nextTick();
    summary.value = false; await until(() => calls.length === 3 && text(host).includes('Refresh failed'));
    assert.equal(calls[2].path, '/api/v1/admin/usage');
    assert.doesNotMatch(text(host), /Shared allowance reminders|Snapshot available/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('snapshot bars compare only count metrics with the same known window and preserve unknowns', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const mode of ['matching', 'different_window', 'different_unit', 'r2_different_unit']) {
      globalThis.fetch = async () => {
        const value = extendedSnapshot();
        const read = value.cloudflare.metrics.find(metric => metric.key === 'd1_rows_read');
        read.value = 40_541;
        value.cloudflare.metrics.push({ ...read, key: 'd1_rows_written', value: 994,
          unit: mode === 'different_unit' ? 'microseconds' : 'count',
          period_start: mode === 'different_window' ? '2026-09-18T00:00:00.000Z' : read.period_start });
        if (mode === 'r2_different_unit') value.cloudflare.metrics.find(metric => metric.key === 'r2_unclassified_operations').unit = 'bytes';
        return Response.json(value);
      };
      const app = renderer.createApp(Component); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Data details & snapshot charts'));
        const charts = all(host).filter(item => item.tag === 'figure');
        const d1 = charts.find(item => text(item).startsWith('D1 read and write counts'));
        assert.equal(Boolean(d1), mode === 'matching' || mode === 'r2_different_unit');
        if (d1) {
          assert.match(text(d1), /D1 rows read today40,541.*D1 rows written today994/);
          const bars = all(d1).filter(item => item.tag === 'div' && item.props.class === 'usage-chart-track');
          assert.equal(bars.length, 2);
          assert.equal(bars[0].children[0].props.style.width, '100%');
          assert.ok(Number.parseFloat(bars[1].children[0].props.style.width) < 3);
        }
        const r2 = charts.find(item => text(item).startsWith('R2 operation counts'));
        assert.equal(Boolean(r2), mode !== 'r2_different_unit');
        if (r2) {
          assert.match(text(r2), /R2 Class A operationsUnknown.*R2 Class B operations0.*R2 unclassified operations2/);
          assert.equal(all(r2).filter(item => item.tag === 'div' && item.props.class === 'usage-chart-track').length, 2);
        }
        assert.match(text(host), /separate usage history panel.*preserves missing dates/);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});
