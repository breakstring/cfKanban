import { typedIssueSearch } from "../../../../packages/shared/issue-search.ts";
import { platformUnavailable, rateLimited } from "./errors.ts";
import { parseRateLimitPolicy } from "./rate-limit-policy.ts";
import type { AuthContext, WorkerEnv } from "./types.ts";

export const MAX_CONCURRENT_PER_PRINCIPAL = 2;
export const MAX_CONCURRENT_PER_ISOLATE = 32;
const active = new Map<string, number>();
let totalActive = 0;

export function readCostProtection(env: WorkerEnv) {
  const project = (binding: RateLimit | undefined, limit: string | undefined, period: string | undefined) => {
    const parsed = binding ? parseRateLimitPolicy(limit, period) : null;
    return { enabled: binding !== undefined, policy: parsed ? { limit: parsed.limit, period_seconds: parsed.periodSeconds } : null };
  };
  return {
    anonymous_login: project(env.ANONYMOUS_LOGIN_RATE_LIMITER, env.RATE_LIMIT_ANONYMOUS_LOGIN_LIMIT, env.RATE_LIMIT_ANONYMOUS_LOGIN_PERIOD_SECONDS),
    expensive_reads: project(env.EXPENSIVE_READ_RATE_LIMITER, env.RATE_LIMIT_EXPENSIVE_READ_LIMIT, env.RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS),
    concurrency: { enabled: env.EXPENSIVE_READ_RATE_LIMITER !== undefined, per_principal: MAX_CONCURRENT_PER_PRINCIPAL, per_isolate: MAX_CONCURRENT_PER_ISOLATE },
    observation_scope: "worker_isolate_best_effort", billing_cap: false,
  };
}

export function isExpensiveIssueRead(url: URL): boolean {
  if (url.pathname.endsWith("/issues/counts")) return true;
  if (!url.searchParams.has("q")) return false;
  if (url.searchParams.getAll("q").length === 1 && !url.searchParams.get("q")!.normalize("NFKC").trim()) return false;
  if (url.searchParams.getAll("q").length !== 1 || url.searchParams.get("q_mode") !== "typed") return true;
  return typedIssueSearch(url.searchParams.get("q")!).kind !== "number";
}

export async function withIssueReadProtection<T>(
  env: WorkerEnv,
  auth: AuthContext,
  url: URL,
  read: () => Promise<T>,
): Promise<T> {
  // 旧部署没有独立 binding；升级计划会显式加入，不能暗中替换原 Principal 门控。
  if (!env.EXPENSIVE_READ_RATE_LIMITER || !isExpensiveIssueRead(url)) return read();
  const policy = parseRateLimitPolicy(env.RATE_LIMIT_EXPENSIVE_READ_LIMIT, env.RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS);
  if (policy === null) throw platformUnavailable("worker");
  let allowed: boolean;
  try {
    ({ success: allowed } = await env.EXPENSIVE_READ_RATE_LIMITER.limit({ key: auth.principalId }));
  } catch {
    throw platformUnavailable("worker");
  }
  if (!allowed) {
    const error = rateLimited("principal", policy.limit, policy.periodSeconds);
    error.details.policy = "expensive_read";
    throw error;
  }
  const count = active.get(auth.principalId) ?? 0;
  if (count >= MAX_CONCURRENT_PER_PRINCIPAL || totalActive >= MAX_CONCURRENT_PER_ISOLATE) {
    const error = rateLimited(count >= MAX_CONCURRENT_PER_PRINCIPAL ? "principal" : "instance", count >= MAX_CONCURRENT_PER_PRINCIPAL ? MAX_CONCURRENT_PER_PRINCIPAL : MAX_CONCURRENT_PER_ISOLATE, 10);
    error.details.policy = "expensive_read_concurrency";
    error.details.observation_scope = "worker_isolate_best_effort";
    throw error;
  }
  active.set(auth.principalId, count + 1);
  totalActive++;
  try {
    return await read();
  } finally {
    const remaining = (active.get(auth.principalId) ?? 1) - 1;
    if (remaining === 0) active.delete(auth.principalId);
    else active.set(auth.principalId, remaining);
    totalActive--;
  }
}
