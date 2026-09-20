import { buildCurrentAuthGuard, requireProjectAuthorization, verifyCurrentAuth } from "../kernel/authorization.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { principalDisplayNameKey, requirePrincipalDisplayName, requireUuid } from "../domain/model.ts";
import { conflict, platformUnavailable, validationError } from "../kernel/errors.ts";

export async function principalDisplayNameExists(
  db: D1Database,
  displayName: string,
  excludedPrincipalId: string | null = null,
): Promise<boolean> {
  try {
    return await db.prepare(
      `SELECT 1 FROM principals WHERE display_name_key = ?1 AND (?2 IS NULL OR id != ?2) LIMIT 1`,
    ).bind(principalDisplayNameKey(displayName), excludedPrincipalId).first() !== null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

export function principalDisplayNameConflict() {
  return conflict("PRINCIPAL_DISPLAY_NAME_CONFLICT", "choose_another_display_name");
}

export async function findProjectAssignee(
  db: D1Database,
  auth: AuthContext,
  workspaceIdValue: JsonValue,
  projectIdValue: JsonValue,
  url: URL,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const workspaceId = requireUuid(workspaceIdValue, "workspace_id");
  const projectId = requireUuid(projectIdValue, "project_id");
  await requireProjectAuthorization(db, auth, workspaceId, projectId);
  if (url.searchParams.getAll("display_name").length !== 1) {
    throw validationError("schema_validation_failed", { field: "display_name" });
  }
  const displayName = requirePrincipalDisplayName(url.searchParams.get("display_name"));
  const currentAuth = buildCurrentAuthGuard(auth, now, 6);
  try {
    const result = await db.prepare(
      `SELECT principal.id AS principal_id, principal.display_name
       FROM principals principal
       JOIN instance_meta instance ON instance.singleton = 1
       JOIN projects project ON project.id = ?2 AND project.workspace_id = ?3
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE principal.display_name_key = ?1
         AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
         AND (?4 = 1 OR EXISTS (
           SELECT 1 FROM project_grants caller_grant
           WHERE caller_grant.project_id = project.id AND caller_grant.principal_id = ?5
             AND caller_grant.revoked_at IS NULL
         ))
         AND (principal.id = instance.owner_principal_id OR EXISTS (
           SELECT 1 FROM project_grants candidate_grant
           WHERE candidate_grant.project_id = project.id AND candidate_grant.principal_id = principal.id
             AND candidate_grant.role = 'writer' AND candidate_grant.revoked_at IS NULL
         ))
         AND ${currentAuth.sql}
       LIMIT 1`,
    ).bind(principalDisplayNameKey(displayName), projectId, workspaceId, auth.isOwner ? 1 : 0,
      auth.principalId, ...currentAuth.values).all<{ principal_id: string; display_name: string }>();
    await verifyCurrentAuth(db, auth, now);
    await requireProjectAuthorization(db, auth, workspaceId, projectId);
    return { items: result.results, has_more: false, next_cursor: null };
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}
