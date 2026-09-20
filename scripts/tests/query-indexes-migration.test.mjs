import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = manifest.migrations.find((entry) => entry.sequence === 10);
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const schema9Sql = await Promise.all(manifest.migrations.filter((entry) => entry.sequence <= 9)
  .map((entry) => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of schema9Sql) db.exec(`BEGIN;${part}COMMIT;`);
  const principal = db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?,?,?,1,1)");
  for (const id of ["test_owner", "test_writer", "test_reader"]) principal.run(id, id, id);
  db.exec("INSERT INTO instance_meta VALUES(1,'instance','test_owner','0.1.0',9,1)");
  db.exec(`INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES('workspace','Example',1,1,'test_owner','test_owner','workspace')`);
  const project = db.prepare(`INSERT INTO projects(id,workspace_id,display_name,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?,'workspace',?,?,?,1,1,'test_owner','test_owner',?)`);
  const grant = db.prepare(`INSERT INTO project_grants(id,principal_id,project_id,role,revoked_at,revoked_by_principal_id,created_at,updated_at,created_operation_id)
    VALUES(?,'test_writer',?,'writer',?,?,1,1,?)`);
  const issue = db.prepare(`INSERT INTO issues(id,project_id,title,title_search,assignee_principal_id,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?,?,'Example','example',?,?,?,1,1,'test_owner','test_owner',?)`);
  for (let n = 0; n < 40; n++) {
    const id = `project-${String(n).padStart(2, "0")}`, deleted = n >= 4;
    project.run(id, id, deleted ? 2 : null, deleted ? "test_owner" : null, id);
    grant.run(`grant-${n}`, id, deleted ? 2 : null, deleted ? "test_owner" : null, `grant-${n}`);
    issue.run(`issue-${n}`, id, n % 2 ? "test_reader" : "test_writer", deleted ? 2 : null, deleted ? "test_owner" : null, `issue-${n}`);
  }
  db.exec(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,authorized_via,project_id,workspace_id,subject_type,subject_id,payload_json,created_at)
    VALUES('event','domain','issue.created','event',0,'test_owner','deployment_owner','project-00','workspace','issue','issue-0','{}',1)`);
  for (const entry of manifest.migrations.filter((item) => item.sequence <= 9)) recordMigration(db, entry);
  return db;
}

function recordMigration(db, entry) {
  db.prepare("INSERT INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)")
    .run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, "00000000-0000-4000-8000-000000000001", 1);
}

function apply(db, suffix = "") {
  try { db.exec(`BEGIN;${sql}${suffix}COMMIT;`); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'instance_meta' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

function readback(db) {
  return parseMigrationReadbackOutput(JSON.stringify(readbackSql.split(";").map((part) => part.trim()).filter(Boolean)
    .map((statement) => ({ success: true, results: db.prepare(statement).all() }))));
}

test("schema 10 adds bounded compatible indexes without table rebuild or rewriting prior migrations", () => {
  assert.equal(manifest.schema_version, 10);
  assert.equal(migration.classification, "backward_compatible");
  assert.equal(migration.destructive, false);
  assert.equal(migration.reentry, "wrangler_migration_ledger_only");
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.ok(Buffer.byteLength(sql, "utf8") <= 24 * 1024);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|DELETE|INSERT|BEGIN|COMMIT)\b/i);
  for (const [index, entry] of manifest.migrations.slice(0, 9).entries()) {
    assert.equal(entry.sha256, sha256NormalizedText(schema9Sql[index]));
  }
});

test("schema 9 upgrades preserving rows, event sequence, prior indexes, constraints and authorization views", () => {
  const db = fixture();
  try {
    const before = snapshot(db);
    const schemaBefore = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const meta = db.prepare("SELECT * FROM instance_meta").get();
    apply(db);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual({ ...db.prepare("SELECT * FROM instance_meta").get() }, { ...meta, schema_version: 10 });
    assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()
      .filter(({ name }) => !migration.expected_artifacts.indexes.includes(name)), schemaBefore);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.throws(() => db.exec("UPDATE issues SET assignee_principal_id='missing' WHERE id='issue-0'"), /FOREIGN KEY constraint/);
    assert.throws(() => db.exec("UPDATE project_grants SET role='admin' WHERE id='grant-0'"), /CHECK constraint/);
    assert.throws(() => db.exec("UPDATE principals SET display_name_key='test_owner' WHERE id='test_writer'"), /UNIQUE constraint/);
  } finally { db.close(); }
});

test("schema 10 failure rolls back all new indexes and version; ledger controls reentry", () => {
  const db = fixture();
  try {
    const before = snapshot(db);
    const schemaBefore = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    assert.throws(() => apply(db, "UPDATE instance_meta SET schema_version=0;"), /CHECK constraint/);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 9);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), schemaBefore);
    apply(db);
    recordMigration(db, migration);
    assert.ok(reconcileMigrationState({ manifest, ...readback(db) }).migrations.every((entry) => entry.state === "applied"));
    assert.throws(() => apply(db), /already exists/);
    db.exec("DROP INDEX idx_issues_active_assignee");
    const state = reconcileMigrationState({ manifest, ...readback(db) });
    assert.equal(state.safe_to_continue, false);
    assert.equal(state.migrations.at(-1).reason, "ledger_present_schema_incomplete");
  } finally { db.close(); }
});

test("query plans use active-only scope, assignee and grant indexes and ordered principal pagination", () => {
  const db = fixture();
  try {
    apply(db);
    const plan = (statement, ...params) => db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...params).map(({ detail }) => detail).join("\n");
    assert.match(plan("SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY workspace_id,id"), /SCAN projects USING INDEX idx_projects_active_scope/);
    assert.match(plan("SELECT id FROM projects WHERE workspace_id=? AND deleted_at IS NULL ORDER BY id", "workspace"), /SEARCH projects USING INDEX idx_projects_active_scope/);
    assert.match(plan("SELECT COUNT(*) FROM issues WHERE assignee_principal_id=? AND deleted_at IS NULL", "test_writer"), /SEARCH issues USING (?:COVERING )?INDEX idx_issues_active_assignee/);
    assert.match(plan("SELECT COUNT(*) FROM project_grants WHERE principal_id=? AND revoked_at IS NULL", "test_writer"), /SEARCH project_grants USING (?:COVERING )?INDEX idx_project_grants_principal_active/);
    const principals = plan("SELECT id,display_name FROM principals WHERE (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?", 1, "test_owner", 10);
    assert.match(principals, /SEARCH principals USING INDEX idx_principals_created/);
    assert.doesNotMatch(principals, /TEMP B-TREE/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM issues WHERE assignee_principal_id=? AND deleted_at IS NULL").get("test_writer").n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_grants WHERE principal_id=? AND revoked_at IS NULL").get("test_writer").n, 4);
  } finally { db.close(); }
});
