import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths, loadPendingCredentialSecret } from "./state.mjs";
import { atomicWritePrivateText, requireHttpsOrigin, requireString, requireUuid } from "./utils.mjs";

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function writeOwnerBootstrapSql({
  stateRoot = resolveStateRoot(),
  instanceId,
  ownerDisplayName,
  ownerPrincipalId,
  preferredApiOrigin,
  serviceVersion,
  schemaVersion,
  outputPath = null,
}) {
  const { metadata } = await loadPendingCredentialSecret({ stateRoot, instanceId });
  const paths = getInstancePaths({ stateRoot, instanceId });
  const operationId = requireUuid(metadata.operation_id, "operation_id");
  const eventId = crypto.randomUUID();
  const now = Date.now();
  const principalId = requireUuid(ownerPrincipalId, "owner_principal_id");
  const instance = requireUuid(instanceId, "instance_id");
  const credentialId = requireUuid(metadata.credential_id, "credential_id");
  const displayName = requireString(ownerDisplayName, "owner_display_name", { max: 128 }).trim();
  const origin = requireHttpsOrigin(preferredApiOrigin, "preferred_api_origin");
  const version = requireString(serviceVersion, "service_version", { max: 128 });
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new TypeError("schemaVersion must be a positive integer");
  const payload = JSON.stringify({
    origin_version: 1,
    owner_display_name: displayName,
    preferred_api_origin: origin,
    schema_version: schemaVersion,
    service_version: version,
  });
  const statements = [
    "PRAGMA foreign_keys = ON;",
    `INSERT INTO principals (id, display_name, version, created_at, updated_at, last_operation_id) VALUES (${sql(principalId)}, ${sql(displayName)}, 1, ${now}, ${now}, ${sql(operationId)});`,
    `INSERT INTO instance_meta (singleton, instance_id, owner_principal_id, service_version, schema_version, created_at) VALUES (1, ${sql(instance)}, ${sql(principalId)}, ${sql(version)}, ${schemaVersion}, ${now});`,
    `INSERT INTO instance_origin_settings (singleton, preferred_api_origin, version, updated_at, updated_by_principal_id, last_operation_id) VALUES (1, ${sql(origin)}, 1, ${now}, ${sql(principalId)}, ${sql(operationId)});`,
    `INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id, last_operation_id) VALUES (${sql(credentialId)}, ${sql(principalId)}, ${sql(metadata.token_prefix)}, ${sql(metadata.token_digest)}, ${now}, ${sql(operationId)}, ${sql(operationId)});`,
    `INSERT INTO events (id, stream, type, operation_id, event_index, actor_principal_id, actor_credential_id, authorized_via, subject_type, subject_id, payload_json, created_at) VALUES (${sql(eventId)}, 'security', 'instance.bootstrapped', ${sql(operationId)}, 0, ${sql(principalId)}, ${sql(credentialId)}, 'deployment_recovery', 'instance', ${sql(instance)}, ${sql(payload)}, ${now});`,
    `INSERT INTO operation_commits (operation_id, primary_subject_type, primary_subject_id, last_event_sequence, committed_at) SELECT ${sql(operationId)}, 'instance', ${sql(instance)}, sequence, ${now} FROM events WHERE operation_id = ${sql(operationId)} AND event_index = 0;`,
    "",
  ];
  const filePath = outputPath || path.join(paths.journalsRoot, `${operationId}.owner-bootstrap.sql`);
  await atomicWritePrivateText(filePath, statements.join("\n"));
  return {
    operation_id: operationId,
    bootstrap_sql_path: filePath,
    owner_principal_id: principalId,
    credential_id: credentialId,
    credential_fingerprint: metadata.fingerprint,
    contains_plaintext_credential: false,
    relies_on_wrangler_file_ingestion_transaction: true,
  };
}
