import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const current = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const manifest = { ...current, schema_version: 17, migrations: current.migrations.filter(entry => entry.sequence <= 17) };
const migration = manifest.migrations.find(entry => entry.sequence === 17);
const sql = await readFile(new URL("../../migrations/0017_web_session_renewal.sql", import.meta.url), "utf8");
const previous = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 17).map(async entry => ({ entry, sql: await readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8") })));
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");
const record = (db, entry) => db.prepare("INSERT INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)")
  .run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, "00000000-0000-4000-8000-000000000001", 1);
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previous) db.exec(part.sql);
  for (const part of previous) record(db, part.entry);
  db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Owner','owner',1,1)");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',16,1)");
  db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES('credential','owner','test',?,1,'credential-operation')").run("a".repeat(64));
  db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at,created_operation_id,last_operation_id)
    VALUES('session',?,'owner','credential','credential','admin','{"kind":"admin","section":"overview","entry_path":"/app/admin"}',28800001,1,'session-operation','session-operation')`).run("b".repeat(64));
  return db;
}
function apply(db, suffix = "") {
  try { db.exec(`BEGIN;${sql}${suffix}COMMIT;`); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function readback(db) {
  return parseMigrationReadbackOutput(JSON.stringify(readbackSql.split(";").map(part => part.trim()).filter(Boolean)
    .map(statement => ({ success: true, results: db.prepare(statement).all() }))));
}

test("schema 17 保留既有 Session、范围与原期限，不批量延长，仅增加默认版本和 expiry 索引", () => {
  assert.equal(migration.classification, "backward_compatible"); assert.equal(migration.destructive, false);
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  for (const part of previous) assert.equal(part.entry.sha256, sha256NormalizedText(part.sql));
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM web_sessions").get();
    apply(db);
    const { version, ...after } = db.prepare("SELECT * FROM web_sessions").get();
    assert.equal(version, 1); assert.deepEqual(after, { ...before });
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 17);
    assert.throws(() => db.exec("UPDATE web_sessions SET version=0"), /constraint/i);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM web_sessions INDEXED BY idx_web_sessions_expiry_cleanup WHERE expires_at<=? ORDER BY expires_at,id LIMIT 100").all(1);
    assert.match(plan.map(row => row.detail).join(" "), /idx_web_sessions_expiry_cleanup/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    record(db, migration);
    assert.ok(reconcileMigrationState({ manifest, ...readback(db) }).migrations.every(entry => entry.state === "applied"));
    for (const [field, absent] of [["columns", "web_sessions.version"], ["indexes", "idx_web_sessions_expiry_cleanup"]]) {
      const missing = readback(db); missing.schema[field] = missing.schema[field].filter(name => name !== absent);
      const state = reconcileMigrationState({ manifest, ...missing });
      assert.equal(state.safe_to_continue, false); assert.equal(state.migrations.at(-1).reason, "ledger_present_schema_incomplete");
    }
  } finally { db.close(); }
});

test("schema 17 migration 失败整体回滚且不可重入，不留下版本列或清理索引", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM web_sessions").get();
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /constraint/i);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 16);
    assert.deepEqual(db.prepare("SELECT * FROM web_sessions").get(), before);
    assert.ok(!db.prepare("PRAGMA table_info(web_sessions)").all().some(column => column.name === "version"));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_web_sessions_expiry_cleanup'").get(), undefined);
    apply(db); assert.throws(() => apply(db), /duplicate column/i);
  } finally { db.close(); }
});
