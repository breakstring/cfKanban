import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const openapi = JSON.parse(await readFile(new URL("../contracts/openapi.json", import.meta.url), "utf8"));
const cases = JSON.parse(await readFile(new URL("../validation/error-normalization-cases.json", import.meta.url), "utf8"));
const errorSchema = openapi.components.schemas.Error;
const serverCategories = new Set(errorSchema.properties.category.enum);
const serverSources = new Set(errorSchema.properties.source.enum);

for (const testCase of cases.service_cases) {
  assert.ok(serverCategories.has(testCase.category), `${testCase.name}: category must be in OpenAPI`);
  assert.ok(serverSources.has(testCase.source), `${testCase.name}: source must be in OpenAPI`);
  assert.ok(testCase.code && testCase.recovery, `${testCase.name}: code and recovery are required`);
  if (testCase.retry_after_seconds !== undefined) {
    assert.equal(testCase.retryable, true, `${testCase.name}: Retry-After requires retryable=true`);
    assert.ok(testCase.retry_after_seconds >= 0, `${testCase.name}: retry delay must be non-negative`);
  }
}

for (const testCase of cases.client_normalized_cases) {
  assert.equal(testCase.normalized_by, "client", `${testCase.name}: external error must disclose client normalization`);
  assert.ok(["cloudflare_platform", "client_transport"].includes(testCase.source), `${testCase.name}: invalid external source`);
  assert.ok(testCase.code && testCase.category && testCase.recovery, `${testCase.name}: normalized result must remain actionable`);
  if (testCase.source === "client_transport") assert.equal(serverSources.has(testCase.source), false, "client-only source must not leak into OpenAPI server responses");
}

assert.equal(new Set(cases.client_normalized_cases.map((item) => item.observed)).size, cases.client_normalized_cases.length, "normalization inputs must be unambiguous");
console.log(`Error contract checks passed for ${cases.service_cases.length} Worker responses and ${cases.client_normalized_cases.length} client-normalized transport failures.`);
