import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { registerCloudflareControlRoutes } from "../../apps/worker/src/routes/cloudflare-control.ts";
import { Router } from "../../apps/worker/src/kernel/router.ts";
import { createRequestContext } from "../../apps/worker/src/kernel/http.ts";
import { errorResponse } from "../../apps/worker/src/kernel/errors.ts";
import { authenticateRequest } from "../../apps/worker/src/kernel/auth.ts";
import { canonicalJson, claimIdempotency, computeRequestHash } from "../../apps/worker/src/kernel/idempotency.ts";
import { ownedExpression, intent, localChange, transition } from "../../apps/worker/src/services/cloudflare-control.ts";

// This harness never contacts Cloudflare: its isolated D1 and provider are synthetic.
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] }), worker = server.getWorker();
const ownerId = randomUUID(), credentialId = randomUUID(), instanceId = randomUUID(), ownerToken = `cfk_v1_owner_${"A".repeat(43)}`, cfToken = "K".repeat(40), zoneId = "b".repeat(32), accountId = "a".repeat(32), databaseId = randomUUID(), hostname = "waf.example.test", base = "/api/v1/admin/cloudflare";
const digest = value => createHash("sha256").update(value).digest("hex");
let env, db, router, provider;
const response = (result, status = 200, info) => new Response(JSON.stringify({ success: status === 200, result, ...(info ? { result_info: info } : {}) }), { status });
function fakeProvider() {
  const state = { sets: [], writes: [], gets: [], workersDev: false, previews: false, domainDenied: false, wrongDomain: false, lostResponse: false, failRead: false, pages: 1, rulePages: 1, active: randomUUID(), runtimeFlags: ["global_fetch_strictly_public"], proofWrong: false, skipProof: false, disabledRead: false, ipRules: [], ipDenied: false };
  const bindings = [{ name: "DB", type: "d1", id: databaseId }, { name: "CFKANBAN_API_TOKEN", type: "secret_text" }];
  state.fetch = async (url, init = {}) => {
    const parsed = new URL(url), method = init.method ?? "GET";
    assert.equal(init.redirect, "manual"); assert.ok(init.signal);
    if (parsed.origin === `https://${hostname}`) {
      assert.equal(parsed.pathname, "/.well-known/cfkanban-waf-proof"); assert.equal(method, "POST"); assert.ok(!Object.hasOwn(init.headers, "authorization")); assert.ok(!JSON.stringify(init).includes(cfToken));
      if (state.skipProof) return new Response("blocked", { status: 403 });
      const req = new Request(url, init), context = createRequestContext(req);
      try { return await router.dispatch(req, state.proofWrong ? { ...env, CFKANBAN_API_TOKEN: "WRONG".repeat(8) } : env, context); } catch (error) { return errorResponse(error, context.requestId); }
    }
    assert.equal(parsed.origin, "https://api.cloudflare.com");
    const path = parsed.pathname.replace("/client/v4", ""); state.gets.push({ path, method });
    if (state.beforeRequest) await state.beforeRequest(path, method);
    if (method === "GET" && state.failRead && state.writes.length) return response(null, 503);
    if (path.endsWith("/deployments")) return response({ deployments: [{ id: "deployment", versions: [{ version_id: state.active, percentage: 100 }] }] });
    if (path.endsWith("/versions")) return response({ items: [{ id: state.candidate ?? state.active }] });
    if (/\/versions\/[^/]+$/.test(path)) return response({ resources: { bindings: state.wrongActiveDatabase ? bindings.map(binding => binding.type === "d1" ? { ...binding, id: randomUUID() } : binding) : bindings, script: { etag: "code" }, script_runtime: { compatibility_flags: state.runtimeFlags } } });
    if (path.endsWith("/settings")) return response({ bindings: state.candidate ? [{ name: "DB", type: "d1", id: "candidate-other-db" }] : bindings, compatibility_date: "2026-08-29" });
    if (path.endsWith("/subdomain")) return response({ enabled: state.workersDev, previews_enabled: state.previews });
    if (path.endsWith("/workers/domains")) { assert.equal(parsed.searchParams.get("hostname"), hostname); assert.equal(parsed.searchParams.get("service"), "fixture-worker"); assert.equal(parsed.searchParams.get("zone_id"), zoneId); return state.domainDenied ? response(null, 403) : response([{ id: "domain1", hostname, service: state.wrongDomain ? "another-worker" : "fixture-worker", zone_id: zoneId }]); }
    if (path.endsWith("/firewall/access_rules/rules")) return state.ipDenied ? response(null, 403) : response(state.ipRules);
    if (path === `/zones/${zoneId}`) return response({ id: zoneId, name: "example.test", status: "active", account: { id: accountId } });
    if (path === `/zones/${zoneId}/rulesets` && method === "GET") return response(state.sets.map(set => ({ id: set.id, kind: set.kind, phase: set.phase })), 200, { total_pages: state.pages, total_count: state.sets.length });
    if (path.endsWith("/entrypoint")) { const set = state.sets.find(set => set.kind === "zone"); return set ? response(set) : response(null, 404); }
    if (path === `/zones/${zoneId}/rulesets` && method === "POST") {
      const body = JSON.parse(init.body); assert.equal(body.kind, "zone"); assert.equal(body.rules.length, 1); state.writes.push({ method, path, body });
      const set = { ...body, id: randomUUID(), rules: body.rules.map(rule => ({ ...rule, id: randomUUID() })) }; state.sets.push(set);
      if (state.lostResponse) throw new Error("synthetic response lost"); return response(set);
    }
    const match = new RegExp(`^/zones/${zoneId}/rulesets/([^/]+)(?:/rules(?:/([^/]+))?)?$`).exec(path);
    if (match) {
      const set = state.sets.find(set => set.id === match[1]); if (!set) return response(null, 404);
      if (method === "GET") return response(set, 200, { total_pages: state.rulePages, ...(state.ruleCount === undefined ? {} : { total_count: state.ruleCount }) });
      state.writes.push({ method, path, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      if (method === "DELETE") { assert.ok(match[2]); set.rules = set.rules.filter(rule => rule.id !== match[2]); }
      if (method === "POST" || method === "PATCH") { const { position, ...body } = JSON.parse(init.body); const rule = { ...body, id: match[2] ?? randomUUID() }; set.rules = set.rules.filter(entry => entry.id !== rule.id); const index = position?.before ? set.rules.findIndex(entry => entry.id === position.before) : -1; if (index >= 0) set.rules.splice(index, 0, rule); else set.rules.push(rule); }
      if (state.lostResponse) throw new Error("synthetic response lost"); return response(set);
    }
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  };
  return state;
}
function entrypoint(rules = []) { return { id: "entrypoint", kind: "zone", phase: "http_request_firewall_custom", rules }; }
const foreign = (id = "foreign", extra = {}) => ({ id, ref: id, description: "foreign", enabled: true, action: "block", expression: '(http.host eq "elsewhere.example.test")', ...extra });
async function request(path, { method = "GET", body, key = randomUUID(), headers = { authorization: `Bearer ${ownerToken}` }, overrideEnv = env } = {}) {
  const req = new Request(`https://${hostname}${path}`, { method, headers: { ...headers, "idempotency-key": key, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), context = createRequestContext(req);
  let result; try { result = await router.dispatch(req, overrideEnv, context); } catch (error) { result = errorResponse(error, context.requestId); }
  return { status: result.status, data: await result.json() };
}
const current = async () => (await request(base)).data;
const plan = async (action = "enable", choice) => request(`${base}/waf/plan`, { method: "POST", body: { action, expected_version: (await current()).version, ...(choice ? { conflict_choice: choice } : {}) } });
const apply = async (planned, extra = {}) => request(`${base}/waf/apply`, { method: "POST", body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version }, ...extra });
const bind = async () => request(`${base}/waf/target-binding`, { method: "POST", body: { expected_version: (await current()).version } });
before(async () => { await server.listen(); await worker.applyD1Migrations("DB"); const original = await worker.getEnv(); db = original.DB; await bootstrapInstance(db, { instanceId, operationId: randomUUID(), ownerCredentialId: credentialId, ownerCredentialToken: ownerToken, ownerDisplayName: "Waf_Owner", ownerPrincipalId: ownerId, preferredApiOrigin: `https://${hostname}` }); env = { ...original, CFKANBAN_CONTROL_ACCOUNT_ID: accountId, CFKANBAN_CONTROL_WORKER_NAME: "fixture-worker", CFKANBAN_CONTROL_DATABASE_ID: databaseId, CFKANBAN_API_TOKEN: cfToken }; });
beforeEach(async () => { provider = fakeProvider(); router = new Router(); registerCloudflareControlRoutes(router, { fetch: provider.fetch }); await db.batch([db.prepare("DELETE FROM cloudflare_control_plans"), db.prepare("DELETE FROM cloudflare_control_operations"), db.prepare("DELETE FROM cloudflare_waf_target_binding"), db.prepare("UPDATE cloudflare_waf_ownership SET binding_id=NULL,rule_id=NULL,ruleset_id=NULL,rule_ref=NULL,rule_digest=NULL,operation_id=NULL,verified_at=NULL"), db.prepare("UPDATE cloudflare_control_settings SET version=1,zone_id=?1,capabilities_json='{}',verified_at=NULL,latest_operation_id=NULL,locked_operation_id=NULL,last_operation_id=NULL").bind(zoneId), db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(credentialId)]); });
after(() => server.close());

async function legacyIntent({ dispatched = true, rules = [], create = false } = {}) {
  const bindingId = randomUUID(), marker = randomUUID(), key = randomUUID(), planId = randomUUID(), domain = { id: "domain1", hostname, service: "fixture-worker", zone_id: zoneId };
  const origin = await db.prepare("SELECT version FROM instance_origin_settings WHERE singleton=1").first();
  await db.prepare("INSERT INTO cloudflare_waf_target_binding(singleton,binding_id,account_id,worker_name,database_id,instance_id,hostname,zone_id,domain_id,origin_version,provider_metadata_hash,source,verified_at,operation_id) VALUES(1,?1,?2,'fixture-worker',?3,?4,?5,?6,'domain1',?7,?8,'worker_domain_read',?9,?10)").bind(bindingId, accountId, databaseId, instanceId, hostname, zoneId, origin.version, digest(canonicalJson(domain)), Date.now(), randomUUID()).run();
  provider.sets = create ? [] : [entrypoint(structuredClone(rules))];
  const target = { account_id: accountId, worker_name: "fixture-worker", database_id: databaseId, instance_id: instanceId, hostname, zone_id: zoneId, domain_id: "domain1" };
  const rule = { ref: `cfkanban_${instanceId.replaceAll("-", "")}_anonymous_api_${marker.replaceAll("-", "")}`, description: `cfKanban ${instanceId} anonymous private API filter`, enabled: true, action: "block", expression: ownedExpression(hostname) };
  const baseline = { target, binding_id: bindingId, origin_version: origin.version, provider_metadata_hash: digest(canonicalJson(domain)), token_hash: digest(cfToken), ip_access_digest: digest(canonicalJson([])), foreign_rules_digest: digest(canonicalJson(provider.sets)), entrypoint_id: create ? null : "entrypoint", entrypoint_rule_ids: rules.map(rule => rule.id), owned_rule_id: null, owned_ruleset_id: null, owned_rule_digest: null, rule_refs: rules.map(rule => rule.ref) };
  const desired = { action: "enable", entrypoint_strategy: create ? "create_entrypoint" : "append_rule", entrypoint_id: baseline.entrypoint_id, position_before: null, rule };
  const body = { plan_id: planId, expected_version: 1 }, req = new Request(`https://${hostname}${base}/waf/apply`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify(body) }), auth = await authenticateRequest(db, req, Date.now());
  const row = await intent(env, req, auth, "waf", digest(canonicalJson(body)), { baseline }, desired, null, 1, Date.now(), null);
  if (dispatched) await transition(env, req, auth, row, "unknown", "unavailable", null, null, true);
  const created = { ...rule, id: "legacy-created-rule" };
  if (dispatched) { if (create) provider.sets = [entrypoint([created])]; else provider.sets[0].rules.push(created); }
  return { id: row.id, key, body, rule: created, verify: (extra = {}) => request(`${base}/operations/${row.id}/verify`, { method: "POST", body: {}, ...extra }), replay: (extra = {}) => request(`${base}/waf/apply`, { method: "POST", key, body, ...extra }) };
}

test("WAF新目标、启用计划与全新apply退役，拒绝前实时校验Owner且不访问供应商", async () => {
  for (const [path, body] of [["waf/target-binding", { expected_version: 1 }], ["waf/plan", { action: "enable", expected_version: 1 }], ["waf/apply", { plan_id: randomUUID(), expected_version: 1 }]]) {
    const result = await request(`${base}/${path}`, { method: "POST", body });
    assert.equal(result.status, 400); assert.equal(result.data.details.reason, "cloudflare_feature_retired");
    assert.equal((await request(`${base}/${path}`, { method: "POST", body, headers: {} })).status, 401);
  }
  assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0);
});
test("RC6已登记但未dispatch的操作仍可同key读回并核验失败后释放共享锁", async () => {
  const old = await legacyIntent({ dispatched: false });
  const replay = await old.replay(); assert.equal(replay.status, 200); assert.equal(replay.data.idempotent_replay, true); assert.equal(replay.data.resource.status, "pending");
  const resolved = await old.verify(); assert.equal(resolved.data.resource.status, "failed"); assert.equal(resolved.data.resource.failure_class, "not_dispatched");
  assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, null);
  assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0);
});
test("RC6未知创建升级后同key仅读回，原标记独立核验并原子登记归属", async () => {
  const old = await legacyIntent({ create: true });
  const replay = await old.replay(); assert.equal(replay.data.resource.status, "unknown"); assert.equal(replay.data.idempotent_replay, true); assert.equal(provider.gets.length, 0);
  const verified = await old.verify(); assert.equal(verified.data.resource.status, "verified", JSON.stringify(verified.data));
  assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, old.rule.id);
  assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, null);
  const key = randomUUID(), first = await old.verify({ key }), count = (await db.prepare("SELECT count(*) AS n FROM events").first()).n;
  const again = await old.verify({ key }); assert.equal(again.data.idempotent_replay, true); assert.deepEqual(again.data.resource, first.data.resource); assert.equal((await db.prepare("SELECT count(*) AS n FROM events").first()).n, count);
  assert.equal(provider.writes.length, 0);
});
test("RC6旧操作key按原调用者与path查询，内容变化冲突而不重发", async () => {
  const old = await legacyIntent();
  const found = await request(`${base}/waf/operations/${old.key}`); assert.equal(found.status, 200); assert.equal(found.data.operation_id, old.id);
  assert.equal((await request(`${base}/waf/operations/${randomUUID()}`)).status, 404);
  assert.equal((await request(`${base}/secret-operations/${old.key}`)).status, 404);
  assert.equal((await old.replay({ body: { ...old.body, expected_version: 9 } })).status, 409);
  assert.equal(provider.writes.length, 0); assert.equal(provider.gets.length, 0);
});
test("旧规则进入错误位置或foreign漂移保持unknown与写锁，恢复准确库存后才完成", async () => {
  const old = await legacyIntent({ rules: [foreign("first"), foreign("second")] });
  provider.sets[0].rules.unshift(provider.sets[0].rules.pop());
  const misplaced = await old.verify(); assert.equal(misplaced.data.resource.status, "unknown"); assert.equal(misplaced.data.resource.failure_class, "cloudflare_waf_position_mismatch");
  provider.sets[0].rules.push(provider.sets[0].rules.shift()); provider.sets[0].rules[0].enabled = false;
  const drift = await old.verify(); assert.equal(drift.data.resource.status, "unknown"); assert.equal(drift.data.resource.failure_class, "cloudflare_waf_foreign_rule_drift");
  assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, old.id);
  provider.sets[0].rules[0].enabled = true; assert.equal((await old.verify()).data.resource.status, "verified"); assert.equal(provider.writes.length, 0);
});
test("手工同名规则不能代替旧创建随机标记，换Token或DB漂移也不能直接清锁", async () => {
  const old = await legacyIntent(); provider.sets[0].rules[0].ref = `cfkanban_${instanceId.replaceAll("-", "")}_anonymous_api`;
  assert.equal((await old.verify()).data.resource.status, "unknown"); provider.sets[0].rules[0].ref = old.rule.ref;
  assert.equal((await old.verify({ overrideEnv: { ...env, CFKANBAN_API_TOKEN: "different-synthetic-token" } })).data.resource.status, "unknown");
  provider.wrongActiveDatabase = true; assert.equal((await old.verify()).data.resource.status, "unknown");
  assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, null);
  assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, old.id); assert.equal(provider.writes.length, 0);
});
test("已有部署runtime目标证明继续支持旧operation恢复且不发送Token到实例", async () => {
  const old = await legacyIntent(); await db.prepare("UPDATE cloudflare_waf_target_binding SET source='deployment_runtime'").run(); provider.domainDenied = true;
  provider.proofWrong = true; assert.equal((await old.verify()).data.resource.status, "unknown"); provider.proofWrong = false;
  const verified = await old.verify(); assert.equal(verified.data.resource.status, "verified", JSON.stringify(verified.data)); assert.equal(provider.writes.length, 0);
});
test("结果审计失败不会提交历史归属，原operation保持可核验", async () => {
  const old = await legacyIntent();
  await db.prepare("CREATE TRIGGER retired_waf_audit BEFORE INSERT ON events WHEN NEW.type='instance.cloudflare-control-result' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
  const result = await old.verify(); await db.prepare("DROP TRIGGER retired_waf_audit").run();
  assert.ok(result.status >= 400, JSON.stringify(result.data)); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, null);
  assert.equal((await old.verify()).data.resource.status, "verified"); assert.equal(provider.writes.length, 0);
});

test("兼容清理拒绝没有D1归属的disable和手工同名规则", async () => {
  provider.sets = [entrypoint([foreign("manual", { ref: `cfkanban_${instanceId.replaceAll("-", "")}_anonymous_api`, expression: ownedExpression(hostname) })])];
  const result = await plan("disable"); assert.equal(result.status, 400); assert.equal(result.data.details.reason, "cloudflare_feature_retired");
  assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0); assert.equal(provider.sets[0].rules[0].id, "manual");
});
test("已有RC6归属只允许明确disable，精确删除旧rule并保留共享入口和foreign规则", async () => {
  const original = foreign(), old = await legacyIntent({ rules: [original] }); assert.equal((await old.verify()).data.resource.status, "verified");
  provider.gets.length = 0;
  const status = await current(); assert.equal(status.capabilities.waf, "unsupported_contract"); assert.equal(provider.gets.length, 0); assert.equal(provider.sets[0].rules.length, 2);
  const enable = await plan("enable"); assert.equal(enable.status, 400); assert.equal(enable.data.details.reason, "cloudflare_feature_retired"); assert.equal(provider.gets.length, 0);
  const planKey = randomUUID(), planBody = { action: "disable", expected_version: (await current()).version };
  const planned = await request(`${base}/waf/plan`, { method: "POST", key: planKey, body: planBody }); assert.equal(planned.status, 200, JSON.stringify(planned.data)); assert.equal(planned.data.resource.after.entrypoint_strategy, "delete_owned_rule");
  const key = randomUUID(), result = await apply(planned, { key }); assert.equal(result.status, 200); assert.equal(result.data.resource.status, "verified", JSON.stringify(result.data));
  assert.deepEqual(provider.writes, [{ method: "DELETE", path: `/zones/${zoneId}/rulesets/entrypoint/rules/${old.rule.id}` }]); assert.deepEqual(provider.sets, [entrypoint([original])]);
  assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, null);
  const replay = await apply(planned, { key }); assert.equal(replay.data.idempotent_replay, true); assert.equal(replay.data.resource.status, "verified"); assert.equal(provider.writes.length, 1);
  const planReplay = await request(`${base}/waf/plan`, { method: "POST", key: planKey, body: planBody }); assert.equal(planReplay.status, 200); assert.equal(planReplay.data.idempotent_replay, true); assert.deepEqual(planReplay.data.resource, planned.data.resource);
  assert.equal((await plan("disable")).data.details.reason, "cloudflare_feature_retired");
});
test("旧规则disable删除响应未知时保持原意图与锁，重放只读而恢复不二次DELETE", async () => {
  const old = await legacyIntent({ rules: [foreign()] }); await old.verify();
  const planned = await plan("disable"), key = randomUUID(); provider.lostResponse = true;
  const applied = await apply(planned, { key }); assert.equal(applied.data.resource.status, "unknown");
  const operationId = applied.data.resource.operation_id; assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, operationId);
  const replay = await apply(planned, { key }); assert.equal(replay.data.idempotent_replay, true); assert.equal(replay.data.resource.status, "unknown"); assert.equal(provider.writes.length, 1);
  provider.lostResponse = false; const verified = await request(`${base}/operations/${operationId}/verify`, { method: "POST", body: {} }); assert.equal(verified.data.resource.status, "verified", JSON.stringify(verified.data));
  assert.equal(provider.writes.length, 1); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, null);
  assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, null);
});
test("兼容disable仍拒绝冻结后规则漂移、Token更换和陈旧CAS", async () => {
  const old = await legacyIntent({ rules: [foreign()] }); await old.verify();
  const planned = await plan("disable");
  assert.equal((await apply(planned, { body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version - 1 } })).status, 409);
  assert.equal((await apply(planned, { overrideEnv: { ...env, CFKANBAN_API_TOKEN: "rotated-synthetic" } })).status, 400);
  provider.sets[0].rules[0].enabled = false; assert.equal((await apply(planned)).status, 400); provider.sets[0].rules[0].enabled = true;
  provider.sets[0].rules[1].logging = { enabled: true }; assert.equal((await apply(planned)).status, 400);
  assert.equal(provider.writes.length, 0); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, old.rule.id);
});
test("旧未消费enable plan不能借兼容清理恢复创建权限", async () => {
  const old = await legacyIntent(); await old.verify();
  const planned = await plan("disable"); const planId = planned.data.resource.plan_id;
  await db.prepare("UPDATE cloudflare_control_plans SET after_json=json_set(after_json,'$.action','enable','$.entrypoint_strategy','append_rule') WHERE id=?1").bind(planId).run();
  provider.gets.length = 0; const result = await apply(planned); assert.equal(result.status, 400); assert.equal(result.data.details.reason, "cloudflare_feature_retired"); assert.equal(result.data.details.write_state, "not_dispatched");
  assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0);
});

async function legacyLocalReceipt(operation, { pending = false } = {}) {
  const method = operation === "zone_settings" ? "PATCH" : "POST", path = operation === "zone_settings" ? `${base}/settings` : operation === "waf_target_binding" ? `${base}/waf/target-binding` : `${base}/waf/plan`;
  const expected = (await current()).version, body = { ...(operation === "zone_settings" ? { zone_id: zoneId } : operation === "waf_plan" ? { action: "enable", conflict_choice: null } : {}), expected_version: expected }, key = randomUUID();
  const req = new Request(`https://${hostname}${path}`, { method, headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": key } }), auth = await authenticateRequest(db, req, Date.now());
  const identity = { method, routeTemplate: path, normalizedResourceScope: "instance-cloudflare-control", scopeKey: `principal:${ownerId}`, idempotencyKey: key, requestBody: body };
  let result;
  if (pending) await claimIdempotency(db, identity);
  else result = await localChange(env, req, auth, path, body, expected, () => [], async version => operation === "waf_plan" ? { version, plan_id: randomUUID(), kind: "waf", after: { action: "enable" } } : operation === "waf_target_binding" ? { version, target_binding: { status: "verified", source: "worker_domain_read", domain_id: "domain1" } } : { version, target: { zone_id: zoneId } }, Date.now());
  const ledger = await db.prepare("SELECT operation_id FROM idempotency_records WHERE idempotency_key=?1").bind(digest(key)).first();
  return { key, body, result, operationId: ledger.operation_id, requestHash: (await computeRequestHash(identity)).requestHash, lookup: () => request(`${base}/local-operations/${key}?operation=${operation}`), replay: (extra = {}) => request(path, { method, key, body, ...extra }) };
}
for (const operation of ["zone_settings", "waf_target_binding", "waf_plan"]) test(`RC6 ${operation} 原key已commit快照只读重放，新key退役且不增加审计`, async () => {
  const old = await legacyLocalReceipt(operation), version = (await current()).version, events = (await db.prepare("SELECT count(*) AS n FROM events").first()).n, records = (await db.prepare("SELECT count(*) AS n FROM idempotency_records").first()).n;
  const lookup = await old.lookup(); assert.equal(lookup.status, 200); assert.equal(lookup.data.operation, operation); assert.equal(lookup.data.request_hash, old.requestHash); assert.deepEqual(lookup.data.resource, old.result.resource); assert.equal(lookup.data.idempotent_replay, true);
  const replay = await old.replay(); assert.equal(replay.status, 200); assert.deepEqual(replay.data.resource, old.result.resource); assert.equal(replay.data.idempotent_replay, true);
  assert.equal((await old.replay({ body: { ...old.body, expected_version: 99 } })).status, 409);
  assert.equal((await old.replay({ key: randomUUID() })).data.details.reason, "cloudflare_feature_retired");
  assert.equal((await current()).version, version); assert.equal((await db.prepare("SELECT count(*) AS n FROM events").first()).n, events); assert.equal((await db.prepare("SELECT count(*) AS n FROM idempotency_records").first()).n, records); assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0);
});
test("本地历史回执只允许原principal、path、未过期key与真实commit，pending不能触发重发", async () => {
  const old = await legacyLocalReceipt("zone_settings");
  assert.equal((await request(`${base}/local-operations/${old.key}?operation=waf_target_binding`)).status, 404);
  assert.equal((await request(`${base}/local-operations/${old.key}?operation=invalid`)).status, 400);
  await db.prepare("UPDATE idempotency_records SET scope_key=?2 WHERE operation_id=?1").bind(old.operationId, `principal:${randomUUID()}`).run(); assert.equal((await old.lookup()).status, 404);
  await db.prepare("UPDATE idempotency_records SET scope_key=?2,created_at=1,expires_at=2 WHERE operation_id=?1").bind(old.operationId, `principal:${ownerId}`).run(); assert.equal((await old.lookup()).status, 404);
  const pending = await legacyLocalReceipt("waf_target_binding", { pending: true }); assert.equal((await pending.lookup()).status, 404); assert.equal((await pending.replay()).data.details.reason, "cloudflare_feature_retired");
  await db.prepare("UPDATE credentials SET revoked_at=?2 WHERE id=?1").bind(credentialId, Date.now()).run(); assert.equal((await pending.lookup()).status, 401); assert.equal((await pending.replay()).status, 401);
  assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0);
});
test("RC6原子commit后响应缓存丢失仍能从快照只读恢复，无commit快照不能证明成功", async () => {
  const old = await legacyLocalReceipt("waf_target_binding");
  await db.prepare("UPDATE idempotency_records SET state='pending',response_json=NULL,response_status=NULL,operation_snapshot_json=?2 WHERE operation_id=?1").bind(old.operationId, canonicalJson(old.result.resource)).run();
  const lookup = await old.lookup(); assert.equal(lookup.status, 200); assert.deepEqual(lookup.data.resource, old.result.resource); assert.equal((await old.replay()).status, 200);
  await db.prepare("DELETE FROM operation_commits WHERE operation_id=?1").bind(old.operationId).run(); assert.equal((await old.lookup()).status, 404); assert.equal((await old.replay()).data.details.reason, "cloudflare_feature_retired");
  assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0);
});
test("退役WAF状态只读本地target登记，不把未探测状态当在线保护", async () => {
  let result = await request(`${base}/waf`); assert.equal(result.status, 200); assert.equal(result.data.status, "unsupported_contract"); assert.equal(result.data.target_binding.status, "missing"); assert.equal(result.data.protected, false);
  await legacyIntent(); provider.gets.length = 0;
  result = await request(`${base}/waf`); assert.equal(result.data.target_binding.status, "verified"); assert.equal(result.data.target_binding.domain_id, "domain1"); assert.equal(result.data.target_binding.live_verified, false); assert.equal(result.data.target_binding.service_proof, false);
  assert.equal((await request(`${base}/waf`, { overrideEnv: { ...env, CFKANBAN_CONTROL_WORKER_NAME: "another-worker" } })).data.target_binding.status, "target_mismatch");
  assert.equal(provider.gets.length, 0); assert.equal(provider.writes.length, 0);
});
