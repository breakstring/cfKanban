import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWritePublicJson, canonicalDigest, readJson, requireString, requireUuid } from "./utils.mjs";
import { toolError } from "./errors.mjs";

export const SCOPE_FILE_NAME = ".cfkanban-scope.json";
const execFileAsync = promisify(execFile);
const NOT_REPOSITORY = /^fatal: not a git repository \(or any of the parent directories\): \.git\r?\n?$/;
const FILESYSTEM_BOUNDARY = /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\r?\n?$/;

function gitEnvironment(environment) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !/^git_/i.test(key))),
    LC_ALL: "C", LANG: "C", LANGUAGE: "C",
  };
}

async function inspectGitDirectory(directory, { gitRunner, environment }) {
  try {
    if (!(await stat(directory)).isDirectory()) return { status: "unknown", root: null };
  } catch {
    return { status: "unknown", root: null };
  }
  const options = {
    cwd: directory, env: gitEnvironment(environment), shell: false, windowsHide: true,
    timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8",
  };
  let insideWorkTree = false;
  try {
    const inside = await gitRunner("git", ["rev-parse", "--is-inside-work-tree"], options);
    if (inside.stdout === "false\n" || inside.stdout === "false\r\n") return { status: "not_repository", root: null };
    if (inside.stdout !== "true\n" && inside.stdout !== "true\r\n") return { status: "unknown", root: null };
    insideWorkTree = true;
    const result = await gitRunner("git", ["rev-parse", "--show-toplevel"], options);
    const root = typeof result.stdout === "string" ? result.stdout.replace(/\r?\n$/, "") : "";
    if (!path.isAbsolute(root) || /[\r\n\u0000]/.test(root)) return { status: "unknown", root: null };
    return { status: "repository", root: path.resolve(root) };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "unavailable", root: null };
    if (!insideWorkTree && error?.code === 128 && !error.killed && (NOT_REPOSITORY.test(error.stderr) || FILESYSTEM_BOUNDARY.test(error.stderr))) {
      return { status: "not_repository", root: null };
    }
    return { status: "unknown", root: null };
  }
}

export async function inspectScopeDirectory({ directory = process.cwd() } = {}, { gitRunner = execFileAsync, environment = process.env } = {}) {
  const absoluteDirectory = path.resolve(requireString(directory, "directory"));
  const git = await inspectGitDirectory(absoluteDirectory, { gitRunner, environment });
  const scopeDirectory = git.root ?? absoluteDirectory;
  const scope = await readRepoScope({ repoRoot: scopeDirectory });
  return {
    directory: absoluteDirectory, git, scope_directory: scopeDirectory,
    workbench_context_key: git.status === "repository" ? canonicalDigest({ directory: scopeDirectory }) : null,
    scope_file: path.join(scopeDirectory, SCOPE_FILE_NAME), scope,
    association_recommended: git.status === "repository" && scope === null,
  };
}

function validateTarget(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw toolError("INVALID_SCOPE", "Scope target must be an object");
  }
  const fields = ["instance_id", "workspace_id", "project_id"];
  if (Object.keys(target).some((field) => !fields.includes(field))) {
    throw toolError("INVALID_SCOPE", "Scope targets require only instance_id, workspace_id and project_id; old key targets are unsupported");
  }
  return Object.fromEntries(fields.map((field) => [field, requireUuid(target[field], field)]));
}

export function validateScopeDocument(document) {
  if (document?.schema_version !== 2 || !Array.isArray(document.targets)) {
    throw toolError("INVALID_SCOPE", "Scope document must use schema_version 2 and a targets array");
  }
  const targets = document.targets.map(validateTarget);
  const unique = new Map();
  for (const target of targets) {
    const key = `${target.instance_id}\u0000${target.workspace_id}\u0000${target.project_id}`;
    unique.set(key, target);
  }
  return { schema_version: 2, targets: [...unique.values()] };
}

export async function readRepoScope({ repoRoot = process.cwd() } = {}) {
  const filePath = path.join(repoRoot, SCOPE_FILE_NAME);
  const document = await readJson(filePath, { allowMissing: true });
  return document === null ? null : validateScopeDocument(document);
}

export async function mergeRepoScope({ repoRoot = process.cwd(), targets }) {
  const current = await readRepoScope({ repoRoot }) ?? { schema_version: 2, targets: [] };
  const merged = validateScopeDocument({ schema_version: 2, targets: [...current.targets, ...targets] });
  await atomicWritePublicJson(path.join(repoRoot, SCOPE_FILE_NAME), merged);
  return merged;
}

export function resolveScope({ explicitTargets = [], repoTargets = [], validTargets = null, allowUnfiltered = true } = {}) {
  const explicit = explicitTargets.map(validateTarget);
  const repository = repoTargets.map(validateTarget);
  const candidates = explicit.length > 0 ? explicit : repository;
  const source = explicit.length > 0 ? "explicit" : repository.length > 0 ? "repository" : "unfiltered";
  if (candidates.length === 0) {
    if (!allowUnfiltered) throw toolError("SCOPE_REQUIRED", "No Project scope was resolved and unfiltered aggregation is disabled");
    return {
      resolved_scope: [],
      source,
      warnings: [{ code: "SCOPE_EXPANDED_TO_AUTHORIZED_AGGREGATE", message: "No Project filter was resolved; the request may include every authorized Project." }],
    };
  }
  const validKeys = validTargets === null ? null : new Set(validTargets.map((target) => {
    const normalized = validateTarget(target);
    return `${normalized.instance_id}/${normalized.workspace_id}/${normalized.project_id}`;
  }));
  const resolved = [];
  const warnings = [];
  for (const target of candidates) {
    const key = `${target.instance_id}/${target.workspace_id}/${target.project_id}`;
    if (validKeys !== null && !validKeys.has(key)) {
      warnings.push({ code: "INVALID_SCOPE_TARGET", target });
    } else {
      resolved.push(target);
    }
  }
  if (resolved.length === 0 && !allowUnfiltered) throw toolError("SCOPE_REQUIRED", "Every candidate Project target was invalid");
  if (resolved.length === 0) warnings.push({ code: "SCOPE_EXPANDED_TO_AUTHORIZED_AGGREGATE", message: "Every candidate Project target was invalid; the request may include every authorized Project." });
  return { resolved_scope: resolved, source: resolved.length > 0 ? source : "unfiltered", warnings };
}
