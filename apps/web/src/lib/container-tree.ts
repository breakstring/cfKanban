import type { ContainerResource, ListResult } from "../types";
import { ColumnPagination } from "./column-pagination";

export type ContainerState = "active" | "archived";
export interface TreeProject extends ContainerResource { workspaceId: string; workspaceName: string }
type FetchPage = (path: string) => Promise<ListResult<ContainerResource>>;

export class ContainerTree {
  workspaces = { active: new ColumnPagination<ContainerResource>(), archived: new ColumnPagination<ContainerResource>() };
  projects: Record<string, ColumnPagination<ContainerResource>> = {};
  private generation = 0;

  reset(): void {
    this.generation += 1;
    this.workspaces.active.reset();
    this.workspaces.archived.reset();
    for (const page of Object.values(this.projects)) page.reset();
    this.projects = {};
  }

  projectPage(workspaceId: string, state: ContainerState): ColumnPagination<ContainerResource> {
    return this.projects[`${state}:${workspaceId}`] ??= new ColumnPagination<ContainerResource>();
  }

  async loadWorkspaces(fetchPage: FetchPage, state: ContainerState, includeArchivedProjects: boolean): Promise<void> {
    const generation = this.generation;
    const loaded = await this.workspaces[state].load(cursor => fetchPage(this.path("/api/v1/workspaces", state, cursor)));
    if (!loaded || generation !== this.generation) return;
    // Initialize only the first Project page of newly visible Workspaces; never drain cursors.
    await Promise.all(this.workspaces[state].items.flatMap(workspace => {
      const states: ContainerState[] = state === "active" ? ["active"] : [];
      if (includeArchivedProjects) states.push("archived");
      return states.filter(kind => !this.projectPage(workspace.id, kind).loaded)
        .map(kind => this.loadProjects(fetchPage, workspace.id, kind));
    }));
  }

  async loadProjects(fetchPage: FetchPage, workspaceId: string, state: ContainerState): Promise<void> {
    await this.projectPage(workspaceId, state).load(cursor => fetchPage(this.path(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`, state, cursor,
    )));
  }

  entries(state: ContainerState): TreeProject[] {
    return [...this.workspaces.active.items, ...this.workspaces.archived.items].flatMap(workspace =>
      (this.projects[`${state}:${workspace.id}`]?.items ?? []).map(project => ({
        ...project, workspaceId: workspace.id, workspaceName: workspace.display_name,
      })));
  }

  private path(base: string, state: ContainerState, cursor?: string): string {
    const params = new URLSearchParams({ limit: "20" });
    if (state === "archived") params.set("deleted", "only");
    if (cursor) params.set("cursor", cursor);
    return `${base}?${params}`;
  }
}
