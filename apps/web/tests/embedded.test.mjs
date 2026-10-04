import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";
import test, { after } from "node:test";
import { build } from "esbuild";
import { compileScript, parse as parseVue } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";
import { assertEmbeddedHtml } from "../scripts/build-embedded.mjs";
import { ISSUE_COLLECTION_LIMIT as CONTROLLER_COLLECTION_LIMIT } from "../../../packages/local-runtime/src/workbench/controller.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "cfkanban-embedded-test-"));
const moduleFile = path.join(temporary, "protocol.mjs");
await build({ stdin: { contents: 'export * from "./src/embedded/protocol.ts"; export * from "./src/embedded/client.ts"; export * from "./src/embedded/drafts.ts"; export * from "./src/embedded/pagination.ts"; export * from "./src/lib/markdown.ts";', resolveDir: path.join(root, "apps/web"), loader: "ts" }, outfile: moduleFile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { ISSUE_COLLECTION_LIMIT, parseActionMessage, parseSnapshotMessage, parseResultMessage, isConnectMessage, isSessionReference, emptySnapshot, createEmbedClient, renderMarkdown, reconcileCompletedDraft, canAutoAppend } = await import(pathToFileURL(moduleFile));
const detailModule = path.join(temporary, "workbench.mjs");
await build({
  entryPoints: [path.join(root, "apps/web/src/embedded/Workbench.vue")], outfile: detailModule, bundle: true, platform: "node", format: "esm", logLevel: "silent", loader: { ".png": "empty" },
  plugins: [{ name: "embedded-detail-test", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      if (!filename.endsWith("/embedded/Workbench.vue")) return { contents: "export default {}", loader: "js" };
      const { descriptor } = parseVue(await readFile(filename, "utf8"), { filename });
      return { contents: compileScript(descriptor, { id: "embedded-detail-test" }).content, loader: "ts", resolveDir: path.dirname(filename) };
    });
    builder.onResolve({ filter: /^@nuxt\/ui\/locale$/ }, () => ({ path: "locale", namespace: "embedded-detail-test" }));
    builder.onLoad({ filter: /.*/, namespace: "embedded-detail-test" }, () => ({ contents: "export const en = {}; export const zh_cn = {};", loader: "js" }));
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(path.join(root, "node_modules/vue/index.mjs")).href, external: true }));
  } }],
});
const { default: Workbench } = await import(pathToFileURL(detailModule));
after(() => rm(temporary, { recursive: true, force: true }));
const action = (name, payload) => ({ type: "action", id: randomUUID(), action: name, payload });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeWindow() {
  const parent = {};
  const listeners = new Set();
  return { parent, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener), emit: event => { for (const listener of listeners) listener(event); } };
}
function connectedClient(options = {}) {
  const surface = fakeWindow();
  const channel = new MessageChannel();
  const errors = [];
  const snapshots = [];
  const locales = [];
  const client = createEmbedClient({ window: surface, onConnect: value => locales.push(value), onSnapshot: value => snapshots.push(value), onError: value => errors.push(value), timeoutMs: 100, ...options });
  const connect = { source: surface.parent, data: { type: "cfkanban.embed.connect", protocol: 1, locale: "zh-CN" }, ports: [channel.port1] };
  return { surface, channel, errors, snapshots, locales, client, connect, close: () => { client.dispose(); channel.port2.close(); } };
}

function node() { return { children: [], parent: null }; }
const renderer = createRenderer({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(target, parent) { target.parent = parent; parent.children.push(target); }, remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); }, parentNode: target => target.parent, nextSibling: () => null });
async function mountedDetail() {
  const saved = { window: globalThis.window, document: globalThis.document };
  const surface = fakeWindow();
  const channel = new MessageChannel();
  globalThis.window = surface;
  globalThis.document = { documentElement: { lang: "en", dataset: {}, toggleAttribute() {} }, getElementById() { return null; } };
  const app = renderer.createApp({ render: () => h({ ...Workbench, render: () => null }) });
  app.mount(node());
  const vm = app._instance.subTree.component.setupState;
  surface.emit({ source: surface.parent, data: { type: "cfkanban.embed.connect", protocol: 1, locale: "en" }, ports: [channel.port1] });
  vm.state = { ...emptySnapshot(), issue: { identifier: "CFK-548", title: "Fixture", body: "", version: 2, status: { key: "todo" }, priority: "high" }, binding: { project: { id: randomUUID() }, statuses: ["backlog", "todo", "in_progress", "done", "canceled"].map(key => ({ key })) }, capabilities: { update: true, comment: true, complete: true } };
  await nextTick();
  const fixture = { vm, channel, calls: [], result: { ok: true }, respond: null, close() { app.unmount(); channel.port2.close(); Object.assign(globalThis, saved); } };
  channel.port2.on("message", message => {
    fixture.calls.push(message);
    fixture.respond?.(message);
    channel.port2.postMessage({ type: "result", id: message.id, result: fixture.result });
  });
  return fixture;
}

test("detail label actions use one existing label and wait for confirmed snapshots", async () => {
  const f = await mountedDetail();
  try {
    const attached = { id: randomUUID(), name: "Bug" }, available = { id: randomUUID(), name: "Feature" };
    f.vm.state.issue.labels = [attached];
    f.vm.state.labels = [attached, available];
    await f.vm.toggleLabel(attached.id, true);
    await f.vm.toggleLabel(randomUUID(), true);
    await f.vm.toggleLabel(available.id, false);
    assert.equal(f.calls.length, 0);
    await f.vm.toggleLabel(available.id, true);
    assert.deepEqual(f.calls[0].payload, { operation: "label_add", change: { label_id: available.id } });
    assert.deepEqual(f.vm.state.issue.labels, [attached]);
    await f.vm.toggleLabel(attached.id, false);
    assert.deepEqual(f.calls[1].payload, { operation: "label_remove", change: { label_id: attached.id } });
    await f.vm.loadLabels(false);
    await f.vm.loadLabels(true);
    assert.deepEqual(f.calls.slice(2).map(call => call.payload), [{ next: false }, { next: true }]);
    f.vm.state.capabilities.update = false;
    await f.vm.toggleLabel(attached.id, false);
    await f.vm.loadLabels(false);
    f.vm.state.capabilities.update = true;
    f.vm.state.pending = { operation: "label_add" };
    await f.vm.toggleLabel(available.id, true);
    assert.equal(f.calls.length, 4);
  } finally { f.close(); }
});

test("the workbench applies confirmed account language and theme without sending profile fields", async () => {
  const f = await mountedDetail();
  try {
    await f.vm.changeLocale("zh-CN");
    assert.deepEqual(f.calls[0], { type: "action", id: f.calls[0].id, action: "set_locale", payload: { locale: "zh-CN" } });
    assert.equal(document.documentElement.lang, "en");
    f.channel.port2.postMessage({ type: "snapshot", state: JSON.parse(JSON.stringify({ ...f.vm.state, locale: "zh-CN", theme: "blue" })) });
    await tick(); await nextTick();
    assert.equal(document.documentElement.lang, "zh-CN");
    assert.equal(document.documentElement.dataset.theme, "blue");
    f.vm.state.pending = { operation: "set_locale" };
    await f.vm.changeLocale("en");
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test("preference and label messages reject injected scopes, malformed enums and duplicate labels", () => {
  assert.ok(parseActionMessage(action("set_locale", { locale: "en" })));
  for (const payload of [{ locale: "fr" }, { locale: null }, { locale: "en", expected_version: 1 }, { locale: "en", principal_id: randomUUID() }]) {
    assert.equal(parseActionMessage(action("set_locale", payload)), null);
  }
  const label = { id: randomUUID(), name: "Existing" };
  assert.ok(parseActionMessage(action("mutate", { operation: "label_add", change: { label_id: label.id } })));
  assert.equal(parseActionMessage(action("mutate", { operation: "label_add", change: { label_id: label.id, project_id: randomUUID() } })), null);
  assert.ok(parseSnapshotMessage({ type: "snapshot", state: { ...emptySnapshot(), theme: "blue", labels: [label] } }));
  for (const patch of [{ theme: "dark" }, { labels: [label, label] }, { labels: [{ ...label, name: "" }] }, { labels_has_more: "yes" }]) {
    assert.equal(parseSnapshotMessage({ type: "snapshot", state: { ...emptySnapshot(), ...patch } }), null);
  }
});

test("detail properties save one choice, done opens confirmation, and blocked or unchanged choices do not write", async () => {
  const f = await mountedDetail();
  try {
    const select = { value: "done" };
    f.vm.statusChanged({ target: select });
    assert.equal(select.value, "todo");
    assert.equal(f.vm.showCompletion, true);
    await tick();
    assert.deepEqual(f.calls, [], "done must not create a normal status PATCH or complete before confirmation");
    f.vm.showCompletion = false;
    for (const value of ["todo", "invalid"]) f.vm.statusChanged({ target: { value } });
    await f.vm.updateDetail({ priority_key: "high" });
    await f.vm.updateDetail({ assignee_principal_id: null });
    assert.equal(f.calls.length, 0);
    await f.vm.updateDetail({ priority_key: "urgent" });
    assert.deepEqual(f.calls[0].payload, { operation: "update", change: { priority_key: "urgent" } });
    assert.equal(f.vm.state.issue.priority, "high", "displayed value follows confirmed Host snapshots");
    f.vm.state.capabilities.update = false;
    await f.vm.updateDetail({ priority_key: "low" });
    f.vm.statusChanged({ target: { value: "in_progress" } });
    f.vm.state.capabilities.update = true;
    f.vm.state.pending = { operation: "update" };
    await f.vm.updateDetail({ priority_key: "low" });
    f.vm.openCompletion();
    assert.equal(f.vm.showCompletion, false);
    assert.equal(f.calls.length, 1);
    f.vm.state.pending = null;
    f.vm.state.busy = 1;
    await f.vm.updateDetail({ priority_key: "low" });
    assert.equal(f.calls.length, 1);
    f.vm.state.busy = 0;
    await f.vm.updateDetail({ status_key: "in_progress" });
    assert.deepEqual(f.calls[1].payload, { operation: "update", change: { status_key: "in_progress" } });
    const principalId = randomUUID();
    await f.vm.updateDetail({ assignee_principal_id: principalId });
    assert.deepEqual(f.calls[2].payload, { operation: "update", change: { assignee_principal_id: principalId } });
  } finally { f.close(); }
});

test("completion failure and unknown result keep evidence through same-Issue readback, with explicit recovery clearing only confirmed completion", async () => {
  const f = await mountedDetail();
  try {
    Object.assign(f.vm.completion, { summary: "Actual work", verification: "One check\n\nSecond check", artifacts: "src/file.ts", artifactKind: "path", followUps: "Next step" });
    f.vm.comment = "Unsent comment";
    f.vm.openCompletion();
    const draft = { ...f.vm.completion };
    f.result = { ok: false, error: { code: "VERSION_CONFLICT" } };
    await f.vm.complete();
    assert.equal(f.vm.showCompletion, true);
    assert.deepEqual({ ...f.vm.completion }, draft);
    assert.deepEqual(f.calls[0].payload.change, { summary: "Actual work", verification: ["One check", "Second check"], artifacts: [{ kind: "path", value: "src/file.ts" }], follow_ups: ["Next step"] });
    f.vm.state.issue = { ...f.vm.state.issue, version: 3, status: { key: "in_progress" }, priority: "low" };
    await nextTick();
    assert.deepEqual({ ...f.vm.completion }, draft);
    assert.equal(f.vm.comment, "Unsent comment");
    f.result = { ok: false, outcome_unknown: true };
    f.respond = () => { f.vm.state.pending = { operation: "complete" }; };
    await f.vm.complete();
    assert.equal(f.vm.showCompletion, true);
    assert.deepEqual({ ...f.vm.completion }, draft);
    await f.vm.complete();
    assert.equal(f.calls.length, 2, "unknown completion cannot submit another write");
    f.result = { ok: true };
    f.respond = () => { f.vm.state.pending = null; f.vm.state.issue = { ...f.vm.state.issue, status: { key: "done" }, version: 4 }; };
    await f.vm.recover();
    assert.equal(f.calls[2].action, "recover");
    assert.deepEqual(f.calls[2].payload, {});
    assert.equal(f.vm.showCompletion, false);
    assert.equal(f.vm.completion.summary, "");
    assert.equal(f.vm.comment, "Unsent comment", "completion recovery does not consume an unrelated comment draft");
  } finally { f.close(); }
});

test("actions accept only atomic public fields, exact enum strings and bounded evidence", () => {
  for (const [name, payload] of [["scope_retry", {}], ["scope_bind", { target_id: "scope/known-project" }], ["select_instance", { instance_id: randomUUID() }], ["filters", { assignment: "mine", status: "todo", priority: "high" }], ["mutate", { operation: "comment", change: { body: "Actual comment" } }], ["mutate", { operation: "complete", change: { summary: "Actual work", verification: ["Confirmed"], artifacts: [{ kind: "path", value: "src/file.ts" }], follow_ups: [] } }], ["view", { mode: "board" }], ["board_page", { status_key: "todo", next: true }], ["quick_update", { identifier: "CFK-548", change: { assignee_principal_id: null } }]]) assert.ok(parseActionMessage(action(name, payload)));
  for (const input of [action("api", { url: "https://other.invalid" }), action("scope_retry", { path: "/tmp" }), action("mutate", { operation: "comment", change: { body: "X" }, idempotency_key: randomUUID() }), action("filters", { assignment: ["all"], status: ["todo"], priority: ["high"] }), action("mutate", { operation: "update", change: { status_key: ["todo"] } }), action("handoff", { target: ["new"], workspace_id: randomUUID() }), action("mutate", { operation: "complete", change: { summary: "X", artifacts: [{ kind: ["path"], value: "file" }] } }), action("mutate", { operation: "comment", change: { body: "x".repeat(32_769) } }), { ...action("manual", {}), id: "not-uuid" }, { ...action("manual", {}), private: true }]) assert.equal(parseActionMessage(input), null);
  assert.equal(isConnectMessage({ type: "cfkanban.embed.connect", protocol: 1, locale: ["en"] }), false);
});

test("snapshot refuses malformed rendering data, private fields and oversized content", () => {
  const base = emptySnapshot();
  assert.ok(parseSnapshotMessage({ type: "snapshot", state: base }));
  const issue = { identifier: "CFK-548", title: "Fixture", version: 2, status: { key: "todo" }, priority: "high" };
  assert.ok(parseSnapshotMessage({ type: "snapshot", state: { ...base, issue, page: { items: [issue], next_cursor: "available" }, scope_targets: [{ id: "target", available: false }] } }));
  for (const change of [{ issue: { ...issue, status: null } }, { issue: { ...issue, version: "2" } }, { issue: { ...issue, title: null } }, { page: { items: [null] } }, { binding: { project: {}, statuses: null } }, { scope_targets: [{ id: "target", available: "true" }] }, { filters: { assignment: ["all"], status: "", priority: "" } }, { identity: { instance: { token: "private" }, principal: {} } }, { credential: "private" }, { issue: { ...issue, body: "x".repeat(262_145) } }]) assert.equal(parseSnapshotMessage({ type: "snapshot", state: { ...base, ...change } }), null);
});

test("native Session references remain confined to trusted scope source fields", () => {
  const id = randomUUID();
  for (const reference of [id, `session-${id}`]) {
    assert.equal(isSessionReference(reference), true);
    assert.ok(parseSnapshotMessage({ type: "snapshot", state: { ...emptySnapshot(), source_session_id: reference } }));
  }
  for (const reference of ["session-invalid", `Session-${id}`, `session-session-${id}`, `session-${id}/other`, `session-${id}\n`, `/tmp/${id}`]) {
    assert.equal(isSessionReference(reference), false);
    assert.equal(parseSnapshotMessage({ type: "snapshot", state: { ...emptySnapshot(), source_session_id: reference } }), null);
  }
  for (const input of [action("bind", { project_id: `session-${id}` }), action("handoff", { target: "new", workspace_id: id }), action("open_association", { association_id: id })]) assert.equal(parseActionMessage(input), null);
});

test("board and quick edits expose bounded public rows but no cursors, CAS overrides or completion PATCH", () => {
  const issue = { identifier: "CFK-548", title: "Fixture", version: 2, status: { key: "todo" }, priority: "high" };
  const column = { key: "todo", display_name: "Todo", items: [issue], has_more: true };
  const message = columns => ({ type: "snapshot", state: { ...emptySnapshot(), view: "board", board: { columns } } });
  assert.ok(parseSnapshotMessage(message([column])));
  for (const columns of [[column, column], [{ ...column, items: Array(26).fill(issue) }], [{ ...column, next_cursor: "private" }], [{ ...column, has_more: "true" }]]) assert.equal(parseSnapshotMessage(message(columns)), null);
  for (const payload of [
    { identifier: "CFK-548", change: { status_key: "done" } },
    { identifier: "CFK-548", change: { priority_key: "urgent" }, expected_version: 2 },
    { identifier: "CFK-548", change: { assignee_principal_id: "name" } },
    { identifier: "CFK-548", change: { priority_key: "urgent", idempotency_key: randomUUID() } }
  ]) assert.equal(parseActionMessage(action("quick_update", payload)), null);
  assert.ok(parseActionMessage(action("assignees", { next: true })));
  assert.equal(parseActionMessage(action("board_page", { status_key: "todo", next: true, cursor: "private" })), null);
});

test("child connects only once through the exact parent and one transferred port", async () => {
  const f = connectedClient();
  const ignored = new MessageChannel();
  try {
    for (const event of [{ ...f.connect, source: {} }, { ...f.connect, source: undefined }, { ...f.connect, data: { ...f.connect.data, origin: "other" } }, { ...f.connect, ports: [] }, { ...f.connect, ports: [f.channel.port1, ignored.port1] }]) f.surface.emit(event);
    assert.equal(f.client.connected, false);
    assert.deepEqual(f.locales, []);
    f.surface.emit(f.connect);
    assert.equal(f.client.connected, true);
    assert.deepEqual(f.locales, ["zh-CN"]);
    f.surface.emit({ ...f.connect, data: { ...f.connect.data, locale: "en" }, ports: [ignored.port1] });
    assert.deepEqual(f.locales, ["zh-CN"]);
    f.channel.port2.postMessage({ type: "snapshot", state: emptySnapshot() });
    await tick(); await tick();
    assert.equal(f.snapshots.length, 1);
    ignored.port2.postMessage({ type: "snapshot", state: { ...emptySnapshot(), busy: 5 } });
    await tick();
    assert.equal(f.snapshots.length, 1);
  } finally { f.close(); ignored.port1.close(); ignored.port2.close(); }
});

test("child correlates results without sending credentials, paths or business keys", async () => {
  const f = connectedClient();
  try {
    assert.equal((await f.client.action("manual", {})).error.code, "EMBED_NOT_CONNECTED");
    f.surface.emit(f.connect);
    const messages = [];
    f.channel.port2.on("message", message => { messages.push(message); f.channel.port2.postMessage({ type: "result", id: message.id, result: { ok: true } }); });
    assert.deepEqual(await f.client.action("mutate", { operation: "comment", change: { body: "Explicit comment" } }), { ok: true });
    assert.equal(messages.length, 1);
    assert.deepEqual(Object.keys(messages[0]), ["type", "id", "action", "payload"]);
    assert.equal((await f.client.action("unknown", {})).error.code, "EMBED_INVALID_ACTION");
    assert.equal(messages.length, 1);
    f.channel.port2.postMessage({ type: "result", id: randomUUID(), result: { ok: false, error: { code: "PANEL_CONTEXT_TOO_LARGE" } } });
    await tick(); await tick();
    assert.ok(f.errors.includes("PANEL_CONTEXT_TOO_LARGE"));
    assert.equal(parseResultMessage({ type: "result", id: randomUUID(), result: { ok: true, data: { token: "private" } } }), null);
  } finally { f.close(); }
});

test("only writes become uncertain on timeout; recovery is explicit and never replays automatically", async () => {
  const f = connectedClient({ timeoutMs: 10 });
  try {
    f.surface.emit(f.connect);
    const messages = [];
    f.channel.port2.on("message", message => messages.push(message));
    const read = await f.client.action("page", { next: false });
    assert.equal(read.error.code, "EMBED_REQUEST_FAILED");
    assert.equal(read.outcome_unknown, undefined);
    const write = await f.client.action("mutate", { operation: "comment", change: { body: "X" } });
    assert.equal(write.outcome_unknown, true);
    const preference = await f.client.action("set_locale", { locale: "zh-CN" });
    assert.equal(preference.outcome_unknown, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(messages.map(message => message.action), ["page", "mutate", "set_locale"]);
    await f.client.action("recover", {});
    assert.deepEqual(messages.map(message => message.action), ["page", "mutate", "set_locale", "recover"]);
    assert.deepEqual(messages[3].payload, {});
  } finally { f.close(); }
});

test("embedded Markdown uses the shared escaping and trusted relative-link rules", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [bad](javascript:alert) [file](file:///tmp/x) [relative](/issues/CFK-1)', { baseUrl: "https://trusted.invalid", linkTarget: "_blank" });
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="file:'));
  assert.ok(html.includes('href="https://trusted.invalid/issues/CFK-1" target="_blank" rel="noreferrer noopener"'));
});

test("narrow Workbench references only existing Web theme and typography tokens", async () => {
  const webSource = path.join(root, "apps/web/src");
  const [legacy, theme, embedded] = await Promise.all(["style.css", "ui.css", "embedded/embedded.css"].map(file => readFile(path.join(webSource, file), "utf8")));
  const defined = new Set([...`${legacy}\n${theme}\n${embedded}`.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  const references = new Set([...embedded.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]));
  assert.ok(references.size > 0);
  assert.deepEqual([...references].filter(token => !defined.has(token)), []);
});

test("explicit write actions bypass native form submission under the fixed sandbox", async () => {
  const source = await readFile(path.join(root, "apps/web/src/embedded/Workbench.vue"), "utf8");
  const { descriptor, errors } = parseVue(source);
  assert.deepEqual(errors, []);
  const template = descriptor.template.content;
  assert.doesNotMatch(template, /<form\b|@submit\b|type="submit"/);
  const buttons = [...template.matchAll(/<UButton\b([^>]*)>/g)].map(match => match[1]);
  for (const handler of ["applyFilters", "addComment", "complete", "openCompletion"]) {
    const button = buttons.find(attributes => attributes.includes(`@click="${handler}"`));
    assert.ok(button, `${handler} must have an explicit click path`);
    assert.match(button, /type="button"/);
  }
  assert.doesNotMatch(template, /@keydown(?:\.enter)?\.prevent/);
  const detail = template.slice(template.indexOf('<article v-else class="embedded-detail">'));
  for (const [, attributes] of detail.matchAll(/<UButton\b([^>]*)>/g)) assert.match(attributes, /type="button"/);
  assert.match(detail, /:dismissible="!busy && !pending"/);
  assert.match(detail, /@update:open="!\$event && !busy && !pending/);
  assert.match(detail, /<UModal[\s\S]*@click="recover"[\s\S]*<\/UModal>/, "pending completion can recover without leaving the modal");
  const carrier = await readFile(path.join(root, "packages/local-runtime/src/workbench/embed-adapter.mjs"), "utf8");
  assert.match(carrier, /FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'/);
});

test("natural pagination requires a deliberate near-bottom scroll and stops on busy, uncertain, failed, exhausted or capacity-limited views", () => {
  const target = { scrollTop: 610, scrollHeight: 1000, clientHeight: 200 };
  const state = { busy: false, pending: false, error: false, hasMore: true, capacityReached: false };
  assert.equal(canAutoAppend(target, state), true);
  assert.equal(canAutoAppend({ ...target, scrollTop: 0 }, state), false, "short first pages use the explicit load-more fallback");
  assert.equal(canAutoAppend({ ...target, scrollTop: 600 }, state), false, "the threshold matches the full board's less-than-200 rule");
  for (const flags of [{ busy: true }, { pending: true }, { error: true }, { hasMore: false }, { capacityReached: true }]) assert.equal(canAutoAppend(target, { ...state, ...flags }), false);
  assert.equal(canAutoAppend(target, { ...state, error: false }), true, "an explicit successful retry can permit future scrolling");
});

test("list and column scrolling retain an accessible explicit fallback inside their scroll area without a first-page control", async () => {
  const source = await readFile(path.join(root, "apps/web/src/embedded/Workbench.vue"), "utf8");
  const { descriptor, errors } = parseVue(source);
  assert.deepEqual(errors, []);
  const nodes = [];
  const visit = (node, ancestors = []) => {
    if (node.type === 1) nodes.push({ node, ancestors });
    for (const child of node.children ?? []) visit(child, node.type === 1 ? [...ancestors, node] : ancestors);
  };
  visit(descriptor.template.ast);
  const attribute = (node, name) => node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
  const directive = (node, event) => node.props.find(prop => prop.type === 7 && prop.name === "on" && prop.arg?.content === event)?.exp?.content;
  const containsClass = (node, value) => attribute(node, "class")?.split(" ").includes(value);
  for (const [handler, ownerClass, scrollHandler] of [["loadMoreColumn(column.key)", "embedded-column-content", "onColumnScroll(column.key, $event)"], ["loadMoreColumn(group.key)", "embedded-group-content", "onColumnScroll(group.key, $event)"]]) {
    const fallback = nodes.find(({ node }) => node.tag === "UButton" && directive(node, "click") === handler);
    assert.ok(fallback, `${handler} must remain available for keyboard and non-overflowing pages`);
    const owner = fallback.ancestors.find(node => containsClass(node, ownerClass));
    assert.ok(owner, `${handler} must remain within its own scroll area`);
    assert.equal(attribute(owner, "tabindex"), "0");
    assert.equal(directive(owner, "scroll"), scrollHandler);
    assert.match(fallback.node.props.find(prop => prop.type === 7 && prop.arg?.content === "disabled").exp.content, /busy \|\| pending.*capacity_reached/);
  }
  assert.doesNotMatch(descriptor.template.content, /e\('first'\)|next: false.*board_page/);
  const hint = nodes.find(({ node }) => attribute(node, "id") === "embedded-board-hint").node;
  assert.equal(containsClass(hint, "sr-only"), false);
});

test("known completion clears submitted evidence while conflicts and uncertain recovery retain every draft field", () => {
  const completed = { identifier: "CFK-548", title: "Fixture", version: 3, status: { key: "done" }, priority: "high" };
  const evidence = { summary: "Actual work", verification: "Checked", artifacts: "src/file.ts", artifactKind: "commit", followUps: "Next step" };
  for (const result of [{ ok: false, error: { code: "VERSION_CONFLICT" } }, { ok: false, outcome_unknown: true }, { ok: true, outcome_unknown: true }]) {
    const draft = { ...evidence };
    assert.equal(reconcileCompletedDraft(draft, completed, result), false);
    assert.deepEqual(draft, evidence);
  }
  const draft = { ...evidence };
  assert.equal(reconcileCompletedDraft(draft, null, { ok: true }), false);
  assert.deepEqual(draft, evidence);
  assert.equal(reconcileCompletedDraft(draft, completed, { ok: true }), true);
  assert.deepEqual(draft, { summary: "", verification: "", artifacts: "", artifactKind: "path", followUps: "" });
});


test("completion accepts the same optional summary and evidence bounds as the service", () => {
  for (const summary of ["", "   ", "Actual result"]) assert.ok(parseActionMessage(action("mutate", { operation: "complete", change: { summary, follow_ups: ["x".repeat(2048)], artifacts: [{ kind: "other", value: "Manual result" }] } })));
  for (const change of [{ summary: "x".repeat(8193) }, { summary: "", follow_ups: ["x".repeat(2049)] }, { summary: "", verification: ["x".repeat(1025)] }]) assert.equal(parseActionMessage(action("mutate", { operation: "complete", change })), null);
});

test("prebuilt Document is offline, versioned, hashed and contains only the embedded Vue entry", async () => {
  const output = path.join(root, "apps/web/dist-embedded");
  const html = await readFile(path.join(output, "embedded.html"), "utf8");
  const metadata = JSON.parse(await readFile(path.join(output, "embedded-build.json"), "utf8"));
  const version = JSON.parse(await readFile(path.join(root, "release/version.json"), "utf8")).version;
  assert.deepEqual({ schema_version: metadata.schema_version, protocol: metadata.protocol, entry: metadata.entry, release_version: metadata.release_version }, { schema_version: 1, protocol: 1, entry: "embedded.html", release_version: version });
  const checked = assertEmbeddedHtml(html);
  assert.equal(metadata.size_bytes, checked.size_bytes);
  assert.equal(metadata.sha256, checked.sha256);
  assert.equal(metadata.sha256, createHash("sha256").update(html).digest("hex"));
  assert.match(html, /cfkanban\.embed\.connect/);
  assert.match(html, /data:image\/png;base64,/);
  assert.doesNotMatch(html, /\/api\/v1\/web-session|document\.cookie|\blocalStorage\b|\bsessionStorage\b/);
  for (const bad of [html.replace('<div id="app">', '<img src=https://evil.invalid/x><div id="app">'), html.replace("</head>", '<link rel="stylesheet" href="https://evil.invalid/x"></head>'), html.replace("connect-src 'none'", "connect-src https:"), html.replace("connect-src 'none'", "connect-src https:; connect-src 'none'"), html.replace("<script type=\"module\">", '<script src="x.js" type="module">')]) assert.throws(() => assertEmbeddedHtml(bad));
});

test("accumulated collections accept up to one thousand unique summaries and explicit capacity while keeping generic safety limits", () => {
  assert.equal(ISSUE_COLLECTION_LIMIT, CONTROLLER_COLLECTION_LIMIT);
  const rows = Array.from({ length: ISSUE_COLLECTION_LIMIT }, (_value, index) => ({ identifier: `CFK-${index + 1}`, title: `Issue ${index + 1}`, version: 1, status: { key: "todo" }, priority: "none" }));
  const base = emptySnapshot();
  const page = { items: rows, next_cursor: "available", capacity_reached: true };
  const column = { key: "todo", items: rows, has_more: true, capacity_reached: true };
  for (const length of [101, Math.floor(ISSUE_COLLECTION_LIMIT / 2), ISSUE_COLLECTION_LIMIT]) {
    assert.ok(parseSnapshotMessage({ type: "snapshot", state: { ...base, page: { ...page, items: rows.slice(0, length) } } }));
    assert.ok(parseSnapshotMessage({ type: "snapshot", state: { ...base, board: { columns: [{ ...column, items: rows.slice(0, length) }] } } }));
  }
  for (const changed of [{ ...page, items: [...rows, { ...rows[0], identifier: `CFK-${ISSUE_COLLECTION_LIMIT + 1}` }] }, { ...page, items: [rows[0], rows[0]] }, { ...page, capacity_reached: "true" }, { ...page, next_cursor: "private-real-cursor" }, { ...page, items: [{ ...rows[0], body: "Private collection body" }] }]) assert.equal(parseSnapshotMessage({ type: "snapshot", state: { ...base, page: changed } }), null);
  for (const changed of [{ ...column, items: [...rows, { ...rows[0], identifier: `CFK-${ISSUE_COLLECTION_LIMIT + 1}` }] }, { ...column, capacity_reached: 1 }, { ...column, items: [{ ...rows[0], body: "Must open detail" }] }]) assert.equal(parseSnapshotMessage({ type: "snapshot", state: { ...base, board: { columns: [changed] } } }), null);
  assert.equal(parseSnapshotMessage({ type: "snapshot", state: { ...base, page: { ...page, items: rows.slice(0, 101).map(row => ({ ...row, title: "x".repeat(8192), assignee: { display_name: "x".repeat(8192), name: "x".repeat(8192) } })) } } }), null);
});
