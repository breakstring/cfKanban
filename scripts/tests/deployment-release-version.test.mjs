import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertReadback } from "../../packages/skill-runtime/src/deployment-finalize.mjs";
import { readServiceReleaseVersion } from "../../packages/skill-runtime/src/service-release-version.mjs";

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
