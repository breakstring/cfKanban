import { compareReleaseVersions, isUpgradeAnnouncementRelease, parseReleaseVersion } from "../../../../packages/skill-runtime/src/release-versions.mjs";
import { buildCurrentAuthGuard, reauthenticateOwner, requireOwnerControl, verifyCurrentAuth } from "../kernel/authorization.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { ApiError, forbidden, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { RELEASE_VERSION } from "../release-version.ts";
import { actorCredentialId, requireIdempotencyKey, writeResult } from "./shared.ts";

type Resource = { [key: string]: JsonValue };
interface SettingsRow { enabled: number; version: number }
const settingsResource = (row: SettingsRow): Resource => ({ enabled: row.enabled === 1, version: row.version });

async function readSettings(db: D1Database): Promise<SettingsRow> {
  try {
    const row = await db.prepare("SELECT enabled,version FROM upgrade_notification_settings WHERE singleton=1").first<SettingsRow>();
    if (!row) throw platformUnavailable("d1");
    return row;
  } catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
}

async function ownerGuardRejected(db: D1Database, auth: AuthContext): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, Date.now(), 1, true);
  try { return await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first() === null; }
  catch (error) { throw platformUnavailable("d1", error); }
}

export async function getUpgradeNotificationSettings(db: D1Database, auth: AuthContext): Promise<Resource> {
  requireOwnerControl(auth);
  const row = await readSettings(db);
  await verifyCurrentAuth(db, auth, Date.now());
  if (await ownerGuardRejected(db, auth)) throw forbidden();
  return settingsResource(row);
}

export async function getUpgradeNotificationRelease(db: D1Database, auth: AuthContext, version: string): Promise<Resource> {
  requireOwnerControl(auth);
  if (!parseReleaseVersion(version)) throw validationError("invalid_release_version");
  let row: Resource | null;
  try {
    row = await db.prepare("SELECT release_version,previous_release_version,deployment_id,worker_version_id,notification_id FROM upgrade_notification_releases WHERE release_version=?1").bind(version).first<Resource>();
  } catch (error) { throw platformUnavailable("d1", error); }
  await verifyCurrentAuth(db, auth, Date.now());
  if (await ownerGuardRejected(db, auth)) throw forbidden();
  if (!row) throw notFound();
  return row;
}

export async function updateUpgradeNotificationSettings(db: D1Database, request: Request, auth: AuthContext, enabled: JsonValue, expectedVersion: number, now: number): Promise<Resource> {
  requireOwnerControl(auth);
  if (typeof enabled !== "boolean") throw validationError("invalid_upgrade_notification_setting");
  const authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const check = async () => { await authorize(); const row = await readSettings(db); if (row.version !== expectedVersion) throw versionConflict(row.version); };
  const result = await runIdempotentOperation({ db, now, authorize, method: "PATCH", routeTemplate: "/api/v1/admin/upgrade-notification-settings",
    scopeKey: `principal:${auth.principalId}`, normalizedResourceScope: "instance-upgrade-notification-settings",
    idempotencyKey: requireIdempotencyKey(request), requestBody: { enabled, expected_version: expectedVersion },
    execute: async operationId => {
      await check();
      const guard = buildCurrentAuthGuard(auth, Date.now(), 4, true);
      const instance = await db.prepare("SELECT instance_id FROM instance_meta WHERE singleton=1").first<{ instance_id: string }>();
      if (!instance) throw platformUnavailable("d1");
      try {
        await executeAtomicBatch(db, { operationId, committedAt: now, primarySubjectType: "instance", primarySubjectId: instance.instance_id, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE upgrade_notification_settings SET enabled=?1,version=version+1,last_operation_id=?2
              WHERE singleton=1 AND version=?3 AND ${guard.sql}`).bind(enabled ? 1 : 0, operationId, expectedVersion, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT json_object('enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END),'version',version)
              FROM upgrade_notification_settings WHERE singleton=1 AND last_operation_id=?1) WHERE operation_id=?1 AND state='pending'`).bind(operationId),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','instance.upgrade-notification-settings-updated',?2,0,?3,?4,'deployment_owner','instance',?5,
                json_object('enabled',enabled,'version',version),?6 FROM upgrade_notification_settings WHERE singleton=1 AND last_operation_id=?2`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), instance.instance_id, now),
          ], confirmBusinessRejection: async () => await ownerGuardRejected(db, auth) || (await readSettings(db)).version !== expectedVersion,
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: async (operationId, commit) => ({ status: 200, body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, operationId), commit.lastEventSequence, false) }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function publishUpgradeNotification(db: D1Database, request: Request, auth: AuthContext, input: Resource, now: number): Promise<Resource> {
  requireOwnerControl(auth);
  const previous = input.previous_release_version, current = input.release_version;
  if (typeof previous !== "string" || typeof current !== "string" || !parseReleaseVersion(previous) || !parseReleaseVersion(current)) throw validationError("invalid_release_version");
  const deploymentId = input.deployment_id, workerVersionId = input.worker_version_id;
  if (typeof deploymentId !== "string" || typeof workerVersionId !== "string") throw validationError("invalid_deployment_identity");
  const forward = compareReleaseVersions(current, previous) === 1;
  const supportedChannel = isUpgradeAnnouncementRelease(current);
  const authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const result = await runIdempotentOperation({ db, now, authorize, method: "POST", routeTemplate: "/api/v1/admin/notifications/commands/publish-upgrade",
    scopeKey: `principal:${auth.principalId}`, normalizedResourceScope: `instance-upgrade-notification:${current}`,
    idempotencyKey: requireIdempotencyKey(request), requestBody: { previous_release_version: previous, release_version: current, deployment_id: deploymentId, worker_version_id: workerVersionId },
    execute: async operationId => {
      await authorize();
      if (current !== RELEASE_VERSION) throw validationError("deployed_release_version_mismatch", { release_version: RELEASE_VERSION });
      const id = crypto.randomUUID(), guard = buildCurrentAuthGuard(auth, Date.now(), 9, true);
      const snapshotGuard = buildCurrentAuthGuard(auth, Date.now(), 8, true);
      const instance = await db.prepare("SELECT instance_id FROM instance_meta WHERE singleton=1").first<{ instance_id: string }>();
      if (!instance) throw platformUnavailable("d1");
      const title = `cfKanban ${current} · 版本更新 / Version update`;
      const body = `站点已从 ${previous} 升级到 ${current}。\nThe site has been upgraded from ${previous} to ${current}.\n\n版本说明 / Release notes: https://github.com/breakstring/cfKanban/releases/tag/${current}\n\n可能需要检查并更新本地 cfKanban Skills；本通知不表示本地技能已更新。\nYou may need to check and update your local cfKanban Skills. This notice does not mean they have been updated.\n\n先运行 cfkanban --version 检查本地版本，再让 Agent 按更新指引检查兼容发行。\nRun cfkanban --version to check your local version, then ask your Agent to check compatible releases using the update guide.\n\n更新指引 / Update guide: /docs/zh-CN/deployment/updates · /docs/en/deployment/updates`;
      try {
        await executeAtomicBatch(db, { operationId, committedAt: now, primarySubjectType: "instance", primarySubjectId: instance.instance_id, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id)
              SELECT ?1,?2,?3,?4,?5,?6,?6 FROM upgrade_notification_settings settings WHERE settings.singleton=1 AND settings.enabled=1
                AND ?7=1 AND NOT EXISTS(SELECT 1 FROM upgrade_notification_releases WHERE release_version=?8) AND ${guard.sql}`)
              .bind(id, title, body, now, auth.principalId, operationId, forward && supportedChannel ? 1 : 0, current, ...guard.values),
            db.prepare(`INSERT INTO upgrade_notification_releases(release_version,previous_release_version,deployment_id,worker_version_id,notification_id,created_operation_id,created_at)
              SELECT ?1,?2,?3,?4,id,?5,?6 FROM instance_notifications WHERE id=?7 AND created_operation_id=?5`)
              .bind(current, previous, deploymentId, workerVersionId, operationId, now, id),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT json_object('status',
              CASE WHEN ?7=0 THEN 'unsupported_channel' WHEN ?6=0 THEN 'not_forward' WHEN releases.created_operation_id=?1 THEN 'published' WHEN releases.notification_id IS NOT NULL THEN 'already_published' WHEN settings.enabled=0 THEN 'disabled' ELSE NULL END,
              'release_version',?2,'previous_release_version',?3,'deployment_id',?4,'worker_version_id',?5,'notification_id',CASE WHEN ?6=1 AND ?7=1 THEN releases.notification_id ELSE NULL END)
              FROM upgrade_notification_settings settings LEFT JOIN upgrade_notification_releases releases ON releases.release_version=?2
              WHERE settings.singleton=1 AND ${snapshotGuard.sql}) WHERE operation_id=?1 AND state='pending'`)
              .bind(operationId, current, previous, deploymentId, workerVersionId, forward ? 1 : 0, supportedChannel ? 1 : 0, ...snapshotGuard.values),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','instance.upgrade-notification-evaluated',?2,0,?3,?4,'deployment_owner','instance',instance.instance_id,
                snapshot.operation_snapshot_json,?5 FROM instance_meta instance JOIN idempotency_records snapshot ON snapshot.operation_id=?2
              WHERE instance.singleton=1 AND snapshot.state='pending' AND snapshot.operation_snapshot_json IS NOT NULL`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), now),
          ], confirmBusinessRejection: () => ownerGuardRejected(db, auth),
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await authorize(); throw error; }
    },
    readback: async (operationId, commit) => ({ status: 200, body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, operationId), commit.lastEventSequence, false) }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
