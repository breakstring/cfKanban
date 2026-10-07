import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isExpensiveIssueRead, readCostProtection, withIssueReadProtection } from "../../apps/worker/src/kernel/query-cost-protection.ts";

const url = path => new URL(path, "https://isolated.fixture.invalid");
const countUrl = url("/api/v1/workspaces/w/projects/p/issues/counts");
const auth = () => ({ principalId: randomUUID() });
const allowed = () => ({ RATE_LIMIT_EXPENSIVE_READ_LIMIT: "10", RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS: "60", EXPENSIVE_READ_RATE_LIMITER: { limit: async () => ({ success: true }) }, get DB() { assert.fail("cost admission must not use D1"); } });
const flush = async () => { for (let step = 0; step < 10; step++) await Promise.resolve(); };

test("Owner cost projection distinguishes inactive legacy, invalid policy and active limits", () => {
  const legacy = readCostProtection({});
  assert.equal(legacy.expensive_reads.enabled, false);
  assert.equal(legacy.concurrency.enabled, false);
  const configured = readCostProtection(allowed());
  assert.deepEqual(configured.expensive_reads.policy, { limit: 10, period_seconds: 60 });
  assert.equal(configured.concurrency.enabled, true);
  assert.equal(configured.billing_cap, false);
  const invalid = readCostProtection(Object.assign(allowed(), { RATE_LIMIT_EXPENSIVE_READ_LIMIT: "bad" }));
  assert.equal(invalid.expensive_reads.enabled, true);
  assert.equal(invalid.expensive_reads.policy, null);
});

test("counts and title substring reads are expensive while typed number seeks and plain lists stay cheap", () => {
  for (const path of ["/api/v1/issues", "/api/v1/issues?q=&q_mode=typed", "/api/v1/issues?q=%20%20", "/api/v1/issues?q=CFK-62&q_mode=typed", "/api/v1/issues/candidates?q=62&q_mode=typed", "/api/v1/workspaces/w/projects/p/issues?q=ＣＦＫ－６２&q_mode=typed"]) assert.equal(isExpensiveIssueRead(url(path)), false, path);
  for (const path of ["/api/v1/workspaces/w/projects/p/issues/counts", "/api/v1/workspaces/w/projects/p/issues/counts?q=62&q_mode=typed", "/api/v1/issues?q=ordinary&q_mode=typed", "/api/v1/issues?q=62", "/api/v1/issues?q=62&q=63&q_mode=typed", "/api/v1/issues?q=x&q_mode=typed"]) assert.equal(isExpensiveIssueRead(url(path)), true, path);
});

test("native rejection returns its independent policy and avoids both the read and D1 writes", async () => {
  const env = allowed(), caller = auth(), keys = [];
  env.EXPENSIVE_READ_RATE_LIMITER.limit = async input => { keys.push(input.key); return { success: false }; };
  await assert.rejects(withIssueReadProtection(env, caller, countUrl, async () => assert.fail("denied read ran")), error => error.status === 429 && error.retryAfterSeconds === 60 && error.details.policy === "expensive_read" && error.details.limit === 10);
  assert.deepEqual(keys, [caller.principalId]);
  assert.equal(await withIssueReadProtection(env, caller, url("/api/v1/issues?q=62&q_mode=typed"), async () => "cheap"), "cheap");
  assert.equal(keys.length, 1);
});

test("legacy missing binding is compatible but an invalid or failed configured binding fails closed", async () => {
  assert.equal(await withIssueReadProtection({}, auth(), countUrl, async () => "legacy"), "legacy");
  for (const env of [Object.assign(allowed(), { RATE_LIMIT_EXPENSIVE_READ_LIMIT: "" }), Object.assign(allowed(), { RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS: "30" }), Object.assign(allowed(), { EXPENSIVE_READ_RATE_LIMITER: { limit: async () => { throw new Error("binding failed"); } } })]) {
    await assert.rejects(withIssueReadProtection(env, auth(), countUrl, async () => assert.fail("unverified policy allowed read")), error => error.status === 503);
  }
});

test("two reads per Principal isolate other identities and release admission after exceptions", async () => {
  const env = allowed(), caller = auth();
  const releases = [];
  const blocked = () => new Promise(resolve => releases.push(resolve));
  const reads = [withIssueReadProtection(env, caller, countUrl, blocked), withIssueReadProtection(env, caller, countUrl, blocked)];
  try {
    await flush();
    assert.equal(releases.length, 2);
    await assert.rejects(withIssueReadProtection(env, caller, countUrl, async () => assert.fail("third concurrent read ran")), error => error.status === 429 && error.details.scope === "principal" && error.details.policy === "expensive_read_concurrency");
    assert.equal(await withIssueReadProtection(env, auth(), countUrl, async () => "other"), "other");
  } finally { releases.forEach(release => release()); await Promise.all(reads); }
  await assert.rejects(withIssueReadProtection(env, caller, countUrl, async () => { throw new Error("read failed"); }), /read failed/);
  assert.equal(await withIssueReadProtection(env, caller, countUrl, async () => "released"), "released");
});

test("isolate admission caps 32 in-flight expensive reads and releases every slot", async () => {
  const env = allowed(), callers = Array.from({ length: 16 }, auth), releases = [];
  const reads = callers.flatMap(caller => Array.from({ length: 2 }, () => withIssueReadProtection(env, caller, countUrl, () => new Promise(resolve => releases.push(resolve)))));
  try {
    await flush();
    assert.equal(releases.length, 32);
    await assert.rejects(withIssueReadProtection(env, auth(), countUrl, async () => assert.fail("33rd concurrent read ran")), error => error.status === 429 && error.details.scope === "instance" && error.details.observation_scope === "worker_isolate_best_effort");
    assert.equal(await withIssueReadProtection(env, auth(), url("/api/v1/issues?limit=20"), async () => "cheap"), "cheap");
  } finally { releases.forEach(release => release()); await Promise.all(reads); }
  assert.equal(await withIssueReadProtection(env, auth(), countUrl, async () => "released"), "released");
});
