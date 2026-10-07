export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkerEnv {
  ASSETS: Fetcher;
  ATTACHMENTS?: R2Bucket;
  DB: D1Database;
  USAGE_ANALYTICS_ENABLED?: string;
  USAGE_HISTORY_ENABLED?: string;
  CFKANBAN_CONTROL_ACCOUNT_ID?: string;
  CFKANBAN_CONTROL_WORKER_NAME?: string;
  CFKANBAN_CONTROL_DATABASE_ID?: string;
  CFKANBAN_CONFIGURATION_TOKEN?: string;
  CFKANBAN_CONTROL_TOKEN?: string;
  USAGE_ACCOUNT_ID?: string;
  USAGE_D1_DATABASE_ID?: string;
  USAGE_R2_BUCKET_NAME?: string;
  USAGE_ANALYTICS_TOKEN?: string;
  USAGE_WORKER_NAME?: string;
  USAGE_BILLING_CYCLE_DAY?: string;
  USAGE_BILLING_PLAN?: string;
  USAGE_ACCOUNT_TOTALS_ENABLED?: string;
  USAGE_WARNING_PERCENT?: string;
  USAGE_R2_STANDARD_ONLY_SCOPE?: string;
  PUBLIC_ACCESS_HOSTNAME?: string;
  PUBLIC_ACCESS_MODE?: string;
  PUBLIC_ACCESS_WAF_PROFILE?: string;
  PUBLIC_ACCESS_VERIFIED_AT?: string;
  PUBLIC_ACCESS_RULE_REF?: string;
  ANONYMOUS_LOGIN_RATE_LIMITER?: RateLimit;
  RATE_LIMIT_ANONYMOUS_LOGIN_LIMIT?: string;
  RATE_LIMIT_ANONYMOUS_LOGIN_PERIOD_SECONDS?: string;
  EXPENSIVE_READ_RATE_LIMITER?: RateLimit;
  RATE_LIMIT_EXPENSIVE_READ_LIMIT?: string;
  RATE_LIMIT_EXPENSIVE_READ_PERIOD_SECONDS?: string;
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

export interface ScopedAdministrator {
  id: string;
  principal_id: string;
  workspace_id: string;
  project_id: string | null;
  version: number;
  generation: string;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AuthenticatedPrincipal {
  displayName: string;
  isOwner: boolean;
  principalId: string;
  principalVersion: number;
  managementGrants?: ScopedAdministrator[];
}

export interface BearerAuthContext extends AuthenticatedPrincipal {
  credentialFingerprint: string;
  credentialId: string;
  kind: "bearer";
}

export interface CookieAuthContext extends AuthenticatedPrincipal {
  kind: "cookie";
  locale: "en" | "zh-CN" | null;
  theme: "orange" | "blue";
  sessionExpiresAt: number;
  sessionCreatedAt: number;
  sessionLastRenewedAt: number | null;
  sessionVersion: number;
  sessionId: string;
  sourceId: string;
  sourceKind: "credential" | "web_authenticator";
  target: { [key: string]: JsonValue };
  targetKind: "admin" | "issue" | "project" | "project_selection" | "workspace";
}

export type AuthContext = BearerAuthContext | CookieAuthContext;
