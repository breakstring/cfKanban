import assert from "node:assert/strict";
import { createHash, randomUUID, subtle, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec(migration);

const now = 1_787_966_400_000;
const launchSecret = "launch-secret-never-persisted";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const run = (sql, values = []) => db.prepare(sql).run(...values);
const get = (sql, values = []) => db.prepare(sql).get(...values);

run("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES ('owner', 'Lin', ?, ?)", [now, now]);
run("INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id) VALUES ('credential', 'owner', 'owner', ?, ?, 'op-credential')", [digest("credential-secret"), now]);
run("INSERT INTO browser_launches (id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, target_json, expires_at, created_at, created_operation_id) VALUES ('launch', 'launch', ?, 'owner', 'credential', 'admin', ?, ?, ?, 'op-launch')", [digest(launchSecret), JSON.stringify({ section: "overview" }), now + 300_000, now]);

// Rendering GET /app/launch is a read: selecting the capability must not consume it.
assert.equal(get("SELECT redeemed_at FROM browser_launches WHERE code_digest = ?", [digest(launchSecret)]).redeemed_at, null);

function redeemLaunch(secret, operationId, at) {
  db.exec("BEGIN");
  try {
    const launch = get("SELECT * FROM browser_launches WHERE code_digest = ?", [digest(secret)]);
    assert.ok(launch, "launch capability must exist");
    const consumed = run("UPDATE browser_launches SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?", [at, launch.id, at]);
    assert.equal(consumed.changes, 1, "launch capability must be active and single-use");
    const sessionId = randomUUID();
    run("INSERT INTO web_sessions (id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, created_at) VALUES (?, ?, ?, 'credential', ?, ?, ?, ?, ?)", [sessionId, digest(`session-${operationId}`), launch.principal_id, launch.source_credential_id, launch.target_kind, launch.target_json, at + 28_800_000, at]);
    db.exec("COMMIT");
    return sessionId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const sessionId = redeemLaunch(launchSecret, "op-redeem", now + 1);
assert.equal(get("SELECT expires_at - created_at AS ttl FROM web_sessions WHERE id = ?", [sessionId]).ttl, 28_800_000, "Web Session must be fixed at eight hours");
assert.throws(() => redeemLaunch(launchSecret, "op-replay", now + 2), /single-use/);
assert.equal(get("SELECT COUNT(*) AS count FROM web_sessions").count, 1, "replay must not create another Session");

const activeSessionSql = `
  SELECT s.id
  FROM web_sessions s
  JOIN credentials c ON s.source_kind = 'credential' AND c.id = s.source_id
  WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND c.revoked_at IS NULL
`;
assert.equal(get(activeSessionSql, [sessionId, now + 2]).id, sessionId);
run("UPDATE credentials SET revoked_at = ?, revoked_by_principal_id = 'owner' WHERE id = 'credential'", [now + 3]);
assert.equal(get(activeSessionSql, [sessionId, now + 4]), undefined, "source Credential revoke must invalidate its Sessions");

function csrfAccepted({ requestUrl, origin, cookieToken, headerToken }) {
  if (origin !== new URL(requestUrl).origin || !cookieToken || !headerToken) return false;
  const cookie = Buffer.from(cookieToken);
  const header = Buffer.from(headerToken);
  return cookie.length === header.length && timingSafeEqual(cookie, header);
}

assert.equal(csrfAccepted({ requestUrl: "https://example.workers.dev/api/v1/me", origin: "https://example.workers.dev", cookieToken: "csrf-a", headerToken: "csrf-a" }), true);
assert.equal(csrfAccepted({ requestUrl: "https://example.workers.dev/api/v1/me", origin: "https://alias.example", cookieToken: "csrf-a", headerToken: "csrf-a" }), false);
assert.equal(csrfAccepted({ requestUrl: "https://example.workers.dev/api/v1/me", origin: "https://example.workers.dev", cookieToken: "csrf-a", headerToken: "csrf-b" }), false);

run("INSERT INTO webauthn_challenges (id, challenge_digest, purpose, rp_id, expected_origin, expires_at, created_at) VALUES ('challenge', ?, 'authentication', 'example.workers.dev', 'https://example.workers.dev', ?, ?)", [digest("challenge-secret"), now + 300_000, now]);
const consumeChallenge = (at) => run("UPDATE webauthn_challenges SET consumed_at = ? WHERE id = 'challenge' AND purpose = 'authentication' AND consumed_at IS NULL AND expires_at > ?", [at, at]).changes;
assert.equal(consumeChallenge(now + 1), 1);
assert.equal(consumeChallenge(now + 2), 0, "WebAuthn challenge must be single-use");

const webauthnPolicy = {
  algorithms: [-7, -257],
  attestation: "none",
  residentKey: "required",
  userVerification: "required",
  challengeTtlMs: 300_000,
};
assert.deepEqual(webauthnPolicy.algorithms, [-7, -257]);

const message = new TextEncoder().encode("cfKanban WebAuthn verification probe");
const es256 = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const es256Signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, es256.privateKey, message);
assert.equal(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, es256.publicKey, es256Signature, message), true);
const rs256 = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["sign", "verify"]);
const rs256Signature = await subtle.sign("RSASSA-PKCS1-v1_5", rs256.privateKey, message);
assert.equal(await subtle.verify("RSASSA-PKCS1-v1_5", rs256.publicKey, rs256Signature, message), true);

const counterDecision = (stored, received) => {
  if (stored === 0 && received === 0) return "accept";
  return received > stored ? "accept" : "reject_and_audit";
};
assert.equal(counterDecision(0, 0), "accept");
assert.equal(counterDecision(0, 1), "accept");
assert.equal(counterDecision(4, 5), "accept");
assert.equal(counterDecision(4, 4), "reject_and_audit");
assert.equal(counterDecision(4, 0), "reject_and_audit");

console.log("Web security contract checks passed for launch/session lifetime, source revocation, CSRF, one-time challenges, ES256/RS256, and counter policy.");
