import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { executeWranglerAction } from "../../packages/skill-runtime/src/deploy.mjs";
import { createJournal, authorizeJournal, appendJournalEvent, assertJournalAuthorization } from "../../packages/skill-runtime/src/journal.mjs";
import { canonicalDigest, sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";
const oldSql = "SELECT\n  sequence,\n  name,\n  sha256,\n  classification,\n  reentry,\n  operation_id,\n  applied_at\nFROM cfkanban_migration_ledger\nORDER BY sequence;\n\nSELECT\n  type,\n  name\nFROM sqlite_master\nWHERE type IN ('table', 'index')\n  AND name NOT LIKE 'sqlite_%'\nUNION ALL\nSELECT 'column' AS type, 'workspaces.' || name AS name FROM pragma_table_info('workspaces')\nUNION ALL\nSELECT 'column' AS type, 'projects.' || name AS name FROM pragma_table_info('projects')\nUNION ALL\nSELECT 'column' AS type, 'public_join_policies.' || name AS name FROM pragma_table_info('public_join_policies')\nORDER BY type, name;\n\nSELECT COUNT(*) AS row_count, MAX(schema_version) AS schema_version\nFROM instance_meta;\n";
async function fixture(t, sql = oldSql, version = "0.1.0-alpha.57", artifactSha = "20b5002cde2b8e8df6986d05f72600b5657f2965c406aa126f851b3d9d985d9e") {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "cfkanban-readback-compat-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const instanceId = "11111111-1111-4111-8111-111111111111", operationId = "22222222-2222-4222-8222-222222222222", taskId = "compat-test";
  const plan = { kind: "deployed_instance_upgrade", task_id: taskId, release: { service_bundle_version: version }, target: { service_bundle_version: version, service_bundle_sha256: artifactSha, schema_version: 7, cloudflare_account_id: "account" }, resources: { d1: { name: "database" } } };
  const input = { stateRoot, instanceId, operationId, taskId, plan };
  await createJournal(input); await authorizeJournal({ ...input, planDigest: canonicalDigest(plan) });
  const serviceBundleRoot = path.join(stateRoot, "bundle"), configPath = path.join(stateRoot, "wrangler.jsonc");
  const migrationReadbackSqlPath = path.join(serviceBundleRoot, "release", "deployment", "migration-readback.sql");
  await mkdir(path.dirname(migrationReadbackSqlPath), { recursive: true });
  await writeFile(migrationReadbackSqlPath, sql); await writeFile(configPath, "{}");
  await appendJournalEvent({ ...input, event: { type: "wrangler_config_written", config_path: configPath, config_digest: canonicalDigest({}), service_bundle_root: serviceBundleRoot } });
  let executedSql;
  const runner = async (_executable, args) => {
    assert.equal(args[0], "d1"); assert.ok(args.includes("--remote"));
    executedSql = args[args.indexOf("--command") + 1];
    return { code: 0, stdout: JSON.stringify([{ success: true, results: [] }, { success: true, results: executedSql.includes("'attachment_storage.'") ? [{ type: "column", name: "attachment_storage.limit_bytes" }] : [] }, { success: true, results: [{ row_count: 1, schema_version: 7 }] }]), stderr: "" };
  };
  return { input, execute: (overrides = {}) => executeWranglerAction({ ...input, action: "migration_ledger_readback", wranglerExecutable: process.execPath, configPath, migrationReadbackSqlPath, environment: {}, runner, ...overrides }), migrationReadbackSqlPath, getSql: () => executedSql };
}
test("alpha57 exact readback SQL gains only fixed column SELECT and audits both digests in the same journal", async (t) => {
  assert.equal(sha256Bytes(Buffer.from(oldSql)), "1aee968287724dfa5b083fd53e92e0e8e93eaf3a9dd81474fcc165e62adefacb");
  const f = await fixture(t), result = await f.execute();
  const supplement = "UNION ALL\nSELECT 'column' AS type, 'attachment_storage.' || name AS name FROM pragma_table_info('attachment_storage')\n";
  assert.equal(f.getSql(), oldSql.replace("ORDER BY type, name;", supplement + "ORDER BY type, name;"));
  assert.equal(await readFile(f.migrationReadbackSqlPath, "utf8"), oldSql);
  assert.equal(result.migration_readback_source.compatibility_fix, "alpha57_attachment_storage_columns");
  assert.equal(result.migration_readback_source.executed_sql_sha256, sha256Bytes(Buffer.from(f.getSql())));
  assert.deepEqual(result.migration_readback.schema.columns, ["attachment_storage.limit_bytes"]);
  const journal = await assertJournalAuthorization(f.input);
  const events = journal.events.filter((entry) => ["command_started", "command_finished"].includes(entry.type));
  assert.equal(events.length, 2);
  for (const event of events) assert.deepEqual(event.migration_readback_source, result.migration_readback_source);
});
test("nonexact SQL and other release versions receive no compatibility rewrite", async (t) => {
  for (const [sql, version] of [[oldSql + "\n", "0.1.0-alpha.57"], [oldSql, "0.1.0-alpha.58"]]) {
    const f = await fixture(t, sql, version), result = await f.execute();
    assert.equal(f.getSql(), sql);
    assert.equal(result.migration_readback_source.compatibility_fix, null);
  }
});
test("compatibility cannot accept external SQL or another plan under an existing authorization", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.input.stateRoot, "override.sql"); await writeFile(outside, oldSql);
  await assert.rejects(f.execute({ migrationReadbackSqlPath: outside }), { code: "MIGRATION_READBACK_SOURCE_DRIFT" });
  await assert.rejects(f.execute({ plan: { ...f.input.plan, target: { ...f.input.plan.target, schema_version: 8 } } }), { code: "PLAN_NOT_AUTHORIZED" });
  assert.equal(f.getSql(), undefined);
});

test("another service artifact cannot use the alpha57 compatibility exception", async (t) => {
  const f = await fixture(t, oldSql, "0.1.0-alpha.57", "f".repeat(64));
  const result = await f.execute();
  assert.equal(result.migration_readback_source.compatibility_fix, null);
  assert.equal(f.getSql(), oldSql);
});
