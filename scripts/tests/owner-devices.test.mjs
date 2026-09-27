import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fsPromises, { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  approveOwnerDevice, inspectOwnerDeviceRequest, listOwnerDevices,
  prepareOwnerDevice, revokeOwnerDevice, verifyOwnerDevice,
} from "../../packages/skill-runtime/src/owner-devices.mjs";
import {
  createPendingCredential, getInstancePaths, loadCurrentCredentialSecret,
  loadPendingCredentialSecret, promotePendingCredential, putInstanceMetadata,
} from "../../packages/skill-runtime/src/state.mjs";

import { verifyPendingCredential } from "../../packages/skill-runtime/src/credential-operations.mjs";
import { pathType } from "../../packages/skill-runtime/src/utils.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Two private temporary homes and an in-memory Service replace every network/state dependency.
async function fixture(t) {
  const homes = await Promise.all(["old", "new"].map((device) => mkdtemp(path.join(os.tmpdir(), `cfkanban-device-${device}-`))));
  t.after(() => Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))));
  const instanceId = randomUUID(), owner = randomUUID(), origin = "https://devices.invalid";
  const f = { owner, origin, instanceId, version: 1, credentials: new Map(), replays: new Map(), calls: [], writes: 0, now: Date.now(), loseResponse: false, discoveryOverride: null, metaOverride: null, meOverride: null, responseOverride: null, healthOverride: null, beforeMutation: null };
  const base = () => ({ instance_id: instanceId, observed_origin: origin, preferred_api_origin: origin, origin_version: 1, service_version: "1.0.0", schema_version: 12 });
  f.fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url), headers = new Headers(options.headers), token = headers.get("authorization")?.replace(/^Bearer /, "");
    assert.equal(parsed.origin, origin);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    f.calls.push({ path: parsed.pathname, search: parsed.search, hasAuth: Boolean(token), method: options.method, body: options.body, key: headers.get("idempotency-key") });
    if (parsed.pathname === "/.well-known/cfkanban-instance.json") {
      assert.equal(token, undefined);
      if (f.discoveryOverride instanceof Response) return f.discoveryOverride;
      return json({ ...base(), discovery_version: 1, ...f.discoveryOverride });
    }
    if (parsed.pathname === "/healthz") {
      assert.equal(token, undefined);
      return json({ d1: "reachable", service_version: "1.0.0", schema_version: 12, ...f.healthOverride });
    }
    const credential = [...f.credentials.values()].find((entry) => entry.token_digest === hash(token ?? "") && !entry.revoked_at);
    if (!credential) return json({}, 401);
    const principal = { id: owner, principal_id: owner, is_owner: true, version: f.version, credential: { id: credential.id, fingerprint: `cfk_v1_${credential.token_prefix}_…` } };
    if (parsed.pathname === "/api/v1/meta") return json({ ...base(), principal: { id: owner, is_owner: true }, ...f.metaOverride });
    if (parsed.pathname === "/api/v1/me") return json({ ...principal, ...f.meOverride });
    if (parsed.pathname === `/api/v1/admin/principals/${owner}/credentials`) return json({ items: [...f.credentials.values()].map(({ token_digest, ...entry }) => entry) });
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body), key = headers.get("idempotency-key");
    assert.ok(key);
    const replay = f.replays.get(key);
    if (replay) {
      assert.equal(replay.body, options.body, "uncertain retries must preserve the full original payload including CAS");
      return json(replay.result);
    }
    if (f.beforeMutation) { const before = f.beforeMutation; f.beforeMutation = null; const response = before(); if (response) return response; }
    if (body.expected_version !== f.version) {
      const requestId = randomUUID();
      return new Response(JSON.stringify({ code: "VERSION_CONFLICT", category: "conflict", message: "Version changed", recovery: "refetch_and_retry", request_id: requestId, retryable: false, source: "service", details: { current_version: f.version } }), { status: 409, headers: { "content-type": "application/json", "x-request-id": requestId } });
    }
    let resource;
    if (parsed.pathname === "/api/v1/admin/owner-credentials/add-device") {
      assert.equal(body.instance_id, instanceId); assert.equal(body.principal_id, owner);
      assert.deepEqual(Object.keys(body).sort(), ["instance_id", "principal_id", "credential_id", "token_prefix", "token_digest", "device_name", "issued_at", "expires_at", "expected_version"].sort());
      assert.ok(Date.parse(body.expires_at) > f.now);
      assert.equal([...f.credentials.values()].some((entry) => entry.token_digest === body.token_digest), false);
      resource = { id: body.credential_id, principal_id: owner, device_name: body.device_name, token_prefix: body.token_prefix, token_digest: body.token_digest, revoked_at: null };
      f.credentials.set(resource.id, resource);
    } else {
      const match = parsed.pathname.match(/^\/api\/v1\/admin\/owner-credentials\/([^/]+)\/revoke$/);
      assert.ok(match); resource = f.credentials.get(match[1]); assert.ok(resource); resource.revoked_at = new Date(f.now).toISOString();
    }
    f.version++; f.writes++;
    const { token_digest, ...publicResource } = resource;
    const result = { resource: { ...publicResource, principal_version: f.version }, ...(f.responseOverride ? f.responseOverride(token) : {}) };
    f.replays.set(key, { body: options.body, result });
    if (f.loseResponse) { f.loseResponse = false; throw new Error(`lost response ${token}`); }
    return json(result);
  };
  const input = (home) => ({ home, stateRoot: path.join(home, ".cfkanban"), persistenceConfirmed: true, instanceId, fetchImpl: f.fetchImpl, now: f.now });
  f.old = input(homes[0]); f.fresh = { ...input(homes[1]), apiOrigin: origin, ownerPrincipalId: owner, deviceName: "新电脑", operationId: randomUUID(), idempotencyKey: randomUUID() };
  await putInstanceMetadata({ ...f.old, trustedApiOrigin: origin });
  const metadata = await createPendingCredential({ ...f.old, principalId: owner, credentialId: randomUUID(), purpose: "owner_bootstrap" });
  await promotePendingCredential({ ...f.old, principalId: owner, credentialId: metadata.credential_id, fingerprint: metadata.fingerprint });
  f.credentials.set(metadata.credential_id, { id: metadata.credential_id, principal_id: owner, token_prefix: metadata.token_prefix, token_digest: metadata.token_digest, device_name: null, revoked_at: null });
  f.oldId = metadata.credential_id;
  f.prepare = async () => (await prepareOwnerDevice(f.fresh)).pairing_request;
  return f;
}

function rejectsCode(action, code) { return assert.rejects(action, (error) => error.code === code); }

test("two devices share one Owner while secrets stay in their own private home; each device can be revoked separately", async (t) => {
  const f = await fixture(t), prepared = await prepareOwnerDevice(f.fresh), request = prepared.pairing_request;
  const pending = await loadPendingCredentialSecret(f.fresh), old = await loadCurrentCredentialSecret(f.old);
  assert.notEqual(pending.token, old.token);
  assert.equal(pending.metadata.credential_id_binding, "exact");
  assert.equal(JSON.stringify(prepared).includes(pending.token), false);
  assert.equal(f.calls.every((call) => !call.hasAuth), true);
  const approval = await approveOwnerDevice({ ...f.old, request });
  assert.equal(approval.operation.ok, true);
  assert.equal(approval.next_action, "verify_on_new_device");
  const current = await verifyOwnerDevice(f.fresh);
  assert.equal(current.credential.state, "current");
  assert.equal(current.verification.principal_id, f.owner);
  assert.equal((await verifyOwnerDevice(f.fresh)).credential.credential_id, request.credential_id);
  assert.equal((await inspectOwnerDeviceRequest(f.fresh)).credential.state, "current");
  assert.equal((await loadCurrentCredentialSecret(f.old)).token, old.token);
  assert.equal((await listOwnerDevices(f.old)).operation.data.items.length, 2);
  const revoked = await revokeOwnerDevice({ ...f.old, credentialId: request.credential_id, idempotencyKey: randomUUID() });
  assert.equal(revoked.operation.ok, true);
  assert.equal((await verifyOwnerDevice(f.fresh)).verification.ok, false);
  assert.equal(f.credentials.get(f.oldId).revoked_at, null);
  assert.equal(new Set([...f.credentials.values()].map((entry) => entry.principal_id)).size, 1);
});

test("prepare resumes the same pending secret and request, and expired requests never silently regenerate", async (t) => {
  const f = await fixture(t), first = await f.prepare(), pending = await loadPendingCredentialSecret(f.fresh);
  const second = await prepareOwnerDevice({ ...f.fresh, now: f.now + 5000 });
  assert.deepEqual(second.pairing_request, first);
  assert.equal((await loadPendingCredentialSecret(f.fresh)).token, pending.token);
  const expired = await prepareOwnerDevice({ ...f.fresh, now: f.now + 3_600_001 });
  assert.equal(expired.expired, true); assert.deepEqual(expired.pairing_request, first);
  await rejectsCode(() => approveOwnerDevice({ ...f.old, request: first, now: f.now + 3_600_001 }), "OWNER_DEVICE_REQUEST_EXPIRED");
  assert.equal(f.writes, 0);
  await rejectsCode(() => prepareOwnerDevice({ ...f.fresh, deviceName: "改名" }), "STATE_PENDING_CONFLICT");
  await rejectsCode(() => prepareOwnerDevice({ ...f.fresh, operationId: randomUUID() }), "STATE_PENDING_CONFLICT");
  assert.deepEqual((await inspectOwnerDeviceRequest(f.fresh)).pairing_request, first);
});

test("lost approval response retries the exact original CAS payload after Principal version changes and expiry", async (t) => {
  const f = await fixture(t), request = await f.prepare(); f.loseResponse = true;
  assert.equal((await approveOwnerDevice({ ...f.old, request })).operation.ok, false);
  assert.equal(f.version, 2); assert.equal(f.writes, 1);
  const retried = await approveOwnerDevice({ ...f.old, request, now: f.now + 3_600_001 });
  assert.equal(retried.operation.ok, true); assert.equal(f.writes, 1);
  assert.equal((await verifyOwnerDevice({ ...f.fresh, now: f.now + 3_600_001 })).credential.state, "current");
  const key = randomUUID(); f.loseResponse = true;
  assert.equal((await revokeOwnerDevice({ ...f.old, credentialId: request.credential_id, idempotencyKey: key })).operation.ok, false);
  assert.equal((await revokeOwnerDevice({ ...f.old, credentialId: request.credential_id, idempotencyKey: key })).operation.ok, true);
  assert.equal(f.writes, 2);
});

test("prepare rejects existing current identity, origin drift, wrong discovery instance and redirects without sending any token", async (t) => {
  const f = await fixture(t);
  await rejectsCode(() => prepareOwnerDevice({ ...f.fresh, home: f.old.home, stateRoot: f.old.stateRoot }), "STATE_CURRENT_CONFLICT");
  f.discoveryOverride = { instance_id: randomUUID() };
  await rejectsCode(() => f.prepare(), "DISCOVERY_INSTANCE_MISMATCH");
  f.discoveryOverride = new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } });
  await rejectsCode(() => f.prepare(), "DISCOVERY_REJECTED");
  f.discoveryOverride = null;
  await f.prepare();
  await rejectsCode(() => prepareOwnerDevice({ ...f.fresh, apiOrigin: "https://elsewhere.invalid" }), "STATE_INSTANCE_CONFLICT");
  assert.equal(f.calls.every((call) => !call.hasAuth), true);
});

test("approval rejects mismatched instance, Principal, origin and malformed or secret-bearing requests", async (t) => {
  const f = await fixture(t), request = await f.prepare(); f.calls = [];
  for (const field of ["instance_id", "principal_id"]) await rejectsCode(() => approveOwnerDevice({ ...f.old, request: { ...request, [field]: randomUUID() } }), "OWNER_DEVICE_TARGET_MISMATCH");
  await rejectsCode(() => approveOwnerDevice({ ...f.old, request: { ...request, api_origin: "https://elsewhere.invalid" } }), "OWNER_DEVICE_TARGET_MISMATCH");
  for (const extra of [{ token: "secret" }, { device_name: "bad\nname" }, { device_name: "cfk_v1_example" }, { token_digest: "bad" }, { expires_at: new Date(f.now + 3_600_001).toISOString() }]) {
    await rejectsCode(() => approveOwnerDevice({ ...f.old, request: { ...request, ...extra } }), "INVALID_OWNER_DEVICE_REQUEST");
  }
  assert.equal(f.calls.length, 0); assert.equal(f.writes, 0);
});

test("verification retains pending state on false Owner, exact-ID/fingerprint/instance mismatch or rejected authentication", async (t) => {
  const f = await fixture(t), request = await f.prepare();
  assert.equal((await verifyOwnerDevice(f.fresh)).credential.state, "pending");
  await approveOwnerDevice({ ...f.old, request });
  for (const override of [{ is_owner: false }, { id: randomUUID() }, { credential: { id: randomUUID(), fingerprint: `cfk_v1_${request.token_prefix}_…` } }, { credential: { id: request.credential_id, fingerprint: "wrong" } }]) {
    f.meOverride = override;
    await rejectsCode(() => verifyOwnerDevice(f.fresh), "CREDENTIAL_VERIFICATION_MISMATCH");
    assert.equal((await loadPendingCredentialSecret(f.fresh)).metadata.state, "pending");
  }
  f.meOverride = null; f.metaOverride = { instance_id: randomUUID() };
  await rejectsCode(() => verifyOwnerDevice(f.fresh), "CREDENTIAL_VERIFICATION_MISMATCH");
  assert.equal((await loadPendingCredentialSecret(f.fresh)).metadata.state, "pending");
});

test("private-path permission drift, symlinks and damaged pending state fail before using a token", async (t) => {
  const f = await fixture(t); await f.prepare(); const paths = getInstancePaths(f.fresh); f.calls = [];
  await chmod(paths.pendingSecret, 0o644);
  await rejectsCode(() => verifyOwnerDevice(f.fresh), "STATE_PERMISSION_DRIFT");
  await chmod(paths.pendingSecret, 0o600);
  const raw = await readFile(paths.pendingMetadata, "utf8");
  await rm(paths.pendingMetadata); await symlink(paths.pendingSecret, paths.pendingMetadata);
  await rejectsCode(() => inspectOwnerDeviceRequest(f.fresh), "STATE_SYMLINK_REJECTED");
  await rm(paths.pendingMetadata); await writeFile(paths.pendingMetadata, raw, { mode: 0o600 });
  await rm(paths.pendingMetadata);
  await rejectsCode(() => f.prepare(), "STATE_PENDING_CONFLICT");
  assert.equal(f.calls.every((call) => !call.hasAuth), true);
});

test("approval and revoke reject identity drift and own-device revocation; responses never reflect token secrets", async (t) => {
  const f = await fixture(t), request = await f.prepare();
  await rejectsCode(() => revokeOwnerDevice({ ...f.old, credentialId: f.oldId, idempotencyKey: randomUUID() }), "OWNER_CURRENT_CREDENTIAL_REVOKE_FORBIDDEN");
  f.meOverride = { is_owner: false };
  await rejectsCode(() => approveOwnerDevice({ ...f.old, request }), "CREDENTIAL_VERIFICATION_MISMATCH");
  f.meOverride = null; f.responseOverride = (token) => ({ echoed: token, nested: [{ secret: token }] });
  const approval = await approveOwnerDevice({ ...f.old, request }), current = await loadCurrentCredentialSecret(f.old);
  assert.equal(JSON.stringify(approval).includes(current.token), false);
  assert.equal(approval.operation.data.echoed, "[REDACTED]");
  await rejectsCode(() => revokeOwnerDevice({ ...f.old, credentialId: request.credential_id, idempotencyKey: request.idempotency_key }), "STATE_OPERATION_CONFLICT");
});


test("interrupted local promotion resumes only when the current slot contains the exact same device secret and request", async (t) => {
  const f = await fixture(t), request = await f.prepare(); await approveOwnerDevice({ ...f.old, request });
  const paths = getInstancePaths(f.fresh), pendingMetadata = await readFile(paths.pendingMetadata), pendingSecret = await readFile(paths.pendingSecret);
  await writeFile(paths.currentSecret, pendingSecret, { mode: 0o600 });
  assert.equal((await verifyOwnerDevice(f.fresh)).credential.state, "current");
  await writeFile(paths.pendingMetadata, pendingMetadata, { mode: 0o600 });
  await writeFile(paths.pendingSecret, pendingSecret, { mode: 0o600 });
  assert.equal((await verifyOwnerDevice(f.fresh)).credential.state, "current");
  await writeFile(paths.pendingMetadata, pendingMetadata, { mode: 0o600 });
  await writeFile(paths.pendingSecret, pendingSecret, { mode: 0o600 });
  const current = JSON.parse(await readFile(paths.currentMetadata)); current.owner_device_request.device_name = "Another device";
  await writeFile(paths.currentMetadata, JSON.stringify(current), { mode: 0o600 });
  await rejectsCode(() => verifyOwnerDevice(f.fresh), "STATE_CURRENT_CONFLICT");
});

async function promotionWithLeftoverMetadata(t) {
  const f = await fixture(t), request = await f.prepare();
  await approveOwnerDevice({ ...f.old, request });
  const paths = getInstancePaths(f.fresh), pendingMetadata = await readFile(paths.pendingMetadata, "utf8");
  const token = (await loadPendingCredentialSecret(f.fresh)).token;
  await verifyOwnerDevice(f.fresh);
  await writeFile(paths.pendingMetadata, pendingMetadata, { mode: 0o600 });
  f.calls = [];
  return { f, request, paths, pendingMetadata, token };
}

test("metadata-only promotion leftovers can be inspected without mutation and are cleaned only after full Owner verification", async (t) => {
  const { f, request, paths, pendingMetadata, token } = await promotionWithLeftoverMetadata(t);
  const inspected = await inspectOwnerDeviceRequest(f.fresh);
  assert.deepEqual(inspected.pairing_request, request);
  assert.equal(inspected.credential.state, "current");
  assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
  assert.equal(f.calls.length, 0);
  const verified = await verifyOwnerDevice(f.fresh);
  assert.equal(verified.verification.ok, true);
  assert.equal(verified.credential.credential_id, request.credential_id);
  assert.deepEqual(f.calls.map((call) => call.path), ["/.well-known/cfkanban-instance.json", "/api/v1/meta", "/api/v1/me"]);
  assert.equal(await pathType(paths.pendingMetadata), "missing");
  assert.equal(await pathType(paths.pendingSecret), "missing");
  assert.equal((await loadCurrentCredentialSecret(f.fresh)).token, token);
  assert.equal(JSON.stringify({ inspected, verified }).includes(token), false);
  assert.equal((await verifyOwnerDevice(f.fresh)).verification.ok, true);
});

test("generic verification preserves metadata-only leftovers on origin, Owner, identity and authentication failures", async (t) => {
  const { f, paths, pendingMetadata, token, request } = await promotionWithLeftoverMetadata(t);
  f.discoveryOverride = { instance_id: randomUUID() };
  await rejectsCode(() => verifyPendingCredential(f.fresh), "DISCOVERY_INSTANCE_MISMATCH");
  assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
  f.discoveryOverride = null;
  for (const override of [{ is_owner: false }, { principal_id: randomUUID() }, { credential: { id: randomUUID(), fingerprint: `cfk_v1_${request.token_prefix}_…` } }, { credential: { id: request.credential_id, fingerprint: "wrong" } }]) {
    f.meOverride = override;
    await rejectsCode(() => verifyPendingCredential(f.fresh), "CREDENTIAL_VERIFICATION_MISMATCH");
    assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
  }
  f.meOverride = null; f.metaOverride = { observed_origin: "https://other.invalid" };
  await rejectsCode(() => verifyPendingCredential(f.fresh), "CREDENTIAL_VERIFICATION_MISMATCH");
  assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
  f.metaOverride = null; f.credentials.get(request.credential_id).revoked_at = "revoked";
  const failure = await verifyPendingCredential(f.fresh);
  assert.equal(failure.verification.ok, false);
  assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
  assert.equal(JSON.stringify(failure).includes(token), false);
  f.credentials.get(request.credential_id).revoked_at = null;
  assert.equal((await verifyPendingCredential(f.fresh)).verification.ok, true);
  assert.equal(await pathType(paths.pendingMetadata), "missing");
});

test("metadata-only promotion recovery requires a complete current slot matching every device identity field", async (t) => {
  const { f, paths, pendingMetadata } = await promotionWithLeftoverMetadata(t);
  const currentRaw = await readFile(paths.currentMetadata, "utf8"), secretRaw = await readFile(paths.currentSecret, "utf8");
  const cases = [
    (value) => { value.instance_id = value.owner_device_request.instance_id = randomUUID(); },
    (value) => { value.principal_id = value.owner_device_request.principal_id = randomUUID(); },
    (value) => { value.credential_id = value.owner_device_request.credential_id = randomUUID(); },
    (value) => { value.operation_id = value.owner_device_request.operation_id = randomUUID(); },
    (value) => { value.idempotency_key = value.owner_device_request.idempotency_key = randomUUID(); },
    (value) => { value.purpose = "owner_bootstrap"; },
    (value) => { value.state = "pending"; },
    (value) => { value.credential_id_binding = "server_assigned"; },
    (value) => { value.fingerprint = "wrong"; },
    (value) => { value.owner_device_request.device_name = "Different request"; },
  ];
  for (const mutate of cases) {
    const current = JSON.parse(currentRaw); mutate(current);
    await writeFile(paths.currentMetadata, JSON.stringify(current), { mode: 0o600 });
    for (const action of [inspectOwnerDeviceRequest, verifyOwnerDevice, verifyPendingCredential]) {
      await assert.rejects(() => action(f.fresh));
      assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
    }
  }
  await writeFile(paths.currentMetadata, currentRaw, { mode: 0o600 });
  for (const [file, raw] of [[paths.currentMetadata, currentRaw], [paths.currentSecret, secretRaw]]) {
    await rm(file);
    await rejectsCode(() => verifyOwnerDevice(f.fresh), "STATE_PATH_INVALID");
    assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
    await writeFile(file, raw, { mode: 0o600 });
  }
  assert.equal(f.calls.length, 0);
});

test("failed leftover cleanup is retryable without replacing the current secret or bypassing verification", async (t) => {
  const { f, paths, pendingMetadata, token } = await promotionWithLeftoverMetadata(t);
  const originalRm = fsPromises.rm;
  const mocked = t.mock.method(fsPromises, "rm", async (file, options) => {
    if (file === paths.pendingMetadata) throw Object.assign(new Error("simulated cleanup failure"), { code: "EACCES" });
    return originalRm(file, options);
  });
  syncBuiltinESMExports();
  try { await rejectsCode(() => verifyOwnerDevice(f.fresh), "EACCES"); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(paths.pendingMetadata, "utf8"), pendingMetadata);
  assert.equal((await loadCurrentCredentialSecret(f.fresh)).token, token);
  f.calls = [];
  assert.equal((await verifyPendingCredential(f.fresh)).verification.ok, true);
  assert.deepEqual(f.calls.map((call) => call.path), ["/.well-known/cfkanban-instance.json", "/api/v1/meta", "/api/v1/me"]);
  assert.equal(await pathType(paths.pendingMetadata), "missing");
});

test("saved operation corruption is rejected and Owner device pagination forwards an encoded cursor", async (t) => {
  const f = await fixture(t), request = await f.prepare(); await approveOwnerDevice({ ...f.old, request });
  const paths = getInstancePaths(f.old), file = path.join(paths.credentialsRoot, `owner-device-operation-${hash(request.idempotency_key)}.json`);
  const operation = JSON.parse(await readFile(file)); operation.body.device_name = "Mutated";
  await writeFile(file, JSON.stringify(operation), { mode: 0o600 });
  await rejectsCode(() => approveOwnerDevice({ ...f.old, request }), "STATE_OPERATION_CONFLICT");
  const cursor = "opaque+/=cursor";
  await listOwnerDevices({ ...f.old, cursor });
  assert.equal(new URLSearchParams(f.calls.at(-1).search).get("cursor"), cursor);
  assert.equal(f.writes, 1);
});


test("generic pending verification delegates Owner devices to discovery and authenticated meta checks", async (t) => {
  const f = await fixture(t), request = await f.prepare(); await approveOwnerDevice({ ...f.old, request });
  f.metaOverride = { instance_id: randomUUID() }; f.calls = [];
  await rejectsCode(() => verifyPendingCredential(f.fresh), "CREDENTIAL_VERIFICATION_MISMATCH");
  assert.deepEqual(f.calls.map((call) => call.path), ["/.well-known/cfkanban-instance.json", "/api/v1/meta"]);
  assert.equal((await loadPendingCredentialSecret(f.fresh)).metadata.state, "pending");
  f.metaOverride = null;
  assert.equal((await verifyPendingCredential(f.fresh)).credential.state, "current");
});

test("trimmed empty device names fail before state creation or network access", async (t) => {
  const f = await fixture(t);
  for (const deviceName of ["", "   ", "\t\n", "\u3000\u00a0"]) await rejectsCode(() => prepareOwnerDevice({ ...f.fresh, deviceName }), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
  assert.equal(await pathType(f.fresh.stateRoot), "missing");
});

test("schema support uses public health before creating a secret and authenticated meta before approval", async (t) => {
  const f = await fixture(t), paths = getInstancePaths(f.fresh);
  f.healthOverride = { schema_version: 11 };
  await rejectsCode(() => f.prepare(), "OWNER_DEVICE_UPGRADE_REQUIRED");
  assert.equal(await pathType(paths.pendingSecret), "missing");
  assert.equal(await pathType(paths.instanceMetadata), "missing");
  assert.equal(f.calls.every((call) => !call.hasAuth), true);
  f.healthOverride = { schema_version: undefined };
  await rejectsCode(() => f.prepare(), "OWNER_DEVICE_SCHEMA_UNVERIFIED");
  assert.equal(await pathType(paths.pendingSecret), "missing");
  f.healthOverride = null;
  const request = await f.prepare(), pending = await loadPendingCredentialSecret(f.fresh);
  f.metaOverride = { schema_version: 11 }; f.calls = [];
  await rejectsCode(() => approveOwnerDevice({ ...f.old, request }), "OWNER_DEVICE_UPGRADE_REQUIRED");
  assert.equal(f.calls.some((call) => call.method === "POST"), false);
  assert.equal(f.writes, 0);
  assert.equal((await loadPendingCredentialSecret(f.fresh)).token, pending.token);
});


test("definitive CAS rejection refreshes only the attempt key/version, preserving the pairing request and pending secret", async (t) => {
  const f = await fixture(t), request = await f.prepare(), secret = (await loadPendingCredentialSecret(f.fresh)).token;
  f.beforeMutation = () => { f.version++; };
  const rejected = await approveOwnerDevice({ ...f.old, request });
  assert.equal(rejected.operation.error.code, "VERSION_CONFLICT");
  assert.equal(rejected.retry_with_fresh_version, true);
  assert.equal(rejected.next_action, "retry_same_command_to_refresh_version");
  assert.equal(f.writes, 0);
  f.loseResponse = true;
  const uncertainRetry = await approveOwnerDevice({ ...f.old, request });
  assert.equal(uncertainRetry.operation.ok, false);
  assert.equal(uncertainRetry.attempt_replanned, true);
  assert.equal(uncertainRetry.retry_with_fresh_version, false);
  const recovered = await approveOwnerDevice({ ...f.old, request });
  assert.equal(recovered.operation.ok, true);
  assert.equal(recovered.attempt_replanned, false);
  const attempts = f.calls.filter((call) => call.method === "POST");
  assert.deepEqual(attempts.map((call) => JSON.parse(call.body).expected_version), [1, 2, 2]);
  assert.notEqual(attempts[0].key, attempts[1].key);
  assert.equal(attempts[1].key, attempts[2].key);
  assert.equal(attempts[1].body, attempts[2].body);
  assert.deepEqual((await inspectOwnerDeviceRequest(f.fresh)).pairing_request, request);
  assert.equal((await loadPendingCredentialSecret(f.fresh)).token, secret);
  assert.equal(f.writes, 1);
  assert.equal((await verifyOwnerDevice(f.fresh)).credential.state, "current");
});

test("single-device revoke can recover a definitive CAS rejection with a new attempt while using the original command input", async (t) => {
  const f = await fixture(t), request = await f.prepare(); await approveOwnerDevice({ ...f.old, request });
  const command = { ...f.old, credentialId: request.credential_id, idempotencyKey: randomUUID() }; f.calls = [];
  f.beforeMutation = () => { f.version++; };
  const rejected = await revokeOwnerDevice(command);
  assert.equal(rejected.operation.error.code, "VERSION_CONFLICT"); assert.equal(rejected.retry_with_fresh_version, true);
  assert.equal(f.credentials.get(request.credential_id).revoked_at, null);
  f.loseResponse = true;
  assert.equal((await revokeOwnerDevice(command)).operation.ok, false);
  assert.equal((await revokeOwnerDevice(command)).operation.ok, true);
  const attempts = f.calls.filter((call) => call.method === "POST");
  assert.deepEqual(attempts.map((call) => JSON.parse(call.body).expected_version), [2, 3, 3]);
  assert.notEqual(attempts[0].key, attempts[1].key); assert.equal(attempts[1].key, attempts[2].key);
  assert.equal(f.writes, 2); assert.equal(f.credentials.get(f.oldId).revoked_at, null);
});

test("unverified conflict responses cannot refresh a frozen CAS or idempotency key", async (t) => {
  const f = await fixture(t), request = await f.prepare();
  f.beforeMutation = () => { f.version++; return json({ code: "VERSION_CONFLICT", source: "service" }, 409); };
  const unknown = await approveOwnerDevice({ ...f.old, request });
  assert.equal(unknown.retry_with_fresh_version, false);
  assert.equal(unknown.operation.error.details.normalized_by, "client");
  const rejection = await approveOwnerDevice({ ...f.old, request });
  assert.equal(rejection.operation.error.code, "VERSION_CONFLICT");
  const attempts = f.calls.filter((call) => call.method === "POST");
  assert.equal(attempts[0].key, attempts[1].key); assert.equal(attempts[0].body, attempts[1].body);
  assert.equal((await approveOwnerDevice({ ...f.old, request })).operation.ok, true);
  assert.equal(f.writes, 1);
});
