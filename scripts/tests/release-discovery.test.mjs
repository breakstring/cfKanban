import assert from "node:assert/strict";
import test from "node:test";
import { discoverRelease, STABLE_RELEASE_POINTER } from "../../packages/skill-runtime/src/release-discovery.mjs";
import { sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";
import { getCommandCatalog } from "../../packages/skill-runtime/src/cli.mjs";

function release(version = "1.0.0") {
  const base = `https://github.com/breakstring/cfKanban/releases/download/${version}/`;
  const publisher = { id: "cfkanban", canonical_origin: "https://github.com" };
  const documents = { en: `${base}install.md`, "zh-CN": `${base}install.zh-CN.md` };
  const manifest = {
    schema_version: 1, product: "cfkanban", publisher, documents,
    release: { version, immutable: true },
    compatibility: { node: ">=22.12.0 <27", wrangler: ">=4.127.1 <5", service_api: ">=0.1.0 <0.2.0", schema_version: 10 },
    artifacts: ["skills", "service"].map((name) => ({
      kind: name === "skills" ? "skill_bundle" : "service_deployment_bundle",
      version, url: `${base}cfkanban-${name}-${version}.zip`, allowed_origins: ["https://github.com"], sha256: "a".repeat(64),
    })),
  };
  const pointer = {
    schema_version: 1, product: "cfkanban", publisher, documents,
    channel: version.includes("-") ? "prerelease" : "stable", release_version: version,
    manifest_url: `${base}cfkanban-release-${version}.json`, manifest_sha256: sha256Bytes(Buffer.from(JSON.stringify(manifest))),
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers, undefined);
    return new Response(JSON.stringify(url === pointer.manifest_url ? manifest : pointer));
  };
  return { pointer, manifest, calls, fetchImpl };
}

test("default discovery pins a stable snapshot without downloading bundles or mutating state", async () => {
  const remote = release();
  const result = await discoverRelease({}, remote);
  assert.deepEqual(remote.calls, [STABLE_RELEASE_POINTER, remote.pointer.manifest_url]);
  assert.equal(result.release_version, "1.0.0");
  assert.equal(result.release_pointer_url, "https://github.com/breakstring/cfKanban/releases/download/1.0.0/stable.json");
  assert.equal(result.marketplace.ref, "1.0.0");
  assert.equal(result.artifacts_verified, false);
  assert.equal(result.manifest_sha256, remote.pointer.manifest_sha256);
  remote.pointer.release_version = "1.0.1";
  assert.equal(result.pointer.release_version, "1.0.0", "Planning keeps the originally resolved snapshot");
});

test("explicit historical stable and prerelease selections use only that immutable target", async () => {
  for (const version of ["1.0.0", "1.1.0-rc.1"]) {
    const remote = release(version);
    assert.equal((await discoverRelease({ version }, remote)).release_version, version);
    assert.equal(remote.calls[0], `https://github.com/breakstring/cfKanban/releases/download/${version}/${version.includes("-") ? "prerelease" : "stable"}.json`);
  }
  for (const version of ["main", "latest", "../1.0.0", "1.0.0+build", 1]) {
    await assert.rejects(discoverRelease({ version }, { fetchImpl: () => assert.fail("Invalid selection must not fetch") }), { code: "INVALID_INPUT" });
  }
});

test("missing stable and network failure never fall back or expose remote error details", async () => {
  const calls = [];
  await assert.rejects(discoverRelease({}, { fetchImpl: async (url) => { calls.push(url); return new Response("missing", { status: 404 }); } }), { code: "RELEASE_DISCOVERY_UNAVAILABLE" });
  assert.deepEqual(calls, [STABLE_RELEASE_POINTER]);
  await assert.rejects(discoverRelease({}, { fetchImpl: async () => { throw new Error("signed-url-secret"); } }), (error) => error.code === "RELEASE_DISCOVERY_UNAVAILABLE" && !JSON.stringify(error).includes("signed-url-secret"));
});

test("discovery rejects prerelease at stable, other versions, mutable URLs and digest drift", async () => {
  await assert.rejects(discoverRelease({}, release("1.0.0-rc.1")), { code: "INVALID_RELEASE_DISCOVERY" });
  await assert.rejects(discoverRelease({ version: "1.0.1" }, release()), { code: "INVALID_RELEASE_DISCOVERY" });
  const remote = release();
  remote.pointer.manifest_url = "https://github.com/breakstring/cfKanban/raw/main/manifest.json";
  await assert.rejects(discoverRelease({}, remote), { code: "INVALID_RELEASE_DISCOVERY" });
  const drift = release();
  drift.manifest.compatibility.schema_version += 1;
  await assert.rejects(discoverRelease({}, drift), { code: "MANIFEST_DIGEST_MISMATCH" });
});

test("canonical identities, artifact paths and compatibility are checked beyond the hash", async () => {
  for (const corrupt of [
    (r) => { r.manifest.product = "other"; },
    (r) => { r.manifest.release.immutable = false; },
    (r) => { r.manifest.artifacts[0].url = "https://github.com/other/repo/skills.zip"; },
    (r) => { r.manifest.artifacts[0].version = "2.0.0"; },
    (r) => { delete r.manifest.compatibility; },
  ]) {
    const remote = release();
    corrupt(remote);
    remote.pointer.manifest_sha256 = sha256Bytes(Buffer.from(JSON.stringify(remote.manifest)));
    await assert.rejects(discoverRelease({}, remote), { code: "INVALID_RELEASE_DISCOVERY" });
  }
});

test("bounded anonymous GitHub redirects are allowed without returning signed locations", async () => {
  const remote = release();
  const signed = "https://release-assets.githubusercontent.com/assets/123?signature=private-redirect";
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers, undefined);
    if (url === STABLE_RELEASE_POINTER) return new Response(null, { status: 302, headers: { location: signed } });
    return remote.fetchImpl(url, options);
  };
  const result = await discoverRelease({}, { fetchImpl });
  assert.equal(JSON.stringify(result).includes("private-redirect"), false);
  for (const location of ["https://evil.example/pointer", "http://github.com/pointer", "https://user:password@github.com/pointer"]) {
    let calls = 0;
    await assert.rejects(discoverRelease({}, { fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location } }); } }), { code: "INVALID_RELEASE_DISCOVERY" });
    assert.equal(calls, 1);
  }
  await assert.rejects(discoverRelease({}, { fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1)) }), { code: "INVALID_RELEASE_DISCOVERY" });
});

test("discovery is exposed only through the deployment skill", () => {
  assert.ok(getCommandCatalog({ surface: "deploy" }).commands.some((command) => command.name === "release discover"));
  for (const surface of ["daily", "admin"]) assert.equal(getCommandCatalog({ surface }).commands.some((command) => command.name === "release discover"), false);
});
