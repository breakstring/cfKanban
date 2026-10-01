import type { IssueSummary, PriorityKey } from "../types";

export interface AppliedBoardFilters {
  search: string;
  priorities: PriorityKey[];
  labels: string[];
}

export function matchesBoardFilters(issue: IssueSummary, filters: AppliedBoardFilters): boolean {
  if (issue.deleted_at !== null) return false;
  if (filters.priorities.length && !filters.priorities.includes(issue.priority)) return false;
  if (filters.labels.length && !issue.labels.some(label => filters.labels.includes(label.id))) return false;
  const search = filters.search.normalize("NFKC").toLowerCase().trim();
  if (!search) return true;
  const number = /^cfk-[1-9][0-9]*$/.test(search) ? Number(search.slice(4)) : null;
  return (number !== null && Number.isSafeInteger(number) && number === issue.number)
    || issue.title.normalize("NFKC").toLowerCase().includes(search);
}

export function sortBoardIssues(issues: IssueSummary[]): IssueSummary[] {
  return issues.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.number - a.number);
}
