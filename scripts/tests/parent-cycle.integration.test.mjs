import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { getIssue } from "../../apps/worker/src/services/issues.ts";
import { createIssueRelation, deleteRelation, restoreRelation } from "../../apps/worker/src/services/relations.ts";

// 全零 D1 ID、127.0.0.1:0、persist:false；所有历史图及身份均为本地合成 fixture。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const origin = "https://parent-cycle.example.test", owner = randomUUID(), credential = randomUUID();
const writer = randomUUID(), writerCredential = randomUUID(), workspace = randomUUID();
const projects = [randomUUID(), randomUUID()], ownerToken = `cfk_v1_parent_${"A".repeat(43)}`, writerToken = `cfk_v1_writer_${"B".repeat(43)}`;
const auth = { kind: "bearer", isOwner: true, principalId: owner, credentialId: credential,
  credentialFingerprint: "synthetic", displayName: "ParentOwner", principalVersion: 1 };
const writerAuth = { ...auth, isOwner: false, principalId: writer, credentialId: writerCredential, displayName: "ParentWriter" };
let db;

const identifier = issue => `CFK-${issue.number}`;
const mutationRequest = (path, key = randomUUID()) => new Request(`${origin}${path}`, { method: "POST", headers: { "idempotency-key": key } });
const graphQuery = query => query.sql.includes("WITH RECURSIVE parent_graph_scope");

function instrument(beforeBatch = async () => {}) {
  const queries = [], raw = new WeakMap();
  const wrap = (statement, sql, values = []) => {
    const wrapped = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...bound) => wrap(target.bind(...bound), sql, bound);
      if (["all", "first", "run"].includes(key)) return async (...args) => {
        const start = performance.now(), result = key === "run" ? await target.run(...args) : await target.all();
        queries.push({ sql, values, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written,
          results: result.results, duration_ms: performance.now() - start });
        return key === "first" ? (args[0] ? result.results[0]?.[args[0]] ?? null : result.results[0] ?? null) : result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    raw.set(wrapped, { statement, sql, values }); return wrapped;
  };
  return { queries, db: new Proxy(db, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    if (key === "batch") return async statements => {
      const operations = statements.map(statement => raw.get(statement));
      await beforeBatch(operations);
      const result = await target.batch(operations.map(operation => operation.statement));
      result.forEach((item, index) => queries.push({ sql: operations[index].sql, values: operations[index].values,
        rows_read: item.meta.rows_read, rows_written: item.meta.rows_written, results: item.results }));
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

async function addIssue(name, project = projects[0]) {
  const id = randomUUID();
  await db.prepare(`INSERT INTO issues(id,project_id,title,title_search,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,?3,?3,1,1,?4,?4,?5)`).bind(id, project, name, owner, randomUUID()).run();
  return current({ id });
}
const current = issue => db.prepare("SELECT id,number,project_id,title,version FROM issues WHERE id=?1").bind(issue.id).first();
async function addRawRelation(source, target, deleted = false, kind = "parent") {
  const id = randomUUID();
  await db.prepare(`INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,
    created_at,created_by_principal_id,created_operation_id,deleted_at,deleted_by_principal_id)
    VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11)`)
    .bind(id, workspace, kind, source.id, target.id, source.project_id, target.project_id, owner, randomUUID(), deleted ? 2 : null, deleted ? owner : null).run();
  return { id, source, target };
}
async function createParent(source, target, { database = db, context = auth, key = randomUUID(), versions, kind = "parent" } = {}) {
  const [currentSource, currentTarget] = versions ?? await Promise.all([current(source), current(target)]);
  return createIssueRelation(database, mutationRequest(`/api/v1/issues/${identifier(source)}/relations`, key), context,
    identifier(source), identifier(target), kind, currentSource.version, currentTarget.version, Date.now());
}
async function restoreParent(relation, { database = db, context = auth, key = randomUUID(), versions } = {}) {
  const [source, target] = versions ?? await Promise.all([current(relation.source), current(relation.target)]);
  const row = await db.prepare("SELECT version FROM issue_relations WHERE id=?1").bind(relation.id).first();
  return restoreRelation(database, mutationRequest(`/api/v1/relations/${relation.id}/commands/restore`, key), context,
    relation.id, row.version, source.version, target.version, Date.now());
}
async function snapshot(issueIds = []) {
  const counts = await db.prepare(`SELECT (SELECT COUNT(*) FROM issue_relations) AS relations,
    (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM operation_commits) AS commits,
    (SELECT COUNT(*) FROM idempotency_records) AS idempotency`).first();
  const versions = (await db.prepare("SELECT id,version,last_operation_id FROM issues WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id")
    .bind(JSON.stringify(issueIds)).all()).results;
  return { counts, versions };
}
const cycleError = error => error.code === "RELATION_CYCLE" && error.status === 409 && error.category === "conflict"
  && error.recovery === "choose_different_parent" && !error.retryable && Object.keys(error.details).length === 0;
const budgetError = error => error.code === "RELATION_GRAPH_TOO_LARGE" && error.status === 400 && error.category === "validation"
  && error.recovery === "simplify_parent_graph" && !error.retryable && JSON.stringify(error.details) === '{"max_ancestors":1000}';

before(async () => {
  await server.listen(); await server.getWorker().applyD1Migrations("DB"); ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: credential, ownerCredentialToken: ownerToken, ownerDisplayName: "ParentOwner", preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'ParentWriter','parentwriter',1,1)").bind(writer).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,1,?4)")
    .bind(writerCredential, writer, createHash("sha256").update(writerToken).digest("hex"), randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Parent graph',1,1,?2,?2,?3)").bind(workspace, owner, randomUUID()).run();
  for (const project of projects) await db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,
    created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Parent graph',1,1,?3,?3,?4)`)
    .bind(project, workspace, owner, randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'writer',1,1,?4)")
    .bind(randomUUID(), writer, projects[0], randomUUID()).run();
});
after(() => server.close());

test("Acyclic multi-parent writes commit CAS and events; a new back edge changes no business state", async () => {
  const a = await addIssue("Branch A"), b = await addIssue("Branch B"), c = await addIssue("Branch C"), d = await addIssue("Branch D");
  const first = await createParent(a, b); assert.equal(first.resource.kind, "parent");
  await createParent(a, c); await createParent(c, d);
  assert.equal((await getIssue(db, auth, identifier(a), new URL(origin))).hierarchy.parent_count, 2);
  const before = await snapshot([a.id, b.id, c.id, d.id]);
  await assert.rejects(createParent(d, a), cycleError);
  assert.deepEqual(await snapshot([a.id, b.id, c.id, d.id]), before);
  await assert.rejects(createParent(a, a), error => error.code === "VALIDATION_ERROR");
  const [source, target] = await Promise.all([current(d), current(a)]);
  const response = await server.fetch(`/api/v1/issues/${identifier(d)}/relations`, { method: "POST", headers: {
    authorization: `Bearer ${ownerToken}`, "content-type": "application/json", "idempotency-key": randomUUID(),
  }, body: JSON.stringify({ kind: "parent", target_identifier: identifier(a), source_expected_version: source.version, target_expected_version: target.version }) });
  assert.equal(response.status, 409);
  const body = await response.json(); assert.equal(body.code, "RELATION_CYCLE"); assert.deepEqual(body.details, {});
  assert.equal(response.headers.get("x-request-id"), body.request_id);
  const stale = await createParent(d, b, { versions: [{ ...source, version: 0 }, target] }).catch(error => error);
  assert.equal(stale.code, "VERSION_CONFLICT");
});

test("Hidden, soft-deleted and paused intermediate topology cannot hide a cycle or leak its path", async () => {
  const a = await addIssue("Visible A"), b = await addIssue("Visible B"), hidden = await addIssue("Hidden intermediary", projects[1]);
  const edge = await addRawRelation(b, hidden); await addRawRelation(hidden, a);
  for (const state of ["active", "deleted-issue", "paused-project"]) {
    if (state === "deleted-issue") await db.prepare("UPDATE issues SET deleted_at=2,deleted_by_principal_id=?2 WHERE id=?1").bind(hidden.id, owner).run();
    if (state === "paused-project") await db.prepare("UPDATE projects SET deleted_at=2,deleted_by_principal_id=?2 WHERE id=?1").bind(projects[1], owner).run();
    const before = await snapshot([a.id, b.id]);
    const error = await createParent(a, b, { context: writerAuth }).catch(error => error);
    assert.ok(cycleError(error)); assert.doesNotMatch(JSON.stringify(error.details), new RegExp(`${hidden.id}|${projects[1]}|Hidden intermediary`, "u"));
    assert.deepEqual(await snapshot([a.id, b.id]), before);
  }
  await db.prepare("UPDATE issues SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(hidden.id).run();
  await db.prepare("UPDATE projects SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(projects[1]).run();
  const denied = instrument();
  await assert.rejects(createParent(a, hidden, { context: writerAuth, database: denied.db }), error => error.code === "NOT_FOUND");
  assert.equal(denied.queries.filter(graphQuery).length, 0);
  await db.prepare("UPDATE issue_relations SET deleted_at=2,deleted_by_principal_id=?2 WHERE id=?1").bind(edge.id, owner).run();
  assert.equal((await createParent(a, b, { context: writerAuth })).resource.kind, "parent");
});

test("Parent restoration rejects a closing edge, then supports safe restore and immutable replay", async () => {
  const a = await addIssue("Restore A"), b = await addIssue("Restore B");
  const removed = await addRawRelation(a, b, true), existing = await addRawRelation(b, a);
  const before = await snapshot([a.id, b.id]);
  await assert.rejects(restoreParent(removed), cycleError);
  assert.deepEqual(await snapshot([a.id, b.id]), before);
  assert.equal((await db.prepare("SELECT deleted_at,version FROM issue_relations WHERE id=?1").bind(removed.id).first()).version, 1);
  await db.prepare("UPDATE issue_relations SET deleted_at=2,deleted_by_principal_id=?2 WHERE id=?1").bind(existing.id, owner).run();
  const key = randomUUID(), versions = await Promise.all([current(a), current(b)]);
  const result = await restoreParent(removed, { key, versions });
  assert.equal(result.resource.version, 2); assert.equal(result.idempotent_replay, false);
  const committed = await snapshot([a.id, b.id]);
  const replay = await restoreRelation(db, mutationRequest(`/api/v1/relations/${removed.id}/commands/restore`, key), auth,
    removed.id, 1, versions[0].version, versions[1].version, Date.now());
  assert.equal(replay.idempotent_replay, true); assert.deepEqual(replay.resource, result.resource);
  assert.deepEqual(await snapshot([a.id, b.id]), committed);
});

async function disjointRace(restore) {
  const a = await addIssue(`Race ${restore} A`), b = await addIssue(`Race ${restore} B`);
  const c = await addIssue(`Race ${restore} C`), d = await addIssue(`Race ${restore} D`);
  await addRawRelation(b, c); await addRawRelation(d, a);
  const removed = restore ? [await addRawRelation(a, b, true), await addRawRelation(c, d, true)] : [];
  const versions = await Promise.all([current(a), current(b), current(c), current(d)]);
  let ready, release, reached = 0;
  const bothReady = new Promise(resolve => { ready = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const observed = instrument(async statements => {
    if (statements.some(graphQuery)) { reached++; if (reached === 2) ready(); await released; }
  });
  const calls = restore
    ? [restoreParent(removed[0], { database: observed.db, versions: versions.slice(0, 2) }),
      restoreParent(removed[1], { database: observed.db, versions: versions.slice(2) })]
    : [createParent(a, b, { database: observed.db, versions: versions.slice(0, 2) }),
      createParent(c, d, { database: observed.db, versions: versions.slice(2) })];
  const before = await snapshot([a.id, b.id, c.id, d.id]);
  const pending = Promise.allSettled(calls); await bothReady; release();
  const results = await pending;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(cycleError(results.find(result => result.status === "rejected").reason));
  const after = await snapshot([a.id, b.id, c.id, d.id]);
  assert.equal(after.counts.events - before.counts.events, 1);
  assert.equal(after.counts.commits - before.counts.commits, 1);
  assert.equal(after.versions.reduce((sum, row) => sum + row.version, 0) - before.versions.reduce((sum, row) => sum + row.version, 0), 2);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM issue_relations WHERE deleted_at IS NULL
    AND (source_issue_id=?1 AND target_issue_id=?2 OR source_issue_id=?3 AND target_issue_id=?4)`)
    .bind(a.id, b.id, c.id, d.id).first()).n, 1);
}
test("Concurrent new edges with disjoint endpoint CAS cannot jointly close a parent cycle", () => disjointRace(false));
test("Concurrent restores with disjoint endpoint CAS cannot jointly close a parent cycle", () => disjointRace(true));

test("Historical cycles stay readable and removable while safe unrelated attachment still works", async () => {
  const a = await addIssue("Historical A"), b = await addIssue("Historical B"), newcomer = await addIssue("Historical newcomer");
  const edge = await addRawRelation(a, b); await addRawRelation(b, a);
  const hierarchy = (await getIssue(db, auth, identifier(a), new URL(origin))).hierarchy;
  assert.equal(hierarchy.parents[0].id, b.id); assert.deepEqual(hierarchy.children, { total: 1, done: 0 });
  assert.equal((await createParent(newcomer, a)).resource.kind, "parent");
  const [source, target] = await Promise.all([current(a), current(b)]);
  const deleted = await deleteRelation(db, auth, edge.id, 1, source.version, target.version, Date.now());
  assert.ok(deleted.resource.deleted_at); assert.equal(deleted.resource.version, 2);
  assert.equal((await getIssue(db, auth, identifier(a), new URL(origin))).hierarchy.parent_count, 0);
});

async function fixtureGraph(prefix, size, dense = false) {
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
    INSERT INTO issues(id,project_id,title,title_search,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    SELECT printf('%s-%012x',?2,n),?3,printf('Ancestor %d',n),printf('ancestor %d',n),1,1,?4,?4,printf('ancestor-%s-%d',?2,n) FROM seq`)
    .bind(size, prefix, projects[0], owner).run();
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
    INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id)
    SELECT printf('%s-%012x',?2,source.n*?1+target.n),?3,'parent',printf('%s-%012x',?2,source.n),printf('%s-%012x',?2,target.n),?4,?4,1,?5,
      printf('ancestor-relation-%s-%d-%d',?2,source.n,target.n)
    FROM seq source CROSS JOIN seq target WHERE ${dense ? "target.n>source.n" : "target.n=source.n+1"}`)
    .bind(size, prefix, workspace, projects[0], owner).run();
  return Array.from({ length: size }, (_, index) => ({ id: `${prefix}-${(index + 1).toString(16).padStart(12, "0")}` }));
}

test("Exactly 1000 ancestors pass; 1001 fail closed for both creation and restoration", async t => {
  const nodes = await fixtureGraph("80000000-0000-4000-8000", 1000);
  const target = await current(nodes[0]), source = await addIssue("At limit source");
  const observed = instrument(); assert.equal((await createParent(source, target, { database: observed.db })).resource.kind, "parent");
  const safeQuery = observed.queries.find(graphQuery); assert.ok(safeQuery);
  const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${safeQuery.sql}`).bind(...safeQuery.values).all()).results.map(row => row.detail).join("\n");
  assert.match(plan, /idx_issue_relations_source/u);
  const extra = await addIssue("Ancestor 1001"), last = await current(nodes.at(-1));
  const overflowEdge = await addRawRelation(last, extra);
  const rejectedSource = await addIssue("Over limit source"), before = await snapshot([rejectedSource.id, target.id]);
  const rejected = instrument();
  await assert.rejects(createParent(rejectedSource, target, { database: rejected.db }), budgetError);
  assert.deepEqual(await snapshot([rejectedSource.id, target.id]), before);
  const diagnostic = rejected.queries.find(graphQuery);
  assert.deepEqual(diagnostic.results, [{ ancestor_count: 1001, forms_cycle: 0 }]);
  const restoringSource = await addIssue("Over limit restore"), removed = await addRawRelation(restoringSource, target, true);
  await assert.rejects(restoreParent(removed), budgetError);
  await db.prepare("UPDATE issue_relations SET deleted_at=2,deleted_by_principal_id=?2 WHERE id=?1").bind(overflowEdge.id, owner).run();
  assert.equal((await restoreParent(removed)).resource.version, 2);
  t.diagnostic(JSON.stringify({ scenario: "local-d1-parent-ancestor-budget", allowed_ancestors: 1000,
    allowed_guard_rows_read: safeQuery.rows_read, rejected_ancestors: diagnostic.results[0].ancestor_count,
    rejected_probe_rows_read: diagnostic.rows_read }));
});

test("Dense acyclic ancestor graphs deduplicate nodes while recording the actual edge-read cost", async t => {
  const size = 100, nodes = await fixtureGraph("90000000-0000-4000-8000", size, true);
  const target = await current(nodes[0]), source = await addIssue("Dense source"), observed = instrument();
  assert.equal((await createParent(source, target, { database: observed.db })).resource.kind, "parent");
  const query = observed.queries.find(graphQuery); assert.ok(query.rows_read > size);
  assert.equal((await getIssue(db, auth, identifier(target), new URL(origin))).hierarchy.parent_count, size - 1);
  t.diagnostic(JSON.stringify({ scenario: "local-d1-dense-parent-graph", ancestor_nodes: size,
    parent_edges: size * (size - 1) / 2, guard_rows_read: query.rows_read, guard_rows_written: query.rows_written }));
  t.diagnostic("本地 workerd D1 meta 不是线上计费保证；1000个不同祖先预算不是1000条读取行预算，稠密祖先图会读取更多边。本次复用已有索引，没有migration或新增索引写放大。");
});
