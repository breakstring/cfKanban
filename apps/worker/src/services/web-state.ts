import { IDEMPOTENCY_TTL_MS } from "../kernel/idempotency.ts";

const CLEANUP_BATCH_SIZE = 100;

export const BROWSER_LAUNCH_CLEANUP_SQL = `DELETE FROM browser_launches
 WHERE id IN (
   SELECT id FROM browser_launches INDEXED BY idx_browser_launches_cleanup
   WHERE created_at <= ?1
   ORDER BY created_at, id LIMIT ?2
 )`;

export const WEB_SESSION_CLEANUP_SQL = `DELETE FROM web_sessions
 WHERE id IN (
   SELECT id FROM web_sessions INDEXED BY idx_web_sessions_cleanup
   WHERE created_at <= ?1
   ORDER BY created_at, id LIMIT ?2
 )`;

export const EXPIRED_WEB_AUTHN_CHALLENGE_CLEANUP_SQL = `DELETE FROM webauthn_challenges
 WHERE id IN (
   SELECT id FROM webauthn_challenges INDEXED BY idx_webauthn_challenges_expiry
   WHERE expires_at <= ?1
   ORDER BY expires_at, id LIMIT ?2
 )`;

export const CONSUMED_WEB_AUTHN_CHALLENGE_CLEANUP_SQL = `DELETE FROM webauthn_challenges
 WHERE id IN (
   SELECT id FROM webauthn_challenges INDEXED BY idx_webauthn_challenges_consumed
   WHERE consumed_at IS NOT NULL
   ORDER BY consumed_at, id LIMIT ?1
 )`;

export function browserLaunchCleanupStatement(
  db: D1Database,
  now: number,
): D1PreparedStatement {
  return db.prepare(BROWSER_LAUNCH_CLEANUP_SQL)
    .bind(now - IDEMPOTENCY_TTL_MS, CLEANUP_BATCH_SIZE);
}

export function webSessionCleanupStatement(
  db: D1Database,
  now: number,
): D1PreparedStatement {
  return db.prepare(WEB_SESSION_CLEANUP_SQL)
    .bind(now - IDEMPOTENCY_TTL_MS, CLEANUP_BATCH_SIZE);
}

export function webAuthnChallengeCleanupStatements(
  db: D1Database,
  now: number,
): D1PreparedStatement[] {
  return [
    db.prepare(EXPIRED_WEB_AUTHN_CHALLENGE_CLEANUP_SQL)
      .bind(now, CLEANUP_BATCH_SIZE),
    db.prepare(CONSUMED_WEB_AUTHN_CHALLENGE_CLEANUP_SQL)
      .bind(CLEANUP_BATCH_SIZE),
  ];
}
