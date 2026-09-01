import { spawn } from "node:child_process";
import path from "node:path";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { toolError } from "./errors.mjs";
import { canonicalDigest, readJson, requireString } from "./utils.mjs";

function redact(value) {
  return value
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
  if (profile === null || profile === undefined) return args;
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
  return {
    args: profile === null
      ? ["d1", "list", "--json"]
      : ["d1", "list", "--json", "--profile", profile],
    env_overrides: { CLOUDFLARE_ACCOUNT_ID: account },
    account_id: account,
    profile,
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
  migrationRecordSqlPath = null,
}) {
  const d1Name = plan.resources?.d1?.name;
  const normalizedConfig = configPath === null ? null : safeAbsolute(configPath, "config_path");
  switch (action) {
    case "create_d1": return withProfile(["d1", "create", requireString(d1Name, "d1_name", { max: 64 }), "--json"], plan, environment);
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
      if (normalizedConfig === null || migrationReadbackSqlPath === null) throw toolError("MIGRATION_READBACK_INPUT_REQUIRED", "Migration readback requires frozen Wrangler config and read-only SQL paths");
      return withProfile(["d1", "execute", requireString(d1Name, "d1_name", { max: 64 }), "--remote", "--file", safeAbsolute(migrationReadbackSqlPath, "migration_readback_sql_path"), "--config", normalizedConfig, "--json"], plan, environment);
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
    child.on("close", (code, signal) => resolve({ code, signal, stdout: redact(Buffer.concat(stdout).toString("utf8")), stderr: redact(Buffer.concat(stderr).toString("utf8")) }));
  });
}

export async function readWranglerAccountAccess({
  wranglerExecutable,
  accountId,
  cloudflareProfile = null,
  runner = spawnCaptured,
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const probe = buildWranglerAccountProbe({ accountId, cloudflareProfile, environment: process.env });
  const result = await runner(executable, probe.args, {
    env: { ...process.env, ...probe.env_overrides },
  });
  if (result.code !== 0) {
    throw toolError("WRANGLER_ACCOUNT_READBACK_FAILED", "Wrangler could not verify D1 read access for the selected Cloudflare account/profile", { exitCode: result.code });
  }
  return {
    authenticated: true,
    executable,
    account_id: probe.account_id,
    profile: probe.profile,
    proof: "wrangler_d1_list",
    d1_read_access: true,
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
  if (configPath !== null) {
    const normalizedConfig = safeAbsolute(configPath, "config_path");
    const frozen = [...journal.events].reverse().find((event) => event.type === "wrangler_config_written");
    const config = await readJson(normalizedConfig);
    if (frozen === undefined || frozen.config_path !== normalizedConfig || frozen.config_digest !== canonicalDigest(config)) {
      throw toolError("WRANGLER_CONFIG_DRIFT", "Wrangler config does not match the frozen config recorded in the authorized operation journal", { configPath: normalizedConfig });
    }
  }
  const args = buildWranglerInvocation({
    action,
    plan,
    configPath,
    bootstrapSqlPath,
    migrationLedgerSchemaSqlPath,
    migrationReadbackSqlPath,
    migrationRecordSqlPath,
  });
  await appendJournalEvent({ stateRoot, instanceId, operationId, event: { type: "command_started", action, executable, args } });
  const result = await runner(executable, args);
  await appendJournalEvent({
    stateRoot,
    instanceId,
    operationId,
    event: {
      type: "command_finished",
      action,
      exit_code: result.code,
      signal: result.signal,
      stdout_summary: redact(result.stdout || ""),
      stderr_summary: redact(result.stderr || ""),
      readback_required: true,
    },
  });
  if (result.code !== 0) throw toolError("WRANGLER_ACTION_FAILED", "Wrangler action failed; read back remote state before deciding whether to resume", { action, exitCode: result.code });
  return { command_succeeded: true, action, readback_required: true, stdout_summary: redact(result.stdout || "") };
}
