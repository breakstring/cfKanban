ALTER TABLE web_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
CREATE INDEX idx_web_sessions_expiry_cleanup ON web_sessions(expires_at, id);
UPDATE instance_meta SET schema_version = 17 WHERE schema_version = 16;
