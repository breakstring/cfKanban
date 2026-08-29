export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  INSTANCE_RATE_LIMITER: RateLimit;
  PRINCIPAL_RATE_LIMITER: RateLimit;
  RATE_LIMIT_INSTANCE_LIMIT: string;
  RATE_LIMIT_INSTANCE_PERIOD_SECONDS: string;
  RATE_LIMIT_PRINCIPAL_LIMIT: string;
  RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS: string;
  RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT: string;
  RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS: string;
  UNAUTHENTICATED_RATE_LIMITER: RateLimit;
}

export interface RequestContext {
  method: string;
  params: Record<string, string>;
  requestId: string;
  startedAt: number;
  url: URL;
}

interface AuthenticatedPrincipal {
  displayName: string;
  isOwner: boolean;
  principalId: string;
  principalVersion: number;
}

export interface BearerAuthContext extends AuthenticatedPrincipal {
  credentialFingerprint: string;
  credentialId: string;
  kind: "bearer";
}

export interface CookieAuthContext extends AuthenticatedPrincipal {
  kind: "cookie";
  sessionExpiresAt: number;
  sessionId: string;
  sourceId: string;
  sourceKind: "credential" | "web_authenticator";
  target: { [key: string]: JsonValue };
  targetKind: "admin" | "issue" | "project" | "project_selection";
}

export type AuthContext = BearerAuthContext | CookieAuthContext;
