import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import {
  authenticateBearer,
  authenticateCookieSession,
  authenticateRequest,
  SESSION_COOKIE_NAME,
} from "../../apps/worker/src/kernel/auth.ts";
import { CSRF_COOKIE_NAME, enforceCookieWriteProtection } from "../../apps/worker/src/kernel/csrf.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import {
  AtomicBatchRejectedError,
  executeAtomicBatch,
  lookupOpaqueResourceId,
} from "../../apps/worker/src/kernel/d1.ts";
import {
  claimIdempotency,
  finalizeIdempotency,
  runIdempotentOperation,
} from "../../apps/worker/src/kernel/idempotency.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const now = 1_787_966_400_000;
const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  participant: "22222222-2222-4222-8222-222222222222",
  project: "44444444-4444-4444-8444-444444444444",
  workspace: "33333333-3333-4333-8333-333333333333",
};
const activeToken = `cfk_v1_live_${"A".repeat(43)}`;
const revokedToken = `cfk_v1_old_${"B".repeat(43)}`;
const unknownToken = `cfk_v1_none_${"C".repeat(43)}`;
const sessionToken = "S".repeat(43);
const expiredSessionToken = "E".repeat(43);
const revokedSourceSessionToken = "R".repeat(43);

const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});

let db;

function errorShape(error) {
  return {
    category: error.category,
    code: error.code,
    details: error.details,
    message: error.message,
    recovery: error.recovery,
    retryable: error.retryable,
    status: error.status,
  };
}

async function captureFailure(action) {
  try {
    await action();
  } catch (error) {
    return errorShape(error);
  }
  assert.fail("Expected operation to fail");
}

async function seedDatabase() {
  const activeDigest = await sha256Hex(activeToken);
  const revokedDigest = await sha256Hex(revokedToken);
  const sessionDigest = await sha256Hex(sessionToken);
  const expiredSessionDigest = await sha256Hex(expiredSessionToken);
  const revokedSourceSessionDigest = await sha256Hex(revokedSourceSessionToken);
  await db.batch([
    db.prepare(
      "INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?1, 'Owner', ?2, ?2)",
    ).bind(ids.owner, now),
    db.prepare(
      "INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?1, 'Participant', ?2, ?2)",
    ).bind(ids.participant, now),
    db.prepare(
      "INSERT INTO instance_meta VALUES (1, 'instance-wp02-test', ?1, '0.1.0', 1, ?2)",
    ).bind(ids.owner, now),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
       VALUES ('credential-active', ?1, 'live', ?2, ?3, 'seed-credential-active')`,
    ).bind(ids.owner, activeDigest, now),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, revoked_at,
         revoked_by_principal_id, revoke_reason, created_operation_id)
       VALUES ('credential-revoked', ?1, 'old', ?2, ?3, ?3, ?1, 'test', 'seed-credential-revoked')`,
    ).bind(ids.owner, revokedDigest, now),
    db.prepare(
      `INSERT INTO workspaces
        (id, key, display_name, created_at, updated_at, created_by_principal_id,
         updated_by_principal_id, created_operation_id)
       VALUES (?1, 'validation', 'Validation', ?2, ?2, ?3, ?3, 'seed-workspace')`,
    ).bind(ids.workspace, now, ids.owner),
    db.prepare(
      `INSERT INTO projects
        (id, workspace_id, key, display_name, created_at, updated_at,
         created_by_principal_id, updated_by_principal_id, created_operation_id)
       VALUES (?1, ?2, 'CORE', 'Core', ?3, ?3, ?4, ?4, 'seed-project')`,
    ).bind(ids.project, ids.workspace, now, ids.owner),
    db.prepare(
      "INSERT INTO project_usage VALUES (?1, 0, 0, 0, ?2, 'seed-usage')",
    ).bind(ids.project, now),
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id, target_kind,
         target_json, expires_at, created_at)
       VALUES ('session-active', ?1, ?2, 'credential', 'credential-active',
               'project', ?3, ?4, ?5)`,
    ).bind(sessionDigest, ids.owner, JSON.stringify({ project_id: ids.project }), now + 60_000, now),
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id, target_kind,
         target_json, expires_at, created_at)
       VALUES ('session-expired', ?1, ?2, 'credential', 'credential-active',
               'project', ?3, ?4, ?5)`,
    ).bind(expiredSessionDigest, ids.owner, JSON.stringify({ project_id: ids.project }), now - 1, now - 60_000),
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id, target_kind,
         target_json, expires_at, created_at)
       VALUES ('session-revoked-source', ?1, ?2, 'credential', 'credential-revoked',
               'project', ?3, ?4, ?5)`,
    ).bind(revokedSourceSessionDigest, ids.owner, JSON.stringify({ project_id: ids.project }), now + 60_000, now),
  ]);
}

before(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  ({ DB: db } = await worker.getEnv());
  await seedDatabase();
});

after(async () => {
  await server.close();
});

function assertRequestId(response, body = null) {
  const requestId = response.headers.get("x-request-id");
  assert.match(requestId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  if (body !== null) assert.equal(body.request_id, requestId);
}

test("production Worker serves health/OpenAPI, structured misses, and Static Assets", async () => {
  const health = await server.fetch("/healthz");
  assert.equal(health.status, 200);
  assertRequestId(health);
  assert.deepEqual(await health.json(), {
    d1: "reachable",
    schema_version: 1,
    service_version: "0.1.0",
  });

  const openapi = await server.fetch("/openapi.json");
  assert.equal(openapi.status, 200);
  assertRequestId(openapi);
  assert.equal((await openapi.json()).openapi, "3.1.0");

  const missing = await server.fetch("/api/v1/not-implemented");
  const missingBody = await missing.json();
  assert.equal(missing.status, 404);
  assertRequestId(missing, missingBody);
  assert.equal(missingBody.code, "NOT_FOUND");
  assert.equal(missingBody.category, "not_found");

  const asset = await server.fetch("/");
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /<div id="app"><\/div>/);
});

test("oversized JSON returns a redacted 413 and Worker logs retain no request secrets", async () => {
  server.clearLogs();
  const bodySecret = `cfk_v1_body_${"Z".repeat(43)}`;
  const response = await server.fetch("/api/v1/not-implemented", {
    body: JSON.stringify({ credential: bodySecret, padding: "x".repeat(132_000) }),
    headers: {
      authorization: `Bearer ${activeToken}`,
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
    method: "POST",
  });
  const responseText = await response.text();
  const responseBody = JSON.parse(responseText);
  assert.equal(response.status, 413);
  assertRequestId(response, responseBody);
  assert.equal(responseBody.code, "PAYLOAD_TOO_LARGE");
  const observable = `${responseText}\n${JSON.stringify(server.getLogs())}`;
  for (const secret of [activeToken, sessionToken, bodySecret]) {
    assert.doesNotMatch(observable, new RegExp(secret));
  }
});

test("Bearer format, unknown digest, and revoked Credential share one 401 result", async () => {
  const failures = await Promise.all([
    captureFailure(() => authenticateBearer(db, "Bearer malformed")),
    captureFailure(() => authenticateBearer(db, `Bearer ${unknownToken}`)),
    captureFailure(() => authenticateBearer(db, `Bearer ${revokedToken}`)),
  ]);
  assert.deepEqual(failures[0], failures[1]);
  assert.deepEqual(failures[1], failures[2]);
  assert.equal(failures[0].code, "UNAUTHORIZED");

  const authenticated = await authenticateBearer(db, `Bearer ${activeToken}`);
  assert.equal(authenticated.principalId, ids.owner);
  assert.equal(authenticated.isOwner, true);
  assert.equal(authenticated.credentialFingerprint, "cfk_v1_live_…");
  assert.doesNotMatch(JSON.stringify(authenticated), new RegExp(activeToken));
  assert.doesNotMatch(JSON.stringify(authenticated), /^[0-9a-f]{64}$/i);
});

test("Cookie Session requires an active session, Principal, and active source", async () => {
  const makeRequest = (token) => new Request("https://kanban.example.test/api/v1/test", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  const valid = await authenticateCookieSession(db, makeRequest(sessionToken), now);
  assert.equal(valid.sessionId, "session-active");
  assert.equal(valid.sourceId, "credential-active");

  const failures = await Promise.all([
    captureFailure(() => authenticateCookieSession(db, makeRequest("U".repeat(43)), now)),
    captureFailure(() => authenticateCookieSession(db, makeRequest(expiredSessionToken), now)),
    captureFailure(() => authenticateCookieSession(db, makeRequest(revokedSourceSessionToken), now)),
  ]);
  assert.deepEqual(failures[0], failures[1]);
  assert.deepEqual(failures[1], failures[2]);
  assert.equal(failures[0].code, "UNAUTHORIZED");
});

test("actual auth selection and Cookie Origin/CSRF matrix keep Bearer independent", async () => {
  const csrf = "Q".repeat(43);
  const validCookieRequest = new Request("https://kanban.example.test/api/v1/test", {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrf}`,
      origin: "https://kanban.example.test",
      "x-csrf-token": csrf,
    },
    method: "POST",
  });
  const cookieAuth = await authenticateRequest(db, validCookieRequest, now);
  assert.equal(cookieAuth.kind, "cookie");
  assert.doesNotThrow(() => enforceCookieWriteProtection(validCookieRequest, cookieAuth));

  for (const headers of [
    { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrf}`, "x-csrf-token": csrf },
    { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrf}`, origin: "https://evil.example", "x-csrf-token": csrf },
    { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrf}`, origin: "https://kanban.example.test", "x-csrf-token": "X".repeat(43) },
  ]) {
    const request = new Request("https://kanban.example.test/api/v1/test", { headers, method: "POST" });
    const auth = await authenticateRequest(db, request, now);
    assert.throws(() => enforceCookieWriteProtection(request, auth), (error) => error.code === "FORBIDDEN");
  }

  const bearerRequest = new Request("https://kanban.example.test/api/v1/test", {
    headers: {
      authorization: `Bearer ${activeToken}`,
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=wrong`,
    },
    method: "POST",
  });
  const bearerAuth = await authenticateRequest(db, bearerRequest, now);
  assert.equal(bearerAuth.kind, "bearer");
  assert.doesNotThrow(() => enforceCookieWriteProtection(bearerRequest, bearerAuth));
});

test("bound values and SQL-fragment allowlists do not interpret untrusted SQL", async () => {
  assert.equal(await lookupOpaqueResourceId(db, "principal", ids.owner), ids.owner);
  assert.equal(await lookupOpaqueResourceId(db, "principal", "' OR 1=1 --"), null);
  await assert.rejects(
    lookupOpaqueResourceId(db, "principal; DROP TABLE principals", ids.owner),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.equal(await lookupOpaqueResourceId(db, "principal", ids.owner), ids.owner);
});

function prepareAtomicIssue({ operationId, issueId, stateGuard = 1, title }) {
  const eventId = crypto.randomUUID();
  const statements = [
    db.prepare(
      `UPDATE project_usage
       SET active_issue_count = active_issue_count + 1,
           updated_at = ?1, last_operation_id = ?2
       WHERE project_id = ?3
         AND EXISTS (
           SELECT 1
           FROM credentials AS c
           JOIN instance_meta AS im ON im.singleton = 1
           WHERE c.id = 'credential-active'
             AND c.principal_id = im.owner_principal_id
             AND c.revoked_at IS NULL
         )`,
    ).bind(now, operationId, ids.project),
    db.prepare(
      `INSERT INTO issues
        (id, project_id, title, title_search, created_at, updated_at,
         created_by_principal_id, updated_by_principal_id,
         created_operation_id, last_operation_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6, ?6, ?7, ?7
       FROM project_usage
       WHERE project_id = ?2 AND last_operation_id = ?7 AND ?8 = 1`,
    ).bind(issueId, ids.project, title, title.toLowerCase(), now, ids.owner, operationId, stateGuard),
    db.prepare(
      `INSERT INTO events
        (id, stream, type, operation_id, event_index, actor_principal_id,
         actor_credential_id, authorized_via, workspace_id, project_id,
         subject_type, subject_id, payload_json, created_at)
       SELECT ?1, 'domain', 'kernel.issue-created', ?2, 0, ?3,
              'credential-active', 'deployment_owner', ?4, ?5,
              'issue', id, '{}', ?6
       FROM issues
       WHERE created_operation_id = ?2`,
    ).bind(eventId, operationId, ids.owner, ids.workspace, ids.project, now),
  ];
  return {
    businessStatements: statements,
    committedAt: now,
    expectedEventCount: 1,
    operationId,
    primarySubjectId: issueId,
    primarySubjectType: "issue",
  };
}

async function createAtomicIssue(operationId, title, stateGuard = 1) {
  const issueId = crypto.randomUUID();
  return executeAtomicBatch(db, prepareAtomicIssue({ issueId, operationId, stateGuard, title }));
}

async function countsForOperation(operationId) {
  return db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM issues WHERE created_operation_id = ?1) AS issues,
      (SELECT COUNT(*) FROM events WHERE operation_id = ?1) AS events,
      (SELECT COUNT(*) FROM operation_commits WHERE operation_id = ?1) AS commits,
      (SELECT active_issue_count FROM project_usage WHERE project_id = ?2) AS active_issues`,
  ).bind(operationId, ids.project).first();
}

test("real env.DB.batch commits resource/Event/sentinel and rolls back an earlier counter on guard failure", async () => {
  const successfulOperation = crypto.randomUUID();
  const before = await countsForOperation(successfulOperation);
  const success = await createAtomicIssue(successfulOperation, "Atomic success");
  const afterSuccess = await countsForOperation(successfulOperation);
  assert.equal(success.recovered, false);
  assert.deepEqual(
    { issues: afterSuccess.issues, events: afterSuccess.events, commits: afterSuccess.commits },
    { issues: 1, events: 1, commits: 1 },
  );
  assert.equal(afterSuccess.active_issues, before.active_issues + 1);

  const rejectedOperation = crypto.randomUUID();
  const beforeRejected = await countsForOperation(rejectedOperation);
  await assert.rejects(
    createAtomicIssue(rejectedOperation, "Atomic rejected", 0),
    (error) => error instanceof AtomicBatchRejectedError && !/SELECT|INSERT|UPDATE|issues|events/i.test(error.message),
  );
  const afterRejected = await countsForOperation(rejectedOperation);
  assert.deepEqual(afterRejected, beforeRejected);
});

async function readbackCreatedIssue(operationId, commit) {
  const row = await db.prepare(
    "SELECT id, number, title FROM issues WHERE created_operation_id = ?1 LIMIT 1",
  ).bind(operationId).first();
  assert.ok(row);
  return {
    body: {
      event_cursor: String(commit.lastEventSequence),
      identifier: `CFK-${row.number}`,
      resource_id: row.id,
      title: row.title,
    },
    status: 201,
  };
}

function idempotencyIdentity(key, body) {
  return {
    idempotencyKey: key,
    method: "POST",
    normalizedResourceScope: "workspace/validation/project/CORE",
    requestBody: body,
    routeTemplate: "/internal/kernel/issue-create",
    scopeKey: `principal:${ids.owner}`,
  };
}

function idempotentCreateOptions(key, body, hooks = {}) {
  return {
    ...idempotencyIdentity(key, body),
    authorize: hooks.authorize ?? (async () => {
      const auth = await authenticateBearer(db, `Bearer ${activeToken}`);
      assert.equal(auth.isOwner, true);
    }),
    db,
    execute: hooks.execute ?? (async (operationId) => {
      await createAtomicIssue(operationId, body.title);
    }),
    forbiddenPersistenceValues: [activeToken, sessionToken],
    now,
    readback: readbackCreatedIssue,
  };
}

test("concurrent identical Idempotency-Key requests share one operation and one side effect", async () => {
  const key = `concurrent-${crypto.randomUUID()}`;
  const body = { title: "Concurrent idempotency" };
  const [first, second] = await Promise.all([
    runIdempotentOperation(idempotentCreateOptions(key, body)),
    runIdempotentOperation(idempotentCreateOptions(key, body)),
  ]);
  assert.equal(first.operationId, second.operationId);
  assert.deepEqual(first.body, second.body);
  assert.ok([first.idempotentReplay, second.idempotentReplay].includes(true));
  const counts = await countsForOperation(first.operationId);
  assert.deepEqual(
    { issues: counts.issues, events: counts.events, commits: counts.commits },
    { issues: 1, events: 1, commits: 1 },
  );

  await assert.rejects(
    runIdempotentOperation(idempotentCreateOptions(key, { title: "Changed request" })),
    (error) => error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409,
  );
  assert.deepEqual(await countsForOperation(first.operationId), counts);
});

test("pending response-loss retry probes commit, readbacks, finalizes, and reauthorizes without re-execution", async () => {
  const key = `response-loss-${crypto.randomUUID()}`;
  const body = { title: "Response loss recovery" };
  const identity = idempotencyIdentity(key, body);
  const claim = await claimIdempotency(db, identity, now);
  await createAtomicIssue(claim.operationId, body.title);

  let authorizeCalls = 0;
  let executeCalls = 0;
  const recovered = await runIdempotentOperation(idempotentCreateOptions(key, body, {
    authorize: async () => {
      authorizeCalls += 1;
      await authenticateBearer(db, `Bearer ${activeToken}`);
    },
    execute: async () => {
      executeCalls += 1;
    },
  }));
  assert.equal(recovered.operationId, claim.operationId);
  assert.equal(recovered.idempotentReplay, true);
  assert.equal(authorizeCalls, 2);
  assert.equal(executeCalls, 0);

  const record = await db.prepare(
    "SELECT state, response_status, response_json FROM idempotency_records WHERE operation_id = ?1",
  ).bind(claim.operationId).first();
  assert.equal(record.state, "committed");
  assert.equal(record.response_status, 201);
  assert.deepEqual(JSON.parse(record.response_json), recovered.body);
  const counts = await countsForOperation(claim.operationId);
  assert.deepEqual(
    { issues: counts.issues, events: counts.events, commits: counts.commits },
    { issues: 1, events: 1, commits: 1 },
  );

  let replayAuthorizationCalls = 0;
  const replay = await runIdempotentOperation(idempotentCreateOptions(key, body, {
    authorize: async () => {
      replayAuthorizationCalls += 1;
      await authenticateBearer(db, `Bearer ${activeToken}`);
    },
    execute: async () => assert.fail("Committed replay must not execute"),
  }));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replayAuthorizationCalls, 2);
  assert.deepEqual(replay.body, recovered.body);
});

test("Event, errors, logs, and idempotency responses contain no request secrets or full digests", async () => {
  const key = `secret-policy-${crypto.randomUUID()}`;
  const identity = idempotencyIdentity(key, { title: "Secret policy" });
  const claim = await claimIdempotency(db, identity, now);
  await createAtomicIssue(claim.operationId, "Secret policy");
  await assert.rejects(
    finalizeIdempotency(db, claim.operationId, { body: { echoed: activeToken }, status: 200 }, [activeToken]),
    /secret policy/i,
  );
  const pending = await db.prepare(
    "SELECT state, response_json FROM idempotency_records WHERE operation_id = ?1",
  ).bind(claim.operationId).first();
  assert.deepEqual(pending, { state: "pending", response_json: null });

  const events = await db.prepare("SELECT payload_json FROM events ORDER BY sequence").all();
  const responses = await db.prepare(
    "SELECT response_json FROM idempotency_records WHERE response_json IS NOT NULL",
  ).all();
  const observable = JSON.stringify({
    events: events.results,
    logs: server.getLogs(),
    responses: responses.results,
  });
  for (const secret of [activeToken, revokedToken, sessionToken]) {
    assert.doesNotMatch(observable, new RegExp(secret));
  }
  assert.doesNotMatch(observable, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(observable, /Authorization|Cookie|token_digest/i);
});
