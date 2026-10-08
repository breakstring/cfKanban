import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { collectUsageStatistics, readUsage } from "../../apps/worker/src/services/usage.ts";

const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.attachments-test.jsonc" }] });
const worker = server.getWorker();
let local;
const owner = { kind: "bearer", isOwner: true };
const now = Date.parse("2026-10-07T12:30:00Z");
const config = { USAGE_ACCOUNT_ID: "test-account", USAGE_D1_DATABASE_ID: "test-database", USAGE_R2_BUCKET_NAME: "test-bucket", USAGE_ANALYTICS_TOKEN: "synthetic-local-only", USAGE_WORKER_NAME: "test-worker", USAGE_BILLING_CYCLE_DAY: "5", USAGE_BILLING_PLAN: "free", USAGE_ACCOUNT_TOTALS_ENABLED: "true" };
const row = (sum) => [{ sum }];
const operation = (actionType, responseStatusCode, requests) => ({ dimensions: { actionType, responseStatusCode }, sum: { requests } });
function data(kind, operations = [operation("PutObject", 200, 800_000), operation("HeadObject", 200, 2), operation("DeleteObject", 204, 99), operation("GetObject", 401, 100)]) {
  const account = kind === "d1" ? {
    activity: row({ rowsRead: 4_000_000, rowsWritten: 0 }), storage: [], billing: row({ rowsRead: 8_000_000, rowsWritten: 10 }),
    accountDaily: row({ rowsRead: 5_000_000, rowsWritten: 1 }), accountBilling: row({ rowsRead: 10_000_000, rowsWritten: 12 }),
    workerDaily: row({ requests: 321, cpuTimeUs: 123 }), accountWorkerDaily: row({ requests: 654, cpuTimeUs: 456 }),
    worker: row({ requests: 85_000, cpuTimeUs: 1234 }), accountWorker: row({ requests: 90_000, cpuTimeUs: 5678 }),
  } : { activity: row({ requests: 899 }), storage: [], billing: operations, accountBilling: operations, daily: operations, accountDaily: operations };
  return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }));
}
const reset = () => local.DB.prepare("UPDATE usage_statistics SET attempted_at=NULL,collected_at=NULL,error=NULL,metrics_json=NULL,config_key=NULL").run();
before(async () => { await server.listen(); await worker.applyD1Migrations("DB"); local = await worker.getEnv(); });
after(() => server.close());

test("two bounded queries provide period, resource and explicit account scope with raw CPU", async () => {
  await reset(); const env = { ...local, ...config }, calls = [];
  await collectUsageStatistics(env, now, async (_url, options) => { const request = JSON.parse(options.body); calls.push(request); return data(request.query.includes("UsageD1") ? "d1" : "r2"); });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].variables.worker, "test-worker");
  assert.equal(calls[0].variables.database, "test-database");
  assert.equal(calls[0].variables.billingDate, "2026-10-05");
  assert.equal(calls[0].variables.workerStart, "2026-10-07T00:00:00.000Z");
  assert.match(calls[0].query, /sum \{ requests cpuTimeUs \}/u);
  assert.equal(calls[1].variables.billingStart, "2026-10-05T00:00:00.000Z");
  const result = await readUsage(env, owner, now);
  assert.equal(result.cloudflare.status, "fresh");
  const metric = (key, scope = "instance") => result.cloudflare.metrics.find(value => value.key === key && value.scope === scope);
  assert.equal(metric("workers_cpu_microseconds").value, 1234);
  assert.equal(metric("workers_cpu_microseconds", "account").value, 5678);
  assert.equal(metric("r2_class_a_operations").value, 800_000);
  assert.equal(metric("r2_class_b_operations").value, 2);
  assert.equal(metric("r2_unclassified_operations").value, 0);
  assert.equal(metric("d1_rows_written").value, 0);
  assert.deepEqual(result.cloudflare.alerts, []);
  assert.equal(metric("workers_daily_requests").value, 85_000);
  assert.ok(!calls[0].query.includes("workerDaily:"));
  assert.equal(metric("workers_daily_cpu_microseconds").period_start, "2026-10-07T00:00:00.000Z");
  assert.equal(metric("r2_daily_class_a_operations").value, 800_000);
  assert.equal(result.cloudflare.billing.allowances_shared, true);
  assert.equal(result.cloudflare.billing.r2_standard_only_scope, "unknown");
  assert.ok(!result.cloudflare.alerts.some(value => value.metric_key.startsWith("r2_")));
  assert.ok(!JSON.stringify(result).includes(config.USAGE_ANALYTICS_TOKEN));
  assert.equal((await readUsage(env, owner, now + 900_000)).cloudflare.alerts.length, 0);
});
test("旧预算阈值或存储类别配置不再产生通知", async () => {
  await reset(); const env = { ...local, ...config, USAGE_WARNING_PERCENT: "1", USAGE_R2_STANDARD_ONLY_SCOPE: "account" };
  await collectUsageStatistics(env, now, async (_url, options) => data(JSON.parse(options.body).query.includes("UsageD1") ? "d1" : "r2"));
  assert.deepEqual((await readUsage(env, owner, now)).cloudflare.alerts, []);
});

test("unclassified or truncated R2 data cannot claim complete Class A/B totals", async () => {
  const env = { ...local, ...config };
  for (const operations of [[operation("FutureOperation", 200, 9)], Array.from({ length: 101 }, () => operation("GetObject", 200, 1))]) {
    await reset();
    await collectUsageStatistics(env, now, async (_url, options) => data(JSON.parse(options.body).query.includes("UsageD1") ? "d1" : "r2", operations));
    const result = await readUsage(env, owner, now);
    const metric = key => result.cloudflare.metrics.find(value => value.key === key && value.scope === "instance");
    assert.equal(metric("r2_class_a_operations").value, null);
    assert.equal(metric("r2_class_b_operations").value, null);
    assert.equal(metric("r2_unclassified_operations").value, operations.length === 101 ? null : 9);
    assert.ok(!result.cloudflare.alerts.some(value => value.metric_key.startsWith("r2_")));
  }
});
test("missing paid cycle still queries daily Workers without inventing monthly usage", async () => {
  await reset(); const env = { ...local, ...config, USAGE_BILLING_PLAN: "paid", USAGE_BILLING_CYCLE_DAY: undefined };
  const calls = [];
  await collectUsageStatistics(env, now, async (_url, options) => { const request = JSON.parse(options.body); calls.push(request); return data(request.query.includes("UsageD1") ? "d1" : "r2"); });
  assert.ok(calls[0].query.includes("workerDaily: workersInvocationsAdaptive"));
  assert.ok(calls.every(value => !value.query.includes("worker: workersInvocationsAdaptive") && !value.query.includes("$billingStart")));
  assert.equal(calls[0].variables.dailyStart, "2026-10-07T00:00:00.000Z");
  const result = await readUsage(env, owner, now);
  assert.equal(result.cloudflare.metrics.find(value => value.key === "workers_requests").value, null);
  assert.equal(result.cloudflare.metrics.find(value => value.key === "workers_daily_requests").value, 321);
  assert.equal(result.cloudflare.billing.period_start, null);
  assert.deepEqual(result.cloudflare.alerts, []);
});
test("account aggregation is opt-in and configuration changes invalidate old scope", async () => {
  await reset(); const env = { ...local, ...config, USAGE_ACCOUNT_TOTALS_ENABLED: "false" };
  await collectUsageStatistics(env, now, async (_url, options) => { const request = JSON.parse(options.body); assert.ok(!request.query.includes("accountDaily") && !request.query.includes("accountBilling") && !request.query.includes("accountWorker")); return data(request.query.includes("UsageD1") ? "d1" : "r2"); });
  assert.ok((await readUsage(env, owner, now)).cloudflare.metrics.every(value => value.scope === "instance"));
  assert.deepEqual((await readUsage({ ...env, USAGE_ACCOUNT_TOTALS_ENABLED: "true" }, owner, now)).cloudflare.metrics, []);
});

test("Paid今日与账期指标分别保留窗口，新增日指标仍只有两次GraphQL请求", async () => {
  await reset(); const env = { ...local, ...config, USAGE_BILLING_PLAN: "paid" }, calls = [];
  await collectUsageStatistics(env, now, async (_url, options) => { const request = JSON.parse(options.body); calls.push(request); return data(request.query.includes("UsageD1") ? "d1" : "r2"); });
  const result = await readUsage(env, owner, now), metric = key => result.cloudflare.metrics.find(value => value.key === key && value.scope === "instance");
  assert.equal(calls.length, 2); assert.equal(calls[0].variables.workerStart, "2026-10-05T00:00:00.000Z"); assert.equal(calls[0].variables.dailyStart, "2026-10-07T00:00:00.000Z");
  assert.equal(metric("workers_requests").value, 85_000); assert.equal(metric("workers_requests").period_start, "2026-10-05T00:00:00.000Z");
  assert.equal(metric("workers_daily_requests").value, 321); assert.equal(metric("workers_daily_requests").period_start, "2026-10-07T00:00:00.000Z");
  assert.equal(metric("r2_class_a_operations").period_start, "2026-10-05T00:00:00.000Z"); assert.equal(metric("r2_daily_class_a_operations").period_start, "2026-10-07T00:00:00.000Z");
  assert.ok(result.cloudflare.metrics.length <= 40);
});
