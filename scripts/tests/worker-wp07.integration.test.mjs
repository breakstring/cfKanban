import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { principalUserHandle } from "../../apps/worker/src/kernel/webauthn.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { verifyWebAuthentication as verifyWebAuthenticationService } from "../../apps/worker/src/services/passkeys.ts";
import {
  base64UrlEncode,
  createAssertionCredential,
  createRegistrationFixture,
} from "./webauthn-fixtures.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://kanban.example.test";
const rpId = "kanban.example.test";
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const participantToken = `cfk_v1_member_${"B".repeat(43)}`;
const ids = {
  bootstrapOperation: "70000000-0000-4000-8000-000000000004",
  instance: "70000000-0000-4000-8000-000000000001",
  issue: "70000000-0000-4000-8000-000000000014",
  ownerCredential: "70000000-0000-4000-8000-000000000002",
  ownerPrincipal: "70000000-0000-4000-8000-000000000003",
  participantCredential: "70000000-0000-4000-8000-000000000005",
  participantGrantA: "70000000-0000-4000-8000-000000000010",
  participantGrantB: "70000000-0000-4000-8000-000000000011",
  participantPrincipal: "70000000-0000-4000-8000-000000000006",
  projectA: "70000000-0000-4000-8000-000000000008",
  projectB: "70000000-0000-4000-8000-000000000009",
  workspace: "70000000-0000-4000-8000-000000000007",
};

const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});

let db;

function ownerHeaders(extra = {}) {
  return { authorization: `Bearer ${ownerToken}`, ...extra };
}

function participantHeaders(extra = {}) {
  return { authorization: `Bearer ${participantToken}`, ...extra };
}

async function request(path, { body, headers = {}, method = "GET" } = {}) {
  const response = await server.getWorker().fetch(path.startsWith("http") ? path : `${origin}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    method,
  });
  const contentType = response.headers.get("content-type") ?? "";
  return {
    body: contentType.includes("application/json") ? await response.json() : await response.text(),
    response,
  };
}

function responseCookies(response) {
  const header = response.headers.get("set-cookie") ?? "";
  const session = /(?:^|,\s*)cfkanban_session=([^;,]+)/u.exec(header)?.[1] ?? null;
  const csrf = /(?:^|,\s*)cfkanban_csrf=([^;,]+)/u.exec(header)?.[1] ?? null;
  return { csrf, header, session };
}

function cookieHeader(cookies) {
  assert.equal(typeof cookies.session, "string");
  assert.equal(typeof cookies.csrf, "string");
  return `cfkanban_session=${cookies.session}; cfkanban_csrf=${cookies.csrf}`;
}

function cookieWriteHeaders(cookies, extra = {}) {
  return {
    cookie: cookieHeader(cookies),
    origin,
    "x-csrf-token": cookies.csrf,
    ...extra,
  };
}

function uniformError(value) {
  return {
    category: value.body.category,
    code: value.body.code,
    details: value.body.details,
    recovery: value.body.recovery,
    retryable: value.body.retryable,
    status: value.response.status,
  };
}

function failPasskeyAuthenticationBatch(database) {
  let failed = false;
  const rawStatements = new WeakMap();
  const authenticationStatements = new WeakSet();
  const wrapStatement = (statement, isAuthenticationStatement) => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values) => wrapStatement(target.bind(...values), isAuthenticationStatement);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    if (isAuthenticationStatement) authenticationStatements.add(wrapped);
    return wrapped;
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => wrapStatement(
          target.prepare(sql),
          sql.includes("UPDATE web_authenticators") && sql.includes("SET sign_count"),
        );
      }
      if (property === "batch") {
        return (statements) => {
          if (!failed && statements.some((statement) => authenticationStatements.has(statement))) {
            failed = true;
            throw new Error("injected passkey authentication batch failure");
          }
          return target.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function codeFromLaunchUrl(value) {
  const code = new URL(value).searchParams.get("code");
  assert.match(code, /^cfl_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/u);
  return code;
}

async function createLaunch(target, idempotencyKey, headers = participantHeaders()) {
  const created = await request("/api/v1/web-launches", {
    body: { target },
    headers: { ...headers, "idempotency-key": idempotencyKey },
    method: "POST",
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.response.headers.get("cache-control"), "no-store");
  assert.equal(created.body.resource.secret_available, true);
  return { ...created, code: codeFromLaunchUrl(created.body.resource.launch_url) };
}

async function redeemLaunch(code, idempotencyKey) {
  const redeemed = await request("/api/v1/web-sessions/redeem", {
    body: { launch_code: code },
    headers: { "idempotency-key": idempotencyKey },
    method: "POST",
  });
  assert.equal(redeemed.response.status, 200);
  assert.equal(redeemed.response.headers.get("cache-control"), "no-store");
  const cookies = responseCookies(redeemed.response);
  assert.equal(typeof cookies.session, "string");
  assert.equal(typeof cookies.csrf, "string");
  assert.match(cookies.header, /HttpOnly/u);
  assert.match(cookies.header, /Secure/u);
  assert.match(cookies.header, /SameSite=Strict/u);
  assert.match(cookies.header, /Max-Age=28800/u);
  assert.equal(redeemed.body.resource.cookie_available, true);
  return { ...redeemed, cookies };
}

async function registrationOptions(cookies) {
  const result = await request("/api/v1/me/passkeys/registration-options", {
    body: {},
    headers: cookieWriteHeaders(cookies),
    method: "POST",
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.body.public_key.rp.id, rpId);
  assert.equal(result.body.public_key.authenticatorSelection.residentKey, "required");
  assert.equal(result.body.public_key.authenticatorSelection.userVerification, "required");
  return result;
}

async function authenticationOptions() {
  const result = await request("/api/v1/web-authentication/options", {
    body: {},
    method: "POST",
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.body.public_key.rpId, rpId);
  assert.equal(result.body.public_key.userVerification, "required");
  assert.equal("allowCredentials" in result.body.public_key, false);
  return result;
}

async function registerFixture(cookies, options, algorithm, key) {
  const fixture = await createRegistrationFixture({
    algorithm,
    challenge: options.body.public_key.challenge,
    origin,
    rpId,
  });
  const registered = await request("/api/v1/me/passkeys", {
    body: {
      challenge_id: options.body.challenge_id,
      credential: fixture.registrationCredential,
    },
    headers: cookieWriteHeaders(cookies, { "idempotency-key": key }),
    method: "POST",
  });
  assert.equal(registered.response.status, 200);
  assert.equal(registered.body.resource.algorithm, algorithm);
  assert.equal(registered.body.resource.version, 1);
  return { fixture, registered };
}

async function authenticateFixture(fixture, options, signCount, key, userHandle = principalUserHandle(ids.participantPrincipal), assertionOrigin = origin) {
  const credential = await createAssertionCredential({
    ...fixture,
    challenge: options.body.public_key.challenge,
    origin: assertionOrigin,
    rpId,
    signCount,
    userHandle,
  });
  const verified = await request("/api/v1/web-authentication/verify", {
    body: { challenge_id: options.body.challenge_id, credential },
    headers: { "idempotency-key": key },
    method: "POST",
  });
  return { credential, verified };
}

before(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  ({ DB: db } = await worker.getEnv());

  const now = Date.now();
  await bootstrapInstance(db, {
    instanceId: ids.instance,
    operationId: ids.bootstrapOperation,
    ownerCredentialId: ids.ownerCredential,
    ownerCredentialToken: ownerToken,
    ownerDisplayName: "Deployment Owner",
    ownerPrincipalId: ids.ownerPrincipal,
    preferredApiOrigin: origin,
  });
  await db.batch([
    db.prepare(
      "INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?1, 'Participant', ?2, ?2)",
    ).bind(ids.participantPrincipal, now),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
       VALUES (?1, ?2, 'member', ?3, ?4, 'wp07-participant-credential')`,
    ).bind(ids.participantCredential, ids.participantPrincipal, await sha256Hex(participantToken), now),
    db.prepare(
      `INSERT INTO workspaces
        (id, key, display_name, created_at, updated_at, created_by_principal_id,
         updated_by_principal_id, created_operation_id)
       VALUES (?1, 'web', 'Web Workspace', ?2, ?2, ?3, ?3, 'wp07-workspace')`,
    ).bind(ids.workspace, now, ids.ownerPrincipal),
    db.prepare(
      `INSERT INTO projects
        (id, workspace_id, key, display_name, created_at, updated_at,
         created_by_principal_id, updated_by_principal_id, created_operation_id)
       VALUES (?1, ?2, 'APP', 'Application', ?3, ?3, ?4, ?4, 'wp07-project-a')`,
    ).bind(ids.projectA, ids.workspace, now, ids.ownerPrincipal),
    db.prepare(
      `INSERT INTO projects
        (id, workspace_id, key, display_name, created_at, updated_at,
         created_by_principal_id, updated_by_principal_id, created_operation_id)
       VALUES (?1, ?2, 'OPS', 'Operations', ?3, ?3, ?4, ?4, 'wp07-project-b')`,
    ).bind(ids.projectB, ids.workspace, now, ids.ownerPrincipal),
    db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'writer', ?4, ?4, 'wp07-grant-a')`,
    ).bind(ids.participantGrantA, ids.participantPrincipal, ids.projectA, now),
    db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'reader', ?4, ?4, 'wp07-grant-b')`,
    ).bind(ids.participantGrantB, ids.participantPrincipal, ids.projectB, now),
    db.prepare(
      `INSERT INTO issues
        (id, project_id, title, title_search, body, status_key, priority_key,
         priority_rank, created_at, updated_at, created_by_principal_id,
         updated_by_principal_id, created_operation_id)
       VALUES (?1, ?2, 'Launch target', 'launch target', '', 'todo', 'none', 4,
               ?3, ?3, ?4, ?4, 'wp07-issue')`,
    ).bind(ids.issue, ids.projectA, now, ids.ownerPrincipal),
  ]);
});

after(async () => {
  await server.close();
});

test("WP-07 enforces one-shot Browser Launch, fixed Session scope, WebAuthn, and source revocation", async () => {
  const secrets = [];

  const unknownNestedField = await request("/api/v1/web-launches", {
    body: { target: { kind: "project", project_key: "APP", redirect_url: "https://evil.example", workspace_key: "web" } },
    headers: participantHeaders({ "idempotency-key": "wp07-reject-open-redirect" }),
    method: "POST",
  });
  assert.equal(unknownNestedField.response.status, 400);
  assert.equal(unknownNestedField.body.code, "VALIDATION_ERROR");

  const participantAdmin = await request("/api/v1/web-launches", {
    body: { target: { kind: "admin", section: "overview" } },
    headers: participantHeaders({ "idempotency-key": "wp07-participant-admin" }),
    method: "POST",
  });
  assert.equal(participantAdmin.response.status, 403);

  const originSettings = await db.prepare(
    `SELECT preferred_api_origin, version, updated_at, updated_by_principal_id,
            last_operation_id
     FROM instance_origin_settings WHERE singleton = 1`,
  ).first();
  await db.prepare("DELETE FROM instance_origin_settings WHERE singleton = 1").run();
  const missingOriginKey = "wp07-missing-preferred-origin";
  const missingOrigin = await request("/api/v1/web-launches", {
    body: { target: { kind: "project", project_key: "APP", workspace_key: "web" } },
    headers: participantHeaders({ "idempotency-key": missingOriginKey }),
    method: "POST",
  });
  assert.equal(missingOrigin.response.status, 503);
  assert.equal(missingOrigin.body.code, "PLATFORM_UNAVAILABLE");
  const missingOriginEffects = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM browser_launches WHERE created_operation_id IN (
         SELECT operation_id FROM idempotency_records WHERE idempotency_key = ?1
       )) AS launches,
       (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?1) AS records`,
  ).bind(await sha256Hex(missingOriginKey)).first();
  assert.deepEqual(missingOriginEffects, { launches: 0, records: 0 });
  await db.prepare(
    `INSERT INTO instance_origin_settings
      (singleton, preferred_api_origin, version, updated_at,
       updated_by_principal_id, last_operation_id)
     VALUES (1, ?1, ?2, ?3, ?4, ?5)`,
  ).bind(
    originSettings.preferred_api_origin,
    originSettings.version,
    originSettings.updated_at,
    originSettings.updated_by_principal_id,
    originSettings.last_operation_id,
  ).run();

  const projectLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-project-launch",
  );
  secrets.push(projectLaunch.code);
  assert.equal(projectLaunch.body.resource.target.project_id, ids.projectA);
  assert.equal(projectLaunch.body.resource.target.entry_path, "/app/w/web/p/APP");

  const replayedCreation = await request("/api/v1/web-launches", {
    body: { target: { kind: "project", project_key: "APP", workspace_key: "web" } },
    headers: participantHeaders({ "idempotency-key": "wp07-project-launch" }),
    method: "POST",
  });
  assert.equal(replayedCreation.response.status, 200);
  assert.equal(replayedCreation.body.idempotent_replay, true);
  assert.equal(replayedCreation.body.resource.secret_available, false);
  assert.equal("launch_url" in replayedCreation.body.resource, false);

  const eventCountBeforeGet = await db.prepare("SELECT COUNT(*) AS count FROM events").first();
  for (let index = 0; index < 2; index += 1) {
    const page = await request(projectLaunch.body.resource.launch_url);
    assert.equal(page.response.status, 200);
    assert.equal(page.response.headers.get("cache-control"), "no-store");
    assert.equal(page.response.headers.get("referrer-policy"), "no-referrer");
    assert.doesNotMatch(page.body, new RegExp(projectLaunch.code));
    const script = /<script>([\s\S]+)<\/script>/u.exec(page.body)?.[1];
    assert.equal(typeof script, "string");
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script))).toString("base64");
    assert.match(page.response.headers.get("content-security-policy"), new RegExp(`sha256-${digest.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
  }
  const launchAfterGet = await db.prepare(
    "SELECT redeemed_at FROM browser_launches WHERE id = ?1",
  ).bind(projectLaunch.body.resource.id).first();
  assert.equal(launchAfterGet.redeemed_at, null);
  const eventCountAfterGet = await db.prepare("SELECT COUNT(*) AS count FROM events").first();
  assert.equal(eventCountAfterGet.count, eventCountBeforeGet.count);

  const projectSession = await redeemLaunch(projectLaunch.code, "wp07-project-redeem");
  secrets.push(projectSession.cookies.session, projectSession.cookies.csrf);
  assert.equal(projectSession.body.resource.entry_path, "/app/w/web/p/APP");
  assert.deepEqual(projectSession.body.resource.allowed_scope, { kind: "project", project_id: ids.projectA });

  const replayedRedemption = await request("/api/v1/web-sessions/redeem", {
    body: { launch_code: projectLaunch.code },
    headers: { "idempotency-key": "wp07-project-redeem" },
    method: "POST",
  });
  assert.equal(replayedRedemption.response.status, 200);
  assert.equal(replayedRedemption.body.idempotent_replay, true);
  assert.equal(replayedRedemption.body.resource.cookie_available, false);
  assert.equal(responseCookies(replayedRedemption.response).session, null);

  const consumedWithNewKey = await request("/api/v1/web-sessions/redeem", {
    body: { launch_code: projectLaunch.code },
    headers: { "idempotency-key": "wp07-project-redeem-new-key" },
    method: "POST",
  });
  assert.equal(consumedWithNewKey.response.status, 410);
  assert.equal(consumedWithNewKey.body.code, "BROWSER_LAUNCH_UNAVAILABLE");

  const sessionView = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(projectSession.cookies) },
  });
  assert.equal(sessionView.response.status, 200);
  assert.equal(sessionView.body.allowed_scope.kind, "project");
  assert.deepEqual(sessionView.body.allowed_scope.projects.map((project) => project.project_id), [ids.projectA]);
  const outsideFixedScope = await request("/api/v1/workspaces/web/projects/OPS", {
    headers: { cookie: cookieHeader(projectSession.cookies) },
  });
  assert.equal(outsideFixedScope.response.status, 404);

  const missingCsrf = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(projectSession.cookies) },
    method: "DELETE",
  });
  assert.equal(missingCsrf.response.status, 403);
  const loggedOut = await request("/api/v1/web-session", {
    headers: cookieWriteHeaders(projectSession.cookies),
    method: "DELETE",
  });
  assert.equal(loggedOut.response.status, 200);
  assert.match(loggedOut.response.headers.get("set-cookie"), /Max-Age=0/u);
  const loggedOutRead = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(projectSession.cookies) },
  });
  assert.equal(loggedOutRead.response.status, 401);

  const issueLaunch = await createLaunch({ identifier: "CFK-1", kind: "issue" }, "wp07-issue-launch");
  secrets.push(issueLaunch.code);
  assert.equal(issueLaunch.body.resource.target.issue_id, ids.issue);
  assert.equal(issueLaunch.body.resource.target.project_id, ids.projectA);
  const issueSession = await redeemLaunch(issueLaunch.code, "wp07-issue-redeem");
  secrets.push(issueSession.cookies.session, issueSession.cookies.csrf);
  assert.equal(issueSession.body.resource.entry_path, "/app/issues/CFK-1");
  assert.equal(issueSession.body.resource.allowed_scope.project_id, ids.projectA);

  const ownerLaunch = await createLaunch(
    { kind: "admin", section: "overview" },
    "wp07-owner-admin-launch",
    ownerHeaders(),
  );
  secrets.push(ownerLaunch.code);
  const ownerSession = await redeemLaunch(ownerLaunch.code, "wp07-owner-admin-redeem");
  secrets.push(ownerSession.cookies.session, ownerSession.cookies.csrf);
  const ownerSessionView = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(ownerSession.cookies) },
  });
  assert.equal(ownerSessionView.body.allowed_scope.kind, "instance");
  assert.equal(ownerSessionView.body.principal.is_owner, true);

  const sourceLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-source-revoke-launch",
  );
  secrets.push(sourceLaunch.code);
  const sourceSession = await redeemLaunch(sourceLaunch.code, "wp07-source-revoke-redeem");
  secrets.push(sourceSession.cookies.session, sourceSession.cookies.csrf);
  const sourceRevokeAt = Date.now();
  await db.prepare(
    `UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2, revoke_reason = 'test'
     WHERE id = ?3`,
  ).bind(sourceRevokeAt, ids.ownerPrincipal, ids.participantCredential).run();
  const invalidatedBySource = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(sourceSession.cookies) },
  });
  assert.equal(invalidatedBySource.response.status, 401);
  await db.prepare(
    "UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL, revoke_reason = NULL WHERE id = ?1",
  ).bind(ids.participantCredential).run();

  const registrationLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-registration-launch",
  );
  secrets.push(registrationLaunch.code);
  const registrationSession = await redeemLaunch(registrationLaunch.code, "wp07-registration-redeem");
  secrets.push(registrationSession.cookies.session, registrationSession.cookies.csrf);

  const noCsrfOptions = await request("/api/v1/me/passkeys/registration-options", {
    body: {},
    headers: { cookie: cookieHeader(registrationSession.cookies), origin },
    method: "POST",
  });
  assert.equal(noCsrfOptions.response.status, 403);
  const preRegistrationView = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(registrationSession.cookies) },
  });
  assert.equal(preRegistrationView.response.status, 200, JSON.stringify(preRegistrationView.body));

  const esOptions = await registrationOptions(registrationSession.cookies);
  secrets.push(esOptions.body.public_key.challenge);
  const storedEsChallenge = await db.prepare(
    "SELECT challenge_digest, expected_origin, principal_id, rp_id FROM webauthn_challenges WHERE id = ?1",
  ).bind(esOptions.body.challenge_id).first();
  assert.equal(storedEsChallenge.challenge_digest, await sha256Hex(esOptions.body.public_key.challenge));
  assert.equal(storedEsChallenge.expected_origin, origin);
  assert.equal(storedEsChallenge.principal_id, ids.participantPrincipal);
  assert.equal(storedEsChallenge.rp_id, rpId);
  assert.notEqual(storedEsChallenge.challenge_digest, esOptions.body.public_key.challenge);
  const es = await registerFixture(registrationSession.cookies, esOptions, -7, "wp07-register-es256");
  const esReplay = await request("/api/v1/me/passkeys", {
    body: { challenge_id: esOptions.body.challenge_id, credential: es.fixture.registrationCredential },
    headers: cookieWriteHeaders(registrationSession.cookies, { "idempotency-key": "wp07-register-es256" }),
    method: "POST",
  });
  assert.equal(esReplay.response.status, 200);
  assert.equal(esReplay.body.idempotent_replay, true);
  assert.equal(esReplay.body.resource.id, es.registered.body.resource.id);

  const rsaOptions = await registrationOptions(registrationSession.cookies);
  secrets.push(rsaOptions.body.public_key.challenge);
  assert.equal(rsaOptions.body.public_key.excludeCredentials.length, 1);
  const rsa = await registerFixture(registrationSession.cookies, rsaOptions, -257, "wp07-register-rs256");

  const listed = await request("/api/v1/me/passkeys", {
    headers: { cookie: cookieHeader(registrationSession.cookies) },
  });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.response.headers.get("cache-control"), "no-store");
  assert.equal(listed.body.items.length, 2);
  assert.deepEqual(new Set(listed.body.items.map((passkey) => passkey.algorithm)), new Set([-7, -257]));

  const platformFailureOptions = await authenticationOptions();
  secrets.push(platformFailureOptions.body.public_key.challenge);
  const platformFailureCredential = await createAssertionCredential({
    ...es.fixture,
    challenge: platformFailureOptions.body.public_key.challenge,
    origin,
    rpId,
    signCount: 1,
    userHandle: principalUserHandle(ids.participantPrincipal),
  });
  const platformFailureKey = "wp07-passkey-platform-failure";
  await assert.rejects(
    verifyWebAuthenticationService(
      failPasskeyAuthenticationBatch(db),
      new Request(`${origin}/api/v1/web-authentication/verify`, {
        headers: { "idempotency-key": platformFailureKey },
        method: "POST",
      }),
      platformFailureOptions.body.challenge_id,
      platformFailureCredential,
      Date.now(),
    ),
    (error) => error.code === "PLATFORM_UNAVAILABLE" && error.status === 503,
  );
  const failedAuthenticationState = await db.prepare(
    `SELECT
       (SELECT consumed_at FROM webauthn_challenges WHERE id = ?1) AS consumed_at,
       (SELECT sign_count FROM web_authenticators WHERE id = ?2) AS sign_count,
       (SELECT state FROM idempotency_records WHERE idempotency_key = ?3) AS state`,
  ).bind(
    platformFailureOptions.body.challenge_id,
    es.registered.body.resource.id,
    await sha256Hex(platformFailureKey),
  ).first();
  assert.deepEqual(failedAuthenticationState, { consumed_at: null, sign_count: 0, state: "pending" });
  await db.batch([
    db.prepare("DELETE FROM idempotency_records WHERE idempotency_key = ?1").bind(await sha256Hex(platformFailureKey)),
    db.prepare("DELETE FROM webauthn_challenges WHERE id = ?1").bind(platformFailureOptions.body.challenge_id),
  ]);

  const esZeroCounterOptions = await authenticationOptions();
  secrets.push(esZeroCounterOptions.body.public_key.challenge);
  const esZeroCounterAuthentication = await authenticateFixture(
    es.fixture,
    esZeroCounterOptions,
    0,
    "wp07-authenticate-es256-zero-counter",
  );
  assert.equal(esZeroCounterAuthentication.verified.response.status, 200);
  const esAfterZeroCounter = await db.prepare(
    "SELECT sign_count, version FROM web_authenticators WHERE id = ?1",
  ).bind(es.registered.body.resource.id).first();
  assert.equal(esAfterZeroCounter.sign_count, 0);
  assert.equal(esAfterZeroCounter.version, 2);

  const esAuthenticationOptions = await authenticationOptions();
  secrets.push(esAuthenticationOptions.body.public_key.challenge);
  const esAuthentication = await authenticateFixture(
    es.fixture,
    esAuthenticationOptions,
    1,
    "wp07-authenticate-es256",
  );
  assert.equal(esAuthentication.verified.response.status, 200);
  assert.equal(esAuthentication.verified.body.resource.cookie_available, true);
  assert.equal(esAuthentication.verified.body.resource.target.kind, "project_selection");
  const esSessionCookies = responseCookies(esAuthentication.verified.response);
  secrets.push(esSessionCookies.session, esSessionCookies.csrf);

  const passkeySessionView = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(esSessionCookies) },
  });
  assert.equal(passkeySessionView.response.status, 200);
  assert.equal(passkeySessionView.body.allowed_scope.kind, "project_selection");
  assert.deepEqual(
    new Set(passkeySessionView.body.allowed_scope.projects.map((project) => project.project_id)),
    new Set([ids.projectA, ids.projectB]),
  );
  const registrationFromPasskeySession = await request("/api/v1/me/passkeys/registration-options", {
    body: {},
    headers: cookieWriteHeaders(esSessionCookies),
    method: "POST",
  });
  assert.equal(registrationFromPasskeySession.response.status, 403);

  const rsaAuthenticationOptions = await authenticationOptions();
  secrets.push(rsaAuthenticationOptions.body.public_key.challenge);
  const rsaAuthentication = await authenticateFixture(
    rsa.fixture,
    rsaAuthenticationOptions,
    1,
    "wp07-authenticate-rs256",
  );
  assert.equal(rsaAuthentication.verified.response.status, 200);
  const rsaSessionCookies = responseCookies(rsaAuthentication.verified.response);
  secrets.push(rsaSessionCookies.session, rsaSessionCookies.csrf);

  const unknownOptions = await authenticationOptions();
  secrets.push(unknownOptions.body.public_key.challenge);
  const unknownCredentialId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const unknownCredential = await createAssertionCredential({
    ...es.fixture,
    challenge: unknownOptions.body.public_key.challenge,
    credentialId: unknownCredentialId,
    origin,
    rpId,
    signCount: 2,
    userHandle: principalUserHandle(ids.participantPrincipal),
  });
  const unknownFailure = await request("/api/v1/web-authentication/verify", {
    body: { challenge_id: unknownOptions.body.challenge_id, credential: unknownCredential },
    headers: { "idempotency-key": "wp07-unknown-credential" },
    method: "POST",
  });

  const wrongHandleOptions = await authenticationOptions();
  secrets.push(wrongHandleOptions.body.public_key.challenge);
  const wrongHandle = await authenticateFixture(
    es.fixture,
    wrongHandleOptions,
    2,
    "wp07-wrong-user-handle",
    principalUserHandle(ids.ownerPrincipal),
  );

  const wrongOriginOptions = await authenticationOptions();
  secrets.push(wrongOriginOptions.body.public_key.challenge);
  const wrongOrigin = await authenticateFixture(
    es.fixture,
    wrongOriginOptions,
    2,
    "wp07-wrong-origin",
    principalUserHandle(ids.participantPrincipal),
    "https://evil.example",
  );

  const wrongRpOptions = await authenticationOptions();
  secrets.push(wrongRpOptions.body.public_key.challenge);
  const wrongRpCredential = await createAssertionCredential({
    ...es.fixture,
    challenge: wrongRpOptions.body.public_key.challenge,
    origin,
    rpId: "other.example",
    signCount: 2,
    userHandle: principalUserHandle(ids.participantPrincipal),
  });
  const wrongRp = await request("/api/v1/web-authentication/verify", {
    body: { challenge_id: wrongRpOptions.body.challenge_id, credential: wrongRpCredential },
    headers: { "idempotency-key": "wp07-wrong-rp-id" },
    method: "POST",
  });

  const invalidChallengeId = await request("/api/v1/web-authentication/verify", {
    body: { challenge_id: "not-a-uuid", credential: wrongOrigin.credential },
    headers: { "idempotency-key": "wp07-invalid-challenge-id" },
    method: "POST",
  });
  assert.deepEqual(uniformError(unknownFailure), uniformError(wrongHandle.verified));
  assert.deepEqual(uniformError(unknownFailure), uniformError(wrongOrigin.verified));
  assert.deepEqual(uniformError(unknownFailure), uniformError(wrongRp));
  assert.deepEqual(uniformError(unknownFailure), uniformError(invalidChallengeId));
  assert.equal(unknownFailure.response.status, 401);

  const anomalyOptions = await authenticationOptions();
  secrets.push(anomalyOptions.body.public_key.challenge);
  const anomaly = await authenticateFixture(
    rsa.fixture,
    anomalyOptions,
    1,
    "wp07-rsa-counter-anomaly",
  );
  assert.equal(anomaly.verified.response.status, 401);
  const rsaRowAfterAnomaly = await db.prepare(
    "SELECT revoked_at, sign_count, version FROM web_authenticators WHERE id = ?1",
  ).bind(rsa.registered.body.resource.id).first();
  assert.equal(rsaRowAfterAnomaly.revoked_at, null);
  assert.equal(rsaRowAfterAnomaly.sign_count, 1);
  assert.equal(rsaRowAfterAnomaly.version, 2);
  const anomalyEvent = await db.prepare(
    "SELECT payload_json FROM events WHERE type = 'passkey.counter-anomaly' AND subject_id = ?1",
  ).bind(rsa.registered.body.resource.id).first();
  assert.deepEqual(JSON.parse(anomalyEvent.payload_json), { observed_sign_count: 1, stored_sign_count: 1 });
  const anomalyChallenge = await db.prepare(
    "SELECT consumed_at FROM webauthn_challenges WHERE id = ?1",
  ).bind(anomalyOptions.body.challenge_id).first();
  assert.equal(typeof anomalyChallenge.consumed_at, "number");

  const selfRevoked = await request(
    `/api/v1/me/passkeys/${es.registered.body.resource.id}?expected_version=3`,
    {
      headers: cookieWriteHeaders(esSessionCookies),
      method: "DELETE",
    },
  );
  assert.equal(selfRevoked.response.status, 200);
  assert.equal(selfRevoked.body.resource.version, 4);
  assert.match(selfRevoked.response.headers.get("set-cookie"), /Max-Age=0/u);
  const selfRevokedSession = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(esSessionCookies) },
  });
  assert.equal(selfRevokedSession.response.status, 401);

  const ownerRevoked = await request(
    `/api/v1/admin/passkeys/${rsa.registered.body.resource.id}?expected_version=2`,
    {
      headers: ownerHeaders(),
      method: "DELETE",
    },
  );
  assert.equal(ownerRevoked.response.status, 200);
  assert.equal(ownerRevoked.body.resource.version, 3);
  const ownerRevokedSession = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(rsaSessionCookies) },
  });
  assert.equal(ownerRevokedSession.response.status, 401);

  const persisted = [];
  for (const table of [
    "browser_launches",
    "web_sessions",
    "webauthn_challenges",
    "web_authenticators",
    "events",
    "idempotency_records",
  ]) {
    const rows = await db.prepare(`SELECT * FROM ${table}`).all();
    persisted.push(JSON.stringify(rows.results));
  }
  const persistedText = persisted.join("\n");
  for (const secret of secrets.filter((value) => typeof value === "string")) {
    assert.equal(persistedText.includes(secret), false, "raw launch/session/CSRF/challenge secret persisted");
  }
});
