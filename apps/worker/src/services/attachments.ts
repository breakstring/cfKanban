import { readAttachmentStorage } from "./attachment-settings.ts";
import { requireUuid, timestamp } from "../domain/model.ts";
import { verifyCurrentAuth } from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { isUuid, sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { ApiError, conflict, forbidden, notFound, payloadTooLarge, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { operationSnapshotStatement, readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { buildProjectRoleGuard, issueReference, requireCollaborationIssue, requireCollaborationIssueAuthorization, requireCollaborationIssueById, requireCollaborationIssueByIdAuthorization, roleCanWrite, type CollaborationIssue } from "./collaboration-shared.ts";
import { actorCredentialId, authorizedVia, requireDeletedMode, requireIdempotencyKey, requireLimit, writeResult } from "./shared.ts";

export const ATTACHMENT_LIMITS = { max_file_bytes: 10 * 1024 * 1024, max_active_per_issue: 20 };
const RESERVATION_TTL = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 64;

type Resource = { [key: string]: JsonValue };
interface AttachmentRow {
  id: string;
  issue_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  state: "pending" | "ready" | "garbage";
  object_key: string;
  preview_content_type: string | null;
  expires_at: number;
  version: number;
  created_at: number;
  deleted_at: number | null;
  deleted_by_principal_id: string | null;
  uploaded_by_principal_id: string;
  uploaded_by_display_name: string;
}
const selectAttachment = `SELECT a.*, o.size_bytes, o.sha256, o.state, o.object_key,
  o.preview_content_type, o.expires_at, principal.display_name AS uploaded_by_display_name
  FROM issue_attachments a JOIN attachment_objects o ON o.id = a.id
  JOIN principals principal ON principal.id = a.uploaded_by_principal_id`;

function storage(env: WorkerEnv): R2Bucket {
  if (env.ATTACHMENTS === undefined) throw new ApiError({ category: "platform_failure", code: "ATTACHMENTS_DISABLED", details: { component: "r2" }, message: "Attachment storage is not enabled.", recovery: "request_owner", retryable: false, status: 503 });
  return env.ATTACHMENTS;
}
function quota(kind: "count" | "bytes", limit: number | null = null): ApiError {
  return new ApiError({ category: "business_quota", code: kind === "count" ? "ISSUE_ATTACHMENT_LIMIT_REACHED" : "ATTACHMENT_STORAGE_LIMIT_REACHED", details: { limit: kind === "count" ? ATTACHMENT_LIMITS.max_active_per_issue : limit }, message: "The attachment capacity is exhausted.", recovery: "free_capacity_or_request_owner", retryable: false, status: 409 });
}
async function first<T>(statement: D1PreparedStatement): Promise<T | null> {
  try { return await statement.first<T>(); } catch (error) { throw platformUnavailable("d1", error); }
}
async function readAttachment(db: D1Database, id: string): Promise<AttachmentRow> {
  const row = await first<AttachmentRow>(db.prepare(`${selectAttachment} WHERE a.id = ?1`).bind(id));
  if (row === null) throw notFound();
  return row;
}
async function access(db: D1Database, auth: AuthContext, idValue: JsonValue, role: "reader" | "writer" = "reader", recovery = false) {
  const row = await readAttachment(db, requireUuid(idValue, "attachment_id"));
  const issue = recovery
    ? await requireCollaborationIssueByIdAuthorization(db, auth, row.issue_id, role, true)
    : await requireCollaborationIssueById(db, auth, row.issue_id, role);
  return { row, issue };
}
function resource(row: AttachmentRow, issue: CollaborationIssue, auth: AuthContext, enabled: boolean, now: number): Resource {
  const activeParent = issue.deletedAt === null && issue.projectDeletedAt === null && issue.workspaceDeletedAt === null;
  const writable = enabled && activeParent && roleCanWrite(issue.role);
  const state = row.state === "garbage" || (row.state === "pending" && row.expires_at <= now) ? "expired" : row.state;
  const actions = ["read"];
  if (enabled && activeParent && row.deleted_at === null && state === "ready") actions.push("download");
  if (writable && row.deleted_at === null && state !== "expired") actions.push("delete");
  if (writable && row.deleted_at === null && state === "pending" && (auth.isOwner || row.uploaded_by_principal_id === auth.principalId)) actions.push("upload");
  if (writable && row.deleted_at !== null && state === "ready") actions.push("restore");
  return {
    id: row.id, issue: issueReference(issue), filename: row.filename, content_type: row.content_type,
    size_bytes: row.size_bytes, sha256: row.sha256, state, version: row.version,
    created_at: timestamp(row.created_at), expires_at: timestamp(row.expires_at), deleted_at: timestamp(row.deleted_at),
    uploaded_by: { principal_id: row.uploaded_by_principal_id, display_name: row.uploaded_by_display_name },
    preview_content_type: row.preview_content_type, allowed_actions: actions,
  };
}
async function ensureCapacity(db: D1Database, issueId: string, size = 0): Promise<void> {
  const counts = await first<{ count: number; reserved_bytes: number; limit_bytes: number | null; limit_configured: number }>(db.prepare(`SELECT
    (SELECT COUNT(*) FROM issue_attachments a JOIN attachment_objects o ON o.id=a.id
     WHERE a.issue_id=?1 AND a.deleted_at IS NULL AND o.state IN ('pending','ready')) AS count,
    reserved_bytes,limit_bytes,limit_configured FROM attachment_storage WHERE singleton=1`).bind(issueId));
  if (counts === null) throw platformUnavailable("d1");
  if (counts.count >= ATTACHMENT_LIMITS.max_active_per_issue) throw quota("count");
  if (size > 0 && counts.limit_configured !== 1) throw new ApiError({ category: "business_quota", code: "ATTACHMENT_STORAGE_NOT_CONFIGURED", details: {}, message: "The Owner must choose an attachment storage limit before uploading.", recovery: "request_owner", retryable: false, status: 409 });
  if (size > 0 && counts.limit_bytes !== null && counts.reserved_bytes + size > counts.limit_bytes) throw quota("bytes", counts.limit_bytes);
}
function eventStatement(db: D1Database, auth: AuthContext, issue: CollaborationIssue, id: string, operationId: string, type: string, now: number) {
  return db.prepare(`INSERT INTO events
    (id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,grant_id,workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
    SELECT ?1,'domain',?2,?3,0,?4,?5,?6,
      CASE WHEN ?7=1 THEN NULL ELSE (SELECT id FROM effective_project_grants WHERE project_id=?8 AND principal_id=?4 AND role='writer' AND revoked_at IS NULL) END,
      ?9,?8,'attachment',a.id,json_object('attachment_id',a.id,'attachment_version',a.version),?10
    FROM issue_attachments a WHERE a.id=?11 AND a.last_operation_id=?3`)
    .bind(crypto.randomUUID(), type, operationId, auth.principalId, actorCredentialId(auth), authorizedVia(auth), auth.isOwner ? 1 : 0, issue.projectId, issue.workspaceId, now, id);
}
function activeIssueGuard(): string {
  return `EXISTS (SELECT 1 FROM issues issue JOIN projects project ON project.id=issue.project_id
    JOIN workspaces workspace ON workspace.id=project.workspace_id
    WHERE issue.id=a.issue_id AND issue.deleted_at IS NULL AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL)`;
}
async function writeReadback(db: D1Database, auth: AuthContext, operationId: string, lastEventSequence: number) {
  return { body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, operationId), lastEventSequence, false), status: 200 };
}
async function deterministic(check: () => Promise<unknown>): Promise<boolean> {
  try { await check(); return false; } catch (error) { if (error instanceof ApiError && error.category !== "platform_failure" && error.category !== "platform_quota") return true; throw error; }
}
function metadata(body: Resource) {
  const filename = body.filename;
  const contentType = body.content_type;
  const size = body.size_bytes;
  const sha256 = body.sha256;
  if (typeof filename !== "string" || filename.trim().length === 0 || Array.from(filename).length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(filename) || filename === "." || filename === "..") throw validationError("invalid_attachment_filename");
  if (typeof contentType !== "string" || contentType.length > 127 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(contentType)) throw validationError("invalid_attachment_content_type");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > ATTACHMENT_LIMITS.max_file_bytes) throw validationError("invalid_attachment_size");
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw validationError("invalid_attachment_sha256");
  return { filename, contentType: contentType.toLowerCase(), size, sha256 };
}

export async function reserveAttachment(env: WorkerEnv, request: Request, auth: AuthContext, identifier: JsonValue, body: Resource, now: number): Promise<Resource> {
  storage(env);
  const db = env.DB;
  const value = metadata(body);
  const issue = await requireCollaborationIssueAuthorization(db, auth, identifier, "writer");
  const check = async () => { await verifyCurrentAuth(db, auth, now); await requireCollaborationIssue(db, auth, issue.identifier, "writer"); await ensureCapacity(db, issue.id, value.size); };
  const result = await runIdempotentOperation({
    db, now, method: "POST", scopeKey: `principal:${auth.principalId}`, routeTemplate: "/api/v1/issues/{identifier}/attachments",
    normalizedResourceScope: `issue:${issue.id}:attachments`, requestBody: { filename: value.filename, content_type: value.contentType, size_bytes: value.size, sha256: value.sha256 }, idempotencyKey: requireIdempotencyKey(request),
    authorize: async () => { await verifyCurrentAuth(db, auth, Date.now()); await requireCollaborationIssueAuthorization(db, auth, issue.identifier, "writer"); },
    execute: async (operationId) => {
      await check();
      const id = operationId;
      const guard = buildProjectRoleGuard(auth, Date.now(), 8, "issue.project_id");
      const row: AttachmentRow = { id, issue_id: issue.id, filename: value.filename, content_type: value.contentType, size_bytes: value.size, sha256: value.sha256, state: "pending", object_key: `attachments/${id}`, preview_content_type: null, expires_at: now + RESERVATION_TTL, version: 1, created_at: now, deleted_at: null, deleted_by_principal_id: null, uploaded_by_principal_id: auth.principalId, uploaded_by_display_name: auth.displayName };
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectId: id, primarySubjectType: "attachment", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`INSERT INTO attachment_objects (id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id,last_operation_id)
              SELECT ?1,?2,?3,?4,'pending',?5,?6,?1,?1 FROM issues issue
              JOIN projects project ON project.id=issue.project_id JOIN workspaces workspace ON workspace.id=project.workspace_id
              WHERE issue.id=?7 AND issue.deleted_at IS NULL AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL AND ${guard.sql}
                AND EXISTS (SELECT 1 FROM attachment_storage WHERE singleton=1 AND limit_configured=1 AND (limit_bytes IS NULL OR reserved_bytes<=limit_bytes-?3))
                AND (SELECT COUNT(*) FROM issue_attachments a JOIN attachment_objects o ON o.id=a.id WHERE a.issue_id=issue.id AND a.deleted_at IS NULL AND o.state IN ('pending','ready')) < ${ATTACHMENT_LIMITS.max_active_per_issue}`)
              .bind(id, row.object_key, value.size, value.sha256, row.expires_at, now, issue.id, ...guard.values),
            db.prepare(`INSERT INTO issue_attachments (id,issue_id,filename,content_type,uploaded_by_principal_id,created_at,created_operation_id,last_operation_id)
              SELECT id,?2,?3,?4,?5,?6,?1,?1 FROM attachment_objects WHERE id=?1 AND created_operation_id=?1`)
              .bind(id, issue.id, value.filename, value.contentType, auth.principalId, now),
            db.prepare(`UPDATE attachment_storage SET reserved_bytes=reserved_bytes+?2 WHERE singleton=1 AND EXISTS (SELECT 1 FROM issue_attachments WHERE id=?1 AND created_operation_id=?1)`).bind(id, value.size),
            eventStatement(db, auth, issue, id, operationId, "attachment.reserved", now),
            operationSnapshotStatement(db, operationId, resource(row, issue, auth, true, now)),
          ], confirmBusinessRejection: () => deterministic(check),
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: (operationId, commit) => writeReadback(db, auth, operationId, commit.lastEventSequence),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function listAttachments(env: WorkerEnv, auth: AuthContext, identifier: JsonValue, url: URL, now: number): Promise<Resource> {
  const deleted = requireDeletedMode(url);
  const issue = deleted === "only"
    ? await requireCollaborationIssueAuthorization(env.DB, auth, identifier, "writer", true)
    : await requireCollaborationIssue(env.DB, auth, identifier);
  const context = await createCursorContext("attachments", { issue_id: issue.id, deleted }, [issue.projectId], auth.principalId);
  const cursor = decodeCursor(url.searchParams.get("cursor"), context);
  if (cursor !== null && (cursor.length !== 2 || typeof cursor[0] !== "number" || !Number.isSafeInteger(cursor[0]) || cursor[0] < 0 || typeof cursor[1] !== "string" || !isUuid(cursor[1]))) throw invalidCursor();
  const limit = requireLimit(url);
  let rows: AttachmentRow[];
  try {
    rows = (await env.DB.prepare(`${selectAttachment} WHERE a.issue_id=?1 AND a.deleted_at IS ${deleted === "only" ? "NOT " : ""}NULL
      AND (?2 IS NULL OR a.created_at>?2 OR (a.created_at=?2 AND a.id>?3)) ORDER BY a.created_at,a.id LIMIT ?4`)
      .bind(issue.id, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1).all<AttachmentRow>()).results;
  } catch (error) { throw platformUnavailable("d1", error); }
  const settings = await readAttachmentStorage(env.DB);
  const page = rows.slice(0, limit), tail = page.at(-1), more = rows.length > limit;
  await verifyCurrentAuth(env.DB, auth, Date.now());
  return { items: page.map((row) => resource(row, issue, auth, env.ATTACHMENTS !== undefined, now)), has_more: more, next_cursor: more && tail ? encodeCursor(context, [tail.created_at, tail.id]) : null,
    resolved_scope: { issue: issueReference(issue) }, capabilities: { attachments: env.ATTACHMENTS !== undefined }, limits: { ...ATTACHMENT_LIMITS, max_storage_bytes: settings.limit_bytes, storage_limit_configured: settings.limit_configured === 1 } };
}
export async function getAttachment(env: WorkerEnv, auth: AuthContext, id: JsonValue, now: number): Promise<Resource> {
  const { row, issue } = await access(env.DB, auth, id);
  if (row.deleted_at !== null && !roleCanWrite(issue.role)) throw notFound();
  await verifyCurrentAuth(env.DB, auth, Date.now());
  return resource(row, issue, auth, env.ATTACHMENTS !== undefined, now);
}

export async function readAttachmentBytes(request: Request, expectedSize: number): Promise<Uint8Array<ArrayBuffer>> {
  if (request.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() !== "application/octet-stream") throw validationError("attachment_content_must_be_binary");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expectedSize)) throw validationError("attachment_size_mismatch");
  if (request.body === null) throw validationError("attachment_body_required");
  const bytes = new Uint8Array(expectedSize);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > expectedSize || offset + chunk.value.byteLength > ATTACHMENT_LIMITS.max_file_bytes) {
        // 发送 413 后由运行时处置未读请求；显式 cancel 可能在错误响应送达前
        // 中止整个 HTTP 交换。
        throw payloadTooLarge(expectedSize, "attachment");
      }
      bytes.set(chunk.value, offset); offset += chunk.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (offset !== expectedSize) throw validationError("attachment_size_mismatch");
  return bytes;
}
export function imageContentType(bytes: Uint8Array): string | null {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (bytes.length >= 24 && starts([137,80,78,71,13,10,26,10]) && new TextDecoder().decode(bytes.slice(12,16)) === "IHDR") return "image/png";
  if (bytes.length >= 4 && starts([255,216,255])) return "image/jpeg";
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0,6)))) return "image/gif";
  if (bytes.length >= 16 && new TextDecoder().decode(bytes.slice(0,4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8,12)) === "WEBP" && ["VP8 ","VP8L","VP8X"].includes(new TextDecoder().decode(bytes.slice(12,16)))) return "image/webp";
  return null;
}
async function assertUploadable(db: D1Database, auth: AuthContext, id: string, now: number) {
  await verifyCurrentAuth(db, auth, now);
  const current = await access(db, auth, id, "writer");
  if (!auth.isOwner && current.row.uploaded_by_principal_id !== auth.principalId) throw forbidden();
  if (current.row.deleted_at !== null || current.row.state !== "pending" || current.row.expires_at <= now) throw conflict("ATTACHMENT_NOT_PENDING", "refresh_resource");
  return current;
}
export async function uploadAttachment(env: WorkerEnv, request: Request, auth: AuthContext, idValue: JsonValue): Promise<Resource> {
  const bucket = storage(env), db = env.DB;
  const { row, issue } = await access(db, auth, idValue, "writer");
  if (!auth.isOwner && row.uploaded_by_principal_id !== auth.principalId) throw forbidden();
  const key = requireIdempotencyKey(request);
  const bytes = await readAttachmentBytes(request, row.size_bytes);
  const digest = await sha256Hex(bytes);
  if (digest !== row.sha256) throw validationError("attachment_sha256_mismatch");
  const previewType = imageContentType(bytes);
  const result = await runIdempotentOperation({
    db, method: "PUT", scopeKey: `principal:${auth.principalId}`, routeTemplate: "/api/v1/attachments/{id}/content", normalizedResourceScope: `attachment:${row.id}:content`,
    requestBody: { size_bytes: row.size_bytes, sha256: digest }, idempotencyKey: key,
    authorize: async () => { await verifyCurrentAuth(db, auth, Date.now()); const current = await access(db, auth, row.id, "writer"); if (!auth.isOwner && current.row.uploaded_by_principal_id !== auth.principalId) throw forbidden(); },
    execute: async (operationId) => {
      await assertUploadable(db, auth, row.id, Date.now());
      try {
        const object = await bucket.put(row.object_key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: digest, httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" }, customMetadata: { sha256: digest, attachment_id: row.id } });
        if (object === null) {
          const existing = await bucket.head(row.object_key);
          if (existing === null || existing.size !== row.size_bytes || existing.customMetadata?.sha256 !== digest) throw conflict("ATTACHMENT_OBJECT_CONFLICT", "request_owner");
        }
      } catch (error) { throw platformUnavailable("r2", error); }
      const now = Date.now();
      const guard = buildProjectRoleGuard(auth, now, 5, "(SELECT project_id FROM issues WHERE id=a.issue_id)");
      const updated = { ...row, state: "ready" as const, version: row.version + 1, preview_content_type: previewType };
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectId: row.id, primarySubjectType: "attachment", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE issue_attachments AS a SET version=version+1,last_operation_id=?2 WHERE a.id=?1 AND a.version=?3 AND a.deleted_at IS NULL
              AND ${activeIssueGuard()} AND ${guard.sql}
              AND EXISTS (SELECT 1 FROM attachment_objects o WHERE o.id=a.id AND o.state='pending' AND o.expires_at>?4)`)
              .bind(row.id, operationId, row.version, now, ...guard.values),
            db.prepare(`UPDATE attachment_objects SET state='ready',preview_content_type=?3,last_operation_id=?2
              WHERE id=?1 AND state='pending' AND EXISTS (SELECT 1 FROM issue_attachments WHERE id=?1 AND last_operation_id=?2)`).bind(row.id, operationId, previewType),
            eventStatement(db, auth, issue, row.id, operationId, "attachment.uploaded", now),
            operationSnapshotStatement(db, operationId, resource(updated, issue, auth, true, now)),
          ], confirmBusinessRejection: () => deterministic(async () => { await assertUploadable(db, auth, row.id, Date.now()); }),
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await assertUploadable(db, auth, row.id, Date.now()); throw error; }
    },
    readback: (operationId, commit) => writeReadback(db, auth, operationId, commit.lastEventSequence),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function downloadAttachment(env: WorkerEnv, auth: AuthContext, id: JsonValue, preview: boolean): Promise<Response> {
  const bucket = storage(env);
  const { row } = await access(env.DB, auth, id);
  if (row.state !== "ready" || row.deleted_at !== null) throw notFound();
  if (preview && row.preview_content_type === null) throw validationError("attachment_preview_not_available");
  let object: R2ObjectBody | null;
  try { object = await bucket.get(row.object_key); } catch (error) { throw platformUnavailable("r2", error); }
  if (object === null || object.size !== row.size_bytes || object.customMetadata?.sha256 !== row.sha256) throw platformUnavailable("r2");
  await verifyCurrentAuth(env.DB, auth, Date.now());
  const latest = await access(env.DB, auth, row.id);
  if (latest.row.state !== "ready" || latest.row.deleted_at !== null) throw notFound();
  const filename = encodeURIComponent(row.filename).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(object.body, { headers: {
    "content-type": preview ? row.preview_content_type as string : "application/octet-stream",
    "content-length": String(row.size_bytes), "content-disposition": `${preview ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${filename}`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "referrer-policy": "no-referrer",
  } });
}

export async function setAttachmentDeleted(env: WorkerEnv, request: Request, auth: AuthContext, idValue: JsonValue, expectedVersion: number, restore: boolean): Promise<Resource> {
  storage(env);
  const db = env.DB, { row, issue } = await access(db, auth, idValue, "writer");
  const check = async () => {
    await verifyCurrentAuth(db, auth, Date.now());
    const latest = await access(db, auth, row.id, "writer");
    if (latest.row.version !== expectedVersion) throw versionConflict(latest.row.version);
    if ((latest.row.deleted_at !== null) !== restore) throw conflict(restore ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED", "refresh_resource");
    if (latest.row.state === "garbage" || (restore && latest.row.state !== "ready")) throw conflict("ATTACHMENT_NOT_RESTORABLE", "none");
    if (restore) await ensureCapacity(db, row.issue_id);
    return latest.row;
  };
  const result = await runIdempotentOperation({
    db, method: restore ? "POST" : "DELETE", scopeKey: `principal:${auth.principalId}`,
    routeTemplate: restore ? "/api/v1/attachments/{id}/commands/restore" : "/api/v1/attachments/{id}", normalizedResourceScope: `attachment:${row.id}:${restore ? "restore" : "delete"}`,
    requestBody: { expected_version: expectedVersion }, idempotencyKey: requireIdempotencyKey(request),
    authorize: async () => { await verifyCurrentAuth(db, auth, Date.now()); await access(db, auth, row.id, "writer"); },
    execute: async (operationId) => {
      const current = await check(), now = Date.now();
      const guard = buildProjectRoleGuard(auth, now, 6, "(SELECT project_id FROM issues WHERE id=a.issue_id)");
      const updated = { ...current, version: expectedVersion + 1, deleted_at: restore ? null : now, deleted_by_principal_id: restore ? null : auth.principalId, state: !restore && current.state === "pending" ? "garbage" as const : current.state };
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectId: row.id, primarySubjectType: "attachment", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE issue_attachments AS a SET deleted_at=?3,deleted_by_principal_id=?4,version=version+1,last_operation_id=?2
              WHERE a.id=?1 AND a.version=?5 AND a.deleted_at IS ${restore ? "NOT " : ""}NULL AND ${activeIssueGuard()} AND ${guard.sql}
                AND EXISTS (SELECT 1 FROM attachment_objects o WHERE o.id=a.id AND o.state ${restore ? "= 'ready'" : "IN ('pending','ready')"})
                ${restore ? `AND (SELECT COUNT(*) FROM issue_attachments active JOIN attachment_objects o ON o.id=active.id WHERE active.issue_id=a.issue_id AND active.deleted_at IS NULL AND o.state IN ('pending','ready')) < ${ATTACHMENT_LIMITS.max_active_per_issue}` : ""}`)
              .bind(row.id, operationId, updated.deleted_at, updated.deleted_by_principal_id, expectedVersion, ...guard.values),
            ...(!restore ? [db.prepare(`UPDATE attachment_objects SET state='garbage',garbage_at=?3,last_operation_id=?2
              WHERE id=?1 AND state='pending' AND EXISTS (SELECT 1 FROM issue_attachments WHERE id=?1 AND last_operation_id=?2)`).bind(row.id, operationId, now)] : []),
            eventStatement(db, auth, issue, row.id, operationId, restore ? "attachment.restored" : "attachment.deleted", now),
            operationSnapshotStatement(db, operationId, resource(updated, issue, auth, true, now)),
          ], confirmBusinessRejection: () => deterministic(check),
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: (operationId, commit) => writeReadback(db, auth, operationId, commit.lastEventSequence),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function collectAttachmentGarbage(env: WorkerEnv, now = Date.now()): Promise<{ checked: number; deleted: number }> {
  if (env.ATTACHMENTS === undefined) return { checked: 0, deleted: 0 };
  const db = env.DB, bucket = env.ATTACHMENTS;
  // 在途 PUT 可能晚于 DELETE 完成，因此永久保留对象墓碑；即使预算已释放，
  // 后续轮询仍能再次删除同一个 key，避免留下无法追踪的对象。
  await db.prepare(`UPDATE attachment_objects SET state='garbage',garbage_at=?1
    WHERE id IN (SELECT id FROM attachment_objects WHERE state='pending' AND expires_at<=?1 ORDER BY expires_at,id LIMIT ?2)`).bind(now, CLEANUP_BATCH).run();
  // garbage 状态的 CHECK 保证 garbage_at 非空；新垃圾按进入时间排队，
  // 避免持续的新记录饿死已检查墓碑，使晚到 PUT 永久留在预算之外。
  const candidates = (await db.prepare(`SELECT id,object_key FROM attachment_objects WHERE state='garbage'
    ORDER BY COALESCE(last_checked_at,garbage_at),id LIMIT ?1`).bind(CLEANUP_BATCH).all<{ id: string; object_key: string }>()).results;
  let deleted = 0;
  for (const object of candidates) {
    await db.prepare("UPDATE attachment_objects SET last_checked_at=?2 WHERE id=?1 AND state='garbage'").bind(object.id, now).run();
    try {
      await bucket.delete(object.object_key);
      if (await bucket.head(object.object_key) !== null) continue;
      await db.batch([
        db.prepare(`UPDATE attachment_storage SET reserved_bytes=reserved_bytes-(SELECT size_bytes FROM attachment_objects WHERE id=?1)
          WHERE singleton=1 AND EXISTS (SELECT 1 FROM attachment_objects WHERE id=?1 AND state='garbage' AND budget_released_at IS NULL)`).bind(object.id),
        db.prepare("UPDATE attachment_objects SET budget_released_at=?2 WHERE id=?1 AND state='garbage' AND budget_released_at IS NULL").bind(object.id, now),
      ]);
      deleted += 1;
    } catch { /* 持久墓碑保留失败项，下一轮有界扫描继续处理。 */ }
  }
  return { checked: candidates.length, deleted };
}
