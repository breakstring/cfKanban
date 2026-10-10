import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery } from "wrangler";
import { createInstanceUpgradePlan } from "../../packages/skill-runtime/src/upgrade-plan.mjs";
import { createStrictZeroPlan } from "../../packages/skill-runtime/src/plan.mjs";
import { buildWranglerInvocation, executeWranglerAction } from "../../packages/skill-runtime/src/deploy.mjs";
import { TREND_BACKFILL_SQL_COMPATIBILITY, prepareUpgradeMigrationSql } from "../../packages/skill-runtime/src/migration-sql-compatibility.mjs";
import { appendJournalEvent, authorizeJournal, createJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { getInstancePaths } from "../../packages/skill-runtime/src/state.mjs";
import { canonicalDigest, sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";
import { JOB_PAGE_SQL, TREND_HISTORY_PAGE_SQL, createTrendBackfillCommit } from "../../apps/worker/src/maintenance/issue-trend-backfill.ts";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = manifest.migrations.find(entry => entry.sequence === 30);
const migrations = await Promise.all(manifest.migrations.map(entry => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));
const sourceSql = migrations[29];
const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function planInput(delta = migration) {
  const core = { principal: { limit: 120, period_seconds: 60 }, instance: { limit: 300, period_seconds: 60 },
    unauthenticated_sensitive: { limit: 30, period_seconds: 60 } };
  const bindings = [{ type: "assets", name: "ASSETS", value_redacted: true }, { type: "d1", name: "DB", database_id: id("8") }];
  for (const [scope, key, namespace] of [["principal", "PRINCIPAL", "1001"], ["instance", "INSTANCE", "1002"], ["unauthenticated_sensitive", "UNAUTHENTICATED", "1003"]]) {
    const variableKey = scope === "unauthenticated_sensitive" ? "UNAUTHENTICATED_SENSITIVE" : key;
    bindings.push({ type: "ratelimit", name: `${key}_RATE_LIMITER`, namespace_id: namespace },
      { type: "plain_text", name: `RATE_LIMIT_${variableKey}_LIMIT`, text: String(core[scope].limit) },
      { type: "plain_text", name: `RATE_LIMIT_${variableKey}_PERIOD_SECONDS`, text: "60" });
  }
  const release = { publisher: "https://github.com", manifest_version: "1.12.0-rc.8", manifest_sha256: "a".repeat(64),
    service_bundle_version: "1.12.0-rc.8", service_bundle_sha256: "b".repeat(64),
    service_bundle_source: "https://github.com/example/service.zip", service_api_version: "0.1.0", schema_version: 29 };
  return { taskId: "isolated-sql-compatibility", instanceId: id("1"), operationId: randomUUID(),
    cloudflare: { account_id: "isolated-account", profile: "isolated", api_origin: "https://example.workers.dev" },
    resources: { worker: { name: "isolated-worker", deployment_id: id("6"), version_id: id("7"), bindings, worker_limits: null, observability: null },
      d1: { name: "isolated-d1", database_id: id("8") }, workers_dev: true, custom_domain: null, routes: [], pages: false },
    bindings: { d1: "DB", assets: "ASSETS", rate_limits: core }, owner: { display_name: "IsolatedOwner", principal_id: id("2"), credential_id: id("3"), credential_fingerprint: "isolated" },
    current: release, target: { ...release, manifest_version: "1.12.0-rc.9", service_bundle_version: "1.12.0-rc.9", service_bundle_sha256: "c".repeat(64),
      schema_version: 30, migration_manifest_sha256: "d".repeat(64), compatibility: { node: ">=22.12.0 <27", wrangler: ">=4.127.1 <5",
        service_api: ">=0.1.0 <0.2.0", schema_version: 30 } }, migrations: [delta],
    restorePoint: { required: true, verified: true, bookmark: "isolated", observed_at: "2026-10-10T00:00:00Z", retention_boundary: "isolated", reason: "isolated" } };
}
function plan() { return createInstanceUpgradePlan(planInput()); }
function prepared(value = plan(), sql = sourceSql, selected = migration) {
  return prepareUpgradeMigrationSql({ plan: value, migration: selected, sourceSql: sql });
}

test("only the exact published migration adds source and execution digests to the plan", () => {
  const value = plan();
  assert.deepEqual(value.migrations.execution, { mode: "single_query", max_sql_bytes: 24576 });
  assert.deepEqual(value.migrations.sql_compatibility, [{ ...TREND_BACKFILL_SQL_COMPATIBILITY }]);
  assert.equal(sha256Bytes(Buffer.from(sourceSql)), TREND_BACKFILL_SQL_COMPATIBILITY.source_sql_sha256);
  const legacy = structuredClone(value); delete legacy.migrations.sql_compatibility;
  assert.notEqual(canonicalDigest(value), canonicalDigest(legacy));
  for (const delta of [{ ...migration, name: "0030_other.sql" }, { ...migration, sha256: "e".repeat(64) }]) {
    assert.equal(createInstanceUpgradePlan(planInput(delta)).migrations.sql_compatibility, undefined);
  }
});

test("old plans retain the original bytes and one command without an implicit compatibility fix", () => {
  const value = plan(); delete value.migrations.sql_compatibility;
  const execution = prepared(value);
  assert.equal(execution.sql, sourceSql);
  assert.equal(execution.evidence.compatibility_transform, null);
  assert.equal(execution.evidence.executed_sql_sha256, migration.sha256);
  const args = buildWranglerInvocation({ action: "apply_migration", plan: value, configPath: "/isolated/wrangler.jsonc", migrationSql: execution.sql, environment: {} });
  assert.deepEqual(args.filter(arg => arg.startsWith("--command=")), [`--command=${sourceSql}`]);
  assert.equal(args.includes("--file"), false);
});

test("compatibility metadata cannot change or widen the fixed transform", () => {
  for (const field of ["name", "source_sql_sha256", "executed_sql_sha256", "transform"]) {
    const value = plan(); value.migrations.sql_compatibility[0][field] = "changed";
    assert.throws(() => prepared(value), { code: "MIGRATION_SQL_COMPATIBILITY_PLAN_MISMATCH" });
  }
  for (const metadata of [null, [], {}, [{ ...TREND_BACKFILL_SQL_COMPATIBILITY, extra: true }]]) {
    const value = plan(); value.migrations.sql_compatibility = metadata;
    assert.throws(() => prepared(value), { code: "MIGRATION_SQL_COMPATIBILITY_PLAN_MISMATCH" });
  }
  assert.throws(() => prepared(plan(), sourceSql + "\n"), { code: "UPGRADE_MIGRATION_SOURCE_DRIFT" });
  const arbitrarySql = "SELECT 1;";
  assert.throws(() => prepared(plan(), arbitrarySql, { ...migration, sha256: sha256Bytes(Buffer.from(arbitrarySql)) }),
    { code: "MIGRATION_SQL_COMPATIBILITY_PLAN_MISMATCH" });
});

test("the fixed execution digest wraps all eight trigger CASE expressions and splits into five statements", () => {
  const execution = prepared();
  assert.equal(execution.evidence.executed_sql_sha256, TREND_BACKFILL_SQL_COMPATIBILITY.executed_sql_sha256);
  assert.equal(execution.evidence.source_sql_bytes, 3853);
  assert.equal(execution.evidence.sql_bytes, 3869);
  const parts = unstable_splitSqlQuery(execution.sql);
  assert.equal(parts.length, 5);
  const trigger = parts[3];
  assert.equal(trigger.match(/\(CASE\b/gu).length, 8);
  assert.doesNotMatch(trigger, /(?<!\()\bCASE\b/gu);
  assert.match(trigger, /UPDATE issue_trend_backfill SET replay_json=NULL/u);
  assert.match(trigger, /\nEND$/u);
});

function sqliteFixture(sql) {
  const db = new DatabaseSync(":memory:");
  migrations.slice(0, 28).forEach(part => db.exec(part));
  db.exec(`INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','TrendOwner','trendowner',1,1);
    INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',28,1);
    INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('w','Trends',1,1,'owner','owner','w');
    INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('p','w','Trends',1,1,'owner','owner','p');
    INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('i','p','Trend','trend','todo',1767268800000,1767268800000,'owner','owner','i');`);
  db.exec(migrations[28]);
  unstable_splitSqlQuery(sql).forEach(part => db.exec(part));
  db.exec("UPDATE issue_trend_backfill_control SET run_id='run',fence=1,lease_until=9999999999999 WHERE id=1");
  return db;
}
function snapshot(db) {
  return Object.fromEntries(["issues", "issue_trend_states", "issue_trend_totals", "issue_trend_projects", "issue_trend_backfill", "issue_trend_days", "issue_trend_backfill_control"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))]));
}

test("original and compatible SQL preserve history, coverage, CAS and trigger rollback behavior", () => {
  const states = [];
  for (const sql of [sourceSql, prepared().sql]) {
    for (const mode of ["complete", "partial", "invalid", "fault", "expired"]) {
      const db = sqliteFixture(sql);
      try {
        const next = db.prepare(JOB_PAGE_SQL).get(1);
        const events = db.prepare(TREND_HISTORY_PAGE_SQL).all(next.project_id, next.issue_id, next.cursor);
        const commit = createTrendBackfillCommit(next, events, { runId: "run", fence: 1, batchId: "batch" });
        const payload = JSON.parse(commit.params[9]);
        if (mode === "complete") { payload.partial = false; payload.stock_from = "1970-01-01"; payload.flow_from = "1970-01-01"; }
        if (mode === "partial") { payload.partial = true; payload.stock_from = "2026-01-02"; payload.flow_from = "2026-01-03"; }
        if (mode === "fault") db.exec("CREATE TRIGGER isolated_fault BEFORE UPDATE ON issue_trend_backfill_control BEGIN SELECT RAISE(ABORT,'isolated fault'); END");
        if (mode === "expired") db.exec("UPDATE issue_trend_backfill_control SET lease_until=0 WHERE id=1");
        commit.params[9] = mode === "invalid" ? "{" : JSON.stringify(payload);
        const before = snapshot(db);
        if (["invalid", "fault", "expired"].includes(mode)) {
          if (mode === "expired") assert.equal(Number(db.prepare(commit.sql).run(...commit.params).changes), 0);
          else assert.throws(() => db.prepare(commit.sql).run(...commit.params));
          assert.deepEqual(snapshot(db), before);
        } else {
          assert.equal(Number(db.prepare(commit.sql).run(...commit.params).changes), 1);
          assert.equal(Number(db.prepare(commit.sql).run(...commit.params).changes), 0);
          assert.equal(db.prepare("SELECT pending_jobs FROM issue_trend_projects").get().pending_jobs, 0);
          if (mode === "partial") assert.equal(db.prepare("SELECT stock_from FROM issue_trend_projects").get().stock_from, "2026-01-02");
        }
        assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 30);
        states.push(snapshot(db));
      } finally { db.close(); }
    }
  }
  assert.deepEqual(states.slice(0, 5), states.slice(5));
});

test("apply journals both digests before executing the one plan-bound command", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cfkanban-sql-compatibility-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleRoot = path.join(root, "service"), stateRoot = path.join(root, "state"), value = plan();
  await mkdir(path.join(bundleRoot, "migrations"), { recursive: true });
  const fixtureManifest = JSON.stringify({ manifest_version: 1, migrations: [migration] });
  value.target.migration_manifest_sha256 = sha256Bytes(Buffer.from(fixtureManifest));
  await writeFile(path.join(bundleRoot, "migrations", "manifest.json"), fixtureManifest);
  const migrationPath = path.join(bundleRoot, "migrations", migration.name);
  await writeFile(migrationPath, sourceSql);
  const configPath = path.join(root, "wrangler.jsonc"), config = { name: "isolated-worker" };
  await writeFile(configPath, JSON.stringify(config));
  const operation = { stateRoot, instanceId: value.instance_id, operationId: value.operation_id };
  await createJournal({ ...operation, plan: value });
  await authorizeJournal({ ...operation, taskId: value.task_id, planDigest: canonicalDigest(value) });
  await appendJournalEvent({ ...operation, event: { type: "wrangler_config_written", config_path: configPath,
    config_digest: canonicalDigest(config), service_bundle_root: bundleRoot, service_bundle_artifact_sha256: value.release.service_bundle_sha256 } });
  await appendJournalEvent({ ...operation, event: { type: "command_finished", action: "migration_ledger_readback", exit_code: 0,
    migration_readback: { ledger: [], schema: { tables: [], indexes: [], columns: [], triggers: [], data: { instance_meta: { row_count: 1, schema_version: 29 } } } } } });
  const journalPath = path.join(getInstancePaths(operation).journalsRoot, `${value.operation_id}.json`);
  let calls = 0;
  await executeWranglerAction({ ...operation, taskId: value.task_id, plan: value, wranglerExecutable: "/isolated/wrangler",
    action: "apply_migration", configPath, migrationSqlPath: migrationPath, migrationName: migration.name, environment: {},
    runner: async (_executable, args) => {
      calls++;
      assert.deepEqual(args.filter(arg => arg.startsWith("--command=")), [`--command=${prepared(value).sql}`]);
      assert.equal(args.includes("--file"), false);
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      const started = journal.events.at(-1);
      assert.equal(started.type, "command_started");
      assert.equal(started.migration.sha256, migration.sha256);
      assert.deepEqual(started.migration_execution, { ...value.migrations.execution, ...prepared(value).evidence });
      assert.ok(started.args.includes("--command=[VERIFIED_PUBLIC_MIGRATION_SQL]"));
      return { code: 0, stdout: "[]", stderr: "", signal: null };
    } });
  assert.equal(calls, 1);
  const mutated = structuredClone(value); mutated.migrations.sql_compatibility[0].executed_sql_sha256 = "f".repeat(64);
  await assert.rejects(executeWranglerAction({ ...operation, taskId: value.task_id, plan: mutated, wranglerExecutable: "/isolated/wrangler",
    action: "apply_migration", configPath, migrationSqlPath: migrationPath, migrationName: migration.name, environment: {},
    runner: async () => { calls++; throw new Error("must not run"); } }), { code: "PLAN_NOT_AUTHORIZED" });
  assert.equal(calls, 1);
});

test("包含schema30迁移的首次安装计划继续拒绝，schema31不绕过deferred限制", () => {
  const input = { taskId: "isolated-install", accountId: "isolated", ownerDisplayName: "IsolatedOwner",
    release: { manifest_version: "isolated", manifest_sha256: "a".repeat(64), service_bundle_version: "isolated", service_bundle_sha256: "b".repeat(64) } };
  for (const schema of [30, 31, 32]) {
    assert.throws(() => createStrictZeroPlan({ ...input, release: { ...input.release, schema_version: schema } }),
      { code: "DEPLOYMENT_INITIAL_SCHEMA30_UNSUPPORTED" });
  }
  assert.equal(createStrictZeroPlan({ ...input, release: { ...input.release, schema_version: 29 } }).plan.release.schema_version, 29);
});

for (const schema of [30, 31]) test(`既存schema${schema}新装计划执行前拒绝云端写入并保留只读检查`, async t => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "cfkanban-schema30-install-guard-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const value = createStrictZeroPlan({ taskId: "isolated-install", accountId: "isolated", ownerDisplayName: "IsolatedOwner",
    release: { manifest_version: "isolated", manifest_sha256: "a".repeat(64), service_bundle_version: "isolated", service_bundle_sha256: "b".repeat(64), schema_version: 29 } }).plan;
  value.release.schema_version = schema;
  const operation = { stateRoot, instanceId: value.target.instance_id, operationId: value.operation_id };
  await createJournal({ ...operation, plan: value });
  await authorizeJournal({ ...operation, taskId: value.task_id, planDigest: canonicalDigest(value) });
  let calls = 0;
  const runner = async () => { calls++; return { code: 0, stdout: "[]", stderr: "", signal: null }; };
  for (const action of ["create_d1", "deploy_worker_and_static_assets", "apply_non_destructive_migrations", "apply_migration", "initialize_migration_checksum_ledger", "record_migration_checksum", "bootstrap_owner"]) {
    await assert.rejects(executeWranglerAction({ ...operation, taskId: value.task_id, plan: value, wranglerExecutable: "/isolated/wrangler", action, environment: {}, runner }),
      { code: "DEPLOYMENT_INITIAL_SCHEMA30_UNSUPPORTED" });
  }
  assert.equal(calls, 0);
  const journalPath = path.join(getInstancePaths(operation).journalsRoot, `${value.operation_id}.json`);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).events.some(event => event.type === "command_started"), false);
  await assert.rejects(executeWranglerAction({ ...operation, taskId: value.task_id, plan: value, wranglerExecutable: "/isolated/wrangler",
    action: "worker_deployment_readback", environment: {}, runner }), error => error.code !== "DEPLOYMENT_INITIAL_SCHEMA30_UNSUPPORTED");
  assert.equal(calls, 1);
});
