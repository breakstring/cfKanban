import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { authenticateBearer, authenticateCookieSession } from "../../apps/worker/src/kernel/auth.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { createCursorContext, encodeCursor } from "../../apps/worker/src/kernel/cursor.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import {
  listIssueCandidates as listIssueCandidatesService,
  listIssues as listIssuesService,
  listProjectIssues as listProjectIssuesService,
  reportIssueBlocked,
} from "../../apps/worker/src/services/issues.ts";

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

function matchesApiError(expected) {
  return (error) => Object.entries(expected).every(([key, value]) => error?.[key] === value);
}

const unauthorizedError = matchesApiError({
  category: "authentication",
  code: "UNAUTHORIZED",
  recovery: "reauthenticate",
  retryable: false,
  source: "service",
  status: 401,
});
const notFoundError = matchesApiError({
  category: "not_found",
  code: "NOT_FOUND",
  recovery: "none",
  retryable: false,
  source: "service",
  status: 404,
});
const cursorScopeMismatchError = matchesApiError({
  category: "conflict",
  code: "CURSOR_SCOPE_MISMATCH",
  recovery: "refresh_cursor",
  retryable: false,
  source: "service",
  status: 409,
});

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

const ordinaryCursorFilter = (projectTargets = []) => ({
  assignees: [],
  candidate: false,
  candidate_assignment: null,
  candidate_blocked: null,
  deleted: "exclude",
  project_targets: projectTargets,
  q: null,
  statuses: [],
  workspace_targets: [],
});

const issueCursorScope = (resultProjectIds, relationProjectIds) => [
  ...resultProjectIds.map((projectId) => `result:${projectId}`),
  ...relationProjectIds.map((projectId) => `relation:${projectId}`),
];

function withOneFinalizeFailure(database) {
  let failed = false;
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SET state = 'committed'")) return statement;
          return {
            bind(...values) {
              const bound = statement.bind(...values);
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
}

function issueRecoveryScopeBarrierDatabase(database, pauseAtRead) {
  let matchingReads = 0;
  let rawRows = null;
  let releaseRead;
  let signalReached;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const wrapStatement = (statement, matchesScopeRead, matchesFinalQuery) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), matchesScopeRead, matchesFinalQuery);
      }
      if (property === "all" && (matchesScopeRead || matchesFinalQuery)) {
        return async (...args) => {
          const result = await target.all(...args);
          if (matchesFinalQuery) rawRows = result.results;
          if (matchesScopeRead) {
            matchingReads += 1;
            if (matchingReads === pauseAtRead) {
              signalReached();
              await released;
            }
          }
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
          return (sql) => {
            const matchesScopeRead = sql.includes("recovery_grant") && sql.includes("ORDER BY w.key, p.key");
            const matchesFinalQuery = sql.includes("WITH current_result_projects(id) AS MATERIALIZED")
              && sql.includes("FROM issues i");
            return wrapStatement(target.prepare(sql), matchesScopeRead, matchesFinalQuery);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    get rawRows() {
      return rawRows;
    },
    reached,
    release() {
      releaseRead();
    },
  };
}

function issueActiveScopeBarrierDatabase(database, pauseAtRead = 1) {
  let matchingReads = 0;
  let rawRows = null;
  let releaseRead;
  let signalReached;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const wrapStatement = (statement, matchesScopeRead, matchesFinalQuery) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), matchesScopeRead, matchesFinalQuery);
      }
      if (property === "all" && (matchesScopeRead || matchesFinalQuery)) {
        return async (...args) => {
          const result = await target.all(...args);
          if (matchesFinalQuery) rawRows = result.results;
          if (matchesScopeRead) {
            matchingReads += 1;
            if (matchingReads === pauseAtRead) {
              signalReached();
              await released;
            }
          }
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
          return (sql) => {
            const matchesScopeRead = sql.includes("FROM project_grants AS pg")
              && sql.includes("ORDER BY w.key, p.key");
            const matchesFinalQuery = (
              sql.includes("WITH current_result_projects(id) AS MATERIALIZED")
              || sql.includes("WITH current_visible_projects(id) AS MATERIALIZED")
            ) && sql.includes("FROM issues i");
            return wrapStatement(target.prepare(sql), matchesScopeRead, matchesFinalQuery);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    get rawRows() {
      return rawRows;
    },
    reached,
    release() {
      releaseRead();
    },
  };
}

function issueFinalQueryBarrierDatabase(database) {
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
      if (property === "all" && matches) {
        return async (...args) => {
          const result = await target.all(...args);
          if (!paused) {
            paused = true;
            signalReached();
            await released;
          }
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
          return (sql) => wrapStatement(
            target.prepare(sql),
            sql.includes("WITH current_result_projects(id) AS MATERIALIZED")
              && sql.includes("FROM issues i"),
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
  const privateProjectScope = await db.prepare(
    "SELECT workspace_id FROM projects WHERE id = ?1",
  ).bind(privateProject.body.resource.id).first();
  await db.prepare(
    `INSERT INTO issue_relations
      (id, workspace_id, kind, source_issue_id, target_issue_id,
       source_project_id, target_project_id, created_at,
       created_by_principal_id, created_operation_id)
     VALUES (?1, ?2, 'blocks', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    "50000000-0000-4000-8000-000000000015",
    privateProjectScope.workspace_id,
    privateIssue.body.resource.id,
    second.body.resource.id,
    privateProject.body.resource.id,
    coreProjectId,
    Date.now(),
    ids.ownerPrincipal,
    "wp05-seed-hidden-blocker",
  ).run();

  const writerList = await jsonRequest("/api/v1/issues", { headers: writerHeaders() });
  assert.deepEqual(writerList.body.items.map((issue) => issue.identifier), ["CFK-2", "CFK-1"]);
  assert.equal(writerList.body.items.find((issue) => issue.identifier === "CFK-2").is_blocked, false);
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
  const sameScopeDifferentPrincipalCursor = await jsonRequest(
    `/api/v1/issues?limit=1&cursor=${encodeURIComponent(firstPage.body.next_cursor)}`,
    { headers: readerHeaders() },
  );
  assert.equal(sameScopeDifferentPrincipalCursor.response.status, 409);
  assert.equal(sameScopeDifferentPrincipalCursor.body.code, "CURSOR_SCOPE_MISMATCH");
  const ordinaryCursorContext = await createCursorContext(
    "issues",
    ordinaryCursorFilter(),
    issueCursorScope([coreProjectId], [coreProjectId]),
    ids.writerPrincipal,
  );
  const invalidOrdinaryCursor = encodeCursor(ordinaryCursorContext, [-1, 1]);
  const invalidOrdinaryPage = await jsonRequest(
    `/api/v1/issues?cursor=${encodeURIComponent(invalidOrdinaryCursor)}`,
    { headers: writerHeaders() },
  );
  assert.equal(invalidOrdinaryPage.response.status, 400);
  assert.equal(invalidOrdinaryPage.body.code, "INVALID_CURSOR");
  const candidateCursorContext = await createCursorContext(
    "issue-candidates",
    {
      ...ordinaryCursorFilter(),
      candidate: true,
      candidate_assignment: "unassigned",
      candidate_blocked: "exclude",
    },
    issueCursorScope([coreProjectId], [coreProjectId]),
    ids.writerPrincipal,
  );
  const invalidCandidateCursor = encodeCursor(candidateCursorContext, [5, 0, 1]);
  const invalidCandidatePage = await jsonRequest(
    `/api/v1/issues/candidates?assignment=unassigned&cursor=${encodeURIComponent(invalidCandidateCursor)}`,
    { headers: writerHeaders() },
  );
  assert.equal(invalidCandidatePage.response.status, 400);
  assert.equal(invalidCandidatePage.body.code, "INVALID_CURSOR");
  const emptyScopeCursorContext = await createCursorContext(
    "issues",
    ordinaryCursorFilter(["engineering/MISSING"]),
    issueCursorScope([], [coreProjectId]),
    ids.writerPrincipal,
  );
  const invalidEmptyScopeCursor = encodeCursor(emptyScopeCursorContext, [0, 1.5]);
  const invalidEmptyScopePage = await jsonRequest(
    `/api/v1/issues?project=engineering%2FMISSING&cursor=${encodeURIComponent(invalidEmptyScopeCursor)}`,
    { headers: writerHeaders() },
  );
  assert.equal(invalidEmptyScopePage.response.status, 400);
  assert.equal(invalidEmptyScopePage.body.code, "INVALID_CURSOR");
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
  const statusEvent = await db.prepare(
    "SELECT payload_json FROM events WHERE type = 'issue.updated' AND subject_id = ?1 ORDER BY sequence DESC LIMIT 1",
  ).bind(first.body.resource.id).first();
  assert.deepEqual(
    {
      new_status_key: JSON.parse(statusEvent.payload_json).new_status_key,
      old_status_key: JSON.parse(statusEvent.payload_json).old_status_key,
    },
    { new_status_key: "todo", old_status_key: "backlog" },
  );
  const assigned = await jsonRequest("/api/v1/issues/CFK-1/commands/assign-to-me", {
    body: { expected_version: updated.body.resource.version },
    headers: writerHeaders({ "idempotency-key": "wp05-assign-self" }),
    method: "POST",
  });
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.body.resource.assignee.principal_id, ids.writerPrincipal);
  const filteredByStatusAndAssignee = await jsonRequest(
    `/api/v1/issues?status=todo&assignee=${encodeURIComponent(ids.writerPrincipal)}`,
    { headers: writerHeaders() },
  );
  assert.deepEqual(filteredByStatusAndAssignee.body.items.map((issue) => issue.identifier), ["CFK-1"]);
  assert.deepEqual(filteredByStatusAndAssignee.body.resolved_scope.filters, {
    assignees: [ids.writerPrincipal],
    statuses: ["todo"],
  });
  const statusPage = await jsonRequest("/api/v1/issues?status=todo&limit=1", {
    headers: writerHeaders(),
  });
  assert.equal(statusPage.body.has_more, true);
  const reusedWithDifferentFilter = await jsonRequest(
    `/api/v1/issues?status=backlog&limit=1&cursor=${encodeURIComponent(statusPage.body.next_cursor)}`,
    { headers: writerHeaders() },
  );
  assert.equal(reusedWithDifferentFilter.response.status, 409);
  assert.equal(reusedWithDifferentFilter.body.code, "CURSOR_SCOPE_MISMATCH");
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
  const hiddenBlockerProjection = await jsonRequest("/api/v1/issues/CFK-2", { headers: writerHeaders() });
  assert.equal(hiddenBlockerProjection.body.is_blocked, false);
  const crossProjectGrantId = "50000000-0000-4000-8000-000000000016";
  await db.prepare(
    `INSERT INTO project_grants
      (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
     VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`,
  ).bind(
    crossProjectGrantId,
    ids.writerPrincipal,
    privateProject.body.resource.id,
    Date.now(),
    "wp05-seed-cross-project-grant",
  ).run();
  const visibleBlockerProjection = await jsonRequest("/api/v1/issues/CFK-2", { headers: writerHeaders() });
  assert.equal(visibleBlockerProjection.body.is_blocked, true);
  const visibleBlockerCandidates = await jsonRequest(
    "/api/v1/issues/candidates?assignment=unassigned",
    { headers: writerHeaders() },
  );
  assert.equal(visibleBlockerCandidates.body.items.some((issue) => issue.identifier === "CFK-2"), false);
  await db.prepare(
    "UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2, version = version + 1 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, crossProjectGrantId).run();
  const revokedBlockerProjection = await jsonRequest("/api/v1/issues/CFK-2", { headers: writerHeaders() });
  assert.equal(revokedBlockerProjection.body.is_blocked, false);
  const revokedBlockerCandidates = await jsonRequest(
    "/api/v1/issues/candidates?assignment=unassigned",
    { headers: writerHeaders() },
  );
  assert.equal(revokedBlockerCandidates.body.items.some((issue) => issue.identifier === "CFK-2"), true);

  const maximumLabels = Array.from({ length: 20 }, (_, index) => ({
    id: `51000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `maximum-${String(index + 1).padStart(2, "0")}`,
    operation: `wp05-seed-maximum-label-${index + 1}`,
  }));
  await db.prepare(
    `INSERT INTO labels
      (id, project_id, name, color, created_at, updated_at,
       created_by_principal_id, updated_by_principal_id, created_operation_id)
     SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.name'), NULL,
            ?2, ?2, ?3, ?3, json_extract(value, '$.operation')
     FROM json_each(?4)`,
  ).bind(coreProjectId, Date.now(), ids.ownerPrincipal, JSON.stringify(maximumLabels)).run();
  const maximumLabelIssue = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: { label_ids: maximumLabels.map((label) => label.id), title: "Maximum label association" },
    headers: ownerHeaders({ "idempotency-key": "wp05-maximum-label-create" }),
    method: "POST",
  });
  assert.equal(maximumLabelIssue.response.status, 200);
  assert.equal(maximumLabelIssue.body.resource.labels.length, 20);
  const maximumLabelOperation = await db.prepare(
    "SELECT operation_id FROM events WHERE type = 'issue.created' AND subject_id = ?1",
  ).bind(maximumLabelIssue.body.resource.id).first();
  const maximumLabelProvenance = await db.prepare(
    `SELECT COUNT(*) AS association_count,
            COUNT(DISTINCT created_operation_id) AS operation_count,
            MIN(created_operation_id) AS operation_id
     FROM issue_labels WHERE issue_id = ?1`,
  ).bind(maximumLabelIssue.body.resource.id).first();
  assert.deepEqual(maximumLabelProvenance, {
    association_count: 20,
    operation_count: 1,
    operation_id: maximumLabelOperation.operation_id,
  });

  const contextProject = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { context: "p".repeat(20 * 1024), display_name: "Context", key: "CONTEXT" },
    headers: ownerHeaders({ "idempotency-key": "wp05-context-project" }),
    method: "POST",
  });
  const contextIssue = await jsonRequest("/api/v1/workspaces/engineering/projects/CONTEXT/issues", {
    body: { body: "b".repeat(20 * 1024), title: "Context remains complete below the envelope limit" },
    headers: ownerHeaders({ "idempotency-key": "wp05-context-issue" }),
    method: "POST",
  });
  const completeContext = await jsonRequest(
    `/api/v1/issues/${contextIssue.body.resource.identifier}/context`,
    { headers: ownerHeaders() },
  );
  assert.equal(completeContext.response.status, 200);
  assert.equal(completeContext.body.truncated, false);
  assert.equal(completeContext.body.sections.body.content.length, 20 * 1024);
  assert.equal(completeContext.body.sections.project_context.content.length, 20 * 1024);
  const contextComments = Array.from({ length: 101 }, (_, index) => ({
    created_at: Date.now() + index,
    id: `52000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    operation: `wp05-seed-context-comment-${index + 1}`,
  }));
  await db.prepare(
    `INSERT INTO comments
      (id, issue_id, kind, author_principal_id, body, created_at, created_operation_id)
     SELECT json_extract(value, '$.id'), ?1, 'standard', ?2, 'bounded context comment',
            json_extract(value, '$.created_at'), json_extract(value, '$.operation')
     FROM json_each(?3)`,
  ).bind(contextIssue.body.resource.id, ids.ownerPrincipal, JSON.stringify(contextComments)).run();
  const boundedCommentContext = await jsonRequest(
    `/api/v1/issues/${contextIssue.body.resource.identifier}/context`,
    { headers: ownerHeaders() },
  );
  assert.equal(boundedCommentContext.body.sections.comments.items.length, 10);
  assert.equal(boundedCommentContext.body.sections.comments.omitted_count, 91);
  assert.equal(
    boundedCommentContext.body.sections.comments.continuation,
    `/api/v1/issues/${contextIssue.body.resource.identifier}/comments`,
  );

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
  const quotaOneReplayAtLimit = await jsonRequest("/api/v1/workspaces/engineering/projects/QUOTA/issues", {
    body: { title: "Quota one" },
    headers: ownerHeaders({ "idempotency-key": "wp05-quota-one" }),
    method: "POST",
  });
  assert.equal(quotaOneReplayAtLimit.response.status, 200);
  assert.deepEqual(quotaOneReplayAtLimit.body.resource, quotaOne.body.resource);
  assert.equal(quotaOneReplayAtLimit.body.idempotent_replay, true);
  await db.batch([
    db.prepare(
      `INSERT INTO comments
        (id, issue_id, kind, author_principal_id, body, created_at, created_operation_id)
       VALUES (?1, ?2, 'standard', ?3, ?4, ?5, ?6)`,
    ).bind(
      "50000000-0000-4000-8000-000000000013",
      quotaOne.body.resource.id,
      ids.ownerPrincipal,
      "First active quota comment",
      Date.now(),
      "wp05-seed-comment-one",
    ),
    db.prepare(
      `INSERT INTO comments
        (id, issue_id, kind, author_principal_id, body, created_at, created_operation_id)
       VALUES (?1, ?2, 'standard', ?3, ?4, ?5, ?6)`,
    ).bind(
      "50000000-0000-4000-8000-000000000014",
      quotaOne.body.resource.id,
      ids.ownerPrincipal,
      "Second active quota comment",
      Date.now(),
      "wp05-seed-comment-two",
    ),
    db.prepare(
      "UPDATE project_usage SET active_comment_count = 2 WHERE project_id = ?1",
    ).bind(quotaProjectId),
  ]);
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
  assert.equal(deleted.body.resource.deleted_by_principal_id, ids.ownerPrincipal);
  assert.deepEqual(deleted.body.resource.parent_status, { project: "active", workspace: "active" });
  assert.equal(deleted.body.resource.restorable, true);
  const usageAfterIssueDelete = await db.prepare(
    "SELECT active_issue_count, active_comment_count FROM project_usage WHERE project_id = ?1",
  ).bind(quotaProjectId).first();
  assert.deepEqual(usageAfterIssueDelete, { active_comment_count: 0, active_issue_count: 0 });
  const deletedEvent = await db.prepare(
    "SELECT payload_json FROM events WHERE type = 'issue.deleted' AND subject_id = ?1 ORDER BY sequence DESC LIMIT 1",
  ).bind(quotaOne.body.resource.id).first();
  assert.equal(JSON.parse(deletedEvent.payload_json).released_or_restored_comments, 2);
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
  const issueQuotaBlockedTombstone = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?deleted=only`,
    { headers: ownerHeaders() },
  );
  assert.equal(issueQuotaBlockedTombstone.body.restorable, false);
  assert.equal(issueQuotaBlockedTombstone.body.unavailability_reason.code, "PROJECT_ISSUE_LIMIT_REACHED");
  assert.deepEqual(
    {
      current_usage: issueQuotaBlockedTombstone.body.unavailability_reason.current_usage,
      limit: issueQuotaBlockedTombstone.body.unavailability_reason.limit,
    },
    { current_usage: 1, limit: 1 },
  );
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
  const quotaTwoDeleted = await jsonRequest(
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
  const usageAfterIssueRestore = await db.prepare(
    "SELECT active_issue_count, active_comment_count FROM project_usage WHERE project_id = ?1",
  ).bind(quotaProjectId).first();
  assert.deepEqual(usageAfterIssueRestore, { active_comment_count: 2, active_issue_count: 1 });
  await db.prepare(
    "UPDATE projects SET issue_limit = 3, comment_limit = 1 WHERE id = ?1",
  ).bind(quotaProjectId).run();
  const zeroCommentRestoreWhileCommentOverLimit = await jsonRequest(
    `/api/v1/issues/${quotaTwo.body.resource.identifier}/commands/restore`,
    {
      body: { expected_version: quotaTwoDeleted.body.resource.version },
      headers: ownerHeaders({ "idempotency-key": "wp05-zero-comment-restore-over-limit" }),
      method: "POST",
    },
  );
  assert.equal(zeroCommentRestoreWhileCommentOverLimit.response.status, 200);
  const usageAfterZeroCommentRestore = await db.prepare(
    "SELECT active_issue_count, active_comment_count FROM project_usage WHERE project_id = ?1",
  ).bind(quotaProjectId).first();
  assert.deepEqual(usageAfterZeroCommentRestore, { active_comment_count: 2, active_issue_count: 2 });
  await jsonRequest(
    `/api/v1/issues/${quotaTwo.body.resource.identifier}?expected_version=${zeroCommentRestoreWhileCommentOverLimit.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  await db.prepare(
    "UPDATE projects SET issue_limit = 1, comment_limit = 10 WHERE id = ?1",
  ).bind(quotaProjectId).run();
  const repeatedRestore = await jsonRequest(`/api/v1/issues/${quotaOne.body.resource.identifier}/commands/restore`, {
    body: { expected_version: restored.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-repeated-restore" }),
    method: "POST",
  });
  assert.equal(repeatedRestore.response.status, 409);
  assert.equal(repeatedRestore.body.code, "RESOURCE_NOT_DELETED");
  await db.prepare(
    "UPDATE projects SET issue_limit = 3, comment_limit = 1 WHERE id = ?1",
  ).bind(quotaProjectId).run();
  const quotaOneDeletedForCommentProjection = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?expected_version=${restored.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(quotaOneDeletedForCommentProjection.response.status, 200);
  const commentQuotaBlockedTombstone = await jsonRequest(
    `/api/v1/issues/${quotaOne.body.resource.identifier}?deleted=only`,
    { headers: ownerHeaders() },
  );
  assert.equal(commentQuotaBlockedTombstone.body.restorable, false);
  assert.equal(commentQuotaBlockedTombstone.body.unavailability_reason.code, "PROJECT_COMMENT_LIMIT_REACHED");
  assert.deepEqual(
    {
      current_usage: commentQuotaBlockedTombstone.body.unavailability_reason.current_usage,
      limit: commentQuotaBlockedTombstone.body.unavailability_reason.limit,
    },
    { current_usage: 0, limit: 1 },
  );

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
    JSON.stringify({
      entry_path: `/app/issues/${first.body.resource.identifier}`,
      identifier: first.body.resource.identifier,
      issue_id: first.body.resource.id,
      kind: "issue",
      project_id: coreProjectId,
      project_key: "CORE",
      workspace_key: "engineering",
    }),
    Date.now() + 60_000,
    Date.now(),
  ).run();
  const cookieHeaders = {
    cookie: `cfkanban_session=${sessionToken}; cfkanban_csrf=${csrfToken}`,
  };
  const issueTargetList = await jsonRequest("/api/v1/issues", { headers: cookieHeaders });
  const issueTargetIdentifiers = new Set(issueTargetList.body.items.map((issue) => issue.identifier));
  assert.equal(issueTargetIdentifiers.has("CFK-1"), true);
  assert.equal(issueTargetIdentifiers.has("CFK-2"), true);
  assert.equal(issueTargetIdentifiers.has("CFK-3"), false);
  assert.equal(issueTargetIdentifiers.has(quotaOne.body.resource.identifier), false);
  const issueTargetProjectList = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE/issues",
    { headers: cookieHeaders },
  );
  assert.equal(issueTargetProjectList.response.status, 200);
  assert.equal(issueTargetProjectList.body.items.some((issue) => issue.identifier === "CFK-2"), true);
  const issueTargetCandidateList = await jsonRequest(
    "/api/v1/issues/candidates?assignment=unassigned",
    { headers: cookieHeaders },
  );
  assert.deepEqual(issueTargetCandidateList.body.items.map((issue) => issue.identifier), ["CFK-2"]);
  const issueTargetSibling = await jsonRequest("/api/v1/issues/CFK-2", { headers: cookieHeaders });
  assert.equal(issueTargetSibling.response.status, 200);
  const issueTargetLeak = await jsonRequest("/api/v1/issues/CFK-3", { headers: cookieHeaders });
  assert.equal(issueTargetLeak.response.status, 404);
  const discovery = await jsonRequest("/.well-known/cfkanban-instance.json");
  const issueTargetCurrent = await jsonRequest("/api/v1/issues/CFK-1", { headers: cookieHeaders });
  const issueTargetWrite = await jsonRequest("/api/v1/issues/CFK-1", {
    body: { expected_version: issueTargetCurrent.body.version, title: "Initial issue via project-scoped session" },
    headers: {
      ...cookieHeaders,
      origin: discovery.body.observed_origin,
      "x-csrf-token": csrfToken,
    },
    method: "PATCH",
  });
  assert.equal(issueTargetWrite.response.status, 200);
  const issueTargetDelete = await jsonRequest(
    `/api/v1/issues/CFK-1?expected_version=${issueTargetWrite.body.resource.version}`,
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
  const issueTargetListAfterDelete = await jsonRequest("/api/v1/issues", { headers: cookieHeaders });
  assert.equal(issueTargetListAfterDelete.response.status, 200);
  assert.deepEqual(issueTargetListAfterDelete.body.items, []);
  const issueTargetSiblingAfterDelete = await jsonRequest("/api/v1/issues/CFK-2", { headers: cookieHeaders });
  assert.equal(issueTargetSiblingAfterDelete.response.status, 404);
  const issueTargetTombstone = await jsonRequest(
    "/api/v1/issues/CFK-1?deleted=only",
    { headers: cookieHeaders },
  );
  assert.equal(issueTargetTombstone.response.status, 200);
  const issueTargetTombstones = await jsonRequest("/api/v1/issues?deleted=only", { headers: cookieHeaders });
  assert.equal(issueTargetTombstones.response.status, 200);
  assert.deepEqual(issueTargetTombstones.body.items.map((issue) => issue.identifier), ["CFK-1"]);
  const issueTargetRestore = await jsonRequest(
    "/api/v1/issues/CFK-1/commands/restore",
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
    "UPDATE labels SET deleted_at = ?1, deleted_by_principal_id = ?2, version = version + 1 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, ids.label).run();
  const labelDriftReplay = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: createBody,
    headers: ownerHeaders({ "idempotency-key": "wp05-first-issue" }),
    method: "POST",
  });
  assert.equal(labelDriftReplay.response.status, 200);
  assert.deepEqual(labelDriftReplay.body.resource, first.body.resource);
  assert.equal(labelDriftReplay.body.idempotent_replay, true);
  await db.prepare(
    "UPDATE labels SET deleted_at = NULL, deleted_by_principal_id = NULL, version = version + 1 WHERE id = ?1",
  ).bind(ids.label).run();

  const commandReplayCases = [
    {
      command: "assign-to-me",
      createKey: "wp05-command-replay-assign-create",
      commandBody: (version) => ({ expected_version: version }),
      commandKey: "wp05-command-replay-assign",
      title: "Assign replay after delete",
    },
    {
      command: "report-blocked",
      createKey: "wp05-command-replay-block-create",
      commandBody: (version) => ({ expected_version: version, reason: "Transient dependency" }),
      commandKey: "wp05-command-replay-block",
      title: "Blocked replay after delete",
    },
  ];
  for (const replayCase of commandReplayCases) {
    const created = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
      body: { title: replayCase.title },
      headers: writerHeaders({ "idempotency-key": replayCase.createKey }),
      method: "POST",
    });
    const commandBody = replayCase.commandBody(created.body.resource.version);
    const commanded = await jsonRequest(
      `/api/v1/issues/${created.body.resource.identifier}/commands/${replayCase.command}`,
      {
        body: commandBody,
        headers: writerHeaders({ "idempotency-key": replayCase.commandKey }),
        method: "POST",
      },
    );
    assert.equal(commanded.response.status, 200);
    await jsonRequest(
      `/api/v1/issues/${created.body.resource.identifier}?expected_version=${commanded.body.resource.version}`,
      { headers: ownerHeaders(), method: "DELETE" },
    );
    const replayed = await jsonRequest(
      `/api/v1/issues/${created.body.resource.identifier}/commands/${replayCase.command}`,
      {
        body: commandBody,
        headers: writerHeaders({ "idempotency-key": replayCase.commandKey }),
        method: "POST",
      },
    );
    assert.equal(replayed.response.status, 200);
    assert.deepEqual(replayed.body.resource, commanded.body.resource);
    assert.equal(replayed.body.idempotent_replay, true);
  }
  const clearReplayIssue = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: { title: "Clear blocked replay after delete" },
    headers: writerHeaders({ "idempotency-key": "wp05-command-replay-clear-create" }),
    method: "POST",
  });
  const clearReplayBlocked = await jsonRequest(
    `/api/v1/issues/${clearReplayIssue.body.resource.identifier}/commands/report-blocked`,
    {
      body: { expected_version: clearReplayIssue.body.resource.version, reason: "Clear me" },
      headers: writerHeaders({ "idempotency-key": "wp05-command-replay-clear-setup" }),
      method: "POST",
    },
  );
  const clearRequestBody = { expected_version: clearReplayBlocked.body.resource.version };
  const clearCommand = await jsonRequest(
    `/api/v1/issues/${clearReplayIssue.body.resource.identifier}/commands/clear-blocked`,
    {
      body: clearRequestBody,
      headers: writerHeaders({ "idempotency-key": "wp05-command-replay-clear" }),
      method: "POST",
    },
  );
  await jsonRequest(
    `/api/v1/issues/${clearReplayIssue.body.resource.identifier}?expected_version=${clearCommand.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  const clearCommandReplay = await jsonRequest(
    `/api/v1/issues/${clearReplayIssue.body.resource.identifier}/commands/clear-blocked`,
    {
      body: clearRequestBody,
      headers: writerHeaders({ "idempotency-key": "wp05-command-replay-clear" }),
      method: "POST",
    },
  );
  assert.equal(clearCommandReplay.response.status, 200);
  assert.deepEqual(clearCommandReplay.body.resource, clearCommand.body.resource);
  assert.equal(clearCommandReplay.body.idempotent_replay, true);

  const assignedCreateBody = {
    assignee_principal_id: ids.writerPrincipal,
    title: "Assignee replay remains exact",
  };
  const assignedCreate = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: assignedCreateBody,
    headers: ownerHeaders({ "idempotency-key": "wp05-assignee-replay" }),
    method: "POST",
  });
  assert.equal(assignedCreate.response.status, 200);

  await db.prepare(
    "UPDATE project_grants SET role = 'reader', version = version + 1 WHERE id = ?1",
  ).bind(ids.writerGrant).run();
  const assigneeDriftReplay = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: assignedCreateBody,
    headers: ownerHeaders({ "idempotency-key": "wp05-assignee-replay" }),
    method: "POST",
  });
  assert.equal(assigneeDriftReplay.response.status, 200);
  assert.deepEqual(assigneeDriftReplay.body.resource, assignedCreate.body.resource);
  assert.equal(assigneeDriftReplay.body.idempotent_replay, true);
  const callerDowngradedReplay = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/issues", {
    body: { priority_key: "high", status_key: "todo", title: "Second candidate" },
    headers: writerHeaders({ "idempotency-key": "wp05-second-issue" }),
    method: "POST",
  });
  assert.equal(callerDowngradedReplay.response.status, 403);
  const unavailableAssignee = await jsonRequest("/api/v1/issues/CFK-1", { headers: ownerHeaders() });
  const unrelatedPatch = await jsonRequest("/api/v1/issues/CFK-1", {
    body: {
      expected_version: unavailableAssignee.body.version,
      title: "Initial issue with unavailable assignee",
    },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(unrelatedPatch.response.status, 200);
  assert.equal(unrelatedPatch.body.resource.assignee.available, false);
  assert.equal(unrelatedPatch.body.resource.needs_reassignment, true);
  const reassignmentCandidates = await jsonRequest(
    "/api/v1/issues/candidates?assignment=needs_reassignment",
    { headers: ownerHeaders() },
  );
  assert.deepEqual(reassignmentCandidates.body.items.map((issue) => issue.identifier), ["CFK-1"]);

  const privateActive = await jsonRequest("/api/v1/workspaces/engineering/projects/PRIVATE/issues", {
    body: { title: "Active child must not become a tombstone" },
    headers: ownerHeaders({ "idempotency-key": "wp05-private-active-child" }),
    method: "POST",
  });
  await db.prepare(
    `UPDATE project_grants SET role = 'writer', revoked_at = NULL,
       revoked_by_principal_id = NULL, version = version + 1
     WHERE id = ?1`,
  ).bind(crossProjectGrantId).run();
  const privateIssueCurrent = await jsonRequest("/api/v1/issues/CFK-3", { headers: ownerHeaders() });
  const privateIssueDeleted = await jsonRequest(
    `/api/v1/issues/CFK-3?expected_version=${privateIssueCurrent.body.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );

  const recoveryRaceAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const globalRecoveryBarrier = issueRecoveryScopeBarrierDatabase(db, 1);
  const racedGlobalTombstones = listIssuesService(
    globalRecoveryBarrier.db,
    recoveryRaceAuth,
    new URL("https://kanban.example.test/api/v1/issues?deleted=only"),
    Date.now(),
  );
  await globalRecoveryBarrier.reached;
  await db.prepare(
    "UPDATE projects SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, privateProject.body.resource.id).run();
  globalRecoveryBarrier.release();
  try {
    await assert.rejects(
      racedGlobalTombstones,
      (error) => error?.code === "CURSOR_SCOPE_MISMATCH" && error?.status === 409,
    );
    assert.deepEqual(globalRecoveryBarrier.rawRows, []);
  } finally {
    await db.prepare(
      "UPDATE projects SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    )
      .bind(privateProject.body.resource.id).run();
  }
  const projectRecoveryBarrier = issueRecoveryScopeBarrierDatabase(db, 2);
  const racedProjectTombstones = listProjectIssuesService(
    projectRecoveryBarrier.db,
    recoveryRaceAuth,
    "engineering",
    "PRIVATE",
    new URL("https://kanban.example.test/api/v1/workspaces/engineering/projects/PRIVATE/issues?deleted=only"),
    Date.now(),
  );
  await projectRecoveryBarrier.reached;
  await db.prepare(
    "UPDATE projects SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, privateProject.body.resource.id).run();
  projectRecoveryBarrier.release();
  try {
    await assert.rejects(racedProjectTombstones, (error) => error?.status === 404);
    assert.deepEqual(projectRecoveryBarrier.rawRows, []);
  } finally {
    await db.prepare(
      "UPDATE projects SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    )
      .bind(privateProject.body.resource.id).run();
  }

  const privateProjectCurrent = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/PRIVATE",
    { headers: ownerHeaders() },
  );
  const privateProjectDeleted = await jsonRequest(
    `/api/v1/workspaces/engineering/projects/PRIVATE?expected_version=${privateProjectCurrent.body.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(privateProjectDeleted.response.status, 200);
  const pausedProjectTombstone = await jsonRequest("/api/v1/issues/CFK-3?deleted=only", {
    headers: ownerHeaders(),
  });
  assert.equal(pausedProjectTombstone.response.status, 200);
  assert.deepEqual(pausedProjectTombstone.body.parent_status, { project: "deleted", workspace: "active" });
  assert.equal(pausedProjectTombstone.body.restorable, false);
  assert.equal(pausedProjectTombstone.body.unavailability_reason.code, "PARENT_PROJECT_DELETED");
  const participantPausedProjectTombstone = await jsonRequest("/api/v1/issues/CFK-3?deleted=only", {
    headers: writerHeaders(),
  });
  assert.equal(participantPausedProjectTombstone.response.status, 404);
  const participantPausedProjectTombstones = await jsonRequest("/api/v1/issues?deleted=only", {
    headers: writerHeaders(),
  });
  assert.equal(participantPausedProjectTombstones.response.status, 200);
  assert.equal(
    participantPausedProjectTombstones.body.items.some((issue) => issue.identifier === "CFK-3"),
    false,
  );
  const participantPausedProjectPath = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/PRIVATE/issues?deleted=only",
    { headers: writerHeaders() },
  );
  assert.equal(participantPausedProjectPath.response.status, 404);
  const activeChildIsNotTombstone = await jsonRequest(
    `/api/v1/issues/${privateActive.body.resource.identifier}?deleted=only`,
    { headers: ownerHeaders() },
  );
  assert.equal(activeChildIsNotTombstone.response.status, 404);
  const pausedProjectTombstoneList = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/PRIVATE/issues?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.deepEqual(pausedProjectTombstoneList.body.items.map((issue) => issue.identifier), ["CFK-3"]);
  const restoreUnderDeletedProject = await jsonRequest("/api/v1/issues/CFK-3/commands/restore", {
    body: { expected_version: privateIssueDeleted.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-restore-under-deleted-project" }),
    method: "POST",
  });
  assert.equal(restoreUnderDeletedProject.response.status, 409);
  assert.equal(restoreUnderDeletedProject.body.code, "PARENT_PROJECT_DELETED");
  assert.equal(restoreUnderDeletedProject.body.recovery, "restore_parent");
  const privateProjectRestored = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/PRIVATE/commands/restore",
    {
      body: { expected_version: privateProjectDeleted.body.resource.version },
      headers: ownerHeaders({ "idempotency-key": "wp05-restore-private-project" }),
      method: "POST",
    },
  );
  assert.equal(privateProjectRestored.response.status, 200);
  const privateIssueRestored = await jsonRequest("/api/v1/issues/CFK-3/commands/restore", {
    body: { expected_version: privateIssueDeleted.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-restore-private-issue-after-project" }),
    method: "POST",
  });
  assert.equal(privateIssueRestored.response.status, 200);

  const privateIssueDeletedAgain = await jsonRequest(
    `/api/v1/issues/CFK-3?expected_version=${privateIssueRestored.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  const engineeringCurrent = await jsonRequest("/api/v1/workspaces/engineering", {
    headers: ownerHeaders(),
  });
  const engineeringDeleted = await jsonRequest(
    `/api/v1/workspaces/engineering?expected_version=${engineeringCurrent.body.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(engineeringDeleted.response.status, 200);
  const pausedWorkspaceTombstone = await jsonRequest("/api/v1/issues/CFK-3?deleted=only", {
    headers: writerHeaders(),
  });
  assert.equal(pausedWorkspaceTombstone.response.status, 404);
  const participantPausedWorkspaceTombstones = await jsonRequest("/api/v1/issues?deleted=only", {
    headers: writerHeaders(),
  });
  assert.equal(participantPausedWorkspaceTombstones.response.status, 200);
  assert.equal(
    participantPausedWorkspaceTombstones.body.items.some((issue) => issue.identifier === "CFK-3"),
    false,
  );
  const participantPausedWorkspacePath = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/PRIVATE/issues?deleted=only",
    { headers: writerHeaders() },
  );
  assert.equal(participantPausedWorkspacePath.response.status, 404);
  const restoreUnderDeletedWorkspace = await jsonRequest("/api/v1/issues/CFK-3/commands/restore", {
    body: { expected_version: privateIssueDeletedAgain.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-restore-under-deleted-workspace" }),
    method: "POST",
  });
  assert.equal(restoreUnderDeletedWorkspace.response.status, 409);
  assert.equal(restoreUnderDeletedWorkspace.body.code, "PARENT_WORKSPACE_DELETED");
  const engineeringRestored = await jsonRequest("/api/v1/workspaces/engineering/commands/restore", {
    body: { expected_version: engineeringDeleted.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-restore-engineering-workspace" }),
    method: "POST",
  });
  assert.equal(engineeringRestored.response.status, 200);
  const privateIssueRestoredAfterWorkspace = await jsonRequest("/api/v1/issues/CFK-3/commands/restore", {
    body: { expected_version: privateIssueDeletedAgain.body.resource.version },
    headers: ownerHeaders({ "idempotency-key": "wp05-restore-private-issue-after-workspace" }),
    method: "POST",
  });
  assert.equal(privateIssueRestoredAfterWorkspace.response.status, 200);
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, crossProjectGrantId).run();

  await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Relation Scope", key: "relation-scope" },
    headers: ownerHeaders({ "idempotency-key": "wp05-relation-scope-workspace" }),
    method: "POST",
  });
  const relationProjectA = await jsonRequest("/api/v1/workspaces/relation-scope/projects", {
    body: { display_name: "Relation A", key: "RA" },
    headers: ownerHeaders({ "idempotency-key": "wp05-relation-project-a" }),
    method: "POST",
  });
  const relationProjectB = await jsonRequest("/api/v1/workspaces/relation-scope/projects", {
    body: { display_name: "Relation B", key: "RB" },
    headers: ownerHeaders({ "idempotency-key": "wp05-relation-project-b" }),
    method: "POST",
  });
  const relationProjectAGrant = "50000000-0000-4000-8000-000000000020";
  const relationProjectBGrant = "50000000-0000-4000-8000-000000000021";
  await db.batch([
    db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`,
    ).bind(
      relationProjectAGrant,
      ids.writerPrincipal,
      relationProjectA.body.resource.id,
      Date.now(),
      "wp05-relation-scope-grant-a",
    ),
    db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`,
    ).bind(
      relationProjectBGrant,
      ids.writerPrincipal,
      relationProjectB.body.resource.id,
      Date.now(),
      "wp05-relation-scope-grant-b",
    ),
  ]);
  const relationTarget = await jsonRequest("/api/v1/workspaces/relation-scope/projects/RA/issues", {
    body: { status_key: "todo", title: "Visible target with cross-project blocker" },
    headers: writerHeaders({ "idempotency-key": "wp05-relation-target" }),
    method: "POST",
  });
  await jsonRequest("/api/v1/workspaces/relation-scope/projects/RA/issues", {
    body: { title: "Second scoped issue for cursor validation" },
    headers: writerHeaders({ "idempotency-key": "wp05-relation-target-second" }),
    method: "POST",
  });
  const relationBlocker = await jsonRequest("/api/v1/workspaces/relation-scope/projects/RB/issues", {
    body: { status_key: "in_progress", title: "Visible cross-project blocker" },
    headers: writerHeaders({ "idempotency-key": "wp05-relation-blocker" }),
    method: "POST",
  });
  const relationWorkspace = await db.prepare(
    "SELECT workspace_id FROM projects WHERE id = ?1",
  ).bind(relationProjectA.body.resource.id).first();
  await db.prepare(
    `INSERT INTO issue_relations
      (id, workspace_id, kind, source_issue_id, target_issue_id,
       source_project_id, target_project_id, created_at,
       created_by_principal_id, created_operation_id)
     VALUES (?1, ?2, 'blocks', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    "50000000-0000-4000-8000-000000000022",
    relationWorkspace.workspace_id,
    relationBlocker.body.resource.id,
    relationTarget.body.resource.id,
    relationProjectB.body.resource.id,
    relationProjectA.body.resource.id,
    Date.now(),
    ids.writerPrincipal,
    "wp05-relation-scope-blocker",
  ).run();
  const explicitRelationScope = await jsonRequest(
    "/api/v1/issues?project=relation-scope%2FRA",
    { headers: writerHeaders() },
  );
  assert.equal(
    explicitRelationScope.body.items.find(
      (issue) => issue.identifier === relationTarget.body.resource.identifier,
    ).is_blocked,
    true,
  );
  const blockedExplicitCandidate = await jsonRequest(
    "/api/v1/issues/candidates?assignment=unassigned&project=relation-scope%2FRA",
    { headers: writerHeaders() },
  );
  assert.deepEqual(blockedExplicitCandidate.body.items, []);
  const relationScopePage = await jsonRequest(
    "/api/v1/issues?project=relation-scope%2FRA&limit=1",
    { headers: writerHeaders() },
  );
  assert.equal(relationScopePage.body.has_more, true);
  const scopedCommandBody = { expected_version: relationTarget.body.resource.version };
  const scopedCommand = await jsonRequest(
    `/api/v1/issues/${relationTarget.body.resource.identifier}/commands/assign-to-me`,
    {
      body: scopedCommandBody,
      headers: writerHeaders({ "idempotency-key": "wp05-relation-scope-command" }),
      method: "POST",
    },
  );
  assert.equal(scopedCommand.body.resource.is_blocked, true);
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, relationProjectBGrant).run();
  const changedRelationVisibilityCursor = await jsonRequest(
    `/api/v1/issues?project=relation-scope%2FRA&limit=1&cursor=${encodeURIComponent(relationScopePage.body.next_cursor)}`,
    { headers: writerHeaders() },
  );
  assert.equal(changedRelationVisibilityCursor.response.status, 409);
  assert.equal(changedRelationVisibilityCursor.body.code, "CURSOR_SCOPE_MISMATCH");
  const replayAfterBlockerGrantRevoke = await jsonRequest(
    `/api/v1/issues/${relationTarget.body.resource.identifier}/commands/assign-to-me`,
    {
      body: scopedCommandBody,
      headers: writerHeaders({ "idempotency-key": "wp05-relation-scope-command" }),
      method: "POST",
    },
  );
  assert.equal(replayAfterBlockerGrantRevoke.response.status, 200);
  assert.equal(replayAfterBlockerGrantRevoke.body.idempotent_replay, true);
  assert.equal(replayAfterBlockerGrantRevoke.body.resource.is_blocked, false);
  const visibleCandidateAfterGrantRevoke = await jsonRequest(
    "/api/v1/issues/candidates?assignment=mine&project=relation-scope%2FRA",
    { headers: writerHeaders() },
  );
  assert.deepEqual(
    visibleCandidateAfterGrantRevoke.body.items.map((issue) => issue.identifier),
    [relationTarget.body.resource.identifier],
  );

  const finalizeInterruptionIssue = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE/issues",
    {
      body: { title: "Finalize interruption must not become a write lock" },
      headers: ownerHeaders({ "idempotency-key": "wp05-finalize-interruption-create" }),
      method: "POST",
    },
  );
  const finalizeRequestBody = {
    expected_version: finalizeInterruptionIssue.body.resource.version,
    reason: "Business commit survives response interruption",
  };
  const ownerAuth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  const finalizeRequest = new Request(
    `https://kanban.example.test/api/v1/issues/${finalizeInterruptionIssue.body.resource.identifier}/commands/report-blocked`,
    {
      body: JSON.stringify(finalizeRequestBody),
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
        "idempotency-key": "wp05-finalize-interruption-command",
      },
      method: "POST",
    },
  );
  await assert.rejects(
    reportIssueBlocked(
      withOneFinalizeFailure(db),
      finalizeRequest,
      ownerAuth,
      finalizeInterruptionIssue.body.resource.identifier,
      finalizeRequestBody.expected_version,
      finalizeRequestBody.reason,
      Date.now(),
    ),
    (error) => error?.code === "PLATFORM_UNAVAILABLE",
  );
  const pendingAfterBusinessCommit = await db.prepare(
    `SELECT record.state, record.operation_snapshot_json,
            EXISTS (SELECT 1 FROM operation_commits commit_row
                    WHERE commit_row.operation_id = record.operation_id) AS committed
     FROM idempotency_records record
     WHERE record.route_template = '/api/v1/issues/{identifier}/commands/report-blocked'
       AND record.state = 'pending'
     ORDER BY record.created_at DESC LIMIT 1`,
  ).first();
  assert.equal(pendingAfterBusinessCommit.state, "pending");
  assert.equal(pendingAfterBusinessCommit.committed, 1);
  assert.equal(typeof pendingAfterBusinessCommit.operation_snapshot_json, "string");
  const committedCommandState = await jsonRequest(
    `/api/v1/issues/${finalizeInterruptionIssue.body.resource.identifier}`,
    { headers: ownerHeaders() },
  );
  assert.equal(committedCommandState.body.blocked_reason, finalizeRequestBody.reason);
  const laterMutation = await jsonRequest(
    `/api/v1/issues/${finalizeInterruptionIssue.body.resource.identifier}`,
    {
      body: {
        expected_version: committedCommandState.body.version,
        title: "A later writer mutation remains allowed",
      },
      headers: ownerHeaders(),
      method: "PATCH",
    },
  );
  assert.equal(laterMutation.response.status, 200);
  const resumedOriginalCommand = await jsonRequest(
    `/api/v1/issues/${finalizeInterruptionIssue.body.resource.identifier}/commands/report-blocked`,
    {
      body: finalizeRequestBody,
      headers: ownerHeaders({ "idempotency-key": "wp05-finalize-interruption-command" }),
      method: "POST",
    },
  );
  assert.equal(resumedOriginalCommand.response.status, 200);
  assert.equal(resumedOriginalCommand.body.idempotent_replay, true);
  assert.equal(resumedOriginalCommand.body.resource.version, committedCommandState.body.version);
  assert.equal(resumedOriginalCommand.body.resource.title, finalizeInterruptionIssue.body.resource.title);
  assert.equal(resumedOriginalCommand.body.resource.blocked_reason, finalizeRequestBody.reason);
  const currentAfterResume = await jsonRequest(
    `/api/v1/issues/${finalizeInterruptionIssue.body.resource.identifier}`,
    { headers: ownerHeaders() },
  );
  assert.equal(currentAfterResume.body.title, "A later writer mutation remains allowed");
  assert.equal(currentAfterResume.body.version, laterMutation.body.resource.version);
  const finalizedRecord = await db.prepare(
    `SELECT state, operation_snapshot_json FROM idempotency_records
     WHERE route_template = '/api/v1/issues/{identifier}/commands/report-blocked'
     ORDER BY created_at DESC LIMIT 1`,
  ).first();
  assert.deepEqual(finalizedRecord, { operation_snapshot_json: null, state: "committed" });

  await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Authorization races", key: "auth-races" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-workspace" }),
    method: "POST",
  });
  const raceProjectA = await jsonRequest("/api/v1/workspaces/auth-races/projects", {
    body: { display_name: "Race A", key: "RA" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-project-a" }),
    method: "POST",
  });
  const raceProjectB = await jsonRequest("/api/v1/workspaces/auth-races/projects", {
    body: { display_name: "Race B", key: "RB" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-project-b" }),
    method: "POST",
  });
  const raceGrantA = "50000000-0000-4000-8000-000000000091";
  const raceGrantB = "50000000-0000-4000-8000-000000000092";
  await db.prepare(
    `INSERT INTO project_grants
      (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
     VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`,
  ).bind(
    raceGrantA,
    ids.writerPrincipal,
    raceProjectA.body.resource.id,
    Date.now(),
    "wp05-auth-race-grant-a",
  ).run();
  await jsonRequest("/api/v1/workspaces/auth-races/projects/RA/issues", {
    body: { status_key: "todo", title: "Race baseline A" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-issue-a" }),
    method: "POST",
  });
  await jsonRequest("/api/v1/workspaces/auth-races/projects/RB/issues", {
    body: { status_key: "todo", title: "Race baseline B" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-issue-b" }),
    method: "POST",
  });

  const raceSessionId = "50000000-0000-4000-8000-000000000093";
  const raceSessionToken = "T".repeat(43);
  const raceSessionCreatedAt = Date.now();
  const raceSessionExpiresAt = raceSessionCreatedAt + 8 * 60 * 60 * 1_000;
  await db.prepare(
    `INSERT INTO web_sessions
      (id, token_digest, principal_id, source_kind, source_id, target_kind,
       target_json, expires_at, created_at)
     VALUES (?1, ?2, ?3, 'credential', ?4, 'project', ?5, ?6, ?7)`,
  ).bind(
    raceSessionId,
    await sha256Hex(raceSessionToken),
    ids.writerPrincipal,
    ids.writerCredential,
    JSON.stringify({
      entry_path: "/app/w/auth-races/p/RA",
      kind: "project",
      project_id: raceProjectA.body.resource.id,
      project_key: "RA",
      workspace_key: "auth-races",
    }),
    raceSessionExpiresAt,
    raceSessionCreatedAt,
  ).run();
  const raceSessionRequest = new Request("https://kanban.example.test/api/v1/issues", {
    headers: { cookie: `cfkanban_session=${raceSessionToken}` },
  });
  const raceSessionAuth = await authenticateCookieSession(
    db,
    raceSessionRequest,
    raceSessionCreatedAt + 1,
  );

  const revokedSessionBarrier = issueActiveScopeBarrierDatabase(db);
  const revokedSessionList = listIssuesService(
    revokedSessionBarrier.db,
    raceSessionAuth,
    new URL("https://kanban.example.test/api/v1/issues?project=auth-races%2FRA"),
    raceSessionCreatedAt + 1,
  );
  await revokedSessionBarrier.reached;
  await db.prepare("UPDATE web_sessions SET revoked_at = ?1 WHERE id = ?2")
    .bind(Date.now(), raceSessionId).run();
  revokedSessionBarrier.release();
  try {
    await assert.rejects(revokedSessionList, unauthorizedError);
    assert.deepEqual(revokedSessionBarrier.rawRows, []);
  } finally {
    await db.prepare("UPDATE web_sessions SET revoked_at = NULL WHERE id = ?1")
      .bind(raceSessionId).run();
  }

  const revokedSessionSourceBarrier = issueActiveScopeBarrierDatabase(db);
  const revokedSessionSourceList = listIssuesService(
    revokedSessionSourceBarrier.db,
    raceSessionAuth,
    new URL("https://kanban.example.test/api/v1/issues?project=auth-races%2FRA"),
    raceSessionCreatedAt + 1,
  );
  await revokedSessionSourceBarrier.reached;
  await db.prepare(
    "UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, ids.writerCredential).run();
  revokedSessionSourceBarrier.release();
  try {
    await assert.rejects(revokedSessionSourceList, unauthorizedError);
    assert.deepEqual(revokedSessionSourceBarrier.rawRows, []);
  } finally {
    await db.prepare(
      "UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.writerCredential).run();
  }

  const expiredSessionStartedAt = raceSessionCreatedAt + 2;
  const expiredSessionBarrier = issueActiveScopeBarrierDatabase(db);
  const expiredSessionList = listIssuesService(
    expiredSessionBarrier.db,
    raceSessionAuth,
    new URL("https://kanban.example.test/api/v1/issues?project=auth-races%2FRA"),
    expiredSessionStartedAt,
  );
  await expiredSessionBarrier.reached;
  await db.prepare("UPDATE web_sessions SET expires_at = ?1 WHERE id = ?2")
    .bind(expiredSessionStartedAt, raceSessionId).run();
  expiredSessionBarrier.release();
  try {
    await assert.rejects(expiredSessionList, unauthorizedError);
    assert.deepEqual(expiredSessionBarrier.rawRows, []);
  } finally {
    await db.prepare("UPDATE web_sessions SET expires_at = ?1 WHERE id = ?2")
      .bind(raceSessionExpiresAt, raceSessionId).run();
  }

  const activeListAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const credentialRaceBarrier = issueActiveScopeBarrierDatabase(db);
  const credentialRacedList = listIssuesService(
    credentialRaceBarrier.db,
    activeListAuth,
    new URL("https://kanban.example.test/api/v1/issues?project=auth-races%2FRA"),
    Date.now(),
  );
  await credentialRaceBarrier.reached;
  await db.prepare(
    "UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, ids.writerCredential).run();
  await jsonRequest("/api/v1/workspaces/auth-races/projects/RA/issues", {
    body: { title: "Created after credential revoke" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-after-credential-revoke" }),
    method: "POST",
  });
  credentialRaceBarrier.release();
  try {
    await assert.rejects(credentialRacedList, unauthorizedError);
    assert.deepEqual(credentialRaceBarrier.rawRows, []);
  } finally {
    await db.prepare(
      "UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.writerCredential).run();
  }

  const projectListAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const projectRaceBarrier = issueActiveScopeBarrierDatabase(db, 2);
  const projectRacedList = listProjectIssuesService(
    projectRaceBarrier.db,
    projectListAuth,
    "auth-races",
    "RA",
    new URL("https://kanban.example.test/api/v1/workspaces/auth-races/projects/RA/issues"),
    Date.now(),
  );
  await projectRaceBarrier.reached;
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, raceGrantA).run();
  await jsonRequest("/api/v1/workspaces/auth-races/projects/RA/issues", {
    body: { title: "Created after Project Grant revoke" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-after-grant-revoke" }),
    method: "POST",
  });
  projectRaceBarrier.release();
  try {
    await assert.rejects(projectRacedList, notFoundError);
    assert.deepEqual(projectRaceBarrier.rawRows, []);
  } finally {
    await db.prepare(
      `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
         version = version + 1 WHERE id = ?1`,
    ).bind(raceGrantA).run();
  }

  const pausedProjectAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const pausedProjectBarrier = issueActiveScopeBarrierDatabase(db);
  const pausedProjectList = listIssuesService(
    pausedProjectBarrier.db,
    pausedProjectAuth,
    new URL("https://kanban.example.test/api/v1/issues?project=auth-races%2FRA"),
    Date.now(),
  );
  await pausedProjectBarrier.reached;
  await db.prepare(
    "UPDATE projects SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, raceProjectA.body.resource.id).run();
  pausedProjectBarrier.release();
  try {
    await assert.rejects(
      pausedProjectList,
      cursorScopeMismatchError,
    );
    assert.deepEqual(pausedProjectBarrier.rawRows, []);
  } finally {
    await db.prepare(
      "UPDATE projects SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(raceProjectA.body.resource.id).run();
  }

  const raceWorkspace = await db.prepare(
    "SELECT id FROM workspaces WHERE key = 'auth-races'",
  ).first();
  const pausedWorkspaceAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const pausedWorkspaceBarrier = issueActiveScopeBarrierDatabase(db, 2);
  const pausedWorkspaceProjectList = listProjectIssuesService(
    pausedWorkspaceBarrier.db,
    pausedWorkspaceAuth,
    "auth-races",
    "RA",
    new URL("https://kanban.example.test/api/v1/workspaces/auth-races/projects/RA/issues"),
    Date.now(),
  );
  await pausedWorkspaceBarrier.reached;
  await db.prepare(
    "UPDATE workspaces SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, raceWorkspace.id).run();
  pausedWorkspaceBarrier.release();
  try {
    await assert.rejects(pausedWorkspaceProjectList, notFoundError);
    assert.deepEqual(pausedWorkspaceBarrier.rawRows, []);
  } finally {
    await db.prepare(
      "UPDATE workspaces SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
    ).bind(raceWorkspace.id).run();
  }

  const raceDeletedIssue = await jsonRequest("/api/v1/workspaces/auth-races/projects/RA/issues", {
    body: { title: "Race tombstone" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-tombstone" }),
    method: "POST",
  });
  await jsonRequest(
    `/api/v1/issues/${raceDeletedIssue.body.resource.identifier}?expected_version=${raceDeletedIssue.body.resource.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  const downgradedRecoveryAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const downgradedRecoveryBarrier = issueRecoveryScopeBarrierDatabase(db, 1);
  const downgradedRecoveryList = listIssuesService(
    downgradedRecoveryBarrier.db,
    downgradedRecoveryAuth,
    new URL("https://kanban.example.test/api/v1/issues?deleted=only&project=auth-races%2FRA"),
    Date.now(),
  );
  await downgradedRecoveryBarrier.reached;
  await db.prepare(
    "UPDATE project_grants SET role = 'reader', version = version + 1 WHERE id = ?1",
  ).bind(raceGrantA).run();
  downgradedRecoveryBarrier.release();
  try {
    await assert.rejects(
      downgradedRecoveryList,
      cursorScopeMismatchError,
    );
    assert.deepEqual(downgradedRecoveryBarrier.rawRows, []);
  } finally {
    await db.prepare(
      "UPDATE project_grants SET role = 'writer', version = version + 1 WHERE id = ?1",
    ).bind(raceGrantA).run();
  }

  const candidateAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const candidateRaceBarrier = issueActiveScopeBarrierDatabase(db);
  const candidateRacedList = listIssueCandidatesService(
    candidateRaceBarrier.db,
    candidateAuth,
    new URL(
      "https://kanban.example.test/api/v1/issues/candidates?assignment=unassigned&project=auth-races%2FRA",
    ),
    Date.now(),
  );
  await candidateRaceBarrier.reached;
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, raceGrantA).run();
  await jsonRequest("/api/v1/workspaces/auth-races/projects/RA/issues", {
    body: { status_key: "todo", title: "Candidate created after Grant revoke" },
    headers: ownerHeaders({ "idempotency-key": "wp05-auth-race-candidate-after-revoke" }),
    method: "POST",
  });
  candidateRaceBarrier.release();
  try {
    await assert.rejects(
      candidateRacedList,
      cursorScopeMismatchError,
    );
    assert.deepEqual(candidateRaceBarrier.rawRows, []);
  } finally {
    await db.prepare(
      `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
         version = version + 1 WHERE id = ?1`,
    ).bind(raceGrantA).run();
  }

  const finalQueryAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const finalQueryBarrier = issueFinalQueryBarrierDatabase(db);
  const expandedAfterQuery = listIssuesService(
    finalQueryBarrier.db,
    finalQueryAuth,
    new URL("https://kanban.example.test/api/v1/issues?project=auth-races%2FRA&limit=1"),
    Date.now(),
  );
  await finalQueryBarrier.reached;
  await db.prepare(
    `INSERT INTO project_grants
      (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
     VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`,
  ).bind(
    raceGrantB,
    ids.writerPrincipal,
    raceProjectB.body.resource.id,
    Date.now(),
    "wp05-auth-race-grant-b",
  ).run();
  finalQueryBarrier.release();
  try {
    await assert.rejects(
      expandedAfterQuery,
      cursorScopeMismatchError,
    );
  } finally {
    await db.prepare(
      `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
         version = version + 1 WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, raceGrantB).run();
  }

  await db.prepare(
    `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
       version = version + 1 WHERE id = ?1`,
  ).bind(raceGrantB).run();
  const continuationSeed = await jsonRequest(
    "/api/v1/issues?project=auth-races%2FRA&limit=1",
    { headers: writerHeaders() },
  );
  assert.equal(continuationSeed.response.status, 200, JSON.stringify(continuationSeed.body));
  assert.equal(continuationSeed.body.has_more, true);
  const continuationAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const continuationBarrier = issueFinalQueryBarrierDatabase(db);
  const shrunkContinuation = listIssuesService(
    continuationBarrier.db,
    continuationAuth,
    new URL(
      `https://kanban.example.test/api/v1/issues?project=auth-races%2FRA&limit=1&cursor=${encodeURIComponent(continuationSeed.body.next_cursor)}`,
    ),
    Date.now(),
  );
  await continuationBarrier.reached;
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, raceGrantB).run();
  continuationBarrier.release();
  await assert.rejects(
    shrunkContinuation,
    cursorScopeMismatchError,
  );

  const duplicateEvents = await db.prepare(
    `SELECT operation_id, COUNT(*) AS count FROM events
     WHERE type IN ('issue.created', 'issue.blocked-reported')
     GROUP BY operation_id HAVING COUNT(*) > 1`,
  ).all();
  assert.deepEqual(duplicateEvents.results, []);
  const persistedBulkEndpoints = JSON.stringify(server.getLogs());
  assert.equal(persistedBulkEndpoints.includes("assign-next"), false);
});
