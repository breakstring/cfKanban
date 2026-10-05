import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const directory = new URL("../../migrations/", import.meta.url);
const names = (await readdir(directory)).filter(name => /^\d{4}.*\.sql$/.test(name)).sort();
const previous = await Promise.all(names.filter(name => !name.startsWith("0020")).map(name => readFile(new URL(name, directory), "utf8")));
const migration = await readFile(new URL("0020_issue_search_index.sql", directory), "utf8");

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const sql of previous) db.exec(sql);
  db.exec(`INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES('owner','Owner','owner',1,1);
    INSERT INTO instance_meta VALUES(1,'instance','owner','0.1.0',19,1);
    INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('workspace','Workspace',1,1,'owner','owner','workspace-op');
    INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('project','workspace','Project',1,1,'owner','owner','project-op');
    INSERT INTO issues(id,project_id,title,title_search,body,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      VALUES('issue','project','Original','original','Secret body',1,1,'owner','owner','issue-op');`);
  return db;
}

function event(db, type, payload = {}, subject = "issue", subjectType = "issue", bindOperation = true) {
  const count = db.prepare("SELECT count(*) AS n FROM events").get().n;
  if (subjectType === "issue" && bindOperation) db.prepare("UPDATE issues SET last_operation_id=? WHERE id=?").run(`event-op-${count}`, subject);
  db.prepare(`INSERT INTO events(id,stream,type,operation_id,event_index,actor_principal_id,authorized_via,workspace_id,project_id,subject_type,subject_id,payload_json,created_at)
    VALUES(?,'domain',?,?,0,'owner','deployment_owner','workspace','project',?,?,?,1)`)
    .run(`event-${count}`, type, `event-op-${count}`, subjectType, subject, JSON.stringify(payload));
}

test("search migration bootstraps metadata and event-trigger changes roll back with the business operation", () => {
  const db = fixture();
  try {
    db.exec(`BEGIN;${migration}COMMIT;`);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 20);
    assert.deepEqual({ ...db.prepare("SELECT * FROM search_index_documents").get() }, {
      id: "issue", project_id: "project", number: 1, title: "Original", is_removed: 0, revision: 0,
    });
    const before = db.prepare("SELECT * FROM search_index_projects").get();
    db.exec("BEGIN; UPDATE issues SET title='Changed' WHERE id='issue';");
    event(db, "issue.updated", { title_changed: true });
    assert.equal(db.prepare("SELECT revision FROM search_index_projects").get().revision, 1);
    db.exec("ROLLBACK");
    assert.deepEqual(db.prepare("SELECT * FROM search_index_projects").get(), before);
    assert.equal(db.prepare("SELECT title FROM search_index_documents").get().title, "Original");
    assert.equal(db.prepare("SELECT count(*) AS n FROM search_index_changes").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("body/comments/no-op title never change search revisions; delete and restore advance an Issue revision", () => {
  const db = fixture();
  try {
    db.exec(migration);
    db.exec("UPDATE issues SET body='Another secret body' WHERE id='issue'");
    event(db, "issue.updated", { body_changed: true });
    event(db, "comment.created", {}, "comment", "comment");
    event(db, "issue.updated", { title_changed: true });
    assert.equal(db.prepare("SELECT revision FROM search_index_projects").get().revision, 0);
    db.exec("UPDATE issues SET title='Changed' WHERE id='issue'");
    event(db, "issue.updated", { title_changed: true }, "issue", "issue", false);
    assert.equal(db.prepare("SELECT revision FROM search_index_projects").get().revision, 0, "another operation's Event cannot project this row");
    event(db, "issue.updated", { title_changed: true });
    assert.equal(db.prepare("SELECT event_sequence FROM search_index_projects").get().event_sequence, 5);
    db.exec("UPDATE issues SET deleted_at=2,deleted_by_principal_id='owner' WHERE id='issue'");
    event(db, "issue.deleted");
    assert.deepEqual({ ...db.prepare("SELECT title,is_removed,revision FROM search_index_documents").get() }, { title: "", is_removed: 1, revision: 2 });
    db.exec("UPDATE issues SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id='issue'");
    event(db, "issue.restored");
    assert.equal(db.prepare("SELECT revision FROM search_index_documents").get().revision, 3);
    assert.deepEqual(db.prepare("SELECT kind,revision,project_revision,event_sequence FROM search_index_changes ORDER BY event_sequence").all().map(row => ({ ...row })), [
      { kind: "upsert", revision: 1, project_revision: 1, event_sequence: 5 },
      { kind: "remove", revision: 2, project_revision: 2, event_sequence: 6 },
      { kind: "upsert", revision: 3, project_revision: 3, event_sequence: 7 },
    ]);
    const fields = db.prepare("PRAGMA table_info(search_index_documents)").all().map(row => row.name);
    assert.equal(fields.includes("body"), false);
  } finally { db.close(); }
});

test("search change retention is bounded per project and physical purge removes metadata", () => {
  const db = fixture();
  try {
    db.exec(migration);
    db.exec("BEGIN");
    for (let n = 0; n < 10005; n++) {
      db.prepare("UPDATE issues SET title=? WHERE id='issue'").run(`Title ${n}`);
      event(db, "issue.updated", { title_changed: true });
    }
    db.exec("COMMIT");
    assert.deepEqual({ ...db.prepare("SELECT revision,retained_after FROM search_index_projects").get() }, { revision: 10005, retained_after: 5 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM search_index_changes").get().n, 10000);
    db.exec("DELETE FROM issues WHERE id='issue'");
    assert.equal(db.prepare("SELECT count(*) AS n FROM search_index_documents").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM search_index_changes").get().n, 0);
    assert.deepEqual({ ...db.prepare("SELECT revision,retained_after FROM search_index_projects").get() }, { revision: 10005, retained_after: 10005 });
  } finally { db.close(); }
});
