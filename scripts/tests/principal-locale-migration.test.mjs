import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const current = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const manifest = { ...current, schema_version: 19, migrations: current.migrations.filter(entry => entry.sequence <= 19) };
const migration = manifest.migrations.find(entry => entry.sequence === 19);
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const previous = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 19)
  .map(async entry => ({ entry, sql: await readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8") })));
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");

const record = (db, entry) => db.prepare("INSERT INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)")
  .run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, "00000000-0000-4000-8000-000000000001", 1);

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previous) db.exec(`BEGIN;${part.sql}COMMIT;`);
  for (const id of ["locale_owner", "locale_member"]) db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?,?,?,1,1)").run(id, id, id);
  db.exec("UPDATE principals SET theme='blue' WHERE id='locale_owner'");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','locale_owner','0.1.0',18,1)");
  db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES('credential','locale_member','test',?,1,'op')").run("a".repeat(64));
  for (const part of previous) record(db, part.entry);
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

test("schema 19 可空语言偏好默认 null，保留既有身份、主题、凭据及旧 migration 指纹", () => {
  assert.equal(migration.classification, "backward_compatible");
  assert.equal(migration.destructive, false);
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.deepEqual(migration.expected_artifacts.columns, ["principals.locale"]);
  for (const part of previous) assert.equal(part.entry.sha256, sha256NormalizedText(part.sql));
  const db = fixture();
  try {
    const principals = db.prepare("SELECT * FROM principals ORDER BY id").all();
    const credentials = db.prepare("SELECT * FROM credentials").all();
    apply(db);
    assert.deepEqual(db.prepare("SELECT * FROM principals ORDER BY id").all().map(({ locale, ...row }) => {
      assert.equal(locale, null);
      return row;
    }), principals.map(row => ({ ...row })));
    assert.deepEqual(db.prepare("SELECT * FROM credentials").all(), credentials);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 19);
    const column = db.prepare("PRAGMA table_info(principals)").all().find(item => item.name === "locale");
    assert.equal(column.notnull, 0);
    assert.equal(column.dflt_value, "NULL");
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('new','New','new',1,1)").run();
    assert.equal(db.prepare("SELECT locale FROM principals WHERE id='new'").get().locale, null);
    for (const locale of ["en", "zh-CN", null]) {
      db.prepare("UPDATE principals SET locale=? WHERE id='locale_member'").run(locale);
      assert.equal(db.prepare("SELECT locale FROM principals WHERE id='locale_member'").get().locale, locale);
    }
    for (const locale of ["zh", "zh-cn", "EN", "", 1]) assert.throws(() => db.prepare("UPDATE principals SET locale=? WHERE id='locale_member'").run(locale), /constraint/i);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("schema 19 失败原子回滚，成功后 ledger 和真实 locale 列共同决定升级状态", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM principals ORDER BY id").all();
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /constraint/i);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 18);
    assert.deepEqual(db.prepare("SELECT * FROM principals ORDER BY id").all(), before);
    assert.ok(!db.prepare("PRAGMA table_info(principals)").all().some(column => column.name === "locale"));
    apply(db);
    record(db, migration);
    assert.ok(reconcileMigrationState({ manifest, ...readback(db) }).migrations.every(entry => entry.state === "applied"));
    assert.throws(() => apply(db), /duplicate column/i);
    const incomplete = readback(db);
    incomplete.schema.columns = incomplete.schema.columns.filter(column => column !== "principals.locale");
    const state = reconcileMigrationState({ manifest, ...incomplete });
    assert.equal(state.safe_to_continue, false);
    assert.equal(state.migrations.at(-1).reason, "ledger_present_schema_incomplete");
  } finally { db.close(); }
});
