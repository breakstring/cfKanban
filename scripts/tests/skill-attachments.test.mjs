import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { downloadAttachment, uploadAttachment } from "../../packages/skill-runtime/src/attachments.mjs";
import { getCommandCatalog } from "../../packages/skill-runtime/src/cli.mjs";
import { guardedApiRequest } from "../../packages/skill-runtime/src/capability-delivery.mjs";

const instanceId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const identifier = "CFK-17";
const token = "cfk_v1_TEST_SECRET_DO_NOT_EXPOSE";
const contents = Buffer.from("Selected diagnostic log\n");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "cfkanban-attachment-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, ".cfkanban");
  const credentials = path.join(stateRoot, "instances", instanceId, "credentials");
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await writeFile(path.join(credentials, "..", "instance.json"), JSON.stringify({ instance_id: instanceId, trusted_api_origin: "https://attachments.example.test" }), { mode: 0o600 });
  await writeFile(path.join(credentials, "current.json"), JSON.stringify({ token_digest: sha(token) }), { mode: 0o600 });
  await writeFile(path.join(credentials, "current.secret.json"), JSON.stringify({ token }), { mode: 0o600 });
  const filePath = path.join(home, "diagnostic.log");
  await writeFile(filePath, contents);
  return { home, stateRoot, instanceId, filePath, identifier, idempotencyKey: "user-selected-upload-operation" };
}

function resource(overrides = {}) {
  return { id: attachmentId, issue: { identifier }, filename: "diagnostic.log", content_type: "text/plain", size_bytes: contents.length, sha256: sha(contents), state: "ready", version: 2, deleted_at: null, ...overrides };
}

function checkedFetch(handler) {
  return async (url, options) => {
    assert.equal(url.origin, "https://attachments.example.test");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.get("authorization"), `Bearer ${token}`);
    return handler(url.pathname, options);
  };
}

test("attachment commands are discovered only on the daily surface", () => {
  for (const name of ["attachment upload", "attachment download"]) {
    assert.ok(getCommandCatalog({ surface: "daily" }).commands.some((entry) => entry.name === name));
    for (const surface of ["admin", "deploy"]) assert.equal(getCommandCatalog({ surface }).commands.some((entry) => entry.name === name), false);
  }
  assert.ok(getCommandCatalog({ surface: "daily" }).commands.find((entry) => entry.name === "attachment upload").input_fields.includes("firstAttemptAt"));
});

test("generic API refuses binary attachment routes before loading Credentials or making requests", async () => {
  for (const apiPath of [
    `/api/v1/attachments/${attachmentId}/content`,
    `/api/v1/attachments/${attachmentId}/content?preview=1`,
    `/api/v1/attachments/${attachmentId}/%63ontent/`,
    `/api/v1/attachments/${attachmentId}%2fcontent`,
  ]) {
    for (const method of ["GET", "PUT", " get "]) {
      await assert.rejects(guardedApiRequest({ instanceId, apiPath, method, fetchImpl: () => assert.fail("content route must stop before fetch") }), (error) => error.code === "ATTACHMENT_COMMAND_REQUIRED" && error.details.command.startsWith("attachment "));
    }
  }
});

test("generic API continues to allow attachment metadata, reservations, delete and restore", async (t) => {
  const input = await fixture(t);
  for (const [method, apiPath] of [
    ["GET", `/api/v1/attachments/${attachmentId}`],
    ["GET", `/api/v1/issues/${identifier}/attachments?deleted=only`],
    ["POST", `/api/v1/issues/${identifier}/attachments`],
    ["DELETE", `/api/v1/attachments/${attachmentId}?expected_version=2`],
    ["POST", `/api/v1/attachments/${attachmentId}/commands/restore`],
  ]) {
    const result = await guardedApiRequest({ ...input, method, apiPath, fetchImpl: checkedFetch(() => json({ metadata: true })) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { metadata: true });
  }
});

test("upload reserves one file, sends binary bytes and verifies ready without returning secrets or content", async (t) => {
  const input = await fixture(t);
  const requests = [];
  const result = await uploadAttachment({ ...input, fetchImpl: checkedFetch((url, options) => {
    requests.push([url, options.method, options.headers.get("idempotency-key")]);
    if (options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body), { filename: "diagnostic.log", content_type: "text/plain", size_bytes: contents.length, sha256: sha(contents) });
      return json({ resource: resource({ state: "pending", version: 1 }) }, 201);
    }
    if (options.method === "PUT") {
      assert.equal(options.headers.get("content-type"), "application/octet-stream");
      assert.deepEqual(options.body, contents);
      return json({ resource: resource() });
    }
    return json(resource({ unexpected: { token, bytes: contents.toString("base64") } }));
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "ready");
  assert.equal(result.attachment_id, attachmentId);
  assert.equal(result.resume.attachmentId, attachmentId);
  assert.equal(requests.length, 3);
  assert.notEqual(requests[0][2], requests[1][2]);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(contents.toString()), false);
  assert.equal(JSON.stringify(result).includes(contents.toString("base64")), false);
});

test("response loss preserves reservation identity and stage keys, then ready readback resolves uncertain PUT", async (t) => {
  const input = await fixture(t);
  const keys = [];
  let posts = 0;
  const fetchImpl = checkedFetch((url, options) => {
    if (options.method === "POST") {
      posts += 1;
      keys.push(options.headers.get("idempotency-key"));
      if (posts === 1) throw new Error(`response lost ${token}`);
      return json({ resource: resource({ state: "pending", version: 1 }) });
    }
    if (options.method === "PUT") throw new Error("response lost after commit");
    return json(resource());
  });
  const first = await uploadAttachment({ ...input, fetchImpl });
  assert.equal(first.ok, false);
  assert.equal(first.stage, "reserve");
  assert.equal(first.operation.error.source, "client_transport");
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.ok(Number.isSafeInteger(first.resume.firstAttemptAt));
  const second = await uploadAttachment({ ...input, ...first.resume, fetchImpl });
  assert.equal(second.ok, true);
  assert.equal(second.recovered, true);
  assert.equal(keys[0], keys[1]);
  assert.deepEqual(first.idempotency_keys, second.idempotency_keys);
  assert.equal(second.resume.firstAttemptAt, first.resume.firstAttemptAt);
});

test("lost reservation response stops replay at 24 hours while preserving recovery identity", async (t) => {
  const input = await fixture(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let posts = 0;
  const first = await uploadAttachment({ ...input, fetchImpl: checkedFetch((_url, options) => {
    assert.equal(options.method, "POST");
    posts++;
    throw new Error("reservation committed but response lost");
  }) });
  assert.equal(first.stage, "reserve");
  assert.equal(first.resume.firstAttemptAt, now);
  now += 24 * 60 * 60 * 1000;
  await assert.rejects(uploadAttachment({ ...input, ...first.resume, fetchImpl: () => assert.fail("expired reservation must not be repeated") }), (error) => {
    assert.equal(error.code, "ATTACHMENT_RETRY_WINDOW_EXPIRED");
    assert.deepEqual(error.details.resume, first.resume);
    assert.deepEqual(error.details.idempotency_keys, first.idempotency_keys);
    return true;
  });
  assert.equal(posts, 1);
});

test("attachment retry time rejects invalid and future values before any request", async (t) => {
  const input = await fixture(t);
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  for (const firstAttemptAt of [now + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, String(now)]) {
    await assert.rejects(uploadAttachment({ ...input, firstAttemptAt, fetchImpl: () => assert.fail("invalid retry time must stop before requests") }), { code: "ATTACHMENT_RETRY_TIME_INVALID" });
  }
});

test("known attachment after the retry window uses metadata to distinguish ready from expired", async (t) => {
  const input = await fixture(t);
  const now = 1_800_000_000_000;
  const firstAttemptAt = now - 24 * 60 * 60 * 1000;
  t.mock.method(Date, "now", () => now);
  for (const state of ["ready", "expired"]) {
    const invoke = () => uploadAttachment({ ...input, attachmentId, firstAttemptAt, fetchImpl: checkedFetch((url, options) => {
      assert.equal(options.method, "GET", "known attachments must not create a new reservation");
      assert.equal(url, `/api/v1/attachments/${attachmentId}`);
      return json(resource({ state }));
    }) });
    if (state === "expired") await assert.rejects(invoke(), { code: "ATTACHMENT_RESUME_CONFLICT" });
    else {
      const result = await invoke();
      assert.equal(result.ok, true);
      assert.equal(result.resume.firstAttemptAt, firstAttemptAt);
    }
  }
});

test("pending upload returns reusable attachment and keys and resumes without another reservation", async (t) => {
  const input = await fixture(t);
  let ready = false;
  let puts = 0;
  let posts = 0;
  const keys = [];
  const fetchImpl = checkedFetch((url, options) => {
    if (options.method === "POST") { posts += 1; return json({ resource: resource({ state: "pending" }) }); }
    if (options.method === "PUT") {
      puts += 1;
      keys.push(options.headers.get("idempotency-key"));
      if (puts === 1) throw new Error("connection lost before commit");
      ready = true;
      return json({ resource: resource() });
    }
    return json(resource({ state: ready ? "ready" : "pending" }));
  });
  const first = await uploadAttachment({ ...input, fetchImpl });
  assert.equal(first.ok, false);
  assert.equal(first.stage, "upload");
  const second = await uploadAttachment({ ...input, ...first.resume, fetchImpl });
  assert.equal(second.ok, true);
  assert.equal(posts, 1);
  assert.equal(keys[0], keys[1]);
});

test("resume rejects another Issue, changed bytes and expired reservations without PUT", async (t) => {
  const input = await fixture(t);
  for (const override of [{ issue: { identifier: "CFK-18" } }, { sha256: "a".repeat(64) }, { state: "expired" }, { deleted_at: "2026-09-19" }]) {
    await assert.rejects(uploadAttachment({ ...input, attachmentId, fetchImpl: checkedFetch((url, options) => {
      assert.equal(options.method, "GET");
      return json(resource(override));
    }) }), { code: "ATTACHMENT_RESUME_CONFLICT" });
  }
});

test("upload rejects private state, empty or oversized files, directories and links before network access", async (t) => {
  const input = await fixture(t);
  const fetchImpl = () => assert.fail("network must not be reached");
  await assert.rejects(uploadAttachment({ ...input, filePath: path.join(input.stateRoot, "instances", instanceId, "credentials", "current.secret.json"), fetchImpl }), { code: "ATTACHMENT_STATE_PATH_REJECTED" });
  await assert.rejects(uploadAttachment({ ...input, filePath: "relative.log", fetchImpl }), { code: "ATTACHMENT_PATH_INVALID" });
  await assert.rejects(uploadAttachment({ ...input, filePath: input.home, fetchImpl }), { code: "ATTACHMENT_FILE_INVALID" });
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
    await writeFile(input.filePath, bytes);
    await assert.rejects(uploadAttachment({ ...input, fetchImpl }), { code: "ATTACHMENT_SIZE_INVALID" });
  }
  await writeFile(input.filePath, contents);
  const hardlink = path.join(input.home, "hard.log");
  await link(input.filePath, hardlink);
  await assert.rejects(uploadAttachment({ ...input, filePath: hardlink, fetchImpl }), { code: "ATTACHMENT_FILE_INVALID" });
  if (process.platform !== "win32") {
    const symbolic = path.join(input.home, "linked.log");
    await symlink(input.filePath, symbolic);
    await assert.rejects(uploadAttachment({ ...input, filePath: symbolic, fetchImpl }), { code: "STATE_SYMLINK_REJECTED" });
  }
});

test("download verifies bytes before exclusively publishing a private file", async (t) => {
  const input = await fixture(t);
  const outputPath = path.join(input.home, "downloaded.log");
  const result = await downloadAttachment({ ...input, attachmentId, outputPath, fetchImpl: checkedFetch((url) => url.endsWith("/content") ? new Response(contents) : json(resource())) });
  assert.equal(result.ok, true);
  assert.equal(result.output_path, outputPath);
  assert.deepEqual(await readFile(outputPath), contents);
  if (process.platform !== "win32") assert.equal((await lstat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await readdir(input.home)).some((name) => name.endsWith(".tmp")), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(contents.toString()), false);
  await assert.rejects(downloadAttachment({ ...input, attachmentId, outputPath, fetchImpl: () => assert.fail("existing file must stop before network") }), { code: "ATTACHMENT_OUTPUT_EXISTS" });
});

test("download rejects corrupt, short and oversized content and removes partial files", async (t) => {
  const input = await fixture(t);
  for (const bytes of [Buffer.alloc(contents.length, 42), contents.subarray(1), Buffer.concat([contents, Buffer.from("extra")])]) {
    const outputPath = path.join(input.home, "corrupt.log");
    await assert.rejects(downloadAttachment({ ...input, attachmentId, outputPath, fetchImpl: checkedFetch((url) => url.endsWith("/content") ? new Response(bytes) : json(resource())) }), { code: "ATTACHMENT_CONTENT_INVALID" });
    await assert.rejects(lstat(outputPath), { code: "ENOENT" });
    assert.equal((await readdir(input.home)).some((name) => name.endsWith(".tmp")), false);
  }
});

test("download never overwrites a destination created while the request is in flight", async (t) => {
  const input = await fixture(t);
  const outputPath = path.join(input.home, "raced.log");
  await assert.rejects(downloadAttachment({ ...input, attachmentId, outputPath, fetchImpl: checkedFetch(async (url) => {
    if (!url.endsWith("/content")) return json(resource());
    await writeFile(outputPath, "keep me");
    return new Response(contents);
  }) }), { code: "ATTACHMENT_OUTPUT_EXISTS" });
  assert.equal(await readFile(outputPath, "utf8"), "keep me");
  assert.equal((await readdir(input.home)).some((name) => name.endsWith(".tmp")), false);
});

test("binary redirect is never followed and platform failures use existing client normalization", async (t) => {
  const input = await fixture(t);
  const outputPath = path.join(input.home, "redirect.log");
  for (const response of [new Response(null, { status: 302, headers: { location: "https://other.example/secret" } }), new Response("limited", { status: 429, headers: { "retry-after": "9" } })]) {
    const result = await downloadAttachment({ ...input, attachmentId, outputPath, fetchImpl: checkedFetch((url) => url.endsWith("/content") ? response : json(resource())) });
    assert.equal(result.ok, false);
    assert.equal(result.operation.error.details.normalized_by, "client");
    assert.equal(result.operation.error.code, response.status === 302 ? "CROSS_ORIGIN_REDIRECT_REJECTED" : "RATE_LIMITED");
    await assert.rejects(lstat(outputPath), { code: "ENOENT" });
  }
});

test("download stops on stream failure and never publishes a partial file", async (t) => {
  const input = await fixture(t);
  const outputPath = path.join(input.home, "partial.log");
  const body = new ReadableStream({ start(controller) { controller.enqueue(contents.subarray(0, 3)); controller.error(new Error(`connection failed ${token}`)); } });
  const result = await downloadAttachment({ ...input, attachmentId, outputPath, fetchImpl: checkedFetch((url) => url.endsWith("/content") ? new Response(body) : json(resource())) });
  assert.equal(result.ok, false);
  assert.equal(result.operation.error.source, "client_transport");
  assert.equal(JSON.stringify(result).includes(token), false);
  await assert.rejects(lstat(outputPath), { code: "ENOENT" });
  assert.equal((await readdir(input.home)).some((name) => name.endsWith(".tmp")), false);
});

test("download rejects private-state and linked destinations before network, and pending metadata before content", async (t) => {
  const input = await fixture(t);
  const fetchImpl = () => assert.fail("unsafe output must stop before network");
  await assert.rejects(downloadAttachment({ ...input, attachmentId, outputPath: path.join(input.stateRoot, "file.log"), fetchImpl }), { code: "ATTACHMENT_STATE_PATH_REJECTED" });
  if (process.platform !== "win32") {
    const linkedDirectory = path.join(input.home, "linked");
    await symlink(input.home, linkedDirectory);
    await assert.rejects(downloadAttachment({ ...input, attachmentId, outputPath: path.join(linkedDirectory, "file.log"), fetchImpl }), { code: "STATE_SYMLINK_REJECTED" });
  }
  await assert.rejects(downloadAttachment({ ...input, attachmentId, outputPath: path.join(input.home, "pending.log"), fetchImpl: checkedFetch((url) => {
    assert.equal(url.endsWith("/content"), false);
    return json(resource({ state: "pending" }));
  }) }), { code: "ATTACHMENT_NOT_READY" });
});

test("already-ready resume verifies metadata without reserving or uploading again", async (t) => {
  const input = await fixture(t);
  const result = await uploadAttachment({ ...input, attachmentId, fetchImpl: checkedFetch((url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(url, `/api/v1/attachments/${attachmentId}`);
    return json(resource());
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "ready");
});

test("current Credential permission drift blocks upload before reserving remotely", { skip: process.platform === "win32" }, async (t) => {
  const input = await fixture(t);
  await chmod(path.join(input.stateRoot, "instances", instanceId, "credentials", "current.secret.json"), 0o644);
  await assert.rejects(uploadAttachment({ ...input, fetchImpl: () => assert.fail("permission drift must stop") }), { code: "STATE_PERMISSION_DRIFT" });
});
