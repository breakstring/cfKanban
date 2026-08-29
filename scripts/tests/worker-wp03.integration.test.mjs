import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const participantToken = `cfk_v1_member_${"B".repeat(43)}`;
const ownerSessionToken = "S".repeat(43);
const csrfToken = "C".repeat(43);
const ids = {
  instance: "10000000-0000-4000-8000-000000000001",
  ownerCredential: "10000000-0000-4000-8000-000000000002",
  ownerPrincipal: "10000000-0000-4000-8000-000000000003",
  participantCredential: "10000000-0000-4000-8000-000000000004",
  participantGrant: "10000000-0000-4000-8000-000000000005",
  participantPrincipal: "10000000-0000-4000-8000-000000000006",
  bootstrapOperation: "10000000-0000-4000-8000-000000000007",
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

before(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  ({ DB: db } = await worker.getEnv());
});

after(async () => {
  await server.close();
});

test("WP-03 bootstraps one Owner without exposing its secret", async () => {
  const input = {
    instanceId: ids.instance,
    operationId: ids.bootstrapOperation,
    ownerCredentialId: ids.ownerCredential,
    ownerCredentialToken: ownerToken,
    ownerDisplayName: "Deployment Owner",
    ownerPrincipalId: ids.ownerPrincipal,
    preferredApiOrigin: "https://kanban.example.test",
  };
  const created = await bootstrapInstance(db, input);
  assert.equal(created.recovered, false);
  assert.equal(created.ownerPrincipalId, ids.ownerPrincipal);
  assert.doesNotMatch(JSON.stringify(created), new RegExp(ownerToken));

  const recovered = await bootstrapInstance(db, input);
  assert.equal(recovered.recovered, true);
  await assert.rejects(
    bootstrapInstance(db, {
      ...input,
      instanceId: "20000000-0000-4000-8000-000000000001",
      operationId: "20000000-0000-4000-8000-000000000002",
    }),
    (error) => error.code === "INSTANCE_ALREADY_INITIALIZED",
  );
});

test("WP-03 serves discovery, identity, containers, statuses, tombstones, and origin CAS", async () => {
  const discovery = await jsonRequest("/.well-known/cfkanban-instance.json", {
    headers: { "x-forwarded-host": "evil.example" },
  });
  assert.equal(discovery.response.status, 200);
  assert.equal(discovery.response.headers.get("cache-control"), "no-store");
  assert.equal(discovery.body.instance_id, ids.instance);
  assert.notEqual(discovery.body.observed_origin, "https://evil.example");

  const meta = await jsonRequest("/api/v1/meta", { headers: ownerHeaders() });
  assert.equal(meta.response.status, 200);
  assert.equal(meta.body.principal.is_owner, true);
  assert.equal(meta.body.visible_scope.project_count, 0);

  const me = await jsonRequest("/api/v1/me", { headers: ownerHeaders() });
  assert.equal(me.body.display_name, "Deployment Owner");
  const renamedMe = await jsonRequest("/api/v1/me", {
    body: { display_name: "Owner Renamed", expected_version: me.body.version },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(renamedMe.response.status, 200);
  assertWriteResult(renamedMe.body);
  assert.equal(renamedMe.body.resource.display_name, "Owner Renamed");

  const createWorkspaceRequest = {
    body: { display_name: "Engineering", key: "engineering" },
    headers: ownerHeaders({ "idempotency-key": "wp03-create-workspace" }),
    method: "POST",
  };
  const createdWorkspace = await jsonRequest("/api/v1/workspaces", createWorkspaceRequest);
  assert.equal(createdWorkspace.response.status, 200);
  assertWriteResult(createdWorkspace.body);
  assert.equal(createdWorkspace.body.resource.key, "engineering");
  const replayedWorkspace = await jsonRequest("/api/v1/workspaces", createWorkspaceRequest);
  assert.equal(replayedWorkspace.body.resource.id, createdWorkspace.body.resource.id);
  assertWriteResult(replayedWorkspace.body, true);
  await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Operations", key: "operations" },
    headers: ownerHeaders({ "idempotency-key": "wp03-create-second-workspace" }),
    method: "POST",
  });
  const firstWorkspacePage = await jsonRequest("/api/v1/workspaces?limit=1", {
    headers: ownerHeaders(),
  });
  assert.equal(firstWorkspacePage.body.items.length, 1);
  assert.equal(firstWorkspacePage.body.has_more, true);
  assert.equal(typeof firstWorkspacePage.body.next_cursor, "string");
  const secondWorkspacePage = await jsonRequest(
    `/api/v1/workspaces?limit=1&cursor=${encodeURIComponent(firstWorkspacePage.body.next_cursor)}`,
    { headers: ownerHeaders() },
  );
  assert.equal(secondWorkspacePage.body.items.length, 1);
  assert.notEqual(secondWorkspacePage.body.items[0].id, firstWorkspacePage.body.items[0].id);

  const unknownField = await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Bad", key: "bad-key", typo: true },
    headers: ownerHeaders({ "idempotency-key": "wp03-unknown-field" }),
    method: "POST",
  });
  assert.equal(unknownField.response.status, 400);
  assert.equal(unknownField.body.code, "VALIDATION_ERROR");

  const staleWorkspace = await jsonRequest("/api/v1/workspaces/engineering", {
    body: { display_name: "Stale", expected_version: 99 },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(staleWorkspace.response.status, 409);
  assert.equal(staleWorkspace.body.code, "VERSION_CONFLICT");

  const updatedWorkspace = await jsonRequest("/api/v1/workspaces/engineering", {
    body: { display_name: "Engineering Team", expected_version: 1 },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(updatedWorkspace.body.resource.version, 2);

  const createdProject = await jsonRequest("/api/v1/workspaces/engineering/projects", {
    body: { context: "Trusted project context only.", display_name: "Core", key: "CORE" },
    headers: ownerHeaders({ "idempotency-key": "wp03-create-project" }),
    method: "POST",
  });
  assert.equal(createdProject.response.status, 200);
  assertWriteResult(createdProject.body);
  assert.equal(createdProject.body.resource.workspace_key, "engineering");
  const projectId = createdProject.body.resource.id;

  const statuses = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/statuses", {
    headers: ownerHeaders(),
  });
  assert.deepEqual(statuses.body.items.map((status) => status.key), [
    "backlog",
    "todo",
    "in_progress",
    "done",
    "canceled",
  ]);
  assert.deepEqual(statuses.body.items.map((status) => status.position), [1, 2, 3, 4, 5]);

  const renamedStatus = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE/statuses/done", {
    body: { display_name: "Shipped", expected_version: 1 },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(renamedStatus.response.status, 200);
  assert.equal(renamedStatus.body.resource.key, "done");
  assert.match(renamedStatus.body.resource.id, /^[0-9a-f-]{36}$/i);
  assert.equal(renamedStatus.body.resource.version, 2);

  const updatedProject = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE", {
    body: { context: null, display_name: "Core Board", expected_version: 2 },
    headers: ownerHeaders(),
    method: "PATCH",
  });
  assert.equal(updatedProject.body.resource.version, 3);
  assert.equal(updatedProject.body.resource.context, null);

  const participantDigest = await sha256Hex(participantToken);
  await db.batch([
    db.prepare(
      `INSERT INTO principals (id, display_name, created_at, updated_at)
       VALUES (?1, 'Participant', ?2, ?2)`,
    ).bind(ids.participantPrincipal, Date.now()),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
       VALUES (?1, ?2, 'member', ?3, ?4, 'wp03-seed-participant-credential')`,
    ).bind(ids.participantCredential, ids.participantPrincipal, participantDigest, Date.now()),
    db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'reader', ?4, ?4, 'wp03-seed-participant-grant')`,
    ).bind(ids.participantGrant, ids.participantPrincipal, projectId, Date.now()),
  ]);
  const participantProject = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE", {
    headers: participantHeaders(),
  });
  assert.equal(participantProject.response.status, 200);
  const participantCreate = await jsonRequest("/api/v1/workspaces", {
    body: { display_name: "Forbidden", key: "forbidden" },
    headers: participantHeaders({ "idempotency-key": "wp03-participant-create" }),
    method: "POST",
  });
  assert.equal(participantCreate.response.status, 403);
  const participantTombstones = await jsonRequest("/api/v1/workspaces?deleted=only", {
    headers: participantHeaders(),
  });
  assert.equal(participantTombstones.response.status, 403);
  const mismatchedCursor = await jsonRequest(
    `/api/v1/workspaces?limit=1&cursor=${encodeURIComponent(firstWorkspacePage.body.next_cursor)}`,
    { headers: participantHeaders() },
  );
  assert.equal(mismatchedCursor.response.status, 409);
  assert.equal(mismatchedCursor.body.code, "CURSOR_SCOPE_MISMATCH");

  const deletedProject = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE?expected_version=3",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(deletedProject.body.resource.deleted_at !== null, true);
  assert.equal(deletedProject.body.resource.version, 4);
  const hiddenProject = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE", {
    headers: ownerHeaders(),
  });
  assert.equal(hiddenProject.response.status, 404);
  const projectTombstones = await jsonRequest("/api/v1/workspaces/engineering/projects?deleted=only", {
    headers: ownerHeaders(),
  });
  assert.equal(projectTombstones.body.items.length, 1);

  const restoredProject = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE/commands/restore",
    {
      body: { expected_version: 4 },
      headers: ownerHeaders({ "idempotency-key": "wp03-restore-project" }),
      method: "POST",
    },
  );
  assert.equal(restoredProject.body.resource.version, 5);
  assert.deepEqual(restoredProject.body.resource.resumed_public_projects.projects, []);

  const deletedWorkspace = await jsonRequest("/api/v1/workspaces/engineering?expected_version=2", {
    headers: ownerHeaders(),
    method: "DELETE",
  });
  assert.equal(deletedWorkspace.body.resource.version, 3);
  const restoredWorkspace = await jsonRequest("/api/v1/workspaces/engineering/commands/restore", {
    body: { expected_version: 3 },
    headers: ownerHeaders({ "idempotency-key": "wp03-restore-workspace" }),
    method: "POST",
  });
  assert.equal(restoredWorkspace.body.resource.version, 4);

  const ownerSessionDigest = await sha256Hex(ownerSessionToken);
  await db.prepare(
    `INSERT INTO web_sessions
      (id, token_digest, principal_id, source_kind, source_id, target_kind,
       target_json, expires_at, created_at)
     VALUES ('wp03-owner-admin-session', ?1, ?2, 'credential', ?3, 'admin',
             '{}', ?4, ?5)`,
  ).bind(
    ownerSessionDigest,
    ids.ownerPrincipal,
    ids.ownerCredential,
    Date.now() + 60_000,
    Date.now(),
  ).run();
  const cookieUpdatedWorkspace = await jsonRequest("/api/v1/workspaces/engineering", {
    body: { display_name: "Engineering via Web", expected_version: 4 },
    headers: {
      cookie: `cfkanban_session=${ownerSessionToken}; cfkanban_csrf=${csrfToken}`,
      origin: discovery.body.observed_origin,
      "x-csrf-token": csrfToken,
    },
    method: "PATCH",
  });
  assert.equal(cookieUpdatedWorkspace.response.status, 200);
  assert.equal(cookieUpdatedWorkspace.body.resource.version, 5);

  const origin = await jsonRequest("/api/v1/admin/instance-origin", { headers: ownerHeaders() });
  assert.equal(origin.body.preferred_api_origin, "https://kanban.example.test");
  const updatedOrigin = await jsonRequest("/api/v1/admin/instance-origin", {
    body: { expected_version: 1, preferred_api_origin: "https://new.example.test" },
    headers: ownerHeaders({ "idempotency-key": "wp03-origin-update" }),
    method: "PUT",
  });
  assert.equal(updatedOrigin.body.resource.preferred_api_origin, "https://new.example.test");
  assert.equal(updatedOrigin.body.resource.version, 2);

  const credential = await db.prepare(
    "SELECT token_digest FROM credentials WHERE id = ?1",
  ).bind(ids.ownerCredential).first();
  assert.match(credential.token_digest, /^[0-9a-f]{64}$/);
  assert.notEqual(credential.token_digest, ownerToken);
  const persistedResponses = await db.prepare(
    "SELECT response_json FROM idempotency_records WHERE response_json IS NOT NULL",
  ).all();
  assert.doesNotMatch(JSON.stringify(persistedResponses.results), new RegExp(ownerToken));
  assert.doesNotMatch(JSON.stringify(server.getLogs()), new RegExp(ownerToken));
  assert.doesNotMatch(JSON.stringify(server.getLogs()), new RegExp(ownerSessionToken));

  const counts = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM operation_commits) AS operations,
       (SELECT COUNT(*) FROM events) AS events`,
  ).first();
  assert.equal(counts.operations, counts.events);
  assert.ok(counts.operations >= 10);
});
