import { readHomepageSettings } from "./homepage-settings.ts";
import { RELEASE_VERSION } from "../release-version.ts";
import { principalDisplayNameExists, principalDisplayNameConflict } from "./principal-names.ts";
import { managementGrantsResource } from "./scoped-administrators.ts";
import { principalDisplayNameKey, requirePrincipalDisplayName, requireHttpsOrigin, timestamp } from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  reauthenticateOwner,
  requireOwnerControl,
  resolveVisibleProjects,
  verifyCurrentAuth,
} from "../kernel/authorization.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import { ApiError, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import {
  operationSnapshotStatement,
  readOperationSnapshot,
  runIdempotentOperation,
} from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { actorCredentialId, authorizedVia, requireIdempotencyKey, writeResult } from "./shared.ts";

interface InstanceRow {
  created_at: number;
  instance_id: string;
  origin_updated_at: number;
  origin_updated_by_principal_id: string;
  origin_last_operation_id: string | null;
  origin_version: number;
  owner_principal_id: string;
  preferred_api_origin: string;
  schema_version: number;
  service_version: string;
}

interface PrincipalRow {
  created_at: number;
  display_name: string;
  id: string;
  locale: "en" | "zh-CN" | null;
  theme: "orange" | "blue";
  updated_at: number;
  version: number;
}

async function readInstance(db: D1Database): Promise<InstanceRow> {
  try {
    const row = await db.prepare(
      `SELECT im.instance_id, im.owner_principal_id, im.service_version, im.schema_version,
              im.created_at, ios.preferred_api_origin, ios.version AS origin_version,
              ios.updated_at AS origin_updated_at,
              ios.updated_by_principal_id AS origin_updated_by_principal_id,
              ios.last_operation_id AS origin_last_operation_id
       FROM instance_meta AS im
       JOIN instance_origin_settings AS ios ON ios.singleton = 1
       WHERE im.singleton = 1
       LIMIT 1`,
    ).first<InstanceRow>();
    if (row === null) throw notFound();
    return row;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}

async function readPrincipal(db: D1Database, principalId: string): Promise<PrincipalRow | null> {
  try {
    return await db.prepare(
      `SELECT id, display_name, locale, theme, version, created_at, updated_at
       FROM principals WHERE id = ?1 LIMIT 1`,
    ).bind(principalId).first<PrincipalRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function authGuardRejected(
  db: D1Database,
  auth: AuthContext,
  now: number,
  ownerOnly = false,
): Promise<boolean> {
  const guard = buildCurrentAuthGuard(auth, now, 1, ownerOnly);
  try {
    return await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first() === null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function principalResource(row: PrincipalRow, extras: Record<string, JsonValue> = {}): { [key: string]: JsonValue } {
  return {
    created_at: timestamp(row.created_at),
    deleted_at: null,
    display_name: row.display_name,
    id: row.id,
    locale: row.locale,
    theme: row.theme,
    updated_at: timestamp(row.updated_at),
    version: row.version,
    ...extras,
  };
}

function instanceOriginResource(row: InstanceRow, observedOrigin: string): { [key: string]: JsonValue } {
  return {
    created_at: timestamp(row.created_at),
    deleted_at: null,
    id: row.instance_id,
    observed_origin: observedOrigin,
    preferred_api_origin: row.preferred_api_origin,
    updated_at: timestamp(row.origin_updated_at),
    updated_by_principal_id: row.origin_updated_by_principal_id,
    version: row.origin_version,
  };
}

export async function getInstanceDiscovery(
  db: D1Database,
  observedOrigin: string,
): Promise<{ [key: string]: JsonValue }> {
  const [instance, homepage] = await Promise.all([readInstance(db), readHomepageSettings(db)]);
  return {
    capabilities: { issue_reference: true, issue_search_index: true, project_milestones: true },
    homepage_notice: { en: homepage.notice_en, "zh-CN": homepage.notice_zh_cn },
    discovery_version: 1,
    instance_id: instance.instance_id,
    observed_origin: observedOrigin,
    origin_version: instance.origin_version,
    preferred_api_origin: instance.preferred_api_origin,
    service_version: instance.service_version,
    release_version: RELEASE_VERSION,
    updated_at: timestamp(instance.origin_updated_at),
  };
}

export async function getMeta(
  db: D1Database,
  auth: AuthContext,
  observedOrigin: string,
  attachmentsEnabled = false,
): Promise<{ [key: string]: JsonValue }> {
  const [instance, projects] = await Promise.all([
    readInstance(db),
    resolveVisibleProjects(db, auth),
  ]);
  const workspaceIds = [...new Set(projects.map((project) => project.workspaceId))];
  return {
    capabilities: {
      attachments: attachmentsEnabled,
      browser_launch: true,
      fixed_workflow: true,
      issue_reference: true,
      issue_search_index: true,
      project_milestones: true,
      passkey: true,
      public_join: true,
    },
    instance_id: instance.instance_id,
    observed_origin: observedOrigin,
    origin_version: instance.origin_version,
    preferred_api_origin: instance.preferred_api_origin,
    principal: {
      display_name: auth.displayName,
      id: auth.principalId,
      is_owner: auth.isOwner,
    },
    schema_version: instance.schema_version,
    service_version: instance.service_version,
    release_version: RELEASE_VERSION,
    visible_scope: {
      project_count: projects.length,
      projects: projects.map((project) => ({
        project_id: project.projectId,
        project_display_name: project.projectName,
        workspace_display_name: project.workspaceName,
        role: project.role,
        workspace_id: project.workspaceId,
      })),
      workspace_count: workspaceIds.length,
    },
  };
}

export async function getMe(db: D1Database, auth: AuthContext): Promise<{ [key: string]: JsonValue }> {
  const [principal, projects] = await Promise.all([
    readPrincipal(db, auth.principalId),
    resolveVisibleProjects(db, auth),
  ]);
  if (principal === null) throw notFound();
  return principalResource(principal, {
    allowed_actions: ["update_profile", ...(auth.isOwner ? ["manage_instance"] : [])],
    credential: auth.kind === "bearer"
      ? { fingerprint: auth.credentialFingerprint, id: auth.credentialId }
      : null,
    grants: projects.map((project) => ({
      project_id: project.projectId,
      project_display_name: project.projectName,
      workspace_display_name: project.workspaceName,
      role: project.role,
      workspace_id: project.workspaceId,
    })),
    is_owner: auth.isOwner,
    management_grants: managementGrantsResource(auth),
    principal_id: principal.id,
  });
}

export async function updateMe(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  input: { [key: string]: JsonValue },
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  if (!("display_name" in input) && !("theme" in input) && !("locale" in input)) throw validationError("profile_change_required");
  const changes: { display_name?: string; locale?: "en" | "zh-CN" | null; theme?: "orange" | "blue" } = {};
  if ("display_name" in input) changes.display_name = requirePrincipalDisplayName(input.display_name as JsonValue);
  if ("locale" in input) {
    if (input.locale !== null && input.locale !== "en" && input.locale !== "zh-CN") throw validationError("invalid_locale", { field: "locale" });
    changes.locale = input.locale;
  }
  if ("theme" in input) {
    if (input.theme !== "orange" && input.theme !== "blue") throw validationError("invalid_theme", { field: "theme" });
    changes.theme = input.theme;
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  const execute = async (operationId: string) => {
    const current = await readPrincipal(db, auth.principalId);
    if (current === null) throw notFound();
    const updated: PrincipalRow = { ...current, ...changes, updated_at: now, version: current.version + 1 };
    const resource = principalResource(updated, { principal_id: updated.id });
    const guard = buildCurrentAuthGuard(auth, now, 9);
    const statements = [
      db.prepare(
        `UPDATE principals
         SET display_name = ?1, display_name_key = ?6, theme = ?7, locale = ?8,
             version = version + 1, updated_at = ?2, last_operation_id = ?3
         WHERE id = ?4 AND version = ?5 AND ${guard.sql}`,
      ).bind(updated.display_name, now, operationId, auth.principalId, expectedVersion,
        principalDisplayNameKey(updated.display_name), updated.theme, updated.locale, ...guard.values),
      db.prepare(
        `INSERT INTO events
          (id, stream, type, operation_id, event_index, actor_principal_id,
           actor_credential_id, authorized_via, subject_type, subject_id,
           payload_json, created_at)
         SELECT ?1, 'security', ?8, ?2, 0, ?3, ?4,
                ?5, 'principal', id, ?6, ?7
         FROM principals WHERE id = ?3 AND last_operation_id = ?2`,
      ).bind(crypto.randomUUID(), operationId, auth.principalId, actorCredentialId(auth),
        authorizedVia(auth), JSON.stringify(changes), now,
        changes.theme === undefined && changes.locale === undefined ? "principal.display-name-updated" : "principal.profile-updated"),
    ];
    if (idempotencyKey !== null) statements.push(operationSnapshotStatement(db, operationId, resource));

    let commit: OperationCommit;
    try {
      ({ commit } = await executeAtomicBatch(db, {
        businessStatements: statements,
        committedAt: now,
        confirmBusinessRejection: async () => {
          const current = await readPrincipal(db, auth.principalId);
          return current === null || current.version !== expectedVersion
            || await principalDisplayNameExists(db, updated.display_name, auth.principalId)
            || await authGuardRejected(db, auth, now);
        },
        expectedEventCount: 1,
        operationId,
        primarySubjectId: auth.principalId,
        primarySubjectType: "principal",
        requireIdempotencySnapshot: idempotencyKey !== null,
      }));
    } catch (error) {
      if (error instanceof AtomicBatchRejectedError) {
        await verifyCurrentAuth(db, auth, now);
        const current = await readPrincipal(db, auth.principalId);
        if (current === null) throw notFound();
        if (current.version !== expectedVersion) throw versionConflict(current.version);
        if (await principalDisplayNameExists(db, updated.display_name, auth.principalId)) throw principalDisplayNameConflict();
        throw versionConflict(current.version);
      }
      throw error;
    }
    return { commit, resource };
  };
  if (idempotencyKey === null) {
    const { commit, resource } = await execute(crypto.randomUUID());
    return writeResult(db, auth, resource, commit.lastEventSequence, false);
  }
  const result = await runIdempotentOperation({
    authorize: () => verifyCurrentAuth(db, auth, now),
    db,
    execute: async (operationId) => { await execute(operationId); },
    idempotencyKey,
    method: "PATCH",
    normalizedResourceScope: `principal:${auth.principalId}`,
    now,
    readback: async (operationId, commit) => ({
      body: await writeResult(db, auth, await readOperationSnapshot<{ [key: string]: JsonValue }>(db, operationId), commit.lastEventSequence, false),
      status: 200,
    }),
    requestBody: { ...changes, expected_version: expectedVersion },
    routeTemplate: "/api/v1/me",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}

export async function getInstanceOrigin(
  db: D1Database,
  auth: AuthContext,
  observedOrigin: string,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  return instanceOriginResource(await readInstance(db), observedOrigin);
}

export async function updateInstanceOrigin(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  preferredOriginValue: JsonValue,
  expectedVersion: number,
  observedOrigin: string,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth, true);
  const preferredApiOrigin = requireHttpsOrigin(preferredOriginValue);
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      const current = await reauthenticateOwner(db, request, now, true);
      if (current.principalId !== auth.principalId) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const current = await readInstance(db);
      const updated: InstanceRow = {
        ...current,
        origin_last_operation_id: operationId,
        origin_updated_at: now,
        origin_updated_by_principal_id: auth.principalId,
        origin_version: current.origin_version + 1,
        preferred_api_origin: preferredApiOrigin,
      };
      const eventId = crypto.randomUUID();
      const guard = buildCurrentAuthGuard(auth, now, 6, true);
      const statements = [
        db.prepare(
          `UPDATE instance_origin_settings
           SET preferred_api_origin = ?1, version = version + 1, updated_at = ?2,
               updated_by_principal_id = ?3, last_operation_id = ?4
           WHERE singleton = 1 AND version = ?5
             AND ${guard.sql}`,
        ).bind(preferredApiOrigin, now, auth.principalId, operationId, expectedVersion, ...guard.values),
        operationSnapshotStatement(db, operationId, instanceOriginResource(updated, observedOrigin)),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'instance.preferred-origin-updated', ?2, 0, ?3, ?4,
                  'deployment_owner', 'instance', im.instance_id, ?5, ?6
           FROM instance_meta AS im
           JOIN instance_origin_settings AS ios ON ios.singleton = 1
           WHERE ios.last_operation_id = ?2`,
        ).bind(
          eventId,
          operationId,
          auth.principalId,
          actorCredentialId(auth),
          JSON.stringify({ observed_origin: observedOrigin, preferred_api_origin: preferredApiOrigin }),
          now,
        ),
      ];
      try {
        await executeAtomicBatch(db, {
          businessStatements: statements,
          committedAt: now,
          confirmBusinessRejection: async () => (await readInstance(db)).origin_version !== expectedVersion
            || await authGuardRejected(db, auth, now, true),
          expectedEventCount: 1,
          operationId,
          primarySubjectId: current.instance_id,
          primarySubjectType: "instance",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          await reauthenticateOwner(db, request, now, true);
          throw versionConflict((await readInstance(db)).origin_version);
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "PUT",
    normalizedResourceScope: "instance-origin",
    now,
    readback: async (operationId, commit) => {
      return {
        body: await writeResult(
          db,
          auth,
          await readOperationSnapshot<{ [key: string]: JsonValue }>(db, operationId),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    requestBody: {
      expected_version: expectedVersion,
      preferred_api_origin: preferredApiOrigin,
    },
    routeTemplate: "/api/v1/admin/instance-origin",
    scopeKey: `principal:${auth.principalId}`,
  });
  const body = result.body as { [key: string]: JsonValue };
  return { ...body, idempotent_replay: result.idempotentReplay };
}
