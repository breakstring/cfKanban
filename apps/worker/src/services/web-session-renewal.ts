import { timestamp } from "../domain/model.ts";
import { WEB_SESSION_LIFETIME_MS, WEB_SESSION_RENEWAL_INTERVAL_MS, sessionRenewalTimes } from "../domain/web-session-policy.ts";
import { authenticateCookieSession } from "../kernel/auth.ts";
import { buildCurrentAuthGuard } from "../kernel/authorization.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, probeOperationCommit } from "../kernel/d1.ts";
import { platformUnavailable, unauthorized, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { CookieAuthContext, JsonValue } from "../kernel/types.ts";
import { actorCredentialId, authorizedVia, requireIdempotencyKey, writeResult } from "./shared.ts";
import { getWebSession } from "./web-auth.ts";
import { readCurrentWebSession, type WebSessionState } from "./web-session-state.ts";

type Resource = { [key: string]: JsonValue };

// 与既有 Session 查询保持同一范围规则；续期不改变 target 或授权来源。
const scopeGuard = `(
  s.target_kind='project_selection'
  OR (s.target_kind='admin' AND EXISTS(SELECT 1 FROM instance_meta im WHERE im.singleton=1 AND im.owner_principal_id=s.principal_id))
  OR (s.target_kind='workspace' AND EXISTS(
    SELECT 1 FROM workspaces w JOIN instance_meta im ON im.singleton=1
    WHERE w.id=json_extract(s.target_json,'$.workspace_id') AND (
      im.owner_principal_id=s.principal_id OR (w.deleted_at IS NULL AND EXISTS(
        SELECT 1 FROM scoped_administrator_grants a WHERE a.workspace_id=w.id AND a.project_id IS NULL
          AND a.principal_id=s.principal_id AND a.revoked_at IS NULL
      ))
    )
  ))
  OR (s.target_kind IN ('project','issue') AND EXISTS(
    SELECT 1 FROM projects p JOIN workspaces w ON w.id=p.workspace_id JOIN instance_meta im ON im.singleton=1
    WHERE p.id=json_extract(s.target_json,'$.project_id') AND w.id=json_extract(s.target_json,'$.workspace_id')
      AND p.deleted_at IS NULL AND w.deleted_at IS NULL
      AND (im.owner_principal_id=s.principal_id OR EXISTS(
        SELECT 1 FROM effective_project_grants g WHERE g.project_id=p.id AND g.principal_id=s.principal_id AND g.revoked_at IS NULL
      ))
      AND (s.target_kind<>'issue' OR EXISTS(
        SELECT 1 FROM issues i WHERE i.id=json_extract(s.target_json,'$.issue_id') AND i.project_id=p.id
          AND 'CFK-'||i.number=json_extract(s.target_json,'$.identifier') AND i.deleted_at IS NULL
      ))
  ))
)`;

function renewalResource(row: WebSessionState, renewed: boolean): Resource {
  const times = sessionRenewalTimes(row.created_at, row.last_seen_at);
  return { session_id: row.id, version: row.version, expires_at: timestamp(row.expires_at),
    renew_after: timestamp(times.renewAfter), absolute_expires_at: timestamp(times.absoluteExpiresAt), renewed };
}

const snapshotSql = `json_object('id',s.id,'version',s.version,'expires_at',s.expires_at,
  'created_at',s.created_at,'last_seen_at',s.last_seen_at,'renewed',?2)`;

export async function renewWebSession(db: D1Database, request: Request, initialAuth: CookieAuthContext, expectedVersion: number, now: number): Promise<Resource> {
  let auth = initialAuth;
  const authorize = async () => {
    auth = await authenticateCookieSession(db, request, Date.now());
    if (auth.sessionId !== initialAuth.sessionId || auth.principalId !== initialAuth.principalId) throw unauthorized(true);
    await getWebSession(db, auth, Date.now());
  };
  const check = async () => {
    await authorize();
    const row = await readCurrentWebSession(db, auth);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  };
  const result = await runIdempotentOperation({
    db, now, authorize, method: "POST", routeTemplate: "/api/v1/web-session/renew",
    scopeKey: `principal:${initialAuth.principalId}`, normalizedResourceScope: `web-session:${initialAuth.sessionId}`,
    requestBody: { expected_version: expectedVersion }, idempotencyKey: requireIdempotencyKey(request),
    execute: async operationId => {
      const row = await check(), renewedAt = Date.now();
      const policy = sessionRenewalTimes(row.created_at, row.last_seen_at);
      const expiresAt = Math.min(renewedAt + WEB_SESSION_LIFETIME_MS, policy.absoluteExpiresAt);
      const renewed = renewedAt >= policy.renewAfter && expiresAt > row.expires_at;
      if (!renewed) {
        const snapshotGuard = buildCurrentAuthGuard(auth, renewedAt, 5);
        const commitGuard = buildCurrentAuthGuard(auth, renewedAt, 5);
        try {
          // 空操作只冻结幂等结果，不写续期审计或修改 Session；commit 与快照同事务。
          await db.batch([
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT ${snapshotSql} FROM web_sessions s
              WHERE s.id=?3 AND s.version=?4 AND ${scopeGuard} AND ${snapshotGuard.sql})
              WHERE operation_id=?1 AND state='pending'`).bind(operationId, 0, auth.sessionId, expectedVersion, ...snapshotGuard.values),
            db.prepare(`INSERT INTO operation_commits(operation_id,primary_subject_type,primary_subject_id,last_event_sequence,committed_at)
              SELECT ?1,'web_session',s.id,COALESCE((SELECT MAX(sequence) FROM events),0),?2 FROM web_sessions s
              WHERE s.id=?3 AND s.version=?4 AND ${scopeGuard} AND ${commitGuard.sql}
                AND EXISTS(SELECT 1 FROM idempotency_records WHERE operation_id=?1 AND state='pending' AND operation_snapshot_json IS NOT NULL)`)
              .bind(operationId, renewedAt, auth.sessionId, expectedVersion, ...commitGuard.values),
          ]);
        } catch (error) {
          if (await probeOperationCommit(db, operationId) !== null) return;
          await check();
          throw platformUnavailable("d1", error);
        }
        if (await probeOperationCommit(db, operationId) === null) { await check(); throw new AtomicBatchRejectedError(); }
        return;
      }
      const guard = buildCurrentAuthGuard(auth, renewedAt, 7);
      try {
        await executeAtomicBatch(db, {
          operationId, committedAt: renewedAt, primarySubjectType: "web_session", primarySubjectId: auth.sessionId,
          expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE web_sessions AS s SET expires_at=?1,last_seen_at=?2,version=version+1,last_operation_id=?3
              WHERE s.id=?4 AND s.version=?5 AND s.expires_at<?1
                AND COALESCE(s.last_seen_at,s.created_at)+?6<=?2 AND ${scopeGuard} AND ${guard.sql}`)
              .bind(expiresAt, renewedAt, operationId, auth.sessionId, expectedVersion, WEB_SESSION_RENEWAL_INTERVAL_MS, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT ${snapshotSql} FROM web_sessions s
              WHERE s.id=?3 AND s.last_operation_id=?1) WHERE operation_id=?1 AND state='pending'`)
              .bind(operationId, 1, auth.sessionId),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','web-session.renewed',?2,0,?3,?4,?5,'web_session',s.id,
                json_object('version',s.version,'expires_at',s.expires_at,'source_kind',s.source_kind,'target_kind',s.target_kind),?6
              FROM web_sessions s WHERE s.id=?7 AND s.last_operation_id=?2`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), authorizedVia(auth), renewedAt, auth.sessionId),
          ],
          confirmBusinessRejection: async () => {
            try { const latest = await check(); return latest.version !== expectedVersion; }
            catch (error) { if ((error as { status?: number }).status === 401 || (error as { status?: number }).status === 403 || (error as { status?: number }).status === 404 || (error as { status?: number }).status === 409) return true; throw error; }
          },
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: async (operationId, commit) => {
      const snapshot = await readOperationSnapshot<Resource>(db, operationId);
      const resource = renewalResource(snapshot as unknown as WebSessionState, snapshot.renewed === 1);
      return { status: 200, body: await writeResult(db, auth, resource, commit.lastEventSequence, false) };
    },
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
