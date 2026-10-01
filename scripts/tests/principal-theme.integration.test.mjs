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
const ownerToken = `cfk_v1_themeowner_${"A".repeat(43)}`;
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
    ownerDisplayName: "Theme_Owner", preferredApiOrigin: "https://kanban.example.test",
  });
});
after(async () => server.close());

test("个人主题默认 orange，主题与显示名称可以独立或同时原子修改", async () => {
  const me = await request("/api/v1/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.theme, "orange");
  const count = await auditCount();
  const blue = await patch({ theme: "blue", expected_version: me.body.version });
  assert.equal(blue.status, 200, JSON.stringify(blue.body));
  assert.equal(blue.body.resource.theme, "blue");
  assert.equal(blue.body.resource.display_name, me.body.display_name);
  assert.equal(blue.body.resource.principal_id, ownerId);
  assert.equal(blue.body.resource.version, me.body.version + 1);
  const themeAudit = await db.prepare("SELECT type,payload_json FROM events WHERE subject_id=?1 ORDER BY sequence DESC LIMIT 1").bind(ownerId).first();
  assert.deepEqual(themeAudit, { type: "principal.profile-updated", payload_json: JSON.stringify({ theme: "blue" }) });
  const renamed = await patch({ display_name: "Theme_Renamed", expected_version: blue.body.resource.version });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.resource.theme, "blue");
  assert.equal((await db.prepare("SELECT type FROM events WHERE subject_id=?1 ORDER BY sequence DESC LIMIT 1").bind(ownerId).first()).type, "principal.display-name-updated");
  const both = await patch({ display_name: "Theme_Updated", theme: "orange", expected_version: renamed.body.resource.version });
  assert.equal(both.status, 200);
  assert.equal(both.body.resource.theme, "orange");
  assert.equal(both.body.resource.display_name, "Theme_Updated");
  assert.equal(await auditCount(), count + 3);
  assert.equal((await request("/api/v1/me")).body.theme, "orange");
});

test("非法主题、空修改、跨身份字段、名称冲突和过期 CAS 不产生部分修改", async () => {
  const me = (await request("/api/v1/me")).body;
  const count = await auditCount();
  for (const input of [
    { theme: "dark" }, { theme: "BLUE" }, { theme: null }, { theme: 1 },
    {}, { theme: "blue", principal_id: crypto.randomUUID() },
  ]) {
    const rejected = await patch({ ...input, expected_version: me.version });
    assert.equal(rejected.status, 400, JSON.stringify(input));
  }
  const reserved = await seedPrincipal("Theme_Reserved");
  const collision = await patch({ display_name: "Theme_Reserved", theme: "blue", expected_version: me.version });
  assert.equal(collision.status, 409);
  assert.equal(collision.body.code, "PRINCIPAL_DISPLAY_NAME_CONFLICT");
  const stale = await patch({ theme: "blue", expected_version: me.version - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "VERSION_CONFLICT");
  assert.equal(stale.body.details.current_version, me.version);
  assert.deepEqual((await request("/api/v1/me")).body, me);
  assert.equal(await auditCount(), count);
  const participant = await patch({ theme: "blue", expected_version: 1 }, bearer(reserved.token));
  assert.equal(participant.status, 200);
  assert.equal(participant.body.resource.principal_id, reserved.id);
  assert.equal((await request("/api/v1/me")).body.theme, "orange");
  assert.equal((await patch({ theme: "blue", expected_version: me.version }, {})).status, 401);
});

test("两个并发主题修改只提交一个 CAS 与一个审计", async () => {
  const participant = await seedPrincipal("Theme_Concurrent");
  const count = await auditCount();
  const updates = await Promise.all(["orange", "blue"].map(theme => patch({ theme, expected_version: 1 }, bearer(participant.token))));
  assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
  assert.equal(await auditCount(), count + 1);
  const me = await request("/api/v1/me", { headers: bearer(participant.token) });
  assert.equal(me.body.version, 2);
  assert.equal(me.body.theme, updates.find(result => result.status === 200).body.resource.theme);
});

test("Cookie 个人主题写入要求同源与 CSRF，Session 读回最新 Principal 主题", async () => {
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
  assert.equal(current.body.principal.theme, "orange");
  const body = { theme: "blue", expected_version: current.body.principal.version };
  assert.equal((await patch(body, cookies)).status, 403);
  assert.equal((await patch(body, { ...cookies, origin: "https://evil.example", "x-csrf-token": csrf })).status, 403);
  const origin = (await request("/.well-known/cfkanban-instance.json")).body.observed_origin;
  assert.equal((await patch(body, { ...cookies, origin, "x-csrf-token": "M".repeat(43) })).status, 403);
  assert.equal((await patch(body, { ...cookies, origin, "x-csrf-token": csrf })).status, 200);
  assert.equal((await request("/api/v1/web-session", { headers: cookies })).body.principal.theme, "blue");
});

test("可选幂等键从提交后读回失败恢复原响应，不覆盖之后修改，并重新核验身份", async () => {
  const participant = await seedPrincipal("Theme_Replay");
  const key = "theme-response-lost";
  const body = { theme: "blue", expected_version: 1 };
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
  assert.equal((await request("/api/v1/me", { headers: bearer(participant.token) })).body.theme, "blue");
  const later = await patch({ theme: "orange", expected_version: 2 }, bearer(participant.token));
  assert.equal(later.status, 200);
  const replayHeaders = { ...bearer(participant.token), "idempotency-key": key };
  const replay = await patch(body, replayHeaders);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.resource.theme, "blue");
  assert.equal(replay.body.resource.version, 2);
  assert.equal((await request("/api/v1/me", { headers: bearer(participant.token) })).body.theme, "orange");
  assert.equal(await auditCount(), count + 2);
  assert.deepEqual((await patch(body, replayHeaders)).body, replay.body);
  const mismatch = await patch({ theme: "orange", expected_version: 1 }, replayHeaders);
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, "IDEMPOTENCY_CONFLICT");
  await db.prepare("UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ownerId, participant.credentialId).run();
  assert.equal((await patch(body, replayHeaders)).status, 401);
  assert.equal(await auditCount(), count + 2);
});
