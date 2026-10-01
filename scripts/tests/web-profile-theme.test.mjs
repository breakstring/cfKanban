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
globalThis.window = {
  navigator: { languages: ["en"] }, location: { pathname: "/app/profile", search: "" },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setTimeout, clearTimeout,
};
globalThis.document = {
  cookie: "cfkanban_csrf=profile-test", documentElement: { dataset: { theme: "orange" }, toggleAttribute() {} },
  addEventListener() {}, removeEventListener() {},
};
afterEach(() => { globalThis.fetch = original.fetch; document.documentElement.dataset.theme = "orange"; });
after(() => { globalThis.window = original.window; globalThis.document = original.document; });

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = await build({
  stdin: { contents: `export { default as Profile } from './apps/web/src/views/ProfileView.vue'; export { applyTheme, latestPrincipalTheme } from './apps/web/src/lib/theme.ts';`, resolveDir: root },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  plugins: [nuxtUiTestPlugin(), { name: "vue-profile-test", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
      return { contents: compileScript(descriptor, { id: "profile-test", inlineTemplate: true }).content, loader: "ts", resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true }));
  } }],
});
const { Profile, applyTheme, latestPrincipalTheme } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const appOutput = await build({
  stdin: { contents: `export { default } from './apps/web/src/App.vue';`, resolveDir: root },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  plugins: [{ name: "app-session-test", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      if (path !== `${root}apps/web/src/App.vue`) return { contents: "export default {}", loader: "js" };
      const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
      return { contents: compileScript(descriptor, { id: "app-session-test" }).content, loader: "ts", resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^@nuxt\/ui\/locale$/ }, () => ({ path: "locale", namespace: "app-session-test" }));
    builder.onLoad({ filter: /.*/, namespace: "app-session-test" }, () => ({ contents: "export const en = {}; export const zh_cn = {};", loader: "js" }));
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true }));
  } }],
});
const { default: AppSession } = await import(`data:text/javascript;base64,${Buffer.from(appOutput.outputFiles[0].text).toString("base64")}`);

function node(tag, text = "") { return { tag, text, children: [], props: {}, parent: null, focus() {}, addEventListener() {}, removeEventListener() {} }; }
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
  setText: (target, text) => { target.text = text; }, setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; },
  insert(target, parent, anchor = null) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent;
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, target);
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); },
  parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insertStaticContent(text, parent, anchor) { const target = node("#static", text); target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, target); return [target, target]; },
});
const principal = (overrides = {}) => ({ id: "00000000-0000-4000-8000-000000000001", display_name: "Pat", is_owner: false, theme: "orange", version: 3, ...overrides });
const session = { principal: principal(), allowed_scope: { kind: "project_selection", projects: [] }, source: { kind: "credential", id: "source" } };
const all = target => [target, ...target.children.flatMap(all)];
const text = target => target.text + target.children.map(text).join("");
const button = (host, label) => all(host).find(item => item.tag === "button" && text(item) === label);
const radio = (host, theme) => all(host).find(item => item.tag === "input" && item.props.type === "radio" && item.props.value === theme);
const form = (host, theme) => all(host).find(item => item.tag === "form" && (theme ? text(item).includes("Save theme") : item.props.class === "profile-form"));
const submit = (host, theme = true) => form(host, theme).props.onSubmit({ preventDefault() {}, stopPropagation() {} });
async function chooseTheme(host, theme) { radio(host, theme).props["onUpdate:modelValue"](theme); radio(host, theme).props.onChange(); await nextTick(); }
async function until(check) {
  for (let step = 0; step < 100; step++) { await new Promise(resolve => setTimeout(resolve, 5)); await nextTick(); if (check()) return; }
  assert.fail("profile did not reach expected state");
}
async function mount(initialSession = session, waitForReady = true) {
  const updates = [];
  const currentSession = ref(initialSession);
  const app = renderer.createApp({ setup: () => () => h(Profile, {
    session: currentSession.value,
    onUpdated: resource => { updates.push(resource); applyTheme(resource.theme); },
  }) });
  const host = node("root"); app.mount(host);
  if (waitForReady) await until(() => !!button(host, "Save theme"));
  const refreshSessionPrincipal = async value => {
    currentSession.value = { ...currentSession.value, principal: value };
    await nextTick();
  };
  return { app, host, updates, refreshSessionPrincipal };
}
function problem(status, code, category, details = {}) {
  const requestId = "00000000-0000-4000-8000-000000000099";
  return Response.json({ category, code, details, message: "Test failure", recovery: category === "conflict" ? "refresh_resource" : "fix_input", request_id: requestId, retryable: false, source: "service" }, { status, headers: { "x-request-id": requestId } });
}
function readResponse(path, current) { return Response.json(path.endsWith("/passkeys") ? { items: [], truncated: false } : current); }

test("profile theme selection stays a draft until a confirmed save, then emits the saved preference once", async () => {
  const writes = []; let finishSave;
  globalThis.fetch = async (path, init) => {
    if (init?.method !== "PATCH") return readResponse(path, principal());
    writes.push(JSON.parse(init.body));
    return new Promise(resolve => { finishSave = () => resolve(Response.json({ resource: principal({ theme: "blue", version: 4 }) })); });
  };
  const { app, host, updates } = await mount();
  try {
    assert.equal(button(host, "Save theme").props.disabled, true);
    await chooseTheme(host, "blue");
    assert.equal(document.documentElement.dataset.theme, "orange");
    assert.equal(updates.length, 1, "a local radio change must not emit an applied preference");
    const saving = submit(host);
    await until(() => !!finishSave);
    assert.deepEqual(writes, [{ theme: "blue", expected_version: 3 }]);
    assert.equal(document.documentElement.dataset.theme, "orange");
    assert.equal(button(host, "Save theme").props.disabled, true);
    finishSave(); await saving; await nextTick();
    assert.equal(document.documentElement.dataset.theme, "blue");
    assert.equal(updates.length, 2);
    assert.equal(updates.at(-1).version, 4);
    assert.match(text(host), /Theme preference saved/);
    await submit(host);
    assert.equal(writes.length, 1, "saving the same theme does not create another write");
  } finally { app.unmount(); }
});

test("failed theme save keeps the selection and applied theme separate", async () => {
  const writes = [];
  globalThis.fetch = async (path, init) => {
    if (init?.method !== "PATCH") return readResponse(path, principal());
    writes.push(JSON.parse(init.body));
    return problem(400, "VALIDATION_ERROR", "validation");
  };
  const { app, host, updates } = await mount();
  try {
    await chooseTheme(host, "blue"); await submit(host); await nextTick();
    assert.equal(document.documentElement.dataset.theme, "orange");
    assert.equal(updates.length, 1);
    assert.equal(radio(host, "blue").checked, true);
    assert.equal(button(host, "Save theme").props.disabled, false);
    assert.doesNotMatch(text(host), /Theme preference saved/);
    assert.match(text(host), /VALIDATION_ERROR/);
    assert.deepEqual(writes, [{ theme: "blue", expected_version: 3 }]);
  } finally { app.unmount(); }
});

test("theme CAS conflict preserves the draft, reads the current version, and retries only on a new explicit save", async () => {
  const writes = []; let meReads = 0;
  globalThis.fetch = async (path, init) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(init.body));
      if (writes.length === 1) return problem(409, "VERSION_CONFLICT", "conflict", { current_version: 7 });
      return Response.json({ resource: principal({ theme: "blue", version: 8 }) });
    }
    if (!path.endsWith("/passkeys")) meReads++;
    return readResponse(path, principal({ version: meReads > 1 ? 7 : 3 }));
  };
  const { app, host, updates } = await mount();
  try {
    await chooseTheme(host, "blue"); await submit(host); await nextTick();
    assert.equal(meReads, 2);
    assert.equal(writes.length, 1, "CAS readback cannot replay the user's update");
    assert.equal(radio(host, "blue").checked, true);
    assert.equal(document.documentElement.dataset.theme, "orange");
    assert.equal(updates.at(-1).version, 7);
    assert.match(text(host), /remote version is v7.*latest fact was read back/);
    assert.deepEqual(JSON.parse(all(host).find(item => item.tag === "textarea" && item.props.readonly !== undefined).props.value), { theme: "blue" });
    await submit(host); await nextTick();
    assert.deepEqual(writes, [{ theme: "blue", expected_version: 3 }, { theme: "blue", expected_version: 7 }]);
    assert.equal(document.documentElement.dataset.theme, "blue");
    assert.equal(updates.at(-1).version, 8);
  } finally { app.unmount(); }
});

test("display-name saves preserve the server theme and an independently edited theme draft", async () => {
  const writes = [];
  globalThis.fetch = async (path, init) => {
    if (init?.method !== "PATCH") return readResponse(path, principal({ theme: "blue" }));
    writes.push(JSON.parse(init.body));
    return Response.json({ resource: principal({ display_name: "Jordan", theme: "blue", version: 4 }) });
  };
  const { app, host, updates } = await mount();
  try {
    await chooseTheme(host, "orange");
    const nameInput = all(form(host, false)).find(item => item.tag === "input");
    nameInput.props["onUpdate:modelValue"]("Jordan"); await nextTick();
    await submit(host, false); await nextTick();
    assert.deepEqual(writes, [{ display_name: "Jordan", expected_version: 3 }]);
    assert.equal(updates.at(-1).theme, "blue");
    assert.equal(document.documentElement.dataset.theme, "blue");
    assert.equal(radio(host, "orange").checked, true, "saving the name must preserve the unsaved theme choice");
    assert.equal(button(host, "Save theme").props.disabled, false);
  } finally { app.unmount(); }
});


test("principal theme reconciliation ignores older facts and never inherits a different identity's theme", () => {
  const current = principal({ theme: "blue", version: 8 });
  assert.equal(latestPrincipalTheme(current, principal({ theme: "orange", version: 7 })), current);
  const newer = principal({ theme: "orange", version: 9 });
  assert.equal(latestPrincipalTheme(current, newer), newer);
  const withoutTheme = principal({ version: 9 });
  delete withoutTheme.theme;
  assert.deepEqual(latestPrincipalTheme(current, withoutTheme), { ...withoutTheme, theme: "blue" });
  const differentIdentity = { ...withoutTheme, id: "00000000-0000-4000-8000-000000000002", version: 1 };
  assert.equal(latestPrincipalTheme(current, differentIdentity), differentIdentity);
  assert.equal("theme" in latestPrincipalTheme(current, differentIdentity), false);
  assert.equal(latestPrincipalTheme(undefined, withoutTheme), withoutTheme);
});

test("a delayed initial profile read keeps the newer session facts and uses their version for the next save", async () => {
  const writes = []; let finishRead;
  globalThis.fetch = async (path, init) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(init.body));
      return Response.json({ resource: principal({ display_name: "Remote", theme: "orange", version: 7 }) });
    }
    if (path.endsWith("/passkeys")) return readResponse(path, principal());
    return new Promise(resolve => { finishRead = () => resolve(Response.json(principal())); });
  };
  const { app, host, updates, refreshSessionPrincipal } = await mount(session, false);
  try {
    await until(() => !!finishRead);
    await refreshSessionPrincipal(principal({ display_name: "Remote", theme: "blue", version: 6 }));
    finishRead(); await until(() => !!button(host, "Save theme"));
    assert.equal(radio(host, "blue").checked, true);
    assert.equal(all(form(host, false)).find(item => item.tag === "input").props.value, "Remote");
    assert.equal(updates.at(-1).version, 6);
    assert.equal(document.documentElement.dataset.theme, "blue");
    await chooseTheme(host, "orange"); await submit(host); await nextTick();
    assert.deepEqual(writes, [{ theme: "orange", expected_version: 6 }]);
  } finally { app.unmount(); }
});

for (const queueRevalidation of [false, true]) {
  test(`a delayed session read cannot replace a verified identity switch${queueRevalidation ? " or consume its queued revalidation" : ""}`, async () => {
    const oldSession = { ...session, session_id: "old-session", expires_at: new Date(Date.now() + 60_000).toISOString(), target: { kind: "project_selection" } };
    const switchedSession = {
      ...oldSession, session_id: "switched-session",
      principal: principal({ id: "00000000-0000-4000-8000-000000000002", display_name: "Other", theme: "blue", version: 1 }),
    };
    const pending = []; let reads = 0;
    globalThis.fetch = async path => {
      if (path === "/.well-known/cfkanban-instance.json") return Response.json({ preferred_api_origin: "https://example.test" });
      if (++reads === 1) return Response.json(oldSession);
      return new Promise(resolve => { pending.push(value => resolve(Response.json(value))); });
    };
    const app = renderer.createApp({ ...AppSession, render: () => null });
    app.mount(node("root"));
    const state = app._instance.setupState;
    try {
      await until(() => state.session?.session_id === oldSession.session_id);
      const oldRead = state.loadSession(false);
      await until(() => pending.length === 1);
      if (queueRevalidation) state.authorizationStale();
      const generation = state.sessionViewGeneration;
      state.acceptVerifiedSession(switchedSession);
      await nextTick();
      assert.equal(state.sessionViewGeneration, generation + 1);
      assert.equal(state.session.session_id, switchedSession.session_id);
      assert.equal(document.documentElement.dataset.theme, "blue");
      pending[0](oldSession); await oldRead; await nextTick();
      assert.equal(state.session.session_id, switchedSession.session_id);
      assert.equal(state.session.principal.id, switchedSession.principal.id);
      assert.equal(document.documentElement.dataset.theme, "blue");
      if (queueRevalidation) {
        await until(() => pending.length === 2);
        assert.equal(state.loadingSession, true, "the stale request cannot finish a newer revalidation");
        pending[1](switchedSession);
        await until(() => state.loadingSession === false);
        assert.equal(reads, 3, "the pending revalidation is performed once");
      } else {
        assert.equal(state.loadingSession, false);
        const refreshed = state.loadSession(false);
        await until(() => pending.length === 2);
        pending[1](switchedSession); await refreshed;
        assert.equal(state.loadingSession, false);
      }
      assert.equal(state.session.session_id, switchedSession.session_id);
      assert.equal(state.sessionViewGeneration, generation + 1);
    } finally { app.unmount(); }
  });
}

test("an untouched profile follows newer session facts and uses their version for the next theme save", async () => {
  const writes = [];
  globalThis.fetch = async (path, init) => {
    if (init?.method !== "PATCH") return readResponse(path, principal());
    writes.push(JSON.parse(init.body));
    return Response.json({ resource: principal({ display_name: "Remote", theme: "orange", version: 7 }) });
  };
  const { app, host, updates, refreshSessionPrincipal } = await mount();
  try {
    await refreshSessionPrincipal(principal({ display_name: "Remote", theme: "blue", version: 6 }));
    assert.equal(radio(host, "blue").checked, true);
    assert.equal(all(form(host, false)).find(item => item.tag === "input").props.value, "Remote");
    assert.equal(button(host, "Save theme").props.disabled, true);
    assert.equal(updates.length, 1, "observing session facts does not publish another profile write result");
    assert.deepEqual(writes, []);
    await refreshSessionPrincipal(principal({ display_name: "Obsolete", theme: "orange", version: 4 }));
    assert.equal(radio(host, "blue").checked, true);
    assert.equal(all(form(host, false)).find(item => item.tag === "input").props.value, "Remote");
    await chooseTheme(host, "orange"); await submit(host); await nextTick();
    assert.deepEqual(writes, [{ theme: "orange", expected_version: 6 }]);
  } finally { app.unmount(); }
});

test("session refresh preserves both profile drafts while advancing the version used by an explicit save", async () => {
  const writes = [];
  globalThis.fetch = async (path, init) => {
    if (init?.method !== "PATCH") return readResponse(path, principal());
    writes.push(JSON.parse(init.body));
    return Response.json({ resource: principal({ display_name: "Jordan", theme: "orange", version: 7 }) });
  };
  const { app, host, refreshSessionPrincipal } = await mount();
  try {
    await chooseTheme(host, "blue");
    all(form(host, false)).find(item => item.tag === "input").props["onUpdate:modelValue"]("Jordan");
    await nextTick();
    await refreshSessionPrincipal(principal({ display_name: "Remote", theme: "orange", version: 6 }));
    assert.equal(radio(host, "blue").checked, true);
    assert.equal(all(form(host, false)).find(item => item.tag === "input").props.value, "Jordan");
    assert.equal(button(host, "Save theme").props.disabled, false);
    assert.deepEqual(writes, []);
    await submit(host, false); await nextTick();
    assert.deepEqual(writes, [{ display_name: "Jordan", expected_version: 6 }]);
    assert.equal(radio(host, "blue").checked, true);
  } finally { app.unmount(); }
});

test("a late theme PATCH replay cannot replace a newer principal received from the session", async () => {
  const writes = []; let finishSave;
  globalThis.fetch = async (path, init) => {
    if (init?.method !== "PATCH") return readResponse(path, principal());
    writes.push(JSON.parse(init.body));
    if (writes.length === 1) return new Promise(resolve => {
      finishSave = () => resolve(Response.json({ resource: principal({ theme: "blue", version: 4 }), idempotent_replay: true }));
    });
    return Response.json({ resource: principal({ display_name: "Remote", theme: "blue", version: 6 }) });
  };
  const { app, host, updates, refreshSessionPrincipal } = await mount();
  try {
    await chooseTheme(host, "blue"); const saving = submit(host);
    await until(() => !!finishSave);
    await refreshSessionPrincipal(principal({ display_name: "Remote", theme: "orange", version: 5 }));
    finishSave(); await saving; await nextTick();
    assert.equal(updates.at(-1).version, 5);
    assert.equal(updates.at(-1).theme, "orange");
    assert.equal(updates.at(-1).display_name, "Remote");
    assert.equal(document.documentElement.dataset.theme, "orange");
    assert.equal(radio(host, "orange").checked, true);
    await chooseTheme(host, "blue"); await submit(host); await nextTick();
    assert.deepEqual(writes, [{ theme: "blue", expected_version: 3 }, { theme: "blue", expected_version: 5 }]);
  } finally { app.unmount(); }
});

for (const updateKind of ["theme", "name"]) {
  test(`a ${updateKind} PATCH response without is_owner preserves the verified Owner role`, async () => {
    const owner = principal({ is_owner: true });
    globalThis.fetch = async (path, init) => {
      if (init?.method !== "PATCH") return readResponse(path, owner);
      const saved = principal({ is_owner: true, theme: "blue", display_name: updateKind === "name" ? "Jordan" : "Pat", version: 4 });
      delete saved.is_owner;
      return Response.json({ resource: saved });
    };
    const { app, host, updates } = await mount({ ...session, principal: owner });
    try {
      if (updateKind === "theme") await chooseTheme(host, "blue");
      else { all(form(host, false)).find(item => item.tag === "input").props["onUpdate:modelValue"]("Jordan"); await nextTick(); }
      await submit(host, updateKind === "theme"); await nextTick();
      assert.equal(updates.at(-1).is_owner, true);
      assert.equal(updates.at(-1).version, 4);
      assert.match(text(host), /Deployment Owner/);
      assert.doesNotMatch(text(host), /Project participant/);
    } finally { app.unmount(); }
  });
}
