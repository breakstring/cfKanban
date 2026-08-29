import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://kanban.example.test";
const ownerToken = `cfk_v1_rate_${"R".repeat(43)}`;
const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp08-rate-test.jsonc" }],
});

before(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  const { DB } = await worker.getEnv();
  await bootstrapInstance(DB, {
    instanceId: "88000000-0000-4000-8000-000000000001",
    operationId: "88000000-0000-4000-8000-000000000004",
    ownerCredentialId: "88000000-0000-4000-8000-000000000002",
    ownerCredentialToken: ownerToken,
    ownerDisplayName: "Rate Policy Owner",
    ownerPrincipalId: "88000000-0000-4000-8000-000000000003",
    preferredApiOrigin: origin,
  });
});

after(async () => {
  await server.close();
});

test("WP-08 non-default native binding, settings, and 429 envelope share one policy", async () => {
  const worker = server.getWorker();
  for (let index = 0; index < 7; index += 1) {
    const response = await worker.fetch(`${origin}/api/v1/web-authentication/options`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(response.status, 200, `sensitive request ${index + 1}`);
  }

  const limited = await worker.fetch(`${origin}/api/v1/web-authentication/options`, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const body = await limited.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(body.category, "rate_limit");
  assert.equal(body.retryable, true);
  assert.equal(body.recovery, "retry_after");
  assert.deepEqual(body.details, {
    limit: 7,
    period_seconds: 60,
    scope: "unauthenticated_sensitive",
  });

  const settings = await worker.fetch(`${origin}/api/v1/admin/rate-limit-settings`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(settings.status, 200);
  const settingsBody = await settings.json();
  assert.deepEqual(settingsBody.policies, {
    instance: { limit: 80, period_seconds: 60 },
    principal: { limit: 60, period_seconds: 60 },
    unauthenticated_sensitive: { limit: 7, period_seconds: 60 },
  });

  const openApi = await worker.fetch(`${origin}/openapi.json`);
  assert.equal(openApi.status, 200);
  const staticAsset = await worker.fetch(`${origin}/`);
  assert.equal(staticAsset.status, 200);
});
