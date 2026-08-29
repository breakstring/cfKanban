import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import {
  createInvitation as createInvitationService,
  redeemInvitation as redeemInvitationService,
} from "../../apps/worker/src/services/invitations.ts";
import { rotateOwnerCredential as rotateOwnerCredentialService } from "../../apps/worker/src/services/access.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const token = (prefix, character) => `cfk_v1_${prefix}_${character.repeat(43)}`;
const initialOwnerToken = token("owner", "A");
const rotatedOwnerToken = token("owner2", "O");
const exposedOwnerToken = token("exposed", "X");
const racedOwnerToken = token("race", "Y");
const participantToken = token("member", "B");
const participantSpareToken = token("spare", "S");
const participantRotatedToken = token("member2", "R");
const participantRecoveredToken = token("member3", "F");
const conflictToken = initialOwnerToken;
const quotaToken = token("quota", "Q");
const bulkNewToken = token("bulk", "W");
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

function countingDatabase(database) {
  let queryCount = 0;
  const rawStatements = new WeakMap();
  const queryMethods = new Set(["all", "first", "raw", "run"]);

  const wrapStatement = (statement) => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values) => wrapStatement(target.bind(...values));
        }
        if (queryMethods.has(property)) {
          return (...args) => {
            queryCount += 1;
            return target[property](...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    return wrapped;
  };

  return {
    db: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql) => wrapStatement(target.prepare(sql));
        }
        if (property === "batch") {
          return (statements) => {
            queryCount += statements.length;
            return target.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    get queryCount() {
      return queryCount;
    },
  };
}

function snapshotReadBarrierDatabase(database) {
  let paused = false;
  let releaseRead;
  let signalReached;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const wrapStatement = (statement, matches) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), matches);
      }
      if (property === "first" && matches) {
        return async (...args) => {
          if (!paused) {
            paused = true;
            signalReached();
            await released;
          }
          return target.first(...args);
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
          return (sql) => wrapStatement(
            target.prepare(sql),
            sql.includes("SELECT operation_snapshot_json FROM idempotency_records"),
          );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    reached,
    release() {
      releaseRead();
    },
  };
}

function businessBatchBarrierDatabase(database, sqlFragment) {
  let paused = false;
  let releaseBatch;
  let signalReached;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseBatch = resolve;
  });
  const rawStatements = new WeakMap();
  const matchedStatements = new WeakSet();
  const wrapStatement = (statement, matches) => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values) => wrapStatement(target.bind(...values), matches);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    if (matches) matchedStatements.add(wrapped);
    return wrapped;
  };
  return {
    db: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql) => wrapStatement(target.prepare(sql), sql.includes(sqlFragment));
        }
        if (property === "batch") {
          return async (statements) => {
            if (!paused && statements.some((statement) => matchedStatements.has(statement))) {
              paused = true;
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

  const [concurrentInviteLeft, concurrentInviteRight] = await Promise.all([
    createInvitation(projectInviteBody, "wp04-concurrent-invite-create"),
    createInvitation(projectInviteBody, "wp04-concurrent-invite-create"),
  ]);
  assert.equal(concurrentInviteLeft.response.status, 200, JSON.stringify(concurrentInviteLeft.body));
  assert.equal(concurrentInviteRight.response.status, 200, JSON.stringify(concurrentInviteRight.body));
  assert.equal(concurrentInviteLeft.body.resource.id, concurrentInviteRight.body.resource.id);
  assert.deepEqual(
    new Set([concurrentInviteLeft.body.idempotent_replay, concurrentInviteRight.body.idempotent_replay]),
    new Set([false, true]),
  );
  assert.equal(
    [concurrentInviteLeft, concurrentInviteRight].filter((result) => result.body.resource.secret_available).length,
    1,
  );

  const barrierKey = "wp04-concurrent-invite-create-barrier";
  const barrierRequest = () => new Request("https://kanban.example.test/api/v1/admin/invitations", {
    headers: ownerHeaders({ "idempotency-key": barrierKey }),
    method: "POST",
  });
  const barrierAuth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  const snapshotBarrier = snapshotReadBarrierDatabase(db);
  const secretHolder = createInvitationService(
    snapshotBarrier.db,
    barrierRequest(),
    barrierAuth,
    "project_grant",
    projectInviteBody.grants,
    undefined,
    undefined,
    Date.now(),
  );
  await snapshotBarrier.reached;
  let safePeer;
  let pendingSecretDelivery;
  let safePeerError;
  try {
    safePeer = await createInvitationService(
      db,
      barrierRequest(),
      barrierAuth,
      "project_grant",
      projectInviteBody.grants,
      undefined,
      undefined,
      Date.now(),
    );
    pendingSecretDelivery = await db.prepare(
      `SELECT state, operation_snapshot_json
       FROM idempotency_records
       WHERE operation_id = (
         SELECT last_operation_id FROM invitations WHERE id = ?1
       )`,
    ).bind(safePeer.resource.id).first();
  } catch (error) {
    safePeerError = error;
  } finally {
    snapshotBarrier.release();
  }
  const deliveredSecret = await secretHolder;
  if (safePeerError !== undefined) throw safePeerError;
  assert.equal(safePeer.resource.secret_available, false);
  assert.equal(pendingSecretDelivery.state, "pending");
  assert.notEqual(pendingSecretDelivery.operation_snapshot_json, null);
  assert.equal(deliveredSecret.resource.id, safePeer.resource.id);
  assert.equal(deliveredSecret.resource.secret_available, true);
  assert.equal(deliveredSecret.idempotent_replay, false);
  await assertSecretsAbsentFromPersistence([invitationCode({ resource: deliveredSecret.resource })]);

  const invitationPage = await request(`/invite?code=${encodeURIComponent(projectInviteCode)}`);
  assert.equal(invitationPage.status, 200);
  assert.equal(invitationPage.headers.get("cache-control"), "no-store");
  assert.equal(invitationPage.headers.get("referrer-policy"), "no-referrer");
  assert.match(invitationPage.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const invitationHtml = await invitationPage.text();
  assert.equal(invitationHtml.includes(projectInviteCode), false);
  assert.match(invitationHtml, /history\.replaceState/);
  const executableScript = /<script>([\s\S]*?)<\/script>/.exec(invitationHtml)?.[1];
  assert.equal(typeof executableScript, "string");
  const executableScriptSource = `sha256-${createHash("sha256").update(executableScript).digest("base64")}`;
  assert.match(
    invitationPage.headers.get("content-security-policy") ?? "",
    new RegExp(`script-src '${executableScriptSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`),
  );
  assert.match(invitationHtml, /<html lang="en">/);
  assert.match(invitationHtml, /data-select-locale="en"/);
  assert.match(invitationHtml, /data-select-locale="zh-CN"/);
  assert.match(invitationHtml, /engineering\/CORE/);
  assert.match(invitationHtml, new RegExp(firstProjectId));
  const chineseInvitationPage = await request(`/invite?code=${encodeURIComponent(projectInviteCode)}`, {
    headers: { "accept-language": "zh-CN,zh;q=0.9" },
  });
  assert.match(await chineseInvitationPage.text(), /<html lang="zh-CN">[\s\S]*目标 Project/);
  const weightedEnglishPage = await request(`/invite?code=${encodeURIComponent(projectInviteCode)}`, {
    headers: { "accept-language": "en-US,en;q=0.9,zh-CN;q=0.1" },
  });
  assert.match(await weightedEnglishPage.text(), /<html lang="en">/);
  const zeroQualityChinesePage = await request(`/invite?code=${encodeURIComponent(projectInviteCode)}`, {
    headers: { "accept-language": "zh-CN;q=0,en;q=0.5" },
  });
  assert.match(await zeroQualityChinesePage.text(), /<html lang="en">/);
  const unknownLocalePage = await request(`/invite?code=${encodeURIComponent(projectInviteCode)}`, {
    headers: { "accept-language": "fr-FR" },
  });
  assert.match(await unknownLocalePage.text(), /<html lang="en">/);
  const inviteBeforeRedeem = await db.prepare(
    "SELECT redeemed_at FROM invitations WHERE code_digest = ?1",
  ).bind(await sha256Hex(projectInviteCode)).first();
  assert.equal(inviteBeforeRedeem.redeemed_at, null);

  const redemptionSideEffects = async () => db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM principals) AS principals,
       (SELECT COUNT(*) FROM credentials) AS credentials,
       (SELECT COUNT(*) FROM project_grants) AS grants,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits,
       (SELECT COUNT(*) FROM idempotency_records
        WHERE operation_snapshot_json IS NOT NULL) AS snapshots`,
  ).first();
  const secretOverlapBefore = await redemptionSideEffects();
  const secretOverlapRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      display_name: participantToken,
      invite_code: projectInviteCode,
      new_credential_token: participantToken,
      redeem_as: "new_principal",
    },
    headers: { "idempotency-key": "wp04-secret-overlap-redeem" },
    method: "POST",
  });
  assert.equal(secretOverlapRedeem.response.status, 400);
  assert.equal(secretOverlapRedeem.body.code, "VALIDATION_ERROR");
  assert.equal(secretOverlapRedeem.body.details.reason, "secret_value_reused");
  assert.deepEqual(await redemptionSideEffects(), secretOverlapBefore);

  const redeemBody = {
    display_name: "Participant",
    invite_code: projectInviteCode,
    new_credential_token: participantToken,
    redeem_as: "new_principal",
  };
  const [redeemed, concurrentRedeem] = await Promise.all([
    jsonRequest("/api/v1/invitations/redeem", {
      body: redeemBody,
      headers: { "idempotency-key": "wp04-project-redeem" },
      method: "POST",
    }),
    jsonRequest("/api/v1/invitations/redeem", {
      body: redeemBody,
      headers: { "idempotency-key": "wp04-project-redeem" },
      method: "POST",
    }),
  ]);
  assert.equal(redeemed.response.status, 200);
  assert.equal(concurrentRedeem.response.status, 200, JSON.stringify(concurrentRedeem.body));
  assert.equal(redeemed.body.resource.principal.principal_id, concurrentRedeem.body.resource.principal.principal_id);
  assert.deepEqual(
    new Set([redeemed.body.idempotent_replay, concurrentRedeem.body.idempotent_replay]),
    new Set([false, true]),
  );
  assertWriteResult(redeemed.body);
  assert.deepEqual(
    redeemed.body.resource.results.map((item) => item.outcome),
    ["created", "created"],
  );
  assert.equal(JSON.stringify(redeemed.body).includes(projectInviteCode), false);
  assert.equal(JSON.stringify(redeemed.body).includes(participantToken), false);
  const participantId = redeemed.body.resource.principal.principal_id;
  const participantCredentialId = redeemed.body.resource.credential.id;

  const bulkProjectIds = Array.from({ length: 20 }, () => crypto.randomUUID());
  const bulkCreatedAt = Date.now();
  await db.batch(bulkProjectIds.map((projectId, index) => db.prepare(
    `INSERT INTO projects
      (id, workspace_id, key, display_name, version, created_at, updated_at,
       created_by_principal_id, updated_by_principal_id, created_operation_id)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6, ?6, ?7)`,
  ).bind(
    projectId,
    workspace.body.resource.id,
    `B${String(index + 1).padStart(2, "0")}`,
    index === 0 ? `cfk_v1_demo_${"X".repeat(43)}` : `Bulk ${index + 1}`,
    bulkCreatedAt,
    ids.ownerPrincipal,
    crypto.randomUUID(),
  )));
  const bulkGrants = bulkProjectIds.map((projectId, index) => ({
    project_id: projectId,
    role: index % 2 === 0 ? "reader" : "writer",
  }));
  const invalidBulkGrants = [
    ...bulkGrants.slice(0, 19),
    { project_id: crypto.randomUUID(), role: "writer" },
  ];
  const invitationWriteCounts = async () => db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM invitations) AS invitations,
       (SELECT COUNT(*) FROM invitation_project_grants) AS invitation_grants,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits,
       (SELECT COUNT(*) FROM idempotency_records) AS idempotency_records`,
  ).first();
  const invalidBulkBefore = await invitationWriteCounts();
  const counted = countingDatabase(db);
  const invalidBulkRequest = new Request("https://kanban.example.test/api/v1/admin/invitations", {
    headers: ownerHeaders({ "idempotency-key": "wp04-invalid-bulk-invite" }),
    method: "POST",
  });
  const countedOwner = await authenticateBearer(
    counted.db,
    invalidBulkRequest.headers.get("authorization"),
  );
  await assert.rejects(
    () => createInvitationService(
      counted.db,
      invalidBulkRequest,
      countedOwner,
      "project_grant",
      invalidBulkGrants,
      undefined,
      undefined,
      Date.now(),
    ),
    (error) => error?.status === 404 && error?.code === "NOT_FOUND",
  );
  assert.ok(counted.queryCount <= 20, `invalid 20-project Invite used ${counted.queryCount} D1 queries`);
  assert.deepEqual(await invitationWriteCounts(), invalidBulkBefore);

  const bulkNewInvite = await createInvitation(
    { grants: bulkGrants, kind: "project_grant" },
    "wp04-bulk-new-invite",
  );
  assert.equal(bulkNewInvite.response.status, 200);
  assert.equal(bulkNewInvite.body.resource.grants.length, 20);
  const bulkNewCode = invitationCode(bulkNewInvite.body);
  const bulkNewRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      display_name: "Bulk New Principal",
      invite_code: bulkNewCode,
      new_credential_token: bulkNewToken,
      redeem_as: "new_principal",
    },
    headers: { "idempotency-key": "wp04-bulk-new-redeem" },
    method: "POST",
  });
  assert.equal(bulkNewRedeem.response.status, 200);
  assert.equal(bulkNewRedeem.body.resource.results.length, 20);
  assert.ok(bulkNewRedeem.body.resource.results.every((result) => result.outcome === "created"));
  const bulkNewPrincipalId = bulkNewRedeem.body.resource.principal.principal_id;

  const bulkCurrentInvite = await createInvitation(
    { grants: bulkGrants, kind: "project_grant" },
    "wp04-bulk-current-invite",
  );
  const bulkCurrentCode = invitationCode(bulkCurrentInvite.body);
  const bulkCurrentRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: { invite_code: bulkCurrentCode, redeem_as: "current_principal" },
    headers: participantHeaders(participantToken, { "idempotency-key": "wp04-bulk-current-redeem" }),
    method: "POST",
  });
  assert.equal(bulkCurrentRedeem.response.status, 200);
  assert.equal(bulkCurrentRedeem.body.resource.results.length, 20);
  assert.ok(bulkCurrentRedeem.body.resource.results.every((result) => result.outcome === "created"));

  const invitationPageOne = await jsonRequest("/api/v1/admin/invitations?limit=2", {
    headers: ownerHeaders(),
  });
  assert.equal(invitationPageOne.response.status, 200);
  assert.equal(invitationPageOne.body.items.length, 2);
  assert.equal(invitationPageOne.body.has_more, true);
  assert.equal(typeof invitationPageOne.body.next_cursor, "string");
  const invitationPageTwo = await jsonRequest(
    `/api/v1/admin/invitations?limit=2&cursor=${encodeURIComponent(invitationPageOne.body.next_cursor)}`,
    { headers: ownerHeaders() },
  );
  assert.equal(invitationPageTwo.response.status, 200);
  assert.ok(invitationPageTwo.body.items.length >= 1);
  assert.notEqual(invitationPageTwo.body.items[0].id, invitationPageOne.body.items[0].id);
  const invalidInvitationCursor = await jsonRequest("/api/v1/admin/invitations?cursor=%", {
    headers: ownerHeaders(),
  });
  assert.equal(invalidInvitationCursor.response.status, 400);
  assert.equal(invalidInvitationCursor.body.code, "INVALID_CURSOR");
  assert.equal(invalidInvitationCursor.body.recovery, "refresh_cursor");

  const principalPageOne = await jsonRequest("/api/v1/admin/principals?limit=1", {
    headers: ownerHeaders(),
  });
  assert.equal(principalPageOne.response.status, 200);
  assert.equal(principalPageOne.body.items.length, 1);
  assert.equal(principalPageOne.body.has_more, true);
  const principalPageTwo = await jsonRequest(
    `/api/v1/admin/principals?limit=1&cursor=${encodeURIComponent(principalPageOne.body.next_cursor)}`,
    { headers: ownerHeaders() },
  );
  assert.equal(principalPageTwo.response.status, 200);
  assert.equal(principalPageTwo.body.items.length, 1);
  assert.notEqual(principalPageTwo.body.items[0].id, principalPageOne.body.items[0].id);

  const bulkGrantPageOne = await jsonRequest(
    `/api/v1/admin/projects/${bulkProjectIds[0]}/grants?limit=1`,
    { headers: ownerHeaders() },
  );
  assert.equal(bulkGrantPageOne.response.status, 200);
  assert.equal(bulkGrantPageOne.body.items.length, 1);
  assert.equal(bulkGrantPageOne.body.has_more, true);
  const bulkGrantPageTwo = await jsonRequest(
    `/api/v1/admin/projects/${bulkProjectIds[0]}/grants?limit=1&cursor=${encodeURIComponent(bulkGrantPageOne.body.next_cursor)}`,
    { headers: ownerHeaders() },
  );
  assert.equal(bulkGrantPageTwo.response.status, 200);
  assert.equal(bulkGrantPageTwo.body.items.length, 1);
  assert.notEqual(bulkGrantPageTwo.body.items[0].id, bulkGrantPageOne.body.items[0].id);

  const replayedRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: redeemBody,
    headers: { "idempotency-key": "wp04-project-redeem" },
    method: "POST",
  });
  assert.equal(replayedRedeem.response.status, 200);
  assertWriteResult(replayedRedeem.body, true);
  const idempotencyBeforeConsumedRetry = await db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_records",
  ).first();
  const secondRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: redeemBody,
    headers: { "idempotency-key": "wp04-project-redeem-second" },
    method: "POST",
  });
  assert.equal(secondRedeem.response.status, 410);
  assert.equal(secondRedeem.body.code, "INVITATION_ALREADY_REDEEMED");
  const idempotencyAfterConsumedRetry = await db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_records",
  ).first();
  assert.equal(idempotencyAfterConsumedRetry.count, idempotencyBeforeConsumedRetry.count);

  const racedInvite = await createInvitation({
    grants: [{ project_id: firstProjectId, role: "reader" }],
    kind: "project_grant",
  }, "wp04-terminal-race-invite");
  const racedInviteCode = invitationCode(racedInvite.body);
  const racedLoserToken = token("terminalracea", "L");
  const racedWinnerToken = token("terminalraceb", "V");
  const terminalRaceBarrier = businessBatchBarrierDatabase(db, "SET redeemed_at = ?1");
  const racedLoser = redeemInvitationService(
    terminalRaceBarrier.db,
    new Request("https://kanban.example.test/api/v1/invitations/redeem", {
      headers: { "idempotency-key": "wp04-terminal-race-loser" },
      method: "POST",
    }),
    racedInviteCode,
    "new_principal",
    "Terminal Race Loser",
    racedLoserToken,
    Date.now(),
  );
  await terminalRaceBarrier.reached;
  let racedWinner;
  try {
    racedWinner = await jsonRequest("/api/v1/invitations/redeem", {
      body: {
        display_name: "Terminal Race Winner",
        invite_code: racedInviteCode,
        new_credential_token: racedWinnerToken,
        redeem_as: "new_principal",
      },
      headers: { "idempotency-key": "wp04-terminal-race-winner" },
      method: "POST",
    });
  } finally {
    terminalRaceBarrier.release();
  }
  assert.equal(racedWinner.response.status, 200, JSON.stringify(racedWinner.body));
  const racedLoserError = await racedLoser.then(() => null, (error) => error);
  assert.equal(racedLoserError?.status, 410);
  assert.equal(racedLoserError?.code, "INVITATION_ALREADY_REDEEMED");
  const racedLoserPending = await db.prepare(
    `SELECT COUNT(*) AS count FROM idempotency_records
     WHERE idempotency_key = 'wp04-terminal-race-loser' AND state = 'pending'`,
  ).first();
  assert.equal(racedLoserPending.count, 0);
  const racedLoserPrincipal = await db.prepare(
    "SELECT COUNT(*) AS count FROM principals WHERE display_name = 'Terminal Race Loser'",
  ).first();
  assert.equal(racedLoserPrincipal.count, 0);
  const consumedInvitePage = await jsonRequest(`/invite?code=${encodeURIComponent(racedInviteCode)}`);
  assert.equal(consumedInvitePage.response.status, 410, JSON.stringify(consumedInvitePage.body));
  assert.equal(consumedInvitePage.body.code, "INVITATION_ALREADY_REDEEMED");

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
  assert.equal(principalDetail.body.grants.length, 22);
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
  const duplicateProjectIds = await createInvitation({
    grants: [
      { project_id: firstProjectId, role: "reader" },
      { project_id: firstProjectId, role: "writer" },
    ],
    kind: "project_grant",
  }, "wp04-duplicate-project-ids");
  assert.equal(duplicateProjectIds.response.status, 400);
  const mixedInvitationFields = await createInvitation({
    grants: [{ project_id: firstProjectId, role: "reader" }],
    kind: "principal_recovery",
    principal_id: participantId,
    recovery_mode: "rotation",
  }, "wp04-mixed-invitation-fields");
  assert.equal(mixedInvitationFields.response.status, 400);

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

  const directCreatedGrant = await jsonRequest(`/api/v1/admin/projects/${firstProjectId}/grants`, {
    body: { principal_id: bulkNewPrincipalId, role: "reader" },
    headers: ownerHeaders({ "idempotency-key": "wp04-direct-created-grant" }),
    method: "POST",
  });
  assert.equal(directCreatedGrant.response.status, 200);
  const lifecycleEvents = await db.prepare(
    `SELECT type, payload_json FROM events
     WHERE grant_id = ?1 ORDER BY sequence`,
  ).bind(firstGrant.id).all();
  const lifecycle = lifecycleEvents.results.map((event) => ({
    payload: JSON.parse(event.payload_json),
    type: event.type,
  }));
  assert.deepEqual(
    lifecycle.map((event) => event.type),
    [
      "invitation.project-grant-redeemed",
      "project-grant.role-updated",
      "project-grant.revoked",
      "project-grant.regranted",
      "project-grant.revoked",
      "invitation.project-grant-redeemed",
    ],
  );
  assert.deepEqual(lifecycle.map((event) => event.payload.grant_version), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(lifecycle[2].payload.effective_capabilities, { read: false, write: false });
  assert.equal(lifecycle[3].payload.lifecycle, "regranted");
  const directCreatedEvent = await db.prepare(
    "SELECT type, payload_json FROM events WHERE grant_id = ?1 LIMIT 1",
  ).bind(directCreatedGrant.body.resource.id).first();
  assert.equal(directCreatedEvent.type, "project-grant.created");
  assert.equal(JSON.parse(directCreatedEvent.payload_json).grant_version, 1);

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
  const rotationPage = await request(`/invite?code=${encodeURIComponent(rotationCode)}`, {
    headers: { "accept-language": "en-US" },
  });
  assert.match(
    await rotationPage.text(),
    /revokes only the old Credential used to authenticate this redemption/,
  );
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
  const rotationSecurityEvent = await db.prepare(
    `SELECT actor_credential_id, payload_json FROM events
     WHERE type = 'principal.credential-recovered' ORDER BY sequence DESC LIMIT 1`,
  ).first();
  assert.equal(rotationSecurityEvent.actor_credential_id, participantCredentialId);
  assert.equal(
    JSON.parse(rotationSecurityEvent.payload_json).replacement_credential_id,
    rotatedParticipant.body.resource.credential.id,
  );
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
  const fullRecoveryPage = await request(`/invite?code=${encodeURIComponent(fullRecoveryCode)}`, {
    headers: { "accept-language": "en" },
  });
  assert.match(await fullRecoveryPage.text(), /revokes every previously active Credential/);
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
  const fullRecoverySecurityEvent = await db.prepare(
    `SELECT actor_credential_id, payload_json FROM events
     WHERE type = 'principal.credential-recovered' ORDER BY sequence DESC LIMIT 1`,
  ).first();
  assert.equal(fullRecoverySecurityEvent.actor_credential_id, null);
  assert.equal(
    JSON.parse(fullRecoverySecurityEvent.payload_json).replacement_credential_id,
    fullyRecovered.body.resource.credential.id,
  );
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

  const credentialPageOne = await jsonRequest(
    `/api/v1/admin/principals/${participantId}/credentials?limit=1`,
    { headers: ownerHeaders() },
  );
  assert.equal(credentialPageOne.response.status, 200);
  assert.equal(credentialPageOne.body.items.length, 1);
  assert.equal(credentialPageOne.body.has_more, true);
  const credentialPageTwo = await jsonRequest(
    `/api/v1/admin/principals/${participantId}/credentials?limit=1&cursor=${encodeURIComponent(credentialPageOne.body.next_cursor)}`,
    { headers: ownerHeaders() },
  );
  assert.equal(credentialPageTwo.response.status, 200);
  assert.equal(credentialPageTwo.body.items.length, 1);
  assert.notEqual(credentialPageTwo.body.items[0].id, credentialPageOne.body.items[0].id);

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
    `INSERT INTO project_usage
      (project_id, active_issue_count, active_comment_count, active_principal_count,
       updated_at, last_operation_id)
     VALUES (?1, 0, 0, 1, ?2, 'wp04-policy')`,
  ).bind(secondProjectId, Date.now()).run();
  await db.prepare(
    `INSERT INTO public_join_policies
      (project_id, public_id, public_summary, enabled_at, enabled_by_principal_id,
       version, created_at, updated_at, last_operation_id)
     VALUES (?1, 'wp04-public', 'Quota test', ?2, ?3, 1, ?2, ?2, 'wp04-policy')`,
  ).bind(secondProjectId, Date.now(), ids.ownerPrincipal).run();
  const activeDuplicateAtQuota = await jsonRequest(`/api/v1/admin/projects/${secondProjectId}/grants`, {
    body: { principal_id: participantId, role: "reader" },
    headers: ownerHeaders({ "idempotency-key": "wp04-active-duplicate-at-quota" }),
    method: "POST",
  });
  assert.equal(activeDuplicateAtQuota.response.status, 409);
  assert.equal(activeDuplicateAtQuota.body.code, "GRANT_ALREADY_EXISTS");
  const newGrantAtQuota = await jsonRequest(`/api/v1/admin/projects/${secondProjectId}/grants`, {
    body: { principal_id: bulkNewPrincipalId, role: "reader" },
    headers: ownerHeaders({ "idempotency-key": "wp04-new-grant-at-quota" }),
    method: "POST",
  });
  assert.equal(newGrantAtQuota.response.status, 409);
  assert.equal(newGrantAtQuota.body.code, "PROJECT_PRINCIPAL_LIMIT_REACHED");
  assert.equal(newGrantAtQuota.body.details.current_usage, 1);
  assert.equal(newGrantAtQuota.body.details.limit, 1);
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
  assert.equal(quotaRedeem.body.details.current_usage, 1);
  assert.equal(quotaRedeem.body.details.limit, 1);
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
  const pendingBeforeRevokedRedeem = await db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_records WHERE state = 'pending'",
  ).first();
  const revokedRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      display_name: "Terminal Invite Probe",
      invite_code: revocableCode,
      new_credential_token: token("terminal", "T"),
      redeem_as: "new_principal",
    },
    headers: { "idempotency-key": "wp04-redeem-revoked" },
    method: "POST",
  });
  assert.equal(revokedRedeem.response.status, 410, JSON.stringify(revokedRedeem.body));
  assert.equal(revokedRedeem.body.code, "INVITATION_REVOKED");
  const pendingAfterRevokedRedeem = await db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_records WHERE state = 'pending'",
  ).first();
  assert.equal(pendingAfterRevokedRedeem.count, pendingBeforeRevokedRedeem.count);

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
  const pendingBeforeExpiredRedeem = await db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_records WHERE state = 'pending'",
  ).first();
  const expiredRedeem = await jsonRequest("/api/v1/invitations/redeem", {
    body: {
      display_name: "Expired Invite Probe",
      invite_code: expiringCode,
      new_credential_token: token("terminal", "T"),
      redeem_as: "new_principal",
    },
    headers: { "idempotency-key": "wp04-redeem-expired" },
    method: "POST",
  });
  assert.equal(expiredRedeem.response.status, 410, JSON.stringify(expiredRedeem.body));
  assert.equal(expiredRedeem.body.code, "INVITATION_EXPIRED");
  const pendingAfterExpiredRedeem = await db.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_records WHERE state = 'pending'",
  ).first();
  assert.equal(pendingAfterExpiredRedeem.count, pendingBeforeExpiredRedeem.count);

  const ownerBeforeSecretOverlap = await jsonRequest("/api/v1/me", { headers: ownerHeaders() });
  const exposedOwnerName = await jsonRequest("/api/v1/me", {
    body: {
      display_name: exposedOwnerToken,
      expected_version: ownerBeforeSecretOverlap.body.version,
    },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(exposedOwnerName.response.status, 200, JSON.stringify(exposedOwnerName.body));
  const ownerRotationSideEffects = async () => db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM credentials) AS credentials,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM operation_commits) AS commits,
       (SELECT COUNT(*) FROM idempotency_records) AS idempotency_records,
       (SELECT COUNT(*) FROM idempotency_records
        WHERE operation_snapshot_json IS NOT NULL) AS snapshots`,
  ).first();
  const exposedRotationBefore = await ownerRotationSideEffects();
  const exposedOwnerRotation = await jsonRequest("/api/v1/admin/owner-credentials/rotate", {
    body: { new_credential_token: exposedOwnerToken },
    headers: ownerHeaders({ "idempotency-key": "wp04-owner-secret-overlap" }),
    method: "POST",
  });
  assert.equal(exposedOwnerRotation.response.status, 400, JSON.stringify(exposedOwnerRotation.body));
  assert.equal(exposedOwnerRotation.body.details.reason, "secret_value_reused");
  assert.deepEqual(await ownerRotationSideEffects(), exposedRotationBefore);
  const restoredOwnerName = await jsonRequest("/api/v1/me", {
    body: {
      display_name: "Deployment Owner",
      expected_version: exposedOwnerName.body.resource.version,
    },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(restoredOwnerName.response.status, 200, JSON.stringify(restoredOwnerName.body));

  const rotationBarrier = businessBatchBarrierDatabase(db, "FROM principals current_owner");
  const racedRotationRequest = new Request(
    "https://kanban.example.test/api/v1/admin/owner-credentials/rotate",
    {
      headers: ownerHeaders({ "idempotency-key": "wp04-owner-secret-overlap-race" }),
      method: "POST",
    },
  );
  const racedRotation = rotateOwnerCredentialService(
    rotationBarrier.db,
    racedRotationRequest,
    racedOwnerToken,
    Date.now(),
  );
  await rotationBarrier.reached;
  const racedOwnerName = await jsonRequest("/api/v1/me", {
    body: {
      display_name: racedOwnerToken,
      expected_version: restoredOwnerName.body.resource.version,
    },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  rotationBarrier.release();
  assert.equal(racedOwnerName.response.status, 200, JSON.stringify(racedOwnerName.body));
  await assert.rejects(
    racedRotation,
    (error) => error?.status === 400 && error?.details?.reason === "secret_value_reused",
  );
  const racedCredential = await db.prepare(
    "SELECT id FROM credentials WHERE token_digest = ?1 LIMIT 1",
  ).bind(await sha256Hex(racedOwnerToken)).first();
  assert.equal(racedCredential, null);
  await assert.rejects(
    () => authenticateBearer(db, `Bearer ${racedOwnerToken}`),
    (error) => error?.status === 401,
  );
  const restoredOwnerNameAfterRace = await jsonRequest("/api/v1/me", {
    body: {
      display_name: "Deployment Owner",
      expected_version: racedOwnerName.body.resource.version,
    },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(
    restoredOwnerNameAfterRace.response.status,
    200,
    JSON.stringify(restoredOwnerNameAfterRace.body),
  );

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
    bulkNewToken,
    bulkNewCode,
    bulkCurrentCode,
    rotatedOwnerToken,
  ]);

  const activeGrants = await db.prepare(
    "SELECT COUNT(*) AS count FROM project_grants WHERE principal_id = ?1 AND revoked_at IS NULL",
  ).bind(participantId).first();
  assert.equal(activeGrants.count, 22);
  const firstUsage = await db.prepare(
    "SELECT active_principal_count FROM project_usage WHERE project_id = ?1",
  ).bind(firstProjectId).first();
  assert.equal(firstUsage, null);
  assert.notEqual(participantCredentialId, recoveredCredentialId);
});
