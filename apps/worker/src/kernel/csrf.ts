import { readCookie, SESSION_COOKIE_NAME } from "./auth.ts";
import { WEB_SESSION_ABSOLUTE_LIFETIME_MS } from "../domain/web-session-policy.ts";
import { timingSafeEqual } from "./crypto.ts";
import { forbidden } from "./errors.ts";
import type { AuthContext } from "./types.ts";

export const CSRF_COOKIE_NAME = "cfkanban_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";
const WEB_SESSION_MAX_AGE_SECONDS = WEB_SESSION_ABSOLUTE_LIFETIME_MS / 1_000;

export function sessionCookieMaxAge(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function serializeSessionCookie(token: string, maxAgeSeconds = WEB_SESSION_MAX_AGE_SECONDS): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function serializeCsrfCookie(token: string, maxAgeSeconds = WEB_SESSION_MAX_AGE_SECONDS): string {
  return `${CSRF_COOKIE_NAME}=${token}; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function clearCsrfCookie(): string {
  return `${CSRF_COOKIE_NAME}=; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function isReadOnlyMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export function enforceCookieWriteProtection(request: Request, auth: AuthContext): void {
  if (auth.kind === "bearer" || isReadOnlyMethod(request.method.toUpperCase())) return;

  const originHeader = request.headers.get("origin");
  if (originHeader === null) throw forbidden();
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originHeader);
  } catch {
    throw forbidden();
  }
  if (originHeader !== parsedOrigin.origin || parsedOrigin.origin !== new URL(request.url).origin) {
    throw forbidden();
  }

  const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  if (
    cookieToken === null
    || headerToken === null
    || cookieToken.length < 32
    || headerToken.length < 32
    || !timingSafeEqual(cookieToken, headerToken)
  ) {
    throw forbidden();
  }
}
