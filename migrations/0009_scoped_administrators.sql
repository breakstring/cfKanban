CREATE TABLE scoped_administrator_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  generation TEXT NOT NULL,
  revoked_at INTEGER,
  revoked_by_principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_operation_id TEXT NOT NULL,
  last_operation_id TEXT,
  CHECK ((revoked_at IS NULL AND revoked_by_principal_id IS NULL) OR revoked_at IS NOT NULL)
);
CREATE UNIQUE INDEX idx_scoped_admin_workspace_principal ON scoped_administrator_grants(workspace_id, principal_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_scoped_admin_project_principal ON scoped_administrator_grants(project_id, principal_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_scoped_admin_principal_active ON scoped_administrator_grants(principal_id, revoked_at, workspace_id, project_id);

CREATE VIEW project_access_sources AS
SELECT g.principal_id, g.project_id, p.workspace_id, g.role,
       'project_grant' AS source, g.id AS source_id, g.version AS source_version,
       NULL AS source_generation, g.id AS direct_grant_id, 1 AS precedence
FROM project_grants g JOIN projects p ON p.id = g.project_id
WHERE g.revoked_at IS NULL
UNION ALL
SELECT a.principal_id, p.id, p.workspace_id, 'writer',
       CASE WHEN a.project_id IS NULL THEN 'workspace_admin' ELSE 'project_admin' END,
       a.id, a.version, a.generation, NULL,
       CASE WHEN a.project_id IS NULL THEN 3 ELSE 2 END
FROM scoped_administrator_grants a JOIN projects p
  ON p.workspace_id = a.workspace_id AND (a.project_id IS NULL OR a.project_id = p.id)
WHERE a.revoked_at IS NULL;

CREATE VIEW effective_project_grants AS
SELECT principal_id, project_id, workspace_id, role, source, source_id,
       source_version AS version, source_generation, direct_grant_id AS id,
       NULL AS revoked_at
FROM (
  SELECT s.*, ROW_NUMBER() OVER (
    PARTITION BY principal_id, project_id
    ORDER BY (role = 'writer') DESC, precedence DESC, source_id
  ) AS source_rank FROM project_access_sources s
) WHERE source_rank = 1;

ALTER TABLE invitations ADD COLUMN issuer_administrator_id TEXT REFERENCES scoped_administrator_grants(id);
ALTER TABLE invitations ADD COLUMN issuer_administrator_generation TEXT;

UPDATE project_usage SET active_principal_count = (
  SELECT COUNT(*) FROM effective_project_grants g
  JOIN instance_meta i ON i.singleton = 1
  WHERE g.project_id = project_usage.project_id AND g.principal_id <> i.owner_principal_id
);

CREATE TABLE scoped_event_sequence (value INTEGER NOT NULL);
INSERT INTO scoped_event_sequence SELECT seq FROM sqlite_sequence WHERE name = 'events';
CREATE TABLE events_scoped (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  stream TEXT NOT NULL CHECK (stream IN ('domain', 'security')),
  type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_index INTEGER NOT NULL CHECK (event_index >= 0),
  actor_principal_id TEXT REFERENCES principals(id),
  actor_credential_id TEXT REFERENCES credentials(id),
  authorized_via TEXT NOT NULL CHECK (authorized_via IN ('deployment_owner', 'project_grant', 'public_join', 'invitation', 'browser_launch', 'web_session', 'webauthn', 'deployment_recovery', 'workspace_admin', 'project_admin')),
  grant_id TEXT REFERENCES project_grants(id),
  administrator_grant_id TEXT REFERENCES scoped_administrator_grants(id),
  administrator_grant_version INTEGER,
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
INSERT INTO events_scoped (sequence, id, stream, type, operation_id, event_index, actor_principal_id, actor_credential_id, authorized_via, grant_id, workspace_id, project_id, relation_other_project_id, subject_type, subject_id, payload_json, created_at) SELECT sequence, id, stream, type, operation_id, event_index, actor_principal_id, actor_credential_id, authorized_via, grant_id, workspace_id, project_id, relation_other_project_id, subject_type, subject_id, payload_json, created_at FROM events;
DROP TABLE events;
ALTER TABLE events_scoped RENAME TO events;
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT MAX(value) FROM scoped_event_sequence), 0)) WHERE name = 'events';
DROP TABLE scoped_event_sequence;
CREATE INDEX idx_events_project_stream_sequence ON events(project_id, stream, sequence);
CREATE INDEX idx_events_project_nonrelation_sequence ON events(project_id, stream, sequence) WHERE relation_other_project_id IS NULL;
CREATE INDEX idx_events_project_relation_sequence ON events(project_id, stream, sequence, relation_other_project_id) WHERE relation_other_project_id IS NOT NULL;
CREATE INDEX idx_events_stream_sequence ON events(stream, sequence);

CREATE TABLE browser_launches_scoped (
  id TEXT PRIMARY KEY,
  code_prefix TEXT NOT NULL,
  code_digest TEXT NOT NULL UNIQUE CHECK (length(code_digest) = 64),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  source_credential_id TEXT NOT NULL REFERENCES credentials(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('workspace', 'project', 'issue', 'admin')),
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
    (target_kind = 'workspace'
      AND json_extract(target_json, '$.kind') = 'workspace'
      AND json_type(target_json, '$.workspace_id') = 'text'
      AND json_extract(target_json, '$.entry_path') = '/app/manage?workspace=' || json_extract(target_json, '$.workspace_id')
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.workspace_id') = '{}')
    OR
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
INSERT INTO browser_launches_scoped (id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, target_json, expires_at, redeemed_at, revoked_at, created_at, created_operation_id, last_operation_id) SELECT id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, target_json, expires_at, redeemed_at, revoked_at, created_at, created_operation_id, last_operation_id FROM browser_launches;
DROP TABLE browser_launches;
ALTER TABLE browser_launches_scoped RENAME TO browser_launches;
CREATE UNIQUE INDEX idx_browser_launches_code_digest ON browser_launches(code_digest);
CREATE INDEX idx_browser_launches_expiry ON browser_launches(expires_at, redeemed_at, revoked_at);
CREATE INDEX idx_browser_launches_cleanup ON browser_launches(created_at, id);

CREATE TABLE web_sessions_scoped (
  id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('credential', 'web_authenticator')),
  source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('workspace', 'project', 'issue', 'admin', 'project_selection')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  created_operation_id TEXT UNIQUE,
  last_operation_id TEXT,
  CHECK (expires_at > created_at),
  CHECK (COALESCE((
    (target_kind = 'workspace'
      AND json_extract(target_json, '$.kind') = 'workspace'
      AND json_type(target_json, '$.workspace_id') = 'text'
      AND json_extract(target_json, '$.entry_path') = '/app/manage?workspace=' || json_extract(target_json, '$.workspace_id')
      AND json_remove(target_json, '$.entry_path', '$.kind', '$.workspace_id') = '{}')
    OR
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
INSERT INTO web_sessions_scoped (id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, revoked_at, created_at, last_seen_at, created_operation_id, last_operation_id) SELECT id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, revoked_at, created_at, last_seen_at, created_operation_id, last_operation_id FROM web_sessions;
DROP TABLE web_sessions;
ALTER TABLE web_sessions_scoped RENAME TO web_sessions;
CREATE UNIQUE INDEX idx_web_sessions_token_digest ON web_sessions(token_digest);
CREATE INDEX idx_web_sessions_principal_active ON web_sessions(principal_id, revoked_at, expires_at);
CREATE INDEX idx_web_sessions_source_active ON web_sessions(source_kind, source_id, revoked_at);
CREATE INDEX idx_web_sessions_cleanup ON web_sessions(created_at, id);

CREATE TRIGGER scoped_admin_event_source AFTER INSERT ON events
WHEN NEW.authorized_via IN ('project_grant', 'web_session') AND NEW.project_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM effective_project_grants g WHERE g.project_id = NEW.project_id
    AND g.principal_id = NEW.actor_principal_id AND g.source IN ('workspace_admin', 'project_admin'))
BEGIN
  UPDATE events SET authorized_via = (SELECT source FROM effective_project_grants WHERE project_id = NEW.project_id AND principal_id = NEW.actor_principal_id),
    administrator_grant_id = (SELECT source_id FROM effective_project_grants WHERE project_id = NEW.project_id AND principal_id = NEW.actor_principal_id),
    administrator_grant_version = (SELECT version FROM effective_project_grants WHERE project_id = NEW.project_id AND principal_id = NEW.actor_principal_id),
    grant_id = NULL
  WHERE sequence = NEW.sequence;
END;
UPDATE instance_meta SET schema_version = MAX(schema_version, 9);
