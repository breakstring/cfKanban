import {
  issueNumber,
  requireIssueIdentifier,
  requireUuid,
  type StatusKey,
} from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  resolveVisibleProjects,
  type SqlGuard,
  type VisibleProject,
} from "../kernel/authorization.ts";
import { businessQuotaExceeded, forbidden, notFound, platformUnavailable, validationError } from "../kernel/errors.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";

export type CollaborationRole = VisibleProject["role"];
export type RelationKind = "blocks" | "duplicate" | "parent" | "related";

export interface CollaborationIssue {
  deletedAt: number | null;
  id: string;
  identifier: string;
  number: number;
  projectId: string;
  projectDeletedAt: number | null;
  projectKey: string;
  projectName: string;
  role: CollaborationRole;
  statusKey: StatusKey;
  title: string;
  version: number;
  workspaceId: string;
  workspaceDeletedAt: number | null;
  workspaceKey: string;
  workspaceName: string;
}

interface CollaborationIssueRow {
  deleted_at: number | null;
  id: string;
  number: number;
  project_deleted_at: number | null;
  project_id: string;
  project_key: string;
  project_name: string;
  status_key: StatusKey;
  title: string;
  version: number;
  workspace_deleted_at: number | null;
  workspace_id: string;
  workspace_key: string;
  workspace_name: string;
}

export interface ProjectRoleGuard extends SqlGuard {}

export function roleCanWrite(role: CollaborationRole): boolean {
  return role === "owner" || role === "writer";
}

function mapIssue(row: CollaborationIssueRow, role: CollaborationRole): CollaborationIssue {
  return {
    deletedAt: row.deleted_at,
    id: row.id,
    identifier: `CFK-${row.number}`,
    number: row.number,
    projectId: row.project_id,
    projectDeletedAt: row.project_deleted_at,
    projectKey: row.project_key,
    projectName: row.project_name,
    role,
    statusKey: row.status_key,
    title: row.title,
    version: row.version,
    workspaceId: row.workspace_id,
    workspaceDeletedAt: row.workspace_deleted_at,
    workspaceKey: row.workspace_key,
    workspaceName: row.workspace_name,
  };
}

async function readIssueRow(
  db: D1Database,
  identifier: string,
): Promise<CollaborationIssueRow | null> {
  try {
    return await db.prepare(
      `SELECT issue.id, issue.number, issue.project_id, issue.title,
              issue.status_key, issue.version, issue.deleted_at,
              project.key AS project_key, project.display_name AS project_name,
              project.deleted_at AS project_deleted_at,
              workspace.id AS workspace_id, workspace.key AS workspace_key,
              workspace.display_name AS workspace_name,
              workspace.deleted_at AS workspace_deleted_at
       FROM issues issue
       JOIN projects project ON project.id = issue.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE issue.number = ?1
       LIMIT 1`,
    ).bind(issueNumber(identifier)).first<CollaborationIssueRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

export async function requireCollaborationIssue(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
): Promise<CollaborationIssue> {
  const identifier = requireIssueIdentifier(identifierValue);
  const [row, visibleProjects] = await Promise.all([
    readIssueRow(db, identifier),
    resolveVisibleProjects(db, auth),
  ]);
  if (
    row === null
    || row.deleted_at !== null
    || row.project_deleted_at !== null
    || row.workspace_deleted_at !== null
  ) throw notFound();
  const project = visibleProjects.find((candidate) => candidate.projectId === row.project_id);
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && !roleCanWrite(project.role)) throw forbidden();
  return mapIssue(row, project.role);
}

export async function requireCollaborationIssueAuthorization(
  db: D1Database,
  auth: AuthContext,
  identifierValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
): Promise<CollaborationIssue> {
  const identifier = requireIssueIdentifier(identifierValue);
  const [row, authorizedProjects] = await Promise.all([
    readIssueRow(db, identifier),
    resolveVisibleProjects(db, auth, true),
  ]);
  if (row === null) throw notFound();
  const project = authorizedProjects.find((candidate) => candidate.projectId === row.project_id);
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && !roleCanWrite(project.role)) throw forbidden();
  return mapIssue(row, project.role);
}

export async function requireCollaborationIssueById(
  db: D1Database,
  auth: AuthContext,
  issueIdValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
): Promise<CollaborationIssue> {
  const issueId = requireUuid(issueIdValue, "issue_id");
  let row: CollaborationIssueRow | null;
  try {
    row = await db.prepare(
      `SELECT issue.id, issue.number, issue.project_id, issue.title,
              issue.status_key, issue.version, issue.deleted_at,
              project.key AS project_key, project.display_name AS project_name,
              project.deleted_at AS project_deleted_at,
              workspace.id AS workspace_id, workspace.key AS workspace_key,
              workspace.display_name AS workspace_name,
              workspace.deleted_at AS workspace_deleted_at
       FROM issues issue
       JOIN projects project ON project.id = issue.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE issue.id = ?1
       LIMIT 1`,
    ).bind(issueId).first<CollaborationIssueRow>();
  } catch {
    throw platformUnavailable("d1");
  }
  if (
    row === null
    || row.deleted_at !== null
    || row.project_deleted_at !== null
    || row.workspace_deleted_at !== null
  ) throw notFound();
  const project = (await resolveVisibleProjects(db, auth)).find(
    (candidate) => candidate.projectId === row?.project_id,
  );
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && !roleCanWrite(project.role)) throw forbidden();
  return mapIssue(row, project.role);
}

export async function requireCollaborationIssueByIdAuthorization(
  db: D1Database,
  auth: AuthContext,
  issueIdValue: JsonValue,
  requiredRole: "reader" | "writer" = "reader",
): Promise<CollaborationIssue> {
  const issueId = requireUuid(issueIdValue, "issue_id");
  let row: CollaborationIssueRow | null;
  try {
    row = await db.prepare(
      `SELECT issue.id, issue.number, issue.project_id, issue.title,
              issue.status_key, issue.version, issue.deleted_at,
              project.key AS project_key, project.display_name AS project_name,
              project.deleted_at AS project_deleted_at,
              workspace.id AS workspace_id, workspace.key AS workspace_key,
              workspace.display_name AS workspace_name,
              workspace.deleted_at AS workspace_deleted_at
       FROM issues issue
       JOIN projects project ON project.id = issue.project_id
       JOIN workspaces workspace ON workspace.id = project.workspace_id
       WHERE issue.id = ?1
       LIMIT 1`,
    ).bind(issueId).first<CollaborationIssueRow>();
  } catch {
    throw platformUnavailable("d1");
  }
  if (row === null) throw notFound();
  const project = (await resolveVisibleProjects(db, auth, true)).find(
    (candidate) => candidate.projectId === row?.project_id,
  );
  if (project === undefined) throw notFound();
  if (requiredRole === "writer" && !roleCanWrite(project.role)) throw forbidden();
  return mapIssue(row, project.role);
}

export function buildProjectRoleGuard(
  auth: AuthContext,
  now: number,
  startIndex: number,
  projectExpression: string,
  requiredRole: "reader" | "writer" = "writer",
): ProjectRoleGuard {
  const currentAuth = buildCurrentAuthGuard(auth, now, startIndex);
  const ownerIndex = startIndex + currentAuth.values.length;
  const principalIndex = ownerIndex + 1;
  return {
    sql: `${currentAuth.sql}
      AND (?${ownerIndex} = 1 OR EXISTS (
        SELECT 1 FROM project_grants final_grant
        WHERE final_grant.project_id = ${projectExpression}
          AND final_grant.principal_id = ?${principalIndex}
          ${requiredRole === "writer" ? "AND final_grant.role = 'writer'" : ""}
          AND final_grant.revoked_at IS NULL
      ))`,
    values: [...currentAuth.values, auth.isOwner ? 1 : 0, auth.principalId],
  };
}

export function buildTwoProjectWriterGuard(
  auth: AuthContext,
  now: number,
  startIndex: number,
  sourceProjectExpression: string,
  targetProjectExpression: string,
): ProjectRoleGuard {
  const currentAuth = buildCurrentAuthGuard(auth, now, startIndex);
  const ownerIndex = startIndex + currentAuth.values.length;
  const principalIndex = ownerIndex + 1;
  return {
    sql: `${currentAuth.sql}
      AND (?${ownerIndex} = 1 OR (
        EXISTS (
          SELECT 1 FROM project_grants source_grant
          WHERE source_grant.project_id = ${sourceProjectExpression}
            AND source_grant.principal_id = ?${principalIndex}
            AND source_grant.role = 'writer' AND source_grant.revoked_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM project_grants target_grant
          WHERE target_grant.project_id = ${targetProjectExpression}
            AND target_grant.principal_id = ?${principalIndex}
            AND target_grant.role = 'writer' AND target_grant.revoked_at IS NULL
        )
      ))`,
    values: [...currentAuth.values, auth.isOwner ? 1 : 0, auth.principalId],
  };
}

export function requireCommentBody(value: JsonValue, field = "body"): string {
  if (typeof value !== "string") throw validationError("schema_validation_failed", { field });
  const normalized = value.trim();
  if (
    normalized.length === 0
    || new TextEncoder().encode(normalized).byteLength > 32 * 1_024
  ) throw validationError("schema_validation_failed", { field });
  return normalized;
}

export function requireLabelName(value: JsonValue, field = "name"): string {
  if (typeof value !== "string") throw validationError("schema_validation_failed", { field });
  const normalized = value.trim();
  if (normalized.length === 0 || Array.from(normalized).length > 64) {
    throw validationError("schema_validation_failed", { field });
  }
  return normalized;
}

export function requireLabelColor(value: JsonValue | undefined, field = "color"): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw validationError("schema_validation_failed", { field });
  }
  return value.toUpperCase();
}

export function requireRelationKind(value: JsonValue, field = "kind"): RelationKind {
  if (value !== "blocks" && value !== "parent" && value !== "related" && value !== "duplicate") {
    throw validationError("schema_validation_failed", { field });
  }
  return value;
}

export interface CompletionPayload {
  artifacts: Array<{ kind: "commit" | "other" | "path" | "url"; value: string }>;
  follow_ups: string[];
  summary: string;
  verification: string[];
}

function requireStringArray(
  value: JsonValue | undefined,
  field: string,
  itemLimit: number,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw validationError("schema_validation_failed", { field });
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || Array.from(item).length > itemLimit) {
      throw validationError("schema_validation_failed", { field: `${field}_${index}` });
    }
    return item;
  });
}

export function requireCompletionPayload(value: { [key: string]: JsonValue }): CompletionPayload {
  const summary = requireCommentBody(value.summary as JsonValue, "summary");
  if (Array.from(summary).length > 8_192) {
    throw validationError("schema_validation_failed", { field: "summary" });
  }
  const verification = requireStringArray(value.verification, "verification", 1_024);
  const followUps = requireStringArray(value.follow_ups, "follow_ups", 2_048);
  const artifactValue = value.artifacts;
  let artifacts: CompletionPayload["artifacts"] = [];
  if (artifactValue !== undefined) {
    if (!Array.isArray(artifactValue) || artifactValue.length > 50) {
      throw validationError("schema_validation_failed", { field: "artifacts" });
    }
    artifacts = artifactValue.map((artifact, index) => {
      if (artifact === null || Array.isArray(artifact) || typeof artifact !== "object") {
        throw validationError("schema_validation_failed", { field: `artifacts_${index}` });
      }
      const keys = Object.keys(artifact);
      const kind = artifact.kind;
      const artifactText = artifact.value;
      if (
        keys.length !== 2
        || !keys.includes("kind")
        || !keys.includes("value")
        || (kind !== "url" && kind !== "path" && kind !== "commit" && kind !== "other")
        || typeof artifactText !== "string"
        || artifactText.length === 0
        || Array.from(artifactText).length > 2_048
      ) throw validationError("schema_validation_failed", { field: `artifacts_${index}` });
      return { kind, value: artifactText };
    });
  }
  const payload = { artifacts, follow_ups: followUps, summary, verification };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 32 * 1_024) {
    throw validationError("schema_validation_failed", { field: "completion" });
  }
  return payload;
}

export async function assertCommentCapacity(
  db: D1Database,
  projectId: string,
  delta = 1,
): Promise<void> {
  let row: {
    active_comment_count: number | null;
    comment_limit: number | null;
    policy_enabled: number;
    usage_exists: number;
  } | null;
  try {
    row = await db.prepare(
      `SELECT
         CASE WHEN policy.enabled_at IS NOT NULL AND policy.disabled_at IS NULL THEN 1 ELSE 0 END AS policy_enabled,
         CASE WHEN usage.project_id IS NULL THEN 0 ELSE 1 END AS usage_exists,
         usage.active_comment_count, project.comment_limit
       FROM projects project
       LEFT JOIN public_join_policies policy ON policy.project_id = project.id
       LEFT JOIN project_usage usage ON usage.project_id = project.id
       WHERE project.id = ?1`,
    ).bind(projectId).first();
  } catch {
    throw platformUnavailable("d1");
  }
  if (row === null || row.policy_enabled === 0) return;
  if (
    row.usage_exists !== 1
    || row.active_comment_count === null
    || row.comment_limit === null
  ) throw platformUnavailable("d1");
  if (delta > 0 && row.active_comment_count + delta > row.comment_limit) {
    throw businessQuotaExceeded("comments", row.active_comment_count, row.comment_limit);
  }
}

export function issueReference(issue: CollaborationIssue): { [key: string]: JsonValue } {
  return {
    id: issue.id,
    identifier: issue.identifier,
    project: {
      id: issue.projectId,
      key: issue.projectKey,
      workspace_key: issue.workspaceKey,
    },
    title: issue.title,
    version: issue.version,
  };
}
