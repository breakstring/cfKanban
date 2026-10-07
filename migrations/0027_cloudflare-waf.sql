-- Extend persisted intents without changing the released schema 26 migration.
CREATE TABLE cloudflare_control_operations_v27 (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  route TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('configuration_secret','control_secret','analytics_secret','configuration','rate_limit','waf')),
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
INSERT INTO cloudflare_control_operations_v27 SELECT * FROM cloudflare_control_operations;
DROP TABLE cloudflare_control_operations;
ALTER TABLE cloudflare_control_operations_v27 RENAME TO cloudflare_control_operations;
CREATE TABLE cloudflare_control_plans_v27 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('configuration','rate_limit','waf')),
  control_version INTEGER NOT NULL,
  baseline_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_operation_id TEXT
);
INSERT INTO cloudflare_control_plans_v27 SELECT * FROM cloudflare_control_plans;
DROP TABLE cloudflare_control_plans;
ALTER TABLE cloudflare_control_plans_v27 RENAME TO cloudflare_control_plans;

CREATE TABLE cloudflare_waf_target_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  binding_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  database_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  origin_version INTEGER NOT NULL CHECK (origin_version >= 1),
  provider_metadata_hash TEXT NOT NULL CHECK (length(provider_metadata_hash) = 64),
  source TEXT NOT NULL CHECK (source IN ('worker_domain_read','deployment_runtime')),
  verified_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL
);
CREATE TABLE cloudflare_waf_ownership (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  binding_id TEXT,
  rule_id TEXT,
  ruleset_id TEXT,
  rule_ref TEXT,
  rule_digest TEXT,
  operation_id TEXT,
  verified_at INTEGER,
  CHECK ((rule_id IS NULL AND ruleset_id IS NULL AND rule_digest IS NULL) OR (rule_id IS NOT NULL AND ruleset_id IS NOT NULL AND length(rule_digest) = 64))
);
INSERT INTO cloudflare_waf_ownership(singleton) VALUES (1);
UPDATE instance_meta SET schema_version = 27 WHERE schema_version = 26;
