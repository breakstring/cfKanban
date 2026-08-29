import type { JsonValue } from "./types.ts";

export type ErrorCategory =
  | "authentication"
  | "authorization"
  | "business_quota"
  | "conflict"
  | "not_found"
  | "platform_failure"
  | "platform_quota"
  | "rate_limit"
  | "validation";

export type ErrorSource = "cloudflare_platform" | "service";

interface ApiErrorOptions {
  category: ErrorCategory;
  code: string;
  details?: Record<string, unknown>;
  message: string;
  recovery: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  source?: ErrorSource;
  status: number;
}

const sensitiveDetailKey = /(?:authorization|cookie|credential_token|session_secret|session_token|token_digest|code_digest|challenge_digest|invite_code|launch_code|request_body|raw_error|sql|statement|stack|bookmark|table(?:_name)?)/i;
const secretStringPatterns = [
  /\bBearer\s+\S+/i,
  /\bCookie\s*:\s*\S+/i,
  /cfk_v1_[A-Za-z0-9]+_[A-Za-z0-9_-]+/,
  /cfi_v1_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/,
  /cfl_v1_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/,
  /\b[0-9a-f]{64}\b/i,
  /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b[\s\S]*/i,
  /\n\s*at\s+\S+/,
];

export class ApiError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details: Record<string, JsonValue>;
  readonly recovery: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly source: ErrorSource;
  readonly status: number;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.category = options.category;
    this.code = options.code;
    this.details = sanitizeDetails(options.details ?? {});
    this.recovery = options.recovery;
    this.retryable = options.retryable;
    this.retryAfterSeconds = normalizeRetryAfter(options.retryAfterSeconds);
    this.source = options.source ?? "service";
    this.status = options.status;
  }
}

function normalizeRetryAfter(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function sanitizeValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (secretStringPatterns.some((pattern) => pattern.test(value))) return "[REDACTED]";
    return value.slice(0, 2_048);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).flatMap((entry) => {
      const sanitized = sanitizeValue(entry);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (typeof value === "object") {
    const sanitized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      if (sensitiveDetailKey.test(key)) continue;
      const sanitizedEntry = sanitizeValue(entry);
      if (sanitizedEntry !== undefined) sanitized[key] = sanitizedEntry;
    }
    return sanitized;
  }
  return undefined;
}

export function sanitizeDetails(details: Record<string, unknown>): Record<string, JsonValue> {
  return (sanitizeValue(details) as Record<string, JsonValue> | undefined) ?? {};
}

export function validationError(reason: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError({
    category: "validation",
    code: "VALIDATION_ERROR",
    details: { reason, ...details },
    message: "The request is invalid.",
    recovery: "none",
    retryable: false,
    status: 400,
  });
}

export function payloadTooLarge(): ApiError {
  return new ApiError({
    category: "validation",
    code: "PAYLOAD_TOO_LARGE",
    details: { limit_bytes: 128 * 1_024 },
    message: "The JSON request body exceeds the allowed size.",
    recovery: "none",
    retryable: false,
    status: 413,
  });
}

export function unauthorized(): ApiError {
  return new ApiError({
    category: "authentication",
    code: "UNAUTHORIZED",
    message: "Authentication is required.",
    recovery: "reauthenticate",
    retryable: false,
    status: 401,
  });
}

export function forbidden(): ApiError {
  return new ApiError({
    category: "authorization",
    code: "FORBIDDEN",
    message: "The requested action is not allowed.",
    recovery: "none",
    retryable: false,
    status: 403,
  });
}

export function notFound(): ApiError {
  return new ApiError({
    category: "not_found",
    code: "NOT_FOUND",
    message: "The requested resource was not found.",
    recovery: "none",
    retryable: false,
    status: 404,
  });
}

export function versionConflict(currentVersion?: number): ApiError {
  return new ApiError({
    category: "conflict",
    code: "VERSION_CONFLICT",
    details: currentVersion === undefined ? {} : { current_version: currentVersion },
    message: "The resource version changed.",
    recovery: "refresh_resource",
    retryable: false,
    status: 409,
  });
}

export function invalidTransition(): ApiError {
  return new ApiError({
    category: "conflict",
    code: "INVALID_TRANSITION",
    message: "The requested status transition must use its dedicated command.",
    recovery: "refresh_resource",
    retryable: false,
    status: 409,
  });
}

export function assigneeNotEligible(): ApiError {
  return new ApiError({
    category: "conflict",
    code: "ASSIGNEE_NOT_ELIGIBLE",
    message: "The selected Principal is not eligible for assignment in this Project.",
    recovery: "refresh_resource",
    retryable: false,
    status: 409,
  });
}

export function conflict(
  code: string,
  recovery = "refresh_resource",
  details: Record<string, unknown> = {},
): ApiError {
  return new ApiError({
    category: "conflict",
    code,
    details,
    message: "The requested operation conflicts with the current resource state.",
    recovery,
    retryable: false,
    status: 409,
  });
}

export function gone(code: string, recovery = "request_new_invitation"): ApiError {
  return new ApiError({
    category: "conflict",
    code,
    message: "The one-time capability is no longer available.",
    recovery,
    retryable: false,
    status: 410,
  });
}

export function invitationModeMismatch(): ApiError {
  return new ApiError({
    category: "validation",
    code: "INVITATION_MODE_MISMATCH",
    message: "The requested redemption mode does not match this Invitation.",
    recovery: "none",
    retryable: false,
    status: 400,
  });
}

export function recoveryPrincipalMismatch(): ApiError {
  return new ApiError({
    category: "authorization",
    code: "RECOVERY_PRINCIPAL_MISMATCH",
    message: "The authenticated Principal does not match this recovery Invitation.",
    recovery: "none",
    retryable: false,
    status: 403,
  });
}

export function businessQuotaExceeded(
  dimension: "comments" | "issues" | "principals",
  currentUsage?: number,
  limit?: number,
): ApiError {
  const resourceKind = dimension === "comments" ? "comment" : dimension === "issues" ? "issue" : "principal";
  const code = dimension === "comments"
    ? "PROJECT_COMMENT_LIMIT_REACHED"
    : dimension === "issues"
      ? "PROJECT_ISSUE_LIMIT_REACHED"
      : "PROJECT_PRINCIPAL_LIMIT_REACHED";
  return new ApiError({
    category: "business_quota",
    code,
    details: {
      resource_kind: resourceKind,
      ...(currentUsage === undefined ? {} : { current_usage: currentUsage }),
      ...(limit === undefined ? {} : { limit }),
    },
    message: "The Project active quota does not allow this operation.",
    recovery: "free_capacity_or_request_owner",
    retryable: false,
    status: 409,
  });
}

export function platformUnavailable(component: "d1" | "worker" = "worker"): ApiError {
  return new ApiError({
    category: "platform_failure",
    code: "PLATFORM_UNAVAILABLE",
    details: { component, failure_class: "unavailable" },
    message: "The service is temporarily unavailable.",
    recovery: "request_owner",
    retryable: false,
    source: component === "d1" ? "cloudflare_platform" : "service",
    status: 503,
  });
}

export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : platformUnavailable();
}

export function errorResponse(error: unknown, requestId: string): Response {
  const apiError = toApiError(error);
  const body = {
    code: apiError.code,
    category: apiError.category,
    source: apiError.source,
    message: apiError.message,
    request_id: requestId,
    retryable: apiError.retryable,
    recovery: apiError.recovery,
    details: apiError.details,
    ...(apiError.retryAfterSeconds === undefined
      ? {}
      : { retry_after_seconds: apiError.retryAfterSeconds }),
  };
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  if (apiError.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(apiError.retryAfterSeconds));
  }
  return new Response(JSON.stringify(body), { headers, status: apiError.status });
}
