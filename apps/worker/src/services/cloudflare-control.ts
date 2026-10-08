import { assessWafOperation, readLocalWafStatus, verifyWafResult } from "./cloudflare-waf.ts";
import { buildCurrentAuthGuard, reauthenticateOwner, requireOwnerControl, type SqlGuard } from "../kernel/authorization.ts";
import { isUuid, sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, probeOperationCommit } from "../kernel/d1.ts";
import { ApiError, conflict, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { canonicalJson, computeRequestHash, readOperationSnapshot, runIdempotentOperation, validateIdempotencyKey } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { actorCredentialId, requireIdempotencyKey, writeResult } from "./shared.ts";
import { usageAnalyticsConfig } from "./usage.ts";

export type Resource = { [key: string]: JsonValue };
type Capability = "missing" | "unverified" | "verified" | "permission_denied" | "unavailable" | "target_mismatch" | "unsupported_contract";
export type Status = "pending" | "verified" | "failed" | "unknown";
type SecretKind = "connection" | "configuration" | "control" | "analytics";
type PlanKind = "configuration" | "rate_limit" | "waf";
type ConfigurationPlanKind = Exclude<PlanKind, "waf">;
type ProviderOperation = "deployments" | "versions" | "settings" | "version_details" | "secret_write" | "notifications" | "billing" | "waf" | "zone" | "graphql";
interface ProviderDiagnostics { provider_operation?: ProviderOperation; provider_method?: "GET" | "PUT" | "POST" | "PATCH" | "DELETE"; provider_status?: number }
export interface CloudflareControlDependencies { fetch?: typeof fetch }
export interface SettingsRow { version: number; zone_id: string | null; capabilities_json: string; verified_at: number | null; latest_operation_id: string | null; locked_operation_id: string | null; last_operation_id: string | null }
export interface OperationRow { id: string; principal_id: string; route: string; request_hash: string; kind: string; status: Status; baseline_json: string; desired_json: string; secret_value_hash: string | null; dispatched_at: number | null; result_version_id: string | null; deployment_id: string | null; failure_class: string | null; created_at: number; updated_at: number }
export interface PlanRow { id: string; kind: PlanKind; control_version: number; baseline_json: string; before_json: string; after_json: string; created_at: number; consumed_operation_id: string | null }
export interface Target { account_id: string; worker_name: string; database_id: string }
export interface Baseline extends Resource { active_version_id: string; latest_version_id: string; deployment_id: string; etag: string; settings_hash: string; target: Resource }
export interface LiveBaseline { baseline: Baseline; settings: Resource; bindings: Resource[] }
function settingsMetadata(settings: Resource): Resource {
  const { bindings: _bindings, annotations: _annotations, exports_reconciliation: _reconciliation, ...metadata } = settings;
  return metadata;
}
const SECRET_NAMES = { connection: "CFKANBAN_API_TOKEN", configuration: "CFKANBAN_CONFIGURATION_TOKEN", control: "CFKANBAN_CONTROL_TOKEN", analytics: "USAGE_ANALYTICS_TOKEN" } as const;
const RATE_GROUPS = {
  instance: ["INSTANCE_RATE_LIMITER", "RATE_LIMIT_INSTANCE_LIMIT", "RATE_LIMIT_INSTANCE_PERIOD_SECONDS"],
  principal: ["PRINCIPAL_RATE_LIMITER", "RATE_LIMIT_PRINCIPAL_LIMIT", "RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS"],
  unauthenticated_sensitive: ["UNAUTHENTICATED_RATE_LIMITER", "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT", "RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS"],
  anonymous_login: ["ANONYMOUS_LOGIN_RATE_LIMITER", "RATE_LIMIT_ANONYMOUS_LOGIN_LIMIT", "RATE_LIMIT_ANONYMOUS_LOGIN_PERIOD_SECONDS"],
  expensive_reads: ["EXPENSIVE_READ_RATE_LIMITER", "RATE_LIMIT_EXPENSIVE_READ_LIMIT", "RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS"],
} as const;
type RateScope = keyof typeof RATE_GROUPS;
const CONFIG_VARS = { history_enabled: "USAGE_HISTORY_ENABLED", analytics_enabled: "USAGE_ANALYTICS_ENABLED", billing_plan: "USAGE_BILLING_PLAN", billing_cycle_day: "USAGE_BILLING_CYCLE_DAY", account_totals: "USAGE_ACCOUNT_TOTALS_ENABLED", warning_percent: "USAGE_WARNING_PERCENT" } as const;
const BUDGET = { status: "unsupported_contract", docs_url: "https://developers.cloudflare.com/billing/manage/budget-alerts/", dashboard_url: "https://dash.cloudflare.com/?to=/:account/billing/billable-usage" };

export class ProviderFailure extends ApiError {
  readonly capability: Capability;
  readonly rejected: boolean;
  readonly missingResource: boolean;
  constructor(capability: Capability, rejected = false, missingResource = false, diagnostics: ProviderDiagnostics = {}) {
    super({ code: capability === "permission_denied" ? "FORBIDDEN" : capability === "target_mismatch" ? "VERSION_CONFLICT" : "PLATFORM_UNAVAILABLE", category: capability === "permission_denied" ? "authorization" : capability === "target_mismatch" ? "conflict" : "platform_failure", source: "cloudflare_platform", message: "Cloudflare control request could not be verified.", recovery: "request_owner", retryable: false, status: capability === "permission_denied" ? 403 : capability === "target_mismatch" ? 409 : 503, details: { component: "cloudflare-control", failure_class: capability, ...diagnostics } });
    this.capability = capability; this.rejected = rejected; this.missingResource = missingResource;
  }
}
export function object(value: JsonValue | undefined): Resource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProviderFailure("unavailable");
  return value;
}
export function list(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value) || value.length > 500) throw new ProviderFailure("unavailable");
  return value;
}
export function text(value: JsonValue | undefined, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new ProviderFailure("unavailable");
  return value;
}
export function fixedTarget(env: WorkerEnv): Target {
  const account = env.CFKANBAN_CONTROL_ACCOUNT_ID, worker = env.CFKANBAN_CONTROL_WORKER_NAME, database = env.CFKANBAN_CONTROL_DATABASE_ID;
  if (!account || !/^[a-zA-Z0-9_-]{1,128}$/.test(account) || !worker || !/^[a-zA-Z0-9_-]{1,63}$/.test(worker) || !database || !isUuid(database)) throw validationError("cloudflare_target_not_configured");
  return { account_id: account, worker_name: worker, database_id: database };
}
function targetResource(target: Target): Resource { return { ...target }; }
export function tokenFor(env: WorkerEnv, kind: SecretKind): string | undefined { return env.CFKANBAN_API_TOKEN ?? env[SECRET_NAMES[kind]]; }
function secretOperationKind(kind: SecretKind): string { return `${kind === "connection" ? "configuration" : kind}_secret`; }
function operationSecretName(row: OperationRow, desired: Resource): typeof SECRET_NAMES[SecretKind] {
  const kind = desired.secret_kind;
  if (typeof kind !== "string" || !Object.hasOwn(SECRET_NAMES, kind) || desired.secret_name !== SECRET_NAMES[kind as SecretKind] || row.kind !== secretOperationKind(kind as SecretKind)) throw new ProviderFailure("target_mismatch", true);
  return SECRET_NAMES[kind as SecretKind];
}
function scriptPath(target: Target): string { return `/accounts/${encodeURIComponent(target.account_id)}/workers/scripts/${encodeURIComponent(target.worker_name)}`; }
function providerDiagnostics(path: string, method: string, status: number): ProviderDiagnostics {
  const details: ProviderDiagnostics = {};
  const worker = /^\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/(deployments|versions|settings|secrets)$/.exec(path);
  if (worker) details.provider_operation = worker[1] === "secrets" ? "secret_write" : worker[1] as "deployments" | "versions" | "settings";
  else if (/^\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/versions\/[^/]+$/.test(path)) details.provider_operation = "version_details";
  else if (/^\/accounts\/[^/]+\/alerting\/v3\/(available_alerts|policies)$/.test(path)) details.provider_operation = "notifications";
  else if (/^\/accounts\/[^/]+\/billable-usage\/info$/.test(path)) details.provider_operation = "billing";
  else if (/^\/zones\/[^/]+\/rulesets\/phases\/http_request_firewall_custom\/entrypoint$/.test(path)) details.provider_operation = "waf";
  else if (/^\/zones\/[^/]+$/.test(path)) details.provider_operation = "zone";
  else if (path === "/graphql") details.provider_operation = "graphql";
  if (method === "GET" || method === "PUT" || method === "POST" || method === "PATCH" || method === "DELETE") details.provider_method = method;
  if (Number.isInteger(status) && status >= 100 && status <= 599) details.provider_status = status;
  return details;
}
const providerErrorTerms = [
  ["inherit", /\binherit(?:ed|ance)?\b/i], ["assets", /\bassets?\b/i], ["bindings", /\bbindings?\b/i],
  ["version", /\bversions?\b/i], ["multipart", /\bmultipart\b/i], ["metadata", /\bmetadata\b/i],
  ["settings", /\bsettings?\b/i], ["placement", /\bplacement\b/i], ["ratelimit", /\b(?:ratelimit|rate[_ -]limits?)\b/i],
  ["secret", /\bsecrets?\b/i], ["unsupported", /\bunsupported\b/i],
] as const;
interface ProviderLogDiagnostics { provider_codes: number[]; provider_error_tags: string[] }
async function providerErrorDiagnostics(response: Response): Promise<ProviderLogDiagnostics> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const empty = { provider_codes: [], provider_error_tags: [] };
  try {
    reader = response.body?.getReader();
    if (!reader) return empty;
    let length = 0, body = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65_536) { await reader.cancel().catch(() => {}); return empty; }
      body += decoder.decode(chunk.value, { stream: true });
    }
    const payload = object(JSON.parse(body + decoder.decode()) as JsonValue);
    if (!Array.isArray(payload.errors)) return empty;
    const codes: number[] = [], tags = new Set<string>();
    for (const entry of payload.errors) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (codes.length < 16 && typeof entry.code === "number" && Number.isSafeInteger(entry.code) && entry.code >= 0) codes.push(entry.code);
      if (typeof entry.message === "string") for (const [tag, expression] of providerErrorTerms) { if (expression.test(entry.message)) tags.add(tag); }
    }
    return { provider_codes: codes, provider_error_tags: [...tags] };
  } catch { return empty; }
  finally { try { reader?.releaseLock(); } catch { /* 诊断读取不能覆盖已知 HTTP 分类。 */ } }
}
export function api(token: string, dependencies: CloudflareControlDependencies, completeInventory = false) {
  return async (path: string, init: RequestInit = {}): Promise<JsonValue> => {
    if (!path.startsWith("/accounts/") && !path.startsWith("/zones/") && path !== "/graphql") throw new ProviderFailure("target_mismatch", true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (dependencies.fetch ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) }, redirect: "manual", signal: controller.signal });
      const diagnostics = providerDiagnostics(path, init.method ?? "GET", response.status);
      if (!response.ok) {
        console.warn({ operation: "cloudflare_control", ...diagnostics, ...await providerErrorDiagnostics(response) });
        if (response.status === 401 || response.status === 403) throw new ProviderFailure("permission_denied", true, false, diagnostics);
        if (response.status === 404) throw new ProviderFailure("unavailable", true, true, diagnostics);
        throw new ProviderFailure("unavailable", response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429, false, diagnostics);
      }
      const reader = response.body?.getReader(); if (!reader) throw new ProviderFailure("unavailable");
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 65_536) { await reader.cancel(); throw new ProviderFailure("unavailable"); } chunks.push(chunk.value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const envelope = object(JSON.parse(new TextDecoder().decode(bytes)) as JsonValue);
      if (path === "/graphql") { if (envelope.errors !== undefined && envelope.errors !== null && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)) throw new ProviderFailure("permission_denied"); return envelope.data ?? null; }
      if (envelope.success !== true) throw new ProviderFailure("unavailable");
      // 基线只取当前部署与最新版本的首项，不需要读取历史页。
      if (envelope.result_info) { const info = object(envelope.result_info); if (typeof info.total_pages === "number" && info.total_pages > 1 && !path.endsWith("/versions") && !path.endsWith("/deployments")) throw new ProviderFailure("unavailable"); }
      if (completeInventory && envelope.result_info) {
        const info = object(envelope.result_info), cursors = info.cursors === undefined || info.cursors === null ? {} : object(info.cursors), result = envelope.result;
        const counted = Array.isArray(result) ? result : result !== null && typeof result === "object" && Array.isArray(result.rules) ? result.rules : null;
        if ((info.total_pages !== undefined && info.total_pages !== null && info.total_pages !== 1) || (info.page !== undefined && info.page !== null && info.page !== 1) || (info.total_count !== undefined && info.total_count !== null && (!Number.isSafeInteger(info.total_count) || Number(info.total_count) < 0 || (counted && info.total_count !== counted.length))) || Object.values(cursors).some(cursor => cursor !== undefined && cursor !== null && cursor !== "") || (info.cursor !== undefined && info.cursor !== null && info.cursor !== "")) throw new ProviderFailure("unavailable");
      }
      return envelope.result ?? null;
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure("unavailable"); }
    finally { clearTimeout(timer); }
  };
}
export async function baseline(env: WorkerEnv, token: string, dependencies: CloudflareControlDependencies, allowPending = false): Promise<LiveBaseline> {
  const target = fixedTarget(env), call = api(token, dependencies), path = scriptPath(target);
  const [deploymentResult, versionsResult, settingsResult] = await Promise.all([call(`${path}/deployments`), call(`${path}/versions`), call(`${path}/settings`)]);
  const deployment = object(list(object(deploymentResult).deployments)[0]), active = list(deployment.versions);
  if (active.length !== 1 || object(active[0]).percentage !== 100) throw new ProviderFailure("target_mismatch", true);
  const versionId = text(object(active[0]).version_id), latestId = text(object(list(object(versionsResult).items)[0]).id);
  if (!allowPending && latestId !== versionId) throw validationError("cloudflare_pending_version");
  const version = object(await call(`${path}/versions/${encodeURIComponent(versionId)}`)), resources = object(version.resources), script = object(resources.script);
  const settings = object(settingsResult), settingsBindings = list(settings.bindings).map(object), bindings = list(resources.bindings).map(object);
  for (const inventory of [settingsBindings, bindings]) {
    const databases = inventory.filter(binding => binding.type === "d1" && binding.name === "DB");
    if (databases.length !== 1 || (databases[0]?.id ?? databases[0]?.database_id) !== target.database_id) throw new ProviderFailure("target_mismatch", true);
    if (new Set(inventory.map(binding => text(binding.name))).size !== inventory.length) throw new ProviderFailure("target_mismatch", true);
  }
  // /settings may describe the latest uploaded candidate. Only the deployment's
  // version resources prove active bindings; candidate metadata cannot prove active config.
  return { settings, bindings, baseline: { active_version_id: versionId, latest_version_id: latestId, deployment_id: text(deployment.id), etag: text(script.etag), settings_hash: await sha256Hex(canonicalJson(settings)), metadata_hash: latestId === versionId ? await sha256Hex(canonicalJson(settingsMetadata(settings))) : null, binding_fingerprints: await Promise.all(bindings.map(async binding => ({ name: text(binding.name), type: text(binding.type), hash: await sha256Hex(canonicalJson(binding)) }))), target: targetResource(target) } };
}
export async function settingsRow(db: D1Database): Promise<SettingsRow> { const row = await db.prepare("SELECT * FROM cloudflare_control_settings WHERE singleton=1").first<SettingsRow>(); if (!row) throw platformUnavailable("d1"); return row; }
export async function operationRow(db: D1Database, id: string): Promise<OperationRow> { if (!isUuid(id)) throw notFound(); const row = await db.prepare("SELECT * FROM cloudflare_control_operations WHERE id=?1").bind(id).first<OperationRow>(); if (!row) throw notFound(); return row; }
export async function instance(db: D1Database) { const row = await db.prepare("SELECT m.instance_id,o.preferred_api_origin FROM instance_meta m JOIN instance_origin_settings o ON o.singleton=m.singleton WHERE m.singleton=1").first<{ instance_id: string; preferred_api_origin: string }>(); if (!row) throw platformUnavailable("d1"); return row; }
export function operationResource(row: OperationRow, version: number): Resource { const base = object(JSON.parse(row.baseline_json) as JsonValue); return { operation_id: row.id, kind: row.kind, status: row.status, version, baseline_version_id: base.active_version_id ?? null, result_version_id: row.kind === "waf" ? null : row.result_version_id, ...(row.kind === "waf" ? { result_rule_id: row.result_version_id } : {}), deployment_id: row.deployment_id, failure_class: row.failure_class, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() }; }
export function planResource(row: PlanRow): Resource { const base = object(JSON.parse(row.baseline_json) as JsonValue); return { plan_id: row.id, kind: row.kind, version: row.control_version, baseline_version_id: base.active_version_id ?? null, baseline_deployment_id: base.deployment_id ?? null, target: base.target ?? null, before: JSON.parse(row.before_json) as JsonValue, after: JSON.parse(row.after_json) as JsonValue, created_at: new Date(row.created_at).toISOString() }; }
function event(db: D1Database, auth: AuthContext, eventId: string, operationId: string, instanceId: string, now: number, type: string) {
  return db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
    SELECT ?1,'security',?2,?3,0,?4,?5,'deployment_owner','instance',?6,json_object('version',version,'operation_id',latest_operation_id),?7
    FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?3`).bind(eventId, type, operationId, auth.principalId, actorCredentialId(auth), instanceId, now);
}
export async function localChange(env: WorkerEnv, request: Request, auth: AuthContext, route: string, body: Resource, expected: number | null, mutation: (operationId: string, version: number) => D1PreparedStatement[], snapshot: (version: number) => Promise<Resource>, now: number, prepare?: () => Promise<void>, commitGuard?: (startIndex: number) => SqlGuard): Promise<Resource> {
  requireOwnerControl(auth); const db = env.DB, authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const result = await runIdempotentOperation({ db, now, method: request.method, routeTemplate: route, scopeKey: `principal:${auth.principalId}`, normalizedResourceScope: "instance-cloudflare-control", requestBody: body, idempotencyKey: requireIdempotencyKey(request), authorize,
    execute: async operationId => {
      await authorize(); const row = await settingsRow(db); if (expected !== null && row.version !== expected) throw versionConflict(row.version); if (row.locked_operation_id) throw conflict("VERSION_CONFLICT", "refresh_resource", { reason: "cloudflare_operation_pending" });
      await prepare?.(); await authorize();
      const guard = buildCurrentAuthGuard(auth, Date.now(), 3, true), meta = await instance(db), extraGuard = commitGuard?.(3 + guard.values.length);
      await executeAtomicBatch(db, { operationId, primarySubjectId: meta.instance_id, primarySubjectType: "instance", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
        businessStatements: [db.prepare(`UPDATE cloudflare_control_settings SET version=version+1,last_operation_id=?1 WHERE singleton=1 AND version=?2 AND locked_operation_id IS NULL AND ${guard.sql}${extraGuard ? ` AND (${extraGuard.sql})` : ""}`).bind(operationId, row.version, ...guard.values, ...(extraGuard?.values ?? [])), ...mutation(operationId, row.version + 1),
          db.prepare("UPDATE idempotency_records SET operation_snapshot_json=?2 WHERE operation_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?1)").bind(operationId, canonicalJson(await snapshot(row.version + 1))),
          event(db, auth, crypto.randomUUID(), operationId, meta.instance_id, now, "instance.cloudflare-control-updated")],
        confirmBusinessRejection: async () => { await authorize(); return (await settingsRow(db)).version !== row.version; } });
    },
    readback: async (id, commit) => ({ body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, id), commit.lastEventSequence, false), status: 200 }) });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
const LOCAL_OPERATIONS = {
  zone_settings: { method: "PATCH", route: "/api/v1/admin/cloudflare/settings" },
  waf_target_binding: { method: "POST", route: "/api/v1/admin/cloudflare/waf/target-binding" },
  waf_plan: { method: "POST", route: "/api/v1/admin/cloudflare/waf/plan" },
} as const;
type LocalOperation = keyof typeof LOCAL_OPERATIONS;
async function localOperationReceipt(env: WorkerEnv, auth: AuthContext, operation: LocalOperation, key: string, now: number, body?: Resource): Promise<Resource | null> {
  requireOwnerControl(auth); validateIdempotencyKey(key);
  const { method, route } = LOCAL_OPERATIONS[operation], scope = "instance-cloudflare-control";
  const [keyHash, scopeHash] = await Promise.all([sha256Hex(key), sha256Hex(scope)]);
  const row = await env.DB.prepare(`SELECT record.operation_id,record.request_hash,record.state,record.response_json,record.operation_snapshot_json,commit_row.last_event_sequence
    FROM idempotency_records record LEFT JOIN operation_commits commit_row ON commit_row.operation_id=record.operation_id
    WHERE record.scope_key=?1 AND record.method=?2 AND record.route_template=?3 AND record.resource_scope_hash=?4 AND record.idempotency_key=?5 AND record.expires_at>?6 LIMIT 1`)
    .bind(`principal:${auth.principalId}`, method, route, scopeHash, keyHash, now)
    .first<{ operation_id: string; request_hash: string; state: string; response_json: string | null; operation_snapshot_json: string | null; last_event_sequence: number | null }>();
  if (!row) return null;
  if (body !== undefined) {
    const { requestHash } = await computeRequestHash({ method, routeTemplate: route, normalizedResourceScope: scope, scopeKey: `principal:${auth.principalId}`, idempotencyKey: key, requestBody: body });
    if (row.request_hash !== requestHash) throw new ApiError({ code: "IDEMPOTENCY_CONFLICT", category: "conflict", message: "The Idempotency-Key was already used for a different request.", recovery: "none", retryable: false, status: 409 });
  }
  // 历史 pending 可能已原子提交但尚未写回缓存；只有 commit 与快照共同证明成功。
  if (row.last_event_sequence === null) return null;
  const result = row.state === "committed" && row.response_json !== null
    ? object(JSON.parse(row.response_json) as JsonValue)
    : await writeResult(env.DB, auth, await readOperationSnapshot<Resource>(env.DB, row.operation_id), row.last_event_sequence, true);
  return { ...result, idempotent_replay: true, operation, request_hash: row.request_hash };
}
export async function getCloudflareLocalOperation(env: WorkerEnv, auth: AuthContext, operation: string | null, key: string, now: number): Promise<Resource> {
  requireOwnerControl(auth);
  if (!operation || !Object.hasOwn(LOCAL_OPERATIONS, operation)) throw validationError("invalid_cloudflare_local_operation");
  const receipt = await localOperationReceipt(env, auth, operation as LocalOperation, key, now);
  if (!receipt) throw notFound(); return receipt;
}
export async function replayCloudflareLocalOperation(env: WorkerEnv, request: Request, auth: AuthContext, operation: LocalOperation, body: Resource, now: number): Promise<Resource | null> {
  requireOwnerControl(auth); await reauthenticateOwner(env.DB, request, Date.now());
  const receipt = await localOperationReceipt(env, auth, operation, requireIdempotencyKey(request), now, body);
  if (!receipt) return null;
  const { operation: _operation, request_hash: _hash, ...result } = receipt; return result;
}
const RETIRED_CAPABILITIES = { notifications: "unsupported_contract", billing: "unsupported_contract", waf: "unsupported_contract" };
async function capabilityIdentity(env: WorkerEnv): Promise<string> {
  // 仅用于持久快照失效，不进入响应或审计；Dashboard 更换 Secret 也会触发失效。
  return sha256Hex(canonicalJson({ domain: "cfkanban-control-capabilities-v1", configuration: tokenFor(env, "configuration") ?? null, analytics: tokenFor(env, "analytics") ?? null, account: env.CFKANBAN_CONTROL_ACCOUNT_ID ?? null, worker: env.CFKANBAN_CONTROL_WORKER_NAME ?? null, database: env.CFKANBAN_CONTROL_DATABASE_ID ?? null }));
}
export async function getCloudflareControl(env: WorkerEnv, auth: AuthContext): Promise<Resource> {
  requireOwnerControl(auth); const row = await settingsRow(env.DB), meta = await instance(env.DB);
  const stored = object(JSON.parse(row.capabilities_json) as JsonValue), current = stored.credential_identity === await capabilityIdentity(env);
  const capabilities = { configuration: current && typeof stored.configuration === "string" ? stored.configuration : tokenFor(env, "configuration") ? "unverified" : "missing", analytics: current && typeof stored.analytics === "string" ? stored.analytics : tokenFor(env, "analytics") ? "unverified" : "missing", ...RETIRED_CAPABILITIES };
  return { version: row.version, target: { account_id: env.CFKANBAN_CONTROL_ACCOUNT_ID ?? null, worker_name: env.CFKANBAN_CONTROL_WORKER_NAME ?? null, database_id: env.CFKANBAN_CONTROL_DATABASE_ID ?? null, zone_id: row.zone_id, hostname: new URL(meta.preferred_api_origin).hostname }, configured: { connection: Boolean(env.CFKANBAN_API_TOKEN), configuration: Boolean(tokenFor(env, "configuration")), control: Boolean(tokenFor(env, "control")), analytics: Boolean(tokenFor(env, "analytics")) }, capabilities, verified_at: !current || row.verified_at === null ? null : new Date(row.verified_at).toISOString(), budget: BUDGET, latest_operation: row.latest_operation_id ? operationResource(await operationRow(env.DB, row.latest_operation_id), row.version) : null, configuration: configurationValues(env) };
}
export async function updateCloudflareSettings(env: WorkerEnv, request: Request, auth: AuthContext, zoneId: JsonValue, expected: number, now: number): Promise<Resource> {
  const previous = await replayCloudflareLocalOperation(env, request, auth, "zone_settings", { zone_id: zoneId, expected_version: expected }, now);
  if (previous) return previous; throw validationError("cloudflare_feature_retired");
}
async function capability(probe: () => Promise<unknown>, present: boolean): Promise<Capability> { if (!present) return "missing"; try { await probe(); return "verified"; } catch (error) { return error instanceof ProviderFailure ? error.capability : "unavailable"; } }
async function probeAnalytics(env: WorkerEnv, token: string, now: number, dependencies: CloudflareControlDependencies): Promise<void> {
  const target = fixedTarget(env), result = object(await api(token, dependencies)("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query($account: string!, $database: string!, $date: Date!) { viewer { accounts(filter: {accountTag: $account}) { d1AnalyticsAdaptiveGroups(limit: 1, filter: {databaseId: $database, date_geq: $date, date_leq: $date}) { sum { rowsRead } } } } }", variables: { account: target.account_id, database: target.database_id, date: new Date(now).toISOString().slice(0, 10) } }) }));
  const accounts = list(object(result.viewer).accounts); if (accounts.length !== 1) throw new ProviderFailure("target_mismatch"); list(object(accounts[0]).d1AnalyticsAdaptiveGroups);
}
export async function verifyCloudflareControl(env: WorkerEnv, request: Request, auth: AuthContext, now: number, dependencies: CloudflareControlDependencies = {}, includeOptional = false): Promise<Resource> {
  requireOwnerControl(auth); fixedTarget(env); const configuration = tokenFor(env, "configuration"), analytics = tokenFor(env, "analytics"), row = await settingsRow(env.DB);
  const [configurationStatus, analyticsStatus] = await Promise.all([
    capability(() => baseline(env, configuration ?? "", dependencies), Boolean(configuration)),
    capability(() => probeAnalytics(env, analytics ?? "", now, dependencies), Boolean(analytics)),
  ]);
  const statuses: Resource = { configuration: configurationStatus, analytics: analyticsStatus, ...RETIRED_CAPABILITIES };
  const stored = { ...statuses, credential_identity: await capabilityIdentity(env) };
  // 并发设置或 Secret 变更会使这次能力快照失效。
  return localChange(env, request, auth, "/api/v1/admin/cloudflare/verify", includeOptional ? { include_optional: true } : {}, row.version, id => [env.DB.prepare("UPDATE cloudflare_control_settings SET capabilities_json=?2,verified_at=?3 WHERE singleton=1 AND last_operation_id=?1").bind(id, canonicalJson(stored), now)], async version => ({ ...await getCloudflareControl(env, auth), version, capabilities: statuses, verified_at: new Date(now).toISOString() }), now);
}
export async function getCloudflareNotifications(_env: WorkerEnv, auth: AuthContext, _dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); throw validationError("cloudflare_feature_retired");
}
export function ownedExpression(host: string): string {
  const paths = ["admin", "workspaces", "projects", "issues", "attachments", "comments", "labels", "relations", "events", "notifications", "search-index"];
  return `(http.host eq "${host}" and (${paths.map(name => `(http.request.uri.path eq "/api/v1/${name}" or starts_with(http.request.uri.path, "/api/v1/${name}/"))`).join(" or ")}) and not any(http.request.headers.names[*] eq "authorization") and not http.cookie contains "cfkanban_session=")`;
}
export async function getCloudflareWaf(env: WorkerEnv, auth: AuthContext, _dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); return readLocalWafStatus(env);
}
function configurationValues(env: WorkerEnv): Resource {
  return { history_enabled: env.USAGE_HISTORY_ENABLED === "true", analytics_enabled: env.USAGE_ANALYTICS_ENABLED === "true" || Boolean(usageAnalyticsConfig(env)), billing_plan: ["free", "paid"].includes(env.USAGE_BILLING_PLAN ?? "") ? env.USAGE_BILLING_PLAN ?? null : null, billing_cycle_day: /^([1-9]|[12][0-9]|3[01])$/.test(env.USAGE_BILLING_CYCLE_DAY ?? "") ? Number(env.USAGE_BILLING_CYCLE_DAY) : null, account_totals: env.USAGE_ACCOUNT_TOTALS_ENABLED === "true", warning_percent: /^([1-9]|[1-9][0-9]|100)$/.test(env.USAGE_WARNING_PERCENT ?? "") ? Number(env.USAGE_WARNING_PERCENT) : 80 };
}
function configurationInput(value: JsonValue): Resource {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw validationError("configuration_object_required");
  const input = object(value); for (const key of Object.keys(input)) if (!Object.hasOwn(CONFIG_VARS, key) && key !== "rate_limits") throw validationError("unknown_configuration_field");
  for (const key of ["history_enabled", "analytics_enabled", "account_totals"]) if (key in input && typeof input[key] !== "boolean") throw validationError("invalid_configuration_boolean");
  if ("billing_plan" in input && input.billing_plan !== null && input.billing_plan !== "free" && input.billing_plan !== "paid") throw validationError("invalid_billing_plan");
  for (const [key, max] of [["billing_cycle_day", 31], ["warning_percent", 100]] as const) if (key in input && !(key === "billing_cycle_day" && input[key] === null) && (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > max)) throw validationError("invalid_configuration_number");
  if ("rate_limits" in input) {
    const rates = input.rate_limits;
    if (rates === null || Array.isArray(rates) || typeof rates !== "object" || Object.keys(rates).length === 0) throw validationError("invalid_rate_limit_configuration");
    for (const [scope, rate] of Object.entries(rates)) {
      if (rate === null || Array.isArray(rate) || typeof rate !== "object" || Object.keys(rate).some(key => key !== "limit" && key !== "period_seconds")) throw validationError("invalid_rate_limit_configuration");
      validateRateLimit(scope, rate.limit ?? null, rate.period_seconds ?? null);
    }
  }
  return input;
}
export async function planCloudflareConfiguration(env: WorkerEnv, request: Request, auth: AuthContext, input: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  if (input !== null && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "warning_percent")) { requireOwnerControl(auth); throw validationError("cloudflare_feature_retired"); }
  return createPlan(env, request, auth, "configuration", configurationInput(input), expected, now, dependencies);
}
function validateRateLimit(scope: JsonValue, limit: JsonValue, period: JsonValue): void {
  if (typeof scope !== "string" || !Object.hasOwn(RATE_GROUPS, scope) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || (period !== 10 && period !== 60)) throw validationError("invalid_rate_limit_configuration");
}
export async function planCloudflareRateLimits(env: WorkerEnv, request: Request, auth: AuthContext, scope: JsonValue, limit: JsonValue, period: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  validateRateLimit(scope, limit, period);
  return createPlan(env, request, auth, "rate_limit", { scope, limit, period_seconds: period }, expected, now, dependencies);
}
function changedRateLimits(kind: ConfigurationPlanKind, desired: Resource): [RateScope, Resource][] {
  return kind === "rate_limit" ? [[desired.scope as RateScope, desired]] : Object.entries(desired.rate_limits === undefined ? {} : object(desired.rate_limits)).map(([scope, rate]) => [scope as RateScope, object(rate)]);
}
async function createPlan(env: WorkerEnv, request: Request, auth: AuthContext, kind: ConfigurationPlanKind, desired: Resource, expected: number, now: number, dependencies: CloudflareControlDependencies): Promise<Resource> {
  requireOwnerControl(auth); const token = tokenFor(env, "configuration"); if (!token) throw validationError("configuration_token_required");
  let live: LiveBaseline, before: Resource, after: Resource;
  const planId = crypto.randomUUID();
  return localChange(env, request, auth, `/api/v1/admin/cloudflare/${kind === "rate_limit" ? "rate-limits" : "configuration"}/plan`, { ...(kind === "configuration" ? { settings: desired } : desired), expected_version: expected }, expected,
    (id, version) => [env.DB.prepare(`INSERT INTO cloudflare_control_plans(id,kind,control_version,baseline_json,before_json,after_json,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?8`).bind(planId, kind, version, canonicalJson(live.baseline), canonicalJson(before), canonicalJson(after), now, id)],
    async version => planResource({ id: planId, kind, control_version: version, baseline_json: canonicalJson(live.baseline), before_json: canonicalJson(before), after_json: canonicalJson(after), created_at: now, consumed_operation_id: null }), now, async () => {
      // 仅拒绝新的空配置，原 key 仍能回放旧版本保存的计划快照。
      if (kind === "configuration" && Object.keys(desired).length === 0) throw validationError("empty_configuration_settings");
      live = await baseline(env, token, dependencies); before = desiredValues(kind, desired, live.bindings);
      after = kind === "configuration" ? { ...before, ...desired } : desired;
      patchSettings(live, kind, after, fixedTarget(env));
    });
}
function bindingText(bindings: Resource[], name: string): string | null { const binding = bindings.find(entry => entry.name === name); if (!binding) return null; if (binding.type !== "plain_text" || typeof binding.text !== "string") throw new ProviderFailure("target_mismatch", true); return binding.text; }
function desiredValues(kind: ConfigurationPlanKind, desired: Resource, bindings: Resource[]): Resource {
  if (kind === "rate_limit") { const group = RATE_GROUPS[desired.scope as keyof typeof RATE_GROUPS], binding = bindings.find(entry => entry.name === group[0]); if (!binding || binding.type !== "ratelimit") throw validationError("rate_limit_binding_missing"); const simple = object(binding.simple); return { scope: desired.scope ?? null, limit: simple.limit ?? null, period_seconds: simple.period ?? null }; }
  const values: Resource = {};
  for (const [key, name] of Object.entries(CONFIG_VARS)) { if (key === "warning_percent") continue; const value = bindingText(bindings, name); values[key] = value === null ? (["billing_plan", "billing_cycle_day"].includes(key) ? null : key === "warning_percent" ? 80 : false) : ["history_enabled", "analytics_enabled", "account_totals"].includes(key) ? value === "true" : ["billing_cycle_day", "warning_percent"].includes(key) ? Number(value) : value; }
  // Older deployments collect snapshots without an explicit enabled variable.
  // A partial settings change must preserve that effective enabled state.
  if (bindingText(bindings, CONFIG_VARS.analytics_enabled) === null) values.analytics_enabled = Boolean((bindingText(bindings, "USAGE_ACCOUNT_ID") || bindingText(bindings, "CFKANBAN_CONTROL_ACCOUNT_ID")) && (bindingText(bindings, "USAGE_D1_DATABASE_ID") || bindingText(bindings, "CFKANBAN_CONTROL_DATABASE_ID")) && bindings.some(binding => (binding.name === SECRET_NAMES.connection || binding.name === SECRET_NAMES.analytics) && binding.type === "secret_text"));
  if (desired.rate_limits !== undefined) values.rate_limits = Object.fromEntries(changedRateLimits(kind, desired).map(([scope]) => {
    const current = desiredValues("rate_limit", { scope }, bindings);
    return [scope, { limit: current.limit ?? null, period_seconds: current.period_seconds ?? null }];
  }));
  configurationInput(values); return values;
}
function patchSettings(live: LiveBaseline, kind: ConfigurationPlanKind, desired: Resource, target: Target): Resource {
  // A complete binding inventory is inherited from one explicit active version;
  // secret values never leave Cloudflare, and unknown top-level settings fail closed.
  const preserved = new Set(["bindings", "compatibility_date", "compatibility_flags", "usage_model", "limits", "logpush", "tail_consumers", "placement", "observability", "tags", "annotations", "cache_options", "exports_reconciliation"]);
  if (Object.keys(live.settings).some(key => !preserved.has(key))) throw validationError("cloudflare_settings_preservation_unverified");
  const changed = new Map<string, Resource>();
  for (const [scope, rate] of changedRateLimits(kind, desired)) {
    const group = RATE_GROUPS[scope], existing = live.bindings.find(entry => entry.name === group[0]);
    if (!existing || existing.type !== "ratelimit" || typeof existing.namespace_id !== "string" || !/^[1-9][0-9]*$/.test(existing.namespace_id)) throw validationError("rate_limit_namespace_unverified");
    const extra = Object.keys(existing).filter(key => !["name", "type", "namespace_id", "simple"].includes(key)); if (extra.length) throw validationError("rate_limit_binding_unverified");
    changed.set(group[0], { name: group[0], type: "ratelimit", namespace_id: existing.namespace_id, simple: { limit: rate.limit ?? null, period: rate.period_seconds ?? null } });
    changed.set(group[1], { name: group[1], type: "plain_text", text: String(rate.limit) }); changed.set(group[2], { name: group[2], type: "plain_text", text: String(rate.period_seconds) });
  }
  if (kind === "configuration") {
    for (const [key, name] of Object.entries(CONFIG_VARS)) if (desired[key] !== null && desired[key] !== undefined) changed.set(name, { name, type: "plain_text", text: String(desired[key]) });
    if (desired.analytics_enabled === true || desired.history_enabled === true) for (const [name, value] of [["USAGE_ACCOUNT_ID", target.account_id], ["USAGE_D1_DATABASE_ID", target.database_id], ["USAGE_WORKER_NAME", target.worker_name]]) changed.set(name as string, { name: name as string, type: "plain_text", text: value as string });
  }
  const removed = kind === "configuration" ? new Set(Object.entries(CONFIG_VARS).filter(([key]) => desired[key] === null).map(([, name]) => name)) : new Set<string>();
  const bindings: Resource[] = live.bindings.filter(entry => !removed.has(text(entry.name))).map(entry => changed.get(text(entry.name)) ?? { name: text(entry.name), type: "inherit", version_id: live.baseline.active_version_id });
  for (const [name, binding] of changed) if (!live.bindings.some(entry => entry.name === name)) bindings.push(binding);
  const { exports_reconciliation: _reconciliation, annotations, ...settings } = live.settings;
  // GET 将未启用的 placement 投影为 {}；PATCH 只接受有配置的对象。
  if (settings.placement !== null && typeof settings.placement === "object" && !Array.isArray(settings.placement) && !Object.keys(settings.placement).length) delete settings.placement;
  // These annotations describe the newly created version; triggered_by is server-only.
  const writableAnnotations = annotations === undefined ? undefined : Object.fromEntries(Object.entries(object(annotations)).filter(([name]) => name === "workers/message" || name === "workers/tag"));
  return { ...settings, ...(writableAnnotations ? { annotations: writableAnnotations } : {}), bindings };
}
export async function findDuplicate(env: WorkerEnv, request: Request, auth: AuthContext, requestHash: string, forbidden: string[] = [], noteExisting?: () => void): Promise<OperationRow | null> {
  const key = requireIdempotencyKey(request); validateIdempotencyKey(key, forbidden); const keyHash = await sha256Hex(key), route = new URL(request.url).pathname;
  const row = await env.DB.prepare("SELECT * FROM cloudflare_control_operations WHERE principal_id=?1 AND route=?2 AND key_hash=?3").bind(auth.principalId, route, keyHash).first<OperationRow>();
  if (row) noteExisting?.();
  if (row && row.request_hash !== requestHash) throw conflict("IDEMPOTENCY_CONFLICT"); return row;
}
export async function operationWriteResult(env: WorkerEnv, auth: AuthContext, row: OperationRow, replay: boolean): Promise<Resource> {
  const control = await settingsRow(env.DB), commit = await probeOperationCommit(env.DB, control.latest_operation_id === row.id && control.last_operation_id ? control.last_operation_id : row.id); if (!commit) throw platformUnavailable("d1"); return writeResult(env.DB, auth, operationResource(row, control.version), commit.lastEventSequence, replay);
}
export async function intent(env: WorkerEnv, request: Request, auth: AuthContext, kind: string, requestHash: string, live: { baseline: Resource }, desired: Resource, secretHash: string | null, expected: number, now: number, planId: string | null): Promise<OperationRow> {
  const db = env.DB, id = crypto.randomUUID(), meta = await instance(db), keyHash = await sha256Hex(requireIdempotencyKey(request)); await reauthenticateOwner(db, request, Date.now());
  const row = await settingsRow(db); if (row.version !== expected) throw versionConflict(row.version); if (row.locked_operation_id) throw conflict("VERSION_CONFLICT", "refresh_resource", { reason: "cloudflare_operation_pending" });
  const guard = buildCurrentAuthGuard(auth, Date.now(), 3, true);
  try { await executeAtomicBatch(db, { operationId: id, primarySubjectId: meta.instance_id, primarySubjectType: "instance", committedAt: now, expectedEventCount: 1,
    businessStatements: [db.prepare(`UPDATE cloudflare_control_settings SET version=version+1,latest_operation_id=?1,locked_operation_id=?1,last_operation_id=?1,capabilities_json='{}',verified_at=NULL WHERE singleton=1 AND version=?2 AND locked_operation_id IS NULL AND ${guard.sql}`).bind(id, expected, ...guard.values),
      db.prepare(`INSERT INTO cloudflare_control_operations(id,principal_id,route,key_hash,request_hash,kind,status,baseline_json,desired_json,secret_value_hash,created_at,updated_at) SELECT ?1,?2,?3,?4,?5,?6,'pending',?7,?8,?9,?10,?10 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?1`).bind(id, auth.principalId, new URL(request.url).pathname, keyHash, requestHash, kind, canonicalJson(live.baseline), canonicalJson(desired), secretHash, now),
      ...(planId ? [db.prepare("UPDATE cloudflare_control_plans SET consumed_operation_id=?1 WHERE id=?2 AND consumed_operation_id IS NULL AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE last_operation_id=?1)").bind(id, planId)] : []), event(db, auth, crypto.randomUUID(), id, meta.instance_id, now, "instance.cloudflare-control-intent")],
    confirmBusinessRejection: async () => { await reauthenticateOwner(db, request, Date.now()); return (await settingsRow(db)).version !== expected; } }); }
  catch (error) { const duplicate = await findDuplicate(env, request, auth, requestHash); if (duplicate) return duplicate; if (error instanceof AtomicBatchRejectedError) throw versionConflict((await settingsRow(db)).version); throw error; }
  return operationRow(db, id);
}
export async function transition(env: WorkerEnv, request: Request, auth: AuthContext, row: OperationRow, status: Status, failure: string | null, versionId: string | null, deploymentId: string | null, dispatch = false, commandId?: string, wafOwnership?: Resource): Promise<boolean> {
  const db = env.DB, eventOperation = commandId ?? crypto.randomUUID(), meta = await instance(db), now = Date.now(); await reauthenticateOwner(db, request, now);
  const control = await settingsRow(db), guard = buildCurrentAuthGuard(auth, now, 6, true);
  try { await executeAtomicBatch(db, { operationId: eventOperation, primarySubjectId: meta.instance_id, primarySubjectType: "instance", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: commandId !== undefined,
    businessStatements: [db.prepare(`UPDATE cloudflare_control_settings SET version=version+1,last_operation_id=?1,locked_operation_id=CASE WHEN ?2 IN ('verified','failed') THEN NULL ELSE locked_operation_id END WHERE singleton=1 AND (locked_operation_id=?3 ${commandId ? "OR locked_operation_id IS NULL" : ""}) AND version=?5 AND EXISTS(SELECT 1 FROM cloudflare_control_operations WHERE id=?3 AND status IN ('pending','unknown'${commandId ? ",'verified','failed'" : ""}) AND updated_at=?4 ${dispatch || row.dispatched_at === null ? "AND dispatched_at IS NULL" : "AND dispatched_at IS NOT NULL"}) AND ${guard.sql}${row.kind === "waf" && dispatch ? ` AND EXISTS(
        SELECT 1 FROM cloudflare_waf_target_binding binding
        JOIN instance_origin_settings origin ON origin.singleton=binding.singleton
        JOIN instance_meta meta ON meta.singleton=binding.singleton
        JOIN cloudflare_control_operations operation ON operation.id=?3
        WHERE binding.binding_id=json_extract(operation.baseline_json,'$.binding_id')
          AND binding.zone_id=cloudflare_control_settings.zone_id
          AND binding.account_id=json_extract(operation.baseline_json,'$.target.account_id')
          AND binding.worker_name=json_extract(operation.baseline_json,'$.target.worker_name')
          AND binding.database_id=json_extract(operation.baseline_json,'$.target.database_id')
          AND binding.domain_id=json_extract(operation.baseline_json,'$.target.domain_id')
          AND binding.provider_metadata_hash=json_extract(operation.baseline_json,'$.provider_metadata_hash')
          AND meta.instance_id=binding.instance_id
          AND binding.hostname=json_extract(operation.baseline_json,'$.target.hostname')
          AND binding.origin_version=origin.version
          AND origin.version=json_extract(operation.baseline_json,'$.origin_version')
          AND origin.preferred_api_origin='https://' || binding.hostname
      )` : ""}`).bind(eventOperation, status, row.id, row.updated_at, control.version, ...guard.values),
      db.prepare(`UPDATE cloudflare_control_operations SET status=?2,failure_class=?3,result_version_id=?4,deployment_id=?5,updated_at=?6${dispatch ? ",dispatched_at=?6" : ""} WHERE id=?1 AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE last_operation_id=?7)`).bind(row.id, status, failure, versionId, deploymentId, now, eventOperation),
      ...(wafOwnership ? [db.prepare(`UPDATE cloudflare_waf_ownership SET rule_id=?2,ruleset_id=?3,rule_ref=?4,rule_digest=?5,operation_id=?6,verified_at=?7,binding_id=?8 WHERE singleton=1 AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE last_operation_id=?1)`).bind(eventOperation, wafOwnership.rule_id ?? null, wafOwnership.ruleset_id ?? null, wafOwnership.rule_ref ?? null, wafOwnership.rule_digest ?? null, row.id, now, wafOwnership.binding_id ?? null)] : []),
      ...(commandId ? [db.prepare("UPDATE idempotency_records SET operation_snapshot_json=?2 WHERE operation_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE last_operation_id=?1)").bind(eventOperation, canonicalJson(operationResource({ ...row, status, failure_class: failure, result_version_id: versionId, deployment_id: deploymentId, updated_at: now }, control.version + 1)))] : []),
      event(db, auth, crypto.randomUUID(), eventOperation, meta.instance_id, now, dispatch ? "instance.cloudflare-control-dispatched" : "instance.cloudflare-control-result")],
    confirmBusinessRejection: async () => { await reauthenticateOwner(db, request, Date.now());
      if (dispatch && row.kind === "waf") { const frozen = object(JSON.parse(row.baseline_json) as JsonValue), target = object(frozen.target), proof = await db.prepare("SELECT binding.binding_id,binding.zone_id,binding.hostname,binding.provider_metadata_hash,origin.version,origin.preferred_api_origin FROM cloudflare_waf_target_binding binding JOIN instance_origin_settings origin ON origin.singleton=binding.singleton WHERE binding.singleton=1").first<{ binding_id: string; zone_id: string; hostname: string; provider_metadata_hash: string; version: number; preferred_api_origin: string }>(); if (!proof || proof.binding_id !== frozen.binding_id || proof.zone_id !== target.zone_id || proof.hostname !== target.hostname || proof.version !== frozen.origin_version || proof.provider_metadata_hash !== frozen.provider_metadata_hash || proof.preferred_api_origin !== `https://${target.hostname}`) return true; }
      const current = await operationRow(db, row.id); return current.updated_at !== row.updated_at || (dispatch && current.dispatched_at !== null) || (await settingsRow(db)).version !== control.version || (await settingsRow(db)).locked_operation_id !== row.id; } }); return true;
  } catch (error) { if (error instanceof AtomicBatchRejectedError) return false; throw error; }
}
export async function saveCloudflareSecret(env: WorkerEnv, request: Request, auth: AuthContext, kindValue: JsonValue, tokenValue: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); if (typeof kindValue !== "string" || !Object.hasOwn(SECRET_NAMES, kindValue) || typeof tokenValue !== "string" || !/^[\x21-\x7e]{32,4096}$/.test(tokenValue)) throw validationError("invalid_cloudflare_secret");
  const kind = kindValue as SecretKind, tokenHash = await sha256Hex(tokenValue), requestHash = await sha256Hex(canonicalJson({ kind, expected_version: expected, value_digest: tokenHash }));
  await reauthenticateOwner(env.DB, request, Date.now()); const duplicate = await findDuplicate(env, request, auth, requestHash, [tokenValue]); if (duplicate) return operationWriteResult(env, auth, duplicate, true);
  const writer = kind === "connection" || kind === "configuration" ? tokenValue : tokenFor(env, "configuration"); if (!writer) throw validationError("configuration_token_required");
  let live: LiveBaseline;
  try { live = await baseline(env, writer, dependencies); }
  catch (error) {
    // 本次请求尚未登记 intent 或进入外部写入；后续错误仍保留未知结果合同。
    if (!(error instanceof ApiError)) throw error;
    const failure = error;
    throw new ApiError({ code: failure.code, category: failure.category, source: failure.source, message: failure.message, recovery: failure.recovery, retryable: failure.retryable, status: failure.status, clearSessionCookies: failure.clearSessionCookies, ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }), details: { ...failure.details, write_state: "not_dispatched" } });
  }
  const row = await intent(env, request, auth, secretOperationKind(kind), requestHash, live, { secret_kind: kind, secret_name: SECRET_NAMES[kind] }, tokenHash, expected, now, null);
  if (row.dispatched_at !== null || row.status !== "pending") return operationWriteResult(env, auth, row, true);
  try { if (canonicalJson((await baseline(env, writer, dependencies)).baseline) !== row.baseline_json) throw validationError("cloudflare_baseline_changed"); }
  catch { await transition(env, request, auth, row, "failed", "preflight_changed", null, null); return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false); }
  if (!(await transition(env, request, auth, row, "pending", null, null, null, true))) return operationWriteResult(env, auth, await operationRow(env.DB, row.id), true);
  await completeCloudMutation(env, request, auth, row.id, dependencies, writer, () => api(writer, dependencies)(`${scriptPath(fixedTarget(env))}/secrets`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: SECRET_NAMES[kind], text: tokenValue, type: "secret_text" }) }));
  return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false);
}
export async function applyCloudflarePlan(env: WorkerEnv, request: Request, auth: AuthContext, kind: ConfigurationPlanKind, planId: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); if (typeof planId !== "string" || !isUuid(planId)) throw validationError("invalid_cloudflare_plan");
  const requestHash = await sha256Hex(canonicalJson({ plan_id: planId, expected_version: expected })); await reauthenticateOwner(env.DB, request, Date.now()); const duplicate = await findDuplicate(env, request, auth, requestHash); if (duplicate) return operationWriteResult(env, auth, duplicate, true);
  const plan = await env.DB.prepare("SELECT * FROM cloudflare_control_plans WHERE id=?1").bind(planId).first<PlanRow>(); if (!plan || plan.kind !== kind) throw notFound(); if (plan.consumed_operation_id || plan.control_version !== expected) throw versionConflict((await settingsRow(env.DB)).version);
  const token = tokenFor(env, "configuration"); if (!token) throw validationError("configuration_token_required"); const live = await baseline(env, token, dependencies);
  if (canonicalJson(live.baseline) !== plan.baseline_json) throw validationError("cloudflare_baseline_changed"); const desired = object(JSON.parse(plan.after_json) as JsonValue), settings = patchSettings(live, kind, desired, fixedTarget(env));
  const row = await intent(env, request, auth, kind, requestHash, live, desired, null, expected, now, planId);
  if (row.dispatched_at !== null || row.status !== "pending") return operationWriteResult(env, auth, row, true);
  try { if (canonicalJson((await baseline(env, token, dependencies)).baseline) !== row.baseline_json) throw validationError("cloudflare_baseline_changed"); }
  catch { await transition(env, request, auth, row, "failed", "preflight_changed", null, null); return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false); }
  if (!(await transition(env, request, auth, row, "pending", null, null, null, true))) return operationWriteResult(env, auth, await operationRow(env.DB, row.id), true);
  await completeCloudMutation(env, request, auth, row.id, dependencies, token, async () => { const form = new FormData(); form.append("settings", new File([JSON.stringify(settings)], "settings", { type: "application/json" })); return api(token, dependencies)(`${scriptPath(fixedTarget(env))}/settings`, { method: "PATCH", body: form }); });
  return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false);
}
export async function getCloudflareOperation(env: WorkerEnv, auth: AuthContext, id: string): Promise<Resource> { requireOwnerControl(auth); return operationResource(await operationRow(env.DB, id), (await settingsRow(env.DB)).version); }
export async function getCloudflareSecretOperation(env: WorkerEnv, auth: AuthContext, requestKey: string): Promise<Resource> {
  requireOwnerControl(auth); validateIdempotencyKey(requestKey);
  const row = await env.DB.prepare("SELECT * FROM cloudflare_control_operations WHERE principal_id=?1 AND route=?2 AND key_hash=?3").bind(auth.principalId, "/api/v1/admin/cloudflare/secrets", await sha256Hex(requestKey)).first<OperationRow>();
  if (!row) throw notFound();
  return operationResource(row, (await settingsRow(env.DB)).version);
}
export async function getCloudflareConfigurationOperation(env: WorkerEnv, auth: AuthContext, requestKey: string): Promise<Resource> {
  requireOwnerControl(auth); validateIdempotencyKey(requestKey);
  const row = await env.DB.prepare("SELECT * FROM cloudflare_control_operations WHERE principal_id=?1 AND route=?2 AND key_hash=?3 AND kind='configuration'").bind(auth.principalId, "/api/v1/admin/cloudflare/configuration/apply", await sha256Hex(requestKey)).first<OperationRow>();
  if (!row) throw notFound();
  return operationResource(row, (await settingsRow(env.DB)).version);
}
export async function getCloudflarePlan(env: WorkerEnv, auth: AuthContext, id: string): Promise<Resource> { requireOwnerControl(auth); if (!isUuid(id)) throw notFound(); const row = await env.DB.prepare("SELECT * FROM cloudflare_control_plans WHERE id=?1").bind(id).first<PlanRow>(); if (!row) throw notFound(); return planResource(row); }
export type Assessment = [Status, string | null, string | null, string | null];
async function completeCloudMutation(env: WorkerEnv, request: Request, auth: AuthContext, id: string, dependencies: CloudflareControlDependencies, token: string, mutate: () => Promise<JsonValue>): Promise<void> {
  try { await mutate(); }
  catch (error) { await transition(env, request, auth, await operationRow(env.DB, id), error instanceof ProviderFailure && error.rejected ? "failed" : "unknown", error instanceof ProviderFailure ? error.capability : "unavailable", null, null); return; }
  // The mutation was accepted. A later read failure cannot prove it did not
  // happen, including an authorization failure of the readback credential.
  try { await verifyOperationInternal(env, request, auth, await operationRow(env.DB, id), dependencies, token); }
  catch (error) { const row = await operationRow(env.DB, id); await transition(env, request, auth, row, "unknown", error instanceof ProviderFailure ? error.capability : "unavailable", row.result_version_id, row.deployment_id); }
}
function orderedBindingFingerprints(value: JsonValue | undefined): Resource[] { return list(value).map(object).sort((a, b) => text(a.name).localeCompare(text(b.name))); }
async function planBindingsMatch(live: LiveBaseline, before: Resource, kind: ConfigurationPlanKind, desired: Resource, target: Target, writer: string, dependencies: CloudflareControlDependencies): Promise<boolean> {
  // Existing intents only retain binding fingerprints. Recover the frozen
  // inventory to prove preserved namespaces and materialize inherited bindings.
  const versionId = text(before.active_version_id), version = object(await api(writer, dependencies)(`${scriptPath(target)}/versions/${encodeURIComponent(versionId)}`));
  const bindings = list(object(version.resources).bindings).map(object);
  const fingerprints = async (inventory: Resource[]) => orderedBindingFingerprints(await Promise.all(inventory.map(async binding => ({ name: text(binding.name), type: text(binding.type), hash: await sha256Hex(canonicalJson(binding)) }))));
  if (canonicalJson(await fingerprints(bindings)) !== canonicalJson(orderedBindingFingerprints(before.binding_fingerprints))) throw new ProviderFailure("target_mismatch");
  const original = new Map(bindings.map(binding => [text(binding.name), binding]));
  const settings = patchSettings({ ...live, bindings, baseline: { ...live.baseline, active_version_id: versionId } }, kind, desired, target);
  const expected = list(settings.bindings).map(object).map(binding => binding.type === "inherit" ? original.get(text(binding.name))! : binding);
  return canonicalJson(await fingerprints(expected)) === canonicalJson(orderedBindingFingerprints(live.baseline.binding_fingerprints));
}
async function assessOperation(env: WorkerEnv, row: OperationRow, dependencies: CloudflareControlDependencies, token?: string): Promise<Assessment> {
  if (row.status === "verified" || row.status === "failed") return [row.status, row.failure_class, row.result_version_id, row.deployment_id];
  if (row.dispatched_at === null) return ["failed", "not_dispatched", null, null];
  if (row.kind === "waf") return assessWafOperation(env, row, dependencies);
  const writer = token ?? tokenFor(env, "configuration"); if (!writer) throw new ProviderFailure("missing"); const live = await baseline(env, writer, dependencies, true), before = object(JSON.parse(row.baseline_json) as JsonValue), desired = object(JSON.parse(row.desired_json) as JsonValue);
  if (canonicalJson(live.baseline.target) !== canonicalJson(object(before.target))) return ["unknown", "target_mismatch", row.result_version_id, live.baseline.deployment_id];
  if (live.baseline.etag !== before.etag) return ["unknown", "cloudflare_code_drift", live.baseline.active_version_id, live.baseline.deployment_id];
  if (row.result_version_id && live.baseline.active_version_id !== row.result_version_id && live.baseline.latest_version_id !== row.result_version_id) return ["unknown", "cloudflare_version_drift", row.result_version_id, live.baseline.deployment_id];
  if (live.baseline.active_version_id === before.active_version_id) return ["pending", "deployment_not_active", live.baseline.latest_version_id === before.active_version_id ? null : live.baseline.latest_version_id, live.baseline.deployment_id];
  if (row.result_version_id && live.baseline.active_version_id !== row.result_version_id) return ["unknown", "cloudflare_version_drift", row.result_version_id, live.baseline.deployment_id];
  const secretName = row.kind.endsWith("_secret") ? operationSecretName(row, desired) : null;
  const changedNames = secretName ? new Set([secretName]) : new Set([
    ...(row.kind === "configuration" ? [...Object.values(CONFIG_VARS), "USAGE_ACCOUNT_ID", "USAGE_D1_DATABASE_ID", "USAGE_WORKER_NAME"] : []),
    ...changedRateLimits(row.kind as ConfigurationPlanKind, desired).flatMap(([scope]) => RATE_GROUPS[scope]),
  ]);
  const unchanged = (value: JsonValue | undefined) => list(value).map(object).filter(binding => !changedNames.has(text(binding.name))).sort((a, b) => text(a.name).localeCompare(text(b.name)));
  if (before.metadata_hash !== live.baseline.metadata_hash || canonicalJson(unchanged(before.binding_fingerprints)) !== canonicalJson(unchanged(live.baseline.binding_fingerprints))) return ["unknown", "cloudflare_foreign_configuration_drift", row.result_version_id, live.baseline.deployment_id];
  let matches = false;
  if (secretName) { const current = env[secretName]; matches = Boolean(current && live.bindings.some(binding => binding.name === secretName && binding.type === "secret_text") && row.secret_value_hash === await sha256Hex(current)); }
  else { const kind = row.kind as ConfigurationPlanKind; matches = await planBindingsMatch(live, before, kind, desired, fixedTarget(env), writer, dependencies); }
  return [matches ? "verified" : "unknown", matches ? null : row.kind.endsWith("_secret") ? "secret_readback_pending" : "configuration_readback_mismatch", matches || secretName ? live.baseline.active_version_id : row.result_version_id, live.baseline.deployment_id];
}
async function verifyOperationInternal(env: WorkerEnv, request: Request, auth: AuthContext, row: OperationRow, dependencies: CloudflareControlDependencies, token?: string): Promise<void> {
  if (row.status === "verified" || row.status === "failed") return;
  const assessed = await assessOperation(env, row, dependencies, token); await transition(env, request, auth, row, ...assessed);
}
export async function verifyCloudflareOperation(env: WorkerEnv, request: Request, auth: AuthContext, id: string, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); const db = env.DB, authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const result = await runIdempotentOperation({ db, now, method: "POST", routeTemplate: "/api/v1/admin/cloudflare/operations/{operation_id}/verify", scopeKey: `principal:${auth.principalId}`, normalizedResourceScope: `cloudflare-operation:${id}`, requestBody: {}, idempotencyKey: requireIdempotencyKey(request), authorize,
    execute: async commandId => { const row = await operationRow(db, id); if (row.kind === "waf") { try { if (!(await verifyWafResult(env, request, auth, row, dependencies, commandId))) throw versionConflict((await settingsRow(db)).version); } catch (error) { if (!(error instanceof ProviderFailure)) throw error; if (!(await transition(env, request, auth, row, "unknown", error.capability, row.result_version_id, null, false, commandId))) throw versionConflict((await settingsRow(db)).version); } return; } let assessed: Assessment; try { assessed = await assessOperation(env, row, dependencies); } catch (error) { if (!(error instanceof ProviderFailure)) throw error; assessed = ["unknown", error.capability, row.result_version_id, row.deployment_id]; } if (!(await transition(env, request, auth, row, ...assessed, false, commandId))) throw versionConflict((await settingsRow(db)).version); },
    readback: async (commandId, commit) => ({ body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, commandId), commit.lastEventSequence, false), status: 200 }) });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
