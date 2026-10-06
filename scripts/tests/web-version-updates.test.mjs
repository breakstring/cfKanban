import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";
import { build } from "esbuild";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, ref } from "vue";
import { nuxtUiTestPlugin } from "./nuxt-ui-test-plugin.mjs";

const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const events = new EventTarget();
const invalidations = [];
events.addEventListener("cfkanban:session-invalid", event => invalidations.push(event));
events.addEventListener("cfkanban:authorization-stale", event => invalidations.push(event));
globalThis.window = {
  location: { pathname: "/app/admin/updates", search: "" }, navigator: { languages: ["en"] },
  history: { pushState() {}, replaceState() {} }, scrollTo() {},
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};
globalThis.document = { cookie: "cfkanban_csrf=fixture-csrf", documentElement: { setAttribute() {} } };

const root = fileURLToPath(new URL("../../", import.meta.url));
const actualApiPath = fileURLToPath(new URL("../../apps/web/src/lib/api.ts", import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Panel } from './apps/web/src/components/VersionUpdatesPanel.vue'; export { locale } from './apps/web/src/lib/i18n.ts'; export { navigate, currentPath } from './apps/web/src/lib/router.ts'; export { observedRequests } from 'version-updates-observed-api';`, resolveDir: root },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  plugins: [nuxtUiTestPlugin(), { name: "version-updates-component", setup(builder) {
    builder.onResolve({ filter: /^version-updates-observed-api$/ }, () => ({ path: "observed-api", namespace: "version-updates-fixture" }));
    builder.onResolve({ filter: /^\.\.\/lib\/api$/ }, args => args.importer.endsWith("VersionUpdatesPanel.vue")
      ? { path: "observed-api", namespace: "version-updates-fixture" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "version-updates-fixture" }, () => ({
      contents: `import { apiRequest as actualRequest } from ${JSON.stringify(actualApiPath)};
        export * from ${JSON.stringify(actualApiPath)};
        export const observedRequests = [];
        export function apiRequest(path, options = {}) { const entry = { path, options }; observedRequests.push(entry); return entry.result = actualRequest(path, options); }`,
      loader: "js", resolveDir: root,
    }));
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
      return { contents: compileScript(descriptor, { id: "version-updates-component", inlineTemplate: true }).content, loader: "ts", resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true }));
  } }],
});
const { Panel, locale, navigate, currentPath, observedRequests } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);

function node(tag, text = "") {
  return { tag, text, children: [], props: {}, parent: null, checked: false,
    addEventListener() {}, removeEventListener() {}, get tagName() { return this.tag.toUpperCase(); } };
}
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; if (key === "type" || key === "value") target[key] = value; },
  insert(target, parent, anchor = null) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent;
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, target);
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); },
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insertStaticContent(text, parent, anchor) {
    const target = node("#static", text); target.parent = parent;
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, target); return [target, target];
  },
});
const all = target => [target, ...target.children.flatMap(all)];
const text = target => target.text + target.children.map(text).join("");
const button = (host, label) => all(host).find(item => item.tag === "button" && text(item) === label);
const checkbox = host => all(host).find(item => item.tag === "input" && item.props.type === "checkbox");
const settingsPath = "/api/v1/admin/upgrade-notification-settings";
const updatesPath = "/api/v1/admin/release-updates";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const json = value => Response.json(value);
const write = resource => json({ resource, event_cursor: "fixture-event", idempotent_replay: false });
function problem(status, category, code) {
  const id = "00000000-0000-4000-8000-000000000099";
  return Response.json({ source: "service", category, code, message: "Fixture failure", details: {}, recovery: "refresh_resource", request_id: id, retryable: false }, { status, headers: { "x-request-id": id } });
}
function session(identity = "a", owner = true, scope = "instance") {
  return { session_id: `session-${identity}`, principal: { id: `principal-${identity}`, display_name: "Fixture", is_owner: owner, version: 1 },
    allowed_scope: { kind: scope }, expires_at: "2099-01-01T00:00:00Z", source: { id: `source-${identity}`, kind: "credential" }, target: { kind: "admin" } };
}
function updates(version = "1.9.4") {
  const channel = { status: "fresh", checked_at: "2026-10-06T00:00:00Z", last_attempt_at: "2026-10-06T00:00:00Z", retry_at: "2026-10-06T00:15:00Z", error: null, releases: [] };
  return { current_version: version, stable: channel, prereleases: { ...channel }, prerelease_window: 20 };
}
function transport(handle) {
  const calls = [];
  globalThis.fetch = (path, init) => {
    const call = { path, method: init.method, body: init.body === undefined ? null : JSON.parse(init.body), key: new Headers(init.headers).get("idempotency-key") };
    calls.push(call);
    assert.ok(path === updatesPath || path === settingsPath, `Unexpected fixture request: ${path}`);
    return Promise.resolve(handle(call));
  };
  return calls;
}
async function until(check) {
  for (let step = 0; step < 100; step++) { await new Promise(done => setTimeout(done, 5)); await nextTick(); if (check()) return; }
  assert.fail("version updates component did not reach the expected state");
}
const apps = new Set();
function mount(initialSession = session()) {
  const state = ref(initialSession), host = node("root");
  const app = renderer.createApp({ setup: () => () => h(Panel, { session: state.value }) });
  app.mount(host); apps.add(app);
  return { state, host, unmount() { app.unmount(); apps.delete(app); } };
}
async function choose(host, value) { checkbox(host).props["onUpdate:modelValue"](value); await nextTick(); }
const loaded = host => checkbox(host) && !checkbox(host).props.disabled;
afterEach(() => {
  for (const app of apps) app.unmount(); apps.clear();
  invalidations.length = 0; observedRequests.length = 0; locale.value = "en";
  currentPath.value = "/app/admin/updates"; globalThis.fetch = original.fetch;
});
after(() => { globalThis.window = original.window; globalThis.document = original.document; });

test("only instance Owner can load the panel; settings start off without a write", async () => {
  const calls = transport(call => json(call.path === updatesPath ? updates() : { enabled: false, version: 1 }));
  for (const identity of [session("reader", false), session("narrow", true, "project")]) {
    const view = mount(identity); await nextTick(); assert.equal(calls.length, 0); assert.equal(checkbox(view.host), undefined); view.unmount();
  }
  const view = mount(); await until(() => loaded(view.host));
  assert.equal(checkbox(view.host).checked, false);
  assert.equal(button(view.host, "Save setting").props.disabled, true);
  assert.deepEqual(calls.map(call => call.method), ["GET", "GET"]);
  locale.value = "zh-CN"; await nextTick();
  assert.ok(button(view.host, "保存设置")); assert.match(text(view.host), /版本与更新/);
});

test("save waits for verified readback and blocks repeated writes while pending", async () => {
  const patch = deferred(), readback = deferred(); let reads = 0;
  const calls = transport(call => call.path === updatesPath ? json(updates()) : call.method === "PATCH" ? patch.promise
    : ++reads === 1 ? json({ enabled: false, version: 1 }) : readback.promise);
  const view = mount(); await until(() => loaded(view.host)); await choose(view.host, true);
  const saving = button(view.host, "Save setting").props.onClick(); await nextTick();
  void button(view.host, "Save setting").props.onClick(); await nextTick();
  assert.equal(calls.filter(call => call.method === "PATCH").length, 1);
  assert.deepEqual(calls.find(call => call.method === "PATCH").body, { enabled: true, expected_version: 1 });
  assert.ok(observedRequests.find(call => call.options.method === "PATCH").options.idempotencyScope.includes("principal-a"));
  assert.equal(checkbox(view.host).props.disabled, true);
  patch.resolve(write({ enabled: true, version: 2 })); await until(() => reads === 2);
  assert.doesNotMatch(text(view.host), /Setting saved and verified/);
  readback.resolve(json({ enabled: true, version: 2 })); await saving; await nextTick();
  assert.match(text(view.host), /Setting saved and verified/); assert.equal(checkbox(view.host).checked, true);
  assert.equal(button(view.host, "Save setting").props.disabled, true);
});

test("refresh locks editing and save so an older in-flight settings read cannot overwrite a concurrent write", async () => {
  const refresh = deferred(); let reads = 0;
  const calls = transport(call => call.path === updatesPath ? json(updates()) : ++reads === 1
    ? json({ enabled: false, version: 1 }) : refresh.promise);
  const view = mount(); await until(() => loaded(view.host)); await choose(view.host, true);
  const refreshing = button(view.host, "Check again").props.onClick(); await nextTick();
  assert.equal(checkbox(view.host).props.disabled, true); assert.equal(button(view.host, "Save setting").props.disabled, true);
  void button(view.host, "Save setting").props.onClick(); void button(view.host, "Check again").props.onClick(); await nextTick();
  assert.equal(calls.some(call => call.method === "PATCH"), false); assert.equal(reads, 2);
  refresh.resolve(json({ enabled: false, version: 2 })); await refreshing; await nextTick();
  assert.equal(checkbox(view.host).checked, false); assert.equal(checkbox(view.host).props.disabled, false);
});

test("an uncertain save preserves the original request and key, blocks navigation and recovers through readback", async () => {
  let attempts = 0, current = { enabled: false, version: 1 };
  const calls = transport(call => {
    if (call.path === updatesPath) return json(updates());
    if (call.method === "GET") return json(current);
    if (++attempts === 1) throw new Error("fixture connection lost");
    current = { enabled: true, version: 2 }; return write(current);
  });
  const view = mount(); await until(() => loaded(view.host)); await choose(view.host, true);
  await button(view.host, "Save setting").props.onClick(); await nextTick();
  assert.ok(button(view.host, "Recover original save")); assert.equal(checkbox(view.host).props.disabled, true);
  assert.equal(button(view.host, "Check again").props.disabled, true); assert.equal(navigate("/app/work"), false);
  await button(view.host, "Recover original save").props.onClick(); await nextTick();
  const writes = calls.filter(call => call.method === "PATCH");
  assert.equal(writes.length, 2); assert.ok(writes[0].key); assert.equal(writes[0].key, writes[1].key);
  assert.deepEqual(writes[0].body, writes[1].body); assert.match(text(view.host), /Setting saved and verified/);
  assert.equal(navigate("/app/work"), true);
});

test("old identity reads cannot overwrite the next identity or emit a late Session invalidation", async () => {
  const oldUpdates = deferred(), oldSettings = deferred(); let reads = 0;
  transport(call => ++reads <= 2 ? (call.path === updatesPath ? oldUpdates.promise : oldSettings.promise)
    : json(call.path === updatesPath ? updates("2.0.0") : { enabled: true, version: 9 }));
  const view = mount(); const oldRequests = observedRequests.slice();
  view.state.value = session("b"); await until(() => loaded(view.host));
  assert.ok(oldRequests.every(call => call.options.authorizationCurrent() === false));
  oldUpdates.resolve(json(updates("1.0.0"))); oldSettings.resolve(problem(401, "authentication", "UNAUTHORIZED"));
  await Promise.allSettled(oldRequests.map(call => call.result)); await nextTick();
  assert.match(text(view.host), /2\.0\.0/); assert.doesNotMatch(text(view.host), /1\.0\.0/);
  assert.equal(checkbox(view.host).checked, true); assert.equal(invalidations.length, 0);
  assert.equal(all(view.host).some(item => item.props.role === "alert"), false);
});

for (const phase of ["write", "readback"]) {
  test(`old identity ${phase} completion cannot change a new identity's settings`, async () => {
    const late = deferred(); let identity = "a", settingsReads = 0;
    const calls = transport(call => {
      if (call.path === updatesPath) return json(updates(identity === "a" ? "1.9.4" : "2.0.0"));
      if (call.method === "PATCH") return phase === "write" ? late.promise : write({ enabled: true, version: 2 });
      if (identity === "b") return json({ enabled: false, version: 9 });
      return ++settingsReads === 1 ? json({ enabled: false, version: 1 }) : late.promise;
    });
    const view = mount(); await until(() => loaded(view.host)); await choose(view.host, true);
    const saving = button(view.host, "Save setting").props.onClick();
    await until(() => phase === "write" ? calls.some(call => call.method === "PATCH") : settingsReads === 2);
    const oldRequest = observedRequests.at(-1);
    identity = "b"; view.state.value = session("b"); await until(() => loaded(view.host));
    assert.equal(oldRequest.options.authorizationCurrent(), false);
    late.resolve(phase === "write" ? write({ enabled: true, version: 2 }) : json({ enabled: true, version: 2 }));
    await saving; await nextTick();
    assert.equal(checkbox(view.host).checked, false); assert.match(text(view.host), /2\.0\.0/);
    assert.doesNotMatch(text(view.host), /Setting saved and verified/);
    assert.equal(settingsReads, phase === "write" ? 1 : 2, "a late write must not start a readback under the next identity");
  });
}

test("a conflicting save reads current CAS facts and keeps the draft without replaying; mismatched readback never claims success", async () => {
  let attempts = 0, current = { enabled: false, version: 1 };
  const calls = transport(call => {
    if (call.path === updatesPath) return json(updates());
    if (call.method === "GET") return json(current);
    if (++attempts === 1) { current = { enabled: false, version: 2 }; return problem(409, "conflict", "VERSION_CONFLICT"); }
    current = { enabled: false, version: 4 }; return write({ enabled: true, version: 3 });
  });
  const view = mount(); await until(() => loaded(view.host)); await choose(view.host, true);
  await button(view.host, "Save setting").props.onClick(); await nextTick();
  assert.equal(attempts, 1); assert.equal(checkbox(view.host).checked, true); assert.equal(button(view.host, "Save setting").props.disabled, false);
  await button(view.host, "Save setting").props.onClick(); await nextTick();
  assert.deepEqual(calls.filter(call => call.method === "PATCH").map(call => call.body.expected_version), [1, 2]);
  assert.equal(checkbox(view.host).checked, false); assert.doesNotMatch(text(view.host), /Setting saved and verified/);
  assert.match(text(view.host), /setting changed again/i);
});
