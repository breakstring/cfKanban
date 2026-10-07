import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const directory = new URL("../../migrations/", import.meta.url);
const previous = await Promise.all((await readdir(directory)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 22)
  .sort().map(async name => await readFile(new URL(name, directory), "utf8")));
const sql = await readFile(new URL("0022_cost_unique_indexes.sql", directory), "utf8");
const pairs = [["credentials", "token_digest", "idx_credentials_token_digest"],
  ["browser_launches", "code_digest", "idx_browser_launches_code_digest"],
  ["web_sessions", "token_digest", "idx_web_sessions_token_digest"]];
const indexes = (db, table, column) => db.prepare(`PRAGMA index_list(${table})`).all()
  .filter(index => index.unique === 1 && JSON.stringify(db.prepare(`PRAGMA index_info(${index.name})`).all().map(row => row.name)) === JSON.stringify([column]));
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of previous) db.exec(part);
  db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Owner','owner',1,1)");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',21,1)");
  db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES('credential','owner','synthetic',?,1,'credential-operation')").run("a".repeat(64));
  const target = JSON.stringify({ kind: "admin", section: "overview", entry_path: "/app/admin" });
  db.prepare(`INSERT INTO browser_launches(id,code_prefix,code_digest,principal_id,source_credential_id,target_kind,target_json,expires_at,created_at,created_operation_id)
    VALUES('launch','synthetic',?,'owner','credential','admin',?,10,1,'launch-operation')`).run("b".repeat(64), target);
  db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at,created_operation_id)
    VALUES('session',?,'owner','credential','credential','admin',?,10,1,'session-operation')`).run("c".repeat(64), target);
  return db;
}
function apply(db, suffix = "") {
  try { db.exec(`BEGIN;${sql}${suffix}COMMIT;`); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("schema 22 只移除三个重复显式索引，保留原记录、唯一约束及摘要点查", () => {
  const db = fixture();
  try {
    const before = Object.fromEntries(pairs.map(([table]) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    for (const [table, column] of pairs) assert.equal(indexes(db, table, column).length, 2);
    apply(db);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 22);
    for (const [table, column, removed] of pairs) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before[table]);
      const remaining = indexes(db, table, column); assert.equal(remaining.length, 1); assert.equal(remaining[0].origin, "u");
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(removed), undefined);
      const query = `SELECT id FROM ${table} WHERE ${column}=?`;
      assert.equal(db.prepare(query).get(before[table][0][column]).id, before[table][0].id);
      assert.ok(db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(before[table][0][column]).some(row => row.detail.includes(remaining[0].name)));
      const columns = Object.keys(before[table][0]);
      const duplicate = { ...before[table][0], id: `duplicate-${table}`, created_operation_id: `duplicate-${table}` };
      assert.throws(() => db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
        .run(...columns.map(name => duplicate[name])), /UNIQUE/);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("schema 22 失败整体回滚，保留三个显式索引及版本", () => {
  const db = fixture();
  try {
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /constraint/i);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 21);
    for (const [table, column] of pairs) assert.equal(indexes(db, table, column).length, 2);
  } finally { db.close(); }
});
