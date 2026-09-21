import type { AccessSource, ContainerResource, Locale, ProjectRole, ProjectScopeItem, WebSessionView } from "../types";

export type ProjectDisplayRole = ProjectRole | "workspace_admin" | "project_admin";

export function projectDisplayRole(session: WebSessionView, project: ProjectScopeItem): ProjectDisplayRole {
  if (project.role === "owner") return "owner";
  const grants = (session.management_grants ?? []).filter(grant =>
    grant.principal_id === session.principal.id
    && grant.workspace_id === project.workspace_id
    && grant.revoked_at === null);
  if (grants.some(grant => grant.project_id === null)) return "workspace_admin";
  if (grants.some(grant => grant.project_id === project.project_id)) return "project_admin";
  return project.role;
}

export function projectRoleLabel(role: ProjectDisplayRole, locale: Locale): string {
  const labels = {
    owner: ["Owner", "所有者"],
    workspace_admin: ["Workspace administrator", "工作区管理员"],
    project_admin: ["Project administrator", "项目管理员"],
    writer: ["Writer", "协作者"],
    reader: ["Reader", "只读者"],
  } as const;
  return labels[role][locale === "zh-CN" ? 1 : 0];
}

export function managementPath(workspaceId: string, projectId?: string): string {
  const params = new URLSearchParams({ workspace: workspaceId });
  if (projectId) params.set("project", projectId);
  return `/app/manage?${params}`;
}

export function hasManagementActions(resource: ContainerResource | null): boolean {
  return resource?.allowed_actions?.some(action => ["update", "manage_members", "manage_administrators", "create_project", "restore"].includes(action)) ?? false;
}

export function managedWorkspaceIds(session: WebSessionView): string[] {
  // A fixed Project session never becomes a Workspace management session.
  if (session.allowed_scope.kind === "workspace") {
    return session.allowed_scope.workspace_id ? [session.allowed_scope.workspace_id] : [];
  }
  if (session.allowed_scope.kind !== "project_selection") return [];
  return [...new Set((session.management_grants ?? [])
    .filter(grant => grant.project_id === null && grant.revoked_at === null)
    .map(grant => grant.workspace_id))];
}

export function remainingAccessSources(sources: AccessSource[], removedId: string): AccessSource[] {
  return sources.filter(source => source.id !== removedId);
}

export function sourceLabel(kind: AccessSource["kind"], chinese: boolean): string {
  const names = {
    workspace_admin: ["Workspace administrator (inherited)", "工作区管理员（继承）"],
    project_admin: ["Project administrator (direct)", "项目管理员（直接）"],
    project_grant: ["Project member (direct)", "项目成员（直接）"],
    deployment_owner: ["Deployment Owner", "实例所有者"],
  } as const;
  return names[kind][chinese ? 1 : 0];
}
