import { randomUUID } from "node:crypto";

import { toolError } from "./errors.mjs";
import { getInstancePaths, loadCurrentCredentialSecret } from "./state.mjs";
import { readJson, requireString } from "./utils.mjs";
import { resolveStateRoot } from "./paths.mjs";

const ERROR_CATEGORIES = new Set([
  "authentication", "authorization", "business_quota", "conflict", "not_found",
  "platform_failure", "platform_quota", "rate_limit", "validation",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function retryAfterSeconds(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)) : null;
}

function categoryMatchesStatus(category, status) {
  if (category === "authentication") return status === 401;
  if (category === "authorization") return status === 403;
  if (category === "not_found") return status === 404;
  if (category === "validation") return status === 400 || status === 413;
  if (category === "conflict") return status === 409 || status === 410;
  if (category === "business_quota") return status === 409;
  if (category === "rate_limit") return status === 429;
  return status === 503;
}

function isErrorBody(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof value.code === "string"
    && value.code.length > 0
    && typeof value.category === "string"
    && ERROR_CATEGORIES.has(value.category)
    && typeof value.message === "string"
    && typeof value.recovery === "string"
    && value.recovery.length > 0
    && typeof value.request_id === "string"
    && UUID_PATTERN.test(value.request_id)
    && typeof value.retryable === "boolean"
    && (value.source === "service" || value.source === "cloudflare_platform")
    && typeof value.details === "object"
    && value.details !== null
    && !Array.isArray(value.details)
    && (value.retry_after_seconds === undefined || (
      typeof value.retry_after_seconds === "number"
      && Number.isSafeInteger(value.retry_after_seconds)
      && value.retry_after_seconds >= 0
    ));
}

function isVerifiedServiceError(response, value) {
  if (!isErrorBody(value)) return false;
  const responseRequestId = response.headers.get("x-request-id");
  const rawRetryAfter = response.headers.get("retry-after");
  const parsedRetryAfter = retryAfterSeconds(response.headers);
  const hasBodyRetryAfter = value.retry_after_seconds !== undefined;
  const retryAfterIsConsistent = rawRetryAfter === null
    ? !hasBodyRetryAfter
    : parsedRetryAfter !== null
      && hasBodyRetryAfter
      && parsedRetryAfter === value.retry_after_seconds;
  const sourceIsConsistent = value.source === "service"
    || value.category === "platform_failure"
    || value.category === "platform_quota";
  return responseRequestId !== null
    && UUID_PATTERN.test(responseRequestId)
    && responseRequestId === value.request_id
    && value.details.normalized_by !== "client"
    && categoryMatchesStatus(value.category, response.status)
    && sourceIsConsistent
    && retryAfterIsConsistent
    && value.retryable === hasBodyRetryAfter
    && (value.category !== "rate_limit" || hasBodyRetryAfter);
}

function clientError({ code, category, source, retryable, recovery, response = null, details = {}, status = null }) {
  const retryAfter = retryAfterSeconds(response?.headers);
  return {
    ok: false,
    status: status ?? response?.status ?? 0,
    error: {
      code,
      category,
      source,
      message: "The service response could not be verified.",
      request_id: randomUUID(),
      retryable,
      recovery,
      details: {
        normalized_by: "client",
        ...(response?.headers?.get?.("cf-ray")
          ? { provider_request_id: response.headers.get("cf-ray") }
          : {}),
        ...details,
      },
      ...(retryAfter === null ? {} : { retry_after_seconds: retryAfter }),
    },
  };
}

function normalizeOuterHttp(response, preview) {
  const providerRequestId = response.headers.get("cf-ray");
  const isCloudflare = providerRequestId !== null
    || response.headers.get("server")?.toLowerCase().includes("cloudflare") === true;
  const cloudflare1027 = isCloudflare && /(?:^|\D)1027(?:\D|$)/.test(preview);
  if (cloudflare1027) {
    return clientError({
      code: "PLATFORM_QUOTA_EXCEEDED",
      category: "platform_quota",
      source: "cloudflare_platform",
      retryable: true,
      recovery: "wait_for_platform_reset",
      response,
      status: 503,
      details: { component: "workers" },
    });
  }
  if (response.status === 429) {
    return clientError({
      code: "RATE_LIMITED",
      category: "rate_limit",
      source: "cloudflare_platform",
      retryable: true,
      recovery: "retry_after",
      response,
      status: 429,
    });
  }
  return clientError({
    code: "PLATFORM_UNAVAILABLE",
    category: "platform_failure",
    source: "cloudflare_platform",
    retryable: false,
    recovery: "request_owner",
    response,
    status: 503,
  });
}

export async function normalizeResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      return normalizeOuterHttp(response, "");
    }
    if (response.ok) return { ok: true, status: response.status, data: payload };
    if (isVerifiedServiceError(response, payload)) {
      return { ok: false, status: response.status, error: payload };
    }
    return normalizeOuterHttp(response, (JSON.stringify(payload) ?? "").slice(0, 4096));
  }
  const preview = (await response.text()).slice(0, 4096);
  return normalizeOuterHttp(response, preview);
}

export function normalizeNetworkFailure() {
  return clientError({
    code: "PLATFORM_UNAVAILABLE",
    category: "platform_failure",
    source: "client_transport",
    retryable: true,
    recovery: "retry_after",
    details: { component: "network" },
  });
}

export async function trustedApiRequest({
  stateRoot = resolveStateRoot(),
  instanceId,
  method = "GET",
  apiPath,
  body = undefined,
  idempotencyKey = null,
  authorizationToken = null,
  fetchImpl = globalThis.fetch,
}) {
  requireString(apiPath, "api_path");
  if (!apiPath.startsWith("/") || apiPath.startsWith("//")) {
    throw toolError("INVALID_API_PATH", "API path must be a same-origin absolute path");
  }
  const paths = getInstancePaths({ stateRoot, instanceId });
  const instance = await readJson(paths.instanceMetadata);
  const headers = new Headers({ accept: "application/json" });
  if (authorizationToken !== null) headers.set("authorization", `Bearer ${authorizationToken}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (idempotencyKey !== null) headers.set("idempotency-key", requireString(idempotencyKey, "idempotency_key", { max: 128 }));
  let response;
  try {
    response = await fetchImpl(new URL(apiPath, instance.trusted_api_origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  } catch (error) {
    return normalizeNetworkFailure(error);
  }
  if (response.status >= 300 && response.status < 400) {
    return clientError({
      code: "CROSS_ORIGIN_REDIRECT_REJECTED",
      category: "platform_failure",
      source: "client_transport",
      retryable: false,
      recovery: "verify_trusted_origin",
      response,
      status: 503,
    });
  }
  return normalizeResponse(response);
}

export async function apiRequest(options) {
  const { token } = await loadCurrentCredentialSecret({
    stateRoot: options.stateRoot ?? resolveStateRoot(),
    instanceId: options.instanceId,
  });
  return trustedApiRequest({ ...options, authorizationToken: token });
}
