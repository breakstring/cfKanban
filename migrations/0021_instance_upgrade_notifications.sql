CREATE TABLE upgrade_notification_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_operation_id TEXT
);
INSERT INTO upgrade_notification_settings(singleton) VALUES (1);

CREATE TABLE upgrade_notification_releases (
  release_version TEXT PRIMARY KEY,
  previous_release_version TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  worker_version_id TEXT NOT NULL,
  notification_id TEXT NOT NULL UNIQUE REFERENCES instance_notifications(id),
  created_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER upgrade_notification_release_immutable BEFORE UPDATE ON upgrade_notification_releases BEGIN
  SELECT RAISE(ABORT, 'upgrade notification release is immutable');
END;
CREATE TRIGGER upgrade_notification_release_retained BEFORE DELETE ON upgrade_notification_releases BEGIN
  SELECT RAISE(ABORT, 'upgrade notification release is retained');
END;

UPDATE instance_meta SET schema_version = 21 WHERE schema_version = 20;
