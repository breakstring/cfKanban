import {
  requireIssueIdentifier,
  requireProjectKey,
  requireWorkspaceKey,
  timestamp,
} from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  requireOwnerControl,
  requireProjectAuthorization,
  resolveCurrentVisibleProjects,
  resolveVisibleProjects,
  verifyCurrentAuth,
} from "../kernel/authorization.ts";
import { sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, probeOperationCommit, type OperationCommit } from "../kernel/d1.ts";
import {
  ApiError,
  forbidden,
  gone,
  notFound,
  platformUnavailable,
  unauthorized,
  validationError,
} from "../kernel/errors.ts";
import {
  abandonOwnedPendingClaim,
  claimIdempotency,
  finalizeIdempotency,
  operationSnapshotStatement,
  readFinalizedIdempotencyResponse,
  readIdempotencyResponse,
  readOperationSnapshot,
} from "../kernel/idempotency.ts";
import { validateJsonObject } from "../kernel/http.ts";
import type { AuthContext, BearerAuthContext, CookieAuthContext, JsonValue } from "../kernel/types.ts";
import { randomBase64Url } from "../kernel/webauthn.ts";
import { requireCollaborationIssue } from "./collaboration-shared.ts";
import { actorCredentialId, authorizedVia, eventCursor, requireIdempotencyKey, writeResult } from "./shared.ts";

const BROWSER_LAUNCH_LIFETIME_MS = 5 * 60 * 1_000;
const WEB_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const ADMIN_SECTIONS = new Set(["overview", "workspaces-projects", "access", "audit"]);

type LaunchTarget =
  | {
    entry_path: string;
    kind: "admin";
    section: string;
  }
  | {
    entry_path: string;
    kind: "project";
    project_id: string;
    project_key: string;
    workspace_key: string;
  }
  | {
    entry_path: string;
    identifier: string;
    issue_id: string;
    kind: "issue";
    project_id: string;
    project_key: string;
    workspace_key: string;
  };

interface BrowserLaunchRow {
  code_digest: string;
  code_prefix: string;
  created_at: number;
  expires_at: number;
  id: string;
  last_operation_id: string | null;
  principal_id: string;
  redeemed_at: number | null;
  revoked_at: number | null;
  source_credential_id: string;
  target_json: string;
  target_kind: "admin" | "issue" | "project";
}

interface LaunchOperationSnapshot {
  code_digest: string;
  row: BrowserLaunchRow;
  target: LaunchTarget;
}

interface SessionOperationSnapshot {
  csrf_digest: string;
  display_name: string;
  entry_path: string;
  expires_at: number;
  is_owner: boolean;
  principal_id: string;
  session_id: string;
  session_token_digest: string;
  source_id: string;
  source_kind: "credential" | "web_authenticator";
  target: LaunchTarget | { entry_path: string; kind: "project_selection" };
}

export interface SessionExchangeResult {
  body: { [key: string]: JsonValue };
  csrfToken: string | null;
  sessionToken: string | null;
}

function parseObject(value: JsonValue): { [key: string]: JsonValue } {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw validationError("object_required");
  }
  return value;
}

function launchUnavailable(): ApiError {
  return gone("BROWSER_LAUNCH_UNAVAILABLE", "request_new_browser_launch");
}

function requireLaunchCode(value: JsonValue): string {
  if (
    typeof value !== "string"
    || !/^cfl_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/u.test(value)
  ) throw launchUnavailable();
  return value;
}

function generateLaunchCode(): { code: string; prefix: string } {
  const prefix = randomBase64Url(16).slice(0, 8);
  return { code: `cfl_v1_${prefix}_${randomBase64Url(32)}`, prefix };
}

function jsonObject(value: string): { [key: string]: JsonValue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw platformUnavailable("d1");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw platformUnavailable("d1");
  }
  return parsed as { [key: string]: JsonValue };
}

function launchTargetFromRow(row: BrowserLaunchRow): LaunchTarget {
  const target = jsonObject(row.target_json);
  if (row.target_kind === "admin") {
    if (typeof target.section !== "string" || !ADMIN_SECTIONS.has(target.section)) throw platformUnavailable("d1");
    return { entry_path: "/app/admin", kind: "admin", section: target.section };
  }
  if (
    typeof target.project_id !== "string"
    || typeof target.project_key !== "string"
    || typeof target.workspace_key !== "string"
  ) throw platformUnavailable("d1");
  if (row.target_kind === "project") {
    return {
      entry_path: `/app/w/${encodeURIComponent(target.workspace_key)}/p/${encodeURIComponent(target.project_key)}`,
      kind: "project",
      project_id: target.project_id,
      project_key: target.project_key,
      workspace_key: target.workspace_key,
    };
  }
  if (typeof target.identifier !== "string" || typeof target.issue_id !== "string") {
    throw platformUnavailable("d1");
  }
  return {
    entry_path: `/app/issues/${encodeURIComponent(target.identifier)}`,
    identifier: target.identifier,
    issue_id: target.issue_id,
    kind: "issue",
    project_id: target.project_id,
    project_key: target.project_key,
    workspace_key: target.workspace_key,
  };
}

async function resolveLaunchTarget(
  db: D1Database,
  auth: BearerAuthContext,
  value: JsonValue,
): Promise<LaunchTarget> {
  const target = parseObject(value);
  if (target.kind === "project") {
    validateJsonObject(target, {
      allowedKeys: ["kind", "project_key", "workspace_key"],
      requiredKeys: ["kind", "project_key", "workspace_key"],
    });
    const workspaceKey = requireWorkspaceKey(target.workspace_key as JsonValue, "workspace_key");
    const projectKey = requireProjectKey(target.project_key as JsonValue, "project_key");
    const project = await requireProjectAuthorization(db, auth, workspaceKey, projectKey);
    return {
      entry_path: `/app/w/${encodeURIComponent(workspaceKey)}/p/${encodeURIComponent(projectKey)}`,
      kind: "project",
      project_id: project.projectId,
      project_key: project.projectKey,
      workspace_key: project.workspaceKey,
    };
  }
  if (target.kind === "issue") {
    validateJsonObject(target, {
      allowedKeys: ["identifier", "kind"],
      requiredKeys: ["identifier", "kind"],
    });
    const identifier = requireIssueIdentifier(target.identifier as JsonValue, "identifier");
    const issue = await requireCollaborationIssue(db, auth, identifier);
    return {
      entry_path: `/app/issues/${encodeURIComponent(identifier)}`,
      identifier,
      issue_id: issue.id,
      kind: "issue",
      project_id: issue.projectId,
      project_key: issue.projectKey,
      workspace_key: issue.workspaceKey,
    };
  }
  if (target.kind === "admin") {
    validateJsonObject(target, {
      allowedKeys: ["kind", "section"],
      requiredKeys: ["kind", "section"],
    });
    requireOwnerControl(auth, true);
    if (typeof target.section !== "string" || !ADMIN_SECTIONS.has(target.section)) {
      throw validationError("schema_validation_failed", { field: "section" });
    }
    return { entry_path: "/app/admin", kind: "admin", section: target.section };
  }
  throw validationError("schema_validation_failed", { field: "target.kind" });
}

async function verifyResolvedLaunchTarget(
  db: D1Database,
  auth: BearerAuthContext,
  target: LaunchTarget,
): Promise<void> {
  if (target.kind === "admin") {
    requireOwnerControl(auth, true);
    return;
  }
  if (target.kind === "project") {
    const project = await requireProjectAuthorization(
      db,
      auth,
      target.workspace_key,
      target.project_key,
    );
    if (project.projectId !== target.project_id) throw notFound();
    return;
  }
  const issue = await requireCollaborationIssue(db, auth, target.identifier);
  if (issue.id !== target.issue_id || issue.projectId !== target.project_id) throw notFound();
}

const launchTargetGuardSql = `(
  (launch.target_kind = 'admin' AND EXISTS (
    SELECT 1 FROM instance_meta target_instance
    WHERE target_instance.singleton = 1
      AND target_instance.owner_principal_id = launch.principal_id
  ))
  OR
  (launch.target_kind IN ('project', 'issue') AND EXISTS (
    SELECT 1
    FROM projects target_project
    JOIN workspaces target_workspace ON target_workspace.id = target_project.workspace_id
    JOIN instance_meta target_instance ON target_instance.singleton = 1
    WHERE target_project.id = json_extract(launch.target_json, '$.project_id')
      AND target_project.deleted_at IS NULL
      AND target_workspace.deleted_at IS NULL
      AND (
        target_instance.owner_principal_id = launch.principal_id
        OR EXISTS (
          SELECT 1 FROM project_grants target_grant
          WHERE target_grant.project_id = target_project.id
            AND target_grant.principal_id = launch.principal_id
            AND target_grant.revoked_at IS NULL
        )
      )
      AND (launch.target_kind != 'issue' OR EXISTS (
        SELECT 1 FROM issues target_issue
        WHERE target_issue.id = json_extract(launch.target_json, '$.issue_id')
          AND target_issue.project_id = target_project.id
          AND target_issue.deleted_at IS NULL
      ))
  ))
)`;

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

function launchResource(
  snapshot: LaunchOperationSnapshot,
  secretAvailable: boolean,
): { [key: string]: JsonValue } {
  return {
    created_at: timestamp(snapshot.row.created_at),
    expires_at: timestamp(snapshot.row.expires_at),
    id: snapshot.row.id,
    secret_available: secretAvailable,
    target: snapshot.target,
  };
}

async function createLaunchBatch(
  db: D1Database,
  auth: BearerAuthContext,
  operationId: string,
  launchId: string,
  codePrefix: string,
  codeDigest: string,
  target: LaunchTarget,
  now: number,
): Promise<OperationCommit> {
  const targetJson = JSON.stringify(target);
  const guard = buildCurrentAuthGuard(auth, now, 11);
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `INSERT INTO browser_launches
            (id, code_prefix, code_digest, principal_id, source_credential_id,
             target_kind, target_json, expires_at, created_at, created_operation_id,
             last_operation_id)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
           WHERE ${guard.sql}
             AND (
               (?6 = 'admin' AND EXISTS (
                 SELECT 1 FROM instance_meta target_instance
                 WHERE target_instance.singleton = 1
                   AND target_instance.owner_principal_id = ?4
               ))
               OR
               (?6 IN ('project', 'issue') AND EXISTS (
                 SELECT 1
                 FROM projects target_project
                 JOIN workspaces target_workspace ON target_workspace.id = target_project.workspace_id
                 JOIN instance_meta target_instance ON target_instance.singleton = 1
                 WHERE target_project.id = json_extract(?7, '$.project_id')
                   AND target_project.deleted_at IS NULL
                   AND target_workspace.deleted_at IS NULL
                   AND (
                     target_instance.owner_principal_id = ?4
                     OR EXISTS (
                       SELECT 1 FROM project_grants target_grant
                       WHERE target_grant.project_id = target_project.id
                         AND target_grant.principal_id = ?4
                         AND target_grant.revoked_at IS NULL
                     )
                   )
                   AND (?6 != 'issue' OR EXISTS (
                     SELECT 1 FROM issues target_issue
                     WHERE target_issue.id = json_extract(?7, '$.issue_id')
                       AND target_issue.project_id = target_project.id
                       AND target_issue.deleted_at IS NULL
                   ))
               ))
             )`,
        ).bind(
          launchId,
          codePrefix,
          codeDigest,
          auth.principalId,
          auth.credentialId,
          target.kind,
          targetJson,
          now + BROWSER_LAUNCH_LIFETIME_MS,
          now,
          operationId,
          ...guard.values,
        ),
        db.prepare(
          `UPDATE idempotency_records
           SET operation_snapshot_json = (
             SELECT json_object(
               'code_digest', launch.code_digest,
               'target', json(launch.target_json),
               'row', json_object(
                 'code_digest', launch.code_digest,
                 'code_prefix', launch.code_prefix,
                 'created_at', launch.created_at,
                 'expires_at', launch.expires_at,
                 'id', launch.id,
                 'last_operation_id', launch.last_operation_id,
                 'principal_id', launch.principal_id,
                 'redeemed_at', launch.redeemed_at,
                 'revoked_at', launch.revoked_at,
                 'source_credential_id', launch.source_credential_id,
                 'target_json', launch.target_json,
                 'target_kind', launch.target_kind
               )
             )
             FROM browser_launches launch
             WHERE launch.id = ?1 AND launch.last_operation_id = ?2
           )
           WHERE operation_id = ?2 AND state = 'pending'`,
        ).bind(launchId, operationId),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'web-launch.created', ?2, 0, ?3, ?4, ?5,
                  'browser_launch', launch.id,
                  json_object('target_kind', launch.target_kind), ?6
           FROM browser_launches launch
           WHERE launch.id = ?7 AND launch.last_operation_id = ?2`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          auth.principalId,
          auth.credentialId,
          authorizedVia(auth),
          now,
          launchId,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        try {
          await verifyCurrentAuth(db, auth, now);
          await verifyResolvedLaunchTarget(db, auth, target);
          return false;
        } catch (error) {
          if (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE") return true;
          throw error;
        }
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: launchId,
      primarySubjectType: "browser_launch",
      requireIdempotencySnapshot: true,
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      await verifyResolvedLaunchTarget(db, auth, target);
    }
    throw error;
  }
}

export async function createWebLaunch(
  db: D1Database,
  request: Request,
  auth: BearerAuthContext,
  targetValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const target = await resolveLaunchTarget(db, auth, targetValue);
  const identity = {
    idempotencyKey: requireIdempotencyKey(request),
    method: "POST",
    normalizedResourceScope: `web-launch:${target.kind}:${target.kind === "admin" ? target.section : target.project_id}`,
    requestBody: { target },
    routeTemplate: "/api/v1/web-launches",
    scopeKey: `principal:${auth.principalId}`,
  };
  await verifyCurrentAuth(db, auth, now);
  const claim = await claimIdempotency(db, identity, now);
  if (claim.state === "committed") {
    await verifyCurrentAuth(db, auth, now);
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
  let generatedOrigin: string | null = null;
  if (commit === null) {
    try {
      generatedOrigin = await preferredOrigin(db);
    } catch (error) {
      await abandonOwnedPendingClaim(db, claim);
      throw error;
    }
    const launchId = crypto.randomUUID();
    const generated = generateLaunchCode();
    generatedCode = generated.code;
    generatedDigest = await sha256Hex(generated.code);
    try {
      commit = await createLaunchBatch(
        db,
        auth,
        claim.operationId,
        launchId,
        generated.prefix,
        generatedDigest,
        target,
        now,
      );
    } catch (error) {
      commit = await probeOperationCommit(db, claim.operationId);
      if (commit === null) {
        await abandonOwnedPendingClaim(db, claim);
        throw error;
      }
    }
  }
  if (commit === null) throw new AtomicBatchRejectedError();
  await verifyCurrentAuth(db, auth, now);
  let snapshot: LaunchOperationSnapshot;
  try {
    snapshot = await readOperationSnapshot<LaunchOperationSnapshot>(db, claim.operationId);
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const peer = await readFinalizedIdempotencyResponse<{ [key: string]: JsonValue }>(db, claim.operationId);
      if (peer !== null) return { ...peer.body, idempotent_replay: true };
    }
    throw error;
  }
  const safeBody = await writeResult(
    db,
    auth,
    launchResource(snapshot, false),
    commit.lastEventSequence,
    false,
  );
  if (
    generatedCode === null
    || generatedDigest !== snapshot.code_digest
    || generatedOrigin === null
  ) {
    return { ...safeBody, idempotent_replay: true };
  }
  const finalized = await finalizeIdempotency(
    db,
    claim.operationId,
    { body: safeBody, status: 200 },
    [generatedCode],
    now,
  );
  const launchUrl = `${generatedOrigin}/app/launch?code=${encodeURIComponent(generatedCode)}`;
  return {
    ...finalized.body,
    idempotent_replay: false,
    resource: {
      ...(finalized.body.resource as { [key: string]: JsonValue }),
      launch_url: launchUrl,
      secret_available: true,
    },
  };
}

async function readLaunchByDigest(db: D1Database, digest: string): Promise<BrowserLaunchRow | null> {
  try {
    return await db.prepare(
      `SELECT id, code_prefix, code_digest, principal_id, source_credential_id,
              target_kind, target_json, expires_at, redeemed_at, revoked_at,
              created_at, last_operation_id
       FROM browser_launches WHERE code_digest = ?1 LIMIT 1`,
    ).bind(digest).first<BrowserLaunchRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

function launchIsActive(row: BrowserLaunchRow | null, now: number): row is BrowserLaunchRow {
  return row !== null
    && row.redeemed_at === null
    && row.revoked_at === null
    && row.expires_at > now;
}

async function launchCanRedeem(
  db: D1Database,
  launch: BrowserLaunchRow,
  now: number,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS redeemable
     FROM browser_launches AS launch
     WHERE launch.id = ?1 AND launch.code_digest = ?2
       AND launch.redeemed_at IS NULL AND launch.revoked_at IS NULL
       AND launch.expires_at > ?3
       AND EXISTS (
         SELECT 1 FROM credentials source
         WHERE source.id = launch.source_credential_id
           AND source.principal_id = launch.principal_id
           AND source.revoked_at IS NULL
       )
       AND ${launchTargetGuardSql}
     LIMIT 1`,
  ).bind(launch.id, launch.code_digest, now).first();
  return row !== null;
}

export async function assertWebLaunchPageAvailable(
  db: D1Database,
  codeValue: JsonValue,
  now: number,
): Promise<void> {
  const code = requireLaunchCode(codeValue);
  const row = await readLaunchByDigest(db, await sha256Hex(code));
  if (!launchIsActive(row, now)) throw launchUnavailable();
  try {
    const source = await db.prepare(
      `SELECT 1 AS active FROM credentials
       WHERE id = ?1 AND principal_id = ?2 AND revoked_at IS NULL`,
    ).bind(row.source_credential_id, row.principal_id).first();
    if (source === null) throw launchUnavailable();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1");
  }
}

function sessionSnapshotResource(
  snapshot: SessionOperationSnapshot,
  cookieAvailable: boolean,
): { [key: string]: JsonValue } {
  return {
    allowed_scope: snapshot.target.kind === "admin"
      ? { kind: "instance" }
      : snapshot.target.kind === "project_selection"
        ? { kind: "project_selection" }
        : { kind: "project", project_id: snapshot.target.project_id },
    cookie_available: cookieAvailable,
    entry_path: snapshot.entry_path,
    expires_at: timestamp(snapshot.expires_at),
    principal: {
      display_name: snapshot.display_name,
      id: snapshot.principal_id,
      is_owner: snapshot.is_owner,
    },
    session_id: snapshot.session_id,
    source: { id: snapshot.source_id, kind: snapshot.source_kind },
    target: snapshot.target,
  };
}

async function redeemLaunchBatch(
  db: D1Database,
  operationId: string,
  launch: BrowserLaunchRow,
  sessionId: string,
  sessionTokenDigest: string,
  csrfDigest: string,
  now: number,
): Promise<OperationCommit> {
  const target = launchTargetFromRow(launch);
  const entryPath = target.entry_path;
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE browser_launches AS launch
           SET redeemed_at = ?1, last_operation_id = ?2
           WHERE launch.id = ?3 AND launch.code_digest = ?4
             AND launch.redeemed_at IS NULL AND launch.revoked_at IS NULL
             AND launch.expires_at > ?1
             AND EXISTS (
               SELECT 1 FROM credentials source
               WHERE source.id = launch.source_credential_id
                 AND source.principal_id = launch.principal_id
                 AND source.revoked_at IS NULL
             )
             AND ${launchTargetGuardSql}`,
        ).bind(now, operationId, launch.id, launch.code_digest),
        db.prepare(
          `INSERT INTO web_sessions
            (id, token_digest, principal_id, source_kind, source_id, target_kind,
             target_json, expires_at, created_at, created_operation_id,
             last_operation_id)
           SELECT ?1, ?2, launch.principal_id, 'credential', launch.source_credential_id,
                  launch.target_kind, launch.target_json, ?3, ?4, ?5, ?5
           FROM browser_launches launch
           WHERE launch.id = ?6 AND launch.last_operation_id = ?5`,
        ).bind(
          sessionId,
          sessionTokenDigest,
          now + WEB_SESSION_LIFETIME_MS,
          now,
          operationId,
          launch.id,
        ),
        db.prepare(
          `UPDATE idempotency_records
           SET operation_snapshot_json = (
             SELECT json_object(
               'csrf_digest', ?1,
               'display_name', principal.display_name,
               'entry_path', ?2,
               'expires_at', session.expires_at,
               'is_owner', CASE WHEN instance.owner_principal_id = session.principal_id THEN 1 ELSE 0 END,
               'principal_id', session.principal_id,
               'session_id', session.id,
               'session_token_digest', session.token_digest,
               'source_id', session.source_id,
               'source_kind', session.source_kind,
               'target', json(session.target_json)
             )
             FROM web_sessions session
             JOIN principals principal ON principal.id = session.principal_id
             JOIN instance_meta instance ON instance.singleton = 1
             WHERE session.id = ?3 AND session.created_operation_id = ?4
           )
           WHERE operation_id = ?4 AND state = 'pending'`,
        ).bind(csrfDigest, entryPath, sessionId, operationId),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'web-session.created', ?2, 0,
                  session.principal_id, session.source_id, 'browser_launch',
                  'web_session', session.id,
                  json_object('source_kind', session.source_kind, 'target_kind', session.target_kind), ?3
           FROM web_sessions session
           WHERE session.id = ?4 AND session.created_operation_id = ?2`,
        ).bind(crypto.randomUUID(), operationId, now, sessionId),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        return !(await launchCanRedeem(db, launch, now));
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: sessionId,
      primarySubjectType: "web_session",
      requireIdempotencySnapshot: true,
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) throw launchUnavailable();
    throw error;
  }
}

export async function redeemWebLaunch(
  db: D1Database,
  request: Request,
  codeValue: JsonValue,
  now: number,
): Promise<SessionExchangeResult> {
  const code = requireLaunchCode(codeValue);
  const codeDigest = await sha256Hex(code);
  const identity = {
    idempotencyKey: requireIdempotencyKey(request),
    method: "POST",
    normalizedResourceScope: `browser-launch:${codeDigest}`,
    requestBody: { launch_code: code },
    routeTemplate: "/api/v1/web-sessions/redeem",
    scopeKey: `browser-launch:${codeDigest}`,
  };
  const claim = await claimIdempotency(db, identity, now, [code]);
  if (claim.state === "committed") {
    const stored = readIdempotencyResponse<{ [key: string]: JsonValue }>(claim);
    return {
      body: {
        ...stored.body,
        idempotent_replay: true,
        resource: {
          ...(stored.body.resource as { [key: string]: JsonValue }),
          cookie_available: false,
        },
      },
      csrfToken: null,
      sessionToken: null,
    };
  }

  let commit = await probeOperationCommit(db, claim.operationId);
  let generatedSessionToken: string | null = null;
  let generatedCsrfToken: string | null = null;
  let generatedSessionDigest: string | null = null;
  let generatedCsrfDigest: string | null = null;
  if (commit === null) {
    const launch = await readLaunchByDigest(db, codeDigest);
    if (!launchIsActive(launch, now)) {
      await abandonOwnedPendingClaim(db, claim);
      throw launchUnavailable();
    }
    generatedSessionToken = randomBase64Url(32);
    generatedCsrfToken = randomBase64Url(32);
    [generatedSessionDigest, generatedCsrfDigest] = await Promise.all([
      sha256Hex(generatedSessionToken),
      sha256Hex(generatedCsrfToken),
    ]);
    try {
      commit = await redeemLaunchBatch(
        db,
        claim.operationId,
        launch,
        crypto.randomUUID(),
        generatedSessionDigest,
        generatedCsrfDigest,
        now,
      );
    } catch (error) {
      commit = await probeOperationCommit(db, claim.operationId);
      if (commit === null) {
        await abandonOwnedPendingClaim(db, claim);
        throw error;
      }
    }
  }
  if (commit === null) throw new AtomicBatchRejectedError();
  let snapshot: SessionOperationSnapshot;
  try {
    snapshot = await readOperationSnapshot<SessionOperationSnapshot>(db, claim.operationId);
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const peer = await readFinalizedIdempotencyResponse<{ [key: string]: JsonValue }>(db, claim.operationId);
      if (peer !== null) {
        return { body: { ...peer.body, idempotent_replay: true }, csrfToken: null, sessionToken: null };
      }
    }
    throw error;
  }
  const safeBody = {
    event_cursor: await eventCursor(
      db,
      { principalId: snapshot.principal_id },
      commit.lastEventSequence,
    ),
    idempotent_replay: false,
    resource: sessionSnapshotResource(snapshot, false),
  };
  if (
    generatedSessionToken === null
    || generatedCsrfToken === null
    || generatedSessionDigest !== snapshot.session_token_digest
    || generatedCsrfDigest !== snapshot.csrf_digest
  ) {
    return { body: { ...safeBody, idempotent_replay: true }, csrfToken: null, sessionToken: null };
  }
  const finalized = await finalizeIdempotency(
    db,
    claim.operationId,
    { body: safeBody, status: 200 },
    [code, generatedSessionToken, generatedCsrfToken],
    now,
  );
  return {
    body: {
      ...finalized.body,
      resource: sessionSnapshotResource(snapshot, true),
    },
    csrfToken: generatedCsrfToken,
    sessionToken: generatedSessionToken,
  };
}

function visibleScopeResource(projects: Awaited<ReturnType<typeof resolveVisibleProjects>>): JsonValue {
  return projects.map((project) => ({
    project_id: project.projectId,
    project_key: project.projectKey,
    role: project.role,
    workspace_key: project.workspaceKey,
  }));
}

export async function getWebSession(
  db: D1Database,
  auth: CookieAuthContext,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  // This is the response's authorization point: the same D1 statement that
  // reads Grants and parent-container state also verifies the Session/source.
  const projects = await resolveCurrentVisibleProjects(db, auth, now);
  if (auth.targetKind !== "project_selection" && auth.targetKind !== "admin" && projects.length === 0) {
    throw notFound();
  }
  if (auth.targetKind === "admin" && !auth.isOwner) throw forbidden();
  return {
    allowed_scope: auth.targetKind === "admin"
      ? { kind: "instance", projects: visibleScopeResource(projects) }
      : { kind: auth.targetKind === "project_selection" ? "project_selection" : "project", projects: visibleScopeResource(projects) },
    expires_at: timestamp(auth.sessionExpiresAt),
    principal: {
      display_name: auth.displayName,
      id: auth.principalId,
      is_owner: auth.isOwner,
      version: auth.principalVersion,
    },
    session_id: auth.sessionId,
    source: { id: auth.sourceId, kind: auth.sourceKind },
    target: { kind: auth.targetKind, ...auth.target },
  };
}

export async function revokeWebSession(
  db: D1Database,
  auth: CookieAuthContext,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 5);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE web_sessions
           SET revoked_at = ?1, last_operation_id = ?2
           WHERE id = ?3 AND principal_id = ?4 AND revoked_at IS NULL
             AND ${guard.sql}`,
        ).bind(now, operationId, auth.sessionId, auth.principalId, ...guard.values),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'web-session.revoked', ?2, 0, ?3, ?4, ?5,
                  'web_session', id, '{}', ?6
           FROM web_sessions WHERE id = ?7 AND last_operation_id = ?2`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          auth.principalId,
          actorCredentialId(auth),
          authorizedVia(auth),
          now,
          auth.sessionId,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        try {
          await verifyCurrentAuth(db, auth, now);
          return false;
        } catch (error) {
          if (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE") return true;
          throw error;
        }
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: auth.sessionId,
      primarySubjectType: "web_session",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) throw unauthorized();
    throw error;
  }
  return writeResult(
    db,
    auth,
    {
      id: auth.sessionId,
      revoked_at: timestamp(now),
      source: { id: auth.sourceId, kind: auth.sourceKind },
    },
    commit.lastEventSequence,
    false,
  );
}

export const WEB_LAUNCH_PAGE_SCRIPT = `(()=>{const status=document.querySelector("[data-launch-status]");const zh=(navigator.languages||[navigator.language||""]).some((value)=>String(value).toLowerCase().startsWith("zh"));const set=(message)=>{if(status)status.textContent=message};const params=new URLSearchParams(location.search);const code=params.get("code");history.replaceState({},document.title,"/app/launch");if(!code){set(zh?"打开链接无效，请让 Agent 重新生成。":"This launch link is invalid. Ask your Agent for a new one.");return}set(zh?"正在安全建立会话…":"Securely establishing your session…");fetch("/api/v1/web-sessions/redeem",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({launch_code:code})}).then(async(response)=>{const body=await response.json().catch(()=>null);if(!response.ok||!body||typeof body!=="object")throw new Error();const entry=body.resource&&body.resource.entry_path;if(typeof entry!=="string"||!entry.startsWith("/app"))throw new Error();location.replace(entry)}).catch(()=>set(zh?"会话未建立，请让 Agent 重新生成链接。":"The session was not established. Ask your Agent for a new link."))})()`;

let webLaunchPageScriptHash: Promise<string> | null = null;

async function webLaunchScriptSource(): Promise<string> {
  webLaunchPageScriptHash ??= crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(WEB_LAUNCH_PAGE_SCRIPT),
  ).then((digest) => {
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return `sha256-${btoa(binary)}`;
  });
  return webLaunchPageScriptHash;
}

export async function webLaunchPageContentSecurityPolicy(): Promise<string> {
  return `default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; script-src '${await webLaunchScriptSource()}'`;
}

export function webLaunchBootstrapHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cfKanban</title></head><body><main><h1>cfKanban</h1><p data-launch-status aria-live="polite">Securely establishing your session…</p><noscript>This page requires JavaScript. Ask your Agent for a new Browser Launch after enabling it.</noscript></main><script>${WEB_LAUNCH_PAGE_SCRIPT}</script></body></html>`;
}
