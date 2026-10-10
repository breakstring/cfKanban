import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import { toolError } from "./errors.mjs";
import { canonicalDigest, requireString } from "./utils.mjs";

// 与既有附件清理共用小时触发器，避免同一维护时刻重复调用 Worker。
export const MAINTENANCE_CRON = "17 * * * *";

export function workerCrons(schemaVersion, attachments) {
  return schemaVersion >= 29 || attachments ? [MAINTENANCE_CRON] : [];
}

export function maintenanceSchedule(plan) {
  const targetSchema = plan.kind === "strict_zero_deploy" ? plan.release?.schema_version : plan.target?.schema_version;
  if (!(targetSchema >= 29)) return undefined;
  const previous = plan.kind === "strict_zero_deploy" ? []
    : workerCrons(plan.current?.schema_version, Boolean(plan.resources?.r2 && !plan.resources.r2.create));
  const crons = workerCrons(targetSchema, Boolean(plan.resources?.r2));
  return { previous_crons: previous, crons, schedule_delta: canonicalDigest(previous) !== canonicalDigest(crons),
    trend_backfill: { max_jobs_per_tick: 8, max_events_per_job: 100, empty_queue_reads_per_tick: 1,
      shared_subrequest_budget: 50, stop_starting_batches_after_ms: 5000, attachment_batch_max: 8 } };
}

export function assertMaintenanceDeploymentEvidence(journal, plan) {
  if (!plan.maintenance) return;
  const events = journal.events;
  const deploymentIndex = events.findLastIndex(event => ["command_started", "command_finished"].includes(event.type) && event.action === "deploy_worker_and_static_assets");
  const readbackIndex = events.findLastIndex(event => event.type === "command_finished" && event.action === "worker_deployment_readback");
  const readback = events[readbackIndex];
  if (deploymentIndex < 0 || readbackIndex <= deploymentIndex || readback?.exit_code !== 0
    || canonicalDigest(readback.worker_deployment_readback?.maintenance_configuration ?? null)
      !== canonicalDigest({ crons: plan.maintenance.crons, verified: true })) {
    throw toolError("MAINTENANCE_READBACK_REQUIRED", "Owner bootstrap requires maintenance evidence from after the latest deployment");
  }
}

export function assertMaintenanceSchedule(plan) {
  const expected = maintenanceSchedule(plan);
  if (expected !== undefined && canonicalDigest(plan.maintenance ?? null) !== canonicalDigest(expected)) {
    throw toolError("MAINTENANCE_PLAN_REQUIRED", "Schema 29 requires the exact bounded maintenance schedule in the authorized deployment plan");
  }
}

export async function verifyPlannedMaintenanceSchedule(input) {
  const { plan, phase } = input;
  assertMaintenanceSchedule(plan);
  if (!plan.maintenance) return undefined;
  if (!["before", "after"].includes(phase)) throw toolError("MAINTENANCE_PLAN_REQUIRED", "Maintenance verification requires an exact phase");
  const name = requireString(plan.resources?.worker?.name, "worker_name", { max: 63 });
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw toolError("INVALID_RESOURCE_NAME", "Worker name is invalid");
  const client = await createCloudflareControlClient({ ...input, accountId: plan.target.cloudflare_account_id,
    cloudflareProfile: plan.target.cloudflare_profile, contextDirectory: plan.target.cloudflare_auth_context_directory },
  `/workers/scripts/${name}/schedules`, { errorPrefix: "MAINTENANCE", resourceLabel: "Worker schedules" });
  const result = await client("");
  const expected = phase === "before" ? plan.maintenance.previous_crons : plan.maintenance.crons;
  if (!Array.isArray(result?.schedules) || result.schedules.some(item => typeof item?.cron !== "string")
    || canonicalDigest(result.schedules.map(item => item.cron).sort()) !== canonicalDigest([...expected].sort())) {
    throw toolError("MAINTENANCE_SCHEDULE_DRIFT", "Worker Cron triggers differ from the frozen maintenance schedule");
  }
  return { crons: expected, verified: true };
}
