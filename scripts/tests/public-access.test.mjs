import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { anonymousApiRule, applyPublicAccess, createPublicAccessPlan, verifyPlannedPublicAccess } from "../../packages/skill-runtime/src/public-access.mjs";
import { normalizePublicAccess, publicAccessBindings } from "../../packages/skill-runtime/src/public-access-config.mjs";
import { acquirePublicAccessLock } from "../../packages/skill-runtime/src/public-access-lock.mjs";
import { createInstanceUpgradePlan } from "../../packages/skill-runtime/src/upgrade-plan.mjs";
import { targetWorkerBindings } from "../../packages/skill-runtime/src/usage-config.mjs";
import { writeFrozenWranglerConfig } from "../../packages/skill-runtime/src/deployment-config.mjs";
import { readWorkerCostSettings, verifyPlannedWorkerCostSettings } from "../../packages/skill-runtime/src/worker-cost-settings.mjs";
import { treeDigest } from "../../packages/skill-runtime/src/skill-update.mjs";
import { createJournal, authorizeJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { createPendingCredential, loadPendingCredentialSecret, promotePendingCredential, putInstanceMetadata, getInstancePaths } from "../../packages/skill-runtime/src/state.mjs";
import { atomicWriteJson, canonicalDigest } from "../../packages/skill-runtime/src/utils.mjs";
import { COMMANDS } from "../../packages/cli/src/catalog.mjs";

// 所有 Cloudflare/应用请求均进入此封闭 fixture；测试凭据只存在临时私有状态。
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfk-public-access-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const instanceId = randomUUID(), principalId = randomUUID(), credentialId = randomUUID(), databaseId = randomUUID();
  const origin = "https://board.isolated.workers.dev", host = "board.example.test";
  const f = { calls: [], domains: [], rulesets: [], dns: [], workers: true, previews: true, preferred: origin, version: 1, owner: true, failAfterDomain: false, failAfterWaf: false, wrongDiscovery: false, partial: false };
  const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const input = { home, stateRoot: path.join(home, ".cfkanban"), persistenceConfirmed: true, passkeyRecoveryReady: true, instanceId, taskId: "public-access-test", zoneId: "zone-test", hostname: host, cloudflareProfile: "isolated", wranglerExecutable: "/mock/wrangler", environment: {}, tokenRunner: async () => ({ stdout: JSON.stringify({ type: "oauth", token: "mock-control-secret" }) }),
    fetchImpl: async (url, options = {}) => {
      const u = new URL(url), method = options.method ?? "GET", body = options.body ? JSON.parse(options.body) : null;
      f.calls.push({ origin: u.origin, path: u.pathname, method, body });
      if (u.origin === "https://api.cloudflare.com") {
        assert.equal(new Headers(options.headers).get("authorization"), "Bearer mock-control-secret");
        const p = u.pathname.replace("/client/v4/accounts/account-test/workers", "/workers").replace("/client/v4/zones/zone-test", "/zone");
        let value;
        if (p === "/workers/subdomain") value = { subdomain: "isolated" };
        else if (p === "/workers/scripts/board/subdomain") {
          if (method === "POST") { f.workers = body.enabled; f.previews = body.previews_enabled; }
          value = { enabled: f.workers, previews_enabled: f.previews };
        } else if (p === "/workers/scripts/board/settings") value = { bindings: [{ type: "d1", name: "DB", id: databaseId }] };
        else if (p === "/workers/services/board/environments/production/routes") value = [];
        else if (p === "/workers/services/board/environments/production") value = { script: { limits: f.limits ?? null } };
        else if (p === "/workers/domains") {
          if (method === "PUT") { assert.equal(f.domains.length, 0); f.domains.push({ id: "domain-test", ...body }); if (f.failAfterDomain) { f.failAfterDomain = false; throw new Error("uncertain after commit"); } }
          value = f.domains;
          if (f.partial) return json({ success: true, result: value, result_info: { total_pages: 2 } });
        } else if (p === "/workers/domains/domain-test" && method === "DELETE") { f.domains = []; value = null; }
        else if (p === "/zone") value = { id: "zone-test", name: "example.test", status: "active", account: { id: "account-test" } };
        else if (p === "/zone/dns_records") { assert.equal(u.searchParams.get("name"), host); value = f.dns; }
        else if (p === "/zone/rulesets") {
          if (method === "POST") {
            assert.equal(body.kind, "zone"); assert.equal(body.phase, "http_request_firewall_custom");
            f.rulesets.push({ id: "ruleset-test", kind: body.kind, phase: body.phase, rules: body.rules.map(rule => ({ id: "rule-test", ...rule })) });
            if (f.failAfterWaf) { f.failAfterWaf = false; throw new Error("uncertain after commit"); }
          }
          value = method === "GET" ? f.rulesets.map(({ rules, ...entry }) => entry) : f.rulesets[0];
        } else if (/^\/zone\/rulesets\/[^/]+$/u.test(p)) value = f.rulesets.find(set => p.endsWith(set.id));
        else if (p === "/zone/rulesets/ruleset-test/rules" && method === "POST") { f.rulesets[0].rules.push({ id: "rule-test", ...body }); value = f.rulesets[0]; }
        else if (p === "/zone/rulesets/ruleset-test/rules/rule-test" && method === "DELETE") { f.rulesets[0].rules = f.rulesets[0].rules.filter(rule => rule.id !== "rule-test"); value = f.rulesets[0]; }
        else assert.fail(`unexpected control request ${method} ${p}`);
        return json({ success: true, result: value });
      }
      assert.ok([origin, `https://${host}`].includes(u.origin));
      if (u.origin === origin) assert.equal(f.workers, true, "disabled workers.dev must never be used");
      if (u.origin === `https://${host}`) assert.equal(f.domains.length, 1, "domain must exist before probing");
      if (u.pathname === "/.well-known/cfkanban-instance.json") {
        assert.equal(new Headers(options.headers).get("authorization"), null, "discovery must not carry credentials");
        return json({ discovery_version: 1, instance_id: f.wrongDiscovery && u.origin !== origin ? randomUUID() : instanceId, observed_origin: u.origin, preferred_api_origin: f.preferred, origin_version: f.version });
      }
      assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${f.token}`);
      if (u.pathname === "/api/v1/meta") return json({ instance_id: instanceId, observed_origin: u.origin, preferred_api_origin: f.preferred, origin_version: f.version, principal: { id: principalId, is_owner: f.owner } });
      assert.equal(u.pathname, "/api/v1/admin/instance-origin");
      if (method === "PUT") {
        assert.equal(body.expected_version, f.version); assert.equal(new Headers(options.headers).get("idempotency-key"), `public-access-${f.operationId}`);
        f.version++; f.preferred = body.preferred_api_origin;
      }
      return json({ preferred_api_origin: f.preferred, version: f.version });
    },
  };
  await putInstanceMetadata({ ...input, trustedApiOrigin: origin, originVersion: 1 });
  await createPendingCredential({ ...input, principalId, credentialId, purpose: "owner_bootstrap" });
  const pending = await loadPendingCredentialSecret(input);
  await promotePendingCredential({ ...input, principalId, credentialId, fingerprint: pending.metadata.fingerprint });
  f.token = pending.token;
  const paths = getInstancePaths(input);
  input.receiptPath = path.join(paths.receiptsRoot, "deployment.json");
  await atomicWriteJson(input.receiptPath, { kind: "cfkanban_deployment_receipt", instance: { id: instanceId }, cloudflare: { account_id: "account-test", profile: "isolated", worker: { name: "board" }, d1: { database_id: databaseId } }, owner: { principal_id: principalId } });
  f.input = input;
  f.principalId = principalId; f.credentialId = credentialId; f.databaseId = databaseId;
  f.prepare = async mode => {
    const result = await createPublicAccessPlan({ ...input, mode });
    f.operationId = result.plan.operation_id;
    f.execution = { ...input, plan: result.plan, operationId: result.plan.operation_id };
    await createJournal(f.execution); await authorizeJournal({ ...f.execution, planDigest: result.plan_digest });
    return result;
  };
  f.apply = () => applyPublicAccess(f.execution);
  return f;
}

test("domain enable verifies trusted origin before disabling bypasses, and rollback restores only owned mapping", async t => {
  const f = await fixture(t);
  await f.prepare("domain-enable");
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  let result = await f.apply();
  assert.equal(result.receipt.domain_enabled, true); assert.equal(f.workers, false); assert.equal(f.previews, false);
  const close = f.calls.findIndex(call => call.path.endsWith("/scripts/board/subdomain") && call.method === "POST");
  assert.ok(f.calls.slice(0, close).some(call => call.origin === "https://board.example.test" && call.path === "/api/v1/meta"));
  assert.ok(!f.calls.some(call => call.path.includes("/rulesets")), "domain-only setup must not require WAF permissions");
  await f.apply(); // 同一日志读回可恢复，不重复迁移 Origin。
  assert.equal(f.calls.filter(call => call.path === "/api/v1/admin/instance-origin" && call.method === "PUT").length, 1);
  await f.prepare("domain-rollback"); result = await f.apply();
  assert.equal(result.receipt.domain_enabled, false); assert.equal(f.workers, true); assert.equal(f.previews, false); assert.equal(f.domains.length, 0);
});

function upgradeInput(f, access, previousBindings = []) {
  const release = { publisher: "https://publisher.test", manifest_version: "1.10.0", manifest_sha256: "a".repeat(64), service_bundle_version: "1.10.0", service_bundle_sha256: "b".repeat(64), service_bundle_source: "https://publisher.test/service.zip", service_api_version: "0.1.0", schema_version: 24 };
  const bindings = [{ type: "assets", name: "ASSETS", value_redacted: true }, { type: "d1", name: "DB", database_id: f.databaseId },
    ...[["PRINCIPAL", "1001", 120], ["INSTANCE", "1002", 300], ["UNAUTHENTICATED", "1003", 30]].flatMap(([name, namespace_id, limit]) => [{ type: "ratelimit", name: `${name}_RATE_LIMITER`, namespace_id }, { type: "plain_text", name: `RATE_LIMIT_${name === "UNAUTHENTICATED" ? "UNAUTHENTICATED_SENSITIVE" : name}_LIMIT`, text: String(limit) }, { type: "plain_text", name: `RATE_LIMIT_${name === "UNAUTHENTICATED" ? "UNAUTHENTICATED_SENSITIVE" : name}_PERIOD_SECONDS`, text: "60" }]), ...previousBindings];
  return { taskId: "managed-upgrade", instanceId: f.input.instanceId, operationId: randomUUID(), cloudflare: { account_id: "account-test", profile: "isolated", api_origin: access.preferred_api_origin },
    resources: { worker: { name: "board", deployment_id: randomUUID(), version_id: randomUUID(), worker_limits: null, bindings }, d1: { name: "board-db", database_id: f.databaseId }, public_access: access, workers_dev: !access.domain_enabled, custom_domain: access.domain_enabled ? access.hostname : null, routes: [], pages: false },
    bindings: { d1: "DB", assets: "ASSETS" }, owner: { display_name: "Test_Owner", principal_id: f.principalId, credential_id: f.credentialId, credential_fingerprint: "test-fingerprint" },
    current: { ...release, service_bundle_sha256: "c".repeat(64) }, target: { ...release, migration_manifest_sha256: "d".repeat(64), compatibility: { node: ">=22.12.0 <27", wrangler: ">=4.127.1 <5", service_api: ">=0.1.0 <0.2.0", schema_version: 24 } }, migrations: [], restorePoint: { required: false, verified: false, reason: "no_migration_delta" } };
}

test("managed-domain upgrade and receipt-bound rollback preserve exposure and remove stale public snapshots", async t => {
  const f = await fixture(t); await f.prepare("domain-enable"); const active = (await f.apply()).receipt;
  f.limits = { cpu_ms: 10, subrequests: 50 };
  const costInput = { ...f.input, accountId: "account-test", workerName: "board" };
  const activeInput = upgradeInput(f, active);
  activeInput.resources.worker.worker_limits = (await readWorkerCostSettings(costInput)).worker_limits;
  const activePlan = createInstanceUpgradePlan(activeInput);
  assert.equal(activePlan.cost_protection.cpu_limit_request, null);
  assert.deepEqual(activePlan.cost_protection.anonymous_login, { limit: 10, period_seconds: 60 });
  await verifyPlannedWorkerCostSettings({ ...costInput, plan: activePlan, phase: "before" });
  assert.equal(activePlan.resources.workers_dev, false); assert.equal(activePlan.binding_changes_allowed, true);
  assert.equal((await verifyPlannedPublicAccess({ ...f.input, plan: activePlan })).verified, true);
  const root = path.join(f.input.home, "service", "versions", "1.10.0", "bundle");
  const files = { "dist/index.js": "export default {}", "apps/web/dist/index.html": "<main>app</main>", "contracts/openapi.json": JSON.stringify({ info: { version: "0.1.0" } }), "migrations/manifest.json": JSON.stringify({ schema_version: 24, migrations: [] }), "release/deployment/migration-readback.sql": "SELECT 1", "wrangler-config-schema.json": "{}", "wrangler.template.json": JSON.stringify({ compatibility_date: "2026-08-29", assets: { binding: "ASSETS", not_found_handling: "none", run_worker_first: ["/docs/*", "!/docs/assets/*"] } }) };
  for (const [name, value] of Object.entries(files)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, value); }
  await atomicWriteJson(path.join(path.dirname(root), ".cfkanban-release.json"), { schema_version: 1, kind: "service_deployment_bundle", version: "1.10.0", artifact_sha256: activeInput.target.service_bundle_sha256, publisher: activeInput.target.publisher, source: activeInput.target.service_bundle_source, bundle_path: root, bundle_tree_digest: await treeDigest(root) });
  const config = async plan => {
    const input = { ...f.input, plan, taskId: plan.task_id, operationId: plan.operation_id, serviceBundleRoot: root, d1DatabaseId: f.databaseId };
    await createJournal(input); await authorizeJournal({ ...input, planDigest: canonicalDigest(plan) });
    return JSON.parse(await readFile((await writeFrozenWranglerConfig(input)).wrangler_config_path, "utf8"));
  };
  const domainConfig = await config(activePlan);
  assert.deepEqual(domainConfig.limits, { cpu_ms: 10, subrequests: 50 });
  assert.ok(domainConfig.ratelimits.some(item => item.name === "ANONYMOUS_LOGIN_RATE_LIMITER"));
  await verifyPlannedWorkerCostSettings({ ...costInput, plan: activePlan, phase: "after" });
  assert.equal(domainConfig.workers_dev, false); assert.equal(domainConfig.preview_urls, false); assert.equal(domainConfig.routes[0].pattern, active.hostname); assert.equal(domainConfig.vars.PUBLIC_ACCESS_MODE, "custom_domain");
  await f.prepare("domain-rollback"); const inactive = (await f.apply()).receipt;
  const rollbackInput = upgradeInput(f, inactive, publicAccessBindings(active));
  assert.throws(() => createInstanceUpgradePlan({ ...rollbackInput, resources: { ...rollbackInput.resources, public_access: undefined } }), { code: "PUBLIC_ACCESS_RECEIPT_REQUIRED" });
  const rollbackPlan = createInstanceUpgradePlan(rollbackInput);
  assert.equal(rollbackPlan.resources.workers_dev, true); assert.equal(rollbackPlan.resources.custom_domain, null); assert.equal(rollbackPlan.binding_changes_allowed, true);
  assert.ok(!targetWorkerBindings(rollbackPlan).some(binding => binding.name.startsWith("PUBLIC_ACCESS_")));
  assert.equal((await verifyPlannedPublicAccess({ ...f.input, plan: rollbackPlan })).workers_dev, true);
  const restoredConfig = await config(rollbackPlan);
  assert.equal(restoredConfig.workers_dev, true); assert.equal(restoredConfig.preview_urls, false); assert.equal(restoredConfig.routes, undefined); assert.equal(restoredConfig.vars.PUBLIC_ACCESS_MODE, undefined);
  f.previews = true;
  await assert.rejects(verifyPlannedPublicAccess({ ...f.input, plan: rollbackPlan }), { code: "PUBLIC_ACCESS_ROUTING_DRIFT" });
});

test("cutover readiness is explicit and receipt fields cannot carry extra payloads", async t => {
  const f = await fixture(t); delete f.input.passkeyRecoveryReady;
  await f.prepare("domain-enable");
  assert.equal(f.execution.plan.passkey_impact.recovery_prepared, false);
  assert.equal(f.execution.plan.passkey_impact.old_rp_id, "board.isolated.workers.dev");
  assert.equal(f.execution.plan.passkey_impact.new_rp_id, "board.example.test");
  await assert.rejects(f.apply(), { code: "PUBLIC_ACCESS_PASSKEY_RECOVERY_NOT_READY" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  f.input.passkeyRecoveryReady = true; await f.prepare("domain-enable"); const receipt = (await f.apply()).receipt;
  assert.throws(() => normalizePublicAccess({ ...receipt, credential: "must-not-pass-through" }), { code: "INVALID_PUBLIC_ACCESS_RECEIPT" });
  assert.throws(() => normalizePublicAccess([]), { code: "INVALID_PUBLIC_ACCESS_RECEIPT" });
  delete f.input.passkeyRecoveryReady; await f.prepare("domain-rollback");
  const writes = f.calls.filter(call => call.method !== "GET").length;
  assert.equal(f.execution.plan.passkey_impact.old_rp_id, "board.example.test");
  assert.equal(f.execution.plan.passkey_impact.new_rp_id, "board.isolated.workers.dev");
  await assert.rejects(f.apply(), { code: "PUBLIC_ACCESS_PASSKEY_RECOVERY_NOT_READY" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, writes);
});

test("public-access locks recover a terminated process and partial lock write while refusing live owners", async t => {
  const f = await fixture(t); await f.prepare("domain-enable");
  const paths = getInstancePaths(f.input), lockInput = { stateRoot: f.input.stateRoot, journalsRoot: paths.journalsRoot, operationId: f.operationId };
  const script = "const {acquirePublicAccessLock}=await import(process.argv[1]); await acquirePublicAccessLock(JSON.parse(process.argv[2])); process.exit(0)";
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, new URL("../../packages/skill-runtime/src/public-access-lock.mjs", import.meta.url).href, JSON.stringify(lockInput)]);
  const directory = path.join(paths.journalsRoot, "public-access-locks"), abandoned = await readdir(directory);
  assert.equal(abandoned.length, 1);
  await writeFile(path.join(directory, abandoned[0]), ""); // 退出可发生于 wx 创建之后、完整 JSON 写完之前。
  const release = await acquirePublicAccessLock(lockInput);
  await assert.rejects(acquirePublicAccessLock(lockInput), { code: "PUBLIC_ACCESS_LOCKED" });
  await release(); assert.deepEqual(await readdir(directory), []);
  await f.apply();
});

test("uncertain domain creation resumes the same intent without another attach or leaking credentials", async t => {
  const f = await fixture(t); await f.prepare("domain-enable"); f.failAfterDomain = true;
  await assert.rejects(f.apply(), { code: "PUBLIC_ACCESS_CONTROL_UNAVAILABLE" });
  assert.equal(f.workers, true);
  await f.apply();
  assert.equal(f.calls.filter(call => call.path.endsWith("/workers/domains") && call.method === "PUT").length, 1);
  assert.ok(!JSON.stringify(f.execution.plan).includes(f.token));
});

test("Free WAF profile preserves unrelated rules, resumes uncertain creation and disables only its rule", async t => {
  const f = await fixture(t); await f.prepare("domain-enable"); await f.apply();
  await f.prepare("waf-enable"); f.failAfterWaf = true;
  await assert.rejects(f.apply(), { code: "PUBLIC_ACCESS_CONTROL_UNAVAILABLE" });
  let result = await f.apply(); assert.equal(result.receipt.waf_profile, "anonymous-api-filter");
  f.rulesets[0].rules.push({ id: "foreign", ref: "other-product", action: "block", expression: "http.host eq \"other.example.test\"", enabled: true });
  const foreign = canonicalDigest(f.rulesets[0].rules[1]);
  await f.prepare("waf-disable"); result = await f.apply();
  assert.equal(result.receipt.waf_profile, "disabled"); assert.equal(f.rulesets[0].rules.length, 1); assert.equal(canonicalDigest(f.rulesets[0].rules[0]), foreign);
  assert.ok(!f.calls.some(call => call.method === "PUT" && call.path.includes("rulesets")));
});

test("resuming an uncertain WAF operation reauthenticates Owner before another control-plane write", async t => {
  const f = await fixture(t); await f.prepare("domain-enable"); await f.apply(); await f.prepare("waf-enable");
  const fetchImpl = f.execution.fetchImpl;
  f.execution.fetchImpl = async (url, options) => {
    if (new URL(url).pathname.endsWith("/rulesets") && options.method === "POST") throw new Error("not committed");
    return fetchImpl(url, options);
  };
  await assert.rejects(f.apply(), { code: "PUBLIC_ACCESS_CONTROL_UNAVAILABLE" });
  f.execution.fetchImpl = fetchImpl; f.owner = false;
  const writes = f.calls.filter(call => call.method !== "GET").length;
  await assert.rejects(f.apply(), { code: "PUBLIC_ACCESS_OWNER_REQUIRED" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, writes);
  assert.equal(f.rulesets.length, 0);
});

test("capacity, external resource drift, incomplete inventories and mismatched discovery fail before dangerous writes", async t => {
  const occupied = await fixture(t); occupied.dns = [{ id: "existing" }];
  await assert.rejects(occupied.prepare("domain-enable"), { code: "PUBLIC_ACCESS_DNS_ALREADY_IN_USE" });
  assert.equal(occupied.calls.filter(call => call.method !== "GET").length, 0);
  const partial = await fixture(t); partial.partial = true;
  await assert.rejects(partial.prepare("domain-enable"), { code: "PUBLIC_ACCESS_INVENTORY_INCOMPLETE" });
  const wrong = await fixture(t); await wrong.prepare("domain-enable"); wrong.wrongDiscovery = true;
  await assert.rejects(wrong.apply(), { code: "PUBLIC_ACCESS_DISCOVERY_MISMATCH" });
  assert.equal(wrong.workers, true); assert.equal(wrong.version, 1);
  const full = await fixture(t); await full.prepare("domain-enable"); await full.apply();
  full.rulesets = [{ id: "foreign", kind: "zone", phase: "http_request_firewall_custom", rules: Array.from({ length: 5 }, (_, i) => ({ id: `foreign-${i}`, ref: `foreign-${i}`, expression: "false", action: "block" })) }];
  await assert.rejects(full.prepare("waf-enable"), { code: "PUBLIC_ACCESS_FREE_CAPACITY_UNAVAILABLE" });
});

test("owned Free profile is narrowly hostname scoped and public CLI discovers all lifecycle operations", () => {
  const rule = anonymousApiRule("board.example.test", randomUUID());
  assert.match(rule.expression, /http\.host eq "board\.example\.test"/u);
  assert.match(rule.expression, /authorization/u); assert.match(rule.expression, /cfkanban_session=/u);
  assert.doesNotMatch(rule.expression, /web-authentication|public-join|challenges|turnstile|rate_limit/iu);
  for (const suffix of ["inspect", "plan", "apply", "resume"]) assert.ok(COMMANDS.some(command => command.name === `deploy public-access ${suffix}`));
  assert.ok(COMMANDS.find(command => command.name === "deploy upgrade plan").fields.includes("workerLimits"));
});
