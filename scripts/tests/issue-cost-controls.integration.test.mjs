import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

// TestHarness 固定 127.0.0.1:0、persist:false；仅全零本地 D1 ID 和合成身份。
const config = JSON.parse(await readFile(new URL("../../wrangler.wp02-test.jsonc", import.meta.url), "utf8"));
assert.equal(config.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000000");
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const origin = "https://isolated.fixture.invalid";
const owner = randomUUID(), credential = randomUUID(), workspace = randomUUID(), reader = randomUUID(), readerCredential = randomUUID();
const ownerToken = `cfk_v1_costowner_${"A".repeat(43)}`, readerToken = `cfk_v1_costreader_${"B".repeat(43)}`;
const projects = [1000, 10000, 50000].map(size => ({ id: randomUUID(), size }));
const evidence = [];
let db, env;

function instrument(database, { legacyCounts = false } = {}) {
  const queries = [], originals = new WeakMap();
  const record = (method, sql, result) => {
    assert.ok(Number.isSafeInteger(result.meta.rows_read));
    assert.ok(Number.isSafeInteger(result.meta.rows_written));
    queries.push({ method, sql, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written, returned: result.results?.length ?? 0 });
  };
  function wrap(statement, sql) {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values) => wrap(target.bind(...values), sql);
      if (key === "first") return async column => {
        const result = await target.all(); record("first", sql, result);
        return result.results.length === 0 ? null : column === undefined ? result.results[0] : result.results[0][column];
      };
      if (key === "all" || key === "run") return async (...args) => { const result = await target[key](...args); record(key, sql, result); return result; };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, { statement, sql });
    return proxy;
  }
  const measured = new Proxy(database, { get(target, key) {
    if (key === "prepare") return original => {
      // 仅测量对照替换驱动，过滤、认证、scope 与结果投影沿完全相同的实际请求。
      const sql = legacyCounts && original.includes("GROUP BY i.status_key") ? original
        .replace("CROSS JOIN json_each(?7) selected_assignee", "")
        .replace("INDEXED BY idx_issues_active_assignee_order", "INDEXED BY idx_issues_active_status_order")
        .replace("AND i.assignee_principal_id IS NULLIF(selected_assignee.value, 'unassigned')", "") : original;
      return wrap(target.prepare(sql), sql);
    };
    if (key === "batch") return async statements => {
      const entries = statements.map(statement => originals.get(statement));
      assert.ok(entries.every(Boolean), "batch must not bypass instrumentation");
      const results = await target.batch(entries.map(entry => entry.statement));
      results.forEach((result, index) => record("batch", entries[index].sql, result));
      return results;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db: measured, queries, totals: () => ({ rows_read: queries.reduce((sum, query) => sum + query.rows_read, 0), rows_written: queries.reduce((sum, query) => sum + query.rows_written, 0), statements: queries.length }) };
}

function apiPath(project, counts, parameters = {}) {
  const url = new URL(`/api/v1/workspaces/${workspace}/projects/${project}/issues${counts ? "/counts" : ""}`, origin);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  return url.pathname + url.search;
}

async function request(path, { token = ownerToken, legacyCounts = false, override = {} } = {}) {
  const measured = instrument(db, { legacyCounts });
  const response = await fetchWorker(new Request(origin + path, { headers: token === null ? {} : { authorization: `Bearer ${token}` } }), { ...env, ...override, DB: measured.db });
  const body = await response.json();
  return { status: response.status, headers: response.headers, body, queries: measured.queries, ...measured.totals() };
}

before(async () => {
  await server.listen(); await server.getWorker().applyD1Migrations("DB");
  env = await server.getWorker().getEnv(); db = env.DB;
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner, ownerCredentialId: credential, ownerCredentialToken: ownerToken, ownerDisplayName: "CostOwner", preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'CostReader','costreader',1,1)").bind(reader).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'costreader',?3,1,?4)").bind(readerCredential, reader, createHash("sha256").update(readerToken).digest("hex"), randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Costs',1,1,?2,?2,?3)").bind(workspace, owner, randomUUID()).run();
  let offset = 0;
  for (const project of projects) {
    await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,?3,1,1,?4,?4,?5)").bind(project.id, workspace, `Cost ${project.size}`, owner, randomUUID()).run();
    for (let start = 1; start <= project.size; start += 1000) {
      await db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM sequence WHERE n<?2)
        INSERT INTO issues(number,id,project_id,title,title_search,status_key,priority_key,priority_rank,assignee_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
        SELECT ?3+n,printf('10000000-0000-4000-8000-%012d',?3+n),?4,
          CASE WHEN n%100=0 THEN 'needle sparse' ELSE 'ordinary title' END,
          CASE WHEN n%100=0 THEN 'needle sparse' ELSE 'ordinary title' END,
          CASE WHEN n%2=0 THEN 'todo' ELSE 'backlog' END,
          CASE WHEN n%4=0 THEN 'high' ELSE 'none' END,CASE WHEN n%4=0 THEN 1 ELSE 4 END,
          CASE WHEN n%100=0 THEN NULL ELSE ?5 END,n,n,?5,?5,printf('20000000-0000-4000-8000-%012d',?3+n)
        FROM sequence`).bind(start, Math.min(start + 999, project.size), offset, project.id, owner).run();
    }
    offset += project.size;
  }
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)").bind(randomUUID(), reader, projects[0].id, randomUUID()).run();
});
after(async () => {
  await server.close();
});

test("1k/10k/50k complete count requests prove sparse unassigned seeking and report unoptimized title scans", async t => {
  for (const project of projects) {
    for (const [scenario, parameters, expected] of [
      ["unassigned", { assignee: "unassigned" }, project.size / 100],
      ["unassigned-empty-title", { assignee: "unassigned", q: "no such title", q_mode: "typed" }, 0],
      ["empty-title", { q: "no such title", q_mode: "typed" }, 0],
      ["combined-priority", { assignee: "unassigned", priority: "high", q: "needle", q_mode: "typed" }, project.size / 100],
    ]) {
      const path = apiPath(project.id, true, parameters);
      const current = await request(path), baseline = await request(path, { legacyCounts: true });
      assert.equal(current.status, 200, JSON.stringify(current.body)); assert.equal(baseline.status, 200, JSON.stringify(baseline.body));
      assert.deepEqual(current.body, baseline.body); assert.equal(current.body.total_count, expected);
      assert.equal(current.rows_written, 0); assert.equal(baseline.rows_written, 0);
      assert.ok(current.queries.some(query => query.method === "first"), "authentication and scope first() reads must be included");
      if (scenario.startsWith("unassigned")) assert.ok(current.rows_read * 5 < baseline.rows_read, `${scenario}: ${current.rows_read} versus ${baseline.rows_read}`);
      const record = { size: project.size, scenario, rows_read: current.rows_read, baseline_rows_read: baseline.rows_read, rows_written: current.rows_written, statements: current.statements };
      evidence.push(record); t.diagnostic(JSON.stringify(record));
    }
  }
});

test("full list requests keep deep pagination bounded and empty typed-number seeks avoid title admission", async t => {
  for (const project of projects) {
    let cursor, first, last;
    for (let page = 0; page < 30; page++) {
      last = await request(apiPath(project.id, false, { limit: 20, ...(cursor ? { cursor } : {}) }));
      assert.equal(last.status, 200, JSON.stringify(last.body)); assert.equal(last.body.items.length, 20); assert.equal(last.rows_written, 0);
      first ??= last; cursor = last.body.next_cursor;
    }
    assert.ok(last.rows_read <= first.rows_read * 2, `deep read increased from ${first.rows_read} to ${last.rows_read}`);
    const empty = await request(apiPath(project.id, false, { limit: 20, q: "99999999", q_mode: "typed" }));
    assert.equal(empty.status, 200); assert.equal(empty.body.items.length, 0); assert.equal(empty.rows_written, 0);
    assert.ok(empty.rows_read < 300);
    const record = { size: project.size, scenario: "list-pagination", first_rows_read: first.rows_read, page_30_rows_read: last.rows_read, empty_typed_number_rows_read: empty.rows_read };
    evidence.push(record); t.diagnostic(JSON.stringify(record));
  }
});

test("HTTP expensive binding denies before aggregate work and preserves cheap typed-number routes", async t => {
  let limiterCalls = 0;
  const override = { RATE_LIMIT_EXPENSIVE_READ_LIMIT: "10", RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS: "60", EXPENSIVE_READ_RATE_LIMITER: { limit: async ({ key }) => { assert.equal(key, owner); limiterCalls++; return { success: false }; } } };
  for (const path of [apiPath(projects[2].id, true), apiPath(projects[2].id, false, { q: "ordinary", q_mode: "typed" }), `/api/v1/issues?project=${projects[2].id}&q=ordinary&q_mode=typed`, `/api/v1/issues/candidates?project=${projects[2].id}&q=ordinary&q_mode=typed`]) {
    const denied = await request(path, { override });
    assert.equal(denied.status, 429); assert.equal(denied.headers.get("retry-after"), "60"); assert.equal(denied.body.details.policy, "expensive_read");
    assert.equal(denied.rows_written, 0); assert.ok(denied.queries.every(query => !query.sql.includes("GROUP BY i.status_key") && !query.sql.includes("issue_page(number)")));
    evidence.push({ scenario: "http-rate-denied", rows_read: denied.rows_read, rows_written: denied.rows_written, statements: denied.statements });
  }
  assert.equal(limiterCalls, 4);
  for (const path of [apiPath(projects[2].id, false, { q: "99999999", q_mode: "typed" }), apiPath(projects[2].id, false, { limit: 20 })]) assert.equal((await request(path, { override })).status, 200);
  assert.equal(limiterCalls, 4);
  t.diagnostic(JSON.stringify(evidence.filter(item => item.scenario === "http-rate-denied")));
});

test("complete HTTP metrics include current authentication, grants and permission refusals", async t => {
  const allowed = await request(apiPath(projects[0].id, true, { assignee: "unassigned" }), { token: readerToken });
  assert.equal(allowed.status, 200); assert.equal(allowed.body.total_count, 10); assert.equal(allowed.rows_written, 0);
  const forbidden = await request(apiPath(projects[2].id, true), { token: readerToken });
  assert.equal(forbidden.status, 404); assert.equal(forbidden.rows_written, 0); assert.ok(forbidden.queries.every(query => !query.sql.includes("GROUP BY i.status_key")));
  const unauthenticated = await request(apiPath(projects[2].id, true), { token: null });
  assert.equal(unauthenticated.status, 401); assert.equal(unauthenticated.rows_written, 0);
  await db.prepare("UPDATE credentials SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2").bind(owner, readerCredential).run();
  const revoked = await request(apiPath(projects[0].id, true), { token: readerToken });
  assert.equal(revoked.status, 401); assert.equal(revoked.rows_written, 0);
  for (const [scenario, measured] of [["reader-allowed", allowed], ["permission-denied", forbidden], ["unauthenticated", unauthenticated], ["credential-revoked", revoked]]) {
    const record = { scenario, rows_read: measured.rows_read, rows_written: measured.rows_written, statements: measured.statements };
    evidence.push(record); t.diagnostic(JSON.stringify(record));
  }
});
