import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import { normalizeObservedWorkerLimits, plannedWorkerLimits } from "./cost-protection-config.mjs";
import { toolError } from "./errors.mjs";
import { canonicalDigest, requireString } from "./utils.mjs";
import { normalizeObservedWorkerObservability, normalizePlannedWorkerObservability } from "./worker-observability.mjs";

export async function readWorkerCostSettings(input) {
  const workerName = requireString(input.workerName, "worker_name", { max: 63 });
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(workerName)) throw toolError("INVALID_WORKER_NAME", "An exact Worker name is required");
  const control = await createCloudflareControlClient(input, `/workers/services/${workerName}/environments/production`, { errorPrefix: "WORKER_COST", resourceLabel: "Worker cost settings" });
  const result = await control("");
  if (!result?.script || typeof result.script !== "object") throw toolError("WORKER_COST_READBACK_INVALID", "Worker environment metadata is incomplete");
  const normalized = normalizeObservedWorkerLimits(result.script.limits);
  return { account_id: input.accountId, worker_name: workerName, worker_limits: normalized, observability: normalizeObservedWorkerObservability(result.script.observability), subscription_readback: "not_performed", secret_values_exposed: false };
}
export async function verifyPlannedWorkerCostSettings(input) {
  const { plan, phase } = input;
  if (!plan.cost_protection || plan.kind !== "deployed_instance_upgrade") return null;
  const observed = await readWorkerCostSettings({ ...input, workerName: plan.resources.worker.name, accountId: plan.target.cloudflare_account_id, cloudflareProfile: plan.target.cloudflare_profile, contextDirectory: plan.target.cloudflare_auth_context_directory });
  const expected = plannedWorkerLimits(plan, phase);
  if (JSON.stringify(observed.worker_limits) !== JSON.stringify(expected)) throw toolError("WORKER_CPU_LIMIT_DRIFT", "The deployed Worker limits differ from the frozen plan; capture the current limits before planning their preservation or an explicit CPU change");
  const observability = normalizePlannedWorkerObservability(plan);
  if (observability !== undefined && canonicalDigest(observed.observability) !== canonicalDigest(observability)) throw toolError("WORKER_OBSERVABILITY_DRIFT", "Worker Observability differs from the frozen upgrade plan; capture the current settings before planning their preservation");
  return observed;
}
