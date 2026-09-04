import {
  requireProjectKey,
  requireUuid,
  requireWorkspaceKey,
  timestamp,
} from "../domain/model.ts";
import {
  buildCurrentAuthGuard,
  requireOwnerControl,
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
import { isUuid } from "../kernel/crypto.ts";
import { ApiError, platformUnavailable, validationError } from "../kernel/errors.ts";
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
  relation_other_project_id: string | null;
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

type AuditEventStream = "domain" | "security";

interface AuditEventFilter {
  projectId: string | null;
  streams: AuditEventStream[];
}

function eventSelect(eventsSource: string): string {
  return `
  SELECT event.sequence, event.id, event.stream, event.type, event.operation_id,
         event.event_index, event.actor_principal_id, actor.display_name AS actor_display_name,
         event.actor_credential_id, event.authorized_via, event.grant_id,
         event.workspace_id, workspace.key AS workspace_key,
         workspace.display_name AS workspace_display_name,
         event.project_id, project.key AS project_key,
         project.display_name AS project_display_name,
         event.relation_other_project_id,
         event.subject_type, event.subject_id, event.payload_json, event.created_at
  FROM ${eventsSource}
  LEFT JOIN principals actor ON actor.id = event.actor_principal_id
  LEFT JOIN workspaces workspace ON workspace.id = event.workspace_id
  LEFT JOIN projects project ON project.id = event.project_id`;
}

const EVENT_SELECT = eventSelect("events event");

const EVENT_CANDIDATE_COLUMNS = `
  sequence, id, stream, type, operation_id, event_index,
  actor_principal_id, actor_credential_id, authorized_via, grant_id,
  workspace_id, project_id, relation_other_project_id,
  subject_type, subject_id, payload_json, created_at`;

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

function parseDomainEventCursor(last: JsonValue[] | null): string | null {
  if (last === null) return null;
  if (
    last.length !== 1
    || (last[0] !== null && (typeof last[0] !== "string" || !isUuid(last[0])))
  ) {
    throw invalidCursor();
  }
  return last[0];
}

function parseAuditEventCursor(last: JsonValue[] | null): number {
  if (last === null) return 0;
  if (
    last.length !== 1
    || typeof last[0] !== "number"
    || !Number.isSafeInteger(last[0])
    || last[0] < 0
  ) throw invalidCursor();
  return last[0];
}

function requireAuditEventFilter(url: URL): AuditEventFilter {
  const projectIdValue = url.searchParams.get("project_id");
  const projectId = projectIdValue === null ? null : requireUuid(projectIdValue, "project_id");
  const streamValue = url.searchParams.get("stream");
  if (streamValue !== null && streamValue !== "domain" && streamValue !== "security") {
    throw validationError("schema_validation_failed", { field: "stream" });
  }
  return {
    projectId,
    streams: streamValue === null
      ? ["domain", "security"]
      : [streamValue],
  };
}

async function eventSequenceForAnchor(db: D1Database, eventId: string | null): Promise<number> {
  if (eventId === null) return 0;
  try {
    const row = await db.prepare(
      "SELECT sequence FROM events WHERE id = ?1 LIMIT 1",
    ).bind(eventId).first<{ sequence: number }>();
    if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) throw invalidCursor();
    return row.sequence;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}

function eventPayload(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw platformUnavailable("d1", error);
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
  now = Date.now(),
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
  const afterEventId = parseDomainEventCursor(decodeCursor(afterValue, context));
  const afterSequence = await eventSequenceForAnchor(db, afterEventId);
  const limit = requireLimit(url);
  const authGuard = buildCurrentAuthGuard(auth, now, 6);
  let rows: EventRow[];
  try {
    const result = await db.prepare(
      `WITH current_visible_projects(id) AS MATERIALIZED (
         SELECT current_project.id
         FROM projects current_project
         JOIN workspaces current_workspace ON current_workspace.id = current_project.workspace_id
         JOIN instance_meta current_instance ON current_instance.singleton = 1
         WHERE current_project.id IN (SELECT value FROM json_each(?3))
           AND current_project.deleted_at IS NULL
           AND current_workspace.deleted_at IS NULL
           AND ${authGuard.sql}
           AND (
             current_instance.owner_principal_id = ?5
             OR EXISTS (
               SELECT 1 FROM project_grants current_grant
               WHERE current_grant.project_id = current_project.id
                 AND current_grant.principal_id = ?5
                 AND current_grant.revoked_at IS NULL
             )
           )
       ), current_result_projects(id) AS MATERIALIZED (
         SELECT id FROM current_visible_projects
         WHERE id IN (SELECT value FROM json_each(?2))
       ), non_relation_events AS (
         SELECT ${EVENT_CANDIDATE_COLUMNS}
         FROM events INDEXED BY idx_events_project_nonrelation_sequence
         WHERE stream = 'domain' AND sequence > ?1
           AND project_id IN (SELECT id FROM current_result_projects)
           AND relation_other_project_id IS NULL
         ORDER BY sequence ASC LIMIT ?4
       ), relation_events AS (
         SELECT ${EVENT_CANDIDATE_COLUMNS}
         FROM events INDEXED BY idx_events_project_relation_sequence
         WHERE stream = 'domain' AND sequence > ?1
           AND project_id IN (SELECT id FROM current_result_projects)
           AND relation_other_project_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM current_visible_projects visible_relation_project
             WHERE visible_relation_project.id = relation_other_project_id
           )
         ORDER BY sequence ASC LIMIT ?4
       ), candidate_events AS (
         SELECT ${EVENT_CANDIDATE_COLUMNS} FROM non_relation_events
         UNION ALL
         SELECT ${EVENT_CANDIDATE_COLUMNS} FROM relation_events
         ORDER BY sequence ASC LIMIT ?4
       )
       ${eventSelect("candidate_events event")}
       ORDER BY event.sequence ASC`,
    ).bind(
      afterSequence,
      JSON.stringify(scope.projects.map((project) => project.projectId)),
      JSON.stringify(scope.visibleProjects.map((project) => project.projectId)),
      limit + 1,
      auth.principalId,
      ...authGuard.values,
    ).all<EventRow>();
    rows = result.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
  await verifyCurrentAuth(db, auth, now);
  const currentScope = await resolveEventScope(db, auth, url);
  const previousVisibleIds = scope.visibleProjects.map((project) => project.projectId).sort();
  const nextVisibleIds = currentScope.visibleProjects.map((project) => project.projectId).sort();
  const previousResultIds = scope.projects.map((project) => project.projectId).sort();
  const nextResultIds = currentScope.projects.map((project) => project.projectId).sort();
  if (
    previousVisibleIds.length !== nextVisibleIds.length
    || previousVisibleIds.some((projectId, index) => projectId !== nextVisibleIds[index])
    || previousResultIds.length !== nextResultIds.length
    || previousResultIds.some((projectId, index) => projectId !== nextResultIds[index])
  ) throw cursorScopeMismatch();
  const currentVisibleIds = new Set(currentScope.visibleProjects.map((project) => project.projectId));
  const currentResultIds = new Set(currentScope.projects.map((project) => project.projectId));
  const authorizedRows = rows.filter((row) => row.project_id !== null
    && currentResultIds.has(row.project_id)
    && (row.relation_other_project_id === null || currentVisibleIds.has(row.relation_other_project_id)));
  const responseContext = await createCursorContext(
    "events",
    filter,
    currentScope.visibleProjects.map((project) => project.projectId),
    auth.principalId,
  );
  const hasMore = authorizedRows.length > limit;
  const page = authorizedRows.slice(0, limit);
  const lastEventId = page.at(-1)?.id ?? afterEventId;
  return {
    has_more: hasMore,
    items: page.map((row) => eventResource(row)),
    next_cursor: encodeCursor(responseContext, [lastEventId]),
    resolved_scope: resolvedEventScope(currentScope),
  };
}

export async function listAuditEvents(
  db: D1Database,
  auth: AuthContext,
  url: URL,
  now = Date.now(),
): Promise<{ [key: string]: JsonValue }> {
  requireOwnerControl(auth);
  const filter = requireAuditEventFilter(url);
  const context = await createCursorContext(
    "audit-events",
    { project_id: filter.projectId, streams: filter.streams },
    [],
    auth.principalId,
  );
  const afterValue = url.searchParams.get("after");
  const afterSequence = parseAuditEventCursor(decodeCursor(afterValue, context));
  const limit = requireLimit(url);
  let bindings: Array<string | number | null>;
  let query: string;
  if (filter.projectId !== null && filter.streams.length === 2) {
    bindings = [afterSequence, filter.projectId, limit + 1];
    const authGuard = buildCurrentAuthGuard(auth, now, 4, true);
    query = `WITH candidate_events AS (
       SELECT ${EVENT_CANDIDATE_COLUMNS}
       FROM events INDEXED BY idx_events_project_stream_sequence
       WHERE project_id = ?2 AND stream = 'domain' AND sequence > ?1
       UNION ALL
       SELECT ${EVENT_CANDIDATE_COLUMNS}
       FROM events INDEXED BY idx_events_project_stream_sequence
       WHERE project_id = ?2 AND stream = 'security' AND sequence > ?1
       ORDER BY sequence ASC LIMIT ?3
     )
     ${eventSelect("candidate_events event")}
     WHERE ${authGuard.sql}
     ORDER BY event.sequence ASC
     LIMIT ?3`;
    bindings.push(...authGuard.values);
  } else {
    const predicates = ["event.sequence > ?1"];
    bindings = [afterSequence];
    if (filter.projectId !== null) {
      bindings.push(filter.projectId);
      predicates.push(`event.project_id = ?${bindings.length}`);
    }
    if (filter.streams.length === 1) {
      bindings.push(filter.streams[0] ?? null);
      predicates.push(`event.stream = ?${bindings.length}`);
    }
    bindings.push(limit + 1);
    const limitParameter = `?${bindings.length}`;
    const authGuard = buildCurrentAuthGuard(auth, now, bindings.length + 1, true);
    query = `${EVENT_SELECT}
     WHERE ${predicates.join("\n       AND ")}
       AND ${authGuard.sql}
     ORDER BY event.sequence ASC
     LIMIT ${limitParameter}`;
    bindings.push(...authGuard.values);
  }
  let rows: EventRow[];
  try {
    const result = await db.prepare(query).bind(...bindings).all<EventRow>();
    rows = result.results;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
  await verifyCurrentAuth(db, auth, now);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const lastSequence = page.at(-1)?.sequence ?? afterSequence;
  return {
    has_more: hasMore,
    items: page.map((row) => eventResource(row, true)),
    next_cursor: encodeCursor(context, [lastSequence]),
    resolved_filters: {
      project_id: filter.projectId,
      streams: filter.streams,
    },
  };
}
