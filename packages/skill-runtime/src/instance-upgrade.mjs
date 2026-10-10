import { readServiceReleaseVersion } from "./service-release-version.mjs";
import { readServiceApiVersion } from "./service-api-version.mjs";
import { deploymentCrons, usageVars } from "./usage-config.mjs";
import { publicAccessVars } from "./public-access-config.mjs";
import { costProtectionBindings, normalizeObservedWorkerLimits, plannedWorkerLimits } from "./cost-protection-config.mjs";
import { normalizeObservedWorkerObservability, normalizePlannedWorkerObservability } from "./worker-observability.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertReadback,
  assertReleaseMatchesPlan,
  loadActiveSkillEvidence,
  requestJson,
} from "./deployment-finalize.mjs";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { reconcileMigrationState } from "./migrations.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { fetchDiscovery, validateDiscovery } from "./rebind.mjs";
import { loadAndVerifyRelease } from "./release.mjs";
import { verifyInstalledServiceBundle } from "./service-bundle.mjs";
import { deploymentCompletion, findDeploymentAttempt } from "./worker-deployment-recovery.mjs";
import { ATTACHMENT_CLEANUP_CRON, assertAttachmentStoragePlan } from "./r2-storage.mjs";
import {
  getInstancePaths,
  loadCurrentCredentialSecret,
  putInstanceMetadata,
  validatePrivatePath,
} from "./state.mjs";
import { trustedApiRequest } from "./transport.mjs";
import { notifyVerifiedUpgrade } from "./upgrade-notification.mjs";
import {
  assertNoSymlinkPath,
  atomicWriteJson,
  canonicalDigest,
  readJson,
  requireHttpsOrigin,
  requireString,
  requireUuid,
  sha256Bytes,
} from "./utils.mjs";


function latestFinished(events, action) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "command_finished" && event.action === action) return { event, index };
  }
  return null;
}

function receiptRelease(receipt) {
  return receipt?.service_release?.after || receipt?.service_release || null;
}

async function requestTrustedReadback({ stateRoot, instanceId, origin, apiPath, token, fetchImpl }) {
  const response = await trustedApiRequest({
    stateRoot,
    instanceId,
    apiPath,
    expectedApiOrigin: origin,
    authorizationToken: token,
    fetchImpl,
  });
  if (!response.ok) {
    throw toolError("DEPLOYMENT_READBACK_FAILED", "Upgrade finalization did not receive a direct JSON success response", { apiPath, status: response.status });
  }
  return response.data;
}

export function assertPriorReceipt(receipt, plan) {
  const attachment = receipt?.kind === "cfkanban_deployment_attachment_receipt";
  if (attachment && (plan.current?.provenance !== "remote_observed" || plan.allow_unverified_current_source !== true
    || receipt.provenance?.deployed_artifact_verified !== false || receipt.provenance?.historical_artifact_source !== "unknown"
    || receipt.cloudflare?.worker?.version_id !== plan.resources.worker.current_version_id
    || receipt.cloudflare?.worker?.deployment_id !== plan.resources.worker.current_deployment_id
    || receipt.service_release?.provenance !== "remote_observed"
    || receipt.instance?.schema_version !== plan.current.schema_version || receipt.instance?.service_version !== plan.current.service_api_version)) {
    throw toolError("UPGRADE_PRIOR_RECEIPT_DRIFT", "Attached deployment provenance or observed Worker state differs from the frozen upgrade plan");
  }
  if (!attachment && plan.current?.provenance === "remote_observed") throw toolError("UPGRADE_PRIOR_RECEIPT_DRIFT", "Unknown current provenance requires an attachment receipt");
  const before = receiptRelease(receipt);
  if ((receipt?.kind !== "cfkanban_deployment_receipt" && receipt?.kind !== "cfkanban_instance_upgrade_receipt" && !attachment)
    || receipt.instance?.id !== plan.instance_id
    || receipt.cloudflare?.account_id !== plan.target.cloudflare_account_id
    || receipt.cloudflare?.profile !== plan.target.cloudflare_profile
    || receipt.cloudflare?.worker?.name !== plan.resources.worker.name
    || receipt.cloudflare?.d1?.name !== plan.resources.d1.name
    || receipt.cloudflare?.d1?.database_id !== plan.resources.d1.database_id
    || receipt.owner?.principal_id !== plan.owner.principal_id
    || receipt.owner?.credential_id !== plan.owner.credential_id
    || receipt.owner?.credential_fingerprint !== plan.owner.credential_fingerprint
    || (receipt.cloudflare?.r2?.bucket_name ?? null) !== (plan.attachment_storage?.previous_bucket ?? null)
    || before?.publisher !== plan.current.publisher
    || before?.manifest_version !== plan.current.manifest_version
    || before?.manifest_sha256 !== plan.current.manifest_sha256
    || before?.service_bundle_version !== plan.current.service_bundle_version
    || before?.service_bundle_sha256 !== plan.current.service_bundle_sha256
    || before?.service_bundle_source !== plan.current.service_bundle_source) {
    throw toolError("UPGRADE_PRIOR_RECEIPT_DRIFT", "Prior deployment receipt does not match the frozen Instance upgrade plan");
  }
}

function assertUpgradeConfig(config, event, plan, configPath) {
  assertAttachmentStoragePlan(plan);
  const observability = normalizePlannedWorkerObservability(plan);
  if (event === null
    || event.config_path !== configPath
    || event.config_digest !== canonicalDigest(config)
    || config.name !== plan.resources.worker.name
    || config.account_id !== plan.target.cloudflare_account_id
    || config.d1_databases?.length !== 1
    || config.d1_databases[0]?.binding !== plan.bindings.d1
    || config.d1_databases[0]?.database_name !== plan.resources.d1.name
    || config.d1_databases[0]?.database_id !== plan.resources.d1.database_id
    || config.assets?.binding !== plan.bindings.assets
    || Object.entries(usageVars(plan.usage_analytics?.configuration)).some(([name, value]) => config.vars?.[name] !== value)
    || Object.entries(publicAccessVars(plan.public_access)).some(([name, value]) => config.vars?.[name] !== value)
    || costProtectionBindings(plan.cost_protection).filter(item => item.type === "plain_text").some(item => config.vars?.[item.name] !== item.text)
    || JSON.stringify(normalizeObservedWorkerLimits(config.limits)) !== JSON.stringify(plannedWorkerLimits(plan))
    || (observability !== undefined && (!Object.hasOwn(config, "observability") || canonicalDigest(normalizeObservedWorkerObservability(config.observability)) !== canonicalDigest(observability)))
    || config.workers_dev !== (plan.public_access?.domain_enabled !== true)
    || (plan.public_access && (config.preview_urls !== false || JSON.stringify(config.routes ?? []) !== JSON.stringify(plan.public_access.domain_enabled ? [{ pattern: plan.public_access.hostname, custom_domain: true, zone_id: plan.public_access.zone_id }] : [])))
    || JSON.stringify(config.r2_buckets ?? []) !== JSON.stringify(plan.resources.r2 ? [{ binding: "ATTACHMENTS", bucket_name: plan.resources.r2.bucket_name }] : [])
    || JSON.stringify(config.triggers?.crons ?? []) !== JSON.stringify(deploymentCrons(plan))) {
    throw toolError("WRANGLER_CONFIG_DRIFT", "Upgrade Wrangler config does not match the frozen target");
  }
}

function assertMigrationReadback(journal, manifest) {
  const latest = latestFinished(journal.events, "migration_ledger_readback");
  if (latest?.event?.exit_code !== 0 || latest.event.migration_readback === undefined) {
    throw toolError("MIGRATION_READBACK_REQUIRED", "Instance upgrade finalization requires a successful normalized migration readback");
  }
  const state = reconcileMigrationState({
    manifest,
    ledger: latest.event.migration_readback.ledger,
    schema: latest.event.migration_readback.schema,
  });
  if (!state.safe_to_continue || state.migrations.some((migration) => migration.state !== "applied")) {
    throw toolError("MIGRATION_STATE_UNSAFE", "Instance upgrade finalization requires every target migration to be applied");
  }
  return { latest, state };
}

export async function finalizeInstanceUpgrade({
  stateRoot = resolveStateRoot(),
  home,
  persistenceConfirmed = false,
  instanceId,
  operationId,
  taskId,
  plan,
  configPath,
  apiOrigin,
  currentReceiptPath,
  releasePointerPath,
  manifestPath,
  artifactFiles,
  fetchImpl = globalThis.fetch,
}) {
  const instance = requireUuid(instanceId, "instance_id");
  const operation = requireUuid(operationId, "operation_id");
  if (plan?.kind !== "deployed_instance_upgrade"
    || plan.instance_id !== instance
    || plan.target?.instance_id !== instance
    || plan.operation_id !== operation
    || plan.task_id !== taskId) {
    throw toolError("INVALID_UPGRADE_PLAN", "Upgrade finalization does not match the frozen task, operation, or Instance");
  }
  const origin = requireHttpsOrigin(apiOrigin, "api_origin");
  if (origin !== plan.target.api_origin) {
    throw toolError("DEPLOYMENT_ORIGIN_DRIFT", "Upgrade finalization origin differs from the frozen plan");
  }
  const journal = await assertJournalAuthorization({ stateRoot, instanceId: instance, operationId: operation, taskId, plan });
  const normalizedConfigPath = path.resolve(requireString(configPath, "config_path", { max: 4096 }));
  await assertNoSymlinkPath(normalizedConfigPath, stateRoot);
  const config = await readJson(normalizedConfigPath);
  const configEvent = [...journal.events].reverse().find((event) => event?.type === "wrangler_config_written") || null;
  assertUpgradeConfig(config, configEvent, plan, normalizedConfigPath);
  await verifyInstalledServiceBundle({
    bundleRoot: configEvent.service_bundle_root,
    expectedVersion: plan.release.service_bundle_version,
    expectedSha256: plan.release.service_bundle_sha256,
    expectedPublisher: plan.target.publisher,
    expectedSource: plan.target.service_bundle_source,
  });

  const releaseVersion = await readServiceReleaseVersion(configEvent.service_bundle_root, plan.release.service_bundle_version);
  await readServiceApiVersion(configEvent.service_bundle_root, {
    expectedReleaseVersion: plan.release.service_bundle_version,
    expectedApiVersion: plan.target.service_api_version,
    serviceApiRange: plan.target.compatibility.service_api,
  });

  const targetManifestPath = path.join(configEvent.service_bundle_root, "migrations", "manifest.json");
  const manifestBytes = await readFile(targetManifestPath);
  if (sha256Bytes(manifestBytes) !== plan.target.migration_manifest_sha256) {
    throw toolError("UPGRADE_MIGRATION_MANIFEST_DRIFT", "Target migration manifest differs from the frozen upgrade plan");
  }
  const migrationManifest = JSON.parse(manifestBytes.toString("utf8"));
  if (migrationManifest.schema_version !== plan.target.schema_version) {
    throw toolError("UPGRADE_MIGRATION_MANIFEST_DRIFT", "Target migration schema version differs from the upgrade plan");
  }
  const migrationReadback = assertMigrationReadback(journal, migrationManifest);
  const deploy = deploymentCompletion(journal, plan, configEvent.config_digest);
  const workerReadback = latestFinished(journal.events, "worker_deployment_readback");
  if (deploy === null
    || workerReadback?.event?.exit_code !== 0
    || workerReadback.index <= deploy.index
    || workerReadback.event.worker_deployment_readback === undefined) {
    throw toolError("WORKER_DEPLOYMENT_READBACK_REQUIRED", "Upgrade finalization requires a successful post-deploy Worker readback");
  }
  const afterWorker = workerReadback.event.worker_deployment_readback;
  if (plan.maintenance && canonicalDigest(afterWorker.maintenance_configuration ?? null) !== canonicalDigest({ crons: plan.maintenance.crons, verified: true })) {
    throw toolError("MAINTENANCE_READBACK_REQUIRED", "Upgrade finalization requires the exact maintenance schedule readback");
  }
  if (plan.current?.provenance === "remote_observed") {
    const attempt = findDeploymentAttempt(journal, plan, configEvent.config_digest);
    if (!attempt || !afterWorker.deployment_proof
      || canonicalDigest(afterWorker.deployment_proof) !== canonicalDigest(attempt.proof)
      || (deploy.recovered && (deploy.event.deployment_id !== afterWorker.deployment_id || deploy.event.version_id !== afterWorker.version_id))) {
      throw toolError("WORKER_DEPLOYMENT_READBACK_REQUIRED", "Upgrade finalization requires readback bound to the exact journaled deployment attempt");
    }
  }
  if (plan.usage_analytics && JSON.stringify(afterWorker.usage_configuration) !== JSON.stringify({ binding_verified: true })) throw toolError("USAGE_READBACK_REQUIRED", "Upgrade finalization requires usage binding readback");
  if (plan.cost_protection && (afterWorker.cost_configuration?.account_id !== plan.target.cloudflare_account_id || afterWorker.cost_configuration?.worker_name !== plan.resources.worker.name || JSON.stringify(afterWorker.cost_configuration?.worker_limits) !== JSON.stringify(plannedWorkerLimits(plan)))) throw toolError("WORKER_COST_READBACK_REQUIRED", "Upgrade finalization requires the exact planned Worker limits readback");
  const observability = normalizePlannedWorkerObservability(plan);
  if (observability !== undefined && (!Object.hasOwn(afterWorker.cost_configuration ?? {}, "observability") || canonicalDigest(normalizeObservedWorkerObservability(afterWorker.cost_configuration.observability)) !== canonicalDigest(observability))) throw toolError("WORKER_OBSERVABILITY_READBACK_REQUIRED", "Upgrade finalization requires the exact planned Observability readback");
  if (plan.public_access && (afterWorker.public_access_configuration?.verified !== true || afterWorker.public_access_configuration?.hostname !== plan.public_access.hostname || afterWorker.public_access_configuration?.workers_dev !== !plan.public_access.domain_enabled || afterWorker.public_access_configuration?.previews_enabled !== false || afterWorker.public_access_configuration?.waf_profile !== plan.public_access.waf_profile)) throw toolError("PUBLIC_ACCESS_READBACK_REQUIRED", "Upgrade finalization requires managed routing and WAF preservation readback");
  if (plan.resources.r2 && JSON.stringify(afterWorker.attachment_configuration) !== JSON.stringify({ bucket_name: plan.resources.r2.bucket_name, crons: [ATTACHMENT_CLEANUP_CRON], binding_verified: true })) throw toolError("R2_READBACK_REQUIRED", "Upgrade finalization requires post-deploy attachment binding and Cron readback");
  if (afterWorker.deployment_id === plan.resources.worker.current_deployment_id
    || afterWorker.version_id === plan.resources.worker.current_version_id) {
    throw toolError("WORKER_DEPLOYMENT_NOT_UPDATED", "Post-deploy Worker readback still identifies the prior deployment or version");
  }

  const normalizedCurrentReceiptPath = path.resolve(requireString(currentReceiptPath, "current_receipt_path", { max: 4096 }));
  await assertNoSymlinkPath(normalizedCurrentReceiptPath, stateRoot);
  const currentReceipt = await readJson(normalizedCurrentReceiptPath);
  assertPriorReceipt(currentReceipt, plan);

  const verifiedRelease = await loadAndVerifyRelease({ releasePointerPath, manifestPath, artifactFiles });
  const artifacts = assertReleaseMatchesPlan(verifiedRelease, plan);
  if (verifiedRelease.manifest.publisher?.canonical_origin !== plan.target.publisher
    || artifacts.service.source !== plan.target.service_bundle_source
    || verifiedRelease.manifest.compatibility?.service_api !== plan.target.compatibility.service_api
    || verifiedRelease.manifest.compatibility?.schema_version !== plan.target.schema_version) {
    throw toolError("DEPLOYMENT_RELEASE_DRIFT", "Verified target release differs from the authorized Instance upgrade");
  }
  const activeSkill = await loadActiveSkillEvidence(stateRoot);
  if (activeSkill.publisher !== plan.target.publisher) {
    throw toolError("PUBLISHER_DISCONTINUITY", "Active canonical Skill publisher differs from the Instance upgrade publisher");
  }

  const paths = getInstancePaths({ stateRoot, instanceId: instance });
  await assertNoSymlinkPath(paths.instanceMetadata, stateRoot);
  await validatePrivatePath(paths.instanceRoot, "directory");
  await validatePrivatePath(paths.instanceMetadata, "file");
  const trustedInstance = await readJson(paths.instanceMetadata);
  if (trustedInstance.instance_id !== instance
    || !Number.isSafeInteger(trustedInstance.origin_version)
    || trustedInstance.origin_version < 1) {
    throw toolError("STATE_INSTANCE_CONFLICT", "Trusted Instance metadata differs from its immutable state slot");
  }
  if (requireHttpsOrigin(trustedInstance.trusted_api_origin, "trusted_api_origin") !== origin) {
    throw toolError("TRUSTED_ORIGIN_BINDING_MISMATCH", "Upgrade finalization origin differs from the current trusted origin");
  }
  const currentCredential = await loadCurrentCredentialSecret({ stateRoot, instanceId: instance });
  const currentMetadata = currentCredential.metadata;
  if (currentMetadata.instance_id !== instance
    || currentMetadata.principal_id !== plan.owner.principal_id
    || currentMetadata.credential_id !== plan.owner.credential_id
    || currentMetadata.fingerprint !== plan.owner.credential_fingerprint
    || currentMetadata.state !== "current") {
    throw toolError("STATE_IDENTITY_CONFLICT", "Current local Owner Credential metadata differs from the upgrade plan");
  }
  const [health, rawDiscovery, meta, me] = await Promise.all([
    requestJson(origin, "/healthz", { fetchImpl }),
    fetchDiscovery(origin, fetchImpl),
    requestTrustedReadback({ stateRoot, instanceId: instance, origin, apiPath: "/api/v1/meta", token: currentCredential.token, fetchImpl }),
    requestTrustedReadback({ stateRoot, instanceId: instance, origin, apiPath: "/api/v1/me", token: currentCredential.token, fetchImpl }),
  ]);
  if (Boolean(meta.capabilities?.attachments) !== Boolean(plan.resources.r2)) throw toolError("R2_CAPABILITY_DRIFT", "Deployed attachment capability differs from the plan");
  const discovery = validateDiscovery(rawDiscovery, origin);
  if (discovery.origin_version < trustedInstance.origin_version) {
    throw toolError("DISCOVERY_VERSION_ROLLBACK", "Upgrade readback reported an older origin version than the current trusted Instance");
  }
  const identity = assertReadback({
    health,
    discovery,
    meta,
    me,
    facts: {
      instance,
      principalId: plan.owner.principal_id,
      credentialId: plan.owner.credential_id,
      displayName: plan.owner.display_name,
    },
    contract: {
      releaseVersion,
      serviceVersion: plan.target.service_api_version,
      schemaVersion: plan.target.schema_version,
    },
    origin,
  });
  if (identity.fingerprint !== plan.owner.credential_fingerprint) {
    throw toolError("DEPLOYMENT_OWNER_MISMATCH", "Authenticated Owner fingerprint differs from the upgrade plan");
  }

  const receiptPath = path.join(paths.receiptsRoot, operation + ".upgrade.json");
  await assertNoSymlinkPath(receiptPath, stateRoot);
  const existingReceipt = await readJson(receiptPath, { allowMissing: true });
  const expectedReceipt = {
    schema_version: 1,
    kind: "cfkanban_instance_upgrade_receipt",
    instance: {
      id: instance,
      api_origin: origin,
      origin_version: discovery.origin_version,
      service_version: plan.target.service_api_version,
      schema_version: plan.target.schema_version,
    },
    cloudflare: {
      account_id: plan.target.cloudflare_account_id,
      profile: plan.target.cloudflare_profile,
      worker: {
        name: plan.resources.worker.name,
        ...(plan.cost_protection ? { worker_limits: plan.cost_protection.worker_limits } : {}),
        ...(observability === undefined ? {} : { observability }),
        before_deployment_id: plan.resources.worker.current_deployment_id,
        before_version_id: plan.resources.worker.current_version_id,
        after_deployment_id: afterWorker.deployment_id,
        after_version_id: afterWorker.version_id,
      },
      ...(plan.public_access ? { public_access: plan.public_access } : {}),
      ...(plan.public_access_domain_receipt ? { public_access_domain_receipt: plan.public_access_domain_receipt } : {}),
      ...(plan.waf_authority ? { waf_authority: plan.waf_authority } : {}),
      ...(plan.usage_analytics ? { usage_analytics: plan.usage_analytics.configuration } : {}),
      ...(plan.resources.r2 ? { r2: { bucket_name: plan.resources.r2.bucket_name, instance_id: instance, public_access: false } } : {}),
      d1: {
        name: plan.resources.d1.name,
        database_id: plan.resources.d1.database_id,
      },
    },
    owner: {
      display_name: plan.owner.display_name,
      principal_id: plan.owner.principal_id,
      credential_id: plan.owner.credential_id,
      credential_fingerprint: plan.owner.credential_fingerprint,
    },
    service_release: {
      before: plan.current,
      after: {
        publisher: verifiedRelease.manifest.publisher.canonical_origin,
        manifest_version: verifiedRelease.manifest.release.version,
        manifest_sha256: verifiedRelease.pointer.manifest_sha256,
        service_bundle_version: artifacts.service.version,
        service_bundle_sha256: artifacts.service.sha256,
        service_bundle_source: artifacts.service.source,
        paired_skill_bundle_version: artifacts.skill.version,
        paired_skill_bundle_sha256: artifacts.skill.sha256,
      },
    },
    active_skill_runtime: activeSkill,
    migrations: {
      planned: plan.migrations.ordered,
      final_ledger: migrationReadback.latest.event.migration_readback.ledger,
      schema_verified: true,
    },
    restore_point: plan.restore_point,
    operation: {
      task_id: requireString(taskId, "task_id", { max: 256 }),
      operation_id: operation,
      plan_digest: canonicalDigest(plan),
      prior_receipt_path: normalizedCurrentReceiptPath,
    },
    verification: {
      canonical_release: true,
      worker_deployment_readback: true,
      ...(deploy.recovered ? { worker_deployment_recovered: true } : {}),
      health: true,
      d1_reachable: true,
      discovery: true,
      migration_ledger_and_schema: true,
      authenticated_meta: true,
      authenticated_me: true,
      checked_at: new Date().toISOString(),
    },
    rollback_boundary: plan.rollback_boundary,
    secret_values_exposed: false,
  };
  let resumed = false;
  if (existingReceipt === null) {
    await atomicWriteJson(receiptPath, expectedReceipt);
  } else {
    const expectedExisting = structuredClone(expectedReceipt);
    expectedExisting.verification.checked_at = existingReceipt.verification?.checked_at;
    if (canonicalDigest(existingReceipt) !== canonicalDigest(expectedExisting)) {
      throw toolError("UPGRADE_RECEIPT_DRIFT", "Existing upgrade receipt differs from the verified operation result");
    }
    resumed = true;
  }
  await putInstanceMetadata({
    stateRoot,
    ...(home === undefined ? {} : { home }),
    persistenceConfirmed,
    instanceId: instance,
    trustedApiOrigin: origin,
    originVersion: discovery.origin_version,
    serviceVersion: plan.target.service_api_version,
    schemaVersion: plan.target.schema_version,
    publisher: plan.target.publisher,
  });
  const finalizedEvent = [...journal.events].reverse().find((event) => event?.type === "upgrade_finalized") || null;
  if (finalizedEvent === null) {
    await appendJournalEvent({
      stateRoot,
      instanceId: instance,
      operationId: operation,
      event: {
        type: "upgrade_finalized",
        receipt_path: receiptPath,
        before_service_bundle_version: plan.current.service_bundle_version,
        after_service_bundle_version: plan.target.service_bundle_version,
        worker_deployment_id: afterWorker.deployment_id,
        secret_values_exposed: false,
      },
    });
  } else if (finalizedEvent.receipt_path !== receiptPath
    || finalizedEvent.before_service_bundle_version !== plan.current.service_bundle_version
    || finalizedEvent.after_service_bundle_version !== plan.target.service_bundle_version
    || finalizedEvent.worker_deployment_id !== afterWorker.deployment_id
    || finalizedEvent.secret_values_exposed !== false) {
    throw toolError("UPGRADE_FINALIZATION_DRIFT", "Journaled upgrade finalization differs from the verified operation result");
  }
  return {
    finalized: true,
    resumed,
    instance_id: instance,
    api_origin: origin,
    service_bundle_version: plan.target.service_bundle_version,
    service_api_version: plan.target.service_api_version,
    schema_version: plan.target.schema_version,
    worker_deployment_id: afterWorker.deployment_id,
    worker_version_id: afterWorker.version_id,
    receipt_path: receiptPath,
    active_skill_version: activeSkill.version,
    credential_unchanged: true,
    upgrade_notification: await notifyVerifiedUpgrade({ stateRoot, instanceId: instance, operationId: operation, journal,
      origin, owner: plan.owner, previousVersion: plan.current.service_bundle_version, releaseVersion,
      schemaVersion: plan.target.schema_version, deploymentId: afterWorker.deployment_id, workerVersionId: afterWorker.version_id,
      token: currentCredential.token, fetchImpl }),
    secret_values_exposed: false,
  };
}
