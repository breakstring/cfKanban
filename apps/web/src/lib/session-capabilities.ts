import type { IssueDetail, WebSessionView } from "../types";

export function canAccessOwnerControlPlane(session: WebSessionView): boolean {
  return session.principal.is_owner && session.allowed_scope.kind === "instance";
}

export function canRegisterPasskeyFromSession(
  session: WebSessionView,
  browserSupportsPasskeys: boolean,
): boolean {
  return browserSupportsPasskeys && session.source.kind === "credential";
}

export function safeWebEntryPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const base = new URL("https://cfkanban.invalid");
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    return null;
  }
  if (
    parsed.origin !== base.origin
    || parsed.hash !== ""
    || !/^\/app(?:\/|$)/u.test(parsed.pathname)
  ) return null;
  return `${parsed.pathname}${parsed.search}`;
}

export function canCreateIssueRelation(
  source: IssueDetail | null,
  target: IssueDetail | null,
): boolean {
  return source !== null
    && target !== null
    && source.identifier !== target.identifier
    && source.workspace.key === target.workspace.key
    && source.allowed_actions.includes("update")
    && target.allowed_actions.includes("update");
}
