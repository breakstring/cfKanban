import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths } from "./state.mjs";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { verifyInstalledServiceBundle } from "./service-bundle.mjs";
import {
  assertNoSymlinkPath,
  atomicWriteJson,
  canonicalDigest,
  pathType,
  readJson,
  requireString,
  requireUuid,
} from "./utils.mjs";

const RATE_LIMIT_BINDINGS = Object.freeze([
  ["PRINCIPAL_RATE_LIMITER", "1001", "principal"],
  ["INSTANCE_RATE_LIMITER", "1002", "instance"],
  ["UNAUTHENTICATED_RATE_LIMITER", "1003", "unauthenticated_sensitive"],
]);

function absolutePath(value, name) {
  const candidate = requireString(value, name, { max: 4096 });
  if (!path.isAbsolute(candidate)) {
    throw toolError("ABSOLUTE_PATH_REQUIRED", `${name} must be an absolute path`, { field: name });
  }
  return path.normalize(candidate);
}

async function requireBundleEntry(bundleRoot, relativePath, expectedType) {
  const entry = path.join(bundleRoot, relativePath);
  await assertNoSymlinkPath(entry, bundleRoot);
  const actualType = await pathType(entry);
  if (actualType !== expectedType) {
    throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Verified Service bundle is missing a required deployment entry", {
      entry: relativePath,
      expected_type: expectedType,
      actual_type: actualType,
    });
  }
  return entry;
}

function requireRateLimit(plan, key) {
  const value = plan.bindings?.rate_limits?.[key];
  if (!Number.isSafeInteger(value?.limit) || value.limit < 1 || !Number.isSafeInteger(value?.period_seconds) || value.period_seconds < 1) {
    throw toolError("INVALID_DEPLOYMENT_PLAN", "Deployment plan contains an invalid rate-limit binding", { key });
  }
  return value;
}

function buildRateLimitConfig(plan) {
  return RATE_LIMIT_BINDINGS.map(([name, namespaceId, key]) => {
    const value = requireRateLimit(plan, key);
    return { name, namespace_id: namespaceId, simple: { limit: value.limit, period: value.period_seconds } };
  });
}

function buildRateLimitVars(plan) {
  const principal = requireRateLimit(plan, "principal");
  const instance = requireRateLimit(plan, "instance");
  const unauthenticated = requireRateLimit(plan, "unauthenticated_sensitive");
  return {
    RATE_LIMIT_INSTANCE_LIMIT: String(instance.limit),
    RATE_LIMIT_INSTANCE_PERIOD_SECONDS: String(instance.period_seconds),
    RATE_LIMIT_PRINCIPAL_LIMIT: String(principal.limit),
    RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS: String(principal.period_seconds),
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT: String(unauthenticated.limit),
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS: String(unauthenticated.period_seconds),
  };
}

export async function writeFrozenWranglerConfig({
  stateRoot = resolveStateRoot(),
  instanceId,
  operationId,
  taskId,
  plan,
  serviceBundleRoot,
  d1DatabaseId,
}) {
  const instance = requireUuid(instanceId, "instance_id");
  const operation = requireUuid(operationId, "operation_id");
  if (plan?.target?.instance_id !== instance || plan?.operation_id !== operation) {
    throw toolError("INVALID_DEPLOYMENT_PLAN", "Deployment plan instance does not match the requested state slot", { instance_id: instance });
  }
  if (plan.kind !== "strict_zero_deploy" && plan.kind !== "deployed_instance_upgrade") {
    throw toolError("INVALID_DEPLOYMENT_PLAN", "Frozen Wrangler config requires a strict-zero or Instance upgrade plan");
  }
  await assertJournalAuthorization({ stateRoot, instanceId: instance, operationId: operation, taskId, plan });
  const bundleRoot = absolutePath(serviceBundleRoot, "service_bundle_root");
  if (await pathType(bundleRoot) !== "directory") {
    throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Verified Service bundle root is not a directory", { service_bundle_root: bundleRoot });
  }
  const serviceBundleEvidence = plan.kind === "deployed_instance_upgrade"
    ? await verifyInstalledServiceBundle({
        bundleRoot,
        expectedVersion: plan.release?.service_bundle_version,
        expectedSha256: plan.release?.service_bundle_sha256,
        expectedPublisher: plan.target?.publisher,
        expectedSource: plan.target?.service_bundle_source,
      })
    : null;
  const templatePath = await requireBundleEntry(bundleRoot, "wrangler.template.json", "file");
  const schemaPath = await requireBundleEntry(bundleRoot, "wrangler-config-schema.json", "file");
  const mainPath = await requireBundleEntry(bundleRoot, path.join("dist", "index.js"), "file");
  const assetsPath = await requireBundleEntry(bundleRoot, path.join("apps", "web", "dist"), "directory");
  const migrationsPath = await requireBundleEntry(bundleRoot, "migrations", "directory");
  const template = await readJson(templatePath);
  if (typeof template.compatibility_date !== "string" || template.assets?.binding !== "ASSETS") {
    throw toolError("SERVICE_BUNDLE_CONFIG_INVALID", "Service bundle Wrangler template is missing its pinned compatibility date or ASSETS binding");
  }
  const workerName = requireString(plan.resources?.worker?.name, "worker_name", { max: 63 });
  const d1Name = requireString(plan.resources?.d1?.name, "d1_name", { max: 63 });
  const accountId = requireString(plan.target?.cloudflare_account_id, "cloudflare_account_id", { max: 128 });
  const databaseId = requireUuid(d1DatabaseId, "d1_database_id");
  if (plan.bindings?.d1 !== "DB" || plan.bindings?.assets !== "ASSETS") {
    throw toolError("INVALID_DEPLOYMENT_PLAN", "Deployment plan must freeze the DB and ASSETS binding names");
  }
  const config = {
    $schema: schemaPath,
    name: workerName,
    account_id: accountId,
    main: mainPath,
    compatibility_date: template.compatibility_date,
    workers_dev: plan.resources?.workers_dev === true,
    assets: {
      directory: assetsPath,
      binding: "ASSETS",
      not_found_handling: template.assets.not_found_handling,
      run_worker_first: template.assets.run_worker_first,
    },
    d1_databases: [{
      binding: "DB",
      database_name: d1Name,
      database_id: databaseId,
      migrations_dir: migrationsPath,
    }],
    vars: buildRateLimitVars(plan),
    ratelimits: buildRateLimitConfig(plan),
  };
  if (config.workers_dev !== true || plan.resources?.custom_domain !== null || plan.resources?.pages !== false) {
    throw toolError("STRICT_ZERO_PLAN_REQUIRED", "Frozen Wrangler config generation accepts only workers.dev without Pages or custom domains");
  }
  if (plan.kind === "deployed_instance_upgrade"
    && (plan.resources?.worker?.create !== false
      || plan.resources?.d1?.create !== false
      || plan.resources?.d1?.database_id !== databaseId
      || !Array.isArray(plan.resources?.routes)
      || plan.resources.routes.length !== 0
      || serviceBundleEvidence === null)) {
    throw toolError("UPGRADE_RESOURCE_DRIFT", "Instance upgrade config would replace resources or use an unverified Service bundle");
  }
  const paths = getInstancePaths({ stateRoot, instanceId: instance });
  const configPath = path.join(paths.journalsRoot, `${operation}.wrangler.jsonc`);
  await atomicWriteJson(configPath, config);
  const configDigest = canonicalDigest(config);
  await appendJournalEvent({
    stateRoot,
    instanceId: instance,
    operationId: operation,
    event: {
      type: "wrangler_config_written",
      config_path: configPath,
      config_digest: configDigest,
      d1_database_id: databaseId,
      service_bundle_root: bundleRoot,
      ...(serviceBundleEvidence === null ? {} : {
        service_bundle_artifact_sha256: serviceBundleEvidence.artifact_sha256,
        service_bundle_tree_digest: serviceBundleEvidence.bundle_tree_digest,
        service_bundle_receipt_path: serviceBundleEvidence.receipt_path,
      }),
    },
  });
  return {
    instance_id: instance,
    operation_id: operation,
    wrangler_config_path: configPath,
    config_digest: configDigest,
    main_path: mainPath,
    assets_path: assetsPath,
    migrations_path: migrationsPath,
    contains_secret: false,
  };
}
