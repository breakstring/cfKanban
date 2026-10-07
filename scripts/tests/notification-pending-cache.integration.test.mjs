import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { before, after, test } from "node:test";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { listNotifications, acknowledgeNotification, updateNotificationPreferences } from "../../apps/worker/src/services/notifications.ts";

// TestHarness binds 127.0.0.1:0 with persist:false; the config's D1 ID is all zeroes.
// All identities and data are synthetic. No remote D1 or credential files are used.
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const origin = "https://pending-cache.example.test", base = Date.now() - 1000000;
const owner = { id: randomUUID(), credential: randomUUID() };
const actors = Object.fromEntries(["allread", "sparse", "late", "over", "failure", "other", "prefs", "revoked", "disabled", "newcomer", "writeauth", "writepref", "writecas"].map(name => [name, { id: randomUUID(), credential: randomUUID() }]));
let db;
const auth = name => ({ kind: "bearer", isOwner: false, principalId: actors[name].id, credentialId: actors[name].credential,
  credentialFingerprint: "synthetic", displayName: name, principalVersion: 1 });
const pending = (name, { database = db, limit = 20, cursor } = {}) => listNotifications(database, auth(name), new URL(`${origin}/api/v1/me/notifications?pending=true&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), Date.now());
const writeRequest = () => new Request(`${origin}/api/v1/me/notifications`, { method: "POST", headers: { "idempotency-key": randomUUID() } });
const ack = (name, id) => acknowledgeNotification(db, writeRequest(), auth(name), id, Date.now());
const pref = (name, enabled, version) => updateNotificationPreferences(db, writeRequest(), auth(name), enabled, version, Date.now());
const cache = name => db.prepare("SELECT * FROM notification_pending_windows WHERE principal_id=?1").bind(actors[name].id).first();
async function seed({ createdAt = Date.now() - 100, expiresAt = null, withdrawnAt = null } = {}) {
  const id = randomUUID();
  await db.prepare(`INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,expires_at,withdrawn_at,created_operation_id,last_operation_id)
    VALUES(?1,'synthetic','retained text',?2,?3,?4,?5,?1,?1)`).bind(id, createdAt, owner.id, expiresAt, withdrawnAt).run();
  return id;
}
function instrument(database = db, hook = () => {}) {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...args) => wrap(target.bind(...args), sql, args);
    if (["all", "first", "run"].includes(key)) return async (...args) => {
      await hook({ sql, values, phase: "before", method: key });
      const result = key === "run" ? await target.run(...args) : await target.all();
      queries.push({ sql, values, read: result.meta.rows_read, written: result.meta.rows_written, results: result.results });
      await hook({ sql, values, phase: "after", method: key, result });
      return key === "first" ? (args[0] ? result.results[0]?.[args[0]] ?? null : result.results[0] ?? null) : result;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { queries, db: new Proxy(database, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
const reads = queries => queries.reduce((total, query) => total + query.read, 0);
const writes = queries => queries.reduce((total, query) => total + query.written, 0);
before(async () => {
  await server.listen(); const worker = server.getWorker(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner.id, ownerCredentialId: owner.credential,
    ownerCredentialToken: `cfk_v1_cost_${"A".repeat(43)}`, ownerDisplayName: "PendingCacheOwner", preferredApiOrigin: origin });
  for (const [name, actor] of Object.entries(actors)) await db.batch([
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?2,?3,?3)").bind(actor.id, name, ["allread", "sparse"].includes(name) ? 1 : base + 100000),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,1,?4)")
      .bind(actor.credential, actor.id, actor.credential.replaceAll("-", "").repeat(2), randomUUID()),
  ]);
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000)
    INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id)
    SELECT printf('%08x-0000-4000-8000-%012x',n,n),'synthetic','synthetic',?1+n,?2,printf('op-%d',n),printf('op-%d',n) FROM seq`).bind(base, owner.id).run();
  for (const name of ["allread", "sparse"]) await db.prepare(`INSERT INTO notification_acknowledgements(notification_id,principal_id,acknowledged_at,created_operation_id)
    SELECT id,?1,?2,'synthetic-ack' FROM instance_notifications ${name === "sparse" ? "WHERE sequence%10000<>0" : ""}`).bind(actors[name].id, Date.now()).run();
});
after(() => server.close());

test("100k 已确认或稀疏未读：一次冷扫描后 hot poll 点查有界且不重复写", async () => {
  for (const name of ["allread", "sparse"]) {
    const cold = instrument(), first = await pending(name, { database: cold.db, limit: 3 });
    assert.equal(first.items.length, name === "allread" ? 0 : 3);
    assert.ok(reads(cold.queries) >= 100000, "首次完整枚举诚实保留冷成本");
    assert.ok(writes(cold.queries) > 0);
    const saved = await cache(name); assert.equal(JSON.parse(saved.pending_ids_json).length, name === "allread" ? 0 : 10);
    const costs = [];
    for (const limit of [1, 3, 20, 50]) {
      const hot = instrument(), page = await pending(name, { database: hot.db, limit });
      costs.push(reads(hot.queries)); assert.ok(reads(hot.queries) < 150); assert.equal(writes(hot.queries), 0);
      assert.equal(page.items.length, name === "allread" ? 0 : Math.min(limit, 10));
      const main = hot.queries.find(query => query.sql.startsWith("WITH candidates")); assert.ok(main);
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${main.sql}`).bind(...main.values).all()).results.map(row => row.detail);
      assert.ok(plan.some(detail => /INTEGER PRIMARY KEY.*rowid>.*rowid</u.test(detail)), JSON.stringify(plan));
      if (name === "sparse") assert.ok(plan.some(detail => /sqlite_autoindex_instance_notifications_1.*id=/u.test(detail)), JSON.stringify(plan));
      if (limit === 3) console.log(JSON.stringify({ scenario: name, rows: 100000, cold_rows_read: reads(cold.queries), cold_rows_written: writes(cold.queries), hot_rows_read: reads(hot.queries), hot_rows_written: writes(hot.queries), plan }));
    }
    console.log(JSON.stringify({ scenario: `${name}-limits-1-3-20-50`, rows_read: costs }));
    assert.deepEqual(await cache(name), saved);
  }
  await pref("disabled", false, 1);
  const disabled = instrument(); assert.deepEqual((await pending("disabled", { database: disabled.db })).items, []);
  assert.ok(reads(disabled.queries) < 20); assert.equal(writes(disabled.queries), 0);
  const newcomer = instrument(); assert.equal((await pending("newcomer", { database: newcomer.db })).items.length, 1);
  assert.ok(reads(newcomer.queries) < 40, "接收时间显式索引边界跳过创建前历史");
});

test("固定提交上限不漏迟提交旧时间通知；丢失响应、乱序确认、过期撤回均保留正确洞", async () => {
  const firstId = await seed(), expiry = await seed({ expiresAt: Date.now() + 60000 }), withdrawal = await seed();
  let delayedId, inserted = false;
  const raced = instrument(db, async ({ sql, phase }) => {
    if (phase === "after" && sql.startsWith("SELECT COALESCE(MAX(sequence)") && !inserted) {
      inserted = true; delayedId = await seed({ createdAt: base + 100001 });
    }
  });
  const first = await pending("late", { database: raced.db, limit: 1 }); assert.ok(!first.items.some(item => item.id === delayedId));
  const before = await cache("late"); assert.ok(!JSON.parse(before.pending_ids_json).includes(delayedId));
  const second = await pending("late", { limit: 50 });
  for (const id of [firstId, expiry, withdrawal, delayedId]) assert.ok(second.items.some(item => item.id === id));
  const checkpoint = await cache("late");
  assert.deepEqual(await pending("late", { limit: 50 }), second, "忽略上一响应不隐含 ACK 或移除未读");
  await ack("late", delayedId); await ack("late", firstId);
  await db.prepare("UPDATE instance_notifications SET withdrawn_at=?1,version=version+1 WHERE id=?2").bind(Date.now(), withdrawal).run();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 120000;
    const page = await pending("late", { limit: 50 });
    assert.ok(!page.items.some(item => [firstId, delayedId, withdrawal, expiry].includes(item.id)));
  } finally { Date.now = realNow; }
  assert.deepEqual(await cache("late"), checkpoint, "无新序列不重复写；旧洞每次核验事实");
  const other = await pending("other", { limit: 50 }); assert.ok(other.items.some(item => item.id === delayedId), "ACK 与缓存按 Principal 隔离");
});

test("超过50条仍保存完整窗口，cursor页面不推进，确认后保留稳定分页", async () => {
  const time = Date.now(); const ids = [];
  for (let index = 0; index < 60; index++) ids.push(await seed({ createdAt: time }));
  const first = await pending("over", { limit: 3 }); assert.ok(first.next_cursor);
  const initial = await cache("over"); assert.equal(initial.is_complete, 1);
  assert.ok(JSON.parse(initial.pending_ids_json).length > 50);
  const second = await pending("over", { limit: 3, cursor: first.next_cursor });
  assert.ok(second.items.every(item => !first.items.some(previous => previous.id === item.id))); assert.deepEqual(await cache("over"), initial);
  for (const item of (await pending("over", { limit: 50 })).items.slice(0, 20)) await ack("over", item.id);
  const all = await pending("over", { limit: 50 }); assert.ok(all.items.length <= 50); assert.equal(all.next_cursor, null);
  const saved = await cache("over"); assert.deepEqual(saved, initial, "完整窗口中的 ACK 实时过滤，不因无新序列重复写缓存");
  const page = await pending("over", { limit: 3 });
  await seed();
  await pending("over", { limit: 3, cursor: page.next_cursor });
  assert.deepEqual(await cache("over"), saved, "新增通知也不能由cursor部分页推进缓存");
  await pending("over", { limit: 3 }); assert.ok((await cache("over")).through_sequence > saved.through_sequence);
});

test("缓存读取、保存失败及损坏均退回事实；认证与最终偏好保持实时", async () => {
  const active = await seed();
  const failingRead = new Proxy(db, { get(target, key) {
    if (key === "prepare") return sql => { if (sql.includes("FROM notification_pending_windows")) throw new Error("synthetic cache unavailable"); return target.prepare(sql); };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.ok((await pending("failure", { database: failingRead, limit: 50 })).items.some(item => item.id === active));
  await db.prepare("CREATE TRIGGER reject_pending_cache BEFORE INSERT ON notification_pending_windows BEGIN SELECT RAISE(ABORT,'synthetic cache write failure'); END").run();
  try { assert.ok((await pending("failure", { limit: 50 })).items.some(item => item.id === active)); assert.equal(await cache("failure"), null); }
  finally { await db.prepare("DROP TRIGGER reject_pending_cache").run(); }
  // Reduce this actor's backlog enough to make a complete projection, then damage only its derived IDs.
  const rows = (await pending("failure", { limit: 50 })).items;
  for (const item of rows) if (item.id !== active) await ack("failure", item.id);
  assert.ok((await pending("failure", { limit: 50 })).items.some(item => item.id === active));
  assert.ok(await cache("failure"));
  await db.prepare("UPDATE notification_pending_windows SET pending_ids_json='[null]' WHERE principal_id=?1").bind(actors.failure.id).run();
  assert.ok((await pending("failure", { limit: 50 })).items.some(item => item.id === active));
  assert.ok(JSON.parse((await cache("failure")).pending_ids_json).includes(active));
  for (const reenable of [false, true]) {
    const current = await db.prepare("SELECT COALESCE((SELECT version FROM notification_preferences WHERE principal_id=?1),1) AS version").bind(actors.prefs.id).first();
    let changed = false;
    const raced = instrument(db, async ({ sql, phase }) => {
      if (!changed && phase === "after" && sql.includes("SELECT n.*,a.acknowledged_at")) {
        changed = true; await pref("prefs", false, current.version);
        if (reenable) await pref("prefs", true, current.version + 1);
      }
    });
    if (reenable) await assert.rejects(pending("prefs", { database: raced.db }), error => error.code === "CURSOR_SCOPE_MISMATCH");
    else { assert.deepEqual(await pending("prefs", { database: raced.db }), { items: [], next_cursor: null }); await pref("prefs", true, current.version + 1); }
    assert.equal(changed, true);
  }
  let revoked = false;
  const racedAuth = instrument(db, async ({ sql, phase }) => {
    if (!revoked && phase === "after" && sql.includes("SELECT n.*,a.acknowledged_at")) {
      revoked = true; await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), actors.revoked.credential).run();
    }
  });
  await assert.rejects(pending("revoked", { database: racedAuth.db }), error => error.status === 401); assert.equal(await cache("revoked"), null);
});

test("cache 写前认证/偏好变化被 SQL guard 拒绝；并发 CAS 不覆盖较新投影", async () => {
  for (const name of ["writeauth", "writepref", "writecas"]) await db.prepare("UPDATE principals SET created_at=?1 WHERE id=?2").bind(Date.now(), actors[name].id).run();
  const id = await seed({ createdAt: Date.now() });
  for (const name of ["writeauth", "writepref"]) {
    let changed = false;
    const raced = instrument(db, async ({ sql, phase }) => {
      if (!changed && phase === "before" && sql.startsWith("INSERT INTO notification_pending_windows")) {
        changed = true;
        if (name === "writeauth") await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), actors[name].credential).run();
        else await pref(name, false, 1);
      }
    });
    if (name === "writeauth") await assert.rejects(pending(name, { database: raced.db }), error => error.status === 401);
    else assert.deepEqual(await pending(name, { database: raced.db }), { items: [], next_cursor: null });
    assert.equal(changed, true); assert.equal(await cache(name), null);
  }
  assert.ok((await pending("writecas")).items.some(item => item.id === id));
  const before = await cache("writecas"), newer = await seed({ createdAt: Date.now() });
  let competed = false, winner;
  const raced = instrument(db, async ({ sql, phase }) => {
    if (!competed && phase === "before" && sql.startsWith("INSERT INTO notification_pending_windows")) {
      competed = true; await pending("writecas"); winner = await cache("writecas");
    }
  });
  const page = await pending("writecas", { database: raced.db });
  assert.ok(page.items.some(item => item.id === newer)); assert.ok(winner.version > before.version);
  assert.deepEqual(await cache("writecas"), winner);
  assert.ok(raced.queries.filter(query => query.sql.includes("SELECT n.*,a.acknowledged_at")).length >= 2, "CAS失败后使用事实查询，不能假设已保存");
});
