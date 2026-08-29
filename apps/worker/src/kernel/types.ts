export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
}

export interface RequestContext {
  method: string;
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
  sessionId: string;
  sourceId: string;
  sourceKind: "credential" | "web_authenticator";
  target: { [key: string]: JsonValue };
  targetKind: "admin" | "issue" | "project" | "project_selection";
}

export type AuthContext = BearerAuthContext | CookieAuthContext;
