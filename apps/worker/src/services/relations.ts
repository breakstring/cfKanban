import { requireUuid, timestamp } from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  resolveVisibleProjects,
  verifyCurrentAuth,
  type VisibleProject,
} from "../kernel/authorization.ts";
import {
  createCursorContext,
  cursorScopeMismatch,
  decodeCursor,
  encodeCursor,
  invalidCursor,
} from "../kernel/cursor.ts";
import { isUuid } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import { ApiError, conflict, forbidden, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  buildTwoProjectWriterGuard,
  requireCollaborationIssue,
  requireCollaborationIssueAuthorization,
  requireRelationKind,
  roleCanWrite,
  type CollaborationIssue,
  type RelationKind,
} from "./collaboration-shared.ts";
import {
  actorCredentialId,
  authorizedVia,
  requireDeletedMode,
  requireIdempotencyKey,
  requireLimit,
  writeResult,
} from "./shared.ts";

interface RelationRow {
  created_at: number;
  created_by_principal_id: string;
  deleted_at: number | null;
  deleted_by_principal_id: string | null;
  id: string;
  kind: RelationKind;
  last_operation_id: string | null;
  source_id: string;
  source_deleted_at: number | null;
  source_number: number;
  source_project_id: string;
  source_project_deleted_at: number | null;
  source_project_key: string;
  source_project_name: string;
  source_title: string;
  source_version: number;
  target_id: string;
  target_deleted_at: number | null;
  target_number: number;
  target_project_id: string;
  target_project_deleted_at: number | null;
  target_project_key: string;
  target_project_name: string;
  target_title: string;
  target_version: number;
  version: number;
  workspace_id: string;
  workspace_deleted_at: number | null;
  workspace_key: string;
  workspace_name: string;
}

interface RelationAccess {
  canWrite: boolean;
  row: RelationRow;
}

interface CurrentRelationAccessRow extends RelationRow {
  source_can_read: number;
  source_can_write: number;
  target_can_read: number;
  target_can_write: number;
}

function endpointResource(row: RelationRow, source: boolean): { [key: string]: JsonValue } {
  return source ? {
    id: row.source_id,
    identifier: `CFK-${row.source_number}`,
    project: {
      id: row.source_project_id,
      key: row.source_project_key,
      workspace_key: row.workspace_key,
    },
    title: row.source_title,
    version: row.source_version,
  } : {
    id: row.target_id,
    identifier: `CFK-${row.target_number}`,
    project: {
      id: row.target_project_id,
      key: row.target_project_key,
      workspace_key: row.workspace_key,
    },
    title: row.target_title,
    version: row.target_version,
  };
}

function relationResource(row: RelationRow, canWrite: boolean): { [key: string]: JsonValue } {
  const unavailabilityReason = row.workspace_deleted_at !== null
    ? { code: "PARENT_WORKSPACE_DELETED", recovery: "restore_parent" }
    : row.source_project_deleted_at !== null || row.target_project_deleted_at !== null
      ? { code: "PARENT_PROJECT_DELETED", recovery: "restore_parent" }
      : row.source_deleted_at !== null || row.target_deleted_at !== null
        ? { code: "RELATION_ENDPOINT_DELETED", recovery: "restore_endpoint" }
        : null;
  const restorable = row.deleted_at !== null && canWrite && unavailabilityReason === null;
  return {
    allowed_actions: canWrite
      ? row.deleted_at === null ? ["read", "delete"] : restorable ? ["read", "restore"] : ["read"]
      : ["read"],
    created_at: timestamp(row.created_at),
    created_by_principal_id: row.created_by_principal_id,
    deleted_at: timestamp(row.deleted_at),
    deleted_by_principal_id: row.deleted_by_principal_id,
    id: row.id,
    kind: row.kind,
    source: endpointResource(row, true),
    target: endpointResource(row, false),
    version: row.version,
    workspace: {
      id: row.workspace_id,
      key: row.workspace_key,
    },
    ...(row.deleted_at === null ? {} : {
      parent_status: {
        source_issue: row.source_deleted_at === null ? "active" : "deleted",
        source_project: row.source_project_deleted_at === null ? "active" : "deleted",
        target_issue: row.target_deleted_at === null ? "active" : "deleted",
        target_project: row.target_project_deleted_at === null ? "active" : "deleted",
        workspace: row.workspace_deleted_at === null ? "active" : "deleted",
      },
      restorable,
      unavailability_reason: unavailabilityReason,
    }),
  };
}

const RELATION_SELECT = `
  SELECT relation.id, relation.workspace_id, relation.kind,
         relation.version, relation.deleted_at, relation.deleted_by_principal_id,
         relation.created_at, relation.created_by_principal_id,
         relation.last_operation_id,
         workspace.key AS workspace_key, workspace.display_name AS workspace_name,
         workspace.deleted_at AS workspace_deleted_at,
         source.id AS source_id, source.number AS source_number,
         source.deleted_at AS source_deleted_at,
         source.title AS source_title, source.version AS source_version,
         source.project_id AS source_project_id,
         source_project.deleted_at AS source_project_deleted_at,
         source_project.key AS source_project_key,
         source_project.display_name AS source_project_name,
         target.id AS target_id, target.number AS target_number,
         target.deleted_at AS target_deleted_at,
         target.title AS target_title, target.version AS target_version,
         target.project_id AS target_project_id,
         target_project.deleted_at AS target_project_deleted_at,
         target_project.key AS target_project_key,
         target_project.display_name AS target_project_name
  FROM issue_relations relation
  JOIN workspaces workspace ON workspace.id = relation.workspace_id
  JOIN issues source ON source.id = relation.source_issue_id
  JOIN projects source_project ON source_project.id = source.project_id
  JOIN issues target ON target.id = relation.target_issue_id
  JOIN projects target_project ON target_project.id = target.project_id`;

function deletedRelationListSql(withCursor: boolean, authGuardSql: string): string {
  const cursorPredicate = withCursor
    ? "AND (relation.deleted_at, relation.id) < (?3, ?4)"
    : "";
  const limitParameter = withCursor ? "?5" : "?3";
  const principalParameter = withCursor ? "?6" : "?4";
  return `WITH current_writer_projects(id) AS MATERIALIZED (
           SELECT current_project.id
           FROM projects current_project
           JOIN workspaces current_workspace ON current_workspace.id = current_project.workspace_id
           JOIN instance_meta current_instance ON current_instance.singleton = 1
           WHERE current_project.id IN (SELECT value FROM json_each(?2))
             AND ${authGuardSql}
             AND (
               current_instance.owner_principal_id = ${principalParameter}
               OR (
                 current_project.deleted_at IS NULL
                 AND current_workspace.deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM project_grants current_grant
                   WHERE current_grant.project_id = current_project.id
                     AND current_grant.principal_id = ${principalParameter}
                     AND current_grant.role = 'writer'
                     AND current_grant.revoked_at IS NULL
                 )
               )
             )
         ), source_candidates AS (
           SELECT relation.id, relation.deleted_at
           FROM issue_relations relation INDEXED BY idx_issue_relations_source_tombstones_visible
           WHERE relation.source_issue_id = ?1 AND relation.deleted_at IS NOT NULL
             AND relation.target_project_id IN (SELECT id FROM current_writer_projects)
             ${cursorPredicate}
           ORDER BY relation.deleted_at DESC, relation.id DESC
           LIMIT ${limitParameter}
         ), target_candidates AS (
           SELECT relation.id, relation.deleted_at
           FROM issue_relations relation INDEXED BY idx_issue_relations_target_tombstones_visible
           WHERE relation.target_issue_id = ?1 AND relation.deleted_at IS NOT NULL
             AND relation.source_project_id IN (SELECT id FROM current_writer_projects)
             ${cursorPredicate}
           ORDER BY relation.deleted_at DESC, relation.id DESC
           LIMIT ${limitParameter}
         ), candidate_relations AS (
           SELECT id, deleted_at FROM source_candidates
           UNION ALL
           SELECT id, deleted_at FROM target_candidates
           ORDER BY deleted_at DESC, id DESC
           LIMIT ${limitParameter}
         )
         ${RELATION_SELECT}
         JOIN candidate_relations candidate ON candidate.id = relation.id
         WHERE relation.source_project_id = source.project_id
           AND relation.target_project_id = target.project_id
           AND source.project_id IN (SELECT id FROM current_writer_projects)
           AND target.project_id IN (SELECT id FROM current_writer_projects)
         ORDER BY relation.deleted_at DESC, relation.id DESC`;
}

function activeRelationListSql(authGuardSql: string): string {
  return `WITH current_visible_projects(id) AS MATERIALIZED (
           SELECT current_project.id
           FROM projects current_project
           JOIN workspaces current_workspace ON current_workspace.id = current_project.workspace_id
           JOIN instance_meta current_instance ON current_instance.singleton = 1
           WHERE current_project.id IN (SELECT value FROM json_each(?2))
             AND current_project.deleted_at IS NULL
             AND current_workspace.deleted_at IS NULL
             AND ${authGuardSql}
             AND (
               current_instance.owner_principal_id = ?6
               OR EXISTS (
                 SELECT 1 FROM project_grants current_grant
                 WHERE current_grant.project_id = current_project.id
                   AND current_grant.principal_id = ?6
                   AND current_grant.revoked_at IS NULL
               )
             )
         )
         ${RELATION_SELECT}
         WHERE (relation.source_issue_id = ?1 OR relation.target_issue_id = ?1)
           AND relation.source_project_id = source.project_id
           AND relation.target_project_id = target.project_id
           AND relation.deleted_at IS NULL
           AND workspace.deleted_at IS NULL
           AND source.deleted_at IS NULL AND target.deleted_at IS NULL
           AND source_project.deleted_at IS NULL AND target_project.deleted_at IS NULL
           AND source.project_id IN (SELECT id FROM current_visible_projects)
           AND target.project_id IN (SELECT id FROM current_visible_projects)
           AND (?3 IS NULL OR relation.created_at > ?3
                OR (relation.created_at = ?3 AND relation.id > ?4))
         ORDER BY relation.created_at ASC, relation.id ASC
         LIMIT ?5`;
}

async function readRelation(
  db: D1Database,
  relationId: string,
  includeEffectiveDeleted = false,
): Promise<RelationRow | null> {
  try {
    return await db.prepare(
      `${RELATION_SELECT}
       WHERE relation.id = ?1
         ${includeEffectiveDeleted ? "" : `AND workspace.deleted_at IS NULL
         AND source.deleted_at IS NULL AND target.deleted_at IS NULL
         AND source_project.deleted_at IS NULL AND target_project.deleted_at IS NULL`}
       LIMIT 1`,
    ).bind(relationId).first<RelationRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function requireRelationAccess(
  db: D1Database,
  auth: AuthContext,
  relationIdValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
  includeEffectiveDeleted = false,
  includeDeletedParentsForRecoveryView = includeEffectiveDeleted,
): Promise<RelationAccess> {
  const relationId = requireUuid(relationIdValue, "relation_id");
  const [row, projects] = await Promise.all([
    readRelation(db, relationId, includeEffectiveDeleted),
    resolveVisibleProjects(db, auth, includeDeletedParentsForRecoveryView && auth.isOwner),
  ]);
  if (row === null) throw notFound();
  const sourceRole = projects.find((project) => project.projectId === row.source_project_id)?.role;
  const targetRole = projects.find((project) => project.projectId === row.target_project_id)?.role;
  if (sourceRole === undefined || targetRole === undefined) throw notFound();
  const canWrite = roleCanWrite(sourceRole) && roleCanWrite(targetRole);
  if (requiredRole === "writer" && !canWrite) throw forbidden();
  return { canWrite, row };
}

async function readCurrentRelationAccess(
  db: D1Database,
  auth: AuthContext,
  relationId: string,
  projectIds: readonly string[],
  deletedMode: "exclude" | "only",
  now: number,
): Promise<CurrentRelationAccessRow | null> {
  const authGuard = buildCurrentAuthGuard(auth, now, 4);
  const endpointAccess = (endpoint: "source" | "target", write: boolean) => `CASE
    WHEN current_instance.owner_principal_id = ?3 THEN 1
    WHEN relation_row.${endpoint}_project_deleted_at IS NULL
      AND relation_row.workspace_deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM project_grants endpoint_grant
        WHERE endpoint_grant.project_id = relation_row.${endpoint}_project_id
          AND endpoint_grant.principal_id = ?3
          ${write ? "AND endpoint_grant.role = 'writer'" : ""}
          AND endpoint_grant.revoked_at IS NULL
      ) THEN 1
    ELSE 0 END`;
  try {
    return await db.prepare(
      `WITH relation_row AS MATERIALIZED (
         ${RELATION_SELECT}
         WHERE relation.id = ?1
           AND source.project_id IN (SELECT value FROM json_each(?2))
           AND target.project_id IN (SELECT value FROM json_each(?2))
           AND relation.source_project_id = source.project_id
           AND relation.target_project_id = target.project_id
           AND source_project.workspace_id = relation.workspace_id
           AND target_project.workspace_id = relation.workspace_id
           AND relation.deleted_at IS ${deletedMode === "only" ? "NOT NULL" : "NULL"}
           ${deletedMode === "only" ? "" : `AND workspace.deleted_at IS NULL
           AND source.deleted_at IS NULL AND target.deleted_at IS NULL
           AND source_project.deleted_at IS NULL AND target_project.deleted_at IS NULL`}
         LIMIT 1
       )
       SELECT relation_row.*,
              ${endpointAccess("source", false)} AS source_can_read,
              ${endpointAccess("source", true)} AS source_can_write,
              ${endpointAccess("target", false)} AS target_can_read,
              ${endpointAccess("target", true)} AS target_can_write
       FROM relation_row
       JOIN instance_meta current_instance ON current_instance.singleton = 1
       WHERE ${authGuard.sql}
       LIMIT 1`,
    ).bind(
      relationId,
      JSON.stringify(projectIds),
      auth.principalId,
      ...authGuard.values,
    ).first<CurrentRelationAccessRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function parseRelationCursor(last: JsonValue[] | null): [number, string] | null {
  if (last === null) return null;
  if (
    last.length !== 2
    || typeof last[0] !== "number"
    || !Number.isSafeInteger(last[0])
    || last[0] < 0
    || typeof last[1] !== "string"
    || !isUuid(last[1])
  ) throw invalidCursor();
  return [last[0], last[1]];
}

function relationSnapshotStatement(
  db: D1Database,
  operationId: string,
  relationId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT json_object(
         'created_at', relation.created_at,
         'created_by_principal_id', relation.created_by_principal_id,
         'deleted_at', relation.deleted_at,
         'deleted_by_principal_id', relation.deleted_by_principal_id,
         'id', relation.id,
         'kind', relation.kind,
         'last_operation_id', relation.last_operation_id,
         'source_id', source.id,
         'source_deleted_at', source.deleted_at,
         'source_number', source.number,
         'source_project_id', source.project_id,
         'source_project_deleted_at', source_project.deleted_at,
         'source_project_key', source_project.key,
         'source_project_name', source_project.display_name,
         'source_title', source.title,
         'source_version', source.version,
         'target_id', target.id,
         'target_deleted_at', target.deleted_at,
         'target_number', target.number,
         'target_project_id', target.project_id,
         'target_project_deleted_at', target_project.deleted_at,
         'target_project_key', target_project.key,
         'target_project_name', target_project.display_name,
         'target_title', target.title,
         'target_version', target.version,
         'version', relation.version,
         'workspace_id', workspace.id,
         'workspace_deleted_at', workspace.deleted_at,
         'workspace_key', workspace.key,
         'workspace_name', workspace.display_name
       )
       FROM issue_relations relation
       JOIN workspaces workspace ON workspace.id = relation.workspace_id
       JOIN issues source ON source.id = relation.source_issue_id
       JOIN projects source_project ON source_project.id = source.project_id
       JOIN issues target ON target.id = relation.target_issue_id
       JOIN projects target_project ON target_project.id = target.project_id
       WHERE relation.id = ?2 AND relation.last_operation_id = ?1
         AND source.last_operation_id = ?1 AND target.last_operation_id = ?1
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, relationId);
}

function relationEvent(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  relationId: string,
  projectId: string,
  otherProjectId: string,
  eventIndex: number,
  type: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, grant_id, workspace_id,
       project_id, relation_other_project_id, subject_type, subject_id, payload_json, created_at)
     SELECT ?1, 'domain', ?2, ?3, ?4, ?5, ?6, ?7,
            CASE WHEN ?8 = 1 THEN NULL ELSE (
              SELECT grant_row.id FROM project_grants grant_row
              WHERE grant_row.project_id = ?9
                AND grant_row.principal_id = ?5
                AND grant_row.role = 'writer' AND grant_row.revoked_at IS NULL
              LIMIT 1
            ) END,
            relation.workspace_id, ?9, ?10, 'relation', relation.id,
            json_object(
              'kind', relation.kind,
              'lifecycle', ?11,
              'relation_version', relation.version,
              'source_identifier', 'CFK-' || source.number,
              'source_version', source.version,
              'target_identifier', 'CFK-' || target.number,
              'target_version', target.version
            ), ?12
     FROM issue_relations relation
     JOIN issues source ON source.id = relation.source_issue_id
     JOIN issues target ON target.id = relation.target_issue_id
     WHERE relation.id = ?13 AND relation.last_operation_id = ?3
       AND source.last_operation_id = ?3 AND target.last_operation_id = ?3
       AND ?9 IN (source.project_id, target.project_id)`,
  ).bind(
    crypto.randomUUID(),
    type,
    operationId,
    eventIndex,
    auth.principalId,
    actorCredentialId(auth),
    authorizedVia(auth),
    auth.isOwner ? 1 : 0,
    projectId,
    otherProjectId,
    type.endsWith("created") ? "created" : type.endsWith("deleted") ? "deleted" : "restored",
    now,
    relationId,
  );
}

function relationEvents(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  relationId: string,
  sourceProjectId: string,
  targetProjectId: string,
  type: string,
  now: number,
): D1PreparedStatement[] {
  const projectIds = sourceProjectId === targetProjectId
    ? [sourceProjectId]
    : [sourceProjectId, targetProjectId].sort();
  return projectIds.map((projectId, index) => relationEvent(
    db,
    auth,
    operationId,
    relationId,
    projectId,
    projectId === sourceProjectId ? targetProjectId : sourceProjectId,
    index,
    type,
    now,
  ));
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

function validateRelationEndpoints(source: CollaborationIssue, target: CollaborationIssue): void {
  if (source.id === target.id) throw validationError("relation_self_reference");
  if (source.workspaceId !== target.workspaceId) throw validationError("relation_cross_workspace");
}

function canonicalRelation(
  kind: RelationKind,
  source: CollaborationIssue,
  target: CollaborationIssue,
  sourceExpectedVersion: number,
  targetExpectedVersion: number,
): {
  source: CollaborationIssue;
  sourceExpectedVersion: number;
  target: CollaborationIssue;
  targetExpectedVersion: number;
} {
  if (kind !== "related" || source.id < target.id) {
    return { source, sourceExpectedVersion, target, targetExpectedVersion };
  }
  return {
    source: target,
    sourceExpectedVersion: targetExpectedVersion,
    target: source,
    targetExpectedVersion: sourceExpectedVersion,
  };
}

async function existingRelation(
  db: D1Database,
  kind: RelationKind,
  sourceId: string,
  targetId: string,
): Promise<{ deleted_at: number | null; id: string } | null> {
  try {
    return await db.prepare(
      `SELECT id, deleted_at FROM issue_relations
       WHERE kind = ?1 AND source_issue_id = ?2 AND target_issue_id = ?3
       LIMIT 1`,
    ).bind(kind, sourceId, targetId).first();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

export async function listIssueRelations(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const deletedMode = requireDeletedMode(url);
  const issue = deletedMode === "only"
    ? await requireCollaborationIssueAuthorization(db, auth, identifierValue, "writer", true)
    : await requireCollaborationIssue(db, auth, identifierValue, "reader");
  const visibleProjects = await resolveVisibleProjects(db, auth, deletedMode === "only" && auth.isOwner);
  const visibleIds = visibleProjects.map((project) => project.projectId);
  const writerIds = visibleProjects.filter((project) => roleCanWrite(project.role))
    .map((project) => project.projectId);
  const cursorProjectIds = deletedMode === "only" ? writerIds : visibleIds;
  const context = await createCursorContext(
    "relations",
    { deleted: deletedMode, issue_id: issue.id },
    cursorProjectIds,
    auth.principalId,
  );
  const cursor = parseRelationCursor(decodeCursor(url.searchParams.get("cursor"), context));
  const limit = requireLimit(url);
  const authGuard = buildCurrentAuthGuard(
    auth,
    now,
    deletedMode === "only" && cursor === null ? 5 : 7,
  );
  let rows: RelationRow[];
  try {
    const result = deletedMode === "only"
      ? cursor === null
        ? await db.prepare(deletedRelationListSql(false, authGuard.sql)).bind(
          issue.id,
          JSON.stringify(writerIds),
          limit + 1,
          auth.principalId,
          ...authGuard.values,
        ).all<RelationRow>()
        : await db.prepare(deletedRelationListSql(true, authGuard.sql)).bind(
          issue.id,
          JSON.stringify(writerIds),
          cursor[0],
          cursor[1],
          limit + 1,
          auth.principalId,
          ...authGuard.values,
        ).all<RelationRow>()
      : await db.prepare(activeRelationListSql(authGuard.sql)).bind(
        issue.id,
        JSON.stringify(visibleIds),
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        limit + 1,
        auth.principalId,
        ...authGuard.values,
      ).all<RelationRow>();
    rows = result.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
  await verifyCurrentAuth(db, auth, now);
  const currentVisibleProjects = await resolveVisibleProjects(
    db,
    auth,
    deletedMode === "only" && auth.isOwner,
  );
  const currentVisibleIds = currentVisibleProjects.map((project) => project.projectId);
  const currentWriterIds = currentVisibleProjects.filter((project) => roleCanWrite(project.role))
    .map((project) => project.projectId);
  const currentProjectIds = deletedMode === "only" ? currentWriterIds : currentVisibleIds;
  const previousCursorIds = [...cursorProjectIds].sort();
  const nextCursorIds = [...currentProjectIds].sort();
  const previousVisibleIds = [...visibleIds].sort();
  const nextVisibleIds = [...currentVisibleIds].sort();
  if (
    previousCursorIds.length !== nextCursorIds.length
    || previousCursorIds.some((projectId, index) => projectId !== nextCursorIds[index])
    || previousVisibleIds.length !== nextVisibleIds.length
    || previousVisibleIds.some((projectId, index) => projectId !== nextVisibleIds[index])
  ) throw cursorScopeMismatch();
  const currentProjectIdSet = new Set(currentProjectIds);
  const currentIssueProject = currentVisibleProjects.find((project) => project.projectId === issue.projectId);
  if (currentIssueProject === undefined) throw notFound();
  if (deletedMode === "only" && !roleCanWrite(currentIssueProject.role)) throw forbidden();
  const authorizedRows = rows.filter((row) => currentProjectIdSet.has(row.source_project_id)
    && currentProjectIdSet.has(row.target_project_id));
  const responseContext = await createCursorContext(
    "relations",
    { deleted: deletedMode, issue_id: issue.id },
    currentProjectIds,
    auth.principalId,
  );
  const roles = new Map(currentVisibleProjects.map((project) => [project.projectId, project.role]));
  const hasMore = authorizedRows.length > limit;
  const page = authorizedRows.slice(0, limit);
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: page.map((row) => relationResource(
      row,
      roleCanWrite(roles.get(row.source_project_id) ?? "reader")
        && roleCanWrite(roles.get(row.target_project_id) ?? "reader"),
    )),
    next_cursor: hasMore && tail !== undefined
      ? encodeCursor(responseContext, [deletedMode === "only" ? tail.deleted_at ?? 0 : tail.created_at, tail.id])
      : null,
    resolved_scope: {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      visible_project_ids: currentVisibleIds,
    },
  };
}

export async function getRelation(
  db: D1Database,
  auth: AuthContext,
  relationIdValue: JsonValue,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const deletedMode = requireDeletedMode(url);
  const relationId = requireUuid(relationIdValue, "relation_id");
  const projects = await resolveVisibleProjects(
    db,
    auth,
    deletedMode === "only" && auth.isOwner,
  );
  const row = await readCurrentRelationAccess(
    db,
    auth,
    relationId,
    projects.map((project) => project.projectId),
    deletedMode,
    now,
  );
  if (row === null) {
    await verifyCurrentAuth(db, auth, now);
    throw notFound();
  }
  const canRead = row.source_can_read === 1 && row.target_can_read === 1;
  const canWrite = row.source_can_write === 1 && row.target_can_write === 1;
  if (!canRead) throw notFound();
  if (deletedMode === "only" && !canWrite) throw forbidden();
  return relationResource(row, canWrite);
}

async function diagnoseRelationCreate(
  db: D1Database,
  auth: AuthContext,
  sourceIdentifier: string,
  targetIdentifier: string,
  kind: RelationKind,
  sourceExpectedVersion: number,
  targetExpectedVersion: number,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const [source, target] = await Promise.all([
    requireCollaborationIssue(db, auth, sourceIdentifier, "writer"),
    requireCollaborationIssue(db, auth, targetIdentifier, "writer"),
  ]);
  validateRelationEndpoints(source, target);
  if (source.version !== sourceExpectedVersion) throw versionConflict(source.version);
  if (target.version !== targetExpectedVersion) throw versionConflict(target.version);
  const canonical = canonicalRelation(kind, source, target, sourceExpectedVersion, targetExpectedVersion);
  const existing = await existingRelation(db, kind, canonical.source.id, canonical.target.id);
  if (existing !== null) {
    throw conflict(
      existing.deleted_at === null ? "RELATION_ALREADY_EXISTS" : "RELATION_DELETED",
      existing.deleted_at === null ? "none" : "restore_relation",
    );
  }
  throw platformUnavailable("d1");
}

export async function createIssueRelation(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  sourceIdentifierValue: JsonValue,
  targetIdentifierValue: JsonValue,
  kindValue: JsonValue,
  sourceExpectedVersion: number,
  targetExpectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const kind = requireRelationKind(kindValue);
  const [pathSource, pathTarget] = await Promise.all([
    requireCollaborationIssueAuthorization(db, auth, sourceIdentifierValue, "writer"),
    requireCollaborationIssueAuthorization(db, auth, targetIdentifierValue, "writer"),
  ]);
  validateRelationEndpoints(pathSource, pathTarget);
  const canonical = canonicalRelation(
    kind,
    pathSource,
    pathTarget,
    sourceExpectedVersion,
    targetExpectedVersion,
  );
  const relationId = crypto.randomUUID();
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      await verifyCurrentAuth(db, auth, now);
      const [latestSource, latestTarget] = await Promise.all([
        requireCollaborationIssueAuthorization(db, auth, pathSource.identifier, "writer"),
        requireCollaborationIssueAuthorization(db, auth, pathTarget.identifier, "writer"),
      ]);
      if (latestSource.projectId !== pathSource.projectId || latestTarget.projectId !== pathTarget.projectId) {
        throw notFound();
      }
    },
    db,
    execute: async (operationId) => {
      const [activeSource, activeTarget] = await Promise.all([
        requireCollaborationIssue(db, auth, pathSource.identifier, "writer"),
        requireCollaborationIssue(db, auth, pathTarget.identifier, "writer"),
      ]);
      validateRelationEndpoints(activeSource, activeTarget);
      const activeCanonical = canonicalRelation(
        kind,
        activeSource,
        activeTarget,
        sourceExpectedVersion,
        targetExpectedVersion,
      );
      const guard = buildTwoProjectWriterGuard(
        auth,
        now,
        10,
        "source.project_id",
        "target.project_id",
      );
      const eventStatements = relationEvents(
        db,
        auth,
        operationId,
        relationId,
        activeCanonical.source.projectId,
        activeCanonical.target.projectId,
        "issue-relation.created",
        now,
      );
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `INSERT INTO issue_relations
                (id, workspace_id, kind, source_issue_id, target_issue_id,
                 source_project_id, target_project_id,
                 version, created_at, created_by_principal_id,
                 created_operation_id, last_operation_id)
               SELECT ?1, source_workspace.id, ?2, source.id, target.id,
                      source.project_id, target.project_id,
                      1, ?7, ?8, ?9, ?9
               FROM issues source
               JOIN projects source_project ON source_project.id = source.project_id
               JOIN workspaces source_workspace ON source_workspace.id = source_project.workspace_id
               JOIN issues target ON target.id = ?4
               JOIN projects target_project ON target_project.id = target.project_id
               JOIN workspaces target_workspace ON target_workspace.id = target_project.workspace_id
               WHERE source.id = ?3 AND source.version = ?5 AND target.version = ?6
                 AND source.id != target.id
                 AND source.deleted_at IS NULL AND target.deleted_at IS NULL
                 AND source_project.deleted_at IS NULL AND target_project.deleted_at IS NULL
                 AND source_workspace.deleted_at IS NULL AND target_workspace.deleted_at IS NULL
                 AND source_workspace.id = target_workspace.id
                 AND ${guard.sql}`,
            ).bind(
              relationId,
              kind,
              activeCanonical.source.id,
              activeCanonical.target.id,
              activeCanonical.sourceExpectedVersion,
              activeCanonical.targetExpectedVersion,
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
                   SELECT 1 FROM issue_relations relation
                   WHERE relation.id = ?6 AND relation.created_operation_id = ?3
                 )`,
            ).bind(
              now,
              auth.principalId,
              operationId,
              activeCanonical.source.id,
              activeCanonical.sourceExpectedVersion,
              relationId,
            ),
            db.prepare(
              `UPDATE issues
               SET version = version + 1, updated_at = ?1,
                   updated_by_principal_id = ?2, last_operation_id = ?3
               WHERE id = ?4 AND version = ?5 AND deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM issue_relations relation
                   WHERE relation.id = ?6 AND relation.created_operation_id = ?3
                 )`,
            ).bind(
              now,
              auth.principalId,
              operationId,
              activeCanonical.target.id,
              activeCanonical.targetExpectedVersion,
              relationId,
            ),
            relationSnapshotStatement(db, operationId, relationId),
            ...eventStatements,
          ],
          committedAt: now,
          confirmBusinessRejection: () => deterministicRejection(
            () => diagnoseRelationCreate(
              db,
              auth,
              pathSource.identifier,
              pathTarget.identifier,
              kind,
              sourceExpectedVersion,
              targetExpectedVersion,
              now,
            ),
          ),
          expectedEventCount: eventStatements.length,
          operationId,
          primarySubjectId: relationId,
          primarySubjectType: "relation",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          return diagnoseRelationCreate(
            db,
            auth,
            pathSource.identifier,
            pathTarget.identifier,
            kind,
            sourceExpectedVersion,
            targetExpectedVersion,
            now,
          );
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `relation:${kind}:${canonical.source.id}:${canonical.target.id}`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<RelationRow>(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          relationResource(snapshot, true),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: {
      kind,
      source_expected_version: sourceExpectedVersion,
      target_expected_version: targetExpectedVersion,
      target_identifier: pathTarget.identifier,
    },
    routeTemplate: "/api/v1/issues/{identifier}/relations",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

async function diagnoseRelationCas(
  db: D1Database,
  auth: AuthContext,
  relationId: string,
  expectedVersion: number,
  sourceExpectedVersion: number,
  targetExpectedVersion: number,
  expectedDeleted: boolean,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const { row } = await requireRelationAccess(db, auth, relationId, "writer");
  if ((row.deleted_at !== null) !== expectedDeleted) {
    throw conflict(
      expectedDeleted ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED",
      "refresh_resource",
      { current_version: row.version },
    );
  }
  if (row.version !== expectedVersion) throw versionConflict(row.version);
  if (row.source_version !== sourceExpectedVersion) throw versionConflict(row.source_version);
  if (row.target_version !== targetExpectedVersion) throw versionConflict(row.target_version);
  throw platformUnavailable("d1");
}

async function setRelationDeleted(
  db: D1Database,
  auth: AuthContext,
  access: RelationAccess,
  expectedVersion: number,
  sourceExpectedVersion: number,
  targetExpectedVersion: number,
  now: number,
  deleted: boolean,
  operationId: string,
  persistSnapshot: boolean,
): Promise<OperationCommit> {
  const { row } = access;
  const guard = buildTwoProjectWriterGuard(
    auth,
    now,
    8,
    "source.project_id",
    "target.project_id",
  );
  const eventStatements = relationEvents(
    db,
    auth,
    operationId,
    row.id,
    row.source_project_id,
    row.target_project_id,
    deleted ? "issue-relation.deleted" : "issue-relation.restored",
    now,
  );
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE issue_relations AS relation
           SET deleted_at = ?1, deleted_by_principal_id = ?2,
               version = version + 1, last_operation_id = ?3
           WHERE relation.id = ?4 AND relation.version = ?5
             AND ${deleted ? "relation.deleted_at IS NULL" : "relation.deleted_at IS NOT NULL"}
             AND EXISTS (
               SELECT 1 FROM issues source
               JOIN projects source_project ON source_project.id = source.project_id
               JOIN workspaces workspace ON workspace.id = source_project.workspace_id
               JOIN issues target ON target.id = relation.target_issue_id
               JOIN projects target_project ON target_project.id = target.project_id
               WHERE source.id = relation.source_issue_id
                 AND source.version = ?6 AND target.version = ?7
                 AND source.deleted_at IS NULL AND target.deleted_at IS NULL
                 AND source_project.deleted_at IS NULL AND target_project.deleted_at IS NULL
                 AND workspace.deleted_at IS NULL
                 AND source_project.workspace_id = target_project.workspace_id
                 AND ${guard.sql}
             )`,
        ).bind(
          deleted ? now : null,
          deleted ? auth.principalId : null,
          operationId,
          row.id,
          expectedVersion,
          sourceExpectedVersion,
          targetExpectedVersion,
          ...guard.values,
        ),
        db.prepare(
          `UPDATE issues
           SET version = version + 1, updated_at = ?1,
               updated_by_principal_id = ?2, last_operation_id = ?3
           WHERE id = ?4 AND version = ?5 AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM issue_relations relation
               WHERE relation.id = ?6 AND relation.last_operation_id = ?3
             )`,
        ).bind(now, auth.principalId, operationId, row.source_id, sourceExpectedVersion, row.id),
        db.prepare(
          `UPDATE issues
           SET version = version + 1, updated_at = ?1,
               updated_by_principal_id = ?2, last_operation_id = ?3
           WHERE id = ?4 AND version = ?5 AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM issue_relations relation
               WHERE relation.id = ?6 AND relation.last_operation_id = ?3
             )`,
        ).bind(now, auth.principalId, operationId, row.target_id, targetExpectedVersion, row.id),
        ...(persistSnapshot ? [relationSnapshotStatement(db, operationId, row.id)] : []),
        ...eventStatements,
      ],
      committedAt: now,
      confirmBusinessRejection: () => deterministicRejection(
        () => diagnoseRelationCas(
          db,
          auth,
          row.id,
          expectedVersion,
          sourceExpectedVersion,
          targetExpectedVersion,
          !deleted,
          now,
        ),
      ),
      expectedEventCount: eventStatements.length,
      operationId,
      primarySubjectId: row.id,
      primarySubjectType: "relation",
      requireIdempotencySnapshot: persistSnapshot,
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnoseRelationCas(
        db,
        auth,
        row.id,
        expectedVersion,
        sourceExpectedVersion,
        targetExpectedVersion,
        !deleted,
        now,
      );
    }
    throw error;
  }
}

export async function deleteRelation(
  db: D1Database,
  auth: AuthContext,
  relationIdValue: JsonValue,
  expectedVersion: number,
  sourceExpectedVersion: number,
  targetExpectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const access = await requireRelationAccess(db, auth, relationIdValue, "writer");
  const operationId = crypto.randomUUID();
  const commit = await setRelationDeleted(
    db,
    auth,
    access,
    expectedVersion,
    sourceExpectedVersion,
    targetExpectedVersion,
    now,
    true,
    operationId,
    false,
  );
  const deletedRow: RelationRow = {
    ...access.row,
    deleted_at: now,
    deleted_by_principal_id: auth.principalId,
    last_operation_id: operationId,
    source_version: sourceExpectedVersion + 1,
    target_version: targetExpectedVersion + 1,
    version: expectedVersion + 1,
  };
  return writeResult(db, auth, relationResource(deletedRow, true), commit.lastEventSequence, false);
}

export async function restoreRelation(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  relationIdValue: JsonValue,
  expectedVersion: number,
  sourceExpectedVersion: number,
  targetExpectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const access = await requireRelationAccess(db, auth, relationIdValue, "writer", true);
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      await verifyCurrentAuth(db, auth, now);
      const latest = await requireRelationAccess(db, auth, access.row.id, "writer", true, false);
      if (
        latest.row.source_project_id !== access.row.source_project_id
        || latest.row.target_project_id !== access.row.target_project_id
      ) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const activeAccess = await requireRelationAccess(db, auth, access.row.id, "writer");
      await setRelationDeleted(
        db,
        auth,
        activeAccess,
        expectedVersion,
        sourceExpectedVersion,
        targetExpectedVersion,
        now,
        false,
        operationId,
        true,
      );
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `relation:${access.row.id}:restore`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<RelationRow>(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          relationResource(snapshot, true),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: {
      expected_version: expectedVersion,
      source_expected_version: sourceExpectedVersion,
      target_expected_version: targetExpectedVersion,
    },
    routeTemplate: "/api/v1/relations/{relation_id}/commands/restore",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}
