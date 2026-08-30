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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "display_name", "project_id", "project_key", "role", "workspace_key",
  ])) return false;
  return typeof value.display_name === "string"
    && typeof value.project_id === "string"
    && typeof value.project_key === "string"
    && (value.role === "reader" || value.role === "writer")
    && typeof value.workspace_key === "string";
}

function isBoundPrincipal(value: unknown): boolean {
  return value === null || (
    isRecord(value)
    && hasOnlyKeys(value, ["display_name", "principal_id"])
    && typeof value.display_name === "string"
    && typeof value.principal_id === "string"
  );
}

function isInvitationCreateResource(value: unknown): value is InvitationCreateResource {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "allowed_actions",
    "bound_principal",
    "code_fingerprint",
    "copy_text",
    "created_at",
    "deleted_at",
    "expires_at",
    "grants",
    "id",
    "invite_url",
    "kind",
    "recovery_mode",
    "redeemed_at",
    "redeemed_by_principal_id",
    "revoked_at",
    "secret_available",
    "status",
    "updated_at",
    "version",
  ])) return false;
  const commonFieldsAreValid = Array.isArray(value.allowed_actions)
    && value.allowed_actions.every((action) => typeof action === "string")
    && isBoundPrincipal(value.bound_principal)
    && typeof value.code_fingerprint === "string"
    && typeof value.created_at === "string"
    && isNullableString(value.deleted_at)
    && typeof value.expires_at === "string"
    && Array.isArray(value.grants)
    && value.grants.every(isInvitationGrant)
    && typeof value.id === "string"
    && (value.kind === "project_grant" || value.kind === "principal_recovery")
    && (value.recovery_mode === null || value.recovery_mode === "rotation" || value.recovery_mode === "full_recovery")
    && isNullableString(value.redeemed_at)
    && isNullableString(value.redeemed_by_principal_id)
    && isNullableString(value.revoked_at)
    && (value.status === "active" || value.status === "expired" || value.status === "redeemed" || value.status === "revoked")
    && typeof value.updated_at === "string"
    && Number.isSafeInteger(value.version)
    && Number(value.version) >= 1;
  if (!commonFieldsAreValid) return false;
  if (value.secret_available === true) {
    return typeof value.copy_text === "string"
      && value.copy_text.length > 0
      && typeof value.invite_url === "string"
      && value.invite_url.length > 0;
  }
  return value.secret_available === false
    && !("copy_text" in value)
    && !("invite_url" in value);
}

export function isInvitationCreateWriteResult(value: unknown): value is InvitationCreateWriteResult {
  return isRecord(value)
    && hasOnlyKeys(value, ["event_cursor", "idempotent_replay", "resource"])
    && typeof value.event_cursor === "string"
    && typeof value.idempotent_replay === "boolean"
    && isInvitationCreateResource(value.resource);
}

export function invitationOutcomeRequiresReview(failure: InvitationFailureShape | null): boolean {
  if (failure === null) return true;
  return failure.code === "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED"
    || failure.status === 0
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
  now = Date.now(),
  committedInvitationResolved = false,
): boolean {
  return readbackReady
    && !hasMore
    && (recoveryRecord === null
      || (recoveryRecord.state === "pending" && !invitationRecoveryCanRetry(recoveryRecord, now))
      || (recoveryRecord.state === "committed_unavailable" && committedInvitationResolved));
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
  readonly #principalId: string;
  readonly #storage: StorageLike;

  constructor(
    principalId: string,
    storage: StorageLike,
    createMarker: () => string = () => crypto.randomUUID(),
  ) {
    this.#createMarker = createMarker;
    this.#principalId = principalId;
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

  begin(intent: AcquiredPendingIntent, body: InvitationRequestBody): InvitationRecoveryRecord {
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

  markCommittedUnavailable(
    record: InvitationRecoveryRecord,
    invitationId: string,
  ): InvitationRecoveryRecord | null {
    const current = this.read();
    if (current === null || current.marker !== record.marker) return null;
    const committed: InvitationRecoveryRecord = {
      ...current,
      invitation_id: invitationId,
      state: "committed_unavailable",
    };
    this.#storage.setItem(this.storageKey, JSON.stringify(committed));
    return committed;
  }

  settle(record: InvitationRecoveryRecord): boolean {
    const current = this.read();
    if (current === null || current.marker !== record.marker) return false;
    this.#storage.removeItem(this.storageKey);
    return true;
  }
}
