export type Locale = "en" | "zh-CN";
export type ProjectRole = "reader" | "writer" | "owner";
export type StatusKey = "backlog" | "todo" | "in_progress" | "done" | "canceled";
export type PriorityKey = "none" | "low" | "medium" | "high" | "urgent";

export interface ApiErrorBody {
  category: string;
  code: string;
  details: Record<string, unknown>;
  message: string;
  recovery: string;
  request_id: string;
  retry_after_seconds?: number;
  retryable: boolean;
  source: string;
}

export interface ListResult<T> {
  has_more: boolean;
  items: T[];
  next_cursor: string | null;
  resolved_scope?: Record<string, unknown>;
}

export interface ProjectScopeItem {
  project_id: string;
  project_key: string;
  role: "owner" | "reader" | "writer";
  workspace_key: string;
}

export interface WebSessionView {
  allowed_scope: {
    kind: "instance" | "project" | "project_selection";
    project_id?: string;
    projects?: ProjectScopeItem[];
  };
  expires_at: string;
  principal: {
    display_name: string;
    id: string;
    is_owner: boolean;
    version: number;
  };
  session_id: string;
  source: { id: string; kind: "credential" | "web_authenticator" };
  target: { entry_path?: string; identifier?: string; kind: string; section?: string };
}

export interface InvitationResource {
  allowed_actions: string[];
  bound_principal: { display_name: string; principal_id: string } | null;
  code_fingerprint: string;
  created_at: string;
  deleted_at: string | null;
  expires_at: string;
  grants: Array<{
    display_name: string;
    project_id: string;
    project_key: string;
    role: "reader" | "writer";
    workspace_key: string;
  }>;
  id: string;
  kind: "project_grant" | "principal_recovery";
  recovery_mode: "full_recovery" | "rotation" | null;
  redeemed_at: string | null;
  redeemed_by_principal_id: string | null;
  revoked_at: string | null;
  status: "active" | "expired" | "redeemed" | "revoked";
  updated_at: string;
  version: number;
}

export interface PublicProject {
  display_name: string;
  public_id: string;
  public_summary: string;
  role_choices: Array<"reader" | "writer">;
}

export interface IssueLabel {
  color?: string | null;
  id: string;
  name: string;
}

export interface IssueStatus {
  category: string;
  display_name: string;
  key: StatusKey;
  terminal: boolean;
}

export interface ProjectStatusResource extends IssueStatus {
  version: number;
}

export interface IssueSummary {
  assignee: null | {
    available: boolean;
    display_name: string;
    principal_id: string;
  };
  created_at: string;
  deleted_at: string | null;
  id: string;
  identifier: string;
  is_blocked: boolean;
  labels: IssueLabel[];
  needs_reassignment: boolean;
  number: number;
  priority: PriorityKey;
  project: { display_name: string; id: string; key: string };
  status: IssueStatus;
  title: string;
  updated_at: string;
  version: number;
  workspace: { display_name: string; key: string };
}

export interface IssueTombstone extends IssueSummary {
  allowed_actions: Array<"restore">;
  deleted_at: string;
  deleted_by_principal_id: string | null;
  parent_status: {
    project: "active" | "deleted";
    workspace: "active" | "deleted";
  };
  restorable: boolean;
  unavailability_reason: null | {
    code: string;
    current_usage?: number;
    limit?: number;
    recovery: string;
    resource_kind?: "issues" | "comments";
  };
}

export interface IssueComment {
  allowed_actions: string[];
  author: { display_name: string; principal_id: string };
  body: string | null;
  completion?: Record<string, unknown> | null;
  created_at: string;
  deleted_at: string | null;
  id: string;
  kind: "standard" | "completion";
  version: number;
}

export interface LabelResource extends IssueLabel {
  allowed_actions: string[];
  deleted_at: string | null;
  project: { id: string; key: string; workspace_key: string };
  version: number;
}

export interface IssueRelation {
  allowed_actions: string[];
  created_at: string;
  deleted_at: string | null;
  id: string;
  kind: "blocks" | "parent" | "related" | "duplicate";
  restorable?: boolean;
  source: {
    identifier: string;
    project: { id: string; key: string; workspace_key: string };
    title: string;
    version: number;
  };
  target: {
    identifier: string;
    project: { id: string; key: string; workspace_key: string };
    title: string;
    version: number;
  };
  version: number;
  workspace: { id: string; key: string };
}

export interface IssueDetail extends IssueSummary {
  allowed_actions: string[];
  blocked_reason: string | null;
  body: string;
  comment_continuation?: string | null;
  comments?: IssueComment[];
  relation_continuation?: string | null;
  relations?: IssueRelation[];
}

export interface Passkey {
  algorithm: -7 | -257;
  backup_eligible: boolean;
  backup_state: boolean;
  created_at: string;
  id: string;
  last_used_at: string | null;
  revoked_at: string | null;
  rp_id: string;
  transports: string[];
  version: number;
}

export interface PrincipalPasskey extends Passkey {
  allowed_actions: string[];
}

export interface EventResource {
  actor: null | { credential_id: string | null; display_name: string; principal_id: string };
  authorized_via: "deployment_owner" | "project_grant" | "public_join" | "invitation" | "browser_launch" | "web_session" | "webauthn" | "deployment_recovery";
  created_at: string;
  event_index: number;
  grant_id: string | null;
  id: string;
  operation_id: string;
  payload: unknown;
  project: null | { display_name: string; id: string; key: string };
  stream?: "domain" | "security";
  subject: { id: string; type: string };
  type: string;
  workspace: null | { display_name: string; id: string; key: string };
}

export interface MetaResource {
  instance_id: string;
  observed_origin: string;
  origin_version: number;
  preferred_api_origin: string;
  schema_version: number;
  service_version: string;
  visible_scope: { project_count: number; workspace_count: number };
}

export interface InstanceDiscovery {
  discovery_version: 1;
  instance_id: string;
  observed_origin: string;
  origin_version: number;
  preferred_api_origin: string;
  service_version: string;
  updated_at: string;
}

export interface RateLimitSettings {
  configuration_source: "worker_configuration";
  editable_via_api: false;
  policies: Record<"instance" | "principal" | "unauthenticated_sensitive", {
    limit: number;
    period_seconds: number;
  }>;
  recent_429_summary: {
    as_of: string;
    by_scope: Record<string, number>;
    total: number;
    window_seconds: number;
  };
}

export interface ContainerResource {
  allowed_actions?: string[];
  context?: string;
  created_at?: string;
  deleted_at: string | null;
  display_name: string;
  id: string;
  key: string;
  updated_at?: string;
  version: number;
  workspace_id?: string;
  workspace_key?: string;
  resumed_public_projects?: {
    has_more: boolean;
    projects: Array<{
      active_usage?: { comments: number; issues: number; principals: number };
      display_name?: string;
      id: string;
      key: string;
      public_summary?: string;
      resource_limits?: { comments: number; issues: number; principals: number };
      role_choices?: Array<"reader" | "writer">;
      workspace_key?: string;
    }>;
  };
}

export interface PrincipalResource {
  active_credential_count?: number;
  active_grant_count?: number;
  assignee_count?: number;
  created_at?: string;
  display_name: string;
  id: string;
  is_owner: boolean;
  principal_id?: string;
  version: number;
}

export interface CredentialResource {
  allowed_actions: string[];
  fingerprint: string;
  id: string;
  issued_at: string;
  last_used_at: string | null;
  principal: { display_name: string; principal_id: string };
  principal_id: string;
  revoke_reason: string | null;
  revoked_at: string | null;
  version: number;
}

export interface GrantResource {
  allowed_actions: string[];
  id: string;
  principal: { display_name: string; principal_id: string };
  principal_id: string;
  project: { display_name: string; id: string; key: string; workspace_key: string };
  project_id: string;
  revoked_at: string | null;
  role: "reader" | "writer";
  version: number;
}

export interface PrincipalDetail extends PrincipalResource {
  credentials: CredentialResource[];
  credentials_has_more: boolean;
  grants: GrantResource[];
  grants_has_more: boolean;
  passkeys: PrincipalPasskey[];
  passkeys_has_more: boolean;
}

export interface WriteResult<T> {
  event_cursor?: string;
  idempotent_replay?: boolean;
  resource: T;
}
