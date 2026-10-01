import { sessionRenewalTimes } from "../domain/web-session-policy.ts";
import { timestamp } from "../domain/model.ts";
import { buildCurrentAuthGuard } from "../kernel/authorization.ts";
import { ApiError, platformUnavailable, unauthorized } from "../kernel/errors.ts";
import type { CookieAuthContext, JsonValue } from "../kernel/types.ts";

export interface WebSessionState {
  created_at: number;
  expires_at: number;
  id: string;
  last_seen_at: number | null;
  version: number;
}

export async function readCurrentWebSession(db: D1Database, auth: CookieAuthContext, now = Date.now()): Promise<WebSessionState> {
  const guard = buildCurrentAuthGuard(auth, now, 3);
  try {
    const row = await db.prepare(`SELECT id,created_at,expires_at,last_seen_at,version FROM web_sessions
      WHERE id=?1 AND principal_id=?2 AND ${guard.sql}`)
      .bind(auth.sessionId, auth.principalId, ...guard.values).first<WebSessionState>();
    if (row === null) throw unauthorized(true);
    return row;
  } catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
}

export function sessionRenewalResource(row: WebSessionState): { [key: string]: JsonValue } {
  const times = sessionRenewalTimes(row.created_at, row.last_seen_at);
  return { absolute_expires_at: timestamp(times.absoluteExpiresAt), renew_after: timestamp(times.renewAfter) };
}
