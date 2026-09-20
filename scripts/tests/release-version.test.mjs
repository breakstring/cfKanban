import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readReleaseVersion, verifyReleaseBuild, writeBuildVersion } from "../lib/release-version.mjs";

async function fixture(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "cfkanban-release-version-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  for (const directory of ["release", ".codex-plugin", "apps/worker/dist", "apps/web/dist"]) await mkdir(path.join(repositoryRoot, directory), { recursive: true });
  const version = "1.0.0";
  await writeFile(path.join(repositoryRoot, "release/version.json"), JSON.stringify({ version }));
  await writeFile(path.join(repositoryRoot, ".codex-plugin/plugin.json"), JSON.stringify({ version }));
  const outputDirectory = path.join(repositoryRoot, "apps/worker/dist");
  await writeFile(path.join(outputDirectory, "index.js"), 'export const release_version = "1.0.0";');
  await writeBuildVersion({ repositoryRoot, outputDirectory, entry: "index.js", version });
  const webOutput = path.join(repositoryRoot, "apps/web/dist");
  await writeFile(path.join(webOutput, "index.html"), "<html>Built web app</html>");
  await writeBuildVersion({ repositoryRoot, outputDirectory: webOutput, entry: "index.html", version });
  return { repositoryRoot, outputDirectory, version };
}

test("packaging accepts matching declared, plugin, and built release versions", async (t) => {
  const input = await fixture(t);
  assert.equal(await readReleaseVersion(input.repositoryRoot), "1.0.0");
  await verifyReleaseBuild(input);
});

test("renaming a bundle cannot relabel a previous release", async (t) => {
  const input = await fixture(t);
  await assert.rejects(verifyReleaseBuild({ ...input, version: "1.1.0" }), /Requested bundle version/);
  for (const file of ["release/version.json", ".codex-plugin/plugin.json"]) await writeFile(path.join(input.repositoryRoot, file), JSON.stringify({ version: "1.1.0" }));
  await assert.rejects(verifyReleaseBuild({ ...input, version: "1.1.0" }), /Built artifact version/);
});

test("packaging refuses mismatched plugin, changed Worker bytes, and missing build evidence", async (t) => {
  const input = await fixture(t);
  const plugin = path.join(input.repositoryRoot, ".codex-plugin/plugin.json");
  await writeFile(plugin, JSON.stringify({ version: "1.0.0-rc.7" }));
  await assert.rejects(verifyReleaseBuild(input), /Plugin version/);
  await writeFile(plugin, JSON.stringify({ version: input.version }));
  await writeFile(path.join(input.outputDirectory, "index.js"), "stale or replaced worker");
  await assert.rejects(verifyReleaseBuild(input), /digest changed/);
  await rm(path.join(input.outputDirectory, "build-version.json"));
  await assert.rejects(verifyReleaseBuild(input), { code: "ENOENT" });
});

test("product release remains separate from existing API and schema contracts", async () => {
  const document = JSON.parse(await readFile(new URL("../../contracts/openapi.json", import.meta.url), "utf8"));
  assert.equal(document.info.version, "0.1.0");
  for (const name of ["Health", "InstanceDiscovery", "Meta"]) {
    const schema = document.components.schemas[name];
    assert.equal(schema.properties.release_version.type, "string");
    assert.equal(schema.required.includes("release_version"), false, "older compatible instances omit this additive field");
    assert.equal(schema.required.includes("service_version"), true);
  }
});

test("packaging refuses stale or changed Web build output", async (t) => {
  const input = await fixture(t);
  const directory = path.join(input.repositoryRoot, "apps/web/dist");
  const metadataPath = path.join(directory, "build-version.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, release_version: "1.0.0-rc.7" }));
  await assert.rejects(verifyReleaseBuild(input), /Built artifact version/);
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(path.join(directory, "index.html"), "stale web app");
  await assert.rejects(verifyReleaseBuild(input), /digest changed/);
});
