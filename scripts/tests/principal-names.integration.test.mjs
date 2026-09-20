import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

const server = createTestHarness({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});
const ownerToken = `cfk_v1_nameowner_${"A".repeat(43)}`;
const ownerId = crypto.randomUUID();
const ownerCredentialId = crypto.randomUUID();
let db;
let sequence = 0;
const bearer = (token = ownerToken) => ({ authorization: `Bearer ${token}` });
async function request(path, { body, headers = bearer(), method = "GET" } = {}) {
  const response = await server.fetch(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function write(path, body, method = "POST", headers = bearer()) {
  return request(path, { body, method, headers: { ...headers, "idempotency-key": `names-${++sequence}` } });
}
async function seed(name, projectId, role = "writer") {
  const id = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const token = `cfk_v1_${id.replaceAll("-", "")}_${"B".repeat(43)}`;
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO principals (id,display_name,display_name_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)")
      .bind(id, name, name.normalize("NFKC").toLowerCase(), now),
    db.prepare("INSERT INTO credentials (id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(credentialId, id, id.replaceAll("-", ""), await sha256Hex(token), now, crypto.randomUUID()),
    db.prepare("INSERT INTO project_grants (id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?5,?6)")
      .bind(grantId, id, projectId, role, now, crypto.randomUUID()),
  ]);
  return { id, token, grantId };
}
async function counts() {
  return db.prepare(`SELECT (SELECT count(*) FROM principals) AS principals,
    (SELECT count(*) FROM credentials) AS credentials,
    (SELECT count(*) FROM project_grants) AS grants`).first();
}
function nameConflict(result) {
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, "PRINCIPAL_DISPLAY_NAME_CONFLICT");
  assert.equal(result.body.recovery, "choose_another_display_name");
  assert.deepEqual(result.body.details, {});
}
before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, {
    instanceId: crypto.randomUUID(), operationId: crypto.randomUUID(),
    ownerPrincipalId: ownerId, ownerCredentialId, ownerCredentialToken: ownerToken,
    ownerDisplayName: "  Ｋｅｎｎ  ", preferredApiOrigin: "https://kanban.example.test",
  });
});
after(async () => server.close());

test("Principal names are normalized, unique, atomic, and resolved only inside authorized Projects", async () => {
  assert.deepEqual(await db.prepare("SELECT display_name,display_name_key FROM principals WHERE id=?1").bind(ownerId).first(), {
    display_name: "Kenn", display_name_key: "kenn",
  });
  const workspace = await write("/api/v1/workspaces", { display_name: "Name Tests" });
  assert.equal(workspace.status, 200);
  const workspaceId = workspace.body.resource.id;
  const project = await write(`/api/v1/workspaces/${workspaceId}/projects`, { display_name: "Names Core" });
  const otherProject = await write(`/api/v1/workspaces/${workspaceId}/projects`, { display_name: "Other" });
  assert.equal(project.status, 200);
  const projectId = project.body.resource.id;
  const otherId = otherProject.body.resource.id;
  const writer = await seed("Alice", projectId);
  const reader = await seed("ReaderOne", projectId, "reader");
  const revoked = await seed("RevokedOne", projectId);
  const elsewhere = await seed("Elsewhere", otherId);
  await db.prepare("UPDATE project_grants SET revoked_at=?1,revoked_by_principal_id=?3 WHERE id=?2").bind(Date.now(), revoked.grantId, ownerId).run();

  for (const name of ["a b", "a\tb", "a\nb", "a\u200bb", "a\u202eb", "a@b", "x#", "x!", "😀", "ADMIN", "Ｏｗｎｅｒ", "管理员"]) {
    const result = await write("/api/v1/me", { display_name: name, expected_version: 1 }, "PATCH");
    assert.equal(result.status, 400, name);
    assert.equal(result.body.details.reason, "principal_display_name_invalid");
  }
  const caseChange = await write("/api/v1/me", { display_name: "  KENN  ", expected_version: 1 }, "PATCH");
  assert.equal(caseChange.status, 200, JSON.stringify(caseChange.body));
  nameConflict(await write("/api/v1/me", { display_name: "ａｌｉｃｅ", expected_version: 2 }, "PATCH"));
  const race = await Promise.all([
    write("/api/v1/me", { display_name: "SharedName", expected_version: 1 }, "PATCH", bearer(writer.token)),
    write("/api/v1/me", { display_name: "ＳＨＡＲＥＤＮＡＭＥ", expected_version: 1 }, "PATCH", bearer(reader.token)),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  nameConflict(race.find((r) => r.status === 409));
  assert.equal((await db.prepare("SELECT count(*) AS count FROM principals WHERE display_name_key='sharedname'").first()).count, 1);
  const writerName = (await db.prepare("SELECT display_name FROM principals WHERE id=?1").bind(writer.id).first()).display_name;
  const readerName = (await db.prepare("SELECT display_name FROM principals WHERE id=?1").bind(reader.id).first()).display_name;

  const endpoint = (pid, name) => `/api/v1/workspaces/${workspaceId}/projects/${pid}/assignees?display_name=${encodeURIComponent(name)}`;
  for (const [name, expectedId] of [["ｋｅｎｎ", ownerId], [writerName.toUpperCase(), writer.id]]) {
    const result = await request(endpoint(projectId, name), { headers: bearer(reader.token) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.items.length, 1);
    assert.equal(result.body.items[0].principal_id, expectedId);
    assert.equal(result.body.has_more, false);
    assert.equal(result.body.next_cursor, null);
  }
  for (const name of [readerName, "RevokedOne", "Elsewhere", "Unknown"]) {
    const result = await request(endpoint(projectId, name), { headers: bearer(writer.token) });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items, []);
  }
  assert.equal((await request(endpoint(otherId, "Elsewhere"), { headers: bearer(writer.token) })).status, 404);
  assert.equal((await request(endpoint(projectId, writerName), { headers: {} })).status, 401);
  assert.equal((await request(endpoint(projectId, writerName), { headers: bearer(elsewhere.token) })).status, 404);
  const listEndpoint = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/assignees`;
  const admin = await seed("ProjectAdmin", otherId, "reader");
  const workspaceAdmin = await seed("WorkspaceAdmin", otherId, "reader");
  for (const [principal, target] of [[admin, projectId], [workspaceAdmin, null], [writer, projectId]]) {
    const result = await write(target === null
      ? `/api/v1/workspaces/${workspaceId}/administrators`
      : `/api/v1/workspaces/${workspaceId}/projects/${target}/administrators`,
    { principal_id: principal.id, expected_version: 0 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  const expectedIds = [ownerId, writer.id, admin.id, workspaceAdmin.id].sort();
  const collected = [];
  let nextCursor = null;
  let firstCursor;
  do {
    const result = await request(`${listEndpoint}?limit=1${nextCursor ? `&cursor=${nextCursor}` : ""}`, { headers: bearer(reader.token) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.items.length, 1);
    assert.deepEqual(Object.keys(result.body.items[0]).sort(), ["display_name", "principal_id"]);
    collected.push(result.body.items[0].principal_id);
    nextCursor = result.body.next_cursor;
    firstCursor ??= nextCursor;
    assert.equal(result.body.has_more, nextCursor !== null);
  } while (nextCursor);
  assert.deepEqual(collected, expectedIds);
  assert.equal((await request(`${listEndpoint}?limit=101`)).status, 400);
  assert.equal((await request(`${listEndpoint}?cursor=invalid`)).status, 400);
  assert.equal((await request(`${endpoint(projectId, writerName)}&cursor=${firstCursor}`, { headers: bearer(reader.token) })).status, 409);
  assert.equal((await request(`${listEndpoint}?cursor=${firstCursor}`)).status, 409);
  assert.equal((await request(`/api/v1/workspaces/${workspaceId}/projects/${otherId}/assignees?cursor=${firstCursor}`, { headers: bearer(workspaceAdmin.token) })).status, 409);
  assert.equal((await request(listEndpoint, { headers: bearer(elsewhere.token) })).status, 404);
  assert.equal((await request(listEndpoint, { headers: {} })).status, 401);
  await db.prepare("UPDATE project_grants SET revoked_at=?1,revoked_by_principal_id=?3 WHERE id=?2").bind(Date.now(), reader.grantId, ownerId).run();
  assert.equal((await request(`${listEndpoint}?cursor=${firstCursor}`, { headers: bearer(reader.token) })).status, 404);
  await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(reader.grantId).run();
  assert.equal((await request(`${endpoint(projectId, writerName)}&display_name=Kenn`)).status, 400);
  const session = "S".repeat(43);
  await db.prepare(`INSERT INTO web_sessions
    (id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES (?1,?2,?3,'credential',?4,'project',?5,?6,?7)`).bind(
      crypto.randomUUID(), await sha256Hex(session), ownerId, ownerCredentialId,
      JSON.stringify({ kind: "project", workspace_id: workspaceId, project_id: projectId, entry_path: `/app/w/${workspaceId}/p/${projectId}` }), Date.now() + 60_000, Date.now(),
    ).run();
  const cookies = { cookie: `cfkanban_session=${session}` };
  assert.equal((await request(endpoint(projectId, writerName), { headers: cookies })).status, 200);
  assert.equal((await request(endpoint(otherId, "Elsewhere"), { headers: cookies })).status, 404);
  assert.equal((await request(listEndpoint, { headers: cookies })).status, 200);
  assert.equal((await request(`/api/v1/workspaces/${workspaceId}/projects/${otherId}/assignees`, { headers: cookies })).status, 404);

  const invite = await write("/api/v1/admin/invitations", { kind: "project_grant", grants: [{ project_id: projectId, role: "writer" }] });
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  const inviteCode = new URL(invite.body.resource.invite_url).searchParams.get("code");
  const invitedToken = `cfk_v1_invited_${"I".repeat(43)}`;
  const beforeInvite = await counts();
  nameConflict(await write("/api/v1/invitations/redeem", {
    invite_code: inviteCode, redeem_as: "new_principal", display_name: "ｋｅｎｎ", new_credential_token: invitedToken,
  }, "POST", {}));
  assert.deepEqual(await counts(), beforeInvite);
  assert.equal((await db.prepare("SELECT redeemed_at FROM invitations WHERE id=?1").bind(invite.body.resource.id).first()).redeemed_at, null);
  const redeemed = await write("/api/v1/invitations/redeem", {
    invite_code: inviteCode, redeem_as: "new_principal", display_name: "InvitedOne", new_credential_token: invitedToken,
  }, "POST", {});
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));

  const enabled = await write(`/api/v1/admin/projects/${projectId}/public-join`, {
    expected_version: 1, issue_limit: 20, comment_limit: 30, principal_limit: 20, public_summary: "Name tests",
  }, "PUT");
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const publicId = enabled.body.resource.public_id;
  const publicToken = `cfk_v1_publicnames_${"P".repeat(43)}`;
  const beforePublic = await counts();
  const usageBefore = await db.prepare("SELECT active_principal_count FROM project_usage WHERE project_id=?1").bind(projectId).first();
  nameConflict(await write(`/api/v1/public-joins/${publicId}/redeem`, {
    redeem_as: "new_principal", role: "writer", display_name: "kEnN", new_credential_token: publicToken,
  }, "POST", {}));
  assert.deepEqual(await counts(), beforePublic);
  assert.deepEqual(await db.prepare("SELECT active_principal_count FROM project_usage WHERE project_id=?1").bind(projectId).first(), usageBefore);
  const joined = await write(`/api/v1/public-joins/${publicId}/redeem`, {
    redeem_as: "new_principal", role: "writer", display_name: "PublicOne", new_credential_token: publicToken,
  }, "POST", {});
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
});
