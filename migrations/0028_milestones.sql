CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(CAST(description AS BLOB)) <= 8192),
  due_date TEXT CHECK (due_date IS NULL OR (
    length(due_date) = 10 AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(due_date, 1, 4) != '0000' AND COALESCE(date(due_date, '+0 days') = due_date, 0)
  )),
  status_key TEXT NOT NULL DEFAULT 'open' CHECK (status_key IN ('open', 'closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  current_total INTEGER NOT NULL DEFAULT 0 CHECK (current_total >= 0),
  current_done INTEGER NOT NULL DEFAULT 0 CHECK (current_done >= 0),
  current_canceled INTEGER NOT NULL DEFAULT 0 CHECK (current_canceled >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL,
  last_operation_id TEXT,
  CHECK (current_done + current_canceled <= current_total)
);
CREATE INDEX idx_milestones_project_order ON milestones(project_id, created_at DESC, id DESC);
CREATE INDEX idx_milestones_project_status_order ON milestones(project_id, status_key, created_at DESC, id DESC);

ALTER TABLE issues ADD COLUMN milestone_id TEXT REFERENCES milestones(id);
CREATE INDEX idx_issues_milestone_list ON issues(project_id, milestone_id, deleted_at, updated_at DESC, number DESC);
CREATE INDEX idx_issues_milestone_candidates ON issues(project_id, milestone_id, status_key, priority_rank, created_at, number) WHERE deleted_at IS NULL;

CREATE TRIGGER issue_milestone_project_insert BEFORE INSERT ON issues
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM milestones WHERE id = NEW.milestone_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'issue milestone must belong to the same project'); END;
CREATE TRIGGER issue_milestone_project_update BEFORE UPDATE OF milestone_id, project_id ON issues
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM milestones WHERE id = NEW.milestone_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'issue milestone must belong to the same project'); END;

-- 当前进度与 Issue 写入处于同一原子单元，普通正文/标题编辑不写统计。
CREATE TRIGGER milestone_progress_insert AFTER INSERT ON issues
WHEN NEW.milestone_id IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  UPDATE milestones SET current_total = current_total + 1,
    current_done = current_done + (NEW.status_key = 'done'),
    current_canceled = current_canceled + (NEW.status_key = 'canceled')
  WHERE id = NEW.milestone_id;
END;
CREATE TRIGGER milestone_progress_update AFTER UPDATE OF milestone_id, status_key, deleted_at ON issues
WHEN (OLD.milestone_id IS NOT NEW.milestone_id OR OLD.status_key IS NOT NEW.status_key
  OR (OLD.deleted_at IS NULL) != (NEW.deleted_at IS NULL))
BEGIN
  UPDATE milestones SET current_total = current_total - 1,
    current_done = current_done - (OLD.status_key = 'done'),
    current_canceled = current_canceled - (OLD.status_key = 'canceled')
  WHERE id = OLD.milestone_id AND OLD.deleted_at IS NULL;
  UPDATE milestones SET current_total = current_total + 1,
    current_done = current_done + (NEW.status_key = 'done'),
    current_canceled = current_canceled + (NEW.status_key = 'canceled')
  WHERE id = NEW.milestone_id AND NEW.deleted_at IS NULL;
END;
CREATE TRIGGER milestone_progress_delete AFTER DELETE ON issues
WHEN OLD.milestone_id IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  UPDATE milestones SET current_total = current_total - 1,
    current_done = current_done - (OLD.status_key = 'done'),
    current_canceled = current_canceled - (OLD.status_key = 'canceled')
  WHERE id = OLD.milestone_id;
END;

UPDATE instance_meta SET schema_version = 28 WHERE schema_version = 27;
