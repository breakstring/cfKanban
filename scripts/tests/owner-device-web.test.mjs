import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  approveOwnerDeviceAttempt, isOwnerDeviceList, isOwnerDeviceWriteResult, OwnerDeviceInputError,
  ownerDeviceIdentity, ownerDeviceRetryAllowed, ownerDeviceVersionConflict, parseOwnerDevicePairing,
  revokeOwnerDeviceAttempt,
} from "../../apps/web/src/lib/owner-devices.ts";

const now = Date.parse("2026-09-28T00:00:00.000Z");
const instanceId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333";
const identity = { instanceId, principalId: ownerId, origin: "https://kanban.example", displayName: "Owner", version: 4 };
const request = {
  instance_id: instanceId, principal_id: ownerId, credential_id: credentialId,
  token_prefix: "1234567890abcdef", token_digest: "a".repeat(64), device_name: "My laptop",
  issued_at: new Date(now - 1_000).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
  api_origin: identity.origin, operation_id: "44444444-4444-4444-8444-444444444444", idempotency_key: "owner-pairing-1",
};
const fingerprint = `cfk_v1_${request.token_prefix}_…`;
const device = { id: credentialId, principal_id: ownerId, device_name: request.device_name, fingerprint,
  allowed_actions: ["revoke_owner_device"], issued_at: request.issued_at, last_used_at: null, revoked_at: null };
function parse(value, time = now) { return parseOwnerDevicePairing(JSON.stringify(value), identity, time); }
function fails(value, code = "invalid", time = now) {
  assert.throws(() => parse(value, time), error => error instanceof OwnerDeviceInputError && error.code === code);
}
function result(attempt, overrides = {}) {
  return { event_cursor: "verified-event-cursor", idempotent_replay: false, resource: {
    id: credentialId, principal_id: ownerId, fingerprint, device_name: request.device_name,
    principal_version: attempt.body.expected_version + 1, revoked_at: null, ...overrides,
  } };
}

test("pairing accepts the exact public envelope and rejects secrets or unknown fields", () => {
  assert.deepEqual(parse(request), request);
  for (const value of [null, [], { ...request, secret: "sensitive" }, { pairing_request: request }, { ...request, expected_version: 1 }]) fails(value);
  const { token_digest: ignored, ...missing } = request;
  fails(missing);
  fails({ ...request, device_name: "cfk_v1_1234567890abcdef_" + "x".repeat(43) });
  fails({ ...request, idempotency_key: "cfk_v1_1234567890abcdef_" + "x".repeat(43) });
  const encodedSecret = JSON.stringify({ ...request, idempotency_key: "cfk_v1_1234567890abcdef_" + "x".repeat(43) }).replace("cfk_v1_", "\\u0063fk_v1_");
  assert.throws(() => parseOwnerDevicePairing(encodedSecret, identity, now), OwnerDeviceInputError);
  fails({ ...request, idempotency_key: "bad\nkey" });
  fails({ ...request, credential_id: "33333333-3333-5333-8333-333333333333" });
  fails({ ...request, token_digest: "abcd" });
  fails({ ...request, device_name: "\u202elaptop" });
  fails({ ...request, device_name: " laptop " });
  fails({ ...request, device_name: "机".repeat(81) });
  assert.equal(parse({ ...request, device_name: "机".repeat(80) }).device_name.length, 80);
});

test("pairing binds the exact origin, instance, Owner and bounded validity interval", () => {
  for (const [key, value] of [["instance_id", credentialId], ["principal_id", credentialId], ["api_origin", "https://other.example"]]) fails({ ...request, [key]: value }, "target");
  for (const origin of ["https://kanban.example/", "http://kanban.example", "https://user@kanban.example", "https://kanban.example/path"]) fails({ ...request, api_origin: origin });
  fails({ ...request, expires_at: new Date(now).toISOString() }, "expired");
  fails({ ...request, issued_at: new Date(now + 1).toISOString() }, "expired");
  fails({ ...request, expires_at: new Date(now + 3_600_000).toISOString() });
  fails({ ...request, issued_at: "2026-09-28T00:00:00Z" });
});

test("fresh Cookie identity verification does not require a bearer credential", () => {
  const meta = { instance_id: instanceId, observed_origin: identity.origin, preferred_api_origin: identity.origin, principal: { id: ownerId, is_owner: true } };
  const me = { id: ownerId, principal_id: ownerId, display_name: "Owner", version: 4, is_owner: true, credential: null };
  assert.deepEqual(ownerDeviceIdentity(meta, me, identity.origin, ownerId), identity);
  for (const override of [{ is_owner: false }, { principal_id: credentialId }, { version: 0 }, { version: 1.5 }]) {
    assert.throws(() => ownerDeviceIdentity(meta, { ...me, ...override }, identity.origin, ownerId), OwnerDeviceInputError);
  }
  assert.throws(() => ownerDeviceIdentity({ ...meta, preferred_api_origin: "https://other.example" }, me, identity.origin, ownerId), OwnerDeviceInputError);
  assert.throws(() => ownerDeviceIdentity({ ...meta, principal: { id: credentialId, is_owner: true } }, me, identity.origin, ownerId), OwnerDeviceInputError);
});

test("device pages require matching Owner rows and keep pagination explicit", () => {
  assert.equal(isOwnerDeviceList({ items: [device], has_more: true, next_cursor: "next" }, ownerId), true);
  assert.equal(isOwnerDeviceList({ items: [device], has_more: true, next_cursor: null }, ownerId), false);
  assert.equal(isOwnerDeviceList({ items: [{ ...device, principal_id: credentialId }], has_more: false, next_cursor: null }, ownerId), false);
  assert.equal(isOwnerDeviceList({ items: [{ ...device, device_name: null, revoked_at: request.issued_at, allowed_actions: [] }], has_more: false, next_cursor: null }, ownerId), true);
});

test("approval freezes exact body/key and remains retryable after pairing expiry within the write retry window", () => {
  const attempt = approveOwnerDeviceAttempt(request, identity, request.idempotency_key, now);
  assert.equal(attempt.key, request.idempotency_key);
  assert.equal(attempt.body.expected_version, 4);
  assert.equal(Object.keys(attempt.body).length, 9);
  assert.equal("api_origin" in attempt.body, false);
  assert.equal(Object.isFrozen(attempt), true);
  assert.equal(Object.isFrozen(attempt.body), true);
  assert.throws(() => { attempt.body.expected_version = 9; }, TypeError);
  assert.equal(ownerDeviceRetryAllowed(attempt, now + 120_000), true);
  assert.equal(ownerDeviceRetryAllowed(attempt, now + 24 * 60 * 60 * 1000), false);
  assert.throws(() => approveOwnerDeviceAttempt(request, identity, "new", now + 120_000), OwnerDeviceInputError);
});

test("only verified version conflict permits a new confirmed attempt with a fresh version", () => {
  const conflict = { status: 409, body: { code: "VERSION_CONFLICT", source: "service", retryable: false, details: {} } };
  assert.equal(ownerDeviceVersionConflict(conflict), true);
  for (const error of [{ ...conflict, status: 503 }, { ...conflict, body: { ...conflict.body, source: "client_transport" } }, { ...conflict, body: { ...conflict.body, details: { normalized_by: "client" } } }, { ...conflict, body: { ...conflict.body, code: "IDEMPOTENCY_KEY_REUSED" } }]) assert.equal(ownerDeviceVersionConflict(error), false);
  const replacement = approveOwnerDeviceAttempt(request, { ...identity, version: 5 }, "new-confirmed-attempt", now);
  assert.equal(replacement.body.expected_version, 5);
  assert.equal(replacement.key, "new-confirmed-attempt");
});

test("malformed or wrong-target write responses cannot turn an uncertain operation into success", () => {
  const attempt = approveOwnerDeviceAttempt(request, identity, request.idempotency_key, now);
  assert.equal(isOwnerDeviceWriteResult(result(attempt), attempt), true);
  for (const override of [{ id: ownerId }, { principal_id: credentialId }, { fingerprint: "wrong" }, { device_name: "other" }, { principal_version: 6 }, { revoked_at: request.issued_at }]) assert.equal(isOwnerDeviceWriteResult(result(attempt, override), attempt), false);
  assert.equal(isOwnerDeviceWriteResult({ ...result(attempt), event_cursor: undefined }, attempt), false);
});

test("revocation uses the dedicated action and route with exact effect verification", () => {
  const attempt = revokeOwnerDeviceAttempt(device, identity, "revoke-1", now);
  assert.equal(attempt.path, `/api/v1/admin/owner-credentials/${credentialId}/revoke`);
  assert.deepEqual(attempt.body, { expected_version: 4 });
  assert.equal(isOwnerDeviceWriteResult(result(attempt, { revoked_at: request.issued_at, revoke_reason: "owner_device_revoke" }), attempt), true);
  assert.equal(isOwnerDeviceWriteResult(result(attempt), attempt), false);
  for (const override of [{ allowed_actions: ["revoke"] }, { allowed_actions: [] }, { revoked_at: request.issued_at }, { principal_id: credentialId }]) assert.throws(() => revokeOwnerDeviceAttempt({ ...device, ...override }, identity, "revoke", now), OwnerDeviceInputError);
});

test("Owner device UI uses shared CSRF transport, guards uncertain navigation and never persists pairing data", async () => {
  const source = await readFile(new URL("../../apps/web/src/components/OwnerDevices.vue", import.meta.url), "utf8");
  assert.match(source, /apiRequest\(attempt\.path, \{ method: "POST", body: attempt\.body, idempotencyKey: attempt\.key/);
  assert.match(source, /registerNavigationGuard/);
  assert.match(source, /beforeunload/);
  assert.match(source, /Return to the Agent on the new computer/);
  assert.match(source, /返回|回到新电脑上的 Agent/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|method: "DELETE"/);
});
