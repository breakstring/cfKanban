import { toolError } from "./errors.mjs";
import { canonicalDigest, requireHttpsOrigin, requireUuid } from "./utils.mjs";

export const PUBLIC_ACCESS_NAMES = new Set(["PUBLIC_ACCESS_MODE", "PUBLIC_ACCESS_HOSTNAME", "PUBLIC_ACCESS_WAF_PROFILE", "PUBLIC_ACCESS_RULE_REF", "PUBLIC_ACCESS_VERIFIED_AT"]);
export function normalizePublicAccess(value, { instanceId, accountId, workerName } = {}) {
  if (value == null) return null;
  const keys = new Set(["schema_version", "kind", "instance_id", "account_id", "worker_name", "zone_id", "hostname", "domain_enabled", "domain_id", "workers_dev_origin", "workers_dev", "previews_enabled", "preferred_api_origin", "rule_id", "ruleset_id", "rule_ref", "waf_profile", "operation_id", "plan_digest", "verified_at", "snapshot_not_realtime", "domain_ownership_proven"]);
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key)) || value.schema_version !== 1 || value.snapshot_not_realtime !== true || typeof value.plan_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.plan_digest)) throw toolError("INVALID_PUBLIC_ACCESS_RECEIPT", "Use only the exact non-secret public-access receipt fields");
  requireUuid(value.operation_id, "operation_id");
  const validId = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id);
  const validHost = host => typeof host === "string" && host.includes(".") && host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
  const enabled = value.domain_enabled === true;
  const baseRef = `cfkanban_${requireUuid(value.instance_id, "instance_id").replaceAll("-", "")}_anonymous_api`;
  const validRef = value.rule_ref === baseRef || (typeof value.rule_ref === "string" && value.rule_ref.startsWith(`${baseRef}_`) && /^[a-f0-9]{32}$/u.test(value.rule_ref.slice(baseRef.length + 1)));
  if (!["cfkanban_public_access_receipt", "cfkanban_waf_target_projection"].includes(value.kind) || (value.kind === "cfkanban_waf_target_projection" ? value.domain_ownership_proven !== false || !enabled : value.domain_ownership_proven !== undefined && value.domain_ownership_proven !== true) || typeof value.domain_enabled !== "boolean" || value.workers_dev !== !enabled || value.previews_enabled !== false || !validHost(value.hostname) || !validId(value.zone_id) || (enabled ? !validId(value.domain_id) : value.domain_id !== null || value.waf_profile !== "disabled") || !validId(value.worker_name) || !validId(value.account_id) || !["disabled", "anonymous-api-filter"].includes(value.waf_profile) || !Number.isFinite(Date.parse(value.verified_at))
    || !validRef
    || (value.waf_profile === "anonymous-api-filter" && (!validId(value.rule_id) || !validId(value.ruleset_id)))
    || (value.waf_profile === "disabled" && (value.rule_id !== null || value.ruleset_id !== null))
    || (instanceId !== undefined && value.instance_id !== instanceId) || (accountId !== undefined && value.account_id !== accountId) || (workerName !== undefined && value.worker_name !== workerName)
    || requireHttpsOrigin(value.preferred_api_origin) !== (enabled ? `https://${value.hostname}` : value.workers_dev_origin) || !requireHttpsOrigin(value.workers_dev_origin).endsWith(".workers.dev")) throw toolError("INVALID_PUBLIC_ACCESS_RECEIPT", "Preserving public access requires this tool's exact verified ownership or rollback receipt");
  return Object.fromEntries([...keys].filter(key => key in value).map(key => [key, value[key]]));
}
export function projectWafAuthority(authority, routing, domainReceipt = null) {
  const binding = authority?.binding, own = authority?.ownership;
  if (!binding || !own || own.binding_id !== binding.binding_id || routing.workers_dev || routing.previews_enabled || routing.domains.filter(domain => domain.service === binding.worker_name).length !== 1 || !routing.domains.some(domain => domain.id === binding.domain_id && domain.hostname === binding.hostname && domain.service === binding.worker_name && domain.zone_id === binding.zone_id)) throw toolError("WAF_TARGET_PROJECTION_UNPROVEN", "An exact registered target and closed bypass exposure are required for normal upgrade preservation");
  if (domainReceipt && (domainReceipt.hostname !== binding.hostname || domainReceipt.zone_id !== binding.zone_id || domainReceipt.domain_id !== binding.domain_id || domainReceipt.preferred_api_origin !== `https://${binding.hostname}`)) throw toolError("WAF_TARGET_DOMAIN_RECEIPT_DRIFT", "The historical domain ownership receipt differs from the registered target");
  const state = { rule_id: own.rule_id, ruleset_id: own.ruleset_id, rule_ref: own.rule_ref ?? `cfkanban_${binding.instance_id.replaceAll("-", "")}_anonymous_api`, waf_profile: own.rule_id ? "anonymous-api-filter" : "disabled", verified_at: new Date(own.verified_at ?? binding.verified_at).toISOString() };
  const value = domainReceipt ? { ...normalizePublicAccess(domainReceipt), ...state } : { schema_version: 1, kind: "cfkanban_waf_target_projection", domain_ownership_proven: false, instance_id: binding.instance_id, account_id: binding.account_id, worker_name: binding.worker_name, zone_id: binding.zone_id, hostname: binding.hostname, domain_enabled: true, domain_id: binding.domain_id, workers_dev_origin: routing.workers_dev_origin, workers_dev: false, previews_enabled: false, preferred_api_origin: `https://${binding.hostname}`, ...state, operation_id: own.operation_id ?? binding.operation_id, plan_digest: canonicalDigest(authority), snapshot_not_realtime: true };
  return normalizePublicAccess(value, { instanceId: binding.instance_id, accountId: binding.account_id, workerName: binding.worker_name });
}
export function normalizeWafAuthority(value, { instanceId, accountId, workerName, databaseId } = {}) {
  if (value == null) return null;
  const keys = ["schema_version", "control_version", "origin_version", "binding", "ownership"];
  const binding = value.binding, own = value.ownership;
  const bindingKeys = ["binding_id", "account_id", "worker_name", "database_id", "instance_id", "hostname", "zone_id", "domain_id", "origin_version", "provider_metadata_hash", "source", "verified_at", "operation_id"];
  const ownKeys = ["binding_id", "rule_id", "ruleset_id", "rule_ref", "rule_digest", "operation_id", "verified_at"];
  if (!binding || !own || typeof binding !== "object" || Array.isArray(binding) || typeof own !== "object" || Array.isArray(own) || bindingKeys.some(key => !(key in binding)) || ownKeys.some(key => !(key in own)) || Object.keys(binding).some(key => !bindingKeys.includes(key)) || Object.keys(own).some(key => !ownKeys.includes(key))) throw toolError("WAF_TARGET_AUTHORITY_INVALID", "WAF authority can contain only the complete exact non-secret binding and ownership fields");
  const validId = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id), validTime = time => Number.isSafeInteger(time) && time >= 0;
  const baseRef = `cfkanban_${requireUuid(binding.instance_id, "binding_instance_id").replaceAll("-", "")}_anonymous_api`, validRef = own.rule_ref === null || own.rule_ref === baseRef || (typeof own.rule_ref === "string" && own.rule_ref.startsWith(`${baseRef}_`) && /^[a-f0-9]{32}$/u.test(own.rule_ref.slice(baseRef.length + 1)));
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || value.schema_version !== 27 || !Number.isSafeInteger(value.control_version) || value.control_version < 1 || !Number.isSafeInteger(value.origin_version) || value.origin_version < 1 || !binding || !own || own.binding_id !== binding.binding_id || binding.instance_id !== instanceId || binding.account_id !== accountId || binding.worker_name !== workerName || binding.database_id !== databaseId || binding.origin_version !== value.origin_version || !["deployment_runtime", "worker_domain_read"].includes(binding.source) || !/^[a-f0-9]{64}$/u.test(binding.provider_metadata_hash) || (own.rule_id ? !own.ruleset_id || !/^[a-f0-9]{64}$/u.test(own.rule_digest) : own.ruleset_id !== null || own.rule_digest !== null)) throw toolError("WAF_TARGET_AUTHORITY_INVALID", "Use only the exact bounded D1 WAF ownership readback for this approved deployment");
  requireUuid(binding.binding_id, "binding_id"); requireUuid(binding.operation_id, "operation_id");
  requireUuid(binding.database_id, "binding_database_id");
  if (![binding.account_id, binding.worker_name, binding.zone_id, binding.domain_id].every(validId) || typeof binding.hostname !== "string" || binding.hostname.length > 253 || !binding.hostname.includes(".") || !binding.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) || !validTime(binding.verified_at) || (own.verified_at !== null && !validTime(own.verified_at)) || !validRef || (own.rule_id !== null && (!validId(own.rule_id) || !validId(own.ruleset_id) || own.rule_ref === null))) throw toolError("WAF_TARGET_AUTHORITY_INVALID", "The authoritative target, rule reference and verification timestamps must be exact");
  if (own.operation_id !== null) requireUuid(own.operation_id, "ownership_operation_id");
  return { schema_version: 27, control_version: value.control_version, origin_version: value.origin_version, binding: { ...binding }, ownership: { ...own } };
}
export function publicAccessBindings(value) {
  const access = normalizePublicAccess(value);
  if (!access?.domain_enabled) return [];
  return Object.entries({ PUBLIC_ACCESS_MODE: "custom_domain", PUBLIC_ACCESS_HOSTNAME: access.hostname, PUBLIC_ACCESS_WAF_PROFILE: access.waf_profile, PUBLIC_ACCESS_RULE_REF: access.rule_ref, PUBLIC_ACCESS_VERIFIED_AT: access.verified_at }).map(([name, text]) => ({ type: "plain_text", name, text }));
}
export function publicAccessVars(value) { return Object.fromEntries(publicAccessBindings(value).map(binding => [binding.name, binding.text])); }
