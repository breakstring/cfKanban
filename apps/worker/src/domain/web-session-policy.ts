export const WEB_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
export const WEB_SESSION_ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
export const WEB_SESSION_RENEWAL_INTERVAL_MS = 30 * 60 * 1_000;

export function sessionRenewalTimes(createdAt: number, lastRenewedAt: number | null) {
  return {
    absoluteExpiresAt: createdAt + WEB_SESSION_ABSOLUTE_LIFETIME_MS,
    renewAfter: (lastRenewedAt ?? createdAt) + WEB_SESSION_RENEWAL_INTERVAL_MS,
  };
}
