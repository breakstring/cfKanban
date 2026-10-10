import { TREND_DAY_MS, utcTrendDate, type TrendDelta } from "../domain/issue-trends.ts";
import { platformUnavailable } from "../kernel/errors.ts";

interface IssueState { status_key: string; milestone_id: string | null; active: number }
export interface TrendBackfillJob extends IssueState {
  issue_id: string; project_id: string; cursor: number; created_at: number;
  last_date: string; oldest_date: string; ceiling_date: string; uncertain?: number; unknown_latest_date?: string | null; version: number;
}
export interface TrendHistoryEvent { sequence: number; type: string; created_at: number; payload_json: string }
interface HistoryDelta extends TrendDelta { milestone_key: string }
interface ReplayResult {
  next: TrendBackfillJob; deltas: HistoryDelta[]; finished: boolean; partial: boolean;
  stockFrom: string; flowFrom: string;
}
const statuses = new Set(["backlog", "todo", "in_progress", "done", "canceled"]);
const relevant = new Set(["issue.created", "issue.updated", "issue.completed", "issue.deleted", "issue.restored"]);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const nextDate = (date: string) => utcTrendDate(Date.parse(`${date}T00:00:00Z`) + TREND_DAY_MS);
function totals(state: IssueState | null, milestone: string) {
  const included = state !== null && state.active === 1 && (milestone === "" || milestone === state.milestone_id);
  return { total: Number(included), done: Number(included && state?.status_key === "done"),
    canceled: Number(included && state?.status_key === "canceled") };
}

// Sequence 驱动状态逆推，时间只用于分桶；无法证明的旧状态不补成默认 backlog。
export function replayTrendHistory(job: TrendBackfillJob, events: readonly TrendHistoryEvent[]): ReplayResult {
  const next = { ...job };
  const deltas = new Map<string, HistoryDelta>();
  let finished = false;
  const markUnknown = (date: string) => {
    next.uncertain = 1;
    if (next.unknown_latest_date == null || date > next.unknown_latest_date) next.unknown_latest_date = date;
  };
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence >= next.cursor) {
      markUnknown(job.ceiling_date); finished = true; break;
    }
    next.cursor = event.sequence;
    let date: string;
    try { date = utcTrendDate(event.created_at); }
    catch { markUnknown(job.ceiling_date); continue; }
    if (next.uncertain === 1) { markUnknown(date); continue; }
    if (!relevant.has(event.type)) continue;
    if (date > next.last_date) { markUnknown(date); continue; }
    const current: IssueState = { status_key: next.status_key, milestone_id: next.milestone_id, active: next.active };
    let previous: IssueState | null = { ...current };
    let payload: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(event.payload_json);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
      payload = decoded as Record<string, unknown>;
    } catch { markUnknown(date); continue; }
    let valid = true;
    if (event.type === "issue.created") {
      valid = current.active === 1 && (!own(payload, "status_key") || (statuses.has(String(payload.status_key)) && payload.status_key === current.status_key))
        && (own(payload, "milestone_id") ? payload.milestone_id === current.milestone_id : current.milestone_id === null)
        && utcTrendDate(job.created_at) === date;
      previous = null;
    } else if (event.type === "issue.updated" || event.type === "issue.completed") {
      const statusChanged = event.type === "issue.completed" || payload.status_changed === true;
      // 旧版 updated 没有明确 status_changed 标记，不能把它假定为普通标题编辑。
      valid = current.active === 1 && (event.type === "issue.completed" || typeof payload.status_changed === "boolean");
      if (statusChanged) {
        valid &&= statuses.has(String(payload.old_status_key)) && statuses.has(String(payload.new_status_key))
          && payload.new_status_key === current.status_key;
        previous.status_key = String(payload.old_status_key);
      }
      if (payload.milestone_changed === true) {
        valid &&= own(payload, "old_milestone_id") && own(payload, "new_milestone_id")
          && (payload.old_milestone_id === null || typeof payload.old_milestone_id === "string")
          && payload.new_milestone_id === current.milestone_id;
        previous.milestone_id = payload.old_milestone_id as string | null;
      }
    } else if (event.type === "issue.deleted") {
      valid = current.active === 0; previous.active = 1;
    } else if (event.type === "issue.restored") {
      valid = current.active === 1; previous.active = 0;
    }
    if (!valid) { markUnknown(date); continue; }
    const keys = new Set(["", current.milestone_id, previous?.milestone_id].filter((key): key is string => typeof key === "string"));
    for (const milestone_key of keys) {
      const newer = totals(current, milestone_key), older = totals(previous, milestone_key);
      const key = `${milestone_key}:${date}`;
      const delta = deltas.get(key) ?? { milestone_key, date, total_delta: 0, done_delta: 0, canceled_delta: 0,
        created: 0, completed: 0, reopened: 0 };
      delta.total_delta += newer.total - older.total;
      delta.done_delta += newer.done - older.done;
      delta.canceled_delta += newer.canceled - older.canceled;
      if (event.type === "issue.created" && (milestone_key === "" || current.milestone_id === milestone_key)) delta.created++;
      if (previous?.active === 1 && current.active === 1 && previous.status_key !== "done" && current.status_key === "done"
        && (milestone_key === "" || current.milestone_id === milestone_key)) delta.completed++;
      if (previous?.active === 1 && current.active === 1 && previous.status_key === "done"
        && ["backlog", "todo", "in_progress"].includes(current.status_key)
        && (milestone_key === "" || current.milestone_id === milestone_key)) delta.reopened++;
      deltas.set(key, delta);
    }
    next.last_date = next.oldest_date = date;
    if (previous === null) { finished = true; break; }
    Object.assign(next, previous);
  }
  if (!finished && events.length < 100) {
    finished = true;
    if (next.uncertain !== 1) markUnknown(next.oldest_date);
    markUnknown(utcTrendDate(job.created_at));
  }
  const partial = next.uncertain === 1;
  const boundary = next.unknown_latest_date ?? next.oldest_date;
  return { next, deltas: [...deltas.values()].filter(delta => [delta.total_delta,delta.done_delta,delta.canceled_delta,delta.created,delta.completed,delta.reopened].some(value => value !== 0)), finished, partial,
    stockFrom: partial ? boundary : utcTrendDate(job.created_at),
    flowFrom: partial ? nextDate(boundary) : utcTrendDate(job.created_at) };
}

export const TREND_HISTORY_PAGE_SQL = `SELECT sequence,type,created_at,payload_json
  FROM events INDEXED BY idx_events_issue_trend_history
  WHERE project_id=?1 AND subject_id=?2 AND stream='domain' AND subject_type='issue' AND sequence<?3
  ORDER BY sequence DESC LIMIT 100`;

// 每批次以 job version + 随机标记锁定派生写；重放、竞争或 purge 都不能重复累计。
export async function backfillIssueTrends(db: D1Database, maxJobs = 8, options: { deadline?: number } = {}): Promise<{ processed: number; finished: number }> {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 20) throw new RangeError("invalid trend backfill bound");
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline < 0)) throw new RangeError("invalid trend backfill deadline");
  const expired = () => options.deadline !== undefined && Date.now() >= options.deadline;
  if (expired()) return { processed: 0, finished: 0 };
  try {
    const jobs = await db.prepare("SELECT * FROM issue_trend_backfill ORDER BY issue_id LIMIT ?1").bind(maxJobs).all<TrendBackfillJob>();
    let processed = 0, finished = 0;
    for (const job of jobs.results) {
      if (expired()) break;
      const events = await db.prepare(TREND_HISTORY_PAGE_SQL).bind(job.project_id, job.issue_id, job.cursor).all<TrendHistoryEvent>();
      if (expired()) break;
      const replay = replayTrendHistory(job, events.results), batchId = crypto.randomUUID(), version = job.version + 1;
      const gate = "EXISTS (SELECT 1 FROM issue_trend_backfill WHERE issue_id=?1 AND version=?2 AND batch_id=?3)";
      const statements = [db.prepare(`UPDATE issue_trend_backfill SET cursor=?1,status_key=?2,milestone_id=?3,active=?4,
        last_date=?5,oldest_date=?6,version=?7,batch_id=?8,uncertain=?11,unknown_latest_date=?12 WHERE issue_id=?9 AND version=?10`)
        .bind(replay.next.cursor, replay.next.status_key, replay.next.milestone_id, replay.next.active,
          replay.next.last_date, replay.next.oldest_date, version, batchId, job.issue_id, job.version, replay.next.uncertain ?? 0, replay.next.unknown_latest_date ?? null),
        db.prepare(`INSERT INTO issue_trend_days(project_id,milestone_key,date,total_delta,done_delta,canceled_delta,created,completed,reopened)
          SELECT ?4,json_extract(value,'$.milestone_key'),json_extract(value,'$.date'),json_extract(value,'$.total_delta'),
            json_extract(value,'$.done_delta'),json_extract(value,'$.canceled_delta'),json_extract(value,'$.created'),
            json_extract(value,'$.completed'),json_extract(value,'$.reopened')
          FROM json_each(?5) WHERE ${gate}
          ON CONFLICT(project_id,milestone_key,date) DO UPDATE SET total_delta=total_delta+excluded.total_delta,
            done_delta=done_delta+excluded.done_delta,canceled_delta=canceled_delta+excluded.canceled_delta,
            created=created+excluded.created,completed=completed+excluded.completed,reopened=reopened+excluded.reopened`)
          .bind(job.issue_id, version, batchId, job.project_id, JSON.stringify(replay.deltas))];
      if (replay.finished) {
        statements.push(db.prepare(`UPDATE issue_trend_projects SET pending_jobs=pending_jobs-1,
          partial=MAX(partial,?4),history_stock_from=MAX(history_stock_from,?5),history_flow_from=MAX(history_flow_from,?6),
          stock_from=CASE WHEN pending_jobs=1 THEN MAX(history_stock_from,?5) ELSE stock_from END,
          flow_from=CASE WHEN pending_jobs=1 THEN MAX(history_flow_from,?6) ELSE flow_from END
          WHERE project_id=?7 AND ${gate}`).bind(job.issue_id, version, batchId, Number(replay.partial),
            replay.partial ? replay.stockFrom : "", replay.partial ? replay.flowFrom : "", job.project_id),
        db.prepare(`DELETE FROM issue_trend_backfill WHERE issue_id=?1 AND version=?2 AND batch_id=?3`)
          .bind(job.issue_id, version, batchId));
      }
      if (expired()) break;
      const results = await db.batch(statements);
      if (results[0]?.meta.changes === 1) { processed++; if (replay.finished) finished++; }
    }
    return { processed, finished };
  } catch (error) { throw platformUnavailable("d1", error); }
}
