import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";
import { nuxtUiTestPlugin } from "./nuxt-ui-test-plugin.mjs";

const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const events = new EventTarget();
globalThis.window = {
  navigator: { languages: ["en"] }, location: { pathname: "/app/admin", search: "" },
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events), setTimeout, clearTimeout, scrollTo() {},
  history: { pushState(_state, _unused, path) { const url = new URL(path, "https://example.test"); window.location.pathname = url.pathname; window.location.search = url.search; }, replaceState(_state, _unused, path) { this.pushState(_state, _unused, path); } },
};
globalThis.document = { cookie: "cfkanban_csrf=management-draft-test", visibilityState: "visible", documentElement: { dataset: {}, toggleAttribute() {} }, addEventListener() {}, removeEventListener() {} };

const root = new URL("../../", import.meta.url).pathname;
const output = await build({
  stdin: { contents: `export * from './apps/web/src/lib/session-drafts.ts'; export { clearPendingRequestIntents } from './apps/web/src/lib/api.ts'; export { default as Owner } from './apps/web/src/views/OwnerView.vue'; export { default as Scoped } from './apps/web/src/views/ScopedManagementView.vue'; export { default as Homepage } from './apps/web/src/components/HomepageSettingsPanel.vue';`, resolveDir: root },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  plugins: [nuxtUiTestPlugin(), { name: "management-drafts-vue", setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      if (![/\/OwnerView\.vue$/, /\/ScopedManagementView\.vue$/, /\/HomepageSettingsPanel\.vue$/].some(pattern => pattern.test(path))) return { contents: "export default {}", loader: "js" };
      const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
      return { contents: compileScript(descriptor, { id: "management-drafts-test" }).content, loader: "ts", resolveDir: dirname(path) };
    });
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true }));
  } }],
});
const { Owner, Scoped, Homepage, retainedSessionTextDrafts, setSessionDraftPrincipal, captureSessionTextDrafts, clearRetainedSessionTextDrafts, restoreSessionTextDraft, clearPendingRequestIntents } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);

function node() { return { children: [], parent: null }; }
const renderer = createRenderer({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(target, parent) { target.parent = parent; parent.children.push(target); }, remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); }, parentNode: target => target.parent, nextSibling: () => null });
const mounted = new Set();
function mount(component, props = {}) {
  const app = renderer.createApp({ render: () => h({ ...component, render: () => null }, props) });
  app.mount(node()); mounted.add(app);
  return { state: app._instance.subTree.component.setupState, unmount() { app.unmount(); mounted.delete(app); } };
}
const flush = async () => { for (let index = 0; index < 24; index++) { await Promise.resolve(); await nextTick(); } };
afterEach(() => {
  for (const app of mounted) app.unmount(); mounted.clear();
  clearRetainedSessionTextDrafts(); setSessionDraftPrincipal(null);
  for (const path of ["/api/v1/workspaces", projectCollection, projectPath, homepagePath, ...statusKeys.map(key => `${projectPath}/statuses/${key}`)]) {
    for (const method of ["POST", "PATCH", "PUT"]) clearPendingRequestIntents(method, path);
  }
  globalThis.fetch = saved.fetch;
});
after(() => Object.assign(globalThis, saved));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const workspacePath = `/api/v1/workspaces/${workspaceId}`;
const projectCollection = `${workspacePath}/projects`;
const projectPath = `${projectCollection}/${projectId}`;
const homepagePath = "/api/v1/admin/homepage-settings";
const statusKeys = ["backlog", "todo", "in_progress", "done", "canceled"];
const page = items => ({ items, next_cursor: null, has_more: false });
const ownerSession = { principal: { id: ownerId, display_name: "Owner", is_owner: true, version: 1 }, session_id: "session-a", expires_at: new Date(Date.now() + 8 * 3600000).toISOString(), source: { kind: "credential", id: "source-a" }, target: { kind: "admin", section: "overview" }, allowed_scope: { kind: "instance" } };
const scopedSession = { ...ownerSession, principal: { ...ownerSession.principal, is_owner: false }, target: { kind: "workspace", entry_path: `/app/manage?workspace=${workspaceId}` }, allowed_scope: { kind: "workspace", workspace_id: workspaceId, projects: [{ project_id: projectId, workspace_id: workspaceId, role: "writer", project_display_name: "Project", workspace_display_name: "Team" }] } };
function fixture(session = ownerSession) {
  const backend = {
    session: structuredClone(session), calls: [], intercept: null,
    workspace: { id: workspaceId, display_name: "Team", version: 3, deleted_at: null, allowed_actions: ["read", "update", "create_project", "manage_administrators"] },
    project: { id: projectId, workspace_id: workspaceId, workspace_display_name: "Team", display_name: "Project", context: "Saved project context", version: 3, deleted_at: null, allowed_actions: ["read", "update", "manage_status_names", "manage_administrators", "manage_members"] },
    settings: { version: 1, notice_en: "Saved English", notice_zh_cn: "原中文" },
    statusNames: Object.fromEntries(statusKeys.map(key => [key, key === "todo" ? "To do" : key])),
    policy: { enabled: false, allowed_actions: ["read", "enable"], public_summary: "Saved summary", resource_limits: { issues: 50, comments: 500, principals: 50 }, active_usage: { issues: 0, comments: 0, principals: 0 }, policy_version: null },
  };
  backend.statuses = () => statusKeys.map(key => ({ key, display_name: backend.statusNames[key], version: backend.project.version }));
  globalThis.fetch = async (path, init) => {
    const call = { path, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    backend.calls.push(call);
    const intercepted = await backend.intercept?.(call);
    if (intercepted !== undefined && intercepted !== null) return intercepted;
    const pathname = new URL(path, "https://example.test").pathname;
    if (init.method === "GET") {
      if (pathname === "/api/v1/web-session") return Response.json(backend.session);
      if (pathname === homepagePath) return Response.json(backend.settings);
      if (pathname === "/api/v1/workspaces") return Response.json(page([backend.workspace]));
      if (pathname === workspacePath) return Response.json(backend.workspace);
      if (pathname === projectCollection) return Response.json(page([backend.project]));
      if (pathname === projectPath) return Response.json(backend.project);
      if (pathname === `${projectPath}/statuses`) return Response.json(page(backend.statuses()));
      if (pathname === `/api/v1/admin/projects/${projectId}/public-join`) return Response.json({ ...backend.policy, project: backend.project });
      return Response.json(page([]));
    }
    if (pathname === homepagePath && init.method === "PATCH") {
      backend.settings = { version: call.body.expected_version + 1, notice_en: call.body.notice_en, notice_zh_cn: call.body.notice_zh_cn };
      return Response.json({ resource: backend.settings, event_cursor: "saved-homepage", idempotent_replay: false });
    }
    if (pathname === projectPath && init.method === "PATCH") {
      backend.project = { ...backend.project, display_name: call.body.display_name, context: call.body.context, version: backend.project.version + 1 };
      return Response.json({ resource: backend.project, event_cursor: "saved-project", idempotent_replay: false });
    }
    if (init.method === "POST" && ["/api/v1/workspaces", projectCollection].includes(pathname)) return Response.json({ resource: { id: "new-container", display_name: call.body.display_name }, event_cursor: "created", idempotent_replay: false });
    assert.fail(`Unexpected write during test: ${init.method} ${pathname}`);
  };
  return backend;
}
const retained = key => retainedSessionTextDrafts.value.find(draft => draft.key === key);
function start(session = ownerSession) { clearRetainedSessionTextDrafts(); setSessionDraftPrincipal(session.principal.id); return fixture(session); }
async function ownerPage() { const view = mount(Owner, { section: "workspaces", session: ownerSession }); await flush(); assert.equal(view.state.loading, false); return view; }
async function scopedPage(project = true) { const view = mount(Scoped, { workspaceId, ...(project ? { projectId } : {}), session: scopedSession }); await flush(); assert.equal(view.state.loading, false); return view; }
async function homepagePage() { const view = mount(Homepage); await flush(); assert.ok(view.state.draft.current); return view; }

test("actual management getters retain only changed business text and stable IDs, excluding confirmations and sensitive fields", async () => {
  start(); const view = await ownerPage();
  view.state.showWorkspace = true; view.state.workspaceForm.display_name = "Typed workspace";
  view.state.openCreateProject(workspaceId); view.state.projectForm.display_name = "Typed project"; view.state.projectForm.context = "Typed new context";
  view.state.openContainerEdit("workspace", view.state.workspaces[0]); view.state.containerEdit.display_name = "Typed rename";
  await view.state.openProjectSettings(view.state.projects[0]); view.state.projectSettingsForm.context = "Typed existing context"; view.state.statusDrafts.todo = "Typed column";
  await view.state.openPolicy(view.state.projects[0]); view.state.policyForm.public_summary = "Typed public summary";
  view.state.oneTimeInvite = "sensitive-invite"; view.state.purgeName = "sensitive-delete-confirm";
  view.state.recoveryForm.principal_id = "sensitive-recovery-target"; view.state.recoveryConfirmed = true;
  view.state.grantForm.principal_id = "sensitive-permission-target"; view.state.policyRiskConfirmed = true;
  captureSessionTextDrafts(ownerId);
  assert.equal(retainedSessionTextDrafts.value.length, 6);
  assert.deepEqual(retained("owner-project-settings").fields, { context: "Typed existing context" });
  assert.deepEqual(retained("owner-status-names").fields, { todo: "Typed column" });
  assert.deepEqual(retained("owner-project-create").target, { workspace_id: workspaceId });
  assert.deepEqual(retained("owner-public-summary").fields, { public_summary: "Typed public summary" });
  assert.doesNotMatch(JSON.stringify(retainedSessionTextDrafts.value), /sensitive-|expected_version|"version"|policyRiskConfirmed|recoveryConfirmed|Saved project context|Saved summary/);
  view.unmount();
  start(scopedSession); const scoped = await scopedPage();
  scoped.state.draft.display_name = "Typed managed name"; scoped.state.statusDrafts.todo = "Typed status";
  scoped.state.administratorCandidate = { principal_id: "sensitive-administrator-choice" };
  scoped.state.memberCandidate = { principal_id: "sensitive-member-choice" }; scoped.state.memberRole = "reader";
  captureSessionTextDrafts(ownerId);
  assert.deepEqual(retained("scoped-container-settings").fields, { display_name: "Typed managed name" });
  assert.deepEqual(retained("scoped-status-names").fields, { todo: "Typed status" });
  assert.doesNotMatch(JSON.stringify(retainedSessionTextDrafts.value), /sensitive-|memberRole|expected_version|"version"|Saved project context/);
  scoped.unmount(); clearRetainedSessionTextDrafts();
  const homepage = await homepagePage(); homepage.state.draft.english = "Typed English";
  captureSessionTextDrafts(ownerId);
  assert.deepEqual(retained("homepage-notice").fields, { english: "Typed English" });
  assert.deepEqual(retained("homepage-notice").target, {});
});

test("successful actual Owner creation, Scoped creation/settings, and homepage saves do not retain already submitted text", async () => {
  start(); const owner = await ownerPage();
  owner.state.showWorkspace = true; owner.state.workspaceForm.display_name = "Submitted workspace";
  await owner.state.createWorkspace(); captureSessionTextDrafts(ownerId);
  assert.equal(retainedSessionTextDrafts.value.length, 0); owner.unmount();
  start(scopedSession); const workspace = await scopedPage(false); workspace.state.projectName = "Submitted project";
  await workspace.state.write(projectCollection, "POST", { display_name: workspace.state.projectName });
  captureSessionTextDrafts(ownerId); assert.equal(retainedSessionTextDrafts.value.length, 0); workspace.unmount();
  const project = await scopedPage(); project.state.draft.display_name = "Submitted managed name";
  project.state.saveSettings(); await flush(); captureSessionTextDrafts(ownerId);
  assert.equal(retainedSessionTextDrafts.value.length, 0); project.unmount();
  const homepage = await homepagePage(); homepage.state.draft.english = "Submitted English"; homepage.state.draft.chinese = "已提交中文";
  await homepage.state.save(); captureSessionTextDrafts(ownerId);
  assert.equal(homepage.state.draft.pending, null); assert.equal(retainedSessionTextDrafts.value.length, 0);
});

test("actual restores verify current identity and permissions, use fresh untouched fields, and never submit", async () => {
  {
  const backend = start(); const first = await ownerPage();
  await first.state.openProjectSettings(first.state.projects[0]);
  first.state.projectSettingsForm.display_name = "Retained name"; first.state.statusDrafts.todo = "Retained column";
  captureSessionTextDrafts(ownerId); first.unmount();
  backend.project = { ...backend.project, version: 4, context: "Fresh remote context" };
  const next = await ownerPage(); const before = backend.calls.length;
  assert.equal(next.state.showProjectSettings, false, "new login does not reopen or restore automatically");
  assert.equal(await restoreSessionTextDraft(retained("owner-project-settings").id, ownerId), true);
  assert.equal(await restoreSessionTextDraft(retained("owner-status-names").id, ownerId), true);
  assert.equal(next.state.projectSettingsForm.display_name, "Retained name");
  assert.equal(next.state.projectSettingsForm.context, "Fresh remote context");
  assert.equal(next.state.statusDrafts.todo, "Retained column");
  assert.equal(next.state.selectedProject.version, 4); assert.equal(next.state.casConflict, null);
  assert.ok(backend.calls.slice(before).every(call => call.method === "GET"));
  next.unmount();
  }
  {
  const backend = start(scopedSession); const first = await scopedPage(); first.state.draft.display_name = "Retained managed name";
  captureSessionTextDrafts(ownerId); first.unmount(); const next = await scopedPage();
  const draft = retained("scoped-container-settings"); const before = backend.calls.length;
  backend.project.allowed_actions = ["read"];
  assert.equal(await restoreSessionTextDraft(draft.id, ownerId), false);
  assert.equal(next.state.draft.display_name, "Project");
  backend.project.allowed_actions = ["read", "update", "manage_status_names"];
  backend.session.principal.id = otherId;
  assert.equal(await restoreSessionTextDraft(draft.id, ownerId), false);
  assert.equal(next.state.draft.display_name, "Project");
  assert.ok(backend.calls.slice(before).every(call => call.method === "GET"));
  backend.session.principal.id = ownerId; backend.project.context = "Fresh untouched context"; backend.project.version = 4;
  assert.equal(await restoreSessionTextDraft(draft.id, ownerId), true);
  assert.equal(next.state.draft.display_name, "Retained managed name"); assert.equal(next.state.draft.context, "Fresh untouched context");
  assert.ok(backend.calls.slice(before).every(call => call.method === "GET"));
  next.unmount();
  }
  {
  const backend = start(); const first = await homepagePage(); first.state.draft.english = "Retained English";
  captureSessionTextDrafts(ownerId); first.unmount(); const next = await homepagePage();
  const draft = retained("homepage-notice"); const before = backend.calls.length;
  backend.session.principal.id = otherId;
  assert.equal(await restoreSessionTextDraft(draft.id, ownerId), false);
  assert.equal(next.state.draft.english, "Saved English");
  backend.session.principal.id = ownerId; backend.settings = { ...backend.settings, version: 2, notice_zh_cn: "恢复时最新中文" };
  assert.equal(await restoreSessionTextDraft(draft.id, ownerId), true);
  assert.equal(next.state.draft.english, "Retained English"); assert.equal(next.state.draft.chinese, "恢复时最新中文");
  assert.equal(next.state.draft.current.version, 2); assert.equal(next.state.draft.pending, null);
  assert.ok(backend.calls.slice(before).every(call => call.method === "GET"));
  }
});

test("Principal switching while actual Owner restore verifies Session cancels the pending text restore", async () => {
  const backend = start(); const first = await ownerPage(); first.state.showWorkspace = true; first.state.workspaceForm.display_name = "Owner A draft";
  captureSessionTextDrafts(ownerId); first.unmount(); const next = await ownerPage();
  const draft = retained("owner-workspace-create"); let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  backend.intercept = call => call.path === "/api/v1/web-session" ? new Promise(resolve => { release = () => resolve(Response.json(backend.session)); entered(); }) : undefined;
  const before = backend.calls.length; const restoring = restoreSessionTextDraft(draft.id, ownerId);
  await reading; setSessionDraftPrincipal(otherId); release();
  assert.equal(await restoring, false); assert.equal(next.state.showWorkspace, false); assert.equal(next.state.workspaceForm.display_name, "");
  assert.equal(retainedSessionTextDrafts.value.length, 0); assert.ok(backend.calls.slice(before).every(call => call.method === "GET"));
});
