import assert from "node:assert/strict";
import { test } from "node:test";
import { publicAccessSnapshot, r2OperationClass, usageAlerts, usageBilling } from "../../apps/worker/src/services/usage-budgets.ts";

test("billing periods require explicit day and clamp across short months", () => {
  assert.equal(usageBilling({}, Date.parse("2026-03-01T12:00:00Z")).period_start, null);
  const env = { USAGE_BILLING_CYCLE_DAY: "31", USAGE_BILLING_PLAN: "paid" };
  assert.equal(usageBilling(env, Date.parse("2026-03-01T12:00:00Z")).period_start, "2026-02-28T00:00:00.000Z");
  assert.equal(usageBilling(env, Date.parse("2026-03-31T00:00:00Z")).period_start, "2026-03-31T00:00:00.000Z");
  assert.equal(usageBilling(env, Date.parse("2028-03-01T00:00:00Z")).period_start, "2028-02-29T00:00:00.000Z");
  assert.equal(usageBilling({ USAGE_BILLING_CYCLE_DAY: "01" }, 0).cycle_day, null);
});
test("fresh shared-allowance warnings preserve instance contribution, scope and unknown periods", () => {
  const value = { key: "workers_requests", value: 80_000, scope: "instance", unit: "count", period_start: "2026-10-07T00:00:00Z", period_end: "2026-10-07T12:00:00Z" };
  const billing = usageBilling({ USAGE_BILLING_PLAN: "free" }, Date.parse(value.period_end));
  assert.equal(usageAlerts([value], billing, true)[0].percent, 80);
  assert.equal(usageAlerts([value], billing, true)[0].scope, "instance");
  assert.deepEqual(usageAlerts([value], billing, false), []);
  assert.deepEqual(usageAlerts([value], { ...billing, plan: "paid" }, true), []);
  assert.deepEqual(usageAlerts([{ ...value, value: null }], billing, true), []);
  assert.equal(usageAlerts([{ ...value, value: 100_000, scope: "account" }], billing, true)[0].level, "reached");
  assert.equal(usageAlerts([value], { ...billing, warning_percent: 90 }, true).length, 0);
});
test("R2 classes separate HEAD, writes, free deletions, unauthorized and unknown operations", () => {
  assert.equal(r2OperationClass("HeadObject", 200), "b");
  assert.equal(r2OperationClass("ListObjectsV2", 200), "a");
  assert.equal(r2OperationClass("LifecycleStorageTierTransition", 200), "a");
  assert.equal(r2OperationClass("DeleteObject", 204), "free");
  assert.equal(r2OperationClass("PutObject", 401), "free");
  assert.equal(r2OperationClass("FutureOperation", 200), "unknown");
});
test("R2 Standard free allowances need a verified storage-class scope", () => {
  const billing = usageBilling({ USAGE_BILLING_CYCLE_DAY: "1" }, Date.parse("2026-10-07T12:00:00Z"));
  const value = { key: "r2_class_a_operations", value: 900_000, scope: "instance", unit: "count", period_start: billing.period_start, period_end: billing.period_end };
  assert.deepEqual(usageAlerts([value], billing, true), []);
  assert.equal(usageAlerts([value], { ...billing, r2_standard_only_scope: "instance" }, true).length, 1);
  assert.deepEqual(usageAlerts([{ ...value, scope: "account" }], { ...billing, r2_standard_only_scope: "instance" }, true), []);
  assert.equal(usageAlerts([{ ...value, scope: "account" }], { ...billing, r2_standard_only_scope: "account" }, true).length, 1);
});
test("public edge snapshot is bounded and does not assert live verification", () => {
  assert.equal(publicAccessSnapshot({}).status, "not_configured");
  const configured = publicAccessSnapshot({ PUBLIC_ACCESS_HOSTNAME: "board.example.test", PUBLIC_ACCESS_MODE: "custom_domain", PUBLIC_ACCESS_WAF_PROFILE: "disabled", PUBLIC_ACCESS_VERIFIED_AT: "2026-10-07T01:00:00Z" });
  assert.equal(configured.status, "configured");
  assert.equal(configured.live_verified, false);
  const invalid = publicAccessSnapshot({ PUBLIC_ACCESS_HOSTNAME: "<script>secret</script>" });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.hostname, null);
  assert.equal(publicAccessSnapshot({ PUBLIC_ACCESS_HOSTNAME: "board.-invalid.test", PUBLIC_ACCESS_MODE: "custom_domain", PUBLIC_ACCESS_WAF_PROFILE: "disabled", PUBLIC_ACCESS_VERIFIED_AT: "2026-10-07T01:00:00Z" }).status, "invalid");
});
