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
SELECT 'column' AS type, 'workspaces.' || name AS name FROM pragma_table_info('workspaces')
UNION ALL
SELECT 'column' AS type, 'projects.' || name AS name FROM pragma_table_info('projects')
UNION ALL
SELECT 'column' AS type, 'public_join_policies.' || name AS name FROM pragma_table_info('public_join_policies')
UNION ALL
SELECT 'column' AS type, 'attachment_storage.' || name AS name FROM pragma_table_info('attachment_storage')
UNION ALL
SELECT 'column' AS type, 'principals.' || name AS name FROM pragma_table_info('principals')
ORDER BY type, name;

SELECT COUNT(*) AS row_count, MAX(schema_version) AS schema_version
FROM instance_meta;
