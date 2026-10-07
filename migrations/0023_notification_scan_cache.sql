CREATE TABLE notification_pending_windows (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  preference_version INTEGER NOT NULL CHECK (preference_version >= 1),
  receive_after INTEGER NOT NULL,
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  pending_ids_json TEXT NOT NULL CHECK (json_valid(pending_ids_json) AND json_type(pending_ids_json) = 'array' AND json_array_length(pending_ids_json) <= 100),
  version INTEGER NOT NULL CHECK (version >= 1),
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  floor_created_at INTEGER,
  floor_id TEXT,
  CHECK ((is_complete = 1 AND floor_created_at IS NULL AND floor_id IS NULL)
    OR (is_complete = 0 AND floor_created_at IS NOT NULL AND floor_id IS NOT NULL AND json_array_length(pending_ids_json) > 0))
);

UPDATE instance_meta SET schema_version = 23 WHERE schema_version = 22;
