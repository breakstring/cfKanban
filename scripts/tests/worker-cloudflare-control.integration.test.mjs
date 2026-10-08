import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { registerCloudflareControlRoutes } from "../../apps/worker/src/routes/cloudflare-control.ts";
import { Router } from "../../apps/worker/src/kernel/router.ts";
import { createRequestContext } from "../../apps/worker/src/kernel/http.ts";
import { errorResponse } from "../../apps/worker/src/kernel/errors.ts";

// Only an isolated local D1 and a synthetic in-memory Cloudflare provider are used.
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker(), ownerId = randomUUID(), credentialId = randomUUID(), instanceId = randomUUID();
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`, configurationToken = "K".repeat(40), nextToken = "N".repeat(40), controlToken = "C".repeat(40);
const target = { account_id: "a".repeat(32), worker_name: "fixture-worker", database_id: randomUUID() }, zoneId = "b".repeat(32), base = "/api/v1/admin/cloudflare";
const digest = value => createHash("sha256").update(value).digest("hex");
let env, db, provider, router;
function fakeProvider() {
  const first = randomUUID();
  const state = { active: first, latest: first, deployment: randomUUID(), deploymentPages: 1, mutations: [], gets: [], requests: [], mode: "deploy", denied: false, foreignZone: false, wafMissing: false, oversized: false, code: "code-etag", secrets: {}, versions: new Map() };
  const bindings = [{ name: "DB", type: "d1", id: target.database_id }, { name: "INSTANCE_RATE_LIMITER", type: "ratelimit", namespace_id: "1001", simple: { limit: 300, period: 60 } }, { name: "RATE_LIMIT_INSTANCE_LIMIT", type: "plain_text", text: "300" }, { name: "RATE_LIMIT_INSTANCE_PERIOD_SECONDS", type: "plain_text", text: "60" }, { name: "FOREIGN_SECRET", type: "secret_text" }, { name: "FOREIGN_VAR", type: "plain_text", text: "do not change" }, { name: "CFKANBAN_CONFIGURATION_TOKEN", type: "secret_text" }];
  state.versions.set(first, { bindings, compatibility_date: "2026-08-29", compatibility_flags: ["nodejs_compat"], limits: { cpu_ms: 10 }, observability: { enabled: false }, cache_options: { enabled: false, cross_version_cache: false }, annotations: { "workers/message": "Fixture version", "workers/triggered_by": "upload" }, exports_reconciliation: { created: [], deleted: [] } });
  const response = (result, status = 200, resultInfo) => new Response(JSON.stringify({ success: status === 200, result, ...(resultInfo ? { result_info: resultInfo } : {}) }), { status });
  const publish = settings => { const id = randomUUID(); state.versions.set(id, structuredClone(settings)); state.latest = id; if (state.mode !== "pending") { state.active = id; state.deployment = randomUUID(); } return id; };
  state.publish = publish;
  state.fetch = async (url, init) => {
    assert.equal(new URL(url).origin, "https://api.cloudflare.com"); assert.equal(init.redirect, "manual"); assert.ok(init.signal);
    const path = new URL(url).pathname.replace("/client/v4", ""), method = init.method ?? "GET";
    state.requests.push({ path, method });
    if (state.denied || state.rejectRequest?.({ path, method, authorization: init.headers.authorization }) || (state.rejectedToken && init.headers.authorization === `Bearer ${state.rejectedToken}`) || (method === "GET" && state.mutations.length && state.readFailureAfterMutation)) return new Response(state.failureBody ?? "provider-secret error details", { status: state.readFailureAfterMutation || state.failureStatus || 403, headers: state.failureHeaders });
    if (state.oversized) return new Response(JSON.stringify({ success: true, result: "x".repeat(70000) }));
    if (method === "PUT" && path.endsWith("/secrets")) {
      const body = JSON.parse(init.body); state.mutations.push({ method, path, name: body.name }); state.secrets[body.name] = body.text;
      const settings = structuredClone(state.versions.get(state.active)); settings.bindings = settings.bindings.filter(binding => binding.name !== body.name); settings.bindings.push({ name: body.name, type: "secret_text" }); settings.annotations = { "workers/message": "Secret updated", "workers/triggered_by": "secret" }; publish(settings);
      if (state.mode === "network_after") throw new Error(`must never expose ${body.text}`);
      return response({ name: body.name, type: body.type });
    }
    if (method === "PATCH" && path.endsWith("/settings")) {
      assert.ok(init.body instanceof FormData); const patch = JSON.parse(init.body.get("settings")); state.mutations.push({ method, path, patch: structuredClone(patch) });
      assert.ok(!("exports_reconciliation" in patch)); assert.ok(!("workers/triggered_by" in patch.annotations));
      patch.bindings = patch.bindings.map(binding => binding.type === "inherit" ? structuredClone(state.versions.get(binding.version_id).bindings.find(existing => existing.name === binding.name)) : binding); patch.annotations["workers/triggered_by"] = "settings";
      publish(patch); if (state.mode === "network_after") throw new Error("Synthetic settings response lost after publication"); return response(patch);
    }
    state.gets.push(path);
    if (path.endsWith("/deployments")) return response({ deployments: [{ id: state.deployment, versions: [{ version_id: state.active, percentage: 100 }] }] }, 200, { page: 1, per_page: 10, total_pages: state.deploymentPages });
    if (path.endsWith("/versions")) return response({ items: [{ id: state.latest }] });
    if (/\/versions\/[^/]+$/.test(path)) return response({ resources: { bindings: state.versions.get(path.split("/").at(-1)).bindings, script: { etag: state.code }, script_runtime: { compatibility_flags: ["global_fetch_strictly_public"] } } });
    if (path.endsWith("/settings")) return response(state.versions.get(state.latest));
    if (path === `/zones/${zoneId}`) return response({ id: zoneId, name: "example.test", status: "active", account: { id: state.foreignZone ? "foreign-account" : target.account_id } });
    if (path.endsWith("/firewall/access_rules/rules")) return response([]);
    const wafRuleset = { id: "fixture-entrypoint", kind: "zone", phase: "http_request_firewall_custom", rules: [{ id: "foreign-rule", ref: "foreign", enabled: true, action: "skip", expression: "true" }] };
    if (path === `/zones/${zoneId}/rulesets`) return response(state.wafMissing ? [] : [{ id: wafRuleset.id, kind: wafRuleset.kind, phase: wafRuleset.phase }]);
    if (path === `/zones/${zoneId}/rulesets/fixture-entrypoint`) return response(wafRuleset);
    if (path.endsWith("/subdomain")) return response({ enabled: false, previews_enabled: false });
    if (path.endsWith("/entrypoint")) return state.wafMissing ? response(null, 404) : response(wafRuleset);
    if (path.endsWith("/available_alerts")) return response({ billing: [{ type: "billing_usage_alert", display_name: "Usage alert", description: "Provider documentation" }] });
    if (path.endsWith("/policies")) return response([{ id: "policy1", name: "A policy", alert_type: "billing_usage_alert", enabled: true, mechanisms: { email: [{ id: "fixture@example.test" }] }, filters: { product: ["r2"], limit: ["100"] } }]);
    if (path.endsWith("/billable-usage/info")) return response({ subscriptions: [] });
    if (path === "/graphql") { const body = JSON.parse(init.body); assert.match(body.query, /\$account: string!, \$database: string!/); assert.doesNotMatch(body.query, /String!/); assert.equal(body.variables.account, target.account_id); assert.equal(body.variables.database, target.database_id); assert.match(body.variables.date, /^\d{4}-\d{2}-\d{2}$/); return new Response(JSON.stringify({ errors: [], data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } })); }
    throw new Error(`Unexpected fake path ${path}`);
  };
  return state;
}
async function request(path, { method = "GET", body, key = randomUUID(), headers = { authorization: `Bearer ${ownerToken}` }, overrideEnv = env } = {}) {
  const req = new Request(`https://control.example.test${path}`, { method, headers: { ...headers, ...(key ? { "idempotency-key": key } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const context = createRequestContext(req); let response;
  try { response = await router.dispatch(req, overrideEnv, context); } catch (error) { response = errorResponse(error, context.requestId); }
  return { status: response.status, data: await response.json(), response };
}
const current = async () => (await request(base)).data;
const save = async (kind, token, extra = {}) => request(`${base}/secrets`, { method: "POST", body: { kind, token, expected_version: (await current()).version }, ...extra });
before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); env = await worker.getEnv(); db = env.DB;
  await bootstrapInstance(db, { instanceId, operationId: randomUUID(), ownerCredentialId: credentialId, ownerCredentialToken: ownerToken, ownerDisplayName: "Control_Owner", ownerPrincipalId: ownerId, preferredApiOrigin: "https://control.example.test" });
  env = { ...env, CFKANBAN_CONTROL_ACCOUNT_ID: target.account_id, CFKANBAN_CONTROL_WORKER_NAME: target.worker_name, CFKANBAN_CONTROL_DATABASE_ID: target.database_id, CFKANBAN_CONFIGURATION_TOKEN: configurationToken, CFKANBAN_CONTROL_TOKEN: controlToken };
});
beforeEach(async () => {
  provider = fakeProvider(); router = new Router(); registerCloudflareControlRoutes(router, { fetch: provider.fetch });
  await db.batch([db.prepare("DELETE FROM cloudflare_control_plans"), db.prepare("DELETE FROM cloudflare_control_operations"), db.prepare("UPDATE cloudflare_control_settings SET version=1,zone_id=NULL,capabilities_json='{}',verified_at=NULL,latest_operation_id=NULL,locked_operation_id=NULL,last_operation_id=NULL")]);
});
after(() => server.close());

test("Owner 独占控制范围，Cookie 写保护和目标白名单拒绝发生在供应商请求前", async () => {
  assert.equal((await request(base, { headers: {} })).status, 401);
  const outsider = randomUUID(), outsiderToken = `cfk_v1_reader_${"R".repeat(43)}`, now = Date.now();
  await db.batch([db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'Control_Reader','control_reader',?2,?2)").bind(outsider, now), db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'reader',?3,?4,?5)").bind(randomUUID(), outsider, digest(outsiderToken), now, randomUUID())]);
  assert.equal((await request(base, { headers: { authorization: `Bearer ${outsiderToken}` } })).status, 403);
  const session = "S".repeat(43), csrf = "X".repeat(32);
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES(?1,?2,?3,'credential',?4,'admin',?5,?6,?7)").bind(randomUUID(), digest(session), ownerId, credentialId, JSON.stringify({ kind: "admin", entry_path: "/app/admin", section: "overview" }), now + 3600000, now).run();
  const cookie = { cookie: `cfkanban_session=${session}; cfkanban_csrf=${csrf}` };
  assert.equal((await save("control", nextToken, { headers: cookie })).status, 403);
  assert.equal((await request(`${base}/configuration/plan`, { method: "POST", body: { settings: { account_id: "foreign" }, expected_version: 1 } })).status, 400);
  assert.equal((await request(`${base}/secrets`, { method: "POST", body: { kind: "control", token: nextToken, expected_version: 1, worker_name: "foreign" } })).status, 400);
  assert.equal(provider.gets.length, 0); assert.equal(provider.mutations.length, 0);
});
test("供应商预检 HTTP403 定位四项读取，取消错误正文且不泄露 Token、目标或响应头", async () => {
  const malicious = JSON.stringify({ errors: [{ code: 10000, message: `provider-secret ${nextToken} Bearer ${nextToken}`, url: `https://provider.example.test/?token=${nextToken}` }], stack: "provider-stack", target: target.account_id });
  for (const [operation, rejects] of [
    ["deployments", path => path.endsWith("/deployments")],
    ["versions", path => path.endsWith("/versions")],
    ["settings", path => path.endsWith("/settings")],
    ["version_details", path => /\/versions\/[^/]+$/.test(path)],
  ]) {
    let cancelled = 0;
    provider.failureBody = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(malicious)); }, cancel() { cancelled += 1; } });
    provider.failureHeaders = { "x-provider-note": `provider-header ${nextToken}` };
    provider.rejectRequest = ({ path, method }) => method === "GET" && rejects(path);
    const denied = await save("connection", nextToken);
    assert.equal(denied.status, 403); assert.equal(denied.data.code, "FORBIDDEN"); assert.equal(denied.data.source, "cloudflare_platform");
    assert.deepEqual(denied.data.details, { component: "cloudflare-control", failure_class: "permission_denied", provider_operation: operation, provider_method: "GET", provider_status: 403, write_state: "not_dispatched" });
    assert.equal(cancelled, 1);
    for (const forbidden of [nextToken, target.account_id, target.worker_name, "provider-secret", "provider-header", "provider-stack", "provider.example.test"]) assert.ok(!JSON.stringify(denied.data).includes(forbidden));
    assert.equal((await db.prepare("SELECT count(*) AS n FROM cloudflare_control_operations").first()).n, 0); assert.equal((await current()).version, 1);
  }
  assert.equal(provider.mutations.length, 0);
});
test("部署历史有十页时仅取当前页，保留active/latest与固定目标校验后自保存", async () => {
  provider.deploymentPages = 10;
  const saved = await save("connection", nextToken, { overrideEnv: { ...env, CFKANBAN_API_TOKEN: nextToken } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.resource.status, "verified");
  assert.equal(provider.mutations.length, 1); assert.equal(provider.mutations[0].name, "CFKANBAN_API_TOKEN");
  assert.equal(provider.requests.filter(call => call.path.endsWith("/deployments")).length, 3);
  assert.equal(provider.requests.length, 13);
});
for (const fault of ["http_503", "transport", "oversized"]) test(`首次保存预检${fault}明确本次未dispatch，不登记intent或写Secret`, async () => {
  if (fault === "http_503") { provider.failureStatus = 503; provider.rejectRequest = ({ path }) => path.endsWith("/deployments"); }
  if (fault === "transport") { router = new Router(); registerCloudflareControlRoutes(router, { fetch: async () => { throw new Error(`provider-secret ${nextToken}`); } }); }
  if (fault === "oversized") provider.oversized = true;
  const key = randomUUID(), result = await save("connection", nextToken, { key });
  assert.equal(result.status, 503, JSON.stringify(result.data)); assert.equal(result.data.source, "cloudflare_platform");
  assert.equal(result.data.details.component, "cloudflare-control"); assert.equal(result.data.details.write_state, "not_dispatched");
  if (fault === "http_503") { assert.equal(result.data.details.provider_operation, "deployments"); assert.equal(result.data.details.provider_status, 503); }
  assert.ok(!JSON.stringify(result.data).includes(nextToken)); assert.ok(!JSON.stringify(result.data).includes("provider-secret"));
  assert.equal(provider.mutations.length, 0); assert.equal((await db.prepare("SELECT count(*) AS n FROM cloudflare_control_operations").first()).n, 0);
  assert.equal((await current()).version, 1); assert.equal((await request(`${base}/secret-operations/${key}`)).status, 404);
});
for (const [status, expected, failure] of [[400, "failed", "unavailable"], [403, "failed", "permission_denied"], [404, "failed", "unavailable"], [408, "unknown", "unavailable"], [429, "unknown", "unavailable"], [503, "unknown", "unavailable"]]) test(`供应商秘密写 HTTP${status} 保持 ${expected} 及原请求不重放语义`, async () => {
  const body = { kind: "connection", token: nextToken, expected_version: 1 }, key = randomUUID();
  provider.failureStatus = status; provider.failureBody = `provider-secret ${nextToken}`; provider.rejectRequest = ({ method, path }) => method === "PUT" && path.endsWith("/secrets");
  const saved = await request(`${base}/secrets`, { method: "POST", body, key });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.resource.status, expected); assert.equal(saved.data.resource.failure_class, failure);
  assert.ok(!JSON.stringify(saved.data).includes(nextToken)); assert.ok(!JSON.stringify(saved.data).includes("provider-secret"));
  const stored = await db.prepare("SELECT * FROM cloudflare_control_operations WHERE id=?1").bind(saved.data.resource.operation_id).first();
  assert.equal(stored.status, expected); assert.equal(stored.failure_class, failure); assert.ok(!JSON.stringify(stored).includes("provider_status"));
  const lock = (await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id;
  assert.equal(lock, expected === "unknown" ? saved.data.resource.operation_id : null);
  const replay = await request(`${base}/secrets`, { method: "POST", body, key }); assert.equal(replay.data.idempotent_replay, true); assert.equal(replay.data.resource.status, expected);
  assert.equal(provider.requests.filter(call => call.method === "PUT").length, 1); assert.equal(provider.mutations.length, 0);
});
test("首次配置 Token 自保存仅向固定 Worker 写秘密，明文不进入D1、审计或响应", async () => {
  const withoutConfiguration = { ...env, CFKANBAN_CONFIGURATION_TOKEN: undefined }, key = randomUUID();
  const result = await save("configuration", nextToken, { overrideEnv: withoutConfiguration, key }); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.resource.status, "unknown"); assert.equal(provider.mutations.length, 1); assert.equal(provider.mutations[0].name, "CFKANBAN_CONFIGURATION_TOKEN");
  const stored = await db.prepare("SELECT * FROM cloudflare_control_operations").all(), audit = await db.prepare("SELECT payload_json FROM events WHERE type LIKE 'instance.cloudflare-control-%'").all();
  for (const value of [result.data, stored.results, audit.results]) assert.ok(!JSON.stringify(value).includes(nextToken));
  const retry = await save("configuration", nextToken, { overrideEnv: withoutConfiguration, key }); assert.equal(retry.status, 409, "changed expected_version intentionally conflicts with the original key");
  const recovered = await request(`${base}/operations/${result.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_CONFIGURATION_TOKEN: nextToken } });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data)); assert.equal(recovered.data.resource.status, "verified"); assert.equal(provider.mutations.length, 1);
});
test("原保存 key 查询只读返回非秘密 intent，404 保留未知写锁", async () => {
  provider.mode = "network_after"; const key = randomUUID(), saved = await save("connection", nextToken, { key });
  assert.equal(saved.data.resource.status, "unknown");
  const before = { settings: await db.prepare("SELECT * FROM cloudflare_control_settings").first(), count: (await db.prepare("SELECT count(*) AS n FROM events").first()).n, requests: provider.requests.length, writes: provider.mutations.length };
  const found = await request(`${base}/secret-operations/${key}`);
  assert.equal(found.status, 200, JSON.stringify(found.data)); assert.equal(found.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(found.data, saved.data.resource);
  assert.deepEqual(Object.keys(found.data).sort(), ["operation_id", "kind", "status", "version", "baseline_version_id", "result_version_id", "deployment_id", "failure_class", "created_at", "updated_at"].sort());
  for (const secret of [nextToken, digest(nextToken), digest(key), "provider-secret"]) assert.ok(!JSON.stringify(found.data).includes(secret));
  assert.equal((await request(`${base}/secret-operations/${randomUUID()}`)).status, 404);
  assert.equal((await request(`${base}/secret-operations/${"x".repeat(129)}`)).status, 400);
  assert.equal((await request(`${base}/secret-operations/${key}`, { headers: {} })).status, 401);
  assert.deepEqual(await db.prepare("SELECT * FROM cloudflare_control_settings").first(), before.settings);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM events").first()).n, before.count);
  assert.equal(provider.requests.length, before.requests); assert.equal(provider.mutations.length, before.writes);
  assert.equal(before.settings.locked_operation_id, saved.data.resource.operation_id);
});
test("原 key 精确查找较早保存，不将 latest operation、其他调用者或其他路由视为结果", async () => {
  const key = randomUUID(), unified = { ...env, CFKANBAN_API_TOKEN: nextToken }, saved = await save("connection", nextToken, { key });
  const verified = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: unified }); assert.equal(verified.data.resource.status, "verified");
  const later = await save("connection", nextToken, { overrideEnv: unified }); assert.equal(later.data.resource.status, "verified");
  assert.equal((await current()).latest_operation.operation_id, later.data.resource.operation_id);
  const calls = provider.requests.length, writes = provider.mutations.length, found = await request(`${base}/secret-operations/${key}`);
  assert.equal(found.data.operation_id, saved.data.resource.operation_id); assert.equal(found.data.status, "verified");
  await db.prepare("UPDATE cloudflare_control_operations SET route=?2 WHERE id=?1").bind(saved.data.resource.operation_id, `${base}/configuration/apply`).run();
  assert.equal((await request(`${base}/secret-operations/${key}`)).status, 404);
  const foreign = randomUUID(), now = Date.now();
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'Intent_Reader','intent_reader',?2,?2)").bind(foreign, now).run();
  await db.prepare("UPDATE cloudflare_control_operations SET route=?2,principal_id=?3 WHERE id=?1").bind(saved.data.resource.operation_id, `${base}/secrets`, foreign).run();
  assert.equal((await request(`${base}/secret-operations/${key}`)).status, 404);
  assert.equal(provider.requests.length, calls); assert.equal(provider.mutations.length, writes);
});
test("所有验证选项只访问配置和统计，退役能力不再请求供应商", async () => {
  const unified = { ...env, CFKANBAN_API_TOKEN: configurationToken };
  for (const body of [{}, { include_optional: false }, { include_optional: true }]) {
    provider.requests.length = 0;
    const verified = await request(`${base}/verify`, { method: "POST", body, overrideEnv: unified });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.deepEqual(verified.data.resource.capabilities, { configuration: "verified", analytics: "verified", notifications: "unsupported_contract", waf: "unsupported_contract", billing: "unsupported_contract" });
    assert.ok(provider.requests.some(call => call.path === "/graphql")); assert.ok(provider.requests.some(call => call.path.endsWith("/deployments")));
    assert.ok(provider.requests.every(call => call.path === "/graphql" || call.path.startsWith(`/accounts/${target.account_id}/workers/scripts/${target.worker_name}/`)));
  }
  assert.equal((await request(`${base}/verify`, { method: "POST", body: { include_optional: "true" } })).status, 400);
  assert.equal(provider.mutations.length, 0);
});

test("Dashboard替换Token或固定目标后旧能力快照失效，身份摘要不对外返回", async () => {
  const unified = { ...env, CFKANBAN_API_TOKEN: configurationToken };
  await request(`${base}/verify`, { method: "POST", body: {}, overrideEnv: unified });
  const before = (await request(base, { overrideEnv: unified })).data;
  assert.equal(before.capabilities.configuration, "verified"); assert.ok(before.verified_at);
  const stored = await db.prepare("SELECT capabilities_json FROM cloudflare_control_settings").first();
  assert.match(JSON.parse(stored.capabilities_json).credential_identity, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(before).includes("credential_identity")); assert.ok(!stored.capabilities_json.includes(configurationToken));
  for (const changed of [{ ...unified, CFKANBAN_API_TOKEN: nextToken }, { ...unified, CFKANBAN_CONTROL_DATABASE_ID: randomUUID() }]) {
    const result = (await request(base, { overrideEnv: changed })).data;
    assert.equal(result.capabilities.configuration, "unverified"); assert.equal(result.capabilities.analytics, "unverified"); assert.equal(result.verified_at, null);
  }
  await db.prepare("UPDATE cloudflare_control_settings SET capabilities_json=?1").bind(JSON.stringify({ configuration: "verified", analytics: "verified" })).run();
  assert.equal((await request(base, { overrideEnv: unified })).data.capabilities.configuration, "unverified");
});

test("验证期间另一个设置操作拒绝提交过期能力快照", async () => {
  let release, started; const pending = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { started = resolve; });
  router = new Router(); registerCloudflareControlRoutes(router, { fetch: async (url, init) => { if (new URL(url).pathname.endsWith("/graphql")) { started(); await pending; } return provider.fetch(url, init); } });
  const verification = request(`${base}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_API_TOKEN: configurationToken } });
  await reading;
  try { const updated = await request(`${base}/configuration/plan`, { method: "POST", body: { settings: { history_enabled: true }, expected_version: 1 } }); assert.equal(updated.status, 200); }
  finally { release(); }
  const stale = await verification; assert.equal(stale.status, 409, JSON.stringify(stale.data));
  const stored = await db.prepare("SELECT version,capabilities_json,verified_at FROM cloudflare_control_settings").first();
  assert.deepEqual(stored, { version: 2, capabilities_json: "{}", verified_at: null }); assert.equal(provider.mutations.length, 0);
});

test("统一 connection 一次自保存并保留旧绑定，非秘密 intent 兼容 schema 26", async () => {
  const oldNames = ["CFKANBAN_CONFIGURATION_TOKEN", "CFKANBAN_CONTROL_TOKEN", "USAGE_ANALYTICS_TOKEN"];
  provider.versions.get(provider.active).bindings.push(...oldNames.slice(1).map(name => ({ name, type: "secret_text" })));
  const unconfigured = { ...env, CFKANBAN_CONFIGURATION_TOKEN: undefined, CFKANBAN_CONTROL_TOKEN: undefined }, key = randomUUID(), body = { kind: "connection", token: nextToken, expected_version: 1 };
  provider.rejectRequest = ({ authorization }) => authorization !== `Bearer ${nextToken}`;
  const saved = await request(`${base}/secrets`, { method: "POST", body, key, overrideEnv: unconfigured });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.resource.kind, "configuration_secret"); assert.equal(saved.data.resource.status, "unknown");
  assert.deepEqual(provider.mutations.map(item => item.name), ["CFKANBAN_API_TOKEN"]);
  for (const name of oldNames) assert.ok(provider.versions.get(provider.active).bindings.some(binding => binding.name === name));
  const stored = (await db.prepare("SELECT * FROM cloudflare_control_operations").all()).results;
  assert.deepEqual(JSON.parse(stored[0].desired_json), { secret_kind: "connection", secret_name: "CFKANBAN_API_TOKEN" });
  const audit = (await db.prepare("SELECT payload_json FROM events WHERE type LIKE 'instance.cloudflare-control-%'").all()).results;
  for (const value of [saved.data, stored, audit]) assert.ok(!JSON.stringify(value).includes(nextToken));
  const replay = await request(`${base}/secrets`, { method: "POST", body, key, overrideEnv: unconfigured }); assert.equal(replay.data.idempotent_replay, true); assert.equal(provider.mutations.length, 1);
  const verified = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...unconfigured, CFKANBAN_API_TOKEN: nextToken } });
  assert.equal(verified.data.resource.status, "verified", JSON.stringify(verified.data)); assert.equal(provider.mutations.length, 1);
});
test("统一 Token 旋转使用输入值 preflight/selfsave，过期旧配置和旧统一授权不阻塞", async () => {
  provider.rejectRequest = ({ authorization }) => authorization !== `Bearer ${nextToken}`;
  const configured = { ...env, CFKANBAN_API_TOKEN: controlToken };
  const saved = await save("connection", nextToken, { overrideEnv: configured });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.resource.status, "unknown"); assert.equal(provider.mutations.length, 1);
  const wrongBinding = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_API_TOKEN: controlToken, CFKANBAN_CONFIGURATION_TOKEN: nextToken } });
  assert.notEqual(wrongBinding.data.resource.status, "verified");
  const verified = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_API_TOKEN: nextToken } });
  assert.equal(verified.data.resource.status, "verified"); assert.equal(provider.mutations.length, 1);
});
test("统一 binding 准确 presence，旧用途投影兼容；所有能力优先统一 Token 并独立核验", async () => {
  const legacy = await current(); assert.deepEqual(legacy.configured, { connection: false, configuration: true, control: true, analytics: false });
  const unified = { ...env, CFKANBAN_API_TOKEN: nextToken, USAGE_ACCOUNT_ID: target.account_id, USAGE_D1_DATABASE_ID: target.database_id };
  const configured = await request(base, { overrideEnv: unified });
  assert.deepEqual(configured.data.configured, { connection: true, configuration: true, control: true, analytics: true }); assert.equal(configured.data.configuration.analytics_enabled, true);
  provider.rejectRequest = ({ path, authorization }) => authorization !== `Bearer ${nextToken}` || path.endsWith("/policies") || path === "/graphql";
  const verified = await request(`${base}/verify`, { method: "POST", body: { include_optional: true }, overrideEnv: unified });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.deepEqual(verified.data.resource.capabilities, { configuration: "verified", notifications: "unsupported_contract", waf: "unsupported_contract", billing: "unsupported_contract", analytics: "permission_denied" });
  assert.equal(provider.mutations.length, 0);
});
test("配置读取故障独立返回，不阻断统计、通知、账务及WAF能力结果", async () => {
  await request(`${base}/settings`, { method: "PATCH", body: { zone_id: zoneId, expected_version: 1 } });
  provider.failureStatus = 503; provider.rejectRequest = ({ path }) => path.endsWith("/deployments");
  const verified = await request(`${base}/verify`, { method: "POST", body: { include_optional: true }, overrideEnv: { ...env, CFKANBAN_API_TOKEN: nextToken } });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.deepEqual(verified.data.resource.capabilities, { configuration: "unavailable", analytics: "verified", notifications: "unsupported_contract", waf: "unsupported_contract", billing: "unsupported_contract" });
  assert.equal(provider.mutations.length, 0);
});
test("旧 analytics operation 按精确旧 Secret hash 读回，统一值不能冒充旧绑定", async () => {
  const unified = { ...env, CFKANBAN_API_TOKEN: configurationToken };
  const saved = await save("analytics", nextToken, { overrideEnv: unified }); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const wrong = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...unified, CFKANBAN_API_TOKEN: nextToken } });
  assert.equal(wrong.data.resource.status, "unknown"); assert.equal(wrong.data.resource.failure_class, "secret_readback_pending");
  const verified = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...unified, USAGE_ANALYTICS_TOKEN: nextToken } });
  assert.equal(verified.data.resource.status, "verified"); assert.equal(provider.mutations.length, 1);
});
test("旧 control 保存只核对配置写者，候选可选能力失败不阻塞Secret写入", async () => {
  await request(`${base}/settings`, { method: "PATCH", body: { zone_id: zoneId, expected_version: 1 } });
  provider.rejectRequest = ({ path, authorization }) => path.endsWith("/policies") || path.endsWith("/billable-usage/info") || authorization === `Bearer ${nextToken}`;
  const saved = await save("control", nextToken, { overrideEnv: { ...env, CFKANBAN_API_TOKEN: configurationToken } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(provider.mutations.length, 1); assert.equal(provider.mutations[0].name, "CFKANBAN_CONTROL_TOKEN");
  assert.ok(provider.requests.every(call => call.path.startsWith(`/accounts/${target.account_id}/workers/scripts/${target.worker_name}/`)));
});
test("统一 connection 的并发/unknown 重放保持锁，CAS、候选和基线漂移拒绝", async () => {
  provider.mode = "network_after"; const body = { kind: "connection", token: nextToken, expected_version: 1 }, key = randomUUID();
  const results = await Promise.all([request(`${base}/secrets`, { method: "POST", body, key }), request(`${base}/secrets`, { method: "POST", body, key })]);
  assert.ok(results.some(result => result.status === 200)); assert.equal(provider.mutations.length, 1);
  const saved = await request(`${base}/secrets`, { method: "POST", body, key }); assert.equal(saved.data.resource.status, "unknown"); assert.equal(saved.data.idempotent_replay, true);
  assert.ok((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id);
  const locked = await save("connection", configurationToken); assert.equal(locked.status, 409); assert.equal(provider.mutations.length, 1);
  provider.versions.get(provider.active).bindings.find(binding => binding.name === "FOREIGN_VAR").text = "foreign drift";
  const drift = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_API_TOKEN: nextToken } });
  assert.equal(drift.data.resource.status, "unknown"); assert.equal(drift.data.resource.failure_class, "cloudflare_foreign_configuration_drift"); assert.equal(provider.mutations.length, 1);
});
test("统一 connection 保存同样拒绝权限不足、错误DB、未部署候选和陈旧CAS", async () => {
  provider.denied = true; assert.equal((await save("connection", nextToken)).status, 403); provider.denied = false;
  const active = provider.versions.get(provider.active); active.bindings[0].id = randomUUID(); assert.equal((await save("connection", nextToken)).status, 409); active.bindings[0].id = target.database_id;
  provider.latest = randomUUID(); provider.versions.set(provider.latest, structuredClone(active)); assert.equal((await save("connection", nextToken)).status, 400); provider.latest = provider.active;
  assert.equal((await request(`${base}/secrets`, { method: "POST", body: { kind: "connection", token: nextToken, expected_version: 9 } })).status, 409); assert.equal(provider.mutations.length, 0);
});
test("重复、并发与HTTP结果不确定均不重发外部秘密写入；恢复只读核验新值", async () => {
  provider.mode = "network_after"; const body = { kind: "control", token: nextToken, expected_version: 1 }, key = randomUUID();
  const results = await Promise.all([request(`${base}/secrets`, { method: "POST", body, key }), request(`${base}/secrets`, { method: "POST", body, key })]);
  assert.ok(results.some(result => result.status === 200), JSON.stringify(results.map(result => result.data))); assert.equal(provider.mutations.length, 1);
  const result = await request(`${base}/secrets`, { method: "POST", body, key }); assert.equal(result.status, 200); assert.equal(result.data.idempotent_replay, true); assert.equal(result.data.resource.status, "unknown");
  const oldReadback = await request(`${base}/operations/${result.data.resource.operation_id}/verify`, { method: "POST", body: {} }); assert.notEqual(oldReadback.data.resource.status, "verified");
  const recovery = await request(`${base}/operations/${result.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_CONTROL_TOKEN: nextToken } }); assert.equal(recovery.data.resource.status, "verified"); assert.equal(provider.mutations.length, 1);
});
test("权限不足、目标D1不符、候选未部署和CAS冲突均拒绝写入", async () => {
  provider.denied = true; const denied = await save("control", nextToken); assert.ok(denied.status >= 400); assert.ok(!JSON.stringify(denied.data).includes("provider-secret"));
  provider.denied = false; const activeSettings = provider.versions.get(provider.active); activeSettings.bindings[0].id = randomUUID(); assert.ok((await save("control", nextToken)).status >= 400); activeSettings.bindings[0].id = target.database_id;
  provider.latest = randomUUID(); provider.versions.set(provider.latest, structuredClone(activeSettings)); assert.equal((await save("control", nextToken)).status, 400); provider.latest = provider.active;
  const stale = await request(`${base}/secrets`, { method: "POST", body: { kind: "control", token: nextToken, expected_version: 9 } }); assert.equal(stale.status, 409); assert.equal(provider.mutations.length, 0);
});
test("限流计划冻结原生namespace，外部所有绑定逐项inherit；候选版本不自动部署", async () => {
  provider.mode = "pending";
  const planned = await request(`${base}/rate-limits/plan`, { method: "POST", body: { scope: "instance", limit: 500, period_seconds: 10, expected_version: 1 } }); assert.equal(planned.status, 200, JSON.stringify(planned.data)); assert.equal(planned.data.resource.before.limit, 300);
  const body = { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version }, key = randomUUID(), applied = await request(`${base}/rate-limits/apply`, { method: "POST", body, key }); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.resource.status, "pending");
  const patch = provider.mutations[0].patch; assert.deepEqual(patch.limits, { cpu_ms: 10 }); assert.deepEqual(patch.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(patch.cache_options, { enabled: false, cross_version_cache: false });
  assert.equal(patch.bindings.find(binding => binding.name === "INSTANCE_RATE_LIMITER").namespace_id, "1001");
  for (const name of ["DB", "FOREIGN_SECRET", "FOREIGN_VAR", "CFKANBAN_CONFIGURATION_TOKEN"]) assert.deepEqual(patch.bindings.find(binding => binding.name === name), { name, type: "inherit", version_id: planned.data.resource.baseline_version_id });
  const replay = await request(`${base}/rate-limits/apply`, { method: "POST", body, key }); assert.equal(replay.data.idempotent_replay, true); assert.equal(provider.mutations.length, 1);
  provider.active = provider.latest; provider.deployment = randomUUID();
  const readback = await request(`${base}/operations/${applied.data.resource.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(readback.data.resource.status, "verified", JSON.stringify(readback.data)); assert.equal(provider.mutations.length, 1);
});
test("历史与analytics设置仅从固定目标派生，保留旧配置并验证当前部署", async () => {
  const planned = await request(`${base}/configuration/plan`, { method: "POST", body: { settings: { history_enabled: true, analytics_enabled: true, billing_plan: "free" }, expected_version: 1 } }); assert.equal(planned.status, 200, JSON.stringify(planned.data)); assert.equal(planned.data.resource.after.history_enabled, true);
  const applied = await request(`${base}/configuration/apply`, { method: "POST", body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version } }); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.resource.status, "verified", JSON.stringify(applied.data));
  const bindings = provider.versions.get(provider.active).bindings;
  for (const [name, value] of [["USAGE_ACCOUNT_ID", target.account_id], ["USAGE_WORKER_NAME", target.worker_name], ["USAGE_D1_DATABASE_ID", target.database_id], ["USAGE_HISTORY_ENABLED", "true"]]) assert.equal(bindings.find(binding => binding.name === name).text, value);
});
test("供应商新版本漂移或不支持的设置均不能产生假成功", async () => {
  const plan = await request(`${base}/rate-limits/plan`, { method: "POST", body: { scope: "instance", limit: 500, period_seconds: 60, expected_version: 1 } });
  provider.versions.get(provider.active).bindings.find(binding => binding.name === "FOREIGN_VAR").text = "changed by another actor";
  const apply = await request(`${base}/rate-limits/apply`, { method: "POST", body: { plan_id: plan.data.resource.plan_id, expected_version: plan.data.resource.version } }); assert.equal(apply.status, 400); assert.equal(provider.mutations.length, 0);
  provider.versions.get(provider.active).unsupported_future_setting = true;
  assert.equal((await request(`${base}/rate-limits/plan`, { method: "POST", body: { scope: "instance", limit: 501, period_seconds: 60, expected_version: (await current()).version } })).status, 400);
});
test("通知、Zone变更和新提醒设置退役，拒绝时不访问供应商", async () => {
  for (const [path, options] of [["notifications", {}], ["settings", { method: "PATCH", body: { zone_id: zoneId, expected_version: 1 } }], ["configuration/plan", { method: "POST", body: { settings: { warning_percent: 90 }, expected_version: 1 } }]]) {
    const response = await request(`${base}/${path}`, options); assert.equal(response.status, 400); assert.equal(response.data.details.reason, "cloudflare_feature_retired");
  }
  assert.equal(provider.requests.length, 0); assert.equal(provider.mutations.length, 0);
});

test("大响应和安全事件失败均不会触发云写；数据库意图保持原子", async () => {
  provider.oversized = true; assert.ok((await save("control", nextToken)).status >= 400); provider.oversized = false;
  await db.prepare("CREATE TRIGGER cloudflare_test_reject BEFORE INSERT ON events WHEN NEW.type='instance.cloudflare-control-intent' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END").run();
  try { assert.ok((await save("control", nextToken)).status >= 500); assert.equal((await current()).version, 1); assert.equal((await db.prepare("SELECT count(*) AS n FROM cloudflare_control_operations").first()).n, 0); assert.equal(provider.mutations.length, 0); }
  finally { await db.prepare("DROP TRIGGER cloudflare_test_reject").run(); }
});
test("冻结计划读回和回放不依赖后续供应商漂移；核验幂等键回放不再追加事件", async () => {
  const body = { scope: "instance", limit: 500, period_seconds: 60, expected_version: 1 }, key = randomUUID();
  const planned = await request(`${base}/rate-limits/plan`, { method: "POST", body, key }); assert.equal(planned.status, 200);
  const readback = await request(`${base}/plans/${planned.data.resource.plan_id}`); assert.deepEqual(readback.data, planned.data.resource); assert.equal((await request(`${base}/plans/${randomUUID()}`)).status, 404);
  provider.denied = true; const replay = await request(`${base}/rate-limits/plan`, { method: "POST", body, key }); assert.deepEqual(replay.data.resource, planned.data.resource); assert.equal(replay.data.idempotent_replay, true); provider.denied = false;
  const saved = await save("control", nextToken), path = `${base}/operations/${saved.data.resource.operation_id}/verify`, verifyKey = randomUUID();
  const first = await request(path, { method: "POST", body: {}, key: verifyKey, overrideEnv: { ...env, CFKANBAN_CONTROL_TOKEN: nextToken } }); assert.equal(first.data.resource.status, "verified");
  const count = (await db.prepare("SELECT count(*) AS n FROM events").first()).n;
  const second = await request(path, { method: "POST", body: {}, key: verifyKey }); assert.equal(second.data.idempotent_replay, true); assert.deepEqual(second.data.resource, first.data.resource); assert.equal((await db.prepare("SELECT count(*) AS n FROM events").first()).n, count);
});
test("保存前凭据撤销由新鲜Owner守卫拒绝，不持久意图也不发送云写", async () => {
  const originalFetch = provider.fetch; let revoked = false;
  provider.fetch = async (...args) => { const response = await originalFetch(...args); if (!revoked) { revoked = true; await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), credentialId).run(); } return response; };
  router = new Router(); registerCloudflareControlRoutes(router, { fetch: provider.fetch });
  try { const result = await request(`${base}/secrets`, { method: "POST", body: { kind: "control", token: nextToken, expected_version: 1 } }); assert.equal(result.status, 401); assert.equal(provider.mutations.length, 0); assert.equal((await db.prepare("SELECT count(*) AS n FROM cloudflare_control_operations").first()).n, 0); }
  finally { await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(credentialId).run(); }
});
test("新Secret值即使可见，代码或外国绑定漂移仍保留unknown锁，不伪造成功", async () => {
  const saved = await save("control", nextToken); assert.equal(saved.status, 200); assert.notEqual(saved.data.resource.status, "verified");
  provider.versions.get(provider.active).bindings.find(binding => binding.name === "FOREIGN_VAR").text = "unexpected change";
  const readback = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_CONTROL_TOKEN: nextToken } }); assert.equal(readback.data.resource.status, "unknown"); assert.equal(readback.data.resource.failure_class, "cloudflare_foreign_configuration_drift"); assert.ok((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id); assert.equal(provider.mutations.length, 1);
});
for (const kind of ["control", "analytics"]) test(`旧${kind}用途先保存，候选缺权限仅影响后续该项能力检查`, async () => {
  provider.rejectedToken = nextToken;
  const saved = await save(kind, nextToken);
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.resource.status, "unknown"); assert.equal(provider.mutations.length, 1);
  assert.equal(provider.mutations[0].name, kind === "control" ? "CFKANBAN_CONTROL_TOKEN" : "USAGE_ANALYTICS_TOKEN");
  assert.ok(provider.requests.every(call => call.path.startsWith(`/accounts/${target.account_id}/workers/scripts/${target.worker_name}/`)));
  const configured = { ...env, [kind === "control" ? "CFKANBAN_CONTROL_TOKEN" : "USAGE_ANALYTICS_TOKEN"]: nextToken };
  const confirmed = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: configured });
  assert.equal(confirmed.data.resource.status, "verified");
  const verified = await request(`${base}/verify`, { method: "POST", body: { include_optional: true }, overrideEnv: configured });
  assert.equal(verified.status, 200, JSON.stringify(verified.data)); assert.equal(verified.data.resource.capabilities.configuration, "verified");
  if (kind === "control") { assert.equal(verified.data.resource.capabilities.notifications, "unsupported_contract"); assert.equal(verified.data.resource.capabilities.billing, "unsupported_contract"); }
  else { assert.equal(verified.data.resource.capabilities.analytics, "permission_denied"); assert.equal(verified.data.resource.capabilities.notifications, "unsupported_contract"); }
  assert.equal(provider.mutations.length, 1);
});
test("旧部署未显式设置analytics flag时，局部修改不关闭既有有效采集", async () => {
  provider.versions.get(provider.active).bindings.push({ name: "USAGE_ACCOUNT_ID", type: "plain_text", text: target.account_id }, { name: "USAGE_D1_DATABASE_ID", type: "plain_text", text: target.database_id }, { name: "USAGE_ANALYTICS_TOKEN", type: "secret_text" });
  const planned = await request(`${base}/configuration/plan`, { method: "POST", body: { settings: { history_enabled: true }, expected_version: 1 } }); assert.equal(planned.status, 200, JSON.stringify(planned.data)); assert.equal(planned.data.resource.before.analytics_enabled, true); assert.equal(planned.data.resource.after.analytics_enabled, true);
  const applied = await request(`${base}/configuration/apply`, { method: "POST", body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version } }); assert.equal(applied.data.resource.status, "verified"); assert.equal(provider.versions.get(provider.active).bindings.find(binding => binding.name === "USAGE_ANALYTICS_ENABLED").text, "true");
});
test("统一 Secret 的隐式 analytics 开关被局部设置计划保留，其他旧 Secret 仍逐项 inherit", async () => {
  provider.versions.get(provider.active).bindings.push({ name: "USAGE_ACCOUNT_ID", type: "plain_text", text: target.account_id }, { name: "USAGE_D1_DATABASE_ID", type: "plain_text", text: target.database_id }, { name: "CFKANBAN_API_TOKEN", type: "secret_text" }, { name: "CFKANBAN_CONTROL_TOKEN", type: "secret_text" });
  const unified = { ...env, CFKANBAN_API_TOKEN: nextToken };
  provider.rejectRequest = ({ authorization }) => authorization !== `Bearer ${nextToken}`;
  const planned = await request(`${base}/configuration/plan`, { method: "POST", body: { settings: { history_enabled: true }, expected_version: 1 }, overrideEnv: unified });
  assert.equal(planned.status, 200, JSON.stringify(planned.data)); assert.equal(planned.data.resource.before.analytics_enabled, true); assert.equal(planned.data.resource.after.analytics_enabled, true);
  const applied = await request(`${base}/configuration/apply`, { method: "POST", body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version }, overrideEnv: unified });
  assert.equal(applied.data.resource.status, "verified", JSON.stringify(applied.data));
  for (const name of ["CFKANBAN_API_TOKEN", "CFKANBAN_CONFIGURATION_TOKEN", "CFKANBAN_CONTROL_TOKEN"]) assert.deepEqual(provider.mutations[0].patch.bindings.find(binding => binding.name === name), { name, type: "inherit", version_id: planned.data.resource.baseline_version_id });
});
test("秘密 operation 的 intent 名称与用途必须匹配白名单，不读取任意 env binding", async () => {
  const saved = await save("connection", nextToken); const id = saved.data.resource.operation_id;
  await db.prepare("UPDATE cloudflare_control_operations SET desired_json=?2 WHERE id=?1").bind(id, JSON.stringify({ secret_kind: "connection", secret_name: "FOREIGN_SECRET" })).run();
  const checked = await request(`${base}/operations/${id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_API_TOKEN: nextToken, FOREIGN_SECRET: nextToken } });
  assert.equal(checked.data.resource.status, "unknown"); assert.equal(checked.data.resource.failure_class, "target_mismatch"); assert.equal(provider.mutations.length, 1);
});
test("候选B未部署、同代码旧C被部署时，不能用最新候选绑定宣告active成功", async () => {
  provider.mode = "pending"; const original = provider.active;
  const planned = await request(`${base}/rate-limits/plan`, { method: "POST", body: { scope: "instance", limit: 500, period_seconds: 60, expected_version: 1 } });
  const applied = await request(`${base}/rate-limits/apply`, { method: "POST", body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version } }); assert.equal(applied.data.resource.status, "pending");
  const candidate = provider.latest, rollback = randomUUID(); provider.versions.set(rollback, structuredClone(provider.versions.get(original))); provider.active = rollback; provider.deployment = randomUUID();
  const readback = await request(`${base}/operations/${applied.data.resource.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(readback.data.resource.status, "unknown"); assert.equal(readback.data.resource.failure_class, "cloudflare_version_drift"); assert.equal(readback.data.resource.result_version_id, candidate); assert.ok((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id); assert.equal(provider.mutations.length, 1);
});
test("秘密PUT已成功但后续GET无权，保持unknown写锁；恢复不重新PUT", async () => {
  provider.readFailureAfterMutation = 403; const body = { kind: "control", token: nextToken, expected_version: 1 }, key = randomUUID();
  const saved = await request(`${base}/secrets`, { method: "POST", body, key }); assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.resource.status, "unknown"); assert.equal(saved.data.resource.failure_class, "permission_denied"); assert.ok((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id);
  const duplicate = await request(`${base}/secrets`, { method: "POST", body, key }); assert.equal(duplicate.data.idempotent_replay, true); assert.equal(provider.mutations.length, 1);
  provider.readFailureAfterMutation = null; const recovered = await request(`${base}/operations/${saved.data.resource.operation_id}/verify`, { method: "POST", body: {}, overrideEnv: { ...env, CFKANBAN_CONTROL_TOKEN: nextToken } }); assert.equal(recovered.data.resource.status, "verified"); assert.equal(provider.mutations.length, 1);
});
test("settings PATCH已成功但后续GET无权，也保持unknown写锁", async () => {
  const planned = await request(`${base}/rate-limits/plan`, { method: "POST", body: { scope: "instance", limit: 500, period_seconds: 60, expected_version: 1 } }); provider.readFailureAfterMutation = 401;
  const body = { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version }, key = randomUUID(), applied = await request(`${base}/rate-limits/apply`, { method: "POST", body, key }); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.resource.status, "unknown"); assert.equal(applied.data.resource.failure_class, "permission_denied"); assert.ok((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id);
  const duplicate = await request(`${base}/rate-limits/apply`, { method: "POST", body, key }); assert.equal(duplicate.data.idempotent_replay, true); assert.equal(provider.mutations.length, 1);
  provider.readFailureAfterMutation = null; const recovered = await request(`${base}/operations/${applied.data.resource.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(recovered.data.resource.status, "verified"); assert.equal(provider.mutations.length, 1);
});
async function applyLostPlan(kind, settings = { history_enabled: true, analytics_enabled: true }) {
  const path = kind === "rate_limit" ? "rate-limits" : "configuration";
  const input = kind === "rate_limit" ? { scope: "instance", limit: 500, period_seconds: 10 } : { settings };
  const planned = await request(`${base}/${path}/plan`, { method: "POST", body: { ...input, expected_version: 1 } }); assert.equal(planned.status, 200, JSON.stringify(planned.data));
  provider.mode = "network_after";
  const body = { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version }, key = randomUUID();
  const applied = await request(`${base}/${path}/apply`, { method: "POST", body, key }); assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.resource.status, "unknown"); assert.equal(applied.data.resource.result_version_id, null); assert.equal(provider.mutations.length, 1);
  return { operationId: applied.data.resource.operation_id, path: `${base}/${path}/apply`, body, key };
}
const rateBinding = bindings => bindings.find(binding => binding.name === "INSTANCE_RATE_LIMITER");
const changeText = (name, value) => bindings => { bindings.find(binding => binding.name === name).text = value; };
const removeBinding = name => bindings => { bindings.splice(bindings.findIndex(binding => binding.name === name), 1); };
for (const scenario of [
  { name: "limit policy var", kind: "rate_limit", change: changeText("RATE_LIMIT_INSTANCE_LIMIT", "300") },
  { name: "period policy var", kind: "rate_limit", change: changeText("RATE_LIMIT_INSTANCE_PERIOD_SECONDS", "60") },
  { name: "namespace", kind: "rate_limit", change: bindings => { rateBinding(bindings).namespace_id = "2002"; } },
  { name: "native simple.limit", kind: "rate_limit", change: bindings => { rateBinding(bindings).simple.limit = 300; } },
  { name: "native simple.period", kind: "rate_limit", change: bindings => { rateBinding(bindings).simple.period = 60; } },
  { name: "missing policy var", kind: "rate_limit", change: removeBinding("RATE_LIMIT_INSTANCE_LIMIT") },
  { name: "Analytics Account", kind: "configuration", change: changeText("USAGE_ACCOUNT_ID", "foreign-account") },
  { name: "Analytics DB", kind: "configuration", change: changeText("USAGE_D1_DATABASE_ID", randomUUID()) },
  { name: "Analytics Worker", kind: "configuration", change: changeText("USAGE_WORKER_NAME", "foreign-worker") },
  { name: "missing Analytics target", kind: "configuration", change: removeBinding("USAGE_ACCOUNT_ID") },
  { name: "missing explicit history flag", kind: "configuration", settings: { history_enabled: false, analytics_enabled: false }, change: removeBinding("USAGE_HISTORY_ENABLED") },
  { name: "missing explicit Analytics flag", kind: "configuration", settings: { history_enabled: false, analytics_enabled: false }, change: removeBinding("USAGE_ANALYTICS_ENABLED") },
  { name: "preserved target with collection disabled", kind: "configuration", settings: { history_enabled: false, analytics_enabled: false }, setup: bindings => { bindings.push({ name: "USAGE_ACCOUNT_ID", type: "plain_text", text: target.account_id }); }, change: changeText("USAGE_ACCOUNT_ID", "foreign-account") },
]) {
  test(`PATCH丢响应后的${scenario.name}漂移不能确认成功，正确版本仍可恢复`, async () => {
    scenario.setup?.(provider.versions.get(provider.active).bindings);
    const operation = await applyLostPlan(scenario.kind, scenario.settings), acceptedVersion = provider.active;
    const drift = structuredClone(provider.versions.get(acceptedVersion)); scenario.change(drift.bindings); provider.publish(drift);
    const checked = await request(`${base}/operations/${operation.operationId}/verify`, { method: "POST", body: {} });
    assert.equal(checked.status, 200, JSON.stringify(checked.data)); assert.equal(checked.data.resource.status, "unknown"); assert.equal(checked.data.resource.failure_class, "configuration_readback_mismatch");
    assert.equal(checked.data.resource.result_version_id, null, "a mismatched foreign version cannot become the operation result");
    assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, operation.operationId);
    const replay = await request(operation.path, { method: "POST", body: operation.body, key: operation.key }); assert.equal(replay.data.idempotent_replay, true); assert.equal(provider.mutations.length, 1);
    provider.active = acceptedVersion; provider.latest = acceptedVersion; provider.deployment = randomUUID();
    const recovered = await request(`${base}/operations/${operation.operationId}/verify`, { method: "POST", body: {} });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data)); assert.equal(recovered.data.resource.status, "verified"); assert.equal(recovered.data.resource.result_version_id, acceptedVersion);
    assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, null); assert.equal(provider.mutations.length, 1);
  });
}
for (const kind of ["rate_limit", "configuration"]) {
  test(`${kind} PATCH丢响应后完整正确的active绑定可直接恢复`, async () => {
    const operation = await applyLostPlan(kind), acceptedVersion = provider.active;
    const recovered = await request(`${base}/operations/${operation.operationId}/verify`, { method: "POST", body: {} });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data)); assert.equal(recovered.data.resource.status, "verified"); assert.equal(recovered.data.resource.result_version_id, acceptedVersion);
    assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, null); assert.equal(provider.mutations.length, 1);
  });
}
test("已知候选结果版本不能被同配置的外部版本替代，原候选仍可恢复", async () => {
  provider.mode = "pending";
  const planned = await request(`${base}/rate-limits/plan`, { method: "POST", body: { scope: "instance", limit: 500, period_seconds: 10, expected_version: 1 } }); assert.equal(planned.status, 200, JSON.stringify(planned.data));
  const applied = await request(`${base}/rate-limits/apply`, { method: "POST", body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version } }); assert.equal(applied.data.resource.status, "pending");
  const candidate = provider.latest; assert.equal(applied.data.resource.result_version_id, candidate);
  provider.mode = "deploy"; provider.publish(provider.versions.get(candidate));
  const checked = await request(`${base}/operations/${applied.data.resource.operation_id}/verify`, { method: "POST", body: {} });
  assert.equal(checked.data.resource.status, "unknown"); assert.equal(checked.data.resource.failure_class, "cloudflare_version_drift"); assert.equal(checked.data.resource.result_version_id, candidate);
  assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, applied.data.resource.operation_id);
  provider.active = candidate; provider.latest = candidate; provider.deployment = randomUUID();
  const recovered = await request(`${base}/operations/${applied.data.resource.operation_id}/verify`, { method: "POST", body: {} });
  assert.equal(recovered.data.resource.status, "verified", JSON.stringify(recovered.data)); assert.equal(recovered.data.resource.result_version_id, candidate); assert.equal(provider.mutations.length, 1);
});
