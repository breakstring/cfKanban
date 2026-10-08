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

// 兼容旧调用方的投影；预算通知已退役，保留旧变量不会产生提醒。
export function usageAlerts(_values: UsageMetric[], _billing: ReturnType<typeof usageBilling>, _fresh: boolean): [] { return []; }

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
