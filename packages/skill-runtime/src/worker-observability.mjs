import { toolError } from "./errors.mjs";

const OBSERVABILITY_FIELDS = ["enabled", "head_sampling_rate", "logs", "traces", "redact_query_string"];
const LOG_FIELDS = ["enabled", "head_sampling_rate", "invocation_logs", "destinations", "persist"];
const TRACE_FIELDS = ["enabled", "head_sampling_rate", "destinations", "persist"];

function invalidReadback() {
  return toolError("WORKER_OBSERVABILITY_READBACK_INVALID", "Worker observability metadata is invalid");
}

function normalizeObject(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidReadback();
  if (Reflect.ownKeys(value).some(key => !fields.includes(key))) {
    // 新增 API 字段必须先明确校验，不能在生成配置时静默丢失。
    throw toolError("WORKER_OBSERVABILITY_UNSUPPORTED_FIELD", "Worker observability contains unrecognized settings; a separate preservation plan is required");
  }
  const result = {};
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value")) throw invalidReadback();
    const item = descriptor.value;
    if (key === "logs" || key === "traces") {
      result[key] = normalizeObject(item, key === "logs" ? LOG_FIELDS : TRACE_FIELDS);
    } else if (key === "head_sampling_rate") {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1) throw invalidReadback();
      result[key] = item;
    } else if (key === "destinations") {
      if (!Array.isArray(item) || Array.from(item).some(destination => typeof destination !== "string")) throw invalidReadback();
      result[key] = [...item];
    } else {
      if (typeof item !== "boolean") throw invalidReadback();
      result[key] = item;
    }
  }
  return result;
}

export function normalizeObservedWorkerObservability(value) {
  // 未配置的 API 设置按 disabled 冻结；升级不依赖 Wrangler 缺省写入 enabled:false。
  if (value === null || value === undefined) return { enabled: false };
  const observed = normalizeObject(value, OBSERVABILITY_FIELDS);
  if (!Object.hasOwn(observed, "enabled") && !Object.hasOwn(observed.logs ?? {}, "enabled")
    && !Object.hasOwn(observed.traces ?? {}, "enabled")) throw invalidReadback();
  return observed;
}

export function normalizePlannedWorkerObservability(plan) {
  if (plan?.kind !== "deployed_instance_upgrade" || !Object.hasOwn(plan.resources?.worker ?? {}, "observability")) return undefined;
  if (plan.resources.worker.observability === undefined) throw invalidReadback();
  return normalizeObservedWorkerObservability(plan.resources.worker.observability);
}
