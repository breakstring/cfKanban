CREATE INDEX idx_issues_active_status_order ON issues(project_id, status_key, updated_at DESC, number DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_issues_active_assignee_order ON issues(project_id, assignee_principal_id, updated_at DESC, number DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_issues_active_priority_order ON issues(project_id, priority_key, updated_at DESC, number DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_issues_todo_assignee_order ON issues(project_id, assignee_principal_id, priority_rank, created_at, number) WHERE deleted_at IS NULL AND status_key = 'todo';
UPDATE instance_meta SET schema_version = 13 WHERE schema_version = 12;
