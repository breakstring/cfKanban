import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { authenticateBearer, authenticateCookieSession } from "../../apps/worker/src/kernel/auth.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { redeemPublicJoin } from "../../apps/worker/src/services/public-join.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://kanban.example.test";
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const joinTokenA = `cfk_v1_publica_${"B".repeat(43)}`;
const joinTokenB = `cfk_v1_publicb_${"C".repeat(43)}`;
const joinTokenC = `cfk_v1_publicc_${"D".repeat(43)}`;
const joinTokenD = `cfk_v1_publicd_${"E".repeat(43)}`;
const joinTokenE = `cfk_v1_publice_${"F".repeat(43)}`;
const joinTokenF = `cfk_v1_publicf_${"G".repeat(43)}`;
const joinTokenG = `cfk_v1_publicg_${"H".repeat(43)}`;
const publicJoinSessionToken = "I".repeat(43);
const ids = {
  bootstrapOperation: "80000000-0000-4000-8000-000000000004",
  instance: "80000000-0000-4000-8000-000000000001",
  ownerCredential: "80000000-0000-4000-8000-000000000002",
  ownerPrincipal: "80000000-0000-4000-8000-000000000003",
};

const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});

let db;

function ownerHeaders(extra = {}) {
  return { authorization: `Bearer ${ownerToken}`, ...extra };
}

async function request(path, { body, headers = {}, method = "GET" } = {}) {
  const response = await server.getWorker().fetch(`${origin}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    method,
  });
  return { body: await response.json(), response };
}

async function tableCount(table, where = "1 = 1", ...values) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .bind(...values).first();
  return row.count;
}

async function assertSecretsAbsentFromPersistence(secrets) {
  const tables = await db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'`,
  ).all();
  const persisted = [];
  for (const { name } of tables.results) {
    const safeTable = `"${String(name).replaceAll('"', '""')}"`;
    persisted.push((await db.prepare(`SELECT * FROM ${safeTable}`).all()).results);
  }
  const persistedText = JSON.stringify(persisted);
  const logs = JSON.stringify(server.getLogs());
  for (const secret of secrets) {
    assert.equal(persistedText.includes(secret), false, "secret persisted in D1");
    assert.equal(logs.includes(secret), false, "secret persisted in Worker logs");
  }
}

function withOneFinalizeFailure(database) {
  let capturedResponse = null;
  let failed = false;
  const proxy = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SET state = 'committed'")) return statement;
          return {
            bind(...values) {
              const bound = statement.bind(...values);
              capturedResponse = {
                body: JSON.parse(values[1]),
                status: values[0],
              };
              return {
                async run() {
                  if (!failed) {
                    failed = true;
                    throw new Error("injected finalize interruption");
                  }
                  return bound.run();
                },
              };
            },
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    capturedResponse: () => capturedResponse,
    database: proxy,
  };
}

function beforeBusinessBatchDatabase(database, beforeBusinessBatch) {
  let batchCount = 0;
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements) => {
          batchCount += 1;
          if (batchCount === 2) await beforeBusinessBatch();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

before(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, {
    instanceId: ids.instance,
    operationId: ids.bootstrapOperation,
    ownerCredentialId: ids.ownerCredential,
    ownerCredentialToken: ownerToken,
    ownerDisplayName: "Deployment Owner",
    ownerPrincipalId: ids.ownerPrincipal,
    preferredApiOrigin: origin,
  });
});

after(async () => {
  await server.close();
});

test("WP-08 enforces Public Join policy, usage lifecycle, redemption, and owner-visible rate settings", async () => {
  const workspace = await request("/api/v1/workspaces", {
    body: { display_name: "Public Workspace", key: "public-space" },
    headers: ownerHeaders({ "idempotency-key": "wp08-workspace" }),
    method: "POST",
  });
  assert.equal(workspace.response.status, 200);
  const project = await request("/api/v1/workspaces/public-space/projects", {
    body: { display_name: "Public Project", key: "PUB" },
    headers: ownerHeaders({ "idempotency-key": "wp08-project" }),
    method: "POST",
  });
  assert.equal(project.response.status, 200);
  const projectId = project.body.resource.id;
  assert.equal(await tableCount("project_usage", "project_id = ?1", projectId), 0);

  const enableRequest = {
    body: {
      comment_limit: 20,
      expected_version: 1,
      issue_limit: 10,
      principal_limit: 2,
      public_summary: "A bounded public onboarding Project.",
    },
    headers: ownerHeaders({ "idempotency-key": "wp08-enable" }),
    method: "PUT",
  };
  const enabled = await request(`/api/v1/admin/projects/${projectId}/public-join`, enableRequest);
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.resource.enabled, true);
  assert.equal(enabled.body.resource.project.version, 2);
  assert.equal(enabled.body.resource.active_usage.principals, 0);
  assert.equal(await tableCount("project_usage", "project_id = ?1", projectId), 1);
  const publicId = enabled.body.resource.public_id;
  assert.equal(typeof publicId, "string");

  const enableReplay = await request(`/api/v1/admin/projects/${projectId}/public-join`, enableRequest);
  assert.equal(enableReplay.response.status, 200);
  assert.equal(enableReplay.body.idempotent_replay, true);
  assert.equal(enableReplay.body.resource.public_id, publicId);

  const secondProject = await request("/api/v1/workspaces/public-space/projects", {
    body: { display_name: "Independent Public Project", key: "AUX" },
    headers: ownerHeaders({ "idempotency-key": "wp08-project-aux" }),
    method: "POST",
  });
  const secondProjectId = secondProject.body.resource.id;
  const secondEnabled = await request(`/api/v1/admin/projects/${secondProjectId}/public-join`, {
    body: {
      comment_limit: 2,
      expected_version: 1,
      issue_limit: 2,
      principal_limit: 2,
      public_summary: "An independently configured public Project.",
    },
    headers: ownerHeaders({ "idempotency-key": "wp08-enable-aux" }),
    method: "PUT",
  });
  assert.equal(secondEnabled.response.status, 200);
  const secondPublicId = secondEnabled.body.resource.public_id;
  const secondUpdated = await request(`/api/v1/admin/projects/${secondProjectId}/public-join`, {
    body: {
      comment_limit: 3,
      expected_version: 2,
      issue_limit: 3,
      principal_limit: 3,
      public_summary: "An updated independent public Project.",
    },
    headers: ownerHeaders({ "idempotency-key": "wp08-update-aux" }),
    method: "PUT",
  });
  assert.equal(secondUpdated.response.status, 200);
  assert.equal(secondUpdated.body.resource.public_id, secondPublicId);
  assert.equal(secondUpdated.body.resource.project.version, 3);
  const secondRecoverySummary = {
    active_usage: { comments: 0, issues: 0, principals: 0 },
    display_name: "Independent Public Project",
    id: secondProjectId,
    key: "AUX",
    public_summary: "An updated independent public Project.",
    resource_limits: { comments: 3, issues: 3, principals: 3 },
    role_choices: ["reader", "writer"],
    workspace_key: "public-space",
  };
  const secondEventTypes = await db.prepare(
    `SELECT type FROM events
     WHERE project_id = ?1 AND type LIKE 'project.public-join-%'
     ORDER BY sequence`,
  ).bind(secondProjectId).all();
  assert.deepEqual(secondEventTypes.results.map((row) => row.type), [
    "project.public-join-enabled",
    "project.public-join-updated",
  ]);

  const publicList = await request("/api/v1/public-projects?limit=1");
  assert.equal(publicList.response.status, 200);
  assert.equal(publicList.body.items.length, 1);
  assert.equal(publicList.body.has_more, true);
  assert.equal(typeof publicList.body.next_cursor, "string");
  assert.deepEqual(publicList.body.items[0].role_choices, ["reader", "writer"]);
  assert.equal("id" in publicList.body.items[0], false);
  assert.equal("workspace_key" in publicList.body.items[0], false);
  assert.equal("project_key" in publicList.body.items[0], false);
  const publicListNext = await request(
    `/api/v1/public-projects?limit=1&cursor=${encodeURIComponent(publicList.body.next_cursor)}`,
  );
  assert.equal(publicListNext.response.status, 200);
  assert.equal(publicListNext.body.has_more, false);
  assert.deepEqual(
    [publicList.body.items[0].public_id, publicListNext.body.items[0].public_id].sort(),
    [publicId, secondPublicId].sort(),
  );

  await db.prepare("DELETE FROM project_usage WHERE project_id = ?1").bind(secondProjectId).run();
  const deleteEventCountBeforeInvariantFailure = await tableCount(
    "events",
    "project_id = ?1 AND type = 'project.deleted'",
    secondProjectId,
  );
  const operationCountBeforeInvariantFailure = await tableCount("operation_commits");
  const rejectedDeleteWithoutUsage = await request(
    "/api/v1/workspaces/public-space/projects/AUX?expected_version=3",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(rejectedDeleteWithoutUsage.response.status, 503);
  assert.equal(rejectedDeleteWithoutUsage.body.code, "PLATFORM_UNAVAILABLE");
  const projectAfterInvariantFailure = await db.prepare(
    "SELECT deleted_at, version FROM projects WHERE id = ?1",
  ).bind(secondProjectId).first();
  assert.deepEqual(projectAfterInvariantFailure, { deleted_at: null, version: 3 });
  assert.equal(
    await tableCount("events", "project_id = ?1 AND type = 'project.deleted'", secondProjectId),
    deleteEventCountBeforeInvariantFailure,
  );
  assert.equal(await tableCount("operation_commits"), operationCountBeforeInvariantFailure);
  await db.prepare(
    `INSERT INTO project_usage
      (project_id, active_issue_count, active_comment_count,
       active_principal_count, updated_at, last_operation_id)
     VALUES (?1, 0, 0, 0, ?2, NULL)`,
  ).bind(secondProjectId, Date.now()).run();

  const pausedSecond = await request(
    "/api/v1/workspaces/public-space/projects/AUX?expected_version=3",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(pausedSecond.response.status, 200);
  assert.equal(pausedSecond.body.resource.deleted_at !== null, true);
  assert.deepEqual(pausedSecond.body.resource.resumed_public_projects.projects, [secondRecoverySummary]);
  assert.equal(await tableCount("project_usage", "project_id = ?1", secondProjectId), 1);
  const pausedSecondTombstone = await request(
    "/api/v1/workspaces/public-space/projects?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.deepEqual(
    pausedSecondTombstone.body.items[0].resumed_public_projects.projects,
    [secondRecoverySummary],
  );
  const pausedSecondDetail = await request(
    "/api/v1/workspaces/public-space/projects/AUX?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.deepEqual(pausedSecondDetail.body.resumed_public_projects.projects, [secondRecoverySummary]);
  const pausedPublicList = await request("/api/v1/public-projects");
  assert.deepEqual(pausedPublicList.body.items.map((item) => item.public_id), [publicId]);
  const pausedRedeem = await request(`/api/v1/public-joins/${secondPublicId}/redeem`, {
    body: {
      display_name: "Paused Target Member",
      new_credential_token: joinTokenC,
      redeem_as: "new_principal",
      role: "reader",
    },
    headers: { "idempotency-key": "wp08-paused-target" },
    method: "POST",
  });
  assert.equal(pausedRedeem.response.status, 404);
  await db.prepare("DELETE FROM project_usage WHERE project_id = ?1").bind(secondProjectId).run();
  const missingRecoveryUsage = await request(
    "/api/v1/workspaces/public-space/projects?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.equal(missingRecoveryUsage.response.status, 503);
  assert.equal(missingRecoveryUsage.body.code, "PLATFORM_UNAVAILABLE");
  await db.prepare(
    `INSERT INTO project_usage
      (project_id, active_issue_count, active_comment_count,
       active_principal_count, updated_at, last_operation_id)
     VALUES (?1, 0, 0, 0, ?2, NULL)`,
  ).bind(secondProjectId, Date.now()).run();

  const restoredSecond = await request(
    "/api/v1/workspaces/public-space/projects/AUX/commands/restore",
    {
      body: { expected_version: 4 },
      headers: ownerHeaders({ "idempotency-key": "wp08-restore-aux" }),
      method: "POST",
    },
  );
  assert.equal(restoredSecond.response.status, 200);
  assert.equal(restoredSecond.body.resource.version, 5);
  assert.deepEqual(restoredSecond.body.resource.resumed_public_projects.projects, [secondRecoverySummary]);
  const restoredPublicList = await request("/api/v1/public-projects");
  assert.deepEqual(
    restoredPublicList.body.items.map((item) => item.public_id).sort(),
    [publicId, secondPublicId].sort(),
  );

  const concurrentJoinRequest = {
    body: {
      display_name: "Concurrent Public Member",
      new_credential_token: joinTokenD,
      redeem_as: "new_principal",
      role: "reader",
    },
    headers: { "idempotency-key": "wp08-concurrent-join" },
    method: "POST",
  };
  const concurrentJoins = await Promise.all([
    request(`/api/v1/public-joins/${secondPublicId}/redeem`, concurrentJoinRequest),
    request(`/api/v1/public-joins/${secondPublicId}/redeem`, concurrentJoinRequest),
  ]);
  assert.deepEqual(concurrentJoins.map((item) => item.response.status), [200, 200]);
  assert.equal(
    concurrentJoins[0].body.resource.principal.principal_id,
    concurrentJoins[1].body.resource.principal.principal_id,
  );
  assert.equal(
    concurrentJoins[0].body.resource.grant.id,
    concurrentJoins[1].body.resource.grant.id,
  );
  assert.equal(await tableCount("credentials", "token_prefix = 'publicd'"), 1);
  assert.equal(await tableCount("project_grants", "project_id = ?1", secondProjectId), 1);
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 1", secondProjectId), 1);

  const responseLossKey = "wp08-response-loss-join";
  const responseLossBody = {
    display_name: "Response Loss Public Member",
    new_credential_token: joinTokenE,
    redeem_as: "new_principal",
    role: "reader",
  };
  const responseLossRequest = new Request(
    `${origin}/api/v1/public-joins/${secondPublicId}/redeem`,
    {
      body: JSON.stringify(responseLossBody),
      headers: {
        "content-type": "application/json",
        "idempotency-key": responseLossKey,
      },
      method: "POST",
    },
  );
  const interrupted = withOneFinalizeFailure(db);
  await assert.rejects(
    redeemPublicJoin(
      interrupted.database,
      responseLossRequest,
      null,
      secondPublicId,
      responseLossBody.redeem_as,
      responseLossBody.role,
      responseLossBody.display_name,
      responseLossBody.new_credential_token,
      Date.now(),
    ),
    (error) => error?.code === "PLATFORM_UNAVAILABLE",
  );
  const pendingResponseLoss = await db.prepare(
    `SELECT operation_id, operation_snapshot_json, state
     FROM idempotency_records WHERE idempotency_key = ?1`,
  ).bind(await sha256Hex(responseLossKey)).first();
  assert.equal(pendingResponseLoss.state, "pending");
  assert.equal(typeof pendingResponseLoss.operation_snapshot_json, "string");
  assert.equal(await tableCount("operation_commits", "operation_id = ?1", pendingResponseLoss.operation_id), 1);
  assert.equal(await tableCount("events", "operation_id = ?1", pendingResponseLoss.operation_id), 2);
  assert.equal(await tableCount("credentials", "token_prefix = 'publice'"), 1);
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 2", secondProjectId), 1);

  const resumedResponseLoss = await request(`/api/v1/public-joins/${secondPublicId}/redeem`, {
    body: responseLossBody,
    headers: { "idempotency-key": responseLossKey },
    method: "POST",
  });
  assert.equal(resumedResponseLoss.response.status, interrupted.capturedResponse().status);
  assert.equal(resumedResponseLoss.body.idempotent_replay, true);
  const { idempotent_replay: _replay, ...resumedStoredBody } = resumedResponseLoss.body;
  assert.equal(interrupted.capturedResponse().body.idempotent_replay, false);
  const { idempotent_replay: _initialReplay, ...initialStoredBody } = interrupted.capturedResponse().body;
  assert.deepEqual(resumedStoredBody, initialStoredBody);
  assert.equal(await tableCount("operation_commits", "operation_id = ?1", pendingResponseLoss.operation_id), 1);
  assert.equal(await tableCount("events", "operation_id = ?1", pendingResponseLoss.operation_id), 2);
  assert.equal(await tableCount("credentials", "token_prefix = 'publice'"), 1);
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 2", secondProjectId), 1);
  const mismatchedResponseLoss = await request(`/api/v1/public-joins/${secondPublicId}/redeem`, {
    body: { ...responseLossBody, role: "writer" },
    headers: { "idempotency-key": responseLossKey },
    method: "POST",
  });
  assert.equal(mismatchedResponseLoss.response.status, 409);
  assert.equal(await tableCount("events", "operation_id = ?1", pendingResponseLoss.operation_id), 2);

  const policyRaceKey = "wp08-policy-race-join";
  const policyRaceBefore = {
    credentials: await tableCount("credentials"),
    events: await tableCount("events"),
    grants: await tableCount("project_grants"),
    operations: await tableCount("operation_commits"),
    principals: await tableCount("principals"),
  };
  const policyRaceRequest = new Request(
    `${origin}/api/v1/public-joins/${secondPublicId}/redeem`,
    {
      body: JSON.stringify({
        display_name: "Policy Race Public Member",
        new_credential_token: joinTokenF,
        redeem_as: "new_principal",
        role: "reader",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": policyRaceKey,
      },
      method: "POST",
    },
  );
  const policyRaceDb = beforeBusinessBatchDatabase(db, async () => {
    await db.prepare(
      `UPDATE public_join_policies
       SET disabled_at = ?1, disabled_by_principal_id = ?2, version = version + 1
       WHERE public_id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, secondPublicId).run();
  });
  await assert.rejects(
    redeemPublicJoin(
      policyRaceDb,
      policyRaceRequest,
      null,
      secondPublicId,
      "new_principal",
      "reader",
      "Policy Race Public Member",
      joinTokenF,
      Date.now(),
    ),
    (error) => error?.code === "NOT_FOUND",
  );
  assert.deepEqual({
    credentials: await tableCount("credentials"),
    events: await tableCount("events"),
    grants: await tableCount("project_grants"),
    operations: await tableCount("operation_commits"),
    principals: await tableCount("principals"),
  }, policyRaceBefore);
  assert.equal(await tableCount("idempotency_records", "idempotency_key = ?1", await sha256Hex(policyRaceKey)), 0);
  await db.prepare(
    `UPDATE public_join_policies
     SET disabled_at = NULL, disabled_by_principal_id = NULL, version = version + 1
     WHERE public_id = ?1`,
  ).bind(secondPublicId).run();

  const parentRaceKey = "wp08-parent-race-join";
  const parentRaceBefore = {
    credentials: await tableCount("credentials"),
    events: await tableCount("events"),
    grants: await tableCount("project_grants"),
    operations: await tableCount("operation_commits"),
    principals: await tableCount("principals"),
  };
  const parentRaceDb = beforeBusinessBatchDatabase(db, async () => {
    await db.prepare(
      "UPDATE projects SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
    ).bind(Date.now(), ids.ownerPrincipal, secondProjectId).run();
  });
  await assert.rejects(
    redeemPublicJoin(
      parentRaceDb,
      new Request(`${origin}/api/v1/public-joins/${secondPublicId}/redeem`, {
        body: JSON.stringify({
          display_name: "Parent Race Public Member",
          new_credential_token: joinTokenG,
          redeem_as: "new_principal",
          role: "reader",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": parentRaceKey,
        },
        method: "POST",
      }),
      null,
      secondPublicId,
      "new_principal",
      "reader",
      "Parent Race Public Member",
      joinTokenG,
      Date.now(),
    ),
    (error) => error?.code === "NOT_FOUND",
  );
  assert.deepEqual({
    credentials: await tableCount("credentials"),
    events: await tableCount("events"),
    grants: await tableCount("project_grants"),
    operations: await tableCount("operation_commits"),
    principals: await tableCount("principals"),
  }, parentRaceBefore);
  assert.equal(await tableCount("idempotency_records", "idempotency_key = ?1", await sha256Hex(parentRaceKey)), 0);
  await db.prepare(
    "UPDATE projects SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
  ).bind(secondProjectId).run();

  const revokedAuth = await authenticateBearer(db, `Bearer ${joinTokenD}`);
  const authRaceKey = "wp08-current-auth-race-join";
  const authRaceEvents = await tableCount("events");
  const authRaceOperations = await tableCount("operation_commits");
  const authRaceRequest = new Request(
    `${origin}/api/v1/public-joins/${secondPublicId}/redeem`,
    {
      body: JSON.stringify({ redeem_as: "current_principal", role: "reader" }),
      headers: {
        authorization: `Bearer ${joinTokenD}`,
        "content-type": "application/json",
        "idempotency-key": authRaceKey,
      },
      method: "POST",
    },
  );
  const authRaceDb = beforeBusinessBatchDatabase(db, async () => {
    await db.prepare(
      `UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2
       WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, revokedAuth.credentialId).run();
  });
  await assert.rejects(
    redeemPublicJoin(
      authRaceDb,
      authRaceRequest,
      revokedAuth,
      secondPublicId,
      "current_principal",
      "reader",
      undefined,
      undefined,
      Date.now(),
    ),
    (error) => error?.code === "UNAUTHORIZED",
  );
  assert.equal(await tableCount("events"), authRaceEvents);
  assert.equal(await tableCount("operation_commits"), authRaceOperations);
  assert.equal(await tableCount("idempotency_records", "idempotency_key = ?1", await sha256Hex(authRaceKey)), 0);
  await db.prepare(
    `UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL
     WHERE id = ?1`,
  ).bind(revokedAuth.credentialId).run();

  const cookiePrincipalId = crypto.randomUUID();
  const cookiePasskeyId = crypto.randomUUID();
  const cookieSessionId = crypto.randomUUID();
  const cookieNow = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO principals (id, display_name, created_at, updated_at)
       VALUES (?1, 'Passkey Public Member', ?2, ?2)`,
    ).bind(cookiePrincipalId, cookieNow),
    db.prepare(
      `INSERT INTO web_authenticators
        (id, principal_id, credential_id, public_key_cose, algorithm,
         user_handle, backup_eligible, backup_state, rp_id, created_at,
         created_operation_id)
       VALUES (?1, ?2, ?3, 'test-public-key', -7, ?4, 0, 0,
               'kanban.example.test', ?5, ?6)`,
    ).bind(
      cookiePasskeyId,
      cookiePrincipalId,
      `passkey-${cookiePasskeyId}`,
      `handle-${cookiePrincipalId}`,
      cookieNow,
      crypto.randomUUID(),
    ),
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id,
         target_kind, target_json, expires_at, created_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'web_authenticator', ?4, 'project_selection',
               ?5, ?6, ?7, ?8)`,
    ).bind(
      cookieSessionId,
      await sha256Hex(publicJoinSessionToken),
      cookiePrincipalId,
      cookiePasskeyId,
      JSON.stringify({ entry_path: "/app", kind: "project_selection" }),
      cookieNow + 8 * 60 * 60 * 1_000,
      cookieNow,
      crypto.randomUUID(),
    ),
  ]);
  const cookieAuthRequest = new Request(`${origin}/api/v1/web-session`, {
    headers: { cookie: `cfkanban_session=${publicJoinSessionToken}` },
  });
  const cookieAuth = await authenticateCookieSession(db, cookieAuthRequest, cookieNow);
  const cookieJoin = await redeemPublicJoin(
    db,
    new Request(`${origin}/api/v1/public-joins/${secondPublicId}/redeem`, {
      body: JSON.stringify({ redeem_as: "current_principal", role: "reader" }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "wp08-cookie-created-join",
      },
      method: "POST",
    }),
    cookieAuth,
    secondPublicId,
    "current_principal",
    "reader",
    undefined,
    undefined,
    cookieNow,
  );
  assert.equal(cookieJoin.resource.outcome, "created");
  assert.equal(await tableCount(
    "project_grants",
    "principal_id = ?1 AND project_id = ?2 AND revoked_at IS NULL",
    cookiePrincipalId,
    secondProjectId,
  ), 1);

  const cookieRaceKey = "wp08-cookie-auth-race-join";
  const cookieRaceEvents = await tableCount("events");
  const cookieRaceOperations = await tableCount("operation_commits");
  const cookieRaceDb = beforeBusinessBatchDatabase(db, async () => {
    await db.prepare("UPDATE web_sessions SET revoked_at = ?1 WHERE id = ?2")
      .bind(Date.now(), cookieSessionId).run();
  });
  await assert.rejects(
    redeemPublicJoin(
      cookieRaceDb,
      new Request(`${origin}/api/v1/public-joins/${secondPublicId}/redeem`, {
        body: JSON.stringify({ redeem_as: "current_principal", role: "reader" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": cookieRaceKey,
        },
        method: "POST",
      }),
      cookieAuth,
      secondPublicId,
      "current_principal",
      "reader",
      undefined,
      undefined,
      Date.now(),
    ),
    (error) => error?.code === "UNAUTHORIZED",
  );
  assert.equal(await tableCount("events"), cookieRaceEvents);
  assert.equal(await tableCount("operation_commits"), cookieRaceOperations);
  assert.equal(await tableCount("idempotency_records", "idempotency_key = ?1", await sha256Hex(cookieRaceKey)), 0);
  await db.prepare("UPDATE web_sessions SET revoked_at = NULL WHERE id = ?1")
    .bind(cookieSessionId).run();

  const firstJoinRequest = {
    body: {
      display_name: "Public Member A",
      new_credential_token: joinTokenA,
      redeem_as: "new_principal",
      role: "reader",
    },
    headers: { "idempotency-key": "wp08-join-a" },
    method: "POST",
  };
  const firstJoin = await request(`/api/v1/public-joins/${publicId}/redeem`, firstJoinRequest);
  assert.equal(firstJoin.response.status, 200);
  assert.equal(firstJoin.body.resource.outcome, "created");
  assert.equal(firstJoin.body.resource.grant.role, "reader");
  assert.equal(firstJoin.body.resource.credential.fingerprint, "cfk_v1_publica_…");
  assert.doesNotMatch(JSON.stringify(firstJoin.body), new RegExp(joinTokenA));
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 1", projectId), 1);

  const firstJoinReplay = await request(`/api/v1/public-joins/${publicId}/redeem`, firstJoinRequest);
  assert.equal(firstJoinReplay.response.status, 200);
  assert.equal(firstJoinReplay.body.idempotent_replay, true);
  assert.equal(firstJoinReplay.body.resource.grant.id, firstJoin.body.resource.grant.id);
  assert.equal(await tableCount("events", "operation_id = (SELECT operation_id FROM idempotency_records WHERE scope_key = ?1 AND state = 'committed')", `public-join:${publicId}`), 2);

  const promoted = await request(`/api/v1/public-joins/${publicId}/redeem`, {
    body: { redeem_as: "current_principal", role: "writer" },
    headers: {
      authorization: `Bearer ${joinTokenA}`,
      "idempotency-key": "wp08-promote-a",
    },
    method: "POST",
  });
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.body.resource.outcome, "promoted");
  assert.equal(promoted.body.resource.grant.role, "writer");
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 1", projectId), 1);

  const noDowngrade = await request(`/api/v1/public-joins/${publicId}/redeem`, {
    body: { redeem_as: "current_principal", role: "reader" },
    headers: {
      authorization: `Bearer ${joinTokenA}`,
      "idempotency-key": "wp08-no-downgrade-a",
    },
    method: "POST",
  });
  assert.equal(noDowngrade.response.status, 200);
  assert.equal(noDowngrade.body.resource.outcome, "already_has_access");
  assert.equal(noDowngrade.body.resource.grant.role, "writer");

  const beforeSecretCollisionPrincipals = await tableCount("principals");
  const secretCollision = await request(`/api/v1/public-joins/${publicId}/redeem`, {
    body: {
      display_name: joinTokenC,
      new_credential_token: joinTokenC,
      redeem_as: "new_principal",
      role: "reader",
    },
    headers: { "idempotency-key": "wp08-secret-collision" },
    method: "POST",
  });
  assert.equal(secretCollision.response.status, 400);
  assert.equal(secretCollision.body.code, "VALIDATION_ERROR");
  assert.deepEqual(secretCollision.body.details, {
    field: "display_name",
    reason: "secret_value_reused",
  });
  assert.equal(await tableCount("principals"), beforeSecretCollisionPrincipals);
  assert.equal(await tableCount("credentials", "token_prefix = 'publicc'"), 0);

  const secondJoin = await request(`/api/v1/public-joins/${publicId}/redeem`, {
    body: {
      display_name: "Public Member B",
      new_credential_token: joinTokenB,
      redeem_as: "new_principal",
      role: "reader",
    },
    headers: { "idempotency-key": "wp08-join-b" },
    method: "POST",
  });
  assert.equal(secondJoin.response.status, 200);
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 2", projectId), 1);

  const revokedSecond = await request(
    `/api/v1/admin/grants/${secondJoin.body.resource.grant.id}?expected_version=${secondJoin.body.resource.grant.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(revokedSecond.response.status, 200);
  assert.equal(revokedSecond.body.resource.revoked_at !== null, true);
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 1", projectId), 1);

  const regrantedSecond = await request(`/api/v1/public-joins/${publicId}/redeem`, {
    body: { redeem_as: "current_principal", role: "reader" },
    headers: {
      authorization: `Bearer ${joinTokenB}`,
      "idempotency-key": "wp08-regrant-b",
    },
    method: "POST",
  });
  assert.equal(regrantedSecond.response.status, 200);
  assert.equal(regrantedSecond.body.resource.outcome, "regranted");
  assert.equal(regrantedSecond.body.resource.grant.role, "reader");
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 2", projectId), 1);

  const lowered = await request(`/api/v1/admin/projects/${projectId}/resource-limits`, {
    body: {
      comment_limit: 1,
      expected_version: 2,
      issue_limit: 1,
      principal_limit: 1,
    },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(lowered.response.status, 200);
  assert.equal(lowered.body.resource.resource_limits.principals, 1);
  assert.equal(lowered.body.resource.active_usage.principals, 2);
  assert.equal(lowered.body.resource.project.version, 3);
  const limitsEvent = await db.prepare(
    "SELECT payload_json FROM events WHERE project_id = ?1 AND type = 'project.resource-limits-updated' ORDER BY sequence DESC LIMIT 1",
  ).bind(projectId).first();
  assert.deepEqual(JSON.parse(limitsEvent.payload_json).active_usage, {
    comments: 0,
    issues: 0,
    principals: 2,
  });

  const overLimitPromotion = await request(`/api/v1/public-joins/${publicId}/redeem`, {
    body: { redeem_as: "current_principal", role: "writer" },
    headers: {
      authorization: `Bearer ${joinTokenB}`,
      "idempotency-key": "wp08-over-limit-promote-b",
    },
    method: "POST",
  });
  assert.equal(overLimitPromotion.response.status, 200);
  assert.equal(overLimitPromotion.body.resource.outcome, "promoted");
  assert.equal(overLimitPromotion.body.resource.grant.role, "writer");
  assert.equal(await tableCount("project_usage", "project_id = ?1 AND active_principal_count = 2", projectId), 1);

  const enabledIssue = await request("/api/v1/workspaces/public-space/projects/PUB/issues", {
    body: { title: "Consumes the enabled Issue quota" },
    headers: ownerHeaders({ "idempotency-key": "wp08-enabled-issue" }),
    method: "POST",
  });
  assert.equal(enabledIssue.response.status, 200);
  const enabledIssueRejected = await request("/api/v1/workspaces/public-space/projects/PUB/issues", {
    body: { title: "Exceeds the enabled Issue quota" },
    headers: ownerHeaders({ "idempotency-key": "wp08-enabled-issue-rejected" }),
    method: "POST",
  });
  assert.equal(enabledIssueRejected.response.status, 409);
  assert.equal(enabledIssueRejected.body.code, "PROJECT_ISSUE_LIMIT_REACHED");
  assert.deepEqual(enabledIssueRejected.body.details, {
    current_usage: 1,
    limit: 1,
    resource_kind: "issue",
  });

  const enabledComment = await request(
    `/api/v1/issues/${enabledIssue.body.resource.identifier}/comments`,
    {
      body: { body: "Consumes the enabled Comment quota" },
      headers: ownerHeaders({ "idempotency-key": "wp08-enabled-comment" }),
      method: "POST",
    },
  );
  assert.equal(enabledComment.response.status, 200);
  const enabledCommentRejected = await request(
    `/api/v1/issues/${enabledIssue.body.resource.identifier}/comments`,
    {
      body: { body: "Exceeds the enabled Comment quota" },
      headers: ownerHeaders({ "idempotency-key": "wp08-enabled-comment-rejected" }),
      method: "POST",
    },
  );
  assert.equal(enabledCommentRejected.response.status, 409);
  assert.equal(enabledCommentRejected.body.code, "PROJECT_COMMENT_LIMIT_REACHED");
  assert.deepEqual(enabledCommentRejected.body.details, {
    current_usage: 1,
    limit: 1,
    resource_kind: "comment",
  });

  const beforeRejectedPrincipals = await tableCount("principals");
  const quotaRejected = await request(`/api/v1/public-joins/${publicId}/redeem`, {
    body: {
      display_name: "Public Member C",
      new_credential_token: joinTokenC,
      redeem_as: "new_principal",
      role: "reader",
    },
    headers: { "idempotency-key": "wp08-join-c" },
    method: "POST",
  });
  assert.equal(quotaRejected.response.status, 409);
  assert.equal(quotaRejected.body.code, "PROJECT_PRINCIPAL_LIMIT_REACHED");
  assert.deepEqual(quotaRejected.body.details, { resource_kind: "principal" });
  assert.equal(await tableCount("principals"), beforeRejectedPrincipals);
  assert.equal(await tableCount("credentials", "token_prefix = 'publicc'"), 0);

  const disabled = await request(
    `/api/v1/admin/projects/${projectId}/public-join?expected_version=3`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.body.resource.enabled, false);
  assert.equal(disabled.body.resource.public_id, publicId);
  assert.equal(disabled.body.resource.project.version, 4);
  assert.deepEqual(disabled.body.resource.active_usage, {
    comments: 1,
    issues: 1,
    principals: 2,
  });
  const repeatedDisable = await request(
    `/api/v1/admin/projects/${projectId}/public-join?expected_version=3`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(repeatedDisable.response.status, 409);
  assert.equal(repeatedDisable.body.code, "PUBLIC_JOIN_DISABLED");
  assert.equal(repeatedDisable.body.recovery, "enable_public_join");
  assert.deepEqual(repeatedDisable.body.details, { current_version: 4 });
  const disabledLimitsUpdate = await request(`/api/v1/admin/projects/${projectId}/resource-limits`, {
    body: {
      comment_limit: 2,
      expected_version: 4,
      issue_limit: 2,
      principal_limit: 2,
    },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(disabledLimitsUpdate.response.status, 409);
  assert.equal(disabledLimitsUpdate.body.code, "PUBLIC_JOIN_DISABLED");
  assert.equal(disabledLimitsUpdate.body.recovery, "enable_public_join");
  assert.deepEqual(disabledLimitsUpdate.body.details, { current_version: 4 });
  assert.equal(await tableCount("project_usage", "project_id = ?1", projectId), 0);
  const hidden = await request("/api/v1/public-projects");
  assert.deepEqual(hidden.body.items.map((item) => item.public_id), [secondPublicId]);
  assert.equal(await tableCount("project_usage", "project_id = ?1", secondProjectId), 1);

  const disabledIssueA = await request("/api/v1/workspaces/public-space/projects/PUB/issues", {
    body: { title: "Created while Public Join is disabled A" },
    headers: ownerHeaders({ "idempotency-key": "wp08-disabled-issue-a" }),
    method: "POST",
  });
  const disabledIssueB = await request("/api/v1/workspaces/public-space/projects/PUB/issues", {
    body: { title: "Created while Public Join is disabled B" },
    headers: ownerHeaders({ "idempotency-key": "wp08-disabled-issue-b" }),
    method: "POST",
  });
  assert.equal(disabledIssueA.response.status, 200);
  assert.equal(disabledIssueB.response.status, 200);
  for (const [key, issue] of [["a", disabledIssueA], ["b", disabledIssueB]]) {
    const comment = await request(`/api/v1/issues/${issue.body.resource.identifier}/comments`, {
      body: { body: `Disabled-policy comment ${key}` },
      headers: ownerHeaders({ "idempotency-key": `wp08-disabled-comment-${key}` }),
      method: "POST",
    });
    assert.equal(comment.response.status, 200);
  }
  assert.equal(await tableCount("project_usage", "project_id = ?1", projectId), 0);

  const reenabled = await request(`/api/v1/admin/projects/${projectId}/public-join`, {
    body: {
      comment_limit: 5,
      expected_version: 4,
      issue_limit: 5,
      principal_limit: 5,
      public_summary: "Re-enabled with explicit limits.",
    },
    headers: ownerHeaders({ "idempotency-key": "wp08-reenable" }),
    method: "PUT",
  });
  assert.equal(reenabled.response.status, 200);
  assert.equal(reenabled.body.resource.public_id, publicId);
  assert.equal(reenabled.body.resource.active_usage.principals, 2);
  assert.equal(reenabled.body.resource.active_usage.issues, 3);
  assert.equal(reenabled.body.resource.active_usage.comments, 3);
  assert.equal(reenabled.body.resource.project.version, 5);

  const usageInvariantTombstone = await request(
    `/api/v1/issues/${enabledIssue.body.resource.identifier}?expected_version=${enabledIssue.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(usageInvariantTombstone.response.status, 200);
  await db.prepare("DELETE FROM project_usage WHERE project_id = ?1").bind(projectId).run();
  const missingUsageCreate = await request("/api/v1/workspaces/public-space/projects/PUB/issues", {
    body: { title: "Must fail as an invariant error" },
    headers: ownerHeaders({ "idempotency-key": "wp08-missing-usage-create" }),
    method: "POST",
  });
  assert.equal(missingUsageCreate.response.status, 503);
  assert.equal(missingUsageCreate.body.code, "PLATFORM_UNAVAILABLE");
  const missingUsageRestore = await request(
    `/api/v1/issues/${enabledIssue.body.resource.identifier}/commands/restore`,
    {
      body: { expected_version: usageInvariantTombstone.body.resource.version },
      headers: ownerHeaders({ "idempotency-key": "wp08-missing-usage-restore" }),
      method: "POST",
    },
  );
  assert.equal(missingUsageRestore.response.status, 503);
  assert.equal(missingUsageRestore.body.code, "PLATFORM_UNAVAILABLE");
  assert.equal(await tableCount("project_usage", "project_id = ?1", projectId), 0);
  await db.prepare(
    `INSERT INTO project_usage
      (project_id, active_issue_count, active_comment_count,
       active_principal_count, updated_at, last_operation_id)
     SELECT project.id,
            (SELECT COUNT(*) FROM issues issue
             WHERE issue.project_id = project.id AND issue.deleted_at IS NULL),
            (SELECT COUNT(*) FROM comments comment
             JOIN issues issue ON issue.id = comment.issue_id
             WHERE issue.project_id = project.id AND issue.deleted_at IS NULL
               AND comment.deleted_at IS NULL),
            (SELECT COUNT(*) FROM project_grants grant_row
             WHERE grant_row.project_id = project.id AND grant_row.revoked_at IS NULL),
            ?2, NULL
     FROM projects project WHERE project.id = ?1`,
  ).bind(projectId, Date.now()).run();
  const restoredAfterUsageRepair = await request(
    `/api/v1/issues/${enabledIssue.body.resource.identifier}/commands/restore`,
    {
      body: { expected_version: usageInvariantTombstone.body.resource.version },
      headers: ownerHeaders({ "idempotency-key": "wp08-repaired-usage-restore" }),
      method: "POST",
    },
  );
  assert.equal(restoredAfterUsageRepair.response.status, 200);

  const publicJoinEventTypes = await db.prepare(
    `SELECT type FROM events
     WHERE project_id = ?1 AND type LIKE 'project.public-join-%'
     ORDER BY sequence`,
  ).bind(projectId).all();
  assert.deepEqual(publicJoinEventTypes.results.map((row) => row.type), [
    "project.public-join-enabled",
    "project.public-join-disabled",
    "project.public-join-enabled",
  ]);

  const rateSettings = await request("/api/v1/admin/rate-limit-settings", {
    headers: ownerHeaders(),
  });
  assert.equal(rateSettings.response.status, 200);
  assert.deepEqual(rateSettings.body.policies.principal, { limit: 10000, period_seconds: 60 });
  assert.equal(rateSettings.body.editable_via_api, false);
  assert.equal(rateSettings.body.recent_429_summary.observation_scope, "worker_isolate_best_effort");
  assert.equal(rateSettings.body.recent_429_summary.window_seconds, 300);
  assert.ok(rateSettings.body.recent_429_summary.total <= 128);

  const pausedWorkspace = await request(
    "/api/v1/workspaces/public-space?expected_version=1",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(pausedWorkspace.response.status, 200);
  const workspaceRecoveryProjects = [
    {
      ...secondRecoverySummary,
      active_usage: { comments: 0, issues: 0, principals: 3 },
    },
    {
      active_usage: { comments: 3, issues: 3, principals: 2 },
      display_name: "Public Project",
      id: projectId,
      key: "PUB",
      public_summary: "Re-enabled with explicit limits.",
      resource_limits: { comments: 5, issues: 5, principals: 5 },
      role_choices: ["reader", "writer"],
      workspace_key: "public-space",
    },
  ];
  const pausedWorkspaceTombstone = await request("/api/v1/workspaces?deleted=only", {
    headers: ownerHeaders(),
  });
  assert.equal(pausedWorkspaceTombstone.body.items[0].resumed_public_projects, undefined);
  const pausedWorkspaceDetail = await request("/api/v1/workspaces/public-space?deleted=only", {
    headers: ownerHeaders(),
  });
  assert.deepEqual(
    pausedWorkspaceDetail.body.resumed_public_projects.projects,
    workspaceRecoveryProjects,
  );
  const hiddenByWorkspace = await request("/api/v1/public-projects");
  assert.deepEqual(hiddenByWorkspace.body.items, []);
  assert.equal(await tableCount("project_usage", "project_id IN (?1, ?2)", projectId, secondProjectId), 2);

  const restoredWorkspace = await request("/api/v1/workspaces/public-space/commands/restore", {
    body: { expected_version: 2 },
    headers: ownerHeaders({ "idempotency-key": "wp08-restore-workspace" }),
    method: "POST",
  });
  assert.equal(restoredWorkspace.response.status, 200);
  assert.deepEqual(
    restoredWorkspace.body.resource.resumed_public_projects.projects,
    workspaceRecoveryProjects,
  );
  const restoredByWorkspace = await request("/api/v1/public-projects");
  assert.deepEqual(
    restoredByWorkspace.body.items.map((item) => item.public_id).sort(),
    [publicId, secondPublicId].sort(),
  );
  await assertSecretsAbsentFromPersistence([
    joinTokenA,
    joinTokenB,
    joinTokenC,
    joinTokenD,
    joinTokenE,
    joinTokenF,
    joinTokenG,
    publicJoinSessionToken,
  ]);
});

test("KENN-338 validates every enabled recovery row while bounding the displayed summary", async () => {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO workspaces
      (id, key, display_name, created_at, updated_at, created_by_principal_id,
       updated_by_principal_id, created_operation_id)
     VALUES ('kenn338-workspace', 'recovery-scale', 'Recovery Scale', ?1, ?1, ?2, ?2,
             'kenn338-workspace-create')`,
  ).bind(now, ids.ownerPrincipal).run();
  await db.prepare(
    `INSERT INTO workspaces
      (id, key, display_name, created_at, updated_at, created_by_principal_id,
       updated_by_principal_id, created_operation_id)
     VALUES ('kenn338-disabled-workspace', 'disabled-scale', 'Disabled Scale', ?1, ?1, ?2, ?2,
             'kenn338-disabled-workspace-create')`,
  ).bind(now, ids.ownerPrincipal).run();
  await db.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
     )
     INSERT INTO projects
       (id, workspace_id, key, display_name, issue_limit, comment_limit, principal_limit,
        created_at, updated_at, created_by_principal_id, updated_by_principal_id,
        created_operation_id)
     SELECT printf('kenn338-enabled-%03d', value), 'kenn338-workspace', printf('E%03d', value),
            printf('Enabled %03d', value), 10, 10, 10, ?1, ?1, ?2, ?2,
            printf('kenn338-enabled-create-%03d', value)
     FROM sequence`,
  ).bind(now, ids.ownerPrincipal).run();
  await db.prepare(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
     )
     INSERT INTO projects
       (id, workspace_id, key, display_name, created_at, updated_at,
        created_by_principal_id, updated_by_principal_id, created_operation_id)
     SELECT printf('kenn338-disabled-%05d', value), 'kenn338-disabled-workspace', printf('D%05d', value),
            printf('Disabled %05d', value), ?1, ?1, ?2, ?2,
            printf('kenn338-disabled-create-%05d', value)
     FROM sequence`,
  ).bind(now, ids.ownerPrincipal).run();
  await db.prepare(
    `INSERT INTO public_join_policies
      (project_id, workspace_id, project_key, public_id, public_summary, enabled_at, enabled_by_principal_id,
       version, created_at, updated_at)
     SELECT id, workspace_id, key, printf('public-%s', id), printf('Summary for %s', key), ?1, ?2, 1, ?1, ?1
     FROM projects WHERE workspace_id = 'kenn338-workspace' AND key LIKE 'E%'`,
  ).bind(now, ids.ownerPrincipal).run();
  await db.prepare(
    `INSERT INTO public_join_policies
      (project_id, workspace_id, project_key, public_id, public_summary, enabled_at, enabled_by_principal_id,
       disabled_at, disabled_by_principal_id, version, created_at, updated_at)
     SELECT id, workspace_id, key, printf('public-%s', id), printf('Disabled summary for %s', key),
            ?1, ?2, ?1 + 1, ?2, 2, ?1, ?1 + 1
     FROM projects WHERE workspace_id = 'kenn338-disabled-workspace'`,
  ).bind(now, ids.ownerPrincipal).run();
  await db.prepare(
    `INSERT INTO project_usage
      (project_id, active_issue_count, active_comment_count, active_principal_count, updated_at)
     SELECT id, 0, 0, 0, ?1
     FROM projects
     WHERE workspace_id = 'kenn338-workspace' AND key BETWEEN 'E001' AND 'E100'`,
  ).bind(now).run();

  const deletedDisabledOnly = await request(
    "/api/v1/workspaces/disabled-scale?expected_version=1",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(deletedDisabledOnly.response.status, 200);
  const disabledOnlyTombstone = await request(
    "/api/v1/workspaces/disabled-scale?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.deepEqual(disabledOnlyTombstone.body.resumed_public_projects, {
    has_more: false,
    projects: [],
  });

  const eventCountBefore = await tableCount(
    "events",
    "workspace_id = 'kenn338-workspace' AND type = 'workspace.deleted'",
  );
  const operationCountBefore = await tableCount("operation_commits");
  const rejectedAtRow101 = await request(
    "/api/v1/workspaces/recovery-scale?expected_version=1",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(rejectedAtRow101.response.status, 503);
  assert.equal(rejectedAtRow101.body.code, "PLATFORM_UNAVAILABLE");
  assert.deepEqual(
    await db.prepare("SELECT deleted_at, version FROM workspaces WHERE id = 'kenn338-workspace'").first(),
    { deleted_at: null, version: 1 },
  );
  assert.equal(
    await tableCount("events", "workspace_id = 'kenn338-workspace' AND type = 'workspace.deleted'"),
    eventCountBefore,
  );
  assert.equal(await tableCount("operation_commits"), operationCountBefore);

  await db.prepare(
    `INSERT INTO project_usage
      (project_id, active_issue_count, active_comment_count, active_principal_count, updated_at)
     VALUES ('kenn338-enabled-101', 0, 0, 0, ?1)`,
  ).bind(now).run();
  const deleted = await request(
    "/api/v1/workspaces/recovery-scale?expected_version=1",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(deleted.response.status, 200);
  const tombstoneDetail = await request(
    "/api/v1/workspaces/recovery-scale?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.equal(tombstoneDetail.response.status, 200);
  assert.equal(tombstoneDetail.body.resumed_public_projects.has_more, true);
  assert.equal(tombstoneDetail.body.resumed_public_projects.projects.length, 100);
  assert.deepEqual(
    tombstoneDetail.body.resumed_public_projects.projects.map((project) => project.key),
    Array.from({ length: 100 }, (_, index) => `E${String(index + 1).padStart(3, "0")}`),
  );
});
