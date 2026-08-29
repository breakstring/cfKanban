import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec(migration);

const now = 1_787_966_400_000;
const digest = (character) => character.repeat(64);
const run = (sql, values = []) => db.prepare(sql).run(...values);
const get = (sql, values = []) => db.prepare(sql).get(...values);
const plain = (row) => ({ ...row });

function atomic(action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    action();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function expectAtomicRollback(label, action) {
  assert.throws(() => atomic(action), (error) => {
    assert.match(error.message, /constraint/i, label);
    return true;
  });
}

function finalize(operationId, subjectType, subjectId, expectedEvents) {
  run(
    `INSERT INTO operation_commits
      (operation_id, primary_subject_type, primary_subject_id, last_event_sequence, committed_at)
     VALUES (?, ?, ?, (
       SELECT CASE WHEN COUNT(*) = ? THEN MAX(sequence) END
       FROM events WHERE operation_id = ?
     ), ?)`,
    [operationId, subjectType, subjectId, expectedEvents, operationId, now],
  );
}

function insertDomainEvent({ operationId, eventIndex, type, workspaceId, projectId, subjectType, subjectId, guardKind = "issue", guardId = subjectId }) {
  const guardSql = {
    issue: "SELECT 1 FROM issues WHERE id = ? AND last_operation_id = ?",
    invitation: "SELECT 1 FROM invitations WHERE id = ? AND last_operation_id = ?",
    relation: "SELECT 1 FROM issue_relations WHERE id = ? AND last_operation_id = ?",
  }[guardKind];
  assert.ok(guardSql, `unsupported event guard ${guardKind}`);
  run(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       actor_credential_id, authorized_via, workspace_id, project_id,
       subject_type, subject_id, payload_json, created_at)
     SELECT ?, 'domain', ?, ?, ?, 'owner', 'cred-owner', 'deployment_owner',
            ?, ?, ?, ?, '{}', ?
     WHERE EXISTS (${guardSql})`,
    [
      `${operationId}-event-${eventIndex}`,
      type,
      operationId,
      eventIndex,
      workspaceId,
      projectId,
      subjectType,
      subjectId,
      now,
      guardId,
      operationId,
    ],
  );
}

run("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES ('owner', 'Lin', ?, ?)", [now, now]);
run("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES ('writer', 'Chen', ?, ?)", [now, now]);
run("INSERT INTO instance_meta VALUES (1, 'instance-1', 'owner', '0.1.0', 1, ?)", [now]);
run("INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id) VALUES ('cred-owner', 'owner', 'owner', ?, ?, 'seed-cred-owner')", [digest("a"), now]);
run("INSERT INTO workspaces (id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('workspace', 'agent-tools', 'Agent Tools', ?, ?, 'owner', 'owner', 'seed-workspace')", [now, now]);
run("INSERT INTO projects (id, workspace_id, key, display_name, issue_limit, comment_limit, principal_limit, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('project-a', 'workspace', 'CORE', 'Core', 10, 1, 10, ?, ?, 'owner', 'owner', 'seed-project-a')", [now, now]);
run("INSERT INTO projects (id, workspace_id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('project-b', 'workspace', 'WEB', 'Web', ?, ?, 'owner', 'owner', 'seed-project-b')", [now, now]);
run("INSERT INTO project_grants (id, principal_id, project_id, role, created_at, updated_at, created_operation_id) VALUES ('grant-a', 'writer', 'project-a', 'writer', ?, ?, 'seed-grant-a')", [now, now]);
run("INSERT INTO project_grants (id, principal_id, project_id, role, created_at, updated_at, created_operation_id) VALUES ('grant-b', 'writer', 'project-b', 'writer', ?, ?, 'seed-grant-b')", [now, now]);
run("INSERT INTO public_join_policies (project_id, public_id, public_summary, enabled_at, enabled_by_principal_id, created_at, updated_at) VALUES ('project-a', 'public-a', 'Public Core', ?, 'owner', ?, ?)", [now, now, now]);
run("INSERT INTO project_usage VALUES ('project-a', 2, 0, 1, ?, 'seed-usage')", [now]);
run("INSERT INTO issues (id, project_id, title, title_search, status_key, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('issue-a1', 'project-a', 'Complete me', 'complete me', 'todo', ?, ?, 'owner', 'owner', 'seed-issue-a1')", [now, now]);
run("INSERT INTO issues (id, project_id, title, title_search, status_key, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('issue-a2', 'project-a', 'Assign me', 'assign me', 'todo', ?, ?, 'owner', 'owner', 'seed-issue-a2')", [now + 1, now + 1]);
run("INSERT INTO issues (id, project_id, title, title_search, status_key, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('issue-b1', 'project-b', 'Related work', 'related work', 'todo', ?, ?, 'owner', 'owner', 'seed-issue-b1')", [now + 2, now + 2]);

// Complete succeeds only when the quota guard, Issue CAS, completion Comment,
// Event, and final commit sentinel all agree on the same operation ID.
atomic(() => {
  const operationId = "op-complete-success";
  run(
    `UPDATE project_usage
     SET active_comment_count = active_comment_count + 1,
         updated_at = ?, last_operation_id = ?
     WHERE project_id = 'project-a'
       AND active_comment_count < (SELECT comment_limit FROM projects WHERE id = 'project-a')`,
    [now, operationId],
  );
  run(
    `UPDATE issues
     SET status_key = 'done', version = version + 1, updated_at = ?,
         updated_by_principal_id = 'writer', last_operation_id = ?
     WHERE id = 'issue-a1' AND version = 1 AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM project_usage WHERE project_id = 'project-a' AND last_operation_id = ?)`,
    [now, operationId, operationId],
  );
  run(
    `INSERT INTO comments
      (id, issue_id, kind, author_principal_id, body, completion_json,
       created_at, created_operation_id, last_operation_id)
     SELECT 'completion-a1', id, 'completion', 'writer', 'Implemented',
            '{"summary":"Implemented"}', ?, ?, ?
     FROM issues WHERE id = 'issue-a1' AND last_operation_id = ?`,
    [now, operationId, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.completed", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-a1" });
  finalize(operationId, "issue", "issue-a1", 1);
});
assert.deepEqual(plain(get("SELECT status_key, version FROM issues WHERE id = 'issue-a1'")), { status_key: "done", version: 2 });
assert.equal(get("SELECT active_comment_count FROM project_usage WHERE project_id = 'project-a'").active_comment_count, 1);
assert.equal(get("SELECT COUNT(*) AS count FROM comments WHERE issue_id = 'issue-a1'").count, 1);

expectAtomicRollback("complete quota rollback", () => {
  const operationId = "op-complete-no-capacity";
  run(
    `UPDATE project_usage
     SET active_comment_count = active_comment_count + 1, last_operation_id = ?
     WHERE project_id = 'project-a'
       AND active_comment_count < (SELECT comment_limit FROM projects WHERE id = 'project-a')`,
    [operationId],
  );
  run(
    `UPDATE issues SET status_key = 'done', version = version + 1, last_operation_id = ?
     WHERE id = 'issue-a2' AND version = 1
       AND EXISTS (SELECT 1 FROM project_usage WHERE project_id = 'project-a' AND last_operation_id = ?)`,
    [operationId, operationId],
  );
  run(
    `INSERT INTO comments
      (id, issue_id, kind, author_principal_id, body, completion_json, created_at, created_operation_id, last_operation_id)
     SELECT 'completion-a2', id, 'completion', 'writer', 'Should not commit',
            '{"summary":"Should not commit"}', ?, ?, ?
     FROM issues WHERE id = 'issue-a2' AND last_operation_id = ?`,
    [now, operationId, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.completed", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-a2" });
  finalize(operationId, "issue", "issue-a2", 1);
});
assert.deepEqual(plain(get("SELECT status_key, version FROM issues WHERE id = 'issue-a2'")), { status_key: "todo", version: 1 });
assert.equal(get("SELECT COUNT(*) AS count FROM comments WHERE issue_id = 'issue-a2'").count, 0);

// A stale concurrent assignment produces no Event, so the final NOT NULL
// sentinel aborts the entire D1 batch rather than committing a partial write.
atomic(() => {
  const operationId = "op-assign-success";
  run(
    `UPDATE issues SET assignee_principal_id = 'writer', version = version + 1,
       updated_at = ?, updated_by_principal_id = 'writer', last_operation_id = ?
     WHERE id = 'issue-a2' AND version = 1
       AND EXISTS (
         SELECT 1 FROM project_grants
         WHERE principal_id = 'writer' AND project_id = issues.project_id
           AND role = 'writer' AND revoked_at IS NULL
       )`,
    [now, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.assigned", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-a2" });
  finalize(operationId, "issue", "issue-a2", 1);
});
expectAtomicRollback("stale assignment rollback", () => {
  const operationId = "op-assign-stale";
  run("UPDATE issues SET assignee_principal_id = 'owner', version = version + 1, last_operation_id = ? WHERE id = 'issue-a2' AND version = 1", [operationId]);
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.assigned", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-a2" });
  finalize(operationId, "issue", "issue-a2", 1);
});
assert.deepEqual(plain(get("SELECT assignee_principal_id, version FROM issues WHERE id = 'issue-a2'")), { assignee_principal_id: "writer", version: 2 });

// A cross-Project Relation requires both writer Grants and both expected
// versions. Both Issue versions and both Project-scoped Events commit together.
atomic(() => {
  const operationId = "op-relation-success";
  run(
    `UPDATE issues SET version = version + 1, last_operation_id = ?
     WHERE id = 'issue-a2' AND version = 2
       AND EXISTS (SELECT 1 FROM project_grants WHERE principal_id = 'writer' AND project_id = issues.project_id AND role = 'writer' AND revoked_at IS NULL)`,
    [operationId],
  );
  run(
    `UPDATE issues SET version = version + 1, last_operation_id = ?
     WHERE id = 'issue-b1' AND version = 1
       AND EXISTS (SELECT 1 FROM project_grants WHERE principal_id = 'writer' AND project_id = issues.project_id AND role = 'writer' AND revoked_at IS NULL)`,
    [operationId],
  );
  run(
    `INSERT INTO issue_relations
      (id, workspace_id, kind, source_issue_id, target_issue_id, created_at,
       created_by_principal_id, created_operation_id, last_operation_id)
     SELECT 'relation-1', 'workspace', 'blocks', 'issue-a2', 'issue-b1', ?, ?, ? ,?
     WHERE (SELECT last_operation_id FROM issues WHERE id = 'issue-a2') = ?
       AND (SELECT last_operation_id FROM issues WHERE id = 'issue-b1') = ?`,
    [now, "writer", operationId, operationId, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "relation.created", workspaceId: "workspace", projectId: "project-a", subjectType: "relation", subjectId: "relation-1", guardKind: "relation" });
  insertDomainEvent({ operationId, eventIndex: 1, type: "relation.created", workspaceId: "workspace", projectId: "project-b", subjectType: "relation", subjectId: "relation-1", guardKind: "relation" });
  finalize(operationId, "relation", "relation-1", 2);
});
assert.equal(get("SELECT COUNT(*) AS count FROM issue_relations WHERE id = 'relation-1'").count, 1);
assert.deepEqual(plain(get("SELECT version FROM issues WHERE id = 'issue-a2'")), { version: 3 });
assert.deepEqual(plain(get("SELECT version FROM issues WHERE id = 'issue-b1'")), { version: 2 });

expectAtomicRollback("relation missing permission rollback", () => {
  const operationId = "op-relation-no-permission";
  run("UPDATE project_grants SET revoked_at = ?, revoked_by_principal_id = 'owner', version = version + 1 WHERE id = 'grant-b'", [now]);
  run("UPDATE issues SET version = version + 1, last_operation_id = ? WHERE id = 'issue-a1' AND version = 2", [operationId]);
  run(
    `UPDATE issues SET version = version + 1, last_operation_id = ?
     WHERE id = 'issue-b1' AND version = 2
       AND EXISTS (SELECT 1 FROM project_grants WHERE principal_id = 'writer' AND project_id = issues.project_id AND role = 'writer' AND revoked_at IS NULL)`,
    [operationId],
  );
  run(
    `INSERT INTO issue_relations
      (id, workspace_id, kind, source_issue_id, target_issue_id, created_at,
       created_by_principal_id, created_operation_id, last_operation_id)
     SELECT 'relation-2', 'workspace', 'related', 'issue-a1', 'issue-b1', ?, 'writer', ?, ?
     WHERE (SELECT last_operation_id FROM issues WHERE id = 'issue-a1') = ?
       AND (SELECT last_operation_id FROM issues WHERE id = 'issue-b1') = ?`,
    [now, operationId, operationId, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "relation.created", workspaceId: "workspace", projectId: "project-a", subjectType: "relation", subjectId: "relation-2", guardKind: "relation" });
  insertDomainEvent({ operationId, eventIndex: 1, type: "relation.created", workspaceId: "workspace", projectId: "project-b", subjectType: "relation", subjectId: "relation-2", guardKind: "relation" });
  finalize(operationId, "relation", "relation-2", 2);
});
assert.equal(get("SELECT COUNT(*) AS count FROM issue_relations WHERE id = 'relation-2'").count, 0);
assert.equal(get("SELECT version FROM issues WHERE id = 'issue-a1'").version, 2);
assert.equal(get("SELECT revoked_at FROM project_grants WHERE id = 'grant-b'").revoked_at, null);

// Public-Join resource limits are Project-local. A limit may be lowered below
// current usage without deleting data; growth is blocked only in that Project.
run("UPDATE projects SET issue_limit = 1, version = version + 1 WHERE id = 'project-a'");
assert.equal(get("SELECT issue_limit FROM projects WHERE id = 'project-a'").issue_limit, 1);
assert.equal(get("SELECT active_issue_count FROM project_usage WHERE project_id = 'project-a'").active_issue_count, 2);
expectAtomicRollback("over-limit issue growth rollback", () => {
  const operationId = "op-issue-over-limit";
  run(
    `UPDATE project_usage SET active_issue_count = active_issue_count + 1,
       last_operation_id = ?
     WHERE project_id = 'project-a'
       AND active_issue_count < (SELECT issue_limit FROM projects WHERE id = 'project-a')`,
    [operationId],
  );
  run(
    `INSERT INTO issues
      (id, project_id, title, title_search, created_at, updated_at,
       created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id)
     SELECT 'issue-over-limit', 'project-a', 'Must not exist', 'must not exist',
            ?, ?, 'writer', 'writer', ?, ?
     WHERE EXISTS (SELECT 1 FROM project_usage WHERE project_id = 'project-a' AND last_operation_id = ?)`,
    [now, now, operationId, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.created", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-over-limit" });
  finalize(operationId, "issue", "issue-over-limit", 1);
});
assert.equal(get("SELECT COUNT(*) AS count FROM issues WHERE id = 'issue-over-limit'").count, 0);
assert.equal(get("SELECT active_issue_count FROM project_usage WHERE project_id = 'project-a'").active_issue_count, 2);

atomic(() => {
  const operationId = "op-free-project-issue";
  run(
    `INSERT INTO issues
      (id, project_id, title, title_search, created_at, updated_at,
       created_by_principal_id, updated_by_principal_id, created_operation_id, last_operation_id)
     SELECT 'issue-b2', 'project-b', 'Independent project', 'independent project',
            ?, ?, 'writer', 'writer', ?, ?
     WHERE EXISTS (
       SELECT 1 FROM project_grants
       WHERE principal_id = 'writer' AND project_id = 'project-b'
         AND role = 'writer' AND revoked_at IS NULL
     )`,
    [now, now, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.created", workspaceId: "workspace", projectId: "project-b", subjectType: "issue", subjectId: "issue-b2" });
  finalize(operationId, "issue", "issue-b2", 1);
});
assert.equal(get("SELECT COUNT(*) AS count FROM issues WHERE id = 'issue-b2'").count, 1);
assert.equal(get("SELECT COUNT(*) AS count FROM project_usage WHERE project_id = 'project-b'").count, 0);

atomic(() => {
  const operationId = "op-soft-delete-a2";
  run(
    `UPDATE project_usage SET active_issue_count = active_issue_count - 1,
       last_operation_id = ?
     WHERE project_id = 'project-a' AND active_issue_count > 0`,
    [operationId],
  );
  run(
    `UPDATE issues SET deleted_at = ?, deleted_by_principal_id = 'writer',
       version = version + 1, last_operation_id = ?
     WHERE id = 'issue-a2' AND version = 3
       AND EXISTS (SELECT 1 FROM project_usage WHERE project_id = 'project-a' AND last_operation_id = ?)`,
    [now, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.deleted", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-a2" });
  finalize(operationId, "issue", "issue-a2", 1);
});
assert.equal(get("SELECT active_issue_count FROM project_usage WHERE project_id = 'project-a'").active_issue_count, 1);
expectAtomicRollback("restore must reoccupy capacity", () => {
  const operationId = "op-restore-no-capacity";
  run(
    `UPDATE project_usage SET active_issue_count = active_issue_count + 1,
       last_operation_id = ?
     WHERE project_id = 'project-a'
       AND active_issue_count < (SELECT issue_limit FROM projects WHERE id = 'project-a')`,
    [operationId],
  );
  run(
    `UPDATE issues SET deleted_at = NULL, deleted_by_principal_id = NULL,
       version = version + 1, last_operation_id = ?
     WHERE id = 'issue-a2' AND version = 4
       AND EXISTS (SELECT 1 FROM project_usage WHERE project_id = 'project-a' AND last_operation_id = ?)`,
    [operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.restored", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-a2" });
  finalize(operationId, "issue", "issue-a2", 1);
});
assert.notEqual(get("SELECT deleted_at FROM issues WHERE id = 'issue-a2'").deleted_at, null);
assert.equal(get("SELECT active_issue_count FROM project_usage WHERE project_id = 'project-a'").active_issue_count, 1);

run("UPDATE public_join_policies SET disabled_at = ?, disabled_by_principal_id = 'owner', version = version + 1 WHERE project_id = 'project-a'", [now]);
run("DELETE FROM project_usage WHERE project_id = 'project-a'");
atomic(() => {
  const operationId = "op-restore-policy-disabled";
  run(
    `UPDATE issues SET deleted_at = NULL, deleted_by_principal_id = NULL,
       version = version + 1, last_operation_id = ?
     WHERE id = 'issue-a2' AND version = 4`,
    [operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "issue.restored", workspaceId: "workspace", projectId: "project-a", subjectType: "issue", subjectId: "issue-a2" });
  finalize(operationId, "issue", "issue-a2", 1);
});
assert.equal(get("SELECT deleted_at FROM issues WHERE id = 'issue-a2'").deleted_at, null);
assert.equal(get("SELECT COUNT(*) AS count FROM project_usage WHERE project_id = 'project-a'").count, 0);

// Invitation redemption creates the Principal, Credential, Grant, immutable
// redemption item, consumption marker, and Events in one transaction.
run(
  `INSERT INTO invitations
    (id, kind, code_prefix, code_digest, expires_at, created_at,
     created_by_owner_principal_id, created_operation_id)
   VALUES ('invite-valid', 'project_grant', 'valid', ?, ?, ?, 'owner', 'seed-invite-valid')`,
  [digest("b"), now + 604800000, now],
);
run("INSERT INTO invitation_project_grants VALUES ('invite-valid', 'project-a', 'writer')");
atomic(() => {
  const operationId = "op-invite-redeem";
  run(
    `INSERT INTO principals (id, display_name, created_at, updated_at, last_operation_id)
     SELECT 'invitee', 'Alex', ?, ?, ? FROM invitations
     WHERE id = 'invite-valid' AND expires_at > ? AND revoked_at IS NULL AND redeemed_at IS NULL`,
    [now, now, operationId, now],
  );
  run(
    `INSERT INTO credentials
      (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id, last_operation_id)
     SELECT 'cred-invitee', id, 'invitee', ?, ?, ?, ?
     FROM principals WHERE id = 'invitee' AND last_operation_id = ?`,
    [digest("c"), now, operationId, operationId, operationId],
  );
  run(
    `INSERT INTO project_grants
      (id, principal_id, project_id, role, created_at, updated_at, created_operation_id, last_operation_id)
     SELECT 'grant-invitee', 'invitee', project_id, role, ?, ?, ?, ?
     FROM invitation_project_grants
     WHERE invitation_id = 'invite-valid'
       AND EXISTS (SELECT 1 FROM credentials WHERE id = 'cred-invitee' AND last_operation_id = ?)`,
    [now, now, operationId, operationId, operationId],
  );
  run(
    `INSERT INTO invitation_redemption_items
      (invitation_id, project_id, operation_id, outcome, effective_role)
     SELECT 'invite-valid', project_id, ?, 'created', role
     FROM invitation_project_grants
     WHERE invitation_id = 'invite-valid'
       AND EXISTS (SELECT 1 FROM project_grants WHERE id = 'grant-invitee' AND last_operation_id = ?)`,
    [operationId, operationId],
  );
  run(
    `UPDATE invitations SET redeemed_at = ?, redeemed_by_principal_id = 'invitee', last_operation_id = ?
     WHERE id = 'invite-valid'
       AND EXISTS (SELECT 1 FROM invitation_redemption_items WHERE invitation_id = 'invite-valid' AND operation_id = ?)`,
    [now, operationId, operationId],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "grant.created", workspaceId: "workspace", projectId: "project-a", subjectType: "grant", subjectId: "grant-invitee", guardKind: "invitation", guardId: "invite-valid" });
  run(
    `INSERT INTO events
      (id, stream, type, operation_id, event_index, actor_principal_id,
       authorized_via, subject_type, subject_id, payload_json, created_at)
     SELECT ?, 'security', 'invitation.redeemed', ?, 1, 'invitee', 'invitation',
            'invitation', 'invite-valid', '{}', ?
     WHERE EXISTS (SELECT 1 FROM invitations WHERE id = 'invite-valid' AND last_operation_id = ?)`,
    [`${operationId}-event-1`, operationId, now, operationId],
  );
  finalize(operationId, "invitation", "invite-valid", 2);
});
assert.equal(get("SELECT COUNT(*) AS count FROM principals WHERE id = 'invitee'").count, 1);
assert.equal(get("SELECT COUNT(*) AS count FROM operation_commits WHERE operation_id = 'op-invite-redeem'").count, 1, "response-loss retry can probe the commit");
assert.deepEqual(plain(get("SELECT outcome, effective_role FROM invitation_redemption_items WHERE invitation_id = 'invite-valid'")), { outcome: "created", effective_role: "writer" });

run(
  `INSERT INTO invitations
    (id, kind, code_prefix, code_digest, expires_at, created_at,
     created_by_owner_principal_id, created_operation_id)
   VALUES ('invite-expired', 'project_grant', 'expired', ?, ?, ?, 'owner', 'seed-invite-expired')`,
  [digest("d"), now - 1, now - 1000],
);
run("INSERT INTO invitation_project_grants VALUES ('invite-expired', 'project-a', 'reader')");
expectAtomicRollback("expired invitation leaves no identity", () => {
  const operationId = "op-invite-expired";
  run(
    `INSERT INTO principals (id, display_name, created_at, updated_at, last_operation_id)
     SELECT 'orphan', 'Orphan', ?, ?, ? FROM invitations
     WHERE id = 'invite-expired' AND expires_at > ? AND revoked_at IS NULL AND redeemed_at IS NULL`,
    [now, now, operationId, now],
  );
  insertDomainEvent({ operationId, eventIndex: 0, type: "grant.created", workspaceId: "workspace", projectId: "project-a", subjectType: "principal", subjectId: "orphan", guardKind: "invitation", guardId: "invite-expired" });
  finalize(operationId, "principal", "orphan", 1);
});
assert.equal(get("SELECT COUNT(*) AS count FROM principals WHERE id = 'orphan'").count, 0);

console.log("D1 atomic operation checks passed for complete, concurrent assignment, cross-Project relation, Project-local quota growth/release/disable, invitation redemption, rollback, and response-loss probing.");
