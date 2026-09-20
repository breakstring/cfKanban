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
WHERE type IN ('table', 'index', 'trigger')
  AND name NOT LIKE 'sqlite_%'
UNION ALL
SELECT 'column' AS type, target.name || '.' || info.name AS name
FROM sqlite_master AS target
JOIN pragma_table_info(target.name) AS info
WHERE target.type = 'table'
  AND target.name IN ('workspaces', 'projects', 'public_join_policies', 'attachment_storage', 'principals')
ORDER BY type, name;

SELECT COUNT(*) AS row_count, MAX(schema_version) AS schema_version
FROM instance_meta;
