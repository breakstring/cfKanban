import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths } from "./state.mjs";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import {
  assertNoSymlinkPath,
  atomicWritePrivateText,
  normalizeLf,
  readJson,
  requireString,
  requireUuid,
  sha256Bytes,
} from "./utils.mjs";

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const MIGRATION_CLASSIFICATIONS = new Set(["bootstrap", "backward_compatible", "breaking_non_destructive", "destructive"]);

function classificationOf(value) {
  const classification = value.classification ?? (value.destructive === true ? "destructive" : "backward_compatible");
  if (!MIGRATION_CLASSIFICATIONS.has(classification) || (value.destructive === true && classification !== "destructive")) {
    throw toolError("INVALID_MIGRATION_CLASSIFICATION", "Migration classification is unknown or inconsistent");
  }
  return classification;
}

function migrationRecord(value) {
  if (!Number.isSafeInteger(value?.sequence) || value.sequence < 1) {
    throw toolError("INVALID_MIGRATION_RECORD", "Migration sequence must be a positive integer");
  }
  const name = requireString(value.name, "migration.name", { max: 256 });
  const sha256 = requireString(value.sha256, "migration.sha256", { max: 64 });
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw toolError("INVALID_MIGRATION_RECORD", "Migration checksum must be a lowercase SHA-256 digest");
  }
  const classification = classificationOf(value);
  const reentry = requireString(value.reentry || "not_safe", "migration.reentry", { max: 128 });
  return { sequence: value.sequence, name, sha256, classification, reentry };
}

export async function writeMigrationLedgerRecordSql({
  stateRoot = resolveStateRoot(),
  instanceId,
  operationId,
  taskId,
  plan,
  migration,
  migrationManifestPath = null,
  outputPath = null,
}) {
  const instance = requireUuid(instanceId, "instance_id");
  const operation = requireUuid(operationId, "operation_id");
  const record = migrationRecord(migration);
  const journal = await assertJournalAuthorization({
    stateRoot,
    instanceId: instance,
    operationId: operation,
    taskId,
    plan,
  });
  const configEvent = [...journal.events].reverse().find((event) => event?.type === "wrangler_config_written") || null;
  if (configEvent === null || typeof configEvent.service_bundle_root !== "string") {
    throw toolError("MIGRATION_RECORD_SOURCE_UNKNOWN", "The authorized journal does not identify its verified Service bundle");
  }
  const bundleRoot = absolutePath(configEvent.service_bundle_root, "service_bundle_root");
  const expectedManifestPath = path.join(bundleRoot, "migrations", "manifest.json");
  const manifestPath = migrationManifestPath === null
    ? expectedManifestPath
    : absolutePath(migrationManifestPath, "migration_manifest_path");
  if (manifestPath !== expectedManifestPath) {
    throw toolError("MIGRATION_RECORD_SOURCE_DRIFT", "Checksum SQL must use the manifest from the Service bundle frozen in the authorized journal");
  }
  const recovery = await assessMigrationLedgerRecovery({
    stateRoot,
    instanceId: instance,
    operationId: operation,
    taskId,
    plan,
    migrationManifestPath: manifestPath,
  });
  const authorizedRecord = recovery.safe_to_record_missing_checksum === true
    ? migrationRecord(recovery.migration)
    : null;
  if (authorizedRecord === null
    || authorizedRecord.sequence !== record.sequence
    || authorizedRecord.name !== record.name
    || authorizedRecord.sha256 !== record.sha256
    || authorizedRecord.classification !== record.classification
    || authorizedRecord.reentry !== record.reentry) {
    throw toolError("MIGRATION_RECORD_NOT_AUTHORIZED", "Checksum SQL requires the exact missing row proven recoverable by the same authorized journal", {
      blockers: recovery.blockers || [],
    });
  }
  const paths = getInstancePaths({ stateRoot, instanceId: instance });
  const fixedPath = path.join(paths.journalsRoot, `${operation}.migration-${record.sequence}.sql`);
  if (outputPath !== null && absolutePath(outputPath, "output_path") !== fixedPath) {
    throw toolError("MIGRATION_RECORD_OUTPUT_DRIFT", "Checksum SQL path is fixed by the authorized operation journal");
  }
  const prior = [...journal.events].reverse().find((event) => event?.type === "migration_record_sql_written"
    && event.migration?.sequence === record.sequence
    && event.migration?.name === record.name) || null;
  if (prior !== null) {
    const existingBytes = await readFile(fixedPath);
    if (prior.migration_record_sql_path !== fixedPath
      || prior.migration_record_sql_sha256 !== sha256Bytes(existingBytes)
      || prior.migration?.sha256 !== record.sha256) {
      throw toolError("MIGRATION_RECORD_SQL_DRIFT", "Previously journaled checksum SQL changed on disk");
    }
    return {
      instance_id: instance,
      operation_id: operation,
      migration: record,
      migration_record_sql_path: fixedPath,
      contains_plaintext_credential: false,
      overwrites_existing_ledger_row: false,
      relies_on_wrangler_file_ingestion_transaction: true,
      resumed: true,
    };
  }
  const appliedAt = Date.now();
  const statements = [
    "INSERT INTO cfkanban_migration_ledger (sequence, name, sha256, classification, reentry, operation_id, applied_at)",
    `SELECT ${record.sequence}, ${sql(record.name)}, ${sql(record.sha256)}, ${sql(record.classification)}, ${sql(record.reentry)}, ${sql(operation)}, ${appliedAt}`,
    `WHERE NOT EXISTS (SELECT 1 FROM cfkanban_migration_ledger WHERE sequence = ${record.sequence} OR name = ${sql(record.name)});`,
    "",
  ];
  await atomicWritePrivateText(fixedPath, statements.join("\n"));
  const sqlSha256 = sha256Bytes(await readFile(fixedPath));
  await appendJournalEvent({
    stateRoot,
    instanceId: instance,
    operationId: operation,
    event: {
      type: "migration_record_sql_written",
      migration_record_sql_path: fixedPath,
      migration_record_sql_sha256: sqlSha256,
      migration: record,
    },
  });
  return {
    instance_id: instance,
    operation_id: operation,
    migration: record,
    migration_record_sql_path: fixedPath,
    contains_plaintext_credential: false,
    overwrites_existing_ledger_row: false,
    relies_on_wrangler_file_ingestion_transaction: true,
    resumed: false,
  };
}

function schemaHasArtifacts(schema, expected = {}) {
  if ((expected.absent_columns?.length ?? 0) > 0 && !Array.isArray(schema.columns)) {
    throw toolError("MIGRATION_COLUMN_READBACK_REQUIRED", "Column readback is required to prove removed schema columns");
  }
  const tables = new Set(schema.tables || []);
  const indexes = new Set(schema.indexes || []);
  const columns = new Set(schema.columns || []);
  const missing = {
    tables: (expected.tables || []).filter((name) => !tables.has(name)),
    indexes: (expected.indexes || []).filter((name) => !indexes.has(name)),
    columns: (expected.columns || []).filter((name) => !columns.has(name)),
    ...(expected.absent_columns ? { absent_columns: expected.absent_columns.filter((name) => columns.has(name)) } : {}),
  };
  return { complete: Object.values(missing).every((items) => items.length === 0), missing };
}

export function normalizeExpectedMigrationData(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["instance_meta_schema_version_at_least", "allow_uninitialized"].includes(key))
    || !Number.isSafeInteger(value.instance_meta_schema_version_at_least) || value.instance_meta_schema_version_at_least < 1
    || (value.allow_uninitialized !== undefined && typeof value.allow_uninitialized !== "boolean")) {
    throw toolError("INVALID_MIGRATION_DATA_ASSERTION", "Migration data assertions only support a minimum Instance schema version and an explicit uninitialized allowance");
  }
  return {
    instance_meta_schema_version_at_least: value.instance_meta_schema_version_at_least,
    allow_uninitialized: value.allow_uninitialized === true,
  };
}

function migrationDataState(schema, expectedValue) {
  const expected = normalizeExpectedMigrationData(expectedValue);
  if (expected === null) return { complete: true, uninitialized: false };
  const observed = schema.data?.instance_meta;
  if (observed === undefined) {
    throw toolError("MIGRATION_DATA_READBACK_REQUIRED", "This migration requires the Instance metadata result from its verified readback SQL");
  }
  if (observed === null || ![0, 1].includes(observed.row_count)
    || (observed.row_count === 0 && observed.schema_version !== null)
    || (observed.row_count === 1 && (!Number.isSafeInteger(observed.schema_version) || observed.schema_version < 1))) {
    throw toolError("MIGRATION_DATA_READBACK_INVALID", "Instance metadata readback must contain zero or one row with an exact schema version");
  }
  const uninitialized = observed.row_count === 0;
  return {
    complete: uninitialized ? expected.allow_uninitialized : observed.schema_version >= expected.instance_meta_schema_version_at_least,
    uninitialized,
  };
}

export function reconcileMigrationState({ manifest, ledger = [], schema = {} }) {
  if (manifest?.manifest_version !== 1 || !Array.isArray(manifest.migrations)) {
    throw toolError("INVALID_MIGRATION_MANIFEST", "Migration manifest must use manifest_version 1");
  }
  const manifestNames = new Set();
  const manifestSequences = new Set();
  for (const migration of manifest.migrations) {
    classificationOf(migration);
    if (manifestNames.has(migration.name) || manifestSequences.has(migration.sequence)) {
      throw toolError("INVALID_MIGRATION_MANIFEST", "Migration manifest contains duplicate names or sequences");
    }
    manifestNames.add(migration.name);
    manifestSequences.add(migration.sequence);
  }
  const ledgerByName = new Map();
  const ledgerSequences = new Set();
  for (const row of ledger) {
    const sequence = Number(row.sequence);
    if (ledgerByName.has(row.name) || ledgerSequences.has(sequence)) {
      throw toolError("MIGRATION_LEDGER_DRIFT", "Migration ledger contains duplicate names or sequences", { name: row.name, sequence });
    }
    ledgerByName.set(row.name, row);
    ledgerSequences.add(sequence);
  }
  const results = [];
  let stopped = false;
  for (const migration of [...manifest.migrations].sort((a, b) => a.sequence - b.sequence)) {
    const row = ledgerByName.get(migration.name);
    const artifacts = schemaHasArtifacts(schema, migration.expected_artifacts);
    const data = migrationDataState(schema, migration.expected_data);
    let state;
    let reason = null;
    if (row && (row.sequence !== undefined && Number(row.sequence) !== migration.sequence)) {
      state = "drift";
      reason = "ledger_sequence_mismatch";
    } else if (row && row.classification !== undefined && classificationOf(row) !== classificationOf(migration)) {
      state = "drift";
      reason = "ledger_classification_mismatch";
    } else if (row && row.sha256 !== migration.sha256) {
      state = "drift";
      reason = "ledger_checksum_mismatch";
    } else if (row && !artifacts.complete) {
      state = "drift";
      reason = "ledger_present_schema_incomplete";
    } else if (row && !data.complete) {
      state = "drift";
      reason = "ledger_present_data_incomplete";
    } else if (row && artifacts.complete) {
      state = "applied";
    } else if (!row && (artifacts.missing.absent_columns?.length ?? 0) > 0
      && artifacts.missing.absent_columns.length < migration.expected_artifacts.absent_columns.length) {
      state = "drift";
      reason = "schema_partial_column_removal";
    } else if (!row && artifacts.complete && data.complete && data.uninitialized) {
      // 空实例的数据修复是 no-op；只有同一 journal 的 apply 证据能证明它已执行。
      state = "pending";
      reason = "uninitialized_data_ledger_missing";
    } else if (!row && artifacts.complete && data.complete) {
      state = migration.safe_baseline === true ? "baseline_candidate" : "drift";
      reason = migration.safe_baseline === true ? "explicit_safe_baseline_required" : "schema_present_ledger_missing";
    } else if (!row && (!data.complete || Object.values(artifacts.missing).some((items) => items.length > 0))) {
      state = "pending";
    }
    if (state === "drift") stopped = true;
    results.push({
      sequence: migration.sequence,
      name: migration.name,
      sha256: migration.sha256,
      classification: classificationOf(migration),
      state,
      reason,
      missing_artifacts: artifacts.missing,
    });
  }
  const unknownLedgerRows = ledger
    .filter((row) => !manifestNames.has(row.name) || !manifestSequences.has(Number(row.sequence)))
    .map((row) => ({ sequence: row.sequence, name: row.name }));
  if (unknownLedgerRows.length > 0) stopped = true;
  return {
    safe_to_continue: !stopped,
    unknown_ledger_rows: unknownLedgerRows,
    migrations: results,
  };
}

function absolutePath(value, name) {
  const candidate = requireString(value, name, { max: 4096 });
  if (!path.isAbsolute(candidate)) {
    throw toolError("ABSOLUTE_PATH_REQUIRED", `${name} must be an absolute path`, { field: name });
  }
  return path.normalize(candidate);
}

function latestCommandFinished(events, action, beforeIndex = events.length) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "command_finished" && event.action === action) return { event, index };
  }
  return null;
}

function latestCommandFinishedAny(events, actions, beforeIndex = events.length) {
  const allowed = new Set(actions);
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "command_finished" && allowed.has(event.action)) return { event, index };
  }
  return null;
}

function isNormalizedMigrationReadback(value) {
  return value !== null
    && typeof value === "object"
    && Array.isArray(value.ledger)
    && value.schema !== null
    && typeof value.schema === "object"
    && Array.isArray(value.schema.tables)
    && Array.isArray(value.schema.indexes)
    && (value.result_set_count === 2 || value.result_set_count === 3);
}

export async function assessMigrationLedgerRecovery({
  stateRoot = resolveStateRoot(),
  instanceId,
  operationId,
  taskId,
  plan,
  migrationManifestPath,
}) {
  const instance = requireUuid(instanceId, "instance_id");
  const operation = requireUuid(operationId, "operation_id");
  const journal = await assertJournalAuthorization({
    stateRoot,
    instanceId: instance,
    operationId: operation,
    taskId,
    plan,
  });
  const configEvent = [...journal.events].reverse().find((event) => event?.type === "wrangler_config_written") || null;
  if (configEvent === null || typeof configEvent.service_bundle_root !== "string") {
    throw toolError("MIGRATION_RECOVERY_SOURCE_UNKNOWN", "The authorized journal does not identify its verified Service bundle");
  }
  const bundleRoot = absolutePath(configEvent.service_bundle_root, "service_bundle_root");
  const manifestPath = absolutePath(migrationManifestPath, "migration_manifest_path");
  const expectedManifestPath = path.join(bundleRoot, "migrations", "manifest.json");
  if (manifestPath !== expectedManifestPath) {
    throw toolError("MIGRATION_RECOVERY_SOURCE_DRIFT", "Migration recovery must use the manifest from the Service bundle frozen in the authorized journal");
  }
  await assertNoSymlinkPath(manifestPath, bundleRoot);
  const manifest = await readJson(manifestPath);
  const latestReadback = latestCommandFinished(journal.events, "migration_ledger_readback");
  if (
    latestReadback === null
    || latestReadback.event.exit_code !== 0
    || !isNormalizedMigrationReadback(latestReadback.event.migration_readback)
  ) {
    return {
      schema_version: 1,
      status: "stop",
      safe_to_record_missing_checksum: false,
      blockers: ["VERIFIED_MIGRATION_READBACK_REQUIRED"],
    };
  }
  const state = reconcileMigrationState({
    manifest,
    ledger: latestReadback.event.migration_readback.ledger,
    schema: latestReadback.event.migration_readback.schema,
  });
  const recoveryCandidates = state.migrations.filter((migration) => (migration.state === "drift" && migration.reason === "schema_present_ledger_missing")
    || (migration.state === "pending" && migration.reason === "uninitialized_data_ledger_missing"));
  const otherDrift = state.migrations.filter((migration) => migration.state === "drift" && migration.reason !== "schema_present_ledger_missing");
  const blockers = [];
  if (state.unknown_ledger_rows.length > 0) blockers.push("UNKNOWN_MIGRATION_LEDGER_ROWS");
  if (otherDrift.length > 0) blockers.push("OTHER_MIGRATION_DRIFT");
  if (recoveryCandidates.length !== 1) blockers.push("EXACTLY_ONE_MISSING_LEDGER_ROW_REQUIRED");

  const latestApply = latestCommandFinishedAny(
    journal.events,
    ["apply_non_destructive_migrations", "apply_migration"],
    latestReadback.index,
  );
  if (latestApply === null || latestApply.event.exit_code !== 0) blockers.push("SAME_JOURNAL_SUCCESSFUL_MIGRATION_APPLY_REQUIRED");
  const latestRecord = latestApply === null
    ? null
    : latestCommandFinished(journal.events, "record_migration_checksum", latestReadback.index);
  if (latestRecord !== null && latestRecord.index > latestApply.index && latestRecord.event.exit_code === 0) {
    blockers.push("SUCCESSFUL_LEDGER_WRITE_MISSING_FROM_READBACK");
  }

  const candidate = recoveryCandidates.length === 1
    ? (manifest.migrations.find((migration) => migration.sequence === recoveryCandidates[0].sequence && migration.name === recoveryCandidates[0].name) || null)
    : null;
  if (candidate !== null && latestApply?.event?.action === "apply_migration") {
    if (latestApply.event.migration?.sequence !== candidate.sequence
      || latestApply.event.migration?.name !== candidate.name
      || latestApply.event.migration?.sha256 !== candidate.sha256) {
      blockers.push("SAME_JOURNAL_MIGRATION_APPLY_MISMATCH");
    }
  }
  if (candidate?.destructive === true) blockers.push("DESTRUCTIVE_MIGRATION_RECOVERY_REJECTED");
  if (candidate !== null) {
    if (path.basename(candidate.name) !== candidate.name || !/^[A-Za-z0-9._-]+$/u.test(candidate.name)) {
      throw toolError("INVALID_MIGRATION_MANIFEST", "Migration recovery candidate has an unsafe file name");
    }
    const migrationPath = path.join(path.dirname(manifestPath), candidate.name);
    await assertNoSymlinkPath(migrationPath, bundleRoot);
    const migrationText = await readFile(migrationPath, "utf8");
    const actualSha256 = sha256Bytes(Buffer.from(normalizeLf(migrationText), "utf8"));
    if (actualSha256 !== candidate.sha256) blockers.push("MIGRATION_FILE_DIGEST_MISMATCH");
  }

  if (blockers.length > 0 || candidate === null) {
    return {
      schema_version: 1,
      status: "stop",
      safe_to_record_missing_checksum: false,
      blockers: [...new Set(blockers)],
    };
  }
  return {
    schema_version: 1,
    status: "same_authorized_journal_recovery",
    safe_to_record_missing_checksum: true,
    blockers: [],
    migration: migrationRecord(candidate),
    evidence: {
      task_operation_and_plan_authorization_match: true,
      service_bundle_manifest_and_migration_digest_match: true,
      migration_apply_succeeded_in_same_journal: true,
      latest_readback_is_after_apply: true,
      expected_schema_is_complete: true,
      ledger_row_is_absent: true,
      no_unknown_ledger_rows: true,
      no_successful_missing_ledger_write: true,
    },
    next_step: "write the insert-only ledger record SQL, execute record_migration_checksum under the same authorized journal, then read back and reconcile again",
  };
}
