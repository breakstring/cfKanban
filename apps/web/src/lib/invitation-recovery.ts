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
  review_revision: number;
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
  retainPendingAfterUncertainResult(): InvitationRecoveryRecord | null;
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
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = timestampPattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1
    || month < 1 || month > 12
    || hour > 23
    || minute > 59
    || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && daysInMonth !== undefined && day <= daysInMonth;
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

function isInvitationCreateResource(
  value: unknown,
  expectedBody: InvitationRequestBody,
): value is InvitationCreateResource {
  if (!isRecord(value)) return false;
  const allowedActions = value.allowed_actions;
  const createdAt = value.created_at;
  const expiresAt = value.expires_at;
  const grants = value.grants;
  const updatedAt = value.updated_at;
  const version = value.version;
  if (!Array.isArray(allowedActions)
    || !allowedActions.every((action) => action === "read" || action === "revoke")
    || new Set(allowedActions).size !== allowedActions.length
    || !isBoundPrincipal(value.bound_principal)
    || typeof value.code_fingerprint !== "string"
    || !/^cfi_v1_[A-Za-z0-9_-]{8}_…$/.test(value.code_fingerprint)
    || !isTimestamp(createdAt)
    || !isNullableTimestamp(value.deleted_at)
    || !isTimestamp(expiresAt)
    || !Array.isArray(grants)
    || !grants.every(isInvitationGrant)
    || !isUuid(value.id)
    || (value.kind !== "project_grant" && value.kind !== "principal_recovery")
    || (value.recovery_mode !== null && value.recovery_mode !== "rotation" && value.recovery_mode !== "full_recovery")
    || !isNullableTimestamp(value.redeemed_at)
    || !isNullableUuid(value.redeemed_by_principal_id)
    || !isNullableTimestamp(value.revoked_at)
    || (value.status !== "active" && value.status !== "expired" && value.status !== "redeemed" && value.status !== "revoked")
    || !isTimestamp(updatedAt)
    || !Number.isSafeInteger(version)
    || Number(version) < 1
    || value.status !== "active"
    || value.deleted_at !== null
    || value.redeemed_at !== null
    || value.redeemed_by_principal_id !== null
    || value.revoked_at !== null
    || version !== 1
    || updatedAt !== createdAt
    || Date.parse(expiresAt) <= Date.parse(createdAt)
    || allowedActions.length !== 2
    || allowedActions[0] !== "read"
    || allowedActions[1] !== "revoke") return false;
  const grantCount = grants.length;
  if (expectedBody.kind === "project_grant") {
    const expectedGrant = expectedBody.grants[0];
    const actualGrant = grants[0];
    if (value.kind !== "project_grant"
      || value.bound_principal !== null
      || value.recovery_mode !== null
      || grantCount !== 1
      || !isRecord(actualGrant)
      || actualGrant.project_id !== expectedGrant.project_id
      || actualGrant.role !== expectedGrant.role) return false;
  } else {
    if (value.kind !== "principal_recovery"
      || !isRecord(value.bound_principal)
      || value.bound_principal.principal_id !== expectedBody.principal_id
      || value.recovery_mode !== expectedBody.recovery_mode
      || grantCount !== 0) return false;
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

export function isInvitationCreateWriteResult(
  value: unknown,
  expectedBody: InvitationRequestBody,
): value is InvitationCreateWriteResult {
  return isRecord(value)
    && typeof value.event_cursor === "string"
    && value.event_cursor.length > 0
    && typeof value.idempotent_replay === "boolean"
    && isInvitationCreateResource(value.resource, expectedBody)
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
      "acquired_at", "body", "idempotency_key", "invitation_id", "marker", "principal_id", "review_revision", "state", "version",
    ])
    || value.version !== 1
    || value.principal_id !== principalId
    || !Number.isSafeInteger(value.acquired_at)
    || Number(value.acquired_at) < 0
    || typeof value.idempotency_key !== "string"
    || value.idempotency_key.length === 0
    || typeof value.marker !== "string"
    || value.marker.length === 0
    || ("review_revision" in value
      && (!Number.isSafeInteger(value.review_revision) || Number(value.review_revision) < 0))
    || !isInvitationRequestBody(value.body)) return null;
  const normalized = {
    ...value,
    // Records created before request-lifetime fencing did not persist a
    // revision. Treat them as revision zero so an upgrade keeps the exact
    // body/key recovery path instead of silently abandoning it.
    review_revision: "review_revision" in value ? Number(value.review_revision) : 0,
  };
  if (value.state === "pending" && !("invitation_id" in value)) {
    return normalized as unknown as InvitationRecoveryRecord;
  }
  if (value.state !== "committed_unavailable"
    || typeof value.invitation_id !== "string"
    || value.invitation_id.length === 0) return null;
  return normalized as unknown as InvitationRecoveryRecord;
}

function sameInvitationRecoveryState(
  current: InvitationRecoveryRecord,
  expected: InvitationRecoveryRecord,
): boolean {
  if (current.marker !== expected.marker
    || current.review_revision !== expected.review_revision
    || current.state !== expected.state) return false;
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

export class InvitationRecoveryExpiredError extends Error {
  constructor() {
    super("The safe Invitation recovery window has expired.");
    this.name = "InvitationRecoveryExpiredError";
  }
}

export class InvitationRecoveryCoordinator {
  readonly storageKey: string;
  readonly #createMarker: () => string;
  readonly #now: () => number;
  readonly #runExclusive: InvitationRecoveryExclusiveLock;
  readonly #principalId: string;
  readonly #storage: StorageLike;

  constructor(
    principalId: string,
    storage: StorageLike,
    runExclusive: InvitationRecoveryExclusiveLock,
    createMarker: () => string = () => crypto.randomUUID(),
    now: () => number = Date.now,
  ) {
    this.#createMarker = createMarker;
    this.#now = now;
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
      review_revision: 0,
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
    if (current === null
      || !sameInvitationRecoveryState(current, record)
      || current.review_revision >= Number.MAX_SAFE_INTEGER) {
      return null;
    }
    if (current.state === "committed_unavailable") {
      return current.invitation_id === invitationId ? current : null;
    }
    const committed: InvitationRecoveryRecord = {
      ...current,
      invitation_id: invitationId,
      review_revision: current.review_revision + 1,
      state: "committed_unavailable",
    };
    this.#storage.setItem(this.storageKey, JSON.stringify(committed));
    return committed;
  }

  #retainPendingAfterUncertainResultUnlocked(
    record: InvitationRecoveryRecord,
  ): InvitationRecoveryRecord | null {
    const current = this.read();
    if (current === null
      || current.state !== "pending"
      || !sameInvitationRecoveryState(current, record)
      || current.review_revision >= Number.MAX_SAFE_INTEGER) {
      return null;
    }
    const retained: InvitationRecoveryRecord = {
      ...current,
      review_revision: current.review_revision + 1,
    };
    this.#storage.setItem(this.storageKey, JSON.stringify(retained));
    return retained;
  }

  #prepareReviewUnlocked(record: InvitationRecoveryRecord): InvitationRecoveryRecord {
    const current = this.read();
    if (current === null) {
      throw new Error("The shared Invitation recovery operation is no longer available.");
    }
    if (!sameInvitationRecoveryState(current, record)) {
      throw new InvitationRecoveryBlockedError(current);
    }
    if (invitationRecoveryCanRetry(current, this.#now())) {
      throw new InvitationRecoveryBlockedError(current);
    }
    if (current.review_revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("The shared Invitation recovery revision is exhausted.");
    }
    // Persist a new review generation only after acquiring the same lock that
    // covers the complete POST lifetime. The first list request can therefore
    // begin only after every live request lease has ended, including when an
    // old page is terminated without running its Promise catch handler.
    const prepared: InvitationRecoveryRecord = {
      ...current,
      review_revision: current.review_revision + 1,
    };
    this.#storage.setItem(this.storageKey, JSON.stringify(prepared));
    return prepared;
  }

  #settleUnlocked(record: InvitationRecoveryRecord): boolean {
    const current = this.read();
    if (current === null || !sameInvitationRecoveryState(current, record)) {
      return false;
    }
    const serialized = this.#storage.getItem(this.storageKey);
    let persistedRevision = false;
    if (serialized !== null) {
      try {
        const raw = JSON.parse(serialized) as unknown;
        persistedRevision = isRecord(raw) && "review_revision" in raw;
      } catch {
        return false;
      }
    }
    if (!persistedRevision) {
      // A pre-fencing tab may still own the old request lease and will not
      // advance review_revision on an uncertain terminal result. The first
      // post-upgrade settlement therefore migrates under the same origin-wide
      // lock and deliberately fails, invalidating every list snapshot that
      // began while legacy code could still commit.
      const migrated: InvitationRecoveryRecord = {
        ...current,
        review_revision: current.review_revision + 1,
      };
      this.#storage.setItem(this.storageKey, JSON.stringify(migrated));
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
      retainPendingAfterUncertainResult: () => {
        const retained = this.#retainPendingAfterUncertainResultUnlocked(expected);
        if (retained !== null) expected = retained;
        return retained;
      },
      settle: () => this.#settleUnlocked(expected),
    };
  }

  async runNewOperation<T>(
    acquireIntent: () => AcquiredPendingIntent,
    body: InvitationRequestBody,
    callback: (lease: InvitationRecoveryLease, intent: AcquiredPendingIntent) => Promise<T>,
  ): Promise<T> {
    // Keep the origin-wide lock for the complete request lifetime. A list
    // readback must not retire this record while the original POST can still
    // commit after its fixed 24-hour recovery deadline.
    return this.#runExclusive(this.storageKey, async () => {
      const existing = this.read();
      if (existing !== null) throw new InvitationRecoveryBlockedError(existing);
      // Acquire the local key only after the origin-wide lock is held. A tab
      // may wait behind another request for longer than the fixed 24-hour
      // window; an unsent key must start its deadline at the real send edge.
      const intent = acquireIntent();
      const record = this.#beginUnlocked(intent, body);
      return callback(this.#lease(record), intent);
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
      // The caller may have queued this retry before the fixed deadline and
      // waited behind another tab's request lease. Recheck only after the lock
      // is actually acquired so an expired D1 idempotency row is never reused
      // as though it were still an exact replay.
      if (!invitationRecoveryCanRetry(current, this.#now())) {
        throw new InvitationRecoveryExpiredError();
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

  async prepareReview(record: InvitationRecoveryRecord): Promise<InvitationRecoveryRecord> {
    return this.#runExclusive(this.storageKey, () => this.#prepareReviewUnlocked(record));
  }

  async settle(record: InvitationRecoveryRecord): Promise<boolean> {
    return this.#runExclusive(this.storageKey, () => this.#settleUnlocked(record));
  }
}
