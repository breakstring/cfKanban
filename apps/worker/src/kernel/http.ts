import { payloadTooLarge, validationError } from "./errors.ts";
import type { JsonValue, RequestContext } from "./types.ts";

export const MAX_JSON_BYTES = 128 * 1_024;

export type JsonValidator = (value: JsonValue) => boolean;

export interface JsonObjectSchema {
  allowedKeys: readonly string[];
  requiredKeys?: readonly string[];
  validators?: Readonly<Record<string, JsonValidator>>;
}

export function createRequestContext(request: Request): RequestContext {
  return {
    method: request.method.toUpperCase(),
    requestId: crypto.randomUUID(),
    startedAt: Date.now(),
    url: new URL(request.url),
  };
}

export function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function jsonResponse(
  value: JsonValue,
  requestId: string,
  init: Omit<ResponseInit, "headers"> & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-request-id", requestId);
  return new Response(JSON.stringify(value), { ...init, headers });
}

function parseDeclaredLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw validationError("invalid_content_length");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw payloadTooLarge();
  return length;
}

export async function readJsonBody(request: Request): Promise<JsonValue> {
  const declaredLength = parseDeclaredLength(request);
  if (declaredLength !== null && declaredLength > MAX_JSON_BYTES) throw payloadTooLarge();

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw validationError("content_type_must_be_json");
  }
  if (request.body === null) throw validationError("json_body_required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw payloadTooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw validationError("invalid_utf8");
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw validationError("invalid_json");
  }
}

function safeFieldName(value: string): string {
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "unknown";
}

export function validateJsonObject(
  value: JsonValue,
  schema: JsonObjectSchema,
): { [key: string]: JsonValue } {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw validationError("object_required");
  }

  const allowed = new Set(schema.allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw validationError("unknown_field", { field: safeFieldName(key) });
    }
  }
  for (const key of schema.requiredKeys ?? []) {
    if (!(key in value)) {
      throw validationError("required_field_missing", { field: safeFieldName(key) });
    }
  }
  for (const [key, validator] of Object.entries(schema.validators ?? {})) {
    if (key in value && !validator(value[key] as JsonValue)) {
      throw validationError("schema_validation_failed", { field: safeFieldName(key) });
    }
  }
  return value;
}
