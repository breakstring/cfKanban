import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digest, publicationPlan, publishRelease } from "../lib/release-publication.mjs";
import { githubClient, verifyPublicDownload } from "../lib/github-release.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cfkanban-publish-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = "0.1.0-alpha.99";
  const repository = "breakstring/cfKanban";
  const commit = "a".repeat(40);
  const base = `https://github.com/${repository}/releases/download/${version}/`;
  const names = [`cfkanban-skills-${version}.zip`, `cfkanban-service-${version}.zip`];
  const documents = { en: `${base}install.md`, "zh-CN": `${base}install.zh-CN.md` };
  const publisher = { id: "cfkanban", canonical_origin: "https://github.com" };
  const manifest = {
    schema_version: 1, product: "cfkanban", publisher, release: { version, immutable: true }, documents,
    artifacts: names.map((name, index) => ({ kind: index ? "service_deployment_bundle" : "skill_bundle", version, url: `${base}${name}`, allowed_origins: ["https://github.com"], sha256: digest(name) })),
  };
  const manifestBytes = JSON.stringify(manifest);
  const manifestName = `cfkanban-release-${version}.json`;
  const pointer = { schema_version: 1, product: "cfkanban", publisher, release_version: version, channel: "prerelease", manifest_url: `${base}${manifestName}`, manifest_sha256: digest(manifestBytes), documents };
  for (const [name, bytes] of [["prerelease.json", JSON.stringify(pointer)], [manifestName, manifestBytes], ...names.map((name) => [name, name]), ["install.md", "# Install"], ["install.zh-CN.md", "# 安装"]]) await writeFile(path.join(directory, name), bytes);
  const config = { repository, version, commit, directory, notes: "测试发布恢复" };
  return { config, plan: await publicationPlan(config) };
}

function remote(plan) {
  const state = { release: null, assets: [], writes: [], failure: null, publicChecks: 0 };
  const copy = (value) => structuredClone(value);
  const fault = (phase) => { if (state.failure === phase) { state.failure = null; throw new Error(`simulated ${phase}`); } };
  const client = {
    tagCommit: async () => plan.commit,
    findRelease: async () => copy(state.release),
    readRelease: async () => copy(state.release),
    listAssets: async () => copy(state.assets),
    createDraft: async () => {
      fault("create_before");
      state.writes.push("create");
      state.release = { id: 123, tag_name: plan.version, prerelease: plan.prerelease, name: plan.version, body: plan.notes, draft: true };
      fault("create_after");
      return copy(state.release);
    },
    upload: async (_plan, _id, asset) => {
      fault(`upload_before:${asset.name}`);
      state.writes.push(`upload:${asset.name}`);
      assert.equal(state.release.draft, true);
      assert.equal(state.assets.some((value) => value.name === asset.name), false);
      state.assets.push({ id: state.assets.length + 1, name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}`, state: "uploaded" });
      fault(`upload_after:${asset.name}`);
    },
    publish: async () => {
      fault("publish_before");
      assert.equal(state.assets.length, 6);
      state.writes.push("publish");
      state.release.draft = false;
      fault("publish_after");
    },
  };
  const verifyPublic = async () => { state.publicChecks += 1; fault("public_verify"); };
  return { state, client, run: (mode, options = {}) => publishRelease({ plan, github: client, mode, verifyPublic, ...options }) };
}

test("publication inspect is read-only; stage keeps a complete draft; publish is separately verified", async (t) => {
  const { plan } = await fixture(t), backend = remote(plan);
  assert.equal((await backend.run("inspect")).state, "absent");
  assert.deepEqual(backend.state.writes, []);
  await assert.rejects(backend.run("publish"), /stage before publishing/);
  assert.equal((await backend.run("stage")).state, "draft_verified");
  assert.equal(backend.state.release.draft, true);
  const writes = [...backend.state.writes];
  await backend.run("stage");
  assert.deepEqual(backend.state.writes, writes);
  assert.equal((await backend.run("publish")).state, "published_verified");
  const publishedWrites = [...backend.state.writes];
  for (const mode of ["inspect", "stage", "publish"]) {
    assert.equal((await backend.run(mode)).changed, false);
    assert.deepEqual(backend.state.writes, publishedWrites);
  }
  assert.equal(backend.state.publicChecks, 4);
});

for (const phase of ["create_before", "create_after", "publish_before", "publish_after", "public_verify"]) {
  test(`same plan resumes after ${phase}, without duplicate create/publish`, async (t) => {
    const { plan } = await fixture(t), backend = remote(plan);
    if (!phase.startsWith("create")) await backend.run("stage");
    backend.state.failure = phase;
    await assert.rejects(backend.run(phase.startsWith("create") ? "stage" : "publish"), /simulated/);
    if (phase.startsWith("create")) await backend.run("stage");
    await backend.run("publish");
    assert.equal(backend.state.writes.filter((write) => write === "create").length, 1);
    assert.equal(backend.state.writes.filter((write) => write === "publish").length, 1);
    assert.equal(backend.state.assets.length, 6);
  });
}

test("every upload can stop before or after commit and resume only missing assets", async (t) => {
  const { plan } = await fixture(t);
  for (const asset of plan.assets) for (const point of ["before", "after"]) {
    const backend = remote(plan);
    backend.state.failure = `upload_${point}:${asset.name}`;
    await assert.rejects(backend.run("stage"), /simulated/);
    assert.equal(backend.state.release.draft, true);
    assert.equal(backend.state.writes.includes("publish"), false);
    await backend.run("stage");
    assert.equal(backend.state.assets.length, 6);
    for (const item of plan.assets) assert.equal(backend.state.writes.filter((value) => value === `upload:${item.name}`).length, 1);
  }
});

for (const corruption of ["digest", "size", "state", "extra", "duplicate", "missing_published", "channel", "draft_notes"]) {
  test(`remote ${corruption} stops without clobber/delete/publish`, async (t) => {
    const { plan } = await fixture(t), backend = remote(plan);
    await backend.run("stage");
    if (["digest", "size", "state"].includes(corruption)) backend.state.assets[0][corruption] = corruption === "size" ? 0 : "invalid";
    if (corruption === "extra") backend.state.assets.push({ id: 999, name: "extra.txt" });
    if (corruption === "duplicate") backend.state.assets.push({ ...backend.state.assets[0], id: 999 });
    if (corruption === "missing_published") { backend.state.release.draft = false; backend.state.assets.pop(); }
    if (corruption === "channel") backend.state.release.prerelease = false;
    if (corruption === "draft_notes") backend.state.release.body = "foreign draft";
    const before = [...backend.state.writes];
    await assert.rejects(backend.run("publish"));
    assert.deepEqual(backend.state.writes, before);
  });
}

test("tag drift, read failure, missing verifier and local drift never authorize writes", async (t) => {
  const { plan } = await fixture(t);
  const backend = remote(plan);
  backend.client.tagCommit = async () => "b".repeat(40);
  await assert.rejects(backend.run("stage"), /pinned commit/);
  assert.deepEqual(backend.state.writes, []);
  backend.client.tagCommit = async () => plan.commit;
  backend.client.findRelease = async () => { throw new Error("read unavailable"); };
  await assert.rejects(backend.run("stage"), /read unavailable/);
  assert.deepEqual(backend.state.writes, []);
  backend.client.findRelease = async () => backend.state.release;
  await backend.run("stage");
  await assert.rejects(backend.run("publish", { verifyPublic: undefined }), /Public verification/);
  await writeFile(plan.assets[0].file, "changed");
  const before = [...backend.state.writes];
  await assert.rejects(backend.run("publish"), /Local asset drift/);
  assert.deepEqual(backend.state.writes, before);
});

test("concurrent publication or disappearing verified assets stops further uploads", async (t) => {
  const { plan } = await fixture(t);
  const backend = remote(plan);
  const upload = backend.client.upload;
  backend.client.upload = async (...args) => { await upload(...args); backend.state.release.draft = false; };
  await assert.rejects(backend.run("stage"), /published concurrently/);
  assert.equal(backend.state.assets.length, 1);
  const removed = remote(plan);
  const originalUpload = removed.client.upload;
  removed.client.upload = async (...args) => {
    await originalUpload(...args);
    if (removed.state.assets.length === 2) removed.state.assets.shift();
  };
  await assert.rejects(removed.run("stage"), /upload disappeared/);
  assert.equal(removed.state.writes.filter((value) => value.startsWith("upload:")).length, 2);
});

test("public verifier downloads all six files and validates downloaded pointer and artifacts", async (t) => {
  const { plan } = await fixture(t);
  const fetched = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers, undefined, "Public downloads must not attach authentication");
    fetched.push(url);
    return new Response(await readFile(plan.assets.find((asset) => url.endsWith(asset.name)).file));
  };
  assert.equal((await verifyPublicDownload(plan, { fetchImpl })).verified, true);
  assert.equal(fetched.length, 6);
  await assert.rejects(verifyPublicDownload(plan, { fetchImpl: async () => new Response("wrong") }), /digest\/size mismatch/);
  await assert.rejects(verifyPublicDownload(plan, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/asset" } }) }), /origin rejected/);
  await assert.rejects(verifyPublicDownload(plan, { fetchImpl: async () => new Response("x".repeat(plan.assets[0].size + 1)) }), /exceeds expected size/);
});

test("local publication inventory rejects extra files and foreign URLs before any upload", async (t) => {
  const { config, plan } = await fixture(t);
  await writeFile(path.join(config.directory, ".cfkanban-scope.json"), "{}");
  await assert.rejects(publicationPlan(config), /six approved assets/);
  await rm(path.join(config.directory, ".cfkanban-scope.json"));
  const pointer = JSON.parse(await readFile(plan.assets[0].file, "utf8"));
  pointer.manifest_url = "https://evil.example/manifest.json";
  await writeFile(plan.assets[0].file, JSON.stringify(pointer));
  await assert.rejects(publicationPlan(config), /Manifest URL/);
});

test("gh adapter binds IDs, uploads one file without clobber, and sanitizes timeout errors", async () => {
  const calls = [];
  const run = async (executable, args, options) => { calls.push({ executable, args, options }); return { stdout: "{}" }; };
  const client = githubClient({ run });
  const plan = { repository: "breakstring/cfKanban", version: "0.1.0-alpha.99", commit: "a".repeat(40), notes: "notes", prerelease: true };
  await client.createDraft(plan);
  await client.upload(plan, 123, { name: "test.zip", file: "/tmp/upload/test.zip" });
  await client.publish(plan, 123);
  assert.equal(calls[0].args.includes("draft=true"), true);
  assert.equal(calls[1].args[1], "https://uploads.github.com/repos/breakstring/cfKanban/releases/123/assets?name=test.zip");
  assert.equal(calls[1].args.includes("--input"), true);
  assert.equal(calls[2].args.includes("draft=false"), true);
  assert.equal(calls.every(({ args }) => !args.includes("DELETE") && !args.includes("--clobber")), true);
  const failing = githubClient({ run: async () => { throw new Error("secret supplier body"); } });
  await assert.rejects(failing.readRelease(plan, 123), (error) => !error.message.includes("secret supplier body") && error.message.includes("re-inspect"));
});
