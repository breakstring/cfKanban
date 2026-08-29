import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../migrations/manifest.json", import.meta.url), "utf8"));
assert.equal(
  manifest.migrations[0].sha256,
  createHash("sha256").update(migration).digest("hex"),
  "migration manifest digest drifted",
);
const db = new DatabaseSync(":memory:");
db.exec(migration);

const now = 1_787_966_400_000;
const digest = (character) => character.repeat(64);
const run = (sql, values = []) => db.prepare(sql).run(...values);
const get = (sql, values = []) => db.prepare(sql).get(...values);
const expectConstraint = (label, action) => {
  assert.throws(action, (error) => {
    assert.match(error.message, /constraint|foreign key|unique/i, label);
    return true;
  });
};

assert.equal(get("PRAGMA foreign_keys").foreign_keys, 1, "foreign keys must be enabled");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
assert.equal(tables.length, 25, "unexpected application table count");
assert.deepEqual(
  tables.map((row) => row.name).sort(),
  [...manifest.migrations[0].expected_artifacts.tables].sort(),
  "manifest table artifacts differ from applied schema",
);
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all();
for (const index of manifest.migrations[0].expected_artifacts.indexes) {
  assert.ok(indexes.some((row) => row.name === index), `missing manifest index ${index}`);
}

run("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["owner", "Lin", now, now]);
run("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", ["writer", "Chen", now, now]);
run("INSERT INTO instance_meta VALUES (1, ?, ?, ?, ?, ?)", ["instance-1", "owner", "0.1.0", 1, now]);
run("INSERT INTO instance_origin_settings VALUES (1, ?, 1, ?, ?, ?)", ["https://example.workers.dev", now, "owner", "op-origin"]);
run("INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id) VALUES (?, ?, ?, ?, ?, ?)", ["cred-owner", "owner", "owner", digest("a"), now, "op-cred-owner"]);
run("INSERT INTO workspaces (id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["workspace", "agent-tools", "Agent Tools", now, now, "owner", "owner", "op-workspace"]);
run("INSERT INTO projects (id, workspace_id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["project", "workspace", "CORE", "Core", now, now, "owner", "owner", "op-project"]);
run("INSERT INTO project_grants (id, principal_id, project_id, role, created_at, updated_at, created_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)", ["grant", "writer", "project", "writer", now, now, "op-grant"]);
run("INSERT INTO issues (id, project_id, title, title_search, status_key, priority_key, priority_rank, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["issue-1", "project", "First issue", "first issue", "todo", "high", 1, now, now, "owner", "owner", "op-issue-1"]);
run("INSERT INTO issues (id, project_id, title, title_search, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["issue-2", "project", "Second issue", "second issue", now + 1, now + 1, "owner", "owner", "op-issue-2"]);
assert.deepEqual(db.prepare("SELECT number FROM issues ORDER BY number").all().map((row) => row.number), [1, 2]);

expectConstraint("workspace key", () => run("INSERT INTO workspaces (id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('bad-workspace', 'Bad Key', 'Bad', ?, ?, 'owner', 'owner', 'op-bad-workspace')", [now, now]));
expectConstraint("foreign key", () => run("INSERT INTO projects (id, workspace_id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('bad-project', 'missing', 'BAD', 'Bad', ?, ?, 'owner', 'owner', 'op-bad-project')", [now, now]));
expectConstraint("grant role", () => run("INSERT INTO project_grants (id, principal_id, project_id, role, created_at, updated_at, created_operation_id) VALUES ('bad-grant', 'writer', 'project', 'admin', ?, ?, 'op-bad-grant')", [now, now]));
expectConstraint("priority pair", () => run("INSERT INTO issues (id, project_id, title, title_search, priority_key, priority_rank, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('bad-priority', 'project', 'Bad', 'bad', 'urgent', 4, ?, ?, 'owner', 'owner', 'op-bad-priority')", [now, now]));

run("INSERT INTO labels (id, project_id, name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["label", "project", "Security", now, now, "owner", "owner", "op-label"]);
run("UPDATE labels SET deleted_at = ?, deleted_by_principal_id = ?, version = version + 1 WHERE id = ?", [now + 2, "owner", "label"]);
expectConstraint("soft-deleted label identity", () => run("INSERT INTO labels (id, project_id, name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('label-duplicate', 'project', 'security', ?, ?, 'owner', 'owner', 'op-label-duplicate')", [now, now]));
expectConstraint("self relation", () => run("INSERT INTO issue_relations (id, workspace_id, kind, source_issue_id, target_issue_id, created_at, created_by_principal_id, created_operation_id) VALUES ('relation-self', 'workspace', 'related', 'issue-1', 'issue-1', ?, 'owner', 'op-relation-self')", [now]));
expectConstraint("completion payload", () => run("INSERT INTO comments (id, issue_id, kind, author_principal_id, body, created_at, created_operation_id) VALUES ('bad-completion', 'issue-1', 'completion', 'owner', 'Done', ?, 'op-bad-completion')", [now]));
expectConstraint("recovery invite binding", () => run("INSERT INTO invitations (id, kind, code_prefix, code_digest, expires_at, created_at, created_by_owner_principal_id, created_operation_id) VALUES ('bad-invite', 'principal_recovery', 'bad', ?, ?, ?, 'owner', 'op-bad-invite')", [digest("b"), now + 3600000, now]));
expectConstraint("usage counters", () => run("INSERT INTO project_usage VALUES ('project', -1, 0, 0, ?, 'op-bad-usage')", [now]));
expectConstraint("passkey algorithm allowlist", () => run("INSERT INTO web_authenticators (id, principal_id, credential_id, public_key_cose, algorithm, user_handle, backup_eligible, backup_state, rp_id, created_at, created_operation_id) VALUES ('bad-passkey', 'owner', 'credential', 'cose', -8, 'owner', 0, 0, 'example.workers.dev', ?, 'op-bad-passkey')", [now]));
expectConstraint("passkey backup flags", () => run("INSERT INTO web_authenticators (id, principal_id, credential_id, public_key_cose, algorithm, user_handle, backup_eligible, backup_state, rp_id, created_at, created_operation_id) VALUES ('bad-backup', 'owner', 'credential-2', 'cose', -7, 'owner', 0, 2, 'example.workers.dev', ?, 'op-bad-backup')", [now]));

const planChecks = [
  ["credential authentication", "SELECT p.id FROM credentials c JOIN principals p ON p.id = c.principal_id WHERE c.token_digest = ? AND c.revoked_at IS NULL", [digest("a")], /idx_credentials_token_digest|sqlite_autoindex_credentials/],
  ["project issue list", "SELECT number FROM issues WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, number DESC LIMIT 21", ["project"], /idx_issues_project_list/],
  ["issue candidates", "SELECT number FROM issues WHERE project_id = ? AND status_key = ? AND deleted_at IS NULL ORDER BY priority_rank, created_at, number LIMIT 21", ["project", "todo"], /idx_issues_candidates/],
  ["project grants", "SELECT principal_id FROM project_grants WHERE project_id = ? AND revoked_at IS NULL AND role = ?", ["project", "writer"], /idx_project_grants_project_active/],
  ["comments", "SELECT id FROM comments WHERE issue_id = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT 21", ["issue-1"], /idx_comments_issue_list/],
  ["invitation redeem", "SELECT id FROM invitations WHERE code_digest = ?", [digest("b")], /idx_invitations_code_digest|sqlite_autoindex_invitations/],
  ["events", "SELECT sequence FROM events WHERE project_id = ? AND stream = ? AND sequence > ? ORDER BY sequence LIMIT 21", ["project", "domain", 0], /idx_events_project_stream_sequence/],
];

for (const [label, sql, values, expectedIndex] of planChecks) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((row) => row.detail).join(" | ");
  assert.match(plan, expectedIndex, `${label}: ${plan}`);
  assert.doesNotMatch(plan, /SCAN (credentials|issues|project_grants|comments|invitations|events)(?:\s|$)/, `${label} unexpectedly scans: ${plan}`);
}

console.log(`D1 schema checks passed for ${tables.length} tables, core constraints, tombstone uniqueness, and ${planChecks.length} indexed query shapes.`);
