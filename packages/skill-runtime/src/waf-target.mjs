import { randomUUID } from "node:crypto";
import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { acquirePublicAccessLock } from "./public-access-lock.mjs";
import { projectWafAuthority } from "./public-access-config.mjs";
import { assertNoPendingWaf } from "./waf-pending.mjs";
import { loadCurrentCredentialSecret } from "./state.mjs";
import { apiRequest } from "./transport.mjs";
import { canonicalDigest, requireString, requireUuid } from "./utils.mjs";
import { anonymousApiRule, loadPublicAccessLocal, publicAccessClients, readPublicAccessOwner, readPublicAccessRouting, readPublicAccessWaf, readPublicAccessZone, verifyPublicAccessActiveWorker, verifyPublicAccessEntrypoint } from "./public-access.mjs";

const BINDING_FIELDS = ["binding_id", "account_id", "worker_name", "database_id", "instance_id", "hostname", "zone_id", "domain_id", "origin_version", "provider_metadata_hash", "source", "verified_at", "operation_id"];
const OWNERSHIP_FIELDS = ["binding_id", "rule_id", "ruleset_id", "rule_ref", "rule_digest", "operation_id", "verified_at"];
const BODY_FIELDS = ["ref", "description", "enabled", "action", "expression"];
const fail = (code, message) => { throw toolError(code, message); };
const bodyOf = rule => Object.fromEntries(BODY_FIELDS.map(key => [key, rule[key] ?? null]));
const rowJson = fields => `json_object(${fields.map(field => `'${field}',${field}`).join(",")})`;
const snapshotJson = (row, fields) => row ? JSON.stringify(Object.fromEntries(fields.map(field => [field, row[field] ?? null]))) : "null";

export async function queryWafTarget(client, statements) {
  const result = await client("/query", { method: "POST", body: { batch: statements } });
  if (!Array.isArray(result) || result.length !== statements.length || result.some(entry => entry?.success !== true || !Array.isArray(entry.results))) fail("WAF_TARGET_READBACK_INVALID", "D1 did not return the complete bounded target registration result");
  return result.map(entry => entry.results);
}
async function dbClient(input, target) { return createCloudflareControlClient({ ...input, accountId: target.account_id, cloudflareProfile: target.cloudflare_profile, contextDirectory: target.context_directory, wranglerExecutable: target.wrangler_executable }, `/d1/database/${target.database_id}`, { errorPrefix: "WAF_TARGET", resourceLabel: "WAF target registration" }); }
async function state(client) {
  const [marker, binding, ownership] = await queryWafTarget(client, [
    { sql: "SELECT m.instance_id,m.owner_principal_id,m.schema_version,s.preferred_api_origin,s.version AS origin_version,c.version AS control_version,c.zone_id,c.locked_operation_id FROM instance_meta m JOIN instance_origin_settings s ON s.singleton=m.singleton JOIN cloudflare_control_settings c ON c.singleton=m.singleton WHERE m.singleton=1 LIMIT 2", params: [] },
    { sql: `SELECT ${BINDING_FIELDS.join(",")} FROM cloudflare_waf_target_binding WHERE singleton=1 LIMIT 2`, params: [] },
    { sql: `SELECT ${OWNERSHIP_FIELDS.join(",")} FROM cloudflare_waf_ownership WHERE singleton=1 LIMIT 2`, params: [] },
  ]);
  if (marker.length !== 1 || binding.length > 1 || ownership.length !== 1 || marker[0].schema_version < 27) fail("WAF_TARGET_SCHEMA_REQUIRED", "Target registration requires the current schema 27 tables and one exact Instance");
  return { marker: marker[0], binding: binding[0] ?? null, ownership: ownership[0] };
}
export async function readWafAuthority(input) {
  const target = input.publicAccessTarget ?? (await loadPublicAccessLocal(input)).target;
  const client = await dbClient(input, target), current = await state(client);
  if (current.marker.instance_id !== target.instance_id || current.marker.preferred_api_origin !== `https://${target.hostname}`) fail("WAF_TARGET_INSTANCE_DRIFT", "D1 does not bind the selected preferred hostname to this Instance");
  if (current.marker.locked_operation_id) fail("WAF_TARGET_OPERATION_PENDING", "Resolve the current control-plane operation before planning or preserving WAF ownership");
  if (current.binding && (current.binding.account_id !== target.account_id || current.binding.worker_name !== target.worker_name || current.binding.database_id !== target.database_id || current.binding.instance_id !== target.instance_id || current.binding.hostname !== target.hostname || current.binding.zone_id !== target.zone_id || current.binding.zone_id !== current.marker.zone_id || current.binding.origin_version !== current.marker.origin_version)) fail("WAF_TARGET_BINDING_DRIFT", "The registered WAF target differs from the current approved deployment or preferred origin");
  if (current.ownership.rule_id && (!current.binding || current.ownership.binding_id !== current.binding.binding_id)) fail("WAF_TARGET_OWNERSHIP_DRIFT", "WAF ownership is not bound to the current registered target");
  return { schema_version: 27, control_version: current.marker.control_version, origin_version: current.marker.origin_version, binding: current.binding, ownership: current.ownership };
}
export async function inspectWafTarget(input) {
  const local = await loadPublicAccessLocal(input), control = await publicAccessClients(input, local.target);
  const owner = await readPublicAccessOwner(input, local);
  const credential = await loadCurrentCredentialSecret({ stateRoot: local.stateRoot, instanceId: local.target.instance_id });
  const me = await apiRequest({ ...input, stateRoot: local.stateRoot, apiPath: "/api/v1/me", expectedPrincipalId: owner.principal_id, expectedCredentialId: credential.metadata.credential_id });
  if (!me.ok || me.data?.is_owner !== true || me.data.credential?.id !== credential.metadata.credential_id || me.data.credential?.fingerprint !== credential.metadata.fingerprint) fail("WAF_TARGET_OWNER_REQUIRED", "Authenticate the exact current Owner device before registering a target");
  Object.assign(owner, { credential_id: credential.metadata.credential_id, credential_fingerprint: credential.metadata.fingerprint });
  if (owner.schema_version < 27 || !Number.isSafeInteger(owner.schema_version)) fail("WAF_TARGET_SCHEMA_REQUIRED", "Upgrade this Instance to schema 27 before registering WAF management");
  if (owner.preferred_api_origin !== `https://${local.target.hostname}` || owner.observed_origin !== owner.preferred_api_origin) fail("WAF_TARGET_ORIGIN_DRIFT", "Register only the current trusted preferred hostname without changing its origin");
  const [zone, routing, settings, activeWorker] = await Promise.all([readPublicAccessZone(control.zone, local.target), readPublicAccessRouting(control.worker, control.zone, local.target), control.worker(`/scripts/${local.target.worker_name}/settings`), verifyPublicAccessActiveWorker(control.worker, local.target)]);
  const domain = routing.domains.find(value => value.hostname === local.target.hostname);
  if (!domain || domain.service !== local.target.worker_name || domain.zone_id !== local.target.zone_id) fail("WAF_TARGET_DOMAIN_UNPROVEN", "The exact existing hostname must map to the receipt-bound Worker and Zone");
  const fixed = { CFKANBAN_CONTROL_ACCOUNT_ID: local.target.account_id, CFKANBAN_CONTROL_WORKER_NAME: local.target.worker_name, CFKANBAN_CONTROL_DATABASE_ID: local.target.database_id };
  for (const [name, value] of Object.entries(fixed)) if (!settings.bindings.some(binding => binding.type === "plain_text" && binding.name === name && (binding.text ?? binding.value) === value)) fail("WAF_TARGET_FIXED_TARGET_DRIFT", "The running Worker's approved fixed control target does not match this deployment");
  const current = await state(await dbClient(input, local.target));
  if (current.marker.instance_id !== local.target.instance_id || current.marker.owner_principal_id !== owner.principal_id || current.marker.preferred_api_origin !== owner.preferred_api_origin || current.marker.origin_version !== owner.origin_version) fail("WAF_TARGET_INSTANCE_DRIFT", "Owner and D1 origin evidence must agree exactly");
  if (current.marker.locked_operation_id) fail("WAF_TARGET_OPERATION_PENDING", "Resolve the pending Cloudflare operation before registering a target");
  if (current.marker.zone_id !== null && current.marker.zone_id !== local.target.zone_id) fail("WAF_TARGET_ZONE_DRIFT", "An already configured Zone cannot be silently replaced");
  let imported = null;
  const migrateLegacy = !current.binding && local.managed?.waf_profile === "anonymous-api-filter";
  if (migrateLegacy && (local.managed.kind !== "cfkanban_public_access_receipt" || !local.managed.domain_enabled || local.managed.domain_ownership_proven === false || local.managed.hostname !== domain.hostname || local.managed.zone_id !== domain.zone_id || local.managed.domain_id !== domain.id || local.managed.preferred_api_origin !== owner.preferred_api_origin)) fail("WAF_TARGET_LEGACY_OWNERSHIP_UNPROVEN", "Legacy rule migration requires this tool's exact historical ownership receipt for the selected live domain");
  if (current.ownership.rule_id || migrateLegacy) {
    const inventory = await readPublicAccessWaf(control.zone), rules = inventory.flatMap(set => set.rules.map(rule => ({ ...rule, ruleset_id: set.id })));
    const proof = current.ownership.rule_id ? current.ownership : local.managed;
    await verifyPublicAccessEntrypoint(control.zone, inventory, proof.ruleset_id, "WAF_TARGET_LEGACY_OWNERSHIP_UNPROVEN");
    const matching = rules.filter(rule => rule.id === proof.rule_id && rule.ruleset_id === proof.ruleset_id && rule.ref === proof.rule_ref);
    const expected = { ...anonymousApiRule(local.target.hostname, local.target.instance_id), ref: proof.rule_ref };
    const allowed = new Set([...BODY_FIELDS, "id", "ruleset_id", "version", "last_updated"]);
    if (matching.length !== 1 || Object.keys(matching[0]).some(key => !allowed.has(key)) || canonicalDigest(bodyOf(matching[0])) !== canonicalDigest(expected) || (current.ownership.rule_id && canonicalDigest(bodyOf(matching[0])) !== current.ownership.rule_digest)) fail("WAF_TARGET_LEGACY_OWNERSHIP_UNPROVEN", "Only exact receipt-owned or service-owned live rule IDs and fixed profile bodies can be preserved");
    imported = { rule_id: proof.rule_id, ruleset_id: proof.ruleset_id, rule_ref: proof.rule_ref, rule_digest: canonicalDigest(bodyOf(matching[0])) };
  }
  if (current.ownership.rule_id && (!current.binding || current.ownership.binding_id !== current.binding.binding_id)) fail("WAF_TARGET_OWNERSHIP_DRIFT", "Existing ownership has no exact target binding");
  const authority = current.binding ? { schema_version: 27, control_version: current.marker.control_version, origin_version: current.marker.origin_version, binding: current.binding, ownership: current.ownership } : null;
  return { target: local.target, owner, zone, routing, domain, active_worker: activeWorker, before: current, imported_ownership: imported, managed_digest: canonicalDigest(local.managed), ...(authority && !routing.workers_dev && !routing.previews_enabled ? { waf_authority: authority, public_access: projectWafAuthority(authority, routing, local.managed) } : {}), cloud_credentials_exposed: false };
}
export async function createWafTargetPlan(input) {
  const local = await loadPublicAccessLocal(input); await assertNoPendingWaf({ stateRoot: local.stateRoot, instanceId: input.instanceId });
  const evidence = await inspectWafTarget(input), operation = requireUuid(input.operationId ?? randomUUID(), "operation_id"), binding = evidence.before.binding;
  const domainHash = canonicalDigest(evidence.domain);
  if (binding && (binding.account_id !== evidence.target.account_id || binding.worker_name !== evidence.target.worker_name || binding.database_id !== evidence.target.database_id || binding.instance_id !== evidence.target.instance_id || binding.hostname !== evidence.target.hostname || binding.zone_id !== evidence.target.zone_id || binding.domain_id !== evidence.domain.id || binding.origin_version !== evidence.owner.origin_version || binding.provider_metadata_hash !== domainHash)) fail("WAF_TARGET_BINDING_DRIFT", "A different registered target requires a separate explicit recovery plan");
  const plan = { kind: "cfkanban_waf_target_registration", schema_version: 1, task_id: requireString(input.taskId, "task_id"), operation_id: operation, instance_id: evidence.target.instance_id, binding_id: binding?.binding_id ?? randomUUID(), event_id: randomUUID(), verified_at: Date.now(), evidence, effects: { register_exact_existing_domain: true, import_exact_legacy_owned_rule: Boolean(evidence.imported_ownership && !evidence.before.ownership.rule_id), cloudflare_resource_writes: false, origin_change: false, credential_creation: false } };
  return { plan, plan_digest: canonicalDigest(plan) };
}
// 旧域名仍需 schema 27 归属事实完成升级或回退；只迁移历史回执，不开放新 WAF 目标。
function assertLegacyTargetReceipt(receipt, evidence = null) {
  if (receipt?.kind !== "cfkanban_public_access_receipt" || receipt.domain_ownership_proven === false || !receipt.domain_enabled) throw toolError("CLOUDFLARE_FEATURE_RETIRED", "WAF setup is retired. Only an existing private domain ownership receipt can enter legacy upgrade recovery.", { reason: "cloudflare_feature_retired" });
  if (evidence && (receipt.account_id !== evidence.target.account_id || receipt.worker_name !== evidence.target.worker_name || receipt.hostname !== evidence.domain.hostname || receipt.zone_id !== evidence.domain.zone_id || receipt.domain_id !== evidence.domain.id || receipt.preferred_api_origin !== evidence.owner.preferred_api_origin)) fail("WAF_TARGET_LEGACY_OWNERSHIP_UNPROVEN", "Legacy upgrade recovery requires the exact existing owned domain, not a new target registration");
}
export async function createLegacyWafTargetPlan(input) {
  const local = await loadPublicAccessLocal(input);
  assertLegacyTargetReceipt(local.managed);
  const result = await createWafTargetPlan(input);
  assertLegacyTargetReceipt(local.managed, result.plan.evidence);
  return result;
}
export function buildWafTargetRegistrationBatch(plan, credential, now) {
  const { evidence: e } = plan, t = e.target, before = e.before, operation = plan.operation_id;
  const binding = { binding_id: plan.binding_id, account_id: t.account_id, worker_name: t.worker_name, database_id: t.database_id, instance_id: t.instance_id, hostname: t.hostname, zone_id: t.zone_id, domain_id: e.domain.id, origin_version: e.owner.origin_version, provider_metadata_hash: canonicalDigest(e.domain), source: "deployment_runtime", verified_at: plan.verified_at, operation_id: operation };
  const imported = e.imported_ownership, ownership = { binding_id: plan.binding_id, rule_id: imported?.rule_id ?? null, ruleset_id: imported?.ruleset_id ?? null, rule_ref: imported?.rule_ref ?? `cfkanban_${t.instance_id.replaceAll("-", "")}_anonymous_api`, rule_digest: imported?.rule_digest ?? null, operation_id: operation, verified_at: plan.verified_at };
  const payload = JSON.stringify({ plan_digest: canonicalDigest(plan), binding, ownership });
  const gate = "EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?1)";
  return [
    { sql: `UPDATE cloudflare_control_settings SET version=version+1,zone_id=?2,last_operation_id=?1,capabilities_json='{}',verified_at=NULL WHERE singleton=1 AND version=?3 AND locked_operation_id IS NULL
      AND EXISTS(SELECT 1 FROM instance_meta m JOIN instance_origin_settings s ON s.singleton=m.singleton JOIN credentials c ON c.principal_id=m.owner_principal_id WHERE m.singleton=1 AND m.instance_id=?4 AND m.schema_version>=27 AND m.owner_principal_id=?5 AND s.preferred_api_origin=?6 AND s.version=?7 AND c.id=?8 AND c.token_digest=?9 AND c.revoked_at IS NULL)
      AND COALESCE((SELECT ${rowJson(BINDING_FIELDS)} FROM cloudflare_waf_target_binding WHERE singleton=1),'null')=?10
      AND COALESCE((SELECT ${rowJson(OWNERSHIP_FIELDS)} FROM cloudflare_waf_ownership WHERE singleton=1),'null')=?11
      AND NOT EXISTS(SELECT 1 FROM operation_commits WHERE operation_id=?1) AND NOT EXISTS(SELECT 1 FROM events WHERE operation_id=?1)`, params: [operation, t.zone_id, before.marker.control_version, t.instance_id, e.owner.principal_id, `https://${t.hostname}`, e.owner.origin_version, credential.credential_id, credential.token_digest, snapshotJson(before.binding, BINDING_FIELDS), snapshotJson(before.ownership, OWNERSHIP_FIELDS)] },
    { sql: `INSERT INTO cloudflare_waf_target_binding(singleton,${BINDING_FIELDS.join(",")}) SELECT 1,${BINDING_FIELDS.map((_, index) => `?${index + 2}`).join(",")} WHERE ${gate} ON CONFLICT(singleton) DO UPDATE SET ${BINDING_FIELDS.map(field => `${field}=excluded.${field}`).join(",")}`, params: [operation, ...BINDING_FIELDS.map(field => binding[field])] },
    { sql: `UPDATE cloudflare_waf_ownership SET ${OWNERSHIP_FIELDS.map((field, index) => `${field}=?${index + 2}`).join(",")} WHERE singleton=1 AND ${gate}`, params: [operation, ...OWNERSHIP_FIELDS.map(field => ownership[field])] },
    { sql: `INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at) SELECT ?2,'security','instance.waf-target-registered',?1,0,?3,?4,'deployment_owner','instance',?5,?6,?7 WHERE ${gate}`, params: [operation, plan.event_id, e.owner.principal_id, credential.credential_id, t.instance_id, payload, now] },
    { sql: "INSERT INTO operation_commits(operation_id,primary_subject_type,primary_subject_id,last_event_sequence,committed_at) VALUES(?1,'instance',?2,(SELECT CASE WHEN COUNT(*)=1 THEN MAX(sequence) END FROM events WHERE operation_id=?1 AND id=?3 AND type='instance.waf-target-registered'),?4)", params: [operation, t.instance_id, plan.event_id, now] },
  ];
}
async function outcome(client, plan) {
  const [rows] = await queryWafTarget(client, [{ sql: "SELECT e.payload_json,c.primary_subject_id,c.last_event_sequence,e.sequence FROM operation_commits c JOIN events e ON e.operation_id=c.operation_id AND e.id=?2 WHERE c.operation_id=?1 LIMIT 2", params: [plan.operation_id, plan.event_id] }]);
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].primary_subject_id !== plan.instance_id || rows[0].last_event_sequence !== rows[0].sequence) fail("WAF_TARGET_PARTIAL_OR_CONFLICT", "Registration audit and commit evidence do not match the original operation");
  let payload; try { payload = JSON.parse(rows[0].payload_json); } catch { fail("WAF_TARGET_READBACK_INVALID", "The target registration audit snapshot is invalid"); }
  if (payload.plan_digest !== canonicalDigest(plan)) fail("WAF_TARGET_PARTIAL_OR_CONFLICT", "The operation has different registered target evidence");
  const current = await state(client);
  if (snapshotJson(current.binding, BINDING_FIELDS) !== snapshotJson(payload.binding, BINDING_FIELDS) || snapshotJson(current.ownership, OWNERSHIP_FIELDS) !== snapshotJson(payload.ownership, OWNERSHIP_FIELDS)) fail("WAF_TARGET_REGISTRATION_SUPERSEDED", "A later target or WAF operation changed this registration; the old operation cannot overwrite it");
  return { kind: "cfkanban_waf_target_registration_receipt", operation_id: plan.operation_id, plan_digest: payload.plan_digest, binding: payload.binding, ownership: payload.ownership, cloudflare_resource_writes: false, snapshot_not_realtime: true };
}
export async function applyWafTarget(input) {
  const plan = input.plan;
  if (plan?.kind !== "cfkanban_waf_target_registration" || plan.schema_version !== 1 || plan.instance_id !== input.instanceId || plan.task_id !== input.taskId || plan.operation_id !== input.operationId) fail("WAF_TARGET_PLAN_REQUIRED", "Use the exact approved WAF target registration plan");
  requireUuid(plan.operation_id, "operation_id"); requireUuid(plan.binding_id, "binding_id"); requireUuid(plan.event_id, "event_id");
  const supplied = { ...input, ...{ receiptPath: plan.evidence.target.receipt_path, hostname: plan.evidence.target.hostname, zoneId: plan.evidence.target.zone_id, wranglerExecutable: plan.evidence.target.wrangler_executable, cloudflareProfile: plan.evidence.target.cloudflare_profile, contextDirectory: plan.evidence.target.context_directory } };
  const local = await loadPublicAccessLocal(supplied);
  if (canonicalDigest(local.target) !== canonicalDigest(plan.evidence.target)) fail("WAF_TARGET_DEPLOYMENT_DRIFT", "The deployment receipt changed after planning target registration");
  const journal = await assertJournalAuthorization({ ...input, stateRoot: local.stateRoot });
  const unlock = await acquirePublicAccessLock({ stateRoot: local.stateRoot, journalsRoot: local.paths.journalsRoot, operationId: plan.operation_id });
  try {
    await assertNoPendingWaf({ stateRoot: local.stateRoot, instanceId: input.instanceId });
    await readPublicAccessOwner(supplied, local);
    const currentCredential = await loadCurrentCredentialSecret({ stateRoot: local.stateRoot, instanceId: input.instanceId });
    if (currentCredential.metadata.credential_id !== plan.evidence.owner.credential_id || currentCredential.metadata.principal_id !== plan.evidence.owner.principal_id || currentCredential.metadata.fingerprint !== plan.evidence.owner.credential_fingerprint) fail("WAF_TARGET_OWNER_REQUIRED", "Resume target registration using the original current Owner device");
    const client = await dbClient(supplied, local.target);
    let receipt = await outcome(client, plan);
    if (!receipt) {
      if (!journal.events.some(entry => entry.type === "waf_target_registration_intent")) assertLegacyTargetReceipt(local.managed, plan.evidence);
      const evidence = await inspectWafTarget(supplied);
      if (canonicalDigest(evidence) !== canonicalDigest(plan.evidence)) fail("WAF_TARGET_BASELINE_CHANGED", "WAF target, ownership or authorization changed after planning");
      const credential = await loadCurrentCredentialSecret({ stateRoot: local.stateRoot, instanceId: input.instanceId });
      if (credential.metadata.principal_id !== evidence.owner.principal_id || credential.metadata.credential_id !== evidence.owner.credential_id || credential.metadata.fingerprint !== evidence.owner.credential_fingerprint) fail("WAF_TARGET_OWNER_REQUIRED", "Use the same current authenticated Owner device");
      await appendJournalEvent({ ...input, stateRoot: local.stateRoot, event: { type: "waf_target_registration_intent" } });
      try { await queryWafTarget(client, buildWafTargetRegistrationBatch(plan, credential.metadata, Date.now())); }
      catch (error) { receipt = await outcome(client, plan); if (!receipt) throw error; }
      receipt ??= await outcome(client, plan);
      if (!receipt) fail("WAF_TARGET_NOT_COMMITTED", "Registration was not committed; retain the original plan and inspect its guard before retrying");
    }
    await appendJournalEvent({ ...input, stateRoot: local.stateRoot, event: { type: "waf_target_registration_complete", binding_id: receipt.binding.binding_id } });
    const authority = await readWafAuthority({ ...supplied, publicAccessTarget: local.target });
    return { receipt, waf_authority: authority, ...(!plan.evidence.routing.workers_dev && !plan.evidence.routing.previews_enabled ? { public_access: projectWafAuthority(authority, plan.evidence.routing, local.managed) } : {}), secret_values_exposed: false };
  } finally { await unlock(); }
}

export async function clearRolledBackWafTarget(input, local, plan) {
  const registered = plan.waf_authority?.binding;
  if (!registered) return;
  const digest = canonicalDigest(`${plan.operation_id}/clear-waf-target`), operation = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const client = await dbClient(input, local.target), credential = await loadCurrentCredentialSecret({ stateRoot: local.stateRoot, instanceId: plan.instance_id });
  const [done] = await queryWafTarget(client, [{ sql: "SELECT c.operation_id FROM operation_commits c JOIN events e ON e.operation_id=c.operation_id AND e.sequence=c.last_event_sequence WHERE c.operation_id=?1 AND e.type='instance.waf-target-cleared' AND json_extract(e.payload_json,'$.parent_plan_digest')=?2 LIMIT 1", params: [operation, canonicalDigest(plan)] }]);
  if (done.length) return;
  const current = await state(client), meta = await readPublicAccessOwner(input, local);
  if (meta.principal_id !== plan.before.owner.principal_id || meta.preferred_api_origin !== plan.before.routing.workers_dev_origin || current.marker.preferred_api_origin !== meta.preferred_api_origin || current.marker.origin_version !== meta.origin_version || current.marker.locked_operation_id || snapshotJson(current.binding, BINDING_FIELDS) !== snapshotJson(registered, BINDING_FIELDS) || current.ownership.rule_id !== null || current.ownership.binding_id !== registered.binding_id) fail("WAF_TARGET_ROLLBACK_DRIFT", "Only the original registered target with a verified disabled rule can be cleared after this exact origin rollback");
  const gate = "EXISTS(SELECT 1 FROM cloudflare_control_settings WHERE singleton=1 AND last_operation_id=?1)", eventId = operation, now = Date.now();
  const statements = [
    { sql: `UPDATE cloudflare_control_settings SET version=version+1,zone_id=NULL,last_operation_id=?1,capabilities_json='{}',verified_at=NULL WHERE singleton=1 AND version=?2 AND locked_operation_id IS NULL AND EXISTS(SELECT 1 FROM instance_meta m JOIN instance_origin_settings s ON s.singleton=m.singleton JOIN credentials c ON c.principal_id=m.owner_principal_id WHERE m.singleton=1 AND m.instance_id=?3 AND m.owner_principal_id=?4 AND s.preferred_api_origin=?5 AND s.version=?6 AND c.id=?7 AND c.token_digest=?8 AND c.revoked_at IS NULL) AND COALESCE((SELECT ${rowJson(BINDING_FIELDS)} FROM cloudflare_waf_target_binding WHERE singleton=1),'null')=?9 AND COALESCE((SELECT ${rowJson(OWNERSHIP_FIELDS)} FROM cloudflare_waf_ownership WHERE singleton=1),'null')=?10`, params: [operation, current.marker.control_version, plan.instance_id, meta.principal_id, meta.preferred_api_origin, meta.origin_version, credential.metadata.credential_id, credential.metadata.token_digest, snapshotJson(current.binding, BINDING_FIELDS), snapshotJson(current.ownership, OWNERSHIP_FIELDS)] },
    { sql: `DELETE FROM cloudflare_waf_target_binding WHERE singleton=1 AND ${gate}`, params: [operation] },
    { sql: `UPDATE cloudflare_waf_ownership SET binding_id=NULL,rule_id=NULL,ruleset_id=NULL,rule_ref=NULL,rule_digest=NULL,operation_id=?1,verified_at=?2 WHERE singleton=1 AND ${gate}`, params: [operation, now] },
    { sql: `INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,actor_credential_id,authorized_via,subject_type,subject_id,payload_json,created_at) SELECT ?2,'security','instance.waf-target-cleared',?1,0,?3,?4,'deployment_owner','instance',?5,?6,?7 WHERE ${gate}`, params: [operation, eventId, meta.principal_id, credential.metadata.credential_id, plan.instance_id, JSON.stringify({ parent_plan_digest: canonicalDigest(plan), binding_id: registered.binding_id }), now] },
    { sql: "INSERT INTO operation_commits(operation_id,primary_subject_type,primary_subject_id,last_event_sequence,committed_at) VALUES(?1,'instance',?2,(SELECT CASE WHEN COUNT(*)=1 THEN MAX(sequence) END FROM events WHERE operation_id=?1 AND type='instance.waf-target-cleared'),?3)", params: [operation, plan.instance_id, now] },
  ];
  try { await queryWafTarget(client, statements); }
  catch (error) {
    const [committed] = await queryWafTarget(client, [{ sql: "SELECT operation_id FROM operation_commits WHERE operation_id=?1 LIMIT 1", params: [operation] }]);
    if (!committed.length) throw error;
  }
  const after = await state(client);
  if (after.binding || after.ownership.binding_id !== null || after.ownership.rule_id !== null) fail("WAF_TARGET_ROLLBACK_DRIFT", "The cleared target was not verified; preserve the original rollback operation");
}
