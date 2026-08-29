import assert from "node:assert/strict";
import test from "node:test";

import {
  CSRF_COOKIE_NAME,
  enforceCookieWriteProtection,
  serializeCsrfCookie,
  serializeSessionCookie,
} from "../../apps/worker/src/kernel/csrf.ts";
import { sha256Hex, timingSafeEqual } from "../../apps/worker/src/kernel/crypto.ts";
import { lookupOpaqueResourceId, requireDiscoverable, resolveSqlFragment } from "../../apps/worker/src/kernel/d1.ts";
import { ApiError, errorResponse, platformUnavailable } from "../../apps/worker/src/kernel/errors.ts";
import { canonicalJson, computeRequestHash, validateIdempotencyKey } from "../../apps/worker/src/kernel/idempotency.ts";
import { MAX_JSON_BYTES, readJsonBody, validateJsonObject } from "../../apps/worker/src/kernel/http.ts";
import {
  enforceInstanceRateLimit,
  isRateLimitedDynamicPath,
  isUnauthenticatedSensitivePath,
  recentRateLimitSummary,
} from "../../apps/worker/src/kernel/rate-limit.ts";
import {
  verifyAuthenticationCredentialEqualized,
  verifyRegistrationCredential,
  WebAuthnVerificationError,
} from "../../apps/worker/src/kernel/webauthn.ts";
import {
  base64UrlEncode,
  createAssertionCredential,
  createRegistrationFixture,
} from "./webauthn-fixtures.mjs";

function errorShape(error) {
  return {
    category: error.category,
    code: error.code,
    details: error.details,
    message: error.message,
    recovery: error.recovery,
    retryable: error.retryable,
    status: error.status,
  };
}

test("streaming JSON limit rejects before retaining an oversized body", async () => {
  const encoder = new TextEncoder();
  const secret = `cfk_v1_test_${"s".repeat(43)}`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`{"value":"${secret}`));
      controller.enqueue(new Uint8Array(MAX_JSON_BYTES));
      controller.close();
    },
  });
  const request = new Request("https://kanban.example.test/api/v1/test", {
    body: stream,
    duplex: "half",
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  await assert.rejects(readJsonBody(request), (error) => {
    assert.equal(error.code, "PAYLOAD_TOO_LARGE");
    assert.doesNotMatch(JSON.stringify(errorShape(error)), new RegExp(secret));
    return true;
  });
});

test("malformed JSON, unknown fields, and schema failures share validation errors", async () => {
  const malformed = new Request("https://kanban.example.test/api/v1/test", {
    body: "{broken",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const failures = [];
  try {
    await readJsonBody(malformed);
  } catch (error) {
    failures.push(error);
  }
  for (const action of [
    () => validateJsonObject({ expected: 1, typo: true }, { allowedKeys: ["expected"] }),
    () => validateJsonObject({ expected: "bad" }, {
      allowedKeys: ["expected"],
      validators: { expected: (value) => typeof value === "number" },
    }),
  ]) {
    try {
      action();
    } catch (error) {
      failures.push(error);
    }
  }

  assert.equal(failures.length, 3);
  for (const error of failures) {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.equal(error.category, "validation");
    assert.equal(error.status, 400);
  }
});

test("error envelope keeps Retry-After aligned and redacts unsafe details", async () => {
  const requestId = crypto.randomUUID();
  const secret = `cfk_v1_test_${"z".repeat(43)}`;
  const browserLaunch = `cfl_v1_${"L".repeat(8)}_${"B".repeat(43)}`;
  const error = new ApiError({
    category: "rate_limit",
    code: "RATE_LIMITED",
    details: {
      authorization: `Bearer ${secret}`,
      raw_error: "SELECT token_digest FROM credentials",
      scope: "principal",
      unsafe_value: secret,
      unsafe_launch_value: browserLaunch,
    },
    message: "Too many requests.",
    recovery: "retry_after",
    retryable: true,
    retryAfterSeconds: 7,
    status: 429,
  });
  const response = errorResponse(error, requestId);
  const body = await response.json();

  assert.equal(response.headers.get("x-request-id"), requestId);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(body.request_id, requestId);
  assert.equal(body.retry_after_seconds, 7);
  assert.equal(body.details.scope, "principal");
  assert.equal(body.details.unsafe_value, "[REDACTED]");
  assert.equal(body.details.unsafe_launch_value, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(body), /token_digest|credentials|cf[kl]_v1_/i);
});

test("native rate-limit rejection maps to the stable machine error and bounded summary", async () => {
  const now = Date.now();
  const before = recentRateLimitSummary(now).by_scope.instance;
  const env = {
    INSTANCE_RATE_LIMITER: {
      async limit({ key }) {
        assert.equal(key, "dynamic-api");
        return { success: false };
      },
    },
    RATE_LIMIT_INSTANCE_LIMIT: "73",
    RATE_LIMIT_INSTANCE_PERIOD_SECONDS: "10",
    RATE_LIMIT_PRINCIPAL_LIMIT: "61",
    RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS: "60",
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT: "17",
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS: "10",
  };

  await assert.rejects(enforceInstanceRateLimit(env), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.category, "rate_limit");
    assert.equal(error.source, "service");
    assert.equal(error.retryable, true);
    assert.equal(error.recovery, "retry_after");
    assert.equal(error.retryAfterSeconds, 10);
    assert.deepEqual(error.details, {
      limit: 73,
      period_seconds: 10,
      scope: "instance",
    });
    return true;
  });
  const after = recentRateLimitSummary(Date.now());
  assert.equal(after.by_scope.instance, before + 1);
  assert.equal(after.observation_scope, "worker_isolate_best_effort");
  assert.equal(after.window_seconds, 300);
  assert.ok(after.total <= 128);
});

test("rate-limit routing covers every Worker-owned dynamic surface and bypasses static assets", () => {
  for (const pathname of [
    "/api/v1/issues",
    "/api/unknown",
    "/healthz",
    "/openapi.json",
    "/invite",
    "/app/launch",
    "/.well-known/cfkanban-instance.json",
  ]) assert.equal(isRateLimitedDynamicPath(pathname), true, pathname);
  for (const pathname of ["/", "/assets/app.js", "/favicon.ico", "/apiary"]) {
    assert.equal(isRateLimitedDynamicPath(pathname), false, pathname);
  }

  for (const pathname of [
    "/api/v1/invitations/redeem",
    "/api/v1/web-sessions/redeem",
    "/api/v1/web-authentication/options",
    "/api/v1/web-authentication/verify",
    `/api/v1/public-joins/${crypto.randomUUID()}/redeem`,
  ]) assert.equal(isUnauthenticatedSensitivePath("POST", pathname), true, pathname);
  assert.equal(isUnauthenticatedSensitivePath("GET", "/api/v1/web-authentication/options"), false);
  assert.equal(isUnauthenticatedSensitivePath("POST", "/api/v1/me/passkeys"), false);
  assert.equal(isUnauthenticatedSensitivePath("POST", "/assets/redeem"), false);
});

test("official D1 quota errors map separately from unknown platform failures", () => {
  const now = Date.parse("2026-08-29T23:59:30.000Z");
  const dailyRead = platformUnavailable(
    "d1",
    new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."),
    now,
  );
  assert.deepEqual(errorShape(dailyRead), {
    category: "platform_quota",
    code: "PLATFORM_QUOTA_EXCEEDED",
    details: {
      component: "d1",
      quota_kind: "daily_reads",
      reset_at: "2026-08-30T00:00:00.000Z",
    },
    message: "The D1 daily quota does not allow this operation until its next reset.",
    recovery: "wait_for_platform_reset",
    retryable: true,
    status: 503,
  });
  assert.equal(dailyRead.retryAfterSeconds, 30);
  assert.equal(dailyRead.source, "cloudflare_platform");

  const dailyWrite = platformUnavailable("d1", {
    cause: new Error("Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."),
  }, now);
  assert.equal(dailyWrite.details.quota_kind, "daily_writes");
  assert.equal(dailyWrite.retryAfterSeconds, 30);

  for (const message of [
    "D1_ERROR: Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit",
    "D1_ERROR: Exceeded maximum DB size.",
  ]) {
    const storage = platformUnavailable("d1", new Error(message), now);
    assert.equal(storage.category, "platform_quota");
    assert.equal(storage.code, "PLATFORM_QUOTA_EXCEEDED");
    assert.deepEqual(storage.details, { component: "d1", quota_kind: "storage" });
    assert.equal(storage.recovery, "request_owner");
    assert.equal(storage.retryable, false);
    assert.equal(storage.retryAfterSeconds, undefined);
  }

  const overload = platformUnavailable("d1", new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued."), now);
  assert.equal(overload.category, "platform_failure");
  assert.equal(overload.code, "PLATFORM_UNAVAILABLE");
  assert.equal(overload.details.failure_class, "unavailable");
});

test("D1 access helpers preserve recognized quota classification", async () => {
  const quotaMessage = "D1_ERROR: Exceeded maximum DB size.";
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              throw new Error(quotaMessage);
            },
          };
        },
      };
    },
  };
  await assert.rejects(lookupOpaqueResourceId(db, "principal", crypto.randomUUID()), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "PLATFORM_QUOTA_EXCEEDED");
    assert.equal(error.category, "platform_quota");
    assert.equal(error.source, "cloudflare_platform");
    assert.deepEqual(error.details, { component: "d1", quota_kind: "storage" });
    return true;
  });
});

test("cookie write protection enforces same-origin and double-submit while Bearer wins", () => {
  const csrf = "c".repeat(43);
  const cookieAuth = {
    displayName: "A",
    isOwner: false,
    kind: "cookie",
    principalId: crypto.randomUUID(),
    principalVersion: 1,
    sessionId: crypto.randomUUID(),
    sourceId: crypto.randomUUID(),
    sourceKind: "credential",
    target: {},
    targetKind: "project",
  };
  const bearerAuth = {
    credentialFingerprint: "cfk_v1_safe_…",
    credentialId: crypto.randomUUID(),
    displayName: "A",
    isOwner: false,
    kind: "bearer",
    principalId: crypto.randomUUID(),
    principalVersion: 1,
  };
  const valid = new Request("https://kanban.example.test/api/v1/test", {
    headers: {
      cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      origin: "https://kanban.example.test",
      "x-csrf-token": csrf,
    },
    method: "POST",
  });
  assert.doesNotThrow(() => enforceCookieWriteProtection(valid, cookieAuth));

  for (const headers of [
    { cookie: `${CSRF_COOKIE_NAME}=${csrf}`, "x-csrf-token": csrf },
    { cookie: `${CSRF_COOKIE_NAME}=${csrf}`, origin: "https://evil.example", "x-csrf-token": csrf },
    { cookie: `${CSRF_COOKIE_NAME}=${csrf}`, origin: "https://kanban.example.test", "x-csrf-token": "d".repeat(43) },
  ]) {
    const request = new Request("https://kanban.example.test/api/v1/test", { headers, method: "POST" });
    assert.throws(() => enforceCookieWriteProtection(request, cookieAuth), (error) => error.code === "FORBIDDEN");
  }

  const bearerWithCookie = new Request("https://kanban.example.test/api/v1/test", {
    headers: { cookie: `${CSRF_COOKIE_NAME}=wrong` },
    method: "POST",
  });
  assert.doesNotThrow(() => enforceCookieWriteProtection(bearerWithCookie, bearerAuth));
  assert.match(serializeSessionCookie("value"), /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
  assert.match(serializeCsrfCookie("value"), /Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
  assert.doesNotMatch(serializeCsrfCookie("value"), /HttpOnly/);
});

test("constant-time comparison and hidden-resource errors are stable", () => {
  assert.equal(timingSafeEqual("same", "same"), true);
  assert.equal(timingSafeEqual("same", "different"), false);

  const failures = [];
  for (const [resource, allowed] of [[null, true], [{ id: "known" }, false]]) {
    try {
      requireDiscoverable(resource, allowed);
    } catch (error) {
      failures.push(errorShape(error));
    }
  }
  assert.deepEqual(failures[0], failures[1]);
  assert.equal(failures[0].code, "NOT_FOUND");
});

test("Passkey authentication equalizes ES256 and RS256 verification paths", async () => {
  const challenge = base64UrlEncode(new Uint8Array(32).fill(0x4a));
  const expectedOrigin = "https://kanban.example.test";
  const rpId = "kanban.example.test";
  const expectedUserHandle = base64UrlEncode(new TextEncoder().encode(crypto.randomUUID()));
  const wrongUserHandle = base64UrlEncode(new TextEncoder().encode(crypto.randomUUID()));
  const challengeDigest = await sha256Hex(challenge);
  const fallback = {
    challengeDigest,
    expectedOrigin,
    rpId,
    userHandle: wrongUserHandle,
  };
  const importCalls = [];
  const verifyCalls = [];
  const keyProfile = (key) => ({
    modulusLength: key.algorithm.modulusLength ?? null,
    name: key.algorithm.name,
    namedCurve: key.algorithm.namedCurve ?? null,
    publicExponent: key.algorithm.publicExponent
      ? Array.from(key.algorithm.publicExponent)
      : null,
  });
  const expectedProfiles = [
    {
      modulusLength: null,
      name: "ECDSA",
      namedCurve: "P-256",
      publicExponent: null,
    },
    {
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      namedCurve: null,
      publicExponent: [1, 0, 1],
    },
  ];
  const sortedProfiles = (profiles) => profiles.toSorted((left, right) => left.name.localeCompare(right.name));
  const assertFixedWorkload = () => {
    assert.deepEqual(sortedProfiles(importCalls), expectedProfiles);
    assert.deepEqual(sortedProfiles(verifyCalls), expectedProfiles);
    importCalls.length = 0;
    verifyCalls.length = 0;
  };
  const originalImportKey = crypto.subtle.importKey;
  const originalVerify = crypto.subtle.verify;
  crypto.subtle.importKey = async function instrumentedImportKey(...args) {
    const key = await originalImportKey.call(this, ...args);
    importCalls.push(keyProfile(key));
    return key;
  };
  crypto.subtle.verify = async function instrumentedVerify(algorithm, key, ...args) {
    verifyCalls.push(keyProfile(key));
    return originalVerify.call(this, algorithm, key, ...args);
  };
  try {
    const es256 = await createRegistrationFixture({ algorithm: -7, challenge, origin: expectedOrigin, rpId });
    const es256Expectation = {
      algorithm: -7,
      backupEligible: false,
      challengeDigest,
      credentialId: es256.credentialId,
      expectedOrigin,
      publicKeyCose: es256.publicKeyCose,
      rpId,
      userHandle: expectedUserHandle,
    };
    const wrongHandleAssertion = await createAssertionCredential({
      algorithm: -7,
      challenge,
      credentialId: es256.credentialId,
      origin: expectedOrigin,
      privateKey: es256.privateKey,
      rpId,
      signCount: 1,
      userHandle: wrongUserHandle,
    });
    await assert.rejects(
      verifyAuthenticationCredentialEqualized(
        wrongHandleAssertion,
        es256Expectation,
        { ...fallback, credentialId: es256.credentialId },
      ),
      WebAuthnVerificationError,
    );
    assertFixedWorkload();

    const unknown = await verifyAuthenticationCredentialEqualized(
      wrongHandleAssertion,
      null,
      { ...fallback, credentialId: es256.credentialId },
    );
    assert.equal(unknown, null);
    assertFixedWorkload();

    for (const assertion of [
      await createAssertionCredential({
        algorithm: -7,
        challenge: base64UrlEncode(new Uint8Array(32).fill(0x6c)),
        credentialId: es256.credentialId,
        origin: expectedOrigin,
        privateKey: es256.privateKey,
        rpId,
        signCount: 1,
        userHandle: expectedUserHandle,
      }),
      await createAssertionCredential({
        algorithm: -7,
        challenge,
        credentialId: es256.credentialId,
        origin: "https://other.example.test",
        privateKey: es256.privateKey,
        rpId,
        signCount: 1,
        userHandle: expectedUserHandle,
      }),
      await createAssertionCredential({
        algorithm: -7,
        challenge,
        credentialId: es256.credentialId,
        origin: expectedOrigin,
        privateKey: es256.privateKey,
        rpId: "other.example.test",
        signCount: 1,
        userHandle: expectedUserHandle,
      }),
    ]) {
      await assert.rejects(
        verifyAuthenticationCredentialEqualized(
          assertion,
          es256Expectation,
          { ...fallback, credentialId: es256.credentialId },
        ),
        WebAuthnVerificationError,
      );
      assertFixedWorkload();
    }

    const rs256 = await createRegistrationFixture({ algorithm: -257, challenge, origin: expectedOrigin, rpId });
    const invalidRsaAssertion = await createAssertionCredential({
      algorithm: -257,
      challenge,
      credentialId: rs256.credentialId,
      origin: expectedOrigin,
      privateKey: rs256.privateKey,
      rpId,
      signCount: 1,
      userHandle: expectedUserHandle,
    });
    invalidRsaAssertion.response.signature = "AA";
    await assert.rejects(
      verifyAuthenticationCredentialEqualized(
        invalidRsaAssertion,
        {
          algorithm: -257,
          backupEligible: false,
          challengeDigest,
          credentialId: rs256.credentialId,
          expectedOrigin,
          publicKeyCose: rs256.publicKeyCose,
          rpId,
          userHandle: expectedUserHandle,
        },
        { ...fallback, credentialId: rs256.credentialId },
      ),
      WebAuthnVerificationError,
    );
    assertFixedWorkload();
  } finally {
    crypto.subtle.importKey = originalImportKey;
    crypto.subtle.verify = originalVerify;
  }
});

test("RS256 registration and authentication preserve accepted historical key profiles", async () => {
  const challenge = base64UrlEncode(new Uint8Array(32).fill(0x5b));
  const challengeDigest = await sha256Hex(challenge);
  const expectedOrigin = "https://kanban.example.test";
  const rpId = "kanban.example.test";
  const userHandle = base64UrlEncode(new TextEncoder().encode(crypto.randomUUID()));
  for (const profile of [
    { modulusLength: 4096, publicExponent: Uint8Array.of(1, 0, 1) },
    { modulusLength: 2048, publicExponent: Uint8Array.of(3) },
  ]) {
    const fixture = await createRegistrationFixture({
      algorithm: -257,
      challenge,
      origin: expectedOrigin,
      rpId,
      rsaModulusLength: profile.modulusLength,
      rsaPublicExponent: profile.publicExponent,
    });
    const registered = await verifyRegistrationCredential(
      fixture.registrationCredential,
      { challengeDigest, expectedOrigin, rpId },
    );
    assert.equal(registered.algorithm, -257);
    assert.equal(registered.publicKeyCose, fixture.publicKeyCose);

    const assertion = await createAssertionCredential({
      algorithm: -257,
      challenge,
      credentialId: registered.credentialId,
      origin: expectedOrigin,
      privateKey: fixture.privateKey,
      rpId,
      signCount: 1,
      userHandle,
    });
    const verified = await verifyAuthenticationCredentialEqualized(
      assertion,
      {
        algorithm: -257,
        backupEligible: registered.backupEligible,
        challengeDigest,
        credentialId: registered.credentialId,
        expectedOrigin,
        publicKeyCose: registered.publicKeyCose,
        rpId,
        userHandle,
      },
      {
        challengeDigest,
        credentialId: registered.credentialId,
        expectedOrigin,
        rpId,
        userHandle,
      },
    );
    assert.equal(verified?.credentialId, registered.credentialId);
    assert.equal(verified?.signCount, 1);
  }
});

test("SQL fragments come only from a code allowlist", () => {
  const allowlist = { newest: "updated_at DESC, id DESC" };
  assert.equal(resolveSqlFragment("newest", allowlist), allowlist.newest);
  assert.throws(
    () => resolveSqlFragment("newest; DROP TABLE principals", allowlist),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("canonical request hashing is stable and idempotency keys are bounded", async () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  const first = await computeRequestHash({
    idempotencyKey: "key",
    method: "post",
    normalizedResourceScope: "workspace/example/project/CORE",
    requestBody: { title: "A", body: "B" },
    routeTemplate: "/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues",
    scopeKey: "principal:test",
  });
  const second = await computeRequestHash({
    idempotencyKey: "key",
    method: "POST",
    normalizedResourceScope: "workspace/example/project/CORE",
    requestBody: { body: "B", title: "A" },
    routeTemplate: "/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues",
    scopeKey: "principal:test",
  });
  assert.deepEqual(first, second);
  assert.doesNotThrow(() => validateIdempotencyKey("printable-key 123"));
  assert.throws(() => validateIdempotencyKey(""), (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED");
  assert.throws(() => validateIdempotencyKey("line\nbreak"), (error) => error.code === "VALIDATION_ERROR");
  assert.throws(() => validateIdempotencyKey("x".repeat(129)), (error) => error.code === "VALIDATION_ERROR");

  const credential = `cfk_v1_live_${"A".repeat(43)}`;
  const invitation = `cfi_v1_${"P".repeat(8)}_${"I".repeat(43)}`;
  const browserLaunch = `cfl_v1_${"L".repeat(8)}_${"B".repeat(43)}`;
  const sessionSecret = "S".repeat(43);
  assert.throws(() => validateIdempotencyKey(credential), (error) => error.code === "VALIDATION_ERROR");
  assert.throws(() => validateIdempotencyKey(invitation), (error) => error.code === "VALIDATION_ERROR");
  assert.throws(() => validateIdempotencyKey(browserLaunch), (error) => error.code === "VALIDATION_ERROR");
  assert.throws(
    () => validateIdempotencyKey(`request-${sessionSecret}`, [sessionSecret]),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
