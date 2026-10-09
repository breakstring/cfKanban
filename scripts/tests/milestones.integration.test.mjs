import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { createMilestone, getMilestone, listMilestones, updateMilestone } from "../../apps/worker/src/services/milestones.ts";
import { countProjectIssues, createIssue, deleteIssue, getIssue, listIssueCandidates, listProjectIssues, restoreIssue, updateIssue } from "../../apps/worker/src/services/issues.ts";
import { completeIssue } from "../../apps/worker/src/services/comments.ts";
import { getPurgePreview, purgeContainer } from "../../apps/worker/src/services/container-purge.ts";

// 全零 D1 ID 的本地 wrangler harness；不读取线上凭据，也不连接线上数据库。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const origin = "https://milestones.example.test", owner = randomUUID(), credential = randomUUID();
const workspace = randomUUID(), project = randomUUID(), peer = randomUUID(), hidden = randomUUID();
const member = randomUUID(), memberCredential = randomUUID(), grant = randomUUID();
const ownerToken = `cfk_v1_milestone_${"A".repeat(43)}`;
const auth = { kind: "bearer", isOwner: true, principalId: owner, credentialId: credential,
  credentialFingerprint: "synthetic", displayName: "MilestoneOwner", principalVersion: 1 };
const reader = { ...auth, isOwner: false, principalId: member, credentialId: memberCredential };
const request = (key = randomUUID()) => new Request(`${origin}/api/v1/test`, {
  method: "POST", headers: { "idempotency-key": key, authorization: `Bearer ${ownerToken}` },
});
const url = (params = {}) => { const u = new URL(`${origin}/api/v1/issues`); for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value); return u; };
let db, now, primary;
const code = expected => error => error.code === expected;
const milestone = async (value = {}, projectId = project, currentAuth = auth) => (await createMilestone(db, request(), currentAuth, workspace, projectId, { title: "阶段交付", ...value }, now)).resource;
const issue = async (value = {}, projectId = project) => (await createIssue(db, request(), auth, workspace, projectId, { title: "里程碑事项", ...value }, now)).resource;
const progress = async id => (await getMilestone(db, auth, id, now)).progress;

before(async () => {
  await server.listen(); await server.getWorker().applyD1Migrations("DB"); ({ DB: db } = await server.getWorker().getEnv()); now = Date.now();
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: credential, ownerCredentialToken: ownerToken, ownerDisplayName: "MilestoneOwner", preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'MilestoneReader','milestonereader',?2,?2)").bind(member, now).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,?4,?5)").bind(memberCredential, member, "b".repeat(64), now, randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Milestone workspace',?2,?2,?3,?3,?4)").bind(workspace, now, owner, randomUUID()).run();
  for (const [index, id] of [project, peer, hidden].entries()) await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,?3,?4,?4,?5,?5,?6)").bind(id, workspace, `Milestone project ${index}`, now, owner, randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',?4,?4,?5)").bind(grant, member, project, now, randomUUID()).run();
  primary = await milestone();
});
after(async () => { await server.close(); });

test("empty milestones, optional Issue ownership, and HTTP projections", async () => {
  assert.deepEqual(primary.progress, { total: 0, done: 0, unfinished: 0, canceled: 0 });
  const plain = await issue(); assert.equal(plain.milestone, null);
  const owned = await issue({ milestone_id: primary.id, status_key: "todo" });
  assert.deepEqual(owned.milestone, { id: primary.id, title: primary.title, status_key: "open", due_date: null });
  const initial = await db.prepare("SELECT payload_json FROM events WHERE subject_id=?1 AND type='issue.created'").bind(owned.id).first();
  assert.equal(JSON.parse(initial.payload_json).milestone_id, primary.id); assert.equal(JSON.parse(initial.payload_json).status_key, "todo");
  const response = await server.fetch(`/api/v1/milestones/${primary.id}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.id, primary.id);
  const missingRoute = await server.fetch(`/api/v1/milestones/${primary.id}`, { method: "DELETE", headers: { authorization: `Bearer ${ownerToken}` } }); assert.ok([400, 404].includes(missingRoute.status)); assert.ok(await db.prepare("SELECT id FROM milestones WHERE id=?1").bind(primary.id).first());
});

test("create replay preserves result and records exactly one event", async () => {
  const key = randomUUID(), value = { title: "重放节点", due_date: "2028-02-29" };
  const a = await createMilestone(db, request(key), auth, workspace, project, value, now);
  const b = await createMilestone(db, request(key), auth, workspace, project, value, now);
  assert.equal(b.idempotent_replay, true); assert.deepEqual(a.resource, b.resource);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE subject_id=?1").bind(a.resource.id).first()).n, 1);
  await assert.rejects(createMilestone(db, request(key), auth, workspace, project, { title: "改变内容" }, now), code("IDEMPOTENCY_CONFLICT"));
});

test("metadata validation, UTF8 bounds, leap dates, CAS, and explicit status", async () => {
  for (const due_date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "0000-01-01", "not-a-date"]) await assert.rejects(milestone({ due_date }), code("VALIDATION_ERROR"));
  for (const value of [{ title: " " }, { title: "字".repeat(201) }, { description: "字".repeat(2731) }, { description: null }, { status_key: null }]) await assert.rejects(milestone(value), code("VALIDATION_ERROR"));
  const m = await milestone({ title: "字".repeat(200), description: "x".repeat(8192), due_date: "2028-02-29" });
  const closed = await updateMilestone(db, auth, m.id, { status_key: "closed", due_date: null }, m.version, now);
  assert.equal(closed.resource.status_key, "closed"); assert.equal(closed.resource.due_date, null);
  await assert.rejects(updateMilestone(db, auth, m.id, { title: "stale" }, m.version, now), code("VERSION_CONFLICT"));
  assert.equal((await updateMilestone(db, auth, m.id, { status_key: "open" }, closed.resource.version, now)).resource.status_key, "open");
});

test("reader, effective project administrator, hidden project and fixed Session scope", async () => {
  assert.deepEqual((await getMilestone(db, reader, primary.id, now)).allowed_actions, ["read"]);
  await assert.rejects(milestone({}, project, reader), code("FORBIDDEN"));
  await assert.rejects(updateMilestone(db, reader, primary.id, { title: "no" }, primary.version, now), code("FORBIDDEN"));
  const other = await milestone({}, hidden);
  await assert.rejects(getMilestone(db, reader, other.id, now), code("NOT_FOUND"));
  const sessionId = randomUUID();
  await db.prepare("INSERT INTO web_sessions(id,principal_id,token_digest,source_kind,source_id,target_kind,target_json,created_at,expires_at,last_seen_at) VALUES(?1,?2,?3,'credential',?4,'project',?5,?6,?7,?6)").bind(sessionId, owner, "c".repeat(64), credential, JSON.stringify({ kind: "project", entry_path: `/app/w/${workspace}/p/${project}`, workspace_id: workspace, project_id: project }), now, now + 86400000).run();
  const scoped = { kind: "cookie", isOwner: true, principalId: owner, sessionId, sourceKind: "credential", sourceId: credential,
    targetKind: "project", target: { workspace_id: workspace, project_id: project }, displayName: auth.displayName, principalVersion: 1 };
  await assert.rejects(getMilestone(db, scoped, other.id, now), code("NOT_FOUND"));
  await assert.rejects(createMilestone(db, request(), scoped, workspace, hidden, { title: "no" }, now), code("NOT_FOUND"));
  await db.prepare("INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,created_at,updated_at,generation,created_operation_id) VALUES(?1,?2,?3,?4,?5,?5,?6,?7)").bind(randomUUID(), member, workspace, project, now, randomUUID(), randomUUID()).run();
  assert.ok((await milestone({ title: "管理员节点" }, project, reader)).allowed_actions.includes("update"));
});

function revokeBeforeRead(credentialId) {
  let revoked = false;
  const wrap = (statement, sql) => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...values) => wrap(target.bind(...values), sql);
    if (key === "first" || key === "all") return async (...args) => {
      if (!revoked && sql.includes("milestone.current_total") && sql.includes("auth_credential")) {
        revoked = true; await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(now, credentialId).run();
      }
      return target[key](...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return new Proxy(db, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("detail and list recheck current credential inside the final data query", async () => {
  for (const [index, read] of [
    observed => getMilestone(observed.db, observed.auth, primary.id, now),
    observed => listMilestones(observed.db, observed.auth, workspace, project, url(), now),
  ].entries()) {
    const credentialId = randomUUID();
    await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'revocation',?3,?4,?5)")
      .bind(credentialId, owner, String(index + 5).repeat(64), now, randomUUID()).run();
    await assert.rejects(read({ db: revokeBeforeRead(credentialId), auth: { ...auth, credentialId } }), code("UNAUTHORIZED"));
  }
});

test("Issue can move between nodes and leave, cross-project references rejected", async () => {
  const m = await milestone(), next = await milestone({ status_key: "closed" }), foreign = await milestone({}, peer);
  let i = await issue({ milestone_id: m.id });
  await assert.rejects(updateIssue(db, auth, i.identifier, { milestone_id: foreign.id }, i.version, now), code("NOT_FOUND"));
  await assert.rejects(issue({ milestone_id: foreign.id }), code("NOT_FOUND"));
  i = (await updateIssue(db, auth, i.identifier, { milestone_id: next.id }, i.version, now)).resource;
  assert.equal(i.milestone.id, next.id); assert.equal(i.milestone.status_key, "closed");
  const payload = JSON.parse((await db.prepare("SELECT payload_json FROM events WHERE subject_id=?1 AND type='issue.updated' ORDER BY sequence DESC LIMIT 1").bind(i.id).first()).payload_json);
  assert.equal(payload.old_milestone_id, m.id); assert.equal(payload.new_milestone_id, next.id);
  i = (await updateIssue(db, auth, i.identifier, { title: "只修改标题" }, i.version, now)).resource;
  assert.equal(i.milestone.id, next.id);
  await updateIssue(db, auth, i.identifier, { milestone_id: null }, i.version, now);
  assert.equal((await getIssue(db, auth, i.identifier, url())).milestone, null);
  assert.deepEqual(await progress(next.id), { total: 0, done: 0, unfinished: 0, canceled: 0 });
});

test("progress distinguishes canceled, completion, reopen, deletion, and restore", async () => {
  const m = await milestone(); let a = await issue({ milestone_id: m.id }), b = await issue({ milestone_id: m.id, status_key: "canceled" });
  assert.deepEqual(await progress(m.id), { total: 2, done: 0, unfinished: 1, canceled: 1 });
  a = (await completeIssue(db, request(), auth, a.identifier, a.version, { summary: "已完成", verification: [], artifacts: [], follow_ups: [] }, now)).resource;
  assert.deepEqual(await progress(m.id), { total: 2, done: 1, unfinished: 0, canceled: 1 });
  assert.equal((await getMilestone(db, auth, m.id, now)).status_key, "open");
  a = (await updateIssue(db, auth, a.identifier, { status_key: "todo" }, a.version, now)).resource;
  assert.deepEqual(await progress(m.id), { total: 2, done: 0, unfinished: 1, canceled: 1 });
  b = (await deleteIssue(db, auth, b.identifier, b.version, now)).resource;
  assert.deepEqual(await progress(m.id), { total: 1, done: 0, unfinished: 1, canceled: 0 });
  await restoreIssue(db, request(), auth, b.identifier, b.version, now);
  assert.deepEqual(await progress(m.id), { total: 2, done: 0, unfinished: 1, canceled: 1 });
  assert.equal((await getMilestone(db, auth, m.id, now)).version, m.version);
});

test("parent relation does not inherit milestone and both explicitly assigned Issues count", async () => {
  const m = await milestone(), parent = await issue({ milestone_id: m.id }), child = await issue();
  await db.prepare("INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id) VALUES(?1,?2,'parent',?3,?4,?5,?5,?6,?7,?8)").bind(randomUUID(), workspace, child.id, parent.id, project, now, owner, randomUUID()).run();
  assert.equal((await getIssue(db, auth, child.identifier, url())).milestone, null);
  assert.equal((await progress(m.id)).total, 1);
  await updateIssue(db, auth, child.identifier, { milestone_id: m.id }, child.version, now);
  assert.equal((await progress(m.id)).total, 2);
});

test("list, counts, candidates apply optional milestone filter before pagination", async () => {
  const m = await milestone(); await issue({ milestone_id: m.id, status_key: "todo" }); await issue({ milestone_id: m.id, status_key: "canceled" });
  const selected = await listProjectIssues(db, auth, workspace, project, url({ milestone: m.id, limit: "1" }), now);
  assert.equal(selected.items.length, 1); assert.equal(selected.has_more, true); assert.equal(selected.items[0].milestone.id, m.id);
  const page2 = await listProjectIssues(db, auth, workspace, project, url({ milestone: m.id, limit: "1", cursor: selected.next_cursor }), now);
  assert.equal(page2.items.length, 1); assert.equal(page2.has_more, false);
  await assert.rejects(listProjectIssues(db, auth, workspace, project, url({ milestone: "none", cursor: selected.next_cursor }), now), code("CURSOR_SCOPE_MISMATCH"));
  const noNode = await listProjectIssues(db, auth, workspace, project, url({ milestone: "none" }), now); assert.ok(noNode.items.every(i => i.milestone === null));
  const counts = await countProjectIssues(db, auth, workspace, project, url({ milestone: m.id }), now);
  assert.equal(counts.total_count, 2);
  const candidates = await listIssueCandidates(db, auth, url({ project, milestone: m.id, assignment: "unassigned" }), now);
  assert.equal(candidates.items.length, 1); assert.equal(candidates.items[0].milestone.id, m.id);
  const malformed = url(); malformed.searchParams.append("milestone", m.id); malformed.searchParams.append("milestone", "none");
  await assert.rejects(listProjectIssues(db, auth, workspace, project, malformed, now), code("VALIDATION_ERROR"));
});

test("milestone pagination, status filters, and cursor binding", async () => {
  await milestone({ status_key: "closed" }); await milestone({ status_key: "closed" });
  const a = await listMilestones(db, auth, workspace, project, url({ status: "closed", limit: "1" }), now);
  assert.equal(a.items.length, 1); assert.equal(a.has_more, true); assert.equal(a.items[0].status_key, "closed");
  const b = await listMilestones(db, auth, workspace, project, url({ status: "closed", limit: "1", cursor: a.next_cursor }), now);
  assert.notEqual(b.items[0].id, a.items[0].id);
  await assert.rejects(listMilestones(db, auth, workspace, project, url({ status: "open", cursor: a.next_cursor }), now), code("CURSOR_SCOPE_MISMATCH"));
});

function instrument() {
  const queries = [], statementSql = new WeakMap();
  const wrap = (statement, sql) => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values) => wrap(target.bind(...values), sql);
      if (key === "all" || key === "run") return async (...args) => {
        const result = await target[key](...args); queries.push({ sql, ...result.meta }); return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    statementSql.set(proxy, sql); return proxy;
  };
  return { queries, db: new Proxy(db, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    if (key === "batch") return async statements => {
      const results = await target.batch(statements);
      results.forEach((result, index) => queries.push({ sql: statementSql.get(statements[index]) ?? "", ...result.meta }));
      return results;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

test("sparse milestone list and candidates are bounded among 5000 unrelated Issues, with no title-write counter overhead", async t => {
  const m = await milestone({ title: "稀疏成本节点" });
  const selected = await issue({ milestone_id: m.id, status_key: "todo" }), plain = await issue({ status_key: "todo" });
  await db.prepare(`WITH RECURSIVE seed(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seed WHERE n < 5000)
    INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    SELECT 'milestone-cost-' || n,?1,'Unrelated ' || n,'unrelated ' || n,'todo',?2,?2,?3,?3,'milestone-cost-operation-' || n FROM seed`)
    .bind(project, now, owner).run();
  const measure = async read => { const observed = instrument(); await read(observed.db);
    const rows = observed.queries.reduce((sum, q) => sum + (q.rows_read ?? 0), 0); assert.ok(rows < 300, `bounded rows_read: ${rows}`); return rows; };
  const listRows = await measure(observed => listProjectIssues(observed, auth, workspace, project, url({ milestone: m.id }), now));
  const candidatesRows = await measure(observed => listIssueCandidates(observed, auth, url({ project, milestone: m.id, assignment: "unassigned" }), now));
  const emptyRows = await measure(observed => listProjectIssues(observed, auth, workspace, project, url({ milestone: randomUUID() }), now));
  const milestonesRows = await measure(observed => listMilestones(observed, auth, workspace, project, url(), now));
  const observed = instrument();
  await updateIssue(observed.db, auth, selected.identifier, { title: "Only title" }, selected.version, now);
  await updateIssue(observed.db, auth, plain.identifier, { title: "Only title" }, plain.version, now);
  const businessUpdates = observed.queries.filter(q => q.sql.trim().startsWith("UPDATE issues SET"));
  assert.equal(businessUpdates.length, 2); assert.equal(businessUpdates[0].rows_written, businessUpdates[1].rows_written);
  const unassignedWrite = await db.prepare("UPDATE issues SET milestone_id=NULL WHERE id=?1").bind(plain.id).run();
  const assignedWrite = await db.prepare("UPDATE issues SET milestone_id=?1 WHERE id=?2").bind(m.id, plain.id).run();
  assert.ok(assignedWrite.meta.rows_written > unassignedWrite.meta.rows_written);
  t.diagnostic(JSON.stringify({ scale: 5000, list_rows_read: listRows, candidate_rows_read: candidatesRows,
    empty_rows_read: emptyRows, milestones_rows_read: milestonesRows, title_rows_written: businessUpdates[0].rows_written,
    unchanged_membership_rows_written: unassignedWrite.meta.rows_written, changed_membership_rows_written: assignedWrite.meta.rows_written }));
});

test("project purge clears nodes, counts, history and idempotency snapshots", async () => {
  const m = await milestone({ title: "PURGE_PRIVATE_MILESTONE" }, peer); await issue({ milestone_id: m.id }, peer);
  const operation = await db.prepare("SELECT created_operation_id FROM milestones WHERE id=?1").bind(m.id).first();
  await db.prepare("UPDATE projects SET deleted_at=?1,deleted_by_principal_id=?2,version=version+1 WHERE id=?3").bind(now, owner, peer).run();
  const preview = await getPurgePreview(db, auth, workspace, peer, now); assert.equal(preview.counts.milestones, 2);
  const result = await purgeContainer(db, request(), auth, workspace, peer, preview.target.version, preview.target.display_name, preview.preview_digest, now);
  assert.equal(result.resource.purged, true);
  for (const sql of ["SELECT id FROM milestones WHERE project_id=?1", "SELECT id FROM issues WHERE project_id=?1", "SELECT id FROM events WHERE project_id=?1"]) assert.equal(await db.prepare(sql).bind(peer).first(), null);
  assert.equal(await db.prepare("SELECT operation_id FROM idempotency_records WHERE operation_id=?1").bind(operation.created_operation_id).first(), null);
  assert.equal(await db.prepare("SELECT operation_id FROM operation_commits WHERE operation_id=?1").bind(operation.created_operation_id).first(), null);
});
