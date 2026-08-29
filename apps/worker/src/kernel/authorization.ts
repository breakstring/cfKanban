import { authenticateRequest } from "./auth.ts";
import { ApiError, forbidden, notFound, platformUnavailable, unauthorized } from "./errors.ts";
import type { AuthContext } from "./types.ts";

type BindValue = string | number | null;

export interface SqlGuard {
  sql: string;
  values: BindValue[];
}

export interface VisibleProject {
  projectId: string;
  projectKey: string;
  projectName: string;
  projectVersion: number;
  role: "owner" | "reader" | "writer";
  workspaceId: string;
  workspaceKey: string;
  workspaceName: string;
}

interface VisibleProjectRow {
  project_id: string;
  project_key: string;
  project_name: string;
  project_version: number;
  role: "owner" | "reader" | "writer";
  workspace_id: string;
  workspace_key: string;
  workspace_name: string;
}

function parameter(index: number): string {
  return `?${index}`;
}

export function buildCurrentAuthGuard(
  auth: AuthContext,
  now: number,
  startIndex: number,
  ownerOnly = false,
): SqlGuard {
  if (auth.kind === "bearer") {
    const credential = parameter(startIndex);
    const principal = parameter(startIndex + 1);
    return {
      sql: `EXISTS (
        SELECT 1
        FROM credentials AS auth_credential
        JOIN principals AS auth_principal ON auth_principal.id = auth_credential.principal_id
        JOIN instance_meta AS auth_instance ON auth_instance.singleton = 1
        WHERE auth_credential.id = ${credential}
          AND auth_credential.principal_id = ${principal}
          AND auth_credential.revoked_at IS NULL
          ${ownerOnly ? "AND auth_instance.owner_principal_id = auth_credential.principal_id" : ""}
      )`,
      values: [auth.credentialId, auth.principalId],
    };
  }

  const session = parameter(startIndex);
  const principal = parameter(startIndex + 1);
  const currentTime = parameter(startIndex + 2);
  return {
    sql: `EXISTS (
      SELECT 1
      FROM web_sessions AS auth_session
      JOIN principals AS auth_principal ON auth_principal.id = auth_session.principal_id
      JOIN instance_meta AS auth_instance ON auth_instance.singleton = 1
      WHERE auth_session.id = ${session}
        AND auth_session.principal_id = ${principal}
        AND auth_session.revoked_at IS NULL
        AND auth_session.expires_at > ${currentTime}
        AND (
          (auth_session.source_kind = 'credential' AND EXISTS (
            SELECT 1 FROM credentials AS auth_source_credential
            WHERE auth_source_credential.id = auth_session.source_id
              AND auth_source_credential.principal_id = auth_session.principal_id
              AND auth_source_credential.revoked_at IS NULL
          ))
          OR
          (auth_session.source_kind = 'web_authenticator' AND EXISTS (
            SELECT 1 FROM web_authenticators AS auth_source_passkey
            WHERE auth_source_passkey.id = auth_session.source_id
              AND auth_source_passkey.principal_id = auth_session.principal_id
              AND auth_source_passkey.revoked_at IS NULL
          ))
        )
        ${ownerOnly ? "AND auth_instance.owner_principal_id = auth_session.principal_id AND auth_session.target_kind = 'admin'" : ""}
    )`,
    values: [auth.sessionId, auth.principalId, now],
  };
}

export function requireOwnerControl(auth: AuthContext, bearerOnly = false): void {
  if (!auth.isOwner) throw forbidden();
  if (bearerOnly && auth.kind !== "bearer") throw forbidden();
  if (auth.kind === "cookie" && auth.targetKind !== "admin") throw forbidden();
}

export async function reauthenticateOwner(
  db: D1Database,
  request: Request,
  now: number,
  bearerOnly = false,
): Promise<AuthContext> {
  const auth = await authenticateRequest(db, request, now);
  requireOwnerControl(auth, bearerOnly);
  return auth;
}

export async function verifyCurrentAuth(db: D1Database, auth: AuthContext, now: number): Promise<void> {
  const guard = buildCurrentAuthGuard(auth, now, 1);
  try {
    const row = await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first();
    if (row === null) throw unauthorized();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1");
  }
}

function fixedTarget(auth: AuthContext): {
  projectId?: string;
  projectKey?: string;
  workspaceKey?: string;
} | null {
  if (auth.kind !== "cookie" || (auth.targetKind !== "project" && auth.targetKind !== "issue")) {
    return null;
  }
  const target: { projectId?: string; projectKey?: string; workspaceKey?: string } = {};
  if (typeof auth.target.project_id === "string") target.projectId = auth.target.project_id;
  if (typeof auth.target.project_key === "string") target.projectKey = auth.target.project_key;
  if (typeof auth.target.workspace_key === "string") target.workspaceKey = auth.target.workspace_key;
  return target;
}

function mapVisibleProject(row: VisibleProjectRow): VisibleProject {
  return {
    projectId: row.project_id,
    projectKey: row.project_key,
    projectName: row.project_name,
    projectVersion: row.project_version,
    role: row.role,
    workspaceId: row.workspace_id,
    workspaceKey: row.workspace_key,
    workspaceName: row.workspace_name,
  };
}

export async function resolveVisibleProjects(db: D1Database, auth: AuthContext): Promise<VisibleProject[]> {
  const target = fixedTarget(auth);
  const targetProjectId = target?.projectId ?? null;
  const targetWorkspaceKey = target?.workspaceKey ?? null;
  const targetProjectKey = target?.projectKey ?? null;
  try {
    if (auth.isOwner) {
      const result = await db.prepare(
        `SELECT p.id AS project_id, p.key AS project_key, p.display_name AS project_name,
                p.version AS project_version, w.id AS workspace_id, w.key AS workspace_key,
                w.display_name AS workspace_name, 'owner' AS role
         FROM projects AS p
         JOIN workspaces AS w ON w.id = p.workspace_id
         WHERE p.deleted_at IS NULL AND w.deleted_at IS NULL
           AND (?1 IS NULL OR p.id = ?1)
           AND (?2 IS NULL OR w.key = ?2)
           AND (?3 IS NULL OR p.key = ?3)
         ORDER BY w.key, p.key`,
      ).bind(targetProjectId, targetWorkspaceKey, targetProjectKey).all<VisibleProjectRow>();
      return result.results.map(mapVisibleProject);
    }

    const result = await db.prepare(
      `SELECT p.id AS project_id, p.key AS project_key, p.display_name AS project_name,
              p.version AS project_version, w.id AS workspace_id, w.key AS workspace_key,
              w.display_name AS workspace_name, pg.role
       FROM project_grants AS pg
       JOIN projects AS p ON p.id = pg.project_id
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE pg.principal_id = ?1 AND pg.revoked_at IS NULL
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL
         AND (?2 IS NULL OR p.id = ?2)
         AND (?3 IS NULL OR w.key = ?3)
         AND (?4 IS NULL OR p.key = ?4)
       ORDER BY w.key, p.key`,
    ).bind(auth.principalId, targetProjectId, targetWorkspaceKey, targetProjectKey).all<VisibleProjectRow>();
    return result.results.map(mapVisibleProject);
  } catch {
    throw platformUnavailable("d1");
  }
}

export async function requireVisibleProject(
  db: D1Database,
  auth: AuthContext,
  workspaceKey: string,
  projectKey: string,
  requiredRole: "reader" | "writer" = "reader",
): Promise<VisibleProject> {
  const visible = await resolveVisibleProjects(db, auth);
  const project = visible.find(
    (candidate) => candidate.workspaceKey === workspaceKey && candidate.projectKey === projectKey,
  );
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && project.role === "reader") throw forbidden();
  return project;
}
