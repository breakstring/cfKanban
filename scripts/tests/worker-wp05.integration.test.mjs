import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const token = (prefix, character) => `cfk_v1_${prefix}_${character.repeat(43)}`;
const ownerToken = token("owner", "A");
const writerToken = token("writer", "W");
const readerToken = token("reader", "R");
const ids = {
  bootstrapOperation: "50000000-0000-4000-8000-000000000004",
  instance: "50000000-0000-4000-8000-000000000001",
  ownerCredential: "50000000-0000-4000-8000-000000000002",
  ownerPrincipal: "50000000-0000-4000-8000-000000000003",
  readerCredential: "50000000-0000-4000-8000-000000000005",
  readerGrant: "50000000-0000-4000-8000-000000000006",
  readerPrincipal: "50000000-0000-4000-8000-000000000007",
  writerCredential: "50000000-0000-4000-8000-000000000008",
  writerGrant: "50000000-0000-4000-8000-000000000009",
  writerPrincipal: "50000000-0000-4000-8000-000000000010",
  label: "50000000-0000-4000-8000-000000000011",
};

const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});

let db;

function ownerHeaders(extra = {}) {
  return { authorization: `Bearer ${ownerToken}`, ...extra };
}

function writerHeaders(extra = {}) {
  return { authorization: `Bearer ${writerToken}`, ...extra };
}

function readerHeaders(extra = {}) {
  return { authorization: `Bearer ${readerToken}`, ...extra };
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

async function seedParticipant({ credentialId, grantId, principalId, role, tokenValue, projectId }) {
  const now = Date.now();
  await db.batch([
    db.prepare(
      "INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
    ).bind(principalId, role === "writer" ? "Writer" : "Reader", now),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      credentialId,
      principalId,
      role,
      await sha256Hex(tokenValue),
      now,
      `wp05-seed-${role}-credential`,
    ),
    db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
    ).bind(grantId, principalId, projectId, role, now, `wp05-seed-${role}-grant`),
  ]);
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

test("WP-05 implements the authorization-filtered Issue ledger and atomic commands", async () => {
  await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Engineering", key: "engineering" },
    headers: ownerHeaders({ "idempotency-key": "wp05-workspace" }),
    method: "POST",
  });
  const core = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { context: "Project contract context", display_name: "Core", key: "CORE" },
    headers: ownerHeaders({ "idempotency-key": "wp05-core" }),
    method: "POST",
  });
  const privateProject = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { display_name: "Private", key: "PRIVATE" },
    headers: ownerHeaders({ "idempotency-key": "wp05-private" }),
    method: "POST",
  });
  assert.equal(core.response.status, 200);
  assert.equal(privateProject.response.status, 200);
  const coreProjectId = core.body.resource.id;
  await Promise.all([
    seedParticipant({
      credentialId: ids.writerCredential,
      grantId: ids.writerGrant,
      principalId: ids.writerPrincipal,
      projectId: coreProjectId,
      role: "writer",
      tokenValue: writerToken,
    }),
    seedParticipant({
      credentialId: ids.readerCredential,
      grantId: ids.readerGrant,
      principalId: ids.readerPrincipal,
      projectId: coreProjectId,
      role: "reader",
      tokenValue: readerToken,
    }),
  ]);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO labels
      (id, project_id, name, color, created_at, updated_at,
       created_by_principal_id, updated_by_principal_id, created_operation_id)
     VALUES (?1, ?2, 'security', NULL, ?3, ?3, ?4, ?4, 'wp05-seed-label')`,
  ).bind(ids.label, coreProjectId, now, ids.ownerPrincipal).run();

  const createBody = {
    body: "Implement the secure Issue ledger",
    label_ids: [ids.label],
    priority_key: "medium",
    status_key: "backlog",
    title: "Ledger Élan",
  };
  const first = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: createBody,
    headers: ownerHeaders({ "idempotency-key": "wp05-first-issue" }),
    method: "POST",
  });
  assert.equal(first.response.status, 200);
  assertWriteResult(first.body);
  assert.equal(first.body.resource.identifier, "CFK-1");
  assert.deepEqual(first.body.resource.labels.map((label) => label.id), [ids.label]);
  const replay = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: createBody,
    headers: ownerHeaders({ "idempotency-key": "wp05-first-issue" }),
    method: "POST",
  });
  assert.equal(replay.body.resource.identifier, "CFK-1");
  assertWriteResult(replay.body, true);

  const second = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: { priority_key: "high", status_key: "todo", title: "Second candidate" },
    headers: writerHeaders({ "idempotency-key": "wp05-second-issue" }),
    method: "POST",
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.resource.identifier, "CFK-2");
  const privateIssue = await jsonRequest("/api/v1/workspaces/engineering/projects/PRIVATE/issues", {
    body: { title: "Hidden issue" },
    headers: ownerHeaders({ "idempotency-key": "wp05-private-issue" }),
    method: "POST",
  });
  assert.equal(privateIssue.body.resource.identifier, "CFK-3");

  const writerList = await jsonRequest("/api/v1/issues", { headers: writerHeaders() });
  assert.deepEqual(writerList.body.items.map((issue) => issue.identifier), ["CFK-2", "CFK-1"]);
  assert.equal(writerList.body.resolved_scope.expanded_to_all_authorized_projects, true);
  assert.equal(writerList.body.resolved_scope.projects.length, 1);
  const firstPage = await jsonRequest("/api/v1/issues?limit=1", { headers: writerHeaders() });
  assert.equal(firstPage.body.items.length, 1);
  assert.equal(firstPage.body.has_more, true);
  const secondPage = await jsonRequest(
    `/api/v1/issues?limit=1&cursor=${encodeURIComponent(firstPage.body.next_cursor)}`,
    { headers: writerHeaders() },
  );
  assert.deepEqual(secondPage.body.items.map((issue) => issue.identifier), ["CFK-1"]);
  const ownerPage = await jsonRequest("/api/v1/issues?limit=1", { headers: ownerHeaders() });
  const mismatchedCursor = await jsonRequest(
    `/api/v1/issues?limit=1&cursor=${encodeURIComponent(ownerPage.body.next_cursor)}`,
    { headers: writerHeaders() },
  );
  assert.equal(mismatchedCursor.response.status, 409);
  assert.equal(mismatchedCursor.body.code, "CURSOR_SCOPE_MISMATCH");
  const hidden = await jsonRequest("/api/v1/issues/CFK-3", { headers: writerHeaders() });
  assert.equal(hidden.response.status, 404);
  const readerCreate = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: { title: "Reader cannot write" },
    headers: readerHeaders({ "idempotency-key": "wp05-reader-create" }),
    method: "POST",
  });
  assert.equal(readerCreate.response.status, 403);

  const scoped = await jsonRequest(
    "/api/v1/issues?project=engineering%2FCORE&project=engineering%2FMISSING&q=%C3%A9lan",
    { headers: writerHeaders() },
  );
  assert.deepEqual(scoped.body.items.map((issue) => issue.identifier), ["CFK-1"]);
  assert.deepEqual(scoped.body.resolved_scope.unresolved_project_targets, ["engineering/MISSING"]);
  const literalPattern = await jsonRequest("/api/v1/issues?q=%25", { headers: ownerHeaders() });
  assert.equal(literalPattern.body.items.length, 0);
  assert.equal(literalPattern.body.resolved_scope.broad_search, true);
  const exactIdentifier = await jsonRequest("/api/v1/issues?q=CFK-2", { headers: writerHeaders() });
  assert.deepEqual(exactIdentifier.body.items.map((issue) => issue.identifier), ["CFK-2"]);

  const directDone = await jsonRequest("/api/v1/issues/CFK-1", {
    body: { expected_version: first.body.resource.version, status_key: "done" },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(directDone.response.status, 409);
  assert.equal(directDone.body.code, "INVALID_TRANSITION");
  const invalidAssignee = await jsonRequest("/api/v1/issues/CFK-1", {
    body: { assignee_principal_id: ids.readerPrincipal, expected_version: first.body.resource.version },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(invalidAssignee.response.status, 409);
  assert.equal(invalidAssignee.body.code, "ASSIGNEE_NOT_ELIGIBLE");
  const crossProjectAssignee = await jsonRequest("/api/v1/issues/CFK-3", {
    body: { assignee_principal_id: ids.writerPrincipal, expected_version: privateIssue.body.resource.version },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(crossProjectAssignee.response.status, 409);
  assert.equal(crossProjectAssignee.body.code, "ASSIGNEE_NOT_ELIGIBLE");

  const updated = await jsonRequest("/api/v1/issues/CFK-1", {
    body: { expected_version: first.body.resource.version, priority_key: "urgent", status_key: "todo" },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.resource.status.key, "todo");
  const assigned = await jsonRequest("/api/v1/issues/CFK-1/commands/assign-to-me", {
    body: { expected_version: updated.body.resource.version },
    headers: writerHeaders({ "idempotency-key": "wp05-assign-self" }),
    method: "POST",
  });
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.body.resource.assignee.principal_id, ids.writerPrincipal);
  const staleAssign = await jsonRequest("/api/v1/issues/CFK-1/commands/assign-to-me", {
    body: { expected_version: updated.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-stale-assign" }),
    method: "POST",
  });
  assert.equal(staleAssign.response.status, 409);
  assert.equal(staleAssign.body.code, "VERSION_CONFLICT");

  const blocked = await jsonRequest("/api/v1/issues/CFK-2/commands/report-blocked", {
    body: { expected_version: second.body.resource.version, reason: "Waiting for upstream" },
    headers: writerHeaders({ "idempotency-key": "wp05-blocked" }),
    method: "POST",
  });
  assert.equal(blocked.body.resource.is_blocked, true);
  const blockedReplay = await jsonRequest("/api/v1/issues/CFK-2/commands/report-blocked", {
    body: { expected_version: second.body.resource.version, reason: "Waiting for upstream" },
    headers: writerHeaders({ "idempotency-key": "wp05-blocked" }),
    method: "POST",
  });
  assertWriteResult(blockedReplay.body, true);
  const missingAssignmentFilter = await jsonRequest("/api/v1/issues/candidates", {
    headers: writerHeaders(),
  });
  assert.equal(missingAssignmentFilter.response.status, 400);
  const candidates = await jsonRequest("/api/v1/issues/candidates?assignment=mine", {
    headers: writerHeaders(),
  });
  assert.deepEqual(candidates.body.items.map((issue) => issue.identifier), ["CFK-1"]);
  assert.deepEqual(candidates.body.resolved_scope.candidate_policy, {
    assignment: "mine",
    blocked: "exclude",
    status_category: "unstarted",
  });
  const blockedExcluded = await jsonRequest("/api/v1/issues/candidates?assignment=unassigned", {
    headers: writerHeaders(),
  });
  assert.deepEqual(blockedExcluded.body.items, []);
  const blockedIncluded = await jsonRequest(
    "/api/v1/issues/candidates?assignment=unassigned&blocked=include",
    { headers: writerHeaders() },
  );
  assert.deepEqual(blockedIncluded.body.items.map((issue) => issue.identifier), ["CFK-2"]);
  const cleared = await jsonRequest("/api/v1/issues/CFK-2/commands/clear-blocked", {
    body: { expected_version: blocked.body.resource.version },
    headers: writerHeaders({ "idempotency-key": "wp05-clear-blocked" }),
    method: "POST",
  });
  assert.equal(cleared.body.resource.is_blocked, false);
  const newlyAvailableCandidate = await jsonRequest(
    "/api/v1/issues/candidates?assignment=unassigned",
    { headers: writerHeaders() },
  );
  assert.deepEqual(newlyAvailableCandidate.body.items.map((issue) => issue.identifier), ["CFK-2"]);

  const beforeLargeBody = await jsonRequest("/api/v1/issues/CFK-1", { headers: writerHeaders() });
  const largeBodyUpdate = await jsonRequest("/api/v1/issues/CFK-1", {
    body: { body: "x".repeat(64 * 1024), expected_version: beforeLargeBody.body.version },
    headers: writerHeaders(),
    method: "PATCH",
  });
  assert.equal(largeBodyUpdate.response.status, 200);
  const context = await jsonRequest("/api/v1/issues/CFK-1/context", { headers: writerHeaders() });
  assert.equal(context.response.status, 200);
  assert.equal(context.body.issue.identifier, "CFK-1");
  assert.ok(Buffer.byteLength(JSON.stringify(context.body)) <= 64 * 1024);
  assert.equal(context.body.sections.body.truncated, true);
  assert.equal(context.body.sections.project_context.content, "Project contract context");
  const concurrentCreates = await Promise.all([
    jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
      body: { title: "Concurrent A" },
      headers: ownerHeaders({ "idempotency-key": "wp05-concurrent-a" }),
      method: "POST",
    }),
    jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
      body: { title: "Concurrent B" },
      headers: writerHeaders({ "idempotency-key": "wp05-concurrent-b" }),
      method: "POST",
    }),
  ]);
  assert.deepEqual(concurrentCreates.map((result) => result.response.status), [200, 200]);
  const concurrentNumbers = concurrentCreates.map((result) => result.body.resource.number);
  assert.equal(new Set(concurrentNumbers).size, 2);
  assert.ok(concurrentNumbers.every((number) => number > 3));
  const coreUsage = await db.prepare(
    "SELECT active_issue_count FROM project_usage WHERE project_id = ?1",
  ).bind(coreProjectId).first();
  assert.equal(coreUsage, null, "disabled policies do not maintain usage rows");

  const quotaProject = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { display_name: "Quota", key: "QUOTA" },
    headers: ownerHeaders({ "idempotency-key": "wp05-quota-project" }),
    method: "POST",
  });
  const quotaProjectId = quotaProject.body.resource.id;
  await db.prepare(
    "UPDATE projects SET issue_limit = 1, comment_limit = 10, principal_limit = 10 WHERE id = ?1",
  ).bind(quotaProjectId).run();
  await db.prepare(
    `INSERT INTO public_join_policies
      (project_id, public_id, public_summary, enabled_at, enabled_by_principal_id,
       version, created_at, updated_at)
     VALUES (?1, 'quota-public', 'Quota test', ?2, ?3, 1, ?2, ?2)`,
  ).bind(quotaProjectId, Date.now(), ids.ownerPrincipal).run();
  await db.prepare(
    `INSERT INTO project_usage
      (project_id, active_issue_count, active_comment_count, active_principal_count,
       updated_at, last_operation_id)
     VALUES (?1, 0, 0, 0, ?2, 'wp05-policy')`,
  ).bind(quotaProjectId, Date.now()).run();
  const quotaOne = await jsonRequest("/api/v1/workspaces/engineering/projects/QUOTA/issues", {
    body: { title: "Quota one" },
    headers: ownerHeaders({ "idempotency-key": "wp05-quota-one" }),
    method: "POST",
  });
  assert.equal(quotaOne.response.status, 200);
  const quotaTwoRejected = await jsonRequest("/api/v1/workspaces/engineering/projects/QUOTA/issues", {
    body: { title: "Quota two" },
    headers: ownerHeaders({ "idempotency-key": "wp05-quota-two" }),
    method: "POST",
  });
  assert.equal(quotaTwoRejected.response.status, 409);
  assert.equal(quotaTwoRejected.body.code, "PROJECT_ISSUE_LIMIT_REACHED");
  assert.deepEqual(
    { current_usage: quotaTwoRejected.body.details.current_usage, limit: quotaTwoRejected.body.details.limit },
    { current_usage: 1, limit: 1 },
  );
  const deleted = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?expected_version=${quotaOne.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(deleted.body.resource.deleted_at !== null, true);
  const repeatedDelete = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?expected_version=${deleted.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(repeatedDelete.response.status, 409);
  assert.equal(repeatedDelete.body.code, "RESOURCE_DELETED");
  const hiddenTombstone = await jsonRequest(`/api/v1/issues/${quotaOne.body.resource.identifier}`, {
    headers: ownerHeaders(),
  });
  assert.equal(hiddenTombstone.response.status, 404);
  const tombstoneDetail = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?deleted=only`,
    { headers: ownerHeaders() },
  );
  assert.equal(tombstoneDetail.response.status, 200);
  assert.equal(tombstoneDetail.body.restorable, true);
  assert.deepEqual(tombstoneDetail.body.allowed_actions, ["restore"]);
  assert.equal(tombstoneDetail.body.deleted_by_principal_id, ids.ownerPrincipal);
  assert.deepEqual(tombstoneDetail.body.parent_status, { project: "active", workspace: "active" });
  const readerDeletedView = await jsonRequest("/api/v1/issues?deleted=only", {
    headers: readerHeaders(),
  });
  assert.deepEqual(readerDeletedView.body.items, []);
  const quotaTwo = await jsonRequest("/api/v1/workspaces/engineering/projects/QUOTA/issues", {
    body: { title: "Quota two" },
    headers: ownerHeaders({ "idempotency-key": "wp05-quota-two" }),
    method: "POST",
  });
  assert.equal(quotaTwo.response.status, 200);
  const restoreOverLimit = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}/commands/restore`,
    {
      body: { expected_version: deleted.body.resource.version },
      headers: ownerHeaders({ "idempotency-key": "wp05-quota-restore" }),
      method: "POST",
    },
  );
  assert.equal(restoreOverLimit.response.status, 409);
  assert.equal(restoreOverLimit.body.code, "PROJECT_ISSUE_LIMIT_REACHED");
  await jsonRequest(
    `/api/v1/issues/${quotaTwo.body.resource.identifier}?expected_version=${quotaTwo.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  const deletedPageOne = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/QUOTA/issues?deleted=only&limit=1",
    { headers: ownerHeaders() },
  );
  assert.equal(deletedPageOne.body.items.length, 1);
  assert.equal(deletedPageOne.body.has_more, true);
  assert.equal(deletedPageOne.body.items[0].identifier, quotaTwo.body.resource.identifier);
  const deletedPageTwo = await jsonRequest(
    `/api/v1/workspaces/engineering/projects/QUOTA/issues?deleted=only&limit=1&cursor=${encodeURIComponent(deletedPageOne.body.next_cursor)}`,
    { headers: ownerHeaders() },
  );
  assert.deepEqual(
    deletedPageTwo.body.items.map((issue) => issue.identifier),
    [quotaOne.body.resource.identifier],
  );
  const restored = await jsonRequest(`/api/v1/issues/${quotaOne.body.resource.identifier}/commands/restore`, {
    body: { expected_version: deleted.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-quota-restore" }),
    method: "POST",
  });
  assert.equal(restored.response.status, 200);
  const repeatedRestore = await jsonRequest(`/api/v1/issues/${quotaOne.body.resource.identifier}/commands/restore`, {
    body: { expected_version: restored.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-repeated-restore" }),
    method: "POST",
  });
  assert.equal(repeatedRestore.response.status, 409);
  assert.equal(repeatedRestore.body.code, "RESOURCE_NOT_DELETED");

  const sessionToken = "S".repeat(43);
  const csrfToken = "C".repeat(43);
  await db.prepare(
    `INSERT INTO web_sessions
      (id, token_digest, principal_id, source_kind, source_id, target_kind,
       target_json, expires_at, created_at)
     VALUES (?1, ?2, ?3, 'credential', ?4, 'issue', ?5, ?6, ?7)`,
  ).bind(
    "50000000-0000-4000-8000-000000000012",
    await sha256Hex(sessionToken),
    ids.ownerPrincipal,
    ids.ownerCredential,
    JSON.stringify({ identifier: quotaOne.body.resource.identifier }),
    Date.now() + 60_000,
    Date.now(),
  ).run();
  const cookieHeaders = {
    cookie: `cfkanban_session=${sessionToken}; cfkanban_csrf=${csrfToken}`,
  };
  const issueTargetList = await jsonRequest("/api/v1/issues", { headers: cookieHeaders });
  assert.deepEqual(issueTargetList.body.items.map((issue) => issue.identifier), [quotaOne.body.resource.identifier]);
  const issueTargetLeak = await jsonRequest("/api/v1/issues/CFK-1", { headers: cookieHeaders });
  assert.equal(issueTargetLeak.response.status, 404);
  const discovery = await jsonRequest("/.well-known/cfkanban-instance.json");
  const issueTargetWrite = await jsonRequest(`/api/v1/issues/${quotaOne.body.resource.identifier}`, {
    body: { expected_version: restored.body.resource.version, title: "Quota one via scoped session" },
    headers: {
      ...cookieHeaders,
      origin: discovery.body.observed_origin,
      "x-csrf-token": csrfToken,
    },
    method: "PATCH",
  });
  assert.equal(issueTargetWrite.response.status, 200);
  const issueTargetDelete = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?expected_version=${issueTargetWrite.body.resource.version}`,
    {
      headers: {
        ...cookieHeaders,
        origin: discovery.body.observed_origin,
        "x-csrf-token": csrfToken,
      },
      method: "DELETE",
    },
  );
  assert.equal(issueTargetDelete.response.status, 200);
  const issueTargetTombstone = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?deleted=only`,
    { headers: cookieHeaders },
  );
  assert.equal(issueTargetTombstone.response.status, 200);
  const issueTargetRestore = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}/commands/restore`,
    {
      body: { expected_version: issueTargetDelete.body.resource.version },
      headers: {
        ...cookieHeaders,
        "idempotency-key": "wp05-issue-target-restore",
        origin: discovery.body.observed_origin,
        "x-csrf-token": csrfToken,
      },
      method: "POST",
    },
  );
  assert.equal(issueTargetRestore.response.status, 200);

  await db.prepare(
    "UPDATE project_grants SET role = 'reader', version = version + 1 WHERE id = ?1",
  ).bind(ids.writerGrant).run();
  const reassignmentCandidates = await jsonRequest(
    "/api/v1/issues/candidates?assignment=needs_reassignment",
    { headers: ownerHeaders() },
  );
  assert.deepEqual(reassignmentCandidates.body.items.map((issue) => issue.identifier), ["CFK-1"]);

  const duplicateEvents = await db.prepare(
    `SELECT operation_id, COUNT(*) AS count FROM events
     WHERE type IN ('issue.created', 'issue.blocked-reported')
     GROUP BY operation_id HAVING COUNT(*) > 1`,
  ).all();
  assert.deepEqual(duplicateEvents.results, []);
  const persistedBulkEndpoints = JSON.stringify(server.getLogs());
  assert.equal(persistedBulkEndpoints.includes("assign-next"), false);
});
