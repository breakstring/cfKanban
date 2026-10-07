CREATE TABLE cloudflare_control_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  zone_id TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  verified_at INTEGER,
  latest_operation_id TEXT,
  locked_operation_id TEXT,
  last_operation_id TEXT
);
INSERT INTO cloudflare_control_settings(singleton) VALUES (1);

-- Cloud writes retain their intent permanently; ordinary idempotency TTL cleanup
-- must never allow an uncertain external write to be sent a second time.
CREATE TABLE cloudflare_control_operations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  route TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('configuration_secret','control_secret','analytics_secret','configuration','rate_limit')),
  status TEXT NOT NULL CHECK (status IN ('pending','verified','failed','unknown')),
  baseline_json TEXT NOT NULL,
  desired_json TEXT NOT NULL,
  secret_value_hash TEXT,
  dispatched_at INTEGER,
  result_version_id TEXT,
  deployment_id TEXT,
  failure_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(principal_id, route, key_hash)
);
CREATE TABLE cloudflare_control_plans (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('configuration','rate_limit')),
  control_version INTEGER NOT NULL,
  baseline_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_operation_id TEXT
);
UPDATE instance_meta SET schema_version = 26 WHERE schema_version = 25;
