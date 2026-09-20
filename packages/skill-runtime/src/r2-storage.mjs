import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { assertNoSymlinkPath, readJson, requireString, requireUuid } from "./utils.mjs";

const MARKER_KEY = "cfkanban-instance.json";
export const ATTACHMENT_CLEANUP_CRON = "17 * * * *";

export function attachmentBucketName(value) {
  const name = requireString(value, "bucket_name", { max: 63 });
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(name)) throw toolError("INVALID_R2_BUCKET", "Use a 3–63 character lowercase bucket name");
  return name;
}


async function inspect(client, name, instanceId = null, accountId) {
  const segment = `/${name}`;
  const bucket = await client(segment, { allowMissing: true });
  if (bucket === null) return { status: "absent", bucket_name: name };
  if (bucket.name !== name || ![undefined, "Standard"].includes(bucket.storage_class)) throw toolError("R2_STORAGE_DRIFT", "R2 bucket name or storage class does not match");
  const [managed, custom, marker] = await Promise.all([
    client(`${segment}/domains/managed`), client(`${segment}/domains/custom`),
    client(`${segment}/objects/${MARKER_KEY}`, { raw: true, allowMissing: true }),
  ]);
  if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.length !== 0) throw toolError("R2_PUBLIC_ACCESS_REJECTED", "Attachment storage must have no public development URL or custom domains");
  let safeMarker = null;
  if (marker !== null) {
    try {
      if (marker?.kind !== "cfkanban_attachment_storage" || marker.bucket_name !== name || marker.account_id !== accountId) throw new Error();
      safeMarker = { kind: marker.kind, bucket_name: name, account_id: accountId, instance_id: requireUuid(marker.instance_id, "instance_id"), operation_id: requireUuid(marker.operation_id, "operation_id") };
    } catch { throw toolError("R2_OWNERSHIP_REQUIRED", "The existing bucket marker is invalid and cannot be replaced"); }
  }
  const validMarker = safeMarker !== null;
  if (instanceId !== null && (!validMarker || marker.instance_id !== instanceId)) throw toolError("R2_OWNERSHIP_REQUIRED", "The bucket marker does not prove ownership by this Instance");
  return { status: "present", bucket_name: name, storage_class: "Standard", public_access: false, instance_id: safeMarker?.instance_id ?? null, marker: safeMarker };
}

export async function readR2Storage(input) {
  const name = attachmentBucketName(input.bucketName);
  const client = await createCloudflareControlClient(input);
  const result = await inspect(client, name, input.instanceId ? requireUuid(input.instanceId, "instance_id") : null, input.accountId);
  return { ...result, account_id: input.accountId, secret_values_exposed: false };
}

export async function provisionR2Storage(input) {
  const { plan, stateRoot = resolveStateRoot(), instanceId, operationId, taskId } = input;
  const instance = requireUuid(instanceId, "instance_id");
  if (plan?.kind !== "deployed_instance_upgrade" || plan.instance_id !== instance || plan.operation_id !== operationId || plan.task_id !== taskId || !plan.resources?.r2 || plan.bindings?.attachments !== "ATTACHMENTS") throw toolError("R2_PLAN_REQUIRED", "Attachment storage requires an exact authorized Instance upgrade plan");
  const journal = await assertJournalAuthorization({ stateRoot, instanceId, operationId, taskId, plan });
  assertAttachmentStoragePlan(plan);
  const name = attachmentBucketName(plan.resources.r2.bucket_name);
  const client = await createCloudflareControlClient(plannedConnection(input));
  const record = (event) => appendJournalEvent({ stateRoot, instanceId, operationId, event });
  if (!plan.resources.r2.create) {
    const receiptPath = requireString(input.currentReceiptPath, "current_receipt_path");
    if (!path.isAbsolute(receiptPath)) throw toolError("ABSOLUTE_PATH_REQUIRED", "The prior receipt must be an absolute private path");
    await assertNoSymlinkPath(receiptPath, stateRoot);
    const receipt = await readJson(receiptPath);
    if (!["cfkanban_deployment_receipt", "cfkanban_instance_upgrade_receipt"].includes(receipt.kind) || receipt.instance?.id !== instance || receipt.cloudflare?.account_id !== plan.target.cloudflare_account_id || receipt.cloudflare?.r2?.bucket_name !== name || receipt.cloudflare?.r2?.instance_id !== instance) throw toolError("R2_RECEIPT_REQUIRED", "Existing attachment storage needs the matching prior deployment receipt");
  }
  let observed = await inspect(client, name, null, plan.target.cloudflare_account_id);
  if (observed.status === "absent") {
    if (!plan.resources.r2.create) throw toolError("R2_STORAGE_MISSING", "The Instance's attachment bucket is missing");
    await record({ type: "r2_create_started", bucket_name: name });
    await client("", { method: "POST", body: { name, storageClass: "Standard" } });
    await record({ type: "r2_created", bucket_name: name });
    observed = await inspect(client, name, null, plan.target.cloudflare_account_id);
    if (observed.status !== "present") throw toolError("R2_CONTROL_READBACK_INVALID", "Created R2 bucket could not be read back");
  } else if (plan.resources.r2.create && !journal.events.some((event) => event.type === "r2_created" && event.bucket_name === name)) {
    throw toolError("R2_UNKNOWN_RESOURCE", "The existing bucket is not proven by this journal and cannot be adopted");
  }
  if (observed.marker !== null && observed.instance_id !== instance) throw toolError("R2_OWNERSHIP_CONFLICT", "Attachment bucket belongs to a different Instance");
  if (observed.marker !== null && plan.resources.r2.create && observed.marker.operation_id !== operationId) throw toolError("R2_OWNERSHIP_CONFLICT", "The created bucket marker belongs to a different operation");
  if (!observed.marker) {
    if (!plan.resources.r2.create) throw toolError("R2_OWNERSHIP_REQUIRED", "An existing receipt-bound bucket must retain its ownership marker; it cannot be re-created or adopted");
    await client(`/${name}/objects/${MARKER_KEY}`, { method: "PUT", raw: true, body: { kind: "cfkanban_attachment_storage", instance_id: instance, bucket_name: name, account_id: plan.target.cloudflare_account_id, operation_id: operationId } });
  }
  const verified = await inspect(client, name, instance, plan.target.cloudflare_account_id);
  await record({ type: "r2_storage_verified", bucket_name: name, instance_id: instance, public_access: false });
  return { ...verified, secret_values_exposed: false };
}

export async function verifyPlannedR2Storage(input) {
  if (!input.plan.resources?.r2) return;
  const { plan } = input;
  assertAttachmentStoragePlan(plan);
  const result = await readR2Storage({ ...plannedConnection(input), bucketName: plan.resources.r2.bucket_name, instanceId: plan.instance_id });
  if (result.status !== "present") throw toolError("R2_STORAGE_MISSING", "The planned attachment bucket is missing");
  return result;
}

function plannedConnection(input) {
  const { plan } = input;
  return { ...input, accountId: plan.target.cloudflare_account_id, cloudflareProfile: plan.target.cloudflare_profile, contextDirectory: plan.target.cloudflare_auth_context_directory };
}

export function assertAttachmentStoragePlan(plan) {
  if (!plan.resources?.r2) return;
  const storage = plan.resources.r2;
  attachmentBucketName(storage.bucket_name);
  const capacityValid = plan.target?.schema_version >= 7
    ? plan.attachment_storage?.capacity_policy === "owner_configured"
      && plan.attachment_storage?.capacity_setting === "application"
      && plan.attachment_storage?.unconfigured_blocks_uploads === true
      && plan.attachment_storage?.deployment_changes_capacity === false
      && !Object.hasOwn(plan.attachment_storage, "max_storage_bytes")
    : plan.attachment_storage?.max_storage_bytes === 1073741824;
  if (!capacityValid) throw toolError("R2_PLAN_REQUIRED", "Attachment capacity policy must match the target release; deployment cannot choose or modify an Owner application setting");
  if (plan.kind !== "deployed_instance_upgrade" || !Number.isSafeInteger(plan.target?.schema_version) || plan.target.schema_version < 4 || storage.instance_id !== plan.instance_id || typeof storage.create !== "boolean" || storage.storage_class !== "Standard" || storage.public_access !== false
    || plan.bindings?.attachments !== "ATTACHMENTS" || plan.bindings?.cleanup_cron !== ATTACHMENT_CLEANUP_CRON
    || plan.cost_delta !== storage.create || plan.binding_changes_allowed !== (storage.create || JSON.stringify(plan.usage_analytics?.configuration) !== JSON.stringify(plan.usage_analytics?.previous_configuration))
    || plan.attachment_storage?.subscription_required !== true || plan.attachment_storage?.usage_beyond_free_tier_is_billable !== true || plan.attachment_storage?.automatic_bucket_deletion !== false
    || plan.attachment_storage?.previous_bucket !== (storage.create ? null : storage.bucket_name)
    || JSON.stringify(plan.attachment_storage?.previous_cleanup_crons) !== JSON.stringify(storage.create ? [] : [ATTACHMENT_CLEANUP_CRON])
    || JSON.stringify(plan.attachment_storage?.cleanup_crons) !== JSON.stringify([ATTACHMENT_CLEANUP_CRON])) {
    throw toolError("R2_PLAN_REQUIRED", "R2 storage, ownership, cost, binding, and cleanup schedule must match the frozen plan");
  }
}

export async function verifyPlannedAttachmentWorker(input) {
  const { plan, phase, version } = input;
  assertAttachmentStoragePlan(plan);
  if (!plan.resources?.r2 || !["before", "after"].includes(phase)) throw toolError("R2_PLAN_REQUIRED", "Attachment Worker verification requires an exact phase and R2 plan");
  const name = requireString(plan.resources.worker.name, "worker_name", { max: 63 });
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw toolError("INVALID_RESOURCE_NAME", "Worker name is invalid");
  const client = await createCloudflareControlClient(plannedConnection(input), `/workers/scripts/${name}/schedules`);
  const result = await client("");
  const expected = phase === "before" && plan.resources.r2.create ? [] : [ATTACHMENT_CLEANUP_CRON];
  if (!Array.isArray(result?.schedules) || result.schedules.length !== expected.length || result.schedules.some((schedule, index) => schedule?.cron !== expected[index])) throw toolError("R2_CLEANUP_SCHEDULE_DRIFT", "Worker Cron triggers do not match the planned attachment cleanup schedule");
  if (phase === "after") {
    const r2Bindings = version?.bindings?.filter((binding) => binding.type === "r2_bucket" || binding.name === "ATTACHMENTS");
    if (JSON.stringify(r2Bindings) !== JSON.stringify([{ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: plan.resources.r2.bucket_name }])) throw toolError("R2_BINDING_DRIFT", "Deployed Worker attachment binding does not match the plan");
  }
  return { bucket_name: plan.resources.r2.bucket_name, crons: expected, binding_verified: phase === "after" };
}
