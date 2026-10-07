CREATE TABLE usage_history (
  config_key TEXT NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10),
  attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0),
  collected_at INTEGER CHECK (collected_at IS NULL OR collected_at >= 0),
  error TEXT,
  metrics_json TEXT CHECK (metrics_json IS NULL OR (json_valid(metrics_json) AND length(metrics_json) <= 16384)),
  PRIMARY KEY (config_key, day)
);
CREATE INDEX idx_usage_history_day ON usage_history(day);
UPDATE instance_meta SET schema_version = 25 WHERE schema_version = 24;
