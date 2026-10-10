import { fileURLToPath } from "node:url";
import serviceApi from "../contracts/service-api.json" with { type: "json" };
import { readReleaseVersion } from "./lib/release-version.mjs";
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
  "milestones",
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
  milestones: "Optional Project delivery milestones and single-Issue membership.",
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
const optionalAuthenticated = [{}, ...authenticated];

const operations = [
  ["get", "/healthz", "getHealth", "meta", publicAccess, "read"],
  ["get", "/openapi.json", "getOpenApi", "meta", publicAccess, "read"],
  ["get", "/.well-known/cfkanban-instance.json", "discoverInstance", "meta", publicAccess, "read"],
  ["get", "/invite", "getInvitationBootstrap", "invitations", publicAccess, "read", "InviteCodeQuery"],
  ["get", "/app/launch", "getWebLaunchPage", "web", publicAccess, "read", "LaunchCodeQuery"],
  ["get", "/api/v1/meta", "getMeta", "meta", authenticated, "read"],
  ["get", "/api/v1/me", "getMe", "identity", authenticated, "read"],
  ["patch", "/api/v1/me", "updateMe", "identity", authenticated, "idempotent-cas", "UpdatePrincipalDisplayNameRequest"],
  ["get", "/api/v1/me/notification-preferences", "getNotificationPreferences", "identity", authenticated, "read"],
  ["patch", "/api/v1/me/notification-preferences", "updateNotificationPreferences", "identity", authenticated, "idempotent-cas", "UpdateNotificationPreferencesRequest"],
  ["get", "/api/v1/me/notifications", "listMyNotifications", "identity", authenticated, "read", "PersonalNotificationQuery"],
  ["post", "/api/v1/me/notifications/{notification_id}/commands/acknowledge", "acknowledgeNotification", "identity", authenticated, "idempotent", "EmptyRequest"],
  ["get", "/api/v1/admin/notifications", "listInstanceNotifications", "admin", authenticated, "read", "NotificationCursorQuery"],
  ["post", "/api/v1/admin/notifications", "publishNotification", "admin", authenticated, "idempotent", "PublishNotificationRequest"],
  ["post", "/api/v1/admin/notifications/{notification_id}/commands/withdraw", "withdrawNotification", "admin", authenticated, "idempotent-cas", "ExpectedVersionRequest"],
  ["get", "/api/v1/admin/upgrade-notification-settings", "getUpgradeNotificationSettings", "admin", authenticated, "read"],
  ["patch", "/api/v1/admin/upgrade-notification-settings", "updateUpgradeNotificationSettings", "admin", authenticated, "idempotent-cas", "UpdateUpgradeNotificationSettingsRequest"],
  ["post", "/api/v1/admin/notifications/commands/publish-upgrade", "publishUpgradeNotification", "admin", authenticated, "idempotent", "PublishUpgradeNotificationRequest"],
  ["get", "/api/v1/admin/notifications/upgrade-releases/{release_version}", "getUpgradeNotificationRelease", "admin", authenticated, "read"],
  ["get", "/api/v1/events", "listEvents", "events", authenticated, "read", "EventQuery"],
  ["get", "/api/v1/search-index/status", "getSearchIndexStatus", "issues", authenticated, "read", "SearchIndexStatusQuery"],
  ["get", "/api/v1/search-index/snapshot", "listSearchIndexSnapshot", "issues", authenticated, "read", "SearchIndexSnapshotQuery"],
  ["get", "/api/v1/search-index/changes", "listSearchIndexChanges", "issues", authenticated, "read", "SearchIndexChangesQuery"],

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

  ["get", "/api/v1/workspaces/{workspace_id}/administrator-candidates", "listWorkspaceAdministratorCandidates", "workspaces", authenticated, "read", "AdministratorCandidateQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/administrators", "listWorkspaceAdministrators", "workspaces", authenticated, "read", "CursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/administrators", "createWorkspaceAdministrator", "workspaces", authenticated, "idempotent-cas", "CreateAdministratorRequest"],
  ["delete", "/api/v1/workspaces/{workspace_id}/administrators/{administrator_id}", "revokeWorkspaceAdministrator", "workspaces", authenticated, "idempotent-cas-delete"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrator-candidates", "listProjectAdministratorCandidates", "projects", authenticated, "read", "AdministratorCandidateQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators", "listProjectAdministrators", "projects", authenticated, "read", "CursorQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators", "createProjectAdministrator", "projects", authenticated, "idempotent-cas", "CreateAdministratorRequest"],
  ["delete", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/administrators/{administrator_id}", "revokeProjectAdministrator", "projects", authenticated, "idempotent-cas-delete"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/members", "listProjectMembers", "projects", authenticated, "read", "CursorQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/member-candidates", "listProjectMemberCandidates", "projects", authenticated, "read", "AdministratorCandidateQuery"],

  ["get", "/api/v1/issues", "listIssues", "issues", authenticated, "read", "IssueListQuery"],
  ["get", "/api/v1/issues/candidates", "listIssueCandidates", "issues", authenticated, "read", "CandidateListQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues", "listProjectIssues", "issues", authenticated, "read", "IssueListQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/counts", "countProjectIssues", "issues", authenticated, "read", "IssueCountsQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/trends", "getProjectIssueTrends", "issues", authenticated, "read", "ProjectIssueTrendsQuery"],
  ["get", "/api/v1/workspaces/{workspace_id}/issues/trends", "getWorkspaceIssueTrends", "issues", authenticated, "read", "WorkspaceIssueTrendsQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues", "createIssue", "issues", authenticated, "idempotent", "CreateIssueRequest"],
  ["get", "/api/v1/issues/{identifier}", "getIssue", "issues", authenticated, "read", "IssueDetailQuery"],
  ["get", "/api/v1/issues/{identifier}/reference", "getIssueReference", "issues", authenticated, "read", "IssueReferenceQuery"],
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

  ["get", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/milestones", "listMilestones", "milestones", authenticated, "read", "MilestoneListQuery"],
  ["post", "/api/v1/workspaces/{workspace_id}/projects/{project_id}/milestones", "createMilestone", "milestones", authenticated, "idempotent", "CreateMilestoneRequest"],
  ["get", "/api/v1/milestones/{milestone_id}", "getMilestone", "milestones", authenticated, "read"],
  ["patch", "/api/v1/milestones/{milestone_id}", "updateMilestone", "milestones", authenticated, "cas", "UpdateMilestoneRequest"],

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

  ["post", "/api/v1/invitations/redeem", "redeemInvitation", "invitations", optionalAuthenticated, "idempotent", "RedeemInvitationRequest"],
  ["get", "/api/v1/admin/invitations", "listInvitations", "invitations", authenticated, "read", "InvitationListQuery"],
  ["post", "/api/v1/admin/invitations", "createInvitation", "invitations", authenticated, "idempotent", "CreateInvitationRequest"],
  ["get", "/api/v1/admin/invitations/{invitation_id}", "getInvitation", "invitations", authenticated, "read"],
  ["delete", "/api/v1/admin/invitations/{invitation_id}", "revokeInvitation", "invitations", authenticated, "cas-delete"],

  ["get", "/api/v1/admin/principals", "listPrincipals", "admin", authenticated, "read", "PrincipalListQuery"],
  ["get", "/api/v1/admin/principals/{principal_id}", "getPrincipal", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/principals/{principal_id}/credentials", "listPrincipalCredentials", "admin", authenticated, "read", "CursorQuery"],
  ["delete", "/api/v1/admin/credentials/{credential_id}", "revokeCredential", "admin", authenticated, "cas-delete"],
  ["post", "/api/v1/admin/owner-credentials/rotate", "rotateOwnerCredential", "admin", bearer, "idempotent", "RotateOwnerCredentialRequest"],
  ["post", "/api/v1/admin/owner-credentials/add-device", "addOwnerDeviceCredential", "admin", authenticated, "idempotent-cas", "AddOwnerDeviceCredentialRequest"],
  ["post", "/api/v1/admin/owner-credentials/{credential_id}/revoke", "revokeOwnerDeviceCredential", "admin", authenticated, "idempotent-cas", "ExpectedVersionRequest"],
  ["post", "/api/v1/admin/owner-credentials/{credential_id}/rename", "renameOwnerDeviceCredential", "admin", authenticated, "idempotent-cas", "RenameOwnerDeviceCredentialRequest"],
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
  ["post", "/api/v1/web-session/renew", "renewWebSession", "web", cookie, "csrf-idempotent", "ExpectedVersionRequest"],
  ["delete", "/api/v1/web-session", "revokeWebSession", "web", cookie, "csrf"],
  ["post", "/api/v1/me/passkeys/registration-options", "createPasskeyRegistrationOptions", "web", cookie, "csrf", "EmptyRequest"],
  ["get", "/api/v1/me/passkeys", "listMyPasskeys", "web", authenticated, "read"],
  ["post", "/api/v1/me/passkeys", "registerPasskey", "web", cookie, "csrf-idempotent", "RegisterPasskeyRequest"],
  ["delete", "/api/v1/me/passkeys/{passkey_id}", "revokeMyPasskey", "web", authenticated, "csrf-idempotent-cas-delete"],
  ["delete", "/api/v1/admin/passkeys/{passkey_id}", "revokePrincipalPasskey", "admin", authenticated, "csrf-cas-delete"],
  ["post", "/api/v1/web-authentication/options", "createWebAuthenticationOptions", "web", publicAccess, "write", "EmptyRequest"],
  ["post", "/api/v1/web-authentication/verify", "verifyWebAuthentication", "web", publicAccess, "idempotent", "VerifyWebAuthenticationRequest"],
  ["get", "/api/v1/public-projects", "listPublicProjects", "public-join", publicAccess, "read", "CursorQuery"],
  ["get", "/api/v1/admin/projects/{project_id}/public-join", "getPublicJoinPolicy", "public-join", authenticated, "read"],
  ["put", "/api/v1/admin/projects/{project_id}/public-join", "enablePublicJoin", "public-join", authenticated, "idempotent-cas", "EnablePublicJoinRequest"],
  ["delete", "/api/v1/admin/projects/{project_id}/public-join", "disablePublicJoin", "public-join", authenticated, "cas-delete"],
  ["get", "/api/v1/admin/projects/{project_id}/resource-limits", "getProjectResourceLimits", "public-join", authenticated, "read"],
  ["patch", "/api/v1/admin/projects/{project_id}/resource-limits", "updateProjectResourceLimits", "public-join", authenticated, "cas", "UpdateResourceLimitsRequest"],
  ["get", "/api/v1/admin/homepage-settings", "getHomepageSettings", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/release-updates", "getReleaseUpdates", "admin", authenticated, "read"],
  ["patch", "/api/v1/admin/homepage-settings", "updateHomepageSettings", "admin", authenticated, "idempotent-cas", "UpdateHomepageSettingsRequest"],
  ["get", "/api/v1/admin/attachment-settings", "getAttachmentSettings", "admin", authenticated, "read"],
  ["patch", "/api/v1/admin/attachment-settings", "updateAttachmentSettings", "admin", authenticated, "idempotent-cas", "UpdateAttachmentSettingsRequest"],
  ["get", "/api/v1/admin/usage", "getUsage", "admin", authenticated, "read"],
  ["post", "/api/v1/admin/usage/refresh", "refreshUsage", "admin", authenticated, "cache-refresh", "RefreshUsageRequest"],
  ["get", "/api/v1/admin/rate-limit-settings", "getRateLimitSettings", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/usage/history", "getUsageHistory", "admin", authenticated, "read", "UsageHistoryQuery"],
  ["post", "/api/v1/admin/usage/history/collect", "collectUsageHistory", "admin", authenticated, "cache-refresh", "CollectUsageHistoryRequest"],
  ["get", "/api/v1/admin/cloudflare", "getCloudflareControl", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/cloudflare/notifications", "getCloudflareNotifications", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/cloudflare/waf", "getCloudflareWaf", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/cloudflare/waf/operations/{request_key}", "getCloudflareWafOperation", "admin", authenticated, "read"],
  ["post", "/api/v1/admin/cloudflare/waf/target-binding", "registerCloudflareWafTarget", "admin", authenticated, "idempotent-cas", "RegisterCloudflareWafTargetRequest"],
  ["post", "/api/v1/admin/cloudflare/waf/plan", "planCloudflareWaf", "admin", authenticated, "idempotent-cas", "PlanCloudflareWafRequest"],
  ["post", "/api/v1/admin/cloudflare/waf/apply", "applyCloudflareWaf", "admin", authenticated, "idempotent-cas", "ApplyCloudflarePlanRequest"],
  ["post", "/.well-known/cfkanban-waf-proof", "proveCloudflareWafOrigin", "meta", [{ WafOriginProof: [] }], "read", "CloudflareWafProofRequest"],
  ["get", "/api/v1/admin/cloudflare/operations/{operation_id}", "getCloudflareOperation", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/cloudflare/secret-operations/{request_key}", "getCloudflareSecretOperation", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/cloudflare/configuration/operations/{request_key}", "getCloudflareConfigurationOperation", "admin", authenticated, "read"],
  ["get", "/api/v1/admin/cloudflare/local-operations/{request_key}", "getCloudflareLocalOperation", "admin", authenticated, "read", "CloudflareLocalOperationQuery"],
  ["get", "/api/v1/admin/cloudflare/plans/{plan_id}", "getCloudflarePlan", "admin", authenticated, "read"],
  ["post", "/api/v1/admin/cloudflare/verify", "verifyCloudflareControl", "admin", authenticated, "idempotent", "CloudflareVerifyRequest"],
  ["patch", "/api/v1/admin/cloudflare/settings", "updateCloudflareSettings", "admin", authenticated, "idempotent-cas", "UpdateCloudflareSettingsRequest"],
  ["post", "/api/v1/admin/cloudflare/secrets", "saveCloudflareSecret", "admin", authenticated, "idempotent-cas", "SaveCloudflareSecretRequest"],
  ["post", "/api/v1/admin/cloudflare/operations/{operation_id}/verify", "verifyCloudflareOperation", "admin", authenticated, "idempotent", "EmptyRequest"],
  ["post", "/api/v1/admin/cloudflare/rate-limits/plan", "planCloudflareRateLimits", "admin", authenticated, "idempotent-cas", "PlanCloudflareRateLimitsRequest"],
  ["post", "/api/v1/admin/cloudflare/rate-limits/apply", "applyCloudflareRateLimits", "admin", authenticated, "idempotent-cas", "ApplyCloudflarePlanRequest"],
  ["post", "/api/v1/admin/cloudflare/configuration/plan", "planCloudflareConfiguration", "admin", authenticated, "idempotent-cas", "PlanCloudflareConfigurationRequest"],
  ["post", "/api/v1/admin/cloudflare/configuration/apply", "applyCloudflareConfiguration", "admin", authenticated, "idempotent-cas", "ApplyCloudflarePlanRequest"],
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
  hierarchy: ref("IssueHierarchy"),
  milestone: { anyOf: [ref("IssueMilestoneSummary"), { type: "null" }] },
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

const issueMentionReferenceProperties = {
  id: ref("Uuid"),
  identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
  title: string({ maxLength: 256 }),
  project: {
    type: "object", required: ["id", "display_name"],
    properties: { id: ref("Uuid"), display_name: string({ maxLength: 128 }) }, additionalProperties: false,
  },
  workspace: {
    type: "object", required: ["id", "display_name"],
    properties: { id: ref("Uuid"), display_name: string({ maxLength: 128 }) }, additionalProperties: false,
  },
};
const issueSummaryRequired = Object.keys(issueSummaryProperties).filter(name => !["hierarchy", "milestone"].includes(name));
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
  control_origin_proof: "Internal service proof authenticated by a transient, domain-separated HMAC for the fixed current Instance/Worker/origin. No ordinary business API or CLI signing capability.",
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
  invitation_capability: "A valid one-time Invitation capability, with conditional current-Principal authentication required by redeem_as. Cookie sessions may redeem only ordinary Project Invitations as their current non-Owner Principal within their unchanged Session scope.",
  browser_launch_capability: "A valid one-time Browser Launch capability.",
  webauthn_options: "Public creation of a short-lived, single-use discoverable WebAuthn authentication challenge.",
  webauthn_capability: "A valid single-use WebAuthn challenge and assertion ceremony.",
  public_join_capability: "An enabled single-Project Public Join policy, with conditional authentication required by redeem_as.",
};

const permissionGroups = {
  control_origin_proof: ["proveCloudflareWafOrigin"],
  public: ["getHealth", "getOpenApi", "discoverInstance", "getInvitationBootstrap", "getWebLaunchPage", "listPublicProjects"],
  authenticated_principal: ["getMeta", "listEvents", "getSearchIndexStatus"],
  visible_scope_active_owner_tombstone: ["listWorkspaces", "getWorkspace", "listProjects", "getProject"],
  current_principal: ["getMe", "updateMe", "getWebSession", "renewWebSession", "revokeWebSession", "listMyPasskeys", "revokeMyPasskey", "getNotificationPreferences", "updateNotificationPreferences", "listMyNotifications", "acknowledgeNotification"],
  deployment_owner: [
    "getUsageHistory", "collectUsageHistory", "getCloudflareControl", "getCloudflareNotifications", "getCloudflareWaf", "getCloudflareWafOperation", "registerCloudflareWafTarget", "planCloudflareWaf", "applyCloudflareWaf", "getCloudflareOperation", "getCloudflareSecretOperation", "getCloudflareConfigurationOperation", "getCloudflareLocalOperation", "getCloudflarePlan", "verifyCloudflareControl", "updateCloudflareSettings", "saveCloudflareSecret", "verifyCloudflareOperation", "planCloudflareRateLimits", "applyCloudflareRateLimits", "planCloudflareConfiguration", "applyCloudflareConfiguration",
    "getReleaseUpdates",
    "previewWorkspacePurge", "purgeWorkspace", "previewProjectPurge", "purgeProject",
    "createWorkspace", "deleteWorkspace", "restoreWorkspace",
    "createWorkspaceAdministrator", "revokeWorkspaceAdministrator", "listWorkspaceAdministratorCandidates",
    "listPrincipals", "getPrincipal", "listPrincipalCredentials", "revokeCredential", "rotateOwnerCredential", "addOwnerDeviceCredential", "revokeOwnerDeviceCredential", "renameOwnerDeviceCredential",
    "getInstanceOrigin", "updateInstanceOrigin", "listAuditEvents", "revokePrincipalPasskey",
    "getPublicJoinPolicy", "enablePublicJoin", "disablePublicJoin", "getProjectResourceLimits",
    "updateProjectResourceLimits", "getRateLimitSettings", "getUsage", "refreshUsage", "getAttachmentSettings", "updateAttachmentSettings", "getHomepageSettings", "updateHomepageSettings",
    "listInstanceNotifications", "publishNotification", "withdrawNotification", "getUpgradeNotificationSettings", "updateUpgradeNotificationSettings", "publishUpgradeNotification", "getUpgradeNotificationRelease",
  ],
  workspace_administrator: ["listProjectAdministratorCandidates", "updateWorkspace", "createProject", "deleteProject", "restoreProject", "listWorkspaceAdministrators", "createProjectAdministrator", "revokeProjectAdministrator"],
  project_administrator: ["updateProject", "updateProjectStatusName", "listProjectAdministrators", "listProjectMembers", "listProjectMemberCandidates", "listProjectGrants", "createProjectGrant", "getProjectGrant", "updateProjectGrant", "revokeProjectGrant"],
  scoped_invitation_manager: ["listInvitations", "createInvitation", "getInvitation", "revokeInvitation"],
  project_reader: ["getProjectIssueTrends", "getWorkspaceIssueTrends", "listMilestones", "getMilestone", "findProjectAssignee", "downloadAttachment", "getAttachment", "listProjectStatuses", "listIssueCandidates", "getIssueContext", "getIssueReference", "countProjectIssues", "listSearchIndexSnapshot", "listSearchIndexChanges"],
  project_reader_active_writer_tombstone: [
    "listIssues", "listProjectIssues", "getIssue",
    "listAttachments", "listComments", "getComment", "listLabels", "getLabel",
  ],
  project_writer: [
    "createMilestone", "updateMilestone",
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
        required: ["projects", "issues", "comments", "attachments", "attachment_bytes", "labels", "milestones", "relations", "cross_project_relations", "grants", "invitations", "shared_invitations", "browser_launches", "web_sessions"],
        properties: { ...Object.fromEntries(["projects", "issues", "comments", "attachments", "attachment_bytes", "labels", "milestones", "relations", "cross_project_relations", "grants", "invitations", "shared_invitations", "browser_launches", "web_sessions"].map((key) => [key, integer({ minimum: 0 })])), administrators: integer({ minimum: 0, description: "Direct administrator records belonging to the target container; excludes inherited sources and ordinary Project Grants." }) },
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
  PrincipalTheme: string({ enum: ["orange", "blue"], default: "orange", description: "Personal color palette; layout and interactions remain the same." }),
  PrincipalLocale: { type: ["string", "null"], enum: ["en", "zh-CN", null], default: null, description: "Personal language preference; null clears the preference and lets the client use its language fallback." },
  UpdatePrincipalDisplayNameRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), display_name: ref("PrincipalDisplayNameInput"), locale: ref("PrincipalLocale"), theme: ref("PrincipalTheme") }, additionalProperties: false },
  ProjectAssigneeResult: {
    type: "object", required: ["items", "has_more", "next_cursor"], additionalProperties: false,
    properties: {
      has_more: { type: "boolean" }, next_cursor: nullableString(),
      items: { type: "array", maxItems: 100, items: { type: "object", required: ["principal_id", "display_name"], properties: { principal_id: ref("Uuid"), display_name: string() }, additionalProperties: false } },
    },
  },
  UpdateDisplayNameRequest: { type: "object", required: ["expected_version", "display_name"], properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateWorkspaceRequest: { type: "object", required: ["display_name"], properties: { display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateProjectRequest: { type: "object", required: ["display_name"], properties: { display_name: string({ minLength: 1, maxLength: 128 }), context: nullableUtf8String(32768, { description: "Untrusted bounded Project context." }) }, additionalProperties: false },
  UpdateProjectRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }), context: nullableUtf8String(32768, { description: "Untrusted bounded Project context." }) }, additionalProperties: false },
  UpdateStatusNameRequest: { type: "object", required: ["expected_version", "display_name"], properties: { expected_version: ref("Version"), display_name: string({ minLength: 1, maxLength: 128 }) }, additionalProperties: false },
  CreateIssueRequest: { type: "object", required: ["title"], properties: { title: string({ minLength: 1, maxLength: 256 }), body: utf8String(65536, { default: "", description: "Untrusted Markdown source." }), status_key: { ...ref("NonDoneStatusKey"), default: "backlog" }, priority_key: { ...ref("PriorityKey"), default: "none" }, assignee_principal_id: { anyOf: [ref("Uuid"), { type: "null" }], default: null }, milestone_id: { anyOf: [ref("Uuid"), { type: "null" }], default: null }, label_ids: { type: "array", items: ref("Uuid"), maxItems: 20, uniqueItems: true, default: [] } }, additionalProperties: false },
  UpdateIssueRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), title: string({ minLength: 1, maxLength: 256 }), body: utf8String(65536, { description: "Untrusted Markdown source." }), status_key: ref("NonDoneStatusKey"), priority_key: ref("PriorityKey"), assignee_principal_id: { anyOf: [ref("Uuid"), { type: "null" }] }, milestone_id: { anyOf: [ref("Uuid"), { type: "null" }] } }, additionalProperties: false },
  ReportBlockedRequest: { type: "object", required: ["expected_version", "reason"], properties: { expected_version: ref("Version"), reason: string({ minLength: 1, maxLength: 4096 }) }, additionalProperties: false },
  CompleteIssueRequest: { type: "object", required: ["expected_version"], properties: { expected_version: ref("Version"), summary: string({ maxLength: 8192, default: "", description: "Optional completion note. Omitted, empty, or whitespace-only values are stored as an empty string." }), verification: { type: "array", items: string({ minLength: 1, maxLength: 1024 }), maxItems: 50, default: [] }, artifacts: { type: "array", items: { type: "object", required: ["kind", "value"], properties: { kind: string({ enum: ["url", "path", "commit", "other"] }), value: string({ minLength: 1, maxLength: 2048 }) }, additionalProperties: false }, maxItems: 50, default: [] }, follow_ups: { type: "array", items: string({ minLength: 1, maxLength: 2048 }), maxItems: 50, default: [] } }, additionalProperties: false, "x-cfkanban-max-utf8-bytes": 32768 },
  IssueLabelRequest: { type: "object", required: ["expected_version", "label_id"], properties: { expected_version: ref("Version"), label_id: ref("Uuid") }, additionalProperties: false },
  CreateCommentRequest: { type: "object", required: ["body"], properties: { body: utf8String(32768, { minLength: 1, description: "Append-only untrusted Comment body." }), reply_to_comment_id: { anyOf: [ref("Uuid"), { type: "null" }], default: null } }, additionalProperties: false },
  CreateMilestoneRequest: { type: "object", required: ["title"], properties: { title: string({ minLength: 1, maxLength: 200 }), description: utf8String(8192, { default: "" }), due_date: nullableString({ format: "date" }), status_key: string({ enum: ["open", "closed"], default: "open" }) }, additionalProperties: false },
  UpdateMilestoneRequest: { type: "object", required: ["expected_version"], minProperties: 2, properties: { expected_version: ref("Version"), title: string({ minLength: 1, maxLength: 200 }), description: utf8String(8192), due_date: nullableString({ format: "date" }), status_key: string({ enum: ["open", "closed"] }) }, additionalProperties: false },
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
  OwnerDeviceResource: {
    type: "object",
    required: ["id", "principal_id", "device_name", "fingerprint", "issued_at", "last_used_at", "revoked_at", "revoke_reason", "principal_version"],
    properties: {
      id: ref("Uuid"), principal_id: ref("Uuid"),
      device_name: { anyOf: [string({ maxLength: 80 }), { type: "null" }] },
      fingerprint: string(), issued_at: ref("Timestamp"),
      last_used_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      revoked_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      revoke_reason: { anyOf: [string(), { type: "null" }] },
      principal_version: ref("Version"),
    },
    additionalProperties: false,
  },
  OwnerDeviceWriteResult: containerWriteResult("OwnerDeviceResource"),
  AddOwnerDeviceCredentialRequest: {
    type: "object",
    required: ["instance_id", "principal_id", "credential_id", "token_prefix", "token_digest", "device_name", "issued_at", "expires_at", "expected_version"],
    properties: {
      instance_id: ref("Uuid"), principal_id: ref("Uuid"), credential_id: ref("Uuid"),
      token_prefix: string({ pattern: "^[a-f0-9]{16}$" }),
      token_digest: string({ pattern: "^[a-f0-9]{64}$", writeOnly: true, description: "SHA-256 of a high-entropy Credential generated and privately stored on the new device; never accepts the secret itself." }),
      device_name: string({ minLength: 1, maxLength: 80, description: "User-provided environment label, not a hardware identity. Trimmed; control characters are rejected." }),
      issued_at: ref("Timestamp"), expires_at: { ...ref("Timestamp"), description: "Pairing approval expiry, at most one hour after issued_at; does not expire an approved Credential." },
      expected_version: { ...ref("Version"), description: "Current Owner Principal version from /me.version." },
    },
    additionalProperties: false,
  },
  RenameOwnerDeviceCredentialRequest: {
    type: "object", required: ["device_name", "expected_version"], additionalProperties: false,
    properties: {
      device_name: string({ minLength: 1, maxLength: 80, description: "Trimmed user-provided display label containing 1–80 Unicode code points. Control/format characters and secret credential material are rejected; never an identity or authorization key." }),
      expected_version: { ...ref("Version"), description: "Current Owner Principal version from /me.version; not the Credential summary version." },
    },
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
  AdministratorCandidate: {
    type: "object", required: ["principal_id", "display_name", "expected_version"],
    properties: { principal_id: ref("Uuid"), display_name: string(), expected_version: integer({ minimum: 0 }) }, additionalProperties: false,
  },
  AdministratorCandidateListResult: {
    type: "object", required: ["has_more", "items", "next_cursor", "resolved_scope"],
    description: "Excludes Owner and active direct or inherited administrators before pagination. Instance-scoped Owner may select any existing Principal; narrower callers see only current scope members and previously listed administrators. expected_version is 0 for a first grant or the revoked direct grant version. Eligibility is advisory; POST rechecks authorization, CAS and quotas.",
    properties: {
      has_more: { type: "boolean" }, items: { type: "array", maxItems: 100, items: ref("AdministratorCandidate") }, next_cursor: nullableString(),
      resolved_scope: { type: "object", required: ["workspace_id", "project_id"], properties: { workspace_id: ref("Uuid"), project_id: { anyOf: [ref("Uuid"), { type: "null" }] } }, additionalProperties: false },
    }, additionalProperties: false,
  },
  ProjectMemberCandidate: {
    type: "object", required: ["principal_id", "display_name"],
    properties: { principal_id: ref("Uuid"), display_name: string() }, additionalProperties: false,
  },
  ProjectMemberCandidateListResult: {
    type: "object", required: ["has_more", "items", "next_cursor", "resolved_scope"],
    description: "Requires current Project member-management permission. Excludes Owner and active direct Project grants before pagination. Instance-scoped Owner can select existing Principals; narrower callers see only this Project's effective members and existing direct member/administrator records. Inherited or direct administrators may receive an independent ordinary grant; revoked direct grants may be regranted. No other Project or Workspace directory is exposed. Grant writes retain their existing authorization and quota checks.",
    properties: {
      has_more: { type: "boolean" }, items: { type: "array", maxItems: 100, items: ref("ProjectMemberCandidate") }, next_cursor: nullableString(),
      resolved_scope: { type: "object", required: ["workspace_id", "project_id"], properties: { workspace_id: ref("Uuid"), project_id: ref("Uuid") }, additionalProperties: false },
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
    type: "object", required: ["id", "principal_id", "display_name", "locale", "theme", "is_owner", "version", "management_grants"],
    properties: {
      id: ref("Uuid"), principal_id: ref("Uuid"), display_name: string(), locale: ref("PrincipalLocale"), theme: ref("PrincipalTheme"), is_owner: { type: "boolean" }, version: ref("Version"),
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
  HomepageNotice: { type: ["string", "null"], maxLength: 500, description: "Public plain text, at most 500 Unicode code points after trimming; whitespace-only input is stored as null and uses the homepage fallback." },
  HomepageSettings: {
    type: "object", required: ["notice_en", "notice_zh_cn", "version"],
    properties: { notice_en: ref("HomepageNotice"), notice_zh_cn: ref("HomepageNotice"), version: ref("Version") }, additionalProperties: false,
  },
  AvailableRelease: {
    type: "object", required: ["version", "url", "published_at", "newer_than_instance"],
    properties: { version: { type: "string", maxLength: 128 }, url: { type: "string", format: "uri" }, published_at: ref("Timestamp"), newer_than_instance: { type: ["boolean", "null"] } }, additionalProperties: false,
  },
  ReleaseUpdateChannel: {
    type: "object", required: ["status", "checked_at", "last_attempt_at", "retry_at", "error", "releases"],
    properties: { status: { type: "string", enum: ["fresh", "stale", "unavailable"] }, checked_at: { type: ["string", "null"], format: "date-time" }, last_attempt_at: { type: ["string", "null"], format: "date-time" }, retry_at: { type: ["string", "null"], format: "date-time" }, error: { type: ["string", "null"], enum: ["rate_limited", "query_failed", null] }, releases: { type: "array", maxItems: 5, items: ref("AvailableRelease") } }, additionalProperties: false,
  },
  ReleaseUpdates: {
    type: "object", required: ["current_version", "stable", "prereleases", "prerelease_window"],
    properties: { current_version: { type: "string" }, stable: ref("ReleaseUpdateChannel"), prereleases: ref("ReleaseUpdateChannel"), prerelease_window: { type: "integer", const: 20 } }, additionalProperties: false,
  },
  UpdateHomepageSettingsRequest: {
    type: "object", required: ["expected_version", "notice_en", "notice_zh_cn"],
    properties: { expected_version: ref("Version"), notice_en: ref("HomepageNotice"), notice_zh_cn: ref("HomepageNotice") }, additionalProperties: false,
  },
  HomepageSettingsWriteResult: containerWriteResult("HomepageSettings"),
  NotificationPreferences: {
    type: "object", required: ["enabled", "version", "receive_after"],
    properties: { enabled: { type: "boolean" }, version: ref("Version"), receive_after: ref("Timestamp") }, additionalProperties: false,
  },
  UpdateNotificationPreferencesRequest: {
    type: "object", required: ["enabled", "expected_version"],
    properties: { enabled: { type: "boolean" }, expected_version: ref("Version") }, additionalProperties: false,
  },
  NotificationPreferencesWriteResult: containerWriteResult("NotificationPreferences"),
  UpgradeNotificationSettings: {
    type: "object", required: ["enabled", "version"],
    properties: { enabled: { type: "boolean" }, version: ref("Version") }, additionalProperties: false,
  },
  UpdateUpgradeNotificationSettingsRequest: {
    type: "object", required: ["enabled", "expected_version"],
    properties: { enabled: { type: "boolean" }, expected_version: ref("Version") }, additionalProperties: false,
  },
  UpgradeNotificationSettingsWriteResult: containerWriteResult("UpgradeNotificationSettings"),
  PublishUpgradeNotificationRequest: {
    type: "object", required: ["previous_release_version", "release_version", "deployment_id", "worker_version_id"],
    properties: {
      previous_release_version: string({ minLength: 1, maxLength: 128 }), release_version: string({ minLength: 1, maxLength: 128 }),
      deployment_id: ref("Uuid"), worker_version_id: ref("Uuid"),
    }, additionalProperties: false,
  },
  UpgradeNotificationResult: {
    type: "object", required: ["status", "previous_release_version", "release_version", "deployment_id", "worker_version_id", "notification_id"],
    properties: {
      status: string({ enum: ["published", "already_published", "disabled", "not_forward", "unsupported_channel"] }),
      previous_release_version: string(), release_version: string(), deployment_id: ref("Uuid"), worker_version_id: ref("Uuid"),
      notification_id: { anyOf: [ref("Uuid"), { type: "null" }] },
    }, additionalProperties: false,
  },
  UpgradeNotificationWriteResult: containerWriteResult("UpgradeNotificationResult"),
  UpgradeNotificationRelease: {
    type: "object", required: ["previous_release_version", "release_version", "deployment_id", "worker_version_id", "notification_id"],
    properties: { previous_release_version: string(), release_version: string(), deployment_id: ref("Uuid"), worker_version_id: ref("Uuid"), notification_id: ref("Uuid") }, additionalProperties: false,
  },
  InstanceNotification: {
    type: "object", required: ["id", "title", "body", "created_at", "expires_at", "withdrawn_at", "version", "status", "acknowledged_at"],
    properties: {
      id: ref("Uuid"), title: string({ minLength: 1, maxLength: 200 }), body: string({ minLength: 1, maxLength: 4000 }),
      created_at: ref("Timestamp"), expires_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      withdrawn_at: { anyOf: [ref("Timestamp"), { type: "null" }] }, version: ref("Version"),
      status: string({ enum: ["active", "expired", "withdrawn"] }), acknowledged_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
    }, additionalProperties: false,
  },
  PublishNotificationRequest: {
    type: "object", required: ["title", "body"], properties: {
      title: string({ minLength: 1, maxLength: 200, description: "Trimmed plain title, at most 200 Unicode code points." }),
      body: string({ minLength: 1, maxLength: 4000, description: "Immutable plain text, at most 4000 Unicode code points; untrusted business content." }),
      expires_at: { anyOf: [ref("Timestamp"), { type: "null" }], description: "Optional future UTC timestamp; expiration preserves history." },
    }, additionalProperties: false,
  },
  InstanceNotificationWriteResult: containerWriteResult("InstanceNotification"),
  InstanceNotificationList: {
    type: "object", required: ["items", "next_cursor"],
    properties: { items: { type: "array", maxItems: 50, items: ref("InstanceNotification") }, next_cursor: nullableString() }, additionalProperties: false,
  },
  PublicHomepageNotice: {
    type: "object", required: ["en", "zh-CN"],
    properties: { en: ref("HomepageNotice"), "zh-CN": ref("HomepageNotice") }, additionalProperties: false,
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
  CollectUsageHistoryRequest: { type: "object", required: ["day"], properties: { day: string({ format: "date", description: "One of the last seven complete UTC dates; today is rejected." }) }, additionalProperties: false },
  UsageHistory: {
    type: "object", required: ["enabled", "retention_days", "generated_at", "items", "missing_days", "source", "history_kind", "error"], additionalProperties: false,
    properties: { enabled: { type: "boolean" }, retention_days: { const: 90 }, generated_at: ref("Timestamp"), source: { const: "cloudflare_analytics" }, history_kind: { const: "utc_daily" }, error: nullableString({ maxLength: 64 }), missing_days: { type: "array", maxItems: 90, items: string({ format: "date" }) }, items: { type: "array", maxItems: 90, items: { type: "object", required: ["day", "collected_at", "metrics", "complete_day"], additionalProperties: false, properties: { day: string({ format: "date" }), collected_at: ref("Timestamp"), metrics: { type: "array", maxItems: 32, items: ref("UsageMetric") }, complete_day: { const: true } } } } },
  },
  CloudflareCapability: string({ enum: ["missing", "unverified", "verified", "permission_denied", "unavailable", "target_mismatch", "unsupported_contract"] }),
  CloudflareBudget: { type: "object", required: ["status", "docs_url", "dashboard_url"], additionalProperties: false, properties: { status: { const: "unsupported_contract" }, docs_url: string({ format: "uri" }), dashboard_url: string({ format: "uri" }) }, description: "The public USD Budget Alert field contract is not confirmed. Notification policy limit fields must not be interpreted as USD." },
  CloudflareConfiguration: { type: "object", additionalProperties: false, properties: { history_enabled: { type: "boolean" }, analytics_enabled: { type: "boolean" }, billing_plan: { enum: ["free", "paid", null] }, billing_cycle_day: { type: ["integer", "null"], minimum: 1, maximum: 31 }, account_totals: { type: "boolean" }, warning_percent: integer({ minimum: 1, maximum: 100 }) } },
  CloudflareOperation: { type: "object", allOf: [{ if: { properties: { kind: { const: "waf" } }, required: ["kind"] }, then: { required: ["result_rule_id"], properties: { result_rule_id: nullableString({ maxLength: 128 }), baseline_version_id: { type: "null" }, result_version_id: { type: "null" }, deployment_id: { type: "null" } } } }], required: ["operation_id", "kind", "status", "version", "baseline_version_id", "result_version_id", "deployment_id", "failure_class", "created_at", "updated_at"], additionalProperties: false, properties: { operation_id: ref("Uuid"), kind: string({ enum: ["configuration_secret", "control_secret", "analytics_secret", "configuration", "rate_limit", "waf"] }), status: string({ enum: ["pending", "verified", "failed", "unknown"] }), version: ref("Version"), baseline_version_id: nullableString(), result_version_id: nullableString(), result_rule_id: nullableString({ maxLength: 128 }), deployment_id: nullableString(), failure_class: nullableString({ maxLength: 128 }), created_at: ref("Timestamp"), updated_at: ref("Timestamp") } },
  CloudflareControl: {
    type: "object", required: ["version", "target", "configured", "capabilities", "verified_at", "budget", "latest_operation", "configuration"], additionalProperties: false,
    properties: { version: ref("Version"), target: { type: "object", required: ["account_id", "worker_name", "database_id", "zone_id", "hostname"], additionalProperties: false, properties: { account_id: nullableString({ maxLength: 128 }), worker_name: nullableString({ maxLength: 63 }), database_id: { anyOf: [ref("Uuid"), { type: "null" }] }, zone_id: nullableString({ maxLength: 128 }), hostname: string({ maxLength: 253 }) } }, configured: { type: "object", required: ["connection", "configuration", "control", "analytics"], additionalProperties: false, properties: { connection: { type: "boolean", description: "Presence of CFKANBAN_API_TOKEN; legacy usage fields project the effective unified-or-legacy token." }, configuration: { type: "boolean" }, control: { type: "boolean" }, analytics: { type: "boolean" } } }, capabilities: { type: "object", required: ["configuration", "notifications", "waf", "billing", "analytics"], additionalProperties: false, properties: Object.fromEntries(["configuration", "notifications", "waf", "billing", "analytics"].map(key => [key, ref("CloudflareCapability")])) }, verified_at: { anyOf: [ref("Timestamp"), { type: "null" }] }, budget: ref("CloudflareBudget"), latest_operation: { anyOf: [ref("CloudflareOperation"), { type: "null" }] }, configuration: ref("CloudflareConfiguration") },
  },
  CloudflareNotifications: { type: "object", required: ["status", "available_alerts", "policies", "budget"], additionalProperties: false, properties: { status: ref("CloudflareCapability"), budget: ref("CloudflareBudget"), available_alerts: { type: "array", maxItems: 500, items: { type: "object", required: ["type", "display_name", "description", "filter_options"], additionalProperties: false, properties: { type: string({ maxLength: 256 }), display_name: string({ maxLength: 500 }), description: string({ maxLength: 2000 }), filter_options: { type: "array", maxItems: 500, items: {} } } } }, policies: { type: "array", maxItems: 500, items: { type: "object", required: ["id", "name", "alert_type", "enabled", "emails", "filters"], additionalProperties: false, properties: { id: string({ maxLength: 256 }), name: string({ maxLength: 500 }), alert_type: string({ maxLength: 256 }), enabled: { type: "boolean" }, emails: { type: "array", maxItems: 500, items: string({ maxLength: 320 }) }, filters: { type: "object", additionalProperties: true } } } } } },
  CloudflareWafRule: { type: "object", required: ["id", "enabled", "action", "expression"], additionalProperties: false, properties: { id: string({ maxLength: 128 }), ref: nullableString({ maxLength: 256 }), description: nullableString({ maxLength: 500 }), enabled: { type: "boolean" }, action: string({ maxLength: 256 }), expression: string({ maxLength: 16384 }) } },
  CloudflareWafBinding: { type: "object", required: ["status", "source", "domain_id", "verified_at"], additionalProperties: false, properties: { status: ref("CloudflareCapability"), source: { enum: ["worker_domain_read", "deployment_runtime", null] }, domain_id: nullableString({ maxLength: 128 }), verified_at: { anyOf: [ref("Timestamp"), { type: "null" }] }, live_verified: { type: "boolean" }, service_proof: { type: "boolean" } } },
  CloudflareWafConflict: { type: "object", required: ["rule_id", "ruleset_id", "kind", "repositionable"], additionalProperties: false, properties: { rule_id: nullableString({ maxLength: 128 }), ruleset_id: nullableString({ maxLength: 128 }), kind: { enum: ["skip", "unowned_duplicate", "expression_unverified", "ip_access_allow", "ip_access_unverified"] }, scope: { enum: ["zone", "account"] }, repositionable: { type: "boolean" } } },
  CloudflareWafCoverage: { type: "object", required: ["status", "workers_dev", "previews_enabled"], additionalProperties: false, properties: { status: { enum: ["incomplete", "hostname_only"] }, workers_dev: { type: ["boolean", "null"] }, previews_enabled: { type: ["boolean", "null"] }, exemptions_preserved: { type: "boolean" } } },
  CloudflareWaf: {
    type: "object", required: ["status", "zone_id", "hostname", "owned_rule", "other_rule_count", "protected"], additionalProperties: false,
    properties: { status: ref("CloudflareCapability"), zone_id: nullableString({ maxLength: 128 }), hostname: string({ maxLength: 253 }), other_rule_count: integer({ minimum: 0, maximum: 5000 }), protected: { type: "boolean", description: "Requires verified ownership/target, no detected exemptions and closed alternate origins; not a live edge test." }, owned_rule: { anyOf: [{ type: "null" }, ref("CloudflareWafRule")] },
      version: ref("Version"), reason: string({ maxLength: 256 }), target_binding: ref("CloudflareWafBinding"), ownership: { type: "object", required: ["status", "ruleset_id", "rule_id"], additionalProperties: false, properties: { status: { enum: ["missing", "verified"] }, ruleset_id: nullableString({ maxLength: 128 }), rule_id: nullableString({ maxLength: 128 }) } },
      entrypoint: { type: "object", required: ["strategy", "id"], additionalProperties: false, properties: { strategy: { enum: ["unverified", "append_rule", "create_entrypoint"] }, id: nullableString({ maxLength: 128 }) } }, inventory: { type: "object", required: ["complete", "ruleset_count", "total_rule_count", "free_rule_limit", "capacity_available"], additionalProperties: false, properties: { complete: { type: "boolean" }, ruleset_count: integer({ minimum: 0, maximum: 10 }), total_rule_count: integer({ minimum: 0, maximum: 5000 }), free_rule_limit: { const: 5 }, capacity_available: { type: "boolean" } } }, conflicts: { type: "array", maxItems: 6000, items: ref("CloudflareWafConflict") }, coverage: ref("CloudflareWafCoverage") },
    description: "Schema 27 adds target, ownership, inventory and coverage. Older schema projections are read-only compatibility and do not authorize mutation.",
  },
  CloudflareWafAfter: { type: "object", required: ["action", "profile", "entrypoint_strategy", "entrypoint_id", "position_before", "conflict_choice", "conflicts", "apply_ready", "coverage", "rule", "purchase_or_upgrade_plan", "modifies_foreign_rules"], additionalProperties: false, properties: { action: { enum: ["enable", "disable"] }, profile: { enum: ["anonymous-api-filter", "disabled"] }, entrypoint_strategy: { enum: ["none", "append_rule", "create_entrypoint", "delete_owned_rule", "reposition_owned_rule"] }, entrypoint_id: nullableString({ maxLength: 128 }), position_before: nullableString({ maxLength: 128 }), conflict_choice: { enum: ["preserve_exemptions", "before_conflicts", null] }, conflicts: { type: "array", maxItems: 6000, items: ref("CloudflareWafConflict") }, apply_ready: { type: "boolean" }, coverage: ref("CloudflareWafCoverage"), rule: { type: "object", additionalProperties: true }, purchase_or_upgrade_plan: { const: false }, modifies_foreign_rules: { const: false } } },
  RegisterCloudflareWafTargetRequest: { type: "object", required: ["expected_version"], additionalProperties: false, properties: { expected_version: ref("Version") } },
  PlanCloudflareWafRequest: { type: "object", required: ["action", "expected_version"], additionalProperties: false, properties: { action: { enum: ["enable", "disable"] }, expected_version: ref("Version"), conflict_choice: { enum: ["preserve_exemptions", "before_conflicts"] } } },
  CloudflareWafTargetResult: { type: "object", required: ["version", "target_binding"], additionalProperties: false, properties: { version: ref("Version"), target_binding: ref("CloudflareWafBinding") } },
  CloudflareWafTargetWriteResult: containerWriteResult("CloudflareWafTargetResult"),
  CloudflareWafLocalState: { type: "object", required: ["version", "status", "zone_id", "hostname", "target_binding", "protected"], additionalProperties: false, properties: { version: ref("Version"), status: { const: "unsupported_contract" }, zone_id: nullableString({ maxLength: 128 }), hostname: string({ maxLength: 253 }), target_binding: ref("CloudflareWafBinding"), protected: { const: false } }, description: "Retired local schema 27 target projection. No inventory, capacity, live rule or protection claim is inferred without provider reads. The full older WAF response remains a legacy compatibility alternative." },
  CloudflareLocalOperation: { type: "object", required: ["operation", "request_hash", "event_cursor", "idempotent_replay", "resource"], additionalProperties: false, properties: { operation: { enum: ["zone_settings", "waf_target_binding", "waf_plan"] }, request_hash: string({ pattern: "^[a-f0-9]{64}$" }), event_cursor: string(), idempotent_replay: { const: true }, resource: { anyOf: [ref("CloudflareControl"), ref("CloudflareWafTargetResult"), ref("CloudflarePlan")] } }, description: "The exact committed snapshot of a retired local control write, matched to the original Principal, fixed operation route and request key. It is historical evidence and does not assert current provider state." },
  CloudflareWafProofTarget: { type: "object", required: ["account_id", "worker_name", "database_id", "instance_id", "preferred_api_origin", "origin_version"], additionalProperties: false, properties: { account_id: string({ maxLength: 128 }), worker_name: string({ maxLength: 63 }), database_id: ref("Uuid"), instance_id: ref("Uuid"), preferred_api_origin: string({ format: "uri", maxLength: 2048 }), origin_version: ref("Version") } },
  CloudflareWafProofRequest: { type: "object", required: ["nonce", "expires_at", "target"], additionalProperties: false, properties: { nonce: string({ pattern: "^[a-f0-9]{64}$", writeOnly: true }), expires_at: integer({ minimum: 1 }), target: ref("CloudflareWafProofTarget") } },
  CloudflareWafProofResponse: { type: "object", required: ["proof"], additionalProperties: false, properties: { proof: string({ pattern: "^[a-f0-9]{64}$", description: "Transient response-labelled HMAC; never journal, log or expose through ordinary API tools." }) } },
  CloudflarePlan: { type: "object", required: ["plan_id", "kind", "version", "baseline_version_id", "baseline_deployment_id", "target", "before", "after", "created_at"], additionalProperties: false, allOf: [{ if: { properties: { kind: { const: "waf" } }, required: ["kind"] }, then: { properties: { after: ref("CloudflareWafAfter"), target: { required: ["instance_id", "hostname", "zone_id", "domain_id"], properties: { instance_id: ref("Uuid"), hostname: string({ maxLength: 253 }), zone_id: string({ maxLength: 128 }), domain_id: string({ maxLength: 128 }) } } } } }], properties: { plan_id: ref("Uuid"), kind: string({ enum: ["configuration", "rate_limit", "waf"] }), version: ref("Version"), baseline_version_id: nullableString(), baseline_deployment_id: nullableString(), target: { type: "object", required: ["account_id", "worker_name", "database_id"], additionalProperties: false, properties: { account_id: string({ maxLength: 128 }), worker_name: string({ maxLength: 63 }), database_id: ref("Uuid"), instance_id: ref("Uuid"), hostname: string({ maxLength: 253 }), zone_id: string({ maxLength: 128 }), domain_id: string({ maxLength: 128 }) } }, before: { type: "object", additionalProperties: true }, after: { type: "object", additionalProperties: true }, created_at: ref("Timestamp") } },
  CloudflareVerifyRequest: { type: "object", properties: { include_optional: { type: "boolean", default: false, deprecated: true, description: "Accepted for older clients. Only configuration and analytics are checked; WAF, Billing and Notifications are retired and do not trigger provider requests." } }, additionalProperties: false },
  UpdateCloudflareSettingsRequest: { type: "object", required: ["zone_id", "expected_version"], properties: { zone_id: nullableString({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }), expected_version: ref("Version") }, additionalProperties: false },
  SaveCloudflareSecretRequest: { type: "object", required: ["kind", "token", "expected_version"], additionalProperties: false, properties: { kind: string({ enum: ["connection", "configuration", "control", "analytics"], description: "connection saves CFKANBAN_API_TOKEN using the supplied token for preflight and self-save. Legacy kinds remain compatible; connection operations retain configuration_secret kind." }), token: string({ minLength: 32, maxLength: 4096, pattern: "^[!-~]+$", writeOnly: true, description: "Transient browser-only secret input. Never persist in ordinary CLI files, drafts or operation journals." }), expected_version: ref("Version") } },
  PlanCloudflareRateLimitsRequest: { type: "object", required: ["scope", "limit", "period_seconds", "expected_version"], additionalProperties: false, properties: { scope: string({ enum: ["instance", "principal", "unauthenticated_sensitive", "anonymous_login", "expensive_reads"] }), limit: integer({ minimum: 1, maximum: 1000000 }), period_seconds: integer({ enum: [10, 60] }), expected_version: ref("Version") } },
  CloudflareRateLimitInput: { type: "object", required: ["limit", "period_seconds"], additionalProperties: false, properties: { limit: integer({ minimum: 1, maximum: 9007199254740991 }), period_seconds: integer({ enum: [10, 60] }) } },
  CloudflareRateLimitsInput: { type: "object", minProperties: 1, additionalProperties: false, properties: Object.fromEntries(["instance", "principal", "unauthenticated_sensitive", "anonymous_login", "expensive_reads"].map(scope => [scope, ref("CloudflareRateLimitInput")])), description: "The requested access-frequency scopes in this single configuration change. Unspecified scopes retain their current values and namespace IDs." },
  PlanCloudflareConfigurationRequest: { type: "object", required: ["settings", "expected_version"], additionalProperties: false, properties: { settings: { type: "object", minProperties: 1, additionalProperties: false, properties: { history_enabled: { type: "boolean" }, analytics_enabled: { type: "boolean" }, billing_plan: { enum: ["free", "paid", null] }, billing_cycle_day: { type: ["integer", "null"], minimum: 1, maximum: 31 }, account_totals: { type: "boolean" }, rate_limits: ref("CloudflareRateLimitsInput") }, description: "At least one usage setting or access-frequency scope is required. All supplied fields form one configuration plan. Budget notifications are retired; warning_percent is read-compatible only and cannot be configured." }, expected_version: ref("Version") } },
  ApplyCloudflarePlanRequest: { type: "object", required: ["plan_id", "expected_version"], additionalProperties: false, properties: { plan_id: ref("Uuid"), expected_version: ref("Version") } },
  CloudflareControlWriteResult: containerWriteResult("CloudflareControl"),
  CloudflarePlanWriteResult: containerWriteResult("CloudflarePlan"),
  CloudflareOperationWriteResult: containerWriteResult("CloudflareOperation"),
  UsageMetric: {
    type: "object",
    required: ["key", "value", "unit", "source", "scope", "period_start", "period_end", "observed_at"],
    properties: {
      key: string({ enum: ["d1_storage_bytes", "d1_rows_read", "d1_rows_written", "r2_storage_bytes", "r2_objects", "r2_operations", "d1_billing_rows_read", "d1_billing_rows_written", "workers_requests", "workers_cpu_microseconds", "r2_class_a_operations", "r2_class_b_operations", "r2_unclassified_operations", "workers_daily_requests", "workers_daily_cpu_microseconds", "r2_daily_class_a_operations", "r2_daily_class_b_operations", "r2_daily_unclassified_operations"] }),
      value: { type: ["number", "null"], minimum: 0 },
      unit: string({ enum: ["bytes", "count", "microseconds"] }),
      source: { const: "cloudflare" },
      scope: string({ enum: ["instance", "account"] }),
      period_start: { anyOf: [ref("Timestamp"), { type: "null" }] },
      period_end: { anyOf: [ref("Timestamp"), { type: "null" }] },
      observed_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
    },
    additionalProperties: false,
  },
  Usage: {
    type: "object",
    required: ["generated_at", "attachments", "cloudflare", "public_access"],
    properties: {
      generated_at: ref("Timestamp"),
      attachments: {
        type: "object", required: ["enabled", "reserved_bytes", "limit_bytes", "limit_configured", "settings_version"],
        properties: { enabled: { type: "boolean" }, reserved_bytes: integer({ minimum: 0 }), limit_bytes: { type: ["integer", "null"], minimum: 1, maximum: 9007199254740991 }, limit_configured: { type: "boolean" }, settings_version: ref("Version") },
        additionalProperties: false,
      },
      public_access: {
        type: "object", required: ["status", "hostname", "mode", "waf_profile", "verified_at", "live_verified"], additionalProperties: false,
        description: "Non-secret last-deployment declaration, never a live Cloudflare control-plane health check.",
        properties: {
          status: string({ enum: ["not_configured", "configured", "invalid"] }),
          hostname: { type: ["string", "null"], maxLength: 253 },
          mode: { enum: ["custom_domain", null] },
          waf_profile: { enum: ["disabled", "anonymous-api-filter", null] },
          verified_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
          live_verified: { const: false },
        },
      },
      cloudflare: {
        type: "object", required: ["status", "refreshing", "collected_at", "attempted_at", "error", "metrics", "billing", "alerts"],
        properties: {
          refreshing: { type: "boolean" },
          status: string({ enum: ["not_configured", "pending", "fresh", "stale", "error"] }),
          collected_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
          attempted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
          error: { type: ["string", "null"], maxLength: 64 },
          metrics: { type: "array", maxItems: 32, items: ref("UsageMetric") },
          billing: {
            type: "object", required: ["plan", "cycle_day", "period_start", "period_end", "account_totals_enabled", "warning_percent", "r2_standard_only_scope", "allowances_shared", "analytics_not_invoice"], additionalProperties: false,
            properties: {
              plan: string({ enum: ["free", "paid", "unknown"] }), cycle_day: { type: ["integer", "null"], minimum: 1, maximum: 31 },
              period_start: { anyOf: [ref("Timestamp"), { type: "null" }] }, period_end: { anyOf: [ref("Timestamp"), { type: "null" }] },
              account_totals_enabled: { type: "boolean" }, warning_percent: integer({ minimum: 1, maximum: 100 }),
              r2_standard_only_scope: string({ enum: ["unknown", "instance", "account"] }),
              allowances_shared: { const: true }, analytics_not_invoice: { const: true },
            },
          },
          alerts: { type: "array", maxItems: 16, items: {
            type: "object", required: ["metric_key", "scope", "level", "value", "allowance", "percent", "period_start", "period_end"], additionalProperties: false,
            description: "Fresh analytic contribution to a shared account allowance; not a remaining balance or billing cap.",
            properties: { metric_key: string({ maxLength: 64 }), scope: string({ enum: ["instance", "account"] }), level: string({ enum: ["warning", "reached"] }), value: { type: "number", minimum: 0 }, allowance: { type: "number", exclusiveMinimum: 0 }, percent: { type: "number", minimum: 0 }, period_start: ref("Timestamp"), period_end: ref("Timestamp") },
          } },
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
      editable_via_api: { type: "boolean", description: "Whether the fixed deployment target and configuration Secret are present. Actual apply still verifies current Owner and Cloudflare permissions." },
      cost_protection: {
        type: "object", required: ["anonymous_login", "expensive_reads", "concurrency", "observation_scope", "billing_cap"], additionalProperties: false,
        properties: {
          ...Object.fromEntries(["anonymous_login", "expensive_reads"].map(key => [key, { type: "object", required: ["enabled", "policy"], additionalProperties: false, properties: { enabled: { type: "boolean" }, policy: { anyOf: [{ type: "null" }, { type: "object", required: ["limit", "period_seconds"], additionalProperties: false, properties: { limit: integer({ minimum: 1 }), period_seconds: integer({ enum: [10, 60] }) } }] } } }])),
          concurrency: { type: "object", required: ["enabled", "per_principal", "per_isolate"], additionalProperties: false, properties: { enabled: { type: "boolean" }, per_principal: { const: 2 }, per_isolate: { const: 32 } } },
          observation_scope: { const: "worker_isolate_best_effort" }, billing_cap: { const: false },
        },
      },
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
  Meta: { type: "object", required: ["service_version", "schema_version"], properties: { release_version: string(), service_version: string(), schema_version: integer({ minimum: 1 }), capabilities: { type: "object", properties: { project_milestones: { type: "boolean" }, issue_trends: { type: "boolean" }, attachments: { type: "boolean" }, browser_launch: { type: "boolean" }, fixed_workflow: { type: "boolean" }, issue_reference: { type: "boolean" }, issue_search_index: { type: "boolean" }, passkey: { type: "boolean" }, public_join: { type: "boolean" } }, additionalProperties: true } }, additionalProperties: true },
  Health: { type: "object", required: ["service_version", "schema_version", "d1"], properties: { service_version: string(), release_version: string({ description: "Product release of the executing Worker build; independent of service/API compatibility version." }), schema_version: integer({ minimum: 1 }), d1: string({ enum: ["reachable", "unavailable"] }) }, additionalProperties: false },
  InstanceDiscovery: { type: "object", required: ["discovery_version", "instance_id", "service_version", "observed_origin", "preferred_api_origin", "origin_version", "updated_at"], properties: { capabilities: { type: "object", properties: { issue_trends: { type: "boolean", description: "True when authorized UTC Project, Workspace and milestone Issue trends are supported; missing or false is unsupported." }, project_milestones: { type: "boolean", description: "True when optional Project milestones and Issue membership are supported." }, issue_reference: { type: "boolean", description: "True only when this Worker supports the bounded Issue reference endpoint. Absence or false is unsupported; a route 404 alone cannot prove a missing Issue." }, issue_search_index: { type: "boolean", description: "True when metadata search status, snapshot and changes endpoints are available; clients must not use ordinary full Issue lists as a fallback." } }, additionalProperties: true }, homepage_notice: ref("PublicHomepageNotice"), discovery_version: integer({ const: 1 }), instance_id: string({ minLength: 1 }), service_version: string(), release_version: string({ description: "Product release of the executing Worker build; independent of service/API compatibility version." }), observed_origin: string({ format: "uri", pattern: "^https://[^/?#]+$" }), preferred_api_origin: string({ format: "uri", pattern: "^https://[^/?#]+$" }), origin_version: ref("Version"), updated_at: ref("Timestamp") }, additionalProperties: false },
  IssueLabelSummary: {
    type: "object",
    required: ["color", "id", "name"],
    properties: { color: nullableString({ pattern: "^#[0-9A-Fa-f]{6}$" }), id: ref("Uuid"), name: string() },
    additionalProperties: false,
  },
  IssueParentSummary: {
    type: "object",
    required: ["id", "identifier", "project_id", "status", "title", "workspace_id"],
    properties: {
      id: ref("Uuid"),
      identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }),
      project_id: ref("Uuid"),
      status: {
        type: "object",
        required: ["display_name", "key"],
        properties: { display_name: string(), key: ref("StatusKey") },
        additionalProperties: false,
      },
      title: string(),
      workspace_id: ref("Uuid"),
    },
    additionalProperties: false,
  },
  IssueHierarchy: {
    type: "object",
    description: "Optional read projection of visible, active direct parent relations. The relation direction is source child to target parent; multiple parents and historical cycles are preserved. New or restored cycle-closing parent relations are rejected atomically. Counts do not inherit the Issue list filters.",
    required: ["children", "parent_count", "parents"],
    properties: {
      children: {
        type: "object",
        required: ["done", "total"],
        properties: {
          done: integer({ minimum: 0, description: "Visible direct children whose status is done; canceled is not done." }),
          total: integer({ minimum: 0, description: "All visible, active direct children." }),
        },
        additionalProperties: false,
      },
      parent_count: integer({ minimum: 0, description: "Total visible, active direct parents, including summaries omitted by the ten-parent bound." }),
      parents: {
        type: "array",
        maxItems: 10,
        description: "First ten visible direct parents ordered by their stable Issue number. Further parents can be read through the existing Issue relations endpoint.",
        items: ref("IssueParentSummary"),
      },
    },
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
    required: ["author", "body", "completion", "created_at", "id", "kind", "version"],
    properties: {
      author: {
        type: "object",
        required: ["display_name", "principal_id"],
        properties: { display_name: string(), principal_id: ref("Uuid") },
        additionalProperties: false,
      },
      body: string({ description: "Comment text, or the completion summary (including an empty summary)." }),
      completion: {
        description: "Null for standard comments; the complete structured payload for completion comments. Context size limits omit whole comments instead of truncating this payload.",
        oneOf: [ref("CompletionPayload"), { type: "null" }],
      },
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
          assignees: { type: "array", maxItems: 20, items: { anyOf: [ref("Uuid"), { const: "unassigned" }] } },
          blocked: string({ enum: ["only", "exclude"] }),
          q_mode: string({ enum: ["typed"] }),
          q: { anyOf: [utf8String(128, { minLength: 1 }), { type: "null" }], description: "Normalized typed query; null when q is omitted. Legacy calls omit q and q_mode here." },
          statuses: { type: "array", maxItems: 5, items: ref("StatusKey") },
          priorities: { type: "array", maxItems: 5, items: ref("PriorityKey") },
          labels: { type: "array", maxItems: 20, items: ref("Uuid") },
          milestone: { anyOf: [ref("Uuid"), { const: "none" }] },
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
  IssueCountsResult: {
    type: "object",
    required: ["counts", "total_count", "resolved_scope"],
    properties: {
      counts: {
        type: "object",
        required: ["backlog", "todo", "in_progress", "done", "canceled"],
        properties: Object.fromEntries(["backlog", "todo", "in_progress", "done", "canceled"].map((key) => [key, integer({ minimum: 0 })])),
        additionalProperties: false,
      },
      total_count: integer({ minimum: 0 }),
      resolved_scope: ref("IssueResolvedScope"),
    },
    additionalProperties: false,
  },
  IssueTrendPoint: {
    type: "object",
    required: ["date", "total", "done", "canceled", "unfinished", "created", "completed", "reopened"],
    properties: {
      date: string({ format: "date" }),
      ...Object.fromEntries(["total", "done", "canceled", "unfinished", "created", "completed", "reopened"].map(key => [key, { anyOf: [integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), { type: "null" }] }])),
    },
    additionalProperties: false,
  },
  IssueTrendsResult: {
    type: "object",
    required: ["timezone", "from_date", "to_date", "observed_at", "scope", "projects", "points"],
    properties: {
      timezone: { const: "UTC" },
      from_date: string({ format: "date" }),
      to_date: string({ format: "date" }),
      observed_at: ref("Timestamp"),
      scope: { type: "object", required: ["workspace_id", "project_ids", "milestone_id"], properties: { workspace_id: ref("Uuid"), project_ids: { type: "array", maxItems: 100, uniqueItems: true, items: ref("Uuid") }, milestone_id: { anyOf: [ref("Uuid"), { type: "null" }] } }, additionalProperties: false },
      projects: { type: "array", maxItems: 100, items: { type: "object", required: ["id", "display_name", "stock_from", "flow_from", "history_state"], properties: { id: ref("Uuid"), display_name: string(), stock_from: { anyOf: [string({ format: "date" }), { type: "null" }] }, flow_from: { anyOf: [string({ format: "date" }), { type: "null" }] }, history_state: string({ enum: ["pending", "complete", "partial"] }) }, additionalProperties: false } },
      points: { type: "array", minItems: 1, maxItems: 365, items: ref("IssueTrendPoint") },
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
  IssueMentionReference: {
    type: "object",
    required: Object.keys(issueMentionReferenceProperties),
    properties: issueMentionReferenceProperties,
    additionalProperties: false,
    description: "Exact Issue reference metadata. At most 4 KiB of serialized UTF-8 JSON; no body, comments, relations, labels or hierarchy are fetched.",
  },
  SearchIndexDocument: {
    type: "object", required: ["id", "number", "identifier", "title", "project_id", "revision"],
    properties: { id: ref("Uuid"), number: integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }), title: utf8String(1024), project_id: ref("Uuid"),
      revision: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Independent per-Issue search revision; body and Comment changes do not increment it." }) },
    additionalProperties: false,
  },
  SearchIndexChange: {
    type: "object", required: ["kind", "id", "number", "identifier", "title", "project_id", "revision"],
    properties: { kind: string({ enum: ["upsert", "remove"] }), id: ref("Uuid"), number: integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      identifier: string({ pattern: "^CFK-[1-9][0-9]*$" }), title: utf8String(1024), project_id: ref("Uuid"),
      revision: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, additionalProperties: false,
    description: "Metadata update or tombstone. A remove carries an empty title. Revision prevents a late update from overwriting a newer snapshot.",
  },
  SearchIndexStatus: {
    type: "object", required: ["instance_id", "projection_version", "epoch", "scope_key", "projects"],
    properties: { instance_id: ref("Uuid"), projection_version: integer({ const: 1 }), epoch: string(), scope_key: string(),
      projects: { type: "array", items: { type: "object", required: ["id", "display_name", "workspace", "revision", "cursor"],
        properties: { id: ref("Uuid"), display_name: string(), workspace: { type: "object", required: ["id", "display_name"],
          properties: { id: ref("Uuid"), display_name: string() }, additionalProperties: false },
          revision: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), cursor: string({ maxLength: 4096 }) }, additionalProperties: false } } },
    additionalProperties: false,
    description: "Live authorized Project catalog and lightweight search heads. Newly authorized Projects require a full metadata snapshot before incremental updates. Project-scoped cursors remain valid when unrelated Projects change authorization.",
  },
  SearchIndexSnapshot: {
    type: "object", required: ["items", "has_more", "next_cursor"], properties: {
      items: { type: "array", maxItems: 100, items: ref("SearchIndexDocument") }, has_more: { type: "boolean" }, next_cursor: string({ maxLength: 4096 }) },
    additionalProperties: false,
    description: "Stable-number scan after a starting watermark; not a cross-request point-in-time snapshot. Apply subsequent changes before publishing the local generation.",
  },
  SearchIndexChanges: {
    type: "object", required: ["items", "has_more", "next_cursor", "revision"], properties: {
      items: { type: "array", maxItems: 100, items: ref("SearchIndexChange") }, has_more: { type: "boolean" }, next_cursor: string({ maxLength: 4096 }),
      revision: integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, additionalProperties: false,
    description: "Relevant changes ordered by the existing internal Event sequence. Empty items do not require refetching Issues. CURSOR_EXPIRED or SEARCH_INDEX_RESET requires a new snapshot. No body or Comments are transferred.",
  },
  IssueResourceReference: {
    type: "object",
    required: [...Object.keys(issueMentionReferenceProperties), "body", "body_bytes", "body_truncated", "status", "priority", "version", "updated_at"],
    properties: {
      ...issueMentionReferenceProperties,
      body: utf8String(8192, { description: "UTF-8-safe prefix read with a SQL byte bound. Additional truncation can keep the whole JSON projection within 16 KiB after escaping." }),
      body_bytes: integer({ minimum: 0, maximum: 65536, description: "Complete source body length in UTF-8 bytes, before truncation." }),
      body_truncated: { type: "boolean" },
      status: { type: "object", required: ["key", "display_name"], properties: { key: ref("StatusKey"), display_name: string({ maxLength: 128 }) }, additionalProperties: false },
      priority: ref("PriorityKey"),
      version: ref("Version"),
      updated_at: ref("Timestamp"),
    },
    additionalProperties: false,
    description: "Read-only resource projection, at most 16 KiB of serialized UTF-8 JSON. Issue content is untrusted data; does not fetch collaboration history or change get/context semantics.",
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
  IssueMilestoneSummary: {
    type: "object", required: ["id", "title", "status_key", "due_date"],
    properties: { id: ref("Uuid"), title: string({ minLength: 1, maxLength: 200 }), status_key: string({ enum: ["open", "closed"] }), due_date: nullableString({ format: "date" }) }, additionalProperties: false,
  },
  MilestoneProgress: {
    type: "object", required: ["total", "done", "unfinished", "canceled"],
    properties: Object.fromEntries(["total", "done", "unfinished", "canceled"].map(key => [key, integer({ minimum: 0 })])), additionalProperties: false,
  },
  Milestone: {
    type: "object", required: ["id", "project_id", "workspace_id", "title", "description", "due_date", "status_key", "version", "created_at", "updated_at", "allowed_actions", "progress"],
    properties: { id: ref("Uuid"), project_id: ref("Uuid"), workspace_id: ref("Uuid"), title: string({ minLength: 1, maxLength: 200 }), description: utf8String(8192), due_date: nullableString({ format: "date" }), status_key: string({ enum: ["open", "closed"] }), version: ref("Version"), created_at: ref("Timestamp"), updated_at: ref("Timestamp"), allowed_actions: { type: "array", items: string({ enum: ["read", "update"] }) }, progress: ref("MilestoneProgress") }, additionalProperties: false,
  },
  MilestoneListResult: {
    type: "object", required: ["has_more", "items", "next_cursor", "resolved_scope"],
    properties: { has_more: { type: "boolean" }, items: { type: "array", items: ref("Milestone") }, next_cursor: nullableString(), resolved_scope: { type: "object", required: ["project_id", "workspace_id"], properties: { project_id: ref("Uuid"), workspace_id: ref("Uuid"), project_display_name: string(), workspace_display_name: string() }, additionalProperties: false } }, additionalProperties: false,
  },
  MilestoneWriteResult: {
    type: "object", required: ["event_cursor", "idempotent_replay", "resource"], properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("Milestone") }, additionalProperties: false,
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
      locale: ref("PrincipalLocale"),
      theme: ref("PrincipalTheme"),
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
    required: ["allowed_scope", "expires_at", "principal", "session_id", "source", "target", "management_grants", "version", "renewal"],
    properties: {
      management_grants: { type: "array", items: ref("Administrator") },
      allowed_scope: ref("WebSessionAllowedScope"),
      expires_at: ref("Timestamp"),
      principal: {
        allOf: [
          ref("WebSessionPrincipal"),
          { type: "object", required: ["locale", "theme", "version"], properties: { locale: ref("PrincipalLocale"), theme: ref("PrincipalTheme"), version: ref("Version") } },
        ],
      },
      session_id: ref("Uuid"),
      source: ref("WebSessionSource"),
      target: ref("WebSessionTarget"),
      version: ref("Version"),
      renewal: ref("WebSessionRenewalMetadata"),
    },
    additionalProperties: false,
  },
  WebSessionRenewalMetadata: {
    type: "object",
    required: ["renew_after", "absolute_expires_at"],
    properties: { renew_after: ref("Timestamp"), absolute_expires_at: ref("Timestamp") },
    additionalProperties: false,
  },
  WebSessionRenewalResource: {
    type: "object",
    required: ["session_id", "version", "expires_at", "renew_after", "absolute_expires_at", "renewed"],
    properties: {
      session_id: ref("Uuid"), version: ref("Version"), expires_at: ref("Timestamp"),
      renew_after: ref("Timestamp"), absolute_expires_at: ref("Timestamp"), renewed: { type: "boolean" },
    },
    additionalProperties: false,
  },
  WebSessionRenewalWriteResult: {
    type: "object",
    required: ["event_cursor", "idempotent_replay", "resource"],
    properties: { event_cursor: string(), idempotent_replay: { type: "boolean" }, resource: ref("WebSessionRenewalResource") },
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
    required: ["allowed_actions", "created_at", "deleted_at", "device_name", "fingerprint", "id", "issued_at", "last_used_at", "principal", "principal_id", "revoke_reason", "revoked_at", "updated_at", "version"],
    properties: {
      allowed_actions: { type: "array", items: string({ enum: ["revoke", "revoke_owner_device", "rename_owner_device"] }), description: "Owner devices only expose revoke_owner_device when active, not the caller's Bearer or Agent Session source Credential, and another active Owner API Credential remains. Every active Owner device exposes rename_owner_device, including the caller and last active device. Generic revoke never applies to Owner Credentials." },
      created_at: ref("Timestamp"),
      deleted_at: { anyOf: [ref("Timestamp"), { type: "null" }] },
      device_name: { anyOf: [string({ maxLength: 80 }), { type: "null" }] },
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
  CloudflareLocalOperationQuery: [{ name: "operation", in: "query", required: true, schema: { enum: ["zone_settings", "waf_target_binding", "waf_plan"] } }],
  UsageHistoryQuery: [{ name: "days", in: "query", required: false, schema: integer({ minimum: 1, maximum: 90, default: 30 }) }],
  NotificationCursorQuery: [
    { name: "cursor", in: "query", required: false, schema: string() },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 50, default: 20 }) },
  ],
  PersonalNotificationQuery: [
    { name: "pending", in: "query", required: false, schema: string({ enum: ["true", "false"], default: "false" }) },
    { name: "cursor", in: "query", required: false, schema: string() },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 50, default: 20 }) },
  ],
  AssigneeNameQuery: [{ name: "display_name", in: "query", required: false, schema: ref("PrincipalDisplayNameInput"), description: "Optional normalized exact match returning zero or one candidate; omission lists current Project Owner, administrators and writers. Only principal_id and display_name are exposed; readers are excluded. Requires Project read access and respects Browser Session scope." }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  InviteCodeQuery: [{ name: "code", in: "query", required: true, schema: string({ minLength: 1 }), description: "一次性 Invite code。" }],
  LaunchCodeQuery: [{ name: "code", in: "query", required: true, schema: string({ minLength: 59, maxLength: 59, pattern: "^cfl_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$" }), description: "一次性 Browser Launch code；GET 不消费该 code。" }],
  EventQuery: [
    { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true },
    { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true },
    { name: "order", in: "query", required: false, schema: string({ enum: ["asc", "desc"], default: "asc" }), description: "asc preserves the incremental sequence feed and write cursors; desc reads history by created_at descending with sequence as tie-breaker. Descending cursors bind the initial sequence upper bound; start a fresh read to see later events." },
    { name: "after", in: "query", required: false, schema: string(), description: "Opaque cursor for the same order and scope. Write cursors are accepted only in the default ascending feed." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) },
  ],
  SearchIndexStatusQuery: [
    { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: ref("Uuid") }, style: "form", explode: true },
    { name: "allow_unfiltered", in: "query", required: false, schema: { type: "boolean", default: false }, description: "Explicitly select the currently authorized scope when project filters are absent. Does not grant access or expand Cookie Session targets." },
  ],
  SearchIndexSnapshotQuery: [
    { name: "project", in: "query", required: true, schema: ref("Uuid") },
    { name: "cursor", in: "query", required: true, schema: string({ minLength: 1, maxLength: 4096 }), description: "Initial cursor from status or next_cursor from the preceding snapshot page. Complete the scan then use the cursor with changes." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 100 }) },
  ],
  SearchIndexChangesQuery: [
    { name: "project", in: "query", required: true, schema: ref("Uuid") },
    { name: "after", in: "query", required: true, schema: string({ minLength: 1, maxLength: 4096 }), description: "Opaque project cursor; independent of unrelated Project authorization changes. Expired cursors require a complete metadata snapshot." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 100 }) },
  ],
  AuditEventQuery: [
    { name: "project_id", in: "query", required: false, schema: ref("Uuid"), description: "Restrict the Owner audit feed to events bound to one immutable Project ID." },
    { name: "stream", in: "query", required: false, schema: string({ enum: ["domain", "security"] }), description: "Restrict the Owner audit feed to one event stream; omission reads both streams." },
    { name: "order", in: "query", required: false, schema: string({ enum: ["asc", "desc"], default: "asc" }), description: "asc preserves sequence order and existing cursors; desc reads history by created_at descending with sequence as tie-breaker and an initial sequence upper bound." },
    { name: "after", in: "query", required: false, schema: string(), description: "Opaque Owner audit cursor bound to the same order, Project and streams." },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) },
  ],
  InvitationListQuery: [{ name: "project_id", in: "query", required: false, schema: ref("Uuid"), description: "Filter to Invitations containing this Project. Every target must still be manageable by the current Principal; partial visibility never reveals an Invitation." }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  AdministratorCandidateQuery: [
    { name: "q", in: "query", required: false, schema: string({ maxLength: 100 }), description: "Optional normalized display name substring." },
    { name: "cursor", in: "query", required: false, schema: string() },
    { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) },
  ],
  MilestoneListQuery: [{ name: "status", in: "query", required: false, schema: string({ enum: ["open", "closed"] }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  CursorQuery: [{ name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  DeletedModeQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }],
  DeletedCursorQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  IssueListQuery: [{ name: "priority", in: "query", required: false, schema: { type: "array", maxItems: 5, items: ref("PriorityKey") }, style: "form", explode: true, description: "Match any selected priority; combined with other dimensions using AND." }, { name: "label", in: "query", required: false, schema: { type: "array", maxItems: 20, items: ref("Uuid") }, style: "form", explode: true, description: "Match any selected active Project Label ID before pagination; unknown, deleted or inaccessible Labels do not match." }, { name: "blocked", in: "query", required: false, schema: string({ enum: ["only", "exclude"] }), description: "Filter by the caller-visible blocked projection before pagination; omission includes both blocked and unblocked Issues." }, { name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }, { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "status", in: "query", required: false, schema: { type: "array", maxItems: 5, items: ref("StatusKey") }, style: "form", explode: true }, { name: "assignee", in: "query", required: false, description: "Match any selected Principal UUID or the unassigned sentinel, independently of status.", schema: { type: "array", maxItems: 20, items: { anyOf: [ref("Uuid"), { const: "unassigned" }] } }, style: "form", explode: true }, { name: "q", in: "query", required: false, schema: utf8String(128, { minLength: 1, description: "Normalized title/identifier search." }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  IssueDetailQuery: [{ name: "deleted", in: "query", required: false, schema: string({ enum: ["exclude", "only"], default: "exclude" }) }],
  IssueReferenceQuery: [{ name: "projection", in: "query", required: false, schema: string({ enum: ["mention", "resource"], default: "mention" }), description: "Exact identifier point lookup: mention returns only resource identity and container names; resource adds bounded body and current status, priority, version and timestamp. Live reader authorization and Cookie Session scope apply; deleted or inaccessible resources are not found." }],
  CandidateListQuery: [{ name: "priority", in: "query", required: false, schema: { type: "array", maxItems: 5, items: ref("PriorityKey") }, style: "form", explode: true, description: "Match any selected priority; combined with other dimensions using AND." }, { name: "label", in: "query", required: false, schema: { type: "array", maxItems: 20, items: ref("Uuid") }, style: "form", explode: true, description: "Match any selected active Project Label ID before pagination; unknown, deleted or inaccessible Labels do not match." }, { name: "assignment", in: "query", required: true, schema: string({ enum: ["unassigned", "mine", "needs_reassignment"] }) }, { name: "blocked", in: "query", required: false, schema: string({ enum: ["exclude", "include"], default: "exclude" }) }, { name: "project", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "workspace", in: "query", required: false, schema: { type: "array", maxItems: 20, items: string() }, style: "form", explode: true }, { name: "q", in: "query", required: false, schema: utf8String(128, { minLength: 1, description: "Normalized title/identifier search." }) }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  PrincipalListQuery: [{ name: "q", in: "query", required: false, schema: string({ maxLength: 128 }) }, { name: "project_id", in: "query", required: false, schema: ref("Uuid") }, { name: "cursor", in: "query", required: false, schema: string() }, { name: "limit", in: "query", required: false, schema: integer({ minimum: 1, maximum: 100, default: 20 }) }],
  RelationDeleteQuery: [],
};
for (const name of ["IssueListQuery", "CandidateListQuery"]) querySets[name].push({ name: "q_mode", in: "query", required: false, schema: string({ enum: ["typed"] }), description: "Opt in to typed title/number-prefix search. NFKC and case-insensitive; bare numbers need two digits, titles two Unicode characters, complete CFK-1 is accepted. Numeric input matches number prefixes only. Omission preserves legacy exact-identifier OR title-substring q semantics." });
for (const name of ["IssueListQuery", "CandidateListQuery"]) querySets[name].push({ name: "milestone", in: "query", required: false, schema: { anyOf: [ref("Uuid"), { const: "none" }] }, description: "Match one Project milestone or only Issues without a milestone; combined with other dimensions using AND before pagination." });
querySets.IssueCountsQuery = querySets.IssueListQuery.filter(({ name }) => !["deleted", "cursor", "limit"].includes(name));
const trendDays = { name: "days", in: "query", required: false, schema: integer({ minimum: 1, maximum: 365, default: 30 }), description: "UTC calendar days including the unfinished current day. Only one days parameter is accepted." };
querySets.ProjectIssueTrendsQuery = [trendDays, { name: "milestone", in: "query", required: false, schema: ref("Uuid"), description: "Optional single milestone in this Project. Historical scope follows membership on each day; not the current membership applied retrospectively." }];
querySets.WorkspaceIssueTrendsQuery = [trendDays, { name: "project", in: "query", required: false, schema: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: ref("Uuid") }, style: "form", explode: true, description: "Optional repeated exact Project UUIDs in this Workspace. Omission uses currently readable active Projects intersected with the authenticated Session scope. Explicit inaccessible targets are rejected." }];

const operationResponseSchemas = {
  getNotificationPreferences: ref("NotificationPreferences"),
  updateNotificationPreferences: ref("NotificationPreferencesWriteResult"),
  listMyNotifications: ref("InstanceNotificationList"),
  listInstanceNotifications: ref("InstanceNotificationList"),
  publishNotification: ref("InstanceNotificationWriteResult"),
  withdrawNotification: ref("InstanceNotificationWriteResult"),
  acknowledgeNotification: ref("InstanceNotificationWriteResult"),
  getUpgradeNotificationSettings: ref("UpgradeNotificationSettings"),
  updateUpgradeNotificationSettings: ref("UpgradeNotificationSettingsWriteResult"),
  publishUpgradeNotification: ref("UpgradeNotificationWriteResult"),
  getUpgradeNotificationRelease: ref("UpgradeNotificationRelease"),
  getMe: ref("CurrentPrincipal"),
  listWorkspaceAdministratorCandidates: ref("AdministratorCandidateListResult"),
  listProjectAdministratorCandidates: ref("AdministratorCandidateListResult"),
  listWorkspaceAdministrators: ref("AdministratorListResult"),
  listProjectAdministrators: ref("AdministratorListResult"),
  addOwnerDeviceCredential: ref("OwnerDeviceWriteResult"),
  revokeOwnerDeviceCredential: ref("OwnerDeviceWriteResult"),
  renameOwnerDeviceCredential: ref("OwnerDeviceWriteResult"),
  createWorkspaceAdministrator: ref("AdministratorWriteResult"),
  createProjectAdministrator: ref("AdministratorWriteResult"),
  revokeWorkspaceAdministrator: ref("AdministratorWriteResult"),
  revokeProjectAdministrator: ref("AdministratorWriteResult"),
  listProjectMembers: ref("EffectiveMemberListResult"),
  listProjectMemberCandidates: ref("ProjectMemberCandidateListResult"),
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
  getHomepageSettings: ref("HomepageSettings"),
  getReleaseUpdates: ref("ReleaseUpdates"),
  updateHomepageSettings: ref("HomepageSettingsWriteResult"),
  getAttachmentSettings: ref("AttachmentSettings"),
  updateAttachmentSettings: ref("AttachmentSettingsWriteResult"),
  getUsage: ref("Usage"),
  refreshUsage: ref("Usage"),
  getRateLimitSettings: ref("RateLimitSettings"),
  getUsageHistory: ref("UsageHistory"), collectUsageHistory: ref("UsageHistory"),
  getCloudflareControl: ref("CloudflareControl"),
  getCloudflareNotifications: ref("CloudflareNotifications"), getCloudflareWaf: { anyOf: [ref("CloudflareWafLocalState"), ref("CloudflareWaf")] },
  getCloudflareWafOperation: ref("CloudflareOperation"), registerCloudflareWafTarget: ref("CloudflareWafTargetWriteResult"), proveCloudflareWafOrigin: ref("CloudflareWafProofResponse"),
  getCloudflareOperation: ref("CloudflareOperation"), getCloudflareSecretOperation: ref("CloudflareOperation"), getCloudflareConfigurationOperation: ref("CloudflareOperation"), getCloudflareLocalOperation: ref("CloudflareLocalOperation"),
  getCloudflarePlan: ref("CloudflarePlan"),
  verifyCloudflareControl: ref("CloudflareControlWriteResult"), updateCloudflareSettings: ref("CloudflareControlWriteResult"),
  saveCloudflareSecret: ref("CloudflareOperationWriteResult"), verifyCloudflareOperation: ref("CloudflareOperationWriteResult"),
  planCloudflareWaf: ref("CloudflarePlanWriteResult"), applyCloudflareWaf: ref("CloudflareOperationWriteResult"),
  planCloudflareRateLimits: ref("CloudflarePlanWriteResult"), planCloudflareConfiguration: ref("CloudflarePlanWriteResult"),
  applyCloudflareRateLimits: ref("CloudflareOperationWriteResult"), applyCloudflareConfiguration: ref("CloudflareOperationWriteResult"),
  redeemPublicJoin: ref("PublicJoinRedemptionWriteResult"),
  createWebLaunch: ref("BrowserLaunchWriteResult"),
  redeemWebLaunch: ref("WebSessionExchangeWriteResult"),
  getWebSession: ref("WebSessionView"),
  renewWebSession: ref("WebSessionRenewalWriteResult"),
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
  getSearchIndexStatus: ref("SearchIndexStatus"),
  listSearchIndexSnapshot: ref("SearchIndexSnapshot"),
  listSearchIndexChanges: ref("SearchIndexChanges"),
  listAuditEvents: ref("AuditEventListResult"),
  listIssues: ref("IssueListResult"),
  listIssueCandidates: ref("ActiveIssueListResult"),
  listProjectIssues: ref("IssueListResult"),
  countProjectIssues: ref("IssueCountsResult"),
  getProjectIssueTrends: ref("IssueTrendsResult"),
  getWorkspaceIssueTrends: ref("IssueTrendsResult"),
  getIssue: { oneOf: [ref("IssueFullDetail"), ref("IssueTombstone")] },
  getIssueContext: ref("IssueContext"),
  getIssueReference: { oneOf: [ref("IssueMentionReference"), ref("IssueResourceReference")] },
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
  listMilestones: ref("MilestoneListResult"),
  getMilestone: ref("Milestone"),
  createMilestone: ref("MilestoneWriteResult"),
  updateMilestone: ref("MilestoneWriteResult"),
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
  // 个人资料更新和 Cookie Passkey 撤销保留原有的可选 header 兼容行为。
  if (mode.includes("idempotent") && !["updateMe", "revokeMyPasskey"].includes(operationId)) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });
  if (operationId === "updateMe") parameters.push({
    name: "Idempotency-Key", in: "header", required: false,
    description: "Optional safe retry key. Reuse the original key and request within 24 hours to recover a committed profile update; the current Principal must remain authenticated.",
    schema: string({ minLength: 1, maxLength: 128, pattern: "^[\\x20-\\x7E]+$" }),
  });
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
for (const [path, methods] of Object.entries(paths)) {
  if (path.startsWith("/api/v1/admin/cloudflare") || path.startsWith("/api/v1/admin/usage/history")) {
    for (const operation of Object.values(methods)) {
      operation.responses["200"].headers = noStoreHeader;
      operation.description = `${permissionDescriptions.deployment_owner} Cookie writes require CSRF. Cloudflare calls use fixed targets, bounded responses and timeouts. External control writes retain a durable non-secret intent; uncertain results are verified without repeating the external write. Cloudflare and D1 do not form an atomic transaction.`;
    }
  }
}
paths["/.well-known/cfkanban-waf-proof"].post["x-cfkanban-sensitive-input"] = "internal_waf_origin_proof";
paths["/.well-known/cfkanban-waf-proof"].post.responses["200"].headers = noStoreHeader;
paths["/.well-known/cfkanban-waf-proof"].post.description = permissionDescriptions.control_origin_proof + " Valid only for a random nonce and expiry within 10 seconds, exact current target and preferred origin. No business write, credentials or ordinary CLI input/output; invalid proofs return 404.";
paths["/api/v1/admin/cloudflare/waf/operations/{request_key}"].get.parameters[0].schema = ref("Uuid");
paths["/api/v1/admin/cloudflare/waf/apply"].post.parameters = paths["/api/v1/admin/cloudflare/waf/apply"].post.parameters.map(parameter => parameter.$ref === "#/components/parameters/IdempotencyKey" ? { name: "Idempotency-Key", in: "header", required: true, schema: ref("Uuid"), description: "Original UUID request key; retained for exact WAF intent lookup without repeating the provider write." } : parameter);
paths["/api/v1/admin/cloudflare/waf/operations/{request_key}"].get.description = "Owner-only D1 lookup of this Principal's original WAF apply intent, scoped to the exact apply route and original UUID key. No provider call or external write. A 404 does not establish that an in-flight request cannot commit.";
paths["/api/v1/admin/cloudflare/secrets"].post["x-cfkanban-sensitive-input"] = "browser_cloudflare_secret";
paths["/api/v1/admin/cloudflare/secrets"].post.description += " Token input is transient and persisted only as an ordinary Worker Secret. The generic Skill/CLI API path rejects this operation; use the protected Owner Web form.";
paths["/api/v1/admin/cloudflare/secret-operations/{request_key}"].get.parameters[0].schema = string({ minLength: 1, maxLength: 128, pattern: "^[\\x20-\\x7E]+$" });
paths["/api/v1/admin/cloudflare/secret-operations/{request_key}"].get.description = "Owner-only read of the original Secret-save intent identified by its non-secret Idempotency-Key, scoped to the current Principal and Secret-save route. Returns only operation metadata; no provider call or write is made. A 404 does not prove that an in-flight save cannot later commit and does not authorize another save.";
paths["/api/v1/admin/cloudflare/configuration/operations/{request_key}"].get.parameters[0].schema = string({ minLength: 1, maxLength: 128, pattern: "^[\\x20-\\x7E]+$" });
paths["/api/v1/admin/cloudflare/configuration/operations/{request_key}"].get.description = "Owner-only read of this Principal's original configuration apply intent by its non-secret Idempotency-Key and exact configuration apply route. Returns operation metadata without provider calls or writes. A 404 does not prove that an in-flight apply cannot later commit; retain the original request and key rather than issuing a replacement write.";
paths["/api/v1/admin/cloudflare/local-operations/{request_key}"].get.parameters[0].schema = string({ minLength: 1, maxLength: 128, pattern: "^[\\x20-\\x7E]+$" });
paths["/api/v1/admin/cloudflare/local-operations/{request_key}"].get.description = "Owner-only read of the original committed D1 snapshot for retired Zone settings, WAF target binding or WAF planning. The operation selector fixes the original method and route; lookup is scoped to the current Principal and original key. request_hash binds the canonical original request. No claim, audit write or provider call occurs. A committed snapshot remains readable even when its response cache was not finalized. Missing, uncommitted and expired records return 404, which never proves the original request did not commit and must not trigger replay.";
paths["/api/v1/admin/cloudflare/verify"].post.description += " Requests check configuration and analytics only. The legacy include_optional parameter is accepted without querying Notifications, Billing or WAF; those capabilities remain unsupported_contract. Permission results are invalidated when the configured Secret changes.";
paths["/api/v1/admin/cloudflare/configuration/plan"].post.description += " Usage settings and one or more rate_limits scopes form one frozen configuration plan. before/after retain the usage fields and include only the requested rate_limits scopes when present. A plan is a preview, not authorization to apply.";
paths["/api/v1/admin/cloudflare/configuration/apply"].post.description += " Apply the authorized frozen configuration plan with one Worker settings PATCH, preserving unrequested scopes and unrelated bindings. Existing flat configuration plans and their original-key recovery remain supported. Uncertain writes retain the original operation and are verified without another provider write.";
for (const [path, method] of [["/api/v1/admin/cloudflare/notifications", "get"], ["/api/v1/admin/cloudflare/settings", "patch"], ["/api/v1/admin/cloudflare/waf/target-binding", "post"]]) {
  paths[path][method].deprecated = true;
  paths[path][method].description += " Retired product feature. New requests return VALIDATION_ERROR with details.reason=cloudflare_feature_retired. Existing rules and historical operation records are preserved.";
}
for (const [path, method] of [["/api/v1/admin/cloudflare/waf", "get"], ["/api/v1/admin/cloudflare/waf/plan", "post"], ["/api/v1/admin/cloudflare/waf/apply", "post"]]) {
  paths[path][method].deprecated = true;
  paths[path][method].description += " Legacy WAF compatibility only. No new WAF enablement or target registration. Retain original request keys after uncertain results and use exact operation lookup/verify; neither a 404 nor feature retirement proves that the original write did not occur.";
}
paths["/api/v1/admin/cloudflare/waf/plan"].post.description += " Only disable plans for an existing, exactly owned rule remain available for legacy cleanup, including an explicitly authorized custom-domain rollback. Enable plans and unowned-rule cleanup are rejected.";
paths["/api/v1/admin/cloudflare/waf"].get.description += " Returns only local schema 27 target registration history with top-level unsupported_contract; target_binding.status may confirm the historical registration, but live_verified and service_proof are false. It makes no provider requests and does not claim active protection.";
paths["/api/v1/admin/cloudflare/waf/apply"].post.description += " Existing keys recover their original recorded result. A new apply is restricted to a reviewed disable plan for the same existing owned rule; no new enablement is dispatched.";
paths["/api/v1/admin/usage/history"].get.description = "Owner-only bounded D1 history read for 1–90 complete UTC days. No Cloudflare request; missing dates and null metrics are preserved. Analytics observations are not invoices.";
paths["/api/v1/admin/usage/history/collect"].post.description = "Owner-only opt-in derived history refresh for one of the last seven complete UTC days. Cookie requests require CSRF; no business domain event or Idempotency-Key is required. Shared claims and a 60-second retry cooldown bound provider calls. Paid daily metrics use this complete UTC day, not month-to-date totals.";
for (const [path, description] of [
  ["/api/v1/issues/{identifier}/relations", "Create one relation with both endpoint Issue versions, current writer access and idempotency. Parent means source child to target parent; multiple parents remain allowed. Parent insertion atomically rejects a cycle and fails closed beyond 1000 distinct ancestors, including the target. Validation follows all undeleted parent edges in the Workspace, including inaccessible or suspended intermediate endpoints; no path or hidden endpoint is disclosed. Historical cycles are preserved."],
  ["/api/v1/relations/{relation_id}/commands/restore", "Restore one deleted relation with relation and both endpoint CAS, current writer access and idempotency. Parent restoration performs the same atomic cycle and 1000-ancestor budget checks as creation. A cycle returns 409 RELATION_CYCLE with choose_different_parent; excessive scope returns 400 RELATION_GRAPH_TOO_LARGE with simplify_parent_graph and only the fixed max_ancestors=1000. Both are non-retryable."],
]) {
  paths[path].post.description = `${permissionDescriptions[paths[path].post["x-cfkanban-permission"]]} ${description}`;
  paths[path].post["x-cfkanban-parent-validation"] = {
    ancestor_limit: 1000,
    includes_target: true,
    cycle_error: { code: "RELATION_CYCLE", status: 409, recovery: "choose_different_parent", retryable: false },
    budget_error: { code: "RELATION_GRAPH_TOO_LARGE", status: 400, recovery: "simplify_parent_graph", retryable: false },
  };
}
paths["/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/counts"].get.description = "Read exact counts for all five fixed workflow statuses and their total within one active Project, using the same normalized filters and current authorization as the ordinary Issue list. Deleted Issues are excluded; deleted, cursor and limit parameters are rejected. Counts are aggregated by one SQL statement, do not load all Issue pages, and are independent of list request snapshots. Filtered counts may scan all matching candidates; no fixed rows-read cost is promised.";
paths["/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/counts"].get.responses["200"].headers = noStoreHeader;
for (const trendPath of ["/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/trends", "/api/v1/workspaces/{workspace_id}/issues/trends"]) {
  const operation = paths[trendPath].get;
  operation.description = "Read UTC daily Issue stock and flow in the exact returned scope under current Project authorization and Session scope. Parent and child Issues count independently. Stock excludes soft-deleted Issues; unfinished is backlog, todo and in_progress, with canceled separate from done. Flow counts original creation and transitions into done; completing again after reopening counts again. Restore and milestone membership changes are not creation or completion. The current day is partial through observed_at. Persisted history is backfilled where recoverable; unknown stock or flow is null, never fabricated zero. projects reports separate stock_from/flow_from and pending/complete/partial coverage. Workspace aggregate values are null when any included Project lacks that metric's coverage. Archived Projects are excluded and purged Projects cannot be recovered. No pagination or ordinary Issue filters are accepted; unknown parameters are rejected. Requires issue_trends capability; clients must not scan Issue lists to reconstruct history.";
  operation.responses["200"].headers = noStoreHeader;
  operation["x-cfkanban-additional-query-parameters"] = false;
}
paths["/api/v1/admin/owner-credentials/add-device"].post.description = "Owner Bearer or Owner admin Web Session only; Cookie requests require same-origin CSRF. Explicitly approve an Agent-generated non-secret pairing request for the same instance and Owner. Requires at least one active Owner API Credential and enforces the 100 active Credential limit atomically. Principal CAS, idempotency and security audit commit together. The new Agent must still verify its pending Credential locally; this is not an all-credentials-lost recovery endpoint.";
paths["/api/v1/admin/owner-credentials/{credential_id}/revoke"].post.description = "Owner Bearer or Owner admin Web Session only; Cookie requests require same-origin CSRF. Atomically revoke another Owner device and its derived Session/Launch capabilities with Principal CAS, idempotency and security audit. Reject the caller's Bearer Credential, an Agent Session's source Credential and the last active Owner API Credential. Passkey Sessions remain independent. Generic Credential DELETE and Owner rotation retain their separate restrictions.";
paths["/api/v1/admin/owner-credentials/{credential_id}/rename"].post.description = "Owner Bearer or Owner admin Web Session only; Cookie requests require same-origin CSRF. Set or change the display name of an exact active Owner Credential, including the caller's and last active device. Principal CAS, idempotency, the immutable result snapshot and security audit commit atomically. Does not rotate/revoke credentials or change secrets, fingerprints, Principal identity, sessions or permissions. Revoked and non-Owner targets are rejected.";
paths["/api/v1/me/passkeys"].get.description = "Bearer Credential or Cookie Session for the current Principal only. Lists only that Principal's Passkeys; browser registration remains a separate Cookie-only WebAuthn ceremony.";
paths["/api/v1/me/passkeys/{passkey_id}"].delete.description = "Bearer Credential or Cookie Session for the current Principal only; Cookie requests require same-origin CSRF. Require expected_version in the query. Bearer requires Idempotency-Key; Cookie may omit it for compatibility. When supplied, retry with the same key and expected_version to replay the immutable result. Revoking a Passkey invalidates only its derived Sessions, preserving API Credentials and grants.";
paths["/api/v1/me/passkeys/{passkey_id}"].delete.parameters.push({ name: "Idempotency-Key", in: "header", required: false, schema: string({ minLength: 1, maxLength: 128, pattern: "^[\\x20-\\x7E]+$" }), description: "Required for Bearer authentication; optional for existing Cookie clients. Supplied keys enforce strict idempotency with unchanged expected_version." });
paths["/api/v1/invitations/redeem"].post.description = "Redeem one Invitation with Idempotency-Key. A non-Owner Cookie Session can redeem only project_grant invitations as current_principal, with same-origin CSRF and every target inside its unchanged Session scope. A multi-Project invitation with any target outside a fixed Session scope is rejected atomically. Cookie cannot create an identity, recover a Principal or mint a Credential. Anonymous and Bearer modes retain their existing constraints.";
paths["/api/v1/invitations/redeem"].post.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/homepage-settings"].get.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/homepage-settings"].patch.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/homepage-settings"].get.description = "Owner instance control only; a project-scoped Owner Session and scoped administrators cannot read these settings.";
paths["/api/v1/admin/homepage-settings"].patch.description = "Owner instance control only. Update both public homepage translations with expected_version and Idempotency-Key; Cookie requests require CSRF. Trimmed empty strings become null and use locale/hostname fallback. CAS, idempotency snapshot and one security audit event commit atomically.";
for (const [path, method] of [
  ["/api/v1/me/notification-preferences", "get"], ["/api/v1/me/notification-preferences", "patch"],
  ["/api/v1/me/notifications", "get"], ["/api/v1/me/notifications/{notification_id}/commands/acknowledge", "post"],
  ["/api/v1/admin/notifications", "get"], ["/api/v1/admin/notifications", "post"],
  ["/api/v1/admin/notifications/{notification_id}/commands/withdraw", "post"],
  ["/api/v1/admin/upgrade-notification-settings", "get"], ["/api/v1/admin/upgrade-notification-settings", "patch"],
  ["/api/v1/admin/notifications/commands/publish-upgrade", "post"],
  ["/api/v1/admin/notifications/upgrade-releases/{release_version}", "get"],
]) paths[path][method].responses["200"].headers = noStoreHeader;
paths["/api/v1/me/notifications"].get.description = "Current Principal with any valid Bearer Credential or Web Session, including no Project grants. History excludes the publisher's own notifications and includes retained expired/withdrawn text. pending=true returns only enabled, active, unacknowledged notifications created at or after the Principal's join/re-enable cutoff. Bounded descending created_at/id pagination binds the Principal, view and pending preference version; mutable pending membership may remove rows between pages.";
paths["/api/v1/me/notification-preferences"].get.description = "Current Principal only; no Project grant required. Defaults to enabled=true, version=1, receive_after=Principal creation time without per-Principal fan-out writes.";
paths["/api/v1/me/notification-preferences"].patch.description = "Current Principal only; no Project grant required. Independent preference CAS, Idempotency-Key, current authentication, immutable snapshot and security audit commit atomically. Cookie requires CSRF. Only a disabled-to-enabled transition advances receive_after; repeated enabled=true preserves it.";
paths["/api/v1/me/notifications/{notification_id}/commands/acknowledge"].post.description = "Atomically acknowledge one non-self notification as the current Principal, shared by Web and Agent. No Project grant or notification version required; Cookie requires CSRF. Idempotency-Key, current authentication, acknowledgement, immutable result and personal security audit commit together. Existing acknowledgements retain their first timestamp; expiration/withdrawal does not erase history.";
paths["/api/v1/admin/notifications"].get.description = "Deployment Owner Bearer or Owner admin Web Session only. Bounded history includes the publisher's own notifications and retained expired/withdrawn plain text.";
paths["/api/v1/admin/notifications"].post.description = "Deployment Owner Bearer or Owner admin Web Session only. Publish one immutable instance notification; title <=200 and body <=4000 Unicode code points, with optional future expiry. Cookie requires CSRF. Idempotency-Key, current Owner authorization, snapshot and security audit commit atomically; never fan out inbox rows.";
paths["/api/v1/admin/notifications/{notification_id}/commands/withdraw"].post.description = "Deployment Owner Bearer or Owner admin Web Session only. Withdraw one notification with expected_version and Idempotency-Key; Cookie requires CSRF. Current Owner authorization, CAS, withdrawal, immutable snapshot and security audit commit together. Retain title/body and personal acknowledgements permanently; published text cannot be edited.";
paths["/api/v1/admin/upgrade-notification-settings"].get.description = "Deployment Owner Bearer or Owner admin Web Session only. Persistent upgrade announcement setting defaults to disabled.";
paths["/api/v1/admin/upgrade-notification-settings"].patch.description = "Owner instance control only; current authorization, CAS, Idempotency-Key, setting, frozen response and security audit commit together. Cookie requires CSRF.";
paths["/api/v1/admin/notifications/commands/publish-upgrade"].post.description = "Owner instance control only. Deployment runtime invokes this atomic command after verified deployment, health, discovery, schema and authenticated identity readback. The new release must match the executing Worker. SemVer forward stable or rc.N changes only; other prerelease channels return unsupported_channel. The service setting is evaluated at commit. One bilingual immutable announcement per release across deployment IDs, concurrent callers and keys; returns published/already_published/disabled/not_forward/unsupported_channel separately from deployment success. Idempotency-Key, current Owner authorization, immutable result and security audit are atomic; same key recovers the original outcome.";
paths["/api/v1/web-session/renew"].post.description = "Current Cookie Session only; Bearer authentication is rejected. Require same-origin CSRF, expected_version and Idempotency-Key. Foreground activity may extend a still-valid Session at most once per thirty minutes, to eight hours from renewal and no later than seven days from creation. CAS, unchanged live source/scope, idempotency snapshot and security audit commit atomically. Success, replay and error responses never set or clear cookies; new sign-ins issue cookies until the absolute deadline, with current expiry enforced independently by the server. Pre-upgrade cookies retain their original expiry and require a new sign-in to use the full renewal period.";
paths["/api/v1/web-session/renew"].post.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/attachment-settings"].get.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/attachment-settings"].patch.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/attachment-settings"].patch.description = "Owner-only explicit capacity choice: positive safe integer bytes or null for unlimited. Requires expected_version and Idempotency-Key; Cookie requests require CSRF. Lowering the limit preserves files and existing reservations. New reservations require configured=true and available capacity. An unset limit is not implicit unlimited capacity.";
paths["/api/v1/admin/usage"].get.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/usage/refresh"].post.responses["200"].headers = noStoreHeader;
paths["/api/v1/admin/usage/refresh"].post.description = "Owner-only derived-cache refresh; Cookie requests require CSRF. No business mutation, domain event, or Idempotency-Key is required. Both modes reuse snapshots younger than 15 minutes; manual does not bypass the shared Web/Skill cache. All attempts share a 60-second cooldown. Concurrent or cooling-down requests return the existing projection. Cloudflare failures are represented in cloudflare.status/error with the last successful snapshot retained.";
paths["/api/v1/meta"].get.responses["200"] = { description: "Authenticated instance metadata with product release and API compatibility versions.", headers: requestIdHeader, content: { "application/json": { schema: ref("Meta") } } };
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
    "Set-Cookie": { required: false, schema: string(), description: "Present only on the secret-bearing first response; sets the HttpOnly Web Session cookie and a separate readable CSRF cookie until the original seven-day absolute deadline. The server independently enforces the current eight-hour expiry and revocation. Secrets never appear in the response body." },
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
    version: await readReleaseVersion(fileURLToPath(new URL("..", import.meta.url))),
    description: "HTTP API contract for this cfKanban release. The API compatibility version is published separately in x-cfkanban-service-version.",
    license: { name: "UNLICENSED" },
  },
  "x-cfkanban-service-version": serviceApi.service_version,
  servers: [{ url: "/", description: "Current cfKanban instance origin" }],
  tags: tags.map((name) => ({ name, description: tagDescriptions[name] })),
  paths,
  components: {
    securitySchemes: {
      WafOriginProof: { type: "apiKey", in: "header", name: "x-cfkanban-waf-proof", description: "Short-lived request-labelled HMAC for the fixed WAF target proof protocol. Not a user token or general signing interface." },
      BearerCredential: { type: "http", scheme: "bearer", bearerFormat: "cfk_v1 opaque credential", description: "Long-lived Principal credential used by Agents. Never place it in a URL." },
      WebSession: { type: "apiKey", in: "cookie", name: "cfkanban_session", description: "HttpOnly same-origin Web Session: eight-hour activity renewal, at most once per thirty minutes, with a seven-day absolute lifetime." },
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
