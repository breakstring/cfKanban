import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";

// 所有请求使用隔离的本地 D1 与合成凭据，不连接线上实例。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker();
const hash = value => createHash("sha256").update(value).digest("hex");
const owner = { id: randomUUID(), credentialId: randomUUID(), token: `cfk_v1_owner_${"A".repeat(43)}` };
const actors = ["member", "newcomer", "preferences", "paging", "other", "race", "afterread", "reenabler"].map((name, index) => ({ name, id: randomUUID(), credentialId: randomUUID(), token: `cfk_v1_${name}_${String.fromCharCode(66 + index).repeat(43)}` }));
const [member, newcomer, preferences, paging, other, race, afterread, reenabler] = actors;
let env, db;
const origin = "https://notifications.example.test";
const adminPath = "/api/v1/admin/notifications", personalPath = "/api/v1/me/notifications", preferencesPath = "/api/v1/me/notification-preferences";
async function request(path, { actor = owner, method = "GET", body, key = randomUUID(), headers, overrideEnv = env } = {}) {
  const response = await fetchWorker(new Request(`${origin}${path}`, { method, headers: {
    ...(headers ?? { authorization: `Bearer ${actor.token}` }), ...(key ? { "idempotency-key": key } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), overrideEnv);
  return { status: response.status, data: await response.json(), response };
}
const publish = (body, extra = {}) => request(adminPath, { method: "POST", body, ...extra });
const acknowledge = (id, extra = {}) => request(`${personalPath}/${id}/commands/acknowledge`, { actor: member, method: "POST", body: {}, ...extra });
const preference = (enabled, expectedVersion, extra = {}) => request(preferencesPath, { actor: preferences, method: "PATCH", body: { enabled, expected_version: expectedVersion }, ...extra });
const pending = (actor = member, extra = "") => request(`${personalPath}?pending=true${extra}`, { actor });
async function seed(title, { createdAt = Date.now() - 100, expiresAt = null, withdrawnAt = null } = {}) {
  const id = randomUUID(), op = randomUUID();
  await db.prepare(`INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,expires_at,withdrawn_at,created_operation_id,last_operation_id)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)`).bind(id, title, `Body ${title}`, createdAt, owner.id, expiresAt, withdrawnAt, op).run();
  return id;
}
async function cookie(actor, targetKind = "project_selection") {
  const token = randomUUID().replaceAll("-", "") + "S".repeat(20), csrf = "C".repeat(32);
  const workspaceId = randomUUID(), projectId = randomUUID();
  const target = targetKind === "admin" ? { kind: "admin", entry_path: "/app/admin", section: "overview" }
    : targetKind === "workspace" ? { kind: "workspace", workspace_id: workspaceId, entry_path: `/app/manage?workspace=${workspaceId}` }
    : targetKind === "project" ? { kind: "project", workspace_id: workspaceId, project_id: projectId, entry_path: `/app/w/${workspaceId}/p/${projectId}` }
    : targetKind === "issue" ? { kind: "issue", workspace_id: workspaceId, project_id: projectId, issue_id: randomUUID(), identifier: "CFK-1", entry_path: "/app/issues/CFK-1" }
    : { kind: "project_selection", entry_path: "/app" };
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES(?1,?2,?3,'credential',?4,?5,?6,?7,?8)`).bind(randomUUID(), hash(token), actor.id, actor.credentialId, targetKind, JSON.stringify(target), Date.now() + 3600000, Date.now()).run();
  return { cookie: `cfkanban_session=${token}; cfkanban_csrf=${csrf}`, origin, "x-csrf-token": csrf };
}
const auditCount = async type => (await db.prepare("SELECT COUNT(*) AS count FROM events WHERE type=?1").bind(type).first()).count;
before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); env = await worker.getEnv(); db = env.DB;
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: owner.credentialId, ownerCredentialToken: owner.token, ownerDisplayName: "Notice_Owner", ownerPrincipalId: owner.id, preferredApiOrigin: origin });
  for (const actor of actors) {
    const createdAt = Date.now() - 100000;
    await db.batch([
      db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?2,?3,?3)").bind(actor.id, actor.name, createdAt),
      db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,?3,?4,?5,?6)")
        .bind(actor.credentialId, actor.id, actor.name, hash(actor.token), createdAt, randomUUID()),
    ]);
  }
});
after(() => server.close());

test("本人通知允许无项目授权 Bearer 和任意有效 Cookie；发布及管理仅 Owner 实例控制范围", async () => {
  for (const path of [personalPath, preferencesPath, adminPath]) assert.equal((await request(path, { headers: {} })).status, 401);
  for (const actor of actors) {
    assert.equal((await request(personalPath, { actor })).status, 200);
    const pref = await request(preferencesPath, { actor });
    assert.equal(pref.status, 200); assert.equal(pref.data.enabled, true); assert.equal(pref.data.version, 1);
    assert.equal(pref.response.headers.get("cache-control"), "no-store");
    assert.equal((await request(adminPath, { actor })).status, 403);
    assert.equal((await publish({ title: "denied", body: "denied" }, { actor })).status, 403);
  }
  const memberCookie = await cookie(member, "issue");
  assert.equal((await request(personalPath, { headers: memberCookie })).status, 200);
  assert.equal((await request(preferencesPath, { headers: memberCookie })).status, 200);
  const ownerProject = await cookie(owner, "project");
  assert.equal((await request(adminPath, { headers: ownerProject })).status, 403);
  assert.equal((await publish({ title: "denied", body: "denied" }, { headers: ownerProject })).status, 403);
  assert.equal((await request(adminPath, { headers: await cookie(owner, "admin") })).status, 200);
});

test("发布保留不可变正文、Unicode 上限、可选过期时间；幂等重放不重复发布或审计", async () => {
  const body = { title: ` ${"😀".repeat(200)} `, body: `    <script>alert(1)</script>\n${"😀".repeat(3950)}`, expires_at: new Date(Date.now() + 3600000).toISOString() }, key = randomUUID();
  const first = await publish(body, { key });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.resource.title, body.title.trim()); assert.equal(first.data.resource.body, body.body);
  const count = await auditCount("instance.notification-published"), replay = await publish(body, { key });
  assert.equal(replay.status, 200); assert.equal(replay.data.idempotent_replay, true); assert.deepEqual(replay.data.resource, first.data.resource);
  assert.equal(await auditCount("instance.notification-published"), count);
  assert.equal((await publish({ ...body, body: "changed" }, { key })).data.code, "IDEMPOTENCY_CONFLICT");
  for (const invalid of [{ title: "", body: "x" }, { title: "x", body: " " }, { title: "😀".repeat(201), body: "x" }, { title: "x", body: "😀".repeat(4001) }, { title: "x\0", body: "x" }, { title: "x", body: "x", expires_at: new Date(1).toISOString() }, { title: "x", body: "x", expires_at: "2026-02-30T00:00:00Z" }, { title: "x", body: "x", extra: true }]) assert.equal((await publish(invalid)).status, 400);
  assert.equal((await publish({ title: "x", body: "x" }, { key: null })).status, 400);
  const id = first.data.resource.id;
  for (const column of ["title", "body"]) await assert.rejects(db.prepare(`UPDATE instance_notifications SET ${column}='changed' WHERE id=?1`).bind(id).run());
  await assert.rejects(db.prepare("DELETE FROM instance_notifications WHERE id=?1").bind(id).run());
  assert.equal((await request(personalPath)).data.items.length, 0, "发布者不在本人收件列表");
  assert.ok((await request(adminPath)).data.items.some(item => item.id === id));
});

test("pending 仅含接收范围内未确认且仍有效的通知；新用户仍可主动查看旧历史", async () => {
  const now = Date.now(), old = await seed("before-join", { createdAt: now - 5000 }), active = await seed("after-join", { createdAt: now - 100 });
  const expired = await seed("expired", { createdAt: now - 200, expiresAt: now - 100 }), withdrawn = await seed("withdrawn", { createdAt: now - 300, withdrawnAt: now - 100 });
  await db.prepare("UPDATE principals SET created_at=?1 WHERE id=?2").bind(now - 1000, newcomer.id).run();
  const result = await pending(newcomer); assert.equal(result.status, 200);
  assert.ok(result.data.items.some(item => item.id === active));
  assert.ok(!result.data.items.some(item => [old, expired, withdrawn].includes(item.id)));
  const history = await request(personalPath, { actor: newcomer });
  assert.ok(history.data.items.some(item => item.id === old));
  assert.equal(history.data.items.find(item => item.id === expired).status, "expired");
  assert.equal(history.data.items.find(item => item.id === withdrawn).status, "withdrawn");
  assert.equal(history.data.items.find(item => item.id === withdrawn).body, "Body withdrawn");
});

test("关闭与重开不补发；重复 enabled=true 不改变截止；偏好版本独立且 CAS 并发只提交一次", async () => {
  const before = (await request(preferencesPath, { actor: preferences })).data;
  const disabled = await preference(false, before.version); assert.equal(disabled.status, 200);
  assert.equal(disabled.data.resource.receive_after, before.receive_after);
  const missed = await seed("while-disabled", { createdAt: Date.now() - 10 });
  assert.deepEqual((await pending(preferences)).data.items, []);
  const key = randomUUID(), reenabled = await preference(true, disabled.data.resource.version, { key });
  assert.equal(reenabled.status, 200); assert.ok(Date.parse(reenabled.data.resource.receive_after) > Date.parse(before.receive_after));
  assert.ok(!(await pending(preferences)).data.items.some(item => item.id === missed));
  const replay = await preference(true, disabled.data.resource.version, { key }); assert.equal(replay.data.idempotent_replay, true);
  assert.deepEqual(replay.data.resource, reenabled.data.resource);
  const principalBefore = await db.prepare("SELECT version FROM principals WHERE id=?1").bind(preferences.id).first();
  const same = await preference(true, reenabled.data.resource.version); assert.equal(same.status, 200);
  assert.equal(same.data.resource.receive_after, reenabled.data.resource.receive_after);
  assert.deepEqual(await db.prepare("SELECT version FROM principals WHERE id=?1").bind(preferences.id).first(), principalBefore);
  const results = await Promise.all([preference(false, same.data.resource.version), preference(true, same.data.resource.version)]);
  assert.deepEqual(results.map(value => value.status).sort(), [200, 409]);
  assert.equal(results.find(value => value.status === 409).data.code, "VERSION_CONFLICT");
});

test("逐条确认隔离本人并共用 Web/Agent；并发确认保留首个时间且旧响应不降低事实", async () => {
  const id = await seed("acknowledge"), key = randomUUID();
  const first = await acknowledge(id, { key }); assert.equal(first.status, 200, JSON.stringify(first.data));
  const firstAck = first.data.resource.acknowledged_at; assert.ok(firstAck);
  assert.ok(!(await pending(member)).data.items.some(item => item.id === id));
  assert.ok((await pending(other)).data.items.some(item => item.id === id));
  const headers = await cookie(member, "workspace");
  const cookieResult = await acknowledge(id, { headers }); assert.equal(cookieResult.status, 200);
  assert.equal(cookieResult.data.resource.acknowledged_at, firstAck);
  assert.equal((await acknowledge(id, { headers: { cookie: headers.cookie } })).status, 403);
  const second = await seed("concurrent-ack");
  const both = await Promise.all([acknowledge(second), acknowledge(second)]);
  assert.deepEqual(both.map(value => value.status), [200, 200]);
  assert.equal(both[0].data.resource.acknowledged_at, both[1].data.resource.acknowledged_at);
  const withdrew = await request(`${adminPath}/${id}/commands/withdraw`, { method: "POST", body: { expected_version: 1 } });
  assert.equal(withdrew.status, 200); assert.equal(withdrew.data.resource.status, "withdrawn");
  const replay = await acknowledge(id, { key }); assert.equal(replay.data.idempotent_replay, true); assert.equal(replay.data.resource.acknowledged_at, firstAck);
  const historical = (await request(personalPath, { actor: member })).data.items.find(item => item.id === id);
  assert.equal(historical.status, "withdrawn"); assert.equal(historical.acknowledged_at, firstAck);
  assert.equal((await acknowledge(id, { actor: owner })).status, 404);
});

test("列表有界、按 created_at/id 稳定分页，cursor 绑定 Principal/view/接收偏好且确认不会误处理下一页", async () => {
  const now = Date.now();
  for (let index = 0; index < 6; index += 1) await seed(`page-${index}`, { createdAt: now + index });
  const first = await pending(paging, "&limit=2"); assert.equal(first.status, 200); assert.equal(first.data.items.length, 2); assert.ok(first.data.next_cursor);
  const query = `&limit=2&cursor=${encodeURIComponent(first.data.next_cursor)}`;
  assert.equal((await pending(other, query)).data.code, "CURSOR_SCOPE_MISMATCH");
  assert.equal((await request(`${personalPath}?limit=2&cursor=${encodeURIComponent(first.data.next_cursor)}`, { actor: paging })).data.code, "CURSOR_SCOPE_MISMATCH");
  await acknowledge(first.data.items[0].id, { actor: paging });
  const second = await pending(paging, query); assert.equal(second.status, 200); assert.ok(second.data.items.every(item => !first.data.items.some(old => old.id === item.id)));
  assert.ok(second.data.items.every(item => item.acknowledged_at === null));
  await preference(false, 1, { actor: paging });
  assert.equal((await pending(paging, query)).data.code, "CURSOR_SCOPE_MISMATCH");
  for (const suffix of ["?limit=51", "?limit=0", "?pending=yes", "?pending=true&pending=false", "?extra=x", "?cursor=invalid"]) assert.equal((await request(personalPath + suffix, { actor: member })).status, 400);
});

test("撤回 CAS、幂等重放与过期重放保留唯一发布；安全事件失败原子回滚全部写入", async () => {
  const expiresAt = new Date(Date.now() + 1000).toISOString(), key = randomUUID(), body = { title: "short-lived", body: "retained", expires_at: expiresAt };
  const first = await publish(body, { key }); assert.equal(first.status, 200);
  const realNow = Date.now;
  try { Date.now = () => realNow() + 5000; const replay = await publish(body, { key }); assert.equal(replay.status, 200); assert.equal(replay.data.idempotent_replay, true); }
  finally { Date.now = realNow; }
  const publishedWithdrawal = await request(`${adminPath}/${first.data.resource.id}/commands/withdraw`, { method: "POST", body: { expected_version: 1 } });
  assert.equal(publishedWithdrawal.status, 200);
  const publicationReplay = await publish(body, { key }); assert.equal(publicationReplay.status, 200);
  assert.deepEqual(publicationReplay.data.resource, first.data.resource, "撤回后发布原键重放仍返回冻结的首次发布响应");
  const id = await seed("withdraw-race"), withdrawalKey = randomUUID(), endpoint = `${adminPath}/${id}/commands/withdraw`;
  const outcomes = await Promise.all([request(endpoint, { method: "POST", body: { expected_version: 1 }, key: withdrawalKey }), request(endpoint, { method: "POST", body: { expected_version: 1 } })]);
  assert.deepEqual(outcomes.map(value => value.status).sort(), [200, 409]);
  const winner = outcomes[0].status === 200 ? outcomes[0] : outcomes[1]; assert.equal(winner.data.resource.version, 2);
  assert.equal((await request(endpoint, { method: "POST", body: { expected_version: 1 }, key: outcomes[0].status === 200 ? withdrawalKey : randomUUID() })).status, outcomes[0].status === 200 ? 200 : 409);
  const count = (await db.prepare("SELECT COUNT(*) AS count FROM instance_notifications").first()).count;
  const rollbackWithdrawalId = await seed("withdraw-must-rollback");
  await db.prepare("CREATE TRIGGER notifications_test_reject BEFORE INSERT ON events WHEN NEW.type LIKE '%notification%' BEGIN SELECT RAISE(ABORT,'audit failure'); END").run();
  try {
    assert.equal((await publish({ title: "roll back", body: "never stored" })).status, 503);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM instance_notifications").first()).count, count + 1);
    assert.equal((await request(`${adminPath}/${rollbackWithdrawalId}/commands/withdraw`, { method: "POST", body: { expected_version: 1 } })).status, 503);
    assert.equal((await db.prepare("SELECT version,withdrawn_at FROM instance_notifications WHERE id=?1").bind(rollbackWithdrawalId).first()).version, 1);
    assert.equal((await db.prepare("SELECT withdrawn_at FROM instance_notifications WHERE id=?1").bind(rollbackWithdrawalId).first()).withdrawn_at, null);
    const before = (await request(preferencesPath, { actor: race })).data;
    assert.equal((await preference(false, before.version, { actor: race })).status, 503);
    assert.deepEqual((await request(preferencesPath, { actor: race })).data, before);
    assert.equal((await acknowledge(id, { actor: race })).status, 503);
    assert.equal(await db.prepare("SELECT * FROM notification_acknowledgements WHERE principal_id=?1").bind(race.id).first(), null);
  } finally { await db.prepare("DROP TRIGGER notifications_test_reject").run(); }
});

test("认证后撤销凭据在原子提交时拒绝，不留下偏好、确认或审计", async () => {
  const before = (await request(preferencesPath, { actor: race })).data, count = await auditCount("principal.notification-preferences-updated");
  let batches = 0;
  const racedDb = new Proxy(db, { get(target, property) {
    if (property === "batch") return async statements => { if (++batches === 2) await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), race.credentialId).run(); return db.batch(statements); };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    const result = await preference(false, before.version, { actor: race, overrideEnv: { ...env, DB: racedDb } });
    assert.equal(result.status, 401, JSON.stringify(result.data)); assert.equal(batches, 2);
    assert.equal(await db.prepare("SELECT * FROM notification_preferences WHERE principal_id=?1").bind(race.id).first(), null);
    assert.equal(await auditCount("principal.notification-preferences-updated"), count);
  } finally { await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(race.credentialId).run(); }
});

test("pending 读取期间关闭接收仍按查询时的当前个人偏好过滤", async () => {
  assert.equal((await preference(true, 1, { actor: other })).status, 200);
  assert.ok((await pending(other)).data.items.length > 0);
  let changed = false;
  const racedDb = new Proxy(db, { get(target, property) {
    if (property === "prepare") return sql => {
      const statement = db.prepare(sql);
      if (!sql.startsWith("SELECT COALESCE(np.enabled,1)")) return statement;
      return new Proxy(statement, { get(prepared, member) {
        if (member === "bind") return (...values) => {
          const bound = statement.bind(...values);
          return { first: async () => {
            const result = await bound.first();
            if (!changed) { changed = true; await db.prepare("UPDATE notification_preferences SET enabled=0,version=version+1 WHERE principal_id=?1").bind(other.id).run(); }
            return result;
          } };
        };
        const value = Reflect.get(prepared, member, prepared); return typeof value === "function" ? value.bind(prepared) : value;
      } });
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const result = await request(`${personalPath}?pending=true`, { actor: other, overrideEnv: { ...env, DB: racedDb } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(changed, true); assert.deepEqual(result.data.items, []);
});

for (const [actor, reenable] of [[afterread, false], [reenabler, true]]) {
  test(`pending SQL 已读取正文后另一设备${reenable ? "关闭再开启" : "关闭"}接收，最终偏好检查拒绝旧正文`, async () => {
    const initial = await preference(true, 1, { actor }); assert.equal(initial.status, 200);
    let changed = false, retrievedCount = 0;
    const racedDb = new Proxy(db, { get(target, property) {
      if (property === "prepare") return sql => {
        const statement = db.prepare(sql);
        if (!sql.startsWith("SELECT n.*,a.acknowledged_at FROM instance_notifications n") || !sql.includes("JOIN principals p")) return statement;
        return new Proxy(statement, { get(prepared, member) {
          if (member === "bind") return (...values) => {
            const bound = statement.bind(...values);
            return { all: async () => {
              const result = await bound.all();
              retrievedCount = result.results.length;
              if (!changed) {
                changed = true;
                const disabled = await preference(false, initial.data.resource.version, { actor });
                assert.equal(disabled.status, 200);
                if (reenable) assert.equal((await preference(true, disabled.data.resource.version, { actor })).status, 200);
              }
              return result;
            } };
          };
          const value = Reflect.get(prepared, member, prepared); return typeof value === "function" ? value.bind(prepared) : value;
        } });
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await request(`${personalPath}?pending=true&limit=2`, { actor, overrideEnv: { ...env, DB: racedDb } });
    assert.equal(changed, true); assert.ok(retrievedCount > 0, "并发偏好变化发生在 SQL 确已读取通知正文之后");
    if (reenable) {
      assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.code, "CURSOR_SCOPE_MISMATCH");
      assert.ok(!("items" in result.data));
    } else {
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(result.data, { items: [], next_cursor: null });
    }
    assert.equal((await request(personalPath, { actor })).status, 200, "主动历史读取不受接收偏好变化限制");
    assert.equal((await request(adminPath)).status, 200, "Owner 管理历史仍可用");
  });
}
