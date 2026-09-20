import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { collectAttachmentGarbage, uploadAttachment, readAttachmentBytes } from "../../apps/worker/src/services/attachments.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = createTestHarness({ root, workers: [{ configPath: "wrangler.attachments-test.jsonc" }] });
// Wrangler 开发代理在提前 413 后会使下一请求连接失败；直接分发仍运行真实 Worker、D1 和 R2。
const worker = server.getWorker();
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const writerToken = `cfk_v1_writer_${"B".repeat(43)}`;
const otherWriterToken = `cfk_v1_otherwriter_${"D".repeat(43)}`;
const readerToken = `cfk_v1_reader_${"C".repeat(43)}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ownerId = randomUUID(), credentialId = randomUUID();
let db, env, auth, workspace, project, issue, writerId, writerCredentialId;
const headers = (token = ownerToken) => ({ authorization: `Bearer ${token}` });
async function json(path, { method = "GET", body, key = randomUUID(), token = ownerToken, extraHeaders = {} } = {}) {
  const response = await worker.fetch(path, { method, headers: { ...headers(token), ...(body === undefined ? {} : { "content-type": "application/json" }), "idempotency-key": key, ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.headers.get("content-type")?.includes("application/json"), `${method} ${path} response ${response.status}: ${text}`);
  return { status: response.status, data: JSON.parse(text), response };
}
async function success(path, options) { const result = await json(path, options); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
async function makeIssue(projectId = project.id, title = "Attachment test") {
  return (await success(`/api/v1/workspaces/${workspace.id}/projects/${projectId}/issues`, { method: "POST", body: { title } })).resource;
}
async function reserve(bytes, { identifier = issue.identifier, token = ownerToken, filename = "日志.txt", key = randomUUID(), contentType = "text/plain" } = {}) {
  return json(`/api/v1/issues/${identifier}/attachments`, { method: "POST", key, token, body: { filename, content_type: contentType, size_bytes: bytes.length, sha256: hash(bytes) } });
}
async function upload(id, bytes, { token = ownerToken, key = randomUUID() } = {}) {
  const response = await worker.fetch(`/api/v1/attachments/${id}/content`, { method: "PUT", headers: { ...headers(token), "idempotency-key": key, "content-type": "application/octet-stream" }, body: bytes });
  const text = await response.text();
  assert.ok(response.headers.get("content-type")?.includes("application/json"), `upload response ${response.status}: ${text}`);
  return { status: response.status, data: JSON.parse(text) };
}
async function uploaded(bytes, options) {
  const reservation = await reserve(bytes, options); assert.equal(reservation.status, 200, JSON.stringify(reservation.data));
  const result = await upload(reservation.data.resource.id, bytes, options); assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.resource;
}
async function seed(token, role) {
  const principal = randomUUID(), credential = randomUUID(), now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO principals (id, display_name, display_name_key, created_at, updated_at) VALUES (?1, ?2, lower(?2), ?3, ?3)").bind(principal, `${role}_${principal}`, now),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)").bind(credential, principal, token.split("_")[2], hash(token), now, randomUUID()),
    db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?5,?6)").bind(randomUUID(), principal, project.id, role, now, randomUUID()),
  ]);
  return { principal, credential };
}
before(async () => {
  await server.listen();
  await worker.applyD1Migrations("DB");
  env = await worker.getEnv(); db = env.DB;
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: credentialId, ownerCredentialToken: ownerToken, ownerDisplayName: "Attachment_Owner", ownerPrincipalId: ownerId, preferredApiOrigin: "https://attachments.example.test" });
  auth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  await success("/api/v1/admin/attachment-settings", { method: "PATCH", body: { expected_version: 1, limit_bytes: 1073741824 } });
  workspace = (await success("/api/v1/workspaces", { method: "POST", body: { display_name: "Attachments" } })).resource;
  project = (await success(`/api/v1/workspaces/${workspace.id}/projects`, { method: "POST", body: { display_name: "File tests" } })).resource;
  issue = await makeIssue();
  ({ principal: writerId, credential: writerCredentialId } = await seed(writerToken, "writer"));
  await seed(readerToken, "reader"); await seed(otherWriterToken, "writer");
});
after(() => server.close());

test("reservation and upload are independently idempotent, private, and preserve Issue version", async () => {
  const bytes = Buffer.from("private diagnostic log\n"), key = randomUUID();
  const one = await reserve(bytes, { key }); assert.equal(one.status, 200, JSON.stringify(one.data));
  const two = await reserve(bytes, { key }); assert.equal(two.data.resource.id, one.data.resource.id); assert.equal(two.data.idempotent_replay, true);
  const conflict = await reserve(Buffer.from("different"), { key }); assert.equal(conflict.status, 409); assert.equal(conflict.data.code, "IDEMPOTENCY_CONFLICT");
  const id = one.data.resource.id;
  assert.equal((await worker.fetch(`/api/v1/attachments/${id}/content`, { headers: headers() })).status, 404);
  const putKey = randomUUID(), put = await upload(id, bytes, { key: putKey }); assert.equal(put.status, 200, JSON.stringify(put.data)); assert.equal(put.data.resource.state, "ready");
  assert.equal(put.data.resource.version, 2);
  const replay = await upload(id, bytes, { key: putKey }); assert.equal(replay.data.idempotent_replay, true); assert.equal(replay.data.resource.version, 2);
  const download = await worker.fetch(`/api/v1/attachments/${id}/content`, { headers: headers(readerToken) });
  assert.equal(download.status, 200); assert.equal(download.headers.get("cache-control"), "private, no-store"); assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-disposition"), /^attachment;/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await worker.fetch(`/api/v1/attachments/${id}/content`)).status, 401);
  const info = await success(`/api/v1/attachments/${id}`, { token: readerToken }); assert.equal(info.sha256, hash(bytes)); assert.ok(!("object_key" in info)); assert.deepEqual(info.allowed_actions, ["read", "download"]);
  assert.equal((await success(`/api/v1/issues/${issue.identifier}`)).version, issue.version);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE subject_id=?1 AND type='attachment.uploaded'").bind(id).first()).n, 1);
});

test("file bounds, filenames, digest and uploader authorization reject before publication", async () => {
  const bytes = Buffer.from("valid data");
  assert.equal((await reserve(bytes, { token: readerToken })).status, 403);
  assert.equal((await reserve(bytes, { filename: "../../secret.log" })).status, 400);
  assert.equal((await reserve(Buffer.alloc(0))).status, 400);
  const huge = await json(`/api/v1/issues/${issue.identifier}/attachments`, { method: "POST", body: { filename: "large", content_type: "text/plain", size_bytes: 10485761, sha256: hash(bytes) } }); assert.equal(huge.status, 400);
  const reserved = await reserve(bytes, { token: writerToken }); assert.equal(reserved.status, 200);
  const id = reserved.data.resource.id;
  assert.equal((await upload(id, bytes, { token: otherWriterToken })).status, 403);
  assert.equal((await upload(id, Buffer.alloc(bytes.length, 88), { token: writerToken })).data.code, "VALIDATION_ERROR");
  assert.equal((await upload(id, Buffer.concat([bytes, Buffer.from("!")]), { token: writerToken })).status, 413);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes.length + 1)); controller.close(); } });
  await assert.rejects(() => readAttachmentBytes(new Request("https://example.test", { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: stream, duplex: "half" }), bytes.length), (error) => error.status === 413 && error.details.limit_bytes === bytes.length);
  assert.equal((await success(`/api/v1/attachments/${id}`)).state, "pending");
  assert.equal(await env.ATTACHMENTS.head(`attachments/${id}`), null);
  assert.equal((await upload(id, bytes, { token: writerToken })).status, 200);
});

test("only signature-verified raster images allow explicit inline preview", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const file = await uploaded(png, { filename: "图.png", contentType: "image/png" });
  assert.equal(file.preview_content_type, "image/png");
  const response = await worker.fetch(`/api/v1/attachments/${file.id}/content?preview=1`, { headers: headers(readerToken) });
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png"); assert.match(response.headers.get("content-disposition"), /^inline;/);
  const svg = await uploaded(Buffer.from('<svg onload="alert(1)"></svg>'), { filename: "fake.png", contentType: "image/png" });
  assert.equal(svg.preview_content_type, null); assert.equal((await worker.fetch(`/api/v1/attachments/${svg.id}/content?preview=1`, { headers: headers() })).status, 400);
});

test("attachment CAS deletion retains budget, restores only ready files and enforces capacity", async () => {
  const file = await uploaded(Buffer.from("recoverable"));
  const beforeBytes = (await db.prepare("SELECT reserved_bytes FROM attachment_storage").first()).reserved_bytes;
  assert.equal((await json(`/api/v1/attachments/${file.id}?expected_version=1`, { method: "DELETE" })).status, 409);
  const removed = await success(`/api/v1/attachments/${file.id}?expected_version=${file.version}`, { method: "DELETE" });
  assert.equal((await db.prepare("SELECT reserved_bytes FROM attachment_storage").first()).reserved_bytes, beforeBytes);
  assert.equal((await worker.fetch(`/api/v1/attachments/${file.id}/content`, { headers: headers() })).status, 404);
  assert.equal((await json(`/api/v1/attachments/${file.id}`, { token: readerToken })).status, 404);
  assert.ok((await success(`/api/v1/issues/${issue.identifier}/attachments?deleted=only`)).items.some((entry) => entry.id === file.id));
  const restored = await success(`/api/v1/attachments/${file.id}/commands/restore`, { method: "POST", body: { expected_version: removed.resource.version } }); assert.equal(restored.resource.deleted_at, null);
  const pending = (await reserve(Buffer.from("cancel"))).data.resource;
  const canceled = await success(`/api/v1/attachments/${pending.id}?expected_version=1`, { method: "DELETE" }); assert.equal(canceled.resource.state, "expired");
  assert.equal((await json(`/api/v1/attachments/${pending.id}/commands/restore`, { method: "POST", body: { expected_version: 2 } })).status, 409);
  const limited = await makeIssue();
  const results = await Promise.all(Array.from({ length: 22 }, (_, index) => reserve(Buffer.from(String(index)), { identifier: limited.identifier })));
  assert.equal(results.filter((entry) => entry.status === 200).length, 20);
  assert.equal(results.filter((entry) => entry.data.code === "ISSUE_ATTACHMENT_LIMIT_REACHED").length, 2);
  const retained = results.find((entry) => entry.status === 200).data.resource;
  await upload(retained.id, Buffer.from(String(results.indexOf(results.find((entry) => entry.status === 200)))));
  const current = await success(`/api/v1/attachments/${retained.id}`);
  const deleted = await success(`/api/v1/attachments/${retained.id}?expected_version=${current.version}`, { method: "DELETE" });
  assert.equal((await reserve(Buffer.from("replacement"), { identifier: limited.identifier })).status, 200);
  assert.equal((await json(`/api/v1/attachments/${retained.id}/commands/restore`, { method: "POST", body: { expected_version: deleted.resource.version } })).data.code, "ISSUE_ATTACHMENT_LIMIT_REACHED");
});

test("global byte reservation is atomic across concurrent uploads", async () => {
  const target = await makeIssue(), old = (await db.prepare("SELECT reserved_bytes FROM attachment_storage").first()).reserved_bytes;
  await db.prepare("UPDATE attachment_storage SET reserved_bytes=?1").bind(1073741824 - 4).run();
  try {
    const results = await Promise.all([reserve(Buffer.from("1234"), { identifier: target.identifier }), reserve(Buffer.from("5678"), { identifier: target.identifier })]);
    assert.equal(results.filter((entry) => entry.status === 200).length, 1); assert.equal(results.filter((entry) => entry.data.code === "ATTACHMENT_STORAGE_LIMIT_REACHED").length, 1);
  } finally { await db.prepare("UPDATE attachment_storage SET reserved_bytes=?1").bind(old + 4).run(); }
});

function proxyBucket(overrides) { return new Proxy(env.ATTACHMENTS, { get(target, property) { if (property in overrides) return overrides[property]; const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value; } }); }
function putRequest(id, bytes, key) { return new Request(`https://attachments.example.test/api/v1/attachments/${id}/content`, { method: "PUT", headers: { ...headers(), "content-type": "application/octet-stream", "idempotency-key": key }, body: bytes }); }

test("R2 and D1 failures preserve a recoverable reservation without duplicate objects or events", async () => {
  const bytes = Buffer.from("recover after storage failure"), pending = (await reserve(bytes)).data.resource, key = randomUUID();
  await assert.rejects(() => uploadAttachment({ ...env, ATTACHMENTS: proxyBucket({ put: async () => { throw new Error("injected R2 failure"); } }) }, putRequest(pending.id, bytes, key), auth, pending.id), (error) => error.details.component === "r2");
  let batches = 0;
  const failingDb = new Proxy(db, { get(target, property) {
    if (property === "batch") return async (statements) => { batches += 1; if (batches === 2) throw new Error("injected precommit D1 failure"); return target.batch(statements); };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(() => uploadAttachment({ ...env, DB: failingDb }, putRequest(pending.id, bytes, key), auth, pending.id), (error) => error.details.component === "d1");
  assert.notEqual(await env.ATTACHMENTS.head(`attachments/${pending.id}`), null); assert.equal((await success(`/api/v1/attachments/${pending.id}`)).state, "pending");
  const recovered = await upload(pending.id, bytes, { key }); assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal((await upload(pending.id, bytes, { key })).data.idempotent_replay, true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE subject_id=?1 AND type='attachment.uploaded'").bind(pending.id).first()).n, 1);
});

test("conditional upload never overwrites a conflicting object and parallel retries publish once", async () => {
  const bytes = Buffer.from("immutable content"), pending = (await reserve(bytes)).data.resource;
  const conflicting = Buffer.from("another object");
  await env.ATTACHMENTS.put(`attachments/${pending.id}`, conflicting, { customMetadata: { sha256: hash(conflicting) } });
  const rejected = await upload(pending.id, bytes); assert.equal(rejected.status, 409); assert.equal(rejected.data.code, "ATTACHMENT_OBJECT_CONFLICT");
  assert.deepEqual(Buffer.from(await (await env.ATTACHMENTS.get(`attachments/${pending.id}`)).arrayBuffer()), conflicting);
  const other = (await reserve(bytes)).data.resource, key = randomUUID();
  const results = await Promise.all([upload(other.id, bytes, { key }), upload(other.id, bytes, { key })]);
  assert.ok(results.every((entry) => entry.status === 200), JSON.stringify(results));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE subject_id=?1 AND type='attachment.uploaded'").bind(other.id).first()).n, 1);
});

test("upload rechecks revocation and parent archive after R2 completes", async () => {
  const bytes = Buffer.from("revocation race"), pending = (await reserve(bytes, { token: writerToken })).data.resource;
  const writerAuth = await authenticateBearer(db, `Bearer ${writerToken}`);
  const bucket = proxyBucket({ put: async (...args) => { const result = await env.ATTACHMENTS.put(...args); await db.prepare("UPDATE credentials SET revoked_at=?2 WHERE id=?1").bind(writerCredentialId, Date.now()).run(); return result; } });
  await assert.rejects(() => uploadAttachment({ ...env, ATTACHMENTS: bucket }, putRequest(pending.id, bytes, randomUUID()), writerAuth, pending.id), (error) => error.status === 401);
  await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(writerCredentialId).run();
  assert.equal((await success(`/api/v1/attachments/${pending.id}`)).state, "pending");
  const parentPending = (await reserve(bytes)).data.resource;
  const archiveBucket = proxyBucket({ put: async (...args) => { const result = await env.ATTACHMENTS.put(...args); await db.prepare("UPDATE issues SET deleted_at=?2,deleted_by_principal_id=?3 WHERE id=?1").bind(issue.id, Date.now(), ownerId).run(); return result; } });
  await assert.rejects(() => uploadAttachment({ ...env, ATTACHMENTS: archiveBucket }, putRequest(parentPending.id, bytes, randomUUID()), auth, parentPending.id), (error) => error.status === 404);
  await db.prepare("UPDATE issues SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(issue.id).run();
});

test("session scope and CSRF apply to binary and JSON writes", async () => {
  const now = Date.now(), cookie = "S".repeat(43), csrf = "X".repeat(32);
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES(?1,?2,?3,'credential',?4,'project',?5,?6,?7)`).bind(randomUUID(), hash(cookie), ownerId, credentialId, JSON.stringify({ kind: "project", entry_path: `/app/w/${workspace.id}/p/${project.id}`, workspace_id: workspace.id, project_id: project.id }), now + 8 * 3600000, now).run();
  const pending = (await reserve(Buffer.from("session"))).data.resource;
  const request = (path, extra = {}) => fetchWorker(new Request(`https://attachments.example.test${path}`, { method: "PUT", headers: { cookie: `cfkanban_session=${cookie}; cfkanban_csrf=${csrf}`, "content-type": "application/octet-stream", "idempotency-key": randomUUID(), ...extra }, body: Buffer.from("session") }), env);
  assert.equal((await request(`/api/v1/attachments/${pending.id}/content`)).status, 403);
  assert.equal((await request(`/api/v1/attachments/${pending.id}/content`, { origin: "https://evil.test", "x-csrf-token": csrf })).status, 403);
  assert.equal((await request(`/api/v1/attachments/${pending.id}/content`, { origin: "https://attachments.example.test", "x-csrf-token": csrf })).status, 200);
  const unrelatedProject = (await success(`/api/v1/workspaces/${workspace.id}/projects`, { method: "POST", body: { display_name: "Outside session" } })).resource;
  const outside = await makeIssue(unrelatedProject.id), outsideFile = await uploaded(Buffer.from("outside"), { identifier: outside.identifier });
  const denied = await fetchWorker(new Request(`https://attachments.example.test/api/v1/attachments/${outsideFile.id}/content`, { headers: { cookie: `cfkanban_session=${cookie}` } }), env); assert.equal(denied.status, 404);
});

test("expiration and Project purge preserve garbage records for failed deletion and late PUT", async () => {
  const bytes = Buffer.from("expired"), pending = (await reserve(bytes)).data.resource;
  await db.prepare("UPDATE attachment_objects SET expires_at=?2 WHERE id=?1").bind(pending.id, Date.now() - 1).run();
  assert.equal((await upload(pending.id, bytes)).status, 409);
  const before = (await db.prepare("SELECT reserved_bytes FROM attachment_storage").first()).reserved_bytes;
  const failed = await collectAttachmentGarbage({ ...env, ATTACHMENTS: proxyBucket({ delete: async () => { throw new Error("failure"); } }) }); assert.equal(failed.deleted, 0);
  assert.equal((await db.prepare("SELECT reserved_bytes FROM attachment_storage").first()).reserved_bytes, before);
  await collectAttachmentGarbage(env);
  const tombstone = await db.prepare("SELECT * FROM attachment_objects WHERE id=?1").bind(pending.id).first(); assert.equal(tombstone.state, "garbage"); assert.notEqual(tombstone.budget_released_at, null);
  await env.ATTACHMENTS.put(tombstone.object_key, bytes);
  await collectAttachmentGarbage(env, Date.now() + 1); assert.equal(await env.ATTACHMENTS.head(tombstone.object_key), null);
  assert.notEqual(await db.prepare("SELECT id FROM attachment_objects WHERE id=?1").bind(pending.id).first(), null);
  const purgeProject = (await success(`/api/v1/workspaces/${workspace.id}/projects`, { method: "POST", body: { display_name: "Purge files" } })).resource;
  const target = await makeIssue(purgeProject.id), file = await uploaded(Buffer.from("purge me"), { identifier: target.identifier });
  const archived = await success(`/api/v1/workspaces/${workspace.id}/projects/${purgeProject.id}?expected_version=1`, { method: "DELETE" });
  const preview = await success(`/api/v1/workspaces/${workspace.id}/projects/${purgeProject.id}/purge-preview`); assert.equal(preview.counts.attachments, 1); assert.equal(preview.counts.attachment_bytes, 8);
  const result = await success(`/api/v1/workspaces/${workspace.id}/projects/${purgeProject.id}/commands/purge`, { method: "POST", body: { expected_version: archived.resource.version, confirm_name: purgeProject.display_name, preview_digest: preview.preview_digest } });
  assert.equal(result.resource.storage_cleanup_pending, true); assert.equal(await db.prepare("SELECT id FROM issue_attachments WHERE id=?1").bind(file.id).first(), null);
  assert.equal((await db.prepare("SELECT state FROM attachment_objects WHERE id=?1").bind(file.id).first()).state, "garbage");
  await collectAttachmentGarbage(env, Date.now() + 2); assert.equal(await env.ATTACHMENTS.head(`attachments/${file.id}`), null);
});

test("R2-disabled instances retain core Kanban and expose metadata without enabling writes", async () => {
  const disabled = { ...env, ATTACHMENTS: undefined };
  const request = (path, init = {}) => fetchWorker(new Request(`https://attachments.example.test${path}`, { ...init, headers: { ...headers(), ...init.headers } }), disabled);
  assert.equal((await request(`/api/v1/issues/${issue.identifier}`)).status, 200);
  const list = await request(`/api/v1/issues/${issue.identifier}/attachments`); assert.equal(list.status, 200); assert.equal((await list.json()).capabilities.attachments, false);
  const meta = await request("/api/v1/meta"); assert.equal((await meta.json()).capabilities.attachments, false);
  const reservation = await request(`/api/v1/issues/${issue.identifier}/attachments`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ filename: "disabled", content_type: "text/plain", size_bytes: 1, sha256: hash("a") }) });
  assert.equal(reservation.status, 503); assert.equal((await reservation.json()).code, "ATTACHMENTS_DISABLED");
});

test("garbage cleanup revisits late PUT tombstones despite a full batch of new garbage", async () => {
  const now = Date.now(), lateId = randomUUID(), objectKey = `attachments/${lateId}`;
  const insertGarbage = (id, garbageAt, lastCheckedAt, releasedAt, size) => db.prepare(`INSERT INTO attachment_objects
    (id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id,garbage_at,last_checked_at,budget_released_at)
    VALUES (?1,?2,?3,?4,'garbage',?5,?5,?1,?5,?6,?7)`)
    .bind(id, `attachments/${id}`, size, hash("late"), garbageAt, lastCheckedAt, releasedAt);
  await insertGarbage(lateId, now - 7200000, now - 3600000, now - 3600000, 4).run();
  // 模拟已确认删除、释放预算之后才落地的在途 PUT。
  await env.ATTACHMENTS.put(objectKey, Buffer.from("late"));
  for (let round = 1; round <= 3; round += 1) {
    const scheduledAt = now + round * 3600000;
    await db.batch([
      ...Array.from({ length: 64 }, () => insertGarbage(randomUUID(), scheduledAt - 1, null, null, 1)),
      db.prepare("UPDATE attachment_storage SET reserved_bytes=reserved_bytes+64 WHERE singleton=1"),
    ]);
    const result = await collectAttachmentGarbage(env, scheduledAt);
    assert.equal(result.checked, 64);
    assert.equal(await env.ATTACHMENTS.head(objectKey), null, `round ${round}: new garbage must not starve tombstone rechecks`);
    const tombstone = await db.prepare("SELECT last_checked_at,budget_released_at FROM attachment_objects WHERE id=?1").bind(lateId).first();
    assert.ok(tombstone.last_checked_at >= now + 3600000);
    assert.equal(tombstone.budget_released_at, now - 3600000);
  }
});
