import type { ApiErrorBody, ProjectScopeItem, WebSessionView } from "../types";

function orderedProjects(projects: ProjectScopeItem[] | undefined): ProjectScopeItem[] {
  return [...(projects ?? [])].sort((left, right) => (
    left.project_id.localeCompare(right.project_id)
      || left.workspace_id.localeCompare(right.workspace_id)
      || left.role.localeCompare(right.role)
  ));
}

export function projectInventoryBoundary(projects: ProjectScopeItem[] | undefined): string {
  return JSON.stringify(projects === undefined ? null : orderedProjects(projects)
    .map(({ project_id, workspace_id, role }) => ({ project_id, workspace_id, role })));
}

function boundaryValue(session: WebSessionView): Record<string, unknown> {
  const scopeProjects = session.allowed_scope.kind === "instance"
    ? []
    : orderedProjects(session.allowed_scope.projects);
  return {
    allowed_scope: {
      kind: session.allowed_scope.kind,
      project_id: session.allowed_scope.project_id ?? null,
      workspace_id: session.allowed_scope.workspace_id ?? null,
      projects: scopeProjects.map(({ project_id, workspace_id, role }) => ({ project_id, workspace_id, role })),
    },
    management_grants: [...(session.management_grants ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, workspace_id, project_id, version, generation, revoked_at }) => ({ id, workspace_id, project_id, version, generation, revoked_at })),
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

export function isVerifiedServiceAccessFailure(status: number, body: ApiErrorBody): boolean {
  if (body.source !== "service" || body.details?.normalized_by === "client") return false;
  return (status === 401 && body.category === "authentication" && body.code === "UNAUTHORIZED")
    || (status === 403 && body.category === "authorization" && body.code === "FORBIDDEN")
    || (status === 404 && body.category === "not_found" && body.code === "NOT_FOUND");
}

export function shouldClearAfterSessionRevalidation(
  failure: { body: ApiErrorBody; status: number },
): boolean {
  return isVerifiedServiceAccessFailure(failure.status, failure.body);
}
