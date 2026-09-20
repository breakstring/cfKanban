import { requireUuid, timestamp } from "../domain/model.ts";
import { buildCurrentAuthGuard, reauthenticateOwner, requireOwnerControl, verifyCurrentAuth } from "../kernel/authorization.ts";
import { sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { ApiError, conflict, forbidden, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { canonicalJson, operationSnapshotStatement, readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { actorCredentialId, requireIdempotencyKey, writeResult } from "./shared.ts";

type Kind = "workspace" | "project";
interface Target { id: string; display_name: string; version: number; deleted_at: number | null; workspace_id: string }
type Counts = Record<string, number>;

// Every query uses ?1 for the immutable container ID. The same expressions guard the write batch.
function countExpressions(kind: Kind): Record<string, string> {
  if (kind === "workspace") return { projects: "SELECT COUNT(*) FROM projects WHERE workspace_id = ?1 AND purged_at IS NULL", administrators: "SELECT COUNT(*) FROM scoped_administrator_grants WHERE workspace_id = ?1" };
  return {
    projects: "SELECT 0",
    issues: "SELECT COUNT(*) FROM issues WHERE project_id = ?1",
    attachments: "SELECT COUNT(*) FROM issue_attachments WHERE issue_id IN (SELECT id FROM issues WHERE project_id=?1)",
    attachment_bytes: "SELECT COALESCE(SUM(size_bytes),0) FROM attachment_objects WHERE id IN (SELECT id FROM issue_attachments WHERE issue_id IN (SELECT id FROM issues WHERE project_id=?1))",
    comments: "SELECT COUNT(*) FROM comments WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ?1)",
    labels: "SELECT COUNT(*) FROM labels WHERE project_id = ?1",
    relations: "SELECT COUNT(*) FROM issue_relations WHERE source_project_id = ?1 OR target_project_id = ?1",
    cross_project_relations: "SELECT COUNT(*) FROM issue_relations WHERE (source_project_id = ?1 OR target_project_id = ?1) AND source_project_id <> target_project_id",
    grants: "SELECT COUNT(*) FROM project_grants WHERE project_id = ?1",
    administrators: "SELECT COUNT(*) FROM scoped_administrator_grants WHERE project_id = ?1",
    invitations: "SELECT COUNT(*) FROM invitation_project_grants WHERE project_id = ?1",
    shared_invitations: "SELECT COUNT(*) FROM invitation_project_grants a WHERE a.project_id = ?1 AND EXISTS (SELECT 1 FROM invitation_project_grants b WHERE b.invitation_id = a.invitation_id AND b.project_id <> ?1)",
    browser_launches: "SELECT COUNT(*) FROM browser_launches WHERE json_extract(target_json, '$.project_id') = ?1",
    web_sessions: "SELECT COUNT(*) FROM web_sessions WHERE json_extract(target_json, '$.project_id') = ?1",
  };
}
const emptyCounts = { projects: 0, issues: 0, comments: 0, attachments: 0, attachment_bytes: 0, labels: 0, relations: 0, cross_project_relations: 0, grants: 0, administrators: 0, invitations: 0, shared_invitations: 0, browser_launches: 0, web_sessions: 0 };
async function readTarget(db: D1Database, workspaceId: string, projectId?: string): Promise<Target> {
  const row = projectId === undefined
    ? await db.prepare("SELECT id,display_name,version,deleted_at,id AS workspace_id FROM workspaces WHERE id = ?1 AND purged_at IS NULL").bind(workspaceId).first<Target>()
    : await db.prepare("SELECT p.id,p.display_name,p.version,p.deleted_at,w.id AS workspace_id FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE w.id=?1 AND p.id=?2 AND p.purged_at IS NULL AND w.purged_at IS NULL").bind(workspaceId, projectId).first<Target>();
  if (row === null) throw notFound();
  return row;
}
async function preview(db: D1Database, kind: Kind, target: Target) {
  const expressions = countExpressions(kind);
  const counts = { ...emptyCounts, ...await db.prepare(`SELECT ${Object.entries(expressions).map(([key, sql]) => `(${sql}) AS ${key}`).join(",")}`).bind(target.id).first<Counts>() };
  const blockingReason = target.deleted_at === null ? "ARCHIVE_REQUIRED" : kind === "workspace" && counts.projects > 0 ? "WORKSPACE_NOT_EMPTY" : null;
  const data = { target: { kind, id: target.id, workspace_id: target.workspace_id, display_name: target.display_name, version: target.version }, counts, can_purge: blockingReason === null, blocking_reason: blockingReason };
  return { ...data, preview_digest: await sha256Hex(canonicalJson(data)) };
}
export async function getPurgePreview(db: D1Database, auth: AuthContext, workspaceValue: JsonValue, projectValue: JsonValue | undefined, now: number): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  await verifyCurrentAuth(db, auth, now);
  const workspaceId = requireUuid(workspaceValue, "workspace_id");
  const projectId = projectValue === undefined ? undefined : requireUuid(projectValue, "project_id");
  try {
    const result = await preview(db, projectId === undefined ? "workspace" : "project", await readTarget(db, workspaceId, projectId));
    await verifyCurrentAuth(db, auth, now);
    return result;
  }
  catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
}

function cleanupStatements(db: D1Database, kind: Kind, targetId: string, operationId: string, now: number, auth: AuthContext): D1PreparedStatement[] {
  const table = kind === "project" ? "projects" : "workspaces";
  const gate = `EXISTS (SELECT 1 FROM ${table} WHERE id=?1 AND last_operation_id=?2 AND purged_at IS NOT NULL)`;
  const stmt = (sql: string) => db.prepare(sql).bind(targetId, operationId);
  const eventScope = kind === "project"
    ? `project_id=?1 OR relation_other_project_id=?1 OR grant_id IN (SELECT id FROM project_grants WHERE project_id=?1)
      OR administrator_grant_id IN (SELECT id FROM scoped_administrator_grants WHERE project_id=?1)
      OR subject_id IN (SELECT invitation_id FROM invitation_project_grants WHERE project_id=?1)
      OR subject_id IN (SELECT id FROM browser_launches WHERE json_extract(target_json,'$.project_id')=?1)
      OR subject_id IN (SELECT id FROM web_sessions WHERE json_extract(target_json,'$.project_id')=?1)`
    : `workspace_id=?1 OR administrator_grant_id IN (SELECT id FROM scoped_administrator_grants WHERE workspace_id=?1)
      OR (subject_type='scoped_administrator' AND subject_id IN (SELECT id FROM scoped_administrator_grants WHERE workspace_id=?1))`;
  const subjectScope = kind === "project" ? `
    (primary_subject_type IN ('project','public_join_policy') AND primary_subject_id=?1)
    OR (primary_subject_type='scoped_administrator' AND primary_subject_id IN (SELECT id FROM scoped_administrator_grants WHERE project_id=?1))
    OR (primary_subject_type='project_grant' AND primary_subject_id IN (SELECT id FROM project_grants WHERE project_id=?1))
    OR (primary_subject_type='issue' AND primary_subject_id IN (SELECT id FROM issues WHERE project_id=?1))
    OR (primary_subject_type='attachment' AND primary_subject_id IN (SELECT id FROM issue_attachments WHERE issue_id IN (SELECT id FROM issues WHERE project_id=?1)))
    OR (primary_subject_type='comment' AND primary_subject_id IN (SELECT id FROM comments WHERE issue_id IN (SELECT id FROM issues WHERE project_id=?1)))
    OR (primary_subject_type='label' AND primary_subject_id IN (SELECT id FROM labels WHERE project_id=?1))
    OR (primary_subject_type='relation' AND primary_subject_id IN (SELECT id FROM issue_relations WHERE source_project_id=?1 OR target_project_id=?1))
    OR primary_subject_id IN (SELECT invitation_id FROM invitation_project_grants WHERE project_id=?1)
    OR primary_subject_id IN (SELECT id FROM browser_launches WHERE json_extract(target_json,'$.project_id')=?1)
    OR primary_subject_id IN (SELECT id FROM web_sessions WHERE json_extract(target_json,'$.project_id')=?1)` : `(primary_subject_type='workspace' AND primary_subject_id=?1)
      OR (primary_subject_type='scoped_administrator' AND primary_subject_id IN (SELECT id FROM scoped_administrator_grants WHERE workspace_id=?1))`;
  const oldOperations = `SELECT operation_id FROM events WHERE (${eventScope}) AND operation_id<>?2 UNION SELECT operation_id FROM operation_commits WHERE (${subjectScope}) AND operation_id<>?2`;
  const result = [
    stmt(`DELETE FROM idempotency_records WHERE operation_id IN (${oldOperations}) AND ${gate}`),
    stmt(`DELETE FROM operation_commits WHERE operation_id IN (${oldOperations}) AND ${gate}`),
    stmt(`DELETE FROM events WHERE (${eventScope}) AND operation_id<>?2 AND ${gate}`),
  ];
  if (kind === "workspace") {
    result.push(stmt(`DELETE FROM scoped_administrator_grants WHERE workspace_id=?1 AND ${gate}`));
    return result;
  }
  result.push(db.prepare(`UPDATE attachment_objects SET state='garbage',garbage_at=COALESCE(garbage_at,?3)
    WHERE id IN (SELECT id FROM issue_attachments WHERE issue_id IN (SELECT id FROM issues WHERE project_id=?1)) AND ${gate}`).bind(targetId, operationId, now));
  // One event per removed cross-project relation, with no deleted target identifier or content.
  result.push(db.prepare(`INSERT INTO events (id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
    SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
      'domain','project.relations-purged',?2,ROW_NUMBER() OVER (ORDER BY r.id),?3,?4,'deployment_owner',p.workspace_id,p.id,'project',p.id,'{"removed_relations":1}',?5
    FROM issue_relations r JOIN projects p ON p.id=CASE WHEN r.source_project_id=?1 THEN r.target_project_id ELSE r.source_project_id END
    WHERE (r.source_project_id=?1 OR r.target_project_id=?1) AND r.source_project_id<>r.target_project_id AND ${gate}`)
    .bind(targetId, operationId, auth.principalId, actorCredentialId(auth), now));
  result.push(db.prepare(`UPDATE invitations SET
      revoked_at=CASE WHEN redeemed_at IS NULL AND revoked_at IS NULL THEN ?3 ELSE revoked_at END,
      revoked_by_principal_id=CASE WHEN redeemed_at IS NULL AND revoked_at IS NULL THEN ?4 ELSE revoked_by_principal_id END,
      last_operation_id=?2
    WHERE id IN (SELECT invitation_id FROM invitation_project_grants WHERE project_id=?1) AND ${gate}`)
    .bind(targetId, operationId, now, auth.principalId));
  for (const [name, where] of [
    ["browser_launches", "json_extract(target_json,'$.project_id')=?1"],
    ["web_sessions", "json_extract(target_json,'$.project_id')=?1"],
    ["invitation_redemption_items", "project_id=?1"],
    ["invitation_project_grants", "project_id=?1"],
    ["issue_labels", "issue_id IN (SELECT id FROM issues WHERE project_id=?1) OR label_id IN (SELECT id FROM labels WHERE project_id=?1)"],
    ["issue_relations", "source_project_id=?1 OR target_project_id=?1"],
    ["issue_attachments", "issue_id IN (SELECT id FROM issues WHERE project_id=?1)"],
    ["comments", "issue_id IN (SELECT id FROM issues WHERE project_id=?1)"],
    ["issues", "project_id=?1"],
    ["labels", "project_id=?1"],
    ["project_grants", "project_id=?1"],
    ["project_status_names", "project_id=?1"],
    ["public_join_policies", "project_id=?1"],
    ["project_usage", "project_id=?1"],
  ]) result.push(stmt(`DELETE FROM ${name} WHERE (${where}) AND ${gate}`));
  result.push(stmt(`DELETE FROM invitations WHERE last_operation_id=?2
    AND NOT EXISTS (SELECT 1 FROM invitation_project_grants WHERE invitation_id=invitations.id)
    AND NOT EXISTS (SELECT 1 FROM invitation_redemption_items WHERE invitation_id=invitations.id) AND ${gate}`));
  result.push(stmt(`DELETE FROM scoped_administrator_grants WHERE project_id=?1 AND ${gate}`));
  return result;
}

export async function purgeContainer(db: D1Database, request: Request, auth: AuthContext, workspaceValue: JsonValue, projectValue: JsonValue | undefined, expectedVersion: number, confirmName: JsonValue, previewDigest: JsonValue, now: number): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const workspaceId = requireUuid(workspaceValue, "workspace_id");
  const projectId = projectValue === undefined ? undefined : requireUuid(projectValue, "project_id");
  if (typeof confirmName !== "string" || confirmName.length < 1 || confirmName.length > 128 || typeof previewDigest !== "string" || !/^[a-f0-9]{64}$/.test(previewDigest)) throw validationError("schema_validation_failed");
  const kind: Kind = projectId === undefined ? "workspace" : "project";
  const result = await runIdempotentOperation({
    db, now, method: "POST", idempotencyKey: requireIdempotencyKey(request),
    scopeKey: `principal:${auth.principalId}`,
    normalizedResourceScope: `workspace:${workspaceId}${projectId === undefined ? "" : `:project:${projectId}`}:purge`,
    routeTemplate: `/api/v1/workspaces/{workspace_id}${kind === "project" ? "/projects/{project_id}" : ""}/commands/purge`,
    requestBody: { expected_version: expectedVersion, confirm_name: confirmName, preview_digest: previewDigest },
    authorize: async () => { if ((await reauthenticateOwner(db, request, now)).principalId !== auth.principalId) throw forbidden(); },
    execute: async (operationId) => {
      const target = await readTarget(db, workspaceId, projectId);
      if (target.version !== expectedVersion) throw versionConflict(target.version);
      if (target.display_name !== confirmName) throw conflict("PURGE_CONFIRMATION_MISMATCH");
      const impact = await preview(db, kind, target);
      if (impact.blocking_reason !== null) throw conflict(impact.blocking_reason);
      if (impact.preview_digest !== previewDigest) throw conflict("PURGE_PREVIEW_CHANGED");
      const table = kind === "project" ? "projects" : "workspaces";
      const expressions = Object.entries(countExpressions(kind));
      const countGuard = expressions.map(([, sql], index) => `(${sql})=?${7 + index}`).join(" AND ");
      const guard = buildCurrentAuthGuard(auth, now, 7 + expressions.length, true);
      const marker = db.prepare(`UPDATE ${table} SET purged_at=?2,display_name='Deleted',version=version+1,updated_at=?2,updated_by_principal_id=?3,last_operation_id=?4${kind === "project" ? ",context=NULL,issue_limit=NULL,comment_limit=NULL,principal_limit=NULL" : ""}
        WHERE id=?1 AND version=?5 AND display_name=?6 AND deleted_at IS NOT NULL AND purged_at IS NULL AND ${countGuard} AND ${guard.sql}`)
        .bind(target.id, now, auth.principalId, operationId, expectedVersion, confirmName, ...expressions.map(([key]) => (impact.counts as Counts)[key]), ...guard.values);
      const resource = { id: target.id, kind, purged: true, purged_at: timestamp(now), version: expectedVersion + 1, storage_cleanup_pending: impact.counts.attachments > 0 };
      const audit = db.prepare(`INSERT INTO events (id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
        SELECT ?1,'security',?2,?3,0,?4,?5,'deployment_owner',?6,id,'{}',?7 FROM ${table} WHERE id=?8 AND last_operation_id=?3 AND purged_at=?7 AND ${expressions.map(([, sql]) => `(${sql.replaceAll("?1", "?8")})=0`).join(" AND ")}`)
        .bind(crypto.randomUUID(), `${kind}.purged`, operationId, auth.principalId, actorCredentialId(auth), kind, now, target.id);
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectType: kind, primarySubjectId: target.id, committedAt: now,
          expectedEventCount: impact.counts.cross_project_relations + 1,
          requireIdempotencySnapshot: true,
          businessStatements: [marker, ...cleanupStatements(db, kind, target.id, operationId, now, auth), audit, operationSnapshotStatement(db, operationId, resource)],
          confirmBusinessRejection: async () => {
            const currentAuth = buildCurrentAuthGuard(auth, now, 1, true);
            if (await db.prepare(`SELECT 1 AS allowed WHERE ${currentAuth.sql}`).bind(...currentAuth.values).first() === null) return true;
            try {
              const current = await readTarget(db, workspaceId, projectId);
              return current.version !== expectedVersion || (await preview(db, kind, current)).preview_digest !== previewDigest;
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) return true;
              throw error;
            }
          },
        });
      } catch (error) {
        if (!(error instanceof AtomicBatchRejectedError)) throw error;
        await verifyCurrentAuth(db, auth, now);
        const current = await readTarget(db, workspaceId, projectId);
        if (current.version !== expectedVersion) throw versionConflict(current.version);
        if ((await preview(db, kind, current)).preview_digest !== previewDigest) throw conflict("PURGE_PREVIEW_CHANGED");
        throw platformUnavailable("d1");
      }
    },
    readback: async (operationId, commit) => ({ status: 200, body: await writeResult(db, auth, await readOperationSnapshot<{ [key: string]: JsonValue }>(db, operationId), commit.lastEventSequence, false) }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
