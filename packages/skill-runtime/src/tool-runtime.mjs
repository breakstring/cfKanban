import { access, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveToolRuntimeRoot } from "./paths.mjs";
import { atomicWriteJson, canonicalDigest, ensurePrivateDirectory, pathType, requireString } from "./utils.mjs";
import { toolError } from "./errors.mjs";

function parseVersion(value) {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(value || "");
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function satisfiesSimpleRange(versionText, range) {
  const version = parseVersion(versionText);
  if (version === null) return false;
  return requireString(range, "version_range").split(/\s+/).every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
    if (!match) return false;
    const target = [Number(match[2]), Number(match[3] || 0), Number(match[4] || 0)];
    const relation = compare(version, target);
    switch (match[1] || "=") {
      case ">=": return relation >= 0;
      case "<=": return relation <= 0;
      case ">": return relation > 0;
      case "<": return relation < 0;
      default: return relation === 0;
    }
  });
}

async function executableExists(filePath) {
  try {
    await access(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" ? `${name}${extension.toLowerCase()}` : name);
      if (await executableExists(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

async function versionOf(executable) {
  return new Promise((resolve) => {
    const child = spawn(executable, ["--version"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/, 1)[0] : null));
  });
}

export async function resolveWrangler({ explicitPath = null, requiredRange, runtimeRoot = resolveToolRuntimeRoot(), env = process.env, platform = process.platform }) {
  const candidates = [];
  if (explicitPath !== null) {
    if (!path.isAbsolute(explicitPath)) throw toolError("ABSOLUTE_PATH_REQUIRED", "Explicit Wrangler path must be absolute");
    candidates.push({ source: "explicit", path: explicitPath });
  }
  const fromPath = await pathExecutable(platform === "win32" ? "wrangler" : "wrangler", { env, platform });
  if (fromPath !== null && !candidates.some((entry) => entry.path === fromPath)) candidates.push({ source: "path", path: fromPath });
  const runtimeVersions = path.join(runtimeRoot, "versions");
  try {
    const active = JSON.parse(await readFile(path.join(runtimeRoot, "active.json"), "utf8"));
    const runtimeExecutable = path.join(runtimeVersions, active.version, "node_modules", ".bin", platform === "win32" ? "wrangler.cmd" : "wrangler");
    candidates.push({ source: "cfkanban_tool_runtime", path: runtimeExecutable });
  } catch {
    // No active private runtime is a normal probe result.
  }
  for (const candidate of candidates) {
    if (!await executableExists(candidate.path)) continue;
    const version = await versionOf(candidate.path);
    if (version !== null && satisfiesSimpleRange(version, requiredRange)) return { status: "compatible", ...candidate, version, required_range: requiredRange };
  }
  return { status: candidates.length === 0 ? "unavailable" : "incompatible", required_range: requiredRange, candidates: await Promise.all(candidates.map(async (candidate) => ({ ...candidate, version: await versionOf(candidate.path) }))) };
}

export function createToolRuntimePlan({ taskId, npmExecutable, wranglerVersion, sourceRegistry = "npm", runtimeRoot = resolveToolRuntimeRoot() }) {
  if (!path.isAbsolute(npmExecutable)) throw toolError("ABSOLUTE_PATH_REQUIRED", "npm executable must be an absolute path");
  const version = requireString(wranglerVersion, "wrangler_version", { max: 64 });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw toolError("INVALID_WRANGLER_VERSION", "Tool Runtime requires an exact Wrangler semantic version");
  const plan = {
    schema_version: 1,
    kind: "tool_runtime_install",
    task_id: requireString(taskId, "task_id"),
    runtime_root: runtimeRoot,
    npm_executable: npmExecutable,
    package: "wrangler",
    version,
    source_registry: sourceRegistry,
    changes_path: false,
    changes_shell_profile: false,
    changes_global_node_or_wrangler: false,
    writes_user_repositories: false,
    rollback: "switch active runtime pointer to previous version or remove this isolated version",
  };
  return { plan, plan_digest: canonicalDigest(plan) };
}

export async function installToolRuntime({ plan, authorizedTaskId, authorizedPlanDigest, runner = null }) {
  const digest = canonicalDigest(plan);
  if (plan.kind !== "tool_runtime_install" || authorizedTaskId !== plan.task_id || authorizedPlanDigest !== digest) {
    throw toolError("PLAN_NOT_AUTHORIZED", "Tool Runtime install authorization does not match the frozen task and plan digest");
  }
  await ensurePrivateDirectory(plan.runtime_root);
  const versionRoot = path.join(plan.runtime_root, "versions", plan.version);
  if (await pathType(versionRoot) !== "missing") throw toolError("TOOL_RUNTIME_VERSION_EXISTS", "Tool Runtime version already exists and will not be overwritten", { versionRoot });
  await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(versionRoot);
  const packageJson = { private: true, name: "cfkanban-tool-runtime", version: "0.0.0", dependencies: { wrangler: plan.version } };
  await atomicWriteJson(path.join(versionRoot, "package.json"), packageJson);
  const execute = runner || ((executable, args) => new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: versionRoot, shell: false, windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  }));
  const result = await execute(plan.npm_executable, ["install", "--no-audit", "--no-fund", "--save-exact"]);
  if (result.code !== 0) throw toolError("TOOL_RUNTIME_INSTALL_FAILED", "npm failed while installing the isolated cfKanban Tool Runtime", { exitCode: result.code });
  const executable = path.join(versionRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  const version = await versionOf(executable);
  if (version === null || !parseVersion(version) || !version.includes(plan.version.split("-")[0])) throw toolError("TOOL_RUNTIME_VERIFY_FAILED", "Installed Wrangler could not be verified", { executable, version });
  const previous = await readFile(path.join(plan.runtime_root, "active.json"), "utf8").then(JSON.parse).catch(() => null);
  const previousSummary = previous === null ? null : { version: previous.version, executable: previous.executable };
  await atomicWriteJson(path.join(plan.runtime_root, "active.json"), { schema_version: 1, version: plan.version, executable, previous: previousSummary, switched_at: new Date().toISOString() });
  return { installed: true, version, executable, previous: previous?.version || null, path_modified: false };
}
