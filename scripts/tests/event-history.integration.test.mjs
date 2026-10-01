import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { listEvents, listAuditEvents } from "../../apps/worker/src/services/events.ts";

// TestHarness 使用 127.0.0.1 随机端口及 persist:false，配置只有全零本地 D1 ID。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const owner = randomUUID(), credential = randomUUID(), member = randomUUID(), memberCredential = randomUUID();
const workspace = randomUUID(), projects = [randomUUID(), randomUUID()], grant = randomUUID();
const token = `cfk_v1_history_${"A".repeat(43)}`;
const auth = { kind: "bearer", isOwner: true, principalId: owner, credentialId: credential, credentialFingerprint: "test", displayName: "HistoryOwner", principalVersion: 1 };
const reader = { ...auth, isOwner: false, principalId: member, credentialId: memberCredential, displayName: "HistoryReader" };
const origin = "https://kanban.example.test";
let db;

function url(params = {}, audit = false) {
  const result = new URL(`${origin}/api/v1/${audit ? "admin/audit-events" : "events"}`);
  for (const [name, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) result.searchParams.append(name, item);
  return result;
}
async function rows() { return (await db.prepare("SELECT id,sequence,created_at,project_id,stream,relation_other_project_id FROM events").all()).results; }
function newest(items) { return [...items].sort((a, b) => b.created_at - a.created_at || b.sequence - a.sequence).map(row => row.id); }
async function walk(params = {}, audit = false, context = auth, database = db, first = null) {
  const request = url({ ...params, order: "desc", limit: 17 }, audit), items = [];
  let page = first;
  for (;;) {
    page ??= await (audit ? listAuditEvents : listEvents)(database, context, request);
    items.push(...page.items.map(row => row.id));
    if (!page.has_more) return items;
    request.searchParams.set("after", page.next_cursor);
    page = null;
  }
}
function eventStatement(project, stream, time, relation = false) {
  return db.prepare(`INSERT INTO events
    (id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,workspace_id,project_id,relation_other_project_id,subject_type,subject_id,payload_json,created_at)
    VALUES(?1,?2,'history.test',?3,0,?4,?5,'deployment_owner',?6,?7,?8,?9,?10,'{}',?11)`)
    .bind(randomUUID(), stream, randomUUID(), owner, credential, project === null ? null : workspace, project, relation ? projects[1] : null, relation ? "relation" : "project", project ?? owner, time);
}
async function seed(count, project, offset = 0, timeShift = 0) {
  for (let start = 0; start < count; start += 80) await db.batch(Array.from({ length: Math.min(80, count - start) }, (_, n) => {
    const index = start + n + offset;
    return eventStatement(project, index % 3 ? "domain" : "security", 1000 + timeShift + Math.floor((index * 17) % 260 / 10), project === projects[0] && index % 13 === 0);
  }));
}
function measure(database = db, hook = async () => {}) {
  const queries = [];
  function wrap(statement, sql, values = []) {
    return new Proxy(statement, { get(target, name) {
      if (name === "bind") return (...args) => wrap(target.bind(...args), sql, args);
      if (name === "all") return async (...args) => {
        await hook(sql, "before");
        const started = performance.now(), result = await target.all(...args);
        queries.push({ sql, values, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written, returned: result.results.length, duration_ms: performance.now() - started });
        await hook(sql, "after");
        return result;
      };
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  return { queries, db: new Proxy(database, { get(target, name) {
    if (name === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, name, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner, ownerCredentialId: credential, ownerCredentialToken: token, ownerDisplayName: "HistoryOwner", preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'HistoryReader','historyreader',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'test',?3,1,?4)").bind(memberCredential, member, "b".repeat(64), randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'History',1,1,?2,?2,?3)").bind(workspace, owner, randomUUID()).run();
  for (const project of projects) await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'History',1,1,?3,?3,?4)").bind(project, workspace, owner, randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)").bind(grant, member, projects[0], randomUUID()).run();
  await seed(260, projects[0]); await seed(1200, projects[1]);
  await db.batch(Array.from({ length: 80 }, (_, index) => eventStatement(null, "security", 1000 + index % 26)));
});
after(() => server.close());

test("历史活动按时间倒序及 sequence tie-breaker 跨多页归并，正序 feed 与旧 cursor 保持兼容", async () => {
  const all = await rows();
  assert.deepEqual(await walk(), newest(all.filter(row => row.stream === "domain")));
  assert.deepEqual(await walk({ project: projects[0] }), newest(all.filter(row => row.stream === "domain" && row.project_id === projects[0])));
  const asc = await listEvents(db, auth, url({ project: projects[0], limit: 17 }));
  assert.deepEqual(asc.items.map(row => row.id), all.filter(row => row.stream === "domain" && row.project_id === projects[0]).sort((a, b) => a.sequence - b.sequence).slice(0, 17).map(row => row.id));
  const oldPayload = JSON.parse(Buffer.from(asc.next_cursor, "base64url"));
  assert.equal(oldPayload.last.length, 1); assert.equal(typeof oldPayload.last[0], "string");
  const continuation = await listEvents(db, auth, url({ project: projects[0], after: asc.next_cursor, order: "asc", limit: 17 }));
  assert.deepEqual(continuation.items.map(row => row.id), all.filter(row => row.stream === "domain" && row.project_id === projects[0]).sort((a, b) => a.sequence - b.sequence).slice(17, 34).map(row => row.id));
  const auditAsc = await listAuditEvents(db, auth, url({ limit: 17 }, true));
  assert.deepEqual(JSON.parse(Buffer.from(auditAsc.next_cursor, "base64url")).last.length, 1);
  await listAuditEvents(db, auth, url({ after: auditAsc.next_cursor, order: "asc" }, true));
});

test("Owner 历史支持实例/项目/domain/security，各流按时间合并且保留空项目安全事件", async () => {
  const all = await rows();
  for (const params of [{}, { stream: "domain" }, { stream: "security" }, { project_id: projects[0] }, { project_id: projects[0], stream: "security" }, { project_id: projects[0], stream: "domain" }]) {
    const expected = all.filter(row => (!params.stream || row.stream === params.stream) && (!params.project_id || row.project_id === params.project_id));
    assert.deepEqual(await walk(params, true), newest(expected), JSON.stringify(params));
  }
  const filtered = await listAuditEvents(db, auth, url({ order: "desc", project_id: projects[0] }, true));
  assert.deepEqual(filtered.resolved_filters, { project_id: projects[0], streams: ["domain", "security"] });
});

test("历史页绑定首屏 sequence 上界，新增较新或回溯时间事件均等待刷新", async () => {
  for (const audit of [false, true]) {
    const params = audit ? { project_id: projects[0] } : { project: projects[0] };
    const all = await rows(), expected = newest(all.filter(row => row.project_id === projects[0] && (audit || row.stream === "domain")));
    const first = await (audit ? listAuditEvents : listEvents)(db, auth, url({ ...params, order: "desc", limit: 17 }, audit));
    await db.batch([eventStatement(projects[0], "domain", 9999), eventStatement(projects[0], "domain", 1)]);
    assert.deepEqual(await walk(params, audit, auth, db, first), expected);
    assert.equal((await walk(params, audit)).length, expected.length + 2);
  }
});

test("write event_cursor 继续默认增量消费，倒序拒绝直接复用 write cursor", async () => {
  async function create(title) {
    const response = await server.fetch(`/api/v1/workspaces/${workspace}/projects/${projects[0]}/issues`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ title }),
    });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  const first = await create("history cursor first"), second = await create("history cursor next");
  for (const params of [{ after: first.event_cursor }, { after: first.event_cursor, order: "asc" }]) {
    const result = await listEvents(db, auth, url(params));
    assert.deepEqual(result.items.map(event => event.subject.id), [second.resource.id]);
  }
  await assert.rejects(listEvents(db, auth, url({ order: "desc", after: first.event_cursor })), error => error.code === "CURSOR_SCOPE_MISMATCH");
});

test("排序/过滤/Principal/授权范围绑定 cursor，跨项目关系仅在两端可读时返回", async () => {
  const all = await rows();
  assert.deepEqual(await walk({ project: projects[0] }, false, reader), newest(all.filter(row => row.stream === "domain" && row.project_id === projects[0] && row.relation_other_project_id === null)));
  await assert.rejects(listAuditEvents(db, reader, url({ order: "desc" }, true)), error => error.status === 403);
  const domain = await listEvents(db, auth, url({ project: projects[0], order: "desc", limit: 1 }));
  for (const params of [{ project: projects[0] }, { project: projects[1], order: "desc" }]) await assert.rejects(listEvents(db, auth, url({ ...params, after: domain.next_cursor })), error => error.code === "CURSOR_SCOPE_MISMATCH");
  await assert.rejects(listEvents(db, reader, url({ project: projects[0], order: "desc", after: domain.next_cursor })), error => error.code === "CURSOR_SCOPE_MISMATCH");
  const multi = await listEvents(db, auth, url({ project: projects, order: "desc", limit: 1 }));
  await listEvents(db, auth, url({ project: [projects[1], projects[0], projects[1]], order: "desc", after: multi.next_cursor }));
  const audit = await listAuditEvents(db, auth, url({ order: "desc", project_id: projects[0], stream: "domain", limit: 1 }, true));
  for (const params of [{ project_id: projects[0], stream: "security", order: "desc" }, { project_id: projects[1], stream: "domain", order: "desc" }, { project_id: projects[0], stream: "domain" }]) await assert.rejects(listAuditEvents(db, auth, url({ ...params, after: audit.next_cursor }, true)), error => error.code === "CURSOR_SCOPE_MISMATCH");
  const readerPage = await listEvents(db, reader, url({ project: projects[0], order: "desc", limit: 1 }));
  await db.prepare("UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?2 WHERE id=?1").bind(grant, owner).run();
  try { await assert.rejects(listEvents(db, reader, url({ project: projects[0], order: "desc", after: readerPage.next_cursor })), error => error.code === "CURSOR_SCOPE_MISMATCH"); }
  finally { await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(grant).run(); }
  let changed = false;
  const raced = measure(db, async (sql, stage) => {
    if (!changed && stage === "after" && sql.includes("history_page")) {
      changed = true; await db.prepare("UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?2 WHERE id=?1").bind(grant, owner).run();
    }
  });
  try { await assert.rejects(listEvents(raced.db, reader, url({ project: projects[0], order: "desc" })), error => error.code === "CURSOR_SCOPE_MISMATCH"); }
  finally { await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(grant).run(); }

  const sessionId = randomUUID(), target = { kind: "project", entry_path: `/app/w/${workspace}/p/${projects[0]}`, workspace_id: workspace, project_id: projects[0] };
  const sessionCreatedAt = Date.now();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at) VALUES(?1,?2,?3,'credential',?4,'project',?5,?6,?7)").bind(sessionId, "c".repeat(64), owner, credential, JSON.stringify(target), sessionCreatedAt, sessionCreatedAt + 28_800_000).run();
  const fixed = { ...auth, kind: "cookie", sessionId, targetKind: "project", target };
  assert.deepEqual(await walk({}, false, fixed), newest(all.filter(row => row.stream === "domain" && row.project_id === projects[0] && row.relation_other_project_id === null)));
});

test("历史拒绝非法排序及 keyset，查询期间撤销 Credential 不返回已有投影", async () => {
  for (const audit of [false, true]) {
    for (const order of ["", "newest", ["desc", "desc"]]) await assert.rejects((audit ? listAuditEvents : listEvents)(db, auth, url({ order }, audit)), error => error.code === "VALIDATION_ERROR");
    const page = await (audit ? listAuditEvents : listEvents)(db, auth, url({ order: "desc", limit: 1 }, audit));
    const payload = JSON.parse(Buffer.from(page.next_cursor, "base64url"));
    for (const last of [[1], [null, 1, 5], [1, 6, 5], [1, 1, -1], [1.1, 1, 5]]) {
      const cursor = Buffer.from(JSON.stringify({ ...payload, last })).toString("base64url");
      await assert.rejects((audit ? listAuditEvents : listEvents)(db, auth, url({ order: "desc", after: cursor }, audit)), error => error.code === "INVALID_CURSOR");
    }
    let revoked = false;
    const measured = measure(db, async (sql, stage) => {
      if (!revoked && stage === "after" && sql.includes("history_page")) { revoked = true; await db.prepare("UPDATE credentials SET revoked_at=2 WHERE id=?1").bind(credential).run(); }
    });
    try { await assert.rejects((audit ? listAuditEvents : listEvents)(measured.db, auth, url({ order: "desc" }, audit)), error => error.status === 401); }
    finally { await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(credential).run(); }
  }
});

test("历史查询利用匹配时间索引，将深页范围扫描收敛到每项目/stream有界候选", async t => {
  const cases = [{}, { stream: "security" }, { project_id: projects[0] }, { project_id: projects[0], stream: "domain" }];
  for (const audit of [false, true]) for (const params of audit ? cases : [{ project: projects[0] }, { project: projects }]) {
    const request = url({ ...params, order: "desc", limit: 20 }, audit);
    let page;
    for (let index = 0; index < 4; index++) {
      page = await (audit ? listAuditEvents : listEvents)(db, auth, request);
      request.searchParams.set("after", page.next_cursor);
    }
    const measured = measure();
    await (audit ? listAuditEvents : listEvents)(measured.db, auth, request);
    const query = measured.queries.find(query => query.sql.includes("history_page"));
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
    const detail = plan.results.map(row => row.detail).join("\n");
    assert.match(detail, /idx_events_(project_stream_|stream_)?history/);
    assert.doesNotMatch(detail, /SCAN event\b/);
    const baselineSql = query.sql.replaceAll("idx_events_project_stream_history", "idx_events_project_stream_sequence").replaceAll("idx_events_stream_history", "idx_events_stream_sequence").replaceAll("INDEXED BY idx_events_history", "NOT INDEXED");
    const started = performance.now();
    const baseline = await db.prepare(baselineSql).bind(...query.values).all();
    const baselineDuration = performance.now() - started;
    assert.deepEqual(baseline.results, (await db.prepare(query.sql).bind(...query.values).all()).results);
    assert.ok(query.rows_read < baseline.meta.rows_read, `${audit}:${JSON.stringify(params)} ${query.rows_read} < ${baseline.meta.rows_read}`);
    t.diagnostic(JSON.stringify({ kind: audit ? "audit" : "domain", params, old_rows_read: baseline.meta.rows_read, rows_read: query.rows_read, returned: query.returned, duration_ms: query.duration_ms, old_duration_ms: baselineDuration, explain: detail }));
  }
});

test("时间索引读取成本不随无关或较早历史增长，实测 Event 写入多三个索引项", async t => {
  async function cost(params, audit = false) {
    const measured = measure(); await (audit ? listAuditEvents : listEvents)(measured.db, auth, url({ ...params, order: "desc", limit: 20 }, audit));
    const query = measured.queries.find(query => query.sql.includes("history_page"));
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
    t.diagnostic(JSON.stringify({ first_page: audit ? "audit" : "domain", params, rows_read: query.rows_read, explain: plan.results.map(row => row.detail).join("\n") }));
    return query.rows_read;
  }
  const beforeProject = await cost({ project: projects[0] });
  const beforeGlobal = await cost({}, true);
  const initialRows = (await rows()).length;
  await seed(1200, projects[1], 1200, -500);
  assert.equal(await cost({ project: projects[0] }), beforeProject);
  assert.equal(await cost({}, true), beforeGlobal);
  const indexed = await eventStatement(projects[0], "domain", 1).run();
  const definitions = [
    ["idx_events_history", "created_at DESC, sequence DESC"],
    ["idx_events_stream_history", "stream, created_at DESC, sequence DESC"],
    ["idx_events_project_stream_history", "project_id, stream, created_at DESC, sequence DESC"],
  ];
  let baseline;
  try {
    for (const [name] of definitions) await db.prepare(`DROP INDEX ${name}`).run();
    baseline = await eventStatement(projects[0], "domain", 1).run();
  } finally { for (const [name, columns] of definitions) await db.prepare(`CREATE INDEX IF NOT EXISTS ${name} ON events(${columns})`).run(); }
  assert.equal(indexed.meta.rows_written - baseline.meta.rows_written, 3);
  t.diagnostic(JSON.stringify({ initial_rows: initialRows, added_older_other_project_rows: 1200, project_rows_read: beforeProject, global_rows_read: beforeGlobal, old_event_rows_written: baseline.meta.rows_written, event_rows_written: indexed.meta.rows_written }));
});
