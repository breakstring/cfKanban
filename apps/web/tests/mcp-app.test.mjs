import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { compileScript, compileTemplate, parse as parseVue } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";
import { buildMcpAppDocument } from "../scripts/build-mcp-app.mjs";
import { assertEmbeddedHtml } from "../scripts/build-embedded.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "cfkanban-mcp-app-test-"));
const moduleFile = path.join(temporary, "client.mjs");
await build({ stdin: { contents: 'export * from "./src/mcp-app/client.ts"; export { emptySnapshot } from "./src/embedded/protocol.ts";', resolveDir: webRoot, loader: "ts" }, outfile: moduleFile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { createMcpAppClient, applyHostContext, emptySnapshot, MCP_APP_PROTOCOL } = await import(pathToFileURL(moduleFile));
const workbenchModule = path.join(temporary, "workbench.mjs");
await build({
  stdin: { contents: 'export { default as Workbench } from "./src/embedded/Workbench.vue"; export { workbenchClientFactory } from "./src/mcp-app/provider.ts";', resolveDir: webRoot, loader: "ts" },
  outfile: workbenchModule, bundle: true, platform: "node", format: "esm", logLevel: "silent", loader: { ".png": "empty", ".svg": "dataurl" },
  plugins: [{ name: "mcp-app-workbench-test", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      if (!filename.endsWith("/embedded/Workbench.vue")) return { contents: "export default { inheritAttrs: false, render() { return this.$slots.default?.(); } }", loader: "js" };
      const { descriptor } = parseVue(await readFile(filename, "utf8"), { filename });
      const script = compileScript(descriptor, { id: "mcp-app-workbench-test" });
      const template = compileTemplate({ source: descriptor.template.content, filename, id: "mcp-app-workbench-test", compilerOptions: { bindingMetadata: script.bindings } });
      assert.deepEqual(template.errors, []);
      return { contents: `${script.content.replace("export default", "const Workbench =")}\n${template.code}\nWorkbench.render = render; export default Workbench;`, loader: "ts", resolveDir: path.dirname(filename) };
    });
    builder.onResolve({ filter: /^@nuxt\/ui\/locale$/ }, () => ({ path: "locale", namespace: "mcp-app-workbench-test" }));
    builder.onLoad({ filter: /.*/, namespace: "mcp-app-workbench-test" }, () => ({ contents: "export const en = {}; export const zh_cn = {};", loader: "js" }));
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(path.join(webRoot, "../../node_modules/vue/index.mjs")).href, external: true }));
  } }],
});
const { Workbench, workbenchClientFactory } = await import(pathToFileURL(workbenchModule));
after(() => rm(temporary, { recursive: true, force: true }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const version = "1.9.1";
const viewId = () => randomUUID();
const tool = (state = emptySnapshot(), meta = {}, result = {}) => ({ content: [], structuredContent: { ok: true, protocol: 1, version, ...result }, _meta: { "cfkanban/snapshot": { type: "snapshot", state }, ...meta } });
function fixture(options = {}) {
  const sent = [], errors = [], snapshots = [], locales = [];
  const listeners = new Map();
  const parent = { postMessage(message, origin) { assert.equal(origin, "*"); sent.push(message); } };
  const window = {
    parent, navigator: options.navigator, addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(message, source = parent) { for (const listener of listeners.get("message") ?? []) listener({ data: message, source }); },
    hide() { for (const listener of listeners.get("pagehide") ?? []) listener(); },
  };
  const client = createMcpAppClient({ window, version, timeoutMs: 100, onConnect: value => locales.push(value), onSnapshot: value => snapshots.push(value), onError: value => errors.push(value), ...options });
  const response = (request, result) => window.emit({ jsonrpc: "2.0", id: request.id, result });
  const notify = (method, params) => window.emit({ jsonrpc: "2.0", method, params });
  const initialize = () => response(sent[0], { protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: "test-host", version: "1" }, hostCapabilities: {}, hostContext: { locale: "zh-CN", theme: "dark", displayMode: "inline" } });
  return { client, window, listeners, sent, errors, snapshots, locales, response, notify, initialize, close: () => client.dispose() };
}
async function connected(options = {}) {
  const f = fixture(options);
  f.initialize();
  await tick();
  f.notify("ui/notifications/tool-result", tool(emptySnapshot(), { "cfkanban/viewId": viewId() }));
  assert.equal(f.client.connected, true);
  return f;
}
function node(type, text = "") { return { type, text, props: {}, children: [], parent: null }; }
const renderer = createRenderer({ createElement: node, createText: text => node("#text", text), createComment: text => node("#comment", text), setText(target, text) { target.text = text; }, setElementText(target, text) { target.text = text; }, patchProp(target, name, previous, value) { target.props[name] = value; }, insert(target, parent, anchor) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, target); }, remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = null; }, parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null });
async function mountedWorkbench({ render = false, ready = true } = {}) {
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = {};
  globalThis.document = { documentElement: { lang: "en", dataset: {}, toggleAttribute() {} }, getElementById() { return null; } };
  const calls = [], resolvers = [];
  let callbacks;
  const root = node("root");
  const app = renderer.createApp({ render: () => h(render ? Workbench : { ...Workbench, render: () => null }) });
  app.provide(workbenchClientFactory, options => {
    callbacks = options;
    if (ready) options.onConnect("en");
    return { connected: true, action: (action, payload) => { calls.push({ action, payload }); return new Promise(resolve => resolvers.push(resolve)); }, dispose() {} };
  });
  app.mount(root);
  const vm = app._instance.subTree.component.setupState;
  if (!render) vm.state = { ...emptySnapshot(), binding: { project: { id: randomUUID() }, statuses: ["backlog", "todo", "in_progress", "done", "canceled"].map(key => ({ key })) }, capabilities: { create: true, update: true, comment: true, complete: true } };
  await nextTick();
  return { vm, calls, root, connect: () => callbacks.onConnect("en"), error: code => callbacks.onError(code), snapshot: state => callbacks.onSnapshot(state), respond: result => resolvers.shift()(result), close() { app.unmount(); Object.assign(globalThis, saved); } };
}

test("a failed host handshake renders its diagnostic without a false no-connections empty state", async () => {
  const f = await mountedWorkbench({ render: true, ready: false });
  const text = target => [target.type === "#comment" ? "" : target.text, ...target.children.map(text)].join(" ");
  try {
    assert.match(text(f.root), /Waiting for the host/);
    f.error("MCP_APP_HOST_INIT_TIMEOUT");
    await nextTick();
    assert.equal(f.vm.connected, false);
    assert.match(text(f.root), /MCP_APP_HOST_INIT_TIMEOUT/);
    assert.ok(!/Waiting for the host|No validated connections/.test(text(f.root)));
  } finally { f.close(); }
  const valid = await mountedWorkbench({ render: true });
  try { assert.match(text(valid.root), /No validated connections/); } finally { valid.close(); }
});

test("injected workbench creation and editing keep drafts until matching confirmed success", async () => {
  const f = await mountedWorkbench();
  try {
    f.vm.openEditor("create");
    f.vm.editorDraft.title = "New title";
    f.vm.editorDraft.body = "# New Markdown";
    let save = f.vm.saveEditor();
    assert.deepEqual(f.calls.at(-1), { action: "create_issue", payload: { change: { title: "New title", body: "# New Markdown", status_key: "backlog", priority_key: "none" } } });
    f.respond({ ok: false, error: { code: "VERSION_CONFLICT" } }); await save;
    assert.equal(f.vm.showEditor, true);
    assert.equal(f.vm.editorDraft.title, "New title");
    f.vm.showEditor = false; f.vm.openEditor("create");
    assert.equal(f.vm.editorDraft.body, "# New Markdown");
    save = f.vm.saveEditor();
    const issue = { identifier: "CFK-600", title: "New title", body: "# New Markdown", version: 1, status: { key: "backlog" }, priority: "none" };
    f.snapshot({ ...f.vm.state, issue });
    f.respond({ ok: true }); await save;
    assert.equal(f.vm.showEditor, false);
    f.vm.openEditor("create");
    assert.equal(f.vm.editorDraft.title, "");
    f.vm.showEditor = false;
    f.vm.openEditor("edit");
    assert.equal(f.vm.editorDraft.title, issue.title);
    assert.equal(f.vm.editorDraft.body, issue.body);
    f.vm.editorDraft.title = "Edited title";
    f.vm.editorDraft.body = "中文正文";
    save = f.vm.saveEditor();
    assert.deepEqual(f.calls.at(-1), { action: "mutate", payload: { operation: "update", change: { title: "Edited title", body: "中文正文" } } });
    f.snapshot({ ...f.vm.state, pending: { operation: "update", identifier: issue.identifier, expected_version: 1 } });
    f.respond({ ok: false, error: { code: "EMBED_REQUEST_UNCERTAIN" }, outcome_unknown: true }); await save;
    assert.equal(f.vm.showEditor, true);
    const count = f.calls.length;
    await f.vm.saveEditor();
    assert.equal(f.calls.length, count);
    const recovery = f.vm.recover();
    f.snapshot({ ...f.vm.state, pending: null, issue: { ...issue, version: 2, title: "Edited title", body: "中文正文" } });
    f.respond({ ok: true }); await recovery;
    assert.equal(f.vm.showEditor, false);
  } finally { f.close(); }
});

test("drafts remain scoped and readonly identities or oversized UTF8 bodies cannot submit", async () => {
  const f = await mountedWorkbench();
  try {
    f.vm.state.capabilities.create = false;
    f.vm.openEditor("create");
    assert.equal(f.vm.showEditor, false);
    f.vm.state.capabilities.create = true;
    f.vm.openEditor("create");
    f.vm.editorDraft.title = "Saved draft";
    f.vm.editorDraft.body = "中".repeat(22_000);
    await f.vm.saveEditor();
    assert.equal(f.calls.length, 0);
    f.vm.editorDraft.body = "Scoped draft";
    const firstProject = f.vm.state.binding.project.id;
    f.vm.showEditor = false;
    f.vm.state.binding.project.id = randomUUID();
    f.vm.openEditor("create");
    assert.equal(f.vm.editorDraft.title, "");
    f.vm.showEditor = false;
    f.vm.state.binding.project.id = firstProject;
    f.vm.openEditor("create");
    assert.equal(f.vm.editorDraft.title, "Saved draft");
    assert.equal(f.vm.editorDraft.body, "Scoped draft");
  } finally { f.close(); }
});

test("a missing server view reference keeps its diagnostic when action admission closes", async () => {
  const f = await connected();
  try {
    const operation = f.client.action("manual", {});
    f.response(f.sent.at(-1), { content: [], structuredContent: { ok: false, protocol: 1, version, error: { code: "MCP_APP_VIEW_ID_MISSING" } } });
    assert.equal((await operation).error.code, "MCP_APP_REOPEN_REQUIRED");
    assert.deepEqual(f.errors, ["MCP_APP_VIEW_ID_MISSING"]);
    assert.equal(f.client.connected, false);
  } finally { f.close(); }
  const ui = await mountedWorkbench();
  try {
    const operation = ui.vm.send("manual", {});
    ui.error("MCP_APP_VIEW_ID_MISSING");
    ui.respond({ ok: false, error: { code: "MCP_APP_REOPEN_REQUIRED" } });
    await operation;
    assert.equal(ui.vm.connected, false);
    assert.equal(ui.vm.localError, "MCP_APP_VIEW_ID_MISSING");
  } finally { ui.close(); }
});

test("MCP Apps initializes before tools/call and accepts the initial tool result in either order", async () => {
  for (const early of [true, false]) {
    const f = fixture();
    try {
      const initial = tool(emptySnapshot(), { "cfkanban/viewId": viewId() });
      assert.deepEqual(f.sent[0].params, { appInfo: { name: "cfKanban", version }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }, protocolVersion: MCP_APP_PROTOCOL });
      assert.equal((await f.client.action("manual", {})).error.code, "MCP_APP_REOPEN_REQUIRED");
      if (early) f.notify("ui/notifications/tool-result", initial);
      assert.equal(f.client.connected, false);
      assert.equal(f.sent.length, 1);
      f.initialize();
      await tick();
      if (!early) f.notify("ui/notifications/tool-result", initial);
      assert.equal(f.client.connected, true);
      assert.deepEqual(f.locales, ["zh-CN"]);
      assert.equal(f.sent[1].method, "ui/notifications/initialized");
      const operation = f.client.action("view", { mode: "list" });
      const request = f.sent.at(-1);
      assert.equal(request.method, "tools/call");
      assert.equal(request.params.name, "cfkanban_workbench_action");
      assert.equal(request.params.arguments.view_id, initial._meta["cfkanban/viewId"]);
      assert.deepEqual(request.params.arguments.message.payload, { mode: "list" });
      assert.equal(request.params._meta, undefined);
      f.response(request, tool({ ...emptySnapshot(), view: "list" }));
      assert.deepEqual(await operation, { ok: true });
      assert.equal(f.snapshots.at(-1).view, "list");
      assert.ok(!JSON.stringify(f.snapshots).includes(initial._meta["cfkanban/viewId"]));
    } finally { f.close(); }
  }
});

test("saved locale wins after connection in either initial-result order, while host changes remain a fallback", async () => {
  for (const early of [true, false]) for (const savedLocale of ["en", "zh-CN"]) {
    const events = [];
    let hostLocale = "en", profileLocale;
    let effectiveLocale;
    const f = fixture({
      onConnect(locale) { events.push("connect"); hostLocale = locale; effectiveLocale = profileLocale ?? hostLocale; },
      onSnapshot(snapshot) { events.push("snapshot"); profileLocale = snapshot.locale; effectiveLocale = profileLocale ?? hostLocale; },
    });
    try {
      const initial = tool({ ...emptySnapshot(), locale: savedLocale }, { "cfkanban/viewId": viewId() });
      if (early) f.notify("ui/notifications/tool-result", initial);
      f.response(f.sent[0], { protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: "host", version: "1" }, hostCapabilities: {}, hostContext: { locale: savedLocale === "en" ? "zh-CN" : "en" } });
      await tick();
      if (!early) f.notify("ui/notifications/tool-result", initial);
      assert.deepEqual(events, ["connect", "snapshot"]);
      assert.equal(effectiveLocale, savedLocale);
      f.notify("ui/notifications/host-context-changed", { locale: "zh_TW" });
      assert.equal(hostLocale, "zh-CN");
      assert.equal(effectiveLocale, savedLocale);
      const operation = f.client.action("manual", {});
      f.response(f.sent.at(-1), tool(emptySnapshot()));
      await operation;
      assert.equal(effectiveLocale, "zh-CN", "cleared preference uses the latest host language");
      f.notify("ui/notifications/host-context-changed", { locale: "fr" });
      assert.equal(effectiveLocale, "en");
      assert.ok(!f.sent.some(row => row.params?.arguments?.message?.action === "set_locale"));
    } finally { f.close(); }
  }
});

test("missing or empty host locale uses the browser primary language, with English for other or unknown languages", async () => {
  for (const hostLocale of [undefined, "", " "]) for (const [navigator, expected] of [
    [{ languages: ["zh-HK", "en"] }, "zh-CN"],
    [{ languages: [], language: "zh_CN" }, "zh-CN"],
    [{ languages: ["fr", "zh-CN"] }, "en"],
    [undefined, "en"],
  ]) {
    const f = fixture({ navigator });
    try {
      f.response(f.sent[0], { protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: "host", version: "1" }, hostCapabilities: {}, hostContext: hostLocale === undefined ? {} : { locale: hostLocale } });
      await tick();
      f.notify("ui/notifications/tool-result", tool(emptySnapshot(), { "cfkanban/viewId": viewId() }));
      assert.deepEqual(f.locales, [expected]);
    } finally { f.close(); }
  }
});

test("only parent messages with the matching id and valid JSON-RPC initialize the view", async () => {
  const f = fixture();
  try {
    const result = { protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: "host", version: "1" }, hostCapabilities: {} };
    f.window.emit({ jsonrpc: "2.0", id: f.sent[0].id, result }, {});
    f.window.emit({ jsonrpc: "2.0", id: randomUUID(), result });
    f.window.emit({ jsonrpc: "2.0", id: f.sent[0].id, result, error: { code: 1, message: "ignored" } });
    f.window.emit({ jsonrpc: "2.0", id: f.sent[0].id, result, injected: true });
    await tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.locales.length, 0);
    f.initialize(); await tick();
    f.notify("ui/notifications/tool-result", { result: tool(emptySnapshot(), { "cfkanban/viewId": viewId() }) });
    assert.deepEqual(f.errors, ["MCP_APP_INITIAL_RESULT_INVALID"]);
    assert.equal(f.client.connected, false);
  } finally { f.close(); }
});

test("same-viewId notification refreshes only; a replacement viewId closes admission", async () => {
  const f = fixture();
  try {
    const initial = tool(emptySnapshot(), { "cfkanban/viewId": viewId() });
    f.notify("ui/notifications/tool-result", initial);
    f.notify("ui/notifications/tool-result", initial);
    f.initialize(); await tick();
    assert.equal(f.client.connected, true);
    f.notify("ui/notifications/tool-result", initial);
    assert.equal(f.sent.at(-1).params.name, "cfkanban_workbench_snapshot");
    f.response(f.sent.at(-1), tool());
    await tick();
    assert.equal(f.locales.length, 1);
    f.notify("ui/notifications/tool-result", tool(emptySnapshot(), { "cfkanban/viewId": viewId() }));
    assert.equal(f.client.connected, false);
    const count = f.sent.length;
    assert.equal((await f.client.action("mutate", { operation: "comment", change: { body: "draft" } })).error.code, "MCP_APP_REOPEN_REQUIRED");
    assert.equal(f.sent.length, count);
  } finally { f.close(); }
});

test("optional undefined values cannot hide oversized host message keys from the byte limit", async () => {
  const f = fixture();
  try {
    f.response(f.sent[0], { protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: "host", version: "1" }, hostCapabilities: {}, hostContext: { styles: { variables: { ["x".repeat(2_200_000)]: undefined } } } });
    await tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.locales.length, 0);
    f.initialize(); await tick();
    f.notify("ui/notifications/tool-result", tool(emptySnapshot(), { "cfkanban/viewId": viewId() }));
    assert.equal(f.client.connected, true);
  } finally { f.close(); }
});

test("legal host initialization extensions and later tool notifications retain the admitted viewId", async () => {
  const f = fixture();
  try {
    f.response(f.sent[0], { protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: "host", version: "1", title: "Desktop Host", description: "Test", icons: [], websiteUrl: "https://example.com" }, hostCapabilities: {}, hostContext: { locale: "en", styles: { variables: { "--font-sans": undefined, "--color-background-primary": undefined } } }, futureHostCapability: { enabled: true } });
    await tick();
    f.notify("ui/notifications/tool-result", tool(emptySnapshot(), { "cfkanban/viewId": viewId() }));
    assert.equal(f.client.connected, true);
    const count = f.sent.length;
    f.notify("ui/notifications/tool-result", tool({ ...emptySnapshot(), view: "board" }));
    f.notify("ui/notifications/tool-result", { content: [{ type: "text", text: "unrelated" }] });
    assert.equal(f.client.connected, true);
    assert.equal(f.sent.length, count);
    assert.equal(f.snapshots.at(-1).view, "board");
    assert.equal(f.errors.length, 0);
  } finally { f.close(); }
});

test("snapshot metadata uses the shared privacy parser and failed versions cannot populate UI", async () => {
  const f = await connected();
  try {
    let operation = f.client.action("manual", {});
    f.response(f.sent.at(-1), tool({ ...emptySnapshot(), credential: "private-marker" }));
    assert.equal((await operation).ok, false);
    assert.ok(!JSON.stringify(f.snapshots).includes("private-marker"));
    operation = f.client.action("manual", {});
    f.response(f.sent.at(-1), tool({ ...emptySnapshot(), busy: 2 }, {}, { version: "0.0.1" }));
    assert.equal((await operation).ok, false);
    assert.equal(f.snapshots.at(-1).busy, 0);
    operation = f.client.action("manual", {});
    f.response(f.sent.at(-1), { content: [], structuredContent: { ok: false, protocol: 1, version, error: { code: "MCP_APP_VIEW_EXPIRED" } } });
    assert.equal((await operation).error.code, "MCP_APP_REOPEN_REQUIRED");
    assert.equal(f.client.connected, false);
  } finally { f.close(); }
});

test("a timed-out write is not resent; next interaction reads snapshot and recover uses the original host operation", async () => {
  const f = await connected({ timeoutMs: 15 });
  try {
    const operation = f.client.action("mutate", { operation: "comment", change: { body: "draft" } });
    const original = f.sent.at(-1);
    assert.equal((await operation).outcome_unknown, true);
    assert.equal(f.sent.at(-1).method, "notifications/cancelled");
    let next = f.client.action("mutate", { operation: "comment", change: { body: "draft" } });
    assert.equal(f.sent.at(-1).params.name, "cfkanban_workbench_snapshot");
    const pendingState = { ...emptySnapshot(), pending: { operation: "comment", identifier: "CFK-600", expected_version: 1, idempotency_key: randomUUID() } };
    f.response(f.sent.at(-1), tool(pendingState));
    assert.equal((await next).outcome_unknown, true);
    assert.equal(f.sent.filter(value => value.params?.name === "cfkanban_workbench_action").length, 1);
    // 迟到的旧结果不能清除宿主已确认的 pending。
    f.response(original, tool());
    next = f.client.action("recover", {});
    f.response(f.sent.at(-1), tool(pendingState));
    await tick();
    const recovery = f.sent.at(-1);
    assert.equal(recovery.params.arguments.message.action, "recover");
    assert.deepEqual(recovery.params.arguments.message.payload, {});
    f.response(recovery, tool());
    assert.deepEqual(await next, { ok: true });
  } finally { f.close(); }
});

test("late known action receipts unlock the original create without issuing a second create", async () => {
  const settled = [];
  const f = await connected({ timeoutMs: 15, onActionSettled: (message, result) => settled.push({ message, result }) });
  try {
    const payload = { change: { title: "One Issue", body: "One original request" } };
    const operation = f.client.action("create_issue", payload);
    const original = f.sent.at(-1).params.arguments.message;
    assert.equal((await operation).outcome_unknown, true);
    for (const receipt of [{ id: original.id, result: null }, { id: randomUUID(), result: { ok: true } }, { id: original.id, result: { ok: false, outcome_unknown: true, error: { code: "PANEL_REQUEST_UNCERTAIN" } } }]) {
      const next = f.client.action("create_issue", payload);
      const request = f.sent.at(-1);
      assert.equal(request.params.name, "cfkanban_workbench_snapshot");
      assert.equal(request.params.arguments.action_id, original.id);
      f.response(request, tool(emptySnapshot(), { "cfkanban/actionReceipt": receipt }));
      assert.equal((await next).outcome_unknown, true);
      assert.equal(settled.length, 0);
    }
    const next = f.client.action("create_issue", payload);
    const issue = { identifier: "CFK-600", title: payload.change.title, body: payload.change.body, version: 1, status: { key: "backlog" }, priority: "none" };
    f.response(f.sent.at(-1), tool({ ...emptySnapshot(), issue }, { "cfkanban/actionReceipt": { id: original.id, result: { ok: true } } }));
    assert.equal((await next).error.code, "MCP_APP_ACTION_SYNCED");
    assert.deepEqual(settled, [{ message: original, result: { ok: true } }]);
    assert.equal(f.sent.filter(value => value.params?.name === "cfkanban_workbench_action").length, 1);
  } finally { f.close(); }
});

test("unknown writes synchronize only bounded local snapshots, then require reopening if still busy", async t => {
  const f = await connected({ timeoutMs: 15 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const operation = f.client.action("create_issue", { change: { title: "Waiting" } });
    const original = f.sent.at(-1).params.arguments.message;
    t.mock.timers.tick(15); await tick();
    assert.equal((await operation).outcome_unknown, true);
    for (let index = 0; index < 10; index++) {
      t.mock.timers.tick(index >= 8 ? 1000 : 250); await tick();
      const request = f.sent.at(-1);
      assert.equal(request.params.name, "cfkanban_workbench_snapshot");
      assert.equal(request.params.arguments.action_id, original.id);
      f.response(request, tool({ ...emptySnapshot(), busy: 1 }, { "cfkanban/actionReceipt": { id: original.id, result: null } }));
      await tick();
    }
    assert.equal(f.client.connected, false);
    assert.ok(f.errors.includes("MCP_APP_REOPEN_REQUIRED"));
    const count = f.sent.length;
    t.mock.timers.tick(100_000); await tick();
    assert.equal(f.sent.length, count);
    assert.equal(f.sent.filter(value => value.params?.name === "cfkanban_workbench_action").length, 1);
  } finally { f.close(); t.mock.timers.reset(); }
});

test("initialization failures report the failed phase without announcing a connection", async () => {
  for (const [kind, code] of [["missing", "MCP_APP_INITIAL_RESULT_INVALID"], ["protocol", "MCP_APP_HOST_INIT_INVALID"], ["timeout", "MCP_APP_HOST_INIT_TIMEOUT"], ["result-timeout", "MCP_APP_INITIAL_RESULT_TIMEOUT"]]) {
    const f = fixture({ timeoutMs: 15 });
    try {
      if (kind === "protocol") f.response(f.sent[0], { protocolVersion: "unsupported", hostInfo: { name: "host", version: "1" }, hostCapabilities: {} });
      else if (kind === "missing") { f.initialize(); await tick(); f.notify("ui/notifications/tool-result", tool()); }
      else if (kind === "result-timeout") { f.initialize(); await new Promise(resolve => setTimeout(resolve, 25)); }
      else await new Promise(resolve => setTimeout(resolve, 25));
      await tick();
      assert.equal(f.client.connected, false);
      assert.deepEqual(f.errors, [code]);
      assert.equal(f.locales.length, 0);
      assert.equal(f.snapshots.length, 0);
      assert.equal(f.sent.filter(value => value.method === "tools/call").length, 0);
    } finally { f.close(); }
  }
});

test("a missing initial snapshot waits for a validated fallback before admitting actions", async () => {
  for (const valid of [true, false]) {
    const f = fixture();
    try {
      f.initialize(); await tick();
      f.notify("ui/notifications/tool-result", { content: [], structuredContent: { ok: true, protocol: 1, version }, _meta: { "cfkanban/viewId": viewId() } });
      assert.equal(f.client.connected, false);
      assert.equal(f.locales.length, 0);
      assert.equal(f.sent.at(-1).params.name, "cfkanban_workbench_snapshot");
      const count = f.sent.length;
      assert.equal((await f.client.action("manual", {})).error.code, "MCP_APP_REOPEN_REQUIRED");
      assert.equal(f.sent.length, count);
      f.response(f.sent.at(-1), valid ? tool() : tool({ ...emptySnapshot(), credential: "private-marker" }));
      await tick();
      assert.equal(f.client.connected, valid);
      assert.equal(f.locales.length, valid ? 1 : 0);
      assert.deepEqual(f.errors, valid ? [] : ["MCP_APP_INITIAL_SNAPSHOT_INVALID"]);
    } finally { f.close(); }
  }
});

test("resource-teardown acknowledges once and pagehide disposes without releasing uncertain host state", async () => {
  for (const method of ["resource", "pagehide"]) {
    const f = await connected();
    try {
      const operation = f.client.action("mutate", { operation: "comment", change: { body: "draft" } });
      if (method === "resource") {
        const id = randomUUID();
        f.window.emit({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: { reason: "Host view removed" } });
        assert.deepEqual(f.sent.at(-1), { jsonrpc: "2.0", id, result: {} });
        const count = f.sent.length;
        f.window.emit({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
        assert.equal(f.sent.length, count);
      } else f.window.hide();
      assert.equal((await operation).outcome_unknown, true);
      assert.equal(f.client.connected, false);
      assert.equal(f.listeners.get("message").size, 0);
      assert.equal(f.listeners.get("pagehide").size, 0);
      assert.ok(!f.sent.some(value => value.params?.name === "cfkanban_workbench_release"));
    } finally { f.close(); }
  }
});

test("host theme/display/style updates preserve brand colors and reject network CSS", async () => {
  const properties = new Map();
  const document = { documentElement: { dataset: { theme: "blue" }, classList: { toggle() {} }, style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) } } };
  const f = await connected({ document });
  try {
    f.notify("ui/notifications/host-context-changed", { theme: "dark", displayMode: "fullscreen", styles: { variables: { "--color-background-primary": "#121212", "--color-text-primary": "rgb(240 240 240)", "--border-radius-md": "8px", "--color-primary": "red", "--font-sans": "url(https://example.com/font)", "--color-background-secondary": "url(https://example.com/image)" } } });
    assert.equal(document.documentElement.dataset.theme, "blue");
    assert.equal(document.documentElement.dataset.mcpTheme, "dark");
    assert.equal(document.documentElement.dataset.mcpDisplayMode, "fullscreen");
    assert.equal(properties.get("--ui-bg"), "#121212");
    assert.equal(properties.get("--radius-control"), "8px");
    assert.equal(properties.has("--ui-bg-muted"), false);
    assert.equal(properties.has("--color-primary"), false);
    assert.equal(applyHostContext(document, { locale: "zh-TW" }), "zh-CN");
  } finally { f.close(); }
});

test("MCP App build shares the Vue workbench and emits one immutable offline document", async () => {
  const outputDirectory = path.join(temporary, "build");
  const metadata = await buildMcpAppDocument({ outputDirectory, version });
  const html = await readFile(path.join(outputDirectory, "workbench.html"), "utf8");
  const checked = assertEmbeddedHtml(html);
  assert.equal(metadata.sha256, checked.sha256);
  assert.equal(metadata.size_bytes, checked.size_bytes);
  assert.equal(metadata.release_version, version);
  assert.equal(metadata.protocol, 1);
  assert.match(html, /ui\/initialize/);
  assert.match(html, /cfkanban_workbench_action/);
  assert.match(html, /MCP_APP_REOPEN_REQUIRED/);
  assert.ok(!html.includes("__CFKANBAN_MCP_APP_VERSION__"));
  assert.ok(!html.includes("<iframe"));
});
