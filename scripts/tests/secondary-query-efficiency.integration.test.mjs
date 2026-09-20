import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { listInvitations } from "../../apps/worker/src/services/invitations.ts";
import { collectAttachmentGarbage } from "../../apps/worker/src/services/attachments.ts";
import { listComments } from "../../apps/worker/src/services/comments.ts";

const server = createTestHarness({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  workers: [{ configPath: "wrangler.attachments-test.jsonc" }],
});
const worker = server.getWorker();
const ownerId = randomUUID(), credentialId = randomUUID();
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
let db, env, auth, issue;

async function create(path, body) {
  const response = await worker.fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.resource;
}

function observeDatabase(afterQuery = async () => {}) {
  const queries = [];
  function wrap(statement, sql, values = []) {
    return new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...bound) => wrap(target.bind(...bound), sql, bound);
      if (["all", "first", "run"].includes(property)) return async (...args) => {
        queries.push({ sql, values });
        const result = await target[property](...args);
        await afterQuery(sql, result);
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  const database = new Proxy(db, { get(target, property) {
    if (property === "prepare") return (sql) => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database, queries };
}

before(async () => {
  await server.listen();
  await worker.applyD1Migrations("DB");
  env = await worker.getEnv(); db = env.DB;
  await bootstrapInstance(db, {
    instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: credentialId,
    ownerCredentialToken: ownerToken, ownerDisplayName: "Query_Owner", ownerPrincipalId: ownerId,
    preferredApiOrigin: "https://query.example.test",
  });
  auth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  const workspace = await create("/api/v1/workspaces", { display_name: "Query tests" });
  const project = await create(`/api/v1/workspaces/${workspace.id}/projects`, { display_name: "Query tests" });
  issue = await create(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, { title: "Comments" });
});
after(() => server.close());

test("Owner 邀请列表鉴权次数不随页大小增加，空页与投影后撤权仍拒绝", async () => {
  const url = new URL("https://query.example.test/api/v1/admin/invitations?limit=100");
  const empty = observeDatabase();
  assert.equal((await listInvitations(empty.database, auth, url, Date.now())).items.length, 0);
  assert.equal(empty.queries.length, 3);

  let revoked = false;
  const emptyRace = observeDatabase(async (sql) => {
    if (!revoked && sql.includes("FROM invitations AS i")) {
      revoked = true;
      await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), credentialId).run();
    }
  });
  try {
    await assert.rejects(listInvitations(emptyRace.database, auth, url, Date.now()), error => error.status === 401);
  } finally {
    await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(credentialId).run();
  }

  const now = Date.now();
  const invitationIds = Array.from({ length: 60 }, () => randomUUID());
  for (const id of invitationIds) {
    await db.prepare(`INSERT INTO invitations
      (id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
      VALUES (?1,'project_grant','test',?2,?3,?4,?5,?6)`)
      .bind(id, digest(id), now + 86400000, now, ownerId, randomUUID()).run();
    await db.prepare("INSERT INTO invitation_project_grants(invitation_id,project_id,role) VALUES (?1,?2,'writer')")
      .bind(id, issue.project.id).run();
  }
  for (const limit of [20, 100]) {
    const observed = observeDatabase();
    url.searchParams.set("limit", String(limit));
    const result = await listInvitations(observed.database, auth, url, now);
    assert.equal(result.items.length, Math.min(limit, invitationIds.length));
    assert.equal(observed.queries.length, 4);
    assert.ok(result.items.every(item => item.grants.length === 1));
  }
  revoked = false;
  const projectionRace = observeDatabase(async (sql) => {
    if (!revoked && sql.includes("FROM invitation_project_grants AS ipg")) {
      revoked = true;
      await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), credentialId).run();
    }
  });
  try {
    await assert.rejects(listInvitations(projectionRace.database, auth, url, Date.now()), error => error.status === 401);
  } finally {
    await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(credentialId).run();
  }
});

test("已释放附件墓碑回访仍删除晚到对象并更新检查时间，不重复提交预算写入", async () => {
  const id = randomUUID(), key = `attachments/${id}`, now = Date.now();
  await db.prepare(`INSERT INTO attachment_objects
    (id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id,garbage_at,budget_released_at)
    VALUES (?1,?2,4,?3,'garbage',?4,?4,?5,?4,?4)`)
    .bind(id,key,digest("late"),now,randomUUID()).run();
  await env.ATTACHMENTS.put(key, "late");
  const budgetBefore = await db.prepare("SELECT reserved_bytes FROM attachment_storage WHERE singleton=1").first();
  const prepared = [], calls = [];
  const trackedDb = new Proxy(db, { get(target, property) {
    if (property === "prepare") return sql => { prepared.push(sql); return target.prepare(sql); };
    if (property === "batch") return () => { assert.fail("已释放墓碑不应提交预算 batch"); };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const bucket = new Proxy(env.ATTACHMENTS, { get(target, property) {
    if (["delete", "head"].includes(property)) return (...args) => { calls.push(property); return target[property](...args); };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.deepEqual(await collectAttachmentGarbage({ ...env, DB: trackedDb, ATTACHMENTS: bucket }, now + 1), { checked: 1, deleted: 1 });
  assert.deepEqual(calls, ["delete", "head"]);
  assert.equal(await env.ATTACHMENTS.head(key), null);
  assert.equal(prepared.filter(sql => sql.includes("UPDATE attachment_storage") || sql.includes("SET budget_released_at")).length, 0);
  assert.equal((await db.prepare("SELECT last_checked_at FROM attachment_objects WHERE id=?1").bind(id).first()).last_checked_at, now + 1);
  assert.deepEqual(await db.prepare("SELECT reserved_bytes FROM attachment_storage WHERE singleton=1").first(), budgetBefore);
});

test("评论深页与同时间戳分页无遗漏重复，活动与墓碑查询都使用范围索引", async (t) => {
  const now = Date.now(), active = [], deleted = [];
  for (let index = 0; index < 240; index += 1) {
    for (const removed of [false, true]) {
      const id = randomUUID(), timestamp = now + Math.floor(index / 12);
      (removed ? deleted : active).push({ id, timestamp });
      await db.prepare(`INSERT INTO comments
        (id,issue_id,kind,author_principal_id,body,created_at,created_operation_id,deleted_at,deleted_by_principal_id)
        VALUES (?1,?2,'standard',?3,'pagination',?4,?5,?6,?7)`)
        .bind(id,issue.id,ownerId,timestamp,randomUUID(),removed ? timestamp : null,removed ? ownerId : null).run();
    }
  }
  for (const removed of [false, true]) {
    const expected = (removed ? deleted : active).sort((a,b) => (a.timestamp-b.timestamp || (a.id < b.id ? -1 : 1)) * (removed ? -1 : 1)).map(row => row.id);
    const url = new URL(`https://query.example.test/api/v1/issues/${issue.identifier}/comments?limit=37${removed ? "&deleted=only" : ""}`);
    const observed = observeDatabase(), actual = [];
    for (;;) {
      const page = await listComments(observed.database, auth, issue.identifier, url);
      actual.push(...page.items.map(item => item.id));
      if (!page.has_more) break;
      assert.ok(page.next_cursor);
      url.searchParams.set("cursor", page.next_cursor);
    }
    assert.deepEqual(actual, expected);
    const query = observed.queries.filter(query => query.sql.includes("FROM comments comment")).at(-1);
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
    const detail = plan.results.map(row => row.detail).join("\n");
    assert.match(detail, removed ? /idx_comments_issue_tombstones/ : /idx_comments_issue_list/);
    assert.match(detail, removed ? /deleted_at[<>]/ : /created_at[,>]/);
    assert.doesNotMatch(detail, /USE TEMP B-TREE/);
    const field = removed ? "deleted_at" : "created_at", operator = removed ? "<" : ">";
    const previousSql = query.sql.replace(`(comment.${field}, comment.id) ${operator} (?3, ?4)`, `(?3 IS NULL OR comment.${field} ${operator} ?3 OR (comment.${field} = ?3 AND comment.id ${operator} ?4))`);
    const current = await db.prepare(query.sql).bind(...query.values).all();
    const previous = await db.prepare(previousSql).bind(...query.values).all();
    assert.deepEqual(current.results, previous.results);
    assert.ok(current.meta.rows_read < previous.meta.rows_read, `${field}: ${current.meta.rows_read} < ${previous.meta.rows_read}`);
    t.diagnostic(`${field} 深页读取行数 ${previous.meta.rows_read} -> ${current.meta.rows_read}`);
  }
});
