import {
  requireProjectKey,
  requireWorkspaceKey,
  timestamp,
} from "../domain/model.ts";
import {
  requireOwnerControl,
  resolveVisibleProjects,
  type VisibleProject,
} from "../kernel/authorization.ts";
import { createCursorContext, decodeCursor, encodeCursor, invalidCursor } from "../kernel/cursor.ts";
import { platformUnavailable, validationError } from "../kernel/errors.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";
import { DEFAULT_EVENT_CURSOR_FILTER, requireLimit } from "./shared.ts";

interface EventRow {
  actor_credential_id: string | null;
  actor_display_name: string | null;
  actor_principal_id: string | null;
  authorized_via: string;
  created_at: number;
  event_index: number;
  grant_id: string | null;
  id: string;
  operation_id: string;
  payload_json: string;
  project_display_name: string | null;
  project_id: string | null;
  project_key: string | null;
  sequence: number;
  stream: "domain" | "security";
  subject_id: string;
  subject_type: string;
  type: string;
  workspace_display_name: string | null;
  workspace_id: string | null;
  workspace_key: string | null;
}

interface EventScope {
  projectTargets: string[];
  projects: VisibleProject[];
  unresolvedProjectTargets: string[];
  unresolvedWorkspaceTargets: string[];
  visibleProjects: VisibleProject[];
  workspaceTargets: string[];
}

const EVENT_SELECT = `
  SELECT event.sequence, event.id, event.stream, event.type, event.operation_id,
         event.event_index, event.actor_principal_id, actor.display_name AS actor_display_name,
         event.actor_credential_id, event.authorized_via, event.grant_id,
         event.workspace_id, workspace.key AS workspace_key,
         workspace.display_name AS workspace_display_name,
         event.project_id, project.key AS project_key,
         project.display_name AS project_display_name,
         event.subject_type, event.subject_id, event.payload_json, event.created_at
  FROM events event
  LEFT JOIN principals actor ON actor.id = event.actor_principal_id
  LEFT JOIN workspaces workspace ON workspace.id = event.workspace_id
  LEFT JOIN projects project ON project.id = event.project_id`;

function repeatedTargets(url: URL, name: "project" | "workspace"): string[] {
  const values = url.searchParams.getAll(name);
  if (values.length > 20) throw validationError("too_many_scope_filters", { field: name });
  return [...new Set(values)].sort();
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

async function resolveEventScope(
  db: D1Database,
  auth: AuthContext,
  url: URL,
): Promise<EventScope> {
  const projectTargets = repeatedTargets(url, "project");
  const workspaceTargets = repeatedTargets(url, "workspace");
  const parsedProjects = projectTargets.map((target) => ({ target, ...parseProjectTarget(target) }));
  const parsedWorkspaces = workspaceTargets.map((target) => ({
    target,
    workspaceKey: requireWorkspaceKey(target, "workspace"),
  }));
  const visible = await resolveVisibleProjects(db, auth);
  let projects = visible;
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
  return {
    projectTargets,
    projects,
    unresolvedProjectTargets: parsedProjects.filter((target) => !visible.some(
      (project) => target.workspaceKey === project.workspaceKey && target.projectKey === project.projectKey,
    )).map((target) => target.target),
    unresolvedWorkspaceTargets: parsedWorkspaces.filter((target) => !visible.some(
      (project) => target.workspaceKey === project.workspaceKey,
    )).map((target) => target.target),
    visibleProjects: visible,
    workspaceTargets,
  };
}

function parseEventCursor(last: JsonValue[] | null): number {
  if (last === null) return 0;
  if (
    last.length !== 1
    || typeof last[0] !== "number"
    || !Number.isSafeInteger(last[0])
    || last[0] < 0
  ) {
    throw invalidCursor();
  }
  return last[0];
}

function eventPayload(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw platformUnavailable("d1");
  }
}

function eventResource(row: EventRow, includeStream = false): { [key: string]: JsonValue } {
  return {
    actor: row.actor_principal_id === null ? null : {
      credential_id: row.actor_credential_id,
      display_name: row.actor_display_name ?? "",
      principal_id: row.actor_principal_id,
    },
    authorized_via: row.authorized_via,
    created_at: timestamp(row.created_at),
    event_index: row.event_index,
    grant_id: row.grant_id,
    id: row.id,
    operation_id: row.operation_id,
    payload: eventPayload(row.payload_json),
    project: row.project_id === null ? null : {
      display_name: row.project_display_name ?? "",
      id: row.project_id,
      key: row.project_key ?? "",
    },
    ...(includeStream ? { stream: row.stream } : {}),
    subject: { id: row.subject_id, type: row.subject_type },
    type: row.type,
    workspace: row.workspace_id === null ? null : {
      display_name: row.workspace_display_name ?? "",
      id: row.workspace_id,
      key: row.workspace_key ?? "",
    },
  };
}

function resolvedEventScope(scope: EventScope): { [key: string]: JsonValue } {
  return {
    expanded_to_all_authorized_projects:
      scope.projectTargets.length === 0 && scope.workspaceTargets.length === 0,
    projects: scope.projects.map((project) => ({
      project_id: project.projectId,
      project_key: project.projectKey,
      workspace_key: project.workspaceKey,
    })),
    unresolved_project_targets: scope.unresolvedProjectTargets,
    unresolved_workspace_targets: scope.unresolvedWorkspaceTargets,
  };
}

export async function listEvents(
  db: D1Database,
  auth: AuthContext,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  const scope = await resolveEventScope(db, auth, url);
  const filter: JsonValue = scope.projectTargets.length === 0 && scope.workspaceTargets.length === 0
    ? DEFAULT_EVENT_CURSOR_FILTER
    : {
      project_targets: scope.projectTargets,
      workspace_targets: scope.workspaceTargets,
    };
  const context = await createCursorContext(
    "events",
    filter,
    scope.visibleProjects.map((project) => project.projectId),
    auth.principalId,
  );
  const afterValue = url.searchParams.get("after");
  const afterSequence = parseEventCursor(decodeCursor(afterValue, context));
  const limit = requireLimit(url);
  let rows: EventRow[];
  try {
    const result = await db.prepare(
      `${EVENT_SELECT}
       WHERE event.stream = 'domain' AND event.sequence > ?1
         AND event.project_id IN (SELECT value FROM json_each(?2))
         AND (
           event.subject_type != 'relation'
           OR EXISTS (
             SELECT 1
             FROM issue_relations relation
             JOIN issues source ON source.id = relation.source_issue_id
             JOIN issues target ON target.id = relation.target_issue_id
             WHERE relation.id = event.subject_id
               AND source.project_id IN (SELECT value FROM json_each(?3))
               AND target.project_id IN (SELECT value FROM json_each(?3))
           )
         )
       ORDER BY event.sequence ASC
       LIMIT ?4`,
    ).bind(
      afterSequence,
      JSON.stringify(scope.projects.map((project) => project.projectId)),
      JSON.stringify(scope.visibleProjects.map((project) => project.projectId)),
      limit + 1,
    ).all<EventRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const lastSequence = page.at(-1)?.sequence ?? afterSequence;
  return {
    has_more: hasMore,
    items: page.map((row) => eventResource(row)),
    next_cursor: encodeCursor(context, [lastSequence]),
    resolved_scope: resolvedEventScope(scope),
  };
}

export async function listAuditEvents(
  db: D1Database,
  auth: AuthContext,
  url: URL,
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const context = await createCursorContext(
    "audit-events",
    { streams: ["domain", "security"] },
    [],
    auth.principalId,
  );
  const afterValue = url.searchParams.get("after");
  const afterSequence = parseEventCursor(decodeCursor(afterValue, context));
  const limit = requireLimit(url);
  let rows: EventRow[];
  try {
    const result = await db.prepare(
      `${EVENT_SELECT}
       WHERE event.sequence > ?1
       ORDER BY event.sequence ASC
       LIMIT ?2`,
    ).bind(afterSequence, limit + 1).all<EventRow>();
    rows = result.results;
  } catch {
    throw platformUnavailable("d1");
  }
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const lastSequence = page.at(-1)?.sequence ?? afterSequence;
  return {
    has_more: hasMore,
    items: page.map((row) => eventResource(row, true)),
    next_cursor: encodeCursor(context, [lastSequence]),
  };
}
