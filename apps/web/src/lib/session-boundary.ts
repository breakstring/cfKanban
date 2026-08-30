import type { ProjectScopeItem, WebSessionView } from "../types";

function orderedProjects(projects: ProjectScopeItem[] | undefined): ProjectScopeItem[] {
  return [...(projects ?? [])].sort((left, right) => (
    left.project_id.localeCompare(right.project_id)
      || left.workspace_key.localeCompare(right.workspace_key)
      || left.project_key.localeCompare(right.project_key)
      || left.role.localeCompare(right.role)
  ));
}

function boundaryValue(session: WebSessionView): Record<string, unknown> {
  const scopeProjects = session.allowed_scope.kind === "instance"
    ? []
    : orderedProjects(session.allowed_scope.projects);
  return {
    allowed_scope: {
      kind: session.allowed_scope.kind,
      project_id: session.allowed_scope.project_id ?? null,
      projects: scopeProjects,
    },
    principal_id: session.principal.id,
    session_id: session.session_id,
    source: { id: session.source.id, kind: session.source.kind },
    target: {
      entry_path: session.target.entry_path ?? null,
      identifier: session.target.identifier ?? null,
      kind: session.target.kind,
      section: session.target.section ?? null,
    },
  };
}

export function sameSessionBoundary(left: WebSessionView, right: WebSessionView): boolean {
  return JSON.stringify(boundaryValue(left)) === JSON.stringify(boundaryValue(right));
}

export function shouldClearAfterSessionRevalidation(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}
