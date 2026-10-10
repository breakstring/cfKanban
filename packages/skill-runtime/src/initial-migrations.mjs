import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { getInstancePaths } from "./state.mjs";
import { verifyInstalledServiceBundle } from "./service-bundle.mjs";
import { assertInitialSchema30Supported, plannedMigrationSqlCompatibility, prepareUpgradeMigrationSql } from "./migration-sql-compatibility.mjs";
import { assertNoSymlinkPath, atomicWritePrivateText, canonicalDigest, ensurePrivateDirectory, pathType, readJson, sha256Bytes } from "./utils.mjs";

const MODE = "wrangler_private_projection_v1";
const digestPattern = /^[a-f0-9]{64}$/;

export function freezeInitialMigrationExecution(schemaVersion, initialMigrations) {
  assertInitialSchema30Supported(schemaVersion);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 30) return null;
  const ordered = initialMigrations?.ordered;
  if (!digestPattern.test(initialMigrations?.manifest_sha256 ?? "") || !Array.isArray(ordered)
    || ordered.length !== schemaVersion || ordered.some((entry, index) => entry?.sequence !== index + 1
      || !/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(entry.name ?? "") || !digestPattern.test(entry.sha256 ?? ""))
    || new Set(ordered.map(entry => entry.name)).size !== ordered.length) {
    throw toolError("INITIAL_MIGRATION_EXECUTION_REQUIRED", "Schema 30/31 first deployment requires the complete ordered migration source digests and canonical manifest digest");
  }
  const compatibility = plannedMigrationSqlCompatibility(ordered);
  if (compatibility.length !== 1) {
    throw toolError("INITIAL_MIGRATION_EXECUTION_REQUIRED", "Initial migration execution requires the exact frozen schema 30 compatibility source");
  }
  const execution = ordered.map(entry => {
    const selected = compatibility.find(value => value.name === entry.name);
    return { sequence: entry.sequence, name: entry.name, source_sql_sha256: entry.sha256,
      executed_sql_sha256: selected?.executed_sql_sha256 ?? entry.sha256, compatibility_transform: selected?.transform ?? null };
  });
  return { mode: MODE, manifest_sha256: initialMigrations.manifest_sha256, ordered: execution, projection_sha256: canonicalDigest(execution) };
}

export function assertInitialMigrationPlan(plan) {
  const schema = plan.release?.schema_version;
  assertInitialSchema30Supported(schema);
  if (!Number.isSafeInteger(schema) || schema < 30) return null;
  const frozen = plan.migrations?.initial_execution;
  const expected = freezeInitialMigrationExecution(schema, { manifest_sha256: frozen?.manifest_sha256,
    ordered: Array.isArray(frozen?.ordered) ? frozen.ordered.map(entry => ({ sequence: entry?.sequence, name: entry?.name, sha256: entry?.source_sql_sha256 })) : null });
  if (canonicalDigest(frozen) !== canonicalDigest(expected)) {
    throw toolError("INITIAL_MIGRATION_PLAN_DRIFT", "Initial execution digests or compatibility transform differ from the frozen plan");
  }
  return frozen;
}

export async function loadInitialMigrationSources({ plan, serviceBundleRoot }) {
  let execution = assertInitialMigrationPlan(plan);
  if (execution === null && serviceBundleRoot === undefined) return null;
  if (execution === null && serviceBundleRoot === null) return null;
  if (typeof serviceBundleRoot !== "string" || !path.isAbsolute(serviceBundleRoot)) {
    throw toolError("INITIAL_SERVICE_BUNDLE_REQUIRED", "First-deployment writes require the verified immutable Service bundle root");
  }
  const bundleRoot = path.normalize(serviceBundleRoot);
  const manifestPath = path.join(bundleRoot, "migrations", "manifest.json");
  await assertNoSymlinkPath(manifestPath, bundleRoot);
  let manifestBytes;
  try { manifestBytes = await readFile(manifestPath); }
  catch (error) { if (error?.code === "ENOENT" && execution === null) return null; throw error; }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (Number.isSafeInteger(manifest.schema_version) && manifest.schema_version >= 30) {
    if (plan.release?.schema_version !== manifest.schema_version) {
      throw toolError("INITIAL_MIGRATION_SCHEMA_DRIFT", "First-deployment schema must match the canonical Service manifest before any write");
    }
    execution = assertInitialMigrationPlan(plan);
  }
  if (execution === null) return null;
  const receipt = await readJson(path.join(path.dirname(bundleRoot), ".cfkanban-release.json"));
  const evidence = await verifyInstalledServiceBundle({ bundleRoot, expectedVersion: plan.release.service_bundle_version,
    expectedSha256: plan.release.service_bundle_sha256, expectedPublisher: receipt.publisher, expectedSource: receipt.source });
  if (sha256Bytes(manifestBytes) !== execution.manifest_sha256) {
    throw toolError("INITIAL_MIGRATION_MANIFEST_DRIFT", "Canonical migration manifest differs from the first-deployment plan");
  }
  if (manifest.schema_version !== plan.release.schema_version || !Array.isArray(manifest.migrations)
    || manifest.migrations.some(entry => entry.destructive !== false)
    || canonicalDigest(freezeInitialMigrationExecution(manifest.schema_version, {
      manifest_sha256: execution.manifest_sha256, ordered: manifest.migrations,
    })) !== canonicalDigest(execution)) {
    throw toolError("INITIAL_MIGRATION_MANIFEST_DRIFT", "Initial projection must include every non-destructive canonical migration in order");
  }
  const compatibility = plannedMigrationSqlCompatibility(manifest.migrations);
  const files = [];
  for (const migration of manifest.migrations) {
    const sourcePath = path.join(bundleRoot, "migrations", migration.name);
    await assertNoSymlinkPath(sourcePath, bundleRoot);
    if (await pathType(sourcePath) !== "file") throw toolError("INITIAL_MIGRATION_SOURCE_DRIFT", "Canonical migration source is missing");
    const bytes = await readFile(sourcePath);
    if (sha256Bytes(bytes) !== migration.sha256) throw toolError("INITIAL_MIGRATION_SOURCE_DRIFT", "Canonical migration source digest changed");
    const prepared = prepareUpgradeMigrationSql({ plan: { migrations: { ordered: manifest.migrations, sql_compatibility: compatibility } }, migration,
      sourceSql: bytes.toString("utf8") });
    files.push({ name: migration.name, sql: prepared.sql, evidence: prepared.evidence });
  }
  return { bundleRoot, execution, manifest, files, evidence };
}

function projectionPath({ stateRoot, instanceId, operationId }) {
  return path.join(getInstancePaths({ stateRoot, instanceId }).journalsRoot, `${operationId}.initial-migrations`);
}

export async function verifyInitialMigrationProjection({ stateRoot, instanceId, operationId, plan, serviceBundleRoot, config, frozenConfigEvent, sources }) {
  const loaded = sources ?? await loadInitialMigrationSources({ plan, serviceBundleRoot });
  if (loaded === null) return null;
  const directory = projectionPath({ stateRoot, instanceId, operationId });
  await assertNoSymlinkPath(directory, getInstancePaths({ stateRoot, instanceId }).journalsRoot);
  if (await pathType(directory) !== "directory") throw toolError("INITIAL_MIGRATION_PROJECTION_DRIFT", "Authorized private migration projection is missing");
  await ensurePrivateDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== loaded.files.length || entries.some(entry => !entry.isFile() || !loaded.files.some(file => file.name === entry.name))) {
    throw toolError("INITIAL_MIGRATION_PROJECTION_DRIFT", "Private migration projection may contain only the ordered canonical SQL files");
  }
  for (const file of loaded.files) {
    const filePath = path.join(directory, file.name);
    await assertNoSymlinkPath(filePath, directory);
    if (sha256Bytes(await readFile(filePath)) !== file.evidence.executed_sql_sha256) {
      throw toolError("INITIAL_MIGRATION_PROJECTION_DRIFT", "Private migration execution bytes differ from the frozen plan", { name: file.name });
    }
  }
  if (config && (config.d1_databases?.length !== 1 || config.d1_databases[0].migrations_dir !== directory
    || frozenConfigEvent?.service_bundle_root !== loaded.bundleRoot
    || frozenConfigEvent?.initial_migrations_path !== directory
    || frozenConfigEvent?.initial_migrations_projection_sha256 !== loaded.execution.projection_sha256
    || frozenConfigEvent?.service_bundle_artifact_sha256 !== loaded.evidence.artifact_sha256
    || frozenConfigEvent?.service_bundle_tree_digest !== loaded.evidence.bundle_tree_digest)) {
    throw toolError("INITIAL_MIGRATION_CONFIG_DRIFT", "Frozen Wrangler config and journal must bind the canonical Service bundle and private migration projection");
  }
  return { path: directory, projection_sha256: loaded.execution.projection_sha256, sources: loaded };
}

export async function writeInitialMigrationProjection(input) {
  const sources = await loadInitialMigrationSources(input);
  if (sources === null) return null;
  const directory = projectionPath(input);
  await assertNoSymlinkPath(directory, getInstancePaths(input).journalsRoot);
  if (await pathType(directory) === "missing") {
    await ensurePrivateDirectory(directory);
    for (const file of sources.files) await atomicWritePrivateText(path.join(directory, file.name), file.sql);
  }
  return verifyInitialMigrationProjection({ ...input, sources });
}
