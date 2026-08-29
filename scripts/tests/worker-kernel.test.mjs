import assert from "node:assert/strict";
import test from "node:test";

import {
  CSRF_COOKIE_NAME,
  enforceCookieWriteProtection,
  serializeCsrfCookie,
  serializeSessionCookie,
} from "../../apps/worker/src/kernel/csrf.ts";
import { timingSafeEqual } from "../../apps/worker/src/kernel/crypto.ts";
import { requireDiscoverable, resolveSqlFragment } from "../../apps/worker/src/kernel/d1.ts";
import { ApiError, errorResponse } from "../../apps/worker/src/kernel/errors.ts";
import { canonicalJson, computeRequestHash, validateIdempotencyKey } from "../../apps/worker/src/kernel/idempotency.ts";
import { MAX_JSON_BYTES, readJsonBody, validateJsonObject } from "../../apps/worker/src/kernel/http.ts";

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
