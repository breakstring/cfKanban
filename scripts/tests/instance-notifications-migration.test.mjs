import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const current = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const manifest = { ...current, schema_version: 15, migrations: current.migrations.filter(entry => entry.sequence <= 15) };
const migration = manifest.migrations.find(entry => entry.sequence === 15);
const sql = await readFile(new URL("../../migrations/0015_instance_notifications.sql", import.meta.url), "utf8");
const previous = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 15).map(async entry => ({ entry, sql: await readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8") })));
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");
const record = (db, entry) => db.prepare("INSERT INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)")
  .run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, "00000000-0000-4000-8000-000000000001", 1);
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previous) db.exec(part.sql);
  for (const part of previous) record(db, part.entry);
  db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Owner','owner',1,1),('member','Member','member',2,2)");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',14,1)");
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
function seed(db, title = "Notice", body = "Text") {
  db.prepare("INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id) VALUES('notice',?,?,3,'owner','operation','operation')").run(title, body);
}

test("schema 15 兼容创建单份通知与按需个人状态；保留既有身份且不进行用户扇出", () => {
  assert.equal(migration.classification, "backward_compatible"); assert.equal(migration.destructive, false);
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.ok(Buffer.byteLength(sql) <= 24576);
  for (const part of previous) assert.equal(part.entry.sha256, sha256NormalizedText(part.sql));
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM principals ORDER BY id").all();
    apply(db);
    assert.deepEqual(db.prepare("SELECT * FROM principals ORDER BY id").all(), before);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 15);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_preferences").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_acknowledgements").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    record(db, migration);
    assert.ok(reconcileMigrationState({ manifest, ...readback(db) }).migrations.every(entry => entry.state === "applied"));
    const missing = readback(db); missing.schema.triggers = missing.schema.triggers.filter(name => name !== "notification_content_immutable");
    assert.equal(reconcileMigrationState({ manifest, ...missing }).safe_to_continue, false);
  } finally { db.close(); }
});

test("schema 15 强制 Unicode 限长与公告/确认不可变历史，撤回保留原文", () => {
  const db = fixture();
  try {
    apply(db); seed(db, "😀".repeat(200), "😀".repeat(4000));
    for (const field of ["sequence", "title", "body", "expires_at", "created_at", "created_by_principal_id"]) {
      assert.throws(() => db.prepare(`UPDATE instance_notifications SET ${field}=? WHERE id='notice'`).run(field.endsWith("_at") ? 10 : "changed"));
    }
    assert.throws(() => db.exec("DELETE FROM instance_notifications"), /retained/);
    db.exec("UPDATE instance_notifications SET withdrawn_at=10,version=2,last_operation_id='withdraw' WHERE id='notice'");
    assert.equal(db.prepare("SELECT body FROM instance_notifications").get().body, "😀".repeat(4000));
    assert.throws(() => db.exec("UPDATE instance_notifications SET withdrawn_at=NULL"), /immutable/);
    db.exec("INSERT INTO notification_acknowledgements VALUES('notice','member',11,'ack')");
    assert.throws(() => db.exec("UPDATE notification_acknowledgements SET acknowledged_at=12"), /immutable/);
    assert.throws(() => db.exec("DELETE FROM notification_acknowledgements"), /retained/);
    assert.throws(() => db.exec("INSERT INTO notification_acknowledgements VALUES('notice','member',12,'ack2')"), /UNIQUE/);
    for (const [title, body] of [["😀".repeat(201), "x"], ["x", "😀".repeat(4001)], ["x\0", "x"], ["x", "x\0"], ["", "x"]]) {
      assert.throws(() => db.prepare("INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id) VALUES('bad',?,?,3,'owner','op','op')").run(title, body), /constraint/i);
    }
  } finally { db.close(); }
});

test("提交序列不可修改或复用；未读投影仅按 Principal 存至多 50 个 ID", () => {
  const db = fixture();
  try {
    apply(db); seed(db);
    const sequence = db.prepare("SELECT sequence FROM instance_notifications WHERE id='notice'").get().sequence;
    db.exec("BEGIN; INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id) VALUES('rolled-back','x','x',3,'owner','op','op'); ROLLBACK;");
    db.exec("INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id) VALUES('later','x','x',2,'owner','op2','op2');");
    assert.ok(db.prepare("SELECT sequence FROM instance_notifications WHERE id='later'").get().sequence > sequence);
    assert.throws(() => db.exec("UPDATE instance_notifications SET sequence=100 WHERE id='notice'"), /immutable/);
    db.exec(`INSERT INTO notification_pending_cache VALUES('member',1,2,${sequence},'["notice"]',1)`);
    assert.throws(() => db.prepare("UPDATE notification_pending_cache SET pending_ids_json=?").run(JSON.stringify(Array.from({ length: 51 }, (_, index) => `${index}`))), /constraint/i);
    assert.throws(() => db.exec("UPDATE notification_pending_cache SET pending_ids_json='broken'"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_preferences").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_acknowledgements").get().count, 0);
  } finally { db.close(); }
});

test("schema 15 migration 失败整体回滚；真实表、索引与不可变 trigger 参与 ledger 核验", () => {
  const db = fixture();
  try {
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /constraint/i);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 14);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='instance_notifications'").get(), undefined);
    apply(db); assert.throws(() => apply(db), /already exists/);
    record(db, migration);
    const incomplete = readback(db); incomplete.schema.tables = incomplete.schema.tables.filter(name => name !== "notification_acknowledgements");
    const state = reconcileMigrationState({ manifest, ...incomplete });
    assert.equal(state.safe_to_continue, false); assert.equal(state.migrations.at(-1).reason, "ledger_present_schema_incomplete");
  } finally { db.close(); }
});
