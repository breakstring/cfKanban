import { validationError } from "../kernel/errors.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";

export function actorCredentialId(auth: AuthContext): string | null {
  if (auth.kind === "bearer") return auth.credentialId;
  return auth.sourceKind === "credential" ? auth.sourceId : null;
}

export function authorizedVia(auth: AuthContext, ownerAction = false): string {
  if (ownerAction || auth.isOwner) return "deployment_owner";
  return auth.kind === "cookie" ? "web_session" : "project_grant";
}

export function opaqueEventCursor(sequence: number): string {
  const json = JSON.stringify({ sequence, v: 1 });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function writeResult(
  resource: { [key: string]: JsonValue },
  lastEventSequence: number,
  idempotentReplay: boolean,
): { [key: string]: JsonValue } {
  return {
    event_cursor: opaqueEventCursor(lastEventSequence),
    idempotent_replay: idempotentReplay,
    resource,
  };
}

export function requireIdempotencyKey(request: Request): string {
  return request.headers.get("idempotency-key") ?? "";
}

export function requireLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 20;
  if (!/^[1-9][0-9]*$/.test(raw)) throw validationError("invalid_limit");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > 100) throw validationError("invalid_limit");
  return limit;
}

export function requireDeletedMode(url: URL): "exclude" | "only" {
  const deleted = url.searchParams.get("deleted") ?? "exclude";
  if (deleted !== "exclude" && deleted !== "only") throw validationError("invalid_deleted_filter");
  return deleted;
}
