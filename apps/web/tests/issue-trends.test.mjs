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
import { canReadIssueTrends, isIssueTrends, issueTrendsPath, issueTrendsSelection } from "../src/lib/issue-trends.ts";

const workspace = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const otherProject = "44444444-4444-4444-8444-444444444444";
const milestone = "33333333-3333-4333-8333-333333333333";
const scopeProject = (id = project) => ({ project_id: id, workspace_id: workspace, project_display_name: id === project ? "Alpha" : "Beta", workspace_display_name: "Workspace", role: "reader" });
const session = (overrides = {}) => ({ principal: { id: "principal", is_owner: false }, session_id: "session", source: { id: "source", kind: "credential" }, target: { kind: "project" }, allowed_scope: { kind: "project_selection", projects: [scopeProject(), scopeProject(otherProject)] }, ...overrides });
const projectResource = { id: project, workspace_id: workspace, display_name: "Alpha", workspace_display_name: "Workspace", deleted_at: null };
function response(request = { workspaceId: workspace, projectId: project, days: 30 }) {
  const end = Date.parse("2026-10-10T00:00:00Z");
  const ids = request.projectId ? [request.projectId] : request.projectIds?.length ? request.projectIds : [project, otherProject];
  const points = Array.from({ length: request.days }, (_, index) => ({ date: new Date(end - (request.days - index - 1) * 86_400_000).toISOString().slice(0, 10), total: 4, done: 1, canceled: 1, unfinished: 2, created: 0, completed: 0, reopened: 0 }));
  return { timezone: "UTC", from_date: points[0].date, to_date: points.at(-1).date, observed_at: "2026-10-10T12:00:00Z", scope: { workspace_id: request.workspaceId, project_ids: ids, milestone_id: request.milestoneId ?? null }, projects: ids.map(id => ({ id, display_name: id === project ? "Alpha" : "Beta", stock_from: "2026-10-01", flow_from: "2026-10-01", history_state: "complete" })), points };
}

test("trend requests retain explicit scope, bound project sets and avoid invalid milestone scopes", () => {
  assert.equal(issueTrendsPath({ workspaceId: workspace, projectId: project, milestoneId: milestone, days: 90 }), `/api/v1/workspaces/${workspace}/projects/${project}/issues/trends?days=90&milestone=${milestone}`);
  assert.equal(issueTrendsPath({ workspaceId: workspace, projectIds: [otherProject, project, project], days: 30 }), `/api/v1/workspaces/${workspace}/issues/trends?days=30&project=${project}&project=${otherProject}`);
  assert.equal(issueTrendsPath({ workspaceId: workspace, milestoneId: milestone, days: 30 }), null);
  assert.equal(issueTrendsPath({ workspaceId: "other", days: 30 }), null);
  assert.equal(issueTrendsPath({ workspaceId: workspace, projectId: project, projectIds: [project], days: 30 }), null);
  assert.equal(issueTrendsPath({ workspaceId: workspace, days: 2 }), null);
  assert.equal(issueTrendsSelection(`?days=365&milestone=${milestone}`).days, 365);
  assert.equal(issueTrendsSelection(`?days=90&days=30&milestone=${milestone}&milestone=none`).milestoneId, "all");
  assert.equal(issueTrendsSelection("?milestone=none&days=bad").days, 30);
  assert.equal(issueTrendsSelection("?project=invalid").allProjects, false);
});

test("trend response validation rejects scope drift, incomplete dates, fake zeros and invalid counts", () => {
  const request = { workspaceId: workspace, projectId: project, days: 30 };
  const valid = response(request);
  valid.projects[0].history_state = "pending";
  valid.points[0] = { ...valid.points[0], total: null, done: null, canceled: null, unfinished: null, created: null, completed: null, reopened: null };
  assert.equal(isIssueTrends(valid, request), true);
  for (const mutate of [
    value => { value.scope.project_ids = [otherProject]; },
    value => { value.scope.milestone_id = milestone; },
    value => { value.points.pop(); },
    value => { value.points[0].date = "2026-02-30"; },
    value => { value.points[0].total = 9; },
    value => { value.points[0].completed = -1; },
    value => { value.points[0].done = null; },
    value => { value.points[0].created = null; },
    value => { value.observed_at = "2026-10-11T00:00:00Z"; },
    value => { value.projects[0].flow_from = "bad"; },
    value => { value.projects.push(value.projects[0]); },
  ]) { const value = response(request); mutate(value); assert.equal(isIssueTrends(value, request), false); }
  assert.equal(isIssueTrends(response({ workspaceId: workspace, projectIds: [project], days: 30 }), { workspaceId: workspace, projectIds: [otherProject], days: 30 }), false);
});

test("reader workspace visibility comes from project scope and fixed Owner sessions do not expand", () => {
  assert.equal(canReadIssueTrends(session(), workspace), true);
  assert.equal(canReadIssueTrends(session(), workspace, milestone), false);
  assert.equal(canReadIssueTrends(session({ principal: { id: "owner", is_owner: true }, allowed_scope: { kind: "project", projects: [scopeProject()] } }), workspace, otherProject), false);
  assert.equal(canReadIssueTrends(session({ principal: { id: "owner", is_owner: true }, allowed_scope: { kind: "instance" } }), workspace, otherProject), true);
  const issueSession = session({ target: { kind: "issue" }, allowed_scope: { kind: "project", projects: [scopeProject()] } });
  assert.equal(canReadIssueTrends(issueSession, workspace), false);
  assert.equal(canReadIssueTrends(issueSession, workspace, project), false);
  assert.equal(canReadIssueTrends({ ...issueSession, principal: { id: "owner", is_owner: true } }, workspace, project), false);
});

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "cfkanban-trends-web-"));
const require = createRequire(import.meta.url);
const moduleFile = path.join(temporary, "trends.mjs");
await build({
  stdin: { contents: `export {default as TrendsView} from ${JSON.stringify(path.join(root, "apps/web/src/views/IssueTrendsView.vue"))}; export {default as SelectionView} from ${JSON.stringify(path.join(root, "apps/web/src/views/ProjectSelectionView.vue"))}; export {default as Switcher} from ${JSON.stringify(path.join(root, "apps/web/src/components/ProjectSwitcher.vue"))}; export * from 'fixture-api'; export * from 'fixture-locale';`, resolveDir: root },
  outfile: moduleFile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  plugins: [{ name: "trends-fixture", setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(require.resolve("vue")).href, external: true }));
    builder.onResolve({ filter: /(?:^fixture-api$|\/lib\/api$)/ }, () => ({ path: "api", namespace: "fixture" }));
    builder.onResolve({ filter: /(?:^fixture-locale$|\/lib\/i18n$)/ }, () => ({ path: "locale", namespace: "fixture" }));
    builder.onResolve({ filter: /\/lib\/router$/ }, () => ({ path: "router", namespace: "fixture" }));
    builder.onResolve({ filter: /\/components\/IssueTrendChart\.vue$/ }, () => ({ path: "chart", namespace: "fixture" }));
    builder.onResolve({ filter: /\/components\/MilestoneSelect\.vue$/ }, () => ({ path: "milestone", namespace: "fixture" }));
    builder.onResolve({ filter: /^@nuxt\/ui\/components\/.*\.vue$/ }, ({ path: name }) => ({ path: name.includes("Button") ? "button" : "select", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => {
      const contents = name === "api" ? `export let handler;export const requests=[];export function setHandler(value){handler=value;requests.length=0;}export async function apiRequest(path,options={}){requests.push({path,...options});const result=await handler(path,options);if(options.validateResponse&&!options.validateResponse(result))throw new Error('Invalid trend response');return result;}export const errorText=error=>error?.message??String(error);`
        : name === "locale" ? `import {ref} from 'vue';export const locale=ref('en');export const t=key=>key;export function setLocale(value){locale.value=value;}`
        : name === "router" ? `export function navigate(){return true;}`
        : name === "chart" ? `import {defineComponent,h} from 'vue';export default defineComponent({props:['label','points','series'],setup(props){return()=>h('figure',{'data-chart':props.label,'data-points':props.points},props.label);}});`
        : name === "milestone" ? `import {defineComponent,h} from 'vue';export default defineComponent({props:['value','allowNone'],emits:['update:value'],setup(props,{emit}){return()=>h('select',{'data-milestone':true,'data-allow-none':props.allowNone,onChange:event=>emit('update:value',event.target.value)});}});`
        : name === "button" ? `import {defineComponent,h} from 'vue';export default defineComponent({inheritAttrs:false,setup(_props,{attrs,slots}){return()=>h('button',attrs,slots.default?.());}});`
        : `import {defineComponent,h} from 'vue';export default defineComponent({inheritAttrs:false,props:['modelValue','items'],emits:['update:modelValue'],setup(props,{attrs,emit}){return()=>h('select',{...attrs,value:props.modelValue,onChange:event=>emit('update:modelValue',Number(event.target.value))},props.items?.map(item=>h('option',{value:item.value},item.label)));}});`;
      return { contents, loader: "js" };
    });
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
      return { contents: compileScript(descriptor, { id: "trends-fixture", inlineTemplate: true }).content, loader: "ts", resolveDir: path.dirname(filename) };
    });
  } }],
});
const { TrendsView, SelectionView, Switcher, setHandler, requests, setLocale } = await import(pathToFileURL(moduleFile));
after(() => rm(temporary, { recursive: true, force: true }));

function fixture(props, search = "", Component = TrendsView) {
  globalThis.window = { location: { search, origin: "https://local.invalid" } };
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const node = (tag, text = "") => markRaw({ tag, text, props: {}, children: [], parent: null, focus() {}, getBoundingClientRect: () => ({ left: 0, width: 160, bottom: 40 }), querySelector(selector) { return descendants(this).find(item => String(item.props.class ?? "").split(" ").includes(selector.slice(1))); } });
  const remove = child => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; };
  const renderer = createRenderer({
    createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
    setText: (element, text) => { element.text = text; }, setElementText: (element, text) => { element.text = text; element.children = []; },
    parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    insert(child, parent, anchor = null) { remove(child); child.parent = parent; parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child); },
    remove, patchProp: (element, key, _previous, value) => { element.props[key] = value; },
  });
  const state = reactive(props);
  const container = node("root");
  const app = renderer.createApp({ render: () => h(Component, state) }); app.mount(container);
  const all = () => descendants(container);
  const text = element => element.text + element.children.map(text).join("");
  const tick = async () => { for (let i = 0; i < 6; i++) { await nextTick(); await new Promise(resolve => setImmediate(resolve)); } };
  return { app, state, all, text: () => text(container), tick };
}
function handler(pathname) {
  if (!pathname.includes("issues/trends")) return projectResource;
  const query = new URL(pathname, "https://local.invalid").searchParams;
  return response({ workspaceId: workspace, ...(pathname.includes("/projects/") ? { projectId: project } : {}), projectIds: query.getAll("project"), milestoneId: query.get("milestone") ?? undefined, days: Number(query.get("days")) });
}

test("reader trend page renders UTC windows, current facts, milestone burn-up and safe product explanations", async () => {
  setLocale("en"); setHandler(handler);
  const f = fixture({ workspaceId: workspace, projectId: project, session: session() }, `?milestone=${milestone}`);
  try {
    await f.tick();
    assert.equal(f.all().filter(item => item.tag === "figure").length, 3);
    assert.match(f.text(), /Today is still in progress/);
    assert.match(f.text(), /completing again after reopening counts again/);
    assert.match(requests.find(item => item.path.includes("trends")).path, new RegExp(`milestone=${milestone}`));
    assert.equal(f.all().find(item => item.props["data-milestone"]).props["data-allow-none"], false);
    assert.equal(requests.every(item => item.method === undefined), true);
    setLocale("zh-CN"); await f.tick(); assert.match(f.text(), /里程碑燃起图/); assert.match(f.text(), /当日尚未结束/);
  } finally { f.app.unmount(); }
});

test("changing windows aborts requests and late results cannot replace the current graph", async () => {
  setLocale("en"); let resolveOld;
  setHandler(pathname => pathname.includes("days=30") ? new Promise(resolve => { resolveOld = resolve; }) : handler(pathname));
  const f = fixture({ workspaceId: workspace, projectId: project, session: session() });
  try {
    await f.tick(); const old = requests.find(item => item.path.includes("days=30"));
    const window = f.all().find(item => item.props["aria-label"] === "Date window");
    window.props.onChange({ target: { value: "90" } }); await f.tick();
    assert.equal(old.signal.aborted, true);
    assert.equal(f.all().find(item => item.tag === "figure").props["data-points"].length, 90);
    resolveOld(response()); await f.tick();
    assert.equal(f.all().find(item => item.tag === "figure").props["data-points"].length, 90);
  } finally { f.app.unmount(); }
});

test("scope revocation clears the old projection and never requests an inaccessible replacement", async () => {
  setLocale("en"); setHandler(handler);
  const f = fixture({ workspaceId: workspace, projectId: project, session: session() });
  try {
    await f.tick(); assert.equal(f.all().filter(item => item.tag === "figure").length, 2);
    const old = requests.length;
    f.state.session = session({ allowed_scope: { kind: "project_selection", projects: [] } }); await f.tick();
    assert.equal(f.all().filter(item => item.tag === "figure").length, 0);
    assert.match(f.text(), /outside your current access/);
    assert.equal(requests.length, old);
  } finally { f.app.unmount(); }
});

test("fixed Issue sessions neither request aggregate trends nor expose workspace trend entry points", async () => {
  setLocale("en");
  const fixed = session({ target: { kind: "issue" }, allowed_scope: { kind: "project", projects: [scopeProject()] } });
  for (const projectId of [undefined, project]) {
    setHandler(() => { throw new Error("Issue session must not request aggregate trends"); });
    const f = fixture({ workspaceId: workspace, projectId, session: fixed });
    try { await f.tick(); assert.equal(requests.length, 0); assert.match(f.text(), /outside your current access/); }
    finally { f.app.unmount(); }
  }
  setHandler(() => { throw new Error("Selection should not request aggregate trends"); });
  const selection = fixture({ session: fixed }, "", SelectionView);
  try { await selection.tick(); assert.equal(requests.length, 0); assert.doesNotMatch(selection.text(), /Workspace trends/); }
  finally { selection.app.unmount(); }
  setHandler(pathname => { assert.equal(pathname, "/api/v1/web-session"); return fixed; });
  const switcher = fixture({ session: fixed }, "", Switcher);
  try {
    switcher.all().find(item => String(item.props.class ?? "").includes("project-switch-trigger")).props.onClick();
    await switcher.tick();
    assert.equal(requests.length, 1); assert.doesNotMatch(switcher.text(), /Workspace trends/);
  } finally { switcher.app.unmount(); }
});

test("workspace default uses current project scope and missing history stays null", async () => {
  setLocale("en"); setHandler(pathname => {
    const value = handler(pathname); value.projects[0].history_state = "partial";
    value.points[0] = { ...value.points[0], total: null, done: null, canceled: null, unfinished: null, created: null, completed: null, reopened: null };
    return value;
  });
  const f = fixture({ workspaceId: workspace, session: session() });
  try {
    await f.tick();
    assert.match(requests[0].path, new RegExp(`workspaces/${workspace}/issues/trends\\?days=30$`));
    assert.equal(f.all().find(item => item.tag === "figure").props["data-points"][0].unfinished, null);
    assert.match(f.text(), /not zero/);
    assert.match(f.text(), /Alpha/); assert.match(f.text(), /Beta/);
  } finally { f.app.unmount(); }
});

test("invalid or refused responses clear graphs and show retry without fabricated values", async () => {
  setLocale("en"); setHandler(handler);
  const f = fixture({ workspaceId: workspace, projectId: project, session: session() });
  try {
    await f.tick();
    setHandler(pathname => { const value = handler(pathname); if (pathname.includes("trends")) value.scope.project_ids = [otherProject]; return value; });
    f.all().find(item => item.tag === "button" && item.children.some(child => child.text === "Refresh")).props.onClick(); await f.tick();
    assert.equal(f.all().filter(item => item.tag === "figure").length, 0);
    assert.match(f.text(), /Invalid trend response/); assert.match(f.text(), /Retry/);
  } finally { f.app.unmount(); }
});
