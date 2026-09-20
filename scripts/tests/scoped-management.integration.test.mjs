import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { updateProject } from "../../apps/worker/src/services/containers.ts";
import { redeemInvitation } from "../../apps/worker/src/services/invitations.ts";
import { listAdministrators } from "../../apps/worker/src/services/scoped-administrators.ts";
import { sha256Hex } from "../../apps/worker/src/kernel/crypto.ts";

const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const owner = { id: randomUUID(), token: `cfk_v1_owner_${"A".repeat(43)}` };
const workspaceAdmin = { id: randomUUID(), token: `cfk_v1_workspace_${"B".repeat(43)}` };
const projectAdmin = { id: randomUUID(), token: `cfk_v1_project_${"C".repeat(43)}` };
const member = { id: randomUUID(), token: `cfk_v1_member_${"D".repeat(43)}` };
let db;
async function request(actor, path, method = "GET", body, key = randomUUID()) {
  const response = await server.fetch(path, { method, headers: { ...(actor.headers ?? { authorization: `Bearer ${actor.token}` }), "content-type": "application/json", "idempotency-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function success(result) { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.resource ?? result.body; }
async function administrator(actor, workspaceId, projectId = null) {
  const id = randomUUID();
  await db.prepare(`INSERT INTO scoped_administrator_grants (id,principal_id,workspace_id,project_id,version,generation,created_at,updated_at,created_operation_id,last_operation_id) VALUES (?1,?2,?3,?4,1,?5,?6,?6,?7,?7)`)
    .bind(id,actor.id,workspaceId,projectId,randomUUID(),Date.now(),randomUUID()).run();
  return id;
}
before(async () => {
  await server.listen();
  const worker = server.getWorker(); await worker.applyD1Migrations("DB"); ({DB: db} = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: randomUUID(), ownerCredentialToken: owner.token, ownerDisplayName: "Deployment_Owner", ownerPrincipalId: owner.id, preferredApiOrigin: "https://kanban.example.test" });
  for (const [actor, name] of [[workspaceAdmin,"Workspace_Admin"],[projectAdmin,"Project_Admin"],[member,"Member"]]) {
    await db.prepare("INSERT INTO principals(id,display_name,display_name_key,version,created_at,updated_at) VALUES (?1,?2,?3,1,?4,?4)").bind(actor.id,name,name.toLowerCase(),Date.now()).run();
    await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)").bind(randomUUID(),actor.id,actor.token.split("_")[2],await sha256Hex(actor.token),Date.now(),randomUUID()).run();
  }
});
after(async () => server.close());

test("分级管理覆盖空工作区、未来项目、精确审计与权限隔离", async () => {
  const workspace = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Managed"}));
  const other = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Other"}));
  const wsGrant = await administrator(workspaceAdmin,workspace.id);
  const list = success(await request(workspaceAdmin,"/api/v1/workspaces"));
  assert.ok(list.items.some(item=>item.id===workspace.id)); assert.ok(!list.items.some(item=>item.id===other.id));
  success(await request(workspaceAdmin,`/api/v1/workspaces/${workspace.id}`,"PATCH",{display_name:"Renamed",expected_version:workspace.version}));
  const project = success(await request(workspaceAdmin,`/api/v1/workspaces/${workspace.id}/projects`,"POST",{display_name:"Future"}));
  const projectPath = `/api/v1/workspaces/${workspace.id}/projects/${project.id}`;
  assert.equal(success(await request(workspaceAdmin,projectPath)).active_usage.principals,1);
  const projectGrant = await administrator(projectAdmin,workspace.id,project.id);
  assert.ok(success(await request(projectAdmin,projectPath)).allowed_actions.includes("manage_members"));
  assert.equal((await request(projectAdmin,`${projectPath}?expected_version=1`,"DELETE")).status,403);
  assert.equal((await request(projectAdmin,`/api/v1/workspaces/${workspace.id}/projects`,"POST",{display_name:"Denied"})).status,403);
  const updated = success(await request(projectAdmin,projectPath,"PATCH",{context:"Scoped context",expected_version:1}));
  const event = await db.prepare("SELECT authorized_via,administrator_grant_id FROM events WHERE subject_id=?1 AND type='project.updated'").bind(project.id).first();
  assert.equal(event.authorized_via,"project_admin"); assert.equal(event.administrator_grant_id,projectGrant);
  const grant = success(await request(projectAdmin,`/api/v1/admin/projects/${project.id}/grants`,"POST",{principal_id:member.id,role:"writer"}));
  assert.equal((await request(projectAdmin,"/api/v1/admin/principals")).status,403);
  assert.equal((await request(projectAdmin,`/api/v1/workspaces/${other.id}`)).status,404);
  success(await request(projectAdmin,`/api/v1/admin/grants/${grant.id}?expected_version=${grant.version}`,"DELETE"));
  const archived = success(await request(workspaceAdmin,`${projectPath}?expected_version=${updated.version}`,"DELETE"));
  assert.equal((await request(projectAdmin,projectPath)).status,404);
  const deleted = success(await request(workspaceAdmin,`/api/v1/workspaces/${workspace.id}/projects?deleted=only`)); assert.equal(deleted.items[0].id,project.id);
  success(await request(workspaceAdmin,`${projectPath}/commands/restore`,"POST",{expected_version:archived.version}));
  await db.prepare("UPDATE scoped_administrator_grants SET revoked_at=?1 WHERE id=?2").bind(Date.now(),wsGrant).run();
  assert.equal((await request(workspaceAdmin,projectPath,"PATCH",{context:"Denied",expected_version:archived.version+1})).status,403);
});

test("项目归档在鉴权后或列表查询前发生时，项目管理员不能读取管理员记录", async () => {
  const ws = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Archive read race"}));
  const project = success(await request(owner,`/api/v1/workspaces/${ws.id}/projects`,"POST",{display_name:"Managed"}));
  const path = `/api/v1/workspaces/${ws.id}/projects/${project.id}`;
  await administrator(workspaceAdmin,ws.id);
  await administrator(projectAdmin,ws.id,project.id);
  await administrator(member,ws.id,project.id);
  const scope = { workspaceId: ws.id, projectId: project.id };
  const url = new URL(`https://kanban.example.test${path}/administrators`);
  const auth = await authenticateBearer(db,`Bearer ${projectAdmin.token}`);
  const archived = success(await request(owner,`${path}?expected_version=1`,"DELETE"));
  await assert.rejects(listAdministrators(db,auth,scope,url,Date.now()),error=>error.status===404);
  for (const actor of [owner,workspaceAdmin]) {
    assert.equal(success(await request(actor,`${path}/administrators`)).items.length,2);
  }
  const restored = success(await request(owner,`${path}/commands/restore`,"POST",{expected_version:archived.version}));
  let rawRows;
  function wrapStatement(statement) {
    return new Proxy(statement,{get(target,property) {
      if (property === "bind") return (...values) => wrapStatement(target.bind(...values));
      if (property === "all") return async () => {
        success(await request(owner,`${path}?expected_version=${restored.version}`,"DELETE"));
        const result = await target.all();
        rawRows = result.results;
        return result;
      };
      const value = Reflect.get(target,property,target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
  }
  const archiveBeforeQuery = new Proxy(db,{get(target,property) {
    if (property === "prepare") return sql => {
      const statement = target.prepare(sql);
      return sql.includes("SELECT a.*, p.display_name FROM scoped_administrator_grants") ? wrapStatement(statement) : statement;
    };
    const value = Reflect.get(target,property,target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  await assert.rejects(listAdministrators(archiveBeforeQuery,auth,scope,url,Date.now()),error=>error.status===404);
  assert.deepEqual(rawRows,[]);
});

test("局部邀请按完整目标过滤，签发来源撤销及重新授权均不能复活旧邀请", async () => {
  const ws = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Invites"}));
  const first = success(await request(owner,`/api/v1/workspaces/${ws.id}/projects`,"POST",{display_name:"First"}));
  const second = success(await request(owner,`/api/v1/workspaces/${ws.id}/projects`,"POST",{display_name:"Second"}));
  const admin = await administrator(projectAdmin,ws.id,first.id);
  const mixed = success(await request(owner,"/api/v1/admin/invitations","POST",{kind:"project_grant",grants:[{project_id:first.id,role:"writer"},{project_id:second.id,role:"reader"}]}));
  assert.equal((await request(projectAdmin,`/api/v1/admin/invitations/${mixed.id}`)).status,403);
  const visible = success(await request(projectAdmin,`/api/v1/admin/invitations?project_id=${first.id}`)); assert.ok(!visible.items.some(i=>i.id===mixed.id));
  const invite = success(await request(projectAdmin,"/api/v1/admin/invitations","POST",{kind:"project_grant",grants:[{project_id:first.id,role:"writer"}]}));
  assert.equal((await request(projectAdmin,"/api/v1/admin/invitations","POST",{kind:"project_grant",grants:[{project_id:first.id,role:"writer"},{project_id:second.id,role:"reader"}]})).status,403);
  const code = new URL(invite.invite_url).searchParams.get("code");
  await db.prepare("UPDATE scoped_administrator_grants SET revoked_at=?1 WHERE id=?2").bind(Date.now(),admin).run();
  const rejected = await request(member,"/api/v1/invitations/redeem","POST",{invite_code:code,redeem_as:"current_principal"});
  assert.equal(rejected.status,410); assert.equal(rejected.body.details.reason,"issuer_authorization_revoked");
  await db.prepare("UPDATE scoped_administrator_grants SET revoked_at=NULL,generation=?1,version=version+1 WHERE id=?2").bind(randomUUID(),admin).run();
  assert.equal((await request(member,"/api/v1/invitations/redeem","POST",{invite_code:code,redeem_as:"current_principal"})).status,410);
  const fresh = success(await request(projectAdmin,"/api/v1/admin/invitations","POST",{kind:"project_grant",grants:[{project_id:first.id,role:"writer"}]}));
  success(await request(member,"/api/v1/invitations/redeem","POST",{invite_code:new URL(fresh.invite_url).searchParams.get("code"),redeem_as:"current_principal"}));
});

test("满额项目的重复授权来源不重复计数，普通Grant、邀请和Public Join共用去重口径", async () => {
  const ws = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Quota"}));
  const p = success(await request(owner,`/api/v1/workspaces/${ws.id}/projects`,"POST",{display_name:"Full"}));
  await administrator(projectAdmin,ws.id,p.id);
  const policy = success(await request(owner,`/api/v1/admin/projects/${p.id}/public-join`,"PUT",{expected_version:1,public_summary:"Quota test",issue_limit:10,comment_limit:10,principal_limit:1}));
  const count = async () => (await db.prepare("SELECT active_principal_count FROM project_usage WHERE project_id=?1").bind(p.id).first()).active_principal_count;
  assert.equal(await count(),1);
  const grant = success(await request(projectAdmin,`/api/v1/admin/projects/${p.id}/grants`,"POST",{principal_id:projectAdmin.id,role:"reader"})); assert.equal(await count(),1);
  success(await request(projectAdmin,`/api/v1/admin/grants/${grant.id}?expected_version=${grant.version}`,"DELETE")); assert.equal(await count(),1);
  const revokedEvent = await db.prepare("SELECT payload_json FROM events WHERE subject_id=?1 AND type='project-grant.revoked'").bind(grant.id).first();
  assert.equal(JSON.parse(revokedEvent.payload_json).effective_role,"writer");
  const blocked = await request(projectAdmin,`/api/v1/admin/projects/${p.id}/grants`,"POST",{principal_id:member.id,role:"writer"}); assert.equal(blocked.status,409);
  const invite = success(await request(projectAdmin,"/api/v1/admin/invitations","POST",{kind:"project_grant",grants:[{project_id:p.id,role:"reader"}]}));
  success(await request(projectAdmin,"/api/v1/invitations/redeem","POST",{invite_code:new URL(invite.invite_url).searchParams.get("code"),redeem_as:"current_principal"})); assert.equal(await count(),1);
  const current = success(await request(projectAdmin,`/api/v1/admin/grants/${grant.id}`));
  success(await request(projectAdmin,`/api/v1/admin/grants/${grant.id}?expected_version=${current.version}`,"DELETE"));
  success(await request(projectAdmin,`/api/v1/public-joins/${policy.public_id}/redeem`,"POST",{redeem_as:"current_principal",role:"reader"})); assert.equal(await count(),1);
  assert.equal((await request(member,`/api/v1/public-joins/${policy.public_id}/redeem`,"POST",{redeem_as:"current_principal",role:"reader"})).status,409);
});

test("项目与空工作区永久清理同时移除管理员授权、签发邀请及其审计引用", async () => {
  const ws = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Purge admins"}));
  const p = success(await request(owner,`/api/v1/workspaces/${ws.id}/projects`,"POST",{display_name:"Purge project"}));
  const workspaceGrant = await administrator(workspaceAdmin,ws.id);
  const projectGrant = await administrator(projectAdmin,ws.id,p.id);
  const path = `/api/v1/workspaces/${ws.id}/projects/${p.id}`;
  success(await request(projectAdmin,"/api/v1/admin/invitations","POST",{kind:"project_grant",grants:[{project_id:p.id,role:"reader"}]}));
  const updated = success(await request(projectAdmin,path,"PATCH",{expected_version:1,context:"Audit references administrator"}));
  success(await request(workspaceAdmin,`${path}?expected_version=${updated.version}`,"DELETE"));
  const preview = success(await request(owner,`${path}/purge-preview`));
  assert.equal(preview.counts.administrators,1);
  success(await request(owner,`${path}/commands/purge`,"POST",{expected_version:preview.target.version,confirm_name:preview.target.display_name,preview_digest:preview.preview_digest}));
  assert.equal(await db.prepare("SELECT 1 FROM scoped_administrator_grants WHERE id=?1").bind(projectGrant).first(),null);
  const wsPath = `/api/v1/workspaces/${ws.id}`;
  success(await request(owner,`${wsPath}?expected_version=${ws.version}`,"DELETE"));
  const workspacePreview = success(await request(owner,`${wsPath}/purge-preview`));
  assert.equal(workspacePreview.counts.administrators,1);
  success(await request(owner,`${wsPath}/commands/purge`,"POST",{expected_version:workspacePreview.target.version,confirm_name:workspacePreview.target.display_name,preview_digest:workspacePreview.preview_digest}));
  assert.equal(await db.prepare("SELECT 1 FROM scoped_administrator_grants WHERE id=?1").bind(workspaceGrant).first(),null);
});

function revokeBeforeBatch(grantId, batchNumber) {
  let count = 0;
  return new Proxy(db, { get(target, property) {
    if (property === "batch") return async (statements) => {
      if (++count === batchNumber) await db.prepare("UPDATE scoped_administrator_grants SET revoked_at=?1 WHERE id=?2").bind(Date.now(),grantId).run();
      return db.batch(statements);
    };
    const value = Reflect.get(target,property,target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("检查后并发撤权使容器写入和邀请兑换整个原子操作失败", async () => {
  const ws = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Atomic revoke"}));
  const p = success(await request(owner,`/api/v1/workspaces/${ws.id}/projects`,"POST",{display_name:"Original"}));
  const grant = await administrator(projectAdmin,ws.id,p.id);
  const auth = await authenticateBearer(db,`Bearer ${projectAdmin.token}`);
  await assert.rejects(updateProject(revokeBeforeBatch(grant,1),auth,ws.id,p.id,"Unauthorized change",undefined,1,Date.now()),error=>[403,404].includes(error.status));
  const current = await db.prepare("SELECT display_name,version FROM projects WHERE id=?1").bind(p.id).first();
  assert.deepEqual(current,{display_name:"Original",version:1});
  await db.prepare("UPDATE scoped_administrator_grants SET revoked_at=NULL,generation=?1,version=version+1 WHERE id=?2").bind(randomUUID(),grant).run();
  const invite = success(await request(projectAdmin,"/api/v1/admin/invitations","POST",{kind:"project_grant",grants:[{project_id:p.id,role:"writer"}]}));
  const code = new URL(invite.invite_url).searchParams.get("code");
  const redeemRequest = new Request("https://kanban.example.test/api/v1/invitations/redeem",{method:"POST",headers:{authorization:`Bearer ${member.token}`,"idempotency-key":randomUUID()}});
  await assert.rejects(redeemInvitation(revokeBeforeBatch(grant,2),redeemRequest,code,"current_principal",undefined,undefined,Date.now()),error=>error.code==="INVITATION_REVOKED");
  assert.equal(await db.prepare("SELECT 1 FROM project_grants WHERE project_id=?1 AND principal_id=?2").bind(p.id,member.id).first(),null);
  assert.equal((await db.prepare("SELECT redeemed_at FROM invitations WHERE id=?1").bind(invite.id).first()).redeemed_at,null);
});

test("空工作区管理范围改变使旧分页游标失效，Owner工作区Session仅发现目标空工作区", async () => {
  const first = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Cursor_A"}));
  const second = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Cursor_B"}));
  await administrator(workspaceAdmin,first.id); await administrator(workspaceAdmin,second.id);
  const page = success(await request(workspaceAdmin,"/api/v1/workspaces?limit=1")); assert.ok(page.next_cursor);
  const third = success(await request(owner,"/api/v1/workspaces","POST",{display_name:"Cursor_C"}));
  await administrator(workspaceAdmin,third.id);
  const oldCursor = await request(workspaceAdmin,`/api/v1/workspaces?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`);
  assert.equal(oldCursor.status,409); assert.equal(oldCursor.body.code,"CURSOR_SCOPE_MISMATCH");
  const credential = await db.prepare("SELECT id FROM credentials WHERE principal_id=?1").bind(owner.id).first();
  const sessionToken = "S".repeat(43); const now = Date.now();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES (?1,?2,?3,'credential',?4,'workspace',?5,?6,?7)")
    .bind(randomUUID(),await sha256Hex(sessionToken),owner.id,credential.id,JSON.stringify({kind:"workspace",workspace_id:third.id,entry_path:`/app/manage?workspace=${third.id}`}),now+3600000,now).run();
  const response = await server.fetch("/api/v1/workspaces",{headers:{cookie:`cfkanban_session=${sessionToken}`}}); const result = await response.json();
  assert.equal(response.status,200,JSON.stringify(result)); assert.deepEqual(result.items.map(w=>w.id),[third.id]);
});


async function ownerCookieActor(target) {
  const credential = await db.prepare("SELECT id FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL").bind(owner.id).first();
  const token = randomUUID().replaceAll("-", "") + "X".repeat(11);
  const now = Date.now();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES (?1,?2,?3,'credential',?4,?5,?6,?7,?8)")
    .bind(randomUUID(),await sha256Hex(token),owner.id,credential.id,target.kind,JSON.stringify(target),now+3600000,now).run();
  const discovery = await (await server.fetch("/.well-known/cfkanban-instance.json")).json();
  const csrf = "C".repeat(43);
  return { headers: { cookie: `cfkanban_session=${token}; cfkanban_csrf=${csrf}`, origin: discovery.observed_origin, "x-csrf-token": csrf } };
}

for (const archived of ["project", "workspace"]) test(`归档${archived}后仅完整Owner保留普通Grant读回和撤销，原列表暂停行为不变`, async () => {
  const ws = success(await request(owner,"/api/v1/workspaces","POST",{display_name:`Archived ${archived}`}));
  const project = success(await request(owner,`/api/v1/workspaces/${ws.id}/projects`,"POST",{display_name:"Grant history"}));
  const path = `/api/v1/workspaces/${ws.id}/projects/${project.id}`;
  await administrator(workspaceAdmin,ws.id);
  await administrator(projectAdmin,ws.id,project.id);
  const bearerGrant = success(await request(owner,`/api/v1/admin/projects/${project.id}/grants`,"POST",{principal_id:member.id,role:"reader"}));
  const cookieGrant = success(await request(owner,`/api/v1/admin/projects/${project.id}/grants`,"POST",{principal_id:projectAdmin.id,role:"reader"}));
  const adminCookie = await ownerCookieActor({kind:"admin",section:"overview",entry_path:"/app/admin"});
  const projectCookie = await ownerCookieActor({kind:"project",workspace_id:ws.id,project_id:project.id,entry_path:`/app/w/${ws.id}/p/${project.id}`});
  const issueCookie = await ownerCookieActor({kind:"issue",workspace_id:ws.id,project_id:project.id,issue_id:randomUUID(),identifier:"CFK-1",entry_path:"/app/issues/CFK-1"});
  const workspaceCookie = await ownerCookieActor({kind:"workspace",workspace_id:ws.id,entry_path:`/app/manage?workspace=${ws.id}`});
  for (const narrow of [projectCookie,issueCookie]) {
    assert.equal((await request(narrow,`/api/v1/admin/grants/${bearerGrant.id}`)).status,403);
  }
  const archivePath = archived === "project" ? path : `/api/v1/workspaces/${ws.id}`;
  success(await request(owner,`${archivePath}?expected_version=1`,"DELETE"));
  for (const paused of [workspaceAdmin,projectAdmin,workspaceCookie,projectCookie,issueCookie]) {
    const read = await request(paused,`/api/v1/admin/grants/${bearerGrant.id}`);
    assert.ok([403,404].includes(read.status),JSON.stringify(read));
    const revoke = await request(paused,`/api/v1/admin/grants/${bearerGrant.id}?expected_version=1`,"DELETE");
    assert.ok([403,404].includes(revoke.status),JSON.stringify(revoke));
  }
  for (const [full,grant] of [[owner,bearerGrant],[adminCookie,cookieGrant]]) {
    assert.equal((await request(full,`/api/v1/admin/projects/${project.id}/grants`)).status,404);
    assert.equal(success(await request(full,`/api/v1/admin/grants/${grant.id}`)).id,grant.id);
    const revoked = success(await request(full,`/api/v1/admin/grants/${grant.id}?expected_version=1`,"DELETE"));
    assert.ok(revoked.revoked_at); assert.equal(revoked.version,2);
    assert.ok(success(await request(full,`/api/v1/admin/grants/${grant.id}`)).revoked_at);
  }
});
