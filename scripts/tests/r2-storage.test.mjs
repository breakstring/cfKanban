import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInstanceUpgradePlan } from "../../packages/skill-runtime/src/upgrade-plan.mjs";
import { executeWranglerAction } from "../../packages/skill-runtime/src/deploy.mjs";
import { readR2Storage, provisionR2Storage, verifyPlannedR2Storage, verifyPlannedAttachmentWorker, assertAttachmentStoragePlan } from "../../packages/skill-runtime/src/r2-storage.mjs";
import { createJournal, authorizeJournal, appendJournalEvent, assertJournalAuthorization } from "../../packages/skill-runtime/src/journal.mjs";
import { inspectCloudflareAuth, createCloudflareAuthPlan, executeCloudflareAuthAction } from "../../packages/skill-runtime/src/tool-runtime.mjs";
import { canonicalDigest, sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";
const INSTANCE_ID="11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID="22222222-2222-4222-8222-222222222222";
const CREDENTIAL_ID="44444444-4444-4444-8444-444444444444";
const OPERATION_ID="55555555-5555-4555-8555-555555555555";
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
      schema_version: 4,
    },
    target: {
      publisher: "https://github.com",
      manifest_version: "0.1.0-alpha.19",
      manifest_sha256: "c".repeat(64),
      service_bundle_version: "0.1.0-alpha.19",
      service_bundle_sha256: "d".repeat(64),
      service_bundle_source: "https://github.com/example/cfkanban-service-alpha.19.zip",
      service_api_version: "0.1.0",
      schema_version: 4,
      migration_manifest_sha256: "e".repeat(64),
      compatibility: {
        node: ">=22.12.0 <27",
        wrangler: ">=4.127.1 <5",
        service_api: ">=0.1.0 <0.2.0",
        schema_version: 4,
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

const bucketName = "cfkanban-test-attachments";
const marker = { kind: "cfkanban_attachment_storage", instance_id: INSTANCE_ID, bucket_name: bucketName, account_id: "account-one", operation_id: OPERATION_ID };
function mockCloudflare({ present = false, initialMarker = null, publicAccess = false, failCreateAfterCommit = false, failMarkerAfterCommit = false } = {}) {
  let exists = present; let storedMarker = initialMarker;
  const writes = [];
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.cloudflare.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    const suffix = new URL(url).pathname.split("/r2/buckets")[1];
    const json = (result, status = 200) => Response.json({ success: status === 200, result }, { status });
    if (options.method !== "GET") writes.push({ suffix, method: options.method });
    if (options.method === "POST") { exists = true; if (failCreateAfterCommit) throw new Error("secret fixture-token"); return json({ name: bucketName }); }
    if (!exists) return Response.json({ success: false, errors: [{ code: 10006 }] }, { status: 404 });
    if (suffix.endsWith("/domains/managed")) return json({ enabled: publicAccess });
    if (suffix.endsWith("/domains/custom")) return json({ domains: [] });
    if (suffix.endsWith("/objects/cfkanban-instance.json")) {
      if (options.method === "PUT") { storedMarker = JSON.parse(options.body); if (failMarkerAfterCommit) { failMarkerAfterCommit=false; throw new Error("uncertain"); } return new Response(null, { status: 200 }); }
      return storedMarker ? Response.json(storedMarker) : new Response(null, { status: 404 });
    }
    return json({ name: bucketName, storage_class: "Standard" });
  };
  return { fetchImpl, writes };
}
const connection = { accountId: "account-one", bucketName, environment: { CLOUDFLARE_API_TOKEN: "fixture-token" } };
async function fixture(t, extra = {}) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "cfkanban-r2-test-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const plan = createInstanceUpgradePlan(upgradePlanInput({ cloudflare: { ...upgradePlanInput().cloudflare, profile: null }, attachments: { bucket_name: bucketName, create: true }, ...extra }));
  const input = { stateRoot, plan, instanceId: INSTANCE_ID, operationId: OPERATION_ID, taskId: plan.task_id, environment: connection.environment };
  await createJournal(input);
  await authorizeJournal({ ...input, planDigest: canonicalDigest(plan) });
  return input;
}

test("strict-zero upgrade remains unchanged; enabling R2 declares cost and exact binding delta", () => {
  const normal = createInstanceUpgradePlan(upgradePlanInput());
  assert.equal(normal.resources.r2, false); assert.equal(normal.cost_delta, false);
  const enabled = createInstanceUpgradePlan(upgradePlanInput({ attachments: { bucket_name: bucketName, create: true } }));
  assert.equal(enabled.resources.r2.public_access, false); assert.equal(enabled.cost_delta, true);
  assert.equal(enabled.bindings.attachments, "ATTACHMENTS");
  assert.equal(enabled.attachment_storage.max_storage_bytes, 1073741824);
  assert.throws(() => createInstanceUpgradePlan(upgradePlanInput({ attachments: { bucket_name: bucketName, create: false } })), { code: "R2_RESOURCE_DELTA_REJECTED" });
});

test("an existing R2 binding is preserved, with no silent bucket replacement or removal", () => {
  const input = upgradePlanInput();
  input.resources.r2 = { bucket_name: bucketName, instance_id: INSTANCE_ID };
  input.resources.worker.bindings.push({ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: bucketName });
  const plan = createInstanceUpgradePlan(input);
  assert.equal(plan.resources.r2.bucket_name, bucketName); assert.equal(plan.resources.r2.create, false);
  assert.equal(plan.attachment_storage.previous_bucket, bucketName);
  assert.throws(() => createInstanceUpgradePlan({ ...input, attachments: { bucket_name: "some-other-bucket", create: true } }), { code: "R2_RESOURCE_DELTA_REJECTED" });
  delete input.resources.r2;
  assert.throws(() => createInstanceUpgradePlan(input), { code: "UPGRADE_BINDING_DELTA_REQUIRES_SEPARATE_PLAN" });
});

test("readback recognizes only exact absence, rejects public buckets and wrong ownership", async () => {
  assert.equal((await readR2Storage({ ...connection, ...mockCloudflare() })).status, "absent");
  await assert.rejects(readR2Storage({ ...connection, ...mockCloudflare({ present:true, publicAccess:true }) }), { code: "R2_PUBLIC_ACCESS_REJECTED" });
  await assert.rejects(readR2Storage({ ...connection, instanceId: INSTANCE_ID, ...mockCloudflare({ present:true }) }), { code: "R2_OWNERSHIP_REQUIRED" });
  const errorFetch = async () => Response.json({ errors:[{code:10000}] }, {status:403});
  await assert.rejects(readR2Storage({ ...connection, fetchImpl: errorFetch }), {code:"R2_CONTROL_FAILED"});
});

test("provision journals creation and marker; exact replay performs no extra writes", async (t) => {
  const input = await fixture(t); const cloud = mockCloudflare();
  const result = await provisionR2Storage({ ...input, ...cloud });
  assert.equal(result.instance_id, INSTANCE_ID); assert.equal(cloud.writes.length, 2);
  await provisionR2Storage({ ...input, ...cloud }); assert.equal(cloud.writes.length, 2);
});

test("unknown buckets cannot be adopted even with a matching remote marker", async (t) => {
  const input = await fixture(t); const cloud = mockCloudflare({present:true,initialMarker:marker});
  await assert.rejects(provisionR2Storage({ ...input, ...cloud }), {code:"R2_UNKNOWN_RESOURCE"});
  assert.equal(cloud.writes.length,0);
});

test("uncertain bucket creation stops instead of adopting a resource without local proof", async (t) => {
  const input=await fixture(t); const cloud=mockCloudflare({failCreateAfterCommit:true});
  await assert.rejects(provisionR2Storage({...input,...cloud}), {code:"R2_CONTROL_UNAVAILABLE"});
  await assert.rejects(provisionR2Storage({...input,...cloud}), {code:"R2_UNKNOWN_RESOURCE"});
  assert.equal(cloud.writes.length,1);
});

test("uncertain marker write recovers by readback without overwriting it", async (t) => {
  const input=await fixture(t); const cloud=mockCloudflare({failMarkerAfterCommit:true});
  await assert.rejects(provisionR2Storage({...input,...cloud}), {code:"R2_CONTROL_UNAVAILABLE"});
  const result=await provisionR2Storage({...input,...cloud});
  assert.equal(result.instance_id, INSTANCE_ID); assert.equal(cloud.writes.length,2);
});

test("auth errors do not expose tokens or raw child stderr", async () => {
  await assert.rejects(readR2Storage({accountId:"account-one",bucketName,wranglerExecutable:"/fixture/wrangler",cloudflareProfile:"cfkanban",environment:{},tokenRunner:async()=>{throw new Error("secret-token-and-email");}}), error => {
    assert.equal(error.code,"R2_AUTH_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(error),/secret-token-and-email/); return true;
  });
});

test("readback strips unknown marker fields and refuses malformed ownership", async () => {
  const result = await readR2Storage({ ...connection, ...mockCloudflare({ present: true, initialMarker: { ...marker, secret: "do-not-return" } }) });
  assert.deepEqual(result.marker, marker);
  assert.doesNotMatch(JSON.stringify(result), /do-not-return/);
  await assert.rejects(readR2Storage({ ...connection, ...mockCloudflare({ present: true, initialMarker: { ...marker, operation_id: "invalid" } }) }), { code: "R2_OWNERSHIP_REQUIRED" });
});

test("existing receipt-bound buckets without markers are never adopted", async (t) => {
  const resources = upgradePlanInput().resources;
  resources.r2 = { bucket_name: bucketName, instance_id: INSTANCE_ID };
  resources.worker.bindings.push({ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: bucketName });
  const input = await fixture(t, { resources, attachments: undefined });
  const currentReceiptPath = path.join(input.stateRoot, "receipt.json");
  await writeFile(currentReceiptPath, JSON.stringify({ kind: "cfkanban_instance_upgrade_receipt", instance: { id: INSTANCE_ID }, cloudflare: { account_id: "account-one", r2: resources.r2 } }));
  const missing = mockCloudflare({ present: true });
  await assert.rejects(provisionR2Storage({ ...input, currentReceiptPath, ...missing }), { code: "R2_OWNERSHIP_REQUIRED" });
  assert.equal(missing.writes.length, 0);
  const valid = mockCloudflare({ present: true, initialMarker: marker });
  assert.equal((await provisionR2Storage({ ...input, currentReceiptPath, ...valid })).instance_id, INSTANCE_ID);
  assert.equal(valid.writes.length, 0);
  const linked = path.join(input.stateRoot, "linked.json");
  await symlink(currentReceiptPath, linked);
  await assert.rejects(provisionR2Storage({ ...input, currentReceiptPath: linked, ...valid }), { code: "STATE_SYMLINK_REJECTED" });
  await assert.rejects(provisionR2Storage({ ...input, currentReceiptPath: path.join(input.stateRoot, "..", "external.json"), ...valid }), { code: "UNSAFE_STATE_PATH" });
});

test("predeploy storage and schedule evidence must be present and match the plan", async (t) => {
  const input = await fixture(t);
  await assert.rejects(verifyPlannedR2Storage({ ...input, ...mockCloudflare() }), { code: "R2_STORAGE_MISSING" });
  const schedules = (crons) => async (url, options) => {
    assert.match(url, /\/workers\/scripts\/cfkanban-worker\/schedules$/);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    return Response.json({ success: true, result: { schedules: crons.map((cron) => ({ cron, unrelated: "not-returned" })) } });
  };
  assert.equal((await verifyPlannedAttachmentWorker({ ...input, phase: "before", fetchImpl: schedules([]) })).binding_verified, false);
  await assert.rejects(verifyPlannedAttachmentWorker({ ...input, phase: "before", fetchImpl: schedules(["0 * * * *"]) }), { code: "R2_CLEANUP_SCHEDULE_DRIFT" });
  const version = { bindings: [{ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: bucketName }] };
  assert.deepEqual(await verifyPlannedAttachmentWorker({ ...input, phase: "after", version, fetchImpl: schedules(["17 * * * *"]) }), { bucket_name: bucketName, crons: ["17 * * * *"], binding_verified: true });
  await assert.rejects(verifyPlannedAttachmentWorker({ ...input, phase: "after", version, fetchImpl: schedules([]) }), { code: "R2_CLEANUP_SCHEDULE_DRIFT" });
  await assert.rejects(verifyPlannedAttachmentWorker({ ...input, phase: "after", version: { bindings: [] }, fetchImpl: schedules(["17 * * * *"]) }), { code: "R2_BINDING_DRIFT" });
  assert.throws(() => assertAttachmentStoragePlan({ ...input.plan, cost_delta: false }), { code: "R2_PLAN_REQUIRED" });
  assert.throws(() => assertAttachmentStoragePlan({ ...input.plan, bindings: { ...input.plan.bindings, cleanup_cron: "* * * * *" } }), { code: "R2_PLAN_REQUIRED" });
});

test("attachment deploy refuses changed live Worker identity or bindings before any deploy", async (t) => {
  const input = await fixture(t);
  const cloud = mockCloudflare();
  await provisionR2Storage({ ...input, ...cloud });
  const current = input.plan.resources.worker;
  let drift = "identity";
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push(args);
    assert.notEqual(args[0], "deploy");
    return { code: 0, stdout: JSON.stringify(args[0] === "deployments" ? { id: current.current_deployment_id, versions: [{ version_id: drift === "identity" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : current.current_version_id, percentage: 100 }], created_on: "2026-09-19T00:00:00Z" } : { id: current.current_version_id, resources: { bindings: [] } }), stderr: "" };
  };
  const action = { ...input, ...cloud, action: "deploy_worker_and_static_assets", wranglerExecutable: "/fixture/wrangler", runner };
  await assert.rejects(executeWranglerAction(action), { code: "UPGRADE_WORKER_DRIFT" });
  drift = "bindings";
  await assert.rejects(executeWranglerAction(action), { code: "UPGRADE_BINDING_DRIFT" });
  assert.equal(calls.length, 3);
  assert.equal(cloud.writes.length, 2);
});

test("postdeploy readback journals attachment proof only after binding, bucket, and Cron verification", async (t) => {
  const manifest = JSON.stringify({ manifest_version: 1, schema_version: 4, migrations: [] });
  const input = await fixture(t, { target: { ...upgradePlanInput().target, migration_manifest_sha256: sha256Bytes(Buffer.from(manifest)) } });
  const bundleRoot = path.join(input.stateRoot, "bundle");
  await mkdir(path.join(bundleRoot, "migrations"), { recursive: true });
  await writeFile(path.join(bundleRoot, "migrations", "manifest.json"), manifest);
  const configPath = path.join(input.stateRoot, "wrangler.jsonc");
  await writeFile(configPath, "{}");
  for (const event of [
    { type: "wrangler_config_written", config_path: configPath, config_digest: canonicalDigest({}), service_bundle_root: bundleRoot, service_bundle_artifact_sha256: input.plan.release.service_bundle_sha256 },
    { type: "command_finished", action: "migration_ledger_readback", exit_code: 0, migration_readback: { ledger: [], schema: { tables: [], indexes: [] } } },
    { type: "command_finished", action: "deploy_worker_and_static_assets", exit_code: 0 },
  ]) await appendJournalEvent({ ...input, event });
  const versionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let validBinding = false;
  const runner = async (_executable, args) => ({ code: 0, stderr: "", stdout: JSON.stringify(args[0] === "deployments"
    ? { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", versions: [{ version_id: versionId, percentage: 100 }], created_on: "2026-09-19T00:00:00Z" }
    : { id: versionId, resources: { bindings: [...upgradeBindingReadback(), ...(validBinding ? [{ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: bucketName }] : [])] } }) });
  const cloud = mockCloudflare({ present: true, initialMarker: marker });
  const fetchImpl = (url, options) => new URL(url).pathname.endsWith("/schedules") ? Response.json({ success: true, result: { schedules: [{ cron: "17 * * * *" }] } }) : cloud.fetchImpl(url, options);
  const action = { ...input, configPath, action: "worker_deployment_readback", wranglerExecutable: "/fixture/wrangler", runner, fetchImpl };
  await assert.rejects(executeWranglerAction(action), { code: "UPGRADE_BINDING_DRIFT" });
  const failed = await assertJournalAuthorization(input);
  assert.equal(failed.events.at(-1).worker_deployment_readback, undefined);
  validBinding = true;
  const result = await executeWranglerAction(action);
  assert.equal(result.worker_deployment_readback.version_id, versionId);
  assert.deepEqual(result.worker_deployment_readback.attachment_configuration, { bucket_name: bucketName, crons: ["17 * * * *"], binding_verified: true });
  assert.equal(cloud.writes.length, 0);
});

function authProbe({ workersScope = true, stderrScopes = false } = {}) {
  return async (_executable, args) => {
    const scopes = ["account:read", "user:read", "workers_scripts:write", "d1:write", ...(workersScope ? ["workers:write"] : [])].join("\n");
    const text = {
      "--version": "4.127.1",
      "auth create --help": "Create or re-authenticate a named auth profile",
      "auth keyring": "Keyring storage is enabled. persisted preference: enabled",
      "auth list": "cfkanban-test",
      "login --help": "--device --scopes",
      "login --scopes-list": stderrScopes ? "" : scopes,
    }[args.join(" ")];
    assert.notEqual(text, undefined);
    return { code: 0, stdout: text, stderr: stderrScopes && args.join(" ") === "login --scopes-list" ? scopes : "" };
  };
}

test("R2 OAuth scope expansion is explicit, disclosed, task-bound, and shell-free", async () => {
  const probe = { wranglerExecutable: "/fixture/wrangler", profileName: "cfkanban-test", environment: {}, platform: "darwin", runner: authProbe({ stderrScopes: true }) };
  const normal = await inspectCloudflareAuth(probe);
  assert.equal(normal.attachment_storage, false);
  assert.equal(normal.required_scopes_available.includes("workers:write"), false);
  const optional = await inspectCloudflareAuth({ ...probe, attachmentStorage: true });
  assert.equal(optional.safe_to_plan, true);
  assert.equal(optional.required_scopes_available.at(-1), "workers:write");
  assert.throws(() => createCloudflareAuthPlan({ taskId: "auth-test", preflight: normal, attachmentStorage: true, allowExistingProfile: true }), { code: "WRANGLER_REQUIRED_OAUTH_SCOPE_UNAVAILABLE" });
  assert.throws(() => createCloudflareAuthPlan({ taskId: "auth-test", preflight: optional, attachmentStorage: true }), { code: "WRANGLER_AUTH_PROFILE_EXISTS" });
  const frozen = createCloudflareAuthPlan({ taskId: "auth-test", preflight: optional, attachmentStorage: true, allowExistingProfile: true });
  assert.match(frozen.plan.oauth.permission_expansion, /not bucket-scoped/);
  assert.equal(frozen.plan.cloudflare_resource_writes, false);
  const calls = [];
  await executeCloudflareAuthAction({ plan: frozen.plan, actionId: "oauth_login", authorizedTaskId: "auth-test", authorizedPlanDigest: frozen.plan_digest, runner: async (_executable, args, options) => { calls.push(args); assert.equal(options.shell, false); return { code: 0 }; } });
  assert.equal(calls[0].at(-1), "workers:write");
  const tampered = structuredClone(frozen.plan);
  tampered.oauth.attachment_storage = false;
  await assert.rejects(executeCloudflareAuthAction({ plan: tampered, actionId: "oauth_login", authorizedTaskId: "auth-test", authorizedPlanDigest: canonicalDigest(tampered), runner: async () => { throw new Error("must not run"); } }), { code: "WRANGLER_AUTH_PLAN_INVALID" });
  const unavailable = await inspectCloudflareAuth({ ...probe, attachmentStorage: true, runner: authProbe({ workersScope: false }) });
  assert.equal(unavailable.safe_to_plan, false);
  assert.ok(unavailable.blockers.includes("WRANGLER_REQUIRED_OAUTH_SCOPE_UNAVAILABLE"));
});
