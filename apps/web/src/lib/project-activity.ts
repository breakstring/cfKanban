import type { EventResource } from "../types";

export interface ActivityTarget { label: string; path: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = /^CFK-[1-9][0-9]*$/;
const issueReferenceEvents = new Set(["comment.created", "comment.deleted", "comment.restored", "issue.label-added", "issue.label-removed"]);
const relationEvents = new Set(["issue-relation.created", "issue-relation.deleted", "issue-relation.restored"]);

export function activityTargets(event: EventResource): ActivityTarget[] {
  const targets: ActivityTarget[] = [];
  if (event.workspace && event.project && uuid.test(event.workspace.id) && uuid.test(event.project.id)) {
    targets.push({ label: `${event.workspace.display_name} / ${event.project.display_name}`, path: `/app/w/${event.workspace.id}/p/${event.project.id}` });
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return targets;
  const value = payload as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (issueReferenceEvents.has(event.type)) {
    candidates.push(value.issue_identifier);
    const reference = value.issue_reference;
    if (reference && typeof reference === "object" && !Array.isArray(reference)) candidates.push((reference as Record<string, unknown>).identifier);
  }
  if (relationEvents.has(event.type)) candidates.push(value.source_identifier, value.target_identifier);
  for (const candidate of new Set(candidates)) {
    if (typeof candidate === "string" && identifier.test(candidate)) targets.push({ label: candidate, path: `/app/issues/${candidate}` });
  }
  return targets;
}
