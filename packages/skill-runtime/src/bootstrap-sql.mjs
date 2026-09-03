import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import {
  createPendingCredential,
  getInstancePaths,
  loadPendingCredentialSecret,
} from "./state.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { reconcileMigrationState } from "./migrations.mjs";
import { toolError } from "./errors.mjs";
import {
  assertNoSymlinkPath,
  atomicWritePrivateText,
  canonicalDigest,
  readJson,
  requireHttpsOrigin,
  requireString,
  requireUuid,
  sha256Bytes,
} from "./utils.mjs";

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function absolutePath(value, name) {
  const candidate = requireString(value, name, { max: 4096 });
  if (!path.isAbsolute(candidate)) {
    throw toolError("ABSOLUTE_PATH_REQUIRED", `${name} must be an absolute path`, { field: name });
  }
  return path.normalize(candidate);
}

export function ownerDeploymentFacts(plan, instanceId, operationId) {
  const instance = requireUuid(instanceId, "instance_id");
  const operation = requireUuid(operationId, "operation_id");
  if (plan?.kind !== "strict_zero_deploy"
    || plan.target?.instance_id !== instance
    || plan.operation_id !== operation) {
    throw toolError("INVALID_DEPLOYMENT_PLAN", "Owner bootstrap does not match the frozen strict-zero plan", { instanceId, operationId });
  }
  return {
    instance,
    operation,
    principalId: requireUuid(plan.owner_bootstrap?.owner_principal_id, "owner_principal_id"),
    credentialId: requireUuid(plan.owner_bootstrap?.owner_credential_id, "owner_credential_id"),
    displayName: requireString(plan.owner_bootstrap?.owner_display_name, "owner_display_name", { max: 128 }).trim(),
  };
}

function matchingCredential(metadata, facts) {
  return metadata?.instance_id === facts.instance
    && metadata?.operation_id === facts.operation
    && metadata?.principal_id === facts.principalId
    && metadata?.credential_id === facts.credentialId
    && metadata?.purpose === "owner_bootstrap";
}

export async function prepareOwnerCredential({
  stateRoot = resolveStateRoot(),
  home,
  persistenceConfirmed = false,
  instanceId,
  operationId,
  taskId,
  plan,
}) {
  const facts = ownerDeploymentFacts(plan, instanceId, operationId);
  await assertJournalAuthorization({ stateRoot, instanceId: facts.instance, operationId: facts.operation, taskId, plan });
  const paths = getInstancePaths({ stateRoot, instanceId: facts.instance });
  const [current, pending] = await Promise.all([
    readJson(paths.currentMetadata, { allowMissing: true }),
    readJson(paths.pendingMetadata, { allowMissing: true }),
  ]);
  if (current !== null) {
    if (!matchingCredential(current, facts) || current.state !== "current") {
      throw toolError("STATE_IDENTITY_CONFLICT", "The instance already has a different current local Credential", { instanceId: facts.instance });
    }
    return {
      instance_id: facts.instance,
      operation_id: facts.operation,
      principal_id: facts.principalId,
      credential_id: facts.credentialId,
      credential_fingerprint: current.fingerprint,
      state: "current",
      secret_values_exposed: false,
    };
  }
  if (pending !== null) {
    if (!matchingCredential(pending, facts) || pending.state !== "pending") {
      throw toolError("STATE_PENDING_CONFLICT", "The instance already has a different pending local Credential", { instanceId: facts.instance });
    }
    return {
      instance_id: facts.instance,
      operation_id: facts.operation,
      principal_id: facts.principalId,
      credential_id: facts.credentialId,
      credential_fingerprint: pending.fingerprint,
      state: "pending",
      secret_values_exposed: false,
    };
  }
  const metadata = await createPendingCredential({
    stateRoot,
    ...(home === undefined ? {} : { home }),
    persistenceConfirmed,
    instanceId: facts.instance,
    principalId: facts.principalId,
    credentialId: facts.credentialId,
    idempotencyKey: facts.operation,
    operationId: facts.operation,
    purpose: "owner_bootstrap",
  });
  await appendJournalEvent({
    stateRoot,
    instanceId: facts.instance,
    operationId: facts.operation,
    event: {
      type: "owner_credential_prepared",
      principal_id: facts.principalId,
      credential_id: facts.credentialId,
      credential_fingerprint: metadata.fingerprint,
      secret_values_exposed: false,
    },
  });
  return {
    instance_id: facts.instance,
    operation_id: facts.operation,
    principal_id: facts.principalId,
    credential_id: facts.credentialId,
    credential_fingerprint: metadata.fingerprint,
    state: metadata.state,
    secret_values_exposed: false,
  };
}

export async function loadAuthorizedDeploymentContract({ stateRoot, facts, taskId, plan, configPath }) {
  const journal = await assertJournalAuthorization({
    stateRoot,
    instanceId: facts.instance,
    operationId: facts.operation,
    taskId,
    plan,
  });
  const configEvent = [...journal.events].reverse().find((event) => event?.type === "wrangler_config_written") || null;
  const normalizedConfigPath = absolutePath(configPath, "config_path");
  await assertNoSymlinkPath(normalizedConfigPath, stateRoot);
  const config = await readJson(normalizedConfigPath);
  if (configEvent === null
    || configEvent.config_path !== normalizedConfigPath
    || configEvent.config_digest !== canonicalDigest(config)) {
    throw toolError("WRANGLER_CONFIG_DRIFT", "Owner bootstrap config does not match the authorized operation journal");
  }
  if (config.name !== plan.resources?.worker?.name
    || config.account_id !== plan.target?.cloudflare_account_id
    || config.d1_databases?.length !== 1
    || config.d1_databases[0]?.database_name !== plan.resources?.d1?.name) {
    throw toolError("WRANGLER_CONFIG_DRIFT", "Owner bootstrap config does not match the frozen Cloudflare resources");
  }
  const bundleRoot = absolutePath(configEvent.service_bundle_root, "service_bundle_root");
  const openapiPath = path.join(bundleRoot, "contracts", "openapi.json");
  const migrationManifestPath = path.join(bundleRoot, "migrations", "manifest.json");
  await assertNoSymlinkPath(openapiPath, bundleRoot);
  await assertNoSymlinkPath(migrationManifestPath, bundleRoot);
  const [openapi, migrationManifest] = await Promise.all([readJson(openapiPath), readJson(migrationManifestPath)]);
  const serviceVersion = requireString(openapi?.info?.version, "service_version", { max: 128 });
  const schemaVersion = migrationManifest?.schema_version;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Service bundle migration manifest has an invalid schema version");
  }
  const latestMigrationReadback = [...journal.events].reverse().find((event) => event?.type === "command_finished" && event.action === "migration_ledger_readback") || null;
  if (latestMigrationReadback?.exit_code !== 0 || latestMigrationReadback.migration_readback === undefined) {
    throw toolError("MIGRATION_READBACK_REQUIRED", "Owner bootstrap requires a successful normalized migration readback");
  }
  const migrationState = reconcileMigrationState({
    manifest: migrationManifest,
    ledger: latestMigrationReadback.migration_readback.ledger,
    schema: latestMigrationReadback.migration_readback.schema,
  });
  if (!migrationState.safe_to_continue || migrationState.migrations.some((migration) => migration.state !== "applied")) {
    throw toolError("MIGRATION_STATE_UNSAFE", "Owner bootstrap requires every Service migration to be applied and read back");
  }
  const workerDeploy = [...journal.events].reverse().find((event) => event?.type === "command_finished" && event.action === "deploy_worker_and_static_assets") || null;
  if (workerDeploy?.exit_code !== 0) {
    throw toolError("WORKER_DEPLOYMENT_REQUIRED", "Owner bootstrap requires a successful Worker deployment in the same authorized journal");
  }
  return { journal, config, configEvent, bundleRoot, serviceVersion, schemaVersion };
}

export async function writeOwnerBootstrapSql({
  stateRoot = resolveStateRoot(),
  instanceId,
  operationId,
  taskId,
  plan,
  configPath,
  preferredApiOrigin,
  outputPath = null,
}) {
  const facts = ownerDeploymentFacts(plan, instanceId, operationId);
  const contract = await loadAuthorizedDeploymentContract({ stateRoot, facts, taskId, plan, configPath });
  const { metadata } = await loadPendingCredentialSecret({ stateRoot, instanceId: facts.instance });
  if (!matchingCredential(metadata, facts)) {
    throw toolError("STATE_IDENTITY_CONFLICT", "Pending Owner Credential does not match the authorized deployment plan");
  }
  const origin = requireHttpsOrigin(preferredApiOrigin, "preferred_api_origin");
  if (!origin.endsWith(".workers.dev")) {
    throw toolError("STRICT_ZERO_PLAN_REQUIRED", "Initial strict-zero Owner bootstrap requires the deployed workers.dev origin");
  }
  const plannedOrigin = plan.owner_bootstrap?.preferred_api_origin;
  if (plannedOrigin !== "derive_from_deployed_workers_dev_origin" && requireHttpsOrigin(plannedOrigin, "planned_preferred_api_origin") !== origin) {
    throw toolError("DEPLOYMENT_ORIGIN_DRIFT", "Owner bootstrap origin differs from the frozen deployment plan");
  }
  const paths = getInstancePaths({ stateRoot, instanceId: facts.instance });
  const defaultPath = path.join(paths.journalsRoot, `${facts.operation}.owner-bootstrap.sql`);
  const filePath = outputPath === null ? defaultPath : absolutePath(outputPath, "output_path");
  if (filePath !== defaultPath) {
    throw toolError("UNSAFE_OUTPUT_PATH", "Owner bootstrap SQL must use the operation journal's private fixed path");
  }
  await assertNoSymlinkPath(filePath, stateRoot);
  const existingEvent = [...contract.journal.events].reverse().find((event) => event?.type === "owner_bootstrap_sql_written") || null;
  if (existingEvent !== null) {
    const existingDigest = sha256Bytes(await readFile(filePath));
    if (existingEvent.bootstrap_sql_path !== filePath
      || existingEvent.bootstrap_sql_sha256 !== existingDigest
      || existingEvent.owner_principal_id !== facts.principalId
      || existingEvent.credential_id !== facts.credentialId
      || existingEvent.credential_fingerprint !== metadata.fingerprint
      || existingEvent.preferred_api_origin !== origin
      || existingEvent.service_version !== contract.serviceVersion
      || existingEvent.schema_version !== contract.schemaVersion) {
      throw toolError("OWNER_BOOTSTRAP_SQL_DRIFT", "Existing Owner bootstrap SQL does not match its journal evidence");
    }
    return {
      operation_id: facts.operation,
      bootstrap_sql_path: filePath,
      bootstrap_sql_sha256: existingDigest,
      owner_principal_id: facts.principalId,
      credential_id: facts.credentialId,
      credential_fingerprint: metadata.fingerprint,
      contains_plaintext_credential: false,
      relies_on_wrangler_file_ingestion_transaction: true,
      resumed: true,
    };
  }

  const eventId = crypto.randomUUID();
  const now = Date.now();
  const payload = JSON.stringify({
    origin_version: 1,
    owner_display_name: facts.displayName,
    preferred_api_origin: origin,
    schema_version: contract.schemaVersion,
    service_version: contract.serviceVersion,
  });
  const statements = [
    "PRAGMA foreign_keys = ON;",
    `INSERT INTO principals (id, display_name, version, created_at, updated_at, last_operation_id) VALUES (${sql(facts.principalId)}, ${sql(facts.displayName)}, 1, ${now}, ${now}, ${sql(facts.operation)});`,
    `INSERT INTO instance_meta (singleton, instance_id, owner_principal_id, service_version, schema_version, created_at) VALUES (1, ${sql(facts.instance)}, ${sql(facts.principalId)}, ${sql(contract.serviceVersion)}, ${contract.schemaVersion}, ${now});`,
    `INSERT INTO instance_origin_settings (singleton, preferred_api_origin, version, updated_at, updated_by_principal_id, last_operation_id) VALUES (1, ${sql(origin)}, 1, ${now}, ${sql(facts.principalId)}, ${sql(facts.operation)});`,
    `INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id, last_operation_id) VALUES (${sql(facts.credentialId)}, ${sql(facts.principalId)}, ${sql(metadata.token_prefix)}, ${sql(metadata.token_digest)}, ${now}, ${sql(facts.operation)}, ${sql(facts.operation)});`,
    `INSERT INTO events (id, stream, type, operation_id, event_index, actor_principal_id, actor_credential_id, authorized_via, subject_type, subject_id, payload_json, created_at) VALUES (${sql(eventId)}, 'security', 'instance.bootstrapped', ${sql(facts.operation)}, 0, ${sql(facts.principalId)}, ${sql(facts.credentialId)}, 'deployment_recovery', 'instance', ${sql(facts.instance)}, ${sql(payload)}, ${now});`,
    `INSERT INTO operation_commits (operation_id, primary_subject_type, primary_subject_id, last_event_sequence, committed_at) SELECT ${sql(facts.operation)}, 'instance', ${sql(facts.instance)}, sequence, ${now} FROM events WHERE operation_id = ${sql(facts.operation)} AND event_index = 0;`,
    "",
  ];
  const contents = statements.join("\n");
  await atomicWritePrivateText(filePath, contents);
  const bootstrapSqlSha256 = sha256Bytes(Buffer.from(contents, "utf8"));
  await appendJournalEvent({
    stateRoot,
    instanceId: facts.instance,
    operationId: facts.operation,
    event: {
      type: "owner_bootstrap_sql_written",
      bootstrap_sql_path: filePath,
      bootstrap_sql_sha256: bootstrapSqlSha256,
      owner_principal_id: facts.principalId,
      credential_id: facts.credentialId,
      credential_fingerprint: metadata.fingerprint,
      preferred_api_origin: origin,
      service_version: contract.serviceVersion,
      schema_version: contract.schemaVersion,
      contains_plaintext_credential: false,
    },
  });
  return {
    operation_id: facts.operation,
    bootstrap_sql_path: filePath,
    bootstrap_sql_sha256: bootstrapSqlSha256,
    owner_principal_id: facts.principalId,
    credential_id: facts.credentialId,
    credential_fingerprint: metadata.fingerprint,
    contains_plaintext_credential: false,
    relies_on_wrangler_file_ingestion_transaction: true,
    resumed: false,
  };
}
