import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive, ref } from "vue";
import { nuxtUiTestPlugin } from "./nuxt-ui-test-plugin.mjs";

const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const events = new EventTarget();
globalThis.window = { navigator: { languages: ["en"] }, location: { pathname: "/app/issues/CFK-1", search: "" }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), setTimeout, clearTimeout, scrollTo() {}, history: { pushState(_state, _unused, path) { const url = new URL(path, "https://example.test"); window.location.pathname = url.pathname; window.location.search = url.search; }, replaceState(_state, _unused, path) { this.pushState(_state, _unused, path); } } };
globalThis.document = { cookie: "cfkanban_csrf=draft-test", visibilityState: "visible", documentElement: { dataset: {}, toggleAttribute() {} }, addEventListener() {}, removeEventListener() {} };
const root = new URL("../../", import.meta.url).pathname;
const output = await build({ stdin: { contents: `export * from './apps/web/src/lib/session-drafts.ts'; export { apiRequest, clearPendingRequestIntents } from './apps/web/src/lib/api.ts'; export { default as Issue } from './apps/web/src/views/IssueDetailView.vue'; export { default as Board } from './apps/web/src/views/ProjectBoardView.vue'; export { default as App } from './apps/web/src/App.vue'; export { default as DraftsPanel } from './apps/web/src/components/SessionDraftsPanel.vue'; export { default as RenderedDraftsPanel } from './apps/web/src/components/SessionDraftsPanel.vue?rendered';`, resolveDir: root }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [nuxtUiTestPlugin(), { name: "session-drafts-vue", setup(builder) {
  builder.onResolve({ filter: /\.vue\?rendered$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\?rendered$/, "")), namespace: "rendered-session-drafts" }));
  builder.onLoad({ filter: /.*/, namespace: "rendered-session-drafts" }, async ({ path }) => {
    const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
    return { contents: compileScript(descriptor, { id: "rendered-session-drafts", inlineTemplate: true }).content, loader: "ts", resolveDir: dirname(path) };
  });
  builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
    if (![/\/IssueDetailView\.vue$/, /\/ProjectBoardView\.vue$/, /\/App\.vue$/, /\/SessionDraftsPanel\.vue$/].some(pattern => pattern.test(path))) return { contents: "export default {}", loader: "js" };
    const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
    return { contents: compileScript(descriptor, { id: "session-drafts-test" }).content, loader: "ts", resolveDir: dirname(path) };
  });
  builder.onResolve({ filter: /^@nuxt\/ui\/locale$/ }, () => ({ path: "locale", namespace: "session-drafts-test" }));
  builder.onLoad({ filter: /.*/, namespace: "session-drafts-test" }, () => ({ contents: "export const en = {}; export const zh_cn = {};", loader: "js" }));
  builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true }));
} }] });
const { registerSessionTextDraft, retainedSessionTextDrafts, setSessionDraftPrincipal, captureSessionTextDrafts, clearRetainedSessionTextDrafts, canRestoreSessionTextDraft, restoreSessionTextDraft, sessionTextDraftCopy, discardSessionTextDraft, changedTextFields, verifySessionTextDraftIdentity, Issue, Board, App, DraftsPanel, RenderedDraftsPanel, apiRequest, clearPendingRequestIntents } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
afterEach(() => { clearRetainedSessionTextDrafts(); setSessionDraftPrincipal(null); clearPendingRequestIntents("PATCH", "/api/v1/issues/CFK-1"); globalThis.fetch = saved.fetch; });
after(() => Object.assign(globalThis, saved));
const label = { en: "Draft", zh: "草稿" };
const flush = async () => { for (let index = 0; index < 12; index++) { await Promise.resolve(); await nextTick(); } };

test("only explicit changed text is captured; no credential, remote records, or attachment bytes", () => {
  setSessionDraftPrincipal("principal-a");
  const page = { title: "Typed title", body: "Saved body", credential: "sensitive-excluded", file: new Uint8Array([1]), remote: { title: "Remote" } };
  const remove = registerSessionTextDraft({ key: "issue-edit", path: "/app/issues/CFK-1", label, target: () => ({ identifier: "CFK-1" }), capture: () => changedTextFields({ title: [page.title, "Saved title"], body: [page.body, "Saved body"] }), canRestore: () => false, restore: () => assert.fail() });
  try {
    captureSessionTextDrafts("principal-a"); page.title = "Different input";
    assert.deepEqual(retainedSessionTextDrafts.value[0].fields, { title: "Typed title" });
    assert.deepEqual(retainedSessionTextDrafts.value[0].target, { identifier: "CFK-1" });
    assert.equal(sessionTextDraftCopy(retainedSessionTextDrafts.value[0]), "Typed title");
    assert.doesNotMatch(JSON.stringify(retainedSessionTextDrafts.value), /sensitive-excluded|Saved body|Remote|credential|file/);
  } finally { remove(); }
});

test("expiry preserves copyable text after page unmount and same Principal requires explicit authorized restore", async () => {
  setSessionDraftPrincipal("principal-a");
  const remove = registerSessionTextDraft({ key: "comment", path: "/app/issues/CFK-1", label, capture: () => ({ comment: "Unsaved comment" }), canRestore: () => true, restore: () => assert.fail("capture does not restore") });
  captureSessionTextDrafts("principal-a"); remove(); setSessionDraftPrincipal(null);
  const draft = retainedSessionTextDrafts.value[0];
  assert.equal(sessionTextDraftCopy(draft), "Unsaved comment"); assert.equal(canRestoreSessionTextDraft(draft, null), false);
  setSessionDraftPrincipal("principal-a"); let authorized = false, input = "", writes = 0;
  const next = registerSessionTextDraft({ key: "comment", path: "/app/issues/CFK-1", label, capture: () => null, canRestore: () => authorized, restore: fields => { input = fields.comment; } });
  try {
    assert.equal(await restoreSessionTextDraft(draft.id, "principal-a"), false); assert.equal(input, "");
    authorized = true; assert.equal(input, "", "new login never restores automatically");
    assert.equal(await restoreSessionTextDraft(draft.id, "principal-a"), true); assert.equal(input, "Unsaved comment");
    assert.equal(writes, 0); assert.equal(retainedSessionTextDrafts.value.length, 0);
  } finally { next(); }
});

test("different Principals and stale registered pages cannot read or restore old text", async () => {
  setSessionDraftPrincipal("principal-a"); let restores = 0;
  const remove = registerSessionTextDraft({ key: "comment", path: "/app/issues/CFK-1", label, capture: () => ({ comment: "A only" }), canRestore: () => true, restore: () => restores++ });
  try {
    captureSessionTextDrafts("principal-a"); const draft = retainedSessionTextDrafts.value[0];
    setSessionDraftPrincipal("principal-b"); assert.equal(retainedSessionTextDrafts.value.length, 0);
    captureSessionTextDrafts("principal-b"); assert.equal(retainedSessionTextDrafts.value.length, 0);
    assert.equal(await restoreSessionTextDraft(draft.id, "principal-b"), false); assert.equal(restores, 0);
  } finally { remove(); }
});

test("uncertain submissions support copying only; discard and logout clear text", async () => {
  setSessionDraftPrincipal("principal-a");
  const remove = registerSessionTextDraft({ key: "create", path: "/app", label, capture: () => ({ body: "Possibly submitted" }), uncertain: () => true, canRestore: () => true, restore: () => assert.fail("uncertain request must not restore or resend") });
  try {
    captureSessionTextDrafts("principal-a"); const draft = retainedSessionTextDrafts.value[0];
    assert.equal(draft.copyOnly, true); assert.equal(await restoreSessionTextDraft(draft.id, "principal-a"), false);
    assert.equal(sessionTextDraftCopy(draft), "Possibly submitted"); discardSessionTextDraft(draft.id);
    assert.equal(retainedSessionTextDrafts.value.length, 0); captureSessionTextDrafts("principal-a"); clearRetainedSessionTextDrafts(); assert.equal(retainedSessionTextDrafts.value.length, 0);
  } finally { remove(); }
});

test("discard or Principal switch during resource verification cancels restore", async () => {
  for (const switchPrincipal of [false, true]) {
    setSessionDraftPrincipal("principal-a"); let release, applied = false;
    const remove = registerSessionTextDraft({ key: "project", path: "/app", label, capture: () => ({ context: "Draft notes" }), canRestore: () => true, restore: async (_fields, _target, isCurrent) => { await new Promise(resolve => { release = resolve; }); if (!isCurrent()) return false; applied = true; } });
    try {
      captureSessionTextDrafts("principal-a"); const draft = retainedSessionTextDrafts.value[0];
      const restoring = restoreSessionTextDraft(draft.id, "principal-a");
      assert.equal(await restoreSessionTextDraft(draft.id, "principal-a"), false, "one restore per draft");
      if (switchPrincipal) setSessionDraftPrincipal("principal-b"); else discardSessionTextDraft(draft.id);
      release(); assert.equal(await restoring, false); assert.equal(applied, false);
    } finally { remove(); }
  }
});

function node(tag = "root", text = "") { return { tag, text, props: {}, children: [], parent: null }; }
const renderer = createRenderer({ createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text), setText(target, text) { target.text = text; }, setElementText(target, text) { target.text = text; target.children = []; }, patchProp(target, key, _previous, value) { target.props[key] = value; }, insert(target, parent, anchor = null) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = parent; const index = parent.children.indexOf(anchor); if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target); }, remove(target) { if (target.parent) { target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = null; } }, parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null });
const workspaceId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222";
const session = { principal: { id: "principal-a", display_name: "Pat", version: 1, is_owner: false }, session_id: "session-a", expires_at: new Date(Date.now() + 8 * 3600000).toISOString(), source: { kind: "credential", id: "source" }, target: { kind: "project_selection" }, allowed_scope: { kind: "project_selection", projects: [{ workspace_id: workspaceId, project_id: projectId, role: "writer" }] } };
const issue = { id: "issue", identifier: "CFK-1", title: "Remote title", body: "Remote body", deleted_at: null, version: 3, priority: "none", status: { key: "todo", display_name: "To do" }, assignee: null, labels: [], allowed_actions: ["update"], workspace: { id: workspaceId, display_name: "Team" }, project: { id: projectId, display_name: "Project" } };
function mount(component, props = {}) { const app = renderer.createApp({ render: () => h({ ...component, render: () => null }, props) }); app.mount(node()); return { app, state: app._instance.subTree.component.setupState }; }

const openMilestone = { id: "33333333-3333-4333-8333-333333333333", title: "Release", status_key: "open", due_date: null };
const closedMilestone = { id: "44444444-4444-4444-8444-444444444444", title: "Previous release", status_key: "closed", due_date: "2026-10-30" };
async function milestoneIssueFixture(onPatch) {
  const fixture = { remote: { ...issue, milestone: null }, writes: [], reads: 0 };
  fixture.commit = milestoneId => {
    fixture.remote = { ...fixture.remote, version: fixture.remote.version + 1, milestone: milestoneId === undefined ? fixture.remote.milestone : milestoneId === null ? null : [openMilestone, closedMilestone].find(item => item.id === milestoneId) };
    return { resource: structuredClone(fixture.remote) };
  };
  globalThis.fetch = async (path, init) => {
    assert.ok(path.startsWith("/api/v1/"), "the fixture handles only isolated relative API requests");
    if (path === "/api/v1/issues/CFK-1" && init.method === "PATCH") {
      const request = { body: JSON.parse(init.body), key: init.headers.get("idempotency-key") };
      fixture.writes.push(request);
      return onPatch ? onPatch(fixture, request) : Response.json(fixture.commit(request.body.milestone_id));
    }
    assert.equal(init.method, "GET");
    if (path === "/api/v1/issues/CFK-1") { fixture.reads++; return Response.json(fixture.remote); }
    return Response.json({ items: [], next_cursor: null });
  };
  Object.assign(fixture, mount(Issue, { identifier: "CFK-1", session }));
  await flush();
  return fixture;
}

test("actual Issue milestone shortcuts save only membership and preserve text drafts while blocking unchanged or unavailable edits", async () => {
  const f = await milestoneIssueFixture();
  try {
    f.state.editMode = true; f.state.edit.body = "Unsaved description"; f.state.edit.title = "Unsaved title"; f.state.edit.milestone = closedMilestone.id;
    f.state.saveMilestone("none"); await flush(); assert.equal(f.writes.length, 0);
    f.state.saveMilestone(openMilestone.id); await flush();
    assert.deepEqual(f.writes[0].body, { expected_version: 3, milestone_id: openMilestone.id });
    assert.equal(f.state.issue.milestone.id, openMilestone.id);
    f.state.saveMilestone(openMilestone.id); await flush(); assert.equal(f.writes.length, 1);
    f.state.saveMilestone(closedMilestone.id); await flush();
    f.state.saveMilestone("none"); await flush();
    assert.deepEqual(f.writes.map(request => request.body), [
      { expected_version: 3, milestone_id: openMilestone.id },
      { expected_version: 4, milestone_id: closedMilestone.id },
      { expected_version: 5, milestone_id: null },
    ]);
    assert.equal(f.state.issue.milestone, null);
    assert.equal(f.state.edit.milestone, closedMilestone.id, "a separate draft stays independent even when a shortcut temporarily matches it");
    assert.equal(f.state.editMode, true); assert.equal(f.state.edit.body, "Unsaved description"); assert.equal(f.state.edit.title, "Unsaved title");
    f.state.busy = true; f.state.saveMilestone(openMilestone.id); f.state.busy = false;
    f.state.issue.allowed_actions = []; f.state.saveMilestone(openMilestone.id);
    f.state.issue.allowed_actions = ["update"]; delete f.state.issue.milestone; f.state.saveMilestone(openMilestone.id);
    await flush(); assert.equal(f.writes.length, 3, "busy, reader and older Service projections do not dispatch");
    assert.ok(f.writes.every(request => typeof request.key === "string" && request.key.length > 0));
    await f.state.load(false); await flush();
    f.state.edit.body = "Another unsaved description";
    for (const milestone of [openMilestone.id, closedMilestone.id, "none", openMilestone.id]) {
      f.state.saveMilestone(milestone); await flush();
      assert.equal(f.state.edit.milestone, milestone, "an unchanged membership draft follows each shortcut");
    }
    await f.state.saveEdit(); await flush();
    assert.deepEqual(f.writes.at(-1).body, { expected_version: 10, body: "Another unsaved description", priority_key: "none", title: "Remote title" });
    assert.equal(f.state.issue.milestone.id, openMilestone.id, "saving text does not undo the shortcut assignment");
    assert.equal(f.state.editMode, false);
  } finally { f.app.unmount(); }
});

test("actual Issue milestone unknown or invalid success responses recover the exact original body and key without closing the editor", async () => {
  for (const invalidSuccess of [false, true]) {
    let committed;
    const f = await milestoneIssueFixture((fixture, request) => {
      if (fixture.writes.length === 1) {
        committed = fixture.commit(request.body.milestone_id);
        if (!invalidSuccess) throw new Error("Synthetic response lost after commit");
        return Response.json({ resource: { ...committed.resource, project: { id: workspaceId } } });
      }
      return Response.json({ ...committed, idempotent_replay: true });
    });
    try {
      f.state.editMode = true; f.state.edit.body = "Keep this unsaved description";
      f.state.saveMilestone(closedMilestone.id); await flush();
      assert.equal(f.writes.length, 1);
      assert.equal(f.state.issue.milestone, null, "membership waits for a valid confirmed resource");
      assert.deepEqual(f.state.pendingMilestoneEdit, { expected_version: 3, milestone_id: closedMilestone.id });
      assert.equal(f.state.pendingMilestoneClosesEditor, false);
      assert.equal(f.state.writeBusy, true);
      f.state.saveMilestone("none"); await flush(); assert.equal(f.writes.length, 1);
      await f.state.updateIssue(f.state.pendingMilestoneEdit, f.state.pendingMilestoneClosesEditor); await flush();
      assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1], f.writes[0]);
      assert.equal(f.state.pendingMilestoneEdit, null); assert.equal(f.state.writeBusy, false);
      assert.equal(f.state.issue.milestone.id, closedMilestone.id);
      assert.equal(f.state.editMode, true); assert.equal(f.state.edit.body, "Keep this unsaved description");
    } finally { f.app.unmount(); clearPendingRequestIntents("PATCH", "/api/v1/issues/CFK-1"); }
  }
});

test("actual Issue milestone CAS conflict reads current facts and keeps the draft without automatic replay", async () => {
  const f = await milestoneIssueFixture((fixture, request) => {
    if (fixture.writes.length > 1) return Response.json(fixture.commit(request.body.milestone_id));
    fixture.remote = { ...fixture.remote, version: 7, body: "Changed remotely" };
    const requestId = crypto.randomUUID();
    return Response.json({ category: "conflict", code: "VERSION_CONFLICT", details: { current_version: 7 }, message: "Changed concurrently", recovery: "refresh_resource", request_id: requestId, retryable: false, source: "service" }, { status: 409, headers: { "x-request-id": requestId } });
  });
  try {
    f.state.editMode = true; f.state.edit.body = "My unsaved description";
    f.state.saveMilestone(openMilestone.id); await flush(); await flush();
    assert.equal(f.writes.length, 1); assert.equal(f.reads, 2);
    assert.equal(f.state.issue.version, 7); assert.equal(f.state.issue.milestone, null);
    assert.equal(f.state.casConflict.readbackState, "complete");
    assert.equal(f.state.editMode, true); assert.equal(f.state.edit.body, "My unsaved description");
    f.state.saveMilestone(closedMilestone.id); await flush(); assert.equal(f.writes.length, 1);
    f.state.dismissCasConflict(); f.state.saveMilestone(closedMilestone.id); await flush();
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.writes[1].body, { expected_version: 7, milestone_id: closedMilestone.id });
    assert.notEqual(f.writes[1].key, f.writes[0].key, "an explicit decision with current CAS is a new operation");
  } finally { f.app.unmount(); }
});

test("late-mounted draft panel offers copy fallback and restores only after explicit confirmation", async () => {
  setSessionDraftPrincipal(session.principal.id); let input = "", confirmations = 0, confirmed = false;
  const remove = registerSessionTextDraft({ key: "panel-comment", path: "/app/issues/CFK-1", label, capture: () => ({ comment: "Retained before panel loads" }), canRestore: () => true, restore: fields => { input = fields.comment; } });
  captureSessionTextDrafts(session.principal.id); const draft = retainedSessionTextDrafts.value[0];
  const mounted = mount(DraftsPanel, { session });
  const previousConfirm = window.confirm;
  window.confirm = () => { confirmations++; return confirmed; };
  try {
    assert.equal(input, ""); await mounted.state.copyDraft(draft);
    assert.equal(mounted.state.copiedDraftId, draft.id, "copy fallback remains available without clipboard capability");
    assert.equal(sessionTextDraftCopy(draft), "Retained before panel loads");
    await mounted.state.restoreDraft(draft); assert.equal(input, ""); assert.equal(retainedSessionTextDrafts.value.length, 1);
    confirmed = true; await mounted.state.restoreDraft(draft);
    assert.equal(confirmations, 2); assert.equal(input, "Retained before panel loads"); assert.equal(retainedSessionTextDrafts.value.length, 0);
  } finally { window.confirm = previousConfirm; remove(); mounted.app.unmount(); }
});

test("draft panel cannot resume pending restore after logout or Principal change", async () => {
  const previousConfirm = window.confirm; window.confirm = () => true;
  try {
    for (const changedPrincipal of [false, true]) {
      setSessionDraftPrincipal(session.principal.id); let finish, applied = false;
      const remove = registerSessionTextDraft({ key: "panel-pending", path: "/app/issues/CFK-1", label, capture: () => ({ comment: "Only A may restore" }), canRestore: () => true, restore: async (_fields, _target, isCurrent) => { await new Promise(resolve => { finish = resolve; }); if (!isCurrent()) return false; applied = true; } });
      captureSessionTextDrafts(session.principal.id); const draft = retainedSessionTextDrafts.value[0];
      const mounted = mount(DraftsPanel, { session });
      try {
        const restoring = mounted.state.restoreDraft(draft);
        if (changedPrincipal) setSessionDraftPrincipal("principal-b");
        else { clearRetainedSessionTextDrafts(); setSessionDraftPrincipal(null); }
        finish(); await restoring; await mounted.state.restoreDraft(draft);
        assert.equal(applied, false); assert.equal(retainedSessionTextDrafts.value.length, 0);
      } finally { remove(); mounted.app.unmount(); }
    }
  } finally { window.confirm = previousConfirm; }
});

test("real draft panel template reacts to late page registration, readiness, removal, and a new same-Principal Session", async () => {
  setSessionDraftPrincipal(session.principal.id);
  const original = registerSessionTextDraft({ key: "rendered-comment", path: "/app/issues/CFK-1", label, capture: () => ({ comment: "Text captured before expiry" }), canRestore: () => true, restore: () => assert.fail("old form never restores") });
  captureSessionTextDrafts(session.principal.id); original(); setSessionDraftPrincipal(null);
  const props = reactive({ session: null }); const tree = node();
  const app = renderer.createApp({ render: () => h(RenderedDraftsPanel, { session: props.session }) }); app.mount(tree);
  const find = (target, text) => target.tag === "button" && target.text === text ? target : target.children.map(child => find(child, text)).find(Boolean);
  const currentSession = { ...session, session_id: "new-session" }; const ready = ref(false); let remove = () => {}, input = "";
  const calls = []; const previousConfirm = window.confirm; window.confirm = () => true;
  globalThis.fetch = async (path, init) => { calls.push({ path, method: init.method }); return Response.json(currentSession); };
  const registration = { key: "rendered-comment", path: "/app/issues/CFK-1", label, capture: () => ({ comment: input }), canRestore: () => ready.value, restore: async (fields, _target, isCurrent) => { if (!await verifySessionTextDraftIdentity(isCurrent) || !isCurrent()) return false; input = fields.comment; } };
  try {
    await flush(); assert.ok(find(tree, "Copy text")); assert.equal(find(tree, "Restore text"), undefined);
    setSessionDraftPrincipal(session.principal.id); props.session = currentSession; await flush();
    assert.equal(find(tree, "Restore text"), undefined, "new Session alone does not authorize an unloaded form");
    remove = registerSessionTextDraft(registration); await flush(); assert.equal(find(tree, "Restore text"), undefined);
    ready.value = true; await flush(); assert.ok(find(tree, "Restore text"), "late page readiness reveals restore without another parent render");
    remove(); await flush(); assert.equal(find(tree, "Restore text"), undefined, "unmounted form immediately removes restore");
    remove = registerSessionTextDraft(registration); await flush(); await find(tree, "Restore text").props.onClick(); await flush();
    assert.equal(input, "Text captured before expiry"); assert.equal(retainedSessionTextDrafts.value.length, 0);
    assert.deepEqual(calls, [{ path: "/api/v1/web-session", method: "GET" }]);
    captureSessionTextDrafts(session.principal.id); await flush(); assert.ok(find(tree, "Restore text"));
    clearRetainedSessionTextDrafts(); setSessionDraftPrincipal(null); props.session = null; await flush();
    assert.equal(find(tree, "Restore text"), undefined); assert.equal(find(tree, "Copy text"), undefined, "explicit logout removes the rendered draft panel");
    setSessionDraftPrincipal(session.principal.id); props.session = currentSession; captureSessionTextDrafts(session.principal.id); await flush();
    assert.ok(find(tree, "Restore text"));
    setSessionDraftPrincipal("principal-b"); props.session = { ...currentSession, principal: { ...currentSession.principal, id: "principal-b" } }; await flush();
    assert.equal(find(tree, "Restore text"), undefined); assert.equal(find(tree, "Copy text"), undefined); assert.equal(retainedSessionTextDrafts.value.length, 0);
  } finally { remove(); app.unmount(); window.confirm = previousConfirm; }
});

test("actual Issue edit/comment/completion getters clear remote state and restore only on explicit action", async () => {
  setSessionDraftPrincipal(session.principal.id); const calls = [];
  globalThis.fetch = async (path, init) => { calls.push({ path, method: init.method }); return Response.json(path === "/api/v1/web-session" ? session : path.endsWith("/CFK-1") ? issue : { items: [], next_cursor: null }); };
  const first = mount(Issue, { identifier: "CFK-1", session }); await flush();
  first.state.editMode = true; first.state.edit.title = "Typed title"; first.state.comment = "Typed comment"; first.state.completionSummary = "Typed summary";
  captureSessionTextDrafts(session.principal.id); first.app.unmount(); setSessionDraftPrincipal(null);
  assert.equal(retainedSessionTextDrafts.value.length, 3);
  assert.doesNotMatch(JSON.stringify(retainedSessionTextDrafts.value), /Remote body|Remote title|version/);
  setSessionDraftPrincipal(session.principal.id); const next = mount(Issue, { identifier: "CFK-1", session: { ...session, session_id: "new-session" } }); await flush();
  try {
    assert.equal(next.state.comment, ""); assert.equal(next.state.edit.title, "Remote title");
    for (const draft of [...retainedSessionTextDrafts.value]) assert.equal(await restoreSessionTextDraft(draft.id, session.principal.id), true);
    assert.equal(next.state.edit.title, "Typed title"); assert.equal(next.state.edit.body, "Remote body");
    assert.equal(next.state.comment, "Typed comment"); assert.equal(next.state.completionSummary, "Typed summary");
    assert.ok(calls.every(call => call.method === "GET"), "restoring draft text never submits");
  } finally { next.app.unmount(); }
});

test("a Cookie Principal change while the tab still shows the old identity cannot restore an Issue draft", async () => {
  setSessionDraftPrincipal(session.principal.id); const calls = []; let cookieChanged = false;
  globalThis.fetch = async (path, init) => { calls.push(init.method); return Response.json(path === "/api/v1/web-session" ? { ...session, principal: { ...session.principal, id: cookieChanged ? "principal-b" : session.principal.id } } : path.endsWith("/CFK-1") ? issue : { items: [], next_cursor: null }); };
  const first = mount(Issue, { identifier: "CFK-1", session }); await flush(); first.state.comment = "A comment";
  captureSessionTextDrafts(session.principal.id); first.app.unmount();
  const next = mount(Issue, { identifier: "CFK-1", session: { ...session, session_id: "new-session" } }); await flush();
  try {
    cookieChanged = true;
    assert.equal(await restoreSessionTextDraft(retainedSessionTextDrafts.value[0].id, session.principal.id), false);
    assert.equal(next.state.comment, ""); assert.equal(sessionTextDraftCopy(retainedSessionTextDrafts.value[0]), "A comment");
    assert.ok(calls.every(method => method === "GET"));
  } finally { next.app.unmount(); }
});

test("App same-session deadline updates keep page generation and explicit logout clears retained text", async () => {
  globalThis.fetch = async (path, init) => path === "/.well-known/cfkanban-instance.json" ? Response.json({ preferred_api_origin: "https://example.test" }) : init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(session);
  const mounted = mount(App); await flush();
  const remove = registerSessionTextDraft({ key: "comment", path: "/app/issues/CFK-1", label, capture: () => ({ comment: "Current input" }), canRestore: () => true, restore() {} });
  try {
    const generation = mounted.state.sessionViewGeneration;
    mounted.state.acceptVerifiedSession({ ...session, version: 2, expires_at: new Date(Date.now() + 9 * 3600000).toISOString(), renewal: { renew_after: new Date(Date.now() + 1800000).toISOString(), absolute_expires_at: new Date(Date.now() + 7 * 86400000).toISOString() } });
    assert.equal(mounted.state.sessionViewGeneration, generation);
    mounted.state.clearSession(true); assert.equal(retainedSessionTextDrafts.value.length, 1);
    mounted.state.acceptVerifiedSession({ ...session, session_id: "new-session" });
    await mounted.state.logout(); assert.equal(retainedSessionTextDrafts.value.length, 0); assert.equal(mounted.state.session, null);
  } finally { remove(); mounted.app.unmount(); }
});

test("actual App renewal isolates new Session intents while uncertain same-Session retries keep their key", async () => {
  const previousNow = Date.now; let now = previousNow(); Date.now = () => now;
  window.history.replaceState(null, "", "/app/issues/CFK-1"); window.dispatchEvent(new Event("popstate"));
  const calls = [];
  const renewalFacts = id => ({ ...session, session_id: id, version: 1, expires_at: new Date(now + 8 * 3600000).toISOString(), renewal: { renew_after: new Date(now - 1).toISOString(), absolute_expires_at: new Date(now + 7 * 86400000).toISOString() } });
  let server = renewalFacts("intent-session-a");
  globalThis.fetch = async (path, init) => {
    if (path === "/.well-known/cfkanban-instance.json") return Response.json({ preferred_api_origin: "https://example.test" });
    if (path !== "/api/v1/web-session/renew") return Response.json(server);
    calls.push({ body: JSON.parse(init.body), key: init.headers.get("idempotency-key") });
    if (server.session_id === "intent-session-a") throw new Error("renewal response lost");
    server = { ...server, version: 2, renewal: { ...server.renewal, renew_after: new Date(now + 1800000).toISOString() } };
    return Response.json({ event_cursor: "renewal-event", idempotent_replay: false, resource: { session_id: server.session_id, version: server.version, expires_at: server.expires_at, ...server.renewal, renewed: true } });
  };
  const mounted = mount(App); await flush();
  try {
    mounted.state.sessionRenewal.activity({ type: "keydown", isTrusted: true }); await mounted.state.sessionRenewal.revalidate();
    assert.equal(calls.length, 1);
    now += 31000;
    mounted.state.sessionRenewal.activity({ type: "keydown", isTrusted: true }); await mounted.state.sessionRenewal.revalidate();
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
    now += 25 * 3600000;
    await assert.rejects(apiRequest("/api/v1/web-session/renew", { method: "POST", body: { expected_version: 1 }, idempotencyScope: "intent-session-a" }), error => error.body.code === "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED");
    assert.equal(calls.length, 2, "expired A intent cannot acquire a new unsafe retry");
    server = renewalFacts("intent-session-b"); mounted.state.acceptVerifiedSession(server);
    mounted.state.sessionRenewal.activity({ type: "keydown", isTrusted: true }); await mounted.state.sessionRenewal.revalidate(); await flush();
    assert.equal(calls.length, 3, "new B Session version 1 reaches the service despite old expired A intent");
    assert.notEqual(calls[2].key, calls[0].key); assert.deepEqual(calls[2].body, { expected_version: 1 });
    assert.equal(mounted.state.session.session_id, "intent-session-b"); assert.equal(mounted.state.session.version, 2);
  } finally { mounted.state.clearSession(false); mounted.app.unmount(); Date.now = previousNow; }
});
