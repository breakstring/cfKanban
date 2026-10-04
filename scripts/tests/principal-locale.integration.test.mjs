import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { authenticateRequest } from "../../apps/worker/src/kernel/auth.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { updateMe } from "../../apps/worker/src/services/identity.ts";

const server = createTestHarness({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});
const ownerId = crypto.randomUUID();
const ownerCredentialId = crypto.randomUUID();
const ownerToken = `cfk_v1_localeowner_${"A".repeat(43)}`;
const bearer = (token = ownerToken) => ({ authorization: `Bearer ${token}` });
let db;

async function request(path, { body, headers = bearer(), method = "GET" } = {}) {
  const response = await server.fetch(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const patch = (body, headers = bearer()) => request("/api/v1/me", { body, headers, method: "PATCH" });
const auditCount = async () => (await db.prepare("SELECT count(*) AS count FROM events WHERE subject_type='principal'").first()).count;
const latestAudit = async id => db.prepare("SELECT type,payload_json FROM events WHERE subject_id=?1 ORDER BY sequence DESC LIMIT 1").bind(id).first();

async function seedPrincipal(name) {
  const id = crypto.randomUUID(), credentialId = crypto.randomUUID();
  const prefix = id.replaceAll("-", "");
  const token = `cfk_v1_${prefix}_${"B".repeat(43)}`;
  await db.batch([
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?3,1,1)").bind(id, name, name.toLowerCase()),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,?3,?4,1,?5)")
      .bind(credentialId, id, prefix, await sha256Hex(token), crypto.randomUUID()),
  ]);
  return { id, credentialId, token };
}

before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, {
    instanceId: crypto.randomUUID(), operationId: crypto.randomUUID(),
    ownerPrincipalId: ownerId, ownerCredentialId, ownerCredentialToken: ownerToken,
    ownerDisplayName: "Locale_Owner", preferredApiOrigin: "https://kanban.example.test",
  });
});
after(async () => server.close());

test("语言默认无偏好，独立保存、与资料混合保存及显式清除都使用单次 Principal 更新", async () => {
  const initial = await request("/api/v1/me");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.locale, null);
  assert.equal(initial.body.theme, "orange");
  const count = await auditCount();
  const chinese = await patch({ locale: "zh-CN", expected_version: initial.body.version });
  assert.equal(chinese.status, 200, JSON.stringify(chinese.body));
  assert.equal(chinese.body.resource.locale, "zh-CN");
  assert.equal(chinese.body.resource.display_name, initial.body.display_name);
  assert.equal(chinese.body.resource.theme, initial.body.theme);
  assert.equal(chinese.body.resource.principal_id, ownerId);
  assert.equal(chinese.body.resource.version, initial.body.version + 1);
  assert.deepEqual(await latestAudit(ownerId), { type: "principal.profile-updated", payload_json: JSON.stringify({ locale: "zh-CN" }) });
  const mixed = await patch({ display_name: "Locale_Renamed", locale: "en", theme: "blue", expected_version: chinese.body.resource.version });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.equal(mixed.body.resource.locale, "en");
  assert.equal(mixed.body.resource.theme, "blue");
  assert.equal(mixed.body.resource.display_name, "Locale_Renamed");
  assert.deepEqual(JSON.parse((await latestAudit(ownerId)).payload_json), { display_name: "Locale_Renamed", locale: "en", theme: "blue" });
  const renamed = await patch({ display_name: "Locale_Updated", expected_version: mixed.body.resource.version });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.resource.locale, "en");
  assert.equal(renamed.body.resource.theme, "blue");
  assert.equal((await latestAudit(ownerId)).type, "principal.display-name-updated");
  const cleared = await patch({ locale: null, expected_version: renamed.body.resource.version });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.resource.locale, null);
  assert.equal(cleared.body.resource.theme, "blue");
  assert.deepEqual(await latestAudit(ownerId), { type: "principal.profile-updated", payload_json: JSON.stringify({ locale: null }) });
  assert.equal(await auditCount(), count + 4);
  assert.equal((await request("/api/v1/me")).body.locale, null);
});

test("非法语言、空修改、跨身份字段、名称冲突与过期 CAS 不产生部分修改或审计", async () => {
  const me = (await request("/api/v1/me")).body;
  const count = await auditCount();
  for (const input of [
    { locale: "zh" }, { locale: "zh-cn" }, { locale: "EN" }, { locale: "" },
    { locale: 1 }, { locale: true }, { locale: {} }, { locale: [] }, {},
    { locale: "en", theme: null }, { locale: "en", principal_id: crypto.randomUUID() },
  ]) assert.equal((await patch({ ...input, expected_version: me.version })).status, 400, JSON.stringify(input));
  await seedPrincipal("Locale_Reserved");
  const collision = await patch({ display_name: "Locale_Reserved", locale: "en", theme: "orange", expected_version: me.version });
  assert.equal(collision.status, 409);
  assert.equal(collision.body.code, "PRINCIPAL_DISPLAY_NAME_CONFLICT");
  const stale = await patch({ locale: "en", theme: "orange", expected_version: me.version - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "VERSION_CONFLICT");
  assert.equal(stale.body.details.current_version, me.version);
  assert.deepEqual((await request("/api/v1/me")).body, me);
  assert.equal(await auditCount(), count);
  assert.equal((await patch({ locale: "en", expected_version: me.version }, {})).status, 401);
});

test("无项目授权的参与者只保存本人的语言，不改变其他身份的偏好", async () => {
  const participant = await seedPrincipal("Locale_Participant");
  const owner = (await request("/api/v1/me")).body;
  const initial = await request("/api/v1/me", { headers: bearer(participant.token) });
  assert.equal(initial.body.locale, null);
  assert.deepEqual(initial.body.grants, []);
  const updated = await patch({ locale: "en", expected_version: 1 }, bearer(participant.token));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.resource.principal_id, participant.id);
  assert.equal((await request("/api/v1/me", { headers: bearer(participant.token) })).body.locale, "en");
  assert.deepEqual((await request("/api/v1/me")).body, owner);
});

test("并发语言修改共享 Principal CAS，只提交一次偏好与审计", async () => {
  const participant = await seedPrincipal("Locale_Concurrent");
  const count = await auditCount();
  const updates = await Promise.all(["en", "zh-CN"].map(locale => patch({ locale, expected_version: 1 }, bearer(participant.token))));
  assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
  assert.equal(await auditCount(), count + 1);
  const me = await request("/api/v1/me", { headers: bearer(participant.token) });
  assert.equal(me.body.version, 2);
  assert.equal(me.body.locale, updates.find(result => result.status === 200).body.resource.locale);
});

test("Cookie 语言写入要求同源与 CSRF，Session 读回最新语言和主题", async () => {
  const sessionToken = "S".repeat(43), csrf = "C".repeat(43);
  const now = Date.now();
  await db.prepare(`INSERT INTO web_sessions
    (id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES(?1,?2,?3,'credential',?4,'admin',?5,?6,?7)`)
    .bind(crypto.randomUUID(), await sha256Hex(sessionToken), ownerId, ownerCredentialId,
      JSON.stringify({ kind: "admin", section: "overview", entry_path: "/app/admin" }), now + 60_000, now).run();
  const cookies = { cookie: `cfkanban_session=${sessionToken}; cfkanban_csrf=${csrf}` };
  const current = await request("/api/v1/web-session", { headers: cookies });
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.equal(current.body.principal.locale, null);
  assert.equal(current.body.principal.theme, "blue");
  const body = { locale: "zh-CN", expected_version: current.body.principal.version };
  assert.equal((await patch(body, cookies)).status, 403);
  assert.equal((await patch(body, { ...cookies, origin: "https://evil.example", "x-csrf-token": csrf })).status, 403);
  const origin = (await request("/.well-known/cfkanban-instance.json")).body.observed_origin;
  assert.equal((await patch(body, { ...cookies, origin, "x-csrf-token": "M".repeat(43) })).status, 403);
  const saved = await patch(body, { ...cookies, origin, "x-csrf-token": csrf });
  assert.equal(saved.status, 200);
  const session = (await request("/api/v1/web-session", { headers: cookies })).body;
  assert.equal(session.principal.locale, "zh-CN");
  assert.equal(session.principal.theme, "blue");
  assert.equal(session.principal.version, saved.body.resource.version);
});

test("可选幂等键恢复丢失的原响应，保留后续偏好更新且重新核验身份", async () => {
  const participant = await seedPrincipal("Locale_Replay");
  const key = "locale-response-lost";
  const body = { locale: "zh-CN", theme: "blue", expected_version: 1 };
  const original = new Request("https://kanban.example.test/api/v1/me", {
    method: "PATCH", headers: { ...bearer(participant.token), "idempotency-key": key },
  });
  const auth = await authenticateRequest(db, original);
  let rejectedReadback = false;
  const failingDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql) => {
        if (!sql.startsWith("SELECT operation_snapshot_json")) return target.prepare(sql);
        return { bind: () => ({ first: async () => {
          rejectedReadback = true;
          throw new Error("Injected local readback failure after commit");
        } }) };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const count = await auditCount();
  await assert.rejects(updateMe(failingDb, original, auth, body, 1, Date.now()), error => error.status === 503);
  assert.equal(rejectedReadback, true);
  assert.equal((await request("/api/v1/me", { headers: bearer(participant.token) })).body.locale, "zh-CN");
  assert.equal((await patch({ locale: null, theme: "orange", expected_version: 2 }, bearer(participant.token))).status, 200);
  const replayHeaders = { ...bearer(participant.token), "idempotency-key": key };
  const replay = await patch(body, replayHeaders);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.resource.locale, "zh-CN");
  assert.equal(replay.body.resource.theme, "blue");
  assert.equal(replay.body.resource.version, 2);
  const latest = (await request("/api/v1/me", { headers: bearer(participant.token) })).body;
  assert.equal(latest.locale, null);
  assert.equal(latest.theme, "orange");
  assert.equal(await auditCount(), count + 2);
  assert.deepEqual((await patch(body, replayHeaders)).body, replay.body);
  const mismatch = await patch({ ...body, locale: "en" }, replayHeaders);
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, "IDEMPOTENCY_CONFLICT");
  await db.prepare("UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ownerId, participant.credentialId).run();
  assert.equal((await patch(body, replayHeaders)).status, 401);
  assert.equal(await auditCount(), count + 2);
});

test("鉴权后来源被撤销时，原子写入 guard 拒绝语言修改并保留 version", async () => {
  const participant = await seedPrincipal("Locale_Revoked");
  const original = new Request("https://kanban.example.test/api/v1/me", { method: "PATCH", headers: bearer(participant.token) });
  const auth = await authenticateRequest(db, original);
  const count = await auditCount();
  await db.prepare("UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ownerId, participant.credentialId).run();
  await assert.rejects(updateMe(db, original, auth, { locale: "en" }, 1, Date.now()), error => error.status === 401);
  assert.deepEqual(await db.prepare("SELECT locale,theme,version FROM principals WHERE id=?1").bind(participant.id).first(), { locale: null, theme: "orange", version: 1 });
  assert.equal(await auditCount(), count);
});
