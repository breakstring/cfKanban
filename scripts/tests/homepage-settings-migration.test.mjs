import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";
import { normalizeHomepageNotice } from "../../apps/worker/src/services/homepage-settings.ts";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = manifest.migrations.find(entry => entry.sequence === 11);
const previous = await Promise.all(manifest.migrations.filter(entry => entry.sequence <= 10).map(async entry => ({ entry, sql: await readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8") })));
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");
function record(db, entry) {
  db.prepare("INSERT INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)").run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, "00000000-0000-4000-8000-000000000001", 1);
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previous) db.exec(part.sql);
  for (const part of previous) record(db, part.entry);
  db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Owner','owner',1,1)");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',10,1)");
  db.exec("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES('workspace','Existing',1,1,'owner','owner','workspace')");
  return db;
}
function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('instance_meta','homepage_settings') ORDER BY name").all()
    .map(({name}) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function apply(db, suffix = "") {
  try { db.exec(`BEGIN;${sql}${suffix}COMMIT;`); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function readback(db) {
  return parseMigrationReadbackOutput(JSON.stringify(readbackSql.split(";").map(part => part.trim()).filter(Boolean)
    .map(statement => ({ success: true, results: db.prepare(statement).all() }))));
}
test("首页说明按 Unicode code point 限长，trim 后空值回退，文案保持纯文本", () => {
  for (const value of [null,"", " \n\t "]) assert.equal(normalizeHomepageNotice(value), null);
  assert.equal(normalizeHomepageNotice("  <script>alert(1)</script>  "), "<script>alert(1)</script>");
  assert.equal(normalizeHomepageNotice(` ${"😀".repeat(500)} `), "😀".repeat(500));
  for (const value of [0, {}, [], true, "😀".repeat(501), `\0${"x".repeat(500)}`]) assert.throws(() => normalizeHomepageNotice(value));
});
test("schema 11 is an immutable compatible migration with complete readback artifacts", () => {
  assert.equal(manifest.schema_version, 11);
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.equal(migration.classification, "backward_compatible");
  assert.equal(migration.destructive, false);
  assert.equal(migration.reentry, "wrangler_migration_ledger_only");
  assert.ok(Buffer.byteLength(sql) <= 24576);
  assert.doesNotMatch(sql, /\b(?:DROP|DELETE|ALTER|BEGIN|COMMIT)\b/i);
  for (const part of previous) assert.equal(part.entry.sha256, sha256NormalizedText(part.sql));
  const db = fixture();
  try {
    const before = snapshot(db);
    apply(db);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 11);
    assert.deepEqual({...db.prepare("SELECT * FROM homepage_settings").get()}, {singleton: 1, notice_en: null, notice_zh_cn: null, version: 1, last_operation_id: null});
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    record(db, migration);
    const state = reconcileMigrationState({manifest, ...readback(db)});
    assert.equal(state.safe_to_continue, true);
    assert.ok(state.migrations.every(entry => entry.state === "applied"));
    db.exec("ALTER TABLE homepage_settings DROP COLUMN last_operation_id");
    const missing = reconcileMigrationState({manifest, ...readback(db)});
    assert.equal(missing.safe_to_continue, false);
    assert.equal(missing.migrations.at(-1).reason, "ledger_present_schema_incomplete");
  } finally { db.close(); }
});
test("schema 11 migration failure rolls back singleton and version; repeated apply rejects", () => {
  const db = fixture();
  try {
    const before = snapshot(db);
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /CHECK constraint/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 10);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='homepage_settings'").get(), undefined);
    apply(db);
    assert.throws(() => apply(db), /already exists/);
    assert.throws(() => db.exec("INSERT INTO homepage_settings(singleton) VALUES(2)"), /CHECK constraint/);
    assert.throws(() => db.prepare("UPDATE homepage_settings SET notice_en=?").run("x".repeat(501)), /CHECK constraint/);
  } finally { db.close(); }
});
