import { isSessionReference } from "./session-reference.mjs";
export { isSessionReference } from "./session-reference.mjs";

export const EMBED_PROTOCOL = 1;
export const ACTION_LIMIT_BYTES = 65_536;
export const SNAPSHOT_LIMIT_BYTES = 2_097_152;
export const ISSUE_COLLECTION_LIMIT = 1000;

export type EmbedLocale = "en" | "zh-CN";
export type AssignmentFilter = "all" | "mine" | "unassigned";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type Status = "backlog" | "todo" | "in_progress" | "done" | "canceled";
export type IssueChange = { status_key?: Exclude<Status, "done">; priority_key?: Priority; assignee_principal_id?: string | null };
export type Artifact = { kind: "commit" | "other" | "path" | "url"; value: string };
export type ActionPayloads = {
  scope_retry: Record<string, never>;
  scope_page: { next: boolean };
  scope_bind: { target_id: string };
  manual: Record<string, never>;
  select_instance: { instance_id: string };
  workspaces: { next?: boolean };
  select_workspace: { workspace_id: string; next?: boolean };
  bind: { project_id: string };
  unbind: Record<string, never>;
  filters: { assignment: AssignmentFilter; status: Status | ""; priority: Priority | "" };
  page: { next: boolean };
  view: { mode: "list" | "board" };
  board_page: { status_key: Status; next: boolean };
  assignees: { next: boolean };
  labels: { next: boolean };
  set_locale: { locale: EmbedLocale };
  quick_update: { identifier: string; change: IssueChange };
  open_issue: { identifier: string };
  issue_back: Record<string, never>;
  comments: Record<string, never>;
  mutate: { operation: "update"; change: IssueChange }
    | { operation: "label_add" | "label_remove"; change: { label_id: string } }
    | { operation: "comment"; change: { body: string } }
    | { operation: "complete"; change: { summary: string; verification?: string[]; artifacts?: Artifact[]; follow_ups?: string[] } };
  recover: Record<string, never>;
};
export type EmbedAction = keyof ActionPayloads;
export type ActionMessage = { [K in EmbedAction]: { type: "action"; id: string; action: K; payload: ActionPayloads[K] } }[EmbedAction];
export type PublicError = { code: string; message?: string };
export type PublicResult = { ok: boolean; error?: PublicError; outcome_unknown?: boolean };
export type RenderTarget = { instance_id: string; principal_id: string; workspace_id: string; project_id: string; identifier?: string };
export type RenderCheckMessage = { type: "render_check"; id: string; target: RenderTarget };
export type RenderedMessage = { type: "rendered"; id: string; target: RenderTarget };
export type RenderCancelMessage = { type: "render_cancel"; id: string };
export type PublicResource = { id?: string; instance_id?: string; principal_id?: string; display_name?: string; title?: string; name?: string; api_origin?: string; trusted_api_origin?: string; origin?: string; role?: string; available?: boolean };
export type PublicIdentity = { instance: PublicResource; principal: PublicResource };
export type PublicStatus = { key: Status; display_name?: string; name?: string };
export type PublicLabel = { id: string; name: string };
export type PublicIssue = {
  id?: string;
  identifier: string;
  title: string;
  body?: string;
  version: number;
  status: { key: Status; display_name?: string };
  priority: Priority;
  assignee?: PublicResource | null;
  labels?: PublicLabel[];
  allowed_actions?: string[];
  completion?: unknown;
  completion_record?: unknown;
  is_blocked?: boolean;
};
export type PublicComment = { id: string; body?: string; created_at?: string; author?: PublicResource; principal?: PublicResource; completion_record?: unknown; kind?: string; completion?: unknown };
export type ScopeTarget = { id: string; display_name?: string; project_id?: string; available: boolean; unavailability?: string | PublicError };
export type EmbedSnapshot = {
  candidates: PublicResource[];
  identity: PublicIdentity | null;
  workspaces: PublicResource[];
  projects: PublicResource[];
  workspace_id?: string;
  workspace_has_more?: boolean;
  project_has_more?: boolean;
  binding: { project: PublicResource; identity?: PublicIdentity | null; principal?: PublicResource; instance?: PublicResource; statuses: PublicStatus[] } | null;
  view?: "list" | "board";
  board?: { columns: { key: Status; display_name?: string; items: PublicIssue[]; has_more: boolean; capacity_reached?: boolean }[] } | null;
  assignees?: { principal_id: string; display_name: string }[];
  assignees_has_more?: boolean;
  labels?: PublicLabel[];
  labels_has_more?: boolean;
  page: { items?: PublicIssue[]; issues?: PublicIssue[]; next_cursor?: string | null; continuation?: { next_cursor?: string | null }; capacity_reached?: boolean } | null;
  issue: PublicIssue | null;
  comments: PublicComment[];
  comments_has_more?: boolean;
  filters: { assignment: AssignmentFilter; status: Status | ""; priority: Priority | "" };
  busy: number;
  error: PublicError | null;
  pending: { identifier?: string; version?: number; expected_version?: number; idempotency_key?: string; key?: string; operation?: string } | null;
  source_session_id?: string | null;
  session_context_changed?: boolean;
  workspace_scope: { status: string } | null;
  scope_mode: "manual" | "suggested";
  scope_targets: ScopeTarget[];
  scope_next_offset: number | null;
  scope_fallback?: string;
  capabilities: { update: boolean; comment: boolean; complete: boolean };
  notice?: string;
  locale?: EmbedLocale;
  theme?: "orange" | "blue";
};

const priorities = new Set(["none", "low", "medium", "high", "urgent"]);
const statuses = new Set(["backlog", "todo", "in_progress", "done", "canceled"]);
const actions = new Set<string>(["scope_retry", "scope_page", "scope_bind", "manual", "select_instance", "workspaces", "select_workspace", "bind", "unbind", "filters", "page", "open_issue", "issue_back", "comments", "mutate", "recover", "view", "board_page", "assignees", "quick_update", "labels", "set_locale"]);
const snapshotFields = new Set(["candidates", "identity", "workspaces", "projects", "workspace_id", "workspace_has_more", "project_has_more", "binding", "page", "issue", "comments", "comments_has_more", "filters", "busy", "error", "pending", "view", "board", "assignees", "assignees_has_more", "source_session_id", "session_context_changed", "workspace_scope", "scope_mode", "scope_targets", "scope_next_offset", "scope_fallback", "capabilities", "notice", "locale", "theme", "labels", "labels_has_more"]);
const privateFields = /^(?:__proto__|prototype|constructor|token|access_token|refresh_token|credential|credentials|secret|csrf_token|cookie|cookies|authorization|binding_id|preview_id|dsh_workspace_id|stateRoot|state_root)$/i;

function record(value: unknown, fields: readonly string[], required: readonly string[] = fields): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every(key => fields.includes(key))
    && required.every(key => Object.hasOwn(value, key));
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max && value.trim().length > 0; }
function member(value: unknown, values: ReadonlySet<string> | readonly string[]): value is string { return typeof value === "string" && (Array.isArray(values) ? values.includes(value) : (values as ReadonlySet<string>).has(value)); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function issueIdentifier(value: unknown): value is string { return typeof value === "string" && /^[A-Z][A-Z0-9]{1,11}-[1-9][0-9]{0,14}$/.test(value); }
export function parseRenderTarget(value: unknown): RenderTarget | null {
  if (!record(value, ["instance_id", "principal_id", "workspace_id", "project_id", "identifier"], ["instance_id", "principal_id", "workspace_id", "project_id"])
    || ![value.instance_id, value.principal_id, value.workspace_id, value.project_id].every(uuid)
    || (value.identifier !== undefined && !issueIdentifier(value.identifier))) return null;
  return { instance_id: value.instance_id, principal_id: value.principal_id, workspace_id: value.workspace_id, project_id: value.project_id, ...(value.identifier === undefined ? {} : { identifier: value.identifier }) } as RenderTarget;
}
export function snapshotRenderTarget(state: EmbedSnapshot): RenderTarget | null {
  if (!state.binding) return null;
  const identity = state.binding.identity ?? state.identity;
  const instance = identity?.instance ?? state.binding.instance;
  const principal = identity?.principal ?? state.binding.principal;
  return parseRenderTarget({ instance_id: instance?.instance_id ?? instance?.id, principal_id: principal?.principal_id ?? principal?.id, workspace_id: state.workspace_id, project_id: state.binding.project.id, ...(state.issue ? { identifier: state.issue.identifier } : {}) });
}
export function sameRenderTarget(left: RenderTarget | null, right: RenderTarget | null): boolean {
  return Boolean(left && right && left.instance_id === right.instance_id && left.principal_id === right.principal_id && left.workspace_id === right.workspace_id && left.project_id === right.project_id && left.identifier === right.identifier);
}
export function parseRenderCheckMessage(value: unknown): RenderCheckMessage | null {
  return record(value, ["type", "id", "target"]) && value.type === "render_check" && uuid(value.id) && parseRenderTarget(value.target) ? value as RenderCheckMessage : null;
}
export function parseRenderedMessage(value: unknown): RenderedMessage | null {
  return record(value, ["type", "id", "target"]) && value.type === "rendered" && uuid(value.id) && parseRenderTarget(value.target) ? value as RenderedMessage : null;
}
export function parseRenderCancelMessage(value: unknown): RenderCancelMessage | null {
  return record(value, ["type", "id"]) && value.type === "render_cancel" && uuid(value.id) ? value as RenderCancelMessage : null;
}
function list(value: unknown, max = 1024): value is string[] { return Array.isArray(value) && value.length <= 50 && value.every(item => text(item, max)); }
function boundedJson(value: unknown, limit: number, forbidPrivate = false): boolean {
  let count = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    if (++count > 20_000 || depth > 20) return false;
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry === "string") return entry.length <= 262_144;
    if (Array.isArray(entry)) return entry.length <= 1000 && entry.every(item => visit(item, depth + 1));
    if (typeof entry !== "object" || Object.getPrototypeOf(entry) !== Object.prototype) return false;
    return Object.entries(entry).every(([key, item]) => key.length <= 100 && (!forbidPrivate || !privateFields.test(key)) && visit(item, depth + 1));
  };
  try { return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= limit; } catch { return false; }
}

function validChange(value: unknown): boolean {
  return record(value, ["status_key", "priority_key", "assignee_principal_id"], []) && Object.keys(value).length > 0
    && (value.status_key === undefined || value.status_key !== "done" && member(value.status_key, statuses))
    && (value.priority_key === undefined || member(value.priority_key, priorities))
    && (value.assignee_principal_id === undefined || value.assignee_principal_id === null || uuid(value.assignee_principal_id));
}

export function parseActionMessage(value: unknown): ActionMessage | null {
  if (!boundedJson(value, ACTION_LIMIT_BYTES) || !record(value, ["type", "id", "action", "payload"]) || value.type !== "action" || !uuid(value.id) || typeof value.action !== "string" || !actions.has(value.action)) return null;
  const p = value.payload;
  let valid = false;
  switch (value.action) {
    case "scope_retry": case "manual": case "unbind": case "issue_back": case "comments": case "recover": valid = record(p, []); break;
    case "scope_page": case "page": case "assignees": case "labels": valid = record(p, ["next"]) && typeof p.next === "boolean"; break;
    case "set_locale": valid = record(p, ["locale"]) && member(p.locale, ["en", "zh-CN"]); break;
    case "scope_bind": valid = record(p, ["target_id"]) && text(p.target_id, 160); break;
    case "select_instance": valid = record(p, ["instance_id"]) && uuid(p.instance_id); break;
    case "workspaces": valid = record(p, ["next"], []) && (p.next === undefined || typeof p.next === "boolean"); break;
    case "select_workspace": valid = record(p, ["workspace_id", "next"], ["workspace_id"]) && uuid(p.workspace_id) && (p.next === undefined || typeof p.next === "boolean"); break;
    case "bind": valid = record(p, ["project_id"]) && uuid(p.project_id); break;
    case "filters": valid = record(p, ["assignment", "status", "priority"]) && member(p.assignment, ["all", "mine", "unassigned"]) && (p.status === "" || member(p.status, statuses)) && (p.priority === "" || member(p.priority, priorities)); break;
    case "open_issue": valid = record(p, ["identifier"]) && issueIdentifier(p.identifier); break;
    case "view": valid = record(p, ["mode"]) && member(p.mode, ["list", "board"]); break;
    case "board_page": valid = record(p, ["status_key", "next"]) && member(p.status_key, statuses) && typeof p.next === "boolean"; break;
    case "quick_update": valid = record(p, ["identifier", "change"]) && issueIdentifier(p.identifier) && validChange(p.change); break;
    case "mutate": {
      if (!record(p, ["operation", "change"])) break;
      if (p.operation === "update") valid = validChange(p.change);
      if (p.operation === "label_add" || p.operation === "label_remove") valid = record(p.change, ["label_id"]) && uuid(p.change.label_id);
      if (p.operation === "comment") valid = record(p.change, ["body"]) && text(p.change.body, 32_768);
      if (p.operation === "complete") valid = record(p.change, ["summary", "verification", "artifacts", "follow_ups"], ["summary"]) && typeof p.change.summary === "string" && p.change.summary.length <= 8192
        && (p.change.verification === undefined || list(p.change.verification)) && (p.change.follow_ups === undefined || list(p.change.follow_ups, 2048))
        && (p.change.artifacts === undefined || (Array.isArray(p.change.artifacts) && p.change.artifacts.length <= 50 && p.change.artifacts.every(item => record(item, ["kind", "value"]) && member(item.kind, ["commit", "other", "path", "url"]) && text(item.value, 2048))));
      break;
    }
  }
  return valid ? value as ActionMessage : null;
}

export function parseSnapshotMessage(value: unknown): { type: "snapshot"; state: EmbedSnapshot } | null {
  if (!record(value, ["type", "state"]) || value.type !== "snapshot" || !boundedJson(value.state, SNAPSHOT_LIMIT_BYTES, true)) return null;
  const s = value.state;
  if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some(key => !snapshotFields.has(key))) return null;
  const state = s as Record<string, unknown>;
  const ordinary = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  const optionalString = (value: unknown, max = 8192) => value === undefined || (typeof value === "string" && value.length <= max);
  const resource = (value: unknown) => ordinary(value) && ["id", "instance_id", "principal_id"].every(key => value[key] === undefined || uuid(value[key])) && ["display_name", "title", "name", "api_origin", "trusted_api_origin", "origin", "role"].every(key => optionalString(value[key])) && (value.available === undefined || typeof value.available === "boolean");
  const identity = (value: unknown) => value === null || (ordinary(value) && resource(value.instance) && resource(value.principal));
  const status = (value: unknown) => ordinary(value) && typeof value.key === "string" && statuses.has(value.key) && optionalString(value.display_name) && optionalString(value.name);
  const labels = (value: unknown) => Array.isArray(value) && value.length <= 1000 && value.every(label => record(label, ["id", "name"]) && uuid(label.id) && text(label.name, 128)) && new Set(value.map(label => label.id)).size === value.length;
  const issue = (value: unknown) => ordinary(value) && issueIdentifier(value.identifier) && text(value.title, 8192) && optionalString(value.body, 262_144)
    && Number.isSafeInteger(value.version) && Number(value.version) > 0 && status(value.status) && typeof value.priority === "string" && priorities.has(value.priority)
    && (value.assignee === undefined || value.assignee === null || resource(value.assignee)) && (value.is_blocked === undefined || typeof value.is_blocked === "boolean")
    && (value.labels === undefined || labels(value.labels))
    && (value.allowed_actions === undefined || (Array.isArray(value.allowed_actions) && value.allowed_actions.length <= 50 && value.allowed_actions.every(item => text(item, 100))));
  const nullableIssue = (value: unknown) => value === null || issue(value);
  const summaryRows = (value: unknown): boolean => {
    if (!Array.isArray(value) || value.length > ISSUE_COLLECTION_LIMIT) return false;
    const seen = new Set();
    return value.every(row => {
      if (!record(row, ["id", "identifier", "title", "version", "priority", "status", "assignee", "labels", "allowed_actions", "is_blocked"], ["identifier", "title", "version", "priority", "status"]) || !issue(row) || seen.has(row.identifier)) return false;
      seen.add(row.identifier); return true;
    });
  };
  const nullableUuid = (value: unknown) => value === undefined || value === null || uuid(value);
  const nullableSession = (value: unknown) => value === undefined || value === null || isSessionReference(value);
  const error = (value: unknown) => value === null || (record(value, ["code", "message"], ["code"]) && text(value.code, 100) && optionalString(value.message, 1024));
  const pending = (value: unknown) => value === null || (ordinary(value) && (value.identifier === undefined || issueIdentifier(value.identifier))
    && ["version", "expected_version"].every(key => value[key] === undefined || (Number.isSafeInteger(value[key]) && Number(value[key]) > 0))
    && ["idempotency_key", "key", "request_id"].every(key => nullableUuid(value[key]))
    && ["source_session_id", "session_id"].every(key => nullableSession(value[key])));
  if (!["candidates", "workspaces", "projects", "comments", "scope_targets"].every(key => Array.isArray(state[key]))
    || !record(state.filters, ["assignment", "status", "priority"])
    || !member(state.filters.assignment, ["all", "mine", "unassigned"]) || (state.filters.status !== "" && !member(state.filters.status, statuses)) || (state.filters.priority !== "" && !member(state.filters.priority, priorities))
    || !record(state.capabilities, ["update", "comment", "complete"])
    || !Object.values(state.capabilities).every(value => typeof value === "boolean")
    || !member(state.scope_mode, ["manual", "suggested"]) || !Number.isSafeInteger(state.busy) || Number(state.busy) < 0
    || !identity(state.identity) || !nullableIssue(state.issue) || !error(state.error) || !pending(state.pending)
    || !(state.candidates as unknown[]).every(value => resource(value) && uuid((value as Record<string, unknown>).instance_id))
    || !(state.workspaces as unknown[]).every(value => resource(value) && uuid((value as Record<string, unknown>).id))
    || !(state.projects as unknown[]).every(value => resource(value) && uuid((value as Record<string, unknown>).id))
    || !(state.comments as unknown[]).every(value => ordinary(value) && uuid(value.id) && optionalString(value.body, 262_144) && optionalString(value.created_at, 100) && (value.author === undefined || resource(value.author)) && (value.principal === undefined || resource(value.principal)))
    || !(state.scope_targets as unknown[]).every(value => ordinary(value) && text(value.id, 160) && typeof value.available === "boolean" && optionalString(value.display_name) && (value.project_id === undefined || uuid(value.project_id)) && (value.unavailability === undefined || text(value.unavailability, 100) || error(value.unavailability)))
    || !nullableUuid(state.workspace_id) || !nullableSession(state.source_session_id)
    || !["workspace_has_more", "project_has_more", "comments_has_more", "session_context_changed", "assignees_has_more", "labels_has_more"].every(key => state[key] === undefined || typeof state[key] === "boolean")
    || !(state.scope_next_offset === null || (Number.isSafeInteger(state.scope_next_offset) && Number(state.scope_next_offset) >= 0))
    || !(state.workspace_scope === null || (record(state.workspace_scope, ["status"]) && text(state.workspace_scope.status, 100)))
    || !(state.locale === undefined || member(state.locale, ["en", "zh-CN"]))
    || !(state.theme === undefined || member(state.theme, ["orange", "blue"]))
    || !(state.labels === undefined || labels(state.labels))) return null;
  if (state.binding !== null && (!ordinary(state.binding) || !resource(state.binding.project) || !Array.isArray(state.binding.statuses) || !state.binding.statuses.every(status)
    || (state.binding.identity !== undefined && !identity(state.binding.identity)) || (state.binding.principal !== undefined && !resource(state.binding.principal)) || (state.binding.instance !== undefined && !resource(state.binding.instance)))) return null;
  if (state.page !== null && (!record(state.page, ["items", "issues", "next_cursor", "continuation", "capacity_reached"], []) || (!Array.isArray(state.page.items) && !Array.isArray(state.page.issues))
    || (state.page.items !== undefined && !summaryRows(state.page.items)) || (state.page.issues !== undefined && !summaryRows(state.page.issues))
    || (Array.isArray(state.page.items) && Array.isArray(state.page.issues) && state.page.items.length + state.page.issues.length > ISSUE_COLLECTION_LIMIT)
    || (state.page.capacity_reached !== undefined && typeof state.page.capacity_reached !== "boolean")
    || (state.page.next_cursor !== undefined && state.page.next_cursor !== null && state.page.next_cursor !== "available")
    || (state.page.continuation !== undefined && (!record(state.page.continuation, ["next_cursor"], []) || (state.page.continuation.next_cursor !== undefined && state.page.continuation.next_cursor !== null && state.page.continuation.next_cursor !== "available"))))) return null;
  if (state.view !== undefined && !member(state.view, ["list", "board"])) return null;
  if (state.assignees !== undefined && (!Array.isArray(state.assignees) || state.assignees.length > 1000 || !state.assignees.every(value => record(value, ["id", "principal_id", "display_name"], ["principal_id", "display_name"]) && uuid(value.principal_id) && text(value.display_name, 128) && (value.id === undefined || uuid(value.id))))) return null;
  if (state.board !== undefined && state.board !== null) {
    if (!record(state.board, ["columns"]) || !Array.isArray(state.board.columns) || state.board.columns.length > 5) return null;
    const seen = new Set();
    for (const column of state.board.columns) {
      if (!record(column, ["key", "display_name", "items", "has_more", "capacity_reached"], ["key", "items", "has_more"]) || !member(column.key, statuses) || seen.has(column.key)
        || !optionalString(column.display_name, 128) || typeof column.has_more !== "boolean" || (column.capacity_reached !== undefined && typeof column.capacity_reached !== "boolean") || !summaryRows(column.items)) return null;
      seen.add(column.key);
    }
  }
  return value as { type: "snapshot"; state: EmbedSnapshot };
}

export function parseResultMessage(value: unknown): { type: "result"; id: string; result: PublicResult } | null {
  if (!boundedJson(value, ACTION_LIMIT_BYTES, true) || !record(value, ["type", "id", "result"]) || value.type !== "result" || !uuid(value.id)
    || !record(value.result, ["ok", "error", "outcome_unknown"], ["ok"]) || typeof value.result.ok !== "boolean"
    || (value.result.outcome_unknown !== undefined && typeof value.result.outcome_unknown !== "boolean")) return null;
  if (value.result.error !== undefined && (!record(value.result.error, ["code", "message"], ["code"]) || !text(value.result.error.code, 100) || (value.result.error.message !== undefined && !text(value.result.error.message, 1024)))) return null;
  return value as { type: "result"; id: string; result: PublicResult };
}

export function isConnectMessage(value: unknown): value is { type: "cfkanban.embed.connect"; protocol: 1; locale: EmbedLocale } {
  return record(value, ["type", "protocol", "locale"]) && value.type === "cfkanban.embed.connect" && value.protocol === EMBED_PROTOCOL && member(value.locale, ["en", "zh-CN"]);
}

export function emptySnapshot(): EmbedSnapshot {
  return { candidates: [], identity: null, workspaces: [], projects: [], binding: null, page: null, issue: null, comments: [], filters: { assignment: "all", status: "", priority: "" }, busy: 0, error: null, pending: null, view: "list", board: null, assignees: [], assignees_has_more: false, workspace_scope: null, scope_mode: "manual", scope_targets: [], scope_next_offset: null, capabilities: { update: false, comment: false, complete: false } };
}
