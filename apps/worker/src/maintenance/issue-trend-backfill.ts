import { replayTrendHistory, type TrendBackfillJob, type TrendHistoryEvent } from "../services/issue-trend-projection.ts";

export const BACKFILL_ALGORITHM_VERSION = 1;
export const HISTORY_PAGE_LIMIT = 100;
export const JOB_PAGE_SQL = `SELECT issue_id,project_id,cursor,status_key,milestone_id,active,created_at,
  last_date,oldest_date,ceiling_date,uncertain,unknown_latest_date,version,batch_id
  FROM issue_trend_backfill ORDER BY issue_id LIMIT ?1`;

const replayKeys = ["status_key", "milestone_id", "status_changed", "old_status_key", "new_status_key",
  "milestone_changed", "old_milestone_id", "new_milestone_id"];
// 必须保留缺失键与 JSON boolean 的差别；正文、标题、评论等内容不离开数据库。
const projectedPayload = `json_remove(json_object(${replayKeys.map(key => `'${key}',json(CASE json_type(payload_json,'$.${key}')
  WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
  ELSE json_quote(json_extract(payload_json,'$.${key}')) END)`).join(",")}),
  ${replayKeys.map(key => `CASE WHEN json_type(payload_json,'$.${key}') IS NULL THEN '$.${key}' ELSE '$.__unused__' END`).join(",")})`;
export const TREND_HISTORY_PAGE_SQL = `SELECT sequence,type,created_at,
  CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json)='object'
    THEN ${projectedPayload} ELSE 'null' END ELSE 'null' END AS payload_json
  FROM events INDEXED BY idx_events_issue_trend_history
  WHERE project_id=?1 AND subject_id=?2 AND stream='domain' AND subject_type='issue' AND sequence<?3
  ORDER BY sequence DESC LIMIT ${HISTORY_PAGE_LIMIT}`;

export function createTrendBackfillCommit(job: TrendBackfillJob, events: readonly TrendHistoryEvent[],
  options: { batchId: string; runId: string; fence: number }) {
  if (events.length > HISTORY_PAGE_LIMIT) throw new RangeError("invalid trend history page bound");
  if (!Number.isSafeInteger(options.fence) || options.fence < 1 || !options.batchId || !options.runId) {
    throw new RangeError("invalid trend backfill lease");
  }
  const replay = replayTrendHistory(job, events);
  const payload = JSON.stringify({ algorithm_version: BACKFILL_ALGORITHM_VERSION,
    run_id: options.runId, fence: options.fence, finished: replay.finished, partial: replay.partial,
    stock_from: replay.stockFrom, flow_from: replay.flowFrom, deltas: replay.deltas });
  return {
    sql: `UPDATE issue_trend_backfill SET cursor=?1,status_key=?2,milestone_id=?3,active=?4,
      last_date=?5,oldest_date=?6,version=version+1,batch_id=?7,uncertain=?8,unknown_latest_date=?9,replay_json=?10
      WHERE issue_id=?11 AND version=?12 AND cursor=?13 AND EXISTS (SELECT 1 FROM issue_trend_backfill_control
        WHERE id=1 AND run_id=?14 AND fence=?15 AND lease_until>=CAST(strftime('%s','now') AS INTEGER)*1000)`,
    params: [replay.next.cursor, replay.next.status_key, replay.next.milestone_id, replay.next.active,
      replay.next.last_date, replay.next.oldest_date, options.batchId, replay.next.uncertain ?? 0,
      replay.next.unknown_latest_date ?? null, payload, job.issue_id, job.version, job.cursor, options.runId, options.fence],
    finished: replay.finished, partial: replay.partial, event_count: events.length, next_cursor: replay.next.cursor,
  };
}
