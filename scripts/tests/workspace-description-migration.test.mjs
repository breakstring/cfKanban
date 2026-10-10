import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = manifest.migrations.find(entry => entry.sequence === 31);
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const previous = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 31).map(entry => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));

test("schema31只添加 nullable 描述并保留现有工作区、权限和审计", () => {
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.equal(migration.classification, "backward_compatible");
  assert.deepEqual(migration.expected_artifacts, { columns: ["workspaces.description"] });
  const db = new DatabaseSync(":memory:");
  try {
    for (const part of previous) db.exec(`BEGIN;${part}COMMIT;`);
    db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Test_Owner','test_owner',1,1)");
    db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',30,1)");
    db.exec("INSERT INTO workspaces(id,display_name,version,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id,last_operation_id) VALUES('workspace','Existing',7,1,2,'owner','owner','created','last')");
    const before = { ...db.prepare("SELECT * FROM workspaces WHERE id='workspace'").get() };
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
    const grants = db.prepare("SELECT COUNT(*) AS count FROM scoped_administrator_grants").get().count;
    const events = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
    const changes = db.prepare("SELECT total_changes() AS count").get().count;
    db.exec(`BEGIN;${sql}COMMIT;`);
    assert.deepEqual({ ...db.prepare("SELECT * FROM workspaces WHERE id='workspace'").get() }, { ...before, description: null });
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 31);
    assert.equal(db.prepare("SELECT total_changes() AS count").get().count - changes, 1, "only instance metadata is updated; no Workspace backfill writes");
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all(), indexes);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scoped_administrator_grants").get().count, grants);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events").get().count, events);
    const update = db.prepare("UPDATE workspaces SET description=? WHERE id='workspace'");
    const maximum = "界".repeat(10922) + "ab";
    update.run(maximum);
    assert.equal(db.prepare("SELECT description FROM workspaces").get().description, maximum);
    assert.throws(() => update.run(maximum + "c"), /CHECK constraint/);
    update.run(null);
    assert.equal(db.prepare("SELECT description FROM workspaces").get().description, null);
  } finally { db.close(); }
});
