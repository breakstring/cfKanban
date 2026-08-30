import type { ApiErrorBody } from "../types";
import {
  type AcquiredPendingIntent,
  normalizeOuterHttp,
  normalizedFailure,
  PendingIntentExpiredError,
  PendingIntentKeys,
  retryAfterSeconds,
} from "./api-core";
import { locale, t } from "./i18n";
import { presentApiProblem } from "./error-presentation";
import { isVerifiedServiceAccessFailure } from "./session-boundary";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "cfkanban_csrf";
const pendingIntents = new PendingIntentKeys(() => crypto.randomUUID());
const ERROR_CATEGORIES = new Set([
  "authentication", "authorization", "business_quota", "conflict", "not_found",
  "platform_failure", "platform_quota", "rate_limit", "validation",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body.code === "string"
    && body.code.length > 0
    && typeof body.category === "string"
    && ERROR_CATEGORIES.has(body.category)
    && typeof body.message === "string"
    && typeof body.recovery === "string"
    && body.recovery.length > 0
    && typeof body.request_id === "string"
    && UUID_PATTERN.test(body.request_id)
    && typeof body.retryable === "boolean"
    && (body.source === "service" || body.source === "cloudflare_platform")
    && typeof body.details === "object"
    && body.details !== null
    && !Array.isArray(body.details)
    && (body.retry_after_seconds === undefined || (
      typeof body.retry_after_seconds === "number"
      && Number.isSafeInteger(body.retry_after_seconds)
      && body.retry_after_seconds >= 0
    ));
}

function categoryMatchesStatus(category: string, status: number): boolean {
  if (category === "authentication") return status === 401;
  if (category === "authorization") return status === 403;
  if (category === "not_found") return status === 404;
  if (category === "validation") return status === 400 || status === 413;
  if (category === "conflict") return status === 409 || status === 410;
  if (category === "business_quota") return status === 409;
  if (category === "rate_limit") return status === 429;
  return status === 503;
}

function isVerifiedErrorEnvelope(response: Response, value: unknown): value is ApiErrorBody {
  if (!isErrorBody(value)) return false;
  const responseRequestId = response.headers.get("x-request-id");
  const rawRetryAfter = response.headers.get("retry-after");
  const parsedRetryAfter = retryAfterSeconds(rawRetryAfter);
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

function normalizedHttpFailure(response: Response, text: string, requestId: string): ApiProblem {
  const normalized = normalizeOuterHttp(response.status, response.headers, text, requestId);
  return new ApiProblem(normalized.status, normalized.body, normalized.retryAfter);
}

function notifyAuthorizationFailure(status: number, body: ApiErrorBody): void {
  if (typeof window === "undefined") return;
  if (!isVerifiedServiceAccessFailure(status, body)) return;
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

export interface ApiRequestOptions<T = unknown> {
  body?: unknown;
  coordinateIdempotencyIntent?: (
    acquire: () => AcquiredPendingIntent,
    execute: (intent: AcquiredPendingIntent) => Promise<T>,
  ) => Promise<T>;
  idempotencyKey?: string;
  method?: string;
  signal?: AbortSignal;
  validateResponse?: (value: unknown) => boolean;
}

export function clearPendingRequestIntents(method: string, path: string): void {
  pendingIntents.clearRequest(method.toUpperCase(), path);
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions<T> = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  let requestIntent: AcquiredPendingIntent | null = null;
  const acquirePendingIntent = (): AcquiredPendingIntent => {
    try {
      return pendingIntents.acquire(method, path, options.body);
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
  };
  if (!SAFE_METHODS.has(method)) {
    const csrf = cookieValue(CSRF_COOKIE);
    if (csrf !== null) headers.set("x-csrf-token", csrf);
    if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);
    else if (options.coordinateIdempotencyIntent === undefined) {
      requestIntent = acquirePendingIntent();
    }
  }

  const executeRequest = async (intent: AcquiredPendingIntent | null = requestIntent): Promise<T> => {
    if (intent !== null) headers.set("idempotency-key", intent.key);
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

    const localRequestId = crypto.randomUUID();
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    let payload: unknown = null;
    if (mediaType === "application/json") {
      try {
        payload = await response.json();
      } catch {
        const problem = normalizedHttpFailure(response, "", localRequestId);
        notifyAuthorizationFailure(problem.status, problem.body);
        throw problem;
      }
    } else if (response.status !== 204) {
      const problem = normalizedHttpFailure(response, (await response.text()).slice(0, 16_384), localRequestId);
      notifyAuthorizationFailure(problem.status, problem.body);
      throw problem;
    }

    if (!response.ok) {
      if (!isVerifiedErrorEnvelope(response, payload)) {
        const problem = normalizedHttpFailure(
          response,
          (JSON.stringify(payload) ?? "").slice(0, 16_384),
          localRequestId,
        );
        notifyAuthorizationFailure(problem.status, problem.body);
        throw problem;
      }
      const headerRetryAfter = retryAfterSeconds(response.headers.get("retry-after"));
      const bodyRetryAfter = typeof payload.retry_after_seconds === "number"
        && Number.isSafeInteger(payload.retry_after_seconds)
        && payload.retry_after_seconds >= 0
        ? payload.retry_after_seconds
        : null;
      const retryAfter = headerRetryAfter ?? bodyRetryAfter;
      const body = payload;
      notifyAuthorizationFailure(response.status, body);
      throw new ApiProblem(response.status, body, retryAfter);
    }
    if (options.validateResponse !== undefined && !options.validateResponse(payload)) {
      throw new ApiProblem(503, normalizedFailure(crypto.randomUUID(), {
        category: "platform_failure",
        code: "PLATFORM_UNAVAILABLE",
        component: "response_validation",
        recovery: "retry_after",
        retryable: true,
        source: "client_transport",
      }));
    }
    if (intent !== null) pendingIntents.complete(intent.signature);
    return payload as T;
  };

  if (!SAFE_METHODS.has(method)
    && options.idempotencyKey === undefined
    && options.coordinateIdempotencyIntent !== undefined) {
    const coordination: {
      intent: AcquiredPendingIntent | null;
      requestStarted: boolean;
    } = { intent: null, requestStarted: false };
    try {
      return await options.coordinateIdempotencyIntent(() => {
        if (coordination.intent !== null) return coordination.intent;
        coordination.intent = acquirePendingIntent();
        return coordination.intent;
      }, (intent) => {
        if (coordination.intent === null
          || coordination.intent.key !== intent.key
          || coordination.intent.signature !== intent.signature) {
          throw new Error("The coordinated Idempotency-Key was not acquired by this request.");
        }
        coordination.requestStarted = true;
        return executeRequest(intent);
      });
    } catch (error) {
      if (!coordination.requestStarted && coordination.intent !== null) {
        // Coordination failed before fetch, so the generated key never left
        // this page and must not consume part of the fixed recovery window.
        pendingIntents.complete(coordination.intent.signature);
      }
      throw error;
    }
  }
  return executeRequest();
}

export function errorText(error: unknown): string {
  if (error instanceof ApiProblem) return presentApiProblem(error, locale.value, (key) => t(key));
  if (error instanceof Error) return error.message;
  return t("error.generic");
}
