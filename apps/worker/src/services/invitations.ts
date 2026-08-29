import {
  generateInvitationCode,
  requireCredentialToken,
  requireDisplayName,
  requireInvitationKind,
  requireInvitationRedeemAs,
  requireProjectRole,
  requireRecoveryMode,
  requireUuid,
  timestamp,
  type InvitationKind,
  type InvitationRedeemAs,
  type ProjectRole,
  type RecoveryMode,
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
import {
  AtomicBatchRejectedError,
  executeAtomicBatch,
  probeOperationCommit,
  type OperationCommit,
} from "../kernel/d1.ts";
import {
  businessQuotaExceeded,
  conflict,
  forbidden,
  gone,
  invitationModeMismatch,
  notFound,
  platformUnavailable,
  recoveryPrincipalMismatch,
  unauthorized,
  validationError,
  versionConflict,
} from "../kernel/errors.ts";
import {
  abandonOwnedPendingClaim,
  claimIdempotency,
  finalizeIdempotency,
  readFinalizedIdempotencyResponse,
  readIdempotencyResponse,
  readOperationSnapshot,
  type IdempotencyClaim,
} from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  actorCredentialId,
  requireIdempotencyKey,
  requireLimit,
  writeResult,
} from "./shared.ts";

const PROJECT_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const RECOVERY_INVITE_LIFETIME_MS = 60 * 60 * 1_000;

export interface InvitationGrantInput {
  projectId: string;
  role: ProjectRole;
}

interface InvitationRow {
  bound_display_name: string | null;
  bound_principal_id: string | null;
  code_digest: string;
  code_prefix: string;
  created_at: number;
  created_by_owner_principal_id: string;
  expires_at: number;
  id: string;
  kind: InvitationKind;
  last_operation_id: string | null;
  recovery_mode: RecoveryMode | null;
  redeemed_at: number | null;
  redeemed_by_principal_id: string | null;
  revoked_at: number | null;
}

interface InvitationGrantRow {
  display_name: string;
  project_id: string;
  project_key: string;
  role: ProjectRole;
  workspace_key: string;
}

interface RedemptionItemRow {
  effective_role: ProjectRole;
  outcome: "already_has_access" | "created" | "regranted";
  project_id: string;
}

interface RedemptionCredentialRow {
  id: string;
  issued_at: number;
  principal_display_name: string;
  principal_id: string;
  token_prefix: string;
}

interface InvitationOperationSnapshot {
  grants: InvitationGrantRow[];
  row: InvitationRow;
}

interface RedemptionOperationSnapshot extends InvitationOperationSnapshot {
  credential: RedemptionCredentialRow | null;
  principal: { display_name: string; id: string };
  results: RedemptionItemRow[];
}

function invitationSnapshotJsonSql(extraFields = ""): string {
  return `json_object(
    'row', json_object(
      'bound_display_name', bound.display_name,
      'bound_principal_id', invitation.bound_principal_id,
      'code_digest', invitation.code_digest,
      'code_prefix', invitation.code_prefix,
      'created_at', invitation.created_at,
      'created_by_owner_principal_id', invitation.created_by_owner_principal_id,
      'expires_at', invitation.expires_at,
      'id', invitation.id,
      'kind', invitation.kind,
      'last_operation_id', invitation.last_operation_id,
      'recovery_mode', invitation.recovery_mode,
      'redeemed_at', invitation.redeemed_at,
      'redeemed_by_principal_id', invitation.redeemed_by_principal_id,
      'revoked_at', invitation.revoked_at
    ),
    'grants', json(COALESCE((
      SELECT json_group_array(json_object(
        'display_name', ordered_grant.display_name,
        'project_id', ordered_grant.project_id,
        'project_key', ordered_grant.project_key,
        'role', ordered_grant.role,
        'workspace_key', ordered_grant.workspace_key
      ))
      FROM (
        SELECT project.display_name, grant_row.project_id,
               project.key AS project_key, grant_row.role,
               workspace.key AS workspace_key
        FROM invitation_project_grants grant_row
        JOIN projects project ON project.id = grant_row.project_id
        JOIN workspaces workspace ON workspace.id = project.workspace_id
        WHERE grant_row.invitation_id = invitation.id
        ORDER BY workspace.key, project.key, project.id
      ) ordered_grant
    ), '[]'))${extraFields}
  )`;
}

function invitationOperationSnapshotStatement(
  db: D1Database,
  operationId: string,
  invitationId: string,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT ${invitationSnapshotJsonSql()}
       FROM invitations invitation
       LEFT JOIN principals bound ON bound.id = invitation.bound_principal_id
       WHERE invitation.id = ?2 AND invitation.last_operation_id = ?1
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, invitationId);
}

function redemptionOperationSnapshotStatement(
  db: D1Database,
  operationId: string,
  invitationId: string,
  forbiddenValues: readonly string[],
): D1PreparedStatement {
  const [firstForbidden = "", secondForbidden = ""] = forbiddenValues;
  const extras = `,
    'credential', json((
      SELECT json_object(
        'id', credential.id,
        'issued_at', credential.issued_at,
        'principal_display_name', credential_principal.display_name,
        'principal_id', credential.principal_id,
        'token_prefix', credential.token_prefix
      )
      FROM credentials credential
      JOIN principals credential_principal ON credential_principal.id = credential.principal_id
      WHERE credential.created_operation_id = ?1
      LIMIT 1
    )),
    'principal', json_object(
      'display_name', redeemed_principal.display_name,
      'id', redeemed_principal.id
    ),
    'results', json(COALESCE((
      SELECT json_group_array(json_object(
        'effective_role', ordered_item.effective_role,
        'outcome', ordered_item.outcome,
        'project_id', ordered_item.project_id
      ))
      FROM (
        SELECT effective_role, outcome, project_id
        FROM invitation_redemption_items
        WHERE invitation_id = invitation.id AND operation_id = ?1
        ORDER BY project_id
      ) ordered_item
    ), '[]'))`;
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT ${invitationSnapshotJsonSql(extras)}
       FROM invitations invitation
       LEFT JOIN principals bound ON bound.id = invitation.bound_principal_id
       JOIN principals redeemed_principal ON redeemed_principal.id = invitation.redeemed_by_principal_id
       WHERE invitation.id = ?2 AND invitation.last_operation_id = ?1
         AND (?3 = '' OR (
           instr(redeemed_principal.display_name, ?3) = 0
           AND instr(COALESCE(bound.display_name, ''), ?3) = 0
           AND NOT EXISTS (
             SELECT 1 FROM invitation_project_grants forbidden_grant
             JOIN projects forbidden_project ON forbidden_project.id = forbidden_grant.project_id
             JOIN workspaces forbidden_workspace ON forbidden_workspace.id = forbidden_project.workspace_id
             WHERE forbidden_grant.invitation_id = invitation.id
               AND (instr(forbidden_project.display_name, ?3) > 0
                    OR instr(forbidden_project.key, ?3) > 0
                    OR instr(forbidden_workspace.key, ?3) > 0)
           )
         ))
         AND (?4 = '' OR (
           instr(redeemed_principal.display_name, ?4) = 0
           AND instr(COALESCE(bound.display_name, ''), ?4) = 0
           AND NOT EXISTS (
             SELECT 1 FROM invitation_project_grants forbidden_grant
             JOIN projects forbidden_project ON forbidden_project.id = forbidden_grant.project_id
             JOIN workspaces forbidden_workspace ON forbidden_workspace.id = forbidden_project.workspace_id
             WHERE forbidden_grant.invitation_id = invitation.id
               AND (instr(forbidden_project.display_name, ?4) > 0
                    OR instr(forbidden_project.key, ?4) > 0
                    OR instr(forbidden_workspace.key, ?4) > 0)
           )
         ))
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, invitationId, firstForbidden, secondForbidden);
}

function invitationVersion(row: InvitationRow): number {
  return row.revoked_at === null && row.redeemed_at === null ? 1 : 2;
}

function invitationStatus(row: InvitationRow, now: number): "active" | "expired" | "redeemed" | "revoked" {
  if (row.revoked_at !== null) return "revoked";
  if (row.redeemed_at !== null) return "redeemed";
  if (now >= row.expires_at) return "expired";
  return "active";
}

async function readInvitationById(db: D1Database, invitationId: string): Promise<InvitationRow | null> {
  try {
    return await db.prepare(
      `SELECT i.id, i.kind, i.code_prefix, i.code_digest, i.bound_principal_id,
              bound.display_name AS bound_display_name, i.recovery_mode,
              i.expires_at, i.revoked_at, i.redeemed_at,
              i.redeemed_by_principal_id, i.created_at,
              i.created_by_owner_principal_id, i.last_operation_id
       FROM invitations AS i
       LEFT JOIN principals AS bound ON bound.id = i.bound_principal_id
       WHERE i.id = ?1 LIMIT 1`,
    ).bind(invitationId).first<InvitationRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readInvitationByDigest(db: D1Database, digest: string): Promise<InvitationRow | null> {
  try {
    return await db.prepare(
      `SELECT i.id, i.kind, i.code_prefix, i.code_digest, i.bound_principal_id,
              bound.display_name AS bound_display_name, i.recovery_mode,
              i.expires_at, i.revoked_at, i.redeemed_at,
              i.redeemed_by_principal_id, i.created_at,
              i.created_by_owner_principal_id, i.last_operation_id
       FROM invitations AS i
       LEFT JOIN principals AS bound ON bound.id = i.bound_principal_id
       WHERE i.code_digest = ?1 LIMIT 1`,
    ).bind(digest).first<InvitationRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readInvitationGrants(db: D1Database, invitationId: string): Promise<InvitationGrantRow[]> {
  try {
    const result = await db.prepare(
      `SELECT ipg.project_id, ipg.role, p.key AS project_key,
              p.display_name, w.key AS workspace_key
       FROM invitation_project_grants AS ipg
       JOIN projects AS p ON p.id = ipg.project_id
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE ipg.invitation_id = ?1
       ORDER BY w.key, p.key, p.id`,
    ).bind(invitationId).all<InvitationGrantRow>();
    return result.results;
  } catch {
    throw platformUnavailable("d1");
  }
}

function assertSecretNotInBusinessText(
  value: string | null,
  field: string,
  forbiddenValues: readonly string[],
): void {
  if (
    value !== null
    && forbiddenValues.some((secret) => secret.length >= 8 && value.includes(secret))
  ) {
    throw validationError("secret_value_reused", { field });
  }
}

async function assertRedemptionSnapshotInputsSafe(
  db: D1Database,
  invitation: InvitationRow,
  principalDisplayName: string | null,
  forbiddenValues: readonly string[],
): Promise<void> {
  assertSecretNotInBusinessText(principalDisplayName, "display_name", forbiddenValues);
  assertSecretNotInBusinessText(invitation.bound_display_name, "display_name", forbiddenValues);
  const grants = await readInvitationGrants(db, invitation.id);
  for (const grant of grants) {
    assertSecretNotInBusinessText(grant.display_name, "project_display_name", forbiddenValues);
    assertSecretNotInBusinessText(grant.project_key, "project_key", forbiddenValues);
    assertSecretNotInBusinessText(grant.workspace_key, "workspace_key", forbiddenValues);
  }
}

async function readInvitationGrantPages(
  db: D1Database,
  invitationIds: readonly string[],
): Promise<Map<string, InvitationGrantRow[]>> {
  const grouped = new Map<string, InvitationGrantRow[]>();
  for (const invitationId of invitationIds) grouped.set(invitationId, []);
  if (invitationIds.length === 0) return grouped;
  try {
    const result = await db.prepare(
      `SELECT ipg.invitation_id, ipg.project_id, ipg.role, p.key AS project_key,
              p.display_name, w.key AS workspace_key
       FROM invitation_project_grants AS ipg
       JOIN projects AS p ON p.id = ipg.project_id
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE ipg.invitation_id IN (SELECT value FROM json_each(?1))
       ORDER BY ipg.invitation_id, w.key, p.key, p.id`,
    ).bind(JSON.stringify(invitationIds)).all<InvitationGrantRow & { invitation_id: string }>();
    for (const row of result.results) grouped.get(row.invitation_id)?.push(row);
    return grouped;
  } catch {
    throw platformUnavailable("d1");
  }
}

async function invitationResource(
  db: D1Database,
  row: InvitationRow,
  now: number,
  providedGrants?: readonly InvitationGrantRow[],
): Promise<{ [key: string]: JsonValue }> {
  const status = invitationStatus(row, now);
  const lifecycleAt = row.revoked_at ?? row.redeemed_at ?? row.created_at;
  return {
    allowed_actions: status === "active" ? ["read", "revoke"] : ["read"],
    bound_principal: row.bound_principal_id === null ? null : {
      display_name: row.bound_display_name ?? "",
      principal_id: row.bound_principal_id,
    },
    code_fingerprint: `cfi_v1_${row.code_prefix}_…`,
    created_at: timestamp(row.created_at),
    deleted_at: timestamp(row.revoked_at),
    expires_at: timestamp(row.expires_at),
    grants: (providedGrants ?? await readInvitationGrants(db, row.id)).map((grant) => ({
      display_name: grant.display_name,
      project_id: grant.project_id,
      project_key: grant.project_key,
      role: grant.role,
      workspace_key: grant.workspace_key,
    })),
    id: row.id,
    kind: row.kind,
    recovery_mode: row.recovery_mode,
    redeemed_at: timestamp(row.redeemed_at),
    redeemed_by_principal_id: row.redeemed_by_principal_id,
    revoked_at: timestamp(row.revoked_at),
    status,
    updated_at: timestamp(lifecycleAt),
    version: invitationVersion(row),
  };
}

async function ownerGuardRejected(db: D1Database, auth: AuthContext, now: number): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, now, 1, true);
  try {
    return await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first() === null;
  } catch {
    throw platformUnavailable("d1");
  }
}

function parseCursor(cursor: JsonValue[] | null): [number, string] | null {
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

export async function listInvitations(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const limit = requireLimit(url);
  const cursorContext = await createCursorContext(
    "invitations",
    {},
    [`owner:${auth.principalId}`],
    auth.principalId,
  );
  const position = parseCursor(decodeCursor(url.searchParams.get("cursor"), cursorContext));
  let rows: InvitationRow[];
  try {
    const result = await db.prepare(
      `SELECT i.id, i.kind, i.code_prefix, i.code_digest, i.bound_principal_id,
              bound.display_name AS bound_display_name, i.recovery_mode,
              i.expires_at, i.revoked_at, i.redeemed_at,
              i.redeemed_by_principal_id, i.created_at,
              i.created_by_owner_principal_id, i.last_operation_id
       FROM invitations AS i
       LEFT JOIN principals AS bound ON bound.id = i.bound_principal_id
       WHERE (?1 IS NULL OR i.created_at < ?1 OR (i.created_at = ?1 AND i.id < ?2))
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT ?3`,
    ).bind(position?.[0] ?? null, position?.[1] ?? null, limit + 1).all<InvitationRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const tail = page.at(-1);
  const grants = await readInvitationGrantPages(db, page.map((row) => row.id));
  return {
    has_more: hasMore,
    items: await Promise.all(page.map((row) => invitationResource(db, row, now, grants.get(row.id) ?? []))),
    next_cursor: hasMore && tail ? encodeCursor(cursorContext, [tail.created_at, tail.id]) : null,
    resolved_scope: { owner_principal_id: auth.principalId },
  };
}

export async function getInvitation(
  db: D1Database,
  auth: AuthContext,
  invitationIdValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const invitationId = requireUuid(invitationIdValue, "invitation_id");
  const row = await readInvitationById(db, invitationId);
  if (row === null) throw notFound();
  return invitationResource(db, row, now);
}

function validateGrantInputs(value: JsonValue | undefined): InvitationGrantInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw validationError("schema_validation_failed", { field: "grants" });
  }
  const projectIds = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
      throw validationError("schema_validation_failed", { field: `grants_${index}` });
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("project_id") || !keys.includes("role")) {
      throw validationError("schema_validation_failed", { field: `grants_${index}` });
    }
    const projectId = requireUuid(entry.project_id as JsonValue, `grants_${index}_project_id`);
    if (projectIds.has(projectId)) throw validationError("duplicate_project_grant");
    projectIds.add(projectId);
    return {
      projectId,
      role: requireProjectRole(entry.role as JsonValue, `grants_${index}_role`),
    };
  });
}

async function preferredOrigin(db: D1Database): Promise<string> {
  try {
    const row = await db.prepare(
      "SELECT preferred_api_origin FROM instance_origin_settings WHERE singleton = 1",
    ).first<{ preferred_api_origin: string }>();
    if (row === null) throw new Error();
    return row.preferred_api_origin;
  } catch {
    throw platformUnavailable("d1");
  }
}

async function createInvitationBatch(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  invitationId: string,
  codePrefix: string,
  codeDigest: string,
  kind: InvitationKind,
  grants: readonly InvitationGrantInput[],
  principalId: string | null,
  recoveryMode: RecoveryMode | null,
  expiresAt: number,
  now: number,
): Promise<void> {
  const guard = buildCurrentAuthGuard(auth, now, 11, true);
  const grantsJson = JSON.stringify(grants.map((grant) => ({
    project_id: grant.projectId,
    role: grant.role,
  })));
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO invitations
        (id, kind, code_prefix, code_digest, bound_principal_id,
         recovery_mode, expires_at, created_at, created_by_owner_principal_id,
         created_operation_id, last_operation_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
       WHERE ${guard.sql}
         AND (
           (?2 = 'project_grant' AND ?5 IS NULL AND ?6 IS NULL)
           OR
           (?2 = 'principal_recovery' AND ?5 IS NOT NULL AND ?6 IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM principals p JOIN instance_meta im ON im.singleton = 1
              WHERE p.id = ?5 AND p.id != im.owner_principal_id
            ))
         )`,
    ).bind(
      invitationId,
      kind,
      codePrefix,
      codeDigest,
      principalId,
      recoveryMode,
      expiresAt,
      now,
      auth.principalId,
      operationId,
      ...guard.values,
    ),
    db.prepare(
      `INSERT INTO invitation_project_grants (invitation_id, project_id, role)
       SELECT invitation.id, project.id,
              json_extract(requested.value, '$.role')
       FROM invitations AS invitation
       CROSS JOIN json_each(?1) AS requested
       JOIN projects AS project
         ON project.id = json_extract(requested.value, '$.project_id')
       JOIN workspaces AS workspace ON workspace.id = project.workspace_id
       WHERE invitation.id = ?2 AND invitation.created_operation_id = ?3
         AND invitation.kind = 'project_grant'
         AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL`,
    ).bind(grantsJson, invitationId, operationId),
  ];
  statements.push(invitationOperationSnapshotStatement(db, operationId, invitationId));
  statements.push(db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, subject_type, subject_id,
       payload_json, created_at)
     SELECT ?1, 'security', 'invitation.created', ?2, 0, ?3, ?4,
            'deployment_owner', 'invitation', i.id, ?5, ?6
     FROM invitations AS i
     WHERE i.id = ?7 AND i.created_operation_id = ?2
       AND ((i.kind = 'project_grant' AND
             (SELECT COUNT(*) FROM invitation_project_grants ipg
              WHERE ipg.invitation_id = i.id) = ?8)
            OR (i.kind = 'principal_recovery' AND ?8 = 0))`,
  ).bind(
    crypto.randomUUID(),
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    JSON.stringify({
      grant_count: grants.length,
      kind,
      recovery_mode: recoveryMode,
    }),
    now,
    invitationId,
    grants.length,
  ));
  try {
    await executeAtomicBatch(db, {
      businessStatements: statements,
      committedAt: now,
      confirmBusinessRejection: async () => {
        if (kind === "principal_recovery") {
          const principal = principalId === null ? null : await db.prepare(
            `SELECT p.id FROM principals p JOIN instance_meta im ON im.singleton = 1
             WHERE p.id = ?1 AND p.id != im.owner_principal_id`,
          ).bind(principalId).first();
          return principal === null || await ownerGuardRejected(db, auth, now);
        }
        const projectSet = await db.prepare(
          `SELECT COUNT(*) AS requested_count,
                  SUM(CASE
                    WHEN project.id IS NOT NULL
                     AND project.deleted_at IS NULL
                     AND workspace.id IS NOT NULL
                     AND workspace.deleted_at IS NULL
                    THEN 1 ELSE 0
                  END) AS active_count
           FROM json_each(?1) AS requested
           LEFT JOIN projects AS project
             ON project.id = json_extract(requested.value, '$.project_id')
           LEFT JOIN workspaces AS workspace ON workspace.id = project.workspace_id`,
        ).bind(grantsJson).first<{ active_count: number | null; requested_count: number }>();
        if (
          projectSet === null
          || projectSet.requested_count !== grants.length
          || projectSet.active_count !== grants.length
        ) return true;
        return ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: invitationId,
      primarySubjectType: "invitation",
      requireIdempotencySnapshot: true,
    });
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      throw notFound();
    }
    throw error;
  }
}

export async function createInvitation(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  kindValue: JsonValue,
  grantsValue: JsonValue | undefined,
  principalIdValue: JsonValue | undefined,
  recoveryModeValue: JsonValue | undefined,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const kind = requireInvitationKind(kindValue);
  let grants: InvitationGrantInput[] = [];
  let principalId: string | null = null;
  let recoveryMode: RecoveryMode | null = null;
  if (kind === "project_grant") {
    grants = validateGrantInputs(grantsValue);
    if (principalIdValue !== undefined || recoveryModeValue !== undefined) {
      throw validationError("invitation_kind_fields_mixed");
    }
  } else {
    if (grantsValue !== undefined) throw validationError("invitation_kind_fields_mixed");
    principalId = requireUuid(principalIdValue as JsonValue, "principal_id");
    recoveryMode = requireRecoveryMode(recoveryModeValue as JsonValue);
  }
  const idempotencyKey = requireIdempotencyKey(request);
  const requestBody: JsonValue = kind === "project_grant"
    ? { kind, grants: grants.map((grant) => ({ project_id: grant.projectId, role: grant.role })) }
    : { kind, principal_id: principalId, recovery_mode: recoveryMode };
  const identity = {
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `invitation:${kind}`,
    requestBody,
    routeTemplate: "/api/v1/admin/invitations",
    scopeKey: `principal:${auth.principalId}`,
  };
  await reauthenticateOwner(db, request, now);
  const claim = await claimIdempotency(db, identity, now);
  if (claim.state === "committed") {
    await reauthenticateOwner(db, request, now);
    const stored = readIdempotencyResponse<{ [key: string]: JsonValue }>(claim);
    return {
      ...stored.body,
      idempotent_replay: true,
      resource: {
        ...(stored.body.resource as { [key: string]: JsonValue }),
        secret_available: false,
      },
    };
  }

  let commit = await probeOperationCommit(db, claim.operationId);
  let generatedCode: string | null = null;
  let generatedDigest: string | null = null;
  if (commit === null) {
    const invitationId = crypto.randomUUID();
    const generated = generateInvitationCode();
    generatedCode = generated.code;
    generatedDigest = await sha256Hex(generated.code);
    try {
      await createInvitationBatch(
        db,
        auth,
        claim.operationId,
        invitationId,
        generated.prefix,
        generatedDigest,
        kind,
        grants,
        principalId,
        recoveryMode,
        now + (kind === "project_grant" ? PROJECT_INVITE_LIFETIME_MS : RECOVERY_INVITE_LIFETIME_MS),
        now,
      );
    } catch (error) {
      commit = await probeOperationCommit(db, claim.operationId);
      if (commit === null) {
        await abandonOwnedPendingClaim(db, claim);
        throw error;
      }
    }
    commit = await probeOperationCommit(db, claim.operationId);
  }
  if (commit === null) throw new AtomicBatchRejectedError();
  await reauthenticateOwner(db, request, now);
  let snapshot: InvitationOperationSnapshot;
  try {
    snapshot = await readOperationSnapshot<InvitationOperationSnapshot>(db, claim.operationId);
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const finalizedByPeer = await readFinalizedIdempotencyResponse<{ [key: string]: JsonValue }>(
        db,
        claim.operationId,
      );
      if (finalizedByPeer !== null) {
        return {
          ...finalizedByPeer.body,
          idempotent_replay: true,
          resource: {
            ...(finalizedByPeer.body.resource as { [key: string]: JsonValue }),
            secret_available: false,
          },
        };
      }
    }
    throw error;
  }
  const safeBody = await writeResult(db, auth, {
    ...(await invitationResource(db, snapshot.row, now, snapshot.grants)),
    secret_available: false,
  }, commit.lastEventSequence, false);
  if (generatedCode === null || generatedDigest !== snapshot.row.code_digest) {
    // A same-key peer can safely confirm the committed Invitation, but only the
    // request that generated the persisted digest may clear the snapshot. This
    // leaves the one request that still holds the plaintext code able to return
    // the one-shot URL without ever persisting that code.
    return { ...safeBody, idempotent_replay: true };
  }
  const committedCode = generatedCode;
  const finalized = await finalizeIdempotency(
    db,
    claim.operationId,
    { body: safeBody, status: 200 },
    [committedCode],
    now,
  );
  const origin = await preferredOrigin(db);
  const inviteUrl = `${origin}/invite?code=${encodeURIComponent(committedCode)}`;
  return {
    ...finalized.body,
    idempotent_replay: false,
    resource: {
      ...(finalized.body.resource as { [key: string]: JsonValue }),
      copy_text: `请仔细阅读 ${inviteUrl} 的说明，以便继续 cfKanban 邀请流程。`,
      invite_url: inviteUrl,
      secret_available: true,
    },
  };
}

export async function revokeInvitation(
  db: D1Database,
  auth: AuthContext,
  invitationIdValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const invitationId = requireUuid(invitationIdValue, "invitation_id");
  const current = await readInvitationById(db, invitationId);
  if (current === null) throw notFound();
  if (invitationVersion(current) !== expectedVersion || current.redeemed_at !== null || current.revoked_at !== null) {
    throw versionConflict(invitationVersion(current));
  }
  const grants = await readInvitationGrants(db, invitationId);
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 6, true);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE invitations
           SET revoked_at = ?1, revoked_by_principal_id = ?2,
               last_operation_id = ?3
           WHERE id = ?4 AND revoked_at IS NULL AND redeemed_at IS NULL
             AND ?5 = 1 AND ${guard.sql}`,
        ).bind(now, auth.principalId, operationId, invitationId, expectedVersion, ...guard.values),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'invitation.revoked', ?2, 0, ?3, ?4,
                  'deployment_owner', 'invitation', id, '{}', ?5
           FROM invitations WHERE id = ?6 AND last_operation_id = ?2`,
        ).bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth), now, invitationId),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readInvitationById(db, invitationId);
        return latest === null || latest.revoked_at !== null || latest.redeemed_at !== null
          || expectedVersion !== 1 || await ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: invitationId,
      primarySubjectType: "invitation",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = await readInvitationById(db, invitationId);
      if (latest === null) throw notFound();
      throw versionConflict(invitationVersion(latest));
    }
    throw error;
  }
  const updated: InvitationRow = {
    ...current,
    last_operation_id: operationId,
    revoked_at: now,
  };
  return writeResult(
    db,
    auth,
    await invitationResource(db, updated, now, grants),
    commit.lastEventSequence,
    false,
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function assertInvitationUsable(row: InvitationRow, now: number): void {
  const status = invitationStatus(row, now);
  if (status === "revoked") throw gone("INVITATION_REVOKED");
  if (status === "redeemed") throw conflict("INVITATION_ALREADY_REDEEMED", "request_new_invitation");
  if (status === "expired") throw gone("INVITATION_EXPIRED");
}

function preferredInvitationLocale(acceptLanguage: string | null): "en" | "zh-CN" {
  const preferences = (acceptLanguage ?? "").split(",").map((entry, index) => {
    const [tagPart, ...parameters] = entry.trim().split(";");
    const qParameter = parameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="));
    const quality = qParameter === undefined ? 1 : Number(qParameter.trim().slice(2));
    return {
      index,
      quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0,
      tag: tagPart?.toLowerCase() ?? "",
    };
  }).filter((entry) => entry.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const preference of preferences) {
    if (/^zh(?:-cn|-hans)?$/u.test(preference.tag)) return "zh-CN";
    if (/^en(?:-[a-z0-9]+)*$/u.test(preference.tag)) return "en";
  }
  return "en";
}

export const INVITATION_PAGE_SCRIPT = `(()=>{const apply=(locale)=>{const selected=locale==="zh-CN"?"zh-CN":"en";document.documentElement.lang=selected;document.querySelectorAll("[data-invitation-locale]").forEach((section)=>{section.hidden=section.dataset.invitationLocale!==selected});try{localStorage.setItem("cfkanban.locale",selected)}catch{}};document.querySelectorAll("[data-select-locale]").forEach((button)=>button.addEventListener("click",()=>apply(button.dataset.selectLocale)));try{const saved=localStorage.getItem("cfkanban.locale");if(saved)apply(saved)}catch{}history.replaceState({},document.title,"/invite")})()`;

let invitationPageScriptHash: Promise<string> | null = null;

async function invitationPageScriptSource(): Promise<string> {
  invitationPageScriptHash ??= crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(INVITATION_PAGE_SCRIPT),
  ).then((digest) => {
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return `sha256-${btoa(binary)}`;
  });
  return invitationPageScriptHash;
}

export async function invitationPageContentSecurityPolicy(): Promise<string> {
  return [
    "default-src 'none'",
    `script-src '${await invitationPageScriptSource()}'`,
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'none'",
    "style-src 'none'",
  ].join("; ");
}

export async function getInvitationBootstrapHtml(
  db: D1Database,
  codeValue: string | null,
  now: number,
  acceptLanguage: string | null = null,
): Promise<string> {
  if (codeValue === null || codeValue.length < 1 || codeValue.length > 1_024) {
    throw validationError("invalid_invitation_code");
  }
  const row = await readInvitationByDigest(db, await sha256Hex(codeValue));
  if (row === null) throw notFound();
  assertInvitationUsable(row, now);
  const grants = await readInvitationGrants(db, row.id);
  const locale = preferredInvitationLocale(acceptLanguage);
  const renderDetails = (isChinese: boolean) => {
    const roleLabel = (role: ProjectRole) => isChinese
      ? role === "writer" ? "可写 writer" : "只读 reader"
      : role === "writer" ? "writer (read/write)" : "reader (read-only)";
    return row.kind === "project_grant"
      ? `<h2>${isChinese ? "目标 Project" : "Target Projects"}</h2><ul>${grants.map((grant) => `<li><strong>${escapeHtml(grant.workspace_key)}/${escapeHtml(grant.project_key)}</strong> — ${escapeHtml(grant.display_name)} — ${roleLabel(grant.role)}<br><small>project_id: ${escapeHtml(grant.project_id)}</small></li>`).join("")}</ul>`
      : `<h2>${isChinese ? "身份恢复警告" : "Identity recovery warning"}</h2><p>${isChinese
        ? `此邀请绑定 Principal ${escapeHtml(row.bound_principal_id ?? "")}（${escapeHtml(row.bound_display_name ?? "")}）。兑换者将继承该身份的全部现有 Grants、assignment 与历史。${row.recovery_mode === "rotation" ? "rotation 成功后只撤销本次用于认证的旧 Credential，其他 active Credential 保持有效。" : "full_recovery 成功后撤销该 Principal 的全部先前 active Credentials。"}`
        : `This Invitation is bound to Principal ${escapeHtml(row.bound_principal_id ?? "")} (${escapeHtml(row.bound_display_name ?? "")}). The redeemer inherits all existing Grants, assignments, and history. ${row.recovery_mode === "rotation" ? "A successful rotation revokes only the old Credential used to authenticate this redemption; other active Credentials remain valid." : "A successful full recovery revokes every previously active Credential for this Principal."}`}</p>`;
  };
  const metadata = JSON.stringify({
    bound_principal_id: row.bound_principal_id,
    expires_at: timestamp(row.expires_at),
    grants: grants.map((grant) => ({
      project_id: grant.project_id,
      project_key: grant.project_key,
      role: grant.role,
      workspace_key: grant.workspace_key,
    })),
    kind: row.kind,
    recovery_mode: row.recovery_mode,
    schema_version: 1,
  }).replaceAll("<", "\\u003c");
  const section = (sectionLocale: "en" | "zh-CN") => {
    const isChinese = sectionLocale === "zh-CN";
    const intro = isChinese
      ? "此页面只读，尚未消费邀请。请让 Agent 使用已从项目声明的 canonical publisher 验证过的 cfKanban Skill，核对发行来源、版本、完整性与下列目标后再执行兑换；不要运行页面中的远程脚本。"
      : "This page is read-only and has not consumed the Invitation. Ask your Agent to use a cfKanban Skill already verified against the project-declared canonical publisher, then check its source, version, integrity, and the targets below before redeeming. Do not run remote scripts from this page.";
    return `<section data-invitation-locale="${sectionLocale}"${locale === sectionLocale ? "" : " hidden"}><p>${intro}</p>${renderDetails(isChinese)}<p>${isChinese ? "有效期至" : "Expires at"} ${escapeHtml(timestamp(row.expires_at) ?? "")}.</p></section>`;
  };
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cfKanban Invitation</title></head><body><main><nav aria-label="Language"><button type="button" data-select-locale="en">English</button> <button type="button" data-select-locale="zh-CN">简体中文</button></nav><h1>cfKanban Invitation</h1>${section("en")}${section("zh-CN")}<script id="cfkanban-invitation-metadata" type="application/json">${metadata}</script></main><script>${INVITATION_PAGE_SCRIPT}</script></body></html>`;
}

async function optionalRedeemAuth(
  db: D1Database,
  request: Request,
  replacementToken: string | null,
): Promise<(AuthContext & { kind: "bearer" }) | null> {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  if (parseBearerCredential(header) === null) throw unauthorized();
  try {
    return await authenticateBearer(db, header);
  } catch (error) {
    if (replacementToken === null) throw error;
    return authenticateBearer(db, `Bearer ${replacementToken}`);
  }
}

function validateRedeemMode(
  invitation: InvitationRow,
  redeemAs: InvitationRedeemAs,
  auth: (AuthContext & { kind: "bearer" }) | null,
  displayNameValue: JsonValue | undefined,
  tokenValue: JsonValue | undefined,
): { displayName: string | null; replacement: { prefix: string; token: string } | null } {
  if (invitation.kind === "project_grant" && redeemAs === "new_principal") {
    if (auth !== null) throw validationError("new_principal_must_be_unauthenticated");
    return {
      displayName: requireDisplayName(displayNameValue as JsonValue),
      replacement: requireCredentialToken(tokenValue as JsonValue, "new_credential_token"),
    };
  }
  if (invitation.kind === "project_grant" && redeemAs === "current_principal") {
    if (auth === null) throw unauthorized();
    if (displayNameValue !== undefined || tokenValue !== undefined) {
      throw validationError("current_principal_fields_mixed");
    }
    if (auth.isOwner) throw forbidden();
    return { displayName: null, replacement: null };
  }
  if (invitation.kind === "principal_recovery" && redeemAs === "recovery") {
    if (displayNameValue !== undefined) throw validationError("recovery_display_name_forbidden");
    const replacement = requireCredentialToken(tokenValue as JsonValue, "new_credential_token");
    if (invitation.recovery_mode === "rotation" && auth === null) throw unauthorized();
    if (auth !== null && auth.principalId !== invitation.bound_principal_id) {
      throw recoveryPrincipalMismatch();
    }
    return { displayName: null, replacement };
  }
  throw invitationModeMismatch();
}

async function credentialDigestExists(db: D1Database, digest: string): Promise<boolean> {
  try {
    return await db.prepare("SELECT id FROM credentials WHERE token_digest = ?1 LIMIT 1")
      .bind(digest).first() !== null;
  } catch {
    throw platformUnavailable("d1");
  }
}

interface InvitationQuotaExceeded {
  currentUsage: number;
  limit: number;
  projectId: string;
}

async function projectQuotaExceeded(
  db: D1Database,
  invitationId: string,
  principalId: string,
): Promise<InvitationQuotaExceeded | null> {
  try {
    const row = await db.prepare(
      `SELECT p.id AS project_id, usage.active_principal_count AS current_usage,
              p.principal_limit AS quota_limit
       FROM invitation_project_grants ipg
       JOIN projects p ON p.id = ipg.project_id
       JOIN workspaces w ON w.id = p.workspace_id
       LEFT JOIN project_usage usage ON usage.project_id = p.id
       JOIN public_join_policies policy ON policy.project_id = p.id
       LEFT JOIN project_grants existing
         ON existing.project_id = p.id AND existing.principal_id = ?2
       WHERE ipg.invitation_id = ?1
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL
         AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
         AND p.principal_limit IS NOT NULL
         AND usage.active_principal_count >= p.principal_limit
         AND (existing.id IS NULL OR existing.revoked_at IS NOT NULL)
       ORDER BY p.id
       LIMIT 1`,
    ).bind(invitationId, principalId).first<{
      current_usage: number;
      project_id: string;
      quota_limit: number;
    }>();
    return row === null ? null : {
      currentUsage: row.current_usage,
      limit: row.quota_limit,
      projectId: row.project_id,
    };
  } catch {
    throw platformUnavailable("d1");
  }
}

async function invitationTargetsActive(db: D1Database, invitationId: string): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN p.deleted_at IS NULL AND w.deleted_at IS NULL THEN 1 ELSE 0 END) AS active
       FROM invitation_project_grants ipg
       JOIN projects p ON p.id = ipg.project_id
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE ipg.invitation_id = ?1`,
    ).bind(invitationId).first<{ active: number | null; total: number }>();
    return row !== null && row.total > 0 && row.active === row.total;
  } catch {
    throw platformUnavailable("d1");
  }
}

async function currentAuthRejected(db: D1Database, auth: AuthContext, now: number): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, now, 1);
  try {
    return await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first() === null;
  } catch {
    throw platformUnavailable("d1");
  }
}

async function executeProjectInviteRedeem(
  db: D1Database,
  invitation: InvitationRow,
  claim: IdempotencyClaim,
  auth: (AuthContext & { kind: "bearer" }) | null,
  displayName: string | null,
  replacement: { digest: string; id: string; prefix: string } | null,
  forbiddenValues: readonly string[],
  now: number,
): Promise<void> {
  const grants = await readInvitationGrants(db, invitation.id);
  if (grants.length < 1 || grants.length > 20) throw platformUnavailable("d1");
  const principalId = auth?.principalId ?? crypto.randomUUID();
  const plan = grants.map((grant, eventIndex) => ({
    event_id: crypto.randomUUID(),
    event_index: eventIndex,
    grant_id: crypto.randomUUID(),
    project_id: grant.project_id,
    role: grant.role,
  }));
  const planJson = JSON.stringify(plan);
  const statements: D1PreparedStatement[] = [];
  if (auth === null) {
    statements.push(db.prepare(
      `INSERT INTO principals (id, display_name, version, created_at, updated_at, last_operation_id)
       SELECT ?1, ?2, 1, ?3, ?3, ?4 FROM invitations
       WHERE id = ?5 AND code_digest = ?6 AND kind = 'project_grant'
         AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?3`,
    ).bind(principalId, displayName, now, claim.operationId, invitation.id, invitation.code_digest));
    statements.push(db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at,
         created_operation_id, last_operation_id)
       SELECT ?1, p.id, ?2, ?3, ?4, ?5, ?5 FROM principals p
       WHERE p.id = ?6 AND p.last_operation_id = ?5`,
    ).bind(replacement?.id, replacement?.prefix, replacement?.digest, now, claim.operationId, principalId));
  }
  const upsertAuthGuard = auth === null ? null : buildCurrentAuthGuard(auth, now, 6);
  statements.push(db.prepare(
    `INSERT INTO project_grants
      (id, principal_id, project_id, role, version, created_at,
       updated_at, created_operation_id, last_operation_id)
     SELECT json_extract(item.value, '$.grant_id'), target.id, p.id,
            json_extract(item.value, '$.role'), 1, ?3, ?3,
            ?4, ?4
     FROM json_each(?1) AS item
     JOIN invitation_project_grants ipg
       ON ipg.invitation_id = ?5
      AND ipg.project_id = json_extract(item.value, '$.project_id')
      AND ipg.role = json_extract(item.value, '$.role')
     JOIN principals target ON target.id = ?2
     JOIN projects p ON p.id = ipg.project_id
     JOIN workspaces w ON w.id = p.workspace_id
     LEFT JOIN project_usage usage ON usage.project_id = p.id
     LEFT JOIN public_join_policies policy ON policy.project_id = p.id
     LEFT JOIN project_grants existing
       ON existing.project_id = p.id AND existing.principal_id = target.id
     JOIN instance_meta im ON im.singleton = 1
     WHERE target.id != im.owner_principal_id
       AND p.deleted_at IS NULL AND w.deleted_at IS NULL
       AND (
         (existing.id IS NOT NULL AND existing.revoked_at IS NULL)
         OR policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
         OR (p.principal_limit IS NOT NULL
             AND usage.active_principal_count < p.principal_limit)
       )
       ${upsertAuthGuard === null
         ? "AND EXISTS (SELECT 1 FROM principals created WHERE created.id = target.id AND created.last_operation_id = ?4)"
         : `AND ${upsertAuthGuard.sql}`}
     ON CONFLICT(principal_id, project_id) DO UPDATE SET
       role = excluded.role,
       revoked_at = NULL,
       revoked_by_principal_id = NULL,
       version = project_grants.version + 1,
       updated_at = excluded.updated_at,
       last_operation_id = excluded.last_operation_id
     WHERE project_grants.revoked_at IS NOT NULL`,
  ).bind(
    planJson,
    principalId,
    now,
    claim.operationId,
    invitation.id,
    ...(upsertAuthGuard?.values ?? []),
  ));

  const outcomeAuthGuard = auth === null ? null : buildCurrentAuthGuard(auth, now, 5);
  statements.push(db.prepare(
    `INSERT INTO invitation_redemption_items
      (invitation_id, project_id, operation_id, outcome, effective_role)
     SELECT ?1, g.project_id, ?2,
            CASE WHEN g.created_operation_id = ?2 THEN 'created'
                 WHEN g.last_operation_id = ?2 THEN 'regranted'
                 ELSE 'already_has_access' END,
            g.role
     FROM json_each(?4) AS item
     JOIN invitation_project_grants ipg
       ON ipg.invitation_id = ?1
      AND ipg.project_id = json_extract(item.value, '$.project_id')
      AND ipg.role = json_extract(item.value, '$.role')
     JOIN projects p ON p.id = ipg.project_id
     JOIN workspaces w ON w.id = p.workspace_id
     JOIN project_grants g ON g.project_id = p.id AND g.principal_id = ?3
     WHERE g.revoked_at IS NULL
       AND p.deleted_at IS NULL AND w.deleted_at IS NULL
       ${outcomeAuthGuard === null
         ? `AND EXISTS (
              SELECT 1 FROM principals created
              JOIN credentials created_credential ON created_credential.principal_id = created.id
              WHERE created.id = ?3 AND created.last_operation_id = ?2
                AND created_credential.created_operation_id = ?2
            )`
         : `AND ${outcomeAuthGuard.sql}`}`,
  ).bind(
    invitation.id,
    claim.operationId,
    principalId,
    planJson,
    ...(outcomeAuthGuard?.values ?? []),
  ));

  statements.push(db.prepare(
    `UPDATE project_usage
     SET active_principal_count = active_principal_count + 1,
         updated_at = ?1, last_operation_id = ?2
     WHERE project_id IN (
       SELECT iri.project_id
       FROM invitation_redemption_items iri
       WHERE iri.invitation_id = ?3 AND iri.operation_id = ?2
         AND iri.outcome IN ('created', 'regranted')
     )
       AND EXISTS (
         SELECT 1 FROM public_join_policies policy
         WHERE policy.project_id = project_usage.project_id
           AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
       )`,
  ).bind(now, claim.operationId, invitation.id));
  statements.push(db.prepare(
    `UPDATE invitations
     SET redeemed_at = ?1, redeemed_by_principal_id = ?2, last_operation_id = ?3
     WHERE id = ?4 AND code_digest = ?5 AND kind = 'project_grant'
       AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?1
       AND (SELECT COUNT(*) FROM invitation_redemption_items iri
            WHERE iri.invitation_id = ?4 AND iri.operation_id = ?3) = ?6
       AND (?7 = 0 OR EXISTS (SELECT 1 FROM credentials c
                             WHERE c.principal_id = ?2 AND c.created_operation_id = ?3))`,
  ).bind(now, principalId, claim.operationId, invitation.id, invitation.code_digest, grants.length, auth === null ? 1 : 0));
  statements.push(redemptionOperationSnapshotStatement(
    db,
    claim.operationId,
    invitation.id,
    forbiddenValues,
  ));
  statements.push(db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, grant_id, workspace_id,
       project_id, subject_type, subject_id, payload_json, created_at)
     SELECT json_extract(item.value, '$.event_id'), 'domain',
            'invitation.project-grant-redeemed', ?2,
            json_extract(item.value, '$.event_index'), ?3, ?4, 'invitation',
            g.id, p.workspace_id, g.project_id, 'project_grant', g.id,
            json_object(
              'outcome', iri.outcome,
              'effective_role', iri.effective_role,
              'grant_version', g.version,
              'effective_capabilities', json_object(
                'read', json('true'),
                'write', json(CASE WHEN g.role = 'writer' THEN 'true' ELSE 'false' END)
              )
            ), ?5
     FROM json_each(?1) AS item
     JOIN invitation_redemption_items iri
       ON iri.invitation_id = ?6
      AND iri.project_id = json_extract(item.value, '$.project_id')
      AND iri.operation_id = ?2
     JOIN project_grants g ON g.project_id = iri.project_id AND g.principal_id = ?3
     JOIN projects p ON p.id = g.project_id
     LEFT JOIN project_usage usage ON usage.project_id = g.project_id
     LEFT JOIN public_join_policies policy ON policy.project_id = g.project_id
     JOIN invitations i ON i.id = iri.invitation_id
     WHERE i.last_operation_id = ?2
       AND (
         iri.outcome = 'already_has_access'
         OR policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
         OR usage.last_operation_id = ?2
       )`,
  ).bind(
    planJson,
    claim.operationId,
    principalId,
    auth?.credentialId ?? null,
    now,
    invitation.id,
  ));
  statements.push(db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, subject_type, subject_id,
       payload_json, created_at)
     SELECT ?1, 'security', 'invitation.redeemed', ?2, ?3, ?4, ?5,
            'invitation', 'invitation', i.id,
            json_object('kind', i.kind, 'project_count', ?3), ?6
     FROM invitations i WHERE i.id = ?7 AND i.last_operation_id = ?2`,
  ).bind(
    crypto.randomUUID(),
    claim.operationId,
    grants.length,
    principalId,
    auth?.credentialId ?? null,
    now,
    invitation.id,
  ));
  try {
    await executeAtomicBatch(db, {
      businessStatements: statements,
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readInvitationById(db, invitation.id);
        return latest === null || invitationStatus(latest, now) !== "active"
          || !(await invitationTargetsActive(db, invitation.id))
          || (auth !== null && await currentAuthRejected(db, auth, now))
          || (replacement !== null && await credentialDigestExists(db, replacement.digest))
          || await projectQuotaExceeded(db, invitation.id, principalId) !== null;
      },
      expectedEventCount: grants.length + 1,
      operationId: claim.operationId,
      primarySubjectId: invitation.id,
      primarySubjectType: "invitation",
      requireIdempotencySnapshot: true,
    });
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await assertRedemptionSnapshotInputsSafe(
        db,
        invitation,
        displayName ?? auth?.displayName ?? null,
        forbiddenValues,
      );
      const latest = await readInvitationById(db, invitation.id);
      if (latest === null) throw notFound();
      if (invitationStatus(latest, now) !== "active") assertInvitationUsable(latest, now);
      if (auth !== null) await verifyCurrentAuth(db, auth, now);
      if (!(await invitationTargetsActive(db, invitation.id))) throw notFound();
      if (replacement !== null && await credentialDigestExists(db, replacement.digest)) {
        throw conflict("CREDENTIAL_TOKEN_CONFLICT", "generate_new_credential");
      }
      const quota = await projectQuotaExceeded(db, invitation.id, principalId);
      if (quota !== null) throw businessQuotaExceeded("principals", quota.currentUsage, quota.limit);
      throw notFound();
    }
    throw error;
  }
}

async function executeRecoveryRedeem(
  db: D1Database,
  invitation: InvitationRow,
  claim: IdempotencyClaim,
  auth: (AuthContext & { kind: "bearer" }) | null,
  replacement: { digest: string; id: string; prefix: string },
  forbiddenValues: readonly string[],
  now: number,
): Promise<void> {
  const principalId = invitation.bound_principal_id;
  if (principalId === null || invitation.recovery_mode === null) throw platformUnavailable("d1");
  const guard = invitation.recovery_mode === "rotation" && auth !== null
    ? buildCurrentAuthGuard(auth, now, 9)
    : null;
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at,
         created_operation_id, last_operation_id)
       SELECT ?1, i.bound_principal_id, ?2, ?3, ?4, ?5, ?5
       FROM invitations i
       WHERE i.id = ?6 AND i.code_digest = ?7
         AND i.kind = 'principal_recovery'
         AND i.revoked_at IS NULL AND i.redeemed_at IS NULL
         AND i.expires_at > ?4
         ${guard === null ? "AND i.recovery_mode = 'full_recovery'" : `AND i.recovery_mode = 'rotation' AND i.bound_principal_id = ?8 AND ${guard.sql}`}`,
    ).bind(
      replacement.id,
      replacement.prefix,
      replacement.digest,
      now,
      claim.operationId,
      invitation.id,
      invitation.code_digest,
      ...(guard === null ? [] : [auth?.principalId ?? "", ...guard.values]),
    ),
  ];
  if (invitation.recovery_mode === "rotation") {
    statements.push(db.prepare(
      `UPDATE credentials
       SET revoked_at = ?1, revoked_by_principal_id = ?2,
           revoke_reason = 'participant_rotation', last_operation_id = ?3
       WHERE id = ?4 AND principal_id = ?2 AND revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM credentials replacement
                     WHERE replacement.created_operation_id = ?3)`,
    ).bind(now, principalId, claim.operationId, auth?.credentialId));
  } else {
    statements.push(db.prepare(
      `UPDATE credentials
       SET revoked_at = ?1, revoked_by_principal_id = ?2,
           revoke_reason = 'participant_full_recovery', last_operation_id = ?3
       WHERE principal_id = ?2 AND revoked_at IS NULL
         AND created_operation_id != ?3
         AND EXISTS (SELECT 1 FROM credentials replacement
                     WHERE replacement.created_operation_id = ?3)`,
    ).bind(now, principalId, claim.operationId));
  }
  statements.push(db.prepare(
    `UPDATE invitations
     SET redeemed_at = ?1, redeemed_by_principal_id = ?2, last_operation_id = ?3
     WHERE id = ?4 AND code_digest = ?5
       AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?1
       AND EXISTS (SELECT 1 FROM credentials replacement
                   WHERE replacement.created_operation_id = ?3)
       AND (?6 = 'full_recovery' OR
            (SELECT COUNT(*) FROM credentials old
             WHERE old.principal_id = ?2 AND old.last_operation_id = ?3
               AND old.revoked_at IS NOT NULL) = 1)`,
  ).bind(now, principalId, claim.operationId, invitation.id, invitation.code_digest, invitation.recovery_mode));
  statements.push(redemptionOperationSnapshotStatement(
    db,
    claim.operationId,
    invitation.id,
    forbiddenValues,
  ));
  statements.push(db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, subject_type, subject_id,
       payload_json, created_at)
     SELECT ?1, 'security', 'principal.credential-recovered', ?2, 0,
            ?3, ?4, 'invitation', 'principal', ?3,
            json_object(
              'mode', i.recovery_mode,
              'replacement_credential_id', replacement.id,
              'revoked_count', (SELECT COUNT(*) FROM credentials old
                                WHERE old.principal_id = ?3
                                  AND old.last_operation_id = ?2
                                  AND old.revoked_at IS NOT NULL)
            ), ?5
     FROM invitations i
     JOIN credentials replacement ON replacement.created_operation_id = ?2
     WHERE i.id = ?6 AND i.last_operation_id = ?2`,
  ).bind(
    crypto.randomUUID(),
    claim.operationId,
    principalId,
    invitation.recovery_mode === "rotation" ? auth?.credentialId ?? null : null,
    now,
    invitation.id,
  ));
  try {
    await executeAtomicBatch(db, {
      businessStatements: statements,
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readInvitationById(db, invitation.id);
        return latest === null || invitationStatus(latest, now) !== "active"
          || (invitation.recovery_mode === "rotation"
            && (auth === null || await currentAuthRejected(db, auth, now)))
          || await credentialDigestExists(db, replacement.digest);
      },
      expectedEventCount: 1,
      operationId: claim.operationId,
      primarySubjectId: invitation.id,
      primarySubjectType: "invitation",
      requireIdempotencySnapshot: true,
    });
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await assertRedemptionSnapshotInputsSafe(
        db,
        invitation,
        invitation.bound_display_name,
        forbiddenValues,
      );
      const latest = await readInvitationById(db, invitation.id);
      if (latest === null) throw notFound();
      if (invitationStatus(latest, now) !== "active") assertInvitationUsable(latest, now);
      if (invitation.recovery_mode === "rotation") {
        if (auth === null) throw unauthorized();
        await verifyCurrentAuth(db, auth, now);
      }
      if (await credentialDigestExists(db, replacement.digest)) {
        throw conflict("CREDENTIAL_TOKEN_CONFLICT", "generate_new_credential");
      }
      throw forbidden();
    }
    throw error;
  }
}

async function redemptionReadback(
  db: D1Database,
  commit: OperationCommit,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const snapshot = await readOperationSnapshot<RedemptionOperationSnapshot>(db, commit.operationId);
  const resource = {
    ...(await invitationResource(db, snapshot.row, now, snapshot.grants)),
    credential: snapshot.credential === null ? null : {
      fingerprint: `cfk_v1_${snapshot.credential.token_prefix}_…`,
      id: snapshot.credential.id,
      issued_at: timestamp(snapshot.credential.issued_at),
    },
    principal: {
      display_name: snapshot.principal.display_name,
      principal_id: snapshot.principal.id,
    },
    results: snapshot.results.map((item) => ({
      effective_role: item.effective_role,
      outcome: item.outcome,
      project_id: item.project_id,
    })),
  };
  return writeResult(
    db,
    { principalId: snapshot.principal.id },
    resource,
    commit.lastEventSequence,
    false,
  );
}

export async function redeemInvitation(
  db: D1Database,
  request: Request,
  inviteCodeValue: JsonValue,
  redeemAsValue: JsonValue,
  displayNameValue: JsonValue | undefined,
  tokenValue: JsonValue | undefined,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  if (typeof inviteCodeValue !== "string" || inviteCodeValue.length < 1 || inviteCodeValue.length > 1_024) {
    throw validationError("schema_validation_failed", { field: "invite_code" });
  }
  const inviteCode = inviteCodeValue;
  const redeemAs = requireInvitationRedeemAs(redeemAsValue);
  const preliminaryToken = typeof tokenValue === "string" ? tokenValue : null;
  const invitation = await readInvitationByDigest(db, await sha256Hex(inviteCode));
  if (invitation === null) throw notFound();
  let auth = await optionalRedeemAuth(db, request, preliminaryToken);
  const mode = validateRedeemMode(invitation, redeemAs, auth, displayNameValue, tokenValue);
  if (auth === null && invitation.recovery_mode === "rotation" && mode.replacement !== null) {
    auth = await optionalRedeemAuth(db, request, mode.replacement.token);
  }
  const replacement = mode.replacement === null ? null : {
    digest: await sha256Hex(mode.replacement.token),
    id: crypto.randomUUID(),
    prefix: mode.replacement.prefix,
    token: mode.replacement.token,
  };
  const persistenceForbiddenValues = [
    inviteCode,
    ...(mode.replacement === null ? [] : [mode.replacement.token]),
  ];
  const redeemedPrincipalDisplayName = mode.displayName
    ?? auth?.displayName
    ?? invitation.bound_display_name;
  assertSecretNotInBusinessText(
    redeemedPrincipalDisplayName,
    "display_name",
    persistenceForbiddenValues,
  );
  const idempotencyKey = requireIdempotencyKey(request);
  const scopeKey = redeemAs === "new_principal" || invitation.recovery_mode === "full_recovery"
    ? `invitation:${invitation.id}`
    : `principal:${auth?.principalId ?? invitation.bound_principal_id ?? "unknown"}`;
  const identity = {
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `invitation:${invitation.id}:redeem`,
    requestBody: {
      display_name: mode.displayName,
      invite_code: inviteCode,
      new_credential_token: mode.replacement?.token ?? null,
      redeem_as: redeemAs,
    },
    routeTemplate: "/api/v1/invitations/redeem",
    scopeKey,
  };
  const claim = await claimIdempotency(
    db,
    identity,
    now,
    persistenceForbiddenValues,
  );
  const status = invitationStatus(invitation, now);
  if (status === "revoked") {
    await abandonOwnedPendingClaim(db, claim);
    throw gone("INVITATION_REVOKED");
  }
  if (status === "expired") {
    await abandonOwnedPendingClaim(db, claim);
    throw gone("INVITATION_EXPIRED");
  }
  if (status === "redeemed" && invitation.last_operation_id !== claim.operationId) {
    await abandonOwnedPendingClaim(db, claim);
    throw gone("INVITATION_ALREADY_REDEEMED");
  }
  if (claim.state === "committed") {
    const stored = readIdempotencyResponse<{ [key: string]: JsonValue }>(claim);
    return { ...stored.body, idempotent_replay: true };
  }
  let commit = await probeOperationCommit(db, claim.operationId);
  const resumed = commit !== null;
  if (commit === null) {
    await assertRedemptionSnapshotInputsSafe(
      db,
      invitation,
      redeemedPrincipalDisplayName,
      persistenceForbiddenValues,
    );
    try {
      if (invitation.kind === "project_grant") {
        await executeProjectInviteRedeem(
          db,
          invitation,
          claim,
          auth,
          mode.displayName,
          replacement,
          persistenceForbiddenValues,
          now,
        );
      } else {
        if (replacement === null) throw validationError("new_credential_token_required");
        await executeRecoveryRedeem(
          db,
          invitation,
          claim,
          auth,
          replacement,
          persistenceForbiddenValues,
          now,
        );
      }
    } catch (error) {
      commit = await probeOperationCommit(db, claim.operationId);
      if (commit === null) throw error;
    }
    commit = await probeOperationCommit(db, claim.operationId);
  }
  if (commit === null) throw new AtomicBatchRejectedError();
  let body: { [key: string]: JsonValue };
  try {
    body = await redemptionReadback(db, commit, now);
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const finalizedByPeer = await readFinalizedIdempotencyResponse<{ [key: string]: JsonValue }>(
        db,
        claim.operationId,
      );
      if (finalizedByPeer !== null) {
        return { ...finalizedByPeer.body, idempotent_replay: true };
      }
    }
    throw error;
  }
  const finalized = await finalizeIdempotency(
    db,
    claim.operationId,
    { body, status: 200 },
    persistenceForbiddenValues,
    now,
  );
  return {
    ...finalized.body,
    idempotent_replay: !claim.owned || resumed || status === "redeemed",
  };
}
