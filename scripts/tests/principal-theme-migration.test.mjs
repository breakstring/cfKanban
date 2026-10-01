import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
manifest.schema_version = 14;
manifest.migrations = manifest.migrations.filter(entry => entry.sequence <= 14);
const migration = manifest.migrations.find(entry => entry.sequence === 14);
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const previousSql = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 14)
  .map(entry => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");

function recordMigration(db, entry) {
  db.prepare("INSERT INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)")
    .run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, "00000000-0000-4000-8000-000000000001", 1);
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previousSql) db.exec(`BEGIN;${part}COMMIT;`);
  for (const id of ["theme_owner", "theme_member"]) db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?,?,?,1,1)").run(id, id, id);
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','theme_owner','0.1.0',13,1)");
  db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES('credential','theme_member','test',?,1,'op')").run("a".repeat(64));
  for (const entry of manifest.migrations.filter(entry => entry.sequence < 14)) recordMigration(db, entry);
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

test("schema 14 兼容增加主题默认值，保留原 Principal、凭据和旧 migration 指纹", () => {
  assert.equal(migration.classification, "backward_compatible");
  assert.equal(migration.destructive, false);
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.deepEqual(migration.expected_artifacts.columns, ["principals.theme"]);
  for (const [index, entry] of manifest.migrations.slice(0, 13).entries()) assert.equal(entry.sha256, sha256NormalizedText(previousSql[index]));
  const db = fixture();
  try {
    const principals = db.prepare("SELECT * FROM principals ORDER BY id").all();
    const credentials = db.prepare("SELECT * FROM credentials").all();
    apply(db);
    assert.deepEqual(db.prepare("SELECT * FROM principals ORDER BY id").all().map(({ theme, ...row }) => {
      assert.equal(theme, "orange");
      return row;
    }), principals.map(row => ({ ...row })));
    assert.deepEqual(db.prepare("SELECT * FROM credentials").all(), credentials);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 14);
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('new','New','new',1,1)").run();
    assert.equal(db.prepare("SELECT theme FROM principals WHERE id='new'").get().theme, "orange");
    db.exec("UPDATE principals SET theme='blue' WHERE id='theme_member'");
    assert.equal(db.prepare("SELECT theme FROM principals WHERE id='theme_member'").get().theme, "blue");
    for (const theme of ["dark", "BLUE", "", null]) assert.throws(() => db.prepare("UPDATE principals SET theme=? WHERE id='theme_member'").run(theme), /constraint/i);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("schema 14 失败原子回滚，成功后 ledger 和真实 theme 列共同决定升级状态", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM principals ORDER BY id").all();
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /constraint/i);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 13);
    assert.deepEqual(db.prepare("SELECT * FROM principals ORDER BY id").all(), before);
    assert.ok(!db.prepare("PRAGMA table_info(principals)").all().some(column => column.name === "theme"));
    apply(db);
    recordMigration(db, migration);
    assert.ok(reconcileMigrationState({ manifest, ...readback(db) }).migrations.every(entry => entry.state === "applied"));
    assert.throws(() => apply(db), /duplicate column/i);
    const incomplete = readback(db);
    incomplete.schema.columns = incomplete.schema.columns.filter(column => column !== "principals.theme");
    const state = reconcileMigrationState({ manifest, ...incomplete });
    assert.equal(state.safe_to_continue, false);
    assert.equal(state.migrations.at(-1).reason, "ledger_present_schema_incomplete");
  } finally { db.close(); }
});
