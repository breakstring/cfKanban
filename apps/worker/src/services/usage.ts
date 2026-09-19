import { requireOwnerControl } from "../kernel/authorization.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { readAttachmentStorage } from "./attachment-settings.ts";

const HOUR = 3_600_000;
const FRESHNESS_MS = 15 * 60_000;
const REFRESH_COOLDOWN_MS = 60_000;
const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const MAX_RESPONSE_BYTES = 64 * 1024;
type Metric = { key: string; value: number | null; unit: "bytes" | "count"; source: "cloudflare"; scope: "instance"; period_start: string | null; period_end: string | null; observed_at: string | null };
interface Snapshot { attempted_at: number | null; collected_at: number | null; error: string | null; metrics_json: string | null; config_key: string | null }
class AnalyticsError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
function config(env: WorkerEnv) {
  if (env.USAGE_ANALYTICS_ENABLED === "false" || !env.USAGE_ACCOUNT_ID?.trim() || !env.USAGE_D1_DATABASE_ID?.trim() || !env.USAGE_ANALYTICS_TOKEN?.trim()) return null;
  return { account: env.USAGE_ACCOUNT_ID, database: env.USAGE_D1_DATABASE_ID, bucket: env.USAGE_R2_BUCKET_NAME || null, token: env.USAGE_ANALYTICS_TOKEN };
}
function configKey(value: NonNullable<ReturnType<typeof config>>): string { return JSON.stringify([value.account, value.database, value.bucket]); }
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
export async function readUsage(env: WorkerEnv, auth: AuthContext, now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const budget = await readAttachmentStorage(env.DB);
  const configuration = config(env);
  const snapshot = configuration ? await env.DB.prepare("SELECT * FROM usage_statistics WHERE singleton = 1 AND config_key = ?1").bind(configKey(configuration)).first<Snapshot>() : null;
  const collected = snapshot?.collected_at ?? null;
  const interrupted = snapshot?.attempted_at !== null && snapshot?.attempted_at !== undefined && snapshot.attempted_at > (collected ?? -1) && now - snapshot.attempted_at >= REFRESH_COOLDOWN_MS;
  const error = snapshot?.error ?? (interrupted ? "collection_interrupted" : null);
  return {
    generated_at: iso(now),
    attachments: { enabled: env.ATTACHMENTS !== undefined, reserved_bytes: budget.reserved_bytes, limit_bytes: budget.limit_bytes, limit_configured: budget.limit_configured === 1, settings_version: budget.version },
    cloudflare: {
      status: !configuration ? "not_configured" : collected !== null ? (error || (snapshot?.attempted_at ?? 0) > collected || now - collected >= FRESHNESS_MS ? "stale" : "fresh") : error ? "error" : "pending",
      refreshing: snapshot !== null && error === null && snapshot.attempted_at !== null && snapshot.attempted_at > (collected ?? -1) && now - snapshot.attempted_at < REFRESH_COOLDOWN_MS,
      collected_at: iso(collected), attempted_at: iso(snapshot?.attempted_at ?? null), error,
      metrics: snapshot?.metrics_json ? JSON.parse(snapshot.metrics_json) as JsonValue : [],
    },
  };
}

const d1Query = `query UsageD1($account: string!, $database: string!, $date: Date!, $storageStart: Time!, $storageEnd: Time!) {
 viewer { accounts(filter: {accountTag: $account}) {
  activity: d1AnalyticsAdaptiveGroups(limit: 1, filter: {databaseId: $database, date_geq: $date, date_leq: $date}) { sum { rowsRead rowsWritten } }
  storage: d1StorageAdaptiveGroups(limit: 1, filter: {databaseId: $database, datetime_geq: $storageStart, datetime_lt: $storageEnd}, orderBy: [datetime_DESC]) { max { databaseSizeBytes } dimensions { datetime } }
 } }
}`;
const r2Query = `query UsageR2($account: string!, $bucket: string!, $start: Time!, $end: Time!, $storageStart: Time!, $storageEnd: Time!) {
 viewer { accounts(filter: {accountTag: $account}) {
  activity: r2OperationsAdaptiveGroups(limit: 1, filter: {bucketName: $bucket, datetime_geq: $start, datetime_leq: $end}) { sum { requests } }
  storage: r2StorageAdaptiveGroups(limit: 1, filter: {bucketName: $bucket, datetime_geq: $storageStart, datetime_lt: $storageEnd}, orderBy: [datetime_DESC]) { max { payloadSize metadataSize objectCount } dimensions { datetime } }
 } }
}`;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnalyticsError("invalid_response"); return value as ObjectValue; }
function number(value: unknown): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AnalyticsError("invalid_response"); return value; }
function first(value: unknown): ObjectValue | null { if (!Array.isArray(value) || value.length > 1) throw new AnalyticsError("invalid_response"); return value.length ? object(value[0]) : null; }
async function readAnalyticsBody(response: Response): Promise<ObjectValue> {
  if (!response.body) throw new AnalyticsError("invalid_response");
  const reader = response.body.getReader();
  let bytes = 0, text = ""; const decoder = new TextDecoder();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new AnalyticsError("invalid_response"); }
      text += decoder.decode(result.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  text += decoder.decode();
  try { return object(JSON.parse(text)); } catch { throw new AnalyticsError("invalid_response"); }
}
function providerCodes(payload: ObjectValue): number[] {
  if (!Array.isArray(payload.errors)) return [];
  return payload.errors.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const code = (entry as ObjectValue).code;
    return typeof code === "number" && Number.isSafeInteger(code) && code >= 0 ? [code] : [];
  }).slice(0, 16);
}
async function query(dataset: "d1" | "r2", queryText: string, variables: ObjectValue, token: string, fetcher: typeof fetch): Promise<ObjectValue> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let httpStatus: number | null = null;
  let codes: number[] = [];
  try {
    const response = await fetcher(ENDPOINT, { method: "POST", redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query: queryText, variables }) });
    httpStatus = response.status;
    if (!response.ok) {
      // 错误体仅提取有界数码；读取失败不能把已知 HTTP 分类替换成解析或超时错误。
      try { codes = providerCodes(await readAnalyticsBody(response)); } catch { /* 保留 HTTP 状态。 */ }
      throw new AnalyticsError(response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "permission_denied" : "upstream_error");
    }
    const payload = await readAnalyticsBody(response);
    codes = providerCodes(payload);
    if (payload.errors !== undefined && payload.errors !== null && (!Array.isArray(payload.errors) || payload.errors.length)) throw new AnalyticsError("graphql_error");
    const accounts = object(object(payload.data).viewer).accounts;
    const account = first(accounts); if (!account) throw new AnalyticsError("invalid_response"); return account;
  } catch (error) {
    const transportName = error instanceof Error && (error.name === "TypeError" || error.name === "AbortError") ? error.name : "Other";
    console.warn({ operation: "usage_analytics", dataset, phase: httpStatus === null ? "transport" : "http", http_status: httpStatus, provider_codes: codes, transport_name: httpStatus === null ? transportName : null });
    if (error instanceof AnalyticsError) throw error;
    throw new AnalyticsError(controller.signal.aborted ? "timeout" : "upstream_error");
  } finally { clearTimeout(timer); }
}
function metrics(account: ObjectValue, kind: "d1" | "r2", start: string, end: string, storageStart: string, storageEnd: string): Metric[] {
  const activity = first(account.activity), storage = first(account.storage);
  const sum = activity ? object(activity.sum) : null, max = storage ? object(storage.max) : null;
  let observed: string | null = null;
  if (storage) {
    const raw = object(storage.dimensions).datetime;
    if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw)) || Date.parse(raw) < Date.parse(storageStart) || Date.parse(raw) >= Date.parse(storageEnd)) throw new AnalyticsError("invalid_response");
    observed = new Date(raw).toISOString();
  }
  const make = (key: string, value: number | null, unit: "bytes" | "count", capacity = false): Metric => ({ key, value, unit, source: "cloudflare", scope: "instance", period_start: capacity ? null : start, period_end: capacity ? null : end, observed_at: capacity ? observed : null });
  if (kind === "d1") return [make("d1_storage_bytes", max ? number(max.databaseSizeBytes) : null, "bytes", true), make("d1_rows_read", sum ? number(sum.rowsRead) : null, "count"), make("d1_rows_written", sum ? number(sum.rowsWritten) : null, "count")];
  const payload = max ? number(max.payloadSize) : null, metadata = max ? number(max.metadataSize) : null;
  return [make("r2_storage_bytes", payload === null || metadata === null ? null : number(payload + metadata), "bytes", true), make("r2_objects", max ? number(max.objectCount) : null, "count", true), make("r2_operations", sum ? number(sum.requests) : null, "count")];
}
export async function collectUsageStatistics(env: WorkerEnv, now = Date.now(), fetcher: typeof fetch = fetch, _mode: "stale" | "manual" = "manual"): Promise<void> {
  const configuration = config(env); if (!configuration) return;
  const key = configKey(configuration);
  // 起始时间抢占单行；相同或更旧的尝试不能覆盖较新的采集。
  const claim = await env.DB.prepare(`UPDATE usage_statistics SET attempted_at = ?1, error = NULL,
    collected_at = CASE WHEN config_key = ?2 THEN collected_at ELSE NULL END,
    metrics_json = CASE WHEN config_key = ?2 THEN metrics_json ELSE NULL END, config_key = ?2
    WHERE singleton = 1 AND (attempted_at IS NULL OR attempted_at <= ?3)
      AND (config_key IS NOT ?2 OR collected_at IS NULL OR collected_at <= ?4 OR attempted_at > collected_at OR error IS NOT NULL)`).bind(now, key, now - REFRESH_COOLDOWN_MS, now - FRESHNESS_MS).run();
  if (!claim.meta.changes) return;
  const end = new Date(now).toISOString(), start = `${end.slice(0, 10)}T00:00:00.000Z`;
  const storageStart = new Date(now - 24 * HOUR).toISOString(), storageEnd = new Date(Math.floor(now / HOUR) * HOUR).toISOString();
  try {
    const shared = { account: configuration.account, start, end, storageStart, storageEnd };
    const d1 = await query("d1", d1Query, { account: configuration.account, date: end.slice(0, 10), storageStart, storageEnd, database: configuration.database }, configuration.token, fetcher);
    const values = metrics(d1, "d1", start, end, storageStart, storageEnd);
    if (configuration.bucket) values.push(...metrics(await query("r2", r2Query, { ...shared, bucket: configuration.bucket }, configuration.token, fetcher), "r2", start, end, storageStart, storageEnd));
    await env.DB.prepare("UPDATE usage_statistics SET collected_at = ?1, metrics_json = ?2, error = NULL WHERE singleton = 1 AND attempted_at = ?1 AND config_key = ?3").bind(now, JSON.stringify(values), key).run();
  } catch (error) {
    await env.DB.prepare("UPDATE usage_statistics SET error = ?2 WHERE singleton = 1 AND attempted_at = ?1 AND config_key = ?3").bind(now, error instanceof AnalyticsError ? error.code : "collection_failed", key).run();
  }
}

export async function refreshUsage(env: WorkerEnv, auth: AuthContext, mode: "stale" | "manual", now = Date.now(), fetcher: typeof fetch = fetch): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  await collectUsageStatistics(env, now, fetcher, mode);
  return readUsage(env, auth, Date.now());
}
