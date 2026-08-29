export interface RateLimitPolicy {
  limit: number;
  periodSeconds: 10 | 60;
}

export interface RateLimitPolicies {
  instance: RateLimitPolicy;
  principal: RateLimitPolicy;
  unauthenticated_sensitive: RateLimitPolicy;
}

function canonicalPositiveInteger(value: unknown, allowed?: readonly number[]): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowed !== undefined && !allowed.includes(parsed))) {
    return null;
  }
  return parsed;
}

export function parseRateLimitPolicy(
  limitValue: unknown,
  periodValue: unknown,
): RateLimitPolicy | null {
  const limit = canonicalPositiveInteger(limitValue);
  const periodSeconds = canonicalPositiveInteger(periodValue, [10, 60]);
  if (limit === null || periodSeconds === null) return null;
  return { limit, periodSeconds: periodSeconds as 10 | 60 };
}
