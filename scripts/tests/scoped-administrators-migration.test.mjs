import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseMigrationReadbackOutput } from "../../packages/skill-runtime/src/deploy.mjs";
import { reconcileMigrationState } from "../../packages/skill-runtime/src/migrations.mjs";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const publishedManifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const manifest = { ...publishedManifest, schema_version: 9, migrations: publishedManifest.migrations.filter((entry) => entry.sequence <= 9) };
const migration = manifest.migrations.find((entry) => entry.sequence === 9);
const sql = await readFile(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
const readbackSql = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");
const schema8Sql = await Promise.all(manifest.migrations.filter((entry) => entry.sequence <= 8)
  .map((entry) => readFile(new URL(`../../migrations/${entry.name}`, import.meta.url), "utf8")));
const id = (suffix) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const owner = id(1), writer = id(2), reader = id(3), workspace = id(4), project = id(5), credential = id(6);
const target = { kind: "project", workspace_id: workspace, project_id: project, entry_path: `/app/w/${workspace}/p/${project}` };

function createProject(db, projectId, operationId = randomUUID()) {
  db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?,?,'Example',1,1,?,?,?)`).run(projectId, workspace, owner, owner, operationId);
}

function addEvent(db, eventId, sequence = null, actor = writer) {
  db.prepare(`INSERT INTO events(sequence,id,stream,type,operation_id,event_index,actor_principal_id,authorized_via,project_id,workspace_id,subject_type,subject_id,payload_json,created_at)
    VALUES(?,?,'domain','issue.updated',?,0,?,'project_grant',?,?,'issue',?,'{}',1)`)
    .run(sequence, eventId, randomUUID(), actor, project, workspace, id(9));
}

function addAdministrator(db, principal, projectId = null) {
  const grantId = randomUUID();
  db.prepare(`INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id)
    VALUES(?,?,?,?,?,1,1,?)`).run(grantId, principal, workspace, projectId, randomUUID(), randomUUID());
  return grantId;
}

function recordMigrations(db, through) {
  for (const entry of manifest.migrations.filter((item) => item.sequence <= through)) {
    db.prepare("INSERT OR IGNORE INTO cfkanban_migration_ledger VALUES(?,?,?,?,?,?,?)")
      .run(entry.sequence, entry.name, entry.sha256, entry.classification, entry.reentry, id(100), 1);
  }
}

function readback(db) {
  return parseMigrationReadbackOutput(JSON.stringify(readbackSql.split(";").map((part) => part.trim()).filter(Boolean)
    .map((statement) => ({ success: true, results: db.prepare(statement).all() }))));
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const part of schema8Sql) db.exec(`BEGIN;${part}COMMIT;`);
  for (const [principal, name] of [[owner, "Test_Owner"], [writer, "Test_Writer"], [reader, "Test_Reader"]]) {
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?,?,?,1,1)")
      .run(principal, name, name.toLowerCase());
  }
  db.prepare("INSERT INTO instance_meta VALUES(1,?,?,'0.1.0',8,1)").run(id(7), owner);
  db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?,?,'test',?,1,?)")
    .run(credential, writer, "a".repeat(64), id(8));
  db.prepare(`INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?,'Example',1,1,?,?,?)`).run(workspace, owner, owner, id(10));
  createProject(db, project);
  for (const [principal, role] of [[writer, "writer"], [reader, "reader"]]) {
    db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?,?,?,?,1,1,?)")
      .run(randomUUID(), principal, project, role, randomUUID());
  }
  db.prepare("INSERT INTO project_usage VALUES(?,1,0,2,1,NULL)").run(project);
  db.prepare(`INSERT INTO issues(id,project_id,title,title_search,assignee_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?,?,'Preserve history','preserve history',?,1,1,?,?,?)`).run(id(9), project, writer, writer, writer, id(11));
  db.prepare(`INSERT INTO invitations(id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
    VALUES(?,'project_grant','invite',?,100,1,?,?)`).run(id(12), "b".repeat(64), owner, id(13));
  db.prepare("INSERT INTO invitation_project_grants VALUES(?,?,'reader')").run(id(12), project);
  db.prepare(`INSERT INTO browser_launches(id,code_prefix,code_digest,principal_id,source_credential_id,target_kind,target_json,expires_at,created_at,created_operation_id)
    VALUES(?,'launch',?, ?,?,'project',?,100,1,?)`).run(id(14), "c".repeat(64), writer, credential, JSON.stringify(target), id(15));
  db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at,created_operation_id)
    VALUES(?, ?,?,'credential',?,'project',?,100,1,?)`).run(id(16), "d".repeat(64), writer, credential, JSON.stringify(target), id(17));
  addEvent(db, id(18), 10);
  addEvent(db, id(19), 100);
  db.prepare("DELETE FROM events WHERE sequence=100").run();
  recordMigrations(db, 8);
  return db;
}

function apply(db) {
  try { db.exec(`BEGIN;${sql}COMMIT;`); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

const historyTables = ["principals", "credentials", "project_grants", "issues", "browser_launches", "web_sessions", "invitation_project_grants"];
const history = (db) => Object.fromEntries(historyTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));

test("schema 9 preserves all previously published migration digests", () => {
  const published = {
    "0001_initial.sql": "8552f2967b0d2b21889a3c7978f46e66d14e0d5da808dc189fe62ac3ac54e5ac",
    "0002_container_purge.sql": "20efa238e6394b2694164a257190e0c1c9fbf79944bc2b121aeb2c7d868bbac9",
    "0003_container_uuid.sql": "e947635c2dde77995eea4397291f3e7089578d9c5a91ba0499a364cbb8abd242",
    "0004_issue_attachments.sql": "cdb10909cfeb76c43822485e14a1036cb8a619f380f837bc3274f7a1559ca2f8",
    "0005_attachment_schema_version.sql": "e0846575e6f3ce89909fc8052dec2c15bd7e02ea4ea44a6e33627d29f8fd1890",
    "0006_usage_statistics.sql": "7d69afb81eab12c306035a4cc84afd1c18fdf645da1bce425a975c6e8640905c",
    "0007_attachment_settings.sql": "b2fa72c8c8cdc213dd774f3266c30a500ee41ddf2acabd9caa749f005bd2a529",
    "0008_principal_names.sql": "f3b541e0cf65d697aa1a3eeaec7a701234f87d475a263f3c829c03b46d932387",
  };
  for (const [index, entry] of manifest.migrations.slice(0, 8).entries()) {
    assert.equal(entry.sha256, published[entry.name]);
    assert.equal(sha256NormalizedText(schema8Sql[index]), published[entry.name]);
  }
});

test("schema 9 remains one bounded breaking non-destructive migration", () => {
  assert.equal(manifest.schema_version, 9);
  assert.equal(migration.classification, "breaking_non_destructive");
  assert.equal(migration.destructive, false);
  assert.equal(migration.reentry, "wrangler_migration_ledger_only");
  assert.equal(migration.sha256, sha256NormalizedText(sql));
  assert.ok(Buffer.byteLength(sql, "utf8") <= 24 * 1024);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN\s*(?:TRANSACTION)?|COMMIT)\s*;/imu);
});

test("schema 8 upgrades with identities, grants, assignments, fixed Sessions and event high-water preserved", () => {
  const db = fixture();
  try {
    const before = history(db);
    const eventBefore = { ...db.prepare("SELECT * FROM events").get() };
    apply(db);
    assert.deepEqual(history(db), before);
    const eventAfter = { ...db.prepare("SELECT * FROM events").get() };
    assert.deepEqual(eventAfter, { ...eventBefore, administrator_grant_id: null, administrator_grant_version: null });
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scoped_administrator_grants").get().n, 0);
    assert.deepEqual(db.prepare("SELECT principal_id,role,source FROM effective_project_grants ORDER BY principal_id").all().map((row) => ({ ...row })), [
      { principal_id: writer, role: "writer", source: "project_grant" },
      { principal_id: reader, role: "reader", source: "project_grant" },
    ]);
    assert.deepEqual({ ...db.prepare("SELECT issuer_administrator_id,issuer_administrator_generation FROM invitations").get() }, { issuer_administrator_id: null, issuer_administrator_generation: null });
    addEvent(db, id(20));
    assert.equal(db.prepare("SELECT sequence FROM events WHERE id=?").get(id(20)).sequence, 101);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_scoped' OR name='scoped_event_sequence'").all(), []);
  } finally { db.close(); }
});

test("effective access deduplicates independent sources, inherits future Projects, and falls back after revocation", () => {
  const db = fixture();
  try {
    apply(db);
    const projectGrant = addAdministrator(db, reader, project);
    const workspaceGrant = addAdministrator(db, reader);
    assert.throws(() => addAdministrator(db, reader), /UNIQUE constraint/);
    assert.throws(() => addAdministrator(db, reader, project), /UNIQUE constraint/);
    const access = () => ({ ...db.prepare("SELECT role,source,source_id FROM effective_project_grants WHERE principal_id=? AND project_id=?").get(reader, project) });
    assert.deepEqual(access(), { role: "writer", source: "workspace_admin", source_id: workspaceGrant });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM effective_project_grants WHERE project_id=?").get(project).n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_access_sources WHERE project_id=? AND principal_id=?").get(project, reader).n, 3);
    createProject(db, id(21));
    assert.equal(db.prepare("SELECT role FROM effective_project_grants WHERE project_id=? AND principal_id=?").get(id(21), reader).role, "writer");
    addEvent(db, id(22), null, reader);
    assert.deepEqual({ ...db.prepare("SELECT authorized_via,administrator_grant_id,administrator_grant_version,grant_id FROM events WHERE id=?").get(id(22)) }, {
      authorized_via: "workspace_admin", administrator_grant_id: workspaceGrant, administrator_grant_version: 1, grant_id: null,
    });
    db.prepare("UPDATE scoped_administrator_grants SET revoked_at=2,revoked_by_principal_id=?,version=version+1 WHERE id=?").run(owner, workspaceGrant);
    assert.deepEqual(access(), { role: "writer", source: "project_admin", source_id: projectGrant });
    db.prepare("UPDATE scoped_administrator_grants SET revoked_at=2,revoked_by_principal_id=?,version=version+1 WHERE id=?").run(owner, projectGrant);
    assert.equal(access().role, "reader");
    assert.equal(access().source, "project_grant");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM effective_project_grants WHERE project_id=? AND principal_id=?").get(id(21), reader).n, 0);
  } finally { db.close(); }
});

test("published readback accepts schema 8 as pending, verifies schema 9 views, and rejects missing applied artifacts", () => {
  const db = fixture();
  try {
    const before = readback(db);
    assert.equal(before.schema.data.instance_meta.schema_version, 8);
    const oldState = reconcileMigrationState({ manifest, ...before });
    assert.equal(oldState.safe_to_continue, true);
    assert.ok(oldState.migrations.slice(0, 8).every((entry) => entry.state === "applied"));
    assert.equal(oldState.migrations.at(-1).state, "pending");
    apply(db);
    recordMigrations(db, 9);
    const after = readback(db);
    assert.deepEqual(after.schema.views, ["effective_project_grants", "project_access_sources"]);
    assert.ok(after.schema.triggers.includes("scoped_admin_event_source"));
    assert.ok(after.schema.columns.includes("events.administrator_grant_id"));
    assert.ok(reconcileMigrationState({ manifest, ...after }).migrations.every((entry) => entry.state === "applied"));
    for (const [kind, name] of [["views", "effective_project_grants"], ["triggers", "scoped_admin_event_source"], ["columns", "invitations.issuer_administrator_generation"]]) {
      const incomplete = { ...after.schema, [kind]: after.schema[kind].filter((entry) => entry !== name) };
      const state = reconcileMigrationState({ manifest, ledger: after.ledger, schema: incomplete });
      assert.equal(state.safe_to_continue, false);
      assert.equal(state.migrations.at(-1).reason, "ledger_present_schema_incomplete");
      assert.ok(state.migrations.at(-1).missing_artifacts[kind].includes(name));
    }
  } finally { db.close(); }
});

test("workspace Browser Launch and Session constraints accept only their matching management path", () => {
  const db = fixture();
  try {
    apply(db);
    const workspaceTarget = { kind: "workspace", workspace_id: workspace, entry_path: `/app/manage?workspace=${workspace}` };
    const session = db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
      VALUES(?,?,?,'credential',?,'workspace',?,100,1)`);
    const launch = db.prepare(`INSERT INTO browser_launches(id,code_prefix,code_digest,principal_id,source_credential_id,target_kind,target_json,expires_at,created_at,created_operation_id)
      VALUES(?,'workspace',?, ?,?,'workspace',?,100,1,?)`);
    session.run(randomUUID(), "e".repeat(64), writer, credential, JSON.stringify(workspaceTarget));
    launch.run(randomUUID(), "f".repeat(64), writer, credential, JSON.stringify(workspaceTarget), randomUUID());
    for (const entryPath of ["/app/admin", `/app/manage?workspace=${id(24)}`]) {
      const badTarget = JSON.stringify({ ...workspaceTarget, entry_path: entryPath });
      assert.throws(() => session.run(randomUUID(), "1".repeat(64), writer, credential, badTarget), /CHECK constraint/);
      assert.throws(() => launch.run(randomUUID(), "2".repeat(64), writer, credential, badTarget, randomUUID()), /CHECK constraint/);
    }
  } finally { db.close(); }
});
