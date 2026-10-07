import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { listNotifications } from "../../apps/worker/src/services/notifications.ts";

// 全零 D1 ID、127.0.0.1:0、persist:false；不读取外部实例或真实身份。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker(), owner = randomUUID(), principal = randomUUID(), credential = randomUUID();
const origin = "https://notification-window.example.test";
const auth = { kind: "bearer", isOwner: false, principalId: principal, credentialId: credential, credentialFingerprint: "synthetic", displayName: "WindowReader", principalVersion: 1 };
let db, seeded = 0;
const cache = () => db.prepare("SELECT * FROM notification_pending_windows WHERE principal_id=?1").bind(principal).first();
const idFor = number => `20000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const reads = queries => queries.reduce((sum, query) => sum + query.read, 0);
const writes = queries => queries.reduce((sum, query) => sum + query.written, 0);
function instrument() {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...bound) => wrap(target.bind(...bound), sql, bound);
    if (["all", "first", "run"].includes(key)) return async (...args) => {
      const result = key === "run" ? await target.run(...args) : await target.all();
      queries.push({ sql, values, read: result.meta.rows_read, written: result.meta.rows_written, returned: result.results.length });
      return key === "first" ? (args[0] ? result.results[0]?.[args[0]] ?? null : result.results[0] ?? null) : result;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { queries, db: new Proxy(db, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
const pending = (database = db, limit = 3, cursor = null) => listNotifications(database, auth,
  new URL(`${origin}/api/v1/me/notifications?pending=true&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), Date.now());
async function seedUntil(size) {
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM seq WHERE n<?2)
    INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,expires_at,created_operation_id,last_operation_id)
    SELECT printf('20000000-0000-4000-8000-%012x',n),'Synthetic','Synthetic',n,?3,
      CASE WHEN n<=51 THEN NULL ELSE n+1 END,printf('notice-%d',n),printf('notice-%d',n) FROM seq`).bind(seeded + 1, size, owner).run();
  seeded = size;
}
async function acknowledge(ids) {
  await db.prepare(`INSERT INTO notification_acknowledgements(notification_id,principal_id,acknowledged_at,created_operation_id)
    SELECT value,?2,?3,'synthetic-ack' FROM json_each(?1)`).bind(JSON.stringify(ids), principal, Date.now()).run();
}
async function livePending() {
  return (await db.prepare(`SELECT n.id FROM instance_notifications n
    LEFT JOIN notification_acknowledgements a ON a.notification_id=n.id AND a.principal_id=?1
    WHERE n.created_by_principal_id<>?1 AND n.withdrawn_at IS NULL AND (n.expires_at IS NULL OR n.expires_at>?2)
      AND a.notification_id IS NULL ORDER BY n.created_at DESC,n.id DESC`).bind(principal, Date.now()).all()).results.map(row => row.id);
}

before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner, ownerCredentialId: randomUUID(),
    ownerCredentialToken: `cfk_v1_window_${"A".repeat(43)}`, ownerDisplayName: "WindowOwner", preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'WindowReader','windowreader',1,1)").bind(principal).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,1,?1)")
    .bind(credential, principal, createHash("sha256").update(credential).digest("hex")).run();
});
after(() => server.close());

test("51条旧未读与1k/10k/50k新过期历史：一次冷扫后重复提醒读量稳定且零写", async t => {
  const costs = [];
  for (const size of [1000, 10000, 50000]) {
    await seedUntil(size);
    await db.prepare("DELETE FROM notification_pending_windows WHERE principal_id=?1").bind(principal).run();
    const cold = instrument(), first = await pending(cold.db);
    assert.deepEqual(first.items.map(row => row.id), [51, 50, 49].map(idFor));
    const saved = await cache(); assert.equal(saved.is_complete, 1); assert.equal(JSON.parse(saved.pending_ids_json).length, 51);
    assert.ok(reads(cold.queries) >= size, "首次扫描成本不伪装成固定页大小");
    const hotCosts = [];
    for (const limit of [3, 50, 3]) {
      const hot = instrument(), page = await pending(hot.db, limit);
      assert.deepEqual(page.items.map(row => row.id), Array.from({ length: limit }, (_, index) => idFor(51 - index)));
      assert.ok(reads(hot.queries) < 400, `${size}: ${reads(hot.queries)}`); assert.equal(writes(hot.queries), 0);
      assert.ok(hot.queries.length < 12); hotCosts.push(reads(hot.queries));
      if (limit === 50) assert.deepEqual((await pending(db, 50, page.next_cursor)).items.map(row => row.id), [idFor(1)]);
    }
    assert.deepEqual(await cache(), saved);
    costs.push({ history: size, cold_rows_read: reads(cold.queries), cold_rows_written: writes(cold.queries), hot_rows_read: hotCosts });
  }
  assert.deepEqual(costs[0].hot_rows_read, costs[2].hot_rows_read);
  t.diagnostic(JSON.stringify({ scenario: "notification-51-pending-expired-history", costs }));
  const previous = await cache(); await seedUntil(70000);
  const delta = instrument(); await pending(delta.db);
  assert.ok(reads(delta.queries) >= 20000); assert.ok((await cache()).through_sequence > previous.through_sequence);
  const caughtUp = instrument(); await pending(caughtUp.db);
  assert.equal(reads(caughtUp.queries), costs.at(-1).hot_rows_read[0]); assert.equal(writes(caughtUp.queries), 0);
  t.diagnostic(JSON.stringify({ scenario: "notification-new-sequence-gap", new_notifications: 20000,
    catchup_rows_read: reads(delta.queries), catchup_rows_written: writes(delta.queries), next_poll_rows_read: reads(caughtUp.queries) }));
});

test("超过窗口保留不完整边界，确认后续扫；迟提交旧时间、分页和新增水位不漏项", async t => {
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<150)
    INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id)
    SELECT printf('30000000-0000-4000-8000-%012x',n),'Synthetic','Synthetic',60000+n,?1,printf('window-%d',n),printf('window-%d',n) FROM seq`).bind(owner).run();
  const first = await pending(db, 50), initial = await cache();
  assert.equal(initial.is_complete, 0); assert.equal(JSON.parse(initial.pending_ids_json).length, 100);
  assert.equal(initial.floor_id, JSON.parse(initial.pending_ids_json).at(-1));
  const unchanged = instrument(); assert.deepEqual(await pending(unchanged.db, 50), first);
  assert.ok(reads(unchanged.queries) < 700); assert.equal(writes(unchanged.queries), 0);
  await acknowledge(JSON.parse(initial.pending_ids_json).slice(0, 80));
  const refilled = instrument(), page = await pending(refilled.db, 50), next = await cache();
  assert.deepEqual(page.items.map(row => row.id), (await livePending()).slice(0, 50));
  assert.equal(next.is_complete, 0); assert.equal(JSON.parse(next.pending_ids_json).length, 100);
  assert.ok(next.floor_created_at < initial.floor_created_at); assert.ok(writes(refilled.queries) > 0);
  const stable = instrument(); await pending(stable.db);
  assert.ok(reads(stable.queries) < 700); assert.equal(writes(stable.queries), 0);
  const late = randomUUID();
  await db.prepare(`INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id)
    VALUES(?1,'Late','Late',10,?2,?1,?1)`).bind(late, owner).run();
  await pending(); const lateWindow = await cache();
  assert.ok(lateWindow.through_sequence > next.through_sequence); assert.equal(lateWindow.is_complete, 0);
  const all = []; let cursor = null;
  do { const result = await pending(db, 20, cursor); all.push(...result.items.map(row => row.id)); cursor = result.next_cursor; } while (cursor);
  assert.deepEqual(all, await livePending()); assert.ok(all.includes(late));
  assert.deepEqual(await cache(), lateWindow, "显式后续分页不推进窗口");
  await acknowledge(JSON.parse(lateWindow.pending_ids_json));
  const final = await pending(db, 50), complete = await cache();
  assert.equal(complete.is_complete, 1); assert.equal(complete.floor_created_at, null); assert.equal(complete.floor_id, null);
  assert.deepEqual(final.items.map(row => row.id), await livePending()); assert.ok(final.items.some(row => row.id === late));
  const finalHot = instrument(); await pending(finalHot.db);
  assert.ok(reads(finalHot.queries) < 200); assert.equal(writes(finalHot.queries), 0);
  t.diagnostic(JSON.stringify({ scenario: "notification-incomplete-window", initial_hot_read: reads(unchanged.queries),
    refill_read: reads(refilled.queries), refill_written: writes(refilled.queries), after_refill_hot_read: reads(stable.queries), final_hot_read: reads(finalHot.queries) }));
});

test("首次按 Principal 有界继承旧完整缓存，不扫描历史或改写旧版投影", async () => {
  const ids = await livePending(); assert.ok(ids.length <= 50);
  const upper = (await db.prepare("SELECT MAX(sequence) AS upper FROM instance_notifications").first()).upper;
  await db.prepare("INSERT INTO notification_pending_cache VALUES(?1,1,1,?2,?3,7)").bind(principal, upper, JSON.stringify(ids)).run();
  const legacy = await db.prepare("SELECT * FROM notification_pending_cache WHERE principal_id=?1").bind(principal).first();
  await db.prepare("DELETE FROM notification_pending_windows WHERE principal_id=?1").bind(principal).run();
  const observed = instrument(), page = await pending(observed.db, 50);
  assert.deepEqual(page.items.map(row => row.id), ids); assert.ok(reads(observed.queries) < 200);
  assert.equal((await cache()).is_complete, 1);
  assert.deepEqual(await db.prepare("SELECT * FROM notification_pending_cache WHERE principal_id=?1").bind(principal).first(), legacy);
});
