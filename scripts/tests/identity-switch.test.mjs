import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fsPromises, { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareOwnerDevice, restorePreviousOwnerDeviceIdentity, verifyOwnerDevice } from "../../packages/skill-runtime/src/owner-devices.mjs";
import { clearPendingCredential, createPendingCredential, getInstancePaths, inspectInstanceState, loadCurrentCredentialSecret,
  loadPendingCredentialSecret, promotePendingCredential, putInstanceMetadata } from "../../packages/skill-runtime/src/state.mjs";
import { redeemInvitation, redeemPublicJoin, rotateOwnerCredential, verifyPendingCredential } from "../../packages/skill-runtime/src/credential-operations.mjs";
import { pathType } from "../../packages/skill-runtime/src/utils.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const rejectsCode = (fn, code) => assert.rejects(fn, (error) => error.code === code);

// Every secret and network response belongs to a disposable private home and
// an in-memory instance; these tests cannot reach a real deployment.
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban-identity-switch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const instanceId = randomUUID(), owner = randomUUID(), member = randomUUID(), origin = "https://identity-switch.invalid";
  const input = { home, stateRoot: path.join(home, ".cfkanban"), persistenceConfirmed: true, instanceId };
  const f = { ...input, owner, member, origin, credentials: new Map(), calls: [], meOverride: null, metaOverride: null, discoveryOverride: null, onMe: null };
  const base = () => ({ instance_id: instanceId, observed_origin: origin, preferred_api_origin: origin, origin_version: 1, service_version: "0.1.0", schema_version: 12 });
  f.fetchImpl = async (url, options) => {
    const parsed = new URL(url), token = new Headers(options.headers).get("authorization")?.replace(/^Bearer /, "");
    assert.equal(parsed.origin, origin); assert.equal(options.redirect, "manual"); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.method, "GET");
    f.calls.push({ path: parsed.pathname, authenticated: Boolean(token) });
    if (parsed.pathname === "/.well-known/cfkanban-instance.json") return json({ ...base(), discovery_version: 1, ...f.discoveryOverride });
    if (parsed.pathname === "/healthz") return json({ ...base(), d1: "reachable" });
    const credential = [...f.credentials.values()].find((entry) => entry.token_digest === digest(token ?? "") && !entry.revoked);
    if (!credential) return json({}, 401);
    const isOwner = credential.principal_id === owner;
    if (parsed.pathname === "/api/v1/meta") return json({ ...base(), principal: { id: credential.principal_id, is_owner: isOwner }, ...f.metaOverride });
    assert.equal(parsed.pathname, "/api/v1/me");
    if (f.onMe) await f.onMe(credential);
    return json({ id: credential.principal_id, principal_id: credential.principal_id, is_owner: isOwner, version: 1,
      credential: { id: credential.credential_id, fingerprint: credential.fingerprint },
      management_grants: isOwner ? [] : [{ project_id: randomUUID() }], ...f.meOverride });
  };
  await putInstanceMetadata({ ...input, trustedApiOrigin: origin });
  const memberMetadata = await createPendingCredential({ ...input, principalId: member, credentialId: randomUUID(), purpose: "principal_bootstrap" });
  await promotePendingCredential({ ...input, principalId: member, credentialId: memberMetadata.credential_id, fingerprint: memberMetadata.fingerprint });
  f.credentials.set(memberMetadata.credential_id, memberMetadata);
  f.original = await loadCurrentCredentialSecret(input);
  f.paths = getInstancePaths(input);
  f.prepareInput = { ...input, fetchImpl: f.fetchImpl, apiOrigin: origin, ownerPrincipalId: owner, deviceName: "开发环境", operationId: randomUUID(), idempotencyKey: randomUUID(),
    replaceCurrent: true, expectedCurrentPrincipalId: member, expectedCurrentCredentialId: memberMetadata.credential_id };
  f.verifyInput = { ...input, fetchImpl: f.fetchImpl };
  f.prepare = async () => {
    const prepared = await prepareOwnerDevice(f.prepareInput);
    const pending = await loadPendingCredentialSecret(input);
    f.ownerCredential = pending;
    return prepared;
  };
  f.approve = () => f.credentials.set(f.ownerCredential.metadata.credential_id, f.ownerCredential.metadata);
  f.switch = async () => { await f.prepare(); f.approve(); return verifyOwnerDevice(f.verifyInput); };
  f.restoreInput = () => ({ ...f.verifyInput, expectedCurrentPrincipalId: owner, expectedCurrentCredentialId: f.ownerCredential.metadata.credential_id });
  return f;
}

function assertNoSecrets(value, f) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(f.original.token), false);
  if (f.ownerCredential) assert.equal(text.includes(f.ownerCredential.token), false);
}

test("explicit scoped-administrator to Owner replacement preserves a recoverable independent old identity", async (t) => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  assert.equal(await pathType(f.paths.previousSecret), "missing");
  assert.notEqual(f.ownerCredential.token, f.original.token);
  f.approve();
  const switched = await verifyPendingCredential(f.verifyInput);
  assert.equal(switched.verification.is_owner, true);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.ownerCredential.token);
  assert.equal((await read(f.paths.previousSecret)).token, f.original.token);
  assert.equal((await read(f.paths.previousMetadata)).principal_id, f.member);
  assert.equal(f.credentials.size, 2);
  const inspected = await inspectInstanceState(f);
  assert.equal(inspected.credential.previous.credential_id, f.original.metadata.credential_id);
  assert.equal(inspected.identity_switch.phase, "complete");
  assertNoSecrets({ prepared, switched, inspected, journal: await read(f.paths.identitySwitch) }, f);
});

test("existing identities require explicit replacement and exact current IDs; generic preparation retains its identity guard", async (t) => {
  const f = await fixture(t);
  await rejectsCode(() => prepareOwnerDevice({ ...f.prepareInput, replaceCurrent: false }), "STATE_CURRENT_CONFLICT");
  await rejectsCode(() => prepareOwnerDevice({ ...f.prepareInput, expectedCurrentPrincipalId: randomUUID() }), "STATE_CURRENT_CONFLICT");
  await rejectsCode(() => prepareOwnerDevice({ ...f.prepareInput, expectedCurrentCredentialId: randomUUID() }), "STATE_CURRENT_CONFLICT");
  await rejectsCode(() => createPendingCredential({ ...f, principalId: f.owner, purpose: "owner_device", replaceCurrent: true }), "STATE_IDENTITY_CONFLICT");
  assert.equal(f.calls.length, 0);
  assert.equal(await pathType(f.paths.pendingSecret), "missing");
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
});

test("same-Principal replacement cannot bypass previous preservation through generic promotion or Owner rotation", async (t) => {
  const f = await fixture(t);
  await prepareOwnerDevice({ ...f.prepareInput, ownerPrincipalId: f.member });
  const pending = await loadPendingCredentialSecret(f);
  await rejectsCode(() => promotePendingCredential({ ...f, principalId: f.member, credentialId: pending.metadata.credential_id, fingerprint: pending.metadata.fingerprint }), "OWNER_DEVICE_REPLACEMENT_REQUIRED");
  f.calls = [];
  await rejectsCode(() => rotateOwnerCredential(f.verifyInput), "STATE_PENDING_CONFLICT");
  await rejectsCode(() => redeemInvitation({ ...f.verifyInput, inviteCode: "isolated-recovery-invite", redeemAs: "recovery" }), "OWNER_DEVICE_REPLACEMENT_REQUIRED");
  await rejectsCode(() => redeemPublicJoin({ ...f.verifyInput, publicId: randomUUID(), role: "writer", redeemAs: "new_principal", displayName: "IsolatedMember" }), "OWNER_DEVICE_REPLACEMENT_REQUIRED");
  assert.equal(f.calls.length, 0);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  assert.equal((await loadPendingCredentialSecret(f)).token, pending.token);
  assert.equal(await pathType(f.paths.previousSecret), "missing");
});

test("failed approval verification preserves old current and pending without creating previous or a switch transaction", async (t) => {
  const f = await fixture(t); await f.prepare();
  assert.equal((await verifyOwnerDevice(f.verifyInput)).verification.ok, false);
  f.approve(); f.meOverride = { principal_id: randomUUID() };
  await rejectsCode(() => verifyOwnerDevice(f.verifyInput), "CREDENTIAL_VERIFICATION_MISMATCH");
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  assert.equal((await loadPendingCredentialSecret(f)).token, f.ownerCredential.token);
  assert.equal(await pathType(f.paths.previousSecret), "missing");
  assert.equal(await pathType(f.paths.identitySwitch), "missing");
});

test("current metadata drift after preparation invalidates the explicit replacement without overwriting pending", async (t) => {
  const f = await fixture(t); await f.prepare(); f.approve();
  const current = await read(f.paths.currentMetadata); current.operation_id = randomUUID();
  await writeFile(f.paths.currentMetadata, JSON.stringify(current), { mode: 0o600 });
  await rejectsCode(() => verifyOwnerDevice(f.verifyInput), "STATE_CURRENT_CONFLICT");
  await rejectsCode(() => f.prepare(), "STATE_CURRENT_CONFLICT");
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  assert.equal((await loadPendingCredentialSecret(f)).token, f.ownerCredential.token);
  assert.equal(await pathType(f.paths.previousSecret), "missing");
});

test("previous and pending conflicts never overwrite either identity or create another secret", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.previousSecret, JSON.stringify({ schema_version: 1, token: f.original.token }), { mode: 0o600 });
  await rejectsCode(() => f.prepare(), "STATE_PREVIOUS_CONFLICT");
  assert.equal(await pathType(f.paths.pendingSecret), "missing");
  await rm(f.paths.previousSecret);
  await createPendingCredential({ ...f, principalId: f.member, purpose: "principal_recovery" });
  const pending = await loadPendingCredentialSecret(f);
  await rejectsCode(() => f.prepare(), "STATE_PENDING_CONFLICT");
  assert.equal((await loadPendingCredentialSecret(f)).token, pending.token);
});

test("restoration swaps the two independent identities and the same expected-current request is idempotent", async (t) => {
  const f = await fixture(t); await f.switch();
  const restored = await restorePreviousOwnerDeviceIdentity(f.restoreInput());
  assert.equal(restored.verification.is_owner, false);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  assert.equal((await read(f.paths.previousSecret)).token, f.ownerCredential.token);
  const journal = await readFile(f.paths.identitySwitch, "utf8");
  const retry = await restorePreviousOwnerDeviceIdentity(f.restoreInput());
  assert.equal(retry.identity_switch.resumed, true);
  assert.equal(await readFile(f.paths.identitySwitch, "utf8"), journal);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  const ownerRestored = await restorePreviousOwnerDeviceIdentity({ ...f.verifyInput, expectedCurrentPrincipalId: f.member, expectedCurrentCredentialId: f.original.metadata.credential_id });
  assert.equal(ownerRestored.verification.is_owner, true);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.ownerCredential.token);
  assert.equal(f.credentials.size, 2);
  assertNoSecrets({ restored, retry, ownerRestored, journal: await read(f.paths.identitySwitch) }, f);
});

test("restoration rejects revoked, wrong-instance and wrong-fingerprint previous identity without modifying current", async (t) => {
  const f = await fixture(t); await f.switch();
  const before = await readFile(f.paths.identitySwitch, "utf8");
  f.credentials.get(f.original.metadata.credential_id).revoked = true;
  assert.equal((await restorePreviousOwnerDeviceIdentity(f.restoreInput())).verification.ok, false);
  f.credentials.get(f.original.metadata.credential_id).revoked = false;
  f.metaOverride = { instance_id: randomUUID() };
  await rejectsCode(() => restorePreviousOwnerDeviceIdentity(f.restoreInput()), "CREDENTIAL_VERIFICATION_MISMATCH");
  f.metaOverride = null; f.meOverride = { credential: { id: f.original.metadata.credential_id, fingerprint: "wrong" } };
  await rejectsCode(() => restorePreviousOwnerDeviceIdentity(f.restoreInput()), "CREDENTIAL_VERIFICATION_MISMATCH");
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.ownerCredential.token);
  assert.equal((await read(f.paths.previousSecret)).token, f.original.token);
  assert.equal(await readFile(f.paths.identitySwitch, "utf8"), before);
});

test("restoration requires exact current IDs, a vacant pending slot and the saved trusted origin", async (t) => {
  const f = await fixture(t); await f.switch();
  await rejectsCode(() => restorePreviousOwnerDeviceIdentity({ ...f.restoreInput(), expectedCurrentCredentialId: randomUUID() }), "STATE_CURRENT_CONFLICT");
  await createPendingCredential({ ...f, principalId: f.owner, purpose: "owner_rotation" });
  await rejectsCode(() => restorePreviousOwnerDeviceIdentity(f.restoreInput()), "STATE_PENDING_CONFLICT");
  await clearPendingCredential({ ...f, committedStateKnownFalse: true });
  const previous = await read(f.paths.previousMetadata);
  previous.identity_restore.origin_version++;
  await writeFile(f.paths.previousMetadata, JSON.stringify(previous), { mode: 0o600 });
  await rejectsCode(() => restorePreviousOwnerDeviceIdentity(f.restoreInput()), "STATE_INSTANCE_CONFLICT");
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.ownerCredential.token);
});

test("previous permission and symlink drift fail before any authenticated restore read", async (t) => {
  const f = await fixture(t); await f.switch(); f.calls = [];
  await chmod(f.paths.previousSecret, 0o644);
  await rejectsCode(() => restorePreviousOwnerDeviceIdentity(f.restoreInput()), "STATE_PERMISSION_DRIFT");
  await chmod(f.paths.previousSecret, 0o600);
  const raw = await readFile(f.paths.previousMetadata);
  await rm(f.paths.previousMetadata); await symlink(f.paths.currentMetadata, f.paths.previousMetadata);
  await rejectsCode(() => restorePreviousOwnerDeviceIdentity(f.restoreInput()), "STATE_SYMLINK_REJECTED");
  await rm(f.paths.previousMetadata); await writeFile(f.paths.previousMetadata, raw, { mode: 0o600 });
  assert.equal(f.calls.length, 0);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.ownerCredential.token);
});

async function interrupted(action, paths, event, count = 1) {
  const method = event.startsWith("remove:") ? "rm" : "rename";
  const target = paths[event.slice(event.indexOf(":") + 1)], original = fsPromises[method];
  let seen = 0, injected = false;
  fsPromises[method] = async (...args) => {
    if ((method === "rename" ? args[1] : args[0]) === target && ++seen === count) { injected = true; throw new Error("injected identity transition interruption"); }
    return original(...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(action, /injected identity transition interruption/); }
  finally { fsPromises[method] = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
}

for (const [event, count] of [
  ["write:previousMetadata", 1], ["write:currentSecret", 1], ["write:currentMetadata", 1],
  ["remove:pendingSecret", 1], ["remove:pendingMetadata", 1], ["write:identitySwitch", 2],
]) test(`Owner promotion resumes after ${event} without losing either Credential`, async (t) => {
  const f = await fixture(t); await f.prepare(); f.approve();
  await interrupted(() => verifyOwnerDevice(f.verifyInput), f.paths, event, count);
  await rejectsCode(() => loadCurrentCredentialSecret(f), "IDENTITY_SWITCH_INCOMPLETE");
  await rejectsCode(() => clearPendingCredential({ ...f, committedStateKnownFalse: true }), "IDENTITY_SWITCH_INCOMPLETE");
  await rejectsCode(() => createPendingCredential({ ...f, principalId: f.owner }), "IDENTITY_SWITCH_INCOMPLETE");
  const resumed = await verifyOwnerDevice(f.verifyInput);
  assert.equal(resumed.identity_switch.resumed, true);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.ownerCredential.token);
  assert.equal((await read(f.paths.previousSecret)).token, f.original.token);
  assert.equal(await pathType(f.paths.pendingSecret), "missing");
  assert.equal(await pathType(f.paths.pendingMetadata), "missing");
  assertNoSecrets({ resumed, journal: await read(f.paths.identitySwitch) }, f);
});

for (const [event, count] of [
  ["write:pendingMetadata", 1], ["write:currentSecret", 1], ["write:currentMetadata", 1],
  ["write:previousSecret", 1], ["write:previousMetadata", 1], ["remove:pendingSecret", 1],
  ["remove:pendingMetadata", 1], ["write:identitySwitch", 2],
]) test(`previous-identity restoration resumes after ${event} and never repeats the swap`, async (t) => {
  const f = await fixture(t); await f.switch();
  await interrupted(() => restorePreviousOwnerDeviceIdentity(f.restoreInput()), f.paths, event, count);
  await rejectsCode(() => loadCurrentCredentialSecret(f), "IDENTITY_SWITCH_INCOMPLETE");
  await rejectsCode(() => verifyOwnerDevice(f.verifyInput), "IDENTITY_SWITCH_INCOMPLETE");
  const restored = await restorePreviousOwnerDeviceIdentity(f.restoreInput());
  assert.equal(restored.identity_switch.resumed, true);
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  assert.equal((await read(f.paths.previousSecret)).token, f.ownerCredential.token);
  await restorePreviousOwnerDeviceIdentity(f.restoreInput());
  assert.equal((await loadCurrentCredentialSecret(f)).token, f.original.token);
  assert.equal(await pathType(f.paths.pendingSecret), "missing");
  assert.equal(await pathType(f.paths.pendingMetadata), "missing");
  assertNoSecrets({ restored, journal: await read(f.paths.identitySwitch) }, f);
});

test("resuming an interrupted switch revalidates the exact remote target and refuses unbound local files", async (t) => {
  const f = await fixture(t); await f.prepare(); f.approve();
  await interrupted(() => verifyOwnerDevice(f.verifyInput), f.paths, "write:currentMetadata");
  f.credentials.get(f.ownerCredential.metadata.credential_id).revoked = true;
  const before = await readFile(f.paths.currentMetadata, "utf8");
  assert.equal((await verifyOwnerDevice(f.verifyInput)).verification.ok, false);
  assert.equal(await readFile(f.paths.currentMetadata, "utf8"), before);
  f.credentials.get(f.ownerCredential.metadata.credential_id).revoked = false;
  const altered = await read(f.paths.currentMetadata); altered.principal_id = randomUUID();
  await writeFile(f.paths.currentMetadata, JSON.stringify(altered), { mode: 0o600 });
  await rejectsCode(() => verifyOwnerDevice(f.verifyInput), "IDENTITY_SWITCH_STATE_CONFLICT");
  assert.equal((await read(f.paths.previousSecret)).token, f.original.token);
});

test("the shared write lock excludes independent ordinary Credential operations during verification", async (t) => {
  const f = await fixture(t); await f.prepare(); f.approve();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.onMe = async () => { entered(); await gate; };
  const verification = verifyOwnerDevice(f.verifyInput);
  await started;
  try {
    await rejectsCode(() => createPendingCredential({ ...f, principalId: f.member }), "OWNER_DEVICE_LOCKED");
    await rejectsCode(() => clearPendingCredential({ ...f, committedStateKnownFalse: true }), "OWNER_DEVICE_LOCKED");
    await rejectsCode(() => loadCurrentCredentialSecret(f), "OWNER_DEVICE_LOCKED");
  } finally { release(); }
  assert.equal((await verification).verification.ok, true);
});
