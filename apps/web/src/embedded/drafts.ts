import type { Artifact, PublicIssue, PublicResult } from "./protocol";

type CompletionDraft = { summary: string; verification: string; artifacts: string; artifactKind: Artifact["kind"]; followUps: string };

export function resetCompletionDraft(draft: CompletionDraft): void {
  Object.assign(draft, { summary: "", verification: "", artifacts: "", artifactKind: "path", followUps: "" });
}

export function reconcileCompletedDraft(draft: CompletionDraft, issue: PublicIssue | null, result: PublicResult): boolean {
  if (!issue || !result.ok || result.outcome_unknown) return false;
  resetCompletionDraft(draft);
  return true;
}
