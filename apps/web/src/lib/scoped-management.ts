import type { AccessSource, ContainerResource, WebSessionView } from "../types";

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
