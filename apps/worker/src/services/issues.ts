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
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
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
import { runIdempotentOperation } from "../kernel/idempotency.ts";
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
  project_display_name: string;
  project_id: string;
  project_key: string;
  status_display_name: string;
  status_key: StatusKey;
  title: string;
  updated_at: number;
  version: number;
  workspace_display_name: string;
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

interface RelationRow {
  id: string;
  kind: "blocks" | "duplicate" | "parent" | "related";
  source_number: number;
  source_project_id: string;
  target_number: number;
  target_project_id: string;
  version: number;
}

interface IssueScope {
  broad: boolean;
  projectTargets: string[];
  projects: VisibleProject[];
  targetIdentifier: string | null;
  unresolvedProjectTargets: string[];
  unresolvedWorkspaceTargets: string[];
  workspaceTargets: string[];
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

const ISSUE_SELECT = `
  SELECT i.id, i.number, i.project_id, i.title, i.body, i.status_key,
         i.priority_key, i.priority_rank, i.assignee_principal_id,
         i.blocked_reason, i.version, i.deleted_at, i.created_at, i.updated_at,
         i.deleted_by_principal_id,
         p.key AS project_key, p.display_name AS project_display_name,
         p.context AS project_context, w.id AS workspace_id,
         w.key AS workspace_key, w.display_name AS workspace_display_name,
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
         CASE WHEN i.blocked_reason IS NOT NULL OR EXISTS (
           SELECT 1
           FROM issue_relations blocked_relation
           JOIN issues blocker ON blocker.id = blocked_relation.source_issue_id
           JOIN projects blocker_project ON blocker_project.id = blocker.project_id
           JOIN workspaces blocker_workspace ON blocker_workspace.id = blocker_project.workspace_id
           WHERE blocked_relation.target_issue_id = i.id
             AND blocked_relation.kind = 'blocks'
             AND blocked_relation.deleted_at IS NULL
             AND blocker.deleted_at IS NULL AND blocker.status_key <> 'done'
             AND blocker_project.deleted_at IS NULL AND blocker_workspace.deleted_at IS NULL
         ) THEN 1 ELSE 0 END AS is_blocked
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
  if (auth.targetKind === "issue") return false;
  return auth.target.workspace_key === workspaceKey && auth.target.project_key === projectKey;
}

function cookieTargetAllowsIssue(
  auth: AuthContext,
  identifier: string,
  workspaceKey: string,
  projectKey: string,
): boolean {
  if (auth.kind === "bearer") return true;
  if (auth.targetKind === "issue") return auth.target.identifier === identifier;
  return cookieTargetAllowsProject(auth, workspaceKey, projectKey);
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
  includeDeletedTarget = false,
): Promise<IssueScope> {
  const projectTargets = repeatedTargets(url, "project");
  const workspaceTargets = repeatedTargets(url, "workspace");
  const parsedProjects = projectTargets.map((target) => ({ target, ...parseProjectTarget(target) }));
  const parsedWorkspaces = workspaceTargets.map((target) => ({
    target,
    workspaceKey: requireWorkspaceKey(target, "workspace"),
  }));
  let projects = await resolveVisibleProjects(db, auth);
  const targetIdentifier = issueTarget(auth);
  if (targetIdentifier !== null) {
    const targetNumber = targetIdentifier === "invalid" ? -1 : issueNumber(targetIdentifier);
    let projectId: string | null = null;
    try {
      const row = await db.prepare(
        `SELECT i.project_id FROM issues i
         JOIN projects p ON p.id = i.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         WHERE i.number = ?1 ${includeDeletedTarget ? "" : "AND i.deleted_at IS NULL"}
           AND p.deleted_at IS NULL AND w.deleted_at IS NULL`,
      ).bind(targetNumber).first<{ project_id: string }>();
      projectId = row?.project_id ?? null;
    } catch {
      throw platformUnavailable("d1");
    }
    projects = projects.filter((project) => project.projectId === projectId);
  }
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

function parseOrdinaryCursor(value: JsonValue[] | null): [number, number] | null {
  if (
    value === null
    || (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number")
  ) return value as [number, number] | null;
  throw invalidCursor();
}

function parseCandidateCursor(value: JsonValue[] | null): [number, number, number] | null {
  if (
    value === null
    || (value.length === 3 && value.every((entry) => typeof entry === "number"))
  ) return value as [number, number, number] | null;
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
  } catch {
    throw platformUnavailable("d1");
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
  } catch {
    throw platformUnavailable("d1");
  }
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
): { [key: string]: JsonValue } {
  return {
    ...issueResource(row, [], role),
    allowed_actions: roleCanWrite(role) ? ["restore"] : [],
    deleted_by_principal_id: row.deleted_by_principal_id,
    parent_status: {
      project: "active",
      workspace: "active",
    },
    restorable: roleCanWrite(role),
    unavailability_reason: null,
  };
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
  if (row === null || !cookieTargetAllowsIssue(auth, identifier, row.workspace_key, row.project_key)) throw notFound();
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

function resolvedScope(
  scope: IssueScope,
  search: SearchFilter,
  candidate: CandidateFilter | null,
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
  principalId: string,
  deletionView: "exclude" | "only",
): Promise<{ hasMore: boolean; rows: IssueRow[]; nextCursor: string | null }> {
  const candidates = candidate !== null;
  const limit = requireLimit(url);
  const filter: JsonValue = {
    candidate: candidates,
    candidate_assignment: candidate?.assignment ?? null,
    candidate_blocked: candidate?.blocked ?? null,
    deleted: deletionView,
    project_targets: [...scope.projectTargets].sort(),
    q: search.normalized,
    target_identifier: scope.targetIdentifier,
    workspace_targets: [...scope.workspaceTargets].sort(),
  };
  const cursorContext = await createCursorContext(
    candidates ? "issue-candidates" : "issues",
    filter,
    scope.projects.map((project) => project.projectId),
  );
  const projectIds = scope.projects.map((project) => project.projectId);
  if (projectIds.length === 0) {
    decodeCursor(url.searchParams.get("cursor"), cursorContext);
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
  const targetNumber = scope.targetIdentifier === null ? null : issueNumber(scope.targetIdentifier);
  let rows: IssueRow[];
  let hasMore: boolean;
  let nextCursor: string | null = null;
  try {
    if (candidates) {
      const cursor = parseCandidateCursor(decodeCursor(url.searchParams.get("cursor"), cursorContext));
      const result = await db.prepare(
        `${ISSUE_SELECT}
         WHERE i.project_id IN (SELECT value FROM json_each(?1))
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
               AND blocker_project.deleted_at IS NULL AND blocker_workspace.deleted_at IS NULL
           )` : ""}
           AND (
             (?8 = 'unassigned' AND i.assignee_principal_id IS NULL)
             OR (?8 = 'mine' AND i.assignee_principal_id = ?9)
             OR (?8 = 'needs_reassignment'
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
           AND (?2 IS NULL OR i.number = ?2)
           AND (?4 IS NULL OR (?3 IS NOT NULL AND i.number = ?3) OR instr(i.title_search, ?4) > 0)
           AND (?5 IS NULL OR i.priority_rank > ?5
                OR (i.priority_rank = ?5 AND i.created_at > ?6)
                OR (i.priority_rank = ?5 AND i.created_at = ?6 AND i.number > ?7))
         ORDER BY i.priority_rank ASC, i.created_at ASC, i.number ASC
         LIMIT ?10`,
      ).bind(
        JSON.stringify(projectIds), targetNumber, search.number, search.normalized,
        cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null,
        candidate.assignment, principalId, limit + 1,
      ).all<IssueRow>();
      rows = result.results;
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
      const tail = rows.at(-1);
      if (hasMore && tail !== undefined) {
        nextCursor = encodeCursor(cursorContext, [tail.priority_rank, tail.created_at, tail.number]);
      }
    } else {
      const cursor = parseOrdinaryCursor(decodeCursor(url.searchParams.get("cursor"), cursorContext));
      const result = await db.prepare(
        `${ISSUE_SELECT}
         WHERE i.project_id IN (SELECT value FROM json_each(?1))
           AND i.deleted_at IS ${deletionView === "only" ? "NOT NULL" : "NULL"}
           AND p.deleted_at IS NULL AND w.deleted_at IS NULL
           AND (?2 IS NULL OR i.number = ?2)
           AND (?4 IS NULL OR (?3 IS NOT NULL AND i.number = ?3) OR instr(i.title_search, ?4) > 0)
           AND (?5 IS NULL OR ${deletionView === "only" ? "i.deleted_at" : "i.updated_at"} < ?5
                OR (${deletionView === "only" ? "i.deleted_at" : "i.updated_at"} = ?5 AND i.number < ?6))
         ORDER BY ${deletionView === "only" ? "i.deleted_at" : "i.updated_at"} DESC, i.number DESC
         LIMIT ?7`,
      ).bind(
        JSON.stringify(projectIds), targetNumber, search.number, search.normalized,
        cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1,
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
    throw platformUnavailable("d1");
  }
  return { hasMore, nextCursor, rows };
}

async function listIssuesInternal(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  candidates: boolean,
  forcedProject: VisibleProject | null = null,
): Promise<{ [key: string]: JsonValue }> {
  const deletionView = candidates ? "exclude" : issueDeletionView(url);
  let scope = await resolveIssueScope(db, auth, url, forcedProject, deletionView === "only");
  if (deletionView === "only") {
    if (forcedProject?.role === "reader") throw forbidden();
    scope = { ...scope, projects: scope.projects.filter((project) => roleCanWrite(project.role)) };
  }
  const search = searchFilter(url);
  const candidate = candidates ? requireCandidateFilter(url) : null;
  const page = await listIssueRows(
    db,
    scope,
    search,
    url,
    candidate,
    auth.principalId,
    deletionView,
  );
  const labels = deletionView === "only"
    ? new Map<string, LabelRow[]>()
    : await labelsForIssues(db, page.rows.map((row) => row.id));
  const roles = new Map(scope.projects.map((project) => [project.projectId, project.role]));
  return {
    has_more: page.hasMore,
    items: page.rows.map((row) => deletionView === "only"
      ? issueTombstoneResource(row, roles.get(row.project_id) ?? "reader")
      : issueResource(row, labels.get(row.id) ?? [], roles.get(row.project_id) ?? "reader")),
    next_cursor: page.nextCursor,
    resolved_scope: resolvedScope(scope, search, candidate),
  };
}

export async function listIssues(
  db: D1Database,
  auth: AuthContext,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  return listIssuesInternal(db, auth, url, false);
}

export async function listIssueCandidates(
  db: D1Database,
  auth: AuthContext,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  return listIssuesInternal(db, auth, url, true);
}

export async function listProjectIssues(
  db: D1Database,
  auth: AuthContext,
  workspaceKeyValue: JsonValue,
  projectKeyValue: JsonValue,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const workspaceKey = requireWorkspaceKey(workspaceKeyValue, "workspace_key");
  const projectKey = requireProjectKey(projectKeyValue, "project_key");
  const project = await requireVisibleProject(db, auth, workspaceKey, projectKey);
  const targetIdentifier = issueTarget(auth);
  if (!cookieTargetAllowsProject(auth, workspaceKey, projectKey)) {
    if (targetIdentifier === null || targetIdentifier === "invalid") throw notFound();
    const target = await readIssueRow(db, issueNumber(targetIdentifier));
    if (target === null || target.project_id !== project.projectId) throw notFound();
  }
  return listIssuesInternal(db, auth, url, false, project);
}

async function visibleRelations(
  db: D1Database,
  issueId: string,
  visibleProjectIds: ReadonlySet<string>,
): Promise<{ [key: string]: JsonValue }[]> {
  try {
    const result = await db.prepare(
      `SELECT r.id, r.kind, source.project_id AS source_project_id,
              source.number AS source_number, target.project_id AS target_project_id,
              target.number AS target_number, r.version
       FROM issue_relations r
       JOIN issues source ON source.id = r.source_issue_id
       JOIN issues target ON target.id = r.target_issue_id
       WHERE (r.source_issue_id = ?1 OR r.target_issue_id = ?1)
         AND r.deleted_at IS NULL AND source.deleted_at IS NULL AND target.deleted_at IS NULL
       ORDER BY r.created_at, r.id`,
    ).bind(issueId).all<RelationRow>();
    return result.results
      .filter((row) => visibleProjectIds.has(row.source_project_id) && visibleProjectIds.has(row.target_project_id))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        source_identifier: `CFK-${row.source_number}`,
        target_identifier: `CFK-${row.target_number}`,
        version: row.version,
      }));
  } catch {
    throw platformUnavailable("d1");
  }
}

async function recentComments(db: D1Database, issueId: string): Promise<{ hasMore: boolean; rows: CommentRow[] }> {
  try {
    const result = await db.prepare(
      `SELECT c.id, c.kind, c.body, c.author_principal_id,
              author.display_name AS author_display_name, c.version, c.created_at
       FROM comments c JOIN principals author ON author.id = c.author_principal_id
       WHERE c.issue_id = ?1 AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC, c.id DESC LIMIT 11`,
    ).bind(issueId).all<CommentRow>();
    return { hasMore: result.results.length > 10, rows: result.results.slice(0, 10).reverse() };
  } catch {
    throw platformUnavailable("d1");
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
  const { project, row } = await requireIssueAccess(
    db,
    auth,
    identifierValue,
    deletionView === "only" ? "writer" : "reader",
    deletionView === "only",
  );
  if (deletionView === "only") {
    if (row.deleted_at === null) throw notFound();
    return issueTombstoneResource(row, project.role);
  }
  const [labels, relations, comments, visible] = await Promise.all([
    labelsForIssues(db, [row.id]),
    resolveVisibleProjects(db, auth).then((projects) => visibleRelations(
      db,
      row.id,
      new Set(projects.map((candidate) => candidate.projectId)),
    )),
    recentComments(db, row.id),
    Promise.resolve(project),
  ]);
  return {
    ...issueResource(row, labels.get(row.id) ?? [], visible.role, true),
    comment_continuation: comments.hasMore ? `/api/v1/issues/CFK-${row.number}/comments` : null,
    comments: comments.rows.map(commentResource),
    relations,
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
  let relations = await visibleRelations(db, row.id, new Set(visibleProjects.map((item) => item.projectId)));
  let commentItems = comments.rows.map(commentResource);
  let body = utf8Excerpt(row.body, 16 * 1_024);
  let projectContext = utf8Excerpt(row.project_context ?? "", 12 * 1_024);
  const core = issueResource(row, labels.get(row.id) ?? [], project.role, true);
  delete core.body;
  const originalRelationCount = relations.length;
  const originalCommentCount = commentItems.length;
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
        continuation: comments.hasMore || commentItems.length < comments.rows.length
          ? `/api/v1/issues/CFK-${row.number}/comments`
          : null,
        items: commentItems,
        omitted_count: originalCommentCount - commentItems.length + (comments.hasMore ? 1 : 0),
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
        continuation: originalRelationCount > relations.length
          ? `/api/v1/issues/CFK-${row.number}/relations`
          : null,
        items: relations,
        omitted_count: originalRelationCount - relations.length,
      },
    },
    truncated: body.truncated || projectContext.truncated || comments.hasMore
      || originalCommentCount > commentItems.length || originalRelationCount > relations.length,
  });
  let context = build();
  const size = () => new TextEncoder().encode(JSON.stringify(context)).byteLength;
  while (size() > 64 * 1_024 && commentItems.length > 0) {
    commentItems = commentItems.slice(1);
    context = build();
  }
  while (size() > 64 * 1_024 && relations.length > 0) {
    relations = relations.slice(0, -1);
    context = build();
  }
  if (size() > 64 * 1_024) {
    body = utf8Excerpt(row.body, 4 * 1_024);
    projectContext = utf8Excerpt(row.project_context ?? "", 4 * 1_024);
    context = build();
  }
  if (size() > 64 * 1_024) throw platformUnavailable();
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
  } catch {
    throw platformUnavailable("d1");
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
  } catch {
    throw platformUnavailable("d1");
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
      `SELECT p.issue_limit, p.comment_limit, usage.active_issue_count,
              usage.active_comment_count,
              CASE WHEN policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL THEN 1 ELSE 0 END AS enabled
       FROM projects p
       LEFT JOIN project_usage usage ON usage.project_id = p.id
       LEFT JOIN public_join_policies policy ON policy.project_id = p.id
       WHERE p.id = ?1`,
    ).bind(projectId).first<{
      active_comment_count: number | null;
      active_issue_count: number | null;
      comment_limit: number | null;
      enabled: number;
      issue_limit: number | null;
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
    const activeCommentCount = row.active_comment_count ?? 0;
    const activeIssueCount = row.active_issue_count ?? 0;
    return {
      comments: row.active_comment_count === null
        || row.comment_limit === null
        || activeCommentCount + restoringCommentCount > row.comment_limit,
      commentCurrent: activeCommentCount,
      commentLimit: row.comment_limit ?? undefined,
      issues: row.active_issue_count === null
        || row.issue_limit === null
        || activeIssueCount + 1 > row.issue_limit,
      issueCurrent: activeIssueCount,
      issueLimit: row.issue_limit ?? undefined,
    };
  } catch {
    throw platformUnavailable("d1");
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
  options: { expectedLabelCount?: number; requireUsageCommit?: boolean } = {},
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
            p.workspace_id, i.project_id, 'issue', i.id, ?8, ?9
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
  );
}

async function readIssueCreatedByOperation(db: D1Database, operationId: string): Promise<IssueRow | null> {
  try {
    return await db.prepare(
      `${ISSUE_SELECT}
       WHERE i.created_operation_id = ?1
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL
       LIMIT 1`,
    ).bind(operationId).first<IssueRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readIssueForOperation(
  db: D1Database,
  number: number,
  operationId: string,
): Promise<IssueRow | null> {
  try {
    return await db.prepare(
      `${ISSUE_SELECT}
       WHERE i.number = ?1 AND i.last_operation_id = ?2
         AND p.deleted_at IS NULL AND w.deleted_at IS NULL
       LIMIT 1`,
    ).bind(number, operationId).first<IssueRow>();
  } catch {
    throw platformUnavailable("d1");
  }
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
  if (!(await assigneeEligible(db, project.projectId, assigneeId))) throw assigneeNotEligible();
  if (!(await activeLabelsExist(db, project.projectId, labelIds))) throw notFound();
  const quota = await issueQuotaExceeded(db, project.projectId);
  if (quota.issues) throw businessQuotaExceeded("issues", quota.issueCurrent, quota.issueLimit);
  const issueId = crypto.randomUUID();
  const associationIds = labelIds.map(() => crypto.randomUUID());
  const idempotencyKey = requireIdempotencyKey(request);
  const targetAllowed = cookieTargetAllowsProject(auth, workspaceKey, projectKey) ? 1 : 0;
  const result = await runIdempotentOperation({
    authorize: async () => {
      const latest = await authorizeProjectWrite(db, auth, workspaceKey, projectKey);
      if (latest.projectId !== project.projectId) throw notFound();
    },
    db,
    execute: async (operationId) => {
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
      const labels = labelIds.map((labelId, index) => db.prepare(
        `INSERT INTO issue_labels
          (issue_id, label_id, added_at, added_by_principal_id, created_operation_id)
         SELECT issue.id, label_row.id, ?1, ?2, ?3
         FROM issues issue
         JOIN labels label_row ON label_row.id = ?4 AND label_row.project_id = issue.project_id
         WHERE issue.id = ?5 AND issue.last_operation_id = ?6 AND label_row.deleted_at IS NULL`,
      ).bind(now, auth.principalId, associationIds[index], labelId, issueId, operationId));
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
            ...labels,
            usage,
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
    readback: async (_operationId, commit) => {
      const row = await readIssueCreatedByOperation(db, commit.operationId);
      if (row === null) throw platformUnavailable("d1");
      const labels = await labelsForIssues(db, [row.id]);
      return {
        body: writeResult(issueResource(row, labels.get(row.id) ?? [], project.role, true), commit.lastEventSequence, false),
        status: 200,
      };
    },
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
  const { row } = await requireIssueAccess(db, auth, identifier, "writer", true);
  if ((row.deleted_at !== null) !== expectedDeleted) {
    throw conflict(expectedDeleted ? "RESOURCE_NOT_DELETED" : "RESOURCE_DELETED");
  }
  if (row.version !== expectedVersion) throw versionConflict(row.version);
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
  const operationId = crypto.randomUUID();
  const targetAllowed = cookieTargetAllowsIssue(auth, identifier, row.workspace_key, row.project_key) ? 1 : 0;
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
             AND NOT EXISTS (
               SELECT 1 FROM idempotency_records AS pending_operation
               WHERE pending_operation.operation_id = issues.last_operation_id
                 AND pending_operation.state = 'pending'
             )
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
  const updated = await readIssueRow(db, row.number);
  if (updated === null) throw platformUnavailable("d1");
  const labels = await labelsForIssues(db, [updated.id]);
  return writeResult(issueResource(updated, labels.get(updated.id) ?? [], project.role, true), commit.lastEventSequence, false);
}

async function activeCommentCount(db: D1Database, issueId: string): Promise<number> {
  try {
    const row = await db.prepare(
      "SELECT COUNT(*) AS count FROM comments WHERE issue_id = ?1 AND deleted_at IS NULL",
    ).bind(issueId).first<{ count: number }>();
    return row?.count ?? 0;
  } catch {
    throw platformUnavailable("d1");
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
): Promise<OperationCommit> {
  const { row } = await requireIssueAccess(db, auth, identifier, "writer", true);
  const targetAllowed = cookieTargetAllowsIssue(auth, identifier, row.workspace_key, row.project_key) ? 1 : 0;
  const guard = buildProjectWriterGuard(auth, now, 9, "issues.project_id");
  const commentCount = await activeCommentCount(db, row.id);
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE issues SET deleted_at = ?1, deleted_by_principal_id = ?2,
                  version = version + 1, updated_at = ?3,
                  updated_by_principal_id = ?4, last_operation_id = ?5
           WHERE id = ?6 AND version = ?7 AND ?8 = 1
             AND deleted_at IS ${deleted ? "NULL" : "NOT NULL"}
             AND NOT EXISTS (
               SELECT 1 FROM idempotency_records AS pending_operation
               WHERE pending_operation.operation_id = issues.last_operation_id
                 AND pending_operation.state = 'pending'
             )
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
                   AND quota_project.comment_limit IS NOT NULL
                   AND usage.active_comment_count +
                     (SELECT COUNT(*) FROM comments c WHERE c.issue_id = issues.id AND c.deleted_at IS NULL)
                     <= quota_project.comment_limit
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
               ? "CASE WHEN active_comment_count >= ?1 THEN active_comment_count - ?1 ELSE 0 END"
               : "active_comment_count + ?1"},
             updated_at = ?2, last_operation_id = ?3
           WHERE project_id = ?4
             AND EXISTS (SELECT 1 FROM issues issue_row
                         WHERE issue_row.id = ?5 AND issue_row.last_operation_id = ?3)
             AND EXISTS (SELECT 1 FROM public_join_policies policy
                         WHERE policy.project_id = ?4
                           AND policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL)`,
        ).bind(commentCount, now, operationId, row.project_id, row.id),
        issueEvent(
          db,
          auth,
          operationId,
          row.id,
          deleted ? "issue.deleted" : "issue.restored",
          { identifier, released_or_restored_comments: commentCount },
          now,
          { requireUsageCommit: true },
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
            const quota = await issueQuotaExceeded(db, row.project_id, commentCount);
            if (quota.issues || quota.comments) return true;
          }
          return false;
        }
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: row.id,
      primarySubjectType: "issue",
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      await verifyCurrentAuth(db, auth, now);
      const latest = await requireIssueAccess(db, auth, identifier, "writer", true);
      if ((latest.row.deleted_at !== null) !== (!deleted)) {
        throw conflict(deleted ? "RESOURCE_DELETED" : "RESOURCE_NOT_DELETED");
      }
      if (latest.row.version !== expectedVersion) throw versionConflict(latest.row.version);
      if (!deleted) {
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
  const { project } = await requireIssueAccess(db, auth, identifier, "writer", true);
  const commit = await setIssueDeleted(db, auth, identifier, expectedVersion, now, true, crypto.randomUUID());
  const row = await readIssueRow(db, issueNumber(identifier), true);
  if (row === null) throw platformUnavailable("d1");
  const labels = await labelsForIssues(db, [row.id]);
  return writeResult(issueResource(row, labels.get(row.id) ?? [], project.role, true), commit.lastEventSequence, false);
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
  const initial = await requireIssueAccess(db, auth, identifier, "writer", true);
  const idempotencyKey = requireIdempotencyKey(request);
  const result = await runIdempotentOperation({
    authorize: async () => {
      const latest = await requireIssueAccess(db, auth, identifier, "writer", true);
      if (latest.row.project_id !== initial.row.project_id) throw notFound();
    },
    db,
    execute: async (operationId) => {
      await setIssueDeleted(db, auth, identifier, expectedVersion, now, false, operationId);
    },
    idempotencyKey,
    method: "POST",
    normalizedResourceScope: `issue:${identifier}:restore`,
    now,
    readback: async (operationId, commit) => {
      const row = await readIssueForOperation(db, issueNumber(identifier), operationId);
      if (row === null) throw platformUnavailable("d1");
      const labels = await labelsForIssues(db, [row.id]);
      return {
        body: writeResult(issueResource(row, labels.get(row.id) ?? [], initial.project.role, true), commit.lastEventSequence, false),
        status: 200,
      };
    },
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
  const initial = await requireIssueAccess(db, auth, identifier, "writer");
  const assigneeChanged = input.assignToPrincipalId !== undefined;
  const blockedChanged = input.blockedReason !== undefined;
  const idempotencyKey = requireIdempotencyKey(request);
  const targetAllowed = cookieTargetAllowsIssue(
    auth,
    identifier,
    initial.row.workspace_key,
    initial.row.project_key,
  ) ? 1 : 0;
  const result = await runIdempotentOperation({
    authorize: async () => {
      const latest = await requireIssueAccess(db, auth, identifier, "writer");
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
                 AND NOT EXISTS (
                   SELECT 1 FROM idempotency_records AS pending_operation
                   WHERE pending_operation.operation_id = issues.last_operation_id
                     AND pending_operation.state = 'pending'
                 )
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
      const row = await readIssueForOperation(db, initial.row.number, operationId);
      if (row === null) throw platformUnavailable("d1");
      const labels = await labelsForIssues(db, [row.id]);
      return {
        body: writeResult(issueResource(row, labels.get(row.id) ?? [], initial.project.role, true), commit.lastEventSequence, false),
        status: 200,
      };
    },
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
