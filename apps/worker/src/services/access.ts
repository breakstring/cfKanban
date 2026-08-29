import {
  requireCredentialToken,
  requireProjectRole,
  requireUuid,
  timestamp,
  type ProjectRole,
} from "../domain/model.ts";
import { authenticateBearer, parseBearerCredential } from "../kernel/auth.ts";
import {
  buildCurrentAuthGuard,
  reauthenticateOwner,
  requireOwnerControl,
  verifyCurrentAuth,
} from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { isUuid, sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import {
  businessQuotaExceeded,
  conflict,
  forbidden,
  notFound,
  platformUnavailable,
  unauthorized,
  validationError,
  versionConflict,
} from "../kernel/errors.ts";
import {
  operationSnapshotStatement,
  readOperationSnapshot,
  runIdempotentOperation,
} from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  actorCredentialId,
  requireIdempotencyKey,
  requireLimit,
  writeResult,
} from "./shared.ts";

interface CredentialRow {
  id: string;
  issued_at: number;
  last_used_at: number | null;
  principal_display_name: string;
  principal_id: string;
  revoked_at: number | null;
  revoke_reason: string | null;
  token_prefix: string;
}

interface GrantRow {
  created_at: number;
  id: string;
  principal_display_name: string;
  principal_id: string;
  project_display_name: string;
  project_id: string;
  project_key: string;
  revoked_at: number | null;
  role: ProjectRole;
  updated_at: number;
  version: number;
  workspace_key: string;
}

interface PrincipalRow {
  active_credential_count: number;
  active_grant_count: number;
  assignee_count: number;
  created_at: number;
  display_name: string;
  id: string;
  is_owner: number;
  updated_at: number;
  version: number;
}

interface ProjectControlRow {
  active_principal_count: number;
  id: string;
  principal_limit: number | null;
  public_join_enabled: number;
  usage_present: number;
  workspace_id: string;
}

function credentialVersion(row: CredentialRow): number {
  return row.revoked_at === null ? 1 : 2;
}

function credentialResource(row: CredentialRow, canRevoke: boolean): { [key: string]: JsonValue } {
  return {
    allowed_actions: row.revoked_at === null && canRevoke ? ["revoke"] : [],
    created_at: timestamp(row.issued_at),
    deleted_at: timestamp(row.revoked_at),
    fingerprint: `cfk_v1_${row.token_prefix}_…`,
    id: row.id,
    issued_at: timestamp(row.issued_at),
    last_used_at: timestamp(row.last_used_at),
    principal: {
      display_name: row.principal_display_name,
      principal_id: row.principal_id,
    },
    principal_id: row.principal_id,
    revoke_reason: row.revoke_reason,
    revoked_at: timestamp(row.revoked_at),
    updated_at: timestamp(row.revoked_at ?? row.issued_at),
    version: credentialVersion(row),
  };
}

function grantResource(row: GrantRow): { [key: string]: JsonValue } {
  return {
    allowed_actions: row.revoked_at === null ? ["read", "update", "revoke"] : ["read", "regrant"],
    created_at: timestamp(row.created_at),
    deleted_at: timestamp(row.revoked_at),
    id: row.id,
    principal: {
      display_name: row.principal_display_name,
      principal_id: row.principal_id,
    },
    principal_id: row.principal_id,
    project: {
      display_name: row.project_display_name,
      id: row.project_id,
      key: row.project_key,
      workspace_key: row.workspace_key,
    },
    project_id: row.project_id,
    revoked_at: timestamp(row.revoked_at),
    role: row.role,
    updated_at: timestamp(row.updated_at),
    version: row.version,
  };
}

function principalResource(row: PrincipalRow): { [key: string]: JsonValue } {
  return {
    active_credential_count: row.active_credential_count,
    active_grant_count: row.active_grant_count,
    assignee_count: row.assignee_count,
    created_at: timestamp(row.created_at),
    deleted_at: null,
    display_name: row.display_name,
    id: row.id,
    is_owner: row.is_owner === 1,
    principal_id: row.id,
    updated_at: timestamp(row.updated_at),
    version: row.version,
  };
}

function grantOperationSnapshotStatement(
  db: D1Database,
  operationId: string,
  grantId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT json_object('row', json_object(
         'created_at', g.created_at,
         'id', g.id,
         'principal_display_name', principal.display_name,
         'principal_id', g.principal_id,
         'project_display_name', project.display_name,
         'project_id', g.project_id,
         'project_key', project.key,
         'revoked_at', g.revoked_at,
         'role', g.role,
         'updated_at', g.updated_at,
         'version', g.version,
         'workspace_key', workspace.key
       ))
       FROM project_grants g
       JOIN principals principal ON principal.id = g.principal_id
       JOIN projects project ON project.id = g.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE g.id = ?2 AND g.last_operation_id = ?1
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, grantId);
}

async function readGrantOperationSnapshot(
  db: D1Database,
  operationId: string,
): Promise<GrantRow> {
  const snapshot = await readOperationSnapshot<{ row: GrantRow }>(db, operationId);
  return snapshot.row;
}

async function readCredential(db: D1Database, credentialId: string): Promise<CredentialRow | null> {
  try {
    return await db.prepare(
      `SELECT c.id, c.principal_id, c.token_prefix, c.issued_at, c.last_used_at,
              c.revoked_at, c.revoke_reason, p.display_name AS principal_display_name
       FROM credentials AS c
       JOIN principals AS p ON p.id = c.principal_id
       WHERE c.id = ?1 LIMIT 1`,
    ).bind(credentialId).first<CredentialRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readGrant(db: D1Database, grantId: string): Promise<GrantRow | null> {
  try {
    return await db.prepare(
      `SELECT g.id, g.principal_id, pr.display_name AS principal_display_name,
              g.project_id, p.key AS project_key, p.display_name AS project_display_name,
              w.key AS workspace_key, g.role, g.revoked_at, g.version,
              g.created_at, g.updated_at
       FROM project_grants AS g
       JOIN principals AS pr ON pr.id = g.principal_id
       JOIN projects AS p ON p.id = g.project_id
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE g.id = ?1 LIMIT 1`,
    ).bind(grantId).first<GrantRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readGrantForPrincipalProject(
  db: D1Database,
  principalId: string,
  projectId: string,
  operationId: string | null = null,
): Promise<GrantRow | null> {
  try {
    return await db.prepare(
      `SELECT g.id, g.principal_id, pr.display_name AS principal_display_name,
              g.project_id, p.key AS project_key, p.display_name AS project_display_name,
              w.key AS workspace_key, g.role, g.revoked_at, g.version,
              g.created_at, g.updated_at
       FROM project_grants AS g
       JOIN principals AS pr ON pr.id = g.principal_id
       JOIN projects AS p ON p.id = g.project_id
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE g.principal_id = ?1 AND g.project_id = ?2
         AND (?3 IS NULL OR g.created_operation_id = ?3 OR g.last_operation_id = ?3)
       LIMIT 1`,
    ).bind(principalId, projectId, operationId).first<GrantRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readPrincipal(db: D1Database, principalId: string): Promise<PrincipalRow | null> {
  try {
    return await db.prepare(
      `SELECT p.id, p.display_name, p.version, p.created_at, p.updated_at,
              CASE WHEN im.owner_principal_id = p.id THEN 1 ELSE 0 END AS is_owner,
              (SELECT COUNT(*) FROM credentials c
               WHERE c.principal_id = p.id AND c.revoked_at IS NULL) AS active_credential_count,
              (SELECT COUNT(*) FROM project_grants g
               WHERE g.principal_id = p.id AND g.revoked_at IS NULL) AS active_grant_count,
              (SELECT COUNT(*) FROM issues i
               WHERE i.assignee_principal_id = p.id AND i.deleted_at IS NULL) AS assignee_count
       FROM principals AS p
       JOIN instance_meta AS im ON im.singleton = 1
       WHERE p.id = ?1 LIMIT 1`,
    ).bind(principalId).first<PrincipalRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readProjectControl(db: D1Database, projectId: string): Promise<ProjectControlRow | null> {
  try {
    return await db.prepare(
      `SELECT p.id, p.workspace_id, p.principal_limit,
              COALESCE(pu.active_principal_count, 0) AS active_principal_count,
              CASE WHEN pu.project_id IS NULL THEN 0 ELSE 1 END AS usage_present,
              CASE WHEN policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
                   THEN 1 ELSE 0 END AS public_join_enabled
       FROM projects AS p
       JOIN workspaces AS w ON w.id = p.workspace_id
       LEFT JOIN project_usage AS pu ON pu.project_id = p.id
       LEFT JOIN public_join_policies AS policy ON policy.project_id = p.id
       WHERE p.id = ?1 AND p.deleted_at IS NULL AND w.deleted_at IS NULL
       LIMIT 1`,
    ).bind(projectId).first<ProjectControlRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function ownerGuardRejected(db: D1Database, auth: AuthContext, now: number): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, now, 1, true);
  try {
    return await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first() === null;
  } catch {
    throw platformUnavailable("d1");
  }
}

function parseTimestampIdCursor(cursor: JsonValue[] | null): [number, string] | null {
  if (cursor === null) return null;
  if (
    cursor.length !== 2
    || typeof cursor[0] !== "number"
    || !Number.isSafeInteger(cursor[0])
    || cursor[0] < 0
    || typeof cursor[1] !== "string"
    || !isUuid(cursor[1])
  ) {
    throw invalidCursor();
  }
  return [cursor[0], cursor[1]];
}

export async function listPrincipals(
  db: D1Database,
  auth: AuthContext,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (Array.from(q).length > 128) throw validationError("schema_validation_failed", { field: "q" });
  const projectIdRaw = url.searchParams.get("project_id");
  const projectId = projectIdRaw === null ? null : requireUuid(projectIdRaw, "project_id");
  const limit = requireLimit(url);
  const cursorContext = await createCursorContext(
    "principals",
    { project_id: projectId, q },
    [`owner:${auth.principalId}`],
    auth.principalId,
  );
  const position = parseTimestampIdCursor(decodeCursor(url.searchParams.get("cursor"), cursorContext));
  let rows: PrincipalRow[];
  try {
    const result = await db.prepare(
      `SELECT p.id, p.display_name, p.version, p.created_at, p.updated_at,
              CASE WHEN im.owner_principal_id = p.id THEN 1 ELSE 0 END AS is_owner,
              (SELECT COUNT(*) FROM credentials c
               WHERE c.principal_id = p.id AND c.revoked_at IS NULL) AS active_credential_count,
              (SELECT COUNT(*) FROM project_grants g
               WHERE g.principal_id = p.id AND g.revoked_at IS NULL) AS active_grant_count,
              (SELECT COUNT(*) FROM issues i
               WHERE i.assignee_principal_id = p.id AND i.deleted_at IS NULL) AS assignee_count
       FROM principals AS p
       JOIN instance_meta AS im ON im.singleton = 1
       WHERE (?1 IS NULL OR EXISTS (
         SELECT 1 FROM project_grants filter_grant
         WHERE filter_grant.principal_id = p.id
           AND filter_grant.project_id = ?1
           AND filter_grant.revoked_at IS NULL
       ))
         AND (?2 = '' OR p.id = ?2 OR instr(lower(p.display_name), ?3) > 0)
         AND (?4 IS NULL OR p.created_at > ?4 OR (p.created_at = ?4 AND p.id > ?5))
       ORDER BY p.created_at, p.id
       LIMIT ?6`,
    ).bind(projectId, q, q.toLocaleLowerCase(), position?.[0] ?? null, position?.[1] ?? null, limit + 1).all<PrincipalRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: page.map(principalResource),
    next_cursor: hasMore && tail ? encodeCursor(cursorContext, [tail.created_at, tail.id]) : null,
    resolved_scope: { project_id: projectId, q },
  };
}

export async function getPrincipal(
  db: D1Database,
  auth: AuthContext,
  principalIdValue: JsonValue,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const principalId = requireUuid(principalIdValue, "principal_id");
  const principal = await readPrincipal(db, principalId);
  if (principal === null) throw notFound();
  let grants: GrantRow[];
  let credentials: CredentialRow[];
  try {
    const [grantResult, credentialResult] = await Promise.all([
      db.prepare(
        `SELECT g.id, g.principal_id, pr.display_name AS principal_display_name,
                g.project_id, p.key AS project_key, p.display_name AS project_display_name,
                w.key AS workspace_key, g.role, g.revoked_at, g.version,
                g.created_at, g.updated_at
         FROM project_grants AS g
         JOIN principals AS pr ON pr.id = g.principal_id
         JOIN projects AS p ON p.id = g.project_id
         JOIN workspaces AS w ON w.id = p.workspace_id
         WHERE g.principal_id = ?1 ORDER BY g.created_at, g.id LIMIT 101`,
      ).bind(principalId).all<GrantRow>(),
      db.prepare(
        `SELECT c.id, c.principal_id, c.token_prefix, c.issued_at, c.last_used_at,
                c.revoked_at, c.revoke_reason, p.display_name AS principal_display_name
         FROM credentials AS c JOIN principals AS p ON p.id = c.principal_id
         WHERE c.principal_id = ?1 ORDER BY c.issued_at DESC, c.id DESC LIMIT 101`,
      ).bind(principalId).all<CredentialRow>(),
    ]);
    grants = grantResult.results;
    credentials = credentialResult.results;
  } catch {
    throw platformUnavailable("d1");
  }
  return {
    ...principalResource(principal),
    credentials: credentials.slice(0, 100).map((row) => credentialResource(row, principal.is_owner !== 1)),
    credentials_has_more: credentials.length > 100,
    grants: grants.slice(0, 100).map(grantResource),
    grants_has_more: grants.length > 100,
  };
}

export async function listPrincipalCredentials(
  db: D1Database,
  auth: AuthContext,
  principalIdValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const principalId = requireUuid(principalIdValue, "principal_id");
  const principal = await readPrincipal(db, principalId);
  if (principal === null) throw notFound();
  const limit = requireLimit(url);
  const cursorContext = await createCursorContext(
    "principal-credentials",
    { principal_id: principalId },
    [`owner:${auth.principalId}`],
    auth.principalId,
  );
  const position = parseTimestampIdCursor(decodeCursor(url.searchParams.get("cursor"), cursorContext));
  let rows: CredentialRow[];
  try {
    const result = await db.prepare(
      `SELECT c.id, c.principal_id, c.token_prefix, c.issued_at, c.last_used_at,
              c.revoked_at, c.revoke_reason, p.display_name AS principal_display_name
       FROM credentials AS c JOIN principals AS p ON p.id = c.principal_id
       WHERE c.principal_id = ?1
         AND (?2 IS NULL OR c.issued_at < ?2 OR (c.issued_at = ?2 AND c.id < ?3))
       ORDER BY c.issued_at DESC, c.id DESC
       LIMIT ?4`,
    ).bind(principalId, position?.[0] ?? null, position?.[1] ?? null, limit + 1).all<CredentialRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: page.map((row) => credentialResource(row, principal.is_owner !== 1)),
    next_cursor: hasMore && tail ? encodeCursor(cursorContext, [tail.issued_at, tail.id]) : null,
    resolved_scope: { principal_id: principalId },
  };
}

export async function revokeCredential(
  db: D1Database,
  auth: AuthContext,
  credentialIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const credentialId = requireUuid(credentialIdValue, "credential_id");
  const current = await readCredential(db, credentialId);
  if (current === null) throw notFound();
  const owner = await readPrincipal(db, current.principal_id);
  if (owner?.is_owner === 1) throw forbidden();
  if (current.revoked_at !== null || expectedVersion !== 1) throw versionConflict(credentialVersion(current));
  const updated: CredentialRow = {
    ...current,
    revoke_reason: "owner_revoke",
    revoked_at: now,
  };
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 5, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE credentials
           SET revoked_at = ?1, revoked_by_principal_id = ?2,
               revoke_reason = 'owner_revoke', last_operation_id = ?3
           WHERE id = ?4 AND revoked_at IS NULL
             AND principal_id != (SELECT owner_principal_id FROM instance_meta WHERE singleton = 1)
             AND ${guard.sql}`,
        ).bind(now, auth.principalId, operationId, credentialId, ...guard.values),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'credential.revoked', ?2, 0, ?3, ?4,
                  'deployment_owner', 'credential', id, ?5, ?6
           FROM credentials WHERE id = ?7 AND last_operation_id = ?2`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          auth.principalId,
          actorCredentialId(auth),
          JSON.stringify({ principal_id: current.principal_id, reason: "owner_revoke" }),
          now,
          credentialId,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readCredential(db, credentialId);
        const principal = latest === null ? null : await readPrincipal(db, latest.principal_id);
        return latest === null || latest.revoked_at !== null || principal?.is_owner === 1
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: credentialId,
      primarySubjectType: "credential",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = await readCredential(db, credentialId);
      if (latest === null) throw notFound();
      if ((await readPrincipal(db, latest.principal_id))?.is_owner === 1) throw forbidden();
      throw versionConflict(credentialVersion(latest));
    }
    throw error;
  }
  return writeResult(db, auth, credentialResource(updated, false), commit.lastEventSequence, false);
}

async function authenticateRotationRequest(
  db: D1Database,
  request: Request,
  replacementToken: string,
): Promise<AuthContext & { kind: "bearer" }> {
  const header = request.headers.get("authorization");
  if (parseBearerCredential(header) === null) throw unauthorized();
  try {
    const current = await authenticateBearer(db, header);
    requireOwnerControl(current, true);
    return current;
  } catch {
    const replacement = await authenticateBearer(db, `Bearer ${replacementToken}`);
    requireOwnerControl(replacement, true);
    return replacement;
  }
}

export async function rotateOwnerCredential(
  db: D1Database,
  request: Request,
  tokenValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const replacement = requireCredentialToken(tokenValue, "new_credential_token");
  const idempotencyKey = requireIdempotencyKey(request);
  const initialAuth = await authenticateRotationRequest(db, request, replacement.token);
  if (initialAuth.displayName.includes(replacement.token)) {
    throw validationError("secret_value_reused", { field: "new_credential_token" });
  }
  const replacementDigest = await sha256Hex(replacement.token);
  const replacementCredentialId = crypto.randomUUID();
  const replacementRow: CredentialRow = {
    id: replacementCredentialId,
    issued_at: now,
    last_used_at: null,
    principal_display_name: initialAuth.displayName,
    principal_id: initialAuth.principalId,
    revoked_at: null,
    revoke_reason: null,
    token_prefix: replacement.prefix,
  };
  const rotationResource = {
    ...credentialResource(replacementRow, false),
    revoked_credential_id: initialAuth.credentialId,
  };
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await authenticateRotationRequest(db, request, replacement.token);
      if (current.principalId !== initialAuth.principalId) throw forbidden();
    },
    db,
    execute: async (operationId) => {
      const guard = buildCurrentAuthGuard(initialAuth, now, 7, true);
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `INSERT INTO credentials
                (id, principal_id, token_prefix, token_digest, issued_at,
                 created_operation_id, last_operation_id)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
               WHERE ${guard.sql}`,
            ).bind(
              replacementCredentialId,
              initialAuth.principalId,
              replacement.prefix,
              replacementDigest,
              now,
              operationId,
              ...guard.values,
            ),
            db.prepare(
              `UPDATE credentials
               SET revoked_at = ?1, revoked_by_principal_id = ?2,
                   revoke_reason = 'owner_rotation', last_operation_id = ?3
               WHERE id = ?4 AND revoked_at IS NULL
                 AND EXISTS (SELECT 1 FROM credentials replacement
                             WHERE replacement.created_operation_id = ?3)`,
            ).bind(now, initialAuth.principalId, operationId, initialAuth.credentialId),
            operationSnapshotStatement(db, operationId, rotationResource),
            db.prepare(
              `INSERT INTO events
                (id, stream, type, operation_id, event_index, actor_principal_id,
                 actor_credential_id, authorized_via, subject_type, subject_id,
                 payload_json, created_at)
               SELECT ?1, 'security', 'owner.credential-rotated', ?2, 0, ?3, ?4,
                      'deployment_owner', 'credential', replacement.id, ?5, ?6
               FROM credentials replacement
               JOIN credentials prior ON prior.id = ?4
               WHERE replacement.created_operation_id = ?2
                 AND prior.last_operation_id = ?2`,
            ).bind(
              crypto.randomUUID(),
              operationId,
              initialAuth.principalId,
              initialAuth.credentialId,
              JSON.stringify({ revoked_credential_id: initialAuth.credentialId }),
              now,
            ),
          ],
          committedAt: now,
          confirmBusinessRejection: async () => {
            const existing = await db.prepare(
              "SELECT id FROM credentials WHERE token_digest = ?1 LIMIT 1",
            ).bind(replacementDigest).first();
            return existing !== null || await ownerGuardRejected(db, initialAuth, now);
          },
          expectedEventCount: 1,
          operationId,
          primarySubjectId: replacementCredentialId,
          primarySubjectType: "credential",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          const existing = await db.prepare(
            "SELECT id FROM credentials WHERE token_digest = ?1 LIMIT 1",
          ).bind(replacementDigest).first();
          if (existing !== null) throw conflict("CREDENTIAL_TOKEN_CONFLICT", "generate_new_credential");
          throw unauthorized();
        }
        throw error;
      }
    },
    forbiddenPersistenceValues: [replacement.token],
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: "owner-credential-rotation",
    now,
    readback: async (operationId, commit) => {
      return {
        body: await writeResult(
          db,
          initialAuth,
          await readOperationSnapshot<{ [key: string]: JsonValue }>(db, operationId),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: { new_credential_token: replacement.token },
    routeTemplate: "/api/v1/admin/owner-credentials/rotate",
    scopeKey: `principal:${initialAuth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function listProjectGrants(
  db: D1Database,
  auth: AuthContext,
  projectIdValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const projectId = requireUuid(projectIdValue, "project_id");
  if (await readProjectControl(db, projectId) === null) throw notFound();
  const limit = requireLimit(url);
  const cursorContext = await createCursorContext(
    "project-grants",
    { project_id: projectId },
    [`owner:${auth.principalId}`],
    auth.principalId,
  );
  const position = parseTimestampIdCursor(decodeCursor(url.searchParams.get("cursor"), cursorContext));
  let rows: GrantRow[];
  try {
    const result = await db.prepare(
      `SELECT g.id, g.principal_id, pr.display_name AS principal_display_name,
              g.project_id, p.key AS project_key, p.display_name AS project_display_name,
              w.key AS workspace_key, g.role, g.revoked_at, g.version,
              g.created_at, g.updated_at
       FROM project_grants AS g
       JOIN principals AS pr ON pr.id = g.principal_id
       JOIN projects AS p ON p.id = g.project_id
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE g.project_id = ?1
         AND (?2 IS NULL OR g.created_at > ?2 OR (g.created_at = ?2 AND g.id > ?3))
       ORDER BY g.created_at, g.id
       LIMIT ?4`,
    ).bind(projectId, position?.[0] ?? null, position?.[1] ?? null, limit + 1).all<GrantRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: page.map(grantResource),
    next_cursor: hasMore && tail ? encodeCursor(cursorContext, [tail.created_at, tail.id]) : null,
    resolved_scope: { project_id: projectId },
  };
}

export async function getProjectGrant(
  db: D1Database,
  auth: AuthContext,
  grantIdValue: JsonValue,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const grantId = requireUuid(grantIdValue, "grant_id");
  const row = await readGrant(db, grantId);
  if (row === null) throw notFound();
  return grantResource(row);
}

interface GrantCapacity {
  currentUsage: number;
  exceeded: boolean;
  limit: number;
}

async function grantCapacity(db: D1Database, projectId: string): Promise<GrantCapacity | null> {
  const project = await readProjectControl(db, projectId);
  if (project === null || project.public_join_enabled !== 1) return null;
  if (project.usage_present !== 1 || project.principal_limit === null) throw platformUnavailable("d1");
  return {
    currentUsage: project.active_principal_count,
    exceeded: project.active_principal_count >= project.principal_limit,
    limit: project.principal_limit,
  };
}

function grantEvent(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  grantId: string,
  type: string | null,
  payload: JsonValue,
  now: number,
  requireUsageCommit = false,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, grant_id, workspace_id,
       project_id, subject_type, subject_id, payload_json, created_at)
     SELECT ?1, 'domain',
            COALESCE(?2, CASE WHEN g.created_operation_id = ?3
                             THEN 'project-grant.created'
                             ELSE 'project-grant.regranted' END),
            ?3, 0, ?4, ?5, 'deployment_owner',
            g.id, p.workspace_id, g.project_id, 'project_grant', g.id,
            json_set(
              json(?6),
              '$.grant_version', g.version,
              '$.effective_role', CASE WHEN g.revoked_at IS NULL THEN g.role ELSE NULL END,
              '$.effective_capabilities', json_object(
                'read', json(CASE WHEN g.revoked_at IS NULL THEN 'true' ELSE 'false' END),
                'write', json(CASE WHEN g.revoked_at IS NULL AND g.role = 'writer' THEN 'true' ELSE 'false' END)
              ),
              '$.lifecycle', CASE
                WHEN ?2 IS NULL AND g.created_operation_id = ?3 THEN 'created'
                WHEN ?2 IS NULL THEN 'regranted'
                WHEN ?2 = 'project-grant.role-updated' THEN 'role_updated'
                WHEN ?2 = 'project-grant.revoked' THEN 'revoked'
                ELSE ?2
              END
            ), ?7
     FROM project_grants AS g
     JOIN projects AS p ON p.id = g.project_id
     LEFT JOIN project_usage AS usage ON usage.project_id = g.project_id
     LEFT JOIN public_join_policies AS policy ON policy.project_id = g.project_id
     WHERE g.id = ?8 AND g.last_operation_id = ?3
       ${requireUsageCommit
         ? `AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
                 OR usage.last_operation_id = ?3)`
         : ""}`,
  ).bind(
    crypto.randomUUID(),
    type,
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    JSON.stringify(payload),
    now,
    grantId,
  );
}

export async function createProjectGrant(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  projectIdValue: JsonValue,
  principalIdValue: JsonValue,
  roleValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const projectId = requireUuid(projectIdValue, "project_id");
  const principalId = requireUuid(principalIdValue, "principal_id");
  const role = requireProjectRole(roleValue);
  const proposedGrantId = crypto.randomUUID();
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await reauthenticateOwner(db, request, now);
      if (current.principalId !== auth.principalId) throw forbidden();
    },
    db,
    execute: async (operationId) => {
      const [principal, project, existing] = await Promise.all([
        readPrincipal(db, principalId),
        readProjectControl(db, projectId),
        readGrantForPrincipalProject(db, principalId, projectId),
      ]);
      if (principal === null || project === null) throw notFound();
      if (principal.is_owner === 1) throw forbidden();
      const grantId = existing?.id ?? proposedGrantId;
      const guard = buildCurrentAuthGuard(auth, now, 8, true);
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `INSERT INTO project_grants
                (id, principal_id, project_id, role, version, created_at,
                 updated_at, created_operation_id, last_operation_id)
               SELECT ?1, target_principal.id, p.id, ?4, 1, ?5, ?5, ?7, ?7
               FROM principals AS target_principal
               JOIN projects AS p ON p.id = ?3
               JOIN workspaces AS w ON w.id = p.workspace_id
               LEFT JOIN project_usage AS usage ON usage.project_id = p.id
               LEFT JOIN public_join_policies AS policy ON policy.project_id = p.id
               JOIN instance_meta AS im ON im.singleton = 1
               WHERE target_principal.id = ?2 AND target_principal.id != im.owner_principal_id
                 AND p.deleted_at IS NULL AND w.deleted_at IS NULL
                 AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
                      OR (p.principal_limit IS NOT NULL
                          AND usage.project_id IS NOT NULL
                          AND usage.active_principal_count < p.principal_limit))
                 AND ${guard.sql}
               ON CONFLICT(principal_id, project_id) DO UPDATE SET
                 role = excluded.role, revoked_at = NULL,
                 revoked_by_principal_id = NULL,
                 version = project_grants.version + 1,
                 updated_at = excluded.updated_at,
                 last_operation_id = excluded.last_operation_id
               WHERE project_grants.revoked_at IS NOT NULL`,
            ).bind(grantId, principalId, projectId, role, now, auth.principalId, operationId, ...guard.values),
            db.prepare(
              `UPDATE project_usage
               SET active_principal_count = active_principal_count + 1,
                   updated_at = ?1, last_operation_id = ?2
               WHERE project_id = ?3 AND EXISTS (
                 SELECT 1 FROM project_grants g
                 WHERE g.project_id = ?3 AND g.principal_id = ?4
                   AND g.last_operation_id = ?2 AND g.revoked_at IS NULL
               ) AND EXISTS (
                 SELECT 1 FROM public_join_policies policy
                 WHERE policy.project_id = ?3
                   AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
               )`,
            ).bind(now, operationId, projectId, principalId),
            grantOperationSnapshotStatement(db, operationId, grantId),
            grantEvent(db, auth, operationId, grantId, null, { role }, now, true),
          ],
          committedAt: now,
          confirmBusinessRejection: async () => {
            const latest = await readGrantForPrincipalProject(db, principalId, projectId);
            return latest?.revoked_at === null
              || await readProjectControl(db, projectId) === null
              || (await readPrincipal(db, principalId))?.is_owner === 1
              || (await grantCapacity(db, projectId))?.exceeded === true
              || await ownerGuardRejected(db, auth, now);
          },
          expectedEventCount: 1,
          operationId,
          primarySubjectId: grantId,
          primarySubjectType: "project_grant",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          await reauthenticateOwner(db, request, now);
          if (await readProjectControl(db, projectId) === null || await readPrincipal(db, principalId) === null) throw notFound();
          if ((await readPrincipal(db, principalId))?.is_owner === 1) throw forbidden();
          const latest = await readGrantForPrincipalProject(db, principalId, projectId);
          if (latest?.revoked_at === null) throw conflict("GRANT_ALREADY_EXISTS", "update_existing_grant");
          const capacity = await grantCapacity(db, projectId);
          if (capacity?.exceeded === true) {
            throw businessQuotaExceeded("principals", capacity.currentUsage, capacity.limit);
          }
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `project:${projectId}:principal:${principalId}`,
    now,
    readback: async (operationId, commit) => {
      const row = await readGrantOperationSnapshot(db, operationId);
      return {
        body: await writeResult(db, auth, grantResource(row), commit.lastEventSequence, false),
        status: 200,
      };
    },
    requestBody: { principal_id: principalId, role },
    routeTemplate: "/api/v1/admin/projects/{project_id}/grants",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function updateProjectGrant(
  db: D1Database,
  auth: AuthContext,
  grantIdValue: JsonValue,
  roleValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const grantId = requireUuid(grantIdValue, "grant_id");
  const role = requireProjectRole(roleValue);
  const current = await readGrant(db, grantId);
  if (current === null || await readProjectControl(db, current.project_id) === null) throw notFound();
  const updated: GrantRow = {
    ...current,
    role,
    updated_at: now,
    version: current.version + 1,
  };
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 7, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE project_grants
           SET role = ?1, version = version + 1, updated_at = ?2,
               last_operation_id = ?3
           WHERE id = ?4 AND version = ?5 AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id
               WHERE p.id = project_grants.project_id
                 AND p.deleted_at IS NULL AND w.deleted_at IS NULL
             ) AND ${guard.sql}`,
        ).bind(role, now, operationId, grantId, expectedVersion, auth.principalId, ...guard.values),
        grantEvent(db, auth, operationId, grantId, "project-grant.role-updated", { role }, now),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readGrant(db, grantId);
        return latest === null || latest.revoked_at !== null || latest.version !== expectedVersion
          || await readProjectControl(db, latest.project_id) === null
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: grantId,
      primarySubjectType: "project_grant",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = await readGrant(db, grantId);
      if (latest === null || await readProjectControl(db, latest.project_id) === null) throw notFound();
      if (latest.revoked_at !== null) throw conflict("GRANT_REVOKED", "regrant");
      throw versionConflict(latest.version);
    }
    throw error;
  }
  return writeResult(db, auth, grantResource(updated), commit.lastEventSequence, false);
}

export async function revokeProjectGrant(
  db: D1Database,
  auth: AuthContext,
  grantIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const grantId = requireUuid(grantIdValue, "grant_id");
  const current = await readGrant(db, grantId);
  if (current === null) throw notFound();
  const updated: GrantRow = {
    ...current,
    revoked_at: now,
    updated_at: now,
    version: current.version + 1,
  };
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 7, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE project_grants
           SET revoked_at = ?1, revoked_by_principal_id = ?2,
               version = version + 1, updated_at = ?1,
               last_operation_id = ?3
           WHERE id = ?4 AND version = ?5 AND revoked_at IS NULL
             AND ${guard.sql}`,
        ).bind(now, auth.principalId, operationId, grantId, expectedVersion, auth.principalId, ...guard.values),
        db.prepare(
          `UPDATE project_usage
           SET active_principal_count = active_principal_count - 1,
               updated_at = ?1, last_operation_id = ?2
           WHERE project_id = ?3 AND active_principal_count > 0
             AND EXISTS (SELECT 1 FROM project_grants g
                         WHERE g.id = ?4 AND g.last_operation_id = ?2
                           AND g.revoked_at IS NOT NULL)
             AND EXISTS (
               SELECT 1 FROM public_join_policies policy
               WHERE policy.project_id = ?3
                 AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
             )`,
        ).bind(now, operationId, current.project_id, grantId),
        grantEvent(db, auth, operationId, grantId, "project-grant.revoked", { role: current.role }, now, true),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readGrant(db, grantId);
        return latest === null || latest.revoked_at !== null || latest.version !== expectedVersion
          || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: grantId,
      primarySubjectType: "project_grant",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = await readGrant(db, grantId);
      if (latest === null) throw notFound();
      if (latest.revoked_at !== null) throw conflict("GRANT_REVOKED", "none");
      throw versionConflict(latest.version);
    }
    throw error;
  }
  return writeResult(db, auth, grantResource(updated), commit.lastEventSequence, false);
}
