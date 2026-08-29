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
  comments: "Chronological standard and immutable completion comments.",
  labels: "Project-scoped labels and single-Issue associations.",
  relations: "Same-Workspace Issue relations, including cross-Project relations.",
  invitations: "Short-lived one-time Project and Principal recovery invitations.",
  "public-join": "Owner-controlled single-Project public enrollment and limits.",
  web: "Browser Launch, fixed Web Sessions, and Passkey authentication.",
  admin: "Deployment Owner application-level maintenance capabilities.",
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
  ["patch", "/api/v1/me", "updateMe", "identity", authenticated, "cas", "UpdateDisplayNameRequest"],
  ["get", "/api/v1/events", "listEvents", "events", authenticated, "read", "EventQuery"],

  ["get", "/api/v1/workspaces", "listWorkspaces", "workspaces", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/workspaces", "createWorkspace", "workspaces", bearer, "idempotent", "CreateWorkspaceRequest"],
  ["get", "/api/v1/workspaces/{workspace_key}", "getWorkspace", "workspaces", authenticated, "read"],
  ["patch", "/api/v1/workspaces/{workspace_key}", "updateWorkspace", "workspaces", authenticated, "cas", "UpdateDisplayNameRequest"],
  ["delete", "/api/v1/workspaces/{workspace_key}", "deleteWorkspace", "workspaces", authenticated, "cas-delete"],
  ["post", "/api/v1/workspaces/{workspace_key}/commands/restore", "restoreWorkspace", "workspaces", authenticated, "idempotent-cas", "ExpectedVersionRequest"],

  ["get", "/api/v1/workspaces/{workspace_key}/projects", "listProjects", "projects", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_key}/projects", "createProject", "projects", bearer, "idempotent", "CreateProjectRequest"],
  ["get", "/api/v1/workspaces/{workspace_key}/projects/{project_key}", "getProject", "projects", authenticated, "read"],
  ["patch", "/api/v1/workspaces/{workspace_key}/projects/{project_key}", "updateProject", "projects", authenticated, "cas", "UpdateProjectRequest"],
  ["delete", "/api/v1/workspaces/{workspace_key}/projects/{project_key}", "deleteProject", "projects", authenticated, "cas-delete"],
  ["post", "/api/v1/workspaces/{workspace_key}/projects/{project_key}/commands/restore", "restoreProject", "projects", authenticated, "idempotent-cas", "ExpectedVersionRequest"],
  ["get", "/api/v1/workspaces/{workspace_key}/projects/{project_key}/statuses", "listProjectStatuses", "projects", authenticated, "read"],
  ["patch", "/api/v1/workspaces/{workspace_key}/projects/{project_key}/statuses/{status_key}", "updateProjectStatusName", "projects", authenticated, "cas", "UpdateStatusNameRequest"],

  ["get", "/api/v1/issues", "listIssues", "issues", authenticated, "read", "IssueListQuery"],
  ["get", "/api/v1/issues/candidates", "listIssueCandidates", "issues", authenticated, "read", "CandidateListQuery"],
  ["get", "/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues", "listProjectIssues", "issues", authenticated, "read", "IssueListQuery"],
  ["post", "/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues", "createIssue", "issues", authenticated, "idempotent", "CreateIssueRequest"],
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

  ["get", "/api/v1/issues/{identifier}/comments", "listComments", "comments", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/issues/{identifier}/comments", "createComment", "comments", authenticated, "idempotent", "CreateCommentRequest"],
  ["get", "/api/v1/comments/{comment_id}", "getComment", "comments", authenticated, "read", "IssueDetailQuery"],
  ["delete", "/api/v1/comments/{comment_id}", "deleteComment", "comments", authenticated, "cas-delete"],
  ["post", "/api/v1/comments/{comment_id}/commands/restore", "restoreComment", "comments", authenticated, "idempotent-cas", "ExpectedVersionRequest"],

  ["get", "/api/v1/workspaces/{workspace_key}/projects/{project_key}/labels", "listLabels", "labels", authenticated, "read", "DeletedCursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_key}/projects/{project_key}/labels", "createLabel", "labels", authenticated, "idempotent", "CreateLabelRequest"],
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
  ["get", "/api/v1/admin/invitations", "listInvitations", "invitations", authenticated, "read", "CursorQuery"],
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
  ["post", "/api/v1/me/passkeys/registration-options", "createPasskeyRegistrationOptions", "web", cookie, "csrf-idempotent", "EmptyRequest"],
  ["get", "/api/v1/me/passkeys", "listMyPasskeys", "web", cookie, "read"],
  ["post", "/api/v1/me/passkeys", "registerPasskey", "web", cookie, "csrf-idempotent", "RegisterPasskeyRequest"],
  ["delete", "/api/v1/me/passkeys/{passkey_id}", "revokeMyPasskey", "web", cookie, "csrf-cas-delete"],
  ["delete", "/api/v1/admin/passkeys/{passkey_id}", "revokePrincipalPasskey", "admin", authenticated, "csrf-cas-delete"],
  ["post", "/api/v1/web-authentication/options", "createWebAuthenticationOptions", "web", publicAccess, "idempotent", "EmptyRequest"],
  ["post", "/api/v1/web-authentication/verify", "verifyWebAuthentication", "web", publicAccess, "idempotent", "VerifyWebAuthenticationRequest"],
  ["get", "/api/v1/public-projects", "listPublicProjects", "public-join", publicAccess, "read", "CursorQuery"],
  ["get", "/api/v1/admin/projects/{project_id}/public-join", "getPublicJoinPolicy", "public-join", authenticated, "read"],
  ["put", "/api/v1/admin/projects/{project_id}/public-join", "enablePublicJoin", "public-join", authenticated, "idempotent-cas", "EnablePublicJoinRequest"],
  ["delete", "/api/v1/admin/projects/{project_id}/public-join", "disablePublicJoin", "public-join", authenticated, "cas-delete"],
  ["get", "/api/v1/admin/projects/{project_id}/resource-limits", "getProjectResourceLimits", "public-join", authenticated, "read"],
  ["patch", "/api/v1/admin/projects/{project_id}/resource-limits", "updateProjectResourceLimits", "public-join", authenticated, "cas", "UpdateResourceLimitsRequest"],
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
    required: ["display_name", "id", "key"],
    properties: { display_name: string(), id: ref("Uuid"), key: string() },
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
    required: ["display_name", "key"],
    properties: { display_name: string(), key: string() },
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
  current_principal: "The currently authenticated Principal acting only on its own identity or Web authentication state.",
  deployment_owner: "The single Deployment Owner. Project Grants never satisfy this permission.",
  project_reader: "Deployment Owner or an active reader/writer Grant for the resource Project.",
  project_reader_active_writer_tombstone: "Active resources require a current reader/writer Grant for the resource Project (or Deployment Owner). The explicit deleted=only recovery view requires writer and remains available under paused parents only to the Deployment Owner.",
  project_writer: "Deployment Owner or an active writer Grant for the resource Project.",
  relation_endpoints_reader: "Deployment Owner or active reader/writer Grants for both Relation endpoint Projects. List operations use the path Issue Project for scope and omit Relations whose other endpoint is not currently readable.",
  relation_endpoints_reader_active_writer_tombstone: "Active Relations require current reader/writer access to both Relation endpoint Projects. The explicit deleted=only recovery view requires writer access to both endpoints and remains available under paused parents only to the Deployment Owner.",
  relation_endpoints_writer: "Deployment Owner or active writer Grants for both Relation endpoint Projects.",
  credential_principal: "Any Principal authenticated with a current Bearer Credential; Cookie Session is intentionally insufficient.",
  agent_launch_session: "A current Cookie Session whose source is an active Bearer Credential Browser Launch.",
  invitation_capability: "A valid one-time Invitation capability, with conditional current-Credential authentication required by redeem_as.",
  browser_launch_capability: "A valid one-time Browser Launch capability.",
  webauthn_capability: "A valid single-use WebAuthn challenge and assertion ceremony.",
  public_join_capability: "An enabled single-Project Public Join policy, with conditional authentication required by redeem_as.",
};

const permissionGroups = {
  public: ["getHealth", "getOpenApi", "discoverInstance", "getInvitationBootstrap", "getWebLaunchPage", "listPublicProjects"],
  authenticated_principal: ["getMeta", "listEvents"],
  visible_scope: ["listWorkspaces", "getWorkspace", "listProjects", "getProject"],
  current_principal: ["getMe", "updateMe", "getWebSession", "revokeWebSession", "listMyPasskeys", "revokeMyPasskey"],
  deployment_owner: [
    "createWorkspace", "updateWorkspace", "deleteWorkspace", "restoreWorkspace",
    "createProject", "updateProject", "deleteProject", "restoreProject", "updateProjectStatusName",
    "listInvitations", "createInvitation", "getInvitation", "revokeInvitation",
    "listPrincipals", "getPrincipal", "listPrincipalCredentials", "revokeCredential", "rotateOwnerCredential",
    "getInstanceOrigin", "updateInstanceOrigin", "listProjectGrants", "createProjectGrant", "getProjectGrant",
    "updateProjectGrant", "revokeProjectGrant", "listAuditEvents", "revokePrincipalPasskey",
    "getPublicJoinPolicy", "enablePublicJoin", "disablePublicJoin", "getProjectResourceLimits",
    "updateProjectResourceLimits", "getRateLimitSettings",
  ],
  project_reader: [
    "listProjectStatuses", "listIssues", "listIssueCandidates", "listProjectIssues", "getIssue", "getIssueContext",
  ],
  project_reader_active_writer_tombstone: ["listComments", "getComment", "listLabels", "getLabel"],
  project_writer: [
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
  webauthn_capability: ["createWebAuthenticationOptions", "verifyWebAuthentication"],
  public_join_capability: ["redeemPublicJoin"],
};

const operationPermissions = new Map();
for (const [permission, operationIds] of Object.entries(permissionGroups)) {
  for (const operationId of operationIds) operationPermissions.set(operationId, permission);
}

const schemas = {
  Uuid: string({ format: "uuid" }),
  Timestamp: string({ format: "date-time" }),
  Version: integer({ minimum: 1 }),
  StatusKey: string({ enum: ["backlog", "todo", "in_progress", "done", "canceled"], description: "稳定状态：待整理、待办、进行中、完成、取消。" }),
  NonDoneStatusKey: string({ enum: ["backlog", "todo", "in_progress", "canceled"], description: "普通创建或 PATCH 可使用的状态；进入 done 必须调用 complete 命令。" }),
  PriorityKey: string({ enum: ["urgent", "high", "medium", "low", "none"], description: "稳定优先级：紧急、高、中、低、无。" }),
  ProjectRole: string({ enum: ["reader", "writer"], description: "项目角色：只读或可写。" }),
  RelationKind: string({ enum: ["blocks", "parent", "related", "duplicate"] }),
  EmptyRequest: { type: "object", additionalProperties: false },
  ExpectedVersionRequest: { type: "object", required: ["expected_version"], properties: { expected_version: ref("Version") }, additionalProperties: false },
  UpdateDisplayNameRequest: { type: "object", required: ["expected_version", "display_name"], properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateWorkspaceRequest: { type: "object", required: ["key", "display_name"], properties: { key: string({ pattern: "^[a-z][a-z0-9-]{1,31}$" }), display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateProjectRequest: { type: "object", required: ["key", "display_name"], properties: { key: string({ pattern: "^[A-Z][A-Z0-9-]{1,15}$" }), display_name: string({ minLength: 1, maxLength: 128 }), context: nullableUtf8String(32768, { description: "Untrusted bounded Project context." }) }, additionalProperties: false },
  UpdateProjectRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }), context: nullableUtf8String(32768, { description: "Untrusted bounded Project context." }) }, additionalProperties: false },
  UpdateStatusNameRequest: { type: "object", required: ["expected_version", "display_name"], properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateIssueRequest: { type: "object", required: ["title"], properties: { title: string({ minLength: 1, maxLength: 256 }), body: utf8String(65536, { default: "", description: "Untrusted Markdown source." }), status_key: { ...ref("NonDoneStatusKey"), default: "backlog" }, priority_key: { ...ref("PriorityKey"), default: "none" }, assignee_principal_id: { anyOf: [ref("Uuid"), { type: "null" }], default: null }, label_ids: { type: "array", items: ref("Uuid"), maxItems: 20, uniqueItems: true, default: [] } }, additionalProperties: false },
  UpdateIssueRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), title: string({ minLength: 1, maxLength: 256 }), body: utf8String(65536, { description: "Untrusted Markdown source." }), status_key: ref("NonDoneStatusKey"), priority_key: ref("PriorityKey"), assignee_principal_id: { anyOf: [ref("Uuid"), { type: "null" }] } }, additionalProperties: false },
  ReportBlockedRequest: { type: "object", required: ["expected_version", "reason"], properties: { expected_version: ref("Version"), reason: string({ minLength: 1, maxLength: 4096 }) }, additionalProperties: false },
  CompleteIssueRequest: { type: "object", required: ["expected_version", "summary"], properties: { expected_version: ref("Version"), summary: string({ minLength: 1, maxLength: 8192 }), verification: { type: "array", items: string({ minLength: 1, maxLength: 1024 }), maxItems: 50, default: [] }, artifacts: { type: "array", items: { type: "object", required: ["kind", "value"], properties: { kind: string({ enum: ["url", "path", "commit", "other"] }), value: string({ minLength: 1, maxLength: 2048 }) }, additionalProperties: false }, maxItems: 50, default: [] }, follow_ups: { type: "array", items: string({ minLength: 1, maxLength: 2048 }), maxItems: 50, default: [] } }, additionalProperties: false, "x-cfkanban-max-utf8-bytes": 32768 },
  IssueLabelRequest: { type: "object", required: ["expected_version", "label_id"], properties: { expected_version: ref("Version"), label_id: ref("Uuid") }, additionalProperties: false },
  CreateCommentRequest: { type: "object", required: ["body"], properties: { body: utf8String(32768, { minLength: 1, description: "Append-only untrusted Comment body." }), reply_to_comment_id: { anyOf: [ref("Uuid"), { type: "null" }], default: null } }, additionalProperties: false },
  CreateLabelRequest: { type: "object", required: ["name"], properties: { name: string({ minLength: 1, maxLength: 64 }), color: nullableString({ pattern: "^#[0-9A-Fa-f]{6}$" }) }, additionalProperties: false },
  UpdateLabelRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), name: string({ minLength: 1, maxLength: 64 }), color: nullableString({ pattern: "^#[0-9A-Fa-f]{6}$" }) }, additionalProperties: false },
  CreateRelationRequest: { type: "object", required: ["kind", "target_identifier", "source_expected_version", "target_expected_version"], properties: { kind: ref("RelationKind"), target_identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }), source_expected_version: ref("Version"), target_expected_version: ref("Version") }, additionalProperties: false },
  RelationVersionsRequest: { type: "object", required: ["expected_version", "source_expected_version", "target_expected_version"], properties: { expected_version: ref("Version"), source_expected_version: ref("Version"), target_expected_version: ref("Version") }, additionalProperties: false },
  RedeemInvitationRequest: {
    oneOf: [
      { type: "object", required: ["invite_code", "redeem_as", "display_name", "new_credential_token"], properties: { invite_code: string({ minLength: 1, maxLength: 1024, writeOnly: true }), redeem_as: { const: "new_principal" }, display_name: string({ minLength: 1, maxLength: 128 }), new_credential_token: credentialToken() }, additionalProperties: false },
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
  CreateGrantRequest: { type: "object", required: ["principal_id", "role"], properties: { principal_id: ref("Uuid"), role: ref("ProjectRole") }, additionalProperties: false },
  UpdateGrantRequest: { type: "object", required: ["expected_version", "role"], properties: { expected_version: ref("Version"), role: ref("ProjectRole") }, additionalProperties: false },
  CreateWebLaunchRequest: { type: "object", required: ["target"], properties: { target: { oneOf: [{ type: "object", required: ["kind", "workspace_key", "project_key"], properties: { kind: { const: "project" }, workspace_key: string(), project_key: string() }, additionalProperties: false }, { type: "object", required: ["kind", "identifier"], properties: { kind: { const: "issue" }, identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }) }, additionalProperties: false }, { type: "object", required: ["kind", "section"], properties: { kind: { const: "admin" }, section: string({ enum: ["overview", "workspaces-projects", "access", "audit"] }) }, additionalProperties: false }] } }, additionalProperties: false },
  RedeemWebLaunchRequest: { type: "object", required: ["launch_code"], properties: { launch_code: string({ minLength: 1, writeOnly: true }) }, additionalProperties: false },
  RegisterPasskeyRequest: { type: "object", required: ["challenge_id", "credential"], properties: { challenge_id: ref("Uuid"), credential: { type: "object", additionalProperties: true } }, additionalProperties: false },
  VerifyWebAuthenticationRequest: { type: "object", required: ["challenge_id", "credential"], properties: { challenge_id: ref("Uuid"), credential: { type: "object", additionalProperties: true } }, additionalProperties: false },
  EnablePublicJoinRequest: { type: "object", required: ["expected_version", "public_summary", "issue_limit", "comment_limit", "principal_limit"], properties: { expected_version: ref("Version"), public_summary: string({ minLength: 1, maxLength: 512 }), issue_limit: integer({ minimum: 1 }), comment_limit: integer({ minimum: 1 }), principal_limit: integer({ minimum: 1 }) }, additionalProperties: false },
  UpdateResourceLimitsRequest: { type: "object", required: ["expected_version", "issue_limit", "comment_limit", "principal_limit"], properties: { expected_version: ref("Version"), issue_limit: integer({ minimum: 1 }), comment_limit: integer({ minimum: 1 }), principal_limit: integer({ minimum: 1 }) }, additionalProperties: false },
  RedeemPublicJoinRequest: { type: "object", required: ["role", "redeem_as"], properties: { role: ref("ProjectRole"), redeem_as: string({ enum: ["new_principal", "current_principal"] }), display_name: string({ minLength: 1, maxLength: 128 }), new_credential_token: credentialToken() }, additionalProperties: false },
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
          required: ["project_id", "project_key", "workspace_key"],
          properties: { project_id: ref("Uuid"), project_key: string(), workspace_key: string() },
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
        required: ["id", "key", "workspace_key"],
        properties: { id: ref("Uuid"), key: string(), workspace_key: string() },
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
      summary: string({ minLength: 1 }),
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
      body: string({ minLength: 1 }),
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
        required: ["id", "key", "workspace_key"],
        properties: { id: ref("Uuid"), key: string(), workspace_key: string() },
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
        required: ["project_id", "project_key", "workspace_key"],
        properties: { project_id: ref("Uuid"), project_key: string(), workspace_key: string() },
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
        required: ["id", "key", "workspace_key"],
        properties: { id: ref("Uuid"), key: string(), workspace_key: string() },
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
        required: ["id", "key"],
        properties: { id: ref("Uuid"), key: string() },
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
    required: ["display_name", "project_id", "project_key", "role", "workspace_key"],
    properties: {
      display_name: string(),
      project_id: ref("Uuid"),
      project_key: string(),
      role: ref("ProjectRole"),
      workspace_key: string(),
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
        type: "object",
        required: ["owner_principal_id"],
        properties: { owner_principal_id: ref("Uuid") },
        additionalProperties: false,
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
    required: ["actor", "authorized_via", "created_at", "event_index", "grant_id", "id", "operation_id", "payload", "project", "subject", "type", "workspace"],
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
      authorized_via: string({ enum: ["deployment_owner", "project_grant", "public_join", "invitation", "web_session", "deployment_recovery"] }),
      created_at: ref("Timestamp"),
      event_index: integer({ minimum: 0 }),
      grant_id: { anyOf: [ref("Uuid"), { type: "null" }] },
      id: ref("Uuid"),
      operation_id: ref("Uuid"),
      payload: {},
      project: {
        anyOf: [
          { type: "object", required: ["display_name", "id", "key"], properties: { display_name: string(), id: ref("Uuid"), key: string() }, additionalProperties: false },
          { type: "null" },
        ],
      },
      stream: string({ enum: ["domain", "security"] }),
      subject: {
        type: "object",
        required: ["id", "type"],
        properties: { id: string(), type: string() },
        additionalProperties: false,
      },
      type: string(),
      workspace: {
        anyOf: [
          { type: "object", required: ["display_name", "id", "key"], properties: { display_name: string(), id: ref("Uuid"), key: string() }, additionalProperties: false },
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
          required: ["project_id", "project_key", "workspace_key"],
          properties: { project_id: ref("Uuid"), project_key: string(), workspace_key: string() },
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
  AuditEventListResult: {
    type: "object",
    required: ["has_more", "items", "next_cursor"],
    properties: {
      has_more: { type: "boolean" },
      items: { type: "array", items: ref("AuditEvent") },
      next_cursor: string(),
    },
    additionalProperties: false,
  },
  ResourceSummary: { type: "object", required: ["id", "version", "created_at", "updated_at", "deleted_at"], properties: { id: ref("Uuid"), version: ref("Version"), created_at: ref("Timestamp"), updated_at: ref("Timestamp"), deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] } }, additionalProperties: true },
  WriteResult: { type: "object", required: ["resource", "event_cursor", "idempotent_replay"], properties: { resource: ref("ResourceSummary"), event_cursor: string(), idempotent_replay: { type: "boolean" } }, additionalProperties: false },
  ListResult: { type: "object", required: ["items", "next_cursor", "has_more"], properties: { items: { type: "array", items: { type: "object", additionalProperties: true } }, next_cursor: nullableString(), has_more: { type: "boolean" }, resolved_scope: { type: "object", additionalProperties: true } }, additionalProperties: false },
  Error: { type: "object", required: ["code", "category", "source", "message", "request_id", "retryable", "recovery", "details"], properties: { code: string({ minLength: 1 }), category: string({ enum: ["authentication", "authorization", "not_found", "validation", "conflict", "business_quota", "rate_limit", "platform_quota", "platform_failure"] }), source: string({ enum: ["service", "cloudflare_platform"] }), message: string(), request_id: ref("Uuid"), retryable: { type: "boolean" }, recovery: string(), details: { type: "object", additionalProperties: true }, retry_after_seconds: integer({ minimum: 0 }) }, additionalProperties: false },
};

const querySets = {
  InviteCodeQuery: [{ name: "code", in: "query", required: true, schema: string({ minLength: 1 }), description: "一次性 Invite code。" }],
  LaunchCodeQuery: [{ name: "code", in: "query", required: true, schema: string({ minLength: 1 }), description: "一次性 Browser Launch code；GET 不消费该 code。" }],
  EventQuery: [
    { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true },
    { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true },
    { name: "after", in: "query", required: false, schema: string(), description: "Opaque Event cursor returned by a write or an earlier Event page." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) },
  ],
  AuditEventQuery: [
    { name: "after", in: "query", required: false, schema: string(), description: "Opaque Owner audit cursor." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) },
  ],
  CursorQuery: [{ name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  DeletedCursorQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  IssueListQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }, { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "status", in: "query", required: false, schema: { type: "array", maxItems: 5, items: ref("StatusKey") }, style: "form", explode: true }, { name: "assignee", in: "query", required: false, schema: { type: "array", maxItems: 20, items: ref("Uuid") }, style: "form", explode: true }, { name: "q", in: "query", required: false, schema: utf8String(128, { minLength: 1, description: "Normalized title/identifier search." }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  IssueDetailQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }],
  CandidateListQuery: [{ name: "assignment", in: "query", required: true, schema: string({ enum: ["unassigned", "mine", "needs_reassignment"] }) }, { name: "blocked", in: "query", required: false, schema: string({ enum: ["exclude", "include"], default: "exclude" }) }, { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "q", in: "query", required: false, schema: utf8String(128, { minLength: 1, description: "Normalized title/identifier search." }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  PrincipalListQuery: [{ name: "q", in: "query", required: false, schema: string({ maxLength: 128 }) }, { name: "project_id", in: "query", required: false, schema: ref("Uuid") }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  RelationDeleteQuery: [],
};

const operationResponseSchemas = {
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
    : name.endsWith("_id")
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
    "Set-Cookie": { required: true, schema: string(), description: "Sets the HttpOnly Web Session cookie and a separate readable CSRF cookie. Secrets never appear in the response body." },
    ...noStoreHeader,
  };
}
paths["/api/v1/web-session"].delete.responses["200"].headers = {
  "Set-Cookie": { required: true, schema: string(), description: "Expires the current Session and CSRF cookies." },
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
      ExpectedVersion: { name: "expected_version", in: "query", required: true, schema: ref("Version"), description: "CAS precondition for DELETE operations." },
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
      PayloadTooLarge: errorResponse("JSON request exceeds the 128 KiB application limit."),
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
