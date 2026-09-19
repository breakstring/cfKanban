import { toolError } from "./errors.mjs";
import { requireUuid } from "./utils.mjs";
import { ATTACHMENT_CLEANUP_CRON, attachmentBucketName } from "./r2-storage.mjs";

export const USAGE_SECRET = "USAGE_ANALYTICS_TOKEN";
export const USAGE_VARS = new Set(["USAGE_ANALYTICS_ENABLED", "USAGE_ACCOUNT_ID", "USAGE_D1_DATABASE_ID", "USAGE_R2_BUCKET_NAME"]);

export function normalizeUsageConfig(value, { accountId, databaseId, bucketName = null }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["enabled", "account_id", "d1_database_id", "r2_bucket_name"].includes(key))) throw toolError("INVALID_USAGE_CONFIG", "Usage configuration accepts only non-secret resource identifiers");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw toolError("INVALID_USAGE_CONFIG", "Usage enabled must be boolean");
  value = { account_id: accountId, d1_database_id: databaseId, ...value };
  if (value.account_id !== accountId || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.account_id) || requireUuid(value.d1_database_id, "usage_database_id") !== databaseId) throw toolError("USAGE_RESOURCE_MISMATCH", "Usage analytics must target this deployment account and database");
  const bucket = value.r2_bucket_name == null ? null : attachmentBucketName(value.r2_bucket_name);
  if (bucket !== null && bucket !== bucketName) throw toolError("USAGE_RESOURCE_MISMATCH", "Usage analytics must target this deployment attachment bucket");
  return { enabled: value.enabled !== false, account_id: accountId, d1_database_id: databaseId, ...(bucket === null ? {} : { r2_bucket_name: bucket }) };
}

export function usageVars(config) {
  if (!config) return {};
  return {
    ...(Object.hasOwn(config, "enabled") ? { USAGE_ANALYTICS_ENABLED: String(config.enabled) } : {}),
    ...(Object.hasOwn(config, "account_id") ? { USAGE_ACCOUNT_ID: config.account_id } : {}),
    ...(Object.hasOwn(config, "d1_database_id") ? { USAGE_D1_DATABASE_ID: config.d1_database_id } : {}),
    ...(Object.hasOwn(config, "r2_bucket_name") ? { USAGE_R2_BUCKET_NAME: config.r2_bucket_name } : {}),
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
  return config;
}

export function usageBindings(config, secretPresent) {
  return [...Object.entries(usageVars(config)).map(([name, text]) => ({ type: "plain_text", name, text })), ...(secretPresent ? [{ type: "secret_text", name: USAGE_SECRET, value_redacted: true }] : [])];
}

export function deploymentCrons(plan) {
  return plan.resources?.r2 ? [ATTACHMENT_CLEANUP_CRON] : [];
}

export function targetWorkerBindings(plan) {
  const bindings = plan.resources.worker.current_bindings.filter((item) => item.type !== "r2_bucket" && !USAGE_VARS.has(item.name));
  if (plan.resources.r2) bindings.push({ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: plan.resources.r2.bucket_name });
  bindings.push(...usageBindings(plan.usage_analytics?.configuration, false));
  return bindings.sort((a, b) => (a.type + ":" + a.name).localeCompare(b.type + ":" + b.name));
}
