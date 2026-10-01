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
globalThis.window = {
  navigator: { languages: ["en"] }, location: { pathname: "/app/notifications", search: "" },
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events), setTimeout, clearTimeout,
};
globalThis.document = { cookie: "cfkanban_csrf=notification-test", documentElement: { setAttribute() {} } };
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Notifications } from './apps/web/src/views/NotificationsView.vue'; export { default as Bell } from './apps/web/src/components/NotificationBell.vue'; export * from './apps/web/src/lib/notifications.ts'; export * from './apps/web/src/lib/notification-events.ts'; export { apiRequest } from './apps/web/src/lib/api.ts'; export { locale } from './apps/web/src/lib/i18n.ts';`, resolveDir: root },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  plugins: [nuxtUiTestPlugin(), { name: "vue-notification-test", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
      return { contents: compileScript(descriptor, { id: "notification-test", inlineTemplate: true }).content, loader: "ts", resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true }));
  } }],
});
const { Notifications, Bell, checkNotificationAttention, notificationAttention, setNotificationSession, isNotificationPath, apiRequest, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
afterEach(() => { setNotificationSession(null); globalThis.fetch = original.fetch; locale.value = "en"; });
after(() => { globalThis.window = original.window; globalThis.document = original.document; });

function node(tag, text = "") { return { tag, text, children: [], props: {}, parent: null, focus() {}, addEventListener() {}, removeEventListener() {} }; }
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
  setText: (target, text) => { target.text = text; }, setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; },
  insert(target, parent, anchor = null) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, target);
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); },
  parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insertStaticContent(text, parent, anchor) { const target = node("#static", text); target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, target); return [target, target]; },
});
const all = target => [target, ...target.children.flatMap(all)];
const text = target => target.text + target.children.map(text).join("");
const button = (host, label) => all(host).find(item => item.tag === "button" && text(item) === label);
const buttons = (host, label) => all(host).filter(item => item.tag === "button" && text(item) === label);
const form = (host, cls) => all(host).find(item => item.tag === "form" && item.props.class === cls);
const submit = (host, cls) => form(host, cls).props.onSubmit({ preventDefault() {}, stopPropagation() {} });
const inputs = host => all(host).filter(item => ["input", "textarea"].includes(item.tag));
async function update(input, value) { input.props["onUpdate:modelValue"](value); await nextTick(); }
async function click(host, label) { button(host, label).props.onClick(); await nextTick(); }
async function until(check) { for (let step = 0; step < 100; step++) { await new Promise(resolve => setTimeout(resolve, 5)); await nextTick(); if (check()) return; } assert.fail("notification did not reach expected state"); }
const session = (owner = false, scope = "project_selection", id = "principal-1") => ({
  principal: { id, display_name: "Pat", is_owner: owner, version: 1 }, allowed_scope: { kind: scope, projects: [] },
  session_id: `session-${id}`, source: { kind: "credential", id: "source" }, expires_at: "2026-12-31T23:59:59Z", target: { kind: scope },
});
const preference = (more = {}) => ({ enabled: true, version: 1, receive_after: "2026-10-01T00:00:00Z", ...more });
const announcement = (id = "announcement-1", more = {}) => ({ id, title: `Title ${id}`, body: `<img src=x onerror=alert(1)> ${id}`, created_at: "2026-10-01T00:00:00Z", expires_at: null, withdrawn_at: null, version: 1, status: "active", acknowledged_at: null, ...more });
const page = (items = [], cursor = null) => Response.json({ items, next_cursor: cursor });
function problem(status, code, category, details = {}) {
  const requestId = "00000000-0000-4000-8000-000000000099";
  return Response.json({ category, code, details, message: "Test failure", recovery: category === "conflict" ? "refresh_resource" : "fix_input", request_id: requestId, retryable: false, source: "service" }, { status, headers: { "x-request-id": requestId } });
}
async function mount(value = session(), ready = true, component = Notifications) {
  const current = ref(value), host = node("root");
  const app = renderer.createApp({ setup: () => () => h(component, { session: current.value }) });
  app.mount(host);
  if (ready && component === Notifications) await until(() => !!button(host, "Save preference") && !text(host).includes("Loading…"));
  return { app, host, change: async next => { current.value = next; await nextTick(); } };
}

test("notification reading is plain text; neither loading nor opening acknowledges, and confirmation writes only the expanded item", async () => {
  const writes = []; const item = announcement();
  globalThis.fetch = async (path, init) => {
    if (init.method === "POST") { writes.push({ path, body: JSON.parse(init.body), key: init.headers.get("idempotency-key") }); return Response.json({ resource: { ...item, acknowledged_at: "2026-10-01T01:00:00Z" } }); }
    return path.includes("notification-preferences") ? Response.json(preference()) : page([item, announcement("announcement-2")]);
  };
  const { app, host } = await mount();
  try {
    assert.equal(writes.length, 0); assert.equal(button(host, "I have read this announcement"), undefined);
    buttons(host, "Read announcement")[0].props.onClick(); await nextTick();
    assert.ok(text(host).includes(item.body)); assert.equal(all(host).filter(item => item.tag === "img").length, 0); assert.equal(writes.length, 0);
    await click(host, "I have read this announcement"); await until(() => writes.length === 1 && !text(host).includes(item.title));
    assert.equal(writes[0].path, `/api/v1/me/notifications/${item.id}/commands/acknowledge`); assert.deepEqual(writes[0].body, {}); assert.ok(writes[0].key);
    assert.ok(text(host).includes("Title announcement-2"));
  } finally { app.unmount(); }
});

test("preference CAS reads current facts, retains the checkbox draft and never automatically replays", async () => {
  let reads = 0; const writes = [];
  globalThis.fetch = async (path, init) => {
    if (init.method === "PATCH") { writes.push(JSON.parse(init.body)); return problem(409, "VERSION_CONFLICT", "conflict", { current_version: 2 }); }
    if (path.includes("notification-preferences")) return Response.json(preference({ version: ++reads }));
    return page();
  };
  const { app, host } = await mount();
  try {
    await update(inputs(host).find(item => item.props.type === "checkbox"), false);
    await submit(host, "form-actions"); await until(() => text(host).includes("The latest fact was read back"));
    assert.equal(writes.length, 1); assert.deepEqual(writes[0], { enabled: false, expected_version: 1 });
    assert.equal(button(host, "Save preference").props.disabled, false);
    await submit(host, "form-actions"); await until(() => writes.length === 2);
    assert.equal(writes[1].expected_version, 2); assert.equal(writes[1].enabled, false);
  } finally { app.unmount(); }
});

test("confirmed disabled preferences clear earlier attention even when the next pending check fails", async () => {
  let enabled = true;
  globalThis.fetch = async (path, init) => {
    if (init.method === "PATCH") { enabled = false; return Response.json({ resource: preference({ enabled: false, version: 2 }) }); }
    if (path.includes("notification-preferences")) return Response.json(preference({ enabled }));
    return enabled ? page([announcement()]) : problem(503, "PLATFORM_UNAVAILABLE", "platform_failure");
  };
  setNotificationSession(session()); await checkNotificationAttention(); assert.equal(notificationAttention.hasPending, true);
  const { app, host } = await mount();
  try {
    await update(inputs(host).find(item => item.props.type === "checkbox"), false);
    await submit(host, "form-actions"); await until(() => notificationAttention.unavailable);
    assert.equal(notificationAttention.hasPending, false);
  } finally { app.unmount(); }
});

test("reading a disabled preference cancels an old pending check and ignores its late result", async () => {
  let resolveOld;
  globalThis.fetch = async (path) => path.includes("notification-preferences") ? Response.json(preference({ enabled: false }))
    : path.includes("limit=3") ? new Promise(resolve => { resolveOld = resolve; }) : page();
  setNotificationSession(session()); notificationAttention.hasPending = true; const old = checkNotificationAttention();
  const { app, host } = await mount();
  try {
    assert.equal(notificationAttention.hasPending, false); assert.equal(notificationAttention.checking, false);
    resolveOld(page([announcement()])); await old;
    assert.equal(notificationAttention.hasPending, false); assert.equal(button(host, "Save preference").props.disabled, true);
  } finally { app.unmount(); }
});

test("a known disabled preference discards a delayed earlier pending list while keeping historical reading available", async () => {
  let resolvePending;
  globalThis.fetch = async path => path.includes("notification-preferences") ? Response.json(preference({ enabled: false }))
    : path.includes("pending=true") ? new Promise(resolve => { resolvePending = resolve; }) : page([announcement("historical")]);
  const { app, host } = await mount();
  try {
    assert.ok(resolvePending); assert.equal(button(host, "Read announcement"), undefined);
    resolvePending(page([announcement("stale-pending")])); await new Promise(resolve => setTimeout(resolve, 10)); await nextTick();
    assert.equal(text(host).includes("stale-pending"), false); assert.equal(button(host, "Read announcement"), undefined);
    await click(host, "History"); await until(() => text(host).includes("Title historical"));
    await click(host, "Read announcement"); assert.ok(text(host).includes("<img src=x onerror=alert(1)> historical"));
    await click(host, "Awaiting confirmation"); await nextTick();
    assert.equal(button(host, "Read announcement"), undefined); assert.ok(text(host).includes("No announcements are awaiting confirmation."));
  } finally { app.unmount(); }
});

test("tab changes discard a late pending page; failed continuation keeps existing cards and retries the same cursor", async () => {
  let resolvePending, continuationReads = 0;
  globalThis.fetch = async (path) => {
    if (path.includes("notification-preferences")) return Response.json(preference());
    if (path.includes("pending=true")) return new Promise(resolve => { resolvePending = resolve; });
    if (path.includes("cursor=")) { continuationReads += 1; return continuationReads === 1 ? problem(503, "PLATFORM_UNAVAILABLE", "platform_failure") : page([announcement("history-2")]); }
    return page([announcement("history-1", { status: "expired" })], "history-cursor");
  };
  const { app, host } = await mount(session(), false);
  try {
    await until(() => !!resolvePending && !!button(host, "History"));
    await click(host, "History"); await until(() => text(host).includes("Title history-1"));
    resolvePending(page([announcement("stale")])); await nextTick(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(text(host).includes("Title stale"), false);
    await click(host, "Load more"); await until(() => !!button(host, "Retry loading"));
    assert.ok(text(host).includes("Title history-1"));
    await click(host, "Retry loading"); await until(() => text(host).includes("Title history-2"));
    assert.equal(continuationReads, 2); assert.equal(text(host).includes("Expired"), true);
  } finally { app.unmount(); }
});

test("Owner management requires instance scope; no-project principals and narrow Owners retain personal notifications", async () => {
  const paths = [];
  globalThis.fetch = async (path) => { paths.push(path); return path.includes("notification-preferences") ? Response.json(preference()) : page(); };
  for (const value of [session(), session(true, "project")]) {
    const { app, host } = await mount(value);
    try { assert.ok(button(host, "History")); assert.equal(button(host, "Publish announcement"), undefined); assert.equal(button(host, "Published by Owner"), undefined); } finally { app.unmount(); }
  }
  assert.equal(paths.some(path => path.includes("/admin/")), false);
});

test("Owner publishes Unicode text and withdraws with CAS; a conflict retains the next publication draft", async () => {
  const writes = []; let ownerItem = announcement("owner-item"), afterConflict = false;
  globalThis.fetch = async (path, init) => {
    if (init.method === "POST") {
      writes.push({ path, body: JSON.parse(init.body) });
      if (path.endsWith("/withdraw")) { afterConflict = true; return problem(409, "VERSION_CONFLICT", "conflict", { current_version: 2 }); }
      return Response.json({ resource: ownerItem });
    }
    return path.includes("notification-preferences") ? Response.json(preference()) : path.includes("/admin/") ? page([{ ...ownerItem, version: afterConflict ? 2 : 1 }]) : page();
  };
  const { app, host } = await mount(session(true, "instance"));
  try {
    await update(inputs(host).find(item => item.tag === "input" && !item.props.type), "🦊".repeat(200));
    await update(inputs(host).find(item => item.tag === "textarea"), "Body");
    assert.equal(button(host, "Publish announcement").props.disabled, false);
    await submit(host, "notification-compose"); await until(() => text(host).includes("Announcement published"));
    assert.equal(Array.from(writes[0].body.title).length, 200); assert.equal(writes.length, 1);
    await update(inputs(host).find(item => item.tag === "input" && !item.props.type), "Next draft");
    await update(inputs(host).find(item => item.tag === "textarea"), "Retain me");
    await click(host, "Read announcement"); await click(host, "Withdraw announcement");
    await until(() => text(host).includes("The latest fact was read back"));
    assert.deepEqual(writes[1].body, { expected_version: 1 }); assert.equal(writes.length, 2);
    assert.equal(inputs(form(host, "notification-compose")).find(item => item.tag === "textarea").props.value, "Retain me");
  } finally { app.unmount(); }
});

test("uncertain publication retries the identical body and key, preserving and freezing the draft", async () => {
  const writes = [];
  globalThis.fetch = async (path, init) => {
    if (init.method === "POST") { writes.push({ body: init.body, key: init.headers.get("idempotency-key") }); if (writes.length === 1) throw new Error("connection lost"); return Response.json({ resource: announcement() }); }
    return path.includes("notification-preferences") ? Response.json(preference()) : page();
  };
  const { app, host } = await mount(session(true, "instance"));
  try {
    await update(inputs(host).find(item => item.tag === "input" && !item.props.type), "Draft");
    await update(inputs(host).find(item => item.tag === "textarea"), "Text");
    await submit(host, "notification-compose"); await until(() => !!button(host, "Retry same publication"));
    assert.equal(inputs(host).find(item => item.tag === "textarea").props.disabled, true);
    await submit(host, "notification-compose"); await until(() => text(host).includes("Announcement published"));
    assert.deepEqual(writes[0], writes[1]);
  } finally { app.unmount(); }
});

test("an expired Owner announcement can still be withdrawn; an already withdrawn announcement cannot", async () => {
  const writes = []; const item = announcement("expired-owner", { status: "expired", expires_at: "2026-10-01T00:01:00Z" });
  globalThis.fetch = async (path, init) => {
    if (init.method === "POST") { writes.push(JSON.parse(init.body)); return Response.json({ resource: { ...item, status: "withdrawn", withdrawn_at: "2026-10-01T02:00:00Z", version: 2 } }); }
    return path.includes("notification-preferences") ? Response.json(preference()) : path.includes("/admin/") ? page([item]) : page();
  };
  const { app, host } = await mount(session(true, "instance"));
  try {
    await click(host, "Published by Owner"); await until(() => text(host).includes(item.title));
    await click(host, "Read announcement"); assert.ok(button(host, "Withdraw announcement"));
    await click(host, "Withdraw announcement"); await until(() => text(host).includes("Withdrawn") && !button(host, "Withdraw announcement"));
    assert.deepEqual(writes, [{ expected_version: 1 }]);
  } finally { app.unmount(); }
});

test("malformed publication success retains its original request key and draft until a verified exact retry", async () => {
  const writes = [];
  globalThis.fetch = async (path, init) => {
    if (init.method === "POST") { writes.push({ body: init.body, key: init.headers.get("idempotency-key") }); return Response.json(writes.length === 1 ? { resource: { id: "bad" } } : { resource: announcement() }); }
    return path.includes("notification-preferences") ? Response.json(preference()) : page();
  };
  const { app, host } = await mount(session(true, "instance"));
  try {
    await update(inputs(host).find(item => item.tag === "input" && !item.props.type), "Retained title");
    await update(inputs(host).find(item => item.tag === "textarea"), "Retained body");
    await submit(host, "notification-compose"); await until(() => !!button(host, "Retry same publication"));
    assert.equal(inputs(form(host, "notification-compose")).find(item => item.tag === "textarea").props.value, "Retained body");
    await submit(host, "notification-compose"); await until(() => text(host).includes("Announcement published"));
    assert.deepEqual(writes[0], writes[1]);
  } finally { app.unmount(); }
});

test("identity changes clear content and discard late reads and publication responses", async () => {
  let resolveList, resolveWrite; let current = "old";
  globalThis.fetch = async (path, init) => {
    if (init.method === "POST") return new Promise(resolve => { resolveWrite = resolve; });
    if (path.includes("notification-preferences")) return Response.json(preference());
    if (current === "old") return new Promise(resolve => { resolveList = resolve; });
    return page([announcement("new-user")]);
  };
  const { app, host, change } = await mount(session(true, "instance"), false);
  try {
    await until(() => !!resolveList && !!button(host, "Save preference"));
    await update(inputs(host).find(item => item.tag === "input" && !item.props.type), "Old private title");
    await update(inputs(host).find(item => item.tag === "textarea"), "Old private body");
    submit(host, "notification-compose"); await until(() => !!resolveWrite);
    current = "new"; await change(session(false, "project_selection", "principal-2"));
    await until(() => text(host).includes("Title new-user"));
    resolveList(page([announcement("old-user")])); resolveWrite(Response.json({ resource: announcement("published-old") }));
    await new Promise(resolve => setTimeout(resolve, 10)); await nextTick();
    assert.equal(text(host).includes("old-user"), false); assert.equal(text(host).includes("Old private"), false); assert.equal(text(host).includes("Announcement published"), false);
  } finally { app.unmount(); }
});

test("attention is bounded and throttled, excludes notification recursion, and discards a previous session result", async () => {
  let resolveOld; const calls = [];
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return new Promise(resolve => { resolveOld = resolve; }); };
  setNotificationSession(session());
  const old = checkNotificationAttention(); await checkNotificationAttention();
  assert.equal(calls.length, 1); assert.ok(calls[0].path.includes("limit=3")); assert.ok(calls[0].init.signal);
  setNotificationSession(session(false, "project_selection", "new"));
  resolveOld(page([announcement()])); await old;
  assert.equal(notificationAttention.hasPending, false); assert.equal(notificationAttention.checking, false);
  globalThis.fetch = async () => page([announcement()]); await checkNotificationAttention();
  assert.equal(notificationAttention.hasPending, true);
  setNotificationSession(null); assert.equal(notificationAttention.hasPending, false);
  for (const path of ["/api/v1/me/notification-preferences", "/api/v1/me/notifications?pending=true", "/api/v1/admin/notifications/x/commands/withdraw"]) assert.equal(isNotificationPath(path), true);
  assert.equal(isNotificationPath("/api/v1/workspaces"), false);
});

test("the bell never acknowledges and an unavailable reminder check does not change a successful business result", async () => {
  const requests = [];
  globalThis.fetch = async (path, init) => { requests.push({ path, method: init.method }); return path.includes("notifications") ? problem(503, "PLATFORM_UNAVAILABLE", "platform_failure") : Response.json({ primary: true }); };
  const { app, host } = await mount(session(), false, Bell);
  try {
    const result = await apiRequest("/api/v1/workspaces"); assert.deepEqual(result, { primary: true });
    await until(() => notificationAttention.unavailable);
    assert.ok(all(host).some(item => String(item.props["aria-label"]).includes("check unavailable")));
    assert.equal(requests.filter(item => item.path.includes("notifications")).length, 1);
    assert.equal(requests.every(item => item.method === "GET"), true);
    locale.value = "zh-CN"; await nextTick(); assert.ok(all(host).some(item => String(item.props["aria-label"]).includes("暂不可用")));
  } finally { app.unmount(); }
});

test("attention cancels after two seconds and never delays a successful primary business request", async () => {
  let aborted = false;
  globalThis.fetch = async (path, init) => {
    if (!path.includes("notifications")) return Response.json({ primary: true });
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
  };
  const { app } = await mount(session(), false, Bell);
  try {
    const result = await Promise.race([apiRequest("/api/v1/workspaces"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))]);
    assert.deepEqual(result, { primary: true });
    await new Promise(resolve => setTimeout(resolve, 2050));
    assert.equal(aborted, true); assert.equal(notificationAttention.checking, false); assert.equal(notificationAttention.unavailable, true);
  } finally { app.unmount(); }
});
