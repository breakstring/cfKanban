import { requireUuid, timestamp } from "../domain/model.ts";
import { createCursorContext, decodeCursor, encodeCursor } from "../kernel/cursor.ts";
import { AtomicBatchRejectedError, executeAtomicBatch } from "../kernel/d1.ts";
import { ApiError, businessQuotaExceeded, forbidden, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import { buildManagementGuard, managementAuthorization, requireManagementAuthorization, sessionAllowsManagement, type ManagementScope } from "../kernel/scoped-authorization.ts";
import type { AuthContext, JsonValue, ScopedAdministrator } from "../kernel/types.ts";
import { actorCredentialId, requireIdempotencyKey, requireLimit, writeResult } from "./shared.ts";

interface AdministratorRow extends ScopedAdministrator {
  display_name: string;
}

function resource(row: AdministratorRow, auth: AuthContext): { [key: string]: JsonValue } {
  const scope = { workspaceId: row.workspace_id, ...(row.project_id === null ? {} : { projectId: row.project_id }) };
  const canManage = managementAuthorization(auth, scope, "manage_administrators") !== null;
  return {
    id: row.id, principal_id: row.principal_id,
    principal: { id: row.principal_id, display_name: row.display_name },
    workspace_id: row.workspace_id, project_id: row.project_id,
    role: row.project_id === null ? "workspace_admin" : "project_admin",
    version: row.version, generation: row.generation,
    revoked_at: timestamp(row.revoked_at), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    allowed_actions: ["read", ...(canManage ? [row.revoked_at === null ? "revoke" : "regrant"] : [])],
  };
}

export function managementGrantsResource(auth: AuthContext): JsonValue[] {
  return (auth.managementGrants ?? []).filter((grant) => sessionAllowsManagement(auth, {
    workspaceId: grant.workspace_id, ...(grant.project_id === null ? {} : { projectId: grant.project_id }),
  })).map((grant) => resource({ ...grant, display_name: auth.displayName }, auth));
}

function cursorPosition(value: JsonValue[] | null): string | null {
  if (value === null) return null;
  if (value.length !== 1 || typeof value[0] !== "string") throw validationError("invalid_cursor");
  return value[0];
}

async function authorizeRead(db: D1Database, auth: AuthContext, scope: ManagementScope, now: number) {
  return requireManagementAuthorization(db, auth, scope, scope.projectId === undefined ? "manage_workspace" : "manage_project", now, true);
}

export async function listAdministrators(db: D1Database, auth: AuthContext, scope: ManagementScope, url: URL, now: number) {
  const authorization = await authorizeRead(db, auth, scope, now);
  const limit = requireLimit(url);
  const cursor = await createCursorContext("scoped-administrators", {
    workspace_id: scope.workspaceId, project_id: scope.projectId ?? null,
  }, [authorization.administratorGrantId ?? "owner", authorization.administratorGeneration ?? "owner"], auth.principalId);
  const after = cursorPosition(decodeCursor(url.searchParams.get("cursor"), cursor));
  const guard = buildManagementGuard(auth, now, 5, scope, scope.projectId === undefined ? "manage_workspace" : "manage_project", true);
  const result = await db.prepare(
    `SELECT a.*, p.display_name FROM scoped_administrator_grants a
     JOIN principals p ON p.id = a.principal_id
     WHERE a.workspace_id = ?1 AND a.project_id IS ?2 AND (?3 IS NULL OR a.id > ?3)
       AND ${guard.sql} ORDER BY a.id LIMIT ?4`,
  ).bind(scope.workspaceId, scope.projectId ?? null, after, limit + 1, ...guard.values).all<AdministratorRow>();
  await authorizeRead(db, auth, scope, now);
  const rows = result.results.slice(0, limit);
  const hasMore = result.results.length > limit;
  return {
    items: rows.map((row) => resource(row, auth)), has_more: hasMore,
    next_cursor: hasMore ? encodeCursor(cursor, [rows.at(-1)!.id]) : null,
    resolved_scope: { workspace_id: scope.workspaceId, project_id: scope.projectId ?? null },
  };
}

export async function listAdministratorCandidates(db: D1Database, auth: AuthContext, scope: ManagementScope, url: URL, now: number) {
  const authorization = await requireManagementAuthorization(db, auth, scope, "manage_administrators", now);
  const limit = requireLimit(url);
  const query = (url.searchParams.get("q") ?? "").trim().normalize("NFKC").toLowerCase();
  if (query.length > 100) throw validationError("invalid_search_query");
  const globalOwner = auth.isOwner && (auth.kind === "bearer" || auth.targetKind === "admin");
  const cursor = await createCursorContext("administrator-candidates", {
    workspace_id: scope.workspaceId, project_id: scope.projectId ?? null, q: query, global_owner: globalOwner,
  }, [authorization.administratorGrantId ?? "owner", authorization.administratorGeneration ?? "owner"], auth.principalId);
  const after = cursorPosition(decodeCursor(url.searchParams.get("cursor"), cursor));
  const guard = buildManagementGuard(auth, now, 6, scope, "manage_administrators");
  // 从已可见的成员/管理员出发，避免窄范围请求逐个扫描实例中的无关用户；撤销记录仍可重新授予。
  const people = globalOwner ? "principals p" : `(
    SELECT a.principal_id FROM scoped_administrator_grants a
      WHERE a.workspace_id=?1 AND a.project_id IS ?2
    UNION
    SELECT g.principal_id FROM projects project JOIN project_grants g ON g.project_id=project.id
      WHERE project.workspace_id=?1 AND (?2 IS NULL OR project.id=?2)
        AND project.deleted_at IS NULL AND g.revoked_at IS NULL
    UNION
    SELECT a.principal_id FROM projects project JOIN scoped_administrator_grants a ON a.project_id=project.id
      WHERE ?2 IS NULL AND project.workspace_id=?1 AND a.workspace_id=?1
        AND a.revoked_at IS NULL AND project.deleted_at IS NULL
  ) visible JOIN principals p ON p.id=visible.principal_id`;
  const result = await db.prepare(`
    SELECT p.id AS principal_id, p.display_name, COALESCE(direct.version, 0) AS expected_version
    FROM ${people}
    LEFT JOIN scoped_administrator_grants direct ON direct.principal_id=p.id
      AND direct.workspace_id=?1 AND direct.project_id IS ?2
    WHERE p.id != (SELECT owner_principal_id FROM instance_meta WHERE singleton=1)
      AND (direct.id IS NULL OR direct.revoked_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM scoped_administrator_grants inherited
        WHERE inherited.workspace_id=?1 AND inherited.project_id IS NULL
          AND inherited.principal_id=p.id AND inherited.revoked_at IS NULL)
      AND (?3 IS NULL OR p.id > ?3) AND instr(p.display_name_key, ?4) > 0
      AND ${guard.sql}
    ORDER BY p.id LIMIT ?5
  `).bind(scope.workspaceId, scope.projectId ?? null, after, query, limit + 1, ...guard.values)
    .all<{ principal_id: string; display_name: string; expected_version: number }>();
  await requireManagementAuthorization(db, auth, scope, "manage_administrators", now);
  const rows = result.results.slice(0, limit);
  const hasMore = result.results.length > limit;
  return {
    items: rows, has_more: hasMore, next_cursor: hasMore ? encodeCursor(cursor, [rows.at(-1)!.principal_id]) : null,
    resolved_scope: { workspace_id: scope.workspaceId, project_id: scope.projectId ?? null },
  };
}

export async function listProjectMemberCandidates(db: D1Database, auth: AuthContext, scope: ManagementScope, url: URL, now: number) {
  const authorization = await requireManagementAuthorization(db, auth, scope, "manage_members", now);
  const limit = requireLimit(url);
  const query = (url.searchParams.get("q") ?? "").trim().normalize("NFKC").toLowerCase();
  if (query.length > 100) throw validationError("invalid_search_query");
  const globalOwner = auth.isOwner && (auth.kind === "bearer" || auth.targetKind === "admin");
  const cursor = await createCursorContext("project-member-candidates", {
    workspace_id: scope.workspaceId, project_id: scope.projectId!, q: query, global_owner: globalOwner,
  }, [authorization.administratorGrantId ?? "owner", authorization.administratorGeneration ?? "owner"], auth.principalId);
  const after = cursorPosition(decodeCursor(url.searchParams.get("cursor"), cursor));
  const guard = buildManagementGuard(auth, now, 5, scope, "manage_members");
  // 项目候选只复用本项目可见人员；兄弟项目和工作区其他人员须通过邀请加入。
  const people = globalOwner ? "principals p" : `(
    SELECT principal_id FROM effective_project_grants WHERE project_id=?1
    UNION
    SELECT principal_id FROM project_grants WHERE project_id=?1
    UNION
    SELECT principal_id FROM scoped_administrator_grants WHERE project_id=?1
  ) visible JOIN principals p ON p.id=visible.principal_id`;
  const result = await db.prepare(`
    SELECT p.id AS principal_id, p.display_name
    FROM ${people}
    WHERE p.id != (SELECT owner_principal_id FROM instance_meta WHERE singleton=1)
      AND NOT EXISTS (SELECT 1 FROM project_grants direct
        WHERE direct.project_id=?1 AND direct.principal_id=p.id AND direct.revoked_at IS NULL)
      AND (?2 IS NULL OR p.id > ?2) AND instr(p.display_name_key, ?3) > 0
      AND ${guard.sql}
    ORDER BY p.id LIMIT ?4
  `).bind(scope.projectId!, after, query, limit + 1, ...guard.values)
    .all<{ principal_id: string; display_name: string }>();
  await requireManagementAuthorization(db, auth, scope, "manage_members", now);
  const rows = result.results.slice(0, limit);
  const hasMore = result.results.length > limit;
  return {
    items: rows, has_more: hasMore, next_cursor: hasMore ? encodeCursor(cursor, [rows.at(-1)!.principal_id]) : null,
    resolved_scope: { workspace_id: scope.workspaceId, project_id: scope.projectId! },
  };
}

async function readAdministrator(db: D1Database, scope: ManagementScope, principalId: string): Promise<AdministratorRow | null> {
  return db.prepare(
    `SELECT a.*, p.display_name FROM scoped_administrator_grants a JOIN principals p ON p.id=a.principal_id
     WHERE a.workspace_id=?1 AND a.project_id IS ?2 AND a.principal_id=?3`,
  ).bind(scope.workspaceId, scope.projectId ?? null, principalId).first<AdministratorRow>();
}

async function capacityFailure(db: D1Database, scope: ManagementScope, principalId: string) {
  return db.prepare(
    `SELECT p.id, p.principal_limit, COUNT(g.principal_id) AS current_usage FROM projects p
     JOIN workspaces w ON w.id=p.workspace_id
     JOIN public_join_policies policy ON policy.project_id=p.id
     LEFT JOIN effective_project_grants g ON g.project_id=p.id
     WHERE p.workspace_id=?1 AND (?2 IS NULL OR p.id=?2)
       AND p.deleted_at IS NULL AND w.deleted_at IS NULL
       AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM effective_project_grants existing WHERE existing.project_id=p.id AND existing.principal_id=?3)
     GROUP BY p.id HAVING p.principal_limit IS NULL OR COUNT(g.principal_id)>=p.principal_limit
     ORDER BY p.id LIMIT 1`,
  ).bind(scope.workspaceId, scope.projectId ?? null, principalId).first<{ id: string; principal_limit: number | null; current_usage: number }>();
}

export async function changeAdministrator(
  db: D1Database, request: Request, auth: AuthContext, scope: ManagementScope,
  input: { principalId?: string; administratorId?: string; expectedVersion: number }, now: number,
): Promise<{ [key: string]: JsonValue }> {
  const deleting = input.administratorId !== undefined;
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < (deleting ? 1 : 0)) {
    throw validationError("invalid_expected_version", { field: "expected_version" });
  }
  const authorization = await requireManagementAuthorization(db, auth, scope, "manage_administrators", now);
  const selected = deleting ? await db.prepare(
    "SELECT principal_id FROM scoped_administrator_grants WHERE id=?1 AND workspace_id=?2 AND project_id IS ?3",
  ).bind(input.administratorId!, scope.workspaceId, scope.projectId ?? null).first<{ principal_id: string }>() : null;
  if (deleting && selected === null) throw notFound();
  const principalId = requireUuid(selected?.principal_id ?? input.principalId ?? null, "principal_id");
  const principal = await db.prepare(
    `SELECT p.display_name, p.id=im.owner_principal_id AS is_owner FROM principals p
     JOIN instance_meta im ON im.singleton=1 WHERE p.id=?1`,
  ).bind(principalId).first<{ display_name: string; is_owner: number }>();
  if (principal === null) throw notFound();
  if (principal.is_owner === 1) throw forbidden();
  const scopePath = scope.projectId === undefined
    ? "/api/v1/workspaces/{workspace_id}/administrators"
    : "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators";
  const result = await runIdempotentOperation({
    db, now, idempotencyKey: requireIdempotencyKey(request),
    scopeKey: `principal:${auth.principalId}`, method: deleting ? "DELETE" : "POST",
    routeTemplate: deleting ? `${scopePath}/{administrator_id}` : scopePath,
    normalizedResourceScope: `administrator:${scope.workspaceId}:${scope.projectId ?? "workspace"}:${principalId}`,
    requestBody: { principal_id: principalId, expected_version: input.expectedVersion },
    authorize: async () => { await requireManagementAuthorization(db, auth, scope, "manage_administrators", now); },
    execute: async (operationId) => {
      const existing = await readAdministrator(db, scope, principalId);
      const assertState = (row: AdministratorRow | null) => {
        if ((row?.version ?? 0) !== input.expectedVersion || (deleting ? row?.revoked_at !== null : row?.revoked_at === null)) {
          throw versionConflict(row?.version ?? 0);
        }
      };
      assertState(existing);
      const id = existing?.id ?? crypto.randomUUID();
      const generation = deleting ? existing!.generation : operationId;
      const guard = buildManagementGuard(auth, now, 11, scope, "manage_administrators");
      const quotaSql = `NOT EXISTS (
        SELECT 1 FROM projects quota_project JOIN workspaces quota_workspace ON quota_workspace.id=quota_project.workspace_id
        JOIN public_join_policies policy ON policy.project_id=quota_project.id
        WHERE quota_project.workspace_id=?3 AND (?4 IS NULL OR quota_project.id=?4)
          AND quota_project.deleted_at IS NULL AND quota_workspace.deleted_at IS NULL
          AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM effective_project_grants already WHERE already.project_id=quota_project.id AND already.principal_id=?2)
          AND (quota_project.principal_limit IS NULL OR
            (SELECT COUNT(*) FROM effective_project_grants members WHERE members.project_id=quota_project.id)>=quota_project.principal_limit)
      )`;
      const statement = deleting
        ? `UPDATE scoped_administrator_grants SET revoked_at=?6, revoked_by_principal_id=?7,
             version=version+1, updated_at=?6, last_operation_id=?8
           WHERE id=?1 AND principal_id=?2 AND workspace_id=?3 AND project_id IS ?4
             AND generation=?5 AND version=?9 AND revoked_at IS NULL AND ?10=1 AND ${guard.sql}`
        : `INSERT INTO scoped_administrator_grants
             (id,principal_id,workspace_id,project_id,generation,version,created_at,updated_at,created_operation_id,last_operation_id)
           SELECT ?1,?2,?3,?4,?5,1,?6,?6,?8,?8
           WHERE ?7 IS NOT NULL AND ?10=0 AND ${guard.sql} AND ${quotaSql}
             AND ((?9=0 AND NOT EXISTS (SELECT 1 FROM scoped_administrator_grants current WHERE current.id=?1))
               OR EXISTS (SELECT 1 FROM scoped_administrator_grants current WHERE current.id=?1 AND current.version=?9 AND current.revoked_at IS NOT NULL))
           ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,version=scoped_administrator_grants.version+1,
             revoked_at=NULL,revoked_by_principal_id=NULL,updated_at=excluded.updated_at,last_operation_id=excluded.last_operation_id
           WHERE scoped_administrator_grants.version=?9 AND scoped_administrator_grants.revoked_at IS NOT NULL`;
      const row: AdministratorRow = {
        id, principal_id: principalId, workspace_id: scope.workspaceId, project_id: scope.projectId ?? null,
        version: (existing?.version ?? 0) + 1, generation, revoked_at: deleting ? now : null,
        created_at: existing?.created_at ?? now, updated_at: now, display_name: principal.display_name,
      };
      try {
        await executeAtomicBatch(db, {
          operationId, primarySubjectId: id, primarySubjectType: "scoped_administrator",
          committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
          businessStatements: [
            db.prepare(statement).bind(id, principalId, scope.workspaceId, scope.projectId ?? null, generation,
              now, auth.principalId, operationId, input.expectedVersion, deleting ? 1 : 0, ...guard.values),
            db.prepare(`UPDATE project_usage SET active_principal_count=(SELECT COUNT(*) FROM effective_project_grants g WHERE g.project_id=project_usage.project_id),
              updated_at=?1,last_operation_id=?2
              WHERE project_id IN (SELECT id FROM projects WHERE workspace_id=?3 AND (?4 IS NULL OR id=?4))
                AND EXISTS (SELECT 1 FROM scoped_administrator_grants a WHERE a.id=?5 AND a.last_operation_id=?2)`)
              .bind(now, operationId, scope.workspaceId, scope.projectId ?? null, id),
            db.prepare(`UPDATE idempotency_records SET operation_snapshot_json=?1 WHERE operation_id=?2 AND state='pending'
              AND EXISTS (SELECT 1 FROM scoped_administrator_grants a WHERE a.id=?3 AND a.last_operation_id=?2)`)
              .bind(JSON.stringify(resource(row, auth)), operationId, id),
            db.prepare(`INSERT INTO events (id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,
              authorized_via,administrator_grant_id,administrator_grant_version,workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
              SELECT ?1,'security',?2,?3,0,?4,?5,?6,?7,?8,?9,?10,'scoped_administrator',?11,?12,?13
              WHERE EXISTS (SELECT 1 FROM scoped_administrator_grants a WHERE a.id=?11 AND a.last_operation_id=?3)`)
              .bind(crypto.randomUUID(), deleting ? "administrator.revoked" : "administrator.granted", operationId,
                auth.principalId, actorCredentialId(auth), authorization.authorizedVia, authorization.administratorGrantId,
                authorization.administratorGrantVersion, scope.workspaceId, scope.projectId ?? null, id,
                JSON.stringify({ principal_id: principalId, role: scope.projectId === undefined ? "workspace_admin" : "project_admin", generation, version: row.version }), now),
          ],
          confirmBusinessRejection: async () => {
            try {
              await requireManagementAuthorization(db, auth, scope, "manage_administrators", now);
              assertState(await readAdministrator(db, scope, principalId));
              return !deleting && await capacityFailure(db, scope, principalId) !== null;
            } catch (error) { if (error instanceof ApiError) return true; throw error; }
          },
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          await requireManagementAuthorization(db, auth, scope, "manage_administrators", now);
          assertState(await readAdministrator(db, scope, principalId));
          const capacity = deleting ? null : await capacityFailure(db, scope, principalId);
          if (capacity !== null) {
            if (capacity.principal_limit === null) throw platformUnavailable("d1");
            throw businessQuotaExceeded("principals", capacity.current_usage, capacity.principal_limit);
          }
        }
        throw error;
      }
    },
    readback: async (operationId, commit) => ({
      body: await writeResult(db, auth, await readOperationSnapshot<{ [key: string]: JsonValue }>(db, operationId), commit.lastEventSequence, false), status: 200,
    }),
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function listProjectMembers(db: D1Database, auth: AuthContext, scope: ManagementScope, url: URL, now: number) {
  const source = await requireManagementAuthorization(db, auth, scope, "manage_members", now);
  const limit = requireLimit(url);
  const context = await createCursorContext("project-members", { project_id: scope.projectId! },
    [scope.projectId!, source.administratorGrantId ?? "owner", source.administratorGeneration ?? "owner"], auth.principalId);
  const after = cursorPosition(decodeCursor(url.searchParams.get("cursor"), context));
  const guard = buildManagementGuard(auth, now, 4, scope, "manage_members");
  const result = await db.prepare(`SELECT p.id AS principal_id,p.display_name,
      CASE WHEN p.id=im.owner_principal_id THEN 'owner' ELSE g.role END AS effective_role
    FROM principals p JOIN instance_meta im ON im.singleton=1
    LEFT JOIN effective_project_grants g ON g.principal_id=p.id AND g.project_id=?1
    WHERE (p.id=im.owner_principal_id OR g.principal_id IS NOT NULL) AND (?2 IS NULL OR p.id>?2)
      AND ${guard.sql} ORDER BY p.id LIMIT ?3`)
    .bind(scope.projectId!, after, limit + 1, ...guard.values).all<{ principal_id: string; display_name: string; effective_role: string }>();
  const rows = result.results.slice(0, limit);
  const sourceRows = await db.prepare(`SELECT s.* FROM project_access_sources s WHERE s.project_id=?1
    AND s.principal_id IN (SELECT value FROM json_each(?2))`)
    .bind(scope.projectId!, JSON.stringify(rows.map((row) => row.principal_id)))
    .all<{ principal_id: string; source: string; source_id: string; source_version: number; role: string }>();
  await requireManagementAuthorization(db, auth, scope, "manage_members", now);
  return {
    items: rows.map((row) => ({ ...row, sources: row.effective_role === "owner"
      ? [{ kind: "deployment_owner", id: null, version: null }]
      : sourceRows.results.filter((item) => item.principal_id === row.principal_id).map((item) => ({ kind: item.source, id: item.source_id, version: item.source_version, role: item.role })) })),
    has_more: result.results.length > limit,
    next_cursor: result.results.length > limit ? encodeCursor(context, [rows.at(-1)!.principal_id]) : null,
    resolved_scope: { workspace_id: scope.workspaceId, project_id: scope.projectId! },
  };
}
