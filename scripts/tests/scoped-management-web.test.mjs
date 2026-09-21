import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { managedWorkspaceIds, managementPath, hasManagementActions, remainingAccessSources, sourceLabel, projectDisplayRole, projectRoleLabel } from "../../apps/web/src/lib/scoped-management.ts";
import { sameSessionBoundary } from "../../apps/web/src/lib/session-boundary.ts";
import { canAccessOwnerControlPlane } from "../../apps/web/src/lib/session-capabilities.ts";

const workspaceGrant = { id: "admin-1", principal_id: "user", workspace_id: "workspace-1", project_id: null, version: 1, generation: "generation-1", revoked_at: null };
function session(overrides = {}) {
  return {
    allowed_scope: { kind: "project_selection", projects: [] },
    management_grants: [workspaceGrant],
    principal: { id: "user", display_name: "User", is_owner: false, version: 1 },
    source: { id: "credential", kind: "credential" },
    target: { kind: "project_selection" }, session_id: "session", expires_at: "2026-09-21T00:00:00Z",
    ...overrides,
  };
}

test("project identity display follows management precedence without leaking across scopes", () => {
  const project = { workspace_id: "workspace-1", project_id: "project-1", role: "writer" };
  const direct = { ...workspaceGrant, id: "direct", project_id: "project-1" };
  assert.equal(projectDisplayRole(session(), project), "workspace_admin");
  assert.equal(projectDisplayRole(session(), { ...project, project_id: "future-project" }), "workspace_admin");
  assert.equal(projectDisplayRole(session({ management_grants: [direct] }), project), "project_admin");
  assert.equal(projectDisplayRole(session({ management_grants: [direct, workspaceGrant] }), project), "workspace_admin");
  assert.equal(projectDisplayRole(session({ management_grants: [direct, workspaceGrant] }), { ...project, role: "owner" }), "owner");
  assert.equal(projectDisplayRole(session(), { ...project, workspace_id: "other-workspace" }), "writer");
  assert.equal(projectDisplayRole(session({ management_grants: [direct] }), { ...project, project_id: "other-project", role: "reader" }), "reader");
  assert.equal(projectDisplayRole(session({ management_grants: [{ ...workspaceGrant, principal_id: "other-user" }] }), project), "writer");
});

test("revoked or unavailable management grants fall back to the remaining current project role", () => {
  const project = { workspace_id: "workspace-1", project_id: "project-1", role: "writer" };
  const direct = { ...workspaceGrant, id: "direct", project_id: "project-1" };
  const revoked = { ...workspaceGrant, revoked_at: "2026-09-21T00:00:00Z" };
  assert.equal(projectDisplayRole(session({ management_grants: [revoked, direct] }), project), "project_admin");
  assert.equal(projectDisplayRole(session({ management_grants: [revoked, { ...direct, revoked_at: revoked.revoked_at }] }), project), "writer");
  assert.equal(projectDisplayRole(session({ management_grants: [] }), { ...project, role: "reader" }), "reader");
  assert.equal(projectDisplayRole(session({ management_grants: undefined, allowed_scope: { kind: "project", projects: [project] } }), project), "writer");
});

test("every project identity has an English and Chinese label", () => {
  for (const [role, english, chinese] of [
    ["owner", "Owner", "所有者"],
    ["workspace_admin", "Workspace administrator", "工作区管理员"],
    ["project_admin", "Project administrator", "项目管理员"],
    ["writer", "Writer", "协作者"],
    ["reader", "Reader", "只读者"],
  ]) {
    assert.equal(projectRoleLabel(role, "en"), english);
    assert.equal(projectRoleLabel(role, "zh-CN"), chinese);
  }
});

test("empty workspaces remain discoverable without broadening a fixed session", () => {
  assert.deepEqual(managedWorkspaceIds(session()), ["workspace-1"]);
  assert.deepEqual(managedWorkspaceIds(session({ management_grants: [workspaceGrant, { ...workspaceGrant, id: "duplicate" }, { ...workspaceGrant, workspace_id: "revoked", revoked_at: "date" }, { ...workspaceGrant, workspace_id: "project-only", project_id: "project" }] })), ["workspace-1"]);
  assert.deepEqual(managedWorkspaceIds(session({ allowed_scope: { kind: "project", project_id: "project", projects: [] } })), []);
  const workspaceSession = session({ principal: { id: "owner", is_owner: true }, management_grants: [], allowed_scope: { kind: "workspace", workspace_id: "only-workspace" } });
  assert.deepEqual(managedWorkspaceIds(workspaceSession), ["only-workspace"]);
  assert.equal(canAccessOwnerControlPlane(workspaceSession), false);
  assert.equal(sameSessionBoundary(workspaceSession, { ...workspaceSession, allowed_scope: { kind: "workspace", workspace_id: "other-workspace" } }), false);
  assert.equal(canAccessOwnerControlPlane(session()), false);
  assert.equal(canAccessOwnerControlPlane(session({ principal: { id: "owner", is_owner: true }, allowed_scope: { kind: "project" } })), false);
});

test("management entry uses server actions rather than data writer role", () => {
  assert.equal(hasManagementActions({ allowed_actions: ["read"] }), false);
  assert.equal(hasManagementActions(null), false);
  assert.equal(hasManagementActions({ allowed_actions: ["manage_members"] }), true);
  assert.equal(hasManagementActions({ allowed_actions: ["restore"] }), true);
  assert.equal(managementPath("workspace 1", "project&2"), "/app/manage?workspace=workspace+1&project=project%262");
});

test("revocation preview removes only the selected independent source", () => {
  const sources = [
    { kind: "workspace_admin", id: "workspace-admin", version: 1 },
    { kind: "project_admin", id: "project-admin", version: 1 },
    { kind: "project_grant", id: "direct-grant", version: 2, role: "reader" },
  ];
  assert.deepEqual(remainingAccessSources(sources, "direct-grant"), sources.slice(0, 2));
  assert.deepEqual(remainingAccessSources(sources, "workspace-admin"), sources.slice(1));
  assert.equal(sources.length, 3);
  assert.match(sourceLabel("workspace_admin", true), /继承/);
  assert.match(sourceLabel("project_grant", false), /direct/);
});

test("management changes invalidate session projections even when writer access remains", () => {
  const before = session();
  assert.equal(sameSessionBoundary(before, session({ management_grants: [] })), false);
  assert.equal(sameSessionBoundary(before, session({ management_grants: [{ ...workspaceGrant, generation: "replacement" }] })), false);
  assert.equal(sameSessionBoundary(before, session({ management_grants: [{ ...workspaceGrant, version: 2 }] })), false);
  assert.equal(sameSessionBoundary(before, session({ principal: { ...before.principal, display_name: "Renamed" } })), true);
  const second = { ...workspaceGrant, id: "admin-2", workspace_id: "workspace-2" };
  assert.equal(sameSessionBoundary(session({ management_grants: [workspaceGrant, second] }), session({ management_grants: [second, workspaceGrant] })), true);
});

test("scoped surfaces avoid instance control endpoints and reuse invitation recovery protections", async () => {
  const [view, invites, app] = await Promise.all([
    readFile(new URL("../../apps/web/src/views/ScopedManagementView.vue", import.meta.url), "utf8"),
    readFile(new URL("../../apps/web/src/components/ScopedInvitations.vue", import.meta.url), "utf8"),
    readFile(new URL("../../apps/web/src/App.vue", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(view, /\/api\/v1\/admin\/(?:principals|credentials|audit-events|rate-limit-settings)/);
  assert.doesNotMatch(view, /public-join-policy/);
  assert.match(view, /can\('manage_administrators'\)/);
  assert.match(view, /expected_version: expectedVersion/);
  assert.match(view, /remainingAccessSources\(member\.sources, item\.id\)/);
  assert.match(view, /captureCasConflict/);
  assert.match(view, /PublicJoinRestorePreview/);
  assert.match(invites, /new InvitationRecoveryCoordinator/);
  assert.match(invites, /runNewOperation/);
  assert.match(invites, /runExistingOperation/);
  assert.match(invites, /retainPendingAfterUncertainResult/);
  assert.match(invites, /canConfirmInvitationReview/);
  assert.match(invites, /isInvitationCreateWriteResult/);
  assert.match(invites, /project_id: props\.projectId, limit: "100"/);
  assert.match(invites, /grants: \[\{ project_id: props\.projectId, role: role\.value \}\]/);
  assert.doesNotMatch(invites, /kind: "principal_recovery"/);
  assert.doesNotMatch(invites, /(?:setItem|console\.[a-z]+)\([^\n]*(?:oneTimeText|invite_url|copy_text)/);
  assert.match(app, /route\.kind === 'owner' && canAccessOwnerControlPlane\(session\)/);
});
