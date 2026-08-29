import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
const workerBuild = await readFile(new URL("./build-worker.mjs", import.meta.url), "utf8");
const workerConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

assert.match(workflow, /^permissions:\n  contents: read$/m, "CI permissions must remain read-only");
assert.match(workflow, /run: npm ci/, "CI must install from the root lockfile");
assert.match(workflow, /run: npm run validate/, "CI must use the root validation entrypoint");

const forbiddenWorkflowPatterns = [
  [/\bsecrets\s*\./i, "GitHub secrets references"],
  [/CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/i, "Cloudflare credential variables"],
  [/\bwrangler\s+(?:deploy|publish)\b(?![^\n]*--dry-run)/i, "remote Wrangler deployment"],
  [/\bwrangler\b[^\n]*--remote\b/i, "remote Wrangler execution"],
  [/^\s*environment\s*:/im, "credential-bearing GitHub environment"],
];

for (const [pattern, label] of forbiddenWorkflowPatterns) {
  assert.doesNotMatch(workflow, pattern, `CI verification must not contain ${label}`);
}

assert.match(workerBuild, /"--dry-run"/, "Worker build must remain a dry run");
assert.doesNotMatch(workerBuild, /"--remote"/, "Worker build must not target remote resources");

assert.equal(workerConfig.account_id, undefined, "source Worker config must not pin a Cloudflare account");
assert.equal(workerConfig.routes, undefined, "source Worker config must not create routes");
assert.equal(workerConfig.assets?.directory, "./apps/web/dist");
assert.equal(workerConfig.assets?.binding, "ASSETS");
assert.equal(workerConfig.assets?.not_found_handling, "single-page-application");
for (const route of ["/api/*", "/healthz", "/openapi.json", "/invite", "/app/launch", "/.well-known/*"]) {
  assert.ok(workerConfig.assets?.run_worker_first?.includes(route), `dynamic route must run Worker first: ${route}`);
}
assert.deepEqual(
  workerConfig.ratelimits.map(({ name, simple }) => ({ name, ...simple })),
  [
    { name: "PRINCIPAL_RATE_LIMITER", limit: 120, period: 60 },
    { name: "INSTANCE_RATE_LIMITER", limit: 300, period: 60 },
    { name: "UNAUTHENTICATED_RATE_LIMITER", limit: 30, period: 60 },
  ],
  "source Worker config must preserve the Frozen zero-parameter rate-limit profile",
);

console.log("Credential-free CI and same-Worker Static Assets configuration checks passed.");
