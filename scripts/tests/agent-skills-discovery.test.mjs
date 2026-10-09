import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildAgentSkillsDiscovery, verifyAgentSkillsDiscovery, validateAgentSkillsIndex, verifySkillRuntimeClosure, AGENT_SKILL_NAMES, AGENT_SKILLS_SCHEMA } from "../lib/agent-skills-discovery.mjs";
import { extractTarGzip, readTarGzipEntries, writeDeterministicTarGzip } from "../lib/deterministic-tar.mjs";
import { writeDeterministicZip } from "../lib/deterministic-zip.mjs";
import { installVerifiedSkillBundle } from "../../packages/skill-runtime/src/skill-update.mjs";
import { RELEASE_VERSION } from "../../apps/worker/src/release-version.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = data => createHash("sha256").update(data).digest("hex");
const processEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^SystemRoot$/iu.test(key)));

async function fixture(t, version = RELEASE_VERSION) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cfkanban-discovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillBundleRoot = path.join(root, "canonical");
  await mkdir(skillBundleRoot);
  for (const entry of ["skills", "packages/skill-runtime"]) {
    await mkdir(path.dirname(path.join(skillBundleRoot, entry)), { recursive: true });
    await cp(path.join(repository, entry), path.join(skillBundleRoot, entry), { recursive: true });
  }
  // 发行验收负责预构建工件摘要；此夹具验证路径投影和真实 helper 执行。
  const files = ["mcp/server.mjs", "cli/cfkanban.mjs", "web-embedded/embedded.html",
    ...["server.mjs", "launcher.mjs", "browser.mjs", "workbench.mjs", "THIRD_PARTY_NOTICES.txt", "embedded/embedded.html", "embedded/embedded-build.json", "build-metadata.json"].map(file => `local-runtime/${file}`)];
  for (const file of files) {
    await mkdir(path.dirname(path.join(skillBundleRoot, file)), { recursive: true });
    await writeFile(path.join(skillBundleRoot, file), `fixture ${file}`);
  }
  await mkdir(path.join(skillBundleRoot, "release"));
  await writeFile(path.join(skillBundleRoot, "release/version.json"), JSON.stringify({ version }));
  const outputDirectory = path.join(root, "web");
  return { root, skillBundleRoot, outputDirectory, version };
}

function workerFixture(index, { origin = "https://kanban.example.test", assets = new Map(), spaFallback = false } = {}) {
  const requests = [];
  const indexPath = `/agent-skills/${RELEASE_VERSION}/index.json`;
  const env = {
    DB: new Proxy({}, { get() { throw new Error("D1 must not be accessed"); } }),
    ASSETS: { async fetch(request) {
      const url = new URL(request.url);
      requests.push({ pathname: url.pathname, method: request.method, headers: new Headers(request.headers), search: url.search });
      if (url.pathname === indexPath && index !== null) return new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } });
      if (assets.has(url.pathname)) return new Response(request.method === "HEAD" ? null : assets.get(url.pathname), { headers: { "content-type": "application/octet-stream" } });
      return new Response(spaFallback ? "<html>App fallback</html>" : "Not Found", { status: spaFallback ? 200 : 404, headers: { "content-type": "text/html" } });
    } },
  };
  const request = (pathname, init = {}) => fetchWorker(new Request(`${origin}${pathname}`, init), env);
  return { request, requests };
}

function sampleIndex() {
  return { $schema: AGENT_SKILLS_SCHEMA, skills: AGENT_SKILL_NAMES.map(name => ({
    name, type: "archive", description: `Use ${name}`, url: `/agent-skills/${RELEASE_VERSION}/${name}.tar.gz`, digest: `sha256:${"a".repeat(64)}`,
  })) };
}

test("four real tar.gz artifacts repeat byte-for-byte, preserve the complete inner tree and run the original safe helper surfaces", async t => {
  const input = await fixture(t);
  const first = await buildAgentSkillsDiscovery(input);
  const second = await buildAgentSkillsDiscovery({ ...input, outputDirectory: path.join(input.root, "again") });
  assert.deepEqual(first.index, second.index);
  assert.equal(first.artifacts.length, 4);
  assert.ok(first.artifacts.every(artifact => artifact.reproducible));
  assert.deepEqual(first.artifacts.filter(artifact => artifact.helper_smoke).map(artifact => artifact.helper_smoke.surface), ["daily", "admin", "deploy"]);
  assert.ok(first.closure.source_files > 50 && first.closure.literal_imports > 100);
  assert.equal(new Set(first.index.skills.map(entry => entry.url)).size, 4);
  const surfaces = new Map([["cfkanban", "daily"], ["cfkanban-admin", "admin"], ["cfkanban-deploy", "deploy"]]);
  for (const entry of first.index.skills) {
    const bytes = await readFile(path.join(input.outputDirectory, entry.url));
    const again = await readFile(path.join(input.root, "again", entry.url));
    assert.deepEqual(bytes, again);
    assert.equal(entry.digest, `sha256:${sha256(bytes)}`);
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
    const entries = readTarGzipEntries(bytes);
    assert.ok(entries.some(item => item.path === "SKILL.md"));
    assert.ok(!entries.some(item => item.path.startsWith(`${entry.name}/`)));
    const directory = path.join(input.root, "unpacked", entry.name);
    await mkdir(path.dirname(directory), { recursive: true });
    await extractTarGzip({ bytes, directory });
    assert.deepEqual(await readFile(path.join(directory, "assets/runtime/release/version.json")), await readFile(path.join(input.skillBundleRoot, "release/version.json")));
    const document = await readFile(path.join(directory, "SKILL.md"), "utf8");
    assert.doesNotMatch(document, /\.\.\/\.\.\/cli\/cfkanban\.mjs/u);
    if (entry.name === "cfkanban-howto") {
      assert.match(document, /\]\(assets\/runtime\/skills\/cfkanban\/SKILL\.md\)/u);
      await assert.rejects(readFile(path.join(directory, "scripts/cfkanban-tool.mjs")), { code: "ENOENT" });
    } else {
      const { stdout, stderr } = await run(process.execPath, [path.join(directory, "scripts/cfkanban-tool.mjs"), "help"], { cwd: directory, env: processEnv, timeout: 5000, maxBuffer: 256 * 1024 });
      const response = JSON.parse(stdout);
      assert.equal(stderr, "");
      assert.equal(response.ok, true);
      assert.equal(response.result.surface, surfaces.get(entry.name));
      assert.ok(response.result.commands.length > 0);
    }
    if (entry.name === "cfkanban-admin") assert.match(await readFile(path.join(directory, "references/owner-workflows.md"), "utf8"), /\]\(\.\.\/assets\/runtime\/skills\/cfkanban\/references\/workflows\.md#/u);
  }
  await verifyAgentSkillsDiscovery(input);
});

test("generation refuses omitted resources, external dependencies and linked canonical inputs", async t => {
  const input = await fixture(t);
  await rm(path.join(input.skillBundleRoot, "local-runtime/browser.mjs"));
  await assert.rejects(buildAgentSkillsDiscovery(input), /Incomplete canonical Skill bundle/u);
  await writeFile(path.join(input.skillBundleRoot, "local-runtime/browser.mjs"), "restored");
  const runtimeFile = path.join(input.skillBundleRoot, "packages/skill-runtime/src/external.mjs");
  await writeFile(runtimeFile, 'import "unbundled-package";');
  await assert.rejects(verifySkillRuntimeClosure(input), /unpackaged external dependency/u);
  await rm(runtimeFile);
  await symlink("../release/version.json", path.join(input.skillBundleRoot, "skills/linked"));
  await assert.rejects(buildAgentSkillsDiscovery(input), /symbolic links/u);
});

test("index verification refuses wrong digests, missing archives, floating URLs and stale release paths", async t => {
  const input = await fixture(t, "8.1.0");
  const { index } = await buildAgentSkillsDiscovery(input);
  validateAgentSkillsIndex(index, { version: "8.1.0" });
  for (const url of ["/agent-skills/latest/cfkanban.tar.gz", "https://foreign.example.test/cfkanban.tar.gz", "/agent-skills/8.0.0/cfkanban.tar.gz"]) {
    const changed = structuredClone(index);
    changed.skills[0].url = url;
    assert.throws(() => validateAgentSkillsIndex(changed, { version: input.version }), /current exact release/u);
  }
  const archive = path.join(input.outputDirectory, index.skills[0].url);
  const original = await readFile(archive);
  await writeFile(archive, Buffer.concat([original, Buffer.from("drift")]));
  await assert.rejects(verifyAgentSkillsDiscovery(input), /digest drift/u);
  await writeFile(archive, original);
  await rm(archive);
  await assert.rejects(verifyAgentSkillsDiscovery(input), /Unexpected discovery payload/u);
});

test("canonical stored ZIP still accepts release/version.json while tar.gz never becomes an installer target", async t => {
  const input = await fixture(t);
  await rm(path.join(input.skillBundleRoot, "cli"), { recursive: true });
  const bundlePath = path.join(input.root, "canonical.zip");
  await writeDeterministicZip({ root: input.skillBundleRoot, outputPath: bundlePath, prefix: `cfkanban-skills-${input.version}/` });
  const releaseRoot = path.join(input.root, "isolated-install");
  const installed = await installVerifiedSkillBundle({ bundlePath, version: input.version, releaseRoot,
    expectedSha256: sha256(await readFile(bundlePath)), publisher: "https://releases.example.test", source: "https://releases.example.test/canonical.zip" });
  assert.equal(installed.discovery_smoke.passed, true);
  assert.equal(JSON.parse(await readFile(path.join(installed.path, "release/version.json"))).version, input.version);
  assert.deepEqual(installed.discovery_smoke.checked.map(entry => entry.surface), ["daily", "admin", "deploy"]);
  const activePath = path.join(releaseRoot, "active.json");
  const activeBefore = await readFile(activePath);
  const archive = path.join(input.root, "discovery.tar.gz");
  await writeDeterministicTarGzip({ root: input.skillBundleRoot, outputPath: archive });
  await assert.rejects(installVerifiedSkillBundle({ bundlePath: archive, version: "8.1.0", releaseRoot,
    expectedSha256: sha256(await readFile(archive)), publisher: "https://releases.example.test", source: "https://releases.example.test/discovery.tar.gz" }), { code: "EMPTY_SKILL_BUNDLE" });
  assert.deepEqual(await readFile(activePath), activeBefore);
});

test("public index uses the request origin, binds the current release, strips credentials and has GET/HEAD parity without D1", async () => {
  const fixture = workerFixture(sampleIndex());
  for (const method of ["GET", "HEAD"]) {
    const response = await fixture.request("/.well-known/agent-skills/index.json?ignored=1", { method, headers: { cookie: "fixture-session", authorization: "Bearer fixture", "x-forwarded-host": "untrusted.example.test" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("x-request-id"));
    if (method === "HEAD") assert.equal(await response.text(), "");
    else {
      const index = await response.json();
      assert.equal(index.skills.length, 4);
      for (const entry of index.skills) assert.equal(entry.url, `https://kanban.example.test/agent-skills/${RELEASE_VERSION}/${entry.name}.tar.gz`);
    }
  }
  assert.ok(fixture.requests.every(request => request.method === "GET" && request.search === "" && !request.headers.has("cookie") && !request.headers.has("authorization")));
});

test("known archive GET streams the original artifact while HEAD is empty and uses an ASSETS HEAD", async () => {
  const index = sampleIndex();
  const data = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
  const assets = new Map(index.skills.map(entry => [entry.url, data]));
  const fixture = workerFixture(index, { assets });
  for (const entry of index.skills) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fixture.request(entry.url, { method, headers: { cookie: "fixture-session", authorization: "Bearer fixture" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/gzip");
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable, no-transform");
      if (method === "GET") assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data);
      else assert.equal(await response.text(), "");
    }
  }
  assert.equal(fixture.requests.filter(request => request.pathname.endsWith(".tar.gz") && request.method === "HEAD").length, 4);
  assert.ok(fixture.requests.every(request => !request.headers.has("cookie") && !request.headers.has("authorization")));
});

test("archive response returns before the source stream completes and removes HTTP gzip encoding", { timeout: 2000 }, async () => {
  const index = sampleIndex();
  const archivePath = index.skills[0].url;
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const env = {
    DB: new Proxy({}, { get() { throw new Error("D1 must not be accessed"); } }),
    ASSETS: { async fetch(request) {
      if (new URL(request.url).pathname === archivePath) return new Response(stream, { headers: { "content-type": "application/gzip", "content-encoding": "gzip" } });
      return new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } });
    } },
  };
  const response = await fetchWorker(new Request(`https://kanban.example.test${archivePath}`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(stream.locked, false);
  const bytes = new Uint8Array([0x1f, 0x8b, 4, 3, 2, 1]);
  controller.enqueue(bytes);
  controller.close();
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("unknown/retired/missing paths and SPA fallback are genuine 404; other methods are 405", async () => {
  const fixture = workerFixture(sampleIndex(), { spaFallback: true });
  for (const pathname of ["/.well-known/agent-skills", "/.well-known/agent-skills/missing.json", `/agent-skills/${RELEASE_VERSION}/missing.tar.gz`, "/agent-skills/0.0.1/cfkanban.tar.gz", `/agent-skills/${RELEASE_VERSION}/cfkanban.tar.gz`]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fixture.request(pathname, { method });
      assert.equal(response.status, 404, pathname);
      assert.equal(await response.text(), method === "HEAD" ? "" : "Not Found");
    }
  }
  for (const method of ["POST", "PUT", "OPTIONS", "DELETE"]) {
    const response = await fixture.request("/.well-known/agent-skills/index.json", { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  const missingIndex = workerFixture(null, { spaFallback: true });
  assert.equal((await missingIndex.request("/.well-known/agent-skills/index.json")).status, 404);
});

test("unknown schema, invalid digest, old-version and foreign URLs fail closed without discovering latest", async () => {
  for (const mutation of [index => { index.$schema = "https://schema.example.test/new"; }, index => { index.skills[0].digest = "sha256:bad"; }, index => { index.skills[0].url = "/agent-skills/0.0.1/cfkanban.tar.gz"; }, index => { index.skills[0].url = "https://foreign.example.test/cfkanban.tar.gz"; }]) {
    const index = sampleIndex();
    mutation(index);
    const fixture = workerFixture(index);
    assert.equal((await fixture.request("/.well-known/agent-skills/index.json")).status, 503);
    assert.ok(fixture.requests.every(request => request.pathname === `/agent-skills/${RELEASE_VERSION}/index.json`));
  }
});
