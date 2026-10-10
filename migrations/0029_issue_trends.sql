CREATE TABLE issue_trend_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  baseline_date TEXT NOT NULL,
  stock_from TEXT NOT NULL,
  flow_from TEXT NOT NULL,
  history_stock_from TEXT NOT NULL,
  history_flow_from TEXT NOT NULL,
  pending_jobs INTEGER NOT NULL CHECK (pending_jobs >= 0),
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0,1))
);
CREATE TABLE issue_trend_totals (
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_key TEXT NOT NULL DEFAULT '',
  known_from TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  canceled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id,milestone_key),
  CHECK (total >= 0 AND done >= 0 AND canceled >= 0 AND done+canceled <= total)
) WITHOUT ROWID;
CREATE TABLE issue_trend_days (
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_key TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  total_delta INTEGER NOT NULL DEFAULT 0,
  done_delta INTEGER NOT NULL DEFAULT 0,
  canceled_delta INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0 CHECK (created >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed >= 0),
  reopened INTEGER NOT NULL DEFAULT 0 CHECK (reopened >= 0),
  PRIMARY KEY (project_id,milestone_key,date)
) WITHOUT ROWID;
CREATE TABLE issue_trend_states (
  issue_id TEXT PRIMARY KEY REFERENCES issues(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  status_key TEXT NOT NULL,
  milestone_id TEXT,
  active INTEGER NOT NULL CHECK (active IN (0,1))
);
CREATE INDEX idx_issue_trend_states_project ON issue_trend_states(project_id,issue_id);
CREATE TABLE issue_trend_backfill (
  issue_id TEXT PRIMARY KEY REFERENCES issues(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  cursor INTEGER NOT NULL,
  status_key TEXT NOT NULL,
  milestone_id TEXT,
  active INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_date TEXT NOT NULL,
  oldest_date TEXT NOT NULL,
  ceiling_date TEXT NOT NULL,
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0,1)),
  unknown_latest_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  batch_id TEXT
);
CREATE INDEX idx_issue_trend_backfill_project ON issue_trend_backfill(project_id,issue_id);
CREATE INDEX idx_events_issue_trend_history ON events(project_id,subject_id,sequence DESC)
  WHERE stream='domain' AND subject_type='issue';

-- 迁移事务冻结真实当前状态与 Event 水位；后台只回放此水位之前的历史。
INSERT INTO issue_trend_projects
SELECT p.id,date('now'),date('now'),date('now','+1 day'),date(p.created_at/1000,'unixepoch'),date(p.created_at/1000,'unixepoch'),
  (SELECT COUNT(*) FROM issues i WHERE i.project_id=p.id),0
FROM projects p WHERE p.purged_at IS NULL;
UPDATE issue_trend_projects SET stock_from=(SELECT date(p.created_at/1000,'unixepoch') FROM projects p WHERE p.id=project_id),
  flow_from=(SELECT date(p.created_at/1000,'unixepoch') FROM projects p WHERE p.id=project_id)
WHERE pending_jobs=0;
INSERT INTO issue_trend_totals(project_id,milestone_key,total,done,canceled)
SELECT p.id,'',COUNT(i.id),COALESCE(SUM(i.status_key='done'),0),COALESCE(SUM(i.status_key='canceled'),0)
FROM projects p LEFT JOIN issues i ON i.project_id=p.id AND i.deleted_at IS NULL
WHERE p.purged_at IS NULL GROUP BY p.id;
INSERT INTO issue_trend_totals(project_id,milestone_key,total,done,canceled)
SELECT project_id,id,current_total,current_done,current_canceled FROM milestones;
INSERT INTO issue_trend_states SELECT id,project_id,status_key,milestone_id,deleted_at IS NULL FROM issues;
INSERT INTO issue_trend_backfill(issue_id,project_id,cursor,status_key,milestone_id,active,created_at,last_date,oldest_date,ceiling_date)
SELECT id,project_id,(SELECT COALESCE(MAX(sequence),0)+1 FROM events),status_key,milestone_id,
  deleted_at IS NULL,created_at,date('now'),date('now'),
  MAX(date('now'),COALESCE((SELECT date(created_at/1000,'unixepoch') FROM events ORDER BY created_at DESC,sequence DESC LIMIT 1),date('now'))) FROM issues;

CREATE TRIGGER issue_trend_project_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO issue_trend_projects VALUES(NEW.id,date(NEW.created_at/1000,'unixepoch'),
    date(NEW.created_at/1000,'unixepoch'),date(NEW.created_at/1000,'unixepoch'),
    date(NEW.created_at/1000,'unixepoch'),date(NEW.created_at/1000,'unixepoch'),0,0);
  INSERT INTO issue_trend_totals(project_id) VALUES(NEW.id);
END;
CREATE TRIGGER issue_trend_milestone_insert AFTER INSERT ON milestones
BEGIN INSERT INTO issue_trend_totals(project_id,milestone_key,known_from) VALUES(NEW.project_id,NEW.id,date(NEW.created_at/1000,'unixepoch')); END;

-- Event 与领域写入共享事务。缓存只参与真实统计状态改变及流量事件。
CREATE TRIGGER issue_trend_event AFTER INSERT ON events
WHEN NEW.stream='domain' AND NEW.subject_type='issue'
  AND NEW.type IN ('issue.created','issue.updated','issue.completed','issue.deleted','issue.restored')
  AND EXISTS (SELECT 1 FROM issues i LEFT JOIN issue_trend_states s ON s.issue_id=i.id
    WHERE i.id=NEW.subject_id AND i.project_id=NEW.project_id
      AND (s.issue_id IS NULL OR s.status_key IS NOT i.status_key OR s.milestone_id IS NOT i.milestone_id
        OR s.active != (i.deleted_at IS NULL) OR NEW.type IN ('issue.created','issue.completed')))
BEGIN
  INSERT INTO issue_trend_days(project_id,milestone_key,date,total_delta,done_delta,canceled_delta,created,completed,reopened)
  SELECT i.project_id,k.milestone_key,date(NEW.created_at/1000,'unixepoch'),
    (i.deleted_at IS NULL AND (k.milestone_key='' OR k.milestone_key IS i.milestone_id))
      -COALESCE(s.active AND (k.milestone_key='' OR k.milestone_key IS s.milestone_id),0),
    (i.deleted_at IS NULL AND i.status_key='done' AND (k.milestone_key='' OR k.milestone_key IS i.milestone_id))
      -COALESCE(s.active AND s.status_key='done' AND (k.milestone_key='' OR k.milestone_key IS s.milestone_id),0),
    (i.deleted_at IS NULL AND i.status_key='canceled' AND (k.milestone_key='' OR k.milestone_key IS i.milestone_id))
      -COALESCE(s.active AND s.status_key='canceled' AND (k.milestone_key='' OR k.milestone_key IS s.milestone_id),0),
    NEW.type='issue.created' AND (k.milestone_key='' OR k.milestone_key IS i.milestone_id),
    COALESCE(s.active AND i.deleted_at IS NULL AND s.status_key!='done' AND i.status_key='done'
      AND (k.milestone_key='' OR k.milestone_key IS i.milestone_id),0),
    COALESCE(s.active AND i.deleted_at IS NULL AND s.status_key='done'
      AND i.status_key IN ('backlog','todo','in_progress') AND (k.milestone_key='' OR k.milestone_key IS i.milestone_id),0)
  FROM issues i LEFT JOIN issue_trend_states s ON s.issue_id=i.id
  CROSS JOIN (SELECT '' AS milestone_key UNION SELECT milestone_id FROM issues WHERE id=NEW.subject_id AND milestone_id IS NOT NULL
    UNION SELECT milestone_id FROM issue_trend_states WHERE issue_id=NEW.subject_id AND milestone_id IS NOT NULL) k
  WHERE i.id=NEW.subject_id
  ON CONFLICT(project_id,milestone_key,date) DO UPDATE SET
    total_delta=total_delta+excluded.total_delta,done_delta=done_delta+excluded.done_delta,
    canceled_delta=canceled_delta+excluded.canceled_delta,created=created+excluded.created,
    completed=completed+excluded.completed,reopened=reopened+excluded.reopened;
  UPDATE issue_trend_totals SET
    total=total+(SELECT (i.deleted_at IS NULL AND (issue_trend_totals.milestone_key='' OR issue_trend_totals.milestone_key IS i.milestone_id))
      -COALESCE(s.active AND (issue_trend_totals.milestone_key='' OR issue_trend_totals.milestone_key IS s.milestone_id),0)
      FROM issues i LEFT JOIN issue_trend_states s ON s.issue_id=i.id WHERE i.id=NEW.subject_id),
    done=done+(SELECT (i.deleted_at IS NULL AND i.status_key='done' AND (issue_trend_totals.milestone_key='' OR issue_trend_totals.milestone_key IS i.milestone_id))
      -COALESCE(s.active AND s.status_key='done' AND (issue_trend_totals.milestone_key='' OR issue_trend_totals.milestone_key IS s.milestone_id),0)
      FROM issues i LEFT JOIN issue_trend_states s ON s.issue_id=i.id WHERE i.id=NEW.subject_id),
    canceled=canceled+(SELECT (i.deleted_at IS NULL AND i.status_key='canceled' AND (issue_trend_totals.milestone_key='' OR issue_trend_totals.milestone_key IS i.milestone_id))
      -COALESCE(s.active AND s.status_key='canceled' AND (issue_trend_totals.milestone_key='' OR issue_trend_totals.milestone_key IS s.milestone_id),0)
      FROM issues i LEFT JOIN issue_trend_states s ON s.issue_id=i.id WHERE i.id=NEW.subject_id)
  WHERE project_id=NEW.project_id AND (milestone_key='' OR milestone_key IN (
    SELECT milestone_id FROM issues WHERE id=NEW.subject_id UNION SELECT milestone_id FROM issue_trend_states WHERE issue_id=NEW.subject_id));
  INSERT INTO issue_trend_states SELECT id,project_id,status_key,milestone_id,deleted_at IS NULL FROM issues WHERE id=NEW.subject_id
  ON CONFLICT(issue_id) DO UPDATE SET status_key=excluded.status_key,milestone_id=excluded.milestone_id,active=excluded.active;
END;

UPDATE instance_meta SET schema_version=29 WHERE schema_version=28;
