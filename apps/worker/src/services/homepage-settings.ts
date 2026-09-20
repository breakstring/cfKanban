import { buildCurrentAuthGuard, reauthenticateOwner, requireOwnerControl } from "../kernel/authorization.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { actorCredentialId, requireIdempotencyKey, writeResult } from "./shared.ts";

export interface HomepageSettings {
  notice_en: string | null;
  notice_zh_cn: string | null;
  version: number;
}
export function normalizeHomepageNotice(value: JsonValue): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw validationError("invalid_homepage_notice");
  const normalized = value.trim();
  if ([...normalized].length > 500) throw validationError("homepage_notice_too_long");
  return normalized || null;
}

type Resource = { [key: string]: JsonValue };
export async function readHomepageSettings(db: D1Database): Promise<HomepageSettings> {
  try {
    const row = await db.prepare("SELECT notice_en,notice_zh_cn,version FROM homepage_settings WHERE singleton=1").first<HomepageSettings>();
    if (row === null) throw platformUnavailable("d1");
    return row;
  } catch (error) { throw platformUnavailable("d1", error); }
}
export async function getHomepageSettings(env: WorkerEnv, auth: AuthContext): Promise<Resource> {
  requireOwnerControl(auth);
  const row = await readHomepageSettings(env.DB);
  return { notice_en: row.notice_en, notice_zh_cn: row.notice_zh_cn, version: row.version };
}
export async function updateHomepageSettings(env: WorkerEnv, request: Request, auth: AuthContext, noticeEnInput: JsonValue, noticeZhCnInput: JsonValue, expectedVersion: number, now: number): Promise<Resource> {
  requireOwnerControl(auth);
  const noticeEn = normalizeHomepageNotice(noticeEnInput);
  const noticeZhCn = normalizeHomepageNotice(noticeZhCnInput);
  const db = env.DB;
  const authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const check = async () => { await authorize(); const row = await readHomepageSettings(db); if (row.version !== expectedVersion) throw versionConflict(row.version); };
  const result = await runIdempotentOperation({
    db, now, method: "PATCH", scopeKey: `principal:${auth.principalId}`, routeTemplate: "/api/v1/admin/homepage-settings",
    normalizedResourceScope: "instance-homepage-settings", requestBody: { expected_version: expectedVersion, notice_en: noticeEn, notice_zh_cn: noticeZhCn }, idempotencyKey: requireIdempotencyKey(request), authorize,
    execute: async (operationId) => {
      await check();
      const guard = buildCurrentAuthGuard(auth, Date.now(), 5, true);
      const instance = await db.prepare("SELECT instance_id FROM instance_meta WHERE singleton=1").first<{ instance_id: string }>();
      if (!instance) throw platformUnavailable("d1");
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectId: instance.instance_id, primarySubjectType: "instance", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE homepage_settings SET notice_en=?1,notice_zh_cn=?2,version=version+1,last_operation_id=?3
              WHERE singleton=1 AND version=?4 AND ${guard.sql}`).bind(noticeEn, noticeZhCn, operationId, expectedVersion, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT json_object('notice_en',notice_en,'notice_zh_cn',notice_zh_cn,'version',version)
              FROM homepage_settings WHERE singleton=1 AND last_operation_id=?1) WHERE operation_id=?1 AND state='pending'`).bind(operationId),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','instance.homepage-settings-updated',?2,0,?3,?4,'deployment_owner','instance',?5,
                json_object('notice_en',notice_en,'notice_zh_cn',notice_zh_cn,'version',version),?6
              FROM homepage_settings WHERE singleton=1 AND last_operation_id=?2`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), instance.instance_id, now),
          ],
          confirmBusinessRejection: async () => { await authorize(); return (await readHomepageSettings(db)).version !== expectedVersion; },
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: async (operationId, commit) => ({ body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, operationId), commit.lastEventSequence, false), status: 200 }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
