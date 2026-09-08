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
UNION ALL
SELECT 'column' AS type, schema.name || '.' || column_info.name AS name
FROM sqlite_master AS schema
JOIN pragma_table_info(schema.name) AS column_info
WHERE schema.type = 'table' AND schema.name NOT LIKE 'sqlite_%'
ORDER BY type, name;
