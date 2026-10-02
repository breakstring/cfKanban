import { buildCurrentAuthGuard } from "../kernel/authorization.ts";
import type { AuthContext } from "../kernel/types.ts";

interface Preferences { enabled: number; version: number; receive_after: number }
interface CacheRow {
  preference_version: number; receive_after: number; through_sequence: number;
  pending_ids_json: string; version: number;
}
interface IdentifiedRow { id: string }
export interface PendingRead<T> {
  rows: T[];
  cold: () => Promise<T[]>;
  save: (() => Promise<boolean>) | null;
}

function cacheIds(row: CacheRow | null, preferences: Preferences, upper: number): string[] | null {
  if (row === null || row.preference_version !== preferences.version || row.receive_after !== preferences.receive_after
    || !Number.isSafeInteger(row.through_sequence) || row.through_sequence < 0 || row.through_sequence > upper
    || !Number.isSafeInteger(row.version) || row.version < 1) return null;
  try {
    const ids: unknown = JSON.parse(row.pending_ids_json);
    if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      || new Set(ids).size !== ids.length) return null;
    return ids as string[];
  } catch { return null; }
}

export async function readPendingNotifications<T extends IdentifiedRow>(db: D1Database, auth: AuthContext, preferences: Preferences,
  last: (string | number)[] | null, limit: number, readAt: number): Promise<PendingRead<T>> {
  let cache: CacheRow | null = null, upper: number | null = null, cacheAvailable = true;
  try {
    cache = await db.prepare("SELECT preference_version,receive_after,through_sequence,pending_ids_json,version FROM notification_pending_cache WHERE principal_id=?1")
      .bind(auth.principalId).first<CacheRow>();
    upper = (await db.prepare("SELECT COALESCE(MAX(sequence),0) AS upper FROM instance_notifications").first<{ upper: number }>())?.upper ?? null;
  } catch { cacheAvailable = false; }
  const ids = upper === null ? null : cacheIds(cache, preferences, upper);
  const query = async (useCache: boolean, probe: boolean): Promise<T[]> => {
    const values: (string | number | null)[] = [auth.principalId, readAt, preferences.receive_after];
    const conditions = ["n.created_by_principal_id<>?1", "COALESCE(np.enabled,1)=1", "n.withdrawn_at IS NULL",
      "(n.expires_at IS NULL OR n.expires_at>?2)", "a.notification_id IS NULL", "n.created_at>=?3",
      "n.created_at>=MAX(p.created_at,COALESCE(np.receive_after,p.created_at))"];
    let source = "instance_notifications";
    let prefix = "";
    if (useCache && cache !== null && upper !== null && ids !== null) {
      values.push(cache.through_sequence, upper);
      const holes = ids.map(id => { values.push(id); return `?${values.length}`; });
      // Separate range and unique-ID branches keep acknowledged history out of the hot read.
      prefix = `WITH candidates AS MATERIALIZED (SELECT * FROM instance_notifications WHERE sequence>?4 AND sequence<=?5
        ${holes.length ? `UNION ALL SELECT * FROM instance_notifications WHERE id IN (${holes.join(",")}) AND sequence<=?4` : ""}) `;
      source = "candidates";
    } else if (upper !== null) {
      values.push(upper); conditions.push(`n.sequence<=?${values.length}`);
    }
    if (last !== null) {
      const start = values.length + 1;
      conditions.push(`(n.created_at,n.id)<(?${start},?${start + 1})`);
      values.push(...last);
    }
    const guard = buildCurrentAuthGuard(auth, Date.now(), values.length + 1);
    conditions.push(guard.sql); values.push(...guard.values, probe ? 51 : limit + 1);
    return (await db.prepare(`${prefix}SELECT n.*,a.acknowledged_at FROM ${source} n
      JOIN principals p ON p.id=?1 LEFT JOIN notification_preferences np ON np.principal_id=p.id
      LEFT JOIN notification_acknowledgements a ON a.notification_id=n.id AND a.principal_id=?1
      WHERE ${conditions.join(" AND ")} ORDER BY n.created_at DESC,n.id DESC LIMIT ?${values.length}`)
      .bind(...values).all<T>()).results;
  };
  const cold = () => query(false, false);
  let rows: T[];
  try { rows = await query(ids !== null, last === null); }
  catch (error) { if (ids === null) throw error; cacheAvailable = false; rows = await cold(); }
  const complete = last === null && rows.length <= 50 && cacheAvailable && upper !== null;
  const unchanged = ids !== null && cache?.through_sequence === upper;
  const save = !complete || unchanged ? null : async () => {
    const guard = buildCurrentAuthGuard(auth, Date.now(), 7);
    try {
      const result = await db.prepare(`INSERT INTO notification_pending_cache(principal_id,preference_version,receive_after,through_sequence,pending_ids_json,version)
        SELECT p.id,?2,?3,?4,?5,1 FROM principals p LEFT JOIN notification_preferences np ON np.principal_id=p.id
        WHERE p.id=?1 AND COALESCE(np.enabled,1)=1 AND COALESCE(np.version,1)=?2
          AND MAX(p.created_at,COALESCE(np.receive_after,p.created_at))=?3 AND ${guard.sql}
        ON CONFLICT(principal_id) DO UPDATE SET preference_version=excluded.preference_version,receive_after=excluded.receive_after,
          through_sequence=excluded.through_sequence,pending_ids_json=excluded.pending_ids_json,version=notification_pending_cache.version+1
        WHERE notification_pending_cache.version=?6 AND notification_pending_cache.through_sequence<=excluded.through_sequence`)
        .bind(auth.principalId, preferences.version, preferences.receive_after, upper, JSON.stringify(rows.map(row => row.id)), cache?.version ?? 0, ...guard.values).run();
      return result.meta.changes === 1;
    } catch { return false; }
  };
  return { rows, cold, save };
}
