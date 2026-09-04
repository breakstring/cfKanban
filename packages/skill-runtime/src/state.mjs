import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { toolError } from "./errors.mjs";
import { resolveStateRoot } from "./paths.mjs";
import {
  assertNoSymlinkPath,
  atomicWriteJson,
  ensurePrivateDirectory,
  pathType,
  readJson,
  requireHttpsOrigin,
  requireString,
  requireUuid,
} from "./utils.mjs";

function instancePaths(stateRoot, instanceId) {
  const id = requireUuid(instanceId, "instance_id");
  const instanceRoot = path.join(stateRoot, "instances", id);
  const credentialsRoot = path.join(instanceRoot, "credentials");
  return {
    stateRoot,
    instanceRoot,
    credentialsRoot,
    instanceMetadata: path.join(instanceRoot, "instance.json"),
    currentMetadata: path.join(credentialsRoot, "current.json"),
    currentSecret: path.join(credentialsRoot, "current.secret.json"),
    pendingMetadata: path.join(credentialsRoot, "pending.json"),
    pendingSecret: path.join(credentialsRoot, "pending.secret.json"),
    receiptsRoot: path.join(instanceRoot, "receipts"),
    journalsRoot: path.join(instanceRoot, "journals"),
  };
}

function windowsAclProbe(targetPath) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$acl=Get-Acl -LiteralPath $env:CFKANBAN_ACL_PATH",
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$owner=$acl.Owner",
    "try{$owner=([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}",
    "$access=@($acl.Access | ForEach-Object { $sid=$_.IdentityReference.Value; try{$sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}; [pscustomobject]@{sid=$sid;type=$_.AccessControlType.ToString()} })",
    "[pscustomobject]@{current=$current;owner=$owner;access=$access}|ConvertTo-Json -Depth 5 -Compress",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, CFKANBAN_ACL_PATH: targetPath },
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw toolError("STATE_ACL_UNVERIFIED", "Windows ACL could not be verified", { path: targetPath });
  }
  let acl;
  try {
    acl = JSON.parse(result.stdout);
  } catch (error) {
    throw toolError("STATE_ACL_UNVERIFIED", "Windows ACL probe returned invalid data", { path: targetPath }, error);
  }
  const allowed = new Set([acl.current, "S-1-5-18", "S-1-5-32-544"]);
  const access = Array.isArray(acl.access) ? acl.access : acl.access ? [acl.access] : [];
  if (acl.owner !== acl.current || access.some((entry) => entry.type === "Allow" && !allowed.has(entry.sid))) {
    throw toolError("STATE_PERMISSION_DRIFT", "Windows ACL grants access outside the current user and required system principals", { path: targetPath });
  }
}

async function validatePrivatePath(targetPath, expectedKind) {
  const type = await pathType(targetPath);
  if (type !== expectedKind) {
    throw toolError("STATE_PATH_INVALID", "Stored state path has an unexpected type", { path: targetPath, expectedKind, actualKind: type });
  }
  if (process.platform === "win32") {
    windowsAclProbe(targetPath);
    return;
  }
  const stats = await lstat(targetPath);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw toolError("STATE_OWNERSHIP_DRIFT", "Stored state is not owned by the current user", { path: targetPath, ownerUid: stats.uid });
  }
  if ((stats.mode & 0o077) !== 0) {
    throw toolError("STATE_PERMISSION_DRIFT", "Stored state is accessible by another user or group", {
      path: targetPath,
      mode: (stats.mode & 0o777).toString(8).padStart(3, "0"),
    });
  }
}

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function initializeStateRoot({
  stateRoot = resolveStateRoot(),
  home = os.homedir(),
  repoRoot = null,
  persistenceConfirmed = false,
} = {}) {
  const absoluteRoot = path.resolve(stateRoot);
  const absoluteHome = path.resolve(home);
  const relative = path.relative(absoluteHome, absoluteRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative) || absoluteRoot === absoluteHome) {
    throw toolError("UNSAFE_STATE_PATH", "cfKanban state must be a private child of the current user's home directory", { stateRoot: absoluteRoot });
  }
  if (repoRoot !== null && isWithin(repoRoot, absoluteRoot)) {
    throw toolError("UNSAFE_STATE_PATH", "cfKanban Credential state must not be stored inside a repository", { stateRoot: absoluteRoot, repoRoot: path.resolve(repoRoot) });
  }
  if (/\/(?:Dropbox|OneDrive|Google Drive|Library\/Mobile Documents)(?:\/|$)/i.test(absoluteRoot.replaceAll("\\", "/"))) {
    throw toolError("UNSAFE_STATE_PATH", "cfKanban Credential state must not be stored in a known synchronization directory", { stateRoot: absoluteRoot });
  }
  if (isWithin(os.tmpdir(), absoluteHome) && !persistenceConfirmed) {
    throw toolError("NON_PERSISTENT_HOME_UNCONFIRMED", "A temporary or container home requires an explicitly confirmed persistent private mount before creating Credentials", { home: absoluteHome });
  }
  await ensurePrivateDirectory(absoluteRoot);
  await assertNoSymlinkPath(absoluteRoot, absoluteHome);
  await validatePrivatePath(absoluteRoot, "directory");
  await ensurePrivateDirectory(path.join(absoluteRoot, "instances"));
  return { state_root: absoluteRoot, permissions: process.platform === "win32" ? "acl-verified" : "0700-verified" };
}

export async function putInstanceMetadata({
  stateRoot = resolveStateRoot(),
  home = os.homedir(),
  persistenceConfirmed = false,
  instanceId,
  trustedApiOrigin,
  originVersion = 1,
  serviceVersion = null,
  schemaVersion = null,
  publisher = null,
}) {
  await initializeStateRoot({ stateRoot, home, persistenceConfirmed });
  const paths = instancePaths(stateRoot, instanceId);
  await ensurePrivateDirectory(paths.instanceRoot);
  await ensurePrivateDirectory(paths.credentialsRoot);
  const current = await readJson(paths.instanceMetadata, { allowMissing: true });
  if (current !== null && current.instance_id !== instanceId) {
    throw toolError("STATE_INSTANCE_CONFLICT", "Instance metadata does not match its immutable state slot", { instanceId });
  }
  const metadata = {
    schema_version: 1,
    instance_id: requireUuid(instanceId, "instance_id"),
    trusted_api_origin: requireHttpsOrigin(trustedApiOrigin, "trusted_api_origin"),
    origin_version: Number.isSafeInteger(originVersion) && originVersion >= 1 ? originVersion : 1,
    service_version: serviceVersion,
    service_schema_version: schemaVersion,
    publisher,
    discovery_checked_at: current?.discovery_checked_at || null,
    updated_at: new Date().toISOString(),
  };
  await atomicWriteJson(paths.instanceMetadata, metadata);
  return metadata;
}

function generateCredential() {
  const prefix = randomBytes(8).toString("hex");
  const token = `cfk_v1_${prefix}_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    prefix,
    fingerprint: `cfk_v1_${prefix}_…`,
    digest: createHash("sha256").update(token).digest("hex"),
  };
}

export function credentialMetadataView(metadata) {
  if (metadata === null) return null;
  return {
    schema_version: metadata.schema_version,
    instance_id: metadata.instance_id,
    principal_id: metadata.principal_id,
    credential_id: metadata.credential_id,
    credential_id_binding: metadata.credential_id_binding,
    fingerprint: metadata.fingerprint,
    operation_id: metadata.operation_id,
    purpose: metadata.purpose,
    state: metadata.state,
    created_at: metadata.created_at,
    ...(metadata.verified_at === undefined ? {} : { verified_at: metadata.verified_at }),
    secret_values_exposed: false,
  };
}

export async function createPendingCredential({
  stateRoot = resolveStateRoot(),
  home = os.homedir(),
  persistenceConfirmed = false,
  instanceId,
  principalId = null,
  credentialId = null,
  idempotencyKey = randomUUID(),
  operationId = randomUUID(),
  purpose = "principal_bootstrap",
}) {
  await initializeStateRoot({ stateRoot, home, persistenceConfirmed });
  const paths = instancePaths(stateRoot, instanceId);
  await ensurePrivateDirectory(paths.credentialsRoot);
  await assertNoSymlinkPath(paths.credentialsRoot, stateRoot);
  const existingCurrent = await readJson(paths.currentMetadata, { allowMissing: true });
  if (existingCurrent !== null && principalId !== null && existingCurrent.principal_id !== principalId) {
    throw toolError("STATE_IDENTITY_CONFLICT", "This instance already has a different current local Principal", {
      instanceId,
      currentPrincipalId: existingCurrent.principal_id,
      requestedPrincipalId: principalId,
    });
  }
  const existingPending = await readJson(paths.pendingMetadata, { allowMissing: true });
  if (existingPending !== null) {
    if (existingPending.operation_id === operationId && existingPending.idempotency_key === idempotencyKey) return existingPending;
    throw toolError("STATE_PENDING_CONFLICT", "An unresolved pending Credential already exists for this instance", {
      instanceId,
      pendingOperationId: existingPending.operation_id,
    });
  }
  const credential = generateCredential();
  const boundCredentialId = credentialId === null ? null : requireUuid(credentialId, "credential_id");
  const metadata = {
    schema_version: 1,
    instance_id: requireUuid(instanceId, "instance_id"),
    principal_id: principalId === null ? null : requireUuid(principalId, "principal_id"),
    credential_id: boundCredentialId,
    credential_id_binding: boundCredentialId === null ? "server_assigned" : "exact",
    token_prefix: credential.prefix,
    fingerprint: credential.fingerprint,
    token_digest: credential.digest,
    idempotency_key: requireString(idempotencyKey, "idempotency_key", { max: 128 }),
    operation_id: requireUuid(operationId, "operation_id"),
    purpose: requireString(purpose, "purpose", { max: 64 }),
    state: "pending",
    created_at: new Date().toISOString(),
  };
  await atomicWriteJson(paths.pendingSecret, { schema_version: 1, token: credential.token });
  try {
    await atomicWriteJson(paths.pendingMetadata, metadata);
  } catch (error) {
    await rm(paths.pendingSecret, { force: true });
    throw error;
  }
  return metadata;
}

export async function preparePendingCredential(input) {
  return credentialMetadataView(await createPendingCredential(input));
}

export async function loadPendingCredentialSecret({ stateRoot = resolveStateRoot(), instanceId }) {
  const paths = instancePaths(stateRoot, instanceId);
  await validatePrivatePath(paths.pendingMetadata, "file");
  await validatePrivatePath(paths.pendingSecret, "file");
  const metadata = await readJson(paths.pendingMetadata);
  const secret = await readJson(paths.pendingSecret);
  if (createHash("sha256").update(secret.token).digest("hex") !== metadata.token_digest) {
    throw toolError("STATE_SECRET_MISMATCH", "Pending Credential secret does not match its metadata", { instanceId });
  }
  return { metadata, token: secret.token };
}

export async function promotePendingCredential({ stateRoot = resolveStateRoot(), instanceId, principalId, credentialId, fingerprint }) {
  const paths = instancePaths(stateRoot, instanceId);
  const { metadata } = await loadPendingCredentialSecret({ stateRoot, instanceId });
  const verifiedPrincipalId = requireUuid(principalId, "principal_id");
  const verifiedCredentialId = requireUuid(credentialId, "credential_id");
  if (metadata.principal_id !== null && metadata.principal_id !== verifiedPrincipalId) {
    throw toolError("STATE_IDENTITY_CONFLICT", "Server readback returned a different Principal for the pending Credential", { instanceId });
  }
  if (metadata.fingerprint !== fingerprint) {
    throw toolError("STATE_SECRET_MISMATCH", "Server readback fingerprint does not match the pending Credential", { instanceId });
  }
  const credentialIdBinding = metadata.credential_id_binding
    ?? (metadata.purpose === "owner_bootstrap" ? "exact" : "server_assigned");
  if (!["exact", "server_assigned"].includes(credentialIdBinding)) {
    throw toolError("STATE_METADATA_INVALID", "Pending Credential has an unsupported Credential ID binding", { instanceId });
  }
  const pendingCredentialId = metadata.credential_id === null
    ? null
    : requireUuid(metadata.credential_id, "pending_credential_id");
  if (credentialIdBinding === "exact" && pendingCredentialId !== verifiedCredentialId) {
    throw toolError("STATE_SECRET_MISMATCH", "Server readback Credential ID does not match the pending Credential", { instanceId });
  }
  const current = await readJson(paths.currentMetadata, { allowMissing: true });
  if (current !== null && current.principal_id !== verifiedPrincipalId) {
    throw toolError("STATE_IDENTITY_CONFLICT", "This instance already has a different current local Principal", { instanceId });
  }
  const promoted = {
    ...metadata,
    principal_id: verifiedPrincipalId,
    credential_id: verifiedCredentialId,
    credential_id_binding: credentialIdBinding,
    state: "current",
    verified_at: new Date().toISOString(),
  };
  const pendingSecret = await readJson(paths.pendingSecret);
  await atomicWriteJson(paths.currentSecret, pendingSecret);
  await atomicWriteJson(paths.currentMetadata, promoted);
  await rm(paths.pendingSecret, { force: true });
  await rm(paths.pendingMetadata, { force: true });
  return promoted;
}

export async function clearPendingCredential({ stateRoot = resolveStateRoot(), instanceId, committedStateKnownFalse = false }) {
  if (!committedStateKnownFalse) {
    throw toolError("PENDING_STATE_UNCERTAIN", "Pending Credential may only be cleared after proving the remote operation was not committed", { instanceId });
  }
  const paths = instancePaths(stateRoot, instanceId);
  await rm(paths.pendingSecret, { force: true });
  await rm(paths.pendingMetadata, { force: true });
  return { cleared: true, instance_id: instanceId };
}

export async function loadCurrentCredentialSecret({ stateRoot = resolveStateRoot(), instanceId }) {
  const paths = instancePaths(stateRoot, instanceId);
  await validatePrivatePath(stateRoot, "directory");
  await assertNoSymlinkPath(paths.credentialsRoot, stateRoot);
  await validatePrivatePath(paths.currentMetadata, "file");
  await validatePrivatePath(paths.currentSecret, "file");
  const metadata = await readJson(paths.currentMetadata);
  const secret = await readJson(paths.currentSecret);
  if (createHash("sha256").update(secret.token).digest("hex") !== metadata.token_digest) {
    throw toolError("STATE_SECRET_MISMATCH", "Current Credential secret does not match its metadata", { instanceId });
  }
  return { metadata, token: secret.token };
}

export async function inspectInstanceState({ stateRoot = resolveStateRoot(), home = os.homedir(), persistenceConfirmed = false, instanceId }) {
  const paths = instancePaths(stateRoot, instanceId);
  await initializeStateRoot({ stateRoot, home, persistenceConfirmed });
  const instance = await readJson(paths.instanceMetadata, { allowMissing: true });
  const current = await readJson(paths.currentMetadata, { allowMissing: true });
  const pending = await readJson(paths.pendingMetadata, { allowMissing: true });
  return {
    schema_version: 1,
    instance,
    credential: {
      current: credentialMetadataView(current),
      pending: credentialMetadataView(pending),
      secret_values_exposed: false,
    },
  };
}

export async function updateTrustedOrigin({ stateRoot = resolveStateRoot(), instanceId, expectedOriginVersion, discovery }) {
  const paths = instancePaths(stateRoot, instanceId);
  const current = await readJson(paths.instanceMetadata);
  if (current.origin_version !== expectedOriginVersion) {
    throw toolError("STATE_CONCURRENT_CHANGE", "Instance origin metadata changed during discovery", {
      expectedOriginVersion,
      actualOriginVersion: current.origin_version,
    });
  }
  const updated = {
    ...current,
    trusted_api_origin: requireHttpsOrigin(discovery.preferred_api_origin, "preferred_api_origin"),
    origin_version: discovery.origin_version,
    service_version: discovery.service_version ?? current.service_version,
    discovery_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await atomicWriteJson(paths.instanceMetadata, updated);
  return updated;
}

export function getInstancePaths({ stateRoot = resolveStateRoot(), instanceId }) {
  return instancePaths(stateRoot, instanceId);
}
