import type { IssueTrends, ProjectScopeItem, WebSessionView } from "../types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const metrics = ["total", "done", "canceled", "unfinished", "created", "completed", "reopened"] as const;
const dayMilliseconds = 86_400_000;
export type IssueTrendWindow = 30 | 90 | 365;
export interface IssueTrendRequest {
  workspaceId: string;
  projectId?: string | undefined;
  milestoneId?: string | undefined;
  days: IssueTrendWindow;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
const count = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value);

export function issueTrendProjects(session: WebSessionView, workspaceId: string): ProjectScopeItem[] {
  return (session.allowed_scope.projects ?? []).filter(project => project.workspace_id === workspaceId);
}

export function canReadIssueTrends(session: WebSessionView, workspaceId: string, projectId?: string): boolean {
  if (session.target?.kind === "issue") return false;
  if (!id(workspaceId) || (projectId !== undefined && !id(projectId))) return false;
  if (session.principal.is_owner && session.allowed_scope.kind === "instance") return true;
  if (projectId !== undefined) return issueTrendProjects(session, workspaceId).some(project => project.project_id === projectId);
  if (session.allowed_scope.kind !== "workspace" && session.allowed_scope.kind !== "project_selection") return false;
  if (session.allowed_scope.kind === "workspace" && session.allowed_scope.workspace_id !== workspaceId) return false;
  if (session.principal.is_owner) return session.allowed_scope.kind === "workspace";
  return (session.management_grants ?? []).some(grant => grant.principal_id === session.principal.id
    && grant.workspace_id === workspaceId && grant.project_id === null && grant.revoked_at === null);
}

export function issueTrendsPath(request: IssueTrendRequest): string | null {
  if (!id(request.workspaceId) || ![30, 90, 365].includes(request.days)) return null;
  if (request.projectId !== undefined && !id(request.projectId)) return null;
  if (request.milestoneId !== undefined && (!request.projectId || !id(request.milestoneId))) return null;
  const params = new URLSearchParams({ days: String(request.days) });
  if (request.milestoneId) params.set("milestone", request.milestoneId);
  const base = `/api/v1/workspaces/${encodeURIComponent(request.workspaceId)}`;
  return `${base}${request.projectId ? `/projects/${encodeURIComponent(request.projectId)}` : ""}/issues/trends?${params}`;
}

export function issueTrendsSelection(search: string): { days: IssueTrendWindow; milestoneId: string } {
  const params = new URLSearchParams(search);
  const rawDays = params.getAll("days");
  const days = rawDays.length === 1 && ["30", "90", "365"].includes(rawDays[0]!) ? Number(rawDays[0]) as IssueTrendWindow : 30;
  const rawMilestone = params.getAll("milestone");
  const milestoneId = rawMilestone.length === 1 && id(rawMilestone[0]) ? rawMilestone[0] : "all";
  return { days, milestoneId };
}

export function isIssueTrends(value: unknown, request: IssueTrendRequest): value is IssueTrends {
  if (!record(value) || value.timezone !== "UTC" || !date(value.from_date) || !date(value.to_date)
    || typeof value.observed_at !== "string" || !Number.isFinite(Date.parse(value.observed_at))
    || !record(value.scope) || value.scope.workspace_id !== request.workspaceId
    || value.scope.milestone_id !== (request.milestoneId ?? null)
    || !Array.isArray(value.scope.project_ids) || !value.scope.project_ids.every(id)
    || value.scope.project_ids.length > 100 || new Set(value.scope.project_ids).size !== value.scope.project_ids.length
    || !Array.isArray(value.projects) || !Array.isArray(value.points) || value.points.length !== request.days) return false;
  const scopedIds = value.scope.project_ids as string[];
  const expected = request.projectId ? [request.projectId] : null;
  if (expected && JSON.stringify([...scopedIds].sort()) !== JSON.stringify([...expected].sort())) return false;
  if (value.projects.length !== scopedIds.length || new Set(value.projects.map(project => record(project) ? project.id : null)).size !== scopedIds.length) return false;
  if (!value.projects.every(project => record(project) && id(project.id) && scopedIds.includes(project.id)
    && typeof project.display_name === "string" && (project.stock_from === null || date(project.stock_from))
    && (project.flow_from === null || date(project.flow_from)) && ["pending", "complete", "partial"].includes(String(project.history_state)))) return false;
  const first = Date.parse(`${value.from_date}T00:00:00Z`);
  if (new Date(value.observed_at).toISOString().slice(0, 10) !== value.to_date) return false;
  if (first + (request.days - 1) * dayMilliseconds !== Date.parse(`${value.to_date}T00:00:00Z`)) return false;
  return value.points.every((point, index) => {
    if (!record(point) || point.date !== new Date(first + index * dayMilliseconds).toISOString().slice(0, 10) || !metrics.every(key => count(point[key]))) return false;
    for (const group of [["total", "done", "canceled", "unfinished"], ["created", "completed", "reopened"]]) {
      const missing = group.filter(key => point[key] === null).length;
      if (missing > 0 && missing !== group.length) return false;
    }
    return point.total === null || point.done === null || point.canceled === null || point.unfinished === null
      || point.total === (point.done as number) + (point.canceled as number) + (point.unfinished as number);
  });
}
