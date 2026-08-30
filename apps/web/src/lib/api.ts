import type { ApiErrorBody } from "../types";
import { locale, t } from "./i18n";
import { presentApiProblem } from "./error-presentation";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "cfkanban_csrf";

function cookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function clientFailure(requestId: string, code = "TRANSPORT_ERROR"): ApiErrorBody {
  return {
    category: "platform_failure",
    code,
    message: "The service response could not be verified.",
    normalized_by: "client",
    recovery: "retry_or_contact_owner",
    request_id: requestId,
    retryable: true,
    source: "client",
  };
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
  if (!SAFE_METHODS.has(method)) {
    const csrf = cookieValue(CSRF_COOKIE);
    if (csrf !== null) headers.set("x-csrf-token", csrf);
    headers.set("idempotency-key", options.idempotencyKey ?? crypto.randomUUID());
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
    const requestId = crypto.randomUUID();
    throw new ApiProblem(0, clientFailure(requestId));
  }

  const requestId = response.headers.get("x-request-id") ?? crypto.randomUUID();
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  let payload: unknown = null;
  if (mediaType === "application/json") {
    try {
      payload = await response.json();
    } catch {
      throw new ApiProblem(response.status, clientFailure(requestId, "INVALID_JSON_RESPONSE"));
    }
  } else if (response.status !== 204) {
    throw new ApiProblem(response.status, clientFailure(requestId, "NON_JSON_RESPONSE"));
  }

  if (!response.ok) {
    const body = isErrorBody(payload) ? payload : clientFailure(requestId);
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfter = retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw)
      ? Number(retryAfterRaw)
      : null;
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("cfkanban:session-invalid"));
    }
    throw new ApiProblem(response.status, body, retryAfter);
  }
  return payload as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiProblem) return presentApiProblem(error, locale.value, (key) => t(key));
  if (error instanceof Error) return error.message;
  return t("error.generic");
}
