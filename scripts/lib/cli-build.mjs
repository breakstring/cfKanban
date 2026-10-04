import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const files = ["THIRD_PARTY_NOTICES.txt", "cfkanban.mjs", "commands.json"];
export async function verifyCliBuild({ outputDirectory, version }) {
  const metadata = JSON.parse(await readFile(path.join(outputDirectory, "build-metadata.json"), "utf8"));
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.name, "cfkanban-cli");
  assert.equal(metadata.release_version, version, "CLI build must match the declared release");
  assert.equal(metadata.node_range, ">=22.12.0");
  assert.deepEqual((await readdir(outputDirectory)).sort(), [...files, "build-metadata.json"].sort());
  assert.deepEqual(metadata.entries.map(entry => entry.path).sort(), files);
  for (const entry of metadata.entries) {
    const file = path.join(outputDirectory, entry.path);
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), "CLI files must be regular payload entries");
    const bytes = await readFile(file);
    assert.equal(bytes.length, entry.size_bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  }
  const commands = JSON.parse(await readFile(path.join(outputDirectory, "commands.json"), "utf8"));
  assert.equal(commands.schema_version, 1);
  assert.equal(commands.version, version);
  assert.ok(commands.commands.some(command => command.name === "issue complete"));
  assert.ok(commands.commands.some(command => command.name === "deploy resume"));
  assert.equal(new Set(commands.commands.map(command => command.name)).size, commands.commands.length);
  return metadata;
}
