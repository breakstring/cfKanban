import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { verifyDocsBuild } from "./lib/docs-build.mjs";
import { verifyWebAssetManifest } from "./lib/web-asset-manifest.mjs";
import { verifyEmbeddedBuild } from "./lib/embedded-build.mjs";
import { verifyLocalRuntimeBuild } from "../packages/local-runtime/scripts/build.mjs";

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

const webRoot = new URL("../apps/web/dist/", import.meta.url);
const workerRoot = new URL("../apps/worker/dist/", import.meta.url);
const release = JSON.parse(await readFile(new URL("../release/version.json", import.meta.url), "utf8"));
await verifyEmbeddedBuild({ outputDirectory: fileURLToPath(new URL("../apps/web/dist-embedded/", import.meta.url)), version: release.version });
await verifyLocalRuntimeBuild({ outputDirectory: fileURLToPath(new URL("../packages/local-runtime/dist/", import.meta.url)), version: release.version });
const webBudget = JSON.parse(await readFile(new URL("./web-performance-budget.json", import.meta.url), "utf8"));
const webAssets = await verifyWebAssetManifest({ outputDirectory: fileURLToPath(webRoot), budget: webBudget });
const docsRoot = new URL("docs/", webRoot);
await verifyDocsBuild({ outputDirectory: fileURLToPath(docsRoot), version: release.version });
const catalog = JSON.parse(await readFile(new URL("../apps/docs/catalog.json", import.meta.url), "utf8"));
const docsIndex = await readFile(new URL("llms.txt", docsRoot), "utf8");
for (const locale of ["en", "zh-CN"]) {
  for (const group of catalog) {
    for (const page of group.pages) {
      const prefix = `${locale}/${group.slug}/${page.slug}`;
      const html = await readFile(new URL(`${prefix}.html`, docsRoot), "utf8");
      assert.match(html, /<meta name="cfkanban-docs"/u, `${prefix} must identify itself as documentation`);
      assert.match(html, /<link rel="icon" href="\/docs\/assets\/cfkanban-mark\.[^"/]+\.png">/u, `${prefix} must load the local brand mark`);
      assert.ok(html.includes(`content="${release.version}"`), `${prefix} must match the release version`);
      assert.equal(await readFile(new URL(`${prefix}.md`, docsRoot), "utf8"), await readFile(new URL(`../apps/docs/${prefix}.md`, import.meta.url), "utf8"));
      assert.equal(docsIndex.includes(`](/docs/${prefix}.md)`), !page.hidden, `${prefix} must match its Agent discovery visibility`);
      assert.ok(!/<link[^>]+href="https?:/u.test(html), `${prefix} must not load external fonts/styles`);
    }
  }
}
assert.match(await readFile(new URL("404.html", docsRoot), "utf8"), /name="cfkanban-docs"/u);
assert.ok((await stat(new URL("llms.txt", docsRoot))).isFile());
assert.ok((await stat(new URL("vp-icons.css", docsRoot))).isFile(), "Documentation icon stylesheet must be included");
const docsFiles = await filesUnder(docsRoot);
assert.ok(docsFiles.some(name => name.startsWith("@localSearchIndexen.") && name.endsWith(".js")), "English local search index must be bundled");
assert.ok(docsFiles.some(name => name.startsWith("@localSearchIndexzh-CN.") && name.endsWith(".js")), "Chinese local search index must be bundled");

assert.ok((await stat(new URL("index.html", webRoot))).isFile(), "Web build must emit index.html");
assert.ok((await stat(new URL("_headers", webRoot))).isFile(), "Web build must emit Cloudflare Static Assets headers");
const staticHeaders = await readFile(new URL("_headers", webRoot), "utf8");
for (const route of ["/", "/app", "/app/*"]) {
  assert.ok(
    staticHeaders.includes(`${route}\n  Cache-Control: no-store, no-transform\n  Referrer-Policy: no-referrer`),
    `${route} must disable caching, edge transforms, and referrer disclosure`,
  );
}
assert.ok(
  staticHeaders.includes("/assets/*\n  Cache-Control: public, max-age=31556952, immutable"),
  "fingerprinted Web assets must be immutable",
);
for (const guide of ["deploy-guide.md", "deploy-guide.zh-CN.md", "join.md", "join.zh-CN.md"]) {
  assert.ok((await stat(new URL(guide, webRoot))).isFile(), `${guide} must be included in the Web build`);
  assert.ok(
    staticHeaders.includes(`/${guide}\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Content-Type: text/plain; charset=utf-8`),
    `${guide} must use the public-guide security headers and explicit UTF-8 decoding`,
  );
}
const webFiles = await filesUnder(webRoot);
assert.ok(webFiles.some((name) => name.endsWith(".js")), "Web build must emit a JavaScript asset");
assert.ok(webFiles.some((name) => name.endsWith(".png")), "Web build must emit the local brand mark");
const indexHtml = await readFile(new URL("index.html", webRoot), "utf8");
assert.match(indexHtml, /<link rel="icon"[^>]+\/assets\/cfkanban-mark-[^"/]+\.png/u, "Web build must fingerprint the favicon");
assert.match(indexHtml, /<link rel="apple-touch-icon"[^>]+\/assets\/cfkanban-mark-[^"/]+\.png/u, "Web build must reuse the fingerprinted mark for touch icons");

const workerFiles = await filesUnder(workerRoot);
const workerEntry = new URL("index.js", workerRoot);
assert.ok((await stat(workerEntry)).isFile(), "Worker dry-run build must emit a portable index.js module");
assert.ok((await stat(new URL("metafile.json", workerRoot))).isFile(), "Worker dry-run build must emit build metadata");
const workerSource = await readFile(workerEntry, "utf8");
assert.ok(!workerSource.startsWith("------formdata-"), "Worker build output must not be Wrangler's multipart upload body");
assert.match(workerSource, /fetchWorker/, "Worker build output must contain the implemented Worker entry point");

console.log(`Web gzip budgets passed: entry ${webAssets.entry_gzip_bytes} B, synchronous JavaScript ${webAssets.initial_javascript_gzip_bytes} B, largest chunk ${webAssets.largest_chunk_gzip_bytes} B.`);
console.log(`Build output checks passed for ${webFiles.length} Web files and ${workerFiles.length} Worker files.`);
