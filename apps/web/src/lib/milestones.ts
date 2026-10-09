import type { IssueMilestone, MilestoneResource, WriteResult } from "../types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function milestoneSelection(milestone: IssueMilestone | null | undefined): string {
  return milestone?.id ?? "none";
}

export function milestoneAssignmentChange(value: string, milestone: IssueMilestone | null | undefined): { milestone_id?: string | null } {
  if (value === milestoneSelection(milestone)) return {};
  return value === "none" ? { milestone_id: null } : uuid.test(value) ? { milestone_id: value } : {};
}

export function isMilestoneWriteResult(value: unknown, workspaceId: string, projectId: string): value is WriteResult<MilestoneResource> {
  if (typeof value !== "object" || value === null) return false;
  const result = value as WriteResult<MilestoneResource>;
  const item = result.resource;
  return typeof item === "object" && item !== null
    && typeof item.id === "string" && uuid.test(item.id)
    && item.workspace_id === workspaceId && item.project_id === projectId
    && typeof item.title === "string" && item.title.length > 0 && typeof item.description === "string"
    && (item.status_key === "open" || item.status_key === "closed")
    && (item.due_date === null || (typeof item.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.due_date)))
    && Number.isSafeInteger(item.version) && item.version > 0
    && typeof item.created_at === "string" && typeof item.updated_at === "string"
    && Array.isArray(item.allowed_actions) && item.allowed_actions.every(action => typeof action === "string")
    && typeof item.progress === "object" && item.progress !== null
    && [item.progress.total, item.progress.done, item.progress.unfinished, item.progress.canceled].every(count => Number.isSafeInteger(count) && count >= 0);
}
