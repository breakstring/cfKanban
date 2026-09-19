CREATE TABLE usage_statistics (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  attempted_at INTEGER,
  collected_at INTEGER,
  error TEXT,
  metrics_json TEXT CHECK (metrics_json IS NULL OR (json_valid(metrics_json) AND length(metrics_json) <= 8192)),
  config_key TEXT
);
INSERT INTO usage_statistics(singleton) VALUES (1);
UPDATE instance_meta SET schema_version = 6 WHERE schema_version = 5;
