import type { PublicIssue } from "./protocol";
import type { IssueParentSummary } from "../lib/issue-hierarchy";

export interface IssueTreeRow {
  identifier: string;
  depth: number;
  issue?: PublicIssue;
  context?: IssueParentSummary;
  cycle: boolean;
  contextProgress?: { total: number; done: number };
}

function relationCycles(links: Map<string, string>): string[][] {
  const result: string[][] = [];
  const resolved = new Set<string>();
  for (const identifier of links.keys()) {
    const trail: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = identifier;
    while (current && !resolved.has(current) && links.has(current)) {
      const index = positions.get(current);
      if (index !== undefined) {
        result.push(trail.slice(index));
        break;
      }
      positions.set(current, trail.length);
      trail.push(current);
      current = links.get(current);
    }
    for (const item of trail) resolved.add(item);
  }
  return result;
}

export function issueTree(issues: PublicIssue[], contextIssues: PublicIssue[] = []): IssueTreeRow[] {
  const nodes = new Map<string, { issue?: PublicIssue; context?: IssueParentSummary }>();
  const progress = new Map(contextIssues.map(issue => [issue.identifier, issue.hierarchy?.children]));
  const links = new Map<string, string>();
  const cycles = new Set<string>();
  for (const issue of issues) nodes.set(issue.identifier, { issue });
  for (const issue of issues) {
    const parent = issue.hierarchy?.parents[0];
    if (!parent) continue;
    if (!nodes.has(parent.identifier)) nodes.set(parent.identifier, { context: parent });
    links.set(issue.identifier, parent.identifier);
  }
  // 关系允许多父，历史数据可能有环；展示选稳定的首个父，断环不改动原关系。
  for (const members of relationCycles(links)) {
    const root = members.sort()[0]!;
    links.delete(root);
    cycles.add(root);
  }
  const knownLinks = new Map<string, string>();
  for (const issue of [...contextIssues, ...issues]) {
    const parent = issue.hierarchy?.parents[0];
    if (parent) knownLinks.set(issue.identifier, parent.identifier);
  }
  for (const members of relationCycles(knownLinks)) {
    const visible = members.filter(identifier => nodes.get(identifier)?.issue).sort()[0];
    if (visible) cycles.add(visible);
  }
  const children = new Map<string, string[]>();
  for (const [identifier, parent] of links) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(identifier);
  }
  const result: IssueTreeRow[] = [];
  const stack = [...nodes.keys()].filter(identifier => !links.has(identifier)).reverse().map(identifier => ({ identifier, depth: 0 }));
  while (stack.length) {
    const row = stack.pop()!;
    const contextProgress = nodes.get(row.identifier)?.context ? progress.get(row.identifier) : undefined;
    result.push({ ...row, ...nodes.get(row.identifier), cycle: cycles.has(row.identifier), ...(contextProgress ? { contextProgress } : {}) });
    for (const identifier of [...children.get(row.identifier) ?? []].reverse()) stack.push({ identifier, depth: row.depth + 1 });
  }
  return result;
}
