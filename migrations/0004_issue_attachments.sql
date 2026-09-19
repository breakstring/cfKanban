CREATE TABLE attachment_storage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)
);
INSERT INTO attachment_storage (singleton, reserved_bytes) VALUES (1, 0);

-- 对象跟踪不依赖 Project 外键，永久删除项目后仍可重复回收晚到的 PUT。
CREATE TABLE attachment_objects (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'garbage')),
  preview_content_type TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  garbage_at INTEGER,
  last_checked_at INTEGER,
  budget_released_at INTEGER,
  CHECK ((state = 'garbage' AND garbage_at IS NOT NULL) OR (state <> 'garbage' AND garbage_at IS NULL))
);
CREATE INDEX idx_attachment_objects_cleanup ON attachment_objects (state, COALESCE(last_checked_at, garbage_at), id);
CREATE INDEX idx_attachment_objects_expiry ON attachment_objects (state, expires_at, id);

CREATE TABLE issue_attachments (
  id TEXT PRIMARY KEY REFERENCES attachment_objects(id),
  issue_id TEXT NOT NULL REFERENCES issues(id),
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 180),
  content_type TEXT NOT NULL,
  uploaded_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by_principal_id TEXT REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);
CREATE INDEX idx_issue_attachments_issue_created ON issue_attachments (issue_id, deleted_at, created_at, id);
