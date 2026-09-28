import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
const built = await build({ entryPoints: [new URL("../../apps/web/src/lib/container-tree.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
const { ContainerTree } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const page = (items, cursor = null) => ({ items, has_more: cursor !== null, next_cursor: cursor });
const workspace = (id, archived = false) => ({ id, display_name: id, deleted_at: archived ? "2026-09-28" : null });

test("管理树按需到达第 21 个工作区与项目，活动/归档 cursor 相互隔离", async () => {
  const tree = new ContainerTree(), requests = [];
  const fetch = async path => {
    requests.push(path);
    const url = new URL(path, "https://local.test"), archived = url.searchParams.has("deleted"), cursor = url.searchParams.get("cursor");
    assert.equal(url.searchParams.get("limit"), "20");
    if (url.pathname === "/api/v1/workspaces") return cursor
      ? page([workspace(`${archived ? 'archived' : 'active'}-21`, archived)])
      : page(Array.from({ length: 20 }, (_, i) => workspace(`${archived ? 'archived' : 'active'}-${i + 1}`, archived)), `${archived ? 'archived' : 'active'}-next`);
    return cursor ? page([{ id: "project-21" }]) : page(Array.from({ length: 20 }, (_, i) => ({ id: `${url.pathname}-${archived}-${i}` })), `projects-${archived}`);
  };
  await tree.loadWorkspaces(fetch, "active", true);
  assert.equal(tree.workspaces.active.items.length, 20);
  assert.equal(tree.entries("active").length, 400);
  assert.equal(requests.length, 41);
  assert.ok(requests.every(path => !path.includes("cursor=")));
  await tree.loadWorkspaces(fetch, "active", true);
  assert.equal(tree.workspaces.active.items.length, 21);
  assert.equal(requests.length, 44);
  await tree.loadProjects(fetch, "active-21", "active");
  assert.equal(tree.projectPage("active-21", "active").items.at(-1).id, "project-21");
  await tree.loadWorkspaces(fetch, "archived", true);
  assert.equal(tree.workspaces.archived.items.length, 20);
  assert.ok(requests.at(-1).includes("deleted=only"));
  await tree.loadWorkspaces(fetch, "archived", true);
  assert.equal(tree.workspaces.archived.items.at(-1).id, "archived-21");
  assert.equal(tree.entries("active").some(item => item.workspaceId.startsWith("archived")), false);
});

test("项目加载失败保留 cursor 可重试；权限变更使 cursor 失效时清空旧页", async () => {
  const tree = new ContainerTree();
  await tree.loadWorkspaces(async path => path.includes("/projects") ? page([{ id: "p1" }], "next") : page([workspace("w")]), "active", false);
  await tree.loadProjects(async () => { throw new Error("offline"); }, "w", "active");
  assert.equal(tree.entries("active")[0].id, "p1");
  assert.equal(tree.projectPage("w", "active").cursor, "next");
  await tree.loadProjects(async path => { assert.match(path, /cursor=next/); throw { body: { code: "CURSOR_SCOPE_MISMATCH" } }; }, "w", "active");
  assert.deepEqual(tree.entries("active"), []);
  await tree.loadProjects(async path => { assert.ok(!path.includes("cursor=")); return page([{ id: "p2" }]); }, "w", "active");
  assert.equal(tree.entries("active")[0].id, "p2");
});

test("切换管理分区丢弃过期工作区响应，也不继续派发子项目读取", async () => {
  const tree = new ContainerTree();
  let resolve, calls = 0;
  const delayed = new Promise(done => { resolve = done; });
  const old = tree.loadWorkspaces(async () => { calls++; return delayed; }, "active", true);
  tree.reset();
  resolve(page([workspace("old")]));
  await old;
  assert.equal(calls, 1);
  assert.deepEqual(tree.workspaces.active.items, []);
  assert.deepEqual(tree.projects, {});
});

const { readFile } = await import("node:fs/promises");
const { default: ts } = await import("typescript");
const ownerSource = await readFile(new URL("../../apps/web/src/views/OwnerView.vue", import.meta.url), "utf8");
const ownerScript = ownerSource.slice(ownerSource.indexOf('>') + 1, ownerSource.indexOf("</script>"));
const ownerAst = ts.createSourceFile("OwnerView.ts", ownerScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const recoveryMethods = ["openContainerEdit", "refreshContainerEditFacts", "saveContainerEdit", "recoverCasConflict", "dismissCasConflict", "refreshCasFacts"];
const declarations = ownerAst.statements.filter(statement => ts.isFunctionDeclaration(statement) && recoveryMethods.includes(statement.name?.text));
assert.equal(declarations.length, recoveryMethods.length);
const recoveryScript = ts.transpileModule(declarations.map(statement => statement.getText(ownerAst)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const casBuilt = await build({ entryPoints: [new URL("../../apps/web/src/lib/cas-recovery.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
const cas = await import(`data:text/javascript;base64,${Buffer.from(casBuilt.outputFiles[0].text).toString("base64")}`);

const stableId = index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
async function ownerRecoveryFixture(apiRequest) {
  const tree = new ContainerTree();
  const resources = Array.from({ length: 21 }, (_, index) => ({ id: stableId(index + 1), display_name: `Workspace ${index + 1}`, version: 1, deleted_at: null }));
  const fetch = async path => path.includes("/projects") ? page([])
    : path.includes("cursor=") ? page(resources.slice(20)) : page(resources.slice(0, 20), "workspace-page-2");
  await tree.loadWorkspaces(fetch, "active", false);
  await tree.loadWorkspaces(fetch, "active", false);
  const fixture = {
    apiRequest,
    busy: { value: false },
    casConflict: { value: null },
    containerEdit: { value: null },
    showContainerEdit: { value: false },
    workspaces: { get value() { return tree.workspaces.active.items; }, set value(items) { tree.workspaces.active.items = items; } },
    projects: { value: [] },
    tree,
    resources,
    errors: [],
    loads: 0,
    load: async () => { fixture.loads++; },
    loadWorkspaceTree: async () => assert.fail("Container conflict readback must not replace bounded pages or walk the tree"),
    writeFence: { enter: () => true, leave: () => {} },
    localizedText: (en, zh) => ({ en, zh }),
    setError: error => fixture.errors.push(error),
    setErrorKey: () => {},
    ...cas,
  };
  const bindings = ["apiRequest", "busy", "casConflict", "containerEdit", "showContainerEdit", "workspaces", "projects", "load", "loadWorkspaceTree", "writeFence", "localizedText", "setError", "setErrorKey", "captureCasConflict", "markCasReadbackComplete", "markCasReadbackFailed"];
  const factory = new Function("bindings", `const { ${bindings.join(",")} } = bindings; let casRecoveryGeneration = 0; let casReadback = null; let casReadbackInFlight = false; ${recoveryScript}; return { ${recoveryMethods.join(",")} };`);
  fixture.methods = factory(fixture);
  return fixture;
}

async function until(check) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail("Owner recovery did not reach the expected state");
}

test("后页工作区改名冲突使用精确 UUID 读回新版本，保留新输入草稿后由用户保存", async () => {
  const calls = [];
  let resolveReadback;
  let writes = 0;
  const targetId = stableId(21);
  const fixture = await ownerRecoveryFixture(async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === "PATCH") {
      writes++;
      if (writes === 1) throw { body: { code: "VERSION_CONFLICT", details: { current_version: 2 } } };
      assert.equal(options.body.expected_version, 2);
      return { resource: { id: targetId, version: 3, display_name: options.body.display_name, deleted_at: null } };
    }
    return new Promise(resolve => { resolveReadback = resolve; });
  });
  fixture.methods.openContainerEdit("workspace", fixture.resources[20]);
  fixture.containerEdit.value.display_name = "Initial draft";
  const saving = fixture.methods.saveContainerEdit();
  await until(() => resolveReadback !== undefined);
  assert.equal(calls[0].body.expected_version, 1);
  assert.equal(calls[1].path, `/api/v1/workspaces/${targetId}`);
  fixture.containerEdit.value.display_name = "Draft typed during readback";
  resolveReadback({ ...fixture.resources[20], display_name: "Server name", version: 2 });
  await saving;
  assert.equal(fixture.containerEdit.value.item.version, 2);
  assert.equal(fixture.containerEdit.value.display_name, "Draft typed during readback");
  assert.equal(fixture.casConflict.value.readbackState, "complete");
  assert.equal(fixture.workspaces.value.length, 21);
  assert.equal(fixture.workspaces.value.at(-1).version, 2);
  assert.equal(writes, 1, "readback must not replay the original write");
  await fixture.methods.saveContainerEdit();
  assert.equal(writes, 2);
  assert.equal(calls.at(-1).body.display_name, "Draft typed during readback");
  assert.equal(fixture.casConflict.value, null);
  assert.equal(fixture.showContainerEdit.value, false);
  assert.equal(fixture.loads, 1);
});

test("精确 UUID 读回失败保留后页目标旧版本和草稿，并明确标记失败直至重试成功", async () => {
  const calls = [];
  let failReadback = true;
  let writes = 0;
  const targetId = stableId(21);
  const fixture = await ownerRecoveryFixture(async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === "PATCH") {
      writes++;
      throw { body: { code: "VERSION_CONFLICT", details: { current_version: 2 } } };
    }
    if (failReadback) throw new Error("readback offline");
    return { id: targetId, display_name: "Server name", version: 2, deleted_at: null };
  });
  fixture.methods.openContainerEdit("workspace", fixture.resources[20]);
  fixture.containerEdit.value.display_name = "Preserved draft";
  await fixture.methods.saveContainerEdit();
  assert.equal(fixture.casConflict.value.readbackState, "failed");
  assert.equal(fixture.containerEdit.value.item.version, 1);
  assert.equal(fixture.containerEdit.value.display_name, "Preserved draft");
  assert.equal(fixture.workspaces.value.length, 21);
  assert.equal(fixture.workspaces.value.at(-1).version, 1);
  assert.equal(fixture.showContainerEdit.value, true);
  assert.equal(fixture.busy.value, false);
  assert.equal(fixture.loads, 0);
  failReadback = false;
  await fixture.methods.refreshCasFacts();
  assert.equal(calls.at(-1).path, `/api/v1/workspaces/${targetId}`);
  assert.equal(fixture.casConflict.value.readbackState, "complete");
  assert.equal(fixture.containerEdit.value.item.version, 2);
  assert.equal(fixture.containerEdit.value.display_name, "Preserved draft");
  assert.equal(writes, 1);
});

test("项目改名读回保持精确父工作区 UUID 路径与当前草稿", async () => {
  const calls = [];
  const project = { id: stableId(30), workspace_id: stableId(21), display_name: "Original project", workspace_display_name: "Workspace 21", version: 1, deleted_at: null };
  const fixture = await ownerRecoveryFixture(async path => { calls.push(path); return { ...project, display_name: "Server project", version: 2 }; });
  fixture.projects.value = [{ ...project, workspaceId: project.workspace_id, workspaceName: project.workspace_display_name }];
  fixture.methods.openContainerEdit("project", project, project.workspace_id);
  fixture.containerEdit.value.display_name = "Project draft";
  await fixture.methods.refreshContainerEditFacts(fixture.containerEdit.value);
  assert.deepEqual(calls, [`/api/v1/workspaces/${project.workspace_id}/projects/${project.id}`]);
  assert.equal(fixture.containerEdit.value.display_name, "Project draft");
  assert.equal(fixture.containerEdit.value.item.version, 2);
  assert.equal(fixture.projects.value[0].version, 2);
  assert.equal(fixture.projects.value[0].workspaceId, project.workspace_id);
});
