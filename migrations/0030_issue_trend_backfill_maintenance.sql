ALTER TABLE issue_trend_backfill ADD COLUMN replay_json TEXT;

CREATE TABLE issue_trend_backfill_control (
  id INTEGER PRIMARY KEY CHECK (id=1),
  run_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
  fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
  last_batch_id TEXT,
  last_issue_id TEXT,
  last_version INTEGER
);
INSERT INTO issue_trend_backfill_control(id) VALUES(1);

-- 单条 CAS 的触发器与游标、历史派生写共享 SQLite 原子单元；旧版 batch 不写 replay_json。
-- CASE / END 保留周围空白，供固定版本 Wrangler 正确识别 trigger 内的复合语句。
CREATE TRIGGER issue_trend_backfill_commit AFTER UPDATE OF replay_json ON issue_trend_backfill
WHEN NEW.replay_json IS NOT NULL
BEGIN
  SELECT CASE WHEN json_valid(NEW.replay_json)=0 THEN RAISE(ABORT,'invalid trend replay') END;
  SELECT CASE WHEN json_type(NEW.replay_json) IS NOT 'object'
    OR json_extract(NEW.replay_json,'$.algorithm_version') IS NOT 1
    OR json_type(NEW.replay_json,'$.deltas') IS NOT 'array'
    OR (json_type(NEW.replay_json,'$.finished') IS NOT 'true' AND json_type(NEW.replay_json,'$.finished') IS NOT 'false')
    OR (json_type(NEW.replay_json,'$.partial') IS NOT 'true' AND json_type(NEW.replay_json,'$.partial') IS NOT 'false')
    OR NEW.batch_id IS NULL OR NEW.version != OLD.version+1
    OR NOT EXISTS (SELECT 1 FROM issue_trend_backfill_control
      WHERE id=1 AND run_id=json_extract(NEW.replay_json,'$.run_id')
        AND fence=json_extract(NEW.replay_json,'$.fence')
        AND lease_until>=CAST(strftime('%s','now') AS INTEGER)*1000)
    THEN RAISE(ABORT,'invalid trend replay lease') END;

  INSERT INTO issue_trend_days(project_id,milestone_key,date,total_delta,done_delta,canceled_delta,created,completed,reopened)
  SELECT NEW.project_id,json_extract(value,'$.milestone_key'),json_extract(value,'$.date'),
    json_extract(value,'$.total_delta'),json_extract(value,'$.done_delta'),json_extract(value,'$.canceled_delta'),
    json_extract(value,'$.created'),json_extract(value,'$.completed'),json_extract(value,'$.reopened')
  FROM json_each(NEW.replay_json,'$.deltas') WHERE 1
  ON CONFLICT(project_id,milestone_key,date) DO UPDATE SET
    total_delta=total_delta+excluded.total_delta,done_delta=done_delta+excluded.done_delta,
    canceled_delta=canceled_delta+excluded.canceled_delta,created=created+excluded.created,
    completed=completed+excluded.completed,reopened=reopened+excluded.reopened;

  UPDATE issue_trend_projects SET pending_jobs=pending_jobs-1,
    partial=MAX(partial,json_extract(NEW.replay_json,'$.partial')),
    history_stock_from=MAX(history_stock_from, CASE WHEN json_extract(NEW.replay_json,'$.partial')
      THEN json_extract(NEW.replay_json,'$.stock_from') ELSE '' END ),
    history_flow_from=MAX(history_flow_from, CASE WHEN json_extract(NEW.replay_json,'$.partial')
      THEN json_extract(NEW.replay_json,'$.flow_from') ELSE '' END ),
    stock_from= CASE WHEN pending_jobs=1 THEN MAX(history_stock_from, CASE WHEN json_extract(NEW.replay_json,'$.partial')
      THEN json_extract(NEW.replay_json,'$.stock_from') ELSE '' END ) ELSE stock_from END ,
    flow_from= CASE WHEN pending_jobs=1 THEN MAX(history_flow_from, CASE WHEN json_extract(NEW.replay_json,'$.partial')
      THEN json_extract(NEW.replay_json,'$.flow_from') ELSE '' END ) ELSE flow_from END
  WHERE project_id=NEW.project_id AND json_extract(NEW.replay_json,'$.finished');

  UPDATE issue_trend_backfill_control SET last_batch_id=NEW.batch_id,last_issue_id=NEW.issue_id,last_version=NEW.version
  WHERE id=1;
  DELETE FROM issue_trend_backfill WHERE issue_id=NEW.issue_id AND json_extract(NEW.replay_json,'$.finished');
  UPDATE issue_trend_backfill SET replay_json=NULL WHERE issue_id=NEW.issue_id;
END;

UPDATE instance_meta SET schema_version=30 WHERE schema_version=29;
