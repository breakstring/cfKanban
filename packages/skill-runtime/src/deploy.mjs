import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { toolError } from "./errors.mjs";
import { canonicalDigest, readJson, requireString, requireUuid } from "./utils.mjs";

const MAX_MIGRATION_READBACK_SQL_BYTES = 4 * 1024;
const MAX_MIGRATION_LEDGER_ROWS = 1024;
const MAX_MIGRATION_SCHEMA_ARTIFACTS = 4096;

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
  migrationRecordSqlPath = null,
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
    case "initialize_migration_checksum_ledger":
      if (normalizedConfig === null || migrationLedgerSchemaSqlPath === null) throw toolError("MIGRATION_LEDGER_INPUT_REQUIRED", "Migration checksum ledger initialization requires frozen Wrangler config and SQL paths");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(migrationLedgerSchemaSqlPath, "migration_ledger_schema_sql_path"), "--config", normalizedConfig, "--json"], plan, environment);
    case "record_migration_checksum":
      if (normalizedConfig === null || migrationRecordSqlPath === null) throw toolError("MIGRATION_RECORD_INPUT_REQUIRED", "Migration checksum recording requires frozen Wrangler config and a private SQL path");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(migrationRecordSqlPath, "migration_record_sql_path"), "--config", normalizedConfig, "--json"], plan, environment);
    case "bootstrap_owner":
      if (normalizedConfig === null || bootstrapSqlPath === null) throw toolError("BOOTSTRAP_INPUT_REQUIRED", "Owner bootstrap requires frozen Wrangler config and private SQL paths");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(bootstrapSqlPath, "bootstrap_sql_path"), "--config", normalizedConfig], plan, environment);
    case "migration_ledger_readback":
      if (normalizedConfig === null || migrationReadbackSql === null) throw toolError("MIGRATION_READBACK_INPUT_REQUIRED", "Migration readback requires frozen Wrangler config and a read-only SQL command");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--command", requireString(migrationReadbackSql, "migration_readback_sql", { max: MAX_MIGRATION_READBACK_SQL_BYTES }), "--config", normalizedConfig, "--json"], plan, environment);
    default: throw toolError("DEPLOY_ACTION_REJECTED", "Deployment action is not in the allowlist", { action });
  }
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

function readbackString(value, field, { max, pattern = null }) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || (pattern !== null && !pattern.test(value))) {
    throw migrationReadbackInvalid(`Migration readback returned an invalid ${field}`);
  }
  return value;
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
  const args = ["deployments", "list", "--name", name, "--json"];
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
  let deployments;
  try {
    deployments = JSON.parse(result.stdout || "");
  } catch (error) {
    throw toolError("WRANGLER_WORKER_READBACK_INVALID", "Wrangler returned invalid JSON while reading back the requested Worker resource", {}, error);
  }
  if (!Array.isArray(deployments)) {
    throw toolError("WRANGLER_WORKER_READBACK_INVALID", "Wrangler Worker readback did not return a deployment list");
  }
  return {
    status: "present",
    account_id: probe.account_id,
    profile: probe.profile,
    ...(probe.context_directory === null ? {} : { context_directory: probe.context_directory }),
    worker_name: name,
  };
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
  const environment = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: requireString(plan.target?.cloudflare_account_id, "cloudflare_account_id", { max: 128 }),
  };
  let migrationReadbackSql = null;
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
  const args = buildWranglerInvocation({
    action,
    plan,
    environment,
    configPath,
    bootstrapSqlPath,
    migrationLedgerSchemaSqlPath,
    migrationReadbackSqlPath,
    migrationReadbackSql,
    migrationRecordSqlPath,
  });
  await appendJournalEvent({ stateRoot, instanceId, operationId, event: { type: "command_started", action, executable, args } });
  const result = await runner(executable, args, { env: environment });
  let migrationReadback = null;
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
      ...(migrationReadback === null ? {} : { migration_readback: migrationReadback }),
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
  };
}
