import type { WorkerEnv } from "../kernel/types.ts";

export interface UsageMetric {
  key: string;
  value: number | null;
  unit: "bytes" | "count" | "microseconds";
  source: "cloudflare";
  scope: "instance" | "account";
  period_start: string | null;
  period_end: string | null;
  observed_at: string | null;
}

export function usageBilling(env: WorkerEnv, now: number) {
  const plan = env.USAGE_BILLING_PLAN === "free" || env.USAGE_BILLING_PLAN === "paid" ? env.USAGE_BILLING_PLAN : "unknown";
  const rawDay = env.USAGE_BILLING_CYCLE_DAY;
  const day = rawDay && /^(?:[1-9]|[12][0-9]|3[01])$/u.test(rawDay) ? Number(rawDay) : null;
  let start: string | null = null;
  if (day !== null) {
    const date = new Date(now);
    const anchor = (offset: number) => {
      const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last));
    };
    const current = anchor(0);
    start = new Date(current <= now ? current : anchor(-1)).toISOString();
  }
  const rawPercent = env.USAGE_WARNING_PERCENT;
  const warning = rawPercent && /^(?:[1-9]|[1-9][0-9]|100)$/u.test(rawPercent) ? Number(rawPercent) : 80;
  return {
    plan, cycle_day: day, period_start: start, period_end: start ? new Date(now).toISOString() : null,
    account_totals_enabled: env.USAGE_ACCOUNT_TOTALS_ENABLED === "true", warning_percent: warning,
    r2_standard_only_scope: env.USAGE_R2_STANDARD_ONLY_SCOPE === "instance" || env.USAGE_R2_STANDARD_ONLY_SCOPE === "account" ? env.USAGE_R2_STANDARD_ONLY_SCOPE : "unknown",
    allowances_shared: true, analytics_not_invoice: true,
  };
}

export function usageAlerts(values: UsageMetric[], billing: ReturnType<typeof usageBilling>, fresh: boolean) {
  if (!fresh) return [];
  const allowance = (key: string): number | null => {
    if (key === "r2_class_a_operations") return billing.cycle_day === null ? null : 1_000_000;
    if (key === "r2_class_b_operations") return billing.cycle_day === null ? null : 10_000_000;
    if (billing.plan === "unknown") return null;
    if (billing.plan === "paid" && billing.cycle_day === null) return null;
    if (key === "workers_requests") return billing.plan === "free" ? 100_000 : 10_000_000;
    if (key === "workers_cpu_microseconds") return billing.plan === "paid" ? 30_000_000_000 : null;
    if (key === "d1_rows_read" && billing.plan === "free") return 5_000_000;
    if (key === "d1_rows_written" && billing.plan === "free") return 100_000;
    if (key === "d1_billing_rows_read" && billing.plan === "paid") return 25_000_000_000;
    if (key === "d1_billing_rows_written" && billing.plan === "paid") return 50_000_000;
    return null;
  };
  return values.flatMap(metric => {
    if (metric.key.startsWith("r2_") && (billing.r2_standard_only_scope === "unknown" || (metric.scope === "account" && billing.r2_standard_only_scope !== "account"))) return [];
    const limit = allowance(metric.key);
    if (limit === null || metric.value === null || !metric.period_start || !metric.period_end) return [];
    const percent = metric.value / limit * 100;
    return percent < billing.warning_percent ? [] : [{
      metric_key: metric.key, scope: metric.scope, level: percent >= 100 ? "reached" : "warning", value: metric.value,
      allowance: limit, percent, period_start: metric.period_start, period_end: metric.period_end,
    }];
  }).slice(0, 16);
}

export function publicAccessSnapshot(env: WorkerEnv) {
  const raw = env.PUBLIC_ACCESS_HOSTNAME;
  if (!raw && !env.PUBLIC_ACCESS_MODE && !env.PUBLIC_ACCESS_WAF_PROFILE && !env.PUBLIC_ACCESS_VERIFIED_AT) return { status: "not_configured", hostname: null, mode: null, waf_profile: null, verified_at: null, live_verified: false };
  const validHost = typeof raw === "string" && raw.length <= 253 && raw.includes(".") && raw.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
  const validMode = env.PUBLIC_ACCESS_MODE === "custom_domain";
  const profile = env.PUBLIC_ACCESS_WAF_PROFILE;
  const validProfile = profile === "disabled" || profile === "anonymous-api-filter";
  const at = env.PUBLIC_ACCESS_VERIFIED_AT;
  const validTime = typeof at === "string" && Number.isFinite(Date.parse(at));
  const valid = validHost && validMode && validProfile && validTime;
  return { status: valid ? "configured" : "invalid", hostname: validHost ? raw : null, mode: validMode ? "custom_domain" : null, waf_profile: validProfile ? profile : null, verified_at: validTime ? new Date(at).toISOString() : null, live_verified: false };
}

const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "ListObjectsV2", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "UploadPart", "UploadPartCopy", "ListMultipartUploads", "ListParts", "PutBucketEncryption", "PutBucketLifecycleConfiguration", "PutBucketCors"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketLifecycleConfiguration", "GetBucketCors"]);
const FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

export function r2OperationClass(action: string, responseStatus: number): "a" | "b" | "free" | "unknown" {
  if (responseStatus === 401) return "free";
  if (CLASS_A.has(action)) return "a";
  if (CLASS_B.has(action)) return "b";
  if (FREE.has(action)) return "free";
  return "unknown";
}
