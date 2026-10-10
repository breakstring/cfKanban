import { toolError } from "./errors.mjs";
import { canonicalDigest, sha256Bytes } from "./utils.mjs";

export const TREND_BACKFILL_SQL_COMPATIBILITY = Object.freeze({
  name: "0030_issue_trend_backfill_maintenance.sql",
  source_sql_sha256: "4a1db214135aeb642784fb08a98752bad7caa920dcf12f9f9bf0fdd6e7fafbb5",
  executed_sql_sha256: "5ea850898a3de9cc0c519d0615d4fd42eb064eaeef616b54eb7ddcd747cb1836",
  transform: "schema30_parenthesized_trigger_case_v1",
});

export function assertInitialSchema30Supported(schemaVersion) {
  if (Number.isSafeInteger(schemaVersion) && schemaVersion > 31) {
    throw toolError("DEPLOYMENT_INITIAL_SCHEMA30_UNSUPPORTED", "Initial migration execution is frozen only through schema 31");
  }
}

export function plannedMigrationSqlCompatibility(migrations) {
  return migrations.some(migration => migration.name === TREND_BACKFILL_SQL_COMPATIBILITY.name
    && migration.sha256 === TREND_BACKFILL_SQL_COMPATIBILITY.source_sql_sha256)
    ? [{ ...TREND_BACKFILL_SQL_COMPATIBILITY }]
    : [];
}

function parenthesizeSchema30Cases(sql) {
  // 仅处理已发行 schema 30 的精确摘要，不对其他 SQL 推断或修复语法。
  // CASE 加括号保持 SQLite 表达式语义，避免远端 splitter 把 CASE END 当作 trigger END。
  const replacements = [
    ["SELECT CASE WHEN", "SELECT (CASE WHEN", 2],
    [" END;", " END);", 2],
    [", CASE WHEN", ", (CASE WHEN", 4],
    ["= CASE WHEN", "= (CASE WHEN", 2],
    [" END )", " END) )", 4],
    [" ELSE stock_from END ,", " ELSE stock_from END) ,", 1],
    [" ELSE flow_from END\n", " ELSE flow_from END)\n", 1],
  ];
  for (const [before, after, count] of replacements) {
    if (sql.split(before).length - 1 !== count) {
      throw toolError("MIGRATION_SQL_COMPATIBILITY_DRIFT", "Fixed migration compatibility replacement does not match its verified source");
    }
    sql = sql.replaceAll(before, after);
  }
  return sql;
}

export function prepareUpgradeMigrationSql({ plan, migration, sourceSql }) {
  const sourceSha256 = sha256Bytes(Buffer.from(sourceSql, "utf8"));
  if (sourceSha256 !== migration.sha256) {
    throw toolError("UPGRADE_MIGRATION_SOURCE_DRIFT", "Migration SQL digest differs from the upgrade plan", { name: migration.name });
  }
  const compatibility = plan.migrations.sql_compatibility;
  // 原计划没有此字段时保留原执行字节；不得在恢复旧 journal 时隐式改变计划。
  if (compatibility !== undefined) {
    const expected = plannedMigrationSqlCompatibility(plan.migrations.ordered);
    if (!Array.isArray(compatibility) || canonicalDigest(compatibility) !== canonicalDigest(expected)) {
      throw toolError("MIGRATION_SQL_COMPATIBILITY_PLAN_MISMATCH", "Migration SQL compatibility must match the fixed source and execution digests in the authorized plan");
    }
  }
  const selected = compatibility?.find(entry => entry.name === migration.name);
  if (selected && sourceSha256 !== selected.source_sql_sha256) {
    throw toolError("MIGRATION_SQL_COMPATIBILITY_PLAN_MISMATCH", "Compatibility applies only to its exact verified migration source", { name: migration.name });
  }
  const sql = selected ? parenthesizeSchema30Cases(sourceSql) : sourceSql;
  const executedSha256 = sha256Bytes(Buffer.from(sql, "utf8"));
  if (selected && executedSha256 !== selected.executed_sql_sha256) {
    throw toolError("MIGRATION_SQL_COMPATIBILITY_DRIFT", "Transformed migration SQL differs from the authorized execution digest", { name: migration.name });
  }
  return {
    sql,
    evidence: {
      source_sql_sha256: sourceSha256,
      executed_sql_sha256: executedSha256,
      compatibility_transform: selected?.transform ?? null,
      source_sql_bytes: Buffer.byteLength(sourceSql, "utf8"),
      sql_bytes: Buffer.byteLength(sql, "utf8"),
    },
  };
}
