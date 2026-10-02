import type { Priority, PublicIssue, PublicResult, Status } from "./protocol";

export function reconcileIssueDraft(draft: { status: Status | ""; priority: Priority }, issue: PublicIssue | null, previous: PublicIssue | null): void {
  if (!issue || !previous || issue.identifier !== previous.identifier) {
    draft.status = issue?.status.key ?? "";
    draft.priority = issue?.priority ?? "none";
    return;
  }
  if (draft.status === previous.status.key) draft.status = issue.status.key;
  if (draft.priority === previous.priority) draft.priority = issue.priority;
}

export function reconcileCompletedDraft(draft: { status: Status | ""; priority: Priority }, issue: PublicIssue | null, result: PublicResult): boolean {
  if (!issue || !result.ok || result.outcome_unknown) return false;
  draft.status = issue.status.key;
  draft.priority = issue.priority;
  return true;
}
