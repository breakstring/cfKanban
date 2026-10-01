CREATE INDEX idx_events_history ON events(created_at DESC, sequence DESC);
CREATE INDEX idx_events_stream_history ON events(stream, created_at DESC, sequence DESC);
CREATE INDEX idx_events_project_stream_history ON events(project_id, stream, created_at DESC, sequence DESC);

UPDATE instance_meta SET schema_version = 16 WHERE schema_version = 15;
