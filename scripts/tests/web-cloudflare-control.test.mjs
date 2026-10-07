import { nuxtUiTestPlugin } from './nuxt-ui-test-plugin.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

const originals = { Document: globalThis.Document, ShadowRoot: globalThis.ShadowRoot, document: globalThis.document, window: globalThis.window };
const storageWrites = [];
globalThis.Document = class {}; globalThis.ShadowRoot = class {};
globalThis.document = { cookie: 'cfkanban_csrf=fixture-csrf', documentElement: { lang: 'en' } };
globalThis.window = { location: { pathname: '/app/admin', search: '' }, addEventListener() {}, dispatchEvent() {}, navigator: { language: 'en' }, localStorage: { getItem() { return null; }, setItem(key, value) { storageWrites.push({ key, value }); } } };
after(() => { Object.assign(globalThis, originals); });
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Control } from './apps/web/src/components/CloudflareControlPanel.vue'; export { default as History } from './apps/web/src/components/UsageHistoryPanel.vue'; export { historyGeometry } from './apps/web/src/components/UsageHistoryChart.vue'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [nuxtUiTestPlugin(), { name: 'vue-test', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
      const compiled = compileScript(descriptor, { id: 'control-test', inlineTemplate: true });
      return { contents: compiled.content, loader: 'ts', resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL('../../node_modules/vue/index.mjs', import.meta.url).href, external: true }));
  } }],
});
const { Control, History, historyGeometry, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function node(tag, text = '') { return { tag, text, children: [], props: {}, parent: null, focus() {}, getRootNode() { return {}; }, addEventListener() {}, removeEventListener() {}, get options() { return this.children; }, get tagName() { return this.tag.toUpperCase(); } }; }
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; }, setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; },
  insert(target, parent, anchor = null) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, target); },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); }, parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insertStaticContent(text, parent, anchor) { const target = node('#static', text); target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, target); return [target, target]; },
});
const all = target => [target, ...target.children.flatMap(all)];
const text = target => target.text + target.children.map(text).join('');
async function until(check) { for (let step = 0; step < 100; step++) { await new Promise(resolve => setTimeout(resolve, 5)); await nextTick(); if (check()) return; } assert.fail('component did not reach expected state'); }
const submit = form => form.props.onSubmit({ preventDefault() {} });
const section = (host, heading) => all(host).find(item => item.tag === 'section' && item.props['aria-labelledby'] === heading);
const write = resource => Response.json({ resource, event_cursor: 'fixture', idempotent_replay: false });
const operation = status => ({ operation_id: 'operation-fixture', kind: 'secret', status, version: 5, baseline_version_id: 'v1', result_version_id: status === 'verified' ? 'v2' : null, deployment_id: null, failure_class: null, created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' });
const connection = () => ({ version: 4, target: { account_id: 'account-fixture', worker_name: 'worker-fixture', database_id: 'db-fixture', zone_id: 'zone-fixture', hostname: 'kanban.example.com' }, configured: { configuration: true, control: false, analytics: false }, capabilities: { configuration: 'verified', notifications: 'unverified', waf: 'permission_denied', billing: 'unsupported_contract', analytics: 'missing' }, verified_at: null, budget: { status: 'unsupported_contract', dashboard_url: 'https://dash.cloudflare.com/', docs_url: 'https://developers.cloudflare.com/billing/manage/budget-alerts/' }, latest_operation: null, configuration: { history_enabled: false, analytics_enabled: true, billing_plan: 'free', billing_cycle_day: 10, account_totals: false, warning_percent: 75 } });
const rateFixture = () => ({ configuration_source: 'worker_configuration', editable_via_api: false, policies: { instance: { limit: 300, period_seconds: 60 }, principal: { limit: 120, period_seconds: 60 }, unauthenticated_sensitive: { limit: 30, period_seconds: 60 } }, cost_protection: { anonymous_login: { enabled: true, policy: { limit: 11, period_seconds: 10 } }, expensive_reads: { enabled: true, policy: { limit: 10, period_seconds: 60 } }, concurrency: { enabled: true, per_principal: 2, per_isolate: 32 } } });
function providerRead(path, current) {
  if (path.endsWith('/rate-limit-settings')) return Response.json(rateFixture());
  if (path.endsWith('/notifications')) return Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'policy-fixture', name: 'Policy fixture', alert_type: 'billing_usage_alert', enabled: true, emails: ['fixture@example.invalid'], filters: { limit: 80 } }] });
  if (path.endsWith('/waf')) return Response.json({ status: 'permission_denied', zone_id: 'zone-fixture', hostname: 'kanban.example.com', owned_rule: null, other_rule_count: null, protected: false });
  return Response.json(current);
}

test('connection reads fixed targets and read-only policies without interpreting a limit as USD or WAF permissions as protection', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); current.configuration.billing_plan = null;
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return providerRead(path, current); };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Policy fixture'));
    assert.match(text(host), /account-fixture.*worker-fixture.*db-fixture/);
    assert.equal(all(host).filter(item => item.tag === 'input' && item.props.type === 'password').length, 3);
    const tokens = section(host, 'connection-tokens-heading');
    assert.match(text(tokens), /account-owned Token.*Specified Workers.*Editor.*code, deployment, and Secret management/);
    assert.match(text(tokens), /Notifications.*Billing.*displayed Account.*Zone WAF.*verified Zone only/);
    assert.match(text(tokens), /Account Analytics.*Read.*Saving first verifies the D1 analytics interface.*subsequent usage reads/);
    assert.ok(all(tokens).some(item => item.tag === 'a' && item.props.href === 'https://dash.cloudflare.com/?to=/:account/api-tokens'));
    assert.ok(all(tokens).some(item => item.tag === 'a' && item.props.href === 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/'));
    const budget = section(host, 'connection-budget-heading');
    assert.match(text(budget), /Public API contract unconfirmed/);
    assert.equal(all(budget).some(item => ['button', 'input', 'textarea', 'select'].includes(item.tag)), false);
    const notifications = section(host, 'connection-notifications-heading');
    assert.match(text(notifications), /Policy fixture.*Enabled.*billing_usage_alert.*fixture@example.invalid/);
    assert.doesNotMatch(text(notifications), /80|\$80/);
    assert.match(text(section(host, 'connection-waf-heading')), /permission denied.*No active tool-owned blocking rule is confirmed/);
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call.init.method === 'GET'));
    const configurationForm = all(section(host, 'connection-configuration-heading')).find(item => item.tag === 'form');
    assert.ok(all(host).filter(item => item.tag === 'option').every(item => item.props.value !== ''), 'Reka SelectItem reserves the empty string for the placeholder');
    all(configurationForm).find(item => item.tag === 'select').props['onUpdate:modelValue']('billing_plan'); await nextTick();
    const billingSelect = all(configurationForm).filter(item => item.tag === 'select')[1];
    assert.equal(billingSelect.props.value, 'unknown');
    assert.ok(billingSelect.children.every(item => item.props.value !== ''), 'unknown billing plans use a nonempty option rather than an empty placeholder item');
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /当前 Worker.*Editor|保存到 Worker Secret/);
    assert.match(text(budget), /公开 API 合同尚未确认/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('Token submission clears the password immediately, uses CSRF and explicit idempotency, and never replays after uncertainty', async () => {
  const originalFetch = globalThis.fetch; const calls = []; let finish;
  const current = connection();
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) return new Promise((resolve, reject) => { finish = () => reject(new Error('fixture-secret-must-not-render')); });
    if (path.endsWith('/verify')) return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Policy fixture'));
    const forms = all(host).filter(item => item.tag === 'form' && item.props.class === 'cloudflare-token-form');
    const form = forms[1]; const input = all(form).find(item => item.tag === 'input');
    input.props['onUpdate:modelValue']('fixture-secret-must-not-render'); await nextTick();
    const pending = submit(form); await until(() => finish);
    assert.equal(input.props.value, '');
    const request = calls.find(call => call.path.endsWith('/secrets'));
    assert.deepEqual(JSON.parse(request.init.body), { kind: 'control', token: 'fixture-secret-must-not-render', expected_version: 4 });
    assert.match(request.init.headers.get('idempotency-key'), /^[0-9a-f-]{36}$/);
    assert.equal(request.init.headers.get('x-csrf-token'), 'fixture-csrf');
    assert.equal(request.init.credentials, 'same-origin');
    finish(); await pending; await until(() => text(host).includes('Token input has been cleared'));
    assert.doesNotMatch(text(host), /fixture-secret-must-not-render/);
    assert.ok(storageWrites.every(entry => !entry.value.includes('fixture-secret-must-not-render')));
    assert.equal(input.props.value, ''); assert.equal(input.props.disabled, true);
    await all(form).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick();
    await until(() => calls.filter(call => call.path.endsWith('/verify')).length === 1 && !all(host).find(item => item.props.id === 'cloudflare-token-control')?.props.disabled);
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-control').props.value, '');
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a lost Secret response discovers the new operation and keeps empty Token inputs locked until terminal readback', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); let verifications = 0;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) {
      current.latest_operation = { ...operation('unknown'), operation_id: 'new-secret-operation' }; current.version = 5;
      throw new Error('Secret response lost after intent creation');
    }
    if (path === '/api/v1/admin/cloudflare/operations/new-secret-operation/verify') {
      verifications++;
      current.latest_operation = { ...current.latest_operation, status: verifications === 1 ? 'pending' : 'verified' };
      return write(current.latest_operation);
    }
    if (path === '/api/v1/admin/cloudflare/verify') {
      assert.equal(current.latest_operation.status, 'verified', 'generic verify must not bypass the pending operation lock');
      current.configured.control = true;
      return write(current);
    }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Policy fixture'));
    assert.equal(section(host, 'connection-operation-heading'), undefined);
    const form = all(host).find(item => item.tag === 'form' && all(item).some(input => input.props.id === 'cloudflare-token-control'));
    all(form).find(item => item.tag === 'input').props['onUpdate:modelValue']('fake-token-for-lost-response'); await nextTick(); await submit(form);
    await until(() => text(host).includes('Token input has been cleared'));
    const beforeReadback = calls.length;
    await all(form).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick();
    await until(() => verifications === 1 && !all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.disabled);
    assert.equal(calls[beforeReadback].path, '/api/v1/admin/cloudflare'); assert.equal(calls[beforeReadback].init.method, 'GET');
    assert.equal(calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 0);
    assert.match(text(section(host, 'connection-operation-heading')), /Pending/);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-control').props.disabled, true);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-control').props.value, '');
    await all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick();
    await until(() => verifications === 2 && !all(host).find(item => item.props.id === 'cloudflare-token-control').props.disabled);
    const restored = all(host).find(item => item.props.id === 'cloudflare-token-control');
    assert.equal(restored.props.value, '');
    restored.props['onUpdate:modelValue']('a-new-unsent-fake-token'); await nextTick();
    assert.equal(restored.props.value, 'a-new-unsent-fake-token');
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 1);
    assert.doesNotMatch(text(host), /fake-token-for-lost-response|a-new-unsent-fake-token/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a lost apply response replaces an old terminal operation with the latest server operation before verification', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  current.latest_operation = { ...operation('verified'), operation_id: 'old-operation' };
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/rate-limits/plan')) return write({ plan_id: 'plan-lost-response', kind: 'rate_limit', version: 7, target: current.target, before: { limit: 300 }, after: { limit: 73 } });
    if (path.endsWith('/rate-limits/apply')) {
      current.latest_operation = { ...operation('unknown'), operation_id: 'new-apply-operation' }; current.version = 8;
      throw new Error('Apply response lost after intent creation');
    }
    if (path === '/api/v1/admin/cloudflare/operations/new-apply-operation/verify') { current.latest_operation.status = 'verified'; return write(current.latest_operation); }
    if (path === '/api/v1/admin/cloudflare/verify') { assert.equal(current.latest_operation.status, 'verified'); return write(current); }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Policy fixture'));
    const form = all(section(host, 'connection-rate-heading')).find(item => item.tag === 'form');
    all(form).find(item => item.tag === 'input').props['onUpdate:modelValue'](73); await nextTick(); await submit(form);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Apply this plan').props.onClick(); await nextTick();
    assert.match(text(section(host, 'connection-operation-heading')), /old-operation/);
    const beforeReadback = calls.length;
    await all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick(); await nextTick();
    assert.equal(calls[beforeReadback].path, '/api/v1/admin/cloudflare');
    assert.equal(calls.filter(call => call.path.includes('/operations/old-operation/')).length, 0);
    assert.equal(calls.filter(call => call.path === '/api/v1/admin/cloudflare/operations/new-apply-operation/verify').length, 1);
    assert.match(text(section(host, 'connection-operation-heading')), /Verified.*new-apply-operation/);
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
    assert.equal(all(form).find(item => item.tag === 'button').props.disabled, false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('request limits reject invalid values, preview before explicit apply, and pending operations require verification', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/rate-limits/plan')) return write({ plan_id: 'plan-fixture', kind: 'rate_limit', version: 7, baseline_version_id: 'v1', baseline_deployment_id: 'd1', target: current.target, before: { limit: 300, period_seconds: 60 }, after: { limit: 123, period_seconds: 10 }, created_at: '2026-10-07T00:00:00Z' });
    if (path.endsWith('/rate-limits/apply')) { current.latest_operation = operation('pending'); return write(current.latest_operation); }
    if (path.includes('/operations/') && path.endsWith('/verify')) { current.latest_operation = operation('verified'); return write(current.latest_operation); }
    if (path.endsWith('/verify')) return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Policy fixture'));
    const rate = section(host, 'connection-rate-heading'); const form = all(rate).find(item => item.tag === 'form');
    const limit = all(form).find(item => item.tag === 'input'); const selects = all(form).filter(item => item.tag === 'select');
    assert.equal(selects[0].children.length, 5);
    limit.props['onUpdate:modelValue'](1.5); await nextTick(); await submit(form);
    assert.equal(calls.filter(call => call.path.includes('/plan')).length, 0);
    limit.props['onUpdate:modelValue'](123); selects[1].props['onUpdate:modelValue']('10'); await nextTick(); await submit(form);
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/rate-limits/plan')).init.body), { scope: 'instance', limit: 123, period_seconds: 10, expected_version: 4 });
    assert.equal(calls.filter(call => call.path.endsWith('/apply')).length, 0);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Apply this plan').props.onClick(); await nextTick();
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/rate-limits/apply')).init.body), { plan_id: 'plan-fixture', expected_version: 7 });
    assert.match(text(host), /Pending; verify the result.*not confirmed active/);
    assert.equal(all(rate).find(item => item.tag === 'button').props.disabled, true);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick(); await nextTick();
    assert.match(text(section(host, 'connection-operation-heading')), /Verified/);
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a superseded live provider read cannot replace verified notification or WAF state', async () => {
  const originalFetch = globalThis.fetch; let finishOldRead; let notificationReads = 0;
  const current = connection();
  globalThis.fetch = async path => {
    if (path.endsWith('/notifications')) {
      notificationReads++;
      if (notificationReads === 1) return new Promise(resolve => { finishOldRead = () => resolve(Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'old', name: 'Old policy', enabled: true, alert_type: 'old', emails: [] }] })); });
      return Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'new', name: 'New policy', enabled: true, alert_type: 'new', emails: [] }] });
    }
    if (path.endsWith('/waf')) return Response.json({ status: 'verified', zone_id: 'zone-fixture', hostname: 'kanban.example.com', owned_rule: null, other_rule_count: 0, protected: notificationReads > 1 });
    if (path.endsWith('/verify')) return write(current);
    return Response.json(current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => finishOldRead);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick();
    await until(() => text(host).includes('New policy'));
    finishOldRead(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(text(host), /New policy/); assert.doesNotMatch(text(host), /Old policy/);
    assert.match(text(section(host, 'connection-waf-heading')), /blocking rule is verified active/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a plan returned after its form values change is discarded', async () => {
  const originalFetch = globalThis.fetch; let finishPlan;
  globalThis.fetch = async path => {
    if (path.endsWith('/rate-limits/plan')) return new Promise(resolve => { finishPlan = () => resolve(write({ plan_id: 'stale-plan', kind: 'rate_limit', version: 4, target: connection().target, before: {}, after: { limit: 123 } })); });
    return providerRead(path, connection());
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Policy fixture'));
    const form = all(section(host, 'connection-rate-heading')).find(item => item.tag === 'form');
    const limit = all(form).find(item => item.tag === 'input');
    limit.props['onUpdate:modelValue']('123'); await nextTick();
    const pending = submit(form); await until(() => finishPlan);
    assert.equal(limit.props.disabled, true);
    limit.props['onUpdate:modelValue']('456'); await nextTick();
    finishPlan(); await pending; await nextTick();
    assert.equal(section(host, 'connection-plan-heading'), undefined);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('current settings fill each form and consecutive previews use the updated control version', async () => {
  const originalFetch = globalThis.fetch; const calls = []; let version = 4;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/configuration/plan')) {
      const body = JSON.parse(init.body); assert.equal(body.expected_version, version);
      version++;
      return write({ plan_id: `plan-${version}`, kind: 'configuration', version, target: connection().target, before: { history_enabled: false }, after: body.settings });
    }
    return providerRead(path, connection());
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Policy fixture'));
    const configForm = all(section(host, 'connection-configuration-heading')).find(item => item.tag === 'form');
    const configSelects = all(configForm).filter(item => item.tag === 'select');
    assert.equal(configSelects[1].props.value, 'false');
    configSelects[1].props['onUpdate:modelValue']('true'); await nextTick(); await submit(configForm);
    assert.equal(calls.filter(call => call.path.endsWith('/configuration/plan')).length, 1);
    configSelects[1].props['onUpdate:modelValue']('false'); await nextTick(); await submit(configForm);
    assert.equal(calls.filter(call => call.path.endsWith('/configuration/plan')).length, 2);
    configSelects[0].props['onUpdate:modelValue']('warning_percent'); await nextTick();
    all(configForm).find(item => item.tag === 'input').props['onUpdate:modelValue'](73); await nextTick(); await submit(configForm);
    assert.deepEqual(JSON.parse(calls.filter(call => call.path.endsWith('/configuration/plan')).at(-1).init.body), { settings: { warning_percent: 73 }, expected_version: 6 });
    const rate = section(host, 'connection-rate-heading'); const rateForm = all(rate).find(item => item.tag === 'form');
    const selects = all(rateForm).filter(item => item.tag === 'select');
    assert.equal(all(rateForm).find(item => item.tag === 'input').props.value, '300');
    selects[0].props['onUpdate:modelValue']('anonymous_login'); await nextTick();
    assert.equal(all(rateForm).find(item => item.tag === 'input').props.value, '11');
    assert.equal(selects[1].props.value, '10');
    assert.match(text(rate), /Current Worker configuration: 11 \/ 10 seconds/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

const metric = (scope, value, unit = 'count') => ({ key: 'd1_rows_read', value, unit, source: 'cloudflare', scope, period_start: '2026-10-05T00:00:00Z', period_end: '2026-10-06T00:00:00Z', observed_at: null });
const dayMetrics = (day, values) => values.map(value => ({ ...value, period_start: `${day}T00:00:00Z`, period_end: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString() }));
const historyFixture = (enabled = true) => ({ enabled, retention_days: 90, generated_at: '2026-10-07T02:00:00Z', items: enabled ? [
  { day: '2026-10-04', complete_day: true, collected_at: '2026-10-05T02:00:00Z', metrics: dayMetrics('2026-10-04', [metric('instance', 0), metric('account', 100)]) },
  { day: '2026-10-05', complete_day: true, collected_at: '2026-10-06T02:00:00Z', metrics: dayMetrics('2026-10-05', [metric('instance', null), metric('account', null)]) },
  { day: '2026-10-06', complete_day: true, collected_at: '2026-10-07T02:00:00Z', metrics: dayMetrics('2026-10-06', [metric('instance', 4), metric('account', 120)]) },
] : [], missing_days: ['2026-10-05'], source: 'cloudflare_analytics', history_kind: 'utc_daily', error: null });

test('history fills unknown days, keeps actual zero and separate scopes, and collects one selected complete UTC day only on request', async () => {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return Response.json(historyFixture()); };
  const app = renderer.createApp(History); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('D1 rows read'));
    assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/v1/admin/usage/history?days=30');
    assert.match(text(host), /2026-10-04.*0 count.*2026-10-05.*Unknown.*2026-10-06.*4 count/);
    assert.doesNotMatch(text(host), /100 count|120 count/);
    const controls = all(host).find(item => item.props.class === 'history-controls');
    const selects = all(controls).filter(item => item.tag === 'select');
    selects[1].props['onUpdate:modelValue']('account'); await nextTick();
    assert.match(text(host), /100 count.*120 count/);
    assert.equal(calls.length, 1);
    selects[0].props['onUpdate:modelValue']('7'); await until(() => calls.length === 2 && text(host).includes('120 count'));
    assert.equal(calls[1].path, '/api/v1/admin/usage/history?days=7');
    const form = all(host).find(item => item.tag === 'form' && item.props.class === 'history-backfill');
    const daySelect = all(form).find(item => item.tag === 'select');
    assert.equal(daySelect.children.length, 7); assert.ok(daySelect.children.every(item => item.props.value < '2026-10-07'));
    await submit(form); await nextTick();
    const collect = calls.find(call => call.path.endsWith('/collect'));
    assert.deepEqual(JSON.parse(collect.init.body), { day: '2026-10-06' });
    assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(host), /完整 UTC 日|最近 7 个完整 UTC 日/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('disabled history does no collection and enabling requires a reviewed Worker configuration plan', async () => {
  const originalFetch = globalThis.fetch; const calls = []; let enabled = false;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path === '/api/v1/admin/cloudflare') return Response.json(connection());
    if (path.endsWith('/configuration/plan')) return write({ plan_id: 'history-plan', version: 4, before: { history_enabled: false }, after: { history_enabled: true }, target: connection().target });
    if (path.endsWith('/configuration/apply')) { enabled = true; return write(operation('verified')); }
    return Response.json(historyFixture(enabled));
  };
  const app = renderer.createApp(History); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('History collection disabled'));
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls.length, 1);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Preview enabling history').props.onClick(); await nextTick();
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/configuration/plan')).init.body), { settings: { history_enabled: true }, expected_version: 4 });
    assert.equal(calls.filter(call => call.path.endsWith('/configuration/apply')).length, 0);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Apply this plan').props.onClick(); await until(() => text(host).includes('History collection enabled'));
    assert.equal(calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith('/collect')).length, 0);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('history rejects mismatched units and UTC windows while retaining real storage observation times', async () => {
  const originalFetch = globalThis.fetch; const fixture = historyFixture();
  fixture.items[0].metrics[0].unit = 'bytes';
  fixture.items[2].metrics[0].period_start = '2026-10-05T00:00:00Z';
  fixture.items[1].metrics.push({ key: 'r2_storage_bytes', scope: 'instance', unit: 'bytes', value: 16, period_start: null, period_end: null, observed_at: '2026-10-05T22:00:00Z' });
  fixture.items[2].metrics.push({ key: 'r2_storage_bytes', scope: 'instance', unit: 'bytes', value: 32, period_start: null, period_end: null, observed_at: '2026-10-05T23:00:00Z' });
  globalThis.fetch = async () => Response.json(fixture);
  const app = renderer.createApp(History); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('D1 rows read'));
    assert.doesNotMatch(text(host), /0 count|4 count/);
    assert.equal(all(host).filter(item => item.tag === 'circle').length, 0);
    const selects = all(all(host).find(item => item.props.class === 'history-controls')).filter(item => item.tag === 'select');
    selects[2].props['onUpdate:modelValue']('r2_storage_bytes'); await nextTick();
    assert.match(text(host), /16 bytes.*2026-10-05 22:00:00 UTC/);
    assert.doesNotMatch(text(host), /32 bytes/);
    assert.match(text(host), /2026-10-05 23:00:00 UTC/);
    assert.equal(all(host).filter(item => item.tag === 'circle').length, 1);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('uncertain collection requires history readback and an unresolved control operation blocks collection', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/collect')) throw new Error('Collection response lost');
    if (path === '/api/v1/admin/cloudflare') return Response.json(current);
    return Response.json(historyFixture());
  };
  const app = renderer.createApp(History); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('D1 rows read'));
    const form = all(host).find(item => item.props.class === 'history-backfill');
    await submit(form); await nextTick();
    assert.match(text(host), /Collection result is unknown.*Read history/);
    assert.equal(all(form).find(item => item.tag === 'button').props.disabled, true);
    await submit(form); assert.equal(calls.filter(call => call.path.endsWith('/collect')).length, 1);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Read history').props.onClick(); await nextTick();
    assert.equal(all(form).find(item => item.tag === 'button').props.disabled, false);
    current.latest_operation = operation('unknown');
    await submit(form); await nextTick();
    assert.match(text(host), /Configuration is not confirmed active/);
    assert.equal(all(form).find(item => item.tag === 'button').props.disabled, true);
    await submit(form); assert.equal(calls.filter(call => call.path.endsWith('/collect')).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith('/configuration/plan')).length, 0);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('history geometry does not connect nulls or missing UTC days, while zero remains an observed point', () => {
  const point = (day, value) => ({ day, value, periodStart: null, periodEnd: null, observedAt: null });
  const geometry = historyGeometry([point('2026-10-01', 0), point('2026-10-02', 2), point('2026-10-03', null), point('2026-10-04', 3), point('2026-10-06', 5)]);
  assert.equal(geometry.segments.length, 3); assert.equal(geometry.dots.length, 4);
  assert.equal(geometry.dots[0].y, 180);
  assert.equal(geometry.segments[0].split(' ').length, 2);
  assert.equal(historyGeometry([point('2026-10-01', null)]).dots.length, 0);
  assert.equal(historyGeometry([point('2026-10-01', Infinity), point('2026-10-02', 4)]).maximum, 4);
});
