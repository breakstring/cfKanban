-- 永久删除保留不可复用的容器 key；数据库约束阻止旧恢复路径复活最小记录。
ALTER TABLE workspaces ADD COLUMN purged_at INTEGER CHECK (purged_at IS NULL OR deleted_at IS NOT NULL);
ALTER TABLE projects ADD COLUMN purged_at INTEGER CHECK (purged_at IS NULL OR deleted_at IS NOT NULL);

CREATE INDEX idx_workspaces_purge_state ON workspaces(purged_at, id);
CREATE INDEX idx_projects_workspace_purge_state ON projects(workspace_id, purged_at, id);

UPDATE instance_meta SET schema_version = 2 WHERE schema_version = 1;
