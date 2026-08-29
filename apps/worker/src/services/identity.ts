import { requireDisplayName, requireHttpsOrigin, timestamp } from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  reauthenticateOwner,
  requireOwnerControl,
  resolveVisibleProjects,
  verifyCurrentAuth,
} from "../kernel/authorization.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import { ApiError, notFound, platformUnavailable, versionConflict } from "../kernel/errors.ts";
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
    throw platformUnavailable("d1");
  }
}

async function readPrincipal(db: D1Database, principalId: string): Promise<PrincipalRow | null> {
  try {
    return await db.prepare(
      `SELECT id, display_name, version, created_at, updated_at
       FROM principals WHERE id = ?1 LIMIT 1`,
    ).bind(principalId).first<PrincipalRow>();
  } catch {
    throw platformUnavailable("d1");
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
  } catch {
    throw platformUnavailable("d1");
  }
}

function principalResource(row: PrincipalRow, extras: Record<string, JsonValue> = {}): { [key: string]: JsonValue } {
  return {
    created_at: timestamp(row.created_at),
    deleted_at: null,
    display_name: row.display_name,
    id: row.id,
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
  const instance = await readInstance(db);
  return {
    discovery_version: 1,
    instance_id: instance.instance_id,
    observed_origin: observedOrigin,
    origin_version: instance.origin_version,
    preferred_api_origin: instance.preferred_api_origin,
    service_version: instance.service_version,
    updated_at: timestamp(instance.origin_updated_at),
  };
}

export async function getMeta(
  db: D1Database,
  auth: AuthContext,
  observedOrigin: string,
): Promise<{ [key: string]: JsonValue }> {
  const [instance, projects] = await Promise.all([
    readInstance(db),
    resolveVisibleProjects(db, auth),
  ]);
  const workspaceIds = [...new Set(projects.map((project) => project.workspaceId))];
  return {
    capabilities: {
      browser_launch: true,
      fixed_workflow: true,
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
    visible_scope: {
      project_count: projects.length,
      projects: projects.map((project) => ({
        project_id: project.projectId,
        project_key: project.projectKey,
        role: project.role,
        workspace_key: project.workspaceKey,
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
      project_key: project.projectKey,
      role: project.role,
      workspace_key: project.workspaceKey,
    })),
    is_owner: auth.isOwner,
    principal_id: principal.id,
  });
}

export async function updateMe(
  db: D1Database,
  auth: AuthContext,
  displayName: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const normalizedName = requireDisplayName(displayName);
  const current = await readPrincipal(db, auth.principalId);
  if (current === null) throw notFound();
  const updated: PrincipalRow = {
    ...current,
    display_name: normalizedName,
    updated_at: now,
    version: current.version + 1,
  };
  const operationId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 6);
  const statements = [
    db.prepare(
      `UPDATE principals
       SET display_name = ?1, version = version + 1, updated_at = ?2, last_operation_id = ?3
       WHERE id = ?4 AND version = ?5 AND ${guard.sql}`,
    ).bind(normalizedName, now, operationId, auth.principalId, expectedVersion, ...guard.values),
    db.prepare(
      `INSERT INTO events
        (id, stream, type, operation_id, event_index, actor_principal_id,
         actor_credential_id, authorized_via, subject_type, subject_id,
         payload_json, created_at)
       SELECT ?1, 'security', 'principal.display-name-updated', ?2, 0, ?3, ?4,
              ?5, 'principal', id, ?6, ?7
       FROM principals WHERE id = ?3 AND last_operation_id = ?2`,
    ).bind(
      eventId,
      operationId,
      auth.principalId,
      actorCredentialId(auth),
      authorizedVia(auth),
      JSON.stringify({ display_name: normalizedName }),
      now,
    ),
  ];

  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: statements,
      committedAt: now,
      confirmBusinessRejection: async () => {
        const current = await readPrincipal(db, auth.principalId);
        return current === null || current.version !== expectedVersion
          || await authGuardRejected(db, auth, now);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: auth.principalId,
      primarySubjectType: "principal",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const current = await readPrincipal(db, auth.principalId);
      if (current === null) throw notFound();
      throw versionConflict(current.version);
    }
    throw error;
  }
  return writeResult(
    db,
    auth,
    principalResource(updated, { principal_id: updated.id }),
    commit.lastEventSequence,
    false,
  );
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
