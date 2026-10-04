import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { getIssue, getIssueContext, listIssueCandidates, listIssues, listProjectIssues } from "../../apps/worker/src/services/issues.ts";

// 全零 D1 ID、127.0.0.1:0、persist:false；仅使用合成身份和本地 D1。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const origin = "https://hierarchy.example.test", owner = randomUUID(), credential = randomUUID();
const member = randomUUID(), memberCredential = randomUUID(), workspace = randomUUID();
const projects = Array.from({ length: 4 }, () => randomUUID()), grants = [randomUUID(), randomUUID()];
const ownerToken = `cfk_v1_hierarchy_${"A".repeat(43)}`;
const auth = { kind: "bearer", isOwner: true, principalId: owner, credentialId: credential,
  credentialFingerprint: "synthetic", displayName: "HierarchyOwner", principalVersion: 1 };
const reader = { ...auth, isOwner: false, principalId: member, credentialId: memberCredential, displayName: "HierarchyReader" };
const fixtures = new Map();
let db, fixed, sessionId, root, multi, parents, relationWriteCost;

const issueUrl = (params = {}) => {
  const result = new URL(`${origin}/api/v1/issues`);
  result.searchParams.set("project", projects[0]);
  for (const [key, value] of Object.entries(params)) result.searchParams.set(key, value);
  return result;
};
const identifier = issue => `CFK-${issue.number}`;
const hierarchyQuery = query => query.sql.includes("WITH hierarchy_visible_projects");

function instrument(hook = async () => {}) {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...bound) => wrap(target.bind(...bound), sql, bound);
    if (key === "all") return async (...args) => {
      await hook(sql, "before");
      const started = performance.now(), result = await target.all(...args);
      queries.push({ sql, values, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written,
        returned: result.results.length, results: result.results, duration_ms: performance.now() - started });
      await hook(sql, "after");
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { queries, db: new Proxy(db, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

function barrier(stage) {
  let reach, release;
  const reached = new Promise(resolve => { reach = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const observed = instrument(async (sql, currentStage) => {
    if (hierarchyQuery({ sql }) && stage === currentStage) { reach(); await released; }
  });
  return { ...observed, reached, release };
}

async function addIssue(name, project = projects[0], status = "todo", deleted = false) {
  const id = randomUUID();
  await db.prepare(`INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,
    created_by_principal_id,updated_by_principal_id,created_operation_id,deleted_at,deleted_by_principal_id)
    VALUES(?1,?2,?3,?3,?4,10,10,?5,?5,?6,?7,?8)`)
    .bind(id, project, name, status, owner, randomUUID(), deleted ? 20 : null, deleted ? owner : null).run();
  const result = { ...(await db.prepare("SELECT id,number,project_id,status_key,title FROM issues WHERE id=?1").bind(id).first()), deleted };
  fixtures.set(name, result);
  return result;
}

async function addRelation(child, parent, deleted = false, kind = "parent") {
  const id = randomUUID();
  const result = await db.prepare(`INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,
    source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id,deleted_at,deleted_by_principal_id)
    VALUES(?1,?2,?3,?4,?5,?6,?7,10,?8,?9,?10,?11)`)
    .bind(id, workspace, kind, child.id, parent.id, child.project_id, parent.project_id, owner, randomUUID(),
      deleted ? 20 : null, deleted ? owner : null).run();
  relationWriteCost ??= { rows_read: result.meta.rows_read, rows_written: result.meta.rows_written };
  return id;
}

before(async () => {
  await server.listen(); await server.getWorker().applyD1Migrations("DB"); ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: credential, ownerCredentialToken: ownerToken, ownerDisplayName: "HierarchyOwner", preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'HierarchyReader','hierarchyreader',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,1,?4)").bind(memberCredential, member, "b".repeat(64), randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Hierarchy',1,1,?2,?2,?3)").bind(workspace, owner, randomUUID()).run();
  for (const [index, project] of projects.entries()) {
    await db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,
      updated_by_principal_id,created_operation_id,deleted_at,deleted_by_principal_id)
      VALUES(?1,?2,?3,1,1,?4,?4,?5,?6,?7)`).bind(project, workspace, `Hierarchy ${index}`, owner,
        randomUUID(), index === 3 ? 20 : null, index === 3 ? owner : null).run();
  }
  for (const [index, project] of projects.slice(0, 2).entries()) await db.prepare(`INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,'reader',1,1,?4)`).bind(grants[index], member, project, randomUUID()).run();
  await db.prepare("INSERT INTO project_status_names(project_id,status_key,display_name,updated_at,updated_by_principal_id) VALUES(?1,'in_progress','Working together',1,?2)").bind(projects[1], owner).run();
  root = await addIssue("Root");
  for (const [name, project, status, deleted] of [
    ["Done child", projects[0], "done", false], ["Todo child", projects[0], "todo", false],
    ["Canceled child", projects[0], "canceled", false], ["Deleted child", projects[0], "done", true],
    ["Visible cross child", projects[1], "done", false], ["Hidden cross child", projects[2], "done", false],
    ["Archived cross child", projects[3], "done", false],
  ]) await addRelation(await addIssue(name, project, status, deleted), root);
  await addRelation(await addIssue("Removed relation child", projects[0], "done"), root, true);
  await addRelation(await addIssue("Related issue", projects[0], "done"), root, false, "related");
  for (const [name, project, deleted] of [
    ["Visible parent", projects[1], false], ["Hidden parent", projects[2], false],
    ["Deleted parent", projects[0], true], ["Archived parent", projects[3], false],
  ]) await addRelation(root, await addIssue(name, project, "in_progress", deleted));
  await addRelation(root, await addIssue("Removed relation parent"), true);
  multi = await addIssue("Multiple parents");
  parents = [];
  for (let index = 0; index < 12; index++) {
    const parent = await addIssue(`Parent ${index}`, projects[index === 11 ? 2 : index % 2]);
    parents.push(parent); await addRelation(multi, parent);
  }
  const cycleA = await addIssue("Cycle A"), cycleB = await addIssue("Cycle B");
  await addRelation(cycleA, cycleB); await addRelation(cycleB, cycleA);
  await addRelation(fixtures.get("Done child"), multi);
  sessionId = randomUUID(); const created = Date.now();
  const target = { kind: "project", entry_path: `/app/w/${workspace}/p/${projects[0]}`, workspace_id: workspace, project_id: projects[0] };
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at)
    VALUES(?1,?2,?3,'credential',?4,'project',?5,?6,?7)`)
    .bind(sessionId, "c".repeat(64), owner, credential, JSON.stringify(target), created, created + 28_800_000).run();
  fixed = { ...auth, kind: "cookie", sessionId, targetKind: "project", target };
});
after(() => server.close());

test("Hierarchy uses child-to-parent direction and only visible active direct children", async () => {
  const ownerIssue = await getIssue(db, auth, identifier(root), issueUrl());
  assert.deepEqual(ownerIssue.hierarchy.children, { total: 5, done: 3 });
  assert.equal(ownerIssue.hierarchy.parent_count, 2);
  const result = await getIssue(db, reader, identifier(root), issueUrl());
  assert.deepEqual(result.hierarchy, {
    children: { total: 4, done: 2 }, parent_count: 1,
    parents: [{ id: fixtures.get("Visible parent").id, identifier: identifier(fixtures.get("Visible parent")),
      title: "Visible parent", project_id: projects[1], workspace_id: workspace,
      status: { key: "in_progress", display_name: "Working together" } }],
  });
  assert.deepEqual((await getIssue(db, fixed, identifier(root), issueUrl())).hierarchy,
    { children: { total: 3, done: 1 }, parents: [], parent_count: 0 });
  const context = await getIssueContext(db, reader, identifier(root));
  assert.deepEqual(context.issue.hierarchy, result.hierarchy);
  const response = await server.fetch(`/api/v1/issues/${identifier(root)}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).hierarchy, ownerIssue.hierarchy);
});

test("Multiple parents, cycles and the ten-parent bound do not change relation semantics", async () => {
  const result = await getIssue(db, auth, identifier(multi), issueUrl());
  assert.equal(result.hierarchy.parent_count, 12); assert.equal(result.hierarchy.parents.length, 10);
  assert.deepEqual(result.hierarchy.parents.map(parent => parent.id), parents.slice(0, 10).map(parent => parent.id));
  assert.deepEqual(result.hierarchy.children, { done: 1, total: 1 });
  assert.equal((await getIssue(db, reader, identifier(multi), issueUrl())).hierarchy.parent_count, 11);
  for (const [name, parentName] of [["Cycle A", "Cycle B"], ["Cycle B", "Cycle A"]]) {
    const cycle = await getIssue(db, reader, identifier(fixtures.get(name)), issueUrl());
    assert.equal(cycle.hierarchy.parents[0].id, fixtures.get(parentName).id);
    assert.deepEqual(cycle.hierarchy.children, { done: 0, total: 1 });
  }
});

test("Lists and candidates project one page without inheriting filters or changing ordering/cursors", async () => {
  const observed = instrument();
  const page = await listProjectIssues(observed.db, reader, workspace, projects[0], issueUrl({ status: "todo", limit: 5 }));
  assert.equal(observed.queries.filter(hierarchyQuery).length, 1);
  assert.ok(page.items.every(issue => issue.hierarchy)); assert.ok(page.has_more);
  assert.deepEqual(page.items.map(issue => issue.number), page.items.map(issue => issue.number).toSorted((a, b) => b - a));
  const rootPage = await listIssues(db, reader, issueUrl({ q: identifier(root), status: "todo" }));
  assert.equal(rootPage.items.length, 1);
  assert.deepEqual(rootPage.items[0].hierarchy.children, { total: 4, done: 2 });
  const first = await listIssues(db, reader, issueUrl({ limit: 5 }));
  const second = await listIssues(db, reader, issueUrl({ limit: 5, cursor: first.next_cursor }));
  const visible = [...fixtures.values()].filter(issue => issue.project_id === projects[0] && !issue.deleted)
    .toSorted((a, b) => b.number - a.number);
  assert.deepEqual([...first.items, ...second.items].map(issue => issue.number), visible.slice(0, 10).map(issue => issue.number));
  const candidate = await listIssueCandidates(db, reader, issueUrl({ q: identifier(root), assignment: "unassigned", blocked: "include" }));
  assert.equal(candidate.items.length, 1);
  assert.deepEqual(candidate.items[0].hierarchy, rootPage.items[0].hierarchy);
  const deleted = await listIssues(db, auth, issueUrl({ deleted: "only" }));
  assert.ok(deleted.items.length > 0); assert.ok(deleted.items.every(issue => !Object.hasOwn(issue, "hierarchy")));
  const empty = instrument();
  assert.deepEqual((await listIssues(empty.db, reader, issueUrl({ q: "No matching issue" }))).items, []);
  assert.equal(empty.queries.filter(hierarchyQuery).length, 0);
});

test("Source and Grant revocation reject a hierarchy read before or after its SQL", async () => {
  for (const [table, target, context, code] of [
    ["credentials", memberCredential, reader, "UNAUTHORIZED"],
    ["project_grants", grants[0], reader, "NOT_FOUND"],
    ["project_grants", grants[1], reader, "CURSOR_SCOPE_MISMATCH"],
  ]) for (const stage of ["before", "after"]) {
    const paused = barrier(stage);
    const pending = listProjectIssues(paused.db, context, workspace, projects[0], issueUrl({ q: identifier(root) }));
    const rejected = assert.rejects(pending, error => error.code === code);
    await paused.reached;
    await db.prepare(`UPDATE ${table} SET revoked_at=20,revoked_by_principal_id=?1 WHERE id=?2`).bind(owner, target).run();
    paused.release();
    try {
      await rejected;
      if (stage === "before") {
        const rows = paused.queries.find(hierarchyQuery).results;
        if (target === grants[1]) assert.ok(rows.every(row => row.parent_project_id !== projects[1]));
        else assert.equal(rows.length, 0);
      }
    } finally {
      await db.prepare(`UPDATE ${table} SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1`).bind(target).run();
    }
  }
});

test("Details and context reject a changed visible relation scope before returning summaries", async () => {
  for (const read of [database => getIssue(database, reader, identifier(root), issueUrl()),
    database => getIssueContext(database, reader, identifier(root))]) {
    const paused = barrier("after"); const pending = read(paused.db);
    const rejected = assert.rejects(pending, error => error.code === "CURSOR_SCOPE_MISMATCH");
    await paused.reached;
    await db.prepare("UPDATE project_grants SET revoked_at=20,revoked_by_principal_id=?1 WHERE id=?2").bind(owner, grants[1]).run();
    paused.release();
    try { await rejected; } finally {
      await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(grants[1]).run();
    }
  }
});

test("Paused containers and expired or revoked Sessions are excluded and reject stale reads", async () => {
  for (const [table, target, context, code] of [
    ["projects", projects[1], reader, "CURSOR_SCOPE_MISMATCH"],
    ["workspaces", workspace, reader, "NOT_FOUND"],
    ["web_sessions", sessionId, fixed, "UNAUTHORIZED"],
  ]) {
    const paused = barrier("before");
    const pending = listProjectIssues(paused.db, context, workspace, projects[0], issueUrl({ q: identifier(root) }));
    const rejected = assert.rejects(pending, error => error.code === code);
    await paused.reached;
    const column = table === "web_sessions" ? "revoked_at" : "deleted_at";
    const actor = table === "web_sessions" ? "" : ",deleted_by_principal_id=?2";
    await db.prepare(`UPDATE ${table} SET ${column}=20${actor} WHERE id=?1`).bind(target, ...(actor ? [owner] : [])).run();
    paused.release();
    try { await rejected; } finally {
      await db.prepare(`UPDATE ${table} SET ${column}=NULL${actor ? ",deleted_by_principal_id=NULL" : ""} WHERE id=?1`).bind(target).run();
    }
  }
  const oldExpiry = (await db.prepare("SELECT expires_at FROM web_sessions WHERE id=?1").bind(sessionId).first()).expires_at;
  await db.prepare("UPDATE web_sessions SET expires_at=?2 WHERE id=?1").bind(sessionId, Date.now() - 1).run();
  try { await assert.rejects(getIssue(db, fixed, identifier(root), issueUrl()), error => error.code === "UNAUTHORIZED"); }
  finally { await db.prepare("UPDATE web_sessions SET expires_at=?2 WHERE id=?1").bind(sessionId, oldExpiry).run(); }
});

test("Page hierarchy reads use incident relation indexes and stay independent of unrelated history", async t => {
  const samples = [];
  for (const size of [0, 1000, 5000]) {
    if (size > 0) {
      const prefix = size === 1000 ? "60000000-0000-4000-8000" : "70000000-0000-4000-8000";
      await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
        INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
        SELECT printf('%s-%012x',?2,n),?3,printf('Unrelated %d',n),printf('unrelated %d',n),'todo',1,1,?4,?4,printf('unrelated-%s-%d',?2,n) FROM seq`)
        .bind(size, prefix, projects[0], owner).run();
      await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
        INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id)
        SELECT printf('%s-%012x',?2,n),?3,'parent',printf('%s-%012x',?2,n),printf('%s-%012x',?2,n-1),?4,?4,1,?5,printf('unrelated-relation-%s-%d',?2,n) FROM seq`)
        .bind(size, prefix, workspace, projects[0], owner).run();
    }
    const observed = instrument();
    const page = await listIssues(observed.db, reader, issueUrl({ q: identifier(root), limit: 20 }));
    assert.deepEqual(page.items[0].hierarchy.children, { total: 4, done: 2 });
    const queries = observed.queries.filter(hierarchyQuery); assert.equal(queries.length, 1);
    const query = queries[0];
    const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all()).results.map(row => row.detail).join("\n");
    assert.match(plan, /idx_issue_relations_source/u); assert.match(plan, /idx_issue_relations_target/u);
    assert.ok(query.rows_read < 250, `hierarchy read ${query.rows_read} rows after adding ${size} unrelated rows`);
    assert.equal(query.rows_written, 0); assert.equal(query.returned, 1);
    samples.push({ added_unrelated_rows: size, rows_read: query.rows_read, returned: query.returned, duration_ms: query.duration_ms });
  }
  assert.ok(samples.every(sample => sample.rows_read <= samples[0].rows_read + 10));
  const pageObserved = instrument();
  assert.equal((await listIssues(pageObserved.db, reader, issueUrl({ limit: 20 }))).items.length, 20);
  assert.equal(pageObserved.queries.filter(hierarchyQuery).length, 1);
  t.diagnostic(JSON.stringify({ scenario: "local-d1-issue-hierarchy", samples, incident_relation_write: relationWriteCost,
    twenty_issue_page_queries: pageObserved.queries.filter(hierarchyQuery).length }));
  t.diagnostic("本地 D1 meta 与 EXPLAIN 仅是隔离观测，不代表线上计费读量、迁移成本或高扇出关系的固定读取上界；本次没有增加索引。");
});
