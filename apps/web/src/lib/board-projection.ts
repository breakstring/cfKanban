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

export async function refreshBoardIssueProgress<T extends Pick<IssueSummary, "version" | "hierarchy">>(options: {
  read: () => Promise<T>;
  knownVersion: () => number;
  isCurrent: () => boolean;
  apply: (issue: T) => Promise<void>;
}): Promise<boolean> {
  // 持续变更时最多重读一次，由调用方隐藏尚未核验的进度。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!options.isCurrent()) return false;
    const issue = await options.read();
    if (!options.isCurrent()) return false;
    if (issue.version < options.knownVersion()) continue;
    if (issue.hierarchy === undefined) return false;
    await options.apply(issue);
    return true;
  }
  return false;
}
