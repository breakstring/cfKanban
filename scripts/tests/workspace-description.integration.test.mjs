import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { updateWorkspace } from "../../apps/worker/src/services/containers.ts";

const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const owner = { id: randomUUID(), token: `cfk_v1_owner_${"A".repeat(43)}` };
const workspaceAdmin = { id: randomUUID(), token: `cfk_v1_workspace_${"B".repeat(43)}` };
const projectAdmin = { id: randomUUID(), token: `cfk_v1_project_${"C".repeat(43)}` };
const reader = { id: randomUUID(), token: `cfk_v1_reader_${"D".repeat(43)}` };
let db;
async function request(actor, path, method = "GET", body, key = randomUUID()) {
  const response = await server.fetch(path, { method, headers: { authorization: `Bearer ${actor.token}`, "content-type": "application/json", "idempotency-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function success(result) { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.resource ?? result.body; }
async function administrator(actor, workspaceId, projectId = null) {
  const id = randomUUID();
  await db.prepare("INSERT INTO scoped_administrator_grants (id,principal_id,workspace_id,project_id,version,generation,created_at,updated_at,created_operation_id,last_operation_id) VALUES (?1,?2,?3,?4,1,?5,?6,?6,?7,?7)")
    .bind(id, actor.id, workspaceId, projectId, randomUUID(), Date.now(), randomUUID()).run();
  return id;
}
before(async () => {
  await server.listen();
  const worker = server.getWorker(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: randomUUID(), ownerCredentialToken: owner.token, ownerDisplayName: "Deployment_Owner", ownerPrincipalId: owner.id, preferredApiOrigin: "https://kanban.example.test" });
  for (const [actor, name] of [[workspaceAdmin, "Workspace_Admin"], [projectAdmin, "Project_Admin"], [reader, "Reader"]]) {
    await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)").bind(actor.id, name, name.toLowerCase(), Date.now()).run();
    await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)").bind(randomUUID(), actor.id, actor.token.split("_")[2], await sha256Hex(actor.token), Date.now(), randomUUID()).run();
  }
});
after(async () => server.close());

test("工作区描述创建保持原文、可空及精确幂等快照", async () => {
  const emptyKey = randomUUID();
  const emptyBody = { display_name: "Default description" };
  const empty = success(await request(owner, "/api/v1/workspaces", "POST", emptyBody, emptyKey));
  assert.equal(empty.description, null);
  const legacy = await db.prepare("SELECT operation_id,response_json FROM idempotency_records WHERE operation_id=(SELECT created_operation_id FROM workspaces WHERE id=?1)").bind(empty.id).first();
  const oldResponse = JSON.parse(legacy.response_json);
  delete oldResponse.resource.description;
  await db.prepare("UPDATE idempotency_records SET response_json=?1 WHERE operation_id=?2").bind(JSON.stringify(oldResponse), legacy.operation_id).run();
  success(await request(owner, `/api/v1/workspaces/${empty.id}`, "PATCH", { description: "Current description differs from the original snapshot", expected_version: empty.version }));
  const oldReplay = await request(owner, "/api/v1/workspaces", "POST", emptyBody, emptyKey);
  assert.equal(oldReplay.body.idempotent_replay, true);
  assert.equal(oldReplay.body.resource.description, null);
  assert.equal(oldReplay.body.resource.version, 1);
  const key = randomUUID();
  const body = { display_name: "Described", description: "  团队目标\n\n<untrusted>  " };
  const created = success(await request(owner, "/api/v1/workspaces", "POST", body, key));
  assert.equal(created.description, body.description);
  const replay = await request(owner, "/api/v1/workspaces", "POST", body, key);
  assert.equal(replay.body.idempotent_replay, true);
  assert.deepEqual(replay.body.resource, created);
  assert.equal((await request(owner, "/api/v1/workspaces", "POST", { ...body, description: "Changed" }, key)).status, 409);
  const list = success(await request(owner, "/api/v1/workspaces"));
  assert.equal(list.items.find(item => item.id === created.id).description, body.description);
  for (const description of [true, 1, {}, "界".repeat(10923)]) {
    assert.equal((await request(owner, "/api/v1/workspaces", "POST", { display_name: "Rejected", description })).status, 400);
  }
  const maximum = "界".repeat(10922) + "ab";
  assert.equal(Buffer.byteLength(maximum), 32768);
  assert.equal(success(await request(owner, "/api/v1/workspaces", "POST", { display_name: "Maximum", description: maximum })).description, maximum);
});

test("工作区描述 PATCH 独立更新、遗漏保持、null清空且CAS失败不写审计", async () => {
  let workspace = success(await request(owner, "/api/v1/workspaces", "POST", { display_name: "Patch", description: "Original" }));
  const path = `/api/v1/workspaces/${workspace.id}`;
  workspace = success(await request(owner, path, "PATCH", { description: "  更新\n", expected_version: workspace.version }));
  assert.equal(workspace.display_name, "Patch");
  assert.equal(workspace.description, "  更新\n");
  workspace = success(await request(owner, path, "PATCH", { display_name: "Renamed", expected_version: workspace.version }));
  assert.equal(workspace.description, "  更新\n");
  const eventCount = await db.prepare("SELECT COUNT(*) AS count FROM events WHERE subject_id=?1").bind(workspace.id).first();
  for (const [body, status] of [
    [{ description: "Stale", expected_version: 1 }, 409],
    [{ expected_version: workspace.version }, 400],
    [{ description: 1, expected_version: workspace.version }, 400],
    [{ description: "界".repeat(10923), expected_version: workspace.version }, 400],
    [{ description: null }, 400],
  ]) assert.equal((await request(owner, path, "PATCH", body)).status, status);
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS count FROM events WHERE subject_id=?1").bind(workspace.id).first(), eventCount);
  assert.equal(success(await request(owner, path)).version, workspace.version);
  workspace = success(await request(owner, path, "PATCH", { description: "", expected_version: workspace.version }));
  assert.equal(workspace.description, "");
  workspace = success(await request(owner, path, "PATCH", { description: null, expected_version: workspace.version }));
  assert.equal(workspace.description, null);
  assert.equal(success(await request(owner, path)).description, null);
  const event = await db.prepare("SELECT payload_json FROM events WHERE subject_id=?1 AND type='workspace.updated' ORDER BY sequence DESC LIMIT 1").bind(workspace.id).first();
  assert.deepEqual(JSON.parse(event.payload_json), { description_changed: true });
});

test("工作区管理权限与事务提交前撤权保护描述和审计", async () => {
  const workspace = success(await request(owner, "/api/v1/workspaces", "POST", { display_name: "Scoped", description: "Visible" }));
  const path = `/api/v1/workspaces/${workspace.id}`;
  const project = success(await request(owner, `${path}/projects`, "POST", { display_name: "Readable" }));
  const grant = await administrator(workspaceAdmin, workspace.id);
  await administrator(projectAdmin, workspace.id, project.id);
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES (?1,?2,?3,'reader',?4,?4,?5)").bind(randomUUID(), reader.id, project.id, Date.now(), randomUUID()).run();
  for (const actor of [reader, projectAdmin]) {
    const visible = success(await request(actor, path));
    assert.equal(visible.description, "Visible");
    assert.ok(!visible.allowed_actions.includes("update"));
    assert.equal((await request(actor, path, "PATCH", { description: "Denied", expected_version: workspace.version })).status, 403);
  }
  const updated = success(await request(workspaceAdmin, path, "PATCH", { description: "Managed", expected_version: workspace.version }));
  const event = await db.prepare("SELECT authorized_via,administrator_grant_id FROM events WHERE subject_id=?1 AND type='workspace.updated'").bind(workspace.id).first();
  assert.equal(event.authorized_via, "workspace_admin"); assert.equal(event.administrator_grant_id, grant);
  const auth = await authenticateBearer(db, `Bearer ${workspaceAdmin.token}`);
  let revoked = false;
  const raced = new Proxy(db, { get(target, property) {
    if (property === "batch") return async statements => {
      if (!revoked) { revoked = true; await target.prepare("UPDATE scoped_administrator_grants SET revoked_at=?1 WHERE id=?2").bind(Date.now(), grant).run(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(updateWorkspace(raced, auth, workspace.id, undefined, "Revoked", updated.version, Date.now()), error => error.status === 404);
  const after = success(await request(owner, path));
  assert.equal(after.description, "Managed"); assert.equal(after.version, updated.version);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM events WHERE subject_id=?1 AND type='workspace.updated'").bind(workspace.id).first()).count, 1);
});

test("审计写入失败时工作区描述与版本在同一事务内回滚", async () => {
  const workspace = success(await request(owner, "/api/v1/workspaces", "POST", { display_name: "Atomic", description: "Before" }));
  await db.prepare("CREATE TRIGGER workspace_description_test_audit_failure BEFORE INSERT ON events WHEN NEW.type='workspace.updated' BEGIN SELECT RAISE(ABORT,'isolated audit failure'); END").run();
  try {
    const response = await request(owner, `/api/v1/workspaces/${workspace.id}`, "PATCH", { description: "After", expected_version: workspace.version });
    assert.equal(response.status, 503);
    const row = await db.prepare("SELECT description,version FROM workspaces WHERE id=?1").bind(workspace.id).first();
    assert.deepEqual(row, { description: "Before", version: workspace.version });
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM events WHERE subject_id=?1 AND type='workspace.updated'").bind(workspace.id).first()).count, 0);
  } finally { await db.prepare("DROP TRIGGER workspace_description_test_audit_failure").run(); }
});
