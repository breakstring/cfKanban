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
    if (row === null) throw unauthorized(auth.kind === "cookie");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}

interface FixedTarget {
  invalid: boolean;
  issueNumber: number | null;
  projectId: string | null;
  projectKey: string | null;
  workspaceKey: string | null;
}

function fixedTarget(auth: AuthContext): FixedTarget | null {
  if (auth.kind !== "cookie" || (auth.targetKind !== "project" && auth.targetKind !== "issue")) {
    return null;
  }
  if (auth.targetKind === "issue") {
    const identifier = auth.target.identifier;
    const match = typeof identifier === "string" ? /^CFK-([1-9][0-9]*)$/.exec(identifier) : null;
    const issueNumber = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    return {
      invalid: !Number.isSafeInteger(issueNumber),
      issueNumber: Number.isSafeInteger(issueNumber) ? issueNumber : null,
      projectId: null,
      projectKey: null,
      workspaceKey: null,
    };
  }

  const projectId = typeof auth.target.project_id === "string" ? auth.target.project_id : null;
  const projectKey = typeof auth.target.project_key === "string" ? auth.target.project_key : null;
  const workspaceKey = typeof auth.target.workspace_key === "string" ? auth.target.workspace_key : null;
  const hasProjectId = projectId !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(projectId);
  const hasKeyPair = projectKey !== null && projectKey.length > 0 && workspaceKey !== null && workspaceKey.length > 0;
  return {
    invalid: !hasProjectId && !hasKeyPair,
    issueNumber: null,
    projectId: hasProjectId ? projectId : null,
    projectKey: hasKeyPair ? projectKey : null,
    workspaceKey: hasKeyPair ? workspaceKey : null,
  };
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

async function queryVisibleProjects(
  db: D1Database,
  auth: AuthContext,
  includeEffectiveDeleted = false,
  currentAuthAt: number | null = null,
): Promise<VisibleProject[]> {
  const target = fixedTarget(auth);
  if (target?.invalid === true) return [];
  const targetProjectId = target?.projectId ?? null;
  const targetWorkspaceKey = target?.workspaceKey ?? null;
  const targetProjectKey = target?.projectKey ?? null;
  const targetIssueNumber = target?.issueNumber ?? null;
  try {
    if (auth.isOwner) {
      const currentAuth = currentAuthAt === null ? null : buildCurrentAuthGuard(auth, currentAuthAt, 5);
      const result = await db.prepare(
        `SELECT p.id AS project_id, p.key AS project_key, p.display_name AS project_name,
                p.version AS project_version, w.id AS workspace_id, w.key AS workspace_key,
                w.display_name AS workspace_name, 'owner' AS role
         FROM projects AS p
         JOIN workspaces AS w ON w.id = p.workspace_id
         WHERE ${includeEffectiveDeleted ? "1 = 1" : "p.deleted_at IS NULL AND w.deleted_at IS NULL"}
           AND (?1 IS NULL OR p.id = ?1)
           AND (?2 IS NULL OR w.key = ?2)
           AND (?3 IS NULL OR p.key = ?3)
           AND (?4 IS NULL OR EXISTS (
             SELECT 1 FROM issues AS target_issue
             WHERE target_issue.number = ?4 AND target_issue.project_id = p.id
               AND target_issue.deleted_at IS NULL
           ))
           ${currentAuth === null ? "" : `AND ${currentAuth.sql}`}
         ORDER BY w.key, p.key`,
      ).bind(
        targetProjectId,
        targetWorkspaceKey,
        targetProjectKey,
        targetIssueNumber,
        ...(currentAuth?.values ?? []),
      ).all<VisibleProjectRow>();
      if (currentAuthAt !== null && result.results.length === 0) {
        await verifyCurrentAuth(db, auth, currentAuthAt);
      }
      return result.results.map(mapVisibleProject);
    }

    const currentAuth = currentAuthAt === null ? null : buildCurrentAuthGuard(auth, currentAuthAt, 6);
    const result = await db.prepare(
      `SELECT p.id AS project_id, p.key AS project_key, p.display_name AS project_name,
              p.version AS project_version, w.id AS workspace_id, w.key AS workspace_key,
              w.display_name AS workspace_name, pg.role
       FROM project_grants AS pg
       JOIN projects AS p ON p.id = pg.project_id
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE pg.principal_id = ?1 AND pg.revoked_at IS NULL
         AND ${includeEffectiveDeleted ? "1 = 1" : "p.deleted_at IS NULL AND w.deleted_at IS NULL"}
         AND (?2 IS NULL OR p.id = ?2)
         AND (?3 IS NULL OR w.key = ?3)
         AND (?4 IS NULL OR p.key = ?4)
         AND (?5 IS NULL OR EXISTS (
           SELECT 1 FROM issues AS target_issue
           WHERE target_issue.number = ?5 AND target_issue.project_id = p.id
             AND target_issue.deleted_at IS NULL
         ))
         ${currentAuth === null ? "" : `AND ${currentAuth.sql}`}
       ORDER BY w.key, p.key`,
    ).bind(
      auth.principalId,
      targetProjectId,
      targetWorkspaceKey,
      targetProjectKey,
      targetIssueNumber,
      ...(currentAuth?.values ?? []),
    ).all<VisibleProjectRow>();
    if (currentAuthAt !== null && result.results.length === 0) {
      await verifyCurrentAuth(db, auth, currentAuthAt);
    }
    return result.results.map(mapVisibleProject);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}

export async function resolveVisibleProjects(
  db: D1Database,
  auth: AuthContext,
  includeEffectiveDeleted = false,
): Promise<VisibleProject[]> {
  return queryVisibleProjects(db, auth, includeEffectiveDeleted);
}

export async function resolveCurrentVisibleProjects(
  db: D1Database,
  auth: AuthContext,
  now: number,
  includeEffectiveDeleted = false,
): Promise<VisibleProject[]> {
  return queryVisibleProjects(db, auth, includeEffectiveDeleted, now);
}

export async function requireProjectAuthorization(
  db: D1Database,
  auth: AuthContext,
  workspaceKey: string,
  projectKey: string,
  requiredRole: "reader" | "writer" = "reader",
  includeDeletedParentsForRecoveryView = false,
): Promise<VisibleProject> {
  // Idempotent replay may ignore a child resource's later tombstone, but a
  // retained Grant is not effective while its Project or Workspace is paused.
  const projects = await resolveVisibleProjects(
    db,
    auth,
    includeDeletedParentsForRecoveryView && auth.isOwner,
  );
  const project = projects.find(
    (candidate) => candidate.workspaceKey === workspaceKey && candidate.projectKey === projectKey,
  );
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && project.role === "reader") throw forbidden();
  return project;
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
