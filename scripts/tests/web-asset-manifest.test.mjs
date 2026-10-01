import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyWebAssetManifest } from "../lib/web-asset-manifest.mjs";

async function fixture(t) {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "cfkanban-web-manifest-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  await mkdir(path.join(outputDirectory, ".vite"));
  await mkdir(path.join(outputDirectory, "assets"));
  for (const file of ["entry.js", "shared.js", "page.js", "page.css", "mark.png"]) {
    await writeFile(path.join(outputDirectory, "assets", file), `built ${file}`);
  }
  await writeFile(path.join(outputDirectory, "index.html"), '<script type="module" src="/assets/entry.js"></script>');
  const manifest = {
    "index.html": { file: "assets/entry.js", isEntry: true, imports: ["shared"], dynamicImports: ["page"] },
    shared: { file: "assets/shared.js" },
    page: { file: "assets/page.js", imports: ["shared"], css: ["assets/page.css"], assets: ["assets/mark.png"] },
  };
  async function save() { await writeFile(path.join(outputDirectory, ".vite/manifest.json"), JSON.stringify(manifest)); }
  await save();
  return { outputDirectory, manifest, save };
}

test("asset verification includes dynamic page CSS/assets but initial JS excludes deferred pages", async t => {
  const input = await fixture(t);
  const result = await verifyWebAssetManifest(input);
  assert.equal(result.files.length, 5);
  assert.equal(result.initial_javascript_gzip_bytes,
    result.javascript["assets/entry.js"].gzip_bytes + result.javascript["assets/shared.js"].gzip_bytes);
});

test("packaging refuses a missing dynamic chunk or its stylesheet", async t => {
  const input = await fixture(t);
  await rm(path.join(input.outputDirectory, "assets/page.js"));
  await assert.rejects(verifyWebAssetManifest(input), { code: "ENOENT" });
  await writeFile(path.join(input.outputDirectory, "assets/page.js"), "restored");
  await rm(path.join(input.outputDirectory, "assets/page.css"));
  await assert.rejects(verifyWebAssetManifest(input), { code: "ENOENT" });
});

test("invalid import references and paths fail before a bundle is accepted", async t => {
  const input = await fixture(t);
  input.manifest.page.dynamicImports = ["unknown"];
  await input.save();
  await assert.rejects(verifyWebAssetManifest(input), /missing Web manifest chunk/);
  delete input.manifest.page.dynamicImports;
  input.manifest.page.assets = ["../outside.png"];
  await input.save();
  await assert.rejects(verifyWebAssetManifest(input), /Unsafe Web manifest asset path/);
});

test("stale HTML and gzip budget regressions are rejected", async t => {
  const input = await fixture(t);
  await assert.rejects(verifyWebAssetManifest({ ...input, budget: {
    entry_gzip_bytes: 1, initial_javascript_gzip_bytes: 1000, largest_chunk_gzip_bytes: 1000,
  } }), /Web budget exceeded/);
  await writeFile(path.join(input.outputDirectory, "index.html"), '<script src="/assets/stale.js"></script>');
  await assert.rejects(verifyWebAssetManifest(input), /HTML must reference the manifest entry/);
});
