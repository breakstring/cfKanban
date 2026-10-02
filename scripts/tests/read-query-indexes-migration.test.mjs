import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = manifest.migrations.find(entry => entry.sequence === 18);
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const previous = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 18).map(async entry => ({
  entry, sql: await readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8"),
})));
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");
const record = (db, entry) => db.prepare("INSERT INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)")
  .run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, "00000000-0000-4000-8000-000000000001", 1);

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previous) db.exec(part.sql);
  for (const part of previous) record(db, part.entry);
  db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Owner','owner',1,1)");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',17,1)");
  db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES('credential','owner','test',?,1,'credential-operation')").run("a".repeat(64));
  db.exec(`INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES('workspace','Workspace',1,1,'owner','owner','workspace-operation');
    INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES('project','workspace','Project',1,1,'owner','owner','project-operation');
    INSERT INTO labels(id,project_id,name,color,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES('label','project','Label','#abcdef',1,1,'owner','owner','label-operation');`);
  return db;
}
function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'instance_meta' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function schema(db) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(); }
function apply(db, suffix = "") {
  try { db.exec(`BEGIN;${sql}${suffix}COMMIT;`); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function readback(db) {
  return parseMigrationReadbackOutput(JSON.stringify(readbackSql.split(";").map(part => part.trim()).filter(Boolean)
    .map(statement => ({ success: true, results: db.prepare(statement).all() }))));
}

test("schema 18 仅新增定向读取索引，保留已有数据、授权视图、约束与历史迁移指纹", () => {
  assert.equal(migration.classification, "backward_compatible"); assert.equal(migration.destructive, false);
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|DELETE|INSERT|BEGIN|COMMIT)\b/i);
  for (const part of previous) assert.equal(part.entry.sha256, sha256NormalizedText(part.sql));
  const db = fixture();
  try {
    const before = snapshot(db), schemaBefore = schema(db);
    apply(db);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 18);
    assert.deepEqual(schema(db).filter(({ name }) => !migration.expected_artifacts.indexes.includes(name)), schemaBefore);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    record(db, migration);
    assert.ok(reconcileMigrationState({ manifest, ...readback(db) }).migrations.every(entry => entry.state === "applied"));
    const incomplete = readback(db);
    incomplete.schema.indexes = incomplete.schema.indexes.filter(name => name !== "idx_labels_active_name");
    assert.equal(reconcileMigrationState({ manifest, ...incomplete }).migrations.at(-1).reason, "ledger_present_schema_incomplete");
    assert.throws(() => apply(db), /already exists/);
  } finally { db.close(); }
});

test("schema 18 migration 失败时整体回滚，不留下部分索引或版本变更", () => {
  const db = fixture();
  try {
    const before = snapshot(db), schemaBefore = schema(db);
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /constraint/i);
    assert.deepEqual(snapshot(db), before); assert.deepEqual(schema(db), schemaBefore);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 17);
  } finally { db.close(); }
});
