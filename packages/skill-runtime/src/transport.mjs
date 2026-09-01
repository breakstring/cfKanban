import { toolError } from "./errors.mjs";
import { getInstancePaths, loadCurrentCredentialSecret } from "./state.mjs";
import { readJson, requireString } from "./utils.mjs";
import { resolveStateRoot } from "./paths.mjs";

function retryAfterSeconds(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)) : null;
}

function clientError({ code, category, source, retryable, recovery, response = null, details = {} }) {
  return {
    ok: false,
    error: {
      code,
      category,
      source,
      request_id: response?.headers?.get?.("x-request-id") || null,
      retryable,
      retry_after_seconds: retryAfterSeconds(response?.headers),
      recovery,
      details: {
        normalized_by: "client",
        http_status: response?.status ?? null,
        ray_id: response?.headers?.get?.("cf-ray") || null,
        ...details,
      },
    },
  };
}

export async function normalizeResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return clientError({ code: "INVALID_JSON_RESPONSE", category: "platform", source: "client_transport", retryable: response.status >= 500, recovery: "retry_or_contact_owner", response });
    }
    if (response.ok) return { ok: true, status: response.status, data: payload };
    if (payload?.code && payload?.category && payload?.source) {
      return { ok: false, status: response.status, error: payload };
    }
    return clientError({ code: "UNRECOGNIZED_JSON_ERROR", category: "platform", source: "client_transport", retryable: response.status >= 500, recovery: "retry_or_contact_owner", response });
  }
  const preview = (await response.text()).slice(0, 4096);
  const cloudflareCode = /(?:error\s*(?:code)?\s*[:#]?\s*|cf-error-code[^>]*>\s*)(\d{3,4})/i.exec(preview)?.[1] || null;
  if (response.status === 429 || cloudflareCode === "1027" || response.headers.get("cf-ray")) {
    return clientError({
      code: cloudflareCode === "1027" ? "CLOUDFLARE_1027" : response.status === 429 ? "RATE_LIMITED" : "CLOUDFLARE_EDGE_FAILURE",
      category: "platform",
      source: "cloudflare_platform",
      retryable: response.status === 429 || response.status >= 500,
      recovery: response.status === 429 ? "wait_for_retry_after" : "inspect_cloudflare_capacity",
      response,
      details: cloudflareCode ? { cloudflare_error_code: cloudflareCode } : {},
    });
  }
  return clientError({ code: "NON_JSON_HTTP_FAILURE", category: "platform", source: "client_transport", retryable: response.status >= 500, recovery: "retry_or_contact_owner", response });
}

export function normalizeNetworkFailure(error) {
  return clientError({
    code: "NETWORK_FAILURE",
    category: "platform",
    source: "client_transport",
    retryable: true,
    recovery: "check_network_then_retry_idempotently",
    details: { reason: error instanceof Error ? error.name : "unknown" },
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
    return clientError({ code: "CROSS_ORIGIN_REDIRECT_REJECTED", category: "security", source: "client_transport", retryable: false, recovery: "verify_trusted_origin", response });
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
