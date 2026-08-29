import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://kanban.example.test";
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const joinTokenA = `cfk_v1_publica_${"B".repeat(43)}`;
const joinTokenB = `cfk_v1_publicb_${"C".repeat(43)}`;
const joinTokenC = `cfk_v1_publicc_${"D".repeat(43)}`;
const joinTokenD = `cfk_v1_publicd_${"E".repeat(43)}`;
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

  const pausedSecond = await request(
    "/api/v1/workspaces/public-space/projects/AUX?expected_version=3",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(pausedSecond.response.status, 200);
  assert.equal(pausedSecond.body.resource.deleted_at !== null, true);
  assert.equal(await tableCount("project_usage", "project_id = ?1", secondProjectId), 1);
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
  assert.deepEqual(restoredSecond.body.resource.resumed_public_projects.projects, [{
    id: secondProjectId,
    key: "AUX",
  }]);
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
  assert.deepEqual(rateSettings.body.policies.principal, { limit: 120, period_seconds: 60 });
  assert.equal(rateSettings.body.editable_via_api, false);
  assert.equal(rateSettings.body.recent_429_summary.observation_scope, "worker_isolate_best_effort");
  assert.equal(rateSettings.body.recent_429_summary.window_seconds, 300);
  assert.ok(rateSettings.body.recent_429_summary.total <= 128);

  const pausedWorkspace = await request(
    "/api/v1/workspaces/public-space?expected_version=1",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(pausedWorkspace.response.status, 200);
  const hiddenByWorkspace = await request("/api/v1/public-projects");
  assert.deepEqual(hiddenByWorkspace.body.items, []);
  assert.equal(await tableCount("project_usage", "project_id IN (?1, ?2)", projectId, secondProjectId), 2);

  const restoredWorkspace = await request("/api/v1/workspaces/public-space/commands/restore", {
    body: { expected_version: 2 },
    headers: ownerHeaders({ "idempotency-key": "wp08-restore-workspace" }),
    method: "POST",
  });
  assert.equal(restoredWorkspace.response.status, 200);
  assert.deepEqual(restoredWorkspace.body.resource.resumed_public_projects.projects, [
    { id: secondProjectId, key: "AUX" },
    { id: projectId, key: "PUB" },
  ]);
  const restoredByWorkspace = await request("/api/v1/public-projects");
  assert.deepEqual(
    restoredByWorkspace.body.items.map((item) => item.public_id).sort(),
    [publicId, secondPublicId].sort(),
  );
});
