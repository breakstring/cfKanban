import { timestamp } from "../domain/model.ts";
import { buildCurrentAuthGuard, reauthenticateOwner, requireOwnerControl, verifyCurrentAuth } from "../kernel/authorization.ts";
import { createCursorContext, cursorScopeMismatch, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { ApiError, forbidden, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { actorCredentialId, authorizedVia, requireIdempotencyKey, writeResult } from "./shared.ts";
import { readPendingNotifications } from "./notification-pending-cache.ts";

type Resource = { [key: string]: JsonValue };
interface NotificationRow {
  id: string;
  title: string;
  body: string;
  created_at: number;
  created_by_principal_id: string;
  expires_at: number | null;
  withdrawn_at: number | null;
  version: number;
  acknowledged_at: number | null;
}
interface PreferenceRow { enabled: number; version: number; receive_after: number }

const notificationJson = (acknowledgedAt = "NULL") => `json_object('id',n.id,'title',n.title,'body',n.body,
  'created_at',n.created_at,'created_by_principal_id',n.created_by_principal_id,
  'expires_at',n.expires_at,'withdrawn_at',n.withdrawn_at,'version',n.version,'acknowledged_at',${acknowledgedAt})`;

function notificationResource(row: NotificationRow, now: number): Resource {
  return {
    id: row.id, title: row.title, body: row.body, created_at: timestamp(row.created_at),
    expires_at: timestamp(row.expires_at), withdrawn_at: timestamp(row.withdrawn_at), version: row.version,
    status: row.withdrawn_at !== null ? "withdrawn" : row.expires_at !== null && row.expires_at <= now ? "expired" : "active",
    acknowledged_at: timestamp(row.acknowledged_at),
  };
}
function preferenceResource(row: PreferenceRow): Resource {
  return { enabled: row.enabled === 1, version: row.version, receive_after: timestamp(row.receive_after) };
}
function textInput(value: JsonValue, field: string, maximum: number, trim: boolean): string {
  if (typeof value !== "string" || value.includes("\0")) throw validationError("invalid_notification_text", { field });
  const result = trim ? value.trim() : value;
  if (!result.trim() || [...result].length > maximum) throw validationError("invalid_notification_text", { field });
  return result;
}
function expiryInput(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw validationError("invalid_notification_expiry");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) throw validationError("invalid_notification_expiry");
  return parsed;
}
async function guardRejected(db: D1Database, auth: AuthContext, ownerOnly = false): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, Date.now(), 1, ownerOnly);
  try { return await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first() === null; }
  catch (error) { throw platformUnavailable("d1", error); }
}
async function readPreferences(db: D1Database, principalId: string): Promise<PreferenceRow> {
  try {
    const row = await db.prepare(`SELECT COALESCE(np.enabled,1) AS enabled,COALESCE(np.version,1) AS version,
      MAX(p.created_at,COALESCE(np.receive_after,p.created_at)) AS receive_after
      FROM principals p LEFT JOIN notification_preferences np ON np.principal_id=p.id WHERE p.id=?1`)
      .bind(principalId).first<PreferenceRow>();
    if (row === null) throw notFound();
    return row;
  } catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
}
async function readNotification(db: D1Database, id: string, principalId: string): Promise<NotificationRow | null> {
  try {
    return await db.prepare(`SELECT n.*,a.acknowledged_at FROM instance_notifications n
      LEFT JOIN notification_acknowledgements a ON a.notification_id=n.id AND a.principal_id=?2 WHERE n.id=?1`)
      .bind(id, principalId).first<NotificationRow>();
  } catch (error) { throw platformUnavailable("d1", error); }
}
async function notificationSnapshot(db: D1Database, operationId: string, now: number): Promise<Resource> {
  const snapshot = await readOperationSnapshot<Resource>(db, operationId);
  return notificationResource(snapshot as unknown as NotificationRow, now);
}

export async function getNotificationPreferences(db: D1Database, auth: AuthContext): Promise<Resource> {
  const row = await readPreferences(db, auth.principalId);
  await verifyCurrentAuth(db, auth, Date.now());
  return preferenceResource(row);
}

export async function listNotifications(db: D1Database, auth: AuthContext, url: URL, now: number, admin = false): Promise<Resource> {
  if (admin) requireOwnerControl(auth);
  for (const key of url.searchParams.keys()) {
    if (!["limit", "cursor", ...(admin ? [] : ["pending"])].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw validationError("unsupported_query_option", { field: key });
    }
  }
  const rawLimit = url.searchParams.get("limit") ?? "20";
  if (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 50) throw validationError("invalid_limit");
  const limit = Number(rawLimit);
  const rawPending = url.searchParams.get("pending") ?? "false";
  if (rawPending !== "true" && rawPending !== "false") throw validationError("invalid_pending_filter");
  const pending = !admin && rawPending === "true";
  const preferences = await readPreferences(db, auth.principalId);
  const context = await createCursorContext(admin ? "admin-notifications" : "personal-notifications",
    { pending, ...(pending ? { preference_version: preferences.version, receive_after: preferences.receive_after } : {}) }, [], auth.principalId);
  const last = decodeCursor(url.searchParams.get("cursor"), context);
  if (last !== null && (last.length !== 2 || typeof last[0] !== "number" || !Number.isSafeInteger(last[0])
    || typeof last[1] !== "string" || !/^[0-9a-f-]{36}$/i.test(last[1]))) throw invalidCursor();
  const readAt = Date.now();
  const checkCurrent = async () => {
    const finalPreferences = pending ? await readPreferences(db, auth.principalId) : null;
    await verifyCurrentAuth(db, auth, Date.now());
    if (admin && await guardRejected(db, auth, true)) throw forbidden();
    if (finalPreferences !== null) {
      if (finalPreferences.enabled === 0) return false;
      if (finalPreferences.version !== preferences.version || finalPreferences.receive_after !== preferences.receive_after) throw cursorScopeMismatch();
    }
    return true;
  };
  const pageResult = async (rows: NotificationRow[]): Promise<Resource> => {
    const page = rows.slice(0, limit), tail = page.at(-1);
    return { items: page.map(row => notificationResource(row, readAt)),
      next_cursor: rows.length > limit && tail ? encodeCursor(context, [tail.created_at, tail.id]) : null };
  };
  if (pending) {
    try {
      if (preferences.enabled === 0) {
        if (!await checkCurrent()) return { items: [], next_cursor: null };
      }
      const read = await readPendingNotifications<NotificationRow>(db, auth, preferences, last as (string | number)[] | null, limit, readAt);
      if (!await checkCurrent()) return { items: [], next_cursor: null };
      if (read.save !== null && !await read.save()) {
        read.rows = await read.cold();
        if (!await checkCurrent()) return { items: [], next_cursor: null };
      }
      return pageResult(read.rows);
    } catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
  }
  const values: (string | number | null)[] = [auth.principalId];
  const conditions: string[] = admin ? [] : ["n.created_by_principal_id<>?1"];
  if (last !== null) {
    const start = values.length + 1;
    conditions.push(`(n.created_at,n.id)<(?${start},?${start + 1})`);
    values.push(last[0] as number, last[1] as string);
  }
  const guard = buildCurrentAuthGuard(auth, Date.now(), values.length + 1, admin);
  conditions.push(guard.sql);
  values.push(...guard.values, limit + 1);
  try {
    const rows = await db.prepare(`SELECT n.*,a.acknowledged_at FROM instance_notifications n
      JOIN principals p ON p.id=?1 LEFT JOIN notification_preferences np ON np.principal_id=p.id
      LEFT JOIN notification_acknowledgements a ON a.notification_id=n.id AND a.principal_id=?1
      WHERE ${conditions.join(" AND ")} ORDER BY n.created_at DESC,n.id DESC LIMIT ?${values.length}`)
      .bind(...values).all<NotificationRow>();
    await checkCurrent();
    return pageResult(rows.results);
  } catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
}

export async function updateNotificationPreferences(db: D1Database, request: Request, auth: AuthContext, enabledInput: JsonValue, expectedVersion: number, now: number): Promise<Resource> {
  if (typeof enabledInput !== "boolean") throw validationError("invalid_notification_preference");
  const enabled = enabledInput ? 1 : 0;
  const authorize = () => verifyCurrentAuth(db, auth, Date.now());
  const check = async () => { await authorize(); const row = await readPreferences(db, auth.principalId); if (row.version !== expectedVersion) throw versionConflict(row.version); };
  const result = await runIdempotentOperation({ db, now, authorize, method: "PATCH", routeTemplate: "/api/v1/me/notification-preferences",
    scopeKey: `principal:${auth.principalId}`, normalizedResourceScope: `notification-preferences:${auth.principalId}`,
    idempotencyKey: requireIdempotencyKey(request), requestBody: { enabled: enabledInput, expected_version: expectedVersion },
    execute: async operationId => {
      await check();
      const changedAt = Date.now(), guard = buildCurrentAuthGuard(auth, changedAt, 6);
      try {
        await executeAtomicBatch(db, { operationId, committedAt: now, primarySubjectType: "principal", primarySubjectId: auth.principalId, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`INSERT INTO notification_preferences(principal_id,enabled,receive_after,version,last_operation_id)
              SELECT p.id,?1,CASE WHEN COALESCE(np.enabled,1)=0 AND ?1=1 THEN ?2 ELSE MAX(p.created_at,COALESCE(np.receive_after,p.created_at)) END,
                COALESCE(np.version,1)+1,?3 FROM principals p LEFT JOIN notification_preferences np ON np.principal_id=p.id
              WHERE p.id=?4 AND COALESCE(np.version,1)=?5 AND ${guard.sql}
              ON CONFLICT(principal_id) DO UPDATE SET enabled=excluded.enabled,receive_after=excluded.receive_after,
                version=excluded.version,last_operation_id=excluded.last_operation_id`).bind(enabled, changedAt, operationId, auth.principalId, expectedVersion, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT json_object('enabled',enabled,'receive_after',receive_after,'version',version)
              FROM notification_preferences WHERE principal_id=?2 AND last_operation_id=?1) WHERE operation_id=?1 AND state='pending'`).bind(operationId, auth.principalId),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','principal.notification-preferences-updated',?2,0,?3,?4,?5,'principal',principal_id,
                json_object('enabled',enabled,'version',version,'auth_kind',?7,'scope','personal'),?6
              FROM notification_preferences WHERE principal_id=?3 AND last_operation_id=?2`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), authorizedVia(auth), now, auth.kind),
          ], confirmBusinessRejection: async () => await guardRejected(db, auth) || (await readPreferences(db, auth.principalId)).version !== expectedVersion,
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: async (operationId, commit) => ({ status: 200, body: await writeResult(db, auth, preferenceResource(await readOperationSnapshot<Resource>(db, operationId) as unknown as PreferenceRow), commit.lastEventSequence, false) }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function publishNotification(db: D1Database, request: Request, auth: AuthContext, input: Resource, now: number): Promise<Resource> {
  requireOwnerControl(auth);
  const title = textInput(input.title ?? null, "title", 200, true), body = textInput(input.body ?? null, "body", 4000, false);
  const expiresAt = expiryInput(input.expires_at);
  const authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const result = await runIdempotentOperation({ db, now, authorize, method: "POST", routeTemplate: "/api/v1/admin/notifications", scopeKey: `principal:${auth.principalId}`,
    normalizedResourceScope: "instance-notifications", idempotencyKey: requireIdempotencyKey(request), requestBody: { title, body, expires_at: timestamp(expiresAt) },
    execute: async operationId => {
      await authorize();
      if (expiresAt !== null && expiresAt <= now) throw validationError("invalid_notification_expiry");
      const id = crypto.randomUUID(), guard = buildCurrentAuthGuard(auth, Date.now(), 8, true);
      try {
        await executeAtomicBatch(db, { operationId, committedAt: now, primarySubjectType: "notification", primarySubjectId: id, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,expires_at,created_operation_id,last_operation_id)
              SELECT ?1,?2,?3,?4,?5,?6,?7,?7 WHERE ${guard.sql}`).bind(id, title, body, now, auth.principalId, expiresAt, operationId, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT ${notificationJson()} FROM instance_notifications n
              WHERE n.id=?2 AND n.last_operation_id=?1) WHERE operation_id=?1 AND state='pending'`).bind(operationId, id),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','instance.notification-published',?2,0,?3,?4,'deployment_owner','notification',n.id,
                json_object('notification_id',n.id,'version',n.version),?5 FROM instance_notifications n WHERE n.id=?6 AND n.last_operation_id=?2`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), now, id),
          ], confirmBusinessRejection: () => guardRejected(db, auth, true),
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await authorize(); throw error; }
    },
    readback: async (operationId, commit) => ({ status: 200, body: await writeResult(db, auth, await notificationSnapshot(db, operationId, now), commit.lastEventSequence, false) }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function withdrawNotification(db: D1Database, request: Request, auth: AuthContext, id: string, expectedVersion: number, now: number): Promise<Resource> {
  requireOwnerControl(auth);
  const authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const check = async () => {
    await authorize(); const row = await readNotification(db, id, auth.principalId);
    if (row === null) throw notFound();
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    if (row.withdrawn_at !== null) throw validationError("notification_already_withdrawn");
  };
  const result = await runIdempotentOperation({ db, now, authorize, method: "POST", routeTemplate: "/api/v1/admin/notifications/{notification_id}/commands/withdraw", scopeKey: `principal:${auth.principalId}`,
    normalizedResourceScope: `notification:${id}`, idempotencyKey: requireIdempotencyKey(request), requestBody: { expected_version: expectedVersion },
    execute: async operationId => {
      await check(); const guard = buildCurrentAuthGuard(auth, Date.now(), 5, true);
      try {
        await executeAtomicBatch(db, { operationId, committedAt: now, primarySubjectType: "notification", primarySubjectId: id, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE instance_notifications SET withdrawn_at=?1,version=version+1,last_operation_id=?2
              WHERE id=?3 AND version=?4 AND withdrawn_at IS NULL AND ${guard.sql}`).bind(now, operationId, id, expectedVersion, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT ${notificationJson()} FROM instance_notifications n
              WHERE n.id=?2 AND n.last_operation_id=?1) WHERE operation_id=?1 AND state='pending'`).bind(operationId, id),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','instance.notification-withdrawn',?2,0,?3,?4,'deployment_owner','notification',n.id,
                json_object('notification_id',n.id,'version',n.version),?5 FROM instance_notifications n WHERE n.id=?6 AND n.last_operation_id=?2`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), now, id),
          ], confirmBusinessRejection: async () => await guardRejected(db, auth, true) || (await readNotification(db, id, auth.principalId))?.version !== expectedVersion,
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: async (operationId, commit) => ({ status: 200, body: await writeResult(db, auth, await notificationSnapshot(db, operationId, now), commit.lastEventSequence, false) }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function acknowledgeNotification(db: D1Database, request: Request, auth: AuthContext, id: string, now: number): Promise<Resource> {
  const authorize = () => verifyCurrentAuth(db, auth, Date.now());
  const check = async () => { await authorize(); const row = await readNotification(db, id, auth.principalId); if (row === null || row.created_by_principal_id === auth.principalId) throw notFound(); };
  const result = await runIdempotentOperation({ db, now, authorize, method: "POST", routeTemplate: "/api/v1/me/notifications/{notification_id}/commands/acknowledge", scopeKey: `principal:${auth.principalId}`,
    normalizedResourceScope: `notification:${id}`, idempotencyKey: requireIdempotencyKey(request), requestBody: {},
    execute: async operationId => {
      await check(); const guard = buildCurrentAuthGuard(auth, Date.now(), 5);
      const snapshotGuard = buildCurrentAuthGuard(auth, Date.now(), 4);
      const eventGuard = buildCurrentAuthGuard(auth, Date.now(), 9);
      try {
        await executeAtomicBatch(db, { operationId, committedAt: now, primarySubjectType: "notification", primarySubjectId: id, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`INSERT INTO notification_acknowledgements(notification_id,principal_id,acknowledged_at,created_operation_id)
              SELECT n.id,?2,?3,?4 FROM instance_notifications n WHERE n.id=?1 AND n.created_by_principal_id<>?2 AND ${guard.sql}
              ON CONFLICT(notification_id,principal_id) DO NOTHING`).bind(id, auth.principalId, now, operationId, ...guard.values),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(SELECT ${notificationJson("a.acknowledged_at")} FROM instance_notifications n
              JOIN notification_acknowledgements a ON a.notification_id=n.id AND a.principal_id=?3
              WHERE n.id=?2 AND n.created_by_principal_id<>?3 AND ${snapshotGuard.sql}) WHERE operation_id=?1 AND state='pending'`)
              .bind(operationId, id, auth.principalId, ...snapshotGuard.values),
            db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security','principal.notification-acknowledged',?2,0,?3,?4,?5,'notification',n.id,
                json_object('notification_id',n.id,'auth_kind',?8,'scope','personal'),?6 FROM instance_notifications n
              JOIN notification_acknowledgements a ON a.notification_id=n.id AND a.principal_id=?3
              WHERE n.id=?7 AND n.created_by_principal_id<>?3 AND ${eventGuard.sql}`)
              .bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), authorizedVia(auth), now, id, auth.kind, ...eventGuard.values),
          ], confirmBusinessRejection: async () => await guardRejected(db, auth) || (await readNotification(db, id, auth.principalId)) === null,
        });
      } catch (error) { if (error instanceof AtomicBatchRejectedError) await check(); throw error; }
    },
    readback: async (operationId, commit) => ({ status: 200, body: await writeResult(db, auth, await notificationSnapshot(db, operationId, now), commit.lastEventSequence, false) }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
