import { requireUuid, timestamp } from "../domain/model.ts";
import { WEB_SESSION_ABSOLUTE_LIFETIME_MS } from "../domain/web-session-policy.ts";
import { aggregateTrendPoints, trendWindow, utcTrendDate, type TrendDelta } from "../domain/issue-trends.ts";
import { buildCurrentAuthGuard, currentProjectRoleSql, resolveCurrentWorkspaceProjects, verifyCurrentAuth, type VisibleProject } from "../kernel/authorization.ts";
import { ApiError, notFound, platformUnavailable, validationError } from "../kernel/errors.ts";
import { cursorScopeMismatch } from "../kernel/cursor.ts";
import type { AuthContext, JsonValue } from "../kernel/types.ts";

interface TrendRow {
  id: string; display_name: string; created_at: number; total: number; done: number; canceled: number;
  stock_from: string; flow_from: string; pending_jobs: number; partial: number; deltas: TrendDelta[];
}
interface TrendEnvelope { observed_at: number; projects_json: string }
export interface TrendReadOptions { snapshotTime?: number }
const scopeKey = (projects: readonly VisibleProject[]) => JSON.stringify(projects.map(project => [project.projectId, project.projectVersion, project.role]));
function parameters(url: URL, projectLevel: boolean): { projectIds?: string[]; milestone: string | null } {
  const allowed = new Set(projectLevel ? ["days", "milestone"] : ["days", "project"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw validationError("unsupported_query_option", { field: key });
  const rawProjects = url.searchParams.getAll("project"), rawMilestones = url.searchParams.getAll("milestone");
  if (rawProjects.length > 100) throw validationError("too_many_scope_filters", { field: "project", maximum: 100 });
  if (rawMilestones.length > 1) throw validationError("schema_validation_failed", { field: "milestone" });
  return { ...(rawProjects.length === 0 ? {} : { projectIds: [...new Set(rawProjects.map(value => requireUuid(value, "project")))].sort() }),
    milestone: rawMilestones.length === 0 ? null : requireUuid(rawMilestones[0]!, "milestone") };
}

async function readTrends(db: D1Database, auth: AuthContext, workspaceValue: JsonValue, projectValue: JsonValue | undefined, url: URL, now: number, options: TrendReadOptions) {
  const workspaceId = requireUuid(workspaceValue, "workspace_id"), projectId = projectValue === undefined ? undefined : requireUuid(projectValue, "project_id");
  const filter = parameters(url, projectId !== undefined), requestedWindow = trendWindow(url, now);
  if (options.snapshotTime !== undefined && (!Number.isSafeInteger(options.snapshotTime) || options.snapshotTime < 0)) throw new RangeError("invalid trend observation clock");
  const requested = projectId === undefined ? filter.projectIds : [projectId];
  const authorizationTime = Date.now();
  await verifyCurrentAuth(db, auth, authorizationTime);
  if (auth.kind === "cookie" && auth.targetKind === "issue") throw notFound();
  try {
    const projects = await resolveCurrentWorkspaceProjects(db, auth, workspaceId, authorizationTime, requested);
    if (projects.length > 100) throw validationError("too_many_trend_projects", { maximum: 100 });
    if (requested !== undefined && projects.length !== requested.length) throw notFound();
    if (projects.length === 0) {
      // Owner 可读取空 Workspace；普通成员必须有至少一个可见 Project。
      if (!auth.isOwner || auth.kind === "cookie" && auth.targetKind !== "admin"
        && !(auth.targetKind === "workspace" && auth.target.workspace_id === workspaceId)) throw notFound();
      const exists = await db.prepare("SELECT 1 FROM workspaces WHERE id=?1 AND deleted_at IS NULL AND purged_at IS NULL").bind(workspaceId).first();
      if (exists === null) throw notFound();
    }
    if (filter.milestone !== null) {
      const exists = await db.prepare("SELECT 1 FROM milestones WHERE id=?1 AND project_id=?2").bind(filter.milestone, projectId!).first();
      if (exists === null) throw notFound();
    }
    const ids = projects.map(project => project.projectId), guard = buildCurrentAuthGuard(auth, authorizationTime, 7);
    // SQLite 的 now 在同一次 step 中固定；存量、日期范围与观测时间共享一个快照。
    const envelope = await db.prepare(`WITH trend_clock AS MATERIALIZED (
      SELECT CASE WHEN ?4 IS NULL THEN CAST(strftime('%s','now') AS INTEGER)*1000
        +CAST(substr(strftime('%f','now'),4,3) AS INTEGER) ELSE ?4 END AS observed_at
    ), trend_rows AS (
      SELECT p.id,p.display_name,COALESCE(m.created_at,p.created_at) AS created_at,
      COALESCE(t.total,0) AS total,COALESCE(t.done,0) AS done,COALESCE(t.canceled,0) AS canceled,
      COALESCE(t.known_from,h.stock_from) AS stock_from,COALESCE(t.known_from,h.flow_from) AS flow_from,
      CASE WHEN t.known_from IS NOT NULL THEN 0 ELSE h.pending_jobs END AS pending_jobs,
      CASE WHEN t.known_from IS NOT NULL THEN 0 ELSE h.partial END AS partial,
      (SELECT json_group_array(json_object('date',d.date,'total_delta',d.total_delta,'done_delta',d.done_delta,
        'canceled_delta',d.canceled_delta,'created',d.created,'completed',d.completed,'reopened',d.reopened))
       FROM issue_trend_days d WHERE d.project_id=p.id AND d.milestone_key=?2
         AND d.date>=date(trend_clock.observed_at/1000,'unixepoch','-'||(?3-1)||' days')
         AND d.date<=date(trend_clock.observed_at/1000,'unixepoch')) AS deltas_json
      FROM json_each(?1) selected CROSS JOIN projects p ON p.id=selected.value
      JOIN workspaces w ON w.id=p.workspace_id JOIN issue_trend_projects h ON h.project_id=p.id
      LEFT JOIN issue_trend_totals t ON t.project_id=p.id AND t.milestone_key=?2
      LEFT JOIN milestones m ON m.id=?2 AND m.project_id=p.id
      CROSS JOIN trend_clock
      WHERE w.id=?5 AND p.deleted_at IS NULL AND p.purged_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL
        AND (?2='' OR m.id IS NOT NULL) AND ${guard.sql}
        ${auth.kind === "cookie" ? `AND EXISTS (SELECT 1 FROM web_sessions session WHERE session.id=?7
          AND session.expires_at>trend_clock.observed_at AND session.created_at+${WEB_SESSION_ABSOLUTE_LIFETIME_MS}>trend_clock.observed_at)` : ""}
        AND (${auth.isOwner ? "1=1" : `${currentProjectRoleSql("?6")} IS NOT NULL`})
      ORDER BY p.id
    ) SELECT trend_clock.observed_at,(SELECT json_group_array(json_object('id',id,'display_name',display_name,
      'created_at',created_at,'total',total,'done',done,'canceled',canceled,'stock_from',stock_from,'flow_from',flow_from,
      'pending_jobs',pending_jobs,'partial',partial,'deltas',json(deltas_json))) FROM trend_rows) AS projects_json
      FROM trend_clock`).bind(JSON.stringify(ids), filter.milestone ?? "", requestedWindow.days, options.snapshotTime ?? null,
        workspaceId, auth.principalId, ...guard.values).all<TrendEnvelope>();
    const observedAt = envelope.results[0]!.observed_at, rows = JSON.parse(envelope.results[0]!.projects_json) as TrendRow[];
    const window = trendWindow(url, observedAt), currentTime = Math.max(Date.now(), observedAt);
    await verifyCurrentAuth(db, auth, currentTime);
    const current = await resolveCurrentWorkspaceProjects(db, auth, workspaceId, currentTime, requested);
    if (requested !== undefined && current.length !== requested.length) throw notFound();
    if (scopeKey(current) !== scopeKey(projects)) throw cursorScopeMismatch();
    if (rows.length !== ids.length) throw notFound();
    if (ids.length === 0 && await db.prepare("SELECT 1 FROM workspaces WHERE id=?1 AND deleted_at IS NULL AND purged_at IS NULL")
      .bind(workspaceId).first() === null) throw notFound();
    return { timezone: "UTC", from_date: window.from, to_date: window.to, observed_at: timestamp(observedAt),
      scope: { workspace_id: workspaceId, project_ids: ids, milestone_id: filter.milestone },
      projects: rows.map(row => ({ id: row.id, display_name: row.display_name, stock_from: row.stock_from,
        flow_from: row.flow_from, history_state: row.pending_jobs > 0 ? "pending" : row.partial ? "partial" : "complete" })),
      points: aggregateTrendPoints(window.dates, rows.map(row => ({ current: { total: row.total, done: row.done, canceled: row.canceled },
        created_date: utcTrendDate(row.created_at), stock_from: row.stock_from, flow_from: row.flow_from,
        deltas: row.deltas }))).map(point => ({ ...point })) };
  } catch (error) { if (error instanceof ApiError) throw error; throw platformUnavailable("d1", error); }
}

export function getProjectIssueTrends(db: D1Database, auth: AuthContext, workspaceId: JsonValue, projectId: JsonValue, url: URL, now: number, options: TrendReadOptions = {}) {
  return readTrends(db, auth, workspaceId, projectId, url, now, options);
}
export function getWorkspaceIssueTrends(db: D1Database, auth: AuthContext, workspaceId: JsonValue, url: URL, now: number, options: TrendReadOptions = {}) {
  return readTrends(db, auth, workspaceId, undefined, url, now, options);
}
