import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeFrozenWranglerConfig } from "../../packages/skill-runtime/src/deployment-config.mjs";
import { serializeError } from "../../packages/skill-runtime/src/errors.mjs";
import { authorizeJournal, createJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { createStrictZeroPlan } from "../../packages/skill-runtime/src/plan.mjs";
import { installVerifiedServiceBundle } from "../../packages/skill-runtime/src/service-bundle.mjs";
import { createInstanceUpgradePlan } from "../../packages/skill-runtime/src/upgrade-plan.mjs";
import { canonicalDigest, sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";
import { normalizeObservedWorkerObservability, normalizePlannedWorkerObservability } from "../../packages/skill-runtime/src/worker-observability.mjs";
import { writeDeterministicZip } from "../lib/deterministic-zip.mjs";

const INSTANCE = "11111111-1111-4111-8111-111111111111";
const DATABASE = "88888888-8888-4888-8888-888888888888";
const OBSERVED = {
  enabled: false, head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 0.25, invocation_logs: true, persist: true, destinations: ["logs-destination"] },
  traces: { enabled: false, head_sampling_rate: 0, persist: false, destinations: [] },
  redact_query_string: false,
};

function upgradeInput(observability = null) {
  const policies = [["INSTANCE", "1002", "300"], ["PRINCIPAL", "1001", "120"], ["UNAUTHENTICATED_SENSITIVE", "1003", "30"]];
  const bindings = [{ type: "assets", name: "ASSETS", value_redacted: true }, { type: "d1", name: "DB", database_id: DATABASE }, ...policies.flatMap(([key, namespace_id, text]) => [
    { type: "plain_text", name: `RATE_LIMIT_${key}_LIMIT`, text },
    { type: "plain_text", name: `RATE_LIMIT_${key}_PERIOD_SECONDS`, text: "60" },
    { type: "ratelimit", name: `${key.replace("_SENSITIVE", "")}_RATE_LIMITER`, namespace_id },
  ])];
  const current = { publisher: "https://releases.example.test", manifest_version: "0.1.0-alpha.1", manifest_sha256: "a".repeat(64), service_bundle_version: "0.1.0-alpha.1", service_bundle_sha256: "b".repeat(64), service_bundle_source: "https://releases.example.test/old.zip", service_api_version: "0.1.0", schema_version: 1 };
  return {
    taskId: "preserve-observability", instanceId: INSTANCE, operationId: randomUUID(),
    cloudflare: { account_id: "isolated-account", account_label: "Fixture", profile: "isolated", api_origin: "https://example.workers.dev" },
    resources: { worker: { name: "board", deployment_id: randomUUID(), version_id: randomUUID(), bindings, worker_limits: null, observability }, d1: { name: "board-db", database_id: DATABASE }, workers_dev: true, custom_domain: null, routes: [], pages: false },
    bindings: { d1: "DB", assets: "ASSETS" },
    owner: { display_name: "Example_Owner", principal_id: randomUUID(), credential_id: randomUUID(), credential_fingerprint: "fixture-only" },
    current,
    target: { ...current, manifest_version: "0.1.0-alpha.2", manifest_sha256: "c".repeat(64), service_bundle_version: "0.1.0-alpha.2", service_bundle_sha256: "d".repeat(64), service_bundle_source: "https://releases.example.test/new.zip", migration_manifest_sha256: "e".repeat(64), compatibility: { node: ">=22.12.0 <27", wrangler: ">=4.127.1 <5", service_api: ">=0.1.0 <0.2.0", schema_version: 1 } },
    restorePoint: { required: false, verified: false, bookmark: null, observed_at: null, reason: "no_migration_delta" },
  };
}

test("observability preserves every known field and mixed global/log switches without filling defaults", () => {
  const input = structuredClone(OBSERVED);
  const normalized = normalizeObservedWorkerObservability(input);
  assert.deepEqual(normalized, OBSERVED);
  input.logs.enabled = false; input.logs.destinations.push("later-destination");
  assert.deepEqual(normalized, OBSERVED);
  for (const sparse of [{ enabled: true }, { logs: { enabled: true } }, { traces: { enabled: true } }]) assert.deepEqual(normalizeObservedWorkerObservability(sparse), sparse);
  for (const absent of [null, undefined]) assert.deepEqual(normalizeObservedWorkerObservability(absent), { enabled: false });
});

test("observability rejects invalid switches, rates, objects and destinations without reflecting input", () => {
  for (const value of [false, [], "PRIVATE-TEST-MARKER", {}, { head_sampling_rate: 1 }, { enabled: 1 }, { enabled: true, head_sampling_rate: NaN }, { enabled: true, head_sampling_rate: Infinity }, { enabled: true, head_sampling_rate: -0.1 }, { enabled: true, head_sampling_rate: 1.1 }, { enabled: true, logs: null }, { logs: { enabled: true, invocation_logs: "PRIVATE-TEST-MARKER" } }, { traces: { enabled: false, persist: null } }, { logs: { enabled: true, destinations: [null] } }, { logs: { enabled: true, destinations: Array(1) } }, { logs: { enabled: true, destinations: "PRIVATE-TEST-MARKER" } }, { enabled: true, redact_query_string: "PRIVATE-TEST-MARKER" }]) {
    assert.throws(() => normalizeObservedWorkerObservability(value), error => {
      assert.equal(error.code, "WORKER_OBSERVABILITY_READBACK_INVALID");
      assert.doesNotMatch(JSON.stringify(serializeError(error)), /PRIVATE-TEST-MARKER/);
      return true;
    });
  }
});

test("observability refuses unknown top-level and nested fields without dropping or exposing them", () => {
  for (const value of [{ enabled: true, "PRIVATE-TEST-MARKER": "PRIVATE-TEST-MARKER" }, { enabled: true, logs: { secret: "PRIVATE-TEST-MARKER" } }, { traces: { enabled: false, future_field: "PRIVATE-TEST-MARKER" } }]) {
    assert.throws(() => normalizeObservedWorkerObservability(value), error => {
      assert.equal(error.code, "WORKER_OBSERVABILITY_UNSUPPORTED_FIELD");
      assert.doesNotMatch(JSON.stringify(serializeError(error)), /PRIVATE-TEST-MARKER/);
      return true;
    });
  }
});

test("new upgrades require explicit observability readback and freeze canonical disabled or complete settings", () => {
  const input = upgradeInput();
  assert.deepEqual(createInstanceUpgradePlan(input).resources.worker.observability, { enabled: false });
  delete input.resources.worker.observability;
  assert.throws(() => createInstanceUpgradePlan(input), { code: "WORKER_OBSERVABILITY_READBACK_REQUIRED" });
  input.resources.worker.observability = undefined;
  assert.throws(() => createInstanceUpgradePlan(input), { code: "WORKER_OBSERVABILITY_READBACK_REQUIRED" });
  input.resources.worker.observability = structuredClone(OBSERVED);
  const plan = createInstanceUpgradePlan(input);
  assert.deepEqual(plan.resources.worker.observability, OBSERVED);
  input.resources.worker.observability.logs.enabled = false;
  assert.deepEqual(plan.resources.worker.observability, OBSERVED);
  const historical = structuredClone(plan); delete historical.resources.worker.observability;
  assert.equal(normalizePlannedWorkerObservability(historical), undefined);
  assert.equal(normalizePlannedWorkerObservability({ kind: "strict_zero_deploy" }), undefined);
});

test("observability settings participate in the authorization plan digest", () => {
  const input = upgradeInput(structuredClone(OBSERVED));
  const original = canonicalDigest(createInstanceUpgradePlan(input));
  for (const change of [value => { value.enabled = true; }, value => { value.head_sampling_rate = 0; }, value => { value.logs.invocation_logs = false; }, value => { value.logs.head_sampling_rate = 1; }, value => { value.logs.persist = false; }, value => { value.logs.destinations.push("another"); }, value => { value.traces.enabled = true; }, value => { value.traces.head_sampling_rate = 1; }, value => { value.traces.persist = true; }, value => { value.traces.destinations.push("traces-destination"); }, value => { value.redact_query_string = true; }]) {
    input.resources.worker.observability = structuredClone(OBSERVED); change(input.resources.worker.observability);
    assert.notEqual(canonicalDigest(createInstanceUpgradePlan(input)), original);
  }
});

async function configFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cfkanban-observability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const files = {
    "dist/index.js": "export default {};\n", "apps/web/dist/index.html": "<!doctype html>\n",
    "contracts/openapi.json": JSON.stringify({ info: { version: "0.1.0" } }),
    "migrations/manifest.json": JSON.stringify({ manifest_version: 1, schema_version: 1, migrations: [] }),
    "release/deployment/migration-readback.sql": "SELECT 1;\n", "wrangler-config-schema.json": "{}\n",
    "wrangler.template.json": JSON.stringify({ compatibility_date: "2026-08-29", assets: { binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] } }),
  };
  for (const [entry, content] of Object.entries(files)) {
    const target = path.join(source, entry); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
  }
  const bundle = path.join(root, "service.zip");
  await writeDeterministicZip({ root: source, outputPath: bundle, prefix: "service/" });
  const input = upgradeInput(structuredClone(OBSERVED));
  input.target.service_bundle_sha256 = sha256Bytes(await readFile(bundle));
  const installed = await installVerifiedServiceBundle({ bundlePath: bundle, version: input.target.service_bundle_version, expectedSha256: input.target.service_bundle_sha256, publisher: input.target.publisher, source: input.target.service_bundle_source, releaseRoot: path.join(root, "service-releases") });
  const stateRoot = path.join(root, "state");
  const write = async plan => {
    await createJournal({ stateRoot, instanceId: INSTANCE, operationId: plan.operation_id, plan });
    await authorizeJournal({ stateRoot, instanceId: INSTANCE, operationId: plan.operation_id, taskId: plan.task_id, planDigest: canonicalDigest(plan) });
    return writeFrozenWranglerConfig({ stateRoot, instanceId: INSTANCE, operationId: plan.operation_id, taskId: plan.task_id, plan, serviceBundleRoot: installed.path, d1DatabaseId: DATABASE });
  };
  return { input, write, stateRoot, bundleRoot: installed.path };
}

test("upgrade config writes the frozen observability object while new and historical defaults stay unchanged", async t => {
  const { input, write } = await configFixture(t);
  for (const observed of [OBSERVED, null]) {
    const plan = createInstanceUpgradePlan({ ...input, operationId: randomUUID(), resources: { ...input.resources, worker: { ...input.resources.worker, observability: observed } } });
    const written = await write(plan);
    assert.deepEqual(JSON.parse(await readFile(written.wrangler_config_path, "utf8")).observability, plan.resources.worker.observability);
  }
  const historical = createInstanceUpgradePlan({ ...input, operationId: randomUUID() });
  delete historical.resources.worker.observability;
  const strict = createStrictZeroPlan({ taskId: input.taskId, accountId: "isolated-account", instanceId: INSTANCE, ownerDisplayName: "Example_Owner", release: input.target }).plan;
  for (const plan of [historical, strict]) {
    const written = await write(plan);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(written.wrangler_config_path, "utf8")), "observability"), false);
  }
});

test("changing frozen observability cannot reuse an existing deployment authorization", async t => {
  const { input, write, stateRoot, bundleRoot } = await configFixture(t);
  const plan = createInstanceUpgradePlan(input);
  await write(plan);
  plan.resources.worker.observability.logs.enabled = false;
  await assert.rejects(writeFrozenWranglerConfig({ stateRoot, instanceId: INSTANCE, operationId: plan.operation_id, taskId: plan.task_id, plan, serviceBundleRoot: bundleRoot, d1DatabaseId: DATABASE }), { code: "PLAN_NOT_AUTHORIZED" });
});
