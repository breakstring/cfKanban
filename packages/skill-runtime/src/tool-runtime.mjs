import { access, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveToolRuntimeRoot } from "./paths.mjs";
import { atomicWriteJson, canonicalDigest, ensurePrivateDirectory, pathType, requireString } from "./utils.mjs";
import { toolError } from "./errors.mjs";

const CFKANBAN_OAUTH_SCOPES = Object.freeze([
  "account:read",
  "user:read",
  "workers_scripts:write",
  "d1:write",
]);

const AUTH_MODES = Object.freeze([
  "named_profile_browser",
  "default_profile_browser",
  "default_profile_device",
]);

const WRANGLER_AUTH_CONTRACT_RANGE = ">=4.127.1 <5.0.0";
const MAX_DISCOVERED_PROFILES = 32;
const MAX_DISCOVERED_ACCOUNT_MAPPINGS = 128;

function safeAbsolute(filePath, name) {
  const value = requireString(filePath, name, { max: 4096 });
  if (!path.isAbsolute(value)) throw toolError("ABSOLUTE_PATH_REQUIRED", `${name} must be an absolute path`, { field: name });
  return path.normalize(value);
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function validateProfileName(value, { allowDefault = true } = {}) {
  const profile = requireString(value, "profile_name", { max: 128 });
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw toolError("INVALID_WRANGLER_PROFILE", "Wrangler profile names may contain only letters, numbers, hyphens, and underscores", { profile });
  }
  if (!allowDefault && ["default", "staging"].includes(profile.toLowerCase())) {
    throw toolError("RESERVED_WRANGLER_PROFILE", "The selected name is reserved by Wrangler and cannot be used for a named profile", { profile });
  }
  return profile;
}

function environmentAuthNames(environment) {
  const names = [];
  if (environment.CLOUDFLARE_API_TOKEN) names.push("CLOUDFLARE_API_TOKEN");
  if (environment.CLOUDFLARE_API_KEY) names.push("CLOUDFLARE_API_KEY");
  if (environment.CLOUDFLARE_EMAIL) names.push("CLOUDFLARE_EMAIL");
  return names;
}

async function spawnCaptured(executable, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8").slice(0, 64 * 1024),
      stderr: Buffer.concat(stderr).toString("utf8").slice(0, 64 * 1024),
    }));
  });
}

async function spawnInteractive(executable, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function parseVersion(value) {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(value || "");
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function satisfiesSimpleRange(versionText, range) {
  const version = parseVersion(versionText);
  if (version === null) return false;
  return requireString(range, "version_range").split(/\s+/).every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
    if (!match) return false;
    const target = [Number(match[2]), Number(match[3] || 0), Number(match[4] || 0)];
    const relation = compare(version, target);
    switch (match[1] || "=") {
      case ">=": return relation >= 0;
      case "<=": return relation <= 0;
      case ">": return relation > 0;
      case "<": return relation < 0;
      default: return relation === 0;
    }
  });
}

async function executableExists(filePath) {
  try {
    await access(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" ? `${name}${extension.toLowerCase()}` : name);
      if (await executableExists(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

async function versionOf(executable) {
  return new Promise((resolve) => {
    const child = spawn(executable, ["--version"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/, 1)[0] : null));
  });
}

export async function resolveWrangler({ explicitPath = null, requiredRange, runtimeRoot = resolveToolRuntimeRoot(), env = process.env, platform = process.platform }) {
  const candidates = [];
  if (explicitPath !== null) {
    if (!path.isAbsolute(explicitPath)) throw toolError("ABSOLUTE_PATH_REQUIRED", "Explicit Wrangler path must be absolute");
    candidates.push({ source: "explicit", path: explicitPath });
  }
  const fromPath = await pathExecutable(platform === "win32" ? "wrangler" : "wrangler", { env, platform });
  if (fromPath !== null && !candidates.some((entry) => entry.path === fromPath)) candidates.push({ source: "path", path: fromPath });
  const runtimeVersions = path.join(runtimeRoot, "versions");
  try {
    const active = JSON.parse(await readFile(path.join(runtimeRoot, "active.json"), "utf8"));
    const runtimeExecutable = path.join(runtimeVersions, active.version, "node_modules", ".bin", platform === "win32" ? "wrangler.cmd" : "wrangler");
    candidates.push({ source: "cfkanban_tool_runtime", path: runtimeExecutable });
  } catch {
    // No active private runtime is a normal probe result.
  }
  for (const candidate of candidates) {
    if (!await executableExists(candidate.path)) continue;
    const version = await versionOf(candidate.path);
    if (version !== null && satisfiesSimpleRange(version, requiredRange)) return { status: "compatible", ...candidate, version, required_range: requiredRange };
  }
  return { status: candidates.length === 0 ? "unavailable" : "incompatible", required_range: requiredRange, candidates: await Promise.all(candidates.map(async (candidate) => ({ ...candidate, version: await versionOf(candidate.path) }))) };
}

export async function inspectCloudflareAuth({
  wranglerExecutable,
  profileName,
  runner = spawnCaptured,
  environment = process.env,
  platform = process.platform,
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const profile = validateProfileName(profileName);
  const probes = [
    ["--version"],
    ["auth", "create", "--help"],
    ["auth", "keyring"],
    ["auth", "list"],
    ["login", "--help"],
    ["login", "--scopes-list"],
  ];
  const results = [];
  for (const args of probes) {
    const result = await runner(executable, args, { env: { ...environment, WRANGLER_WRITE_LOGS: "false" } });
    results.push({
      args,
      code: result?.code,
      stdout: stripAnsi(result?.stdout),
      stderr: stripAnsi(result?.stderr),
    });
  }

  const [versionProbe, namedProfileHelp, keyringProbe, profilesProbe, loginHelp, scopesProbe] = results;
  const version = versionProbe.code === 0 ? versionProbe.stdout.trim().split(/\r?\n/, 1)[0] : null;
  const keyringText = `${keyringProbe.stdout}\n${keyringProbe.stderr}`;
  const effectiveMatch = /Keyring storage is (enabled|disabled)/i.exec(keyringText);
  const persistedMatch = /persisted preference:\s*(enabled|disabled)/i.exec(keyringText);
  const keyringEnabled = effectiveMatch === null ? null : effectiveMatch[1].toLowerCase() === "enabled";
  const persistedKeyringEnabled = persistedMatch === null ? keyringEnabled : persistedMatch[1].toLowerCase() === "enabled";
  const profileText = `${profilesProbe.stdout}\n${profilesProbe.stderr}`;
  const escapedProfile = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const profileExists = profilesProbe.code !== 0
    ? null
    : /No profiles found\./i.test(profileText)
      ? false
      : new RegExp(`(^|[^A-Za-z0-9_-])${escapedProfile}(?=$|[^A-Za-z0-9_-])`, "m").test(profileText);
  const availableRequiredScopes = CFKANBAN_OAUTH_SCOPES.filter((scope) => {
    const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_:-])${escaped}(?=$|[^A-Za-z0-9_:-])`, "m").test(scopesProbe.stdout);
  });
  const authEnvironmentVariables = environmentAuthNames(environment);
  const keyringOverride = environment.CLOUDFLARE_AUTH_USE_KEYRING;
  const blockers = [];
  if (version === null || !satisfiesSimpleRange(version, WRANGLER_AUTH_CONTRACT_RANGE)) blockers.push("WRANGLER_AUTH_CONTRACT_UNSUPPORTED");
  if (namedProfileHelp.code !== 0 || !/named auth profile/i.test(namedProfileHelp.stdout)) blockers.push("WRANGLER_NAMED_PROFILE_UNSUPPORTED");
  if (keyringProbe.code !== 0 || keyringEnabled === null || persistedKeyringEnabled === null) blockers.push("WRANGLER_KEYRING_STATE_UNKNOWN");
  if (profilesProbe.code !== 0 || profileExists === null) blockers.push("WRANGLER_PROFILE_STATE_UNKNOWN");
  if (loginHelp.code !== 0 || !/--device\b/.test(loginHelp.stdout)) blockers.push("WRANGLER_DEVICE_FLOW_UNSUPPORTED");
  if (scopesProbe.code !== 0 || availableRequiredScopes.length !== CFKANBAN_OAUTH_SCOPES.length) blockers.push("WRANGLER_REQUIRED_OAUTH_SCOPE_UNAVAILABLE");
  if (authEnvironmentVariables.length > 0) blockers.push("WRANGLER_PROFILE_SHADOWED_BY_ENV");
  if (String(keyringOverride).toLowerCase() === "false") blockers.push("WRANGLER_KEYRING_DISABLED_BY_ENV");

  return {
    schema_version: 1,
    executable,
    version,
    platform,
    auth_contract_range: WRANGLER_AUTH_CONTRACT_RANGE,
    profile: { name: profile, exists: profileExists },
    keyring: {
      enabled: keyringEnabled,
      persisted_enabled: persistedKeyringEnabled,
      global_for_current_os_user: true,
    },
    capabilities: {
      named_profiles: !blockers.includes("WRANGLER_NAMED_PROFILE_UNSUPPORTED"),
      browser_callback: true,
      device_flow: !blockers.includes("WRANGLER_DEVICE_FLOW_UNSUPPORTED"),
      scoped_oauth: availableRequiredScopes.length === CFKANBAN_OAUTH_SCOPES.length,
    },
    required_scopes_available: availableRequiredScopes,
    environment_auth_variables: authEnvironmentVariables,
    blockers,
    safe_to_plan: blockers.length === 0,
    raw_output_returned: false,
  };
}

function parseWranglerProfileNames(value) {
  const output = stripAnsi(value);
  if (/No profiles found\./i.test(output)) return { complete: true, profiles: [] };
  const profiles = [];
  let recognizedTable = false;
  for (const line of output.split(/\r?\n/)) {
    if (/\bBound Directories\b/i.test(line)) {
      recognizedTable = true;
      continue;
    }
    const match = /^\s*│\s*([^│]+?)\s*│/u.exec(line);
    if (match === null) continue;
    const candidate = match[1].trim();
    if (!/^[A-Za-z0-9_-]+$/.test(candidate)) continue;
    profiles.push(validateProfileName(candidate));
  }
  return {
    complete: recognizedTable,
    profiles: [...new Set(profiles)],
  };
}

function isolatedTokenEnvironment(environment, token) {
  const isolated = { ...environment, WRANGLER_WRITE_LOGS: "false" };
  delete isolated.CLOUDFLARE_API_TOKEN;
  delete isolated.CLOUDFLARE_API_KEY;
  delete isolated.CLOUDFLARE_EMAIL;
  delete isolated.CLOUDFLARE_ACCOUNT_ID;
  isolated.CLOUDFLARE_API_TOKEN = token;
  return isolated;
}

function parseWranglerToken(value) {
  let parsed;
  try {
    parsed = JSON.parse(stripAnsi(value));
  } catch {
    return null;
  }
  if (!["oauth", "api_token"].includes(parsed?.type) || typeof parsed.token !== "string" || parsed.token.length === 0) {
    return null;
  }
  return parsed.token;
}

function safeAccountLabel(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized.length === 0 ? null : normalized.slice(0, 256);
}

function parseWranglerAccounts(value) {
  let parsed;
  try {
    parsed = JSON.parse(stripAnsi(value));
  } catch {
    return null;
  }
  if (parsed?.loggedIn !== true || !Array.isArray(parsed.accounts)) return null;
  const accounts = [];
  const seen = new Set();
  for (const account of parsed.accounts) {
    if (typeof account?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(account.id) || seen.has(account.id)) continue;
    seen.add(account.id);
    accounts.push({ account_id: account.id, account_label: safeAccountLabel(account.name) });
  }
  return accounts;
}

async function runAuthProbe(runner, executable, args, environment) {
  try {
    const result = await runner(executable, args, { env: { ...environment, WRANGLER_WRITE_LOGS: "false" } });
    return {
      code: result?.code,
      signal: result?.signal || null,
      stdout: stripAnsi(result?.stdout),
      stderr: stripAnsi(result?.stderr),
    };
  } catch {
    return { code: null, signal: null, stdout: "", stderr: "" };
  }
}

async function discoverAccountsForToken({ runner, executable, environment, token }) {
  const result = await runAuthProbe(
    runner,
    executable,
    ["whoami", "--json"],
    isolatedTokenEnvironment(environment, token),
  );
  if (result.code !== 0) return null;
  return parseWranglerAccounts(result.stdout);
}

async function discoverProfileAccounts({ runner, executable, environment, profile }) {
  const args = ["auth", "token", "--json", "--profile", profile];
  const tokenResult = await runAuthProbe(runner, executable, args, environment);
  if (tokenResult.code !== 0) return null;
  const token = parseWranglerToken(tokenResult.stdout);
  if (token === null) return null;
  return discoverAccountsForToken({ runner, executable, environment, token });
}

function authResolutionResult({ executable, version, environmentVariables, profileInventoryComplete, candidates, unverifiedProfiles }) {
  const sortedCandidates = [...candidates].sort((left, right) => {
    const leftProfile = left.profile || "";
    const rightProfile = right.profile || "";
    if (leftProfile !== rightProfile) return leftProfile < rightProfile ? -1 : 1;
    if (left.account_id === right.account_id) return 0;
    return left.account_id < right.account_id ? -1 : 1;
  });
  let status;
  let selected = null;
  if (unverifiedProfiles.length > 0 || profileInventoryComplete === false) {
    status = "blocked";
  } else if (sortedCandidates.length === 1) {
    status = "resolved";
    [selected] = sortedCandidates;
  } else if (sortedCandidates.length > 0) {
    status = "selection_required";
  } else {
    status = "unavailable";
  }
  return {
    schema_version: 1,
    status,
    executable,
    version,
    auth_contract_range: WRANGLER_AUTH_CONTRACT_RANGE,
    environment_auth_variables: environmentVariables,
    profile_inventory_complete: profileInventoryComplete,
    candidates: sortedCandidates,
    selected,
    unverified_profiles: unverifiedProfiles,
    account_readback_required: sortedCandidates.length > 0,
    candidate_values_are_untrusted_display_metadata: true,
    raw_token_returned: false,
    raw_output_returned: false,
    next_step: status === "resolved"
      ? "run runtime wrangler-account-readback for selected.profile and selected.account_id"
      : status === "selection_required"
        ? "ask the user to choose one candidate, then run runtime wrangler-account-readback"
        : status === "unavailable"
          ? "inspect the stable proposed profile and create a separate Cloudflare authentication plan"
          : "stop; the existing Cloudflare authentication inventory could not be resolved safely",
  };
}

export async function resolveCloudflareAuth({
  wranglerExecutable,
  runner = spawnCaptured,
  environment = process.env,
}) {
  const executable = safeAbsolute(wranglerExecutable, "wrangler_executable");
  const versionProbe = await runAuthProbe(runner, executable, ["--version"], environment);
  const version = versionProbe.code === 0 ? versionProbe.stdout.trim().split(/\r?\n/, 1)[0] : null;
  if (version === null || !satisfiesSimpleRange(version, WRANGLER_AUTH_CONTRACT_RANGE)) {
    throw toolError("WRANGLER_AUTH_CONTRACT_UNSUPPORTED", "Wrangler version is outside the verified authentication discovery range", {
      version,
      requiredRange: WRANGLER_AUTH_CONTRACT_RANGE,
    });
  }

  const environmentVariables = environmentAuthNames(environment);
  if (environmentVariables.length > 0) {
    const whoami = await runAuthProbe(runner, executable, ["whoami", "--json"], environment);
    const accounts = whoami.code === 0 ? parseWranglerAccounts(whoami.stdout) : null;
    const candidates = (accounts || []).map((account) => ({
      profile: null,
      ...account,
      auth_source: "environment",
    }));
    const unverifiedProfiles = accounts === null
      ? [{ profile: null, code: "WRANGLER_ENV_AUTH_ACCOUNT_DISCOVERY_FAILED" }]
      : [];
    return authResolutionResult({
      executable,
      version,
      environmentVariables,
      profileInventoryComplete: null,
      candidates,
      unverifiedProfiles,
    });
  }

  const listResult = await runAuthProbe(runner, executable, ["auth", "list"], environment);
  const inventory = listResult.code === 0
    ? parseWranglerProfileNames(`${listResult.stdout}\n${listResult.stderr}`)
    : { complete: false, profiles: [] };
  if (inventory.profiles.length > MAX_DISCOVERED_PROFILES) {
    return authResolutionResult({
      executable,
      version,
      environmentVariables,
      profileInventoryComplete: false,
      candidates: [],
      unverifiedProfiles: [{ profile: null, code: "WRANGLER_PROFILE_DISCOVERY_LIMIT_EXCEEDED" }],
    });
  }

  const candidates = [];
  const unverifiedProfiles = [];
  const profiles = ["default", ...inventory.profiles.filter((profile) => profile !== "default")];
  for (const profile of profiles) {
    const accounts = await discoverProfileAccounts({ runner, executable, environment, profile });
    if (accounts === null) {
      if (profile !== "default") unverifiedProfiles.push({ profile, code: "WRANGLER_PROFILE_ACCOUNT_DISCOVERY_FAILED" });
      continue;
    }
    if (profile !== "default" && accounts.length === 0) {
      unverifiedProfiles.push({ profile, code: "WRANGLER_PROFILE_ACCOUNT_DISCOVERY_FAILED" });
      continue;
    }
    if (candidates.length + accounts.length > MAX_DISCOVERED_ACCOUNT_MAPPINGS) {
      unverifiedProfiles.push({ profile, code: "WRANGLER_ACCOUNT_DISCOVERY_LIMIT_EXCEEDED" });
      break;
    }
    for (const account of accounts) {
      candidates.push({
        profile,
        ...account,
        auth_source: "wrangler_profile",
      });
    }
  }

  return authResolutionResult({
    executable,
    version,
    environmentVariables,
    profileInventoryComplete: inventory.complete,
    candidates,
    unverifiedProfiles,
  });
}

function buildOAuthArgs(mode, profileName) {
  const scopes = [...CFKANBAN_OAUTH_SCOPES];
  if (mode === "named_profile_browser") {
    return [
      "auth", "create", profileName,
      "--browser=true",
      "--callback-host", "localhost",
      "--callback-port", "8976",
      "--scopes", ...scopes,
    ];
  }
  if (mode === "default_profile_browser") {
    return [
      "login",
      "--browser=true",
      "--callback-host", "localhost",
      "--callback-port", "8976",
      "--scopes", ...scopes,
    ];
  }
  return ["login", "--device", "--browser=false", "--scopes", ...scopes];
}

export function createCloudflareAuthPlan({
  taskId,
  mode = "named_profile_browser",
  preflight,
  allowExistingProfile = false,
}) {
  if (!AUTH_MODES.includes(mode)) throw toolError("INVALID_WRANGLER_AUTH_MODE", "Unknown Wrangler authentication mode", { mode });
  if (preflight?.safe_to_plan !== true || preflight.blockers?.length !== 0) {
    throw toolError("WRANGLER_AUTH_PREFLIGHT_BLOCKED", "Wrangler authentication preflight is not safe to plan", { blockers: preflight?.blockers || ["INVALID_PREFLIGHT"] });
  }
  const executable = safeAbsolute(preflight.executable, "wrangler_executable");
  const version = requireString(preflight.version, "wrangler_version", { max: 128 });
  if (!satisfiesSimpleRange(version, WRANGLER_AUTH_CONTRACT_RANGE)) {
    throw toolError("WRANGLER_AUTH_CONTRACT_UNSUPPORTED", "Wrangler version is outside the verified authentication command range", { version, requiredRange: WRANGLER_AUTH_CONTRACT_RANGE });
  }
  const expectedScopes = [...CFKANBAN_OAUTH_SCOPES];
  if (JSON.stringify(preflight.required_scopes_available) !== JSON.stringify(expectedScopes)) {
    throw toolError("WRANGLER_REQUIRED_OAUTH_SCOPE_UNAVAILABLE", "Wrangler does not expose every OAuth scope required by this cfKanban release");
  }
  if (typeof preflight.keyring?.persisted_enabled !== "boolean" || typeof preflight.profile?.exists !== "boolean") {
    throw toolError("WRANGLER_AUTH_STATE_UNKNOWN", "Wrangler keyring and profile state must be known before planning");
  }
  const namedProfile = mode === "named_profile_browser";
  const profileName = validateProfileName(preflight.profile.name, { allowDefault: !namedProfile });
  if (namedProfile && !preflight.capabilities?.named_profiles) {
    throw toolError("WRANGLER_NAMED_PROFILE_UNSUPPORTED", "This Wrangler does not support named authentication profiles");
  }
  if (!namedProfile && profileName !== "default") {
    throw toolError("WRANGLER_DEFAULT_PROFILE_REQUIRED", "Default-profile authentication modes require a preflight for the default profile");
  }
  if (mode === "default_profile_device" && !preflight.capabilities?.device_flow) {
    throw toolError("WRANGLER_DEVICE_FLOW_UNSUPPORTED", "This Wrangler does not support device authorization");
  }
  if (preflight.profile.exists && allowExistingProfile !== true) {
    throw toolError("WRANGLER_AUTH_PROFILE_EXISTS", "The selected Wrangler profile already exists; re-authentication must be explicitly planned", { profile: profileName });
  }

  const actions = [];
  if (!preflight.keyring.persisted_enabled) {
    actions.push({
      id: "enable_keyring",
      args: ["auth", "keyring", "enable"],
      effect: "change the global Wrangler OAuth storage preference for every profile owned by the current OS user",
    });
  }
  actions.push({
    id: "oauth_login",
    args: buildOAuthArgs(mode, profileName),
    effect: namedProfile
      ? `${preflight.profile.exists ? "re-authenticate" : "create"} the named Wrangler OAuth profile and complete Cloudflare consent in a browser`
      : `${preflight.profile.exists ? "re-authenticate" : "create"} the default Wrangler OAuth profile and complete Cloudflare consent`,
  });

  const plan = {
    schema_version: 1,
    kind: "cloudflare_oauth_login",
    task_id: requireString(taskId, "task_id"),
    platform: preflight.platform,
    wrangler: {
      executable,
      version,
      auth_contract_range: WRANGLER_AUTH_CONTRACT_RANGE,
    },
    profile: {
      name: profileName,
      operation: preflight.profile.exists ? "reauthenticate" : "create",
      experimental: namedProfile,
      directory_binding_created: false,
    },
    keyring: {
      persisted_previously_enabled: preflight.keyring.persisted_enabled,
      requested_enabled: true,
      global_for_current_os_user: true,
      affects_all_wrangler_profiles: true,
      existing_plaintext_profiles_may_migrate_when_next_accessed: true,
      windows_backend_may_require_one_time_download: preflight.platform === "win32" && !preflight.keyring.persisted_enabled,
    },
    oauth: {
      mode,
      requested_scopes: expectedScopes,
      automatically_added_scopes: ["offline_access"],
      browser_confirmation_required: true,
      callback: mode === "default_profile_device" ? null : { host: "localhost", port: 8976 },
      scopes_are_separate_process_arguments: true,
    },
    actions,
    cloudflare_resource_writes: false,
    worker_writes: false,
    d1_writes: false,
    writes_user_repositories: false,
    stores_cloudflare_auth_outside_cfkanban_root: true,
    wrangler_disk_logs_disabled_for_auth_actions: true,
    raw_oauth_token_returned: false,
    readback: "verify the exact account and profile with runtime wrangler-account-readback before creating a deployment plan",
    rollback: {
      delete_profile_args: namedProfile ? ["auth", "delete", profileName] : ["logout"],
      delete_profile_requires_separate_authorization: true,
      disable_keyring_automatically: false,
      keyring_reason: "keyring is a global Wrangler preference and disabling it can remove encrypted credentials for other profiles",
    },
  };
  return { plan, plan_digest: canonicalDigest(plan) };
}

function validateAuthAction(plan, action) {
  if (!["enable_keyring", "oauth_login"].includes(action.id)) {
    throw toolError("WRANGLER_AUTH_ACTION_REJECTED", "Wrangler authentication action is not allowlisted", { actionId: action.id });
  }
  const expectedArgs = action.id === "enable_keyring"
    ? ["auth", "keyring", "enable"]
    : buildOAuthArgs(plan.oauth?.mode, plan.profile?.name);
  if (JSON.stringify(action.args) !== JSON.stringify(expectedArgs)) {
    throw toolError("WRANGLER_AUTH_PLAN_INVALID", "Wrangler authentication arguments do not match the fixed action contract", { actionId: action.id });
  }
}

function validateAuthPlanActions(plan) {
  const namedProfile = plan.oauth.mode === "named_profile_browser";
  const profileName = validateProfileName(plan.profile?.name, { allowDefault: !namedProfile });
  if (!namedProfile && profileName !== "default") {
    throw toolError("WRANGLER_AUTH_PLAN_INVALID", "Default-profile authentication modes require the default Wrangler profile");
  }
  if (typeof plan.keyring?.persisted_previously_enabled !== "boolean") {
    throw toolError("WRANGLER_AUTH_PLAN_INVALID", "Cloudflare authentication plan does not contain a known prior keyring preference");
  }
  const expectedActionIds = plan.keyring.persisted_previously_enabled
    ? ["oauth_login"]
    : ["enable_keyring", "oauth_login"];
  const actionIds = Array.isArray(plan.actions) ? plan.actions.map((action) => action?.id) : [];
  if (JSON.stringify(actionIds) !== JSON.stringify(expectedActionIds)) {
    throw toolError("WRANGLER_AUTH_PLAN_INVALID", "Cloudflare authentication actions do not match the fixed keyring and OAuth sequence");
  }
  for (const action of plan.actions) validateAuthAction(plan, action);
}

export async function executeCloudflareAuthAction({
  plan,
  actionId,
  completedActionIds = [],
  authorizedTaskId,
  authorizedPlanDigest,
  runner = spawnInteractive,
}) {
  const digest = canonicalDigest(plan);
  if (plan?.kind !== "cloudflare_oauth_login" || authorizedTaskId !== plan.task_id || authorizedPlanDigest !== digest) {
    throw toolError("PLAN_NOT_AUTHORIZED", "Cloudflare authentication authorization does not match the frozen task and plan digest");
  }
  if (!AUTH_MODES.includes(plan.oauth?.mode) || JSON.stringify(plan.oauth?.requested_scopes) !== JSON.stringify(CFKANBAN_OAUTH_SCOPES)) {
    throw toolError("WRANGLER_AUTH_PLAN_INVALID", "Cloudflare authentication plan has drifted from the verified scope or mode contract");
  }
  validateAuthPlanActions(plan);
  const actionIndex = plan.actions.findIndex((candidate) => candidate.id === actionId);
  if (actionIndex === -1) throw toolError("WRANGLER_AUTH_ACTION_REJECTED", "Requested authentication action is not present in the frozen plan", { actionId });
  const requiredCompletedActionIds = plan.actions.slice(0, actionIndex).map((candidate) => candidate.id);
  if (JSON.stringify(completedActionIds) !== JSON.stringify(requiredCompletedActionIds)) {
    throw toolError("WRANGLER_AUTH_ACTION_OUT_OF_ORDER", "Earlier Cloudflare authentication actions must complete in their frozen order", {
      actionId,
      requiredCompletedActionIds,
    });
  }
  const action = plan.actions[actionIndex];
  const executable = safeAbsolute(plan.wrangler?.executable, "wrangler_executable");
  const result = await runner(executable, [...action.args], {
    env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.code !== 0) {
    throw toolError("WRANGLER_AUTH_ACTION_FAILED", "Wrangler authentication action failed; inspect current auth state before retrying", { actionId, exitCode: result.code, signal: result.signal || null });
  }
  return {
    action_completed: true,
    action_id: actionId,
    readback_required: true,
    raw_output_returned: false,
  };
}

export function createToolRuntimePlan({ taskId, npmExecutable, wranglerVersion, sourceRegistry = "npm", runtimeRoot = resolveToolRuntimeRoot() }) {
  if (!path.isAbsolute(npmExecutable)) throw toolError("ABSOLUTE_PATH_REQUIRED", "npm executable must be an absolute path");
  const version = requireString(wranglerVersion, "wrangler_version", { max: 64 });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw toolError("INVALID_WRANGLER_VERSION", "Tool Runtime requires an exact Wrangler semantic version");
  const plan = {
    schema_version: 1,
    kind: "tool_runtime_install",
    task_id: requireString(taskId, "task_id"),
    runtime_root: runtimeRoot,
    npm_executable: npmExecutable,
    package: "wrangler",
    version,
    source_registry: sourceRegistry,
    changes_path: false,
    changes_shell_profile: false,
    changes_global_node_or_wrangler: false,
    writes_user_repositories: false,
    rollback: "switch active runtime pointer to previous version or remove this isolated version",
  };
  return { plan, plan_digest: canonicalDigest(plan) };
}

export async function installToolRuntime({ plan, authorizedTaskId, authorizedPlanDigest, runner = null }) {
  const digest = canonicalDigest(plan);
  if (plan.kind !== "tool_runtime_install" || authorizedTaskId !== plan.task_id || authorizedPlanDigest !== digest) {
    throw toolError("PLAN_NOT_AUTHORIZED", "Tool Runtime install authorization does not match the frozen task and plan digest");
  }
  await ensurePrivateDirectory(plan.runtime_root);
  const versionRoot = path.join(plan.runtime_root, "versions", plan.version);
  if (await pathType(versionRoot) !== "missing") throw toolError("TOOL_RUNTIME_VERSION_EXISTS", "Tool Runtime version already exists and will not be overwritten", { versionRoot });
  await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(versionRoot);
  const packageJson = { private: true, name: "cfkanban-tool-runtime", version: "0.0.0", dependencies: { wrangler: plan.version } };
  await atomicWriteJson(path.join(versionRoot, "package.json"), packageJson);
  const execute = runner || ((executable, args) => new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: versionRoot, shell: false, windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  }));
  const result = await execute(plan.npm_executable, ["install", "--no-audit", "--no-fund", "--save-exact"]);
  if (result.code !== 0) throw toolError("TOOL_RUNTIME_INSTALL_FAILED", "npm failed while installing the isolated cfKanban Tool Runtime", { exitCode: result.code });
  const executable = path.join(versionRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  const version = await versionOf(executable);
  if (version === null || !parseVersion(version) || !version.includes(plan.version.split("-")[0])) throw toolError("TOOL_RUNTIME_VERIFY_FAILED", "Installed Wrangler could not be verified", { executable, version });
  const previous = await readFile(path.join(plan.runtime_root, "active.json"), "utf8").then(JSON.parse).catch(() => null);
  const previousSummary = previous === null ? null : { version: previous.version, executable: previous.executable };
  await atomicWriteJson(path.join(plan.runtime_root, "active.json"), { schema_version: 1, version: plan.version, executable, previous: previousSummary, switched_at: new Date().toISOString() });
  return { installed: true, version, executable, previous: previous?.version || null, path_modified: false };
}
