import { nuxtUiTestPlugin } from './nuxt-ui-test-plugin.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';

const originals = { Document: globalThis.Document, ShadowRoot: globalThis.ShadowRoot, document: globalThis.document, window: globalThis.window };
const storageWrites = [];
const windowListeners = new Map();
globalThis.Document = class {}; globalThis.ShadowRoot = class {};
globalThis.document = { cookie: 'cfkanban_csrf=fixture-csrf', documentElement: { lang: 'en' } };
globalThis.window = { location: { origin: 'https://kanban.example.test', pathname: '/app/admin', search: '' }, addEventListener(type, listener) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(listener); }, removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); }, dispatchEvent(event) { for (const listener of windowListeners.get(event.type) ?? []) listener(event); return true; }, navigator: { language: 'en' }, localStorage: { getItem() { return null; }, setItem(key, value) { storageWrites.push({ key, value }); } } };
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
const section = (host, heading) => all(host).find(item => ['section', 'details'].includes(item.tag) && item.props['aria-labelledby'] === heading);
const write = resource => Response.json({ resource, event_cursor: 'fixture', idempotent_replay: false });
const operation = status => ({ operation_id: '11111111-1111-4111-8111-111111111111', kind: 'configuration_secret', status, version: 5, baseline_version_id: 'v1', result_version_id: status === 'verified' ? 'v2' : null, deployment_id: null, failure_class: null, created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' });
const connection = () => ({ version: 4, target: { account_id: 'account-fixture', worker_name: 'worker-fixture', database_id: 'db-fixture', zone_id: 'zone-fixture', hostname: 'kanban.example.com' }, configured: { connection: true, configuration: true, control: false, analytics: false }, capabilities: { configuration: 'verified', notifications: 'unverified', waf: 'permission_denied', billing: 'unsupported_contract', analytics: 'missing' }, verified_at: null, budget: { status: 'unsupported_contract', dashboard_url: 'https://dash.cloudflare.com/', docs_url: 'https://developers.cloudflare.com/billing/manage/budget-alerts/' }, latest_operation: null, configuration: { history_enabled: false, analytics_enabled: true, billing_plan: 'free', billing_cycle_day: 10, account_totals: false, warning_percent: 75 } });
const rateFixture = () => ({ configuration_source: 'worker_configuration', editable_via_api: false, policies: { instance: { limit: 300, period_seconds: 60 }, principal: { limit: 120, period_seconds: 60 }, unauthenticated_sensitive: { limit: 30, period_seconds: 60 } }, cost_protection: { anonymous_login: { enabled: true, policy: { limit: 11, period_seconds: 10 } }, expensive_reads: { enabled: true, policy: { limit: 10, period_seconds: 60 } }, concurrency: { enabled: true, per_principal: 2, per_isolate: 32 } } });
function providerRead(path, current) {
  if (path.endsWith('/rate-limit-settings')) return Response.json(rateFixture());
  if (path.endsWith('/notifications')) return Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'policy-fixture', name: 'Policy fixture', alert_type: 'billing_usage_alert', enabled: true, emails: ['fixture@example.invalid'], filters: { limit: 80 } }] });
  if (path.endsWith('/waf')) return Response.json({ status: 'permission_denied', zone_id: 'zone-fixture', hostname: 'kanban.example.com', owned_rule: null, other_rule_count: null, protected: false });
  return Response.json(current);
}

const problem = (status, { source = 'service', category = status === 400 ? 'validation' : status === 403 ? 'authorization' : status === 404 ? 'not_found' : 'conflict', code = status === 409 ? 'VERSION_CONFLICT' : status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', details = {} } = {}) => {
  const requestId = crypto.randomUUID();
  return Response.json({ category, code, details, message: 'unsafe provider body must not render', recovery: 'request_owner', request_id: requestId, retryable: false, source }, { status, headers: { 'x-request-id': requestId } });
};
const management = host => all(host).find(item => item.tag === 'details' && item.props.class === 'connection-management');
const tokenInput = host => all(host).find(item => item.props.id === 'cloudflare-token-connection');
const tokenForm = host => all(host).find(item => item.tag === 'form' && item.props.class === 'cloudflare-token-form');
const button = (host, label) => all(host).find(item => item.tag === 'button' && text(item) === label);
const capabilityRows = host => all(host).filter(item => item.tag === 'details' && item.props.class === 'capability-item');
const row = (host, label) => capabilityRows(host).find(item => text(item).startsWith(label));
const capabilitySummary = entry => all(entry).find(item => item.tag === 'summary');
const mounted = host => text(host).includes('worker-fixture');

test('Overview folds a checked connection into a small card with one Token save action and five meaningful functions', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return providerRead(path, current); };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    assert.match(text(host), /Connected/); assert.equal(management(host).props.open, false);
    assert.equal(section(host, 'connection-rate-heading'), undefined);
    assert.equal(all(host).some(item => item.props.class === 'required-capability-summary'), false);
    assert.equal(all(host).some(item => item.props.class === 'muted-copy connection-next-step'), false);
    assert.equal(capabilityRows(host).length, 5);
    assert.equal(all(host).filter(item => item.tag === 'input' && item.props.type === 'password').length, 1);
    assert.equal(all(tokenForm(host)).filter(item => item.tag === 'button').length, 1);
    assert.equal(text(button(tokenForm(host), 'Save Token')), 'Save Token');
    assert.equal(button(host, 'Connect Cloudflare'), undefined);
    assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'GET');
    const tokens = section(host, 'connection-tokens-heading');
    const required = section(tokens, 'token-required-permissions-heading');
    const optional = section(tokens, 'token-optional-permissions-heading');
    assert.equal(all(required).filter(item => item.tag === 'li').length, 2);
    assert.equal(all(optional).filter(item => item.tag === 'li').length, 4);
    assert.match(text(tokens), /Manage Account → Account API Tokens → Create Token.*one account-owned Token/);
    assert.match(text(required), /Specified Workers → select this existing Worker: worker-fixture.*Developer Platform → Individual Workers → Editor.*code, deployment, Secret, and configuration modification authority/);
    assert.match(text(optional), /DNS & Zones → Zone → Read.*App Security → Zone WAF Rules → Read/);
    assert.match(text(row(host, 'Save, deploy and modify the Worker')), /this instance’s active Worker configuration and D1 binding.*does not probe every write operation/);
    assert.match(text(row(host, 'Read usage analytics')), /specified D1 database passed.*Workers, R2 and other metrics depend on their actual queries/);
    const labels = [
      ['Save, deploy and modify the Worker', 'Worker 的保存、部署与修改', 'Developer Platform → Individual Workers → Editor'],
      ['Read usage analytics', '分析读取用量', 'Analytics & Logs → Account Analytics → Read'],
      ['Read billing', '账务读取', 'Account & Billing → Billing → Read'],
      ['Read notifications', '通知读取', 'Account & Billing → Notifications → Read'],
      ['Read domain protection', '域名防护读取', 'DNS & Zones → Zone → Read · App Security → Zone WAF Rules → Read'],
    ];
    for (const [en, , path] of labels) {
      const summary = capabilitySummary(row(host, en));
      assert.ok(text(summary).startsWith(`${en} (${path})`));
      assert.doesNotMatch(text(summary), /Saved Token|Existing .* authorization|Optional/);
      assert.equal(all(summary).some(item => item.props['data-icon'] === 'i-lucide-chevron-down'), false);
    }
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /已连接.*Worker 的保存、部署与修改.*分析读取用量.*账务读取.*通知读取.*域名防护读取/);
    for (const [, zh, path] of labels) assert.ok(text(capabilitySummary(row(host, zh))).startsWith(`${zh}（${path}）`));
    assert.equal(text(button(tokenForm(host), '保存 Token')), '保存 Token');
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('legacy analytics remains visibly separate from a new Token and missing permissions remain neutral', async () => {
  const originalFetch = globalThis.fetch; const current = connection();
  current.configured = { connection: false, configuration: false, control: false, analytics: true };
  current.capabilities.configuration = 'missing'; current.capabilities.analytics = 'verified'; current.target.zone_id = null;
  globalThis.fetch = async path => providerRead(path, current);
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    assert.equal(management(host).props.open, true); assert.equal(tokenInput(host).props.disabled, false);
    assert.doesNotMatch(text(host), /Usage is available; settings cannot be changed yet|create a Token with settings permissions|Existing authorization remains available/);
    assert.equal(all(host).some(item => item.props.class === 'connection-summary'), false);
    assert.equal(all(host).some(item => item.props.class === 'muted-copy connection-next-step'), false);
    assert.equal(row(host, 'Save, deploy and modify the Worker').props['data-state'], 'neutral');
    assert.equal(row(host, 'Read usage analytics').props['data-state'], 'verified');
    assert.match(text(row(host, 'Read usage analytics')), /Existing analytics authorization/);
    assert.doesNotMatch(text(capabilitySummary(row(host, 'Read usage analytics'))), /Existing analytics authorization/);
    assert.equal(row(host, 'Read domain protection').props['data-state'], 'neutral');
    assert.match(text(row(host, 'Read domain protection')), /Zone not selected/);
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(host), /现有统计授权/);
    assert.doesNotMatch(text(host), /统计可用，尚不能修改设置|要修改设置，请先|现有授权仍可使用/);
    assert.doesNotMatch(text(capabilitySummary(row(host, '分析读取用量'))), /现有统计授权/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('function icons distinguish actual success, explicit rejection and states that have not been checked', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ['missing', 'unverified', 'unavailable', 'unsupported_contract', 'permission_denied', 'target_mismatch', 'verified']) {
      const current = connection(); current.capabilities.configuration = state;
      globalThis.fetch = async path => providerRead(path, current);
      const app = renderer.createApp(Control); const host = node('root');
      try {
        app.mount(host); await until(() => mounted(host));
        const entry = row(host, 'Save, deploy and modify the Worker');
        const expected = state === 'verified' ? 'verified' : ['permission_denied', 'target_mismatch'].includes(state) ? 'denied' : 'neutral';
        assert.equal(entry.props['data-state'], expected);
        const icon = all(entry).find(item => item.props['data-icon']);
        assert.equal(icon.props['data-icon'], expected === 'verified' ? 'i-lucide-circle-check' : expected === 'denied' ? 'i-lucide-circle-x' : 'i-lucide-circle-minus');
        assert.ok(all(entry).some(item => item.tag === 'summary' && item.props.class === 'capability-summary'));
        assert.ok(all(entry).some(item => item.props.class === 'capability-info'));
        assert.match(text(entry), /Current Worker: worker-fixture.*Developer Platform → Individual Workers → Editor/);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('core checks collapse a resolved connection and optional reads require an explicit user action', async () => {
  const originalFetch = globalThis.fetch; const current = connection(); const calls = [];
  current.capabilities.configuration = 'unverified';
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path === '/api/v1/admin/cloudflare/verify') {
      const optional = JSON.parse(init.body).include_optional === true;
      current.capabilities.configuration = current.capabilities.analytics = 'verified';
      if (optional) current.capabilities.billing = current.capabilities.notifications = current.capabilities.waf = 'verified';
      return write(current);
    }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    await button(host, 'Check again').props.onClick(); await nextTick();
    assert.equal(management(host).props.open, false);
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/verify')).init.body), {});
    assert.equal(calls.some(call => call.path.endsWith('/notifications') || call.path.endsWith('/waf')), false);
    await button(host, 'Check other functions').props.onClick(); await nextTick();
    assert.deepEqual(JSON.parse(calls.filter(call => call.path.endsWith('/verify')).at(-1).init.body), { include_optional: true });
    assert.equal(row(host, 'Read billing').props['data-state'], 'verified');
    assert.equal(row(host, 'Read notifications').props['data-state'], 'verified');
    assert.equal(row(host, 'Read domain protection').props['data-state'], 'verified');
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('an initial read failure gives a clear retry action without claiming a Token save is unknown', async () => {
  const originalFetch = globalThis.fetch; let failRead = true; const current = connection();
  globalThis.fetch = async path => {
    if (path === '/api/v1/admin/cloudflare' && failRead) throw new Error('untrusted read failure');
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('current status is temporarily unavailable'));
    assert.equal(tokenInput(host), undefined); assert.doesNotMatch(text(host), /save result is unknown|untrusted read failure/);
    failRead = false; await button(host, 'Check current status').props.onClick(); await until(() => mounted(host));
    assert.equal(tokenInput(host).props.disabled, false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('Usage explains unavailable limits and links to Overview instead of showing unexplained grey controls', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ['missing', 'unverified', 'permission_denied', 'pending', 'unknown']) {
      const current = connection();
      if (state === 'missing') { current.configured.connection = current.configured.configuration = false; current.capabilities.configuration = 'missing'; }
      else if (['pending', 'unknown'].includes(state)) current.latest_operation = operation(state);
      else current.capabilities.configuration = state;
      globalThis.fetch = async path => providerRead(path, current);
      const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Current limit: 300'));
        const rate = section(host, 'connection-rate-heading');
        assert.equal(all(rate).some(item => item.tag === 'form'), false);
        assert.ok(all(rate).some(item => item.tag === 'a' && item.props.href === '/app/admin'));
        assert.match(text(rate), state === 'missing' ? /first save a Token with settings permissions/ : state === 'unverified' ? /Token is saved but has not been checked/ : state === 'permission_denied' ? /current Token cannot change these limits/ : /last save is not confirmed yet/);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('Usage keeps five limit scopes and reads notification policies and WAF only after expansion', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return providerRead(path, current); };
  const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.init.method === 'GET'));
    assert.equal(all(host).filter(item => item.tag === 'input' && item.props.type === 'password').length, 0);
    assert.equal(all(section(host, 'connection-rate-heading')).find(item => item.tag === 'select').children.length, 5);
    const notifications = section(host, 'connection-notifications-heading');
    notifications.props.onToggle({ target: { open: true } }); await until(() => text(host).includes('Policy fixture'));
    assert.match(text(notifications), /Policy fixture.*Enabled.*billing_usage_alert.*fixture@example.invalid/);
    assert.doesNotMatch(text(notifications), /80|\$80/);
    const waf = section(host, 'connection-waf-heading'); waf.props.onToggle({ target: { open: true } });
    await until(() => calls.some(call => call.path.endsWith('/waf')) && !text(waf).includes('Reading…'));
    assert.match(text(waf), /permission denied.*No active tool-owned blocking rule is confirmed/);
    const budget = section(host, 'connection-budget-heading');
    assert.match(text(budget), /Not available to check/);
    assert.match(text(budget), /selected email recipients.*separate from cfKanban.*do not stop usage or cap charges/);
    assert.equal(all(budget).some(item => ['button', 'input', 'textarea', 'select'].includes(item.tag)), false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('Token submission clears immediately, uses an explicit key, and recovers only the original save without replay', async () => {
  const originalFetch = globalThis.fetch; const calls = []; let rejectSave; let lookupReady = false; let checkCount = 0;
  const current = connection(); current.latest_operation = { ...operation('verified'), operation_id: '22222222-2222-4222-8222-222222222222' };
  current.configured = { connection: false, configuration: false, control: false, analytics: true }; current.capabilities.configuration = 'missing'; current.capabilities.analytics = 'verified';
  const originalSave = { ...operation('unknown'), operation_id: '33333333-3333-4333-8333-333333333333' };
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) return new Promise((_resolve, reject) => { rejectSave = () => reject(new Error('fixture-secret-must-not-render')); });
    if (path.includes('/secret-operations/')) return lookupReady ? Response.json(originalSave) : problem(404);
    if (path.endsWith('/operations/33333333-3333-4333-8333-333333333333/verify')) {
      checkCount++; originalSave.status = checkCount === 1 ? 'pending' : 'verified'; return write(originalSave);
    }
    if (path === '/api/v1/admin/cloudflare/verify') {
      assert.equal(originalSave.status, 'verified', 'core checks cannot replace verification of the original save');
      current.configured.connection = true; current.capabilities.configuration = 'verified'; return write(current);
    }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('fixture-secret-must-not-render'); await nextTick();
    const pending = submit(tokenForm(host)); await until(() => rejectSave);
    assert.equal(tokenInput(host).props.value, '');
    const request = calls.find(call => call.path.endsWith('/secrets'));
    assert.deepEqual(JSON.parse(request.init.body), { kind: 'connection', token: 'fixture-secret-must-not-render', expected_version: 4 });
    const key = request.init.headers.get('idempotency-key'); assert.match(key, /^[0-9a-f-]{36}$/);
    assert.equal(request.init.headers.get('x-csrf-token'), 'fixture-csrf'); assert.equal(request.init.credentials, 'same-origin');
    rejectSave(); await pending; await nextTick();
    assert.equal(tokenInput(host).props.disabled, true); assert.doesNotMatch(text(host), /fixture-secret-must-not-render/);
    assert.match(text(row(host, 'Save, deploy and modify the Worker')), /No authorization saved/);
    assert.match(text(row(host, 'Read usage analytics')), /Existing analytics authorization \(this save awaits confirmation\)/);
    assert.doesNotMatch(text(row(host, 'Read notifications')), /Previously confirmed authorization/);
    assert.equal(all(host).filter(item => item.props.role === 'alert').length, 1, 'unknown save has one feedback message');
    assert.equal(button(tokenForm(host), 'Check save result'), undefined, 'the form does not duplicate its parent feedback');
    await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(calls.find(call => call.path.includes('/secret-operations/')).path, `/api/v1/admin/cloudflare/secret-operations/${key}`);
    assert.match(text(host), /save record is not available yet/); assert.equal(tokenInput(host).props.disabled, true);
    assert.equal(calls.filter(call => call.path.endsWith('/verify')).length, 0, 'old latest operation cannot unlock a lost save');
    lookupReady = true; await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(checkCount, 1); assert.equal(tokenInput(host).props.disabled, true);
    await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(checkCount, 2); assert.equal(tokenInput(host).props.disabled, false); assert.equal(tokenInput(host).props.value, '');
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(calls.some(call => call.path.includes('/operations/22222222-2222-4222-8222-222222222222/')), false);
    assert.ok(storageWrites.every(entry => !entry.value.includes('fixture-secret-must-not-render')));
    assert.equal(management(host).props.open, false, 'terminal recovery collapses the card');
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('structured validation, Cloudflare permission and conflict rejections allow correction without an unknown-save warning', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [400, 403, 409]) {
      const current = connection(); const calls = [];
      globalThis.fetch = async (path, init) => {
        calls.push({ path, init });
        if (path.endsWith('/secrets')) return problem(status, { source: status === 400 ? 'service' : 'cloudflare_platform', details: { failure_class: status === 403 ? 'permission_denied' : 'target_mismatch', provider_operation: 'settings', provider_method: 'GET', provider_status: status, provider_body: 'unsafe provider body' } });
        return providerRead(path, current);
      };
      const app = renderer.createApp(Control); const host = node('root');
      try {
        app.mount(host); await until(() => mounted(host));
        tokenInput(host).props['onUpdate:modelValue']('fake-rejected-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
        assert.match(text(host), /Token was not saved/); assert.doesNotMatch(text(host), /save result is unknown|save is still being verified|unsafe provider body|fake-rejected-secret/);
        if (status !== 400) assert.match(text(host), new RegExp(`Failed step: Read Worker settings · GET · Cloudflare HTTP ${status}`));
        assert.equal(button(host, 'Check save result'), undefined); assert.equal(tokenInput(host).props.disabled, false);
        assert.equal(tokenInput(host).props.value, '');
        tokenInput(host).props['onUpdate:modelValue']('replacement-secret'); await nextTick();
        assert.equal(button(tokenForm(host), 'Save Token').props.disabled, false);
        assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('verified provider HTTP failure diagnostics remain visible while an unconfirmed save stays locked', async () => {
  const originalFetch = globalThis.fetch; const current = connection(); let secretWrites = 0;
  globalThis.fetch = async path => {
    if (path.endsWith('/secrets')) {
      secretWrites++;
      return problem(503, { source: 'cloudflare_platform', category: 'platform_failure', code: 'PLATFORM_UNAVAILABLE', details: { failure_class: 'unavailable', provider_operation: 'deployments', provider_method: 'GET', provider_status: 503, provider_body: 'unsafe provider body' } });
    }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('fake-unconfirmed-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
    assert.match(text(host), /save result is unknown/);
    assert.match(text(host), /Failed step: Read Worker deployment · GET · Cloudflare HTTP 503 · Request ID:/);
    assert.doesNotMatch(text(host), /unsafe provider body|fake-unconfirmed-secret|Token was not saved/);
    assert.equal(tokenInput(host).props.disabled, true); assert.equal(tokenInput(host).props.value, ''); assert.equal(secretWrites, 1);
    assert.ok(button(host, 'Check save result'));
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('an explicitly failed save gives the confirmed failure reason and keeps the Token field usable', async () => {
  const originalFetch = globalThis.fetch; const current = connection();
  globalThis.fetch = async path => {
    if (path.endsWith('/secrets')) { current.latest_operation = { ...operation('failed'), failure_class: 'permission_denied' }; return write(current.latest_operation); }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('failed-save-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
    assert.match(text(host), /Token save failed.*Cloudflare denied the save permission/);
    assert.doesNotMatch(text(host), /save result is unknown|failed-save-secret/); assert.equal(tokenInput(host).props.disabled, false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a verified save followed by failed status or function reads remains a saved Token', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const failureStage of ['readback', 'capabilities']) {
      const current = connection(); let saved = false; let readFails = true; const calls = [];
      globalThis.fetch = async (path, init) => {
        calls.push({ path, init });
        if (path.endsWith('/secrets')) { saved = true; current.configured.connection = true; current.latest_operation = operation('verified'); current.capabilities.configuration = current.capabilities.analytics = 'unverified'; return write(current.latest_operation); }
        if (readFails && saved && (failureStage === 'readback' ? path === '/api/v1/admin/cloudflare' : path === '/api/v1/admin/cloudflare/verify')) throw new Error('post-save read unavailable');
        if (path === '/api/v1/admin/cloudflare/verify') { current.capabilities.configuration = current.capabilities.analytics = 'verified'; return write(current); }
        return providerRead(path, current);
      };
      const app = renderer.createApp(Control); const host = node('root');
      try {
        app.mount(host); await until(() => mounted(host));
        tokenInput(host).props['onUpdate:modelValue']('verified-save-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
        assert.match(text(host), failureStage === 'readback' ? /Token saved.*latest status is temporarily unavailable/ : /Token saved.*Some functions could not be confirmed yet/);
        assert.doesNotMatch(text(host), /save result is unknown|Token save failed|verified-save-secret/); assert.equal(button(host, 'Check save result'), undefined);
        assert.equal(row(host, 'Save, deploy and modify the Worker').props['data-state'], 'neutral');
        readFails = false; await button(host, 'Check again').props.onClick(); await nextTick();
        assert.equal(row(host, 'Save, deploy and modify the Worker').props['data-state'], 'verified');
        assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('a pending save stays locked across Overview and Usage and verifies its exact operation', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); const mode = ref('overview');
  const pendingSave = { ...operation('pending'), operation_id: '44444444-4444-4444-8444-444444444444' };
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) return write(pendingSave);
    if (path.endsWith('/operations/44444444-4444-4444-8444-444444444444/verify')) { pendingSave.status = 'verified'; current.latest_operation = pendingSave; return write(pendingSave); }
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp({ render: () => h(Control, { mode: mode.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('44444444-4444-4444-8444-444444444444-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
    assert.equal(tokenInput(host).props.disabled, true); assert.equal(calls.filter(call => call.path.endsWith('/verify')).length, 0);
    mode.value = 'usage'; await until(() => text(host).includes('Current limit: 300'));
    assert.match(text(section(host, 'connection-rate-heading')), /last save is not confirmed yet/);
    await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(button(section(host, 'connection-rate-heading'), 'Change limit').props.disabled, false);
    mode.value = 'overview'; await nextTick(); assert.equal(tokenInput(host).props.disabled, false); assert.equal(tokenInput(host).props.value, '');
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(calls.some(call => call.path.includes('/secret-operations/')), false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('function details support hover, focus, persistent keyboard activation and touch without hiding the status text', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = async path => providerRead(path, connection());
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    const entry = row(host, 'Save, deploy and modify the Worker'); const summary = all(entry).find(item => item.tag === 'summary');
    assert.equal(entry.props.open, false); assert.match(text(summary), /Save, deploy and modify the Worker \(Developer Platform → Individual Workers → Editor\).*Available/);
    entry.props.onPointerenter({ pointerType: 'mouse' }); await nextTick(); assert.equal(entry.props.open, true); assert.equal(entry.props['data-preview'], true);
    entry.props.onPointerleave(); await nextTick(); assert.equal(entry.props.open, false);
    entry.props.onFocusin(); await nextTick(); assert.equal(entry.props.open, true);
    summary.props.onClick({ preventDefault() {} }); await nextTick(); assert.equal(entry.props.open, true); assert.equal(entry.props['data-preview'], false);
    entry.props.onFocusout({ currentTarget: { contains: () => false }, relatedTarget: null }); await nextTick(); assert.equal(entry.props.open, true);
    summary.props.onClick({ preventDefault() {} }); await nextTick(); assert.equal(entry.props.open, false);
    entry.props.onPointerenter({ pointerType: 'touch' }); await nextTick(); assert.equal(entry.props.open, false);
    summary.props.onClick({ preventDefault() {} }); await nextTick(); assert.equal(entry.props.open, true);
    assert.match(text(entry), /Individual Workers · Editor.*Current Worker: worker-fixture.*does not probe every write operation/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('malformed successful save responses keep the original key and never unlock or replay the Secret write', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const malformed of [{}, { resource: null }, { ...operation('verified'), status: 'unexpected' }]) {
      const calls = []; const current = connection();
      globalThis.fetch = async (path, init) => {
        calls.push({ path, init });
        if (path.endsWith('/secrets')) return Response.json(malformed);
        if (path.includes('/secret-operations/')) return Response.json(operation('verified'));
        if (path === '/api/v1/admin/cloudflare/verify') return write(current);
        return providerRead(path, current);
      };
      const app = renderer.createApp(Control); const host = node('root');
      try {
        app.mount(host); await until(() => mounted(host));
        tokenInput(host).props['onUpdate:modelValue']('malformed-save-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
        assert.match(text(host), /save result is unknown/); assert.equal(tokenInput(host).props.disabled, true);
        const key = calls.find(call => call.path.endsWith('/secrets')).init.headers.get('idempotency-key');
        await button(host, 'Check save result').props.onClick(); await nextTick();
        assert.equal(calls.find(call => call.path.includes('/secret-operations/')).path, `/api/v1/admin/cloudflare/secret-operations/${key}`);
        assert.equal(tokenInput(host).props.disabled, false); assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
        assert.doesNotMatch(text(host), /malformed-save-secret/);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('malformed lookup or verification records cannot turn an unknown save into a failed or completed save', async () => {
  const originalFetch = globalThis.fetch; const current = connection(); let lookupValid = false; let checkValid = false; const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) throw new Error('lost response');
    if (path.includes('/secret-operations/')) return Response.json(lookupValid ? operation('unknown') : { ...operation('verified'), status: 'unexpected' });
    if (path.includes('/operations/') && path.endsWith('/verify')) return checkValid ? write(operation('verified')) : write({ ...operation('verified'), operation_id: '55555555-5555-4555-8555-555555555555' });
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('lookup-save-secret'); await nextTick(); await submit(tokenForm(host));
    await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(tokenInput(host).props.disabled, true); assert.match(text(host), /save result is unknown/);
    lookupValid = true; await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(tokenInput(host).props.disabled, true); assert.doesNotMatch(text(host), /Token save failed/);
    checkValid = true; await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(tokenInput(host).props.disabled, false); assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a newer unknown change from another device keeps the instance locked after this Token save completes', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  const ownSave = operation('verified'); const otherSave = { ...operation('unknown'), operation_id: '66666666-6666-4666-8666-666666666666' };
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) { current.latest_operation = otherSave; return write(ownSave); }
    if (path === '/api/v1/admin/cloudflare/verify') { assert.fail('core checks must wait for the newer unresolved change'); }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('verified-own-save-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
    assert.equal(tokenInput(host).props.disabled, true); assert.match(text(host), /Save awaiting confirmation/);
    assert.match(text(section(host, 'connection-operation-heading')), /66666666-6666-4666-8666-666666666666/);
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith('/verify')).length, 0);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

const sessionFixture = (id = 'session-one', principal = 'principal-one') => ({ session_id: id, principal: { id: principal, is_owner: true, display_name: 'Owner fixture', version: 1 } });
test('non-secret recovery keys survive component navigation only within the same instance and session partition', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); const session = sessionFixture('recovery-session');
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) throw new Error('response lost before component navigation');
    if (path.includes('/secret-operations/')) return Response.json(operation('verified'));
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  let app = renderer.createApp(Control, { session }); let host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('navigation-save-secret'); await nextTick(); await submit(tokenForm(host));
    const key = calls.find(call => call.path.endsWith('/secrets')).init.headers.get('idempotency-key'); app.unmount();
    app = renderer.createApp(Control, { session: sessionFixture('another-session', 'another-principal') }); host = node('root'); app.mount(host); await until(() => mounted(host));
    assert.equal(tokenInput(host).props.disabled, false); assert.equal(button(host, 'Check save result'), undefined); app.unmount();
    app = renderer.createApp(Control, { session }); host = node('root'); app.mount(host); await until(() => mounted(host));
    assert.equal(tokenInput(host).props.disabled, true); assert.equal(tokenInput(host).props.value, '');
    await button(host, 'Check save result').props.onClick(); await nextTick();
    assert.equal(calls.find(call => call.path.includes('/secret-operations/')).path, `/api/v1/admin/cloudflare/secret-operations/${key}`);
    assert.equal(tokenInput(host).props.disabled, false); assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a late failure from an old session cannot invalidate or overwrite the newly selected Owner session', async () => {
  const originalFetch = globalThis.fetch; const originalDispatch = window.dispatchEvent; const events = []; let finishSave;
  const current = connection(); const session = ref(sessionFixture('old-session', 'old-principal'));
  window.dispatchEvent = event => { events.push(event.type); return true; };
  globalThis.fetch = async path => {
    if (path.endsWith('/secrets')) return new Promise(resolve => { finishSave = () => resolve(problem(401, { category: 'authentication', code: 'UNAUTHENTICATED' })); });
    return providerRead(path, current);
  };
  const app = renderer.createApp({ render: () => h(Control, { session: session.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('old-session-secret'); await nextTick(); const pending = submit(tokenForm(host)); await until(() => finishSave);
    session.value = sessionFixture('new-session', 'new-principal'); await nextTick(); await until(() => mounted(host) && !tokenInput(host).props.disabled);
    finishSave(); await pending; await nextTick();
    assert.equal(events.some(type => ['cfkanban:session-invalid', 'cfkanban:authorization-stale'].includes(type)), false); assert.equal(tokenInput(host).props.disabled, false);
    assert.doesNotMatch(text(host), /Token was not saved|save result is unknown|old-session-secret/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; window.dispatchEvent = originalDispatch; }
});

test('changing a closed Zone view discards its cached WAF result and any earlier in-flight result', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const deferred of [false, true]) {
      const current = connection(); current.capabilities.waf = 'unverified'; let finishOldRead; let wafReads = 0;
      globalThis.fetch = async path => {
        if (path.endsWith('/waf')) {
          wafReads++;
          const old = { status: 'verified', zone_id: 'zone-fixture', hostname: 'kanban.example.com', owned_rule: null, other_rule_count: 0, protected: true };
          return deferred ? new Promise(resolve => { finishOldRead = () => resolve(Response.json(old)); }) : Response.json(old);
        }
        if (path.endsWith('/settings')) { current.target.zone_id = 'new-zone'; current.capabilities.waf = 'unverified'; return write(current); }
        return providerRead(path, current);
      };
      const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Current limit: 300'));
        const waf = section(host, 'connection-waf-heading'); waf.props.onToggle({ target: { open: true } });
        await until(() => deferred ? finishOldRead : text(waf).includes('blocking rule is verified active'));
        waf.props.onToggle({ target: { open: false } }); await nextTick();
        const form = all(waf).find(item => item.tag === 'form'); all(form).find(item => item.tag === 'input').props['onUpdate:modelValue']('new-zone'); await nextTick(); await submit(form);
        if (finishOldRead) finishOldRead(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 5));
        assert.match(text(waf), /Not checked/); assert.doesNotMatch(text(waf), /blocking rule is verified active/);
        assert.equal(wafReads, 1, 'saving a closed Zone view does not fetch its optional provider data');
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('failure to check other functions keeps independently checked Worker settings usable', async () => {
  const originalFetch = globalThis.fetch; const current = connection();
  globalThis.fetch = async (path, init) => {
    if (path === '/api/v1/admin/cloudflare/verify' && JSON.parse(init.body).include_optional) throw new Error('optional check unavailable');
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host)); await button(host, 'Check other functions').props.onClick(); await nextTick();
    assert.equal(row(host, 'Save, deploy and modify the Worker').props['data-state'], 'verified');
    assert.equal(row(host, 'Read billing').props['data-state'], 'neutral'); assert.equal(row(host, 'Read notifications').props['data-state'], 'neutral');
    assert.equal(tokenInput(host).props.disabled, false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

const limitPlan = (target, after, version = 7) => ({ plan_id: '77777777-7777-4777-8777-777777777777', kind: 'rate_limit', version, baseline_version_id: 'v1', baseline_deployment_id: 'd1', target, before: { scope: after.scope, limit: 300, period_seconds: 60 }, after, created_at: '2026-10-07T00:00:00Z' });
test('limits validate input, show the current and new values, and require explicit confirmation before saving', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/rate-limits/plan')) return write(limitPlan(current.target, { scope: 'instance', limit: 123, period_seconds: 10 }));
    if (path.endsWith('/rate-limits/apply')) { current.latest_operation = { ...operation('pending'), kind: 'rate_limit' }; current.version = 8; return write(current.latest_operation); }
    if (path.includes('/operations/') && path.endsWith('/verify')) { current.latest_operation.status = 'verified'; return write(current.latest_operation); }
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const rate = section(host, 'connection-rate-heading'); const form = all(rate).find(item => item.tag === 'form');
    const input = all(form).find(item => item.tag === 'input'); const selects = all(form).filter(item => item.tag === 'select');
    assert.equal(selects[0].children.length, 5); assert.equal(button(rate, 'Change limit').props.disabled, false);
    for (const invalid of ['', '0', '-1', '1.5']) { input.props['onUpdate:modelValue'](invalid); await nextTick(); await submit(form); }
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/plan')).length, 0);
    input.props['onUpdate:modelValue']('123'); selects[1].props['onUpdate:modelValue']('10'); await nextTick(); await submit(form); await nextTick();
    const preview = calls.find(call => call.path.endsWith('/rate-limits/plan'));
    assert.deepEqual(JSON.parse(preview.init.body), { scope: 'instance', limit: 123, period_seconds: 10, expected_version: 4 });
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 0);
    const plan = section(host, 'connection-plan-heading'); assert.match(text(plan), /BeforeAfter.*300 \/ 60 seconds.*123 \/ 10 seconds/);
    assert.match(text(plan), /Confirming saves the access limit for this instance/);
    await button(plan, 'Confirm save').props.onClick(); await nextTick();
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/rate-limits/apply')).init.body), { plan_id: '77777777-7777-4777-8777-777777777777', expected_version: 7 });
    assert.equal(section(host, 'connection-plan-heading'), undefined);
    assert.equal(all(rate).some(item => item.tag === 'form'), false); assert.match(text(rate), /last save is not confirmed yet/);
    await button(host, 'Check current status').props.onClick(); await nextTick();
    assert.equal(button(rate, 'Change limit').props.disabled, false);
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('lost limit-save responses refresh the latest instance lock without replaying or verifying an older completed change', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  current.latest_operation = { ...operation('verified'), operation_id: '88888888-8888-4888-8888-888888888888' };
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/rate-limits/plan')) return write(limitPlan(current.target, { scope: 'instance', limit: 73, period_seconds: 60 }));
    if (path.endsWith('/rate-limits/apply')) { current.latest_operation = { ...operation('unknown'), operation_id: '99999999-9999-4999-8999-999999999999', kind: 'rate_limit' }; current.version = 8; throw new Error('limit response lost'); }
    if (path.includes('/operations/99999999-9999-4999-8999-999999999999/verify')) { current.latest_operation.status = 'verified'; return write(current.latest_operation); }
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const form = all(section(host, 'connection-rate-heading')).find(item => item.tag === 'form');
    all(form).find(item => item.tag === 'input').props['onUpdate:modelValue']('73'); await nextTick(); await submit(form);
    await button(host, 'Confirm save').props.onClick(); await nextTick();
    const beforeCheck = calls.length; await button(host, 'Check current status').props.onClick(); await nextTick();
    assert.equal(calls[beforeCheck].path, '/api/v1/admin/cloudflare'); assert.equal(calls[beforeCheck].init.method, 'GET');
    assert.equal(calls.some(call => call.path.includes('/operations/88888888-8888-4888-8888-888888888888/')), false);
    assert.equal(calls.filter(call => call.path.includes('/operations/99999999-9999-4999-8999-999999999999/verify')).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
    assert.equal(button(section(host, 'connection-rate-heading'), 'Change limit').props.disabled, false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a pending plan is discarded when values or the active page change before its response arrives', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const changePage of [false, true]) {
      let finishPlan; const mode = ref('usage');
      globalThis.fetch = async path => {
        if (path.endsWith('/rate-limits/plan')) return new Promise(resolve => { finishPlan = () => resolve(write(limitPlan(connection().target, { scope: 'instance', limit: 123, period_seconds: 60 }))); });
        return providerRead(path, connection());
      };
      const app = renderer.createApp({ render: () => h(Control, { mode: mode.value }) }); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Current limit: 300'));
        const form = all(section(host, 'connection-rate-heading')).find(item => item.tag === 'form'); const input = all(form).find(item => item.tag === 'input');
        input.props['onUpdate:modelValue']('123'); await nextTick(); const pending = submit(form); await until(() => finishPlan);
        assert.equal(input.props.disabled, true);
        if (changePage) mode.value = 'overview'; else input.props['onUpdate:modelValue']('456'); await nextTick();
        finishPlan(); await pending; await nextTick(); assert.equal(section(host, 'connection-plan-heading'), undefined);
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('usage settings keep server values, updated CAS versions and explicit plan confirmation', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); let version = 4;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/configuration/plan')) {
      const body = JSON.parse(init.body); assert.equal(body.expected_version, version); version++;
      return write({ ...limitPlan(current.target, body.settings, version), kind: 'configuration', before: { history_enabled: false }, after: body.settings });
    }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const editor = section(host, 'usage-setting-heading'); const form = all(editor).find(item => item.tag === 'form'); const selects = all(form).filter(item => item.tag === 'select');
    assert.equal(selects[1].props.value, 'false'); selects[1].props['onUpdate:modelValue']('true'); await nextTick(); await submit(form);
    assert.match(text(section(host, 'connection-plan-heading')), /Disabled.*Enabled/); assert.ok(button(host, 'Confirm save'));
    selects[1].props['onUpdate:modelValue']('false'); await nextTick(); assert.equal(section(host, 'connection-plan-heading'), undefined); await submit(form);
    selects[0].props['onUpdate:modelValue']('warning_percent'); await nextTick();
    all(form).find(item => item.tag === 'input').props['onUpdate:modelValue']('73'); await nextTick(); await submit(form);
    assert.deepEqual(JSON.parse(calls.filter(call => call.path.endsWith('/configuration/plan')).at(-1).init.body), { settings: { warning_percent: 73 }, expected_version: 6 });
    const rate = section(host, 'connection-rate-heading'); const scope = all(rate).find(item => item.tag === 'select'); scope.props['onUpdate:modelValue']('anonymous_login'); await nextTick();
    assert.equal(all(rate).find(item => item.tag === 'input').props.value, '11'); assert.match(text(rate), /Current limit: 11 \/ 10 seconds/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('repeated shortcuts to a usage setting restore the requested selection after a local change', async () => {
  const originalFetch = globalThis.fetch; const settingRequest = ref(0); globalThis.fetch = async path => providerRead(path, connection());
  const app = renderer.createApp({ render: () => h(Control, { mode: 'usage', initialSetting: 'billing_plan', settingRequest: settingRequest.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current value: Free'));
    const editor = section(host, 'usage-setting-heading'); const selection = all(editor).find(item => item.tag === 'select');
    selection.props['onUpdate:modelValue']('warning_percent'); await nextTick(); assert.equal(selection.props.value, 'warning_percent');
    settingRequest.value++; await nextTick(); await nextTick(); assert.equal(selection.props.value, 'billing_plan');
    assert.equal(all(editor).filter(item => item.tag === 'select')[1].props.value, 'free');
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('refreshing the same session facts preserves the unsent Token and connection form state', async () => {
  const originalFetch = globalThis.fetch; const session = ref(sessionFixture('renewed-session')); const calls = [];
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return providerRead(path, connection()); };
  const app = renderer.createApp({ render: () => h(Control, { session: session.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('unsent-local-secret'); await nextTick(); const reads = calls.length;
    session.value = { ...session.value, principal: { ...session.value.principal, version: 2 } }; await nextTick();
    assert.equal(tokenInput(host).props.value, 'unsent-local-secret'); assert.equal(calls.length, reads);
    assert.doesNotMatch(text(host), /unsent-local-secret/); assert.ok(storageWrites.every(entry => !entry.value.includes('unsent-local-secret')));
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('the session-exchanged event blocks old request failures before the new session facts arrive', async () => {
  const originalFetch = globalThis.fetch; const originalDispatch = window.dispatchEvent; const events = []; let finishSave;
  const session = ref(sessionFixture('before-exchange')); const current = connection();
  window.dispatchEvent = event => { events.push(event.type); return originalDispatch(event); };
  globalThis.fetch = async path => {
    if (path.endsWith('/secrets')) return new Promise(resolve => { finishSave = () => resolve(problem(401, { category: 'authentication', code: 'UNAUTHENTICATED' })); });
    return providerRead(path, current);
  };
  const app = renderer.createApp({ render: () => h(Control, { session: session.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => mounted(host));
    tokenInput(host).props['onUpdate:modelValue']('exchange-window-secret'); await nextTick(); const pending = submit(tokenForm(host)); await until(() => finishSave);
    window.dispatchEvent({ type: 'cfkanban:session-exchanged' }); await nextTick();
    finishSave(); await pending; await nextTick();
    assert.equal(events.includes('cfkanban:session-invalid'), false);
    session.value = sessionFixture('after-exchange'); await nextTick(); await until(() => mounted(host));
    assert.equal(tokenInput(host).props.disabled, false); assert.equal(tokenInput(host).props.value, '');
    assert.doesNotMatch(text(host), /save result is unknown|Token was not saved|exchange-window-secret/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; window.dispatchEvent = originalDispatch; }
});

test('new Token and explicit optional checks discard older notification projections before showing their results', async () => {
  const originalFetch = globalThis.fetch; const current = connection(); const mode = ref('usage');
  globalThis.fetch = async (path, init) => {
    if (path.endsWith('/notifications')) return Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'old', name: 'Old verified policy', alert_type: 'fixture', enabled: true, emails: [] }] });
    if (path.endsWith('/secrets')) { current.latest_operation = operation('verified'); current.capabilities.notifications = 'unverified'; return write(current.latest_operation); }
    if (path === '/api/v1/admin/cloudflare/verify') {
      current.capabilities.configuration = 'verified';
      if (JSON.parse(init.body).include_optional) current.capabilities.notifications = 'permission_denied';
      return write(current);
    }
    return providerRead(path, current);
  };
  const app = renderer.createApp({ render: () => h(Control, { mode: mode.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    section(host, 'connection-notifications-heading').props.onToggle({ target: { open: true } }); await until(() => text(host).includes('Old verified policy'));
    mode.value = 'overview'; await nextTick(); assert.equal(row(host, 'Read notifications').props['data-state'], 'verified');
    await button(host, 'Check other functions').props.onClick(); await nextTick();
    assert.equal(row(host, 'Read notifications').props['data-state'], 'denied', 'old local projections cannot override a new optional check');
    mode.value = 'usage'; await nextTick();
    section(host, 'connection-notifications-heading').props.onToggle({ target: { open: true } }); await until(() => text(host).includes('Old verified policy'));
    mode.value = 'overview'; await nextTick(); assert.equal(row(host, 'Read notifications').props['data-state'], 'verified');
    tokenInput(host).props['onUpdate:modelValue']('replacement-token-secret'); await nextTick(); await submit(tokenForm(host)); await nextTick();
    assert.equal(row(host, 'Read notifications').props['data-state'], 'neutral', 'a replacement Token must not inherit a previous Token’s notification check');
    assert.doesNotMatch(text(host), /Old verified policy|replacement-token-secret/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a superseded provider read cannot replace newer notification or WAF state', async () => {
  const originalFetch = globalThis.fetch; const current = connection(); let finishOldRead; let notificationReads = 0;
  globalThis.fetch = async path => {
    if (path.endsWith('/notifications')) {
      notificationReads++;
      if (notificationReads === 1) return new Promise(resolve => { finishOldRead = () => resolve(Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'old', name: 'Old policy', enabled: true, alert_type: 'old', emails: [] }] })); });
      return Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'new', name: 'New policy', enabled: true, alert_type: 'new', emails: [] }] });
    }
    if (path.endsWith('/waf')) return Response.json({ status: 'verified', zone_id: 'zone-fixture', hostname: 'kanban.example.com', owned_rule: null, other_rule_count: 0, protected: notificationReads > 1 });
    if (path.endsWith('/verify')) return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    section(host, 'connection-notifications-heading').props.onToggle({ target: { open: true } }); await until(() => finishOldRead);
    section(host, 'connection-waf-heading').props.onToggle({ target: { open: true } });
    await button(host, 'Check current status').props.onClick(); await until(() => text(host).includes('New policy'));
    finishOldRead(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(text(host), /New policy/); assert.doesNotMatch(text(host), /Old policy/);
    assert.match(text(section(host, 'connection-waf-heading')), /blocking rule is verified active/);
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

test('disabled history does no collection and directs its setting to the shared Usage editor', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const settings = [];
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return Response.json(historyFixture(false)); };
  const app = renderer.createApp(History, { onSettings: field => settings.push(field) }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('History collection disabled'));
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls.length, 1);
    const link = all(host).find(item => item.tag === 'a' && text(item) === 'Change history setting');
    assert.equal(link.props.href, '#connection-configuration-heading'); link.props.onClick(); await nextTick();
    assert.deepEqual(settings, ['history_enabled']);
    assert.equal(all(host).some(item => item.tag === 'button' && text(item).includes('Preview')), false);
    assert.equal(calls.filter(call => call.init.method === 'POST').length, 0);
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
