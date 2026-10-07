import { buildCurrentAuthGuard, reauthenticateOwner, requireOwnerControl } from "../kernel/authorization.ts";
import { isUuid, sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, probeOperationCommit } from "../kernel/d1.ts";
import { ApiError, conflict, notFound, platformUnavailable, validationError, versionConflict } from "../kernel/errors.ts";
import { canonicalJson, readOperationSnapshot, runIdempotentOperation, validateIdempotencyKey } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue, WorkerEnv } from "../kernel/types.ts";
import { actorCredentialId, requireIdempotencyKey, writeResult } from "./shared.ts";

type Resource = { [key: string]: JsonValue };
type Capability = "missing" | "unverified" | "verified" | "permission_denied" | "unavailable" | "target_mismatch" | "unsupported_contract";
type Status = "pending" | "verified" | "failed" | "unknown";
type SecretKind = "connection" | "configuration" | "control" | "analytics";
type PlanKind = "configuration" | "rate_limit";
type ProviderOperation = "deployments" | "versions" | "settings" | "version_details" | "secret_write" | "notifications" | "billing" | "waf" | "zone" | "graphql";
interface ProviderDiagnostics { provider_operation?: ProviderOperation; provider_method?: "GET" | "PUT" | "POST" | "PATCH" | "DELETE"; provider_status?: number }
export interface CloudflareControlDependencies { fetch?: typeof fetch }
interface SettingsRow { version: number; zone_id: string | null; capabilities_json: string; verified_at: number | null; latest_operation_id: string | null; locked_operation_id: string | null; last_operation_id: string | null }
interface OperationRow { id: string; principal_id: string; route: string; request_hash: string; kind: string; status: Status; baseline_json: string; desired_json: string; secret_value_hash: string | null; dispatched_at: number | null; result_version_id: string | null; deployment_id: string | null; failure_class: string | null; created_at: number; updated_at: number }
interface PlanRow { id: string; kind: PlanKind; control_version: number; baseline_json: string; before_json: string; after_json: string; created_at: number; consumed_operation_id: string | null }
interface Target { account_id: string; worker_name: string; database_id: string }
interface Baseline extends Resource { active_version_id: string; latest_version_id: string; deployment_id: string; etag: string; settings_hash: string; target: Resource }
interface LiveBaseline { baseline: Baseline; settings: Resource; bindings: Resource[] }
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
const CONFIG_VARS = { history_enabled: "USAGE_HISTORY_ENABLED", analytics_enabled: "USAGE_ANALYTICS_ENABLED", billing_plan: "USAGE_BILLING_PLAN", billing_cycle_day: "USAGE_BILLING_CYCLE_DAY", account_totals: "USAGE_ACCOUNT_TOTALS_ENABLED", warning_percent: "USAGE_WARNING_PERCENT" } as const;
const BUDGET = { status: "unsupported_contract", docs_url: "https://developers.cloudflare.com/billing/manage/budget-alerts/", dashboard_url: "https://dash.cloudflare.com/?to=/:account/billing/billable-usage" };

class ProviderFailure extends ApiError {
  readonly capability: Capability;
  readonly rejected: boolean;
  readonly missingResource: boolean;
  constructor(capability: Capability, rejected = false, missingResource = false, diagnostics: ProviderDiagnostics = {}) {
    super({ code: capability === "permission_denied" ? "FORBIDDEN" : capability === "target_mismatch" ? "VERSION_CONFLICT" : "PLATFORM_UNAVAILABLE", category: capability === "permission_denied" ? "authorization" : capability === "target_mismatch" ? "conflict" : "platform_failure", source: "cloudflare_platform", message: "Cloudflare control request could not be verified.", recovery: "request_owner", retryable: false, status: capability === "permission_denied" ? 403 : capability === "target_mismatch" ? 409 : 503, details: { component: "cloudflare-control", failure_class: capability, ...diagnostics } });
    this.capability = capability; this.rejected = rejected; this.missingResource = missingResource;
  }
}
function object(value: JsonValue | undefined): Resource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProviderFailure("unavailable");
  return value;
}
function list(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value) || value.length > 500) throw new ProviderFailure("unavailable");
  return value;
}
function text(value: JsonValue | undefined, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new ProviderFailure("unavailable");
  return value;
}
function fixedTarget(env: WorkerEnv): Target {
  const account = env.CFKANBAN_CONTROL_ACCOUNT_ID, worker = env.CFKANBAN_CONTROL_WORKER_NAME, database = env.CFKANBAN_CONTROL_DATABASE_ID;
  if (!account || !/^[a-zA-Z0-9_-]{1,128}$/.test(account) || !worker || !/^[a-zA-Z0-9_-]{1,63}$/.test(worker) || !database || !isUuid(database)) throw validationError("cloudflare_target_not_configured");
  return { account_id: account, worker_name: worker, database_id: database };
}
function targetResource(target: Target): Resource { return { ...target }; }
function tokenFor(env: WorkerEnv, kind: SecretKind): string | undefined { return env.CFKANBAN_API_TOKEN ?? env[SECRET_NAMES[kind]]; }
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
function api(token: string, dependencies: CloudflareControlDependencies) {
  return async (path: string, init: RequestInit = {}): Promise<JsonValue> => {
    if (!path.startsWith("/accounts/") && !path.startsWith("/zones/") && path !== "/graphql") throw new ProviderFailure("target_mismatch", true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (dependencies.fetch ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) }, redirect: "manual", signal: controller.signal });
      const diagnostics = providerDiagnostics(path, init.method ?? "GET", response.status);
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ProviderFailure("permission_denied", true, false, diagnostics); }
      if (response.status === 404) { await response.body?.cancel(); throw new ProviderFailure("unavailable", true, true, diagnostics); }
      if (!response.ok) { await response.body?.cancel(); throw new ProviderFailure("unavailable", response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429, false, diagnostics); }
      const reader = response.body?.getReader(); if (!reader) throw new ProviderFailure("unavailable");
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 65_536) { await reader.cancel(); throw new ProviderFailure("unavailable"); } chunks.push(chunk.value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const envelope = object(JSON.parse(new TextDecoder().decode(bytes)) as JsonValue);
      if (path === "/graphql") { if (envelope.errors !== undefined && envelope.errors !== null && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)) throw new ProviderFailure("permission_denied"); return envelope.data ?? null; }
      if (envelope.success !== true) throw new ProviderFailure("unavailable");
      if (envelope.result_info) { const info = object(envelope.result_info); if (typeof info.total_pages === "number" && info.total_pages > 1 && !path.endsWith("/versions")) throw new ProviderFailure("unavailable"); }
      return envelope.result ?? null;
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure("unavailable"); }
    finally { clearTimeout(timer); }
  };
}
async function baseline(env: WorkerEnv, token: string, dependencies: CloudflareControlDependencies, allowPending = false): Promise<LiveBaseline> {
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
async function settingsRow(db: D1Database): Promise<SettingsRow> { const row = await db.prepare("SELECT * FROM cloudflare_control_settings WHERE singleton=1").first<SettingsRow>(); if (!row) throw platformUnavailable("d1"); return row; }
async function operationRow(db: D1Database, id: string): Promise<OperationRow> { if (!isUuid(id)) throw notFound(); const row = await db.prepare("SELECT * FROM cloudflare_control_operations WHERE id=?1").bind(id).first<OperationRow>(); if (!row) throw notFound(); return row; }
async function instance(db: D1Database) { const row = await db.prepare("SELECT m.instance_id,o.preferred_api_origin FROM instance_meta m JOIN instance_origin_settings o ON o.singleton=m.singleton WHERE m.singleton=1").first<{ instance_id: string; preferred_api_origin: string }>(); if (!row) throw platformUnavailable("d1"); return row; }
function operationResource(row: OperationRow, version: number): Resource { const base = object(JSON.parse(row.baseline_json) as JsonValue); return { operation_id: row.id, kind: row.kind, status: row.status, version, baseline_version_id: base.active_version_id ?? null, result_version_id: row.result_version_id, deployment_id: row.deployment_id, failure_class: row.failure_class, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() }; }
function planResource(row: PlanRow): Resource { const base = object(JSON.parse(row.baseline_json) as JsonValue); return { plan_id: row.id, kind: row.kind, version: row.control_version, baseline_version_id: base.active_version_id ?? null, baseline_deployment_id: base.deployment_id ?? null, target: base.target ?? null, before: JSON.parse(row.before_json) as JsonValue, after: JSON.parse(row.after_json) as JsonValue, created_at: new Date(row.created_at).toISOString() }; }
function event(db: D1Database, auth: AuthContext, eventId: string, operationId: string, instanceId: string, now: number, type: string) {
  return db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at)
    SELECT ?1,'security',?2,?3,0,?4,?5,'deployment_owner','instance',?6,json_object('version',version,'operation_id',latest_operation_id),?7
    FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?3`).bind(eventId, type, operationId, auth.principalId, actorCredentialId(auth), instanceId, now);
}
async function localChange(env: WorkerEnv, request: Request, auth: AuthContext, route: string, body: Resource, expected: number | null, mutation: (operationId: string, version: number) => D1PreparedStatement[], snapshot: (version: number) => Promise<Resource>, now: number, prepare?: () => Promise<void>): Promise<Resource> {
  requireOwnerControl(auth); const db = env.DB, authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const result = await runIdempotentOperation({ db, now, method: request.method, routeTemplate: route, scopeKey: `principal:${auth.principalId}`, normalizedResourceScope: "instance-cloudflare-control", requestBody: body, idempotencyKey: requireIdempotencyKey(request), authorize,
    execute: async operationId => {
      await authorize(); const row = await settingsRow(db); if (expected !== null && row.version !== expected) throw versionConflict(row.version); if (row.locked_operation_id) throw conflict("VERSION_CONFLICT", "refresh_resource", { reason: "cloudflare_operation_pending" });
      await prepare?.(); await authorize();
      const guard = buildCurrentAuthGuard(auth, Date.now(), 3, true), meta = await instance(db);
      await executeAtomicBatch(db, { operationId, primarySubjectId: meta.instance_id, primarySubjectType: "instance", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: true,
        businessStatements: [db.prepare(`UPDATE cloudflare_control_settings SET version=version+1,last_operation_id=?1 WHERE singleton=1 AND version=?2 AND locked_operation_id IS NULL AND ${guard.sql}`).bind(operationId, row.version, ...guard.values), ...mutation(operationId, row.version + 1),
          db.prepare("UPDATE idempotency_records SET operation_snapshot_json=?2 WHERE operation_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?1)").bind(operationId, canonicalJson(await snapshot(row.version + 1))),
          event(db, auth, crypto.randomUUID(), operationId, meta.instance_id, now, "instance.cloudflare-control-updated")],
        confirmBusinessRejection: async () => { await authorize(); return (await settingsRow(db)).version !== row.version; } });
    },
    readback: async (id, commit) => ({ body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, id), commit.lastEventSequence, false), status: 200 }) });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
export async function getCloudflareControl(env: WorkerEnv, auth: AuthContext): Promise<Resource> {
  requireOwnerControl(auth); const row = await settingsRow(env.DB), meta = await instance(env.DB);
  const capabilities = { configuration: tokenFor(env, "configuration") ? "unverified" : "missing", notifications: tokenFor(env, "control") ? "unverified" : "missing", waf: tokenFor(env, "control") ? "unverified" : "missing", billing: tokenFor(env, "control") ? "unverified" : "missing", analytics: tokenFor(env, "analytics") ? "unverified" : "missing", ...object(JSON.parse(row.capabilities_json) as JsonValue) };
  return { version: row.version, target: { account_id: env.CFKANBAN_CONTROL_ACCOUNT_ID ?? null, worker_name: env.CFKANBAN_CONTROL_WORKER_NAME ?? null, database_id: env.CFKANBAN_CONTROL_DATABASE_ID ?? null, zone_id: row.zone_id, hostname: new URL(meta.preferred_api_origin).hostname }, configured: { connection: Boolean(env.CFKANBAN_API_TOKEN), configuration: Boolean(tokenFor(env, "configuration")), control: Boolean(tokenFor(env, "control")), analytics: Boolean(tokenFor(env, "analytics")) }, capabilities, verified_at: row.verified_at === null ? null : new Date(row.verified_at).toISOString(), budget: BUDGET, latest_operation: row.latest_operation_id ? operationResource(await operationRow(env.DB, row.latest_operation_id), row.version) : null, configuration: configurationValues(env) };
}
export async function updateCloudflareSettings(env: WorkerEnv, request: Request, auth: AuthContext, zoneId: JsonValue, expected: number, now: number): Promise<Resource> {
  if (zoneId !== null && (typeof zoneId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(zoneId))) throw validationError("invalid_zone_id");
  return localChange(env, request, auth, "/api/v1/admin/cloudflare/settings", { zone_id: zoneId, expected_version: expected }, expected, id => [env.DB.prepare("UPDATE cloudflare_control_settings SET zone_id=?2,capabilities_json='{}',verified_at=NULL WHERE singleton=1 AND last_operation_id=?1").bind(id, zoneId)], async version => { const resource = await getCloudflareControl(env, auth); return { ...resource, version, target: { ...object(resource.target), zone_id: zoneId }, verified_at: null, capabilities: { configuration: tokenFor(env, "configuration") ? "unverified" : "missing", notifications: tokenFor(env, "control") ? "unverified" : "missing", waf: tokenFor(env, "control") ? "unverified" : "missing", billing: tokenFor(env, "control") ? "unverified" : "missing", analytics: tokenFor(env, "analytics") ? "unverified" : "missing" } }; }, now);
}
async function capability(probe: () => Promise<unknown>, present: boolean): Promise<Capability> { if (!present) return "missing"; try { await probe(); return "verified"; } catch (error) { return error instanceof ProviderFailure ? error.capability : "unavailable"; } }
async function probeAnalytics(env: WorkerEnv, token: string, now: number, dependencies: CloudflareControlDependencies): Promise<void> {
  const target = fixedTarget(env), result = object(await api(token, dependencies)("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query($account: string!, $database: string!, $date: Date!) { viewer { accounts(filter: {accountTag: $account}) { d1AnalyticsAdaptiveGroups(limit: 1, filter: {databaseId: $database, date_geq: $date, date_leq: $date}) { sum { rowsRead } } } } }", variables: { account: target.account_id, database: target.database_id, date: new Date(now).toISOString().slice(0, 10) } }) }));
  const accounts = list(object(result.viewer).accounts); if (accounts.length !== 1) throw new ProviderFailure("target_mismatch"); list(object(accounts[0]).d1AnalyticsAdaptiveGroups);
}
export async function verifyCloudflareControl(env: WorkerEnv, request: Request, auth: AuthContext, now: number, dependencies: CloudflareControlDependencies = {}, includeOptional = false): Promise<Resource> {
  requireOwnerControl(auth); const target = fixedTarget(env), control = tokenFor(env, "control"), configuration = tokenFor(env, "configuration"), analytics = tokenFor(env, "analytics"), row = await settingsRow(env.DB);
  const [configurationStatus, analyticsStatus] = await Promise.all([
    capability(() => baseline(env, configuration ?? "", dependencies), Boolean(configuration)),
    capability(() => probeAnalytics(env, analytics ?? "", now, dependencies), Boolean(analytics)),
  ]);
  const stored = object(JSON.parse(row.capabilities_json) as JsonValue), statuses: Resource = {
    configuration: configurationStatus, analytics: analyticsStatus,
    notifications: stored.notifications ?? (control ? "unverified" : "missing"),
    waf: stored.waf ?? (control && row.zone_id ? "unverified" : "missing"),
    billing: stored.billing ?? (control ? "unverified" : "missing"),
  };
  if (includeOptional) {
    const call = api(control ?? "", dependencies), [notifications, waf, billing] = await Promise.all([
      capability(() => call(`/accounts/${target.account_id}/alerting/v3/policies`), Boolean(control)),
      capability(async () => { const result = await getCloudflareWaf(env, auth, dependencies); if (result.status !== "verified") throw new ProviderFailure(result.status as Capability); }, Boolean(control) && Boolean(row.zone_id)),
      capability(() => call(`/accounts/${target.account_id}/billable-usage/info`), Boolean(control)),
    ]);
    Object.assign(statuses, { notifications, waf, billing });
  }
  // 并发设置或 Secret 变更会使这次能力快照失效。
  return localChange(env, request, auth, "/api/v1/admin/cloudflare/verify", includeOptional ? { include_optional: true } : {}, row.version, id => [env.DB.prepare("UPDATE cloudflare_control_settings SET capabilities_json=?2,verified_at=?3 WHERE singleton=1 AND last_operation_id=?1").bind(id, canonicalJson(statuses), now)], async version => ({ ...await getCloudflareControl(env, auth), version, capabilities: statuses, verified_at: new Date(now).toISOString() }), now);
}
async function verifiedZone(env: WorkerEnv, zoneId: string | null, dependencies: CloudflareControlDependencies, token: string | undefined): Promise<Resource> {
  if (!zoneId || !token) throw new ProviderFailure("missing");
  const target = fixedTarget(env), zone = object(await api(token, dependencies)(`/zones/${encodeURIComponent(zoneId)}`));
  const hostname = new URL((await instance(env.DB)).preferred_api_origin).hostname, name = text(zone.name);
  if (object(zone.account).id !== target.account_id || zone.id !== zoneId || !(hostname === name || hostname.endsWith(`.${name}`))) throw new ProviderFailure("target_mismatch", true);
  return zone;
}
export async function getCloudflareNotifications(env: WorkerEnv, auth: AuthContext, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); const target = fixedTarget(env), token = tokenFor(env, "control"); if (!token) return { status: "missing", available_alerts: [], policies: [], budget: BUDGET };
  try {
    const call = api(token, dependencies), path = `/accounts/${target.account_id}/alerting/v3`, [available, policies] = await Promise.all([call(`${path}/available_alerts`), call(`${path}/policies`)]);
    const flattened = Object.values(object(available)).flatMap(list); if (flattened.length > 500) throw new ProviderFailure("unavailable");
    const alerts = flattened.map(value => { const alert = object(value); return { type: text(alert.type), display_name: text(alert.display_name, 500), description: typeof alert.description === "string" ? alert.description.slice(0, 2000) : "", filter_options: alert.filter_options === undefined ? [] : list(alert.filter_options) }; });
    return { status: "verified", available_alerts: alerts, policies: list(policies).map(value => { const policy = object(value), mechanisms = object(policy.mechanisms ?? {}); return { id: text(policy.id), name: text(policy.name, 500), alert_type: text(policy.alert_type), enabled: policy.enabled === true, emails: Array.isArray(mechanisms.email) ? list(mechanisms.email).map(entry => text(object(entry).id, 320)) : [], filters: object(policy.filters ?? {}) }; }), budget: BUDGET };
  } catch (error) { return { status: error instanceof ProviderFailure ? error.capability : "unavailable", available_alerts: [], policies: [], budget: BUDGET }; }
}
function ownedExpression(host: string): string {
  const paths = ["admin", "workspaces", "projects", "issues", "attachments", "comments", "labels", "relations", "events", "notifications", "search-index"];
  return `(http.host eq "${host}" and (${paths.map(name => `(http.request.uri.path eq "/api/v1/${name}" or starts_with(http.request.uri.path, "/api/v1/${name}/"))`).join(" or ")}) and not any(http.request.headers.names[*] eq "authorization") and not http.cookie contains "cfkanban_session=")`;
}
export async function getCloudflareWaf(env: WorkerEnv, auth: AuthContext, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); return readCloudflareWaf(env, dependencies, tokenFor(env, "control"));
}
async function readCloudflareWaf(env: WorkerEnv, dependencies: CloudflareControlDependencies, token: string | undefined): Promise<Resource> {
  const row = await settingsRow(env.DB), meta = await instance(env.DB), hostname = new URL(meta.preferred_api_origin).hostname, resource: Resource = { status: "missing", zone_id: row.zone_id, hostname, owned_rule: null, other_rule_count: 0, protected: false };
  let zoneVerified = false;
  try { await verifiedZone(env, row.zone_id, dependencies, token); zoneVerified = true; const ruleset = object(await api(token ?? "", dependencies)(`/zones/${row.zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint`)), rules = list(ruleset.rules ?? []).map(object), ref = `cfkanban_${meta.instance_id.replaceAll("-", "")}_anonymous_api`, owned = rules.filter(rule => rule.ref === ref); if (owned.length > 1) throw new ProviderFailure("target_mismatch"); const rule = owned[0]; return { ...resource, status: "verified", owned_rule: rule ? { id: text(rule.id), enabled: rule.enabled === true, action: text(rule.action), expression: text(rule.expression, 16_384) } : null, other_rule_count: rules.length - owned.length, protected: Boolean(rule && rule.enabled === true && rule.action === "block" && rule.expression === ownedExpression(hostname)) }; }
  catch (error) { return { ...resource, status: zoneVerified && error instanceof ProviderFailure && error.missingResource ? "verified" : error instanceof ProviderFailure ? error.capability : "unavailable" }; }
}
function configurationValues(env: WorkerEnv): Resource {
  return { history_enabled: env.USAGE_HISTORY_ENABLED === "true", analytics_enabled: env.USAGE_ANALYTICS_ENABLED === "true" || (env.USAGE_ANALYTICS_ENABLED === undefined && Boolean(env.USAGE_ACCOUNT_ID && env.USAGE_D1_DATABASE_ID && tokenFor(env, "analytics"))), billing_plan: ["free", "paid"].includes(env.USAGE_BILLING_PLAN ?? "") ? env.USAGE_BILLING_PLAN ?? null : null, billing_cycle_day: /^([1-9]|[12][0-9]|3[01])$/.test(env.USAGE_BILLING_CYCLE_DAY ?? "") ? Number(env.USAGE_BILLING_CYCLE_DAY) : null, account_totals: env.USAGE_ACCOUNT_TOTALS_ENABLED === "true", warning_percent: /^([1-9]|[1-9][0-9]|100)$/.test(env.USAGE_WARNING_PERCENT ?? "") ? Number(env.USAGE_WARNING_PERCENT) : 80 };
}
function configurationInput(value: JsonValue): Resource {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw validationError("configuration_object_required");
  const input = object(value); for (const key of Object.keys(input)) if (!Object.hasOwn(CONFIG_VARS, key)) throw validationError("unknown_configuration_field");
  for (const key of ["history_enabled", "analytics_enabled", "account_totals"]) if (key in input && typeof input[key] !== "boolean") throw validationError("invalid_configuration_boolean");
  if ("billing_plan" in input && input.billing_plan !== null && input.billing_plan !== "free" && input.billing_plan !== "paid") throw validationError("invalid_billing_plan");
  for (const [key, max] of [["billing_cycle_day", 31], ["warning_percent", 100]] as const) if (key in input && !(key === "billing_cycle_day" && input[key] === null) && (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > max)) throw validationError("invalid_configuration_number");
  return input;
}
export async function planCloudflareConfiguration(env: WorkerEnv, request: Request, auth: AuthContext, input: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  return createPlan(env, request, auth, "configuration", configurationInput(input), expected, now, dependencies);
}
export async function planCloudflareRateLimits(env: WorkerEnv, request: Request, auth: AuthContext, scope: JsonValue, limit: JsonValue, period: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  if (typeof scope !== "string" || !Object.hasOwn(RATE_GROUPS, scope) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || (period !== 10 && period !== 60)) throw validationError("invalid_rate_limit_configuration");
  return createPlan(env, request, auth, "rate_limit", { scope, limit, period_seconds: period }, expected, now, dependencies);
}
async function createPlan(env: WorkerEnv, request: Request, auth: AuthContext, kind: PlanKind, desired: Resource, expected: number, now: number, dependencies: CloudflareControlDependencies): Promise<Resource> {
  requireOwnerControl(auth); const token = tokenFor(env, "configuration"); if (!token) throw validationError("configuration_token_required");
  let live: LiveBaseline, before: Resource, after: Resource;
  const planId = crypto.randomUUID();
  return localChange(env, request, auth, `/api/v1/admin/cloudflare/${kind === "rate_limit" ? "rate-limits" : "configuration"}/plan`, { ...(kind === "configuration" ? { settings: desired } : desired), expected_version: expected }, expected,
    (id, version) => [env.DB.prepare(`INSERT INTO cloudflare_control_plans(id,kind,control_version,baseline_json,before_json,after_json,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?8`).bind(planId, kind, version, canonicalJson(live.baseline), canonicalJson(before), canonicalJson(after), now, id)],
    async version => planResource({ id: planId, kind, control_version: version, baseline_json: canonicalJson(live.baseline), before_json: canonicalJson(before), after_json: canonicalJson(after), created_at: now, consumed_operation_id: null }), now, async () => { live = await baseline(env, token, dependencies); before = desiredValues(kind, desired, live.bindings); after = kind === "configuration" ? { ...before, ...desired } : desired; patchSettings(live, kind, after, fixedTarget(env)); });
}
function bindingText(bindings: Resource[], name: string): string | null { const binding = bindings.find(entry => entry.name === name); if (!binding) return null; if (binding.type !== "plain_text" || typeof binding.text !== "string") throw new ProviderFailure("target_mismatch", true); return binding.text; }
function desiredValues(kind: PlanKind, desired: Resource, bindings: Resource[]): Resource {
  if (kind === "rate_limit") { const group = RATE_GROUPS[desired.scope as keyof typeof RATE_GROUPS], binding = bindings.find(entry => entry.name === group[0]); if (!binding || binding.type !== "ratelimit") throw validationError("rate_limit_binding_missing"); const simple = object(binding.simple); return { scope: desired.scope ?? null, limit: simple.limit ?? null, period_seconds: simple.period ?? null }; }
  const values: Resource = {};
  for (const [key, name] of Object.entries(CONFIG_VARS)) { const value = bindingText(bindings, name); values[key] = value === null ? (["billing_plan", "billing_cycle_day"].includes(key) ? null : key === "warning_percent" ? 80 : false) : ["history_enabled", "analytics_enabled", "account_totals"].includes(key) ? value === "true" : ["billing_cycle_day", "warning_percent"].includes(key) ? Number(value) : value; }
  // Older deployments collect snapshots without an explicit enabled variable.
  // A partial settings change must preserve that effective enabled state.
  if (bindingText(bindings, CONFIG_VARS.analytics_enabled) === null) values.analytics_enabled = Boolean(bindingText(bindings, "USAGE_ACCOUNT_ID") && bindingText(bindings, "USAGE_D1_DATABASE_ID") && bindings.some(binding => (binding.name === SECRET_NAMES.connection || binding.name === SECRET_NAMES.analytics) && binding.type === "secret_text"));
  configurationInput(values); return values;
}
function patchSettings(live: LiveBaseline, kind: PlanKind, desired: Resource, target: Target): Resource {
  // A complete binding inventory is inherited from one explicit active version;
  // secret values never leave Cloudflare, and unknown top-level settings fail closed.
  const preserved = new Set(["bindings", "compatibility_date", "compatibility_flags", "usage_model", "limits", "logpush", "tail_consumers", "placement", "observability", "tags", "annotations", "cache_options", "exports_reconciliation"]);
  if (Object.keys(live.settings).some(key => !preserved.has(key))) throw validationError("cloudflare_settings_preservation_unverified");
  const changed = new Map<string, Resource>();
  if (kind === "rate_limit") {
    const group = RATE_GROUPS[desired.scope as keyof typeof RATE_GROUPS], existing = live.bindings.find(entry => entry.name === group[0]);
    if (!existing || existing.type !== "ratelimit" || typeof existing.namespace_id !== "string" || !/^[1-9][0-9]*$/.test(existing.namespace_id)) throw validationError("rate_limit_namespace_unverified");
    const extra = Object.keys(existing).filter(key => !["name", "type", "namespace_id", "simple"].includes(key)); if (extra.length) throw validationError("rate_limit_binding_unverified");
    changed.set(group[0], { name: group[0], type: "ratelimit", namespace_id: existing.namespace_id, simple: { limit: desired.limit ?? null, period: desired.period_seconds ?? null } });
    changed.set(group[1], { name: group[1], type: "plain_text", text: String(desired.limit) }); changed.set(group[2], { name: group[2], type: "plain_text", text: String(desired.period_seconds) });
  } else {
    for (const [key, name] of Object.entries(CONFIG_VARS)) if (desired[key] !== null && desired[key] !== undefined) changed.set(name, { name, type: "plain_text", text: String(desired[key]) });
    if (desired.analytics_enabled === true || desired.history_enabled === true) for (const [name, value] of [["USAGE_ACCOUNT_ID", target.account_id], ["USAGE_D1_DATABASE_ID", target.database_id], ["USAGE_WORKER_NAME", target.worker_name]]) changed.set(name as string, { name: name as string, type: "plain_text", text: value as string });
  }
  const removed = kind === "configuration" ? new Set(Object.entries(CONFIG_VARS).filter(([key]) => desired[key] === null).map(([, name]) => name)) : new Set<string>();
  const bindings: Resource[] = live.bindings.filter(entry => !removed.has(text(entry.name))).map(entry => changed.get(text(entry.name)) ?? { name: text(entry.name), type: "inherit", version_id: live.baseline.active_version_id });
  for (const [name, binding] of changed) if (!live.bindings.some(entry => entry.name === name)) bindings.push(binding);
  const { exports_reconciliation: _reconciliation, annotations, ...settings } = live.settings;
  // These annotations describe the newly created version; triggered_by is server-only.
  const writableAnnotations = annotations === undefined ? undefined : Object.fromEntries(Object.entries(object(annotations)).filter(([name]) => name === "workers/message" || name === "workers/tag"));
  return { ...settings, ...(writableAnnotations ? { annotations: writableAnnotations } : {}), bindings };
}
async function findDuplicate(env: WorkerEnv, request: Request, auth: AuthContext, requestHash: string, forbidden: string[] = []): Promise<OperationRow | null> {
  const key = requireIdempotencyKey(request); validateIdempotencyKey(key, forbidden); const keyHash = await sha256Hex(key), route = new URL(request.url).pathname;
  const row = await env.DB.prepare("SELECT * FROM cloudflare_control_operations WHERE principal_id=?1 AND route=?2 AND key_hash=?3").bind(auth.principalId, route, keyHash).first<OperationRow>();
  if (row && row.request_hash !== requestHash) throw conflict("IDEMPOTENCY_CONFLICT"); return row;
}
async function operationWriteResult(env: WorkerEnv, auth: AuthContext, row: OperationRow, replay: boolean): Promise<Resource> {
  const control = await settingsRow(env.DB), commit = await probeOperationCommit(env.DB, control.latest_operation_id === row.id && control.last_operation_id ? control.last_operation_id : row.id); if (!commit) throw platformUnavailable("d1"); return writeResult(env.DB, auth, operationResource(row, control.version), commit.lastEventSequence, replay);
}
async function intent(env: WorkerEnv, request: Request, auth: AuthContext, kind: string, requestHash: string, live: LiveBaseline, desired: Resource, secretHash: string | null, expected: number, now: number, planId: string | null): Promise<OperationRow> {
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
async function transition(env: WorkerEnv, request: Request, auth: AuthContext, row: OperationRow, status: Status, failure: string | null, versionId: string | null, deploymentId: string | null, dispatch = false, commandId?: string): Promise<boolean> {
  const db = env.DB, eventOperation = commandId ?? crypto.randomUUID(), meta = await instance(db), now = Date.now(); await reauthenticateOwner(db, request, now);
  const control = await settingsRow(db), guard = buildCurrentAuthGuard(auth, now, 6, true);
  try { await executeAtomicBatch(db, { operationId: eventOperation, primarySubjectId: meta.instance_id, primarySubjectType: "instance", committedAt: now, expectedEventCount: 1, requireIdempotencySnapshot: commandId !== undefined,
    businessStatements: [db.prepare(`UPDATE cloudflare_control_settings SET version=version+1,last_operation_id=?1,locked_operation_id=CASE WHEN ?2 IN ('verified','failed') THEN NULL ELSE locked_operation_id END WHERE singleton=1 AND (locked_operation_id=?3 ${commandId ? "OR locked_operation_id IS NULL" : ""}) AND version=?5 AND EXISTS(SELECT 1 FROM cloudflare_control_operations WHERE id=?3 AND status IN ('pending','unknown'${commandId ? ",'verified','failed'" : ""}) AND updated_at=?4 ${dispatch || row.dispatched_at === null ? "AND dispatched_at IS NULL" : "AND dispatched_at IS NOT NULL"}) AND ${guard.sql}`).bind(eventOperation, status, row.id, row.updated_at, control.version, ...guard.values),
      db.prepare(`UPDATE cloudflare_control_operations SET status=?2,failure_class=?3,result_version_id=?4,deployment_id=?5,updated_at=?6${dispatch ? ",dispatched_at=?6" : ""} WHERE id=?1 AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE last_operation_id=?7)`).bind(row.id, status, failure, versionId, deploymentId, now, eventOperation),
      ...(commandId ? [db.prepare("UPDATE idempotency_records SET operation_snapshot_json=?2 WHERE operation_id=?1 AND state='pending' AND EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE last_operation_id=?1)").bind(eventOperation, canonicalJson(operationResource({ ...row, status, failure_class: failure, result_version_id: versionId, deployment_id: deploymentId, updated_at: now }, control.version + 1)))] : []),
      event(db, auth, crypto.randomUUID(), eventOperation, meta.instance_id, now, dispatch ? "instance.cloudflare-control-dispatched" : "instance.cloudflare-control-result")],
    confirmBusinessRejection: async () => { await reauthenticateOwner(db, request, Date.now()); const current = await operationRow(db, row.id); return current.updated_at !== row.updated_at || (dispatch && current.dispatched_at !== null) || (await settingsRow(db)).version !== control.version || (await settingsRow(db)).locked_operation_id !== row.id; } }); return true;
  } catch (error) { if (error instanceof AtomicBatchRejectedError) return false; throw error; }
}
export async function saveCloudflareSecret(env: WorkerEnv, request: Request, auth: AuthContext, kindValue: JsonValue, tokenValue: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); if (typeof kindValue !== "string" || !Object.hasOwn(SECRET_NAMES, kindValue) || typeof tokenValue !== "string" || !/^[\x21-\x7e]{32,4096}$/.test(tokenValue)) throw validationError("invalid_cloudflare_secret");
  const kind = kindValue as SecretKind, tokenHash = await sha256Hex(tokenValue), requestHash = await sha256Hex(canonicalJson({ kind, expected_version: expected, value_digest: tokenHash }));
  await reauthenticateOwner(env.DB, request, Date.now()); const duplicate = await findDuplicate(env, request, auth, requestHash, [tokenValue]); if (duplicate) return operationWriteResult(env, auth, duplicate, true);
  if (kind === "analytics") await probeAnalytics(env, tokenValue, now, dependencies);
  if (kind === "control") {
    const target = fixedTarget(env), call = api(tokenValue, dependencies), zone = (await settingsRow(env.DB)).zone_id;
    const probes = await Promise.all([capability(() => call(`/accounts/${target.account_id}/alerting/v3/policies`), true), capability(() => call(`/accounts/${target.account_id}/billable-usage/info`), true), capability(async () => { const result = await readCloudflareWaf(env, dependencies, tokenValue); if (result.status !== "verified") throw new ProviderFailure(result.status as Capability); }, Boolean(zone))]);
    if (!probes.includes("verified")) throw new ProviderFailure(probes.every(status => status === "permission_denied" || status === "missing") ? "permission_denied" : "unavailable", true);
  }
  const writer = kind === "connection" || kind === "configuration" ? tokenValue : tokenFor(env, "configuration"); if (!writer) throw validationError("configuration_token_required");
  const live = await baseline(env, writer, dependencies), row = await intent(env, request, auth, secretOperationKind(kind), requestHash, live, { secret_kind: kind, secret_name: SECRET_NAMES[kind] }, tokenHash, expected, now, null);
  if (row.dispatched_at !== null || row.status !== "pending") return operationWriteResult(env, auth, row, true);
  try { if (canonicalJson((await baseline(env, writer, dependencies)).baseline) !== row.baseline_json) throw validationError("cloudflare_baseline_changed"); }
  catch { await transition(env, request, auth, row, "failed", "preflight_changed", null, null); return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false); }
  if (!(await transition(env, request, auth, row, "pending", null, null, null, true))) return operationWriteResult(env, auth, await operationRow(env.DB, row.id), true);
  await completeCloudMutation(env, request, auth, row.id, dependencies, writer, () => api(writer, dependencies)(`${scriptPath(fixedTarget(env))}/secrets`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: SECRET_NAMES[kind], text: tokenValue, type: "secret_text" }) }));
  return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false);
}
export async function applyCloudflarePlan(env: WorkerEnv, request: Request, auth: AuthContext, kind: PlanKind, planId: JsonValue, expected: number, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
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
  await completeCloudMutation(env, request, auth, row.id, dependencies, token, async () => { const form = new FormData(); form.append("settings", JSON.stringify(settings)); return api(token, dependencies)(`${scriptPath(fixedTarget(env))}/settings`, { method: "PATCH", body: form }); });
  return operationWriteResult(env, auth, await operationRow(env.DB, row.id), false);
}
export async function getCloudflareOperation(env: WorkerEnv, auth: AuthContext, id: string): Promise<Resource> { requireOwnerControl(auth); return operationResource(await operationRow(env.DB, id), (await settingsRow(env.DB)).version); }
export async function getCloudflareSecretOperation(env: WorkerEnv, auth: AuthContext, requestKey: string): Promise<Resource> {
  requireOwnerControl(auth); validateIdempotencyKey(requestKey);
  const row = await env.DB.prepare("SELECT * FROM cloudflare_control_operations WHERE principal_id=?1 AND route=?2 AND key_hash=?3").bind(auth.principalId, "/api/v1/admin/cloudflare/secrets", await sha256Hex(requestKey)).first<OperationRow>();
  if (!row) throw notFound();
  return operationResource(row, (await settingsRow(env.DB)).version);
}
export async function getCloudflarePlan(env: WorkerEnv, auth: AuthContext, id: string): Promise<Resource> { requireOwnerControl(auth); if (!isUuid(id)) throw notFound(); const row = await env.DB.prepare("SELECT * FROM cloudflare_control_plans WHERE id=?1").bind(id).first<PlanRow>(); if (!row) throw notFound(); return planResource(row); }
type Assessment = [Status, string | null, string | null, string | null];
async function completeCloudMutation(env: WorkerEnv, request: Request, auth: AuthContext, id: string, dependencies: CloudflareControlDependencies, token: string, mutate: () => Promise<JsonValue>): Promise<void> {
  try { await mutate(); }
  catch (error) { await transition(env, request, auth, await operationRow(env.DB, id), error instanceof ProviderFailure && error.rejected ? "failed" : "unknown", error instanceof ProviderFailure ? error.capability : "unavailable", null, null); return; }
  // The mutation was accepted. A later read failure cannot prove it did not
  // happen, including an authorization failure of the readback credential.
  try { await verifyOperationInternal(env, request, auth, await operationRow(env.DB, id), dependencies, token); }
  catch (error) { const row = await operationRow(env.DB, id); await transition(env, request, auth, row, "unknown", error instanceof ProviderFailure ? error.capability : "unavailable", row.result_version_id, row.deployment_id); }
}
function orderedBindingFingerprints(value: JsonValue | undefined): Resource[] { return list(value).map(object).sort((a, b) => text(a.name).localeCompare(text(b.name))); }
async function planBindingsMatch(live: LiveBaseline, before: Resource, kind: PlanKind, desired: Resource, target: Target, writer: string, dependencies: CloudflareControlDependencies): Promise<boolean> {
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
  const writer = token ?? tokenFor(env, "configuration"); if (!writer) throw new ProviderFailure("missing"); const live = await baseline(env, writer, dependencies, true), before = object(JSON.parse(row.baseline_json) as JsonValue), desired = object(JSON.parse(row.desired_json) as JsonValue);
  if (canonicalJson(live.baseline.target) !== canonicalJson(object(before.target))) return ["unknown", "target_mismatch", row.result_version_id, live.baseline.deployment_id];
  if (live.baseline.etag !== before.etag) return ["unknown", "cloudflare_code_drift", live.baseline.active_version_id, live.baseline.deployment_id];
  if (row.result_version_id && live.baseline.active_version_id !== row.result_version_id && live.baseline.latest_version_id !== row.result_version_id) return ["unknown", "cloudflare_version_drift", row.result_version_id, live.baseline.deployment_id];
  if (live.baseline.active_version_id === before.active_version_id) return ["pending", "deployment_not_active", live.baseline.latest_version_id === before.active_version_id ? null : live.baseline.latest_version_id, live.baseline.deployment_id];
  if (row.result_version_id && live.baseline.active_version_id !== row.result_version_id) return ["unknown", "cloudflare_version_drift", row.result_version_id, live.baseline.deployment_id];
  const secretName = row.kind.endsWith("_secret") ? operationSecretName(row, desired) : null;
  const changedNames = secretName ? new Set([secretName]) : row.kind === "rate_limit" ? new Set(RATE_GROUPS[desired.scope as keyof typeof RATE_GROUPS]) : new Set([...Object.values(CONFIG_VARS), "USAGE_ACCOUNT_ID", "USAGE_D1_DATABASE_ID", "USAGE_WORKER_NAME"]);
  const unchanged = (value: JsonValue | undefined) => list(value).map(object).filter(binding => !changedNames.has(text(binding.name))).sort((a, b) => text(a.name).localeCompare(text(b.name)));
  if (before.metadata_hash !== live.baseline.metadata_hash || canonicalJson(unchanged(before.binding_fingerprints)) !== canonicalJson(unchanged(live.baseline.binding_fingerprints))) return ["unknown", "cloudflare_foreign_configuration_drift", live.baseline.active_version_id, live.baseline.deployment_id];
  let matches = false;
  if (secretName) { const current = env[secretName]; matches = Boolean(current && live.bindings.some(binding => binding.name === secretName && binding.type === "secret_text") && row.secret_value_hash === await sha256Hex(current)); }
  else { const kind = row.kind as PlanKind; matches = await planBindingsMatch(live, before, kind, desired, fixedTarget(env), writer, dependencies); }
  return [matches ? "verified" : "unknown", matches ? null : row.kind.endsWith("_secret") ? "secret_readback_pending" : "configuration_readback_mismatch", matches || secretName ? live.baseline.active_version_id : row.result_version_id, live.baseline.deployment_id];
}
async function verifyOperationInternal(env: WorkerEnv, request: Request, auth: AuthContext, row: OperationRow, dependencies: CloudflareControlDependencies, token?: string): Promise<void> {
  if (row.status === "verified" || row.status === "failed") return;
  const assessed = await assessOperation(env, row, dependencies, token); await transition(env, request, auth, row, ...assessed);
}
export async function verifyCloudflareOperation(env: WorkerEnv, request: Request, auth: AuthContext, id: string, now: number, dependencies: CloudflareControlDependencies = {}): Promise<Resource> {
  requireOwnerControl(auth); const db = env.DB, authorize = async () => { await reauthenticateOwner(db, request, Date.now()); };
  const result = await runIdempotentOperation({ db, now, method: "POST", routeTemplate: "/api/v1/admin/cloudflare/operations/{operation_id}/verify", scopeKey: `principal:${auth.principalId}`, normalizedResourceScope: `cloudflare-operation:${id}`, requestBody: {}, idempotencyKey: requireIdempotencyKey(request), authorize,
    execute: async commandId => { const row = await operationRow(db, id); let assessed: Assessment; try { assessed = await assessOperation(env, row, dependencies); } catch (error) { if (!(error instanceof ProviderFailure)) throw error; assessed = ["unknown", error.capability, row.result_version_id, row.deployment_id]; } if (!(await transition(env, request, auth, row, ...assessed, false, commandId))) throw versionConflict((await settingsRow(db)).version); },
    readback: async (commandId, commit) => ({ body: await writeResult(db, auth, await readOperationSnapshot<Resource>(db, commandId), commit.lastEventSequence, false), status: 200 }) });
  return { ...result.body, idempotent_replay: result.idempotentReplay };
}
