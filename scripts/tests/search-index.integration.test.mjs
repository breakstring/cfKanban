import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { authenticateBearer, authenticateCookieSession } from "../../apps/worker/src/kernel/auth.ts";
import { getSearchIndexChanges, getSearchIndexSnapshot, getSearchIndexStatus } from "../../apps/worker/src/services/search-index.ts";

// 独立进程内本地 TestHarness、persist:false 和全零 D1 ID，不访问线上实例。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const origin = "https://search.example.test", owner = randomUUID(), credential = randomUUID();
const token = `cfk_v1_search_${"A".repeat(43)}`;
let db, worker, auth, workspace, project, other, first, second;
function url(path, values) {
  const result = new URL(`/api/v1/search-index/${path}`, origin);
  for (const [key, value] of Object.entries(values)) result.searchParams.set(key, value);
  return result;
}
async function request(path, method = "GET", value) {
  const response = await worker.fetch(new URL(path, origin).toString(), { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.resource ?? body;
}
async function status(context = auth, database = db) { return getSearchIndexStatus(database, context, url("status", { allow_unfiltered: "true" })); }
async function snapshot(cursor, context = auth, limit = 100, database = db) { return getSearchIndexSnapshot(database, context, url("snapshot", { project: project.id, cursor, limit })); }
async function changes(after, context = auth, limit = 100, database = db) { return getSearchIndexChanges(database, context, url("changes", { project: project.id, after, limit })); }
function head(value) { return value.projects.find(entry => entry.id === project.id); }
async function patch(issue, value) {
  const current = await request(`/api/v1/issues/${issue.identifier}`);
  return request(`/api/v1/issues/${issue.identifier}`, "PATCH", { expected_version: current.version, ...value });
}
function intercept(database, callback) {
  const queries = [];
  const wrap = (statement, sql) => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...values) => wrap(target.bind(...values), sql);
    if (key === "all") return async (...args) => { const result = await target.all(...args);
      queries.push({ sql, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written });
      await callback?.(sql); return result; };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { queries, db: new Proxy(database, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

before(async () => {
  await server.listen(); worker = server.getWorker(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: credential, ownerCredentialToken: token, ownerDisplayName: "SearchOwner", preferredApiOrigin: origin });
  auth = await authenticateBearer(db, `Bearer ${token}`);
  workspace = await request("/api/v1/workspaces", "POST", { display_name: "Search" });
  project = await request(`/api/v1/workspaces/${workspace.id}/projects`, "POST", { display_name: "Primary" });
  other = await request(`/api/v1/workspaces/${workspace.id}/projects`, "POST", { display_name: "Other" });
  first = await request(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, "POST", { title: "First title", body: "Never indexed" });
  second = await request(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, "POST", { title: "Second title" });
});
after(() => server.close());

test("public status/snapshot/changes are metadata-only, bounded and skip body/comment writes", async () => {
  const initial = await request(url("status", { project: project.id }).pathname + url("status", { project: project.id }).search);
  assert.equal(initial.projection_version, 1);
  assert.equal(initial.projects.length, 1);
  assert.equal(head(initial).revision, 2);
  const filtered = await getSearchIndexStatus(db, auth, url("status", { project: project.id, allow_unfiltered: "false" }));
  assert.equal(filtered.projects.length, 1);
  await assert.rejects(getSearchIndexStatus(db, auth, url("status", { allow_unfiltered: "false" })), error => error.code === "VALIDATION_ERROR" && error.details.reason === "explicit_search_scope_required");
  const start = head(initial).cursor;
  const page = await snapshot(start, auth, 1);
  assert.equal(page.has_more, true); assert.equal(page.items[0].id, first.id);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ["id", "identifier", "number", "project_id", "revision", "title"]);
  await patch(first, { body: "Changed body" });
  await request(`/api/v1/issues/${first.identifier}/comments`, "POST", { body: "A new comment" });
  await patch(first, { title: "First title" });
  assert.equal(head(await status()).revision, 2);
  const empty = await changes(start); assert.deepEqual(empty.items, []);
  assert.equal(empty.revision, 2);
  await patch(first, { title: "Updated once" }); await patch(first, { title: "Updated twice" });
  const delta = await changes(start); assert.equal(delta.items.length, 1);
  assert.equal(delta.items[0].title, "Updated twice"); assert.equal(delta.items[0].revision, 3);
  assert.equal(delta.revision, 4);
  assert.deepEqual((await changes(delta.next_cursor)).items, []);
  const last = await snapshot(page.next_cursor, auth, 1);
  assert.equal(last.has_more, false); assert.equal(last.items[0].id, second.id);
  assert.equal((await changes(last.next_cursor)).items[0].title, "Updated twice");
  const discovery = await worker.fetch(`${origin}/.well-known/cfkanban-instance.json`);
  assert.equal((await discovery.json()).capabilities.issue_search_index, true);
});

test("immutable-number snapshot catches racing rename/create/delete through delta without body data", async () => {
  const start = head(await status()).cursor;
  const page = await snapshot(start, auth, 1);
  await patch(second, { title: "Racing title" });
  const third = await request(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, "POST", { title: "Created after boundary" });
  const current = await request(`/api/v1/issues/${first.identifier}`);
  await request(`/api/v1/issues/${first.identifier}?expected_version=${current.version}`, "DELETE");
  const last = await snapshot(page.next_cursor, auth, 1);
  assert.equal(last.items[0].title, "Racing title"); assert.equal(last.items.some(item => item.id === third.id), false);
  const delta = await changes(last.next_cursor);
  assert.deepEqual(delta.items.map(item => [item.id, item.kind]), [[second.id, "upsert"], [third.id, "upsert"], [first.id, "remove"]]);
  assert.equal(delta.items.at(-1).title, "");
  const deleted = await db.prepare("SELECT version FROM issues WHERE id=?1").bind(first.id).first();
  await request(`/api/v1/issues/${first.identifier}/commands/restore`, "POST", { expected_version: deleted.version });
  const restored = await changes(delta.next_cursor);
  assert.equal(restored.items[0].kind, "upsert"); assert.equal(restored.items[0].revision, 5);
});

test("cursor binds current scope, Principal and instance; epoch/retention require explicit rebuild", async () => {
  const start = head(await status()).cursor;
  await db.prepare("UPDATE projects SET deleted_at=2,deleted_by_principal_id=?1 WHERE id=?2").bind(owner, other.id).run();
  assert.deepEqual((await changes(start)).items, [], "unrelated project permission changes preserve this project cursor");
  await db.prepare("UPDATE projects SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(other.id).run();
  const previousInstance = await db.prepare("SELECT instance_id FROM instance_meta").first();
  await db.prepare("UPDATE instance_meta SET instance_id=?1").bind(randomUUID()).run();
  await assert.rejects(changes(start), error => error.code === "CURSOR_SCOPE_MISMATCH");
  await db.prepare("UPDATE instance_meta SET instance_id=?1").bind(previousInstance.instance_id).run();
  const previousEpoch = await db.prepare("SELECT epoch FROM search_index_meta").first();
  await db.prepare("UPDATE search_index_meta SET epoch='reset'").run();
  await assert.rejects(changes(start), error => error.code === "SEARCH_INDEX_RESET");
  await db.prepare("UPDATE search_index_meta SET epoch=?1").bind(previousEpoch.epoch).run();
  const state = await db.prepare("SELECT revision FROM search_index_projects WHERE project_id=?1").bind(project.id).first();
  await db.prepare("UPDATE search_index_projects SET revision=revision+1,retained_after=revision+1 WHERE project_id=?1").bind(project.id).run();
  await assert.rejects(changes(start), error => error.code === "CURSOR_EXPIRED");
  await db.prepare("UPDATE search_index_projects SET revision=?1,retained_after=0 WHERE project_id=?2").bind(state.revision, project.id).run();
});

test("Issue Cookie Session cannot snapshot or synchronize another Issue", async () => {
  const now = Date.now(), secret = "S".repeat(43), session = randomUUID();
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES(?1,?2,?3,'credential',?4,'issue',?5,?6,?7)`).bind(session, createHash("sha256").update(secret).digest("hex"), owner, credential,
    JSON.stringify({ kind: "issue", identifier: first.identifier, issue_id: first.id, project_id: project.id,
      workspace_id: workspace.id, entry_path: `/app/issues/${first.identifier}` }), now + 60000, now).run();
  const cookie = await authenticateCookieSession(db, new Request(origin, { headers: { cookie: `cfkanban_session=${secret}` } }));
  const start = head(await status(cookie)).cursor;
  assert.deepEqual((await snapshot(start, cookie)).items.map(item => item.id), [first.id]);
  await patch(second, { title: "Invisible title change" }); await patch(first, { title: "Visible title change" });
  const delta = await changes(start, cookie);
  assert.deepEqual(delta.items.map(item => item.id), [first.id]);
  assert.equal(JSON.stringify(delta).includes("Invisible title change"), false);
  await assert.rejects(changes(start, auth), error => error.code === "CURSOR_SCOPE_MISMATCH");
});

test("read-time grant revocation rejects selected metadata and sparse delta has bounded local read evidence", async () => {
  const member = randomUUID(), memberCredential = randomUUID(), grant = randomUUID(), memberToken = `cfk_v1_searchreader_${"B".repeat(43)}`;
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'SearchReader','searchreader',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'searchreader',?3,1,?4)")
    .bind(memberCredential, member, createHash("sha256").update(memberToken).digest("hex"), randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)")
    .bind(grant, member, project.id, randomUUID()).run();
  const reader = await authenticateBearer(db, `Bearer ${memberToken}`), start = head(await status(reader)).cursor;
  let revoked = false;
  const race = intercept(db, async sql => {
    if (!revoked && sql.includes("FROM search_index_documents INDEXED BY") && sql.includes("ORDER BY number ASC")) {
      revoked = true; await db.prepare("UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2").bind(owner, grant).run();
    }
  });
  await assert.rejects(snapshot(start, reader, 100, race.db), error => error.code === "CURSOR_SCOPE_MISMATCH");
  const fresh = head(await status()).cursor;
  const noisy = [];
  for (let n = 0; n < 2000; n++) noisy.push(db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,authorized_via,project_id,subject_type,subject_id,payload_json,created_at)
    VALUES(?1,'domain','comment.created',?2,0,'deployment_owner',?3,'comment',?4,'{}',1)`).bind(randomUUID(), randomUUID(), project.id, randomUUID()));
  for (let n = 0; n < noisy.length; n += 80) await db.batch(noisy.slice(n, n + 80));
  const measured = intercept(db), empty = await changes(fresh, auth, 1, measured.db);
  assert.deepEqual(empty.items, []);
  const deltaQuery = measured.queries.find(query => query.sql.includes("FROM search_index_changes"));
  assert.ok(deltaQuery.rows_read <= 20, JSON.stringify(deltaQuery)); assert.equal(deltaQuery.rows_written, 0);
});

test("new project grants and workspace administrator inheritance expose historical snapshots without resetting other project cursors", async () => {
  const member = randomUUID(), memberCredential = randomUUID(), grant = randomUUID(), memberToken = `cfk_v1_searchnewscope_${"C".repeat(43)}`;
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'SearchNewScope','searchnewscope',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'searchnewscope',?3,1,?4)")
    .bind(memberCredential, member, createHash("sha256").update(memberToken).digest("hex"), randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)")
    .bind(grant, member, project.id, randomUUID()).run();
  const historical = await request(`/api/v1/workspaces/${workspace.id}/projects/${other.id}/issues`, "POST", { title: "Historical newly authorized Issue" });
  const reader = await authenticateBearer(db, `Bearer ${memberToken}`), initial = await status(reader), prior = head(initial).cursor;
  assert.equal(initial.projects.length, 1);
  const newGrant = randomUUID();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)")
    .bind(newGrant, member, other.id, randomUUID()).run();
  const expanded = await status(reader);
  assert.equal(expanded.projects.length, 2); assert.notEqual(expanded.scope_key, initial.scope_key);
  assert.deepEqual((await changes(prior, reader)).items, []);
  const newlyVisible = expanded.projects.find(entry => entry.id === other.id);
  const historicalPage = await getSearchIndexSnapshot(db, reader, url("snapshot", { project: other.id, cursor: newlyVisible.cursor }));
  assert.deepEqual(historicalPage.items.map(item => item.id), [historical.id]);
  await db.prepare("UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2").bind(owner, newGrant).run();
  await assert.rejects(getSearchIndexChanges(db, reader, url("changes", { project: other.id, after: newlyVisible.cursor })), error => error.code === "CURSOR_SCOPE_MISMATCH");
  const operation = randomUUID();
  await db.prepare(`INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,NULL,?4,1,1,?4)`).bind(randomUUID(), member, workspace.id, operation).run();
  const inherited = await status(reader);
  assert.equal(inherited.projects.length, 2); assert.deepEqual((await changes(prior, reader)).items, []);
  const inheritedHead = inherited.projects.find(entry => entry.id === other.id);
  assert.deepEqual((await getSearchIndexSnapshot(db, reader, url("snapshot", { project: other.id, cursor: inheritedHead.cursor }))).items.map(item => item.id), [historical.id]);
});

test("retention advanced during a delta read rejects an otherwise empty page", async () => {
  const start = head(await status()).cursor, previous = await db.prepare("SELECT revision,retained_after FROM search_index_projects WHERE project_id=?1").bind(project.id).first();
  let expired = false;
  const race = intercept(db, async sql => {
    if (!expired && sql.includes("FROM search_index_changes")) {
      expired = true;
      await db.prepare("UPDATE search_index_projects SET revision=revision+1,retained_after=revision+1 WHERE project_id=?1").bind(project.id).run();
    }
  });
  try { await assert.rejects(changes(start, auth, 100, race.db), error => error.code === "CURSOR_EXPIRED"); }
  finally { await db.prepare("UPDATE search_index_projects SET revision=?1,retained_after=?2 WHERE project_id=?3").bind(previous.revision, previous.retained_after, project.id).run(); }
});

test("physical Issue removal expires offline delta and snapshot cursors while a fresh snapshot can rebuild", async () => {
  const issue = await request(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, "POST", { title: "Cached before physical removal" });
  const oldHead = head(await status());
  const cached = await snapshot(oldHead.cursor);
  assert.equal(cached.items.some(item => item.id === issue.id), true);
  const current = await request(`/api/v1/issues/${issue.identifier}`);
  await request(`/api/v1/issues/${issue.identifier}?expected_version=${current.version}`, "DELETE");
  const deletedHead = head(await status());
  assert.equal(deletedHead.revision, oldHead.revision + 1);
  assert.equal((await changes(cached.next_cursor)).items.find(item => item.id === issue.id)?.kind, "remove");

  // 当前公共 purge API 只提供整项目删除；夹具沿用其派生清理顺序再验证 Issue 物理移除。
  await db.batch([
    ...["issue_trend_backfill", "issue_trend_states", "issue_trend_days", "issue_trend_totals", "issue_trend_projects"]
      .map(table => db.prepare(`DELETE FROM ${table} WHERE project_id=?1`).bind(project.id)),
    db.prepare("DELETE FROM issues WHERE id=?1").bind(issue.id),
  ]);
  assert.equal(await db.prepare("SELECT 1 FROM search_index_changes WHERE id=?1").bind(issue.id).first(), null);
  await assert.rejects(changes(cached.next_cursor), error => error.code === "CURSOR_EXPIRED");
  await assert.rejects(snapshot(cached.next_cursor), error => error.code === "CURSOR_EXPIRED");
  const freshHead = head(await status());
  assert.equal(freshHead.revision, deletedHead.revision);
  const rebuilt = await snapshot(freshHead.cursor);
  assert.equal(rebuilt.items.some(item => item.id === issue.id), false);
  assert.equal(rebuilt.has_more, false);
  assert.deepEqual((await changes(rebuilt.next_cursor)).items, []);
});

test("representative projection scale keeps deep snapshots and sparse single-Issue deltas on bounded indexes", async t => {
  // 查询成本夹具直接填充投影；业务触发器及原子操作已由前面的独立测试覆盖。
  await db.prepare(`WITH RECURSIVE scale(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM scale WHERE n<1500)
    INSERT INTO search_index_documents(id,project_id,number,title,is_removed,revision)
    SELECT 'scale-'||n,?1,50000+n,'Metadata only',n%2,0 FROM scale`).bind(project.id).run();
  let cursor = head(await status()).cursor;
  for (let n = 0; n < 5; n++) {
    const page = await snapshot(cursor); assert.equal(page.has_more, true); cursor = page.next_cursor;
  }
  const measured = intercept(db), deep = await snapshot(cursor, auth, 3, measured.db);
  assert.equal(deep.items.length, 3); assert.ok(deep.items[0].number > 50900);
  const snapshotQuery = measured.queries.find(query => query.sql.includes("ORDER BY number ASC"));
  assert.ok(snapshotQuery.rows_read <= 30, JSON.stringify(snapshotQuery)); assert.equal(snapshotQuery.rows_written, 0);
  const now = Date.now(), secret = "T".repeat(43);
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES(?1,?2,?3,'credential',?4,'issue',?5,?6,?7)`).bind(randomUUID(), createHash("sha256").update(secret).digest("hex"), owner, credential,
    JSON.stringify({ kind: "issue", identifier: first.identifier, issue_id: first.id, project_id: project.id,
      workspace_id: workspace.id, entry_path: `/app/issues/${first.identifier}` }), now + 60000, now).run();
  const cookie = await authenticateCookieSession(db, new Request(origin, { headers: { cookie: `cfkanban_session=${secret}` } }));
  const start = head(await status(cookie)).cursor;
  await db.prepare(`WITH RECURSIVE scale(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM scale WHERE n<2000)
    INSERT INTO search_index_changes(project_id,revision,project_revision,event_sequence,kind,id,number,title)
    SELECT ?1,n,(SELECT revision FROM search_index_projects WHERE project_id=?1)+n,100000+n,'upsert',?2,?3,'Other Issue title' FROM scale`)
    .bind(project.id, second.id, second.number).run();
  await db.prepare("UPDATE search_index_projects SET revision=revision+2000,event_sequence=102000 WHERE project_id=?1").bind(project.id).run();
  const sparse = intercept(db), delta = await changes(start, cookie, 3, sparse.db);
  assert.deepEqual(delta.items, []);
  const deltaQuery = sparse.queries.find(query => query.sql.includes("FROM search_index_changes"));
  assert.ok(deltaQuery.rows_read <= 20, JSON.stringify(deltaQuery)); assert.equal(deltaQuery.rows_written, 0);
  t.diagnostic(JSON.stringify({ isolated_local_d1: true, documents_seeded: 1500, skipped_snapshot_items: 500,
    snapshot_rows_read: snapshotQuery.rows_read, snapshot_rows_written: snapshotQuery.rows_written,
    snapshot_response_bytes: Buffer.byteLength(JSON.stringify(deep)), unrelated_changes_seeded: 2000,
    sparse_delta_rows_read: deltaQuery.rows_read, sparse_delta_rows_written: deltaQuery.rows_written,
    delta_response_bytes: Buffer.byteLength(JSON.stringify(delta)) }));
});
