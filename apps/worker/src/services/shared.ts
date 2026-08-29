import { resolveVisibleProjects } from "../kernel/authorization.ts";
import { createCursorContext, encodeCursor } from "../kernel/cursor.ts";
import { platformUnavailable, validationError } from "../kernel/errors.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";

export interface EventCursorPrincipal {
  principalId: string;
}

export const DEFAULT_EVENT_CURSOR_FILTER: JsonValue = {
  project_targets: [],
  workspace_targets: [],
};

export function actorCredentialId(auth: AuthContext): string | null {
  if (auth.kind === "bearer") return auth.credentialId;
  return auth.sourceKind === "credential" ? auth.sourceId : null;
}

export function authorizedVia(auth: AuthContext, ownerAction = false): string {
  if (ownerAction || auth.isOwner) return "deployment_owner";
  return auth.kind === "cookie" ? "web_session" : "project_grant";
}

async function eventCursorProjectIds(
  db: D1Database,
  identity: AuthContext | EventCursorPrincipal,
): Promise<string[]> {
  if ("kind" in identity) {
    return (await resolveVisibleProjects(db, identity)).map((project) => project.projectId);
  }
  try {
    const result = await db.prepare(
      `SELECT project.id
       FROM projects project
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       JOIN instance_meta instance ON instance.singleton = 1
       WHERE project.deleted_at IS NULL AND workspace.deleted_at IS NULL
         AND (
           instance.owner_principal_id = ?1
           OR EXISTS (
             SELECT 1 FROM project_grants grant_row
             WHERE grant_row.project_id = project.id
               AND grant_row.principal_id = ?1
               AND grant_row.revoked_at IS NULL
           )
         )
       ORDER BY project.id`,
    ).bind(identity.principalId).all<{ id: string }>();
    return result.results.map((row) => row.id);
  } catch {
    throw platformUnavailable("d1");
  }
}

export async function eventCursor(
  db: D1Database,
  identity: AuthContext | EventCursorPrincipal,
  lastEventSequence: number,
): Promise<string> {
  const context = await createCursorContext(
    "events",
    DEFAULT_EVENT_CURSOR_FILTER,
    await eventCursorProjectIds(db, identity),
    identity.principalId,
  );
  return encodeCursor(context, [lastEventSequence]);
}

export async function writeResult(
  db: D1Database,
  identity: AuthContext | EventCursorPrincipal,
  resource: { [key: string]: JsonValue },
  lastEventSequence: number,
  idempotentReplay: boolean,
): Promise<{ [key: string]: JsonValue }> {
  return {
    event_cursor: await eventCursor(db, identity, lastEventSequence),
    idempotent_replay: idempotentReplay,
    resource,
  };
}

export function requireIdempotencyKey(request: Request): string {
  return request.headers.get("idempotency-key") ?? "";
}

export function requireLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 20;
  if (!/^[1-9][0-9]*$/.test(raw)) throw validationError("invalid_limit");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > 100) throw validationError("invalid_limit");
  return limit;
}

export function requireDeletedMode(url: URL): "exclude" | "only" {
  const deleted = url.searchParams.get("deleted") ?? "exclude";
  if (deleted !== "exclude" && deleted !== "only") throw validationError("invalid_deleted_filter");
  return deleted;
}
