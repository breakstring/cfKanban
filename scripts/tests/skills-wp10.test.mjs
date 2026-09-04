import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCapabilityReport } from "../../packages/skill-runtime/src/capabilities.mjs";
import { prepareOwnerCredential, writeOwnerBootstrapSql } from "../../packages/skill-runtime/src/bootstrap-sql.mjs";
import { finalizeOwnerDeployment } from "../../packages/skill-runtime/src/deployment-finalize.mjs";
import { finalizeInstanceUpgrade } from "../../packages/skill-runtime/src/instance-upgrade.mjs";
import { dispatch, getCommandCatalog } from "../../packages/skill-runtime/src/cli.mjs";
import { redeemInvitation, redeemPublicJoin, rotateOwnerCredential } from "../../packages/skill-runtime/src/credential-operations.mjs";
import { buildOwnerBootstrapReadbackSql, buildWranglerAccountProbe, buildWranglerInvocation, executeWranglerAction, parseMigrationReadbackOutput, parseOwnerBootstrapReadbackOutput, readD1ResourceByName, readD1RestorePoint, readWorkerResourceByName, readWorkerVersionById, readWranglerAccountAccess } from "../../packages/skill-runtime/src/deploy.mjs";
import { writeFrozenWranglerConfig } from "../../packages/skill-runtime/src/deployment-config.mjs";
import { appendJournalEvent, authorizeJournal, createJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { assessMigrationLedgerRecovery, reconcileMigrationState, writeMigrationLedgerRecordSql } from "../../packages/skill-runtime/src/migrations.mjs";
import { comparePlans, createInstanceUpgradePlan, createSkillUpdatePlan, createStrictZeroPlan } from "../../packages/skill-runtime/src/plan.mjs";
import { checkTrustedOriginRebind } from "../../packages/skill-runtime/src/rebind.mjs";
import { verifyPublisherContinuity } from "../../packages/skill-runtime/src/release.mjs";
import { generateReleaseMetadata } from "../generate-release-metadata.mjs";
import { resolveScope, validateScopeDocument } from "../../packages/skill-runtime/src/scope.mjs";
import { installVerifiedSkillBundle } from "../../packages/skill-runtime/src/skill-update.mjs";
import { installVerifiedServiceBundle } from "../../packages/skill-runtime/src/service-bundle.mjs";
import {
  createPendingCredential,
  getInstancePaths,
  initializeStateRoot,
  inspectInstanceState,
  loadCurrentCredentialSecret,
  loadPendingCredentialSecret,
  promotePendingCredential,
  putInstanceMetadata,
} from "../../packages/skill-runtime/src/state.mjs";
import { normalizeNetworkFailure, normalizeResponse } from "../../packages/skill-runtime/src/transport.mjs";
import {
  createCloudflareAuthPlan,
  createToolRuntimePlan,
  executeCloudflareAuthAction,
  inspectCloudflareAuth,
  resolveCloudflareAuth,
  resolveWrangler,
  satisfiesSimpleRange,
} from "../../packages/skill-runtime/src/tool-runtime.mjs";
import { canonicalDigest, readJson, sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";
import { writeDeterministicZip } from "../lib/deterministic-zip.mjs";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const SERVER_CREDENTIAL_ID = "77777777-7777-4777-8777-777777777777";
const TESTING_RELEASE_CONFIG = JSON.parse(await readFile(new URL("../../release/config/0.1.0-alpha.21.json", import.meta.url), "utf8"));

function upgradeBindingReadback(databaseId = "88888888-8888-4888-8888-888888888888") {
  return [
    { type: "assets", name: "ASSETS", value_redacted: true },
    { type: "d1", name: "DB", database_id: databaseId },
    { type: "plain_text", name: "RATE_LIMIT_INSTANCE_LIMIT", text: "300" },
    { type: "plain_text", name: "RATE_LIMIT_INSTANCE_PERIOD_SECONDS", text: "60" },
    { type: "plain_text", name: "RATE_LIMIT_PRINCIPAL_LIMIT", text: "120" },
    { type: "plain_text", name: "RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS", text: "60" },
    { type: "plain_text", name: "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT", text: "30" },
    { type: "plain_text", name: "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS", text: "60" },
    { type: "ratelimit", name: "INSTANCE_RATE_LIMITER", namespace_id: "1002" },
    { type: "ratelimit", name: "PRINCIPAL_RATE_LIMITER", namespace_id: "1001" },
    { type: "ratelimit", name: "UNAUTHENTICATED_RATE_LIMITER", namespace_id: "1003" },
  ];
}

async function fixtureState() {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban-wp10-home-"));
  const stateRoot = path.join(home, ".cfkanban");
  await initializeStateRoot({ stateRoot, home, persistenceConfirmed: true });
  await putInstanceMetadata({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    trustedApiOrigin: "https://old.example.test",
    originVersion: 1,
    serviceVersion: "0.1.0",
    schemaVersion: 1,
  });
  return { home, stateRoot };
}

function upgradePlanInput(overrides = {}) {
  const base = {
    taskId: "wp10-upgrade",
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    cloudflare: {
      account_id: "account-one",
      account_label: "Example Account",
      profile: "production",
      auth_context_directory: null,
      api_origin: "https://example.workers.dev",
    },
    resources: {
      worker: {
        name: "cfkanban-worker",
        deployment_id: "66666666-6666-4666-8666-666666666666",
        version_id: "77777777-7777-4777-8777-777777777777",
        bindings: upgradeBindingReadback(),
      },
      d1: {
        name: "cfkanban-d1",
        database_id: "88888888-8888-4888-8888-888888888888",
      },
      workers_dev: true,
      custom_domain: null,
      routes: [],
      pages: false,
    },
    bindings: {
      d1: "DB",
      assets: "ASSETS",
      rate_limits: {
        principal: { limit: 120, period_seconds: 60 },
        instance: { limit: 300, period_seconds: 60 },
        unauthenticated_sensitive: { limit: 30, period_seconds: 60 },
      },
    },
    owner: {
      display_name: "Example Owner",
      principal_id: PRINCIPAL_ID,
      credential_id: CREDENTIAL_ID,
      credential_fingerprint: "cfk_v1_example_…",
    },
    current: {
      publisher: "https://github.com",
      manifest_version: "0.1.0-alpha.8",
      manifest_sha256: "a".repeat(64),
      service_bundle_version: "0.1.0-alpha.8",
      service_bundle_sha256: "b".repeat(64),
      service_bundle_source: "https://github.com/example/cfkanban-service-alpha.8.zip",
      service_api_version: "0.1.0",
      schema_version: 1,
    },
    target: {
      publisher: "https://github.com",
      manifest_version: "0.1.0-alpha.19",
      manifest_sha256: "c".repeat(64),
      service_bundle_version: "0.1.0-alpha.19",
      service_bundle_sha256: "d".repeat(64),
      service_bundle_source: "https://github.com/example/cfkanban-service-alpha.19.zip",
      service_api_version: "0.1.0",
      schema_version: 1,
      migration_manifest_sha256: "e".repeat(64),
      compatibility: {
        node: ">=22.12.0 <27",
        wrangler: ">=4.127.1 <5",
        service_api: ">=0.1.0 <0.2.0",
        schema_version: 1,
      },
    },
    migrations: [],
    restorePoint: {
      required: false,
      verified: false,
      bookmark: null,
      observed_at: null,
      reason: "no_migration_delta",
      restore_overwrites_later_writes: true,
      restore_automatic: false,
    },
  };
  return { ...base, ...overrides };
}

test("capability fixtures keep macOS, Windows native, WSL2, and Linux isolated without mutation", () => {
  const cases = [
    [{ platform: "darwin", release: "25.0.0", home: "/Users/example", env: {}, probes: false }, "macos", "/Users/example/.cfkanban"],
    [{ platform: "win32", release: "10.0.26100", home: "C:\\Users\\Example", env: { LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" }, probes: false }, "windows-native", "C:\\Users\\Example\\.cfkanban"],
    [{ platform: "linux", release: "6.6.87.2-microsoft-standard-WSL2", home: "/home/example", env: { WSL_DISTRO_NAME: "Ubuntu" }, probes: false }, "wsl2", "/home/example/.cfkanban"],
    [{ platform: "linux", release: "6.12.0", home: "/home/example", env: {}, probes: false }, "linux", "/home/example/.cfkanban"],
  ];
  for (const [input, expected, root] of cases) {
    const report = buildCapabilityReport(input);
    assert.equal(report.execution_environment, expected);
    assert.equal(report.paths.state_root, root);
    assert.equal(report.paths.tool_runtime_root, input.platform === "win32" ? `${root}\\tool-runtime` : `${root}/tool-runtime`);
    assert.equal(report.paths.skill_release_root, input.platform === "win32" ? `${root}\\skill-releases` : `${root}/skill-releases`);
    assert.equal(report.paths.service_release_root, input.platform === "win32" ? `${root}\\service-releases` : `${root}/service-releases`);
    assert.equal(report.boundaries.windows_wsl_mixed_toolchain, false);
    assert.equal(report.boundaries.mutates_path, false);
    assert.equal(report.boundaries.installs_dependencies, false);
  }
  assert.equal(satisfiesSimpleRange("wrangler 4.127.1", ">=4.127.1 <5.0.0"), true);
  assert.equal(satisfiesSimpleRange("4.126.9", ">=4.127.1 <5.0.0"), false);
  const runtimePlan = createToolRuntimePlan({ taskId: "wp10", npmExecutable: "/opt/node/bin/npm", wranglerVersion: "4.127.1", runtimeRoot: "/private/cfkanban/tool-runtime" });
  assert.equal(runtimePlan.plan.changes_path, false);
  assert.equal(runtimePlan.plan.writes_user_repositories, false);
});

test("testing release accepts verified Node.js 26 while retaining a future-major boundary", () => {
  assert.equal(TESTING_RELEASE_CONFIG.nodeRange, ">=22.12.0 <27");
  assert.equal(satisfiesSimpleRange("v22.12.0", TESTING_RELEASE_CONFIG.nodeRange), true);
  assert.equal(satisfiesSimpleRange("v24.19.0", TESTING_RELEASE_CONFIG.nodeRange), true);
  assert.equal(satisfiesSimpleRange("v26.8.1", TESTING_RELEASE_CONFIG.nodeRange), true);
  assert.equal(satisfiesSimpleRange("v22.11.0", TESTING_RELEASE_CONFIG.nodeRange), false);
  assert.equal(satisfiesSimpleRange("v27.0.0", TESTING_RELEASE_CONFIG.nodeRange), false);
});

test("PATH capability output cannot hide a reusable cfKanban Tool Runtime", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban-wp10-runtime-resolution-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtimeRoot = path.join(home, ".cfkanban", "tool-runtime");
  const executable = path.join(runtimeRoot, "versions", "4.127.1", "node_modules", ".bin", "wrangler");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nprintf '4.127.1\\n'\n", { mode: 0o700 });
  await writeFile(path.join(runtimeRoot, "active.json"), `${JSON.stringify({ schema_version: 1, version: "4.127.1" })}\n`, "utf8");

  const report = buildCapabilityReport({ home, env: { PATH: "" }, probes: false });
  assert.equal(report.tools.wrangler.status, "unknown");
  assert.equal(report.tools.wrangler.discovery_scope, "path_only");
  assert.equal(report.tools.wrangler.release_compatibility, "not_determined");
  assert.deepEqual(report.installed_tool_runtime, {
    status: "recorded_unverified",
    version: "4.127.1",
    resolver_required: true,
  });
  assert.equal(report.required_next_checks[0].command, "runtime resolve-wrangler");
  assert.deepEqual(report.required_next_checks[0].searches, ["explicit_path", "path", "cfkanban_tool_runtime"]);

  const resolved = await resolveWrangler({
    requiredRange: ">=4.127.1 <5",
    runtimeRoot,
    env: { PATH: "" },
    platform: "darwin",
  });
  assert.equal(resolved.status, "compatible");
  assert.equal(resolved.source, "cfkanban_tool_runtime");
  assert.equal(resolved.path, executable);
  assert.equal(resolved.version, "4.127.1");
});

test("Cloudflare OAuth planning freezes named-profile syntax, least scopes, and global keyring effects", async () => {
  const calls = [];
  const outputs = new Map([
    ["--version", { code: 0, stdout: "4.127.1\n", stderr: "" }],
    ["auth create --help", { code: 0, stdout: "Create or re-authenticate a named auth profile\n--scopes\n", stderr: "" }],
    ["auth keyring", { code: 0, stdout: "Keyring storage is disabled.\nCredentials are currently stored in: /private/default.toml\n", stderr: "" }],
    ["auth list", { code: 0, stdout: "No profiles found. Run `wrangler login` to get started.\n", stderr: "" }],
    ["login --help", { code: 0, stdout: "--device\n--scopes\n", stderr: "" }],
    ["login --scopes-list", {
      code: 0,
      stdout: ["account:read", "user:read", "workers:write", "workers_scripts:write", "d1:write"].join("\n"),
      stderr: "",
    }],
  ]);
  const preflight = await inspectCloudflareAuth({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    profileName: "cfkanban-test",
    platform: "darwin",
    environment: {},
    runner: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { signal: null, ...outputs.get(args.join(" ")) };
    },
  });
  assert.equal(preflight.safe_to_plan, true);
  assert.equal(preflight.keyring.enabled, false);
  assert.equal(preflight.profile.exists, false);
  assert.equal(preflight.capabilities.named_profiles, true);
  assert.equal(preflight.capabilities.device_flow, true);
  assert.equal(preflight.raw_output_returned, false);
  assert.equal(JSON.stringify(preflight).includes("/private/default.toml"), false);

  const frozen = createCloudflareAuthPlan({
    taskId: "task-auth",
    mode: "named_profile_browser",
    preflight,
  });
  assert.equal(frozen.plan.kind, "cloudflare_oauth_login");
  assert.equal(frozen.plan.cloudflare_resource_writes, false);
  assert.equal(frozen.plan.keyring.global_for_current_os_user, true);
  assert.equal(frozen.plan.keyring.affects_all_wrangler_profiles, true);
  assert.deepEqual(frozen.plan.oauth.requested_scopes, [
    "account:read",
    "user:read",
    "workers_scripts:write",
    "d1:write",
  ]);
  assert.equal(frozen.plan.oauth.requested_scopes.includes("workers:write"), false);
  assert.equal(frozen.plan.oauth.requested_scopes.includes("workers_kv:write"), false);
  assert.equal(frozen.plan.oauth.requested_scopes.includes("workers_routes:write"), false);
  assert.deepEqual(frozen.plan.actions[0].args, ["auth", "keyring", "enable"]);
  assert.deepEqual(frozen.plan.actions[1].args, [
    "auth", "create", "cfkanban-test",
    "--browser=true",
    "--callback-host", "localhost",
    "--callback-port", "8976",
    "--scopes",
    "account:read",
    "user:read",
    "workers_scripts:write",
    "d1:write",
  ]);
  assert.equal(frozen.plan.actions[1].args.includes("account:read user:read workers_scripts:write d1:write"), false);
  assert.equal(frozen.plan.profile.experimental, true);
  assert.deepEqual(frozen.plan.rollback.delete_profile_args, ["auth", "delete", "cfkanban-test"]);
  assert.equal(frozen.plan.rollback.disable_keyring_automatically, false);

  const defaultPreflight = structuredClone(preflight);
  defaultPreflight.profile = { name: "default", exists: false };
  defaultPreflight.keyring = { ...defaultPreflight.keyring, enabled: true, persisted_enabled: true };
  const device = createCloudflareAuthPlan({
    taskId: "task-device-auth",
    mode: "default_profile_device",
    preflight: defaultPreflight,
  });
  assert.deepEqual(device.plan.actions.map(({ id }) => id), ["oauth_login"]);
  assert.deepEqual(device.plan.actions[0].args, [
    "login", "--device", "--browser=false", "--scopes",
    "account:read", "user:read", "workers_scripts:write", "d1:write",
  ]);
  assert.equal(device.plan.oauth.callback, null);
  assert.equal(device.plan.profile.experimental, false);

  const existingProfile = structuredClone(preflight);
  existingProfile.profile.exists = true;
  assert.throws(
    () => createCloudflareAuthPlan({ taskId: "task-existing-auth", preflight: existingProfile }),
    (error) => error.code === "WRANGLER_AUTH_PROFILE_EXISTS",
  );

  await assert.rejects(
    executeCloudflareAuthAction({
      plan: frozen.plan,
      actionId: "oauth_login",
      completedActionIds: [],
      authorizedTaskId: "task-auth",
      authorizedPlanDigest: frozen.plan_digest,
      runner: async () => ({ code: 0, signal: null }),
    }),
    (error) => error.code === "WRANGLER_AUTH_ACTION_OUT_OF_ORDER",
  );

  const executed = [];
  const completedActionIds = [];
  for (const action of frozen.plan.actions) {
    const result = await executeCloudflareAuthAction({
      plan: frozen.plan,
      actionId: action.id,
      completedActionIds,
      authorizedTaskId: "task-auth",
      authorizedPlanDigest: frozen.plan_digest,
      runner: async (executable, args, options) => {
        executed.push({ executable, args, options });
        return { code: 0, signal: null };
      },
    });
    assert.equal(result.action_completed, true);
    assert.equal(result.raw_output_returned, false);
    completedActionIds.push(action.id);
  }
  assert.deepEqual(executed.map(({ args }) => args), frozen.plan.actions.map(({ args }) => args));
  assert.equal(executed.every(({ options }) => options.shell === false), true);
  assert.equal(executed.every(({ options }) => options.env.WRANGLER_WRITE_LOGS === "false"), true);
  assert.equal(calls.length, 6);
  assert.equal(calls.every(({ options }) => options.env.WRANGLER_WRITE_LOGS === "false"), true);

  await assert.rejects(
    executeCloudflareAuthAction({
      plan: frozen.plan,
      actionId: "oauth_login",
      authorizedTaskId: "different-task",
      authorizedPlanDigest: frozen.plan_digest,
      runner: async () => ({ code: 0, signal: null }),
    }),
    (error) => error.code === "PLAN_NOT_AUTHORIZED",
  );
});

test("Cloudflare auth resolution prefers the effective private deployment context", async () => {
  const contextDirectory = "/private/cfkanban/deploy-context";
  const calls = [];
  const result = await resolveCloudflareAuth({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    contextDirectory,
    environment: {},
    runner: async (executable, args, options) => {
      calls.push({ executable, args, options });
      const command = args.join(" ");
      if (command === "--version") return { code: 0, signal: null, stdout: "4.127.1\n", stderr: "" };
      if (command === `whoami --json --cwd ${contextDirectory}`) {
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            loggedIn: true,
            authType: "OAuth Token",
            email: "private@example.test",
            accounts: [{ id: "a".repeat(32), name: "Example Account" }],
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.schema_version, 3);
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.resolution_order, ["environment_auth", "explicit_profile", "directory_bound_profile", "default_profile", "new_login"]);
  assert.equal(result.context_directory, contextDirectory);
  assert.deepEqual(result.selected, {
    profile: null,
    account_id: "a".repeat(32),
    account_label: "Example Account",
    auth_source: "effective_context",
  });
  assert.deepEqual(result.candidates, [result.selected]);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.account_readback_required, true);
  assert.equal(result.raw_token_returned, false);
  assert.equal(result.raw_output_returned, false);
  assert.equal(result.candidate_values_are_untrusted_display_metadata, true);
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.equal(calls.some(({ args }) => args[0] === "auth"), false);
  assert.equal(calls.every(({ options }) => options.env.WRANGLER_WRITE_LOGS === "false"), true);
});

test("Cloudflare auth resolution honors an environment account ID without changing the effective profile", async () => {
  const contextDirectory = "/private/cfkanban/deploy-context";
  const selectedAccountId = "b".repeat(32);
  const result = await resolveCloudflareAuth({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    contextDirectory,
    environment: { CLOUDFLARE_ACCOUNT_ID: selectedAccountId },
    runner: async (_executable, args) => {
      const command = args.join(" ");
      if (command === "--version") return { code: 0, signal: null, stdout: "4.127.1\n", stderr: "" };
      if (command === `whoami --json --cwd ${contextDirectory}`) {
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            loggedIn: true,
            accounts: [
              { id: "a".repeat(32), name: "Account A" },
              { id: selectedAccountId, name: "Account B" },
            ],
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.selected.account_id, selectedAccountId);
  assert.equal(result.selected.auth_source, "effective_context");
});

test("Cloudflare auth resolution does not enumerate profiles when the current context is unavailable", async () => {
  const contextDirectory = "/private/cfkanban/deploy-context";
  const calls = [];
  const result = await resolveCloudflareAuth({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    contextDirectory,
    environment: {},
    runner: async (executable, args, options) => {
      calls.push({ executable, args, options });
      const command = args.join(" ");
      if (command === "--version") return { code: 0, signal: null, stdout: "4.127.1\n", stderr: "" };
      if (command === `whoami --json --cwd ${contextDirectory}`) {
        return { code: 1, signal: null, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.account_readback_required, false);
  assert.equal(result.raw_token_returned, false);
  assert.equal(result.raw_output_returned, false);
  assert.equal(calls.every(({ options }) => options.env.WRANGLER_WRITE_LOGS === "false"), true);
  assert.equal(calls.some(({ args }) => args[0] === "auth"), false);
});

test("Cloudflare auth resolution gives an explicitly selected profile precedence over directory context", async () => {
  const token = "team-b-token";
  const contextDirectory = "/private/cfkanban/deploy-context";
  const calls = [];
  const result = await resolveCloudflareAuth({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    contextDirectory,
    selectedProfile: "team-b",
    environment: {},
    runner: async (_executable, args, options) => {
      calls.push({ args, options });
      const command = args.join(" ");
      if (command === "--version") return { code: 0, signal: null, stdout: "4.127.1\n", stderr: "" };
      if (command === "auth token --json --profile team-b") {
        return { code: 0, signal: null, stdout: JSON.stringify({ type: "oauth", token }), stderr: "" };
      }
      if (command === `whoami --json --cwd ${contextDirectory}` && options.env.CLOUDFLARE_API_TOKEN === token) {
        return { code: 0, signal: null, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "b".repeat(32), name: "Team B" }] }), stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.selected.profile, "team-b");
  assert.equal(result.selected.account_id, "b".repeat(32));
  assert.equal(result.selected.auth_source, "explicit_profile");
  assert.equal(calls.some(({ args }) => args.join(" ") === `auth list --cwd ${contextDirectory}`), false);
  assert.equal(calls.some(({ args, options }) => args.join(" ") === `whoami --json --cwd ${contextDirectory}` && options.env.CLOUDFLARE_API_TOKEN === undefined), false);
  assert.deepEqual(calls.filter(({ args }) => args.slice(0, 2).join(" ") === "auth token").map(({ args }) => args.at(-1)), ["team-b"]);
});

test("Cloudflare auth resolution asks only for an account after one selected profile exposes several accounts", async () => {
  const contextDirectory = "/private/cfkanban/deploy-context";
  const result = await resolveCloudflareAuth({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    contextDirectory,
    selectedProfile: "team-a",
    environment: {},
    runner: async (_executable, args, options) => {
      const command = args.join(" ");
      if (command === "--version") return { code: 0, signal: null, stdout: "4.127.1\n", stderr: "" };
      if (command === "auth token --json --profile team-a") return { code: 0, signal: null, stdout: JSON.stringify({ type: "oauth", token: "team-a-token" }), stderr: "" };
      if (command === `whoami --json --cwd ${contextDirectory}` && options.env.CLOUDFLARE_API_TOKEN === "team-a-token") {
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            loggedIn: true,
            accounts: [
              { id: "a".repeat(32), name: "Team A Primary" },
              { id: "c".repeat(32), name: "Team A Secondary" },
            ],
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.status, "account_selection_required");
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates.map(({ account_id }) => account_id), ["a".repeat(32), "c".repeat(32)]);
  assert.equal(result.account_readback_required, true);
});

test("Cloudflare auth resolution honors effective environment authentication without inspecting shadowed profiles", async () => {
  const token = "environment-token-fixture";
  const contextDirectory = "/private/cfkanban/deploy-context";
  const calls = [];
  const result = await resolveCloudflareAuth({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    contextDirectory,
    selectedProfile: "shadowed-profile",
    environment: { CLOUDFLARE_API_TOKEN: token },
    runner: async (_executable, args, options) => {
      calls.push({ args, options });
      const command = args.join(" ");
      if (command === "--version") return { code: 0, signal: null, stdout: "4.127.1\n", stderr: "" };
      if (command === `whoami --json --cwd ${contextDirectory}` && options.env.CLOUDFLARE_API_TOKEN === token) {
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({ loggedIn: true, email: "private@example.test", accounts: [{ id: "d".repeat(32), name: "Environment Account" }] }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.status, "resolved");
  assert.deepEqual(result.environment_auth_variables, ["CLOUDFLARE_API_TOKEN"]);
  assert.deepEqual(result.selected, {
    profile: null,
    account_id: "d".repeat(32),
    account_label: "Environment Account",
    auth_source: "environment",
  });
  assert.equal(calls.some(({ args }) => args[0] === "auth"), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
});

test("each Skill exposes a self-describing command catalog with a bounded surface", async () => {
  const daily = getCommandCatalog({ surface: "daily" });
  const admin = getCommandCatalog({ surface: "admin" });
  const deploy = getCommandCatalog({ surface: "deploy" });
  const names = (catalog) => catalog.commands.map((entry) => entry.name);

  assert.equal(daily.surface, "daily");
  assert.equal(names(daily).includes("scope resolve"), true);
  assert.equal(names(daily).includes("invite redeem"), true);
  assert.equal(names(daily).includes("credential verify-and-promote"), true);
  assert.equal(names(daily).includes("credential promote"), false);
  assert.equal(names(daily).includes("plan strict-zero"), false);
  assert.equal(names(admin).includes("api request"), true);
  assert.equal(names(admin).includes("owner rotate-credential"), true);
  assert.equal(names(admin).includes("scope resolve"), false);
  assert.equal(names(admin).includes("plan strict-zero"), false);
  assert.equal(names(deploy).includes("plan strict-zero"), true);
  assert.equal(names(deploy).includes("runtime inspect-cloudflare-auth"), true);
  assert.equal(names(deploy).includes("runtime resolve-cloudflare-auth"), true);
  assert.equal(names(deploy).includes("migrations assess-ledger-recovery"), true);
  assert.equal(names(deploy).includes("runtime plan-cloudflare-auth"), true);
  assert.equal(names(deploy).includes("runtime cloudflare-auth-action"), true);
  assert.equal(deploy.commands.find((entry) => entry.name === "runtime cloudflare-auth-action").input_fields.includes("completedActionIds"), true);
  assert.equal(names(deploy).includes("runtime wrangler-account-readback"), true);
  assert.equal(names(deploy).includes("runtime d1-resource-readback"), true);
  assert.equal(names(deploy).includes("runtime worker-resource-readback"), true);
  assert.equal(names(deploy).includes("deployment prepare-owner-credential"), true);
  assert.equal(names(deploy).includes("deployment finalize-owner"), true);
  assert.equal(names(deploy).includes("runtime wrangler-whoami"), false);
  assert.equal(names(deploy).includes("scope resolve"), false);
  assert.equal(deploy.commands.every((entry) => entry.description && entry.effect && Array.isArray(entry.input_fields)), true);
  assert.equal([...daily.commands, ...admin.commands].some((entry) => entry.input_fields.includes("newCredentialToken")), false);

  await assert.rejects(
    dispatch("plan strict-zero", {}, { surface: "daily" }),
    (error) => error.code === "COMMAND_OUTSIDE_SKILL_SURFACE",
  );
});

test("Invite redemption injects and verifies a pending Credential without exposing it", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pending = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    idempotencyKey: "invite-one",
  });
  const secret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  assert.equal(pending.credential_id, null);
  assert.equal(pending.credential_id_binding, "server_assigned");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, headers: new Headers(options.headers), body: options.body });
    if (url.pathname === "/api/v1/invitations/redeem") {
      return new Response(JSON.stringify({
        resource: { principal: { principal_id: PRINCIPAL_ID } },
        event_cursor: "1",
        idempotent_replay: false,
        unsafe_echo_fixture: `${secret.token}:private-invite-code`,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: PRINCIPAL_ID,
      principal_id: PRINCIPAL_ID,
      is_owner: false,
      credential: { id: SERVER_CREDENTIAL_ID, fingerprint: pending.fingerprint },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await redeemInvitation({
    stateRoot,
    instanceId: INSTANCE_ID,
    inviteCode: "private-invite-code",
    redeemAs: "new_principal",
    displayName: "Example Participant",
    fetchImpl,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.has("authorization"), false);
  assert.equal(JSON.parse(calls[0].body).new_credential_token, secret.token);
  assert.equal(calls[0].headers.get("idempotency-key"), "invite-one");
  assert.equal(calls[1].headers.get("authorization"), `Bearer ${secret.token}`);
  assert.equal(result.credential.state, "current");
  assert.equal(result.credential.credential_id, SERVER_CREDENTIAL_ID);
  assert.equal(JSON.stringify(result).includes(secret.token), false);
  const current = await loadCurrentCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  assert.equal(current.metadata.credential_id, SERVER_CREDENTIAL_ID);
  assert.equal(current.token, secret.token);
});

test("Public Join promotes the Credential ID assigned by the Service", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pending = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    idempotencyKey: "public-join-one",
  });
  const secret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  const publicId = "88888888-8888-4888-8888-888888888888";
  const fetchImpl = async (url, options) => {
    if (url.pathname === `/api/v1/public-joins/${publicId}/redeem`) {
      assert.equal(JSON.parse(options.body).new_credential_token, secret.token);
      return new Response(JSON.stringify({
        resource: { principal: { principal_id: PRINCIPAL_ID } },
        event_cursor: "1",
        idempotent_replay: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: PRINCIPAL_ID,
      principal_id: PRINCIPAL_ID,
      is_owner: false,
      credential: { id: SERVER_CREDENTIAL_ID, fingerprint: pending.fingerprint },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await redeemPublicJoin({
    stateRoot,
    instanceId: INSTANCE_ID,
    publicId,
    role: "writer",
    redeemAs: "new_principal",
    displayName: "Public Join Participant",
    fetchImpl,
  });
  assert.equal(result.credential.credential_id, SERVER_CREDENTIAL_ID);
  assert.equal((await loadCurrentCredentialSecret({ stateRoot, instanceId: INSTANCE_ID })).metadata.credential_id, SERVER_CREDENTIAL_ID);
  assert.equal(JSON.stringify(result).includes(secret.token), false);
});

test("current Principal Invite and Public Join redemption return the same safe operation envelope", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pending = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
    idempotencyKey: "existing-principal-bootstrap",
    purpose: "owner_bootstrap",
  });
  const currentSecret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  await promotePendingCredential({
    stateRoot,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    fingerprint: pending.fingerprint,
  });
  const inviteCode = "current-principal-invite-code";
  const publicId = "88888888-8888-4888-8888-888888888888";
  const fetchImpl = async (url) => new Response(JSON.stringify({
    resource: { route: url.pathname },
    event_cursor: "2",
    idempotent_replay: false,
    unsafe_echo_fixture: url.pathname === "/api/v1/invitations/redeem"
      ? `${currentSecret.token}:${inviteCode}`
      : currentSecret.token,
  }), { status: 200, headers: { "content-type": "application/json" } });

  const invitation = await redeemInvitation({
    stateRoot,
    instanceId: INSTANCE_ID,
    inviteCode,
    redeemAs: "current_principal",
    idempotencyKey: "current-principal-invite",
    fetchImpl,
  });
  const publicJoin = await redeemPublicJoin({
    stateRoot,
    instanceId: INSTANCE_ID,
    publicId,
    role: "writer",
    redeemAs: "current_principal",
    idempotencyKey: "current-principal-public-join",
    fetchImpl,
  });
  for (const result of [invitation, publicJoin]) {
    assert.equal(result.operation.ok, true);
    assert.equal(result.credential.state, "current");
    assert.equal(result.credential.principal_id, PRINCIPAL_ID);
    assert.equal(result.credential.credential_id, CREDENTIAL_ID);
    assert.equal(result.credential.secret_values_exposed, false);
    assert.equal(JSON.stringify(result).includes(currentSecret.token), false);
    assert.equal(JSON.stringify(result).includes(inviteCode), false);
  }

  const denied = await redeemPublicJoin({
    stateRoot,
    instanceId: INSTANCE_ID,
    publicId,
    role: "reader",
    redeemAs: "current_principal",
    idempotencyKey: "current-principal-public-join-denied",
    fetchImpl: async () => new Response(JSON.stringify({
      code: "FORBIDDEN",
      category: "authorization",
      source: "service",
      request_id: "request-one",
      retryable: false,
      recovery: "request_access",
      details: {},
    }), { status: 403, headers: { "content-type": "application/json" } }),
  });
  assert.equal(denied.operation.ok, false);
  assert.equal(denied.operation.error.code, "FORBIDDEN");
  assert.equal(denied.credential.state, "current");
  assert.equal(denied.credential.credential_id, CREDENTIAL_ID);
});

test("Owner rotation keeps both current and replacement Credentials inside the bundled tool", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
    idempotencyKey: "owner-bootstrap",
    purpose: "owner_bootstrap",
  });
  const firstSecret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  await promotePendingCredential({ stateRoot, instanceId: INSTANCE_ID, principalId: PRINCIPAL_ID, credentialId: first.credential_id, fingerprint: first.fingerprint });

  const replacement = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    operationId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: "owner-rotation",
    purpose: "owner_rotation",
  });
  const replacementSecret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  assert.equal(replacement.credential_id, null);
  assert.equal(replacement.credential_id_binding, "server_assigned");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, headers: new Headers(options.headers), body: options.body });
    if (url.pathname === "/api/v1/admin/owner-credentials/rotate") {
      return new Response(JSON.stringify({
        resource: { id: SERVER_CREDENTIAL_ID },
        event_cursor: "2",
        idempotent_replay: false,
        unsafe_echo_fixture: `${firstSecret.token}:${replacementSecret.token}`,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: PRINCIPAL_ID,
      principal_id: PRINCIPAL_ID,
      is_owner: true,
      credential: { id: SERVER_CREDENTIAL_ID, fingerprint: replacement.fingerprint },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await rotateOwnerCredential({ stateRoot, instanceId: INSTANCE_ID, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${firstSecret.token}`);
  assert.equal(JSON.parse(calls[0].body).new_credential_token, replacementSecret.token);
  assert.equal(calls[0].headers.get("idempotency-key"), "owner-rotation");
  assert.equal(calls[1].headers.get("authorization"), `Bearer ${replacementSecret.token}`);
  assert.equal(result.credential.state, "current");
  assert.equal(result.credential.credential_id, SERVER_CREDENTIAL_ID);
  assert.equal(JSON.stringify(result).includes(firstSecret.token), false);
  assert.equal(JSON.stringify(result).includes(replacementSecret.token), false);
  assert.equal((await loadCurrentCredentialSecret({ stateRoot, instanceId: INSTANCE_ID })).token, replacementSecret.token);
});

test("legacy participant pending records accept the authenticated server Credential ID without weakening Owner bootstrap binding", async (t) => {
  const participant = await fixtureState();
  const owner = await fixtureState();
  t.after(() => Promise.all([
    rm(participant.home, { recursive: true, force: true }),
    rm(owner.home, { recursive: true, force: true }),
  ]));

  const participantPending = await createPendingCredential({
    stateRoot: participant.stateRoot,
    home: participant.home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    idempotencyKey: "legacy-participant",
  });
  const participantPaths = getInstancePaths({ stateRoot: participant.stateRoot, instanceId: INSTANCE_ID });
  const legacyParticipant = JSON.parse(await readFile(participantPaths.pendingMetadata, "utf8"));
  delete legacyParticipant.credential_id_binding;
  legacyParticipant.credential_id = CREDENTIAL_ID;
  await writeFile(participantPaths.pendingMetadata, `${JSON.stringify(legacyParticipant)}\n`, { mode: 0o600 });
  const promoted = await promotePendingCredential({
    stateRoot: participant.stateRoot,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: SERVER_CREDENTIAL_ID,
    fingerprint: participantPending.fingerprint,
  });
  assert.equal(promoted.credential_id, SERVER_CREDENTIAL_ID);
  assert.equal(promoted.credential_id_binding, "server_assigned");

  const ownerPending = await createPendingCredential({
    stateRoot: owner.stateRoot,
    home: owner.home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
    idempotencyKey: "legacy-owner",
    purpose: "owner_bootstrap",
  });
  const ownerPaths = getInstancePaths({ stateRoot: owner.stateRoot, instanceId: INSTANCE_ID });
  const legacyOwner = JSON.parse(await readFile(ownerPaths.pendingMetadata, "utf8"));
  delete legacyOwner.credential_id_binding;
  await writeFile(ownerPaths.pendingMetadata, `${JSON.stringify(legacyOwner)}\n`, { mode: 0o600 });
  await assert.rejects(
    promotePendingCredential({
      stateRoot: owner.stateRoot,
      instanceId: INSTANCE_ID,
      principalId: PRINCIPAL_ID,
      credentialId: SERVER_CREDENTIAL_ID,
      fingerprint: ownerPending.fingerprint,
    }),
    (error) => error.code === "STATE_SECRET_MISMATCH",
  );
});

test("private state uses pending to current promotion, hides secrets, and rejects a second Principal", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pending = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
    idempotencyKey: "bootstrap-one",
  });
  assert.equal(pending.state, "pending");
  const pendingSecret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  assert.match(pendingSecret.token, /^cfk_v1_[A-Za-z0-9]+_[A-Za-z0-9_-]{43}$/);
  const inspected = await inspectInstanceState({ stateRoot, home, persistenceConfirmed: true, instanceId: INSTANCE_ID });
  assert.equal(JSON.stringify(inspected).includes(pendingSecret.token), false);
  await assert.rejects(
    promotePendingCredential({ stateRoot, instanceId: INSTANCE_ID, principalId: PRINCIPAL_ID, credentialId: "77777777-7777-4777-8777-777777777777", fingerprint: pending.fingerprint }),
    (error) => error.code === "STATE_SECRET_MISMATCH",
  );
  const promoted = await promotePendingCredential({ stateRoot, instanceId: INSTANCE_ID, principalId: PRINCIPAL_ID, credentialId: pending.credential_id, fingerprint: pending.fingerprint });
  assert.equal(promoted.state, "current");
  assert.equal((await loadCurrentCredentialSecret({ stateRoot, instanceId: INSTANCE_ID })).token, pendingSecret.token);
  if (process.platform !== "win32") {
    const paths = getInstancePaths({ stateRoot, instanceId: INSTANCE_ID });
    assert.equal((await stat(stateRoot)).mode & 0o077, 0);
    assert.equal((await stat(paths.currentSecret)).mode & 0o077, 0);
  }
  await assert.rejects(
    createPendingCredential({ stateRoot, home, persistenceConfirmed: true, instanceId: INSTANCE_ID, principalId: OTHER_PRINCIPAL_ID }),
    (error) => error.code === "STATE_IDENTITY_CONFLICT",
  );
});

test("state initialization rejects a symlink root", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban-wp10-symlink-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const real = path.join(home, "real");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, path.join(home, ".cfkanban"));
  await assert.rejects(
    initializeStateRoot({ stateRoot: path.join(home, ".cfkanban"), home, persistenceConfirmed: true }),
    (error) => error.code === "STATE_SYMLINK_REJECTED",
  );
});

test("Owner bootstrap and finalization stay plan-bound, verify exact identity, and write only a redacted receipt", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const serviceRoot = path.join(home, "service-bundle");
  await mkdir(path.join(serviceRoot, "dist"), { recursive: true });
  await mkdir(path.join(serviceRoot, "apps", "web", "dist"), { recursive: true });
  await mkdir(path.join(serviceRoot, "contracts"), { recursive: true });
  await mkdir(path.join(serviceRoot, "migrations"), { recursive: true });
  await mkdir(path.join(serviceRoot, "release", "deployment"), { recursive: true });
  await writeFile(path.join(serviceRoot, "dist", "index.js"), "export default {};\n", "utf8");
  await writeFile(path.join(serviceRoot, "apps", "web", "dist", "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(path.join(serviceRoot, "contracts", "openapi.json"), `${JSON.stringify({ info: { version: "0.1.0" } })}\n`, "utf8");
  const migrationText = "SELECT 1;\n";
  const migration = {
    sequence: 1,
    name: "0001_initial.sql",
    sha256: sha256Bytes(Buffer.from(migrationText, "utf8")),
    classification: "bootstrap",
    destructive: false,
    reentry: "wrangler_migration_ledger_only",
    expected_artifacts: { tables: [], indexes: [] },
  };
  await writeFile(path.join(serviceRoot, "migrations", migration.name), migrationText, "utf8");
  await writeFile(path.join(serviceRoot, "migrations", "manifest.json"), `${JSON.stringify({ manifest_version: 1, schema_version: 1, migrations: [migration] }, null, 2)}\n`, "utf8");
  await writeFile(path.join(serviceRoot, "release", "deployment", "migration-readback.sql"), "SELECT 1;\n", "utf8");
  await writeFile(path.join(serviceRoot, "wrangler-config-schema.json"), "{}\n", "utf8");
  await writeFile(path.join(serviceRoot, "wrangler.template.json"), JSON.stringify({
    compatibility_date: "2026-08-29",
    assets: { binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/healthz"] },
  }), "utf8");

  const artifactRoot = path.join(home, "artifacts");
  const skillSource = path.join(home, "skill-source");
  await mkdir(artifactRoot);
  await mkdir(skillSource);
  await writeFile(path.join(skillSource, "SKILL.md"), "---\nname: fixture\ndescription: fixture\n---\n", "utf8");
  const skillBundle = path.join(artifactRoot, "skills.zip");
  const serviceBundle = path.join(artifactRoot, "service.zip");
  await writeDeterministicZip({ root: skillSource, outputPath: skillBundle, prefix: "skills/" });
  await writeDeterministicZip({ root: serviceRoot, outputPath: serviceBundle, prefix: "service/" });
  const releaseOutput = path.join(home, "release-output");
  await mkdir(releaseOutput);
  const generated = await generateReleaseMetadata({
    outputDirectory: releaseOutput,
    canonicalBaseUrl: "https://releases.example.test/cfkanban/0.1.0/",
    version: "0.1.0",
    skillBundlePath: skillBundle,
    serviceBundlePath: serviceBundle,
    nodeRange: ">=22.12.0 <27",
    wranglerRange: ">=4.127.1 <5",
    serviceApiRange: ">=0.1.0 <0.2.0",
    schemaVersion: 1,
  });
  const serviceArtifact = generated.manifest.artifacts.find((artifact) => artifact.kind === "service_deployment_bundle");
  const skillArtifact = generated.manifest.artifacts.find((artifact) => artifact.kind === "skill_bundle");
  const installedService = await installVerifiedServiceBundle({
    bundlePath: serviceBundle,
    version: serviceArtifact.version,
    expectedSha256: serviceArtifact.sha256,
    publisher: generated.manifest.publisher.canonical_origin,
    source: serviceArtifact.url,
    releaseRoot: path.join(stateRoot, "service-releases"),
  });
  assert.equal(installedService.installed, true);
  assert.equal(installedService.verified, true);
  assert.equal(installedService.path.endsWith(path.join("versions", "0.1.0", "service")), true);
  const reusedService = await installVerifiedServiceBundle({
    bundlePath: serviceBundle,
    version: serviceArtifact.version,
    expectedSha256: serviceArtifact.sha256,
    publisher: generated.manifest.publisher.canonical_origin,
    source: serviceArtifact.url,
    releaseRoot: path.join(stateRoot, "service-releases"),
  });
  assert.equal(reusedService.reused, true);
  const plan = createStrictZeroPlan({
    taskId: "wp10-owner-finalize",
    accountId: "account-one",
    cloudflareProfile: "production",
    ownerDisplayName: "Example Owner",
    release: {
      manifest_version: generated.manifest.release.version,
      manifest_sha256: generated.pointer.manifest_sha256,
      service_bundle_version: serviceArtifact.version,
      service_bundle_sha256: serviceArtifact.sha256,
    },
    instanceId: INSTANCE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    ownerCredentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
  }).plan;
  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: plan.task_id, planDigest: canonicalDigest(plan) });
  const config = await writeFrozenWranglerConfig({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    serviceBundleRoot: serviceRoot,
    d1DatabaseId: "77777777-7777-4777-8777-777777777777",
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: {
      type: "command_finished",
      action: "migration_ledger_readback",
      exit_code: 0,
      migration_readback: {
        ledger: [{ ...migration, operation_id: OPERATION_ID, applied_at: Date.now() }],
        schema: { tables: [], indexes: [] },
        result_set_count: 2,
      },
    },
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "deploy_worker_and_static_assets", exit_code: 0 },
  });
  await installVerifiedSkillBundle({
    bundlePath: skillBundle,
    version: "0.1.0",
    expectedSha256: skillArtifact.sha256,
    publisher: generated.manifest.publisher.canonical_origin,
    source: skillArtifact.url,
    releaseRoot: path.join(stateRoot, "skill-releases"),
  });
  const prepared = await prepareOwnerCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
  });
  assert.equal(prepared.state, "pending");
  const pending = await readJson(getInstancePaths({ stateRoot, instanceId: INSTANCE_ID }).pendingMetadata);
  const secret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  const result = await writeOwnerBootstrapSql({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    configPath: config.wrangler_config_path,
    preferredApiOrigin: "https://example.workers.dev",
  });
  const sql = await readFile(result.bootstrap_sql_path, "utf8");
  assert.equal(sql.includes(secret.token), false);
  assert.equal(sql.includes(pending.token_digest), true);
  assert.doesNotMatch(sql, /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/iu);
  assert.equal(result.contains_plaintext_credential, false);
  assert.equal(result.relies_on_wrangler_file_ingestion_transaction, true);
  await assert.rejects(
    executeWranglerAction({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: plan.task_id,
      plan,
      wranglerExecutable: "/opt/cfkanban/wrangler",
      action: "bootstrap_owner",
      configPath: config.wrangler_config_path,
      bootstrapSqlPath: result.bootstrap_sql_path,
      runner: async () => ({ code: 1, signal: null, stdout: "", stderr: "fetch failed" }),
    }),
    (error) => error.code === "WRANGLER_ACTION_FAILED",
  );
  await assert.rejects(
    executeWranglerAction({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: plan.task_id,
      plan,
      wranglerExecutable: "/opt/cfkanban/wrangler",
      action: "bootstrap_owner",
      configPath: config.wrangler_config_path,
      bootstrapSqlPath: result.bootstrap_sql_path,
      runner: async () => ({ code: 0, signal: null, stdout: "", stderr: "" }),
    }),
    (error) => error.code === "OWNER_BOOTSTRAP_ALREADY_ATTEMPTED",
  );
  let recoveryArgs = null;
  const recovery = await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "owner_bootstrap_readback",
    configPath: config.wrangler_config_path,
    bootstrapSqlPath: result.bootstrap_sql_path,
    runner: async (_executable, args) => {
      recoveryArgs = args;
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify([{ success: true, results: [{ principals: 0, instance_meta: 0, instance_origin_settings: 0, credentials: 0, events: 0, operation_commits: 0 }] }]),
        stderr: "",
      };
    },
  });
  assert.equal(recovery.owner_bootstrap_readback.state, "absent");
  assert.equal(recovery.owner_bootstrap_readback.safe_to_retry, true);
  assert.equal(recovery.stdout_summary, '{"state":"absent","safe_to_retry":true}');
  assert.equal(recoveryArgs.includes("--command"), true);
  assert.equal(recoveryArgs.includes("--json"), true);
  assert.equal(JSON.stringify(recoveryArgs).includes(secret.token), false);
  assert.equal(JSON.stringify(recoveryArgs).includes(pending.token_digest), false);

  const retried = await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "bootstrap_owner",
    configPath: config.wrangler_config_path,
    bootstrapSqlPath: result.bootstrap_sql_path,
    runner: async () => ({ code: 0, signal: null, stdout: "bootstrap complete", stderr: "" }),
  });
  assert.equal(retried.command_succeeded, true);
  await assert.rejects(
    executeWranglerAction({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: plan.task_id,
      plan,
      wranglerExecutable: "/opt/cfkanban/wrangler",
      action: "bootstrap_owner",
      configPath: config.wrangler_config_path,
      bootstrapSqlPath: result.bootstrap_sql_path,
      runner: async () => ({ code: 0, signal: null, stdout: "", stderr: "" }),
    }),
    (error) => error.code === "OWNER_BOOTSTRAP_ALREADY_ATTEMPTED",
  );

  const fetchCalls = [];
  let wrongCredential = true;
  const fetchImpl = async (url, options) => {
    const headers = new Headers(options.headers);
    fetchCalls.push({ path: url.pathname, authorization: headers.has("authorization") });
    let body;
    if (url.pathname === "/healthz") {
      body = { d1: "reachable", service_version: "0.1.0", schema_version: 1 };
    } else if (url.pathname === "/.well-known/cfkanban-instance.json") {
      body = { discovery_version: 1, instance_id: INSTANCE_ID, observed_origin: url.origin, preferred_api_origin: url.origin, origin_version: 1, service_version: "0.1.0" };
    } else if (url.pathname === "/api/v1/meta") {
      body = { instance_id: INSTANCE_ID, observed_origin: url.origin, preferred_api_origin: url.origin, origin_version: 1, service_version: "0.1.0", schema_version: 1, principal: { id: PRINCIPAL_ID, is_owner: true } };
    } else {
      body = { id: PRINCIPAL_ID, principal_id: PRINCIPAL_ID, display_name: "Example Owner", is_owner: true, credential: { id: wrongCredential ? "88888888-8888-4888-8888-888888888888" : CREDENTIAL_ID, fingerprint: pending.fingerprint } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const finalizeInput = {
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    configPath: config.wrangler_config_path,
    apiOrigin: "https://example.workers.dev",
    releasePointerPath: generated.pointerPath,
    manifestPath: generated.manifestPath,
    artifactFiles: { skill_bundle: skillBundle, service_deployment_bundle: serviceBundle },
    fetchImpl,
  };
  await assert.rejects(finalizeOwnerDeployment(finalizeInput), (error) => error.code === "DEPLOYMENT_OWNER_MISMATCH");
  assert.equal((await inspectInstanceState({ stateRoot, home, persistenceConfirmed: true, instanceId: INSTANCE_ID })).credential.pending.state, "pending");
  wrongCredential = false;
  const finalized = await finalizeOwnerDeployment(finalizeInput);
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.credential_state, "current");
  assert.equal(finalized.secret_values_exposed, false);
  const receipt = await readJson(finalized.receipt_path);
  assert.equal(receipt.owner.credential_id, CREDENTIAL_ID);
  assert.equal(receipt.operation.plan_digest, canonicalDigest(plan));
  assert.equal(receipt.active_skill_runtime.version, "0.1.0");
  assert.equal(JSON.stringify(receipt).includes(secret.token), false);
  assert.equal(JSON.stringify(finalized).includes(secret.token), false);
  assert.equal(fetchCalls.filter((call) => call.authorization).every((call) => call.path === "/api/v1/meta" || call.path === "/api/v1/me"), true);
  const resumed = await finalizeOwnerDeployment(finalizeInput);
  assert.equal(resumed.resumed, true);
  const journal = await readJson(getInstancePaths({ stateRoot, instanceId: INSTANCE_ID }).journalsRoot + `/${OPERATION_ID}.json`);
  assert.equal(journal.events.filter((event) => event.type === "deployment_finalized").length, 1);
});

test("existing Instance upgrade consumes a verified Service cache, preserves the Owner Credential, and writes a redacted before/after receipt", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const serviceRoot = path.join(home, "upgrade-service");
  for (const directory of [
    "dist",
    path.join("apps", "web", "dist"),
    "contracts",
    "migrations",
    path.join("release", "deployment"),
  ]) {
    await mkdir(path.join(serviceRoot, directory), { recursive: true });
  }
  await writeFile(path.join(serviceRoot, "dist", "index.js"), "export default {};\n", "utf8");
  await writeFile(path.join(serviceRoot, "apps", "web", "dist", "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(path.join(serviceRoot, "contracts", "openapi.json"), JSON.stringify({ info: { version: "0.1.0" } }) + "\n", "utf8");
  const initialSql = "SELECT 1;\n";
  const initialMigration = {
    sequence: 1,
    name: "0001_initial.sql",
    sha256: sha256Bytes(Buffer.from(initialSql, "utf8")),
    classification: "bootstrap",
    destructive: false,
    reentry: "wrangler_migration_ledger_only",
    expected_artifacts: { tables: [], indexes: [] },
  };
  const upgradeSql = "CREATE TABLE project_context (project_id TEXT PRIMARY KEY);\n";
  const upgradeMigration = {
    sequence: 2,
    name: "0002_project_context.sql",
    sha256: sha256Bytes(Buffer.from(upgradeSql, "utf8")),
    classification: "backward_compatible",
    destructive: false,
    reentry: "wrangler_file_ingestion_transaction",
    expected_artifacts: { tables: ["project_context"], indexes: [] },
  };
  const migrationManifest = { manifest_version: 1, schema_version: 2, migrations: [initialMigration, upgradeMigration] };
  const migrationManifestText = JSON.stringify(migrationManifest, null, 2) + "\n";
  await writeFile(path.join(serviceRoot, "migrations", initialMigration.name), initialSql, "utf8");
  await writeFile(path.join(serviceRoot, "migrations", upgradeMigration.name), upgradeSql, "utf8");
  await writeFile(path.join(serviceRoot, "migrations", "manifest.json"), migrationManifestText, "utf8");
  await writeFile(path.join(serviceRoot, "release", "deployment", "migration-readback.sql"), "SELECT 1;\nSELECT 1;\n", "utf8");
  await writeFile(path.join(serviceRoot, "wrangler-config-schema.json"), "{}\n", "utf8");
  await writeFile(path.join(serviceRoot, "wrangler.template.json"), JSON.stringify({
    compatibility_date: "2026-08-29",
    assets: { binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/healthz"] },
  }), "utf8");

  const artifactRoot = path.join(home, "upgrade-artifacts");
  const skillSource = path.join(home, "upgrade-skill");
  await mkdir(artifactRoot);
  await mkdir(skillSource);
  await writeFile(path.join(skillSource, "SKILL.md"), "---\nname: fixture\ndescription: fixture\n---\n", "utf8");
  const skillBundle = path.join(artifactRoot, "skills.zip");
  const serviceBundle = path.join(artifactRoot, "service.zip");
  await writeDeterministicZip({ root: skillSource, outputPath: skillBundle, prefix: "skills/" });
  await writeDeterministicZip({ root: serviceRoot, outputPath: serviceBundle, prefix: "service/" });
  const releaseOutput = path.join(home, "upgrade-release");
  await mkdir(releaseOutput);
  const generated = await generateReleaseMetadata({
    outputDirectory: releaseOutput,
    canonicalBaseUrl: "https://releases.example.test/cfkanban/0.1.0-alpha.19/",
    channel: "prerelease",
    version: "0.1.0-alpha.19",
    skillBundlePath: skillBundle,
    serviceBundlePath: serviceBundle,
    nodeRange: ">=22.12.0 <27",
    wranglerRange: ">=4.127.1 <5",
    serviceApiRange: ">=0.1.0 <0.2.0",
    schemaVersion: 2,
  });
  const serviceArtifact = generated.manifest.artifacts.find((artifact) => artifact.kind === "service_deployment_bundle");
  const skillArtifact = generated.manifest.artifacts.find((artifact) => artifact.kind === "skill_bundle");
  const installedService = await installVerifiedServiceBundle({
    bundlePath: serviceBundle,
    version: serviceArtifact.version,
    expectedSha256: serviceArtifact.sha256,
    publisher: generated.manifest.publisher.canonical_origin,
    source: serviceArtifact.url,
    releaseRoot: path.join(stateRoot, "service-releases"),
  });
  await installVerifiedSkillBundle({
    bundlePath: skillBundle,
    version: skillArtifact.version,
    expectedSha256: skillArtifact.sha256,
    publisher: generated.manifest.publisher.canonical_origin,
    source: skillArtifact.url,
    releaseRoot: path.join(stateRoot, "skill-releases"),
  });

  const credential = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    operationId: "99999999-9999-4999-8999-999999999999",
    idempotencyKey: "99999999-9999-4999-8999-999999999999",
    purpose: "owner_bootstrap",
  });
  await promotePendingCredential({
    stateRoot,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    fingerprint: credential.fingerprint,
  });
  const secret = await loadCurrentCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  const base = upgradePlanInput();
  const current = {
    ...base.current,
    publisher: generated.manifest.publisher.canonical_origin,
    service_bundle_source: "https://releases.example.test/cfkanban/0.1.0-alpha.8/service.zip",
  };
  const target = {
    publisher: generated.manifest.publisher.canonical_origin,
    manifest_version: generated.manifest.release.version,
    manifest_sha256: generated.pointer.manifest_sha256,
    service_bundle_version: serviceArtifact.version,
    service_bundle_sha256: serviceArtifact.sha256,
    service_bundle_source: serviceArtifact.url,
    service_api_version: "0.1.0",
    schema_version: 2,
    migration_manifest_sha256: sha256Bytes(Buffer.from(migrationManifestText, "utf8")),
    compatibility: generated.manifest.compatibility,
  };
  const plan = createInstanceUpgradePlan({
    ...base,
    current,
    target,
    migrations: [upgradeMigration],
    restorePoint: {
      required: true,
      verified: true,
      bookmark: "0000001c-00000000-000050dc-example",
      observed_at: "2026-09-04T01:02:03.000Z",
      retention_boundary: "verified_current_cloudflare_plan_boundary",
      reason: "pre_migration_time_travel_bookmark",
    },
    owner: {
      display_name: "Example Owner",
      principal_id: PRINCIPAL_ID,
      credential_id: CREDENTIAL_ID,
      credential_fingerprint: credential.fingerprint,
    },
  });
  const paths = getInstancePaths({ stateRoot, instanceId: INSTANCE_ID });
  await mkdir(paths.receiptsRoot, { recursive: true, mode: 0o700 });
  const currentReceiptPath = path.join(paths.receiptsRoot, "99999999-9999-4999-8999-999999999999.deployment.json");
  await writeFile(currentReceiptPath, JSON.stringify({
    schema_version: 1,
    kind: "cfkanban_deployment_receipt",
    instance: { id: INSTANCE_ID, api_origin: "https://example.workers.dev", origin_version: 1, service_version: "0.1.0", schema_version: 1 },
    cloudflare: {
      account_id: "account-one",
      profile: "production",
      worker: { name: "cfkanban-worker" },
      d1: { name: "cfkanban-d1", database_id: base.resources.d1.database_id },
    },
    owner: {
      display_name: "Example Owner",
      principal_id: PRINCIPAL_ID,
      credential_id: CREDENTIAL_ID,
      credential_fingerprint: credential.fingerprint,
    },
    service_release: current,
    secret_values_exposed: false,
  }, null, 2) + "\n", { mode: 0o600 });

  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: plan.task_id, planDigest: canonicalDigest(plan) });
  const config = await writeFrozenWranglerConfig({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    serviceBundleRoot: installedService.path,
    d1DatabaseId: base.resources.d1.database_id,
  });
  const readbackOutput = JSON.stringify([
    {
      success: true,
      results: [{
        ...initialMigration,
        operation_id: "99999999-9999-4999-8999-999999999999",
        applied_at: 1_788_000_000_000,
      }],
    },
    { success: true, results: [] },
  ]);
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "migration_ledger_readback",
    configPath: config.wrangler_config_path,
    migrationReadbackSqlPath: path.join(installedService.path, "release", "deployment", "migration-readback.sql"),
    runner: async () => ({ code: 0, signal: null, stdout: readbackOutput, stderr: "" }),
  });
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "apply_migration",
    configPath: config.wrangler_config_path,
    migrationName: upgradeMigration.name,
    migrationSqlPath: path.join(installedService.path, "migrations", upgradeMigration.name),
    runner: async () => ({ code: 0, signal: null, stdout: "[]", stderr: "" }),
  });
  const postApplyReadback = JSON.stringify([
    {
      success: true,
      results: [{
        ...initialMigration,
        operation_id: "99999999-9999-4999-8999-999999999999",
        applied_at: 1_788_000_000_000,
      }],
    },
    { success: true, results: [{ type: "table", name: "project_context" }] },
  ]);
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "migration_ledger_readback",
    configPath: config.wrangler_config_path,
    migrationReadbackSqlPath: path.join(installedService.path, "release", "deployment", "migration-readback.sql"),
    runner: async () => ({ code: 0, signal: null, stdout: postApplyReadback, stderr: "" }),
  });
  const record = await writeMigrationLedgerRecordSql({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    migration: upgradeMigration,
    migrationManifestPath: path.join(installedService.path, "migrations", "manifest.json"),
  });
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "record_migration_checksum",
    configPath: config.wrangler_config_path,
    migrationName: upgradeMigration.name,
    migrationRecordSqlPath: record.migration_record_sql_path,
    runner: async () => ({ code: 0, signal: null, stdout: "[]", stderr: "" }),
  });
  await assert.rejects(
    executeWranglerAction({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: plan.task_id,
      plan,
      wranglerExecutable: "/opt/cfkanban/wrangler",
      action: "record_migration_checksum",
      configPath: config.wrangler_config_path,
      migrationName: upgradeMigration.name,
      migrationRecordSqlPath: record.migration_record_sql_path,
      runner: async () => ({ code: 0, signal: null, stdout: "[]", stderr: "" }),
    }),
    (error) => error.code === "UPGRADE_MIGRATION_CHECKSUM_ALREADY_RECORDED",
  );
  const finalReadback = JSON.stringify([
    {
      success: true,
      results: [
        {
          ...initialMigration,
          operation_id: "99999999-9999-4999-8999-999999999999",
          applied_at: 1_788_000_000_000,
        },
        {
          ...upgradeMigration,
          operation_id: OPERATION_ID,
          applied_at: 1_788_000_001_000,
        },
      ],
    },
    { success: true, results: [{ type: "table", name: "project_context" }] },
  ]);
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "migration_ledger_readback",
    configPath: config.wrangler_config_path,
    migrationReadbackSqlPath: path.join(installedService.path, "release", "deployment", "migration-readback.sql"),
    runner: async () => ({ code: 0, signal: null, stdout: finalReadback, stderr: "" }),
  });
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "validate_worker_bundle",
    configPath: config.wrangler_config_path,
    runner: async () => ({ code: 0, signal: null, stdout: "dry run", stderr: "" }),
  });
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "deploy_worker_and_static_assets",
    configPath: config.wrangler_config_path,
    runner: async () => ({ code: 0, signal: null, stdout: "deployed", stderr: "" }),
  });
  const afterDeploymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const afterVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "worker_deployment_readback",
    configPath: config.wrangler_config_path,
    runner: async () => ({
      code: 0,
      signal: null,
      stdout: JSON.stringify({
        id: afterDeploymentId,
        created_on: "2026-09-04T02:03:04.000Z",
        versions: [{ version_id: afterVersionId, percentage: 100 }],
      }),
      stderr: "",
    }),
  });
  const fetchImpl = async (url) => {
    let body;
    if (url.pathname === "/healthz") {
      body = { d1: "reachable", service_version: "0.1.0", schema_version: 2 };
    } else if (url.pathname === "/.well-known/cfkanban-instance.json") {
      body = { discovery_version: 1, instance_id: INSTANCE_ID, observed_origin: url.origin, preferred_api_origin: url.origin, origin_version: 1, service_version: "0.1.0" };
    } else if (url.pathname === "/api/v1/meta") {
      body = { instance_id: INSTANCE_ID, observed_origin: url.origin, preferred_api_origin: url.origin, origin_version: 1, service_version: "0.1.0", schema_version: 2, principal: { id: PRINCIPAL_ID, is_owner: true } };
    } else {
      body = { id: PRINCIPAL_ID, principal_id: PRINCIPAL_ID, display_name: "Example Owner", is_owner: true, credential: { id: CREDENTIAL_ID, fingerprint: credential.fingerprint } };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const finalizeInput = {
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    configPath: config.wrangler_config_path,
    apiOrigin: "https://example.workers.dev",
    currentReceiptPath,
    releasePointerPath: generated.pointerPath,
    manifestPath: generated.manifestPath,
    artifactFiles: { skill_bundle: skillBundle, service_deployment_bundle: serviceBundle },
    fetchImpl,
  };
  const finalized = await finalizeInstanceUpgrade(finalizeInput);
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.credential_unchanged, true);
  assert.equal(finalized.worker_deployment_id, afterDeploymentId);
  const receipt = await readJson(finalized.receipt_path);
  assert.equal(receipt.kind, "cfkanban_instance_upgrade_receipt");
  assert.equal(receipt.service_release.before.service_bundle_version, "0.1.0-alpha.8");
  assert.equal(receipt.service_release.after.service_bundle_version, "0.1.0-alpha.19");
  assert.equal(receipt.cloudflare.worker.after_version_id, afterVersionId);
  assert.equal(receipt.owner.credential_id, CREDENTIAL_ID);
  assert.equal(JSON.stringify(receipt).includes(secret.token), false);
  assert.equal((await readJson(paths.currentMetadata)).credential_id, CREDENTIAL_ID);
  const resumed = await finalizeInstanceUpgrade(finalizeInput);
  assert.equal(resumed.resumed, true);
  const journal = await readJson(path.join(paths.journalsRoot, `${OPERATION_ID}.json`));
  assert.equal(journal.events.filter((event) => event.type === "upgrade_finalized").length, 1);
});

test("scope resolution prefers explicit, then Repo, then warned aggregate", () => {
  const explicit = [{ instance_id: INSTANCE_ID, workspace_key: "team", project_key: "APP" }];
  const repository = [{ instance_id: INSTANCE_ID, workspace_key: "team", project_key: "OPS" }];
  assert.equal(resolveScope({ explicitTargets: explicit, repoTargets: repository }).resolved_scope[0].project_key, "APP");
  assert.equal(resolveScope({ repoTargets: repository }).resolved_scope[0].project_key, "OPS");
  const expanded = resolveScope();
  assert.equal(expanded.source, "unfiltered");
  assert.equal(expanded.warnings[0].code, "SCOPE_EXPANDED_TO_AUTHORIZED_AGGREGATE");
  assert.deepEqual(validateScopeDocument({ schema_version: 1, targets: [...explicit, ...explicit] }).targets, explicit);
});

test("trusted origin rebind sends no Credential and requires old-to-new cross-check", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, options });
    const origin = url.origin;
    const preferred = "https://new.example.test";
    return new Response(JSON.stringify({
      discovery_version: 1,
      instance_id: INSTANCE_ID,
      service_version: "0.1.1",
      observed_origin: origin,
      preferred_api_origin: preferred,
      origin_version: 2,
      updated_at: new Date().toISOString(),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await checkTrustedOriginRebind({ stateRoot, instanceId: INSTANCE_ID, fetchImpl });
  assert.equal(result.changed, true);
  assert.equal(result.trusted_api_origin, "https://new.example.test");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new Headers(call.options.headers).has("authorization"), false);
    assert.equal(call.options.redirect, "manual");
  }
});

test("failed origin cross-check preserves the old trusted origin", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fetchImpl = async (url) => new Response(JSON.stringify({
    discovery_version: 1,
    instance_id: url.origin.includes("new") ? OTHER_PRINCIPAL_ID : INSTANCE_ID,
    service_version: "0.1.1",
    observed_origin: url.origin,
    preferred_api_origin: "https://new.example.test",
    origin_version: 2,
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(checkTrustedOriginRebind({ stateRoot, instanceId: INSTANCE_ID, fetchImpl }), (error) => error.code === "DISCOVERY_CROSS_CHECK_FAILED");
  const current = await readJson(getInstancePaths({ stateRoot, instanceId: INSTANCE_ID }).instanceMetadata);
  assert.equal(current.trusted_api_origin, "https://old.example.test");
  assert.equal(current.origin_version, 1);
});

test("transport preserves Service envelopes and marks client-normalized Cloudflare failures", async () => {
  const service = await normalizeResponse(new Response(JSON.stringify({ code: "PROJECT_QUOTA_EXCEEDED", category: "quota", source: "cfkanban", retryable: false, recovery: "free_capacity_or_request_owner", details: {} }), { status: 409, headers: { "content-type": "application/json" } }));
  assert.equal(service.error.code, "PROJECT_QUOTA_EXCEEDED");
  assert.equal(service.error.details.normalized_by, undefined);
  const edge = await normalizeResponse(new Response("error code: 1027", { status: 429, headers: { "content-type": "text/html", "cf-ray": "ray-test", "retry-after": "12" } }));
  assert.equal(edge.error.source, "cloudflare_platform");
  assert.equal(edge.error.details.normalized_by, "client");
  assert.equal(edge.error.retry_after_seconds, 12);
  assert.equal(normalizeNetworkFailure(new TypeError("secret detail")).error.details.reason, "TypeError");
});

test("D1 exact-name readback returns one verified UUID without exposing account inventory", async () => {
  const calls = [];
  const databaseId = "77777777-7777-4777-8777-777777777777";
  const result = await readD1ResourceByName({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    accountId: "account-one",
    cloudflareProfile: "production",
    d1Name: "cfkanban-d1",
    environment: { PATH: "/usr/bin" },
    runner: async (executable, args, options) => {
      calls.push({ executable, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID, writeLogs: options.env.WRANGLER_WRITE_LOGS });
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify([
          { name: "unrelated-private-database", uuid: "66666666-6666-4666-8666-666666666666" },
          { name: "cfkanban-d1", uuid: databaseId },
        ]),
        stderr: "",
      };
    },
  });
  assert.deepEqual(calls, [{
    executable: "/opt/cfkanban/wrangler",
    args: ["d1", "list", "--json", "--profile", "production"],
    accountId: "account-one",
    writeLogs: "false",
  }]);
  assert.deepEqual(result, {
    status: "present",
    account_id: "account-one",
    profile: "production",
    d1_name: "cfkanban-d1",
    database_id: databaseId,
  });
  assert.equal(JSON.stringify(result).includes("unrelated-private-database"), false);

  const absent = await readD1ResourceByName({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    accountId: "account-one",
    d1Name: "cfkanban-d1",
    environment: {},
    runner: async () => ({ code: 0, signal: null, stdout: "[]", stderr: "" }),
  });
  assert.equal(absent.status, "absent");
  assert.equal(absent.database_id, null);

  await assert.rejects(
    readD1ResourceByName({
      wranglerExecutable: "/opt/cfkanban/wrangler",
      accountId: "account-one",
      d1Name: "cfkanban-d1",
      environment: {},
      runner: async () => ({ code: 0, signal: null, stdout: "not-json", stderr: "" }),
    }),
    (error) => error.code === "WRANGLER_D1_READBACK_INVALID",
  );
  await assert.rejects(
    readD1ResourceByName({
      wranglerExecutable: "/opt/cfkanban/wrangler",
      accountId: "account-one",
      d1Name: "cfkanban-d1",
      environment: {},
      runner: async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify([
          { name: "cfkanban-d1", uuid: databaseId },
          { name: "cfkanban-d1", uuid: "66666666-6666-4666-8666-666666666666" },
        ]),
        stderr: "",
      }),
    }),
    (error) => error.code === "WRANGLER_D1_READBACK_AMBIGUOUS",
  );
});

test("Worker exact-name readback distinguishes presence, absence, and unknown Cloudflare failures", async () => {
  const calls = [];
  const present = await readWorkerResourceByName({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    accountId: "account-one",
    cloudflareProfile: "production",
    workerName: "cfkanban-worker",
    environment: { PATH: "/usr/bin" },
    runner: async (executable, args, options) => {
      calls.push({ executable, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID, writeLogs: options.env.WRANGLER_WRITE_LOGS });
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          id: "66666666-6666-4666-8666-666666666666",
          created_on: "2026-09-04T00:00:00.000Z",
          source: "private-account-metadata",
          versions: [{ version_id: "77777777-7777-4777-8777-777777777777", percentage: 100 }],
        }),
        stderr: "",
      };
    },
  });
  assert.deepEqual(calls, [{
    executable: "/opt/cfkanban/wrangler",
    args: ["deployments", "status", "--name", "cfkanban-worker", "--json", "--profile", "production"],
    accountId: "account-one",
    writeLogs: "false",
  }]);
  assert.deepEqual(present, {
    status: "present",
    account_id: "account-one",
    profile: "production",
    worker_name: "cfkanban-worker",
    deployment_id: "66666666-6666-4666-8666-666666666666",
    version_id: "77777777-7777-4777-8777-777777777777",
    created_on: "2026-09-04T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(present).includes("private-account-metadata"), false);

  const absent = await readWorkerResourceByName({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    accountId: "account-one",
    workerName: "cfkanban-worker",
    environment: {},
    runner: async () => ({ code: 1, signal: null, stdout: "", stderr: "Cloudflare API error [code: 10007]" }),
  });
  assert.deepEqual(absent, {
    status: "absent",
    account_id: "account-one",
    profile: null,
    worker_name: "cfkanban-worker",
  });

  await assert.rejects(
    readWorkerResourceByName({
      wranglerExecutable: "/opt/cfkanban/wrangler",
      accountId: "account-one",
      workerName: "cfkanban-worker",
      environment: {},
      runner: async () => ({ code: 0, signal: null, stdout: "not-json", stderr: "" }),
    }),
    (error) => error.code === "WRANGLER_WORKER_READBACK_INVALID",
  );
  await assert.rejects(
    readWorkerResourceByName({
      wranglerExecutable: "/opt/cfkanban/wrangler",
      accountId: "account-one",
      workerName: "cfkanban-worker",
      environment: {},
      runner: async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify([{
          id: "66666666-6666-4666-8666-666666666666",
          created_on: "2026-09-04T00:00:00.000Z",
          versions: [{ version_id: "77777777-7777-4777-8777-777777777777", percentage: 100 }],
        }]),
        stderr: "",
      }),
    }),
    (error) => error.code === "WRANGLER_WORKER_READBACK_INVALID",
  );
  await assert.rejects(
    readWorkerResourceByName({
      wranglerExecutable: "/opt/cfkanban/wrangler",
      accountId: "account-one",
      workerName: "cfkanban-worker",
      environment: {},
      runner: async () => ({ code: 1, signal: null, stdout: "", stderr: "Cloudflare API error [code: 10000]" }),
    }),
    (error) => error.code === "WRANGLER_WORKER_READBACK_FAILED",
  );
});

test("Worker version and D1 restore-point readbacks return only normalized upgrade evidence", async () => {
  const version = await readWorkerVersionById({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    accountId: "account-one",
    cloudflareProfile: "production",
    workerName: "cfkanban-worker",
    versionId: "77777777-7777-4777-8777-777777777777",
    environment: {},
    runner: async () => ({
      code: 0,
      signal: null,
      stdout: JSON.stringify({
        id: "77777777-7777-4777-8777-777777777777",
        resources: {
          bindings: [
            { type: "assets", name: "ASSETS" },
            { type: "d1", name: "DB", database_id: "88888888-8888-4888-8888-888888888888" },
            { type: "plain_text", name: "RATE_LIMIT_INSTANCE_LIMIT", text: "300" },
            { type: "plain_text", name: "PRIVATE_VALUE", text: "must-not-leak" },
          ],
        },
      }),
      stderr: "",
    }),
  });
  assert.equal(version.version_id, "77777777-7777-4777-8777-777777777777");
  assert.deepEqual(version.bindings.find((entry) => entry.name === "PRIVATE_VALUE"), {
    type: "plain_text",
    name: "PRIVATE_VALUE",
    value_redacted: true,
  });
  assert.equal(JSON.stringify(version).includes("must-not-leak"), false);

  const restore = await readD1RestorePoint({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    accountId: "account-one",
    cloudflareProfile: "production",
    d1Name: "cfkanban-d1",
    environment: {},
    now: () => new Date("2026-09-04T01:02:03.000Z"),
    runner: async () => ({
      code: 0,
      signal: null,
      stdout: JSON.stringify({ bookmark: "0000001c-00000000-000050dc-example" }),
      stderr: "",
    }),
  });
  assert.deepEqual(restore, {
    status: "available",
    account_id: "account-one",
    profile: "production",
    d1_name: "cfkanban-d1",
    bookmark: "0000001c-00000000-000050dc-example",
    observed_at: "2026-09-04T01:02:03.000Z",
    retention_boundary: null,
    retention_boundary_source: "not_reported_by_wrangler",
    restore_overwrites_later_writes: true,
    restore_automatic: false,
  });
});

test("strict-zero plan freezes defaults; any delta requires new authorization", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const baseInput = {
    taskId: "task-wp10",
    accountId: "account-one",
    cloudflareProfile: "production",
    ownerDisplayName: "Example Owner",
    release: { manifest_version: "0.1.0", manifest_sha256: "a".repeat(64), service_bundle_version: "0.1.0", service_bundle_sha256: "b".repeat(64) },
    instanceId: INSTANCE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    ownerCredentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
  };
  const { plan, plan_digest: digest } = createStrictZeroPlan(baseInput);
  assert.deepEqual(plan.bindings.rate_limits, { principal: { limit: 120, period_seconds: 60 }, instance: { limit: 300, period_seconds: 60 }, unauthenticated_sensitive: { limit: 30, period_seconds: 60 } });
  assert.equal(plan.resources.pages, false);
  assert.equal(plan.target.cloudflare_profile, "production");
  assert.equal(plan.target.cloudflare_auth_context_directory, null);
  assert.equal(plan.resources.custom_domain, null);
  assert.equal(plan.migrations.checksum_ledger_table, "cfkanban_migration_ledger");
  assert.equal(plan.steps.includes("read_migration_checksum_ledger_and_schema_again"), true);
  assert.deepEqual(plan.owner_bootstrap.recovery_authorization, {
    zero_state_retry_included_in_plan: true,
    separate_confirmation_per_attempt: false,
    requires_same_task_operation_plan_sql_and_credential: true,
  });
  const firstSkillInstall = createSkillUpdatePlan({
    taskId: "task-wp10",
    current: null,
    target: {
      version: TESTING_RELEASE_CONFIG.version,
      source: TESTING_RELEASE_CONFIG.canonicalBaseUrl,
      sha256: "a".repeat(64),
    },
    installRoot: "/safe/skill-releases",
  });
  assert.equal(firstSkillInstall.current, null);
  assert.equal(firstSkillInstall.target.kind, "skill_bundle");
  assert.equal(firstSkillInstall.install_root, "/safe/skill-releases");
  assert.equal(firstSkillInstall.cloudflare_writes, false);
  assert.equal(firstSkillInstall.d1_migrations, false);
  const upgrade = createInstanceUpgradePlan(upgradePlanInput());
  assert.equal(upgrade.kind, "deployed_instance_upgrade");
  assert.equal(upgrade.operation_id, OPERATION_ID);
  assert.equal(upgrade.target.instance_id, INSTANCE_ID);
  assert.equal(upgrade.target.cloudflare_account_id, "account-one");
  assert.equal(upgrade.resources.worker.create, false);
  assert.deepEqual(upgrade.resources.worker.current_bindings, upgradeBindingReadback());
  assert.equal(upgrade.resources.d1.create, false);
  assert.equal(upgrade.resources.d1.database_id, "88888888-8888-4888-8888-888888888888");
  assert.deepEqual(upgrade.migrations.ordered, []);
  assert.equal(upgrade.release.service_bundle_sha256, "d".repeat(64));
  assert.equal(upgrade.skill_update_included, false);
  assert.equal(upgrade.resource_replacement_allowed, false);
  assert.equal(upgrade.binding_changes_allowed, false);
  assert.equal(upgrade.d1_restore_automatic, false);
  assert.throws(
    () => createInstanceUpgradePlan(upgradePlanInput({
      resources: {
        ...upgradePlanInput().resources,
        worker: { ...upgradePlanInput().resources.worker, bindings: [] },
      },
    })),
    (error) => error.code === "UPGRADE_BINDING_DELTA_REQUIRES_SEPARATE_PLAN",
  );
  const migrationUpgradeInput = upgradePlanInput({
    target: {
      ...upgradePlanInput().target,
      schema_version: 2,
      compatibility: { ...upgradePlanInput().target.compatibility, schema_version: 2 },
    },
    migrations: [{
      sequence: 2,
      name: "0002_add_context.sql",
      sha256: "f".repeat(64),
      classification: "backward_compatible",
      destructive: false,
      reentry: "wrangler_file_ingestion_transaction",
      expected_artifacts: { tables: ["project_context"], indexes: [] },
    }],
    restorePoint: {
      required: true,
      verified: true,
      bookmark: "0000001c-00000000-000050dc-example",
      observed_at: "2026-09-04T01:02:03.000Z",
      retention_boundary: null,
      reason: "pre_migration_time_travel_bookmark",
    },
  });
  assert.throws(
    () => createInstanceUpgradePlan(migrationUpgradeInput),
    (error) => error.code === "RESTORE_POINT_RETENTION_REQUIRED",
  );
  const migrationUpgrade = createInstanceUpgradePlan({
    ...migrationUpgradeInput,
    restorePoint: { ...migrationUpgradeInput.restorePoint, retention_boundary: "verified_current_cloudflare_plan_boundary" },
  });
  assert.equal(migrationUpgrade.steps.includes("read_migration_checksum_ledger_and_schema_after_apply:2"), true);
  assert.throws(
    () => createInstanceUpgradePlan(upgradePlanInput({
      migrations: [{
        sequence: 2,
        name: "0002_break.sql",
        sha256: "f".repeat(64),
        classification: "destructive",
        destructive: true,
        reentry: "not_safe",
        expected_artifacts: { tables: [], indexes: [] },
      }],
    })),
    (error) => error.code === "DESTRUCTIVE_MIGRATION_REQUIRES_SEPARATE_PLAN",
  );
  const changed = structuredClone(plan);
  changed.resources.custom_domain = "kanban.example.test";
  assert.equal(comparePlans(plan, changed).requires_new_authorization, true);
  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: "task-wp10", planDigest: digest });
  const createD1Calls = [];
  const executed = await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: "task-wp10",
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "create_d1",
    runner: async (executable, args, options) => {
      createD1Calls.push({ executable, args, accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID });
      return { code: 0, signal: null, stdout: `created cfk_v1_demo_${"A".repeat(43)}`, stderr: "" };
    },
  });
  assert.equal(executed.command_succeeded, true);
  assert.equal(executed.stdout_summary.includes("cfk_v1_"), false);
  assert.deepEqual(createD1Calls, [{
    executable: "/opt/cfkanban/wrangler",
    args: ["d1", "create", "cfkanban-d1", "--profile", "production"],
    accountId: "account-one",
  }]);
  const contextDirectory = path.join(home, ".cfkanban");
  const contextPlan = createStrictZeroPlan({
    ...baseInput,
    cloudflareProfile: null,
    cloudflareAuthContextDirectory: contextDirectory,
  }).plan;
  assert.equal(contextPlan.target.cloudflare_auth_context_directory, contextDirectory);
  assert.deepEqual(
    buildWranglerInvocation({ action: "create_d1", plan: contextPlan, environment: {} }),
    ["d1", "create", "cfkanban-d1", "--cwd", contextDirectory],
  );
  assert.throws(
    () => createStrictZeroPlan({ ...baseInput, cloudflareAuthContextDirectory: contextDirectory }),
    (error) => error.code === "AMBIGUOUS_WRANGLER_AUTH_CONTEXT",
  );
  await assert.rejects(
    executeWranglerAction({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: "task-wp10", plan: changed, wranglerExecutable: "/opt/cfkanban/wrangler", action: "create_d1", runner: async () => ({ code: 0 }) }),
    (error) => error.code === "PLAN_NOT_AUTHORIZED",
  );
});

test("portable Service bundle produces a private frozen Wrangler config and dry-run action", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const serviceRoot = path.join(home, "service-bundle");
  await mkdir(path.join(serviceRoot, "dist"), { recursive: true });
  await mkdir(path.join(serviceRoot, "apps", "web", "dist"), { recursive: true });
  await mkdir(path.join(serviceRoot, "migrations"), { recursive: true });
  await mkdir(path.join(serviceRoot, "release", "deployment"), { recursive: true });
  await writeFile(path.join(serviceRoot, "dist", "index.js"), "export default {};\n", "utf8");
  await writeFile(path.join(serviceRoot, "apps", "web", "dist", "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(path.join(serviceRoot, "migrations", "0001_initial.sql"), "SELECT 1;\n", "utf8");
  const migrationReadbackPath = path.join(serviceRoot, "release", "deployment", "migration-readback.sql");
  const migrationReadbackSql = "SELECT sequence, name, sha256, classification, reentry, operation_id, applied_at FROM cfkanban_migration_ledger ORDER BY sequence; SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;\n";
  await writeFile(migrationReadbackPath, migrationReadbackSql, "utf8");
  await writeFile(path.join(serviceRoot, "wrangler-config-schema.json"), "{}\n", "utf8");
  await writeFile(path.join(serviceRoot, "wrangler.template.json"), JSON.stringify({
    compatibility_date: "2026-08-29",
    assets: {
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/healthz"],
    },
  }), "utf8");
  const plan = createStrictZeroPlan({
    taskId: "wp10-portable",
    accountId: "account-one",
    cloudflareProfile: "production",
    ownerDisplayName: "Example Owner",
    release: { manifest_version: "0.1.0", manifest_sha256: "a".repeat(64), service_bundle_version: "0.1.0", service_bundle_sha256: "b".repeat(64) },
    instanceId: INSTANCE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    ownerCredentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
  }).plan;
  const planDigest = canonicalDigest(plan);
  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: "wp10-portable", planDigest });
  const generated = await writeFrozenWranglerConfig({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: "wp10-portable",
    plan,
    serviceBundleRoot: serviceRoot,
    d1DatabaseId: "77777777-7777-4777-8777-777777777777",
  });
  const config = await readJson(generated.wrangler_config_path);
  assert.equal(config.name, "cfkanban-worker");
  assert.equal(config.account_id, "account-one");
  assert.equal(config.main, path.join(serviceRoot, "dist", "index.js"));
  assert.equal(config.assets.directory, path.join(serviceRoot, "apps", "web", "dist"));
  assert.equal(config.d1_databases[0].database_id, "77777777-7777-4777-8777-777777777777");
  assert.equal(config.d1_databases[0].migrations_dir, path.join(serviceRoot, "migrations"));
  assert.equal(generated.contains_secret, false);
  const accountProbe = buildWranglerAccountProbe({
    accountId: "account-one",
    cloudflareProfile: "production",
    environment: {},
  });
  assert.deepEqual(accountProbe.args, ["d1", "list", "--json", "--profile", "production"]);
  assert.deepEqual(accountProbe.env_overrides, { CLOUDFLARE_ACCOUNT_ID: "account-one" });
  const contextDirectory = path.join(home, ".cfkanban");
  const contextProbe = buildWranglerAccountProbe({
    accountId: "account-one",
    contextDirectory,
    environment: {},
  });
  assert.deepEqual(contextProbe.args, ["d1", "list", "--json", "--cwd", contextDirectory]);
  assert.throws(
    () => buildWranglerAccountProbe({
      accountId: "account-one",
      cloudflareProfile: "production",
      environment: { CLOUDFLARE_API_TOKEN: "must-not-shadow-profile" },
    }),
    (error) => error.code === "WRANGLER_PROFILE_SHADOWED_BY_ENV",
  );
  const accountReadbackCalls = [];
  const accountReadback = await readWranglerAccountAccess({
    wranglerExecutable: "/opt/cfkanban/wrangler",
    accountId: "account-one",
    contextDirectory,
    runner: async (executable, args, options) => {
      accountReadbackCalls.push({ executable, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID, writeLogs: options.env.WRANGLER_WRITE_LOGS });
      return { code: 0, signal: null, stdout: '[{"name":"must-not-leak"}]', stderr: "" };
    },
  });
  assert.equal(accountReadback.authenticated, true);
  assert.equal(accountReadback.account_id, "account-one");
  assert.equal(accountReadback.context_directory, contextDirectory);
  assert.equal(accountReadback.proof, "wrangler_d1_list");
  assert.equal(JSON.stringify(accountReadback).includes("must-not-leak"), false);
  assert.deepEqual(accountReadbackCalls, [{ executable: "/opt/cfkanban/wrangler", args: ["d1", "list", "--json", "--cwd", contextDirectory], accountId: "account-one", writeLogs: "false" }]);
  assert.deepEqual(
    buildWranglerInvocation({ action: "validate_worker_bundle", plan, configPath: generated.wrangler_config_path, environment: {} }),
    ["deploy", "--dry-run", "--config", generated.wrangler_config_path, "--profile", "production"],
  );
  const dryRun = await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: "wp10-portable",
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "validate_worker_bundle",
    configPath: generated.wrangler_config_path,
    runner: async () => ({ code: 0, signal: null, stdout: "dry run ok", stderr: "" }),
  });
  assert.equal(dryRun.command_succeeded, true);
  const migrationCalls = [];
  const migrationReadback = await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: "wp10-portable",
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "migration_ledger_readback",
    configPath: generated.wrangler_config_path,
    migrationReadbackSqlPath: migrationReadbackPath,
    runner: async (executable, args) => {
      migrationCalls.push({ executable, args });
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify([
          { success: true, results: [] },
          { success: true, results: [{ type: "table", name: "cfkanban_migration_ledger" }] },
        ]),
        stderr: "",
      };
    },
  });
  assert.deepEqual(migrationReadback.migration_readback.schema, { tables: ["cfkanban_migration_ledger"], indexes: [] });
  assert.equal(migrationReadback.stdout_summary, JSON.stringify({ result_sets: 2, ledger_rows: 0, schema_tables: 1, schema_indexes: 0 }));
  const readbackJournal = await readJson(path.join(stateRoot, "instances", INSTANCE_ID, "journals", `${OPERATION_ID}.json`));
  const readbackEvent = [...readbackJournal.events].reverse().find((event) => event.action === "migration_ledger_readback" && event.type === "command_finished");
  assert.deepEqual(readbackEvent.migration_readback, migrationReadback.migration_readback);
  assert.equal(JSON.stringify(readbackEvent).includes("sqlite_master"), false);
  assert.deepEqual(migrationCalls[0].args, [
    "d1", "execute", "cfkanban-d1", "--remote", "--command", migrationReadbackSql,
    "--config", generated.wrangler_config_path, "--json", "--profile", "production",
  ]);
  await assert.rejects(
    executeWranglerAction({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: "wp10-portable",
      plan,
      wranglerExecutable: "/opt/cfkanban/wrangler",
      action: "migration_ledger_readback",
      configPath: generated.wrangler_config_path,
      migrationReadbackSqlPath: path.join(serviceRoot, "migrations", "0001_initial.sql"),
      runner: async () => ({ code: 0, signal: null, stdout: "[]", stderr: "" }),
    }),
    (error) => error.code === "MIGRATION_READBACK_SOURCE_DRIFT",
  );
  config.name = "tampered-worker";
  await writeFile(generated.wrangler_config_path, `${JSON.stringify(config)}\n`, "utf8");
  await assert.rejects(
    executeWranglerAction({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: "wp10-portable",
      plan,
      wranglerExecutable: "/opt/cfkanban/wrangler",
      action: "validate_worker_bundle",
      configPath: generated.wrangler_config_path,
      runner: async () => ({ code: 0, signal: null, stdout: "", stderr: "" }),
    }),
    (error) => error.code === "WRANGLER_CONFIG_DRIFT",
  );
});

test("migration reconciliation requires both ledger checksum and schema artifacts", () => {
  const manifest = { manifest_version: 1, migrations: [{ sequence: 1, name: "0001.sql", sha256: "a".repeat(64), destructive: false, expected_artifacts: { tables: ["issues"], indexes: ["idx_issues"] } }] };
  assert.equal(reconcileMigrationState({ manifest, ledger: [{ sequence: 1, name: "0001.sql", sha256: "a".repeat(64) }], schema: { tables: ["issues"], indexes: ["idx_issues"] } }).migrations[0].state, "applied");
  assert.equal(reconcileMigrationState({ manifest, ledger: [{ sequence: 1, name: "0001.sql", sha256: "b".repeat(64) }], schema: { tables: ["issues"], indexes: ["idx_issues"] } }).safe_to_continue, false);
  assert.equal(reconcileMigrationState({ manifest, ledger: [{ sequence: 1, name: "0001.sql", sha256: "a".repeat(64) }], schema: { tables: ["issues"], indexes: [] } }).safe_to_continue, false);
  assert.equal(reconcileMigrationState({ manifest, ledger: [{ sequence: 1, name: "0001.sql", sha256: "a".repeat(64) }, { sequence: 2, name: "unknown.sql", sha256: "b".repeat(64) }], schema: { tables: ["issues"], indexes: ["idx_issues"] } }).safe_to_continue, false);
});

test("missing migration ledger recovery requires the same authorized journal, successful apply, and later exact readback", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const serviceRoot = path.join(home, "verified-service");
  const migrationsRoot = path.join(serviceRoot, "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  const migrationText = "CREATE TABLE issues (id TEXT PRIMARY KEY);\nCREATE INDEX idx_issues ON issues(id);\n";
  const migration = {
    sequence: 1,
    name: "0001_initial.sql",
    sha256: sha256Bytes(Buffer.from(migrationText, "utf8")),
    classification: "bootstrap",
    destructive: false,
    reentry: "wrangler_migration_ledger_only",
    expected_artifacts: { tables: ["issues"], indexes: ["idx_issues"] },
  };
  const manifestPath = path.join(migrationsRoot, "manifest.json");
  await writeFile(path.join(migrationsRoot, migration.name), migrationText, "utf8");
  await writeFile(manifestPath, `${JSON.stringify({ manifest_version: 1, schema_version: 1, migrations: [migration] }, null, 2)}\n`, "utf8");
  const plan = createStrictZeroPlan({
    taskId: "wp10-ledger-recovery",
    accountId: "account-one",
    ownerDisplayName: "Example Owner",
    release: { manifest_version: "0.1.0", manifest_sha256: "a".repeat(64), service_bundle_version: "0.1.0", service_bundle_sha256: "b".repeat(64) },
    instanceId: INSTANCE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    ownerCredentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
  }).plan;
  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: plan.task_id, planDigest: canonicalDigest(plan) });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "wrangler_config_written", service_bundle_root: serviceRoot },
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "apply_non_destructive_migrations", exit_code: 0 },
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "migration_ledger_readback", exit_code: 0, migration_readback: { ledger: [] } },
  });
  const malformed = await assessMigrationLedgerRecovery({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    migrationManifestPath: manifestPath,
  });
  assert.equal(malformed.safe_to_record_missing_checksum, false);
  assert.deepEqual(malformed.blockers, ["VERIFIED_MIGRATION_READBACK_REQUIRED"]);
  const missingLedgerReadback = {
    ledger: [],
    schema: { tables: ["issues"], indexes: ["idx_issues"] },
    result_set_count: 2,
  };
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "migration_ledger_readback", exit_code: 0, migration_readback: missingLedgerReadback },
  });

  const recovery = await assessMigrationLedgerRecovery({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    migrationManifestPath: manifestPath,
  });
  assert.equal(recovery.status, "same_authorized_journal_recovery");
  assert.equal(recovery.safe_to_record_missing_checksum, true);
  assert.deepEqual(recovery.migration, {
    sequence: 1,
    name: migration.name,
    sha256: migration.sha256,
    classification: migration.classification,
    reentry: migration.reentry,
  });

  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "record_migration_checksum", exit_code: 0 },
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "migration_ledger_readback", exit_code: 0, migration_readback: missingLedgerReadback },
  });
  const inconsistent = await assessMigrationLedgerRecovery({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    migrationManifestPath: manifestPath,
  });
  assert.equal(inconsistent.safe_to_record_missing_checksum, false);
  assert.equal(inconsistent.blockers.includes("SUCCESSFUL_LEDGER_WRITE_MISSING_FROM_READBACK"), true);
});

test("migration readback parser keeps only bounded ledger and schema facts", () => {
  const raw = JSON.stringify([
    {
      success: true,
      results: [{
        sequence: 1,
        name: "0001_initial.sql",
        sha256: "a".repeat(64),
        classification: "bootstrap",
        reentry: "safe_baseline",
        operation_id: OPERATION_ID,
        applied_at: 1_725_000_000_000,
      }],
    },
    {
      success: true,
      results: [
        { type: "index", name: "idx_issues_status", sql: "must not be returned" },
        { type: "table", name: "issues", sql: "must not be returned" },
      ],
    },
  ]);
  const parsed = parseMigrationReadbackOutput(raw);
  assert.deepEqual(parsed.schema, { tables: ["issues"], indexes: ["idx_issues_status"] });
  assert.equal(parsed.ledger[0].operation_id, OPERATION_ID);
  assert.equal(JSON.stringify(parsed).includes("must not be returned"), false);
  assert.throws(
    () => parseMigrationReadbackOutput(JSON.stringify([{ success: true, results: [] }])),
    (error) => error.code === "WRANGLER_MIGRATION_READBACK_INVALID",
  );
  assert.throws(
    () => parseMigrationReadbackOutput(JSON.stringify([
      { success: true, results: [] },
      { success: true, results: [{ type: "table", name: "issues" }, { type: "table", name: "issues" }] },
    ])),
    (error) => error.code === "WRANGLER_MIGRATION_READBACK_INVALID",
  );
});

test("Owner bootstrap recovery readback permits only a completely empty bootstrap state", () => {
  const sql = buildOwnerBootstrapReadbackSql();
  assert.match(sql, /COUNT\(\*\) FROM principals/u);
  assert.match(sql, /COUNT\(\*\) FROM operation_commits/u);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT)\b/iu);
  const emptyRow = {
    principals: 0,
    instance_meta: 0,
    instance_origin_settings: 0,
    credentials: 0,
    events: 0,
    operation_commits: 0,
  };
  const empty = parseOwnerBootstrapReadbackOutput(JSON.stringify([{ success: true, results: [emptyRow] }]));
  assert.equal(empty.state, "absent");
  assert.equal(empty.safe_to_retry, true);
  assert.deepEqual(empty.counts, emptyRow);

  const partial = parseOwnerBootstrapReadbackOutput(JSON.stringify([{
    success: true,
    results: [{ ...emptyRow, principals: 1 }],
  }]));
  assert.equal(partial.state, "present_or_partial");
  assert.equal(partial.safe_to_retry, false);
  assert.throws(
    () => parseOwnerBootstrapReadbackOutput(JSON.stringify([{ success: true, results: [{ ...emptyRow, credentials: -1 }] }])),
    (error) => error.code === "WRANGLER_OWNER_BOOTSTRAP_READBACK_INVALID",
  );
  assert.throws(
    () => parseOwnerBootstrapReadbackOutput(JSON.stringify([{ success: true, results: [{ ...emptyRow, credentials: null }] }])),
    (error) => error.code === "WRANGLER_OWNER_BOOTSTRAP_READBACK_INVALID",
  );
});

test("Owner bootstrap never retries after any present or partial recovery readback", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const plan = createStrictZeroPlan({
    taskId: "wp10-owner-partial",
    accountId: "account-one",
    ownerDisplayName: "Example Owner",
    release: { manifest_version: "0.1.0", manifest_sha256: "a".repeat(64), service_bundle_version: "0.1.0", service_bundle_sha256: "b".repeat(64) },
    instanceId: INSTANCE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    ownerCredentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
  }).plan;
  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: plan.task_id, planDigest: canonicalDigest(plan) });
  const paths = getInstancePaths({ stateRoot, instanceId: INSTANCE_ID });
  const configPath = path.join(paths.journalsRoot, `${OPERATION_ID}.wrangler.jsonc`);
  const config = { name: "cfkanban-worker", account_id: "account-one" };
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "wrangler_config_written", config_path: configPath, config_digest: canonicalDigest(config) },
  });
  const pending = await createPendingCredential({
    stateRoot,
    home,
    persistenceConfirmed: true,
    instanceId: INSTANCE_ID,
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    idempotencyKey: OPERATION_ID,
    operationId: OPERATION_ID,
    purpose: "owner_bootstrap",
  });
  const bootstrapSqlPath = path.join(paths.journalsRoot, `${OPERATION_ID}.owner-bootstrap.sql`);
  const bootstrapSql = "SELECT 1;\n";
  await writeFile(bootstrapSqlPath, bootstrapSql, { mode: 0o600 });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: {
      type: "owner_bootstrap_sql_written",
      bootstrap_sql_path: bootstrapSqlPath,
      bootstrap_sql_sha256: sha256Bytes(Buffer.from(bootstrapSql, "utf8")),
      credential_fingerprint: pending.fingerprint,
    },
  });
  await appendJournalEvent({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, event: { type: "command_started", action: "bootstrap_owner" } });
  await appendJournalEvent({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, event: { type: "command_finished", action: "bootstrap_owner", exit_code: 1 } });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "owner_bootstrap_readback", exit_code: 0, owner_bootstrap_readback: { state: "present_or_partial", safe_to_retry: false } },
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "owner_bootstrap_readback", exit_code: 0, owner_bootstrap_readback: { state: "absent", safe_to_retry: true } },
  });
  await assert.rejects(
    executeWranglerAction({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: plan.task_id,
      plan,
      wranglerExecutable: "/opt/cfkanban/wrangler",
      action: "bootstrap_owner",
      configPath,
      bootstrapSqlPath,
      runner: async () => ({ code: 0, signal: null, stdout: "", stderr: "" }),
    }),
    (error) => error.code === "OWNER_BOOTSTRAP_REMOTE_STATE_PRESENT",
  );
});

test("migration checksum SQL is fixed, same-journal authorized, and never overwrites", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const plan = createStrictZeroPlan({
    taskId: "wp10-ledger",
    accountId: "account-one",
    ownerDisplayName: "Example Owner",
    release: { manifest_version: "0.1.0", manifest_sha256: "a".repeat(64), service_bundle_version: "0.1.0", service_bundle_sha256: "b".repeat(64) },
    instanceId: INSTANCE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    ownerCredentialId: CREDENTIAL_ID,
    operationId: OPERATION_ID,
  }).plan;
  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: plan.task_id, planDigest: canonicalDigest(plan) });
  const serviceRoot = path.join(home, "service");
  const migrationsRoot = path.join(serviceRoot, "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  const migrationSql = "CREATE TABLE issues (id TEXT PRIMARY KEY);\n";
  const migration = {
    sequence: 1,
    name: "0001_initial.sql",
    sha256: sha256Bytes(Buffer.from(migrationSql, "utf8")),
    classification: "bootstrap",
    destructive: false,
    reentry: "safe_baseline",
    expected_artifacts: { tables: ["issues"], indexes: [] },
  };
  const manifestPath = path.join(migrationsRoot, "manifest.json");
  await writeFile(path.join(migrationsRoot, migration.name), migrationSql, "utf8");
  await writeFile(manifestPath, JSON.stringify({ manifest_version: 1, schema_version: 1, migrations: [migration] }) + "\n", "utf8");
  const configPath = path.join(home, "wrangler.jsonc");
  const config = { name: "cfkanban-worker", account_id: "account-one" };
  await writeFile(configPath, JSON.stringify(config) + "\n", { mode: 0o600 });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: {
      type: "wrangler_config_written",
      config_path: configPath,
      config_digest: canonicalDigest(config),
      service_bundle_root: serviceRoot,
    },
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: { type: "command_finished", action: "apply_non_destructive_migrations", exit_code: 0 },
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    event: {
      type: "command_finished",
      action: "migration_ledger_readback",
      exit_code: 0,
      migration_readback: { ledger: [], schema: { tables: ["issues"], indexes: [] }, result_set_count: 2 },
    },
  });
  const record = await writeMigrationLedgerRecordSql({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    migration,
    migrationManifestPath: manifestPath,
  });
  const sql = await readFile(record.migration_record_sql_path, "utf8");
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.doesNotMatch(sql, /UPDATE|REPLACE|ON CONFLICT/i);
  assert.doesNotMatch(sql, /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/iu);
  assert.equal(record.overwrites_existing_ledger_row, false);
  assert.equal(record.relies_on_wrangler_file_ingestion_transaction, true);
  assert.equal(record.resumed, false);
  assert.equal((await writeMigrationLedgerRecordSql({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    migration,
    migrationManifestPath: manifestPath,
  })).resumed, true);
  await assert.rejects(
    writeMigrationLedgerRecordSql({
      stateRoot,
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      taskId: plan.task_id,
      plan,
      migration,
      migrationManifestPath: manifestPath,
      outputPath: path.join(home, "unbound.sql"),
    }),
    (error) => error.code === "MIGRATION_RECORD_OUTPUT_DRIFT",
  );

  const ledgerSchemaPath = path.resolve("release/deployment/migration-ledger.sql");
  const readbackPath = path.resolve("release/deployment/migration-readback.sql");
  const readbackSql = await readFile(readbackPath, "utf8");
  assert.doesNotMatch(readbackSql, /tbl_name|\bsql\b/iu);
  assert.deepEqual(
    buildWranglerInvocation({ action: "initialize_migration_checksum_ledger", plan, configPath, migrationLedgerSchemaSqlPath: ledgerSchemaPath }),
    ["d1", "execute", "cfkanban-d1", "--remote", "--file", ledgerSchemaPath, "--config", configPath, "--json"],
  );
  assert.deepEqual(
    buildWranglerInvocation({ action: "migration_ledger_readback", plan, configPath, migrationReadbackSql: readbackSql }),
    ["d1", "execute", "cfkanban-d1", "--remote", "--command", readbackSql, "--config", configPath, "--json"],
  );
  assert.deepEqual(
    buildWranglerInvocation({ action: "record_migration_checksum", plan, configPath, migrationRecordSqlPath: record.migration_record_sql_path }),
    ["d1", "execute", "cfkanban-d1", "--remote", "--file", record.migration_record_sql_path, "--config", configPath, "--json"],
  );
  await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: plan.task_id,
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "record_migration_checksum",
    migrationName: migration.name,
    configPath,
    migrationRecordSqlPath: record.migration_record_sql_path,
    runner: async () => ({ code: 0, signal: null, stdout: "[]", stderr: "" }),
  });
  const bootstrapSqlPath = path.join(home, "owner-bootstrap.sql");
  assert.deepEqual(
    buildWranglerInvocation({ action: "bootstrap_owner", plan, configPath, bootstrapSqlPath }),
    ["d1", "execute", "cfkanban-d1", "--remote", "--file", bootstrapSqlPath, "--config", configPath],
  );
});

test("release metadata pins two artifacts, localized documents, and installable deterministic Skill ZIP", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cfkanban-wp10-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await mkdir(source);
  await mkdir(output);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n", "utf8");
  const skillBundle = path.join(output, "skills.zip");
  const serviceBundle = path.join(output, "service.zip");
  await writeDeterministicZip({ root: source, outputPath: skillBundle, prefix: "bundle/" });
  await writeDeterministicZip({ root: source, outputPath: serviceBundle, prefix: "service/" });
  const generated = await generateReleaseMetadata({
    outputDirectory: output,
    canonicalBaseUrl: "https://releases.example.test/cfkanban/",
    version: "0.1.0",
    skillBundlePath: skillBundle,
    serviceBundlePath: serviceBundle,
    nodeRange: TESTING_RELEASE_CONFIG.nodeRange,
    wranglerRange: ">=4.127.1 <5",
    serviceApiRange: ">=0.1.0 <0.2.0",
    schemaVersion: 1,
  });
  assert.equal(generated.manifest.artifacts.length, 2);
  assert.equal(generated.pointer.channel, "stable");
  assert.equal(generated.manifest.documents["zh-CN"].endsWith("install.zh-CN.md"), true);
  assert.equal(generated.stable.manifest_sha256, sha256Bytes(await readFile(generated.manifestPath)));
  const installHome = path.join(root, "install");
  const installed = await installVerifiedSkillBundle({ bundlePath: skillBundle, version: "0.1.0", expectedSha256: sha256Bytes(await readFile(skillBundle)), publisher: "https://releases.example.test", source: generated.manifest.artifacts[0].url, releaseRoot: installHome });
  assert.equal(installed.installed, true);
  assert.equal((await readJson(path.join(installHome, "active.json"))).version, "0.1.0");
  const installedReceipt = await readJson(path.join(installed.release_path, ".cfkanban-release.json"));
  assert.deepEqual(installedReceipt.artifact_origins, ["https://releases.example.test"]);
  assert.deepEqual(verifyPublisherContinuity({ currentReceipt: installedReceipt, targetManifest: generated.manifest }), {
    continuous: true,
    first_install: false,
    requires_explicit_rebind: false,
    before: {
      publisher: "https://releases.example.test",
      artifact_origins: ["https://releases.example.test"],
    },
    after: {
      publisher: "https://releases.example.test",
      artifact_origins: ["https://releases.example.test"],
    },
  });
  const legacyReceipt = { ...installedReceipt };
  delete legacyReceipt.artifact_origins;
  assert.equal(verifyPublisherContinuity({ currentReceipt: legacyReceipt, targetManifest: generated.manifest }).continuous, true);
  assert.equal(verifyPublisherContinuity({
    currentReceipt: { ...installedReceipt, publisher: { canonical_origin: "https://releases.example.test" } },
    targetManifest: generated.manifest,
  }).continuous, true);
  assert.equal(verifyPublisherContinuity({
    currentReceipt: { ...installedReceipt, publisher: "https://other.example.test" },
    targetManifest: generated.manifest,
  }).continuous, false);
  assert.equal(verifyPublisherContinuity({
    currentReceipt: { ...installedReceipt, artifact_origins: ["https://other.example.test"] },
    targetManifest: generated.manifest,
  }).continuous, false);
  assert.equal(verifyPublisherContinuity({
    currentReceipt: { ...legacyReceipt, source: "https://other.example.test/cfkanban-skills.zip" },
    targetManifest: generated.manifest,
  }).continuous, false);
  assert.throws(
    () => verifyPublisherContinuity({ currentReceipt: { ...legacyReceipt, source: "http://releases.example.test/cfkanban-skills.zip" }, targetManifest: generated.manifest }),
    (error) => error.code === "INVALID_RELEASE_RECEIPT",
  );

  const prereleaseOutput = path.join(root, "prerelease-output");
  await mkdir(prereleaseOutput);
  const prerelease = await generateReleaseMetadata({
    outputDirectory: prereleaseOutput,
    canonicalBaseUrl: TESTING_RELEASE_CONFIG.canonicalBaseUrl,
    version: TESTING_RELEASE_CONFIG.version,
    channel: TESTING_RELEASE_CONFIG.channel,
    urlLayout: TESTING_RELEASE_CONFIG.urlLayout,
    skillBundlePath: skillBundle,
    serviceBundlePath: serviceBundle,
    nodeRange: TESTING_RELEASE_CONFIG.nodeRange,
    wranglerRange: TESTING_RELEASE_CONFIG.wranglerRange,
    serviceApiRange: TESTING_RELEASE_CONFIG.serviceApiRange,
    schemaVersion: TESTING_RELEASE_CONFIG.schemaVersion,
  });
  assert.equal(path.basename(prerelease.pointerPath), "prerelease.json");
  assert.equal(prerelease.pointer.channel, "prerelease");
  assert.equal(prerelease.stable, null);
  assert.equal(prerelease.manifest.compatibility.node, TESTING_RELEASE_CONFIG.nodeRange);
  assert.equal(prerelease.pointer.manifest_url, `https://github.com/breakstring/cfKanban/releases/download/${TESTING_RELEASE_CONFIG.version}/cfkanban-release-${TESTING_RELEASE_CONFIG.version}.json`);
  assert.equal(prerelease.manifest.artifacts.every((artifact) => !artifact.url.includes("/artifacts/")), true);
  const verifiedPrerelease = await dispatch("release verify", {
    releasePointerPath: prerelease.pointerPath,
    manifestPath: prerelease.manifestPath,
    artifactFiles: {
      skill_bundle: path.join(prereleaseOutput, "artifacts", path.basename(skillBundle)),
      service_deployment_bundle: path.join(prereleaseOutput, "artifacts", path.basename(serviceBundle)),
    },
  }, { surface: "deploy" });
  assert.equal(verifiedPrerelease.pointer.channel, "prerelease");
  assert.equal(verifiedPrerelease.verified, true);
});

test("plugin and Skill metadata stay English where localization is unsupported, while documents are paired", async () => {
  const plugin = JSON.parse(await readFile(new URL("../../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(plugin.name, "cfkanban-agent-skills");
  assert.equal(plugin.version, TESTING_RELEASE_CONFIG.version);
  assert.equal(/[\u3400-\u9fff]/u.test(JSON.stringify(plugin)), false);
  for (const skill of ["cfkanban", "cfkanban-admin", "cfkanban-deploy"]) {
    const yaml = await readFile(new URL(`../../skills/${skill}/agents/openai.yaml`, import.meta.url), "utf8");
    assert.equal(/[\u3400-\u9fff]/u.test(yaml), false);
  }
  for (const pair of [
    ["../../docs/skills/README.md", "../../docs/skills/README.zh-CN.md"],
    ["../../release/bootstrap/install.md", "../../release/bootstrap/install.zh-CN.md"],
    ["../../skills/cfkanban/references/workflows.md", "../../skills/cfkanban/references/workflows.zh-CN.md"],
    ["../../skills/cfkanban-admin/references/owner-workflows.md", "../../skills/cfkanban-admin/references/owner-workflows.zh-CN.md"],
    ["../../skills/cfkanban-deploy/references/deployment-workflows.md", "../../skills/cfkanban-deploy/references/deployment-workflows.zh-CN.md"],
  ]) {
    await Promise.all(pair.map((entry) => stat(new URL(entry, import.meta.url))));
  }
  const releaseNotes = await readFile(new URL(`../../release/notes/${TESTING_RELEASE_CONFIG.version}.md`, import.meta.url), "utf8");
  assert.match(releaseNotes, /## English/u);
  assert.match(releaseNotes, /## 简体中文/u);
});

test("user-facing entrypoints use short intent-first prompts while Skills retain the safety workflow", async () => {
  const [readmeEn, readmeZh, skillsEn, skillsZh, daily, admin, deploy, dailyYaml, adminYaml, deployYaml] = await Promise.all([
    readFile(new URL("../../README.md", import.meta.url), "utf8"),
    readFile(new URL("../../README.zh-CN.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/skills/README.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/skills/README.zh-CN.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-admin/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-deploy/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban/agents/openai.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-admin/agents/openai.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-deploy/agents/openai.yaml", import.meta.url), "utf8"),
  ]);
  const installCommand = `codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref ${TESTING_RELEASE_CONFIG.version}`;
  for (const source of [readmeEn, readmeZh, skillsEn, skillsZh]) {
    assert.match(source, new RegExp(installCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(source, /codex plugin add cfkanban-agent-skills@cfkanban/u);
  }
  assert.match(readmeEn, /public testing preview/u);
  assert.match(readmeZh, /公开测试预览版/u);
  assert.match(skillsEn, /complete plugin\/bundle/u);
  assert.match(skillsZh, /完整 plugin\/bundle/u);
  assert.match(readmeEn, /> Use `\$cfkanban-deploy` to deploy cfKanban for me\./u);
  assert.match(readmeZh, /> 请使用 `\$cfkanban-deploy` 为我部署一套 cfKanban。/u);
  assert.match(readmeEn, /> Use `\$cfkanban-admin` to create my first cfKanban board\./u);
  assert.match(readmeZh, /> 请使用 `\$cfkanban-admin` 创建我的第一个 cfKanban 看板。/u);
  assert.match(readmeEn, /> Use `\$cfkanban` to join this Project:/u);
  assert.match(readmeZh, /> 请使用 `\$cfkanban` 加入这个 Project：/u);
  assert.doesNotMatch(readmeEn, /Run only the read-only capability and release checks first/u);
  assert.doesNotMatch(readmeZh, /先只执行只读的 capability 和 release 检查/u);
  assert.doesNotMatch(readmeEn, /complete strict-zero plan/u);
  assert.doesNotMatch(readmeZh, /完整的 strict-zero 计划/u);
  assert.match(daily, /First-use workflow for an invited participant/u);
  assert.match(admin, /First-use workflow after deployment/u);
  assert.match(deploy, /Choose the deployment source first/u);
  assert.match(deploy, /owner_bootstrap_readback/u);
  assert.match(deploy, /Do not phrase the authorization as a one-command or one-attempt approval/u);
  for (const skill of [daily, admin, deploy]) assert.match(skill, /Intent-first user experience/u);
  assert.match(dailyYaml, /Use \$cfkanban to help me work in this cfKanban Project\./u);
  assert.match(adminYaml, /Use \$cfkanban-admin to create my first cfKanban board\./u);
  assert.match(deployYaml, /Use \$cfkanban-deploy to deploy cfKanban for me\./u);
});

test("admin Skill canonicalizes user-chosen Workspace and Project key casing before creation", async () => {
  const [admin, workflowEn, workflowZh] = await Promise.all([
    readFile(new URL("../../skills/cfkanban-admin/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-admin/references/owner-workflows.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-admin/references/owner-workflows.zh-CN.md", import.meta.url), "utf8"),
  ]);
  for (const source of [admin, workflowEn]) {
    assert.match(source, /Workspace key[^\n]*lowercase/u);
    assert.match(source, /Project key[^\n]*uppercase/u);
    assert.match(source, /\[a-z\]\[a-z0-9-\]\{1,31\}/u);
    assert.match(source, /\[A-Z\]\[A-Z0-9-\]\{1,15\}/u);
  }
  assert.match(workflowZh, /Workspace key[^\n]*规范为小写/u);
  assert.match(workflowZh, /Project key[^\n]*规范为大写/u);
  for (const source of [admin, workflowEn, workflowZh]) {
    assert.match(source, /canonical|不可变/u);
    assert.match(source, /retype|重新输入/u);
  }
});

test("deployment Skill directly documents the deterministic Cloudflare authentication boundary", async () => {
  const [deploy, workflowEn, workflowZh] = await Promise.all([
    readFile(new URL("../../skills/cfkanban-deploy/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-deploy/references/deployment-workflows.md", import.meta.url), "utf8"),
    readFile(new URL("../../skills/cfkanban-deploy/references/deployment-workflows.zh-CN.md", import.meta.url), "utf8"),
  ]);
  for (const source of [deploy, workflowEn, workflowZh]) {
    assert.match(source, /runtime resolve-cloudflare-auth/u);
    assert.match(source, /runtime inspect-cloudflare-auth/u);
    assert.match(source, /runtime plan-cloudflare-auth/u);
    assert.match(source, /runtime cloudflare-auth-action/u);
    assert.match(source, /account:read/u);
    assert.match(source, /user:read/u);
    assert.match(source, /workers_scripts:write/u);
    assert.match(source, /d1:write/u);
    assert.match(source, /auth create <name>/u);
    assert.match(source, /login --profile/u);
    assert.match(source, /migrations assess-ledger-recovery/u);
    assert.match(source, /owner_bootstrap_readback/u);
  }
  assert.match(deploy, /never enumerate profiles/u);
  assert.doesNotMatch(deploy, /profile_selection_required/u);
  assert.match(workflowEn, /never enumerates profiles/u);
  assert.match(workflowZh, /不会枚举 profiles/u);
  assert.match(deploy, /global to every Wrangler profile for the current OS user/u);
  assert.match(workflowEn, /global for every Wrangler profile owned by the current OS user/u);
  assert.match(workflowZh, /当前 OS 用户拥有的所有 Wrangler profiles/u);
  assert.match(workflowEn, /login alone creates no Worker, D1/u);
  assert.match(workflowZh, /登录本身不会创建 Worker、D1/u);
  for (const source of [deploy, workflowEn, workflowZh]) {
    assert.match(source, /runtime resolve-wrangler/u);
    assert.match(source, /PATH/u);
    assert.match(source, /installed_tool_runtime/u);
  }
  assert.match(deploy, /Always run `runtime resolve-wrangler`/u);
  assert.match(workflowEn, /Always invoke `runtime resolve-wrangler`/u);
  assert.match(workflowZh, /必须使用 manifest 的准确兼容范围调用 `runtime resolve-wrangler`/u);
});

test("public Agent-facing documents avoid the internal stage label", async () => {
  const publicDocuments = [
    "../../README.md",
    "../../README.zh-CN.md",
    "../../docs/skills/README.md",
    "../../docs/skills/README.zh-CN.md",
    "../../release/bootstrap/install.md",
    "../../release/bootstrap/install.zh-CN.md",
    "../../release/bootstrap/prerelease.schema.json",
    "../../release/notes/0.1.0-alpha.1.md",
    "../../release/notes/0.1.0-alpha.2.md",
    "../../release/notes/0.1.0-alpha.3.md",
    "../../release/notes/0.1.0-alpha.4.md",
    "../../release/notes/0.1.0-alpha.5.md",
    "../../release/notes/0.1.0-alpha.6.md",
    "../../release/notes/0.1.0-alpha.7.md",
    "../../release/notes/0.1.0-alpha.8.md",
    "../../release/notes/0.1.0-alpha.9.md",
    "../../release/notes/0.1.0-alpha.10.md",
    "../../release/notes/0.1.0-alpha.11.md",
    "../../release/notes/0.1.0-alpha.12.md",
    "../../release/notes/0.1.0-alpha.13.md",
    "../../release/notes/0.1.0-alpha.14.md",
    "../../release/notes/0.1.0-alpha.15.md",
    "../../release/notes/0.1.0-alpha.16.md",
    "../../release/notes/0.1.0-alpha.17.md",
    "../../release/notes/0.1.0-alpha.18.md",
    "../../release/notes/0.1.0-alpha.19.md",
    "../../release/notes/0.1.0-alpha.20.md",
    "../../release/notes/0.1.0-alpha.21.md",
    "../../release/config/0.1.0-alpha.2.json",
    "../../release/config/0.1.0-alpha.3.json",
    "../../release/config/0.1.0-alpha.4.json",
    "../../release/config/0.1.0-alpha.5.json",
    "../../release/config/0.1.0-alpha.6.json",
    "../../release/config/0.1.0-alpha.7.json",
    "../../release/config/0.1.0-alpha.8.json",
    "../../release/config/0.1.0-alpha.9.json",
    "../../release/config/0.1.0-alpha.10.json",
    "../../release/config/0.1.0-alpha.11.json",
    "../../release/config/0.1.0-alpha.12.json",
    "../../release/config/0.1.0-alpha.13.json",
    "../../release/config/0.1.0-alpha.14.json",
    "../../release/config/0.1.0-alpha.15.json",
    "../../release/config/0.1.0-alpha.16.json",
    "../../release/config/0.1.0-alpha.17.json",
    "../../release/config/0.1.0-alpha.18.json",
    "../../release/config/0.1.0-alpha.19.json",
    "../../release/config/0.1.0-alpha.20.json",
    "../../release/config/0.1.0-alpha.21.json",
    "../../.codex-plugin/plugin.json",
    "../../.agents/plugins/marketplace.json",
    "../../skills/cfkanban/SKILL.md",
    "../../skills/cfkanban/agents/openai.yaml",
    "../../skills/cfkanban/references/workflows.md",
    "../../skills/cfkanban/references/workflows.zh-CN.md",
    "../../skills/cfkanban-admin/SKILL.md",
    "../../skills/cfkanban-admin/agents/openai.yaml",
    "../../skills/cfkanban-admin/references/owner-workflows.md",
    "../../skills/cfkanban-admin/references/owner-workflows.zh-CN.md",
    "../../skills/cfkanban-deploy/SKILL.md",
    "../../skills/cfkanban-deploy/agents/openai.yaml",
    "../../skills/cfkanban-deploy/references/deployment-workflows.md",
    "../../skills/cfkanban-deploy/references/deployment-workflows.zh-CN.md",
  ];
  for (const entry of publicDocuments) {
    const source = await readFile(new URL(entry, import.meta.url), "utf8");
    const visibleText = source.replace(/\]\([^)]+\)/g, "]()");
    assert.doesNotMatch(visibleText, /\bv0\b/i, entry);
  }
});
