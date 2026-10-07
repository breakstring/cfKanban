import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { getInstancePaths, validatePrivatePath } from "./state.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { apiRequest } from "./transport.mjs";
import { checkTrustedOriginRebind, fetchDiscovery, validateDiscovery } from "./rebind.mjs";
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, pathType, readJson, requireString, requireUuid } from "./utils.mjs";
import { toolError } from "./errors.mjs";
import { normalizePublicAccess } from "./public-access-config.mjs";
import { acquirePublicAccessLock } from "./public-access-lock.mjs";

const PHASE = "http_request_firewall_custom";
const PROFILE = "anonymous-api-filter";
const OPTIONS = { errorPrefix: "PUBLIC_ACCESS", resourceLabel: "public access" };
const MODES = ["domain-enable", "waf-enable", "waf-disable", "domain-rollback"];
function fail(code, message) { throw toolError(code, message); }
function exactId(value, field) { const result = requireString(value, field, { max: 128 }); if (!/^[A-Za-z0-9_-]+$/u.test(result)) fail("INVALID_PUBLIC_ACCESS_TARGET", "Cloudflare identifiers must be exact"); return result; }
function hostname(value) {
  if (typeof value !== "string" || value.length > 253 || value !== value.toLowerCase() || !value.includes(".") || !value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) fail("INVALID_PUBLIC_ACCESS_HOSTNAME", "Use one exact lowercase hostname without wildcard, scheme, port or path");
  return value;
}
function boundedList(value, limit = 1000) {
  if (value?.success !== true || !Array.isArray(value.result) || value.result.length > limit || (value.result_info?.total_pages ?? 1) > 1 || (value.result_info?.total_count !== undefined && value.result_info.total_count !== value.result.length)) fail("PUBLIC_ACCESS_INVENTORY_INCOMPLETE", "A complete bounded resource inventory is required; no writes were inferred from partial results");
  return value.result;
}
function ownedRef(instanceId) { return `cfkanban_${instanceId.replaceAll("-", "")}_anonymous_api`; }
export function anonymousApiRule(host, instanceId) {
  hostname(host); requireUuid(instanceId, "instance_id");
  // 只拦截原本就缺少任何认证材料的私有 API；不依赖 Free 不支持的 Host 限速表达式。
  const paths = ["admin", "workspaces", "projects", "issues", "attachments", "comments", "labels", "relations", "events", "notifications", "search-index"];
  const pathExpression = paths.map(name => `(http.request.uri.path eq "/api/v1/${name}" or starts_with(http.request.uri.path, "/api/v1/${name}/"))`).join(" or ");
  return { ref: ownedRef(instanceId), description: `cfKanban ${instanceId} anonymous private API filter`, enabled: true, action: "block",
    expression: `(http.host eq "${host}" and (${pathExpression}) and not any(http.request.headers.names[*] eq "authorization") and not http.cookie contains "cfkanban_session=")` };
}
function ruleBody(rule) { return Object.fromEntries(["ref", "description", "enabled", "action", "expression"].map(key => [key, rule[key]])); }
function foreignRulesDigest(inventory, ref) { return canonicalDigest(inventory.flatMap(set => (set.rules ?? []).filter(rule => rule.ref !== ref).map(rule => ({ ruleset: set.id, ...rule }))).map(({ version, last_updated, ...entry }) => entry)); }
function routingDigest(routing) { return canonicalDigest(routing); }
function routeMayMatchHostname(pattern, host) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 2048 || /[\s?#\\]/u.test(pattern)) fail("PUBLIC_ACCESS_ROUTE_PATTERN_UNVERIFIED", "An unrecognized zone route pattern requires a separate routing plan");
  const parts = /^(?:(https?):\/\/)?([^/]+)(\/.*)?$/iu.exec(pattern);
  if (!parts) fail("PUBLIC_ACCESS_ROUTE_PATTERN_UNVERIFIED", "An unrecognized zone route pattern requires a separate routing plan");
  const routeHost = parts[2].toLowerCase(), suffix = routeHost.startsWith("*") ? routeHost.slice(1) : routeHost;
  const domain = routeHost.startsWith("*.") ? suffix.slice(1) : suffix;
  if ((routeHost !== "*" && (!domain.includes(".") || !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))))
    || !/^\/[^*]*\*?$/u.test(parts[3] ?? "/")) fail("PUBLIC_ACCESS_ROUTE_PATTERN_UNVERIFIED", "An unrecognized zone route pattern requires a separate routing plan");
  if (parts[1]?.toLowerCase() === "http") return false;
  // Cloudflare 的前导 * 匹配任意前缀，*example.test 包含 apex；*.example.test 不包含。
  return routeHost.startsWith("*") ? host.endsWith(suffix) : host === routeHost;
}
async function loadLocal(input) {
  const stateRoot = path.resolve(input.stateRoot ?? resolveStateRoot());
  const instanceId = requireUuid(input.instanceId, "instance_id");
  const paths = getInstancePaths({ stateRoot, instanceId });
  await validatePrivatePath(stateRoot, "directory");
  await assertNoSymlinkPath(paths.instanceMetadata, stateRoot); await validatePrivatePath(paths.instanceMetadata, "file");
  const metadata = await readJson(paths.instanceMetadata);
  const receiptPath = path.resolve(requireString(input.receiptPath, "receipt_path"));
  const relative = path.relative(paths.receiptsRoot, receiptPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("PUBLIC_ACCESS_RECEIPT_REQUIRED", "Use an existing private receipt for this Instance");
  await assertNoSymlinkPath(receiptPath, stateRoot); await validatePrivatePath(receiptPath, "file");
  const receipt = await readJson(receiptPath);
  if (!["cfkanban_deployment_receipt", "cfkanban_instance_upgrade_receipt", "cfkanban_deployment_attachment_receipt"].includes(receipt.kind) || receipt.instance?.id !== instanceId) fail("PUBLIC_ACCESS_RECEIPT_REQUIRED", "An existing verified deployment receipt must bind this Instance");
  const managedPath = path.join(paths.receiptsRoot, "public-access.json");
  await assertNoSymlinkPath(managedPath, stateRoot);
  if (await pathType(managedPath) !== "missing") await validatePrivatePath(managedPath, "file");
  const managed = normalizePublicAccess(await readJson(managedPath, { allowMissing: true }));
  const target = { instance_id: instanceId, account_id: exactId(receipt.cloudflare?.account_id, "account_id"), worker_name: exactId(receipt.cloudflare?.worker?.name, "worker_name"), database_id: requireUuid(receipt.cloudflare?.d1?.database_id, "database_id"), zone_id: exactId(input.zoneId, "zone_id"), hostname: hostname(input.hostname),
    cloudflare_profile: input.cloudflareProfile ?? receipt.cloudflare.profile ?? null, context_directory: input.contextDirectory ?? null, wrangler_executable: requireString(input.wranglerExecutable, "wrangler_executable"), receipt_path: receiptPath, receipt_digest: canonicalDigest(receipt) };
  if (!path.isAbsolute(target.wrangler_executable) || (target.context_directory && !path.isAbsolute(target.context_directory)) || (target.cloudflare_profile !== null) === (target.context_directory !== null)) fail("PUBLIC_ACCESS_AUTH_CONTEXT_REQUIRED", "Choose one exact existing Wrangler profile or private context with an absolute executable");
  if (receipt.cloudflare.profile && target.cloudflare_profile !== receipt.cloudflare.profile) fail("PUBLIC_ACCESS_AUTH_CONTEXT_DRIFT", "The selected profile differs from the deployment receipt");
  if (managed && (managed.instance_id !== instanceId || managed.account_id !== target.account_id || managed.worker_name !== target.worker_name)) fail("PUBLIC_ACCESS_RECEIPT_DRIFT", "The public-access receipt differs from this deployment");
  return { stateRoot, paths, metadata, receipt, receiptPath, managedPath, managed, target };
}
async function clients(input, target) {
  const connection = { ...input, accountId: target.account_id, zoneId: target.zone_id, wranglerExecutable: target.wrangler_executable, cloudflareProfile: target.cloudflare_profile, contextDirectory: target.context_directory };
  return { worker: await createCloudflareControlClient(connection, "/workers", OPTIONS), zone: await createCloudflareControlClient(connection, "", { ...OPTIONS, scope: "zone" }) };
}
async function readRouting(worker, zone, target, { checkZoneRoutes = true } = {}) {
  const [account, subdomain, domains, routes, settings, zoneRoutes] = await Promise.all([worker("/subdomain"), worker(`/scripts/${target.worker_name}/subdomain`), worker("/domains", { raw: true }), worker(`/services/${target.worker_name}/environments/production/routes`, { raw: true }), worker(`/scripts/${target.worker_name}/settings`), checkZoneRoutes ? zone("/workers/routes", { raw: true }) : null]);
  if (!/^[a-z0-9-]+$/u.test(account?.subdomain ?? "") || typeof subdomain?.enabled !== "boolean" || typeof subdomain?.previews_enabled !== "boolean") fail("PUBLIC_ACCESS_ROUTING_UNVERIFIED", "Both workers.dev and preview URL status require explicit readback");
  if (boundedList(routes).length) fail("PUBLIC_ACCESS_ROUTES_UNSUPPORTED", "Resolve Worker routes in a separate plan before changing public access");
  if (checkZoneRoutes) for (const route of boundedList(zoneRoutes)) {
    if (route === null || typeof route !== "object" || Array.isArray(route)) fail("PUBLIC_ACCESS_ROUTE_PATTERN_UNVERIFIED", "An unrecognized zone route requires a separate routing plan");
    // script=null 是排除路由，也会改变匹配行为；不能据此认定 hostname 未被占用。
    if (routeMayMatchHostname(route.pattern, target.hostname)) fail("PUBLIC_ACCESS_ZONE_ROUTES_UNSUPPORTED", "A zone Worker route may cover the selected HTTPS hostname; resolve it in a separate plan without deleting routes implicitly");
  }
  if (!Array.isArray(settings?.bindings) || !settings.bindings.some(binding => binding.type === "d1" && binding.name === "DB" && binding.id === target.database_id || binding.type === "d1" && binding.name === "DB" && binding.database_id === target.database_id)) fail("PUBLIC_ACCESS_WORKER_UNPROVEN", "The selected Worker does not bind the receipt's D1 database");
  const allDomains = boundedList(domains).map(domain => ({ id: exactId(domain.id, "domain_id"), hostname: hostname(domain.hostname), service: exactId(domain.service, "worker_name"), zone_id: exactId(domain.zone_id, "zone_id") })).sort((a, b) => a.hostname.localeCompare(b.hostname));
  return { workers_dev: subdomain.enabled, previews_enabled: subdomain.previews_enabled, workers_dev_origin: `https://${target.worker_name}.${account.subdomain}.workers.dev`, domains: allDomains.filter(domain => domain.service === target.worker_name || domain.hostname === target.hostname) };
}
async function readZone(zone, target) {
  const value = await zone("");
  if (value?.id !== target.zone_id || value.account?.id !== target.account_id || value.status !== "active" || typeof value.name !== "string" || !(target.hostname === value.name || target.hostname.endsWith(`.${value.name}`))) fail("PUBLIC_ACCESS_ZONE_UNPROVEN", "Use an active zone in the receipt's account containing exactly the selected hostname");
  return { id: value.id, name: value.name, status: value.status, account_id: value.account.id };
}
async function readWaf(zone) {
  const summaries = boundedList(await zone("/rulesets", { raw: true }), 100).filter(set => set.phase === PHASE);
  if (summaries.length > 10) fail("PUBLIC_ACCESS_RULESET_BOUND_EXCEEDED", "The selected zone exceeds the supported bounded ruleset inventory");
  const inventory = await Promise.all(summaries.map(set => zone(`/rulesets/${exactId(set.id, "ruleset_id")}`)));
  if (inventory.some(set => set.phase !== PHASE || !Array.isArray(set.rules) || set.rules.length > 1000) || inventory.filter(set => set.kind === "zone").length > 1) fail("PUBLIC_ACCESS_RULESET_UNVERIFIED", "Custom ruleset inventory could not be verified");
  return inventory;
}
async function ownerRead(input, local) {
  const response = await apiRequest({ stateRoot: local.stateRoot, instanceId: local.target.instance_id, apiPath: "/api/v1/meta", fetchImpl: input.fetchImpl });
  const meta = response.data;
  if (!response.ok || meta?.instance_id !== local.target.instance_id || meta.principal?.is_owner !== true || meta.principal.id !== local.receipt.owner?.principal_id || meta.observed_origin !== local.metadata.trusted_api_origin) fail("PUBLIC_ACCESS_OWNER_REQUIRED", "The current trusted connection must authenticate the receipt's Deployment Owner");
  return { principal_id: meta.principal.id, origin_version: meta.origin_version, preferred_api_origin: meta.preferred_api_origin, observed_origin: meta.observed_origin };
}
function ownedDomain(routing, target) { return routing.domains.find(domain => domain.hostname === target.hostname); }
function assertManaged(local, routing) {
  const domain = ownedDomain(routing, local.target);
  if (!local.managed || local.managed.hostname !== local.target.hostname || local.managed.zone_id !== local.target.zone_id || local.managed.domain_id !== domain?.id || domain.service !== local.target.worker_name || domain.zone_id !== local.target.zone_id || !local.managed.domain_enabled) fail("PUBLIC_ACCESS_OWNERSHIP_REQUIRED", "An exact active mapping and this tool's private ownership receipt are required");
}
export async function inspectPublicAccess(input) {
  const local = await loadLocal(input), control = await clients(input, local.target);
  const [zone, routing, owner] = await Promise.all([readZone(control.zone, local.target), readRouting(control.worker, control.zone, local.target), ownerRead(input, local)]);
  const waf = input.includeWaf === false ? [] : await readWaf(control.zone);
  const ref = ownedRef(local.target.instance_id), rules = waf.flatMap(set => set.rules.map(rule => ({ ruleset_id: set.id, ...rule })));
  return { target: local.target, zone, owner, routing, managed: local.managed, waf: { rule_count: rules.length, free_profile_rule_limit: 5, rulesets: waf, foreign_rules_digest: foreignRulesDigest(waf, ref), owned_rules: rules.filter(rule => rule.ref === ref) }, credential_values_exposed: false };
}
export async function createPublicAccessPlan(input) {
  if (!MODES.includes(input.mode)) fail("INVALID_PUBLIC_ACCESS_MODE", "Choose domain-enable, waf-enable, waf-disable or domain-rollback");
  if (input.passkeyRecoveryReady !== undefined && typeof input.passkeyRecoveryReady !== "boolean") fail("INVALID_PASSKEY_RECOVERY_READINESS", "Passkey recovery readiness must be an explicit boolean");
  const local = await loadLocal(input), observed = await inspectPublicAccess({ ...input, includeWaf: input.mode !== "domain-enable" && (input.mode !== "domain-rollback" || Boolean(local.managed?.rule_id)) });
  const mode = input.mode, mapping = ownedDomain(observed.routing, local.target), ownRules = observed.waf.owned_rules;
  if (observed.owner.preferred_api_origin !== observed.owner.observed_origin) fail("PUBLIC_ACCESS_ORIGIN_MIGRATION_PENDING", "Finish the existing trusted-origin migration before planning another one");
  if (mode === "domain-enable") {
    if (local.managed?.domain_enabled || mapping || observed.routing.domains.some(domain => domain.service === local.target.worker_name) || observed.owner.observed_origin !== observed.routing.workers_dev_origin || !observed.routing.workers_dev) fail("PUBLIC_ACCESS_DOMAIN_ALREADY_IN_USE", "A new hostname and an enabled receipt-bound workers.dev origin are required; existing mappings are never adopted");
    const control = await clients(input, local.target);
    if (boundedList(await control.zone("/dns_records", { raw: true, query: { name: local.target.hostname, per_page: "100" } })).length) fail("PUBLIC_ACCESS_DNS_ALREADY_IN_USE", "The selected hostname already has DNS records; no overwrite is allowed");
  } else {
    assertManaged(local, observed.routing);
    if (observed.routing.workers_dev || observed.routing.previews_enabled) fail("PUBLIC_ACCESS_ROUTING_DRIFT", "The managed domain must remain the sole active public origin before planning a profile change");
  }
  if (ownRules.length > 1 || (ownRules.length && (!local.managed || local.managed.rule_id !== ownRules[0].id || canonicalDigest(ruleBody(ownRules[0])) !== canonicalDigest(anonymousApiRule(local.target.hostname, local.target.instance_id))))) fail("PUBLIC_ACCESS_RULE_OWNERSHIP_REQUIRED", "Existing rules cannot be adopted or modified without an exact private ownership receipt");
  if (mode === "waf-enable" && !ownRules.length && observed.waf.rule_count >= 5) fail("PUBLIC_ACCESS_FREE_CAPACITY_UNAVAILABLE", "No verified Free custom-rule slot remains; this tool never purchases or upgrades a plan");
  if (mode === "domain-rollback" && input.wafProfile !== undefined) fail("INVALID_PUBLIC_ACCESS_PROFILE", "Domain rollback also removes only the rule owned by this tool");
  const plan = { schema_version: 1, kind: "cfkanban_public_access", task_id: requireString(input.taskId, "task_id"), operation_id: requireUuid(input.operationId ?? randomUUID(), "operation_id"), instance_id: local.target.instance_id, mode, target: local.target,
    before: { owner: observed.owner, routing: observed.routing, managed_digest: canonicalDigest(local.managed), foreign_rules_digest: observed.waf.foreign_rules_digest, owned_rules: ownRules.map(rule => ({ ruleset_id: rule.ruleset_id, id: rule.id, ...ruleBody(rule) })) },
    profile: mode === "waf-enable" ? PROFILE : "disabled", purchase_or_upgrade_plan: false, automatic_zone_dns_overwrite: false, modifies_foreign_rules: false,
    ...(["domain-enable", "domain-rollback"].includes(mode) ? { passkey_impact: {
      old_rp_id: new URL(observed.owner.observed_origin).hostname,
      new_rp_id: mode === "domain-enable" ? local.target.hostname : new URL(observed.routing.workers_dev_origin).hostname,
      existing_passkeys_transfer: false,
      recovery_prepared: input.passkeyRecoveryReady === true,
      owner_recovery: "existing_safe_api_credential_verified_as_same_owner_at_new_origin",
      participant_recovery: "existing_same_identity_api_credential_or_owner_issued_same_principal_recovery_then_register_new_passkey",
      web_only_users_affected: true,
      automatic_new_identity_or_rp_id_transfer: false,
    } } : {}),
    effects: mode === "domain-enable" ? ["attach_exact_unused_hostname", "verify_same_instance_https", "cas_preferred_origin", "rebind_trusted_origin", "disable_workers_dev_and_previews"] : mode === "domain-rollback" ? ["enable_workers_dev_without_previews", "verify_same_instance_https", "cas_preferred_origin", "rebind_trusted_origin", "remove_owned_rule", "detach_owned_domain"] : [mode === "waf-enable" ? "create_owned_hostname_private_api_filter" : "remove_owned_rule"],
    limitations: ["Free profile filters missing authentication material only; it is not a request or billing cap", "Cloudflare control writes have no compare-and-swap; readback detects competing changes", "Domain certificate removal is not automatic", "Old-RP Passkeys cannot authenticate at the new hostname; prepare same-identity recovery and re-registration before cutover", "Other API clients must follow the trusted-origin transition; old links stop working when the previous origin closes"] };
  return { plan, plan_digest: canonicalDigest(plan) };
}
async function verifyDiscovery(input, target, origin, expectedOrigin, version) {
  const discovery = validateDiscovery(await fetchDiscovery(origin, input.fetchImpl ?? globalThis.fetch), origin);
  if (discovery.instance_id !== target.instance_id || discovery.preferred_api_origin !== expectedOrigin || discovery.origin_version !== version) fail("PUBLIC_ACCESS_DISCOVERY_MISMATCH", "HTTPS discovery does not prove the same Instance and exact origin transition");
}
async function moveOrigin(input, local, plan, nextOrigin, event) {
  const previous = plan.before.owner, current = await readJson(local.paths.instanceMetadata);
  if (![previous.observed_origin, nextOrigin].includes(current.trusted_api_origin)) fail("PUBLIC_ACCESS_ORIGIN_DRIFT", "The trusted origin moved outside the approved transition");
  if (current.trusted_api_origin === previous.observed_origin) {
    const meta = await apiRequest({ stateRoot: local.stateRoot, instanceId: plan.instance_id, apiPath: "/api/v1/admin/instance-origin", fetchImpl: input.fetchImpl });
    if (!meta.ok) fail("PUBLIC_ACCESS_OWNER_REQUIRED", "Origin readback requires the current Owner");
    if (meta.data.preferred_api_origin === previous.observed_origin && meta.data.version === previous.origin_version) {
      await verifyDiscovery(input, plan.target, nextOrigin, previous.observed_origin, previous.origin_version);
      await event("origin_change_intent");
      const result = await apiRequest({ stateRoot: local.stateRoot, instanceId: plan.instance_id, apiPath: "/api/v1/admin/instance-origin", method: "PUT", body: { preferred_api_origin: nextOrigin, expected_version: previous.origin_version }, idempotencyKey: `public-access-${plan.operation_id}`, fetchImpl: input.fetchImpl });
      if (!result.ok) fail("PUBLIC_ACCESS_ORIGIN_UNCERTAIN", "Origin update was not confirmed; resume this exact journal and idempotency key after readback");
    } else if (meta.data.preferred_api_origin !== nextOrigin || meta.data.version !== previous.origin_version + 1) fail("PUBLIC_ACCESS_ORIGIN_DRIFT", "Preferred origin changed outside the authorized transition");
    await verifyDiscovery(input, plan.target, previous.observed_origin, nextOrigin, previous.origin_version + 1);
    await verifyDiscovery(input, plan.target, nextOrigin, nextOrigin, previous.origin_version + 1);
    await checkTrustedOriginRebind({ stateRoot: local.stateRoot, instanceId: plan.instance_id, fetchImpl: input.fetchImpl });
  }
  await verifyDiscovery(input, plan.target, nextOrigin, nextOrigin, previous.origin_version + 1);
  local.metadata = await readJson(local.paths.instanceMetadata);
  const owner = await ownerRead(input, local);
  if (owner.preferred_api_origin !== nextOrigin || owner.origin_version !== previous.origin_version + 1) fail("PUBLIC_ACCESS_ORIGIN_DRIFT", "The rebound Owner connection did not confirm the new origin");
  await event("origin_verified");
}
async function applyWaf(input, local, plan, control, journal, event, enabled) {
  let inventory = await readWaf(control.zone);
  const ref = ownedRef(plan.instance_id), expected = anonymousApiRule(plan.target.hostname, plan.instance_id);
  if (foreignRulesDigest(inventory, ref) !== plan.before.foreign_rules_digest) fail("PUBLIC_ACCESS_FOREIGN_RULE_DRIFT", "Unrelated zone rules changed; prepare a fresh plan without overwriting them");
  let matches = inventory.flatMap(set => set.rules.filter(rule => rule.ref === ref).map(rule => ({ ruleset_id: set.id, ...rule })));
  if (matches.length > 1) fail("PUBLIC_ACCESS_RULE_OWNERSHIP_REQUIRED", "Duplicate ownership references are ambiguous");
  const rule = matches[0];
  if (rule && (canonicalDigest(ruleBody(rule)) !== canonicalDigest(expected) || (rule.id !== local.managed?.rule_id && !journal.events.some(entry => entry.type === "public_access_waf_create_intent")))) fail("PUBLIC_ACCESS_RULE_OWNERSHIP_REQUIRED", "The matching rule is not proven to belong to this operation");
  if (enabled && !rule) {
    if (inventory.reduce((count, set) => count + set.rules.length, 0) >= 5) fail("PUBLIC_ACCESS_FREE_CAPACITY_UNAVAILABLE", "Free custom-rule capacity changed; no plan is purchased automatically");
    await event("waf_create_intent");
    const entrypoint = inventory.find(set => set.kind === "zone");
    if (entrypoint) await control.zone(`/rulesets/${entrypoint.id}/rules`, { method: "POST", body: expected });
    else await control.zone("/rulesets", { method: "POST", body: { kind: "zone", name: "cfKanban custom request filters", phase: PHASE, rules: [expected] } });
  } else if (!enabled && rule) {
    await event("waf_delete_intent");
    await control.zone(`/rulesets/${rule.ruleset_id}/rules/${rule.id}`, { method: "DELETE" });
  }
  inventory = await readWaf(control.zone);
  if (foreignRulesDigest(inventory, ref) !== plan.before.foreign_rules_digest) fail("PUBLIC_ACCESS_FOREIGN_RULE_DRIFT", "Unrelated rules changed during the request; no success receipt was written");
  matches = inventory.flatMap(set => set.rules.filter(candidate => candidate.ref === ref).map(candidate => ({ ruleset_id: set.id, ...candidate })));
  if (enabled ? matches.length !== 1 || canonicalDigest(ruleBody(matches[0])) !== canonicalDigest(expected) : matches.length !== 0) fail("PUBLIC_ACCESS_RULE_READBACK_FAILED", "The exact owned-rule change was not verified; resume the original operation");
  await event("waf_verified");
  return enabled ? { rule_id: matches[0].id, ruleset_id: matches[0].ruleset_id, rule_ref: ref, waf_profile: PROFILE } : { rule_id: null, ruleset_id: null, rule_ref: ref, waf_profile: "disabled" };
}
export async function applyPublicAccess(input) {
  const plan = input.plan;
  if (plan?.kind !== "cfkanban_public_access" || plan.instance_id !== input.instanceId || plan.operation_id !== input.operationId || plan.task_id !== input.taskId || !MODES.includes(plan.mode) || plan.purchase_or_upgrade_plan !== false) fail("INVALID_PUBLIC_ACCESS_PLAN", "Use the exact authorized public-access plan");
  if (["domain-enable", "domain-rollback"].includes(plan.mode) && plan.passkey_impact?.recovery_prepared !== true) fail("PUBLIC_ACCESS_PASSKEY_RECOVERY_NOT_READY", "Prepare and explicitly confirm same-identity recovery and new-RP Passkey registration before authorizing this cutover");
  const supplied = { ...input, zoneId: plan.target.zone_id, hostname: plan.target.hostname, receiptPath: plan.target.receipt_path, wranglerExecutable: plan.target.wrangler_executable, cloudflareProfile: plan.target.cloudflare_profile, contextDirectory: plan.target.context_directory };
  const local = await loadLocal(supplied);
  if (canonicalDigest(local.target) !== canonicalDigest(plan.target)) fail("PUBLIC_ACCESS_RECEIPT_DRIFT", "Deployment evidence differs from the frozen plan");
  let journal = await assertJournalAuthorization({ stateRoot: local.stateRoot, instanceId: input.instanceId, operationId: input.operationId, taskId: input.taskId, plan });
  const releaseLock = await acquirePublicAccessLock({ stateRoot: local.stateRoot, journalsRoot: local.paths.journalsRoot, operationId: plan.operation_id });
  try {
    const control = await clients(input, plan.target);
    if (canonicalDigest(local.managed) !== plan.before.managed_digest && local.managed?.operation_id !== plan.operation_id) fail("PUBLIC_ACCESS_RECEIPT_DRIFT", "A different public-access operation has completed; this older journal cannot overwrite it");
    const event = async (type) => { await appendJournalEvent({ stateRoot: local.stateRoot, instanceId: input.instanceId, operationId: input.operationId, event: { type: `public_access_${type}` } }); journal.events.push({ type: `public_access_${type}` }); };
    await readZone(control.zone, plan.target);
    // 恢复日志不延续旧的应用授权；每次继续控制面变更前重新验证现任 Owner。
    const currentOwner = await ownerRead(input, local);
    let routing = await readRouting(control.worker, control.zone, plan.target);
    const started = journal.events.some(entry => entry.type.startsWith("public_access_"));
    if (!started) {
      if (routingDigest(routing) !== routingDigest(plan.before.routing) || canonicalDigest(local.managed) !== plan.before.managed_digest) fail("PUBLIC_ACCESS_ROUTING_DRIFT", "Public routing changed after the plan was created");
      if (canonicalDigest(currentOwner) !== canonicalDigest(plan.before.owner)) fail("PUBLIC_ACCESS_ORIGIN_DRIFT", "Owner/origin evidence changed after planning");
      await event("started");
    }
    const foreignDomains = values => values.filter(domain => domain.hostname !== plan.target.hostname);
    if (canonicalDigest(foreignDomains(routing.domains)) !== canonicalDigest(foreignDomains(plan.before.routing.domains))) fail("PUBLIC_ACCESS_ROUTING_DRIFT", "Other Worker domain mappings changed; no mapping is overwritten");
    let domain = ownedDomain(routing, plan.target), wafResult = local.managed ? { rule_id: local.managed.rule_id, ruleset_id: local.managed.ruleset_id, rule_ref: local.managed.rule_ref, waf_profile: local.managed.waf_profile } : { rule_id: null, ruleset_id: null, rule_ref: ownedRef(plan.instance_id), waf_profile: "disabled" };
    if (plan.mode === "domain-enable") {
      if (domain && (!journal.events.some(entry => entry.type === "public_access_domain_create_intent") || domain.service !== plan.target.worker_name || domain.zone_id !== plan.target.zone_id)) fail("PUBLIC_ACCESS_DOMAIN_ALREADY_IN_USE", "The selected hostname appeared outside this authorized operation");
      if (!domain) {
        if (boundedList(await control.zone("/dns_records", { raw: true, query: { name: plan.target.hostname, per_page: "100" } })).length) fail("PUBLIC_ACCESS_DNS_ALREADY_IN_USE", "DNS appeared after planning; no record is overwritten");
        await event("domain_create_intent");
        await control.worker("/domains", { method: "PUT", body: { hostname: plan.target.hostname, service: plan.target.worker_name, zone_id: plan.target.zone_id } });
        routing = await readRouting(control.worker, control.zone, plan.target); domain = ownedDomain(routing, plan.target);
      }
      if (!domain || domain.service !== plan.target.worker_name || domain.zone_id !== plan.target.zone_id) fail("PUBLIC_ACCESS_DOMAIN_UNVERIFIED", "The exact new domain mapping is not confirmed");
      await moveOrigin(input, local, plan, `https://${plan.target.hostname}`, event);
      await event("workers_dev_disable_intent");
      await control.worker(`/scripts/${plan.target.worker_name}/subdomain`, { method: "POST", body: { enabled: false, previews_enabled: false } });
    } else if (plan.mode === "domain-rollback") {
      if (domain) assertManaged(local, routing);
      else if (!journal.events.some(entry => entry.type === "public_access_domain_delete_intent")) fail("PUBLIC_ACCESS_DOMAIN_UNVERIFIED", "The owned domain disappeared outside this operation");
      if (!routing.workers_dev || routing.previews_enabled) {
        await event("workers_dev_enable_intent");
        await control.worker(`/scripts/${plan.target.worker_name}/subdomain`, { method: "POST", body: { enabled: true, previews_enabled: false } });
      }
      await moveOrigin(input, local, plan, routing.workers_dev_origin, event);
      if (plan.before.owned_rules.length) wafResult = await applyWaf(input, local, plan, control, journal, event, false);
      if (domain) { await event("domain_delete_intent"); await control.worker(`/domains/${domain.id}`, { method: "DELETE" }); }
    } else {
      assertManaged(local, routing);
      wafResult = await applyWaf(input, local, plan, control, journal, event, plan.mode === "waf-enable");
    }
    routing = await readRouting(control.worker, control.zone, plan.target);
    const enabled = plan.mode !== "domain-rollback";
    domain = ownedDomain(routing, plan.target);
    if (routing.workers_dev !== !enabled || routing.previews_enabled !== false || (enabled ? !domain || domain.service !== plan.target.worker_name || domain.zone_id !== plan.target.zone_id : Boolean(domain))) fail("PUBLIC_ACCESS_ROUTING_UNVERIFIED", "Final domain, workers.dev and preview URL readback did not match the plan");
    local.metadata = await readJson(local.paths.instanceMetadata);
    await ownerRead(input, local);
    const receipt = { schema_version: 1, kind: "cfkanban_public_access_receipt", instance_id: plan.instance_id, account_id: plan.target.account_id, worker_name: plan.target.worker_name, zone_id: plan.target.zone_id, hostname: plan.target.hostname, domain_enabled: enabled, domain_id: domain?.id ?? null, workers_dev_origin: routing.workers_dev_origin, workers_dev: routing.workers_dev, previews_enabled: routing.previews_enabled, preferred_api_origin: local.metadata.trusted_api_origin, ...wafResult, operation_id: plan.operation_id, plan_digest: canonicalDigest(plan), verified_at: new Date().toISOString(), snapshot_not_realtime: true };
    await atomicWriteJson(local.managedPath, receipt);
    await event("complete");
    return { receipt, receipt_path: local.managedPath, secret_values_exposed: false };
  } finally { await releaseLock(); }
}

export async function verifyPlannedPublicAccess(input) {
  const { plan } = input;
  if (!plan.public_access) return null;
  const access = normalizePublicAccess(plan.public_access, { instanceId: plan.instance_id, accountId: plan.target.cloudflare_account_id, workerName: plan.resources.worker.name });
  const stateRoot = path.resolve(input.stateRoot ?? resolveStateRoot());
  const receiptPath = path.join(getInstancePaths({ stateRoot, instanceId: plan.instance_id }).receiptsRoot, "public-access.json");
  await assertNoSymlinkPath(receiptPath, stateRoot); await validatePrivatePath(receiptPath, "file");
  if (canonicalDigest(await readJson(receiptPath)) !== canonicalDigest(access)) fail("PUBLIC_ACCESS_RECEIPT_DRIFT", "Public-access ownership changed after the upgrade plan was frozen");
  const target = { instance_id: plan.instance_id, account_id: access.account_id, worker_name: access.worker_name, zone_id: access.zone_id, hostname: access.hostname, database_id: plan.resources.d1.database_id, wrangler_executable: input.wranglerExecutable, cloudflare_profile: plan.target.cloudflare_profile, context_directory: plan.target.cloudflare_auth_context_directory };
  return verifyPublicAccessConfiguration({ ...input, publicAccessReceipt: access, publicAccessTarget: target });
}

export async function verifyPublicAccessConfiguration(input) {
  const target = input.publicAccessTarget;
  const access = normalizePublicAccess(input.publicAccessReceipt, { instanceId: target.instance_id, accountId: target.account_id, workerName: target.worker_name });
  if (!access || target.zone_id !== access.zone_id || target.hostname !== access.hostname) fail("PUBLIC_ACCESS_RECEIPT_REQUIRED", "Use the exact selected public-access receipt");
  const control = await clients(input, target);
  if (access.domain_enabled) await readZone(control.zone, target);
  // 已回退的 hostname 可被其他服务重用；inactive 升级只核对原映射消失和 Worker 入口。
  const routing = await readRouting(control.worker, control.zone, target, { checkZoneRoutes: access.domain_enabled }), domain = ownedDomain(routing, target);
  if (routing.workers_dev !== !access.domain_enabled || routing.previews_enabled || routing.workers_dev_origin !== access.workers_dev_origin || (access.domain_enabled ? domain?.id !== access.domain_id || domain?.service !== access.worker_name || domain?.zone_id !== access.zone_id || routing.domains.filter(value => value.service === access.worker_name).length !== 1 : Boolean(domain) || routing.domains.some(value => value.service === access.worker_name))) fail("PUBLIC_ACCESS_ROUTING_DRIFT", "Managed domain or bypass exposure differs from the frozen upgrade target");
  if (access.waf_profile === PROFILE) {
    const inventory = await readWaf(control.zone);
    const rules = inventory.flatMap(set => set.rules.filter(rule => rule.ref === access.rule_ref).map(rule => ({ ruleset_id: set.id, ...rule })));
    if (rules.length !== 1 || rules[0].id !== access.rule_id || rules[0].ruleset_id !== access.ruleset_id || canonicalDigest(ruleBody(rules[0])) !== canonicalDigest(anonymousApiRule(access.hostname, access.instance_id))) fail("PUBLIC_ACCESS_RULE_DRIFT", "The exact owned WAF profile changed; normal upgrade cannot repair it implicitly");
  }
  return { verified: true, hostname: access.hostname, workers_dev: !access.domain_enabled, previews_enabled: false, waf_profile: access.waf_profile };
}
