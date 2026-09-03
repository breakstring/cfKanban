import { randomUUID } from "node:crypto";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { canonicalDigest, jsonPointerChanges, requireHttpsOrigin, requireString, requireUuid } from "./utils.mjs";

export const DEFAULT_RATE_LIMITS = Object.freeze({
  principal: { limit: 120, period_seconds: 60 },
  instance: { limit: 300, period_seconds: 60 },
  unauthenticated_sensitive: { limit: 30, period_seconds: 60 },
});

function resourceName(value, suffix) {
  const base = requireString(value, "resource_prefix", { max: 48 }).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (base.length < 2) throw toolError("INVALID_RESOURCE_PREFIX", "Resource prefix must contain at least two letters or digits");
  return `${base.slice(0, 48 - suffix.length - 1)}-${suffix}`;
}

function exactResourceName(value, name) {
  const text = requireString(value, name, { max: 63 });
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(text)) throw toolError("INVALID_RESOURCE_NAME", `${name} is not a safe Cloudflare resource name`, { field: name });
  return text;
}

function digest(value, name) {
  const text = requireString(value, name, { max: 64 });
  if (!/^[a-f0-9]{64}$/.test(text)) throw toolError("INVALID_DIGEST", `${name} must be a lowercase SHA-256 digest`, { field: name });
  return text;
}

function absolutePath(value, name) {
  const text = requireString(value, name, { max: 4096 });
  if (!path.posix.isAbsolute(text) && !path.win32.isAbsolute(text)) {
    throw toolError("ABSOLUTE_PATH_REQUIRED", `${name} must be an absolute path`, { field: name });
  }
  return text;
}

export function createStrictZeroPlan({
  taskId,
  accountId,
  accountLabel = null,
  cloudflareProfile = null,
  cloudflareAuthContextDirectory = null,
  ownerDisplayName,
  release,
  resourcePrefix = "cfkanban",
  workerName = null,
  d1Name = null,
  instanceId = randomUUID(),
  ownerPrincipalId = randomUUID(),
  ownerCredentialId = randomUUID(),
  operationId = randomUUID(),
  preferredApiOrigin = null,
}) {
  const owner = requireString(ownerDisplayName, "owner_display_name", { max: 128 }).trim();
  const frozenWorkerName = exactResourceName(workerName || resourceName(resourcePrefix, "worker"), "worker_name");
  const frozenD1Name = exactResourceName(d1Name || resourceName(resourcePrefix, "d1"), "d1_name");
  if (cloudflareProfile !== null && cloudflareAuthContextDirectory !== null) {
    throw toolError("AMBIGUOUS_WRANGLER_AUTH_CONTEXT", "Use either an explicit Wrangler profile or an effective context directory, not both");
  }
  const plan = {
    schema_version: 1,
    kind: "strict_zero_deploy",
    task_id: requireString(taskId, "task_id", { max: 256 }),
    operation_id: requireUuid(operationId, "operation_id"),
    target: {
      cloudflare_account_id: requireString(accountId, "account_id", { max: 128 }),
      cloudflare_account_label: accountLabel,
      cloudflare_profile: cloudflareProfile === null ? null : requireString(cloudflareProfile, "cloudflare_profile", { max: 128 }),
      cloudflare_auth_context_directory: cloudflareAuthContextDirectory === null
        ? null
        : absolutePath(cloudflareAuthContextDirectory, "cloudflare_auth_context_directory"),
      instance_id: requireUuid(instanceId, "instance_id"),
    },
    release: {
      manifest_version: requireString(release.manifest_version, "release.manifest_version", { max: 128 }),
      manifest_sha256: digest(release.manifest_sha256, "release.manifest_sha256"),
      service_bundle_version: requireString(release.service_bundle_version, "release.service_bundle_version", { max: 128 }),
      service_bundle_sha256: digest(release.service_bundle_sha256, "release.service_bundle_sha256"),
    },
    resources: {
      worker: { name: frozenWorkerName, create: true },
      d1: { name: frozenD1Name, create: true },
      workers_dev: true,
      custom_domain: null,
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
      rate_limits: DEFAULT_RATE_LIMITS,
    },
    owner_bootstrap: {
      owner_display_name: owner,
      owner_principal_id: requireUuid(ownerPrincipalId, "owner_principal_id"),
      owner_credential_id: requireUuid(ownerCredentialId, "owner_credential_id"),
      credential_strategy: "generate_after_authorization_to_private_pending_file",
      preferred_api_origin: preferredApiOrigin === null ? "derive_from_deployed_workers_dev_origin" : requireHttpsOrigin(preferredApiOrigin, "preferred_api_origin"),
    },
    migrations: {
      allow_destructive: false,
      require_ledger_and_schema_readback: true,
      checksum_ledger_table: "cfkanban_migration_ledger",
      missing_ledger_policy: "stop_unless_manifest_explicitly_allows_safe_baseline",
      restore_automatically: false,
    },
    cost_profile: "cloudflare_strict_zero_free_candidate",
    rollback_boundary: {
      worker_rollback_does_not_rollback_d1: true,
      d1_restore_requires_new_authorization: true,
      unknown_resources_are_never_adopted_or_overwritten: true,
    },
    steps: [
      "preflight_readback",
      "create_d1",
      "write_frozen_wrangler_config",
      "initialize_migration_checksum_ledger",
      "read_migration_checksum_ledger_and_schema",
      "apply_non_destructive_migrations",
      "record_each_migration_checksum_without_overwrite",
      "read_migration_checksum_ledger_and_schema_again",
      "validate_worker_bundle_with_wrangler_dry_run",
      "deploy_worker_and_static_assets",
      "bootstrap_owner_from_private_pending_credential",
      "verify_health_discovery_schema_and_me",
      "write_redacted_receipt",
    ],
  };
  return { plan, plan_digest: canonicalDigest(plan) };
}

export function comparePlans(before, after) {
  const changes = jsonPointerChanges(before, after);
  return {
    changed: changes.length > 0,
    changed_paths: changes,
    requires_new_authorization: changes.length > 0,
    before_digest: canonicalDigest(before),
    after_digest: canonicalDigest(after),
  };
}

export function createSkillUpdatePlan({ taskId, current, target, installRoot }) {
  if (current?.kind && current.kind !== "skill_bundle") throw toolError("INVALID_UPDATE_PLANE", "Current artifact is not a Skill bundle");
  return {
    schema_version: 1,
    kind: "local_skill_update",
    task_id: requireString(taskId, "task_id"),
    current,
    target: { ...target, kind: "skill_bundle" },
    install_root: installRoot,
    cloudflare_writes: false,
    d1_migrations: false,
    switch: "atomic_after_digest_and_discovery_smoke",
    rollback: "previous_known_good_bundle",
  };
}

export function createInstanceUpgradePlan({ taskId, instanceId, current, target, migrations, restorePoint }) {
  return {
    schema_version: 1,
    kind: "deployed_instance_upgrade",
    task_id: requireString(taskId, "task_id"),
    instance_id: requireUuid(instanceId, "instance_id"),
    current,
    target: { ...target, kind: "service_deployment_bundle" },
    migrations,
    restore_point: restorePoint,
    requires_cloudflare_authorization: true,
    skill_update_included: false,
    d1_restore_automatic: false,
    worker_rollback_rolls_back_d1: false,
  };
}
