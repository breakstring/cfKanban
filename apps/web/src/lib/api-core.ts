export interface LocalErrorBody {
  category: string;
  code: string;
  details: Record<string, unknown>;
  message: string;
  recovery: string;
  request_id: string;
  retry_after_seconds?: number;
  retryable: boolean;
  source: "client_transport" | "cloudflare_platform";
}

interface PendingIntent {
  idempotencyKey: string;
  touchedAt: number;
}

export class PendingIntentKeys {
  readonly #entries = new Map<string, PendingIntent>();
  readonly #createKey: () => string;
  readonly #ttlMs: number;

  constructor(
    createKey: () => string,
    ttlMs = 24 * 60 * 60 * 1000,
  ) {
    this.#createKey = createKey;
    this.#ttlMs = ttlMs;
  }

  acquire(method: string, path: string, body: unknown, now = Date.now()): { key: string; signature: string } {
    for (const [signature, intent] of this.#entries) {
      if (intent.touchedAt + this.#ttlMs <= now) this.#entries.delete(signature);
    }
    const signature = `${method}\n${path}\n${canonicalJson(body)}`;
    const existing = this.#entries.get(signature);
    if (existing !== undefined) {
      existing.touchedAt = now;
      return { key: existing.idempotencyKey, signature };
    }
    const key = this.#createKey();
    this.#entries.set(signature, { idempotencyKey: key, touchedAt: now });
    return { key, signature };
  }

  complete(signature: string): void {
    this.#entries.delete(signature);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

export function normalizedFailure(
  requestId: string,
  input: {
    category: string;
    code: string;
    component?: string;
    providerRequestId?: string | null;
    recovery: string;
    retryAfter?: number | null;
    retryable: boolean;
    source: "client_transport" | "cloudflare_platform";
  },
): LocalErrorBody {
  const details: Record<string, unknown> = { normalized_by: "client" };
  if (input.component !== undefined) details.component = input.component;
  if (input.providerRequestId) details.provider_request_id = input.providerRequestId;
  return {
    category: input.category,
    code: input.code,
    details,
    message: "The service response could not be verified.",
    recovery: input.recovery,
    request_id: requestId,
    retryable: input.retryable,
    source: input.source,
    ...(input.retryAfter === null || input.retryAfter === undefined
      ? {}
      : { retry_after_seconds: input.retryAfter }),
  };
}

export function normalizeOuterHttp(
  status: number,
  headers: Headers,
  text: string,
  requestId: string,
): { body: LocalErrorBody; retryAfter: number | null; status: number } {
  const retryAfter = retryAfterSeconds(headers.get("retry-after"));
  const providerRequestId = headers.get("cf-ray");
  const isCloudflare = providerRequestId !== null
    || headers.get("server")?.toLowerCase().includes("cloudflare") === true;
  if (isCloudflare && /(?:^|\D)1027(?:\D|$)/.test(text)) {
    return {
      body: normalizedFailure(requestId, {
        category: "platform_quota",
        code: "PLATFORM_QUOTA_EXCEEDED",
        component: "workers",
        providerRequestId,
        recovery: "wait_for_platform_reset",
        retryable: true,
        source: "cloudflare_platform",
      }),
      retryAfter: null,
      status: 503,
    };
  }
  if (status === 429) {
    return {
      body: normalizedFailure(requestId, {
        category: "rate_limit",
        code: "RATE_LIMITED",
        providerRequestId,
        recovery: "retry_after",
        retryAfter,
        retryable: true,
        source: "cloudflare_platform",
      }),
      retryAfter,
      status: 429,
    };
  }
  return {
    body: normalizedFailure(requestId, {
      category: "platform_failure",
      code: "PLATFORM_UNAVAILABLE",
      providerRequestId,
      recovery: "request_owner",
      retryable: false,
      source: "cloudflare_platform",
    }),
    retryAfter: null,
    status: 503,
  };
}
