import { buildCurrentAuthGuard } from "../kernel/authorization.ts";
import type { AuthContext } from "../kernel/types.ts";

interface Preferences { enabled: number; version: number; receive_after: number }
interface CacheRow {
  preference_version: number; receive_after: number; through_sequence: number;
  pending_ids_json: string; version: number;
  is_complete: number; floor_created_at: number | null; floor_id: string | null;
}
interface IdentifiedRow { id: string; created_at: number }
export interface PendingRead<T> {
  rows: T[];
  cold: () => Promise<T[]>;
  save: (() => Promise<boolean>) | null;
}

export const NOTIFICATION_PENDING_WINDOW = 100;

function cacheIds(row: CacheRow | null, preferences: Preferences, upper: number): string[] | null {
  if (row === null || row.preference_version !== preferences.version || row.receive_after !== preferences.receive_after
    || !Number.isSafeInteger(row.through_sequence) || row.through_sequence < 0 || row.through_sequence > upper
    || !Number.isSafeInteger(row.version) || row.version < 1
    || (row.is_complete !== 0 && row.is_complete !== 1)) return null;
  try {
    const ids: unknown = JSON.parse(row.pending_ids_json);
    if (!Array.isArray(ids) || ids.length > NOTIFICATION_PENDING_WINDOW || ids.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      || new Set(ids).size !== ids.length) return null;
    if (row.is_complete === 1 && (row.floor_created_at !== null || row.floor_id !== null)) return null;
    if (row.is_complete === 0 && (!Number.isSafeInteger(row.floor_created_at) || row.floor_id === null || !ids.includes(row.floor_id))) return null;
    return ids as string[];
  } catch { return null; }
}

export async function readPendingNotifications<T extends IdentifiedRow>(db: D1Database, auth: AuthContext, preferences: Preferences,
  last: (string | number)[] | null, limit: number, readAt: number): Promise<PendingRead<T>> {
  let cache: CacheRow | null = null, upper: number | null = null, cacheAvailable = true, storedVersion = 0;
  try {
    cache = await db.prepare(`SELECT preference_version,receive_after,through_sequence,pending_ids_json,version,is_complete,floor_created_at,floor_id
      FROM notification_pending_windows WHERE principal_id=?1`)
      .bind(auth.principalId).first<CacheRow>();
    storedVersion = cache?.version ?? 0;
    // 逐身份继承旧版完整投影，避免迁移时全表回填；旧表继续兼容服务回滚。
    if (cache === null) cache = await db.prepare(`SELECT preference_version,receive_after,through_sequence,pending_ids_json,version,
      1 AS is_complete,NULL AS floor_created_at,NULL AS floor_id FROM notification_pending_cache WHERE principal_id=?1`)
      .bind(auth.principalId).first<CacheRow>();
    upper = (await db.prepare("SELECT COALESCE(MAX(sequence),0) AS upper FROM instance_notifications").first<{ upper: number }>())?.upper ?? null;
  } catch { cacheAvailable = false; }
  const ids = upper === null ? null : cacheIds(cache, preferences, upper);
  const query = async (useCache: boolean, maximum: number, cursor = last): Promise<T[]> => {
    const values: (string | number | null)[] = [auth.principalId, readAt, preferences.receive_after];
    const conditions = ["n.created_by_principal_id<>?1", "COALESCE(np.enabled,1)=1", "n.withdrawn_at IS NULL",
      "(n.expires_at IS NULL OR n.expires_at>?2)", "a.notification_id IS NULL", "n.created_at>=?3",
      "n.created_at>=MAX(p.created_at,COALESCE(np.receive_after,p.created_at))"];
    let source = "instance_notifications";
    let prefix = "";
    if (useCache && cache !== null && upper !== null && ids !== null) {
      values.push(cache.through_sequence, upper);
      let window = "";
      if (cache.is_complete === 0) {
        values.push(cache.floor_created_at, cache.floor_id);
        window = " AND (created_at,id)>=(?6,?7)";
      }
      values.push(JSON.stringify(ids));
      const cachedIds = `?${values.length}`;
      // 旧水位之前只点查窗口 ID；排序下界之外的新公告由后续事实续扫读取，不会漏掉迟提交的旧时间。
      prefix = `WITH candidates AS MATERIALIZED (SELECT * FROM instance_notifications WHERE sequence>?4 AND sequence<=?5${window}
        ${ids.length ? `UNION ALL SELECT * FROM instance_notifications WHERE id IN (SELECT value FROM json_each(${cachedIds})) AND sequence<=?4` : ""}) `;
      source = "candidates";
    } else if (upper !== null) {
      values.push(upper); conditions.push(`n.sequence<=?${values.length}`);
    }
    if (cursor !== null) {
      const start = values.length + 1;
      conditions.push(`(n.created_at,n.id)<(?${start},?${start + 1})`);
      values.push(...cursor);
    }
    const guard = buildCurrentAuthGuard(auth, Date.now(), values.length + 1);
    conditions.push(guard.sql); values.push(...guard.values, maximum);
    return (await db.prepare(`${prefix}SELECT n.*,a.acknowledged_at FROM ${source} n
      JOIN principals p ON p.id=?1 LEFT JOIN notification_preferences np ON np.principal_id=p.id
      LEFT JOIN notification_acknowledgements a ON a.notification_id=n.id AND a.principal_id=?1
      WHERE ${conditions.join(" AND ")} ORDER BY n.created_at DESC,n.id DESC LIMIT ?${values.length}`)
      .bind(...values).all<T>()).results;
  };
  const cold = () => query(false, limit + 1);
  let rows: T[];
  const useCache = last === null && ids !== null && cache !== null;
  let complete = !useCache || cache?.is_complete === 1;
  try {
    rows = await query(useCache, last === null && cacheAvailable ? NOTIFICATION_PENDING_WINDOW + 1 : limit + 1);
    if (useCache && cache?.is_complete === 0 && rows.length < NOTIFICATION_PENDING_WINDOW) {
      const maximum = NOTIFICATION_PENDING_WINDOW + 1 - rows.length;
      const tail = await query(false, maximum, [cache.floor_created_at as number, cache.floor_id as string]);
      rows.push(...tail);
      complete = tail.length < maximum;
    }
  } catch (error) { if (!useCache) throw error; cacheAvailable = false; rows = await cold(); }
  if (rows.length > NOTIFICATION_PENDING_WINDOW) complete = false;
  const windowRows = rows.slice(0, NOTIFICATION_PENDING_WINDOW);
  const floor = complete ? null : windowRows.at(-1);
  const pendingIds = JSON.stringify(windowRows.map(row => row.id));
  const unchanged = ids !== null && storedVersion > 0 && cache?.through_sequence === upper
    && (cache.is_complete === 1 || (cache.is_complete === Number(complete) && cache.pending_ids_json === pendingIds
      && cache.floor_created_at === (floor?.created_at ?? null) && cache.floor_id === (floor?.id ?? null)));
  const save = last !== null || !cacheAvailable || upper === null || unchanged ? null : async () => {
    const guard = buildCurrentAuthGuard(auth, Date.now(), 10);
    try {
      const result = await db.prepare(`INSERT INTO notification_pending_windows(principal_id,preference_version,receive_after,through_sequence,pending_ids_json,version,is_complete,floor_created_at,floor_id)
        SELECT p.id,?2,?3,?4,?5,1,?7,?8,?9 FROM principals p LEFT JOIN notification_preferences np ON np.principal_id=p.id
        WHERE p.id=?1 AND COALESCE(np.enabled,1)=1 AND COALESCE(np.version,1)=?2
          AND MAX(p.created_at,COALESCE(np.receive_after,p.created_at))=?3 AND ${guard.sql}
        ON CONFLICT(principal_id) DO UPDATE SET preference_version=excluded.preference_version,receive_after=excluded.receive_after,
          through_sequence=excluded.through_sequence,pending_ids_json=excluded.pending_ids_json,version=notification_pending_windows.version+1,
          is_complete=excluded.is_complete,floor_created_at=excluded.floor_created_at,floor_id=excluded.floor_id
        WHERE notification_pending_windows.version=?6 AND notification_pending_windows.through_sequence<=excluded.through_sequence`)
        .bind(auth.principalId, preferences.version, preferences.receive_after, upper, pendingIds, storedVersion,
          complete ? 1 : 0, floor?.created_at ?? null, floor?.id ?? null, ...guard.values).run();
      return result.meta.changes === 1;
    } catch { return false; }
  };
  return { rows, cold, save };
}
