export type CompletionArtifactKind = "commit" | "other" | "path" | "url";

export interface CompletionRecord {
  artifacts: Array<{ kind: CompletionArtifactKind; value: string }>;
  follow_ups: string[];
  summary: string;
  verification: string[];
}

const artifactKinds = new Set<CompletionArtifactKind>(["commit", "other", "path", "url"]);

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

export function parseCompletionRecord(value: unknown): CompletionRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || record.summary.length === 0
    || !stringList(record.verification)
    || !stringList(record.follow_ups)
    || !Array.isArray(record.artifacts)) return null;
  const artifacts: CompletionRecord["artifacts"] = [];
  for (const entry of record.artifacts) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const artifact = entry as Record<string, unknown>;
    if (typeof artifact.kind !== "string"
      || !artifactKinds.has(artifact.kind as CompletionArtifactKind)
      || typeof artifact.value !== "string"
      || artifact.value.length === 0) return null;
    artifacts.push({ kind: artifact.kind as CompletionArtifactKind, value: artifact.value });
  }
  return {
    artifacts,
    follow_ups: record.follow_ups,
    summary: record.summary,
    verification: record.verification,
  };
}

export function safeArtifactHref(artifact: { kind: CompletionArtifactKind; value: string }): string | null {
  if (artifact.kind !== "url") return null;
  try {
    const url = new URL(artifact.value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
