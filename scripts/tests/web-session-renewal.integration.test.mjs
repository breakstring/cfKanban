import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { principalUserHandle } from "../../apps/worker/src/kernel/webauthn.ts";
import { authenticateCookieSession } from "../../apps/worker/src/kernel/auth.ts";
import { getWebSession } from "../../apps/worker/src/services/web-auth.ts";
import { webSessionCleanupStatement } from "../../apps/worker/src/services/web-state.ts";
import { createRegistrationFixture, createAssertionCredential } from "./webauthn-fixtures.mjs";

// 隔离 Wrangler 本地 D1；身份、Credential 与 WebAuthn 密钥均为本测试合成材料。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker(), origin = "https://renewal.example.test", rpId = "renewal.example.test";
const HOUR = 3600000, HALF_HOUR = HOUR / 2, WEEK = 7 * 24 * HOUR;
const ids = Object.fromEntries(["instance", "owner", "ownerCredential", "member", "memberCredential"].map(key => [key, randomUUID()]));
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`, memberToken = `cfk_v1_member_${"B".repeat(43)}`;
const hash = value => createHash("sha256").update(value).digest("hex");
let env, db, workspace, project;
const bearer = token => ({ authorization: `Bearer ${token}` });
async function request(path, { method = "GET", body, headers = {}, key, overrideEnv = env } = {}) {
  const response = await fetchWorker(new Request(origin + path, { method, headers: { ...headers,
    ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key === undefined ? {} : { "idempotency-key": key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), overrideEnv);
  return { response, status: response.status, data: await response.json() };
}
function cookies(response) {
  const header = response.headers.get("set-cookie") ?? "";
  const session = /cfkanban_session=([^;,]+)/.exec(header)?.[1], csrf = /cfkanban_csrf=([^;,]+)/.exec(header)?.[1];
  assert.ok(session); assert.ok(csrf);
  return { session, csrf, cookie: `cfkanban_session=${session}; cfkanban_csrf=${csrf}` };
}
function writeHeaders(session) { return { cookie: session.cookie, origin, "x-csrf-token": session.csrf }; }
const view = session => request("/api/v1/web-session", { headers: { cookie: session.cookie } });
const renew = (session, version, extra = {}) => request("/api/v1/web-session/renew", { method: "POST", body: { expected_version: version }, headers: writeHeaders(session), key: randomUUID(), ...extra });
async function launchSession(token = memberToken, target) {
  const launch = await request("/api/v1/web-launches", { method: "POST", body: { target: target ?? (token === ownerToken ? { kind: "admin", section: "overview" } : { kind: "project", workspace_id: workspace.id, project_id: project.id }) }, headers: bearer(token), key: randomUUID() });
  assert.equal(launch.status, 200, JSON.stringify(launch.data));
  const redeemed = await request("/api/v1/web-sessions/redeem", { method: "POST", body: { launch_code: new URL(launch.data.resource.launch_url).searchParams.get("code") }, key: randomUUID() });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
  return { ...cookies(redeemed.response), id: redeemed.data.resource.session_id, initial: redeemed.data.resource, response: redeemed.response };
}
async function passkeySession() {
  const registrationSession = await launchSession();
  const options = await request("/api/v1/me/passkeys/registration-options", { method: "POST", body: {}, headers: writeHeaders(registrationSession) });
  assert.equal(options.status, 200, JSON.stringify(options.data));
  const fixture = await createRegistrationFixture({ algorithm: -7, challenge: options.data.public_key.challenge, origin, rpId });
  const registered = await request("/api/v1/me/passkeys", { method: "POST", body: { challenge_id: options.data.challenge_id, credential: fixture.registrationCredential }, headers: writeHeaders(registrationSession), key: randomUUID() });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  const authOptions = await request("/api/v1/web-authentication/options", { method: "POST", body: {} });
  assert.equal(authOptions.status, 200);
  const assertion = await createAssertionCredential({ algorithm: -7, challenge: authOptions.data.public_key.challenge,
    credentialId: fixture.credentialId, privateKey: fixture.privateKey, origin, rpId, signCount: 1, userHandle: principalUserHandle(ids.member) });
  const verified = await request("/api/v1/web-authentication/verify", { method: "POST", body: { challenge_id: authOptions.data.challenge_id, credential: assertion }, key: randomUUID() });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return { ...cookies(verified.response), id: verified.data.resource.session_id, passkeyId: registered.data.resource.id, response: verified.response };
}
async function eligible(session, { age = HALF_HOUR + 10000 } = {}) {
  const createdAt = Date.now() - age;
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2,last_seen_at=NULL WHERE id=?3").bind(createdAt, createdAt + 8 * HOUR, session.id).run();
  return row(session);
}
const row = session => db.prepare("SELECT * FROM web_sessions WHERE id=?1").bind(session.id).first();
const auditCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='web-session.renewed'").first()).n;
function interceptBatch(database, match, action) {
  const raw = new WeakMap(), flagged = new WeakSet(); let used = false;
  const wrap = (statement, marked) => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values) => wrap(target.bind(...values), marked);
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    raw.set(proxy, statement); if (marked) flagged.add(proxy); return proxy;
  };
  return new Proxy(database, { get(target, property) {
    if (property === "prepare") return sql => wrap(target.prepare(sql), match(sql));
    if (property === "batch") return async statements => {
      const selected = statements.some(statement => flagged.has(statement));
      if (selected && !used) { used = true; return action(() => target.batch(statements.map(statement => raw.get(statement) ?? statement))); }
      return target.batch(statements.map(statement => raw.get(statement) ?? statement));
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
function responseBarrier() {
  let entered, released;
  const started = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { released = resolve; });
  return {
    async wait() {
      let timer;
      try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("response barrier was not reached")), 5000); })]); }
      finally { clearTimeout(timer); }
    },
    release: () => released(),
    async hold(value) { entered(); await resume; return value; },
  };
}
function interceptFirst(database, match, action) {
  let used = false;
  return new Proxy(database, { get(target, property) {
    if (property === "prepare") return sql => {
      const statement = target.prepare(sql);
      if (!match(sql)) return statement;
      const wrap = statement => new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...values) => wrap(target.bind(...values));
        if (property === "first") return async (...values) => {
          const result = await target.first(...values);
          if (used) return result;
          used = true; return action(result);
        };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      return wrap(statement);
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
function browserCookieJar(now = Date.now) {
  const values = new Map();
  return {
    accept(response) {
      for (const cookie of response.headers.getSetCookie()) {
        const parsed = /^(cfkanban_session|cfkanban_csrf)=([^;]*)/.exec(cookie);
        if (parsed === null) continue;
        if (/; Max-Age=0(?:;|$)/.test(cookie)) values.delete(parsed[1]);
        else values.set(parsed[1], { value: parsed[2], expiresAt: now() + Number(/; Max-Age=(\d+)(?:;|$)/.exec(cookie)?.[1]) * 1000 });
      }
    },
    get cookie() { return [...values].filter(([, entry]) => entry.expiresAt > now()).map(([name, entry]) => `${name}=${entry.value}`).join("; "); },
  };
}

before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); env = await worker.getEnv(); db = env.DB;
  await bootstrapInstance(db, { instanceId: ids.instance, operationId: randomUUID(), ownerPrincipalId: ids.owner, ownerCredentialId: ids.ownerCredential, ownerCredentialToken: ownerToken, ownerDisplayName: "Renewal_Owner", preferredApiOrigin: origin, schemaVersion: 17 });
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'Renewal_Member','renewal_member',?2,?2)").bind(ids.member, now),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'member',?3,?4,?5)").bind(ids.memberCredential, ids.member, hash(memberToken), now, randomUUID()),
  ]);
  workspace = (await request("/api/v1/workspaces", { method: "POST", body: { display_name: "Renewal" }, headers: bearer(ownerToken), key: randomUUID() })).data.resource;
  project = (await request(`/api/v1/workspaces/${workspace.id}/projects`, { method: "POST", body: { display_name: "Renewal" }, headers: bearer(ownerToken), key: randomUUID() })).data.resource;
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'writer',?4,?4,?5)").bind(randomUUID(), ids.member, project.id, now, randomUUID()).run();
});
after(() => server.close());

test("新旧 Credential 与真实 Passkey 来源 Session 同用续期政策，GET 不写入且返回当前版本和期限", async () => {
  for (const session of [await launchSession(), await passkeySession()]) {
    const before = await row(session), viewed = await view(session);
    assert.equal(viewed.status, 200, JSON.stringify(viewed.data)); assert.equal(viewed.data.version, 1);
    assert.equal(Date.parse(viewed.data.expires_at) - before.created_at, 8 * HOUR);
    const cookieMaxAge = Number(/Max-Age=(\d+)/.exec(session.response.headers.get("set-cookie"))[1]);
    assert.ok(cookieMaxAge > WEEK / 1000 - 10 && cookieMaxAge <= WEEK / 1000);
    assert.equal(Date.parse(viewed.data.renewal.renew_after) - before.created_at, HALF_HOUR);
    assert.equal(Date.parse(viewed.data.renewal.absolute_expires_at) - before.created_at, WEEK);
    assert.deepEqual(await row(session), before);
    const aged = await eligible(session), renewed = await renew(session, 1);
    assert.equal(renewed.status, 200, JSON.stringify(renewed.data)); assert.equal(renewed.data.resource.renewed, true);
    const after = await row(session); assert.equal(after.version, 2); assert.ok(after.expires_at > aged.expires_at); assert.ok(after.last_seen_at);
    for (const field of ["id", "token_digest", "principal_id", "source_kind", "source_id", "target_kind", "target_json", "created_at", "created_operation_id"]) assert.equal(after[field], aged[field], field);
    const staleAuth = await authenticateCookieSession(db, new Request(origin, { headers: { cookie: session.cookie } }));
    await db.prepare("UPDATE web_sessions SET expires_at=expires_at+1000,version=version+1 WHERE id=?1").bind(session.id).run();
    const currentView = await getWebSession(db, staleAuth, Date.now());
    assert.equal(currentView.version, 3); assert.equal(Date.parse(currentView.expires_at), after.expires_at + 1000);
  }
});

test("30 分钟实际续期节流返回冻结 noop，不修改 version/last_seen/期限或续期审计", async () => {
  const session = await launchSession(), before = await row(session), count = await auditCount(), key = randomUUID();
  const noop = await renew(session, 1, { key }); assert.equal(noop.status, 200, JSON.stringify(noop.data)); assert.equal(noop.data.resource.renewed, false);
  assert.deepEqual(await row(session), before); assert.equal(await auditCount(), count);
  await eligible(session);
  const changed = await renew(session, 1); assert.equal(changed.data.resource.renewed, true);
  const replay = await renew(session, 1, { key }); assert.equal(replay.data.idempotent_replay, true); assert.deepEqual(replay.data.resource, noop.data.resource);
  const after = await row(session), second = await renew(session, 2); assert.equal(second.data.resource.renewed, false);
  assert.deepEqual(await row(session), after); assert.equal(await auditCount(), count + 1);
  assert.equal((await renew(session, 1)).data.code, "VERSION_CONFLICT");
});

test("续期期限不超过原创建七天；已处于绝对上限时 noop，绝对截止后不能复活", async () => {
  const session = await launchSession(), now = Date.now(), createdAt = now - WEEK + 2 * HOUR;
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2,last_seen_at=?3 WHERE id=?4").bind(createdAt, now + HOUR, now - HALF_HOUR - 1000, session.id).run();
  const changed = await renew(session, 1); assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(changed.data.resource.renewed, true);
  assert.equal(Date.parse(changed.data.resource.expires_at), createdAt + WEEK);
  await db.prepare("UPDATE web_sessions SET last_seen_at=?1 WHERE id=?2").bind(now - HALF_HOUR - 1000, session.id).run();
  const count = await auditCount(), noop = await renew(session, 2); assert.equal(noop.status, 200); assert.equal(noop.data.resource.renewed, false); assert.equal(await auditCount(), count);
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2 WHERE id=?3").bind(now - WEEK - 1, now + HOUR, session.id).run();
  const expired = await renew(session, 2); assert.equal(expired.status, 401); assert.equal(expired.response.headers.get("set-cookie"), null);
});

test("续期 Cookie-only、CSRF 与幂等校验拒绝 Bearer/跨源/未知输入；所有响应不写 Cookie", async () => {
  const session = await launchSession(); await eligible(session);
  for (const headers of [bearer(memberToken), { ...writeHeaders(session), ...bearer(memberToken) }, { cookie: session.cookie }, { ...writeHeaders(session), origin: "https://attacker.example.test" }, { ...writeHeaders(session), "x-csrf-token": "X".repeat(43) }]) {
    const rejected = await renew(session, 1, { headers }); assert.ok(rejected.status >= 400); assert.equal(rejected.response.headers.get("set-cookie"), null);
  }
  assert.equal((await renew(session, 1, { key: undefined })).status, 400);
  assert.equal((await renew(session, 1, { body: { expected_version: 1, scope: "admin" } })).status, 400);
  const result = await renew(session, 1); assert.equal(result.status, 200);
  assert.equal(result.response.headers.get("set-cookie"), null);
  const header = session.response.headers.get("set-cookie");
  assert.match(header, /HttpOnly; Secure; SameSite=Strict; Path=\//); assert.match(header, /cfkanban_csrf=[^;]+; Secure; SameSite=Strict/);
  assert.ok(!JSON.stringify(result.data).includes(session.session)); assert.ok(!JSON.stringify(result.data).includes(session.csrf));
});

test("过期、来源 Credential/Passkey 撤销与退出阻止续期和原键重放", async () => {
  const expired = await launchSession();
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2 WHERE id=?3").bind(Date.now() - HOUR, Date.now() - 1000, expired.id).run();
  assert.equal((await renew(expired, 1)).status, 401);
  const source = await launchSession(); await eligible(source);
  const key = randomUUID(); assert.equal((await renew(source, 1, { key })).status, 200);
  await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), ids.memberCredential).run();
  try { assert.equal((await renew(source, 1, { key })).status, 401); }
  finally { await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(ids.memberCredential).run(); }
  const passkey = await passkeySession(); await eligible(passkey);
  assert.equal((await request(`/api/v1/me/passkeys/${passkey.passkeyId}?expected_version=2`, { method: "DELETE", headers: bearer(memberToken), key: randomUUID() })).status, 200);
  assert.equal((await renew(passkey, 1)).status, 401);
  const loggedOut = await launchSession(); await eligible(loggedOut);
  assert.equal((await request("/api/v1/web-session", { method: "DELETE", headers: writeHeaders(loggedOut) })).status, 200);
  assert.equal((await renew(loggedOut, 1)).status, 401);
});

test("续期保持 Owner 窄 scope 和既有固定项目；权限撤销/归档不允许跨 scope 续期", async () => {
  const owner = await launchSession(ownerToken, { kind: "project", workspace_id: workspace.id, project_id: project.id }); await eligible(owner);
  const ownerBefore = await row(owner), result = await renew(owner, 1); assert.equal(result.status, 200);
  assert.equal((await row(owner)).target_json, ownerBefore.target_json); assert.equal((await view(owner)).data.allowed_scope.kind, "project");
  const fixed = await launchSession();
  await db.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE id=?2").bind(JSON.stringify({ kind: "project", workspace_id: workspace.id, project_id: project.id, entry_path: `/app/w/${workspace.id}/p/${project.id}` }), fixed.id).run();
  await eligible(fixed); const before = await row(fixed); assert.equal((await renew(fixed, 1)).status, 200);
  assert.equal((await row(fixed)).target_json, before.target_json);
  await db.prepare("UPDATE project_grants SET revoked_at=?1,revoked_by_principal_id=?2 WHERE principal_id=?3 AND project_id=?4").bind(Date.now(), ids.owner, ids.member, project.id).run();
  try { assert.equal((await renew(fixed, 2)).status, 404); }
  finally { await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=?1 AND project_id=?2").bind(ids.member, project.id).run(); }
  await db.prepare("UPDATE projects SET deleted_at=?1,deleted_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ids.owner, project.id).run();
  try { assert.equal((await renew(owner, 2)).status, 404); }
  finally { await db.prepare("UPDATE projects SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(project.id).run(); }
});

test("工作区管理与 Issue Session 维持既有范围，selection 无 Project Grant 仍能续期本人 Session", async () => {
  const managed = await launchSession(ownerToken, { kind: "workspace", workspace_id: workspace.id }); await eligible(managed);
  const original = await row(managed); assert.equal((await renew(managed, 1)).status, 200);
  assert.equal((await row(managed)).target_json, original.target_json); assert.equal((await view(managed)).data.allowed_scope.kind, "workspace");
  const created = await request(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, { method: "POST", body: { title: "Renewal issue" }, headers: bearer(ownerToken), key: randomUUID() });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const issue = created.data.resource, focused = await launchSession(ownerToken, { kind: "issue", identifier: issue.identifier }); await eligible(focused);
  const target = (await row(focused)).target_json; assert.equal((await renew(focused, 1)).status, 200);
  assert.equal((await row(focused)).target_json, target); assert.equal((await view(focused)).data.target.identifier, issue.identifier);
  await db.prepare("UPDATE issues SET deleted_at=?1,deleted_by_principal_id=?2 WHERE id=?3").bind(Date.now(), ids.owner, issue.id).run();
  assert.equal((await renew(focused, 2)).status, 404);
  const selection = await launchSession(); await eligible(selection);
  await db.prepare("UPDATE project_grants SET revoked_at=?1,revoked_by_principal_id=?2 WHERE principal_id=?3 AND project_id=?4").bind(Date.now(), ids.owner, ids.member, project.id).run();
  try {
    const current = await view(selection); assert.equal(current.status, 200); assert.deepEqual(current.data.allowed_scope.projects, []);
    assert.equal((await renew(selection, 1)).status, 200); assert.equal((await row(selection)).target_kind, "project_selection");
    assert.equal((await request(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, { headers: { cookie: selection.cookie } })).status, 404);
  } finally { await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=?1 AND project_id=?2").bind(ids.member, project.id).run(); }
});

test("并发 CAS 只延长一次；原响应丢失可恢复冻结结果，旧结果重放不写 Cookie", async () => {
  const session = await launchSession(); await eligible(session);
  const count = await auditCount(), keys = [randomUUID(), randomUUID()];
  const outcomes = await Promise.all(keys.map(key => renew(session, 1, { key })));
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]); assert.equal(await auditCount(), count + 1);
  const winner = outcomes.findIndex(result => result.status === 200), initial = outcomes[winner];
  await db.prepare("UPDATE web_sessions SET last_seen_at=?1 WHERE id=?2").bind(Date.now() - HALF_HOUR - 1000, session.id).run();
  const later = await renew(session, 2); assert.equal(later.status, 200); assert.ok(Date.parse(later.data.resource.expires_at) > Date.parse(initial.data.resource.expires_at));
  const replay = await renew(session, 1, { key: keys[winner] }); assert.equal(replay.status, 200); assert.equal(replay.data.idempotent_replay, true); assert.deepEqual(replay.data.resource, initial.data.resource);
  assert.equal(replay.response.headers.get("set-cookie"), null);
  const lost = await launchSession(); await eligible(lost);
  const lostKey = randomUUID(), failing = interceptBatch(db, sql => sql.includes("UPDATE web_sessions AS s SET expires_at"), async commit => { await commit(); throw new Error("synthetic lost reply"); });
  const recovered = await renew(lost, 1, { key: lostKey, overrideEnv: { ...env, DB: failing } }); assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  const recoveredReplay = await renew(lost, 1, { key: lostKey }); assert.equal(recoveredReplay.data.idempotent_replay, true); assert.deepEqual(recoveredReplay.data.resource, recovered.data.resource);
});

test("A 续期已提交但响应迟到时，B 新登录的 Principal 与 scope 不被 Set-Cookie 覆写", async () => {
  const old = await launchSession(ownerToken, { kind: "project", workspace_id: workspace.id, project_id: project.id }); await eligible(old);
  const barrier = responseBarrier(), delayedDb = interceptBatch(db, sql => sql.includes("UPDATE web_sessions AS s SET expires_at"), async commit => barrier.hold(await commit()));
  const pending = renew(old, 1, { overrideEnv: { ...env, DB: delayedDb } }), jar = browserCookieJar();
  try {
    await barrier.wait();
    const newer = await launchSession(); jar.accept(newer.response);
  } finally { barrier.release(); }
  const late = await pending; assert.equal(late.status, 200, JSON.stringify(late.data));
  assert.equal(late.response.headers.get("set-cookie"), null); jar.accept(late.response);
  const current = await view(jar); assert.equal(current.status, 200);
  assert.equal(current.data.principal.id, ids.member); assert.equal(current.data.allowed_scope.kind, "project_selection");
});

test("A 过期认证已读回但 401 迟到时，B 新登录的 Cookie 不被自动清除", async () => {
  const old = await launchSession(ownerToken, { kind: "project", workspace_id: workspace.id, project_id: project.id });
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2 WHERE id=?3").bind(Date.now() - HOUR, Date.now() - 1000, old.id).run();
  const barrier = responseBarrier(), delayedDb = interceptFirst(db, sql => sql.includes("FROM web_sessions AS ws"), result => barrier.hold(result));
  const pending = renew(old, 1, { overrideEnv: { ...env, DB: delayedDb } }), jar = browserCookieJar();
  try {
    await barrier.wait();
    const newer = await launchSession(); jar.accept(newer.response);
  } finally { barrier.release(); }
  const late = await pending; assert.equal(late.status, 401); assert.equal(late.response.headers.get("set-cookie"), null); jar.accept(late.response);
  const current = await view(jar); assert.equal(current.status, 200);
  assert.equal(current.data.principal.id, ids.member); assert.equal(current.data.allowed_scope.kind, "project_selection");
});

test("旧八小时 Cookie 保持原持有截止，服务端续期不原地延长 Cookie，浏览器到期后须重新登录", async () => {
  const old = await launchSession(), previous = await eligible(old);
  let browserNow = Date.now(); const jar = browserCookieJar(() => browserNow), headers = new Headers();
  const oldMaxAge = Math.ceil((previous.expires_at - browserNow) / 1000);
  for (const cookie of old.response.headers.getSetCookie()) headers.append("set-cookie", cookie.replace(/Max-Age=\d+/, `Max-Age=${oldMaxAge}`));
  jar.accept(new Response(null, { headers }));
  const changed = await renew(old, 1, { headers: writeHeaders({ cookie: jar.cookie, csrf: old.csrf }) });
  assert.equal(changed.status, 200); assert.equal(changed.data.resource.renewed, true); assert.equal(changed.response.headers.get("set-cookie"), null);
  jar.accept(changed.response); browserNow = previous.expires_at + 2000;
  assert.ok((await row(old)).expires_at > browserNow); assert.equal(jar.cookie, "");
  const noCookie = await renew(old, 2, { headers: writeHeaders({ cookie: jar.cookie, csrf: old.csrf }) });
  assert.equal(noCookie.status, 401); assert.equal(noCookie.response.headers.get("set-cookie"), null);
  const newer = await launchSession(); const cookieMaxAge = Number(/Max-Age=(\d+)/.exec(newer.response.headers.get("set-cookie"))[1]);
  assert.ok(cookieMaxAge > WEEK / 1000 - 10 && cookieMaxAge <= WEEK / 1000);
});

test("续期审计失败原子回滚；认证后源撤销与退出/权限撤销竞态不会留下延长", async () => {
  const session = await launchSession(); await eligible(session);
  const before = await row(session), count = await auditCount();
  await db.prepare("CREATE TRIGGER renewal_test_reject BEFORE INSERT ON events WHEN NEW.type='web-session.renewed' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
  try { assert.equal((await renew(session, 1)).status, 503); assert.deepEqual(await row(session), before); assert.equal(await auditCount(), count); }
  finally { await db.prepare("DROP TRIGGER renewal_test_reject").run(); }
  for (const mutation of ["credential", "logout", "grant"]) {
    const raced = await launchSession(); await eligible(raced);
    if (mutation === "grant") await db.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE id=?2").bind(JSON.stringify({ kind: "project", workspace_id: workspace.id, project_id: project.id, entry_path: `/app/w/${workspace.id}/p/${project.id}` }), raced.id).run();
    const original = await row(raced);
    const racedDb = interceptBatch(db, sql => sql.includes("UPDATE web_sessions AS s SET expires_at"), async commit => {
      if (mutation === "credential") await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), ids.memberCredential).run();
      else if (mutation === "logout") await db.prepare("UPDATE web_sessions SET revoked_at=?1 WHERE id=?2").bind(Date.now(), raced.id).run();
      else await db.prepare("UPDATE project_grants SET revoked_at=?1,revoked_by_principal_id=?2 WHERE principal_id=?3 AND project_id=?4").bind(Date.now(), ids.owner, ids.member, project.id).run();
      return commit();
    });
    try {
      assert.equal((await renew(raced, 1, { overrideEnv: { ...env, DB: racedDb } })).status, mutation === "grant" ? 404 : 401);
      const current = await row(raced); assert.equal(current.expires_at, original.expires_at); assert.equal(current.version, original.version);
    } finally {
      if (mutation === "credential") await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(ids.memberCredential).run();
      else if (mutation === "grant") await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=?1 AND project_id=?2").bind(ids.member, project.id).run();
    }
  }
});

test("期限清理有界使用 expiry 索引，保留创建超过 24 小时但仍有效的续期 Session", async () => {
  const live = await launchSession(), obsolete = await launchSession();
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2 WHERE id=?3").bind(Date.now() - 2 * 24 * HOUR, Date.now() + HOUR, live.id).run();
  await db.prepare("UPDATE web_sessions SET created_at=?1,expires_at=?2 WHERE id=?3").bind(Date.now() - 3 * 24 * HOUR, Date.now() - 2 * 24 * HOUR, obsolete.id).run();
  await webSessionCleanupStatement(db, Date.now()).run();
  assert.ok(await row(live)); assert.equal(await row(obsolete), null); assert.equal((await view(live)).status, 200);
  const plan = await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM web_sessions INDEXED BY idx_web_sessions_expiry_cleanup WHERE expires_at<=?1 ORDER BY expires_at,id LIMIT 100").bind(Date.now()).all();
  assert.match(plan.results.map(row => row.detail).join(" "), /idx_web_sessions_expiry_cleanup/);
});
