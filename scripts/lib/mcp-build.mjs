import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertEmbeddedHtml } from "../../apps/web/scripts/build-embedded.mjs";

export const MCP_BUILD_FILES = ["server.mjs", "facade.mjs", "workbench.html", "mcp-app-build.json", "THIRD_PARTY_NOTICES.txt", "build-metadata.json"];
const hashedFiles = ["server.mjs", "facade.mjs", "workbench.html", "mcp-app-build.json"];
const sha256 = value => createHash("sha256").update(value).digest("hex");

export async function verifyMcpBuild({ outputDirectory, version }) {
  assert.ok((await lstat(outputDirectory)).isDirectory(), "MCP artifact root must be a regular directory");
  assert.deepEqual((await readdir(outputDirectory)).sort(), [...MCP_BUILD_FILES].sort(), "MCP artifact must contain the complete fixed file set");
  for (const name of MCP_BUILD_FILES) assert.ok((await lstat(path.join(outputDirectory, name))).isFile(), "MCP artifact files must be regular files");
  const metadata = JSON.parse(await readFile(path.join(outputDirectory, "build-metadata.json"), "utf8"));
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.name, "cfkanban-mcp");
  assert.equal(metadata.transport, "stdio");
  assert.equal(metadata.node_range, ">=22.12.0");
  assert.equal(metadata.release_version, version, "MCP version must match the complete release");
  assert.deepEqual(metadata.entries.map(entry => entry.path).sort(), [...hashedFiles].sort());
  for (const entry of metadata.entries) {
    const bytes = await readFile(path.join(outputDirectory, entry.path));
    assert.equal(entry.size_bytes, bytes.length);
    assert.equal(entry.sha256, sha256(bytes), "MCP artifact digest changed; rebuild before packaging");
  }
  const ui = JSON.parse(await readFile(path.join(outputDirectory, "mcp-app-build.json"), "utf8"));
  assert.equal(ui.schema_version, 1);
  assert.equal(ui.protocol, 1);
  assert.equal(ui.entry, "workbench.html");
  assert.equal(ui.release_version, version);
  const checked = assertEmbeddedHtml(await readFile(path.join(outputDirectory, "workbench.html"), "utf8"));
  assert.equal(ui.sha256, checked.sha256);
  assert.equal(ui.size_bytes, checked.size_bytes);
  return metadata;
}
