import type { ContainerResource, ProjectScopeItem } from "../types";

export interface WorkspaceGroup {
  id: string;
  name: string;
  projects: ProjectScopeItem[];
  canManage: boolean;
}

export function groupProjects(projects: ProjectScopeItem[], workspaces: ContainerResource[], search = ""): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const workspace of workspaces) groups.set(workspace.id, { id: workspace.id, name: workspace.display_name, projects: [], canManage: workspace.allowed_actions?.some(action => ["update", "create_project", "manage_administrators"].includes(action)) ?? false });
  for (const project of projects) {
    const group = groups.get(project.workspace_id) ?? { id: project.workspace_id, name: project.workspace_display_name, projects: [], canManage: false };
    group.projects.push(project);
    groups.set(group.id, group);
  }
  const query = search.trim().toLocaleLowerCase();
  return [...groups.values()].map(group => ({ ...group, projects: group.name.toLocaleLowerCase().includes(query)
    ? group.projects
    : group.projects.filter(project => project.project_display_name.toLocaleLowerCase().includes(query)) }))
    .filter(group => !query || group.name.toLocaleLowerCase().includes(query) || group.projects.length > 0);
}

export function projectReturnTarget(value: string | null, projects: ProjectScopeItem[]): ProjectScopeItem | undefined {
  if (!value) return undefined;
  const match = /^\/app\/w\/([^/]+)\/p\/([^/?#]+)$/.exec(value);
  return match ? projects.find(project => project.workspace_id === match[1] && project.project_id === match[2]) : undefined;
}
