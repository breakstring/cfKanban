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
import { ownedExpression } from "../../apps/worker/src/services/cloudflare-control.ts";

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

test("目标接入是纯读取登记，不改DNS且拒绝任意receipt/token，缺证据不发WAF写", async () => {
  const status = await request(`${base}/waf`); assert.equal(status.data.status, "verified"); assert.equal(status.data.target_binding.status, "missing"); assert.equal(status.data.protected, false);
  assert.equal((await plan()).status, 400); assert.equal((await request(`${base}/waf/target-binding`, { method: "POST", body: { expected_version: 1, receipt: {} } })).status, 400);
  assert.equal((await bind()).status, 200); const registered = await db.prepare("SELECT b.binding_id,o.binding_id AS ownership_binding_id,o.rule_id,o.operation_id FROM cloudflare_waf_target_binding b JOIN cloudflare_waf_ownership o ON o.singleton=b.singleton").first(); assert.equal(registered.binding_id, registered.ownership_binding_id); assert.equal(registered.rule_id, null); assert.ok(registered.operation_id); assert.equal(provider.writes.length, 0); provider.wrongDomain = true; assert.equal((await plan()).status, 409); assert.equal(provider.writes.length, 0);
});
test("独立WAF核验仍拒绝当前Worker实际DB不符，未登记intent不发送云写", async () => {
  provider.wrongActiveDatabase = true; assert.equal((await bind()).status, 409); provider.wrongActiveDatabase = false; await bind(); const planned = await plan(), key = randomUUID(); provider.wrongActiveDatabase = true;
  const rejected = await apply(planned, { key }); assert.equal(rejected.status, 409); assert.equal(rejected.data.details.write_state, "not_dispatched"); assert.equal((await request(`${base}/waf/operations/${key}`)).status, 404); assert.equal(provider.writes.length, 0);
});
test("已部署runtime缺公网fetch或冲突flag拒绝目标证明和写入，unknown只读恢复不重发", async () => {
  provider.runtimeFlags = []; const unbound = await bind(); assert.equal(unbound.status, 503); assert.equal(unbound.data.details.failure_class, "unsupported_contract");
  provider.runtimeFlags = ["global_fetch_strictly_public"]; await bind(); const planned = await plan(), key = randomUUID(); await db.prepare("UPDATE cloudflare_waf_target_binding SET source='deployment_runtime'").run(); provider.domainDenied = true;
  for (const flags of [undefined, [], ["global_fetch_private_origin"], ["global_fetch_strictly_public", "global_fetch_private_origin"], ["global_fetch_strictly_public", null]]) {
    provider.runtimeFlags = flags; const status = await request(`${base}/waf`); assert.equal(status.data.target_binding.status, "unsupported_contract"); assert.equal(status.data.protected, false);
    const rejected = await apply(planned, { key }); assert.equal(rejected.status, 503); assert.equal(rejected.data.details.write_state, "not_dispatched"); assert.equal((await request(`${base}/waf/operations/${key}`)).status, 404); assert.equal(provider.writes.length, 0);
  }
  provider.runtimeFlags = ["global_fetch_strictly_public"]; const fallbackPlan = await plan(); provider.lostResponse = true; const uncertain = await apply(fallbackPlan); assert.equal(uncertain.data.resource.status, "unknown"); provider.lostResponse = false; provider.runtimeFlags = [];
  const verify = () => request(`${base}/operations/${uncertain.data.resource.operation_id}/verify`, { method: "POST", body: {} });
  const refused = await verify(); assert.equal(refused.data.resource.status, "unknown"); assert.equal(refused.data.resource.failure_class, "unsupported_contract"); provider.runtimeFlags = ["global_fetch_strictly_public"]; assert.equal((await verify()).data.resource.status, "verified"); assert.equal(provider.writes.length, 1);
  assert.ok(provider.gets.every(read => !read.path.endsWith("/settings")));
});
test("不存在入口创建携带一条规则，精确ID登记，禁用只删rule保留共享入口", async () => {
  assert.equal((await bind()).status, 200); const planned = await plan(); assert.equal(planned.status, 200, JSON.stringify(planned.data)); assert.equal(planned.data.resource.after.entrypoint_strategy, "create_entrypoint");
  const result = await apply(planned); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.resource.status, "verified", JSON.stringify(result.data)); assert.equal(provider.writes.length, 1); assert.equal(provider.sets[0].rules.length, 1);
  const owned = await db.prepare("SELECT * FROM cloudflare_waf_ownership").first(); assert.equal(owned.rule_id, provider.sets[0].rules[0].id); assert.equal((await request(`${base}/waf`)).data.protected, true);
  const disabled = await apply(await plan("disable")); assert.equal(disabled.data.resource.status, "verified", JSON.stringify(disabled.data)); assert.equal(provider.sets.length, 1); assert.equal(provider.sets[0].rules.length, 0); assert.equal(provider.writes[1].method, "DELETE");
});
test("唯一共享入口追加，foreign内容和相对顺序完整保留", async () => {
  provider.sets = [entrypoint([foreign("first"), foreign("second")])]; const original = structuredClone(provider.sets[0].rules); await bind(); const planned = await plan(); const result = await apply(planned);
  assert.equal(result.data.resource.status, "verified", JSON.stringify(result.data)); assert.deepEqual(provider.sets[0].rules.slice(0, 2), original); assert.equal(provider.writes[0].path, `/zones/${zoneId}/rulesets/entrypoint/rules`); assert.equal(provider.writes[0].method, "POST");
});
test("前置Skip必须明确选择，before只移动自有规则且不改foreign顺序", async () => {
  provider.sets = [entrypoint([foreign("skip", { action: "skip", expression: "true", action_parameters: { ruleset: "current" } }), foreign("other")])]; await bind();
  const unchosen = await plan(); assert.equal(unchosen.data.resource.after.apply_ready, false); assert.equal((await apply(unchosen)).status, 400); assert.equal(provider.writes.length, 0);
  const chosen = await plan("enable", "before_conflicts"), result = await apply(chosen); assert.equal(result.data.resource.status, "verified", JSON.stringify(result.data)); assert.equal(provider.sets[0].rules[0].id, result.data.resource.result_rule_id); assert.deepEqual(provider.sets[0].rules.slice(1).map(rule => rule.id), ["skip", "other"]); assert.equal((await request(`${base}/waf`)).data.protected, true);
});
test("手工同ref/body不会接管；保留重复后覆盖受限，关闭仅删新自有ID", async () => {
  const manual = foreign("manual", { ref: `cfkanban_${instanceId.replaceAll("-", "")}_anonymous_api`, description: `cfKanban ${instanceId} anonymous private API filter`, expression: ownedExpression(hostname) }); provider.sets = [entrypoint([manual])]; await bind();
  const status = await request(`${base}/waf`); assert.equal(status.data.owned_rule, null); assert.equal(status.data.conflicts[0].kind, "unowned_duplicate"); assert.equal((await plan("enable", "before_conflicts")).status, 400);
  const result = await apply(await plan("enable", "preserve_exemptions")); assert.equal(result.data.resource.status, "verified", JSON.stringify(result.data)); assert.equal((await request(`${base}/waf`)).data.protected, false);
  await apply(await plan("disable")); assert.deepEqual(provider.sets[0].rules, [manual]);
});
test("Free总容量包含disabled和子规则集，拒绝第六条及不完整分页", async () => {
  provider.sets = [entrypoint([foreign("1"), foreign("2")]), { id: "child", kind: "custom", phase: "http_request_firewall_custom", rules: [foreign("3"), foreign("4", { enabled: false }), foreign("5")] }]; await bind(); assert.equal((await request(`${base}/waf`)).data.inventory.total_rule_count, 5); assert.equal((await plan()).status, 400); assert.equal(provider.writes.length, 0);
  provider.pages = 2; assert.equal((await plan()).status, 503); provider.pages = 1; provider.rulePages = 2; assert.equal((await plan()).status, 503); provider.rulePages = 1; provider.ruleCount = 9; assert.equal((await plan()).status, 503); assert.equal(provider.writes.length, 0);
});
test("计划后foreign规则/顺序、target、Token漂移拒绝并不更换策略", async () => {
  provider.sets = [entrypoint([foreign("1"), foreign("2")])]; await bind(); const planned = await plan(); provider.sets[0].rules.reverse(); assert.equal((await apply(planned)).status, 400); assert.equal(provider.writes.length, 0);
  provider.sets[0].rules.reverse(); const rotated = await apply(planned, { overrideEnv: { ...env, CFKANBAN_API_TOKEN: "NEW".repeat(14) } }); assert.equal(rotated.status, 400); assert.equal(provider.writes.length, 0);
});
test("网络未知同key不重发，原持久随机标记可只读验证恢复，Worker版本不参与WAF结果", async () => {
  await bind(); const planned = await plan(), key = randomUUID(); provider.lostResponse = true; const result = await apply(planned, { key }); assert.equal(result.data.resource.status, "unknown"); assert.equal((await apply(planned, { key })).data.idempotent_replay, true); assert.equal(provider.writes.length, 1);
  provider.lostResponse = false; provider.active = randomUUID(); provider.candidate = randomUUID(); const verified = await request(`${base}/operations/${result.data.resource.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(verified.data.resource.status, "verified", JSON.stringify(verified.data)); assert.equal(provider.writes.length, 1); assert.equal((await request(`${base}/waf`)).data.ownership.rule_id, provider.sets[0].rules[0].id);
  assert.ok(provider.gets.every(read => !read.path.endsWith("/versions") && !read.path.endsWith("/settings"))); assert.equal((await plan("disable")).status, 200);
});
test("未知创建只在冻住的入口和准确位置恢复，子ruleset或错误排序保持unknown", async () => {
  provider.sets = [entrypoint([foreign("first"), foreign("second")]), { id: "child", kind: "custom", phase: "http_request_firewall_custom", rules: [] }]; await bind(); const planned = await plan(); provider.lostResponse = true; const result = await apply(planned); assert.equal(result.data.resource.status, "unknown"); provider.lostResponse = false;
  const zone = provider.sets[0], child = provider.sets[1], created = zone.rules.pop(); child.rules.push(created);
  const verify = () => request(`${base}/operations/${result.data.resource.operation_id}/verify`, { method: "POST", body: {} });
  const wrongSet = await verify(); assert.equal(wrongSet.data.resource.status, "unknown", JSON.stringify(wrongSet.data)); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, null);
  child.rules = []; zone.rules.unshift(created); const wrongOrder = await verify(); assert.equal(wrongOrder.data.resource.status, "unknown", JSON.stringify(wrongOrder.data)); assert.equal(wrongOrder.data.resource.failure_class, "cloudflare_waf_position_mismatch");
  zone.rules.shift(); zone.rules.push(created); const recovered = await verify(); assert.equal(recovered.data.resource.status, "verified", JSON.stringify(recovered.data)); assert.equal(provider.writes.length, 1); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, created.id);
});
test("unknown期间手工同固定ref不能代替创建标记；外部规则变化保持锁定", async () => {
  await bind(); const planned = await plan(); provider.lostResponse = true; const result = await apply(planned); provider.sets[0].rules[0].ref = `cfkanban_${instanceId.replaceAll("-", "")}_anonymous_api`; provider.lostResponse = false;
  const verified = await request(`${base}/operations/${result.data.resource.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(verified.data.resource.status, "unknown"); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, null); assert.equal((await db.prepare("SELECT locked_operation_id FROM cloudflare_control_settings").first()).locked_operation_id, result.data.resource.operation_id); assert.equal(provider.writes.length, 1);
});
test("deployment runtime证明走固定HMAC服务，不传Token，错误Secret/拦截拒绝写", async () => {
  await bind(); await db.prepare("UPDATE cloudflare_waf_target_binding SET source='deployment_runtime'").run(); provider.domainDenied = true;
  const planned = await plan(); assert.equal(planned.status, 200, JSON.stringify(planned.data)); assert.equal((await apply(planned)).data.resource.status, "verified");
  provider.proofWrong = true; assert.equal((await plan("disable")).status, 503); provider.proofWrong = false; provider.skipProof = true; assert.equal((await plan("disable")).status, 503); assert.equal(provider.writes.length, 1);
  assert.equal((await request("/.well-known/cfkanban-waf-proof", { method: "POST", body: { nonce: "a".repeat(64), expires_at: Date.now() + 9000, target: {} }, headers: {} })).status, 404);
});
test("workers.dev和preview开启仍准许明确计划但绝不声称完整覆盖或关闭入口", async () => {
  await bind(); provider.workersDev = true; provider.previews = true; const result = await apply(await plan()); assert.equal(result.data.resource.status, "verified"); const status = (await request(`${base}/waf`)).data; assert.equal(status.coverage.status, "incomplete"); assert.equal(status.protected, false); assert.ok(provider.writes.every(write => write.path.includes("/rulesets")));
});
test("CSRF和Owner实时撤销发生于外部dispatch之前，无Token进入D1/审计", async () => {
  assert.equal((await plan()).status, 400); await bind(); const planned = await plan();
  const session = "S".repeat(43), csrf = "X".repeat(32), now = Date.now(); await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES(?1,?2,?3,'credential',?4,'admin',?5,?6,?7)").bind(randomUUID(), digest(session), ownerId, credentialId, JSON.stringify({ kind: "admin", entry_path: "/app/admin", section: "overview" }), now + 3600000, now).run();
  assert.equal((await apply(planned, { headers: { cookie: `cfkanban_session=${session}; cfkanban_csrf=${csrf}` } })).status, 403); assert.equal(provider.writes.length, 0);
  await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), credentialId).run(); assert.equal((await apply(planned)).status, 401); assert.equal(provider.writes.length, 0);
  const tables = await db.prepare("SELECT baseline_json,desired_json FROM cloudflare_control_operations").all(), events = await db.prepare("SELECT payload_json FROM events WHERE type LIKE 'instance.cloudflare-control-%'").all(); assert.ok(!JSON.stringify({ tables, events }).includes(cfToken));
});

test("IP Access Allow和未核验豁免不能靠before解决，明确保留时覆盖受限", async () => {
  provider.ipRules = [{ id: "allowed-ip", mode: "whitelist", configuration: { target: "ip", value: "192.0.2.1" } }]; await bind();
  const pending = await plan(); assert.equal(pending.data.resource.after.apply_ready, false); assert.equal(pending.data.resource.after.conflicts[0].kind, "ip_access_allow"); assert.equal((await plan("enable", "before_conflicts")).status, 400);
  assert.equal((await apply(await plan("enable", "preserve_exemptions"))).data.resource.status, "verified"); assert.equal((await request(`${base}/waf`)).data.protected, false);
  const rows = await db.prepare("SELECT baseline_json,desired_json FROM cloudflare_control_operations").all(); assert.ok(!JSON.stringify(rows).includes("192.0.2.1")); provider.ipDenied = true; assert.equal((await request(`${base}/waf`)).data.conflicts.at(-1).kind, "ip_access_unverified");
});
test("原apply请求key精确查询scope/path且404不能当未dispatch证明", async () => {
  const key = randomUUID(); assert.equal((await request(`${base}/waf/operations/${key}`)).status, 404); await bind(); const planned = await plan(); provider.lostResponse = true; assert.equal((await apply(planned, { key: `cli-${randomUUID()}` })).status, 400); const saved = await apply(planned, { key });
  const found = await request(`${base}/waf/operations/${key}`); assert.equal(found.status, 200); assert.equal(found.data.operation_id, saved.data.resource.operation_id); assert.equal(found.data.status, "unknown"); assert.equal((await request(`${base}/secret-operations/${key}`)).status, 404); assert.equal(provider.writes.length, 1); assert.equal((await request(`${base}/waf/operations/not-a-uuid`)).status, 400);
});

test("apply登记intent前明确preflight失败可返回not_dispatched，登记后未知不伪造未写", async () => {
  await bind(); const planned = await plan(), key = randomUUID(); provider.wrongDomain = true;
  const rejected = await apply(planned, { key }); assert.equal(rejected.status, 409); assert.equal(rejected.data.details.write_state, "not_dispatched"); assert.equal((await request(`${base}/waf/operations/${key}`)).status, 404); assert.equal(provider.writes.length, 0);
  provider.wrongDomain = false; provider.lostResponse = true; const uncertainKey = randomUUID(), uncertain = await apply(planned, { key: uncertainKey }); assert.equal(uncertain.data.resource.status, "unknown"); assert.ok(!JSON.stringify(uncertain.data).includes("not_dispatched")); assert.equal(provider.writes.length, 1);
  const mismatch = await request(`${base}/waf/apply`, { method: "POST", key: uncertainKey, body: { plan_id: planned.data.resource.plan_id, expected_version: planned.data.resource.version + 1 } }); assert.equal(mismatch.status, 409); assert.notEqual(mismatch.data.details.write_state, "not_dispatched"); assert.equal((await request(`${base}/waf/operations/${uncertainKey}`)).data.status, "unknown"); assert.equal(provider.writes.length, 1);
  const invalidPlan = await request(`${base}/waf/apply`, { method: "POST", key: uncertainKey, body: { plan_id: "invalid-plan", expected_version: planned.data.resource.version } }); assert.equal(invalidPlan.status, 409); assert.notEqual(invalidPlan.data.details.write_state, "not_dispatched");
});
test("最终dispatch前凭据撤销阻止云写，未dispatch原intent只读恢复failed", async () => {
  await bind(); const planned = await plan(), key = randomUUID(); let accountRead = 0;
  provider.beforeRequest = async (path, method) => { if (method === "GET" && path === `/accounts/${accountId}/firewall/access_rules/rules` && ++accountRead === 2) await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(), credentialId).run(); };
  const rejected = await apply(planned, { key }); assert.equal(rejected.status, 401); assert.equal(provider.writes.length, 0); await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(credentialId).run(); provider.beforeRequest = null;
  const original = await request(`${base}/waf/operations/${key}`); assert.equal(original.data.status, "pending"); const verified = await request(`${base}/operations/${original.data.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(verified.data.resource.status, "failed"); assert.equal(verified.data.resource.failure_class, "not_dispatched"); assert.equal(provider.writes.length, 0);
});
test("目标origin在最终preflight后改变时D1 dispatch fence拒绝，不发送WAF写", async () => {
  await bind(); const planned = await plan(), key = randomUUID(), originalVersion = (await db.prepare("SELECT version FROM instance_origin_settings").first()).version; let accountRead = 0;
  provider.beforeRequest = async (path, method) => { if (method === "GET" && path === `/accounts/${accountId}/firewall/access_rules/rules` && ++accountRead === 2) await db.prepare("UPDATE instance_origin_settings SET version=version+1 WHERE singleton=1").run(); };
  const rejected = await apply(planned, { key }); assert.equal(rejected.status, 200, JSON.stringify(rejected.data)); assert.equal(rejected.data.resource.status, "pending"); assert.equal(provider.writes.length, 0);
  provider.beforeRequest = null; await db.prepare("UPDATE instance_origin_settings SET version=?1 WHERE singleton=1").bind(originalVersion).run(); const verified = await request(`${base}/operations/${rejected.data.resource.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(verified.data.resource.status, "failed"); assert.equal(provider.writes.length, 0);
});
test("归属与verified审计同批，结果审计失败不记录归属且原intent可只读恢复", async () => {
  await bind(); const planned = await plan(), key = randomUUID(); await db.exec("CREATE TRIGGER waf_result_failure BEFORE INSERT ON events WHEN NEW.type='instance.cloudflare-control-result' BEGIN SELECT RAISE(ABORT,'synthetic result failure'); END");
  try { assert.ok((await apply(planned, { key })).status >= 500); assert.equal(provider.writes.length, 1); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, null); assert.notEqual((await request(`${base}/waf/operations/${key}`)).data.status, "verified"); }
  finally { await db.exec("DROP TRIGGER waf_result_failure"); }
  const original = await request(`${base}/waf/operations/${key}`), result = await request(`${base}/operations/${original.data.operation_id}/verify`, { method: "POST", body: {} }); assert.equal(result.data.resource.status, "verified", JSON.stringify(result.data)); assert.equal(provider.writes.length, 1); assert.equal((await db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").first()).rule_id, provider.sets[0].rules[0].id);
});

test("同目标重复核验保留bindingID与已有归属，未知own语义字段按漂移拒绝删除", async () => {
  await bind(); const applied = await apply(await plan()); assert.equal(applied.data.resource.status, "verified"); const previous = await db.prepare("SELECT binding_id,rule_id FROM cloudflare_waf_ownership").first();
  assert.equal((await bind()).status, 200); assert.equal((await db.prepare("SELECT binding_id FROM cloudflare_waf_target_binding").first()).binding_id, previous.binding_id); assert.equal((await request(`${base}/waf`)).data.ownership.rule_id, previous.rule_id);
  provider.sets[0].rules[0].action_parameters = { response: { status_code: 403 } }; assert.equal((await plan("disable")).status, 400); assert.equal((await request(`${base}/waf`)).data.protected, false); assert.equal(provider.writes.length, 1);
});
