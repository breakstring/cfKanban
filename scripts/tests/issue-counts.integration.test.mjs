import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { countProjectIssues, listProjectIssues } from "../../apps/worker/src/services/issues.ts";

// TestHarness 固定 127.0.0.1:0、persist:false；配置仅含全零本地 D1 ID。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const owner = randomUUID(), credential = randomUUID(), member = randomUUID(), memberCredential = randomUUID();
const workspace = randomUUID(), projects = Array.from({ length: 4 }, () => randomUUID());
const grant = randomUUID(), labels = Array.from({ length: 4 }, () => randomUUID());
const ownerToken = `cfk_v1_counts_${"A".repeat(43)}`;
const statuses = ["backlog", "todo", "in_progress", "done", "canceled"];
const priorityKeys = ["urgent", "high", "medium", "low", "none"];
const auth = { kind: "bearer", isOwner: true, principalId: owner, credentialId: credential, credentialFingerprint: "test", displayName: "CountOwner", principalVersion: 1 };
const reader = { ...auth, isOwner: false, principalId: member, credentialId: memberCredential, displayName: "CountReader" };
const examples = [];
let db;

function path(project = projects[0]) { return `/api/v1/workspaces/${workspace}/projects/${project}/issues/counts`; }
function url(params = {}, project = projects[0]) {
  const result = new URL(`https://kanban.example.test${path(project)}`);
  for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) result.searchParams.append(key, item);
  return result;
}
function count(params = {}, context = auth, project = projects[0], database = db) {
  return countProjectIssues(database, context, workspace, project, url(params, project));
}
function expected(params = {}, context = auth) {
  const counts = Object.fromEntries(statuses.map(key => [key, 0]));
  const values = name => params[name] === undefined ? [] : Array.isArray(params[name]) ? params[name] : [params[name]];
  for (const row of examples) {
    if (row.deleted || values("status").length && !values("status").includes(row.status)) continue;
    if (values("priority").length && !values("priority").includes(row.priority)) continue;
    if (values("assignee").length && !values("assignee").includes(row.assignee ?? "unassigned")) continue;
    if (values("label").length && !row.labels.some(id => id !== labels[2] && values("label").includes(id))) continue;
    if (params.q && row.number !== Number(params.q.toLowerCase().replace(/^cfk-/, "")) && !row.title.includes(params.q.normalize("NFKC").toLowerCase().trim())) continue;
    const blocked = row.blocked || row.n === 2 && context.isOwner;
    if (params.blocked === "only" && !blocked || params.blocked === "exclude" && blocked) continue;
    counts[row.status]++;
  }
  return { counts, total_count: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}
function instrument(database, hook = async () => {}) {
  const queries = [];
  function wrap(statement, sql, values = []) {
    return new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args) => wrap(target.bind(...args), sql, args);
      if (key === "all") return async (...args) => {
        await hook(sql, "before");
        const started = performance.now(), result = await target.all(...args);
        const query = { sql, values, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written, returned: result.results.length, duration_ms: performance.now() - started };
        queries.push(query);
        await hook(sql, "after");
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  return { queries, db: new Proxy(database, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
function aggregate(query) { return query.sql.includes("GROUP BY i.status_key"); }
function barrier(stage) {
  let reach, release;
  const reached = new Promise(resolve => { reach = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const measured = instrument(db, async (sql, currentStage) => {
    if (sql.includes("GROUP BY i.status_key") && currentStage === stage) { reach(); await released; }
  });
  return { ...measured, reached, release };
}
async function batches(statements) {
  for (let start = 0; start < statements.length; start += 80) await db.batch(statements.slice(start, start + 80));
}

before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner, ownerCredentialId: credential, ownerCredentialToken: ownerToken, ownerDisplayName: "CountOwner", preferredApiOrigin: "https://kanban.example.test" });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'CountReader','countreader',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'test',?3,1,?4)").bind(memberCredential, member, "b".repeat(64), randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Counts',1,1,?2,?2,?3)").bind(workspace, owner, randomUUID()).run();
  for (const project of projects) await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Counts',1,1,?3,?3,?4)").bind(project, workspace, owner, randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)").bind(grant, member, projects[0], randomUUID()).run();
  for (const [n, id] of labels.entries()) await db.prepare("INSERT INTO labels(id,project_id,name,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,?3,?4,?5,1,1,?6,?6,?7)").bind(id, projects[n === 3 ? 2 : 0], `CountLabel${n}`, n === 2 ? 2 : null, n === 2 ? owner : null, owner, randomUUID()).run();
  const statements = [];
  for (let n = 0; n < 650; n++) {
    const row = { id: randomUUID(), n, title: `${n % 7 === 0 ? "needle" : "ordinary"} issue ${n}`, status: statuses[n % 5], priority: ["urgent", "high", "none"][n % 3], assignee: n % 2 ? owner : null, blocked: n === 1 ? "waiting" : null, deleted: n === 0, labels: [n % 3 === 0 ? labels[0] : null, n % 4 === 0 ? labels[1] : null, n % 5 === 0 ? labels[2] : null].filter(Boolean) };
    examples.push(row);
    statements.push(db.prepare(`INSERT INTO issues(id,project_id,title,title_search,status_key,priority_key,priority_rank,assignee_principal_id,blocked_reason,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES(?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,1,1,?11,?11,?12)`)
      .bind(row.id, projects[0], row.title, row.status, row.priority, priorityKeys.indexOf(row.priority), row.assignee, row.blocked, row.deleted ? 2 : null, row.deleted ? owner : null, owner, randomUUID()));
  }
  await batches(statements);
  const numbers = await db.prepare("SELECT id,number FROM issues WHERE project_id=?1").bind(projects[0]).all();
  const byId = new Map(numbers.results.map(row => [row.id, row.number]));
  for (const row of examples) row.number = byId.get(row.id);
  await batches(examples.flatMap(row => row.labels.map(label => db.prepare("INSERT INTO issue_labels VALUES(?1,?2,1,?3,?4)").bind(row.id, label, owner, randomUUID()))));
  const blocker = randomUUID();
  await db.prepare("INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'blocker','blocker','todo',1,1,?3,?3,?4)").bind(blocker, projects[2], owner, randomUUID()).run();
  await db.prepare("INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id) VALUES(?1,?2,'blocks',?3,?4,?5,?6,1,?7,?8)").bind(randomUUID(), workspace, blocker, examples[2].id, projects[2], projects[0], owner, randomUUID()).run();
});
after(() => server.close());

test("Project counts include all active Issues beyond 20 and 100 without loading pages", async () => {
  const measured = instrument(db);
  const result = await count({}, auth, projects[0], measured.db);
  assert.deepEqual(result.counts, expected().counts);
  assert.equal(result.total_count, 649);
  assert.ok(Object.values(result.counts).every(value => value > 100));
  assert.equal(measured.queries.filter(aggregate).length, 1);
  assert.equal(measured.queries.filter(aggregate)[0].returned, 5);
  assert.equal(result.resolved_scope.projects.length, 1);
  const pageMeasured = instrument(db);
  const page = await listProjectIssues(pageMeasured.db, auth, workspace, projects[0], url({ limit: 20 }));
  assert.equal(page.items.length, 20); assert.equal(page.has_more, true);
  assert.ok(pageMeasured.queries.every(query => !aggregate(query) && !query.sql.includes("COUNT(*)")));
  const empty = await count({}, auth, projects[1]);
  assert.deepEqual(empty.counts, Object.fromEntries(statuses.map(key => [key, 0])));
  assert.equal(empty.total_count, 0);
  const response = await server.fetch(path(), { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).total_count, 649);
});

test("Counts share list filter semantics, normalized search and label deduplication", async () => {
  for (const params of [
    { priority: ["urgent", "high"], label: [labels[0], labels[1]] },
    { q: "needle", priority: "urgent", label: labels[0], assignee: "unassigned" },
    { status: ["todo", "in_progress"], assignee: [owner, "unassigned"], label: [labels[0], labels[0], labels[1]] },
    { blocked: "only" }, { blocked: "exclude" }, { q: "no matching issue" },
    { q: `CFK-${examples[30].number}` },
  ]) {
    const result = await count(params);
    assert.deepEqual(result.counts, expected(params).counts, JSON.stringify(params));
    assert.equal(result.total_count, expected(params).total_count);
  }
  const normalized = await count({ q: "  ＮＥＥＤＬＥ  " });
  assert.deepEqual(normalized.counts, expected({ q: "needle" }).counts);
  for (const label of [randomUUID(), labels[2], labels[3]]) assert.equal((await count({ label })).total_count, 0);
  assert.equal((await count({ label: [randomUUID(), labels[0]] })).total_count, expected({ label: labels[0] }).total_count);
});

test("Counts reject paging/deletion parameters and invalid filters", async () => {
  for (const params of [{ deleted: "exclude" }, { deleted: "only" }, { cursor: "" }, { limit: "20" }, { priority: "critical" }, { label: "invalid" }, { status: "invalid" }, { assignee: "invalid" }, { priority: Array(6).fill("high") }, { label: Array(21).fill(labels[0]) }]) {
    await assert.rejects(count(params), error => error.code === "VALIDATION_ERROR");
  }
});

test("Reader and fixed Session counts respect Project and visible-blocker scope", async () => {
  assert.deepEqual((await count({}, reader)).counts, expected({}, reader).counts);
  assert.deepEqual((await count({ blocked: "only" }, reader)).counts, expected({ blocked: "only" }, reader).counts);
  await assert.rejects(count({}, reader, projects[2]), error => error.code === "NOT_FOUND");
  const sessionId = randomUUID();
  const target = { kind: "project", entry_path: `/app/w/${workspace}/p/${projects[0]}`, workspace_id: workspace, project_id: projects[0] };
  const sessionCreatedAt = Date.now();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at) VALUES(?1,?2,?3,'credential',?4,'project',?5,?6,?7)").bind(sessionId, "c".repeat(64), owner, credential, JSON.stringify(target), sessionCreatedAt, sessionCreatedAt + 28_800_000).run();
  const fixed = { ...auth, kind: "cookie", sessionId, targetKind: "project", target };
  assert.equal((await count({}, fixed)).total_count, 649);
  await assert.rejects(count({}, fixed, projects[2]), error => error.code === "NOT_FOUND");
  assert.equal((await count({ label: labels[3] }, fixed)).total_count, 0);
});

test("Count SQL rechecks revocation before aggregation and rejects revocation after aggregation", async () => {
  for (const [table, id, context] of [["credentials", memberCredential, reader], ["project_grants", grant, reader], ["projects", projects[0], auth], ["workspaces", workspace, auth]]) {
    for (const stage of ["before", "after"]) {
      const paused = barrier(stage);
      const promise = count({}, context, projects[0], paused.db);
      const rejected = assert.rejects(promise, error => error.code === (table === "credentials" ? "UNAUTHORIZED" : "NOT_FOUND"));
      await paused.reached;
      const column = table === "credentials" || table === "project_grants" ? "revoked_at" : "deleted_at";
      const actor = column === "revoked_at" ? "revoked_by_principal_id" : "deleted_by_principal_id";
      await db.prepare(`UPDATE ${table} SET ${column}=2,${actor}=?1 WHERE id=?2`).bind(owner, id).run();
      paused.release();
      try {
        await rejected;
        if (stage === "before") assert.equal(paused.queries.filter(aggregate)[0].returned, 0);
      } finally {
        await db.prepare(`UPDATE ${table} SET ${column}=NULL,${actor}=NULL WHERE id=?1`).bind(id).run();
      }
    }
  }
});

test("A changed visible relation Project set invalidates a blocked count snapshot", async () => {
  const relationGrant = randomUUID();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)").bind(relationGrant, member, projects[2], randomUUID()).run();
  const paused = barrier("after");
  const pending = count({ blocked: "only" }, reader, projects[0], paused.db);
  const rejected = assert.rejects(pending, error => error.code === "CURSOR_SCOPE_MISMATCH");
  await paused.reached;
  await db.prepare("UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2").bind(owner, relationGrant).run();
  paused.release();
  await rejected;
  assert.deepEqual((await count({ blocked: "only" }, reader)).counts, expected({ blocked: "only" }, reader).counts);
});

test("One aggregate stays internally consistent during status writes while list snapshots may differ", async () => {
  const paused = barrier("after");
  const pending = count({}, auth, projects[0], paused.db);
  await paused.reached;
  await db.prepare("UPDATE issues SET status_key='done',version=version+1 WHERE id=?1").bind(examples[5].id).run();
  paused.release();
  try {
    const snapshot = await pending;
    assert.deepEqual(snapshot.counts, expected().counts);
    assert.equal(snapshot.total_count, Object.values(snapshot.counts).reduce((sum, value) => sum + value, 0));
    const current = await count();
    assert.equal(current.counts.backlog, snapshot.counts.backlog - 1);
    assert.equal(current.counts.done, snapshot.counts.done + 1);
    assert.equal(current.total_count, snapshot.total_count);
  } finally {
    await db.prepare("UPDATE issues SET status_key='backlog',version=version+1 WHERE id=?1").bind(examples[5].id).run();
  }
});

test("Exact counts report local D1 costs and use the existing status index without writes", async t => {
  const observations = [];
  for (const params of [{}, { status: "todo" }, { priority: "urgent", label: labels[0] }, { q: "no matching issue" }]) {
    const measured = instrument(db);
    const result = await count(params, auth, projects[0], measured.db);
    const query = measured.queries.find(aggregate);
    assert.ok(Number.isFinite(query.rows_read)); assert.equal(query.rows_written, 0);
    assert.ok(query.returned <= 5);
    const explain = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
    if (!Object.keys(params).length) {
      assert.ok(explain.results.some(row => String(row.detail).includes("idx_issues_active_status_order")));
      assert.ok(query.rows_read > 100, "exact totals scan the matching set rather than one page");
    }
    observations.push({ params, total_count: result.total_count, rows_read: query.rows_read, returned: query.returned, duration_ms: query.duration_ms,
      ...(!Object.keys(params).length ? { plan: explain.results.map(row => row.detail) } : {}) });
  }
  t.diagnostic(`Local workerd D1 evidence only; counts add no counters, indexes or writes: ${JSON.stringify(observations)}`);
});

test("Exact count reads grow with data while response remains five rows", async t => {
  const observations = [];
  for (const [from, to] of [[0, 250], [250, 1000]]) {
    await db.prepare(`WITH RECURSIVE sample(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM sample WHERE n+1<?2)
      INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      SELECT 'count-cost-'||n,?3,'Count cost','count cost',
        CASE n%5 WHEN 0 THEN 'backlog' WHEN 1 THEN 'todo' WHEN 2 THEN 'in_progress' WHEN 3 THEN 'done' ELSE 'canceled' END,
        1,1,?4,?4,'count-cost-operation-'||n FROM sample`).bind(from, to, projects[3], owner).run();
    const measured = instrument(db);
    const result = await count({}, auth, projects[3], measured.db);
    const query = measured.queries.find(aggregate);
    assert.equal(result.total_count, to); assert.equal(query.returned, 5); assert.equal(query.rows_written, 0);
    observations.push({ issue_count: to, rows_read: query.rows_read, returned: query.returned });
  }
  assert.ok(observations[1].rows_read > observations[0].rows_read);
  t.diagnostic(`Local workerd D1 growth evidence, not production measurements: ${JSON.stringify(observations)}`);
});
