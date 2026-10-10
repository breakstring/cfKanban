import { randomUUID } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCloudflareControlClient } from './cloudflare-control.mjs';
import { requestJson } from './deployment-finalize.mjs';
import { parseMigrationReadbackOutput } from './deploy.mjs';
import { toolError } from './errors.mjs';
import { appendJournalEvent, assertJournalAuthorization, authorizeJournal, createJournal } from './journal.mjs';
import { reconcileMigrationState } from './migrations.mjs';
import { resolveStateRoot } from './paths.mjs';
import { fetchDiscovery, validateDiscovery } from './rebind.mjs';
import { verifyInstalledServiceBundle } from './service-bundle.mjs';
import { readServiceApiVersion } from './service-api-version.mjs';
import { getInstancePaths, loadCurrentCredentialSecret, validatePrivatePath } from './state.mjs';
import { trustedApiRequest } from './transport.mjs';
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, ensurePrivateDirectory, readJson, requireHttpsOrigin, requireString, requireUuid, sha256Bytes } from './utils.mjs';

export const DEFAULT_TREND_BACKFILL_BUDGET = Object.freeze({ batchSize: 8, maxPages: 1000, maxDurationMs: 30 * 60 * 1000, requestIntervalMs: 500, maxRequests: 3000, rowsRead: 250000, rowsWritten: 50000 });
const SUPPORTED_TREND_BACKFILL_SCHEMAS = Object.freeze([30, 31]);
const LEASE_MS = 120000;
const CONTROL_SQL = 'SELECT id,run_id,lease_until,fence,last_batch_id,last_issue_id,last_version FROM issue_trend_backfill_control WHERE id=1 LIMIT 1';
const STATUS_SQL = 'SELECT COUNT(*) AS project_count,COALESCE(SUM(pending_jobs),0) AS pending_jobs,COALESCE(SUM(partial),0) AS partial_projects FROM issue_trend_projects';
const QUEUE_SQL = 'SELECT COUNT(*) AS pending_jobs FROM issue_trend_backfill';
const MIGRATION_SQL = [
  'SELECT sequence,name,sha256,classification,reentry,operation_id,applied_at FROM cfkanban_migration_ledger ORDER BY sequence LIMIT 1025',
  `SELECT type,name FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%'
   UNION ALL SELECT 'column' AS type,target.name||'.'||info.name AS name FROM sqlite_master AS target JOIN pragma_table_info(target.name) AS info
   WHERE target.type='table' AND target.name NOT GLOB '_cf_*' AND target.name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 4097`,
  'SELECT COUNT(*) AS row_count,MAX(schema_version) AS schema_version FROM instance_meta',
];
const stop = (reason, details = {}) => toolError('TREND_BACKFILL_STOPPED', 'Bounded trend backfill stopped; inspect the original journal before another run', { reason, ...details });

export function normalizeTrendBackfillBudget(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_TREND_BACKFILL_BUDGET, key))) throw toolError('INVALID_TREND_BACKFILL_BUDGET', 'Only documented bounded budget fields are supported');
  const budget = { ...DEFAULT_TREND_BACKFILL_BUDGET, ...value };
  for (const [key, maximum] of Object.entries(DEFAULT_TREND_BACKFILL_BUDGET)) {
    const minimum = key === 'requestIntervalMs' ? maximum : 1;
    if (!Number.isSafeInteger(budget[key]) || budget[key] < minimum || key !== 'requestIntervalMs' && budget[key] > maximum || key === 'requestIntervalMs' && budget[key] > 30000) throw toolError('INVALID_TREND_BACKFILL_BUDGET', 'Budgets can only reduce work or slow the provider request rate', { field: key });
  }
  return budget;
}

// All Cloudflare requests, including target readbacks and lease writes, share one rate gate.
export function createTrendBackfillMeter({ budget, fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onQuery = async () => {}, onRequest = async () => {}, previousUsage = {}, previousElapsedMs = 0 }) {
  const started = now(); let lastRequest = null;
  const usage = { provider_requests: 0, rows_read: 0, rows_written: 0, sql_duration_ms: 0, metadata_complete: true, ...previousUsage };
  const available = (read = 0, write = 0, requests = 1) => previousElapsedMs + now() - started < budget.maxDurationMs && usage.provider_requests + requests <= budget.maxRequests && usage.rows_read + read <= budget.rowsRead && usage.rows_written + write <= budget.rowsWritten;
  const fetch = async (url, init) => {
    if (new URL(url).origin === 'https://api.cloudflare.com') {
      if (!available()) throw stop('budget_exhausted');
      if (lastRequest !== null) await sleep(Math.max(0, lastRequest + budget.requestIntervalMs - now()));
      if (!available()) throw stop('budget_exhausted');
      lastRequest = now(); usage.provider_requests += 1;
      await onRequest({ provider_requests: usage.provider_requests, cumulative_elapsed_ms: previousElapsedMs + now() - started });
    }
    return fetchImpl(url, init);
  };
  const record = async (result, label, queryId = null) => {
    const meta = result?.meta;
    if (!meta || !['rows_read', 'rows_written'].every(key => Number.isSafeInteger(meta[key]) && meta[key] >= 0) || !Number.isFinite(meta.duration) || meta.duration < 0) {
      usage.metadata_complete = false;
      await onQuery({ label, query_id: queryId, metadata_complete: false, provider_requests: usage.provider_requests, cumulative_elapsed_ms: previousElapsedMs + now() - started });
      throw stop('usage_metadata_unknown');
    }
    usage.rows_read += meta.rows_read; usage.rows_written += meta.rows_written; usage.sql_duration_ms += meta.duration;
    await onQuery({ label, query_id: queryId, rows_read: meta.rows_read, rows_written: meta.rows_written, sql_duration_ms: meta.duration, provider_requests: usage.provider_requests, cumulative_elapsed_ms: previousElapsedMs + now() - started });
    if (!available(0, 0, 0)) throw stop('budget_exhausted');
  };
  return { fetch, usage, available, record, started, now, sleep };
}

function noRemoteOverrides(input) {
  for (const key of ['accountId', 'databaseId', 'd1Name', 'workerName', 'cloudflareProfile', 'contextDirectory', 'apiOrigin', 'sql', 'params', 'modulePath', 'algorithm']) if (Object.hasOwn(input, key)) throw toolError('TREND_BACKFILL_TARGET_OVERRIDE', 'Backfill target and algorithm come only from the verified private deployment receipt');
}

async function localEvidence(input) {
  noRemoteOverrides(input);
  const stateRoot = path.resolve(input.stateRoot ?? resolveStateRoot());
  const instanceId = requireUuid(input.instanceId, 'instance_id');
  const paths = getInstancePaths({ stateRoot, instanceId });
  await validatePrivatePath(stateRoot, 'directory'); await validatePrivatePath(paths.instanceRoot, 'directory');
  await assertNoSymlinkPath(paths.instanceMetadata, stateRoot); await validatePrivatePath(paths.instanceMetadata, 'file');
  const metadata = await readJson(paths.instanceMetadata);
  const receiptPath = path.resolve(requireString(input.currentReceiptPath, 'current_receipt_path', { max: 4096 }));
  if (path.dirname(receiptPath) !== paths.receiptsRoot) throw toolError('TREND_BACKFILL_RECEIPT_REQUIRED', 'Use the existing private instance deployment receipt');
  await assertNoSymlinkPath(receiptPath, stateRoot); await validatePrivatePath(receiptPath, 'file');
  const receipt = await readJson(receiptPath), release = receipt.service_release?.after ?? receipt.service_release;
  const schemaVersion = receipt.instance?.schema_version;
  if (receipt.kind !== 'cfkanban_instance_upgrade_receipt' || receipt.instance?.id !== instanceId || !SUPPORTED_TREND_BACKFILL_SCHEMAS.includes(schemaVersion) || receipt.verification?.canonical_release !== true || receipt.verification?.worker_deployment_readback !== true || receipt.verification?.migration_ledger_and_schema !== true || metadata.instance_id !== instanceId || metadata.trusted_api_origin !== receipt.instance.api_origin || metadata.origin_version !== receipt.instance.origin_version) throw toolError('TREND_BACKFILL_RECEIPT_DRIFT', 'Backfill requires a verified schema 30 or 31 upgrade receipt matching the existing trusted instance');
  const bundleRoot = path.resolve(requireString(input.serviceBundleRoot, 'service_bundle_root', { max: 4096 }));
  const canonicalRoot = path.join(stateRoot, 'service-releases', 'versions', release.service_bundle_version);
  if (path.dirname(bundleRoot) !== canonicalRoot) throw toolError('TREND_BACKFILL_SOURCE_REQUIRED', 'Use the matching immutable canonical Service bundle cache');
  const bundle = await verifyInstalledServiceBundle({ bundleRoot, expectedVersion: release.service_bundle_version, expectedSha256: release.service_bundle_sha256, expectedPublisher: release.publisher, expectedSource: release.service_bundle_source });
  const manifest = await readJson(path.join(bundleRoot, 'migrations/manifest.json'));
  if (manifest.schema_version !== schemaVersion) throw toolError('TREND_BACKFILL_SOURCE_REQUIRED', 'The verified Service schema must match its schema 30 or 31 upgrade receipt');
  const serviceVersion = await readServiceApiVersion(bundleRoot, { expectedReleaseVersion: release.service_bundle_version, expectedApiVersion: receipt.instance.service_version });
  const modulePath = path.join(bundleRoot, 'dist/issue-trend-backfill.mjs');
  await assertNoSymlinkPath(modulePath, bundleRoot);
  const build = await readJson(path.join(bundleRoot, 'dist/issue-trend-backfill-build.json'));
  if (build.release_version !== release.service_bundle_version || build.algorithm_version !== 1 || build.entry !== 'issue-trend-backfill.mjs' || build.sha256 !== sha256Bytes(await readFile(modulePath))) throw toolError('TREND_BACKFILL_ALGORITHM_DRIFT', 'The immutable backfill entry differs from its paired Service build');
  const algorithm = await import(pathToFileURL(modulePath).href);
  if (algorithm.BACKFILL_ALGORITHM_VERSION !== 1 || algorithm.HISTORY_PAGE_LIMIT !== 100 || typeof algorithm.createTrendBackfillCommit !== 'function' || !['string', 'function'].includes(typeof algorithm.TREND_HISTORY_PAGE_SQL) || !['string', 'function'].includes(typeof algorithm.JOB_PAGE_SQL)) throw toolError('TREND_BACKFILL_ALGORITHM_UNSUPPORTED', 'The verified Service backfill algorithm is unsupported');
  const cloud = receipt.cloudflare;
  const target = { instance_id: instanceId, api_origin: requireHttpsOrigin(receipt.instance.api_origin), origin_version: receipt.instance.origin_version,
    account_id: requireString(cloud.account_id, 'account_id', { max: 128 }), cloudflare_profile: cloud.profile ?? null, context_directory: cloud.context_directory ?? null,
    worker_name: requireString(cloud.worker.name, 'worker_name', { max: 63 }), worker_version_id: requireUuid(cloud.worker.after_version_id ?? cloud.worker.version_id, 'worker_version_id'), worker_deployment_id: requireUuid(cloud.worker.after_deployment_id ?? cloud.worker.deployment_id, 'worker_deployment_id'),
    d1_name: requireString(cloud.d1.name, 'd1_name', { max: 63 }), database_id: requireUuid(cloud.d1.database_id, 'database_id'), release_version: release.service_bundle_version, service_version: serviceVersion, schema_version: schemaVersion, owner: receipt.owner };
  if (!/^[a-f0-9]{32}$/u.test(target.account_id) || ![target.worker_name, target.d1_name].every(value => /^[a-z0-9-]+$/u.test(value)) || (target.cloudflare_profile === null) === (target.context_directory === null)) throw toolError('TREND_BACKFILL_RECEIPT_DRIFT', 'The receipt must identify one exact account, resource pair and authentication context');
  const credential = await loadCurrentCredentialSecret({ stateRoot, instanceId });
  if (credential.metadata.principal_id !== target.owner.principal_id || credential.metadata.credential_id !== target.owner.credential_id || credential.metadata.fingerprint !== target.owner.credential_fingerprint || credential.metadata.state !== 'current') throw toolError('TREND_BACKFILL_OWNER_DRIFT', 'The current private Owner identity differs from the deployment receipt');
  return { stateRoot, paths, receiptPath, receipt, receipt_digest: canonicalDigest(receipt), target, bundle, bundleRoot, manifest, algorithm, credential };
}

async function remoteEvidence(input, local, meter, record = async () => {}) {
  const t = local.target;
  const connection = { accountId: t.account_id, cloudflareProfile: t.cloudflare_profile, contextDirectory: t.context_directory, wranglerExecutable: requireString(input.wranglerExecutable, 'wrangler_executable', { max: 4096 }), fetchImpl: meter.fetch, refreshAuth: true, ...(input.tokenRunner ? { tokenRunner: input.tokenRunner } : {}) };
  if (!path.isAbsolute(connection.wranglerExecutable)) throw toolError('ABSOLUTE_PATH_REQUIRED', 'Wrangler must be an absolute executable path');
  const options = { errorPrefix: 'TREND_BACKFILL', resourceLabel: 'maintenance', scope: 'account' };
  const control = await createCloudflareControlClient(connection, `/d1/database/${t.database_id}`, options);
  const workerControl = await createCloudflareControlClient(connection, '/workers', options);
  const query = async (sql, params = [], label = 'inspection') => {
    const queryId = randomUUID();
    await record({ type: 'trend_backfill_query_started', query_id: queryId, label });
    let results; const requestsBefore = meter.usage.provider_requests;
    try {
      results = await control('/query', { method: 'POST', body: { sql, params } });
      if (!Array.isArray(results) || results.length !== 1 || results[0]?.success !== true || !Array.isArray(results[0].results)) throw stop('query_response_unknown');
    } catch (error) {
      const sent = meter.usage.provider_requests > requestsBefore;
      if (sent) meter.usage.metadata_complete = false;
      await record({ type: 'trend_backfill_query_failed', query_id: queryId, label, provider_request_sent: sent,
        code: /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code ?? '') ? error.code : 'CONTROL_REQUEST_FAILED',
        ...(Number.isSafeInteger(error.details?.status) ? { status: error.details.status } : {}),
        ...(Array.isArray(error.details?.codes) ? { codes: error.details.codes.filter(Number.isSafeInteger) } : {}) });
      throw error;
    }
    await meter.record(results[0], label, queryId); return results[0];
  };
  const assertWorker = async () => {
    const value = await workerControl(`/scripts/${t.worker_name}/deployments`);
    const deployments = Array.isArray(value) ? value : value?.deployments;
    const current = Array.isArray(deployments) ? deployments[0] : null;
    if (current?.id !== t.worker_deployment_id || current.versions?.length !== 1 || current.versions[0].version_id !== t.worker_version_id || Number(current.versions[0].percentage) !== 100) throw stop('worker_version_drift');
  };
  await assertWorker();
  const version = await workerControl(`/scripts/${t.worker_name}/versions/${t.worker_version_id}`);
  const d1Bindings = version?.resources?.bindings?.filter(binding => binding.type === 'd1') ?? [];
  if (version?.id !== t.worker_version_id || d1Bindings.length !== 1 || d1Bindings[0].database_id !== t.database_id || d1Bindings[0].name !== 'DB') throw stop('database_binding_drift');
  const db = await control('');
  if (db?.uuid !== t.database_id || db.name !== t.d1_name) throw stop('database_identity_drift');
  const migration = [];
  for (const sql of MIGRATION_SQL) migration.push(await query(sql));
  const parsed = parseMigrationReadbackOutput(JSON.stringify(migration));
  const state = reconcileMigrationState({ manifest: local.manifest, ledger: parsed.ledger, schema: parsed.schema });
  if (!state.safe_to_continue || state.migrations.some(entry => entry.state !== 'applied')
    || parsed.schema.data?.instance_meta?.row_count !== 1 || parsed.schema.data.instance_meta.schema_version !== t.schema_version) throw stop('migration_ledger_drift');
  const fetchImpl = meter.fetch;
  const discovery = validateDiscovery(await fetchDiscovery(t.api_origin, fetchImpl), t.api_origin);
  const health = await requestJson(t.api_origin, '/healthz', { fetchImpl });
  const readback = async apiPath => {
    const value = await trustedApiRequest({ stateRoot: local.stateRoot, instanceId: t.instance_id, apiPath, expectedApiOrigin: t.api_origin, authorizationToken: local.credential.token, fetchImpl });
    if (!value.ok) throw stop('owner_readback_failed'); return value.data;
  };
  const meta = await readback('/api/v1/meta'), me = await readback('/api/v1/me');
  if (discovery.instance_id !== t.instance_id || discovery.origin_version !== t.origin_version || discovery.preferred_api_origin !== t.api_origin || discovery.release_version !== t.release_version || discovery.service_version !== t.service_version || health.release_version !== t.release_version || health.service_version !== t.service_version || health.schema_version !== t.schema_version || health.d1 !== 'reachable' || meta.instance_id !== t.instance_id || meta.release_version !== t.release_version || meta.service_version !== t.service_version || meta.schema_version !== t.schema_version || meta.observed_origin !== t.api_origin || meta.preferred_api_origin !== t.api_origin || meta.origin_version !== t.origin_version || meta.principal?.id !== t.owner.principal_id || meta.principal?.is_owner !== true || me.id !== t.owner.principal_id || me.principal_id !== t.owner.principal_id || me.display_name !== t.owner.display_name || me.is_owner !== true || me.credential?.id !== t.owner.credential_id || me.credential?.fingerprint !== t.owner.credential_fingerprint) throw stop('instance_identity_drift');
  const summary = (await query(STATUS_SQL)).results[0], queue = (await query(QUEUE_SQL)).results[0], lease = (await query(CONTROL_SQL)).results[0];
  if (!Number.isSafeInteger(summary?.pending_jobs) || queue?.pending_jobs !== summary.pending_jobs || !Number.isSafeInteger(lease?.fence)) throw stop('queue_state_drift');
  return { query, assertWorker, summary: { ...summary, queue_pending_jobs: queue.pending_jobs }, lease };
}

export async function inspectTrendBackfill(input) {
  const local = await localEvidence(input), budget = normalizeTrendBackfillBudget(input.budget);
  const meter = createTrendBackfillMeter({ budget, fetchImpl: input.fetchImpl });
  const remote = await remoteEvidence(input, local, meter);
  return { target: local.target, source: { bundle_root: local.bundleRoot, bundle_tree_digest: local.bundle.bundle_tree_digest, artifact_sha256: local.bundle.artifact_sha256, algorithm_version: 1 }, pending: remote.summary, lease: remote.lease, usage: meter.usage, worker_cpu_ms: null, backfill_runs_in: 'local_node', secret_values_exposed: false };
}

export async function createTrendBackfillPlan(input) {
  const local = await localEvidence(input), budget = normalizeTrendBackfillBudget(input.budget);
  const meter = createTrendBackfillMeter({ budget, fetchImpl: input.fetchImpl });
  const remote = await remoteEvidence(input, local, meter);
  const plan = { kind: 'issue_trend_history_backfill', schema_version: 1, task_id: requireString(input.taskId, 'task_id', { max: 256 }), operation_id: requireUuid(input.operationId ?? randomUUID(), 'operation_id'), instance_id: local.target.instance_id,
    target: local.target, source: { bundle_root: local.bundleRoot, bundle_tree_digest: local.bundle.bundle_tree_digest, artifact_sha256: local.bundle.artifact_sha256, algorithm_version: 1 }, receipt: { path: local.receiptPath, digest: local.receipt_digest }, budget,
    effects: { domain_writes: false, history_aggregation_writes: true, worker_deployment: false, cron_change: false, paid_settings_change: false }, initial_pending: remote.summary.pending_jobs };
  return { plan, plan_digest: canonicalDigest(plan), inspection: { pending: remote.summary, lease: remote.lease, usage: meter.usage } };
}

export function reconcileTrendBackfillEvidence(events, inspection, job, databaseNowMs) {
  const acquired = events.findLast(event => event.type === 'trend_backfill_lease_acquired');
  const checkpoint = events.findLast(event => event.type === 'trend_backfill_batch_started');
  const finished = events.filter(event => event.type === 'trend_backfill_batch_finished');
  const control = inspection.lease;
  if (!acquired || control.fence !== acquired.fence || control.run_id !== null && control.run_id !== acquired.run_id
    || !Number.isSafeInteger(databaseNowMs) || control.run_id !== null && control.lease_until >= databaseNowMs) throw stop('original_lease_unconfirmed');
  const uncertain = checkpoint && !finished.some(event => event.batch_id === checkpoint.batch_id);
  let batchOutcome = 'no_uncertain_batch';
  if (uncertain) {
    if (control.last_batch_id === checkpoint.batch_id && control.last_issue_id === checkpoint.issue_id
      && control.last_version === checkpoint.original_version + 1) batchOutcome = 'committed';
    else {
      const previous = finished.at(-1);
      const baseline = acquired.previous_checkpoint;
      const previousMatches = previous ? control.last_batch_id === previous.batch_id && control.last_issue_id === previous.issue_id
        && control.last_version === previous.original_version + 1 : baseline ? control.last_batch_id === baseline.batch_id
          && control.last_issue_id === baseline.issue_id && control.last_version === baseline.version : control.last_batch_id === null;
      if (!previousMatches || job?.version !== checkpoint.original_version || job?.cursor !== checkpoint.original_cursor) throw stop('original_batch_unconfirmed');
      batchOutcome = 'not_committed';
    }
  } else {
    const previous = finished.at(-1);
    const baseline = acquired.previous_checkpoint;
    const matches = previous ? control.last_batch_id === previous.batch_id && control.last_issue_id === previous.issue_id
      && control.last_version === previous.original_version + 1 : baseline ? control.last_batch_id === baseline.batch_id
        && control.last_issue_id === baseline.issue_id && control.last_version === baseline.version : control.last_batch_id === null;
    if (!matches) throw stop('original_checkpoint_unconfirmed');
  }
  const usages = new Set(events.filter(event => event.type === 'trend_backfill_query_usage' && event.metadata_complete !== false
    && ['rows_read', 'rows_written'].every(key => Number.isSafeInteger(event[key]) && event[key] >= 0)
    && Number.isFinite(event.sql_duration_ms) && event.sql_duration_ms >= 0).map(event => event.query_id));
  const notSent = new Set(events.filter(event => event.type === 'trend_backfill_query_failed' && event.provider_request_sent === false).map(event => event.query_id));
  const unknown = events.filter(event => event.type === 'trend_backfill_query_started' && !usages.has(event.query_id) && !notSent.has(event.query_id));
  const allowed = new Set(['inspection', 'pending_before', 'lease_acquire', 'lease_renew', 'lease_release', 'job_page', 'history_page', 'history_commit', 'history_commit_readback', 'uncertain_commit_readback', 'pending_after', 'queue_after']);
  if (unknown.some(event => !allowed.has(event.label))) throw stop('original_query_unrecognized');
  const unknownWrites = unknown.filter(event => ['lease_acquire', 'lease_renew', 'lease_release', 'history_commit'].includes(event.label));
  return { batch_id: uncertain ? checkpoint.batch_id : null, batch_outcome: batchOutcome, original_usage_complete: unknown.length === 0,
    unknown_queries: unknown.length, conservative_unknown_usage: { rows_read: unknown.length * 4000, rows_written: unknownWrites.length * 1000 },
    pending_jobs: inspection.pending.pending_jobs, original_fence: acquired.fence, original_lease_active: false, replayed_writes: 0 };
}

export async function recoverTrendBackfill(input) {
  const plan = input.plan;
  if (plan?.kind !== 'issue_trend_history_backfill' || plan.schema_version !== 1 || input.instanceId !== plan.instance_id
    || input.operationId !== plan.operation_id || input.taskId !== plan.task_id || input.authorization?.plan_digest !== canonicalDigest(plan)
    || input.authorization?.operation_id !== plan.operation_id || input.authorization?.instance_id !== plan.instance_id
    || input.authorization?.task_id !== plan.task_id) throw toolError('INVALID_TREND_BACKFILL_PLAN', 'Recover only the retained original authorized backfill plan');
  const local = await localEvidence(input);
  if (canonicalDigest(local.target) !== canonicalDigest(plan.target) || local.receiptPath !== plan.receipt.path || local.receipt_digest !== plan.receipt.digest
    || local.bundleRoot !== plan.source.bundle_root || local.bundle.bundle_tree_digest !== plan.source.bundle_tree_digest
    || local.bundle.artifact_sha256 !== plan.source.artifact_sha256) throw toolError('TREND_BACKFILL_PLAN_DRIFT', 'Recover using the original receipt, source and target');
  const lockPath = path.join(local.paths.journalsRoot, `${input.operationId}.json.trends.lock`);
  await assertNoSymlinkPath(lockPath, local.stateRoot);
  let lock; try { lock = await open(lockPath, 'wx', 0o600); } catch { throw toolError('TREND_BACKFILL_LOCAL_LOCKED', 'The original local runner may still be active; never recover it concurrently'); }
  try {
    const journal = await assertJournalAuthorization({ ...input, stateRoot: local.stateRoot });
    const meter = createTrendBackfillMeter({ budget: normalizeTrendBackfillBudget(), fetchImpl: input.fetchImpl });
    const remote = await remoteEvidence(input, local, meter);
    const checkpoint = journal.events.findLast(event => event.type === 'trend_backfill_batch_started');
    const job = checkpoint ? (await remote.query('SELECT version,cursor FROM issue_trend_backfill WHERE issue_id=? LIMIT 1', [checkpoint.issue_id], 'recover_original_job')).results[0] : null;
    const databaseNowMs = (await remote.query("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 AS now_ms", [], 'recover_database_time')).results[0]?.now_ms;
    const controlAfter = (await remote.query(CONTROL_SQL, [], 'recover_control_readback')).results[0];
    if (canonicalDigest(controlAfter) !== canonicalDigest(remote.lease)) throw stop('original_control_changed');
    const evidence = reconcileTrendBackfillEvidence(journal.events, { lease: remote.lease, pending: remote.summary }, job, databaseNowMs);
    const result = { ok: true, recovered: true, complete: false, operation_id: input.operationId, ...evidence, recovery_usage: meter.usage,
      continuation: 'create_new_bounded_plan_after_account_usage_readback', secret_values_exposed: false };
    await appendJournalEvent({ ...input, stateRoot: local.stateRoot, event: { type: 'trend_backfill_recovered_read_only', ...result } });
    const receiptPath = path.join(local.paths.receiptsRoot, `${input.operationId}.trends-recovery.json`);
    await atomicWriteJson(receiptPath, { kind: 'cfkanban_trend_backfill_recovery_receipt', schema_version: 1, instance_id: input.instanceId,
      operation_id: input.operationId, plan_digest: canonicalDigest(plan), result, checked_at: new Date().toISOString() });
    return { ...result, receipt_path: receiptPath };
  } finally { await lock.close(); await rm(lockPath); }
}

export async function runBoundedTrendBackfill({ plan, algorithm, query, meter, record, assertWorker, now = Date.now, priorEvents = [] }) {
  const cpuStart = process.cpuUsage(); const started = now(); const runId = plan.operation_id;
  const priorBatches = priorEvents.filter(event => event.type === 'trend_backfill_batch_finished');
  let fence = null, pages = priorBatches.length, finished = priorBatches.filter(event => event.finished).length, partial = priorBatches.filter(event => event.finished && event.partial).length, events = priorBatches.reduce((sum, event) => sum + event.event_count, 0), pendingBefore = null, pendingAfter = null, reason = 'complete', uncertainBatch = null;
  const usageStart = { ...meter.usage };
  const checkpoint = priorEvents.findLast(event => event.type === 'trend_backfill_batch_started');
  if (checkpoint && !priorEvents.some(event => ['trend_backfill_batch_finished', 'trend_backfill_batch_uncertain'].includes(event.type) && event.batch_id === checkpoint.batch_id)) {
    const control = (await query(CONTROL_SQL, [], 'recover_original_batch')).results[0];
    await record({ type: 'trend_backfill_batch_uncertain', batch_id: checkpoint.batch_id, committed: control?.last_batch_id === checkpoint.batch_id, metadata_complete: false });
    return { stop_reason: 'original_batch_usage_unknown', pages: 0, finished_issues: 0, usage: meter.usage, worker_cpu_ms: null };
  }
  if (priorEvents.some(event => event.type === 'trend_backfill_batch_uncertain')) return { stop_reason: 'original_batch_usage_unknown', pages: 0, finished_issues: 0, usage: meter.usage, worker_cpu_ms: null };
  try {
    pendingBefore = (await query(STATUS_SQL, [], 'pending_before')).results[0]?.pending_jobs;
    if (pendingBefore === 0) return { stop_reason: 'complete', pending_before: 0, pending_after: 0, pages: 0, finished_issues: 0, usage: meter.usage, worker_cpu_ms: null };
    const acquired = await query('UPDATE issue_trend_backfill_control SET run_id=?,lease_until=?,fence=fence+1 WHERE id=1 AND lease_until<=? RETURNING fence,last_batch_id,last_issue_id,last_version', [runId, now() + LEASE_MS, now()], 'lease_acquire');
    if (acquired.results.length !== 1 || !Number.isSafeInteger(acquired.results[0].fence)) throw stop('lease_busy');
    fence = acquired.results[0].fence;
    await record({ type: 'trend_backfill_lease_acquired', run_id: runId, fence,
      previous_checkpoint: { batch_id: acquired.results[0].last_batch_id ?? null, issue_id: acquired.results[0].last_issue_id ?? null, version: acquired.results[0].last_version ?? null } });
    let lastProgress = null;
    while (pages < plan.budget.maxPages) {
      if (!meter.available(4000, 1000, 9) || now() - started >= plan.budget.maxDurationMs) { reason = 'budget_exhausted'; break; }
      await assertWorker();
      const renewed = await query('UPDATE issue_trend_backfill_control SET lease_until=? WHERE id=1 AND run_id=? AND fence=? AND lease_until>? RETURNING fence', [now() + LEASE_MS, runId, fence, now()], 'lease_renew');
      if (renewed.results.length !== 1) throw stop('lease_lost');
      const jobSQL = typeof algorithm.JOB_PAGE_SQL === 'function' ? algorithm.JOB_PAGE_SQL(plan.budget.batchSize) : { sql: algorithm.JOB_PAGE_SQL, params: [plan.budget.batchSize] };
      const jobs = (await query(typeof jobSQL === 'string' ? jobSQL : jobSQL.sql, typeof jobSQL === 'string' ? [] : jobSQL.params ?? [], 'job_page')).results;
      if (jobs.length > plan.budget.batchSize || jobs.length > 8) throw stop('job_page_unbounded');
      if (!jobs.length) break;
      for (const job of jobs) {
        if (pages >= plan.budget.maxPages || !meter.available(4000, 1000, 6) || now() - started >= plan.budget.maxDurationMs) { reason = 'budget_exhausted'; break; }
        const progress = `${job.issue_id}:${job.version}:${job.cursor}`;
        if (progress === lastProgress) throw stop('no_progress');
        const batchUsageStart = { ...meter.usage }, batchCpuStart = process.cpuUsage(), batchStarted = now();
        const history = typeof algorithm.TREND_HISTORY_PAGE_SQL === 'function' ? algorithm.TREND_HISTORY_PAGE_SQL(job.project_id, job.issue_id, job.cursor) : algorithm.TREND_HISTORY_PAGE_SQL;
        const rows = (await query(typeof history === 'string' ? history : history.sql, typeof history === 'string' ? [job.project_id, job.issue_id, job.cursor] : history.params ?? [], 'history_page')).results;
        if (rows.length > 100) throw stop('history_page_unbounded');
        const batchId = canonicalDigest({ runId, fence, issue: job.issue_id, version: job.version, cursor: job.cursor });
        const commit = algorithm.createTrendBackfillCommit(job, rows, { batchId, runId, fence });
        uncertainBatch = { batch_id: batchId, issue_id: job.issue_id, project_id: job.project_id, original_version: job.version, original_cursor: job.cursor, event_count: rows.length };
        await record({ type: 'trend_backfill_batch_started', ...uncertainBatch });
        await query(commit.sql, commit.params, 'history_commit');
        const accepted = (await query(CONTROL_SQL, [], 'history_commit_readback')).results[0];
        if (accepted?.last_batch_id !== batchId || accepted.last_issue_id !== job.issue_id || accepted.last_version !== job.version + 1 || accepted.fence !== fence || accepted.run_id !== runId) throw stop('commit_cas_rejected');
        pages += 1; events += rows.length; if (commit.finished) finished += 1; if (commit.finished && commit.partial) partial += 1;
        const batchCpu = process.cpuUsage(batchCpuStart);
        await record({ type: 'trend_backfill_batch_finished', ...uncertainBatch, finished: Boolean(commit.finished),
          partial: Boolean(commit.partial), next_cursor: commit.next_cursor ?? null, usage: { ...meter.usage },
          batch_usage: { rows_read: meter.usage.rows_read - batchUsageStart.rows_read,
            rows_written: meter.usage.rows_written - batchUsageStart.rows_written,
            provider_requests: meter.usage.provider_requests - batchUsageStart.provider_requests,
            sql_duration_ms: meter.usage.sql_duration_ms - batchUsageStart.sql_duration_ms,
            elapsed_ms: now() - batchStarted, local_node_cpu_ms: (batchCpu.user + batchCpu.system) / 1000 } });
        uncertainBatch = null; lastProgress = progress;
      }
      if (reason !== 'complete') break;
    }
    if (pages >= plan.budget.maxPages) reason = 'page_budget_exhausted';
  } catch (error) {
    reason = error.details?.reason ?? error.code ?? 'execution_failed';
    if (uncertainBatch) {
      meter.usage.metadata_complete = false;
      let committed = null;
      try { committed = (await query(CONTROL_SQL, [], 'uncertain_commit_readback')).results[0]?.last_batch_id === uncertainBatch.batch_id; } catch { /* Preserve unknown state; never replay a write. */ }
      await record({ type: 'trend_backfill_batch_uncertain', ...uncertainBatch, committed, metadata_complete: false });
    }
  } finally {
    if (fence !== null) {
      try {
        await query('UPDATE issue_trend_backfill_control SET run_id=NULL,lease_until=0 WHERE id=1 AND run_id=? AND fence=?', [runId, fence], 'lease_release');
      } catch { if (reason === 'complete') reason = 'lease_release_unknown'; }
    }
    try {
      pendingAfter = (await query(STATUS_SQL, [], 'pending_after')).results[0]?.pending_jobs ?? null;
      const queue = (await query(QUEUE_SQL, [], 'queue_after')).results[0]?.pending_jobs;
      if (!Number.isSafeInteger(pendingAfter) || pendingAfter !== queue || reason === 'complete' && pendingAfter !== 0) reason = 'queue_state_drift';
    } catch { if (reason === 'complete') reason = 'final_usage_unknown'; }
  }
  const cpu = process.cpuUsage(cpuStart);
  const result = { stop_reason: reason, pending_before: pendingBefore, pending_after: pendingAfter, pages, finished_issues: finished, partial_issues: partial, history_events: events, usage: { ...meter.usage }, run_usage_start: usageStart, elapsed_ms: now() - started, local_node_cpu_ms: (cpu.user + cpu.system) / 1000, worker_cpu_ms: null, backfill_runs_in: 'local_node', fence, secret_values_exposed: false };
  await record({ type: 'trend_backfill_run_finished', ...result }); return result;
}

export function summarizeTrendBackfill(result, { operationId, journalPath }) {
  const reason = result.stop_reason;
  const complete = reason === 'complete' && result.pending_after === 0;
  if (complete || ['budget_exhausted', 'page_budget_exhausted'].includes(reason)) {
    return { ...result, ok: true, complete };
  }
  const conflict = result.usage?.metadata_complete !== false
    && /(?:lease_busy|lease_lost|drift|cas_rejected|no_progress)/i.test(reason ?? '');
  return { ...result, ok: false, complete: false, ...(!conflict ? { outcome_unknown: true } : {}),
    error: { code: 'TREND_BACKFILL_STOPPED', category: conflict ? 'conflict' : 'platform_failure',
      source: 'client_runtime', recovery: 'inspect_original_backfill_journal' },
    recovery: { command: 'deploy trends inspect', operation_id: operationId, journal_path: journalPath,
      preserve_original_plan: true, replay_automatically: false } };
}

export async function runTrendBackfill(input) {
  const plan = input.plan;
  if (plan?.kind !== 'issue_trend_history_backfill' || plan.schema_version !== 1 || input.instanceId !== plan.instance_id || input.operationId !== plan.operation_id || input.taskId !== plan.task_id) throw toolError('INVALID_TREND_BACKFILL_PLAN', 'Run must match one frozen backfill task, instance and operation');
  const authorization = input.authorization;
  if (!authorization || Object.keys(authorization).some(key => !['task_id', 'operation_id', 'instance_id', 'plan_digest'].includes(key)) || authorization.task_id !== input.taskId || authorization.operation_id !== input.operationId || authorization.instance_id !== input.instanceId || authorization.plan_digest !== canonicalDigest(plan)) throw toolError('TREND_BACKFILL_AUTHORIZATION_REQUIRED', 'Provide authorization for this exact task, operation, instance and plan digest');
  const local = await localEvidence(input);
  if (canonicalDigest(local.target) !== canonicalDigest(plan.target) || local.receiptPath !== plan.receipt.path || local.receipt_digest !== plan.receipt.digest || local.bundleRoot !== plan.source.bundle_root || local.bundle.bundle_tree_digest !== plan.source.bundle_tree_digest || local.bundle.artifact_sha256 !== plan.source.artifact_sha256 || plan.source.algorithm_version !== 1 || canonicalDigest(normalizeTrendBackfillBudget(plan.budget)) !== canonicalDigest(plan.budget)) throw toolError('TREND_BACKFILL_PLAN_DRIFT', 'Receipt, source, target or bounded budget changed since the plan');
  const journalPath = path.join(local.paths.journalsRoot, `${input.operationId}.json`), lockPath = `${journalPath}.trends.lock`;
  await ensurePrivateDirectory(local.paths.journalsRoot);
  await assertNoSymlinkPath(lockPath, local.stateRoot);
  let lock; try { lock = await open(lockPath, 'wx', 0o600); } catch { throw toolError('TREND_BACKFILL_LOCAL_LOCKED', 'Another local process may be executing this exact run; inspect it before resuming'); }
  try {
    await createJournal({ ...input, stateRoot: local.stateRoot });
    await authorizeJournal({ ...input, stateRoot: local.stateRoot, planDigest: canonicalDigest(plan) });
    const journal = await assertJournalAuthorization({ ...input, stateRoot: local.stateRoot });
    const record = event => appendJournalEvent({ ...input, stateRoot: local.stateRoot, event });
    const queries = journal.events.filter(event => event.type === 'trend_backfill_query_usage');
    const previousUsage = { provider_requests: Math.max(0, ...journal.events.filter(event => Number.isSafeInteger(event.provider_requests)).map(event => event.provider_requests)), rows_read: queries.reduce((sum, event) => sum + (event.rows_read ?? 0), 0), rows_written: queries.reduce((sum, event) => sum + (event.rows_written ?? 0), 0), sql_duration_ms: queries.reduce((sum, event) => sum + (event.sql_duration_ms ?? 0), 0), metadata_complete: queries.every(event => event.metadata_complete !== false) };
    const previousElapsedMs = Math.max(0, ...journal.events.filter(event => Number.isFinite(event.cumulative_elapsed_ms)).map(event => event.cumulative_elapsed_ms));
    const meter = createTrendBackfillMeter({ budget: plan.budget, fetchImpl: input.fetchImpl, previousUsage, previousElapsedMs, onRequest: event => record({ type: 'trend_backfill_provider_request', ...event }), onQuery: event => record({ type: 'trend_backfill_query_usage', ...event }) });
    if (!previousUsage.metadata_complete) throw stop('original_run_usage_unknown');
    if (journal.events.some(event => event.type === 'trend_backfill_query_started' && !queries.some(result => result.query_id === event.query_id)
      && !journal.events.some(result => result.type === 'trend_backfill_query_failed' && result.query_id === event.query_id && result.provider_request_sent === false))) throw stop('original_query_usage_unknown');
    const remote = await remoteEvidence(input, local, meter, record);
    const result = summarizeTrendBackfill(await runBoundedTrendBackfill({ plan, algorithm: local.algorithm,
      query: remote.query, assertWorker: remote.assertWorker, meter, record, priorEvents: journal.events }),
    { operationId: input.operationId, journalPath });
    const receiptPath = path.join(local.paths.receiptsRoot, `${input.operationId}.trends.json`);
    await atomicWriteJson(receiptPath, { kind: 'cfkanban_trend_backfill_receipt', schema_version: 1, instance_id: input.instanceId, operation_id: input.operationId, task_id: input.taskId, plan_digest: canonicalDigest(plan), target: plan.target, source: plan.source, budget: plan.budget, result, checked_at: new Date().toISOString(), secret_values_exposed: false });
    return { ...result, receipt_path: receiptPath, journal_path: journalPath };
  } finally { await lock.close(); await rm(lockPath); }
}
