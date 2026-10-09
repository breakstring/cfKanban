import { boardPath, boardReturnPath } from "./board-navigation";
import { hasManagementActions, managementPath } from "./scoped-management";
import { canAccessOwnerControlPlane } from "./session-capabilities";
import type { ContainerResource, WebSessionView } from "../types";

export type ProjectSettingsSection = "management" | "labels" | "activity" | "deleted";
export const ownerWorkspacesReturnTarget = "owner-workspaces";
export type ProjectSettingsReturnTarget = typeof ownerWorkspacesReturnTarget;

export function ownerWorkspacesReturnPath(session: WebSessionView, workspaceId: string, query: string): string | null {
  const targets = new URLSearchParams(query).getAll("return");
  if (!canAccessOwnerControlPlane(session) || targets.length !== 1 || targets[0] !== ownerWorkspacesReturnTarget) return null;
  return `/app/admin?${new URLSearchParams({ section: "workspaces", workspace: workspaceId })}`;
}

export function ownerWorkspaceSettingsPath(workspaceId: string): string {
  return `${managementPath(workspaceId)}&${new URLSearchParams({ section: "settings", return: ownerWorkspacesReturnTarget })}`;
}

export function ownerProjectSettingsPath(
  workspaceId: string,
  projectId: string,
  section: ProjectSettingsSection = "management",
  archived = false,
): string {
  return projectSettingsPath(workspaceId, projectId, section, undefined, archived, ownerWorkspacesReturnTarget);
}

export function projectSettingsPath(
  workspaceId: string,
  projectId: string,
  section: ProjectSettingsSection,
  returnTo = boardPath(workspaceId, projectId),
  archived = false,
  returnTarget?: ProjectSettingsReturnTarget,
): string {
  const from = boardReturnPath(workspaceId, projectId, new URLSearchParams({ from: returnTo }).toString());
  const query = new URLSearchParams({ from });
  if (returnTarget === ownerWorkspacesReturnTarget) query.set("return", returnTarget);
  if (section === "management") {
    if (archived) query.set("archived", "1");
    return `${managementPath(workspaceId, projectId)}&${query}`;
  }
  return `${boardPath(workspaceId, projectId)}/${section}?${query}`;
}

export function projectSettingsSections(
  session: WebSessionView,
  workspaceId: string,
  projectId: string,
  project: ContainerResource | null,
): ProjectSettingsSection[] {
  if (!project) return [];
  const scopedProject = session.allowed_scope.projects?.find(item => item.workspace_id === workspaceId && item.project_id === projectId);
  const unlistedOwner = session.principal.is_owner && session.allowed_scope.projects === undefined && (
    session.allowed_scope.kind === "instance"
    || (session.allowed_scope.kind === "workspace" && session.allowed_scope.workspace_id === workspaceId)
    || (session.allowed_scope.kind === "project" && session.allowed_scope.workspace_id === workspaceId && session.allowed_scope.project_id === projectId)
  );
  const role = scopedProject?.role ?? (unlistedOwner ? "owner" : null);
  const managementScope = session.allowed_scope.kind === "instance"
    || session.allowed_scope.kind === "project_selection"
    || (session.allowed_scope.kind === "workspace" && session.allowed_scope.workspace_id === workspaceId)
    || (session.allowed_scope.kind === "project" && session.allowed_scope.workspace_id === workspaceId && session.allowed_scope.project_id === projectId);
  const archivedManagement = managementScope && (session.management_grants ?? []).some(grant =>
    grant.principal_id === session.principal.id && grant.revoked_at === null
    && grant.workspace_id === workspaceId && (grant.project_id === null || grant.project_id === projectId));
  const sections: ProjectSettingsSection[] = hasManagementActions(project) && (role !== null || archivedManagement) ? ["management"] : [];
  if (role && project.deleted_at === null) sections.push("labels", "activity");
  if ((role === "owner" || role === "writer") && project.deleted_at === null) sections.push("deleted");
  return sections;
}
