import { prepareOwnerDevice, inspectOwnerDeviceRequest, approveOwnerDevice, verifyOwnerDevice, listOwnerDevices, revokeOwnerDevice, restorePreviousOwnerDeviceIdentity } from "./owner-devices.mjs";
import { inspectDeploymentAttachment, createDeploymentAttachmentPlan, attachDeployment } from "./deployment-attach.mjs";
import { preflightBrowser } from "./browser-preflight.mjs";
import { discoverOwnerRecoveryCandidates } from "./owner-recovery-discovery.mjs";
import { createOwnerRecoveryPlan, executeOwnerRecovery, inspectOwnerRecovery } from "./owner-recovery.mjs";
import { resolveWebInstance } from "./web-resolve.mjs";
import { openWeb } from "./web-open.mjs";
import { downloadAttachment, uploadAttachment } from "./attachments.mjs";
import { provisionR2Storage, readR2Storage } from "./r2-storage.mjs";
import { buildCapabilityReport } from "./capabilities.mjs";
import { createBrowserLaunchAndDeliver, createInvitationAndDeliver, guardedApiRequest } from "./capability-delivery.mjs";
import { redeemInvitation, redeemPublicJoin, rotateOwnerCredential, verifyPendingCredential } from "./credential-operations.mjs";
import { serializeError, toolError } from "./errors.mjs";
import { authorizeJournal, createJournal } from "./journal.mjs";
import { assessMigrationLedgerRecovery, reconcileMigrationState, writeMigrationLedgerRecordSql } from "./migrations.mjs";
import { comparePlans, createInstanceUpgradePlan, createSkillUpdatePlan, createStrictZeroPlan } from "./plan.mjs";
import { checkTrustedOriginRebind } from "./rebind.mjs";
import { loadAndVerifyRelease, verifyPublisherContinuity } from "./release.mjs";
import { discoverRelease } from "./release-discovery.mjs";
import { inspectScopeDirectory, mergeRepoScope, readRepoScope, resolveScope } from "./scope.mjs";
import {
  clearPendingCredential,
  inspectInstanceState,
  initializeStateRoot,
  preparePendingCredential,
  putInstanceMetadata,
} from "./state.mjs";
import { prepareOwnerCredential, writeOwnerBootstrapSql } from "./bootstrap-sql.mjs";
import { finalizeOwnerDeployment } from "./deployment-finalize.mjs";
import { finalizeInstanceUpgrade } from "./instance-upgrade.mjs";
import { executeWranglerAction, readD1ResourceByName, readD1RestorePoint, readWorkerResourceByName, readWorkerVersionById, readWranglerAccountAccess } from "./deploy.mjs";
import { writeFrozenWranglerConfig } from "./deployment-config.mjs";
import { installVerifiedServiceBundle } from "./service-bundle.mjs";
import { installVerifiedSkillBundle } from "./skill-update.mjs";
import {
  createCloudflareAuthPlan,
  createToolRuntimePlan,
  executeCloudflareAuthAction,
  inspectCloudflareAuth,
  installToolRuntime,
  resolveCloudflareAuth,
  resolveWrangler,
} from "./tool-runtime.mjs";
import { canonicalDigest } from "./utils.mjs";
import { inspectPublicAccess, createPublicAccessPlan, applyPublicAccess } from "./public-access.mjs";
import { inspectWafTarget, createLegacyWafTargetPlan, applyWafTarget } from "./waf-target.mjs";
import { readWorkerCostSettings } from "./worker-cost-settings.mjs";

const ALL_SURFACES = Object.freeze(["daily", "admin", "deploy"]);

function command({ description, effect, inputFields = [], output = "ordinary", surfaces = ALL_SURFACES, run }) {
  return Object.freeze({ description, effect, inputFields: Object.freeze(inputFields), output, surfaces: Object.freeze(surfaces), run });
}

const COMMANDS = new Map([
  ["runtime worker-cost-settings", command({ description: "Read the selected Worker's limits and Observability without changing a subscription or settings.", effect: "read_only_control_plane", inputFields: ["accountId", "workerName", "wranglerExecutable", "cloudflareProfile", "contextDirectory"], surfaces: ["deploy"], run: readWorkerCostSettings })],
  ["public-access inspect", command({ description: "Read one receipt-bound hostname, Workers exposure and optional WAF inventory without writes.", effect: "read_only_control_plane_and_authenticated_http", inputFields: ["instanceId", "receiptPath", "zoneId", "hostname", "wranglerExecutable", "cloudflareProfile", "contextDirectory", "includeWaf"], surfaces: ["deploy"], run: inspectPublicAccess })],
  ["plan public-access", command({ description: "Plan a custom-domain enable or explicit rollback; legacy owned-rule cleanup is retained only for rollback.", effect: "read_control_plane_and_register_service_plan", inputFields: ["instanceId", "taskId", "operationId", "receiptPath", "zoneId", "hostname", "wranglerExecutable", "cloudflareProfile", "contextDirectory", "mode", "passkeyRecoveryReady", "conflictChoice"], surfaces: ["deploy"], run: createPublicAccessPlan })],
  ["public-access apply", command({ description: "Apply or resume only the exact authorized public-access journal, verifying origin trust and owned resources.", effect: "authorized_cloudflare_and_origin_writes", inputFields: ["instanceId", "operationId", "taskId", "plan"], surfaces: ["deploy"], run: applyPublicAccess })],
  ["waf-target inspect", command({ description: "Verify one existing preferred hostname and exact deployment target without changing its mapping.", effect: "read_only_control_plane_and_authenticated_http", inputFields: ["instanceId", "receiptPath", "zoneId", "hostname", "wranglerExecutable", "cloudflareProfile", "contextDirectory"], surfaces: ["deploy"], run: inspectWafTarget })],
  ["plan waf-target", command({ description: "Legacy upgrade recovery only: import an exact existing private domain ownership receipt; no new WAF setup.", effect: "read_only_control_plane_and_plan", inputFields: ["instanceId", "taskId", "operationId", "receiptPath", "zoneId", "hostname", "wranglerExecutable", "cloudflareProfile", "contextDirectory"], surfaces: ["deploy"], run: createLegacyWafTargetPlan })],
  ["waf-target apply", command({ description: "Register or recover the original approved non-secret WAF target using guarded atomic D1 statements.", effect: "authorized_non_secret_d1_registration", inputFields: ["instanceId", "taskId", "operationId", "plan"], surfaces: ["deploy"], run: applyWafTarget })],
  ["web open", command({ description: "Open the shared local project/Issue workbench by default, or explicitly choose online Browser Launch. Supply the user's actual working directory for local mode. Preflight the requested browser; keep the local process alive until closed. Management targets require online mode.", effect: "local_web_service_or_authenticated_browser_delivery", inputFields: ["mode", "directory", "instanceId", "target", "delivery", "idempotencyKey", "sensitiveOutputAcknowledgement"], output: "conditional_one_time_capability", surfaces: ["daily", "admin"], run: openWeb })],
  ["capabilities", command({ description: "Inspect the current host, paths, and PATH-level tools without installing anything; Wrangler usability still requires runtime resolve-wrangler.", effect: "read_only", run: buildCapabilityReport })],
  ["state init", command({ description: "Create and verify the private cfKanban user root.", effect: "local_write", inputFields: ["home", "repoRoot", "persistenceConfirmed"], run: initializeStateRoot })],
  ["state put-instance", command({ description: "Store non-secret metadata for one trusted instance.", effect: "local_write", inputFields: ["instanceId", "trustedApiOrigin", "originVersion"], surfaces: ["daily", "deploy"], run: putInstanceMetadata })],
  ["state inspect", command({ description: "Inspect one local instance slot without returning Credential values.", effect: "local_state_check", inputFields: ["instanceId"], run: inspectInstanceState })],
  ["credential prepare", command({ description: "Generate a Credential directly into the private pending slot and return only its safe metadata view.", effect: "local_secret_write", inputFields: ["instanceId", "principalId", "operationId", "idempotencyKey", "purpose"], run: preparePendingCredential })],
  ["credential verify-and-promote", command({ description: "Authenticate with the pending Credential, require consistent /me Principal IDs, an explicit Owner flag, the exact fingerprint, and any plan-bound Credential ID before promotion.", effect: "authenticated_read_and_local_secret_write", inputFields: ["instanceId"], run: verifyPendingCredential })],
  ["credential clear", command({ description: "Clear a pending Credential only after remote non-commit is proven.", effect: "local_secret_delete", inputFields: ["instanceId", "committedStateKnownFalse"], run: clearPendingCredential })],
  ["invite redeem", command({ description: "Redeem one Project or recovery Invite while injecting any pending Credential internally.", effect: "single_remote_write_and_local_credential_promotion", inputFields: ["instanceId", "inviteCode", "redeemAs", "displayName", "idempotencyKey"], surfaces: ["daily"], run: redeemInvitation })],
  ["public-join redeem", command({ description: "Join one public Project with an explicit role while injecting any pending Credential internally.", effect: "single_remote_write_and_local_credential_promotion", inputFields: ["instanceId", "publicId", "role", "redeemAs", "displayName", "idempotencyKey"], surfaces: ["daily"], run: redeemPublicJoin })],
  ["attachment upload", command({ description: "Upload one explicitly selected local file through a resumable reservation and binary transfer; never return file bytes or Credentials.", effect: "authenticated_remote_writes_and_local_file_read", inputFields: ["instanceId", "identifier", "filePath", "idempotencyKey", "attachmentId", "firstAttemptAt"], surfaces: ["daily"], run: uploadAttachment })],
  ["attachment download", command({ description: "Download one private attachment to an explicit new local path after verifying size and SHA-256; never overwrite or open the file.", effect: "authenticated_remote_read_and_local_file_write", inputFields: ["instanceId", "attachmentId", "outputPath"], surfaces: ["daily"], run: downloadAttachment })],
  ["owner-recovery discover", command({ description: "Find verified cfKanban recovery candidates in one selected Cloudflare account, excluding unrelated Workers and reporting unresolved resources without choosing among instances.", effect: "read_only_control_plane_and_public_http", inputFields: ["accountId", "wranglerExecutable", "cloudflareProfile", "contextDirectory", "workerNames"], surfaces: ["deploy"], run: discoverOwnerRecoveryCandidates })],
  ["owner-recovery inspect", command({ description: "Read the exact Cloudflare Worker/D1, existing Owner and public origin without an application Credential.", effect: "read_only_control_plane_and_public_http", inputFields: ["instanceId", "accountId", "workerName", "d1Name", "databaseId", "apiOrigin", "wranglerExecutable", "cloudflareProfile", "contextDirectory"], surfaces: ["deploy"], run: inspectOwnerRecovery })],
  ["plan owner-recovery", command({ description: "Read back an existing deployment and freeze a same-Owner total-loss recovery plan; revoke all prior API Credentials and preserve Passkeys.", effect: "read_only_control_plane_and_plan", inputFields: ["taskId", "instanceId", "accountId", "workerName", "d1Name", "databaseId", "apiOrigin", "wranglerExecutable", "cloudflareProfile", "contextDirectory"], surfaces: ["deploy"], run: createOwnerRecoveryPlan })],
  ["owner-recovery execute", command({ description: "Execute or resume authorized same-Owner recovery through one guarded D1 query batch, then verify and promote the private replacement Credential.", effect: "authorized_cloudflare_credential_recovery_and_local_secret_write", inputFields: ["instanceId", "operationId", "taskId", "plan"], surfaces: ["deploy"], run: executeOwnerRecovery })],
  ["owner-device prepare", command({ description: "Prepare a private pending Owner Credential, optionally binding an explicit current-identity replacement; return only a one-hour non-secret pairing request.", effect: "credential_free_read_and_local_secret_write", inputFields: ["instanceId", "apiOrigin", "ownerPrincipalId", "deviceName", "operationId", "idempotencyKey", "expiresInSeconds", "persistenceConfirmed", "replaceCurrent", "expectedCurrentPrincipalId", "expectedCurrentCredentialId"], surfaces: ["admin"], run: prepareOwnerDevice })],
  ["owner-device request", command({ description: "Read the existing private pending device request without generating or exposing a secret.", effect: "local_state_check", inputFields: ["instanceId"], surfaces: ["admin"], run: inspectOwnerDeviceRequest })],
  ["owner-device approve", command({ description: "Approve an explicitly authorized non-secret device request as the existing Owner; preserve the prior Credential and freeze retries.", effect: "authenticated_remote_write_and_local_retry_record", inputFields: ["instanceId", "request"], surfaces: ["admin"], run: approveOwnerDevice })],
  ["owner-device verify", command({ description: "Verify the pending device's exact Instance, Owner, Credential ID and fingerprint before promoting it locally.", effect: "authenticated_read_and_local_secret_promotion", inputFields: ["instanceId"], surfaces: ["admin"], run: verifyOwnerDevice })],
  ["owner-device restore-previous", command({ description: "Verify and restore the one explicitly saved previous identity, preserving the current Credential in its place; resume the same bound transaction on interruption.", effect: "authenticated_read_and_local_identity_switch", inputFields: ["instanceId", "expectedCurrentPrincipalId", "expectedCurrentCredentialId"], surfaces: ["admin"], run: restorePreviousOwnerDeviceIdentity })],
  ["owner-device list", command({ description: "List the current Owner's device Credential summaries without secrets.", effect: "authenticated_read", inputFields: ["instanceId", "cursor"], surfaces: ["admin"], run: listOwnerDevices })],
  ["owner-device revoke", command({ description: "Revoke one other Owner device Credential; reject the current device and preserve Passkeys.", effect: "authenticated_remote_write_and_local_retry_record", inputFields: ["instanceId", "credentialId", "idempotencyKey"], surfaces: ["admin"], run: revokeOwnerDevice })],
  ["deployment inspect-existing", command({ description: "Read the exact existing Worker/D1, migration baseline, origin and available Owner identity without changing remote resources.", effect: "read_only_control_plane_and_http", inputFields: ["instanceId", "accountId", "workerName", "d1Name", "databaseId", "apiOrigin", "wranglerExecutable", "cloudflareProfile", "contextDirectory", "baselineBundle", "publisher", "publicAccessReceipt"], surfaces: ["deploy"], run: inspectDeploymentAttachment })],
  ["plan deployment-attachment", command({ description: "Freeze a local attachment plan from fresh remote evidence, without claiming historical artifact provenance.", effect: "read_only_control_plane_and_plan", inputFields: ["taskId", "instanceId", "accountId", "workerName", "d1Name", "databaseId", "apiOrigin", "wranglerExecutable", "cloudflareProfile", "contextDirectory", "baselineBundle", "publisher", "publicAccessReceipt"], surfaces: ["deploy"], run: createDeploymentAttachmentPlan })],
  ["deployment attach", command({ description: "Recheck an authorized attachment plan and save a private non-secret maintenance receipt; no remote writes or Credential issuance.", effect: "authorized_local_receipt_write_and_remote_readback", inputFields: ["instanceId", "operationId", "taskId", "plan"], surfaces: ["deploy"], run: attachDeployment })],
  ["owner rotate-credential", command({ description: "Rotate the Owner Credential by reading current and pending secrets internally, then verify and promote.", effect: "authenticated_remote_secret_rotation_and_local_promotion", inputFields: ["instanceId"], surfaces: ["admin"], run: rotateOwnerCredential })],
  ["deployment prepare-owner-credential", command({ description: "Prepare or resume the exact private pending Owner Credential from an authorized strict-zero plan.", effect: "authorized_local_secret_write", inputFields: ["instanceId", "operationId", "taskId", "plan"], surfaces: ["deploy"], run: prepareOwnerCredential })],
  ["bootstrap write-owner-sql", command({ description: "Write plan-bound private hash-only SQL for first Owner bootstrap after migration and Worker readback.", effect: "authorized_local_secret_derived_write", inputFields: ["instanceId", "operationId", "taskId", "plan", "configPath", "preferredApiOrigin"], surfaces: ["deploy"], run: writeOwnerBootstrapSql })],
  ["deployment finalize-owner", command({ description: "Verify release/config/journal, public discovery, health, authenticated Instance/Owner identity, then promote the exact Credential and write a redacted receipt.", effect: "credential_free_and_authenticated_readback_then_local_secret_promotion", inputFields: ["instanceId", "operationId", "taskId", "plan", "configPath", "apiOrigin", "releasePointerPath", "manifestPath", "artifactFiles"], surfaces: ["deploy"], run: finalizeOwnerDeployment })],
  ["deployment finalize-upgrade", command({ description: "Verify an existing Instance upgrade, unchanged Owner identity, migration/schema state, Worker deployment, and write a redacted before/after receipt.", effect: "credential_free_and_authenticated_readback_then_local_receipt_write", inputFields: ["instanceId", "operationId", "taskId", "plan", "configPath", "apiOrigin", "currentReceiptPath", "releasePointerPath", "manifestPath", "artifactFiles"], surfaces: ["deploy"], run: finalizeInstanceUpgrade })],
  ["scope inspect-directory", command({ description: "Inspect the user's working directory, Git worktree root, and saved scope without writing files. Offer an association only for a confirmed Git worktree with no scope; unavailable or uncertain detection is not a non-Git result.", effect: "read_only", inputFields: ["directory"], surfaces: ["daily"], run: inspectScopeDirectory })],
  ["scope read", command({ description: "Read the optional non-secret scope file at one exact directory; use scope inspect-directory to locate a Git worktree root first.", effect: "read_only", inputFields: ["repoRoot"], surfaces: ["daily"], run: async (input) => ({ scope: await readRepoScope(input) }) })],
  ["scope merge", command({ description: "Merge explicit non-secret Repo scope targets.", effect: "local_write", inputFields: ["repoRoot", "targets"], surfaces: ["daily"], run: mergeRepoScope })],
  ["scope resolve", command({ description: "Resolve explicit, Repo, or warned aggregate Project scope.", effect: "read_only", inputFields: ["explicitTargets", "repoTargets", "validTargets", "allowUnfiltered"], surfaces: ["daily"], run: resolveScope })],
  ["origin rebind-check", command({ description: "Cross-check trusted and preferred origins without sending a Credential; update local metadata only after proof.", effect: "credential_free_network_and_local_write", inputFields: ["instanceId"], run: checkTrustedOriginRebind })],
  ["web resolve", command({ description: "Resolve a trusted local instance for Web opening without reading secrets; return ambiguity instead of choosing a default.", effect: "read_only_local", inputFields: ["instanceId", "origin", "repoRoot"], surfaces: ["daily", "admin"], run: resolveWebInstance })],
  ["web preflight", command({ description: "Probe local browser delivery without credentials, redirects, or remote writes; verify the requested browser visually.", effect: "local_browser_probe", inputFields: ["delivery"], surfaces: ["daily", "admin", "deploy"], run: preflightBrowser })],
  ["web launch", command({ description: "Create one Browser Launch through a memory-only relay. host_browser streams a 60-second local handoff event for IAB or a named browser; system_browser opens directly. Explicit headless fallback may return the remote capability once.", effect: "authenticated_remote_write_and_browser_delivery", inputFields: ["instanceId", "target", "idempotencyKey", "delivery", "sensitiveOutputAcknowledgement"], output: "conditional_one_time_capability", surfaces: ["daily", "admin"], run: createBrowserLaunchAndDeliver })],
  ["invite create", command({ description: "Create one scope-authorized Invitation and copy it without stdout; scoped administrators invite one Project as reader/writer, while identity recovery remains Owner-only. Explicit headless fallback may return the capability once.", effect: "authenticated_remote_write_and_invite_delivery", inputFields: ["instanceId", "body", "idempotencyKey", "delivery", "sensitiveOutputAcknowledgement"], output: "conditional_one_time_capability", surfaces: ["admin"], run: createInvitationAndDeliver })],
  ["api request", command({ description: "Send one same-origin authenticated REST request using the private current Credential; one-time capability creation requires a dedicated command.", effect: "authenticated_remote_request", inputFields: ["instanceId", "method", "apiPath", "body", "idempotencyKey"], run: guardedApiRequest })],
  ["release discover", command({ description: "Discover and freeze a release without installing or downloading bundles. selectionMode defaults to latest_stable, with marketplace.ref=null even when version freezes a previously resolved stable snapshot. Use exact_version with version only for a user-requested or clearly established conversation target. Preserve selection_mode independently of artifact versions; host-native updates follow the stable channel. Artifact verification remains required.", effect: "credential_free_read_only_network", inputFields: ["version", "selectionMode"], surfaces: ["deploy"], run: discoverRelease })],
  ["release verify", command({ description: "Verify a stable or prerelease pointer, immutable manifest, allowed origins, and both artifact digests.", effect: "read_only", inputFields: ["releasePointerPath", "manifestPath", "artifactFiles"], surfaces: ["deploy"], run: loadAndVerifyRelease })],
  ["release continuity", command({ description: "Compare publisher and artifact-origin continuity with an installed receipt.", effect: "read_only", inputFields: ["currentReceipt", "targetManifest"], surfaces: ["deploy"], run: verifyPublisherContinuity })],
  ["release install-skill-bundle", command({ description: "Install one verified Skill bundle version and atomically switch its active pointer.", effect: "local_write", inputFields: ["bundlePath", "version", "expectedSha256", "publisher", "source"], surfaces: ["deploy"], run: installVerifiedSkillBundle })],
  ["release install-service-bundle", command({ description: "Install one verified immutable Service deployment bundle into the private cfKanban release cache without deploying it.", effect: "local_write", inputFields: ["bundlePath", "version", "expectedSha256", "publisher", "source"], surfaces: ["deploy"], run: installVerifiedServiceBundle })],
  ["runtime resolve-wrangler", command({ description: "Resolve an explicitly configured, PATH, or cfKanban-managed compatible Wrangler.", effect: "read_only", inputFields: ["explicitPath", "requiredRange"], surfaces: ["deploy"], run: resolveWrangler })],
  ["runtime resolve-cloudflare-auth", command({ description: "Resolve Wrangler authentication without enumerating profiles. wranglerExecutable and a private absolute contextDirectory outside user Repos are required even when selectedProfile is supplied; selectedProfile is optional.", effect: "read_only_local_auth_and_cloudflare_accounts", inputFields: ["wranglerExecutable", "contextDirectory", "selectedProfile"], surfaces: ["deploy"], run: resolveCloudflareAuth })],
  ["runtime inspect-cloudflare-auth", command({ description: "Inspect one Wrangler profile, keyring preference, auth command support, and required OAuth scopes without returning tokens. Explicit attachmentStorage checks the optional R2 scope expansion.", effect: "read_only_local_auth", inputFields: ["wranglerExecutable", "profileName", "attachmentStorage"], surfaces: ["deploy"], run: inspectCloudflareAuth })],
  ["runtime plan-cloudflare-auth", command({ description: "Create a frozen Cloudflare OAuth plan with exact shell-free Wrangler arguments and global keyring effects. Explicit attachmentStorage discloses broader optional R2 access.", effect: "plan_only", inputFields: ["taskId", "mode", "preflight", "allowExistingProfile", "attachmentStorage"], surfaces: ["deploy"], run: createCloudflareAuthPlan })],
  ["runtime cloudflare-auth-action", command({ description: "Run one ordered, allowlisted action from an authorized Cloudflare OAuth plan without returning raw auth output.", effect: "authorized_local_auth_and_oauth", inputFields: ["plan", "actionId", "completedActionIds", "authorizedTaskId", "authorizedPlanDigest"], surfaces: ["deploy"], run: executeCloudflareAuthAction })],
  ["runtime wrangler-account-readback", command({ description: "Verify read-only D1 access for one exact account through either an explicit profile or the resolved context directory.", effect: "read_only_cloudflare_account", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory"], surfaces: ["deploy"], run: readWranglerAccountAccess })],
  ["runtime d1-resource-readback", command({ description: "Read back one exact D1 name and verified UUID through the selected Wrangler auth context without returning the account inventory.", effect: "read_only_cloudflare_resource", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory", "d1Name"], surfaces: ["deploy"], run: readD1ResourceByName })],
  ["runtime r2-storage-readback", command({ description: "Read the exact optional attachment bucket and instance ownership marker without returning account inventory.", effect: "read_only_cloudflare_resource", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory", "bucketName", "instanceId"], surfaces: ["deploy"], run: readR2Storage })],
  ["deployment provision-r2-storage", command({ description: "Provision or resume the exact optional private attachment bucket through an authorized deployment plan and verify its ownership marker.", effect: "authorized_cloudflare_write_and_readback", inputFields: ["instanceId", "operationId", "taskId", "plan", "wranglerExecutable", "currentReceiptPath"], surfaces: ["deploy"], run: provisionR2Storage })],
  ["runtime d1-restore-point-readback", command({ description: "Obtain one read-only D1 Time Travel bookmark as upgrade evidence without performing a restore.", effect: "read_only_cloudflare_resource", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory", "d1Name"], surfaces: ["deploy"], run: readD1RestorePoint })],
  ["runtime worker-resource-readback", command({ description: "Read back one exact Worker name and its current single-version deployment without returning account inventory.", effect: "read_only_cloudflare_resource", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory", "workerName"], surfaces: ["deploy"], run: readWorkerResourceByName })],
  ["runtime worker-version-readback", command({ description: "Read back one exact Worker version and a redacted normalized binding inventory.", effect: "read_only_cloudflare_resource", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory", "workerName", "versionId"], surfaces: ["deploy"], run: readWorkerVersionById })],
  ["runtime plan-install", command({ description: "Create an exact local Tool Runtime installation plan.", effect: "plan_only", inputFields: ["taskId", "npmExecutable", "wranglerVersion"], surfaces: ["deploy"], run: createToolRuntimePlan })],
  ["runtime install", command({ description: "Install the exact authorized Wrangler version inside the cfKanban user root.", effect: "local_tool_write", inputFields: ["plan", "authorizedTaskId", "authorizedPlanDigest"], surfaces: ["deploy"], run: installToolRuntime })],
  ["plan strict-zero", command({ description: "Create a frozen first-deployment plan for one Worker, one D1, and bundled Static Assets.", effect: "plan_only", inputFields: ["taskId", "accountId", "accountLabel", "cloudflareProfile", "cloudflareAuthContextDirectory", "ownerDisplayName", "release"], surfaces: ["deploy"], run: createStrictZeroPlan })],
  ["plan skill-update", command({ description: "Create a local-only Skill update plan.", effect: "plan_only", inputFields: ["taskId", "current", "target", "installRoot"], surfaces: ["deploy"], run: (input) => { const plan = createSkillUpdatePlan(input); return { plan, plan_digest: canonicalDigest(plan) }; } })],
  ["plan instance-upgrade", command({ description: "Create a complete existing-resource Cloudflare Instance upgrade plan without changing local Skills.", effect: "plan_only", inputFields: ["taskId", "instanceId", "operationId", "cloudflare", "resources", "bindings", "owner", "current", "target", "migrations", "restorePoint", "allow_breaking_change", "allow_unverified_current_source", "attachments", "usageAnalytics", "workerLimits"], surfaces: ["deploy"], run: (input) => { const plan = createInstanceUpgradePlan(input); return { plan, plan_digest: canonicalDigest(plan) }; } })],
  ["plan compare", command({ description: "Compare frozen plans and report whether new authorization is required.", effect: "read_only", inputFields: ["before", "after"], surfaces: ["deploy"], run: (input) => comparePlans(input.before, input.after) })],
  ["journal create", command({ description: "Create or resume the local journal for one exact plan digest.", effect: "local_write", inputFields: ["instanceId", "operationId", "plan"], surfaces: ["deploy"], run: createJournal })],
  ["journal authorize", command({ description: "Record authorization for one task, operation, and plan digest.", effect: "local_write", inputFields: ["instanceId", "operationId", "taskId", "planDigest"], surfaces: ["deploy"], run: authorizeJournal })],
  ["deployment write-wrangler-config", command({ description: "Generate and journal a private frozen Wrangler config that points at one verified portable Service bundle and D1.", effect: "authorized_local_write", inputFields: ["instanceId", "operationId", "taskId", "plan", "serviceBundleRoot", "d1DatabaseId"], surfaces: ["deploy"], run: writeFrozenWranglerConfig })],
  ["deploy wrangler-action", command({ description: "Run one plan-kind-specific allowlisted Wrangler action after journal authorization.", effect: "authorized_cloudflare_write_or_readback", inputFields: ["instanceId", "operationId", "taskId", "plan", "wranglerExecutable", "action", "configPath", "bootstrapSqlPath", "migrationLedgerSchemaSqlPath", "migrationReadbackSqlPath", "migrationSqlPath", "migrationName", "migrationRecordSqlPath"], surfaces: ["deploy"], run: executeWranglerAction })],
  ["migrations reconcile", command({ description: "Compare migration manifest checksums with the remote ledger and bounded schema artifacts.", effect: "read_only", inputFields: ["manifest", "ledger", "schema"], surfaces: ["deploy"], run: reconcileMigrationState })],
  ["migrations assess-ledger-recovery", command({ description: "Allow one missing checksum row only when the same authorized journal proves a successful non-destructive apply and a later exact schema/ledger readback.", effect: "read_only_local_recovery_assessment", inputFields: ["instanceId", "operationId", "taskId", "plan", "migrationManifestPath"], surfaces: ["deploy"], run: assessMigrationLedgerRecovery })],
  ["migrations write-ledger-record-sql", command({ description: "Write plan-bound insert-only private SQL for the one missing migration checksum proven recoverable by the same authorized journal.", effect: "authorized_local_write", inputFields: ["instanceId", "operationId", "taskId", "plan", "migration", "migrationManifestPath"], surfaces: ["deploy"], run: writeMigrationLedgerRecordSql })],
]);

function requireSurface(surface) {
  if (surface !== "all" && !ALL_SURFACES.includes(surface)) {
    throw toolError("INVALID_SKILL_SURFACE", "Unknown cfKanban Skill command surface", { surface });
  }
  return surface;
}

function isAvailable(definition, surface) {
  return surface === "all" || definition.surfaces.includes(surface);
}

export function getCommandCatalog({ surface = "all" } = {}) {
  const selectedSurface = requireSurface(surface);
  return {
    schema_version: 1,
    surface: selectedSurface,
    invocation: "node scripts/cfkanban-tool.mjs <command>",
    input_transport: "JSON object on stdin; omit stdin only for help",
    commands: [...COMMANDS.entries()]
      .filter(([, definition]) => isAvailable(definition, selectedSurface))
      .map(([name, definition]) => ({
        name,
        description: definition.description,
        effect: definition.effect,
        input_fields: [...definition.inputFields],
        output: definition.output,
      })),
  };
}

async function readStdinJson() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 256 * 1024) throw toolError("INPUT_TOO_LARGE", "Tool input exceeds 256 KiB");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw === "" ? {} : JSON.parse(raw);
}

function requireCommand(argv) {
  const value = argv.join(" ").trim();
  if (!value) return "help";
  return value === "--help" || value === "-h" ? "help" : value;
}

export async function dispatch(commandName, input, { surface = "all" } = {}) {
  const selectedSurface = requireSurface(surface);
  const definition = COMMANDS.get(commandName);
  if (definition === undefined) throw toolError("UNKNOWN_COMMAND", "Unknown cfKanban tool command", { command: commandName });
  if (!isAvailable(definition, selectedSurface)) {
    throw toolError("COMMAND_OUTSIDE_SKILL_SURFACE", "Command is not available through this cfKanban Skill", { command: commandName, surface: selectedSurface });
  }
  if (commandName === "plan public-access" && ["waf-enable", "waf-disable"].includes(input.mode)) {
    throw toolError("CLOUDFLARE_FEATURE_RETIRED", "WAF setup is retired. Preserve existing rules and recover an uncertain operation using its original journal.", { reason: "cloudflare_feature_retired" });
  }
  return definition.run(input);
}

export async function main(argv = process.argv.slice(2), { surface = "all" } = {}) {
  try {
    const commandName = requireCommand(argv);
    const result = commandName === "help"
      ? getCommandCatalog({ surface })
      : await dispatch(commandName, {
        ...await readStdinJson(),
        ...(["web launch", "web open", "web preflight"].includes(commandName) ? { onRelayReady: (event) => {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        } } : {}),
      }, { surface });
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    if (result?.closed instanceof Promise) await result.closed;
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(serializeError(error), null, 2)}\n`);
    return 1;
  }
}
