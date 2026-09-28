import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { toolError } from "./errors.mjs";
import { credentialMetadataView, loadCurrentCredentialSecret, validatePrivatePath } from "./state.mjs";
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, pathType, readJson, requireUuid, sha256Text } from "./utils.mjs";

const fail = (code, message) => { throw toolError(code, message); };
const same = (left, right) => canonicalDigest(left) === canonicalDigest(right);

async function privateJson(paths, file) {
  await assertNoSymlinkPath(file, paths.stateRoot);
  if (await pathType(file) === "missing") return null;
  await validatePrivatePath(file, "file");
  return readJson(file);
}

function assertMetadata(metadata, instanceId) {
  if (!metadata || metadata.instance_id !== instanceId || !/^[0-9a-f]{64}$/.test(metadata.token_digest)
    || !/^[0-9a-f]{16}$/.test(metadata.token_prefix) || metadata.fingerprint !== `cfk_v1_${metadata.token_prefix}_…`
    || /cfk_v1_[0-9a-f]{16}_[A-Za-z0-9_-]{32,}/.test(JSON.stringify(metadata))) {
    fail("IDENTITY_SWITCH_STATE_CONFLICT", "Identity metadata does not match the selected private Credential state");
  }
  requireUuid(metadata.principal_id, "principal_id");
  requireUuid(metadata.credential_id, "credential_id");
}

async function noPrevious(paths) {
  if (await pathType(paths.previousMetadata) !== "missing" || await pathType(paths.previousSecret) !== "missing") {
    fail("STATE_PREVIOUS_CONFLICT", "A previous identity already occupies the private restoration slot; do not overwrite it");
  }
}

export async function prepareIdentityReplacement(input, paths) {
  const present = await pathType(paths.currentMetadata) !== "missing" || await pathType(paths.currentSecret) !== "missing";
  if (!present) {
    if (input.replaceCurrent === true || input.expectedCurrentPrincipalId !== undefined || input.expectedCurrentCredentialId !== undefined) {
      fail("STATE_CURRENT_CONFLICT", "The explicitly selected current identity is no longer present");
    }
    return null;
  }
  if (input.replaceCurrent !== true) fail("STATE_CURRENT_CONFLICT", "This environment already has a current Credential; replacing it requires an explicit identity-bound Owner device request");
  const principal = requireUuid(input.expectedCurrentPrincipalId, "expected_current_principal_id");
  const credential = requireUuid(input.expectedCurrentCredentialId, "expected_current_credential_id");
  const current = await loadCurrentCredentialSecret(input);
  assertMetadata(current.metadata, input.instanceId);
  if (current.metadata.state !== "current" || current.metadata.principal_id !== principal || current.metadata.credential_id !== credential) {
    fail("STATE_CURRENT_CONFLICT", "Current identity differs from the explicitly confirmed Principal and Credential");
  }
  await noPrevious(paths);
  return { principal_id: principal, credential_id: credential, fingerprint: current.metadata.fingerprint,
    token_digest: current.metadata.token_digest, metadata_digest: canonicalDigest(current.metadata) };
}

export async function readIdentitySwitch(input, paths) {
  const record = await privateJson(paths, paths.identitySwitch);
  if (record === null) return null;
  if (record.schema_version !== 1 || record.instance_id !== input.instanceId
    || !["owner_device", "restore_previous"].includes(record.kind) || !["prepared", "complete"].includes(record.phase)) {
    fail("IDENTITY_SWITCH_STATE_CONFLICT", "Private identity transition metadata is not recognized");
  }
  requireUuid(record.operation_id, "operation_id");
  for (const metadata of [record.from, record.to, record.current, record.previous, record.pending]) assertMetadata(metadata, input.instanceId);
  if (record.from.token_digest === record.to.token_digest || record.from.credential_id === record.to.credential_id
    || record.current.state !== "current" || record.previous.state !== "previous" || record.pending.state !== "pending"
    || record.current.token_digest !== record.to.token_digest || record.previous.token_digest !== record.from.token_digest
    || record.pending.token_digest !== (record.kind === "owner_device" ? record.to : record.from).token_digest
    || record.binding_digest !== canonicalDigest(binding(record))) {
    fail("IDENTITY_SWITCH_STATE_CONFLICT", "Private identity transition no longer matches its exact operation and Credential bindings");
  }
  return record;
}

function binding(record) {
  const { binding_digest, phase, completed_at, ...rest } = record;
  return rest;
}

function originOf(instance) { return { trusted_api_origin: instance.trusted_api_origin, origin_version: instance.origin_version }; }

async function checkOrigin(input, paths, record) {
  const instance = await privateJson(paths, paths.instanceMetadata);
  if (instance?.instance_id !== input.instanceId || !same(originOf(instance), record.origin)) {
    fail("STATE_INSTANCE_CONFLICT", "Trusted instance or origin changed during the identity transition");
  }
}

async function readTransitionState(input, paths, record) {
  await checkOrigin(input, paths, record);
  const restoring = record.kind === "restore_previous";
  const choices = [
    [paths.currentMetadata, [record.from, record.current]],
    [paths.previousMetadata, restoring ? [record.to, record.previous] : [null, record.previous]],
    [paths.pendingMetadata, [null, record.pending]],
  ];
  for (const [file, allowed] of choices) {
    const actual = await privateJson(paths, file);
    if (!allowed.some((candidate) => same(candidate, actual))) fail("IDENTITY_SWITCH_STATE_CONFLICT", "A Credential metadata file differs from every expected old or new transition state");
  }
  const tokens = new Map();
  for (const [file, allowed] of [
    [paths.currentSecret, [record.from.token_digest, record.to.token_digest]],
    [paths.previousSecret, restoring ? [record.to.token_digest, record.from.token_digest] : [null, record.from.token_digest]],
    [paths.pendingSecret, [null, record.pending.token_digest]],
  ]) {
    const value = await privateJson(paths, file);
    if (value === null) {
      if (!allowed.includes(null)) fail("IDENTITY_SWITCH_STATE_CONFLICT", "An essential Credential secret is missing from the identity transition");
      continue;
    }
    if (value.schema_version !== 1 || Object.keys(value).some((key) => !["schema_version", "token"].includes(key)) || typeof value.token !== "string") {
      fail("IDENTITY_SWITCH_STATE_CONFLICT", "A private Credential secret has an unexpected format");
    }
    const digest = sha256Text(value.token);
    if (!allowed.includes(digest)) fail("IDENTITY_SWITCH_STATE_CONFLICT", "A private Credential secret differs from the exact transition bindings");
    tokens.set(digest, value.token);
  }
  if (!tokens.has(record.from.token_digest) || !tokens.has(record.to.token_digest)) {
    fail("IDENTITY_SWITCH_STATE_CONFLICT", "Both bound Credentials must remain recoverable before continuing the identity transition");
  }
  return tokens;
}

function transitionRecord(input, instance, kind, from, to, pending) {
  const operationId = kind === "owner_device" ? to.operation_id : pending.operation_id;
  const origin = originOf(instance), verifiedAt = new Date().toISOString();
  const { identity_restore: ignored, ...currentFields } = to;
  const current = { ...currentFields, state: "current", verified_at: verifiedAt };
  const previous = { ...from, state: "previous", identity_restore: { ...origin, operation_id: operationId } };
  for (const metadata of [from, to, current, previous, pending]) assertMetadata(metadata, input.instanceId);
  const record = { schema_version: 1, kind, phase: "prepared", instance_id: input.instanceId,
    operation_id: operationId, origin, from, to, current, previous, pending };
  return { ...record, binding_digest: canonicalDigest(binding(record)) };
}

function result(record, verification, resumed) {
  return { verification: { ok: true, is_owner: verification.me.is_owner, principal_id: record.current.principal_id, credential_id: record.current.credential_id },
    credential: credentialMetadataView(record.current), previous: credentialMetadataView(record.previous),
    identity_switch: { operation_id: record.operation_id, kind: record.kind, completed: true, resumed }, secret_values_exposed: false };
}

async function applyTransition(input, paths, record, tokens) {
  const writeSecret = (file, digest) => atomicWriteJson(file, { schema_version: 1, token: tokens.get(digest) });
  // The backup is complete before either current file changes. During restore,
  // pending is the bounded transaction staging slot, never a third identity.
  if (record.kind === "owner_device") {
    await writeSecret(paths.previousSecret, record.from.token_digest);
    await atomicWriteJson(paths.previousMetadata, record.previous);
  } else {
    await writeSecret(paths.pendingSecret, record.from.token_digest);
    await atomicWriteJson(paths.pendingMetadata, record.pending);
  }
  await writeSecret(paths.currentSecret, record.to.token_digest);
  await atomicWriteJson(paths.currentMetadata, record.current);
  if (record.kind === "restore_previous") {
    await writeSecret(paths.previousSecret, record.from.token_digest);
    await atomicWriteJson(paths.previousMetadata, record.previous);
  }
  await rm(paths.pendingSecret, { force: true });
  await rm(paths.pendingMetadata, { force: true });
  const completed = { ...record, phase: "complete", completed_at: new Date().toISOString() };
  await atomicWriteJson(paths.identitySwitch, completed);
  return completed;
}

async function continueTransition(input, paths, record, verifyTarget, resumed, alreadyVerified = null) {
  const tokens = await readTransitionState(input, paths, record);
  const verification = alreadyVerified ?? await verifyTarget({ metadata: record.to, token: tokens.get(record.to.token_digest) });
  if (verification.failure) return { verification: verification.failure, credential: credentialMetadataView(record.to), secret_values_exposed: false };
  // Network readback may take time; recheck all file/ACL/origin bindings before writes.
  await readTransitionState(input, paths, record);
  if (record.phase === "complete") {
    const current = await privateJson(paths, paths.currentMetadata), previous = await privateJson(paths, paths.previousMetadata);
    const currentSecret = await privateJson(paths, paths.currentSecret), previousSecret = await privateJson(paths, paths.previousSecret);
    if (!same(current, record.current) || !same(previous, record.previous)
      || sha256Text(currentSecret?.token ?? "") !== record.to.token_digest || sha256Text(previousSecret?.token ?? "") !== record.from.token_digest
      || await pathType(paths.pendingMetadata) !== "missing" || await pathType(paths.pendingSecret) !== "missing") {
      fail("IDENTITY_SWITCH_STATE_CONFLICT", "Completed transition no longer matches the current and previous Credential slots");
    }
    return result(record, verification, true);
  }
  return result(await applyTransition(input, paths, record, tokens), verification, resumed);
}

export async function resumeOwnerIdentitySwitch(input, paths, record, verifyTarget) {
  if (record.kind !== "owner_device") fail("IDENTITY_SWITCH_INCOMPLETE", "Resume the pending previous-identity restoration with its original expected current IDs");
  return continueTransition(input, paths, record, verifyTarget, true);
}

export async function switchPendingOwnerIdentity(input, paths, pending, verifyTarget) {
  const replacement = pending.metadata.owner_device_replacement;
  const current = await loadCurrentCredentialSecret(input);
  if (!replacement || !same(replacement, { principal_id: current.metadata.principal_id, credential_id: current.metadata.credential_id,
    fingerprint: current.metadata.fingerprint, token_digest: current.metadata.token_digest, metadata_digest: canonicalDigest(current.metadata) })) {
    fail("STATE_CURRENT_CONFLICT", "Current identity changed after the explicit Owner-device replacement was prepared");
  }
  await noPrevious(paths);
  const verification = await verifyTarget(pending);
  if (verification.failure) return { verification: verification.failure, credential: credentialMetadataView(pending.metadata), secret_values_exposed: false };
  const instance = await privateJson(paths, paths.instanceMetadata);
  const record = transitionRecord(input, instance, "owner_device", current.metadata, pending.metadata, pending.metadata);
  await readTransitionState(input, paths, record);
  await atomicWriteJson(paths.identitySwitch, record);
  return continueTransition(input, paths, record, verifyTarget, false, verification);
}

export async function restorePreviousIdentity(input, paths, verifyTarget) {
  const expectedPrincipal = requireUuid(input.expectedCurrentPrincipalId, "expected_current_principal_id");
  const expectedCredential = requireUuid(input.expectedCurrentCredentialId, "expected_current_credential_id");
  const saved = await readIdentitySwitch(input, paths);
  if (saved?.kind === "restore_previous" && saved.from.principal_id === expectedPrincipal && saved.from.credential_id === expectedCredential) {
    return continueTransition(input, paths, saved, verifyTarget, true);
  }
  if (saved && saved.phase !== "complete") fail("IDENTITY_SWITCH_INCOMPLETE", "Resume the original identity transition before restoring another identity");
  const current = await loadCurrentCredentialSecret(input);
  if (current.metadata.principal_id !== expectedPrincipal || current.metadata.credential_id !== expectedCredential) fail("STATE_CURRENT_CONFLICT", "Current identity differs from the identity explicitly selected for restoration");
  if (await pathType(paths.pendingMetadata) !== "missing" || await pathType(paths.pendingSecret) !== "missing") fail("STATE_PENDING_CONFLICT", "Resolve the existing pending Credential before restoring the previous identity");
  const previous = await privateJson(paths, paths.previousMetadata), secret = await privateJson(paths, paths.previousSecret);
  assertMetadata(previous, input.instanceId);
  if (previous.state !== "previous" || !secret || typeof secret.token !== "string" || sha256Text(secret.token) !== previous.token_digest) fail("STATE_SECRET_MISMATCH", "Previous Credential does not match its private restoration metadata");
  const instance = await privateJson(paths, paths.instanceMetadata);
  if (previous.identity_restore?.trusted_api_origin !== instance.trusted_api_origin || previous.identity_restore?.origin_version !== instance.origin_version) fail("STATE_INSTANCE_CONFLICT", "Previous identity was saved under a different trusted origin; preserve it for explicit recovery");
  const verification = await verifyTarget({ metadata: previous, token: secret.token });
  if (verification.failure) return { verification: verification.failure, credential: credentialMetadataView(current.metadata), secret_values_exposed: false };
  const pending = { ...current.metadata, state: "pending", purpose: "identity_restore", operation_id: randomUUID() };
  const record = transitionRecord(input, instance, "restore_previous", current.metadata, previous, pending);
  await readTransitionState(input, paths, record);
  await atomicWriteJson(paths.identitySwitch, record);
  return continueTransition(input, paths, record, verifyTarget, false, verification);
}
