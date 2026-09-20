import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import { readD1ResourceByName, readWorkerResourceByName, readWorkerVersionById } from "./deploy.mjs";
import { requestJson } from "./deployment-finalize.mjs";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { fetchDiscovery, validateDiscovery } from "./rebind.mjs";
import { createPendingCredential, getInstancePaths, initializeStateRoot, loadCurrentCredentialSecret, loadPendingCredentialSecret, promotePendingCredential, putInstanceMetadata, validatePrivatePath } from "./state.mjs";
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, ensurePrivateDirectory, pathType, readJson, requireHttpsOrigin, requireString, requireUuid } from "./utils.mjs";

const execFileAsync = promisify(execFile);
const MAX_CREDENTIALS = 256;

async function boundedWrangler(executable, args, options) {
  try {
    const result = await execFileAsync(executable, args, { ...options, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch {
    fail("OWNER_RECOVERY_RESOURCE_READBACK_FAILED", "The exact Cloudflare resource could not be verified within the readback bounds");
  }
}
const EFFECTS = Object.freeze({ revoke: "all_previous_owner_api_credentials", passkeys: "preserve", credential_sessions: "invalidated_by_source_revocation", owner_transfer: false, deployment: false, migration: false });

function fail(code = "OWNER_RECOVERY_DRIFT", message = "Owner recovery target or state changed; stop and inspect before creating a new plan") {
  throw toolError(code, message);
}

function targetOf(input) {
  const accountId = requireString(input.accountId, "account_id", { max: 128 });
  if (!/^[A-Za-z0-9_-]+$/u.test(accountId)) fail("INVALID_ACCOUNT_ID", "Invalid Cloudflare account ID");
  const workerName = requireString(input.workerName, "worker_name", { max: 63 });
  if (!/^[A-Za-z0-9_-]+$/u.test(workerName)) fail("INVALID_WORKER_NAME", "Invalid Worker name");
  const target = {
    accountId, workerName,
    d1Name: requireString(input.d1Name, "d1_name", { max: 64 }),
    databaseId: requireUuid(input.databaseId, "database_id"),
    instanceId: requireUuid(input.instanceId, "instance_id"),
    apiOrigin: requireHttpsOrigin(input.apiOrigin),
    wranglerExecutable: requireString(input.wranglerExecutable, "wrangler_executable"),
    cloudflareProfile: input.cloudflareProfile ?? null,
    contextDirectory: input.contextDirectory ?? null,
  };
  if (!path.isAbsolute(target.wranglerExecutable)) fail("ABSOLUTE_PATH_REQUIRED", "Wrangler must be an absolute path");
  if (target.contextDirectory !== null && !path.isAbsolute(target.contextDirectory)) fail("ABSOLUTE_PATH_REQUIRED", "Authentication context must be an absolute private directory");
  if (target.cloudflareProfile !== null && !/^[A-Za-z0-9_-]{1,128}$/u.test(target.cloudflareProfile)) fail("INVALID_WRANGLER_PROFILE", "Invalid frozen profile");
  if ((target.cloudflareProfile === null) === (target.contextDirectory === null)) fail("OWNER_RECOVERY_AUTH_CONTEXT_REQUIRED", "Choose one exact profile or private context directory");
  return target;
}

async function query(client, statements) {
  const result = await client("/query", { method: "POST", body: { batch: statements } });
  if (!Array.isArray(result) || result.length !== statements.length || result.some((entry) => entry?.success !== true || !Array.isArray(entry.results))) {
    fail("OWNER_RECOVERY_READBACK_INVALID", "D1 did not return the exact successful query results");
  }
  return result.map((entry) => entry.results);
}

const SNAPSHOT_SQL = `SELECT m.instance_id, m.owner_principal_id, m.service_version, m.schema_version,
 p.display_name, p.version AS principal_version, s.preferred_api_origin, s.version AS origin_version,
 (SELECT COUNT(*) FROM credentials WHERE principal_id = m.owner_principal_id AND revoked_at IS NULL) AS active_count,
 (SELECT json_group_array(id) FROM (SELECT id FROM credentials WHERE principal_id = m.owner_principal_id AND revoked_at IS NULL ORDER BY id LIMIT 257)) AS active_ids
 FROM instance_meta m JOIN principals p ON p.id = m.owner_principal_id
 JOIN instance_origin_settings s ON s.singleton = m.singleton WHERE m.singleton = 1`;

async function snapshot(client, target) {
  const [rows] = await query(client, [{ sql: SNAPSHOT_SQL, params: [] }]);
  if (rows.length !== 1) fail("OWNER_RECOVERY_INSTANCE_INVALID", "D1 must contain exactly one existing Owner and origin setting");
  const row = rows[0];
  let ids;
  try { ids = JSON.parse(row.active_ids); } catch { fail("OWNER_RECOVERY_READBACK_INVALID", "Invalid Credential inventory"); }
  if (!Array.isArray(ids) || !Number.isSafeInteger(row.active_count) || row.active_count > MAX_CREDENTIALS || ids.length !== row.active_count
    || new Set(ids).size !== ids.length || JSON.stringify([...ids].sort()) !== JSON.stringify(ids)) fail("OWNER_RECOVERY_READBACK_INVALID", "Credential inventory is invalid or exceeds the supported recovery bound");
  ids.forEach((id) => requireUuid(id, "credential_id"));
  if (row.instance_id !== target.instanceId || requireHttpsOrigin(row.preferred_api_origin) !== target.apiOrigin) fail();
  if (!Number.isSafeInteger(row.schema_version) || row.schema_version < 1 || row.schema_version > 7) fail("OWNER_RECOVERY_SCHEMA_UNSUPPORTED", "This Skill does not support the deployed schema for Owner recovery");
  if (!Number.isSafeInteger(row.origin_version) || row.origin_version < 1 || !Number.isSafeInteger(row.principal_version) || row.principal_version < 1) fail();
  return {
    instance_id: target.instanceId,
    owner_principal_id: requireUuid(row.owner_principal_id, "owner_principal_id"),
    display_name: requireString(row.display_name, "display_name", { max: 128 }),
    principal_version: row.principal_version,
    service_version: requireString(row.service_version, "service_version", { max: 128 }),
    schema_version: row.schema_version,
    preferred_api_origin: target.apiOrigin,
    origin_version: row.origin_version,
    active_credential_ids: ids,
  };
}

async function control(target, options) {
  return createCloudflareControlClient({ ...options, ...target }, `/d1/database/${target.databaseId}`, { errorPrefix: "OWNER_RECOVERY", resourceLabel: "D1 Owner recovery" });
}

async function verifyResources(target, options) {
  if (target.contextDirectory !== null) {
    await assertNoSymlinkPath(target.contextDirectory, path.parse(target.contextDirectory).root);
    await validatePrivatePath(target.contextDirectory, "directory");
  }
  const args = { ...options, ...target, runner: options.runner ?? boundedWrangler };
  const d1 = await readD1ResourceByName(args);
  if (d1.status !== "present" || d1.database_id !== target.databaseId) fail();
  const worker = await readWorkerResourceByName(args);
  if (worker.status !== "present") fail();
  const version = await readWorkerVersionById({ ...args, versionId: worker.version_id });
  const databases = version.bindings.filter((binding) => binding.type === "d1");
  if (databases.length !== 1 || databases[0].name !== "DB" || databases[0].database_id !== target.databaseId) fail();
  return { worker_version_id: worker.version_id, bindings_digest: canonicalDigest(version.bindings) };
}

async function verifyPublic(target, observed, fetchImpl) {
  const discovery = validateDiscovery(await fetchDiscovery(target.apiOrigin, fetchImpl), target.apiOrigin);
  const health = await requestJson(target.apiOrigin, "/healthz", { fetchImpl });
  if (discovery.instance_id !== target.instanceId || discovery.preferred_api_origin !== target.apiOrigin
    || discovery.origin_version !== observed.origin_version || discovery.service_version !== observed.service_version
    || health.d1 !== "reachable" || health.schema_version !== observed.schema_version || health.service_version !== observed.service_version) fail();
}

export async function inspectOwnerRecovery(input) {
  const target = targetOf(input);
  const resources = await verifyResources(target, input);
  const observed = await snapshot(await control(target, input), target);
  await verifyPublic(target, observed, input.fetchImpl ?? globalThis.fetch);
  return { target, resources, observed, effects: { ...EFFECTS }, secret_values_exposed: false };
}

export async function createOwnerRecoveryPlan(input) {
  const evidence = await inspectOwnerRecovery(input);
  const storage = recoveryStorage(input);
  const plan = {
    kind: "owner_credential_recovery", schema_version: 1,
    task_id: requireString(input.taskId, "task_id", { max: 128 }),
    operation_id: randomUUID(), credential_id: randomUUID(), event_id: randomUUID(),
    ...evidence,
    credential_storage: storage,
    execution: { mode: "cloudflare_d1_query_batch", retry: "readback_before_same_operation_retry" },
  };
  return { plan, plan_digest: canonicalDigest(plan) };
}

function recoveryStorage(input) {
  const stateRoot = path.resolve(input.stateRoot ?? resolveStateRoot());
  const paths = getInstancePaths({ stateRoot, instanceId: input.instanceId });
  return { state_root: stateRoot, pending_secret: paths.pendingSecret, current_secret: paths.currentSecret };
}

function validatePlan(input) {
  const plan = input.plan;
  if (plan?.kind !== "owner_credential_recovery" || plan.schema_version !== 1 || plan.task_id !== input.taskId
    || plan.operation_id !== input.operationId || plan.target?.instanceId !== input.instanceId
    || canonicalDigest(plan.effects) !== canonicalDigest(EFFECTS)
    || canonicalDigest(plan.credential_storage) !== canonicalDigest(recoveryStorage(input))
    || plan.execution?.mode !== "cloudflare_d1_query_batch" || plan.execution?.retry !== "readback_before_same_operation_retry") fail("OWNER_RECOVERY_PLAN_INVALID", "Use the dedicated Owner recovery plan and its exact task, operation and effects");
  requireUuid(plan.operation_id, "operation_id"); requireUuid(plan.credential_id, "credential_id"); requireUuid(plan.event_id, "event_id");
  return { plan, target: targetOf(plan.target), digest: canonicalDigest(plan) };
}

function matches(metadata, plan) {
  return metadata?.instance_id === plan.target.instanceId && metadata.principal_id === plan.observed.owner_principal_id
    && metadata.credential_id === plan.credential_id && metadata.operation_id === plan.operation_id
    && metadata.purpose === "owner_recovery" && metadata.credential_id_binding === "exact";
}

async function loadRecoveryCredential(input, plan, create) {
  const paths = getInstancePaths(input);
  const current = await readJson(paths.currentMetadata, { allowMissing: true });
  const pending = await readJson(paths.pendingMetadata, { allowMissing: true });
  if (current !== null && current.principal_id !== plan.observed.owner_principal_id) fail("STATE_IDENTITY_CONFLICT", "A different local Principal already occupies this instance");
  if (pending !== null) {
    if (!matches(pending, plan)) fail("STATE_PENDING_CONFLICT", "Resolve the existing pending operation before Owner recovery");
    // 提升先写完 current 再删除 pending；两次删除之间中断时复用完整 current。
    if (await pathType(paths.pendingSecret) === "missing" && matches(current, plan)) return loadCurrentCredentialSecret(input);
    return loadPendingCredentialSecret(input);
  }
  if (matches(current, plan)) return loadCurrentCredentialSecret(input);
  if (await pathType(paths.currentSecret) !== "missing") fail("OWNER_RECOVERY_CURRENT_EXISTS", "A local Credential still exists; verify it and use normal rotation instead of total-loss recovery");
  if (await pathType(paths.pendingSecret) !== "missing") fail("STATE_PENDING_CONFLICT", "An unresolved pending secret exists without its metadata; do not overwrite it");
  if (!create) fail("OWNER_RECOVERY_SECRET_MISSING", "This recovery already prepared a secret; restore its private pending/current files before continuing");
  await createPendingCredential({ ...input, principalId: plan.observed.owner_principal_id, credentialId: plan.credential_id,
    operationId: plan.operation_id, idempotencyKey: plan.operation_id, purpose: "owner_recovery" });
  return loadPendingCredentialSecret(input);
}

// 条件与写入共用一个 D1 batch；active 集合变化时不写入，避免撤销并发签发的凭据。
export function buildOwnerRecoveryBatch(plan, metadata, now) {
  const before = plan.observed;
  const operation = plan.operation_id;
  const replacement = plan.credential_id;
  const owner = before.owner_principal_id;
  const payload = JSON.stringify({ owner_principal_id: owner, credential_id: replacement, revoked_credential_ids: before.active_credential_ids, passkeys: "preserve", plan_digest: canonicalDigest(plan) });
  return [
    { sql: `INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
      SELECT ?1, m.owner_principal_id, ?2, ?3, ?4, ?5 FROM instance_meta m
      JOIN principals p ON p.id = m.owner_principal_id JOIN instance_origin_settings s ON s.singleton = m.singleton
      WHERE m.singleton = 1 AND m.instance_id = ?6 AND m.owner_principal_id = ?7
      AND m.service_version = ?8 AND m.schema_version = ?9 AND p.version = ?10 AND p.display_name = ?11
      AND s.preferred_api_origin = ?12 AND s.version = ?13
      AND (SELECT json_group_array(id) FROM (SELECT id FROM credentials WHERE principal_id = ?7 AND revoked_at IS NULL ORDER BY id)) = ?14
      AND NOT EXISTS (SELECT 1 FROM operation_commits WHERE operation_id = ?5)
      AND NOT EXISTS (SELECT 1 FROM events WHERE operation_id = ?5)
      AND NOT EXISTS (SELECT 1 FROM credentials WHERE id = ?1 OR created_operation_id = ?5)`,
      params: [replacement, metadata.token_prefix, metadata.token_digest, now, operation, before.instance_id, owner, before.service_version, before.schema_version, before.principal_version, before.display_name, before.preferred_api_origin, before.origin_version, JSON.stringify(before.active_credential_ids)] },
    { sql: `UPDATE credentials SET revoked_at = ?1, revoked_by_principal_id = ?2, revoke_reason = 'owner_full_recovery', last_operation_id = ?3
      WHERE principal_id = ?2 AND revoked_at IS NULL AND id != ?4
      AND EXISTS (SELECT 1 FROM credentials WHERE id = ?4 AND created_operation_id = ?3 AND token_digest = ?5 AND revoked_at IS NULL)`,
      params: [now, owner, operation, replacement, metadata.token_digest] },
    { sql: `INSERT INTO events (id, stream, type, operation_id, event_index, actor_principal_id, actor_credential_id, authorized_via, subject_type, subject_id, payload_json, created_at)
      SELECT ?1, 'security', 'owner.credential_recovered', ?2, 0, ?3, ?4, 'deployment_recovery', 'credential', ?4, ?5, ?6
      WHERE EXISTS (SELECT 1 FROM credentials WHERE id = ?4 AND created_operation_id = ?2 AND token_digest = ?7 AND revoked_at IS NULL)`,
      params: [plan.event_id, operation, owner, replacement, payload, now, metadata.token_digest] },
    { sql: `INSERT INTO operation_commits (operation_id, primary_subject_type, primary_subject_id, last_event_sequence, committed_at)
      SELECT ?1, 'credential', ?2, sequence, ?3 FROM events WHERE id = ?4 AND operation_id = ?1`,
      params: [operation, replacement, now, plan.event_id] },
  ];
}

async function recoveryOutcome(client, plan, metadata) {
  const [rows] = await query(client, [{ sql: `SELECT
    (SELECT COUNT(*) FROM credentials WHERE id = ?1 OR created_operation_id = ?2) AS credential_count,
    (SELECT COUNT(*) FROM events WHERE operation_id = ?2 OR id = ?3) AS event_count,
    (SELECT COUNT(*) FROM operation_commits WHERE operation_id = ?2) AS commit_count,
    (SELECT COUNT(*) FROM credentials WHERE id = ?1 AND created_operation_id = ?2 AND principal_id = ?4 AND token_digest = ?5 AND token_prefix = ?6 AND revoked_at IS NULL) AS credential_matches,
    (SELECT COUNT(*) FROM events e JOIN operation_commits o ON o.operation_id = e.operation_id AND o.last_event_sequence = e.sequence
      WHERE e.id = ?3 AND e.operation_id = ?2 AND e.stream = 'security' AND e.type = 'owner.credential_recovered'
      AND e.authorized_via = 'deployment_recovery' AND e.actor_principal_id = ?4 AND e.actor_credential_id = ?1
      AND e.subject_type = 'credential' AND e.subject_id = ?1 AND json_extract(e.payload_json, '$.plan_digest') = ?7
      AND o.primary_subject_type = 'credential' AND o.primary_subject_id = ?1) AS audit_matches,
    (SELECT COUNT(*) FROM credentials WHERE id IN (SELECT value FROM json_each(?8)) AND principal_id = ?4 AND revoked_at IS NOT NULL AND last_operation_id = ?2 AND revoke_reason = 'owner_full_recovery') AS revoked_count`,
    params: [plan.credential_id, plan.operation_id, plan.event_id, plan.observed.owner_principal_id, metadata.token_digest, metadata.token_prefix, canonicalDigest(plan), JSON.stringify(plan.observed.active_credential_ids)] }]);
  const row = rows[0];
  if (rows.length !== 1 || Object.values(row).some((v) => !Number.isSafeInteger(v) || v < 0)) fail("OWNER_RECOVERY_READBACK_INVALID", "Invalid operation readback");
  if (row.credential_count === 0 && row.event_count === 0 && row.commit_count === 0 && row.revoked_count === 0) return "absent";
  if (row.credential_count === 1 && row.event_count === 1 && row.commit_count === 1 && row.credential_matches === 1 && row.audit_matches === 1 && row.revoked_count === plan.observed.active_credential_ids.length) return "committed";
  fail("OWNER_RECOVERY_PARTIAL_OR_CONFLICT", "Recovery evidence is partial, conflicting, or its replacement Credential was revoked; preserve local files and stop");
}

async function finalize(input, plan, credential, observed) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  await verifyPublic(plan.target, observed, fetchImpl);
  const options = { token: credential.token, fetchImpl };
  const meta = await requestJson(plan.target.apiOrigin, "/api/v1/meta", options);
  const me = await requestJson(plan.target.apiOrigin, "/api/v1/me", options);
  if (meta.instance_id !== plan.target.instanceId || meta.observed_origin !== plan.target.apiOrigin || meta.preferred_api_origin !== plan.target.apiOrigin
    || meta.origin_version !== observed.origin_version || meta.service_version !== observed.service_version || meta.schema_version !== observed.schema_version
    || meta.principal?.id !== observed.owner_principal_id || meta.principal?.is_owner !== true
    || me.id !== observed.owner_principal_id || me.principal_id !== observed.owner_principal_id || me.is_owner !== true
    || me.credential?.id !== plan.credential_id || me.credential?.fingerprint !== credential.metadata.fingerprint) fail("OWNER_RECOVERY_VERIFICATION_FAILED", "Authenticated Instance/Owner/Credential readback did not match the recovery plan");
  const paths = getInstancePaths(input);
  const existing = await readJson(paths.instanceMetadata, { allowMissing: true });
  if (existing !== null && (existing.instance_id !== input.instanceId || existing.trusted_api_origin !== plan.target.apiOrigin)) fail("STATE_INSTANCE_CONFLICT", "Existing trusted instance metadata conflicts with the recovered target");
  await putInstanceMetadata({ ...input, trustedApiOrigin: plan.target.apiOrigin, originVersion: observed.origin_version,
    serviceVersion: observed.service_version, schemaVersion: observed.schema_version, publisher: existing?.publisher ?? null });
  if (credential.metadata.state === "pending") await promotePendingCredential({ ...input, principalId: observed.owner_principal_id, credentialId: plan.credential_id, fingerprint: credential.metadata.fingerprint });
  if (credential.metadata.state === "current" && await pathType(paths.pendingSecret) === "missing") {
    const leftover = await readJson(paths.pendingMetadata, { allowMissing: true });
    if (matches(leftover, plan)) await rm(paths.pendingMetadata);
  }
  const receipt = { kind: "cfkanban_owner_recovery_receipt", schema_version: 1, instance_id: input.instanceId,
    operation_id: input.operationId, plan_digest: canonicalDigest(plan), target: plan.target, owner_principal_id: observed.owner_principal_id,
    credential_id: plan.credential_id, credential_fingerprint: credential.metadata.fingerprint, effects: plan.effects, secret_values_exposed: false };
  await assertNoSymlinkPath(paths.receiptsRoot, input.stateRoot);
  await ensurePrivateDirectory(paths.receiptsRoot);
  await validatePrivatePath(paths.receiptsRoot, "directory");
  const receiptPath = path.join(paths.receiptsRoot, `${input.operationId}.owner-recovery.json`);
  await atomicWriteJson(receiptPath, receipt);
  await appendJournalEvent({ ...input, event: { type: "owner_recovery_finalized", receipt_path: receiptPath, credential_id: plan.credential_id } });
  return { ...receipt, receipt_path: receiptPath, state: "current" };
}

export async function executeOwnerRecovery(options) {
  const input = { ...options, stateRoot: options.stateRoot ?? resolveStateRoot() };
  const { plan, target } = validatePlan(input);
  await initializeStateRoot(input);
  const paths = getInstancePaths(input);
  await assertNoSymlinkPath(paths.journalsRoot, input.stateRoot);
  await validatePrivatePath(paths.journalsRoot, "directory");
  const journalPath = path.join(paths.journalsRoot, `${input.operationId}.json`);
  await validatePrivatePath(journalPath, "file");
  const journal = await assertJournalAuthorization(input);
  await assertNoSymlinkPath(paths.credentialsRoot, input.stateRoot);
  await ensurePrivateDirectory(paths.credentialsRoot);
  await validatePrivatePath(paths.credentialsRoot, "directory");
  for (const file of [paths.instanceMetadata, paths.currentMetadata, paths.currentSecret, paths.pendingMetadata, paths.pendingSecret]) {
    await assertNoSymlinkPath(file, input.stateRoot);
    if (await pathType(file) !== "missing") await validatePrivatePath(file, "file");
  }
  const lockPath = path.join(paths.credentialsRoot, "owner-recovery.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { fail("OWNER_RECOVERY_LOCKED", "Another recovery may be running; if interrupted, verify that process stopped before removing the private lock"); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, operation_id: input.operationId }));
    const resources = await verifyResources(target, input);
    if (canonicalDigest(resources) !== canonicalDigest(plan.resources)) fail();
    const client = await control(target, input);
    const before = await snapshot(client, target);
    const stable = { ...before, active_credential_ids: plan.observed.active_credential_ids };
    if (canonicalDigest(stable) !== canonicalDigest(plan.observed)) fail();
    await verifyPublic(target, before, input.fetchImpl ?? globalThis.fetch);
    const metadata = await readJson(paths.instanceMetadata, { allowMissing: true });
    if (metadata !== null && (metadata.instance_id !== input.instanceId || metadata.trusted_api_origin !== target.apiOrigin)) fail("STATE_INSTANCE_CONFLICT", "Local trusted origin differs from the explicit recovery target; resolve it before recovery");
    const previouslyPrepared = journal.events.some((e) => ["owner_recovery_prepared", "owner_recovery_attempt_started"].includes(e.type));
    const credential = await loadRecoveryCredential(input, plan, !previouslyPrepared);
    let outcome = await recoveryOutcome(client, plan, credential.metadata);
    if (outcome === "absent") {
      if (canonicalDigest(before) !== canonicalDigest(plan.observed) || credential.metadata.state !== "pending") fail();
      await appendJournalEvent({ ...input, event: { type: "owner_recovery_prepared", credential_id: plan.credential_id, credential_fingerprint: credential.metadata.fingerprint } });
      await appendJournalEvent({ ...input, event: { type: "owner_recovery_attempt_started" } });
      await query(client, buildOwnerRecoveryBatch(plan, credential.metadata, Date.now()));
      outcome = await recoveryOutcome(client, plan, credential.metadata);
      if (outcome !== "committed") fail("OWNER_RECOVERY_NOT_COMMITTED", "The atomic recovery guard rejected a concurrent change; no new authorization is inferred");
    }
    const after = await snapshot(client, target);
    if (canonicalDigest(after) !== canonicalDigest({ ...plan.observed, active_credential_ids: [plan.credential_id] })) fail();
    await appendJournalEvent({ ...input, event: { type: "owner_recovery_committed", credential_id: plan.credential_id } });
    return await finalize(input, plan, credential, after);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
