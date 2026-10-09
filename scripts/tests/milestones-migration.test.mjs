import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = manifest.migrations.find(entry => entry.sequence === 28);
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const previousSql = await Promise.all(manifest.migrations.filter(entry => entry.sequence < 28)
  .map(entry => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));
function fixture() {
  const db = new DatabaseSync(":memory:"); for (const part of previousSql) db.exec(part);
  db.exec("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','MilestoneOwner','milestoneowner',1,1)");
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',27,1)");
  db.exec("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES('workspace','Milestone',1,1,'owner','owner','workspace')");
  for (const id of ['project', 'peer']) db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?,'workspace',?,1,1,'owner','owner',?)").run(id, id, id);
  db.exec("INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES('legacy','project','Legacy','legacy','todo',1,1,'owner','owner','legacy')");
  return db;
}
const createMilestone = (db, id = "m", project = "project") => db.prepare("INSERT INTO milestones(id,project_id,title,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?,?,'Node',1,1,'owner','owner',?)").run(id, project, id);

test("schema 28 preserves legacy Issue and starts with no implicit milestones", () => {
  const db = fixture(); try {
    const before = { ...db.prepare("SELECT * FROM issues WHERE id='legacy'").get() }; db.exec(sql);
    assert.equal(migration.sha256, sha256NormalizedText(sql)); assert.equal(migration.classification, "backward_compatible"); assert.equal(migration.destructive, false);
    assert.deepEqual({ ...db.prepare("SELECT * FROM issues WHERE id='legacy'").get() }, { ...before, milestone_id: null });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM milestones").get().n, 0);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 28);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("schema enforces project ownership and calendar dates without inherited assignment", () => {
  const db = fixture(); try {
    db.exec(sql); createMilestone(db); createMilestone(db, 'foreign', 'peer');
    assert.throws(() => db.exec("UPDATE issues SET milestone_id='foreign' WHERE id='legacy'"), /same project/);
    assert.throws(() => db.exec("UPDATE milestones SET due_date='2026-02-29' WHERE id='m'"), /CHECK/);
    db.exec("UPDATE milestones SET due_date='2028-02-29' WHERE id='m'");
    assert.equal(db.prepare("SELECT milestone_id FROM issues WHERE id='legacy'").get().milestone_id, null);
    db.exec("UPDATE issues SET milestone_id='m' WHERE id='legacy'");
    assert.equal(db.prepare("SELECT current_total FROM milestones WHERE id='m'").get().current_total, 1);
    assert.throws(() => db.exec("DELETE FROM milestones WHERE id='m'"), /FOREIGN KEY/);
  } finally { db.close(); }
});

test("statistic changes are atomic and title edits leave milestone counters untouched", () => {
  const db = fixture(); try {
    db.exec(sql); createMilestone(db); db.exec("UPDATE issues SET milestone_id='m' WHERE id='legacy'");
    const writesBefore = db.prepare("SELECT total_changes() AS n").get().n;
    db.exec("UPDATE issues SET title='Edited',status_key=status_key,milestone_id=milestone_id WHERE id='legacy'");
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n - writesBefore, 1);
    db.exec("BEGIN; UPDATE issues SET status_key='done' WHERE id='legacy'; ROLLBACK;");
    assert.equal(db.prepare("SELECT current_done FROM milestones WHERE id='m'").get().current_done, 0);
    db.exec("UPDATE issues SET status_key='canceled' WHERE id='legacy'");
    assert.deepEqual({ ...db.prepare("SELECT current_total,current_done,current_canceled,version FROM milestones WHERE id='m'").get() }, { current_total: 1, current_done: 0, current_canceled: 1, version: 1 });
    db.exec("DELETE FROM issues WHERE id='legacy'"); assert.equal(db.prepare("SELECT current_total FROM milestones WHERE id='m'").get().current_total, 0);
  } finally { db.close(); }
});

test("failed migration rolls back the new column, table, indexes and version", () => {
  const db = fixture(); try {
    assert.throws(() => { db.exec("BEGIN"); try { db.exec(sql); db.exec("UPDATE instance_meta SET schema_version=0"); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } }, /CHECK/);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 27);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='milestones'").get(), undefined);
    assert.ok(!db.prepare("PRAGMA table_info(issues)").all().some(column => column.name === "milestone_id"));
  } finally { db.close(); }
});
