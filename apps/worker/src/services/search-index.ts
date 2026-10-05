import { requireUuid } from "../domain/model.ts";
import { buildCurrentAuthGuard, resolveCurrentVisibleProjects, verifyCurrentAuth, type VisibleProject } from "../kernel/authorization.ts";
import { createCursorContext, cursorScopeMismatch, decodeCursor, encodeCursor, invalidCursor, type CursorContext } from "../kernel/cursor.ts";
import { sha256Hex } from "../kernel/crypto.ts";
import { ApiError, notFound, platformUnavailable, validationError } from "../kernel/errors.ts";
import { canonicalJson } from "../kernel/idempotency.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";

interface SearchScope {
  key: string;
  projects: VisibleProject[];
  visible: VisibleProject[];
  issueNumber: number | null;
}

interface IndexMeta { epoch: string; instance_id: string; projection_version: number }
interface ProjectState { project_id: string; revision: number; event_sequence: number; retained_after: number; upper_number: number }
interface DocumentRow { id: string; number: number; title: string; project_id: string; revision: number }
interface ChangeRow extends DocumentRow { event_sequence: number; project_revision: number; kind: "upsert" | "remove" }
interface Position { mode: "snapshot" | "changes"; revision: number; eventSequence: number; upperNumber: number; lastNumber: number }

function resetError(code: "CURSOR_EXPIRED" | "SEARCH_INDEX_RESET"): ApiError {
  return new ApiError({ category: "conflict", code, message: "The search index requires a new snapshot.",
    recovery: "rebuild_search_index", retryable: false, status: 409 });
}

function one(url: URL, name: string, required = false): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1 || (required && values.length !== 1) || values[0] === "") {
    throw validationError("schema_validation_failed", { field: name });
  }
  return values[0] ?? null;
}

function validateParameters(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) throw validationError("unknown_query_parameter", { field: key });
  }
}

function pageLimit(url: URL): number {
  const value = one(url, "limit") ?? "100";
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 100) {
    throw validationError("schema_validation_failed", { field: "limit" });
  }
  return Number(value);
}

async function scope(db: D1Database, auth: AuthContext, projects: string[], now: number): Promise<SearchScope> {
  const visible = await resolveCurrentVisibleProjects(db, auth, now);
  const issueNumber = auth.kind === "cookie" && auth.targetKind === "issue"
    ? Number(String(auth.target.identifier).slice(4)) : null;
  const key = await sha256Hex(canonicalJson({ principal_id: auth.principalId,
    projects: visible.map((project) => project.projectId).sort(),
    session_scope: auth.kind === "cookie" ? { kind: auth.targetKind, target: auth.target } : null,
  }));
  return { key, visible, issueNumber, projects: projects.length === 0 ? visible
    : visible.filter((project) => projects.includes(project.projectId)) };
}

async function checkScope(db: D1Database, auth: AuthContext, previous: SearchScope, projects: string[], now: number): Promise<SearchScope> {
  await verifyCurrentAuth(db, auth, now);
  const current = await scope(db, auth, projects, now);
  const previousIds = previous.projects.map((project) => project.projectId).sort();
  const currentIds = current.projects.map((project) => project.projectId).sort();
  if (canonicalJson(previousIds) !== canonicalJson(currentIds)) throw cursorScopeMismatch();
  return current;
}

async function indexMeta(db: D1Database): Promise<IndexMeta> {
  const row = await db.prepare(`SELECT meta.epoch, meta.projection_version, instance.instance_id
    FROM search_index_meta meta JOIN instance_meta instance ON instance.singleton = meta.singleton
    WHERE meta.singleton = 1`).first<IndexMeta>();
  if (row === null || row.projection_version !== 1) throw resetError("SEARCH_INDEX_RESET");
  return row;
}

function currentProjectGuard(auth: AuthContext, now: number, projectParameter: number | string, principalParameter: number, start: number) {
  const guard = buildCurrentAuthGuard(auth, now, start);
  return { sql: `EXISTS (SELECT 1 FROM projects project
    JOIN workspaces workspace ON workspace.id = project.workspace_id
    JOIN instance_meta instance ON instance.singleton = 1
    WHERE project.id = ${typeof projectParameter === "number" ? `?${projectParameter}` : projectParameter} AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
      AND ${guard.sql} AND (instance.owner_principal_id = ?${principalParameter} OR EXISTS (
        SELECT 1 FROM effective_project_grants grant_row WHERE grant_row.project_id = project.id
          AND grant_row.principal_id = ?${principalParameter} AND grant_row.revoked_at IS NULL)))`, values: guard.values };
}

async function cursorContext(meta: IndexMeta, current: SearchScope, auth: AuthContext, project: string): Promise<CursorContext> {
  return createCursorContext("search-index", { instance_id: meta.instance_id, project_id: project,
    session_scope: auth.kind === "cookie" ? { kind: auth.targetKind, target: auth.target } : null,
  }, current.projects.filter((entry) => entry.projectId === project).map((entry) => entry.projectId), auth.principalId);
}

function positionCursor(context: CursorContext, meta: IndexMeta, value: Position): string {
  return encodeCursor(context, [meta.epoch, meta.projection_version, value.mode, value.revision, value.eventSequence, value.upperNumber, value.lastNumber]);
}

function readPosition(value: string | null, context: CursorContext, meta: IndexMeta): Position {
  if (value === null || value.length > 4096) throw invalidCursor();
  const last = decodeCursor(value, context);
  if (last === null || last.length !== 7 || typeof last[0] !== "string" || typeof last[1] !== "number"
    || (last[2] !== "snapshot" && last[2] !== "changes")
    || last.slice(3).some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)) throw invalidCursor();
  if (last[0] !== meta.epoch || last[1] !== meta.projection_version) throw resetError("SEARCH_INDEX_RESET");
  const [revision, eventSequence, upperNumber, lastNumber] = last.slice(3) as number[];
  if (lastNumber! > upperNumber! || (last[2] === "changes" && (upperNumber !== 0 || lastNumber !== 0))) throw invalidCursor();
  return { mode: last[2], revision: revision!, eventSequence: eventSequence!, upperNumber: upperNumber!, lastNumber: lastNumber! };
}

function document(row: DocumentRow): { [key: string]: JsonValue } {
  return { id: row.id, number: row.number, identifier: `CFK-${row.number}`, title: row.title,
    project_id: row.project_id, revision: row.revision };
}

async function projectState(db: D1Database, auth: AuthContext, current: SearchScope, project: string, now: number): Promise<ProjectState> {
  if (!current.projects.some((entry) => entry.projectId === project)) throw notFound();
  const guard = currentProjectGuard(auth, now, 1, 2, 3);
  const row = await db.prepare(`SELECT state.project_id, state.revision, state.event_sequence, state.retained_after,
    COALESCE((SELECT number FROM search_index_documents INDEXED BY idx_search_index_documents_project_number
      WHERE project_id = state.project_id AND is_removed = 0 ORDER BY number DESC LIMIT 1), 0) AS upper_number
    FROM search_index_projects state WHERE state.project_id = ?1 AND ${guard.sql}`)
    .bind(project, auth.principalId, ...guard.values).first<ProjectState>();
  if (row === null) { await verifyCurrentAuth(db, auth, now); throw notFound(); }
  return row;
}

export async function getSearchIndexStatus(db: D1Database, auth: AuthContext, url: URL, now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  validateParameters(url, ["project", "allow_unfiltered"]);
  const targets = [...new Set(url.searchParams.getAll("project").map((value) => requireUuid(value, "project")))].sort();
  if (targets.length > 20) throw validationError("too_many_scope_filters", { field: "project" });
  const broad = one(url, "allow_unfiltered");
  if (broad !== null && broad !== "true" && broad !== "false") throw validationError("schema_validation_failed", { field: "allow_unfiltered" });
  if (targets.length === 0 && broad !== "true") throw validationError("explicit_search_scope_required");
  const current = await scope(db, auth, targets, now);
  const meta = await indexMeta(db);
  const guard = currentProjectGuard(auth, now, "state.project_id", 2, 3);
  const result = await db.prepare(`SELECT state.project_id, state.revision, state.event_sequence, state.retained_after,
    COALESCE((SELECT number FROM search_index_documents INDEXED BY idx_search_index_documents_project_number
      WHERE project_id = state.project_id AND is_removed = 0 ORDER BY number DESC LIMIT 1), 0) AS upper_number
    FROM search_index_projects state WHERE state.project_id IN (SELECT value FROM json_each(?1)) AND ${guard.sql}`)
    .bind(JSON.stringify(current.projects.map((project) => project.projectId)), auth.principalId, ...guard.values).all<ProjectState>();
  const states = new Map(result.results.map((state) => [state.project_id, state]));
  const finalScope = await checkScope(db, auth, current, targets, now);
  return { projection_version: meta.projection_version, instance_id: meta.instance_id, epoch: meta.epoch,
    scope_key: finalScope.key, projects: await Promise.all(finalScope.projects.map(async (project) => {
      const state = states.get(project.projectId);
      if (state === undefined) throw resetError("SEARCH_INDEX_RESET");
      const context = await cursorContext(meta, finalScope, auth, project.projectId);
      return { id: project.projectId, display_name: project.projectName,
        workspace: { id: project.workspaceId, display_name: project.workspaceName }, revision: state.revision,
        cursor: positionCursor(context, meta, { mode: "snapshot", revision: state.revision, eventSequence: state.event_sequence, upperNumber: state.upper_number, lastNumber: 0 }) };
    })) };
}

async function pageContext(db: D1Database, auth: AuthContext, url: URL, now: number, cursorParameter: "cursor" | "after") {
  validateParameters(url, ["project", cursorParameter, "limit"]);
  const project = requireUuid(one(url, "project", true), "project");
  const current = await scope(db, auth, [project], now);
  const meta = await indexMeta(db);
  const context = await cursorContext(meta, current, auth, project);
  const position = readPosition(one(url, cursorParameter, true), context, meta);
  const state = await projectState(db, auth, current, project, now);
  if (position.revision > state.revision || position.eventSequence > state.event_sequence) throw invalidCursor();
  if (position.revision < state.retained_after) throw resetError("CURSOR_EXPIRED");
  return { current, meta, context, position, state, project, limit: pageLimit(url) };
}

async function checkPagePosition(db: D1Database, auth: AuthContext, page: Awaited<ReturnType<typeof pageContext>>, now: number): Promise<void> {
  await checkScope(db, auth, page.current, [page.project], now);
  const [meta, state] = await Promise.all([indexMeta(db), projectState(db, auth, page.current, page.project, now)]);
  if (meta.epoch !== page.meta.epoch || meta.projection_version !== page.meta.projection_version) throw resetError("SEARCH_INDEX_RESET");
  // 日志保留清理可能发生在读取 head 与候选页之间，不能把已消失的变更当作空页跳过。
  if (page.position.revision < state.retained_after) throw resetError("CURSOR_EXPIRED");
}

export async function getSearchIndexSnapshot(db: D1Database, auth: AuthContext, url: URL, now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  const page = await pageContext(db, auth, url, now, "cursor");
  if (page.position.mode !== "snapshot") throw invalidCursor();
  const guard = currentProjectGuard(auth, now, 1, 6, 7);
  const rows = await db.prepare(`SELECT id, number, title, project_id, revision
    FROM search_index_documents INDEXED BY idx_search_index_documents_project_number
    WHERE project_id = ?1 AND is_removed = 0 AND number > ?2 AND number <= ?3 AND ${page.current.issueNumber === null ? "?4 IS NULL" : "number = ?4"} AND ${guard.sql}
    ORDER BY number ASC LIMIT ?5`).bind(page.project, page.position.lastNumber, page.position.upperNumber,
      page.current.issueNumber, page.limit + 1, auth.principalId, ...guard.values).all<DocumentRow>();
  await checkPagePosition(db, auth, page, now);
  const items = rows.results.slice(0, page.limit);
  return { items: items.map(document), has_more: rows.results.length > page.limit,
    next_cursor: positionCursor(page.context, page.meta, { ...page.position, lastNumber: items.at(-1)?.number ?? page.position.lastNumber }) };
}

export async function getSearchIndexChanges(db: D1Database, auth: AuthContext, url: URL, now = Date.now()): Promise<{ [key: string]: JsonValue }> {
  const page = await pageContext(db, auth, url, now, "after");
  const guard = currentProjectGuard(auth, now, 1, 6, 7);
  const rows = await db.prepare(`SELECT kind, id, number, title, project_id, revision, event_sequence, project_revision
    FROM search_index_changes ${page.current.issueNumber === null ? "" : "INDEXED BY idx_search_index_changes_issue_sequence"} WHERE project_id = ?1 AND event_sequence > ?2 AND event_sequence <= ?3
      AND ${page.current.issueNumber === null ? "?4 IS NULL" : "number = ?4"} AND ${guard.sql}
    ORDER BY event_sequence ASC LIMIT ?5`).bind(page.project, page.position.eventSequence, page.state.event_sequence,
      page.current.issueNumber, page.limit + 1, auth.principalId, ...guard.values).all<ChangeRow>();
  await checkPagePosition(db, auth, page, now);
  const hasMore = rows.results.length > page.limit;
  const batch = rows.results.slice(0, page.limit);
  const latest = new Map<string, ChangeRow>();
  for (const row of batch) latest.set(row.id, row);
  const position: Position = { mode: "changes", revision: hasMore ? batch.at(-1)!.project_revision : page.state.revision,
    eventSequence: hasMore ? batch.at(-1)!.event_sequence : page.state.event_sequence,
    upperNumber: 0, lastNumber: 0 };
  return { items: [...latest.values()].sort((a, b) => a.event_sequence - b.event_sequence).map((row) => ({ ...document(row), kind: row.kind })),
    has_more: hasMore, next_cursor: positionCursor(page.context, page.meta, position), revision: page.state.revision };
}

export async function searchIndexRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1", error);
  }
}
