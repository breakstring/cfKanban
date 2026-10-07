import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertReadback } from "../../packages/skill-runtime/src/deployment-finalize.mjs";
import { readServiceReleaseVersion } from "../../packages/skill-runtime/src/service-release-version.mjs";
import { readServiceApiVersion } from "../../packages/skill-runtime/src/service-api-version.mjs";
import { createStrictZeroPlan } from "../../packages/skill-runtime/src/plan.mjs";

test("first deployment enables Owner control only for an explicitly frozen supported schema", () => {
  const input = { taskId: "owner-control-schema", accountId: "account-fixture", ownerDisplayName: "Fixture_Owner", release: { manifest_version: "1.10.1", manifest_sha256: "a".repeat(64), service_bundle_version: "1.10.1", service_bundle_sha256: "b".repeat(64) } };
  assert.equal(createStrictZeroPlan(input).plan.cloudflare_control, undefined);
  assert.equal(createStrictZeroPlan({ ...input, release: { ...input.release, schema_version: 24 } }).plan.cloudflare_control, undefined);
  const supported = createStrictZeroPlan({ ...input, release: { ...input.release, schema_version: 26 } }).plan;
  assert.deepEqual(supported.cloudflare_control, { enabled: true, history_enabled: false });
  assert.equal(supported.release.schema_version, 26);
  assert.throws(() => createStrictZeroPlan({ ...input, release: { ...input.release, schema_version: "26" } }), { code: "INVALID_DEPLOYMENT_RELEASE" });
});

async function bundle(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cfkanban-product-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"));
  return { root, file: path.join(root, "release/version.json") };
}

function readback(releaseVersion = "1.0.0") {
  const origin = "https://release-test.workers.dev";
  const versionFields = { service_version: "0.1.0", ...(releaseVersion == null ? {} : { release_version: releaseVersion }) };
  const facts = { instance: "instance", principalId: "owner", credentialId: "credential", displayName: "Release_Owner" };
  return {
    origin, facts,
    contract: { releaseVersion, serviceVersion: "0.1.0", schemaVersion: 10 },
    health: { ...versionFields, d1: "reachable", schema_version: 10 },
    discovery: { ...versionFields, instance_id: facts.instance, preferred_api_origin: origin, origin_version: 1 },
    meta: { ...versionFields, instance_id: facts.instance, observed_origin: origin, preferred_api_origin: origin, origin_version: 1, schema_version: 10, principal: { id: facts.principalId, is_owner: true } },
    me: { id: facts.principalId, principal_id: facts.principalId, display_name: facts.displayName, is_owner: true, credential: { id: facts.credentialId, fingerprint: "verified-fingerprint" } },
  };
}

test("historical bundles without a release declaration retain API/schema readback", async (t) => {
  const fixture = await bundle(t);
  assert.equal(await readServiceReleaseVersion(fixture.root, "1.0.0-rc.7"), null);
  assert.deepEqual(assertReadback(readback(null)), { fingerprint: "verified-fingerprint" });
  const wrongApi = readback(null);
  wrongApi.meta.service_version = "0.2.0";
  assert.throws(() => assertReadback(wrongApi), { code: "DEPLOYMENT_META_MISMATCH" });
});

test("new bundle declarations must agree with the authorized service bundle version", async (t) => {
  const fixture = await bundle(t);
  await writeFile(fixture.file, JSON.stringify({ version: "1.0.0" }));
  assert.equal(await readServiceReleaseVersion(fixture.root, "1.0.0"), "1.0.0");
  await assert.rejects(readServiceReleaseVersion(fixture.root, "1.1.0"), { code: "DEPLOYMENT_RELEASE_DRIFT" });
  for (const malformed of ["null", "{}", '{"version":10}', "invalid-json"]) {
    await writeFile(fixture.file, malformed);
    await assert.rejects(readServiceReleaseVersion(fixture.root, "1.0.0"));
  }
});

test("release declaration cannot escape through a symlink", async (t) => {
  const fixture = await bundle(t);
  const target = path.join(fixture.root, "target.json");
  await writeFile(target, JSON.stringify({ version: "1.0.0" }));
  await symlink(target, fixture.file);
  await assert.rejects(readServiceReleaseVersion(fixture.root, "1.0.0"));
});

test("finalization accepts product and API versions independently when every endpoint agrees", () => {
  assert.deepEqual(assertReadback(readback()), { fingerprint: "verified-fingerprint" });
});

for (const [endpoint, code] of [["health", "DEPLOYMENT_HEALTH_MISMATCH"], ["discovery", "DEPLOYMENT_DISCOVERY_MISMATCH"], ["meta", "DEPLOYMENT_META_MISMATCH"]]) {
  test(`finalization rejects missing or stale product version in ${endpoint}`, () => {
    for (const releaseVersion of [undefined, "1.0.0-rc.7", "0.1.0"]) {
      const input = readback();
      if (releaseVersion === undefined) delete input[endpoint].release_version;
      else input[endpoint].release_version = releaseVersion;
      assert.throws(() => assertReadback(input), { code });
    }
  });
}

async function apiBundle(t, { legacy = false } = {}) {
  const fixture = await bundle(t);
  await mkdir(path.join(fixture.root, "contracts"));
  await mkdir(path.join(fixture.root, "migrations"));
  const declaration = path.join(fixture.root, "contracts/service-api.json");
  const openapi = path.join(fixture.root, "contracts/openapi.json");
  const migrations = path.join(fixture.root, "migrations/manifest.json");
  await writeFile(fixture.file, JSON.stringify({ version: "1.4.0-rc.2" }));
  if (!legacy) await writeFile(declaration, JSON.stringify({ service_version: "0.1.0" }));
  await writeFile(openapi, JSON.stringify({ info: { version: legacy ? "0.1.0" : "1.4.0-rc.2" }, ...(!legacy ? { "x-cfkanban-service-version": "0.1.0" } : {}) }));
  await writeFile(migrations, JSON.stringify({ service_compatibility: { minimum: "0.1.0", maximum_exclusive: "0.2.0" } }));
  return { ...fixture, declaration, openapi, migrations, read: (options = {}) => readServiceApiVersion(fixture.root, { expectedReleaseVersion: "1.4.0-rc.2", ...options }) };
}

test("Service API version supports legacy and independent declarations without treating a product version as an API", async (t) => {
  for (const legacy of [true, false]) {
    const fixture = await apiBundle(t, { legacy });
    assert.equal(await fixture.read({ serviceApiRange: ">=0.1.0 <0.2.0", expectedApiVersion: "0.1.0" }), "0.1.0");
    await assert.rejects(fixture.read({ expectedApiVersion: "0.1.1" }), { code: "DEPLOYMENT_SERVICE_VERSION_DRIFT" });
    await assert.rejects(fixture.read({ serviceApiRange: ">=1.0.0 <2.0.0" }), { code: "DEPLOYMENT_SERVICE_VERSION_DRIFT" });
    await writeFile(fixture.migrations, JSON.stringify({ service_compatibility: { minimum: "0.2.0", maximum_exclusive: "0.3.0" } }));
    await assert.rejects(fixture.read(), { code: "DEPLOYMENT_SERVICE_VERSION_DRIFT" });
  }
  const legacy = await apiBundle(t, { legacy: true });
  for (const version of ["1.4.0-rc.2", "1.4.0", "0.1.0-rc.2"]) {
    await writeFile(legacy.openapi, JSON.stringify({ info: { version } }));
    await assert.rejects(legacy.read(), { code: "SERVICE_API_DECLARATION_REQUIRED" });
  }
});

test("new Service version contracts fail closed on missing, conflicting or malformed declarations", async (t) => {
  const fixture = await apiBundle(t);
  for (const declaration of [null, {}, { service_version: "0.2.0" }, { service_version: "1.4.0-rc.2" }]) {
    await writeFile(fixture.declaration, JSON.stringify(declaration));
    await assert.rejects(fixture.read(), { code: "SERVICE_API_DECLARATION_MISMATCH" });
  }
  await writeFile(fixture.declaration, "invalid-json");
  await assert.rejects(fixture.read(), { code: "SERVICE_BUNDLE_INCOMPLETE" });
  await rm(fixture.declaration);
  await assert.rejects(fixture.read(), { code: "SERVICE_API_DECLARATION_MISMATCH" });
  await writeFile(fixture.declaration, JSON.stringify({ service_version: "0.1.0" }));
  await writeFile(fixture.openapi, JSON.stringify({ info: { version: "1.4.0-rc.2" } }));
  await assert.rejects(fixture.read(), { code: "SERVICE_API_DECLARATION_MISMATCH" });
  await writeFile(fixture.openapi, JSON.stringify({ info: { version: "0.1.0" }, "x-cfkanban-service-version": "0.1.0" }));
  await assert.rejects(fixture.read(), { code: "DEPLOYMENT_RELEASE_DRIFT" });
  await writeFile(fixture.openapi, JSON.stringify({ info: { version: "1.4.0-rc.2" }, "x-cfkanban-service-version": "0.1.0" }));
  await rm(fixture.file);
  await assert.rejects(fixture.read(), { code: "DEPLOYMENT_RELEASE_DRIFT" });
});

test("independent API declaration cannot escape the immutable Service bundle through a symlink", async (t) => {
  const fixture = await apiBundle(t);
  await rm(fixture.declaration);
  await symlink(fixture.file, fixture.declaration);
  await assert.rejects(fixture.read());
});
