import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { appendJournalEvent, assertJournalAuthorization } from "./journal.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { assertNoSymlinkPath, readJson, requireString, requireUuid } from "./utils.mjs";

const execFileAsync = promisify(execFile);
const API_ORIGIN = "https://api.cloudflare.com";
const MARKER_KEY = "cfkanban-instance.json";
export const ATTACHMENT_CLEANUP_CRON = "17 * * * *";

export function attachmentBucketName(value) {
  const name = requireString(value, "bucket_name", { max: 63 });
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(name)) throw toolError("INVALID_R2_BUCKET", "Use a 3–63 character lowercase bucket name");
  return name;
}

async function authHeaders({ wranglerExecutable, cloudflareProfile = null, contextDirectory = null, environment = process.env, tokenRunner = execFileAsync }) {
  if (cloudflareProfile && contextDirectory) throw toolError("AMBIGUOUS_WRANGLER_AUTH_CONTEXT", "Choose the frozen profile or context, not both");
  if (cloudflareProfile && !/^[A-Za-z0-9_-]{1,128}$/u.test(cloudflareProfile)) throw toolError("INVALID_WRANGLER_PROFILE", "The frozen profile name is invalid");
  if (cloudflareProfile && (environment.CLOUDFLARE_API_TOKEN || environment.CLOUDFLARE_API_KEY)) throw toolError("WRANGLER_PROFILE_SHADOWED_BY_ENV", "Environment authentication shadows the frozen profile");
  if (!cloudflareProfile && environment.CLOUDFLARE_API_TOKEN) return { Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}` };
  if (!cloudflareProfile && environment.CLOUDFLARE_API_KEY && environment.CLOUDFLARE_EMAIL) return { "X-Auth-Key": environment.CLOUDFLARE_API_KEY, "X-Auth-Email": environment.CLOUDFLARE_EMAIL };
  if (environment.CLOUDFLARE_API_KEY || environment.CLOUDFLARE_EMAIL) throw toolError("R2_AUTH_UNAVAILABLE", "Cloudflare environment authentication is incomplete");
  if (!cloudflareProfile && !contextDirectory) throw toolError("R2_AUTH_CONTEXT_REQUIRED", "Use the frozen profile or private authentication context directory");
  if (!path.isAbsolute(wranglerExecutable ?? "")) throw toolError("ABSOLUTE_PATH_REQUIRED", "Wrangler must be an absolute executable path");
  if (contextDirectory && !path.isAbsolute(contextDirectory)) throw toolError("ABSOLUTE_PATH_REQUIRED", "Cloudflare context must be an absolute path");
  const args = ["auth", "token", "--json", ...(cloudflareProfile ? ["--profile", cloudflareProfile] : []), ...(contextDirectory ? ["--cwd", contextDirectory] : [])];
  try {
    const result = await tokenRunner(wranglerExecutable, args, { env: { ...environment, WRANGLER_WRITE_LOGS: "false" }, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
    const parsed = JSON.parse(result.stdout);
    if (!["oauth", "api_token"].includes(parsed?.type) || typeof parsed.token !== "string" || !parsed.token) throw new Error();
    return { Authorization: `Bearer ${parsed.token}` };
  } catch {
    throw toolError("R2_AUTH_UNAVAILABLE", "The frozen Cloudflare authentication could not be read; no login or profile change was performed");
  }
}

async function controlClient(input, resourcePath = "/r2/buckets") {
  const account = requireString(input.accountId, "account_id", { max: 128 });
  if (!/^[A-Za-z0-9_-]+$/u.test(account)) throw toolError("INVALID_ACCOUNT_ID", "Account ID is invalid");
  const headers = await authHeaders(input);
  const base = `/client/v4/accounts/${account}${resourcePath}`;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  return async (suffix, { method = "GET", body, raw = false, allowMissing = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${base}${suffix}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { ...headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw toolError("R2_CONTROL_UNAVAILABLE", "Cloudflare R2 response is uncertain; read back before retrying", { method });
    }
    let text;
    try {
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 64 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
      text = Buffer.concat(chunks).toString("utf8");
    } catch { throw toolError("R2_CONTROL_READBACK_INVALID", "R2 readback exceeded its bound or could not be read"); }
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { throw toolError("R2_CONTROL_READBACK_INVALID", "R2 returned an invalid readback"); }
    if (allowMissing && response.status === 404 && (raw || value?.errors?.some((error) => error.code === 10006))) return null;
    if (!response.ok || (!raw && value?.success !== true)) {
      throw toolError("R2_CONTROL_FAILED", "Cloudflare R2 request failed; check subscription and the selected account's permissions", { status: response.status, codes: Array.isArray(value?.errors) ? value.errors.map((entry) => Number(entry.code)).filter(Number.isSafeInteger) : [] });
    }
    return raw ? value : value.result;
  };
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
  const client = await controlClient(input);
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
  const client = await controlClient(plannedConnection(input));
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
  if (plan.kind !== "deployed_instance_upgrade" || !Number.isSafeInteger(plan.target?.schema_version) || plan.target.schema_version < 4 || storage.instance_id !== plan.instance_id || typeof storage.create !== "boolean" || storage.storage_class !== "Standard" || storage.public_access !== false
    || plan.bindings?.attachments !== "ATTACHMENTS" || plan.bindings?.cleanup_cron !== ATTACHMENT_CLEANUP_CRON
    || plan.cost_delta !== storage.create || plan.binding_changes_allowed !== storage.create
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
  const client = await controlClient(plannedConnection(input), `/workers/scripts/${name}/schedules`);
  const result = await client("");
  const expected = phase === "before" && plan.resources.r2.create ? [] : [ATTACHMENT_CLEANUP_CRON];
  if (!Array.isArray(result?.schedules) || result.schedules.length !== expected.length || result.schedules.some((schedule, index) => schedule?.cron !== expected[index])) throw toolError("R2_CLEANUP_SCHEDULE_DRIFT", "Worker Cron triggers do not match the planned attachment cleanup schedule");
  if (phase === "after") {
    const r2Bindings = version?.bindings?.filter((binding) => binding.type === "r2_bucket" || binding.name === "ATTACHMENTS");
    if (JSON.stringify(r2Bindings) !== JSON.stringify([{ type: "r2_bucket", name: "ATTACHMENTS", bucket_name: plan.resources.r2.bucket_name }])) throw toolError("R2_BINDING_DRIFT", "Deployed Worker attachment binding does not match the plan");
  }
  return { bucket_name: plan.resources.r2.bucket_name, crons: expected, binding_verified: phase === "after" };
}
