import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import { parseMigrationReadbackOutput, readD1ResourceByName, readWorkerResourceByName, readWorkerVersionById } from "./deploy.mjs";
import { loadActiveSkillEvidence, requestJson } from "./deployment-finalize.mjs";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { reconcileMigrationState } from "./migrations.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { requireObservedPrincipalDisplayName } from "./principal-name.mjs";
import { readR2Storage, ATTACHMENT_CLEANUP_CRON } from "./r2-storage.mjs";
import { fetchDiscovery, validateDiscovery } from "./rebind.mjs";
import { verifyInstalledServiceBundle } from "./service-bundle.mjs";
import { readServiceReleaseVersion } from "./service-release-version.mjs";
import { getInstancePaths, initializeStateRoot, loadCurrentCredentialSecret, putInstanceMetadata, validatePrivatePath } from "./state.mjs";
import { currentBindingReadback } from "./upgrade-plan.mjs";
import { normalizePublicAccess } from "./public-access-config.mjs";
import { verifyPublicAccessConfiguration } from "./public-access.mjs";
import { existingUsageConfig, USAGE_SECRET } from "./usage-config.mjs";
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, ensurePrivateDirectory, pathType, readJson, requireHttpsOrigin, requireString, requireUuid, sha256Bytes } from "./utils.mjs";

const execFileAsync = promisify(execFile);
const EFFECTS = Object.freeze({ remote_writes: false, credential_creation: false, credential_revocation: false, deployment: false, migration: false, local_deployment_registration: true });
const CONTROL_OPTIONS = { errorPrefix: "DEPLOYMENT_ATTACH", resourceLabel: "deployment inspection" };
const MARKER_SQL = `SELECT m.instance_id, m.owner_principal_id, m.service_version, m.schema_version,
 p.display_name, p.version AS principal_version, s.preferred_api_origin, s.version AS origin_version
 FROM instance_meta m JOIN principals p ON p.id = m.owner_principal_id
 JOIN instance_origin_settings s ON s.singleton = m.singleton WHERE m.singleton = 1 LIMIT 2`;
const MIGRATION_SQL = [
  "SELECT sequence, name, sha256, classification, reentry, operation_id, applied_at FROM cfkanban_migration_ledger ORDER BY sequence LIMIT 1025",
  `SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%'
   UNION ALL SELECT 'column' AS type, target.name || '.' || info.name AS name FROM sqlite_master AS target
   JOIN pragma_table_info(target.name) AS info WHERE target.type = 'table'
   AND target.name NOT GLOB '_cf_*' AND target.name NOT GLOB 'sqlite_*' ORDER BY type, name LIMIT 4097`,
  "SELECT COUNT(*) AS row_count, MAX(schema_version) AS schema_version FROM instance_meta",
];
function fail(code = "DEPLOYMENT_ATTACH_DRIFT", message = "Deployment evidence changed or does not match the exact selected Instance") { throw toolError(code, message); }
async function boundedRunner(executable, args, options) {
  try { const result = await execFileAsync(executable, args, { ...options, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" }); return { code: 0, stdout: result.stdout, stderr: "" }; }
  catch { fail("DEPLOYMENT_ATTACH_READBACK_FAILED", "The selected Cloudflare resources could not be inspected within the readback bounds"); }
}
function targetOf(input) {
  const target = { accountId: requireString(input.accountId, "account_id", { max: 128 }), workerName: requireString(input.workerName, "worker_name", { max: 63 }),
    d1Name: requireString(input.d1Name, "d1_name", { max: 63 }), databaseId: requireUuid(input.databaseId, "database_id"), instanceId: requireUuid(input.instanceId, "instance_id"),
    apiOrigin: requireHttpsOrigin(input.apiOrigin), wranglerExecutable: requireString(input.wranglerExecutable, "wrangler_executable"),
    cloudflareProfile: input.cloudflareProfile ?? null, contextDirectory: input.contextDirectory ?? null };
  if (!/^[A-Za-z0-9_-]+$/u.test(target.accountId) || ![target.workerName, target.d1Name].every(name => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name))) fail("INVALID_DEPLOYMENT_ATTACH_TARGET", "Use exact account and resource identifiers");
  if (!path.isAbsolute(target.wranglerExecutable) || (target.contextDirectory !== null && !path.isAbsolute(target.contextDirectory))) fail("ABSOLUTE_PATH_REQUIRED", "Wrangler and private authentication context paths must be absolute");
  if ((target.cloudflareProfile === null) === (target.contextDirectory === null)) fail("DEPLOYMENT_ATTACH_AUTH_CONTEXT_REQUIRED", "Choose one exact profile or private context directory");
  if (target.cloudflareProfile !== null && !/^[A-Za-z0-9_-]{1,128}$/u.test(target.cloudflareProfile)) fail("INVALID_WRANGLER_PROFILE", "Invalid selected profile");
  return target;
}
function baselineOf(input) {
  const value = input.baselineBundle;
  if (!value || !path.isAbsolute(value.bundleRoot ?? "")) fail("DEPLOYMENT_ATTACH_BASELINE_REQUIRED", "Provide an installed verified release bundle matching the running release version");
  return { bundleRoot: path.resolve(value.bundleRoot), version: requireString(value.version, "baseline_version", { max: 128 }), sha256: requireString(value.sha256, "baseline_sha256", { max: 64 }), publisher: requireHttpsOrigin(value.publisher), source: requireString(value.source, "baseline_source") };
}
async function query(client, statements) {
  const results = await client("/query", { method: "POST", body: { batch: statements.map(sql => ({ sql, params: [] })) } });
  if (!Array.isArray(results) || results.length !== statements.length || results.some(row => row?.success !== true || !Array.isArray(row.results))) fail("DEPLOYMENT_ATTACH_READBACK_INVALID", "D1 returned incomplete inspection results");
  return results;
}
async function localContext(input, target, baseline) {
  const stateRoot = path.resolve(input.stateRoot ?? resolveStateRoot());
  const paths = getInstancePaths({ stateRoot, instanceId: target.instanceId });
  await assertNoSymlinkPath(paths.instanceMetadata, stateRoot);
  if (await pathType(stateRoot) !== "missing") await validatePrivatePath(stateRoot, "directory");
  if (await pathType(paths.instanceMetadata) !== "missing") await validatePrivatePath(paths.instanceMetadata, "file");
  if (await pathType(paths.pendingMetadata) !== "missing" || await pathType(paths.pendingSecret) !== "missing") fail("STATE_PENDING_CONFLICT", "Resolve the pending Credential operation before attaching this deployment");
  const metadata = await readJson(paths.instanceMetadata, { allowMissing: true });
  if (metadata !== null) {
    if (metadata.instance_id !== target.instanceId || metadata.trusted_api_origin !== target.apiOrigin) fail("STATE_INSTANCE_CONFLICT", "The selected origin differs from this Instance's trusted local origin; use the origin migration flow first");
  }
  const publisher = metadata?.publisher ?? input.publisher ?? (await loadActiveSkillEvidence(stateRoot)).publisher;
  if (requireHttpsOrigin(publisher) !== baseline.publisher) fail("PUBLISHER_DISCONTINUITY", "The baseline publisher differs from the trusted or explicitly selected publisher");
  if (input.publisher !== undefined && requireHttpsOrigin(input.publisher) !== publisher) fail("PUBLISHER_DISCONTINUITY", "The requested publisher differs from existing trust");
  return { stateRoot, paths, metadata, publisher };
}
async function inspectRouting(connection, target) {
  if (connection.publicAccessReceipt) {
    const access = normalizePublicAccess(connection.publicAccessReceipt, { instanceId: target.instanceId, accountId: target.accountId, workerName: target.workerName });
    if (target.apiOrigin !== access.preferred_api_origin) fail("DEPLOYMENT_ATTACH_ORIGIN_UNPROVEN", "The trusted origin differs from the supplied public-access receipt");
    await verifyPublicAccessConfiguration({ ...connection, publicAccessReceipt: access, publicAccessTarget: {
      instance_id: target.instanceId, account_id: target.accountId, worker_name: target.workerName, database_id: target.databaseId,
      zone_id: access.zone_id, hostname: access.hostname, wrangler_executable: target.wranglerExecutable, cloudflare_profile: target.cloudflareProfile, context_directory: target.contextDirectory,
    } });
    return { workers_dev: !access.domain_enabled, previews_enabled: false, workers_dev_origin: access.workers_dev_origin, custom_domains: access.domain_enabled ? [{ hostname: access.hostname, environment: "production" }] : [], routes: [], management: "preserve_existing", public_access: access };
  }
  const client = await createCloudflareControlClient(connection, "/workers", CONTROL_OPTIONS);
  const [account, subdomain, domainResponse, routeResponse] = await Promise.all([
    client("/subdomain"), client(`/scripts/${target.workerName}/subdomain`), client("/domains", { raw: true }),
    client(`/services/${target.workerName}/environments/production/routes`, { raw: true }),
  ]);
  for (const response of [domainResponse, routeResponse]) {
    if (response?.success !== true || !Array.isArray(response.result) || (response.result_info?.total_pages ?? 1) > 1
      || (response.result_info?.total_count !== undefined && response.result_info.total_count !== response.result.length)) fail("DEPLOYMENT_ATTACH_ROUTING_INCOMPLETE", "The domain or route inventory is incomplete; do not infer an empty inventory from a partial page");
  }
  const domains = domainResponse.result, routes = routeResponse.result;
  if (!/^[a-z0-9-]+$/u.test(account?.subdomain ?? "") || typeof subdomain?.enabled !== "boolean" || !Array.isArray(domains) || domains.length > 1000 || !Array.isArray(routes) || routes.length !== 0) fail("DEPLOYMENT_ATTACH_ROUTING_UNSUPPORTED", "Inspect bounded domain metadata and resolve nonempty Worker routes before attaching");
  const selected = domains.filter(domain => domain?.service === target.workerName);
  const normalized = selected.map(domain => {
    if (domain.environment !== "production" || typeof domain.hostname !== "string" || !/^[a-z0-9.-]+$/u.test(domain.hostname)) fail("DEPLOYMENT_ATTACH_ROUTING_UNSUPPORTED", "The selected Worker has an unsupported domain mapping");
    return { hostname: domain.hostname, environment: domain.environment };
  }).sort((a, b) => a.hostname.localeCompare(b.hostname));
  if (new Set(normalized.map(domain => domain.hostname)).size !== normalized.length) fail("DEPLOYMENT_ATTACH_ROUTING_UNSUPPORTED", "Duplicate domain mappings are ambiguous");
  const workersOrigin = `https://${target.workerName}.${account.subdomain}.workers.dev`;
  if (subdomain.enabled !== true || (target.apiOrigin !== workersOrigin && !normalized.some(domain => `https://${domain.hostname}` === target.apiOrigin))) fail("DEPLOYMENT_ATTACH_ORIGIN_UNPROVEN", "The trusted origin is not mapped to the selected Worker");
  return { workers_dev: true, workers_dev_origin: workersOrigin, custom_domains: normalized, routes: [], management: "preserve_existing" };
}
function observedRateLimits(bindings) {
  const vars = Object.fromEntries(bindings.filter(binding => binding.type === "plain_text").map(binding => [binding.name, binding.text]));
  const read = name => { const result = Number(vars[name]); if (!Number.isSafeInteger(result) || result < 1) fail("DEPLOYMENT_ATTACH_BINDINGS_UNSUPPORTED", "Rate-limit configuration must be explicit and positive"); return result; };
  return { principal: { limit: read("RATE_LIMIT_PRINCIPAL_LIMIT"), period_seconds: read("RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS") },
    instance: { limit: read("RATE_LIMIT_INSTANCE_LIMIT"), period_seconds: read("RATE_LIMIT_INSTANCE_PERIOD_SECONDS") },
    unauthenticated_sensitive: { limit: read("RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT"), period_seconds: read("RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS") } };
}

export async function inspectDeploymentAttachment(input) {
  const target = targetOf(input), baseline = baselineOf(input);
  const local = await localContext(input, target, baseline);
  await verifyInstalledServiceBundle({ bundleRoot: baseline.bundleRoot, expectedVersion: baseline.version, expectedSha256: baseline.sha256, expectedPublisher: baseline.publisher, expectedSource: baseline.source });
  if (await readServiceReleaseVersion(baseline.bundleRoot, baseline.version) !== baseline.version) fail("DEPLOYMENT_ATTACH_RELEASE_UNREPORTED", "This flow requires an immutable release declaration");
  const manifestBytes = await readFile(path.join(baseline.bundleRoot, "migrations/manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (target.contextDirectory !== null) { await assertNoSymlinkPath(target.contextDirectory, path.parse(target.contextDirectory).root); await validatePrivatePath(target.contextDirectory, "directory"); }
  const connection = { ...input, ...target, runner: input.runner ?? boundedRunner };
  const d1 = await readD1ResourceByName(connection);
  const worker = await readWorkerResourceByName(connection);
  if (d1.status !== "present" || d1.database_id !== target.databaseId || worker.status !== "present") fail();
  const version = await readWorkerVersionById({ ...connection, versionId: worker.version_id });
  const rateLimits = observedRateLimits(version.bindings);
  const r2Bindings = version.bindings.filter(binding => binding.type === "r2_bucket");
  if (r2Bindings.length > 1 || (r2Bindings[0] && r2Bindings[0].name !== "ATTACHMENTS")) fail("DEPLOYMENT_ATTACH_BINDINGS_UNSUPPORTED", "Only the existing cfKanban attachment binding can be attached");
  const attachments = r2Bindings[0] ? { bucket_name: r2Bindings[0].bucket_name } : null;
  const usage = existingUsageConfig(version.bindings, { accountId: target.accountId, databaseId: target.databaseId, bucketName: attachments?.bucket_name ?? null, workerName: target.workerName });
  const bindings = currentBindingReadback(version.bindings, { d1DatabaseId: target.databaseId, rateLimits, attachments, usageSecret: version.bindings.some(binding => binding.type === "secret_text" && binding.name === USAGE_SECRET) });
  const client = await createCloudflareControlClient(connection, `/d1/database/${target.databaseId}`, CONTROL_OPTIONS);
  const [markers] = await query(client, [MARKER_SQL]);
  if (markers.results.length !== 1) fail();
  const row = markers.results[0];
  if (row.instance_id !== target.instanceId || row.preferred_api_origin !== target.apiOrigin || ![row.schema_version, row.principal_version, row.origin_version].every(value => Number.isSafeInteger(value) && value > 0) || row.schema_version !== manifest.schema_version) fail();
  if ((attachments && row.schema_version < 4) || (usage && row.schema_version < 6)) fail("DEPLOYMENT_ATTACH_BINDINGS_UNSUPPORTED", "Optional bindings require their corresponding applied schema");
  const observed = { instance_id: target.instanceId, owner_principal_id: requireUuid(row.owner_principal_id, "owner_principal_id"), display_name: requireObservedPrincipalDisplayName(row.display_name),
    principal_version: row.principal_version, preferred_api_origin: target.apiOrigin, origin_version: row.origin_version, service_version: requireString(row.service_version, "service_version", { max: 128 }), schema_version: row.schema_version };
  const migration = parseMigrationReadbackOutput(JSON.stringify(await query(client, MIGRATION_SQL)));
  const state = reconcileMigrationState({ manifest, ledger: migration.ledger, schema: migration.schema });
  if (!state.safe_to_continue || state.migrations.some(item => item.state !== "applied")) fail("DEPLOYMENT_ATTACH_MIGRATIONS_UNSAFE", "Existing ledger and schema must prove every baseline migration fully applied; unknown, partial, or missing history cannot be adopted");
  const routing = await inspectRouting(connection, target);
  const scheduleClient = await createCloudflareControlClient(connection, `/workers/scripts/${target.workerName}/schedules`, CONTROL_OPTIONS);
  const schedules = await scheduleClient("");
  const crons = attachments ? [ATTACHMENT_CLEANUP_CRON] : [];
  if (!Array.isArray(schedules?.schedules) || canonicalDigest(schedules.schedules.map(item => item?.cron).sort()) !== canonicalDigest(crons)) fail("DEPLOYMENT_ATTACH_CRON_DRIFT", "Unexpected Worker Cron configuration");
  const r2 = attachments ? await readR2Storage({ ...connection, bucketName: attachments.bucket_name }) : null;
  if (r2 && r2.status !== "present") fail("R2_STORAGE_MISSING", "The attachment bucket is absent");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const discovery = validateDiscovery(await fetchDiscovery(target.apiOrigin, fetchImpl), target.apiOrigin);
  const health = await requestJson(target.apiOrigin, "/healthz", { fetchImpl });
  for (const value of [discovery, health]) if (value.release_version !== baseline.version || value.service_version !== observed.service_version) fail("DEPLOYMENT_ATTACH_RELEASE_DRIFT", "The running release, API and schema must match the inspected baseline");
  if (discovery.instance_id !== target.instanceId || discovery.origin_version !== observed.origin_version || discovery.preferred_api_origin !== target.apiOrigin || health.d1 !== "reachable" || health.schema_version !== observed.schema_version) fail();
  let owner = null;
  if (await pathType(local.paths.currentMetadata) !== "missing" || await pathType(local.paths.currentSecret) !== "missing") {
    if (local.metadata === null) fail("STATE_INSTANCE_CONFLICT", "An existing Credential requires previously trusted Instance metadata");
    const credential = await loadCurrentCredentialSecret({ stateRoot: local.stateRoot, instanceId: target.instanceId });
    const options = { token: credential.token, fetchImpl };
    const me = await requestJson(target.apiOrigin, "/api/v1/me", options);
    const meta = await requestJson(target.apiOrigin, "/api/v1/meta", options);
    if (credential.metadata.state !== "current" || credential.metadata.principal_id !== observed.owner_principal_id
      || me.id !== observed.owner_principal_id || me.principal_id !== observed.owner_principal_id || me.is_owner !== true
      || me.credential?.id !== credential.metadata.credential_id || me.credential?.fingerprint !== credential.metadata.fingerprint
      || meta.instance_id !== target.instanceId || meta.observed_origin !== target.apiOrigin || meta.preferred_api_origin !== target.apiOrigin
      || meta.origin_version !== observed.origin_version || meta.principal?.id !== observed.owner_principal_id || meta.principal?.is_owner !== true
      || meta.release_version !== baseline.version || meta.schema_version !== observed.schema_version || meta.service_version !== observed.service_version
      || Boolean(meta.capabilities?.attachments) !== Boolean(r2)) fail("DEPLOYMENT_ATTACH_OWNER_REQUIRED", "Authenticate the same existing Deployment Owner with a valid current device Credential");
    owner = { principal_id: observed.owner_principal_id, display_name: observed.display_name, credential_id: credential.metadata.credential_id, credential_fingerprint: credential.metadata.fingerprint };
  }
  const finalWorker = await readWorkerResourceByName(connection);
  if (finalWorker.version_id !== worker.version_id || finalWorker.deployment_id !== worker.deployment_id) fail();
  return { target, baseline_bundle: baseline, publisher: local.publisher, observed, owner,
    status: owner ? "ready" : "credential_required", next_action: owner ? "create_local_attachment_plan" : "connect_owner_device_or_use_total_loss_recovery",
    service_release: { provenance: "remote_observed", publisher: local.publisher, manifest_version: null, manifest_sha256: null, service_bundle_version: baseline.version, service_bundle_sha256: null, service_bundle_source: null, service_api_version: observed.service_version, schema_version: observed.schema_version },
    resources: { worker: { name: target.workerName, deployment_id: worker.deployment_id, version_id: worker.version_id, bindings }, d1: { name: target.d1Name, database_id: target.databaseId }, r2: r2 ? { bucket_name: r2.bucket_name, instance_id: r2.instance_id, public_access: false } : null, routing, ...(routing.public_access ? { public_access: routing.public_access } : {}), crons },
    bindings: { d1: "DB", assets: "ASSETS", rate_limits: rateLimits }, usage_analytics: usage,
    migrations: { manifest_sha256: sha256Bytes(manifestBytes), final_ledger: migration.ledger, schema_digest: canonicalDigest(migration.schema), schema_verified: true },
    provenance: { deployed_artifact_verified: false, historical_artifact_source: "unknown", baseline_bundle_used_for: "migration_contract_only" }, effects: { ...EFFECTS }, secret_values_exposed: false };
}

function storageOf(input) {
  const stateRoot = path.resolve(input.stateRoot ?? resolveStateRoot());
  return { state_root: stateRoot, receipts_root: getInstancePaths({ stateRoot, instanceId: input.instanceId }).receiptsRoot };
}
export async function createDeploymentAttachmentPlan(input) {
  const evidence = await inspectDeploymentAttachment(input);
  if (evidence.owner === null) fail("DEPLOYMENT_ATTACH_OWNER_REQUIRED", "Connect an existing Owner device before creating the local attachment plan");
  const plan = { kind: "deployment_attachment", schema_version: 1, task_id: requireString(input.taskId, "task_id", { max: 256 }), operation_id: randomUUID(), evidence, storage: storageOf(input) };
  return { plan, plan_digest: canonicalDigest(plan) };
}
export async function attachDeployment(input) {
  const plan = input.plan;
  if (plan?.kind !== "deployment_attachment" || plan.schema_version !== 1 || plan.task_id !== input.taskId || plan.operation_id !== input.operationId || plan.evidence?.target?.instanceId !== input.instanceId
    || canonicalDigest(plan.storage) !== canonicalDigest(storageOf(input)) || canonicalDigest(plan.evidence.effects) !== canonicalDigest(EFFECTS)) fail("DEPLOYMENT_ATTACH_PLAN_INVALID", "Use the exact local attachment plan, task, operation and storage location");
  requireUuid(plan.operation_id, "operation_id");
  await initializeStateRoot(input);
  const stateRoot = plan.storage.state_root;
  const paths = getInstancePaths({ stateRoot, instanceId: input.instanceId });
  await assertNoSymlinkPath(paths.journalsRoot, stateRoot);
  await validatePrivatePath(paths.journalsRoot, "directory");
  const journalPath = path.join(paths.journalsRoot, `${plan.operation_id}.json`);
  await assertNoSymlinkPath(journalPath, stateRoot);
  await validatePrivatePath(journalPath, "file");
  await assertJournalAuthorization({ ...input, stateRoot });
  const evidence = await inspectDeploymentAttachment({ ...input, ...plan.evidence.target, publicAccessReceipt: plan.evidence.resources.public_access, baselineBundle: plan.evidence.baseline_bundle, publisher: plan.evidence.publisher });
  if (canonicalDigest(evidence) !== canonicalDigest(plan.evidence)) fail();
  const receipt = { kind: "cfkanban_deployment_attachment_receipt", schema_version: 1,
    instance: { id: input.instanceId, api_origin: evidence.target.apiOrigin, origin_version: evidence.observed.origin_version, service_version: evidence.observed.service_version, schema_version: evidence.observed.schema_version },
    cloudflare: { account_id: evidence.target.accountId, profile: evidence.target.cloudflareProfile, auth_context_directory: evidence.target.contextDirectory,
      worker: { name: evidence.resources.worker.name, deployment_id: evidence.resources.worker.deployment_id, version_id: evidence.resources.worker.version_id }, d1: evidence.resources.d1,
      ...(evidence.resources.r2 ? { r2: evidence.resources.r2 } : {}), ...(evidence.resources.public_access ? { public_access: evidence.resources.public_access } : {}), routing: evidence.resources.routing, usage_analytics: evidence.usage_analytics },
    owner: evidence.owner, service_release: evidence.service_release, migrations: evidence.migrations, provenance: evidence.provenance,
    operation: { task_id: input.taskId, operation_id: input.operationId, plan_digest: canonicalDigest(plan) }, effects: { ...EFFECTS }, secret_values_exposed: false };
  await assertNoSymlinkPath(paths.receiptsRoot, stateRoot);
  await ensurePrivateDirectory(paths.receiptsRoot);
  await validatePrivatePath(paths.receiptsRoot, "directory");
  const receiptPath = path.join(paths.receiptsRoot, `${plan.operation_id}.attachment.json`);
  await assertNoSymlinkPath(receiptPath, stateRoot);
  if (await pathType(receiptPath) !== "missing") await validatePrivatePath(receiptPath, "file");
  const existing = await readJson(receiptPath, { allowMissing: true });
  if (existing !== null && canonicalDigest(existing) !== canonicalDigest(receipt)) fail("DEPLOYMENT_ATTACH_RECEIPT_CONFLICT", "An existing receipt for this operation contains different evidence");
  if (evidence.resources.public_access) {
    const publicPath = path.join(paths.receiptsRoot, "public-access.json");
    await assertNoSymlinkPath(publicPath, stateRoot);
    if (await pathType(publicPath) !== "missing") await validatePrivatePath(publicPath, "file");
    const previous = await readJson(publicPath, { allowMissing: true });
    if (previous && canonicalDigest(previous) !== canonicalDigest(evidence.resources.public_access)) fail("PUBLIC_ACCESS_RECEIPT_DRIFT", "The existing local public-access receipt cannot be overwritten by attachment");
    await atomicWriteJson(publicPath, evidence.resources.public_access);
  }
  await putInstanceMetadata({ ...input, stateRoot, trustedApiOrigin: evidence.target.apiOrigin, originVersion: evidence.observed.origin_version, serviceVersion: evidence.observed.service_version, schemaVersion: evidence.observed.schema_version, publisher: evidence.publisher });
  await atomicWriteJson(receiptPath, receipt);
  await appendJournalEvent({ ...input, stateRoot, event: { type: "deployment_attached", receipt_path: receiptPath, remote_writes: false } });
  return { ...receipt, receipt_path: receiptPath };
}
