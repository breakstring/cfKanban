import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCapabilityReport } from "../../packages/skill-runtime/src/capabilities.mjs";
import { writeOwnerBootstrapSql } from "../../packages/skill-runtime/src/bootstrap-sql.mjs";
import { dispatch, getCommandCatalog } from "../../packages/skill-runtime/src/cli.mjs";
import { redeemInvitation, rotateOwnerCredential } from "../../packages/skill-runtime/src/credential-operations.mjs";
import { buildWranglerAccountProbe, buildWranglerInvocation, executeWranglerAction, readWranglerAccountAccess } from "../../packages/skill-runtime/src/deploy.mjs";
import { writeFrozenWranglerConfig } from "../../packages/skill-runtime/src/deployment-config.mjs";
import { authorizeJournal, createJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { reconcileMigrationState, writeMigrationLedgerRecordSql } from "../../packages/skill-runtime/src/migrations.mjs";
import { comparePlans, createInstanceUpgradePlan, createSkillUpdatePlan, createStrictZeroPlan } from "../../packages/skill-runtime/src/plan.mjs";
import { checkTrustedOriginRebind } from "../../packages/skill-runtime/src/rebind.mjs";
import { generateReleaseMetadata } from "../generate-release-metadata.mjs";
import { resolveScope, validateScopeDocument } from "../../packages/skill-runtime/src/scope.mjs";
import { installVerifiedSkillBundle } from "../../packages/skill-runtime/src/skill-update.mjs";
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
import { createToolRuntimePlan, satisfiesSimpleRange } from "../../packages/skill-runtime/src/tool-runtime.mjs";
import { canonicalDigest, readJson, sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";
import { writeDeterministicZip } from "../lib/deterministic-zip.mjs";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";

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
  assert.equal(names(deploy).includes("runtime wrangler-account-readback"), true);
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
      principal_id: PRINCIPAL_ID,
      credential: { id: CREDENTIAL_ID, fingerprint: pending.fingerprint },
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
  assert.equal(JSON.stringify(result).includes(secret.token), false);
  assert.equal((await loadCurrentCredentialSecret({ stateRoot, instanceId: INSTANCE_ID })).token, secret.token);
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
    operationId: OPERATION_ID,
    idempotencyKey: "owner-bootstrap",
  });
  const firstSecret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  await promotePendingCredential({ stateRoot, instanceId: INSTANCE_ID, principalId: PRINCIPAL_ID, fingerprint: first.fingerprint });

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
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, headers: new Headers(options.headers), body: options.body });
    if (url.pathname === "/api/v1/admin/owner-credentials/rotate") {
      return new Response(JSON.stringify({
        resource: { id: replacement.credential_id },
        event_cursor: "2",
        idempotent_replay: false,
        unsafe_echo_fixture: `${firstSecret.token}:${replacementSecret.token}`,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      principal_id: PRINCIPAL_ID,
      credential: { id: replacement.credential_id, fingerprint: replacement.fingerprint },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await rotateOwnerCredential({ stateRoot, instanceId: INSTANCE_ID, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${firstSecret.token}`);
  assert.equal(JSON.parse(calls[0].body).new_credential_token, replacementSecret.token);
  assert.equal(calls[0].headers.get("idempotency-key"), "owner-rotation");
  assert.equal(calls[1].headers.get("authorization"), `Bearer ${replacementSecret.token}`);
  assert.equal(result.credential.state, "current");
  assert.equal(JSON.stringify(result).includes(firstSecret.token), false);
  assert.equal(JSON.stringify(result).includes(replacementSecret.token), false);
  assert.equal((await loadCurrentCredentialSecret({ stateRoot, instanceId: INSTANCE_ID })).token, replacementSecret.token);
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
  const promoted = await promotePendingCredential({ stateRoot, instanceId: INSTANCE_ID, principalId: PRINCIPAL_ID, fingerprint: pending.fingerprint });
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

test("Owner bootstrap SQL contains only the Credential digest and prefix", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const pending = await createPendingCredential({ stateRoot, home, persistenceConfirmed: true, instanceId: INSTANCE_ID, principalId: PRINCIPAL_ID, credentialId: CREDENTIAL_ID, operationId: OPERATION_ID });
  const secret = await loadPendingCredentialSecret({ stateRoot, instanceId: INSTANCE_ID });
  const result = await writeOwnerBootstrapSql({
    stateRoot,
    instanceId: INSTANCE_ID,
    ownerDisplayName: "Example Owner",
    ownerPrincipalId: PRINCIPAL_ID,
    preferredApiOrigin: "https://example.workers.dev",
    serviceVersion: "0.1.0",
    schemaVersion: 1,
  });
  const sql = await readFile(result.bootstrap_sql_path, "utf8");
  assert.equal(sql.includes(secret.token), false);
  assert.equal(sql.includes(pending.token_digest), true);
  assert.equal(result.contains_plaintext_credential, false);
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
  assert.equal(plan.resources.custom_domain, null);
  assert.equal(plan.migrations.checksum_ledger_table, "cfkanban_migration_ledger");
  assert.equal(plan.steps.includes("read_migration_checksum_ledger_and_schema_again"), true);
  assert.equal(createSkillUpdatePlan({ taskId: "task-wp10", current: null, target: { version: "0.1.0" }, installRoot: "/safe" }).cloudflare_writes, false);
  assert.equal(createInstanceUpgradePlan({ taskId: "task-wp10", instanceId: INSTANCE_ID, current: {}, target: {}, migrations: [], restorePoint: {} }).skill_update_included, false);
  const changed = structuredClone(plan);
  changed.resources.custom_domain = "kanban.example.test";
  assert.equal(comparePlans(plan, changed).requires_new_authorization, true);
  await createJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, plan });
  await authorizeJournal({ stateRoot, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: "task-wp10", planDigest: digest });
  const executed = await executeWranglerAction({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    taskId: "task-wp10",
    plan,
    wranglerExecutable: "/opt/cfkanban/wrangler",
    action: "create_d1",
    runner: async () => ({ code: 0, signal: null, stdout: `created cfk_v1_demo_${"A".repeat(43)}`, stderr: "" }),
  });
  assert.equal(executed.command_succeeded, true);
  assert.equal(executed.stdout_summary.includes("cfk_v1_"), false);
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
  await writeFile(path.join(serviceRoot, "dist", "index.js"), "export default {};\n", "utf8");
  await writeFile(path.join(serviceRoot, "apps", "web", "dist", "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(path.join(serviceRoot, "migrations", "0001_initial.sql"), "SELECT 1;\n", "utf8");
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
    runner: async (executable, args, options) => {
      accountReadbackCalls.push({ executable, args, accountId: options.env.CLOUDFLARE_ACCOUNT_ID });
      return { code: 0, signal: null, stdout: '[{"name":"must-not-leak"}]', stderr: "" };
    },
  });
  assert.equal(accountReadback.authenticated, true);
  assert.equal(accountReadback.account_id, "account-one");
  assert.equal(accountReadback.proof, "wrangler_d1_list");
  assert.equal(JSON.stringify(accountReadback).includes("must-not-leak"), false);
  assert.deepEqual(accountReadbackCalls, [{ executable: "/opt/cfkanban/wrangler", args: ["d1", "list", "--json"], accountId: "account-one" }]);
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

test("migration ledger SQL is fixed in the Service bundle and checksum records never overwrite", async (t) => {
  const { home, stateRoot } = await fixtureState();
  t.after(() => rm(home, { recursive: true, force: true }));
  const record = await writeMigrationLedgerRecordSql({
    stateRoot,
    instanceId: INSTANCE_ID,
    operationId: OPERATION_ID,
    migration: { sequence: 1, name: "0001_initial.sql", sha256: "a".repeat(64), classification: "bootstrap", reentry: "safe_baseline" },
  });
  const sql = await readFile(record.migration_record_sql_path, "utf8");
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.doesNotMatch(sql, /UPDATE|REPLACE|ON CONFLICT/i);
  assert.equal(record.overwrites_existing_ledger_row, false);

  const configPath = path.join(home, "wrangler.jsonc");
  const ledgerSchemaPath = path.resolve("release/deployment/migration-ledger.sql");
  const readbackPath = path.resolve("release/deployment/migration-readback.sql");
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
  assert.deepEqual(
    buildWranglerInvocation({ action: "initialize_migration_checksum_ledger", plan, configPath, migrationLedgerSchemaSqlPath: ledgerSchemaPath }),
    ["d1", "execute", "cfkanban-d1", "--remote", "--file", ledgerSchemaPath, "--config", configPath, "--json"],
  );
  assert.deepEqual(
    buildWranglerInvocation({ action: "migration_ledger_readback", plan, configPath, migrationReadbackSqlPath: readbackPath }),
    ["d1", "execute", "cfkanban-d1", "--remote", "--file", readbackPath, "--config", configPath, "--json"],
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
    nodeRange: ">=22.12.0 <25",
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

  const prereleaseOutput = path.join(root, "prerelease-output");
  await mkdir(prereleaseOutput);
  const prerelease = await generateReleaseMetadata({
    outputDirectory: prereleaseOutput,
    canonicalBaseUrl: "https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.1/",
    version: "0.1.0-alpha.1",
    channel: "prerelease",
    urlLayout: "flat",
    skillBundlePath: skillBundle,
    serviceBundlePath: serviceBundle,
    nodeRange: ">=22.12.0 <25",
    wranglerRange: ">=4.127.1 <5",
    serviceApiRange: ">=0.1.0 <0.2.0",
    schemaVersion: 1,
  });
  assert.equal(path.basename(prerelease.pointerPath), "prerelease.json");
  assert.equal(prerelease.pointer.channel, "prerelease");
  assert.equal(prerelease.stable, null);
  assert.equal(prerelease.pointer.manifest_url, "https://github.com/breakstring/cfKanban/releases/download/0.1.0-alpha.1/cfkanban-release-0.1.0-alpha.1.json");
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
  const releaseNotes = await readFile(new URL("../../release/notes/0.1.0-alpha.1.md", import.meta.url), "utf8");
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
  const installCommand = "codex plugin marketplace add https://github.com/breakstring/cfKanban.git --ref 0.1.0-alpha.1";
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
  for (const skill of [daily, admin, deploy]) assert.match(skill, /Intent-first user experience/u);
  assert.match(dailyYaml, /Use \$cfkanban to help me work in this cfKanban Project\./u);
  assert.match(adminYaml, /Use \$cfkanban-admin to create my first cfKanban board\./u);
  assert.match(deployYaml, /Use \$cfkanban-deploy to deploy cfKanban for me\./u);
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
