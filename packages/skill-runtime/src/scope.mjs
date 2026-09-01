import path from "node:path";
import { atomicWritePublicJson, readJson, requireString, requireUuid } from "./utils.mjs";
import { toolError } from "./errors.mjs";

export const SCOPE_FILE_NAME = ".cfkanban-scope.json";

function validateTarget(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw toolError("INVALID_SCOPE", "Scope target must be an object");
  }
  const workspaceKey = requireString(target.workspace_key, "workspace_key", { max: 32 });
  const projectKey = requireString(target.project_key, "project_key", { max: 16 });
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(workspaceKey) || !/^[A-Z][A-Z0-9-]{1,15}$/.test(projectKey)) {
    throw toolError("INVALID_SCOPE", "Scope target contains an invalid Workspace or Project key", { workspaceKey, projectKey });
  }
  return {
    instance_id: requireUuid(target.instance_id, "instance_id"),
    workspace_key: workspaceKey,
    project_key: projectKey,
  };
}

export function validateScopeDocument(document) {
  if (document?.schema_version !== 1 || !Array.isArray(document.targets)) {
    throw toolError("INVALID_SCOPE", "Scope document must use schema_version 1 and a targets array");
  }
  const targets = document.targets.map(validateTarget);
  const unique = new Map();
  for (const target of targets) {
    const key = `${target.instance_id}\u0000${target.workspace_key}\u0000${target.project_key}`;
    unique.set(key, target);
  }
  return { schema_version: 1, targets: [...unique.values()] };
}

export async function readRepoScope({ repoRoot = process.cwd() } = {}) {
  const filePath = path.join(repoRoot, SCOPE_FILE_NAME);
  const document = await readJson(filePath, { allowMissing: true });
  return document === null ? null : validateScopeDocument(document);
}

export async function mergeRepoScope({ repoRoot = process.cwd(), targets }) {
  const current = await readRepoScope({ repoRoot }) ?? { schema_version: 1, targets: [] };
  const merged = validateScopeDocument({ schema_version: 1, targets: [...current.targets, ...targets] });
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
    return `${normalized.instance_id}/${normalized.workspace_key}/${normalized.project_key}`;
  }));
  const resolved = [];
  const warnings = [];
  for (const target of candidates) {
    const key = `${target.instance_id}/${target.workspace_key}/${target.project_key}`;
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
