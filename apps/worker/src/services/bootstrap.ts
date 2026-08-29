import { requireCredentialToken, requireDisplayName, requireHttpsOrigin, requireUuid, timestamp } from "../domain/model.ts";
import { sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, probeOperationCommit } from "../kernel/d1.ts";
import { conflict, platformUnavailable, validationError } from "../kernel/errors.ts";

export interface BootstrapInstanceInput {
  instanceId: string;
  operationId: string;
  ownerCredentialId: string;
  ownerCredentialToken: string;
  ownerDisplayName: string;
  ownerPrincipalId: string;
  preferredApiOrigin: string;
  schemaVersion?: number;
  serviceVersion?: string;
}

export interface BootstrapInstanceResult {
  createdAt: string;
  credentialFingerprint: string;
  credentialId: string;
  instanceId: string;
  originVersion: number;
  ownerDisplayName: string;
  ownerPrincipalId: string;
  preferredApiOrigin: string;
  recovered: boolean;
  schemaVersion: number;
  serviceVersion: string;
}

interface BootstrapRow {
  created_at: number;
  credential_id: string;
  instance_id: string;
  origin_version: number;
  owner_display_name: string;
  owner_principal_id: string;
  preferred_api_origin: string;
  schema_version: number;
  service_version: string;
  token_prefix: string;
}

async function readBootstrapResult(db: D1Database): Promise<BootstrapRow | null> {
  try {
    return await db.prepare(
      `SELECT im.instance_id, im.owner_principal_id, im.service_version, im.schema_version,
              im.created_at, p.display_name AS owner_display_name,
              ios.preferred_api_origin, ios.version AS origin_version,
              c.id AS credential_id, c.token_prefix
       FROM instance_meta AS im
       JOIN principals AS p ON p.id = im.owner_principal_id
       JOIN instance_origin_settings AS ios ON ios.singleton = 1
       JOIN credentials AS c ON c.principal_id = im.owner_principal_id
         AND c.revoked_at IS NULL
       WHERE im.singleton = 1
       ORDER BY c.issued_at, c.id
       LIMIT 1`,
    ).first<BootstrapRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

function mapBootstrap(row: BootstrapRow, recovered: boolean): BootstrapInstanceResult {
  return {
    createdAt: timestamp(row.created_at) ?? new Date(0).toISOString(),
    credentialFingerprint: `cfk_v1_${row.token_prefix}_…`,
    credentialId: row.credential_id,
    instanceId: row.instance_id,
    originVersion: row.origin_version,
    ownerDisplayName: row.owner_display_name,
    ownerPrincipalId: row.owner_principal_id,
    preferredApiOrigin: row.preferred_api_origin,
    recovered,
    schemaVersion: row.schema_version,
    serviceVersion: row.service_version,
  };
}

export async function bootstrapInstance(
  db: D1Database,
  input: BootstrapInstanceInput,
  now = Date.now(),
): Promise<BootstrapInstanceResult> {
  const instanceId = requireUuid(input.instanceId, "instance_id");
  const operationId = requireUuid(input.operationId, "operation_id");
  const ownerPrincipalId = requireUuid(input.ownerPrincipalId, "owner_principal_id");
  const ownerCredentialId = requireUuid(input.ownerCredentialId, "owner_credential_id");
  const ownerDisplayName = requireDisplayName(input.ownerDisplayName, "owner_display_name");
  const preferredApiOrigin = requireHttpsOrigin(input.preferredApiOrigin);
  const credential = requireCredentialToken(input.ownerCredentialToken, "owner_credential_token");
  const serviceVersion = input.serviceVersion ?? "0.1.0";
  const schemaVersion = input.schemaVersion ?? 1;
  if (serviceVersion.trim().length === 0 || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw validationError("invalid_bootstrap_version");
  }

  const priorCommit = await probeOperationCommit(db, operationId);
  if (priorCommit !== null) {
    const existing = await readBootstrapResult(db);
    if (existing === null || existing.instance_id !== instanceId || existing.owner_principal_id !== ownerPrincipalId) {
      throw conflict("INSTANCE_ALREADY_INITIALIZED", "request_owner");
    }
    return mapBootstrap(existing, true);
  }

  const tokenDigest = await sha256Hex(credential.token);
  const eventId = crypto.randomUUID();
  const statements = [
    db.prepare(
      `INSERT INTO principals
        (id, display_name, version, created_at, updated_at, last_operation_id)
       SELECT ?1, ?2, 1, ?3, ?3, ?4
       WHERE NOT EXISTS (SELECT 1 FROM instance_meta WHERE singleton = 1)`,
    ).bind(ownerPrincipalId, ownerDisplayName, now, operationId),
    db.prepare(
      `INSERT INTO instance_meta
        (singleton, instance_id, owner_principal_id, service_version, schema_version, created_at)
       SELECT 1, ?1, ?2, ?3, ?4, ?5
       FROM principals
       WHERE id = ?2 AND last_operation_id = ?6`,
    ).bind(instanceId, ownerPrincipalId, serviceVersion, schemaVersion, now, operationId),
    db.prepare(
      `INSERT INTO instance_origin_settings
        (singleton, preferred_api_origin, version, updated_at, updated_by_principal_id, last_operation_id)
       SELECT 1, ?1, 1, ?2, ?3, ?4
       FROM instance_meta
       WHERE singleton = 1 AND instance_id = ?5 AND owner_principal_id = ?3`,
    ).bind(preferredApiOrigin, now, ownerPrincipalId, operationId, instanceId),
    db.prepare(
      `INSERT INTO credentials
        (id, principal_id, token_prefix, token_digest, issued_at,
         created_operation_id, last_operation_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
       FROM instance_meta
       WHERE singleton = 1 AND instance_id = ?7 AND owner_principal_id = ?2`,
    ).bind(ownerCredentialId, ownerPrincipalId, credential.prefix, tokenDigest, now, operationId, instanceId),
    db.prepare(
      `INSERT INTO events
        (id, stream, type, operation_id, event_index, actor_principal_id,
         actor_credential_id, authorized_via, subject_type, subject_id,
         payload_json, created_at)
       SELECT ?1, 'security', 'instance.bootstrapped', ?2, 0, ?3, ?4,
              'deployment_recovery', 'instance', ?5, ?6, ?7
       FROM credentials
       WHERE id = ?4 AND created_operation_id = ?2`,
    ).bind(
      eventId,
      operationId,
      ownerPrincipalId,
      ownerCredentialId,
      instanceId,
      JSON.stringify({ origin_version: 1, schema_version: schemaVersion, service_version: serviceVersion }),
      now,
    ),
  ];

  try {
    await executeAtomicBatch(db, {
      businessStatements: statements,
      committedAt: now,
      confirmBusinessRejection: async () => (await readBootstrapResult(db)) !== null,
      expectedEventCount: 1,
      operationId,
      primarySubjectId: instanceId,
      primarySubjectType: "instance",
    });
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      throw conflict("INSTANCE_ALREADY_INITIALIZED", "request_owner");
    }
    throw error;
  }

  const row = await readBootstrapResult(db);
  if (row === null) throw platformUnavailable("d1");
  return mapBootstrap(row, false);
}
