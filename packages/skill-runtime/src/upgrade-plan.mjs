import { randomUUID } from "node:crypto";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { satisfiesSimpleRange } from "./tool-runtime.mjs";
import { requireHttpsOrigin, requireString, requireUuid } from "./utils.mjs";

const DEFAULT_RATE_LIMITS = Object.freeze({
  principal: { limit: 120, period_seconds: 60 },
  instance: { limit: 300, period_seconds: 60 },
  unauthenticated_sensitive: { limit: 30, period_seconds: 60 },
});

function digest(value, name) {
  const text = requireString(value, name, { max: 64 });
  if (!/^[a-f0-9]{64}$/u.test(text)) {
    throw toolError("INVALID_DIGEST", name + " must be a lowercase SHA-256 digest", { field: name });
  }
  return text;
}

function absolutePath(value, name) {
  const text = requireString(value, name, { max: 4096 });
  if (!path.posix.isAbsolute(text) && !path.win32.isAbsolute(text)) {
    throw toolError("ABSOLUTE_PATH_REQUIRED", name + " must be an absolute path", { field: name });
  }
  return text;
}

function resourceName(value, name) {
  const text = requireString(value, name, { max: 63 });
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(text)) {
    throw toolError("INVALID_RESOURCE_NAME", name + " is not a safe Cloudflare resource name", { field: name });
  }
  return text;
}

function serviceRelease(value, name, { isTarget = false } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw toolError("INVALID_UPGRADE_RELEASE", name + " must be an object", { field: name });
  }
  let source;
  try {
    source = new URL(requireString(value.service_bundle_source, name + ".service_bundle_source", { max: 4096 }));
  } catch (error) {
    throw toolError("INVALID_UPGRADE_RELEASE", name + ".service_bundle_source must be an HTTPS URL", { field: name + ".service_bundle_source" }, error);
  }
  if (source.protocol !== "https:" || source.username || source.password) {
    throw toolError("INVALID_UPGRADE_RELEASE", name + ".service_bundle_source must be an HTTPS URL without credentials", { field: name + ".service_bundle_source" });
  }
  const schemaVersion = Number(value.schema_version);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw toolError("INVALID_UPGRADE_RELEASE", name + ".schema_version must be a positive integer", { field: name + ".schema_version" });
  }
  const normalized = {
    publisher: requireHttpsOrigin(value.publisher, name + ".publisher"),
    manifest_version: requireString(value.manifest_version, name + ".manifest_version", { max: 128 }),
    manifest_sha256: digest(value.manifest_sha256, name + ".manifest_sha256"),
    service_bundle_version: requireString(value.service_bundle_version, name + ".service_bundle_version", { max: 128 }),
    service_bundle_sha256: digest(value.service_bundle_sha256, name + ".service_bundle_sha256"),
    service_bundle_source: source.href,
    service_api_version: requireString(value.service_api_version, name + ".service_api_version", { max: 128 }),
    schema_version: schemaVersion,
  };
  if (!isTarget) return normalized;

  const compatibility = value.compatibility;
  if (compatibility === null || typeof compatibility !== "object" || Array.isArray(compatibility)) {
    throw toolError("INVALID_UPGRADE_COMPATIBILITY", "target.compatibility must be an object");
  }
  const compatibilitySchema = Number(compatibility.schema_version);
  if (!Number.isSafeInteger(compatibilitySchema) || compatibilitySchema !== schemaVersion) {
    throw toolError("INVALID_UPGRADE_COMPATIBILITY", "Target release schema and compatibility schema must match");
  }
  return {
    ...normalized,
    migration_manifest_sha256: digest(value.migration_manifest_sha256, name + ".migration_manifest_sha256"),
    compatibility: {
      node: requireString(compatibility.node, "target.compatibility.node", { max: 128 }),
      wrangler: requireString(compatibility.wrangler, "target.compatibility.wrangler", { max: 128 }),
      service_api: requireString(compatibility.service_api, "target.compatibility.service_api", { max: 128 }),
      schema_version: compatibilitySchema,
    },
  };
}

function rateLimits(value) {
  const source = value || DEFAULT_RATE_LIMITS;
  const normalized = {};
  for (const key of ["principal", "instance", "unauthenticated_sensitive"]) {
    const entry = source?.[key];
    if (!Number.isSafeInteger(entry?.limit) || entry.limit < 1
      || !Number.isSafeInteger(entry?.period_seconds) || entry.period_seconds < 1) {
      throw toolError("INVALID_UPGRADE_BINDINGS", "Upgrade plan contains an invalid rate-limit binding", { key });
    }
    normalized[key] = { limit: entry.limit, period_seconds: entry.period_seconds };
  }
  return normalized;
}

function sortedBindings(values) {
  return [...values].sort((left, right) => (left.type + ":" + left.name).localeCompare(right.type + ":" + right.name));
}

function expectedBindings({ d1DatabaseId, rateLimits: limits }) {
  return sortedBindings([
    { type: "assets", name: "ASSETS", value_redacted: true },
    { type: "d1", name: "DB", database_id: d1DatabaseId },
    { type: "ratelimit", name: "INSTANCE_RATE_LIMITER", namespace_id: "1002" },
    { type: "ratelimit", name: "PRINCIPAL_RATE_LIMITER", namespace_id: "1001" },
    { type: "ratelimit", name: "UNAUTHENTICATED_RATE_LIMITER", namespace_id: "1003" },
    { type: "plain_text", name: "RATE_LIMIT_INSTANCE_LIMIT", text: String(limits.instance.limit) },
    { type: "plain_text", name: "RATE_LIMIT_INSTANCE_PERIOD_SECONDS", text: String(limits.instance.period_seconds) },
    { type: "plain_text", name: "RATE_LIMIT_PRINCIPAL_LIMIT", text: String(limits.principal.limit) },
    { type: "plain_text", name: "RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS", text: String(limits.principal.period_seconds) },
    { type: "plain_text", name: "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT", text: String(limits.unauthenticated_sensitive.limit) },
    { type: "plain_text", name: "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS", text: String(limits.unauthenticated_sensitive.period_seconds) },
  ]);
}

function currentBindingReadback(value, { d1DatabaseId, rateLimits: limits }) {
  if (!Array.isArray(value)) {
    throw toolError("UPGRADE_BINDING_READBACK_REQUIRED", "Instance upgrade requires the redacted binding inventory from the current Worker version");
  }
  const observed = sortedBindings(value.map((binding, index) => {
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
      throw toolError("INVALID_UPGRADE_BINDINGS", "Current Worker binding evidence contains an invalid entry", { index });
    }
    const type = requireString(binding.type, "worker_binding.type", { max: 64 });
    const name = requireString(binding.name, "worker_binding.name", { max: 128 });
    if (type === "assets") return { type, name, value_redacted: binding.value_redacted === true };
    if (type === "d1") return { type, name, database_id: requireUuid(binding.database_id, "worker_binding.database_id") };
    if (type === "ratelimit") {
      return {
        type,
        name,
        namespace_id: requireString(binding.namespace_id, "worker_binding.namespace_id", { max: 64 }),
      };
    }
    if (type === "plain_text") {
      return { type, name, text: requireString(binding.text, "worker_binding.text", { max: 32 }) };
    }
    throw toolError("UPGRADE_BINDING_DELTA_REQUIRES_SEPARATE_PLAN", "Current Worker has an unsupported binding that the normal upgrade would remove or replace", { type, name });
  }));
  const expected = expectedBindings({ d1DatabaseId, rateLimits: limits });
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw toolError("UPGRADE_BINDING_DELTA_REQUIRES_SEPARATE_PLAN", "Current Worker bindings do not exactly match the frozen normal-upgrade target", {
      observed: observed.map(({ type, name }) => ({ type, name })),
      expected: expected.map(({ type, name }) => ({ type, name })),
    });
  }
  return observed;
}

function artifactNames(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_.]+$/u.test(entry))) {
    throw toolError("INVALID_UPGRADE_MIGRATION", field + " must contain safe schema artifact names", { field });
  }
  return [...new Set(value)].sort();
}

function migrationDelta(values) {
  if (!Array.isArray(values)) throw toolError("INVALID_UPGRADE_MIGRATION", "migrations must be an array");
  const ordered = values.map((value, index) => {
    if (!Number.isSafeInteger(value?.sequence) || value.sequence < 1) {
      throw toolError("INVALID_UPGRADE_MIGRATION", "Migration sequence must be a positive integer", { index });
    }
    const name = requireString(value.name, "migration.name", { max: 256 });
    if (path.basename(name) !== name || !/^[A-Za-z0-9._-]+$/u.test(name)) {
      throw toolError("INVALID_UPGRADE_MIGRATION", "Migration name must be a safe file name", { index });
    }
    if (value.destructive === true || value.classification === "destructive") {
      throw toolError("DESTRUCTIVE_MIGRATION_REQUIRES_SEPARATE_PLAN", "Normal Instance upgrade rejects destructive migrations", { sequence: value.sequence, name });
    }
    if (value.classification !== "backward_compatible") {
      throw toolError("INVALID_UPGRADE_MIGRATION", "Normal Instance upgrade accepts only backward-compatible migration deltas", { sequence: value.sequence, name });
    }
    return {
      sequence: value.sequence,
      name,
      sha256: digest(value.sha256, "migration.sha256"),
      classification: "backward_compatible",
      destructive: false,
      reentry: requireString(value.reentry, "migration.reentry", { max: 128 }),
      expected_artifacts: {
        tables: artifactNames(value.expected_artifacts?.tables, "migration.expected_artifacts.tables"),
        indexes: artifactNames(value.expected_artifacts?.indexes, "migration.expected_artifacts.indexes"),
        columns: artifactNames(value.expected_artifacts?.columns, "migration.expected_artifacts.columns"),
      },
    };
  });
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].sequence >= ordered[index].sequence) {
      throw toolError("INVALID_UPGRADE_MIGRATION", "Migration deltas must be supplied in strictly increasing sequence order");
    }
  }
  if (new Set(ordered.map((entry) => entry.name)).size !== ordered.length) {
    throw toolError("INVALID_UPGRADE_MIGRATION", "Migration deltas contain duplicate names");
  }
  return ordered;
}

function restorePoint(value, migrations) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw toolError("RESTORE_POINT_REQUIRED", "Instance upgrade requires an explicit restore-point decision");
  }
  const required = migrations.length > 0;
  if (required && (value.required !== true || value.verified !== true)) {
    throw toolError("RESTORE_POINT_REQUIRED", "Migration-bearing Instance upgrades require verified D1 restore evidence");
  }
  if (!required && value.required !== false && value.verified !== true) {
    throw toolError("INVALID_RESTORE_POINT", "A no-migration upgrade must mark the restore point as not required or provide verified evidence");
  }
  const bookmark = value.bookmark === null || value.bookmark === undefined
    ? null
    : requireString(value.bookmark, "restore_point.bookmark", { max: 512 });
  if (required && bookmark === null) throw toolError("RESTORE_POINT_REQUIRED", "Verified restore evidence requires a D1 bookmark");
  const observedAt = value.observed_at === null || value.observed_at === undefined
    ? null
    : requireString(value.observed_at, "restore_point.observed_at", { max: 128 });
  if (required && (observedAt === null || Number.isNaN(Date.parse(observedAt)))) {
    throw toolError("RESTORE_POINT_REQUIRED", "Verified restore evidence requires an observed_at timestamp");
  }
  const retentionBoundary = value.retention_boundary === undefined || value.retention_boundary === null
    ? null
    : requireString(value.retention_boundary, "restore_point.retention_boundary", { max: 256 });
  if (required && (retentionBoundary === null || retentionBoundary === "not_reported_by_wrangler")) {
    throw toolError("RESTORE_POINT_RETENTION_REQUIRED", "Migration-bearing Instance upgrades require a verified current platform retention boundary");
  }
  return {
    required,
    verified: value.verified === true,
    bookmark,
    observed_at: observedAt,
    retention_boundary: retentionBoundary,
    reason: requireString(value.reason, "restore_point.reason", { max: 256 }),
    restore_overwrites_later_writes: true,
    restore_automatic: false,
  };
}

export function createInstanceUpgradePlan({
  taskId,
  instanceId,
  operationId = randomUUID(),
  cloudflare,
  resources,
  bindings,
  owner,
  current,
  target,
  migrations = [],
  restorePoint: restorePointInput,
}) {
  const instance = requireUuid(instanceId, "instance_id");
  const operation = requireUuid(operationId, "operation_id");
  if (cloudflare === null || typeof cloudflare !== "object" || Array.isArray(cloudflare)) {
    throw toolError("INVALID_UPGRADE_TARGET", "cloudflare must identify the existing deployment target");
  }
  if (cloudflare.profile !== null && cloudflare.profile !== undefined
    && cloudflare.auth_context_directory !== null && cloudflare.auth_context_directory !== undefined) {
    throw toolError("AMBIGUOUS_WRANGLER_AUTH_CONTEXT", "Use either an explicit Wrangler profile or an effective context directory, not both");
  }
  const profile = cloudflare.profile === null || cloudflare.profile === undefined
    ? null
    : requireString(cloudflare.profile, "cloudflare.profile", { max: 128 });
  const contextDirectory = cloudflare.auth_context_directory === null || cloudflare.auth_context_directory === undefined
    ? null
    : absolutePath(cloudflare.auth_context_directory, "cloudflare.auth_context_directory");

  if (resources === null || typeof resources !== "object" || Array.isArray(resources)) {
    throw toolError("INVALID_UPGRADE_RESOURCES", "resources must identify the existing Worker and D1");
  }
  if (resources.workers_dev !== true
    || resources.custom_domain !== null
    || !Array.isArray(resources.routes)
    || resources.routes.length !== 0
    || resources.pages !== false) {
    throw toolError("UPGRADE_RESOURCE_DELTA_REQUIRES_SEPARATE_PLAN", "Normal Instance upgrade cannot add, remove, or take ownership of domains, routes, Pages, or workers.dev");
  }
  const workerName = resourceName(resources.worker?.name, "worker_name");
  const d1Name = resourceName(resources.d1?.name, "d1_name");
  const d1DatabaseId = requireUuid(resources.d1?.database_id, "d1_database_id");
  const workerDeploymentId = requireUuid(resources.worker?.deployment_id, "worker_deployment_id");
  const workerVersionId = requireUuid(resources.worker?.version_id, "worker_version_id");

  if (bindings?.d1 !== "DB" || bindings?.assets !== "ASSETS") {
    throw toolError("INVALID_UPGRADE_BINDINGS", "Normal Instance upgrade requires the existing DB and ASSETS binding names");
  }
  const normalizedCurrent = serviceRelease(current, "current");
  const normalizedTarget = serviceRelease(target, "target", { isTarget: true });
  if (normalizedCurrent.publisher !== normalizedTarget.publisher
    || new URL(normalizedCurrent.service_bundle_source).origin !== new URL(normalizedTarget.service_bundle_source).origin) {
    throw toolError("PUBLISHER_DISCONTINUITY", "Instance upgrade target changes the canonical publisher or artifact origin");
  }
  if (normalizedCurrent.service_bundle_sha256 === normalizedTarget.service_bundle_sha256) {
    throw toolError("UPGRADE_TARGET_ALREADY_CURRENT", "Target Service bundle matches the current deployment");
  }
  if (!satisfiesSimpleRange(normalizedCurrent.service_api_version, normalizedTarget.compatibility.service_api)
    || !satisfiesSimpleRange(normalizedTarget.service_api_version, normalizedTarget.compatibility.service_api)) {
    throw toolError("INCOMPATIBLE_SERVICE_API", "Current or target Service API is outside the target release compatibility range");
  }
  const orderedMigrations = migrationDelta(migrations);
  if (normalizedTarget.schema_version < normalizedCurrent.schema_version
    || (orderedMigrations.length === 0 && normalizedTarget.schema_version !== normalizedCurrent.schema_version)
    || (orderedMigrations.length > 0 && normalizedTarget.schema_version <= normalizedCurrent.schema_version)) {
    throw toolError("INVALID_UPGRADE_SCHEMA_DELTA", "Target schema version and ordered migration delta do not agree");
  }
  const normalizedRestorePoint = restorePoint(restorePointInput, orderedMigrations);

  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    throw toolError("INVALID_UPGRADE_OWNER", "owner must identify the existing Deployment Owner");
  }
  const normalizedOwner = {
    display_name: requireString(owner.display_name, "owner.display_name", { max: 128 }).trim(),
    principal_id: requireUuid(owner.principal_id, "owner.principal_id"),
    credential_id: requireUuid(owner.credential_id, "owner.credential_id"),
    credential_fingerprint: requireString(owner.credential_fingerprint, "owner.credential_fingerprint", { max: 128 }),
  };
  const normalizedRateLimits = rateLimits(bindings.rate_limits);
  const observedBindings = currentBindingReadback(resources.worker?.bindings, {
    d1DatabaseId,
    rateLimits: normalizedRateLimits,
  });
  const accountId = requireString(cloudflare.account_id, "cloudflare.account_id", { max: 128 });
  const apiOrigin = requireHttpsOrigin(cloudflare.api_origin, "cloudflare.api_origin");
  const frozenTarget = {
    ...normalizedTarget,
    kind: "service_deployment_bundle",
    instance_id: instance,
    cloudflare_account_id: accountId,
    cloudflare_account_label: cloudflare.account_label ?? null,
    cloudflare_profile: profile,
    cloudflare_auth_context_directory: contextDirectory,
    api_origin: apiOrigin,
  };

  return {
    schema_version: 1,
    kind: "deployed_instance_upgrade",
    task_id: requireString(taskId, "task_id", { max: 256 }),
    operation_id: operation,
    instance_id: instance,
    current: normalizedCurrent,
    target: frozenTarget,
    release: {
      manifest_version: normalizedTarget.manifest_version,
      manifest_sha256: normalizedTarget.manifest_sha256,
      service_bundle_version: normalizedTarget.service_bundle_version,
      service_bundle_sha256: normalizedTarget.service_bundle_sha256,
    },
    resources: {
      worker: {
        name: workerName,
        create: false,
        current_deployment_id: workerDeploymentId,
        current_version_id: workerVersionId,
        current_bindings: observedBindings,
      },
      d1: { name: d1Name, database_id: d1DatabaseId, create: false },
      workers_dev: true,
      custom_domain: null,
      routes: [],
      pages: false,
      kv: false,
      r2: false,
      queues: false,
      durable_objects: false,
      vectorize: false,
      workers_ai: false,
    },
    bindings: {
      d1: "DB",
      assets: "ASSETS",
      rate_limits: normalizedRateLimits,
    },
    owner: normalizedOwner,
    compatibility: {
      current: {
        service_api_version: normalizedCurrent.service_api_version,
        schema_version: normalizedCurrent.schema_version,
      },
      target: {
        ...normalizedTarget.compatibility,
        service_api_version: normalizedTarget.service_api_version,
      },
      verified: true,
    },
    migrations: {
      ordered: orderedMigrations,
      allow_destructive: false,
      require_ledger_and_schema_readback: true,
      checksum_ledger_table: "cfkanban_migration_ledger",
      restore_automatically: false,
    },
    restore_point: normalizedRestorePoint,
    requires_cloudflare_authorization: true,
    skill_update_included: false,
    resource_replacement_allowed: false,
    binding_changes_allowed: false,
    cost_delta: false,
    domain_delta: false,
    expected_interruption: "single_worker_deploy",
    d1_restore_automatic: false,
    worker_rollback_rolls_back_d1: false,
    rollback_boundary: {
      worker_rollback_requires_compatible_current_schema: true,
      worker_rollback_does_not_rollback_d1: true,
      d1_restore_requires_new_authorization: true,
    },
    steps: [
      "verify_existing_resource_markers_bindings_and_instance",
      "install_verified_service_bundle",
      "write_frozen_wrangler_config",
      "read_migration_checksum_ledger_and_schema",
      ...orderedMigrations.flatMap((migration) => [
        "apply_migration:" + migration.sequence + ":" + migration.name,
        "read_migration_checksum_ledger_and_schema_after_apply:" + migration.sequence,
        "prove_same_journal_missing_checksum_recovery:" + migration.sequence,
        "write_plan_bound_migration_checksum_sql:" + migration.sequence,
        "record_migration_checksum:" + migration.sequence + ":" + migration.name,
        "read_migration_checksum_ledger_and_schema_after_record:" + migration.sequence,
      ]),
      "validate_worker_bundle_with_wrangler_dry_run",
      "deploy_worker_and_static_assets",
      "read_worker_deployment",
      "verify_health_discovery_schema_meta_and_me",
      "write_redacted_upgrade_receipt",
    ],
  };
}
