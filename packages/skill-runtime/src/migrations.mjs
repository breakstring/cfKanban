import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths } from "./state.mjs";
import { toolError } from "./errors.mjs";
import { atomicWritePrivateText, requireString, requireUuid } from "./utils.mjs";

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
  const classification = value.destructive === true
    ? "destructive"
    : requireString(value.classification || "backward_compatible", "migration.classification", { max: 64 });
  const reentry = requireString(value.reentry || "not_safe", "migration.reentry", { max: 128 });
  return { sequence: value.sequence, name, sha256, classification, reentry };
}

export async function writeMigrationLedgerRecordSql({
  stateRoot = resolveStateRoot(),
  instanceId,
  operationId,
  migration,
  outputPath = null,
}) {
  const instance = requireUuid(instanceId, "instance_id");
  const operation = requireUuid(operationId, "operation_id");
  const record = migrationRecord(migration);
  const paths = getInstancePaths({ stateRoot, instanceId: instance });
  const appliedAt = Date.now();
  const statements = [
    "BEGIN IMMEDIATE;",
    "INSERT INTO cfkanban_migration_ledger (sequence, name, sha256, classification, reentry, operation_id, applied_at)",
    `SELECT ${record.sequence}, ${sql(record.name)}, ${sql(record.sha256)}, ${sql(record.classification)}, ${sql(record.reentry)}, ${sql(operation)}, ${appliedAt}`,
    `WHERE NOT EXISTS (SELECT 1 FROM cfkanban_migration_ledger WHERE sequence = ${record.sequence} OR name = ${sql(record.name)});`,
    "COMMIT;",
    "",
  ];
  const filePath = outputPath || path.join(paths.journalsRoot, `${operation}.migration-${record.sequence}.sql`);
  await atomicWritePrivateText(filePath, statements.join("\n"));
  return {
    instance_id: instance,
    operation_id: operation,
    migration: record,
    migration_record_sql_path: filePath,
    contains_plaintext_credential: false,
    overwrites_existing_ledger_row: false,
  };
}

function schemaHasArtifacts(schema, expected = {}) {
  const tables = new Set(schema.tables || []);
  const indexes = new Set(schema.indexes || []);
  const columns = new Set(schema.columns || []);
  const missing = {
    tables: (expected.tables || []).filter((name) => !tables.has(name)),
    indexes: (expected.indexes || []).filter((name) => !indexes.has(name)),
    columns: (expected.columns || []).filter((name) => !columns.has(name)),
  };
  return { complete: Object.values(missing).every((items) => items.length === 0), missing };
}

export function reconcileMigrationState({ manifest, ledger = [], schema = {} }) {
  if (manifest?.manifest_version !== 1 || !Array.isArray(manifest.migrations)) {
    throw toolError("INVALID_MIGRATION_MANIFEST", "Migration manifest must use manifest_version 1");
  }
  const manifestNames = new Set();
  const manifestSequences = new Set();
  for (const migration of manifest.migrations) {
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
    let state;
    let reason = null;
    if (row && (row.sequence !== undefined && Number(row.sequence) !== migration.sequence)) {
      state = "drift";
      reason = "ledger_sequence_mismatch";
    } else if (row && row.sha256 !== migration.sha256) {
      state = "drift";
      reason = "ledger_checksum_mismatch";
    } else if (row && !artifacts.complete) {
      state = "drift";
      reason = "ledger_present_schema_incomplete";
    } else if (row && artifacts.complete) {
      state = "applied";
    } else if (!row && artifacts.complete) {
      state = migration.safe_baseline === true ? "baseline_candidate" : "drift";
      reason = migration.safe_baseline === true ? "explicit_safe_baseline_required" : "schema_present_ledger_missing";
    } else if (!row && Object.values(artifacts.missing).some((items) => items.length > 0)) {
      state = "pending";
    }
    if (state === "drift") stopped = true;
    results.push({
      sequence: migration.sequence,
      name: migration.name,
      sha256: migration.sha256,
      classification: migration.destructive ? "destructive" : migration.classification || "backward_compatible",
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
