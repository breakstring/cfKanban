import type { CredentialResource, ListResult, WriteResult } from "../types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIRING_FIELDS = ["instance_id", "principal_id", "credential_id", "token_prefix", "token_digest", "device_name", "issued_at", "expires_at", "api_origin", "operation_id", "idempotency_key"];
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OwnerDeviceIdentity {
  instanceId: string;
  principalId: string;
  displayName: string;
  origin: string;
  version: number;
}

export interface OwnerDevicePairing {
  instance_id: string;
  principal_id: string;
  credential_id: string;
  token_prefix: string;
  token_digest: string;
  device_name: string;
  issued_at: string;
  expires_at: string;
  api_origin: string;
  operation_id: string;
  idempotency_key: string;
}

type DeviceBody = Pick<OwnerDevicePairing, "instance_id" | "principal_id" | "credential_id" | "token_prefix" | "token_digest" | "device_name" | "issued_at" | "expires_at"> & { expected_version: number };
export interface OwnerDeviceAttempt {
  readonly kind: "approve" | "revoke" | "rename";
  readonly path: string;
  readonly body: Readonly<DeviceBody | { expected_version: number } | { device_name: string; expected_version: number }>;
  readonly key: string;
  readonly startedAt: number;
  readonly credentialId: string;
  readonly principalId: string;
  readonly fingerprint: string;
  readonly deviceName: string | null;
}

export class OwnerDeviceInputError extends Error {
  readonly code: "invalid" | "name" | "target" | "expired" | "identity";
  constructor(code: OwnerDeviceInputError["code"]) {
    super(code);
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function utc(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; }
}

export function ownerDeviceIdentity(meta: unknown, me: unknown, origin: string, principalId: string): OwnerDeviceIdentity {
  if (!record(meta) || !record(me) || !record(meta.principal) || !uuid(meta.instance_id)
    || !canonicalOrigin(origin) || meta.observed_origin !== origin || meta.preferred_api_origin !== origin
    || meta.principal.id !== principalId || meta.principal.is_owner !== true || me.id !== principalId
    || me.principal_id !== principalId || me.is_owner !== true || typeof me.display_name !== "string"
    || typeof me.version !== "number" || !Number.isSafeInteger(me.version) || me.version < 1) {
    throw new OwnerDeviceInputError("identity");
  }
  return { instanceId: meta.instance_id, principalId, displayName: me.display_name, origin, version: me.version };
}

export function parseOwnerDevicePairing(text: string, identity: OwnerDeviceIdentity, now = Date.now()): OwnerDevicePairing {
  if (text.length > 8192 || /cf[kil]_v1_/i.test(text)) throw new OwnerDeviceInputError("invalid");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OwnerDeviceInputError("invalid"); }
  if (!record(value) || Object.keys(value).length !== PAIRING_FIELDS.length || Object.keys(value).some(key => !PAIRING_FIELDS.includes(key))
    || !uuid(value.instance_id) || !uuid(value.principal_id) || !uuid(value.credential_id) || value.credential_id[14] !== "4" || !uuid(value.operation_id)
    || typeof value.token_prefix !== "string" || !/^[a-f0-9]{16}$/.test(value.token_prefix)
    || typeof value.token_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.token_digest)
    || typeof value.device_name !== "string" || value.device_name.trim() !== value.device_name || !value.device_name.length
    || [...value.device_name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(value.device_name) || /cf[kil]_v1_/i.test(value.device_name) || value.device_name.includes(value.token_digest)
    || !utc(value.issued_at) || !utc(value.expires_at) || !canonicalOrigin(value.api_origin)
    || typeof value.idempotency_key !== "string" || !/^[\x20-\x7E]{1,128}$/.test(value.idempotency_key) || /cf[kil]_v1_/i.test(value.idempotency_key)) {
    throw new OwnerDeviceInputError("invalid");
  }
  if (value.api_origin !== identity.origin || value.instance_id !== identity.instanceId || value.principal_id !== identity.principalId) throw new OwnerDeviceInputError("target");
  const issued = Date.parse(value.issued_at), expires = Date.parse(value.expires_at);
  if (expires <= issued || expires - issued > 3_600_000) throw new OwnerDeviceInputError("invalid");
  if (issued > now || expires <= now) throw new OwnerDeviceInputError("expired");
  return Object.freeze(value) as unknown as OwnerDevicePairing;
}

export function isOwnerDeviceList(value: unknown, principalId: string): value is ListResult<CredentialResource> {
  return record(value) && Array.isArray(value.items) && typeof value.has_more === "boolean"
    && (value.has_more ? typeof value.next_cursor === "string" && value.next_cursor.length > 0 : value.next_cursor === null)
    && value.items.every(item => record(item) && uuid(item.id) && item.principal_id === principalId
      && typeof item.fingerprint === "string" && /^cfk_v1_[a-f0-9]{16}_…$/.test(item.fingerprint)
      && (item.device_name === null || typeof item.device_name === "string") && utc(item.issued_at)
      && (item.last_used_at === null || utc(item.last_used_at)) && (item.revoked_at === null || utc(item.revoked_at))
      && Array.isArray(item.allowed_actions) && item.allowed_actions.every(action => typeof action === "string"));
}

export function approveOwnerDeviceAttempt(request: OwnerDevicePairing, identity: OwnerDeviceIdentity, key = request.idempotency_key, now = Date.now()): OwnerDeviceAttempt {
  // Recheck the exact reviewed request at submission, including its lifetime.
  parseOwnerDevicePairing(JSON.stringify(request), identity, now);
  const { instance_id, principal_id, credential_id, token_prefix, token_digest, device_name, issued_at, expires_at } = request;
  return Object.freeze({ kind: "approve", path: "/api/v1/admin/owner-credentials/add-device", key, startedAt: now,
    credentialId: credential_id, principalId: principal_id, fingerprint: `cfk_v1_${token_prefix}_…`, deviceName: device_name,
    body: Object.freeze({ instance_id, principal_id, credential_id, token_prefix, token_digest, device_name, issued_at, expires_at, expected_version: identity.version }) });
}

export function revokeOwnerDeviceAttempt(device: CredentialResource, identity: OwnerDeviceIdentity, key: string, now = Date.now()): OwnerDeviceAttempt {
  if (device.principal_id !== identity.principalId || device.revoked_at !== null || !device.allowed_actions.includes("revoke_owner_device")) throw new OwnerDeviceInputError("target");
  return Object.freeze({ kind: "revoke", path: `/api/v1/admin/owner-credentials/${device.id}/revoke`, key, startedAt: now,
    credentialId: device.id, principalId: identity.principalId, fingerprint: device.fingerprint, deviceName: device.device_name ?? null,
    body: Object.freeze({ expected_version: identity.version }) });
}

export function renameOwnerDeviceAttempt(device: CredentialResource, name: string, identity: OwnerDeviceIdentity, key: string, now = Date.now()): OwnerDeviceAttempt {
  if (!uuid(device.id) || device.principal_id !== identity.principalId || device.revoked_at !== null || !device.allowed_actions.includes("rename_owner_device")) throw new OwnerDeviceInputError("target");
  const deviceName = name.trim();
  if (!deviceName || [...deviceName].length > 80 || /[\p{Cc}\p{Cf}]/u.test(deviceName) || /cf[kil]_v1_/i.test(deviceName)) throw new OwnerDeviceInputError("name");
  return Object.freeze({ kind: "rename", path: `/api/v1/admin/owner-credentials/${device.id}/rename`, key, startedAt: now,
    credentialId: device.id, principalId: identity.principalId, fingerprint: device.fingerprint, deviceName,
    body: Object.freeze({ device_name: deviceName, expected_version: identity.version }) });
}

export function ownerDeviceRetryAllowed(attempt: OwnerDeviceAttempt, now = Date.now()): boolean {
  return now < attempt.startedAt + RETRY_WINDOW_MS;
}

export function isOwnerDeviceWriteResult(value: unknown, attempt: OwnerDeviceAttempt): value is WriteResult<Record<string, unknown>> {
  if (!record(value) || typeof value.event_cursor !== "string" || !value.event_cursor.length || typeof value.idempotent_replay !== "boolean" || !record(value.resource)) return false;
  const device = value.resource;
  return device.id === attempt.credentialId && device.principal_id === attempt.principalId
    && device.fingerprint === attempt.fingerprint && device.device_name === attempt.deviceName
    && device.principal_version === attempt.body.expected_version + 1
    && (attempt.kind === "revoke" ? utc(device.revoked_at) && device.revoke_reason === "owner_device_revoke" : device.revoked_at === null);
}

export function ownerDeviceVersionConflict(error: unknown): boolean {
  return record(error) && error.status === 409 && record(error.body) && error.body.source === "service"
    && error.body.code === "VERSION_CONFLICT" && error.body.retryable === false
    && record(error.body.details) && error.body.details.normalized_by !== "client";
}

export function ownerDeviceNameRejected(error: unknown): boolean {
  return record(error) && error.status === 400 && record(error.body) && error.body.source === "service"
    && error.body.code === "VALIDATION_ERROR" && error.body.retryable === false
    && record(error.body.details) && error.body.details.normalized_by !== "client"
    && error.body.details.reason === "invalid_device_name";
}
