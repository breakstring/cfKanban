import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function fingerprints(directory, prefix = "") {
  const files = {};
  for (const entry of (await readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await fingerprints(directory, name));
    else if (entry.isFile() && name !== "build-manifest.json") {
      files[name] = createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex");
    } else if (!entry.isFile()) throw new Error(`Unexpected documentation artifact: ${name}`);
  }
  return files;
}

export async function writeDocsBuild({ outputDirectory, version }) {
  const files = await fingerprints(outputDirectory);
  assert.ok(files["index.html"], "Documentation entry must exist before recording its build");
  await writeFile(path.join(outputDirectory, "build-manifest.json"), `${JSON.stringify({ release_version: version, files }, null, 2)}\n`);
}

export async function verifyDocsBuild({ outputDirectory, version }) {
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, "build-manifest.json"), "utf8"));
  assert.equal(manifest.release_version, version, "Documentation build version does not match release version; rebuild before packaging");
  assert.deepEqual(await fingerprints(outputDirectory), manifest.files, "Documentation artifact digest changed; rebuild before packaging");
}
