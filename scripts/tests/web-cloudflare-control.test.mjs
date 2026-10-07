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
const section = (host, heading) => all(host).find(item => ['section', 'details'].includes(item.tag) && item.props['aria-labelledby'] === heading);
const write = resource => Response.json({ resource, event_cursor: 'fixture', idempotent_replay: false });
const operation = status => ({ operation_id: 'operation-fixture', kind: 'secret', status, version: 5, baseline_version_id: 'v1', result_version_id: status === 'verified' ? 'v2' : null, deployment_id: null, failure_class: null, created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' });
const connection = () => ({ version: 4, target: { account_id: 'account-fixture', worker_name: 'worker-fixture', database_id: 'db-fixture', zone_id: 'zone-fixture', hostname: 'kanban.example.com' }, configured: { connection: true, configuration: true, control: false, analytics: false }, capabilities: { configuration: 'verified', notifications: 'unverified', waf: 'permission_denied', billing: 'unsupported_contract', analytics: 'missing' }, verified_at: null, budget: { status: 'unsupported_contract', dashboard_url: 'https://dash.cloudflare.com/', docs_url: 'https://developers.cloudflare.com/billing/manage/budget-alerts/' }, latest_operation: null, configuration: { history_enabled: false, analytics_enabled: true, billing_plan: 'free', billing_cycle_day: 10, account_totals: false, warning_percent: 75 } });
const rateFixture = () => ({ configuration_source: 'worker_configuration', editable_via_api: false, policies: { instance: { limit: 300, period_seconds: 60 }, principal: { limit: 120, period_seconds: 60 }, unauthenticated_sensitive: { limit: 30, period_seconds: 60 } }, cost_protection: { anonymous_login: { enabled: true, policy: { limit: 11, period_seconds: 10 } }, expensive_reads: { enabled: true, policy: { limit: 10, period_seconds: 60 } }, concurrency: { enabled: true, per_principal: 2, per_isolate: 32 } } });
function providerRead(path, current) {
  if (path.endsWith('/rate-limit-settings')) return Response.json(rateFixture());
  if (path.endsWith('/notifications')) return Response.json({ status: 'verified', available_alerts: [], policies: [{ id: 'policy-fixture', name: 'Policy fixture', alert_type: 'billing_usage_alert', enabled: true, emails: ['fixture@example.invalid'], filters: { limit: 80 } }] });
  if (path.endsWith('/waf')) return Response.json({ status: 'permission_denied', zone_id: 'zone-fixture', hostname: 'kanban.example.com', owned_rule: null, other_rule_count: null, protected: false });
  return Response.json(current);
}

test('Overview keeps one connection Token, separate capabilities and five API scopes without optional provider reads', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); current.configured.connection = false;
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return providerRead(path, current); };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    assert.match(text(host), /Using existing authorization/);
    assert.match(text(host), /Change settingsVerified.*View usageNot configured/);
    assert.equal(all(host).filter(item => item.tag === 'input' && item.props.type === 'password').length, 1);
    const tokens = section(host, 'connection-tokens-heading');
    assert.match(text(tokens), /Manage Account → Account API Tokens → Create Token.*one account-owned Token/);
    const required = section(tokens, 'token-required-permissions-heading');
    const optional = section(tokens, 'token-optional-permissions-heading');
    assert.equal(all(required).filter(item => item.tag === 'li').length, 2);
    assert.equal(all(optional).filter(item => item.tag === 'li').length, 4);
    assert.match(text(required), /Required permissions.*Specified Workers → select this existing Worker: worker-fixture.*Developer Platform → Individual Workers → Editor.*code, deployment, Secret, and configuration modification authority/);
    assert.match(text(required), /Do not select account-wide Workers Editor or Admin.*Target account only: account-fixture.*Analytics & Logs → Account Analytics → Read.*Workers, D1, and R2 usage.*D1 SQL and R2 object editing permissions are not required/);
    assert.match(text(optional), /Optional read permissions.*Target account only: account-fixture.*Account & Billing → Billing → Read.*Account & Billing → Notifications → Read.*Account-owned Token compatibility/);
    assert.match(text(optional), /Specified Zone for this domain only: kanban.example.com · zone-fixture.*DNS & Zones → Zone → Read.*not Account WAF.*App Security → Zone WAF Rules → Read/);
    assert.match(text(optional), /No optional Edit permissions are required.*affect only the corresponding capability/);
    assert.match(text(tokens), /creator needs account Super Administrator or API Token Provisioning authority.*Do not add API Tokens Write/);
    assert.match(text(tokens), /account-fixture.*worker-fixture.*db-fixture/);
    assert.ok(all(tokens).some(item => item.tag === 'a' && item.props.href === 'https://dash.cloudflare.com/?to=/:account/api-tokens'));
    assert.equal(section(host, 'connection-configuration-heading'), undefined);
    assert.equal(section(host, 'connection-budget-heading'), undefined);
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.init.method === 'GET'));
    assert.equal(all(section(host, 'connection-rate-heading')).find(item => item.tag === 'select').children.length, 5);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /正在使用现有授权.*修改设置核验通过.*查看用量未配置/);
    assert.match(text(required), /必需权限.*Specified Workers（指定的 Workers）.*当前已存在的 Worker： worker-fixture.*Developer Platform（开发者平台）→ Individual Workers → Editor/);
    assert.match(text(required), /仅目标账户： account-fixture.*Analytics & Logs（分析和日志）→ Account Analytics（账户分析）→ Read/);
    assert.match(text(optional), /可选读取权限.*Account & Billing（账户与账务）→ Billing → Read.*Account & Billing（账户与账务）→ Notifications → Read/);
    assert.match(text(optional), /DNS & Zones（DNS 和区域）→ Zone → Read.*App Security（应用安全）→ Zone WAF Rules → Read.*可选能力无需 Edit 权限/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('legacy analytics-only authorization opens the connection form and directs missing settings access to Token creation', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  current.configured = { configuration: false, control: false, analytics: true };
  current.capabilities.configuration = 'missing'; current.capabilities.analytics = 'verified';
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return providerRead(path, current); };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const management = all(host).find(item => item.tag === 'details' && item.props.class === 'connection-management');
    assert.equal(management.props.open, true);
    assert.match(text(host), /Usage is available; settings cannot be changed yet/);
    assert.match(text(host), /To change settings, create a Token with settings permissions and enter it below/);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-connection').props.disabled, false);
    assert.equal(all(section(host, 'connection-rate-heading')).find(item => item.tag === 'button').props.disabled, true);
    assert.equal(all(host).some(item => item.tag === 'button' && text(item) === 'Verify current state'), false);
    management.props.onToggle({ target: { open: false } }); await nextTick(); assert.equal(management.props.open, false);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Connect Cloudflare').props.onClick(); await nextTick();
    assert.equal(management.props.open, true); assert.ok(calls.every(call => call.init.method === 'GET'));
    const mainText = item => item.tag === 'details' && item.props.class === 'connection-guide' ? '' : item.text + item.children.map(mainText).join('');
    assert.doesNotMatch(mainText(host), /Worker Secret|binding/);
    assert.match(mainText(host), /Maximum requests.*Duration/);
    locale.value = 'zh-CN'; await nextTick();
    assert.match(text(host), /统计可用，尚不能修改设置.*修改设置未配置.*查看用量核验通过/);
    assert.match(text(host), /请先创建具有设置修改权限的 Token，并在下方输入/);
    assert.match(mainText(host), /访问频率限制.*最多请求数.*统计时长/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('unverified and denied connections offer verification or Token replacement as their distinct next steps', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const capability of ['unverified', 'permission_denied']) {
      const current = connection(); current.capabilities.configuration = capability; const calls = [];
      globalThis.fetch = async (path, init) => {
        calls.push({ path, init });
        if (path === '/api/v1/admin/cloudflare/verify') { current.capabilities.configuration = 'verified'; return write(current); }
        return providerRead(path, current);
      };
      const app = renderer.createApp(Control); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Current limit: 300'));
        const management = all(host).find(item => item.tag === 'details' && item.props.class === 'connection-management');
        assert.equal(management.props.open, capability === 'permission_denied');
        if (capability === 'unverified') {
          assert.match(text(host), /Connection awaiting verification.*The connection is saved. Verify it before changing settings/);
          await all(host).find(item => item.tag === 'button' && text(item) === 'Verify connection').props.onClick(); await nextTick();
          assert.equal(calls.filter(call => call.path.endsWith('/verify')).length, 1);
          assert.equal(all(section(host, 'connection-rate-heading')).find(item => item.tag === 'button').props.disabled, false);
        } else {
          assert.match(text(host), /Connection permission denied.*Check the permissions in the creation guide or enter a replacement Token below/);
          const action = all(host).find(item => item.tag === 'button' && text(item) === 'Check or replace Token'); assert.ok(action);
          management.props.onToggle({ target: { open: false } }); await nextTick(); await action.props.onClick(); await nextTick();
          assert.equal(management.props.open, true); assert.ok(calls.every(call => call.init.method === 'GET'));
          assert.equal(all(host).some(item => item.tag === 'button' && text(item) === 'Verify connection'), false);
        }
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('failed initial connection read keeps verification available instead of offering an unavailable Token form', async () => {
  const originalFetch = globalThis.fetch; let failRead = true; const current = connection();
  globalThis.fetch = async path => {
    if (path === '/api/v1/admin/cloudflare' && failRead) throw new Error('Fixture read unavailable');
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('The request could not be confirmed'));
    const retry = all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state'); assert.ok(retry);
    assert.equal(all(host).some(item => item.props.id === 'cloudflare-token-connection'), false);
    failRead = false; await retry.props.onClick(); await until(() => text(host).includes('Current limit: 300'));
    assert.equal(all(section(host, 'connection-rate-heading')).find(item => item.tag === 'button').props.disabled, false);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('Usage settings read optional policies and WAF only after expansion and keep unsupported USD budgets read-only', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); current.configuration.billing_plan = null;
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return providerRead(path, current); };
  const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current value: Disabled'));
    assert.equal(calls.length, 1);
    assert.equal(all(host).filter(item => item.tag === 'input' && item.props.type === 'password').length, 0);
    assert.equal(section(host, 'connection-rate-heading'), undefined);
    const notifications = section(host, 'connection-notifications-heading');
    notifications.props.onToggle({ target: { open: true } }); await until(() => text(host).includes('Policy fixture'));
    assert.match(text(notifications), /Policy fixture.*Enabled.*billing_usage_alert.*fixture@example.invalid/);
    assert.doesNotMatch(text(notifications), /80|\$80/);
    const waf = section(host, 'connection-waf-heading'); waf.props.onToggle({ target: { open: true } });
    await until(() => calls.some(call => call.path.endsWith('/waf')) && !text(waf).includes('Reading…'));
    assert.match(text(waf), /permission denied.*No active tool-owned blocking rule is confirmed/);
    const budget = section(host, 'connection-budget-heading');
    assert.match(text(budget), /Public API contract unconfirmed.*selected email recipients.*separate from cfKanban.*do not stop usage or cap charges/);
    assert.equal(all(budget).some(item => ['button', 'input', 'textarea', 'select'].includes(item.tag)), false);
    const configurationForm = all(host).find(item => item.tag === 'section' && item.props['aria-labelledby'] === 'usage-setting-heading');
    assert.ok(all(host).filter(item => item.tag === 'option').every(item => item.props.value !== ''));
    all(configurationForm).find(item => item.tag === 'select').props['onUpdate:modelValue']('billing_plan'); await nextTick();
    assert.equal(all(configurationForm).filter(item => item.tag === 'select')[1].props.value, 'unknown');
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(budget), /公开 API 合同尚未确认 USD 阈值/);
  } finally { app.unmount(); globalThis.fetch = originalFetch; locale.value = 'en'; }
});

test('Usage hides verified capability rows and folds completed changes while unresolved changes remain prominent', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ['verified', 'unverified', 'permission_denied', 'pending', 'unknown']) {
      const current = connection(); current.capabilities.analytics = ['unverified', 'permission_denied'].includes(state) ? state : 'verified';
      current.latest_operation = operation(['pending', 'unknown'].includes(state) ? state : 'verified');
      globalThis.fetch = async path => providerRead(path, current);
      const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
      try {
        app.mount(host); await until(() => text(host).includes('Current value: Disabled'));
        const capabilityRows = all(host).find(item => item.props.class === 'connection-capabilities');
        if (['unverified', 'permission_denied'].includes(state)) {
          assert.ok(capabilityRows); assert.doesNotMatch(text(capabilityRows), /Change settings/);
          assert.match(text(capabilityRows), state === 'unverified' ? /View usageNot verified/ : /View usageCloudflare permission denied/);
          assert.match(text(host), state === 'unverified' ? /Verify the connection before reading usage/ : /Review or replace the connection Token in Overview/);
        } else assert.equal(capabilityRows, undefined);
        const change = section(host, 'connection-operation-heading');
        if (['pending', 'unknown'].includes(state)) {
          assert.equal(change.tag, 'section'); assert.match(text(change), /not confirmed active/);
          assert.equal(all(section(host, 'usage-setting-heading')).find(item => item.tag === 'button').props.disabled, true);
        } else { assert.equal(change.tag, 'details'); assert.notEqual(change.props.open, true); }
      } finally { app.unmount(); }
    }
  } finally { globalThis.fetch = originalFetch; }
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
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const forms = all(host).filter(item => item.tag === 'form' && item.props.class === 'cloudflare-token-form');
    const form = forms[0]; const input = all(form).find(item => item.tag === 'input');
    input.props['onUpdate:modelValue']('fixture-secret-must-not-render'); await nextTick();
    const pending = submit(form); await until(() => finish);
    assert.equal(input.props.value, '');
    const request = calls.find(call => call.path.endsWith('/secrets'));
    assert.deepEqual(JSON.parse(request.init.body), { kind: 'connection', token: 'fixture-secret-must-not-render', expected_version: 4 });
    assert.match(request.init.headers.get('idempotency-key'), /^[0-9a-f-]{36}$/);
    assert.equal(request.init.headers.get('x-csrf-token'), 'fixture-csrf');
    assert.equal(request.init.credentials, 'same-origin');
    finish(); await pending; await until(() => text(host).includes('Token input has been cleared'));
    assert.doesNotMatch(text(host), /fixture-secret-must-not-render/);
    assert.ok(storageWrites.every(entry => !entry.value.includes('fixture-secret-must-not-render')));
    assert.equal(input.props.value, ''); assert.equal(input.props.disabled, true);
    await all(form).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick();
    await until(() => calls.filter(call => call.path.endsWith('/verify')).length === 1 && !all(host).find(item => item.props.id === 'cloudflare-token-connection')?.props.disabled);
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-connection').props.value, '');
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('one verified connection save checks capabilities automatically and unlocks settings without optional policy reads', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection();
  current.configured.connection = false; current.configured.configuration = false; current.capabilities.configuration = 'missing';
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) { current.configured.connection = true; current.latest_operation = operation('verified'); current.capabilities.configuration = 'unverified'; return write(current.latest_operation); }
    if (path === '/api/v1/admin/cloudflare/verify') { current.capabilities.configuration = current.capabilities.analytics = 'verified'; return write(current); }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const rate = section(host, 'connection-rate-heading'); assert.equal(all(rate).find(item => item.tag === 'button').props.disabled, true);
    const form = all(host).find(item => item.tag === 'form' && item.props.class === 'cloudflare-token-form');
    all(form).find(item => item.tag === 'input').props['onUpdate:modelValue']('fixture-connection-token'); await nextTick(); await submit(form);
    await until(() => all(rate).find(item => item.tag === 'button').props.disabled === false);
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(JSON.parse(calls.find(call => call.path.endsWith('/secrets')).init.body).kind, 'connection');
    assert.equal(calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 1);
    assert.equal(calls.some(call => call.path.endsWith('/notifications') || call.path.endsWith('/waf')), false);
    assert.match(text(host), /Connection saved.*Change settingsVerified.*View usageVerified/);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-connection').props.value, '');
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('a pending connection operation retains its write lock across Overview and Usage modes', async () => {
  const originalFetch = globalThis.fetch; const calls = []; const current = connection(); const mode = ref('overview');
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/secrets')) { current.latest_operation = operation('pending'); return write(current.latest_operation); }
    if (path.includes('/operations/') && path.endsWith('/verify')) { current.latest_operation = operation('verified'); return write(current.latest_operation); }
    if (path === '/api/v1/admin/cloudflare/verify') return write(current);
    return providerRead(path, current);
  };
  const app = renderer.createApp({ render: () => h(Control, { mode: mode.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const form = all(host).find(item => item.tag === 'form' && item.props.class === 'cloudflare-token-form');
    all(form).find(item => item.tag === 'input').props['onUpdate:modelValue']('fixture-pending-token'); await nextTick(); await submit(form);
    assert.equal(calls.filter(call => call.path.endsWith('/verify')).length, 0);
    mode.value = 'usage'; await nextTick();
    const editor = section(host, 'usage-setting-heading');
    assert.equal(all(editor).find(item => item.tag === 'button').props.disabled, true);
    assert.match(text(section(host, 'connection-operation-heading')), /Pending; verify the result/);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick(); await nextTick();
    assert.equal(all(editor).find(item => item.tag === 'button').props.disabled, false);
    mode.value = 'overview'; await nextTick();
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-connection').props.value, '');
    assert.equal(calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 1);
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
      current.configured.connection = true;
      return write(current);
    }
    return providerRead(path, current);
  };
  const app = renderer.createApp(Control); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    assert.equal(section(host, 'connection-operation-heading'), undefined);
    const form = all(host).find(item => item.tag === 'form' && all(item).some(input => input.props.id === 'cloudflare-token-connection'));
    all(form).find(item => item.tag === 'input').props['onUpdate:modelValue']('fake-token-for-lost-response'); await nextTick(); await submit(form);
    await until(() => text(host).includes('Token input has been cleared'));
    const beforeReadback = calls.length;
    await all(form).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick();
    await until(() => verifications === 1 && !all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.disabled);
    assert.equal(calls[beforeReadback].path, '/api/v1/admin/cloudflare'); assert.equal(calls[beforeReadback].init.method, 'GET');
    assert.equal(calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 0);
    assert.match(text(section(host, 'connection-operation-heading')), /Pending/);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-connection').props.disabled, true);
    assert.equal(all(host).find(item => item.props.id === 'cloudflare-token-connection').props.value, '');
    await all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick();
    await until(() => verifications === 2 && !all(host).find(item => item.props.id === 'cloudflare-token-connection').props.disabled);
    const restored = all(host).find(item => item.props.id === 'cloudflare-token-connection');
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
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
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
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
    const rate = section(host, 'connection-rate-heading'); const form = all(rate).find(item => item.tag === 'form');
    const limit = all(form).find(item => item.tag === 'input'); const selects = all(form).filter(item => item.tag === 'select');
    assert.equal(selects[0].children.length, 5);
    limit.props['onUpdate:modelValue'](1.5); await nextTick(); await submit(form);
    assert.equal(calls.filter(call => call.path.includes('/plan')).length, 0);
    limit.props['onUpdate:modelValue'](123); selects[1].props['onUpdate:modelValue']('10'); await nextTick(); await submit(form);
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/rate-limits/plan')).init.body), { scope: 'instance', limit: 123, period_seconds: 10, expected_version: 4 });
    assert.equal(calls.filter(call => call.path.endsWith('/apply')).length, 0);
    const comparison = all(section(host, 'connection-plan-heading')).find(item => item.tag === 'table');
    assert.match(text(comparison), /Instance API300 \/ 60 seconds123 \/ 10 seconds/);
    assert.ok(all(section(host, 'connection-plan-heading')).filter(item => item.tag === 'pre').every(item => item.parent.tag === 'details'));
    await all(host).find(item => item.tag === 'button' && text(item) === 'Apply this plan').props.onClick(); await nextTick();
    assert.deepEqual(JSON.parse(calls.find(call => call.path.endsWith('/rate-limits/apply')).init.body), { plan_id: 'plan-fixture', expected_version: 7 });
    assert.match(text(host), /Pending; verify the result.*not confirmed active/);
    assert.equal(all(rate).find(item => item.tag === 'button').props.disabled, true);
    await all(host).find(item => item.tag === 'button' && text(item) === 'Verify current state').props.onClick(); await nextTick();
    assert.match(text(section(host, 'connection-operation-heading')), /Verified/);
    assert.equal(calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
  } finally { app.unmount(); globalThis.fetch = originalFetch; }
});

test('repeated links to the same Usage setting restore that selection after a local form change', async () => {
  const originalFetch = globalThis.fetch; const settingRequest = ref(0);
  globalThis.fetch = async path => providerRead(path, connection());
  const app = renderer.createApp({ render: () => h(Control, { mode: 'usage', initialSetting: 'billing_plan', settingRequest: settingRequest.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current value: Free'));
    const editor = section(host, 'usage-setting-heading'); const selection = all(editor).find(item => item.tag === 'select');
    selection.props['onUpdate:modelValue']('warning_percent'); await nextTick(); assert.equal(selection.props.value, 'warning_percent');
    settingRequest.value++; await nextTick(); await nextTick(); assert.equal(selection.props.value, 'billing_plan');
    assert.equal(all(editor).filter(item => item.tag === 'select')[1].props.value, 'free');
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
  const app = renderer.createApp(Control, { mode: 'usage' }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current value: Disabled'));
    section(host, 'connection-notifications-heading').props.onToggle({ target: { open: true } }); await until(() => finishOldRead);
    section(host, 'connection-waf-heading').props.onToggle({ target: { open: true } });
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
    app.mount(host); await until(() => text(host).includes('Current limit: 300'));
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
  const mode = ref('usage'); const app = renderer.createApp({ render: () => h(Control, { mode: mode.value }) }); const host = node('root');
  try {
    app.mount(host); await until(() => text(host).includes('Current value: Disabled'));
    const configForm = all(all(host).find(item => item.tag === 'section' && item.props['aria-labelledby'] === 'usage-setting-heading')).find(item => item.tag === 'form');
    const configSelects = all(configForm).filter(item => item.tag === 'select');
    assert.equal(configSelects[1].props.value, 'false');
    configSelects[1].props['onUpdate:modelValue']('true'); await nextTick(); await submit(configForm);
    assert.equal(calls.filter(call => call.path.endsWith('/configuration/plan')).length, 1);
    configSelects[1].props['onUpdate:modelValue']('false'); await nextTick(); await submit(configForm);
    assert.equal(calls.filter(call => call.path.endsWith('/configuration/plan')).length, 2);
    configSelects[0].props['onUpdate:modelValue']('warning_percent'); await nextTick();
    all(configForm).find(item => item.tag === 'input').props['onUpdate:modelValue'](73); await nextTick(); await submit(configForm);
    assert.deepEqual(JSON.parse(calls.filter(call => call.path.endsWith('/configuration/plan')).at(-1).init.body), { settings: { warning_percent: 73 }, expected_version: 6 });
    mode.value = 'overview'; await until(() => text(host).includes('Current limit: 300'));
    assert.equal(section(host, 'connection-plan-heading'), undefined);
    const rate = section(host, 'connection-rate-heading'); const rateForm = all(rate).find(item => item.tag === 'form');
    const selects = all(rateForm).filter(item => item.tag === 'select');
    assert.equal(all(rateForm).find(item => item.tag === 'input').props.value, '300');
    selects[0].props['onUpdate:modelValue']('anonymous_login'); await nextTick();
    assert.equal(all(rateForm).find(item => item.tag === 'input').props.value, '11');
    assert.equal(selects[1].props.value, '10');
    assert.match(text(rate), /Current limit: 11 \/ 10 seconds/);
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
