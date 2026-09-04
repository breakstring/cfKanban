import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { authenticateRequest } from "../../apps/worker/src/kernel/auth.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import {
  getProject as getProjectService,
  getWorkspace as getWorkspaceService,
  listProjects as listProjectsService,
  listWorkspaces as listWorkspacesService,
} from "../../apps/worker/src/services/containers.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const openApi = JSON.parse(await readFile(new URL("../../contracts/openapi.json", import.meta.url), "utf8"));
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const participantToken = `cfk_v1_member_${"B".repeat(43)}`;
const ownerSessionToken = "S".repeat(43);
const staleOwnerSessionToken = "R".repeat(43);
const issueSessionToken = "T".repeat(43);
const malformedSessionToken = "M".repeat(43);
const csrfToken = "C".repeat(43);
const ids = {
  instance: "10000000-0000-4000-8000-000000000001",
  ownerCredential: "10000000-0000-4000-8000-000000000002",
  ownerPrincipal: "10000000-0000-4000-8000-000000000003",
  participantCredential: "10000000-0000-4000-8000-000000000004",
  participantGrant: "10000000-0000-4000-8000-000000000005",
  participantPrincipal: "10000000-0000-4000-8000-000000000006",
  bootstrapOperation: "10000000-0000-4000-8000-000000000007",
  participantSecondGrant: "10000000-0000-4000-8000-000000000008",
  targetIssue: "10000000-0000-4000-8000-000000000009",
};

const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});

let db;

function assertExactOpenApiObject(value, schemaName) {
  const schema = openApi.components.schemas[schemaName];
  assert.equal(schema.additionalProperties, false, `${schemaName} must reject unknown fields`);
  assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort(), `${schemaName} runtime keys drifted`);
}

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

function guardedRecoveryDatabase(target) {
  const rawRows = [];
  const wrapStatement = (statement, guarded) => new Proxy(statement, {
    get(current, property) {
      if (property === "bind") {
        return (...values) => wrapStatement(current.bind(...values), guarded);
      }
      if (property === "all") {
        return async (...values) => {
          const result = await current.all(...values);
          if (guarded) rawRows.push(result.results);
          return result;
        };
      }
      if (property === "first") {
        return async (...values) => {
          const result = await current.first(...values);
          if (guarded) rawRows.push(result === null ? [] : [result]);
          return result;
        };
      }
      const value = Reflect.get(current, property, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
  return {
    db: new Proxy(target, {
      get(current, property) {
        if (property === "prepare") {
          return (sql) => wrapStatement(
            current.prepare(sql),
            (sql.includes("FROM credentials AS auth_credential")
              || sql.includes("FROM web_sessions AS auth_session"))
              && !sql.startsWith("SELECT 1 AS allowed WHERE"),
          );
        }
        const value = Reflect.get(current, property, current);
        return typeof value === "function" ? value.bind(current) : value;
      },
    }),
    rawRows,
  };
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
    bootstrapInstance(db, { ...input, ownerDisplayName: "Drifted Owner" }),
    (error) => error.code === "INSTANCE_ALREADY_INITIALIZED",
  );
  await assert.rejects(
    bootstrapInstance(db, { ...input, ownerCredentialToken: `cfk_v1_owner_${"Z".repeat(43)}` }),
    (error) => error.code === "INSTANCE_ALREADY_INITIALIZED",
  );
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
  assertExactOpenApiObject(createdWorkspace.body.resource, "WorkspaceActive");
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
  const ordinaryUsage = await db.prepare(
    "SELECT COUNT(*) AS count FROM project_usage WHERE project_id = ?1",
  ).bind(projectId).first();
  assert.equal(ordinaryUsage.count, 0);

  const createdSecondProject = await jsonRequest("/api/v1/workspaces/operations/projects", {
    body: { display_name: "Operations Board", key: "OPS" },
    headers: ownerHeaders({ "idempotency-key": "wp03-create-second-project" }),
    method: "POST",
  });
  assert.equal(createdSecondProject.response.status, 200);
  const secondProjectId = createdSecondProject.body.resource.id;

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
  const issueSessionDigest = await sha256Hex(issueSessionToken);
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
    db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
       VALUES (?1, ?2, ?3, 'reader', ?4, ?4, 'wp03-seed-participant-second-grant')`,
    ).bind(ids.participantSecondGrant, ids.participantPrincipal, secondProjectId, Date.now()),
    db.prepare(
      `INSERT INTO issues
        (id, project_id, title, title_search, body, status_key, priority_key,
         priority_rank, version, created_at, updated_at, created_by_principal_id,
         updated_by_principal_id, created_operation_id)
       VALUES (?1, ?2, 'Target issue', 'target issue', '', 'backlog', 'none',
               4, 1, ?3, ?3, ?4, ?4, 'wp03-seed-target-issue')`,
    ).bind(ids.targetIssue, projectId, Date.now(), ids.ownerPrincipal),
  ]);
  const targetIssue = await db.prepare("SELECT number FROM issues WHERE id = ?1")
    .bind(ids.targetIssue).first();
  await db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id, target_kind,
         target_json, expires_at, created_at)
       VALUES ('wp03-issue-target-session', ?1, ?2, 'credential', ?3, 'issue',
               ?4, ?5, ?6)`,
    ).bind(
      issueSessionDigest,
      ids.participantPrincipal,
      ids.participantCredential,
      JSON.stringify({
        entry_path: `/app/issues/CFK-${targetIssue.number}`,
        identifier: `CFK-${targetIssue.number}`,
        issue_id: ids.targetIssue,
        kind: "issue",
        project_id: projectId,
        project_key: "CORE",
        workspace_key: "engineering",
      }),
      Date.now() + 60_000,
      Date.now(),
    ).run();
  await assert.rejects(
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_digest, principal_id, source_kind, source_id, target_kind,
         target_json, expires_at, created_at)
       VALUES ('wp03-malformed-target-session', ?1, ?2, 'credential', ?3, 'project',
               '{}', ?4, ?5)`,
    ).bind(
      await sha256Hex(malformedSessionToken),
      ids.participantPrincipal,
      ids.participantCredential,
      Date.now() + 60_000,
      Date.now(),
    ).run(),
  );
  const participantProject = await jsonRequest("/api/v1/workspaces/engineering/projects/CORE", {
    headers: participantHeaders(),
  });
  assert.equal(participantProject.response.status, 200);
  const participantWorkspaces = await jsonRequest("/api/v1/workspaces", {
    headers: participantHeaders(),
  });
  assert.deepEqual(participantWorkspaces.body.items.map((workspace) => workspace.key), ["engineering", "operations"]);
  const issueTargetWorkspaces = await jsonRequest("/api/v1/workspaces", {
    headers: { cookie: `cfkanban_session=${issueSessionToken}` },
  });
  assert.equal(issueTargetWorkspaces.response.status, 200);
  assert.deepEqual(issueTargetWorkspaces.body.items.map((workspace) => workspace.key), ["engineering"]);
  const issueTargetOtherProject = await jsonRequest("/api/v1/workspaces/operations/projects", {
    headers: { cookie: `cfkanban_session=${issueSessionToken}` },
  });
  assert.equal(issueTargetOtherProject.response.status, 404);
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
  const malformedCursor = await jsonRequest("/api/v1/workspaces?cursor=%25", {
    headers: ownerHeaders(),
  });
  assert.equal(malformedCursor.response.status, 400);
  assert.equal(malformedCursor.body.code, "INVALID_CURSOR");
  assert.equal(malformedCursor.body.recovery, "refresh_cursor");

  const deletedProject = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE?expected_version=3",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(deletedProject.body.resource.deleted_at !== null, true);
  assert.equal(deletedProject.body.resource.version, 4);
  assertExactOpenApiObject(deletedProject.body.resource, "ProjectTombstoneWrite");
  const repeatedDeleteProject = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE?expected_version=4",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(repeatedDeleteProject.response.status, 409);
  assert.equal(repeatedDeleteProject.body.code, "RESOURCE_DELETED");
  assert.equal(repeatedDeleteProject.body.details.current_version, 4);
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
  assertExactOpenApiObject(restoredProject.body.resource, "ProjectRestoredWrite");
  const repeatedRestoreProject = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE/commands/restore",
    {
      body: { expected_version: 5 },
      headers: ownerHeaders({ "idempotency-key": "wp03-repeat-restore-project" }),
      method: "POST",
    },
  );
  assert.equal(repeatedRestoreProject.response.status, 409);
  assert.equal(repeatedRestoreProject.body.code, "RESOURCE_NOT_DELETED");
  assert.equal(repeatedRestoreProject.body.details.current_version, 5);
  const abandonedRestore = await db.prepare(
    `SELECT COUNT(*) AS count FROM idempotency_records
     WHERE state = 'pending' AND route_template = '/api/v1/workspaces/{workspace_key}/projects/{project_key}/commands/restore'`,
  ).first();
  assert.equal(abandonedRestore.count, 0);

  const deletedProjectBeforeParent = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE?expected_version=5",
    { headers: ownerHeaders(), method: "DELETE" },
  );
  assert.equal(deletedProjectBeforeParent.body.resource.version, 6);

  const deletedWorkspace = await jsonRequest("/api/v1/workspaces/engineering?expected_version=2", {
    headers: ownerHeaders(),
    method: "DELETE",
  });
  assert.equal(deletedWorkspace.body.resource.version, 3);
  assertExactOpenApiObject(deletedWorkspace.body.resource, "WorkspaceTombstone");
  const childTombstoneUnderDeletedParent = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.equal(childTombstoneUnderDeletedParent.response.status, 200);
  assertExactOpenApiObject(childTombstoneUnderDeletedParent.body, "ProjectTombstoneRead");
  assert.equal(childTombstoneUnderDeletedParent.body.restorable, false);
  assert.deepEqual(childTombstoneUnderDeletedParent.body.allowed_actions, []);
  assert.deepEqual(childTombstoneUnderDeletedParent.body.parent_status, { workspace: "deleted" });
  assert.deepEqual(childTombstoneUnderDeletedParent.body.unavailability_reason, {
    code: "PARENT_WORKSPACE_DELETED",
    recovery: "restore_parent",
  });
  const childTombstonePageUnderDeletedParent = await jsonRequest(
    "/api/v1/workspaces/engineering/projects?deleted=only",
    { headers: ownerHeaders() },
  );
  assert.equal(childTombstonePageUnderDeletedParent.response.status, 200);
  assert.equal(childTombstonePageUnderDeletedParent.body.items[0].restorable, false);
  assert.deepEqual(childTombstonePageUnderDeletedParent.body.items[0].parent_status, { workspace: "deleted" });
  const staleOwnerNow = Date.now();
  const staleOwnerAuth = await authenticateRequest(
    db,
    new Request("https://kanban.example.test/api/v1/workspaces?deleted=only", {
      headers: ownerHeaders(),
    }),
    staleOwnerNow,
  );
  await db.prepare(
    `INSERT INTO web_sessions
      (id, token_digest, principal_id, source_kind, source_id, target_kind,
       target_json, expires_at, created_at)
     VALUES ('wp03-stale-owner-session', ?1, ?2, 'credential', ?3, 'admin',
             ?4, ?5, ?6)`,
  ).bind(
    await sha256Hex(staleOwnerSessionToken),
    ids.ownerPrincipal,
    ids.ownerCredential,
    JSON.stringify({ entry_path: "/app/admin", kind: "admin", section: "workspaces-projects" }),
    staleOwnerNow + 60_000,
    staleOwnerNow,
  ).run();
  const staleOwnerSessionAuth = await authenticateRequest(
    db,
    new Request("https://kanban.example.test/api/v1/workspaces?deleted=only", {
      headers: { cookie: `cfkanban_session=${staleOwnerSessionToken}` },
    }),
    staleOwnerNow,
  );
  await db.prepare("UPDATE credentials SET revoked_at = ?1 WHERE id = ?2")
    .bind(staleOwnerNow, ids.ownerCredential)
    .run();
  try {
    for (const staleAuth of [staleOwnerAuth, staleOwnerSessionAuth]) {
      const staleRecoveryReads = [];
      for (const read of [
        (guardedDb) => listWorkspacesService(
          guardedDb,
          staleAuth,
          new URL("https://kanban.example.test/api/v1/workspaces?deleted=only"),
          staleOwnerNow,
        ),
        (guardedDb) => getWorkspaceService(
          guardedDb,
          staleAuth,
          "engineering",
          new URL("https://kanban.example.test/api/v1/workspaces/engineering?deleted=only"),
          staleOwnerNow,
        ),
        (guardedDb) => listProjectsService(
          guardedDb,
          staleAuth,
          "engineering",
          new URL("https://kanban.example.test/api/v1/workspaces/engineering/projects?deleted=only"),
          staleOwnerNow,
        ),
        (guardedDb) => getProjectService(
          guardedDb,
          staleAuth,
          "engineering",
          "CORE",
          new URL("https://kanban.example.test/api/v1/workspaces/engineering/projects/CORE?deleted=only"),
          staleOwnerNow,
        ),
      ]) {
        const guarded = guardedRecoveryDatabase(db);
        staleRecoveryReads.push(await Promise.allSettled([read(guarded.db)]).then(([result]) => result));
        assert.ok(guarded.rawRows.length > 0);
        assert.deepEqual(guarded.rawRows, guarded.rawRows.map(() => []));
      }
      for (const read of staleRecoveryReads) {
        assert.equal(read.status, "rejected");
        assert.equal(read.reason?.status, 401);
        assert.equal(read.reason?.code, "UNAUTHORIZED");
      }
    }
  } finally {
    await db.prepare("UPDATE credentials SET revoked_at = NULL WHERE id = ?1")
      .bind(ids.ownerCredential)
      .run();
    await db.prepare("DELETE FROM web_sessions WHERE id = 'wp03-stale-owner-session'").run();
  }
  const childRestoreWhileParentDeleted = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE/commands/restore",
    {
      body: { expected_version: 6 },
      headers: ownerHeaders({ "idempotency-key": "wp03-restore-child-under-deleted-parent" }),
      method: "POST",
    },
  );
  assert.equal(childRestoreWhileParentDeleted.response.status, 409);
  assert.equal(childRestoreWhileParentDeleted.body.code, "PARENT_WORKSPACE_DELETED");
  const restoredWorkspace = await jsonRequest("/api/v1/workspaces/engineering/commands/restore", {
    body: { expected_version: 3 },
    headers: ownerHeaders({ "idempotency-key": "wp03-restore-workspace" }),
    method: "POST",
  });
  assert.equal(restoredWorkspace.body.resource.version, 4);
  assertExactOpenApiObject(restoredWorkspace.body.resource, "WorkspaceRestored");
  const restoredChildAfterParent = await jsonRequest(
    "/api/v1/workspaces/engineering/projects/CORE/commands/restore",
    {
      body: { expected_version: 6 },
      headers: ownerHeaders({ "idempotency-key": "wp03-restore-child-after-parent" }),
      method: "POST",
    },
  );
  assert.equal(restoredChildAfterParent.body.resource.version, 7);

  const ownerSessionDigest = await sha256Hex(ownerSessionToken);
  await db.prepare(
    `INSERT INTO web_sessions
      (id, token_digest, principal_id, source_kind, source_id, target_kind,
       target_json, expires_at, created_at)
     VALUES ('wp03-owner-admin-session', ?1, ?2, 'credential', ?3, 'admin',
             ?4, ?5, ?6)`,
  ).bind(
    ownerSessionDigest,
    ids.ownerPrincipal,
    ids.ownerCredential,
    JSON.stringify({ entry_path: "/app/admin", kind: "admin", section: "overview" }),
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

  const bootstrapAfterLaterMutations = await bootstrapInstance(db, {
    instanceId: ids.instance,
    operationId: ids.bootstrapOperation,
    ownerCredentialId: ids.ownerCredential,
    ownerCredentialToken: ownerToken,
    ownerDisplayName: "Deployment Owner",
    ownerPrincipalId: ids.ownerPrincipal,
    preferredApiOrigin: "https://kanban.example.test",
  });
  assert.equal(bootstrapAfterLaterMutations.recovered, true);
  assert.equal(bootstrapAfterLaterMutations.ownerDisplayName, "Deployment Owner");
  assert.equal(bootstrapAfterLaterMutations.preferredApiOrigin, "https://kanban.example.test");
  assert.equal(bootstrapAfterLaterMutations.credentialId, ids.ownerCredential);

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
