import {
  parseGeneratedMode,
  renderGeneratedJson,
  syncGeneratedFile,
} from "./lib/generated-artifacts.mjs";

const tags = [
  "meta",
  "identity",
  "workspaces",
  "projects",
  "issues",
  "comments",
  "attachments",
  "labels",
  "relations",
  "invitations",
  "public-join",
  "web",
  "admin",
  "events",
];

const tagDescriptions = {
  meta: "Service health, discovery, versions, and capabilities.",
  identity: "The authenticated Principal and its non-secret identity projection.",
  workspaces: "Owner-created logical namespaces.",
  projects: "Project containers and the fixed five-status display model.",
  issues: "Issue reads and single-resource atomic commands.",
  attachments: "Optional private Issue files with bounded reservations, authenticated transfer, and recovery.",
  comments: "Chronological standard and immutable completion comments.",
  labels: "Project-scoped labels and single-Issue associations.",
  relations: "Same-Workspace Issue relations, including cross-Project relations.",
  invitations: "Short-lived one-time Project and Principal recovery invitations.",
  "public-join": "Owner-controlled single-Project public enrollment and limits.",
  web: "Browser Launch, fixed Web Sessions, and Passkey authentication.",
  admin: "Scope-authorized application maintenance; identity, security, quotas, and instance settings remain Deployment Owner-only.",
  events: "Authorization-filtered domain events and incremental synchronization.",
};

const bearer = [{ BearerCredential: [] }];
const cookie = [{ WebSession: [] }];
const authenticated = [...bearer, ...cookie];
const publicAccess = [];
const optionalBearer = [{}, ...bearer];
const optionalAuthenticated = [{}, ...authenticated];

const operations = [
  ["get", "/healthz", "getHealth", "meta", publicAccess, "read"],
  ["get", "/openapi.json", "getOpenApi", "meta", publicAccess, "read"],
  ["get", "/.well-known/cfkanban-instance.json", "discoverInstance", "meta", publicAccess, "read"],
  ["get", "/invite", "getInvitationBootstrap", "invitations", publicAccess, "read", "InviteCodeQuery"],
  ["get", "/app/launch", "getWebLaunchPage", "web", publicAccess, "read", "LaunchCodeQuery"],
  ["get", "/api/v1/meta", "getMeta", "meta", authenticated, "read"],
  ["get", "/api/v1/me", "getMe", "identity", authenticated, "read"],
  ["patch", "/api/v1/me", "updateMe", "identity", authenticated, "cas", "UpdatePrincipalDisplayNameRequest"],
  ["get", "/api/v1/events", "listEvents", "events", authenticated, "read", "EventQuery"],

  ["get", "/api/v1/workspaces", "listWorkspaces", "workspaces", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/workspaces", "createWorkspace", "workspaces", bearer, "idempotent", "CreateWorkspaceRequest"],
  ["get", "/api/v1/workspaces/{workspace_id}", "getWorkspace", "workspaces", authenticated, "read", "DeletedModeQuery"],
  ["patch", "/api/v1/workspaces/{workspace_id}", "updateWorkspace", "workspaces", authenticated, "cas", "UpdateDisplayNameRequest"],
  ["delete", "/api/v1/workspaces/{workspace_id}", "deleteWorkspace", "workspaces", authenticated, "cas-delete"],
  ["get", "/api/v1/workspaces/{workspace_id}/purge-preview", "previewWorkspacePurge", "workspaces", authenticated, "read"],
  ["post", "/api/v1/workspaces/{workspace_id}/commands/purge", "purgeWorkspace", "workspaces", authenticated, "idempotent-cas", "ContainerPurgeRequest"],
  ["post", "/api/v1/workspaces/{workspace_id}/commands/restore", "restoreWorkspace", "workspaces", authenticated, "idempotent-cas", "ExpectedVersionRequest"],

  ["get", "/api/v1/workspaces/{workspace_id}/projects", "listProjects", "projects", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects", "createProject", "projects", authenticated, "idempotent", "CreateProjectRequest"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}", "getProject", "projects", authenticated, "read", "DeletedModeQuery"],
  ["patch", "/api/v1/workspaces/{workspace_id}/projects/{project_id}", "updateProject", "projects", authenticated, "cas", "UpdateProjectRequest"],
  ["delete", "/api/v1/workspaces/{workspace_id}/projects/{project_id}", "deleteProject", "projects", authenticated, "cas-delete"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/purge-preview", "previewProjectPurge", "projects", authenticated, "read"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/commands/purge", "purgeProject", "projects", authenticated, "idempotent-cas", "ContainerPurgeRequest"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/commands/restore", "restoreProject", "projects", authenticated, "idempotent-cas", "ExpectedVersionRequest"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/assignees", "findProjectAssignee", "projects", authenticated, "read", "AssigneeNameQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/statuses", "listProjectStatuses", "projects", authenticated, "read"],
  ["patch", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/statuses/{status_key}", "updateProjectStatusName", "projects", authenticated, "cas", "UpdateStatusNameRequest"],

  ["get", "/api/v1/workspaces/{workspace_id}/administrators", "listWorkspaceAdministrators", "workspaces", authenticated, "read", "CursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/administrators", "createWorkspaceAdministrator", "workspaces", authenticated, "idempotent-cas", "CreateAdministratorRequest"],
  ["delete", "/api/v1/workspaces/{workspace_id}/administrators/{administrator_id}", "revokeWorkspaceAdministrator", "workspaces", authenticated, "idempotent-cas-delete"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators", "listProjectAdministrators", "projects", authenticated, "read", "CursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators", "createProjectAdministrator", "projects", authenticated, "idempotent-cas", "CreateAdministratorRequest"],
  ["delete", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators/{administrator_id}", "revokeProjectAdministrator", "projects", authenticated, "idempotent-cas-delete"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/members", "listProjectMembers", "projects", authenticated, "read", "CursorQuery"],

  ["get", "/api/v1/issues", "listIssues", "issues", authenticated, "read", "IssueListQuery"],
  ["get", "/api/v1/issues/candidates", "listIssueCandidates", "issues", authenticated, "read", "CandidateListQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues", "listProjectIssues", "issues", authenticated, "read", "IssueListQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues", "createIssue", "issues", authenticated, "idempotent", "CreateIssueRequest"],
  ["get", "/api/v1/issues/{identifier}", "getIssue", "issues", authenticated, "read", "IssueDetailQuery"],
  ["patch", "/api/v1/issues/{identifier}", "updateIssue", "issues", authenticated, "cas", "UpdateIssueRequest"],
  ["delete", "/api/v1/issues/{identifier}", "deleteIssue", "issues", authenticated, "cas-delete"],
  ["post", "/api/v1/issues/{identifier}/commands/restore", "restoreIssue", "issues", authenticated, "idempotent-cas", "ExpectedVersionRequest"],
  ["get", "/api/v1/issues/{identifier}/context", "getIssueContext", "issues", authenticated, "read"],
  ["post", "/api/v1/issues/{identifier}/commands/assign-to-me", "assignIssueToMe", "issues", authenticated, "idempotent-cas", "ExpectedVersionRequest"],
  ["post", "/api/v1/issues/{identifier}/commands/report-blocked", "reportIssueBlocked", "issues", authenticated, "idempotent-cas", "ReportBlockedRequest"],
  ["post", "/api/v1/issues/{identifier}/commands/clear-blocked", "clearIssueBlocked", "issues", authenticated, "idempotent-cas", "ExpectedVersionRequest"],
  ["post", "/api/v1/issues/{identifier}/commands/complete", "completeIssue", "issues", authenticated, "idempotent-cas", "CompleteIssueRequest"],
  ["post", "/api/v1/issues/{identifier}/commands/add-label", "addIssueLabel", "issues", authenticated, "idempotent-cas", "IssueLabelRequest"],
  ["post", "/api/v1/issues/{identifier}/commands/remove-label", "removeIssueLabel", "issues", authenticated, "idempotent-cas", "IssueLabelRequest"],

  ["get", "/api/v1/issues/{identifier}/attachments", "listAttachments", "attachments", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/issues/{identifier}/attachments", "reserveAttachment", "attachments", authenticated, "idempotent", "ReserveAttachmentRequest"],
  ["get", "/api/v1/attachments/{id}", "getAttachment", "attachments", authenticated, "read"],
  ["put", "/api/v1/attachments/{id}/content", "uploadAttachment", "attachments", authenticated, "idempotent", "AttachmentBytes"],
  ["get", "/api/v1/attachments/{id}/content", "downloadAttachment", "attachments", authenticated, "read"],
  ["delete", "/api/v1/attachments/{id}", "deleteAttachment", "attachments", authenticated, "idempotent-cas-delete"],
  ["post", "/api/v1/attachments/{id}/commands/restore", "restoreAttachment", "attachments", authenticated, "idempotent-cas", "ExpectedVersionRequest"],

  ["get", "/api/v1/issues/{identifier}/comments", "listComments", "comments", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/issues/{identifier}/comments", "createComment", "comments", authenticated, "idempotent", "CreateCommentRequest"],
  ["get", "/api/v1/comments/{comment_id}", "getComment", "comments", authenticated, "read", "IssueDetailQuery"],
  ["delete", "/api/v1/comments/{comment_id}", "deleteComment", "comments", authenticated, "cas-delete"],
  ["post", "/api/v1/comments/{comment_id}/commands/restore", "restoreComment", "comments", authenticated, "idempotent-cas", "ExpectedVersionRequest"],

  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/labels", "listLabels", "labels", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/labels", "createLabel", "labels", authenticated, "idempotent", "CreateLabelRequest"],
  ["get", "/api/v1/labels/{label_id}", "getLabel", "labels", authenticated, "read", "IssueDetailQuery"],
  ["patch", "/api/v1/labels/{label_id}", "updateLabel", "labels", authenticated, "cas", "UpdateLabelRequest"],
  ["delete", "/api/v1/labels/{label_id}", "deleteLabel", "labels", authenticated, "cas-delete"],
  ["post", "/api/v1/labels/{label_id}/commands/restore", "restoreLabel", "labels", authenticated, "idempotent-cas", "ExpectedVersionRequest"],

  ["get", "/api/v1/issues/{identifier}/relations", "listIssueRelations", "relations", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/issues/{identifier}/relations", "createIssueRelation", "relations", authenticated, "idempotent", "CreateRelationRequest"],
  ["get", "/api/v1/relations/{relation_id}", "getRelation", "relations", authenticated, "read", "IssueDetailQuery"],
  ["delete", "/api/v1/relations/{relation_id}", "deleteRelation", "relations", authenticated, "cas-delete", "RelationDeleteQuery"],
  ["post", "/api/v1/relations/{relation_id}/commands/restore", "restoreRelation", "relations", authenticated, "idempotent-cas", "RelationVersionsRequest"],

  ["post", "/api/v1/invitations/redeem", "redeemInvitation", "invitations", optionalBearer, "idempotent", "RedeemInvitationRequest"],
  ["get", "/api/v1/admin/invitations", "listInvitations", "invitations", authenticated, "read", "InvitationListQuery"],
  ["post", "/api/v1/admin/invitations", "createInvitation", "invitations", authenticated, "idempotent", "CreateInvitationRequest"],
  ["get", "/api/v1/admin/invitations/{invitation_id}", "getInvitation", "invitations", authenticated, "read"],
  ["delete", "/api/v1/admin/invitations/{invitation_id}", "revokeInvitation", "invitations", authenticated, "cas-delete"],

  ["get", "/api/v1/admin/principals", "listPrincipals", "admin", authenticated, "read", "PrincipalListQuery"],
  ["get", "/api/v1/admin/principals/{principal_id}", "getPrincipal", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/principals/{principal_id}/credentials", "listPrincipalCredentials", "admin", authenticated, "read", "CursorQuery"],
  ["delete", "/api/v1/admin/credentials/{credential_id}", "revokeCredential", "admin", authenticated, "cas-delete"],
  ["post", "/api/v1/admin/owner-credentials/rotate", "rotateOwnerCredential", "admin", bearer, "idempotent", "RotateOwnerCredentialRequest"],
  ["get", "/api/v1/admin/instance-origin", "getInstanceOrigin", "admin", authenticated, "read"],
  ["put", "/api/v1/admin/instance-origin", "updateInstanceOrigin", "admin", bearer, "idempotent-cas", "UpdateInstanceOriginRequest"],
  ["get", "/api/v1/admin/projects/{project_id}/grants", "listProjectGrants", "admin", authenticated, "read", "CursorQuery"],
  ["post", "/api/v1/admin/projects/{project_id}/grants", "createProjectGrant", "admin", authenticated, "idempotent", "CreateGrantRequest"],
  ["get", "/api/v1/admin/grants/{grant_id}", "getProjectGrant", "admin", authenticated, "read"],
  ["patch", "/api/v1/admin/grants/{grant_id}", "updateProjectGrant", "admin", authenticated, "cas", "UpdateGrantRequest"],
  ["delete", "/api/v1/admin/grants/{grant_id}", "revokeProjectGrant", "admin", authenticated, "cas-delete"],
  ["get", "/api/v1/admin/audit-events", "listAuditEvents", "admin", authenticated, "read", "AuditEventQuery"],

  ["post", "/api/v1/web-launches", "createWebLaunch", "web", bearer, "idempotent", "CreateWebLaunchRequest"],
  ["post", "/api/v1/web-sessions/redeem", "redeemWebLaunch", "web", publicAccess, "idempotent", "RedeemWebLaunchRequest"],
  ["get", "/api/v1/web-session", "getWebSession", "web", cookie, "read"],
  ["delete", "/api/v1/web-session", "revokeWebSession", "web", cookie, "csrf"],
  ["post", "/api/v1/me/passkeys/registration-options", "createPasskeyRegistrationOptions", "web", cookie, "csrf", "EmptyRequest"],
  ["get", "/api/v1/me/passkeys", "listMyPasskeys", "web", cookie, "read"],
  ["post", "/api/v1/me/passkeys", "registerPasskey", "web", cookie, "csrf-idempotent", "RegisterPasskeyRequest"],
  ["delete", "/api/v1/me/passkeys/{passkey_id}", "revokeMyPasskey", "web", cookie, "csrf-cas-delete"],
  ["delete", "/api/v1/admin/passkeys/{passkey_id}", "revokePrincipalPasskey", "admin", authenticated, "csrf-cas-delete"],
  ["post", "/api/v1/web-authentication/options", "createWebAuthenticationOptions", "web", publicAccess, "write", "EmptyRequest"],
  ["post", "/api/v1/web-authentication/verify", "verifyWebAuthentication", "web", publicAccess, "idempotent", "VerifyWebAuthenticationRequest"],
  ["get", "/api/v1/public-projects", "listPublicProjects", "public-join", publicAccess, "read", "CursorQuery"],
  ["get", "/api/v1/admin/projects/{project_id}/public-join", "getPublicJoinPolicy", "public-join", authenticated, "read"],
  ["put", "/api/v1/admin/projects/{project_id}/public-join", "enablePublicJoin", "public-join", authenticated, "idempotent-cas", "EnablePublicJoinRequest"],
  ["delete", "/api/v1/admin/projects/{project_id}/public-join", "disablePublicJoin", "public-join", authenticated, "cas-delete"],
  ["get", "/api/v1/admin/projects/{project_id}/resource-limits", "getProjectResourceLimits", "public-join", authenticated, "read"],
  ["patch", "/api/v1/admin/projects/{project_id}/resource-limits", "updateProjectResourceLimits", "public-join", authenticated, "cas", "UpdateResourceLimitsRequest"],
  ["get", "/api/v1/admin/attachment-settings", "getAttachmentSettings", "admin", authenticated, "read"],
  ["patch", "/api/v1/admin/attachment-settings", "updateAttachmentSettings", "admin", authenticated, "cas", "UpdateAttachmentSettingsRequest"],
  ["get", "/api/v1/admin/usage", "getUsage", "admin", authenticated, "read"],
  ["post", "/api/v1/admin/usage/refresh", "refreshUsage", "admin", authenticated, "cache-refresh", "RefreshUsageRequest"],
  ["get", "/api/v1/admin/rate-limit-settings", "getRateLimitSettings", "admin", authenticated, "read"],
  ["post", "/api/v1/public-joins/{public_id}/redeem", "redeemPublicJoin", "public-join", optionalAuthenticated, "idempotent", "RedeemPublicJoinRequest"],
];

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const string = (extra = {}) => ({ type: "string", ...extra });
const integer = (extra = {}) => ({ type: "integer", format: "int64", ...extra });
const nullableString = (extra = {}) => ({ anyOf: [string(extra), { type: "null" }] });
const utf8String = (maxBytes, extra = {}) => string({
  ...extra,
  description: `${extra.description ?? "Text value."} Runtime limit: ${maxBytes} UTF-8 bytes.`,
  "x-cfkanban-max-utf8-bytes": maxBytes,
});
const nullableUtf8String = (maxBytes, extra = {}) => ({
  anyOf: [utf8String(maxBytes, extra), { type: "null" }],
});
const credentialToken = () => string({
  minLength: 52,
  maxLength: 584,
  pattern: "^cfk_v1_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43,512}$",
  writeOnly: true,
});

const issueSummaryProperties = {
  assignee: {
    anyOf: [
      {
        type: "object",
        required: ["available", "display_name", "principal_id"],
        properties: {
          available: { type: "boolean" },
          display_name: string(),
          principal_id: ref("Uuid"),
        },
        additionalProperties: false,
      },
      { type: "null" },
    ],
  },
  created_at: ref("Timestamp"),
  deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
  id: ref("Uuid"),
  identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
  is_blocked: { type: "boolean" },
  labels: { type: "array", items: ref("IssueLabelSummary") },
  needs_reassignment: { type: "boolean" },
  number: integer({ minimum: 1 }),
  priority: ref("PriorityKey"),
  project: {
    type: "object",
    required: ["display_name", "id"],
    properties: { display_name: string(), id: ref("Uuid") },
    additionalProperties: false,
  },
  status: {
    type: "object",
    required: ["category", "display_name", "key", "terminal"],
    properties: {
      category: string({ enum: ["backlog", "unstarted", "started", "completed", "canceled"] }),
      display_name: string(),
      key: ref("StatusKey"),
      terminal: { type: "boolean" },
    },
    additionalProperties: false,
  },
  title: string(),
  updated_at: ref("Timestamp"),
  version: ref("Version"),
  workspace: {
    type: "object",
    required: ["display_name", "id"],
    properties: { display_name: string(), id: ref("Uuid") },
    additionalProperties: false,
  },
};
const issueSummaryRequired = Object.keys(issueSummaryProperties);
const issueDetailProperties = {
  ...issueSummaryProperties,
  allowed_actions: { type: "array", items: string() },
  blocked_reason: nullableString(),
  body: string(),
};
const issueDetailRequired = [...issueSummaryRequired, "allowed_actions", "blocked_reason", "body"];

const commentAuthorSchema = {
  type: "object",
  required: ["display_name", "principal_id"],
  properties: { display_name: string(), principal_id: ref("Uuid") },
  additionalProperties: false,
};
const commentCommonRequired = [
  "allowed_actions", "author", "body", "completion", "created_at", "deleted_at",
  "deleted_by_principal_id", "id", "issue", "kind", "reply_to_comment_id", "version",
];
const commentCommonProperties = {
  allowed_actions: { type: "array", items: string({ enum: ["read", "delete", "restore"] }) },
  author: commentAuthorSchema,
  created_at: ref("Timestamp"),
  id: ref("Uuid"),
  issue: ref("IssueReference"),
  version: ref("Version"),
};

const invitationRequired = [
  "allowed_actions", "bound_principal", "code_fingerprint", "created_at", "deleted_at",
  "expires_at", "grants", "id", "kind", "recovery_mode", "redeemed_at",
  "redeemed_by_principal_id", "revoked_at", "status", "updated_at", "version",
];
const invitationProperties = {
  allowed_actions: { type: "array", items: string({ enum: ["read", "revoke"] }) },
  bound_principal: {
    anyOf: [
      {
        type: "object",
        required: ["display_name", "principal_id"],
        properties: { display_name: string(), principal_id: ref("Uuid") },
        additionalProperties: false,
      },
      { type: "null" },
    ],
  },
  code_fingerprint: string({ pattern: "^cfi_v1_[A-Za-z0-9_-]{8}_…$" }),
  created_at: ref("Timestamp"),
  deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
  expires_at: ref("Timestamp"),
  grants: { type: "array", items: ref("InvitationGrantSummary") },
  id: ref("Uuid"),
  kind: string({ enum: ["project_grant", "principal_recovery"] }),
  recovery_mode: { anyOf: [string({ enum: ["rotation", "full_recovery"] }), { type: "null" }] },
  redeemed_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
  redeemed_by_principal_id: { anyOf: [ref("Uuid"), { type: "null" }] },
  revoked_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
  status: string({ enum: ["active", "expired", "redeemed", "revoked"] }),
  updated_at: ref("Timestamp"),
  version: ref("Version"),
};

const permissionDescriptions = {
  public: "Public, non-secret read.",
  authenticated_principal: "Any authenticated Principal; returned data is filtered to current effective authorization.",
  visible_scope: "Deployment Owner or a Principal with a currently visible Project in this container.",
  visible_scope_active_owner_tombstone: "Active container reads require Deployment Owner, scoped administration, or a currently visible Project in the container, including empty managed Workspaces. Archived Workspace recovery remains Owner-only; archived Projects may also be read by the active parent Workspace administrator.",
  current_principal: "The currently authenticated Principal acting only on its own identity or Web authentication state.",
  deployment_owner: "The single Deployment Owner. Project Grants and scoped administrators never satisfy this permission.",
  workspace_administrator: "Deployment Owner or a current administrator of this active Workspace, within the current Session scope.",
  project_administrator: "Deployment Owner, current parent Workspace administrator, or current Project administrator, within the current Session scope. Ordinary writer Grants do not grant management rights.",
  scoped_invitation_manager: "Deployment Owner manages all Invitations. Scoped administrators manage only ordinary Project Invitations whose complete targets are within their current scope; non-Owner creation is limited to one Project with explicit reader/writer role. Recovery Invitations remain Owner-only. A scoped Invitation binds the issuing administrator grant ID and generation; revocation permanently invalidates unredeemed Invitations, even after regrant.",
  project_reader: "Deployment Owner or effective Project reader/writer access, including current scoped administrator inheritance.",
  project_reader_active_writer_tombstone: "Active resources require a current effective reader/writer access for the resource Project, including scoped administrators (or Deployment Owner). The explicit deleted=only recovery view requires writer and remains available under paused parents only to the Deployment Owner.",
  project_writer: "Deployment Owner or effective Project writer access, including current scoped administrator inheritance.",
  relation_endpoints_reader: "Deployment Owner or effective reader/writer access for both Relation endpoint Projects, including scoped administrators. List operations use the path Issue Project for scope and omit Relations whose other endpoint is not currently readable.",
  relation_endpoints_reader_active_writer_tombstone: "Active Relations require current reader/writer access to both Relation endpoint Projects. The explicit deleted=only recovery view requires writer access to both endpoints and remains available under paused parents only to the Deployment Owner.",
  relation_endpoints_writer: "Deployment Owner or effective writer access for both Relation endpoint Projects, including scoped administrators.",
  credential_principal: "Any Principal authenticated with a current Bearer Credential; Cookie Session is intentionally insufficient.",
  agent_launch_session: "A current Cookie Session whose source is an active Bearer Credential Browser Launch.",
  invitation_capability: "A valid one-time Invitation capability, with conditional current-Credential authentication required by redeem_as.",
  browser_launch_capability: "A valid one-time Browser Launch capability.",
  webauthn_options: "Public creation of a short-lived, single-use discoverable WebAuthn authentication challenge.",
  webauthn_capability: "A valid single-use WebAuthn challenge and assertion ceremony.",
  public_join_capability: "An enabled single-Project Public Join policy, with conditional authentication required by redeem_as.",
};

const permissionGroups = {
  public: ["getHealth", "getOpenApi", "discoverInstance", "getInvitationBootstrap", "getWebLaunchPage", "listPublicProjects"],
  authenticated_principal: ["getMeta", "listEvents"],
  visible_scope_active_owner_tombstone: ["listWorkspaces", "getWorkspace", "listProjects", "getProject"],
  current_principal: ["getMe", "updateMe", "getWebSession", "revokeWebSession", "listMyPasskeys", "revokeMyPasskey"],
  deployment_owner: [
    "previewWorkspacePurge", "purgeWorkspace", "previewProjectPurge", "purgeProject",
    "createWorkspace", "deleteWorkspace", "restoreWorkspace",
    "createWorkspaceAdministrator", "revokeWorkspaceAdministrator",
    "listPrincipals", "getPrincipal", "listPrincipalCredentials", "revokeCredential", "rotateOwnerCredential",
    "getInstanceOrigin", "updateInstanceOrigin", "listAuditEvents", "revokePrincipalPasskey",
    "getPublicJoinPolicy", "enablePublicJoin", "disablePublicJoin", "getProjectResourceLimits",
    "updateProjectResourceLimits", "getRateLimitSettings", "getUsage", "refreshUsage", "getAttachmentSettings", "updateAttachmentSettings",
  ],
  workspace_administrator: ["updateWorkspace", "createProject", "deleteProject", "restoreProject", "listWorkspaceAdministrators", "createProjectAdministrator", "revokeProjectAdministrator"],
  project_administrator: ["updateProject", "updateProjectStatusName", "listProjectAdministrators", "listProjectMembers", "listProjectGrants", "createProjectGrant", "getProjectGrant", "updateProjectGrant", "revokeProjectGrant"],
  scoped_invitation_manager: ["listInvitations", "createInvitation", "getInvitation", "revokeInvitation"],
  project_reader: ["findProjectAssignee", "downloadAttachment", "getAttachment", "listProjectStatuses", "listIssueCandidates", "getIssueContext"],
  project_reader_active_writer_tombstone: [
    "listIssues", "listProjectIssues", "getIssue",
    "listAttachments", "listComments", "getComment", "listLabels", "getLabel",
  ],
  project_writer: [
    "reserveAttachment", "uploadAttachment", "deleteAttachment", "restoreAttachment",
    "createIssue", "updateIssue", "deleteIssue", "restoreIssue", "assignIssueToMe", "reportIssueBlocked",
    "clearIssueBlocked", "completeIssue", "addIssueLabel", "removeIssueLabel", "createComment", "deleteComment",
    "restoreComment", "createLabel", "updateLabel", "deleteLabel", "restoreLabel",
  ],
  relation_endpoints_reader_active_writer_tombstone: ["listIssueRelations", "getRelation"],
  relation_endpoints_writer: ["createIssueRelation", "deleteRelation", "restoreRelation"],
  credential_principal: ["createWebLaunch"],
  agent_launch_session: ["createPasskeyRegistrationOptions", "registerPasskey"],
  invitation_capability: ["redeemInvitation"],
  browser_launch_capability: ["redeemWebLaunch"],
  webauthn_options: ["createWebAuthenticationOptions"],
  webauthn_capability: ["verifyWebAuthentication"],
  public_join_capability: ["redeemPublicJoin"],
};

const operationPermissions = new Map();
for (const [permission, operationIds] of Object.entries(permissionGroups)) {
  for (const operationId of operationIds) operationPermissions.set(operationId, permission);
}

const containerUsageSchema = (nullable = false) => ({
  type: "object",
  required: ["comments", "issues", "principals"],
  properties: {
    comments: nullable ? { anyOf: [integer({ minimum: 0 }), { type: "null" }] } : integer({ minimum: 0 }),
    issues: nullable ? { anyOf: [integer({ minimum: 0 }), { type: "null" }] } : integer({ minimum: 0 }),
    principals: nullable ? { anyOf: [integer({ minimum: 0 }), { type: "null" }] } : integer({ minimum: 0 }),
  },
  additionalProperties: false,
});
const resumedPublicProjectsSchema = {
  type: "object",
  required: ["has_more", "projects"],
  properties: {
    has_more: { type: "boolean" },
    projects: { type: "array", maxItems: 100, items: ref("ResumedPublicProject") },
  },
  additionalProperties: false,
};
const workspaceProperties = {
  allowed_actions: { type: "array", uniqueItems: true, items: string({ enum: ["create_project", "delete", "read", "restore", "update", "manage_administrators"] }) },
  created_at: ref("Timestamp"),
  display_name: string({ minLength: 1, maxLength: 128 }),
  id: ref("Uuid"),
  updated_at: ref("Timestamp"),
  version: ref("Version"),
};
const workspaceRequired = ["allowed_actions", "created_at", "deleted_at", "display_name", "id", "restorable", "updated_at", "version"];
const workspaceSchema = ({ deleted, resumed = false }) => ({
  type: "object",
  required: [...workspaceRequired, ...(resumed ? ["resumed_public_projects"] : [])],
  properties: {
    ...workspaceProperties,
    deleted_at: deleted ? ref("Timestamp") : { type: "null" },
    restorable: deleted ? { const: true } : { const: false },
    ...(resumed ? { resumed_public_projects: resumedPublicProjectsSchema } : {}),
  },
  additionalProperties: false,
});
const projectProperties = {
  allowed_actions: { type: "array", uniqueItems: true, items: string({ enum: ["delete", "manage_status_names", "read", "restore", "update", "manage_members", "manage_administrators"] }) },
  context: nullableUtf8String(32768, { description: "Untrusted bounded Project context." }),
  created_at: ref("Timestamp"),
  display_name: string({ minLength: 1, maxLength: 128 }),
  id: ref("Uuid"),
  public_join_enabled: { type: "boolean" },
  resource_limits: containerUsageSchema(true),
  updated_at: ref("Timestamp"),
  version: ref("Version"),
  workspace_id: ref("Uuid"),
  workspace_display_name: string(),
};
const projectRequired = [
  "allowed_actions", "context", "created_at", "deleted_at", "display_name", "id",
  "public_join_enabled", "resource_limits", "restorable", "updated_at", "version", "workspace_id", "workspace_display_name",
];
const projectSchema = ({ activeUsage, deleted, resumed = false }) => ({
  type: "object",
  required: [
    ...projectRequired,
    ...(activeUsage ? ["active_usage"] : []),
    ...(deleted ? ["parent_status", "resumed_public_projects", "unavailability_reason"] : []),
    ...(!deleted && resumed ? ["resumed_public_projects"] : []),
  ],
  properties: {
    ...projectProperties,
    ...(activeUsage ? { active_usage: containerUsageSchema() } : {}),
    deleted_at: deleted ? ref("Timestamp") : { type: "null" },
    restorable: { type: "boolean" },
    ...(deleted ? {
      parent_status: {
        type: "object",
        required: ["workspace"],
        properties: { workspace: string({ enum: ["active", "deleted"] }) },
        additionalProperties: false,
      },
      resumed_public_projects: resumedPublicProjectsSchema,
      unavailability_reason: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            required: ["code", "recovery"],
            properties: { code: { const: "PARENT_WORKSPACE_DELETED" }, recovery: { const: "restore_parent" } },
            additionalProperties: false,
          },
        ],
      },
    } : resumed ? { resumed_public_projects: resumedPublicProjectsSchema } : {}),
  },
  additionalProperties: false,
});
const containerWriteResult = (resourceName) => ({
  type: "object",
  required: ["event_cursor", "idempotent_replay", "resource"],
  properties: {
    event_cursor: string(),
    idempotent_replay: { type: "boolean" },
    resource: ref(resourceName),
  },
  additionalProperties: false,
});

const schemas = {
  Uuid: string({ format: "uuid" }),
  Timestamp: string({ format: "date-time" }),
  WebAuthnCredentialId: string({ minLength: 22, maxLength: 1366, pattern: "^[A-Za-z0-9_-]+$" }),
  WebAuthnChallenge: string({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" }),
  WebAuthnClientData: string({ minLength: 1, maxLength: 10923, pattern: "^[A-Za-z0-9_-]+$" }),
  WebAuthnAttestation: string({ minLength: 1, maxLength: 87382, pattern: "^[A-Za-z0-9_-]+$" }),
  WebAuthnAuthenticatorData: string({ minLength: 50, maxLength: 10923, pattern: "^[A-Za-z0-9_-]+$" }),
  WebAuthnSignature: string({ minLength: 1, maxLength: 2731, pattern: "^[A-Za-z0-9_-]+$" }),
  WebAuthnUserHandle: string({ minLength: 1, maxLength: 86, pattern: "^[A-Za-z0-9_-]+$" }),
  Version: integer({ minimum: 1 }),
  StatusKey: string({ enum: ["backlog", "todo", "in_progress", "done", "canceled"], description: "稳定状态：待整理、待办、进行中、完成、取消。" }),
  NonDoneStatusKey: string({ enum: ["backlog", "todo", "in_progress", "canceled"], description: "普通创建或 PATCH 可使用的状态；进入 done 必须调用 complete 命令。" }),
  PriorityKey: string({ enum: ["urgent", "high", "medium", "low", "none"], description: "稳定优先级：紧急、高、中、低、无。" }),
  ProjectRole: string({ enum: ["reader", "writer"], description: "项目角色：只读或可写。" }),
  RelationKind: string({ enum: ["blocks", "parent", "related", "duplicate"] }),
  EmptyRequest: { type: "object", additionalProperties: false },
  ContainerPurgeRequest: {
    type: "object", required: ["expected_version", "confirm_name", "preview_digest"],
    properties: { expected_version: ref("Version"), confirm_name: string({ minLength: 1, maxLength: 128 }), preview_digest: string({ pattern: "^[a-f0-9]{64}$" }) },
    additionalProperties: false,
    description: "Permanently remove one archived container after an Owner preview. Requires the exact current display name and preview digest. Empty archived Workspaces only; no bulk purge.",
  },
  ContainerPurgePreview: {
    type: "object", required: ["target", "counts", "can_purge", "blocking_reason", "preview_digest"],
    properties: {
      target: {
        type: "object", required: ["kind", "id", "workspace_id", "display_name", "version"],
        properties: { kind: string({ enum: ["workspace", "project"] }), id: ref("Uuid"), workspace_id: ref("Uuid"), display_name: string(), version: ref("Version") },
        additionalProperties: false,
      },
      counts: {
        type: "object",
        required: ["projects", "issues", "comments", "attachments", "attachment_bytes", "labels", "relations", "cross_project_relations", "grants", "invitations", "shared_invitations", "browser_launches", "web_sessions"],
        properties: { ...Object.fromEntries(["projects", "issues", "comments", "attachments", "attachment_bytes", "labels", "relations", "cross_project_relations", "grants", "invitations", "shared_invitations", "browser_launches", "web_sessions"].map((key) => [key, integer({ minimum: 0 })])), administrators: integer({ minimum: 0, description: "Direct administrator records belonging to the target container; excludes inherited sources and ordinary Project Grants." }) },
        additionalProperties: false,
      },
      can_purge: { type: "boolean" },
      blocking_reason: { enum: [null, "ARCHIVE_REQUIRED", "WORKSPACE_NOT_EMPTY"] },
      preview_digest: string({ pattern: "^[a-f0-9]{64}$" }),
    },
    additionalProperties: false,
  },
  PurgedContainer: {
    type: "object", required: ["id", "kind", "purged", "purged_at", "version"],
    properties: { id: ref("Uuid"), kind: string({ enum: ["workspace", "project"] }), purged: { const: true }, purged_at: ref("Timestamp"), version: ref("Version"), storage_cleanup_pending: { type: "boolean", description: "Private attachment objects remain queued for asynchronous deletion." } },
    additionalProperties: false,
  },
  ContainerPurgeWriteResult: containerWriteResult("PurgedContainer"),
  ReserveAttachmentRequest: {
    type: "object", required: ["filename", "content_type", "size_bytes", "sha256"],
    properties: { filename: string({ minLength: 1, maxLength: 180, description: "Untrusted display filename; paths and control characters are rejected." }), content_type: string({ minLength: 3, maxLength: 127 }), size_bytes: integer({ minimum: 1, maximum: 10485760 }), sha256: string({ pattern: "^[a-f0-9]{64}$" }) }, additionalProperties: false,
  },
  AttachmentBytes: { type: "string", format: "binary", description: "One raw file matching the reservation size and SHA-256; maximum 10 MiB." },
  Attachment: {
    type: "object", required: ["id", "issue", "filename", "content_type", "size_bytes", "sha256", "state", "version", "created_at", "expires_at", "deleted_at", "uploaded_by", "preview_content_type", "allowed_actions"],
    properties: {
      id: ref("Uuid"), issue: ref("IssueReference"), filename: string(), content_type: string(), size_bytes: integer({ minimum: 1, maximum: 10485760 }), sha256: string({ pattern: "^[a-f0-9]{64}$" }),
      state: string({ enum: ["pending", "ready", "expired"] }), version: ref("Version"), created_at: ref("Timestamp"), expires_at: ref("Timestamp"), deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      uploaded_by: { type: "object", required: ["principal_id", "display_name"], properties: { principal_id: ref("Uuid"), display_name: string() }, additionalProperties: false },
      preview_content_type: { enum: [null, "image/png", "image/jpeg", "image/gif", "image/webp"] }, allowed_actions: { type: "array", items: string({ enum: ["read", "upload", "download", "delete", "restore"] }) },
    }, additionalProperties: false,
  },
  AttachmentListResult: {
    type: "object", required: ["items", "has_more", "next_cursor", "resolved_scope", "capabilities", "limits"],
    properties: { items: { type: "array", items: ref("Attachment") }, has_more: { type: "boolean" }, next_cursor: nullableString(),
      resolved_scope: { type: "object", required: ["issue"], properties: { issue: ref("IssueReference") }, additionalProperties: false },
      capabilities: { type: "object", required: ["attachments"], properties: { attachments: { type: "boolean" } }, additionalProperties: false },
      limits: { type: "object", required: ["max_file_bytes", "max_active_per_issue", "max_storage_bytes", "storage_limit_configured"], properties: { max_file_bytes: { const: 10485760 }, max_active_per_issue: { const: 20 }, max_storage_bytes: { type: ["integer", "null"], minimum: 1, maximum: 9007199254740991 }, storage_limit_configured: { type: "boolean" } }, additionalProperties: false } }, additionalProperties: false,
  },
  AttachmentWriteResult: containerWriteResult("Attachment"),
  ExpectedVersionRequest: { type: "object", required: ["expected_version"], properties: { expected_version: ref("Version") }, additionalProperties: false },
  PrincipalDisplayNameInput: string({ description: "Trim and NFKC normalize before validation; 1–128 Unicode code points in both display and locale-independent lowercase key. Letters, marks, numbers, underscore, hyphen and middle dot only; reject Default_Ignorable_Code_Point. Exact reserved keys: admin, administrator, owner, system, 管理员, 所有者, 系统. Instance-wide unique key; conflict returns PRINCIPAL_DISPLAY_NAME_CONFLICT without owner identity." }),
  UpdatePrincipalDisplayNameRequest: { type: "object", required: ["expected_version", "display_name"], properties: { expected_version: ref("Version"), display_name: ref("PrincipalDisplayNameInput") }, additionalProperties: false },
  ProjectAssigneeResult: {
    type: "object", required: ["items", "has_more", "next_cursor"], additionalProperties: false,
    properties: {
      has_more: { const: false }, next_cursor: { type: "null" },
      items: { type: "array", maxItems: 1, items: { type: "object", required: ["principal_id", "display_name"], properties: { principal_id: ref("Uuid"), display_name: string() }, additionalProperties: false } },
    },
  },
  UpdateDisplayNameRequest: { type: "object", required: ["expected_version", "display_name"], properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateWorkspaceRequest: { type: "object", required: ["display_name"], properties: { display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateProjectRequest: { type: "object", required: ["display_name"], properties: { display_name: string({ minLength: 1, maxLength: 128 }), context: nullableUtf8String(32768, { description: "Untrusted bounded Project context." }) }, additionalProperties: false },
  UpdateProjectRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }), context: nullableUtf8String(32768, { description: "Untrusted bounded Project context." }) }, additionalProperties: false },
  UpdateStatusNameRequest: { type: "object", required: ["expected_version", "display_name"], properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateIssueRequest: { type: "object", required: ["title"], properties: { title: string({ minLength: 1, maxLength: 256 }), body: utf8String(65536, { default: "", description: "Untrusted Markdown source." }), status_key: { ...ref("NonDoneStatusKey"), default: "backlog" }, priority_key: { ...ref("PriorityKey"), default: "none" }, assignee_principal_id: { anyOf: [ref("Uuid"), { type: "null" }], default: null }, label_ids: { type: "array", items: ref("Uuid"), maxItems: 20, uniqueItems: true, default: [] } }, additionalProperties: false },
  UpdateIssueRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), title: string({ minLength: 1, maxLength: 256 }), body: utf8String(65536, { description: "Untrusted Markdown source." }), status_key: ref("NonDoneStatusKey"), priority_key: ref("PriorityKey"), assignee_principal_id: { anyOf: [ref("Uuid"), { type: "null" }] } }, additionalProperties: false },
  ReportBlockedRequest: { type: "object", required: ["expected_version", "reason"], properties: { expected_version: ref("Version"), reason: string({ minLength: 1, maxLength: 4096 }) }, additionalProperties: false },
  CompleteIssueRequest: { type: "object", required: ["expected_version"], properties: { expected_version: ref("Version"), summary: string({ maxLength: 8192, default: "", description: "Optional completion note. Omitted, empty, or whitespace-only values are stored as an empty string." }), verification: { type: "array", items: string({ minLength: 1, maxLength: 1024 }), maxItems: 50, default: [] }, artifacts: { type: "array", items: { type: "object", required: ["kind", "value"], properties: { kind: string({ enum: ["url", "path", "commit", "other"] }), value: string({ minLength: 1, maxLength: 2048 }) }, additionalProperties: false }, maxItems: 50, default: [] }, follow_ups: { type: "array", items: string({ minLength: 1, maxLength: 2048 }), maxItems: 50, default: [] } }, additionalProperties: false, "x-cfkanban-max-utf8-bytes": 32768 },
  IssueLabelRequest: { type: "object", required: ["expected_version", "label_id"], properties: { expected_version: ref("Version"), label_id: ref("Uuid") }, additionalProperties: false },
  CreateCommentRequest: { type: "object", required: ["body"], properties: { body: utf8String(32768, { minLength: 1, description: "Append-only untrusted Comment body." }), reply_to_comment_id: { anyOf: [ref("Uuid"), { type: "null" }], default: null } }, additionalProperties: false },
  CreateLabelRequest: { type: "object", required: ["name"], properties: { name: string({ minLength: 1, maxLength: 64 }), color: nullableString({ pattern: "^#[0-9A-Fa-f]{6}$" }) }, additionalProperties: false },
  UpdateLabelRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), name: string({ minLength: 1, maxLength: 64 }), color: nullableString({ pattern: "^#[0-9A-Fa-f]{6}$" }) }, additionalProperties: false },
  CreateRelationRequest: { type: "object", required: ["kind", "target_identifier", "source_expected_version", "target_expected_version"], properties: { kind: ref("RelationKind"), target_identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }), source_expected_version: ref("Version"), target_expected_version: ref("Version") }, additionalProperties: false },
  RelationVersionsRequest: { type: "object", required: ["expected_version", "source_expected_version", "target_expected_version"], properties: { expected_version: ref("Version"), source_expected_version: ref("Version"), target_expected_version: ref("Version") }, additionalProperties: false },
  RedeemInvitationRequest: {
    oneOf: [
      { type: "object", required: ["invite_code", "redeem_as", "display_name", "new_credential_token"], properties: { invite_code: string({ minLength: 1, maxLength: 1024, writeOnly: true }), redeem_as: { const: "new_principal" }, display_name: ref("PrincipalDisplayNameInput"), new_credential_token: credentialToken() }, additionalProperties: false },
      { type: "object", required: ["invite_code", "redeem_as"], properties: { invite_code: string({ minLength: 1, maxLength: 1024, writeOnly: true }), redeem_as: { const: "current_principal" } }, additionalProperties: false },
      { type: "object", required: ["invite_code", "redeem_as", "new_credential_token"], properties: { invite_code: string({ minLength: 1, maxLength: 1024, writeOnly: true }), redeem_as: { const: "recovery" }, new_credential_token: credentialToken() }, additionalProperties: false },
    ],
  },
  CreateInvitationRequest: {
    oneOf: [
      { type: "object", required: ["kind", "grants"], properties: { kind: { const: "project_grant" }, grants: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, description: "Project IDs MUST be unique within this array.", "x-cfkanban-unique-by": "project_id", items: { type: "object", required: ["project_id", "role"], properties: { project_id: ref("Uuid"), role: ref("ProjectRole") }, additionalProperties: false } } }, additionalProperties: false },
      { type: "object", required: ["kind", "principal_id", "recovery_mode"], properties: { kind: { const: "principal_recovery" }, principal_id: ref("Uuid"), recovery_mode: string({ enum: ["rotation", "full_recovery"] }) }, additionalProperties: false },
    ],
  },
  RotateOwnerCredentialRequest: { type: "object", required: ["new_credential_token"], properties: { new_credential_token: credentialToken() }, additionalProperties: false },
  UpdateInstanceOriginRequest: { type: "object", required: ["expected_version", "preferred_api_origin"], properties: { expected_version: ref("Version"), preferred_api_origin: string({ format: "uri", pattern: "^https://[^/?#]+$" }) }, additionalProperties: false },
  Administrator: {
    type: "object",
    required: ["id", "principal_id", "principal", "workspace_id", "project_id", "role", "version", "generation", "revoked_at", "created_at", "updated_at", "allowed_actions"],
    properties: {
      id: ref("Uuid"), principal_id: ref("Uuid"),
      principal: { type: "object", required: ["id", "display_name"], properties: { id: ref("Uuid"), display_name: string() }, additionalProperties: false },
      workspace_id: ref("Uuid"), project_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      role: string({ enum: ["workspace_admin", "project_admin"] }),
      version: ref("Version"), generation: ref("Uuid"),
      revoked_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      created_at: ref("Timestamp"), updated_at: ref("Timestamp"),
      allowed_actions: { type: "array", uniqueItems: true, items: string({ enum: ["read", "revoke", "regrant"] }) },
    },
    additionalProperties: false,
  },
  AdministratorListResult: {
    type: "object", required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" }, items: { type: "array", maxItems: 100, items: ref("Administrator") }, next_cursor: nullableString(),
      resolved_scope: { type: "object", required: ["workspace_id", "project_id"], properties: { workspace_id: ref("Uuid"), project_id: { anyOf: [ref("Uuid"), { type: "null" }] } }, additionalProperties: false },
    }, additionalProperties: false,
  },
  AdministratorWriteResult: { type: "object", required: ["event_cursor", "idempotent_replay", "resource"], properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("Administrator") }, additionalProperties: false },
  EffectiveMemberSource: {
    type: "object", required: ["kind", "id", "version"],
    properties: {
      kind: string({ enum: ["workspace_admin", "project_admin", "project_grant", "deployment_owner"] }),
      id: { anyOf: [ref("Uuid"), { type: "null" }] }, version: { anyOf: [ref("Version"), { type: "null" }] }, role: string(),
    }, additionalProperties: false,
  },
  EffectiveMember: {
    type: "object", required: ["principal_id", "display_name", "effective_role", "sources"],
    properties: { principal_id: ref("Uuid"), display_name: string(), effective_role: string({ enum: ["owner", "writer", "reader"] }), sources: { type: "array", minItems: 1, items: ref("EffectiveMemberSource") } }, additionalProperties: false,
  },
  EffectiveMemberListResult: {
    type: "object", required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" }, items: { type: "array", maxItems: 100, items: ref("EffectiveMember") }, next_cursor: nullableString(),
      resolved_scope: { type: "object", required: ["workspace_id", "project_id"], properties: { workspace_id: ref("Uuid"), project_id: ref("Uuid") }, additionalProperties: false },
    }, additionalProperties: false,
  },
  CurrentPrincipal: {
    type: "object", required: ["id", "principal_id", "display_name", "is_owner", "version", "management_grants"],
    properties: {
      id: ref("Uuid"), principal_id: ref("Uuid"), display_name: string(), is_owner: { type: "boolean" }, version: ref("Version"),
      management_grants: { type: "array", items: ref("Administrator") },
      grants: { type: "array", items: ref("WebSessionProjectScopeItem") }, allowed_actions: { type: "array", items: string() },
      created_at: ref("Timestamp"), updated_at: ref("Timestamp"), deleted_at: { type: "null" },
      credential: { anyOf: [{ type: "object", required: ["fingerprint", "id"], properties: { fingerprint: string(), id: ref("Uuid") }, additionalProperties: false }, { type: "null" }] },
    }, additionalProperties: false,
  },
  CreateAdministratorRequest: { type: "object", required: ["principal_id", "expected_version"], properties: { principal_id: ref("Uuid"), expected_version: integer({ minimum: 0, description: "0 for first grant; current revoked row version for regrant. Regrant creates a new generation." }) }, additionalProperties: false },
  CreateGrantRequest: { type: "object", required: ["principal_id", "role"], properties: { principal_id: ref("Uuid"), role: ref("ProjectRole") }, additionalProperties: false },
  UpdateGrantRequest: { type: "object", required: ["expected_version", "role"], properties: { expected_version: ref("Version"), role: ref("ProjectRole") }, additionalProperties: false },
  CreateWebLaunchRequest: { type: "object", required: ["target"], properties: { target: { oneOf: [{ type: "object", required: ["kind", "workspace_id"], properties: { kind: { const: "workspace" }, workspace_id: ref("Uuid") }, additionalProperties: false }, { type: "object", required: ["kind", "workspace_id", "project_id"], properties: { kind: { const: "project" }, workspace_id: ref("Uuid"), project_id: ref("Uuid") }, additionalProperties: false }, { type: "object", required: ["kind", "identifier"], properties: { kind: { const: "issue" }, identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }) }, additionalProperties: false }, { type: "object", required: ["kind", "section"], properties: { kind: { const: "admin" }, section: string({ enum: ["overview", "workspaces-projects", "access", "audit"] }) }, additionalProperties: false }] } }, additionalProperties: false },
  RedeemWebLaunchRequest: { type: "object", required: ["launch_code"], properties: { launch_code: string({ minLength: 59, maxLength: 59, pattern: "^cfl_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$", writeOnly: true }) }, additionalProperties: false },
  WebAuthnRegistrationCredential: {
    type: "object",
    required: ["id", "rawId", "response", "type"],
    properties: {
      authenticatorAttachment: nullableString({ enum: ["platform", "cross-platform"] }),
      clientExtensionResults: { type: "object", maxProperties: 0, additionalProperties: false },
      id: ref("WebAuthnCredentialId"),
      rawId: ref("WebAuthnCredentialId"),
      type: { const: "public-key" },
      response: {
        type: "object",
        required: ["attestationObject", "clientDataJSON"],
        properties: {
          attestationObject: ref("WebAuthnAttestation"),
          authenticatorData: ref("WebAuthnAuthenticatorData"),
          clientDataJSON: ref("WebAuthnClientData"),
          publicKey: { anyOf: [string({ minLength: 1, maxLength: 5462, pattern: "^[A-Za-z0-9_-]+$" }), { type: "null" }] },
          publicKeyAlgorithm: { anyOf: [integer({ enum: [-257, -7] }), { type: "null" }] },
          transports: { type: "array", maxItems: 8, uniqueItems: true, items: string({ enum: ["ble", "hybrid", "internal", "nfc", "smart-card", "usb"] }) },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  WebAuthnAuthenticationCredential: {
    type: "object",
    required: ["id", "rawId", "response", "type"],
    properties: {
      authenticatorAttachment: nullableString({ enum: ["platform", "cross-platform"] }),
      clientExtensionResults: { type: "object", maxProperties: 0, additionalProperties: false },
      id: ref("WebAuthnCredentialId"),
      rawId: ref("WebAuthnCredentialId"),
      type: { const: "public-key" },
      response: {
        type: "object",
        required: ["authenticatorData", "clientDataJSON", "signature", "userHandle"],
        properties: {
          authenticatorData: ref("WebAuthnAuthenticatorData"),
          clientDataJSON: ref("WebAuthnClientData"),
          signature: ref("WebAuthnSignature"),
          userHandle: ref("WebAuthnUserHandle"),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  RegisterPasskeyRequest: { type: "object", required: ["challenge_id", "credential"], properties: { challenge_id: ref("Uuid"), credential: ref("WebAuthnRegistrationCredential") }, additionalProperties: false },
  VerifyWebAuthenticationRequest: { type: "object", required: ["challenge_id", "credential"], properties: { challenge_id: ref("Uuid"), credential: ref("WebAuthnAuthenticationCredential") }, additionalProperties: false },
  EnablePublicJoinRequest: { type: "object", required: ["expected_version", "public_summary", "issue_limit", "comment_limit", "principal_limit"], properties: { expected_version: { ...ref("Version"), description: "Current Project version from the policy response's project.version; policy_version is not this CAS value." }, public_summary: string({ minLength: 1, maxLength: 512 }), issue_limit: integer({ minimum: 1 }), comment_limit: integer({ minimum: 1 }), principal_limit: integer({ minimum: 1 }) }, additionalProperties: false },
  UpdateResourceLimitsRequest: { type: "object", required: ["expected_version", "issue_limit", "comment_limit", "principal_limit"], properties: { expected_version: { ...ref("Version"), description: "Current Project version from the resource-limits response's project.version; the Public Join policy_version is not this CAS value." }, issue_limit: integer({ minimum: 1 }), comment_limit: integer({ minimum: 1 }), principal_limit: integer({ minimum: 1 }) }, additionalProperties: false },
  RedeemPublicJoinRequest: {
    oneOf: [
      { type: "object", required: ["display_name", "new_credential_token", "redeem_as", "role"], properties: { display_name: ref("PrincipalDisplayNameInput"), new_credential_token: credentialToken(), redeem_as: { const: "new_principal" }, role: ref("ProjectRole") }, additionalProperties: false },
      { type: "object", required: ["redeem_as", "role"], properties: { redeem_as: { const: "current_principal" }, role: ref("ProjectRole") }, additionalProperties: false },
    ],
  },
  PublicProject: {
    type: "object",
    required: ["display_name", "public_id", "public_summary", "role_choices"],
    properties: {
      display_name: string({ minLength: 1, maxLength: 128 }),
      public_id: ref("Uuid"),
      public_summary: string({ minLength: 1, maxLength: 512 }),
      role_choices: { type: "array", minItems: 2, maxItems: 2, uniqueItems: true, items: ref("ProjectRole") },
    },
    additionalProperties: false,
  },
  PublicProjectListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("PublicProject") },
      next_cursor: nullableString(),
    },
    additionalProperties: false,
  },
  PublicJoinPolicy: {
    type: "object",
    required: ["active_usage", "allowed_actions", "created_at", "disabled_at", "enabled", "enabled_at", "policy_version", "project", "public_id", "public_summary", "resource_limits", "updated_at"],
    properties: {
      active_usage: {
        type: "object",
        required: ["comments", "issues", "principals"],
        properties: { comments: integer({ minimum: 0 }), issues: integer({ minimum: 0 }), principals: integer({ minimum: 0 }) },
        additionalProperties: false,
      },
      allowed_actions: { type: "array", uniqueItems: true, items: string({ enum: ["read", "enable", "update", "disable", "update_limits"] }) },
      created_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      disabled_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      enabled: { type: "boolean" },
      enabled_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      policy_version: { anyOf: [ref("Version"), { type: "null" }] },
      project: {
        type: "object",
        required: ["display_name", "id", "version", "workspace_id", "workspace_display_name"],
        properties: { display_name: string({ minLength: 1, maxLength: 128 }), id: ref("Uuid"), version: ref("Version"), workspace_id: ref("Uuid"), workspace_display_name: string() },
        additionalProperties: false,
      },
      public_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      public_summary: { anyOf: [string({ minLength: 1, maxLength: 512 }), { type: "null" }] },
      resource_limits: {
        type: "object",
        required: ["comments", "issues", "principals"],
        properties: {
          comments: { anyOf: [integer({ minimum: 1 }), { type: "null" }] },
          issues: { anyOf: [integer({ minimum: 1 }), { type: "null" }] },
          principals: { anyOf: [integer({ minimum: 1 }), { type: "null" }] },
        },
        additionalProperties: false,
      },
      updated_at: ref("Timestamp"),
    },
    additionalProperties: false,
  },
  PublicJoinPolicyWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("PublicJoinPolicy") },
    additionalProperties: false,
  },
  PublicJoinRedemptionResource: {
    type: "object",
    required: ["allowed_actions", "credential", "grant", "outcome", "principal", "project", "public_id"],
    properties: {
      allowed_actions: { type: "array", minItems: 1, uniqueItems: true, items: string({ enum: ["read", "write"] }) },
      credential: {
        anyOf: [
          { type: "object", required: ["fingerprint", "id", "issued_at"], properties: { fingerprint: string({ minLength: 1 }), id: ref("Uuid"), issued_at: ref("Timestamp") }, additionalProperties: false },
          { type: "null" },
        ],
      },
      grant: {
        type: "object",
        required: ["effective_capabilities", "id", "role", "version"],
        properties: {
          effective_capabilities: { type: "object", required: ["read", "write"], properties: { read: { const: true }, write: { type: "boolean" } }, additionalProperties: false },
          id: ref("Uuid"),
          role: ref("ProjectRole"),
          version: ref("Version"),
        },
        additionalProperties: false,
      },
      outcome: string({ enum: ["already_has_access", "created", "promoted", "regranted"] }),
      principal: { type: "object", required: ["display_name", "principal_id"], properties: { display_name: string({ minLength: 1, maxLength: 128 }), principal_id: ref("Uuid") }, additionalProperties: false },
      project: {
        type: "object",
        required: ["display_name", "id", "public_summary", "workspace_id", "workspace_display_name"],
        properties: { display_name: string({ minLength: 1, maxLength: 128 }), id: ref("Uuid"), public_summary: string({ minLength: 1, maxLength: 512 }), workspace_id: ref("Uuid"), workspace_display_name: string() },
        additionalProperties: false,
      },
      public_id: ref("Uuid"),
    },
    additionalProperties: false,
  },
  PublicJoinRedemptionWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("PublicJoinRedemptionResource") },
    additionalProperties: false,
  },
  AttachmentSettings: {
    type: "object", required: ["limit_bytes", "configured", "version", "reserved_bytes"],
    properties: { limit_bytes: { type: ["integer", "null"], minimum: 1, maximum: 9007199254740991 }, configured: { type: "boolean" }, version: ref("Version"), reserved_bytes: integer({ minimum: 0 }) }, additionalProperties: false,
  },
  UpdateAttachmentSettingsRequest: {
    type: "object", required: ["expected_version", "limit_bytes"],
    properties: { expected_version: ref("Version"), limit_bytes: { type: ["integer", "null"], minimum: 1, maximum: 9007199254740991 } }, additionalProperties: false,
  },
  AttachmentSettingsWriteResult: containerWriteResult("AttachmentSettings"),
  RefreshUsageRequest: { type: "object", required: ["mode"], properties: { mode: string({ enum: ["stale", "manual"] }) }, additionalProperties: false },
  UsageMetric: {
    type: "object",
    required: ["key", "value", "unit", "source", "scope", "period_start", "period_end", "observed_at"],
    properties: {
      key: string({ enum: ["d1_storage_bytes", "d1_rows_read", "d1_rows_written", "r2_storage_bytes", "r2_objects", "r2_operations"] }),
      value: { type: ["number", "null"], minimum: 0 },
      unit: string({ enum: ["bytes", "count"] }),
      source: { const: "cloudflare" },
      scope: { const: "instance" },
      period_start: { anyOf: [ref("Timestamp"), { type: "null" }] },
      period_end: { anyOf: [ref("Timestamp"), { type: "null" }] },
      observed_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
    },
    additionalProperties: false,
  },
  Usage: {
    type: "object",
    required: ["generated_at", "attachments", "cloudflare"],
    properties: {
      generated_at: ref("Timestamp"),
      attachments: {
        type: "object", required: ["enabled", "reserved_bytes", "limit_bytes", "limit_configured", "settings_version"],
        properties: { enabled: { type: "boolean" }, reserved_bytes: integer({ minimum: 0 }), limit_bytes: { type: ["integer", "null"], minimum: 1, maximum: 9007199254740991 }, limit_configured: { type: "boolean" }, settings_version: ref("Version") },
        additionalProperties: false,
      },
      cloudflare: {
        type: "object", required: ["status", "refreshing", "collected_at", "attempted_at", "error", "metrics"],
        properties: {
          refreshing: { type: "boolean" },
          status: string({ enum: ["not_configured", "pending", "fresh", "stale", "error"] }),
          collected_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
          attempted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
          error: { type: ["string", "null"], maxLength: 64 },
          metrics: { type: "array", maxItems: 6, items: ref("UsageMetric") },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  RateLimitSettings: {
    type: "object",
    required: ["allowed_actions", "configuration_source", "editable_via_api", "policies", "recent_429_summary"],
    properties: {
      allowed_actions: { type: "array", minItems: 1, maxItems: 1, items: { const: "read" } },
      configuration_source: { const: "worker_configuration" },
      editable_via_api: { const: false },
      policies: {
        type: "object",
        required: ["instance", "principal", "unauthenticated_sensitive"],
        properties: {
          instance: { type: "object", required: ["limit", "period_seconds"], properties: { limit: integer({ minimum: 1 }), period_seconds: integer({ enum: [10, 60] }) }, additionalProperties: false },
          principal: { type: "object", required: ["limit", "period_seconds"], properties: { limit: integer({ minimum: 1 }), period_seconds: integer({ enum: [10, 60] }) }, additionalProperties: false },
          unauthenticated_sensitive: { type: "object", required: ["limit", "period_seconds"], properties: { limit: integer({ minimum: 1 }), period_seconds: integer({ enum: [10, 60] }) }, additionalProperties: false },
        },
        additionalProperties: false,
      },
      recent_429_summary: {
        type: "object",
        required: ["as_of", "by_scope", "observation_scope", "total", "window_seconds"],
        properties: {
          as_of: ref("Timestamp"),
          by_scope: { type: "object", required: ["instance", "principal", "unauthenticated_sensitive"], properties: { instance: integer({ minimum: 0 }), principal: integer({ minimum: 0 }), unauthenticated_sensitive: integer({ minimum: 0 }) }, additionalProperties: false },
          observation_scope: { const: "worker_isolate_best_effort" },
          total: integer({ minimum: 0, maximum: 128 }),
          window_seconds: integer({ const: 300 }),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  Health: { type: "object", required: ["service_version", "schema_version", "d1"], properties: { service_version: string(), schema_version: integer({ minimum: 1 }), d1: string({ enum: ["reachable", "unavailable"] }) }, additionalProperties: false },
  InstanceDiscovery: { type: "object", required: ["discovery_version", "instance_id", "service_version", "observed_origin", "preferred_api_origin", "origin_version", "updated_at"], properties: { discovery_version: integer({ const: 1 }), instance_id: string({ minLength: 1 }), service_version: string(), observed_origin: string({ format: "uri", pattern: "^https://[^/?#]+$" }), preferred_api_origin: string({ format: "uri", pattern: "^https://[^/?#]+$" }), origin_version: ref("Version"), updated_at: ref("Timestamp") }, additionalProperties: false },
  IssueLabelSummary: {
    type: "object",
    required: ["color", "id", "name"],
    properties: { color: nullableString({ pattern: "^#[0-9A-Fa-f]{6}$" }), id: ref("Uuid"), name: string() },
    additionalProperties: false,
  },
  IssueSummary: {
    type: "object",
    required: issueSummaryRequired,
    properties: issueSummaryProperties,
    additionalProperties: false,
  },
  IssueDetail: {
    type: "object",
    required: issueDetailRequired,
    properties: issueDetailProperties,
    additionalProperties: false,
  },
  IssueRelationSummary: {
    type: "object",
    required: ["id", "kind", "source_identifier", "target_identifier", "version"],
    properties: {
      id: ref("Uuid"),
      kind: ref("RelationKind"),
      source_identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
      target_identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  IssueCommentSummary: {
    type: "object",
    required: ["author", "body", "created_at", "id", "kind", "version"],
    properties: {
      author: {
        type: "object",
        required: ["display_name", "principal_id"],
        properties: { display_name: string(), principal_id: ref("Uuid") },
        additionalProperties: false,
      },
      body: string(),
      created_at: ref("Timestamp"),
      id: ref("Uuid"),
      kind: string({ enum: ["standard", "completion"] }),
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  IssueFullDetail: {
    type: "object",
    required: [...issueDetailRequired, "comment_continuation", "comments", "relation_continuation", "relations"],
    properties: {
      ...issueDetailProperties,
      comment_continuation: nullableString(),
      comments: { type: "array", items: ref("IssueCommentSummary") },
      relation_continuation: nullableString(),
      relations: { type: "array", items: ref("IssueRelationSummary") },
    },
    additionalProperties: false,
  },
  IssueTombstone: {
    type: "object",
    required: [...issueSummaryRequired, "allowed_actions", "deleted_by_principal_id", "parent_status", "restorable", "unavailability_reason"],
    properties: {
      ...issueSummaryProperties,
      allowed_actions: { type: "array", items: string({ enum: ["restore"] }), maxItems: 1 },
      deleted_by_principal_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      parent_status: {
        type: "object",
        required: ["project", "workspace"],
        properties: { project: string({ enum: ["active", "deleted"] }), workspace: string({ enum: ["active", "deleted"] }) },
        additionalProperties: false,
      },
      restorable: { type: "boolean" },
      unavailability_reason: {
        anyOf: [
          {
            type: "object",
            required: ["code", "recovery"],
            properties: {
              code: string(),
              current_usage: integer({ minimum: 0 }),
              limit: integer({ minimum: 0 }),
              recovery: string(),
              resource_kind: string({ enum: ["issues", "comments"] }),
            },
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
    },
    additionalProperties: false,
  },
  IssueResolvedScope: {
    type: "object",
    required: ["broad_search", "expanded_to_all_authorized_projects", "filters", "project_targets", "projects", "target_identifier", "unresolved_project_targets", "unresolved_workspace_targets", "workspace_targets"],
    properties: {
      broad_search: { type: "boolean" },
      candidate_policy: {
        type: "object",
        required: ["assignment", "blocked", "status_category"],
        properties: {
          assignment: string({ enum: ["unassigned", "mine", "needs_reassignment"] }),
          blocked: string({ enum: ["exclude", "include"] }),
          status_category: { const: "unstarted" },
        },
        additionalProperties: false,
      },
      expanded_to_all_authorized_projects: { type: "boolean" },
      filters: {
        type: "object",
        required: ["assignees", "statuses"],
        properties: {
          assignees: { type: "array", maxItems: 20, items: ref("Uuid") },
          statuses: { type: "array", maxItems: 5, items: ref("StatusKey") },
        },
        additionalProperties: false,
      },
      project_targets: { type: "array", maxItems: 20, items: string() },
      projects: {
        type: "array",
        items: {
          type: "object",
          required: ["project_id", "project_display_name", "workspace_id", "workspace_display_name"],
          properties: { project_id: ref("Uuid"), project_display_name: string(), workspace_id: ref("Uuid"), workspace_display_name: string() },
          additionalProperties: false,
        },
      },
      target_identifier: { anyOf: [string({ pattern: "^CFK-[1-9][0-9]*$" }), { type: "null" }] },
      unresolved_project_targets: { type: "array", items: string() },
      unresolved_workspace_targets: { type: "array", items: string() },
      workspace_targets: { type: "array", maxItems: 20, items: string() },
    },
    additionalProperties: false,
  },
  IssueListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: { oneOf: [ref("IssueSummary"), ref("IssueTombstone")] } },
      next_cursor: nullableString(),
      resolved_scope: ref("IssueResolvedScope"),
    },
    additionalProperties: false,
  },
  IssueContext: {
    type: "object",
    required: ["issue", "sections", "truncated"],
    properties: {
      issue: {
        type: "object",
        required: [...issueSummaryRequired, "allowed_actions", "blocked_reason"],
        properties: { ...issueSummaryProperties, allowed_actions: { type: "array", items: string() }, blocked_reason: nullableString() },
        additionalProperties: false,
      },
      sections: {
        type: "object",
        required: ["body", "comments", "project_context", "relations"],
        properties: {
          body: {
            type: "object",
            required: ["content", "continuation", "omitted_bytes", "truncated"],
            properties: { content: string(), continuation: nullableString(), omitted_bytes: integer({ minimum: 0 }), truncated: { type: "boolean" } },
            additionalProperties: false,
          },
          comments: {
            type: "object",
            required: ["continuation", "items", "omitted_count"],
            properties: { continuation: nullableString(), items: { type: "array", items: ref("IssueCommentSummary") }, omitted_count: integer({ minimum: 0 }) },
            additionalProperties: false,
          },
          project_context: {
            type: "object",
            required: ["content", "continuation", "omitted_bytes", "truncated"],
            properties: { content: string(), continuation: nullableString(), omitted_bytes: integer({ minimum: 0 }), truncated: { type: "boolean" } },
            additionalProperties: false,
          },
          relations: {
            type: "object",
            required: ["continuation", "items", "omitted_count"],
            properties: { continuation: nullableString(), items: { type: "array", items: ref("IssueRelationSummary") }, omitted_count: integer({ minimum: 0 }) },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      truncated: { type: "boolean" },
    },
    additionalProperties: false,
  },
  CompletedIssueDetail: {
    type: "object",
    required: [...issueDetailRequired, "completion_comment_id"],
    properties: { ...issueDetailProperties, completion_comment_id: ref("Uuid") },
    additionalProperties: false,
  },
  ActiveIssueListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("IssueSummary") },
      next_cursor: nullableString(),
      resolved_scope: ref("IssueResolvedScope"),
    },
    additionalProperties: false,
  },
  ActiveIssueWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("IssueDetail") },
    additionalProperties: false,
  },
  CompletedIssueWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("CompletedIssueDetail") },
    additionalProperties: false,
  },
  DeletedIssueWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("IssueTombstone") },
    additionalProperties: false,
  },
  IssueReference: {
    type: "object",
    required: ["id", "identifier", "project", "title", "version"],
    properties: {
      id: ref("Uuid"),
      identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
      project: {
        type: "object",
        required: ["id", "display_name", "workspace_id", "workspace_display_name"],
        properties: { id: ref("Uuid"), display_name: string(), workspace_id: ref("Uuid"), workspace_display_name: string() },
        additionalProperties: false,
      },
      title: string(),
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  CompletionPayload: {
    type: "object",
    required: ["artifacts", "follow_ups", "summary", "verification"],
    properties: {
      artifacts: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          required: ["kind", "value"],
          properties: { kind: string({ enum: ["url", "path", "commit", "other"] }), value: string({ minLength: 1 }) },
          additionalProperties: false,
        },
      },
      follow_ups: { type: "array", maxItems: 50, items: string({ minLength: 1 }) },
      summary: string({ maxLength: 8192 }),
      verification: { type: "array", maxItems: 50, items: string({ minLength: 1 }) },
    },
    additionalProperties: false,
  },
  ActiveStandardComment: {
    type: "object",
    required: commentCommonRequired,
    properties: {
      ...commentCommonProperties,
      body: string({ minLength: 1 }),
      completion: { type: "null" },
      deleted_at: { type: "null" },
      deleted_by_principal_id: { type: "null" },
      kind: { const: "standard" },
      reply_to_comment_id: { anyOf: [ref("Uuid"), { type: "null" }] },
    },
    additionalProperties: false,
  },
  CompletionComment: {
    type: "object",
    required: commentCommonRequired,
    properties: {
      ...commentCommonProperties,
      body: string({ description: "Completion summary; empty when no completion note was supplied." }),
      completion: ref("CompletionPayload"),
      deleted_at: { type: "null" },
      deleted_by_principal_id: { type: "null" },
      kind: { const: "completion" },
      reply_to_comment_id: { type: "null" },
    },
    additionalProperties: false,
  },
  DeletedStandardComment: {
    type: "object",
    required: [...commentCommonRequired, "parent_status", "restorable", "unavailability_reason"],
    properties: {
      ...commentCommonProperties,
      body: { type: "null" },
      completion: { type: "null" },
      deleted_at: ref("Timestamp"),
      deleted_by_principal_id: ref("Uuid"),
      kind: { const: "standard" },
      parent_status: {
        type: "object",
        required: ["issue", "project", "workspace"],
        properties: {
          issue: string({ enum: ["active", "deleted"] }),
          project: string({ enum: ["active", "deleted"] }),
          workspace: string({ enum: ["active", "deleted"] }),
        },
        additionalProperties: false,
      },
      reply_to_comment_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      restorable: { type: "boolean" },
      unavailability_reason: {
        anyOf: [
          {
            type: "object",
            required: ["code", "recovery"],
            properties: { code: string(), recovery: string() },
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
    },
    additionalProperties: false,
  },
  Comment: {
    oneOf: [ref("ActiveStandardComment"), ref("CompletionComment"), ref("DeletedStandardComment")],
  },
  CommentListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("Comment") },
      next_cursor: nullableString(),
      resolved_scope: {
        type: "object",
        required: ["issue"],
        properties: { issue: ref("IssueReference") },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  CommentWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("Comment") },
    additionalProperties: false,
  },
  Label: {
    type: "object",
    required: ["allowed_actions", "color", "created_at", "deleted_at", "deleted_by_principal_id", "id", "name", "project", "updated_at", "version"],
    properties: {
      allowed_actions: { type: "array", items: string({ enum: ["read", "update", "delete", "restore"] }) },
      color: nullableString({ pattern: "^#[0-9A-F]{6}$" }),
      created_at: ref("Timestamp"),
      deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      deleted_by_principal_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      id: ref("Uuid"),
      name: string({ minLength: 1, maxLength: 64 }),
      parent_status: {
        type: "object",
        required: ["project", "workspace"],
        properties: {
          project: string({ enum: ["active", "deleted"] }),
          workspace: string({ enum: ["active", "deleted"] }),
        },
        additionalProperties: false,
      },
      project: {
        type: "object",
        required: ["id", "display_name", "workspace_id", "workspace_display_name"],
        properties: { id: ref("Uuid"), display_name: string(), workspace_id: ref("Uuid"), workspace_display_name: string() },
        additionalProperties: false,
      },
      updated_at: ref("Timestamp"),
      restorable: { type: "boolean" },
      unavailability_reason: {
        anyOf: [
          {
            type: "object",
            required: ["code", "recovery"],
            properties: { code: string(), recovery: string() },
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  LabelListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("Label") },
      next_cursor: nullableString(),
      resolved_scope: {
        type: "object",
        required: ["project_id", "project_display_name", "workspace_id", "workspace_display_name"],
        properties: { project_id: ref("Uuid"), project_display_name: string(), workspace_id: ref("Uuid"), workspace_display_name: string() },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  LabelWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("Label") },
    additionalProperties: false,
  },
  RelationEndpoint: {
    type: "object",
    required: ["id", "identifier", "project", "title", "version"],
    properties: {
      id: ref("Uuid"),
      identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
      project: {
        type: "object",
        required: ["id", "display_name", "workspace_id", "workspace_display_name"],
        properties: { id: ref("Uuid"), display_name: string(), workspace_id: ref("Uuid"), workspace_display_name: string() },
        additionalProperties: false,
      },
      title: string(),
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  Relation: {
    type: "object",
    required: ["allowed_actions", "created_at", "created_by_principal_id", "deleted_at", "deleted_by_principal_id", "id", "kind", "source", "target", "version", "workspace"],
    properties: {
      allowed_actions: { type: "array", items: string({ enum: ["read", "delete", "restore"] }) },
      created_at: ref("Timestamp"),
      created_by_principal_id: ref("Uuid"),
      deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      deleted_by_principal_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      id: ref("Uuid"),
      kind: ref("RelationKind"),
      parent_status: {
        type: "object",
        required: ["source_issue", "source_project", "target_issue", "target_project", "workspace"],
        properties: {
          source_issue: string({ enum: ["active", "deleted"] }),
          source_project: string({ enum: ["active", "deleted"] }),
          target_issue: string({ enum: ["active", "deleted"] }),
          target_project: string({ enum: ["active", "deleted"] }),
          workspace: string({ enum: ["active", "deleted"] }),
        },
        additionalProperties: false,
      },
      restorable: { type: "boolean" },
      source: ref("RelationEndpoint"),
      target: ref("RelationEndpoint"),
      unavailability_reason: {
        anyOf: [
          {
            type: "object",
            required: ["code", "recovery"],
            properties: { code: string(), recovery: string() },
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
      version: ref("Version"),
      workspace: {
        type: "object",
        required: ["id", "display_name"],
        properties: { id: ref("Uuid"), display_name: string() },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  RelationListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("Relation") },
      next_cursor: nullableString(),
      resolved_scope: {
        type: "object",
        required: ["issue_id", "issue_identifier", "visible_project_ids"],
        properties: {
          issue_id: ref("Uuid"),
          issue_identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
          visible_project_ids: { type: "array", items: ref("Uuid") },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  RelationWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("Relation") },
    additionalProperties: false,
  },
  InvitationGrantSummary: {
    type: "object",
    required: ["display_name", "project_id", "role", "workspace_id", "workspace_display_name"],
    properties: {
      display_name: string(),
      project_id: ref("Uuid"),
      role: ref("ProjectRole"),
      workspace_id: ref("Uuid"), workspace_display_name: string(),
    },
    additionalProperties: false,
  },
  Invitation: {
    type: "object",
    required: invitationRequired,
    properties: invitationProperties,
    additionalProperties: false,
  },
  InvitationListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("Invitation") },
      next_cursor: nullableString(),
      resolved_scope: {
        oneOf: [
          { type: "object", required: ["owner_principal_id"], properties: { owner_principal_id: ref("Uuid") }, additionalProperties: false },
          { type: "object", required: ["principal_id", "project_ids", "project_id"], properties: { principal_id: ref("Uuid"), project_ids: { type: "array", items: ref("Uuid") }, project_id: { anyOf: [ref("Uuid"), { type: "null" }] } }, additionalProperties: false },
        ],
      },
    },
    additionalProperties: false,
  },
  InvitationCreateResource: {
    oneOf: [
      {
        type: "object",
        required: [...invitationRequired, "copy_text", "invite_url", "secret_available"],
        properties: {
          ...invitationProperties,
          copy_text: string({ minLength: 1 }),
          invite_url: string({ format: "uri" }),
          secret_available: { const: true },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: [...invitationRequired, "secret_available"],
        properties: { ...invitationProperties, secret_available: { const: false } },
        additionalProperties: false,
      },
    ],
  },
  InvitationCreateWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: {
      event_cursor: string(),
      idempotent_replay: { type: "boolean" },
      resource: ref("InvitationCreateResource"),
    },
    additionalProperties: false,
  },
  InvitationWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: {
      event_cursor: string(),
      idempotent_replay: { type: "boolean" },
      resource: ref("Invitation"),
    },
    additionalProperties: false,
  },
  InvitationRedemptionResource: {
    type: "object",
    required: [...invitationRequired, "credential", "principal", "results"],
    properties: {
      ...invitationProperties,
      credential: {
        anyOf: [
          {
            type: "object",
            required: ["fingerprint", "id", "issued_at"],
            properties: { fingerprint: string(), id: ref("Uuid"), issued_at: ref("Timestamp") },
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
      principal: {
        type: "object",
        required: ["display_name", "principal_id"],
        properties: { display_name: string(), principal_id: ref("Uuid") },
        additionalProperties: false,
      },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["effective_role", "outcome", "project_id"],
          properties: {
            effective_role: ref("ProjectRole"),
            outcome: string({ enum: ["created", "regranted", "already_has_access"] }),
            project_id: ref("Uuid"),
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  InvitationRedemptionWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: {
      event_cursor: string(),
      idempotent_replay: { type: "boolean" },
      resource: ref("InvitationRedemptionResource"),
    },
    additionalProperties: false,
  },
  Event: {
    type: "object",
    required: ["actor", "administrator_grant_id", "administrator_grant_version", "authorized_via", "created_at", "event_index", "grant_id", "id", "operation_id", "payload", "project", "subject", "type", "workspace"],
    properties: {
      actor: {
        anyOf: [
          {
            type: "object",
            required: ["credential_id", "display_name", "principal_id"],
            properties: {
              credential_id: { anyOf: [ref("Uuid"), { type: "null" }] },
              display_name: string(),
              principal_id: ref("Uuid"),
            },
            additionalProperties: false,
          },
          { type: "null" },
        ],
      },
      administrator_grant_id: {
        description: "Scoped administrator Grant used to authorize the Event, when applicable.",
        anyOf: [ref("Uuid"), { type: "null" }],
      },
      administrator_grant_version: {
        description: "Scoped administrator Grant version captured when authorizing the Event, when applicable.",
        anyOf: [integer({ minimum: 1 }), { type: "null" }],
      },
      authorized_via: string({
        description: "Historical authorization path used for this Event; it does not identify the mutated resource.",
        enum: ["deployment_owner", "workspace_admin", "project_admin", "project_grant", "public_join", "invitation", "browser_launch", "web_session", "webauthn", "deployment_recovery"],
      }),
      created_at: ref("Timestamp"),
      event_index: integer({ minimum: 0 }),
      grant_id: {
        description: "Project Grant involved in the Event's authorization context when one exists. On Grant-management Events it can also equal the Grant subject; use subject.type and subject.id to identify the mutated resource.",
        anyOf: [ref("Uuid"), { type: "null" }],
      },
      id: ref("Uuid"),
      operation_id: ref("Uuid"),
      payload: {},
      project: {
        anyOf: [
          { type: "object", required: ["display_name", "id"], properties: { display_name: string(), id: ref("Uuid") }, additionalProperties: false },
          { type: "null" },
        ],
      },
      stream: string({ enum: ["domain", "security"] }),
      subject: {
        type: "object",
        description: "Stable type and ID of the resource whose lifecycle this Event records. Use this pair, not grant_id alone, to classify resource mutations.",
        required: ["id", "type"],
        properties: { id: string(), type: string() },
        additionalProperties: false,
      },
      type: string(),
      workspace: {
        anyOf: [
          { type: "object", required: ["display_name", "id"], properties: { display_name: string(), id: ref("Uuid") }, additionalProperties: false },
          { type: "null" },
        ],
      },
    },
    additionalProperties: false,
  },
  EventResolvedScope: {
    type: "object",
    required: ["expanded_to_all_authorized_projects", "projects", "unresolved_project_targets", "unresolved_workspace_targets"],
    properties: {
      expanded_to_all_authorized_projects: { type: "boolean" },
      projects: {
        type: "array",
        items: {
          type: "object",
          required: ["project_id", "project_display_name", "workspace_id", "workspace_display_name"],
          properties: { project_id: ref("Uuid"), project_display_name: string(), workspace_id: ref("Uuid"), workspace_display_name: string() },
          additionalProperties: false,
        },
      },
      unresolved_project_targets: { type: "array", items: string() },
      unresolved_workspace_targets: { type: "array", items: string() },
    },
    additionalProperties: false,
  },
  EventListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("Event") },
      next_cursor: string(),
      resolved_scope: ref("EventResolvedScope"),
    },
    additionalProperties: false,
  },
  AuditEvent: {
    allOf: [ref("Event"), { type: "object", required: ["stream"] }],
  },
  AuditEventResolvedFilters: {
    type: "object",
    required: ["project_id", "streams"],
    properties: {
      project_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      streams: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        items: string({ enum: ["domain", "security"] }),
      },
    },
    additionalProperties: false,
  },
  AuditEventListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_filters"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("AuditEvent") },
      next_cursor: string(),
      resolved_filters: ref("AuditEventResolvedFilters"),
    },
    additionalProperties: false,
  },
  BrowserLaunchTarget: {
    oneOf: [
      { type: "object", required: ["entry_path", "kind", "workspace_id"], properties: { entry_path: string({ pattern: "^/app/manage\\?workspace=" }), kind: { const: "workspace" }, workspace_id: ref("Uuid") }, additionalProperties: false },
      {
        type: "object",
        required: ["entry_path", "kind", "project_id", "workspace_id"],
        properties: {
          entry_path: string({ pattern: "^/app/" }),
          kind: { const: "project" },
          project_id: ref("Uuid"),
          workspace_id: ref("Uuid"),
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["entry_path", "identifier", "issue_id", "kind", "project_id", "workspace_id"],
        properties: {
          entry_path: string({ pattern: "^/app/issues/" }),
          identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
          issue_id: ref("Uuid"),
          kind: { const: "issue" },
          project_id: ref("Uuid"),
          workspace_id: ref("Uuid"),
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["entry_path", "kind", "section"],
        properties: {
          entry_path: string({ enum: ["/app/admin", "/app/admin?section=workspaces", "/app/admin?section=access", "/app/admin?section=audit"] }),
          kind: { const: "admin" },
          section: string({ enum: ["overview", "workspaces-projects", "access", "audit"] }),
        },
        additionalProperties: false,
      },
    ],
  },
  BrowserLaunchResource: {
    oneOf: [
      {
        type: "object",
        required: ["created_at", "expires_at", "id", "launch_url", "secret_available", "target"],
        properties: {
          created_at: ref("Timestamp"),
          expires_at: ref("Timestamp"),
          id: ref("Uuid"),
          launch_url: string({ format: "uri" }),
          secret_available: { const: true },
          target: ref("BrowserLaunchTarget"),
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["created_at", "expires_at", "id", "secret_available", "target"],
        properties: {
          created_at: ref("Timestamp"),
          expires_at: ref("Timestamp"),
          id: ref("Uuid"),
          secret_available: { const: false },
          target: ref("BrowserLaunchTarget"),
        },
        additionalProperties: false,
      },
    ],
  },
  BrowserLaunchWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: {
      event_cursor: string(),
      idempotent_replay: { type: "boolean" },
      resource: ref("BrowserLaunchResource"),
    },
    additionalProperties: false,
  },
  WebSessionProjectScopeItem: {
    type: "object",
    required: ["project_id", "project_display_name", "role", "workspace_id", "workspace_display_name"],
    properties: {
      project_id: ref("Uuid"),
      project_display_name: string(),
      role: string({ enum: ["owner", "reader", "writer"] }),
      workspace_id: ref("Uuid"), workspace_display_name: string(),
    },
    additionalProperties: false,
  },
  WebSessionAllowedScope: {
    oneOf: [
      { type: "object", required: ["kind", "workspace_id"], properties: { kind: { const: "workspace" }, workspace_id: ref("Uuid"), projects: { type: "array", items: ref("WebSessionProjectScopeItem") } }, additionalProperties: false },
      {
        type: "object",
        required: ["kind"],
        properties: { kind: { const: "instance" }, projects: { type: "array", items: ref("WebSessionProjectScopeItem") } },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["kind"],
        properties: { kind: { const: "project_selection" }, projects: { type: "array", items: ref("WebSessionProjectScopeItem") } },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["kind", "project_id"],
        properties: { kind: { const: "project" }, project_id: ref("Uuid") },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["kind", "projects"],
        properties: { kind: { const: "project" }, projects: { type: "array", items: ref("WebSessionProjectScopeItem") } },
        additionalProperties: false,
      },
    ],
  },
  WebSessionPrincipal: {
    type: "object",
    required: ["display_name", "id", "is_owner"],
    properties: {
      display_name: string(),
      id: ref("Uuid"),
      is_owner: { type: "boolean" },
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  WebSessionSource: {
    type: "object",
    required: ["id", "kind"],
    properties: { id: ref("Uuid"), kind: string({ enum: ["credential", "web_authenticator"] }) },
    additionalProperties: false,
  },
  WebSessionTarget: {
    oneOf: [
      ref("BrowserLaunchTarget"),
      {
        type: "object",
        required: ["entry_path", "kind"],
        properties: { entry_path: { const: "/app" }, kind: { const: "project_selection" } },
        additionalProperties: false,
      },
    ],
  },
  WebSessionExchangeResource: {
    type: "object",
    required: ["allowed_scope", "cookie_available", "entry_path", "expires_at", "principal", "session_id", "source", "target"],
    properties: {
      allowed_scope: ref("WebSessionAllowedScope"),
      cookie_available: { type: "boolean" },
      entry_path: string({ pattern: "^/app(?:/.*)?$" }),
      expires_at: ref("Timestamp"),
      principal: ref("WebSessionPrincipal"),
      session_id: ref("Uuid"),
      source: ref("WebSessionSource"),
      target: ref("WebSessionTarget"),
    },
    additionalProperties: false,
  },
  WebSessionExchangeWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: {
      event_cursor: string(),
      idempotent_replay: { type: "boolean" },
      resource: ref("WebSessionExchangeResource"),
    },
    additionalProperties: false,
  },
  WebSessionView: {
    type: "object",
    required: ["allowed_scope", "expires_at", "principal", "session_id", "source", "target", "management_grants"],
    properties: {
      management_grants: { type: "array", items: ref("Administrator") },
      allowed_scope: ref("WebSessionAllowedScope"),
      expires_at: ref("Timestamp"),
      principal: ref("WebSessionPrincipal"),
      session_id: ref("Uuid"),
      source: ref("WebSessionSource"),
      target: ref("WebSessionTarget"),
    },
    additionalProperties: false,
  },
  WebSessionRevocationWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: {
      event_cursor: string(),
      idempotent_replay: { type: "boolean" },
      resource: {
        type: "object",
        required: ["id", "revoked_at", "source"],
        properties: { id: ref("Uuid"), revoked_at: ref("Timestamp"), source: ref("WebSessionSource") },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  Passkey: {
    type: "object",
    required: ["algorithm", "backup_eligible", "backup_state", "created_at", "id", "last_used_at", "revoked_at", "rp_id", "transports", "version"],
    properties: {
      algorithm: integer({ enum: [-7, -257] }),
      backup_eligible: { type: "boolean" },
      backup_state: { type: "boolean" },
      created_at: ref("Timestamp"),
      id: ref("Uuid"),
      last_used_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      revoked_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      rp_id: string({ minLength: 1 }),
      transports: { type: "array", maxItems: 8, uniqueItems: true, items: string({ enum: ["ble", "hybrid", "internal", "nfc", "smart-card", "usb"] }) },
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  PrincipalPasskeySummary: {
    type: "object",
    required: ["algorithm", "allowed_actions", "backup_eligible", "backup_state", "created_at", "id", "last_used_at", "revoked_at", "rp_id", "transports", "version"],
    properties: {
      algorithm: integer({ enum: [-7, -257] }),
      allowed_actions: { type: "array", items: string({ enum: ["revoke"] }) },
      backup_eligible: { type: "boolean" },
      backup_state: { type: "boolean" },
      created_at: ref("Timestamp"),
      id: ref("Uuid"),
      last_used_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      revoked_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      rp_id: string({ minLength: 1 }),
      transports: { type: "array", maxItems: 8, uniqueItems: true, items: string({ enum: ["ble", "hybrid", "internal", "nfc", "smart-card", "usb"] }) },
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  PrincipalCredentialSummary: {
    type: "object",
    required: ["allowed_actions", "created_at", "deleted_at", "fingerprint", "id", "issued_at", "last_used_at", "principal", "principal_id", "revoke_reason", "revoked_at", "updated_at", "version"],
    properties: {
      allowed_actions: { type: "array", items: string({ enum: ["revoke"] }) },
      created_at: ref("Timestamp"),
      deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      fingerprint: string(),
      id: ref("Uuid"),
      issued_at: ref("Timestamp"),
      last_used_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      principal: { type: "object", required: ["display_name", "principal_id"], properties: { display_name: string(), principal_id: ref("Uuid") }, additionalProperties: false },
      principal_id: ref("Uuid"),
      revoke_reason: { anyOf: [string(), { type: "null" }] },
      revoked_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      updated_at: ref("Timestamp"),
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  PrincipalGrantSummary: {
    type: "object",
    required: ["allowed_actions", "created_at", "deleted_at", "id", "principal", "principal_id", "project", "project_id", "revoked_at", "role", "updated_at", "version"],
    properties: {
      allowed_actions: { type: "array", items: string() },
      created_at: ref("Timestamp"),
      deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      id: ref("Uuid"),
      principal: { type: "object", required: ["display_name", "principal_id"], properties: { display_name: string(), principal_id: ref("Uuid") }, additionalProperties: false },
      principal_id: ref("Uuid"),
      project: { type: "object", required: ["display_name", "id", "workspace_id", "workspace_display_name"], properties: { display_name: string(), id: ref("Uuid"), workspace_id: ref("Uuid"), workspace_display_name: string() }, additionalProperties: false },
      project_id: ref("Uuid"),
      revoked_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      role: ref("ProjectRole"),
      updated_at: ref("Timestamp"),
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  PrincipalDetail: {
    type: "object",
    required: ["active_credential_count", "active_grant_count", "assignee_count", "created_at", "credentials", "credentials_has_more", "deleted_at", "display_name", "grants", "grants_has_more", "id", "is_owner", "passkeys", "passkeys_has_more", "principal_id", "updated_at", "version"],
    properties: {
      active_credential_count: integer({ minimum: 0 }),
      active_grant_count: integer({ minimum: 0 }),
      assignee_count: integer({ minimum: 0 }),
      created_at: ref("Timestamp"),
      credentials: { type: "array", maxItems: 100, items: ref("PrincipalCredentialSummary") },
      credentials_has_more: { type: "boolean" },
      deleted_at: { type: "null" },
      display_name: string(),
      grants: { type: "array", maxItems: 100, items: ref("PrincipalGrantSummary") },
      grants_has_more: { type: "boolean" },
      id: ref("Uuid"),
      is_owner: { type: "boolean" },
      passkeys: { type: "array", maxItems: 100, items: ref("PrincipalPasskeySummary") },
      passkeys_has_more: { type: "boolean" },
      principal_id: ref("Uuid"),
      updated_at: ref("Timestamp"),
      version: ref("Version"),
    },
    additionalProperties: false,
  },
  PasskeyListResult: {
    type: "object",
    required: ["items", "truncated"],
    properties: { items: { type: "array", maxItems: 100, items: ref("Passkey") }, truncated: { type: "boolean" } },
    additionalProperties: false,
  },
  PasskeyWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("Passkey") },
    additionalProperties: false,
  },
  PasskeyRegistrationOptions: {
    type: "object",
    required: ["challenge_id", "expires_at", "public_key"],
    properties: {
      challenge_id: ref("Uuid"),
      expires_at: ref("Timestamp"),
      public_key: {
        type: "object",
        required: ["attestation", "authenticatorSelection", "challenge", "excludeCredentials", "pubKeyCredParams", "rp", "timeout", "user"],
        properties: {
          attestation: { const: "none" },
          authenticatorSelection: {
            type: "object",
            required: ["requireResidentKey", "residentKey", "userVerification"],
            properties: { requireResidentKey: { const: true }, residentKey: { const: "required" }, userVerification: { const: "required" } },
            additionalProperties: false,
          },
          challenge: ref("WebAuthnChallenge"),
          excludeCredentials: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              required: ["id", "transports", "type"],
              properties: { id: ref("WebAuthnCredentialId"), transports: { type: "array", items: string() }, type: { const: "public-key" } },
              additionalProperties: false,
            },
          },
          pubKeyCredParams: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: { type: "object", required: ["alg", "type"], properties: { alg: integer({ enum: [-7, -257] }), type: { const: "public-key" } }, additionalProperties: false },
          },
          rp: { type: "object", required: ["id", "name"], properties: { id: string(), name: string() }, additionalProperties: false },
          timeout: integer({ const: 300000 }),
          user: { type: "object", required: ["displayName", "id", "name"], properties: { displayName: string(), id: string({ minLength: 48, maxLength: 48, pattern: "^[A-Za-z0-9_-]+$" }), name: string() }, additionalProperties: false },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  PasskeyAuthenticationOptions: {
    type: "object",
    required: ["challenge_id", "expires_at", "public_key"],
    properties: {
      challenge_id: ref("Uuid"),
      expires_at: ref("Timestamp"),
      public_key: {
        type: "object",
        required: ["challenge", "rpId", "timeout", "userVerification"],
        properties: { challenge: ref("WebAuthnChallenge"), rpId: string(), timeout: integer({ const: 300000 }), userVerification: { const: "required" } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  ResumedPublicProject: {
    type: "object",
    required: ["active_usage", "display_name", "id", "public_summary", "resource_limits", "role_choices", "workspace_id", "workspace_display_name"],
    properties: {
      active_usage: containerUsageSchema(),
      display_name: string({ minLength: 1, maxLength: 128 }),
      id: ref("Uuid"),
      public_summary: string({ minLength: 1, maxLength: 512 }),
      resource_limits: containerUsageSchema(),
      role_choices: { type: "array", minItems: 2, maxItems: 2, items: ref("ProjectRole") },
      workspace_id: ref("Uuid"), workspace_display_name: string(),
    },
    additionalProperties: false,
  },
  WorkspaceActive: workspaceSchema({ deleted: false }),
  WorkspaceTombstone: workspaceSchema({ deleted: true }),
  WorkspaceTombstoneDetail: workspaceSchema({ deleted: true, resumed: true }),
  WorkspaceRestored: workspaceSchema({ deleted: false, resumed: true }),
  WorkspaceListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", maxItems: 100, items: { oneOf: [ref("WorkspaceActive"), ref("WorkspaceTombstone")] } },
      next_cursor: nullableString(),
      resolved_scope: {
        type: "object",
        required: ["deleted", "project_ids"],
        properties: {
          deleted: string({ enum: ["exclude", "only"] }),
          project_ids: { type: "array", items: ref("Uuid") },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  WorkspaceActiveWriteResult: containerWriteResult("WorkspaceActive"),
  WorkspaceTombstoneWriteResult: containerWriteResult("WorkspaceTombstone"),
  WorkspaceRestoredWriteResult: containerWriteResult("WorkspaceRestored"),
  ProjectActiveRead: projectSchema({ activeUsage: true, deleted: false }),
  ProjectActiveWrite: projectSchema({ activeUsage: false, deleted: false }),
  ProjectTombstoneRead: projectSchema({ activeUsage: true, deleted: true }),
  ProjectTombstoneWrite: projectSchema({ activeUsage: false, deleted: true }),
  ProjectRestoredWrite: projectSchema({ activeUsage: false, deleted: false, resumed: true }),
  ProjectListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", maxItems: 100, items: { oneOf: [ref("ProjectActiveRead"), ref("ProjectTombstoneRead")] } },
      next_cursor: nullableString(),
      resolved_scope: {
        type: "object",
        required: ["deleted", "workspace_id"],
        properties: {
          deleted: string({ enum: ["exclude", "only"] }),
          workspace_id: ref("Uuid"),
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  ProjectActiveWriteResult: containerWriteResult("ProjectActiveWrite"),
  ProjectTombstoneWriteResult: containerWriteResult("ProjectTombstoneWrite"),
  ProjectRestoredWriteResult: containerWriteResult("ProjectRestoredWrite"),
  ResourceSummary: { type: "object", required: ["id", "version", "created_at", "updated_at", "deleted_at"], properties: { id: ref("Uuid"), version: ref("Version"), created_at: ref("Timestamp"), updated_at: ref("Timestamp"), deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] } }, additionalProperties: true },
  WriteResult: { type: "object", required: ["resource", "event_cursor", "idempotent_replay"], properties: { resource: ref("ResourceSummary"), event_cursor: string(), idempotent_replay: { type: "boolean" } }, additionalProperties: false },
  ListResult: { type: "object", required: ["items", "next_cursor", "has_more"], properties: { items: { type: "array", items: { type: "object", additionalProperties: true } }, next_cursor: nullableString(), has_more: { type: "boolean" }, resolved_scope: { type: "object", additionalProperties: true } }, additionalProperties: false },
  Error: { type: "object", required: ["code", "category", "source", "message", "request_id", "retryable", "recovery", "details"], properties: { code: string({ minLength: 1 }), category: string({ enum: ["authentication", "authorization", "not_found", "validation", "conflict", "business_quota", "rate_limit", "platform_quota", "platform_failure"] }), source: string({ enum: ["service", "cloudflare_platform"] }), message: string(), request_id: ref("Uuid"), retryable: { type: "boolean" }, recovery: string(), details: { type: "object", additionalProperties: true }, retry_after_seconds: integer({ minimum: 0 }) }, additionalProperties: false },
};

const querySets = {
  AssigneeNameQuery: [{ name: "display_name", in: "query", required: true, schema: ref("PrincipalDisplayNameInput") }],
  InviteCodeQuery: [{ name: "code", in: "query", required: true, schema: string({ minLength: 1 }), description: "一次性 Invite code。" }],
  LaunchCodeQuery: [{ name: "code", in: "query", required: true, schema: string({ minLength: 59, maxLength: 59, pattern: "^cfl_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$" }), description: "一次性 Browser Launch code；GET 不消费该 code。" }],
  EventQuery: [
    { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true },
    { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true },
    { name: "after", in: "query", required: false, schema: string(), description: "Opaque Event cursor returned by a write or an earlier Event page." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) },
  ],
  AuditEventQuery: [
    { name: "project_id", in: "query", required: false, schema: ref("Uuid"), description: "Restrict the Owner audit feed to events bound to one immutable Project ID." },
    { name: "stream", in: "query", required: false, schema: string({ enum: ["domain", "security"] }), description: "Restrict the Owner audit feed to one event stream; omission reads both streams." },
    { name: "after", in: "query", required: false, schema: string(), description: "Opaque Owner audit cursor." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) },
  ],
  InvitationListQuery: [{ name: "project_id", in: "query", required: false, schema: ref("Uuid"), description: "Filter to Invitations containing this Project. Every target must still be manageable by the current Principal; partial visibility never reveals an Invitation." }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  CursorQuery: [{ name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  DeletedModeQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }],
  DeletedCursorQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  IssueListQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }, { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "status", in: "query", required: false, schema: { type: "array", maxItems: 5, items: ref("StatusKey") }, style: "form", explode: true }, { name: "assignee", in: "query", required: false, schema: { type: "array", maxItems: 20, items: ref("Uuid") }, style: "form", explode: true }, { name: "q", in: "query", required: false, schema: utf8String(128, { minLength: 1, description: "Normalized title/identifier search." }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  IssueDetailQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }],
  CandidateListQuery: [{ name: "assignment", in: "query", required: true, schema: string({ enum: ["unassigned", "mine", "needs_reassignment"] }) }, { name: "blocked", in: "query", required: false, schema: string({ enum: ["exclude", "include"], default: "exclude" }) }, { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "q", in: "query", required: false, schema: utf8String(128, { minLength: 1, description: "Normalized title/identifier search." }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  PrincipalListQuery: [{ name: "q", in: "query", required: false, schema: string({ maxLength: 128 }) }, { name: "project_id", in: "query", required: false, schema: ref("Uuid") }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  RelationDeleteQuery: [],
};

const operationResponseSchemas = {
  getMe: ref("CurrentPrincipal"),
  listWorkspaceAdministrators: ref("AdministratorListResult"),
  listProjectAdministrators: ref("AdministratorListResult"),
  createWorkspaceAdministrator: ref("AdministratorWriteResult"),
  createProjectAdministrator: ref("AdministratorWriteResult"),
  revokeWorkspaceAdministrator: ref("AdministratorWriteResult"),
  revokeProjectAdministrator: ref("AdministratorWriteResult"),
  listProjectMembers: ref("EffectiveMemberListResult"),
  findProjectAssignee: ref("ProjectAssigneeResult"),
  listAttachments: ref("AttachmentListResult"),
  getAttachment: ref("Attachment"),
  reserveAttachment: ref("AttachmentWriteResult"),
  uploadAttachment: ref("AttachmentWriteResult"),
  deleteAttachment: ref("AttachmentWriteResult"),
  restoreAttachment: ref("AttachmentWriteResult"),
  previewWorkspacePurge: ref("ContainerPurgePreview"),
  previewProjectPurge: ref("ContainerPurgePreview"),
  purgeWorkspace: ref("ContainerPurgeWriteResult"),
  purgeProject: ref("ContainerPurgeWriteResult"),
  listWorkspaces: ref("WorkspaceListResult"),
  getWorkspace: { oneOf: [ref("WorkspaceActive"), ref("WorkspaceTombstoneDetail")] },
  createWorkspace: ref("WorkspaceActiveWriteResult"),
  updateWorkspace: ref("WorkspaceActiveWriteResult"),
  deleteWorkspace: ref("WorkspaceTombstoneWriteResult"),
  restoreWorkspace: ref("WorkspaceRestoredWriteResult"),
  listProjects: ref("ProjectListResult"),
  getProject: { oneOf: [ref("ProjectActiveRead"), ref("ProjectTombstoneRead")] },
  createProject: ref("ProjectActiveWriteResult"),
  updateProject: ref("ProjectActiveWriteResult"),
  deleteProject: ref("ProjectTombstoneWriteResult"),
  restoreProject: ref("ProjectRestoredWriteResult"),
  listPublicProjects: ref("PublicProjectListResult"),
  getPublicJoinPolicy: ref("PublicJoinPolicy"),
  enablePublicJoin: ref("PublicJoinPolicyWriteResult"),
  disablePublicJoin: ref("PublicJoinPolicyWriteResult"),
  getProjectResourceLimits: ref("PublicJoinPolicy"),
  updateProjectResourceLimits: ref("PublicJoinPolicyWriteResult"),
  getAttachmentSettings: ref("AttachmentSettings"),
  updateAttachmentSettings: ref("AttachmentSettingsWriteResult"),
  getUsage: ref("Usage"),
  refreshUsage: ref("Usage"),
  getRateLimitSettings: ref("RateLimitSettings"),
  redeemPublicJoin: ref("PublicJoinRedemptionWriteResult"),
  createWebLaunch: ref("BrowserLaunchWriteResult"),
  redeemWebLaunch: ref("WebSessionExchangeWriteResult"),
  getWebSession: ref("WebSessionView"),
  revokeWebSession: ref("WebSessionRevocationWriteResult"),
  createPasskeyRegistrationOptions: ref("PasskeyRegistrationOptions"),
  listMyPasskeys: ref("PasskeyListResult"),
  registerPasskey: ref("PasskeyWriteResult"),
  revokeMyPasskey: ref("PasskeyWriteResult"),
  revokePrincipalPasskey: ref("PasskeyWriteResult"),
  getPrincipal: ref("PrincipalDetail"),
  createWebAuthenticationOptions: ref("PasskeyAuthenticationOptions"),
  verifyWebAuthentication: ref("WebSessionExchangeWriteResult"),
  redeemInvitation: ref("InvitationRedemptionWriteResult"),
  listInvitations: ref("InvitationListResult"),
  createInvitation: ref("InvitationCreateWriteResult"),
  getInvitation: ref("Invitation"),
  revokeInvitation: ref("InvitationWriteResult"),
  listEvents: ref("EventListResult"),
  listAuditEvents: ref("AuditEventListResult"),
  listIssues: ref("IssueListResult"),
  listIssueCandidates: ref("ActiveIssueListResult"),
  listProjectIssues: ref("IssueListResult"),
  getIssue: { oneOf: [ref("IssueFullDetail"), ref("IssueTombstone")] },
  getIssueContext: ref("IssueContext"),
  createIssue: ref("ActiveIssueWriteResult"),
  updateIssue: ref("ActiveIssueWriteResult"),
  deleteIssue: ref("DeletedIssueWriteResult"),
  restoreIssue: ref("ActiveIssueWriteResult"),
  assignIssueToMe: ref("ActiveIssueWriteResult"),
  reportIssueBlocked: ref("ActiveIssueWriteResult"),
  clearIssueBlocked: ref("ActiveIssueWriteResult"),
  completeIssue: ref("CompletedIssueWriteResult"),
  addIssueLabel: ref("ActiveIssueWriteResult"),
  removeIssueLabel: ref("ActiveIssueWriteResult"),
  listComments: ref("CommentListResult"),
  getComment: ref("Comment"),
  createComment: ref("CommentWriteResult"),
  deleteComment: ref("CommentWriteResult"),
  restoreComment: ref("CommentWriteResult"),
  listLabels: ref("LabelListResult"),
  getLabel: ref("Label"),
  createLabel: ref("LabelWriteResult"),
  updateLabel: ref("LabelWriteResult"),
  deleteLabel: ref("LabelWriteResult"),
  restoreLabel: ref("LabelWriteResult"),
  listIssueRelations: ref("RelationListResult"),
  getRelation: ref("Relation"),
  createIssueRelation: ref("RelationWriteResult"),
  deleteRelation: ref("RelationWriteResult"),
  restoreRelation: ref("RelationWriteResult"),
};

const pathParameter = (name) => ({
  name,
  in: "path",
  required: true,
  schema: name === "identifier"
    ? string({ pattern: "^CFK-[1-9][0-9]*$" })
    : name === "id" || name.endsWith("_id")
      ? ref("Uuid")
      : string({ minLength: 1 }),
});

function buildOperation([method, path, operationId, tag, security, mode, requestOrQuery]) {
  const permission = operationPermissions.get(operationId);
  if (!permission) throw new Error(`Missing permission contract for ${operationId}`);
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => pathParameter(match[1]));
  if (method === "get" && requestOrQuery && querySets[requestOrQuery]) parameters.push(...querySets[requestOrQuery]);
  if (mode.includes("idempotent")) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  if (mode.includes("cas-delete")) parameters.push({ $ref: "#/components/parameters/ExpectedVersion" });
  const allowsCookie = security.some((requirement) => Object.hasOwn(requirement, "WebSession"));
  const allowsBearer = security.some((requirement) => Object.hasOwn(requirement, "BearerCredential"));
  if (method !== "get" && allowsCookie) {
    parameters.push({ $ref: allowsBearer || security.some((requirement) => Object.keys(requirement).length === 0)
      ? "#/components/parameters/ConditionalCsrfToken"
      : "#/components/parameters/CsrfToken" });
  }
  if (requestOrQuery === "RelationDeleteQuery") {
    parameters.push({ name: "source_expected_version", in: "query", required: true, schema: ref("Version") });
    parameters.push({ name: "target_expected_version", in: "query", required: true, schema: ref("Version") });
  }

  const responseSchema = operationResponseSchemas[operationId]
    ?? (method === "get" && operationId.startsWith("list")
      ? ref("ListResult")
      : mode === "read"
        ? { type: "object", additionalProperties: true }
        : ref("WriteResult"));
  const operation = {
    operationId,
    tags: [tag],
    summary: operationId.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase()),
    description: `${permissionDescriptions[permission]} Atomic cfKanban ${mode} operation. Authorization and current resource state are revalidated when the operation executes.`,
    security,
    parameters,
    responses: {
      "200": { description: "Successful response.", headers: { "X-Request-ID": { $ref: "#/components/headers/RequestId" } }, content: { "application/json": { schema: responseSchema } } },
      "400": { $ref: "#/components/responses/BadRequest" },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
      "404": { $ref: "#/components/responses/NotFound" },
      "409": { $ref: "#/components/responses/Conflict" },
      "429": { $ref: "#/components/responses/RateLimited" },
      "503": { $ref: "#/components/responses/PlatformUnavailable" },
    },
    "x-cfkanban-write-contract": mode,
    "x-cfkanban-permission": permission,
  };

  if (method !== "get" && method !== "delete") {
    const schemaName = requestOrQuery ?? "EmptyRequest";
    operation.requestBody = { required: true, content: { "application/json": { schema: ref(schemaName) } } };
    operation.responses["413"] = { $ref: "#/components/responses/PayloadTooLarge" };
  }
  if (operationId === "uploadAttachment") {
    operation.requestBody = { required: true, content: { "application/octet-stream": { schema: ref("AttachmentBytes") } } };
    operation.description += " Only the reservation creator or Deployment Owner may upload. The reservation fixes the byte length and SHA-256. R2 and D1 are separate stages; retry with the same attachment and Idempotency-Key.";
  }
  if (operationId === "downloadAttachment") {
    operation.parameters.push({ name: "preview", in: "query", required: false, schema: { type: "string", enum: ["1"] }, description: "Inline only when a PNG, JPEG, GIF, or WebP file header was verified." });
    operation.responses["200"].content = Object.fromEntries(["application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp"].map((type) => [type, { schema: ref("AttachmentBytes") }]));
    Object.assign(operation.responses["200"].headers, {
      "Cache-Control": { required: true, schema: { type: "string", const: "private, no-store" } },
      "X-Content-Type-Options": { required: true, schema: { type: "string", const: "nosniff" } },
      "Content-Disposition": { required: true, schema: string(), description: "Defaults to attachment; explicit verified image preview uses inline." },
    });
  }
  return operation;
}

const paths = {};
for (const operation of operations) {
  const [method, path] = operation;
  paths[path] ??= {};
  paths[path][method] = buildOperation(operation);
}

const requestIdHeader = { "X-Request-ID": { $ref: "#/components/headers/RequestId" } };
const noStoreHeader = { ...requestIdHeader, "Cache-Control": { required: true, schema: { type: "string", const: "no-store" } } };
paths["/api/v1/admin/attachment-settings"].get.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/attachment-settings"].patch.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/attachment-settings"].patch.description = "Owner-only explicit capacity choice: positive safe integer bytes or null for unlimited. Requires expected_version and Idempotency-Key; Cookie requests require CSRF. Lowering the limit preserves files and existing reservations. New reservations require configured=true and available capacity. An unset limit is not implicit unlimited capacity.";
paths["/api/v1/admin/usage"].get.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/usage/refresh"].post.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/usage/refresh"].post.description = "Owner-only derived-cache refresh; Cookie requests require CSRF. No business mutation, domain event, or Idempotency-Key is required. Both modes reuse snapshots younger than 15 minutes; manual does not bypass the shared Web/Skill cache. All attempts share a 60-second cooldown. Concurrent or cooling-down requests return the existing projection. Cloudflare failures are represented in cloudflare.status/error with the last successful snapshot retained.";
paths["/healthz"].get.responses["200"] = { description: "Bounded health projection.", headers: requestIdHeader, content: { "application/json": { schema: ref("Health") } } };
paths["/.well-known/cfkanban-instance.json"].get.responses["200"] = { description: "Dynamic non-secret discovery document for the request origin.", headers: noStoreHeader, content: { "application/json": { schema: ref("InstanceDiscovery") } } };
paths["/invite"].get.responses["200"] = { description: "Human- and Agent-readable invitation bootstrap document. GET has no redemption side effect.", headers: { ...noStoreHeader, "Referrer-Policy": { required: true, schema: { type: "string", const: "no-referrer" } } }, content: { "text/html": { schema: string() } } };
paths["/invite"].get.responses["410"] = { $ref: "#/components/responses/Gone" };
paths["/app/launch"].get.responses["200"] = { description: "Same-origin launch page. GET has no redemption side effect.", headers: { ...noStoreHeader, "Referrer-Policy": { required: true, schema: { type: "string", const: "no-referrer" } } }, content: { "text/html": { schema: string() } } };
paths["/app/launch"].get.responses["410"] = { $ref: "#/components/responses/Gone" };
paths["/api/v1/invitations/redeem"].post.responses["410"] = { $ref: "#/components/responses/Gone" };
paths["/api/v1/web-sessions/redeem"].post.responses["410"] = { $ref: "#/components/responses/Gone" };
for (const [path, method] of [
  ["/api/v1/web-sessions/redeem", "post"],
  ["/api/v1/web-authentication/verify", "post"],
]) {
  paths[path][method].responses["200"].headers = {
    "Set-Cookie": { required: false, schema: string(), description: "Present only on the secret-bearing first response; sets the HttpOnly Web Session cookie and a separate readable CSRF cookie. Secrets never appear in the response body." },
    ...noStoreHeader,
  };
}
paths["/api/v1/web-session"].delete.responses["200"].headers = {
  "Set-Cookie": { required: true, schema: string(), description: "Expires the current Session and CSRF cookies." },
  ...noStoreHeader,
};
for (const [path, method] of [
  ["/api/v1/web-launches", "post"],
  ["/api/v1/web-session", "get"],
  ["/api/v1/me/passkeys/registration-options", "post"],
  ["/api/v1/me/passkeys", "get"],
  ["/api/v1/me/passkeys", "post"],
  ["/api/v1/me/passkeys/{passkey_id}", "delete"],
  ["/api/v1/admin/passkeys/{passkey_id}", "delete"],
  ["/api/v1/web-authentication/options", "post"],
]) {
  paths[path][method].responses["200"].headers = noStoreHeader;
}
paths["/api/v1/me/passkeys/{passkey_id}"].delete.responses["200"].headers = {
  "Set-Cookie": { required: false, schema: string(), description: "Expires the current Session and CSRF cookies when the revoked Passkey is this Session's source." },
  ...noStoreHeader,
};

const errorResponse = (description, includeRetryAfter = false) => ({
  description,
  headers: {
    "X-Request-ID": { $ref: "#/components/headers/RequestId" },
    ...(includeRetryAfter ? { "Retry-After": { schema: { type: "integer", minimum: 0 }, description: "Seconds before a safe retry." } } : {}),
  },
  content: { "application/json": { schema: ref("Error") } },
});

const document = {
  openapi: "3.1.0",
  info: {
    title: "cfKanban API",
    version: "0.1.0",
    description: "Frozen v0.1 Agent-first atomic Kanban contract. Generated from the repository contract source; implementation completion is tracked separately.",
    license: { name: "UNLICENSED" },
  },
  servers: [{ url: "/", description: "Current cfKanban instance origin" }],
  tags: tags.map((name) => ({ name, description: tagDescriptions[name] })),
  paths,
  components: {
    securitySchemes: {
      BearerCredential: { type: "http", scheme: "bearer", bearerFormat: "cfk_v1 opaque credential", description: "Long-lived Principal credential used by Agents. Never place it in a URL." },
      WebSession: { type: "apiKey", in: "cookie", name: "cfkanban_session", description: "Fixed eight-hour HttpOnly same-origin Web Session." },
    },
    parameters: {
      IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true, schema: string({ minLength: 1, maxLength: 128, pattern: "^[\\x20-\\x7E]+$" }) },
      CsrfToken: { name: "X-CSRF-Token", in: "header", required: true, schema: string({ minLength: 1 }), description: "Must equal the readable same-origin CSRF cookie for Cookie-authenticated writes." },
      ConditionalCsrfToken: { name: "X-CSRF-Token", in: "header", required: false, schema: string({ minLength: 1 }), description: "Required when this operation uses WebSession cookie authentication; omitted for Bearer or unauthenticated branches." },
      ExpectedVersion: { name: "expected_version", in: "query", required: true, schema: ref("Version"), description: "CAS precondition for DELETE operations. For Public Join disable, use policy.project.version from the GET response; policy_version is not this CAS value." },
    },
    headers: {
      RequestId: { required: true, schema: ref("Uuid"), description: "Non-secret request correlation ID; equals error body request_id when an error body exists." },
    },
    responses: {
      BadRequest: errorResponse("Validation or malformed request."),
      Unauthorized: errorResponse("Authentication failed without disclosing credential existence."),
      Forbidden: errorResponse("Authenticated but not authorized."),
      NotFound: errorResponse("Resource is absent, deleted, or hidden by authorization."),
      Conflict: errorResponse("Version, transition, uniqueness, or business quota conflict."),
      Gone: errorResponse("A short-lived capability expired, was revoked, or was already consumed."),
      PayloadTooLarge: errorResponse("JSON request exceeds 128 KiB, or attachment bytes exceed the fixed reservation or 10 MiB application limit."),
      RateLimited: errorResponse("Application rate limit reached.", true),
      PlatformUnavailable: errorResponse("Cloudflare platform quota or availability failure.", true),
    },
    schemas,
  },
};

const mode = parseGeneratedMode(process.argv.slice(2));
await syncGeneratedFile(
  new URL("../contracts/openapi.json", import.meta.url),
  renderGeneratedJson(document),
  { mode, regenerateCommand: "npm run contracts:generate" },
);
console.log(`${mode === "check" ? "Verified" : "Generated"} contracts/openapi.json with ${operations.length} operations.`);
