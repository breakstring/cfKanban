import type { ProjectScopeItem, StatusKey, WebSessionView } from "../types";

export type WorkQueue = "all" | "mine" | "unassigned" | "needs_reassignment";
export interface WorkListFilter {
  projects: string[];
  queue: WorkQueue;
  assignee: string;
  status: StatusKey | "";
  search: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workProjects(session: WebSessionView): ProjectScopeItem[] {
  return (session.allowed_scope.projects ?? []).filter(project => uuid.test(project.project_id)
    && (session.allowed_scope.kind !== "project" || project.project_id === session.allowed_scope.project_id)
    && (!session.allowed_scope.workspace_id || project.workspace_id === session.allowed_scope.workspace_id));
}

export function workListPath(filter: WorkListFilter, session: WebSessionView, cursor?: string): string | null {
  const allowed = new Set(workProjects(session).map(project => project.project_id));
  const projects = [...new Set(filter.projects)].sort();
  if (!projects.length || projects.length > 20 || projects.some(project => !allowed.has(project))) return null;
  const params = new URLSearchParams({ limit: "20" });
  for (const project of projects) params.append("project", project);
  const candidates = filter.queue === "unassigned" || filter.queue === "needs_reassignment";
  if (candidates) params.set("assignment", filter.queue);
  else {
    const assignee = filter.queue === "mine" ? session.principal.id : filter.assignee;
    if (assignee) {
      if (!uuid.test(assignee)) return null;
      params.set("assignee", assignee);
    }
    if (filter.status) params.set("status", filter.status);
  }
  if (filter.search.trim()) params.set("q", filter.search.trim());
  if (cursor) params.set("cursor", cursor);
  return `/api/v1/issues${candidates ? "/candidates" : ""}?${params}`;
}

export interface ResolvedWorkScope {
  projects: Array<{ project_id: string; project_display_name: string; workspace_display_name: string }>;
  unresolvedProjects: string[];
}
export function resolvedWorkScope(value: Record<string, unknown> | undefined): ResolvedWorkScope | null {
  if (!value || !Array.isArray(value.projects)) return null;
  return {
    projects: value.projects.flatMap(item => {
      if (!item || typeof item !== "object" || typeof item.project_id !== "string" || typeof item.project_display_name !== "string" || typeof item.workspace_display_name !== "string") return [];
      return [{ project_id: item.project_id, project_display_name: item.project_display_name, workspace_display_name: item.workspace_display_name }];
    }),
    unresolvedProjects: Array.isArray(value.unresolved_project_targets) ? value.unresolved_project_targets.filter((item): item is string => typeof item === "string") : [],
  };
}
