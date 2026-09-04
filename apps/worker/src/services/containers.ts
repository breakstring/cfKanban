import {
  WORKFLOW_STATUSES,
  isStatusKey,
  requireContext,
  requireDisplayName,
  requireProjectKey,
  requireWorkspaceKey,
  timestamp,
  type StatusKey,
} from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  reauthenticateOwner,
  requireOwnerControl,
  resolveVisibleProjects,
  verifyCurrentAuth,
} from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { isUuid } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import { conflict, forbidden, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import {
  operationSnapshotStatement,
  readOperationSnapshot,
  runIdempotentOperation,
} from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  actorCredentialId,
  authorizedVia,
  requireDeletedMode,
  requireIdempotencyKey,
  requireLimit,
  writeResult,
} from "./shared.ts";

interface WorkspaceRow {
  created_at: number;
  deleted_at: number | null;
  display_name: string;
  id: string;
  key: string;
  updated_at: number;
  version: number;
}

interface ProjectRow {
  active_comment_count: number;
  active_issue_count: number;
  active_principal_count: number;
  comment_limit: number | null;
  context: string | null;
  created_at: number;
  deleted_at: number | null;
  display_name: string;
  id: string;
  issue_limit: number | null;
  key: string;
  principal_limit: number | null;
  public_join_public_summary: string | null;
  public_join_enabled: number;
  updated_at: number;
  usage_present: number;
  version: number;
  workspace_id: string;
  workspace_deleted_at: number | null;
  workspace_key: string;
}

interface ResumedPublicProjectRow {
  active_comment_count: number | null;
  active_issue_count: number | null;
  active_principal_count: number | null;
  comment_limit: number | null;
  display_name: string;
  id: string;
  issue_limit: number | null;
  key: string;
  principal_limit: number | null;
  public_summary: string;
  workspace_key: string;
}

interface StatusNameRow {
  display_name: string;
  status_key: StatusKey;
}

function canManageContainers(auth: AuthContext): boolean {
  return auth.isOwner && (auth.kind === "bearer" || auth.targetKind === "admin");
}

function workspaceResource(row: WorkspaceRow, auth: AuthContext): { [key: string]: JsonValue } {
  const canManage = canManageContainers(auth);
  return {
    allowed_actions: row.deleted_at === null
      ? [...(canManage ? ["update", "delete", "create_project"] : []), "read"]
      : canManage ? ["restore"] : [],
    created_at: timestamp(row.created_at),
    deleted_at: timestamp(row.deleted_at),
    display_name: row.display_name,
    id: row.id,
    key: row.key,
    restorable: row.deleted_at !== null && canManage,
    updated_at: timestamp(row.updated_at),
    version: row.version,
  };
}

function projectResource(row: ProjectRow, auth: AuthContext): { [key: string]: JsonValue } {
  const canManage = canManageContainers(auth);
  const parentActive = row.workspace_deleted_at === null;
  const resource: { [key: string]: JsonValue } = {
    active_usage: {
      comments: row.active_comment_count,
      issues: row.active_issue_count,
      principals: row.active_principal_count,
    },
    allowed_actions: row.deleted_at === null
      ? [...(canManage ? ["update", "delete", "manage_status_names"] : []), "read"]
      : canManage && parentActive ? ["restore"] : [],
    context: row.context,
    created_at: timestamp(row.created_at),
    deleted_at: timestamp(row.deleted_at),
    display_name: row.display_name,
    id: row.id,
    key: row.key,
    public_join_enabled: row.public_join_enabled === 1,
    resource_limits: {
      comments: row.comment_limit,
      issues: row.issue_limit,
      principals: row.principal_limit,
    },
    restorable: row.deleted_at !== null && canManage && parentActive,
    updated_at: timestamp(row.updated_at),
    version: row.version,
    workspace_id: row.workspace_id,
    workspace_key: row.workspace_key,
  };
  if (row.deleted_at !== null) {
    resource.parent_status = { workspace: parentActive ? "active" : "deleted" };
    resource.resumed_public_projects = projectRowResumedSummary(row);
    resource.unavailability_reason = parentActive
      ? null
      : { code: "PARENT_WORKSPACE_DELETED", recovery: "restore_parent" };
  }
  return resource;
}

function projectRowResumedSummary(row: ProjectRow): { [key: string]: JsonValue } {
  if (row.public_join_enabled !== 1) return { has_more: false, projects: [] };
  if (row.usage_present !== 1 || row.public_join_public_summary === null) throw platformUnavailable("d1");
  return {
    has_more: false,
    projects: [resumedPublicProjectResource({
      active_comment_count: row.active_comment_count,
      active_issue_count: row.active_issue_count,
      active_principal_count: row.active_principal_count,
      comment_limit: row.comment_limit,
      display_name: row.display_name,
      id: row.id,
      issue_limit: row.issue_limit,
      key: row.key,
      principal_limit: row.principal_limit,
      public_summary: row.public_join_public_summary,
      workspace_key: row.workspace_key,
    })],
  };
}

function projectWriteResource(row: ProjectRow, auth: AuthContext): { [key: string]: JsonValue } {
  const { active_usage: _activeUsage, ...resource } = projectResource(row, auth);
  return resource;
}

async function readResourceSnapshot(
  db: D1Database,
  operationId: string,
): Promise<{ [key: string]: JsonValue }> {
  return readOperationSnapshot<{ [key: string]: JsonValue }>(db, operationId);
}

function updatedWorkspaceRow(
  row: WorkspaceRow,
  changes: Partial<Pick<WorkspaceRow, "deleted_at" | "display_name">>,
  now: number,
): WorkspaceRow {
  return {
    ...row,
    ...changes,
    updated_at: now,
    version: row.version + 1,
  };
}

function updatedProjectRow(
  row: ProjectRow,
  changes: Partial<Pick<ProjectRow, "context" | "deleted_at" | "display_name">>,
  now: number,
): ProjectRow {
  return {
    ...row,
    ...changes,
    updated_at: now,
    version: row.version + 1,
  };
}

async function readWorkspace(
  db: D1Database,
  key: string,
  includeDeleted = false,
  auth: AuthContext | null = null,
  now = Date.now(),
): Promise<WorkspaceRow | null> {
  try {
    const currentAuth = includeDeleted && auth !== null
      ? buildCurrentAuthGuard(auth, now, 2, true)
      : null;
    return await db.prepare(
      `SELECT id, key, display_name, version, deleted_at, created_at, updated_at
       FROM workspaces
       WHERE key = ?1 ${includeDeleted ? "" : "AND deleted_at IS NULL"}
         ${currentAuth === null ? "" : `AND ${currentAuth.sql}`}
       LIMIT 1`,
    ).bind(key, ...(currentAuth?.values ?? [])).first<WorkspaceRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function readProject(
  db: D1Database,
  workspaceKey: string,
  projectKey: string,
  includeDeleted = false,
  auth: AuthContext | null = null,
  now = Date.now(),
): Promise<ProjectRow | null> {
  try {
    const currentAuth = includeDeleted && auth !== null
      ? buildCurrentAuthGuard(auth, now, 3, true)
      : null;
    return await db.prepare(
      `SELECT p.id, p.workspace_id, w.key AS workspace_key, w.deleted_at AS workspace_deleted_at,
              p.key, p.display_name,
              p.context, p.issue_limit, p.comment_limit, p.principal_limit,
              p.version, p.deleted_at, p.created_at, p.updated_at,
              COALESCE(pu.active_issue_count, 0) AS active_issue_count,
              COALESCE(pu.active_comment_count, 0) AS active_comment_count,
              COALESCE(pu.active_principal_count, 0) AS active_principal_count,
              CASE WHEN pu.project_id IS NULL THEN 0 ELSE 1 END AS usage_present,
              pjp.public_summary AS public_join_public_summary,
              CASE WHEN pjp.enabled_at IS NOT NULL AND pjp.disabled_at IS NULL THEN 1 ELSE 0 END AS public_join_enabled
       FROM projects AS p
       JOIN workspaces AS w ON w.id = p.workspace_id
       LEFT JOIN project_usage AS pu ON pu.project_id = p.id
       LEFT JOIN public_join_policies AS pjp ON pjp.project_id = p.id
       WHERE w.key = ?1 AND p.key = ?2
         ${includeDeleted ? "" : "AND w.deleted_at IS NULL AND p.deleted_at IS NULL"}
         ${currentAuth === null ? "" : `AND ${currentAuth.sql}`}
       LIMIT 1`,
    ).bind(workspaceKey, projectKey, ...(currentAuth?.values ?? [])).first<ProjectRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function workspaceIsVisible(db: D1Database, auth: AuthContext, workspaceId: string): Promise<boolean> {
  if (canManageContainers(auth)) return true;
  return (await resolveVisibleProjects(db, auth)).some((project) => project.workspaceId === workspaceId);
}

async function projectIsVisible(db: D1Database, auth: AuthContext, projectId: string): Promise<boolean> {
  if (canManageContainers(auth)) return true;
  return (await resolveVisibleProjects(db, auth)).some((project) => project.projectId === projectId);
}

async function readWorkspacePage(
  db: D1Database,
  deleted: "exclude" | "only",
  visibleProjectIds: readonly string[] | null,
  position: [string, string] | [number, string] | null,
  limit: number,
  auth: AuthContext | null = null,
  now = Date.now(),
): Promise<WorkspaceRow[]> {
  try {
    const currentAuth = deleted === "only" && auth !== null
      ? buildCurrentAuthGuard(auth, now, 5, true)
      : null;
    const visible = visibleProjectIds === null ? null : JSON.stringify(visibleProjectIds);
    const first = position?.[0] ?? null;
    const stableId = position?.[1] ?? null;
    const result = await db.prepare(
      `SELECT id, key, display_name, version, deleted_at, created_at, updated_at
       FROM workspaces ${deleted === "only" ? "INDEXED BY idx_workspaces_tombstones" : ""}
       WHERE deleted_at IS ${deleted === "only" ? "NOT NULL" : "NULL"}
         AND (?1 IS NULL OR id IN (
           SELECT DISTINCT project_row.workspace_id
           FROM projects AS project_row
           WHERE project_row.id IN (SELECT value FROM json_each(?1))
         ))
         AND (?2 IS NULL OR ${deleted === "only"
           ? "deleted_at < ?2 OR (deleted_at = ?2 AND id < ?3)"
           : "key > ?2 OR (key = ?2 AND id > ?3)"})
         ${currentAuth === null ? "" : `AND ${currentAuth.sql}`}
       ORDER BY ${deleted === "only" ? "deleted_at DESC, id DESC" : "key, id"}
       LIMIT ?4`,
    ).bind(visible, first, stableId, limit + 1, ...(currentAuth?.values ?? [])).all<WorkspaceRow>();
    return result.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function readProjectPage(
  db: D1Database,
  workspaceKey: string,
  deleted: "exclude" | "only",
  visibleProjectIds: readonly string[] | null,
  position: [string, string] | [number, string] | null,
  limit: number,
  auth: AuthContext | null = null,
  now = Date.now(),
): Promise<ProjectRow[]> {
  try {
    const currentAuth = deleted === "only" && auth !== null
      ? buildCurrentAuthGuard(auth, now, 6, true)
      : null;
    const visible = visibleProjectIds === null ? null : JSON.stringify(visibleProjectIds);
    const first = position?.[0] ?? null;
    const stableId = position?.[1] ?? null;
    const result = await db.prepare(
      `SELECT p.id, p.workspace_id, w.key AS workspace_key, w.deleted_at AS workspace_deleted_at,
              p.key, p.display_name,
              p.context, p.issue_limit, p.comment_limit, p.principal_limit,
              p.version, p.deleted_at, p.created_at, p.updated_at,
              COALESCE(pu.active_issue_count, 0) AS active_issue_count,
              COALESCE(pu.active_comment_count, 0) AS active_comment_count,
              COALESCE(pu.active_principal_count, 0) AS active_principal_count,
              CASE WHEN pu.project_id IS NULL THEN 0 ELSE 1 END AS usage_present,
              pjp.public_summary AS public_join_public_summary,
              CASE WHEN pjp.enabled_at IS NOT NULL AND pjp.disabled_at IS NULL THEN 1 ELSE 0 END AS public_join_enabled
       FROM projects AS p ${deleted === "only" ? "INDEXED BY idx_projects_workspace_tombstones" : ""}
       JOIN workspaces AS w ON w.id = p.workspace_id
       LEFT JOIN project_usage AS pu ON pu.project_id = p.id
       LEFT JOIN public_join_policies AS pjp ON pjp.project_id = p.id
       WHERE w.key = ?1 AND p.deleted_at IS ${deleted === "only" ? "NOT NULL" : "NULL"}
         ${deleted === "only" ? "" : "AND w.deleted_at IS NULL"}
         AND (?2 IS NULL OR p.id IN (SELECT value FROM json_each(?2)))
         AND (?3 IS NULL OR ${deleted === "only"
           ? "p.deleted_at < ?3 OR (p.deleted_at = ?3 AND p.id < ?4)"
           : "p.key > ?3 OR (p.key = ?3 AND p.id > ?4)"})
         ${currentAuth === null ? "" : `AND ${currentAuth.sql}`}
       ORDER BY ${deleted === "only" ? "p.deleted_at DESC, p.id DESC" : "p.key, p.id"}
       LIMIT ?5`,
    ).bind(
      workspaceKey,
      visible,
      first,
      stableId,
      limit + 1,
      ...(currentAuth?.values ?? []),
    ).all<ProjectRow>();
    return result.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function parseCursorPosition(
  cursor: JsonValue[] | null,
  deleted: "exclude" | "only",
  keyKind: "project" | "workspace",
): [string, string] | [number, string] | null {
  if (cursor === null) return null;
  const firstValid = deleted === "only"
    ? typeof cursor[0] === "number" && Number.isSafeInteger(cursor[0]) && cursor[0] >= 0
    : typeof cursor[0] === "string" && (keyKind === "workspace"
      ? /^[a-z][a-z0-9-]{1,31}$/.test(cursor[0])
      : /^[A-Z][A-Z0-9-]{1,15}$/.test(cursor[0]));
  if (cursor.length !== 2 || !firstValid || typeof cursor[1] !== "string" || !isUuid(cursor[1])) {
    throw invalidCursor();
  }
  return cursor as [string, string] | [number, string];
}

function scopeIds(auth: AuthContext, visibleProjectIds: readonly string[]): string[] {
  return canManageContainers(auth) ? [`owner:${auth.principalId}`] : [...visibleProjectIds];
}

export async function listWorkspaces(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const deleted = requireDeletedMode(url);
  const limit = requireLimit(url);
  if (deleted === "only") requireOwnerControl(auth);
  const visibleProjects = await resolveVisibleProjects(db, auth);
  const cursorContext = await createCursorContext(
    "workspaces",
    { deleted },
    scopeIds(auth, visibleProjects.map((project) => project.projectId)),
    auth.principalId,
  );
  const position = parseCursorPosition(
    decodeCursor(url.searchParams.get("cursor"), cursorContext),
    deleted,
    "workspace",
  );
  const rows = await readWorkspacePage(
    db,
    deleted,
    canManageContainers(auth) ? null : visibleProjects.map((project) => project.projectId),
    position,
    limit,
    deleted === "only" ? auth : null,
    now,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const tail = items.at(-1);
  const result = {
    has_more: hasMore,
    items: items.map((row) => workspaceResource(row, auth)),
    next_cursor: hasMore && tail !== undefined
      ? encodeCursor(cursorContext, deleted === "only" ? [tail.deleted_at, tail.id] : [tail.key, tail.id])
      : null,
    resolved_scope: {
      deleted,
      project_ids: visibleProjects.map((project) => project.projectId),
    },
  };
  if (deleted === "only") await verifyCurrentAuth(db, auth, now);
  return result;
}

export async function getWorkspace(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const deleted = requireDeletedMode(url);
  if (deleted === "only") requireOwnerControl(auth);
  const row = await readWorkspace(
    db,
    workspaceKey,
    deleted === "only",
    deleted === "only" ? auth : null,
    now,
  );
  if (row === null && deleted === "only") await verifyCurrentAuth(db, auth, now);
  if (
    row === null
    || (deleted === "only" ? row.deleted_at === null : !(await workspaceIsVisible(db, auth, row.id)))
  ) throw notFound();
  const resource = {
    ...workspaceResource(row, auth),
    ...(deleted === "only"
      ? { resumed_public_projects: await resumedPublicProjects(db, row.id, auth, now) }
      : {}),
  };
  if (deleted === "only") await verifyCurrentAuth(db, auth, now);
  return resource;
}

export async function listProjects(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const deleted = requireDeletedMode(url);
  const limit = requireLimit(url);
  if (deleted === "only") requireOwnerControl(auth);
  const workspace = await readWorkspace(
    db,
    workspaceKey,
    deleted === "only",
    deleted === "only" ? auth : null,
    now,
  );
  if (workspace === null && deleted === "only") await verifyCurrentAuth(db, auth, now);
  if (workspace === null) throw notFound();
  const visibleProjects = await resolveVisibleProjects(db, auth);
  if (deleted === "exclude" && !canManageContainers(auth) && !visibleProjects.some((p) => p.workspaceId === workspace.id)) {
    throw notFound();
  }
  const cursorContext = await createCursorContext(
    "projects",
    { deleted, workspace_key: workspaceKey },
    scopeIds(auth, visibleProjects.map((project) => project.projectId)),
    auth.principalId,
  );
  const position = parseCursorPosition(
    decodeCursor(url.searchParams.get("cursor"), cursorContext),
    deleted,
    "project",
  );
  const rows = await readProjectPage(
    db,
    workspaceKey,
    deleted,
    canManageContainers(auth) ? null : visibleProjects.map((project) => project.projectId),
    position,
    limit,
    deleted === "only" ? auth : null,
    now,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const tail = items.at(-1);
  const result = {
    has_more: hasMore,
    items: items.map((row) => projectResource(row, auth)),
    next_cursor: hasMore && tail !== undefined
      ? encodeCursor(cursorContext, deleted === "only" ? [tail.deleted_at, tail.id] : [tail.key, tail.id])
      : null,
    resolved_scope: { deleted, workspace_key: workspaceKey },
  };
  if (deleted === "only") await verifyCurrentAuth(db, auth, now);
  return result;
}

export async function getProject(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const deleted = requireDeletedMode(url);
  if (deleted === "only") requireOwnerControl(auth);
  const row = await readProject(
    db,
    workspaceKey,
    projectKey,
    deleted === "only",
    deleted === "only" ? auth : null,
    now,
  );
  if (row === null && deleted === "only") await verifyCurrentAuth(db, auth, now);
  if (
    row === null
    || (deleted === "only" ? row.deleted_at === null : !(await projectIsVisible(db, auth, row.id)))
  ) throw notFound();
  const resource = projectResource(row, auth);
  if (deleted === "only") await verifyCurrentAuth(db, auth, now);
  return resource;
}

async function ownerGuardRejected(db: D1Database, auth: AuthContext, now: number): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, now, 1, true);
  try {
    return await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first() === null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function workspaceEvent(
  db: D1Database,
  auth: AuthContext,
  eventId: string,
  operationId: string,
  eventType: string,
  workspaceId: string,
  payload: JsonValue,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, workspace_id, subject_type,
       subject_id, payload_json, created_at)
     SELECT ?1, 'security', ?2, ?3, 0, ?4, ?5, ?6, id,
            'workspace', id, ?7, ?8
     FROM workspaces WHERE id = ?9 AND last_operation_id = ?3`,
  ).bind(
    eventId,
    eventType,
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    authorizedVia(auth, true),
    JSON.stringify(payload),
    now,
    workspaceId,
  );
}

function projectEvent(
  db: D1Database,
  auth: AuthContext,
  eventId: string,
  operationId: string,
  eventType: string,
  projectId: string,
  payload: JsonValue,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, workspace_id, project_id,
       subject_type, subject_id, payload_json, created_at)
     SELECT ?1, 'domain', ?2, ?3, 0, ?4, ?5, ?6, workspace_id, id,
            'project', id, ?7, ?8
     FROM projects WHERE id = ?9 AND last_operation_id = ?3`,
  ).bind(
    eventId,
    eventType,
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    authorizedVia(auth, true),
    JSON.stringify(payload),
    now,
    projectId,
  );
}

async function diagnoseWorkspaceCas(
  db: D1Database,
  auth: AuthContext,
  key: string,
  expectedVersion: number,
  now: number,
  expectedDeleted: boolean,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const current = await readWorkspace(db, key, true);
  if (current === null) throw notFound();
  if ((current.deleted_at !== null) !== expectedDeleted) {
    throw conflict(
      expectedDeleted ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED",
      "refresh_resource",
      { current_version: current.version },
    );
  }
  throw versionConflict(current.version === expectedVersion ? undefined : current.version);
}

async function diagnoseProjectCas(
  db: D1Database,
  auth: AuthContext,
  workspaceKey: string,
  projectKey: string,
  expectedVersion: number,
  now: number,
  expectedDeleted: boolean,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const workspace = await readWorkspace(db, workspaceKey, true);
  if (workspace === null || workspace.deleted_at !== null) throw notFound();
  const current = await readProject(db, workspaceKey, projectKey, true);
  if (current === null) throw notFound();
  if ((current.deleted_at !== null) !== expectedDeleted) {
    throw conflict(
      expectedDeleted ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED",
      "refresh_resource",
      { current_version: current.version },
    );
  }
  throw versionConflict(current.version === expectedVersion ? undefined : current.version);
}

export async function createWorkspace(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  keyValue: JsonValue,
  displayNameValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth, true);
  const key = requireWorkspaceKey(keyValue);
  const displayName = requireDisplayName(displayNameValue);
  const idempotencyKey = requireIdempotencyKey(request);
  const workspaceId = crypto.randomUUID();
  const createdRow: WorkspaceRow = {
    created_at: now,
    deleted_at: null,
    display_name: displayName,
    id: workspaceId,
    key,
    updated_at: now,
    version: 1,
  };
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await reauthenticateOwner(db, request, now, true);
      if (current.principalId !== auth.principalId) throw forbidden();
    },
    db,
    execute: async (operationId) => {
      const guard = buildCurrentAuthGuard(auth, now, 7, true);
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `INSERT INTO workspaces
                (id, key, display_name, version, created_at, updated_at,
                 created_by_principal_id, updated_by_principal_id,
                 created_operation_id, last_operation_id)
               SELECT ?1, ?2, ?3, 1, ?4, ?4, ?5, ?5, ?6, ?6
               WHERE ${guard.sql}`,
            ).bind(workspaceId, key, displayName, now, auth.principalId, operationId, ...guard.values),
            operationSnapshotStatement(db, operationId, workspaceResource(createdRow, auth)),
            workspaceEvent(db, auth, crypto.randomUUID(), operationId, "workspace.created", workspaceId, { key }, now),
          ],
          committedAt: now,
          confirmBusinessRejection: async () => (await readWorkspace(db, key, true)) !== null
            || await ownerGuardRejected(db, auth, now),
          expectedEventCount: 1,
          operationId,
          primarySubjectId: workspaceId,
          primarySubjectType: "workspace",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          await reauthenticateOwner(db, request, now, true);
          if (await readWorkspace(db, key, true)) throw conflict("WORKSPACE_KEY_CONFLICT", "choose_different_key");
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `workspace:${key}`,
    now,
    readback: async (operationId, commit) => {
      return {
        body: await writeResult(
          db,
          auth,
          await readResourceSnapshot(db, operationId),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { display_name: displayName, key },
    routeTemplate: "/api/v1/workspaces",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function updateWorkspace(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  displayNameValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const key = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const displayName = requireDisplayName(displayNameValue);
  const current = await readWorkspace(db, key);
  if (current === null) throw notFound();
  const updated = updatedWorkspaceRow(current, { display_name: displayName }, now);
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 7, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE workspaces SET display_name = ?1, version = version + 1,
                  updated_at = ?2, updated_by_principal_id = ?3, last_operation_id = ?4
           WHERE id = ?5 AND version = ?6 AND deleted_at IS NULL
             AND ${guard.sql}`,
        ).bind(displayName, now, auth.principalId, operationId, current.id, expectedVersion, ...guard.values),
        workspaceEvent(db, auth, crypto.randomUUID(), operationId, "workspace.updated", current.id, { display_name: displayName }, now),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readWorkspace(db, key, true);
        return latest === null || latest.deleted_at !== null || latest.version !== expectedVersion
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: current.id,
      primarySubjectType: "workspace",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) return diagnoseWorkspaceCas(db, auth, key, expectedVersion, now, false);
    throw error;
  }
  return writeResult(db, auth, workspaceResource(updated, auth), commit.lastEventSequence, false);
}

async function setWorkspaceDeleted(
  db: D1Database,
  auth: AuthContext,
  key: string,
  expectedVersion: number,
  now: number,
  deleted: boolean,
  operationId: string,
  persistSnapshot = false,
): Promise<{ commit: OperationCommit; row: WorkspaceRow }> {
  const current = await readWorkspace(db, key, true);
  if (current === null) throw notFound();
  const row = updatedWorkspaceRow(current, { deleted_at: deleted ? now : null }, now);
  const snapshot = persistSnapshot
    ? {
        ...workspaceResource(row, auth),
        resumed_public_projects: await resumedPublicProjects(db, current.id, auth, now),
      }
    : null;
  const guard = buildCurrentAuthGuard(auth, now, 8, true);
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE workspaces
           SET deleted_at = ?1, deleted_by_principal_id = ?2,
               version = version + 1, updated_at = ?3,
               updated_by_principal_id = ?4, last_operation_id = ?5
           WHERE id = ?6 AND version = ?7
             AND deleted_at IS ${deleted ? "NULL" : "NOT NULL"}
             AND NOT EXISTS (
               SELECT 1
               FROM projects AS invariant_project
               JOIN public_join_policies AS invariant_policy
                 ON invariant_policy.project_id = invariant_project.id
               LEFT JOIN project_usage AS invariant_usage
                 ON invariant_usage.project_id = invariant_project.id
               WHERE invariant_project.workspace_id = workspaces.id
                 AND invariant_project.deleted_at IS NULL
                 AND invariant_policy.enabled_at IS NOT NULL
                 AND invariant_policy.disabled_at IS NULL
                 AND (invariant_usage.project_id IS NULL
                   OR invariant_project.issue_limit IS NULL
                   OR invariant_project.comment_limit IS NULL
                   OR invariant_project.principal_limit IS NULL
                   OR invariant_policy.public_summary IS NULL)
             )
             AND ${guard.sql}`,
        ).bind(
          deleted ? now : null,
          deleted ? auth.principalId : null,
          now,
          auth.principalId,
          operationId,
          current.id,
          expectedVersion,
          ...guard.values,
        ),
        workspaceEvent(
          db,
          auth,
          crypto.randomUUID(),
          operationId,
          deleted ? "workspace.deleted" : "workspace.restored",
          current.id,
          { key },
          now,
        ),
        ...(snapshot === null ? [] : [operationSnapshotStatement(db, operationId, snapshot)]),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readWorkspace(db, key, true);
        return latest === null || (latest.deleted_at !== null) !== !deleted || latest.version !== expectedVersion
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: current.id,
      primarySubjectType: "workspace",
      requireIdempotencySnapshot: persistSnapshot,
    });
    return { commit, row };
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await resumedPublicProjects(db, current.id, auth, now);
      return diagnoseWorkspaceCas(db, auth, key, expectedVersion, now, !deleted);
    }
    throw error;
  }
}

function resumedPublicProjectResource(row: ResumedPublicProjectRow): { [key: string]: JsonValue } {
  if (
    row.active_comment_count === null
    || row.active_issue_count === null
    || row.active_principal_count === null
    || row.comment_limit === null
    || row.issue_limit === null
    || row.principal_limit === null
  ) throw platformUnavailable("d1");
  return {
    active_usage: {
      comments: row.active_comment_count,
      issues: row.active_issue_count,
      principals: row.active_principal_count,
    },
    display_name: row.display_name,
    id: row.id,
    key: row.key,
    public_summary: row.public_summary,
    resource_limits: {
      comments: row.comment_limit,
      issues: row.issue_limit,
      principals: row.principal_limit,
    },
    role_choices: ["reader", "writer"],
    workspace_key: row.workspace_key,
  };
}

export function workspacePublicResumeInvariantSql(currentAuthSql: string): string {
  return `SELECT policy.project_id
          FROM public_join_policies AS policy INDEXED BY idx_public_join_resume_enabled_workspace_project
          JOIN projects AS p ON p.id = policy.project_id AND p.workspace_id = policy.workspace_id
          JOIN workspaces AS workspace ON workspace.id = p.workspace_id
          LEFT JOIN project_usage AS usage ON usage.project_id = p.id
          WHERE policy.workspace_id = ?1
            AND p.deleted_at IS NULL
            AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
            AND (usage.project_id IS NULL
              OR p.issue_limit IS NULL OR p.comment_limit IS NULL OR p.principal_limit IS NULL
              OR policy.public_summary IS NULL)
            AND ${currentAuthSql}
          LIMIT 1`;
}

export function workspacePublicResumePageSql(currentAuthSql: string): string {
  return `SELECT workspace.key AS workspace_key,
                 p.id, p.key, p.display_name, policy.public_summary,
                 p.issue_limit, p.comment_limit, p.principal_limit,
                 usage.active_issue_count, usage.active_comment_count,
                 usage.active_principal_count
          FROM public_join_policies AS policy INDEXED BY idx_public_join_resume_enabled_workspace_project
          JOIN projects AS p ON p.id = policy.project_id AND p.workspace_id = policy.workspace_id
          JOIN workspaces AS workspace ON workspace.id = p.workspace_id
          JOIN project_usage AS usage ON usage.project_id = p.id
          WHERE policy.workspace_id = ?1
            AND p.deleted_at IS NULL
            AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
            AND ${currentAuthSql}
          ORDER BY policy.project_key, policy.project_id
          LIMIT 101`;
}

async function resumedPublicProjects(
  db: D1Database,
  workspaceId: string,
  auth: AuthContext,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  try {
    const currentAuth = buildCurrentAuthGuard(auth, now, 2, true);
    const invalid = await db.prepare(workspacePublicResumeInvariantSql(currentAuth.sql))
      .bind(workspaceId, ...currentAuth.values).first<{ project_id: string }>();
    if (invalid !== null) throw platformUnavailable("d1");
    const result = await db.prepare(workspacePublicResumePageSql(currentAuth.sql))
      .bind(workspaceId, ...currentAuth.values).all<ResumedPublicProjectRow>();
    return {
      has_more: result.results.length > 100,
      projects: result.results.slice(0, 100).map(resumedPublicProjectResource),
    };
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

export async function deleteWorkspace(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const key = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const { commit, row } = await setWorkspaceDeleted(
    db,
    auth,
    key,
    expectedVersion,
    now,
    true,
    crypto.randomUUID(),
  );
  return writeResult(db, auth, workspaceResource(row, auth), commit.lastEventSequence, false);
}

export async function restoreWorkspace(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const key = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await reauthenticateOwner(db, request, now);
      if (current.principalId !== auth.principalId) throw forbidden();
    },
    db,
    execute: async (operationId) => {
      await setWorkspaceDeleted(db, auth, key, expectedVersion, now, false, operationId, true);
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `workspace:${key}:restore`,
    now,
    readback: async (operationId, commit) => {
      return {
        body: await writeResult(
          db,
          auth,
          await readResourceSnapshot(db, operationId),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { expected_version: expectedVersion },
    routeTemplate: "/api/v1/workspaces/{workspace_key}/commands/restore",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function createProject(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  keyValue: JsonValue,
  displayNameValue: JsonValue,
  contextValue: JsonValue | undefined,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth, true);
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const key = requireProjectKey(keyValue);
  const displayName = requireDisplayName(displayNameValue);
  const context = requireContext(contextValue) ?? null;
  const idempotencyKey = requireIdempotencyKey(request);
  const projectId = crypto.randomUUID();
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await reauthenticateOwner(db, request, now, true);
      if (current.principalId !== auth.principalId) throw forbidden();
    },
    db,
    execute: async (operationId) => {
      const workspace = await readWorkspace(db, workspaceKey);
      if (workspace === null) throw notFound();
      const createdRow: ProjectRow = {
        active_comment_count: 0,
        active_issue_count: 0,
        active_principal_count: 0,
        comment_limit: null,
        context,
        created_at: now,
        deleted_at: null,
        display_name: displayName,
        id: projectId,
        issue_limit: null,
        key,
        principal_limit: null,
        public_join_enabled: 0,
        public_join_public_summary: null,
        updated_at: now,
        usage_present: 0,
        version: 1,
        workspace_id: workspace.id,
        workspace_deleted_at: null,
        workspace_key: workspaceKey,
      };
      const guard = buildCurrentAuthGuard(auth, now, 9, true);
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `INSERT INTO projects
                (id, workspace_id, key, display_name, context, version,
                 created_at, updated_at, created_by_principal_id,
                 updated_by_principal_id, created_operation_id, last_operation_id)
               SELECT ?1, w.id, ?2, ?3, ?4, 1, ?5, ?5, ?6, ?6, ?7, ?7
               FROM workspaces AS w
               WHERE w.key = ?8 AND w.deleted_at IS NULL AND ${guard.sql}`,
            ).bind(projectId, key, displayName, context, now, auth.principalId, operationId, workspaceKey, ...guard.values),
            operationSnapshotStatement(db, operationId, projectWriteResource(createdRow, auth)),
            projectEvent(db, auth, crypto.randomUUID(), operationId, "project.created", projectId, { key, workspace_key: workspaceKey }, now),
          ],
          committedAt: now,
          confirmBusinessRejection: async () => (await readWorkspace(db, workspaceKey)) === null
            || (await readProject(db, workspaceKey, key, true)) !== null
            || await ownerGuardRejected(db, auth, now),
          expectedEventCount: 1,
          operationId,
          primarySubjectId: projectId,
          primarySubjectType: "project",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          await reauthenticateOwner(db, request, now, true);
          if (await readWorkspace(db, workspaceKey) === null) throw notFound();
          if (await readProject(db, workspaceKey, key, true)) throw conflict("PROJECT_KEY_CONFLICT", "choose_different_key");
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `workspace:${workspaceKey}:project:${key}`,
    now,
    readback: async (operationId, commit) => {
      return {
        body: await writeResult(
          db,
          auth,
          await readResourceSnapshot(db, operationId),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { context, display_name: displayName, key },
    routeTemplate: "/api/v1/workspaces/{workspace_key}/projects",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function updateProject(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  displayNameValue: JsonValue | undefined,
  contextValue: JsonValue | undefined,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  if (displayNameValue === undefined && contextValue === undefined) throw validationError("update_field_required");
  const displayName = displayNameValue === undefined ? null : requireDisplayName(displayNameValue);
  const context = requireContext(contextValue);
  const current = await readProject(db, workspaceKey, projectKey);
  if (current === null) throw notFound();
  const updated = updatedProjectRow(current, {
    ...(contextValue === undefined ? {} : { context: context ?? null }),
    ...(displayNameValue === undefined ? {} : { display_name: displayName ?? current.display_name }),
  }, now);
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 11, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE projects
           SET display_name = CASE WHEN ?1 = 1 THEN ?2 ELSE display_name END,
               context = CASE WHEN ?3 = 1 THEN ?4 ELSE context END,
               version = version + 1, updated_at = ?5,
               updated_by_principal_id = ?6, last_operation_id = ?7
           WHERE id = ?8 AND workspace_id = ?9 AND version = ?10
             AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM workspaces parent_workspace
               WHERE parent_workspace.id = projects.workspace_id
                 AND parent_workspace.deleted_at IS NULL
             )
             AND ${guard.sql}`,
        ).bind(
          displayNameValue === undefined ? 0 : 1,
          displayName,
          contextValue === undefined ? 0 : 1,
          context ?? null,
          now,
          auth.principalId,
          operationId,
          current.id,
          current.workspace_id,
          expectedVersion,
          ...guard.values,
        ),
        projectEvent(
          db,
          auth,
          crypto.randomUUID(),
          operationId,
          "project.updated",
          current.id,
          { context_changed: contextValue !== undefined, display_name_changed: displayNameValue !== undefined },
          now,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readProject(db, workspaceKey, projectKey, true);
        return latest === null || latest.deleted_at !== null || latest.version !== expectedVersion
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: current.id,
      primarySubjectType: "project",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnoseProjectCas(db, auth, workspaceKey, projectKey, expectedVersion, now, false);
    }
    throw error;
  }
  return writeResult(db, auth, projectWriteResource(updated, auth), commit.lastEventSequence, false);
}

async function setProjectDeleted(
  db: D1Database,
  auth: AuthContext,
  workspaceKey: string,
  projectKey: string,
  expectedVersion: number,
  now: number,
  deleted: boolean,
  operationId: string,
  persistSnapshot = false,
): Promise<{ commit: OperationCommit; row: ProjectRow }> {
  const current = await readProject(db, workspaceKey, projectKey, true);
  if (current === null) throw notFound();
  const workspace = await readWorkspace(db, workspaceKey, true);
  if (workspace === null || workspace.deleted_at !== null) throw notFound();
  const resumedSummary = projectRowResumedSummary(current);
  const row = updatedProjectRow(current, { deleted_at: deleted ? now : null }, now);
  const snapshot = persistSnapshot
    ? {
        ...projectWriteResource(row, auth),
        resumed_public_projects: resumedSummary,
      }
    : null;
  const guard = buildCurrentAuthGuard(auth, now, 9, true);
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE projects
           SET deleted_at = ?1, deleted_by_principal_id = ?2,
               version = version + 1, updated_at = ?3,
               updated_by_principal_id = ?4, last_operation_id = ?5
           WHERE id = ?6 AND version = ?7
             AND deleted_at IS ${deleted ? "NULL" : "NOT NULL"}
             AND EXISTS (
               SELECT 1 FROM workspaces AS parent_workspace
               WHERE parent_workspace.id = projects.workspace_id
                 AND parent_workspace.key = ?8
                 AND parent_workspace.deleted_at IS NULL
             )
             AND NOT EXISTS (
               SELECT 1
               FROM public_join_policies AS invariant_policy
               LEFT JOIN project_usage AS invariant_usage
                 ON invariant_usage.project_id = invariant_policy.project_id
               WHERE invariant_policy.project_id = projects.id
                 AND invariant_policy.enabled_at IS NOT NULL
                 AND invariant_policy.disabled_at IS NULL
                 AND (invariant_usage.project_id IS NULL
                   OR projects.issue_limit IS NULL
                   OR projects.comment_limit IS NULL
                   OR projects.principal_limit IS NULL
                   OR invariant_policy.public_summary IS NULL)
             )
             AND ${guard.sql}`,
        ).bind(
          deleted ? now : null,
          deleted ? auth.principalId : null,
          now,
          auth.principalId,
          operationId,
          current.id,
          expectedVersion,
          workspaceKey,
          ...guard.values,
        ),
        projectEvent(
          db,
          auth,
          crypto.randomUUID(),
          operationId,
          deleted ? "project.deleted" : "project.restored",
          current.id,
          { project_key: projectKey, workspace_key: workspaceKey },
          now,
        ),
        ...(snapshot === null ? [] : [operationSnapshotStatement(db, operationId, snapshot)]),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readProject(db, workspaceKey, projectKey, true);
        const latestWorkspace = await readWorkspace(db, workspaceKey, true);
        return latestWorkspace === null || latestWorkspace.deleted_at !== null
          || latest === null || (latest.deleted_at !== null) !== !deleted || latest.version !== expectedVersion
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: current.id,
      primarySubjectType: "project",
      requireIdempotencySnapshot: persistSnapshot,
    });
    return { commit, row };
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const latest = await readProject(db, workspaceKey, projectKey, true);
      if (latest !== null) projectRowResumedSummary(latest);
      return diagnoseProjectCas(db, auth, workspaceKey, projectKey, expectedVersion, now, !deleted);
    }
    throw error;
  }
}

export async function deleteProject(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const { commit, row } = await setProjectDeleted(
    db,
    auth,
    workspaceKey,
    projectKey,
    expectedVersion,
    now,
    true,
    crypto.randomUUID(),
  );
  return writeResult(db, auth, projectWriteResource(row, auth), commit.lastEventSequence, false);
}

export async function restoreProject(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await reauthenticateOwner(db, request, now);
      if (current.principalId !== auth.principalId) throw forbidden();
    },
    db,
    execute: async (operationId) => {
      const workspace = await readWorkspace(db, workspaceKey);
      if (workspace === null) throw conflict("PARENT_WORKSPACE_DELETED", "restore_parent");
      await setProjectDeleted(db, auth, workspaceKey, projectKey, expectedVersion, now, false, operationId, true);
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `workspace:${workspaceKey}:project:${projectKey}:restore`,
    now,
    readback: async (operationId, commit) => {
      return {
        body: await writeResult(
          db,
          auth,
          await readResourceSnapshot(db, operationId),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { expected_version: expectedVersion },
    routeTemplate: "/api/v1/workspaces/{workspace_key}/projects/{project_key}/commands/restore",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function listStatuses(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const project = await readProject(db, workspaceKey, projectKey);
  if (project === null || !(await projectIsVisible(db, auth, project.id))) throw notFound();
  let overrides: StatusNameRow[];
  try {
    const result = await db.prepare(
      `SELECT status_key, display_name FROM project_status_names
       WHERE project_id = ?1 ORDER BY status_key`,
    ).bind(project.id).all<StatusNameRow>();
    overrides = result.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
  const names = new Map(overrides.map((row) => [row.status_key, row.display_name]));
  return {
    has_more: false,
    items: WORKFLOW_STATUSES.map((status) => ({
      category: status.category,
      display_name: names.get(status.key) ?? status.displayName,
      key: status.key,
      position: status.position,
      project_id: project.id,
      terminal: status.terminal,
      version: project.version,
    })),
    next_cursor: null,
    resolved_scope: { project_key: projectKey, workspace_key: workspaceKey },
  };
}

export async function updateStatusName(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  statusKeyValue: JsonValue,
  displayNameValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  if (!isStatusKey(statusKeyValue)) throw notFound();
  const statusKey = statusKeyValue;
  const displayName = requireDisplayName(displayNameValue);
  const project = await readProject(db, workspaceKey, projectKey);
  if (project === null) throw notFound();
  const updated = updatedProjectRow(project, {}, now);
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 6, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE projects
           SET version = version + 1, updated_at = ?1,
               updated_by_principal_id = ?2, last_operation_id = ?3
           WHERE id = ?4 AND version = ?5 AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM workspaces parent_workspace
               WHERE parent_workspace.id = projects.workspace_id
                 AND parent_workspace.deleted_at IS NULL
             )
             AND ${guard.sql}`,
        ).bind(now, auth.principalId, operationId, project.id, expectedVersion, ...guard.values),
        db.prepare(
          `INSERT INTO project_status_names
            (project_id, status_key, display_name, updated_at,
             updated_by_principal_id, last_operation_id)
           SELECT id, ?1, ?2, ?3, ?4, ?5 FROM projects
           WHERE id = ?6 AND last_operation_id = ?5
           ON CONFLICT(project_id, status_key) DO UPDATE SET
             display_name = excluded.display_name,
             updated_at = excluded.updated_at,
             updated_by_principal_id = excluded.updated_by_principal_id,
             last_operation_id = excluded.last_operation_id`,
        ).bind(statusKey, displayName, now, auth.principalId, operationId, project.id),
        projectEvent(db, auth, crypto.randomUUID(), operationId, "project.status-name-updated", project.id, { display_name: displayName, status_key: statusKey }, now),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readProject(db, workspaceKey, projectKey, true);
        return latest === null || latest.deleted_at !== null || latest.version !== expectedVersion
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: project.id,
      primarySubjectType: "project",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnoseProjectCas(db, auth, workspaceKey, projectKey, expectedVersion, now, false);
    }
    throw error;
  }
  const definition = WORKFLOW_STATUSES.find((status) => status.key === statusKey);
  if (definition === undefined) throw platformUnavailable();
  return writeResult(db, auth, {
    category: definition.category,
    created_at: timestamp(updated.created_at),
    deleted_at: null,
    display_name: displayName,
    id: updated.id,
    key: statusKey,
    position: definition.position,
    project_id: updated.id,
    terminal: definition.terminal,
    updated_at: timestamp(updated.updated_at),
    version: updated.version,
  }, commit.lastEventSequence, false);
}
