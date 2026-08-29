import { sha256Hex } from "./crypto.ts";
import { ApiError, validationError } from "./errors.ts";
import { canonicalJson } from "./idempotency.ts";
import type { JsonValue } from "./types.ts";

interface CursorPayload {
  filter_hash: string;
  kind: string;
  last: JsonValue[];
  scope_hash: string;
  v: 1;
}

export interface CursorContext {
  filterHash: string;
  kind: string;
  scopeHash: string;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw validationError("invalid_cursor");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw validationError("invalid_cursor");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw validationError("invalid_cursor");
  }
}

function invalidCursor(): ApiError {
  return new ApiError({
    category: "validation",
    code: "INVALID_CURSOR",
    message: "The cursor is invalid.",
    recovery: "refresh_cursor",
    retryable: false,
    status: 400,
  });
}

function scopeMismatch(): ApiError {
  return new ApiError({
    category: "conflict",
    code: "CURSOR_SCOPE_MISMATCH",
    message: "The cursor no longer matches the requested authorization scope.",
    recovery: "refresh_cursor",
    retryable: false,
    status: 409,
  });
}

export async function createCursorContext(
  kind: string,
  filter: JsonValue,
  scopeProjectIds: readonly string[],
): Promise<CursorContext> {
  const normalizedScope = [...new Set(scopeProjectIds)].sort();
  const [filterHash, scopeHash] = await Promise.all([
    sha256Hex(canonicalJson(filter)),
    sha256Hex(canonicalJson(normalizedScope)),
  ]);
  return { filterHash, kind, scopeHash };
}

export function encodeCursor(context: CursorContext, last: JsonValue[]): string {
  const payload: CursorPayload = {
    filter_hash: context.filterHash,
    kind: context.kind,
    last,
    scope_hash: context.scopeHash,
    v: 1,
  };
  return base64UrlEncode(canonicalJson(payload as unknown as JsonValue));
}

export function decodeCursor(value: string | null, context: CursorContext): JsonValue[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(value));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidCursor();
  }
  if (
    parsed === null
    || Array.isArray(parsed)
    || typeof parsed !== "object"
    || (parsed as Partial<CursorPayload>).v !== 1
    || typeof (parsed as Partial<CursorPayload>).kind !== "string"
    || typeof (parsed as Partial<CursorPayload>).filter_hash !== "string"
    || typeof (parsed as Partial<CursorPayload>).scope_hash !== "string"
    || !Array.isArray((parsed as Partial<CursorPayload>).last)
  ) {
    throw invalidCursor();
  }
  const payload = parsed as CursorPayload;
  if (
    payload.kind !== context.kind
    || payload.filter_hash !== context.filterHash
    || payload.scope_hash !== context.scopeHash
  ) {
    throw scopeMismatch();
  }
  return payload.last;
}
