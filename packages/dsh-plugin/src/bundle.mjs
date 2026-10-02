import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const name = "cfkanban-bundle";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export function acceptsNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (!match) return false;
  const [major, minor] = match.slice(1, 3).map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

function artifactPaths(root, relative = "") {
  const files = [];
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    // pnpm 可添加宿主管理的 peer links；预构建业务工件不携带 node_modules。
    if (relative === "" && name === "node_modules") continue;
    const child = relative ? `${relative}/${name}` : name;
    const stats = lstatSync(path.join(root, child));
    if (stats.isSymbolicLink()) throw new Error("cfKanban: artifact contains a symbolic link");
    if (stats.isDirectory()) files.push(...artifactPaths(root, child));
    else if (stats.isFile()) files.push(child);
    else throw new Error("cfKanban: artifact contains a non-regular file");
  }
  return files;
}

export function verifyArtifact(root = packageRoot) {
  const canonicalRoot = realpathSync(root);
  const actualFiles = artifactPaths(root).filter((entry) => entry !== "artifact-manifest.json");
  let manifest;
  let metadata;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, "artifact-manifest.json"), "utf8"));
    metadata = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch { throw new Error("cfKanban: artifact metadata could not be verified"); }
  if (manifest.schema_version !== 1 || manifest.release_version !== metadata.version || !Array.isArray(manifest.files)) {
    throw new Error("cfKanban: invalid or inconsistent artifact manifest; reinstall the verified fixed artifact");
  }
  const files = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "") || files.has(entry.path)) {
      throw new Error("cfKanban: invalid artifact file path");
    }
    files.add(entry.path);
    const entryPath = path.join(root, entry.path);
    const canonicalPath = realpathSync(entryPath);
    if (!canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error("cfKanban: artifact file escapes its verified package");
    }
    const bytes = readFileSync(entryPath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256 || bytes.length !== entry.size) throw new Error("cfKanban: artifact integrity check failed; reinstall the verified fixed artifact");
  }
  if (actualFiles.length !== files.size || actualFiles.some((entry) => !files.has(entry))) {
    throw new Error("cfKanban: artifact manifest does not cover its complete payload");
  }
  for (const required of ["package.json", "cordis.patch.yml", "src/bundle.mjs", "src/host/index.mjs", "src/host/bridge.mjs", "src/shared/panel.mjs", "lib/client.js", "embedded/embedded.html", "embedded/embedded-build.json", "mcp/server.mjs", "mcp/facade.mjs", "mcp/build-metadata.json", "mcp/THIRD_PARTY_NOTICES.txt", "local-runtime/server.mjs", "local-runtime/launcher.mjs", "local-runtime/browser.mjs", "local-runtime/workbench.mjs", "local-runtime/build-metadata.json", "local-runtime/THIRD_PARTY_NOTICES.txt", "local-runtime/embedded/embedded.html", "local-runtime/embedded/embedded-build.json", "packages/skill-runtime/src/cli.mjs", "skills/cfkanban/SKILL.md", "skills/cfkanban-admin/SKILL.md", "skills/cfkanban-deploy/SKILL.md", "skills/cfkanban-howto/SKILL.md"]) {
    if (!files.has(required)) throw new Error("cfKanban: incomplete artifact");
  }
  return manifest;
}

export function resolveRuntime({ root = packageRoot, nodeExecutable, execPath = process.execPath, versions = process.versions } = {}) {
  if (nodeExecutable !== undefined && (typeof nodeExecutable !== "string" || !path.isAbsolute(nodeExecutable))) {
    throw new Error("cfKanban: nodeExecutable must be an absolute path");
  }
  let nodeCommand;
  try { nodeCommand = realpathSync(nodeExecutable ?? execPath); }
  catch { throw new Error("cfKanban: selected Node executable is unavailable"); }
  let nodeVersion = versions.node;
  let electron = nodeExecutable === undefined && Boolean(versions.electron);
  if (nodeExecutable !== undefined) {
    const result = spawnSync(nodeCommand, ["--version"], {
      encoding: "utf8", timeout: 3000, windowsHide: true,
      env: Object.fromEntries(["PATH", "SystemRoot", "WINDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    });
    if (result.error || result.status !== 0 || !/^v\d+\.\d+\.\d+\s*$/.test(result.stdout ?? "")) {
      throw new Error("cfKanban: selected Node could not be verified");
    }
    nodeVersion = result.stdout.trim();
    electron = false;
  }
  if (!acceptsNode(nodeVersion)) throw new Error("cfKanban requires Node >=22.12.0; select a compatible absolute nodeExecutable");
  return Object.freeze({
    nodeCommand,
    nodeVersion,
    skillsDirectory: path.join(root, "skills"),
    mcpArgs: Object.freeze([...(electron ? ["--expose-internals"] : []), path.join(root, "mcp", "server.mjs")]),
    mcpEnvironment: Object.freeze(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  });
}

export function apply(ctx, config = {}) {
  const manifest = verifyArtifact();
  const runtime = resolveRuntime({ nodeExecutable: config.nodeExecutable });
  ctx.provide("cfkanbanBundle", Object.freeze({ ...runtime, releaseVersion: manifest.release_version }));
}
