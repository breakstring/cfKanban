import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { authenticateRequest } from "../../apps/worker/src/kernel/auth.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { principalUserHandle } from "../../apps/worker/src/kernel/webauthn.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { verifyWebAuthentication as verifyWebAuthenticationService } from "../../apps/worker/src/services/passkeys.ts";
import {
  getWebSession as getWebSessionService,
  redeemWebLaunch as redeemWebLaunchService,
} from "../../apps/worker/src/services/web-auth.ts";
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

function assertSessionCookiesCleared(response) {
  const header = response.headers.get("set-cookie") ?? "";
  assert.match(header, /cfkanban_session=;[^,]*Max-Age=0/u);
  assert.match(header, /cfkanban_csrf=;[^,]*Max-Age=0/u);
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

function failBrowserLaunchRedemptionBatch(database) {
  let failed = false;
  const rawStatements = new WeakMap();
  const redemptionStatements = new WeakSet();
  const wrapStatement = (statement, isRedemptionStatement) => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values) => wrapStatement(target.bind(...values), isRedemptionStatement);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    if (isRedemptionStatement) redemptionStatements.add(wrapped);
    return wrapped;
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => wrapStatement(
          target.prepare(sql),
          sql.includes("UPDATE browser_launches AS launch") && sql.includes("SET redeemed_at"),
        );
      }
      if (property === "batch") {
        return (statements) => {
          if (!failed && statements.some((statement) => redemptionStatements.has(statement))) {
            failed = true;
            throw new Error("injected Browser Launch redemption batch failure");
          }
          return target.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failBrowserLaunchSnapshotReadOnce(database) {
  let failed = false;
  const wrapStatement = (statement, isSnapshotRead) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), isSnapshotRead);
      }
      if (property === "first" && isSnapshotRead) {
        return (...values) => {
          if (!failed) {
            failed = true;
            throw new Error("injected Browser Launch snapshot read failure");
          }
          return target.first(...values);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => wrapStatement(
          target.prepare(sql),
          sql.includes("SELECT operation_snapshot_json FROM idempotency_records"),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function browserLaunchRedemptionBarrierDatabase(database) {
  let releaseBatch;
  let signalReached;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseBatch = resolve;
  });
  const rawStatements = new WeakMap();
  const redemptionStatements = new WeakSet();
  const wrapStatement = (statement, isRedemptionStatement) => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values) => wrapStatement(target.bind(...values), isRedemptionStatement);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    if (isRedemptionStatement) redemptionStatements.add(wrapped);
    return wrapped;
  };
  return {
    db: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql) => wrapStatement(
            target.prepare(sql),
            sql.includes("UPDATE browser_launches AS launch") && sql.includes("SET redeemed_at"),
          );
        }
        if (property === "batch") {
          return async (statements) => {
            if (statements.some((statement) => redemptionStatements.has(statement))) {
              signalReached();
              await released;
            }
            return target.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    reached,
    release() {
      releaseBatch();
    },
  };
}

function webSessionScopeBarrierDatabase(database) {
  let releaseQuery;
  let rawRows = null;
  let signalReached;
  let guardedSql = null;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseQuery = resolve;
  });
  const wrapStatement = (statement, sql) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), sql);
      }
      if (property === "all" && sql.includes("FROM web_sessions AS auth_session")) {
        return async (...values) => {
          guardedSql = sql;
          signalReached();
          await released;
          const result = await target.all(...values);
          rawRows = result.results;
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql) => wrapStatement(target.prepare(sql), sql);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    get guardedSql() {
      return guardedSql;
    },
    get rawRows() {
      return rawRows;
    },
    reached,
    release() {
      releaseQuery();
    },
  };
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

async function assertRacedRedemptionUnavailable({ idempotencyKey, launch, mutate, restore }) {
  const before = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM web_sessions) AS sessions,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits`,
  ).first();
  const barrier = browserLaunchRedemptionBarrierDatabase(db);
  const redemption = redeemWebLaunchService(
    barrier.db,
    new Request(`${origin}/api/v1/web-sessions/redeem`, {
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    }),
    launch.code,
    Date.now(),
  );
  await barrier.reached;
  try {
    await mutate();
    barrier.release();
    await assert.rejects(
      redemption,
      (error) => {
        assert.deepEqual(
          {
            category: error?.category,
            code: error?.code,
            recovery: error?.recovery,
            retryable: error?.retryable,
            source: error?.source,
            status: error?.status,
          },
          {
            category: "conflict",
            code: "BROWSER_LAUNCH_UNAVAILABLE",
            recovery: "request_new_browser_launch",
            retryable: false,
            source: "service",
            status: 410,
          },
        );
        return true;
      },
    );
  } finally {
    barrier.release();
    await restore();
  }
  const after = await db.prepare(
    `SELECT
       (SELECT redeemed_at FROM browser_launches WHERE id = ?1) AS redeemed_at,
       (SELECT COUNT(*) FROM web_sessions) AS sessions,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits,
       (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?2) AS records`,
  ).bind(launch.body.resource.id, await sha256Hex(idempotencyKey)).first();
  assert.deepEqual(after, {
    ...before,
    redeemed_at: null,
    records: 0,
  });
}

async function assertRacedWebSessionScope({
  cookies,
  expectedRole = null,
  expectedStatus = 404,
  expectGrantGuard = true,
  mutate,
  restore,
}) {
  const now = Date.now();
  const auth = await authenticateRequest(
    db,
    new Request(`${origin}/api/v1/web-session`, { headers: { cookie: cookieHeader(cookies) } }),
    now,
  );
  const barrier = webSessionScopeBarrierDatabase(db);
  const view = getWebSessionService(barrier.db, auth, now);
  await barrier.reached;
  try {
    assert.match(barrier.guardedSql, /FROM web_sessions AS auth_session/u);
    if (expectGrantGuard) assert.match(barrier.guardedSql, /pg\.revoked_at IS NULL/u);
    else assert.doesNotMatch(barrier.guardedSql, /FROM project_grants AS pg/u);
    assert.match(barrier.guardedSql, /p\.deleted_at IS NULL AND w\.deleted_at IS NULL/u);
    assert.match(barrier.guardedSql, /target_issue\.deleted_at IS NULL/u);
    await mutate(now);
    barrier.release();
    if (expectedRole === null) {
      await assert.rejects(view, (error) => error?.status === expectedStatus);
      assert.deepEqual(barrier.rawRows, []);
    } else {
      const resource = await view;
      assert.equal(barrier.rawRows.length, 1);
      assert.deepEqual(resource.allowed_scope.projects.map((project) => project.role), [expectedRole]);
    }
  } finally {
    barrier.release();
    await restore();
  }
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

async function rejectRegistrationWithExtraCose(
  cookies,
  algorithm,
  extraCoseEntries,
  key,
  preserveCoseEntries = false,
) {
  const options = await registrationOptions(cookies);
  const fixture = await createRegistrationFixture({
    algorithm,
    challenge: options.body.public_key.challenge,
    extraCoseEntries,
    origin,
    preserveCoseEntries,
    rpId,
  });
  const before = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM web_authenticators) AS authenticators,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits`,
  ).first();
  const rejected = await request("/api/v1/me/passkeys", {
    body: {
      challenge_id: options.body.challenge_id,
      credential: fixture.registrationCredential,
    },
    headers: cookieWriteHeaders(cookies, { "idempotency-key": key }),
    method: "POST",
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, "PASSKEY_CHALLENGE_INVALID");
  assert.equal(JSON.stringify(rejected.body).includes(fixture.publicKeyCose), false);
  const after = await db.prepare(
    `SELECT
       (SELECT consumed_at FROM webauthn_challenges WHERE id = ?1) AS consumed_at,
       (SELECT COUNT(*) FROM web_authenticators) AS authenticators,
       (SELECT COUNT(*) FROM web_authenticators WHERE credential_id = ?2 OR public_key_cose = ?3) AS injected,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits,
       (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?4) AS idempotency_records`,
  ).bind(
    options.body.challenge_id,
    fixture.credentialId,
    fixture.publicKeyCose,
    await sha256Hex(key),
  ).first();
  assert.equal(typeof after.consumed_at, "number");
  assert.deepEqual(
    {
      authenticators: after.authenticators,
      commits: after.commits,
      events: after.events,
      idempotency_records: after.idempotency_records,
      injected: after.injected,
    },
    { ...before, idempotency_records: 0, injected: 0 },
  );
  return { fixture, options };
}

async function rejectRegistrationWithCredentialMutation(cookies, mutate, key) {
  const options = await registrationOptions(cookies);
  const fixture = await createRegistrationFixture({
    algorithm: -7,
    challenge: options.body.public_key.challenge,
    origin,
    rpId,
  });
  mutate(fixture.registrationCredential);
  const before = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM web_authenticators) AS authenticators,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits`,
  ).first();
  const rejected = await request("/api/v1/me/passkeys", {
    body: {
      challenge_id: options.body.challenge_id,
      credential: fixture.registrationCredential,
    },
    headers: cookieWriteHeaders(cookies, { "idempotency-key": key }),
    method: "POST",
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, "PASSKEY_CHALLENGE_INVALID");
  const after = await db.prepare(
    `SELECT
       (SELECT consumed_at FROM webauthn_challenges WHERE id = ?1) AS consumed_at,
       (SELECT COUNT(*) FROM web_authenticators) AS authenticators,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits,
       (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?2) AS idempotency_records`,
  ).bind(options.body.challenge_id, await sha256Hex(key)).first();
  assert.equal(typeof after.consumed_at, "number");
  assert.deepEqual(
    {
      authenticators: after.authenticators,
      commits: after.commits,
      events: after.events,
      idempotency_records: after.idempotency_records,
    },
    { ...before, idempotency_records: 0 },
  );
  return { fixture, options, rejected };
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

  const oldLaunchCreatedAt = Date.now() - (2 * 24 * 60 * 60 * 1_000);
  await db.prepare(
    `WITH RECURSIVE counter(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM counter WHERE value < 101
     )
     INSERT INTO browser_launches
       (id, code_prefix, code_digest, principal_id, source_credential_id,
        target_kind, target_json, expires_at, created_at, created_operation_id)
     SELECT 'wp07-old-launch-' || value, 'old', printf('%064x', value + 1000),
            ?1, ?2, 'project',
            json_object('entry_path', '/app/w/web/p/APP', 'kind', 'project',
                        'project_id', ?3, 'project_key', 'APP', 'workspace_key', 'web'),
            ?4 + 300000, ?4, 'wp07-old-launch-operation-' || value
     FROM counter`,
  ).bind(
    ids.participantPrincipal,
    ids.participantCredential,
    ids.projectA,
    oldLaunchCreatedAt,
  ).run();
  const projectLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-project-launch",
  );
  secrets.push(projectLaunch.code);
  const oldLaunchesAfterCleanup = await db.prepare(
    "SELECT COUNT(*) AS count FROM browser_launches WHERE id LIKE 'wp07-old-launch-%'",
  ).first();
  assert.equal(oldLaunchesAfterCleanup.count, 1);
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
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, ids.participantGrantA).run();
  try {
    const unauthorizedCreationReplay = await request("/api/v1/web-launches", {
      body: { target: { kind: "project", project_key: "APP", workspace_key: "web" } },
      headers: participantHeaders({ "idempotency-key": "wp07-project-launch" }),
      method: "POST",
    });
    assert.equal(unauthorizedCreationReplay.response.status, 404);
    assert.equal("resource" in unauthorizedCreationReplay.body, false);
  } finally {
    await db.prepare(
      `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
         version = version + 1 WHERE id = ?1`,
    ).bind(ids.participantGrantA).run();
  }

  const sourceInvalidationLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-redeem-source-race-launch",
  );
  const grantInvalidationLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-redeem-grant-race-launch",
  );
  const projectInvalidationLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-redeem-project-race-launch",
  );
  const workspaceInvalidationLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-redeem-workspace-race-launch",
  );
  const issueInvalidationLaunch = await createLaunch(
    { identifier: "CFK-1", kind: "issue" },
    "wp07-redeem-issue-race-launch",
  );
  secrets.push(
    sourceInvalidationLaunch.code,
    grantInvalidationLaunch.code,
    projectInvalidationLaunch.code,
    workspaceInvalidationLaunch.code,
    issueInvalidationLaunch.code,
  );
  await assertRacedRedemptionUnavailable({
    idempotencyKey: "wp07-redeem-source-race",
    launch: sourceInvalidationLaunch,
    mutate: () => db.prepare(
      `UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2,
         revoke_reason = 'test' WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, ids.participantCredential).run(),
    restore: () => db.prepare(
      `UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL,
         revoke_reason = NULL WHERE id = ?1`,
    ).bind(ids.participantCredential).run(),
  });
  await assertRacedRedemptionUnavailable({
    idempotencyKey: "wp07-redeem-grant-race",
    launch: grantInvalidationLaunch,
    mutate: () => db.prepare(
      `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
         version = version + 1 WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, ids.participantGrantA).run(),
    restore: () => db.prepare(
      `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
         version = version + 1 WHERE id = ?1`,
    ).bind(ids.participantGrantA).run(),
  });
  await assertRacedRedemptionUnavailable({
    idempotencyKey: "wp07-redeem-project-race",
    launch: projectInvalidationLaunch,
    mutate: () => db.prepare(
      "UPDATE projects SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
    ).bind(Date.now(), ids.ownerPrincipal, ids.projectA).run(),
    restore: () => db.prepare(
      "UPDATE projects SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.projectA).run(),
  });
  await assertRacedRedemptionUnavailable({
    idempotencyKey: "wp07-redeem-workspace-race",
    launch: workspaceInvalidationLaunch,
    mutate: () => db.prepare(
      "UPDATE workspaces SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
    ).bind(Date.now(), ids.ownerPrincipal, ids.workspace).run(),
    restore: () => db.prepare(
      "UPDATE workspaces SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.workspace).run(),
  });
  await assertRacedRedemptionUnavailable({
    idempotencyKey: "wp07-redeem-issue-race",
    launch: issueInvalidationLaunch,
    mutate: () => db.prepare(
      `UPDATE issues SET deleted_at = ?1, deleted_by_principal_id = ?2,
         version = version + 1 WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, ids.issue).run(),
    restore: () => db.prepare(
      `UPDATE issues SET deleted_at = NULL, deleted_by_principal_id = NULL,
      version = version + 1 WHERE id = ?1`,
    ).bind(ids.issue).run(),
  });

  const platformFailureLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-redeem-platform-failure-launch",
  );
  secrets.push(platformFailureLaunch.code);
  const redemptionPlatformFailureKey = "wp07-redeem-platform-failure";
  const platformFailureBefore = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM web_sessions) AS sessions,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits`,
  ).first();
  await assert.rejects(
    redeemWebLaunchService(
      failBrowserLaunchRedemptionBatch(db),
      new Request(`${origin}/api/v1/web-sessions/redeem`, {
        headers: { "idempotency-key": redemptionPlatformFailureKey },
        method: "POST",
      }),
      platformFailureLaunch.code,
      Date.now(),
    ),
    (error) => {
      assert.deepEqual(
        {
          category: error?.category,
          code: error?.code,
          recovery: error?.recovery,
          retryable: error?.retryable,
          source: error?.source,
          status: error?.status,
        },
        {
          category: "platform_failure",
          code: "PLATFORM_UNAVAILABLE",
          recovery: "request_owner",
          retryable: false,
          source: "cloudflare_platform",
          status: 503,
        },
      );
      return true;
    },
  );
  const platformFailureAfter = await db.prepare(
    `SELECT
       (SELECT redeemed_at FROM browser_launches WHERE id = ?1) AS redeemed_at,
       (SELECT COUNT(*) FROM web_sessions) AS sessions,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits,
       (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?2) AS records`,
  ).bind(platformFailureLaunch.body.resource.id, await sha256Hex(redemptionPlatformFailureKey)).first();
  assert.deepEqual(platformFailureAfter, {
    ...platformFailureBefore,
    redeemed_at: null,
    records: 0,
  });

  const responseLossLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-response-loss-launch",
  );
  secrets.push(responseLossLaunch.code);
  const responseLossKey = "wp07-response-loss-redeem";
  await assert.rejects(
    redeemWebLaunchService(
      failBrowserLaunchSnapshotReadOnce(db),
      new Request(`${origin}/api/v1/web-sessions/redeem`, {
        headers: { "idempotency-key": responseLossKey },
        method: "POST",
      }),
      responseLossLaunch.code,
      Date.now(),
    ),
    (error) => error?.code === "PLATFORM_UNAVAILABLE" && error?.status === 503,
  );
  const responseLossResume = await redeemWebLaunchService(
    db,
    new Request(`${origin}/api/v1/web-sessions/redeem`, {
      headers: { "idempotency-key": responseLossKey },
      method: "POST",
    }),
    responseLossLaunch.code,
    Date.now(),
  );
  assert.equal(responseLossResume.body.idempotent_replay, true);
  assert.equal(responseLossResume.body.resource.cookie_available, false);
  assert.equal(responseLossResume.sessionToken, null);
  assert.equal(responseLossResume.csrfToken, null);
  const responseLossState = await db.prepare(
    `SELECT record.state,
            (record.operation_snapshot_json IS NOT NULL) AS snapshot_available,
            (SELECT COUNT(*) FROM web_sessions
             WHERE created_operation_id = record.operation_id) AS sessions,
            (SELECT COUNT(*) FROM events
             WHERE operation_id = record.operation_id) AS events,
            (SELECT COUNT(*) FROM operation_commits
             WHERE operation_id = record.operation_id) AS commits
     FROM idempotency_records record
     WHERE record.idempotency_key = ?1`,
  ).bind(await sha256Hex(responseLossKey)).first();
  assert.deepEqual(responseLossState, {
    commits: 1,
    events: 1,
    sessions: 1,
    snapshot_available: 1,
    state: "pending",
  });

  const concurrentLaunch = await createLaunch(
    { kind: "project", project_key: "APP", workspace_key: "web" },
    "wp07-concurrent-redeem-launch",
  );
  secrets.push(concurrentLaunch.code);
  const concurrentRedeemKey = "wp07-concurrent-redeem";
  const concurrentRedemptions = await Promise.all([
    request("/api/v1/web-sessions/redeem", {
      body: { launch_code: concurrentLaunch.code },
      headers: { "idempotency-key": concurrentRedeemKey },
      method: "POST",
    }),
    request("/api/v1/web-sessions/redeem", {
      body: { launch_code: concurrentLaunch.code },
      headers: { "idempotency-key": concurrentRedeemKey },
      method: "POST",
    }),
  ]);
  assert.deepEqual(concurrentRedemptions.map((result) => result.response.status), [200, 200]);
  assert.deepEqual(
    concurrentRedemptions.map((result) => result.body.resource.cookie_available).sort(),
    [false, true],
  );
  const concurrentWinnerCookies = concurrentRedemptions
    .map((result) => responseCookies(result.response))
    .find((cookies) => cookies.session !== null);
  assert.equal(typeof concurrentWinnerCookies.session, "string");
  assert.equal(typeof concurrentWinnerCookies.csrf, "string");
  secrets.push(concurrentWinnerCookies.session, concurrentWinnerCookies.csrf);
  const concurrentRedeemState = await db.prepare(
    `SELECT record.state,
            (SELECT COUNT(*) FROM web_sessions
             WHERE created_operation_id = record.operation_id) AS sessions,
            (SELECT COUNT(*) FROM events
             WHERE operation_id = record.operation_id) AS events,
            (SELECT COUNT(*) FROM operation_commits
             WHERE operation_id = record.operation_id) AS commits
     FROM idempotency_records record
     WHERE record.idempotency_key = ?1`,
  ).bind(await sha256Hex(concurrentRedeemKey)).first();
  assert.deepEqual(concurrentRedeemState, { commits: 1, events: 1, sessions: 1, state: "committed" });

  const eventCountBeforeGet = await db.prepare("SELECT COUNT(*) AS count FROM events").first();
  for (let index = 0; index < 2; index += 1) {
    const page = await request(projectLaunch.body.resource.launch_url);
    assert.equal(page.response.status, 200);
    assert.equal(page.response.headers.get("cache-control"), "no-store, no-transform");
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

  const oldSessionCreatedAt = Date.now() - (2 * 24 * 60 * 60 * 1_000);
  await db.prepare(
    `WITH RECURSIVE counter(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM counter WHERE value < 101
     )
     INSERT INTO web_sessions
       (id, token_digest, principal_id, source_kind, source_id, target_kind,
        target_json, expires_at, created_at, created_operation_id)
     SELECT 'wp07-old-session-' || value, printf('%064x', value + 2000), ?1,
            'credential', ?2, 'project_selection',
            json_object('entry_path', '/app', 'kind', 'project_selection'),
            ?3 + 28800000, ?3, 'wp07-old-session-operation-' || value
     FROM counter`,
  ).bind(ids.participantPrincipal, ids.participantCredential, oldSessionCreatedAt).run();
  const projectSession = await redeemLaunch(projectLaunch.code, "wp07-project-redeem");
  secrets.push(projectSession.cookies.session, projectSession.cookies.csrf);
  const oldSessionsAfterCleanup = await db.prepare(
    "SELECT COUNT(*) AS count FROM web_sessions WHERE id LIKE 'wp07-old-session-%'",
  ).first();
  assert.equal(oldSessionsAfterCleanup.count, 1);
  assert.equal(projectSession.body.resource.entry_path, "/app/w/web/p/APP");
  assert.deepEqual(projectSession.body.resource.allowed_scope, { kind: "project", project_id: ids.projectA });
  assert.equal(projectSession.body.resource.principal.is_owner, false);
  assert.equal(typeof projectSession.body.resource.principal.is_owner, "boolean");

  const consumedLaunchPage = await request(projectLaunch.body.resource.launch_url);
  assert.equal(consumedLaunchPage.response.status, 410);
  assert.match(consumedLaunchPage.response.headers.get("content-type"), /^text\/html/u);
  assert.equal(consumedLaunchPage.response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(consumedLaunchPage.response.headers.get("referrer-policy"), "no-referrer");
  assert.doesNotMatch(consumedLaunchPage.body, new RegExp(projectLaunch.code));
  assert.match(consumedLaunchPage.body, /Ask your Agent for a new link/u);
  assert.match(consumedLaunchPage.body, /此浏览器启动链接已失效/u);

  const replayedRedemption = await request("/api/v1/web-sessions/redeem", {
    body: { launch_code: projectLaunch.code },
    headers: { "idempotency-key": "wp07-project-redeem" },
    method: "POST",
  });
  assert.equal(replayedRedemption.response.status, 200);
  assert.equal(replayedRedemption.body.idempotent_replay, true);
  assert.equal(replayedRedemption.body.resource.cookie_available, false);
  assert.equal(replayedRedemption.body.resource.principal.is_owner, false);
  assert.equal(typeof replayedRedemption.body.resource.principal.is_owner, "boolean");
  assert.equal(responseCookies(replayedRedemption.response).session, null);
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, ids.participantGrantA).run();
  try {
    const unauthorizedRedemptionReplay = await request("/api/v1/web-sessions/redeem", {
      body: { launch_code: projectLaunch.code },
      headers: { "idempotency-key": "wp07-project-redeem" },
      method: "POST",
    });
    assert.equal(unauthorizedRedemptionReplay.response.status, 410);
    assert.equal(unauthorizedRedemptionReplay.body.code, "BROWSER_LAUNCH_UNAVAILABLE");
    assert.equal("resource" in unauthorizedRedemptionReplay.body, false);
  } finally {
    await db.prepare(
      `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
         version = version + 1 WHERE id = ?1`,
    ).bind(ids.participantGrantA).run();
  }

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
  await assertRacedWebSessionScope({
    cookies: projectSession.cookies,
    expectedStatus: 401,
    mutate: () => db.prepare(
      "UPDATE web_sessions SET revoked_at = ?1 WHERE id = ?2",
    ).bind(Date.now(), projectSession.body.resource.session_id).run(),
    restore: () => db.prepare(
      "UPDATE web_sessions SET revoked_at = NULL WHERE id = ?1",
    ).bind(projectSession.body.resource.session_id).run(),
  });
  await assertRacedWebSessionScope({
    cookies: projectSession.cookies,
    expectedStatus: 401,
    mutate: (authorizationNow) => db.prepare(
      "UPDATE web_sessions SET expires_at = ?1 WHERE id = ?2",
    ).bind(authorizationNow, projectSession.body.resource.session_id).run(),
    restore: () => db.prepare(
      "UPDATE web_sessions SET expires_at = ?1 WHERE id = ?2",
    ).bind(Date.parse(projectSession.body.resource.expires_at), projectSession.body.resource.session_id).run(),
  });
  await assertRacedWebSessionScope({
    cookies: projectSession.cookies,
    expectedStatus: 401,
    mutate: () => db.prepare(
      `UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2,
         revoke_reason = 'test' WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, ids.participantCredential).run(),
    restore: () => db.prepare(
      `UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL,
         revoke_reason = NULL WHERE id = ?1`,
    ).bind(ids.participantCredential).run(),
  });
  await assertRacedWebSessionScope({
    cookies: projectSession.cookies,
    expectedRole: "reader",
    mutate: () => db.prepare(
      "UPDATE project_grants SET role = 'reader', version = version + 1 WHERE id = ?1",
    ).bind(ids.participantGrantA).run(),
    restore: () => db.prepare(
      "UPDATE project_grants SET role = 'writer', version = version + 1 WHERE id = ?1",
    ).bind(ids.participantGrantA).run(),
  });
  await assertRacedWebSessionScope({
    cookies: projectSession.cookies,
    mutate: () => db.prepare(
      `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
         version = version + 1 WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, ids.participantGrantA).run(),
    restore: () => db.prepare(
      `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
         version = version + 1 WHERE id = ?1`,
    ).bind(ids.participantGrantA).run(),
  });
  await assertRacedWebSessionScope({
    cookies: projectSession.cookies,
    mutate: () => db.prepare(
      "UPDATE projects SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
    ).bind(Date.now(), ids.ownerPrincipal, ids.projectA).run(),
    restore: () => db.prepare(
      "UPDATE projects SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.projectA).run(),
  });
  await assertRacedWebSessionScope({
    cookies: projectSession.cookies,
    mutate: () => db.prepare(
      "UPDATE workspaces SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
    ).bind(Date.now(), ids.ownerPrincipal, ids.workspace).run(),
    restore: () => db.prepare(
      "UPDATE workspaces SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.workspace).run(),
  });
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
  assertSessionCookiesCleared(loggedOutRead.response);

  const issueLaunch = await createLaunch({ identifier: "CFK-1", kind: "issue" }, "wp07-issue-launch");
  secrets.push(issueLaunch.code);
  assert.equal(issueLaunch.body.resource.target.issue_id, ids.issue);
  assert.equal(issueLaunch.body.resource.target.project_id, ids.projectA);
  const issueSession = await redeemLaunch(issueLaunch.code, "wp07-issue-redeem");
  secrets.push(issueSession.cookies.session, issueSession.cookies.csrf);
  assert.equal(issueSession.body.resource.entry_path, "/app/issues/CFK-1");
  assert.equal(issueSession.body.resource.allowed_scope.project_id, ids.projectA);
  await assertRacedWebSessionScope({
    cookies: issueSession.cookies,
    mutate: () => db.prepare(
      "UPDATE issues SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
    ).bind(Date.now(), ids.ownerPrincipal, ids.issue).run(),
    restore: () => db.prepare(
      "UPDATE issues SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.issue).run(),
  });

  const ownerLaunch = await createLaunch(
    { kind: "admin", section: "overview" },
    "wp07-owner-admin-launch",
    ownerHeaders(),
  );
  secrets.push(ownerLaunch.code);
  assert.equal(ownerLaunch.body.resource.target.entry_path, "/app/admin");
  const ownerSession = await redeemLaunch(ownerLaunch.code, "wp07-owner-admin-redeem");
  secrets.push(ownerSession.cookies.session, ownerSession.cookies.csrf);
  assert.equal(ownerSession.body.resource.entry_path, "/app/admin");
  assert.equal(ownerSession.body.resource.target.section, "overview");
  assert.equal(ownerSession.body.resource.principal.is_owner, true);
  assert.equal(typeof ownerSession.body.resource.principal.is_owner, "boolean");
  const ownerSessionView = await request("/api/v1/web-session", {
    headers: { cookie: cookieHeader(ownerSession.cookies) },
  });
  assert.equal(ownerSessionView.body.allowed_scope.kind, "instance");
  assert.equal(ownerSessionView.body.principal.is_owner, true);
  const adminEntryPaths = new Map([
    ["workspaces-projects", "/app/admin?section=workspaces"],
    ["access", "/app/admin?section=access"],
    ["audit", "/app/admin?section=audit"],
  ]);
  for (const [section, entryPath] of adminEntryPaths) {
    const launch = await createLaunch(
      { kind: "admin", section },
      `wp07-owner-admin-${section}-launch`,
      ownerHeaders(),
    );
    secrets.push(launch.code);
    assert.equal(launch.body.resource.target.entry_path, entryPath);
    const redeemed = await redeemLaunch(launch.code, `wp07-owner-admin-${section}-redeem`);
    secrets.push(redeemed.cookies.session, redeemed.cookies.csrf);
    assert.equal(redeemed.body.resource.entry_path, entryPath);
    assert.equal(redeemed.body.resource.target.section, section);
    assert.equal(redeemed.body.resource.allowed_scope.kind, "instance");
  }
  await assertRacedWebSessionScope({
    cookies: ownerSession.cookies,
    expectedStatus: 401,
    expectGrantGuard: false,
    mutate: () => db.prepare(
      "UPDATE web_sessions SET revoked_at = ?1 WHERE id = ?2",
    ).bind(Date.now(), ownerSession.body.resource.session_id).run(),
    restore: () => db.prepare(
      "UPDATE web_sessions SET revoked_at = NULL WHERE id = ?1",
    ).bind(ownerSession.body.resource.session_id).run(),
  });
  await assertRacedWebSessionScope({
    cookies: ownerSession.cookies,
    expectedStatus: 401,
    expectGrantGuard: false,
    mutate: () => db.prepare(
      `UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2,
         revoke_reason = 'test' WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, ids.ownerCredential).run(),
    restore: () => db.prepare(
      `UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL,
         revoke_reason = NULL WHERE id = ?1`,
    ).bind(ids.ownerCredential).run(),
  });

  const ownerIssueLaunch = await createLaunch(
    { identifier: "CFK-1", kind: "issue" },
    "wp07-owner-issue-launch",
    ownerHeaders(),
  );
  secrets.push(ownerIssueLaunch.code);
  const ownerIssueSession = await redeemLaunch(ownerIssueLaunch.code, "wp07-owner-issue-redeem");
  secrets.push(ownerIssueSession.cookies.session, ownerIssueSession.cookies.csrf);
  const fixedOwnerCreateWorkspace = await request("/api/v1/workspaces", {
    body: { display_name: "Must stay fixed", key: "fixed-owner-session" },
    headers: cookieWriteHeaders(ownerIssueSession.cookies, {
      "idempotency-key": "wp07-fixed-owner-create-workspace",
    }),
    method: "POST",
  });
  assert.equal(fixedOwnerCreateWorkspace.response.status, 403);
  assert.equal(fixedOwnerCreateWorkspace.body.code, "FORBIDDEN");
  await assertRacedWebSessionScope({
    cookies: ownerIssueSession.cookies,
    expectGrantGuard: false,
    mutate: () => db.prepare(
      "UPDATE issues SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
    ).bind(Date.now(), ids.ownerPrincipal, ids.issue).run(),
    restore: () => db.prepare(
      "UPDATE issues SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.issue).run(),
  });

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
  assertSessionCookiesCleared(invalidatedBySource.response);
  const invalidatedSourceReplay = await request("/api/v1/web-sessions/redeem", {
    body: { launch_code: sourceLaunch.code },
    headers: { "idempotency-key": "wp07-source-revoke-redeem" },
    method: "POST",
  });
  assert.equal(invalidatedSourceReplay.response.status, 410);
  assert.equal(invalidatedSourceReplay.body.code, "BROWSER_LAUNCH_UNAVAILABLE");
  assert.equal("resource" in invalidatedSourceReplay.body, false);
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

  const oldChallengeCreatedAt = Date.now() - (10 * 60 * 1_000);
  await db.prepare(
    `WITH RECURSIVE counter(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM counter WHERE value < 101
     )
     INSERT INTO webauthn_challenges
       (id, challenge_digest, purpose, principal_id, rp_id, expected_origin,
        expires_at, created_at)
     SELECT 'wp07-expired-challenge-' || value, printf('%064x', value + 3000),
            'authentication', NULL, ?1, ?2, ?3 + 300000, ?3
     FROM counter`,
  ).bind(rpId, origin, oldChallengeCreatedAt).run();
  const consumedChallengeCreatedAt = Date.now() - 1_000;
  await db.prepare(
    `WITH RECURSIVE counter(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM counter WHERE value < 101
     )
     INSERT INTO webauthn_challenges
       (id, challenge_digest, purpose, principal_id, rp_id, expected_origin,
        expires_at, consumed_at, created_at)
     SELECT 'wp07-consumed-challenge-' || value, printf('%064x', value + 4000),
            'authentication', NULL, ?1, ?2, ?3 + 300000, ?3, ?3 - 1
     FROM counter`,
  ).bind(rpId, origin, consumedChallengeCreatedAt).run();
  const ecPrivateLabel = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -7,
    [[-4, new Uint8Array(32).fill(0x5a)]],
    "wp07-reject-ec-private-cose-label",
  );
  secrets.push(ecPrivateLabel.options.body.public_key.challenge, ecPrivateLabel.fixture.publicKeyCose);
  const oldChallengesAfterCleanup = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM webauthn_challenges WHERE id LIKE 'wp07-expired-challenge-%') AS expired,
       (SELECT COUNT(*) FROM webauthn_challenges WHERE id LIKE 'wp07-consumed-challenge-%') AS consumed`,
  ).first();
  assert.deepEqual(oldChallengesAfterCleanup, { consumed: 1, expired: 1 });
  const rsaPrivateLabel = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -257,
    [[-3, new Uint8Array(128).fill(0x6b)]],
    "wp07-reject-rsa-private-cose-label",
  );
  secrets.push(rsaPrivateLabel.options.body.public_key.challenge, rsaPrivateLabel.fixture.publicKeyCose);
  const duplicateCoseLabel = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -7,
    [[-2, new Uint8Array(32).fill(0x4d)]],
    "wp07-reject-duplicate-cose-label",
    true,
  );
  secrets.push(duplicateCoseLabel.options.body.public_key.challenge, duplicateCoseLabel.fixture.publicKeyCose);
  const stringCoseLabel = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -7,
    [["-4", new Uint8Array(32).fill(0x5e)]],
    "wp07-reject-string-cose-label",
  );
  secrets.push(stringCoseLabel.options.body.public_key.challenge, stringCoseLabel.fixture.publicKeyCose);
  const unknownCoseLabel = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -7,
    [[99, 1]],
    "wp07-reject-unknown-cose-label",
  );
  secrets.push(unknownCoseLabel.options.body.public_key.challenge, unknownCoseLabel.fixture.publicKeyCose);
  const nonIntegerCoseLabel = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -7,
    [[true, 1]],
    "wp07-reject-noninteger-cose-label",
  );
  secrets.push(nonIntegerCoseLabel.options.body.public_key.challenge, nonIntegerCoseLabel.fixture.publicKeyCose);
  const invalidEcPoint = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -7,
    [
      [-2, new Uint8Array(32)],
      [-3, new Uint8Array(32)],
    ],
    "wp07-reject-invalid-ec-public-key",
  );
  secrets.push(invalidEcPoint.options.body.public_key.challenge, invalidEcPoint.fixture.publicKeyCose);
  const invalidRsaKey = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -257,
    [
      [-1, new Uint8Array(256)],
      [-2, Uint8Array.of(0)],
    ],
    "wp07-reject-invalid-rsa-public-key",
  );
  secrets.push(invalidRsaKey.options.body.public_key.challenge, invalidRsaKey.fixture.publicKeyCose);
  for (const [name, exponent] of [
    ["zero", Uint8Array.of(0)],
    ["one", Uint8Array.of(1)],
    ["two", Uint8Array.of(2)],
    ["four", Uint8Array.of(4)],
    ["leading-zero", Uint8Array.of(0, 1, 0, 1)],
    ["nine-byte", Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 3)],
  ]) {
    const rejectedExponent = await rejectRegistrationWithExtraCose(
      registrationSession.cookies,
      -257,
      [[-2, exponent]],
      `wp07-reject-rsa-${name}-exponent`,
    );
    secrets.push(
      rejectedExponent.options.body.public_key.challenge,
      rejectedExponent.fixture.publicKeyCose,
    );
  }
  const shortRsaModulus = new Uint8Array(256).fill(0xff);
  shortRsaModulus[0] = 0x7f;
  const invalidRsaBitLength = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -257,
    [[-1, shortRsaModulus]],
    "wp07-reject-short-rsa-modulus",
  );
  secrets.push(
    invalidRsaBitLength.options.body.public_key.challenge,
    invalidRsaBitLength.fixture.publicKeyCose,
  );
  const evenRsaModulus = new Uint8Array(256).fill(0xff);
  evenRsaModulus[0] = 0x80;
  evenRsaModulus[evenRsaModulus.length - 1] = 0xfe;
  const invalidEvenRsaModulus = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -257,
    [[-1, evenRsaModulus]],
    "wp07-reject-even-rsa-modulus",
  );
  secrets.push(
    invalidEvenRsaModulus.options.body.public_key.challenge,
    invalidEvenRsaModulus.fixture.publicKeyCose,
  );
  const oversizedRsaModulus = new Uint8Array(513).fill(0xff);
  oversizedRsaModulus[0] = 0x80;
  const invalidOversizedRsaModulus = await rejectRegistrationWithExtraCose(
    registrationSession.cookies,
    -257,
    [[-1, oversizedRsaModulus]],
    "wp07-reject-oversized-rsa-modulus",
  );
  secrets.push(
    invalidOversizedRsaModulus.options.body.public_key.challenge,
    invalidOversizedRsaModulus.fixture.publicKeyCose,
  );
  const unknownRegistrationField = "wp07-unknown-registration-response-field";
  const unknownRegistration = await rejectRegistrationWithCredentialMutation(
    registrationSession.cookies,
    (credential) => {
      credential.response.unexpected = unknownRegistrationField;
    },
    "wp07-reject-unknown-registration-field",
  );
  assert.equal(JSON.stringify(unknownRegistration.rejected.body).includes(unknownRegistrationField), false);
  secrets.push(unknownRegistration.options.body.public_key.challenge, unknownRegistrationField);

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

  const duplicateOptions = await registrationOptions(registrationSession.cookies);
  secrets.push(duplicateOptions.body.public_key.challenge);
  const duplicateFixture = await createRegistrationFixture({
    algorithm: -7,
    challenge: duplicateOptions.body.public_key.challenge,
    credentialIdBytes: es.fixture.credentialIdBytes,
    origin,
    rpId,
  });
  const duplicateRegistration = await request("/api/v1/me/passkeys", {
    body: {
      challenge_id: duplicateOptions.body.challenge_id,
      credential: duplicateFixture.registrationCredential,
    },
    headers: cookieWriteHeaders(registrationSession.cookies, {
      "idempotency-key": "wp07-register-duplicate-credential",
    }),
    method: "POST",
  });
  assert.equal(duplicateRegistration.response.status, 409);
  assert.equal(duplicateRegistration.body.code, "PASSKEY_ALREADY_REGISTERED");
  const duplicateChallenge = await db.prepare(
    "SELECT consumed_at FROM webauthn_challenges WHERE id = ?1",
  ).bind(duplicateOptions.body.challenge_id).first();
  assert.equal(typeof duplicateChallenge.consumed_at, "number");
  const duplicateChallengeReuse = await request("/api/v1/me/passkeys", {
    body: {
      challenge_id: duplicateOptions.body.challenge_id,
      credential: duplicateFixture.registrationCredential,
    },
    headers: cookieWriteHeaders(registrationSession.cookies, {
      "idempotency-key": "wp07-reuse-duplicate-challenge",
    }),
    method: "POST",
  });
  assert.equal(duplicateChallengeReuse.response.status, 409);
  assert.equal(duplicateChallengeReuse.body.code, "PASSKEY_CHALLENGE_INVALID");

  const limitOptions = await registrationOptions(registrationSession.cookies);
  secrets.push(limitOptions.body.public_key.challenge);
  const limitFixture = await createRegistrationFixture({
    algorithm: -7,
    challenge: limitOptions.body.public_key.challenge,
    origin,
    rpId,
  });
  await db.prepare(
    `WITH RECURSIVE counter(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM counter WHERE value < 98
     )
     INSERT INTO web_authenticators
       (id, principal_id, credential_id, public_key_cose, algorithm, user_handle,
        sign_count, backup_eligible, backup_state, rp_id, version, created_at,
        created_operation_id)
     SELECT 'wp07-limit-' || value, ?1, 'wp07-limit-credential-' || value,
            'public-only-test-fixture', -7, ?2, 0, 0, 0, ?3, 1, ?4,
            'wp07-limit-operation-' || value
     FROM counter`,
  ).bind(
    ids.participantPrincipal,
    principalUserHandle(ids.participantPrincipal),
    rpId,
    Date.now(),
  ).run();
  try {
    const limitRegistration = await request("/api/v1/me/passkeys", {
      body: {
        challenge_id: limitOptions.body.challenge_id,
        credential: limitFixture.registrationCredential,
      },
      headers: cookieWriteHeaders(registrationSession.cookies, {
        "idempotency-key": "wp07-register-at-passkey-limit",
      }),
      method: "POST",
    });
    assert.equal(limitRegistration.response.status, 409);
    assert.equal(limitRegistration.body.code, "PASSKEY_LIMIT_REACHED");
    const limitChallenge = await db.prepare(
      "SELECT consumed_at FROM webauthn_challenges WHERE id = ?1",
    ).bind(limitOptions.body.challenge_id).first();
    assert.equal(typeof limitChallenge.consumed_at, "number");
  } finally {
    await db.prepare("DELETE FROM web_authenticators WHERE id LIKE 'wp07-limit-%'").run();
  }
  const limitChallengeReuse = await request("/api/v1/me/passkeys", {
    body: {
      challenge_id: limitOptions.body.challenge_id,
      credential: limitFixture.registrationCredential,
    },
    headers: cookieWriteHeaders(registrationSession.cookies, {
      "idempotency-key": "wp07-reuse-limit-challenge",
    }),
    method: "POST",
  });
  assert.equal(limitChallengeReuse.response.status, 409);
  assert.equal(limitChallengeReuse.body.code, "PASSKEY_CHALLENGE_INVALID");

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

  const backupEligibilityOptions = await authenticationOptions();
  secrets.push(backupEligibilityOptions.body.public_key.challenge);
  const backupEligibilityCredential = await createAssertionCredential({
    ...es.fixture,
    backupEligible: true,
    backupState: true,
    challenge: backupEligibilityOptions.body.public_key.challenge,
    origin,
    rpId,
    signCount: 1,
    userHandle: principalUserHandle(ids.participantPrincipal),
  });
  const backupEligibilityChanged = await request("/api/v1/web-authentication/verify", {
    body: {
      challenge_id: backupEligibilityOptions.body.challenge_id,
      credential: backupEligibilityCredential,
    },
    headers: { "idempotency-key": "wp07-reject-backup-eligibility-change" },
    method: "POST",
  });
  assert.equal(backupEligibilityChanged.response.status, 401);
  assert.equal(backupEligibilityChanged.body.code, "UNAUTHORIZED");
  const backupEligibilityState = await db.prepare(
    `SELECT
       (SELECT consumed_at FROM webauthn_challenges WHERE id = ?1) AS consumed_at,
       (SELECT backup_eligible FROM web_authenticators WHERE id = ?2) AS backup_eligible,
       (SELECT backup_state FROM web_authenticators WHERE id = ?2) AS backup_state,
       (SELECT sign_count FROM web_authenticators WHERE id = ?2) AS sign_count,
       (SELECT version FROM web_authenticators WHERE id = ?2) AS version`,
  ).bind(backupEligibilityOptions.body.challenge_id, es.registered.body.resource.id).first();
  assert.equal(typeof backupEligibilityState.consumed_at, "number");
  assert.deepEqual(
    {
      backup_eligible: backupEligibilityState.backup_eligible,
      backup_state: backupEligibilityState.backup_state,
      sign_count: backupEligibilityState.sign_count,
      version: backupEligibilityState.version,
    },
    { backup_eligible: 0, backup_state: 0, sign_count: 0, version: 1 },
  );

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
  assert.equal(esAuthentication.verified.body.resource.principal.is_owner, false);
  assert.equal(typeof esAuthentication.verified.body.resource.principal.is_owner, "boolean");
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
  await assertRacedWebSessionScope({
    cookies: esSessionCookies,
    expectedStatus: 401,
    mutate: () => db.prepare(
      `UPDATE web_authenticators SET revoked_at = ?1, revoked_by_principal_id = ?2
       WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, es.registered.body.resource.id).run(),
    restore: () => db.prepare(
      `UPDATE web_authenticators SET revoked_at = NULL, revoked_by_principal_id = NULL
       WHERE id = ?1`,
    ).bind(es.registered.body.resource.id).run(),
  });
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

  const equalizedUnknownOptions = await authenticationOptions();
  secrets.push(equalizedUnknownOptions.body.public_key.challenge);
  const equalizedUnknownCredential = await createAssertionCredential({
    ...limitFixture,
    challenge: equalizedUnknownOptions.body.public_key.challenge,
    origin,
    rpId,
    signCount: 2,
    userHandle: principalUserHandle(ids.participantPrincipal),
  });
  const originalVerify = crypto.subtle.verify;
  let unknownCredentialVerifyCalls = 0;
  crypto.subtle.verify = (...arguments_) => {
    unknownCredentialVerifyCalls += 1;
    return originalVerify.call(crypto.subtle, ...arguments_);
  };
  try {
    await assert.rejects(
      verifyWebAuthenticationService(
        db,
        new Request(`${origin}/api/v1/web-authentication/verify`, {
          headers: { "idempotency-key": "wp07-equalize-unknown-credential" },
          method: "POST",
        }),
        equalizedUnknownOptions.body.challenge_id,
        equalizedUnknownCredential,
        Date.now(),
      ),
      (error) => error?.code === "UNAUTHORIZED" && error?.status === 401,
    );
  } finally {
    crypto.subtle.verify = originalVerify;
  }
  assert.equal(unknownCredentialVerifyCalls, 2);
  const equalizedUnknownState = await db.prepare(
    `SELECT
       (SELECT consumed_at FROM webauthn_challenges WHERE id = ?1) AS consumed_at,
       (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?2) AS records`,
  ).bind(
    equalizedUnknownOptions.body.challenge_id,
    await sha256Hex("wp07-equalize-unknown-credential"),
  ).first();
  assert.equal(typeof equalizedUnknownState.consumed_at, "number");
  assert.equal(equalizedUnknownState.records, 0);

  const unknownAuthenticationFieldOptions = await authenticationOptions();
  secrets.push(unknownAuthenticationFieldOptions.body.public_key.challenge);
  const unknownAuthenticationFieldCredential = await createAssertionCredential({
    ...es.fixture,
    challenge: unknownAuthenticationFieldOptions.body.public_key.challenge,
    origin,
    rpId,
    signCount: 2,
    userHandle: principalUserHandle(ids.participantPrincipal),
  });
  const unknownAuthenticationField = "wp07-unknown-authentication-credential-field";
  unknownAuthenticationFieldCredential.unexpected = unknownAuthenticationField;
  const esBeforeUnknownField = await db.prepare(
    "SELECT backup_eligible, backup_state, sign_count, version FROM web_authenticators WHERE id = ?1",
  ).bind(es.registered.body.resource.id).first();
  const unknownAuthenticationFieldFailure = await request("/api/v1/web-authentication/verify", {
    body: {
      challenge_id: unknownAuthenticationFieldOptions.body.challenge_id,
      credential: unknownAuthenticationFieldCredential,
    },
    headers: { "idempotency-key": "wp07-reject-unknown-authentication-field" },
    method: "POST",
  });
  assert.equal(unknownAuthenticationFieldFailure.response.status, 401);
  assert.equal(unknownAuthenticationFieldFailure.body.code, "UNAUTHORIZED");
  assert.equal(JSON.stringify(unknownAuthenticationFieldFailure.body).includes(unknownAuthenticationField), false);
  const unknownAuthenticationFieldState = await db.prepare(
    `SELECT
       (SELECT consumed_at FROM webauthn_challenges WHERE id = ?1) AS consumed_at,
       (SELECT backup_eligible FROM web_authenticators WHERE id = ?2) AS backup_eligible,
       (SELECT backup_state FROM web_authenticators WHERE id = ?2) AS backup_state,
       (SELECT sign_count FROM web_authenticators WHERE id = ?2) AS sign_count,
       (SELECT version FROM web_authenticators WHERE id = ?2) AS version,
       (SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key = ?3) AS idempotency_records`,
  ).bind(
    unknownAuthenticationFieldOptions.body.challenge_id,
    es.registered.body.resource.id,
    await sha256Hex("wp07-reject-unknown-authentication-field"),
  ).first();
  assert.equal(typeof unknownAuthenticationFieldState.consumed_at, "number");
  assert.deepEqual(
    {
      backup_eligible: unknownAuthenticationFieldState.backup_eligible,
      backup_state: unknownAuthenticationFieldState.backup_state,
      sign_count: unknownAuthenticationFieldState.sign_count,
      version: unknownAuthenticationFieldState.version,
    },
    esBeforeUnknownField,
  );
  assert.equal(unknownAuthenticationFieldState.idempotency_records, 0);
  secrets.push(unknownAuthenticationField);

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

  const concurrentPasskeyOptions = await registrationOptions(registrationSession.cookies);
  secrets.push(concurrentPasskeyOptions.body.public_key.challenge);
  const concurrentPasskey = await registerFixture(
    registrationSession.cookies,
    concurrentPasskeyOptions,
    -7,
    "wp07-register-concurrent-passkey",
  );
  const concurrentAuthenticationOptions = await authenticationOptions();
  secrets.push(concurrentAuthenticationOptions.body.public_key.challenge);
  const concurrentAssertion = await createAssertionCredential({
    ...concurrentPasskey.fixture,
    challenge: concurrentAuthenticationOptions.body.public_key.challenge,
    origin,
    rpId,
    signCount: 1,
    userHandle: principalUserHandle(ids.participantPrincipal),
  });
  const concurrentAuthenticationKey = "wp07-concurrent-passkey-authentication";
  const concurrentAuthentications = await Promise.all([
    request("/api/v1/web-authentication/verify", {
      body: {
        challenge_id: concurrentAuthenticationOptions.body.challenge_id,
        credential: concurrentAssertion,
      },
      headers: { "idempotency-key": concurrentAuthenticationKey },
      method: "POST",
    }),
    request("/api/v1/web-authentication/verify", {
      body: {
        challenge_id: concurrentAuthenticationOptions.body.challenge_id,
        credential: concurrentAssertion,
      },
      headers: { "idempotency-key": concurrentAuthenticationKey },
      method: "POST",
    }),
  ]);
  assert.deepEqual(concurrentAuthentications.map((result) => result.response.status), [200, 200]);
  assert.deepEqual(
    concurrentAuthentications.map((result) => result.body.resource.cookie_available).sort(),
    [false, true],
  );
  const concurrentAuthenticationCookies = concurrentAuthentications
    .map((result) => responseCookies(result.response))
    .find((cookies) => cookies.session !== null);
  assert.equal(typeof concurrentAuthenticationCookies.session, "string");
  assert.equal(typeof concurrentAuthenticationCookies.csrf, "string");
  secrets.push(concurrentAuthenticationCookies.session, concurrentAuthenticationCookies.csrf);
  const concurrentAuthenticationState = await db.prepare(
    `SELECT record.state,
            (SELECT COUNT(*) FROM web_sessions
             WHERE created_operation_id = record.operation_id) AS sessions,
            (SELECT COUNT(*) FROM events
             WHERE operation_id = record.operation_id) AS events,
            (SELECT COUNT(*) FROM operation_commits
             WHERE operation_id = record.operation_id) AS commits,
            (SELECT sign_count FROM web_authenticators WHERE id = ?2) AS sign_count,
            (SELECT version FROM web_authenticators WHERE id = ?2) AS version
     FROM idempotency_records record
     WHERE record.idempotency_key = ?1`,
  ).bind(
    await sha256Hex(concurrentAuthenticationKey),
    concurrentPasskey.registered.body.resource.id,
  ).first();
  assert.deepEqual(concurrentAuthenticationState, {
    commits: 1,
    events: 1,
    sessions: 1,
    sign_count: 1,
    state: "committed",
    version: 2,
  });

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
  assertSessionCookiesCleared(selfRevokedSession.response);

  const participantBeforeOwnerRevoke = await request(
    `/api/v1/admin/principals/${ids.participantPrincipal}`,
    { headers: ownerHeaders() },
  );
  assert.equal(participantBeforeOwnerRevoke.response.status, 200);
  assert.equal(participantBeforeOwnerRevoke.body.passkeys_has_more, false);
  const discoveredParticipantPasskey = participantBeforeOwnerRevoke.body.passkeys.find(
    (passkey) => passkey.id === rsa.registered.body.resource.id,
  );
  assert.deepEqual(discoveredParticipantPasskey.allowed_actions, ["revoke"]);
  const participantCredentialSnapshot = participantBeforeOwnerRevoke.body.credentials;
  const participantGrantSnapshot = participantBeforeOwnerRevoke.body.grants;
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
  assertSessionCookiesCleared(ownerRevokedSession.response);
  const participantAfterOwnerRevoke = await request(
    `/api/v1/admin/principals/${ids.participantPrincipal}`,
    { headers: ownerHeaders() },
  );
  assert.equal(participantAfterOwnerRevoke.response.status, 200);
  const revokedParticipantPasskey = participantAfterOwnerRevoke.body.passkeys.find(
    (passkey) => passkey.id === rsa.registered.body.resource.id,
  );
  assert.equal(revokedParticipantPasskey, undefined);
  assert.deepEqual(participantAfterOwnerRevoke.body.credentials, participantCredentialSnapshot);
  assert.deepEqual(participantAfterOwnerRevoke.body.grants, participantGrantSnapshot);

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
