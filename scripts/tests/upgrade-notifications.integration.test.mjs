import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { RELEASE_VERSION } from "../../apps/worker/src/release-version.ts";

// 隔离本地D1和合成身份；不访问线上实例或Cloudflare控制面。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker(), hash = value => createHash("sha256").update(value).digest("hex");
const owner = { id: randomUUID(), credentialId: randomUUID(), token: `cfk_v1_upgrade_${"A".repeat(43)}` };
const member = { id: randomUUID(), credentialId: randomUUID(), token: `cfk_v1_member_${"B".repeat(43)}` };
const origin = "https://upgrade-notifications.example.test", settings = "/api/v1/admin/upgrade-notification-settings", publish = "/api/v1/admin/notifications/commands/publish-upgrade";
let env, db;
const upgradeBody = extra => ({ previous_release_version: "0.0.0", release_version: RELEASE_VERSION, deployment_id: randomUUID(), worker_version_id: randomUUID(), ...extra });
async function request(apiPath, { actor = owner, method = "GET", body, key = randomUUID(), headers, overrideEnv = env } = {}) {
  const response = await fetchWorker(new Request(origin + apiPath, { method, headers: { ...(headers ?? { authorization: `Bearer ${actor.token}` }), ...(key ? { "idempotency-key": key } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), overrideEnv);
  return { status: response.status, data: await response.json() };
}
const enable = async value => { const current = await request(settings); return request(settings, { method: "PATCH", body: { enabled: value, expected_version: current.data.version } }); };
const notifications = async () => (await db.prepare("SELECT COUNT(*) AS count FROM instance_notifications").first()).count;
before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); env = await worker.getEnv(); db = env.DB;
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: owner.credentialId, ownerCredentialToken: owner.token, ownerDisplayName: "Upgrade_Owner", ownerPrincipalId: owner.id, preferredApiOrigin: origin });
  const createdAt = Date.now() - 1000;
  await db.batch([
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'Member','member',?2,?2)").bind(member.id, createdAt),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'member',?3,?4,?5)").bind(member.credentialId, member.id, hash(member.token), createdAt, randomUUID()),
  ]);
});
after(() => server.close());

test("默认关闭，Owner实例范围认证与Cookie写保护，设置CAS/幂等和审计原子性", async () => {
  const initial = await request(settings); assert.deepEqual(initial.data, { enabled: false, version: 1 });
  assert.equal((await request("/api/v1/admin/release-updates", { headers: {} })).status, 401);
  assert.equal((await request("/api/v1/admin/release-updates", { actor: member })).status, 403);
  for (const path of [settings, publish]) assert.equal((await request(path, { actor: member, ...(path === publish ? { method: "POST", body: upgradeBody() } : {}) })).status, 403);
  const token = randomUUID().replaceAll("-", "") + "S".repeat(20), now = Date.now(), projectId = randomUUID(), workspaceId = randomUUID();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES(?1,?2,?3,'credential',?4,'project',?5,?6,?7)")
    .bind(randomUUID(), hash(token), owner.id, owner.credentialId, JSON.stringify({ kind: "project", workspace_id: workspaceId, project_id: projectId, entry_path: `/app/w/${workspaceId}/p/${projectId}` }), now + 3600000, now).run();
  assert.equal((await request(settings, { headers: { cookie: `cfkanban_session=${token}` } })).status, 403);
  assert.equal((await request("/api/v1/admin/release-updates", { headers: { cookie: `cfkanban_session=${token}` } })).status, 403);
  const idempotency = randomUUID(), first = await request(settings, { method: "PATCH", key: idempotency, body: { enabled: true, expected_version: 1 } });
  assert.equal(first.status, 200, JSON.stringify(first.data)); assert.deepEqual(first.data.resource, { enabled: true, version: 2 });
  const replay = await request(settings, { method: "PATCH", key: idempotency, body: { enabled: true, expected_version: 1 } }); assert.equal(replay.data.idempotent_replay, true); assert.deepEqual(replay.data.resource, first.data.resource);
  const concurrent = await Promise.all([request(settings, { method: "PATCH", body: { enabled: false, expected_version: 2 } }), request(settings, { method: "PATCH", body: { enabled: true, expected_version: 2 } })]);
  assert.deepEqual(concurrent.map(item => item.status).sort(), [200, 409]);
  const before = (await request(settings)).data;
  await db.prepare("CREATE TRIGGER upgrade_settings_reject BEFORE INSERT ON events WHEN NEW.type='instance.upgrade-notification-settings-updated' BEGIN SELECT RAISE(ABORT,'audit failure'); END").run();
  try { assert.equal((await enable(true)).status, 503); assert.deepEqual((await request(settings)).data, before); }
  finally { await db.prepare("DROP TRIGGER upgrade_settings_reject").run(); }
});

test("关闭时不发布且原key恢复保持关闭结果；实际构建不符、同版与回退边界", async () => {
  await enable(false); const body = upgradeBody(), key = randomUUID(), before = await notifications();
  const first = await request(publish, { method: "POST", body, key }); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.resource.status, "disabled");
  await enable(true); const replay = await request(publish, { method: "POST", body, key }); assert.equal(replay.data.idempotent_replay, true); assert.deepEqual(replay.data.resource, first.data.resource);
  assert.equal(await notifications(), before);
  assert.equal((await request(publish, { method: "POST", body: upgradeBody({ release_version: "99.0.0" }) })).status, 400);
  for (const previous of [RELEASE_VERSION, "999.0.0"]) { const result = await request(publish, { method: "POST", body: upgradeBody({ previous_release_version: previous }) }); assert.equal(result.data.resource.status, "not_forward"); }
  assert.equal(await notifications(), before);
  assert.equal((await request(publish, { method: "POST", body: upgradeBody({ previous_release_version: "01.0.0" }) })).status, 400);
});

test("发布失败回滚公告/去重/审计；不同key并发及撤回后每发行只保留一份", async () => {
  await enable(true); const before = await notifications();
  await db.prepare("CREATE TRIGGER upgrade_publish_reject BEFORE INSERT ON events WHEN NEW.type='instance.upgrade-notification-evaluated' BEGIN SELECT RAISE(ABORT,'audit failure'); END").run();
  const body = upgradeBody(), key = randomUUID();
  try { assert.equal((await request(publish, { method: "POST", body, key })).status, 503); assert.equal(await notifications(), before); assert.equal(await db.prepare("SELECT 1 FROM upgrade_notification_releases").first(), null); }
  finally { await db.prepare("DROP TRIGGER upgrade_publish_reject").run(); }
  const results = await Promise.all([request(publish, { method: "POST", body, key }), request(publish, { method: "POST", body: upgradeBody() })]);
  assert.deepEqual(results.map(item => item.status), [200, 200]); assert.deepEqual(results.map(item => item.data.resource.status).sort(), ["already_published", "published"]);
  const notificationId = results[0].data.resource.notification_id; assert.equal(results[1].data.resource.notification_id, notificationId); assert.equal(await notifications(), before + 1);
  const readback = await request(`/api/v1/admin/notifications/upgrade-releases/${encodeURIComponent(RELEASE_VERSION)}`); assert.equal(readback.data.notification_id, notificationId);
  const notification = await db.prepare("SELECT * FROM instance_notifications WHERE id=?1").bind(notificationId).first();
  assert.ok(notification.body.includes(`站点已从 ${body.previous_release_version} 升级到 ${RELEASE_VERSION}。`));
  assert.ok(notification.body.includes(`The site has been upgraded from ${body.previous_release_version} to ${RELEASE_VERSION}.`));
  assert.ok(notification.body.includes(`https://github.com/breakstring/cfKanban/releases/tag/${RELEASE_VERSION}`));
  assert.ok(notification.body.includes("本次站点升级不会自动更新本地 cfKanban 插件和技能。"));
  assert.ok(notification.body.includes("This site upgrade does not automatically update your local cfKanban plugin and Skills."));
  const zhPrompt = notification.body.split("请把下面的语句复制给您的 Agent，用来更新本地插件和技能：\n")[1]?.split("\n")[0];
  const enPrompt = notification.body.split("Copy the following request to your Agent to update your local plugin and Skills:\n")[1]?.split("\n")[0];
  assert.equal(zhPrompt, `请以 ${RELEASE_VERSION} 为目标版本，使用 cfkanban-deploy 技能将本地 cfKanban 插件和技能更新到该版本。`);
  assert.equal(enPrompt, `Use the cfkanban-deploy skill to update my local cfKanban plugin and Skills to ${RELEASE_VERSION}.`);
  for (const prompt of [zhPrompt, enPrompt]) assert.doesNotMatch(prompt, /站点|线上|部署|deployment|https?:\/\/|\b(?:IP|DNS)\b/i);
  assert.doesNotMatch(notification.body, /cfkanban --version/);
  const personal = await request("/api/v1/me/notifications?pending=true", { actor: member }); assert.ok(personal.data.items.some(item => item.id === notificationId));
  await request("/api/v1/me/notification-preferences", { actor: member, method: "PATCH", body: { enabled: false, expected_version: 1 } });
  assert.deepEqual((await request("/api/v1/me/notifications?pending=true", { actor: member })).data.items, []);
  assert.ok((await request("/api/v1/me/notifications", { actor: member })).data.items.some(item => item.id === notificationId));
  assert.equal((await request(`/api/v1/admin/notifications/${notificationId}/commands/withdraw`, { method: "POST", body: { expected_version: 1 } })).status, 200);
  const retry = await request(publish, { method: "POST", body: upgradeBody() }); assert.equal(retry.data.resource.status, "already_published"); assert.equal(retry.data.resource.notification_id, notificationId); assert.equal(await notifications(), before + 1);
  await assert.rejects(db.prepare("DELETE FROM upgrade_notification_releases WHERE release_version=?1").bind(RELEASE_VERSION).run());
});

test("开关与通知在提交时重验Owner凭据，撤销竞态不留下业务写入或审计", async () => {
  const before = (await request(settings)).data, eventCount = (await db.prepare("SELECT COUNT(*) AS count FROM events").first()).count;
  let batches = 0;
  const racedDb = new Proxy(db, { get(target, property) {
    if(property === "batch") return async statements => { if(++batches === 2) await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), owner.credentialId).run(); return db.batch(statements); };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    const result = await request(settings, { method: "PATCH", body: { enabled: !before.enabled, expected_version: before.version }, overrideEnv: { ...env, DB: racedDb } });
    assert.equal(result.status, 401, JSON.stringify(result.data)); assert.equal(batches, 2);
  } finally { await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(owner.credentialId).run(); }
  assert.deepEqual((await request(settings)).data, before); assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM events").first()).count, eventCount);
  batches = 0;
  try {
    const result = await request(publish, { method: "POST", body: upgradeBody(), overrideEnv: { ...env, DB: racedDb } }); assert.equal(result.status, 401, JSON.stringify(result.data));
  } finally { await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(owner.credentialId).run(); }
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM events").first()).count, eventCount);
});
