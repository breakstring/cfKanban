import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery } from "wrangler";
import { createInitialDeploymentFixture } from "./helpers/initial-deployment-fixture.mjs";
import { createStrictZeroPlan } from "../../packages/skill-runtime/src/plan.mjs";
import { loadInitialMigrationSources, verifyInitialMigrationProjection } from "../../packages/skill-runtime/src/initial-migrations.mjs";
import { executeWranglerAction, parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { recordFirstDeploymentLedger } from "../../packages/cli/src/workflows.mjs";
import { ownerDeploymentFacts, prepareOwnerCredential, writeOwnerBootstrapSql } from "../../packages/skill-runtime/src/bootstrap-sql.mjs";
import { finalizeOwnerDeployment } from "../../packages/skill-runtime/src/deployment-finalize.mjs";
import { treeDigest } from "../../packages/skill-runtime/src/skill-update.mjs";
import { appendJournalEvent, authorizeJournal, createJournal } from "../../packages/skill-runtime/src/journal.mjs";
import { getInstancePaths } from "../../packages/skill-runtime/src/state.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { canonicalDigest, readJson, sha256Bytes } from "../../packages/skill-runtime/src/utils.mjs";

async function fixture(t, options) {
  const home = await mkdtemp(path.join(tmpdir(), "cfkanban-initial-migrations-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, ".cfkanban");
  await mkdir(stateRoot, { mode: 0o700 });
  return { ...await createInitialDeploymentFixture(stateRoot, options), home };
}

for (const schemaVersion of [30, 31]) test(`schema${schemaVersion}初装完整源摘要与私有执行投影绑定，canonical Service不变`, async t => {
  const f = await fixture(t, { schemaVersion });
  const before = await loadInitialMigrationSources(f);
  assert.equal(before.files.length, schemaVersion);
  assert.equal(f.plan.migrations.initial_execution.projection_sha256, canonicalDigest(f.plan.migrations.initial_execution.ordered));
  assert.deepEqual((await readdir(f.projectionPath)).sort(), f.manifest.migrations.map(entry => entry.name).sort());
  for (const entry of f.plan.migrations.initial_execution.ordered) {
    assert.equal(sha256Bytes(await readFile(path.join(f.serviceBundleRoot, "migrations", entry.name))), entry.source_sql_sha256);
    assert.equal(sha256Bytes(await readFile(path.join(f.projectionPath, entry.name))), entry.executed_sql_sha256);
    assert.equal(entry.compatibility_transform !== null, entry.sequence === 30);
    assert.equal(entry.source_sql_sha256 !== entry.executed_sql_sha256, entry.sequence === 30);
  }
  const events = (await readJson(path.join(getInstancePaths(f).journalsRoot, `${f.operationId}.json`))).events;
  const config = await readJson(f.configPath);
  await verifyInitialMigrationProjection({ ...f, config, frozenConfigEvent: events.findLast(event => event.type === "wrangler_config_written") });
  assert.equal(config.d1_databases[0].migrations_dir, f.projectionPath);
  assert.equal((await loadInitialMigrationSources(f)).evidence.bundle_tree_digest, before.evidence.bundle_tree_digest);
  for (const mutate of [input => input.initialMigrations.ordered.pop(), input => input.initialMigrations.ordered.reverse(), input => input.initialMigrations.ordered[29].sha256 = "f".repeat(64)]) {
    const input = structuredClone(f.planInput); mutate(input);
    assert.throws(() => createStrictZeroPlan(input), { code: "INITIAL_MIGRATION_EXECUTION_REQUIRED" });
  }
});

test("完整31份执行SQL及Wrangler migration ledger footer在空SQLite成立，canonical checksum逐条补记可续做", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  db.exec(await readFile(path.join(f.serviceBundleRoot, "release/deployment/migration-ledger.sql"), "utf8"));
  for (const migration of f.manifest.migrations) {
    const sql = await readFile(path.join(f.projectionPath, migration.name), "utf8");
    const query = `${sql}\nINSERT INTO d1_migrations (name) values ('${migration.name}');`;
    for (const part of unstable_splitSqlQuery(query)) db.exec(part);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get().n, 31);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM instance_meta").get().n, 0);
  const readbackQueries = unstable_splitSqlQuery(await readFile(path.join(f.serviceBundleRoot, "release/deployment/migration-readback.sql"), "utf8"));
  const readback = () => parseMigrationReadbackOutput(JSON.stringify(readbackQueries.map(sql => ({ results: db.prepare(sql).all(), success: true }))));
  const initialReadback = readback();
  const events = [{ type: "cli_first_deploy_absence_verified", worker_name: f.plan.resources.worker.name, d1_name: f.plan.resources.d1.name },
    { type: "command_finished", action: "create_d1", exit_code: 0 },
    { type: "cli_created_d1_verified", database_id: f.databaseId, d1_name: f.plan.resources.d1.name, account_id: f.plan.target.cloudflare_account_id },
    { type: "command_finished", action: "apply_non_destructive_migrations", exit_code: 0 },
    { type: "command_finished", action: "migration_ledger_readback", exit_code: 0, migration_readback: initialReadback }];
  for (const event of events) await appendJournalEvent({ ...f, event });
  let records = 0;
  let interrupted = false;
  const runner = async (_executable, args) => {
    if (args.includes("--file")) {
      if (++records === 2 && !interrupted) { interrupted = true; throw new Error("isolated checksum interruption"); }
      db.exec(await readFile(args[args.indexOf("--file") + 1], "utf8"));
      return { code: 0, stdout: "[]", stderr: "", signal: null };
    }
    assert.ok(args.includes("--command"));
    return { code: 0, stdout: JSON.stringify(readbackQueries.map(sql => ({ results: db.prepare(sql).all(), success: true }))), stderr: "", signal: null };
  };
  const helper = async (name, input) => { assert.equal(name, "deploy wrangler-action"); return executeWranglerAction({ ...input, wranglerExecutable: "/isolated/wrangler", runner, environment: {} }); };
  const shared = { configPath: f.configPath, migrationReadbackSqlPath: path.join(f.serviceBundleRoot, "release/deployment/migration-readback.sql") };
  await assert.rejects(recordFirstDeploymentLedger({ ...f, manifest: f.manifest, readback: initialReadback, helper, shared }), /isolated checksum interruption/);
  const firstRow = db.prepare("SELECT * FROM cfkanban_migration_ledger WHERE sequence=1").get();
  assert.equal(firstRow.sha256, f.manifest.migrations[0].sha256);
  await helper("deploy wrangler-action", { ...f, ...shared, action: "migration_ledger_readback" });
  await recordFirstDeploymentLedger({ ...f, manifest: f.manifest, readback: readback(), helper, shared });
  const final = readback();
  assert.equal(final.ledger.length, 31);
  assert.deepEqual(db.prepare("SELECT * FROM cfkanban_migration_ledger WHERE sequence=1").get(), firstRow);
  assert.equal(final.ledger.find(entry => entry.sequence === 30).sha256, f.manifest.migrations[29].sha256);
  const state = reconcileMigrationState({ manifest: f.manifest, ...final });
  assert.equal(state.safe_to_continue, true);
  assert.ok(state.migrations.every(entry => entry.state === "applied"));
  await verifyOwnerBootstrapAndFinalize(f, db);
  db.exec("DELETE FROM cfkanban_migration_ledger WHERE sequence=1");
  await helper("deploy wrangler-action", { ...f, ...shared, action: "migration_ledger_readback" });
  const recordedBefore = records;
  await assert.rejects(recordFirstDeploymentLedger({ ...f, manifest: f.manifest, readback: readback(), helper, shared }), { code: "CLI_INITIAL_LEDGER_STATE_CONTRADICTION" });
  assert.equal(records, recordedBefore);
});

test("初装投影多余SQL、执行字节、符号链接、canonical树及config漂移均在云写前拒绝", async t => {
  const scenarios = [
    { code: "INITIAL_MIGRATION_PROJECTION_DRIFT", change: f => writeFile(path.join(f.projectionPath, "9999_unplanned.sql"), "SELECT 1") },
    { code: "INITIAL_MIGRATION_PROJECTION_DRIFT", change: f => writeFile(path.join(f.projectionPath, f.manifest.migrations[0].name), "SELECT 1") },
    { code: "INITIAL_MIGRATION_PROJECTION_DRIFT", change: async f => { const file = path.join(f.projectionPath, f.manifest.migrations[0].name); await rm(file); await symlink(path.join(f.serviceBundleRoot, "migrations", f.manifest.migrations[0].name), file); } },
    { code: "LOCAL_SERVICE_BUNDLE_MODIFIED", change: f => writeFile(path.join(f.serviceBundleRoot, "migrations/manifest.json"), "{}") },
    { code: "LOCAL_SERVICE_BUNDLE_MODIFIED", change: f => writeFile(path.join(f.serviceBundleRoot, "migrations", f.manifest.migrations[0].name), "SELECT 1") },
    { code: "WRANGLER_CONFIG_DRIFT", change: async f => { const config = await readJson(f.configPath); config.d1_databases[0].migrations_dir = path.join(f.serviceBundleRoot, "migrations"); await writeFile(f.configPath, JSON.stringify(config)); } },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(t); await scenario.change(f); let calls = 0;
    await assert.rejects(executeWranglerAction({ ...f, wranglerExecutable: "/isolated/wrangler", action: "apply_non_destructive_migrations", environment: {},
      runner: async () => { calls++; throw new Error("must not execute"); } }), { code: scenario.code });
    assert.equal(calls, 0);
    const events = (await readJson(path.join(getInstancePaths(f).journalsRoot, `${f.operationId}.json`))).events;
    assert.equal(events.some(event => event.type === "command_started"), false);
  }
});

test("create_d1前需要完整不可变Service；已有初装apply尝试拒绝再次执行", async t => {
  const f = await fixture(t); let calls = 0;
  const options = { ...f, wranglerExecutable: "/isolated/wrangler", environment: {}, runner: async () => { calls++; throw new Error("must not execute"); } };
  await assert.rejects(executeWranglerAction({ ...options, action: "create_d1", serviceBundleRoot: null }), { code: "INITIAL_SERVICE_BUNDLE_REQUIRED" });
  await appendJournalEvent({ ...f, event: { type: "command_started", action: "apply_non_destructive_migrations" } });
  await assert.rejects(executeWranglerAction({ ...options, action: "apply_non_destructive_migrations" }), { code: "INITIAL_MIGRATION_ALREADY_ATTEMPTED" });
  await writeFile(path.join(f.serviceBundleRoot, "dist/index.js"), "changed");
  await assert.rejects(executeWranglerAction({ ...options, action: "create_d1" }), { code: "LOCAL_SERVICE_BUNDLE_MODIFIED" });
  assert.equal(calls, 0);
});

test("实际schema31不能用遗漏或schema29计划绕过初装冻结，projection损坏仍允许只读核实", async t => {
  const f = await fixture(t);
  for (const schema of [undefined, 29]) {
    const input = structuredClone(f.planInput);
    delete input.initialMigrations;
    if (schema === undefined) delete input.release.schema_version;
    else input.release.schema_version = schema;
    const { plan } = createStrictZeroPlan(input);
    const operation = { ...f, plan, instanceId: plan.target.instance_id, operationId: plan.operation_id, taskId: plan.task_id };
    await createJournal(operation);
    await authorizeJournal({ ...operation, planDigest: canonicalDigest(plan) });
    let calls = 0;
    await assert.rejects(executeWranglerAction({ ...operation, configPath: null, wranglerExecutable: "/isolated/wrangler", action: "create_d1", environment: {},
      runner: async () => { calls++; throw new Error("must not execute"); } }), { code: "INITIAL_MIGRATION_SCHEMA_DRIFT" });
    assert.equal(calls, 0);
  }
  await writeFile(path.join(f.projectionPath, f.manifest.migrations[0].name), "changed");
  let calls = 0;
  const result = await executeWranglerAction({ ...f, wranglerExecutable: "/isolated/wrangler", action: "migration_ledger_readback", environment: {},
    migrationReadbackSqlPath: path.join(f.serviceBundleRoot, "release/deployment/migration-readback.sql"),
    runner: async () => { calls++; return { code: 0, stdout: JSON.stringify([{ results: [], success: true }, { results: [], success: true }, { results: [{ row_count: 0, schema_version: null }], success: true }]), stderr: "", signal: null }; } });
  assert.equal(result.command_succeeded, true);
  assert.equal(calls, 1);
  await writeFile(path.join(f.serviceBundleRoot, "release/deployment/migration-readback.sql"), "DELETE FROM principals;");
  await assert.rejects(executeWranglerAction({ ...f, wranglerExecutable: "/isolated/wrangler", action: "migration_ledger_readback", environment: {},
    migrationReadbackSqlPath: path.join(f.serviceBundleRoot, "release/deployment/migration-readback.sql"),
    runner: async () => { calls++; throw new Error("must not execute changed canonical readback"); } }), { code: "LOCAL_SERVICE_BUNDLE_MODIFIED" });
  assert.equal(calls, 1);
});

test("旧schema31计划、projection漂移及未完成部署在Owner Credential生成前停止", async t => {
  const f = await fixture(t);
  const legacy = structuredClone(f.plan); delete legacy.migrations.initial_execution;
  assert.throws(() => ownerDeploymentFacts(legacy, f.instanceId, f.operationId), { code: "INITIAL_MIGRATION_EXECUTION_REQUIRED" });
  await assert.rejects(prepareOwnerCredential(f), { code: "MAINTENANCE_READBACK_REQUIRED" });
  await writeFile(path.join(f.projectionPath, f.manifest.migrations[29].name), "changed");
  await assert.rejects(prepareOwnerCredential(f), { code: "INITIAL_MIGRATION_PROJECTION_DRIFT" });
  await assert.rejects(readFile(getInstancePaths(f).pendingSecret), { code: "ENOENT" });
  await assert.rejects(readFile(getInstancePaths(f).pendingMetadata), { code: "ENOENT" });
});

async function verifyOwnerBootstrapAndFinalize(f, db) {
  const version = f.plan.release.service_bundle_version;
  const skillPath = path.join(f.stateRoot, "skill-releases", "versions", version);
  await mkdir(skillPath, { recursive: true, mode: 0o700 });
  const artifact = f.releaseManifest.artifacts.find(entry => entry.kind === "skill_bundle");
  await writeFile(path.join(skillPath, ".cfkanban-release.json"), JSON.stringify({ version, artifact_sha256: artifact.sha256,
    publisher: "https://publisher.invalid", source: artifact.url }), { mode: 0o600 });
  await writeFile(path.join(f.stateRoot, "skill-releases/active.json"), JSON.stringify({ version, path: skillPath,
    artifact_sha256: artifact.sha256, tree_digest: await treeDigest(skillPath) }), { mode: 0o600 });
  for (const event of [{ type: "command_finished", action: "deploy_worker_and_static_assets", exit_code: 0 },
    { type: "command_finished", action: "worker_deployment_readback", exit_code: 0,
      worker_deployment_readback: { maintenance_configuration: { crons: f.plan.maintenance.crons, verified: true } } }]) await appendJournalEvent({ ...f, event });
  const local = { ...f, persistenceConfirmed: true };
  const prepared = await prepareOwnerCredential(local);
  assert.equal(prepared.state, "pending");
  const apiOrigin = "https://isolated-first-deployment.workers.dev";
  const written = await writeOwnerBootstrapSql({ ...f, preferredApiOrigin: apiOrigin });
  assert.equal(written.contains_plaintext_credential, false);
  db.exec(await readFile(written.bootstrap_sql_path, "utf8"));
  assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 31);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM principals").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n, 1);
  await appendJournalEvent({ ...f, event: { type: "command_finished", action: "bootstrap_owner", exit_code: 0 } });
  const principal = f.plan.owner_bootstrap.owner_principal_id;
  const fetchImpl = async url => {
    const common = { instance_id: f.instanceId, preferred_api_origin: apiOrigin, observed_origin: apiOrigin,
      origin_version: 1, release_version: version, service_version: "0.1.0", schema_version: 31 };
    switch (new URL(url).pathname) {
      case "/healthz": return Response.json({ ...common, d1: "reachable" });
      case "/.well-known/cfkanban-instance.json": return Response.json({ ...common, discovery_version: 1 });
      case "/api/v1/meta": return Response.json({ ...common, principal: { id: principal, is_owner: true } });
      case "/api/v1/me": return Response.json({ id: principal, principal_id: principal, display_name: "IsolatedOwner", is_owner: true,
        credential: { id: f.plan.owner_bootstrap.owner_credential_id, fingerprint: prepared.credential_fingerprint } });
      default: throw new Error("Unplanned isolated finalization endpoint");
    }
  };
  const finalized = await finalizeOwnerDeployment({ ...local, apiOrigin, fetchImpl });
  assert.equal(finalized.finalized, true);
  const receipt = await readJson(finalized.receipt_path);
  assert.equal(receipt.instance.schema_version, 31);
  assert.equal(receipt.owner.principal_id, principal);
  assert.equal(receipt.verification.migration_ledger_and_schema, true);
  await assert.rejects(readFile(getInstancePaths(f).pendingSecret), { code: "ENOENT" });
}
