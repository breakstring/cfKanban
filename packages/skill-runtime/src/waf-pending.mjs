import path from "node:path";
import { lstat, rm } from "node:fs/promises";
import { toolError } from "./errors.mjs";
import { getInstancePaths, validatePrivatePath } from "./state.mjs";
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, pathType, readJson, requireUuid } from "./utils.mjs";

async function pendingPath(input) {
  const paths = getInstancePaths(input), file = path.join(paths.instanceRoot, "waf-pending.json");
  await validatePrivatePath(paths.stateRoot, "directory"); await assertNoSymlinkPath(file, paths.stateRoot); await validatePrivatePath(paths.instanceRoot, "directory");
  return file;
}
export async function readPendingWaf(input) {
  const file = await pendingPath(input);
  if (await pathType(file) === "missing") return null;
  await validatePrivatePath(file, "file");
  if ((await lstat(file)).size > 4096) throw toolError("WAF_PENDING_STATE_INVALID", "The retained WAF dispatch state exceeds its fixed bound");
  const value = await readJson(file), keys = ["schema_version", "kind", "instance_id", "operation_id", "plan_digest"];
  if (!value || Array.isArray(value) || value.schema_version !== 1 || value.kind !== "cfkanban_waf_pending" || value.instance_id !== input.instanceId || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value)) || !/^[a-f0-9]{64}$/u.test(value.plan_digest)) throw toolError("WAF_PENDING_STATE_INVALID", "The original WAF dispatch state must be inspected before another mutation");
  requireUuid(value.operation_id, "pending_operation_id"); requireUuid(value.instance_id, "pending_instance_id");
  return value;
}
export async function assertNoPendingWaf(input, original = null) {
  const pending = await readPendingWaf(input);
  if (pending && (pending.operation_id !== original?.operation_id || pending.plan_digest !== original?.plan_digest)) throw toolError("WAF_PENDING_OPERATION_REQUIRED", "Resolve the original retained WAF dispatch before another WAF, target or public-origin mutation", { instance_id: pending.instance_id, operation_id: pending.operation_id });
  return pending;
}
export async function retainPendingWaf(input, plan) {
  const original = { operation_id: requireUuid(plan.operation_id, "operation_id"), plan_digest: canonicalDigest(plan) };
  if (await assertNoPendingWaf(input, original)) return;
  await atomicWriteJson(await pendingPath(input), { schema_version: 1, kind: "cfkanban_waf_pending", instance_id: requireUuid(input.instanceId, "instance_id"), ...original });
}
export async function releasePendingWaf(input, plan) {
  const pending = await assertNoPendingWaf(input, { operation_id: plan.operation_id, plan_digest: canonicalDigest(plan) });
  if (pending) await rm(await pendingPath(input));
}
