import {
  requireCredentialToken,
  requireDisplayName,
  requireProjectRole,
  requireUuid,
  timestamp,
  type ProjectRole,
} from "../domain/model.ts";
import { authenticateBearer } from "../kernel/auth.ts";
import {
  buildCurrentAuthGuard,
  reauthenticateOwner,
  requireOwnerControl,
  resolveCurrentVisibleProjects,
  verifyCurrentAuth,
} from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import {
  ApiError,
  businessQuotaExceeded,
  conflict,
  forbidden,
  notFound,
  platformUnavailable,
  unauthorized,
  validationError,
  versionConflict,
} from "../kernel/errors.ts";
import {
  operationSnapshotStatement,
  readOperationSnapshot,
  runIdempotentOperation,
} from "../kernel/idempotency.ts";
import { recentRateLimitSummary } from "../kernel/rate-limit.ts";
import type { RateLimitPolicies } from "../kernel/rate-limit.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  actorCredentialId,
  requireIdempotencyKey,
  requireLimit,
  writeResult,
} from "./shared.ts";

interface PublicProjectRow {
  display_name: string;
  public_id: string;
  public_summary: string;
}

interface PolicyRow {
  active_comment_count: number;
  active_issue_count: number;
  active_principal_count: number;
  comment_limit: number | null;
  created_at: number | null;
  display_name: string;
  disabled_at: number | null;
  enabled_at: number | null;
  issue_limit: number | null;
  policy_version: number | null;
  principal_limit: number | null;
  project_id: string;
  project_key: string;
  project_version: number;
  public_id: string | null;
  public_summary: string | null;
  updated_at: number;
  usage_present: number;
  workspace_id: string;
  workspace_key: string;
}

interface PolicySnapshot {
  active_comment_count: number;
  active_issue_count: number;
  active_principal_count: number;
  comment_limit: number;
  created_at: number;
  display_name: string;
  disabled_at: number | null;
  enabled_at: number;
  issue_limit: number;
  policy_version: number;
  principal_limit: number;
  project_id: string;
  project_key: string;
  project_version: number;
  public_id: string;
  public_summary: string;
  updated_at: number;
  usage_present: number;
  workspace_id: string;
  workspace_key: string;
}

interface ResourceLimits {
  commentLimit: number;
  issueLimit: number;
  principalLimit: number;
}

interface ActiveUsageSnapshot {
  comments: number;
  issues: number;
  principals: number;
}

function requirePublicSummary(value: JsonValue): string {
  if (typeof value !== "string") {
    throw validationError("schema_validation_failed", { field: "public_summary" });
  }
  const summary = value.trim();
  if (summary.length === 0 || Array.from(summary).length > 512) {
    throw validationError("schema_validation_failed", { field: "public_summary" });
  }
  return summary;
}

function requirePositiveLimit(value: JsonValue, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

function requireLimits(value: {
  comment_limit: JsonValue;
  issue_limit: JsonValue;
  principal_limit: JsonValue;
}): ResourceLimits {
  return {
    commentLimit: requirePositiveLimit(value.comment_limit, "comment_limit"),
    issueLimit: requirePositiveLimit(value.issue_limit, "issue_limit"),
    principalLimit: requirePositiveLimit(value.principal_limit, "principal_limit"),
  };
}

function publicProjectResource(row: PublicProjectRow): { [key: string]: JsonValue } {
  return {
    display_name: row.display_name,
    public_id: row.public_id,
    public_summary: row.public_summary,
    role_choices: ["reader", "writer"],
  };
}

function policyResource(row: PolicyRow | PolicySnapshot): { [key: string]: JsonValue } {
  const enabled = row.enabled_at !== null && row.disabled_at === null;
  if (
    enabled
    && (
      row.public_id === null
      || row.public_summary === null
      || row.policy_version === null
      || row.created_at === null
      || row.issue_limit === null
      || row.comment_limit === null
      || row.principal_limit === null
      || row.usage_present !== 1
    )
  ) {
    throw platformUnavailable("d1");
  }
  return {
    active_usage: {
      comments: row.active_comment_count,
      issues: row.active_issue_count,
      principals: row.active_principal_count,
    },
    allowed_actions: enabled
      ? ["read", "update", "disable", "update_limits"]
      : ["read", "enable"],
    created_at: timestamp(row.created_at),
    disabled_at: timestamp(row.disabled_at),
    enabled,
    enabled_at: timestamp(row.enabled_at),
    policy_version: row.policy_version,
    project: {
      display_name: row.display_name,
      id: row.project_id,
      key: row.project_key,
      version: row.project_version,
      workspace_id: row.workspace_id,
      workspace_key: row.workspace_key,
    },
    public_id: row.public_id,
    public_summary: row.public_summary,
    resource_limits: {
      comments: row.comment_limit,
      issues: row.issue_limit,
      principals: row.principal_limit,
    },
    updated_at: timestamp(row.updated_at),
  };
}

async function readOperationActiveUsage(
  db: D1Database,
  operationId: string,
  eventType: "project.public-join-disabled" | "project.resource-limits-updated",
): Promise<ActiveUsageSnapshot> {
  let row: { payload_json: string } | null;
  try {
    row = await db.prepare(
      `SELECT payload_json
       FROM events
       WHERE operation_id = ?1 AND type = ?2 AND event_index = 0
       LIMIT 1`,
    ).bind(operationId, eventType).first<{ payload_json: string }>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
  if (row === null) throw platformUnavailable("d1");
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw platformUnavailable("d1");
  }
  if (typeof payload !== "object" || payload === null) throw platformUnavailable("d1");
  const activeUsage = (payload as { active_usage?: unknown }).active_usage;
  if (typeof activeUsage !== "object" || activeUsage === null) throw platformUnavailable("d1");
  const values = activeUsage as Partial<ActiveUsageSnapshot>;
  if (
    !Number.isSafeInteger(values.comments)
    || !Number.isSafeInteger(values.issues)
    || !Number.isSafeInteger(values.principals)
    || (values.comments ?? -1) < 0
    || (values.issues ?? -1) < 0
    || (values.principals ?? -1) < 0
  ) throw platformUnavailable("d1");
  return values as ActiveUsageSnapshot;
}

function parsePublicCursor(last: JsonValue[] | null): string | null {
  if (last === null) return null;
  if (
    last.length !== 1
    || typeof last[0] !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(last[0])
  ) {
    throw invalidCursor();
  }
  return last[0];
}

export async function listPublicProjects(
  db: D1Database,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const limit = requireLimit(url);
  const context = await createCursorContext("public-projects", {}, [], "public");
  const afterPublicId = parsePublicCursor(decodeCursor(url.searchParams.get("cursor"), context));
  let rows: PublicProjectRow[];
  try {
    const result = await db.prepare(
      `SELECT policy.public_id, project.display_name, policy.public_summary
       FROM public_join_policies policy INDEXED BY idx_public_join_enabled
       JOIN projects project ON project.id = policy.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       JOIN project_usage usage ON usage.project_id = project.id
       WHERE policy.disabled_at IS NULL AND policy.enabled_at IS NOT NULL
         AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
         AND project.issue_limit IS NOT NULL
         AND project.comment_limit IS NOT NULL
         AND project.principal_limit IS NOT NULL
         AND (?1 IS NULL OR policy.public_id > ?1)
       ORDER BY policy.public_id
       LIMIT ?2`,
    ).bind(afterPublicId, limit + 1).all<PublicProjectRow>();
    rows = result.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: page.map(publicProjectResource),
    next_cursor: hasMore && tail !== undefined
      ? encodeCursor(context, [tail.public_id])
      : null,
  };
}

async function readPolicyControl(
  db: D1Database,
  auth: AuthContext,
  projectId: string,
  now: number,
): Promise<PolicyRow | null> {
  const guard = buildCurrentAuthGuard(auth, now, 2, true);
  try {
    return await db.prepare(
      `SELECT project.id AS project_id, project.key AS project_key,
              project.display_name, project.version AS project_version,
              project.issue_limit, project.comment_limit, project.principal_limit,
              workspace.id AS workspace_id, workspace.key AS workspace_key,
              policy.public_id, policy.public_summary,
              policy.enabled_at, policy.disabled_at,
              policy.version AS policy_version, policy.created_at,
              COALESCE(policy.updated_at, project.updated_at) AS updated_at,
              CASE WHEN usage.project_id IS NULL THEN 0 ELSE 1 END AS usage_present,
              COALESCE(usage.active_issue_count, (
                SELECT COUNT(*) FROM issues issue
                WHERE issue.project_id = project.id AND issue.deleted_at IS NULL
              )) AS active_issue_count,
              COALESCE(usage.active_comment_count, (
                SELECT COUNT(*) FROM comments comment
                JOIN issues comment_issue ON comment_issue.id = comment.issue_id
                WHERE comment_issue.project_id = project.id
                  AND comment_issue.deleted_at IS NULL AND comment.deleted_at IS NULL
              )) AS active_comment_count,
              COALESCE(usage.active_principal_count, (
                SELECT COUNT(*) FROM project_grants grant_row
                WHERE grant_row.project_id = project.id AND grant_row.revoked_at IS NULL
              )) AS active_principal_count
       FROM projects project
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       LEFT JOIN public_join_policies policy ON policy.project_id = project.id
       LEFT JOIN project_usage usage ON usage.project_id = project.id
       WHERE project.id = ?1
         AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
         AND ${guard.sql}
       LIMIT 1`,
    ).bind(projectId, ...guard.values).first<PolicyRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

export async function getPublicJoinPolicy(
  db: D1Database,
  auth: AuthContext,
  projectIdValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const projectId = requireUuid(projectIdValue, "project_id");
  const row = await readPolicyControl(db, auth, projectId, now);
  if (row === null) throw notFound();
  return policyResource(row);
}

function policySnapshotStatement(
  db: D1Database,
  operationId: string,
  projectId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT json_object(
         'active_comment_count', usage.active_comment_count,
         'active_issue_count', usage.active_issue_count,
         'active_principal_count', usage.active_principal_count,
         'comment_limit', project.comment_limit,
         'created_at', policy.created_at,
         'display_name', project.display_name,
         'disabled_at', policy.disabled_at,
         'enabled_at', policy.enabled_at,
         'issue_limit', project.issue_limit,
         'policy_version', policy.version,
         'principal_limit', project.principal_limit,
         'project_id', project.id,
         'project_key', project.key,
         'project_version', project.version,
         'public_id', policy.public_id,
         'public_summary', policy.public_summary,
         'updated_at', policy.updated_at,
         'usage_present', 1,
         'workspace_id', workspace.id,
         'workspace_key', workspace.key
       )
       FROM projects project
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       JOIN public_join_policies policy ON policy.project_id = project.id
       JOIN project_usage usage ON usage.project_id = project.id
       WHERE project.id = ?2
         AND project.last_operation_id = ?1
         AND policy.last_operation_id = ?1
         AND usage.last_operation_id = ?1
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, projectId);
}

function policyEvent(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  projectId: string,
  eventType: "project.public-join-enabled" | "project.public-join-updated",
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, workspace_id, project_id,
       subject_type, subject_id, payload_json, created_at)
     SELECT ?1, 'domain', ?6,
            ?2, 0, ?3, ?4, 'deployment_owner', project.workspace_id,
            project.id, 'public_join_policy', policy.public_id,
            json_object(
              'policy_version', policy.version,
              'project_version', project.version,
              'public_id', policy.public_id,
              'public_summary', policy.public_summary,
              'resource_limits', json_object(
                'issues', project.issue_limit,
                'comments', project.comment_limit,
                'principals', project.principal_limit
              ),
              'active_usage', json_object(
                'issues', usage.active_issue_count,
                'comments', usage.active_comment_count,
                'principals', usage.active_principal_count
              )
            ), ?7
     FROM projects project
     JOIN public_join_policies policy ON policy.project_id = project.id
     JOIN project_usage usage ON usage.project_id = project.id
     WHERE project.id = ?5 AND project.last_operation_id = ?2
       AND policy.last_operation_id = ?2 AND usage.last_operation_id = ?2`,
  ).bind(
    crypto.randomUUID(),
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    projectId,
    eventType,
    now,
  );
}

async function ownerGuardRejected(
  db: D1Database,
  auth: AuthContext,
  now: number,
): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, now, 1, true);
  try {
    return await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`)
      .bind(...guard.values).first() === null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

export async function enablePublicJoin(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  projectIdValue: JsonValue,
  publicSummaryValue: JsonValue,
  expectedVersion: number,
  values: { comment_limit: JsonValue; issue_limit: JsonValue; principal_limit: JsonValue },
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const projectId = requireUuid(projectIdValue, "project_id");
  const publicSummary = requirePublicSummary(publicSummaryValue);
  const limits = requireLimits(values);
  const proposedPublicId = crypto.randomUUID();
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await reauthenticateOwner(db, request, now);
      if (current.principalId !== auth.principalId) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const current = await readPolicyControl(db, auth, projectId, now);
      if (current === null) throw notFound();
      const eventType = current.enabled_at === null || current.disabled_at !== null
        ? "project.public-join-enabled"
        : "project.public-join-updated";
      const guard = buildCurrentAuthGuard(auth, now, 9, true);
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `UPDATE projects
               SET issue_limit = ?1, comment_limit = ?2, principal_limit = ?3,
                   version = version + 1, updated_at = ?4,
                   updated_by_principal_id = ?5, last_operation_id = ?6
               WHERE id = ?7 AND version = ?8 AND deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM workspaces workspace
                   WHERE workspace.id = projects.workspace_id
                     AND workspace.deleted_at IS NULL
                 )
                 AND ${guard.sql}`,
            ).bind(
              limits.issueLimit,
              limits.commentLimit,
              limits.principalLimit,
              now,
              auth.principalId,
              operationId,
              projectId,
              expectedVersion,
              ...guard.values,
            ),
            db.prepare(
              `INSERT INTO public_join_policies
                (project_id, public_id, public_summary, enabled_at,
                 enabled_by_principal_id, version, created_at, updated_at,
                 last_operation_id)
               SELECT project.id, ?1, ?2, ?3, ?4, 1, ?3, ?3, ?5
               FROM projects project
               WHERE project.id = ?6 AND project.last_operation_id = ?5
               ON CONFLICT(project_id) DO UPDATE SET
                 public_summary = excluded.public_summary,
                 enabled_at = CASE
                   WHEN public_join_policies.disabled_at IS NOT NULL
                   THEN excluded.enabled_at ELSE public_join_policies.enabled_at END,
                 enabled_by_principal_id = CASE
                   WHEN public_join_policies.disabled_at IS NOT NULL
                   THEN excluded.enabled_by_principal_id
                   ELSE public_join_policies.enabled_by_principal_id END,
                 disabled_at = NULL,
                 disabled_by_principal_id = NULL,
                 version = public_join_policies.version + 1,
                 updated_at = excluded.updated_at,
                 last_operation_id = excluded.last_operation_id`,
            ).bind(
              proposedPublicId,
              publicSummary,
              now,
              auth.principalId,
              operationId,
              projectId,
            ),
            db.prepare(
              `INSERT INTO project_usage
                (project_id, active_issue_count, active_comment_count,
                 active_principal_count, updated_at, last_operation_id)
               SELECT project.id,
                      (SELECT COUNT(*) FROM issues issue
                       WHERE issue.project_id = project.id AND issue.deleted_at IS NULL),
                      (SELECT COUNT(*) FROM comments comment
                       JOIN issues comment_issue ON comment_issue.id = comment.issue_id
                       WHERE comment_issue.project_id = project.id
                         AND comment_issue.deleted_at IS NULL
                         AND comment.deleted_at IS NULL),
                      (SELECT COUNT(*) FROM project_grants grant_row
                       WHERE grant_row.project_id = project.id
                         AND grant_row.revoked_at IS NULL),
                      ?1, ?2
               FROM projects project
               JOIN public_join_policies policy ON policy.project_id = project.id
               WHERE project.id = ?3 AND project.last_operation_id = ?2
                 AND policy.last_operation_id = ?2
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
               ON CONFLICT(project_id) DO UPDATE SET
                 active_issue_count = excluded.active_issue_count,
                 active_comment_count = excluded.active_comment_count,
                 active_principal_count = excluded.active_principal_count,
                 updated_at = excluded.updated_at,
                 last_operation_id = excluded.last_operation_id`,
            ).bind(now, operationId, projectId),
            policySnapshotStatement(db, operationId, projectId),
            policyEvent(db, auth, operationId, projectId, eventType, now),
          ],
          committedAt: now,
          confirmBusinessRejection: async () => {
            const latest = await readPolicyControl(db, auth, projectId, now);
            return latest === null
              || latest.project_version !== expectedVersion
              || await ownerGuardRejected(db, auth, now);
          },
          expectedEventCount: 1,
          operationId,
          primarySubjectId: projectId,
          primarySubjectType: "public_join_policy",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          await verifyCurrentAuth(db, auth, now);
          const latest = await readPolicyControl(db, auth, projectId, now);
          if (latest === null) throw notFound();
          throw versionConflict(latest.project_version);
        }
        throw error;
      }
    },
    idempotencyKey: requireIdempotencyKey(request),
    method: "PUT",
    normalizedResourceScope: `project:${projectId}:public-join`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<PolicySnapshot>(db, operationId);
      return {
        body: await writeResult(db, auth, policyResource(snapshot), commit.lastEventSequence, false),
        status: 200,
      };
    },
    requestBody: {
      comment_limit: limits.commentLimit,
      expected_version: expectedVersion,
      issue_limit: limits.issueLimit,
      principal_limit: limits.principalLimit,
      public_summary: publicSummary,
    },
    routeTemplate: "/api/v1/admin/projects/{project_id}/public-join",
    scopeKey: `principal:${auth.principalId}`,
  });
  return {
    ...(result.body as { [key: string]: JsonValue }),
    idempotent_replay: result.idempotentReplay,
  };
}

function disabledPolicySnapshot(current: PolicyRow, now: number): PolicySnapshot {
  if (
    current.public_id === null
    || current.public_summary === null
    || current.policy_version === null
    || current.created_at === null
    || current.enabled_at === null
    || current.issue_limit === null
    || current.comment_limit === null
    || current.principal_limit === null
    || current.usage_present !== 1
  ) {
    throw platformUnavailable("d1");
  }
  return {
    ...current,
    disabled_at: now,
    policy_version: current.policy_version + 1,
    project_version: current.project_version + 1,
    updated_at: now,
    usage_present: 0,
  } as PolicySnapshot;
}

export async function disablePublicJoin(
  db: D1Database,
  auth: AuthContext,
  projectIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const projectId = requireUuid(projectIdValue, "project_id");
  const current = await readPolicyControl(db, auth, projectId, now);
  if (current === null) throw notFound();
  if (current.enabled_at === null || current.disabled_at !== null) {
    throw conflict("PUBLIC_JOIN_DISABLED", "enable_public_join");
  }
  const updated = disabledPolicySnapshot(current, now);
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
               SELECT 1 FROM workspaces workspace
               WHERE workspace.id = projects.workspace_id
                 AND workspace.deleted_at IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM public_join_policies policy
               JOIN project_usage usage ON usage.project_id = policy.project_id
               WHERE policy.project_id = projects.id
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
             )
             AND ${guard.sql}`,
        ).bind(now, auth.principalId, operationId, projectId, expectedVersion, ...guard.values),
        db.prepare(
          `UPDATE public_join_policies
           SET disabled_at = ?1, disabled_by_principal_id = ?2,
               version = version + 1, updated_at = ?1,
               last_operation_id = ?3
           WHERE project_id = ?4
             AND enabled_at IS NOT NULL AND disabled_at IS NULL
             AND EXISTS (SELECT 1 FROM projects project
                         WHERE project.id = ?4 AND project.last_operation_id = ?3)`,
        ).bind(now, auth.principalId, operationId, projectId),
        db.prepare(
          `DELETE FROM project_usage
           WHERE project_id = ?1
             AND EXISTS (
               SELECT 1 FROM public_join_policies policy
               WHERE policy.project_id = ?1 AND policy.last_operation_id = ?2
                 AND policy.disabled_at IS NOT NULL
             )`,
        ).bind(projectId, operationId),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, workspace_id, project_id,
             subject_type, subject_id, payload_json, created_at)
           SELECT ?1, 'domain', 'project.public-join-disabled', ?2, 0,
                  ?3, ?4, 'deployment_owner', project.workspace_id, project.id,
                  'public_join_policy', policy.public_id,
                  json_object(
                    'policy_version', policy.version,
                    'project_version', project.version,
                    'public_id', policy.public_id,
                    'resource_limits', json_object(
                      'issues', project.issue_limit,
                      'comments', project.comment_limit,
                      'principals', project.principal_limit
                    ),
                    'active_usage', json_object(
                      'issues', (SELECT COUNT(*) FROM issues issue
                                 WHERE issue.project_id = project.id
                                   AND issue.deleted_at IS NULL),
                      'comments', (SELECT COUNT(*) FROM comments comment
                                   JOIN issues comment_issue ON comment_issue.id = comment.issue_id
                                   WHERE comment_issue.project_id = project.id
                                     AND comment_issue.deleted_at IS NULL
                                     AND comment.deleted_at IS NULL),
                      'principals', (SELECT COUNT(*) FROM project_grants grant_row
                                    WHERE grant_row.project_id = project.id
                                      AND grant_row.revoked_at IS NULL)
                    )
                  ), ?5
           FROM projects project
           JOIN public_join_policies policy ON policy.project_id = project.id
           WHERE project.id = ?6 AND project.last_operation_id = ?2
             AND policy.last_operation_id = ?2
             AND NOT EXISTS (SELECT 1 FROM project_usage usage
                             WHERE usage.project_id = project.id)`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          auth.principalId,
          actorCredentialId(auth),
          now,
          projectId,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readPolicyControl(db, auth, projectId, now);
        return latest === null
          || latest.project_version !== expectedVersion
          || latest.enabled_at === null
          || latest.disabled_at !== null
          || latest.usage_present !== 1
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: projectId,
      primarySubjectType: "public_join_policy",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = await readPolicyControl(db, auth, projectId, now);
      if (latest === null) throw notFound();
      if (latest.enabled_at === null || latest.disabled_at !== null) {
        throw conflict("PUBLIC_JOIN_DISABLED", "enable_public_join");
      }
      throw versionConflict(latest.project_version);
    }
    throw error;
  }
  const activeUsage = await readOperationActiveUsage(
    db,
    operationId,
    "project.public-join-disabled",
  );
  updated.active_comment_count = activeUsage.comments;
  updated.active_issue_count = activeUsage.issues;
  updated.active_principal_count = activeUsage.principals;
  return writeResult(db, auth, policyResource(updated), commit.lastEventSequence, false);
}

export async function getProjectResourceLimits(
  db: D1Database,
  auth: AuthContext,
  projectIdValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  return getPublicJoinPolicy(db, auth, projectIdValue, now);
}

export async function updateProjectResourceLimits(
  db: D1Database,
  auth: AuthContext,
  projectIdValue: JsonValue,
  expectedVersion: number,
  values: { comment_limit: JsonValue; issue_limit: JsonValue; principal_limit: JsonValue },
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const projectId = requireUuid(projectIdValue, "project_id");
  const limits = requireLimits(values);
  const current = await readPolicyControl(db, auth, projectId, now);
  if (current === null) throw notFound();
  if (current.enabled_at === null || current.disabled_at !== null || current.usage_present !== 1) {
    throw conflict("PUBLIC_JOIN_DISABLED", "enable_public_join");
  }
  const updated: PolicySnapshot = {
    ...(current as PolicySnapshot),
    comment_limit: limits.commentLimit,
    issue_limit: limits.issueLimit,
    principal_limit: limits.principalLimit,
    project_version: current.project_version + 1,
    updated_at: now,
  };
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 9, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE projects
           SET issue_limit = ?1, comment_limit = ?2, principal_limit = ?3,
               version = version + 1, updated_at = ?4,
               updated_by_principal_id = ?5, last_operation_id = ?6
           WHERE id = ?7 AND version = ?8 AND deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM workspaces workspace
                         WHERE workspace.id = projects.workspace_id
                           AND workspace.deleted_at IS NULL)
             AND EXISTS (
               SELECT 1 FROM public_join_policies policy
               JOIN project_usage usage ON usage.project_id = policy.project_id
               WHERE policy.project_id = projects.id
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
             )
             AND ${guard.sql}`,
        ).bind(
          limits.issueLimit,
          limits.commentLimit,
          limits.principalLimit,
          now,
          auth.principalId,
          operationId,
          projectId,
          expectedVersion,
          ...guard.values,
        ),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, workspace_id, project_id,
             subject_type, subject_id, payload_json, created_at)
           SELECT ?1, 'domain', 'project.resource-limits-updated', ?2, 0,
                  ?3, ?4, 'deployment_owner', project.workspace_id, project.id,
                  'project', project.id,
                  json_object(
                    'project_version', project.version,
                    'resource_limits', json_object(
                      'issues', project.issue_limit,
                      'comments', project.comment_limit,
                      'principals', project.principal_limit
                    ),
                    'active_usage', json_object(
                      'issues', usage.active_issue_count,
                      'comments', usage.active_comment_count,
                      'principals', usage.active_principal_count
                    )
                  ), ?5
           FROM projects project
           JOIN public_join_policies policy ON policy.project_id = project.id
           JOIN project_usage usage ON usage.project_id = project.id
           WHERE project.id = ?6 AND project.last_operation_id = ?2
             AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          auth.principalId,
          actorCredentialId(auth),
          now,
          projectId,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readPolicyControl(db, auth, projectId, now);
        return latest === null
          || latest.project_version !== expectedVersion
          || latest.enabled_at === null
          || latest.disabled_at !== null
          || latest.usage_present !== 1
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: projectId,
      primarySubjectType: "project",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = await readPolicyControl(db, auth, projectId, now);
      if (latest === null) throw notFound();
      if (latest.enabled_at === null || latest.disabled_at !== null || latest.usage_present !== 1) {
        throw conflict("PUBLIC_JOIN_DISABLED", "enable_public_join");
      }
      throw versionConflict(latest.project_version);
    }
    throw error;
  }
  const activeUsage = await readOperationActiveUsage(
    db,
    operationId,
    "project.resource-limits-updated",
  );
  updated.active_comment_count = activeUsage.comments;
  updated.active_issue_count = activeUsage.issues;
  updated.active_principal_count = activeUsage.principals;
  return writeResult(db, auth, policyResource(updated), commit.lastEventSequence, false);
}

export async function getRateLimitSettings(
  db: D1Database,
  auth: AuthContext,
  now: number,
  policies: RateLimitPolicies,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  await verifyCurrentAuth(db, auth, now);
  return {
    allowed_actions: ["read"],
    configuration_source: "worker_configuration",
    editable_via_api: false,
    policies: {
      instance: {
        limit: policies.instance.limit,
        period_seconds: policies.instance.periodSeconds,
      },
      principal: {
        limit: policies.principal.limit,
        period_seconds: policies.principal.periodSeconds,
      },
      unauthenticated_sensitive: {
        limit: policies.unauthenticated_sensitive.limit,
        period_seconds: policies.unauthenticated_sensitive.periodSeconds,
      },
    },
    recent_429_summary: {
      as_of: timestamp(now),
      ...recentRateLimitSummary(now),
    },
  };
}

type PublicJoinRedeemAs = "current_principal" | "new_principal";
type PublicJoinOutcome = "already_has_access" | "created" | "promoted" | "regranted";

interface PublicJoinTargetRow {
  active_principal_count: number | null;
  comment_limit: number | null;
  display_name: string;
  disabled_at: number | null;
  enabled_at: number | null;
  issue_limit: number | null;
  principal_limit: number | null;
  project_id: string;
  project_key: string;
  public_id: string;
  public_summary: string;
  usage_present: number;
  workspace_display_name: string;
  workspace_id: string;
  workspace_key: string;
  workspace_deleted_at: number | null;
  project_deleted_at: number | null;
}

interface PublicJoinGrantRow {
  id: string;
  revoked_at: number | null;
  role: ProjectRole;
  version: number;
}

interface PublicJoinSnapshot {
  credential: {
    id: string;
    issued_at: number;
    token_prefix: string;
  } | null;
  grant: {
    id: string;
    role: ProjectRole;
    version: number;
  };
  outcome: PublicJoinOutcome;
  principal: {
    display_name: string;
    id: string;
  };
  project: {
    display_name: string;
    id: string;
    key: string;
    public_summary: string;
    workspace_id: string;
    workspace_key: string;
  };
  public_id: string;
}

function requirePublicJoinRedeemAs(value: JsonValue): PublicJoinRedeemAs {
  if (value !== "current_principal" && value !== "new_principal") {
    throw validationError("schema_validation_failed", { field: "redeem_as" });
  }
  return value;
}

async function readPublicJoinTarget(
  db: D1Database,
  publicId: string,
): Promise<PublicJoinTargetRow | null> {
  try {
    return await db.prepare(
      `SELECT policy.public_id, policy.public_summary,
              policy.enabled_at, policy.disabled_at,
              project.id AS project_id, project.key AS project_key,
              project.display_name, project.deleted_at AS project_deleted_at,
              project.issue_limit, project.comment_limit, project.principal_limit,
              workspace.id AS workspace_id, workspace.key AS workspace_key,
              workspace.display_name AS workspace_display_name,
              workspace.deleted_at AS workspace_deleted_at,
              CASE WHEN usage.project_id IS NULL THEN 0 ELSE 1 END AS usage_present,
              usage.active_principal_count
       FROM public_join_policies policy
       JOIN projects project ON project.id = policy.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       LEFT JOIN project_usage usage ON usage.project_id = project.id
       WHERE policy.public_id = ?1
       LIMIT 1`,
    ).bind(publicId).first<PublicJoinTargetRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function publicJoinTargetEnabled(target: PublicJoinTargetRow | null): target is PublicJoinTargetRow {
  return target !== null
    && target.enabled_at !== null
    && target.disabled_at === null
    && target.project_deleted_at === null
    && target.workspace_deleted_at === null
    && target.issue_limit !== null
    && target.comment_limit !== null
    && target.principal_limit !== null
    && target.usage_present === 1
    && target.active_principal_count !== null;
}

async function readPublicJoinGrant(
  db: D1Database,
  principalId: string,
  projectId: string,
): Promise<PublicJoinGrantRow | null> {
  try {
    return await db.prepare(
      `SELECT id, role, revoked_at, version
       FROM project_grants
       WHERE principal_id = ?1 AND project_id = ?2
       LIMIT 1`,
    ).bind(principalId, projectId).first<PublicJoinGrantRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function activePublicJoinGrantExists(
  db: D1Database,
  principalId: string,
  projectId: string,
): Promise<boolean> {
  try {
    return await db.prepare(
      `SELECT 1 AS allowed
       FROM project_grants grant_row
       JOIN projects project ON project.id = grant_row.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE grant_row.principal_id = ?1 AND grant_row.project_id = ?2
         AND grant_row.revoked_at IS NULL
         AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
       LIMIT 1`,
    ).bind(principalId, projectId).first() !== null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function credentialDigestExists(db: D1Database, digest: string): Promise<boolean> {
  try {
    return await db.prepare(
      "SELECT 1 AS present FROM credentials WHERE token_digest = ?1 LIMIT 1",
    ).bind(digest).first() !== null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function assertSecretNotInText(value: string, field: string, secret: string): void {
  if (secret.length >= 8 && value.includes(secret)) {
    throw validationError("secret_value_reused", { field });
  }
}

async function assertCurrentPublicJoinAuth(
  db: D1Database,
  auth: AuthContext,
  projectId: string,
  now: number,
): Promise<void> {
  if (auth.isOwner) throw forbidden();
  await verifyCurrentAuth(db, auth, now);
  if (auth.kind !== "cookie" || auth.targetKind === "project_selection") return;
  if (auth.targetKind === "admin") throw forbidden();
  const visible = await resolveCurrentVisibleProjects(db, auth, now);
  if (!visible.some((project) => project.projectId === projectId)) throw forbidden();
}

async function authorizePublicJoin(
  db: D1Database,
  target: PublicJoinTargetRow,
  auth: AuthContext | null,
  replacementToken: string | null,
  replacementDigest: string | null,
  now: number,
): Promise<void> {
  if (auth !== null) {
    await assertCurrentPublicJoinAuth(db, auth, target.project_id, now);
    const current = await readPublicJoinTarget(db, target.public_id);
    if (
      publicJoinTargetEnabled(current)
      || await activePublicJoinGrantExists(db, auth.principalId, target.project_id)
    ) return;
    throw notFound();
  }
  if (replacementToken === null || replacementDigest === null) throw unauthorized();
  if (await credentialDigestExists(db, replacementDigest)) {
    let tokenAuth: AuthContext;
    try {
      tokenAuth = await authenticateBearer(db, `Bearer ${replacementToken}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") throw unauthorized();
      throw error;
    }
    if (
      tokenAuth.isOwner
      || !(await activePublicJoinGrantExists(db, tokenAuth.principalId, target.project_id))
    ) throw forbidden();
    return;
  }
  if (!publicJoinTargetEnabled(await readPublicJoinTarget(db, target.public_id))) throw notFound();
}

function publicJoinOutcome(
  grant: PublicJoinGrantRow | null,
  requestedRole: ProjectRole,
): { effectiveRole: ProjectRole; outcome: PublicJoinOutcome; usageDelta: 0 | 1 } {
  if (grant === null) return { effectiveRole: requestedRole, outcome: "created", usageDelta: 1 };
  if (grant.revoked_at !== null) return { effectiveRole: requestedRole, outcome: "regranted", usageDelta: 1 };
  if (grant.role === "reader" && requestedRole === "writer") {
    return { effectiveRole: "writer", outcome: "promoted", usageDelta: 0 };
  }
  return { effectiveRole: grant.role, outcome: "already_has_access", usageDelta: 0 };
}

function fixedSessionTargetGuard(
  auth: AuthContext | null,
  projectExpression: string,
  startIndex: number,
): { sql: string; values: string[] } {
  if (auth?.kind !== "cookie" || auth.targetKind === "project_selection") {
    return { sql: "1 = 1", values: [] };
  }
  if (auth.targetKind === "project") {
    return {
      sql: `EXISTS (
        SELECT 1 FROM web_sessions fixed_session
        WHERE fixed_session.id = ?${startIndex}
          AND fixed_session.target_kind = 'project'
          AND json_extract(fixed_session.target_json, '$.project_id') = ${projectExpression}
      )`,
      values: [auth.sessionId],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM web_sessions fixed_session
      JOIN issues fixed_issue
        ON fixed_issue.id = json_extract(fixed_session.target_json, '$.issue_id')
      WHERE fixed_session.id = ?${startIndex}
        AND fixed_session.target_kind = 'issue'
        AND fixed_issue.project_id = ${projectExpression}
        AND fixed_issue.deleted_at IS NULL
    )`,
    values: [auth.sessionId],
  };
}

function publicJoinSnapshotStatement(
  db: D1Database,
  operationId: string,
  target: PublicJoinTargetRow,
  principalId: string,
  outcome: PublicJoinOutcome,
  effectiveRole: ProjectRole,
  replacementToken: string | null,
  expectedGrantVersion: number,
  expectedGrantRole: ProjectRole,
  auth: AuthContext | null,
  now: number,
): D1PreparedStatement {
  const authGuard = auth === null ? null : buildCurrentAuthGuard(auth, now, 9);
  const targetGuard = fixedSessionTargetGuard(
    auth,
    "project.id",
    9 + (authGuard?.values.length ?? 0),
  );
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT json_object(
         'credential', json((
           SELECT json_object(
             'id', credential.id,
             'issued_at', credential.issued_at,
             'token_prefix', credential.token_prefix
           )
           FROM credentials credential
           WHERE credential.created_operation_id = ?1
           LIMIT 1
         )),
         'grant', json_object(
           'id', grant_row.id,
           'role', grant_row.role,
           'version', grant_row.version
         ),
         'outcome', ?4,
         'principal', json_object(
           'display_name', principal.display_name,
           'id', principal.id
         ),
         'project', json_object(
           'display_name', project.display_name,
           'id', project.id,
           'key', project.key,
           'public_summary', policy.public_summary,
           'workspace_id', workspace.id,
           'workspace_key', workspace.key
         ),
         'public_id', policy.public_id
       )
       FROM public_join_policies policy
       JOIN projects project ON project.id = policy.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       JOIN project_usage usage ON usage.project_id = project.id
       JOIN project_grants grant_row
         ON grant_row.project_id = project.id AND grant_row.principal_id = ?3
       JOIN principals principal ON principal.id = grant_row.principal_id
       WHERE policy.public_id = ?2
         AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
         AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
         AND project.principal_limit IS NOT NULL
         AND grant_row.revoked_at IS NULL AND grant_row.role = ?5
         AND (
           (?4 IN ('created', 'regranted', 'promoted')
             AND grant_row.last_operation_id = ?1)
           OR
           (?4 = 'already_has_access'
             AND grant_row.version = ?7 AND grant_row.role = ?8)
         )
         AND (?4 NOT IN ('created', 'regranted') OR usage.last_operation_id = ?1)
         AND (?6 = '' OR (
           principal.last_operation_id = ?1
           AND EXISTS (SELECT 1 FROM credentials created_credential
                       WHERE created_credential.principal_id = principal.id
                         AND created_credential.created_operation_id = ?1)
           AND instr(principal.display_name, ?6) = 0
           AND instr(project.display_name, ?6) = 0
           AND instr(project.key, ?6) = 0
           AND instr(workspace.display_name, ?6) = 0
           AND instr(workspace.key, ?6) = 0
           AND instr(policy.public_summary, ?6) = 0
         ))
         AND ${authGuard?.sql ?? "1 = 1"}
         AND ${targetGuard.sql}
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(
    operationId,
    target.public_id,
    principalId,
    outcome,
    effectiveRole,
    replacementToken ?? "",
    expectedGrantVersion,
    expectedGrantRole,
    ...(authGuard?.values ?? []),
    ...targetGuard.values,
  );
}

function publicJoinEventStatements(
  db: D1Database,
  auth: AuthContext | null,
  operationId: string,
  now: number,
): D1PreparedStatement[] {
  const actorCredential = auth === null ? null : actorCredentialId(auth);
  return [
    db.prepare(
      `INSERT INTO events
        (id, stream, type, operation_id, event_index, actor_principal_id,
         actor_credential_id, authorized_via, grant_id, workspace_id,
         project_id, subject_type, subject_id, payload_json, created_at)
       SELECT ?1, 'domain', 'public-join.redeemed', ?2, 0,
              json_extract(record.operation_snapshot_json, '$.principal.id'),
              ?3, 'public_join',
              json_extract(record.operation_snapshot_json, '$.grant.id'),
              json_extract(record.operation_snapshot_json, '$.project.workspace_id'),
              json_extract(record.operation_snapshot_json, '$.project.id'),
              'project_grant',
              json_extract(record.operation_snapshot_json, '$.grant.id'),
              json_object(
                'outcome', json_extract(record.operation_snapshot_json, '$.outcome'),
                'effective_role', json_extract(record.operation_snapshot_json, '$.grant.role'),
                'grant_version', json_extract(record.operation_snapshot_json, '$.grant.version'),
                'effective_capabilities', json_object(
                  'read', json('true'),
                  'write', json(CASE
                    WHEN json_extract(record.operation_snapshot_json, '$.grant.role') = 'writer'
                    THEN 'true' ELSE 'false' END)
                )
              ), ?4
       FROM idempotency_records record
       WHERE record.operation_id = ?2 AND record.state = 'pending'
         AND record.operation_snapshot_json IS NOT NULL`,
    ).bind(crypto.randomUUID(), operationId, actorCredential, now),
    db.prepare(
      `INSERT INTO events
        (id, stream, type, operation_id, event_index, actor_principal_id,
         actor_credential_id, authorized_via, project_id, subject_type,
         subject_id, payload_json, created_at)
       SELECT ?1, 'security', 'principal.public-join-redeemed', ?2, 1,
              json_extract(record.operation_snapshot_json, '$.principal.id'),
              ?3, 'public_join',
              json_extract(record.operation_snapshot_json, '$.project.id'),
              'principal',
              json_extract(record.operation_snapshot_json, '$.principal.id'),
              json_object(
                'outcome', json_extract(record.operation_snapshot_json, '$.outcome'),
                'public_id', json_extract(record.operation_snapshot_json, '$.public_id'),
                'role', json_extract(record.operation_snapshot_json, '$.grant.role')
              ), ?4
       FROM idempotency_records record
       WHERE record.operation_id = ?2 AND record.state = 'pending'
         AND record.operation_snapshot_json IS NOT NULL`,
    ).bind(crypto.randomUUID(), operationId, actorCredential, now),
  ];
}

function publicJoinResource(snapshot: PublicJoinSnapshot): { [key: string]: JsonValue } {
  return {
    allowed_actions: snapshot.grant.role === "writer" ? ["read", "write"] : ["read"],
    credential: snapshot.credential === null ? null : {
      fingerprint: `cfk_v1_${snapshot.credential.token_prefix}_…`,
      id: snapshot.credential.id,
      issued_at: timestamp(snapshot.credential.issued_at),
    },
    grant: {
      effective_capabilities: {
        read: true,
        write: snapshot.grant.role === "writer",
      },
      id: snapshot.grant.id,
      role: snapshot.grant.role,
      version: snapshot.grant.version,
    },
    outcome: snapshot.outcome,
    principal: {
      display_name: snapshot.principal.display_name,
      principal_id: snapshot.principal.id,
    },
    project: {
      display_name: snapshot.project.display_name,
      id: snapshot.project.id,
      key: snapshot.project.key,
      public_summary: snapshot.project.public_summary,
      workspace_id: snapshot.project.workspace_id,
      workspace_key: snapshot.project.workspace_key,
    },
    public_id: snapshot.public_id,
  };
}

function sameGrantState(
  left: PublicJoinGrantRow | null,
  right: PublicJoinGrantRow | null,
): boolean {
  return left?.id === right?.id
    && left?.role === right?.role
    && left?.revoked_at === right?.revoked_at
    && left?.version === right?.version;
}

export async function redeemPublicJoin(
  db: D1Database,
  request: Request,
  auth: AuthContext | null,
  publicIdValue: JsonValue,
  redeemAsValue: JsonValue,
  roleValue: JsonValue,
  displayNameValue: JsonValue | undefined,
  credentialTokenValue: JsonValue | undefined,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const publicId = requireUuid(publicIdValue, "public_id");
  const redeemAs = requirePublicJoinRedeemAs(redeemAsValue);
  const requestedRole = requireProjectRole(roleValue);
  let displayName: string | null = null;
  let replacement: { digest: string; id: string; prefix: string; token: string } | null = null;
  if (redeemAs === "new_principal") {
    if (auth !== null) throw validationError("public_join_mode_fields_mixed");
    displayName = requireDisplayName(displayNameValue as JsonValue);
    const token = requireCredentialToken(credentialTokenValue as JsonValue, "new_credential_token");
    assertSecretNotInText(displayName, "display_name", token.token);
    replacement = {
      digest: await sha256Hex(token.token),
      id: crypto.randomUUID(),
      prefix: token.prefix,
      token: token.token,
    };
  } else {
    if (auth === null) throw unauthorized();
    if (displayNameValue !== undefined || credentialTokenValue !== undefined) {
      throw validationError("public_join_mode_fields_mixed");
    }
  }
  const initialTarget = await readPublicJoinTarget(db, publicId);
  if (initialTarget === null) throw notFound();
  if (replacement !== null && publicJoinTargetEnabled(initialTarget)) {
    for (const [field, value] of [
      ["project_display_name", initialTarget.display_name],
      ["project_key", initialTarget.project_key],
      ["public_summary", initialTarget.public_summary],
      ["workspace_display_name", initialTarget.workspace_display_name],
      ["workspace_key", initialTarget.workspace_key],
    ] as const) {
      assertSecretNotInText(value, field, replacement.token);
    }
  }
  const principalId = auth?.principalId ?? crypto.randomUUID();
  const proposedGrantId = crypto.randomUUID();
  let expectedGrant: PublicJoinGrantRow | null = null;
  let expectedOutcome: ReturnType<typeof publicJoinOutcome> | null = null;
  const result = await runIdempotentOperation({
    authorize: () => authorizePublicJoin(
      db,
      initialTarget,
      auth,
      replacement?.token ?? null,
      replacement?.digest ?? null,
      now,
    ),
    db,
    execute: async (operationId) => {
      const target = await readPublicJoinTarget(db, publicId);
      if (!publicJoinTargetEnabled(target)) throw notFound();
      if (auth !== null) await assertCurrentPublicJoinAuth(db, auth, target.project_id, now);
      if (replacement !== null) {
        if (await credentialDigestExists(db, replacement.digest)) {
          throw conflict("CREDENTIAL_TOKEN_CONFLICT", "generate_new_credential");
        }
        for (const [field, value] of [
          ["project_display_name", target.display_name],
          ["project_key", target.project_key],
          ["public_summary", target.public_summary],
          ["workspace_display_name", target.workspace_display_name],
          ["workspace_key", target.workspace_key],
        ] as const) {
          assertSecretNotInText(value, field, replacement.token);
        }
      }
      expectedGrant = await readPublicJoinGrant(db, principalId, target.project_id);
      expectedOutcome = publicJoinOutcome(expectedGrant, requestedRole);
      if (
        expectedOutcome.usageDelta === 1
        && (target.active_principal_count ?? Number.MAX_SAFE_INTEGER) >= (target.principal_limit ?? 0)
      ) {
        throw businessQuotaExceeded("principals");
      }
      const grantId = expectedGrant?.id ?? proposedGrantId;
      const statements: D1PreparedStatement[] = [];
      if (replacement !== null && displayName !== null) {
        statements.push(db.prepare(
          `INSERT INTO principals
            (id, display_name, version, created_at, updated_at, last_operation_id)
           SELECT ?1, ?2, 1, ?3, ?3, ?4
           FROM public_join_policies policy
           JOIN projects project ON project.id = policy.project_id
           JOIN workspaces workspace ON workspace.id = project.workspace_id
           JOIN project_usage usage ON usage.project_id = project.id
           WHERE policy.public_id = ?5
             AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
             AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
             AND project.principal_limit IS NOT NULL
             AND usage.active_principal_count < project.principal_limit
             AND instr(?2, ?6) = 0
             AND instr(project.display_name, ?6) = 0
             AND instr(project.key, ?6) = 0
             AND instr(workspace.display_name, ?6) = 0
             AND instr(workspace.key, ?6) = 0
             AND instr(policy.public_summary, ?6) = 0`,
        ).bind(principalId, displayName, now, operationId, publicId, replacement.token));
        statements.push(db.prepare(
          `INSERT INTO credentials
            (id, principal_id, token_prefix, token_digest, issued_at,
             created_operation_id, last_operation_id)
           SELECT ?1, principal.id, ?2, ?3, ?4, ?5, ?5
           FROM principals principal
           WHERE principal.id = ?6 AND principal.last_operation_id = ?5`,
        ).bind(
          replacement.id,
          replacement.prefix,
          replacement.digest,
          now,
          operationId,
          principalId,
        ));
      }
      if (expectedOutcome.outcome === "created") {
        const guard = auth === null ? null : buildCurrentAuthGuard(auth, now, 7);
        statements.push(db.prepare(
          `INSERT INTO project_grants
            (id, principal_id, project_id, role, version, created_at,
             updated_at, created_operation_id, last_operation_id)
           SELECT ?1, principal.id, project.id, ?4, 1, ?5, ?5, ?6, ?6
           FROM public_join_policies policy
           JOIN projects project ON project.id = policy.project_id
           JOIN workspaces workspace ON workspace.id = project.workspace_id
           JOIN project_usage usage ON usage.project_id = project.id
           JOIN principals principal ON principal.id = ?2
           WHERE policy.public_id = ?3
             AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
             AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
             AND project.principal_limit IS NOT NULL
             AND usage.active_principal_count < project.principal_limit
             AND NOT EXISTS (SELECT 1 FROM project_grants existing
                             WHERE existing.principal_id = principal.id
                               AND existing.project_id = project.id)
             ${replacement === null ? "" : `AND principal.last_operation_id = ?6
               AND EXISTS (SELECT 1 FROM credentials credential
                           WHERE credential.principal_id = principal.id
                             AND credential.created_operation_id = ?6)`}
             AND ${guard?.sql ?? "1 = 1"}`,
        ).bind(
          grantId,
          principalId,
          publicId,
          requestedRole,
          now,
          operationId,
          ...(guard?.values ?? []),
        ));
      } else if (expectedOutcome.outcome === "regranted") {
        const guard = auth === null ? null : buildCurrentAuthGuard(auth, now, 8);
        statements.push(db.prepare(
          `UPDATE project_grants
           SET role = ?1, revoked_at = NULL, revoked_by_principal_id = NULL,
               version = version + 1, updated_at = ?2, last_operation_id = ?3
           WHERE id = ?4 AND version = ?5 AND principal_id = ?7
             AND revoked_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM public_join_policies policy
               JOIN projects project ON project.id = policy.project_id
               JOIN workspaces workspace ON workspace.id = project.workspace_id
               JOIN project_usage usage ON usage.project_id = project.id
               WHERE policy.public_id = ?6
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
                 AND project.id = project_grants.project_id
                 AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
                 AND project.principal_limit IS NOT NULL
                 AND usage.active_principal_count < project.principal_limit
             )
             AND ${guard?.sql ?? "1 = 1"}`,
        ).bind(
          requestedRole,
          now,
          operationId,
          grantId,
          expectedGrant?.version,
          publicId,
          principalId,
          ...(guard?.values ?? []),
        ));
      } else if (expectedOutcome.outcome === "promoted") {
        const guard = auth === null ? null : buildCurrentAuthGuard(auth, now, 7);
        statements.push(db.prepare(
          `UPDATE project_grants
           SET role = 'writer', version = version + 1,
               updated_at = ?1, last_operation_id = ?2
           WHERE id = ?3 AND version = ?4 AND principal_id = ?6
             AND role = 'reader' AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM public_join_policies policy
               JOIN projects project ON project.id = policy.project_id
               JOIN workspaces workspace ON workspace.id = project.workspace_id
               JOIN project_usage usage ON usage.project_id = project.id
               WHERE policy.public_id = ?5
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
                 AND project.id = project_grants.project_id
                 AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
             )
             AND ${guard?.sql ?? "1 = 1"}`,
        ).bind(
          now,
          operationId,
          grantId,
          expectedGrant?.version,
          publicId,
          principalId,
          ...(guard?.values ?? []),
        ));
      }
      if (expectedOutcome.usageDelta === 1) {
        statements.push(db.prepare(
          `UPDATE project_usage
           SET active_principal_count = active_principal_count + 1,
               updated_at = ?1, last_operation_id = ?2
           WHERE project_id = (
             SELECT project_id FROM public_join_policies WHERE public_id = ?3
           )
             AND active_principal_count < (
               SELECT project.principal_limit
               FROM projects project
               JOIN public_join_policies policy ON policy.project_id = project.id
               WHERE policy.public_id = ?3
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM project_grants grant_row
               WHERE grant_row.project_id = project_usage.project_id
                 AND grant_row.principal_id = ?4
                 AND grant_row.revoked_at IS NULL
                 AND grant_row.last_operation_id = ?2
             )`,
        ).bind(now, operationId, publicId, principalId));
      }
      const expectedGrantVersion = expectedOutcome.outcome === "created"
        ? 1
        : expectedOutcome.outcome === "already_has_access"
          ? expectedGrant?.version ?? 0
          : (expectedGrant?.version ?? 0) + 1;
      statements.push(publicJoinSnapshotStatement(
        db,
        operationId,
        target,
        principalId,
        expectedOutcome.outcome,
        expectedOutcome.effectiveRole,
        replacement?.token ?? null,
        expectedGrantVersion,
        expectedOutcome.effectiveRole,
        auth,
        now,
      ));
      statements.push(...publicJoinEventStatements(db, auth, operationId, now));
      try {
        await executeAtomicBatch(db, {
          businessStatements: statements,
          committedAt: now,
          confirmBusinessRejection: async () => {
            const latestTarget = await readPublicJoinTarget(db, publicId);
            if (!publicJoinTargetEnabled(latestTarget)) return true;
            if (auth !== null) {
              try {
                await assertCurrentPublicJoinAuth(db, auth, target.project_id, now);
              } catch (error) {
                if (error instanceof ApiError) return true;
                throw error;
              }
            }
            if (replacement !== null && await credentialDigestExists(db, replacement.digest)) return true;
            if (replacement !== null) {
              const targetTexts = [
                latestTarget.display_name,
                latestTarget.project_key,
                latestTarget.public_summary,
                latestTarget.workspace_display_name,
                latestTarget.workspace_key,
              ];
              if (targetTexts.some((value) => value.includes(replacement.token))) return true;
            }
            const latestGrant = await readPublicJoinGrant(db, principalId, target.project_id);
            if (!sameGrantState(latestGrant, expectedGrant)) return true;
            return expectedOutcome?.usageDelta === 1
              && (latestTarget.active_principal_count ?? Number.MAX_SAFE_INTEGER)
                >= (latestTarget.principal_limit ?? 0);
          },
          expectedEventCount: 2,
          operationId,
          primarySubjectId: grantId,
          primarySubjectType: "project_grant",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          const latestTarget = await readPublicJoinTarget(db, publicId);
          if (!publicJoinTargetEnabled(latestTarget)) throw notFound();
          if (auth !== null) await assertCurrentPublicJoinAuth(db, auth, target.project_id, now);
          if (replacement !== null && await credentialDigestExists(db, replacement.digest)) {
            throw conflict("CREDENTIAL_TOKEN_CONFLICT", "generate_new_credential");
          }
          if (replacement !== null) {
            for (const [field, value] of [
              ["project_display_name", latestTarget.display_name],
              ["project_key", latestTarget.project_key],
              ["public_summary", latestTarget.public_summary],
              ["workspace_display_name", latestTarget.workspace_display_name],
              ["workspace_key", latestTarget.workspace_key],
            ] as const) {
              assertSecretNotInText(value, field, replacement.token);
            }
          }
          const latestGrant = await readPublicJoinGrant(db, principalId, target.project_id);
          if (!sameGrantState(latestGrant, expectedGrant)) {
            throw conflict("PUBLIC_JOIN_STATE_CHANGED", "retry_with_new_idempotency_key");
          }
          if (
            expectedOutcome.usageDelta === 1
            && (latestTarget.active_principal_count ?? Number.MAX_SAFE_INTEGER)
              >= (latestTarget.principal_limit ?? 0)
          ) throw businessQuotaExceeded("principals");
        }
        throw error;
      }
    },
    forbiddenPersistenceValues: replacement === null ? [] : [replacement.token],
    idempotencyKey: requireIdempotencyKey(request),
    method: "POST",
    normalizedResourceScope: `public-join:${publicId}:redeem`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<PublicJoinSnapshot>(db, operationId);
      return {
        body: await writeResult(
          db,
          { principalId: snapshot.principal.id },
          publicJoinResource(snapshot),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: {
      display_name: displayName,
      new_credential_token: replacement?.token ?? null,
      redeem_as: redeemAs,
      role: requestedRole,
    },
    routeTemplate: "/api/v1/public-joins/{public_id}/redeem",
    scopeKey: auth === null ? `public-join:${publicId}` : `principal:${auth.principalId}`,
  });
  return {
    ...(result.body as { [key: string]: JsonValue }),
    idempotent_replay: result.idempotentReplay,
  };
}
