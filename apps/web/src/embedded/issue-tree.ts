import type { PublicIssue } from "./protocol";
import { issueTree as buildIssueTree, type IssueTreeRow as TreeRow } from "../lib/issue-tree";

export type IssueTreeRow = TreeRow<PublicIssue>;
export function issueTree(issues: PublicIssue[], contextIssues: PublicIssue[] = []): IssueTreeRow[] {
  return buildIssueTree(issues, contextIssues);
}
