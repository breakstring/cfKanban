CREATE INDEX idx_projects_active_scope ON projects(workspace_id, id) WHERE deleted_at IS NULL;
CREATE INDEX idx_issues_active_assignee ON issues(assignee_principal_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_principals_created ON principals(created_at, id);
CREATE INDEX idx_project_grants_principal_active ON project_grants(principal_id) WHERE revoked_at IS NULL;
UPDATE instance_meta SET schema_version = 10 WHERE schema_version = 9;
