import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

const webRoot = new URL("../apps/web/dist/", import.meta.url);
const workerRoot = new URL("../apps/worker/dist/", import.meta.url);

assert.ok((await stat(new URL("index.html", webRoot))).isFile(), "Web build must emit index.html");
assert.ok((await stat(new URL("_headers", webRoot))).isFile(), "Web build must emit Cloudflare Static Assets headers");
const staticHeaders = await readFile(new URL("_headers", webRoot), "utf8");
for (const route of ["/", "/app", "/app/*"]) {
  assert.ok(
    staticHeaders.includes(`${route}\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer`),
    `${route} must disable caching and referrer disclosure`,
  );
}
assert.ok(
  staticHeaders.includes("/assets/*\n  Cache-Control: public, max-age=31556952, immutable"),
  "fingerprinted Web assets must be immutable",
);
for (const guide of ["deploy-guide.md", "deploy-guide.zh-CN.md", "join.md", "join.zh-CN.md"]) {
  assert.ok((await stat(new URL(guide, webRoot))).isFile(), `${guide} must be included in the Web build`);
  assert.ok(
    staticHeaders.includes(`/${guide}\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff`),
    `${guide} must use the public-guide security headers`,
  );
}
const webFiles = await filesUnder(webRoot);
assert.ok(webFiles.some((name) => name.endsWith(".js")), "Web build must emit a JavaScript asset");

const workerFiles = await filesUnder(workerRoot);
const workerEntry = new URL("index.js", workerRoot);
assert.ok((await stat(workerEntry)).isFile(), "Worker dry-run build must emit a portable index.js module");
assert.ok((await stat(new URL("metafile.json", workerRoot))).isFile(), "Worker dry-run build must emit build metadata");
const workerSource = await readFile(workerEntry, "utf8");
assert.ok(!workerSource.startsWith("------formdata-"), "Worker build output must not be Wrangler's multipart upload body");
assert.match(workerSource, /fetchWorker/, "Worker build output must contain the implemented Worker entry point");

console.log(`Build output checks passed for ${webFiles.length} Web files and ${workerFiles.length} Worker files.`);
