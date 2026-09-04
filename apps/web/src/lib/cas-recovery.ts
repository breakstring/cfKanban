import type { LocalizedText } from "./localized-error";

export interface CasConflictState {
  currentVersion: number | null;
  draft: string;
  readbackState: "complete" | "failed" | "pending";
  resource: string | LocalizedText;
}

interface ProblemLike {
  body?: {
    code?: unknown;
    details?: Record<string, unknown>;
  };
}

const CAS_CONFLICT_CODES = new Set([
  "VERSION_CONFLICT",
  "RESOURCE_DELETED",
  "RESOURCE_NOT_DELETED",
]);

export function captureCasConflict(
  error: unknown,
  resource: string | LocalizedText,
  draft: unknown,
): CasConflictState | null {
  const problem = error as ProblemLike;
  if (typeof problem?.body?.code !== "string" || !CAS_CONFLICT_CODES.has(problem.body.code)) return null;
  const rawVersion = problem.body.details?.current_version;
  const currentVersion = typeof rawVersion === "number"
    && Number.isSafeInteger(rawVersion)
    && rawVersion > 0
    ? rawVersion
    : null;
  return {
    currentVersion,
    draft: serializeDraft(draft),
    readbackState: "pending",
    resource,
  };
}

export function markCasReadbackComplete(conflict: CasConflictState): CasConflictState {
  return { ...conflict, readbackState: "complete" };
}

export function markCasReadbackFailed(conflict: CasConflictState): CasConflictState {
  return { ...conflict, readbackState: "failed" };
}

function serializeDraft(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[Draft could not be serialized]";
  }
}
