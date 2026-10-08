import { toolError } from "./errors.mjs";
import { requireUuid } from "./utils.mjs";
import { ATTACHMENT_CLEANUP_CRON, attachmentBucketName } from "./r2-storage.mjs";
import { COST_PROTECTION_NAMES, costProtectionBindings } from "./cost-protection-config.mjs";
import { PUBLIC_ACCESS_NAMES, publicAccessBindings } from "./public-access-config.mjs";
import { OWNER_CONTROL_VARS, ownerControlVars } from "./owner-control-config.mjs";

export const USAGE_SECRET = "USAGE_ANALYTICS_TOKEN";
export const USAGE_VARS = new Set(["USAGE_ANALYTICS_ENABLED", "USAGE_ACCOUNT_ID", "USAGE_D1_DATABASE_ID", "USAGE_R2_BUCKET_NAME", "USAGE_WORKER_NAME", "USAGE_BILLING_CYCLE_DAY", "USAGE_BILLING_PLAN", "USAGE_ACCOUNT_TOTALS_ENABLED", "USAGE_WARNING_PERCENT", "USAGE_R2_STANDARD_ONLY_SCOPE"]);

function extraUsageConfig(value, { workerName }) {
  const result = {};
  if (Object.hasOwn(value, "worker_name")) {
    if (typeof value.worker_name !== "string" || !/^[A-Za-z0-9_-]{1,63}$/u.test(value.worker_name) || value.worker_name !== workerName) throw toolError("USAGE_RESOURCE_MISMATCH", "Usage analytics must target this deployment Worker");
    result.worker_name = value.worker_name;
  }
  if (Object.hasOwn(value, "billing_cycle_day")) {
    if (!Number.isSafeInteger(value.billing_cycle_day) || value.billing_cycle_day < 1 || value.billing_cycle_day > 31) throw toolError("INVALID_USAGE_CONFIG", "Billing cycle day must be an explicit UTC day from 1 to 31");
    result.billing_cycle_day = value.billing_cycle_day;
  }
  if (Object.hasOwn(value, "billing_plan")) {
    if (!["free", "paid"].includes(value.billing_plan)) throw toolError("INVALID_USAGE_CONFIG", "Billing plan must be free or paid");
    result.billing_plan = value.billing_plan;
  }
  if (Object.hasOwn(value, "account_totals")) {
    if (typeof value.account_totals !== "boolean") throw toolError("INVALID_USAGE_CONFIG", "Account totals must be explicitly enabled or disabled");
    result.account_totals = value.account_totals;
  }
  if (Object.hasOwn(value, "warning_percent")) {
    if (!Number.isSafeInteger(value.warning_percent) || value.warning_percent < 1 || value.warning_percent > 100) throw toolError("INVALID_USAGE_CONFIG", "Usage warning percent must be between 1 and 100");
    result.warning_percent = value.warning_percent;
  }
  if (Object.hasOwn(value, "r2_standard_only_scope")) {
    if (!["unknown", "instance", "account"].includes(value.r2_standard_only_scope)) throw toolError("INVALID_USAGE_CONFIG", "R2 Standard-only scope must be explicitly verified instance, account, or unknown");
    result.r2_standard_only_scope = value.r2_standard_only_scope;
  }
  return result;
}

export function normalizeUsageConfig(value, { accountId, databaseId, bucketName = null, workerName }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["enabled", "account_id", "d1_database_id", "r2_bucket_name", "worker_name", "billing_cycle_day", "billing_plan", "account_totals", "warning_percent", "r2_standard_only_scope"].includes(key))) throw toolError("INVALID_USAGE_CONFIG", "Usage configuration accepts only non-secret resource identifiers and billing settings");
  if (Object.hasOwn(value, "warning_percent")) throw toolError("CLOUDFLARE_FEATURE_RETIRED", "Budget notifications are retired; existing deployment values are preserved without configuring new thresholds", { reason: "cloudflare_feature_retired" });
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw toolError("INVALID_USAGE_CONFIG", "Usage enabled must be boolean");
  value = { account_id: accountId, d1_database_id: databaseId, ...value };
  if (value.account_id !== accountId || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.account_id) || requireUuid(value.d1_database_id, "usage_database_id") !== databaseId) throw toolError("USAGE_RESOURCE_MISMATCH", "Usage analytics must target this deployment account and database");
  const bucket = value.r2_bucket_name == null ? null : attachmentBucketName(value.r2_bucket_name);
  if (bucket !== null && bucket !== bucketName) throw toolError("USAGE_RESOURCE_MISMATCH", "Usage analytics must target this deployment attachment bucket");
  return { enabled: value.enabled !== false, account_id: accountId, d1_database_id: databaseId, ...(bucket === null ? {} : { r2_bucket_name: bucket }), ...extraUsageConfig(value, { workerName }) };
}

export function usageVars(config) {
  if (!config) return {};
  return {
    ...(Object.hasOwn(config, "enabled") ? { USAGE_ANALYTICS_ENABLED: String(config.enabled) } : {}),
    ...(Object.hasOwn(config, "account_id") ? { USAGE_ACCOUNT_ID: config.account_id } : {}),
    ...(Object.hasOwn(config, "d1_database_id") ? { USAGE_D1_DATABASE_ID: config.d1_database_id } : {}),
    ...(Object.hasOwn(config, "r2_bucket_name") ? { USAGE_R2_BUCKET_NAME: config.r2_bucket_name } : {}),
    ...(Object.hasOwn(config, "worker_name") ? { USAGE_WORKER_NAME: config.worker_name } : {}),
    ...(Object.hasOwn(config, "billing_cycle_day") ? { USAGE_BILLING_CYCLE_DAY: String(config.billing_cycle_day) } : {}),
    ...(Object.hasOwn(config, "billing_plan") ? { USAGE_BILLING_PLAN: config.billing_plan } : {}),
    ...(Object.hasOwn(config, "account_totals") ? { USAGE_ACCOUNT_TOTALS_ENABLED: String(config.account_totals) } : {}),
    ...(Object.hasOwn(config, "warning_percent") ? { USAGE_WARNING_PERCENT: String(config.warning_percent) } : {}),
    ...(Object.hasOwn(config, "r2_standard_only_scope") ? { USAGE_R2_STANDARD_ONLY_SCOPE: config.r2_standard_only_scope } : {}),
  };
}

export function existingUsageConfig(bindings, target) {
  const found = (bindings ?? []).filter((item) => USAGE_VARS.has(item.name));
  if (!found.length) return null;
  const vars = Object.fromEntries(found.map((item) => [item.name, item.text]));
  if (found.some((item) => item.type !== "plain_text" || typeof item.text !== "string") || found.length !== Object.keys(vars).length || (Object.hasOwn(vars, "USAGE_ANALYTICS_ENABLED") && !["true", "false"].includes(vars.USAGE_ANALYTICS_ENABLED))) throw toolError("INVALID_USAGE_CONFIG", "Existing usage configuration is unsupported; reconcile it before upgrading");
  const config = {};
  if (Object.hasOwn(vars, "USAGE_ANALYTICS_ENABLED")) config.enabled = vars.USAGE_ANALYTICS_ENABLED === "true";
  if (Object.hasOwn(vars, "USAGE_ACCOUNT_ID")) {
    if (vars.USAGE_ACCOUNT_ID !== target.accountId || !/^[A-Za-z0-9_-]{1,128}$/u.test(vars.USAGE_ACCOUNT_ID)) throw toolError("USAGE_RESOURCE_MISMATCH", "Existing usage account must match this deployment");
    config.account_id = vars.USAGE_ACCOUNT_ID;
  }
  if (Object.hasOwn(vars, "USAGE_D1_DATABASE_ID")) {
    if (requireUuid(vars.USAGE_D1_DATABASE_ID, "usage_database_id") !== target.databaseId) throw toolError("USAGE_RESOURCE_MISMATCH", "Existing usage database must match this deployment");
    config.d1_database_id = vars.USAGE_D1_DATABASE_ID;
  }
  if (Object.hasOwn(vars, "USAGE_R2_BUCKET_NAME")) {
    if (attachmentBucketName(vars.USAGE_R2_BUCKET_NAME) !== target.bucketName) throw toolError("USAGE_RESOURCE_MISMATCH", "Existing usage bucket must match this deployment");
    config.r2_bucket_name = vars.USAGE_R2_BUCKET_NAME;
  }
  if (Object.hasOwn(vars, "USAGE_WORKER_NAME")) config.worker_name = vars.USAGE_WORKER_NAME;
  if (Object.hasOwn(vars, "USAGE_BILLING_CYCLE_DAY")) {
    if (!/^(?:[1-9]|[12][0-9]|3[01])$/u.test(vars.USAGE_BILLING_CYCLE_DAY)) throw toolError("INVALID_USAGE_CONFIG", "Existing billing cycle day is invalid");
    config.billing_cycle_day = Number(vars.USAGE_BILLING_CYCLE_DAY);
  }
  if (Object.hasOwn(vars, "USAGE_BILLING_PLAN")) config.billing_plan = vars.USAGE_BILLING_PLAN;
  if (Object.hasOwn(vars, "USAGE_ACCOUNT_TOTALS_ENABLED")) {
    if (!["true", "false"].includes(vars.USAGE_ACCOUNT_TOTALS_ENABLED)) throw toolError("INVALID_USAGE_CONFIG", "Existing account totals flag is invalid");
    config.account_totals = vars.USAGE_ACCOUNT_TOTALS_ENABLED === "true";
  }
  if (Object.hasOwn(vars, "USAGE_WARNING_PERCENT")) {
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/u.test(vars.USAGE_WARNING_PERCENT)) throw toolError("INVALID_USAGE_CONFIG", "Existing usage warning percent is invalid");
    config.warning_percent = Number(vars.USAGE_WARNING_PERCENT);
  }
  if (Object.hasOwn(vars, "USAGE_R2_STANDARD_ONLY_SCOPE")) config.r2_standard_only_scope = vars.USAGE_R2_STANDARD_ONLY_SCOPE;
  return { ...config, ...extraUsageConfig(config, target) };
}

export function usageBindings(config, secretPresent) {
  return [...Object.entries(usageVars(config)).map(([name, text]) => ({ type: "plain_text", name, text })), ...(secretPresent ? [{ type: "secret_text", name: USAGE_SECRET, value_redacted: true }] : [])];
}

export function deploymentCrons(plan) {
  return plan.resources?.r2 ? [ATTACHMENT_CLEANUP_CRON] : [];
}

export function targetWorkerBindings(plan) {
  const bindings = plan.resources.worker.current_bindings.filter((item) => item.type !== "r2_bucket" && !USAGE_VARS.has(item.name) && !COST_PROTECTION_NAMES.has(item.name) && !PUBLIC_ACCESS_NAMES.has(item.name) && !OWNER_CONTROL_VARS.has(item.name));
  if (plan.resources.r2) bindings.push({ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: plan.resources.r2.bucket_name });
  bindings.push(...usageBindings(plan.usage_analytics?.configuration, false));
  bindings.push(...costProtectionBindings(plan.cost_protection));
  bindings.push(...publicAccessBindings(plan.public_access));
  bindings.push(...Object.entries(ownerControlVars(plan)).map(([name, text]) => ({ type: "plain_text", name, text })));
  const policies = { INSTANCE_RATE_LIMITER: plan.bindings.rate_limits.instance, PRINCIPAL_RATE_LIMITER: plan.bindings.rate_limits.principal, UNAUTHENTICATED_RATE_LIMITER: plan.bindings.rate_limits.unauthenticated_sensitive, ANONYMOUS_LOGIN_RATE_LIMITER: plan.cost_protection?.anonymous_login, EXPENSIVE_READ_RATE_LIMITER: plan.cost_protection?.expensive_reads };
  return bindings.map(binding => {
    if (binding.type !== "ratelimit") return binding;
    const current = plan.resources.worker.current_bindings.find(item => item.name === binding.name);
    if (!plan.cloudflare_control?.enabled && current && current.simple === undefined) return binding;
    const policy = policies[binding.name];
    return { ...binding, simple: { limit: policy.limit, period: policy.period_seconds } };
  }).sort((a, b) => (a.type + ":" + a.name).localeCompare(b.type + ":" + b.name));
}
