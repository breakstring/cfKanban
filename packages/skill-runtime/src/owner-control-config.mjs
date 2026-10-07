import { toolError } from "./errors.mjs";

export const OWNER_CONTROL_SECRETS = new Set(["CFKANBAN_CONFIGURATION_TOKEN", "CFKANBAN_CONTROL_TOKEN"]);
export const OWNER_CONTROL_VARS = new Set(["CFKANBAN_CONTROL_ACCOUNT_ID", "CFKANBAN_CONTROL_WORKER_NAME", "CFKANBAN_CONTROL_DATABASE_ID", "USAGE_HISTORY_ENABLED"]);

export function existingOwnerControl(bindings = [], { accountId, workerName, databaseId }) {
  const found = bindings.filter(item => OWNER_CONTROL_VARS.has(item.name));
  const vars = Object.fromEntries(found.map(item => [item.name, item.text]));
  if (found.some(item => item.type !== "plain_text" || typeof item.text !== "string") || found.length !== Object.keys(vars).length) {
    throw toolError("OWNER_CONTROL_READBACK_INVALID", "Owner control settings require an exact non-secret readback");
  }
  for (const [name, expected] of [["CFKANBAN_CONTROL_ACCOUNT_ID", accountId], ["CFKANBAN_CONTROL_WORKER_NAME", workerName], ["CFKANBAN_CONTROL_DATABASE_ID", databaseId]]) {
    if (Object.hasOwn(vars, name) && vars[name] !== expected) throw toolError("OWNER_CONTROL_TARGET_MISMATCH", "Owner control settings must match this deployment", { field: name });
  }
  if (Object.hasOwn(vars, "USAGE_HISTORY_ENABLED") && !["true", "false"].includes(vars.USAGE_HISTORY_ENABLED)) throw toolError("OWNER_CONTROL_READBACK_INVALID", "History enabled must be an explicit boolean");
  return { history_enabled: vars.USAGE_HISTORY_ENABLED === "true" };
}

export function ownerControlVars(plan, databaseId = plan.resources?.d1?.database_id) {
  if (!plan.cloudflare_control?.enabled) return {};
  return {
    CFKANBAN_CONTROL_ACCOUNT_ID: plan.target.cloudflare_account_id,
    CFKANBAN_CONTROL_WORKER_NAME: plan.resources.worker.name,
    CFKANBAN_CONTROL_DATABASE_ID: databaseId,
    USAGE_HISTORY_ENABLED: String(plan.cloudflare_control.history_enabled === true),
  };
}

export function nativeRateLimitSimple(value, { required = false, scope, errorCode = "OWNER_CONTROL_READBACK_INVALID" } = {}) {
  if (value === undefined && !required) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.limit) || value.limit < 1 || ![10, 60].includes(value.period)) {
    throw toolError(errorCode, "Native rate limits require a positive limit and an exact 10 or 60 second period", scope ? { scope } : {});
  }
  return { limit: value.limit, period: value.period };
}

export function observedCoreRateLimits(bindings, fallback) {
  if (!bindings?.some(item => item.name === "CFKANBAN_CONTROL_WORKER_NAME")) return fallback;
  const vars = Object.fromEntries(bindings.filter(item => item.type === "plain_text").map(item => [item.name, item.text]));
  const result = {};
  for (const [scope, prefix, name] of [["instance", "INSTANCE", "INSTANCE_RATE_LIMITER"], ["principal", "PRINCIPAL", "PRINCIPAL_RATE_LIMITER"], ["unauthenticated_sensitive", "UNAUTHENTICATED_SENSITIVE", "UNAUTHENTICATED_RATE_LIMITER"]]) {
    const limit = vars[`RATE_LIMIT_${prefix}_LIMIT`];
    const period = vars[`RATE_LIMIT_${prefix}_PERIOD_SECONDS`];
    if (!/^[1-9][0-9]*$/u.test(limit ?? "") || !Number.isSafeInteger(Number(limit)) || !/^(10|60)$/u.test(period ?? "")) throw toolError("OWNER_CONTROL_READBACK_INVALID", "Owner-managed rate limits require current valid settings", { scope });
    const simple = nativeRateLimitSimple(bindings.find(item => item.type === "ratelimit" && item.name === name)?.simple, { required: true, scope });
    if (simple.limit !== Number(limit) || simple.period !== Number(period)) throw toolError("OWNER_CONTROL_READBACK_INVALID", "Owner-managed native rate limits must match their policy variables", { scope });
    result[scope] = { limit: Number(limit), period_seconds: Number(period) };
  }
  return result;
}
