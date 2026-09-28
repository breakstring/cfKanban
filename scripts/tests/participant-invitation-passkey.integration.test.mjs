import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertGenericApiPathIsNonSensitive } from "../../packages/skill-runtime/src/capability-delivery.mjs";
import { getInstancePaths, putInstanceMetadata } from "../../packages/skill-runtime/src/state.mjs";
import { trustedApiRequest } from "../../packages/skill-runtime/src/transport.mjs";
import { createTestHarness } from "wrangler";
import { authenticateRequest } from "../../apps/worker/src/kernel/auth.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { INVITATION_PAGE_SCRIPT, redeemInvitation } from "../../apps/worker/src/services/invitations.ts";
import { listMyPasskeys, revokeMyPasskey } from "../../apps/worker/src/services/passkeys.ts";

const origin = "https://kanban.example.test";
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const memberToken = `cfk_v1_member_${"B".repeat(43)}`;
const ids = Object.fromEntries(["instance", "owner", "ownerCredential", "member", "memberCredential", "workspace", "a", "b", "c"].map((key) => [key, crypto.randomUUID()]));
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
let db;
const bearer = (token = memberToken) => ({ authorization: `Bearer ${token}` });
async function request(path, { method = "GET", body, headers = {} } = {}) {
  const response = await server.getWorker().fetch(origin + path, {
    method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text() };
}
async function session(token = memberToken) {
  const launch = await request("/api/v1/web-launches", { method: "POST", headers: { ...bearer(token), "idempotency-key": crypto.randomUUID() }, body: { target: token === ownerToken ? { kind: "admin", section: "overview" } : { kind: "project", workspace_id: ids.workspace, project_id: ids.a } } });
  assert.equal(launch.response.status, 200, JSON.stringify(launch.body));
  const code = new URL(launch.body.resource.launch_url).searchParams.get("code");
  const redeemed = await request("/api/v1/web-sessions/redeem", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { launch_code: code } });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.body));
  const header = redeemed.response.headers.get("set-cookie");
  const tokenValue = /cfkanban_session=([^;,]+)/.exec(header)[1];
  const csrf = /cfkanban_csrf=([^;,]+)/.exec(header)[1];
  const cookie = `cfkanban_session=${tokenValue}; cfkanban_csrf=${csrf}`;
  const view = await request("/api/v1/web-session", { headers: { cookie } });
  return { id: view.body.session_id, cookie, headers: { cookie, origin, "x-csrf-token": csrf } };
}
async function invitation(projects = [ids.b], extra = {}) {
  const created = await request("/api/v1/admin/invitations", { method: "POST", headers: { ...bearer(ownerToken), "idempotency-key": crypto.randomUUID() }, body: { kind: "project_grant", grants: projects.map((project_id) => ({ project_id, role: "writer" })), ...extra } });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  return { id: created.body.resource.id, code: new URL(created.body.resource.invite_url).searchParams.get("code") };
}
async function effects(inviteId) {
  return db.prepare(`SELECT redeemed_at, (SELECT COUNT(*) FROM invitation_redemption_items WHERE invitation_id=?1) items FROM invitations WHERE id=?1`).bind(inviteId).first();
}
async function passkey(principal = ids.member) {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO web_authenticators (id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,created_operation_id)
    VALUES (?1,?2,?3,'test-public-key-material',-7,'test-user-handle',0,0,'kanban.example.test',?4,?5)`).bind(id, principal, crypto.randomUUID(), Date.now(), crypto.randomUUID()).run();
  return id;
}
function intercept(database, matches, action) {
  const raw = new WeakMap();
  const flagged = new WeakSet();
  let used = false;
  const wrap = (statement, flag) => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values) => wrap(target.bind(...values), flag);
      if (property === "first" && flag) return async (...values) => {
        if (!used) { used = true; await action(); }
        return target.first(...values);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    raw.set(proxy, statement);
    if (flag) flagged.add(proxy);
    return proxy;
  };
  return new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql) => wrap(target.prepare(sql), matches(sql));
    if (property === "batch") return async (statements) => {
      if (!used && statements.some((statement) => flagged.has(statement))) { used = true; await action(); }
      return target.batch(statements.map((statement) => raw.get(statement) ?? statement));
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  ({ DB: db } = await server.getWorker().getEnv());
  const now = Date.now();
  await bootstrapInstance(db, { instanceId: ids.instance, operationId: crypto.randomUUID(), ownerCredentialId: ids.ownerCredential, ownerCredentialToken: ownerToken, ownerDisplayName: "Deployment_Operator", ownerPrincipalId: ids.owner, preferredApiOrigin: origin });
  await db.batch([
    db.prepare("INSERT INTO principals (id,display_name,display_name_key,created_at,updated_at) VALUES (?1,'Member','member',?2,?2)").bind(ids.member, now),
    db.prepare("INSERT INTO credentials (id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,'member',?3,?4,?5)").bind(ids.memberCredential, ids.member, await sha256Hex(memberToken), now, crypto.randomUUID()),
    db.prepare("INSERT INTO workspaces (id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES (?1,'Workspace',?2,?2,?3,?3,?4)").bind(ids.workspace, now, ids.owner, crypto.randomUUID()),
    ...[ids.a, ids.b, ids.c].map((id, index) => db.prepare("INSERT INTO projects (id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES (?1,?2,?3,?4,?4,?5,?5,?6)").bind(id, ids.workspace, `Project ${index}`, now, ids.owner, crypto.randomUUID())),
    db.prepare("INSERT INTO project_grants (id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES (?1,?2,?3,'reader',?4,?4,?5)").bind(crypto.randomUUID(), ids.member, ids.a, now, crypto.randomUUID()),
  ]);
});
after(() => server.close());

test("Cookie ordinary invitation requires CSRF, retains identity/scope and replays once", async () => {
  const current = await session();
  const invite = await invitation([ids.a, ids.b]);
  const before = await db.prepare("SELECT * FROM web_sessions WHERE id=?1").bind(current.id).first();
  const counts = await db.prepare("SELECT (SELECT COUNT(*) FROM principals) principals,(SELECT COUNT(*) FROM credentials) credentials").first();
  const body = { invite_code: invite.code, redeem_as: "current_principal" };
  const key = crypto.randomUUID();
  const page = await request(`/invite?code=${invite.code}`);
  assert.equal(page.response.status, 200);
  assert.match(page.body, /id="invitation-accept"/);
  assert.match(page.response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal(page.body.includes(invite.code), false);
  assert.deepEqual(await effects(invite.id), { redeemed_at: null, items: 0 });
  for (const headers of [{ cookie: current.cookie }, { ...current.headers, origin: "https://evil.example" }]) {
    const rejected = await request("/api/v1/invitations/redeem", { method: "POST", body, headers: { ...headers, "idempotency-key": key } });
    assert.equal(rejected.response.status, 403);
    assert.deepEqual(await effects(invite.id), { redeemed_at: null, items: 0 });
  }
  const accepted = await request("/api/v1/invitations/redeem", { method: "POST", body, headers: { ...current.headers, "idempotency-key": key } });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.resource.principal.principal_id, ids.member);
  assert.deepEqual(await db.prepare("SELECT (SELECT COUNT(*) FROM principals) principals,(SELECT COUNT(*) FROM credentials) credentials").first(), counts);
  assert.deepEqual(await db.prepare("SELECT * FROM web_sessions WHERE id=?1").bind(current.id).first(), before);
  const grantA = await db.prepare("SELECT role FROM project_grants WHERE principal_id=?1 AND project_id=?2").bind(ids.member, ids.a).first();
  assert.equal(grantA.role, "reader");
  const replay = await request("/api/v1/invitations/redeem", { method: "POST", body, headers: { ...current.headers, "idempotency-key": key } });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal((await effects(invite.id)).items, 2);
  const persisted = await db.prepare("SELECT operation_snapshot_json,response_json FROM idempotency_records WHERE idempotency_key=?1").bind(await sha256Hex(key)).first();
  assert.equal(JSON.stringify(persisted).includes(invite.code), false);
});

test("Cookie rejects Owner, new identity, recovery, expired session and fixed-scope partial grants", async () => {
  const current = await session();
  const owner = await session(ownerToken);
  const invite = await invitation([ids.a, ids.c]);
  for (const [headers, redeem_as] of [[owner.headers, "current_principal"], [current.headers, "new_principal"]]) {
    const rejected = await request("/api/v1/invitations/redeem", { method: "POST", headers: { ...headers, "idempotency-key": crypto.randomUUID() }, body: { invite_code: invite.code, redeem_as } });
    assert.equal(rejected.response.status, 403);
  }
  const recovery = await request("/api/v1/admin/invitations", { method: "POST", headers: { ...bearer(ownerToken), "idempotency-key": crypto.randomUUID() }, body: { kind: "principal_recovery", principal_id: ids.member, recovery_mode: "full_recovery" } });
  assert.equal(recovery.response.status, 200);
  const rejectedRecovery = await request("/api/v1/invitations/redeem", { method: "POST", headers: { ...current.headers, "idempotency-key": crypto.randomUUID() }, body: { invite_code: new URL(recovery.body.resource.invite_url).searchParams.get("code"), redeem_as: "recovery" } });
  assert.equal(rejectedRecovery.response.status, 403);
  await db.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE id=?2").bind(JSON.stringify({ kind: "project", workspace_id: ids.workspace, project_id: ids.a, entry_path: `/app/w/${ids.workspace}/p/${ids.a}` }), current.id).run();
  const fixed = await request("/api/v1/invitations/redeem", { method: "POST", headers: { ...current.headers, "idempotency-key": crypto.randomUUID() }, body: { invite_code: invite.code, redeem_as: "current_principal" } });
  assert.equal(fixed.response.status, 403, JSON.stringify(fixed.body));
  assert.deepEqual(await effects(invite.id), { redeemed_at: null, items: 0 });
  assert.equal(await db.prepare("SELECT 1 FROM project_grants WHERE principal_id=?1 AND project_id=?2").bind(ids.member, ids.c).first(), null);
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2 WHERE id=?3").bind(Date.now() - 10000, Date.now() - 1000, current.id).run();
  const expired = await request("/api/v1/invitations/redeem", { method: "POST", headers: { ...current.headers, "idempotency-key": crypto.randomUUID() }, body: { invite_code: invite.code, redeem_as: "current_principal" } });
  assert.equal(expired.response.status, 401);
  assert.deepEqual(await effects(invite.id), { redeemed_at: null, items: 0 });
});

test("Cookie invitation detects source revoke inside its atomic transaction", async () => {
  const current = await session();
  const invite = await invitation([ids.c]);
  const req = new Request(origin + "/api/v1/invitations/redeem", { method: "POST", headers: { ...current.headers, "idempotency-key": crypto.randomUUID() } });
  const racedDb = intercept(db, (sql) => sql.includes("INSERT INTO project_grants"), () => db.prepare("UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ids.owner, ids.memberCredential).run());
  try {
    await assert.rejects(redeemInvitation(racedDb, req, invite.code, "current_principal", undefined, undefined, Date.now()), (error) => error.status === 401);
    assert.deepEqual(await effects(invite.id), { redeemed_at: null, items: 0 });
    assert.equal(await db.prepare("SELECT 1 FROM project_grants WHERE principal_id=?1 AND project_id=?2").bind(ids.member, ids.c).first(), null);
  } finally { await db.prepare("UPDATE credentials SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(ids.memberCredential).run(); }
});

test("Bearer self passkeys hide auth material, require idempotency and atomically revoke sources", async () => {
  const id = await passkey();
  const other = await passkey(ids.owner);
  const source = await session();
  await db.prepare("UPDATE web_sessions SET source_kind='web_authenticator',source_id=?1 WHERE id=?2").bind(id, source.id).run();
  const listed = await request("/api/v1/me/passkeys", { headers: bearer() });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.items.some((item) => item.id === other), false);
  assert.deepEqual(Object.keys(listed.body.items.find((item) => item.id === id)).sort(), ["algorithm", "backup_eligible", "backup_state", "created_at", "id", "last_used_at", "revoked_at", "rp_id", "transports", "version"].sort());
  const path = `/api/v1/me/passkeys/${id}?expected_version=1`;
  const missingKey = await request(path, { method: "DELETE", headers: bearer() });
  assert.equal(missingKey.body.code, "IDEMPOTENCY_KEY_REQUIRED");
  const wrongOwner = await request(`/api/v1/me/passkeys/${other}?expected_version=1`, { method: "DELETE", headers: { ...bearer(), "idempotency-key": crypto.randomUUID() } });
  assert.equal(wrongOwner.response.status, 404);
  const stale = await request(`/api/v1/me/passkeys/${id}?expected_version=2`, { method: "DELETE", headers: { ...bearer(), "idempotency-key": crypto.randomUUID() } });
  assert.equal(stale.response.status, 409);
  const key = crypto.randomUUID();
  const headers = { ...bearer(), "idempotency-key": key };
  const deleted = await request(path, { method: "DELETE", headers });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.resource.version, 2);
  assert.equal((await request("/api/v1/web-session", { headers: { cookie: source.cookie } })).response.status, 401);
  const replay = await request(path, { method: "DELETE", headers });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.idempotent_replay, true);
  const different = await request(`/api/v1/me/passkeys/${id}?expected_version=2`, { method: "DELETE", headers });
  assert.equal(different.body.code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM events WHERE subject_id=?1 AND type='passkey.revoked'").bind(id).first()).count, 1);
  assert.equal((await db.prepare("SELECT revoked_at FROM credentials WHERE id=?1").bind(ids.memberCredential).first()).revoked_at, null);
  const registration = await request("/api/v1/me/passkeys/registration-options", { method: "POST", body: {}, headers: bearer() });
  assert.equal(registration.response.status, 401);
});

test("Cookie passkey revoke preserves legacy behavior and key-based self-source revocation", async () => {
  for (const withKey of [false, true]) {
    const id = await passkey();
    const current = await session();
    await db.prepare("UPDATE web_sessions SET source_kind='web_authenticator',source_id=?1 WHERE id=?2").bind(id, current.id).run();
    const rejected = await request(`/api/v1/me/passkeys/${id}?expected_version=1`, { method: "DELETE", headers: { cookie: current.cookie, ...(withKey ? { "idempotency-key": crypto.randomUUID() } : {}) } });
    assert.equal(rejected.response.status, 403);
    const deleted = await request(`/api/v1/me/passkeys/${id}?expected_version=1`, { method: "DELETE", headers: { ...current.headers, ...(withKey ? { "idempotency-key": crypto.randomUUID() } : {}) } });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
    assert.match(deleted.response.headers.get("set-cookie"), /Max-Age=0/);
  }
});

test("Bearer passkey revoke recovers a committed operation after snapshot read failure", async () => {
  const id = await passkey();
  const req = new Request(origin + `/api/v1/me/passkeys/${id}?expected_version=1`, { method: "DELETE", headers: { ...bearer(), "idempotency-key": crypto.randomUUID() } });
  const auth = await authenticateRequest(db, req);
  const broken = intercept(db, (sql) => sql.includes("SELECT operation_snapshot_json FROM idempotency_records"), () => { throw new Error("injected snapshot read loss"); });
  await assert.rejects(revokeMyPasskey(broken, auth, id, 1, Date.now(), req));
  const resumed = await revokeMyPasskey(db, auth, id, 1, Date.now(), req);
  assert.equal(resumed.idempotent_replay, true);
  assert.equal(resumed.resource.version, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM events WHERE subject_id=?1 AND type='passkey.revoked'").bind(id).first()).count, 1);
});


test("Passkey list and revoke reject Credential revocation between authentication and database work", async () => {
  const id = await passkey();
  const req = new Request(origin + `/api/v1/me/passkeys/${id}?expected_version=1`, { method: "DELETE", headers: { ...bearer(), "idempotency-key": crypto.randomUUID() } });
  const auth = await authenticateRequest(db, req);
  const revokeCredential = () => db.prepare("UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ids.owner, ids.memberCredential).run();
  const restore = () => db.prepare("UPDATE credentials SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(ids.memberCredential).run();
  try {
    const raced = intercept(db, (sql) => sql.includes("UPDATE web_authenticators AS authenticator"), revokeCredential);
    await assert.rejects(revokeMyPasskey(raced, auth, id, 1, Date.now(), req), (error) => error.status === 401);
    assert.equal((await db.prepare("SELECT revoked_at FROM web_authenticators WHERE id=?1").bind(id).first()).revoked_at, null);
    assert.equal((await db.prepare("SELECT COUNT(*) count FROM events WHERE subject_id=?1 AND type='passkey.revoked'").bind(id).first()).count, 0);
    await assert.rejects(listMyPasskeys(db, auth, Date.now()), (error) => error.status === 401);
  } finally { await restore(); }
});

test("Invitation page does not auto-consume or persist code and retries one in-memory request", async () => {
  const calls = [];
  const stored = [];
  const handlers = {};
  const elements = Object.fromEntries(["invitation-status", "invitation-accept", "invitation-next"].map((id) => [id, { hidden: false, addEventListener: (name, handler) => { handlers[id + name] = handler; } }]));
  elements["cfkanban-invitation-metadata"] = { textContent: JSON.stringify({ kind: "project_grant", invitation_id: "page-invitation", grants: [{ project_id: ids.a, workspace_id: ids.workspace, role: "writer" }] }) };
  const current = { principal: { id: ids.member, display_name: "Member", is_owner: false }, session_id: crypto.randomUUID() };
  let posts = 0;
  let cleaned;
  runInNewContext(INVITATION_PAGE_SCRIPT, {
    URL, AbortSignal, crypto,
    location: { href: origin + "/invite?code=test-page-capability" },
    history: { replaceState: (_state, _title, url) => { cleaned = url; } },
    localStorage: { getItem: () => "zh-CN", setItem: (key, value) => stored.push([key, value]) },
    document: { documentElement: { lang: "en" }, title: "Invitation", cookie: "cfkanban_csrf=" + "X".repeat(43), getElementById: (id) => elements[id], querySelectorAll: () => [] },
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (path === "/api/v1/web-session") return { ok: true, json: async () => current };
      posts += 1;
      if (posts === 1) throw new Error("response lost");
      if (posts === 2) return { ok: true, json: async () => ({ resource: { status: "redeemed" } }) };
      return { ok: true, json: async () => ({ resource: { id: "page-invitation", kind: "project_grant", status: "redeemed", redeemed_at: new Date().toISOString(), revoked_at: null, credential: null, redeemed_by_principal_id: ids.member, principal: { principal_id: ids.member }, grants: [{ project_id: ids.a, workspace_id: ids.workspace, role: "writer" }], results: [{ project_id: ids.a, outcome: "created", effective_role: "writer" }] } }) };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, "/invite");
  assert.equal(posts, 0);
  assert.equal(elements["invitation-accept"].hidden, false);
  assert.match(elements["invitation-status"].textContent, /Member/);
  await handlers["invitation-acceptclick"]();
  assert.match(elements["invitation-status"].textContent, /结果尚未确认/);
  await handlers["invitation-acceptclick"]();
  assert.match(elements["invitation-status"].textContent, /结果尚未确认/);
  assert.equal(elements["invitation-next"].hidden, true);
  await handlers["invitation-acceptclick"]();
  const requests = calls.filter((call) => call.path === "/api/v1/invitations/redeem");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.body, requests[1].options.body);
  assert.equal(requests[0].options.headers["idempotency-key"], requests[1].options.headers["idempotency-key"]);
  assert.deepEqual(stored, [["cfkanban_locale", "zh-CN"]]);
  assert.equal(elements["invitation-next"].hidden, false);
});

async function invitationPageRecoveryFixture() {
  const current = { principal: { id: ids.member, display_name: "Member", is_owner: false }, session_id: crypto.randomUUID() };
  const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
  let sessionResponse = response(200, current);
  const posts = [];
  const stored = [];
  const handlers = {};
  const elements = Object.fromEntries(["invitation-status", "invitation-accept", "invitation-next"].map((id) => [id, { hidden: false, addEventListener: (name, handler) => { handlers[id + name] = handler; } }]));
  const grants = [{ project_id: ids.a, workspace_id: ids.workspace, role: "writer" }];
  elements["cfkanban-invitation-metadata"] = { textContent: JSON.stringify({ kind: "project_grant", invitation_id: "recovery-invitation", grants }) };
  runInNewContext(INVITATION_PAGE_SCRIPT, {
    URL, AbortSignal, crypto,
    location: { href: origin + "/invite?code=test-recovery-capability" },
    history: { replaceState: () => {} },
    localStorage: { getItem: () => "zh-CN", setItem: (key, value) => stored.push([key, value]) },
    document: { documentElement: { lang: "en" }, title: "Invitation", cookie: "cfkanban_csrf=" + "X".repeat(43), getElementById: (id) => elements[id], querySelectorAll: () => [] },
    fetch: async (path, options) => {
      if (path === "/api/v1/web-session") return sessionResponse;
      posts.push(options);
      if (posts.length === 1) throw new Error("injected unknown POST result");
      return response(200, { resource: { id: "recovery-invitation", kind: "project_grant", status: "redeemed", redeemed_at: new Date().toISOString(), revoked_at: null, credential: null, redeemed_by_principal_id: ids.member, principal: { principal_id: ids.member }, grants, results: [{ project_id: ids.a, outcome: "created", effective_role: "writer" }] } });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { current, response, posts, stored, elements, click: () => handlers["invitation-acceptclick"](), setSessionResponse: (value) => { sessionResponse = value; } };
}

test("邀请原请求在会话 503、429 或畸形成功响应后仍可安全重试", async () => {
  const page = await invitationPageRecoveryFixture();
  await page.click();
  assert.equal(page.posts.length, 1);
  const original = { body: page.posts[0].body, key: page.posts[0].headers["idempotency-key"] };
  for (const result of [
    page.response(503, {}),
    page.response(429, {}),
    page.response(200, {}),
    page.response(200, { principal: page.current.principal }),
    page.response(200, { ...page.current, session_id: "malformed-session-id" }),
    { status: 200, ok: true, json: async () => { throw new Error("invalid JSON"); } },
  ]) {
    page.setSessionResponse(result);
    await page.click();
    assert.equal(page.posts.length, 1);
    assert.match(page.elements["invitation-status"].textContent, /结果尚未确认/);
    assert.equal(page.elements["invitation-accept"].hidden, false);
    assert.equal(page.elements["invitation-accept"].disabled, false);
    assert.equal(page.elements["invitation-next"].hidden, true);
  }
  page.setSessionResponse(page.response(200, page.current));
  await page.click();
  assert.equal(page.posts.length, 2);
  assert.equal(page.posts[1].body, original.body);
  assert.equal(page.posts[1].headers["idempotency-key"], original.key);
  assert.match(page.elements["invitation-status"].textContent, /已接受邀请/);
  assert.equal(page.elements["invitation-next"].hidden, false);
  assert.deepEqual(page.stored, [["cfkanban_locale", "zh-CN"]]);
});

test("邀请恢复在明确 401 或已核实身份与会话变化时停止", async () => {
  for (const kind of ["unauthenticated", "principal_changed", "session_changed"]) {
    const page = await invitationPageRecoveryFixture();
    await page.click();
    const rejected = kind === "unauthenticated" ? page.response(401, {})
      : page.response(200, kind === "principal_changed"
        ? { ...page.current, principal: { ...page.current.principal, id: ids.owner, is_owner: true } }
        : { ...page.current, session_id: crypto.randomUUID() });
    page.setSessionResponse(rejected);
    await page.click();
    assert.equal(page.posts.length, 1);
    assert.match(page.elements["invitation-status"].textContent, kind === "unauthenticated" ? /当前登录已失效/ : /当前登录身份已变化/);
    assert.equal(page.elements["invitation-accept"].hidden, true);
    assert.equal(page.elements["invitation-next"].hidden, true);
    page.setSessionResponse(page.response(200, page.current));
    await page.click();
    assert.equal(page.posts.length, 1);
    assert.deepEqual(page.stored, [["cfkanban_locale", "zh-CN"]]);
  }
});

test("Invitation checks live scope for already-authorized outcomes after Session scope narrows", async () => {
  for (const initialKind of ["project_selection", "workspace"]) {
    const current = await session();
    if (initialKind === "workspace") {
      await db.prepare("UPDATE web_sessions SET target_kind='workspace',target_json=?1 WHERE id=?2").bind(JSON.stringify({ kind: "workspace", workspace_id: ids.workspace, entry_path: `/app/manage?workspace=${ids.workspace}` }), current.id).run();
    }
    const invite = await invitation([ids.a, ids.b]);
    const req = new Request(origin + "/api/v1/invitations/redeem", { method: "POST", headers: { ...current.headers, "idempotency-key": crypto.randomUUID() } });
    const narrowed = intercept(db, (sql) => sql.includes("INSERT INTO project_grants"), () => db.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE id=?2").bind(JSON.stringify({ kind: "project", workspace_id: ids.workspace, project_id: ids.a, entry_path: `/app/w/${ids.workspace}/p/${ids.a}` }), current.id).run());
    await assert.rejects(redeemInvitation(narrowed, req, invite.code, "current_principal", undefined, undefined, Date.now()), (error) => error.status === 403);
    assert.deepEqual(await effects(invite.id), { redeemed_at: null, items: 0 });
  }
});

test("Committed passkey and Cookie invitation replays recheck authentication after claim I/O", async () => {
  const revokeCredential = () => db.prepare("UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ids.owner, ids.memberCredential).run();
  const restore = () => db.prepare("UPDATE credentials SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(ids.memberCredential).run();
  const id = await passkey();
  const key = crypto.randomUUID();
  const req = new Request(origin + `/api/v1/me/passkeys/${id}?expected_version=1`, { method: "DELETE", headers: { ...bearer(), "idempotency-key": key } });
  const auth = await authenticateRequest(db, req);
  await revokeMyPasskey(db, auth, id, 1, Date.now(), req);
  try {
    const raced = intercept(db, (sql) => sql.includes("SELECT request_hash, operation_id, state"), revokeCredential);
    await assert.rejects(revokeMyPasskey(raced, auth, id, 1, Date.now(), req), (error) => error.status === 401);
  } finally { await restore(); }
  const current = await session();
  const invite = await invitation([ids.a]);
  const invitationRequest = new Request(origin + "/api/v1/invitations/redeem", { method: "POST", headers: { ...current.headers, "idempotency-key": crypto.randomUUID() } });
  await redeemInvitation(db, invitationRequest, invite.code, "current_principal", undefined, undefined, Date.now());
  try {
    const raced = intercept(db, (sql) => sql.includes("SELECT request_hash, operation_id, state"), revokeCredential);
    await assert.rejects(redeemInvitation(raced, invitationRequest, invite.code, "current_principal", undefined, undefined, Date.now()), (error) => error.status === 401);
  } finally { await restore(); }
});


test("源 Skill runtime 经可信同源传输完成本人 Passkey 管理和 Owner 设备改名读回", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban-runtime-worker-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, ".cfkanban");
  // 只保存合成实例的非秘密 metadata；测试凭据仅复用内存 fixture，不写入任何本地槽位。
  await putInstanceMetadata({ stateRoot, home, persistenceConfirmed: true, instanceId: ids.instance, trustedApiOrigin: origin, originVersion: 1 });
  const call = (input, authorizationToken = memberToken) => {
    assertGenericApiPathIsNonSensitive(input);
    return trustedApiRequest({ ...input, stateRoot, instanceId: ids.instance, authorizationToken, fetchImpl: (url, options) => {
      assert.equal(new URL(url).origin, origin);
      assert.equal(options.redirect, "manual");
      return server.getWorker().fetch(url.toString(), options);
    } });
  };
  const id = await passkey();
  const listed = await call({ apiPath: "/api/v1/me/passkeys" });
  assert.equal(listed.ok, true);
  const summary = listed.data.items.find((item) => item.id === id);
  assert.equal(summary.version, 1);
  for (const field of ["credential_id", "public_key_cose", "user_handle"]) assert.equal(field in summary, false);
  const apiPath = `/api/v1/me/passkeys/${id}?expected_version=${summary.version}`;
  const missingKey = await call({ apiPath, method: "DELETE" });
  assert.equal(missingKey.ok, false);
  assert.equal(missingKey.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(missingKey.error.source, "service");
  const revokeInput = { apiPath, method: "DELETE", idempotencyKey: crypto.randomUUID() };
  const revoked = await call(revokeInput);
  assert.equal(revoked.ok, true);
  assert.equal(revoked.data.resource.id, id);
  const replay = await call(revokeInput);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.idempotent_replay, true);
  const readback = await call({ apiPath: "/api/v1/me/passkeys" });
  const observed = readback.data.items.find((item) => item.id === id);
  assert.equal(observed.version, 2);
  assert.equal(typeof observed.revoked_at, "string");

  const me = await call({ apiPath: "/api/v1/me" }, ownerToken);
  assert.equal(me.ok, true);
  const renamed = await call({ apiPath: `/api/v1/admin/owner-credentials/${ids.ownerCredential}/rename`, method: "POST", idempotencyKey: crypto.randomUUID(), body: { device_name: "Skill 验收设备", expected_version: me.data.version } }, ownerToken);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.data.resource.device_name, "Skill 验收设备");
  const devices = await call({ apiPath: `/api/v1/admin/principals/${ids.owner}/credentials` }, ownerToken);
  assert.equal(devices.ok, true);
  assert.equal(devices.data.items.find((item) => item.id === ids.ownerCredential).device_name, "Skill 验收设备");
  const paths = getInstancePaths({ stateRoot, instanceId: ids.instance });
  assert.deepEqual(await readdir(paths.credentialsRoot), []);
});
