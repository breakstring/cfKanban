import { toolError } from "./errors.mjs";
import { requireHttpsOrigin, requireUuid } from "./utils.mjs";

export const PUBLIC_ACCESS_NAMES = new Set(["PUBLIC_ACCESS_MODE", "PUBLIC_ACCESS_HOSTNAME", "PUBLIC_ACCESS_WAF_PROFILE", "PUBLIC_ACCESS_RULE_REF", "PUBLIC_ACCESS_VERIFIED_AT"]);
export function normalizePublicAccess(value, { instanceId, accountId, workerName } = {}) {
  if (value == null) return null;
  const keys = new Set(["schema_version", "kind", "instance_id", "account_id", "worker_name", "zone_id", "hostname", "domain_enabled", "domain_id", "workers_dev_origin", "workers_dev", "previews_enabled", "preferred_api_origin", "rule_id", "ruleset_id", "rule_ref", "waf_profile", "operation_id", "plan_digest", "verified_at", "snapshot_not_realtime"]);
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key)) || value.schema_version !== 1 || value.snapshot_not_realtime !== true || typeof value.plan_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.plan_digest)) throw toolError("INVALID_PUBLIC_ACCESS_RECEIPT", "Use only the exact non-secret public-access receipt fields");
  requireUuid(value.operation_id, "operation_id");
  const validId = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id);
  const validHost = host => typeof host === "string" && host.includes(".") && host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
  const enabled = value.domain_enabled === true;
  if (value.kind !== "cfkanban_public_access_receipt" || typeof value.domain_enabled !== "boolean" || value.workers_dev !== !enabled || value.previews_enabled !== false || !validHost(value.hostname) || !validId(value.zone_id) || (enabled ? !validId(value.domain_id) : value.domain_id !== null || value.waf_profile !== "disabled") || !validId(value.worker_name) || !validId(value.account_id) || !["disabled", "anonymous-api-filter"].includes(value.waf_profile) || !Number.isFinite(Date.parse(value.verified_at))
    || value.rule_ref !== `cfkanban_${requireUuid(value.instance_id, "instance_id").replaceAll("-", "")}_anonymous_api`
    || (value.waf_profile === "anonymous-api-filter" && (!validId(value.rule_id) || !validId(value.ruleset_id)))
    || (value.waf_profile === "disabled" && (value.rule_id !== null || value.ruleset_id !== null))
    || (instanceId !== undefined && value.instance_id !== instanceId) || (accountId !== undefined && value.account_id !== accountId) || (workerName !== undefined && value.worker_name !== workerName)
    || requireHttpsOrigin(value.preferred_api_origin) !== (enabled ? `https://${value.hostname}` : value.workers_dev_origin) || !requireHttpsOrigin(value.workers_dev_origin).endsWith(".workers.dev")) throw toolError("INVALID_PUBLIC_ACCESS_RECEIPT", "Preserving public access requires this tool's exact verified ownership or rollback receipt");
  return Object.fromEntries([...keys].map(key => [key, value[key]]));
}
export function publicAccessBindings(value) {
  const access = normalizePublicAccess(value);
  if (!access?.domain_enabled) return [];
  return Object.entries({ PUBLIC_ACCESS_MODE: "custom_domain", PUBLIC_ACCESS_HOSTNAME: access.hostname, PUBLIC_ACCESS_WAF_PROFILE: access.waf_profile, PUBLIC_ACCESS_RULE_REF: access.rule_ref, PUBLIC_ACCESS_VERIFIED_AT: access.verified_at }).map(([name, text]) => ({ type: "plain_text", name, text }));
}
export function publicAccessVars(value) { return Object.fromEntries(publicAccessBindings(value).map(binding => [binding.name, binding.text])); }
