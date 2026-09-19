import { readWorkerVersionById } from "../../packages/skill-runtime/src/deploy.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createInstanceUpgradePlan } from "../../packages/skill-runtime/src/upgrade-plan.mjs";
import { deploymentCrons, existingUsageConfig, targetWorkerBindings, usageBindings, usageVars } from "../../packages/skill-runtime/src/usage-config.mjs";
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
      schema_version: 6,
    },
    target: {
      publisher: "https://github.com",
      manifest_version: "0.1.0-alpha.19",
      manifest_sha256: "c".repeat(64),
      service_bundle_version: "0.1.0-alpha.19",
      service_bundle_sha256: "d".repeat(64),
      service_bundle_source: "https://github.com/example/cfkanban-service-alpha.19.zip",
      service_api_version: "0.1.0",
      schema_version: 6,
      migration_manifest_sha256: "e".repeat(64),
      compatibility: {
        node: ">=22.12.0 <27",
        wrangler: ">=4.127.1 <5",
        service_api: ">=0.1.0 <0.2.0",
        schema_version: 6,
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


const config = { enabled: true, account_id: "account-one", d1_database_id: "88888888-8888-4888-8888-888888888888" };
function enabledInput(existing = false) {
  const input = upgradePlanInput();
  input.resources.worker.bindings.push(...usageBindings(existing ? config : null, true));
  if (!existing) input.usageAnalytics = config;
  return input;
}
test("cloud configuration is optional and adds no Cloudflare resource", () => {
  const plain = createInstanceUpgradePlan(upgradePlanInput());
  assert.equal(plain.usage_analytics, undefined);
  assert.deepEqual(deploymentCrons(plain), []);
  const plan = createInstanceUpgradePlan(enabledInput());
  assert.deepEqual(plan.usage_analytics.configuration, config);
  assert.deepEqual(deploymentCrons(plan), []);
  assert.equal(plan.resources.r2, false);
  assert.equal(plan.cost_delta, false);
  assert.equal(plan.binding_changes_allowed, true);
  assert.equal(targetWorkerBindings(plan).filter((b) => b.name === "USAGE_ANALYTICS_TOKEN").length, 1);
});
test("normal upgrade preserves exact usage vars and secret binding", () => {
  const plan = createInstanceUpgradePlan(enabledInput(true));
  assert.deepEqual(plan.usage_analytics.previous_configuration, config);
  assert.deepEqual(usageVars(plan.usage_analytics.configuration), { USAGE_ANALYTICS_ENABLED: "true", USAGE_ACCOUNT_ID: config.account_id, USAGE_D1_DATABASE_ID: config.d1_database_id });
  assert.equal(plan.binding_changes_allowed, false);
  const input = enabledInput(true); input.usageAnalytics = { ...config, enabled: false };
  assert.equal(createInstanceUpgradePlan(input).usage_analytics.configuration.enabled, false);
});
test("usage rejects secret payload and foreign resources; missing secret is allowed", () => {
  const input = enabledInput(); input.usageAnalytics = { ...config, token: "PRIVATE-TEST-SECRET" };
  assert.throws(() => createInstanceUpgradePlan(input), (error) => error.code === "INVALID_USAGE_CONFIG" && !JSON.stringify(error).includes("PRIVATE-TEST-SECRET"));
  const missing = upgradePlanInput(); missing.usageAnalytics = config;
  assert.equal(createInstanceUpgradePlan(missing).usage_analytics.configuration.enabled, true);
  const wrong = enabledInput(); wrong.usageAnalytics = { ...config, account_id: "other" };
  assert.throws(() => createInstanceUpgradePlan(wrong), { code: "USAGE_RESOURCE_MISMATCH" });
  assert.throws(() => existingUsageConfig([{ type: "plain_text", name: "USAGE_ANALYTICS_ENABLED", text: "bad" }], {}), { code: "INVALID_USAGE_CONFIG" });
});
test("disabled configuration is preserved without a token or cron", () => {
  const input = upgradePlanInput();
  input.resources.worker.bindings.push({ type: "plain_text", name: "USAGE_ANALYTICS_ENABLED", text: "false" });
  const plan = createInstanceUpgradePlan(input);
  assert.equal(plan.usage_analytics.configuration.enabled, false);
  assert.deepEqual(deploymentCrons(plan), []);
  assert.equal(targetWorkerBindings(plan).some((item) => item.type === "secret_text"), false);
});

test("live binding normalization preserves resource configuration but strips every secret value", async () => {
  const versionId = "77777777-7777-4777-8777-777777777777";
  const result = await readWorkerVersionById({
    wranglerExecutable: process.execPath, accountId: "account-one", workerName: "cfkanban-worker", versionId,
    environment: {}, cloudflareProfile: "production",
    runner: async () => ({ code: 0, stdout: JSON.stringify({ id: versionId, resources: { bindings: [
      ...usageBindings(config, false),
      { type: "secret_text", name: "USAGE_ANALYTICS_TOKEN", text: "PRIVATE-TEST-SECRET", value: "PRIVATE-TEST-SECRET" },
    ] } }) }),
  });
  assert.ok(!JSON.stringify(result).includes("PRIVATE-TEST-SECRET"));
  assert.deepEqual(result.bindings.find((item) => item.name === "USAGE_ANALYTICS_TOKEN"), { type: "secret_text", name: "USAGE_ANALYTICS_TOKEN", value_redacted: true });
  assert.equal(result.bindings.find((item) => item.name === "USAGE_D1_DATABASE_ID").text, config.d1_database_id);
});

for (const vars of [
  { USAGE_ANALYTICS_ENABLED: "true" },
  { USAGE_ANALYTICS_ENABLED: "false" },
  { USAGE_ACCOUNT_ID: config.account_id, USAGE_D1_DATABASE_ID: config.d1_database_id },
]) {
  test(`normal upgrade preserves exact partial usage variables: ${Object.keys(vars).join(",")}/${vars.USAGE_ANALYTICS_ENABLED ?? "missing enabled"}`, () => {
    const input = upgradePlanInput();
    const original = Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text }));
    input.resources.worker.bindings.push(...original);
    const plan = createInstanceUpgradePlan(input);
    assert.deepEqual(usageVars(plan.usage_analytics.configuration), vars);
    assert.deepEqual(targetWorkerBindings(plan).filter((item) => item.name.startsWith("USAGE_")), [...original].sort((a, b) => a.name.localeCompare(b.name)));
    assert.equal(plan.binding_changes_allowed, false);
    input.usageAnalytics = {};
    const explicit = createInstanceUpgradePlan(input);
    assert.equal(explicit.binding_changes_allowed, true);
    assert.deepEqual(usageVars(explicit.usage_analytics.configuration), { USAGE_ANALYTICS_ENABLED: "true", USAGE_ACCOUNT_ID: config.account_id, USAGE_D1_DATABASE_ID: config.d1_database_id });
  });
}
test("partial existing resource identifiers are individually checked against the deployment", () => {
  const target = { accountId: config.account_id, databaseId: config.d1_database_id, bucketName: null };
  for (const [name, text] of [["USAGE_ACCOUNT_ID", "other"], ["USAGE_D1_DATABASE_ID", INSTANCE_ID], ["USAGE_R2_BUCKET_NAME", "foreign-bucket"]]) {
    assert.throws(() => existingUsageConfig([{ type: "plain_text", name, text }], target), { code: "USAGE_RESOURCE_MISMATCH" });
  }
});
