-- 移除容器 key，保留 UUID、业务内容和权限；旧 API/缓存不提供兼容。

PRAGMA defer_foreign_keys = ON;

-- 存量部署 ledger 需重建 CHECK；独立 schema 初始化也允许尚未创建 ledger。
CREATE TABLE IF NOT EXISTS cfkanban_migration_ledger (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  classification TEXT NOT NULL CHECK (classification IN ('bootstrap', 'backward_compatible', 'breaking_non_destructive', 'destructive')),
  reentry TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
) STRICT;

CREATE TABLE cfkanban_migration_ledger_uuid (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  classification TEXT NOT NULL CHECK (classification IN ('bootstrap', 'backward_compatible', 'breaking_non_destructive', 'destructive')),
  reentry TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
) STRICT;

INSERT INTO cfkanban_migration_ledger_uuid (sequence, name, sha256, classification, reentry, operation_id, applied_at)
SELECT sequence, name, sha256, classification, reentry, operation_id, applied_at FROM cfkanban_migration_ledger;

DROP TABLE cfkanban_migration_ledger;

ALTER TABLE cfkanban_migration_ledger_uuid RENAME TO cfkanban_migration_ledger;


CREATE TABLE workspaces_uuid AS SELECT id, CASE WHEN purged_at IS NOT NULL THEN '[deleted]' ELSE display_name END AS display_name, version, deleted_at, deleted_by_principal_id, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id, purged_at FROM workspaces;

CREATE TABLE projects_uuid AS SELECT id, workspace_id, CASE WHEN purged_at IS NOT NULL THEN '[deleted]' ELSE display_name END AS display_name, context, issue_limit, comment_limit, principal_limit, version, deleted_at, deleted_by_principal_id, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id, purged_at FROM projects;

CREATE TABLE public_join_policies_uuid AS SELECT project_id, workspace_id, public_id, public_summary, enabled_at, enabled_by_principal_id, disabled_at, disabled_by_principal_id, version, created_at, updated_at, last_operation_id FROM public_join_policies;

CREATE TABLE browser_launches_uuid AS SELECT id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, CASE WHEN target_kind IN ('project', 'issue') THEN json_set(
      json_remove(target_json, '$.workspace_key', '$.project_key'),
      '$.workspace_id', (SELECT workspace_id FROM projects WHERE id=json_extract(browser_launches.target_json, '$.project_id')),
      '$.entry_path', CASE WHEN target_kind='project' THEN '/app/w/'
        || (SELECT workspace_id FROM projects WHERE id=json_extract(browser_launches.target_json, '$.project_id'))
        || '/p/' || json_extract(target_json, '$.project_id')
        ELSE json_extract(target_json, '$.entry_path') END
    ) ELSE target_json END AS target_json, expires_at, redeemed_at, revoked_at, created_at, created_operation_id, last_operation_id FROM browser_launches;

CREATE TABLE web_sessions_uuid AS SELECT id, token_digest, principal_id, source_kind, source_id, target_kind, CASE WHEN target_kind IN ('project', 'issue') THEN json_set(
      json_remove(target_json, '$.workspace_key', '$.project_key'),
      '$.workspace_id', (SELECT workspace_id FROM projects WHERE id=json_extract(web_sessions.target_json, '$.project_id')),
      '$.entry_path', CASE WHEN target_kind='project' THEN '/app/w/'
        || (SELECT workspace_id FROM projects WHERE id=json_extract(web_sessions.target_json, '$.project_id'))
        || '/p/' || json_extract(target_json, '$.project_id')
        ELSE json_extract(target_json, '$.entry_path') END
    ) ELSE target_json END AS target_json, expires_at, revoked_at, created_at, last_seen_at, created_operation_id, last_operation_id FROM web_sessions;

DROP TABLE web_sessions;

DROP TABLE browser_launches;

DROP TABLE public_join_policies;

DROP TABLE projects;

DROP TABLE workspaces;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 128),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at INTEGER,
  deleted_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  purged_at INTEGER CHECK (purged_at IS NULL OR deleted_at IS NOT NULL),
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

INSERT INTO workspaces (id, display_name, version, deleted_at, deleted_by_principal_id, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id, purged_at) SELECT id, display_name, version, deleted_at, deleted_by_principal_id, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id, purged_at FROM workspaces_uuid;

DROP TABLE workspaces_uuid;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 128),
  context TEXT CHECK (context IS NULL OR length(CAST(context AS BLOB)) <= 32768),
  issue_limit INTEGER CHECK (issue_limit IS NULL OR issue_limit > 0),
  comment_limit INTEGER CHECK (comment_limit IS NULL OR comment_limit > 0),
  principal_limit INTEGER CHECK (principal_limit IS NULL OR principal_limit > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at INTEGER,
  deleted_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  purged_at INTEGER CHECK (purged_at IS NULL OR deleted_at IS NOT NULL),
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

INSERT INTO projects (id, workspace_id, display_name, context, issue_limit, comment_limit, principal_limit, version, deleted_at, deleted_by_principal_id, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id, purged_at) SELECT id, workspace_id, display_name, context, issue_limit, comment_limit, principal_limit, version, deleted_at, deleted_by_principal_id, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id, purged_at FROM projects_uuid;

DROP TABLE projects_uuid;

CREATE TABLE public_join_policies (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  public_id TEXT NOT NULL UNIQUE,
  public_summary TEXT NOT NULL CHECK (length(trim(public_summary)) BETWEEN 1 AND 512),
  enabled_at INTEGER,
  enabled_by_principal_id TEXT REFERENCES principals(id),
  disabled_at INTEGER,
  disabled_by_principal_id TEXT REFERENCES principals(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_operation_id TEXT,
  CHECK (
    (enabled_at IS NOT NULL AND enabled_by_principal_id IS NOT NULL AND disabled_at IS NULL AND disabled_by_principal_id IS NULL)
    OR
    (disabled_at IS NOT NULL AND disabled_by_principal_id IS NOT NULL)
  )
);

INSERT INTO public_join_policies (project_id, workspace_id, public_id, public_summary, enabled_at, enabled_by_principal_id, disabled_at, disabled_by_principal_id, version, created_at, updated_at, last_operation_id) SELECT project_id, workspace_id, public_id, public_summary, enabled_at, enabled_by_principal_id, disabled_at, disabled_by_principal_id, version, created_at, updated_at, last_operation_id FROM public_join_policies_uuid;

DROP TABLE public_join_policies_uuid;

CREATE TABLE browser_launches (
  id TEXT PRIMARY KEY,
  code_prefix TEXT NOT NULL,
  code_digest TEXT NOT NULL UNIQUE CHECK (length(code_digest) = 64),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  source_credential_id TEXT NOT NULL REFERENCES credentials(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'issue', 'admin')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  CHECK (expires_at > created_at),
  CHECK (redeemed_at IS NULL OR revoked_at IS NULL),
  CHECK (COALESCE((
    (target_kind = 'admin'
      AND json_extract(target_json, '$.kind') = 'admin'
      AND json_extract(target_json, '$.entry_path') = '/app/admin'
      AND json_extract(target_json, '$.section') IN ('overview', 'workspaces-projects', 'access', 'audit')
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.section') = '{}')
    OR
    (target_kind = 'project'
      AND json_extract(target_json, '$.kind') = 'project'
      AND json_extract(target_json, '$.entry_path') = '/app/w/'
        || json_extract(target_json, '$.workspace_id')
        || '/p/' || json_extract(target_json, '$.project_id')
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.workspace_id') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.project_id', '$.workspace_id') = '{}')
    OR
    (target_kind = 'issue'
      AND json_extract(target_json, '$.kind') = 'issue'
      AND json_extract(target_json, '$.entry_path') = '/app/issues/'
        || json_extract(target_json, '$.identifier')
      AND json_type(target_json, '$.identifier') = 'text'
      AND json_type(target_json, '$.issue_id') = 'text'
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.workspace_id') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.identifier', '$.issue_id', '$.kind', '$.project_id', '$.workspace_id') = '{}')
  ), 0))
);

INSERT INTO browser_launches (id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, target_json, expires_at, redeemed_at, revoked_at, created_at, created_operation_id, last_operation_id) SELECT id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, target_json, expires_at, redeemed_at, revoked_at, created_at, created_operation_id, last_operation_id FROM browser_launches_uuid;

DROP TABLE browser_launches_uuid;

CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('credential', 'web_authenticator')),
  source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project', 'issue', 'admin', 'project_selection')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  created_operation_id TEXT UNIQUE,
  last_operation_id TEXT,
  CHECK (expires_at > created_at),
  CHECK (COALESCE((
    (target_kind = 'admin'
      AND json_extract(target_json, '$.kind') = 'admin'
      AND json_extract(target_json, '$.entry_path') = '/app/admin'
      AND json_extract(target_json, '$.section') IN ('overview', 'workspaces-projects', 'access', 'audit')
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.section') = '{}')
    OR
    (target_kind = 'project_selection'
      AND json_extract(target_json, '$.kind') = 'project_selection'
      AND json_extract(target_json, '$.entry_path') = '/app'
      AND json_remove(target_json, '$.entry_path', '$.kind') = '{}')
    OR
    (target_kind = 'project'
      AND json_extract(target_json, '$.kind') = 'project'
      AND json_extract(target_json, '$.entry_path') = '/app/w/'
        || json_extract(target_json, '$.workspace_id')
        || '/p/' || json_extract(target_json, '$.project_id')
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.workspace_id') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.project_id', '$.workspace_id') = '{}')
    OR
    (target_kind = 'issue'
      AND json_extract(target_json, '$.kind') = 'issue'
      AND json_extract(target_json, '$.entry_path') = '/app/issues/'
        || json_extract(target_json, '$.identifier')
      AND json_type(target_json, '$.identifier') = 'text'
      AND json_type(target_json, '$.issue_id') = 'text'
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.workspace_id') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.identifier', '$.issue_id', '$.kind', '$.project_id', '$.workspace_id') = '{}')
  ), 0))
);

INSERT INTO web_sessions (id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, revoked_at, created_at, last_seen_at, created_operation_id, last_operation_id) SELECT id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, revoked_at, created_at, last_seen_at, created_operation_id, last_operation_id FROM web_sessions_uuid;

DROP TABLE web_sessions_uuid;

CREATE UNIQUE INDEX idx_browser_launches_code_digest ON browser_launches(code_digest);

CREATE INDEX idx_browser_launches_expiry ON browser_launches(expires_at, redeemed_at, revoked_at);

CREATE INDEX idx_browser_launches_cleanup ON browser_launches(created_at, id);

CREATE UNIQUE INDEX idx_web_sessions_token_digest ON web_sessions(token_digest);

CREATE INDEX idx_web_sessions_principal_active ON web_sessions(principal_id, revoked_at, expires_at);

CREATE INDEX idx_web_sessions_source_active ON web_sessions(source_kind, source_id, revoked_at);

CREATE INDEX idx_web_sessions_cleanup ON web_sessions(created_at, id);

CREATE INDEX idx_workspaces_tombstones ON workspaces(deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_projects_list ON projects(workspace_id, deleted_at, display_name, id);

CREATE INDEX idx_projects_workspace_tombstones ON projects(workspace_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_public_join_enabled ON public_join_policies(disabled_at, public_id);

CREATE INDEX idx_public_join_resume_enabled_workspace_project ON public_join_policies(workspace_id, project_id) WHERE enabled_at IS NOT NULL AND disabled_at IS NULL;

CREATE INDEX idx_workspaces_purge_state ON workspaces(purged_at, id);

CREATE INDEX idx_projects_workspace_purge_state ON projects(workspace_id, purged_at, id);

-- 旧响应快照不再符合 UUID 合同，业务事件及内容保留。

DELETE FROM idempotency_records;

DELETE FROM operation_commits;

UPDATE instance_meta SET schema_version = 3 WHERE schema_version = 2;
