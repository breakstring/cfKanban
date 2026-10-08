import assert from "node:assert/strict";
import test from "node:test";
import { dispatch } from "../../packages/skill-runtime/src/cli.mjs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { applyWafTarget, createWafTargetPlan, inspectWafTarget, readWafAuthority } from "../../packages/skill-runtime/src/waf-target.mjs";
import { anonymousApiRule, applyPublicAccess, createPublicAccessPlan, inspectPublicAccess, verifyPublicAccessConfiguration } from "../../packages/skill-runtime/src/public-access.mjs";
import { projectWafAuthority } from "../../packages/skill-runtime/src/public-access-config.mjs";
import { appendJournalEvent, authorizeJournal, createJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { createPendingCredential, getInstancePaths, loadPendingCredentialSecret, promotePendingCredential, putInstanceMetadata } from "../../packages/skill-runtime/src/state.mjs";
import { atomicWriteJson, canonicalDigest } from "../../packages/skill-runtime/src/utils.mjs";
import { readPendingWaf } from "../../packages/skill-runtime/src/waf-pending.mjs";

// 所有请求均进入本地 fixture，D1 batch 使用真实 SQLite transaction。
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfk-waf-target-")), db = new DatabaseSync(":memory:");
  t.after(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  for (const file of (await readdir("migrations")).filter(name => /^\d+.*\.sql$/.test(name)).sort()) db.exec(await readFile(path.join("migrations", file), "utf8"));
  const instanceId = randomUUID(), principalId = randomUUID(), credentialId = randomUUID(), databaseId = randomUUID(), hostname = "board.example.test", preferred = `https://${hostname}`;
  const input = { home, stateRoot: path.join(home, ".cfkanban"), persistenceConfirmed: true, instanceId, taskId: "target-test", zoneId: "zone-test", hostname, cloudflareProfile: "isolated", wranglerExecutable: "/mock/wrangler", environment: {}, tokenRunner: async () => ({ stdout: JSON.stringify({ type: "oauth", token: "mock-control-secret" }) }) };
  await putInstanceMetadata({ ...input, trustedApiOrigin: preferred, originVersion: 1 });
  await createPendingCredential({ ...input, principalId, credentialId, purpose: "owner_bootstrap" });
  const credential = await loadPendingCredentialSecret(input);
  await promotePendingCredential({ ...input, principalId, credentialId, fingerprint: credential.metadata.fingerprint });
  db.prepare("INSERT INTO principals(id,display_name,display_name_key,version,created_at,updated_at) VALUES(?1,'Owner','owner',1,1,1)").run(principalId);
  db.prepare("INSERT INTO instance_meta(singleton,instance_id,owner_principal_id,service_version,schema_version,created_at) VALUES(1,?1,?2,'0.1.0',27,1)").run(instanceId, principalId);
  db.prepare("INSERT INTO instance_origin_settings(singleton,preferred_api_origin,version,updated_at,updated_by_principal_id) VALUES(1,?1,1,1,?2)").run(preferred, principalId);
  db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,?3,?4,1,?5)").run(credentialId, principalId, credential.metadata.token_prefix, credential.metadata.token_digest, randomUUID());
  const paths = getInstancePaths(input); input.receiptPath = path.join(paths.receiptsRoot, "deployment.json");
  await atomicWriteJson(input.receiptPath, { kind: "cfkanban_deployment_receipt", instance: { id: instanceId }, cloudflare: { account_id: "account-test", profile: "isolated", worker: { name: "board" }, d1: { database_id: databaseId } }, owner: { principal_id: principalId } });
  const f = { input, db, paths, credential, principalId, credentialId, activeDeploymentId: randomUUID(), activeVersionId: randomUUID(), calls: [], rules: [], domainPresent: true, workers: false, previews: false, foreignDomain: false, fixedDrift: false, writes: 0, beforeWrite: null, loseResponse: false, serviceDispatches: 0, serviceUnknown: false, serviceStatus: "verified", noIntent: false, serviceVerifyKeys: [], verifyResponses: new Map() };
  const commitService = () => {
    if (f.serviceCommitted || f.serviceStatus !== "verified") return;
    const binding = db.prepare("SELECT * FROM cloudflare_waf_target_binding").get(), rule = f.serviceRule, ref = rule.ref, enabled = f.serviceAction === "enable";
    f.rules = enabled ? [{ id: "service-rule", ...rule }] : [];
    db.prepare("UPDATE cloudflare_waf_ownership SET binding_id=?1,rule_id=?2,ruleset_id=?3,rule_ref=?4,rule_digest=?5,operation_id=?6,verified_at=?7").run(binding.binding_id, enabled ? "service-rule" : null, enabled ? "ruleset-test" : null, ref, enabled ? canonicalDigest(rule) : null, f.serviceOperationId, Date.now());
    db.prepare("UPDATE cloudflare_control_settings SET version=version+1").run(); f.serviceCommitted = true;
  };
  const operationResource = () => ({ kind: "waf", operation_id: f.serviceOperationId, status: f.serviceStatus, version: db.prepare("SELECT version FROM cloudflare_control_settings").get().version, baseline_version_id: null, result_version_id: null, deployment_id: null, result_rule_id: f.serviceResultRuleId === undefined ? f.serviceCommitted && f.serviceAction === "enable" ? "service-rule" : null : f.serviceResultRuleId, failure_class: f.serviceFailure ?? null, created_at: new Date(1).toISOString(), updated_at: new Date(2).toISOString() });
  const operationWrite = () => ({ resource: operationResource(), event_cursor: "fixture-cursor", idempotent_replay: false });
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  input.fetchImpl = async (url, options = {}) => {
    const u = new URL(url), method = options.method ?? "GET", body = options.body ? JSON.parse(options.body) : null;
    f.calls.push({ origin: u.origin, path: u.pathname, method, body });
    if (u.origin === "https://api.cloudflare.com") {
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer mock-control-secret");
      if (u.pathname.endsWith(`/d1/database/${databaseId}/query`)) {
        const writing = body.batch.some(item => /^(UPDATE|INSERT)/.test(item.sql));
        if (writing) { f.writes++; if (f.beforeWrite) { const before = f.beforeWrite; f.beforeWrite = null; before(); } }
        try {
          if (writing) db.exec("BEGIN");
          const result = body.batch.map(item => ({ success: true, results: db.prepare(item.sql).all(...item.params) }));
          if (writing) db.exec("COMMIT");
          if (writing && f.loseResponse) { f.loseResponse = false; throw new Error("lost committed response"); }
          return json({ success: true, result });
        } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      }
      const p = u.pathname.replace("/client/v4/accounts/account-test/workers", "/workers").replace("/client/v4/zones/zone-test", "/zone");
      let result;
      if (p === "/workers/subdomain") result = { subdomain: "isolated" };
      else if (p === "/workers/scripts/board/subdomain") { if (method === "POST") { f.workers = body.enabled; f.previews = body.previews_enabled; } result = { enabled: f.workers, previews_enabled: f.previews }; }
      else if (p === "/workers/scripts/board/settings") result = { compatibility_flags: f.candidateFlags ?? ["global_fetch_strictly_public"], bindings: [{ type: "d1", name: "DB", id: databaseId }, ...Object.entries({ CFKANBAN_CONTROL_ACCOUNT_ID: "account-test", CFKANBAN_CONTROL_WORKER_NAME: f.fixedDrift ? "foreign" : "board", CFKANBAN_CONTROL_DATABASE_ID: databaseId }).map(([name, text]) => ({ type: "plain_text", name, text }))] };
      else if (p === "/workers/scripts/board/deployments") result = { deployments: [{ id: f.activeDeploymentId, versions: [{ version_id: f.activeVersionId, percentage: f.activePercentage ?? 100 }] }] };
      else if (p === `/workers/scripts/board/versions/${f.activeVersionId}`) result = { id: f.activeVersionId, resources: { script_runtime: { compatibility_flags: f.compatibilityFlags ?? ["global_fetch_strictly_public"] }, bindings: [{ type: "d1", name: "DB", id: f.activeDatabaseId ?? databaseId }, ...Object.entries({ CFKANBAN_CONTROL_ACCOUNT_ID: "account-test", CFKANBAN_CONTROL_WORKER_NAME: "board", CFKANBAN_CONTROL_DATABASE_ID: databaseId }).map(([name, text]) => ({ type: "plain_text", name, text }))] } };
      else if (p === "/workers/services/board/environments/production/routes" || p === "/zone/workers/routes") result = [];
      else if (p === "/workers/domains") result = f.domainPresent ? [{ id: "domain-test", hostname, service: f.foreignDomain ? "foreign" : "board", zone_id: "zone-test" }] : [];
      else if (p === "/workers/domains/domain-test" && method === "DELETE") { f.domainPresent = false; result = null; }
      else if (p === "/zone") result = { id: "zone-test", name: "example.test", status: "active", account: { id: "account-test" } };
      else if (p === "/zone/rulesets") result = f.rules.length ? [{ id: "ruleset-test", kind: f.rulesetKind ?? "zone", phase: "http_request_firewall_custom" }] : [];
      else if (p === "/zone/rulesets/ruleset-test" || p === "/zone/rulesets/phases/http_request_firewall_custom/entrypoint") result = { id: p.includes("/entrypoint") && f.entrypointForeign ? "foreign-entrypoint" : "ruleset-test", kind: f.rulesetKind ?? "zone", phase: "http_request_firewall_custom", rules: f.rules };
      else assert.fail(`Unexpected fixed Cloudflare request ${method} ${p}`);
      assert.ok(method === "GET" || p === "/workers/scripts/board/subdomain" || p === "/workers/domains/domain-test"); return json({ success: true, result });
    }
    assert.ok([preferred, "https://board.isolated.workers.dev"].includes(u.origin));
    const originState = db.prepare("SELECT preferred_api_origin,version FROM instance_origin_settings").get();
    if (u.pathname === "/.well-known/cfkanban-instance.json") { assert.equal(new Headers(options.headers).get("authorization"), null); return json({ discovery_version: 1, instance_id: instanceId, observed_origin: u.origin, preferred_api_origin: originState.preferred_api_origin, origin_version: originState.version }); }
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${credential.token}`);
    if (u.pathname === "/api/v1/meta") return json({ instance_id: instanceId, schema_version: 27, observed_origin: u.origin, preferred_api_origin: originState.preferred_api_origin, origin_version: originState.version, principal: { id: principalId, is_owner: true } });
    if (u.pathname === "/api/v1/admin/instance-origin") { if (method === "PUT") { assert.equal(body.expected_version, originState.version); db.prepare("UPDATE instance_origin_settings SET preferred_api_origin=?1,version=version+1").run(body.preferred_api_origin); } const current = db.prepare("SELECT preferred_api_origin,version FROM instance_origin_settings").get(); return json(current); }
    if (u.pathname === "/api/v1/me") return json({ id: principalId, is_owner: true, credential: { id: credentialId, fingerprint: credential.metadata.fingerprint } });
    if (u.pathname === "/api/v1/admin/cloudflare") return json({ version: db.prepare("SELECT version FROM cloudflare_control_settings").get().version });
    if (u.pathname === "/api/v1/admin/cloudflare/waf/plan") { f.serviceAction = body.action; f.serviceOperationId = randomUUID(); f.servicePlanId = randomUUID(); f.serviceCommitted = false; f.serviceRule = { ...anonymousApiRule(hostname, instanceId), ref: `${anonymousApiRule(hostname, instanceId).ref}_${f.servicePlanId.replaceAll("-", "")}` }; return json({ resource: { kind: "waf", plan_id: f.servicePlanId, version: body.expected_version, before: { owned_rule: body.action === "disable" ? { id: db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").get().rule_id, ruleset_id: "ruleset-test" } : null }, after: { action: body.action, rule: f.serviceRule, entrypoint_strategy: body.action === "disable" ? "delete_owned_rule" : "append_rule", apply_ready: true, purchase_or_upgrade_plan: false, modifies_foreign_rules: false } } }); }
    if (u.pathname === "/api/v1/admin/cloudflare/waf/apply") {
      f.serviceDispatches++;
      if (f.serviceNotDispatched) { const requestId = randomUUID(); return json({ code: "VERSION_CONFLICT", category: "conflict", source: "service", message: "fixture pre-dispatch rejection", recovery: "refresh_and_retry", request_id: requestId, retryable: false, details: { write_state: "not_dispatched" } }, 409, { "x-request-id": requestId }); }
      commitService(); if (f.serviceUnknown) throw new Error("unknown dispatched response");
      return json(f.truncatedApply ? { resource: { kind: "waf", operation_id: f.serviceOperationId, status: f.serviceStatus, version: 1 } } : operationWrite());
    }
    if (/\/waf\/operations\//.test(u.pathname)) { if (f.serviceUnknown) throw new Error("unavailable legacy lookup"); commitService(); return f.noIntent ? json({ code: "NOT_FOUND" }, 404) : json(f.truncatedLookup ? { kind: "waf", operation_id: f.serviceOperationId, status: f.serviceStatus, version: 1 } : operationResource()); }
    if (/\/operations\/[^/]+\/verify$/.test(u.pathname)) {
      const key = new Headers(options.headers).get("idempotency-key"); f.serviceVerifyKeys.push(key);
      if (f.verifyResponses.has(key)) return json(f.verifyResponses.get(key));
      if (f.verifyStatus) f.serviceStatus = f.verifyStatus; commitService(); const response = f.truncatedVerify ? { resource: { kind: "waf", operation_id: f.serviceOperationId, status: f.serviceStatus, version: 1 } } : operationWrite();
      if (!f.truncatedVerify) f.verifyResponses.set(key, response);
      if (f.verifyLost) { f.verifyLost = false; throw new Error("lost verify response"); } return json(response);
    }
    assert.fail(`Unexpected trusted API ${method} ${u.pathname}`);
  };
  f.prepare = async ({ dispatched = true } = {}) => { const result = await createWafTargetPlan(input); f.execution = { ...input, plan: result.plan, operationId: result.plan.operation_id }; await createJournal(f.execution); await authorizeJournal({ ...f.execution, planDigest: result.plan_digest }); if (dispatched) await appendJournalEvent({ ...f.execution, event: { type: "waf_target_registration_intent" } }); return result; };
  f.apply = () => applyWafTarget(f.execution);
  f.seedServiceDispatch = async execution => { await appendJournalEvent({ ...execution, event: { type: "public_access_service_dispatch" } }); f.serviceDispatches++; };
  f.prepareService = async (mode = "waf-enable") => { const result = await createPublicAccessPlan({ ...input, mode }); const execution = { ...input, plan: result.plan, operationId: result.plan.operation_id }; await createJournal(execution); await authorizeJournal({ ...execution, planDigest: result.plan_digest }); if (mode === "waf-enable") await f.seedServiceDispatch(execution); return execution; };
  f.legacy = async () => {
    const receipt = { schema_version: 1, kind: "cfkanban_public_access_receipt", instance_id: instanceId, account_id: "account-test", worker_name: "board", zone_id: "zone-test", hostname, domain_enabled: true, domain_id: "domain-test", workers_dev_origin: "https://board.isolated.workers.dev", workers_dev: false, previews_enabled: false, preferred_api_origin: preferred, rule_id: "rule-test", ruleset_id: "ruleset-test", rule_ref: anonymousApiRule(hostname, instanceId).ref, waf_profile: "anonymous-api-filter", operation_id: randomUUID(), plan_digest: "a".repeat(64), verified_at: new Date(1).toISOString(), snapshot_not_realtime: true };
    f.rules = [{ id: "rule-test", ...anonymousApiRule(hostname, instanceId) }]; await atomicWriteJson(path.join(paths.receiptsRoot, "public-access.json"), receipt); return receipt;
  };
  return f;
}
test("legacy dispatched target registration binds exact old domain, reuses ID and recovers lost commit", async t => {
  const f = await fixture(t); await f.prepare(); f.loseResponse = true;
  const result = await f.apply(); assert.equal(result.receipt.binding.source, "deployment_runtime"); assert.equal(result.public_access.domain_ownership_proven, false); assert.equal(result.public_access.kind, "cfkanban_waf_target_projection");
  assert.equal(f.writes, 1); assert.deepEqual(await f.apply(), result); assert.equal(f.writes, 1);
  const next = await f.prepare(); assert.equal(next.plan.binding_id, result.receipt.binding.binding_id); await f.apply(); assert.equal(f.writes, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='instance.waf-target-registered'").get().n, 2);
  assert.equal(f.calls.filter(call => call.origin === "https://api.cloudflare.com" && call.method !== "GET" && !call.path.endsWith("/query")).length, 0);
});
test("target guards reject revoked Owner, origin/control changes and pending locks with no partial writes", async t => {
  for (const change of [db => db.prepare("UPDATE credentials SET revoked_at=2 WHERE id IS NOT NULL").run(), db => db.prepare("UPDATE instance_origin_settings SET version=version+1").run(), db => db.prepare("UPDATE cloudflare_control_settings SET version=version+1").run(), db => db.prepare("UPDATE cloudflare_control_settings SET locked_operation_id='unknown'").run()]) {
    const f = await fixture(t); await f.prepare(); f.beforeWrite = () => change(f.db); await assert.rejects(f.apply());
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloudflare_waf_target_binding").get().n, 0); assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM operation_commits").get().n, 0);
  }
});
test("target registration audit failure rolls back binding, ownership and control CAS", async t => {
  const f = await fixture(t); await f.prepare(); f.db.exec("CREATE TRIGGER reject_target_audit BEFORE INSERT ON events WHEN NEW.type='instance.waf-target-registered' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  await assert.rejects(f.apply()); assert.equal(f.db.prepare("SELECT version FROM cloudflare_control_settings").get().version, 1); assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloudflare_waf_target_binding").get().n, 0);
});
test("only exact private legacy receipt migrates a rule; matching manual ref remains foreign", async t => {
  const f = await fixture(t); const historical = await f.legacy(); await f.prepare(); const result = await f.apply();
  assert.equal(result.receipt.ownership.rule_id, "rule-test"); assert.equal(result.receipt.ownership.rule_digest, canonicalDigest(anonymousApiRule(f.input.hostname, f.input.instanceId)));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.paths.receiptsRoot, "public-access.json"), "utf8")), historical);
  const manual = await fixture(t); manual.rules = [{ id: "manual", ...anonymousApiRule(manual.input.hostname, manual.input.instanceId) }]; await manual.prepare(); assert.equal((await manual.apply()).receipt.ownership.rule_id, null);
  const drift = await fixture(t); await drift.legacy(); drift.rules[0].action_parameters = { custom_response: { status_code: 401 } }; await assert.rejects(drift.prepare(), { code: "WAF_TARGET_LEGACY_OWNERSHIP_UNPROVEN" });
  for (const mismatch of ["rulesetKind", "entrypointForeign"]) { const unproven = await fixture(t); await unproven.legacy(); unproven[mismatch] = mismatch === "rulesetKind" ? "custom" : true; await assert.rejects(unproven.prepare(), { code: "WAF_TARGET_LEGACY_OWNERSHIP_UNPROVEN" }); }
});
test("target mismatch and superseded registration cannot adopt or overwrite changed state", async t => {
  const foreign = await fixture(t); foreign.foreignDomain = true; await assert.rejects(foreign.prepare(), { code: "WAF_TARGET_DOMAIN_UNPROVEN" });
  const fixed = await fixture(t); fixed.fixedDrift = true; await assert.rejects(fixed.prepare(), { code: "WAF_TARGET_FIXED_TARGET_DRIFT" });
  for (const flags of [[], ["global_fetch_strictly_public", "global_fetch_private_origin"]]) { const privateFetch = await fixture(t); privateFetch.compatibilityFlags = flags; await assert.rejects(privateFetch.prepare(), { code: "PUBLIC_ACCESS_PUBLIC_FETCH_REQUIRED" }); assert.equal(privateFetch.writes, 0); }
  const candidate = await fixture(t); candidate.candidateFlags = ["global_fetch_private_origin"]; await candidate.prepare();
  const divided = await fixture(t); divided.activePercentage = 50; await assert.rejects(divided.prepare(), { code: "PUBLIC_ACCESS_ACTIVE_WORKER_UNPROVEN" });
  const wrongDatabase = await fixture(t); wrongDatabase.activeDatabaseId = randomUUID(); await assert.rejects(wrongDatabase.prepare(), { code: "PUBLIC_ACCESS_ACTIVE_WORKER_UNPROVEN" });
  const f = await fixture(t); await f.prepare(); await f.apply(); f.db.prepare("UPDATE cloudflare_waf_ownership SET operation_id=?1").run(randomUUID()); await assert.rejects(f.apply(), { code: "WAF_TARGET_REGISTRATION_SUPERSEDED" }); assert.equal(f.writes, 1);
});
test("schema 27 runtime WAF uses reviewed Worker plan and dispatch fence, without Cloudflare rule writes", async t => {
  const f = await fixture(t); await f.prepare(); await f.apply();
  const planned = await createPublicAccessPlan({ ...f.input, mode: "waf-enable", conflictChoice: "preserve_exemptions" });
  const execution = { ...f.input, plan: planned.plan, operationId: planned.plan.operation_id }; await createJournal(execution); await authorizeJournal({ ...execution, planDigest: planned.plan_digest });
  await f.seedServiceDispatch(execution); f.serviceUnknown = true; await assert.rejects(applyPublicAccess(execution), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); f.serviceUnknown = false;
  const result = await applyPublicAccess(execution); assert.equal(result.operation.status, "verified"); assert.equal(f.serviceDispatches, 1); assert.equal(result.domain_receipt_unchanged, true);
  const none = await createPublicAccessPlan({ ...f.input, mode: "waf-disable" }); const missing = { ...f.input, plan: none.plan, operationId: none.plan.operation_id }; await createJournal(missing); await authorizeJournal({ ...missing, planDigest: none.plan_digest });
  f.serviceUnknown = true; await assert.rejects(applyPublicAccess(missing)); f.noIntent = true; await assert.rejects(applyPublicAccess(missing), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); assert.equal(f.serviceDispatches, 2);
});

test("a previously frozen Service enable plan without dispatch cannot create a new rule", async t => {
  const f = await fixture(t); await f.prepare(); await f.apply();
  const prepared = await createPublicAccessPlan({ ...f.input, mode: "waf-enable" });
  const execution = { ...f.input, plan: prepared.plan, operationId: prepared.plan.operation_id };
  await createJournal(execution); await authorizeJournal({ ...execution, planDigest: prepared.plan_digest });
  await assert.rejects(applyPublicAccess(execution), { code: "CLOUDFLARE_FEATURE_RETIRED" });
  assert.equal(f.serviceDispatches, 0); assert.equal(f.rules.length, 0); assert.equal(await readPendingWaf(f.input), null);
});
test("lost dispatch plus absent intent blocks new WAF and target mutations until the exact original resume verifies", async t => {
  const f = await fixture(t); await f.prepare(); await f.apply(); await f.prepare(); const targetExecution = f.execution;
  const concurrent = await f.prepareService(), original = await f.prepareService(); f.serviceUnknown = true;
  await assert.rejects(applyPublicAccess(original), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); f.noIntent = true;
  await assert.rejects(applyPublicAccess(original), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" });
  assert.equal((await readPendingWaf(f.input)).operation_id, original.operationId);
  await assert.rejects(f.prepareService(), { code: "WAF_PENDING_OPERATION_REQUIRED" });
  await assert.rejects(applyPublicAccess(concurrent), { code: "WAF_PENDING_OPERATION_REQUIRED" });
  await assert.rejects(createWafTargetPlan(f.input), { code: "WAF_PENDING_OPERATION_REQUIRED" });
  await assert.rejects(applyWafTarget(targetExecution), { code: "WAF_PENDING_OPERATION_REQUIRED" });
  assert.equal(f.serviceDispatches, 2); f.noIntent = false; f.serviceUnknown = false;
  await applyPublicAccess(original); assert.equal(await readPendingWaf(f.input), null); await f.prepareService();
});
test("truncated apply, lookup and verify cannot release the service dispatch fence", async t => {
  for (const kind of ["lookup", "verify"]) {
    const f = await fixture(t); await f.prepare(); await f.apply(); const execution = await f.prepareService();
    if (kind === "lookup") { f.serviceUnknown = true; await assert.rejects(applyPublicAccess(execution)); f.serviceUnknown = false; f.truncatedLookup = true; }
    else { f.serviceStatus = "pending"; f.verifyStatus = "verified"; f.truncatedVerify = true; }
    await assert.rejects(applyPublicAccess(execution), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); assert.equal(f.serviceDispatches, 1);
    const journal = JSON.parse(await readFile(path.join(f.paths.journalsRoot, `${execution.operationId}.json`), "utf8")); assert.ok(!journal.events.some(event => event.type === "public_access_service_verified"));
    f.truncatedApply = false; f.truncatedLookup = false; f.truncatedVerify = false;
    assert.equal((await applyPublicAccess(execution)).operation.status, "verified"); assert.equal(f.serviceDispatches, 1);
  }
});
test("verified service operation must agree with current ownership and its previously observed terminal result", async t => {
  const f = await fixture(t); await f.prepare(); await f.apply(); const execution = await f.prepareService();
  f.serviceResultRuleId = "different-rule"; await assert.rejects(applyPublicAccess(execution), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); assert.equal(f.serviceDispatches, 1);
  f.serviceResultRuleId = undefined; await applyPublicAccess(execution);
  f.serviceFailure = "changed-terminal"; await assert.rejects(applyPublicAccess(execution), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); f.serviceFailure = null;
  f.db.prepare("UPDATE cloudflare_waf_ownership SET operation_id=?1").run(randomUUID()); await assert.rejects(applyPublicAccess(execution), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); assert.equal(f.serviceDispatches, 1);
  assert.equal(await readPendingWaf(f.input), null);
});
test("complete unknown verification advances rounds while lost HTTP reuses its original round", async t => {
  for (const lost of [false, true]) {
    const f = await fixture(t); await f.prepare(); await f.apply(); const execution = await f.prepareService(); f.serviceStatus = "unknown"; f.verifyStatus = "unknown"; f.verifyLost = lost;
    await assert.rejects(applyPublicAccess(execution), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" });
    if (lost) { await assert.rejects(applyPublicAccess(execution), { code: "PUBLIC_ACCESS_SERVICE_OUTCOME_UNKNOWN" }); assert.equal(f.serviceVerifyKeys[0], f.serviceVerifyKeys[1]); }
    f.verifyStatus = "verified"; assert.equal((await applyPublicAccess(execution)).operation.status, "verified");
    assert.notEqual(f.serviceVerifyKeys[0], f.serviceVerifyKeys.at(-1)); assert.equal(f.serviceDispatches, 1);
  }
});
test("trusted not-dispatched and complete failed operations are retained confirmed failures without redispatch", async t => {
  for (const notDispatched of [true, false]) {
    const f = await fixture(t); await f.legacy(); await f.prepare(); await f.apply(); const execution = await f.prepareService("waf-disable"); f.serviceNotDispatched = notDispatched; f.serviceStatus = "failed"; f.serviceFailure = "provider_rejected";
    const result = await applyPublicAccess(execution); assert.equal(result.ok, false); assert.equal(result.cloudflare_status, "failed"); assert.equal(result.outcome_unknown, false); assert.equal(result.operation.failure_class, notDispatched ? "not_dispatched" : "provider_rejected");
    assert.deepEqual(await applyPublicAccess(execution), result); assert.equal(f.serviceDispatches, 1); assert.equal(f.serviceVerifyKeys.length, 0);
    assert.equal(await readPendingWaf(f.input), null); await f.prepareService();
  }
});
test("current authority produces suffix-aware upgrade projection without changing domain ownership proof", async t => {
  const f = await fixture(t); const receipt = await f.legacy(); await f.prepare(); await f.apply();
  const ref = `${receipt.rule_ref}_${randomUUID().replaceAll("-", "")}`, rule = { ...anonymousApiRule(f.input.hostname, f.input.instanceId), ref };
  f.rules = [{ id: "new-rule", ...rule }]; f.db.prepare("UPDATE cloudflare_waf_ownership SET rule_id='new-rule',rule_ref=?1,rule_digest=?2,operation_id=?3").run(ref, canonicalDigest(rule), randomUUID());
  const observed = await inspectWafTarget(f.input), authority = await readWafAuthority(f.input), projected = projectWafAuthority(authority, observed.routing, receipt);
  assert.equal(projected.rule_id, "new-rule"); assert.equal(projected.rule_ref, ref); assert.equal(receipt.rule_id, "rule-test");
  await verifyPublicAccessConfiguration({ ...f.input, publicAccessReceipt: projected, publicAccessTarget: observed.target, wafAuthority: authority });
  f.compatibilityFlags = []; await assert.rejects(verifyPublicAccessConfiguration({ ...f.input, publicAccessReceipt: projected, publicAccessTarget: observed.target, wafAuthority: authority }), { code: "PUBLIC_ACCESS_PUBLIC_FETCH_REQUIRED" }); f.compatibilityFlags = undefined;
  f.db.prepare("UPDATE cloudflare_waf_ownership SET rule_id=NULL,ruleset_id=NULL,rule_digest=NULL,operation_id=?1").run(randomUUID()); f.rules = [];
  const off = projectWafAuthority(await readWafAuthority(f.input), observed.routing, receipt); assert.equal(off.waf_profile, "disabled"); assert.equal(off.rule_id, null);
  const disabled = await inspectWafTarget(f.input); assert.equal(disabled.public_access.waf_profile, "disabled"); assert.equal(disabled.imported_ownership, null);
  const publicView = await inspectPublicAccess(f.input); assert.deepEqual(publicView.waf_authority, disabled.waf_authority); assert.equal(publicView.public_access.waf_profile, "disabled"); assert.deepEqual(publicView.public_access_domain_receipt, receipt);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.paths.receiptsRoot, "public-access.json"), "utf8")), receipt);
});

test("schema 27 owned domain rollback disables service WAF first and clears target atomically", async t => {
  const f = await fixture(t); await f.legacy(); await f.prepare(); await f.apply();
  const result = await createPublicAccessPlan({ ...f.input, mode: "domain-rollback", passkeyRecoveryReady: true });
  const execution = { ...f.input, operationId: result.plan.operation_id, plan: result.plan }; await createJournal(execution); await authorizeJournal({ ...execution, planDigest: result.plan_digest });
  const reverted = await applyPublicAccess(execution); assert.equal(reverted.receipt.domain_enabled, false); assert.equal(reverted.receipt.waf_profile, "disabled"); assert.equal(f.workers, true); assert.equal(f.domainPresent, false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloudflare_waf_target_binding").get().n, 0); assert.equal(f.db.prepare("SELECT rule_id FROM cloudflare_waf_ownership").get().rule_id, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='instance.waf-target-cleared'").get().n, 1); assert.equal(f.serviceDispatches, 1);
  assert.deepEqual((await applyPublicAccess(execution)).receipt, reverted.receipt);
});

test("retired target planning accepts only proven private legacy domain ownership for upgrade recovery", async t => {
  const fresh = await fixture(t);
  await assert.rejects(dispatch("plan waf-target", fresh.input, { surface: "deploy" }), error => error.code === "CLOUDFLARE_FEATURE_RETIRED" && error.details.reason === "cloudflare_feature_retired");
  assert.equal(fresh.calls.length, 0);
  const existing = await fixture(t); await existing.legacy();
  const result = await dispatch("plan waf-target", existing.input, { surface: "deploy" });
  assert.equal(result.plan.effects.import_exact_legacy_owned_rule, true);
  assert.equal(result.plan.effects.cloudflare_resource_writes, false);
  await existing.prepare({ dispatched: false });
  assert.equal((await existing.apply()).receipt.ownership.rule_id, "rule-test");
});
test("a frozen undispatched target registration cannot bypass retired setup without exact legacy ownership", async t => {
  const f = await fixture(t); await f.prepare({ dispatched: false });
  await assert.rejects(f.apply(), { code: "CLOUDFLARE_FEATURE_RETIRED" });
  assert.equal(f.writes, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloudflare_waf_target_binding").get().n, 0);
});
test("registered-domain projection never authorizes domain rollback", async t => {
  const f = await fixture(t); await f.prepare(); const registered = await f.apply(); await atomicWriteJson(path.join(f.paths.receiptsRoot, "public-access.json"), registered.public_access);
  await assert.rejects(createPublicAccessPlan({ ...f.input, mode: "domain-rollback", passkeyRecoveryReady: true }), { code: "PUBLIC_ACCESS_OWNERSHIP_REQUIRED" });
});
