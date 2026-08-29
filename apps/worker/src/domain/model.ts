import { validationError } from "../kernel/errors.ts";
import type { JsonValue } from "../kernel/types.ts";

export const WORKFLOW_STATUSES = [
  { category: "backlog", displayName: "Backlog", key: "backlog", position: 1, terminal: false },
  { category: "unstarted", displayName: "Todo", key: "todo", position: 2, terminal: false },
  { category: "started", displayName: "In Progress", key: "in_progress", position: 3, terminal: false },
  { category: "completed", displayName: "Done", key: "done", position: 4, terminal: true },
  { category: "canceled", displayName: "Canceled", key: "canceled", position: 5, terminal: true },
] as const;

export type StatusKey = typeof WORKFLOW_STATUSES[number]["key"];
export type ProjectRole = "reader" | "writer";
export type InvitationKind = "principal_recovery" | "project_grant";
export type RecoveryMode = "full_recovery" | "rotation";
export type InvitationRedeemAs = "current_principal" | "new_principal" | "recovery";

export function isStatusKey(value: JsonValue): value is StatusKey {
  return typeof value === "string" && WORKFLOW_STATUSES.some((status) => status.key === value);
}

export function requireUuid(value: JsonValue, field: string): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export function requireVersion(value: JsonValue, field = "expected_version"): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function requireDisplayName(value: JsonValue, field = "display_name"): string {
  if (typeof value !== "string") throw validationError("schema_validation_failed", { field });
  const normalized = value.trim();
  if (normalized.length === 0 || codePointLength(normalized) > 128) {
    throw validationError("schema_validation_failed", { field });
  }
  return normalized;
}

export function requireWorkspaceKey(value: JsonValue, field = "key"): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(value)) {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export function requireProjectKey(value: JsonValue, field = "key"): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9-]{1,15}$/.test(value)) {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export function requireContext(value: JsonValue | undefined, field = "context"): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 32 * 1_024) {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export function requireHttpsOrigin(value: JsonValue, field = "preferred_api_origin"): string {
  if (typeof value !== "string") throw validationError("schema_validation_failed", { field });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError("schema_validation_failed", { field });
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || value !== url.origin
  ) {
    throw validationError("schema_validation_failed", { field });
  }
  return url.origin;
}

export function requireCredentialToken(value: JsonValue, field = "credential_token"): {
  prefix: string;
  token: string;
} {
  if (typeof value !== "string") throw validationError("schema_validation_failed", { field });
  const match = /^cfk_v1_([A-Za-z0-9]{1,64})_([A-Za-z0-9_-]{43,512})$/.exec(value);
  if (!match?.[1]) throw validationError("schema_validation_failed", { field });
  return { prefix: match[1], token: value };
}

export function requireProjectRole(value: JsonValue, field = "role"): ProjectRole {
  if (value !== "reader" && value !== "writer") {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export function requireInvitationKind(value: JsonValue, field = "kind"): InvitationKind {
  if (value !== "project_grant" && value !== "principal_recovery") {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export function requireRecoveryMode(value: JsonValue, field = "recovery_mode"): RecoveryMode {
  if (value !== "rotation" && value !== "full_recovery") {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export function requireInvitationRedeemAs(value: JsonValue, field = "redeem_as"): InvitationRedeemAs {
  if (value !== "new_principal" && value !== "current_principal" && value !== "recovery") {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function generateInvitationCode(): { code: string; prefix: string } {
  const prefix = base64Url(crypto.getRandomValues(new Uint8Array(6)));
  const secret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { code: `cfi_v1_${prefix}_${secret}`, prefix };
}

export function timestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
