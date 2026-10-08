import assert from "node:assert/strict";
import test from "node:test";
import { costProtectionBindings, observedAnonymousLogin, observedExpensiveReads, normalizeWorkerLimits, normalizeObservedWorkerLimits, plannedWorkerLimits } from "../../packages/skill-runtime/src/cost-protection-config.mjs";
import { enforceAnonymousLoginRateLimit } from "../../apps/worker/src/kernel/rate-limit.ts";
import { readWorkerCostSettings, verifyPlannedWorkerCostSettings } from "../../packages/skill-runtime/src/worker-cost-settings.mjs";

test("anonymous login limiter hashes only the trusted address and refuses before D1 work", async () => {
  const keys = [];
  const env = { ANONYMOUS_LOGIN_RATE_LIMITER: { async limit({ key }) { keys.push(key); return { success: false }; } }, RATE_LIMIT_ANONYMOUS_LOGIN_LIMIT: "10", RATE_LIMIT_ANONYMOUS_LOGIN_PERIOD_SECONDS: "60", get DB() { assert.fail("limiter cannot read D1"); } };
  for (const forwarded of ["1.1.1.1", "8.8.8.8"]) {
    await assert.rejects(enforceAnonymousLoginRateLimit(env, new Request("https://test.invalid/api/v1/web-authentication/options", { headers: { "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": forwarded } })), error => error.code === "RATE_LIMITED" && error.details.limit === 10);
  }
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^anonymous-login:[a-f0-9]{64}$/u);
  assert.ok(!keys[0].includes("192.0.2.1"));
  await enforceAnonymousLoginRateLimit({}, new Request("https://test.invalid"));
});

test("cost bindings preserve verified policies and reject partial readback", () => {
  const config = { anonymous_login: { limit: 8, period_seconds: 60 }, expensive_reads: { limit: 9, period_seconds: 10 } };
  const bindings = costProtectionBindings(config);
  assert.equal(bindings.length, 6);
  assert.deepEqual(observedAnonymousLogin(bindings), config.anonymous_login);
  assert.deepEqual(observedExpensiveReads(bindings), config.expensive_reads);
  assert.throws(() => observedAnonymousLogin(bindings.filter(item => item.name !== "ANONYMOUS_LOGIN_RATE_LIMITER")), { code: "INVALID_COST_PROTECTION" });
  assert.throws(() => observedExpensiveReads(bindings.map(item => item.name === "EXPENSIVE_READ_RATE_LIMITER" ? { ...item, namespace_id: "1004" } : item)), { code: "INVALID_COST_PROTECTION" });
  assert.throws(() => normalizeWorkerLimits({ workers_plan: "free", cpu_ms: 100 }), { code: "INVALID_WORKER_CPU_LIMIT" });
  assert.throws(() => normalizeWorkerLimits({ workers_plan: "paid", cpu_ms: 300001 }), { code: "INVALID_WORKER_CPU_LIMIT" });
  assert.deepEqual(normalizeWorkerLimits({ workers_plan: "paid", cpu_ms: 100 }), { workers_plan: "paid", cpu_ms: 100 });
});

test("provider limits are preserved without inferring a subscription and explicit CPU changes retain subrequests", async () => {
  let limits = { cpu_ms: 200, subrequests: 1000 };
  const requests = [];
  const input = { accountId: "isolated-account", workerName: "board", wranglerExecutable: "/mock/wrangler", cloudflareProfile: "isolated", environment: {}, tokenRunner: async () => ({ stdout: JSON.stringify({ type: "oauth", token: "mock-private-control" }) }), fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method });
    assert.equal(new URL(url).pathname, "/client/v4/accounts/isolated-account/workers/services/board/environments/production");
    return Response.json({ success: true, result: { script: { limits } } });
  } };
  const readback = await readWorkerCostSettings(input);
  const previous = readback.worker_limits;
  assert.deepEqual(previous, limits);
  assert.equal(readback.subscription_readback, "not_performed");
  assert.equal(Object.hasOwn(previous, "workers_plan"), false);
  const plan = { kind: "deployed_instance_upgrade", target: { cloudflare_account_id: "isolated-account", cloudflare_profile: "isolated" }, resources: { worker: { name: "board" } }, cost_protection: { previous_worker_limits: previous, worker_limits: { cpu_ms: 100, subrequests: 1000 }, cpu_limit_request: { workers_plan: "paid", cpu_ms: 100 } } };
  await verifyPlannedWorkerCostSettings({ ...input, plan, phase: "before" });
  await assert.rejects(verifyPlannedWorkerCostSettings({ ...input, plan, phase: "after" }), { code: "WORKER_CPU_LIMIT_DRIFT" });
  await assert.rejects(verifyPlannedWorkerCostSettings({ ...input, plan: { ...plan, cost_protection: { previous_worker_limits: null, worker_limits: null } }, phase: "before" }), { code: "WORKER_CPU_LIMIT_DRIFT" });
  limits = { cpu_ms: 100, subrequests: 1000 };
  await verifyPlannedWorkerCostSettings({ ...input, plan, phase: "after" });
  limits = { cpu_ms: 100, subrequests: 999 };
  await assert.rejects(verifyPlannedWorkerCostSettings({ ...input, plan, phase: "after" }), { code: "WORKER_CPU_LIMIT_DRIFT" });
  limits = { cpu_ms: 100, subrequests: 1000, future_limit: 1 };
  await assert.rejects(readWorkerCostSettings(input), { code: "WORKER_COST_UNSUPPORTED_LIMIT" });
  for (const freeLimits of [{ cpu_ms: 10, subrequests: 50 }, { subrequests: 50 }, null]) {
    limits = freeLimits;
    const preserved = { ...plan, cost_protection: { previous_worker_limits: freeLimits, worker_limits: freeLimits, cpu_limit_request: null } };
    await verifyPlannedWorkerCostSettings({ ...input, plan: preserved, phase: "before" });
    await verifyPlannedWorkerCostSettings({ ...input, plan: preserved, phase: "after" });
    assert.deepEqual(plannedWorkerLimits(preserved), freeLimits);
  }
  assert.throws(() => plannedWorkerLimits({ ...plan, cost_protection: { ...plan.cost_protection, cpu_limit_request: null } }), { code: "INVALID_WORKER_CPU_LIMIT" });
  assert.throws(() => plannedWorkerLimits({ ...plan, cost_protection: { ...plan.cost_protection, worker_limits: { cpu_ms: 100 } } }), { code: "INVALID_WORKER_CPU_LIMIT" });
  assert.throws(() => normalizeObservedWorkerLimits({ workers_plan: "paid", cpu_ms: 100 }), { code: "WORKER_COST_UNSUPPORTED_LIMIT" });
  assert.equal(await verifyPlannedWorkerCostSettings({ plan: { kind: "strict_zero_deploy", cost_protection: { worker_limits: null } }, fetchImpl: () => assert.fail("A new Worker has no prior limits to preserve") }), null);
  assert.ok(requests.every(request => request.method === "GET"));
});

test("upgrade preserves Observability and rejects drift before and after deployment", async () => {
  const preserved = { enabled: false, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1, persist: true }, traces: { enabled: false, head_sampling_rate: 1, persist: true } };
  let observability = structuredClone(preserved);
  const input = { accountId: "isolated-account", workerName: "board", wranglerExecutable: "/mock/wrangler", cloudflareProfile: "isolated", environment: {}, tokenRunner: async () => ({ stdout: JSON.stringify({ type: "oauth", token: "mock-private-control" }) }), fetchImpl: async (_url, options) => {
    assert.equal(options.method, "GET");
    return Response.json({ success: true, result: { script: { limits: null, observability } } });
  } };
  const plan = { kind: "deployed_instance_upgrade", target: { cloudflare_account_id: input.accountId, cloudflare_profile: input.cloudflareProfile }, resources: { worker: { name: input.workerName, observability: preserved } }, cost_protection: { previous_worker_limits: null, worker_limits: null } };
  assert.deepEqual((await readWorkerCostSettings(input)).observability, preserved);
  for (const phase of ["before", "after"]) {
    assert.deepEqual((await verifyPlannedWorkerCostSettings({ ...input, plan, phase })).observability, preserved);
    observability.logs.enabled = false;
    await assert.rejects(verifyPlannedWorkerCostSettings({ ...input, plan, phase }), { code: "WORKER_OBSERVABILITY_DRIFT" });
    observability = structuredClone(preserved);
    observability.logs.head_sampling_rate = 0.5;
    await assert.rejects(verifyPlannedWorkerCostSettings({ ...input, plan, phase }), { code: "WORKER_OBSERVABILITY_DRIFT" });
    observability = structuredClone(preserved);
  }
  observability = { ...preserved, future_field: "mock-sensitive-marker" };
  await assert.rejects(readWorkerCostSettings(input), error => error.code === "WORKER_OBSERVABILITY_UNSUPPORTED_FIELD" && !JSON.stringify(error).includes("mock-sensitive-marker"));
});
