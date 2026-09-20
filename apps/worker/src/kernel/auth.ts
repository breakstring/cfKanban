import { sha256Hex } from "./crypto.ts";
import { platformUnavailable, unauthorized } from "./errors.ts";
import type { AuthContext, BearerAuthContext, CookieAuthContext, JsonValue, ScopedAdministrator } from "./types.ts";

export const SESSION_COOKIE_NAME = "cfkanban_session";

interface BearerRow {
  credential_id: string;
  display_name: string;
  owner_principal_id: string;
  principal_id: string;
  principal_version: number;
  token_prefix: string;
}

interface SessionRow {
  display_name: string;
  owner_principal_id: string;
  principal_id: string;
  principal_version: number;
  session_expires_at: number;
  session_id: string;
  source_id: string;
  source_kind: "credential" | "web_authenticator";
  target_json: string;
  target_kind: "admin" | "issue" | "project" | "project_selection" | "workspace";
}

interface ParsedCredential {
  prefix: string;
  token: string;
}

export function parseBearerCredential(header: string | null): ParsedCredential | null {
  if (header === null) return null;
  const match = /^Bearer (cfk_v1_([A-Za-z0-9]{1,64})_([A-Za-z0-9_-]{43,512}))$/.exec(header);
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[2], token: match[1] };
}

function fingerprint(prefix: string): string {
  return `cfk_v1_${prefix}_…`;
}

export async function readManagementGrants(db: D1Database, principalId: string): Promise<ScopedAdministrator[]> {
  try {
    const rows = await db.prepare(
      `SELECT a.id, a.principal_id, a.workspace_id, a.project_id, a.version,
              a.generation, a.revoked_at, a.created_at, a.updated_at
       FROM scoped_administrator_grants a
       JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN projects p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
       WHERE a.principal_id = ?1 AND a.revoked_at IS NULL AND w.deleted_at IS NULL
         AND (a.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL))
       ORDER BY a.workspace_id, a.project_id, a.id`,
    ).bind(principalId).all<ScopedAdministrator>();
    return rows.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function singleCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  const matches: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === name) matches.push(value);
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function readCookie(request: Request, name: string): string | null {
  return singleCookie(request.headers.get("cookie"), name);
}

export async function authenticateBearer(db: D1Database, header: string | null): Promise<BearerAuthContext> {
  const parsed = parseBearerCredential(header);
  if (parsed === null) throw unauthorized();
  const digest = await sha256Hex(parsed.token);

  let row: BearerRow | null;
  try {
    row = await db.prepare(
      `SELECT c.id AS credential_id, c.principal_id, c.token_prefix,
              p.display_name, p.version AS principal_version,
              im.owner_principal_id
       FROM credentials AS c
       JOIN principals AS p ON p.id = c.principal_id
       JOIN instance_meta AS im ON im.singleton = 1
       WHERE c.token_digest = ?1 AND c.revoked_at IS NULL
       LIMIT 1`,
    ).bind(digest).first<BearerRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }

  if (row === null || row.token_prefix !== parsed.prefix) throw unauthorized();
  return {
    credentialFingerprint: fingerprint(parsed.prefix),
    credentialId: row.credential_id,
    displayName: row.display_name,
    isOwner: row.principal_id === row.owner_principal_id,
    kind: "bearer",
    principalId: row.principal_id,
    principalVersion: row.principal_version,
    managementGrants: row.principal_id === row.owner_principal_id ? [] : await readManagementGrants(db, row.principal_id),
  };
}

export async function authenticateCookieSession(
  db: D1Database,
  request: Request,
  now = Date.now(),
): Promise<CookieAuthContext> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (token === null || !/^[A-Za-z0-9_-]{43,512}$/.test(token)) throw unauthorized(token !== null);
  const digest = await sha256Hex(token);

  let row: SessionRow | null;
  try {
    row = await db.prepare(
      `SELECT ws.id AS session_id, ws.principal_id, ws.source_kind, ws.source_id,
              ws.target_kind, ws.target_json, ws.expires_at AS session_expires_at,
              p.display_name,
              p.version AS principal_version, im.owner_principal_id
       FROM web_sessions AS ws
       JOIN principals AS p ON p.id = ws.principal_id
       JOIN instance_meta AS im ON im.singleton = 1
       WHERE ws.token_digest = ?1
         AND ws.revoked_at IS NULL
         AND ws.expires_at > ?2
         AND (
           (ws.source_kind = 'credential' AND EXISTS (
             SELECT 1 FROM credentials AS c
             WHERE c.id = ws.source_id
               AND c.principal_id = ws.principal_id
               AND c.revoked_at IS NULL
           ))
           OR
           (ws.source_kind = 'web_authenticator' AND EXISTS (
             SELECT 1 FROM web_authenticators AS wa
             WHERE wa.id = ws.source_id
               AND wa.principal_id = ws.principal_id
               AND wa.revoked_at IS NULL
           ))
         )
       LIMIT 1`,
    ).bind(digest, now).first<SessionRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }

  if (row === null) throw unauthorized(true);
  let target: { [key: string]: JsonValue };
  try {
    const parsed = JSON.parse(row.target_json) as JsonValue;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    target = parsed;
  } catch {
    throw unauthorized(true);
  }

  return {
    displayName: row.display_name,
    isOwner: row.principal_id === row.owner_principal_id,
    kind: "cookie",
    principalId: row.principal_id,
    principalVersion: row.principal_version,
    managementGrants: row.principal_id === row.owner_principal_id ? [] : await readManagementGrants(db, row.principal_id),
    sessionExpiresAt: row.session_expires_at,
    sessionId: row.session_id,
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    target,
    targetKind: row.target_kind,
  };
}

export async function authenticateRequest(
  db: D1Database,
  request: Request,
  now = Date.now(),
): Promise<AuthContext> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) return authenticateBearer(db, authorization);
  return authenticateCookieSession(db, request, now);
}
