import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { listIssues, listIssueCandidates } from "../../apps/worker/src/services/issues.ts";

// TestHarness 固定 127.0.0.1:0 和 persist:false；此配置使用全零本地 D1 ID。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const owner = randomUUID(), credential = randomUUID(), workspace = randomUUID();
const projects = Array.from({ length: 4 }, () => randomUUID());
const member = randomUUID(), departed = randomUUID();
const labels = Array.from({ length: 5 }, () => randomUUID());
const unknown = randomUUID();
const priorities = ["urgent", "high", "medium", "low", "none"];
const auth = { kind: "bearer", isOwner: true, principalId: owner, credentialId: credential, credentialFingerprint: "test", displayName: "FilterOwner", principalVersion: 1 };
let db;
const examples = [];

function url(params = {}, candidates = false) {
  const result = new URL(`https://kanban.example.test/api/v1/issues${candidates ? "/candidates" : ""}`);
  for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) result.searchParams.append(key, item);
  return result;
}
function measure(database) {
  const queries = [];
  function wrap(statement, sql, values = []) {
    return new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args) => wrap(target.bind(...args), sql, args);
      if (key === "all") return async (...args) => {
        const started = performance.now(), result = await target.all(...args);
        queries.push({ sql, values, rows_read: result.meta.rows_read, returned: result.results.length, duration_ms: performance.now() - started });
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
async function insertIssue(row) {
  const result = await db.prepare(`INSERT INTO issues(id,project_id,title,title_search,status_key,priority_key,priority_rank,assignee_principal_id,blocked_reason,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?14)`)
    .bind(row.id, row.project, row.title, row.status, row.priority, priorities.indexOf(row.priority), row.assignee, row.blocked ?? null, row.deleted ? 500 : null, row.deleted ? owner : null, row.created, row.updated, owner, randomUUID()).run();
  row.number = result.meta.last_row_id;
  for (const label of row.labels ?? []) await db.prepare("INSERT INTO issue_labels VALUES(?1,?2,1,?3,?4)").bind(row.id, label, owner, randomUUID()).run();
}
before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner, ownerCredentialId: credential,
    ownerCredentialToken: `cfk_v1_filters_${"A".repeat(43)}`, ownerDisplayName: "FilterOwner", preferredApiOrigin: "https://kanban.example.test" });
  for (const [id, name] of [[member, "FilterMember"], [departed, "FilterDeparted"]]) await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?3,1,1)").bind(id, name, name.toLowerCase()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Filters',1,1,?2,?2,?3)").bind(workspace, owner, randomUUID()).run();
  for (const project of projects) await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Filters',1,1,?3,?3,?4)").bind(project, workspace, owner, randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'writer',1,1,?4)").bind(randomUUID(), member, projects[0], randomUUID()).run();
  for (const [n, id] of labels.entries()) await db.prepare("INSERT INTO labels(id,project_id,name,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,?3,?4,?5,1,1,?6,?6,?7)")
    .bind(id, projects[n === 2 ? 1 : n >= 3 ? 2 : 0], `Label${n}`, n === 1 ? 2 : null, n === 1 ? owner : null, owner, randomUUID()).run();
  for (let n = 0; n < 36; n++) {
    const row = { id: randomUUID(), project: projects[n < 30 ? 0 : 1], title: `filter issue ${n}`, status: ["todo", "todo", "in_progress", "backlog", "canceled", "done"][n % 6], priority: priorities[n % 5], assignee: [null, member, owner, departed][n % 4], created: 1000 + Math.floor(n / 3), updated: 2000 + Math.floor(n / 3), labels: n < 30 ? [n % 2 === 0 ? labels[0] : labels[1]] : [labels[2]], deleted: n === 29, blocked: n === 12 ? "waiting" : null };
    await insertIssue(row); examples.push(row);
  }
});
after(() => server.close());

function expected({ project = [projects[0]], priority = [], label = [], assignee = [], status = [], deleted = false } = {}) {
  return examples.filter(row => project.includes(row.project) && !!row.deleted === deleted
    && (!priority.length || priority.includes(row.priority)) && (!status.length || status.includes(row.status))
    && (!assignee.length || assignee.includes(row.assignee ?? "unassigned"))
    && (!label.length || row.labels.some(id => label.includes(id) && id !== labels[1])))
    .sort((a, b) => b.updated - a.updated || b.number - a.number).map(row => row.number);
}
async function numbers(params, context = auth) { return (await listIssues(db, context, url({ project: projects[0], limit: 100, ...params }))).items.map(row => row.number); }

test("ordinary filters OR values within a dimension, AND dimensions, support unassigned and expose canonical scope", async () => {
  const filters = { project: [projects[0], projects[1]], priority: ["urgent", "medium"], label: [labels[0], labels[2]], status: ["todo", "in_progress"], assignee: ["unassigned", owner] };
  assert.deepEqual(await numbers(filters), expected(filters));
  assert.ok(expected(filters).length > 0);
  assert.deepEqual(await numbers({ assignee: "unassigned" }), expected({ assignee: ["unassigned"] }));
  assert.deepEqual(await numbers({ priority: ["high", "high", "urgent"] }), expected({ priority: ["high", "urgent"] }));
  const page = await listIssues(db, auth, url({ project: projects[0], priority: ["high", "urgent", "high"], label: [labels[0], labels[0]] }));
  assert.deepEqual(page.resolved_scope.filters.priorities, ["high", "urgent"]);
  assert.deepEqual(page.resolved_scope.filters.labels, [labels[0]]);
  const unfiltered = await listIssues(db, auth, url({ project: projects[0] }));
  assert.equal(Object.hasOwn(unfiltered.resolved_scope.filters, "priorities"), false);
  assert.equal(Object.hasOwn(unfiltered.resolved_scope.filters, "labels"), false);
});

test("unknown, deleted and out-of-scope labels give no matches and cannot widen a fixed Session", async () => {
  for (const label of [unknown, labels[1], labels[2]]) assert.deepEqual(await numbers({ label }), []);
  assert.deepEqual(await numbers({ label: [unknown, labels[0]] }), expected({ label: [labels[0]] }));
  // 即使 Principal 为 Owner，项目范围 Session 也不能借标签查询读取其他项目。
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at) VALUES(?1,?5,?2,'credential',?3,'project',?4,1,9999999999999)")
    .bind("filter-session", owner, credential, JSON.stringify({ kind: "project", entry_path: `/app/w/${workspace}/p/${projects[0]}`, workspace_id: workspace, project_id: projects[0] }), "b".repeat(64)).run();
  const session = { ...auth, kind: "cookie", sessionId: "filter-session", targetKind: "project", target: { workspace_id: workspace, project_id: projects[0] } };
  assert.deepEqual(await numbers({ project: [projects[0], projects[1]], label: labels[2] }, session), []);
  assert.deepEqual(await numbers({ deleted: "only", priority: examples[29].priority }), [examples[29].number]);
  assert.deepEqual(await numbers({ deleted: "only", label: labels[1] }), []);
});

test("new filter validation rejects invalid UUIDs/enums and caps raw repeated parameters", async () => {
  for (const candidates of [false, true]) {
    const service = candidates ? listIssueCandidates : listIssues;
    for (const params of [{ priority: "critical" }, { priority: Array(6).fill("high") }, { label: "not-a-uuid" }, { label: Array(21).fill(labels[0]) }]) {
      await assert.rejects(service(db, auth, url({ project: projects[0], ...(candidates ? { assignment: "unassigned" } : {}), ...params }, candidates)), error => error.code === "VALIDATION_ERROR");
    }
  }
  for (const value of ["me", "nobody", "", "' OR 1=1 --"]) await assert.rejects(listIssues(db, auth, url({ project: projects[0], assignee: value })), error => error.code === "VALIDATION_ERROR");
});

test("filter-bound keyset cursors keep ties, no duplicates and normalized repeated values", async () => {
  const params = { project: [projects[0], projects[1]], priority: ["urgent", "high", "medium"], label: [labels[0], labels[2]], limit: 2 };
  let cursor = null, seen = [], first;
  do {
    const page = await listIssues(db, auth, url({ ...params, ...(cursor ? { cursor } : {}) }));
    first ??= page; seen.push(...page.items.map(row => row.number)); cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, expected(params)); assert.equal(new Set(seen).size, seen.length); assert.ok(first.next_cursor);
  const reordered = await listIssues(db, auth, url({ ...params, priority: ["medium", "high", "urgent", "medium"], label: [labels[2], labels[0]], cursor: first.next_cursor }));
  assert.deepEqual(reordered.items.map(row => row.number), seen.slice(2,4));
  for (const change of [{ priority: "low" }, { label: labels[2] }, { assignee: "unassigned" }, { status: "todo" }]) await assert.rejects(listIssues(db, auth, url({ ...params, ...change, cursor: first.next_cursor })), error => error.code === "CURSOR_SCOPE_MISMATCH");
});

test("candidates retain explicit assignment and todo policy while applying label/priority before pagination", async () => {
  for (const assignment of ["unassigned", "mine", "needs_reassignment"]) {
    const matching = examples.filter(row => row.project === projects[0] && !row.deleted && row.status === "todo" && row.labels.includes(labels[0]) && ["urgent", "high", "medium"].includes(row.priority)
      && (assignment === "unassigned" ? row.assignee === null : assignment === "mine" ? row.assignee === owner : row.assignee === departed))
      .sort((a,b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority) || a.created - b.created || a.number - b.number);
    let cursor = null, seen = [];
    do {
      const page = await listIssueCandidates(db, auth, url({ project: projects[0], assignment, blocked: "include", priority: ["urgent", "high", "medium"], label: labels[0], limit: 1, ...(cursor ? { cursor } : {}) }, true));
      seen.push(...page.items.map(row => row.number)); cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, matching.map(row => row.number));
  }
  await assert.rejects(listIssueCandidates(db, auth, url({ project: projects[0], priority: "high" }, true)), error => error.code === "VALIDATION_ERROR");
});

test("candidate project/priority branches merge all assignment policies in stable keyset order", async () => {
  const chosen = ["urgent", "high", "medium", "none"];
  for (const assignment of ["unassigned", "mine", "needs_reassignment"]) {
    const matching = examples.filter(row => !row.deleted && row.status === "todo" && chosen.includes(row.priority)
      && (assignment === "unassigned" ? row.assignee === null : assignment === "mine" ? row.assignee === owner
        : row.assignee !== null && row.assignee !== owner && (row.assignee === departed || row.project !== projects[0])))
      .sort((a,b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority) || a.created - b.created || a.number - b.number);
    let cursor = null, seen = [];
    do {
      const page = await listIssueCandidates(db, auth, url({ project: [projects[0], projects[1]], assignment, blocked: "include", priority: chosen, limit: 2, ...(cursor ? { cursor } : {}) }, true));
      seen.push(...page.items.map(row => row.number)); cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, matching.map(row => row.number), assignment);
    assert.equal(new Set(seen).size, seen.length);
  }
});

async function growCostDataset(from, to) {
  await db.prepare(`WITH RECURSIVE sample(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM sample WHERE n+1<?2)
    INSERT INTO issues(id,project_id,title,title_search,status_key,priority_key,priority_rank,assignee_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    SELECT 'cost-'||n, CASE WHEN n%2=0 THEN ?3 ELSE ?4 END, 'cost issue '||n, 'cost issue '||n,
      CASE WHEN n%100=0 THEN 'in_progress' ELSE 'todo' END,
      CASE WHEN n%100=0 THEN 'urgent' WHEN n%4=0 THEN 'high' ELSE 'none' END,
      CASE WHEN n%100=0 THEN 0 WHEN n%4=0 THEN 1 ELSE 4 END,
      CASE WHEN n%100=0 THEN ?5 WHEN n%100=2 THEN ?6 ELSE NULL END, 10000+CAST(n/3 AS INTEGER),10000+CAST(n/3 AS INTEGER),?6,?6,'cost-operation-'||n FROM sample`)
    .bind(from,to,projects[2],projects[3],member,owner).run();
  await db.prepare(`INSERT INTO issue_labels(issue_id,label_id,added_at,added_by_principal_id,created_operation_id)
    SELECT id,CASE WHEN CAST(substr(id,6) AS INTEGER)%100=0 THEN ?3 ELSE ?4 END,1,?5,'cost-label-'||id
    FROM issues WHERE id LIKE 'cost-%' AND CAST(substr(id,6) AS INTEGER)>=?1 AND CAST(substr(id,6) AS INTEGER)<?2 AND CAST(substr(id,6) AS INTEGER)%4=0`)
    .bind(from,to,labels[3],labels[4],owner).run();
}

// 保留当前授权和结果投影，复现 schema 13 之前的分页查询形状。
// 新增 priority 只作为残余条件加入此对照，不声称旧 API 已支持优先级筛选。
// 固定旧查询使用的项目排序索引，使新增索引不影响对照计划。
async function legacyCost(query, page) {
  const bindings = query.values, projectIds = JSON.parse(bindings[0]);
  const sql = query.sql.slice(0, query.sql.indexOf("issue_page(number) AS MATERIALIZED (")) + `issue_page(number) AS MATERIALIZED (
    SELECT i.number FROM issues i INDEXED BY idx_issues_project_list
    WHERE i.project_id ${projectIds.length === 1 ? "= (SELECT id FROM current_result_projects)" : "IN (SELECT id FROM current_result_projects)"}
      AND i.deleted_at IS NULL
      ${bindings[5] === null ? "" : "AND i.status_key IN (SELECT value FROM json_each(?6))"}
      ${bindings[6] === null ? "" : "AND (i.assignee_principal_id IN (SELECT value FROM json_each(?7)) OR (i.assignee_principal_id IS NULL AND EXISTS (SELECT 1 FROM json_each(?7) WHERE value='unassigned')))"}
      ${JSON.parse(bindings[10]).length === 0 ? "" : "AND i.priority_key IN (SELECT value FROM json_each(?11))"}
      ${bindings[3] === null ? "" : "AND (i.updated_at,i.number)<(?4,?5)"}
    ORDER BY i.updated_at DESC,i.number DESC LIMIT ?8
  )` + query.sql.slice(query.sql.indexOf("SELECT i.id, i.number"));
  const started = performance.now();
  const previous = await db.prepare(sql).bind(...bindings).all();
  assert.deepEqual(previous.results.slice(0,10).map(row => row.number), page.items.map(row => row.number));
  return { rows_read: previous.meta.rows_read, duration_ms: +(performance.now() - started).toFixed(2) };
}

async function costQuery(name, params, budget) {
  const m = measure(db), started = performance.now();
  const page = await listIssues(m.db, auth, url({ project: projects[2], limit: 10, ...params }));
  const apiDuration = performance.now() - started;
  const query = m.queries.find(entry => entry.sql.includes("current_result_projects"));
  assert.ok(query, "measure the real service result SQL");
  assert.ok(query.rows_read <= budget, `${name}: read ${query.rows_read} > budget ${budget}`);
  const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all()).results.map(row => row.detail);
  const before = params.label ? null : await legacyCost(query, page);
  if (/sparse-(status|assignee|priority)/.test(name)) assert.ok(query.rows_read * 3 < before.rows_read, `${name} should materially reduce old page scans`);
  const evidence = { name, before, rows_read: query.rows_read, returned: page.items.length, duration_ms: +query.duration_ms.toFixed(2), api_duration_ms: +apiDuration.toFixed(2), plan };
  console.log(JSON.stringify({ cost: "CFK-497", ...evidence, plan: plan.filter(line => /issues|association|label|TEMP B-TREE/.test(line)) }));
  return { page, query, evidence };
}

test("selective indexed filters and keyset continuation stay bounded as the Issue population grows", async () => {
  await growCostDataset(0, 2400);
  const cases = [
    ["sparse-status", { status: "in_progress" }, 600],
    ["sparse-assignee", { assignee: member }, 600],
    ["sparse-priority", { priority: "urgent" }, 600],
    ["dense-priority", { priority: "high" }, 600],
    ["multiple-project-values", { project: [projects[2], projects[3]], status: ["todo", "in_progress"] }, 1500],
    ["combined", { status: "in_progress", assignee: member, priority: "urgent" }, 600],
    ["no-match", { assignee: departed }, 100],
    ["unassigned-urgent", { assignee: "unassigned", priority: "urgent" }, 300],
    ["unassigned-in-progress", { assignee: "unassigned", status: "in_progress" }, 300],
    ["sparse-label", { label: labels[3] }, 300],
    ["dense-label", { label: labels[4] }, 4000],
  ];
  const small = new Map();
  for (const [name, params, budget] of cases) small.set(name, await costQuery(`${name}-2400`, params, budget));
  await growCostDataset(2400, 12000);
  for (const [name, params, budget] of cases) {
    const large = await costQuery(`${name}-12000`, params, name === "sparse-label" ? 900 : name === "dense-label" ? 15000 : budget);
    if (!name.endsWith("label") && !name.startsWith("unassigned-")) assert.ok(large.query.rows_read <= small.get(name).query.rows_read + 100, `${name} grows with unrelated Issues`);
    if (large.page.next_cursor) {
      const next = await costQuery(`${name}-next`, { ...params, cursor: large.page.next_cursor }, name === "sparse-label" ? 900 : name === "dense-label" ? 15000 : budget);
      assert.equal(new Set([...large.page.items, ...next.page.items].map(row => row.number)).size, large.page.items.length + next.page.items.length);
    }
  }
});

test("candidate assignment/priority seeks bound sparse matches and subsequent pages", async () => {
  for (const [name, filters, expectedIndex] of [
    ["mine-none", { assignment: "mine", priority: "none" }, "idx_issues_todo_assignee_order"],
    ["unassigned-high", { assignment: "unassigned", priority: "high" }, "idx_issues_todo_assignee_order"],
    ["mine-absent-priority", { assignment: "mine", priority: "urgent" }, "idx_issues_todo_assignee_order"],
  ]) {
    let cursor = null, seen = [];
    for (let n = 0; n < 2; n++) {
      const m = measure(db);
      const page = await listIssueCandidates(m.db, auth, url({ project: projects[2], blocked: "include", limit: 10, ...filters, ...(cursor ? { cursor } : {}) }, true));
      const query = m.queries.find(entry => entry.sql.includes("current_result_projects"));
      assert.ok(query.rows_read < 400, `${name}: ${query.rows_read}`);
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all()).results.map(row => row.detail);
      assert.ok(plan.some(line => line.includes(expectedIndex)), plan.join("\n"));
      console.log(JSON.stringify({ cost: "CFK-497-candidates", name, page: n + 1, rows_read: query.rows_read, returned: page.items.length, duration_ms: +query.duration_ms.toFixed(2) }));
      seen.push(...page.items.map(row => row.number)); cursor = page.next_cursor;
      if (!cursor) break;
    }
    assert.equal(new Set(seen).size, seen.length);
  }
  const params = { project: projects[0], assignment: "unassigned", blocked: "include", label: labels[0], priority: ["urgent", "medium"], limit: 1 };
  const first = await listIssueCandidates(db, auth, url(params, true));
  assert.ok(first.next_cursor);
  for (const change of [{ priority: "urgent" }, { label: labels[1] }, { assignment: "mine" }]) await assert.rejects(listIssueCandidates(db, auth, url({ ...params, ...change, cursor: first.next_cursor }, true)), error => error.code === "CURSOR_SCOPE_MISMATCH");
});

test("four additive indexes have explicit local D1 insert, update and tombstone write costs", async () => {
  const indexes = (await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN ('idx_issues_active_status_order','idx_issues_active_assignee_order','idx_issues_active_priority_order','idx_issues_todo_assignee_order')").all()).results;
  assert.equal(indexes.length, 4);
  const writes = async () => {
    const id = randomUUID();
    const inserted = await db.prepare("INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'write cost','write cost','todo',1,1,?3,?3,?4)").bind(id,projects[3],owner,randomUUID()).run();
    const updated = await db.prepare("UPDATE issues SET priority_key='high',priority_rank=1,assignee_principal_id=?1,updated_at=2 WHERE id=?2").bind(member,id).run();
    const deleted = await db.prepare("UPDATE issues SET deleted_at=3,deleted_by_principal_id=?1 WHERE id=?2").bind(owner,id).run();
    return { insert: inserted.meta.rows_written, update: updated.meta.rows_written, soft_delete: deleted.meta.rows_written };
  };
  const after = await writes();
  try {
    for (const index of indexes) await db.prepare(`DROP INDEX ${index.name}`).run();
    const before = await writes();
    for (const field of ["insert", "update", "soft_delete"]) assert.ok(after[field] >= before[field], `${field} accounts for additional index writes`);
    console.log(JSON.stringify({ cost: "CFK-497-index-writes", added_indexes: indexes.length, before, after }));
  } finally { for (const index of indexes) await db.prepare(index.sql).run(); }
});
