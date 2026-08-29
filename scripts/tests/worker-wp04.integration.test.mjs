import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const token = (prefix, character) => `cfk_v1_${prefix}_${character.repeat(43)}`;
const initialOwnerToken = token("owner", "A");
const rotatedOwnerToken = token("owner2", "O");
const participantToken = token("member", "B");
const participantSpareToken = token("spare", "S");
const participantRotatedToken = token("member2", "R");
const participantRecoveredToken = token("member3", "F");
const conflictToken = initialOwnerToken;
const quotaToken = token("quota", "Q");
const ids = {
  bootstrapOperation: "40000000-0000-4000-8000-000000000004",
  instance: "40000000-0000-4000-8000-000000000001",
  ownerCredential: "40000000-0000-4000-8000-000000000002",
  ownerPrincipal: "40000000-0000-4000-8000-000000000003",
  participantSpareCredential: "40000000-0000-4000-8000-000000000005",
};

const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});

let db;
let ownerToken = initialOwnerToken;

function ownerHeaders(extra = {}) {
  return { authorization: `Bearer ${ownerToken}`, ...extra };
}

function participantHeaders(currentToken, extra = {}) {
  return { authorization: `Bearer ${currentToken}`, ...extra };
}

async function request(path, { body, headers = {}, method = "GET" } = {}) {
  return server.fetch(path, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    method,
  });
}

async function jsonRequest(path, options) {
  const response = await request(path, options);
  return { body: await response.json(), response };
}

function invitationCode(writeBody) {
  const inviteUrl = new URL(writeBody.resource.invite_url);
  const code = inviteUrl.searchParams.get("code");
  assert.ok(code);
  return code;
}

function assertWriteResult(value, replay = false) {
  assert.equal(value.idempotent_replay, replay);
  assert.equal(typeof value.event_cursor, "string");
  assert.equal(typeof value.resource, "object");
}

async function createInvitation(body, idempotencyKey) {
  return jsonRequest("/api/v1/admin/invitations", {
    body,
    headers: ownerHeaders({ "idempotency-key": idempotencyKey }),
    method: "POST",
  });
}

async function assertSecretsAbsentFromPersistence(secrets) {
  const [events, idempotency, invitations] = await Promise.all([
    db.prepare("SELECT payload_json FROM events").all(),
    db.prepare("SELECT response_json FROM idempotency_records WHERE response_json IS NOT NULL").all(),
    db.prepare("SELECT code_prefix, code_digest FROM invitations").all(),
  ]);
  const persisted = JSON.stringify([events.results, idempotency.results, invitations.results]);
  const logs = JSON.stringify(server.getLogs());
  for (const secret of secrets) {
    assert.equal(persisted.includes(secret), false);
    assert.equal(logs.includes(secret), false);
  }
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
    ownerCredentialToken: initialOwnerToken,
    ownerDisplayName: "Deployment Owner",
    ownerPrincipalId: ids.ownerPrincipal,
    preferredApiOrigin: "https://kanban.example.test",
  });
});

after(async () => {
  await server.close();
});

test("WP-04 implements hash-only Invitations, atomic identity bootstrap, Grants, recovery, and Owner rotation", async () => {
  const workspace = await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Engineering", key: "engineering" },
    headers: ownerHeaders({ "idempotency-key": "wp04-workspace" }),
    method: "POST",
  });
  assert.equal(workspace.response.status, 200);

  const firstProject = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { display_name: "Core", key: "CORE" },
    headers: ownerHeaders({ "idempotency-key": "wp04-project-core" }),
    method: "POST",
  });
  const secondProject = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { display_name: "Docs", key: "DOCS" },
    headers: ownerHeaders({ "idempotency-key": "wp04-project-docs" }),
    method: "POST",
  });
  assert.equal(firstProject.response.status, 200);
  assert.equal(secondProject.response.status, 200);
  const firstProjectId = firstProject.body.resource.id;
  const secondProjectId = secondProject.body.resource.id;

  const projectInviteBody = {
    grants: [
      { project_id: firstProjectId, role: "reader" },
      { project_id: secondProjectId, role: "writer" },
    ],
    kind: "project_grant",
  };
  const createdInvite = await createInvitation(projectInviteBody, "wp04-project-invite");
  assert.equal(createdInvite.response.status, 200);
  assertWriteResult(createdInvite.body);
  assert.equal(createdInvite.body.resource.secret_available, true);
  const projectInviteCode = invitationCode(createdInvite.body);
  assert.equal(
    Date.parse(createdInvite.body.resource.expires_at) - Date.parse(createdInvite.body.resource.created_at),
    7 * 24 * 60 * 60 * 1_000,
  );

  const replayedInvite = await createInvitation(projectInviteBody, "wp04-project-invite");
  assert.equal(replayedInvite.response.status, 200);
  assertWriteResult(replayedInvite.body, true);
  assert.equal(replayedInvite.body.resource.secret_available, false);
  assert.equal(JSON.stringify(replayedInvite.body).includes(projectInviteCode), false);

  const invitationPage = await request(`/invite?code=${encodeURIComponent(projectInviteCode)}`);
  assert.equal(invitationPage.status, 200);
  assert.equal(invitationPage.headers.get("cache-control"), "no-store");
  assert.equal(invitationPage.headers.get("referrer-policy"), "no-referrer");
  assert.match(invitationPage.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const invitationHtml = await invitationPage.text();
  assert.equal(invitationHtml.includes(projectInviteCode), false);
  assert.match(invitationHtml, /history\.replaceState/);
  const inviteBeforeRedeem = await db.prepare(
    "SELECT redeemed_at FROM invitations WHERE code_digest = ?1",
  ).bind(await sha256Hex(projectInviteCode)).first();
  assert.equal(inviteBeforeRedeem.redeemed_at, null);

  const redeemBody = {
    display_name: "Participant",
    invite_code: projectInviteCode,
    new_credential_token: participantToken,
    redeem_as: "new_principal",
  };
  const redeemed = await jsonRequest("/api/v1/invitations/redeem", {
    body: redeemBody,
    headers: { "idempotency-key": "wp04-project-redeem" },
    method: "POST",
  });
  assert.equal(redeemed.response.status, 200);
  assertWriteResult(redeemed.body);
  assert.deepEqual(
    redeemed.body.resource.results.map((item) => item.outcome),
    ["created", "created"],
  );
  assert.equal(JSON.stringify(redeemed.body).includes(projectInviteCode), false);
  assert.equal(JSON.stringify(redeemed.body).includes(participantToken), false);
  const participantId = redeemed.body.resource.principal.principal_id;
  const participantCredentialId = redeemed.body.resource.credential.id;

  const replayedRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: redeemBody,
    headers: { "idempotency-key": "wp04-project-redeem" },
    method: "POST",
  });
  assert.equal(replayedRedeem.response.status, 200);
  assertWriteResult(replayedRedeem.body, true);
  const secondRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: redeemBody,
    headers: { "idempotency-key": "wp04-project-redeem-second" },
    method: "POST",
  });
  assert.equal(secondRedeem.response.status, 409);
  assert.equal(secondRedeem.body.code, "INVITATION_ALREADY_REDEEMED");

  const participantProject = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE", {
    headers: participantHeaders(participantToken),
  });
  assert.equal(participantProject.response.status, 200);
  const participantAdmin = await jsonRequest("/api/v1/admin/principals", {
    headers: participantHeaders(participantToken),
  });
  assert.equal(participantAdmin.response.status, 403);

  const principalDetail = await jsonRequest(`/api/v1/admin/principals/${participantId}`, {
    headers: ownerHeaders(),
  });
  assert.equal(principalDetail.response.status, 200);
  assert.equal(principalDetail.body.grants.length, 2);
  assert.equal(principalDetail.body.credentials.length, 1);
  assert.equal(JSON.stringify(principalDetail.body).includes(participantToken), false);

  const firstGrant = principalDetail.body.grants.find((grant) => grant.project_id === firstProjectId);
  assert.ok(firstGrant);
  const updatedGrant = await jsonRequest(`/api/v1/admin/grants/${firstGrant.id}`, {
    body: { expected_version: firstGrant.version, role: "writer" },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(updatedGrant.response.status, 200);
  assert.equal(updatedGrant.body.resource.role, "writer");
  const revokedGrant = await jsonRequest(
    `/api/v1/admin/grants/${firstGrant.id}?expected_version=${updatedGrant.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(revokedGrant.response.status, 200);
  assert.equal(revokedGrant.body.resource.revoked_at !== null, true);
  const hiddenProject = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE", {
    headers: participantHeaders(participantToken),
  });
  assert.equal(hiddenProject.response.status, 404);
  const regranted = await jsonRequest(`/api/v1/admin/projects/${firstProjectId}/grants`, {
    body: { principal_id: participantId, role: "reader" },
    headers: ownerHeaders({ "idempotency-key": "wp04-regrant" }),
    method: "POST",
  });
  assert.equal(regranted.response.status, 200);
  assert.equal(regranted.body.resource.id, firstGrant.id);
  assert.equal(regranted.body.resource.role, "reader");
  const ownerGrant = await jsonRequest(`/api/v1/admin/projects/${firstProjectId}/grants`, {
    body: { principal_id: ids.ownerPrincipal, role: "writer" },
    headers: ownerHeaders({ "idempotency-key": "wp04-owner-grant" }),
    method: "POST",
  });
  assert.equal(ownerGrant.response.status, 403);

  const roleRequired = await createInvitation({
    grants: [{ project_id: firstProjectId }],
    kind: "project_grant",
  }, "wp04-role-required");
  assert.equal(roleRequired.response.status, 400);

  const existingGrantInvite = await createInvitation({
    grants: [{ project_id: secondProjectId, role: "reader" }],
    kind: "project_grant",
  }, "wp04-existing-grant-invite");
  const existingGrantCode = invitationCode(existingGrantInvite.body);
  const existingGrantRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: { invite_code: existingGrantCode, redeem_as: "current_principal" },
    headers: participantHeaders(participantToken, { "idempotency-key": "wp04-existing-grant-redeem" }),
    method: "POST",
  });
  assert.equal(existingGrantRedeem.response.status, 200);
  assert.equal(existingGrantRedeem.body.resource.credential, null);
  assert.equal(existingGrantRedeem.body.resource.principal.principal_id, participantId);
  assert.equal(existingGrantRedeem.body.resource.results[0].outcome, "already_has_access");
  assert.equal(existingGrantRedeem.body.resource.results[0].effective_role, "writer");

  const revokeForInvite = await jsonRequest(
    `/api/v1/admin/grants/${firstGrant.id}?expected_version=${regranted.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(revokeForInvite.response.status, 200);
  const regrantInvite = await createInvitation({
    grants: [{ project_id: firstProjectId, role: "writer" }],
    kind: "project_grant",
  }, "wp04-regrant-invite");
  const regrantCode = invitationCode(regrantInvite.body);
  const regrantRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: { invite_code: regrantCode, redeem_as: "current_principal" },
    headers: participantHeaders(participantToken, { "idempotency-key": "wp04-regrant-redeem" }),
    method: "POST",
  });
  assert.equal(regrantRedeem.response.status, 200);
  assert.equal(regrantRedeem.body.resource.results[0].outcome, "regranted");
  assert.equal(regrantRedeem.body.resource.results[0].effective_role, "writer");

  const invitationCount = await db.prepare("SELECT COUNT(*) AS count FROM invitations").first();
  const invalidInvite = await createInvitation({
    grants: [
      { project_id: firstProjectId, role: "reader" },
      { project_id: "49999999-9999-4999-8999-999999999999", role: "writer" },
    ],
    kind: "project_grant",
  }, "wp04-invalid-project-invite");
  assert.equal(invalidInvite.response.status, 404);
  const invitationCountAfter = await db.prepare("SELECT COUNT(*) AS count FROM invitations").first();
  assert.equal(invitationCountAfter.count, invitationCount.count);

  const conflictInvite = await createInvitation({
    grants: [{ project_id: firstProjectId, role: "reader" }],
    kind: "project_grant",
  }, "wp04-conflict-invite");
  const conflictInviteCode = invitationCode(conflictInvite.body);
  const modeMismatch = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      invite_code: conflictInviteCode,
      new_credential_token: quotaToken,
      redeem_as: "recovery",
    },
    headers: { "idempotency-key": "wp04-mode-mismatch" },
    method: "POST",
  });
  assert.equal(modeMismatch.response.status, 400);
  assert.equal(modeMismatch.body.code, "INVITATION_MODE_MISMATCH");
  const principalCount = await db.prepare("SELECT COUNT(*) AS count FROM principals").first();
  const conflictRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      display_name: "Must Roll Back",
      invite_code: conflictInviteCode,
      new_credential_token: conflictToken,
      redeem_as: "new_principal",
    },
    headers: { "idempotency-key": "wp04-conflict-redeem" },
    method: "POST",
  });
  assert.equal(conflictRedeem.response.status, 409);
  assert.equal(conflictRedeem.body.code, "CREDENTIAL_TOKEN_CONFLICT");
  const principalCountAfter = await db.prepare("SELECT COUNT(*) AS count FROM principals").first();
  assert.equal(principalCountAfter.count, principalCount.count);
  const conflictInviteRow = await db.prepare(
    "SELECT redeemed_at FROM invitations WHERE code_digest = ?1",
  ).bind(await sha256Hex(conflictInviteCode)).first();
  assert.equal(conflictInviteRow.redeemed_at, null);

  await db.prepare(
    `INSERT INTO credentials
      (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
     VALUES (?1, ?2, 'spare', ?3, ?4, 'wp04-spare-credential')`,
  ).bind(
    ids.participantSpareCredential,
    participantId,
    await sha256Hex(participantSpareToken),
    Date.now(),
  ).run();

  const rotationInvite = await createInvitation({
    kind: "principal_recovery",
    principal_id: participantId,
    recovery_mode: "rotation",
  }, "wp04-recovery-rotation-invite");
  assert.equal(rotationInvite.response.status, 200);
  assert.equal(
    Date.parse(rotationInvite.body.resource.expires_at) - Date.parse(rotationInvite.body.resource.created_at),
    60 * 60 * 1_000,
  );
  const rotationCode = invitationCode(rotationInvite.body);
  const principalMismatch = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      invite_code: rotationCode,
      new_credential_token: quotaToken,
      redeem_as: "recovery",
    },
    headers: ownerHeaders({ "idempotency-key": "wp04-recovery-principal-mismatch" }),
    method: "POST",
  });
  assert.equal(principalMismatch.response.status, 403);
  assert.equal(principalMismatch.body.code, "RECOVERY_PRINCIPAL_MISMATCH");
  const rotatedParticipant = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      invite_code: rotationCode,
      new_credential_token: participantRotatedToken,
      redeem_as: "recovery",
    },
    headers: participantHeaders(participantToken, { "idempotency-key": "wp04-recovery-rotation" }),
    method: "POST",
  });
  assert.equal(rotatedParticipant.response.status, 200);
  assert.equal(JSON.stringify(rotatedParticipant.body).includes(participantRotatedToken), false);
  const replayedParticipantRotation = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      invite_code: rotationCode,
      new_credential_token: participantRotatedToken,
      redeem_as: "recovery",
    },
    headers: participantHeaders(participantToken, { "idempotency-key": "wp04-recovery-rotation" }),
    method: "POST",
  });
  assert.equal(replayedParticipantRotation.response.status, 200);
  assertWriteResult(replayedParticipantRotation.body, true);
  const oldParticipant = await jsonRequest("/api/v1/me", { headers: participantHeaders(participantToken) });
  assert.equal(oldParticipant.response.status, 401);
  const spareParticipant = await jsonRequest("/api/v1/me", { headers: participantHeaders(participantSpareToken) });
  assert.equal(spareParticipant.response.status, 200);
  const newParticipant = await jsonRequest("/api/v1/me", { headers: participantHeaders(participantRotatedToken) });
  assert.equal(newParticipant.response.status, 200);

  const fullRecoveryInvite = await createInvitation({
    kind: "principal_recovery",
    principal_id: participantId,
    recovery_mode: "full_recovery",
  }, "wp04-full-recovery-invite");
  const fullRecoveryCode = invitationCode(fullRecoveryInvite.body);
  const fullyRecovered = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      invite_code: fullRecoveryCode,
      new_credential_token: participantRecoveredToken,
      redeem_as: "recovery",
    },
    headers: { "idempotency-key": "wp04-full-recovery" },
    method: "POST",
  });
  assert.equal(fullyRecovered.response.status, 200);
  const replayedFullRecovery = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      invite_code: fullRecoveryCode,
      new_credential_token: participantRecoveredToken,
      redeem_as: "recovery",
    },
    headers: { "idempotency-key": "wp04-full-recovery" },
    method: "POST",
  });
  assert.equal(replayedFullRecovery.response.status, 200);
  assertWriteResult(replayedFullRecovery.body, true);
  const revokedSpare = await jsonRequest("/api/v1/me", { headers: participantHeaders(participantSpareToken) });
  assert.equal(revokedSpare.response.status, 401);
  const revokedRotated = await jsonRequest("/api/v1/me", { headers: participantHeaders(participantRotatedToken) });
  assert.equal(revokedRotated.response.status, 401);
  const recoveredParticipant = await jsonRequest("/api/v1/me", { headers: participantHeaders(participantRecoveredToken) });
  assert.equal(recoveredParticipant.response.status, 200);

  const recoveredCredentialId = fullyRecovered.body.resource.credential.id;
  const revokedCredential = await jsonRequest(
    `/api/v1/admin/credentials/${recoveredCredentialId}?expected_version=1`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(revokedCredential.response.status, 200);
  const revokedRecovered = await jsonRequest("/api/v1/me", { headers: participantHeaders(participantRecoveredToken) });
  assert.equal(revokedRecovered.response.status, 401);
  const revokeOwner = await jsonRequest(
    `/api/v1/admin/credentials/${ids.ownerCredential}?expected_version=1`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(revokeOwner.response.status, 403);

  await db.prepare(
    `UPDATE projects SET principal_limit = 1 WHERE id = ?1`,
  ).bind(secondProjectId).run();
  await db.prepare(
    `INSERT INTO public_join_policies
      (project_id, public_id, public_summary, enabled_at, enabled_by_principal_id,
       version, created_at, updated_at, last_operation_id)
     VALUES (?1, 'wp04-public', 'Quota test', ?2, ?3, 1, ?2, ?2, 'wp04-policy')`,
  ).bind(secondProjectId, Date.now(), ids.ownerPrincipal).run();
  const quotaInvite = await createInvitation({
    grants: [{ project_id: secondProjectId, role: "reader" }],
    kind: "project_grant",
  }, "wp04-quota-invite");
  const quotaCode = invitationCode(quotaInvite.body);
  const beforeQuotaPrincipals = await db.prepare("SELECT COUNT(*) AS count FROM principals").first();
  const quotaRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      display_name: "Quota Rollback",
      invite_code: quotaCode,
      new_credential_token: quotaToken,
      redeem_as: "new_principal",
    },
    headers: { "idempotency-key": "wp04-quota-redeem" },
    method: "POST",
  });
  assert.equal(quotaRedeem.response.status, 409);
  assert.equal(quotaRedeem.body.code, "PROJECT_PRINCIPAL_LIMIT_REACHED");
  const afterQuotaPrincipals = await db.prepare("SELECT COUNT(*) AS count FROM principals").first();
  assert.equal(afterQuotaPrincipals.count, beforeQuotaPrincipals.count);

  const revocableInvite = await createInvitation({
    grants: [{ project_id: firstProjectId, role: "reader" }],
    kind: "project_grant",
  }, "wp04-revocable-invite");
  const revocableCode = invitationCode(revocableInvite.body);
  const revokedInvite = await jsonRequest(
    `/api/v1/admin/invitations/${revocableInvite.body.resource.id}?expected_version=1`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(revokedInvite.response.status, 200);
  const revokedInvitePage = await jsonRequest(`/invite?code=${encodeURIComponent(revocableCode)}`);
  assert.equal(revokedInvitePage.response.status, 410);
  assert.equal(revokedInvitePage.body.code, "INVITATION_REVOKED");

  const expiringInvite = await createInvitation({
    grants: [{ project_id: firstProjectId, role: "reader" }],
    kind: "project_grant",
  }, "wp04-expiring-invite");
  const expiringCode = invitationCode(expiringInvite.body);
  await db.prepare(
    "UPDATE invitations SET expires_at = created_at + 1 WHERE id = ?1",
  ).bind(expiringInvite.body.resource.id).run();
  const expiredInvitePage = await jsonRequest(`/invite?code=${encodeURIComponent(expiringCode)}`);
  assert.equal(expiredInvitePage.response.status, 410);
  assert.equal(expiredInvitePage.body.code, "INVITATION_EXPIRED");

  const rotatedOwner = await jsonRequest("/api/v1/admin/owner-credentials/rotate", {
    body: { new_credential_token: rotatedOwnerToken },
    headers: ownerHeaders({ "idempotency-key": "wp04-owner-rotation" }),
    method: "POST",
  });
  assert.equal(rotatedOwner.response.status, 200);
  assert.equal(JSON.stringify(rotatedOwner.body).includes(rotatedOwnerToken), false);
  const revokedOwnerId = rotatedOwner.body.resource.revoked_credential_id;
  assert.equal(revokedOwnerId, ids.ownerCredential);
  const initialOwner = await jsonRequest("/api/v1/me", { headers: ownerHeaders() });
  assert.equal(initialOwner.response.status, 401);
  const oldOwnerToken = ownerToken;
  ownerToken = rotatedOwnerToken;
  const currentOwner = await jsonRequest("/api/v1/me", { headers: ownerHeaders() });
  assert.equal(currentOwner.response.status, 200);
  const replayedOwnerRotation = await jsonRequest("/api/v1/admin/owner-credentials/rotate", {
    body: { new_credential_token: rotatedOwnerToken },
    headers: participantHeaders(oldOwnerToken, { "idempotency-key": "wp04-owner-rotation" }),
    method: "POST",
  });
  assert.equal(replayedOwnerRotation.response.status, 200);
  assertWriteResult(replayedOwnerRotation.body, true);
  assert.equal(replayedOwnerRotation.body.resource.revoked_credential_id, ids.ownerCredential);

  const ownerCredentialId = rotatedOwner.body.resource.id;
  const rejectOwnerRevoke = await jsonRequest(
    `/api/v1/admin/credentials/${ownerCredentialId}?expected_version=1`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(rejectOwnerRevoke.response.status, 403);

  await assertSecretsAbsentFromPersistence([
    projectInviteCode,
    existingGrantCode,
    regrantCode,
    conflictInviteCode,
    rotationCode,
    fullRecoveryCode,
    quotaCode,
    revocableCode,
    expiringCode,
    initialOwnerToken,
    participantToken,
    participantSpareToken,
    participantRotatedToken,
    participantRecoveredToken,
    quotaToken,
    rotatedOwnerToken,
  ]);

  const activeGrants = await db.prepare(
    "SELECT COUNT(*) AS count FROM project_grants WHERE principal_id = ?1 AND revoked_at IS NULL",
  ).bind(participantId).first();
  assert.equal(activeGrants.count, 2);
  const firstUsage = await db.prepare(
    "SELECT active_principal_count FROM project_usage WHERE project_id = ?1",
  ).bind(firstProjectId).first();
  assert.equal(firstUsage.active_principal_count, 1);
  assert.notEqual(participantCredentialId, recoveredCredentialId);
});
