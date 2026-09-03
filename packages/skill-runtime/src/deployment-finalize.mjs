import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import { appendJournalEvent } from "./journal.mjs";
import {
  getInstancePaths,
  loadCurrentCredentialSecret,
  loadPendingCredentialSecret,
  promotePendingCredential,
  putInstanceMetadata,
} from "./state.mjs";
import {
  loadAuthorizedDeploymentContract,
  ownerDeploymentFacts,
} from "./bootstrap-sql.mjs";
import { fetchDiscovery, validateDiscovery } from "./rebind.mjs";
import { loadAndVerifyRelease } from "./release.mjs";
import { treeDigest } from "./skill-update.mjs";
import { toolError } from "./errors.mjs";
import {
  assertNoSymlinkPath,
  atomicWriteJson,
  canonicalDigest,
  readJson,
  requireHttpsOrigin,
  requireString,
  requireUuid,
} from "./utils.mjs";

function digest(value, name) {
  const result = requireString(value, name, { max: 64 });
  if (!/^[a-f0-9]{64}$/u.test(result)) throw toolError("INVALID_DIGEST", `${name} must be a lowercase SHA-256 digest`);
  return result;
}

function matchingOwnerCredential(metadata, facts) {
  return metadata?.instance_id === facts.instance
    && metadata?.operation_id === facts.operation
    && metadata?.principal_id === facts.principalId
    && metadata?.credential_id === facts.credentialId
    && metadata?.purpose === "owner_bootstrap";
}

async function requestJson(origin, apiPath, { token = null, fetchImpl }) {
  const headers = new Headers({ accept: "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  let response;
  try {
    response = await fetchImpl(new URL(apiPath, origin), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw toolError("DEPLOYMENT_READBACK_FAILED", "Deployment finalization could not reach an exact readback endpoint", { apiPath, reason: error instanceof Error ? error.name : "unknown" }, error);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || response.status >= 300 && response.status < 400 || !contentType.includes("application/json")) {
    throw toolError("DEPLOYMENT_READBACK_FAILED", "Deployment finalization did not receive a direct JSON success response", { apiPath, status: response.status });
  }
  try {
    return await response.json();
  } catch (error) {
    throw toolError("DEPLOYMENT_READBACK_FAILED", "Deployment finalization received invalid JSON", { apiPath }, error);
  }
}

function assertReleaseMatchesPlan(verified, plan) {
  if (verified.pointer?.manifest_sha256 !== plan.release?.manifest_sha256
    || verified.manifest?.release?.version !== plan.release?.manifest_version) {
    throw toolError("DEPLOYMENT_RELEASE_DRIFT", "Verified release pointer or manifest does not match the authorized deployment plan");
  }
  const service = verified.artifacts.find((artifact) => artifact.kind === "service_deployment_bundle");
  const skill = verified.artifacts.find((artifact) => artifact.kind === "skill_bundle");
  if (service?.version !== plan.release?.service_bundle_version
    || service?.sha256 !== plan.release?.service_bundle_sha256
    || skill === undefined) {
    throw toolError("DEPLOYMENT_RELEASE_DRIFT", "Verified release artifacts do not match the authorized deployment plan");
  }
  return { service, skill };
}

async function loadActiveSkillEvidence(stateRoot) {
  const releaseRoot = path.join(stateRoot, "skill-releases");
  const activePath = path.join(releaseRoot, "active.json");
  await assertNoSymlinkPath(activePath, stateRoot);
  const active = await readJson(activePath);
  const releasePath = path.resolve(requireString(active.release_path || active.path, "active_skill_release_path", { max: 4096 }));
  await assertNoSymlinkPath(releasePath, releaseRoot);
  const skillReceiptPath = path.join(releasePath, ".cfkanban-release.json");
  await assertNoSymlinkPath(skillReceiptPath, releaseRoot);
  const receipt = await readJson(skillReceiptPath);
  const actualTreeDigest = await treeDigest(releasePath);
  if (actualTreeDigest !== digest(active.tree_digest, "active_skill_tree_digest")
    || active.version !== receipt.version
    || active.artifact_sha256 !== receipt.artifact_sha256) {
    throw toolError("LOCAL_SKILL_MODIFIED", "The active canonical Skill release does not match its local receipt");
  }
  const publisher = requireHttpsOrigin(
    typeof receipt.publisher === "string" ? receipt.publisher : receipt.publisher?.canonical_origin,
    "active_skill_publisher",
  );
  const source = new URL(requireString(receipt.source, "active_skill_source", { max: 4096 }));
  if (source.protocol !== "https:") throw toolError("LOCAL_SKILL_MODIFIED", "Active Skill source must use HTTPS");
  return {
    version: requireString(active.version, "active_skill_version", { max: 128 }),
    artifact_sha256: digest(active.artifact_sha256, "active_skill_artifact_sha256"),
    tree_digest: actualTreeDigest,
    publisher,
    source: source.href,
  };
}

function assertReadback({ health, discovery, meta, me, facts, contract, origin }) {
  if (health?.d1 !== "reachable"
    || health.service_version !== contract.serviceVersion
    || health.schema_version !== contract.schemaVersion) {
    throw toolError("DEPLOYMENT_HEALTH_MISMATCH", "Worker health does not match the verified Service bundle");
  }
  if (discovery.instance_id !== facts.instance
    || discovery.preferred_api_origin !== origin
    || discovery.service_version !== contract.serviceVersion
    || discovery.origin_version < 1) {
    throw toolError("DEPLOYMENT_DISCOVERY_MISMATCH", "Public discovery does not match the authorized deployment");
  }
  if (meta?.instance_id !== facts.instance
    || meta.observed_origin !== origin
    || meta.preferred_api_origin !== origin
    || meta.origin_version !== discovery.origin_version
    || meta.service_version !== contract.serviceVersion
    || meta.schema_version !== contract.schemaVersion
    || meta.principal?.id !== facts.principalId
    || meta.principal?.is_owner !== true) {
    throw toolError("DEPLOYMENT_META_MISMATCH", "Authenticated /meta does not verify the exact Instance and Owner");
  }
  if (me?.id !== facts.principalId
    || me.principal_id !== facts.principalId
    || me.display_name !== facts.displayName
    || me.is_owner !== true
    || me.credential?.id !== facts.credentialId) {
    throw toolError("DEPLOYMENT_OWNER_MISMATCH", "Authenticated /me does not verify the exact Owner Principal and Credential");
  }
  const fingerprint = requireString(me.credential?.fingerprint, "credential_fingerprint", { max: 128 });
  return { fingerprint };
}

export async function finalizeOwnerDeployment({
  stateRoot = resolveStateRoot(),
  home,
  persistenceConfirmed = false,
  instanceId,
  operationId,
  taskId,
  plan,
  configPath,
  apiOrigin,
  releasePointerPath,
  manifestPath,
  artifactFiles,
  fetchImpl = globalThis.fetch,
}) {
  const facts = ownerDeploymentFacts(plan, instanceId, operationId);
  const origin = requireHttpsOrigin(apiOrigin, "api_origin");
  if (!origin.endsWith(".workers.dev")) {
    throw toolError("STRICT_ZERO_PLAN_REQUIRED", "Initial strict-zero finalization requires the deployed workers.dev origin");
  }
  const contract = await loadAuthorizedDeploymentContract({ stateRoot, facts, taskId, plan, configPath });
  const bootstrapAttempt = [...contract.journal.events].reverse().find((event) => (event?.type === "command_started" || event?.type === "command_finished") && event.action === "bootstrap_owner") || null;
  if (bootstrapAttempt === null) {
    throw toolError("OWNER_BOOTSTRAP_READBACK_REQUIRED", "Deployment finalization requires a journaled Owner bootstrap attempt before remote identity readback");
  }

  const verifiedRelease = await loadAndVerifyRelease({ releasePointerPath, manifestPath, artifactFiles });
  const artifacts = assertReleaseMatchesPlan(verifiedRelease, plan);
  if (verifiedRelease.manifest.compatibility?.schema_version !== contract.schemaVersion) {
    throw toolError("DEPLOYMENT_RELEASE_DRIFT", "Release manifest schema compatibility differs from the deployed Service bundle");
  }
  const activeSkill = await loadActiveSkillEvidence(stateRoot);
  const releasePublisher = requireHttpsOrigin(verifiedRelease.manifest.publisher.canonical_origin, "release_publisher");
  const allowedArtifactOrigins = new Set(verifiedRelease.manifest.artifacts.flatMap((artifact) => artifact.allowed_origins));
  if (activeSkill.publisher !== releasePublisher || !allowedArtifactOrigins.has(new URL(activeSkill.source).origin)) {
    throw toolError("PUBLISHER_DISCONTINUITY", "The active canonical Skill does not share the authorized release publisher and artifact origin");
  }
  const paths = getInstancePaths({ stateRoot, instanceId: facts.instance });
  const [pendingMetadata, currentMetadata] = await Promise.all([
    readJson(paths.pendingMetadata, { allowMissing: true }),
    readJson(paths.currentMetadata, { allowMissing: true }),
  ]);
  const usePending = pendingMetadata !== null;
  const localMetadata = usePending ? pendingMetadata : currentMetadata;
  if (localMetadata === null || !matchingOwnerCredential(localMetadata, facts)) {
    throw toolError("STATE_IDENTITY_CONFLICT", "No exact pending or current Owner Credential matches the authorized deployment plan");
  }
  if (pendingMetadata !== null && currentMetadata !== null && !matchingOwnerCredential(currentMetadata, facts)) {
    throw toolError("STATE_IDENTITY_CONFLICT", "Pending and current local Credential slots disagree during deployment recovery");
  }
  const localCredential = usePending
    ? await loadPendingCredentialSecret({ stateRoot, instanceId: facts.instance })
    : await loadCurrentCredentialSecret({ stateRoot, instanceId: facts.instance });

  const [health, rawDiscovery, meta, me] = await Promise.all([
    requestJson(origin, "/healthz", { fetchImpl }),
    fetchDiscovery(origin, fetchImpl),
    requestJson(origin, "/api/v1/meta", { token: localCredential.token, fetchImpl }),
    requestJson(origin, "/api/v1/me", { token: localCredential.token, fetchImpl }),
  ]);
  const discovery = validateDiscovery(rawDiscovery, origin);
  const readback = assertReadback({ health, discovery, meta, me, facts, contract, origin });
  if (readback.fingerprint !== localMetadata.fingerprint) {
    throw toolError("DEPLOYMENT_OWNER_MISMATCH", "Authenticated /me fingerprint does not match the private local Credential");
  }

  await putInstanceMetadata({
    stateRoot,
    ...(home === undefined ? {} : { home }),
    persistenceConfirmed,
    instanceId: facts.instance,
    trustedApiOrigin: origin,
    originVersion: discovery.origin_version,
    serviceVersion: contract.serviceVersion,
    schemaVersion: contract.schemaVersion,
    publisher: verifiedRelease.manifest.publisher.canonical_origin,
  });
  const promoted = usePending
    ? await promotePendingCredential({
      stateRoot,
      instanceId: facts.instance,
      principalId: facts.principalId,
      credentialId: facts.credentialId,
      fingerprint: readback.fingerprint,
    })
    : currentMetadata;

  const receiptPath = path.join(paths.receiptsRoot, `${facts.operation}.deployment.json`);
  await assertNoSymlinkPath(receiptPath, stateRoot);
  const existingReceipt = await readJson(receiptPath, { allowMissing: true });
  const planDigest = canonicalDigest(plan);
  const receipt = existingReceipt || {
    schema_version: 1,
    kind: "cfkanban_deployment_receipt",
    instance: {
      id: facts.instance,
      api_origin: origin,
      origin_version: discovery.origin_version,
      service_version: contract.serviceVersion,
      schema_version: contract.schemaVersion,
    },
    cloudflare: {
      account_id: requireString(plan.target.cloudflare_account_id, "cloudflare_account_id", { max: 128 }),
      profile: plan.target.cloudflare_profile ?? null,
      worker: { name: plan.resources.worker.name },
      d1: { name: plan.resources.d1.name, database_id: requireUuid(contract.config.d1_databases[0].database_id, "d1_database_id") },
    },
    owner: {
      display_name: facts.displayName,
      principal_id: facts.principalId,
      credential_id: facts.credentialId,
      credential_fingerprint: readback.fingerprint,
    },
    service_release: {
      publisher: verifiedRelease.manifest.publisher.canonical_origin,
      manifest_version: verifiedRelease.manifest.release.version,
      manifest_sha256: verifiedRelease.pointer.manifest_sha256,
      service_bundle_version: artifacts.service.version,
      service_bundle_sha256: artifacts.service.sha256,
      service_bundle_source: artifacts.service.source,
      paired_skill_bundle_version: artifacts.skill.version,
      paired_skill_bundle_sha256: artifacts.skill.sha256,
    },
    active_skill_runtime: activeSkill,
    operation: {
      task_id: requireString(taskId, "task_id", { max: 256 }),
      operation_id: facts.operation,
      plan_digest: planDigest,
    },
    verification: {
      health: true,
      d1_reachable: true,
      discovery: true,
      migration_ledger_and_schema: true,
      authenticated_meta: true,
      authenticated_me: true,
      checked_at: new Date().toISOString(),
    },
    next_prompt: "Use $cfkanban-admin to create my first cfKanban board.",
    secret_values_exposed: false,
  };
  if (existingReceipt !== null) {
    const receiptText = JSON.stringify(existingReceipt);
    const recordedFinalization = [...contract.journal.events].reverse().find((event) => event?.type === "deployment_finalized") || null;
    const recordedReceiptMatches = recordedFinalization === null
      ? existingReceipt.active_skill_runtime?.version === activeSkill.version
        && existingReceipt.active_skill_runtime?.artifact_sha256 === activeSkill.artifact_sha256
        && existingReceipt.active_skill_runtime?.tree_digest === activeSkill.tree_digest
      : recordedFinalization.receipt_path === receiptPath
        && recordedFinalization.receipt_digest === canonicalDigest(existingReceipt);
    const receiptMatches = existingReceipt.schema_version === 1
      && existingReceipt.kind === "cfkanban_deployment_receipt"
      && existingReceipt.instance?.id === facts.instance
      && existingReceipt.instance?.api_origin === origin
      && existingReceipt.instance?.origin_version === discovery.origin_version
      && existingReceipt.instance?.service_version === contract.serviceVersion
      && existingReceipt.instance?.schema_version === contract.schemaVersion
      && existingReceipt.cloudflare?.account_id === plan.target.cloudflare_account_id
      && existingReceipt.cloudflare?.profile === (plan.target.cloudflare_profile ?? null)
      && existingReceipt.cloudflare?.worker?.name === plan.resources.worker.name
      && existingReceipt.cloudflare?.d1?.name === plan.resources.d1.name
      && existingReceipt.cloudflare?.d1?.database_id === contract.config.d1_databases[0].database_id
      && existingReceipt.owner?.display_name === facts.displayName
      && existingReceipt.owner?.principal_id === facts.principalId
      && existingReceipt.owner?.credential_id === facts.credentialId
      && existingReceipt.owner?.credential_fingerprint === readback.fingerprint
      && existingReceipt.service_release?.publisher === verifiedRelease.manifest.publisher.canonical_origin
      && existingReceipt.service_release?.manifest_version === verifiedRelease.manifest.release.version
      && existingReceipt.service_release?.manifest_sha256 === plan.release.manifest_sha256
      && existingReceipt.service_release?.service_bundle_version === artifacts.service.version
      && existingReceipt.service_release?.service_bundle_sha256 === artifacts.service.sha256
      && existingReceipt.service_release?.service_bundle_source === artifacts.service.source
      && existingReceipt.service_release?.paired_skill_bundle_version === artifacts.skill.version
      && existingReceipt.service_release?.paired_skill_bundle_sha256 === artifacts.skill.sha256
      && existingReceipt.operation?.task_id === taskId
      && existingReceipt.operation?.operation_id === facts.operation
      && existingReceipt.operation?.plan_digest === planDigest
      && existingReceipt.next_prompt === "Use $cfkanban-admin to create my first cfKanban board."
      && existingReceipt.secret_values_exposed === false
      && recordedReceiptMatches
      && !/cfk_v1_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43,512}/u.test(receiptText);
    if (!receiptMatches) {
      throw toolError("DEPLOYMENT_RECEIPT_CONFLICT", "Existing deployment receipt does not match the verified deployment");
    }
  }
  if (existingReceipt === null) await atomicWriteJson(receiptPath, receipt);
  const receiptDigest = canonicalDigest(receipt);
  const alreadyFinalized = contract.journal.events.some((event) => event?.type === "deployment_finalized" && event.receipt_digest === receiptDigest);
  if (!alreadyFinalized) {
    await appendJournalEvent({
      stateRoot,
      instanceId: facts.instance,
      operationId: facts.operation,
      event: {
        type: "deployment_finalized",
        receipt_path: receiptPath,
        receipt_digest: receiptDigest,
        instance_id: facts.instance,
        api_origin: origin,
        owner_principal_id: facts.principalId,
        credential_id: facts.credentialId,
        credential_fingerprint: readback.fingerprint,
        secret_values_exposed: false,
      },
    });
  }
  return {
    finalized: true,
    resumed: !usePending || existingReceipt !== null,
    instance_id: facts.instance,
    api_origin: origin,
    owner_principal_id: facts.principalId,
    credential_id: facts.credentialId,
    credential_fingerprint: promoted.fingerprint,
    credential_state: promoted.state,
    receipt_path: receiptPath,
    receipt_digest: receiptDigest,
    active_skill_version: activeSkill.version,
    service_bundle_version: artifacts.service.version,
    next_prompt: receipt.next_prompt,
    secret_values_exposed: false,
  };
}
