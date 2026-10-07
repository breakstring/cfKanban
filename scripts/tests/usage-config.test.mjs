import { readWorkerVersionById } from "../../packages/skill-runtime/src/deploy.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createInstanceUpgradePlan } from "../../packages/skill-runtime/src/upgrade-plan.mjs";
import { deploymentCrons, existingUsageConfig, normalizeUsageConfig, targetWorkerBindings, usageBindings, usageVars } from "../../packages/skill-runtime/src/usage-config.mjs";
import { ownerControlVars } from "../../packages/skill-runtime/src/owner-control-config.mjs";
import { costProtectionBindings } from "../../packages/skill-runtime/src/cost-protection-config.mjs";
import { canonicalDigest } from "../../packages/skill-runtime/src/utils.mjs";
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
        worker_limits: null,
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

function ownerManagedInput() {
  const input = upgradePlanInput();
  input.current.schema_version = 26;
  input.target.schema_version = 26;
  input.target.compatibility.schema_version = 26;
  input.resources.worker.bindings.push(
    { type: "plain_text", name: "CFKANBAN_CONTROL_ACCOUNT_ID", text: input.cloudflare.account_id },
    { type: "plain_text", name: "CFKANBAN_CONTROL_WORKER_NAME", text: input.resources.worker.name },
    { type: "plain_text", name: "CFKANBAN_CONTROL_DATABASE_ID", text: input.resources.d1.database_id },
    { type: "plain_text", name: "USAGE_HISTORY_ENABLED", text: "true" },
    { type: "secret_text", name: "CFKANBAN_API_TOKEN", value_redacted: true },
    { type: "secret_text", name: "CFKANBAN_CONFIGURATION_TOKEN", value_redacted: true },
    { type: "secret_text", name: "CFKANBAN_CONTROL_TOKEN", value_redacted: true },
  );
  input.resources.worker.bindings.find(item => item.name === "RATE_LIMIT_INSTANCE_LIMIT").text = "73";
  input.resources.worker.bindings.find(item => item.name === "RATE_LIMIT_INSTANCE_PERIOD_SECONDS").text = "10";
  input.resources.worker.bindings.push(...costProtectionBindings({ anonymous_login: { limit: 17, period_seconds: 10 }, expensive_reads: { limit: 19, period_seconds: 60 } }));
  input.resources.worker.bindings.push(...usageBindings({ ...config, worker_name: input.resources.worker.name, billing_plan: "paid", billing_cycle_day: 31, account_totals: true, warning_percent: 90, r2_standard_only_scope: "unknown" }, true));
  for (const [name, prefix] of OWNER_RATE_GROUPS) {
    input.resources.worker.bindings.find(item => item.name === name).simple = {
      limit: Number(input.resources.worker.bindings.find(item => item.name === `RATE_LIMIT_${prefix}_LIMIT`).text),
      period: Number(input.resources.worker.bindings.find(item => item.name === `RATE_LIMIT_${prefix}_PERIOD_SECONDS`).text),
    };
  }
  return input;
}

const OWNER_RATE_GROUPS = [
  ["INSTANCE_RATE_LIMITER", "INSTANCE"],
  ["PRINCIPAL_RATE_LIMITER", "PRINCIPAL"],
  ["UNAUTHENTICATED_RATE_LIMITER", "UNAUTHENTICATED_SENSITIVE"],
  ["ANONYMOUS_LOGIN_RATE_LIMITER", "ANONYMOUS_LOGIN"],
  ["EXPENSIVE_READ_RATE_LIMITER", "EXPENSIVE_READ"],
];

test("升级使用当前 Owner 设置并保留统一与旧管理 Secret 和历史开关，不被旧本地默认覆盖", () => {
  const plan = createInstanceUpgradePlan(ownerManagedInput());
  assert.deepEqual(plan.bindings.rate_limits.instance, { limit: 73, period_seconds: 10 });
  assert.deepEqual(plan.cloudflare_control, { enabled: true, history_enabled: true });
  assert.equal(ownerControlVars(plan).CFKANBAN_CONTROL_DATABASE_ID, plan.resources.d1.database_id);
  const target = targetWorkerBindings(plan);
  for (const name of ["CFKANBAN_API_TOKEN", "CFKANBAN_CONFIGURATION_TOKEN", "CFKANBAN_CONTROL_TOKEN", "USAGE_ANALYTICS_TOKEN"]) assert.deepEqual(target.find(item => item.name === name), { type: "secret_text", name, value_redacted: true });
  assert.equal(target.find(item => item.name === "USAGE_HISTORY_ENABLED").text, "true");
  assert.equal(target.find(item => item.name === "RATE_LIMIT_INSTANCE_LIMIT").text, "73");
  for (const [name, prefix] of OWNER_RATE_GROUPS) {
    assert.deepEqual(target.find(item => item.name === name).simple, {
      limit: Number(target.find(item => item.name === `RATE_LIMIT_${prefix}_LIMIT`).text),
      period: Number(target.find(item => item.name === `RATE_LIMIT_${prefix}_PERIOD_SECONDS`).text),
    });
  }
  assert.deepEqual(usageVars(plan.usage_analytics.configuration), usageVars(plan.usage_analytics.previous_configuration));
  assert.equal(plan.binding_changes_allowed, false);
});

for (const [name] of OWNER_RATE_GROUPS) {
  test(`Owner 升级拒绝 ${name} 原生阈值漂移或缺失`, () => {
    for (const mutate of [binding => { binding.simple.limit += 1; }, binding => { binding.simple.period = binding.simple.period === 10 ? 60 : 10; }, binding => { delete binding.simple; }]) {
      const input = ownerManagedInput();
      mutate(input.resources.worker.bindings.find(item => item.name === name));
      assert.throws(() => createInstanceUpgradePlan(input), error => ["OWNER_CONTROL_READBACK_INVALID", "INVALID_COST_PROTECTION", "UPGRADE_BINDING_DELTA_REQUIRES_SEPARATE_PLAN"].includes(error.code));
    }
  });
}

test("旧实例首次升级到控制能力时明确冻结五组原生限流", () => {
  const input = upgradePlanInput();
  input.current.schema_version = input.target.schema_version = input.target.compatibility.schema_version = 26;
  const plan = createInstanceUpgradePlan(input);
  assert.equal(plan.cloudflare_control.history_enabled, false);
  assert.equal(targetWorkerBindings(plan).filter(item => item.type === "ratelimit" && item.simple).length, 5);
});

test("真实版本读回保留原生阈值供漂移检查，只投影非秘密白名单", async () => {
  const versionId = "77777777-7777-4777-8777-777777777777";
  const read = async limit => readWorkerVersionById({
    wranglerExecutable: process.execPath, accountId: "account-one", workerName: "cfkanban-worker", versionId, environment: {}, cloudflareProfile: "production",
    runner: async () => ({ code: 0, stdout: JSON.stringify({ id: versionId, resources: { bindings: [
      { type: "ratelimit", name: "INSTANCE_RATE_LIMITER", namespace_id: "1002", simple: { limit, period: 10, token: "PRIVATE-TEST-SECRET" }, text: "PRIVATE-TEST-SECRET" },
    ] } }) }),
  });
  const before = await read(73);
  const drift = await read(900);
  assert.deepEqual(before.bindings, [{ type: "ratelimit", name: "INSTANCE_RATE_LIMITER", namespace_id: "1002", simple: { limit: 73, period: 10 } }]);
  assert.notEqual(canonicalDigest(before.bindings), canonicalDigest(drift.bindings));
  assert.ok(!JSON.stringify(before).includes("PRIVATE-TEST-SECRET"));
});

test("完整 Owner 版本读回与冻结的升级目标完全一致", async () => {
  const input = ownerManagedInput();
  const observed = await readWorkerVersionById({
    wranglerExecutable: process.execPath, accountId: input.cloudflare.account_id, workerName: input.resources.worker.name, versionId: input.resources.worker.version_id, environment: {}, cloudflareProfile: "production",
    runner: async () => ({ code: 0, stdout: JSON.stringify({ id: input.resources.worker.version_id, resources: { bindings: input.resources.worker.bindings.map(binding => ({ ...binding, ...(binding.type === "secret_text" ? { text: "PRIVATE-TEST-SECRET" } : {}), ...(binding.simple ? { simple: { ...binding.simple, token: "PRIVATE-TEST-SECRET" } } : {}) })) } }) }),
  });
  input.resources.worker.bindings = observed.bindings;
  const plan = createInstanceUpgradePlan(input);
  assert.deepEqual(targetWorkerBindings(plan), observed.bindings);
  assert.ok(!JSON.stringify(plan).includes("PRIVATE-TEST-SECRET"));
});

test("版本读回拒绝不受支持的原生限流值", async () => {
  const versionId = "77777777-7777-4777-8777-777777777777";
  for (const simple of [null, { limit: 0, period: 60 }, { limit: Number.MAX_SAFE_INTEGER + 1, period: 60 }, { limit: "10", period: 60 }, { limit: 10, period: 30 }, { limit: 10, period: "60" }]) {
    await assert.rejects(readWorkerVersionById({
      wranglerExecutable: process.execPath, accountId: "account-one", workerName: "cfkanban-worker", versionId, environment: {}, cloudflareProfile: "production",
      runner: async () => ({ code: 0, stdout: JSON.stringify({ id: versionId, resources: { bindings: [{ type: "ratelimit", name: "INSTANCE_RATE_LIMITER", namespace_id: "1002", simple }] } }) }),
    }), { code: "WRANGLER_WORKER_VERSION_READBACK_INVALID" });
  }
});

test("升级拒绝错配管理目标、未脱敏 Secret 和不支持控制能力的发行目标", () => {
  const foreign = ownerManagedInput();
  foreign.resources.worker.bindings.find(item => item.name === "CFKANBAN_CONTROL_DATABASE_ID").text = "99999999-9999-4999-8999-999999999999";
  assert.throws(() => createInstanceUpgradePlan(foreign), { code: "OWNER_CONTROL_TARGET_MISMATCH" });
  const unsafe = ownerManagedInput();
  unsafe.resources.worker.bindings.find(item => item.name === "CFKANBAN_CONTROL_TOKEN").value_redacted = false;
  assert.throws(() => createInstanceUpgradePlan(unsafe), { code: "UPGRADE_BINDING_DELTA_REQUIRES_SEPARATE_PLAN" });
  const old = ownerManagedInput();
  old.target.schema_version = old.target.compatibility.schema_version = 24;
  assert.throws(() => createInstanceUpgradePlan(old), { code: "OWNER_CONTROL_RELEASE_UNSUPPORTED" });
});
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
      { type: "secret_text", name: "CFKANBAN_API_TOKEN", text: "PRIVATE-UNIFIED-SECRET", value: "PRIVATE-UNIFIED-SECRET" },
    ] } }) }),
  });
  assert.ok(!JSON.stringify(result).includes("PRIVATE-TEST-SECRET"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE-UNIFIED-SECRET"));
  assert.deepEqual(result.bindings.find((item) => item.name === "CFKANBAN_API_TOKEN"), { type: "secret_text", name: "CFKANBAN_API_TOKEN", value_redacted: true });
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
test("extended usage settings retain exact target and explicit billing/scope on upgrade", () => {
  const input = enabledInput(true);
  const extended = { ...config, worker_name: input.resources.worker.name, billing_plan: "paid", billing_cycle_day: 31, account_totals: true, warning_percent: 90, r2_standard_only_scope: "instance" };
  input.resources.worker.bindings = input.resources.worker.bindings.filter(binding => !binding.name.startsWith("USAGE_"));
  input.resources.worker.bindings.push(...usageBindings(extended, true));
  const plan = createInstanceUpgradePlan(input);
  assert.deepEqual(plan.usage_analytics.configuration, extended);
  assert.deepEqual(usageVars(plan.usage_analytics.configuration), usageVars(extended));
  assert.equal(plan.binding_changes_allowed, false);
  const target = { accountId: config.account_id, databaseId: config.d1_database_id, workerName: "cfkanban-worker" };
  for (const changes of [{ worker_name: "foreign-worker" }, { billing_cycle_day: 0 }, { warning_percent: 101 }, { account_totals: "true" }, { r2_standard_only_scope: "assumed" }]) {
    assert.throws(() => normalizeUsageConfig({ ...extended, ...changes }, target), error => ["USAGE_RESOURCE_MISMATCH", "INVALID_USAGE_CONFIG"].includes(error.code));
  }
  for (const [name, text] of [["USAGE_BILLING_CYCLE_DAY", "031"], ["USAGE_WARNING_PERCENT", "080"], ["USAGE_ACCOUNT_TOTALS_ENABLED", "1"], ["USAGE_R2_STANDARD_ONLY_SCOPE", "assumed"]]) {
    assert.throws(() => existingUsageConfig([{ type: "plain_text", name, text }], target), { code: "INVALID_USAGE_CONFIG" });
  }
});
