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
test('usage has one persistent empty Token field, two truthful capabilities and all settings before the data slot', async () => {
  const f = setup(); const v = await mountControl({}, { default: () => h('section', { id: 'usage-slot' }, 'USAGE DATA') });
  try {
    assert.match(text(v.host), /Token saved/); assert.equal(tokenInput(v.host).props.value, '');
    assert.equal(button(v.host, 'Save').props.disabled, true);
    assert.match(text(v.host), /Leave blank to keep the saved Token/);
    assert.equal(capabilityRows(v.host).length, 2);
    assert.match(text(v.host), /Configuration readable/);
    assert.doesNotMatch(text(capabilitySummary(row(v.host, 'Instance settings'))), /Editor|permissions verified/);
    assert.doesNotMatch(text(v.host), /WAF|notification policies|Budget|Check again|Check save|Read history|Overview/);
    assert.equal(all(v.host).filter(item => String(item.props.class).includes('rate-row')).length, 5);
    assert.ok(text(v.host).indexOf('Token saved') < text(v.host).indexOf('USAGE DATA'));
    assert.ok(text(v.host).indexOf('Token saved') < text(v.host).indexOf('Usage & access settings'));
    assert.ok(text(v.host).indexOf('Request frequency') < text(v.host).indexOf('USAGE DATA'));
    assert.equal(settingsSave(v.host).props.disabled, true);
    assert.equal(dialog(v.host), undefined);
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
    assert.equal(all(v.host).find(item => item.props.id === 'usage-rate-instance').props.disabled, true);
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
    assert.equal(all(v.host).find(item => item.props.id === 'usage-rate-instance').props.disabled, false);
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

const settingsSave = host => all(host).find(item => item.tag === 'form' && item.props.class === 'unified-settings-form')?.children.flatMap(all).find(item => item.tag === 'button' && item.props.type === 'submit');
const settingsForm = host => all(host).find(item => item.tag === 'form' && item.props.class === 'unified-settings-form');
const settingInput = (host, name) => all(host).find(item => item.props.id === `usage-setting-${name}`);
const rateInput = (host, scope = 'instance') => all(host).find(item => item.props.id === `usage-rate-${scope}`);
const diff = host => all(host).find(item => item.props.class === 'plan-comparison');
const planFixture = (call, current, rates) => {
  const before = Object.fromEntries(['analytics_enabled', 'history_enabled', 'account_totals', 'billing_plan', 'billing_cycle_day'].map(key => [key, current.configuration[key]]));
  if (call.body.settings.rate_limits) before.rate_limits = Object.fromEntries(Object.keys(call.body.settings.rate_limits).map(scope => [scope, { ...(scope === 'anonymous_login' || scope === 'expensive_reads' ? rates.cost_protection[scope].policy : rates.policies[scope]) }]));
  const resource = { plan_id: crypto.randomUUID(), kind: 'configuration', version: current.version + 1, target: Object.fromEntries(['account_id', 'worker_name', 'database_id'].map(key => [key, current.target[key]])), before, after: { ...before, ...call.body.settings } };
  current.version = resource.version;
  return resource;
};
function successfulSettings(call, current, rates, state) {
  if (call.path.endsWith('/configuration/plan')) { state.plan = planFixture(call, current, rates); return write(state.plan); }
  if (call.path.endsWith('/configuration/apply')) {
    for (const [key, value] of Object.entries(state.plan.after)) {
      if (key === 'rate_limits') for (const [scope, rate] of Object.entries(value)) {
        if (scope === 'anonymous_login' || scope === 'expensive_reads') rates.cost_protection[scope].policy = rate; else rates.policies[scope] = rate;
      }
      else current.configuration[key] = value;
    }
    current.version++; current.latest_operation = { ...operation('verified'), kind: 'configuration', version: current.version };
    return write(current.latest_operation);
  }
}

test('completed instance history never becomes this page’s settings save feedback', async () => {
  for (const kind of ['configuration', 'rate_limit']) for (const outcome of ['failed', 'verified']) {
    const current = connection(); current.latest_operation = { ...operation(outcome), kind, failure_class: outcome === 'failed' ? 'permission_denied' : null };
    const f = setup(current); const v = await mountControl();
    try {
      assert.equal(all(v.host).find(item => item.props.class === 'settings-feedback'), undefined);
      assert.doesNotMatch(text(v.host), /settings change failed|Settings saved/);
      assert.equal(settingInput(v.host, 'history_enabled').props.disabled, false);
      assert.equal(v.events.applied, 1, 'initial data loading is independent of completed history');
      assert.equal(f.calls.some(call => call.path.includes('/operations/')), false);
      assert.equal(f.calls.some(call => call.path.endsWith('/configuration/apply')), false);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('unresolved instance history stays locked and verifies its exact operation before unlocking', async () => {
  for (const kind of ['configuration', 'rate_limit']) for (const pending of ['pending', 'unknown']) {
    const current = connection(); current.latest_operation = { ...operation(pending), kind };
    let finish;
    const f = setup(current, call => {
      if (/\/operations\/.*\/verify$/.test(call.path)) return new Promise(resolve => { finish = () => {
        current.version = 6; current.latest_operation = { ...current.latest_operation, status: 'verified', version: 6 };
        resolve(write(current.latest_operation));
      }; });
    });
    const host = node('root'); const app = renderer.createApp(Control, { session: sessionFixture() }); app.mount(host);
    try {
      await until(() => Boolean(finish));
      assert.equal(tokenInput(host).props.disabled, true);
      assert.equal(settingInput(host, 'history_enabled').props.disabled, true);
      assert.match(text(host), /settings change is awaiting confirmation/);
      assert.equal(f.calls.filter(call => call.path.endsWith(`/operations/${current.latest_operation.operation_id}/verify`)).length, 1);
      finish(); await until(() => !tokenInput(host).props.disabled); await flush();
      assert.match(text(host), /Settings saved/);
      assert.equal(f.calls.some(call => call.path.endsWith('/configuration/apply') || call.path.endsWith('/secrets')), false);
    } finally { app.unmount(); f.restore(); }
  }
});

test('per-minute editing leaves legacy ten-second limits untouched on open and unrelated saves', async () => {
  const state = {}; const f = setup(connection(), (call, current, rates) => successfulSettings(call, current, rates, state)); const v = await mountControl();
  try {
    const legacy = rateInput(v.host, 'anonymous_login');
    assert.equal(legacy.props.value, ''); assert.equal(legacy.props.placeholder, 'Enter requests per minute');
    const rows = all(v.host).filter(item => item.props.class === 'setting-row rate-row');
    assert.equal(rows.some(item => all(item).some(child => child.tag === 'select')), false, 'frequency has no duration selector');
    assert.match(text(rows.find(item => text(item).startsWith('Anonymous login'))), /11 \/ 10 seconds/);
    assert.match(text(v.host), /Set the maximum requests allowed per minute \(60 seconds\)/);
    assert.equal(diff(v.host), undefined); assert.equal(settingsSave(v.host).props.disabled, true);
    assert.equal(f.calls.some(call => call.path.endsWith('/configuration/plan') || call.path.endsWith('/configuration/apply')), false);
    change(settingInput(v.host, 'history_enabled'), 'true'); await nextTick(); await submit(settingsForm(v.host)); await flush();
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/configuration/plan')).body.settings, { history_enabled: true });
    assert.deepEqual(f.rates.cost_protection.anonymous_login.policy, { limit: 11, period_seconds: 10 });
    assert.equal(rateInput(v.host, 'anonymous_login').props.value, '');
    locale.value = 'zh-CN'; await nextTick();
    assert.equal(rateInput(v.host, 'anonymous_login').props.placeholder, '请输入每分钟请求数');
    assert.match(text(v.host), /11 \/ 10 秒.*当前 10 秒限额继续生效/);
  } finally { locale.value = 'en'; v.app.unmount(); f.restore(); }
});

test('explicit legacy edits show the ten-to-sixty-second change and save the entered per-minute limit without scaling', async () => {
  for (const scope of ['instance', 'anonymous_login']) {
    const state = {}; const f = setup(connection(), (call, current, rates) => successfulSettings(call, current, rates, state));
    const rate = scope === 'instance' ? f.rates.policies.instance : f.rates.cost_protection.anonymous_login.policy;
    rate.limit = 11; rate.period_seconds = 10;
    const v = await mountControl();
    try {
      change(rateInput(v.host, scope), '11'); await nextTick();
      assert.match(text(diff(v.host)), /11 \/ 10 seconds11 \/ 1 minute \(window: 10 → 60 seconds\)/);
      locale.value = 'zh-CN'; await nextTick(); assert.match(text(diff(v.host)), /11 \/ 10 秒11 \/ 1 分钟（时长：10 → 60 秒）/); locale.value = 'en'; await nextTick();
      button(v.host, 'Discard changes').props.onClick(); await nextTick();
      assert.equal(rateInput(v.host, scope).props.value, ''); assert.equal(diff(v.host), undefined);
      change(rateInput(v.host, scope), '11'); await nextTick(); await submit(settingsForm(v.host)); await flush();
      assert.deepEqual(f.calls.find(call => call.path.endsWith('/configuration/plan')).body.settings, { rate_limits: { [scope]: { limit: 11, period_seconds: 60 } } });
      assert.equal(rateInput(v.host, scope).props.value, '11'); assert.equal(diff(v.host), undefined);
      assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
    } finally { locale.value = 'en'; v.app.unmount(); f.restore(); }
  }
});

test('attachment settings are inside the settings section but outside its form and remain independent of Cloudflare authorization', async () => {
  const current = connection(); current.configured = { connection: false, configuration: false, control: false, analytics: false }; current.capabilities.configuration = 'missing';
  const f = setup(current); const v = await mountControl({}, { 'attachment-settings': () => h('form', { id: 'attachment-settings-fixture' }, [h('input', { id: 'attachment-limit-fixture' })]) });
  try {
    const attachment = all(v.host).find(item => item.props.id === 'attachment-settings-fixture');
    assert.ok(attachment); assert.equal(attachment.parent.props.class, 'owner-section settings-panel');
    assert.equal(attachment.parent, settingsForm(v.host).parent);
    assert.equal(all(settingsForm(v.host)).includes(attachment), false);
    assert.equal(settingInput(v.host, 'history_enabled').props.disabled, true);
    assert.equal(all(attachment).find(item => item.props.id === 'attachment-limit-fixture').props.disabled, undefined);
  } finally { v.app.unmount(); f.restore(); }
});

test('unified settings draft shows only changes, discards locally, and keeps unknown fields unavailable', async () => {
  const f = setup(); const v = await mountControl();
  try {
    assert.equal(settingInput(v.host, 'history_enabled').props.value, 'false');
    assert.equal(settingInput(v.host, 'account_totals').props.value, 'false');
    assert.equal(diff(v.host), undefined); const before = f.calls.length;
    change(settingInput(v.host, 'history_enabled'), 'true'); change(rateInput(v.host), '450'); await nextTick();
    assert.match(text(diff(v.host)), /Daily usage historyDisabledEnabled.*Instance API300 \/ 1 minute450 \/ 1 minute/);
    assert.equal(all(diff(v.host)).filter(item => item.tag === 'tbody')[0].children.filter(item => item.tag === 'tr').length, 2);
    assert.equal(settingsSave(v.host).props.disabled, false); assert.equal(text(settingsSave(v.host)), 'Save 2 changes');
    locale.value = 'zh-CN'; await nextTick(); assert.equal(text(settingsSave(v.host)), '保存 2 项修改'); locale.value = 'en'; await nextTick();
    assert.equal(f.calls.length, before, 'editing and showing the comparison are entirely local');
    button(v.host, 'Discard changes').props.onClick(); await nextTick();
    assert.equal(diff(v.host), undefined); assert.equal(rateInput(v.host).props.value, '300');
    assert.equal(settingsSave(v.host).props.disabled, true);
    locale.value = 'zh-CN'; await nextTick(); assert.match(text(v.host), /用量与访问设置.*当前套餐声明.*不会购买或切换/);
    assert.ok(button(v.host, '保存设置')); assert.ok(button(v.host, '放弃修改'));
  } finally { locale.value = 'en'; v.app.unmount(); f.restore(); }
  const missing = connection(); delete missing.configuration.history_enabled;
  const g = setup(missing); const second = await mountControl();
  try { assert.equal(settingInput(second.host, 'history_enabled').props.value, ''); assert.equal(settingInput(second.host, 'history_enabled').props.disabled, true); assert.equal(settingsSave(second.host).props.disabled, true); }
  finally { second.app.unmount(); g.restore(); }
});

test('one save sends only changed settings to one configuration plan and one apply then reads all results', async () => {
  const state = {}; const f = setup(connection(), (call, current, rates) => successfulSettings(call, current, rates, state)); const v = await mountControl();
  try {
    const before = v.events.applied;
    change(settingInput(v.host, 'history_enabled'), 'true'); change(settingInput(v.host, 'billing_plan'), 'paid');
    change(rateInput(v.host), '450'); change(rateInput(v.host, 'anonymous_login'), '20'); await nextTick();
    await submit(settingsForm(v.host)); await flush();
    const plans = f.calls.filter(call => call.path.endsWith('/configuration/plan')), applies = f.calls.filter(call => call.path.endsWith('/configuration/apply'));
    assert.equal(plans.length, 1); assert.equal(applies.length, 1); assert.ok(applies[0].key);
    assert.deepEqual(plans[0].body, { settings: { history_enabled: true, billing_plan: 'paid', rate_limits: { instance: { limit: 450, period_seconds: 60 }, anonymous_login: { limit: 20, period_seconds: 60 } } }, expected_version: 4 });
    assert.deepEqual(applies[0].body, { plan_id: state.plan.plan_id, expected_version: 5 });
    assert.equal(f.calls.some(call => call.path.includes('/rate-limits/')), false);
    assert.equal(diff(v.host), undefined); assert.equal(rateInput(v.host).props.value, '450'); assert.equal(settingInput(v.host, 'history_enabled').props.value, 'true');
    assert.equal(settingsSave(v.host).props.disabled, true); assert.equal(v.events.applied, before + 1); assert.match(text(v.host), /Settings saved/); assert.equal(dialog(v.host), undefined);
    await submit(settingsForm(v.host)); assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/plan')).length, 1);
  } finally { v.app.unmount(); f.restore(); }
});

test('invalid settings never create a plan and returning to the current values disables save', async () => {
  const f = setup(); const v = await mountControl();
  try {
    for (const invalid of ['0', '1.5', '-1']) { change(rateInput(v.host), invalid); await nextTick(); await submit(settingsForm(v.host)); await nextTick(); assert.match(text(v.host), /Use whole numbers/); }
    change(rateInput(v.host), '300'); change(settingInput(v.host, 'billing_cycle_day'), '32'); await nextTick(); await submit(settingsForm(v.host));
    assert.equal(f.calls.some(call => call.path.endsWith('/configuration/plan')), false);
    change(settingInput(v.host, 'billing_cycle_day'), '10'); change(rateInput(v.host), '0300'); await nextTick(); assert.equal(settingsSave(v.host).props.disabled, true);
  } finally { v.app.unmount(); f.restore(); }
});

test('a frozen plan whose target, current values or new values differ from the visible comparison never applies', async () => {
  for (const mismatch of ['target', 'before', 'after', 'version', 'extra']) {
    const f = setup(connection(), (call, current, rates) => {
      if (!call.path.endsWith('/configuration/plan')) return;
      const planned = planFixture(call, current, rates);
      if (mismatch === 'target') planned.target.worker_name = 'other-worker';
      if (mismatch === 'before') { planned.before.billing_cycle_day = 15; current.configuration.billing_cycle_day = 15; }
      if (mismatch === 'after') planned.after.history_enabled = false;
      if (mismatch === 'version') planned.version++;
      if (mismatch === 'extra') planned.after.rate_limits = { principal: { limit: 999, period_seconds: 60 } };
      return write(planned);
    }); const v = await mountControl();
    try {
      change(settingInput(v.host, 'history_enabled'), 'true'); await nextTick(); await submit(settingsForm(v.host)); await flush();
      assert.equal(f.calls.some(call => call.path.endsWith('/apply')), false, mismatch); assert.match(text(v.host), /Settings changed elsewhere/);
      assert.equal(settingInput(v.host, 'history_enabled').props.value, 'true'); assert.equal(settingsSave(v.host).props.disabled, false);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('a conflicting or failed preparation refreshes current values and retains the draft for one new save', async () => {
  for (const failure of ['offline', 'conflict']) {
    let attempts = 0; const state = {};
    const f = setup(connection(), (call, current, rates) => {
      if (call.path.endsWith('/configuration/plan') && attempts++ === 0) { current.version = 7; rates.policies.instance.limit = 600; if (failure === 'conflict') return problem(409); throw new Error('plan result lost'); }
      return successfulSettings(call, current, rates, state);
    }); const v = await mountControl();
    try {
      change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
      assert.match(text(v.host), failure === 'conflict' ? /Settings changed elsewhere/ : /Could not prepare/);
      assert.match(text(diff(v.host)), /600 \/ 1 minute450 \/ 1 minute/); assert.equal(rateInput(v.host).props.value, '450');
      assert.equal(f.calls.some(call => call.path.endsWith('/apply')), false);
      await submit(settingsForm(v.host)); await flush();
      assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/plan')).at(-1).body.expected_version, 7);
      assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1); assert.match(text(v.host), /Settings saved/);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('a rejected or failed apply keeps the complete draft and needs a new explicit save', async () => {
  for (const failure of ['conflict', 'permission', 'operation']) {
    let applies = 0; const state = {};
    const f = setup(connection(), (call, current, rates) => {
      if (call.path.endsWith('/configuration/apply') && applies++ === 0) {
        if (failure === 'conflict') return problem(409);
        if (failure === 'permission') return problem(403, { source: 'cloudflare_platform' });
        current.version++; current.latest_operation = { ...operation('failed'), kind: 'configuration', version: current.version, failure_class: 'permission_denied' }; return write(current.latest_operation);
      }
      return successfulSettings(call, current, rates, state);
    }); const v = await mountControl();
    try {
      change(settingInput(v.host, 'history_enabled'), 'true'); change(rateInput(v.host), '450'); await nextTick();
      await submit(settingsForm(v.host)); await flush();
      assert.equal(applies, 1); assert.equal(settingInput(v.host, 'history_enabled').props.value, 'true'); assert.equal(rateInput(v.host).props.value, '450');
      assert.match(text(v.host), failure === 'operation' ? /settings change failed.*denied permission/ : failure === 'conflict' ? /Settings changed elsewhere/ : /was not saved/);
      assert.doesNotMatch(text(v.host), /Settings saved/); assert.equal(settingsSave(v.host).props.disabled, false);
      await submit(settingsForm(v.host)); await flush(); assert.equal(applies, 2); assert.equal(diff(v.host), undefined);
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('a confirmed failed apply rechecks invalidated capabilities while keeping its failed result and draft without resending apply', async () => {
  const state = {}; let finishCheck;
  const f = setup(connection(), (call, current, rates) => {
    if (call.path.endsWith('/configuration/apply')) {
      current.version++; current.latest_operation = { ...operation('failed'), kind: 'configuration', version: current.version, failure_class: 'permission_denied' };
      current.capabilities.configuration = 'unverified'; current.capabilities.analytics = 'unverified';
      return write(current.latest_operation);
    }
    if (call.path === '/api/v1/admin/cloudflare/verify' && current.latest_operation?.status === 'failed') return new Promise(resolve => { finishCheck = () => {
      current.capabilities.configuration = 'verified'; current.capabilities.analytics = 'missing';
      resolve(write(current));
    }; });
    return successfulSettings(call, current, rates, state);
  }); const v = await mountControl();
  try {
    const before = v.events.applied;
    change(settingInput(v.host, 'history_enabled'), 'true'); change(rateInput(v.host), '450'); await nextTick();
    await submit(settingsForm(v.host)); await until(() => Boolean(finishCheck));
    assert.equal(settingsSave(v.host).props.disabled, true);
    assert.match(text(v.host), /settings change failed.*denied permission/);
    assert.equal(settingInput(v.host, 'history_enabled').props.value, 'true'); assert.equal(rateInput(v.host).props.value, '450');
    finishCheck(); await until(() => !settingsSave(v.host).props.disabled); await flush();
    assert.match(text(v.host), /settings change failed.*denied permission/); assert.doesNotMatch(text(v.host), /Settings saved/);
    assert.equal(settingInput(v.host, 'history_enabled').props.value, 'true'); assert.equal(rateInput(v.host).props.value, '450');
    assert.match(text(capabilitySummary(row(v.host, 'Instance settings'))), /Configuration readable/);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/plan')).length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
    assert.equal(f.calls.filter(call => call.path === '/api/v1/admin/cloudflare/verify').length, 2);
    assert.equal(v.events.applied, before, 'failed settings never report an applied change');
  } finally { v.app.unmount(); f.restore(); }
});

test('a lost apply recovers only its original key across navigation and never trusts another completed operation', async () => {
  const session = sessionFixture(); let key; const state = {};
  const f = setup(connection(), (call, current, rates) => {
    if (call.path.endsWith('/configuration/apply')) { key = call.key; current.version = 10; current.latest_operation = { ...operation('verified'), operation_id: '22222222-2222-4222-8222-222222222222', kind: 'configuration', version: 10 }; throw new Error('lost response'); }
    if (call.path.includes('/configuration/operations/')) return problem(404);
    return successfulSettings(call, current, rates, state);
  }); const v = await mountControl({ session }); let next;
  try {
    change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
    assert.equal(settingsSave(v.host).props.disabled, true); assert.equal(tokenInput(v.host).props.disabled, true);
    assert.ok(f.calls.some(call => call.path.endsWith(`/configuration/operations/${key}`))); assert.equal(f.calls.some(call => call.path.includes('22222222-2222')), false);
    v.app.unmount(); const host = node('root'); next = renderer.createApp(Control, { session }); next.mount(host); await flush();
    assert.equal(settingsSave(host).props.disabled, true); assert.equal(rateInput(host).props.value, '450');
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith(`/configuration/operations/${key}`)).length, 2);
  } finally { next?.unmount(); v.app.unmount(); f.restore(); }
});

test('pending and unknown settings are verified automatically without applying again and preserve failed drafts', async () => {
  for (const outcome of ['verified', 'failed']) {
    const state = {}; const f = setup(connection(), (call, current, rates) => {
      if (call.path.endsWith('/configuration/apply')) { current.version++; current.latest_operation = { ...operation('unknown'), kind: 'configuration', version: current.version }; return write(current.latest_operation); }
      if (/\/operations\/.*\/verify$/.test(call.path)) { current.version++; current.latest_operation = { ...current.latest_operation, status: outcome, version: current.version, failure_class: outcome === 'failed' ? 'preflight_changed' : null }; if (outcome === 'verified') rates.policies.instance.limit = 450; return write(current.latest_operation); }
      return successfulSettings(call, current, rates, state);
    }); const v = await mountControl();
    try {
      change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
      assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
      assert.equal(f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path)).length, 1);
      assert.equal(tokenInput(v.host).props.disabled, false);
      assert.match(text(v.host), outcome === 'verified' ? /Settings saved/ : /settings change failed.*active settings changed/);
      assert.equal(Boolean(diff(v.host)), outcome === 'failed');
    } finally { v.app.unmount(); f.restore(); }
  }
});

test('late preparation after leaving the page or changing identity cannot dispatch apply', async () => {
  for (const boundary of ['mode', 'session', 'unmount']) {
    let finish; const mode = ref('usage'), session = ref(sessionFixture());
    const f = setup(connection(), (call, current, rates) => call.path.endsWith('/configuration/plan') ? new Promise(resolve => { finish = () => resolve(write(planFixture(call, current, rates))); }) : undefined);
    const host = node('root'); const app = renderer.createApp({ render: () => h(Control, { mode: mode.value, session: session.value }) });
    try {
      app.mount(host); await until(() => rateInput(host) && !rateInput(host).props.disabled);
      change(rateInput(host), '450'); await nextTick(); const pending = submit(settingsForm(host)); await until(() => Boolean(finish));
      assert.equal(rateInput(host).props.disabled, true); change(rateInput(host), '999'); await nextTick(); assert.equal(rateInput(host).props.value, '450');
      if (boundary === 'mode') mode.value = 'overview'; else if (boundary === 'session') session.value = sessionFixture(); else app.unmount();
      await nextTick(); finish(); await pending; await flush(); assert.equal(f.calls.some(call => call.path.endsWith('/apply')), false, boundary);
      if (boundary === 'session') assert.equal(diff(host), undefined);
    } finally { app.unmount(); f.restore(); }
  }
});

test('failed current-value readback retries without dropping the draft or repeating plan/apply', async context => {
  let outage = false;
  const f = setup(connection(), call => {
    if (call.path.endsWith('/configuration/plan')) { outage = true; throw new Error('offline'); }
    if (outage && call.path === '/api/v1/admin/cloudflare') throw new Error('readback offline');
  }); const v = await mountControl(); context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
    assert.equal(settingsSave(v.host).props.disabled, true); outage = false;
    context.mock.timers.tick(2000); await flush();
    assert.equal(settingsSave(v.host).props.disabled, false); assert.equal(rateInput(v.host).props.value, '450');
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/plan')).length, 1); assert.equal(f.calls.some(call => call.path.endsWith('/apply')), false);
  } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('uncertain verification preserves its original key across navigation and starts a new round only after a complete response', async context => {
  const session = sessionFixture(), state = {}; let verifications = 0;
  const f = setup(connection(), (call, current, rates) => {
    if (call.path.endsWith('/configuration/apply')) { current.version++; current.latest_operation = { ...operation('unknown'), kind: 'configuration', version: current.version }; return write(current.latest_operation); }
    if (/\/operations\/.*\/verify$/.test(call.path)) {
      verifications++;
      if (verifications === 1) throw new Error('verification response lost');
      current.version++; current.latest_operation = { ...current.latest_operation, status: verifications === 2 ? 'unknown' : 'verified', version: current.version };
      if (verifications === 3) rates.policies.instance.limit = 450;
      return write(current.latest_operation);
    }
    return successfulSettings(call, current, rates, state);
  }); const v = await mountControl({ session }); let next;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
    assert.equal(verifications, 1); assert.equal(settingsSave(v.host).props.disabled, true);
    v.app.unmount(); const host = node('root'); next = renderer.createApp(Control, { session }); next.mount(host); await flush();
    assert.equal(verifications, 2); assert.equal(settingsSave(host).props.disabled, true);
    const verifyCalls = () => f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path));
    assert.equal(verifyCalls()[0].key, verifyCalls()[1].key);
    context.mock.timers.tick(2000); await flush();
    assert.equal(verifications, 3); assert.notEqual(verifyCalls()[1].key, verifyCalls()[2].key);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
    assert.match(text(host), /Settings saved/); assert.equal(diff(host), undefined); assert.equal(rateInput(host).props.value, '450');
  } finally { next?.unmount(); v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('a refusal while recovering an uncertain verification keeps the same original key until its successful response', async context => {
  const state = {}; let verifications = 0;
  const f = setup(connection(), (call, current, rates) => {
    if (call.path.endsWith('/configuration/apply')) { current.version++; current.latest_operation = { ...operation('unknown'), kind: 'configuration', version: current.version }; return write(current.latest_operation); }
    if (/\/operations\/.*\/verify$/.test(call.path)) {
      verifications++;
      if (verifications === 1) throw new Error('verification response lost');
      if (verifications === 2) return problem(403, { source: 'cloudflare_platform' });
      current.version++; current.latest_operation = { ...current.latest_operation, status: 'verified', version: current.version }; rates.policies.instance.limit = 450;
      return write(current.latest_operation);
    }
    return successfulSettings(call, current, rates, state);
  }); const v = await mountControl(); context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
    context.mock.timers.tick(2000); await flush(); assert.equal(verifications, 2); assert.equal(settingsSave(v.host).props.disabled, true);
    context.mock.timers.tick(5000); await flush();
    const keys = f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path)).map(call => call.key);
    assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 1); assert.match(text(v.host), /Settings saved/);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
  } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('an original-key lookup can confirm a lost apply without replaying it or verifying another operation', async () => {
  const state = {}; let originalKey;
  const f = setup(connection(), (call, current, rates) => {
    if (call.path.endsWith('/configuration/apply')) {
      originalKey = call.key; successfulSettings(call, current, rates, state); throw new Error('committed result lost');
    }
    if (call.path.includes('/configuration/operations/')) { assert.ok(call.path.endsWith(originalKey)); return Response.json(current.latest_operation); }
    return successfulSettings(call, current, rates, state);
  }); const v = await mountControl();
  try {
    change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
    assert.match(text(v.host), /Settings saved/); assert.equal(diff(v.host), undefined); assert.equal(tokenInput(v.host).props.disabled, false);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/apply')).length, 1);
    assert.equal(f.calls.filter(call => /\/operations\/.*\/verify$/.test(call.path)).length, 0);
  } finally { v.app.unmount(); f.restore(); }
});

test('unavailable current rate values retain the draft and block that save until automatic reads recover', async context => {
  let outage = false;
  const f = setup(connection(), call => {
    if (call.path.endsWith('/configuration/plan')) { outage = true; return problem(409); }
    if (outage && call.path.endsWith('/rate-limit-settings')) throw new Error('rate read unavailable');
  }); const v = await mountControl(); context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    change(rateInput(v.host), '450'); await nextTick(); await submit(settingsForm(v.host)); await flush();
    assert.equal(rateInput(v.host).props.value, '450'); assert.equal(rateInput(v.host).props.disabled, true); assert.equal(settingsSave(v.host).props.disabled, true);
    assert.match(text(v.host), /Current request limits are temporarily unavailable/);
    await submit(settingsForm(v.host)); assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/plan')).length, 1);
    outage = false; context.mock.timers.tick(2000); await flush();
    assert.equal(rateInput(v.host).props.value, '450'); assert.equal(settingsSave(v.host).props.disabled, false);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configuration/plan')).length, 1); assert.equal(f.calls.some(call => call.path.endsWith('/apply')), false);
  } finally { v.app.unmount(); context.mock.timers.reset(); f.restore(); }
});

test('Owner routes keep overview read-only and keep usage data below the unified control panel', async () => {
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
