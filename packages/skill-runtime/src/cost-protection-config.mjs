import { toolError } from "./errors.mjs";
import { PUBLIC_ACCESS_NAMES, publicAccessBindings } from "./public-access-config.mjs";

export const ANONYMOUS_LOGIN_POLICY = Object.freeze({ limit: 10, period_seconds: 60 });
export const ANONYMOUS_LOGIN_NAMES = new Set(["ANONYMOUS_LOGIN_RATE_LIMITER", "RATE_LIMIT_ANONYMOUS_LOGIN_LIMIT", "RATE_LIMIT_ANONYMOUS_LOGIN_PERIOD_SECONDS"]);
export const EXPENSIVE_READ_POLICY = Object.freeze({ limit: 10, period_seconds: 60 });
export const EXPENSIVE_READ_NAMES = new Set(["EXPENSIVE_READ_RATE_LIMITER", "RATE_LIMIT_EXPENSIVE_READ_LIMIT", "RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS"]);
export const COST_PROTECTION_NAMES = new Set([...ANONYMOUS_LOGIN_NAMES, ...EXPENSIVE_READ_NAMES]);

export function anonymousLoginBindings(policy) {
  if (!policy) return [];
  if (!Number.isSafeInteger(policy.limit) || policy.limit < 1 || ![10, 60].includes(policy.period_seconds)) throw toolError("INVALID_COST_PROTECTION", "Anonymous login protection requires a positive native rate limit");
  return [
    { type: "ratelimit", name: "ANONYMOUS_LOGIN_RATE_LIMITER", namespace_id: "1004" },
    { type: "plain_text", name: "RATE_LIMIT_ANONYMOUS_LOGIN_LIMIT", text: String(policy.limit) },
    { type: "plain_text", name: "RATE_LIMIT_ANONYMOUS_LOGIN_PERIOD_SECONDS", text: String(policy.period_seconds) },
  ];
}

export function observedAnonymousLogin(bindings = []) {
  const found = bindings.filter(item => ANONYMOUS_LOGIN_NAMES.has(item.name));
  if (!found.length) return null;
  const limit = found.find(item => item.name === "RATE_LIMIT_ANONYMOUS_LOGIN_LIMIT")?.text;
  const period = found.find(item => item.name === "RATE_LIMIT_ANONYMOUS_LOGIN_PERIOD_SECONDS")?.text;
  if (!/^[1-9][0-9]*$/u.test(limit ?? "") || !/^(10|60)$/u.test(period ?? "")) throw toolError("INVALID_COST_PROTECTION", "Existing anonymous login protection must have an exact readback");
  const policy = { limit: Number(limit), period_seconds: Number(period) };
  const sorted = value => [...value].sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(sorted(found)) !== JSON.stringify(sorted(anonymousLoginBindings(policy)))) throw toolError("INVALID_COST_PROTECTION", "Existing anonymous login bindings do not match the supported profile");
  return policy;
}

export function expensiveReadBindings(policy) {
  return anonymousLoginBindings(policy).map(item => ({ ...item, name: item.name.replace("ANONYMOUS_LOGIN", "EXPENSIVE_READ"), ...(item.type === "ratelimit" ? { namespace_id: "1005" } : {}) }));
}

export function observedExpensiveReads(bindings = []) {
  if (bindings.some(item => item.name === "EXPENSIVE_READ_RATE_LIMITER" && item.namespace_id !== "1005")) throw toolError("INVALID_COST_PROTECTION", "Existing expensive-read protection uses an unexpected namespace");
  return observedAnonymousLogin(bindings.filter(item => EXPENSIVE_READ_NAMES.has(item.name)).map(item => ({ ...item, name: item.name.replace("EXPENSIVE_READ", "ANONYMOUS_LOGIN"), ...(item.type === "ratelimit" ? { namespace_id: item.namespace_id === "1005" ? "1004" : item.namespace_id } : {}) })));
}

export function costProtectionBindings(config) {
  return [...anonymousLoginBindings(config?.anonymous_login), ...expensiveReadBindings(config?.expensive_reads)];
}

export function plannedProtectionBindingDelta(plan) {
  const observed = (plan.resources?.worker?.current_bindings ?? []).filter(item => COST_PROTECTION_NAMES.has(item.name) || PUBLIC_ACCESS_NAMES.has(item.name));
  const expected = [...costProtectionBindings(plan.cost_protection), ...publicAccessBindings(plan.public_access)];
  const sorted = value => [...value].sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify(sorted(observed)) !== JSON.stringify(sorted(expected));
}

export function normalizeWorkerLimits(value) {
  if (value == null) return null;
  if (value.workers_plan !== "paid" || !Number.isSafeInteger(value.cpu_ms) || value.cpu_ms < 1 || value.cpu_ms > 300_000 || Object.keys(value).some(key => !["workers_plan", "cpu_ms"].includes(key))) {
    throw toolError("INVALID_WORKER_CPU_LIMIT", "An explicit existing paid Workers plan and a CPU ceiling from 1 to 300000 milliseconds are required; this does not purchase a plan");
  }
  return { workers_plan: "paid", cpu_ms: value.cpu_ms };
}

export function normalizeObservedWorkerLimits(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["cpu_ms", "subrequests"].includes(key))) {
    throw toolError("WORKER_COST_UNSUPPORTED_LIMIT", "Unrecognized Worker limits require a separate preservation plan");
  }
  const limits = {};
  for (const [key, maximum] of [["cpu_ms", 300_000], ["subrequests", 10_000_000]]) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > maximum) throw toolError("WORKER_COST_READBACK_INVALID", "Worker limit metadata is invalid");
    limits[key] = value[key];
  }
  return Object.keys(limits).length ? limits : null;
}

export function plannedWorkerLimits(plan, phase = "after") {
  const protection = plan.cost_protection;
  if (!protection) return null;
  const previous = normalizeObservedWorkerLimits(protection.previous_worker_limits);
  const target = normalizeObservedWorkerLimits(protection.worker_limits);
  const request = normalizeWorkerLimits(protection.cpu_limit_request);
  const expected = request ? { ...previous, cpu_ms: request.cpu_ms } : previous;
  if (JSON.stringify(target) !== JSON.stringify(normalizeObservedWorkerLimits(expected))) {
    throw toolError("INVALID_WORKER_CPU_LIMIT", "Only an explicit existing-paid CPU request may change the observed limits; other limits must be preserved");
  }
  return phase === "before" ? previous : target;
}
