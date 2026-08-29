PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 128),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_operation_id TEXT
);

CREATE TABLE instance_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL UNIQUE,
  owner_principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  service_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  created_at INTEGER NOT NULL
);

CREATE TABLE instance_origin_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  preferred_api_origin TEXT NOT NULL CHECK (
    preferred_api_origin LIKE 'https://%'
    AND instr(substr(preferred_api_origin, 9), '/') = 0
    AND instr(preferred_api_origin, '?') = 0
    AND instr(preferred_api_origin, '#') = 0
    AND instr(preferred_api_origin, '@') = 0
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL,
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  last_operation_id TEXT
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_prefix TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
  issued_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_by_principal_id TEXT REFERENCES principals(id),
  revoke_reason TEXT,
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  CHECK ((revoked_at IS NULL AND revoked_by_principal_id IS NULL) OR revoked_at IS NOT NULL)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (
    length(key) BETWEEN 2 AND 32
    AND substr(key, 1, 1) GLOB '[a-z]'
    AND key NOT GLOB '*[^a-z0-9-]*'
  ),
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
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL CHECK (
    length(key) BETWEEN 2 AND 16
    AND substr(key, 1, 1) GLOB '[A-Z]'
    AND key NOT GLOB '*[^A-Z0-9-]*'
  ),
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
  UNIQUE (workspace_id, key),
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

CREATE TABLE project_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('reader', 'writer')),
  revoked_at INTEGER,
  revoked_by_principal_id TEXT REFERENCES principals(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_operation_id TEXT NOT NULL,
  last_operation_id TEXT,
  UNIQUE (principal_id, project_id),
  CHECK ((revoked_at IS NULL AND revoked_by_principal_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_principal_id IS NOT NULL))
);

CREATE TABLE project_status_names (
  project_id TEXT NOT NULL REFERENCES projects(id),
  status_key TEXT NOT NULL CHECK (status_key IN ('backlog', 'todo', 'in_progress', 'done', 'canceled')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 128),
  updated_at INTEGER NOT NULL,
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  last_operation_id TEXT,
  PRIMARY KEY (project_id, status_key)
);

CREATE TABLE public_join_policies (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
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

CREATE TABLE project_usage (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  active_issue_count INTEGER NOT NULL CHECK (active_issue_count >= 0),
  active_comment_count INTEGER NOT NULL CHECK (active_comment_count >= 0),
  active_principal_count INTEGER NOT NULL CHECK (active_principal_count >= 0),
  updated_at INTEGER NOT NULL,
  last_operation_id TEXT
);

CREATE TABLE issues (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 256),
  title_search TEXT NOT NULL CHECK (length(title_search) BETWEEN 1 AND 256),
  body TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body AS BLOB)) <= 65536),
  status_key TEXT NOT NULL DEFAULT 'backlog' CHECK (status_key IN ('backlog', 'todo', 'in_progress', 'done', 'canceled')),
  priority_key TEXT NOT NULL DEFAULT 'none' CHECK (priority_key IN ('urgent', 'high', 'medium', 'low', 'none')),
  priority_rank INTEGER NOT NULL DEFAULT 4 CHECK (priority_rank BETWEEN 0 AND 4),
  assignee_principal_id TEXT REFERENCES principals(id),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR length(trim(blocked_reason)) BETWEEN 1 AND 4096),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at INTEGER,
  deleted_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  CHECK (
    (priority_key = 'urgent' AND priority_rank = 0)
    OR (priority_key = 'high' AND priority_rank = 1)
    OR (priority_key = 'medium' AND priority_rank = 2)
    OR (priority_key = 'low' AND priority_rank = 3)
    OR (priority_key = 'none' AND priority_rank = 4)
  ),
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT COLLATE NOCASE NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
  color TEXT CHECK (
    color IS NULL
    OR (length(color) = 7 AND substr(color, 1, 1) = '#'
        AND substr(color, 2) NOT GLOB '*[^0-9A-Fa-f]*')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at INTEGER,
  deleted_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  UNIQUE (project_id, name),
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

CREATE TABLE issue_labels (
  issue_id TEXT NOT NULL REFERENCES issues(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  added_at INTEGER NOT NULL,
  added_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL,
  PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE issue_relations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('blocks', 'parent', 'related', 'duplicate')),
  source_issue_id TEXT NOT NULL REFERENCES issues(id),
  target_issue_id TEXT NOT NULL REFERENCES issues(id),
  source_project_id TEXT NOT NULL REFERENCES projects(id),
  target_project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at INTEGER,
  deleted_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  UNIQUE (kind, source_issue_id, target_issue_id),
  CHECK (source_issue_id <> target_issue_id),
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  kind TEXT NOT NULL CHECK (kind IN ('standard', 'completion')),
  author_principal_id TEXT NOT NULL REFERENCES principals(id),
  body TEXT NOT NULL CHECK (
    length(trim(body)) >= 1
    AND length(CAST(body AS BLOB)) <= 32768
  ),
  completion_json TEXT CHECK (
    completion_json IS NULL
    OR (json_valid(completion_json) AND length(CAST(completion_json AS BLOB)) <= 32768)
  ),
  reply_to_comment_id TEXT REFERENCES comments(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at INTEGER,
  deleted_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  CHECK (
    (kind = 'standard' AND completion_json IS NULL)
    OR (kind = 'completion' AND completion_json IS NOT NULL AND reply_to_comment_id IS NULL AND deleted_at IS NULL AND deleted_by_principal_id IS NULL)
  ),
  CHECK ((deleted_at IS NULL AND deleted_by_principal_id IS NULL) OR (deleted_at IS NOT NULL AND deleted_by_principal_id IS NOT NULL))
);

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
        || json_extract(target_json, '$.workspace_key')
        || '/p/' || json_extract(target_json, '$.project_key')
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.project_key') = 'text'
      AND json_type(target_json, '$.workspace_key') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.project_id', '$.project_key', '$.workspace_key') = '{}')
    OR
    (target_kind = 'issue'
      AND json_extract(target_json, '$.kind') = 'issue'
      AND json_extract(target_json, '$.entry_path') = '/app/issues/'
        || json_extract(target_json, '$.identifier')
      AND json_type(target_json, '$.identifier') = 'text'
      AND json_type(target_json, '$.issue_id') = 'text'
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.project_key') = 'text'
      AND json_type(target_json, '$.workspace_key') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.identifier', '$.issue_id', '$.kind', '$.project_id', '$.project_key', '$.workspace_key') = '{}')
  ), 0))
);

CREATE TABLE web_authenticators (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key_cose TEXT NOT NULL,
  algorithm INTEGER NOT NULL CHECK (algorithm IN (-7, -257)),
  user_handle TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0, 1)),
  backup_state INTEGER NOT NULL CHECK (backup_state IN (0, 1)),
  transports_json TEXT CHECK (transports_json IS NULL OR json_valid(transports_json)),
  rp_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_by_principal_id TEXT REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  CHECK (backup_state = 0 OR backup_eligible = 1),
  CHECK ((revoked_at IS NULL AND revoked_by_principal_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_principal_id IS NOT NULL))
);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge_digest TEXT NOT NULL UNIQUE CHECK (length(challenge_digest) = 64),
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  principal_id TEXT REFERENCES principals(id),
  rp_id TEXT NOT NULL,
  expected_origin TEXT NOT NULL CHECK (expected_origin LIKE 'https://%'),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  last_operation_id TEXT,
  CHECK ((purpose = 'registration' AND principal_id IS NOT NULL) OR (purpose = 'authentication' AND principal_id IS NULL)),
  CHECK (expires_at > created_at)
);

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
        || json_extract(target_json, '$.workspace_key')
        || '/p/' || json_extract(target_json, '$.project_key')
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.project_key') = 'text'
      AND json_type(target_json, '$.workspace_key') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.project_id', '$.project_key', '$.workspace_key') = '{}')
    OR
    (target_kind = 'issue'
      AND json_extract(target_json, '$.kind') = 'issue'
      AND json_extract(target_json, '$.entry_path') = '/app/issues/'
        || json_extract(target_json, '$.identifier')
      AND json_type(target_json, '$.identifier') = 'text'
      AND json_type(target_json, '$.issue_id') = 'text'
      AND json_type(target_json, '$.project_id') = 'text'
      AND json_type(target_json, '$.project_key') = 'text'
      AND json_type(target_json, '$.workspace_key') = 'text'
      AND json_remove(target_json, '$.entry_path', '$.identifier', '$.issue_id', '$.kind', '$.project_id', '$.project_key', '$.workspace_key') = '{}')
  ), 0))
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('project_grant', 'principal_recovery')),
  code_prefix TEXT NOT NULL,
  code_digest TEXT NOT NULL UNIQUE CHECK (length(code_digest) = 64),
  bound_principal_id TEXT REFERENCES principals(id),
  recovery_mode TEXT CHECK (recovery_mode IN ('rotation', 'full_recovery')),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_principal_id TEXT REFERENCES principals(id),
  redeemed_at INTEGER,
  redeemed_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  created_by_owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_operation_id TEXT NOT NULL UNIQUE,
  last_operation_id TEXT,
  CHECK (
    (kind = 'project_grant' AND bound_principal_id IS NULL AND recovery_mode IS NULL)
    OR (kind = 'principal_recovery' AND bound_principal_id IS NOT NULL AND recovery_mode IS NOT NULL)
  ),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL AND revoked_by_principal_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_principal_id IS NOT NULL))
);

CREATE TABLE invitation_project_grants (
  invitation_id TEXT NOT NULL REFERENCES invitations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('reader', 'writer')),
  PRIMARY KEY (invitation_id, project_id)
);

CREATE TABLE invitation_redemption_items (
  invitation_id TEXT NOT NULL REFERENCES invitations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  operation_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'regranted', 'already_has_access')),
  effective_role TEXT NOT NULL CHECK (effective_role IN ('reader', 'writer')),
  PRIMARY KEY (invitation_id, project_id)
);

CREATE TABLE operation_commits (
  operation_id TEXT PRIMARY KEY,
  primary_subject_type TEXT NOT NULL,
  primary_subject_id TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  committed_at INTEGER NOT NULL
);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  stream TEXT NOT NULL CHECK (stream IN ('domain', 'security')),
  type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_index INTEGER NOT NULL CHECK (event_index >= 0),
  actor_principal_id TEXT REFERENCES principals(id),
  actor_credential_id TEXT REFERENCES credentials(id),
  authorized_via TEXT NOT NULL CHECK (authorized_via IN ('deployment_owner', 'project_grant', 'public_join', 'invitation', 'browser_launch', 'web_session', 'webauthn', 'deployment_recovery')),
  grant_id TEXT REFERENCES project_grants(id),
  workspace_id TEXT REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),
  relation_other_project_id TEXT REFERENCES projects(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (operation_id, event_index),
  CHECK ((stream = 'domain' AND project_id IS NOT NULL) OR stream = 'security'),
  CHECK (
    (subject_type = 'relation' AND relation_other_project_id IS NOT NULL)
    OR (subject_type <> 'relation' AND relation_other_project_id IS NULL)
  )
);

CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  method TEXT NOT NULL,
  route_template TEXT NOT NULL,
  resource_scope_hash TEXT NOT NULL CHECK (length(resource_scope_hash) = 64),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  operation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
  operation_snapshot_json TEXT CHECK (operation_snapshot_json IS NULL OR json_valid(operation_snapshot_json)),
  response_status INTEGER,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (scope_key, method, route_template, resource_scope_hash, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'pending' AND response_status IS NULL AND response_json IS NULL)
    OR (state = 'committed' AND operation_snapshot_json IS NULL
        AND response_status IS NOT NULL AND response_json IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_credentials_token_digest ON credentials(token_digest);
CREATE INDEX idx_credentials_principal_active ON credentials(principal_id, revoked_at);
CREATE UNIQUE INDEX idx_browser_launches_code_digest ON browser_launches(code_digest);
CREATE INDEX idx_browser_launches_expiry ON browser_launches(expires_at, redeemed_at, revoked_at);
CREATE INDEX idx_browser_launches_cleanup ON browser_launches(created_at, id);
CREATE UNIQUE INDEX idx_web_sessions_token_digest ON web_sessions(token_digest);
CREATE INDEX idx_web_sessions_principal_active ON web_sessions(principal_id, revoked_at, expires_at);
CREATE INDEX idx_web_sessions_source_active ON web_sessions(source_kind, source_id, revoked_at);
CREATE INDEX idx_web_sessions_cleanup ON web_sessions(created_at, id);
CREATE UNIQUE INDEX idx_workspaces_key ON workspaces(key);
CREATE UNIQUE INDEX idx_projects_workspace_key ON projects(workspace_id, key);
CREATE INDEX idx_projects_list ON projects(workspace_id, deleted_at, display_name, id);
CREATE UNIQUE INDEX idx_project_grants_principal_project ON project_grants(principal_id, project_id);
CREATE INDEX idx_project_grants_project_active ON project_grants(project_id, revoked_at, role, principal_id);
CREATE INDEX idx_issues_project_list ON issues(project_id, deleted_at, updated_at DESC, number DESC);
CREATE INDEX idx_issues_candidates ON issues(project_id, status_key, deleted_at, priority_rank, created_at, number);
CREATE INDEX idx_issues_assignee ON issues(project_id, assignee_principal_id, deleted_at, status_key, updated_at DESC);
CREATE UNIQUE INDEX idx_labels_project_name ON labels(project_id, name COLLATE NOCASE);
CREATE INDEX idx_labels_project_tombstones ON labels(project_id, deleted_at DESC, id DESC);
CREATE INDEX idx_issue_labels_label_issue ON issue_labels(label_id, issue_id);
CREATE INDEX idx_comments_issue_list ON comments(issue_id, deleted_at, created_at, id);
CREATE INDEX idx_comments_issue_tombstones ON comments(issue_id, deleted_at DESC, id DESC);
CREATE INDEX idx_issue_relations_source ON issue_relations(source_issue_id, deleted_at, kind);
CREATE INDEX idx_issue_relations_target ON issue_relations(target_issue_id, deleted_at, kind);
CREATE INDEX idx_issue_relations_source_tombstones ON issue_relations(source_issue_id, deleted_at DESC, id DESC);
CREATE INDEX idx_issue_relations_target_tombstones ON issue_relations(target_issue_id, deleted_at DESC, id DESC);
CREATE INDEX idx_issue_relations_source_tombstones_visible ON issue_relations(source_issue_id, target_project_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_issue_relations_target_tombstones_visible ON issue_relations(target_issue_id, source_project_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL;
CREATE UNIQUE INDEX idx_invitations_code_digest ON invitations(code_digest);
CREATE INDEX idx_invitations_owner_list ON invitations(created_at DESC, id);
CREATE INDEX idx_events_project_stream_sequence ON events(project_id, stream, sequence);
CREATE INDEX idx_events_project_nonrelation_sequence ON events(project_id, stream, sequence) WHERE relation_other_project_id IS NULL;
CREATE INDEX idx_events_project_relation_sequence ON events(project_id, stream, sequence, relation_other_project_id) WHERE relation_other_project_id IS NOT NULL;
CREATE INDEX idx_events_stream_sequence ON events(stream, sequence);
CREATE INDEX idx_idempotency_expiry ON idempotency_records(expires_at, id);
CREATE INDEX idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at, id);
CREATE INDEX idx_webauthn_challenges_consumed ON webauthn_challenges(consumed_at, id) WHERE consumed_at IS NOT NULL;
CREATE INDEX idx_web_authenticators_principal_active ON web_authenticators(principal_id, revoked_at, created_at, id);
CREATE INDEX idx_public_join_enabled ON public_join_policies(disabled_at, public_id);
