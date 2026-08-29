import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const token = (prefix, character) => `cfk_v1_${prefix}_${character.repeat(43)}`;
const ownerToken = token("owner", "A");
const dualWriterToken = token("dual", "D");
const scopedWriterToken = token("scoped", "S");

const ids = {
  bootstrapOperation: "60000000-0000-4000-8000-000000000004",
  instance: "60000000-0000-4000-8000-000000000001",
  ownerCredential: "60000000-0000-4000-8000-000000000002",
  ownerPrincipal: "60000000-0000-4000-8000-000000000003",
  dualCredential: "60000000-0000-4000-8000-000000000005",
  dualPrincipal: "60000000-0000-4000-8000-000000000006",
  scopedCredential: "60000000-0000-4000-8000-000000000007",
  scopedPrincipal: "60000000-0000-4000-8000-000000000008",
};

const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});

let db;

function ownerHeaders(extra = {}) {
  return { authorization: `Bearer ${ownerToken}`, ...extra };
}

function dualHeaders(extra = {}) {
  return { authorization: `Bearer ${dualWriterToken}`, ...extra };
}

function scopedHeaders(extra = {}) {
  return { authorization: `Bearer ${scopedWriterToken}`, ...extra };
}

async function jsonRequest(path, { body, headers = {}, method = "GET" } = {}) {
  const response = await server.fetch(path, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    method,
  });
  return { body: await response.json(), response };
}

function assertWriteResult(value, replay = false) {
  assert.equal(value.idempotent_replay, replay);
  assert.equal(typeof value.event_cursor, "string");
  assert.equal(typeof value.resource, "object");
}

async function seedPrincipal({ credentialId, principalId, tokenValue, grants }) {
  const now = Date.now();
  await db.batch([
    db.prepare(
      "INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
    ).bind(principalId, principalId === ids.dualPrincipal ? "Dual Writer" : "Scoped Writer", now),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      credentialId,
      principalId,
      principalId === ids.dualPrincipal ? "dual" : "scoped",
      await sha256Hex(tokenValue),
      now,
      `wp06-${principalId}-credential`,
    ),
    ...grants.map(({ grantId, projectId }) => db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`,
    ).bind(grantId, principalId, projectId, now, `wp06-${grantId}-grant`)),
  ]);
}

async function createIssue(workspaceKey, projectKey, title, key, headers = ownerHeaders()) {
  const result = await jsonRequest(`/api/v1/workspaces/${workspaceKey}/projects/${projectKey}/issues`, {
    body: { status_key: "todo", title },
    headers: { ...headers, "idempotency-key": key },
    method: "POST",
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result;
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
    preferredApiOrigin: "https://kanban.example.test",
  });
});

after(async () => {
  await server.close();
});

test("WP-06 implements atomic collaboration resources, completion, and scoped Event feeds", async () => {
  const engineering = await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Engineering", key: "engineering" },
    headers: ownerHeaders({ "idempotency-key": "wp06-engineering" }),
    method: "POST",
  });
  const operations = await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Operations", key: "operations" },
    headers: ownerHeaders({ "idempotency-key": "wp06-operations" }),
    method: "POST",
  });
  assert.equal(engineering.response.status, 200);
  assert.equal(operations.response.status, 200);

  const projectA = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { display_name: "Application", key: "APP" },
    headers: ownerHeaders({ "idempotency-key": "wp06-project-app" }),
    method: "POST",
  });
  const projectB = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { display_name: "Backend", key: "BACK" },
    headers: ownerHeaders({ "idempotency-key": "wp06-project-back" }),
    method: "POST",
  });
  const projectC = await jsonRequest("/api/v1/workspaces/operations/projects", {
    body: { display_name: "Runbooks", key: "RUN" },
    headers: ownerHeaders({ "idempotency-key": "wp06-project-run" }),
    method: "POST",
  });
  assert.equal(projectA.response.status, 200);
  assert.equal(projectB.response.status, 200);
  assert.equal(projectC.response.status, 200);
  const projectAId = projectA.body.resource.id;
  const projectBId = projectB.body.resource.id;

  await seedPrincipal({
    credentialId: ids.dualCredential,
    grants: [
      { grantId: "60000000-0000-4000-8000-000000000011", projectId: projectAId },
      { grantId: "60000000-0000-4000-8000-000000000012", projectId: projectBId },
    ],
    principalId: ids.dualPrincipal,
    tokenValue: dualWriterToken,
  });
  await seedPrincipal({
    credentialId: ids.scopedCredential,
    grants: [{ grantId: "60000000-0000-4000-8000-000000000013", projectId: projectAId }],
    principalId: ids.scopedPrincipal,
    tokenValue: scopedWriterToken,
  });

  const issueA = await createIssue("engineering", "APP", "Application task", "wp06-issue-a", dualHeaders());
  const issueA2 = await createIssue("engineering", "APP", "Quota completion task", "wp06-issue-a2", dualHeaders());
  const issueB = await createIssue("engineering", "BACK", "Backend blocker", "wp06-issue-b", dualHeaders());
  const issueC = await createIssue("operations", "RUN", "Cross workspace task", "wp06-issue-c");
  let issueAVersion = issueA.body.resource.version;
  let issueA2Version = issueA2.body.resource.version;
  let issueBVersion = issueB.body.resource.version;

  const label = await jsonRequest("/api/v1/workspaces/engineering/projects/APP/labels", {
    body: { color: "#1a2b3c", name: "Security" },
    headers: dualHeaders({ "idempotency-key": "wp06-label-create" }),
    method: "POST",
  });
  assert.equal(label.response.status, 200, JSON.stringify(label.body));
  assertWriteResult(label.body);
  assert.equal(label.body.resource.color, "#1A2B3C");
  const labelId = label.body.resource.id;

  const updatedLabel = await jsonRequest(`/api/v1/labels/${labelId}`, {
    body: { color: null, expected_version: 1, name: "Security Review" },
    headers: dualHeaders(),
    method: "PATCH",
  });
  assert.equal(updatedLabel.response.status, 200, JSON.stringify(updatedLabel.body));
  assert.equal(updatedLabel.body.resource.version, 2);

  const addLabel = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/add-label`, {
    body: { expected_version: issueAVersion, label_id: labelId },
    headers: dualHeaders({ "idempotency-key": "wp06-label-add" }),
    method: "POST",
  });
  assert.equal(addLabel.response.status, 200, JSON.stringify(addLabel.body));
  issueAVersion = addLabel.body.resource.version;
  assert.deepEqual(addLabel.body.resource.labels.map((item) => item.id), [labelId]);

  const removeLabel = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/remove-label`, {
    body: { expected_version: issueAVersion, label_id: labelId },
    headers: dualHeaders({ "idempotency-key": "wp06-label-remove" }),
    method: "POST",
  });
  assert.equal(removeLabel.response.status, 200, JSON.stringify(removeLabel.body));
  issueAVersion = removeLabel.body.resource.version;
  assert.deepEqual(removeLabel.body.resource.labels, []);

  const deletedLabel = await jsonRequest(`/api/v1/labels/${labelId}?expected_version=2`, {
    headers: dualHeaders(),
    method: "DELETE",
  });
  assert.equal(deletedLabel.response.status, 200, JSON.stringify(deletedLabel.body));
  assert.equal(deletedLabel.body.resource.version, 3);
  assert.notEqual(deletedLabel.body.resource.deleted_at, null);
  const restoredLabel = await jsonRequest(`/api/v1/labels/${labelId}/commands/restore`, {
    body: { expected_version: 3 },
    headers: dualHeaders({ "idempotency-key": "wp06-label-restore" }),
    method: "POST",
  });
  assert.equal(restoredLabel.response.status, 200, JSON.stringify(restoredLabel.body));
  assert.equal(restoredLabel.body.resource.version, 4);

  const comment = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
    body: { body: "Initial implementation note" },
    headers: dualHeaders({ "idempotency-key": "wp06-comment-create" }),
    method: "POST",
  });
  assert.equal(comment.response.status, 200, JSON.stringify(comment.body));
  assertWriteResult(comment.body);
  const commentId = comment.body.resource.id;
  const replayedComment = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
    body: { body: "Initial implementation note" },
    headers: dualHeaders({ "idempotency-key": "wp06-comment-create" }),
    method: "POST",
  });
  assert.equal(replayedComment.response.status, 200);
  assertWriteResult(replayedComment.body, true);
  assert.equal(replayedComment.body.resource.id, commentId);

  const reply = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
    body: { body: "Correction and follow-up", reply_to_comment_id: commentId },
    headers: dualHeaders({ "idempotency-key": "wp06-comment-reply" }),
    method: "POST",
  });
  assert.equal(reply.response.status, 200, JSON.stringify(reply.body));
  const replyId = reply.body.resource.id;

  const firstCommentPage = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/comments?limit=1`,
    { headers: dualHeaders() },
  );
  assert.equal(firstCommentPage.response.status, 200);
  assert.equal(firstCommentPage.body.items.length, 1);
  assert.equal(firstCommentPage.body.has_more, true);
  const secondCommentPage = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/comments?limit=1&cursor=${encodeURIComponent(firstCommentPage.body.next_cursor)}`,
    { headers: dualHeaders() },
  );
  assert.equal(secondCommentPage.body.items[0].id, replyId);

  const deletedComment = await jsonRequest(`/api/v1/comments/${commentId}?expected_version=1`, {
    headers: dualHeaders(),
    method: "DELETE",
  });
  assert.equal(deletedComment.response.status, 200, JSON.stringify(deletedComment.body));
  assert.equal(deletedComment.body.resource.body, null);
  const restoredComment = await jsonRequest(`/api/v1/comments/${commentId}/commands/restore`, {
    body: { expected_version: 2 },
    headers: dualHeaders({ "idempotency-key": "wp06-comment-restore" }),
    method: "POST",
  });
  assert.equal(restoredComment.response.status, 200, JSON.stringify(restoredComment.body));
  assert.equal(restoredComment.body.resource.body, "Initial implementation note");
  assert.equal(restoredComment.body.resource.version, 3);

  const completionBody = {
    artifacts: [{ kind: "commit", value: "abc123" }],
    expected_version: issueAVersion,
    follow_ups: ["Observe rollout"],
    summary: "Application task completed",
    verification: ["Integration tests passed"],
  };
  const completed = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/complete`, {
    body: completionBody,
    headers: dualHeaders({ "idempotency-key": "wp06-complete-first" }),
    method: "POST",
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assertWriteResult(completed.body);
  assert.equal(completed.body.resource.status.key, "done");
  issueAVersion = completed.body.resource.version;
  const completionCommentId = completed.body.resource.completion_comment_id;
  const replayedCompletion = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/complete`, {
    body: completionBody,
    headers: dualHeaders({ "idempotency-key": "wp06-complete-first" }),
    method: "POST",
  });
  assert.equal(replayedCompletion.response.status, 200);
  assertWriteResult(replayedCompletion.body, true);
  assert.equal(replayedCompletion.body.resource.completion_comment_id, completionCommentId);

  const completionDelete = await jsonRequest(`/api/v1/comments/${completionCommentId}?expected_version=1`, {
    headers: dualHeaders(),
    method: "DELETE",
  });
  assert.equal(completionDelete.response.status, 403);
  assert.equal(completionDelete.body.code, "FORBIDDEN");

  const reopened = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}`, {
    body: { expected_version: issueAVersion, status_key: "todo" },
    headers: dualHeaders(),
    method: "PATCH",
  });
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.resource.status.key, "todo");
  issueAVersion = reopened.body.resource.version;

  const completedAgain = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/complete`, {
    body: { expected_version: issueAVersion, summary: "Application task completed again" },
    headers: dualHeaders({ "idempotency-key": "wp06-complete-second" }),
    method: "POST",
  });
  assert.equal(completedAgain.response.status, 200, JSON.stringify(completedAgain.body));
  issueAVersion = completedAgain.body.resource.version;
  const completionCount = await db.prepare(
    "SELECT COUNT(*) AS count FROM comments WHERE issue_id = ?1 AND kind = 'completion'",
  ).bind(issueA.body.resource.id).first();
  assert.equal(completionCount.count, 2);

  const crossWorkspace = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/relations`, {
    body: {
      kind: "related",
      source_expected_version: issueAVersion,
      target_expected_version: issueC.body.resource.version,
      target_identifier: issueC.body.resource.identifier,
    },
    headers: ownerHeaders({ "idempotency-key": "wp06-relation-cross-workspace" }),
    method: "POST",
  });
  assert.equal(crossWorkspace.response.status, 400);
  assert.equal(crossWorkspace.body.code, "VALIDATION_ERROR");

  const relation = await jsonRequest(`/api/v1/issues/${issueB.body.resource.identifier}/relations`, {
    body: {
      kind: "blocks",
      source_expected_version: issueBVersion,
      target_expected_version: issueAVersion,
      target_identifier: issueA.body.resource.identifier,
    },
    headers: dualHeaders({ "idempotency-key": "wp06-relation-create" }),
    method: "POST",
  });
  assert.equal(relation.response.status, 200, JSON.stringify(relation.body));
  assertWriteResult(relation.body);
  const relationId = relation.body.resource.id;
  issueBVersion = relation.body.resource.source.version;
  issueAVersion = relation.body.resource.target.version;

  const hiddenRelationList = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/relations`,
    { headers: scopedHeaders() },
  );
  assert.equal(hiddenRelationList.response.status, 200);
  assert.deepEqual(hiddenRelationList.body.items, []);
  const hiddenRelationDetail = await jsonRequest(`/api/v1/relations/${relationId}`, {
    headers: scopedHeaders(),
  });
  assert.equal(hiddenRelationDetail.response.status, 404);

  const visibleRelationList = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/relations`,
    { headers: dualHeaders() },
  );
  assert.equal(visibleRelationList.body.items.length, 1);
  assert.equal(visibleRelationList.body.items[0].id, relationId);

  const scopedEvents = await jsonRequest("/api/v1/events?limit=100", { headers: scopedHeaders() });
  assert.equal(scopedEvents.response.status, 200, JSON.stringify(scopedEvents.body));
  assert.equal(scopedEvents.body.items.some((event) => event.subject.type === "relation"), false);
  const dualEvents = await jsonRequest("/api/v1/events?limit=100", { headers: dualHeaders() });
  assert.equal(dualEvents.response.status, 200, JSON.stringify(dualEvents.body));
  assert.equal(
    dualEvents.body.items.filter((event) => event.subject.id === relationId).length,
    2,
  );

  const deletedRelation = await jsonRequest(
    `/api/v1/relations/${relationId}?expected_version=1&source_expected_version=${issueBVersion}&target_expected_version=${issueAVersion}`,
    { headers: dualHeaders(), method: "DELETE" },
  );
  assert.equal(deletedRelation.response.status, 200, JSON.stringify(deletedRelation.body));
  assert.equal(deletedRelation.body.resource.version, 2);
  issueBVersion = deletedRelation.body.resource.source.version;
  issueAVersion = deletedRelation.body.resource.target.version;

  const restoredRelation = await jsonRequest(`/api/v1/relations/${relationId}/commands/restore`, {
    body: {
      expected_version: 2,
      source_expected_version: issueBVersion,
      target_expected_version: issueAVersion,
    },
    headers: dualHeaders({ "idempotency-key": "wp06-relation-restore" }),
    method: "POST",
  });
  assert.equal(restoredRelation.response.status, 200, JSON.stringify(restoredRelation.body));
  assert.equal(restoredRelation.body.resource.version, 3);

  const afterRelationCursor = restoredRelation.body.event_cursor;
  const laterComment = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
    body: { body: "Event cursor continuation" },
    headers: dualHeaders({ "idempotency-key": "wp06-comment-after-relation" }),
    method: "POST",
  });
  assert.equal(laterComment.response.status, 200, JSON.stringify(laterComment.body));
  const continuedEvents = await jsonRequest(
    `/api/v1/events?after=${encodeURIComponent(afterRelationCursor)}&limit=100`,
    { headers: dualHeaders() },
  );
  assert.equal(continuedEvents.response.status, 200, JSON.stringify(continuedEvents.body));
  assert.deepEqual(continuedEvents.body.items.map((event) => event.subject.id), [laterComment.body.resource.id]);

  const concurrentBody = { body: "Concurrent same-key finalization" };
  const [concurrentLeft, concurrentRight] = await Promise.all([
    jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
      body: concurrentBody,
      headers: dualHeaders({ "idempotency-key": "wp06-concurrent-finalizer" }),
      method: "POST",
    }),
    jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
      body: concurrentBody,
      headers: dualHeaders({ "idempotency-key": "wp06-concurrent-finalizer" }),
      method: "POST",
    }),
  ]);
  assert.equal(concurrentLeft.response.status, 200, JSON.stringify(concurrentLeft.body));
  assert.equal(concurrentRight.response.status, 200, JSON.stringify(concurrentRight.body));
  assert.equal(concurrentLeft.body.resource.id, concurrentRight.body.resource.id);
  assert.deepEqual(
    new Set([concurrentLeft.body.idempotent_replay, concurrentRight.body.idempotent_replay]),
    new Set([false, true]),
  );

  const crossedCursor = await jsonRequest(
    `/api/v1/events?after=${encodeURIComponent(afterRelationCursor)}`,
    { headers: scopedHeaders() },
  );
  assert.equal(crossedCursor.response.status, 409);
  assert.equal(crossedCursor.body.code, "CURSOR_SCOPE_MISMATCH");

  const audit = await jsonRequest("/api/v1/admin/audit-events?limit=100", { headers: ownerHeaders() });
  assert.equal(audit.response.status, 200, JSON.stringify(audit.body));
  assert.equal(audit.body.items.some((event) => event.stream === "security"), true);
  assert.equal(audit.body.items.some((event) => event.subject.id === relationId), true);

  const usage = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM issues WHERE project_id = ?1 AND deleted_at IS NULL) AS issue_count,
       (SELECT COUNT(*) FROM comments comment
        JOIN issues issue ON issue.id = comment.issue_id
        WHERE issue.project_id = ?1 AND issue.deleted_at IS NULL AND comment.deleted_at IS NULL) AS comment_count,
       (SELECT COUNT(*) FROM project_grants
        WHERE project_id = ?1 AND revoked_at IS NULL AND principal_id != ?2) AS principal_count`,
  ).bind(projectAId, ids.ownerPrincipal).first();
  const now = Date.now();
  await db.batch([
    db.prepare(
      `UPDATE projects SET issue_limit = 100, comment_limit = ?1, principal_limit = 100 WHERE id = ?2`,
    ).bind(usage.comment_count, projectAId),
    db.prepare(
      `INSERT INTO public_join_policies
        (project_id, public_id, public_summary, enabled_at, enabled_by_principal_id,
         version, created_at, updated_at)
       VALUES (?1, ?2, 'Public test project', ?3, ?4, 1, ?3, ?3)`,
    ).bind(projectAId, "wp06-public-app", now, ids.ownerPrincipal),
    db.prepare(
      `INSERT INTO project_usage
        (project_id, active_issue_count, active_comment_count, active_principal_count, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(projectAId, usage.issue_count, usage.comment_count, usage.principal_count, now),
  ]);

  const overLimitComment = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
    body: { body: "Must not fit" },
    headers: dualHeaders({ "idempotency-key": "wp06-comment-over-limit" }),
    method: "POST",
  });
  assert.equal(overLimitComment.response.status, 409, JSON.stringify(overLimitComment.body));
  assert.equal(overLimitComment.body.code, "PROJECT_COMMENT_LIMIT_REACHED");

  const overLimitCompletion = await jsonRequest(`/api/v1/issues/${issueA2.body.resource.identifier}/commands/complete`, {
    body: { expected_version: issueA2Version, summary: "Must roll back" },
    headers: dualHeaders({ "idempotency-key": "wp06-complete-over-limit" }),
    method: "POST",
  });
  assert.equal(overLimitCompletion.response.status, 409, JSON.stringify(overLimitCompletion.body));
  assert.equal(overLimitCompletion.body.code, "PROJECT_COMMENT_LIMIT_REACHED");
  const unchangedIssue = await jsonRequest(`/api/v1/issues/${issueA2.body.resource.identifier}`, {
    headers: dualHeaders(),
  });
  assert.equal(unchangedIssue.body.status.key, "todo");
  assert.equal(unchangedIssue.body.version, issueA2Version);

  const released = await jsonRequest(`/api/v1/comments/${replyId}?expected_version=1`, {
    headers: dualHeaders(),
    method: "DELETE",
  });
  assert.equal(released.response.status, 200, JSON.stringify(released.body));
  const completionAfterRelease = await jsonRequest(
    `/api/v1/issues/${issueA2.body.resource.identifier}/commands/complete`,
    {
      body: { expected_version: issueA2Version, summary: "Fits after quota release" },
      headers: dualHeaders({ "idempotency-key": "wp06-complete-after-release" }),
      method: "POST",
    },
  );
  assert.equal(completionAfterRelease.response.status, 200, JSON.stringify(completionAfterRelease.body));
  assert.equal(completionAfterRelease.body.resource.status.key, "done");

  const finalUsage = await db.prepare(
    `SELECT active_comment_count FROM project_usage WHERE project_id = ?1`,
  ).bind(projectAId).first();
  const authoritativeComments = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM comments comment
     JOIN issues issue ON issue.id = comment.issue_id
     WHERE issue.project_id = ?1 AND issue.deleted_at IS NULL AND comment.deleted_at IS NULL`,
  ).bind(projectAId).first();
  assert.equal(finalUsage.active_comment_count, authoritativeComments.count);
});
