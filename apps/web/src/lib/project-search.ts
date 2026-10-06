import { matchesTypedIssueSearch, typedIssueSearch, type TypedIssueSearch } from "../../../../packages/shared/issue-search";
import type { IssueSummary } from "../types";

export { typedIssueSearch };

export function projectSearchCandidates(items: readonly IssueSummary[], projectId: string, query: TypedIssueSearch): { items: IssueSummary[]; hasMore: boolean } {
  if (query.kind === "empty" || query.kind === "invalid") return { items: [], hasMore: false };
  const byId = new Map<string, IssueSummary>();
  for (const issue of items) {
    if (issue.project.id !== projectId) continue;
    const previous = byId.get(issue.id);
    if (!previous || issue.version > previous.version || (issue.version === previous.version && issue.updated_at > previous.updated_at)) byId.set(issue.id, issue);
  }
  const matching = [...byId.values()].filter(issue => issue.deleted_at === null && matchesTypedIssueSearch(issue, query));
  matching.sort((a, b) => query.kind === "number"
    ? Number(b.number === query.number) - Number(a.number === query.number) || a.number - b.number || a.id.localeCompare(b.id)
    : Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.number - a.number || a.id.localeCompare(b.id));
  return { items: matching.slice(0, 10), hasMore: matching.length > 10 };
}

export function nextSearchCandidateId(items: readonly IssueSummary[], current: string | null, key: string): string | null {
  if (!items.length) return null;
  const index = items.findIndex(issue => issue.id === current);
  const target = key === "ArrowUp" ? (index < 0 ? items.length - 1 : Math.max(0, index - 1)) : (index < 0 ? 0 : Math.min(items.length - 1, index + 1));
  return items[target]?.id ?? null;
}
