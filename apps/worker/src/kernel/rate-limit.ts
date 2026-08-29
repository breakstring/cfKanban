import { platformUnavailable, rateLimited } from "./errors.ts";
import type { AuthContext, WorkerEnv } from "./types.ts";

export const RATE_LIMIT_POLICIES = {
  instance: { limit: 300, periodSeconds: 60 },
  principal: { limit: 120, periodSeconds: 60 },
  unauthenticated_sensitive: { limit: 30, periodSeconds: 60 },
} as const;

type RateLimitScope = keyof typeof RATE_LIMIT_POLICIES;

const RECENT_429_WINDOW_SECONDS = 300;
const MAX_RECENT_429S = 128;
const recent429s: Array<{ at: number; scope: RateLimitScope }> = [];

function pruneRecent429s(now: number): void {
  const cutoff = now - RECENT_429_WINDOW_SECONDS * 1_000;
  while (recent429s.length > 0 && recent429s[0]!.at < cutoff) recent429s.shift();
}

function recordRateLimit(scope: RateLimitScope, now = Date.now()): void {
  pruneRecent429s(now);
  recent429s.push({ at: now, scope });
  if (recent429s.length > MAX_RECENT_429S) {
    recent429s.splice(0, recent429s.length - MAX_RECENT_429S);
  }
}

export function recentRateLimitSummary(now: number): {
  by_scope: Record<RateLimitScope, number>;
  observation_scope: "worker_isolate_best_effort";
  total: number;
  window_seconds: number;
} {
  pruneRecent429s(now);
  const byScope: Record<RateLimitScope, number> = {
    instance: 0,
    principal: 0,
    unauthenticated_sensitive: 0,
  };
  for (const hit of recent429s) byScope[hit.scope] += 1;
  return {
    by_scope: byScope,
    observation_scope: "worker_isolate_best_effort",
    total: recent429s.length,
    window_seconds: RECENT_429_WINDOW_SECONDS,
  };
}

async function enforce(
  binding: RateLimit,
  key: string,
  scope: keyof typeof RATE_LIMIT_POLICIES,
): Promise<void> {
  let success: boolean;
  try {
    ({ success } = await binding.limit({ key }));
  } catch {
    throw platformUnavailable("worker");
  }
  if (success) return;
  recordRateLimit(scope);
  const policy = RATE_LIMIT_POLICIES[scope];
  throw rateLimited(scope, policy.limit, policy.periodSeconds);
}

export async function enforceInstanceRateLimit(env: WorkerEnv): Promise<void> {
  await enforce(env.INSTANCE_RATE_LIMITER, "dynamic-api", "instance");
}

export async function enforcePrincipalRateLimit(env: WorkerEnv, auth: AuthContext): Promise<void> {
  await enforce(env.PRINCIPAL_RATE_LIMITER, auth.principalId, "principal");
}

export async function enforceUnauthenticatedSensitiveRateLimit(env: WorkerEnv): Promise<void> {
  await enforce(
    env.UNAUTHENTICATED_RATE_LIMITER,
    "unauthenticated-sensitive",
    "unauthenticated_sensitive",
  );
}

export function isRateLimitedDynamicPath(pathname: string): boolean {
  return pathname.startsWith("/api/")
    || pathname === "/healthz"
    || pathname === "/openapi.json"
    || pathname === "/invite"
    || pathname === "/app/launch"
    || pathname.startsWith("/.well-known/");
}

export function isUnauthenticatedSensitivePath(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return pathname === "/api/v1/invitations/redeem"
    || pathname === "/api/v1/web-sessions/redeem"
    || pathname === "/api/v1/web-authentication/options"
    || pathname === "/api/v1/web-authentication/verify"
    || /^\/api\/v1\/public-joins\/[^/]+\/redeem$/u.test(pathname);
}
