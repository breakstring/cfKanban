CREATE TABLE search_index_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch TEXT NOT NULL,
  projection_version INTEGER NOT NULL CHECK (projection_version = 1)
);

INSERT INTO search_index_meta VALUES (1, lower(hex(randomblob(16))), 1);

CREATE TABLE search_index_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  retained_after INTEGER NOT NULL DEFAULT 0 CHECK (retained_after >= 0)
);

CREATE TABLE search_index_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  is_removed INTEGER NOT NULL DEFAULT 0 CHECK (is_removed IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

CREATE INDEX idx_search_index_documents_project_number ON search_index_documents(project_id, number) WHERE is_removed = 0;

CREATE TABLE search_index_changes (
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  project_revision INTEGER NOT NULL CHECK (project_revision > 0),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  kind TEXT NOT NULL CHECK (kind IN ('upsert', 'remove')),
  id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (project_id, event_sequence)
);

CREATE INDEX idx_search_index_changes_issue_sequence ON search_index_changes(project_id, number, event_sequence);
CREATE INDEX idx_search_index_changes_retention ON search_index_changes(project_id, project_revision);

INSERT INTO search_index_projects(project_id) SELECT id FROM projects;
INSERT INTO search_index_documents(id, project_id, number, title, is_removed, revision)
SELECT id, project_id, number, CASE WHEN deleted_at IS NULL THEN title ELSE '' END,
  CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END, 0 FROM issues;

CREATE TRIGGER search_index_project_created AFTER INSERT ON projects BEGIN
  INSERT INTO search_index_projects(project_id) VALUES (NEW.id);
END;

-- 由已有原子业务操作内的 Event 驱动；正文、评论及标题未实际改变均不写搜索投影。
CREATE TRIGGER search_index_issue_event AFTER INSERT ON events
WHEN NEW.stream = 'domain' AND NEW.subject_type = 'issue'
  AND NEW.type IN ('issue.created', 'issue.updated', 'issue.deleted', 'issue.restored')
  AND (NEW.type <> 'issue.updated' OR json_extract(NEW.payload_json, '$.title_changed') = 1)
  AND EXISTS (
    SELECT 1 FROM issues issue
    LEFT JOIN search_index_documents document ON document.id = issue.id
    WHERE issue.id = NEW.subject_id AND issue.project_id = NEW.project_id
      AND issue.last_operation_id = NEW.operation_id
      AND ((issue.deleted_at IS NULL AND (document.id IS NULL OR document.is_removed = 1 OR document.title <> issue.title))
        OR (issue.deleted_at IS NOT NULL AND document.id IS NOT NULL AND document.is_removed = 0))
  )
BEGIN
  UPDATE search_index_projects SET revision = revision + 1, event_sequence = NEW.sequence,
    retained_after = max(0, revision + 1 - 10000) WHERE project_id = NEW.project_id;

  INSERT INTO search_index_changes(project_id, revision, project_revision, event_sequence, kind, id, number, title)
  SELECT issue.project_id, COALESCE(document.revision, 0) + 1, state.revision, NEW.sequence,
    CASE WHEN issue.deleted_at IS NULL THEN 'upsert' ELSE 'remove' END,
    issue.id, issue.number, CASE WHEN issue.deleted_at IS NULL THEN issue.title ELSE '' END
  FROM issues issue JOIN search_index_projects state ON state.project_id = issue.project_id
  LEFT JOIN search_index_documents document ON document.id = issue.id
  WHERE issue.id = NEW.subject_id;

  INSERT INTO search_index_documents(id, project_id, number, title, is_removed, revision)
  SELECT issue.id, issue.project_id, issue.number,
    CASE WHEN issue.deleted_at IS NULL THEN issue.title ELSE '' END,
    CASE WHEN issue.deleted_at IS NULL THEN 0 ELSE 1 END,
    COALESCE(document.revision, 0) + 1
  FROM issues issue LEFT JOIN search_index_documents document ON document.id = issue.id
  WHERE issue.id = NEW.subject_id
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, is_removed = excluded.is_removed,
    revision = excluded.revision;

  DELETE FROM search_index_changes WHERE project_id = NEW.project_id
    AND project_revision <= (SELECT retained_after FROM search_index_projects WHERE project_id = NEW.project_id);
END;

-- 容器 purge 保留容器占位记录；物理删除 Issue 时同步清除其搜索元数据。
CREATE TRIGGER search_index_issue_purged AFTER DELETE ON issues BEGIN
  -- 删除日志后，尚未消费 remove 的游标必须重建，不能把缺失变更当作空页跳过。
  UPDATE search_index_projects SET retained_after = revision
    WHERE project_id = OLD.project_id AND retained_after < revision;
  DELETE FROM search_index_documents WHERE id = OLD.id;
  DELETE FROM search_index_changes WHERE project_id = OLD.project_id AND number = OLD.number;
END;

UPDATE instance_meta SET schema_version = 20 WHERE schema_version = 19;
