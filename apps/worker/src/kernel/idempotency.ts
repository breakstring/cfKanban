import { sha256Hex } from "./crypto.ts";
import { ApiError, platformUnavailable, validationError } from "./errors.ts";
import { AtomicBatchRejectedError, probeOperationCommit, type OperationCommit } from "./d1.ts";
import type { JsonValue } from "./types.ts";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 64;
const secretTokenPattern = /(?:cfk_v1_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43,512}|cfi_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}|cfl_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43})/;

interface IdempotencyRow {
  operation_id: string;
  request_hash: string;
  response_json: string | null;
  response_status: number | null;
  state: "committed" | "pending";
}

export interface IdempotencyIdentity {
  idempotencyKey: string;
  method: string;
  normalizedResourceScope: string;
  requestBody: JsonValue;
  routeTemplate: string;
  scopeKey: string;
}

export interface IdempotencyClaim {
  operationId: string;
  owned: boolean;
  requestHash: string;
  resourceScopeHash: string;
  responseJson: string | null;
  responseStatus: number | null;
  state: "committed" | "pending";
}

export interface IdempotentReadback<T extends JsonValue> {
  body: T;
  status: number;
}

export interface RunIdempotentOperationOptions<T extends JsonValue> extends IdempotencyIdentity {
  authorize: () => Promise<void>;
  db: D1Database;
  execute: (operationId: string) => Promise<void>;
  forbiddenPersistenceValues?: readonly string[];
  now?: number;
  readback: (operationId: string, commit: OperationCommit) => Promise<IdempotentReadback<T>>;
  replay?: (stored: IdempotentReadback<T>) => Promise<IdempotentReadback<T>>;
}

export interface IdempotentOperationResult<T extends JsonValue> extends IdempotentReadback<T> {
  idempotentReplay: boolean;
  operationId: string;
}

const sensitivePersistenceKeys = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "credential_token",
  "new_credential_token",
  "session_secret",
  "session_token",
  "token_digest",
  "code_digest",
  "challenge_digest",
  "invite_code",
  "launch_code",
  "sql",
  "stack",
  "bookmark",
]);

export function validateIdempotencyKey(key: string, forbiddenValues: readonly string[] = []): void {
  if (key.length === 0) {
    throw new ApiError({
      category: "validation",
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "Idempotency-Key is required.",
      recovery: "none",
      retryable: false,
      status: 400,
    });
  }
  if (!/^[\x20-\x7E]{1,128}$/.test(key)) {
    throw validationError("invalid_idempotency_key");
  }
  if (
    secretTokenPattern.test(key)
    || forbiddenValues.some((secret) => secret.length >= 8 && key.includes(secret))
  ) {
    throw validationError("invalid_idempotency_key");
  }
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw validationError("non_finite_json_number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export async function computeRequestHash(identity: IdempotencyIdentity): Promise<{
  requestHash: string;
  resourceScopeHash: string;
}> {
  const method = identity.method.toUpperCase();
  const resourceScopeHash = await sha256Hex(identity.normalizedResourceScope);
  const requestHash = await sha256Hex(
    `${method}\n${identity.routeTemplate}\n${identity.normalizedResourceScope}\n${canonicalJson(identity.requestBody)}`,
  );
  return { requestHash, resourceScopeHash };
}

function idempotencyConflict(): ApiError {
  return new ApiError({
    category: "conflict",
    code: "IDEMPOTENCY_CONFLICT",
    message: "The Idempotency-Key was already used for a different request.",
    recovery: "none",
    retryable: false,
    status: 409,
  });
}

function safeJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(safeJson);
  return typeof value === "object" && Object.values(value).every(safeJson);
}

function assertPersistenceSafe(value: JsonValue, forbiddenValues: readonly string[]): void {
  if (typeof value === "string") {
    if (
      forbiddenValues.some((secret) => secret.length >= 8 && value.includes(secret))
    ) {
      throw new Error("Idempotency response rejected by secret policy.");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertPersistenceSafe(entry, forbiddenValues);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (sensitivePersistenceKeys.has(key.toLowerCase()) || key.toLowerCase().endsWith("_digest")) {
        throw new Error("Idempotency response rejected by secret policy.");
      }
      assertPersistenceSafe(entry, forbiddenValues);
    }
  }
}

export function operationSnapshotStatement(
  db: D1Database,
  operationId: string,
  snapshot: JsonValue,
): D1PreparedStatement {
  assertPersistenceSafe(snapshot, []);
  const snapshotJson = canonicalJson(snapshot);
  if (new TextEncoder().encode(snapshotJson).byteLength > 128 * 1_024) {
    throw new Error("Operation snapshot exceeds the persistence limit.");
  }
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = ?1
     WHERE operation_id = ?2 AND state = 'pending'`,
  ).bind(snapshotJson, operationId);
}

export async function readOperationSnapshot<T>(
  db: D1Database,
  operationId: string,
): Promise<T> {
  let row: { operation_snapshot_json: string | null } | null;
  try {
    row = await db.prepare(
      `SELECT operation_snapshot_json FROM idempotency_records
       WHERE operation_id = ?1
         AND EXISTS (SELECT 1 FROM operation_commits WHERE operation_id = ?1)
       LIMIT 1`,
    ).bind(operationId).first<{ operation_snapshot_json: string | null }>();
  } catch {
    throw platformUnavailable("d1");
  }
  if (row?.operation_snapshot_json === null || row === null) throw new AtomicBatchRejectedError();
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.operation_snapshot_json);
  } catch {
    throw new AtomicBatchRejectedError();
  }
  if (!safeJson(snapshot)) throw new AtomicBatchRejectedError();
  return snapshot as T;
}

export async function claimIdempotency(
  db: D1Database,
  identity: IdempotencyIdentity,
  now = Date.now(),
  forbiddenValues: readonly string[] = [],
): Promise<IdempotencyClaim> {
  validateIdempotencyKey(identity.idempotencyKey, forbiddenValues);
  // The schema column is a lookup key; persist a digest so a caller mistake cannot store the raw header value.
  const [{ requestHash, resourceScopeHash }, storedIdempotencyKey] = await Promise.all([
    computeRequestHash(identity),
    sha256Hex(identity.idempotencyKey),
  ]);
  const proposedOperationId = crypto.randomUUID();
  const recordId = crypto.randomUUID();

  let row: IdempotencyRow | null;
  try {
    const deleteExpired = db.prepare(
      `DELETE FROM idempotency_records
       WHERE scope_key = ?1 AND method = ?2 AND route_template = ?3
         AND resource_scope_hash = ?4 AND idempotency_key = ?5
         AND expires_at <= ?6`,
    ).bind(
      identity.scopeKey,
      identity.method.toUpperCase(),
      identity.routeTemplate,
      resourceScopeHash,
      storedIdempotencyKey,
      now,
    );
    const deleteExpiredBatch = db.prepare(
      `DELETE FROM idempotency_records
       WHERE id IN (
         SELECT id
         FROM idempotency_records
         WHERE expires_at <= ?1
         ORDER BY expires_at, id
         LIMIT ?2
       )`,
    ).bind(now, IDEMPOTENCY_CLEANUP_BATCH_SIZE);
    const insertPending = db.prepare(
      `INSERT OR IGNORE INTO idempotency_records
        (id, scope_key, method, route_template, resource_scope_hash,
         idempotency_key, request_hash, operation_id, state, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10)`,
    ).bind(
      recordId,
      identity.scopeKey,
      identity.method.toUpperCase(),
      identity.routeTemplate,
      resourceScopeHash,
      storedIdempotencyKey,
      requestHash,
      proposedOperationId,
      now,
      now + IDEMPOTENCY_TTL_MS,
    );
    await db.batch([deleteExpired, deleteExpiredBatch, insertPending]);

    row = await db.prepare(
      `SELECT request_hash, operation_id, state, response_status, response_json
       FROM idempotency_records
       WHERE scope_key = ?1 AND method = ?2 AND route_template = ?3
         AND resource_scope_hash = ?4 AND idempotency_key = ?5
       LIMIT 1`,
    ).bind(
      identity.scopeKey,
      identity.method.toUpperCase(),
      identity.routeTemplate,
      resourceScopeHash,
      storedIdempotencyKey,
    ).first<IdempotencyRow>();
  } catch {
    throw platformUnavailable("d1");
  }

  if (row === null) throw platformUnavailable("d1");
  if (row.request_hash !== requestHash) throw idempotencyConflict();
  return {
    operationId: row.operation_id,
    owned: row.operation_id === proposedOperationId,
    requestHash,
    resourceScopeHash,
    responseJson: row.response_json,
    responseStatus: row.response_status,
    state: row.state,
  };
}

function parseStoredResponse<T extends JsonValue>(claim: IdempotencyClaim): IdempotentReadback<T> {
  if (claim.state !== "committed" || claim.responseJson === null || claim.responseStatus === null) {
    throw new AtomicBatchRejectedError();
  }
  let body: unknown;
  try {
    body = JSON.parse(claim.responseJson);
  } catch {
    throw new AtomicBatchRejectedError();
  }
  if (!safeJson(body)) throw new AtomicBatchRejectedError();
  return { body: body as T, status: claim.responseStatus };
}

export async function readFinalizedIdempotencyResponse<T extends JsonValue>(
  db: D1Database,
  operationId: string,
): Promise<IdempotentReadback<T> | null> {
  let row: IdempotencyRow | null;
  try {
    row = await db.prepare(
      `SELECT request_hash, operation_id, state, response_status, response_json
       FROM idempotency_records
       WHERE operation_id = ?1 AND state = 'committed'
       LIMIT 1`,
    ).bind(operationId).first<IdempotencyRow>();
  } catch {
    throw platformUnavailable("d1");
  }
  return row === null ? null : parseStoredResponse<T>({
    operationId: row.operation_id,
    owned: false,
    requestHash: row.request_hash,
    resourceScopeHash: "",
    responseJson: row.response_json,
    responseStatus: row.response_status,
    state: row.state,
  });
}

export function readIdempotencyResponse<T extends JsonValue>(
  claim: IdempotencyClaim,
): IdempotentReadback<T> {
  return parseStoredResponse<T>(claim);
}

export async function finalizeIdempotency<T extends JsonValue>(
  db: D1Database,
  operationId: string,
  response: IdempotentReadback<T>,
  forbiddenValues: readonly string[] = [],
  finalizedAt = Date.now(),
): Promise<IdempotentReadback<T>> {
  assertPersistenceSafe(response.body, forbiddenValues);
  const responseJson = canonicalJson(response.body);
  if (new TextEncoder().encode(responseJson).byteLength > 128 * 1_024) {
    throw new Error("Idempotency response exceeds the persistence limit.");
  }

  let row: IdempotencyRow | null;
  try {
    await db.prepare(
      `UPDATE idempotency_records
       SET state = 'committed', response_status = ?1, response_json = ?2,
           operation_snapshot_json = NULL, expires_at = ?4
       WHERE operation_id = ?3 AND state = 'pending'
         AND EXISTS (SELECT 1 FROM operation_commits WHERE operation_id = ?3)`,
    ).bind(response.status, responseJson, operationId, finalizedAt + IDEMPOTENCY_TTL_MS).run();
    row = await db.prepare(
      `SELECT request_hash, operation_id, state, response_status, response_json
       FROM idempotency_records WHERE operation_id = ?1 LIMIT 1`,
    ).bind(operationId).first<IdempotencyRow>();
  } catch {
    throw platformUnavailable("d1");
  }
  if (row === null) throw new AtomicBatchRejectedError();
  return parseStoredResponse<T>({
    operationId: row.operation_id,
    owned: false,
    requestHash: row.request_hash,
    resourceScopeHash: "",
    responseJson: row.response_json,
    responseStatus: row.response_status,
    state: row.state,
  });
}

export async function abandonOwnedPendingClaim(
  db: D1Database,
  claim: IdempotencyClaim,
): Promise<void> {
  if (!claim.owned) return;
  try {
    await db.prepare(
      `DELETE FROM idempotency_records
       WHERE operation_id = ?1 AND request_hash = ?2 AND state = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM operation_commits WHERE operation_id = ?1
         )`,
    ).bind(claim.operationId, claim.requestHash).run();
  } catch {
    throw platformUnavailable("d1");
  }
}

export async function runIdempotentOperation<T extends JsonValue>(
  options: RunIdempotentOperationOptions<T>,
): Promise<IdempotentOperationResult<T>> {
  await options.authorize();
  const claim = await claimIdempotency(
    options.db,
    options,
    options.now,
    options.forbiddenPersistenceValues ?? [],
  );

  if (claim.state === "committed") {
    await options.authorize();
    const stored = parseStoredResponse<T>(claim);
    return {
      ...(options.replay === undefined ? stored : await options.replay(stored)),
      idempotentReplay: true,
      operationId: claim.operationId,
    };
  }

  let commit = await probeOperationCommit(options.db, claim.operationId);
  const resumedAfterCommit = commit !== null;
  if (commit === null) {
    try {
      await options.execute(claim.operationId);
    } catch (error) {
      commit = await probeOperationCommit(options.db, claim.operationId);
      if (commit === null) {
        if (error instanceof ApiError && !error.retryable) {
          await abandonOwnedPendingClaim(options.db, claim);
        }
        throw error;
      }
    }
    commit = await probeOperationCommit(options.db, claim.operationId);
  }
  if (commit === null) throw new AtomicBatchRejectedError();

  await options.authorize();
  let readback: IdempotentReadback<T>;
  try {
    readback = await options.readback(claim.operationId, commit);
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const finalizedByPeer = await readFinalizedIdempotencyResponse<T>(options.db, claim.operationId);
      if (finalizedByPeer !== null) {
        return {
          ...(options.replay === undefined
            ? finalizedByPeer
            : await options.replay(finalizedByPeer)),
          idempotentReplay: true,
          operationId: claim.operationId,
        };
      }
    }
    throw error;
  }
  const finalized = await finalizeIdempotency(
    options.db,
    claim.operationId,
    readback,
    options.forbiddenPersistenceValues ?? [],
    options.now ?? Date.now(),
  );
  return {
    ...finalized,
    idempotentReplay: !claim.owned || resumedAfterCommit,
    operationId: claim.operationId,
  };
}
