import type { AcquiredPendingIntent } from "./api-core";
import type { InvitationResource, WriteResult } from "../types";

export const INVITATION_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export type InvitationRequestBody =
  | {
    grants: [{ project_id: string; role: "reader" | "writer" }];
    kind: "project_grant";
  }
  | {
    kind: "principal_recovery";
    principal_id: string;
    recovery_mode: "full_recovery" | "rotation";
  };

export type InvitationCreateResource = InvitationResource & (
  | { copy_text: string; invite_url: string; secret_available: true }
  | { secret_available: false }
);

export type InvitationCreateWriteResult = WriteResult<InvitationCreateResource> & {
  event_cursor: string;
  idempotent_replay: boolean;
};

interface InvitationRecoveryRecordBase {
  acquired_at: number;
  body: InvitationRequestBody;
  idempotency_key: string;
  marker: string;
  principal_id: string;
  version: 1;
}

export type InvitationRecoveryRecord = InvitationRecoveryRecordBase & (
  | { state: "pending" }
  | { invitation_id: string; state: "committed_unavailable" }
);

export interface InvitationFailureShape {
  code?: string;
  status: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export type InvitationRecoveryExclusiveLock = <T>(
  name: string,
  callback: () => Promise<T> | T,
) => Promise<T>;

export interface InvitationRecoveryLease {
  readonly record: InvitationRecoveryRecord;
  markCommittedUnavailable(invitationId: string): InvitationRecoveryRecord | null;
  settle(): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && timestampPattern.test(value)
    && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isInvitationRequestBody(value: unknown): value is InvitationRequestBody {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "project_grant") {
    if (!hasOnlyKeys(value, ["grants", "kind"]) || !Array.isArray(value.grants) || value.grants.length !== 1) {
      return false;
    }
    const grant = value.grants[0];
    return isRecord(grant)
      && hasOnlyKeys(grant, ["project_id", "role"])
      && typeof grant.project_id === "string"
      && grant.project_id.length > 0
      && (grant.role === "reader" || grant.role === "writer");
  }
  return value.kind === "principal_recovery"
    && hasOnlyKeys(value, ["kind", "principal_id", "recovery_mode"])
    && typeof value.principal_id === "string"
    && value.principal_id.length > 0
    && (value.recovery_mode === "rotation" || value.recovery_mode === "full_recovery");
}

function isInvitationGrant(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.display_name === "string"
    && isUuid(value.project_id)
    && typeof value.project_key === "string"
    && (value.role === "reader" || value.role === "writer")
    && typeof value.workspace_key === "string";
}

function isBoundPrincipal(value: unknown): boolean {
  return value === null || (
    isRecord(value)
    && typeof value.display_name === "string"
    && isUuid(value.principal_id)
  );
}

function isInvitationCreateResource(value: unknown): value is InvitationCreateResource {
  if (!isRecord(value)) return false;
  const commonFieldsAreValid = Array.isArray(value.allowed_actions)
    && value.allowed_actions.every((action) => action === "read" || action === "revoke")
    && new Set(value.allowed_actions).size === value.allowed_actions.length
    && isBoundPrincipal(value.bound_principal)
    && typeof value.code_fingerprint === "string"
    && /^cfi_v1_[A-Za-z0-9_-]{8}_…$/.test(value.code_fingerprint)
    && isTimestamp(value.created_at)
    && isNullableTimestamp(value.deleted_at)
    && isTimestamp(value.expires_at)
    && Array.isArray(value.grants)
    && value.grants.every(isInvitationGrant)
    && isUuid(value.id)
    && (value.kind === "project_grant" || value.kind === "principal_recovery")
    && (value.recovery_mode === null || value.recovery_mode === "rotation" || value.recovery_mode === "full_recovery")
    && isNullableTimestamp(value.redeemed_at)
    && isNullableUuid(value.redeemed_by_principal_id)
    && isNullableTimestamp(value.revoked_at)
    && (value.status === "active" || value.status === "expired" || value.status === "redeemed" || value.status === "revoked")
    && isTimestamp(value.updated_at)
    && Number.isSafeInteger(value.version)
    && Number(value.version) >= 1;
  if (!commonFieldsAreValid) return false;
  const grantCount = Array.isArray(value.grants) ? value.grants.length : -1;
  if (value.kind === "project_grant") {
    if (value.bound_principal !== null || value.recovery_mode !== null || grantCount === 0) return false;
  } else if (value.bound_principal === null || value.recovery_mode === null || grantCount !== 0) {
    return false;
  }
  if (value.secret_available === true) {
    return typeof value.copy_text === "string"
      && value.copy_text.length > 0
      && isHttpsUrl(value.invite_url);
  }
  return value.secret_available === false
    && !("copy_text" in value)
    && !("invite_url" in value);
}

export function isInvitationCreateWriteResult(value: unknown): value is InvitationCreateWriteResult {
  return isRecord(value)
    && typeof value.event_cursor === "string"
    && value.event_cursor.length > 0
    && typeof value.idempotent_replay === "boolean"
    && isInvitationCreateResource(value.resource)
    && value.idempotent_replay === !value.resource.secret_available;
}

export function invitationOutcomeRequiresReview(failure: InvitationFailureShape | null): boolean {
  if (failure === null) return true;
  return failure.code === "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED"
    || failure.status === 0
    || failure.status === 401
    || failure.status === 403
    || failure.status >= 500;
}

export function invitationRecoveryCanRetry(
  record: InvitationRecoveryRecord,
  now = Date.now(),
): boolean {
  return record.state === "pending"
    && now < record.acquired_at + INVITATION_RECOVERY_TTL_MS;
}

export function canConfirmInvitationReview(
  readbackReady: boolean,
  hasMore: boolean,
  recoveryRecord: InvitationRecoveryRecord | null = null,
  reviewStartedAt: number | null = null,
  now = Date.now(),
  committedInvitationResolved = false,
): boolean {
  return readbackReady
    && !hasMore
    && (recoveryRecord === null
      || (recoveryRecord.state === "pending"
        && reviewStartedAt !== null
        && reviewStartedAt >= recoveryRecord.acquired_at + INVITATION_RECOVERY_TTL_MS
        && !invitationRecoveryCanRetry(recoveryRecord, now))
      || (recoveryRecord.state === "committed_unavailable"
        && reviewStartedAt !== null
        && committedInvitationResolved));
}

function parseInvitationRecoveryRecord(value: unknown, principalId: string): InvitationRecoveryRecord | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "acquired_at", "body", "idempotency_key", "invitation_id", "marker", "principal_id", "state", "version",
    ])
    || value.version !== 1
    || value.principal_id !== principalId
    || !Number.isSafeInteger(value.acquired_at)
    || Number(value.acquired_at) < 0
    || typeof value.idempotency_key !== "string"
    || value.idempotency_key.length === 0
    || typeof value.marker !== "string"
    || value.marker.length === 0
    || !isInvitationRequestBody(value.body)) return null;
  if (value.state === "pending" && !("invitation_id" in value)) {
    return value as unknown as InvitationRecoveryRecord;
  }
  if (value.state !== "committed_unavailable"
    || typeof value.invitation_id !== "string"
    || value.invitation_id.length === 0) return null;
  return value as unknown as InvitationRecoveryRecord;
}

function sameInvitationRecoveryState(
  current: InvitationRecoveryRecord,
  expected: InvitationRecoveryRecord,
): boolean {
  if (current.marker !== expected.marker || current.state !== expected.state) return false;
  return current.state === "pending"
    || (expected.state === "committed_unavailable" && current.invitation_id === expected.invitation_id);
}

export class InvitationRecoveryBlockedError extends Error {
  readonly record: InvitationRecoveryRecord;

  constructor(record: InvitationRecoveryRecord) {
    super("Another Invitation operation still requires recovery.");
    this.name = "InvitationRecoveryBlockedError";
    this.record = record;
  }
}

export class InvitationRecoveryCoordinator {
  readonly storageKey: string;
  readonly #createMarker: () => string;
  readonly #runExclusive: InvitationRecoveryExclusiveLock;
  readonly #principalId: string;
  readonly #storage: StorageLike;

  constructor(
    principalId: string,
    storage: StorageLike,
    runExclusive: InvitationRecoveryExclusiveLock,
    createMarker: () => string = () => crypto.randomUUID(),
  ) {
    this.#createMarker = createMarker;
    this.#principalId = principalId;
    this.#runExclusive = runExclusive;
    this.#storage = storage;
    this.storageKey = `cfkanban.invitation-recovery.owner.${principalId}`;
  }

  read(): InvitationRecoveryRecord | null {
    const serialized = this.#storage.getItem(this.storageKey);
    if (serialized === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new Error("The shared Invitation recovery record is invalid.");
    }
    const record = parseInvitationRecoveryRecord(value, this.#principalId);
    if (record === null) throw new Error("The shared Invitation recovery record is invalid.");
    return record;
  }

  readStorageValue(serialized: string | null): InvitationRecoveryRecord | null {
    if (serialized === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      return null;
    }
    return parseInvitationRecoveryRecord(value, this.#principalId);
  }

  #beginUnlocked(intent: AcquiredPendingIntent, body: InvitationRequestBody): InvitationRecoveryRecord {
    const existing = this.read();
    if (existing !== null) throw new InvitationRecoveryBlockedError(existing);
    const record: InvitationRecoveryRecord = {
      acquired_at: intent.acquiredAt,
      body: structuredClone(body),
      idempotency_key: intent.key,
      marker: this.#createMarker(),
      principal_id: this.#principalId,
      state: "pending",
      version: 1,
    };
    this.#storage.setItem(this.storageKey, JSON.stringify(record));
    return record;
  }

  #markCommittedUnavailableUnlocked(
    record: InvitationRecoveryRecord,
    invitationId: string,
  ): InvitationRecoveryRecord | null {
    const current = this.read();
    if (current === null || !sameInvitationRecoveryState(current, record)) {
      return null;
    }
    if (current.state === "committed_unavailable") {
      return current.invitation_id === invitationId ? current : null;
    }
    const committed: InvitationRecoveryRecord = {
      ...current,
      invitation_id: invitationId,
      state: "committed_unavailable",
    };
    this.#storage.setItem(this.storageKey, JSON.stringify(committed));
    return committed;
  }

  #settleUnlocked(record: InvitationRecoveryRecord): boolean {
    const current = this.read();
    if (current === null || !sameInvitationRecoveryState(current, record)) {
      return false;
    }
    this.#storage.removeItem(this.storageKey);
    return true;
  }

  #lease(initialRecord: InvitationRecoveryRecord): InvitationRecoveryLease {
    let expected = initialRecord;
    return {
      get record() {
        return expected;
      },
      markCommittedUnavailable: (invitationId) => {
        const committed = this.#markCommittedUnavailableUnlocked(expected, invitationId);
        if (committed !== null) expected = committed;
        return committed;
      },
      settle: () => this.#settleUnlocked(expected),
    };
  }

  async runNewOperation<T>(
    intent: AcquiredPendingIntent,
    body: InvitationRequestBody,
    callback: (lease: InvitationRecoveryLease) => Promise<T>,
  ): Promise<T> {
    // Keep the origin-wide lock for the complete request lifetime. A list
    // readback must not retire this record while the original POST can still
    // commit after its fixed 24-hour recovery deadline.
    return this.#runExclusive(this.storageKey, async () => {
      const record = this.#beginUnlocked(intent, body);
      return callback(this.#lease(record));
    });
  }

  async runExistingOperation<T>(
    record: InvitationRecoveryRecord,
    callback: (lease: InvitationRecoveryLease) => Promise<T>,
  ): Promise<T> {
    return this.#runExclusive(this.storageKey, async () => {
      const current = this.read();
      if (current === null) {
        throw new Error("The shared Invitation recovery operation is no longer available.");
      }
      if (!sameInvitationRecoveryState(current, record)) {
        throw new InvitationRecoveryBlockedError(current);
      }
      return callback(this.#lease(current));
    });
  }

  async begin(intent: AcquiredPendingIntent, body: InvitationRequestBody): Promise<InvitationRecoveryRecord> {
    return this.#runExclusive(this.storageKey, () => this.#beginUnlocked(intent, body));
  }

  async markCommittedUnavailable(
    record: InvitationRecoveryRecord,
    invitationId: string,
  ): Promise<InvitationRecoveryRecord | null> {
    return this.#runExclusive(
      this.storageKey,
      () => this.#markCommittedUnavailableUnlocked(record, invitationId),
    );
  }

  async settle(record: InvitationRecoveryRecord): Promise<boolean> {
    return this.#runExclusive(this.storageKey, () => this.#settleUnlocked(record));
  }
}
