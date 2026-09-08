import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";

const server = createTestHarness({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});
const ownerToken = `cfk_v1_owner_${"A".repeat(43)}`;
const memberToken = `cfk_v1_member_${"M".repeat(43)}`;
const ownerId = randomUUID();
const credentialId = randomUUID();
const memberId = randomUUID();
let db;

async function request(path, { method = "GET", body, token = ownerToken, key = randomUUID(), headers = {} } = {}) {
  const response = await server.fetch(path, {
    method,
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method !== "GET" ? { "idempotency-key": key } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function write(path, body, method = "POST") {
  const result = await request(method === "DELETE" ? `${path}?expected_version=${body.expected_version}` : path, { method, body: method === "DELETE" ? undefined : body });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.resource;
}
async function preview(path) {
  const result = await request(`${path}/purge-preview`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
function confirmation(value) {
  return { expected_version: value.target.version, confirm_name: value.target.display_name, preview_digest: value.preview_digest };
}
async function fixture(key) {
  const workspace = await write("/api/v1/workspaces", { display_name: `Workspace ${key}` });
  const path = `/api/v1/workspaces/${workspace.id}`;
  const project = await write(`${path}/projects`, { display_name: `Sensitive ${key}` });
  return { workspace, project, path: `${path}/projects/${project.id}`, workspacePath: path };
}
async function seedIssue(projectId, title) {
  const id = randomUUID();
  await db.prepare(`INSERT INTO issues (id, project_id, title, title_search, body, created_at, updated_at,
    created_by_principal_id, updated_by_principal_id, created_operation_id)
    VALUES (?1, ?2, ?3, ?3, ?3, ?4, ?4, ?5, ?5, ?6)`)
    .bind(id, projectId, title, Date.now(), ownerId, randomUUID()).run();
  return await db.prepare("SELECT * FROM issues WHERE id = ?1").bind(id).first();
}

before(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, {
    instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: credentialId,
    ownerCredentialToken: ownerToken, ownerDisplayName: "Purge test Owner", ownerPrincipalId: ownerId,
    preferredApiOrigin: "https://purge.example.test",
  });
  const now = Date.now();
  await db.prepare("INSERT INTO principals (id, display_name, created_at, updated_at) VALUES (?1, 'Member', ?2, ?2)")
    .bind(memberId, now).run();
  await db.prepare(`INSERT INTO credentials (id, principal_id, token_prefix, token_digest, issued_at, created_operation_id)
    VALUES (?1, ?2, 'member', ?3, ?4, ?5)`).bind(randomUUID(), memberId, await sha256Hex(memberToken), now, randomUUID()).run();
});
after(async () => { await server.close(); });

test("purge requires Owner, archive, exact confirmation and an unchanged preview", async () => {
  const f = await fixture("purge-guards");
  await db.prepare(`INSERT INTO project_grants (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
    VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`).bind(randomUUID(), memberId, f.project.id, Date.now(), randomUUID()).run();
  for (const token of [null, memberToken]) {
    const result = await request(`${f.path}/purge-preview`, { token });
    assert.equal(result.status, token ? 403 : 401);
    const mutation = await request(`${f.path}/commands/purge`, { token, method: "POST", body: { expected_version: 1, confirm_name: f.project.display_name, preview_digest: "0".repeat(64) } });
    assert.equal(mutation.status, token ? 403 : 401);
  }
  const active = await preview(f.path);
  assert.equal(active.can_purge, false);
  assert.equal(active.blocking_reason, "ARCHIVE_REQUIRED");
  assert.equal((await request(`${f.path}/commands/purge`, { method: "POST", body: confirmation(active) })).status, 409);
  await write(f.path, { expected_version: f.project.version }, "DELETE");
  const ready = await preview(f.path);
  assert.equal(ready.can_purge, true);
  for (const change of [{ confirm_name: "Wrong name" }, { expected_version: 999 }, { preview_digest: "0".repeat(64) }]) {
    const result = await request(`${f.path}/commands/purge`, { method: "POST", body: { ...confirmation(ready), ...change } });
    assert.ok([400, 409, 422].includes(result.status), JSON.stringify(result));
  }
  await seedIssue(f.project.id, "Content added after preview");
  assert.equal((await request(`${f.path}/commands/purge`, { method: "POST", body: confirmation(ready) })).status, 409);
  const fresh = await preview(f.path);
  await write(`${f.path}/commands/restore`, { expected_version: fresh.target.version });
  assert.equal((await request(`${f.path}/commands/purge`, { method: "POST", body: confirmation(fresh) })).status, 409);
  await write(f.workspacePath, { expected_version: f.workspace.version }, "DELETE");
  const nonempty = await preview(f.workspacePath);
  assert.equal(nonempty.can_purge, false);
  assert.equal(nonempty.blocking_reason, "WORKSPACE_NOT_EMPTY");
  assert.equal((await request(`${f.workspacePath}/commands/purge`, { method: "POST", body: confirmation(nonempty) })).status, 409);
});

test("project purge atomically removes content and snapshots, preserves peers, and replays", async () => {
  const f = await fixture("purge-content");
  const peer = await write(`${f.workspacePath}/projects`, { display_name: "Keep this project" });
  const targetIssue = await seedIssue(f.project.id, "PURGE_PRIVATE_CONTENT");
  const peerIssue = await seedIssue(peer.id, "Keep this issue");
  const now = Date.now();
  const relationId = randomUUID();
  const inviteId = randomUUID();
  const labelId = randomUUID();
  const operationId = randomUUID();
  const target = JSON.stringify({ kind: "project", project_id: f.project.id, workspace_id: f.workspace.id, entry_path: `/app/w/${f.workspace.id}/p/${f.project.id}` });
  await db.batch([
    ...["standard", "completion"].map((kind) => db.prepare(`INSERT INTO comments
      (id, issue_id, kind, author_principal_id, body, completion_json, created_at, created_operation_id)
      VALUES (?1, ?2, ?3, ?4, 'PURGE_PRIVATE_CONTENT', ?5, ?6, ?7)`)
      .bind(randomUUID(), targetIssue.id, kind, ownerId, kind === "completion" ? '{"summary":"PURGE_PRIVATE_CONTENT"}' : null, now, randomUUID())),
    db.prepare(`INSERT INTO labels (id, project_id, name, created_at, updated_at, created_by_principal_id, updated_by_principal_id, created_operation_id)
      VALUES (?1, ?2, 'Secret label', ?3, ?3, ?4, ?4, ?5)`).bind(labelId, f.project.id, now, ownerId, randomUUID()),
    db.prepare("INSERT INTO issue_labels VALUES (?1, ?2, ?3, ?4, ?5)").bind(targetIssue.id, labelId, now, ownerId, randomUUID()),
    db.prepare(`INSERT INTO issue_relations (id, workspace_id, kind, source_issue_id, target_issue_id, source_project_id, target_project_id, created_at, created_by_principal_id, created_operation_id)
      VALUES (?1, ?2, 'related', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(relationId, f.workspace.id, targetIssue.id, peerIssue.id, f.project.id, peer.id, now, ownerId, operationId),
    ...[f.project.id, peer.id].map((id) => db.prepare(`INSERT INTO project_grants (id, principal_id, project_id, role, created_at, updated_at, created_operation_id)
      VALUES (?1, ?2, ?3, 'writer', ?4, ?4, ?5)`).bind(randomUUID(), memberId, id, now, randomUUID())),
    db.prepare(`INSERT INTO invitations (id, kind, code_prefix, code_digest, expires_at, created_at, created_by_owner_principal_id, created_operation_id)
      VALUES (?1, 'project_grant', 'dummy', ?2, ?3, ?4, ?5, ?6)`).bind(inviteId, "1".repeat(64), now + 86400000, now, ownerId, randomUUID()),
    ...[f.project.id, peer.id].map((id) => db.prepare("INSERT INTO invitation_project_grants VALUES (?1, ?2, 'writer')").bind(inviteId, id)),
    ...[f.project.id, peer.id].map((id) => db.prepare("INSERT INTO invitation_redemption_items VALUES (?1, ?2, ?3, 'created', 'writer')").bind(inviteId, id, randomUUID())),
    db.prepare(`INSERT INTO browser_launches (id, code_prefix, code_digest, principal_id, source_credential_id, target_kind, target_json, expires_at, created_at, created_operation_id)
      VALUES (?1, 'dummy', ?2, ?3, ?4, 'project', ?5, ?6, ?7, ?8)`).bind(randomUUID(), "2".repeat(64), ownerId, credentialId, target, now + 300000, now, randomUUID()),
    db.prepare(`INSERT INTO web_sessions (id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, created_at)
      VALUES (?1, ?2, ?3, 'credential', ?4, 'project', ?5, ?6, ?7)`).bind(randomUUID(), "3".repeat(64), ownerId, credentialId, target, now + 28800000, now),
    db.prepare(`INSERT INTO events (id, stream, type, operation_id, event_index, actor_principal_id, authorized_via, workspace_id, project_id, relation_other_project_id, subject_type, subject_id, payload_json, created_at)
      VALUES (?1, 'domain', 'relation.created', ?2, 0, ?3, 'deployment_owner', ?4, ?5, ?6, 'relation', ?7, '{"body":"PURGE_PRIVATE_CONTENT"}', ?8)`)
      .bind(randomUUID(), operationId, ownerId, f.workspace.id, peer.id, f.project.id, relationId, now),
    db.prepare(`INSERT INTO operation_commits VALUES (?1, 'relation', ?2, 1, ?3)`).bind(operationId, relationId, now),
    db.prepare(`INSERT INTO idempotency_records (id, scope_key, method, route_template, resource_scope_hash, idempotency_key, request_hash, operation_id, state, response_status, response_json, created_at, expires_at)
      VALUES (?1, 'test', 'POST', '/relations', ?2, 'purge-old-response', ?2, ?3, 'committed', 200, '{"body":"PURGE_PRIVATE_CONTENT"}', ?4, ?5)`)
      .bind(randomUUID(), "4".repeat(64), operationId, now, now + 86400000),
  ]);
  await write(f.path, { expected_version: f.project.version }, "DELETE");
  const ready = await preview(f.path);
  for (const [key, count] of Object.entries({ issues: 1, comments: 2, labels: 1, relations: 1, cross_project_relations: 1, grants: 1, invitations: 1, shared_invitations: 1, browser_launches: 1, web_sessions: 1 })) {
    assert.equal(ready.counts[key], count, key);
  }
  const input = { method: "POST", key: "purge-content-operation", body: confirmation(ready) };
  await db.prepare("CREATE TRIGGER fail_purge_test BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'injected purge rollback'); END").run();
  const failed = await request(`${f.path}/commands/purge`, input);
  assert.ok(failed.status >= 400);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?1").bind(targetIssue.id).first()).n, 2);
  assert.equal((await db.prepare("SELECT purged_at FROM projects WHERE id = ?1").bind(f.project.id).first()).purged_at, null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM issue_relations WHERE id = ?1").bind(relationId).first()).n, 1);
  await db.prepare("DROP TRIGGER fail_purge_test").run();
  const purged = await request(`${f.path}/commands/purge`, input);
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.equal(purged.body.resource.purged, true);
  const replay = await request(`${f.path}/commands/purge`, input);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.idempotent_replay, true);
  assert.deepEqual(replay.body.resource, purged.body.resource);
  for (const [table, column, id] of [["issues", "project_id", f.project.id], ["comments", "issue_id", targetIssue.id], ["labels", "project_id", f.project.id], ["issue_labels", "issue_id", targetIssue.id], ["issue_relations", "id", relationId], ["project_grants", "project_id", f.project.id], ["project_status_names", "project_id", f.project.id], ["public_join_policies", "project_id", f.project.id], ["project_usage", "project_id", f.project.id], ["invitation_project_grants", "project_id", f.project.id], ["invitation_redemption_items", "project_id", f.project.id], ["operation_commits", "operation_id", operationId], ["idempotency_records", "operation_id", operationId]]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?1`).bind(id).first()).n, 0, table);
  }
  for (const table of ["browser_launches", "web_sessions"]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE json_extract(target_json, '$.project_id') = ?1`).bind(f.project.id).first()).n, 0);
  }
  assert.ok((await db.prepare("SELECT revoked_at FROM invitations WHERE id = ?1").bind(inviteId).first()).revoked_at);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM invitation_project_grants WHERE invitation_id = ?1 AND project_id = ?2").bind(inviteId, peer.id).first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM project_grants WHERE project_id = ?1").bind(peer.id).first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM invitation_redemption_items WHERE invitation_id = ?1 AND project_id = ?2").bind(inviteId, peer.id).first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM idempotency_records WHERE response_json LIKE '%PURGE_PRIVATE_CONTENT%' OR operation_snapshot_json LIKE '%PURGE_PRIVATE_CONTENT%'").first()).n, 0);
  assert.ok(await db.prepare("SELECT id FROM issues WHERE id = ?1").bind(peerIssue.id).first());
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE payload_json LIKE '%PURGE_PRIVATE_CONTENT%'").first()).n, 0);
  const minimal = await db.prepare("SELECT * FROM projects WHERE id = ?1").bind(f.project.id).first();
  assert.ok(minimal.purged_at);
  assert.notEqual(minimal.display_name, f.project.display_name);
  assert.equal(minimal.context, null);
  for (const query of ["", "?deleted=only"]) {
    const list = await request(`${f.workspacePath}/projects${query}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.some((item) => item.id === f.project.id), false);
  }
  assert.equal((await request(f.path)).status, 404);
  assert.equal((await request(`${f.path}/commands/restore`, { method: "POST", body: { expected_version: minimal.version } })).status, 404);
  assert.equal((await request(`${f.workspacePath}/projects`, { method: "POST", body: { display_name: f.project.display_name } })).status, 200);
  const next = await seedIssue(peer.id, "Next issue");
  assert.ok(next.number > targetIssue.number && next.number > peerIssue.number);
});

test("archived workspace containing only purged project records can be permanently removed", async () => {
  const f = await fixture("purge-workspace");
  await write(f.path, { expected_version: f.project.version }, "DELETE");
  await write(`${f.path}/commands/purge`, confirmation(await preview(f.path)));
  await write(f.workspacePath, { expected_version: f.workspace.version }, "DELETE");
  const ready = await preview(f.workspacePath);
  assert.equal(ready.can_purge, true);
  assert.equal(ready.counts.projects, 0);
  const input = { method: "POST", key: "purge-workspace-operation", body: confirmation(ready) };
  const result = await request(`${f.workspacePath}/commands/purge`, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.resource.purged, true);
  assert.equal((await request(`${f.workspacePath}/commands/purge`, input)).body.idempotent_replay, true);
  assert.equal((await request(`${f.workspacePath}/commands/restore`, { method: "POST", body: { expected_version: result.body.resource.version } })).status, 404);
  for (const query of ["", "?deleted=only"]) {
    const list = await request(`/api/v1/workspaces${query}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.some((item) => item.id === f.workspace.id), false);
  }
  assert.equal((await request("/api/v1/workspaces", { method: "POST", body: { display_name: f.workspace.display_name } })).status, 200);
});


test("Owner admin cookie purge requires same-origin double-submit CSRF", async () => {
  const f = await fixture("purge-cookie");
  await write(f.path, { expected_version: f.project.version }, "DELETE");
  const sessionToken = "S".repeat(43);
  const csrfToken = "C".repeat(43);
  const now = Date.now();
  await db.prepare(`INSERT INTO web_sessions (id, token_digest, principal_id, source_kind, source_id, target_kind, target_json, expires_at, created_at)
    VALUES (?1, ?2, ?3, 'credential', ?4, 'admin', ?5, ?6, ?7)`)
    .bind(randomUUID(), await sha256Hex(sessionToken), ownerId, credentialId,
      JSON.stringify({ kind: "admin", entry_path: "/app/admin", section: "overview" }), now + 28800000, now).run();
  const cookie = `cfkanban_session=${sessionToken}; cfkanban_csrf=${csrfToken}`;
  const read = await request(`${f.path}/purge-preview`, { token: null, headers: { cookie } });
  assert.equal(read.status, 200);
  const body = confirmation(read.body);
  const discovery = await request("/.well-known/cfkanban-instance.json", { token: null });
  const origin = discovery.body.observed_origin;
  for (const headers of [{ cookie, origin }, { cookie, origin: "https://evil.example.test", "x-csrf-token": csrfToken }, { cookie, origin, "x-csrf-token": "wrong" }]) {
    const refused = await request(`${f.path}/commands/purge`, { token: null, method: "POST", body, headers });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  }
  const accepted = await request(`${f.path}/commands/purge`, { token: null, method: "POST", body, headers: { cookie, origin, "x-csrf-token": csrfToken } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.resource.purged, true);
});
