SELECT
  sequence,
  name,
  sha256,
  classification,
  reentry,
  operation_id,
  applied_at
FROM cfkanban_migration_ledger
ORDER BY sequence;

SELECT
  type,
  name
FROM sqlite_master
WHERE type IN ('table', 'index')
  AND name NOT LIKE 'sqlite_%'
ORDER BY type, name;
