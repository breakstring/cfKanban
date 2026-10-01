import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

export async function verifyWebAssetManifest({ outputDirectory, budget }) {
  const root = path.resolve(outputDirectory);
  const manifest = JSON.parse(await readFile(path.join(root, ".vite/manifest.json"), "utf8"));
  const entry = manifest["index.html"];
  assert.ok(entry?.isEntry, "Web manifest must identify index.html as its entry");
  const files = new Set();
  const javascript = new Map();
  async function verifyFile(file) {
    assert.equal(typeof file, "string", "Web manifest asset path must be a string");
    assert.ok(file.length > 0 && !file.includes("\\") && !file.includes("?") && !file.includes("#")
      && !path.posix.isAbsolute(file) && file.split("/").every(part => part && part !== "." && part !== ".."),
    `Unsafe Web manifest asset path: ${file}`);
    if (files.has(file)) return;
    assert.ok((await stat(path.join(root, file))).isFile(), `Missing Web asset: ${file}`);
    files.add(file);
    if (file.endsWith(".js")) {
      const source = await readFile(path.join(root, file));
      javascript.set(file, { bytes: source.length, gzip_bytes: gzipSync(source).length });
    }
  }
  for (const [key, chunk] of Object.entries(manifest)) {
    await verifyFile(chunk.file);
    for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) await verifyFile(file);
    for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      assert.ok(Object.hasOwn(manifest, dependency), `${key} references missing Web manifest chunk ${dependency}`);
    }
  }
  const initialFiles = new Set();
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    initialFiles.add(chunk.file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  visit("index.html");
  const html = await readFile(path.join(root, "index.html"), "utf8");
  assert.ok(html.includes(`src="/${entry.file}"`) || html.includes(`src='/${entry.file}'`),
    "Web HTML must reference the manifest entry");
  const initialJavaScriptGzipBytes = [...initialFiles].reduce((sum, file) => sum + (javascript.get(file)?.gzip_bytes ?? 0), 0);
  const entryGzipBytes = javascript.get(entry.file)?.gzip_bytes ?? 0;
  const largestChunkGzipBytes = Math.max(0, ...[...javascript.values()].map(chunk => chunk.gzip_bytes));
  if (budget) {
    for (const [name, actual] of Object.entries({
      entry_gzip_bytes: entryGzipBytes,
      initial_javascript_gzip_bytes: initialJavaScriptGzipBytes,
      largest_chunk_gzip_bytes: largestChunkGzipBytes,
    })) {
      assert.ok(Number.isSafeInteger(budget[name]) && budget[name] > 0, `Invalid Web budget: ${name}`);
      assert.ok(actual <= budget[name], `Web budget exceeded: ${name} ${actual} > ${budget[name]}`);
    }
  }
  return {
    files: [...files].sort(),
    javascript: Object.fromEntries(javascript),
    entry_gzip_bytes: entryGzipBytes,
    initial_javascript_gzip_bytes: initialJavaScriptGzipBytes,
    largest_chunk_gzip_bytes: largestChunkGzipBytes,
  };
}
