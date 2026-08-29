import {
  requireProjectKey,
  requireUuid,
  requireWorkspaceKey,
  timestamp,
} from "../domain/model.ts";
import {
  requireProjectAuthorization,
  requireVisibleProject,
  resolveVisibleProjects,
  verifyCurrentAuth,
  type VisibleProject,
} from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { isUuid } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  platformUnavailable,
  validationError,
  versionConflict,
} from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  buildProjectRoleGuard,
  requireCollaborationIssue,
  requireCollaborationIssueAuthorization,
  requireLabelColor,
  requireLabelName,
  roleCanWrite,
  type CollaborationIssue,
} from "./collaboration-shared.ts";
import {
  currentIssueReplayProjection,
  issueWriteSnapshotStatement,
  readIssueWriteSnapshotResource,
} from "./issues.ts";
import {
  actorCredentialId,
  authorizedVia,
  requireDeletedMode,
  requireIdempotencyKey,
  requireLimit,
  writeResult,
} from "./shared.ts";

interface LabelRow {
  color: string | null;
  created_at: number;
  deleted_at: number | null;
  deleted_by_principal_id: string | null;
  id: string;
  last_operation_id: string | null;
  name: string;
  project_id: string;
  project_deleted_at: number | null;
  project_key: string;
  project_name: string;
  updated_at: number;
  version: number;
  workspace_id: string;
  workspace_deleted_at: number | null;
  workspace_key: string;
  workspace_name: string;
}

interface LabelAccess {
  project: VisibleProject;
  row: LabelRow;
}

function labelResource(row: LabelRow, role: VisibleProject["role"]): { [key: string]: JsonValue } {
  const canWrite = roleCanWrite(role);
  const parentStatus = {
    project: row.project_deleted_at === null ? "active" : "deleted",
    workspace: row.workspace_deleted_at === null ? "active" : "deleted",
  };
  const unavailabilityReason = row.workspace_deleted_at !== null
    ? { code: "PARENT_WORKSPACE_DELETED", recovery: "restore_parent" }
    : row.project_deleted_at !== null
      ? { code: "PARENT_PROJECT_DELETED", recovery: "restore_parent" }
      : null;
  const restorable = row.deleted_at !== null && canWrite && unavailabilityReason === null;
  return {
    allowed_actions: canWrite
      ? row.deleted_at === null ? ["read", "update", "delete"] : ["read", "restore"]
      : ["read"],
    color: row.color,
    created_at: timestamp(row.created_at),
    deleted_at: timestamp(row.deleted_at),
    deleted_by_principal_id: row.deleted_by_principal_id,
    id: row.id,
    name: row.name,
    project: {
      id: row.project_id,
      key: row.project_key,
      workspace_key: row.workspace_key,
    },
    updated_at: timestamp(row.updated_at),
    version: row.version,
    ...(row.deleted_at === null ? {} : {
      parent_status: parentStatus,
      restorable,
      unavailability_reason: unavailabilityReason,
    }),
  };
}

async function readLabel(db: D1Database, labelId: string): Promise<LabelRow | null> {
  try {
    return await db.prepare(
      `SELECT label.id, label.project_id, label.name, label.color,
              label.version, label.deleted_at, label.deleted_by_principal_id,
              label.created_at, label.updated_at, label.last_operation_id,
              project.key AS project_key, project.display_name AS project_name,
              project.deleted_at AS project_deleted_at,
              workspace.id AS workspace_id, workspace.key AS workspace_key,
              workspace.display_name AS workspace_name,
              workspace.deleted_at AS workspace_deleted_at
       FROM labels label
       JOIN projects project ON project.id = label.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE label.id = ?1
       LIMIT 1`,
    ).bind(labelId).first<LabelRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function requireLabelAccess(
  db: D1Database,
  auth: AuthContext,
  labelIdValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
  requireActive = false,
  includeEffectiveDeleted = false,
): Promise<LabelAccess> {
  const labelId = requireUuid(labelIdValue, "label_id");
  const [row, projects] = await Promise.all([
    readLabel(db, labelId),
    resolveVisibleProjects(db, auth, includeEffectiveDeleted && auth.isOwner),
  ]);
  if (row === null || (requireActive && row.deleted_at !== null)) throw notFound();
  const project = projects.find((candidate) => candidate.projectId === row.project_id);
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && !roleCanWrite(project.role)) throw forbidden();
  return { project, row };
}

function parseLabelCursor(
  last: JsonValue[] | null,
  deleted: boolean,
): [number, string] | [string, string] | null {
  if (last === null) return null;
  if (last.length !== 2 || typeof last[1] !== "string" || !isUuid(last[1])) throw invalidCursor();
  if (deleted) {
    if (typeof last[0] !== "number" || !Number.isSafeInteger(last[0]) || last[0] < 0) {
      throw invalidCursor();
    }
    return [last[0], last[1]];
  }
  if (typeof last[0] !== "string" || last[0].length === 0) throw invalidCursor();
  return [last[0], last[1]];
}

function labelSnapshotStatement(
  db: D1Database,
  operationId: string,
  labelId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT json_object(
         'color', label.color,
         'created_at', label.created_at,
         'deleted_at', label.deleted_at,
         'deleted_by_principal_id', label.deleted_by_principal_id,
         'id', label.id,
         'last_operation_id', label.last_operation_id,
         'name', label.name,
         'project_id', label.project_id,
         'project_deleted_at', project.deleted_at,
         'project_key', project.key,
         'project_name', project.display_name,
         'updated_at', label.updated_at,
         'version', label.version,
         'workspace_id', workspace.id,
         'workspace_deleted_at', workspace.deleted_at,
         'workspace_key', workspace.key,
         'workspace_name', workspace.display_name
       )
       FROM labels label
       JOIN projects project ON project.id = label.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE label.id = ?2 AND label.last_operation_id = ?1
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, labelId);
}

function labelEvent(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  labelId: string,
  type: string,
  payload: JsonValue,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, grant_id, workspace_id,
       project_id, subject_type, subject_id, payload_json, created_at)
     SELECT ?1, 'domain', ?2, ?3, 0, ?4, ?5, ?6,
            CASE WHEN ?7 = 1 THEN NULL ELSE (
              SELECT grant_row.id FROM project_grants grant_row
              WHERE grant_row.project_id = label.project_id
                AND grant_row.principal_id = ?4
                AND grant_row.role = 'writer' AND grant_row.revoked_at IS NULL
              LIMIT 1
            ) END,
            project.workspace_id, label.project_id,
            'label', label.id, ?8, ?9
     FROM labels label
     JOIN projects project ON project.id = label.project_id
     WHERE label.id = ?10 AND label.last_operation_id = ?3`,
  ).bind(
    crypto.randomUUID(),
    type,
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    authorizedVia(auth),
    auth.isOwner ? 1 : 0,
    JSON.stringify(payload),
    now,
    labelId,
  );
}

async function deterministicRejection(check: () => Promise<never>): Promise<boolean> {
  try {
    await check();
  } catch (error) {
    if (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE") return true;
    throw error;
  }
  return false;
}

async function labelNameConflict(
  db: D1Database,
  projectId: string,
  name: string,
  exceptId: string | null = null,
): Promise<boolean> {
  try {
    return await db.prepare(
      `SELECT id FROM labels
       WHERE project_id = ?1 AND name = ?2 COLLATE NOCASE
         AND (?3 IS NULL OR id != ?3)
       LIMIT 1`,
    ).bind(projectId, name, exceptId).first() !== null;
  } catch {
    throw platformUnavailable("d1");
  }
}

export async function listLabels(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const deletedMode = requireDeletedMode(url);
  const project = deletedMode === "only"
    ? await requireProjectAuthorization(db, auth, workspaceKey, projectKey, "writer", true)
    : await requireVisibleProject(db, auth, workspaceKey, projectKey);
  const context = await createCursorContext(
    "labels",
    { deleted: deletedMode, project_id: project.projectId },
    [project.projectId],
    auth.principalId,
  );
  const cursor = parseLabelCursor(decodeCursor(url.searchParams.get("cursor"), context), deletedMode === "only");
  const limit = requireLimit(url);
  let rows: LabelRow[];
  try {
    const result = deletedMode === "only"
      ? await db.prepare(
        `SELECT label.id, label.project_id, label.name, label.color,
                label.version, label.deleted_at, label.deleted_by_principal_id,
                label.created_at, label.updated_at, label.last_operation_id,
                project.key AS project_key, project.display_name AS project_name,
                project.deleted_at AS project_deleted_at,
                workspace.id AS workspace_id, workspace.key AS workspace_key,
                workspace.display_name AS workspace_name,
                workspace.deleted_at AS workspace_deleted_at
         FROM labels label
         JOIN projects project ON project.id = label.project_id
         JOIN workspaces workspace ON workspace.id = project.workspace_id
         WHERE label.project_id = ?1 AND label.deleted_at IS NOT NULL
           AND (?2 IS NULL OR label.deleted_at < ?2
                OR (label.deleted_at = ?2 AND label.id < ?3))
         ORDER BY label.deleted_at DESC, label.id DESC
         LIMIT ?4`,
      ).bind(project.projectId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1).all<LabelRow>()
      : await db.prepare(
        `SELECT label.id, label.project_id, label.name, label.color,
                label.version, label.deleted_at, label.deleted_by_principal_id,
                label.created_at, label.updated_at, label.last_operation_id,
                project.key AS project_key, project.display_name AS project_name,
                project.deleted_at AS project_deleted_at,
                workspace.id AS workspace_id, workspace.key AS workspace_key,
                workspace.display_name AS workspace_name,
                workspace.deleted_at AS workspace_deleted_at
         FROM labels label
         JOIN projects project ON project.id = label.project_id
         JOIN workspaces workspace ON workspace.id = project.workspace_id
         WHERE label.project_id = ?1 AND label.deleted_at IS NULL
           AND (?2 IS NULL OR label.name > ?2 COLLATE NOCASE
                OR (label.name = ?2 COLLATE NOCASE AND label.id > ?3))
         ORDER BY label.name COLLATE NOCASE ASC, label.id ASC
         LIMIT ?4`,
      ).bind(project.projectId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1).all<LabelRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: page.map((row) => labelResource(row, project.role)),
    next_cursor: hasMore && tail !== undefined
      ? encodeCursor(context, deletedMode === "only"
        ? [tail.deleted_at ?? 0, tail.id]
        : [tail.name, tail.id])
      : null,
    resolved_scope: {
      project_id: project.projectId,
      project_key: project.projectKey,
      workspace_key: project.workspaceKey,
    },
  };
}

export async function getLabel(
  db: D1Database,
  auth: AuthContext,
  labelIdValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const deletedMode = requireDeletedMode(url);
  const { project, row } = await requireLabelAccess(
    db,
    auth,
    labelIdValue,
    deletedMode === "only" ? "writer" : "reader",
    false,
    deletedMode === "only",
  );
  if ((row.deleted_at !== null) !== (deletedMode === "only")) throw notFound();
  return labelResource(row, project.role);
}

async function diagnoseLabelCreate(
  db: D1Database,
  auth: AuthContext,
  workspaceKey: string,
  projectKey: string,
  name: string,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const project = await requireVisibleProject(db, auth, workspaceKey, projectKey, "writer");
  if (await labelNameConflict(db, project.projectId, name)) {
    throw conflict("LABEL_NAME_CONFLICT", "use_existing_or_restore");
  }
  throw platformUnavailable("d1");
}

export async function createLabel(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  nameValue: JsonValue,
  colorValue: JsonValue | undefined,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const project = await requireProjectAuthorization(db, auth, workspaceKey, projectKey, "writer");
  const name = requireLabelName(nameValue);
  const color = requireLabelColor(colorValue) ?? null;
  const labelId = crypto.randomUUID();
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      await verifyCurrentAuth(db, auth, now);
      const latest = await requireProjectAuthorization(db, auth, workspaceKey, projectKey, "writer");
      if (latest.projectId !== project.projectId) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const activeProject = await requireVisibleProject(db, auth, workspaceKey, projectKey, "writer");
      if (activeProject.projectId !== project.projectId) throw notFound();
      const guard = buildProjectRoleGuard(auth, now, 8, "project.id");
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `INSERT INTO labels
                (id, project_id, name, color, version, created_at, updated_at,
                 created_by_principal_id, updated_by_principal_id,
                 created_operation_id, last_operation_id)
               SELECT ?1, project.id, ?3, ?4, 1, ?5, ?5, ?6, ?6, ?7, ?7
               FROM projects project
               JOIN workspaces workspace ON workspace.id = project.workspace_id
               WHERE project.id = ?2 AND project.deleted_at IS NULL
                 AND workspace.deleted_at IS NULL AND ${guard.sql}`,
            ).bind(
              labelId,
              project.projectId,
              name,
              color,
              now,
              auth.principalId,
              operationId,
              ...guard.values,
            ),
            labelSnapshotStatement(db, operationId, labelId),
            labelEvent(db, auth, operationId, labelId, "label.created", {
              color,
              label_version: 1,
              name,
            }, now),
          ],
          committedAt: now,
          confirmBusinessRejection: () => deterministicRejection(
            () => diagnoseLabelCreate(db, auth, workspaceKey, projectKey, name, now),
          ),
          expectedEventCount: 1,
          operationId,
          primarySubjectId: labelId,
          primarySubjectType: "label",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          return diagnoseLabelCreate(db, auth, workspaceKey, projectKey, name, now);
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `project:${project.projectId}:label:${name.toLowerCase()}`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<LabelRow>(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          labelResource(snapshot, project.role),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { color, name },
    routeTemplate: "/api/v1/workspaces/{workspace_key}/projects/{project_key}/labels",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

async function diagnoseLabelCas(
  db: D1Database,
  auth: AuthContext,
  labelId: string,
  expectedVersion: number,
  expectedDeleted: boolean,
  now: number,
  nextName?: string,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const { row } = await requireLabelAccess(db, auth, labelId, "writer");
  if ((row.deleted_at !== null) !== expectedDeleted) {
    throw conflict(expectedDeleted ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED");
  }
  if (row.version !== expectedVersion) throw versionConflict(row.version);
  if (nextName !== undefined && await labelNameConflict(db, row.project_id, nextName, row.id)) {
    throw conflict("LABEL_NAME_CONFLICT", "choose_different_name");
  }
  throw platformUnavailable("d1");
}

export async function updateLabel(
  db: D1Database,
  auth: AuthContext,
  labelIdValue: JsonValue,
  nameValue: JsonValue | undefined,
  colorValue: JsonValue | undefined,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const access = await requireLabelAccess(db, auth, labelIdValue, "writer", true);
  if (nameValue === undefined && colorValue === undefined) throw validationError("update_field_required");
  const name = nameValue === undefined ? access.row.name : requireLabelName(nameValue);
  const color = colorValue === undefined ? access.row.color : requireLabelColor(colorValue) ?? null;
  const operationId = crypto.randomUUID();
  const guard = buildProjectRoleGuard(auth, now, 10, "labels.project_id");
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE labels
           SET name = CASE WHEN ?1 = 1 THEN ?2 ELSE name END,
               color = CASE WHEN ?3 = 1 THEN ?4 ELSE color END,
               version = version + 1, updated_at = ?5,
               updated_by_principal_id = ?6, last_operation_id = ?7
           WHERE id = ?8 AND version = ?9 AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM projects parent_project
               JOIN workspaces parent_workspace ON parent_workspace.id = parent_project.workspace_id
               WHERE parent_project.id = labels.project_id
                 AND parent_project.deleted_at IS NULL
                 AND parent_workspace.deleted_at IS NULL
             )
             AND ${guard.sql}`,
        ).bind(
          nameValue === undefined ? 0 : 1,
          name,
          colorValue === undefined ? 0 : 1,
          color,
          now,
          auth.principalId,
          operationId,
          access.row.id,
          expectedVersion,
          ...guard.values,
        ),
        labelEvent(db, auth, operationId, access.row.id, "label.updated", {
          color_changed: colorValue !== undefined,
          label_version: expectedVersion + 1,
          name_changed: nameValue !== undefined,
        }, now),
      ],
      committedAt: now,
      confirmBusinessRejection: () => deterministicRejection(
        () => diagnoseLabelCas(db, auth, access.row.id, expectedVersion, false, now, name),
      ),
      expectedEventCount: 1,
      operationId,
      primarySubjectId: access.row.id,
      primarySubjectType: "label",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnoseLabelCas(db, auth, access.row.id, expectedVersion, false, now, name);
    }
    throw error;
  }
  const updated: LabelRow = {
    ...access.row,
    color,
    last_operation_id: operationId,
    name,
    updated_at: now,
    version: expectedVersion + 1,
  };
  return writeResult(db, auth, labelResource(updated, access.project.role), commit.lastEventSequence, false);
}

async function setLabelDeleted(
  db: D1Database,
  auth: AuthContext,
  access: LabelAccess,
  expectedVersion: number,
  now: number,
  deleted: boolean,
  operationId: string,
  persistSnapshot: boolean,
): Promise<OperationCommit> {
  const guard = buildProjectRoleGuard(auth, now, 8, "labels.project_id");
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE labels
           SET deleted_at = ?1, deleted_by_principal_id = ?2,
               version = version + 1, updated_at = ?3,
               updated_by_principal_id = ?4, last_operation_id = ?5
           WHERE id = ?6 AND version = ?7
             AND ${deleted ? "deleted_at IS NULL" : "deleted_at IS NOT NULL"}
             AND EXISTS (
               SELECT 1 FROM projects parent_project
               JOIN workspaces parent_workspace ON parent_workspace.id = parent_project.workspace_id
               WHERE parent_project.id = labels.project_id
                 AND parent_project.deleted_at IS NULL
                 AND parent_workspace.deleted_at IS NULL
             )
             AND ${guard.sql}`,
        ).bind(
          deleted ? now : null,
          deleted ? auth.principalId : null,
          now,
          auth.principalId,
          operationId,
          access.row.id,
          expectedVersion,
          ...guard.values,
        ),
        ...(persistSnapshot ? [labelSnapshotStatement(db, operationId, access.row.id)] : []),
        labelEvent(
          db,
          auth,
          operationId,
          access.row.id,
          deleted ? "label.deleted" : "label.restored",
          { label_version: expectedVersion + 1 },
          now,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: () => deterministicRejection(
        () => diagnoseLabelCas(db, auth, access.row.id, expectedVersion, !deleted, now),
      ),
      expectedEventCount: 1,
      operationId,
      primarySubjectId: access.row.id,
      primarySubjectType: "label",
      requireIdempotencySnapshot: persistSnapshot,
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnoseLabelCas(db, auth, access.row.id, expectedVersion, !deleted, now);
    }
    throw error;
  }
}

export async function deleteLabel(
  db: D1Database,
  auth: AuthContext,
  labelIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const access = await requireLabelAccess(db, auth, labelIdValue, "writer");
  const operationId = crypto.randomUUID();
  const commit = await setLabelDeleted(db, auth, access, expectedVersion, now, true, operationId, false);
  const row: LabelRow = {
    ...access.row,
    deleted_at: now,
    deleted_by_principal_id: auth.principalId,
    last_operation_id: operationId,
    updated_at: now,
    version: expectedVersion + 1,
  };
  return writeResult(db, auth, labelResource(row, access.project.role), commit.lastEventSequence, false);
}

export async function restoreLabel(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  labelIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const access = await requireLabelAccess(db, auth, labelIdValue, "writer", false, true);
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      await verifyCurrentAuth(db, auth, now);
      const latest = await requireLabelAccess(db, auth, access.row.id, "writer");
      if (latest.row.project_id !== access.row.project_id) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const activeAccess = await requireLabelAccess(db, auth, access.row.id, "writer");
      await setLabelDeleted(
        db,
        auth,
        activeAccess,
        expectedVersion,
        now,
        false,
        operationId,
        true,
      );
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `label:${access.row.id}:restore`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<LabelRow>(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          labelResource(snapshot, access.project.role),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { expected_version: expectedVersion },
    routeTemplate: "/api/v1/labels/{label_id}/commands/restore",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

async function associationExists(db: D1Database, issueId: string, labelId: string): Promise<boolean> {
  try {
    return await db.prepare(
      "SELECT 1 FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2",
    ).bind(issueId, labelId).first() !== null;
  } catch {
    throw platformUnavailable("d1");
  }
}

async function diagnoseIssueLabel(
  db: D1Database,
  auth: AuthContext,
  issue: CollaborationIssue,
  labelId: string,
  expectedVersion: number,
  adding: boolean,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const latestIssue = await requireCollaborationIssue(db, auth, issue.identifier, "writer");
  if (latestIssue.version !== expectedVersion) throw versionConflict(latestIssue.version);
  const label = await requireLabelAccess(db, auth, labelId, "reader", true);
  if (label.row.project_id !== issue.projectId) throw notFound();
  const exists = await associationExists(db, issue.id, labelId);
  if (adding && exists) throw conflict("LABEL_ALREADY_ATTACHED");
  if (!adding && !exists) throw conflict("LABEL_NOT_ATTACHED");
  if (adding) {
    try {
      const count = await db.prepare(
        "SELECT COUNT(*) AS count FROM issue_labels WHERE issue_id = ?1",
      ).bind(issue.id).first<{ count: number }>();
      if ((count?.count ?? 0) >= 20) throw conflict("ISSUE_LABEL_LIMIT_REACHED");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw platformUnavailable("d1");
    }
  }
  throw platformUnavailable("d1");
}

function issueLabelEvent(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  issue: CollaborationIssue,
  labelId: string,
  adding: boolean,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, grant_id, workspace_id,
       project_id, subject_type, subject_id, payload_json, created_at)
     SELECT ?1, 'domain', ?2, ?3, 0, ?4, ?5, ?6,
            CASE WHEN ?7 = 1 THEN NULL ELSE (
              SELECT grant_row.id FROM project_grants grant_row
              WHERE grant_row.project_id = issue.project_id
                AND grant_row.principal_id = ?4
                AND grant_row.role = 'writer' AND grant_row.revoked_at IS NULL
              LIMIT 1
            ) END,
            project.workspace_id, issue.project_id,
            'issue', issue.id,
            json_object(
              'issue_identifier', ?8,
              'issue_version', issue.version,
              'label_id', label.id,
              'label_name', label.name,
              'label_version', label.version
            ), ?9
     FROM issues issue
     JOIN projects project ON project.id = issue.project_id
     JOIN labels label ON label.id = ?10 AND label.project_id = issue.project_id
     WHERE issue.id = ?11 AND issue.last_operation_id = ?3
       AND ${adding
         ? "EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = issue.id AND il.label_id = label.id AND il.created_operation_id = ?3)"
         : "NOT EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = issue.id AND il.label_id = label.id)"}`,
  ).bind(
    crypto.randomUUID(),
    adding ? "issue.label-added" : "issue.label-removed",
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    authorizedVia(auth),
    auth.isOwner ? 1 : 0,
    issue.identifier,
    now,
    labelId,
    issue.id,
  );
}

async function changeIssueLabel(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  labelIdValue: JsonValue,
  expectedVersion: number,
  adding: boolean,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const issue = await requireCollaborationIssueAuthorization(db, auth, identifierValue, "writer");
  const labelId = requireUuid(labelIdValue, "label_id");
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      await verifyCurrentAuth(db, auth, now);
      const latest = await requireCollaborationIssueAuthorization(db, auth, issue.identifier, "writer");
      if (latest.projectId !== issue.projectId) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const activeIssue = await requireCollaborationIssue(db, auth, issue.identifier, "writer");
      const label = await requireLabelAccess(db, auth, labelId, "reader", true);
      if (label.row.project_id !== activeIssue.projectId) throw notFound();
      const guard = buildProjectRoleGuard(auth, now, 7, "issue.project_id");
      const businessStatements: D1PreparedStatement[] = adding
        ? [
          db.prepare(
            `INSERT INTO issue_labels
              (issue_id, label_id, added_at, added_by_principal_id, created_operation_id)
             SELECT issue.id, label.id, ?4, ?5, ?6
             FROM issues issue
             JOIN labels label ON label.id = ?2 AND label.project_id = issue.project_id
             JOIN projects project ON project.id = issue.project_id
             JOIN workspaces workspace ON workspace.id = project.workspace_id
             WHERE issue.id = ?1 AND issue.version = ?3 AND issue.deleted_at IS NULL
               AND label.deleted_at IS NULL AND project.deleted_at IS NULL
               AND workspace.deleted_at IS NULL
               AND (SELECT COUNT(*) FROM issue_labels existing WHERE existing.issue_id = issue.id) < 20
               AND ${guard.sql}`,
          ).bind(
            activeIssue.id,
            labelId,
            expectedVersion,
            now,
            auth.principalId,
            operationId,
            ...guard.values,
          ),
          db.prepare(
            `UPDATE issues
             SET version = version + 1, updated_at = ?1,
                 updated_by_principal_id = ?2, last_operation_id = ?3
             WHERE id = ?4 AND version = ?5 AND deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM issue_labels association
                 WHERE association.issue_id = issues.id AND association.label_id = ?6
                   AND association.created_operation_id = ?3
               )`,
          ).bind(now, auth.principalId, operationId, activeIssue.id, expectedVersion, labelId),
        ]
        : [
          db.prepare(
            `UPDATE issues AS issue
             SET version = version + 1, updated_at = ?1,
                 updated_by_principal_id = ?2, last_operation_id = ?3
             WHERE issue.id = ?4 AND issue.version = ?5 AND issue.deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM labels label
                 JOIN projects project ON project.id = issue.project_id
                 JOIN workspaces workspace ON workspace.id = project.workspace_id
                 WHERE label.id = ?6 AND label.project_id = issue.project_id
                   AND label.deleted_at IS NULL
                   AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
                   AND EXISTS (
                     SELECT 1 FROM issue_labels association
                     WHERE association.issue_id = issue.id AND association.label_id = label.id
                   )
                   AND ${guard.sql}
               )`,
          ).bind(now, auth.principalId, operationId, activeIssue.id, expectedVersion, labelId, ...guard.values),
          db.prepare(
            `DELETE FROM issue_labels
             WHERE issue_id = ?1 AND label_id = ?2
               AND EXISTS (SELECT 1 FROM issues issue WHERE issue.id = ?1 AND issue.last_operation_id = ?3)`,
          ).bind(activeIssue.id, labelId, operationId),
        ];
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            ...businessStatements,
            issueWriteSnapshotStatement(db, operationId, activeIssue.id, activeIssue.role),
            issueLabelEvent(db, auth, operationId, activeIssue, labelId, adding, now),
          ],
          committedAt: now,
          confirmBusinessRejection: () => deterministicRejection(
            () => diagnoseIssueLabel(db, auth, activeIssue, labelId, expectedVersion, adding, now),
          ),
          expectedEventCount: 1,
          operationId,
          primarySubjectId: activeIssue.id,
          primarySubjectType: "issue",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          return diagnoseIssueLabel(db, auth, activeIssue, labelId, expectedVersion, adding, now);
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `issue:${issue.id}:label:${labelId}:${adding ? "add" : "remove"}`,
    now,
    readback: async (operationId, commit) => ({
      body: await writeResult(
        db,
        auth,
        await readIssueWriteSnapshotResource(db, auth, operationId),
        commit.lastEventSequence,
        false,
      ),
      status: 200,
    }),
    requestBody: { expected_version: expectedVersion, label_id: labelId },
    replay: (stored) => currentIssueReplayProjection(db, auth, stored),
    routeTemplate: adding
      ? "/api/v1/issues/{identifier}/commands/add-label"
      : "/api/v1/issues/{identifier}/commands/remove-label",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export function addIssueLabel(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  labelIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  return changeIssueLabel(db, request, auth, identifierValue, labelIdValue, expectedVersion, true, now);
}

export function removeIssueLabel(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  labelIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  return changeIssueLabel(db, request, auth, identifierValue, labelIdValue, expectedVersion, false, now);
}
