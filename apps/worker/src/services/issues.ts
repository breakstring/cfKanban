import {
  WORKFLOW_STATUSES,
  issueNumber,
  issueTitleSearch,
  priorityRank,
  requireBlockedReason,
  requireIssueBody,
  requireIssueIdentifier,
  requireIssueTitle,
  requirePriorityKey,
  requireProjectKey,
  requireUuid,
  requireWorkspaceKey,
  timestamp,
  type PriorityKey,
  type StatusKey,
} from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  requireVisibleProject,
  resolveVisibleProjects,
  verifyCurrentAuth,
  type VisibleProject,
} from "../kernel/authorization.ts";
import {
  createCursorContext,
  cursorScopeMismatch,
  decodeCursor,
  encodeCursor,
  invalidCursor,
} from "../kernel/cursor.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, type OperationCommit } from "../kernel/d1.ts";
import {
  ApiError,
  assigneeNotEligible,
  businessQuotaExceeded,
  conflict,
  forbidden,
  invalidTransition,
  notFound,
  platformUnavailable,
  validationError,
  versionConflict,
} from "../kernel/errors.ts";
import { readOperationSnapshot, runIdempotentOperation } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import {
  actorCredentialId,
  authorizedVia,
  requireIdempotencyKey,
  requireLimit,
  writeResult,
} from "./shared.ts";

type ProjectAccessRole = "owner" | "reader" | "writer";

interface IssueRow {
  assignee_available: number;
  assignee_display_name: string | null;
  assignee_principal_id: string | null;
  blocked_reason: string | null;
  body: string;
  created_at: number;
  deleted_at: number | null;
  deleted_by_principal_id: string | null;
  id: string;
  is_blocked: number;
  number: number;
  priority_key: PriorityKey;
  priority_rank: number;
  project_context: string | null;
  project_deleted_at: number | null;
  project_display_name: string;
  project_id: string;
  project_key: string;
  status_display_name: string;
  status_key: StatusKey;
  title: string;
  updated_at: number;
  version: number;
  workspace_display_name: string;
  workspace_deleted_at: number | null;
  workspace_id: string;
  workspace_key: string;
}

interface LabelRow {
  color: string | null;
  id: string;
  issue_id: string;
  name: string;
}

interface CommentRow {
  author_display_name: string;
  author_principal_id: string;
  body: string;
  created_at: number;
  id: string;
  kind: "completion" | "standard";
  version: number;
}

interface CountedCommentRow extends CommentRow {
  total_count: number;
}

interface RelationRow {
  created_at: number;
  id: string;
  kind: "blocks" | "duplicate" | "parent" | "related";
  source_number: number;
  source_project_id: string;
  target_number: number;
  target_project_id: string;
  total_count: number;
  version: number;
}

interface BoundedSection<T> {
  items: T[];
  totalCount: number;
}

interface IssueScope {
  broad: boolean;
  projectTargets: string[];
  projects: VisibleProject[];
  relationProjects: VisibleProject[];
  targetIdentifier: string | null;
  unresolvedProjectTargets: string[];
  unresolvedWorkspaceTargets: string[];
  workspaceTargets: string[];
}

interface IssueOperationSnapshot {
  labels: LabelRow[];
  row: IssueRow;
}

interface TombstoneQuotaRow {
  active_comment_count: number | null;
  active_issue_count: number | null;
  comment_limit: number | null;
  issue_id: string;
  issue_limit: number | null;
  public_join_enabled: number;
  restoring_comment_count: number;
}

interface SearchFilter {
  normalized: string | null;
  number: number | null;
}

type CandidateAssignment = "mine" | "needs_reassignment" | "unassigned";

interface CandidateFilter {
  assignment: CandidateAssignment;
  blocked: "exclude" | "include";
}

interface IssueListFilter {
  assignees: string[];
  statuses: StatusKey[];
}

const ISSUE_SELECT = `
  SELECT i.id, i.number, i.project_id, i.title, i.body, i.status_key,
         i.priority_key, i.priority_rank, i.assignee_principal_id,
         i.blocked_reason, i.version, i.deleted_at, i.created_at, i.updated_at,
         i.deleted_by_principal_id,
         p.key AS project_key, p.display_name AS project_display_name,
         p.deleted_at AS project_deleted_at,
         p.context AS project_context, w.id AS workspace_id,
         w.key AS workspace_key, w.display_name AS workspace_display_name,
         w.deleted_at AS workspace_deleted_at,
         assignee.display_name AS assignee_display_name,
         COALESCE(status_name.display_name,
           CASE i.status_key
             WHEN 'backlog' THEN 'Backlog'
             WHEN 'todo' THEN 'Todo'
             WHEN 'in_progress' THEN 'In Progress'
             WHEN 'done' THEN 'Done'
             ELSE 'Canceled'
           END) AS status_display_name,
         CASE
           WHEN i.assignee_principal_id IS NULL THEN 0
           WHEN i.assignee_principal_id = instance.owner_principal_id THEN 1
           WHEN EXISTS (
             SELECT 1 FROM project_grants eligible_grant
             WHERE eligible_grant.project_id = i.project_id
               AND eligible_grant.principal_id = i.assignee_principal_id
               AND eligible_grant.role = 'writer'
               AND eligible_grant.revoked_at IS NULL
           ) THEN 1 ELSE 0
         END AS assignee_available,
         CASE WHEN i.blocked_reason IS NOT NULL THEN 1 ELSE 0 END AS is_blocked
  FROM issues i
  JOIN projects p ON p.id = i.project_id
  JOIN workspaces w ON w.id = p.workspace_id
  JOIN instance_meta instance ON instance.singleton = 1
  LEFT JOIN principals assignee ON assignee.id = i.assignee_principal_id
  LEFT JOIN project_status_names status_name
    ON status_name.project_id = i.project_id AND status_name.status_key = i.status_key`;

function statusDefinition(key: StatusKey) {
  const definition = WORKFLOW_STATUSES.find((status) => status.key === key);
  if (definition === undefined) throw platformUnavailable();
  return definition;
}

function issueTarget(auth: AuthContext): string | null {
  if (auth.kind !== "cookie" || auth.targetKind !== "issue") return null;
  const identifier = auth.target.identifier;
  return typeof identifier === "string" && /^CFK-[1-9][0-9]*$/.test(identifier) ? identifier : "invalid";
}

function cookieTargetAllowsProject(auth: AuthContext, workspaceKey: string, projectKey: string): boolean {
  if (auth.kind === "bearer") return true;
  if (auth.targetKind === "admin") return auth.isOwner;
  if (auth.targetKind === "project_selection") return true;
  // An Issue launch fixes the Session to the Issue's owning Project. The
  // project membership is resolved by resolveVisibleProjects; the identifier
  // only selects the initial Web page and is not a single-resource ACL.
  if (auth.targetKind === "issue") return true;
  return auth.target.workspace_key === workspaceKey && auth.target.project_key === projectKey;
}

function roleCanWrite(role: ProjectAccessRole): boolean {
  return role === "owner" || role === "writer";
}

function projectRole(projects: readonly VisibleProject[], projectId: string): ProjectAccessRole | null {
  return projects.find((project) => project.projectId === projectId)?.role ?? null;
}

function parseProjectTarget(value: string): { projectKey: string; workspaceKey: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator !== value.lastIndexOf("/") || separator === value.length - 1) {
    throw validationError("invalid_project_filter");
  }
  return {
    projectKey: requireProjectKey(value.slice(separator + 1), "project"),
    workspaceKey: requireWorkspaceKey(value.slice(0, separator), "project"),
  };
}

function repeatedTargets(url: URL, name: "project" | "workspace"): string[] {
  const values = url.searchParams.getAll(name);
  if (values.length > 20) throw validationError("too_many_scope_filters", { field: name });
  return [...new Set(values)];
}

async function resolveIssueScope(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  forcedProject: VisibleProject | null = null,
  recoveryView = false,
): Promise<IssueScope> {
  const projectTargets = repeatedTargets(url, "project");
  const workspaceTargets = repeatedTargets(url, "workspace");
  const parsedProjects = projectTargets.map((target) => ({ target, ...parseProjectTarget(target) }));
  const parsedWorkspaces = workspaceTargets.map((target) => ({
    target,
    workspaceKey: requireWorkspaceKey(target, "workspace"),
  }));
  const relationProjects = recoveryView
    ? await resolveIssueRecoveryProjects(db, auth)
    : await resolveVisibleProjects(db, auth);
  let projects = relationProjects;
  const targetIdentifier = issueTarget(auth);
  if (forcedProject !== null) projects = projects.filter((project) => project.projectId === forcedProject.projectId);
  const visibleBeforeQueryFilters = projects;
  if (parsedProjects.length > 0) {
    projects = projects.filter((project) => parsedProjects.some(
      (target) => target.workspaceKey === project.workspaceKey && target.projectKey === project.projectKey,
    ));
  }
  if (parsedWorkspaces.length > 0) {
    projects = projects.filter((project) => parsedWorkspaces.some(
      (target) => target.workspaceKey === project.workspaceKey,
    ));
  }
  const unresolvedProjectTargets = parsedProjects
    .filter((target) => !visibleBeforeQueryFilters.some(
      (project) => project.workspaceKey === target.workspaceKey && project.projectKey === target.projectKey,
    ))
    .map((target) => target.target);
  const unresolvedWorkspaceTargets = parsedWorkspaces
    .filter((target) => !visibleBeforeQueryFilters.some((project) => project.workspaceKey === target.workspaceKey))
    .map((target) => target.target);
  return {
    broad: forcedProject === null && targetIdentifier === null && projectTargets.length === 0 && workspaceTargets.length === 0,
    projectTargets,
    projects,
    relationProjects,
    targetIdentifier,
    unresolvedProjectTargets,
    unresolvedWorkspaceTargets,
    workspaceTargets,
  };
}

function searchFilter(url: URL): SearchFilter {
  const raw = url.searchParams.get("q");
  if (raw === null) return { normalized: null, number: null };
  const normalized = raw.normalize("NFKC").toLowerCase().trim();
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes < 1 || bytes > 128) throw validationError("invalid_issue_query");
  const identifier = /^cfk-[1-9][0-9]*$/.test(normalized) ? Number(normalized.slice(4)) : null;
  return {
    normalized,
    number: identifier !== null && Number.isSafeInteger(identifier) ? identifier : null,
  };
}

function issueDeletionView(url: URL): "exclude" | "only" {
  const value = url.searchParams.get("deleted") ?? "exclude";
  if (value !== "exclude" && value !== "only") {
    throw validationError("schema_validation_failed", { field: "deleted" });
  }
  return value;
}

async function resolveIssueRecoveryProjects(
  db: D1Database,
  auth: AuthContext,
  onlyProjectId: string | null = null,
): Promise<VisibleProject[]> {
  let targetProjectId: string | null = null;
  let targetWorkspaceKey: string | null = null;
  let targetProjectKey: string | null = null;
  let targetIssueNumber: number | null = null;
  if (auth.kind === "cookie") {
    if (auth.targetKind === "admin" && !auth.isOwner) return [];
    if (auth.targetKind === "project") {
      targetProjectId = typeof auth.target.project_id === "string" ? auth.target.project_id : null;
      targetWorkspaceKey = typeof auth.target.workspace_key === "string" ? auth.target.workspace_key : null;
      targetProjectKey = typeof auth.target.project_key === "string" ? auth.target.project_key : null;
      if (targetProjectId === null && (targetWorkspaceKey === null || targetProjectKey === null)) return [];
    }
    if (auth.targetKind === "issue") {
      const identifier = issueTarget(auth);
      if (identifier === null || identifier === "invalid") return [];
      targetIssueNumber = issueNumber(identifier);
    }
  }
  const select = `
    SELECT p.id AS project_id, p.key AS project_key, p.display_name AS project_name,
           p.version AS project_version, w.id AS workspace_id, w.key AS workspace_key,
           w.display_name AS workspace_name, ?1 AS role
    FROM projects p
    JOIN workspaces w ON w.id = p.workspace_id
    WHERE (?2 IS NULL OR p.id = ?2)
      AND (?3 IS NULL OR p.id = ?3)
      AND (?4 IS NULL OR w.key = ?4)
      AND (?5 IS NULL OR p.key = ?5)
      AND (?6 IS NULL OR EXISTS (
        SELECT 1 FROM issues target_issue
        WHERE target_issue.number = ?6 AND target_issue.project_id = p.id
      ))`;
  try {
    if (auth.isOwner) {
      const result = await db.prepare(`${select} ORDER BY w.key, p.key`).bind(
        "owner",
        onlyProjectId,
        targetProjectId,
        targetWorkspaceKey,
        targetProjectKey,
        targetIssueNumber,
      ).all<{
        project_id: string;
        project_key: string;
        project_name: string;
        project_version: number;
        role: ProjectAccessRole;
        workspace_id: string;
        workspace_key: string;
        workspace_name: string;
      }>();
      return result.results.map((row) => ({
        projectId: row.project_id,
        projectKey: row.project_key,
        projectName: row.project_name,
        projectVersion: row.project_version,
        role: row.role,
        workspaceId: row.workspace_id,
        workspaceKey: row.workspace_key,
        workspaceName: row.workspace_name,
      }));
    }
    const result = await db.prepare(
      `${select}
       AND p.deleted_at IS NULL AND w.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM project_grants recovery_grant
         WHERE recovery_grant.project_id = p.id
           AND recovery_grant.principal_id = ?7
           AND recovery_grant.role = 'writer' AND recovery_grant.revoked_at IS NULL
       )
       ORDER BY w.key, p.key`,
    ).bind(
      "writer",
      onlyProjectId,
      targetProjectId,
      targetWorkspaceKey,
      targetProjectKey,
      targetIssueNumber,
      auth.principalId,
    ).all<{
      project_id: string;
      project_key: string;
      project_name: string;
      project_version: number;
      role: ProjectAccessRole;
      workspace_id: string;
      workspace_key: string;
      workspace_name: string;
    }>();
    return result.results.map((row) => ({
      projectId: row.project_id,
      projectKey: row.project_key,
      projectName: row.project_name,
      projectVersion: row.project_version,
      role: row.role,
      workspaceId: row.workspace_id,
      workspaceKey: row.workspace_key,
      workspaceName: row.workspace_name,
    }));
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function parseOrdinaryCursor(value: JsonValue[] | null): [number, number] | null {
  if (value === null) return null;
  if (
    value.length === 2
    && typeof value[0] === "number"
    && Number.isSafeInteger(value[0])
    && value[0] >= 0
    && typeof value[1] === "number"
    && Number.isSafeInteger(value[1])
    && value[1] >= 1
  ) return value as [number, number];
  throw invalidCursor();
}

function parseCandidateCursor(value: JsonValue[] | null): [number, number, number] | null {
  if (value === null) return null;
  if (
    value.length === 3
    && typeof value[0] === "number"
    && Number.isSafeInteger(value[0])
    && value[0] >= 0
    && value[0] < 5
    && typeof value[1] === "number"
    && Number.isSafeInteger(value[1])
    && value[1] >= 0
    && typeof value[2] === "number"
    && Number.isSafeInteger(value[2])
    && value[2] >= 1
  ) return value as [number, number, number];
  throw invalidCursor();
}

async function readIssueRow(db: D1Database, number: number, includeDeleted = false): Promise<IssueRow | null> {
  try {
    return await db.prepare(
      `${ISSUE_SELECT}
       WHERE i.number = ?1
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL
         ${includeDeleted ? "" : "AND i.deleted_at IS NULL"}
       LIMIT 1`,
    ).bind(number).first<IssueRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function labelsForIssues(db: D1Database, issueIds: readonly string[]): Promise<Map<string, LabelRow[]>> {
  const byIssue = new Map<string, LabelRow[]>();
  if (issueIds.length === 0) return byIssue;
  try {
    const result = await db.prepare(
      `SELECT il.issue_id, l.id, l.name, l.color
       FROM issue_labels il
       JOIN labels l ON l.id = il.label_id
       WHERE il.issue_id IN (SELECT value FROM json_each(?1))
         AND l.deleted_at IS NULL
       ORDER BY lower(l.name), l.id`,
    ).bind(JSON.stringify(issueIds)).all<LabelRow>();
    for (const row of result.results) {
      const labels = byIssue.get(row.issue_id) ?? [];
      labels.push(row);
      byIssue.set(row.issue_id, labels);
    }
    return byIssue;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

interface BlockedProjectionRow {
  blocked_reason: string | null;
  id: string;
  is_blocked: number;
}

async function applyVisibleBlockedState(
  db: D1Database,
  rows: readonly BlockedProjectionRow[],
  visibleProjectIds: readonly string[],
): Promise<void> {
  for (const row of rows) row.is_blocked = row.blocked_reason === null ? 0 : 1;
  if (rows.length === 0 || visibleProjectIds.length === 0) return;
  try {
    const result = await db.prepare(
      `SELECT DISTINCT blocked_relation.target_issue_id
       FROM issue_relations blocked_relation
       JOIN issues blocker ON blocker.id = blocked_relation.source_issue_id
       JOIN issues target ON target.id = blocked_relation.target_issue_id
       JOIN projects blocker_project ON blocker_project.id = blocker.project_id
       JOIN workspaces blocker_workspace ON blocker_workspace.id = blocker_project.workspace_id
       JOIN projects target_project ON target_project.id = target.project_id
       JOIN workspaces target_workspace ON target_workspace.id = target_project.workspace_id
       WHERE blocked_relation.target_issue_id IN (SELECT value FROM json_each(?1))
         AND blocker.project_id IN (SELECT value FROM json_each(?2))
         AND target.project_id IN (SELECT value FROM json_each(?2))
         AND blocked_relation.kind = 'blocks' AND blocked_relation.deleted_at IS NULL
         AND blocker.deleted_at IS NULL AND blocker.status_key <> 'done'
         AND target.deleted_at IS NULL
         AND blocker_project.deleted_at IS NULL AND blocker_workspace.deleted_at IS NULL
         AND target_project.deleted_at IS NULL AND target_workspace.deleted_at IS NULL`,
    ).bind(
      JSON.stringify(rows.map((row) => row.id)),
      JSON.stringify(visibleProjectIds),
    ).all<{ target_issue_id: string }>();
    const blockedIds = new Set(result.results.map((row) => row.target_issue_id));
    for (const row of rows) {
      if (blockedIds.has(row.id)) row.is_blocked = 1;
    }
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function issueOperationSnapshotStatement(
  db: D1Database,
  operationId: string,
  issueId: string,
  role: ProjectAccessRole,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE idempotency_records
     SET operation_snapshot_json = (
       SELECT json_object(
         'row', json_object(
           'assignee_available', CASE
             WHEN i.assignee_principal_id IS NULL THEN 0
             WHEN i.assignee_principal_id = instance.owner_principal_id THEN 1
             WHEN EXISTS (
               SELECT 1 FROM project_grants eligible_grant
               WHERE eligible_grant.project_id = i.project_id
                 AND eligible_grant.principal_id = i.assignee_principal_id
                 AND eligible_grant.role = 'writer' AND eligible_grant.revoked_at IS NULL
             ) THEN 1 ELSE 0 END,
           'assignee_display_name', assignee.display_name,
           'assignee_principal_id', i.assignee_principal_id,
           'blocked_reason', i.blocked_reason,
           'body', i.body,
           'created_at', i.created_at,
           'deleted_at', i.deleted_at,
           'deleted_by_principal_id', i.deleted_by_principal_id,
           'id', i.id,
           'is_blocked', CASE WHEN i.blocked_reason IS NOT NULL THEN 1 ELSE 0 END,
           'number', i.number,
           'priority_key', i.priority_key,
           'priority_rank', i.priority_rank,
           'project_context', p.context,
           'project_deleted_at', p.deleted_at,
           'project_display_name', p.display_name,
           'project_id', p.id,
           'project_key', p.key,
           'status_display_name', COALESCE(status_name.display_name,
             CASE i.status_key
               WHEN 'backlog' THEN 'Backlog' WHEN 'todo' THEN 'Todo'
               WHEN 'in_progress' THEN 'In Progress' WHEN 'done' THEN 'Done'
               ELSE 'Canceled' END),
           'status_key', i.status_key,
           'title', i.title,
           'updated_at', i.updated_at,
           'version', i.version,
           'workspace_deleted_at', w.deleted_at,
           'workspace_display_name', w.display_name,
           'workspace_id', w.id,
           'workspace_key', w.key
         ),
         'labels', json(COALESCE((
           SELECT json_group_array(json_object(
             'color', ordered_label.color,
             'id', ordered_label.id,
             'issue_id', ordered_label.issue_id,
             'name', ordered_label.name
           ))
           FROM (
             SELECT l.color, l.id, il.issue_id, l.name
             FROM issue_labels il JOIN labels l ON l.id = il.label_id
             WHERE il.issue_id = i.id AND l.deleted_at IS NULL
             ORDER BY lower(l.name), l.id
           ) ordered_label
         ), '[]')),
         'role', ?3
       )
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN workspaces w ON w.id = p.workspace_id
       JOIN instance_meta instance ON instance.singleton = 1
       LEFT JOIN principals assignee ON assignee.id = i.assignee_principal_id
       LEFT JOIN project_status_names status_name
         ON status_name.project_id = i.project_id AND status_name.status_key = i.status_key
       WHERE i.id = ?2
     )
     WHERE operation_id = ?1 AND state = 'pending'`,
  ).bind(operationId, issueId, role);
}

async function readIssueOperationSnapshot(
  db: D1Database,
  operationId: string,
): Promise<IssueOperationSnapshot & { role: ProjectAccessRole }> {
  return readOperationSnapshot<IssueOperationSnapshot & { role: ProjectAccessRole }>(db, operationId);
}

async function issueSnapshotResource(
  db: D1Database,
  auth: AuthContext,
  snapshot: IssueOperationSnapshot & { role: ProjectAccessRole },
): Promise<{ [key: string]: JsonValue }> {
  const row = { ...snapshot.row };
  const visibleProjects = await resolveVisibleProjects(db, auth);
  await applyVisibleBlockedState(
    db,
    [row],
    visibleProjects.map((project) => project.projectId),
  );
  return issueResource(row, snapshot.labels, snapshot.role, true);
}

export function issueWriteSnapshotStatement(
  db: D1Database,
  operationId: string,
  issueId: string,
  role: VisibleProject["role"],
): D1PreparedStatement {
  return issueOperationSnapshotStatement(db, operationId, issueId, role);
}

export async function readIssueWriteSnapshotResource(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
): Promise<{ [key: string]: JsonValue }> {
  return issueSnapshotResource(db, auth, await readIssueOperationSnapshot(db, operationId));
}

export async function currentIssueReplayProjection(
  db: D1Database,
  auth: AuthContext,
  stored: { body: { [key: string]: JsonValue }; status: number },
): Promise<{ body: { [key: string]: JsonValue }; status: number }> {
  const resourceValue = stored.body.resource;
  if (resourceValue === null || Array.isArray(resourceValue) || typeof resourceValue !== "object") {
    throw platformUnavailable();
  }
  const id = resourceValue.id;
  const blockedReason = resourceValue.blocked_reason;
  if (
    typeof id !== "string"
    || (blockedReason !== null && typeof blockedReason !== "string")
  ) {
    throw platformUnavailable();
  }
  const projection: BlockedProjectionRow = {
    blocked_reason: blockedReason,
    id,
    is_blocked: blockedReason === null ? 0 : 1,
  };
  const visibleProjects = await resolveVisibleProjects(db, auth);
  await applyVisibleBlockedState(
    db,
    [projection],
    visibleProjects.map((project) => project.projectId),
  );
  return {
    body: {
      ...stored.body,
      resource: { ...resourceValue, is_blocked: projection.is_blocked === 1 },
    },
    status: stored.status,
  };
}

function allowedIssueActions(role: ProjectAccessRole, deleted: boolean): string[] {
  if (!roleCanWrite(role)) return deleted ? [] : ["read"];
  if (deleted) return ["restore"];
  return ["read", "update", "delete", "assign_to_me", "report_blocked", "clear_blocked"];
}

function issueResource(
  row: IssueRow,
  labels: readonly LabelRow[],
  role: ProjectAccessRole,
  detail = false,
): { [key: string]: JsonValue } {
  const status = statusDefinition(row.status_key);
  const resource: { [key: string]: JsonValue } = {
    assignee: row.assignee_principal_id === null ? null : {
      available: row.assignee_available === 1,
      display_name: row.assignee_display_name ?? "",
      principal_id: row.assignee_principal_id,
    },
    created_at: timestamp(row.created_at),
    deleted_at: timestamp(row.deleted_at),
    id: row.id,
    identifier: `CFK-${row.number}`,
    is_blocked: row.is_blocked === 1,
    labels: labels.map((label) => ({ color: label.color, id: label.id, name: label.name })),
    needs_reassignment: row.assignee_principal_id !== null && row.assignee_available !== 1,
    number: row.number,
    priority: row.priority_key,
    project: {
      display_name: row.project_display_name,
      id: row.project_id,
      key: row.project_key,
    },
    status: {
      category: status.category,
      display_name: row.status_display_name,
      key: row.status_key,
      terminal: status.terminal,
    },
    title: row.title,
    updated_at: timestamp(row.updated_at),
    version: row.version,
    workspace: { display_name: row.workspace_display_name, key: row.workspace_key },
  };
  if (detail) {
    resource.allowed_actions = allowedIssueActions(role, row.deleted_at !== null);
    resource.blocked_reason = row.blocked_reason;
    resource.body = row.body;
  }
  return resource;
}

function issueTombstoneResource(
  row: IssueRow,
  role: ProjectAccessRole,
  quota: TombstoneQuotaRow | null = null,
): { [key: string]: JsonValue } {
  const projectActive = row.project_deleted_at === null;
  const workspaceActive = row.workspace_deleted_at === null;
  let unavailabilityReason: JsonValue = !workspaceActive
    ? { code: "PARENT_WORKSPACE_DELETED", recovery: "restore_parent" }
    : !projectActive
      ? { code: "PARENT_PROJECT_DELETED", recovery: "restore_parent" }
      : null;
  if (unavailabilityReason === null && roleCanWrite(role) && quota?.public_join_enabled === 1) {
    if (
      quota.active_issue_count === null
      || quota.issue_limit === null
      || quota.active_comment_count === null
      || (quota.restoring_comment_count > 0 && quota.comment_limit === null)
    ) {
      throw platformUnavailable("d1");
    }
    if (quota.active_issue_count + 1 > quota.issue_limit) {
      unavailabilityReason = {
        code: "PROJECT_ISSUE_LIMIT_REACHED",
        current_usage: quota.active_issue_count,
        limit: quota.issue_limit,
        recovery: "free_capacity_or_request_owner",
        resource_kind: "issues",
      };
    } else if (
      quota.restoring_comment_count > 0
      && quota.active_comment_count + quota.restoring_comment_count > (quota.comment_limit ?? -1)
    ) {
      unavailabilityReason = {
        code: "PROJECT_COMMENT_LIMIT_REACHED",
        current_usage: quota.active_comment_count,
        limit: quota.comment_limit,
        recovery: "free_capacity_or_request_owner",
        resource_kind: "comments",
      };
    }
  }
  const restorable = roleCanWrite(role) && projectActive && workspaceActive && unavailabilityReason === null;
  return {
    ...issueResource(row, [], role),
    allowed_actions: restorable ? ["restore"] : [],
    deleted_by_principal_id: row.deleted_by_principal_id,
    parent_status: {
      project: projectActive ? "active" : "deleted",
      workspace: workspaceActive ? "active" : "deleted",
    },
    restorable,
    unavailability_reason: unavailabilityReason,
  };
}

async function tombstoneQuotaRows(
  db: D1Database,
  issueIds: readonly string[],
): Promise<Map<string, TombstoneQuotaRow>> {
  const byIssue = new Map<string, TombstoneQuotaRow>();
  if (issueIds.length === 0) return byIssue;
  try {
    const result = await db.prepare(
      `SELECT issue.id AS issue_id,
              CASE WHEN policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL
                   THEN 1 ELSE 0 END AS public_join_enabled,
              project.issue_limit, project.comment_limit,
              usage.active_issue_count, usage.active_comment_count,
              (SELECT COUNT(*) FROM comments active_comment
               WHERE active_comment.issue_id = issue.id
                 AND active_comment.deleted_at IS NULL) AS restoring_comment_count
       FROM issues issue
       JOIN projects project ON project.id = issue.project_id
       LEFT JOIN public_join_policies policy ON policy.project_id = project.id
       LEFT JOIN project_usage usage ON usage.project_id = project.id
       WHERE issue.id IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(issueIds)).all<TombstoneQuotaRow>();
    for (const row of result.results) byIssue.set(row.issue_id, row);
    return byIssue;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}

async function requireIssueRecoveryAccess(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  requireDeleted = false,
): Promise<{ project: VisibleProject; row: IssueRow }> {
  const identifier = requireIssueIdentifier(identifierValue);
  let row: IssueRow | null;
  try {
    row = await db.prepare(
      `${ISSUE_SELECT} WHERE i.number = ?1 LIMIT 1`,
    ).bind(issueNumber(identifier)).first<IssueRow>();
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
  if (row === null || (requireDeleted && row.deleted_at === null)) throw notFound();
  const projects = await resolveIssueRecoveryProjects(db, auth, row.project_id);
  const project = projects.find((candidate) => candidate.projectId === row.project_id);
  if (project === undefined) throw notFound();
  return { project, row };
}

function requireActiveIssueParents(row: IssueRow): void {
  if (row.workspace_deleted_at !== null) {
    throw conflict("PARENT_WORKSPACE_DELETED", "restore_parent", { parent_kind: "workspace" });
  }
  if (row.project_deleted_at !== null) {
    throw conflict("PARENT_PROJECT_DELETED", "restore_parent", { parent_kind: "project" });
  }
}

async function requireIssueAccess(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
  includeDeleted = false,
): Promise<{ project: VisibleProject; row: IssueRow }> {
  const identifier = requireIssueIdentifier(identifierValue);
  const row = await readIssueRow(db, issueNumber(identifier), includeDeleted);
  if (row === null || !cookieTargetAllowsProject(auth, row.workspace_key, row.project_key)) throw notFound();
  const visible = await resolveVisibleProjects(db, auth);
  const project = visible.find((candidate) => candidate.projectId === row.project_id);
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && !roleCanWrite(project.role)) throw forbidden();
  return { project, row };
}

function requireCandidateFilter(url: URL): CandidateFilter {
  const assignment = url.searchParams.get("assignment");
  if (assignment !== "unassigned" && assignment !== "mine" && assignment !== "needs_reassignment") {
    throw validationError("schema_validation_failed", { field: "assignment" });
  }
  const blocked = url.searchParams.get("blocked") ?? "exclude";
  if (blocked !== "exclude" && blocked !== "include") {
    throw validationError("schema_validation_failed", { field: "blocked" });
  }
  return { assignment, blocked };
}

function requireIssueListFilter(url: URL): IssueListFilter {
  const rawStatuses = url.searchParams.getAll("status");
  const rawAssignees = url.searchParams.getAll("assignee");
  if (rawStatuses.length > 5) throw validationError("too_many_issue_filters", { field: "status" });
  if (rawAssignees.length > 20) throw validationError("too_many_issue_filters", { field: "assignee" });
  const statuses = [...new Set(rawStatuses)].map((status) => {
    if (!WORKFLOW_STATUSES.some((definition) => definition.key === status)) {
      throw validationError("schema_validation_failed", { field: "status" });
    }
    return status as StatusKey;
  }).sort();
  const assignees = [...new Set(rawAssignees.map((assignee) => requireUuid(assignee, "assignee")))].sort();
  return { assignees, statuses };
}

function resolvedScope(
  scope: IssueScope,
  search: SearchFilter,
  candidate: CandidateFilter | null,
  issueFilter: IssueListFilter,
): { [key: string]: JsonValue } {
  return {
    broad_search: scope.broad && search.normalized !== null,
    expanded_to_all_authorized_projects: scope.broad,
    project_targets: scope.projectTargets,
    projects: scope.projects.map((project) => ({
      project_id: project.projectId,
      project_key: project.projectKey,
      workspace_key: project.workspaceKey,
    })),
    ...(candidate !== null ? {
      candidate_policy: { ...candidate, status_category: "unstarted" },
    } : {}),
    filters: {
      assignees: issueFilter.assignees,
      statuses: issueFilter.statuses,
    },
    target_identifier: scope.targetIdentifier,
    unresolved_project_targets: scope.unresolvedProjectTargets,
    unresolved_workspace_targets: scope.unresolvedWorkspaceTargets,
    workspace_targets: scope.workspaceTargets,
  };
}

async function listIssueRows(
  db: D1Database,
  scope: IssueScope,
  search: SearchFilter,
  url: URL,
  candidate: CandidateFilter | null,
  issueFilter: IssueListFilter,
  auth: AuthContext,
  deletionView: "exclude" | "only",
  now: number,
): Promise<{ hasMore: boolean; rows: IssueRow[]; nextCursor: string | null }> {
  const candidates = candidate !== null;
  const limit = requireLimit(url);
  const filter: JsonValue = {
    candidate: candidates,
    candidate_assignment: candidate?.assignment ?? null,
    candidate_blocked: candidate?.blocked ?? null,
    deleted: deletionView,
    assignees: issueFilter.assignees,
    project_targets: [...scope.projectTargets].sort(),
    q: search.normalized,
    statuses: issueFilter.statuses,
    workspace_targets: [...scope.workspaceTargets].sort(),
  };
  const cursorContext = await createCursorContext(
    candidates ? "issue-candidates" : "issues",
    filter,
    [
      ...scope.projects.map((project) => `result:${project.projectId}`),
      ...scope.relationProjects.map((project) => `relation:${project.projectId}`),
    ],
    auth.principalId,
  );
  const projectIds = scope.projects.map((project) => project.projectId);
  const decodedCursor = decodeCursor(url.searchParams.get("cursor"), cursorContext);
  const parsedCursor = candidates
    ? parseCandidateCursor(decodedCursor)
    : parseOrdinaryCursor(decodedCursor);
  if (projectIds.length === 0) {
    return { hasMore: false, nextCursor: null, rows: [] };
  }
  if (scope.broad && search.normalized !== null && search.number === null && projectIds.length > 20) {
    throw new ApiError({
      category: "validation",
      code: "QUERY_SCOPE_TOO_BROAD",
      message: "The search scope exceeds the bounded v0 scan budget.",
      recovery: "narrow_scope",
      retryable: false,
      status: 400,
    });
  }
  let rows: IssueRow[];
  let hasMore: boolean;
  let nextCursor: string | null = null;
  try {
    if (candidates) {
      const cursor = parsedCursor as [number, number, number] | null;
      const currentAuthGuard = buildCurrentAuthGuard(auth, now, 11);
      const candidateStatement = db.prepare(
        `WITH current_visible_projects(id) AS MATERIALIZED (
           SELECT current_project.id
           FROM projects current_project
           JOIN workspaces current_workspace ON current_workspace.id = current_project.workspace_id
           JOIN instance_meta current_instance ON current_instance.singleton = 1
           WHERE current_project.id IN (SELECT value FROM json_each(?10))
             AND current_project.deleted_at IS NULL
             AND current_workspace.deleted_at IS NULL
             AND ${currentAuthGuard.sql}
             AND (
               current_instance.owner_principal_id = ?8
               OR EXISTS (
                 SELECT 1 FROM project_grants current_grant
                 WHERE current_grant.project_id = current_project.id
                   AND current_grant.principal_id = ?8
                   AND current_grant.revoked_at IS NULL
               )
             )
         ), current_result_projects(id) AS MATERIALIZED (
           SELECT id FROM current_visible_projects
           WHERE id IN (SELECT value FROM json_each(?1))
         )
         ${ISSUE_SELECT}
         WHERE i.project_id IN (SELECT id FROM current_result_projects)
           AND i.deleted_at IS NULL AND p.deleted_at IS NULL AND w.deleted_at IS NULL
           AND i.status_key = 'todo'
           ${candidate.blocked === "exclude" ? `AND i.blocked_reason IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM issue_relations blocked_relation
             JOIN issues blocker ON blocker.id = blocked_relation.source_issue_id
             JOIN projects blocker_project ON blocker_project.id = blocker.project_id
             JOIN workspaces blocker_workspace ON blocker_workspace.id = blocker_project.workspace_id
             WHERE blocked_relation.target_issue_id = i.id
               AND blocked_relation.kind = 'blocks' AND blocked_relation.deleted_at IS NULL
               AND blocker.deleted_at IS NULL AND blocker.status_key <> 'done'
               AND blocker.project_id IN (SELECT id FROM current_visible_projects)
               AND blocker_project.deleted_at IS NULL AND blocker_workspace.deleted_at IS NULL
           )` : ""}
           AND (
             (?7 = 'unassigned' AND i.assignee_principal_id IS NULL)
             OR (?7 = 'mine' AND i.assignee_principal_id = ?8)
             OR (?7 = 'needs_reassignment'
                 AND i.assignee_principal_id IS NOT NULL
                 AND i.assignee_principal_id != (SELECT owner_principal_id FROM instance_meta WHERE singleton = 1)
                 AND NOT EXISTS (
                   SELECT 1 FROM project_grants candidate_grant
                   WHERE candidate_grant.project_id = i.project_id
                     AND candidate_grant.principal_id = i.assignee_principal_id
                     AND candidate_grant.role = 'writer'
                     AND candidate_grant.revoked_at IS NULL
                 ))
           )
           AND (?3 IS NULL OR (?2 IS NOT NULL AND i.number = ?2) OR instr(i.title_search, ?3) > 0)
           AND (?4 IS NULL OR i.priority_rank > ?4
                OR (i.priority_rank = ?4 AND i.created_at > ?5)
                OR (i.priority_rank = ?4 AND i.created_at = ?5 AND i.number > ?6))
         ORDER BY i.priority_rank ASC, i.created_at ASC, i.number ASC
         LIMIT ?9`,
      );
      const candidateBindings = [
        JSON.stringify(projectIds), search.number, search.normalized,
        cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null,
        candidate.assignment,
        auth.principalId,
        limit + 1,
      ] as const;
      const boundCandidateStatement = candidateStatement.bind(
        ...candidateBindings,
        JSON.stringify(scope.relationProjects.map((project) => project.projectId)),
        ...currentAuthGuard.values,
      );
      const result = await boundCandidateStatement.all<IssueRow>();
      rows = result.results;
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
      const tail = rows.at(-1);
      if (hasMore && tail !== undefined) {
        nextCursor = encodeCursor(cursorContext, [tail.priority_rank, tail.created_at, tail.number]);
      }
    } else {
      const cursor = parsedCursor as [number, number] | null;
      const currentAuthGuard = buildCurrentAuthGuard(auth, now, 10);
      const statement = db.prepare(
        `WITH current_result_projects(id) AS MATERIALIZED (
           SELECT current_project.id
           FROM projects current_project
           JOIN workspaces current_workspace ON current_workspace.id = current_project.workspace_id
           JOIN instance_meta current_instance ON current_instance.singleton = 1
           WHERE current_project.id IN (SELECT value FROM json_each(?1))
             AND ${currentAuthGuard.sql}
             AND ${deletionView === "only" ? `(
               current_instance.owner_principal_id = ?9
               OR (
                 current_project.deleted_at IS NULL
                 AND current_workspace.deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM project_grants current_grant
                   WHERE current_grant.project_id = current_project.id
                     AND current_grant.principal_id = ?9
                     AND current_grant.role = 'writer'
                     AND current_grant.revoked_at IS NULL
                 )
               )
             )` : `current_project.deleted_at IS NULL
             AND current_workspace.deleted_at IS NULL
             AND (
               current_instance.owner_principal_id = ?9
               OR EXISTS (
                 SELECT 1 FROM project_grants current_grant
                 WHERE current_grant.project_id = current_project.id
                   AND current_grant.principal_id = ?9
                   AND current_grant.revoked_at IS NULL
               )
             )`}
         )
         ${ISSUE_SELECT}
         WHERE i.project_id IN (SELECT id FROM current_result_projects)
           AND i.deleted_at IS ${deletionView === "only" ? "NOT NULL" : "NULL"}
           ${deletionView === "only" ? "" : "AND p.deleted_at IS NULL AND w.deleted_at IS NULL"}
           AND (?3 IS NULL OR (?2 IS NOT NULL AND i.number = ?2) OR instr(i.title_search, ?3) > 0)
           AND (?6 IS NULL OR i.status_key IN (SELECT value FROM json_each(?6)))
           AND (?7 IS NULL OR i.assignee_principal_id IN (SELECT value FROM json_each(?7)))
           AND (?4 IS NULL OR ${deletionView === "only" ? "i.deleted_at" : "i.updated_at"} < ?4
                OR (${deletionView === "only" ? "i.deleted_at" : "i.updated_at"} = ?4 AND i.number < ?5))
         ORDER BY ${deletionView === "only" ? "i.deleted_at" : "i.updated_at"} DESC, i.number DESC
         LIMIT ?8`,
      );
      const bindings = [
        JSON.stringify(projectIds), search.number, search.normalized,
        cursor?.[0] ?? null, cursor?.[1] ?? null,
        issueFilter.statuses.length === 0 ? null : JSON.stringify(issueFilter.statuses),
        issueFilter.assignees.length === 0 ? null : JSON.stringify(issueFilter.assignees),
        limit + 1,
      ] as const;
      const result = await statement.bind(
        ...bindings,
        auth.principalId,
        ...currentAuthGuard.values,
      ).all<IssueRow>();
      rows = result.results;
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
      const tail = rows.at(-1);
      if (hasMore && tail !== undefined) {
        nextCursor = encodeCursor(cursorContext, [
          deletionView === "only" ? tail.deleted_at ?? 0 : tail.updated_at,
          tail.number,
        ]);
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
  return { hasMore, nextCursor, rows };
}

async function listIssuesInternal(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  candidates: boolean,
  forcedProject: VisibleProject | null = null,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const deletionView = candidates ? "exclude" : issueDeletionView(url);
  let scope = await resolveIssueScope(db, auth, url, forcedProject, deletionView === "only");
  if (deletionView === "only") {
    if (forcedProject?.role === "reader") throw forbidden();
    scope = { ...scope, projects: scope.projects.filter((project) => roleCanWrite(project.role)) };
  }
  const search = searchFilter(url);
  const candidate = candidates ? requireCandidateFilter(url) : null;
  const issueFilter = candidates ? { assignees: [], statuses: [] } : requireIssueListFilter(url);
  let page = await listIssueRows(
    db,
    scope,
    search,
    url,
    candidate,
    issueFilter,
    auth,
    deletionView,
    now,
  );
  const labels = deletionView === "only"
    ? new Map<string, LabelRow[]>()
    : await labelsForIssues(db, page.rows.map((row) => row.id));
  const tombstoneQuotas = deletionView === "only"
    ? await tombstoneQuotaRows(db, page.rows.map((row) => row.id))
    : new Map<string, TombstoneQuotaRow>();
  if (deletionView !== "only") {
    await applyVisibleBlockedState(
      db,
      page.rows,
      scope.relationProjects.map((project) => project.projectId),
    );
  }
  await verifyCurrentAuth(db, auth, now);
  let currentScope = await resolveIssueScope(
    db,
    auth,
    url,
    forcedProject,
    deletionView === "only",
  );
  if (deletionView === "only") {
    currentScope = {
      ...currentScope,
      projects: currentScope.projects.filter((project) => roleCanWrite(project.role)),
    };
  }
  if (
    forcedProject !== null
    && !currentScope.projects.some((project) => project.projectId === forcedProject.projectId)
  ) throw notFound();
  const sameProjectIds = (previous: readonly VisibleProject[], current: readonly VisibleProject[]) => {
    const previousIds = previous.map((project) => project.projectId).sort();
    const currentIds = current.map((project) => project.projectId).sort();
    return previousIds.length === currentIds.length
      && previousIds.every((projectId, index) => projectId === currentIds[index]);
  };
  if (
    !sameProjectIds(scope.projects, currentScope.projects)
    || !sameProjectIds(scope.relationProjects, currentScope.relationProjects)
  ) throw cursorScopeMismatch();
  const currentProjectIds = new Set(currentScope.projects.map((project) => project.projectId));
  page = {
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    rows: page.rows.filter((row) => currentProjectIds.has(row.project_id)),
  };
  scope = currentScope;
  const roles = new Map(scope.projects.map((project) => [project.projectId, project.role]));
  return {
    has_more: page.hasMore,
    items: page.rows.map((row) => deletionView === "only"
      ? issueTombstoneResource(
          row,
          roles.get(row.project_id) ?? "reader",
          tombstoneQuotas.get(row.id) ?? null,
        )
      : issueResource(row, labels.get(row.id) ?? [], roles.get(row.project_id) ?? "reader")),
    next_cursor: page.nextCursor,
    resolved_scope: resolvedScope(scope, search, candidate, issueFilter),
  };
}

export async function listIssues(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  return listIssuesInternal(db, auth, url, false, null, now);
}

export async function listIssueCandidates(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  return listIssuesInternal(db, auth, url, true, null, now);
}

export async function listProjectIssues(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const deletionView = issueDeletionView(url);
  const project = deletionView === "only"
    ? (await resolveIssueRecoveryProjects(db, auth)).find(
      (candidate) => candidate.workspaceKey === workspaceKey && candidate.projectKey === projectKey,
    )
    : await requireVisibleProject(db, auth, workspaceKey, projectKey);
  if (project === undefined) throw notFound();
  return listIssuesInternal(db, auth, url, false, project, now);
}

async function visibleRelations(
  db: D1Database,
  issueId: string,
  visibleProjectIds: ReadonlySet<string>,
  limit = 100,
): Promise<BoundedSection<{ [key: string]: JsonValue }>> {
  if (visibleProjectIds.size === 0) return { items: [], totalCount: 0 };
  try {
    const result = await db.prepare(
      `SELECT r.id, r.kind, r.created_at,
              source.project_id AS source_project_id,
              source.number AS source_number, target.project_id AS target_project_id,
              target.number AS target_number, r.version,
              COUNT(*) OVER () AS total_count
       FROM issue_relations r
       JOIN issues source ON source.id = r.source_issue_id
       JOIN issues target ON target.id = r.target_issue_id
       WHERE (r.source_issue_id = ?1 OR r.target_issue_id = ?1)
         AND r.deleted_at IS NULL AND source.deleted_at IS NULL AND target.deleted_at IS NULL
         AND source.project_id IN (SELECT value FROM json_each(?2))
         AND target.project_id IN (SELECT value FROM json_each(?2))
       ORDER BY CASE
         WHEN r.kind = 'blocks' AND r.target_issue_id = ?1 AND source.status_key != 'done' THEN 0
         WHEN r.kind = 'parent' AND r.source_issue_id = ?1 THEN 1
         WHEN r.kind = 'parent' THEN 2
         WHEN r.kind = 'blocks' THEN 3
         WHEN r.kind = 'duplicate' THEN 4
         ELSE 5
       END, r.created_at DESC, r.id
       LIMIT ?3`,
    ).bind(issueId, JSON.stringify([...visibleProjectIds].sort()), limit).all<RelationRow>();
    return {
      items: result.results.map((row) => ({
        id: row.id,
        kind: row.kind,
        source_identifier: `CFK-${row.source_number}`,
        target_identifier: `CFK-${row.target_number}`,
        version: row.version,
      })),
      totalCount: result.results[0]?.total_count ?? 0,
    };
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function recentComments(db: D1Database, issueId: string): Promise<BoundedSection<CommentRow>> {
  try {
    const result = await db.prepare(
      `SELECT c.id, c.kind, c.body, c.author_principal_id,
              author.display_name AS author_display_name, c.version, c.created_at,
              COUNT(*) OVER () AS total_count
       FROM comments c JOIN principals author ON author.id = c.author_principal_id
       WHERE c.issue_id = ?1 AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC, c.id DESC LIMIT 10`,
    ).bind(issueId).all<CountedCommentRow>();
    return {
      items: result.results.map(({ total_count: _totalCount, ...row }) => row).reverse(),
      totalCount: result.results[0]?.total_count ?? 0,
    };
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

function commentResource(row: CommentRow): { [key: string]: JsonValue } {
  return {
    author: { display_name: row.author_display_name, principal_id: row.author_principal_id },
    body: row.body,
    created_at: timestamp(row.created_at),
    id: row.id,
    kind: row.kind,
    version: row.version,
  };
}

export async function getIssue(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const deletionView = issueDeletionView(url);
  if (deletionView === "only") {
    const { project, row } = await requireIssueRecoveryAccess(db, auth, identifierValue, true);
    const quotas = await tombstoneQuotaRows(db, [row.id]);
    return issueTombstoneResource(row, project.role, quotas.get(row.id) ?? null);
  }
  const { project, row } = await requireIssueAccess(db, auth, identifierValue);
  const visibleProjects = await resolveVisibleProjects(db, auth);
  const [labels, relations, comments] = await Promise.all([
    labelsForIssues(db, [row.id]),
    visibleRelations(db, row.id, new Set(visibleProjects.map((candidate) => candidate.projectId))),
    recentComments(db, row.id),
    applyVisibleBlockedState(db, [row], visibleProjects.map((candidate) => candidate.projectId)),
  ]);
  return {
    ...issueResource(row, labels.get(row.id) ?? [], project.role, true),
    comment_continuation: comments.totalCount > comments.items.length
      ? `/api/v1/issues/CFK-${row.number}/comments`
      : null,
    comments: comments.items.map(commentResource),
    relation_continuation: relations.totalCount > relations.items.length
      ? `/api/v1/issues/CFK-${row.number}/relations`
      : null,
    relations: relations.items,
  };
}

function utf8Excerpt(value: string, maxBytes: number): { content: string; omittedBytes: number; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return { content: value, omittedBytes: 0, truncated: false };
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (new TextEncoder().encode(codePoints.slice(0, middle).join("")).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const content = codePoints.slice(0, low).join("");
  return {
    content,
    omittedBytes: encoded.byteLength - new TextEncoder().encode(content).byteLength,
    truncated: true,
  };
}

export async function getIssueContext(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
): Promise<{ [key: string]: JsonValue }> {
  const { project, row } = await requireIssueAccess(db, auth, identifierValue);
  const [labels, comments, visibleProjects] = await Promise.all([
    labelsForIssues(db, [row.id]),
    recentComments(db, row.id),
    resolveVisibleProjects(db, auth),
  ]);
  await applyVisibleBlockedState(db, [row], visibleProjects.map((item) => item.projectId));
  const relationSection = await visibleRelations(
    db,
    row.id,
    new Set(visibleProjects.map((item) => item.projectId)),
    50,
  );
  let relations = relationSection.items;
  let commentItems = comments.items.map(commentResource);
  const bodyBytes = new TextEncoder().encode(row.body).byteLength;
  const projectContextValue = row.project_context ?? "";
  const projectContextBytes = new TextEncoder().encode(projectContextValue).byteLength;
  let body = utf8Excerpt(row.body, bodyBytes);
  let projectContext = utf8Excerpt(projectContextValue, projectContextBytes);
  const core = issueResource(row, labels.get(row.id) ?? [], project.role, true);
  delete core.body;
  const build = (): { [key: string]: JsonValue } => ({
    issue: core,
    sections: {
      body: {
        content: body.content,
        continuation: body.truncated ? `/api/v1/issues/CFK-${row.number}` : null,
        omitted_bytes: body.omittedBytes,
        truncated: body.truncated,
      },
      comments: {
        continuation: comments.totalCount > commentItems.length
          ? `/api/v1/issues/CFK-${row.number}/comments`
          : null,
        items: commentItems,
        omitted_count: comments.totalCount - commentItems.length,
      },
      project_context: {
        content: projectContext.content,
        continuation: projectContext.truncated
          ? `/api/v1/workspaces/${row.workspace_key}/projects/${row.project_key}`
          : null,
        omitted_bytes: projectContext.omittedBytes,
        truncated: projectContext.truncated,
      },
      relations: {
        continuation: relationSection.totalCount > relations.length
          ? `/api/v1/issues/CFK-${row.number}/relations`
          : null,
        items: relations,
        omitted_count: relationSection.totalCount - relations.length,
      },
    },
    truncated: body.truncated || projectContext.truncated
      || comments.totalCount > commentItems.length
      || relationSection.totalCount > relations.length,
  });
  let context = build();
  const contextSize = () => new TextEncoder().encode(JSON.stringify(context)).byteLength;
  const maxContextBytes = 64 * 1_024;
  while (contextSize() > maxContextBytes && commentItems.length > 0) {
    // Comments are chronological here, so the oldest entry is removed first.
    commentItems = commentItems.slice(1);
    context = build();
  }
  while (contextSize() > maxContextBytes && relations.length > 0) {
    // visibleRelations orders active blockers and parent relations first.
    relations = relations.slice(0, -1);
    context = build();
  }
  if (contextSize() > maxContextBytes) {
    body = utf8Excerpt(row.body, 0);
    projectContext = utf8Excerpt(projectContextValue, 0);
    context = build();
    const fixedBytes = contextSize();
    let available = Math.max(0, maxContextBytes - fixedBytes - 512);
    const combinedBytes = bodyBytes + projectContextBytes;
    let bodyBudget = combinedBytes === 0 ? 0 : Math.floor(available * bodyBytes / combinedBytes);
    let projectBudget = Math.max(0, available - bodyBudget);
    body = utf8Excerpt(row.body, bodyBudget);
    projectContext = utf8Excerpt(projectContextValue, projectBudget);
    context = build();
    while (contextSize() > maxContextBytes && (bodyBudget > 0 || projectBudget > 0)) {
      const excess = contextSize() - maxContextBytes;
      if (bodyBudget >= projectBudget && bodyBudget > 0) {
        bodyBudget = Math.max(0, bodyBudget - Math.max(256, excess));
        body = utf8Excerpt(row.body, bodyBudget);
      } else {
        projectBudget = Math.max(0, projectBudget - Math.max(256, excess));
        projectContext = utf8Excerpt(projectContextValue, projectBudget);
      }
      context = build();
    }
  }
  if (contextSize() > maxContextBytes) throw platformUnavailable();
  return context;
}

interface WriterGuard {
  sql: string;
  values: (string | number | null)[];
}

function buildProjectWriterGuard(
  auth: AuthContext,
  now: number,
  startIndex: number,
  projectExpression: string,
): WriterGuard {
  const currentAuth = buildCurrentAuthGuard(auth, now, startIndex);
  const ownerIndex = startIndex + currentAuth.values.length;
  const principalIndex = ownerIndex + 1;
  return {
    sql: `${currentAuth.sql}
      AND (?${ownerIndex} = 1 OR EXISTS (
        SELECT 1 FROM project_grants final_grant
        WHERE final_grant.project_id = ${projectExpression}
          AND final_grant.principal_id = ?${principalIndex}
          AND final_grant.role = 'writer' AND final_grant.revoked_at IS NULL
      ))`,
    values: [...currentAuth.values, auth.isOwner ? 1 : 0, auth.principalId],
  };
}

async function assigneeEligible(db: D1Database, projectId: string, principalId: string | null): Promise<boolean> {
  if (principalId === null) return true;
  try {
    const row = await db.prepare(
      `SELECT 1 AS eligible
       FROM principals principal
       JOIN instance_meta instance ON instance.singleton = 1
       WHERE principal.id = ?1 AND (
         principal.id = instance.owner_principal_id OR EXISTS (
           SELECT 1 FROM project_grants grant_row
           WHERE grant_row.project_id = ?2 AND grant_row.principal_id = principal.id
             AND grant_row.role = 'writer' AND grant_row.revoked_at IS NULL
         )
       )`,
    ).bind(principalId, projectId).first();
    return row !== null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function principalDisplayName(db: D1Database, principalId: string): Promise<string> {
  try {
    const row = await db.prepare(
      "SELECT display_name FROM principals WHERE id = ?1",
    ).bind(principalId).first<{ display_name: string }>();
    if (row === null) throw assigneeNotEligible();
    return row.display_name;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}

async function projectStatusDisplayName(
  db: D1Database,
  projectId: string,
  statusKey: StatusKey,
): Promise<string> {
  try {
    const row = await db.prepare(
      "SELECT display_name FROM project_status_names WHERE project_id = ?1 AND status_key = ?2",
    ).bind(projectId, statusKey).first<{ display_name: string }>();
    return row?.display_name ?? statusDefinition(statusKey).displayName;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function activeLabelsExist(db: D1Database, projectId: string, labelIds: readonly string[]): Promise<boolean> {
  if (labelIds.length === 0) return true;
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS count FROM labels
       WHERE project_id = ?1 AND deleted_at IS NULL
         AND id IN (SELECT value FROM json_each(?2))`,
    ).bind(projectId, JSON.stringify(labelIds)).first<{ count: number }>();
    return row?.count === labelIds.length;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function issueQuotaExceeded(db: D1Database, projectId: string, restoringCommentCount = 0): Promise<{
  comments: boolean;
  commentCurrent: number;
  commentLimit: number | undefined;
  issues: boolean;
  issueCurrent: number;
  issueLimit: number | undefined;
}> {
  try {
    const row = await db.prepare(
      `SELECT p.issue_limit, p.comment_limit, p.principal_limit,
              usage.active_issue_count, usage.active_comment_count,
              usage.active_principal_count,
              CASE WHEN policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL THEN 1 ELSE 0 END AS enabled
       FROM projects p
       LEFT JOIN project_usage usage ON usage.project_id = p.id
       LEFT JOIN public_join_policies policy ON policy.project_id = p.id
       WHERE p.id = ?1`,
    ).bind(projectId).first<{
      active_comment_count: number | null;
      active_issue_count: number | null;
      active_principal_count: number | null;
      comment_limit: number | null;
      enabled: number;
      issue_limit: number | null;
      principal_limit: number | null;
    }>();
    if (row === null || row.enabled !== 1) {
      return {
        comments: false,
        commentCurrent: row?.active_comment_count ?? 0,
        commentLimit: row?.comment_limit ?? undefined,
        issues: false,
        issueCurrent: row?.active_issue_count ?? 0,
        issueLimit: row?.issue_limit ?? undefined,
      };
    }
    if (
      row.active_comment_count === null
      || row.active_issue_count === null
      || row.active_principal_count === null
      || row.comment_limit === null
      || row.issue_limit === null
      || row.principal_limit === null
    ) throw platformUnavailable("d1");
    const activeCommentCount = row.active_comment_count;
    const activeIssueCount = row.active_issue_count;
    return {
      comments: restoringCommentCount > 0 && (
        activeCommentCount + restoringCommentCount > row.comment_limit
      ),
      commentCurrent: activeCommentCount,
      commentLimit: row.comment_limit,
      issues: activeIssueCount + 1 > row.issue_limit,
      issueCurrent: activeIssueCount,
      issueLimit: row.issue_limit,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}

function issueEvent(
  db: D1Database,
  auth: AuthContext,
  operationId: string,
  issueId: string,
  type: string,
  payload: JsonValue,
  now: number,
  options: {
    expectedLabelCount?: number;
    includeActiveCommentCount?: boolean;
    requireUsageCommit?: boolean;
  } = {},
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, grant_id, workspace_id,
       project_id, subject_type, subject_id, payload_json, created_at)
     SELECT ?1, 'domain', ?2, ?3, 0, ?4, ?5, ?6,
            CASE WHEN ?7 = 1 THEN NULL ELSE (
              SELECT grant_row.id FROM project_grants grant_row
              WHERE grant_row.project_id = i.project_id
                AND grant_row.principal_id = ?4
                AND grant_row.role = 'writer' AND grant_row.revoked_at IS NULL
              LIMIT 1
            ) END,
            p.workspace_id, i.project_id, 'issue', i.id,
            CASE WHEN ?13 = 1 THEN json_set(
              ?8,
              '$.released_or_restored_comments',
              (SELECT COUNT(*) FROM comments event_comment
               WHERE event_comment.issue_id = i.id AND event_comment.deleted_at IS NULL)
            ) ELSE ?8 END,
            ?9
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     LEFT JOIN project_usage usage ON usage.project_id = i.project_id
     LEFT JOIN public_join_policies policy ON policy.project_id = i.project_id
     WHERE i.id = ?10 AND i.last_operation_id = ?3
       AND (?11 < 0 OR (SELECT COUNT(*) FROM issue_labels il WHERE il.issue_id = i.id) = ?11)
       AND (?12 = 0 OR policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
            OR usage.last_operation_id = ?3)`,
  ).bind(
    crypto.randomUUID(),
    type,
    operationId,
    auth.principalId,
    actorCredentialId(auth),
    authorizedVia(auth),
    auth.isOwner ? 1 : 0,
    JSON.stringify(payload),
    now,
    issueId,
    options.expectedLabelCount ?? -1,
    options.requireUsageCommit ? 1 : 0,
    options.includeActiveCommentCount ? 1 : 0,
  );
}

async function authorizeProjectWrite(
  db: D1Database,
  auth: AuthContext,
  workspaceKey: string,
  projectKey: string,
): Promise<VisibleProject> {
  const project = await requireVisibleProject(db, auth, workspaceKey, projectKey, "writer");
  if (!cookieTargetAllowsProject(auth, workspaceKey, projectKey)) throw notFound();
  return project;
}

async function diagnoseCreateIssue(
  db: D1Database,
  auth: AuthContext,
  workspaceKey: string,
  projectKey: string,
  assigneeId: string | null,
  labelIds: readonly string[],
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const project = await authorizeProjectWrite(db, auth, workspaceKey, projectKey);
  if (!(await assigneeEligible(db, project.projectId, assigneeId))) throw assigneeNotEligible();
  if (!(await activeLabelsExist(db, project.projectId, labelIds))) throw notFound();
  const quota = await issueQuotaExceeded(db, project.projectId);
  if (quota.issues) throw businessQuotaExceeded("issues", quota.issueCurrent, quota.issueLimit);
  throw platformUnavailable("d1");
}

function requireLabelIds(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw validationError("schema_validation_failed", { field: "label_ids" });
  const ids = value.map((entry) => requireUuid(entry, "label_ids"));
  if (new Set(ids).size !== ids.length) throw validationError("schema_validation_failed", { field: "label_ids" });
  return ids;
}

function requireAssignee(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, "assignee_principal_id");
}

export async function createIssue(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  value: { [key: string]: JsonValue },
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const project = await authorizeProjectWrite(db, auth, workspaceKey, projectKey);
  const title = requireIssueTitle(value.title as JsonValue);
  const body = requireIssueBody(value.body ?? "");
  const statusKey = value.status_key === undefined
    ? "backlog"
    : WORKFLOW_STATUSES.some((status) => status.key === value.status_key)
      ? value.status_key as StatusKey
      : (() => { throw validationError("schema_validation_failed", { field: "status_key" }); })();
  if (statusKey === "done") throw invalidTransition();
  const priorityKey = value.priority_key === undefined ? "none" : requirePriorityKey(value.priority_key);
  const assigneeId = requireAssignee(value.assignee_principal_id);
  const labelIds = requireLabelIds(value.label_ids);
  const issueId = crypto.randomUUID();
  const idempotencyKey = requireIdempotencyKey(request);
  const targetAllowed = cookieTargetAllowsProject(auth, workspaceKey, projectKey) ? 1 : 0;
  const result = await runIdempotentOperation({
    authorize: async () => {
      const latest = await authorizeProjectWrite(db, auth, workspaceKey, projectKey);
      if (latest.projectId !== project.projectId) throw notFound();
    },
    db,
    execute: async (operationId) => {
      if (!(await assigneeEligible(db, project.projectId, assigneeId))) throw assigneeNotEligible();
      if (!(await activeLabelsExist(db, project.projectId, labelIds))) throw notFound();
      const quota = await issueQuotaExceeded(db, project.projectId);
      if (quota.issues) throw businessQuotaExceeded("issues", quota.issueCurrent, quota.issueLimit);
      const guard = buildProjectWriterGuard(auth, now, 16, "p.id");
      const insert = db.prepare(
        `INSERT INTO issues
          (id, project_id, title, title_search, body, status_key,
           priority_key, priority_rank, assignee_principal_id, version,
           created_at, updated_at, created_by_principal_id,
           updated_by_principal_id, created_operation_id, last_operation_id)
         SELECT ?1, p.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1,
                ?9, ?9, ?10, ?10, ?11, ?11
         FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
         LEFT JOIN project_usage usage ON usage.project_id = p.id
         LEFT JOIN public_join_policies policy ON policy.project_id = p.id
         WHERE p.id = ?12 AND p.deleted_at IS NULL AND w.deleted_at IS NULL
           AND (SELECT COUNT(*) FROM labels label_row
                WHERE label_row.project_id = p.id AND label_row.deleted_at IS NULL
                  AND label_row.id IN (SELECT value FROM json_each(?13))) = ?14
           AND ?15 = 1 AND ${guard.sql}
           AND (?8 IS NULL OR ?8 = (SELECT owner_principal_id FROM instance_meta WHERE singleton = 1)
                OR EXISTS (SELECT 1 FROM project_grants eligible_grant
                           WHERE eligible_grant.project_id = p.id
                             AND eligible_grant.principal_id = ?8
                             AND eligible_grant.role = 'writer'
                             AND eligible_grant.revoked_at IS NULL))
           AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL
                OR (p.issue_limit IS NOT NULL AND usage.active_issue_count < p.issue_limit))`,
      ).bind(
        issueId, title, issueTitleSearch(title), body, statusKey, priorityKey,
        priorityRank(priorityKey), assigneeId, now, auth.principalId, operationId,
        project.projectId, JSON.stringify(labelIds), labelIds.length, targetAllowed,
        ...guard.values,
      );
      const labels = db.prepare(
        `INSERT INTO issue_labels
          (issue_id, label_id, added_at, added_by_principal_id, created_operation_id)
         SELECT issue.id, label_row.id, ?1, ?2, ?3
         FROM issues issue
         JOIN json_each(?4) requested_label
         JOIN labels label_row
           ON label_row.id = requested_label.value
          AND label_row.project_id = issue.project_id
         WHERE issue.id = ?5 AND issue.last_operation_id = ?3
           AND label_row.deleted_at IS NULL`,
      ).bind(now, auth.principalId, operationId, JSON.stringify(labelIds), issueId);
      const usage = db.prepare(
        `UPDATE project_usage SET active_issue_count = active_issue_count + 1,
                updated_at = ?1, last_operation_id = ?2
         WHERE project_id = ?3
           AND EXISTS (SELECT 1 FROM issues WHERE id = ?4 AND last_operation_id = ?2)
           AND EXISTS (SELECT 1 FROM public_join_policies policy
                       WHERE policy.project_id = ?3
                         AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL)`,
      ).bind(now, operationId, project.projectId, issueId);
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            insert,
            labels,
            usage,
            issueOperationSnapshotStatement(
              db,
              operationId,
              issueId,
              project.role,
            ),
            issueEvent(db, auth, operationId, issueId, "issue.created", {
              identifier_pending: true,
              project_key: projectKey,
              workspace_key: workspaceKey,
            }, now, { expectedLabelCount: labelIds.length, requireUsageCommit: true }),
          ],
          committedAt: now,
          confirmBusinessRejection: async () => {
            try {
              await diagnoseCreateIssue(db, auth, workspaceKey, projectKey, assigneeId, labelIds, now);
            } catch (error) {
              return error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE";
            }
            return false;
          },
          expectedEventCount: 1,
          operationId,
          primarySubjectId: issueId,
          primarySubjectType: "issue",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          return diagnoseCreateIssue(db, auth, workspaceKey, projectKey, assigneeId, labelIds, now);
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `workspace:${workspaceKey}:project:${projectKey}:issue`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readIssueOperationSnapshot(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          await issueSnapshotResource(db, auth, snapshot),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    replay: (stored) => currentIssueReplayProjection(db, auth, stored),
    requestBody: {
      assignee_principal_id: assigneeId,
      body,
      label_ids: labelIds,
      priority_key: priorityKey,
      status_key: statusKey,
      title,
    },
    routeTemplate: "/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

async function diagnoseIssueCas(
  db: D1Database,
  auth: AuthContext,
  identifier: string,
  expectedVersion: number,
  now: number,
  expectedDeleted: boolean,
  assigneeId?: string | null,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  const { row } = expectedDeleted
    ? await requireIssueRecoveryAccess(db, auth, identifier)
    : await requireIssueAccess(db, auth, identifier, "writer", true);
  if ((row.deleted_at !== null) !== expectedDeleted) {
    throw conflict(
      expectedDeleted ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED",
      "refresh_resource",
      { current_version: row.version },
    );
  }
  if (row.version !== expectedVersion) throw versionConflict(row.version);
  if (expectedDeleted) requireActiveIssueParents(row);
  if (assigneeId !== undefined && !(await assigneeEligible(db, row.project_id, assigneeId))) {
    throw assigneeNotEligible();
  }
  throw platformUnavailable("d1");
}

export async function updateIssue(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  value: { [key: string]: JsonValue },
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const identifier = requireIssueIdentifier(identifierValue);
  const { project, row } = await requireIssueAccess(db, auth, identifier, "writer");
  const hasTitle = value.title !== undefined;
  const hasBody = value.body !== undefined;
  const hasStatus = value.status_key !== undefined;
  const hasPriority = value.priority_key !== undefined;
  const hasAssignee = Object.hasOwn(value, "assignee_principal_id");
  if (!hasTitle && !hasBody && !hasStatus && !hasPriority && !hasAssignee) {
    throw validationError("update_field_required");
  }
  const title = hasTitle ? requireIssueTitle(value.title as JsonValue) : row.title;
  const body = hasBody ? requireIssueBody(value.body as JsonValue) : row.body;
  let statusKey = row.status_key;
  if (hasStatus) {
    if (!WORKFLOW_STATUSES.some((status) => status.key === value.status_key)) {
      throw validationError("schema_validation_failed", { field: "status_key" });
    }
    statusKey = value.status_key as StatusKey;
    if (statusKey === "done") throw invalidTransition();
  }
  const priorityKey = hasPriority ? requirePriorityKey(value.priority_key as JsonValue) : row.priority_key;
  const assigneeId = hasAssignee ? requireAssignee(value.assignee_principal_id) : row.assignee_principal_id;
  if (hasAssignee && !(await assigneeEligible(db, row.project_id, assigneeId))) throw assigneeNotEligible();
  const [labels, visibleProjects, assigneeDisplayName, statusDisplayName] = await Promise.all([
    labelsForIssues(db, [row.id]),
    resolveVisibleProjects(db, auth),
    hasAssignee && assigneeId !== null
      ? principalDisplayName(db, assigneeId)
      : Promise.resolve(row.assignee_display_name),
    hasStatus
      ? projectStatusDisplayName(db, row.project_id, statusKey)
      : Promise.resolve(row.status_display_name),
  ]);
  await applyVisibleBlockedState(db, [row], visibleProjects.map((visibleProject) => visibleProject.projectId));
  const operationId = crypto.randomUUID();
  const targetAllowed = cookieTargetAllowsProject(auth, row.workspace_key, row.project_key) ? 1 : 0;
  const guard = buildProjectWriterGuard(auth, now, 19, "issues.project_id");
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE issues SET
             title = CASE WHEN ?1 = 1 THEN ?2 ELSE title END,
             title_search = CASE WHEN ?1 = 1 THEN ?3 ELSE title_search END,
             body = CASE WHEN ?4 = 1 THEN ?5 ELSE body END,
             status_key = CASE WHEN ?6 = 1 THEN ?7 ELSE status_key END,
             priority_key = CASE WHEN ?8 = 1 THEN ?9 ELSE priority_key END,
             priority_rank = CASE WHEN ?8 = 1 THEN ?10 ELSE priority_rank END,
             assignee_principal_id = CASE WHEN ?11 = 1 THEN ?12 ELSE assignee_principal_id END,
             version = version + 1, updated_at = ?13,
             updated_by_principal_id = ?14, last_operation_id = ?15
           WHERE id = ?16 AND version = ?17 AND deleted_at IS NULL AND ?18 = 1
             AND EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id
                         WHERE p.id = issues.project_id AND p.deleted_at IS NULL AND w.deleted_at IS NULL)
             AND ${guard.sql}
             AND (?11 = 0 OR ?12 IS NULL
                  OR ?12 = (SELECT owner_principal_id FROM instance_meta WHERE singleton = 1)
                  OR EXISTS (SELECT 1 FROM project_grants eligible_grant
                             WHERE eligible_grant.project_id = issues.project_id
                               AND eligible_grant.principal_id = ?12
                               AND eligible_grant.role = 'writer'
                               AND eligible_grant.revoked_at IS NULL))`,
        ).bind(
          hasTitle ? 1 : 0, title, issueTitleSearch(title),
          hasBody ? 1 : 0, body,
          hasStatus ? 1 : 0, statusKey,
          hasPriority ? 1 : 0, priorityKey, priorityRank(priorityKey),
          hasAssignee ? 1 : 0, assigneeId,
          now, auth.principalId, operationId, row.id, expectedVersion, targetAllowed,
          ...guard.values,
        ),
        issueEvent(db, auth, operationId, row.id, "issue.updated", {
          assignee_changed: hasAssignee,
          body_changed: hasBody,
          priority_changed: hasPriority,
          status_changed: hasStatus,
          ...(hasStatus ? {
            new_status_key: statusKey,
            old_status_key: row.status_key,
          } : {}),
          title_changed: hasTitle,
        }, now),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        try {
          await diagnoseIssueCas(db, auth, identifier, expectedVersion, now, false, hasAssignee ? assigneeId : undefined);
        } catch (error) {
          return error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE";
        }
        return false;
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: row.id,
      primarySubjectType: "issue",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnoseIssueCas(db, auth, identifier, expectedVersion, now, false, hasAssignee ? assigneeId : undefined);
    }
    throw error;
  }
  const updated: IssueRow = {
    ...row,
    assignee_available: assigneeId === null
      ? 0
      : hasAssignee
        ? 1
        : row.assignee_available,
    assignee_display_name: assigneeId === null ? null : assigneeDisplayName,
    assignee_principal_id: assigneeId,
    body,
    priority_key: priorityKey,
    priority_rank: priorityRank(priorityKey),
    status_display_name: statusDisplayName,
    status_key: statusKey,
    title,
    updated_at: now,
    version: expectedVersion + 1,
  };
  return writeResult(
    db,
    auth,
    issueResource(updated, labels.get(updated.id) ?? [], project.role, true),
    commit.lastEventSequence,
    false,
  );
}

async function activeCommentCount(db: D1Database, issueId: string): Promise<number> {
  try {
    const row = await db.prepare(
      "SELECT COUNT(*) AS count FROM comments WHERE issue_id = ?1 AND deleted_at IS NULL",
    ).bind(issueId).first<{ count: number }>();
    return row?.count ?? 0;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

async function setIssueDeleted(
  db: D1Database,
  auth: AuthContext,
  identifier: string,
  expectedVersion: number,
  now: number,
  deleted: boolean,
  operationId: string,
  snapshot: { role: ProjectAccessRole } | null = null,
): Promise<OperationCommit> {
  const { row } = deleted
    ? await requireIssueAccess(db, auth, identifier, "writer", true)
    : await requireIssueRecoveryAccess(db, auth, identifier);
  const targetAllowed = cookieTargetAllowsProject(auth, row.workspace_key, row.project_key) ? 1 : 0;
  const guard = buildProjectWriterGuard(auth, now, 9, "issues.project_id");
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE issues SET deleted_at = ?1, deleted_by_principal_id = ?2,
                  version = version + 1, updated_at = ?3,
                  updated_by_principal_id = ?4, last_operation_id = ?5
           WHERE id = ?6 AND version = ?7 AND ?8 = 1
             AND deleted_at IS ${deleted ? "NULL" : "NOT NULL"}
             AND EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id
                         WHERE p.id = issues.project_id AND p.deleted_at IS NULL AND w.deleted_at IS NULL)
             AND ${guard.sql}
             ${deleted ? "" : `AND EXISTS (
               SELECT 1 FROM projects quota_project
               LEFT JOIN project_usage usage ON usage.project_id = quota_project.id
               LEFT JOIN public_join_policies policy ON policy.project_id = quota_project.id
               WHERE quota_project.id = issues.project_id
                 AND (policy.enabled_at IS NULL OR policy.disabled_at IS NOT NULL OR (
                   quota_project.issue_limit IS NOT NULL
                   AND usage.active_issue_count < quota_project.issue_limit
                   AND (
                     (SELECT COUNT(*) FROM comments c
                      WHERE c.issue_id = issues.id AND c.deleted_at IS NULL) = 0
                     OR (
                       quota_project.comment_limit IS NOT NULL
                       AND usage.active_comment_count +
                         (SELECT COUNT(*) FROM comments c
                          WHERE c.issue_id = issues.id AND c.deleted_at IS NULL)
                         <= quota_project.comment_limit
                     )
                   )
                 ))
             )`}`,
        ).bind(
          deleted ? now : null,
          deleted ? auth.principalId : null,
          now,
          auth.principalId,
          operationId,
          row.id,
          expectedVersion,
          targetAllowed,
          ...guard.values,
        ),
        db.prepare(
          `UPDATE project_usage SET
             active_issue_count = ${deleted
               ? "CASE WHEN active_issue_count > 0 THEN active_issue_count - 1 ELSE 0 END"
               : "active_issue_count + 1"},
             active_comment_count = ${deleted
               ? `active_comment_count - (
                   SELECT COUNT(*) FROM comments usage_comment
                   WHERE usage_comment.issue_id = ?1 AND usage_comment.deleted_at IS NULL
                 )`
               : `active_comment_count + (
                   SELECT COUNT(*) FROM comments usage_comment
                   WHERE usage_comment.issue_id = ?1 AND usage_comment.deleted_at IS NULL
                 )`},
             updated_at = ?2, last_operation_id = ?3
           WHERE project_id = ?4
             AND EXISTS (SELECT 1 FROM issues issue_row
                         WHERE issue_row.id = ?5 AND issue_row.last_operation_id = ?3)
             AND EXISTS (SELECT 1 FROM public_join_policies policy
                         WHERE policy.project_id = ?4
                           AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL)`,
        ).bind(row.id, now, operationId, row.project_id, row.id),
        ...(snapshot === null ? [] : [issueOperationSnapshotStatement(
          db,
          operationId,
          row.id,
          snapshot.role,
        )]),
        issueEvent(
          db,
          auth,
          operationId,
          row.id,
          deleted ? "issue.deleted" : "issue.restored",
          { identifier },
          now,
          { includeActiveCommentCount: true, requireUsageCommit: true },
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        try {
          await diagnoseIssueCas(db, auth, identifier, expectedVersion, now, !deleted);
          return false;
        } catch (error) {
          if (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE") return true;
          if (!deleted) {
            const quota = await issueQuotaExceeded(db, row.project_id, await activeCommentCount(db, row.id));
            if (quota.issues || quota.comments) return true;
          }
          return false;
        }
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: row.id,
      primarySubjectType: "issue",
      requireIdempotencySnapshot: snapshot !== null,
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = deleted
        ? await requireIssueAccess(db, auth, identifier, "writer", true)
        : await requireIssueRecoveryAccess(db, auth, identifier);
      if ((latest.row.deleted_at !== null) !== (!deleted)) {
        throw conflict(
          deleted ? "RESOURCE_DELETED" : "RESOURCE_NOT_DELETED",
          "refresh_resource",
          { current_version: latest.row.version },
        );
      }
      if (latest.row.version !== expectedVersion) throw versionConflict(latest.row.version);
      if (!deleted) {
        requireActiveIssueParents(latest.row);
        const quota = await issueQuotaExceeded(db, latest.row.project_id, await activeCommentCount(db, latest.row.id));
        if (quota.issues) throw businessQuotaExceeded("issues", quota.issueCurrent, quota.issueLimit);
        if (quota.comments) throw businessQuotaExceeded("comments", quota.commentCurrent, quota.commentLimit);
      }
      throw platformUnavailable("d1");
    }
    throw error;
  }
}

export async function deleteIssue(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const identifier = requireIssueIdentifier(identifierValue);
  const { project, row } = await requireIssueAccess(db, auth, identifier, "writer", true);
  const [labels, visibleProjects] = await Promise.all([
    labelsForIssues(db, [row.id]),
    resolveVisibleProjects(db, auth),
  ]);
  await applyVisibleBlockedState(db, [row], visibleProjects.map((visibleProject) => visibleProject.projectId));
  const commit = await setIssueDeleted(db, auth, identifier, expectedVersion, now, true, crypto.randomUUID());
  const deleted: IssueRow = {
    ...row,
    deleted_at: now,
    deleted_by_principal_id: auth.principalId,
    updated_at: now,
    version: expectedVersion + 1,
  };
  const quotas = await tombstoneQuotaRows(db, [deleted.id]);
  return writeResult(
    db,
    auth,
    issueTombstoneResource(deleted, project.role, quotas.get(deleted.id) ?? null),
    commit.lastEventSequence,
    false,
  );
}

export async function restoreIssue(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const identifier = requireIssueIdentifier(identifierValue);
  const initial = await requireIssueRecoveryAccess(db, auth, identifier);
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      const latest = await requireIssueRecoveryAccess(db, auth, identifier);
      if (latest.row.project_id !== initial.row.project_id) throw notFound();
    },
    db,
    execute: async (operationId) => {
      await setIssueDeleted(db, auth, identifier, expectedVersion, now, false, operationId, {
        role: initial.project.role,
      });
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `issue:${identifier}:restore`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readIssueOperationSnapshot(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          await issueSnapshotResource(db, auth, snapshot),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    replay: (stored) => currentIssueReplayProjection(db, auth, stored),
    requestBody: { expected_version: expectedVersion },
    routeTemplate: "/api/v1/issues/{identifier}/commands/restore",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

interface IssueCommandInput {
  assignToPrincipalId?: string;
  blockedReason?: string | null;
  eventType: string;
  requestBody: { [key: string]: JsonValue };
  routeTemplate: string;
}

async function runIssueCommand(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  expectedVersion: number,
  input: IssueCommandInput,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const identifier = requireIssueIdentifier(identifierValue);
  const initial = await requireIssueAccess(db, auth, identifier, "writer", true);
  const assigneeChanged = input.assignToPrincipalId !== undefined;
  const blockedChanged = input.blockedReason !== undefined;
  const idempotencyKey = requireIdempotencyKey(request);
  const targetAllowed = cookieTargetAllowsProject(
    auth,
    initial.row.workspace_key,
    initial.row.project_key,
  ) ? 1 : 0;
  const result = await runIdempotentOperation({
    authorize: async () => {
      const latest = await requireIssueAccess(db, auth, identifier, "writer", true);
      if (latest.row.project_id !== initial.row.project_id) throw notFound();
    },
    db,
    execute: async (operationId) => {
      const guard = buildProjectWriterGuard(auth, now, 11, "issues.project_id");
      try {
        await executeAtomicBatch(db, {
          businessStatements: [
            db.prepare(
              `UPDATE issues SET
                 assignee_principal_id = CASE WHEN ?1 = 1 THEN ?2 ELSE assignee_principal_id END,
                 blocked_reason = CASE WHEN ?3 = 1 THEN ?4 ELSE blocked_reason END,
                 version = version + 1, updated_at = ?5,
                 updated_by_principal_id = ?6, last_operation_id = ?7
               WHERE id = ?8 AND version = ?9 AND deleted_at IS NULL AND ?10 = 1
                 AND EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id
                             WHERE p.id = issues.project_id AND p.deleted_at IS NULL AND w.deleted_at IS NULL)
                 AND ${guard.sql}
                 AND (?1 = 0 OR ?2 = (SELECT owner_principal_id FROM instance_meta WHERE singleton = 1)
                      OR EXISTS (SELECT 1 FROM project_grants eligible_grant
                                 WHERE eligible_grant.project_id = issues.project_id
                                   AND eligible_grant.principal_id = ?2
                                   AND eligible_grant.role = 'writer'
                                   AND eligible_grant.revoked_at IS NULL))`,
              ).bind(
              assigneeChanged ? 1 : 0,
              input.assignToPrincipalId ?? null,
              blockedChanged ? 1 : 0,
              input.blockedReason ?? null,
              now,
              auth.principalId,
              operationId,
              initial.row.id,
              expectedVersion,
              targetAllowed,
                ...guard.values,
              ),
              issueOperationSnapshotStatement(
                db,
                operationId,
                initial.row.id,
                initial.project.role,
              ),
              issueEvent(db, auth, operationId, initial.row.id, input.eventType, {
              assignee_changed: assigneeChanged,
              blocked_reason_changed: blockedChanged,
              identifier,
            }, now),
          ],
          committedAt: now,
          confirmBusinessRejection: async () => {
            try {
              await diagnoseIssueCas(
                db,
                auth,
                identifier,
                expectedVersion,
                now,
                false,
                assigneeChanged ? input.assignToPrincipalId : undefined,
              );
            } catch (error) {
              return error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE";
            }
            return false;
          },
          expectedEventCount: 1,
          operationId,
          primarySubjectId: initial.row.id,
          primarySubjectType: "issue",
          requireIdempotencySnapshot: true,
        });
      } catch (error) {
        if (error instanceof AtomicBatchRejectedError) {
          return diagnoseIssueCas(
            db,
            auth,
            identifier,
            expectedVersion,
            now,
            false,
            assigneeChanged ? input.assignToPrincipalId : undefined,
          );
        }
        throw error;
      }
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `issue:${identifier}:${input.eventType}`,
    now,
    readback: async (operationId, commit) => {
      const snapshot = await readIssueOperationSnapshot(db, operationId);
      return {
        body: await writeResult(
          db,
          auth,
          await issueSnapshotResource(db, auth, snapshot),
          commit.lastEventSequence,
          false,
        ),
        status: 200,
      };
    },
    replay: (stored) => currentIssueReplayProjection(db, auth, stored),
    requestBody: input.requestBody,
    routeTemplate: input.routeTemplate,
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function assignIssueToMe(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  return runIssueCommand(db, request, auth, identifierValue, expectedVersion, {
    assignToPrincipalId: auth.principalId,
    eventType: "issue.assigned-to-self",
    requestBody: { expected_version: expectedVersion },
    routeTemplate: "/api/v1/issues/{identifier}/commands/assign-to-me",
  }, now);
}

export async function reportIssueBlocked(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  expectedVersion: number,
  reasonValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const reason = requireBlockedReason(reasonValue);
  return runIssueCommand(db, request, auth, identifierValue, expectedVersion, {
    blockedReason: reason,
    eventType: "issue.blocked-reported",
    requestBody: { expected_version: expectedVersion, reason },
    routeTemplate: "/api/v1/issues/{identifier}/commands/report-blocked",
  }, now);
}

export async function clearIssueBlocked(
  db: D1Database,
  request: Request,
  auth: AuthContext,
  identifierValue: JsonValue,
  expectedVersion: number,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  return runIssueCommand(db, request, auth, identifierValue, expectedVersion, {
    blockedReason: null,
    eventType: "issue.blocked-cleared",
    requestBody: { expected_version: expectedVersion },
    routeTemplate: "/api/v1/issues/{identifier}/commands/clear-blocked",
  }, now);
}
