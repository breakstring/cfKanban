import { requireUuid, requireVersion, timestamp } from "../domain/model.ts";
import { buildCurrentAuthGuard, requireOwnerControl, verifyCurrentAuth } from "../kernel/authorization.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { ApiError, conflict, forbidden, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, BearerAuthContext, JsonValue } from "../kernel/types.ts";
import { requireIdempotencyKey, writeResult } from "./shared.ts";

type Resource = { [key: string]: JsonValue };
interface OwnerState {
  instance_id: string;
  principal_id: string;
  version: number;
  active_count: number;
}
interface DeviceRequest {
  instance_id: string;
  principal_id: string;
  credential_id: string;
  token_prefix: string;
  token_digest: string;
  device_name: string;
  issued_at: string;
  expires_at: string;
  expected_version: number;
}
const REQUEST_TTL_MS = 60 * 60 * 1_000;
const ACTIVE_CREDENTIAL_LIMIT = 100;

function requireTimestamp(value: JsonValue, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw validationError("schema_validation_failed", { field });
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

function parseDeviceRequest(body: Resource): DeviceRequest {
  const issuedAt = requireTimestamp(body.issued_at ?? null, "issued_at");
  const expiresAt = requireTimestamp(body.expires_at ?? null, "expires_at");
  const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (duration <= 0 || duration > REQUEST_TTL_MS) throw validationError("invalid_owner_device_request_lifetime");
  const prefix = body.token_prefix;
  const digest = body.token_digest;
  if (typeof prefix !== "string" || !/^[a-f0-9]{16}$/.test(prefix)) throw validationError("schema_validation_failed", { field: "token_prefix" });
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw validationError("schema_validation_failed", { field: "token_digest" });
  const name = typeof body.device_name === "string" ? body.device_name.trim() : "";
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name) || /cf[kil]_v1_/i.test(name) || name.includes(digest)) {
    throw validationError("invalid_device_name", { field: "device_name" });
  }
  return {
    instance_id: requireUuid(body.instance_id ?? null, "instance_id"),
    principal_id: requireUuid(body.principal_id ?? null, "principal_id"),
    credential_id: requireUuid(body.credential_id ?? null, "credential_id"),
    token_prefix: prefix,
    token_digest: digest,
    device_name: name,
    issued_at: issuedAt,
    expires_at: expiresAt,
    expected_version: requireVersion(body.expected_version ?? null),
  };
}

async function readOwner(db: D1Database): Promise<OwnerState> {
  try {
    const row = await db.prepare(`SELECT im.instance_id, p.id AS principal_id, p.version,
      (SELECT COUNT(*) FROM credentials c WHERE c.principal_id=p.id AND c.revoked_at IS NULL) AS active_count
      FROM instance_meta im JOIN principals p ON p.id=im.owner_principal_id WHERE im.singleton=1`).first<OwnerState>();
    if (row === null) throw platformUnavailable("d1");
    return row;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function requireBearerOwner(auth: AuthContext): asserts auth is BearerAuthContext {
  requireOwnerControl(auth, true);
}

async function guardRejected(db: D1Database, auth: AuthContext, check: () => Promise<void>): Promise<boolean> {
  try {
    await verifyCurrentAuth(db, auth, Date.now());
    await check();
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return true;
    throw error;
  }
}

function snapshotStatement(db: D1Database, operationId: string, credentialId: string): D1PreparedStatement {
  return db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=(
    SELECT json_object('id',c.id,'principal_id',c.principal_id,'device_name',c.device_name,
      'fingerprint','cfk_v1_' || c.token_prefix || '_…','issued_at',c.issued_at,
      'last_used_at',c.last_used_at,'revoked_at',c.revoked_at,'revoke_reason',c.revoke_reason,
      'principal_version',p.version)
    FROM credentials c JOIN principals p ON p.id=c.principal_id
    WHERE c.id=?2 AND c.last_operation_id=?1 AND p.last_operation_id=?1)
    WHERE operation_id=?1 AND state='pending'`).bind(operationId, credentialId);
}

async function readResource(db: D1Database, operationId: string): Promise<Resource> {
  const row = await readOperationSnapshot<Resource>(db, operationId);
  return {
    ...row,
    issued_at: timestamp(row.issued_at as number),
    last_used_at: timestamp(row.last_used_at as number | null),
    revoked_at: timestamp(row.revoked_at as number | null),
  };
}

function auditStatement(db: D1Database, auth: BearerAuthContext, operationId: string, credentialId: string, type: string, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO events (id,stream,type,operation_id,event_index,actor_principal_id,
    actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
    SELECT ?1,'security',?2,?3,0,?4,?5,'deployment_owner','credential',c.id,
      json_object('credential_id',c.id,'principal_id',c.principal_id,'device_name',c.device_name,
        'fingerprint','cfk_v1_' || c.token_prefix || '_…','principal_version',p.version),?6
    FROM credentials c JOIN principals p ON p.id=c.principal_id
    WHERE c.id=?7 AND c.last_operation_id=?3 AND p.last_operation_id=?3`)
    .bind(crypto.randomUUID(), type, operationId, auth.principalId, auth.credentialId, now, credentialId);
}

export async function addOwnerDevice(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  body: Resource,
  now: number,
): Promise<Resource> {
  requireBearerOwner(auth);
  const input = parseDeviceRequest(body);
  const authorize = async () => { await verifyCurrentAuth(db, auth, Date.now()); requireOwnerControl(auth, true); };
  const check = async () => {
    await authorize();
    const owner = await readOwner(db);
    if (input.instance_id !== owner.instance_id || input.principal_id !== owner.principal_id || auth.principalId !== owner.principal_id) throw forbidden();
    if (owner.version !== input.expected_version) throw versionConflict(owner.version);
    const currentTime = Date.now();
    if (Date.parse(input.issued_at) > currentTime || Date.parse(input.expires_at) <= currentTime) throw validationError("owner_device_request_expired");
    const existing = await db.prepare("SELECT id FROM credentials WHERE id=?1 OR token_digest=?2 LIMIT 1").bind(input.credential_id, input.token_digest).first();
    if (existing !== null) throw conflict("CREDENTIAL_TOKEN_CONFLICT", "generate_new_credential");
    if (owner.active_count >= ACTIVE_CREDENTIAL_LIMIT) throw new ApiError({
      code: "OWNER_CREDENTIAL_LIMIT_REACHED", category: "business_quota", status: 409, retryable: false,
      recovery: "free_capacity_or_request_owner", message: "The Owner active Credential limit has been reached.",
      details: { limit: ACTIVE_CREDENTIAL_LIMIT, current_usage: owner.active_count },
    });
  };
  const result = await runIdempotentOperation({
    db, now, method: "POST", scopeKey: `principal:${auth.principalId}`,
    routeTemplate: "/api/v1/admin/owner-credentials/add-device", normalizedResourceScope: "owner-credentials",
    requestBody: { ...input }, idempotencyKey: requireIdempotencyKey(request), authorize,
    execute: async (operationId) => {
      await check();
      const guard = buildCurrentAuthGuard(auth, Date.now(), 12, true);
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectId: input.credential_id, primarySubjectType: "credential", committedAt: now,
          expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`INSERT INTO credentials(id,principal_id,token_prefix,token_digest,device_name,issued_at,created_operation_id,last_operation_id)
              SELECT ?1,p.id,?2,?3,?4,?5,?6,?6 FROM principals p JOIN instance_meta im ON im.owner_principal_id=p.id
              WHERE im.singleton=1 AND im.instance_id=?7 AND p.id=?8 AND p.version=?9
                AND ?10>?11 AND (SELECT COUNT(*) FROM credentials c WHERE c.principal_id=p.id AND c.revoked_at IS NULL)<100
                AND NOT EXISTS(SELECT 1 FROM credentials c WHERE c.id=?1 OR c.token_digest=?3) AND ${guard.sql}`)
              .bind(input.credential_id,input.token_prefix,input.token_digest,input.device_name,now,operationId,input.instance_id,input.principal_id,input.expected_version,Date.parse(input.expires_at),Date.now(),...guard.values),
            db.prepare(`UPDATE principals SET version=version+1,updated_at=?1,last_operation_id=?2 WHERE id=?3 AND version=?4
              AND EXISTS(SELECT 1 FROM credentials WHERE id=?5 AND created_operation_id=?2)`)
              .bind(now,operationId,auth.principalId,input.expected_version,input.credential_id),
            snapshotStatement(db, operationId, input.credential_id),
            auditStatement(db, auth, operationId, input.credential_id, "owner.device-added", now),
          ],
          confirmBusinessRejection: () => guardRejected(db, auth, check),
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) await check();
        throw error;
      }
    },
    readback: async (operationId, commit) => ({
      body: await writeResult(db, auth, await readResource(db, operationId), commit.lastEventSequence, false),
      status: 200,
    }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function revokeOwnerDevice(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  credentialIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<Resource> {
  requireBearerOwner(auth);
  const credentialId = requireUuid(credentialIdValue, "credential_id");
  if (credentialId === auth.credentialId) throw forbidden();
  const authorize = async () => {
    await verifyCurrentAuth(db, auth, Date.now());
    requireOwnerControl(auth, true);
  };
  const check = async () => {
    await authorize();
    const owner = await readOwner(db);
    if (owner.version !== expectedVersion) throw versionConflict(owner.version);
    const target = await db.prepare("SELECT principal_id,revoked_at FROM credentials WHERE id=?1").bind(credentialId).first<{principal_id:string;revoked_at:number|null}>();
    if (target === null) throw notFound();
    if (target.principal_id !== owner.principal_id) throw forbidden();
    if (target.revoked_at !== null) throw conflict("CREDENTIAL_ALREADY_REVOKED");
  };
  const result = await runIdempotentOperation({
    db,
    now,
    method: "POST",
    scopeKey: `principal:${auth.principalId}`,
    routeTemplate: "/api/v1/admin/owner-credentials/{credential_id}/revoke",
    normalizedResourceScope: `credential:${credentialId}`,
    requestBody: { expected_version: expectedVersion },
    idempotencyKey: requireIdempotencyKey(request),
    authorize,
    execute: async (operationId) => {
      await check();
      const guard = buildCurrentAuthGuard(auth, Date.now(), 6, true);
      try {
        await executeAtomicBatch(db, {
          operationId,
          primarySubjectId: credentialId,
          primarySubjectType: "credential",
          committedAt: now,
          expectedEventCount: 1,
          requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(`UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2,revoke_reason='owner_device_revoke',last_operation_id=?3
              WHERE id=?4 AND principal_id=?2 AND revoked_at IS NULL
                AND EXISTS(SELECT 1 FROM principals p JOIN instance_meta im ON im.owner_principal_id=p.id WHERE p.id=?2 AND p.version=?5)
                AND ${guard.sql}`).bind(now, auth.principalId, operationId, credentialId, expectedVersion, ...guard.values),
            db.prepare(`UPDATE principals SET version=version+1,updated_at=?1,last_operation_id=?2 WHERE id=?3 AND version=?4
              AND EXISTS(SELECT 1 FROM credentials WHERE id=?5 AND last_operation_id=?2)`)
              .bind(now, operationId, auth.principalId, expectedVersion, credentialId),
            db.prepare(`UPDATE web_sessions SET revoked_at=?1 WHERE source_kind='credential' AND source_id=?2 AND revoked_at IS NULL
              AND EXISTS(SELECT 1 FROM credentials WHERE id=?2 AND last_operation_id=?3)`).bind(now, credentialId, operationId),
            db.prepare(`UPDATE browser_launches SET revoked_at=?1 WHERE source_credential_id=?2 AND revoked_at IS NULL AND redeemed_at IS NULL
              AND EXISTS(SELECT 1 FROM credentials WHERE id=?2 AND last_operation_id=?3)`).bind(now, credentialId, operationId),
            snapshotStatement(db, operationId, credentialId),
            auditStatement(db, auth, operationId, credentialId, "owner.device-revoked", now),
          ],
          confirmBusinessRejection: () => guardRejected(db, auth, check),
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) await check();
        throw error;
      }
    },
    readback: async (operationId, commit) => ({
      body: await writeResult(db, auth, await readResource(db, operationId), commit.lastEventSequence, false),
      status: 200,
    }),
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
