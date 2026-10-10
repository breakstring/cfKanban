import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive } from "vue";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "cfkanban-milestone-web-"));
const require = createRequire(import.meta.url);
const moduleFile = path.join(temporary, "milestones.mjs");
await build({
  stdin: { contents: `export {default as MilestoneSelect} from ${JSON.stringify(path.join(root, "apps/web/src/components/MilestoneSelect.vue"))}; export {default as MilestonesView} from ${JSON.stringify(path.join(root, "apps/web/src/views/ProjectMilestonesView.vue"))}; export * from ${JSON.stringify(path.join(root, "apps/web/src/lib/board-navigation.ts"))}; export * from ${JSON.stringify(path.join(root, "apps/web/src/lib/board-projection.ts"))}; export * from ${JSON.stringify(path.join(root, "apps/web/src/lib/milestones.ts"))}; export { priorityOrder as navigationPriorityOrder } from ${JSON.stringify(path.join(root, "apps/web/src/lib/priority-values.ts"))}; export { priorityOrder as publicPriorityOrder, priorityText, prioritySaveIsUncertain } from ${JSON.stringify(path.join(root, "apps/web/src/lib/priority.ts"))}; export * from 'fixture-api'; export * from 'fixture-locale'; export * from 'fixture-router';`, resolveDir: root },
  outfile: moduleFile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  plugins: [{ name: "milestone-fixture", setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(require.resolve("vue")).href, external: true }));
    builder.onResolve({ filter: /(?:^fixture-api$|\/lib\/api$)/ }, () => ({ path: "api", namespace: "fixture" }));
    builder.onResolve({ filter: /(?:^fixture-locale$|\/lib\/i18n$)/ }, () => ({ path: "locale", namespace: "fixture" }));
    builder.onResolve({ filter: /(?:^fixture-router$|\/lib\/router$)/ }, () => ({ path: "router", namespace: "fixture" }));
    builder.onResolve({ filter: /\/lib\/(?:navigation-draft|session-drafts)$/ }, () => ({ path: "drafts", namespace: "fixture" }));
    builder.onResolve({ filter: /\/lib\/localized-error$/ }, () => ({ path: "errors", namespace: "fixture" }));
    builder.onResolve({ filter: /^@nuxt\/ui\/components\/.*\.vue$/ }, ({ path: name }) => ({ path: name.includes("Button") ? "button" : name.includes("Select") ? "select" : name.includes("Textarea") ? "textarea" : "input", namespace: "fixture" }));
    builder.onResolve({ filter: /\/components\/(?:ModalDialog|CasConflictNotice|ErrorNotice|MarkdownContent)\.vue$/ }, ({ path: name }) => ({ path: name.includes("ModalDialog") ? "modal" : name.includes("CasConflict") ? "conflict" : "notice", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => {
      const contents = name === "api" ? `export let handler; export const requests=[]; export function setHandler(value){handler=value;requests.length=0;} export class ApiProblem extends Error {constructor(status,body){super(body.message??body.code);this.status=status;this.body=body;}} export async function apiRequest(path,options={}){requests.push({path,...options});return handler(path,options);} export const errorText=error=>error?.message??String(error); export const hasUncertainWrite=()=>false;`
        : name === "locale" ? `import {ref} from 'vue';export const locale=ref('en');export const t=key=>key;export function setLocale(value){locale.value=value;}`
        : name === "router" ? `export const destinations=[];export function navigate(path){destinations.push(path);return true;}`
        : name === "drafts" ? `export const protectNavigationDraft=()=>{}; export const useSessionTextDraft=()=>{};export const changedTextFields=()=>null;export const verifySessionTextDraftIdentity=()=>null;`
        : name === "errors" ? `import {ref} from 'vue';export function useLocalizedError(){const error=ref('');return {error,clearError:()=>{error.value='';},setError:value=>{error.value=value?.message??String(value);},setLocalizedError:(en)=>{error.value=en;}};}`
        : name === "conflict" ? `import {defineComponent,h} from 'vue';export default defineComponent({props:['conflict','busy'],emits:['refresh','dismiss'],setup(props,{emit}){return()=>h('section',{'data-conflict':props.conflict.readbackState},[h('pre',props.conflict.draft),h('button',{onClick:()=>emit('refresh')},'Refresh facts'),h('button',{onClick:()=>emit('dismiss')},'Dismiss')]);}});`
        : name === "modal" ? `import {defineComponent,h} from 'vue';export default defineComponent({props:['title','busy'],emits:['close'],setup(props,{slots,emit}){return()=>h('section',{'data-modal':true},[h('h2',props.title),...(slots.default?.()??[]),h('button',{disabled:props.busy,onClick:()=>emit('close')},'Close dialog')]);}});`
        : name === "notice" ? `import {defineComponent,h} from 'vue';export default defineComponent({props:['error','source'],setup(props){return()=>h('p',props.error??props.source);}});`
        : name === "button" ? `import {defineComponent,h} from 'vue';export default defineComponent({inheritAttrs:false,setup(_props,{attrs,slots}){return()=>h('button',attrs,slots.default?.());}});`
        : `import {defineComponent,h} from 'vue';export default defineComponent({inheritAttrs:false,props:['modelValue','items'],emits:['update:modelValue'],setup(props,{attrs,emit}){return()=>h(${JSON.stringify(name)},{...attrs,value:props.modelValue,onInput:event=>emit('update:modelValue',event.target.value),onChange:event=>emit('update:modelValue',event.target.value)},props.items?.map(item=>h('option',{value:item.value},item.label)));}});`;
      return { contents, loader: "js" };
    });
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
      return { contents: compileScript(descriptor, { id: "milestone-fixture", inlineTemplate: true }).content, loader: "ts", resolveDir: path.dirname(filename) };
    });
  } }],
});
const { MilestoneSelect, MilestonesView, setHandler, requests, ApiProblem, setLocale, destinations, boardFilters, boardPath, boardReturnPath, matchesBoardFilters, milestoneAssignmentChange, isMilestoneWriteResult, navigationPriorityOrder, publicPriorityOrder, priorityText, prioritySaveIsUncertain } = await import(pathToFileURL(moduleFile));
after(() => rm(temporary, { recursive: true, force: true }));

const workspace = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const milestoneId = "33333333-3333-4333-8333-333333333333";
const milestone = (overrides = {}) => ({ id: milestoneId, workspace_id: workspace, project_id: project, title: "Release", description: "Scope", due_date: null, status_key: "open", version: 1, created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", allowed_actions: ["read", "update"], progress: { total: 4, done: 1, unfinished: 2, canceled: 1 }, ...overrides });
const projectResource = { id: project, display_name: "Project", workspace_display_name: "Workspace", deleted_at: null };
const list = (items, cursor = null) => ({ items, has_more: cursor !== null, next_cursor: cursor });
const session = (role = "writer") => ({ principal: { id: "principal", is_owner: false }, session_id: "session", source: { id: "source", kind: "credential" }, target: { kind: "project" }, allowed_scope: { kind: "project", projects: [{ project_id: project, workspace_id: workspace, project_display_name: "Project", workspace_display_name: "Workspace", role }] } });

function fixture(Component, props, options = {}) {
  globalThis.window = { location: { search: "", origin: "https://local.invalid" } };
  const listeners = new Map();
  const fixtureDocument = { addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); } };
  if (options.noDocument) delete globalThis.document;
  else globalThis.document = fixtureDocument;
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const node = (tag, text = "") => markRaw({ tag, text, props: {}, children: [], parent: null, open: false, focus() {}, querySelector(selector) { return descendants(this).find(child => child.tag === selector); } });
  const remove = child => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; };
  const renderer = createRenderer({
    createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
    setText: (element, text) => { element.text = text; }, setElementText: (element, text) => { element.text = text; element.children = []; },
    parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    insert(child, parent, anchor = null) { remove(child); child.parent = parent; parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child); },
    remove, patchProp: (element, key, _previous, value) => { element.props[key] = value; },
  });
  const state = reactive(props);
  const selections = [];
  const container = node("root");
  const app = renderer.createApp({ render: () => h(Component, { ...state, "onUpdate:value": value => { selections.push(value); state.value = value; } }) });
  app.mount(container);
  const all = () => descendants(container);
  const text = element => element.text + element.children.map(text).join("");
  const button = label => all().find(element => element.tag === "button" && text(element) === label);
  const tick = async () => { for (let i = 0; i < 8; i++) { await nextTick(); await new Promise(resolve => setImmediate(resolve)); } };
  return { app, state, all, text, button, tick, selections, listeners };
}

test("milestone filter round trips safely and membership changes are optional, singular and explicit", () => {
  const filters = boardFilters(`?milestone=${milestoneId}&view=list`);
  assert.equal(filters.milestone, milestoneId);
  const route = boardPath(workspace, project, filters);
  assert.equal(boardReturnPath(workspace, project, new URLSearchParams({ from: route }).toString()), route);
  assert.equal(boardFilters("?milestone=none").milestone, "none");
  assert.equal(boardFilters(`?milestone=none&milestone=${milestoneId}`).milestone, undefined);
  assert.equal(boardFilters("?milestone=invalid").milestone, undefined);
  assert.deepEqual(milestoneAssignmentChange("none", undefined), {});
  assert.deepEqual(milestoneAssignmentChange(milestoneId, null), { milestone_id: milestoneId });
  assert.deepEqual(milestoneAssignmentChange("none", milestone()), { milestone_id: null });
  const issue = { deleted_at: null, priority: "none", labels: [], title: "Task", number: 1 };
  assert.equal(matchesBoardFilters(issue, { search: "", priorities: [], labels: [], milestone: "none" }), true);
  assert.equal(matchesBoardFilters({ ...issue, milestone: milestone() }, { search: "", priorities: [], labels: [], milestone: "none" }), false);
  assert.equal(matchesBoardFilters({ ...issue, milestone: milestone() }, { search: "", priorities: [], labels: [], milestone: milestoneId }), true);
});

test("milestone writes validate the scoped projection before retiring an uncertain request", () => {
  assert.equal(isMilestoneWriteResult({ resource: milestone() }, workspace, project), true);
  assert.equal(isMilestoneWriteResult({ resource: milestone({ project_id: workspace }) }, workspace, project), false);
  assert.equal(isMilestoneWriteResult({ resource: milestone({ progress: {} }) }, workspace, project), false);
  assert.equal(isMilestoneWriteResult({}, workspace, project), false);
});

test("navigation uses the same lightweight priority values without changing public order, text or recovery", () => {
  assert.deepEqual(navigationPriorityOrder, ["none", "low", "medium", "high", "urgent"]);
  assert.equal(publicPriorityOrder, navigationPriorityOrder);
  assert.equal(priorityText("urgent", true), "紧急");
  assert.equal(priorityText("none", false), "None");
  assert.equal(prioritySaveIsUncertain({ status: 0 }), true);
  assert.equal(prioritySaveIsUncertain({ status: 409 }), false);
});

test("selector loads bounded pages, includes closed milestones and supports no membership", async () => {
  setLocale("en");
  setHandler(async pathname => pathname.includes("cursor=") ? list([milestone({ id: "44444444-4444-4444-8444-444444444444", title: "Next", status_key: "closed" })]) : list([milestone()], "page-two"));
  const f = fixture(MilestoneSelect, { workspaceId: workspace, projectId: project, value: "none", allowAny: true });
  try {
    assert.equal(requests.length, 0);
    const menu = f.all().find(item => item.tag === "details"); menu.open = true; menu.props.onToggle(); await f.tick();
    assert.equal(requests.length, 1);
    assert.match(requests[0].path, /\?limit=20$/);
    f.button("Load more").props.onClick(); await f.tick();
    assert.match(requests[1].path, /cursor=page-two/);
    f.button("Next · Closed").props.onClick(); await f.tick();
    assert.equal(f.state.value, "44444444-4444-4444-8444-444444444444");
    assert.equal(menu.open, false);
    f.button("No milestone").props.onClick(); await f.tick();
    assert.equal(f.state.value, "none");
    f.button("Any milestone").props.onClick(); await f.tick();
    assert.equal(f.state.value, "all");
  } finally { f.app.unmount(); }
});

test("selector invalidates in flight results and labels when project scope changes", async () => {
  let finish;
  setHandler(() => new Promise(resolve => { finish = resolve; }));
  const f = fixture(MilestoneSelect, { workspaceId: workspace, projectId: project, value: "none", resetKey: "writer" });
  try {
    const menu = f.all().find(item => item.tag === "details"); menu.open = true; menu.props.onToggle(); await nextTick();
    f.state.projectId = "55555555-5555-4555-8555-555555555555"; f.state.resetKey = "reader"; await nextTick();
    finish(list([milestone({ title: "Old scope" })])); await f.tick();
    assert.equal(f.all().some(item => f.text(item).includes("Old scope")), false);
    assert.equal(menu.open, false);
  } finally { f.app.unmount(); }
});

test("selector mounting and unmounting are safe without a DOM document", async () => {
  setHandler(() => { throw new Error("Disabled selector must not fetch"); });
  const f = fixture(MilestoneSelect, { workspaceId: workspace, projectId: project, value: "none", disabled: true }, { noDocument: true });
  try {
    await f.tick();
    const menu = f.all().find(item => item.tag === "details");
    let prevented = 0;
    for (const key of ["Enter", " "]) menu.props.onKeydown({ key, preventDefault: () => prevented++ });
    assert.equal(prevented, 2);
    menu.open = true; menu.props.onToggle(); await f.tick();
    assert.equal(menu.open, false);
    assert.equal(requests.length, 0);
  } finally { f.app.unmount(); }
});

test("selector unregisters the captured document listener even when the global document changes", async () => {
  setHandler(async () => list([]));
  const f = fixture(MilestoneSelect, { workspaceId: workspace, projectId: project, value: "none" });
  try {
    await f.tick();
    const menu = f.all().find(item => item.tag === "details");
    const listener = f.listeners.get("pointerdown");
    assert.equal(typeof listener, "function");
    menu.open = true;
    listener({ composedPath: () => [menu] }); assert.equal(menu.open, true);
    listener({ composedPath: () => [] }); assert.equal(menu.open, false);
    delete globalThis.document;
  } finally { f.app.unmount(); }
  assert.equal(f.listeners.size, 0);
});

test("fixed Issue sessions have no project or milestone trend actions", async () => {
  setLocale("en");
  setHandler(pathname => pathname.includes("/milestones") ? list([milestone()]) : projectResource);
  const fixed = { ...session("reader"), target: { kind: "issue" } };
  const f = fixture(MilestonesView, { workspaceId: workspace, projectId: project, session: fixed });
  try {
    await f.tick();
    assert.equal(f.button("Trends"), undefined);
    assert.equal(f.button("View trends"), undefined);
    assert.equal(requests.some(item => item.path.includes("/issues/trends")), false);
  } finally { f.app.unmount(); }
});

test("project milestones render server progress and browse Issues with the milestone filter", async () => {
  setHandler(async pathname => pathname.includes("/milestones?") ? list([milestone()]) : projectResource);
  destinations.length = 0;
  const f = fixture(MilestonesView, { workspaceId: workspace, projectId: project, session: session() });
  try {
    await f.tick();
    const stats = f.all().filter(item => item.tag === "dd").map(item => f.text(item));
    assert.deepEqual(stats, ["4", "1", "2", "1"]);
    f.button("View Issues").props.onClick();
    assert.equal(new URL(destinations.at(-1), "https://local.invalid").searchParams.get("milestone"), milestoneId);
    assert.equal(new URL(destinations.at(-1), "https://local.invalid").searchParams.get("view"), "list");
    f.state.session = session("reader"); await f.tick();
    assert.equal(f.button("New milestone"), undefined);
    assert.equal(f.button("Edit"), undefined);
    assert.equal(f.button("Close milestone"), undefined);
  } finally { f.app.unmount(); }
});

test("CAS conflict retains milestone draft, reads the latest version and requires explicit resubmission", async () => {
  let writes = 0;
  const latest = milestone({ title: "Remote title", version: 2 });
  setHandler(async (pathname, options) => {
    if (options.method === "PATCH") {
      writes++;
      if (writes === 1) throw new ApiProblem(409, { code: "VERSION_CONFLICT", details: { current_version: 2 } });
      return { resource: latest };
    }
    if (pathname === `/api/v1/milestones/${milestoneId}`) return latest;
    return pathname.includes("/milestones?") ? list([milestone()]) : projectResource;
  });
  const f = fixture(MilestonesView, { workspaceId: workspace, projectId: project, session: session() });
  try {
    await f.tick(); f.button("Edit").props.onClick(); await f.tick();
    f.all().find(item => item.tag === "input" && item.props.maxlength === "200").props.onInput({ target: { value: "My title" } }); await f.tick();
    f.all().find(item => item.tag === "form").props.onSubmit({ preventDefault() {} }); await f.tick();
    assert.equal(writes, 1);
    assert.equal(f.all().find(item => item.tag === "input" && item.props.maxlength === "200").props.value, "My title");
    assert.ok(f.all().some(item => item.props["data-conflict"] === "complete"));
    f.button("Dismiss").props.onClick(); await f.tick();
    f.all().find(item => item.tag === "form").props.onSubmit({ preventDefault() {} }); await f.tick();
    const writeRequests = requests.filter(item => item.method === "PATCH");
    assert.equal(writeRequests[0].body.expected_version, 1);
    assert.equal(writeRequests[1].body.expected_version, 2);
    assert.equal(writeRequests[1].body.title, "My title");
  } finally { f.app.unmount(); }
});

test("unconfirmed milestone writes lock the editor and verify the exact original operation", async () => {
  let writes = 0;
  setHandler(async (pathname, options) => {
    if (options.method === "POST") { if (++writes === 1) throw new ApiProblem(0, { code: "PLATFORM_UNAVAILABLE" }); return { resource: milestone() }; }
    return pathname.includes("/milestones?") ? list([]) : projectResource;
  });
  const f = fixture(MilestonesView, { workspaceId: workspace, projectId: project, session: session() });
  try {
    await f.tick(); f.button("New milestone").props.onClick(); await f.tick();
    f.all().find(item => item.tag === "input" && item.props.maxlength === "200").props.onInput({ target: { value: "Release" } }); await f.tick();
    f.all().find(item => item.tag === "form").props.onSubmit({ preventDefault() {} }); await f.tick();
    assert.equal(f.all().find(item => item.tag === "input" && item.props.maxlength === "200").props.disabled, true);
    assert.equal(f.button("Close dialog").props.disabled, true);
    f.button("Verify save").props.onClick(); await f.tick();
    const writeRequests = requests.filter(item => item.method === "POST");
    assert.equal(writeRequests.length, 2);
    assert.deepEqual(writeRequests[1].body, writeRequests[0].body);
    assert.equal(f.all().some(item => item.props["data-modal"]), false);
  } finally { f.app.unmount(); }
});
