import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

const webRoot = new URL("../apps/web/dist/", import.meta.url);
const workerRoot = new URL("../apps/worker/dist/", import.meta.url);

assert.ok((await stat(new URL("index.html", webRoot))).isFile(), "Web build must emit index.html");
const webFiles = await filesUnder(webRoot);
assert.ok(webFiles.some((name) => name.endsWith(".js")), "Web build must emit a JavaScript asset");

const workerFiles = await filesUnder(workerRoot);
assert.ok((await stat(new URL("worker.js", workerRoot))).isFile(), "Worker dry-run build must emit worker.js");
assert.ok((await stat(new URL("metafile.json", workerRoot))).isFile(), "Worker dry-run build must emit build metadata");

console.log(`Build output checks passed for ${webFiles.length} Web files and ${workerFiles.length} Worker files.`);
