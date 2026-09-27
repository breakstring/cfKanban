import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { fetchDiscovery, validateDiscovery } from "./rebind.mjs";
import {
  createPendingCredential, credentialMetadataView, getInstancePaths, initializeStateRoot,
  loadCurrentCredentialSecret, loadPendingCredentialSecret, promotePendingCredential,
  putInstanceMetadata, validatePrivatePath,
} from "./state.mjs";
import { trustedApiRequest } from "./transport.mjs";
import {
  assertNoSymlinkPath, atomicWriteJson, canonicalDigest, ensurePrivateDirectory,
  pathType, readJson, requireHttpsOrigin, requireString, requireUuid, sha256Text,
} from "./utils.mjs";

const PURPOSE = "owner_device";
const REQUEST_FIELDS = ["instance_id", "principal_id", "credential_id", "token_prefix", "token_digest", "device_name", "issued_at", "expires_at"];
const ENVELOPE_FIELDS = [...REQUEST_FIELDS, "api_origin", "operation_id", "idempotency_key"];
const fail = (code, message) => { throw toolError(code, message); };
const currentTime = (input) => input.now ?? Date.now();
const inputOptions = (input) => ({ ...input, stateRoot: input.stateRoot ?? resolveStateRoot() });
const boundedFetch = (input) => (url, options = {}) => (input.fetchImpl ?? globalThis.fetch)(url, { ...options, signal: options.signal ?? AbortSignal.timeout(15_000) });

function redact(value, token = null) {
  if (typeof value === "string") {
    const safe = token ? value.replaceAll(token, "[REDACTED]") : value;
    return safe.replace(/cfk_v1_[0-9a-f]{16}_[A-Za-z0-9_-]{32,}/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, token));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, token)]));
  return value;
}

function deviceName(value) {
  const name = requireString(value, "device_name", { max: 320 }).trim();
  if ([...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name) || /cf[kil]_v1_/i.test(name)) fail("INVALID_OWNER_DEVICE_REQUEST", "Device name must contain 1–80 characters without control characters or Credential tokens");
  return name;
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !ENVELOPE_FIELDS.includes(key))) fail("INVALID_OWNER_DEVICE_REQUEST", "Pairing request must contain only the documented public fields");
  const request = {
    instance_id: requireUuid(value.instance_id, "instance_id"), principal_id: requireUuid(value.principal_id, "principal_id"),
    credential_id: requireUuid(value.credential_id, "credential_id"), token_prefix: value.token_prefix, token_digest: value.token_digest,
    device_name: deviceName(value.device_name), issued_at: value.issued_at, expires_at: value.expires_at,
    api_origin: requireHttpsOrigin(value.api_origin, "api_origin"), operation_id: requireUuid(value.operation_id, "operation_id"),
    idempotency_key: requireString(value.idempotency_key, "idempotency_key", { max: 128 }),
  };
  if (typeof request.token_prefix !== "string" || typeof request.token_digest !== "string" || !/^[0-9a-f]{16}$/.test(request.token_prefix) || !/^[0-9a-f]{64}$/.test(request.token_digest) || request.credential_id[14] !== "4") fail("INVALID_OWNER_DEVICE_REQUEST", "Pairing request must contain an exact Credential ID, token prefix and SHA-256 digest");
  const issued = Date.parse(request.issued_at), expires = Date.parse(request.expires_at);
  if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || new Date(issued).toISOString() !== request.issued_at || new Date(expires).toISOString() !== request.expires_at || expires <= issued || expires - issued > 3_600_000) fail("INVALID_OWNER_DEVICE_REQUEST", "Pairing request validity must be a UTC interval of at most one hour");
  if (request.device_name.includes(request.token_digest)) fail("INVALID_OWNER_DEVICE_REQUEST", "Device name must not repeat the Credential digest");
  return request;
}

function requestView(request, state, now) {
  return { pairing_request: request, credential: { state, credential_id: request.credential_id, principal_id: request.principal_id, fingerprint: `cfk_v1_${request.token_prefix}_…`, secret_values_exposed: false }, expired: Date.parse(request.expires_at) <= now, secret_values_exposed: false };
}

async function privatePaths(input, initialize = false) {
  const paths = getInstancePaths(input);
  if (initialize) await initializeStateRoot(input);
  await validatePrivatePath(input.stateRoot, "directory");
  await assertNoSymlinkPath(paths.credentialsRoot, input.stateRoot);
  if (initialize) await ensurePrivateDirectory(paths.credentialsRoot);
  for (const directory of [path.join(input.stateRoot, "instances"), paths.instanceRoot, paths.credentialsRoot]) await validatePrivatePath(directory, "directory");
  for (const file of [paths.instanceMetadata, paths.currentMetadata, paths.currentSecret, paths.pendingMetadata, paths.pendingSecret]) {
    await assertNoSymlinkPath(file, input.stateRoot);
    if (await pathType(file) !== "missing") await validatePrivatePath(file, "file");
  }
  return paths;
}

async function withLock(input, callback, initialize = false) {
  const paths = await privatePaths(input, initialize);
  const lockPath = path.join(paths.credentialsRoot, "owner-devices.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { fail("OWNER_DEVICE_LOCKED", "Another device operation may be running; verify that it stopped before removing its private lock"); }
  try { return await callback(paths); }
  finally { await lock.close(); await rm(lockPath); }
}

async function instanceMetadata(input, paths) {
  const instance = await readJson(paths.instanceMetadata);
  if (instance?.instance_id !== input.instanceId) fail("STATE_INSTANCE_CONFLICT", "Trusted instance metadata does not match the selected instance");
  requireHttpsOrigin(instance.trusted_api_origin, "trusted_api_origin");
  return instance;
}

async function discoveryAt(input, origin, instance) {
  const discovery = validateDiscovery(await fetchDiscovery(origin, boundedFetch(input)), origin);
  if (discovery.instance_id !== input.instanceId) fail("DISCOVERY_INSTANCE_MISMATCH", "The explicit origin reports a different instance");
  if (discovery.preferred_api_origin !== origin || discovery.origin_version < 1 || (instance && discovery.origin_version !== instance.origin_version)) fail("DISCOVERY_ORIGIN_MISMATCH", "Resolve trusted origin changes explicitly before pairing a device");
  return discovery;
}

function requireDeviceSchema(schemaVersion, source) {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw toolError("OWNER_DEVICE_SCHEMA_UNVERIFIED", "Service did not provide a verifiable schema version for Owner device support", { source });
  if (schemaVersion < 12) throw toolError("OWNER_DEVICE_UPGRADE_REQUIRED", "Upgrade this instance to schema 12 or later before adding Owner devices", { source, schema_version: schemaVersion, required_schema_version: 12 });
}

async function verifyPublicDeviceSupport(input, origin) {
  let response;
  try { response = await boundedFetch(input)(new URL("/healthz", origin), { method: "GET", headers: { accept: "application/json" }, redirect: "manual" }); }
  catch { fail("OWNER_DEVICE_SCHEMA_UNVERIFIED", "Could not verify Owner device support through the explicit origin's public health endpoint"); }
  if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) fail("OWNER_DEVICE_SCHEMA_UNVERIFIED", "Public health endpoint did not return a direct JSON success response");
  let health;
  try { health = await response.json(); }
  catch { fail("OWNER_DEVICE_SCHEMA_UNVERIFIED", "Public health endpoint did not return valid JSON"); }
  requireDeviceSchema(health?.schema_version, "healthz");
}

async function assertNoCurrent(paths) {
  if (await pathType(paths.currentMetadata) !== "missing" || await pathType(paths.currentSecret) !== "missing") fail("STATE_CURRENT_CONFLICT", "This environment already has a current Credential for the instance");
}

function pairingFrom(metadata) {
  if (metadata.purpose !== PURPOSE || metadata.credential_id_binding !== "exact") fail("STATE_PENDING_CONFLICT", "Pending Credential belongs to another operation");
  const request = validateRequest(metadata.owner_device_request);
  if (request.instance_id !== metadata.instance_id || request.principal_id !== metadata.principal_id || request.credential_id !== metadata.credential_id || request.token_prefix !== metadata.token_prefix || request.token_digest !== metadata.token_digest || request.operation_id !== metadata.operation_id || request.idempotency_key !== metadata.idempotency_key) fail("STATE_SECRET_MISMATCH", "Pairing request no longer matches its private pending Credential");
  return request;
}

export async function prepareOwnerDevice(options) {
  const input = inputOptions(options);
  input.instanceId = requireUuid(input.instanceId, "instance_id");
  const origin = requireHttpsOrigin(input.apiOrigin, "api_origin"), owner = requireUuid(input.ownerPrincipalId, "owner_principal_id");
  const name = deviceName(input.deviceName), operationId = requireUuid(input.operationId, "operation_id"), key = requireString(input.idempotencyKey, "idempotency_key", { max: 128 });
  const lifetime = input.expiresInSeconds ?? 3600;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 3600) fail("INVALID_OWNER_DEVICE_REQUEST", "Pairing request lifetime must be 1–3600 seconds");
  return withLock(input, async (paths) => {
    await assertNoCurrent(paths);
    const stored = await readJson(paths.instanceMetadata, { allowMissing: true });
    if (stored && (stored.instance_id !== input.instanceId || stored.trusted_api_origin !== origin)) fail("STATE_INSTANCE_CONFLICT", "Explicit origin conflicts with existing trusted instance metadata");
    const discovery = await discoveryAt(input, origin, stored);
    await verifyPublicDeviceSupport(input, origin);
    if (!stored) await putInstanceMetadata({ ...input, trustedApiOrigin: origin, originVersion: discovery.origin_version, serviceVersion: discovery.service_version ?? null });
    const pendingType = await pathType(paths.pendingMetadata), secretType = await pathType(paths.pendingSecret);
    if ((pendingType === "missing") !== (secretType === "missing")) fail("STATE_PENDING_CONFLICT", "Pending Credential is incomplete; preserve it until its remote state is known");
    let metadata;
    if (pendingType !== "missing") {
      metadata = (await loadPendingCredentialSecret(input)).metadata;
      if (metadata.purpose !== PURPOSE || metadata.principal_id !== owner || metadata.operation_id !== operationId || metadata.idempotency_key !== key) fail("STATE_PENDING_CONFLICT", "An unresolved pending Credential belongs to a different pairing operation");
    } else {
      metadata = await createPendingCredential({ ...input, principalId: owner, credentialId: randomUUID(), operationId, idempotencyKey: key, purpose: PURPOSE });
    }
    // If interrupted before this write, no public pairing request was returned.
    if (!metadata.owner_device_request) {
      const issuedAt = currentTime(input);
      metadata.owner_device_request = validateRequest({ instance_id: input.instanceId, principal_id: owner, credential_id: metadata.credential_id,
        token_prefix: metadata.token_prefix, token_digest: metadata.token_digest, device_name: name,
        issued_at: new Date(issuedAt).toISOString(), expires_at: new Date(issuedAt + lifetime * 1000).toISOString(),
        api_origin: origin, operation_id: operationId, idempotency_key: key });
      await atomicWriteJson(paths.pendingMetadata, metadata);
    }
    const request = pairingFrom(metadata);
    if (request.api_origin !== origin || request.device_name !== name || Date.parse(request.expires_at) - Date.parse(request.issued_at) !== lifetime * 1000) fail("STATE_PENDING_CONFLICT", "The existing pairing request must be reused without changing its target, name or expiry");
    return requestView(request, "pending", currentTime(input));
  }, true);
}

export async function inspectOwnerDeviceRequest(options) {
  const input = inputOptions(options), paths = await privatePaths(input);
  const instance = await instanceMetadata(input, paths);
  const { credential } = await loadDeviceCredential(input, paths);
  const request = pairingFrom(credential.metadata);
  if (instance.trusted_api_origin !== request.api_origin) fail("STATE_INSTANCE_CONFLICT", "Trusted origin changed after this pairing request was prepared");
  return requestView(request, credential.metadata.state, currentTime(input));
}

async function authenticatedOwner(input, paths, credential, request = null) {
  const instance = await instanceMetadata(input, paths), origin = instance.trusted_api_origin;
  if (request && (request.instance_id !== input.instanceId || request.api_origin !== origin || request.principal_id !== credential.metadata.principal_id)) fail("OWNER_DEVICE_TARGET_MISMATCH", "Pairing request does not match the trusted instance and current Owner");
  await discoveryAt(input, origin, instance);
  const send = (apiPath) => trustedApiRequest({ ...input, apiPath, authorizationToken: credential.token, fetchImpl: boundedFetch(input) });
  const meta = await send("/api/v1/meta");
  if (!meta.ok) return { failure: redact(meta, credential.token) };
  if (meta.data?.instance_id !== input.instanceId || meta.data?.observed_origin !== origin || meta.data?.preferred_api_origin !== origin || meta.data?.origin_version !== instance.origin_version || meta.data?.principal?.id !== credential.metadata.principal_id || meta.data?.principal?.is_owner !== true) fail("CREDENTIAL_VERIFICATION_MISMATCH", "Authenticated instance readback did not verify the expected Owner and trusted origin");
  requireDeviceSchema(meta.data?.schema_version, "meta");
  const me = await send("/api/v1/me");
  if (!me.ok) return { failure: redact(me, credential.token) };
  if (me.data?.id !== credential.metadata.principal_id || me.data?.principal_id !== credential.metadata.principal_id || me.data?.is_owner !== true || me.data?.credential?.id !== credential.metadata.credential_id || me.data?.credential?.fingerprint !== credential.metadata.fingerprint || !Number.isSafeInteger(me.data?.version) || me.data.version < 1) fail("CREDENTIAL_VERIFICATION_MISMATCH", "/me did not verify the exact Owner Credential and Principal version");
  return { me: me.data };
}

function operationBody(saved, fields, version) {
  if (!saved) return { ...fields, expected_version: version };
  const expectedVersion = saved.body?.expected_version;
  const body = { ...fields, expected_version: expectedVersion };
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || canonicalDigest(saved.body) !== canonicalDigest(body)) fail("STATE_OPERATION_CONFLICT", "Saved device operation body no longer matches the original request");
  return body;
}

async function savedOperation(paths, key, expected) {
  const file = path.join(paths.credentialsRoot, `owner-device-operation-${sha256Text(key)}.json`);
  await assertNoSymlinkPath(file, paths.stateRoot);
  if (await pathType(file) !== "missing") {
    await validatePrivatePath(file, "file");
    const saved = await readJson(file);
    if (saved.request_digest !== expected.request_digest || saved.actor_credential_id !== expected.actor_credential_id || saved.api_path !== expected.api_path || saved.idempotency_key !== key) fail("STATE_OPERATION_CONFLICT", "This idempotency key already belongs to another device operation");
    return { file, saved };
  }
  return { file, saved: null };
}

function hasDefinitiveVersionConflict(saved) {
  const rejection = saved?.definitive_rejection;
  if (rejection === undefined) return false;
  if (rejection.code !== "VERSION_CONFLICT" || rejection.status !== 409 || rejection.source !== "service") fail("STATE_OPERATION_CONFLICT", "Saved operation does not contain a recognized definitive rejection");
  requireUuid(rejection.request_id, "rejection_request_id");
  return true;
}

function isDefinitiveVersionConflict(operation) {
  return operation.ok === false && operation.status === 409 && operation.error?.code === "VERSION_CONFLICT"
    && operation.error?.category === "conflict" && operation.error?.source === "service"
    && operation.error?.retryable === false && operation.error?.details?.normalized_by !== "client";
}

async function sendDeviceAttempt({ input, file, saved, expected, fields, version, current }) {
  const previousBody = operationBody(saved, fields, version);
  const replan = hasDefinitiveVersionConflict(saved);
  const record = !saved || replan ? {
    ...expected,
    body: replan ? { ...fields, expected_version: version } : previousBody,
    attempt_idempotency_key: replan ? randomUUID() : expected.idempotency_key,
    ...(replan ? { previous_attempt: {
      idempotency_key: saved.attempt_idempotency_key ?? expected.idempotency_key,
      expected_version: previousBody.expected_version, rejection_request_id: saved.definitive_rejection.request_id,
    } } : {}),
  } : saved;
  const key = requireString(record.attempt_idempotency_key ?? expected.idempotency_key, "attempt_idempotency_key", { max: 128 });
  if (!saved || replan) await atomicWriteJson(file, record);
  const operation = await trustedApiRequest({ ...input, method: "POST", apiPath: expected.api_path, body: record.body, idempotencyKey: key, authorizationToken: current.token, fetchImpl: boundedFetch(input) });
  const versionRejected = isDefinitiveVersionConflict(operation);
  // Only a verified Service rejection proves this attempt did not commit. A
  // response lost after commit must continue replaying its exact body and key.
  if (versionRejected) await atomicWriteJson(file, { ...record, definitive_rejection: {
    code: "VERSION_CONFLICT", status: 409, source: "service", request_id: operation.error.request_id,
  } });
  return { operation: redact(operation, current.token), attempt_replanned: replan, retry_with_fresh_version: versionRejected };
}

export async function approveOwnerDevice(options) {
  const input = inputOptions(options), request = validateRequest(input.request);
  return withLock(input, async (paths) => {
    const current = await loadCurrentCredentialSecret(input);
    const identity = await authenticatedOwner(input, paths, current, request);
    if (identity.failure) return { operation: identity.failure, secret_values_exposed: false };
    const apiPath = "/api/v1/admin/owner-credentials/add-device";
    const expected = { request_digest: canonicalDigest(request), actor_credential_id: current.metadata.credential_id, api_path: apiPath, idempotency_key: request.idempotency_key };
    const { file, saved } = await savedOperation(paths, request.idempotency_key, expected);
    if ((!saved || hasDefinitiveVersionConflict(saved)) && (Date.parse(request.issued_at) > currentTime(input) || Date.parse(request.expires_at) <= currentTime(input))) fail("OWNER_DEVICE_REQUEST_EXPIRED", "Request is expired or not yet valid; preserve the pending Credential and resolve its remote state before replacement");
    const result = await sendDeviceAttempt({ input, file, saved, expected, fields: Object.fromEntries(REQUEST_FIELDS.map((key) => [key, request[key]])), version: identity.me.version, current });
    return { ...result, pairing_request: request, next_action: result.operation.ok ? "verify_on_new_device" : result.retry_with_fresh_version ? "retry_same_command_to_refresh_version" : "preserve_request_and_retry_same_operation", secret_values_exposed: false };
  });
}

async function assertPromotionCompatible(paths, pending) {
  const current = await readJson(paths.currentMetadata, { allowMissing: true });
  if (current && (current.state !== "current" || canonicalDigest(pairingFrom(current)) !== canonicalDigest(pairingFrom(pending.metadata)))) fail("STATE_CURRENT_CONFLICT", "Current Credential belongs to another device operation");
  const currentSecret = await readJson(paths.currentSecret, { allowMissing: true });
  if (currentSecret && currentSecret.token !== pending.token) fail("STATE_CURRENT_CONFLICT", "Current secret differs from the verified pending device");
}

async function loadDeviceCredential(input, paths) {
  const hasPendingMetadata = await pathType(paths.pendingMetadata) !== "missing";
  const hasPendingSecret = await pathType(paths.pendingSecret) !== "missing";
  if (hasPendingMetadata && hasPendingSecret) return { credential: await loadPendingCredentialSecret(input), pending: true };
  if (!hasPendingMetadata && hasPendingSecret) fail("STATE_PENDING_CONFLICT", "Pending Credential is incomplete; preserve it until its remote state is known");
  const credential = await loadCurrentCredentialSecret(input);
  if (!hasPendingMetadata) return { credential, pending: false };

  // Promotion writes both current files before removing the pending files. A
  // leftover metadata file is recoverable only with that exact completed copy.
  const leftover = await readJson(paths.pendingMetadata);
  const request = pairingFrom(leftover), currentRequest = pairingFrom(credential.metadata);
  const fingerprint = `cfk_v1_${request.token_prefix}_…`;
  if (leftover.state !== "pending" || credential.metadata.state !== "current"
    || request.instance_id !== input.instanceId || currentRequest.instance_id !== input.instanceId
    || leftover.fingerprint !== fingerprint || credential.metadata.fingerprint !== fingerprint
    || canonicalDigest(request) !== canonicalDigest(currentRequest)) {
    fail("STATE_CURRENT_CONFLICT", "Current Credential does not match the interrupted device promotion");
  }
  return { credential, pending: false, leftoverDigest: canonicalDigest(leftover) };
}

export async function verifyOwnerDevice(options) {
  const input = inputOptions(options);
  return withLock(input, async (paths) => {
    const { credential, pending, leftoverDigest } = await loadDeviceCredential(input, paths);
    if (pending) await assertPromotionCompatible(paths, credential);
    const request = pairingFrom(credential.metadata);
    const identity = await authenticatedOwner(input, paths, credential, request);
    if (identity.failure) return { verification: identity.failure, credential: credentialMetadataView(credential.metadata), secret_values_exposed: false };
    const metadata = pending ? await promotePendingCredential({ ...input, principalId: identity.me.principal_id, credentialId: identity.me.credential.id, fingerprint: identity.me.credential.fingerprint }) : credential.metadata;
    if (leftoverDigest) {
      await privatePaths(input);
      const remaining = await loadDeviceCredential(input, paths);
      if (remaining.leftoverDigest !== leftoverDigest || canonicalDigest(remaining.credential.metadata) !== canonicalDigest(metadata)) fail("STATE_CURRENT_CONFLICT", "Device Credential state changed during verification; preserve the remaining promotion state");
      await rm(paths.pendingMetadata);
    }
    return { verification: { ok: true, is_owner: true, principal_id: metadata.principal_id, credential_id: metadata.credential_id }, credential: credentialMetadataView(metadata), secret_values_exposed: false };
  });
}

export async function listOwnerDevices(options) {
  const input = inputOptions(options), paths = await privatePaths(input), current = await loadCurrentCredentialSecret(input);
  const identity = await authenticatedOwner(input, paths, current);
  if (identity.failure) return { operation: identity.failure, secret_values_exposed: false };
  const cursor = input.cursor === undefined || input.cursor === null ? "" : `?${new URLSearchParams({ cursor: requireString(input.cursor, "cursor", { max: 4096 }) })}`;
  const apiPath = `/api/v1/admin/principals/${current.metadata.principal_id}/credentials${cursor}`;
  const operation = await trustedApiRequest({ ...input, apiPath, authorizationToken: current.token, fetchImpl: boundedFetch(input) });
  return { operation: redact(operation, current.token), current_credential_id: current.metadata.credential_id, secret_values_exposed: false };
}

export async function revokeOwnerDevice(options) {
  const input = inputOptions(options), credentialId = requireUuid(input.credentialId, "credential_id"), key = requireString(input.idempotencyKey, "idempotency_key", { max: 128 });
  return withLock(input, async (paths) => {
    const current = await loadCurrentCredentialSecret(input);
    if (credentialId === current.metadata.credential_id) fail("OWNER_CURRENT_CREDENTIAL_REVOKE_FORBIDDEN", "A device cannot revoke its own current Credential");
    const identity = await authenticatedOwner(input, paths, current);
    if (identity.failure) return { operation: identity.failure, secret_values_exposed: false };
    const apiPath = `/api/v1/admin/owner-credentials/${credentialId}/revoke`;
    const expected = { request_digest: canonicalDigest({ credential_id: credentialId, instance_id: input.instanceId }), actor_credential_id: current.metadata.credential_id, api_path: apiPath, idempotency_key: key };
    const { file, saved } = await savedOperation(paths, key, expected);
    const result = await sendDeviceAttempt({ input, file, saved, expected, fields: {}, version: identity.me.version, current });
    return { ...result, credential_id: credentialId, next_action: result.operation.ok ? "complete" : result.retry_with_fresh_version ? "retry_same_command_to_refresh_version" : "preserve_request_and_retry_same_operation", secret_values_exposed: false };
  });
}
