import type { ApiErrorBody } from "../types";
import {
  normalizeOuterHttp,
  normalizedFailure,
  PendingIntentExpiredError,
  PendingIntentKeys,
  retryAfterSeconds,
} from "./api-core";
import { locale, t } from "./i18n";
import { presentApiProblem } from "./error-presentation";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "cfkanban_csrf";
const pendingIntents = new PendingIntentKeys(() => crypto.randomUUID());

function cookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.code === "string"
    && typeof body.category === "string"
    && typeof body.message === "string"
    && typeof body.recovery === "string"
    && typeof body.request_id === "string"
    && typeof body.retryable === "boolean"
    && typeof body.source === "string";
}

function normalizedHttpFailure(response: Response, text: string, requestId: string): ApiProblem {
  const normalized = normalizeOuterHttp(response.status, response.headers, text, requestId);
  return new ApiProblem(normalized.status, normalized.body, normalized.retryAfter);
}

function notifyAuthorizationFailure(status: number): void {
  if (typeof window === "undefined") return;
  if (status === 401) window.dispatchEvent(new CustomEvent("cfkanban:session-invalid"));
  if (status === 403) window.dispatchEvent(new CustomEvent("cfkanban:authorization-stale"));
}

export class ApiProblem extends Error {
  readonly body: ApiErrorBody;
  readonly retryAfter: number | null;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody, retryAfter: number | null = null) {
    super(body.message);
    this.name = "ApiProblem";
    this.body = body;
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

export interface ApiRequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  method?: string;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  let signature: string | null = null;
  if (!SAFE_METHODS.has(method)) {
    const csrf = cookieValue(CSRF_COOKIE);
    if (csrf !== null) headers.set("x-csrf-token", csrf);
    if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);
    else {
      let intent: ReturnType<PendingIntentKeys["acquire"]>;
      try {
        intent = pendingIntents.acquire(method, path, options.body);
      } catch (error) {
        if (!(error instanceof PendingIntentExpiredError)) throw error;
        throw new ApiProblem(409, {
          category: "conflict",
          code: "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED",
          details: { normalized_by: "client" },
          message: "The safe retry window for this write has expired.",
          recovery: "refresh_resource",
          request_id: crypto.randomUUID(),
          retryable: false,
          source: "client_transport",
        });
      }
      signature = intent.signature;
      headers.set("idempotency-key", intent.key);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers,
      method,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new ApiProblem(0, normalizedFailure(crypto.randomUUID(), {
      category: "platform_failure",
      code: "PLATFORM_UNAVAILABLE",
      recovery: "retry_after",
      retryable: true,
      source: "client_transport",
    }));
  }

  const requestId = response.headers.get("x-request-id") ?? crypto.randomUUID();
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  let payload: unknown = null;
  if (mediaType === "application/json") {
    try {
      payload = await response.json();
    } catch {
      const problem = normalizedHttpFailure(response, "", requestId);
      notifyAuthorizationFailure(problem.status);
      throw problem;
    }
  } else if (response.status !== 204) {
    const problem = normalizedHttpFailure(response, (await response.text()).slice(0, 16_384), requestId);
    notifyAuthorizationFailure(problem.status);
    throw problem;
  }

  if (!response.ok) {
    const headerRetryAfter = retryAfterSeconds(response.headers.get("retry-after"));
    const bodyRetryAfter = isErrorBody(payload)
      && typeof payload.retry_after_seconds === "number"
      && Number.isSafeInteger(payload.retry_after_seconds)
      && payload.retry_after_seconds >= 0
      ? payload.retry_after_seconds
      : null;
    const retryAfter = headerRetryAfter ?? bodyRetryAfter;
    const body = isErrorBody(payload)
      ? payload
      : normalizedFailure(requestId, {
        category: "platform_failure",
        code: "PLATFORM_UNAVAILABLE",
        providerRequestId: response.headers.get("cf-ray"),
        recovery: "request_owner",
        retryable: false,
        source: "cloudflare_platform",
      });
    notifyAuthorizationFailure(response.status);
    throw new ApiProblem(response.status, body, retryAfter);
  }
  if (signature !== null) pendingIntents.complete(signature);
  return payload as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiProblem) return presentApiProblem(error, locale.value, (key) => t(key));
  if (error instanceof Error) return error.message;
  return t("error.generic");
}
