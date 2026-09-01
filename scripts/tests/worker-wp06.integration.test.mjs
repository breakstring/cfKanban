import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { createCursorContext, encodeCursor } from "../../apps/worker/src/kernel/cursor.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import {
  createComment as createCommentService,
  deleteComment as deleteCommentService,
} from "../../apps/worker/src/services/comments.ts";
import {
  listAuditEvents as listAuditEventsService,
  listEvents as listEventsService,
} from "../../apps/worker/src/services/events.ts";
import {
  getRelation as getRelationService,
  listIssueRelations as listIssueRelationsService,
} from "../../apps/worker/src/services/relations.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const token = (prefix, character) => `cfk_v1_${prefix}_${character.repeat(43)}`;
const ownerToken = token("owner", "A");
const dualWriterToken = token("dual", "D");
const scopedWriterToken = token("scoped", "S");
const dualReaderToken = token("reader", "R");

const ids = {
  bootstrapOperation: "60000000-0000-4000-8000-000000000004",
  instance: "60000000-0000-4000-8000-000000000001",
  ownerCredential: "60000000-0000-4000-8000-000000000002",
  ownerPrincipal: "60000000-0000-4000-8000-000000000003",
  dualCredential: "60000000-0000-4000-8000-000000000005",
  dualPrincipal: "60000000-0000-4000-8000-000000000006",
  scopedCredential: "60000000-0000-4000-8000-000000000007",
  scopedPrincipal: "60000000-0000-4000-8000-000000000008",
  readerCredential: "60000000-0000-4000-8000-000000000009",
  readerPrincipal: "60000000-0000-4000-8000-000000000010",
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

function readerHeaders(extra = {}) {
  return { authorization: `Bearer ${dualReaderToken}`, ...extra };
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

function commentReadbackBarrierDatabase(database) {
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
            sql.includes("SELECT payload_json") && sql.includes("subject_type = 'comment'"),
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

function commentQuotaPreviewFailureDatabase(database) {
  let failureCount = 0;
  const wrapStatement = (statement, matches) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), matches);
      }
      if (property === "first" && matches) {
        return async () => {
          failureCount += 1;
          throw new Error("injected post-commit quota preview failure");
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
            sql.includes("project.comment_limit") && sql.includes("usage.active_comment_count"),
          );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    get failureCount() {
      return failureCount;
    },
  };
}

function eventScopeBarrierDatabase(database) {
  let paused = false;
  let rawEventRows = null;
  let releaseRead;
  let signalReached;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const wrapStatement = (statement, sql) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), sql);
      }
      if (property === "all") {
        return async (...args) => {
          const result = await target.all(...args);
          if (sql.includes("candidate_events AS") && sql.includes("current_visible_projects")) {
            rawEventRows = result.results;
          }
          if (!paused && sql.includes("FROM project_grants AS pg")
              && sql.includes("ORDER BY w.key, p.key")) {
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
          return (sql) => wrapStatement(target.prepare(sql), sql);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    reached,
    get rawEventRows() {
      return rawEventRows;
    },
    release() {
      releaseRead();
    },
  };
}

function relationScopeBarrierDatabase(database) {
  let matchingReads = 0;
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
          matchingReads += 1;
          if (matchingReads === 2) {
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
            sql.includes("FROM project_grants AS pg") && sql.includes("ORDER BY w.key, p.key"),
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

function finalQueryBarrierDatabase(database, predicate) {
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
          return (sql) => wrapStatement(target.prepare(sql), predicate(sql));
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

function queryExecutionBarrierDatabase(database, predicate) {
  let paused = false;
  let rawRows = null;
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
          if (!paused) {
            paused = true;
            signalReached();
            await released;
          }
          const result = await target.all(...args);
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
          return (sql) => wrapStatement(target.prepare(sql), predicate(sql));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    reached,
    get rawRows() {
      return rawRows;
    },
    release() {
      releaseRead();
    },
  };
}

function relationDetailBarrierDatabase(database) {
  let releaseRead;
  let signalReached;
  let scopeRead = false;
  const reached = new Promise((resolve) => {
    signalReached = resolve;
  });
  const released = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const wrapStatement = (statement, sql) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(target.bind(...values), sql);
      }
      if (property === "all" && sql.includes("FROM project_grants AS pg")
          && sql.includes("ORDER BY w.key, p.key")) {
        return async (...args) => {
          const result = await target.all(...args);
          if (!scopeRead) {
            scopeRead = true;
            signalReached();
          }
          return result;
        };
      }
      if (property === "first" && sql.includes("WHERE relation.id = ?1")
          && sql.includes("FROM issue_relations relation")) {
        return async (...args) => {
          await released;
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
          return (sql) => wrapStatement(target.prepare(sql), sql);
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

async function seedPrincipal({ credentialId, principalId, tokenValue, grants, role = "writer" }) {
  const now = Date.now();
  await db.batch([
    db.prepare(
      "INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
    ).bind(
      principalId,
      principalId === ids.dualPrincipal
        ? "Dual Writer"
        : principalId === ids.readerPrincipal ? "Dual Reader" : "Scoped Writer",
      now,
    ),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      credentialId,
      principalId,
      principalId === ids.dualPrincipal ? "dual" : principalId === ids.readerPrincipal ? "reader" : "scoped",
      await sha256Hex(tokenValue),
      now,
      `wp06-${principalId}-credential`,
    ),
    ...grants.map(({ grantId, projectId }) => db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
    ).bind(grantId, principalId, projectId, role, now, `wp06-${grantId}-grant`)),
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
  await seedPrincipal({
    credentialId: ids.readerCredential,
    grants: [
      { grantId: "60000000-0000-4000-8000-000000000014", projectId: projectAId },
      { grantId: "60000000-0000-4000-8000-000000000015", projectId: projectBId },
    ],
    principalId: ids.readerPrincipal,
    role: "reader",
    tokenValue: dualReaderToken,
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

  const addLabelExpectedVersion = issueAVersion;
  const addLabel = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/add-label`, {
    body: { expected_version: addLabelExpectedVersion, label_id: labelId },
    headers: dualHeaders({ "idempotency-key": "wp06-label-add" }),
    method: "POST",
  });
  assert.equal(addLabel.response.status, 200, JSON.stringify(addLabel.body));
  issueAVersion = addLabel.body.resource.version;
  assert.deepEqual(addLabel.body.resource.labels.map((item) => item.id), [labelId]);

  const removeLabelExpectedVersion = issueAVersion;
  const removeLabel = await jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/remove-label`, {
    body: { expected_version: removeLabelExpectedVersion, label_id: labelId },
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
  const hiddenDeletedLabel = await jsonRequest(`/api/v1/labels/${labelId}`, {
    headers: dualHeaders(),
  });
  assert.equal(hiddenDeletedLabel.response.status, 404);
  const readerDeletedLabel = await jsonRequest(`/api/v1/labels/${labelId}?deleted=only`, {
    headers: readerHeaders(),
  });
  assert.equal(readerDeletedLabel.response.status, 403);
  const deletedLabelList = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/APP/labels?deleted=only",
    { headers: dualHeaders() },
  );
  assert.deepEqual(deletedLabelList.body.items.map((item) => item.id), [labelId]);
  const restoredLabel = await jsonRequest(`/api/v1/labels/${labelId}/commands/restore`, {
    body: { expected_version: 3 },
    headers: dualHeaders({ "idempotency-key": "wp06-label-restore" }),
    method: "POST",
  });
  assert.equal(restoredLabel.response.status, 200, JSON.stringify(restoredLabel.body));
  assert.equal(restoredLabel.body.resource.version, 4);

  const replayTombstonedLabel = await jsonRequest(`/api/v1/labels/${labelId}?expected_version=4`, {
    headers: dualHeaders(),
    method: "DELETE",
  });
  assert.equal(replayTombstonedLabel.response.status, 200, JSON.stringify(replayTombstonedLabel.body));
  const replayedAddAfterLabelDelete = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/commands/add-label`,
    {
      body: { expected_version: addLabelExpectedVersion, label_id: labelId },
      headers: dualHeaders({ "idempotency-key": "wp06-label-add" }),
      method: "POST",
    },
  );
  assert.equal(replayedAddAfterLabelDelete.response.status, 200, JSON.stringify(replayedAddAfterLabelDelete.body));
  assertWriteResult(replayedAddAfterLabelDelete.body, true);
  const replayedRemoveAfterLabelDelete = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/commands/remove-label`,
    {
      body: { expected_version: removeLabelExpectedVersion, label_id: labelId },
      headers: dualHeaders({ "idempotency-key": "wp06-label-remove" }),
      method: "POST",
    },
  );
  assert.equal(replayedRemoveAfterLabelDelete.response.status, 200, JSON.stringify(replayedRemoveAfterLabelDelete.body));
  assertWriteResult(replayedRemoveAfterLabelDelete.body, true);
  const restoredReplayLabel = await jsonRequest(`/api/v1/labels/${labelId}/commands/restore`, {
    body: { expected_version: 5 },
    headers: dualHeaders({ "idempotency-key": "wp06-label-restore-after-replay" }),
    method: "POST",
  });
  assert.equal(restoredReplayLabel.response.status, 200, JSON.stringify(restoredReplayLabel.body));
  assert.equal(restoredReplayLabel.body.resource.version, 6);

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

  const snapshotIssue = await createIssue(
    "engineering",
    "APP",
    "Comment snapshot title",
    "wp06-comment-snapshot-issue",
    dualHeaders(),
  );
  const markdownBody = "    indented code\n\ntrailing paragraph\n";
  const markdownComment = await jsonRequest(
    `/api/v1/issues/${snapshotIssue.body.resource.identifier}/comments`,
    {
      body: { body: markdownBody },
      headers: dualHeaders({ "idempotency-key": "wp06-comment-markdown-source" }),
      method: "POST",
    },
  );
  assert.equal(markdownComment.response.status, 200, JSON.stringify(markdownComment.body));
  assert.equal(markdownComment.body.resource.body, markdownBody);

  const commentReadbackBarrier = commentReadbackBarrierDatabase(db);
  const directCommentRequest = new Request(
    `https://kanban.example.test/api/v1/issues/${snapshotIssue.body.resource.identifier}/comments`,
    {
      headers: dualHeaders({ "idempotency-key": "wp06-comment-operation-reference" }),
      method: "POST",
    },
  );
  const directCommentAuth = await authenticateBearer(db, `Bearer ${dualWriterToken}`);
  const directComment = createCommentService(
    commentReadbackBarrier.db,
    directCommentRequest,
    directCommentAuth,
    snapshotIssue.body.resource.identifier,
    "Operation-bound reference",
    undefined,
    Date.now(),
  );
  await commentReadbackBarrier.reached;
  const renamedSnapshotIssue = await jsonRequest(
    `/api/v1/issues/${snapshotIssue.body.resource.identifier}`,
    {
      body: { expected_version: 1, title: "Changed after Comment commit" },
      headers: dualHeaders(),
      method: "PATCH",
    },
  );
  commentReadbackBarrier.release();
  assert.equal(renamedSnapshotIssue.response.status, 200, JSON.stringify(renamedSnapshotIssue.body));
  const directCommentResult = await directComment;
  assert.equal(directCommentResult.resource.issue.title, "Comment snapshot title");
  assert.equal(directCommentResult.resource.issue.version, 1);
  const currentSnapshotIssue = await jsonRequest(
    `/api/v1/issues/${snapshotIssue.body.resource.identifier}`,
    { headers: dualHeaders() },
  );
  assert.equal(currentSnapshotIssue.body.title, "Changed after Comment commit");
  assert.equal(currentSnapshotIssue.body.version, 2);

  const quotaPreviewFailure = commentQuotaPreviewFailureDatabase(db);
  const deletedCommentBody = await deleteCommentService(
    quotaPreviewFailure.db,
    directCommentAuth,
    commentId,
    1,
    Date.now(),
  );
  assert.equal(quotaPreviewFailure.failureCount, 1);
  assert.equal(deletedCommentBody.resource.body, null);
  assert.equal(
    deletedCommentBody.resource.unavailability_reason.code,
    "PROJECT_COMMENT_QUOTA_UNAVAILABLE",
  );
  assert.deepEqual(deletedCommentBody.resource.allowed_actions, ["read"]);
  const activeCommentsAfterDelete = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/comments`,
    { headers: dualHeaders() },
  );
  assert.equal(activeCommentsAfterDelete.body.items.some((item) => item.id === commentId), false);
  const hiddenDeletedComment = await jsonRequest(`/api/v1/comments/${commentId}`, {
    headers: dualHeaders(),
  });
  assert.equal(hiddenDeletedComment.response.status, 404);
  const readerDeletedComment = await jsonRequest(`/api/v1/comments/${commentId}?deleted=only`, {
    headers: readerHeaders(),
  });
  assert.equal(readerDeletedComment.response.status, 403);
  const deletedCommentList = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/comments?deleted=only`,
    { headers: dualHeaders() },
  );
  assert.deepEqual(deletedCommentList.body.items.map((item) => item.id), [commentId]);
  const quotaPreviewAt = Date.now();
  await db.batch([
    db.prepare("UPDATE projects SET comment_limit = 1 WHERE id = ?1").bind(projectAId),
    db.prepare(
      `INSERT INTO public_join_policies
        (project_id, workspace_id, project_key, public_id, public_summary, enabled_at, enabled_by_principal_id,
         version, created_at, updated_at, last_operation_id)
       VALUES (?1, (SELECT workspace_id FROM projects WHERE id = ?1),
               (SELECT key FROM projects WHERE id = ?1),
               'wp06-comment-preview', 'Comment quota preview', ?2, ?3, 1, ?2, ?2, 'wp06-preview-policy')`,
    ).bind(projectAId, quotaPreviewAt, ids.ownerPrincipal),
    db.prepare(
      `INSERT INTO project_usage
        (project_id, active_issue_count, active_comment_count, active_principal_count,
         updated_at, last_operation_id)
       VALUES (?1, 0, 1, 0, ?2, 'wp06-preview-usage')`,
    ).bind(projectAId, quotaPreviewAt),
  ]);
  const quotaBlockedComment = await jsonRequest(`/api/v1/comments/${commentId}?deleted=only`, {
    headers: dualHeaders(),
  });
  assert.equal(quotaBlockedComment.response.status, 200, JSON.stringify(quotaBlockedComment.body));
  assert.equal(quotaBlockedComment.body.restorable, false);
  assert.deepEqual(quotaBlockedComment.body.allowed_actions, ["read"]);
  assert.equal(quotaBlockedComment.body.unavailability_reason.code, "PROJECT_COMMENT_LIMIT_REACHED");
  await db.batch([
    db.prepare("DELETE FROM project_usage WHERE project_id = ?1").bind(projectAId),
    db.prepare("DELETE FROM public_join_policies WHERE project_id = ?1").bind(projectAId),
    db.prepare("UPDATE projects SET comment_limit = NULL WHERE id = ?1").bind(projectAId),
  ]);
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
  const projectFilteredRelationEvents = await jsonRequest(
    "/api/v1/events?project=engineering%2FAPP&limit=100",
    { headers: dualHeaders() },
  );
  assert.equal(projectFilteredRelationEvents.response.status, 200, JSON.stringify(projectFilteredRelationEvents.body));
  assert.equal(
    projectFilteredRelationEvents.body.items.filter((event) => event.subject.id === relationId).length,
    1,
  );

  const eventScopeBarrier = eventScopeBarrierDatabase(db);
  const eventScopeAuth = await authenticateBearer(db, `Bearer ${dualWriterToken}`);
  const racedEvents = listEventsService(
    eventScopeBarrier.db,
    eventScopeAuth,
    new URL("https://kanban.example.test/api/v1/events?limit=100"),
    Date.now(),
  );
  await eventScopeBarrier.reached;
  await db.prepare(
    "UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, "60000000-0000-4000-8000-000000000012").run();
  await db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, workspace_id, project_id,
       subject_type, subject_id, payload_json, created_at)
     VALUES (?1, 'domain', 'issue.after-revoke', ?2, 0, ?3,
             ?4, 'project_grant', ?5, ?6, 'issue', ?7, '{}', ?8)`,
  ).bind(
    "60000000-0000-4000-8000-000000000103",
    "60000000-0000-4000-8000-000000000104",
    ids.dualPrincipal,
    ids.dualCredential,
    engineering.body.resource.id,
    projectBId,
    issueB.body.resource.id,
    Date.now(),
  ).run();
  eventScopeBarrier.release();
  await assert.rejects(
    racedEvents,
    cursorScopeMismatchError,
  );
  assert.equal(
    eventScopeBarrier.rawEventRows.some((row) => row.project_id === projectBId
      || row.relation_other_project_id === projectBId),
    false,
    "the final Event SQL must filter the revoked Project before response-level scope checks",
  );
  await db.prepare(
    "UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL WHERE id = ?1",
  ).bind("60000000-0000-4000-8000-000000000012").run();

  const scopedProjectBGrant = "60000000-0000-4000-8000-000000000121";
  const postQueryEventBarrier = finalQueryBarrierDatabase(
    db,
    (sql) => sql.includes("candidate_events AS") && sql.includes("current_visible_projects"),
  );
  const postQueryEventAuth = await authenticateBearer(db, `Bearer ${scopedWriterToken}`);
  const postQueryScopeExpansion = listEventsService(
    postQueryEventBarrier.db,
    postQueryEventAuth,
    new URL("https://kanban.example.test/api/v1/events?project=engineering%2FAPP&limit=1"),
    Date.now(),
  );
  await postQueryEventBarrier.reached;
  await db.prepare(
    `INSERT INTO project_grants
      (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
     VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`,
  ).bind(
    scopedProjectBGrant,
    ids.scopedPrincipal,
    projectBId,
    Date.now(),
    "wp06-scoped-project-b-grant",
  ).run();
  postQueryEventBarrier.release();
  try {
    await assert.rejects(
      postQueryScopeExpansion,
      cursorScopeMismatchError,
    );
  } finally {
    await db.prepare(
      `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
         version = version + 1 WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, scopedProjectBGrant).run();
  }

  const auditBarrier = queryExecutionBarrierDatabase(
    db,
    (sql) => sql.includes("WHERE event.sequence > ?1") && sql.includes("event.stream"),
  );
  const auditAuth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  const revokedOwnerAudit = listAuditEventsService(
    auditBarrier.db,
    auditAuth,
    new URL("https://kanban.example.test/api/v1/admin/audit-events?limit=1"),
    Date.now(),
  );
  await auditBarrier.reached;
  await db.prepare(
    "UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, ids.ownerCredential).run();
  await db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, subject_type, subject_id, payload_json, created_at)
     VALUES (?1, 'security', 'credential.revoked-after-audit-auth', ?2, 0, ?3,
             NULL, 'deployment_recovery', 'credential', ?4, '{}', ?5)`,
  ).bind(
    "60000000-0000-4000-8000-000000000122",
    "60000000-0000-4000-8000-000000000123",
    ids.ownerPrincipal,
    ids.ownerCredential,
    Date.now(),
  ).run();
  auditBarrier.release();
  try {
    await assert.rejects(revokedOwnerAudit, unauthorizedError);
    assert.deepEqual(
      auditBarrier.rawRows,
      [],
      "the Audit SQL must return no rows after the Owner Credential is revoked",
    );
  } finally {
    await db.prepare(
      "UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL WHERE id = ?1",
    ).bind(ids.ownerCredential).run();
  }

  const auditSessionSourceCredential = "60000000-0000-4000-8000-000000000124";
  const auditSessionId = "60000000-0000-4000-8000-000000000125";
  const auditSessionCreatedAt = Date.now();
  const auditSessionExpiresAt = auditSessionCreatedAt + 8 * 60 * 60 * 1_000;
  await db.batch([
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
       VALUES (?1, ?2, 'audit-session', ?3, ?4, ?5)`,
    ).bind(
      auditSessionSourceCredential,
      ids.ownerPrincipal,
      await sha256Hex(token("audit-session", "Q")),
      Date.now(),
      "wp06-audit-session-source-credential",
    ),
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id, target_kind,
         target_json, expires_at, created_at)
       VALUES (?1, ?2, ?3, 'credential', ?4, 'admin', ?5, ?6, ?7)`,
    ).bind(
      auditSessionId,
      await sha256Hex("wp06-audit-session-cookie"),
      ids.ownerPrincipal,
      auditSessionSourceCredential,
      JSON.stringify({ entry_path: "/app/admin", kind: "admin", section: "audit" }),
      auditSessionExpiresAt,
      auditSessionCreatedAt,
    ),
  ]);
  const auditSessionAuth = {
    displayName: "Deployment Owner",
    isOwner: true,
    kind: "cookie",
    principalId: ids.ownerPrincipal,
    principalVersion: 1,
    sessionExpiresAt: auditSessionExpiresAt,
    sessionId: auditSessionId,
    sourceId: auditSessionSourceCredential,
    sourceKind: "credential",
    target: {},
    targetKind: "admin",
  };
  const revokedSessionBarrier = queryExecutionBarrierDatabase(
    db,
    (sql) => sql.includes("WHERE event.sequence > ?1") && sql.includes("auth_session"),
  );
  const revokedSessionAudit = listAuditEventsService(
    revokedSessionBarrier.db,
    auditSessionAuth,
    new URL("https://kanban.example.test/api/v1/admin/audit-events?limit=1"),
    Date.now(),
  );
  await revokedSessionBarrier.reached;
  await db.prepare(
    "UPDATE web_sessions SET revoked_at = ?1 WHERE id = ?2",
  ).bind(Date.now(), auditSessionId).run();
  await db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       authorized_via, subject_type, subject_id, payload_json, created_at)
     VALUES (?1, 'security', 'web-session.revoked-after-audit-auth', ?2, 0, ?3,
             'deployment_recovery', 'web_session', ?4, '{}', ?5)`,
  ).bind(
    "60000000-0000-4000-8000-000000000126",
    "60000000-0000-4000-8000-000000000127",
    ids.ownerPrincipal,
    auditSessionId,
    Date.now(),
  ).run();
  revokedSessionBarrier.release();
  try {
    await assert.rejects(revokedSessionAudit, unauthorizedError);
    assert.deepEqual(
      revokedSessionBarrier.rawRows,
      [],
      "the Audit SQL must return no rows after the Web Session is revoked",
    );
  } finally {
    await db.prepare("UPDATE web_sessions SET revoked_at = NULL WHERE id = ?1")
      .bind(auditSessionId).run();
  }

  const revokedSourceBarrier = queryExecutionBarrierDatabase(
    db,
    (sql) => sql.includes("WHERE event.sequence > ?1") && sql.includes("auth_source_credential"),
  );
  const revokedSourceAudit = listAuditEventsService(
    revokedSourceBarrier.db,
    auditSessionAuth,
    new URL("https://kanban.example.test/api/v1/admin/audit-events?limit=1"),
    Date.now(),
  );
  await revokedSourceBarrier.reached;
  await db.prepare(
    "UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, auditSessionSourceCredential).run();
  await db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       authorized_via, subject_type, subject_id, payload_json, created_at)
     VALUES (?1, 'security', 'session-source.revoked-after-audit-auth', ?2, 0, ?3,
             'deployment_recovery', 'credential', ?4, '{}', ?5)`,
  ).bind(
    "60000000-0000-4000-8000-000000000128",
    "60000000-0000-4000-8000-000000000129",
    ids.ownerPrincipal,
    auditSessionSourceCredential,
    Date.now(),
  ).run();
  revokedSourceBarrier.release();
  await assert.rejects(revokedSourceAudit, unauthorizedError);
  assert.deepEqual(
    revokedSourceBarrier.rawRows,
    [],
    "the Audit SQL must return no rows after the Session source Credential is revoked",
  );
  await db.prepare(
    "UPDATE credentials SET revoked_at = NULL, revoked_by_principal_id = NULL WHERE id = ?1",
  ).bind(auditSessionSourceCredential).run();

  const auditExpiryStartedAt = auditSessionCreatedAt + 1;
  const expiredSessionBarrier = queryExecutionBarrierDatabase(
    db,
    (sql) => sql.includes("WHERE event.sequence > ?1") && sql.includes("auth_session.expires_at"),
  );
  const expiredSessionAudit = listAuditEventsService(
    expiredSessionBarrier.db,
    auditSessionAuth,
    new URL("https://kanban.example.test/api/v1/admin/audit-events?limit=1"),
    auditExpiryStartedAt,
  );
  await expiredSessionBarrier.reached;
  await db.prepare("UPDATE web_sessions SET expires_at = ?1 WHERE id = ?2")
    .bind(auditExpiryStartedAt, auditSessionId).run();
  expiredSessionBarrier.release();
  try {
    await assert.rejects(expiredSessionAudit, unauthorizedError);
    assert.deepEqual(
      expiredSessionBarrier.rawRows,
      [],
      "the Audit SQL must return no rows when the Web Session expires during the request",
    );
  } finally {
    await db.prepare("UPDATE web_sessions SET expires_at = ?1 WHERE id = ?2")
      .bind(auditSessionExpiresAt, auditSessionId).run();
  }

  const auditPasskeyId = "60000000-0000-4000-8000-000000000130";
  const auditPasskeySessionId = "60000000-0000-4000-8000-000000000131";
  const auditPasskeySessionExpiresAt = Date.now() + 8 * 60 * 60 * 1_000;
  await db.batch([
    db.prepare(
      `INSERT INTO web_authenticators
        (id, principal_id, credential_id, public_key_cose, algorithm, user_handle,
         backup_eligible, backup_state, rp_id, created_at, created_operation_id)
       VALUES (?1, ?2, ?3, ?4, -7, ?2, 0, 0, 'kanban.example.test', ?5, ?6)`,
    ).bind(
      auditPasskeyId,
      ids.ownerPrincipal,
      "YXVkaXQtcGFzc2tleQ",
      "pQECAyYgASFYIA",
      Date.now(),
      "wp06-audit-source-passkey",
    ),
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id, target_kind,
         target_json, expires_at, created_at)
       VALUES (?1, ?2, ?3, 'web_authenticator', ?4, 'admin', ?5, ?6, ?7)`,
    ).bind(
      auditPasskeySessionId,
      await sha256Hex("wp06-audit-passkey-session-cookie"),
      ids.ownerPrincipal,
      auditPasskeyId,
      JSON.stringify({ entry_path: "/app/admin", kind: "admin", section: "audit" }),
      auditPasskeySessionExpiresAt,
      Date.now(),
    ),
  ]);
  const auditPasskeySessionAuth = {
    ...auditSessionAuth,
    sessionExpiresAt: auditPasskeySessionExpiresAt,
    sessionId: auditPasskeySessionId,
    sourceId: auditPasskeyId,
    sourceKind: "web_authenticator",
  };
  const revokedPasskeyBarrier = queryExecutionBarrierDatabase(
    db,
    (sql) => sql.includes("WHERE event.sequence > ?1") && sql.includes("auth_source_passkey"),
  );
  const revokedPasskeyAudit = listAuditEventsService(
    revokedPasskeyBarrier.db,
    auditPasskeySessionAuth,
    new URL("https://kanban.example.test/api/v1/admin/audit-events?limit=1"),
    Date.now(),
  );
  await revokedPasskeyBarrier.reached;
  await db.prepare(
    `UPDATE web_authenticators
     SET revoked_at = ?1, revoked_by_principal_id = ?2, version = version + 1
     WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, auditPasskeyId).run();
  revokedPasskeyBarrier.release();
  await assert.rejects(revokedPasskeyAudit, unauthorizedError);
  assert.deepEqual(
    revokedPasskeyBarrier.rawRows,
    [],
    "the Audit SQL must return no rows after the Session source Passkey is revoked",
  );

  const hiddenTailBaseline = await jsonRequest(
    `/api/v1/events?after=${encodeURIComponent(scopedEvents.body.next_cursor)}&limit=1`,
    { headers: scopedHeaders() },
  );
  assert.equal(hiddenTailBaseline.response.status, 200, JSON.stringify(hiddenTailBaseline.body));
  assert.deepEqual(hiddenTailBaseline.body.items, []);
  await db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, workspace_id, project_id,
       relation_other_project_id, subject_type, subject_id, payload_json, created_at)
     VALUES (?1, 'domain', 'relation.hidden-tail-probe', ?2, 0, ?3,
             ?4, 'project_grant', ?5, ?6, ?7, 'relation', ?8, '{}', ?9)`,
  ).bind(
    "60000000-0000-4000-8000-000000000101",
    "60000000-0000-4000-8000-000000000102",
    ids.dualPrincipal,
    ids.dualCredential,
    engineering.body.resource.id,
    projectAId,
    projectBId,
    relationId,
    Date.now(),
  ).run();
  const hiddenTail = await jsonRequest(
    `/api/v1/events?after=${encodeURIComponent(scopedEvents.body.next_cursor)}&limit=1`,
    { headers: scopedHeaders() },
  );
  assert.equal(hiddenTail.response.status, 200, JSON.stringify(hiddenTail.body));
  assert.deepEqual(hiddenTail.body, hiddenTailBaseline.body);

  const relationDetailBarrier = relationDetailBarrierDatabase(db);
  const relationDetailAuth = await authenticateBearer(db, `Bearer ${dualWriterToken}`);
  const racedRelationDetail = getRelationService(
    relationDetailBarrier.db,
    relationDetailAuth,
    relationId,
    new URL(`https://kanban.example.test/api/v1/relations/${relationId}?deleted=only`),
    Date.now(),
  );
  await relationDetailBarrier.reached;
  await db.prepare(
    `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, "60000000-0000-4000-8000-000000000012").run();
  await db.prepare(
    `UPDATE issue_relations SET deleted_at = ?1, deleted_by_principal_id = ?2,
       version = version + 1 WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, relationId).run();
  relationDetailBarrier.release();
  try {
    await assert.rejects(racedRelationDetail, notFoundError);
  } finally {
    await db.prepare(
      `UPDATE issue_relations SET deleted_at = NULL, deleted_by_principal_id = NULL,
         version = 1 WHERE id = ?1`,
    ).bind(relationId).run();
    await db.prepare(
      `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
         version = version + 1 WHERE id = ?1`,
    ).bind("60000000-0000-4000-8000-000000000012").run();
  }

  const deletedRelation = await jsonRequest(
    `/api/v1/relations/${relationId}?expected_version=1&source_expected_version=${issueBVersion}&target_expected_version=${issueAVersion}`,
    { headers: dualHeaders(), method: "DELETE" },
  );
  assert.equal(deletedRelation.response.status, 200, JSON.stringify(deletedRelation.body));
  assert.equal(deletedRelation.body.resource.version, 2);
  issueBVersion = deletedRelation.body.resource.source.version;
  issueAVersion = deletedRelation.body.resource.target.version;
  const hiddenDeletedRelation = await jsonRequest(`/api/v1/relations/${relationId}`, {
    headers: dualHeaders(),
  });
  assert.equal(hiddenDeletedRelation.response.status, 404);
  const readerDeletedRelation = await jsonRequest(`/api/v1/relations/${relationId}?deleted=only`, {
    headers: readerHeaders(),
  });
  assert.equal(readerDeletedRelation.response.status, 403);
  const deletedRelationList = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/relations?deleted=only`,
    { headers: dualHeaders() },
  );
  assert.deepEqual(deletedRelationList.body.items.map((item) => item.id), [relationId]);

  const relationPostQueryBarrier = finalQueryBarrierDatabase(
    db,
    (sql) => sql.includes("current_writer_projects") && sql.includes("candidate_relations AS"),
  );
  const relationPostQueryAuth = await authenticateBearer(db, `Bearer ${scopedWriterToken}`);
  const expandedRelationScope = listIssueRelationsService(
    relationPostQueryBarrier.db,
    relationPostQueryAuth,
    issueA.body.resource.identifier,
    new URL(
      `https://kanban.example.test/api/v1/issues/${issueA.body.resource.identifier}/relations?deleted=only&limit=1`,
    ),
    Date.now(),
  );
  await relationPostQueryBarrier.reached;
  await db.prepare(
    `UPDATE project_grants SET revoked_at = NULL, revoked_by_principal_id = NULL,
       version = version + 1 WHERE id = ?1`,
  ).bind(scopedProjectBGrant).run();
  relationPostQueryBarrier.release();
  try {
    await assert.rejects(
      expandedRelationScope,
      cursorScopeMismatchError,
    );
  } finally {
    await db.prepare(
      `UPDATE project_grants SET revoked_at = ?1, revoked_by_principal_id = ?2,
         version = version + 1 WHERE id = ?3`,
    ).bind(Date.now(), ids.ownerPrincipal, scopedProjectBGrant).run();
  }

  const relationScopeBarrier = relationScopeBarrierDatabase(db);
  const relationScopeAuth = await authenticateBearer(db, `Bearer ${dualWriterToken}`);
  const racedDeletedRelations = listIssueRelationsService(
    relationScopeBarrier.db,
    relationScopeAuth,
    issueA.body.resource.identifier,
    new URL(`https://kanban.example.test/api/v1/issues/${issueA.body.resource.identifier}/relations?deleted=only`),
    Date.now(),
  );
  await relationScopeBarrier.reached;
  await db.prepare(
    "UPDATE projects SET deleted_at = ?1, deleted_by_principal_id = ?2 WHERE id = ?3",
  ).bind(Date.now(), ids.ownerPrincipal, projectBId).run();
  relationScopeBarrier.release();
  await assert.rejects(
    racedDeletedRelations,
    cursorScopeMismatchError,
  );
  await db.prepare(
    "UPDATE projects SET deleted_at = NULL, deleted_by_principal_id = NULL WHERE id = ?1",
  )
    .bind(projectBId).run();

  const hiddenRelationBaseline = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/relations?deleted=only&limit=1`,
    { headers: scopedHeaders() },
  );
  assert.equal(hiddenRelationBaseline.response.status, 200, JSON.stringify(hiddenRelationBaseline.body));
  assert.deepEqual(hiddenRelationBaseline.body.items, []);

  const hiddenRelations = [
    { id: "60000000-0000-4000-8000-000000000111", kind: "related" },
    { id: "60000000-0000-4000-8000-000000000112", kind: "duplicate" },
  ];
  const hiddenRelationAt = Date.now();
  await db.batch(hiddenRelations.map(({ id, kind }, index) => db.prepare(
    `INSERT INTO issue_relations
      (id, workspace_id, kind, source_issue_id, target_issue_id,
       source_project_id, target_project_id, version,
       deleted_at, deleted_by_principal_id, created_at, created_by_principal_id,
       created_operation_id, last_operation_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 2, ?8, ?9, ?8, ?9, ?10, ?10)`,
  ).bind(
    id,
    engineering.body.resource.id,
    kind,
    issueA.body.resource.id,
    issueB.body.resource.id,
    projectAId,
    projectBId,
    hiddenRelationAt - index,
    ids.ownerPrincipal,
    `wp06-hidden-relation-${index}`,
  )));
  const hiddenRelationPage = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/relations?deleted=only&limit=1`,
    { headers: scopedHeaders() },
  );
  assert.equal(hiddenRelationPage.response.status, 200, JSON.stringify(hiddenRelationPage.body));
  assert.deepEqual(hiddenRelationPage.body, hiddenRelationBaseline.body);

  await db.prepare(
    "UPDATE project_grants SET role = 'writer' WHERE principal_id = ?1 AND project_id = ?2",
  ).bind(ids.readerPrincipal, projectAId).run();
  const oldWriterScope = await createCursorContext(
    "relations",
    { deleted: "only", issue_id: issueA.body.resource.id },
    [projectAId],
    ids.readerPrincipal,
  );
  const oldWriterCursor = encodeCursor(oldWriterScope, [
    Date.parse(deletedRelation.body.resource.deleted_at),
    relationId,
  ]);
  await db.prepare(
    "UPDATE project_grants SET role = 'writer' WHERE principal_id = ?1 AND project_id = ?2",
  ).bind(ids.readerPrincipal, projectBId).run();
  const expandedWriterScope = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/relations?deleted=only&cursor=${encodeURIComponent(oldWriterCursor)}`,
    { headers: readerHeaders() },
  );
  assert.equal(expandedWriterScope.response.status, 409, JSON.stringify(expandedWriterScope.body));
  assert.equal(expandedWriterScope.body.code, "CURSOR_SCOPE_MISMATCH");
  await db.prepare(
    "UPDATE project_grants SET role = 'reader' WHERE principal_id = ?1",
  ).bind(ids.readerPrincipal).run();

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

  const replayProject = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { display_name: "Replay Scope", key: "REPLAY" },
    headers: ownerHeaders({ "idempotency-key": "wp06-replay-project" }),
    method: "POST",
  });
  assert.equal(replayProject.response.status, 200, JSON.stringify(replayProject.body));
  const replayLabelBody = { color: "#334455", name: "Replay Label" };
  const replayLabel = await jsonRequest("/api/v1/workspaces/engineering/projects/REPLAY/labels", {
    body: replayLabelBody,
    headers: ownerHeaders({ "idempotency-key": "wp06-replay-label-create" }),
    method: "POST",
  });
  assert.equal(replayLabel.response.status, 200, JSON.stringify(replayLabel.body));
  const deletedReplayLabel = await jsonRequest(
    `/api/v1/labels/${replayLabel.body.resource.id}?expected_version=1`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(deletedReplayLabel.response.status, 200, JSON.stringify(deletedReplayLabel.body));
  const pausedReplayProject = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/REPLAY?expected_version=1",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(pausedReplayProject.response.status, 200, JSON.stringify(pausedReplayProject.body));
  const pausedReplayLabelTombstone = await jsonRequest(
    `/api/v1/labels/${replayLabel.body.resource.id}?deleted=only`,
    { headers: ownerHeaders() },
  );
  assert.equal(pausedReplayLabelTombstone.response.status, 200, JSON.stringify(pausedReplayLabelTombstone.body));
  assert.equal(pausedReplayLabelTombstone.body.restorable, false);
  assert.deepEqual(pausedReplayLabelTombstone.body.allowed_actions, ["read"]);
  assert.equal(pausedReplayLabelTombstone.body.parent_status.project, "deleted");
  const replayedLabelAfterProjectDelete = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/REPLAY/labels",
    {
      body: replayLabelBody,
      headers: ownerHeaders({ "idempotency-key": "wp06-replay-label-create" }),
      method: "POST",
    },
  );
  assert.equal(replayedLabelAfterProjectDelete.response.status, 404, JSON.stringify(replayedLabelAfterProjectDelete.body));

  const commentReplayIssue = await createIssue(
    "engineering",
    "APP",
    "Comment replay tombstone",
    "wp06-comment-replay-issue",
    dualHeaders(),
  );
  const commentReplayBody = { body: "Committed before Issue deletion" };
  const commentBeforeIssueDelete = await jsonRequest(
    `/api/v1/issues/${commentReplayIssue.body.resource.identifier}/comments`,
    {
      body: commentReplayBody,
      headers: dualHeaders({ "idempotency-key": "wp06-comment-replay-after-issue-delete" }),
      method: "POST",
    },
  );
  assert.equal(commentBeforeIssueDelete.response.status, 200, JSON.stringify(commentBeforeIssueDelete.body));
  const deletedReplayComment = await jsonRequest(
    `/api/v1/comments/${commentBeforeIssueDelete.body.resource.id}?expected_version=1`,
    { headers: dualHeaders(), method: "DELETE" },
  );
  assert.equal(deletedReplayComment.response.status, 200, JSON.stringify(deletedReplayComment.body));
  const deletedCommentReplayIssue = await jsonRequest(
    `/api/v1/issues/${commentReplayIssue.body.resource.identifier}?expected_version=1`,
    { headers: dualHeaders(), method: "DELETE" },
  );
  assert.equal(deletedCommentReplayIssue.response.status, 200, JSON.stringify(deletedCommentReplayIssue.body));
  const pausedReplayCommentTombstone = await jsonRequest(
    `/api/v1/comments/${commentBeforeIssueDelete.body.resource.id}?deleted=only`,
    { headers: dualHeaders() },
  );
  assert.equal(pausedReplayCommentTombstone.response.status, 200, JSON.stringify(pausedReplayCommentTombstone.body));
  assert.equal(pausedReplayCommentTombstone.body.restorable, false);
  assert.equal(pausedReplayCommentTombstone.body.parent_status.issue, "deleted");
  const replayedCommentAfterIssueDelete = await jsonRequest(
    `/api/v1/issues/${commentReplayIssue.body.resource.identifier}/comments`,
    {
      body: commentReplayBody,
      headers: dualHeaders({ "idempotency-key": "wp06-comment-replay-after-issue-delete" }),
      method: "POST",
    },
  );
  assert.equal(replayedCommentAfterIssueDelete.response.status, 200, JSON.stringify(replayedCommentAfterIssueDelete.body));
  assertWriteResult(replayedCommentAfterIssueDelete.body, true);
  assert.equal(replayedCommentAfterIssueDelete.body.resource.id, commentBeforeIssueDelete.body.resource.id);

  const completeReplayIssue = await createIssue(
    "engineering",
    "APP",
    "Complete replay tombstone",
    "wp06-complete-replay-issue",
    dualHeaders(),
  );
  const completeReplayBody = { expected_version: 1, summary: "Completed before Issue deletion" };
  const completedBeforeIssueDelete = await jsonRequest(
    `/api/v1/issues/${completeReplayIssue.body.resource.identifier}/commands/complete`,
    {
      body: completeReplayBody,
      headers: dualHeaders({ "idempotency-key": "wp06-complete-replay-after-issue-delete" }),
      method: "POST",
    },
  );
  assert.equal(completedBeforeIssueDelete.response.status, 200, JSON.stringify(completedBeforeIssueDelete.body));
  const deletedCompleteReplayIssue = await jsonRequest(
    `/api/v1/issues/${completeReplayIssue.body.resource.identifier}?expected_version=2`,
    { headers: dualHeaders(), method: "DELETE" },
  );
  assert.equal(deletedCompleteReplayIssue.response.status, 200, JSON.stringify(deletedCompleteReplayIssue.body));
  const replayedCompleteAfterIssueDelete = await jsonRequest(
    `/api/v1/issues/${completeReplayIssue.body.resource.identifier}/commands/complete`,
    {
      body: completeReplayBody,
      headers: dualHeaders({ "idempotency-key": "wp06-complete-replay-after-issue-delete" }),
      method: "POST",
    },
  );
  assert.equal(replayedCompleteAfterIssueDelete.response.status, 200, JSON.stringify(replayedCompleteAfterIssueDelete.body));
  assertWriteResult(replayedCompleteAfterIssueDelete.body, true);
  assert.equal(
    replayedCompleteAfterIssueDelete.body.resource.completion_comment_id,
    completedBeforeIssueDelete.body.resource.completion_comment_id,
  );

  const relationReplaySource = await createIssue(
    "engineering",
    "APP",
    "Relation replay source",
    "wp06-relation-replay-source",
    dualHeaders(),
  );
  const relationReplayTarget = await createIssue(
    "engineering",
    "BACK",
    "Relation replay target",
    "wp06-relation-replay-target",
    dualHeaders(),
  );
  const relationReplayBody = {
    kind: "related",
    source_expected_version: 1,
    target_expected_version: 1,
    target_identifier: relationReplayTarget.body.resource.identifier,
  };
  const relationBeforeIssueDelete = await jsonRequest(
    `/api/v1/issues/${relationReplaySource.body.resource.identifier}/relations`,
    {
      body: relationReplayBody,
      headers: dualHeaders({ "idempotency-key": "wp06-relation-replay-after-issue-delete" }),
      method: "POST",
    },
  );
  assert.equal(relationBeforeIssueDelete.response.status, 200, JSON.stringify(relationBeforeIssueDelete.body));
  const deletedReplayRelation = await jsonRequest(
    `/api/v1/relations/${relationBeforeIssueDelete.body.resource.id}`
      + "?expected_version=1&source_expected_version=2&target_expected_version=2",
    { headers: dualHeaders(), method: "DELETE" },
  );
  assert.equal(deletedReplayRelation.response.status, 200, JSON.stringify(deletedReplayRelation.body));
  const deletedRelationReplaySource = await jsonRequest(
    `/api/v1/issues/${relationReplaySource.body.resource.identifier}?expected_version=3`,
    { headers: dualHeaders(), method: "DELETE" },
  );
  assert.equal(deletedRelationReplaySource.response.status, 200, JSON.stringify(deletedRelationReplaySource.body));
  const pausedReplayRelationTombstone = await jsonRequest(
    `/api/v1/relations/${relationBeforeIssueDelete.body.resource.id}?deleted=only`,
    { headers: dualHeaders() },
  );
  assert.equal(pausedReplayRelationTombstone.response.status, 200, JSON.stringify(pausedReplayRelationTombstone.body));
  assert.equal(pausedReplayRelationTombstone.body.restorable, false);
  assert.equal(
    [
      pausedReplayRelationTombstone.body.parent_status.source_issue,
      pausedReplayRelationTombstone.body.parent_status.target_issue,
    ].includes("deleted"),
    true,
  );
  const replayedRelationAfterIssueDelete = await jsonRequest(
    `/api/v1/issues/${relationReplaySource.body.resource.identifier}/relations`,
    {
      body: relationReplayBody,
      headers: dualHeaders({ "idempotency-key": "wp06-relation-replay-after-issue-delete" }),
      method: "POST",
    },
  );
  assert.equal(replayedRelationAfterIssueDelete.response.status, 200, JSON.stringify(replayedRelationAfterIssueDelete.body));
  assertWriteResult(replayedRelationAfterIssueDelete.body, true);
  assert.equal(replayedRelationAfterIssueDelete.body.resource.id, relationBeforeIssueDelete.body.resource.id);

  await db.prepare(
    `UPDATE project_grants
     SET revoked_at = ?1, revoked_by_principal_id = ?2
     WHERE id = ?3`,
  ).bind(Date.now(), ids.ownerPrincipal, "60000000-0000-4000-8000-000000000012").run();
  const filteredCursorAfterRelationGrantRevoke = await jsonRequest(
    `/api/v1/events?project=engineering%2FAPP&after=${encodeURIComponent(projectFilteredRelationEvents.body.next_cursor)}`,
    { headers: dualHeaders() },
  );
  assert.equal(filteredCursorAfterRelationGrantRevoke.response.status, 409);
  assert.equal(filteredCursorAfterRelationGrantRevoke.body.code, "CURSOR_SCOPE_MISMATCH");

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
        (project_id, workspace_id, project_key, public_id, public_summary, enabled_at, enabled_by_principal_id,
         version, created_at, updated_at)
       VALUES (?1, (SELECT workspace_id FROM projects WHERE id = ?1),
               (SELECT key FROM projects WHERE id = ?1),
               ?2, 'Public test project', ?3, ?4, 1, ?3, ?3)`,
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

  const currentProjectA = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/APP",
    { headers: ownerHeaders() },
  );
  const pausedProjectA = await jsonRequest(
    `/api/v1/workspaces/engineering/projects/APP?expected_version=${currentProjectA.body.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(pausedProjectA.response.status, 200, JSON.stringify(pausedProjectA.body));
  const replayRequests = [
    jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/comments`, {
      body: { body: "Initial implementation note" },
      headers: dualHeaders({ "idempotency-key": "wp06-comment-create" }),
      method: "POST",
    }),
    jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/complete`, {
      body: completionBody,
      headers: dualHeaders({ "idempotency-key": "wp06-complete-first" }),
      method: "POST",
    }),
    jsonRequest("/api/v1/workspaces/engineering/projects/APP/labels", {
      body: { color: "#1a2b3c", name: "Security" },
      headers: dualHeaders({ "idempotency-key": "wp06-label-create" }),
      method: "POST",
    }),
    jsonRequest(`/api/v1/issues/${issueA.body.resource.identifier}/commands/add-label`, {
      body: { expected_version: addLabelExpectedVersion, label_id: labelId },
      headers: dualHeaders({ "idempotency-key": "wp06-label-add" }),
      method: "POST",
    }),
    jsonRequest(`/api/v1/issues/${issueB.body.resource.identifier}/relations`, {
      body: {
        kind: "blocks",
        source_expected_version: relation.body.resource.source.version - 1,
        target_expected_version: relation.body.resource.target.version - 1,
        target_identifier: issueA.body.resource.identifier,
      },
      headers: dualHeaders({ "idempotency-key": "wp06-relation-create" }),
      method: "POST",
    }),
  ];
  for (const replay of await Promise.all(replayRequests)) {
    assert.equal(replay.response.status, 404, JSON.stringify(replay.body));
  }

  const restoredProjectA = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/APP/commands/restore",
    {
      body: { expected_version: pausedProjectA.body.resource.version },
      headers: ownerHeaders({ "idempotency-key": "wp06-restore-project-after-replay-auth" }),
      method: "POST",
    },
  );
  assert.equal(restoredProjectA.response.status, 200, JSON.stringify(restoredProjectA.body));
  const currentEngineering = await jsonRequest(
    "/api/v1/workspaces/engineering",
    { headers: ownerHeaders() },
  );
  const pausedEngineering = await jsonRequest(
    `/api/v1/workspaces/engineering?expected_version=${currentEngineering.body.version}`,
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(pausedEngineering.response.status, 200, JSON.stringify(pausedEngineering.body));
  const workspacePausedCommentReplay = await jsonRequest(
    `/api/v1/issues/${issueA.body.resource.identifier}/comments`,
    {
      body: { body: "Initial implementation note" },
      headers: dualHeaders({ "idempotency-key": "wp06-comment-create" }),
      method: "POST",
    },
  );
  assert.equal(
    workspacePausedCommentReplay.response.status,
    404,
    JSON.stringify(workspacePausedCommentReplay.body),
  );
});
