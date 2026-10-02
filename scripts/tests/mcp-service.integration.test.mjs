import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { createMcpFacade } from "../../packages/skill-runtime/src/mcp-facade.mjs";
import { loadCurrentCredentialSecret } from "../../packages/skill-runtime/src/state.mjs";
import { createMcpStateFixture } from "./mcp-fixture.mjs";

test("MCP uses the real isolated Worker for scoped collaboration, CAS, replay and uncertain writes", async t => {
  const fixture = await createMcpStateFixture(t);
  const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
  t.after(() => server.close());
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  const { DB: db } = await worker.getEnv();
  const current = await loadCurrentCredentialSecret(fixture);
  await bootstrapInstance(db, { instanceId: fixture.instanceId, operationId: randomUUID(), ownerCredentialId: current.metadata.credential_id, ownerCredentialToken: current.token, ownerDisplayName: "MCP_Owner", ownerPrincipalId: fixture.principalId, preferredApiOrigin: fixture.origin });
  const fetchImpl = (url, init) => {
    assert.equal(new URL(url).origin, fixture.origin, "fixture must never reach an external network");
    return worker.fetch(url.toString(), init);
  };
  const rawWrite = async (pathname, body) => {
    const response = await fetchImpl(new URL(pathname, fixture.origin), { method: "POST", headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return (await response.json()).resource;
  };
  const workspace = await rawWrite("/api/v1/workspaces", { display_name: "MCP fixture" });
  const project = await rawWrite(`/api/v1/workspaces/${workspace.id}/projects`, { display_name: "Scoped" });
  const other = await rawWrite(`/api/v1/workspaces/${workspace.id}/projects`, { display_name: "Other" });
  const facade = createMcpFacade({ ...fixture, fetchImpl });
  const instance = { instance_id: fixture.instanceId };
  const target = { ...instance, workspace_id: workspace.id, project_id: project.id };
  const call = async (name, args) => {
    const result = await facade.callTool(`cfkanban_${name}`, { ...instance, ...args });
    assert.equal(JSON.stringify(result).includes(current.token), false, "results must not contain the fixture credential");
    return result;
  };
  assert.equal((await call("connection_inspect", {})).data.principal.id, fixture.principalId);
  assert.equal((await call("statuses_list", target)).data.items.length, 5);
  assert.equal((await call("workspaces_list", { limit: 1 })).data.items.length, 1);
  assert.equal((await call("projects_get", target)).data.id, project.id);
  assert.equal((await call("projects_list", { workspace_id: workspace.id, limit: 1 })).data.has_more, true);
  const create = { ...target, title: "MCP first", priority_key: "high", idempotency_key: randomUUID() };
  const first = await call("issues_create", create);
  assert.equal(first.ok, true);
  assert.equal((await call("issues_create", create)).data.idempotent_replay, true);
  const a = first.data.resource;
  const second = await call("issues_create", { ...target, title: "MCP second", idempotency_key: randomUUID() });
  assert.equal(second.ok, true);
  const b = second.data.resource;
  const list = await call("issues_list", { project_ids: [project.id], priority: ["high"], limit: 1 });
  assert.equal(list.ok, true);
  assert.equal(list.data.items[0].identifier, a.identifier);
  assert.equal(list.data.resolved_scope.projects[0].project_id, project.id);
  const update = await call("issues_update", { identifier: a.identifier, expected_version: a.version, changes: { status_key: "in_progress" }, idempotency_key: randomUUID() });
  assert.equal(update.ok, true);
  const conflict = await call("issues_update", { identifier: a.identifier, expected_version: a.version, changes: { title: "stale" }, idempotency_key: randomUUID() });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.outcome_unknown, undefined);
  const comment = await call("comments_create", { identifier: a.identifier, body: "Verified fixture comment", idempotency_key: randomUUID() });
  assert.equal(comment.ok, true);
  assert.equal((await call("comments_list", { identifier: a.identifier })).data.items.length, 1);
  const readA = (await call("issues_get", { identifier: a.identifier })).data;
  const readB = (await call("issues_get", { identifier: b.identifier })).data;
  const related = await call("relations_create", { identifier: a.identifier, target_identifier: b.identifier, kind: "related", source_expected_version: readA.version, target_expected_version: readB.version, idempotency_key: randomUUID() });
  assert.equal(related.ok, true);
  assert.equal((await call("relations_list", { identifier: a.identifier })).data.items.length, 1);
  const afterRelationA = (await call("issues_get", { identifier: a.identifier })).data;
  const afterRelationB = (await call("issues_get", { identifier: b.identifier })).data;
  const relation = related.data.resource;
  const sourceVersion = relation.source.identifier === a.identifier ? afterRelationA.version : afterRelationB.version;
  const targetVersion = relation.target.identifier === b.identifier ? afterRelationB.version : afterRelationA.version;
  assert.equal((await call("relations_delete", { relation_id: relation.id, expected_version: relation.version, source_expected_version: sourceVersion, target_expected_version: targetVersion, idempotency_key: randomUUID() })).ok, true);
  const done = await call("issues_complete", { identifier: a.identifier, expected_version: (await call("issues_get", { identifier: a.identifier })).data.version, summary: "Completed by isolated MCP fixture", verification: ["real Worker/D1 comparison"], idempotency_key: randomUUID() });
  assert.equal(done.ok, true);
  assert.equal((await call("issues_get", { identifier: a.identifier })).data.status.key, "done");

  const outside = await call("issues_create", { ...target, project_id: other.id, title: "Other project", idempotency_key: randomUUID() });
  const bound = createMcpFacade({ ...fixture, fetchImpl, binding: { instance_id: fixture.instanceId, expected_principal_id: fixture.principalId, project_ids: [project.id] } });
  const denied = await bound.callTool("cfkanban_comments_create", { ...instance, identifier: outside.data.resource.identifier, body: "must be refused", idempotency_key: randomUUID() });
  assert.equal(denied.error.code, "MCP_PROJECT_BINDING_MISMATCH");

  const uncertainArgs = { ...target, title: "Lost response", idempotency_key: randomUUID() };
  const lost = createMcpFacade({ ...fixture, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (init.method === "POST") { await response.text(); throw new Error("fixture dropped response after commit"); }
    return response;
  } });
  const unknown = await lost.callTool("cfkanban_issues_create", uncertainArgs);
  assert.equal(unknown.outcome_unknown, true);
  assert.equal(unknown.recovery_request.idempotency_key, uncertainArgs.idempotency_key);
  assert.equal((await call("issues_create", uncertainArgs)).data.idempotent_replay, true);

  const reader = await createMcpStateFixture(t, { instanceId: fixture.instanceId, origin: fixture.origin });
  const readerCurrent = await loadCurrentCredentialSecret(reader);
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES (?1,'MCP_Reader','mcp_reader',?2,?2)").bind(reader.principalId, now),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)").bind(readerCurrent.metadata.credential_id, reader.principalId, readerCurrent.token.split("_")[2], readerCurrent.metadata.token_digest, now, randomUUID()),
    db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES (?1,?2,?3,'reader',?4,?4,?5)").bind(randomUUID(), reader.principalId, project.id, now, randomUUID()),
  ]);
  const readerFacade = createMcpFacade({ ...reader, fetchImpl });
  assert.equal((await readerFacade.callTool("cfkanban_issues_get", { ...instance, identifier: a.identifier })).ok, true);
  assert.equal((await readerFacade.callTool("cfkanban_comments_create", { ...instance, identifier: a.identifier, body: "reader refused", idempotency_key: randomUUID() })).status, 403);
  assert.equal((await readerFacade.callTool("cfkanban_issues_get", { ...instance, identifier: outside.data.resource.identifier })).status, 404);
  await db.prepare("UPDATE credentials SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(), fixture.principalId, readerCurrent.metadata.credential_id).run();
  assert.equal((await readerFacade.callTool("cfkanban_connection_inspect", instance)).status, 401);
});
