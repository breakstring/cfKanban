import { buildCurrentAuthGuard, reauthenticateOwner, requireOwnerControl } from "../kernel/authorization.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { actorCredentialId, requireIdempotencyKey, writeResult } from "./shared.ts";

export interface AttachmentStorageSettings {
  limit_bytes: number | null;
  limit_configured: number;
  reserved_bytes: number;
  version: number;
}
type Resource = { [key: string]: JsonValue };
export async function readAttachmentStorage(db: D1Database): Promise<AttachmentStorageSettings> {
  try {
    const row = await db.prepare("SELECT limit_bytes,limit_configured,reserved_bytes,version FROM attachment_storage WHERE singleton=1").first<AttachmentStorageSettings>();
    if (row === null) throw platformUnavailable("d1");
    return row;
  } catch (error) { throw platformUnavailable("d1", error); }
}
export async function getAttachmentSettings(env: WorkerEnv, auth: AuthContext): Promise<Resource> {
  requireOwnerControl(auth);
  const row = await readAttachmentStorage(env.DB);
  return { limit_bytes: row.limit_bytes, configured: row.limit_configured === 1, reserved_bytes: row.reserved_bytes, version: row.version };
}
export async function updateAttachmentSettings(env: WorkerEnv, request: Request, auth: AuthContext, limit: JsonValue, expectedVersion: number, now: number): Promise<Resource> {
  requireOwnerControl(auth);
  if (limit !== null && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)) throw validationError("invalid_attachment_storage_limit");
  const db = env.DB;
  const authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const check = async () => { await authorize(); const row = await readAttachmentStorage(db); if (row.version !== expectedVersion) throw versionConflict(row.version); };
  const result = await runIdempotentOperation({
    db, now, method: "PATCH", scopeKey: `principal:${auth.principalId}`, routeTemplate: "/api/v1/admin/attachment-settings",
    normalizedResourceScope: "instance-attachment-settings", requestBody: { expected_version: expectedVersion, limit_bytes: limit }, idempotencyKey: requireIdempotencyKey(request), authorize,
    execute: async (operationId) => {
      await check();
      const guard = buildCurrentAuthGuard(auth, Date.now(), 4, true);
      const instance = await db.prepare("SELECT instance_id FROM instance_meta WHERE singleton=1").first<{ instance_id: string }>();
      if (!instance) throw platformUnavailable("d1");
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectId: instance.instance_id, primarySubjectType: "instance", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE attachment_storage SET limit_bytes=?1,limit_configured=1,version=version+1,last_operation_id=?2
              WHERE singleton=1 AND version=?3 AND ${guard.sql}`).bind(limit, operationId, expectedVersion, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT json_object('limit_bytes',limit_bytes,'configured',json('true'),'reserved_bytes',reserved_bytes,'version',version)
              FROM attachment_storage WHERE singleton=1 AND last_operation_id=?1) WHERE operation_id=?1 AND state='pending'`).bind(operationId),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','instance.attachment-settings-updated',?2,0,?3,?4,'deployment_owner','instance',?5,
                json_object('limit_bytes',limit_bytes,'configured',json('true'),'version',version),?6
              FROM attachment_storage WHERE singleton=1 AND last_operation_id=?2`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), instance.instance_id, now),
          ],
          confirmBusinessRejection: async () => { await authorize(); return (await readAttachmentStorage(db)).version !== expectedVersion; },
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: async (operationId, commit) => ({ body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, operationId), commit.lastEventSequence, false), status: 200 }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
