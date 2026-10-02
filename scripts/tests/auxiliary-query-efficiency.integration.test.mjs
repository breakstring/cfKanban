import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { createCursorContext, encodeCursor } from "../../apps/worker/src/kernel/cursor.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { collectAttachmentGarbage, listAttachments } from "../../apps/worker/src/services/attachments.ts";
import { listMyPasskeys } from "../../apps/worker/src/services/passkeys.ts";
import { listNotifications } from "../../apps/worker/src/services/notifications.ts";

// 全零 D1 ID、127.0.0.1:0、persist:false；仅使用本地合成身份、D1 和 R2。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.attachments-test.jsonc" }] });
const worker = server.getWorker(), origin = "https://auxiliary-cost.example.test";
const ownerId = randomUUID(), credentialId = randomUUID(), ownerToken = `cfk_v1_cost_${"A".repeat(43)}`;
const readerId = randomUUID(), readerCredentialId = randomUUID();
const base = Date.now() - 1000000, size = 10000;
const hash = value => createHash("sha256").update(value).digest("hex");
const idFor = (prefix, index) => `${prefix}-${index.toString(16).padStart(12, "0")}`;
const prefixes = { active: "10000000-0000-4000-8000", deleted: "20000000-0000-4000-8000", passkey: "30000000-0000-4000-8000", notification: "40000000-0000-4000-8000", garbage: "50000000-0000-4000-8000" };
const readerAuth = { kind: "bearer", isOwner: false, principalId: readerId, credentialId: readerCredentialId,
  credentialFingerprint: "synthetic", displayName: "CostReader", principalVersion: 1 };
let db, env, auth, issue;

async function create(path, body) {
  const response = await worker.fetch(path, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`,
    "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.resource;
}

function instrument({ beforeQuery = async () => {}, afterQuery = async () => {}, beforeBatch = async () => {} } = {}) {
  const queries = [], calls = [], rawStatements = new WeakMap();
  const wrap = (statement, sql, values = []) => {
    const wrapped = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...bound) => wrap(target.bind(...bound), sql, bound);
      if (["all", "first", "run"].includes(property)) return async (...args) => {
        const query = { sql, values, method: property };
        calls.push(query);
        await beforeQuery(query);
        const result = property === "run" ? await target.run(...args) : await target.all();
        queries.push({ ...query, read: result.meta.rows_read, written: result.meta.rows_written, results: result.results });
        await afterQuery(query, result);
        return property === "first" ? (args[0] ? result.results[0]?.[args[0]] ?? null : result.results[0] ?? null) : result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    rawStatements.set(wrapped, { statement, sql, values });
    return wrapped;
  };
  return { queries, calls, database: new Proxy(db, { get(target, property) {
    if (property === "prepare") return sql => wrap(target.prepare(sql), sql);
    if (property === "batch") return async statements => {
      const raw = statements.map(statement => rawStatements.get(statement));
      calls.push({ method: "batch", statements: raw });
      await beforeBatch(raw);
      const results = await target.batch(raw.map(row => row.statement));
      results.forEach((result, index) => queries.push({ sql: raw[index].sql, values: raw[index].values,
        read: result.meta.rows_read, written: result.meta.rows_written, results: result.results }));
      return results;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
const totalReads = observed => observed.queries.reduce((sum, query) => sum + query.read, 0);
const totalWrites = observed => observed.queries.reduce((sum, query) => sum + query.written, 0);
const plan = async query => (await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all()).results.map(row => row.detail).join("\n");
const bucketProxy = overrides => new Proxy(env.ATTACHMENTS, { get(target, property) {
  if (property in overrides) return overrides[property];
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
} });

before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); env = await worker.getEnv(); db = env.DB;
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: ownerId,
    ownerCredentialId: credentialId, ownerCredentialToken: ownerToken, ownerDisplayName: "AuxiliaryCostOwner", preferredApiOrigin: origin });
  auth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  const workspace = await create("/api/v1/workspaces", { display_name: "Auxiliary cost" });
  const project = await create(`/api/v1/workspaces/${workspace.id}/projects`, { display_name: "Auxiliary cost" });
  issue = await create(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, { title: "Synthetic history" });
  await db.batch([
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'CostReader','costreader',1,1)").bind(readerId),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,1,?4)")
      .bind(readerCredentialId, readerId, hash(readerCredentialId), randomUUID()),
  ]);
  for (const deleted of [false, true]) {
    const prefix = prefixes[deleted ? "deleted" : "active"];
    // 活动 metadata 的历史垃圾不占 active slot；仅最后 20 行为 ready。
    await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
      INSERT INTO attachment_objects(id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id,garbage_at,budget_released_at)
      SELECT printf('%s-%012x',?2,n),printf('attachments/%s-%012x',?2,n),1,?3,
        CASE WHEN ?5=0 AND n>?1-20 THEN 'ready' ELSE 'garbage' END,?4+86400000,?4,printf('attachment-%s-%d',?2,n),
        CASE WHEN ?5=0 AND n>?1-20 THEN NULL ELSE ?4 END,CASE WHEN ?5=0 AND n>?1-20 THEN NULL ELSE ?4 END FROM seq`)
      .bind(size, prefix, hash("synthetic"), base, deleted ? 1 : 0).run();
    await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
      INSERT INTO issue_attachments(id,issue_id,filename,content_type,uploaded_by_principal_id,created_at,created_operation_id,deleted_at,deleted_by_principal_id)
      SELECT printf('%s-%012x',?2,n),?3,'synthetic.log','text/plain',?4,?5,printf('metadata-%s-%d',?2,n),
        CASE WHEN ?6=1 THEN ?5+n ELSE NULL END,CASE WHEN ?6=1 THEN ?4 ELSE NULL END FROM seq`)
      .bind(size, prefix, issue.id, ownerId, base, deleted ? 1 : 0).run();
  }
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
    INSERT INTO web_authenticators(id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,revoked_at,revoked_by_principal_id,created_operation_id)
    SELECT printf('%s-%012x',?2,n),?3,printf('credential-%d',n),'synthetic',-7,'synthetic',0,0,'auxiliary-cost.example.test',?4,
      CASE WHEN n<=?1-100 THEN ?4+1 ELSE NULL END,CASE WHEN n<=?1-100 THEN ?3 ELSE NULL END,printf('passkey-%d',n) FROM seq`)
    .bind(size, prefixes.passkey, ownerId, base).run();
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
    INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id)
    SELECT printf('%s-%012x',?2,n),'synthetic','retained history',?3,?4,printf('notification-%d',n),printf('notification-%d',n) FROM seq`)
    .bind(size, prefixes.notification, base, ownerId).run();
});
after(() => server.close());

test("附件首屏、同时间戳续页和深页保持完整顺序，活动及删除页读量有界", async t => {
  for (const deleted of [false, true]) {
    const prefix = prefixes[deleted ? "deleted" : "active"];
    const url = new URL(`${origin}/api/v1/issues/${issue.identifier}/attachments?limit=20${deleted ? "&deleted=only" : ""}`);
    const context = await createCursorContext("attachments", { issue_id: issue.id, deleted: deleted ? "only" : "exclude" }, [issue.project.id], ownerId);
    const costs = [];
    for (const boundary of [0, 20, 8000, size]) {
      if (boundary) url.searchParams.set("cursor", encodeCursor(context, [base, idFor(prefix, boundary)]));
      const observed = instrument(), result = await listAttachments({ ...env, DB: observed.database }, auth, issue.identifier, url, Date.now());
      assert.deepEqual(result.items.map(row => row.id), Array.from({ length: Math.min(20, size - boundary) }, (_, index) => idFor(prefix, boundary + index + 1)));
      assert.equal(result.has_more, boundary < size - 20);
      const query = observed.queries.find(query => query.sql.includes("FROM issue_attachments a JOIN attachment_objects"));
      costs.push(query.read); assert.ok(query.read <= 70, `${deleted}: ${query.read}`);
      const detail = await plan(query);
      assert.match(detail, deleted ? /idx_issue_attachments_deleted_order/ : /idx_issue_attachments_issue_created/);
      assert.doesNotMatch(detail, /USE TEMP B-TREE/);
      if (boundary) {
        assert.match(query.sql, /\(a\.created_at,a\.id\)>\(\?2,\?3\)/);
        const previousSql = query.sql.replace("(a.created_at,a.id)>(?2,?3)", "(?2 IS NULL OR a.created_at>?2 OR (a.created_at=?2 AND a.id>?3))");
        const previous = await db.prepare(previousSql).bind(...query.values).all();
        assert.deepEqual(query.results, previous.results);
        if (boundary === 8000) assert.ok(previous.meta.rows_read > 8000);
      } else assert.doesNotMatch(query.sql, /IS NULL OR/);
    }
    t.diagnostic(`${deleted ? "deleted" : "active"} 附件首屏/续页/深页/空页 rows_read=${costs.join("/")}`);
  }
});

test("Passkey 10000 条历史含 9900 条撤销，保留 100 条摘要及 truncated 且读量有界", async t => {
  const observed = instrument(), result = await listMyPasskeys(observed.database, auth, Date.now());
  assert.equal(result.truncated, true); assert.equal(result.items.length, 100);
  assert.deepEqual(result.items.map(row => row.id), Array.from({ length: 100 }, (_, index) => idFor(prefixes.passkey, size - index)));
  const query = observed.queries.find(query => query.sql.includes("FROM web_authenticators authenticator"));
  assert.equal(query.results.length, 101); assert.notEqual(query.results[100].revoked_at, null);
  assert.ok(query.read <= 110, `${query.read}`);
  const detail = await plan(query); assert.match(detail, /idx_web_authenticators_principal_history/); assert.doesNotMatch(detail, /USE TEMP B-TREE/);
  t.diagnostic(`Passkey 主查询 rows_read=${query.read}`);
});

test("通知同时间戳历史和 pending 深页直接定位 ID，缓存不可用仍完整回退", async t => {
  for (const pending of [false, true]) {
    const url = new URL(`${origin}/api/v1/me/notifications?pending=${pending}&limit=20`);
    const context = await createCursorContext("personal-notifications", { pending, ...(pending ? { preference_version: 1, receive_after: 1 } : {}) }, [], readerId);
    const costs = [];
    for (const boundary of [size + 1, size - 19, 2000, 1]) {
      if (boundary !== size + 1) url.searchParams.set("cursor", encodeCursor(context, [base, idFor(prefixes.notification, boundary)]));
      const observed = instrument(), result = await listNotifications(observed.database, readerAuth, url, Date.now());
      assert.deepEqual(result.items.map(row => row.id), Array.from({ length: Math.min(20, boundary - 1) }, (_, index) => idFor(prefixes.notification, boundary - index - 1)));
      const query = observed.queries.find(query => query.sql.includes("SELECT n.*,a.acknowledged_at"));
      costs.push(query.read); assert.ok(query.read <= (pending && boundary === size + 1 ? 170 : 80), `${pending}: ${query.read}`);
      const detail = await plan(query); assert.doesNotMatch(detail, /USE TEMP B-TREE/);
      if (boundary !== size + 1) {
        assert.match(query.sql, /\(n\.created_at,n\.id\)</);
        const previousSql = query.sql.replace(/\(n\.created_at,n\.id\)<\((\?\d+),(\?\d+)\)/, "(n.created_at<$1 OR (n.created_at=$1 AND n.id<$2))");
        const previous = await db.prepare(previousSql).bind(...query.values).all();
        assert.deepEqual(query.results, previous.results);
        if (boundary === 2000) assert.ok(previous.meta.rows_read > 8000);
      }
    }
    if (pending) {
      url.searchParams.set("cursor", encodeCursor(context, [base, idFor(prefixes.notification, 2000)]));
      const unavailable = instrument({ beforeQuery: async query => { if (query.sql.includes("FROM notification_pending_cache")) throw new Error("injected cache read failure"); } });
      const result = await listNotifications(unavailable.database, readerAuth, url, Date.now());
      assert.deepEqual(result.items.map(row => row.id), Array.from({ length: 20 }, (_, index) => idFor(prefixes.notification, 1999 - index)));
      assert.ok(totalReads(unavailable) < 100); assert.equal(totalWrites(unavailable), 0);
      assert.equal(await db.prepare("SELECT * FROM notification_pending_cache WHERE principal_id=?1").bind(readerId).first(), null, "超过 50 条的首屏及有游标页面不保存完整缓存");
    }
    t.diagnostic(`${pending ? "pending" : "history"} 通知首屏/续页/深页/空页 rows_read=${costs.join("/")}`);
  }
});

test("10000 个已释放墓碑每轮仍公平回访 64 项，仅一次 metadata 更新及三个独立 D1 调用", async t => {
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
    INSERT INTO attachment_objects(id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id,garbage_at,budget_released_at)
    SELECT printf('%s-%012x',?2,n),printf('attachments/%s-%012x',?2,n),1,?3,'garbage',?4,?4,printf('garbage-%d',n),?4,?4 FROM seq`)
    .bind(size, prefixes.garbage, hash("synthetic"), base - 100000).run();
  for (const round of [0, 1]) {
    const observed = instrument({ beforeBatch: async () => assert.fail("已释放墓碑不重复写预算") }), calls = [];
    const bucket = bucketProxy({ delete: async key => calls.push(["delete", key]), head: async key => { calls.push(["head", key]); return null; } });
    const result = await collectAttachmentGarbage({ ...env, DB: observed.database, ATTACHMENTS: bucket }, base + 200000 + round);
    assert.deepEqual(result, { checked: 64, deleted: 64 }); assert.equal(observed.calls.length, 3);
    const selected = observed.queries.find(query => query.sql.startsWith("SELECT id,object_key"));
    assert.deepEqual(selected.results.map(row => row.id), Array.from({ length: 64 }, (_, index) => idFor(prefixes.garbage, round * 64 + index + 1)));
    assert.deepEqual(calls, selected.results.flatMap(row => [["delete", row.object_key], ["head", row.object_key]]));
    assert.equal(observed.queries.filter(query => query.sql.includes("SET last_checked_at")).length, 1);
    const metadata = observed.queries.find(query => query.sql.includes("SET last_checked_at"));
    t.diagnostic(`metadata plan=${await plan(metadata)}, rows_read=${metadata.read}`);
    assert.ok(totalReads(observed) < 200, `${totalReads(observed)}`); assert.equal(totalWrites(observed), 128);
    if (round === 0) {
      const previous = instrument();
      for (const row of selected.results) await previous.database.prepare("UPDATE attachment_objects SET last_checked_at=?2 WHERE id=?1 AND state='garbage'")
        .bind(row.id, base + 200000).run();
      assert.equal(previous.calls.length, 64); assert.equal(totalReads(previous), 64); assert.equal(totalWrites(previous), 128);
      t.diagnostic(`相同候选旧路径 calls=${previous.calls.length + 2}, rows_read=${totalReads(previous) + totalReads(observed) - metadata.read}, rows_written=${totalWrites(previous)}`);
    }
    const detail = await plan(selected); assert.match(detail, /idx_attachment_objects_cleanup/); assert.doesNotMatch(detail, /USE TEMP B-TREE/);
    t.diagnostic(`released Cron round ${round + 1}: calls=${observed.calls.length}, rows_read=${totalReads(observed)}, rows_written=${totalWrites(observed)}`);
  }
});

async function garbage(released = false) {
  const id = randomUUID(), key = `attachments/${id}`;
  await db.prepare(`INSERT INTO attachment_objects(id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id,garbage_at,budget_released_at)
    VALUES(?1,?2,4,?3,'garbage',?4,?4,?1,?4,?5)`).bind(id, key, hash("late"), 1, released ? 1 : null).run();
  await env.ATTACHMENTS.put(key, "late");
  if (!released) await db.prepare("UPDATE attachment_storage SET reserved_bytes=reserved_bytes+4 WHERE singleton=1").run();
  return { id, key };
}
const budget = async () => (await db.prepare("SELECT reserved_bytes FROM attachment_storage WHERE singleton=1").first()).reserved_bytes;

test("R2 删除、晚到 PUT 与 D1 预算失败均推进回访，重试只释放一次并永久保留墓碑", async () => {
  const good = await garbage(), failedDelete = await garbage(), latePut = await garbage(), failedBudget = await garbage(), released = await garbage(true);
  const before = await budget(), now = Date.now();
  const observed = instrument({ beforeBatch: async statements => { if (statements[0].values[0] === failedBudget.id) throw new Error("injected budget batch failure"); } });
  const bucket = bucketProxy({ delete: async key => {
    if (key === failedDelete.key) throw new Error("injected R2 delete failure");
    await env.ATTACHMENTS.delete(key);
  }, head: async key => {
    if (key === latePut.key) await env.ATTACHMENTS.put(key, "late");
    return env.ATTACHMENTS.head(key);
  } });
  await collectAttachmentGarbage({ ...env, DB: observed.database, ATTACHMENTS: bucket }, now);
  assert.equal(await budget(), before - 4);
  for (const object of [good, failedDelete, latePut, failedBudget, released]) {
    const row = await db.prepare("SELECT * FROM attachment_objects WHERE id=?1").bind(object.id).first();
    assert.equal(row.last_checked_at, now);
    assert.equal(row.budget_released_at !== null, object === good || object === released);
  }
  // 仅隔离 fixture 调整队列位置，确保下一轮重新检查故障项。
  await db.prepare("UPDATE attachment_objects SET last_checked_at=?1 WHERE state='garbage' AND id NOT IN (?2,?3,?4,?5,?6)")
    .bind(now + 86400000, good.id, failedDelete.id, latePut.id, failedBudget.id, released.id).run();
  await env.ATTACHMENTS.put(released.key, "late");
  await collectAttachmentGarbage(env, now + 1);
  assert.equal(await budget(), before - 16);
  await collectAttachmentGarbage(env, now + 2);
  assert.equal(await budget(), before - 16);
  for (const object of [good, failedDelete, latePut, failedBudget, released]) {
    assert.equal(await env.ATTACHMENTS.head(object.key), null);
    assert.notEqual(await db.prepare("SELECT id FROM attachment_objects WHERE id=?1").bind(object.id).first(), null);
  }
});

test("并发清理保持预算 guard，metadata 写失败时不开始 R2 操作", async () => {
  const object = await garbage(), before = await budget();
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const observed = instrument({ afterQuery: async query => {
    if (query.sql.startsWith("SELECT id,object_key")) { arrived += 1; if (arrived === 2) release(); await barrier; }
  } });
  await Promise.all([collectAttachmentGarbage({ ...env, DB: observed.database }), collectAttachmentGarbage({ ...env, DB: observed.database })]);
  assert.equal(await budget(), before - 4);
  const row = await db.prepare("SELECT budget_released_at FROM attachment_objects WHERE id=?1").bind(object.id).first();
  assert.notEqual(row.budget_released_at, null);
  const unavailable = instrument({ beforeQuery: async query => { if (query.sql.includes("SET last_checked_at")) throw new Error("injected metadata failure"); } });
  let r2Calls = 0;
  const bucket = bucketProxy({ delete: async () => { r2Calls += 1; }, head: async () => { r2Calls += 1; return null; } });
  await assert.rejects(collectAttachmentGarbage({ ...env, DB: unavailable.database, ATTACHMENTS: bucket }), /injected metadata failure/);
  assert.equal(r2Calls, 0); assert.equal(await budget(), before - 4);
});
