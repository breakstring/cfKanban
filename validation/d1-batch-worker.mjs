const now = 1_787_966_400_000;
const digest = (character) => character.repeat(64);

async function seed(db) {
  await db.batch([
    db.prepare("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES ('owner', 'Lin', ?, ?)").bind(now, now),
    db.prepare("INSERT INTO instance_meta VALUES (1, 'instance-batch', 'owner', '0.1.0', 1, ?)").bind(now),
    db.prepare("INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id) VALUES ('cred-owner', 'owner', 'owner', ?, ?, 'seed-cred')").bind(digest("a"), now),
    db.prepare("INSERT INTO workspaces (id, key, display_name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('workspace', 'validation', 'Validation', ?, ?, 'owner', 'owner', 'seed-workspace')").bind(now, now),
    db.prepare("INSERT INTO projects (id, workspace_id, key, display_name, issue_limit, comment_limit, principal_limit, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('project', 'workspace', 'CORE', 'Core', 10, 1, 10, ?, ?, 'owner', 'owner', 'seed-project')").bind(now, now),
    db.prepare("INSERT INTO public_join_policies (project_id, public_id, public_summary, enabled_at, enabled_by_principal_id, created_at, updated_at) VALUES ('project', 'public', 'Public', ?, 'owner', ?, ?)").bind(now, now, now),
    db.prepare("INSERT INTO project_usage VALUES ('project', 2, 0, 0, ?, 'seed-usage')").bind(now),
    db.prepare("INSERT INTO issues (id, project_id, title, title_search, status_key, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('issue-1', 'project', 'First', 'first', 'todo', ?, ?, 'owner', 'owner', 'seed-issue-1')").bind(now, now),
    db.prepare("INSERT INTO issues (id, project_id, title, title_search, status_key, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id) VALUES ('issue-2', 'project', 'Second', 'second', 'todo', ?, ?, 'owner', 'owner', 'seed-issue-2')").bind(now + 1, now + 1),
  ]);
}

async function complete(db, issueId, expectedVersion, operationId, commentId) {
  return db.batch([
    db.prepare(
      `UPDATE project_usage
       SET active_comment_count = active_comment_count + 1,
           updated_at = ?, last_operation_id = ?
       WHERE project_id = 'project'
         AND active_comment_count < (SELECT comment_limit FROM projects WHERE id = 'project')`,
    ).bind(now, operationId),
    db.prepare(
      `UPDATE issues
       SET status_key = 'done', version = version + 1, updated_at = ?,
           updated_by_principal_id = 'owner', last_operation_id = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM project_usage WHERE project_id = 'project' AND last_operation_id = ?)`,
    ).bind(now, operationId, issueId, expectedVersion, operationId),
    db.prepare(
      `INSERT INTO comments
        (id, issue_id, kind, author_principal_id, body, completion_json,
         created_at, created_operation_id, last_operation_id)
       SELECT ?, id, 'completion', 'owner', 'Done', '{"summary":"Done"}', ?, ?, ?
       FROM issues WHERE id = ? AND last_operation_id = ?`,
    ).bind(commentId, now, operationId, operationId, issueId, operationId),
    db.prepare(
      `INSERT INTO events
        (id, stream, type, operation_id, event_index, actor_principal_id,
         actor_credential_id, authorized_via, workspace_id, project_id,
         subject_type, subject_id, payload_json, created_at)
       SELECT ?, 'domain', 'issue.completed', ?, 0, 'owner', 'cred-owner',
              'deployment_owner', 'workspace', 'project', 'issue', ?, '{}', ?
       WHERE EXISTS (SELECT 1 FROM comments WHERE id = ? AND last_operation_id = ?)`,
    ).bind(`${operationId}-event`, operationId, issueId, now, commentId, operationId),
    db.prepare(
      `INSERT INTO operation_commits
        (operation_id, primary_subject_type, primary_subject_id, last_event_sequence, committed_at)
       VALUES (?, 'issue', ?, (
         SELECT CASE WHEN COUNT(*) = 1 THEN MAX(sequence) END
         FROM events WHERE operation_id = ?
       ), ?)`,
    ).bind(operationId, issueId, operationId, now),
  ]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/validate") return new Response("Not found", { status: 404 });

    await seed(env.DB);
    await complete(env.DB, "issue-1", 1, "op-success", "completion-1");

    let rejected = false;
    try {
      await complete(env.DB, "issue-2", 1, "op-no-capacity", "completion-2");
    } catch {
      rejected = true;
    }

    const state = await env.DB.prepare(
      `SELECT
        (SELECT status_key FROM issues WHERE id = 'issue-1') AS first_status,
        (SELECT status_key FROM issues WHERE id = 'issue-2') AS second_status,
        (SELECT active_comment_count FROM project_usage WHERE project_id = 'project') AS comment_count,
        (SELECT COUNT(*) FROM comments WHERE id = 'completion-2') AS failed_comment_count,
        (SELECT COUNT(*) FROM operation_commits WHERE operation_id = 'op-success') AS success_commit_count,
        (SELECT COUNT(*) FROM operation_commits WHERE operation_id = 'op-no-capacity') AS failed_commit_count`,
    ).first();

    return Response.json({ rejected, ...state });
  },
};
