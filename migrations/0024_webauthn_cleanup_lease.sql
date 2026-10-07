CREATE TABLE webauthn_cleanup_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_run_at INTEGER NOT NULL DEFAULT 0 CHECK (next_run_at >= 0)
);
INSERT INTO webauthn_cleanup_state(singleton, next_run_at) VALUES (1, 0);
UPDATE instance_meta SET schema_version = 24 WHERE schema_version = 23;
