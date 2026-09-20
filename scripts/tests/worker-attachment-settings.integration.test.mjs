import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.attachments-test.jsonc" }] });
const worker = server.getWorker();
const token = `cfk_v1_owner_${"A".repeat(43)}`, writerToken = `cfk_v1_writer_${"B".repeat(43)}`;
const ownerId = randomUUID(), credentialId = randomUUID(), hash = value => createHash("sha256").update(value).digest("hex");
let env, db, workspace, project, issue;
const endpoint = "/api/v1/admin/attachment-settings";
async function request(path, { method="GET", body, key=randomUUID(), headers={ authorization: `Bearer ${token}` }, overrideEnv=env }={}) {
  const response=await fetchWorker(new Request(`https://settings.example.test${path}`, {method,headers:{...headers,...(key?{"idempotency-key":key}:{}),...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}),overrideEnv);
  return {status:response.status,data:await response.json(),response};
}
const settings = () => request(endpoint);
const patch = (body, extra={}) => request(endpoint,{method:"PATCH",body,...extra});
const reserve = (bytes, extra={}) => request(`/api/v1/issues/${issue.identifier}/attachments`, {method:"POST",body:{filename:"test.txt",content_type:"text/plain",size_bytes:bytes.length,sha256:hash(bytes)},...extra});
const freshIssue = async () => (await request(`/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`, {method:"POST",body:{title:"Settings test"}})).data.resource;
before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); env=await worker.getEnv(); db=env.DB;
  await bootstrapInstance(db,{instanceId:randomUUID(),operationId:randomUUID(),ownerCredentialId:credentialId,ownerCredentialToken:token,ownerDisplayName:"Settings_Owner",ownerPrincipalId:ownerId,preferredApiOrigin:"https://settings.example.test"});
  workspace=(await request("/api/v1/workspaces",{method:"POST",body:{display_name:"Settings"}})).data.resource;
  project=(await request(`/api/v1/workspaces/${workspace.id}/projects`,{method:"POST",body:{display_name:"Settings"}})).data.resource;
  issue=await freshIssue();
  const principalId=randomUUID(),now=Date.now();
  await db.batch([
    db.prepare("INSERT INTO principals (id, display_name, display_name_key, created_at, updated_at) VALUES (?1, 'Writer', lower('Writer'), ?2, ?2)").bind(principalId,now),
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,'writer',?3,?4,?5)").bind(randomUUID(),principalId,hash(writerToken),now,randomUUID()),
    db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES (?1,?2,?3,'writer',?4,?4,?5)").bind(randomUUID(),principalId,project.id,now,randomUUID()),
  ]);
});
after(() => server.close());
test("new and upgraded storage requires an explicit Owner choice",async()=>{
  const result=await settings(); assert.equal(result.status,200); assert.equal(result.response.headers.get("cache-control"),"no-store");
  assert.deepEqual(result.data,{limit_bytes:null,configured:false,version:1,reserved_bytes:0});
  const denied=await reserve(Buffer.from("data")); assert.equal(denied.status,409); assert.equal(denied.data.code,"ATTACHMENT_STORAGE_NOT_CONFIGURED");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM attachment_objects").first()).count,0);
  const list=await request(`/api/v1/issues/${issue.identifier}/attachments`); assert.equal(list.data.limits.storage_limit_configured,false); assert.equal(list.data.limits.max_storage_bytes,null);
});
test("settings enforce authorization, CSRF, input constraints and idempotency",async()=>{
  const writer={authorization:`Bearer ${writerToken}`};
  assert.equal((await request(endpoint,{headers:writer})).status,403);
  assert.equal((await patch({expected_version:1,limit_bytes:100},{headers:writer})).status,403);
  for (const limit of [0,-1,1.5,9007199254740992,"100",true]) assert.equal((await patch({expected_version:1,limit_bytes:limit})).status,400);
  assert.equal((await patch({expected_version:1})).status,400);
  assert.equal((await patch({expected_version:1,limit_bytes:100},{key:null})).status,400);
  const session="S".repeat(43),csrf="C".repeat(32),now=Date.now();
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES (?1,?2,?3,'credential',?4,'admin',?5,?6,?7)`).bind(randomUUID(),hash(session),ownerId,credentialId,JSON.stringify({kind:"admin",entry_path:"/app/admin",section:"overview"}),now+3600000,now).run();
  const cookie={cookie:`cfkanban_session=${session}; cfkanban_csrf=${csrf}`};
  assert.equal((await request(endpoint,{headers:cookie})).status,200);
  assert.equal((await patch({expected_version:1,limit_bytes:100},{headers:cookie})).status,403);
  const headers={...cookie,origin:"https://settings.example.test","x-csrf-token":csrf};
  const body={expected_version:1,limit_bytes:100},key=randomUUID();
  const changed=await patch(body,{headers,key,overrideEnv:{...env,ATTACHMENTS:undefined}}); assert.equal(changed.status,200,JSON.stringify(changed.data)); assert.deepEqual(changed.data.resource,{limit_bytes:100,configured:true,version:2,reserved_bytes:0});
  const replay=await patch(body,{headers,key}); assert.equal(replay.data.idempotent_replay,true); assert.equal(replay.data.resource.version,2);
  assert.equal((await patch({...body,limit_bytes:200},{headers,key})).data.code,"IDEMPOTENCY_CONFLICT");
  const audit=await db.prepare("SELECT * FROM events WHERE type='instance.attachment-settings-updated'").all(); assert.equal(audit.results.length,1); assert.equal(audit.results[0].stream,"security"); assert.equal(audit.results[0].authorized_via,"deployment_owner");
  await db.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE token_digest=?2").bind(JSON.stringify({kind:"project",workspace_id:workspace.id,project_id:project.id,entry_path:`/app/w/${workspace.id}/p/${project.id}`}),hash(session)).run();
  assert.equal((await request(endpoint,{headers})).status,403); assert.equal((await patch({expected_version:2,limit_bytes:null},{headers})).status,403);
});
test("CAS permits one concurrent update and retains a single audit per mutation",async()=>{
  const version=(await settings()).data.version;
  const results=await Promise.all([patch({expected_version:version,limit_bytes:10}),patch({expected_version:version,limit_bytes:20})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]); assert.equal(results.find(r=>r.status===409).data.code,"VERSION_CONFLICT");
  assert.equal((await settings()).data.version,version+1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='instance.attachment-settings-updated'").first()).count,2);
});
test("finite budget is atomically shared; lowering does not cancel pending uploads",async()=>{
  await patch({expected_version:(await settings()).data.version,limit_bytes:8});
  const bytes=Buffer.from("abcd"),results=await Promise.all([reserve(bytes),reserve(bytes),reserve(bytes)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,200,409]); assert.equal(results.find(r=>r.status===409).data.code,"ATTACHMENT_STORAGE_LIMIT_REACHED");
  assert.equal((await settings()).data.reserved_bytes,8);
  const id=results.find(r=>r.status===200).data.resource.id;
  await patch({expected_version:(await settings()).data.version,limit_bytes:1});
  assert.equal((await settings()).data.reserved_bytes,8);
  await db.prepare("UPDATE attachment_storage SET limit_configured=0").run();
  const uploaded=await fetchWorker(new Request(`https://settings.example.test/api/v1/attachments/${id}/content`,{method:"PUT",headers:{authorization:`Bearer ${token}`,"idempotency-key":randomUUID(),"content-type":"application/octet-stream"},body:bytes}),env); assert.equal(uploaded.status,200,await uploaded.clone().text());
  assert.equal((await reserve(Buffer.from("x"))).status,409);
  const deleted=await request(`/api/v1/attachments/${id}?expected_version=2`,{method:"DELETE"}); assert.equal(deleted.status,200);
  const restored=await request(`/api/v1/attachments/${id}/commands/restore`,{method:"POST",body:{expected_version:3}}); assert.equal(restored.status,200);
  assert.equal((await settings()).data.reserved_bytes,8);
  assert.equal((await reserve(Buffer.from("z"))).data.code,"ATTACHMENT_STORAGE_NOT_CONFIGURED");
  await db.prepare("UPDATE attachment_storage SET limit_configured=1").run();
});
test("explicit unlimited removes the old 1GiB limit and preserves exact counters",async()=>{
  const before=(await settings()).data;
  const result=await patch({expected_version:before.version,limit_bytes:null}); assert.equal(result.status,200); assert.equal(result.data.resource.configured,true); assert.equal(result.data.resource.limit_bytes,null);
  const list=await request(`/api/v1/issues/${issue.identifier}/attachments`); assert.equal(list.data.limits.storage_limit_configured,true); assert.equal(list.data.limits.max_storage_bytes,null);
  await db.prepare("UPDATE attachment_storage SET reserved_bytes=?1").bind(1073741824+8).run();
  const reservation=await reserve(Buffer.from("free")); assert.equal(reservation.status,200,JSON.stringify(reservation.data)); assert.equal((await settings()).data.reserved_bytes,1073741824+12);
  await db.prepare("UPDATE attachment_storage SET reserved_bytes=?1").bind(before.reserved_bytes+4).run();
  const usage=await request("/api/v1/admin/usage"); assert.equal(usage.data.attachments.limit_configured,true); assert.equal(usage.data.attachments.limit_bytes,null); assert.equal(usage.data.attachments.settings_version,result.data.resource.version);
});
