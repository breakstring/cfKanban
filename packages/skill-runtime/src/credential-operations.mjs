import { toolError } from "./errors.mjs";
import { resolveStateRoot } from "./paths.mjs";
import {
  getInstancePaths,
  loadCurrentCredentialSecret,
  loadPendingCredentialSecret,
  promotePendingCredential,
} from "./state.mjs";
import { trustedApiRequest } from "./transport.mjs";
import { pathType, requireString, requireUuid } from "./utils.mjs";

function oneOf(value, name, values) {
  if (!values.includes(value)) {
    throw toolError("INVALID_OPERATION_INPUT", `${name} must be one of the supported values`, { name, value, allowed: values });
  }
  return value;
}

function redactSecretValues(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecretValues(entry, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecretValues(entry, secrets)]));
  }
  return value;
}

function currentCredentialResult(operation, current) {
  return {
    operation,
    credential: {
      state: "current",
      principal_id: current.metadata.principal_id,
      credential_id: current.metadata.credential_id,
      fingerprint: current.metadata.fingerprint,
      secret_values_exposed: false,
    },
  };
}

async function loadOptionalCurrentCredentialSecret({ stateRoot, instanceId }) {
  try {
    return await loadCurrentCredentialSecret({ stateRoot, instanceId });
  } catch (error) {
    const paths = getInstancePaths({ stateRoot, instanceId });
    const metadataType = await pathType(paths.currentMetadata);
    const secretType = await pathType(paths.currentSecret);
    if (
      error?.code === "STATE_PATH_INVALID"
      && error.details?.actualKind === "missing"
      && metadataType === "missing"
      && secretType === "missing"
    ) return null;
    throw error;
  }
}

async function verifyAndPromote({ stateRoot, instanceId, token, operation, fetchImpl, requireOwner = false }) {
  const verification = await trustedApiRequest({
    stateRoot,
    instanceId,
    apiPath: "/api/v1/me",
    authorizationToken: token,
    fetchImpl,
  });
  if (!verification.ok) {
    return {
      operation,
      verification,
      credential: { state: "pending", secret_values_exposed: false },
    };
  }
  const principalId = requireUuid(verification.data?.principal_id, "principal_id");
  const resourceId = requireUuid(verification.data?.id, "principal_resource_id");
  if (resourceId !== principalId) {
    throw toolError("CREDENTIAL_VERIFICATION_MISMATCH", "/me returned inconsistent Principal identifiers", { instanceId });
  }
  if (typeof verification.data?.is_owner !== "boolean") {
    throw toolError("CREDENTIAL_VERIFICATION_MISMATCH", "/me did not return an explicit Owner identity flag", { instanceId });
  }
  if (requireOwner && verification.data.is_owner !== true) {
    throw toolError("CREDENTIAL_VERIFICATION_MISMATCH", "/me did not verify the expected Deployment Owner identity", { instanceId });
  }
  const credentialId = requireUuid(verification.data?.credential?.id, "credential_id");
  const fingerprint = requireString(verification.data?.credential?.fingerprint, "credential_fingerprint", { max: 128 });
  const promoted = await promotePendingCredential({ stateRoot, instanceId, principalId, credentialId, fingerprint });
  return {
    operation,
    verification: {
      ok: true,
      principal_id: principalId,
      is_owner: verification.data.is_owner,
      credential_id: credentialId,
      credential_fingerprint: fingerprint,
    },
    credential: {
      state: promoted.state,
      principal_id: promoted.principal_id,
      credential_id: promoted.credential_id,
      fingerprint: promoted.fingerprint,
      secret_values_exposed: false,
    },
  };
}

export async function verifyPendingCredential({
  stateRoot = resolveStateRoot(),
  instanceId,
  fetchImpl = globalThis.fetch,
}) {
  const pending = await loadPendingCredentialSecret({ stateRoot, instanceId });
  return verifyAndPromote({ stateRoot, instanceId, token: pending.token, operation: null, fetchImpl });
}

export async function redeemInvitation({
  stateRoot = resolveStateRoot(),
  instanceId,
  inviteCode,
  redeemAs,
  displayName = null,
  idempotencyKey = null,
  fetchImpl = globalThis.fetch,
}) {
  const mode = oneOf(redeemAs, "redeem_as", ["new_principal", "current_principal", "recovery"]);
  const body = { invite_code: requireString(inviteCode, "invite_code", { max: 1024 }), redeem_as: mode };
  if (mode === "current_principal") {
    const current = await loadCurrentCredentialSecret({ stateRoot, instanceId });
    const operation = await trustedApiRequest({
      stateRoot,
      instanceId,
      method: "POST",
      apiPath: "/api/v1/invitations/redeem",
      body,
      idempotencyKey: requireString(idempotencyKey, "idempotency_key", { max: 128 }),
      authorizationToken: current.token,
      fetchImpl,
    });
    return currentCredentialResult(
      redactSecretValues(operation, [current.token, body.invite_code]),
      current,
    );
  }

  const pending = await loadPendingCredentialSecret({ stateRoot, instanceId });
  if (mode === "new_principal") body.display_name = requireString(displayName, "display_name", { max: 128 });
  body.new_credential_token = pending.token;
  // A rotation recovery must prove possession of the current Principal's
  // Credential; full recovery may intentionally proceed without one. When a
  // local current Credential exists, try it first. An authentication or
  // principal-mismatch response is safe to retry without Authorization: the
  // Service rejects those cases before claiming the idempotent operation, and
  // this is the only recovery mode that permits an unauthenticated fallback.
  let current = null;
  if (mode === "recovery") {
    current = await loadOptionalCurrentCredentialSecret({ stateRoot, instanceId });
  }
  const request = {
    stateRoot,
    instanceId,
    method: "POST",
    apiPath: "/api/v1/invitations/redeem",
    body,
    idempotencyKey: pending.metadata.idempotency_key,
    fetchImpl,
  };
  let operation = await trustedApiRequest({ ...request, authorizationToken: current?.token ?? null });
  if (mode === "recovery" && current !== null && !operation.ok && [401, 403].includes(operation.status)) {
    operation = await trustedApiRequest({ ...request, authorizationToken: null });
  }
  const safeOperation = redactSecretValues(operation, [pending.token, body.invite_code]);
  if (!operation.ok) return { operation: safeOperation, credential: { state: "pending", secret_values_exposed: false } };
  return verifyAndPromote({ stateRoot, instanceId, token: pending.token, operation: safeOperation, fetchImpl });
}

export async function redeemPublicJoin({
  stateRoot = resolveStateRoot(),
  instanceId,
  publicId,
  role,
  redeemAs,
  displayName = null,
  idempotencyKey = null,
  fetchImpl = globalThis.fetch,
}) {
  const mode = oneOf(redeemAs, "redeem_as", ["new_principal", "current_principal"]);
  const explicitRole = oneOf(role, "role", ["reader", "writer"]);
  const body = { redeem_as: mode, role: explicitRole };
  const apiPath = `/api/v1/public-joins/${requireUuid(publicId, "public_id")}/redeem`;
  if (mode === "current_principal") {
    const current = await loadCurrentCredentialSecret({ stateRoot, instanceId });
    const operation = await trustedApiRequest({
      stateRoot,
      instanceId,
      method: "POST",
      apiPath,
      body,
      idempotencyKey: requireString(idempotencyKey, "idempotency_key", { max: 128 }),
      authorizationToken: current.token,
      fetchImpl,
    });
    return currentCredentialResult(redactSecretValues(operation, [current.token]), current);
  }

  const pending = await loadPendingCredentialSecret({ stateRoot, instanceId });
  body.display_name = requireString(displayName, "display_name", { max: 128 });
  body.new_credential_token = pending.token;
  const operation = await trustedApiRequest({
    stateRoot,
    instanceId,
    method: "POST",
    apiPath,
    body,
    idempotencyKey: pending.metadata.idempotency_key,
    authorizationToken: null,
    fetchImpl,
  });
  const safeOperation = redactSecretValues(operation, [pending.token]);
  if (!operation.ok) return { operation: safeOperation, credential: { state: "pending", secret_values_exposed: false } };
  return verifyAndPromote({ stateRoot, instanceId, token: pending.token, operation: safeOperation, fetchImpl });
}

export async function rotateOwnerCredential({
  stateRoot = resolveStateRoot(),
  instanceId,
  fetchImpl = globalThis.fetch,
}) {
  const [current, pending] = await Promise.all([
    loadCurrentCredentialSecret({ stateRoot, instanceId }),
    loadPendingCredentialSecret({ stateRoot, instanceId }),
  ]);
  const operation = await trustedApiRequest({
    stateRoot,
    instanceId,
    method: "POST",
    apiPath: "/api/v1/admin/owner-credentials/rotate",
    body: { new_credential_token: pending.token },
    idempotencyKey: pending.metadata.idempotency_key,
    authorizationToken: current.token,
    fetchImpl,
  });
  const safeOperation = redactSecretValues(operation, [current.token, pending.token]);
  if (!operation.ok) return { operation: safeOperation, credential: { state: "pending", secret_values_exposed: false } };
  return verifyAndPromote({ stateRoot, instanceId, token: pending.token, operation: safeOperation, fetchImpl, requireOwner: true });
}
