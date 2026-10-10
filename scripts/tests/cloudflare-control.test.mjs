import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareControlClient } from "../../packages/skill-runtime/src/cloudflare-control.mjs";

function fixture(overrides = {}) {
  const authCalls = [];
  const requests = [];
  const input = {
    accountId: "isolated-account",
    cloudflareProfile: "frozen-profile",
    wranglerExecutable: "/mock/wrangler",
    environment: {},
    tokenRunner: async (executable, args, options) => {
      authCalls.push({ executable, args, environment: options.env });
      return { stdout: JSON.stringify({ type: "oauth", token: `fixture-token-${authCalls.length}` }) };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ success: true, result: { readback: true } }));
    },
    ...overrides,
  };
  return { input, authCalls, requests };
}

test("control clients retain cached authentication by default", async () => {
  const f = fixture();
  const client = await createCloudflareControlClient(f.input);
  await client("/first");
  await client("/second", { method: "PUT", body: { enabled: true } });
  assert.equal(f.authCalls.length, 1);
  assert.equal(f.authCalls[0].environment.WRANGLER_SEND_METRICS, undefined);
  assert.deepEqual(f.requests.map(({ options }) => options.headers.Authorization), ["Bearer fixture-token-1", "Bearer fixture-token-1"]);
});

test("opt-in authentication refresh loads the frozen profile before each request", async () => {
  const f = fixture({ refreshAuth: true, environment: { WRANGLER_SEND_METRICS: "true" } });
  const client = await createCloudflareControlClient(f.input, "/d1/database/isolated-db", { errorPrefix: "TRENDS", resourceLabel: "trend backfill" });
  f.input.cloudflareProfile = "changed-profile";
  f.input.wranglerExecutable = "/changed/wrangler";
  f.input.environment.CLOUDFLARE_API_TOKEN = "untrusted-replacement";
  await client("/query", { method: "POST", body: { sql: "SELECT 1" } });
  await client("/query", { method: "POST", body: { sql: "SELECT 2" } });
  assert.equal(f.authCalls.length, 3);
  for (const call of f.authCalls) {
    assert.equal(call.executable, "/mock/wrangler");
    assert.deepEqual(call.args, ["auth", "token", "--json", "--profile", "frozen-profile"]);
    assert.equal(call.environment.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(call.environment.WRANGLER_WRITE_LOGS, "false");
    assert.equal(call.environment.WRANGLER_SEND_METRICS, "false");
  }
  assert.deepEqual(f.requests.map(({ options }) => options.headers.Authorization), ["Bearer fixture-token-2", "Bearer fixture-token-3"]);
});

test("authentication refresh failure prevents the request and hides credential diagnostics", async () => {
  let authCount = 0;
  const f = fixture({ refreshAuth: true, tokenRunner: async () => {
    authCount++;
    if (authCount > 1) throw new Error("private-token-and-stderr");
    return { stdout: JSON.stringify({ type: "oauth", token: "fixture-initial-token" }) };
  } });
  const client = await createCloudflareControlClient(f.input, "/d1/database/isolated-db", { errorPrefix: "TRENDS", resourceLabel: "trend backfill" });
  await assert.rejects(client("/query", { method: "POST", body: { sql: "UPDATE isolated SET value = 1" } }), (error) => {
    assert.equal(error.code, "TRENDS_AUTH_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(error), /private-token|stderr|fixture-initial-token/u);
    return true;
  });
  assert.equal(authCount, 2);
  assert.equal(f.requests.length, 0);
});

test("authentication refresh does not retry a failed Cloudflare write", async () => {
  let requestCount = 0;
  const f = fixture({ refreshAuth: true, fetchImpl: async () => {
    requestCount++;
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 401 });
  } });
  const client = await createCloudflareControlClient(f.input);
  await assert.rejects(client("/isolated-bucket", { method: "PUT", body: { enabled: true } }), { code: "R2_CONTROL_FAILED" });
  assert.equal(requestCount, 1);
  assert.equal(f.authCalls.length, 2);
});
