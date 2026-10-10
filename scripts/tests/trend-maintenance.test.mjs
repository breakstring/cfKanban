import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrictZeroPlan } from "../../packages/skill-runtime/src/plan.mjs";
import { deploymentCrons } from "../../packages/skill-runtime/src/usage-config.mjs";
import { assertMaintenanceDeploymentEvidence, maintenanceSchedule, verifyPlannedMaintenanceSchedule } from "../../packages/skill-runtime/src/maintenance-schedule.mjs";
import { executeWranglerAction } from "../../packages/skill-runtime/src/deploy.mjs";
import { appendJournalEvent, authorizeJournal, createJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { canonicalDigest } from "../../packages/skill-runtime/src/utils.mjs";

function strict(schema) {
  return createStrictZeroPlan({ taskId: "isolated-maintenance", accountId: "test-account", cloudflareProfile: "isolated",
    ownerDisplayName: "MaintenanceOwner", release: { manifest_version: "1.12.0-rc.7", manifest_sha256: "a".repeat(64),
      service_bundle_version: "1.12.0-rc.7", service_bundle_sha256: "b".repeat(64), schema_version: schema } }).plan;
}
function upgrade(currentSchema, targetSchema, attachments = false) {
  const plan = { kind: "deployed_instance_upgrade", current: { schema_version: currentSchema },
    target: { schema_version: targetSchema, cloudflare_account_id: "test-account", cloudflare_profile: "isolated" },
    resources: { worker: { name: "isolated-worker" }, r2: attachments ? { create: false } : false } };
  const schedule = maintenanceSchedule(plan);
  if (schedule) plan.maintenance = schedule;
  return plan;
}
test("new core plans freeze a bounded maintenance task independent of R2; old schemas retain behavior", () => {
  const plan = strict(29);
  assert.deepEqual(deploymentCrons(plan), ["17 * * * *"]);
  assert.deepEqual(plan.maintenance, { previous_crons: [], crons: ["17 * * * *"], schedule_delta: true,
    trend_backfill: { max_jobs_per_tick: 8, max_events_per_job: 100, empty_queue_reads_per_tick: 1,
      shared_subrequest_budget: 50, stop_starting_batches_after_ms: 5000, attachment_batch_max: 8 } });
  assert.equal(plan.resources.r2, false);
  assert.ok(plan.steps.includes("read_worker_deployment_and_maintenance_schedule"));
  assert.deepEqual(deploymentCrons(strict(28)), []);
  assert.equal(strict(28).maintenance, undefined);
});
test("schema upgrades reuse attachment Cron and preserve new core Cron without duplicating schedules", () => {
  assert.deepEqual(upgrade(28, 29).maintenance.previous_crons, []);
  assert.equal(upgrade(28, 29).maintenance.schedule_delta, true);
  assert.deepEqual(upgrade(28, 29, true).maintenance.previous_crons, ["17 * * * *"]);
  assert.equal(upgrade(28, 29, true).maintenance.schedule_delta, false);
  assert.equal(upgrade(29, 29).maintenance.schedule_delta, false);
  for (const value of [upgrade(28, 29), upgrade(28, 29, true), upgrade(29, 29)]) {
    assert.deepEqual(deploymentCrons(value), ["17 * * * *"]);
  }
  const missing = upgrade(28, 29); delete missing.maintenance;
  assert.throws(() => deploymentCrons(missing), { code: "MAINTENANCE_PLAN_REQUIRED" });
  const drift = upgrade(28, 29); drift.maintenance.trend_backfill.max_jobs_per_tick = 100;
  assert.throws(() => deploymentCrons(drift), { code: "MAINTENANCE_PLAN_REQUIRED" });
});
test("schedule preflight and readback refuse missing, additional, or duplicate remote triggers", async () => {
  const plan = upgrade(28, 29), seen = [];
  const inspect = (phase, crons) => verifyPlannedMaintenanceSchedule({ plan, phase, wranglerExecutable: "/mock/wrangler",
    environment: {}, tokenRunner: async () => ({ stdout: JSON.stringify({ type: "oauth", token: "isolated-only" }) }),
    fetchImpl: async (url, options) => { seen.push([url, options.method]); return Response.json({ success: true,
      result: { schedules: crons.map(cron => ({ cron })) } }); } });
  assert.deepEqual(await inspect("before", []), { crons: [], verified: true });
  assert.deepEqual(await inspect("after", ["17 * * * *"]), { crons: ["17 * * * *"], verified: true });
  for (const [phase, crons] of [["before", ["* * * * *"]], ["after", []], ["after", ["17 * * * *", "17 * * * *"]]]) {
    await assert.rejects(inspect(phase, crons), { code: "MAINTENANCE_SCHEDULE_DRIFT" });
  }
  assert.ok(seen.every(([url, method]) => url === "https://api.cloudflare.com/client/v4/accounts/test-account/workers/scripts/isolated-worker/schedules" && method === "GET"));
});

test("initial deployment cannot use maintenance evidence from before a newer deployment or uncertain attempt", () => {
  const plan = strict(29);
  const deploy = { type: "command_finished", action: "deploy_worker_and_static_assets", exit_code: 0 };
  const proof = { type: "command_finished", action: "worker_deployment_readback", exit_code: 0,
    worker_deployment_readback: { maintenance_configuration: { crons: ["17 * * * *"], verified: true } } };
  assert.doesNotThrow(() => assertMaintenanceDeploymentEvidence({ events: [deploy, proof] }, plan));
  for (const events of [[deploy], [proof, deploy], [deploy, proof, deploy],
    [deploy, proof, { type: "command_started", action: "deploy_worker_and_static_assets" }]]) {
    assert.throws(() => assertMaintenanceDeploymentEvidence({ events }, plan), { code: "MAINTENANCE_READBACK_REQUIRED" });
  }
});

test("bootstrap execution rechecks maintenance after SQL preparation and before any runner or Credential access", async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), "cfkanban-maintenance-runner-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  for (const type of ["command_started", "command_finished"]) {
    const plan = strict(29), instanceId = plan.target.instance_id, operationId = plan.operation_id;
    await createJournal({ stateRoot, instanceId, operationId, plan });
    await authorizeJournal({ stateRoot, instanceId, operationId, taskId: plan.task_id, planDigest: canonicalDigest(plan) });
    for (const event of [
      { type: "command_finished", action: "deploy_worker_and_static_assets", exit_code: 0 },
      { type: "command_finished", action: "worker_deployment_readback", exit_code: 0,
        worker_deployment_readback: { maintenance_configuration: { crons: ["17 * * * *"], verified: true } } },
      { type: "owner_bootstrap_sql_written", bootstrap_sql_path: "/isolated/bootstrap.sql" },
      { type, action: "deploy_worker_and_static_assets", exit_code: 0 },
    ]) await appendJournalEvent({ stateRoot, instanceId, operationId, event });
    let calls = 0;
    await assert.rejects(executeWranglerAction({ stateRoot, instanceId, operationId, taskId: plan.task_id, plan,
      wranglerExecutable: "/isolated/wrangler", action: "bootstrap_owner", bootstrapSqlPath: "/isolated/bootstrap.sql",
      environment: {}, runner: async () => { calls++; throw new Error("runner must not execute"); } }),
    { code: "MAINTENANCE_READBACK_REQUIRED" });
    assert.equal(calls, 0);
  }
});
