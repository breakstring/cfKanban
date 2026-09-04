import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { toolError } from "./errors.mjs";
import { assessMigrationLedgerRecovery, reconcileMigrationState } from "./migrations.mjs";
import { loadPendingCredentialSecret } from "./state.mjs";
import { canonicalDigest, normalizeLf, readJson, requireString, requireUuid, sha256Bytes } from "./utils.mjs";

const MAX_MIGRATION_READBACK_SQL_BYTES = 4 * 1024;
const MAX_MIGRATION_LEDGER_ROWS = 1024;
const MAX_MIGRATION_SCHEMA_ARTIFACTS = 4096;
const OWNER_BOOTSTRAP_READBACK_FIELDS = Object.freeze([
  "principals",
  "instance_meta",
  "instance_origin_settings",
  "credentials",
  "events",
  "operation_commits",
]);

function redact(value) {
  return String(value || "")
    .replace(/cfk_v1_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43,512}/g, "[REDACTED_CFKANBAN_CREDENTIAL]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .slice(0, 16 * 1024);
}

function safeAbsolute(filePath, name) {
  const value = requireString(filePath, name, { max: 4096 });
  if (!path.isAbsolute(value)) throw toolError("ABSOLUTE_PATH_REQUIRED", `${name} must be an absolute path`, { field: name });
  return path.normalize(value);
}

function hasCloudflareEnvironmentAuth(environment) {
  return Boolean(
    environment.CLOUDFLARE_API_TOKEN
    || (environment.CLOUDFLARE_API_KEY && environment.CLOUDFLARE_EMAIL),
  );
}

function withProfile(args, plan, environment = process.env) {
  const profile = plan.target?.cloudflare_profile;
  if (profile === null || profile === undefined) {
    const contextDirectory = plan.target?.cloudflare_auth_context_directory;
    return contextDirectory === null || contextDirectory === undefined
      ? args
      : [...args, "--cwd", safeAbsolute(contextDirectory, "cloudflare_auth_context_directory")];
  }
  if (hasCloudflareEnvironmentAuth(environment)) {
    throw toolError(
      "WRANGLER_PROFILE_SHADOWED_BY_ENV",
      "A Cloudflare environment credential would override the frozen Wrangler auth profile",
    );
  }
  return [...args, "--profile", requireString(profile, "cloudflare_profile", { max: 128 })];
}

export function buildWranglerAccountProbe({
  accountId,
  cloudflareProfile = null,
  contextDirectory = null,
  environment = {},
}) {
  const account = requireString(accountId, "account_id", { max: 128 });
  const profile = cloudflareProfile === null
    ? null
    : requireString(cloudflareProfile, "cloudflare_profile", { max: 128 });
  if (profile !== null && hasCloudflareEnvironmentAuth(environment)) {
    throw toolError(
      "WRANGLER_PROFILE_SHADOWED_BY_ENV",
      "A Cloudflare environment credential would override the requested Wrangler auth profile",
    );
  }
  if (profile !== null && contextDirectory !== null) {
    throw toolError(
      "AMBIGUOUS_WRANGLER_AUTH_CONTEXT",
      "Use either an explicit Wrangler profile or an effective context directory, not both",
    );
  }
  const context = contextDirectory === null ? null : safeAbsolute(contextDirectory, "context_directory");
  return {
    args: profile === null
      ? ["d1", "list", "--json", ...(context === null ? [] : ["--cwd", context])]
      : ["d1", "list", "--json", "--profile", profile],
    env_overrides: { CLOUDFLARE_ACCOUNT_ID: account },
    account_id: account,
    profile,
    context_directory: context,
  };
}

export function buildWranglerInvocation({
  action,
  plan,
  environment = process.env,
  configPath = null,
  bootstrapSqlPath = null,
  migrationLedgerSchemaSqlPath = null,
  migrationReadbackSqlPath = null,
  migrationReadbackSql = null,
  migrationSqlPath = null,
  migrationRecordSqlPath = null,
  ownerBootstrapReadbackSql = null,
}) {
  const d1Name = plan.resources?.d1?.name;
  const normalizedConfig = configPath === null ? null : safeAbsolute(configPath, "config_path");
  switch (action) {
    case "create_d1": return withProfile(["d1", "create", requireString(d1Name, "d1_name", { max: 64 })], plan, environment);
    case "validate_worker_bundle":
      if (normalizedConfig === null) throw toolError("CONFIG_REQUIRED", "Worker dry run requires a frozen generated Wrangler config");
      return withProfile(["deploy", "--dry-run", "--config", normalizedConfig], plan, environment);
    case "deploy_worker_and_static_assets":
      if (normalizedConfig === null) throw toolError("CONFIG_REQUIRED", "Worker deployment requires a frozen generated Wrangler config");
      return withProfile(["deploy", "--config", normalizedConfig], plan, environment);
    case "apply_non_destructive_migrations":
      if (normalizedConfig === null) throw toolError("CONFIG_REQUIRED", "Migration apply requires a frozen generated Wrangler config");
      return withProfile(["d1", "migrations", "apply", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--config", normalizedConfig], plan, environment);
    case "apply_migration":
      if (normalizedConfig === null || migrationSqlPath === null) throw toolError("MIGRATION_INPUT_REQUIRED", "Single migration apply requires frozen Wrangler config and one migration SQL path");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(migrationSqlPath, "migration_sql_path"), "--config", normalizedConfig, "--json"], plan, environment);
    case "initialize_migration_checksum_ledger":
      if (normalizedConfig === null || migrationLedgerSchemaSqlPath === null) throw toolError("MIGRATION_LEDGER_INPUT_REQUIRED", "Migration checksum ledger initialization requires frozen Wrangler config and SQL paths");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(migrationLedgerSchemaSqlPath, "migration_ledger_schema_sql_path"), "--config", normalizedConfig, "--json"], plan, environment);
    case "record_migration_checksum":
      if (normalizedConfig === null || migrationRecordSqlPath === null) throw toolError("MIGRATION_RECORD_INPUT_REQUIRED", "Migration checksum recording requires frozen Wrangler config and a private SQL path");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(migrationRecordSqlPath, "migration_record_sql_path"), "--config", normalizedConfig, "--json"], plan, environment);
    case "bootstrap_owner":
      if (normalizedConfig === null || bootstrapSqlPath === null) throw toolError("BOOTSTRAP_INPUT_REQUIRED", "Owner bootstrap requires frozen Wrangler config and private SQL paths");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(bootstrapSqlPath, "bootstrap_sql_path"), "--config", normalizedConfig], plan, environment);
    case "owner_bootstrap_readback":
      if (normalizedConfig === null || ownerBootstrapReadbackSql === null) throw toolError("OWNER_BOOTSTRAP_READBACK_INPUT_REQUIRED", "Owner bootstrap recovery readback requires frozen Wrangler config and the fixed read-only SQL command");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--command", requireString(ownerBootstrapReadbackSql, "owner_bootstrap_readback_sql", { max: MAX_MIGRATION_READBACK_SQL_BYTES }), "--config", normalizedConfig, "--json"], plan, environment);
    case "migration_ledger_readback":
      if (normalizedConfig === null || migrationReadbackSql === null) throw toolError("MIGRATION_READBACK_INPUT_REQUIRED", "Migration readback requires frozen Wrangler config and a read-only SQL command");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--command", requireString(migrationReadbackSql, "migration_readback_sql", { max: MAX_MIGRATION_READBACK_SQL_BYTES }), "--config", normalizedConfig, "--json"], plan, environment);
    case "worker_deployment_readback":
      return withProfile(["deployments", "status", "--name", requireString(plan.resources?.worker?.name, "worker_name", { max: 63 }), "--json"], plan, environment);
    default: throw toolError("DEPLOY_ACTION_REJECTED", "Deployment action is not in the allowlist", { action });
  }
}

export function buildOwnerBootstrapReadbackSql() {
  return [
    "SELECT",
    "  (SELECT COUNT(*) FROM principals) AS principals,",
    "  (SELECT COUNT(*) FROM instance_meta) AS instance_meta,",
    "  (SELECT COUNT(*) FROM instance_origin_settings) AS instance_origin_settings,",
    "  (SELECT COUNT(*) FROM credentials) AS credentials,",
    "  (SELECT COUNT(*) FROM events) AS events,",
    "  (SELECT COUNT(*) FROM operation_commits) AS operation_commits;",
    "",
  ].join("\n");
}

async function spawnCaptured(executable, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function migrationReadbackInvalid(message) {
  return toolError("WRANGLER_MIGRATION_READBACK_INVALID", message);
}

function readbackString(value, field, {
  max,
  pattern = null,
  errorCode = "WRANGLER_MIGRATION_READBACK_INVALID",
  surface = "Migration readback",
}) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || (pattern !== null && !pattern.test(value))) {
    throw toolError(errorCode, `${surface} returned an invalid ${field}`);
  }
  return value;
}

function workerResourceString(value, field, options) {
  return readbackString(value, field, {
    ...options,
    errorCode: "WRANGLER_WORKER_READBACK_INVALID",
    surface: "Wrangler Worker readback",
  });
}

function workerVersionString(value, field, options) {
  return readbackString(value, field, {
    ...options,
    errorCode: "WRANGLER_WORKER_VERSION_READBACK_INVALID",
    surface: "Wrangler Worker version readback",
  });
}

function workerVersionUuid(value, field) {
  try {
    return requireUuid(value, field);
  } catch (error) {
    throw toolError("WRANGLER_WORKER_VERSION_READBACK_INVALID", `Wrangler Worker version readback returned an invalid ${field}`, {}, error);
  }
}

function normalizeMigrationLedgerRow(row) {
  const sequence = Number(row?.sequence);
  const appliedAt = Number(row?.applied_at);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(appliedAt) || appliedAt < 1) {
    throw migrationReadbackInvalid("Migration readback returned an invalid ledger sequence or timestamp");
  }
  const classification = readbackString(row?.classification, "ledger classification", { max: 64, pattern: /^(?:bootstrap|backward_compatible|destructive)$/u });
  let operationId;
  try {
    operationId = requireUuid(row?.operation_id, "operation_id");
  } catch {
    throw migrationReadbackInvalid("Migration readback returned an invalid ledger operation ID");
  }
  return {
    sequence,
    name: readbackString(row?.name, "ledger name", { max: 256, pattern: /^[A-Za-z0-9._-]+$/u }),
    sha256: readbackString(row?.sha256, "ledger checksum", { max: 64, pattern: /^[a-f0-9]{64}$/u }),
    classification,
    reentry: readbackString(row?.reentry, "ledger reentry rule", { max: 128, pattern: /^[A-Za-z0-9._-]+$/u }),
    operation_id: operationId,
    applied_at: appliedAt,
  };
}

export function parseMigrationReadbackOutput(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ""));
  } catch {
    throw migrationReadbackInvalid("Wrangler returned invalid JSON for migration readback");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((entry) => entry?.success !== true || !Array.isArray(entry.results))) {
    throw migrationReadbackInvalid("Wrangler migration readback did not return the two expected successful result sets");
  }
  const ledgerRows = parsed[0].results;
  const schemaRows = parsed[1].results;
  if (ledgerRows.length > MAX_MIGRATION_LEDGER_ROWS || schemaRows.length > MAX_MIGRATION_SCHEMA_ARTIFACTS) {
    throw migrationReadbackInvalid("Wrangler migration readback exceeded its bounded row limits");
  }
  const ledger = ledgerRows.map(normalizeMigrationLedgerRow);
  const tables = [];
  const indexes = [];
  const seen = new Set();
  for (const row of schemaRows) {
    if (row?.type !== "table" && row?.type !== "index") {
      throw migrationReadbackInvalid("Wrangler migration readback returned an unexpected schema artifact type");
    }
    const name = readbackString(row?.name, "schema artifact name", { max: 128, pattern: /^[A-Za-z0-9_]+$/u });
    const key = `${row.type}:${name}`;
    if (seen.has(key)) throw migrationReadbackInvalid("Wrangler migration readback returned duplicate schema artifacts");
    seen.add(key);
    (row.type === "table" ? tables : indexes).push(name);
  }
  tables.sort();
  indexes.sort();
  return {
    ledger,
    schema: { tables, indexes },
    result_set_count: 2,
  };
}

function ownerBootstrapReadbackInvalid(message) {
  return toolError("WRANGLER_OWNER_BOOTSTRAP_READBACK_INVALID", message);
}

export function parseOwnerBootstrapReadbackOutput(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ""));
  } catch {
    throw ownerBootstrapReadbackInvalid("Wrangler returned invalid JSON for Owner bootstrap recovery readback");
  }
  if (!Array.isArray(parsed)
    || parsed.length !== 1
    || parsed[0]?.success !== true
    || !Array.isArray(parsed[0].results)
    || parsed[0].results.length !== 1) {
    throw ownerBootstrapReadbackInvalid("Wrangler Owner bootstrap recovery readback did not return the one expected successful result row");
  }
  const row = parsed[0].results[0];
  const counts = {};
  for (const field of OWNER_BOOTSTRAP_READBACK_FIELDS) {
    const count = row?.[field];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw ownerBootstrapReadbackInvalid(`Wrangler Owner bootstrap recovery readback returned an invalid ${field} count`);
    }
    counts[field] = count;
  }
  const absent = OWNER_BOOTSTRAP_READBACK_FIELDS.every((field) => counts[field] === 0);
  return {
    state: absent ? "absent" : "present_or_partial",
    safe_to_retry: absent,
    counts,
  };
}

function assertOwnerBootstrapCanRun(journal) {
  const attemptIndex = journal.events.findLastIndex((event) => event?.type === "command_started" && event.action === "bootstrap_owner");
  if (attemptIndex < 0) return;
  const finishIndex = journal.events.findLastIndex((event, index) => index > attemptIndex && event?.type === "command_finished" && event.action === "bootstrap_owner");
  if (finishIndex > attemptIndex && journal.events[finishIndex].exit_code === 0) {
    throw toolError("OWNER_BOOTSTRAP_ALREADY_ATTEMPTED", "Owner bootstrap already succeeded; use deployment finalization instead of executing it again");
  }
  const observedRemoteState = journal.events.slice(attemptIndex + 1).some((event) => event?.type === "command_finished"
    && event.action === "owner_bootstrap_readback"
    && event.exit_code === 0
    && event.owner_bootstrap_readback?.state === "present_or_partial");
  if (observedRemoteState) {
    throw toolError("OWNER_BOOTSTRAP_REMOTE_STATE_PRESENT", "Owner bootstrap readback observed remote or partial state; do not execute bootstrap again");
  }
  const readbackIndex = journal.events.findLastIndex((event, index) => index > attemptIndex && event?.type === "command_finished" && event.action === "owner_bootstrap_readback");
  const readback = readbackIndex > attemptIndex ? journal.events[readbackIndex] : null;
  if (readback?.exit_code === 0
    && readback.owner_bootstrap_readback?.state === "absent"
    && readback.owner_bootstrap_readback?.safe_to_retry === true) {
    return;
  }
  throw toolError(
    "OWNER_BOOTSTRAP_ALREADY_ATTEMPTED",
    "Owner bootstrap was already attempted; run the plan-bound Owner bootstrap readback and retry only when it proves every bootstrap table is still empty",
  );
}

export async function readWranglerAccountAccess({
  wranglerExecutable,
  accountId,
  cloudflareProfile = null,
  contextDirectory = null,
  environment = process.env,
  runner = spawnCaptured,
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const probe = buildWranglerAccountProbe({ accountId, cloudflareProfile, contextDirectory, environment });
  const result = await runner(executable, probe.args, {
    env: { ...environment, ...probe.env_overrides, WRANGLER_WRITE_LOGS: "false" },
  });
  if (result.code !== 0) {
    throw toolError("WRANGLER_ACCOUNT_READBACK_FAILED", "Wrangler could not verify D1 read access for the selected Cloudflare account/profile", { exitCode: result.code });
  }
  return {
    authenticated: true,
    executable,
    account_id: probe.account_id,
    profile: probe.profile,
    ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
    proof: "wrangler_d1_list",
    d1_read_access: true,
  };
}

export async function readD1ResourceByName({
  wranglerExecutable,
  accountId,
  d1Name,
  cloudflareProfile = null,
  contextDirectory = null,
  environment = process.env,
  runner = spawnCaptured,
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const name = requireString(d1Name, "d1_name", { max: 64 });
  const probe = buildWranglerAccountProbe({ accountId, cloudflareProfile, contextDirectory, environment });
  const result = await runner(executable, probe.args, {
    env: { ...environment, ...probe.env_overrides, WRANGLER_WRITE_LOGS: "false" },
  });
  if (result.code !== 0) {
    throw toolError("WRANGLER_D1_READBACK_FAILED", "Wrangler could not read back the requested D1 resource", { exitCode: result.code });
  }
  let resources;
  try {
    resources = JSON.parse(result.stdout || "");
  } catch (error) {
    throw toolError("WRANGLER_D1_READBACK_INVALID", "Wrangler returned invalid JSON while reading back the requested D1 resource", {}, error);
  }
  if (!Array.isArray(resources)) {
    throw toolError("WRANGLER_D1_READBACK_INVALID", "Wrangler D1 readback did not return a resource list");
  }
  const matches = resources.filter((resource) => resource?.name === name);
  if (matches.length === 0) {
    return {
      status: "absent",
      account_id: probe.account_id,
      profile: probe.profile,
      ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
      d1_name: name,
      database_id: null,
    };
  }
  if (matches.length !== 1) {
    throw toolError("WRANGLER_D1_READBACK_AMBIGUOUS", "Wrangler returned more than one exact D1 name match", { d1Name: name });
  }
  let databaseId;
  try {
    databaseId = requireUuid(matches[0].uuid, "database_id");
  } catch (error) {
    throw toolError("WRANGLER_D1_READBACK_INVALID", "Wrangler returned an invalid D1 database UUID", { d1Name: name }, error);
  }
  return {
    status: "present",
    account_id: probe.account_id,
    profile: probe.profile,
    ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
    d1_name: name,
    database_id: databaseId,
  };
}

function hasCloudflareApiErrorCode(result, code) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return new RegExp(`\\[code:\\s*${code}\\]`, "u").test(output);
}

function parseWorkerDeployment(value) {
  let deployment;
  try {
    deployment = JSON.parse(value || "");
  } catch (error) {
    throw toolError("WRANGLER_WORKER_READBACK_INVALID", "Wrangler returned invalid JSON while reading back the requested Worker resource", {}, error);
  }
  if (deployment === null || typeof deployment !== "object" || Array.isArray(deployment)) {
    throw toolError("WRANGLER_WORKER_READBACK_INVALID", "Wrangler Worker status did not return one current deployment object");
  }
  let deploymentId;
  let versionId;
  try {
    deploymentId = requireUuid(deployment?.id, "worker_deployment_id");
    const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
    if (versions.length !== 1 || Number(versions[0]?.percentage) !== 100) {
      throw new Error("Worker deployment must have exactly one version at 100 percent");
    }
    versionId = requireUuid(versions[0].version_id, "worker_version_id");
  } catch (error) {
    throw toolError("WRANGLER_WORKER_READBACK_INVALID", "Wrangler returned an unsupported Worker deployment strategy", {}, error);
  }
  const createdOn = workerResourceString(deployment?.created_on, "deployment timestamp", { max: 128 });
  if (Number.isNaN(Date.parse(createdOn))) {
    throw toolError("WRANGLER_WORKER_READBACK_INVALID", "Wrangler returned an invalid Worker deployment timestamp");
  }
  return {
    deployment_id: deploymentId,
    version_id: versionId,
    created_on: createdOn,
  };
}

const PUBLIC_RATE_LIMIT_VARS = new Set([
  "RATE_LIMIT_INSTANCE_LIMIT",
  "RATE_LIMIT_INSTANCE_PERIOD_SECONDS",
  "RATE_LIMIT_PRINCIPAL_LIMIT",
  "RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS",
  "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT",
  "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS",
]);

function parseWorkerVersion(value, expectedVersionId) {
  let version;
  try {
    version = JSON.parse(value || "");
  } catch (error) {
    throw toolError("WRANGLER_WORKER_VERSION_READBACK_INVALID", "Wrangler returned invalid JSON for the Worker version", {}, error);
  }
  let versionId;
  try {
    versionId = requireUuid(version?.id, "worker_version_id");
  } catch (error) {
    throw toolError("WRANGLER_WORKER_VERSION_READBACK_INVALID", "Wrangler returned an invalid Worker version ID", {}, error);
  }
  if (versionId !== expectedVersionId || !Array.isArray(version?.resources?.bindings)) {
    throw toolError("WRANGLER_WORKER_VERSION_READBACK_INVALID", "Wrangler Worker version does not match the requested version or has no binding list");
  }
  const bindings = version.resources.bindings.map((binding) => {
    const type = workerVersionString(binding?.type, "binding type", { max: 64, pattern: /^[A-Za-z0-9_-]+$/u });
    const name = workerVersionString(binding?.name, "binding name", { max: 128, pattern: /^[A-Za-z0-9_]+$/u });
    if (type === "d1") {
      return { type, name, database_id: workerVersionUuid(binding.database_id, "binding database ID") };
    }
    if (type === "ratelimit") {
      return {
        type,
        name,
        namespace_id: workerVersionString(binding.namespace_id, "rate-limit namespace ID", { max: 64, pattern: /^[A-Za-z0-9_-]+$/u }),
      };
    }
    if (type === "plain_text" && PUBLIC_RATE_LIMIT_VARS.has(name)) {
      return {
        type,
        name,
        text: workerVersionString(binding.text ?? binding.value, "rate-limit variable", { max: 32, pattern: /^\d+$/u }),
      };
    }
    return { type, name, value_redacted: true };
  }).sort((left, right) => (left.type + ":" + left.name).localeCompare(right.type + ":" + right.name));
  return { version_id: versionId, bindings };
}

export async function readD1RestorePoint({
  wranglerExecutable,
  accountId,
  d1Name,
  cloudflareProfile = null,
  contextDirectory = null,
  environment = process.env,
  runner = spawnCaptured,
  now = () => new Date(),
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const name = requireString(d1Name, "d1_name", { max: 64 });
  const probe = buildWranglerAccountProbe({ accountId, cloudflareProfile, contextDirectory, environment });
  const args = ["d1", "time-travel", "info", name, "--json"];
  if (probe.profile !== null) args.push("--profile", probe.profile);
  if (probe.context_directory !== null) args.push("--cwd", probe.context_directory);
  const result = await runner(executable, args, {
    env: { ...environment, ...probe.env_overrides, WRANGLER_WRITE_LOGS: "false" },
  });
  if (result.code !== 0) {
    throw toolError("WRANGLER_D1_RESTORE_POINT_FAILED", "Wrangler could not obtain a D1 Time Travel bookmark", { exitCode: result.code });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "");
  } catch (error) {
    throw toolError("WRANGLER_D1_RESTORE_POINT_INVALID", "Wrangler returned invalid JSON for the D1 restore point", {}, error);
  }
  const bookmark = readbackString(parsed?.bookmark, "D1 restore bookmark", {
    max: 512,
    pattern: /^[A-Za-z0-9_-]+$/u,
    errorCode: "WRANGLER_D1_RESTORE_POINT_INVALID",
    surface: "Wrangler D1 restore-point readback",
  });
  return {
    status: "available",
    account_id: probe.account_id,
    profile: probe.profile,
    ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
    d1_name: name,
    bookmark,
    observed_at: now().toISOString(),
    retention_boundary: null,
    retention_boundary_source: "not_reported_by_wrangler",
    restore_overwrites_later_writes: true,
    restore_automatic: false,
  };
}

export async function readWorkerVersionById({
  wranglerExecutable,
  accountId,
  workerName,
  versionId,
  cloudflareProfile = null,
  contextDirectory = null,
  environment = process.env,
  runner = spawnCaptured,
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const name = requireString(workerName, "worker_name", { max: 63 });
  const expectedVersionId = requireUuid(versionId, "worker_version_id");
  const probe = buildWranglerAccountProbe({ accountId, cloudflareProfile, contextDirectory, environment });
  const args = ["versions", "view", expectedVersionId, "--name", name, "--json"];
  if (probe.profile !== null) args.push("--profile", probe.profile);
  if (probe.context_directory !== null) args.push("--cwd", probe.context_directory);
  const result = await runner(executable, args, {
    env: { ...environment, ...probe.env_overrides, WRANGLER_WRITE_LOGS: "false" },
  });
  if (result.code !== 0) {
    throw toolError("WRANGLER_WORKER_VERSION_READBACK_FAILED", "Wrangler could not read the requested Worker version", { exitCode: result.code });
  }
  return {
    status: "present",
    account_id: probe.account_id,
    profile: probe.profile,
    ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
    worker_name: name,
    ...parseWorkerVersion(result.stdout, expectedVersionId),
  };
}

export async function readWorkerResourceByName({
  wranglerExecutable,
  accountId,
  workerName,
  cloudflareProfile = null,
  contextDirectory = null,
  environment = process.env,
  runner = spawnCaptured,
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const name = requireString(workerName, "worker_name", { max: 63 });
  const probe = buildWranglerAccountProbe({ accountId, cloudflareProfile, contextDirectory, environment });
  const args = ["deployments", "status", "--name", name, "--json"];
  if (probe.profile !== null) args.push("--profile", probe.profile);
  if (probe.context_directory !== null) args.push("--cwd", probe.context_directory);
  const result = await runner(executable, args, {
    env: { ...environment, ...probe.env_overrides, WRANGLER_WRITE_LOGS: "false" },
  });
  if (result.code !== 0) {
    if (hasCloudflareApiErrorCode(result, 10007)) {
      return {
        status: "absent",
        account_id: probe.account_id,
        profile: probe.profile,
        ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
        worker_name: name,
      };
    }
    throw toolError("WRANGLER_WORKER_READBACK_FAILED", "Wrangler could not read back the requested Worker resource", { exitCode: result.code });
  }
  return {
    status: "present",
    account_id: probe.account_id,
    profile: probe.profile,
    ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
    worker_name: name,
    ...parseWorkerDeployment(result.stdout),
  };
}

function latestFinished(events, action) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "command_finished" && event.action === action) return { event, index };
  }
  return null;
}

async function loadUpgradeMigrationState({ journal, plan, frozenConfigEvent }) {
  if (frozenConfigEvent === null || typeof frozenConfigEvent.service_bundle_root !== "string") {
    throw toolError("UPGRADE_SERVICE_BUNDLE_REQUIRED", "Instance upgrade requires a journaled verified Service bundle");
  }
  if (frozenConfigEvent.service_bundle_artifact_sha256 !== plan.release?.service_bundle_sha256) {
    throw toolError("UPGRADE_SERVICE_BUNDLE_DRIFT", "Journaled Service bundle does not match the upgrade plan");
  }
  const manifestPath = path.join(frozenConfigEvent.service_bundle_root, "migrations", "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  if (sha256Bytes(manifestBytes) !== plan.target?.migration_manifest_sha256) {
    throw toolError("UPGRADE_MIGRATION_MANIFEST_DRIFT", "Service migration manifest does not match the upgrade plan");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const planned = Array.isArray(plan.migrations?.ordered) ? plan.migrations.ordered : [];
  for (const migration of planned) {
    const frozen = manifest.migrations?.find((entry) => entry.sequence === migration.sequence && entry.name === migration.name);
    if (frozen?.sha256 !== migration.sha256
      || frozen?.destructive === true
      || frozen?.classification !== "backward_compatible") {
      throw toolError("UPGRADE_MIGRATION_MANIFEST_DRIFT", "Planned migration delta differs from the verified Service manifest", {
        sequence: migration.sequence,
        name: migration.name,
      });
    }
  }
  const latestReadback = latestFinished(journal.events, "migration_ledger_readback");
  if (latestReadback?.event?.exit_code !== 0 || latestReadback.event.migration_readback === undefined) {
    throw toolError("MIGRATION_READBACK_REQUIRED", "Instance upgrade requires a successful normalized migration readback");
  }
  const state = reconcileMigrationState({
    manifest,
    ledger: latestReadback.event.migration_readback.ledger,
    schema: latestReadback.event.migration_readback.schema,
  });
  return { manifest, manifestPath, planned, state, latestReadback };
}

async function validateUpgradeAction({
  journal,
  plan,
  action,
  frozenConfigEvent,
  migrationSqlPath,
  migrationName,
  stateRoot,
  instanceId,
  operationId,
  taskId,
}) {
  const allowed = new Set([
    "migration_ledger_readback",
    "apply_migration",
    "record_migration_checksum",
    "validate_worker_bundle",
    "deploy_worker_and_static_assets",
    "worker_deployment_readback",
  ]);
  if (!allowed.has(action)) {
    throw toolError("UPGRADE_ACTION_REJECTED", "Action is not allowed for an existing Instance upgrade", { action });
  }
  if (action === "migration_ledger_readback") return { migration: null };
  const migrationState = await loadUpgradeMigrationState({ journal, plan, frozenConfigEvent });

  if (action === "apply_migration") {
    if (!migrationState.state.safe_to_continue) {
      throw toolError("MIGRATION_STATE_UNSAFE", "Instance upgrade migration ledger or schema has drift");
    }
    const name = requireString(migrationName, "migration_name", { max: 256 });
    const migration = migrationState.planned.find((entry) => entry.name === name);
    if (migration === undefined) {
      throw toolError("UPGRADE_MIGRATION_NOT_PLANNED", "Migration is not part of the authorized upgrade delta", { name });
    }
    const expectedPath = path.join(frozenConfigEvent.service_bundle_root, "migrations", migration.name);
    const actualPath = safeAbsolute(migrationSqlPath, "migration_sql_path");
    if (actualPath !== expectedPath) {
      throw toolError("UPGRADE_MIGRATION_SOURCE_DRIFT", "Migration SQL must come from the verified Service bundle", { name });
    }
    const migrationText = await readFile(actualPath, "utf8");
    if (sha256Bytes(Buffer.from(normalizeLf(migrationText), "utf8")) !== migration.sha256) {
      throw toolError("UPGRADE_MIGRATION_SOURCE_DRIFT", "Migration SQL digest differs from the upgrade plan", { name });
    }
    const selected = migrationState.state.migrations.find((entry) => entry.sequence === migration.sequence && entry.name === migration.name);
    const earlierIncomplete = migrationState.state.migrations.some((entry) => entry.sequence < migration.sequence && entry.state !== "applied");
    if (selected?.state !== "pending" || earlierIncomplete) {
      throw toolError("UPGRADE_MIGRATION_ORDER_VIOLATION", "Only the next pending migration may be applied", { name });
    }
    const alreadyApplied = journal.events.some((event) => event?.type === "command_finished"
      && event.action === "apply_migration"
      && event.exit_code === 0
      && event.migration?.name === name);
    if (alreadyApplied) {
      throw toolError("UPGRADE_MIGRATION_ALREADY_ATTEMPTED", "Migration already succeeded in this journal; read back before continuing", { name });
    }
    return { migration };
  }

  const incomplete = migrationState.state.migrations.filter((entry) => entry.state !== "applied");
  if (action === "record_migration_checksum") {
    const name = requireString(migrationName, "migration_name", { max: 256 });
    const migration = migrationState.planned.find((entry) => entry.name === name);
    const alreadyRecorded = journal.events.some((event) => event?.type === "command_finished"
      && event.action === "record_migration_checksum"
      && event.exit_code === 0
      && event.migration?.name === name);
    if (alreadyRecorded) {
      throw toolError("UPGRADE_MIGRATION_CHECKSUM_ALREADY_RECORDED", "Checksum recording already succeeded; read back ledger and schema before continuing", { name });
    }
    const recovery = await assessMigrationLedgerRecovery({
      stateRoot,
      instanceId,
      operationId,
      taskId,
      plan,
      migrationManifestPath: migrationState.manifestPath,
    });
    if (migration === undefined
      || recovery.safe_to_record_missing_checksum !== true
      || recovery.migration?.sequence !== migration.sequence
      || recovery.migration?.name !== migration.name
      || recovery.migration?.sha256 !== migration.sha256) {
      throw toolError("UPGRADE_MIGRATION_RECORD_REJECTED", "Checksum recording requires a post-apply readback and exact same-journal recovery proof", {
        name,
        blockers: recovery.blockers || [],
      });
    }
    return { migration };
  }
  if (!migrationState.state.safe_to_continue) {
    throw toolError("MIGRATION_STATE_UNSAFE", "Instance upgrade migration ledger or schema has drift");
  }
  if (incomplete.length > 0) {
    throw toolError("MIGRATION_STATE_INCOMPLETE", "Worker validation and deployment require every target migration to be applied and read back", {
      incomplete: incomplete.map((entry) => ({ sequence: entry.sequence, name: entry.name, state: entry.state })),
    });
  }
  if (action === "deploy_worker_and_static_assets") {
    const dryRun = latestFinished(journal.events, "validate_worker_bundle");
    if (dryRun?.event?.exit_code !== 0) {
      throw toolError("WORKER_DRY_RUN_REQUIRED", "Instance upgrade requires a successful Worker dry run before deployment");
    }
    const priorDeploy = latestFinished(journal.events, "deploy_worker_and_static_assets");
    if (priorDeploy?.event?.exit_code === 0) {
      throw toolError("WORKER_ALREADY_DEPLOYED", "Worker deployment already succeeded; use readback and finalization");
    }
  }
  if (action === "worker_deployment_readback") {
    const deploy = latestFinished(journal.events, "deploy_worker_and_static_assets");
    if (deploy?.event?.exit_code !== 0) {
      throw toolError("WORKER_DEPLOYMENT_REQUIRED", "Worker deployment readback requires a successful deployment");
    }
  }
  return { migration: null };
}

export async function executeWranglerAction({
  stateRoot,
  instanceId,
  operationId,
  taskId,
  plan,
  wranglerExecutable,
  action,
  configPath = null,
  bootstrapSqlPath = null,
  migrationLedgerSchemaSqlPath = null,
  migrationReadbackSqlPath = null,
  migrationSqlPath = null,
  migrationName = null,
  migrationRecordSqlPath = null,
  runner = spawnCaptured,
}) {
  const journal = await assertJournalAuthorization({ stateRoot, instanceId, operationId, taskId, plan });
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  let frozenConfigEvent = null;
  if (configPath !== null) {
    const normalizedConfig = safeAbsolute(configPath, "config_path");
    frozenConfigEvent = [...journal.events].reverse().find((event) => event.type === "wrangler_config_written") || null;
    const config = await readJson(normalizedConfig);
    if (frozenConfigEvent === null || frozenConfigEvent.config_path !== normalizedConfig || frozenConfigEvent.config_digest !== canonicalDigest(config)) {
      throw toolError("WRANGLER_CONFIG_DRIFT", "Wrangler config does not match the frozen config recorded in the authorized operation journal", { configPath: normalizedConfig });
    }
  }
  if (plan.kind === "deployed_instance_upgrade" && configPath === null) {
    throw toolError("CONFIG_REQUIRED", "Instance upgrade actions require the frozen generated Wrangler config");
  }
  const upgradeAction = plan.kind === "deployed_instance_upgrade"
    ? await validateUpgradeAction({
        journal,
        plan,
        action,
        frozenConfigEvent,
        migrationSqlPath,
        migrationName,
        stateRoot,
        instanceId,
        operationId,
        taskId,
      })
    : { migration: null };
  let actionMigration = upgradeAction.migration;
  if (action === "record_migration_checksum") {
    const recordPath = safeAbsolute(migrationRecordSqlPath, "migration_record_sql_path");
    const recordEvent = [...journal.events].reverse().find((event) => event?.type === "migration_record_sql_written") || null;
    const bytes = await readFile(recordPath);
    if (recordEvent === null
      || recordEvent.migration_record_sql_path !== recordPath
      || recordEvent.migration_record_sql_sha256 !== sha256Bytes(bytes)
      || recordEvent.migration?.name !== requireString(migrationName, "migration_name", { max: 256 })) {
      throw toolError("MIGRATION_RECORD_SQL_DRIFT", "Checksum SQL does not match the same authorized journal evidence");
    }
    if (actionMigration !== null
      && (recordEvent.migration.sequence !== actionMigration.sequence
        || recordEvent.migration.sha256 !== actionMigration.sha256)) {
      throw toolError("MIGRATION_RECORD_SQL_DRIFT", "Checksum SQL migration differs from the authorized upgrade delta");
    }
    actionMigration = recordEvent.migration;
  }
  const environment = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: requireString(plan.target?.cloudflare_account_id, "cloudflare_account_id", { max: 128 }),
  };
  let migrationReadbackSql = null;
  let ownerBootstrapReadbackSql = null;
  if (action === "migration_ledger_readback") {
    if (migrationReadbackSqlPath === null) {
      throw toolError("MIGRATION_READBACK_INPUT_REQUIRED", "Migration readback requires a frozen read-only SQL path");
    }
    const readbackPath = safeAbsolute(migrationReadbackSqlPath, "migration_readback_sql_path");
    const expectedReadbackPath = frozenConfigEvent === null || typeof frozenConfigEvent.service_bundle_root !== "string"
      ? null
      : path.join(frozenConfigEvent.service_bundle_root, "release", "deployment", "migration-readback.sql");
    if (expectedReadbackPath === null || readbackPath !== expectedReadbackPath) {
      throw toolError("MIGRATION_READBACK_SOURCE_DRIFT", "Migration readback SQL must come from the verified Service bundle recorded in the operation journal");
    }
    const bytes = await readFile(readbackPath);
    if (bytes.length === 0 || bytes.length > MAX_MIGRATION_READBACK_SQL_BYTES || bytes.includes(0)) {
      throw toolError("MIGRATION_READBACK_SQL_INVALID", "Migration readback SQL is empty, oversized, or contains a NUL byte");
    }
    migrationReadbackSql = bytes.toString("utf8");
  }
  if (action === "owner_bootstrap_readback") {
    const priorAttempt = journal.events.find((event) => event?.type === "command_started" && event.action === "bootstrap_owner") || null;
    if (priorAttempt === null) {
      throw toolError("OWNER_BOOTSTRAP_READBACK_NOT_REQUIRED", "Owner bootstrap recovery readback requires a prior journaled bootstrap attempt");
    }
    ownerBootstrapReadbackSql = buildOwnerBootstrapReadbackSql();
  }
  if (action === "bootstrap_owner" || action === "owner_bootstrap_readback") {
    const bootstrapPath = safeAbsolute(bootstrapSqlPath, "bootstrap_sql_path");
    const bootstrapEvent = [...journal.events].reverse().find((event) => event?.type === "owner_bootstrap_sql_written") || null;
    if (bootstrapEvent === null
      || bootstrapEvent.bootstrap_sql_path !== bootstrapPath
      || bootstrapEvent.bootstrap_sql_sha256 !== sha256Bytes(await readFile(bootstrapPath))) {
      throw toolError("OWNER_BOOTSTRAP_SQL_DRIFT", "Owner bootstrap SQL does not match the plan-bound journal evidence");
    }
    const { metadata } = await loadPendingCredentialSecret({ stateRoot, instanceId });
    if (metadata.operation_id !== operationId
      || metadata.principal_id !== plan.owner_bootstrap?.owner_principal_id
      || metadata.credential_id !== plan.owner_bootstrap?.owner_credential_id
      || metadata.purpose !== "owner_bootstrap"
      || metadata.fingerprint !== bootstrapEvent.credential_fingerprint) {
      throw toolError("STATE_IDENTITY_CONFLICT", "Pending Owner Credential does not match the authorized bootstrap SQL and plan");
    }
    if (action === "bootstrap_owner") assertOwnerBootstrapCanRun(journal);
  }
  const args = buildWranglerInvocation({
    action,
    plan,
    environment,
    configPath,
    bootstrapSqlPath,
    migrationLedgerSchemaSqlPath,
    migrationReadbackSqlPath,
    migrationReadbackSql,
    migrationSqlPath,
    migrationRecordSqlPath,
    ownerBootstrapReadbackSql,
  });
  await appendJournalEvent({
    stateRoot,
    instanceId,
    operationId,
    event: {
      type: "command_started",
      action,
      executable,
      args,
      ...(actionMigration === null ? {} : {
        migration: {
          sequence: actionMigration.sequence,
          name: actionMigration.name,
          sha256: actionMigration.sha256,
        },
      }),
    },
  });
  const result = await runner(executable, args, {
    env: ["owner_bootstrap_readback", "migration_ledger_readback", "worker_deployment_readback"].includes(action)
      ? { ...environment, WRANGLER_WRITE_LOGS: "false" }
      : environment,
  });
  let migrationReadback = null;
  let ownerBootstrapReadback = null;
  let workerDeploymentReadback = null;
  let stdoutSummary = redact(result.stdout || "");
  let readbackError = null;
  if (result.code === 0 && action === "migration_ledger_readback") {
    try {
      migrationReadback = parseMigrationReadbackOutput(result.stdout);
      stdoutSummary = JSON.stringify({
        result_sets: migrationReadback.result_set_count,
        ledger_rows: migrationReadback.ledger.length,
        schema_tables: migrationReadback.schema.tables.length,
        schema_indexes: migrationReadback.schema.indexes.length,
      });
    } catch (error) {
      readbackError = error;
      stdoutSummary = "[MIGRATION_READBACK_OUTPUT_REJECTED]";
    }
  }
  if (result.code === 0 && action === "owner_bootstrap_readback") {
    try {
      ownerBootstrapReadback = parseOwnerBootstrapReadbackOutput(result.stdout);
      stdoutSummary = JSON.stringify({
        state: ownerBootstrapReadback.state,
        safe_to_retry: ownerBootstrapReadback.safe_to_retry,
      });
    } catch (error) {
      readbackError = error;
      stdoutSummary = "[OWNER_BOOTSTRAP_READBACK_OUTPUT_REJECTED]";
    }
  }
  if (result.code === 0 && action === "worker_deployment_readback") {
    try {
      workerDeploymentReadback = parseWorkerDeployment(result.stdout);
      stdoutSummary = JSON.stringify(workerDeploymentReadback);
    } catch (error) {
      readbackError = error;
      stdoutSummary = "[WORKER_DEPLOYMENT_READBACK_REJECTED]";
    }
  }
  await appendJournalEvent({
    stateRoot,
    instanceId,
    operationId,
    event: {
      type: "command_finished",
      action,
      exit_code: result.code,
      signal: result.signal,
      stdout_summary: stdoutSummary,
      stderr_summary: redact(result.stderr || ""),
      readback_required: true,
      ...(actionMigration === null ? {} : {
        migration: {
          sequence: actionMigration.sequence,
          name: actionMigration.name,
          sha256: actionMigration.sha256,
        },
      }),
      ...(migrationReadback === null ? {} : { migration_readback: migrationReadback }),
      ...(ownerBootstrapReadback === null ? {} : { owner_bootstrap_readback: ownerBootstrapReadback }),
      ...(workerDeploymentReadback === null ? {} : { worker_deployment_readback: workerDeploymentReadback }),
    },
  });
  if (result.code !== 0) throw toolError("WRANGLER_ACTION_FAILED", "Wrangler action failed; read back remote state before deciding whether to resume", { action, exitCode: result.code });
  if (readbackError !== null) throw readbackError;
  return {
    command_succeeded: true,
    action,
    readback_required: true,
    stdout_summary: stdoutSummary,
    ...(migrationReadback === null ? {} : { migration_readback: migrationReadback }),
    ...(ownerBootstrapReadback === null ? {} : { owner_bootstrap_readback: ownerBootstrapReadback }),
    ...(workerDeploymentReadback === null ? {} : { worker_deployment_readback: workerDeploymentReadback }),
  };
}
