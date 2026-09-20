import { buildCurrentAuthGuard, requireProjectAuthorization, verifyCurrentAuth } from "../kernel/authorization.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { principalDisplayNameKey, requirePrincipalDisplayName, requireUuid } from "../domain/model.ts";
import { ApiError, conflict, platformUnavailable, validationError } from "../kernel/errors.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { isUuid } from "../kernel/crypto.ts";
import { requireLimit } from "./shared.ts";

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
  if (["display_name", "limit", "cursor"].some((name) => url.searchParams.getAll(name).length > 1)) {
    throw validationError("schema_validation_failed");
  }
  const displayNameValue = url.searchParams.get("display_name");
  const displayNameKey = displayNameValue === null ? null
    : principalDisplayNameKey(requirePrincipalDisplayName(displayNameValue));
  const limit = requireLimit(url);
  const context = await createCursorContext(
    "project-assignees", { display_name_key: displayNameKey, workspace_id: workspaceId }, [projectId], auth.principalId,
  );
  const cursor = decodeCursor(url.searchParams.get("cursor"), context);
  if (cursor !== null && (cursor.length !== 1 || typeof cursor[0] !== "string" || !isUuid(cursor[0]))) {
    throw invalidCursor();
  }
  const currentAuth = buildCurrentAuthGuard(auth, now, 8);
  try {
    const result = await db.prepare(
      `WITH candidate_ids(id) AS (
         SELECT owner_principal_id FROM instance_meta WHERE singleton = 1
         UNION
         SELECT principal_id FROM effective_project_grants
         WHERE project_id = ?2 AND role = 'writer' AND revoked_at IS NULL
       )
       SELECT principal.id AS principal_id, principal.display_name
       FROM candidate_ids candidate
       JOIN principals principal ON principal.id = candidate.id
       JOIN projects project ON project.id = ?2 AND project.workspace_id = ?3
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE (?1 IS NULL OR principal.display_name_key = ?1)
         AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
         AND (?4 = 1 OR EXISTS (
           SELECT 1 FROM effective_project_grants caller_grant
           WHERE caller_grant.project_id = project.id AND caller_grant.principal_id = ?5
             AND caller_grant.revoked_at IS NULL
         ))
         AND (?6 IS NULL OR principal.id > ?6)
         AND ${currentAuth.sql}
       ORDER BY principal.id ASC
       LIMIT ?7`,
    ).bind(displayNameKey, projectId, workspaceId, auth.isOwner ? 1 : 0,
      auth.principalId, cursor?.[0] ?? null, limit + 1,
      ...currentAuth.values).all<{ principal_id: string; display_name: string }>();
    await verifyCurrentAuth(db, auth, now);
    await requireProjectAuthorization(db, auth, workspaceId, projectId);
    const items = result.results.slice(0, limit);
    const hasMore = result.results.length > limit;
    const tail = items.at(-1);
    return { items, has_more: hasMore, next_cursor: hasMore && tail ? encodeCursor(context, [tail.principal_id]) : null };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}
