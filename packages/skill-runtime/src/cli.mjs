import { buildCapabilityReport } from "./capabilities.mjs";
import { redeemInvitation, redeemPublicJoin, rotateOwnerCredential, verifyPendingCredential } from "./credential-operations.mjs";
import { serializeError, toolError } from "./errors.mjs";
import { authorizeJournal, createJournal } from "./journal.mjs";
import { assessMigrationLedgerRecovery, reconcileMigrationState, writeMigrationLedgerRecordSql } from "./migrations.mjs";
import { comparePlans, createInstanceUpgradePlan, createSkillUpdatePlan, createStrictZeroPlan } from "./plan.mjs";
import { checkTrustedOriginRebind } from "./rebind.mjs";
import { loadAndVerifyRelease, verifyPublisherContinuity } from "./release.mjs";
import { mergeRepoScope, readRepoScope, resolveScope } from "./scope.mjs";
import {
  clearPendingCredential,
  createPendingCredential,
  inspectInstanceState,
  initializeStateRoot,
  putInstanceMetadata,
} from "./state.mjs";
import { apiRequest } from "./transport.mjs";
import { writeOwnerBootstrapSql } from "./bootstrap-sql.mjs";
import { executeWranglerAction, readD1ResourceByName, readWorkerResourceByName, readWranglerAccountAccess } from "./deploy.mjs";
import { writeFrozenWranglerConfig } from "./deployment-config.mjs";
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

const ALL_SURFACES = Object.freeze(["daily", "admin", "deploy"]);

function command({ description, effect, inputFields = [], surfaces = ALL_SURFACES, run }) {
  return Object.freeze({ description, effect, inputFields: Object.freeze(inputFields), surfaces: Object.freeze(surfaces), run });
}

const COMMANDS = new Map([
  ["capabilities", command({ description: "Inspect the current host, paths, and PATH-level tools without installing anything; Wrangler usability still requires runtime resolve-wrangler.", effect: "read_only", run: buildCapabilityReport })],
  ["state init", command({ description: "Create and verify the private cfKanban user root.", effect: "local_write", inputFields: ["home", "repoRoot", "persistenceConfirmed"], run: initializeStateRoot })],
  ["state put-instance", command({ description: "Store non-secret metadata for one trusted instance.", effect: "local_write", inputFields: ["instanceId", "trustedApiOrigin", "originVersion"], surfaces: ["daily", "deploy"], run: putInstanceMetadata })],
  ["state inspect", command({ description: "Inspect one local instance slot without returning Credential values.", effect: "local_state_check", inputFields: ["instanceId"], run: inspectInstanceState })],
  ["credential prepare", command({ description: "Generate a Credential directly into the private pending slot.", effect: "local_secret_write", inputFields: ["instanceId", "principalId", "operationId", "idempotencyKey", "purpose"], run: createPendingCredential })],
  ["credential verify-and-promote", command({ description: "Authenticate with the pending Credential, verify /me, and promote only a matching Principal and fingerprint.", effect: "authenticated_read_and_local_secret_write", inputFields: ["instanceId"], run: verifyPendingCredential })],
  ["credential clear", command({ description: "Clear a pending Credential only after remote non-commit is proven.", effect: "local_secret_delete", inputFields: ["instanceId", "committedStateKnownFalse"], run: clearPendingCredential })],
  ["invite redeem", command({ description: "Redeem one Project or recovery Invite while injecting any pending Credential internally.", effect: "single_remote_write_and_local_credential_promotion", inputFields: ["instanceId", "inviteCode", "redeemAs", "displayName", "idempotencyKey"], surfaces: ["daily"], run: redeemInvitation })],
  ["public-join redeem", command({ description: "Join one public Project with an explicit role while injecting any pending Credential internally.", effect: "single_remote_write_and_local_credential_promotion", inputFields: ["instanceId", "publicId", "role", "redeemAs", "displayName", "idempotencyKey"], surfaces: ["daily"], run: redeemPublicJoin })],
  ["owner rotate-credential", command({ description: "Rotate the Owner Credential by reading current and pending secrets internally, then verify and promote.", effect: "authenticated_remote_secret_rotation_and_local_promotion", inputFields: ["instanceId"], surfaces: ["admin"], run: rotateOwnerCredential })],
  ["bootstrap write-owner-sql", command({ description: "Write private hash-only SQL for first Owner bootstrap.", effect: "local_secret_derived_write", inputFields: ["instanceId", "ownerDisplayName", "ownerPrincipalId", "preferredApiOrigin", "serviceVersion", "schemaVersion"], surfaces: ["deploy"], run: writeOwnerBootstrapSql })],
  ["scope read", command({ description: "Read the optional non-secret Repo scope file.", effect: "read_only", inputFields: ["repoRoot"], surfaces: ["daily"], run: async (input) => ({ scope: await readRepoScope(input) }) })],
  ["scope merge", command({ description: "Merge explicit non-secret Repo scope targets.", effect: "local_write", inputFields: ["repoRoot", "targets"], surfaces: ["daily"], run: mergeRepoScope })],
  ["scope resolve", command({ description: "Resolve explicit, Repo, or warned aggregate Project scope.", effect: "read_only", inputFields: ["explicitTargets", "repoTargets"], surfaces: ["daily"], run: resolveScope })],
  ["origin rebind-check", command({ description: "Cross-check trusted and preferred origins without sending a Credential; update local metadata only after proof.", effect: "credential_free_network_and_local_write", inputFields: ["instanceId"], run: checkTrustedOriginRebind })],
  ["api request", command({ description: "Send one same-origin authenticated REST request using the private current Credential.", effect: "authenticated_remote_request", inputFields: ["instanceId", "method", "apiPath", "body", "idempotencyKey"], run: apiRequest })],
  ["release verify", command({ description: "Verify a stable or prerelease pointer, immutable manifest, allowed origins, and both artifact digests.", effect: "read_only", inputFields: ["releasePointerPath", "manifestPath", "artifactFiles"], surfaces: ["deploy"], run: loadAndVerifyRelease })],
  ["release continuity", command({ description: "Compare publisher and artifact-origin continuity with an installed receipt.", effect: "read_only", inputFields: ["currentReceipt", "targetManifest"], surfaces: ["deploy"], run: verifyPublisherContinuity })],
  ["release install-skill-bundle", command({ description: "Install one verified Skill bundle version and atomically switch its active pointer.", effect: "local_write", inputFields: ["bundlePath", "version", "expectedSha256", "publisher", "source"], surfaces: ["deploy"], run: installVerifiedSkillBundle })],
  ["runtime resolve-wrangler", command({ description: "Resolve an explicitly configured, PATH, or cfKanban-managed compatible Wrangler.", effect: "read_only", inputFields: ["explicitPath", "requiredRange"], surfaces: ["deploy"], run: resolveWrangler })],
  ["runtime resolve-cloudflare-auth", command({ description: "Resolve Wrangler authentication from environment, an explicitly named profile, or the effective deployment context without enumerating profiles.", effect: "read_only_local_auth_and_cloudflare_accounts", inputFields: ["wranglerExecutable", "contextDirectory", "selectedProfile"], surfaces: ["deploy"], run: resolveCloudflareAuth })],
  ["runtime inspect-cloudflare-auth", command({ description: "Inspect one Wrangler profile, keyring preference, auth command support, and required OAuth scopes without returning tokens.", effect: "read_only_local_auth", inputFields: ["wranglerExecutable", "profileName"], surfaces: ["deploy"], run: inspectCloudflareAuth })],
  ["runtime plan-cloudflare-auth", command({ description: "Create a frozen Cloudflare OAuth plan with exact shell-free Wrangler arguments and global keyring effects.", effect: "plan_only", inputFields: ["taskId", "mode", "preflight", "allowExistingProfile"], surfaces: ["deploy"], run: createCloudflareAuthPlan })],
  ["runtime cloudflare-auth-action", command({ description: "Run one ordered, allowlisted action from an authorized Cloudflare OAuth plan without returning raw auth output.", effect: "authorized_local_auth_and_oauth", inputFields: ["plan", "actionId", "completedActionIds", "authorizedTaskId", "authorizedPlanDigest"], surfaces: ["deploy"], run: executeCloudflareAuthAction })],
  ["runtime wrangler-account-readback", command({ description: "Verify read-only D1 access for one exact account through either an explicit profile or the resolved context directory.", effect: "read_only_cloudflare_account", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory"], surfaces: ["deploy"], run: readWranglerAccountAccess })],
  ["runtime d1-resource-readback", command({ description: "Read back one exact D1 name and verified UUID through the selected Wrangler auth context without returning the account inventory.", effect: "read_only_cloudflare_resource", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory", "d1Name"], surfaces: ["deploy"], run: readD1ResourceByName })],
  ["runtime worker-resource-readback", command({ description: "Read back one exact Worker name through the selected Wrangler auth context without returning deployment or account inventory.", effect: "read_only_cloudflare_resource", inputFields: ["wranglerExecutable", "accountId", "cloudflareProfile", "contextDirectory", "workerName"], surfaces: ["deploy"], run: readWorkerResourceByName })],
  ["runtime plan-install", command({ description: "Create an exact local Tool Runtime installation plan.", effect: "plan_only", inputFields: ["taskId", "npmExecutable", "wranglerVersion"], surfaces: ["deploy"], run: createToolRuntimePlan })],
  ["runtime install", command({ description: "Install the exact authorized Wrangler version inside the cfKanban user root.", effect: "local_tool_write", inputFields: ["plan", "authorizedTaskId", "authorizedPlanDigest"], surfaces: ["deploy"], run: installToolRuntime })],
  ["plan strict-zero", command({ description: "Create a frozen first-deployment plan for one Worker, one D1, and bundled Static Assets.", effect: "plan_only", inputFields: ["taskId", "accountId", "accountLabel", "cloudflareProfile", "cloudflareAuthContextDirectory", "ownerDisplayName", "release"], surfaces: ["deploy"], run: createStrictZeroPlan })],
  ["plan skill-update", command({ description: "Create a local-only Skill update plan.", effect: "plan_only", inputFields: ["taskId", "current", "target", "installRoot"], surfaces: ["deploy"], run: (input) => { const plan = createSkillUpdatePlan(input); return { plan, plan_digest: canonicalDigest(plan) }; } })],
  ["plan instance-upgrade", command({ description: "Create a separate Cloudflare Instance upgrade plan without changing local Skills.", effect: "plan_only", inputFields: ["taskId", "instanceId", "current", "target", "migrations", "restorePoint"], surfaces: ["deploy"], run: (input) => { const plan = createInstanceUpgradePlan(input); return { plan, plan_digest: canonicalDigest(plan) }; } })],
  ["plan compare", command({ description: "Compare frozen plans and report whether new authorization is required.", effect: "read_only", inputFields: ["before", "after"], surfaces: ["deploy"], run: (input) => comparePlans(input.before, input.after) })],
  ["journal create", command({ description: "Create or resume the local journal for one exact plan digest.", effect: "local_write", inputFields: ["instanceId", "operationId", "plan"], surfaces: ["deploy"], run: createJournal })],
  ["journal authorize", command({ description: "Record authorization for one task, operation, and plan digest.", effect: "local_write", inputFields: ["instanceId", "operationId", "taskId", "planDigest"], surfaces: ["deploy"], run: authorizeJournal })],
  ["deployment write-wrangler-config", command({ description: "Generate and journal a private frozen Wrangler config that points at one verified portable Service bundle and D1.", effect: "authorized_local_write", inputFields: ["instanceId", "operationId", "taskId", "plan", "serviceBundleRoot", "d1DatabaseId"], surfaces: ["deploy"], run: writeFrozenWranglerConfig })],
  ["deploy wrangler-action", command({ description: "Run one allowlisted Wrangler action after journal authorization.", effect: "authorized_cloudflare_write_or_readback", inputFields: ["instanceId", "operationId", "taskId", "plan", "wranglerExecutable", "action", "configPath", "bootstrapSqlPath", "migrationLedgerSchemaSqlPath", "migrationReadbackSqlPath", "migrationRecordSqlPath"], surfaces: ["deploy"], run: executeWranglerAction })],
  ["migrations reconcile", command({ description: "Compare migration manifest checksums with the remote ledger and bounded schema artifacts.", effect: "read_only", inputFields: ["manifest", "ledger", "schema"], surfaces: ["deploy"], run: reconcileMigrationState })],
  ["migrations assess-ledger-recovery", command({ description: "Allow one missing checksum row only when the same authorized journal proves a successful non-destructive apply and a later exact schema/ledger readback.", effect: "read_only_local_recovery_assessment", inputFields: ["instanceId", "operationId", "taskId", "plan", "migrationManifestPath"], surfaces: ["deploy"], run: assessMigrationLedgerRecovery })],
  ["migrations write-ledger-record-sql", command({ description: "Write insert-only private SQL for one verified migration checksum record.", effect: "local_write", inputFields: ["instanceId", "operationId", "migration"], surfaces: ["deploy"], run: writeMigrationLedgerRecordSql })],
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
  return definition.run(input);
}

export async function main(argv = process.argv.slice(2), { surface = "all" } = {}) {
  try {
    const commandName = requireCommand(argv);
    const result = commandName === "help"
      ? getCommandCatalog({ surface })
      : await dispatch(commandName, await readStdinJson(), { surface });
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(serializeError(error), null, 2)}\n`);
    return 1;
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main();
}
