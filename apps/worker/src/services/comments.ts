import { requireUuid, timestamp } from "../domain/model.ts";
import { verifyCurrentAuth } from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { isUuid } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import {
  ApiError,
  conflict,
  forbidden,
  invalidTransition,
  notFound,
  platformUnavailable,
  versionConflict,
} from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  assertCommentCapacity,
  buildProjectRoleGuard,
  issueReference,
  requireCollaborationIssue,
  requireCollaborationIssueAuthorization,
  requireCollaborationIssueById,
  requireCollaborationIssueByIdAuthorization,
  requireCommentBody,
  requireCompletionPayload,
  roleCanWrite,
  type CollaborationIssue,
  type CompletionPayload,
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

interface CommentRow {
  author_display_name: string;
  author_principal_id: string;
  body: string;
  completion_json: string | null;
  created_at: number;
  deleted_at: number | null;
  deleted_by_principal_id: string | null;
  id: string;
  issue_id: string;
  kind: "completion" | "standard";
  last_operation_id: string | null;
  reply_to_comment_id: string | null;
  version: number;
}

interface CommentAccess {
  issue: CollaborationIssue;
  row: CommentRow;
}

function completionPayload(value: string | null): JsonValue {
  if (value === null) return null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw platformUnavailable("d1");
  }
}

function commentAllowedActions(row: CommentRow, issue: CollaborationIssue): string[] {
  if (!roleCanWrite(issue.role) || row.kind === "completion") return ["read"];
  if (row.deleted_at === null) return ["read", "delete"];
  return issue.deletedAt === null && issue.projectDeletedAt === null && issue.workspaceDeletedAt === null
    ? ["read", "restore"]
    : ["read"];
}

function commentResource(row: CommentRow, issue: CollaborationIssue): { [key: string]: JsonValue } {
  const unavailabilityReason = issue.workspaceDeletedAt !== null
    ? { code: "PARENT_WORKSPACE_DELETED", recovery: "restore_parent" }
    : issue.projectDeletedAt !== null
      ? { code: "PARENT_PROJECT_DELETED", recovery: "restore_parent" }
      : issue.deletedAt !== null
        ? { code: "PARENT_ISSUE_DELETED", recovery: "restore_parent" }
        : null;
  const restorable = row.deleted_at !== null
    && row.kind === "standard"
    && roleCanWrite(issue.role)
    && unavailabilityReason === null;
  return {
    allowed_actions: commentAllowedActions(row, issue),
    author: {
      display_name: row.author_display_name,
      principal_id: row.author_principal_id,
    },
    body: row.deleted_at === null ? row.body : null,
    completion: row.deleted_at === null ? completionPayload(row.completion_json) : null,
    created_at: timestamp(row.created_at),
    deleted_at: timestamp(row.deleted_at),
    deleted_by_principal_id: row.deleted_by_principal_id,
    id: row.id,
    issue: issueReference(issue),
    kind: row.kind,
    reply_to_comment_id: row.reply_to_comment_id,
    version: row.version,
    ...(row.deleted_at === null ? {} : {
      parent_status: {
        issue: issue.deletedAt === null ? "active" : "deleted",
        project: issue.projectDeletedAt === null ? "active" : "deleted",
        workspace: issue.workspaceDeletedAt === null ? "active" : "deleted",
      },
      restorable,
      unavailability_reason: unavailabilityReason,
    }),
  };
}

async function readComment(db: D1Database, commentId: string): Promise<CommentRow | null> {
  try {
    return await db.prepare(
      `SELECT comment.id, comment.issue_id, comment.kind,
              comment.author_principal_id, author.display_name AS author_display_name,
              comment.body, comment.completion_json, comment.reply_to_comment_id,
              comment.version, comment.deleted_at, comment.deleted_by_principal_id,
              comment.created_at, comment.last_operation_id
       FROM comments comment
       JOIN principals author ON author.id = comment.author_principal_id
       WHERE comment.id = ?1
       LIMIT 1`,
    ).bind(commentId).first<CommentRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function requireCommentAccess(
  db: D1Database,
  auth: AuthContext,
  commentIdValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
  includeEffectiveDeleted = false,
): Promise<CommentAccess> {
  const commentId = requireUuid(commentIdValue, "comment_id");
  const row = await readComment(db, commentId);
  if (row === null) throw notFound();
  const issue = includeEffectiveDeleted
    ? await requireCollaborationIssueByIdAuthorization(db, auth, row.issue_id, requiredRole)
    : await requireCollaborationIssueById(db, auth, row.issue_id, requiredRole);
  return { issue, row };
}

function parseCommentCursor(last: JsonValue[] | null): [number, string] | null {
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

function commentSnapshotStatement(
  db: D1Database,
  operationId: string,
  commentId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT json_object(
         'author_display_name', author.display_name,
         'author_principal_id', comment.author_principal_id,
         'body', comment.body,
         'completion_json', comment.completion_json,
         'created_at', comment.created_at,
         'deleted_at', comment.deleted_at,
         'deleted_by_principal_id', comment.deleted_by_principal_id,
         'id', comment.id,
         'issue_id', comment.issue_id,
         'kind', comment.kind,
         'last_operation_id', comment.last_operation_id,
         'reply_to_comment_id', comment.reply_to_comment_id,
         'version', comment.version
       )
       FROM comments comment
       JOIN principals author ON author.id = comment.author_principal_id
       WHERE comment.id = ?2 AND comment.last_operation_id = ?1
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, commentId);
}

async function commentEvent(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  commentId: string,
  type: string,
  payload: JsonValue,
  now: number,
): Promise<D1PreparedStatement> {
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
            'comment', comment.id, ?8, ?9
     FROM comments comment
     JOIN issues issue ON issue.id = comment.issue_id
     JOIN projects project ON project.id = issue.project_id
     LEFT JOIN public_join_policies policy ON policy.project_id = issue.project_id
     LEFT JOIN project_usage usage ON usage.project_id = issue.project_id
     WHERE comment.id = ?10 AND comment.last_operation_id = ?3
       AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
            OR usage.last_operation_id = ?3)`,
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
    commentId,
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

async function assertReplyValid(
  db: D1Database,
  issueId: string,
  replyToCommentId: string | null,
): Promise<void> {
  if (replyToCommentId === null) return;
  try {
    const reply = await db.prepare(
      `SELECT id FROM comments
       WHERE id = ?1 AND issue_id = ?2 AND deleted_at IS NULL`,
    ).bind(replyToCommentId, issueId).first();
    if (reply === null) throw notFound();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1");
  }
}

async function diagnoseCommentCreate(
  db: D1Database,
  auth: AuthContext,
  identifier: string,
  replyToCommentId: string | null,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const issue = await requireCollaborationIssue(db, auth, identifier, "writer");
  await assertReplyValid(db, issue.id, replyToCommentId);
  await assertCommentCapacity(db, issue.projectId);
  throw platformUnavailable("d1");
}

export async function listComments(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const deletedMode = requireDeletedMode(url);
  const issue = deletedMode === "only"
    ? await requireCollaborationIssueAuthorization(db, auth, identifierValue, "writer")
    : await requireCollaborationIssue(db, auth, identifierValue, "reader");
  const context = await createCursorContext(
    "comments",
    { deleted: deletedMode, issue_id: issue.id },
    [issue.projectId],
    auth.principalId,
  );
  const cursor = parseCommentCursor(decodeCursor(url.searchParams.get("cursor"), context));
  const limit = requireLimit(url);
  let rows: CommentRow[];
  try {
    const result = deletedMode === "only"
      ? await db.prepare(
        `SELECT comment.id, comment.issue_id, comment.kind,
                comment.author_principal_id, author.display_name AS author_display_name,
                comment.body, comment.completion_json, comment.reply_to_comment_id,
                comment.version, comment.deleted_at, comment.deleted_by_principal_id,
                comment.created_at, comment.last_operation_id
         FROM comments comment
         JOIN principals author ON author.id = comment.author_principal_id
         WHERE comment.issue_id = ?1 AND comment.deleted_at IS NOT NULL
           AND (?2 IS NULL OR comment.deleted_at < ?2
                OR (comment.deleted_at = ?2 AND comment.id < ?3))
         ORDER BY comment.deleted_at DESC, comment.id DESC
         LIMIT ?4`,
      ).bind(issue.id, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1).all<CommentRow>()
      : await db.prepare(
        `SELECT comment.id, comment.issue_id, comment.kind,
                comment.author_principal_id, author.display_name AS author_display_name,
                comment.body, comment.completion_json, comment.reply_to_comment_id,
                comment.version, comment.deleted_at, comment.deleted_by_principal_id,
                comment.created_at, comment.last_operation_id
         FROM comments comment
         JOIN principals author ON author.id = comment.author_principal_id
         WHERE comment.issue_id = ?1 AND comment.deleted_at IS NULL
           AND (?2 IS NULL OR comment.created_at > ?2
                OR (comment.created_at = ?2 AND comment.id > ?3))
         ORDER BY comment.created_at ASC, comment.id ASC
         LIMIT ?4`,
      ).bind(issue.id, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1).all<CommentRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: page.map((row) => commentResource(row, issue)),
    next_cursor: hasMore && tail !== undefined
      ? encodeCursor(context, [deletedMode === "only" ? tail.deleted_at ?? 0 : tail.created_at, tail.id])
      : null,
    resolved_scope: { issue: issueReference(issue) },
  };
}

export async function getComment(
  db: D1Database,
  auth: AuthContext,
  commentIdValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const deletedMode = requireDeletedMode(url);
  const { issue, row } = await requireCommentAccess(
    db,
    auth,
    commentIdValue,
    deletedMode === "only" ? "writer" : "reader",
    deletedMode === "only",
  );
  if ((row.deleted_at !== null) !== (deletedMode === "only")) throw notFound();
  return commentResource(row, issue);
}

export async function createComment(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  bodyValue: JsonValue,
  replyToCommentIdValue: JsonValue | undefined,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const issue = await requireCollaborationIssueAuthorization(db, auth, identifierValue, "writer");
  const body = requireCommentBody(bodyValue);
  const replyToCommentId = replyToCommentIdValue === undefined || replyToCommentIdValue === null
    ? null
    : requireUuid(replyToCommentIdValue, "reply_to_comment_id");
  const commentId = crypto.randomUUID();
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
      const guard = buildProjectRoleGuard(auth, now, 8, "issue.project_id");
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `UPDATE project_usage
               SET active_comment_count = active_comment_count + 1,
                   updated_at = ?1, last_operation_id = ?2
               WHERE project_id = ?3
                 AND active_comment_count < (
                   SELECT project.comment_limit
                   FROM projects project
                   JOIN public_join_policies policy ON policy.project_id = project.id
                   WHERE project.id = project_usage.project_id
                     AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
                 )`,
            ).bind(now, operationId, activeIssue.projectId),
            db.prepare(
              `INSERT INTO comments
                (id, issue_id, kind, author_principal_id, body,
                 completion_json, reply_to_comment_id, version, created_at,
                 created_operation_id, last_operation_id)
               SELECT ?1, issue.id, 'standard', ?3, ?4, NULL, ?5, 1, ?6, ?7, ?7
               FROM issues issue
               JOIN projects project ON project.id = issue.project_id
               JOIN workspaces workspace ON workspace.id = project.workspace_id
               LEFT JOIN public_join_policies policy ON policy.project_id = issue.project_id
               LEFT JOIN project_usage usage ON usage.project_id = issue.project_id
               WHERE issue.id = ?2 AND issue.deleted_at IS NULL
                 AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
                 AND (?5 IS NULL OR EXISTS (
                   SELECT 1 FROM comments reply
                   WHERE reply.id = ?5 AND reply.issue_id = issue.id AND reply.deleted_at IS NULL
                 ))
                 AND ${guard.sql}
                 AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
                      OR (usage.project_id IS NOT NULL
                          AND project.comment_limit IS NOT NULL
                          AND usage.last_operation_id = ?7))`,
            ).bind(
              commentId,
              activeIssue.id,
              auth.principalId,
              body,
              replyToCommentId,
              now,
              operationId,
              ...guard.values,
            ),
            commentSnapshotStatement(db, operationId, commentId),
            await commentEvent(db, auth, operationId, commentId, "comment.created", {
              comment_version: 1,
              issue_identifier: activeIssue.identifier,
              kind: "standard",
              reply_to_comment_id: replyToCommentId,
            }, now),
          ],
          committedAt: now,
          confirmBusinessRejection: () => deterministicRejection(
            () => diagnoseCommentCreate(db, auth, activeIssue.identifier, replyToCommentId, now),
          ),
          expectedEventCount: 1,
          operationId,
          primarySubjectId: commentId,
          primarySubjectType: "comment",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          return diagnoseCommentCreate(db, auth, activeIssue.identifier, replyToCommentId, now);
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `issue:${issue.id}:comment`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<CommentRow>(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          commentResource(snapshot, issue),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { body, reply_to_comment_id: replyToCommentId },
    routeTemplate: "/api/v1/issues/{identifier}/comments",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

async function diagnoseCommentCas(
  db: D1Database,
  auth: AuthContext,
  commentId: string,
  expectedVersion: number,
  expectedDeleted: boolean,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const { issue, row } = await requireCommentAccess(db, auth, commentId, "writer");
  if (row.kind === "completion") throw forbidden();
  if ((row.deleted_at !== null) !== expectedDeleted) {
    throw conflict(expectedDeleted ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED");
  }
  if (row.version !== expectedVersion) throw versionConflict(row.version);
  if (expectedDeleted) await assertCommentCapacity(db, issue.projectId);
  throw platformUnavailable("d1");
}

async function setCommentDeleted(
  db: D1Database,
  auth: AuthContext,
  access: CommentAccess,
  expectedVersion: number,
  now: number,
  deleted: boolean,
  operationId: string,
  persistSnapshot: boolean,
): Promise<OperationCommit> {
  const { issue, row } = access;
  const guard = buildProjectRoleGuard(auth, now, 7, "issue.project_id");
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE project_usage
           SET active_comment_count = active_comment_count + ?1,
               updated_at = ?2, last_operation_id = ?3
           WHERE project_id = ?4
             AND (?1 < 0 OR active_comment_count < (
               SELECT project.comment_limit
               FROM projects project
               JOIN public_join_policies policy ON policy.project_id = project.id
               WHERE project.id = project_usage.project_id
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
             ))
             AND (?1 > 0 OR active_comment_count > 0)`,
        ).bind(deleted ? -1 : 1, now, operationId, issue.projectId),
        db.prepare(
          `UPDATE comments
           SET deleted_at = ?1, deleted_by_principal_id = ?2,
               version = version + 1, last_operation_id = ?3
           WHERE id = ?4 AND issue_id = ?5 AND kind = 'standard'
             AND version = ?6
             AND ${deleted ? "deleted_at IS NULL" : "deleted_at IS NOT NULL"}
             AND EXISTS (
               SELECT 1 FROM issues issue
               JOIN projects project ON project.id = issue.project_id
               JOIN workspaces workspace ON workspace.id = project.workspace_id
               LEFT JOIN public_join_policies policy ON policy.project_id = issue.project_id
               LEFT JOIN project_usage usage ON usage.project_id = issue.project_id
               WHERE issue.id = comments.issue_id AND issue.deleted_at IS NULL
                 AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
                 AND ${guard.sql}
                 AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
                      OR usage.last_operation_id = ?3)
             )`,
        ).bind(
          deleted ? now : null,
          deleted ? auth.principalId : null,
          operationId,
          row.id,
          issue.id,
          expectedVersion,
          ...guard.values,
        ),
        ...(persistSnapshot ? [commentSnapshotStatement(db, operationId, row.id)] : []),
        await commentEvent(
          db,
          auth,
          operationId,
          row.id,
          deleted ? "comment.deleted" : "comment.restored",
          {
            comment_version: expectedVersion + 1,
            issue_identifier: issue.identifier,
            kind: "standard",
          },
          now,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: () => deterministicRejection(
        () => diagnoseCommentCas(db, auth, row.id, expectedVersion, !deleted, now),
      ),
      expectedEventCount: 1,
      operationId,
      primarySubjectId: row.id,
      primarySubjectType: "comment",
      requireIdempotencySnapshot: persistSnapshot,
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnoseCommentCas(db, auth, row.id, expectedVersion, !deleted, now);
    }
    throw error;
  }
}

export async function deleteComment(
  db: D1Database,
  auth: AuthContext,
  commentIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const access = await requireCommentAccess(db, auth, commentIdValue, "writer");
  if (access.row.kind === "completion") throw forbidden();
  const operationId = crypto.randomUUID();
  const commit = await setCommentDeleted(db, auth, access, expectedVersion, now, true, operationId, false);
  const deletedRow: CommentRow = {
    ...access.row,
    deleted_at: now,
    deleted_by_principal_id: auth.principalId,
    last_operation_id: operationId,
    version: expectedVersion + 1,
  };
  return writeResult(db, auth, commentResource(deletedRow, access.issue), commit.lastEventSequence, false);
}

export async function restoreComment(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  commentIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const access = await requireCommentAccess(db, auth, commentIdValue, "writer", true);
  if (access.row.kind === "completion") throw forbidden();
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      await verifyCurrentAuth(db, auth, now);
      const latest = await requireCommentAccess(db, auth, access.row.id, "writer", true);
      if (latest.issue.projectId !== access.issue.projectId) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const activeAccess = await requireCommentAccess(db, auth, access.row.id, "writer");
      if (activeAccess.row.kind === "completion") throw forbidden();
      await setCommentDeleted(db, auth, activeAccess, expectedVersion, now, false, operationId, true);
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `comment:${access.row.id}:restore`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<CommentRow>(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          commentResource(snapshot, access.issue),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { expected_version: expectedVersion },
    routeTemplate: "/api/v1/comments/{comment_id}/commands/restore",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

async function diagnoseComplete(
  db: D1Database,
  auth: AuthContext,
  identifier: string,
  expectedVersion: number,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const issue = await requireCollaborationIssue(db, auth, identifier, "writer");
  if (issue.version !== expectedVersion) throw versionConflict(issue.version);
  if (issue.statusKey === "done") throw invalidTransition();
  await assertCommentCapacity(db, issue.projectId);
  throw platformUnavailable("d1");
}

export async function completeIssue(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  expectedVersion: number,
  value: { [key: string]: JsonValue },
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const issue = await requireCollaborationIssueAuthorization(db, auth, identifierValue, "writer");
  const payload: CompletionPayload = requireCompletionPayload(value);
  const commentId = crypto.randomUUID();
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
      const guard = buildProjectRoleGuard(auth, now, 6, "issue.project_id");
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `UPDATE project_usage
               SET active_comment_count = active_comment_count + 1,
                   updated_at = ?1, last_operation_id = ?2
               WHERE project_id = ?3
                 AND active_comment_count < (
                   SELECT project.comment_limit
                   FROM projects project
                   JOIN public_join_policies policy ON policy.project_id = project.id
                   WHERE project.id = project_usage.project_id
                     AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
                 )`,
            ).bind(now, operationId, activeIssue.projectId),
            db.prepare(
              `UPDATE issues AS issue
               SET status_key = 'done', version = version + 1,
                   updated_at = ?1, updated_by_principal_id = ?2,
                   last_operation_id = ?3
               WHERE issue.id = ?4 AND issue.version = ?5
                 AND issue.status_key != 'done' AND issue.deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM projects project
                   JOIN workspaces workspace ON workspace.id = project.workspace_id
                   LEFT JOIN public_join_policies policy ON policy.project_id = project.id
                   LEFT JOIN project_usage usage ON usage.project_id = project.id
                   WHERE project.id = issue.project_id
                     AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
                     AND ${guard.sql}
                     AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
                          OR usage.last_operation_id = ?3)
                 )`,
            ).bind(now, auth.principalId, operationId, activeIssue.id, expectedVersion, ...guard.values),
            db.prepare(
              `INSERT INTO comments
                (id, issue_id, kind, author_principal_id, body,
                 completion_json, reply_to_comment_id, version, created_at,
                 created_operation_id, last_operation_id)
               SELECT ?1, issue.id, 'completion', ?2, ?3, ?4, NULL, 1, ?5, ?6, ?6
               FROM issues issue
               WHERE issue.id = ?7 AND issue.last_operation_id = ?6
                 AND issue.status_key = 'done' AND issue.version = ?8`,
            ).bind(
              commentId,
              auth.principalId,
              payload.summary,
              JSON.stringify(payload),
              now,
              operationId,
              activeIssue.id,
              expectedVersion + 1,
            ),
            issueWriteSnapshotStatement(db, operationId, activeIssue.id, activeIssue.role),
            db.prepare(
              `INSERT INTO events
                (id, stream, type, operation_id, event_index, actor_principal_id,
                 actor_credential_id, authorized_via, grant_id, workspace_id,
                 project_id, subject_type, subject_id, payload_json, created_at)
               SELECT ?1, 'domain', 'issue.completed', ?2, 0, ?3, ?4, ?5,
                      CASE WHEN ?6 = 1 THEN NULL ELSE (
                        SELECT grant_row.id FROM project_grants grant_row
                        WHERE grant_row.project_id = issue.project_id
                          AND grant_row.principal_id = ?3
                          AND grant_row.role = 'writer' AND grant_row.revoked_at IS NULL
                        LIMIT 1
                      ) END,
                      project.workspace_id, issue.project_id,
                      'issue', issue.id, ?7, ?8
               FROM issues issue
               JOIN projects project ON project.id = issue.project_id
               JOIN comments completion
                 ON completion.issue_id = issue.id AND completion.created_operation_id = ?2
               WHERE issue.id = ?9 AND issue.last_operation_id = ?2
                 AND completion.id = ?10`,
            ).bind(
              crypto.randomUUID(),
              operationId,
              auth.principalId,
              actorCredentialId(auth),
              authorizedVia(auth),
              auth.isOwner ? 1 : 0,
              JSON.stringify({
                completion_comment_id: commentId,
                new_status_key: "done",
                old_status_key: activeIssue.statusKey,
              }),
              now,
              activeIssue.id,
              commentId,
            ),
          ],
          committedAt: now,
          confirmBusinessRejection: () => deterministicRejection(
            () => diagnoseComplete(db, auth, activeIssue.identifier, expectedVersion, now),
          ),
          expectedEventCount: 1,
          operationId,
          primarySubjectId: activeIssue.id,
          primarySubjectType: "issue",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          return diagnoseComplete(db, auth, activeIssue.identifier, expectedVersion, now);
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `issue:${issue.id}:complete`,
    now,
    readback: async (operationId, commit) => {
      const [resource, completion] = await Promise.all([
        readIssueWriteSnapshotResource(db, auth, operationId),
        db.prepare(
          `SELECT id FROM comments
           WHERE kind = 'completion' AND created_operation_id = ?1
           LIMIT 1`,
        ).bind(operationId).first<{ id: string }>(),
      ]);
      if (completion === null) throw new AtomicBatchRejectedError();
      return {
        body: await writeResult(
          db,
          auth,
          { ...resource, completion_comment_id: completion.id },
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { expected_version: expectedVersion, ...payload },
    replay: (stored) => currentIssueReplayProjection(db, auth, stored),
    routeTemplate: "/api/v1/issues/{identifier}/commands/complete",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}
