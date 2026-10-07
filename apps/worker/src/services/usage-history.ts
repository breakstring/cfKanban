import { requireOwnerControl } from "../kernel/authorization.ts";
import { validationError } from "../kernel/errors.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import type { UsageMetric } from "./usage-budgets.ts";
import { UsageAnalyticsError, parseUsageMetrics, parseUsageOperationMetrics, queryUsageAnalytics, usageAnalyticsConfig, usageFirst, usageNumber, usageObject } from "./usage.ts";

const DAY = 86_400_000;
const COOLDOWN = 60_000;
const RETENTION_DAYS = 90;
const MAX_HISTORY_ROWS = 630;
const CLEANUP_BATCH = 7;
type Configuration = NonNullable<ReturnType<typeof usageAnalyticsConfig>>;
interface HistoryRow { day: string; attempted_at: number; collected_at: number | null; metrics_json: string | null; error: string | null }
const iso = (time: number) => new Date(time).toISOString();
const date = (time: number) => iso(time).slice(0, 10);
const today = (now: number) => Math.floor(now / DAY) * DAY;
function historyKey(configuration: Configuration): string {
  return JSON.stringify([configuration.account, configuration.database, configuration.bucket, configuration.worker, configuration.totals]);
}
function dayStart(day: unknown, now: number): number {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw validationError("invalid_usage_history_day");
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start) || date(start) !== day || start < today(now) - 7 * DAY || start >= today(now)) throw validationError("invalid_usage_history_day");
  return start;
}
export async function readUsageHistory(env: WorkerEnv, auth: AuthContext, days = 30, now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  if (!Number.isSafeInteger(days) || days < 1 || days > RETENTION_DAYS) throw validationError("invalid_usage_history_days");
  const end = today(now), requested = Array.from({ length: days }, (_, index) => date(end - (days - index) * DAY));
  const enabled = env.USAGE_HISTORY_ENABLED === "true", configuration = enabled ? usageAnalyticsConfig(env) : null;
  const rows = configuration ? (await env.DB.prepare("SELECT day, attempted_at, collected_at, metrics_json, error FROM usage_history WHERE config_key = ?1 AND day >= ?2 AND day < ?3 ORDER BY day LIMIT ?4").bind(historyKey(configuration), requested[0]!, date(end), days).all<HistoryRow>()).results : [];
  const items = rows.filter(row => row.collected_at !== null && row.metrics_json !== null).map(row => ({ day: row.day, collected_at: iso(row.collected_at!), metrics: JSON.parse(row.metrics_json!) as UsageMetric[], complete_day: true }));
  const known = new Set(items.filter(item => item.metrics.some(metric => metric.value !== null)).map(item => item.day));
  const latest = [...rows].sort((left, right) => right.attempted_at - left.attempted_at)[0];
  const interrupted = latest && latest.attempted_at > (latest.collected_at ?? -1) && now - latest.attempted_at >= COOLDOWN;
  return { enabled, retention_days: RETENTION_DAYS, generated_at: iso(now), items: items as unknown as JsonValue, missing_days: requested.filter(day => !known.has(day)), source: "cloudflare_analytics", history_kind: "utc_daily", error: enabled && !configuration ? "not_configured" : latest?.error ?? (interrupted ? "collection_interrupted" : null) };
}

function dailyQueries(configuration: Configuration) {
  const declarations = ["$account: string!", "$database: string!", "$date: Date!", "$storageStart: Time!", "$storageEnd: Time!"];
  const fields = ["activity: d1AnalyticsAdaptiveGroups(limit: 1, filter: {databaseId: $database, date_geq: $date, date_leq: $date}) { sum { rowsRead rowsWritten } }", "storage: d1StorageAdaptiveGroups(limit: 1, filter: {databaseId: $database, datetime_geq: $storageStart, datetime_lt: $storageEnd}, orderBy: [datetime_DESC]) { max { databaseSizeBytes } dimensions { datetime } }"];
  if (configuration.totals) fields.push("accountDaily: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: $date, date_leq: $date}) { sum { rowsRead rowsWritten } }");
  if (configuration.worker || configuration.totals) {
    declarations.push("$start: Time!", "$end: Time!");
    if (configuration.worker) { declarations.push("$worker: string!"); fields.push("worker: workersInvocationsAdaptive(limit: 1, filter: {scriptName: $worker, datetime_geq: $start, datetime_leq: $end}) { sum { requests cpuTimeUs } }"); }
    if (configuration.totals) fields.push("accountWorker: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests cpuTimeUs } }");
  }
  const r2Declarations = ["$account: string!", "$start: Time!", "$end: Time!"];
  const r2Fields: string[] = [];
  const operations = (alias: string, scoped: boolean) => `${alias}: r2OperationsAdaptiveGroups(limit: 101, filter: {${scoped ? "bucketName: $bucket," : ""} datetime_geq: $start, datetime_leq: $end}) { sum { requests } dimensions { actionType responseStatusCode } }`;
  if (configuration.bucket) {
    r2Declarations.push("$bucket: string!", "$storageStart: Time!", "$storageEnd: Time!");
    r2Fields.push("activity: r2OperationsAdaptiveGroups(limit: 1, filter: {bucketName: $bucket, datetime_geq: $start, datetime_leq: $end}) { sum { requests } }", "storage: r2StorageAdaptiveGroups(limit: 1, filter: {bucketName: $bucket, datetime_geq: $storageStart, datetime_lt: $storageEnd}, orderBy: [datetime_DESC]) { max { payloadSize metadataSize objectCount } dimensions { datetime } }", operations("daily", true));
  }
  if (configuration.totals) r2Fields.push("accountActivity: r2OperationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests } }", operations("accountDaily", false));
  return {
    d1: `query UsageHistoryD1(${declarations.join(", ")}) { viewer { accounts(filter: {accountTag: $account}) { ${fields.join("\n")} } } }`,
    r2: r2Fields.length ? `query UsageHistoryR2(${r2Declarations.join(", ")}) { viewer { accounts(filter: {accountTag: $account}) { ${r2Fields.join("\n")} } } }` : null,
  };
}
function cumulative(account: Record<string, unknown>, alias: string, keys: string[], fields: string[], scope: UsageMetric["scope"], start: string, end: string): UsageMetric[] {
  const row = usageFirst(account[alias]), sum = row ? usageObject(row.sum) : null;
  return keys.map((key, index) => ({ key, value: sum ? usageNumber(sum[fields[index]!]) : null, unit: key === "workers_cpu_microseconds" ? "microseconds" : "count", source: "cloudflare", scope, period_start: start, period_end: end, observed_at: null }));
}
async function collectMetrics(configuration: Configuration, startTime: number, fetcher: typeof fetch): Promise<UsageMetric[]> {
  const start = iso(startTime), end = iso(startTime + DAY), endInclusive = iso(startTime + DAY - 1), queries = dailyQueries(configuration);
  const shared = { account: configuration.account, start, end: endInclusive, storageStart: start, storageEnd: end };
  const d1 = await queryUsageAnalytics("d1", queries.d1, { account: configuration.account, database: configuration.database, date: date(startTime), storageStart: start, storageEnd: end, ...(configuration.worker || configuration.totals ? { start, end: endInclusive } : {}), ...(configuration.worker ? { worker: configuration.worker } : {}) }, configuration.token, fetcher);
  const values = parseUsageMetrics(d1, "d1", start, end, start, end);
  if (configuration.worker) values.push(...cumulative(d1, "worker", ["workers_requests", "workers_cpu_microseconds"], ["requests", "cpuTimeUs"], "instance", start, end));
  if (configuration.totals) values.push(...cumulative(d1, "accountDaily", ["d1_rows_read", "d1_rows_written"], ["rowsRead", "rowsWritten"], "account", start, end), ...cumulative(d1, "accountWorker", ["workers_requests", "workers_cpu_microseconds"], ["requests", "cpuTimeUs"], "account", start, end));
  if (queries.r2) {
    const r2 = await queryUsageAnalytics("r2", queries.r2, { ...shared, ...(configuration.bucket ? { bucket: configuration.bucket } : {}) }, configuration.token, fetcher);
    if (configuration.bucket) values.push(...parseUsageMetrics(r2, "r2", start, end, start, end), ...parseUsageOperationMetrics(r2, "daily", "instance", start, end));
    if (configuration.totals) values.push(...cumulative(r2, "accountActivity", ["r2_operations"], ["requests"], "account", start, end), ...parseUsageOperationMetrics(r2, "accountDaily", "account", start, end));
  }
  return values;
}
async function cleanup(env: WorkerEnv, key: string, now: number): Promise<void> {
  const expired = await env.DB.prepare("DELETE FROM usage_history WHERE rowid IN (SELECT rowid FROM usage_history WHERE day < ?1 ORDER BY day LIMIT ?2)").bind(date(today(now) - RETENTION_DAYS * DAY), CLEANUP_BATCH).run();
  const remaining = CLEANUP_BATCH - (expired.meta.changes ?? 0);
  if (!remaining) return;
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM (SELECT 1 FROM usage_history LIMIT ?1)").bind(MAX_HISTORY_ROWS).first<{ count: number }>();
  if ((count?.count ?? 0) < MAX_HISTORY_ROWS) return;
  // 当前配置最多保留90个日期，day索引找7个其他配置候选至多越过90个当前行。
  await env.DB.prepare("DELETE FROM usage_history WHERE rowid IN (SELECT rowid FROM usage_history WHERE config_key != ?1 ORDER BY day LIMIT ?2)").bind(key, remaining).run();
}
async function collectDay(env: WorkerEnv, day: string, now: number, fetcher: typeof fetch, manual: boolean): Promise<void> {
  if (env.USAGE_HISTORY_ENABLED !== "true") return;
  const configuration = usageAnalyticsConfig(env); if (!configuration) return;
  const start = dayStart(day, now), key = historyKey(configuration);
  const previous = await env.DB.prepare("SELECT attempted_at, collected_at, error FROM usage_history WHERE config_key = ?1 AND day = ?2").bind(key, day).first<HistoryRow>();
  if (previous && (previous.attempted_at > now - COOLDOWN || (!manual && previous.collected_at !== null && previous.attempted_at <= previous.collected_at && previous.error === null))) return;
  await cleanup(env, key, now);
  const claim = await env.DB.prepare(`INSERT INTO usage_history(config_key, day, attempted_at) SELECT ?1, ?2, ?3
    WHERE EXISTS (SELECT 1 FROM usage_history WHERE config_key = ?1 AND day = ?2)
      OR (SELECT COUNT(*) FROM (SELECT 1 FROM usage_history LIMIT ?6)) < ?6
    ON CONFLICT(config_key, day) DO UPDATE SET attempted_at = excluded.attempted_at, error = NULL
    WHERE usage_history.attempted_at <= ?4 AND (?5 = 1 OR usage_history.collected_at IS NULL OR usage_history.error IS NOT NULL OR usage_history.attempted_at > usage_history.collected_at)`)
    .bind(key, day, now, now - COOLDOWN, manual ? 1 : 0, MAX_HISTORY_ROWS).run();
  if (!claim.meta.changes) return;
  try {
    const values = await collectMetrics(configuration, start, fetcher);
    const error = values.some(metric => metric.value !== null) ? null : "no_data";
    // 全未知只记失败；首次仍保存未知日点，已有采集值与时间不能被清空。
    await env.DB.prepare(`UPDATE usage_history SET
      collected_at = CASE WHEN ?3 IS NULL THEN ?1 ELSE COALESCE(collected_at, ?1) END,
      metrics_json = CASE WHEN ?3 IS NULL THEN ?2 ELSE COALESCE(metrics_json, ?2) END, error = ?3
      WHERE config_key = ?4 AND day = ?5 AND attempted_at = ?1 AND (collected_at IS NULL OR collected_at <= ?1)`).bind(now, JSON.stringify(values), error, key, day).run();
  } catch (error) {
    await env.DB.prepare("UPDATE usage_history SET error = ?1 WHERE config_key = ?2 AND day = ?3 AND attempted_at = ?4").bind(error instanceof UsageAnalyticsError ? error.code : "collection_failed", key, day, now).run();
  }
}
export async function collectUsageHistoryDaily(env: WorkerEnv, now = Date.now(), fetcher: typeof fetch = fetch): Promise<void> {
  await collectDay(env, date(today(now) - DAY), now, fetcher, false);
}
export async function collectUsageHistory(env: WorkerEnv, auth: AuthContext, day: unknown, now = Date.now(), fetcher: typeof fetch = fetch): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  dayStart(day, now);
  await collectDay(env, day as string, now, fetcher, true);
  return readUsageHistory(env, auth, 30, now);
}
