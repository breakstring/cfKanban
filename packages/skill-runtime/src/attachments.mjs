import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import { toolError } from "./errors.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths, loadCurrentCredentialSecret, validatePrivatePath } from "./state.mjs";
import { apiRequest, clientError, normalizeNetworkFailure, normalizeResponse } from "./transport.mjs";
import { assertNoSymlinkPath, readJson, requireHttpsOrigin, requireString, requireUuid } from "./utils.mjs";

const MAX_BYTES = 10 * 1024 * 1024;
const RESERVATION_RETRY_TTL_MS = 24 * 60 * 60 * 1000;
const MIME_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".txt", "text/plain"],
  [".log", "text/plain"], [".md", "text/markdown"], [".json", "application/json"],
  [".pdf", "application/pdf"], [".zip", "application/zip"], [".csv", "text/csv"],
]);

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function timedFetch(fetchImpl) {
  return (url, options) => fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(60_000) });
}
function within(root, target) {
  const relative = path.relative(path.resolve(root), target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function validateFilePath(value, stateRoot) {
  requireString(value, "file_path");
  if (!path.isAbsolute(value)) throw toolError("ATTACHMENT_PATH_INVALID", "Attachment paths must be absolute");
  const target = path.resolve(value);
  if (within(stateRoot, target) || within(resolveStateRoot(), target)
    || target.split(path.sep).some((part) => part.toLowerCase() === ".cfkanban")) {
    throw toolError("ATTACHMENT_STATE_PATH_REJECTED", "cfKanban private state cannot be an attachment source or destination");
  }
  await assertNoSymlinkPath(target, path.parse(target).root);
  return target;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function loadUploadFile(filePath, stateRoot) {
  const target = await validateFilePath(filePath, stateRoot);
  const before = await lstat(target);
  if (!before.isFile() || before.nlink !== 1) throw toolError("ATTACHMENT_FILE_INVALID", "Upload requires one ordinary file without symbolic or hard links");
  if (before.size < 1 || before.size > MAX_BYTES) throw toolError("ATTACHMENT_SIZE_INVALID", "Attachment must contain between 1 byte and 10 MiB");
  const filename = path.basename(target);
  if (filename.length > 180 || /[\\/\p{Cc}]/u.test(filename) || !filename.trim()) {
    throw toolError("ATTACHMENT_FILENAME_INVALID", "Attachment filename is invalid");
  }
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await file.stat())) throw toolError("ATTACHMENT_FILE_CHANGED", "Upload file changed while it was opened");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    await assertNoSymlinkPath(target, path.parse(target).root);
    if (length !== before.size || !sameFile(before, await file.stat()) || !sameFile(before, await lstat(target))) {
      throw toolError("ATTACHMENT_FILE_CHANGED", "Upload file changed while it was read");
    }
    const content = bytes.subarray(0, length);
    return { bytes: content, filename, content_type: MIME_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream", size_bytes: length, sha256: digest(content) };
  } finally { await file.close(); }
}

function metadata(value, attachmentId = null) {
  if (!value || typeof value !== "object" || !value.issue || typeof value.issue.identifier !== "string"
    || !/^CFK-[1-9]\d*$/.test(value.issue.identifier) || typeof value.filename !== "string"
    || value.filename.length < 1 || value.filename.length > 180 || /[\\/\p{Cc}]/u.test(value.filename)
    || typeof value.content_type !== "string" || value.content_type.length > 128
    || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_BYTES
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !["pending", "ready", "expired"].includes(value.state) || !Number.isSafeInteger(value.version)) {
    throw toolError("ATTACHMENT_RESPONSE_INVALID", "Attachment metadata could not be verified");
  }
  const id = requireUuid(value.id, "attachment_id");
  if (attachmentId !== null && id !== attachmentId) throw toolError("ATTACHMENT_RESPONSE_INVALID", "Attachment identity did not match the request");
  return {
    id, identifier: value.issue.identifier, filename: value.filename, content_type: value.content_type,
    size_bytes: value.size_bytes, sha256: value.sha256, state: value.state, version: value.version,
    deleted: value.deleted_at !== null && value.deleted_at !== undefined,
  };
}

async function binaryRequest({ stateRoot, instanceId, attachmentId, method, bytes, idempotencyKey, fetchImpl }) {
  const { token } = await loadCurrentCredentialSecret({ stateRoot, instanceId });
  const instance = await readJson(getInstancePaths({ stateRoot, instanceId }).instanceMetadata);
  const origin = requireHttpsOrigin(instance.trusted_api_origin);
  const headers = new Headers({ authorization: `Bearer ${token}`, accept: method === "PUT" ? "application/json" : "application/octet-stream" });
  if (method === "PUT") {
    headers.set("content-type", "application/octet-stream");
    headers.set("idempotency-key", idempotencyKey);
  }
  let response;
  try {
    response = await fetchImpl(new URL(`/api/v1/attachments/${attachmentId}/content`, origin), {
      method, headers, ...(bytes === undefined ? {} : { body: bytes }), redirect: "manual", signal: AbortSignal.timeout(60_000),
    });
  } catch { return { result: normalizeNetworkFailure() }; }
  if (response.status >= 300 && response.status < 400) {
    return { result: clientError({ code: "CROSS_ORIGIN_REDIRECT_REJECTED", category: "platform_failure", source: "client_transport", retryable: false, recovery: "verify_trusted_origin", response, status: 503 }) };
  }
  if (method === "PUT" || !response.ok) {
    try { return { result: await normalizeResponse(response) }; } catch { return { result: normalizeNetworkFailure() }; }
  }
  return { response };
}

export async function uploadAttachment({ stateRoot = resolveStateRoot(), instanceId, identifier, filePath, idempotencyKey, attachmentId = null, firstAttemptAt = null, fetchImpl = globalThis.fetch }) {
  requireUuid(instanceId, "instance_id");
  if (typeof identifier !== "string" || !/^CFK-[1-9]\d*$/.test(identifier)) throw toolError("INVALID_INPUT", "identifier must be a stable CFK Issue identifier");
  requireString(idempotencyKey, "idempotency_key", { max: 128 });
  if (attachmentId !== null) attachmentId = requireUuid(attachmentId, "attachment_id");
  const now = Date.now();
  if (firstAttemptAt === null) firstAttemptAt = now;
  if (!Number.isSafeInteger(firstAttemptAt) || firstAttemptAt < 0 || firstAttemptAt > now) {
    throw toolError("ATTACHMENT_RETRY_TIME_INVALID", "firstAttemptAt must be the original attempt time in Unix milliseconds and cannot be in the future");
  }
  const keys = { reserve: `attachment-reserve-${digest(`${idempotencyKey}\0reserve`)}`, content: `attachment-content-${digest(`${idempotencyKey}\0content`)}` };
  const resume = { instanceId, identifier, filePath, idempotencyKey, firstAttemptAt, ...(attachmentId === null ? {} : { attachmentId }) };
  const requireReservationRetryWindow = () => {
    if (Date.now() - firstAttemptAt >= RESERVATION_RETRY_TTL_MS) {
      throw toolError("ATTACHMENT_RETRY_WINDOW_EXPIRED", "The reservation retry window has expired; locate the existing attachment before continuing", { resume, idempotency_keys: keys });
    }
  };
  if (attachmentId === null) requireReservationRetryWindow();
  const file = await loadUploadFile(filePath, stateRoot);
  resume.filePath = path.resolve(filePath);
  const options = { stateRoot, instanceId, fetchImpl: timedFetch(fetchImpl) };
  const fail = (stage, operation) => ({ ok: false, stage, attachment_id: attachmentId, idempotency_keys: keys, resume, operation });
  const checkedMetadata = (value, expectedId = null) => {
    try { return metadata(value, expectedId); }
    catch { throw toolError("ATTACHMENT_RESPONSE_INVALID", "Attachment response could not be verified; preserve the same operation key", { resume, idempotency_keys: keys }); }
  };
  let resource;
  if (attachmentId === null) {
    requireReservationRetryWindow();
    const { bytes: _, ...body } = file;
    const reservation = await apiRequest({ ...options, method: "POST", apiPath: `/api/v1/issues/${identifier}/attachments`, body, idempotencyKey: keys.reserve });
    if (!reservation.ok) return fail("reserve", reservation);
    resource = checkedMetadata(reservation.data?.resource);
    attachmentId = resource.id;
    resume.attachmentId = attachmentId;
  } else {
    const current = await apiRequest({ ...options, apiPath: `/api/v1/attachments/${attachmentId}` });
    if (!current.ok) return fail("readback", current);
    resource = checkedMetadata(current.data, attachmentId);
  }
  const matches = (item) => item.identifier === identifier && item.filename === file.filename
    && item.content_type === file.content_type && item.size_bytes === file.size_bytes && item.sha256 === file.sha256;
  if (!matches(resource) || resource.deleted || resource.state === "expired") {
    throw toolError("ATTACHMENT_RESUME_CONFLICT", "The attachment reservation does not match this file or is no longer uploadable", { resume, idempotency_keys: keys });
  }
  let upload = null;
  if (resource.state !== "ready") {
    ({ result: upload } = await binaryRequest({ ...options, attachmentId, method: "PUT", bytes: file.bytes, idempotencyKey: keys.content }));
  }
  const readback = await apiRequest({ ...options, apiPath: `/api/v1/attachments/${attachmentId}` });
  if (!readback.ok) return fail("readback", readback);
  const final = checkedMetadata(readback.data, attachmentId);
  if (!matches(final) || final.deleted) throw toolError("ATTACHMENT_READBACK_CONFLICT", "Uploaded attachment readback does not match the selected file", { resume, idempotency_keys: keys });
  if (final.state !== "ready") return fail("upload", upload?.ok === false ? upload : { ok: false, error: { code: "ATTACHMENT_NOT_READY", recovery: "resume_same_upload" } });
  return { ok: true, stage: "ready", attachment_id: attachmentId, attachment: final, idempotency_keys: keys, resume, recovered: upload?.ok === false };
}

export async function downloadAttachment({ stateRoot = resolveStateRoot(), instanceId, attachmentId, outputPath, fetchImpl = globalThis.fetch }) {
  requireUuid(instanceId, "instance_id");
  attachmentId = requireUuid(attachmentId, "attachment_id");
  const target = await validateFilePath(outputPath, stateRoot);
  const directory = path.dirname(target);
  const parent = await lstat(directory);
  if (!parent.isDirectory()) throw toolError("ATTACHMENT_PATH_INVALID", "Download destination parent must exist and be a directory");
  try { await lstat(target); throw toolError("ATTACHMENT_OUTPUT_EXISTS", "Download refuses to overwrite an existing destination"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const options = { stateRoot, instanceId, fetchImpl: timedFetch(fetchImpl) };
  const readback = await apiRequest({ ...options, apiPath: `/api/v1/attachments/${attachmentId}` });
  if (!readback.ok) return { ok: false, stage: "metadata", operation: readback };
  const resource = metadata(readback.data, attachmentId);
  if (resource.state !== "ready" || resource.deleted) throw toolError("ATTACHMENT_NOT_READY", "Only an active ready attachment can be downloaded");
  const { response, result } = await binaryRequest({ ...options, attachmentId, method: "GET" });
  if (result) return { ok: false, stage: "download", operation: result };
  const temporary = path.join(directory, `.cfkanban-download-${randomUUID()}.tmp`);
  let file;
  try {
    await assertNoSymlinkPath(directory, path.parse(directory).root);
    file = await open(temporary, "wx", 0o600);
    await validatePrivatePath(temporary, "file");
    const hash = createHash("sha256");
    let length = 0;
    const reader = response.body?.getReader();
    if (!reader) throw toolError("ATTACHMENT_CONTENT_INVALID", "Attachment response has no content");
    try {
      while (true) {
        let chunk;
        try { chunk = await reader.read(); } catch { return { ok: false, stage: "download", operation: normalizeNetworkFailure() }; }
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > resource.size_bytes || length > MAX_BYTES) throw toolError("ATTACHMENT_CONTENT_INVALID", "Attachment content exceeds its verified size");
        hash.update(chunk.value);
        await file.writeFile(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (length !== resource.size_bytes || hash.digest("hex") !== resource.sha256) throw toolError("ATTACHMENT_CONTENT_INVALID", "Attachment size or SHA-256 did not match its metadata");
    await file.sync();
    await file.close();
    file = null;
    await assertNoSymlinkPath(target, path.parse(target).root);
    const currentParent = await lstat(directory);
    if (parent.dev !== currentParent.dev || parent.ino !== currentParent.ino) throw toolError("ATTACHMENT_PATH_CHANGED", "Download destination directory changed");
    // A hard link publishes the verified file atomically and fails if the destination appeared meanwhile.
    try { await link(temporary, target); }
    catch (error) { if (error.code === "EEXIST") throw toolError("ATTACHMENT_OUTPUT_EXISTS", "Download refuses to overwrite an existing destination"); throw error; }
    return { ok: true, stage: "saved", output_path: target, attachment: resource };
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
