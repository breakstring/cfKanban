import { IDEMPOTENCY_TTL_MS } from "../kernel/idempotency.ts";

const CLEANUP_BATCH_SIZE = 100;

export function browserLaunchCleanupStatement(
  db: D1Database,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM browser_launches
     WHERE id IN (
       SELECT id FROM browser_launches INDEXED BY idx_browser_launches_cleanup
       WHERE created_at <= ?1
       ORDER BY created_at, id LIMIT ?2
     )`,
  ).bind(now - IDEMPOTENCY_TTL_MS, CLEANUP_BATCH_SIZE);
}

export function webSessionCleanupStatement(
  db: D1Database,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM web_sessions
     WHERE id IN (
       SELECT id FROM web_sessions INDEXED BY idx_web_sessions_cleanup
       WHERE created_at <= ?1
       ORDER BY created_at, id LIMIT ?2
     )`,
  ).bind(now - IDEMPOTENCY_TTL_MS, CLEANUP_BATCH_SIZE);
}
