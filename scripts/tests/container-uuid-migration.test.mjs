import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const migration = async (name) => readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");

test("UUID migration preserves populated relationships, Web targets and Issue sequence without container keys", async () => {
  const db = new DatabaseSync(":memory:");
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const apply = async (name) => db.exec(`BEGIN;${await migration(name)}COMMIT;`);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    await apply("0001_initial.sql");
    await apply("0002_container_purge.sql");
    const owner = uuid(1), workspace = uuid(2), project = uuid(3), issue = uuid(4), credential = uuid(5), participant = uuid(6);
    run("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?, 'Owner', 1, 1), (?, 'Writer', 1, 1)", owner, participant);
    run("INSERT INTO instance_meta VALUES (1, ?, ?, 'development', 2, 1)", uuid(7), owner);
    run("INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id) VALUES (?, ?, 'owner', ?, 1, 'credential-op')", credential, owner, "a".repeat(64));
    run("INSERT INTO workspaces (id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, 'workspace', 'Same name', 1, 1, ?, ?, 'workspace-op')", workspace, owner, owner);
    run("INSERT INTO projects (id, workspace_id, key, display_name, context, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, 'PROJECT', 'Same project', 'Preserved context', 1, 1, ?, ?, 'project-op')", project, workspace, owner, owner);
    run("INSERT INTO project_grants (id, principal_id, project_id, role, created_at, updated_at, created_operation_id) VALUES (?, ?, ?, 'writer', 1, 1, 'grant-op')", uuid(8), participant, project);
    run("INSERT INTO issues (number, id, project_id, title, title_search, body, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (42, ?, ?, 'Preserved issue', 'preserved issue', 'Markdown body', 1, 1, ?, ?, 'issue-op')", issue, project, owner, owner);
    run("INSERT INTO comments (id, issue_id, kind, author_principal_id, body, completion_json, created_at, created_operation_id) VALUES (?, ?, 'completion', ?, 'Completed', ?, 1, 'comment-op')", uuid(9), issue, participant, JSON.stringify({ summary: "Completed" }));
    run("INSERT INTO public_join_policies (project_id, workspace_id, project_key, public_id, public_summary, enabled_at, enabled_by_principal_id, created_at, updated_at) VALUES (?, ?, 'PROJECT', ?, 'Preserved public summary', 1, ?, 1, 1)", project, workspace, uuid(10), owner);
    run("INSERT INTO events (id, stream, type, operation_id, event_index, actor_principal_id, authorized_via, workspace_id, project_id, subject_type, subject_id, payload_json, created_at) VALUES (?, 'domain', 'issue.completed', 'event-op', 0, ?, 'deployment_owner', ?, ?, 'issue', ?, '{}', 1)", uuid(11), owner, workspace, project, issue);
    run("INSERT INTO operation_commits VALUES ('event-op', 'issue', ?, 1, 1)", issue);
    run("INSERT INTO idempotency_records (id, scope_key, method, route_template, resource_scope_hash, idempotency_key, request_hash, operation_id, state, response_status, response_json, created_at, expires_at) VALUES (?, 'scope', 'POST', '/old/key/path', ?, 'retry', ?, 'cached-op', 'committed', 201, ?, 1, 100)", uuid(12), "b".repeat(64), "c".repeat(64), JSON.stringify({ key: "PROJECT" }));
    const targets = [
      { kind: "project", project_id: project, workspace_key: "workspace", project_key: "PROJECT", entry_path: "/app/w/workspace/p/PROJECT" },
      { kind: "issue", project_id: project, workspace_key: "workspace", project_key: "PROJECT", issue_id: issue, identifier: "CFK-42", entry_path: "/app/issues/CFK-42" },
    ];
    for (const [index, target] of targets.entries()) {
      run("INSERT INTO browser_launches (id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, target_json, expires_at, created_at, created_operation_id) VALUES (?, 'launch', ?, ?, ?, ?, ?, 100, 1, ?)", uuid(20 + index), String(index + 1).repeat(64), owner, credential, target.kind, JSON.stringify(target), `launch-${index}`);
      run("INSERT INTO web_sessions (id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, created_at) VALUES (?, ?, ?, 'credential', ?, ?, ?, 100, 1)", uuid(30 + index), String(index + 3).repeat(64), owner, credential, target.kind, JSON.stringify(target));
    }
    assert.deepEqual(all("PRAGMA foreign_key_check"), []);
    await apply("0003_container_uuid.sql");
    assert.equal(get("PRAGMA foreign_keys").foreign_keys, 1);
    assert.deepEqual(all("PRAGMA foreign_key_check"), []);
    assert.equal(get("SELECT schema_version FROM instance_meta").schema_version, 3);
    assert.equal(get("SELECT context FROM projects WHERE id = ? AND workspace_id = ?", project, workspace).context, "Preserved context");
    assert.equal(get("SELECT role FROM project_grants WHERE project_id = ? AND principal_id = ?", project, participant).role, "writer");
    assert.equal(get("SELECT body FROM issues WHERE id = ? AND project_id = ?", issue, project).body, "Markdown body");
    assert.equal(get("SELECT body FROM comments WHERE issue_id = ?", issue).body, "Completed");
    assert.equal(get("SELECT public_summary FROM public_join_policies WHERE project_id = ?", project).public_summary, "Preserved public summary");
    assert.equal(get("SELECT project_id FROM events WHERE id = ?", uuid(11)).project_id, project);
    assert.equal(get("SELECT token_digest FROM credentials WHERE id = ?", credential).token_digest, "a".repeat(64));
    for (const table of ["browser_launches", "web_sessions"]) {
      const rows = all(`SELECT target_json, principal_id, expires_at FROM ${table} ORDER BY target_kind`);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const target = JSON.parse(row.target_json);
        assert.equal(target.workspace_id, workspace);
        assert.equal(target.project_id, project);
        assert.equal(target.entry_path, target.kind === "project" ? `/app/w/${workspace}/p/${project}` : "/app/issues/CFK-42");
        if (target.kind === "issue") assert.equal(target.issue_id, issue);
        assert.equal("workspace_key" in target, false);
        assert.equal("project_key" in target, false);
        assert.equal(row.principal_id, owner);
        assert.equal(row.expires_at, 100);
      }
    }
    for (const table of ["workspaces", "projects", "public_join_policies"]) {
      assert.ok(all(`PRAGMA table_info(${table})`).every((column) => !["key", "project_key"].includes(column.name)));
    }
    assert.equal(get("SELECT COUNT(*) AS count FROM idempotency_records").count, 0);
    assert.equal(get("SELECT COUNT(*) AS count FROM operation_commits").count, 0);
    run("INSERT INTO workspaces (id, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, 'Same name', 1, 1, ?, ?, 'same-workspace-op')", uuid(40), owner, owner);
    run("INSERT INTO projects (id, workspace_id, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, 'Same project', 1, 1, ?, ?, 'same-project-op')", uuid(41), workspace, owner, owner);
    assert.equal(get("SELECT COUNT(*) AS count FROM workspaces WHERE display_name = 'Same name'").count, 2);
    assert.equal(get("SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ? AND display_name = 'Same project'", workspace).count, 2);
    run("INSERT INTO issues (id, project_id, title, title_search, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, 'Next issue', 'next issue', 2, 2, ?, ?, 'next-issue-op')", uuid(42), project, owner, owner);
    assert.equal(get("SELECT number FROM issues WHERE id = ?", uuid(42)).number, 43);
    assert.deepEqual(all("PRAGMA foreign_key_check"), []);
  } finally { db.close(); }
});

// schema 2 部署时实际使用的 ledger DDL；不得随当前 release DDL 更新。
const schema2LedgerSql = `CREATE TABLE IF NOT EXISTS cfkanban_migration_ledger (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  classification TEXT NOT NULL CHECK (classification IN ('bootstrap', 'backward_compatible', 'destructive')),
  reentry TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (applied_at > 0)
) STRICT;`;

for (const baseline of ["schema2", "fresh_deployment", "schema_fixture"]) {
  test(`UUID migration upgrades the real checksum ledger from ${baseline}`, async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      for (const name of ["0001_initial.sql", "0002_container_purge.sql"]) {
        db.exec(`BEGIN;${await migration(name)}COMMIT;`);
      }
      if (baseline === "schema2") db.exec(schema2LedgerSql);
      if (baseline === "fresh_deployment") {
        db.exec(await readFile(new URL("../../release/deployment/migration-ledger.sql", import.meta.url), "utf8"));
      }
      const insert = () => db.prepare("INSERT INTO cfkanban_migration_ledger VALUES (?, ?, ?, ?, ?, ?, ?)");
      let before = [];
      if (baseline !== "schema_fixture") {
        insert().run(1, "0001_initial.sql", "a".repeat(64), "bootstrap", "wrangler_migration_ledger_only", uuid(101), 1234);
        insert().run(2, "0002_container_purge.sql", "b".repeat(64), "backward_compatible", "wrangler_migration_ledger_only", uuid(102), 5678);
        before = db.prepare("SELECT * FROM cfkanban_migration_ledger ORDER BY sequence").all();
      }
      db.exec(`BEGIN;${await migration("0003_container_uuid.sql")}COMMIT;`);
      assert.deepEqual(db.prepare("SELECT * FROM cfkanban_migration_ledger ORDER BY sequence").all(), before);
      insert().run(3, "0003_container_uuid.sql", "c".repeat(64), "breaking_non_destructive", "wrangler_migration_ledger_only", uuid(103), 9012);
      assert.throws(() => insert().run(4, "unknown.sql", "d".repeat(64), "unknown", "not_safe", uuid(104), 9013), /CHECK constraint failed/);
      const readback = await readFile(new URL("../../release/deployment/migration-readback.sql", import.meta.url), "utf8");
      const resultSets = readback.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql).all());
      assert.equal(resultSets[0].find((row) => row.sequence === 3).classification, "breaking_non_destructive");
      assert.deepEqual(resultSets[0].filter((row) => row.sequence < 3), before);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'cfkanban_migration_ledger_uuid'").get().count, 0);
    } finally { db.close(); }
  });
}

test("UUID ledger rebuild rolls back with its enclosing migration transaction", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of ["0001_initial.sql", "0002_container_purge.sql"]) db.exec(`BEGIN;${await migration(name)}COMMIT;`);
    db.exec(schema2LedgerSql);
    db.prepare("INSERT INTO cfkanban_migration_ledger VALUES (1, '0001_initial.sql', ?, 'bootstrap', 'wrangler_migration_ledger_only', ?, 1234)").run("a".repeat(64), uuid(101));
    const before = db.prepare("SELECT * FROM cfkanban_migration_ledger").all();
    db.exec(`BEGIN;${await migration("0003_container_uuid.sql")}ROLLBACK;`);
    assert.deepEqual(db.prepare("SELECT * FROM cfkanban_migration_ledger").all(), before);
    assert.ok(db.prepare("PRAGMA table_info(workspaces)").all().some((column) => column.name === "key"));
    assert.throws(() => db.prepare("INSERT INTO cfkanban_migration_ledger VALUES (3, '0003_container_uuid.sql', ?, 'breaking_non_destructive', 'wrangler_migration_ledger_only', ?, 5678)").run("c".repeat(64), uuid(103)), /CHECK constraint failed/);
  } finally { db.close(); }
});
