import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

export function isFingerprintedDocsAsset(name) {
  return /[.-][A-Za-z0-9_-]{8,}(?:\.lean)?\.[^/]+$/u.test(name);
}

export async function docsAssetHeaders(directory, baseHeaders) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")).sort();
  assert.ok(entries.every(entry => entry.isFile() || entry.isDirectory()), "Documentation assets must be regular files");
  assert.ok(files.every(name => /^[A-Za-z0-9_./@-]+$/u.test(name)), "Documentation asset paths must be safe header patterns");
  const groups = Map.groupBy(files, name => path.extname(name));
  const rules = ["/docs/assets/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff"];
  for (const [extension, names] of groups) {
    if (extension && names.every(isFingerprintedDocsAsset)) {
      rules.push(`/docs/assets/*${extension}\n  Cache-Control: public, max-age=31536000, immutable`);
    } else {
      for (const name of names) rules.push(`/docs/assets/${name}\n  Cache-Control: ${isFingerprintedDocsAsset(name) ? "public, max-age=31536000, immutable" : "no-store, no-transform"}`);
    }
  }
  const output = `${baseHeaders.trim()}\n\n${rules.join("\n\n")}\n`;
  assert.ok(output.split("\n").filter(line => line.startsWith("/")).length <= 100, "Static Assets header rule limit exceeded; split the asset namespace before publishing");
  return output;
}
