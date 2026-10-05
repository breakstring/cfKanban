import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildMcpAppDocument } from "../../../apps/web/scripts/build-mcp-app.mjs";
import { verifyMcpBuild } from "../../../scripts/lib/mcp-build.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const versionIndex = process.argv.indexOf("--version");
const declared = JSON.parse(await readFile(path.join(repoRoot, "release/version.json"), "utf8"));
const version = versionIndex === -1 ? declared.release_version ?? declared.version : process.argv[versionIndex + 1];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("MCP build requires a fixed release version");
const outputRoot = path.join(packageRoot, "dist");
await mkdir(outputRoot, { recursive: true });
const inputs = new Set();
const entries = [];
const ui = await buildMcpAppDocument({ outputDirectory: outputRoot, version });
for (const entry of ui.inputs ?? []) inputs.add(path.relative(repoRoot, entry));
for (const name of ["workbench.html", "mcp-app-build.json"]) {
  const bytes = await readFile(path.join(outputRoot, name));
  entries.push({ path: name, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
for (const name of ["server", "facade"]) {
  const output = path.join(outputRoot, `${name}.mjs`);
  const result = await build({ absWorkingDir: repoRoot, entryPoints: [path.join(packageRoot, "src", `${name}.mjs`)], outfile: output, bundle: true, platform: "node", target: "node22.12", format: "esm", minify: true, legalComments: "inline", metafile: true, logLevel: "silent", loader: { ".svg": "text" }, define: { __CFKANBAN_MCP_VERSION__: JSON.stringify(version), __CFKANBAN_MCP_BUNDLED__: "true", __CFKANBAN_MCP_UI_SHA256__: JSON.stringify(ui.sha256) }, banner: { js: 'import { createRequire as __cfkanbanCreateRequire } from "node:module"; const require = __cfkanbanCreateRequire(import.meta.url);' } });
  Object.keys(result.metafile.inputs).forEach(entry => inputs.add(entry));
  const bytes = await readFile(output);
  entries.push({ path: `${name}.mjs`, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const dependencyRoots = new Set();
for (const entry of inputs) {
  const matched = entry.match(/^(.*?node_modules\/(?:@[^/]+\/)?[^/]+)/);
  if (matched) dependencyRoots.add(matched[1]);
}
const notices = ["cfKanban MCP bundled dependencies. The cfKanban source license is supplied with the containing release.\n"];
const dependencies = [];
for (const relative of [...dependencyRoots].sort()) {
  const root = path.resolve(repoRoot, relative);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  dependencies.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? "SEE LICENSE" });
  let license = "License text is supplied by the upstream package.";
  for (const file of ["LICENSE", "LICENSE.txt", "LICENSE.md", "license", "LICENSE-MIT"]) {
    try { license = await readFile(path.join(root, file), "utf8"); break; } catch { /* Try the package's next conventional license file. */ }
  }
  notices.push(`\n--- ${manifest.name}@${manifest.version} (${manifest.license ?? "SEE LICENSE"}) ---\n${license}`);
}
await writeFile(path.join(outputRoot, "THIRD_PARTY_NOTICES.txt"), `${notices.join("\n")}\n`);
await writeFile(path.join(outputRoot, "build-metadata.json"), `${JSON.stringify({ schema_version: 1, name: "cfkanban-mcp", release_version: version, node_range: ">=22.12.0", transport: "stdio", entries, dependencies }, null, 2)}\n`);
await verifyMcpBuild({ outputDirectory: outputRoot, version });
process.stdout.write(`Built cfKanban MCP ${version}: ${entries.map(entry => entry.path).join(", ")}\n`);
