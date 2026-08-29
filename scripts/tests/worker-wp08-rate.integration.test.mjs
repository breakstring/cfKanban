import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://kanban.example.test";
const server = createTestHarness({
  root: repositoryRoot,
  workers: [{ configPath: "wrangler.wp08-rate-test.jsonc" }],
});

before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
});

after(async () => {
  await server.close();
});

test("WP-08 native unauthenticated-sensitive binding returns stable 429 without gating other surfaces", async () => {
  const worker = server.getWorker();
  for (let index = 0; index < 30; index += 1) {
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
    limit: 30,
    period_seconds: 60,
    scope: "unauthenticated_sensitive",
  });

  const openApi = await worker.fetch(`${origin}/openapi.json`);
  assert.equal(openApi.status, 200);
  const staticAsset = await worker.fetch(`${origin}/`);
  assert.equal(staticAsset.status, 200);
});
