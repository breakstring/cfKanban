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
import { createCursorContext, decodeCursor, encodeCursor } from "../kernel/cursor.ts";
import { sha256Hex } from "../kernel/crypto.ts";
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
  claimIdempotency,
  finalizeIdempotency,
  readIdempotencyResponse,
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
  outcome: "already_has_access" | "created" | "promoted" | "regranted";
  project_id: string;
}

interface RedemptionCredentialRow {
  id: string;
  issued_at: number;
  principal_display_name: string;
  principal_id: string;
  token_prefix: string;
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

async function readInvitationByOperation(db: D1Database, operationId: string): Promise<InvitationRow | null> {
  try {
    return await db.prepare(
      `SELECT i.id, i.kind, i.code_prefix, i.code_digest, i.bound_principal_id,
              bound.display_name AS bound_display_name, i.recovery_mode,
              i.expires_at, i.revoked_at, i.redeemed_at,
              i.redeemed_by_principal_id, i.created_at,
              i.created_by_owner_principal_id, i.last_operation_id
       FROM invitations AS i
       LEFT JOIN principals AS bound ON bound.id = i.bound_principal_id
       WHERE i.created_operation_id = ?1 LIMIT 1`,
    ).bind(operationId).first<InvitationRow>();
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

async function invitationResource(
  db: D1Database,
  row: InvitationRow,
  now: number,
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
    grants: (await readInvitationGrants(db, row.id)).map((grant) => ({
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

function parseCursor(cursor: JsonValue[] | null, rows: readonly InvitationRow[]): number {
  if (cursor === null) return 0;
  if (cursor.length !== 1 || typeof cursor[0] !== "string") throw validationError("invalid_cursor");
  const index = rows.findIndex((row) => row.id === cursor[0]);
  if (index < 0) throw validationError("invalid_cursor");
  return index + 1;
}

export async function listInvitations(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
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
       ORDER BY i.created_at DESC, i.id`,
    ).all<InvitationRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const limit = requireLimit(url);
  const cursorContext = await createCursorContext("invitations", {}, [`owner:${auth.principalId}`]);
  const start = parseCursor(decodeCursor(url.searchParams.get("cursor"), cursorContext), rows);
  const remaining = rows.slice(start);
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  const tail = page.at(-1);
  return {
    has_more: hasMore,
    items: await Promise.all(page.map((row) => invitationResource(db, row, now))),
    next_cursor: hasMore && tail ? encodeCursor(cursorContext, [tail.id]) : null,
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
  ];
  for (const grant of grants) {
    statements.push(db.prepare(
      `INSERT INTO invitation_project_grants (invitation_id, project_id, role)
       SELECT i.id, p.id, ?1
       FROM invitations AS i
       JOIN projects AS p ON p.id = ?2
       JOIN workspaces AS w ON w.id = p.workspace_id
       WHERE i.id = ?3 AND i.created_operation_id = ?4
         AND i.kind = 'project_grant'
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL`,
    ).bind(grant.role, grant.projectId, invitationId, operationId));
  }
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
        for (const grant of grants) {
          const project = await db.prepare(
            `SELECT p.id FROM projects p JOIN workspaces w ON w.id = p.workspace_id
             WHERE p.id = ?1 AND p.deleted_at IS NULL AND w.deleted_at IS NULL`,
          ).bind(grant.projectId).first();
          if (project === null) return true;
        }
        return ownerGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: invitationId,
      primarySubjectType: "invitation",
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
      if (commit === null) throw error;
    }
    commit = await probeOperationCommit(db, claim.operationId);
  }
  if (commit === null) throw new AtomicBatchRejectedError();
  await reauthenticateOwner(db, request, now);
  const row = await readInvitationByOperation(db, claim.operationId);
  if (row === null) throw platformUnavailable("d1");
  const safeBody = writeResult({
    ...(await invitationResource(db, row, now)),
    secret_available: false,
  }, commit.lastEventSequence, false);
  const finalized = await finalizeIdempotency(
    db,
    claim.operationId,
    { body: safeBody, status: 200 },
    generatedCode === null ? [] : [generatedCode],
    now,
  );
  if (generatedCode === null || generatedDigest !== row.code_digest) {
    return { ...finalized.body, idempotent_replay: true };
  }
  const origin = await preferredOrigin(db);
  const inviteUrl = `${origin}/invite?code=${encodeURIComponent(generatedCode)}`;
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
  const updated = await readInvitationById(db, invitationId);
  if (updated === null) throw platformUnavailable("d1");
  return writeResult(await invitationResource(db, updated, now), commit.lastEventSequence, false);
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

export async function getInvitationBootstrapHtml(
  db: D1Database,
  codeValue: string | null,
  now: number,
): Promise<string> {
  if (codeValue === null || codeValue.length < 1 || codeValue.length > 1_024) {
    throw validationError("invalid_invitation_code");
  }
  const row = await readInvitationByDigest(db, await sha256Hex(codeValue));
  if (row === null) throw notFound();
  assertInvitationUsable(row, now);
  const grants = await readInvitationGrants(db, row.id);
  const details = row.kind === "project_grant"
    ? `<ul>${grants.map((grant) => `<li>${escapeHtml(grant.display_name)} — ${grant.role}</li>`).join("")}</ul>`
    : `<p><strong>身份恢复警告：</strong>此邀请绑定 Principal ${escapeHtml(row.bound_principal_id ?? "")}（${escapeHtml(row.bound_display_name ?? "")}），模式为 ${escapeHtml(row.recovery_mode ?? "")}。兑换者将继承该身份的现有授权、assignment 与历史。</p>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cfKanban Invitation</title></head><body><main><h1>cfKanban Invitation</h1><p>此页面只读，尚未消费邀请。请使用受信任的 cfKanban Skill 检查来源、目标权限并执行兑换；不要运行页面提供的远程脚本。</p>${details}<p>有效期至 ${escapeHtml(timestamp(row.expires_at) ?? "")}。</p></main><script>history.replaceState({},document.title,"/invite")</script></body></html>`;
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

async function projectQuotaExceeded(db: D1Database, invitationId: string, principalId: string): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT 1 AS exceeded
       FROM invitation_project_grants ipg
       JOIN projects p ON p.id = ipg.project_id
       JOIN workspaces w ON w.id = p.workspace_id
       JOIN project_usage usage ON usage.project_id = p.id
       JOIN public_join_policies policy ON policy.project_id = p.id
       LEFT JOIN project_grants existing
         ON existing.project_id = p.id AND existing.principal_id = ?2
       WHERE ipg.invitation_id = ?1
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL
         AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
         AND p.principal_limit IS NOT NULL
         AND usage.active_principal_count >= p.principal_limit
         AND (existing.id IS NULL OR existing.revoked_at IS NOT NULL)
       LIMIT 1`,
    ).bind(invitationId, principalId).first();
    return row !== null;
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
  now: number,
): Promise<void> {
  const grants = await readInvitationGrants(db, invitation.id);
  if (grants.length < 1 || grants.length > 20) throw platformUnavailable("d1");
  const principalId = auth?.principalId ?? crypto.randomUUID();
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
  const authGuard = auth === null ? null : buildCurrentAuthGuard(auth, now, 9);
  for (const grant of grants) {
    const grantId = crypto.randomUUID();
    const grantCreatedOperationId = crypto.randomUUID();
    statements.push(db.prepare(
      `INSERT INTO project_grants
        (id, principal_id, project_id, role, version, created_at,
         updated_at, created_operation_id, last_operation_id)
       SELECT ?1, target.id, p.id, ?4, 1, ?5, ?5, ?8, ?6
       FROM principals target
       JOIN projects p ON p.id = ?3
       JOIN workspaces w ON w.id = p.workspace_id
       JOIN project_usage usage ON usage.project_id = p.id
       LEFT JOIN public_join_policies policy ON policy.project_id = p.id
       LEFT JOIN project_grants existing
         ON existing.project_id = p.id AND existing.principal_id = target.id
       JOIN instance_meta im ON im.singleton = 1
       WHERE target.id = ?2 AND target.id != im.owner_principal_id
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM invitation_project_grants ipg
                     WHERE ipg.invitation_id = ?7 AND ipg.project_id = p.id
                       AND ipg.role = ?4)
         AND (existing.id IS NOT NULL AND existing.revoked_at IS NULL
              OR policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
              OR p.principal_limit IS NULL
              OR usage.active_principal_count < p.principal_limit)
         ${authGuard === null
           ? "AND EXISTS (SELECT 1 FROM principals created WHERE created.id = target.id AND created.last_operation_id = ?6)"
           : `AND ${authGuard.sql}`}
       ON CONFLICT(principal_id, project_id) DO UPDATE SET
         role = CASE WHEN project_grants.revoked_at IS NOT NULL THEN excluded.role ELSE project_grants.role END,
         revoked_at = CASE WHEN project_grants.revoked_at IS NOT NULL THEN NULL ELSE project_grants.revoked_at END,
         revoked_by_principal_id = CASE WHEN project_grants.revoked_at IS NOT NULL THEN NULL ELSE project_grants.revoked_by_principal_id END,
         version = CASE WHEN project_grants.revoked_at IS NOT NULL THEN project_grants.version + 1 ELSE project_grants.version END,
         updated_at = CASE WHEN project_grants.revoked_at IS NOT NULL THEN excluded.updated_at ELSE project_grants.updated_at END,
         last_operation_id = CASE WHEN project_grants.revoked_at IS NOT NULL THEN excluded.last_operation_id ELSE project_grants.last_operation_id END`,
    ).bind(
      grantId,
      principalId,
      grant.project_id,
      grant.role,
      now,
      claim.operationId,
      invitation.id,
      grantCreatedOperationId,
      ...(authGuard?.values ?? []),
    ));
    statements.push(db.prepare(
      `INSERT INTO invitation_redemption_items
        (invitation_id, project_id, operation_id, outcome, effective_role)
       SELECT ?1, g.project_id, ?2,
              CASE WHEN g.created_operation_id = ?5 THEN 'created'
                   WHEN g.last_operation_id = ?2 THEN 'regranted'
                   ELSE 'already_has_access' END,
              g.role
       FROM project_grants g
       WHERE g.principal_id = ?3 AND g.project_id = ?4
         AND g.revoked_at IS NULL`,
    ).bind(
      invitation.id,
      claim.operationId,
      principalId,
      grant.project_id,
      grantCreatedOperationId,
    ));
    statements.push(db.prepare(
      `UPDATE project_usage
       SET active_principal_count = active_principal_count + 1,
           updated_at = ?1, last_operation_id = ?2
       WHERE project_id = ?3 AND EXISTS (
         SELECT 1 FROM project_grants g
         WHERE g.principal_id = ?4 AND g.project_id = ?3
           AND g.revoked_at IS NULL
           AND (g.created_operation_id = ?2 OR g.last_operation_id = ?2)
       )`,
    ).bind(now, claim.operationId, grant.project_id, principalId));
  }
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
  grants.forEach((grant, index) => {
    statements.push(db.prepare(
      `INSERT INTO events
        (id, stream, type, operation_id, event_index, actor_principal_id,
         actor_credential_id, authorized_via, grant_id, workspace_id,
         project_id, subject_type, subject_id, payload_json, created_at)
       SELECT ?1, 'domain', 'invitation.project-grant-redeemed', ?2, ?3,
              ?4, ?5, 'invitation', g.id, p.workspace_id, g.project_id,
              'project_grant', g.id,
              json_object('outcome', iri.outcome, 'effective_role', iri.effective_role), ?6
       FROM invitation_redemption_items iri
       JOIN project_grants g ON g.project_id = iri.project_id AND g.principal_id = ?4
       JOIN projects p ON p.id = g.project_id
       JOIN invitations i ON i.id = iri.invitation_id
       WHERE iri.invitation_id = ?7 AND iri.project_id = ?8
         AND iri.operation_id = ?2 AND i.last_operation_id = ?2`,
    ).bind(
      crypto.randomUUID(),
      claim.operationId,
      index,
      principalId,
      auth?.credentialId ?? replacement?.id ?? null,
      now,
      invitation.id,
      grant.project_id,
    ));
  });
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
    auth?.credentialId ?? replacement?.id ?? null,
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
          || (replacement !== null && await credentialDigestExists(db, replacement.digest))
          || await projectQuotaExceeded(db, invitation.id, principalId);
      },
      expectedEventCount: grants.length + 1,
      operationId: claim.operationId,
      primarySubjectId: invitation.id,
      primarySubjectType: "invitation",
    });
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const latest = await readInvitationById(db, invitation.id);
      if (latest === null) throw notFound();
      if (invitationStatus(latest, now) !== "active") assertInvitationUsable(latest, now);
      if (replacement !== null && await credentialDigestExists(db, replacement.digest)) {
        throw conflict("CREDENTIAL_TOKEN_CONFLICT", "generate_new_credential");
      }
      if (await projectQuotaExceeded(db, invitation.id, principalId)) throw businessQuotaExceeded("principals");
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
  statements.push(db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, subject_type, subject_id,
       payload_json, created_at)
     SELECT ?1, 'security', 'principal.credential-recovered', ?2, 0,
            ?3, replacement.id, 'invitation', 'principal', ?3,
            json_object(
              'mode', i.recovery_mode,
              'revoked_count', (SELECT COUNT(*) FROM credentials old
                                WHERE old.principal_id = ?3
                                  AND old.last_operation_id = ?2
                                  AND old.revoked_at IS NOT NULL)
            ), ?4
     FROM invitations i
     JOIN credentials replacement ON replacement.created_operation_id = ?2
     WHERE i.id = ?5 AND i.last_operation_id = ?2`,
  ).bind(crypto.randomUUID(), claim.operationId, principalId, now, invitation.id));
  try {
    await executeAtomicBatch(db, {
      businessStatements: statements,
      committedAt: now,
      confirmBusinessRejection: async () => {
        const latest = await readInvitationById(db, invitation.id);
        return latest === null || invitationStatus(latest, now) !== "active"
          || await credentialDigestExists(db, replacement.digest);
      },
      expectedEventCount: 1,
      operationId: claim.operationId,
      primarySubjectId: invitation.id,
      primarySubjectType: "invitation",
    });
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const latest = await readInvitationById(db, invitation.id);
      if (latest === null) throw notFound();
      if (invitationStatus(latest, now) !== "active") assertInvitationUsable(latest, now);
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
  invitation: InvitationRow,
  commit: OperationCommit,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const current = await readInvitationById(db, invitation.id);
  if (current === null || current.last_operation_id !== commit.operationId) throw platformUnavailable("d1");
  let credential: RedemptionCredentialRow | null = null;
  let items: RedemptionItemRow[] = [];
  let principal: { display_name: string; id: string } | null = null;
  try {
    const [credentialRow, itemResult, principalRow] = await Promise.all([
      db.prepare(
        `SELECT c.id, c.principal_id, c.token_prefix, c.issued_at,
                p.display_name AS principal_display_name
         FROM credentials c JOIN principals p ON p.id = c.principal_id
         WHERE c.created_operation_id = ?1 LIMIT 1`,
      ).bind(commit.operationId).first<RedemptionCredentialRow>(),
      db.prepare(
        `SELECT project_id, outcome, effective_role
         FROM invitation_redemption_items
         WHERE invitation_id = ?1 AND operation_id = ?2 ORDER BY project_id`,
      ).bind(invitation.id, commit.operationId).all<RedemptionItemRow>(),
      db.prepare(
        `SELECT p.id, p.display_name
         FROM invitations i JOIN principals p ON p.id = i.redeemed_by_principal_id
         WHERE i.id = ?1 AND i.last_operation_id = ?2 LIMIT 1`,
      ).bind(invitation.id, commit.operationId).first<{ display_name: string; id: string }>(),
    ]);
    credential = credentialRow;
    const result = itemResult;
    items = result.results;
    principal = principalRow;
  } catch {
    throw platformUnavailable("d1");
  }
  if (principal === null) throw platformUnavailable("d1");
  const resource = {
    ...(await invitationResource(db, current, now)),
    credential: credential === null ? null : {
      fingerprint: `cfk_v1_${credential.token_prefix}_…`,
      id: credential.id,
      issued_at: timestamp(credential.issued_at),
    },
    principal: {
      display_name: principal.display_name,
      principal_id: principal.id,
    },
    results: items.map((item) => ({
      effective_role: item.effective_role,
      outcome: item.outcome,
      project_id: item.project_id,
    })),
  };
  return writeResult(resource, commit.lastEventSequence, false);
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
    [inviteCode, ...(mode.replacement === null ? [] : [mode.replacement.token])],
  );
  const status = invitationStatus(invitation, now);
  if (status === "revoked") throw gone("INVITATION_REVOKED");
  if (status === "expired") throw gone("INVITATION_EXPIRED");
  if (status === "redeemed" && invitation.last_operation_id !== claim.operationId) {
    throw conflict("INVITATION_ALREADY_REDEEMED", "request_new_invitation");
  }
  if (claim.state === "committed") {
    const stored = readIdempotencyResponse<{ [key: string]: JsonValue }>(claim);
    return { ...stored.body, idempotent_replay: true };
  }
  let commit = await probeOperationCommit(db, claim.operationId);
  const resumed = commit !== null;
  if (commit === null) {
    try {
      if (invitation.kind === "project_grant") {
        await executeProjectInviteRedeem(
          db,
          invitation,
          claim,
          auth,
          mode.displayName,
          replacement,
          now,
        );
      } else {
        if (replacement === null) throw validationError("new_credential_token_required");
        await executeRecoveryRedeem(db, invitation, claim, auth, replacement, now);
      }
    } catch (error) {
      commit = await probeOperationCommit(db, claim.operationId);
      if (commit === null) throw error;
    }
    commit = await probeOperationCommit(db, claim.operationId);
  }
  if (commit === null) throw new AtomicBatchRejectedError();
  const body = await redemptionReadback(db, invitation, commit, now);
  const finalized = await finalizeIdempotency(
    db,
    claim.operationId,
    { body, status: 200 },
    [inviteCode, ...(mode.replacement === null ? [] : [mode.replacement.token])],
    now,
  );
  return {
    ...finalized.body,
    idempotent_replay: !claim.owned || resumed || status === "redeemed",
  };
}
