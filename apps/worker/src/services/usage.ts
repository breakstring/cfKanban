import { requireOwnerControl } from "../kernel/authorization.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { readAttachmentStorage } from "./attachment-settings.ts";
import { publicAccessSnapshot, r2OperationClass, usageAlerts, usageBilling, type UsageMetric } from "./usage-budgets.ts";

const HOUR = 3_600_000;
const FRESHNESS_MS = 15 * 60_000;
const REFRESH_COOLDOWN_MS = 60_000;
const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const MAX_RESPONSE_BYTES = 64 * 1024;
type Metric = UsageMetric;
interface Snapshot { attempted_at: number | null; collected_at: number | null; error: string | null; metrics_json: string | null; config_key: string | null }
class AnalyticsError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
function config(env: WorkerEnv) {
  if (env.USAGE_ANALYTICS_ENABLED === "false" || !env.USAGE_ACCOUNT_ID?.trim() || !env.USAGE_D1_DATABASE_ID?.trim() || !env.USAGE_ANALYTICS_TOKEN?.trim()) return null;
  return { account: env.USAGE_ACCOUNT_ID, database: env.USAGE_D1_DATABASE_ID, bucket: env.USAGE_R2_BUCKET_NAME || null, token: env.USAGE_ANALYTICS_TOKEN,
    worker: env.USAGE_WORKER_NAME || null, cycle: env.USAGE_BILLING_CYCLE_DAY || null, plan: env.USAGE_BILLING_PLAN || null,
    totals: env.USAGE_ACCOUNT_TOTALS_ENABLED === "true", warning: env.USAGE_WARNING_PERCENT || null, standardScope: env.USAGE_R2_STANDARD_ONLY_SCOPE || null };
}
function configKey(value: NonNullable<ReturnType<typeof config>>): string { return JSON.stringify([value.account, value.database, value.bucket, value.worker, value.cycle, value.plan, value.totals, value.warning, value.standardScope]); }
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
export async function readUsage(env: WorkerEnv, auth: AuthContext, now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const budget = await readAttachmentStorage(env.DB);
  const configuration = config(env);
  const snapshot = configuration ? await env.DB.prepare("SELECT * FROM usage_statistics WHERE singleton = 1 AND config_key = ?1").bind(configKey(configuration)).first<Snapshot>() : null;
  const collected = snapshot?.collected_at ?? null;
  const interrupted = snapshot?.attempted_at !== null && snapshot?.attempted_at !== undefined && snapshot.attempted_at > (collected ?? -1) && now - snapshot.attempted_at >= REFRESH_COOLDOWN_MS;
  const error = snapshot?.error ?? (interrupted ? "collection_interrupted" : null);
  const status = !configuration ? "not_configured" : collected !== null ? (error || (snapshot?.attempted_at ?? 0) > collected || now - collected >= FRESHNESS_MS ? "stale" : "fresh") : error ? "error" : "pending";
  const values = snapshot?.metrics_json ? JSON.parse(snapshot.metrics_json) as Metric[] : [];
  const billing = usageBilling(env, collected ?? now);
  return {
    generated_at: iso(now),
    attachments: { enabled: env.ATTACHMENTS !== undefined, reserved_bytes: budget.reserved_bytes, limit_bytes: budget.limit_bytes, limit_configured: budget.limit_configured === 1, settings_version: budget.version },
    public_access: publicAccessSnapshot(env),
    cloudflare: {
      status,
      refreshing: snapshot !== null && error === null && snapshot.attempted_at !== null && snapshot.attempted_at > (collected ?? -1) && now - snapshot.attempted_at < REFRESH_COOLDOWN_MS,
      collected_at: iso(collected), attempted_at: iso(snapshot?.attempted_at ?? null), error,
      metrics: values as unknown as JsonValue,
      billing, alerts: usageAlerts(values, billing, status === "fresh"),
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
    // workerd 不支持 redirect:error；manual 返回的 3xx 由下方拒绝，不转发凭据。
    const response = await fetcher(ENDPOINT, { method: "POST", redirect: "manual", signal: controller.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query: queryText, variables }) });
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

function extendedQueries(configuration: NonNullable<ReturnType<typeof config>>, billing: ReturnType<typeof usageBilling>, start: string) {
  const monthly = billing.period_start !== null;
  const workerStart = billing.plan === "paid" ? billing.period_start : start;
  const declarations = ["$account: string!", "$database: string!", "$date: Date!", "$storageStart: Time!", "$storageEnd: Time!"];
  const fields = ["activity: d1AnalyticsAdaptiveGroups(limit: 1, filter: {databaseId: $database, date_geq: $date, date_leq: $date}) { sum { rowsRead rowsWritten } }", "storage: d1StorageAdaptiveGroups(limit: 1, filter: {databaseId: $database, datetime_geq: $storageStart, datetime_lt: $storageEnd}, orderBy: [datetime_DESC]) { max { databaseSizeBytes } dimensions { datetime } }"];
  if (monthly) {
    declarations.push("$billingDate: Date!");
    fields.push("billing: d1AnalyticsAdaptiveGroups(limit: 1, filter: {databaseId: $database, date_geq: $billingDate, date_leq: $date}) { sum { rowsRead rowsWritten } }");
  }
  if (configuration.totals) fields.push("accountDaily: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: $date, date_leq: $date}) { sum { rowsRead rowsWritten } }");
  if (configuration.totals && monthly) fields.push("accountBilling: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: $billingDate, date_leq: $date}) { sum { rowsRead rowsWritten } }");
  if (workerStart && (configuration.worker || configuration.totals)) {
    declarations.push("$workerStart: Time!", "$end: Time!");
    if (configuration.worker) { declarations.push("$worker: string!"); fields.push("worker: workersInvocationsAdaptive(limit: 1, filter: {scriptName: $worker, datetime_geq: $workerStart, datetime_leq: $end}) { sum { requests cpuTimeUs } }"); }
    if (configuration.totals) fields.push("accountWorker: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $workerStart, datetime_leq: $end}) { sum { requests cpuTimeUs } }");
  }
  const r2Declarations = ["$account: string!"];
  const r2Fields: string[] = [];
  if (configuration.bucket) {
    r2Declarations.push("$bucket: string!", "$start: Time!", "$end: Time!", "$storageStart: Time!", "$storageEnd: Time!");
    r2Fields.push("activity: r2OperationsAdaptiveGroups(limit: 1, filter: {bucketName: $bucket, datetime_geq: $start, datetime_leq: $end}) { sum { requests } }", "storage: r2StorageAdaptiveGroups(limit: 1, filter: {bucketName: $bucket, datetime_geq: $storageStart, datetime_lt: $storageEnd}, orderBy: [datetime_DESC]) { max { payloadSize metadataSize objectCount } dimensions { datetime } }");
  }
  if (monthly && (configuration.bucket || configuration.totals)) {
    r2Declarations.push("$billingStart: Time!");
    if (!configuration.bucket) r2Declarations.push("$end: Time!");
    const operation = (alias: string, scoped: boolean) => `${alias}: r2OperationsAdaptiveGroups(limit: 101, filter: {${scoped ? "bucketName: $bucket," : ""} datetime_geq: $billingStart, datetime_leq: $end}) { sum { requests } dimensions { actionType responseStatusCode } }`;
    if (configuration.bucket) r2Fields.push(operation("billing", true));
    if (configuration.totals) r2Fields.push(operation("accountBilling", false));
  }
  return {
    d1: `query UsageD1(${declarations.join(", ")}) { viewer { accounts(filter: {accountTag: $account}) { ${fields.join("\n")} } } }`,
    r2: r2Fields.length ? `query UsageR2(${r2Declarations.join(", ")}) { viewer { accounts(filter: {accountTag: $account}) { ${r2Fields.join("\n")} } } }` : null,
    workerStart,
  };
}

function extendedMetrics(account: ObjectValue, configuration: NonNullable<ReturnType<typeof config>>, billing: ReturnType<typeof usageBilling>, start: string, end: string): Metric[] {
  const values: Metric[] = [];
  const add = (alias: string, keys: [string, string], fields: [string, string], scope: Metric["scope"], period: string | null, cpu = false) => {
    const row = period ? first(account[alias]) : null;
    const sum = row ? object(row.sum) : null;
    keys.forEach((key, index) => values.push({ key, value: sum ? number(sum[fields[index]!]) : null, unit: cpu && index === 1 ? "microseconds" : "count", source: "cloudflare", scope, period_start: period, period_end: period ? end : null, observed_at: null }));
  };
  if (configuration.cycle) add("billing", ["d1_billing_rows_read", "d1_billing_rows_written"], ["rowsRead", "rowsWritten"], "instance", billing.period_start);
  if (configuration.totals) {
    add("accountDaily", ["d1_rows_read", "d1_rows_written"], ["rowsRead", "rowsWritten"], "account", start);
    if (configuration.cycle) add("accountBilling", ["d1_billing_rows_read", "d1_billing_rows_written"], ["rowsRead", "rowsWritten"], "account", billing.period_start);
  }
  const workerStart = billing.plan === "paid" ? billing.period_start : start;
  if (configuration.worker) add("worker", ["workers_requests", "workers_cpu_microseconds"], ["requests", "cpuTimeUs"], "instance", workerStart, true);
  if (configuration.totals) add("accountWorker", ["workers_requests", "workers_cpu_microseconds"], ["requests", "cpuTimeUs"], "account", workerStart, true);
  return values;
}

function operationMetrics(account: ObjectValue, alias: string, scope: Metric["scope"], start: string | null, end: string): Metric[] {
  let a: number | null = null, b: number | null = null, unknown: number | null = null;
  if (start) {
    const rows = account[alias];
    if (!Array.isArray(rows) || rows.length > 101) throw new AnalyticsError("invalid_response");
    if (rows.length) {
      a = 0; b = 0; unknown = 0;
      for (const raw of rows) {
        const row = object(raw), dimensions = object(row.dimensions), requests = number(object(row.sum).requests);
        if (typeof dimensions.actionType !== "string" || requests === null) throw new AnalyticsError("invalid_response");
        const code = dimensions.responseStatusCode;
        const category = typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599 ? r2OperationClass(dimensions.actionType, code) : "unknown";
        if (category === "a") a += requests;
        else if (category === "b") b += requests;
        else if (category === "unknown") unknown += requests;
      }
      // 截断或未知操作不能被误报为完整的计费类别合计。
      if (rows.length === 101 || unknown > 0) { a = null; b = null; }
      if (rows.length === 101) unknown = null;
    }
  }
  return [["r2_class_a_operations", a], ["r2_class_b_operations", b], ["r2_unclassified_operations", unknown]].map(([key, value]) => ({ key: key as string, value: value as number | null, unit: "count", source: "cloudflare", scope, period_start: start, period_end: start ? end : null, observed_at: null }));
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
    const billing = usageBilling(env, now);
    const extended = Boolean(configuration.worker || configuration.cycle || configuration.totals);
    const queries = extendedQueries(configuration, billing, start);
    const shared = { account: configuration.account, start, end, storageStart, storageEnd };
    const d1 = await query("d1", extended ? queries.d1 : d1Query, { account: configuration.account, date: end.slice(0, 10), storageStart, storageEnd, database: configuration.database,
      ...(billing.period_start ? { billingDate: billing.period_start.slice(0, 10) } : {}),
      ...(queries.workerStart && (configuration.worker || configuration.totals) ? { workerStart: queries.workerStart, end, ...(configuration.worker ? { worker: configuration.worker } : {}) } : {}),
    }, configuration.token, fetcher);
    const values = metrics(d1, "d1", start, end, storageStart, storageEnd);
    if (extended) values.push(...extendedMetrics(d1, configuration, billing, start, end));
    if (configuration.bucket || (configuration.totals && billing.period_start)) {
      const r2 = await query("r2", extended ? queries.r2! : r2Query, { ...shared, ...(configuration.bucket ? { bucket: configuration.bucket } : {}), ...(billing.period_start ? { billingStart: billing.period_start } : {}) }, configuration.token, fetcher);
      if (configuration.bucket) values.push(...metrics(r2, "r2", start, end, storageStart, storageEnd));
      if (configuration.cycle && configuration.bucket) values.push(...operationMetrics(r2, "billing", "instance", billing.period_start, end));
      if (configuration.totals && configuration.cycle) values.push(...operationMetrics(r2, "accountBilling", "account", billing.period_start, end));
    }
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
