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
  stdin: { contents: `export { default as Control } from './apps/web/src/components/CloudflareControlPanel.vue'; export { historyGeometry } from './apps/web/src/components/UsageHistoryChart.vue'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
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
const { Control, historyGeometry, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
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
const write = resource => Response.json({ resource, event_cursor: 'fixture', idempotent_replay: false });
const operation = status => ({ operation_id: '11111111-1111-4111-8111-111111111111', kind: 'configuration_secret', status, version: 5, baseline_version_id: 'v1', result_version_id: status === 'verified' ? 'v2' : null, deployment_id: null, failure_class: null, created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' });
const connection = () => ({ version: 4, target: { account_id: 'account-fixture', worker_name: 'worker-fixture', database_id: 'db-fixture', zone_id: 'zone-fixture', hostname: 'kanban.example.com' }, configured: { connection: true, configuration: true, control: false, analytics: false }, capabilities: { configuration: 'verified', notifications: 'unverified', waf: 'permission_denied', billing: 'unsupported_contract', analytics: 'missing' }, verified_at: null, budget: { status: 'unsupported_contract', dashboard_url: 'https://dash.cloudflare.com/', docs_url: 'https://developers.cloudflare.com/billing/manage/budget-alerts/' }, latest_operation: null, configuration: { history_enabled: false, analytics_enabled: true, billing_plan: 'free', billing_cycle_day: 10, account_totals: false, warning_percent: 75 } });
const rateFixture = () => ({ configuration_source: 'worker_configuration', editable_via_api: false, policies: { instance: { limit: 300, period_seconds: 60 }, principal: { limit: 120, period_seconds: 60 }, unauthenticated_sensitive: { limit: 30, period_seconds: 60 } }, cost_protection: { anonymous_login: { enabled: true, policy: { limit: 11, period_seconds: 10 } }, expensive_reads: { enabled: true, policy: { limit: 10, period_seconds: 60 } }, concurrency: { enabled: true, per_principal: 2, per_isolate: 32 } } });
const problem = (status, { source = 'service', category = status === 400 ? 'validation' : status === 403 ? 'authorization' : status === 404 ? 'not_found' : 'conflict', code = status === 409 ? 'VERSION_CONFLICT' : status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', details = {} } = {}) => {
  const requestId = crypto.randomUUID();
  return Response.json({ category, code, details, message: 'unsafe provider body must not render', recovery: 'request_owner', request_id: requestId, retryable: false, source }, { status, headers: { 'x-request-id': requestId } });
};
const tokenInput = host => all(host).find(item => item.props.id === 'cloudflare-token-connection');
const tokenForm = host => all(host).find(item => item.tag === 'form' && item.props.class === 'cloudflare-token-form');
const button = (host, label) => all(host).find(item => item.tag === 'button' && text(item) === label);
const capabilityRows = host => all(host).filter(item => item.tag === 'details' && item.props.class === 'capability-item');
const row = (host, label) => capabilityRows(host).find(item => text(item).startsWith(label));
const capabilitySummary = entry => all(entry).find(item => item.tag === 'summary');

const sessionFixture = (id = crypto.randomUUID(), principal = 'principal-one') => ({ session_id: id, principal: { id: principal, is_owner: true, display_name: 'Owner fixture', version: 1 } });
const change = (input, value) => input.props['onUpdate:modelValue'](value);
const dialog = host => all(host).find(item => item.props.role === 'dialog');
function setup(current = connection(), intercept = null) {
  const originalFetch = globalThis.fetch; const calls = []; const rates = rateFixture();
  globalThis.fetch = async (path, init) => {
    const call = { path, method: init.method, body: init.body ? JSON.parse(init.body) : null, key: new Headers(init.headers).get('Idempotency-Key') };
    calls.push(call);
    const result = await intercept?.(call, current, rates);
    if (result !== undefined) return result;
    if (path.endsWith('/rate-limit-settings')) return Response.json(rates);
    if (path.endsWith('/verify')) return write(current);
    if (path === '/api/v1/admin/cloudflare') return Response.json(current);
    throw new Error(`unexpected request: ${path}`);
  };
  return { current, calls, rates, restore() { globalThis.fetch = originalFetch; } };
}
async function mountControl(options = {}, slots = undefined) {
  const host = node('root'); const events = { applied: 0 };
  const app = renderer.createApp({ render: () => h(Control, { mode: 'usage', session: sessionFixture(), onApplied() { events.applied++; }, ...options }, slots) });
  app.mount(host); await until(() => tokenInput(host) && !tokenInput(host).props.disabled);
  return { host, app, events };
}
async function flush() { for (let i = 0; i < 12; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick(); } }

// Token writes remain explicit; permission checks and original-operation readbacks are automatic.
test('usage has one persistent empty Token field, two truthful capabilities and all limits after the data slot', async () => {
  const f = setup(); const v = await mountControl({}, { default: () => h('section', { id: 'usage-slot' }, 'USAGE DATA') });
  try {
    assert.match(text(v.host), /Token saved/); assert.equal(tokenInput(v.host).props.value, '');
    assert.equal(button(v.host, 'Save').props.disabled, true);
    assert.match(text(v.host), /Leave blank to keep the saved Token/);
    assert.equal(capabilityRows(v.host).length, 2);
    assert.match(text(v.host), /Configuration readable/);
    assert.doesNotMatch(text(capabilitySummary(row(v.host, 'Instance settings'))), /Editor|permissions verified/);
    assert.doesNotMatch(text(v.host), /WAF|notification policies|Budget|Check again|Check save|Read history|Overview/);
    assert.equal(all(v.host).filter(item => item.props.class === 'rate-row').length, 5);
    assert.ok(text(v.host).indexOf('Token saved') < text(v.host).indexOf('USAGE DATA'));
    assert.ok(text(v.host).indexOf('USAGE DATA') < text(v.host).indexOf('Request frequency'));
    assert.equal(f.calls.filter(call => call.path.endsWith('/verify')).length, 1);
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/verify')).body, {});
    assert.equal(f.calls.some(call => /waf|notification|billing/.test(call.path)), false);
    locale.value = 'zh-CN'; await nextTick();
    assert.ok(button(v.host, '保存')); assert.match(text(v.host), /Token 已保存.*留空保持已保存的 Token/);
  } finally { locale.value = 'en'; v.app.unmount(); f.restore(); }
});

test('an unconfigured Token gets a concise creation and manual Secret recovery path automatically', async () => {
  const current = connection(); current.configured = { connection: false, configuration: false, control: false, analytics: false }; current.capabilities.configuration = 'missing';
  const f = setup(current); const v = await mountControl();
  try {
    assert.match(text(v.host), /Not configured/); assert.doesNotMatch(text(v.host), /Token saved/);
    assert.match(text(v.host), /Workers & Pages.*Variables and Secrets.*CFKANBAN_API_TOKEN as a Secret.*Deploy/);
    assert.equal(button(v.host, 'Save').props.disabled, true);
    assert.equal(all(v.host).find(item => item.props.class === 'connection-guide').props.open, true);
    assert.equal(f.calls.filter(call => call.path.endsWith('/verify')).length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('saving clears the secret immediately and automatically confirms activation, capabilities and data exactly once', async () => {
  let finishSave;
  const f = setup(connection(), async (call, current) => {
    if (call.path.endsWith('/secrets')) return new Promise(resolve => { finishSave = () => {
      current.latest_operation = { ...operation('unknown'), result_version_id: 'v2', deployment_id: 'deployment', failure_class: 'secret_readback_pending' };
      resolve(write(current.latest_operation));
    }; });
    if (/\/operations\/.*\/verify$/.test(call.path)) { current.latest_operation = operation('verified'); current.version = 5; return write(current.latest_operation); }
  });
  const v = await mountControl(); const before = v.events.applied;
  try {
    change(tokenInput(v.host), 'fixture-secret-do-not-store'); await nextTick(); const save = submit(tokenForm(v.host));
    await until(() => Boolean(finishSave));
    assert.equal(tokenInput(v.host).props.value, ''); assert.equal(tokenInput(v.host).props.disabled, true);
    assert.doesNotMatch(text(v.host), /fixture-secret-do-not-store/);
    finishSave(); await save; await until(() => !tokenInput(v.host).props.disabled && v.events.applied === before + 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path)).length, 1);
    assert.equal(f.calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 2);
    assert.equal(storageWrites.some(value => JSON.stringify(value).includes('fixture-secret-do-not-store')), false);
    assert.match(text(v.host), /Token saved/);
  } finally { v.app.unmount(); f.restore(); }
});

test('an uncertain save looks up only its original key and does not resend the Token or use another device’s operation', async () => {
  let originalKey; const other = { ...operation('pending'), operation_id: '22222222-2222-4222-8222-222222222222' };
  const f = setup(connection(), (call, current) => {
    if (call.path.endsWith('/secrets')) { originalKey = call.key; current.latest_operation = other; throw new Error('response lost'); }
    if (call.path.includes('/secret-operations/')) return problem(404);
  });
  const v = await mountControl();
  try {
    change(tokenInput(v.host), 'secret-unknown'); await nextTick(); await submit(tokenForm(v.host)); await flush();
    assert.equal(tokenInput(v.host).props.disabled, true);
    assert.ok(f.calls.find(call => call.path.endsWith(`/secret-operations/${originalKey}`)));
    assert.equal(f.calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(f.calls.some(call => call.path.includes(other.operation_id)), false);
    assert.match(text(v.host), /save record is not available/);
    window.dispatchEvent(new Event('focus')); await flush();
    assert.equal(f.calls.filter(call => call.path.includes('/secret-operations/')).length, 1, 'focus is cooled down');
  } finally { v.app.unmount(); f.restore(); }
});

test('a malformed save and malformed original-key lookup cannot claim completion or unlock another save', async () => {
  const f = setup(connection(), call => {
    if (call.path.endsWith('/secrets')) return write({ ...operation('verified'), operation_id: 'invalid' });
    if (call.path.includes('/secret-operations/')) return Response.json({ ...operation('verified'), kind: 'rate_limit' });
  });
  const v = await mountControl();
  try {
    change(tokenInput(v.host), 'secret-malformed'); await nextTick(); await submit(tokenForm(v.host)); await flush();
    assert.equal(tokenInput(v.host).props.disabled, true); assert.match(text(v.host), /save result is not confirmed/);
    assert.equal(f.calls.filter(call => call.path.endsWith('/secrets')).length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('structured pre-dispatch refusal permits a replacement without falsely claiming a save', async () => {
  for (const status of [400, 403, 409]) {
    const f = setup(connection(), call => call.path.endsWith('/secrets') ? problem(status) : undefined);
    const v = await mountControl();
    try {
      change(tokenInput(v.host), 'rejected-token'); await nextTick(); await submit(tokenForm(v.host)); await flush();
      assert.equal(tokenInput(v.host).props.disabled, false); assert.match(text(v.host), /Token was not saved/);
      assert.doesNotMatch(text(v.host), /save result is not confirmed/);
      assert.equal(f.calls.some(call => call.path.includes('/secret-operations/')), false);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('missing Editor permission on the saved Token does not block entering and saving a replacement', async () => {
  const current = connection(); current.capabilities.configuration = 'permission_denied';
  const f = setup(current, call => {
    if (call.path.endsWith('/secrets')) {
      current.latest_operation = operation('verified'); current.version = 5; current.capabilities.configuration = 'verified';
      return write(current.latest_operation);
    }
  });
  const v = await mountControl();
  try {
    assert.equal(tokenInput(v.host).props.disabled, false);
    assert.match(text(capabilitySummary(row(v.host, 'Instance settings'))), /permission denied/);
    assert.equal(all(v.host).find(item => item.props['aria-label'] === 'Edit Instance API').props.disabled, true);
    change(tokenInput(v.host), 'replacement-with-editor'); await nextTick();
    assert.equal(button(v.host, 'Save').props.disabled, false);
    await submit(tokenForm(v.host)); await flush();
    assert.equal(f.calls.filter(call => call.path.endsWith('/secrets')).length, 1);
    assert.equal(tokenInput(v.host).props.disabled, false);
    assert.match(text(capabilitySummary(row(v.host, 'Instance settings'))), /Configuration readable/);
  } finally { v.app.unmount(); f.restore(); }
});

test('an active saved Token with denied analytics keeps its saved status, settings access and refreshes the independent data slot', async () => {
  const generation = ref(0); let saved = false;
  const f = setup(connection(), (call, current) => {
    if (call.path.endsWith('/secrets')) {
      saved = true; current.latest_operation = operation('verified'); current.version = 5;
      return write(current.latest_operation);
    }
    if (saved && call.path === '/api/v1/admin/cloudflare/verify') {
      current.capabilities.configuration = 'verified'; current.capabilities.analytics = 'permission_denied';
      return write(current);
    }
  });
  const v = await mountControl({ onApplied() { generation.value++; } }, { default: () => h('section', { id: 'data-slot' }, `Data generation ${generation.value}`) });
  const before = generation.value;
  try {
    change(tokenInput(v.host), 'token-without-analytics'); await nextTick(); await submit(tokenForm(v.host)); await flush();
    assert.match(text(v.host), /Token saved/); assert.doesNotMatch(text(v.host), /Token was not saved/);
    assert.match(text(capabilitySummary(row(v.host, 'Usage analytics'))), /permission denied/);
    assert.match(text(capabilitySummary(row(v.host, 'Instance settings'))), /Configuration readable/);
    assert.equal(all(v.host).find(item => item.props['aria-label'] === 'Edit Instance API').props.disabled, false);
    assert.equal(generation.value, before + 1);
    assert.match(text(v.host), new RegExp(`Data generation ${before + 1}`));
    assert.equal(f.calls.filter(call => call.path.endsWith('/secrets')).length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('successful saving remains visibly saved when later capability reads fail', async () => {
  let saved = false;
  const f = setup(connection(), (call, current) => {
    if (call.path.endsWith('/secrets')) { saved = true; current.latest_operation = operation('verified'); return write(current.latest_operation); }
    if (saved && call.path === '/api/v1/admin/cloudflare/verify') throw new Error('capability service unavailable');
  });
  const v = await mountControl();
  try {
    change(tokenInput(v.host), 'new-token'); await nextTick(); await submit(tokenForm(v.host)); await flush();
    assert.match(text(v.host), /Token saved/); assert.doesNotMatch(text(v.host), /Token was not saved/);
    assert.equal(f.calls.filter(call => call.path.endsWith('/secrets')).length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('legacy WAF pending operations recover through the generic operation endpoint without reviving WAF management', async () => {
  const current = connection(); current.latest_operation = { ...operation('unknown'), kind: 'waf', baseline_version_id: null, result_version_id: null, deployment_id: null, result_rule_id: null };
  const f = setup(current, (call, value) => {
    if (/\/operations\/.*\/verify$/.test(call.path)) { value.latest_operation = { ...value.latest_operation, status: 'verified', result_rule_id: 'old-rule' }; return write(value.latest_operation); }
  });
  const v = await mountControl();
  try {
    assert.equal(f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path)).length, 1);
    assert.equal(f.calls.some(call => call.path.includes('/waf')), false); assert.doesNotMatch(text(v.host), /WAF|Domain & access/);
  } finally { v.app.unmount(); f.restore(); }
});

test('returning after cooldown automatically reads current Secret state while preserving an unsent replacement', async () => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  const f = setup(); const v = await mountControl();
  try {
    change(tokenInput(v.host), 'unsent-replacement'); await nextTick();
    window.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.calls.filter(call => call.path.endsWith('/verify')).length, 1);
    now += 60_001; f.current.capabilities.configuration = 'permission_denied';
    window.dispatchEvent(new Event('focus')); await until(() => f.calls.filter(call => call.path.endsWith('/verify')).length === 2); await flush();
    assert.equal(tokenInput(v.host).props.value, 'unsent-replacement'); assert.match(text(v.host), /permission denied/);
    assert.equal(f.calls.some(call => call.path.endsWith('/secrets')), false);
  } finally { Date.now = originalNow; v.app.unmount(); f.restore(); }
});

test('background recovery stops after three retries and never repeats an unknown external write', async context => {
  const f = setup(); const v = await mountControl();
  try {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const original = f.current.latest_operation = operation('unknown');
    f.current.capabilities.configuration = 'unavailable';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (path, init) => {
      if (/\/operations\/.*\/verify$/.test(path)) { f.calls.push({ path, method: init.method }); return write(original); }
      return originalFetch(path, init);
    };
    const oldNow = Date.now; const future = oldNow() + 60_001; Date.now = () => future;
    window.dispatchEvent(new Event('focus')); await flush(); Date.now = oldNow;
    for (const duration of [2_000, 5_000, 15_000, 60_000]) { context.mock.timers.tick(duration); await flush(); }
    assert.equal(f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path)).length, 4);
    assert.equal(f.calls.some(call => call.path.endsWith('/secrets')), false);
    assert.equal(tokenInput(v.host).props.disabled, true);
  } finally { context.mock.timers.reset(); v.app.unmount(); f.restore(); }
});

test('editing a limit uses the visible current value, validates input, previews one scope and saves only after confirmation', async () => {
  const f = setup(connection(), (call, current, rates) => {
    if (call.path.endsWith('/rate-limits/plan')) { current.version = 5; return write({ plan_id: 'plan-one', kind: 'rate_limit', version: 5, baseline_version_id: 'v1', baseline_deployment_id: 'd1', target: current.target, before: rates.policies.instance, after: { scope: call.body.scope, limit: call.body.limit, period_seconds: call.body.period_seconds }, created_at: '2026-10-07T00:00:00Z' }); }
    if (call.path.endsWith('/rate-limits/apply')) { rates.policies.instance.limit = 450; current.latest_operation = { ...operation('verified'), kind: 'rate_limit' }; return write(current.latest_operation); }
  });
  const v = await mountControl();
  try {
    const edit = all(v.host).find(item => item.props['aria-label'] === 'Edit Instance API'); edit.props.onClick(); await nextTick();
    const input = all(dialog(v.host)).find(item => item.tag === 'input'); assert.equal(input.props.value, '300');
    change(input, '0'); await nextTick(); await submit(all(dialog(v.host)).find(item => item.tag === 'form')); await nextTick();
    assert.equal(f.calls.some(call => call.path.endsWith('/rate-limits/plan')), false);
    change(input, '450'); await nextTick(); await submit(all(dialog(v.host)).find(item => item.tag === 'form')); await flush();
    assert.match(text(dialog(v.host)), /300 \/ 60 seconds.*450 \/ 60 seconds/);
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/rate-limits/plan')).body, { scope: 'instance', limit: 450, period_seconds: 60, expected_version: 4 });
    assert.equal(f.calls.some(call => call.path.endsWith('/rate-limits/apply')), false);
    await button(v.host, 'Confirm save').props.onClick(); await flush();
    assert.equal(dialog(v.host), undefined); assert.equal(f.calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/rate-limits/apply')).body, { plan_id: 'plan-one', expected_version: 5 });
    assert.match(text(v.host), /450 \/ 60 seconds/);
  } finally { v.app.unmount(); f.restore(); }
});

test('usage-setting shortcut opens only that setting and closes after one reviewed atomic save', async () => {
  const requested = ref(null); const request = ref(0); const current = connection();
  const f = setup(current, (call, current) => {
    if (call.path.endsWith('/configuration/plan')) { current.version = 5; return write({ plan_id: 'setting-plan', kind: 'configuration', version: 5, target: current.target, before: { history_enabled: false }, after: { history_enabled: true } }); }
    if (call.path.endsWith('/configuration/apply')) { current.latest_operation = { ...operation('verified'), kind: 'configuration' }; current.configuration.history_enabled = true; return write(current.latest_operation); }
  });
  const host = node('root'); const app = renderer.createApp({ render: () => h(Control, { session: sessionFixture('settings-session'), initialSetting: requested.value, settingRequest: request.value }) });
  try {
    app.mount(host); await until(() => tokenInput(host) && !tokenInput(host).props.disabled);
    requested.value = 'history_enabled'; request.value++; await nextTick();
    assert.equal(dialog(host).props['aria-label'], 'Daily usage history');
    const selects = all(dialog(host)).filter(item => item.tag === 'select'); assert.equal(selects.length, 1);
    change(selects[0], 'true'); await nextTick(); await submit(all(dialog(host)).find(item => item.tag === 'form')); await flush();
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/configuration/plan')).body, { settings: { history_enabled: true }, expected_version: 4 });
    await button(host, 'Confirm save').props.onClick(); await flush(); assert.equal(dialog(host), undefined);
  } finally { app.unmount(); f.restore(); }
});

test('non-secret recovery survives navigation only in the original session partition', async () => {
  const session = sessionFixture(); let key;
  const f = setup(connection(), call => {
    if (call.path.endsWith('/secrets')) { key = call.key; throw new Error('lost'); }
    if (call.path.includes('/secret-operations/')) return problem(404);
  });
  const first = await mountControl({ session });
  try {
    change(tokenInput(first.host), 'lost-secret'); await nextTick(); await submit(tokenForm(first.host)); await flush(); first.app.unmount();
    const sameHost = node('root'); const same = renderer.createApp(Control, { session }); same.mount(sameHost); await flush();
    assert.equal(f.calls.filter(call => call.path.endsWith(`/secret-operations/${key}`)).length, 2); assert.equal(tokenInput(sameHost).props.disabled, true); same.unmount();
    const before = f.calls.length; const other = await mountControl({ session: sessionFixture() });
    assert.equal(f.calls.slice(before).some(call => call.path.includes('/secret-operations/')), false); other.app.unmount();
  } finally { first.app.unmount(); f.restore(); }
});

test('session changes discard old async responses and never replay another session’s Token', async () => {
  const selected = ref(sessionFixture('first-session')); let finish; let started = false;
  const f = setup(connection(), call => {
    if (call.path.endsWith('/secrets')) { started = true; return new Promise(resolve => { finish = () => resolve(problem(403)); }); }
  });
  const host = node('root'); const app = renderer.createApp({ render: () => h(Control, { session: selected.value }) });
  try {
    app.mount(host); await until(() => tokenInput(host) && !tokenInput(host).props.disabled);
    change(tokenInput(host), 'old-session-token'); await nextTick(); const pending = submit(tokenForm(host)); await until(() => started);
    selected.value = sessionFixture('second-session', 'second-owner'); await nextTick(); await until(() => tokenInput(host) && !tokenInput(host).props.disabled);
    finish(); await pending; await flush();
    assert.doesNotMatch(text(host), /Token was not saved/); assert.equal(tokenInput(host).props.value, '');
    assert.equal(f.calls.filter(call => call.path.endsWith('/secrets')).length, 1);
  } finally { app.unmount(); f.restore(); }
});

test('a lost setting save stays locked on an older completed operation across navigation and never reapplies', async () => {
  const current = connection(); current.latest_operation = operation('verified'); current.latest_operation.version = current.version;
  const session = sessionFixture(); let applyCount = 0;
  const f = setup(current, call => {
    if (call.path.endsWith('/rate-limits/plan')) { current.version = 5; return write({ plan_id: 'lost-plan', kind: 'rate_limit', version: 5, target: current.target, before: { limit: 300, period_seconds: 60 }, after: { scope: 'instance', limit: 450, period_seconds: 60 } }); }
    if (call.path.endsWith('/rate-limits/apply')) { applyCount++; throw new Error('lost response'); }
  });
  const v = await mountControl({ session }); let next;
  try {
    all(v.host).find(item => item.props['aria-label'] === 'Edit Instance API').props.onClick(); await nextTick();
    change(all(dialog(v.host)).find(item => item.tag === 'input'), '450'); await nextTick();
    await submit(all(dialog(v.host)).find(item => item.tag === 'form')); await flush();
    await button(v.host, 'Confirm save').props.onClick(); await flush();
    assert.equal(tokenInput(v.host).props.disabled, true);
    assert.equal(f.calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 1, 'old operation cannot release the uncertain change');
    v.app.unmount(); const host = node('root'); next = renderer.createApp(Control, { session }); next.mount(host); await flush();
    assert.equal(tokenInput(host).props.disabled, true); assert.equal(applyCount, 1);
    assert.match(text(host), /awaiting confirmation/);
  } finally { next?.unmount(); v.app.unmount(); f.restore(); }
});

test('a late plan cannot become confirmable after leaving its editor', async () => {
  let finishPlan; const mode = ref('usage'); const current = connection();
  const f = setup(current, call => {
    if (call.path.endsWith('/rate-limits/plan')) return new Promise(resolve => { finishPlan = () => resolve(write({ plan_id: 'late-plan', kind: 'rate_limit', version: 5, target: current.target, before: { limit: 300, period_seconds: 60 }, after: { scope: 'instance', limit: 450, period_seconds: 60 } })); });
  });
  const host = node('root'); const app = renderer.createApp({ render: () => h(Control, { mode: mode.value, session: sessionFixture('late-plan-session') }) });
  try {
    app.mount(host); await until(() => tokenInput(host) && !tokenInput(host).props.disabled);
    all(host).find(item => item.props['aria-label'] === 'Edit Instance API').props.onClick(); await nextTick();
    change(all(dialog(host)).find(item => item.tag === 'input'), '450'); await nextTick();
    const pending = submit(all(dialog(host)).find(item => item.tag === 'form')); await until(() => Boolean(finishPlan));
    mode.value = 'overview'; await nextTick(); finishPlan(); await pending; await flush();
    assert.equal(dialog(host), undefined); assert.equal(button(host, 'Confirm save'), undefined);
    assert.equal(f.calls.some(call => call.path.endsWith('/rate-limits/apply')), false);
  } finally { app.unmount(); f.restore(); }
});

test('a failed settings operation stays in the editor with its real cause and requires a new reviewed plan', async () => {
  for (const kind of ['rate_limit', 'configuration']) {
    let plans = 0; let applies = 0;
    const requested = ref(null); const requestedVersion = ref(0); const events = { applied: 0 };
    const f = setup(connection(), (call, current) => {
      if (call.path.endsWith('/plan')) {
        plans++; current.version++;
        return write({ plan_id: `retry-plan-${plans}`, kind, version: current.version, target: current.target,
          before: kind === 'rate_limit' ? { limit: 300, period_seconds: 60 } : { history_enabled: false },
          after: kind === 'rate_limit' ? { scope: 'instance', limit: 450, period_seconds: 60 } : { history_enabled: true } });
      }
      if (call.path.endsWith('/apply')) {
        applies++; current.version++;
        current.latest_operation = { ...operation(applies === 1 ? 'failed' : 'verified'), kind, version: current.version, failure_class: applies === 1 ? 'permission_denied' : null };
        current.capabilities.configuration = applies === 1 ? 'unverified' : 'verified';
        return write(current.latest_operation);
      }
      if (call.path === '/api/v1/admin/cloudflare/verify') { current.capabilities.configuration = 'verified'; return write(current); }
    });
    const host = node('root'); const app = renderer.createApp({ render: () => h(Control, { session: sessionFixture(`failed-${kind}`), initialSetting: requested.value, settingRequest: requestedVersion.value, onApplied() { events.applied++; } }) });
    try {
      app.mount(host); await until(() => tokenInput(host) && !tokenInput(host).props.disabled); const before = events.applied;
      if (kind === 'rate_limit') { all(host).find(item => item.props['aria-label'] === 'Edit Instance API').props.onClick(); await nextTick(); change(all(dialog(host)).find(item => item.tag === 'input'), '450'); }
      else { requested.value = 'history_enabled'; requestedVersion.value++; await nextTick(); change(all(dialog(host)).find(item => item.tag === 'select'), 'true'); }
      await nextTick(); await submit(all(dialog(host)).find(item => item.tag === 'form')); await flush();
      await button(host, 'Confirm save').props.onClick(); await flush();
      assert.ok(dialog(host)); assert.match(text(dialog(host)), /settings change failed.*Cloudflare denied permission to change these settings/);
      assert.doesNotMatch(text(host), /Token save failed|Token was not saved|Settings saved\./);
      assert.equal(events.applied, before, 'failed apply and its permission readback cannot report applied');
      assert.equal(button(host, 'Review change').props.disabled, false); assert.equal(applies, 1);
      const draft = all(dialog(host)).find(item => item.tag === (kind === 'rate_limit' ? 'input' : 'select'));
      assert.equal(draft.props.value, kind === 'rate_limit' ? '450' : 'true');
      await submit(all(dialog(host)).find(item => item.tag === 'form')); await flush();
      assert.equal(plans, 2); assert.equal(applies, 1, 'review never automatically replays the failed apply');
      await button(host, 'Confirm save').props.onClick(); await flush();
      assert.equal(applies, 2); assert.equal(dialog(host), undefined); assert.equal(events.applied, before + 1); assert.match(text(host), /Settings saved\./);
    } finally { app.unmount(); f.restore(); }
  }
});

test('an automatically confirmed failure is displayed as a settings failure without replaying pending or unknown apply', async () => {
  for (const initialStatus of ['pending', 'unknown']) {
    const f = setup(connection(), (call, current) => {
      if (call.path.endsWith('/rate-limits/plan')) { current.version = 5; return write({ plan_id: 'pending-plan', kind: 'rate_limit', version: 5, target: current.target, before: { limit: 300, period_seconds: 60 }, after: { scope: 'instance', limit: 450, period_seconds: 60 } }); }
      if (call.path.endsWith('/rate-limits/apply')) { current.version = 6; current.latest_operation = { ...operation(initialStatus), kind: 'rate_limit', version: 6 }; return write(current.latest_operation); }
      if (/\/operations\/.*\/verify$/.test(call.path)) { current.version = 7; current.latest_operation = { ...current.latest_operation, status: 'failed', version: 7, failure_class: 'preflight_changed' }; return write(current.latest_operation); }
    });
    const v = await mountControl();
    try {
      const before = v.events.applied; all(v.host).find(item => item.props['aria-label'] === 'Edit Instance API').props.onClick(); await nextTick();
      change(all(dialog(v.host)).find(item => item.tag === 'input'), '450'); await nextTick();
      await submit(all(dialog(v.host)).find(item => item.tag === 'form')); await flush();
      await button(v.host, 'Confirm save').props.onClick(); await flush();
      assert.equal(dialog(v.host), undefined); assert.match(text(v.host), /settings change failed.*active settings changed/);
      assert.doesNotMatch(text(v.host), /Token save failed|Settings saved\./); assert.equal(v.events.applied, before);
      assert.equal(f.calls.filter(call => call.path.endsWith('/rate-limits/apply')).length, 1);
      assert.equal(f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path)).length, 1);
      assert.equal(tokenInput(v.host).props.disabled, false);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('a failed or conflicted preview reads fresh settings automatically and keeps the unsaved draft editable', async () => {
  for (const failure of ['offline', 'conflict']) {
    let plans = 0;
    const f = setup(connection(), (call, current, rates) => {
      if (call.path.endsWith('/rate-limits/plan')) {
        plans++;
        if (plans === 1) { current.version = 7; rates.policies.instance.limit = 600; if (failure === 'conflict') return problem(409); throw new Error('plan response lost'); }
        current.version = 8; return write({ plan_id: 'fresh-plan', kind: 'rate_limit', version: 8, target: current.target, before: { limit: 600, period_seconds: 60 }, after: { scope: 'instance', limit: 450, period_seconds: 60 } });
      }
    });
    const v = await mountControl();
    try {
      all(v.host).find(item => item.props['aria-label'] === 'Edit Instance API').props.onClick(); await nextTick();
      change(all(dialog(v.host)).find(item => item.tag === 'input'), '450'); await nextTick();
      await submit(all(dialog(v.host)).find(item => item.tag === 'form')); await flush();
      assert.ok(dialog(v.host)); assert.equal(button(v.host, 'Review change').props.disabled, false);
      assert.equal(all(dialog(v.host)).find(item => item.tag === 'input').props.value, '450');
      assert.match(text(dialog(v.host)), /Current value: 600 \/ 60 seconds/);
      assert.match(text(dialog(v.host)), failure === 'conflict' ? /Settings changed elsewhere/ : /Could not prepare this change/);
      assert.equal(plans, 1); assert.equal(f.calls.some(call => call.path.endsWith('/apply')), false);
      await submit(all(dialog(v.host)).find(item => item.tag === 'form')); await flush();
      assert.equal(plans, 2); assert.equal(f.calls.filter(call => call.path.endsWith('/rate-limits/plan')).at(-1).body.expected_version, 7);
      assert.match(text(dialog(v.host)), /600 \/ 60 seconds.*450 \/ 60 seconds/); assert.ok(button(v.host, 'Confirm save'));
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('preview readback retries while its editor is open and closing the editor does not leave a permanent write lock', async context => {
  for (const closeEditor of [false, true]) {
    let outage = false;
    const f = setup(connection(), call => {
      if (call.path.endsWith('/rate-limits/plan')) { outage = true; throw new Error('offline'); }
      if (outage && call.path === '/api/v1/admin/cloudflare') throw new Error('readback offline');
    });
    const v = await mountControl();
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      all(v.host).find(item => item.props['aria-label'] === 'Edit Instance API').props.onClick(); await nextTick();
      change(all(dialog(v.host)).find(item => item.tag === 'input'), '450'); await nextTick();
      await submit(all(dialog(v.host)).find(item => item.tag === 'form')); await flush();
      assert.equal(button(v.host, 'Review change').props.disabled, true);
      outage = false;
      if (closeEditor) { all(dialog(v.host)).find(item => item.props['aria-label'] === 'Close').props.onClick(); await flush(); }
      else { context.mock.timers.tick(2000); await flush(); }
      assert.equal(tokenInput(v.host).props.disabled, false);
      if (!closeEditor) { assert.equal(button(v.host, 'Review change').props.disabled, false); assert.equal(all(dialog(v.host)).find(item => item.tag === 'input').props.value, '450'); }
      else assert.equal(dialog(v.host), undefined);
      assert.equal(f.calls.filter(call => call.path.endsWith('/rate-limits/plan')).length, 1);
      assert.equal(f.calls.some(call => call.path.endsWith('/apply')), false);
    } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
  }
});

test('Owner routes keep overview read-only and place usage data between Token and limits', async () => {
  const owner = await readFile(new URL('../../apps/web/src/views/OwnerView.vue', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../apps/web/src/App.vue', import.meta.url), 'utf8');
  assert.match(owner, /<CloudflareControlPanel v-if="activeSection === 'usage'"[\s\S]*?<UsagePanel [\s\S]*?<UsageHistoryPanel [\s\S]*?<\/CloudflareControlPanel>/);
  assert.match(owner, /<HomepageSettingsPanel v-if="activeSection === 'settings'"/);
  assert.match(owner, /props\.section === "cloudflare" \? "usage"/);
  assert.match(app, /raw === "cloudflare" \|\| raw === "settings"/);
});

test('history geometry does not connect missing days while real zero remains observed', () => {
  const result = historyGeometry([{ day: '2026-10-01', value: 0 }, { day: '2026-10-02', value: null }, { day: '2026-10-03', value: 10 }, { day: '2026-10-05', value: 5 }]);
  assert.equal(result.segments.length, 3); assert.equal(result.dots.length, 3);
  assert.equal(result.dots[0].y, 180); assert.equal(result.maximum, 10);
});
