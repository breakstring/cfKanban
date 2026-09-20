import { buildCurrentAuthGuard, type SqlGuard } from "./authorization.ts";
import { ApiError, forbidden, notFound, platformUnavailable } from "./errors.ts";
import type { AuthContext } from "./types.ts";

export type ManagementCapability = "manage_workspace" | "create_project" | "manage_project"
  | "manage_members" | "manage_administrators" | "archive_project";

export interface ManagementScope {
  workspaceId: string;
  projectId?: string;
}

export interface ManagementAuthorization {
  authorizedVia: "deployment_owner" | "workspace_admin" | "project_admin";
  administratorGrantId: string | null;
  administratorGrantVersion: number | null;
  administratorGeneration: string | null;
}

export function sessionAllowsManagement(auth: AuthContext, scope: ManagementScope): boolean {
  if (auth.kind === "bearer") return true;
  if (auth.targetKind === "admin") return auth.isOwner;
  if (auth.targetKind === "project_selection") return !auth.isOwner;
  if (auth.targetKind === "workspace") return auth.target.workspace_id === scope.workspaceId;
  if (auth.isOwner || scope.projectId === undefined) return false;
  return auth.target.workspace_id === scope.workspaceId && auth.target.project_id === scope.projectId;
}

export function managementAuthorization(
  auth: AuthContext,
  scope: ManagementScope,
  capability: ManagementCapability,
): ManagementAuthorization | null {
  if (!sessionAllowsManagement(auth, scope)) return null;
  if (auth.isOwner) return {
    authorizedVia: "deployment_owner", administratorGrantId: null,
    administratorGrantVersion: null, administratorGeneration: null,
  };
  if (capability === "manage_administrators" && scope.projectId === undefined) return null;
  const workspaceOnly = scope.projectId === undefined || capability === "archive_project"
    || capability === "manage_administrators" || capability === "create_project" || capability === "manage_workspace";
  const grant = (auth.managementGrants ?? []).filter((candidate) => candidate.revoked_at === null
    && candidate.workspace_id === scope.workspaceId
    && (candidate.project_id === null || (!workspaceOnly && candidate.project_id === scope.projectId)))
    .sort((a, b) => Number(a.project_id !== null) - Number(b.project_id !== null))[0];
  if (grant === undefined) return null;
  return {
    authorizedVia: grant.project_id === null ? "workspace_admin" : "project_admin",
    administratorGrantId: grant.id,
    administratorGrantVersion: grant.version,
    administratorGeneration: grant.generation,
  };
}

export function buildManagementGuard(
  auth: AuthContext,
  now: number,
  startIndex: number,
  scope: ManagementScope,
  capability: ManagementCapability,
  allowDeletedProject = false,
): SqlGuard {
  const source = managementAuthorization(auth, scope, capability);
  if (source === null) return { sql: "0 = 1", values: [] };
  const current = buildCurrentAuthGuard(auth, now, startIndex);
  const values = [...current.values];
  const bind = (value: string | number | null): string => {
    const parameter = `?${startIndex + values.length}`;
    values.push(value);
    return parameter;
  };
  const workspace = bind(scope.workspaceId);
  const project = scope.projectId === undefined ? null : bind(scope.projectId);
  const principal = bind(auth.principalId);
  let role: string;
  if (auth.isOwner) {
    role = `EXISTS (SELECT 1 FROM instance_meta control_instance WHERE control_instance.singleton = 1 AND control_instance.owner_principal_id = ${principal})`;
  } else {
    const id = bind(source.administratorGrantId);
    const generation = bind(source.administratorGeneration);
    role = `EXISTS (SELECT 1 FROM scoped_administrator_grants control_grant
      WHERE control_grant.id = ${id} AND control_grant.generation = ${generation}
        AND control_grant.principal_id = ${principal} AND control_grant.revoked_at IS NULL
        AND control_grant.workspace_id = ${workspace}
        AND ${source.authorizedVia === "workspace_admin" ? "control_grant.project_id IS NULL" : `control_grant.project_id = ${project}`})`;
  }
  // The archive exception is limited to Owner/Workspace administrators;
  // a Project administrator's cached auth cannot survive a concurrent archive.
  return {
    sql: `(${current.sql}) AND (${role}) AND EXISTS (
      SELECT 1 FROM workspaces control_workspace
      ${project === null ? "" : "JOIN projects control_project ON control_project.workspace_id = control_workspace.id"}
      WHERE control_workspace.id = ${workspace}
        ${auth.isOwner ? "" : "AND control_workspace.deleted_at IS NULL"}
        ${project === null ? "" : `AND control_project.id = ${project} ${allowDeletedProject && source.authorizedVia !== "project_admin" ? "" : "AND control_project.deleted_at IS NULL"}`}
    )`,
    values,
  };
}

export async function requireManagementAuthorization(
  db: D1Database,
  auth: AuthContext,
  scope: ManagementScope,
  capability: ManagementCapability,
  now: number,
  allowDeletedProject = false,
): Promise<ManagementAuthorization> {
  const source = managementAuthorization(auth, scope, capability);
  if (source === null) throw forbidden();
  const guard = buildManagementGuard(auth, now, 1, scope, capability, allowDeletedProject);
  try {
    const row = await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first();
    if (row === null) throw notFound();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
  return source;
}
