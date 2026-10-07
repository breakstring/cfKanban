import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const directory = new URL("../../migrations/", import.meta.url);
const previous = await Promise.all((await readdir(directory)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 23)
  .sort().map(async name => await readFile(new URL(name, directory), "utf8")));
const sql = await readFile(new URL("0023_notification_scan_cache.sql", directory), "utf8");
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previous) db.exec(part);
  db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Owner','owner',1,1),('member','Member','member',1,1)");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',22,1)");
  db.exec("INSERT INTO instance_notifications(id,title,body,created_at,created_by_principal_id,created_operation_id,last_operation_id) VALUES('notice','Title','Body',2,'owner','notice-op','notice-op')");
  db.exec("INSERT INTO notification_pending_cache VALUES('member',1,1,1,'[\"notice\"]',1)");
  return db;
}
function apply(db, suffix = "") {
  try { db.exec(`BEGIN;${sql}${suffix}COMMIT;`); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("schema 23 新增有界窗口，保留旧缓存与通知历史且不回填所有 Principal", () => {
  const db = fixture();
  try {
    const notice = db.prepare("SELECT * FROM instance_notifications").all(), legacy = db.prepare("SELECT * FROM notification_pending_cache").all();
    apply(db);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 23);
    assert.deepEqual(db.prepare("SELECT * FROM instance_notifications").all(), notice);
    assert.deepEqual(db.prepare("SELECT * FROM notification_pending_cache").all(), legacy);
    assert.deepEqual(db.prepare("SELECT * FROM notification_pending_windows").all(), []);
    db.prepare("INSERT INTO notification_pending_windows VALUES('member',1,1,1,?,1,0,2,'notice')")
      .run(JSON.stringify(Array.from({ length: 100 }, (_, index) => `notice-${index}`)));
    assert.throws(() => db.prepare("UPDATE notification_pending_windows SET pending_ids_json=?").run(JSON.stringify(Array.from({ length: 101 }, (_, index) => `${index}`))), /constraint/i);
    assert.throws(() => db.exec("UPDATE notification_pending_windows SET pending_ids_json='[]'"), /constraint/i);
    assert.throws(() => db.exec("UPDATE notification_pending_windows SET is_complete=1"), /constraint/i);
    db.exec("UPDATE notification_pending_windows SET is_complete=1,floor_created_at=NULL,floor_id=NULL,pending_ids_json='[]'");
    assert.throws(() => db.exec("UPDATE notification_pending_windows SET is_complete=0"), /constraint/i);
    assert.throws(() => db.exec("DELETE FROM instance_notifications"), /retained/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("schema 23 失败整体回滚，旧缓存仍可读取", () => {
  const db = fixture();
  try {
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /constraint/i);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 22);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='notification_pending_windows'").get(), undefined);
    assert.equal(db.prepare("SELECT pending_ids_json FROM notification_pending_cache").get().pending_ids_json, '["notice"]');
  } finally { db.close(); }
});
