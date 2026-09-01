CREATE TABLE IF NOT EXISTS cfkanban_migration_ledger (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  classification TEXT NOT NULL CHECK (classification IN ('bootstrap', 'backward_compatible', 'destructive')),
  reentry TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
) STRICT;
