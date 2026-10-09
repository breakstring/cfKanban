import { requireUuid, timestamp } from "../domain/model.ts";
import { requireProjectAuthorization, verifyCurrentAuth, type VisibleProject } from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { isUuid } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import { ApiError, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { buildProjectRoleGuard, roleCanWrite } from "./collaboration-shared.ts";
import { actorCredentialId, authorizedVia, requireIdempotencyKey, requireLimit, writeResult } from "./shared.ts";

interface MilestoneRow {
  id: string;
  project_id: string;
  workspace_id: string;
  title: string;
  description: string;
  due_date: string | null;
  status_key: "open" | "closed";
  version: number;
  current_total: number;
  current_done: number;
  current_canceled: number;
  created_at: number;
  updated_at: number;
}

const SELECT_MILESTONE = `SELECT milestone.id, milestone.project_id, project.workspace_id,
  milestone.title, milestone.description, milestone.due_date, milestone.status_key,
  milestone.version, milestone.current_total, milestone.current_done, milestone.current_canceled,
  milestone.created_at, milestone.updated_at
  FROM milestones milestone JOIN projects project ON project.id = milestone.project_id
  JOIN workspaces workspace ON workspace.id = project.workspace_id`;

function resource(row: MilestoneRow, role: VisibleProject["role"]): { [key: string]: JsonValue } {
  return {
    id: row.id, project_id: row.project_id, workspace_id: row.workspace_id,
    title: row.title, description: row.description, due_date: row.due_date, status_key: row.status_key,
    version: row.version, created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    allowed_actions: roleCanWrite(role) ? ["read", "update"] : ["read"],
    progress: { total: row.current_total, done: row.current_done,
      unfinished: row.current_total - row.current_done - row.current_canceled, canceled: row.current_canceled },
  };
}

function titleValue(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw validationError("schema_validation_failed", { field: "title" });
  const title = value.trim();
  if (title.length === 0 || Array.from(title).length > 200) {
    throw validationError("schema_validation_failed", { field: "title" });
  }
  return title;
}

function descriptionValue(value: JsonValue | undefined): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 8192) {
    throw validationError("schema_validation_failed", { field: "description" });
  }
  return value;
}

function dueDateValue(value: JsonValue | undefined): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
    || value.startsWith("0000") || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw validationError("schema_validation_failed", { field: "due_date" });
  }
  return value;
}

function statusValue(value: JsonValue | undefined): "open" | "closed" {
  if (value !== "open" && value !== "closed") throw validationError("schema_validation_failed", { field: "status_key" });
  return value;
}

async function access(db: D1Database, auth: AuthContext, idValue: JsonValue,
  role: "reader" | "writer", now: number): Promise<{ row: MilestoneRow; project: VisibleProject }> {
  const id = requireUuid(idValue, "milestone_id");
  let scope: { project_id: string; workspace_id: string } | null;
  try { scope = await db.prepare(`SELECT milestone.project_id, project.workspace_id
    FROM milestones milestone JOIN projects project ON project.id = milestone.project_id
    WHERE milestone.id = ?1 LIMIT 1`).bind(id).first<{ project_id: string; workspace_id: string }>(); }
  catch (error) { throw platformUnavailable("d1", error); }
  if (scope === null) throw notFound();
  const project = await requireProjectAuthorization(db, auth, scope.workspace_id, scope.project_id, role);
  const guard = buildProjectRoleGuard(auth, now, 2, "project.id", role);
  let row: MilestoneRow | null;
  try { row = await db.prepare(`${SELECT_MILESTONE} WHERE milestone.id = ?1
    AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL AND ${guard.sql} LIMIT 1`)
    .bind(id, ...guard.values).first<MilestoneRow>(); }
  catch (error) { throw platformUnavailable("d1", error); }
  if (row === null) {
    await verifyCurrentAuth(db, auth, now);
    await requireProjectAuthorization(db, auth, scope.workspace_id, scope.project_id, role);
    throw notFound();
  }
  return { row, project };
}

export async function listMilestones(db: D1Database, auth: AuthContext, workspaceValue: JsonValue,
  projectValue: JsonValue, url: URL, now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  const workspaceId = requireUuid(workspaceValue, "workspace_id"), projectId = requireUuid(projectValue, "project_id");
  const project = await requireProjectAuthorization(db, auth, workspaceId, projectId);
  const status = url.searchParams.get("status");
  if (url.searchParams.getAll("status").length > 1 || (status !== null && status !== "open" && status !== "closed")) {
    throw validationError("schema_validation_failed", { field: "status" });
  }
  const context = await createCursorContext("milestones", { project_id: projectId, status }, [projectId], auth.principalId);
  const cursor = decodeCursor(url.searchParams.get("cursor"), context);
  if (cursor !== null && (cursor.length !== 2 || typeof cursor[0] !== "number"
    || !Number.isSafeInteger(cursor[0]) || cursor[0] < 0 || typeof cursor[1] !== "string" || !isUuid(cursor[1]))) throw invalidCursor();
  const limit = requireLimit(url), guard = buildProjectRoleGuard(auth, now, 6, "project.id", "reader");
  let rows: MilestoneRow[];
  try { rows = (await db.prepare(`${SELECT_MILESTONE}
    WHERE milestone.project_id = ?1 AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
      ${status === null ? "" : "AND milestone.status_key = ?2"}
      ${cursor === null ? "" : "AND (milestone.created_at, milestone.id) < (?3, ?4)"}
      AND ${guard.sql}
    ORDER BY milestone.created_at DESC, milestone.id DESC LIMIT ?5`)
    .bind(projectId, status, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1, ...guard.values).all<MilestoneRow>()).results; }
  catch (error) { throw platformUnavailable("d1", error); }
  await verifyCurrentAuth(db, auth, now);
  const currentProject = await requireProjectAuthorization(db, auth, workspaceId, projectId);
  const page = rows.slice(0, limit), tail = page.at(-1), hasMore = rows.length > limit;
  return { items: page.map(row => resource(row, currentProject.role)), has_more: hasMore,
    next_cursor: hasMore && tail !== undefined ? encodeCursor(context, [tail.created_at, tail.id]) : null,
    resolved_scope: { project_id: projectId, workspace_id: workspaceId,
      project_display_name: project.projectName, workspace_display_name: project.workspaceName } };
}

export async function getMilestone(db: D1Database, auth: AuthContext, idValue: JsonValue,
  now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  const { row, project } = await access(db, auth, idValue, "reader", now);
  return resource(row, project.role);
}

function snapshotStatement(db: D1Database, operationId: string, id: string): D1PreparedStatement {
  return db.prepare(`UPDATE idempotency_records SET operation_snapshot_json = (
    SELECT json_object('id', milestone.id, 'project_id', milestone.project_id, 'workspace_id', project.workspace_id,
      'title', milestone.title, 'description', milestone.description, 'due_date', milestone.due_date,
      'status_key', milestone.status_key, 'version', milestone.version,
      'current_total', milestone.current_total, 'current_done', milestone.current_done,
      'current_canceled', milestone.current_canceled, 'created_at', milestone.created_at, 'updated_at', milestone.updated_at)
    FROM milestones milestone JOIN projects project ON project.id = milestone.project_id
    WHERE milestone.id = ?2 AND milestone.last_operation_id = ?1
  ) WHERE operation_id = ?1 AND state = 'pending'`).bind(operationId, id);
}

function eventStatement(db: D1Database, auth: AuthContext, operationId: string, id: string,
  type: string, payload: JsonValue, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO events
    (id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,grant_id,
      workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
    SELECT ?1,'domain',?2,?3,0,?4,?5,?6,
      CASE WHEN ?7 = 1 THEN NULL ELSE (SELECT id FROM effective_project_grants
        WHERE project_id = milestone.project_id AND principal_id = ?4 AND role = 'writer' AND revoked_at IS NULL LIMIT 1) END,
      project.workspace_id,milestone.project_id,'milestone',milestone.id,?8,?9
    FROM milestones milestone JOIN projects project ON project.id = milestone.project_id
    WHERE milestone.id = ?10 AND milestone.last_operation_id = ?3`)
    .bind(crypto.randomUUID(), type, operationId, auth.principalId, actorCredentialId(auth), authorizedVia(auth),
      auth.isOwner ? 1 : 0, JSON.stringify(payload), now, id);
}

async function deterministicRejection(check: () => Promise<never>): Promise<boolean> {
  try { await check(); } catch (error) {
    if (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE") return true;
    throw error;
  }
  return false;
}

export async function createMilestone(db: D1Database, request: Request, auth: AuthContext,
  workspaceValue: JsonValue, projectValue: JsonValue, value: { [key: string]: JsonValue },
  now: number): Promise<{ [key: string]: JsonValue }> {
  const workspaceId = requireUuid(workspaceValue, "workspace_id"), projectId = requireUuid(projectValue, "project_id");
  const project = await requireProjectAuthorization(db, auth, workspaceId, projectId, "writer");
  const title = titleValue(value.title), description = descriptionValue(value.description === undefined ? "" : value.description),
    dueDate = dueDateValue(value.due_date ?? null), status = statusValue(value.status_key === undefined ? "open" : value.status_key);
  const id = crypto.randomUUID();
  const diagnose = async (): Promise<never> => {
    await verifyCurrentAuth(db, auth, now);
    await requireProjectAuthorization(db, auth, workspaceId, projectId, "writer");
    throw platformUnavailable("d1");
  };
  const result = await runIdempotentOperation({
    authorize: async () => { await verifyCurrentAuth(db, auth, now);
      await requireProjectAuthorization(db, auth, workspaceId, projectId, "writer"); },
    db, idempotencyKey: requireIdempotencyKey(request), method: "POST",
    normalizedResourceScope: `project:${projectId}:milestone`, now,
    requestBody: { title, description, due_date: dueDate, status_key: status },
    routeTemplate: "/api/v1/workspaces/{workspace_id}/projects/{project_id}/milestones",
    scopeKey: `principal:${auth.principalId}`,
    execute: async operationId => {
      const guard = buildProjectRoleGuard(auth, now, 10, "project.id");
      try { await executeAtomicBatch(db, {
        businessStatements: [db.prepare(`INSERT INTO milestones
          (id,project_id,title,description,due_date,status_key,created_at,updated_at,created_by_principal_id,
            updated_by_principal_id,created_operation_id,last_operation_id)
          SELECT ?1,project.id,?3,?4,?5,?6,?7,?7,?8,?8,?9,?9
          FROM projects project JOIN workspaces workspace ON workspace.id = project.workspace_id
          WHERE project.id = ?2 AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL AND ${guard.sql}`)
          .bind(id, projectId, title, description, dueDate, status, now, auth.principalId, operationId, ...guard.values),
          snapshotStatement(db, operationId, id),
          eventStatement(db, auth, operationId, id, "milestone.created",
            { title, due_date: dueDate, status_key: status, milestone_version: 1 }, now)],
        committedAt: now, confirmBusinessRejection: () => deterministicRejection(diagnose),
        expectedEventCount: 1, operationId, primarySubjectId: id, primarySubjectType: "milestone",
        requireIdempotencySnapshot: true,
      }); } catch (error) { if (error instanceof AtomicBatchRejectedError) return diagnose(); throw error; }
    },
    readback: async (operationId, commit) => ({ status: 200,
      body: await writeResult(db, auth, resource(await readOperationSnapshot<MilestoneRow>(db, operationId), project.role),
        commit.lastEventSequence, false) }),
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function updateMilestone(db: D1Database, auth: AuthContext, idValue: JsonValue,
  value: { [key: string]: JsonValue }, expectedVersion: number, now: number): Promise<{ [key: string]: JsonValue }> {
  const { row, project } = await access(db, auth, idValue, "writer", now);
  const fields = ["title", "description", "due_date", "status_key"];
  if (!fields.some(field => Object.hasOwn(value, field))) throw validationError("update_field_required");
  const title = value.title === undefined ? row.title : titleValue(value.title),
    description = value.description === undefined ? row.description : descriptionValue(value.description),
    dueDate = value.due_date === undefined ? row.due_date : dueDateValue(value.due_date),
    status = value.status_key === undefined ? row.status_key : statusValue(value.status_key);
  const operationId = crypto.randomUUID(), guard = buildProjectRoleGuard(auth, now, 10, "milestones.project_id");
  const diagnose = async (): Promise<never> => {
    const latest = await access(db, auth, row.id, "writer", now);
    if (latest.row.version !== expectedVersion) throw versionConflict(latest.row.version);
    throw platformUnavailable("d1");
  };
  let commit: OperationCommit;
  try { ({ commit } = await executeAtomicBatch(db, {
    businessStatements: [db.prepare(`UPDATE milestones SET title = ?1, description = ?2, due_date = ?3,
      status_key = ?4, version = version + 1, updated_at = ?5, updated_by_principal_id = ?6, last_operation_id = ?7
      WHERE id = ?8 AND version = ?9 AND EXISTS (SELECT 1 FROM projects project
        JOIN workspaces workspace ON workspace.id = project.workspace_id
        WHERE project.id = milestones.project_id AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL)
        AND ${guard.sql}`)
      .bind(title, description, dueDate, status, now, auth.principalId, operationId, row.id, expectedVersion, ...guard.values),
      eventStatement(db, auth, operationId, row.id, "milestone.updated", {
        milestone_version: expectedVersion + 1, title_changed: value.title !== undefined,
        description_changed: value.description !== undefined, due_date_changed: value.due_date !== undefined,
        old_status_key: row.status_key, new_status_key: status,
      }, now)],
    committedAt: now, confirmBusinessRejection: () => deterministicRejection(diagnose),
    expectedEventCount: 1, operationId, primarySubjectId: row.id, primarySubjectType: "milestone",
  })); } catch (error) { if (error instanceof AtomicBatchRejectedError) return diagnose(); throw error; }
  return writeResult(db, auth, resource({ ...row, title, description, due_date: dueDate, status_key: status,
    updated_at: now, version: expectedVersion + 1 }, project.role), commit.lastEventSequence, false);
}

export async function requireIssueMilestone(db: D1Database, projectId: string,
  value: JsonValue | undefined): Promise<string | null> {
  if (value === null || value === undefined) return null;
  const id = requireUuid(value, "milestone_id");
  try {
    if (await db.prepare("SELECT id FROM milestones WHERE id = ?1 AND project_id = ?2 LIMIT 1").bind(id, projectId).first() === null) throw notFound();
    return id;
  } catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
}
