import { reauthenticateOwner, requireOwnerControl } from "../kernel/authorization.ts";
import { isUuid, sha256Hex, timingSafeEqual } from "../kernel/crypto.ts";
import { ApiError, notFound, validationError, versionConflict } from "../kernel/errors.ts";
import { canonicalJson, validateIdempotencyKey } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { requireIdempotencyKey } from "./shared.ts";
import { api, findDuplicate, fixedTarget, instance, intent, list, localChange, object, operationResource, operationRow, operationWriteResult, ownedExpression, planResource, ProviderFailure, settingsRow, text, tokenFor, transition, type Assessment, type CloudflareControlDependencies, type OperationRow, type PlanRow, type Resource } from "./cloudflare-control.ts";

const PHASE = "http_request_firewall_custom", PROFILE = "anonymous-api-filter", FREE_RULE_LIMIT = 5;
interface BindingRow { binding_id: string; account_id: string; worker_name: string; database_id: string; instance_id: string; hostname: string; zone_id: string; domain_id: string; origin_version: number; provider_metadata_hash: string; source: string; verified_at: number; operation_id: string }
interface OwnershipRow { binding_id: string | null; rule_id: string | null; ruleset_id: string | null; rule_ref: string | null; rule_digest: string | null; operation_id: string | null; verified_at: number | null }
interface Inventory { sets: Resource[]; entrypoint: Resource | null; rules: Resource[]; digest: string; foreignDigest: string; owned: Resource | null }
interface LiveWaf { baseline: Resource; binding: BindingRow; ownership: OwnershipRow; inventory: Inventory; coverage: Resource; hostname: string; instanceId: string; conflicts: Resource[] }
function ruleBody(rule: Resource): Resource { return Object.fromEntries(["ref", "description", "enabled", "action", "expression"].map(key => [key, rule[key] ?? null])); }
function ruleRef(instanceId: string): string { return `cfkanban_${instanceId.replaceAll("-", "")}_anonymous_api`; }
function desiredRule(hostname: string, instanceId: string, marker?: string): Resource { return { ref: `${ruleRef(instanceId)}${marker ? `_${marker.replaceAll("-", "")}` : ""}`, description: `cfKanban ${instanceId} anonymous private API filter`, enabled: true, action: "block", expression: ownedExpression(hostname) }; }
function fixedRuleShape(rule: Resource): boolean {
  const allowed = new Set(["ref", "description", "enabled", "action", "expression", "id", "ruleset_id", "version", "last_updated"]);
  return Object.keys(rule).every(key => allowed.has(key));
}
function matchesOwnedProfile(rule: Resource, hostname: string, instanceId: string): boolean {
  const ref = typeof rule.ref === "string" ? rule.ref : "", prefix = ruleRef(instanceId);
  return fixedRuleShape(rule) && (ref === prefix || (ref.startsWith(`${prefix}_`) && /^[a-f0-9]{32}$/.test(ref.slice(prefix.length + 1)))) && canonicalJson(ruleBody(rule)) === canonicalJson({ ...desiredRule(hostname, instanceId), ref });
}
function semanticRule(rule: Resource): Resource { const { version: _version, last_updated: _updated, ...semantic } = rule; return semantic; }
function exactId(value: JsonValue | undefined): string { const id = text(value, 128); if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ProviderFailure("target_mismatch"); return id; }
async function origin(db: D1Database) { const row = await db.prepare("SELECT preferred_api_origin,version FROM instance_origin_settings WHERE singleton=1").first<{ preferred_api_origin: string; version: number }>(); if (!row) throw new ProviderFailure("unavailable"); return row; }
async function bindingRow(db: D1Database): Promise<BindingRow | null> { return db.prepare("SELECT * FROM cloudflare_waf_target_binding WHERE singleton=1").first<BindingRow>(); }
async function ownershipRow(db: D1Database): Promise<OwnershipRow> { const row = await db.prepare("SELECT * FROM cloudflare_waf_ownership WHERE singleton=1").first<OwnershipRow>(); if (!row) throw new ProviderFailure("unavailable"); return row; }
async function verifyWafWorkerDatabase(env: WorkerEnv, token: string, dependencies: CloudflareControlDependencies): Promise<void> {
  const target = fixedTarget(env), call = api(token, dependencies), path = `/accounts/${encodeURIComponent(target.account_id)}/workers/scripts/${encodeURIComponent(target.worker_name)}`;
  const deployment = object(list(object(await call(`${path}/deployments`)).deployments)[0]), active = list(deployment.versions);
  if (active.length !== 1 || object(active[0]).percentage !== 100) throw new ProviderFailure("target_mismatch");
  const resources = object(object(await call(`${path}/versions/${encodeURIComponent(exactId(object(active[0]).version_id))}`)).resources), bindings = list(resources.bindings).map(object), databases = bindings.filter(binding => binding.type === "d1" && binding.name === "DB");
  if (new Set(bindings.map(binding => text(binding.name))).size !== bindings.length || databases.length !== 1 || (databases[0]!.id ?? databases[0]!.database_id) !== target.database_id) throw new ProviderFailure("target_mismatch");
  const flags = object(resources.script_runtime).compatibility_flags;
  // Inspect the deployed version; /settings can describe an inactive candidate.
  if (!Array.isArray(flags) || flags.length > 64 || flags.some(flag => typeof flag !== "string") || !flags.includes("global_fetch_strictly_public") || flags.includes("global_fetch_private_origin")) throw new ProviderFailure("unsupported_contract");
}
async function verifiedTarget(env: WorkerEnv, dependencies: CloudflareControlDependencies, token: string): Promise<{ binding: BindingRow; hostname: string; instanceId: string; proofSource: "cloudflare_domain" | "origin_service" }> {
  const target = fixedTarget(env), control = await settingsRow(env.DB), meta = await instance(env.DB), currentOrigin = await origin(env.DB), binding = await bindingRow(env.DB), hostname = new URL(meta.preferred_api_origin).hostname;
  if (!binding) throw validationError("cloudflare_waf_target_binding_required");
  if (binding.account_id !== target.account_id || binding.worker_name !== target.worker_name || binding.database_id !== target.database_id || binding.instance_id !== meta.instance_id || binding.zone_id !== control.zone_id || binding.hostname !== hostname || binding.origin_version !== currentOrigin.version) throw validationError("cloudflare_waf_target_binding_changed");
  await verifyWafWorkerDatabase(env, token, dependencies);
  await verifiedZone(env, control.zone_id, hostname, token, dependencies);
  // Where the saved Token can read custom domains, detect mapping drift directly.
  // Deployment-runtime evidence is an independent, audited registration boundary.
  let proofSource: "cloudflare_domain" | "origin_service" = "cloudflare_domain";
  try { const domain = await exactDomain(env, hostname, control.zone_id!, token, dependencies); if (domain.id !== binding.domain_id || await sha256Hex(canonicalJson(domain)) !== binding.provider_metadata_hash) throw new ProviderFailure("target_mismatch"); }
  catch (error) { if (!(error instanceof ProviderFailure && error.capability === "permission_denied" && binding.source === "deployment_runtime")) throw error; await proveTrustedOrigin(env, token, dependencies); proofSource = "origin_service"; }
  return { binding, hostname, instanceId: meta.instance_id, proofSource };
}
async function verifiedZone(env: WorkerEnv, zoneId: string | null, hostname: string, token: string, dependencies: CloudflareControlDependencies): Promise<void> {
  if (!zoneId) throw validationError("cloudflare_zone_required");
  const zone = object(await api(token, dependencies)(`/zones/${encodeURIComponent(zoneId)}`));
  if (zone.id !== zoneId || object(zone.account).id !== fixedTarget(env).account_id || zone.status !== "active" || typeof zone.name !== "string" || (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`))) throw new ProviderFailure("target_mismatch");
}
async function exactDomain(env: WorkerEnv, hostname: string, zoneId: string, token: string, dependencies: CloudflareControlDependencies): Promise<Resource> {
  const target = fixedTarget(env), params = new URLSearchParams({ hostname, service: target.worker_name, zone_id: zoneId });
  const domains = list(await api(token, dependencies, true)(`/accounts/${encodeURIComponent(target.account_id)}/workers/domains?${params}`)).map(object);
  if (domains.length !== 1 || domains[0]!.hostname !== hostname || domains[0]!.service !== target.worker_name || domains[0]!.zone_id !== zoneId) throw new ProviderFailure("target_mismatch");
  return { id: exactId(domains[0]!.id), hostname, service: target.worker_name, zone_id: zoneId };
}
export async function registerWafTargetBinding(env: WorkerEnv, request: Request, auth: AuthContext, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); const token = tokenFor(env, "control"); if (!token) throw validationError("cloudflare_token_required");
  let binding: BindingRow, bindingId = crypto.randomUUID(), preserveOwnership = false;
  return localChange(env, request, auth, "/api/v1/admin/cloudflare/waf/target-binding", { expected_version: expected }, expected,
    id => [env.DB.prepare(`INSERT INTO cloudflare_waf_target_binding(singleton,binding_id,account_id,worker_name,database_id,instance_id,hostname,zone_id,domain_id,origin_version,provider_metadata_hash,source,verified_at,operation_id)
      SELECT 1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'worker_domain_read',?11,?12 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?12
      ON CONFLICT(singleton) DO UPDATE SET binding_id=excluded.binding_id,account_id=excluded.account_id,worker_name=excluded.worker_name,database_id=excluded.database_id,instance_id=excluded.instance_id,hostname=excluded.hostname,zone_id=excluded.zone_id,domain_id=excluded.domain_id,origin_version=excluded.origin_version,provider_metadata_hash=excluded.provider_metadata_hash,source=excluded.source,verified_at=excluded.verified_at,operation_id=excluded.operation_id`).bind(bindingId, binding.account_id, binding.worker_name, binding.database_id, binding.instance_id, binding.hostname, binding.zone_id, binding.domain_id, binding.origin_version, binding.provider_metadata_hash, now, id),
      env.DB.prepare(`UPDATE cloudflare_waf_ownership SET binding_id=?2,rule_ref=CASE WHEN ?3 THEN rule_ref ELSE ?4 END,operation_id=CASE WHEN ?3 THEN operation_id ELSE ?1 END,verified_at=CASE WHEN ?3 THEN verified_at ELSE ?5 END WHERE singleton=1 AND rule_id IS NULL AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?1)`).bind(id, bindingId, preserveOwnership ? 1 : 0, ruleRef(binding.instance_id), now)],
    async version => ({ version, target_binding: { status: "verified", source: "worker_domain_read", domain_id: binding.domain_id, verified_at: new Date(now).toISOString() } }), now,
    async () => { const control = await settingsRow(env.DB), meta = await instance(env.DB), currentOrigin = await origin(env.DB), hostname = new URL(meta.preferred_api_origin).hostname, target = fixedTarget(env); await verifyWafWorkerDatabase(env, token, dependencies); await verifiedZone(env, control.zone_id, hostname, token, dependencies); const domain = await exactDomain(env, hostname, control.zone_id!, token, dependencies), previous = await bindingRow(env.DB), owned = await ownershipRow(env.DB);
      const sameTarget = previous && previous.account_id === target.account_id && previous.worker_name === target.worker_name && previous.database_id === target.database_id && previous.instance_id === meta.instance_id && previous.hostname === hostname && previous.zone_id === control.zone_id && previous.domain_id === domain.id && previous.origin_version === currentOrigin.version;
      if (owned.rule_id && owned.binding_id !== previous?.binding_id) throw validationError("cloudflare_waf_ownership_binding_changed");
      if (sameTarget) bindingId = previous.binding_id;
      else if (owned.rule_id) throw validationError("cloudflare_waf_ownership_binding_changed");
      preserveOwnership = Boolean(sameTarget && owned.binding_id === bindingId);
      binding = { binding_id: bindingId, ...target, instance_id: meta.instance_id, hostname, zone_id: control.zone_id!, domain_id: exactId(domain.id), origin_version: currentOrigin.version, provider_metadata_hash: await sha256Hex(canonicalJson(domain)), source: "worker_domain_read", verified_at: now, operation_id: "" }; }, startIndex => ({
      sql: `EXISTS(SELECT 1 FROM instance_origin_settings origin JOIN instance_meta meta ON meta.singleton=origin.singleton WHERE origin.singleton=1 AND origin.version=?${startIndex} AND origin.preferred_api_origin=?${startIndex + 1} AND meta.instance_id=?${startIndex + 2})`,
      values: [binding.origin_version, `https://${binding.hostname}`, binding.instance_id],
    }));
}
async function inventory(env: WorkerEnv, token: string, dependencies: CloudflareControlDependencies, ownership: OwnershipRow): Promise<Inventory> {
  const control = await settingsRow(env.DB), path = `/zones/${encodeURIComponent(control.zone_id!)}/rulesets`, call = api(token, dependencies, true), summaries = list(await call(path)).map(object);
  if (summaries.length > 100 || new Set(summaries.map(set => exactId(set.id))).size !== summaries.length) throw new ProviderFailure("unavailable");
  for (const summary of summaries) { exactId(summary.id); text(summary.kind, 64); text(summary.phase, 128); }
  const custom = summaries.filter(set => set.phase === PHASE); if (custom.length > 10) throw new ProviderFailure("unavailable");
  const sets = await Promise.all(custom.map(async summary => { const set = object(await call(`${path}/${encodeURIComponent(exactId(summary.id))}`)); if (set.id !== summary.id || set.phase !== PHASE || set.kind !== summary.kind || (set.kind !== "zone" && set.kind !== "custom")) throw new ProviderFailure("target_mismatch"); const rules = list(set.rules).map(object); for (const rule of rules) { exactId(rule.id); text(rule.action, 64); text(rule.expression, 16_384); if (typeof rule.enabled !== "boolean") throw new ProviderFailure("unavailable"); } if (new Set(rules.map(rule => exactId(rule.id))).size !== rules.length) throw new ProviderFailure("unavailable"); return { id: exactId(set.id), kind: set.kind, phase: PHASE, rules } as Resource; }));
  sets.sort((left, right) => exactId(left.id).localeCompare(exactId(right.id)));
  let entrypoint: Resource | null = null;
  try { const entry = object(await call(`${path}/phases/${PHASE}/entrypoint`)); const found = sets.find(set => set.id === entry.id && set.kind === "zone"); if (!found || entry.kind !== "zone" || entry.phase !== PHASE || canonicalJson(list(found.rules).map(rule => semanticRule(object(rule)))) !== canonicalJson(list(entry.rules).map(rule => semanticRule(object(rule))))) throw new ProviderFailure("target_mismatch"); entrypoint = found; }
  catch (error) { if (!(error instanceof ProviderFailure && error.missingResource && sets.every(set => set.kind !== "zone"))) throw error; }
  if (sets.filter(set => set.kind === "zone").length > 1) throw new ProviderFailure("target_mismatch");
  const rules: Resource[] = sets.flatMap(set => list(set.rules).map(rule => ({ ...object(rule), ruleset_id: exactId(set.id) }))), allRuleIds = new Set(rules.map(rule => exactId(rule.id)));
  if (allRuleIds.size !== rules.length || rules.some(rule => rule.action === "execute" && !sets.some(set => set.id === object(rule.action_parameters).id))) throw new ProviderFailure("unavailable");
  const owned = ownership.rule_id ? rules.find(rule => rule.id === ownership.rule_id && rule.ruleset_id === ownership.ruleset_id) ?? null : null;
  if (ownership.rule_id && (!owned || owned.ruleset_id !== entrypoint?.id || !fixedRuleShape(owned) || await sha256Hex(canonicalJson(ruleBody(owned))) !== ownership.rule_digest)) throw validationError("cloudflare_waf_owned_rule_drift");
  const semantic: Resource[] = sets.map(set => ({ ...set, rules: list(set.rules).map(rule => semanticRule(object(rule))) }));
  const foreign = semantic.map(set => ({ ...set, rules: list(set.rules).filter(rule => !(object(rule).id === ownership.rule_id && set.id === ownership.ruleset_id)) }));
  return { sets, entrypoint, rules, owned, digest: await sha256Hex(canonicalJson(semantic)), foreignDigest: await sha256Hex(canonicalJson(foreign)), };
}
function possibleConflicts(inventory: Inventory, hostname: string, instanceId: string): Resource[] {
  return inventory.rules.filter(rule => rule.id !== inventory.owned?.id && rule.enabled !== false).flatMap(rule => {
    const expression = text(rule.expression, 16_384), hostOnly = /^\(?http\.host eq "([^"\\]+)"\)?$/.exec(expression);
    if (hostOnly && hostOnly[1] !== hostname) return [];
    if (rule.action === "skip" && inventory.owned && rule.ruleset_id === inventory.entrypoint?.id) {
      const ordered = list(inventory.entrypoint!.rules).map(object);
      if (ordered.findIndex(entry => entry.id === rule.id) > ordered.findIndex(entry => entry.id === inventory.owned!.id)) return [];
    }
    const duplicate = (typeof rule.ref === "string" && (rule.ref === ruleRef(instanceId) || rule.ref.startsWith(`${ruleRef(instanceId)}_`))) || rule.description === desiredRule(hostname, instanceId).description;
    return [{ rule_id: exactId(rule.id), ruleset_id: exactId(rule.ruleset_id), kind: duplicate ? "unowned_duplicate" : rule.action === "skip" ? "skip" : "expression_unverified", repositionable: rule.action === "skip" && rule.ruleset_id === inventory.entrypoint?.id }];
  });
}
async function ipAccessEvidence(env: WorkerEnv, token: string, dependencies: CloudflareControlDependencies): Promise<{ conflicts: Resource[]; digest: string }> {
  const control = await settingsRow(env.DB), target = fixedTarget(env), conflicts: Resource[] = [], evidence: Resource[] = [];
  for (const [scope, path] of [["zone", `/zones/${encodeURIComponent(control.zone_id!)}/firewall/access_rules/rules?per_page=500`], ["account", `/accounts/${encodeURIComponent(target.account_id)}/firewall/access_rules/rules?per_page=500`]] as const) {
    try {
      const access = list(await api(token, dependencies, true)(path)).map(object);
      for (const rule of access) {
        const id = exactId(rule.id), mode = text(rule.mode);
        evidence.push({ scope, id, mode, configuration_digest: await sha256Hex(canonicalJson(rule.configuration ?? null)) });
        if (mode === "whitelist") conflicts.push({ rule_id: id, ruleset_id: null, kind: "ip_access_allow", scope, repositionable: false });
      }
    } catch { evidence.push({ scope, status: "unverified" }); conflicts.push({ rule_id: null, ruleset_id: null, kind: "ip_access_unverified", scope, repositionable: false }); }
  }
  evidence.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return { conflicts, digest: await sha256Hex(canonicalJson(evidence)) };
}
async function coverage(env: WorkerEnv, token: string, dependencies: CloudflareControlDependencies): Promise<Resource> {
  try { const target = fixedTarget(env), result = object(await api(token, dependencies)(`/accounts/${encodeURIComponent(target.account_id)}/workers/scripts/${encodeURIComponent(target.worker_name)}/subdomain`)); if (typeof result.enabled !== "boolean" || typeof result.previews_enabled !== "boolean") throw new ProviderFailure("unavailable"); return { status: result.enabled || result.previews_enabled ? "incomplete" : "hostname_only", workers_dev: result.enabled, previews_enabled: result.previews_enabled }; }
  catch { return { status: "incomplete", workers_dev: null, previews_enabled: null }; }
}
async function liveWaf(env: WorkerEnv, dependencies: CloudflareControlDependencies, token: string): Promise<LiveWaf> {
  const { binding, hostname, instanceId, proofSource } = await verifiedTarget(env, dependencies, token), ownership = await ownershipRow(env.DB);
  if (ownership.rule_id && ownership.binding_id !== binding.binding_id) throw validationError("cloudflare_waf_ownership_binding_changed");
  const observed = await inventory(env, token, dependencies, ownership), exposed = await coverage(env, token, dependencies), access = await ipAccessEvidence(env, token, dependencies), conflicts = [...possibleConflicts(observed, hostname, instanceId), ...access.conflicts];
  const frozen: Resource = { target: { ...fixedTarget(env), instance_id: instanceId, hostname, zone_id: binding.zone_id, domain_id: binding.domain_id }, binding_id: binding.binding_id, origin_version: binding.origin_version, provider_metadata_hash: binding.provider_metadata_hash, target_proof_source: proofSource, token_hash: await sha256Hex(token), inventory_digest: observed.digest, ip_access_digest: access.digest, rule_refs: observed.rules.map(rule => rule.ref ?? null), foreign_rules_digest: observed.foreignDigest, entrypoint_id: observed.entrypoint?.id ?? null, entrypoint_rule_ids: observed.entrypoint ? list(observed.entrypoint.rules).map(rule => exactId(object(rule).id)) : [], owned_rule_id: ownership.rule_id, owned_ruleset_id: ownership.ruleset_id, owned_rule_digest: ownership.rule_digest, coverage: exposed };
  return { baseline: frozen, binding, ownership, inventory: observed, coverage: exposed, hostname, instanceId, conflicts };
}
export async function readWafStatus(env: WorkerEnv, dependencies: CloudflareControlDependencies = {}, suppliedToken?: string): Promise<Resource> {
  const control = await settingsRow(env.DB), meta = await instance(env.DB), binding = await bindingRow(env.DB), token = suppliedToken ?? tokenFor(env, "control"), hostname = new URL(meta.preferred_api_origin).hostname;
  const empty: Resource = { version: control.version, status: token ? "unverified" : "missing", zone_id: control.zone_id, hostname, target_binding: { status: binding ? "unverified" : "missing", source: binding?.source ?? null, domain_id: binding?.domain_id ?? null, verified_at: binding ? new Date(binding.verified_at).toISOString() : null }, ownership: { status: "missing", ruleset_id: null, rule_id: null }, entrypoint: { strategy: "unverified", id: null }, inventory: { complete: false, ruleset_count: 0, total_rule_count: 0, free_rule_limit: FREE_RULE_LIMIT, capacity_available: false }, owned_rule: null, other_rule_count: 0, conflicts: [], coverage: { status: "incomplete", workers_dev: null, previews_enabled: null }, protected: false };
  if (!token || !control.zone_id) return { ...empty, status: "missing" };
  try {
    await verifiedZone(env, control.zone_id, hostname, token, dependencies);
    const ownership = await ownershipRow(env.DB);
    if (ownership.rule_id && (!binding || ownership.binding_id !== binding.binding_id)) throw validationError("cloudflare_waf_ownership_binding_changed");
    const observed = await inventory(env, token, dependencies, ownership), exposed = await coverage(env, token, dependencies), access = await ipAccessEvidence(env, token, dependencies), conflicts = [...possibleConflicts(observed, hostname, meta.instance_id), ...access.conflicts], owned = observed.owned;
    let bindingStatus = "missing", liveDomainVerified = false, serviceProven = false;
    if (binding) { try { const verified = await verifiedTarget(env, dependencies, token); bindingStatus = "verified"; liveDomainVerified = verified.proofSource === "cloudflare_domain"; serviceProven = verified.proofSource === "origin_service"; } catch (error) { bindingStatus = error instanceof ProviderFailure ? error.capability : "target_mismatch"; } }
    const exact = owned && matchesOwnedProfile(owned, hostname, meta.instance_id);
    return { ...empty, status: "verified", target_binding: { status: bindingStatus, source: binding?.source ?? null, domain_id: binding?.domain_id ?? null, verified_at: binding ? new Date(binding.verified_at).toISOString() : null, live_verified: liveDomainVerified, service_proof: serviceProven }, ownership: { status: owned ? "verified" : "missing", ruleset_id: ownership.ruleset_id, rule_id: ownership.rule_id }, entrypoint: { strategy: observed.entrypoint ? "append_rule" : "create_entrypoint", id: observed.entrypoint?.id ?? null }, inventory: { complete: true, ruleset_count: observed.sets.length, total_rule_count: observed.rules.length, free_rule_limit: FREE_RULE_LIMIT, capacity_available: observed.rules.length < FREE_RULE_LIMIT || Boolean(owned) }, owned_rule: owned ? { id: owned.id ?? null, ...ruleBody(owned) } : null, other_rule_count: observed.rules.length - (owned ? 1 : 0), conflicts, coverage: exposed, protected: Boolean(exact && bindingStatus === "verified" && !conflicts.length && exposed.status === "hostname_only") };
  } catch (error) { const reason = error instanceof ProviderFailure ? error.capability : error instanceof Error && "details" in error ? object((error as { details: Resource }).details).reason ?? "unavailable" : "unavailable"; return { ...empty, status: error instanceof ProviderFailure ? error.capability : "target_mismatch", reason }; }
}
export async function planWaf(env: WorkerEnv, request: Request, auth: AuthContext, action: JsonValue, choice: JsonValue | undefined, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); if ((action !== "enable" && action !== "disable") || (choice !== undefined && choice !== "preserve_exemptions" && choice !== "before_conflicts")) throw validationError("invalid_cloudflare_waf_plan");
  const token = tokenFor(env, "control"); if (!token) throw validationError("cloudflare_token_required"); let live: LiveWaf, after: Resource, before: Resource; const planId = crypto.randomUUID();
  return localChange(env, request, auth, "/api/v1/admin/cloudflare/waf/plan", { action, conflict_choice: choice ?? null, expected_version: expected }, expected,
    (id, version) => [env.DB.prepare(`INSERT INTO cloudflare_control_plans(id,kind,control_version,baseline_json,before_json,after_json,created_at) SELECT ?1,'waf',?2,?3,?4,?5,?6 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?7`).bind(planId, version, canonicalJson(live.baseline), canonicalJson(before), canonicalJson(after), now, id)],
    async version => planResource({ id: planId, kind: "waf", control_version: version, baseline_json: canonicalJson(live.baseline), before_json: canonicalJson(before), after_json: canonicalJson(after), created_at: now, consumed_operation_id: null }), now,
    async () => { live = await liveWaf(env, dependencies, token); const owned = live.inventory.owned; if (action === "enable" && !owned && live.inventory.rules.length >= FREE_RULE_LIMIT) throw validationError("cloudflare_waf_free_capacity_unavailable"); if (owned && !matchesOwnedProfile(owned, live.hostname, live.instanceId)) throw validationError("cloudflare_waf_owned_rule_drift");
      const conflicts = action === "enable" ? live.conflicts : [], unpositionable = conflicts.some(entry => entry.repositionable !== true), entryRules = live.inventory.entrypoint ? list(live.inventory.entrypoint.rules).map(object) : [], first = entryRules.find(rule => conflicts.some(entry => entry.rule_id === rule.id));
      if (choice === "before_conflicts" && unpositionable) throw validationError("cloudflare_waf_conflict_not_repositionable");
      before = { owned_rule: owned ? { id: owned.id ?? null, ruleset_id: owned.ruleset_id ?? null, ...ruleBody(owned) } : null, total_rule_count: live.inventory.rules.length, coverage: live.coverage };
      after = { action, profile: action === "enable" ? PROFILE : "disabled", entrypoint_strategy: owned ? action === "disable" ? "delete_owned_rule" : choice === "before_conflicts" && first ? "reposition_owned_rule" : "none" : action === "disable" ? "none" : live.inventory.entrypoint ? "append_rule" : "create_entrypoint", entrypoint_id: live.inventory.entrypoint?.id ?? null, position_before: choice === "before_conflicts" ? first?.id ?? null : null, conflict_choice: choice ?? null, conflicts, apply_ready: !conflicts.length || choice !== undefined, coverage: { ...live.coverage, exemptions_preserved: conflicts.length > 0 && choice === "preserve_exemptions" }, rule: owned ? ruleBody(owned) : desiredRule(live.hostname, live.instanceId, planId), purchase_or_upgrade_plan: false, modifies_foreign_rules: false };
    });
}
async function assessWafDetailed(env: WorkerEnv, row: OperationRow, dependencies: CloudflareControlDependencies): Promise<{ assessment: Assessment; ownership?: Resource }> {
  if (row.status === "verified" || row.status === "failed") return { assessment: [row.status, row.failure_class, row.result_version_id, null] };
  if (row.dispatched_at === null) return { assessment: ["failed", "not_dispatched", null, null] };
  const token = tokenFor(env, "control"); if (!token) throw new ProviderFailure("missing"); const before = object(JSON.parse(row.baseline_json) as JsonValue), desired = object(JSON.parse(row.desired_json) as JsonValue), { binding, hostname, instanceId } = await verifiedTarget(env, dependencies, token);
  if (binding.binding_id !== before.binding_id || binding.origin_version !== before.origin_version || binding.provider_metadata_hash !== before.provider_metadata_hash || await sha256Hex(token) !== before.token_hash || canonicalJson(before.target ?? null) !== canonicalJson({ ...fixedTarget(env), instance_id: instanceId, hostname, zone_id: binding.zone_id, domain_id: binding.domain_id })) return { assessment: ["unknown", "cloudflare_waf_target_drift", null, null] };
  const access = await ipAccessEvidence(env, token, dependencies); if (access.digest !== before.ip_access_digest) return { assessment: ["unknown", "cloudflare_waf_ip_access_drift", row.result_version_id, null] };
  const recorded = await ownershipRow(env.DB), deleting = desired.action === "disable", oldOwnership: OwnershipRow = deleting ? { ...recorded, rule_id: null, ruleset_id: null, rule_digest: null } : recorded;
  const observed = await inventory(env, token, dependencies, oldOwnership);
  let owned = recorded.rule_id ? observed.rules.find(rule => rule.id === recorded.rule_id && rule.ruleset_id === recorded.ruleset_id) ?? null : null;
  if (!recorded.rule_id && !deleting) { const resultId = row.result_version_id; owned = resultId ? observed.rules.find(rule => rule.id === resultId) ?? null : null;
    if (!resultId && (desired.entrypoint_strategy === "append_rule" || desired.entrypoint_strategy === "create_entrypoint") && !list(before.rule_refs).includes(object(desired.rule).ref ?? null)) {
      const markerMatches = observed.rules.filter(rule => fixedRuleShape(rule) && rule.ref === object(desired.rule).ref && canonicalJson(ruleBody(rule)) === canonicalJson(object(desired.rule)));
      if (markerMatches.length === 1 && /^[a-f0-9]{32}$/.test(text(object(desired.rule).ref).slice(ruleRef(instanceId).length + 1))) owned = markerMatches[0]!;
    } }
  if (!deleting && (!owned || !fixedRuleShape(owned) || canonicalJson(ruleBody(owned)) !== canonicalJson(object(desired.rule)))) return { assessment: ["unknown", "cloudflare_waf_readback_mismatch", null, null] };
  if (deleting && before.owned_rule_id && observed.rules.some(rule => rule.id === before.owned_rule_id)) return { assessment: ["unknown", "cloudflare_waf_readback_mismatch", null, null] };
  const foreignSets = observed.sets.filter(set => !(before.entrypoint_id === null && set.id === owned?.ruleset_id && list(set.rules).length === 1));
  const foreignDigest = await sha256Hex(canonicalJson(foreignSets.map(set => ({ ...set, rules: list(set.rules).filter(rule => !(object(rule).id === (deleting ? before.owned_rule_id : owned?.id) && set.id === (deleting ? before.owned_ruleset_id : owned?.ruleset_id))).map(rule => semanticRule(object(rule))) }))));
  if (foreignDigest !== before.foreign_rules_digest) return { assessment: ["unknown", "cloudflare_waf_foreign_rule_drift", null, null] };
  const expectedOrder = list(before.entrypoint_rule_ids).filter(id => !(deleting || desired.entrypoint_strategy === "reposition_owned_rule") || id !== before.owned_rule_id);
  if (!deleting && owned) {
    if (owned.ruleset_id !== observed.entrypoint?.id || (before.entrypoint_id !== null && owned.ruleset_id !== before.entrypoint_id)) return { assessment: ["unknown", "cloudflare_waf_entrypoint_mismatch", null, null] };
    if (desired.entrypoint_strategy === "append_rule" || desired.entrypoint_strategy === "create_entrypoint" || desired.entrypoint_strategy === "reposition_owned_rule") {
      const beforeId = desired.position_before, position = beforeId === null ? expectedOrder.length : typeof beforeId === "string" ? expectedOrder.indexOf(beforeId) : -1;
      if (position < 0) return { assessment: ["unknown", "cloudflare_waf_position_mismatch", null, null] };
      expectedOrder.splice(position, 0, exactId(owned.id));
    }
  }
  if (canonicalJson(expectedOrder) !== canonicalJson(observed.entrypoint ? list(observed.entrypoint.rules).map(rule => exactId(object(rule).id)) : [])) return { assessment: ["unknown", "cloudflare_waf_position_mismatch", null, null] };
  return { assessment: ["verified", null, owned ? exactId(owned.id) : null, null], ownership: { binding_id: binding.binding_id, rule_id: deleting ? null : owned?.id ?? null, ruleset_id: deleting ? null : owned?.ruleset_id ?? null, rule_ref: deleting ? recorded.rule_ref ?? ruleRef(instanceId) : owned?.ref ?? ruleRef(instanceId), rule_digest: deleting ? null : await sha256Hex(canonicalJson(ruleBody(owned!))) } };
}
export async function assessWafOperation(env: WorkerEnv, row: OperationRow, dependencies: CloudflareControlDependencies): Promise<Assessment> { return (await assessWafDetailed(env, row, dependencies)).assessment; }
export async function verifyWafResult(env: WorkerEnv, request: Request, auth: AuthContext, row: OperationRow, dependencies: CloudflareControlDependencies, commandId?: string): Promise<boolean> {
  let result: { assessment: Assessment; ownership?: Resource };
  try { result = await assessWafDetailed(env, row, dependencies); }
  catch (error) { if (!(error instanceof ApiError)) throw error; const reason = error instanceof ProviderFailure ? error.capability : typeof error.details.reason === "string" ? error.details.reason : "unavailable"; result = { assessment: ["unknown", reason, row.result_version_id, null] }; }
  return transition(env, request, auth, row, ...result.assessment, false, commandId, result.ownership);
}
export async function applyWaf(env: WorkerEnv, request: Request, auth: AuthContext, planId: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  let intentStarted = false;
  try { return await applyWafInternal(env, request, auth, planId, expected, now, dependencies, () => { intentStarted = true; }); }
  catch (error) {
    if (intentStarted || !(error instanceof ApiError)) throw error;
    // This handler has neither attempted to persist an intent nor sent a write.
    throw new ApiError({ code: error.code, category: error.category, source: error.source, message: error.message, recovery: error.recovery, retryable: error.retryable, status: error.status, clearSessionCookies: error.clearSessionCookies, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }), details: { ...error.details, write_state: "not_dispatched" } });
  }
}
async function applyWafInternal(env: WorkerEnv, request: Request, auth: AuthContext, planId: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies, noteIntent: () => void): Promise<Resource> {
  requireOwnerControl(auth); if (!isUuid(requireIdempotencyKey(request))) throw validationError("invalid_idempotency_key");
  const requestHash = await sha256Hex(canonicalJson({ plan_id: planId, expected_version: expected })), duplicate = await findDuplicate(env, request, auth, requestHash, [], noteIntent); await reauthenticateOwner(env.DB, request, Date.now()); if (duplicate) return operationWriteResult(env, auth, duplicate, true);
  if (typeof planId !== "string" || !isUuid(planId)) throw validationError("invalid_cloudflare_plan");
  const plan = await env.DB.prepare("SELECT * FROM cloudflare_control_plans WHERE id=?1").bind(planId).first<PlanRow>(); if (!plan || plan.kind !== "waf") throw notFound(); if (plan.consumed_operation_id || plan.control_version !== expected) throw versionConflict((await settingsRow(env.DB)).version);
  const desired = object(JSON.parse(plan.after_json) as JsonValue); if (desired.apply_ready !== true) throw validationError("cloudflare_waf_conflict_choice_required"); const token = tokenFor(env, "control"); if (!token) throw validationError("cloudflare_token_required");
  const live = await liveWaf(env, dependencies, token), planned = object(JSON.parse(plan.baseline_json) as JsonValue); if (canonicalJson(live.baseline) !== canonicalJson(planned)) throw validationError("cloudflare_waf_baseline_changed");
  noteIntent();
  const row = await intent(env, request, auth, "waf", requestHash, { baseline: live.baseline }, desired, null, expected, now, planId); if (row.dispatched_at !== null || row.status !== "pending") return operationWriteResult(env, auth, row, true);
  try { const current = await liveWaf(env, dependencies, token); if (canonicalJson(current.baseline) !== plan.baseline_json) throw validationError("cloudflare_waf_baseline_changed"); }
  catch { await transition(env, request, auth, row, "failed", "preflight_changed", null, null); return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false); }
  if (!(await transition(env, request, auth, row, "pending", null, null, null, true))) return operationWriteResult(env, auth, await operationRow(env.DB, row.id), true);
  const path = `/zones/${encodeURIComponent(live.binding.zone_id)}/rulesets`, rule = object(desired.rule), position = desired.position_before ? { position: { before: desired.position_before } } : {};
  let mutationResult: JsonValue = null;
  try {
    if (desired.entrypoint_strategy === "append_rule") mutationResult = await api(token, dependencies)(`${path}/${encodeURIComponent(text(desired.entrypoint_id))}/rules`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...rule, ...position }) });
    else if (desired.entrypoint_strategy === "create_entrypoint") mutationResult = await api(token, dependencies)(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "zone", name: "cfKanban custom request filters", phase: PHASE, rules: [rule] }) });
    else if (desired.entrypoint_strategy === "delete_owned_rule") mutationResult = await api(token, dependencies)(`${path}/${encodeURIComponent(live.ownership.ruleset_id!)}/rules/${encodeURIComponent(live.ownership.rule_id!)}`, { method: "DELETE" });
    else if (desired.entrypoint_strategy === "reposition_owned_rule") mutationResult = await api(token, dependencies)(`${path}/${encodeURIComponent(live.ownership.ruleset_id!)}/rules/${encodeURIComponent(live.ownership.rule_id!)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...rule, ...position }) });
  } catch (error) { await transition(env, request, auth, await operationRow(env.DB, row.id), error instanceof ProviderFailure && error.rejected ? "failed" : "unknown", error instanceof ProviderFailure ? error.capability : "unavailable", null, null); return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false); }
  if (desired.entrypoint_strategy === "append_rule" || desired.entrypoint_strategy === "create_entrypoint") {
    try {
      const result = object(mutationResult), resultRules = list(result.rules).map(object), originalIds = new Set(live.inventory.rules.map(entry => exactId(entry.id)));
      const created = resultRules.filter(entry => fixedRuleShape(entry) && !originalIds.has(exactId(entry.id)) && canonicalJson(ruleBody(entry)) === canonicalJson(rule));
      if (created.length !== 1 || (desired.entrypoint_id && result.id !== desired.entrypoint_id)) throw new ProviderFailure("target_mismatch");
      await transition(env, request, auth, await operationRow(env.DB, row.id), "pending", null, exactId(created[0]!.id), null);
    } catch { await transition(env, request, auth, await operationRow(env.DB, row.id), "unknown", "cloudflare_waf_creation_id_unverified", null, null); return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false); }
  }
  try { await verifyWafResult(env, request, auth, await operationRow(env.DB, row.id), dependencies); }
  catch (error) { await transition(env, request, auth, await operationRow(env.DB, row.id), "unknown", error instanceof ProviderFailure ? error.capability : "unavailable", null, null); }
  return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false);
}

const PROOF_PATH = "/.well-known/cfkanban-waf-proof";
async function proofMac(token: string, label: "request" | "response", challenge: Resource): Promise<string> {
  const bytes = new TextEncoder(), derived = await sha256Hex(`cfKanban/WAF-target-proof/key/v1\0${token}`), key = await crypto.subtle.importKey("raw", bytes.encode(derived), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, bytes.encode(`cfKanban/WAF-target-proof/${label}/v1\0${canonicalJson(challenge)}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function proofTarget(env: WorkerEnv): Promise<Resource> { const meta = await instance(env.DB), currentOrigin = await origin(env.DB); return { ...fixedTarget(env), instance_id: meta.instance_id, preferred_api_origin: currentOrigin.preferred_api_origin, origin_version: currentOrigin.version }; }
export async function answerWafTargetProof(env: WorkerEnv, request: Request, challenge: Resource): Promise<Resource> {
  const token = tokenFor(env, "control"), signature = request.headers.get("x-cfkanban-waf-proof") ?? "";
  if (!token || typeof challenge.nonce !== "string" || !/^[a-f0-9]{64}$/.test(challenge.nonce) || typeof challenge.expires_at !== "number" || !Number.isSafeInteger(challenge.expires_at) || challenge.expires_at <= Date.now() || challenge.expires_at > Date.now() + 10_000 || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(signature, await proofMac(token, "request", challenge))) throw notFound();
  const target = await proofTarget(env);
  if (canonicalJson(challenge.target ?? null) !== canonicalJson(target) || new URL(request.url).origin !== target.preferred_api_origin) throw notFound();
  return { proof: await proofMac(token, "response", challenge) };
}
async function proveTrustedOrigin(env: WorkerEnv, token: string, dependencies: CloudflareControlDependencies): Promise<void> {
  const target = await proofTarget(env), trusted = new URL(text(target.preferred_api_origin));
  if (trusted.protocol !== "https:" || trusted.port || trusted.username || trusted.password || trusted.hostname === "localhost" || trusted.hostname.endsWith(".localhost") || trusted.hostname.includes(":") || /^[0-9.]+$/.test(trusted.hostname) || trusted.pathname !== "/" || trusted.search || trusted.hash) throw new ProviderFailure("target_mismatch");
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32)), challenge: Resource = { nonce: Array.from(nonceBytes, byte => byte.toString(16).padStart(2, "0")).join(""), expires_at: Date.now() + 10_000, target }, signature = await proofMac(token, "request", challenge), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await (dependencies.fetch ?? fetch)(new URL(PROOF_PATH, trusted).href, { method: "POST", headers: { "content-type": "application/json", "x-cfkanban-waf-proof": signature }, body: canonicalJson(challenge), redirect: "manual", signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderFailure("unavailable"); }
    const reader = response.body?.getReader(); if (!reader) throw new ProviderFailure("unavailable"); const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 65_536) { await reader.cancel(); throw new ProviderFailure("unavailable"); } chunks.push(next.value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = object(JSON.parse(new TextDecoder().decode(bytes)) as JsonValue);
    if (typeof result.proof !== "string" || !timingSafeEqual(result.proof, await proofMac(token, "response", challenge)) || Date.now() >= Number(challenge.expires_at)) throw new ProviderFailure("target_mismatch");
  } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure("unavailable"); }
  finally { clearTimeout(timer); }
}

export async function getWafOperationByKey(env: WorkerEnv, auth: AuthContext, requestKey: string): Promise<Resource> {
  requireOwnerControl(auth); validateIdempotencyKey(requestKey); if (!isUuid(requestKey)) throw validationError("invalid_idempotency_key");
  const row = await env.DB.prepare("SELECT * FROM cloudflare_control_operations WHERE principal_id=?1 AND route=?2 AND key_hash=?3").bind(auth.principalId, "/api/v1/admin/cloudflare/waf/apply", await sha256Hex(requestKey)).first<OperationRow>();
  if (!row) throw notFound();
  return operationResource(row, (await settingsRow(env.DB)).version);
}
