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

export function captureCasConflict(
  error: unknown,
  resource: string | LocalizedText,
  draft: unknown,
): CasConflictState | null {
  const problem = error as ProblemLike;
  if (problem?.body?.code !== "VERSION_CONFLICT") return null;
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
