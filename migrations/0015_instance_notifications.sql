CREATE TABLE instance_notifications (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (typeof(title) = 'text' AND length(title) BETWEEN 1 AND 200 AND instr(title, char(0)) = 0),
  body TEXT NOT NULL CHECK (typeof(body) = 'text' AND length(body) BETWEEN 1 AND 4000 AND instr(body, char(0)) = 0),
  created_at INTEGER NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > created_at),
  withdrawn_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_operation_id TEXT NOT NULL,
  last_operation_id TEXT NOT NULL
);
CREATE INDEX idx_notifications_created ON instance_notifications(created_at DESC, id DESC);
CREATE INDEX idx_notifications_pending ON instance_notifications(withdrawn_at, created_at DESC, id DESC);

CREATE TABLE notification_preferences (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  receive_after INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  last_operation_id TEXT NOT NULL
);

CREATE TABLE notification_acknowledgements (
  notification_id TEXT NOT NULL REFERENCES instance_notifications(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  acknowledged_at INTEGER NOT NULL,
  created_operation_id TEXT NOT NULL,
  PRIMARY KEY (notification_id, principal_id)
);
CREATE INDEX idx_notification_acknowledgements_principal ON notification_acknowledgements(principal_id, notification_id);

CREATE TABLE notification_pending_cache (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  preference_version INTEGER NOT NULL CHECK (preference_version >= 1),
  receive_after INTEGER NOT NULL,
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  pending_ids_json TEXT NOT NULL CHECK (json_valid(pending_ids_json) AND json_type(pending_ids_json) = 'array' AND json_array_length(pending_ids_json) <= 50),
  version INTEGER NOT NULL CHECK (version >= 1)
);

CREATE TRIGGER notification_content_immutable BEFORE UPDATE ON instance_notifications
WHEN NEW.sequence IS NOT OLD.sequence OR NEW.id IS NOT OLD.id OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
  OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by_principal_id IS NOT OLD.created_by_principal_id
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_operation_id IS NOT OLD.created_operation_id
  OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NOT OLD.withdrawn_at)
BEGIN SELECT RAISE(ABORT, 'notification content is immutable'); END;
CREATE TRIGGER notification_history_retained BEFORE DELETE ON instance_notifications
BEGIN SELECT RAISE(ABORT, 'notification history is retained'); END;
CREATE TRIGGER notification_acknowledgement_immutable BEFORE UPDATE ON notification_acknowledgements
BEGIN SELECT RAISE(ABORT, 'notification acknowledgement is immutable'); END;
CREATE TRIGGER notification_acknowledgement_retained BEFORE DELETE ON notification_acknowledgements
BEGIN SELECT RAISE(ABORT, 'notification acknowledgement is retained'); END;

UPDATE instance_meta SET schema_version = 15 WHERE schema_version = 14;
