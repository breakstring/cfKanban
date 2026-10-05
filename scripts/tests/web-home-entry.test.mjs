import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, afterEach } from 'node:test';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';

const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), PublicKeyCredential: globalThis.PublicKeyCredential };
const events = new EventTarget();
const documentEvents = new EventTarget();
let navigations = [];
let ceremonies = 0;
class PublicKeyCredential { static parseRequestOptionsFromJSON(value) { return value; } }
globalThis.PublicKeyCredential = PublicKeyCredential;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { get: async () => { ceremonies++; throw new DOMException('Fixture canceled', 'NotAllowedError'); } } } });
globalThis.window = {
  PublicKeyCredential, navigator: { languages: ['en'] },
  location: { pathname: '/', search: '', origin: 'https://kanban.test', hostname: 'kanban.test' },
  history: { pushState(_state, _title, path) { navigations.push(path); }, replaceState(_state, _title, path) { navigations.push(path); } },
  scrollTo() {}, setTimeout, clearTimeout,
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
};
globalThis.document = { cookie: 'cfkanban_csrf=homepage-fixture', visibilityState: 'visible', documentElement: { setAttribute() {} }, addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents) };

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `export { default as PublicHome } from './apps/web/src/views/PublicHomeView.vue'; export { locale } from './apps/web/src/lib/i18n.ts'; export { currentPath } from './apps/web/src/lib/router.ts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', loader: { '.svg': 'dataurl' },
  plugins: [{ name: 'homepage-entry-test', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
      return { contents: compileScript(descriptor, { id: 'homepage-entry-test', inlineTemplate: true }).content, loader: 'ts', resolveDir: dirname(path) };
    });
    builder.onLoad({ filter: /\.(png|jpg|mp4)$/ }, () => ({ contents: 'export default "fixture-asset";', loader: 'js' }));
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL('../../node_modules/vue/index.mjs', import.meta.url).href, external: true }));
  } }],
});
const { PublicHome, locale, currentPath } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function node(tag, text = '') { return { tag, text, children: [], props: {}, parent: null }; }
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; }, setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; },
  insert(target, parent, anchor = null) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, target);
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); },
  parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
});
const all = target => [target, ...target.children.flatMap(all)];
const text = target => target.text + target.children.map(text).join('');
const entry = host => all(host).find(item => item.tag === 'button' && String(item.props.class).includes('home-workbench-entry'));
const apps = new Set();
async function until(check) { for (let step = 0; step < 100; step++) { await new Promise(resolve => setTimeout(resolve, 5)); await nextTick(); if (check()) return; } assert.fail('homepage did not reach the expected state'); }
async function mount() {
  const host = node('root'); const app = renderer.createApp({ setup: () => () => h(PublicHome) });
  app.mount(host); apps.add(app);
  await until(() => entry(host) && !entry(host).props.disabled && !entry(host).props['aria-busy']);
  return { host, app, unmount() { app.unmount(); apps.delete(app); } };
}
function session(path = '/app', source = 'web_authenticator') {
  return { session_id: 'fixture-session', principal: { id: 'fixture-principal', display_name: 'Fixture', is_owner: false, version: 1 }, source: { kind: source, id: 'fixture-source' }, target: { kind: 'project_selection', entry_path: path }, allowed_scope: { kind: 'project_selection', projects: [] }, expires_at: '2099-01-01T00:00:00Z' };
}
function problem(status, category, code) {
  const requestId = '00000000-0000-4000-8000-000000000099';
  return Response.json({ source: 'service', category, code, message: 'Fixture failure', details: {}, recovery: 'sign_in', request_id: requestId, retryable: false }, { status, headers: { 'x-request-id': requestId } });
}
function transport(read) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init.method });
    if (path === '/api/v1/web-session') return read(init);
    if (path === '/api/v1/web-authentication/options') return Response.json({ challenge_id: 'fixture-challenge', public_key: { challenge: 'AA' } });
    if (path.startsWith('/api/v1/public-projects')) return Response.json({ items: [], next_cursor: null });
    if (path === '/.well-known/cfkanban-instance.json') return Response.json({ preferred_api_origin: 'https://kanban.test', instance_id: 'fixture-instance' });
    assert.fail(`Unexpected fixture request: ${path}`);
  };
  return calls;
}
afterEach(() => {
  for (const app of apps) app.unmount(); apps.clear();
  navigations = []; ceremonies = 0; locale.value = 'en'; currentPath.value = '/'; globalThis.fetch = original.fetch;
  globalThis.window.PublicKeyCredential = PublicKeyCredential;
});
after(() => {
  globalThis.window = original.window; globalThis.document = original.document; globalThis.PublicKeyCredential = original.PublicKeyCredential;
  if (original.navigator) Object.defineProperty(globalThis, 'navigator', original.navigator); else delete globalThis.navigator;
});

test('homepage top-right entry reuses either valid Session source and verifies the current scoped entry before navigation', async () => {
  for (const source of ['credential', 'web_authenticator']) {
    let current = session('/app', source);
    const calls = transport(() => Response.json(current));
    const view = await mount();
    assert.equal(text(entry(view.host)), 'Open workbench');
    assert.match(String(entry(view.host).parent.props.class), /public-nav-links/);
    current = session('/app/manage?workspace=fixture-workspace', source);
    await entry(view.host).props.onClick();
    assert.equal(navigations.at(-1), current.target.entry_path);
    assert.equal(calls.filter(call => call.path === '/api/v1/web-session').length, 2);
    assert.equal(calls.some(call => call.method !== 'GET'), false);
    assert.equal(ceremonies, 0);
    view.unmount();
  }
});

test('a valid homepage Session works without Passkey support and uses the current language', async () => {
  delete globalThis.window.PublicKeyCredential;
  locale.value = 'zh-CN';
  transport(() => Response.json(session('/app')));
  const view = await mount();
  assert.equal(text(entry(view.host)), '进入工作台');
  await entry(view.host).props.onClick();
  assert.deepEqual(navigations, ['/app']);
  assert.equal(ceremonies, 0);
});

test('only a verified signed-out response starts Passkey authentication, including an expired Session after loading', async () => {
  let expired = false;
  const calls = transport(() => expired ? problem(401, 'authentication', 'UNAUTHORIZED') : Response.json(session()));
  const view = await mount();
  expired = true;
  await entry(view.host).props.onClick();
  await nextTick();
  assert.equal(text(entry(view.host)), 'Use Passkey');
  assert.equal(calls.filter(call => call.path === '/api/v1/web-authentication/options').length, 1);
  assert.equal(ceremonies, 1);
  assert.deepEqual(navigations, []);
});

test('temporary read failures and invalid entry paths never replace an existing Session with a new sign-in', async () => {
  let failure = false;
  let foreign = false;
  const calls = transport(() => failure ? problem(503, 'platform_failure', 'PLATFORM_UNAVAILABLE') : Response.json(session(foreign ? 'https://evil.test/app' : '/app')));
  const view = await mount();
  failure = true;
  await entry(view.host).props.onClick();
  failure = false; foreign = true;
  await entry(view.host).props.onClick();
  assert.equal(calls.some(call => call.method !== 'GET'), false);
  assert.equal(ceremonies, 0);
  assert.deepEqual(navigations, []);
  assert.ok(all(view.host).some(item => item.props.role === 'alert'));
});

test('focus refreshes the homepage login label and late reads from an unmounted page cannot restore it', async () => {
  let current = session();
  let finish;
  let deferred = false;
  transport(() => deferred ? new Promise(resolve => { finish = resolve; }) : current ? Response.json(current) : problem(401, 'authentication', 'UNAUTHORIZED'));
  const old = await mount();
  deferred = true;
  events.dispatchEvent(new Event('focus'));
  await until(() => finish);
  old.unmount();
  deferred = false; current = null;
  const fresh = await mount();
  finish(Response.json(session('/app/admin')));
  await new Promise(resolve => setTimeout(resolve, 10)); await nextTick();
  assert.equal(text(entry(fresh.host)), 'Use Passkey');
  current = session();
  events.dispatchEvent(new Event('focus'));
  await until(() => text(entry(fresh.host)) === 'Open workbench');
  assert.deepEqual(navigations, []);
});

for (const language of ['en', 'zh-CN']) {
test(`focus Session checks keep the ${language} entry stable and clickable while an explicit click supersedes the background read`, async () => {
  locale.value = language;
  let readCount = 0;
  const waiting = [];
  const calls = transport(init => {
    if (++readCount === 1) return Response.json(session());
    return new Promise(resolve => { waiting.push({ resolve, signal: init.signal }); });
  });
  const view = await mount();
  const button = entry(view.host);
  const label = text(button);
  events.dispatchEvent(new Event('focus'));
  await until(() => waiting.length === 1 && button.props['aria-busy']);
  assert.equal(entry(view.host), button);
  assert.equal(text(button), label);
  assert.equal(button.props.disabled, false, 'a background Session read must not block the entry');
  const opening = button.props.onClick();
  await until(() => waiting.length === 2 && button.props.disabled);
  assert.equal(waiting[0].signal.aborted, true);
  assert.equal(text(button), label, 'the entry keeps its width while the explicit request runs');
  await button.props.onClick();
  assert.equal(readCount, 3, 'the explicit busy fence still prevents duplicate requests');
  waiting[1].resolve(Response.json(session('/app/work')));
  await opening;
  waiting[0].resolve(Response.json(session('/app/admin')));
  await new Promise(resolve => setTimeout(resolve, 10)); await nextTick();
  assert.deepEqual(navigations, ['/app/work']);
  assert.equal(ceremonies, 0);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});
}
