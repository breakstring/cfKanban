import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { buildOwnerRecoveryBatch } from "../../packages/skill-runtime/src/owner-recovery.mjs";

// 仅使用 Wrangler 隔离的本地 D1 和合成凭据，不连接线上账户或实例。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker();
const origin = "https://devices.example.test", endpoint = "/api/v1/admin/owner-credentials/add-device";
const ownerId = randomUUID(), originalCredentialId = randomUUID(), instanceId = randomUUID();
const hash = value => createHash("sha256").update(value).digest("hex");
const makeToken = () => `cfk_v1_${randomBytes(8).toString("hex")}_${randomBytes(32).toString("base64url")}`;
let ownerToken = makeToken(), env, db, added;
const actors = ["reader", "writer", "workspace_admin", "project_admin"].map(role => ({role,id:randomUUID(),token:makeToken()}));
async function request(path, {method="GET", body, key=randomUUID(), headers={authorization:`Bearer ${ownerToken}`}, overrideEnv=env}={}) {
  const response = await fetchWorker(new Request(`${origin}${path}`, {method,headers:{...headers,...(key?{"idempotency-key":key}:{}),...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}),overrideEnv);
  return {status:response.status,data:await response.json()};
}
const owner = async () => (await db.prepare("SELECT * FROM principals WHERE id=?1").bind(ownerId).first());
async function device(name="工作电脑") {
  const token=makeToken(),now=Date.now();
  return {token,body:{instance_id:instanceId,principal_id:ownerId,credential_id:randomUUID(),token_prefix:token.split("_")[2],token_digest:hash(token),device_name:name,issued_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString(),expected_version:(await owner()).version}};
}
const add = (body, extra={}) => request(endpoint,{method:"POST",body,...extra});
const revoke = (id,version,extra={}) => request(`/api/v1/admin/owner-credentials/${id}/revoke`,{method:"POST",body:{expected_version:version},...extra});
const rename = (id, name, version, extra={}) => request(`/api/v1/admin/owner-credentials/${id}/rename`,{method:"POST",body:{device_name:name,expected_version:version},...extra});
const auditCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('owner.device-added','owner.device-revoked','owner.device-renamed')").first()).n;
async function session(sourceKind,sourceId,targetKind="admin",target={kind:"admin",entry_path:"/app/admin",section:"overview"},principalId=ownerId) {
  const token=randomBytes(32).toString("base64url"),id=randomUUID(),now=Date.now();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")
    .bind(id,hash(token),principalId,sourceKind,sourceId,targetKind,JSON.stringify(target),now+3600000,now).run();
  return {id,token,headers:{cookie:`cfkanban_session=${token}; cfkanban_csrf=${"C".repeat(32)}`,origin,"x-csrf-token":"C".repeat(32)}};
}
before(async()=>{
  await server.listen();await worker.applyD1Migrations("DB");env=await worker.getEnv();db=env.DB;
  await bootstrapInstance(db,{instanceId,operationId:randomUUID(),ownerCredentialId:originalCredentialId,ownerCredentialToken:ownerToken,ownerDisplayName:"Devices_Owner",ownerPrincipalId:ownerId,preferredApiOrigin:origin,schemaVersion:12});
  const workspace=(await request("/api/v1/workspaces",{method:"POST",body:{display_name:"Devices"}})).data.resource;
  const project=(await request(`/api/v1/workspaces/${workspace.id}/projects`,{method:"POST",body:{display_name:"Devices"}})).data.resource;
  for(const actor of actors){
    const now=Date.now();actor.credentialId=randomUUID();
    await db.batch([
      db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?2,?3,?3)").bind(actor.id,actor.role,now),
      db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,?3,?4,?5,?6)").bind(actor.credentialId,actor.id,actor.token.split("_")[2],hash(actor.token),now,randomUUID()),
    ]);
    if(actor.role.endsWith("admin"))await db.prepare("INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,version,generation,created_at,updated_at,created_operation_id,last_operation_id) VALUES(?1,?2,?3,?4,1,?5,?6,?6,?7,?7)")
      .bind(randomUUID(),actor.id,workspace.id,actor.role==="project_admin"?project.id:null,randomUUID(),now,randomUUID()).run();
    else await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,?4,?5,?5,?6)").bind(randomUUID(),actor.id,project.id,actor.role,now,randomUUID()).run();
  }
});
after(()=>server.close());

test("历史凭据名称为空；未认证、参与者、局部管理员和 Owner 窄 Session 均不能添加/撤销",async()=>{
  const body=(await device()).body;
  const list=(await request(`/api/v1/admin/principals/${ownerId}/credentials`)).data;
  assert.equal(list.items[0].device_name,null);
  assert.equal((await add(body,{headers:{}})).status,401);
  for(const actor of actors){
    const headers={authorization:`Bearer ${actor.token}`};
    assert.equal((await add(body,{headers})).status,403,actor.role);
    assert.equal((await revoke(originalCredentialId,1,{headers})).status,403,actor.role);
    const cookie=await session("credential",actor.credentialId,"admin",{kind:"admin",entry_path:"/app/admin",section:"overview"},actor.id);
    assert.equal((await add(body,{headers:cookie.headers})).status,403,`${actor.role} cookie`);
    assert.equal((await revoke(originalCredentialId,1,{headers:cookie.headers})).status,403,`${actor.role} cookie`);
  }
  const cookie=await session("credential",originalCredentialId);
  assert.equal((await request("/api/v1/me",{headers:cookie.headers})).status,200);
  assert.equal((await revoke(originalCredentialId,1,{headers:cookie.headers})).status,403);
  const project=await db.prepare("SELECT id,workspace_id FROM projects LIMIT 1").first();
  const scoped=await session("credential",originalCredentialId,"project",{kind:"project",workspace_id:project.workspace_id,project_id:project.id,entry_path:`/app/w/${project.workspace_id}/p/${project.id}`});
  assert.equal((await request("/api/v1/me",{headers:scoped.headers})).status,200);
  assert.equal((await add(body,{headers:scoped.headers})).status,403);
  assert.equal((await revoke(originalCredentialId,1,{headers:scoped.headers})).status,403);
  assert.equal((await owner()).version,1);assert.equal(await auditCount(),0);
});
test("拒绝不匹配实例/Owner、错误字段、过期和超过一小时请求，服务端不接收secret",async()=>{
  const body=(await device()).body;
  for(const patch of [{instance_id:randomUUID()},{principal_id:actors[0].id}])assert.equal((await add({...body,...patch})).status,403);
  for(const patch of [
    {token_prefix:"wrong"},{token_digest:"F".repeat(64)},{credential_id:"bad"},{expected_version:0},
    {device_name:" "},{device_name:"A".repeat(81)},{device_name:"test\nname"},{device_name:`cfk_v1_${"A".repeat(43)}`},
    {expires_at:new Date(Date.parse(body.issued_at)+3600001).toISOString()},
    {issued_at:new Date(Date.now()+10000).toISOString()},
    {issued_at:new Date(Date.now()-7200000).toISOString(),expires_at:new Date(Date.now()-3600000).toISOString()},
    {new_credential_token:makeToken()},
  ])assert.equal((await add({...body,...patch})).status,400,JSON.stringify(Object.keys(patch)));
  assert.equal((await add(body,{key:null})).status,400);
  assert.equal(await auditCount(),0);
});
test("添加同一 Owner 的独立凭据，幂等重放保持原结果，不持久化digest到审计/响应",async()=>{
  added=await device(" 新电脑 ");added.key=randomUUID();
  const result=await add(added.body,{key:added.key});assert.equal(result.status,200,JSON.stringify(result.data));
  added.resource=result.data.resource;
  assert.equal(result.data.resource.device_name,"新电脑");assert.equal(result.data.resource.principal_version,2);
  assert.equal((await request("/api/v1/me",{headers:{authorization:`Bearer ${added.token}`}})).data.principal_id,ownerId);
  assert.equal((await request("/api/v1/me")).status,200);
  const replay=await add(added.body,{key:added.key});assert.equal(replay.status,200);assert.equal(replay.data.idempotent_replay,true);assert.deepEqual(replay.data.resource,result.data.resource);
  assert.equal((await add({...added.body,device_name:"changed"},{key:added.key})).data.code,"IDEMPOTENCY_CONFLICT");
  assert.equal((await add({...added.body,expected_version:2})).data.code,"CREDENTIAL_TOKEN_CONFLICT");
  assert.equal((await add({...added.body,credential_id:randomUUID(),expected_version:2})).data.code,"CREDENTIAL_TOKEN_CONFLICT");
  const surfaces=JSON.stringify([result.data,(await db.prepare("SELECT payload_json FROM events WHERE type='owner.device-added'").all()).results,(await db.prepare("SELECT response_json FROM idempotency_records WHERE route_template=?1").bind(endpoint).all()).results]);
  assert.ok(!surfaces.includes(added.token));assert.ok(!surfaces.includes(added.body.token_digest));assert.equal(await auditCount(),1);
  const list=(await request(`/api/v1/admin/principals/${ownerId}/credentials`)).data.items;
  assert.equal(list.find(row=>row.id===added.body.credential_id).device_name,"新电脑");
});
test("同一Principal版本并发添加只提交一次，重放保留旧版本快照",async()=>{
  const devices=await Promise.all([device("parallel1"),device("parallel2")]);
  const results=await Promise.all(devices.map(d=>add(d.body)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(results.find(r=>r.status===409).data.code,"VERSION_CONFLICT");
  assert.equal((await owner()).version,3);
  const replay=await add(added.body,{key:added.key});assert.deepEqual(replay.data.resource,added.resource);assert.equal(await auditCount(),2);
});
test("当前设备不可自撤销，不可用专用接口撤销参与者；通用DELETE仍拒绝Owner",async()=>{
  const version=(await owner()).version;
  assert.equal((await revoke(originalCredentialId,version)).status,403);
  assert.equal((await revoke(actors[0].credentialId,version)).status,403);
  assert.equal((await request(`/api/v1/admin/credentials/${added.body.credential_id}?expected_version=1`,{method:"DELETE"})).status,403);
});
test("单独撤销只影响目标Credential及派生Session/Launch，保留其他设备和Passkey",async()=>{
  const targetSession=await session("credential",added.body.credential_id),otherSession=await session("credential",originalCredentialId);
  const passkeyId=randomUUID(),now=Date.now();
  await db.prepare("INSERT INTO web_authenticators(id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,created_operation_id) VALUES(?1,?2,?3,'key',-7,'user',0,0,?4,?5,?6)").bind(passkeyId,ownerId,randomUUID(),new URL(origin).hostname,now,randomUUID()).run();
  const passkeySession=await session("web_authenticator",passkeyId);
  const launchIds=[randomUUID(),randomUUID()];
  for(const [index,id] of launchIds.entries())await db.prepare("INSERT INTO browser_launches(id,code_prefix,code_digest,principal_id,source_credential_id,target_kind,target_json,expires_at,redeemed_at,created_at,created_operation_id) VALUES(?1,'fixture',?2,?3,?4,'admin',?5,?6,?7,?8,?9)")
    .bind(id,hash(id),ownerId,added.body.credential_id,JSON.stringify({kind:"admin",entry_path:"/app/admin",section:"overview"}),now+300000,index===1?now:null,now,randomUUID()).run();
  const version=(await owner()).version,key=randomUUID();
  const result=await revoke(added.body.credential_id,version,{key});assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.resource.principal_version,version+1);
  const replay=await revoke(added.body.credential_id,version,{key});assert.equal(replay.data.idempotent_replay,true);assert.deepEqual(replay.data.resource,result.data.resource);
  assert.equal((await request("/api/v1/me",{headers:{authorization:`Bearer ${added.token}`}})).status,401);
  assert.equal((await request("/api/v1/me",{headers:targetSession.headers})).status,401);
  for(const headers of [otherSession.headers,passkeySession.headers,{authorization:`Bearer ${ownerToken}`}])assert.equal((await request("/api/v1/me",{headers})).status,200);
  assert.equal((await db.prepare("SELECT revoked_at FROM web_sessions WHERE id=?1").bind(targetSession.id).first()).revoked_at!==null,true);
  assert.equal((await db.prepare("SELECT revoked_at FROM web_authenticators WHERE id=?1").bind(passkeyId).first()).revoked_at,null);
  assert.notEqual((await db.prepare("SELECT revoked_at FROM browser_launches WHERE id=?1").bind(launchIds[0]).first()).revoked_at,null);
  assert.equal((await db.prepare("SELECT revoked_at FROM browser_launches WHERE id=?1").bind(launchIds[1]).first()).revoked_at,null);
  assert.equal((await revoke(added.body.credential_id,version+1)).data.code,"CREDENTIAL_ALREADY_REVOKED");
});
test("安全审计故障回滚Credential和Principal版本",async()=>{
  const candidate=await device(),before=(await owner()).version,count=await auditCount();
  await db.prepare("CREATE TRIGGER owner_device_test_reject BEFORE INSERT ON events WHEN NEW.type='owner.device-added' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
  try{
    assert.equal((await add(candidate.body)).status,503);
    assert.equal((await owner()).version,before);assert.equal(await auditCount(),count);
    assert.equal(await db.prepare("SELECT id FROM credentials WHERE id=?1").bind(candidate.body.credential_id).first(),null);
  }finally{await db.prepare("DROP TRIGGER owner_device_test_reject").run();}
});
test("认证后源Credential撤销在原子guard中拒绝，不留下新增权限",async()=>{
  const candidate=await device(),before=(await owner()).version,count=await auditCount();let batches=0;
  const racedDb=new Proxy(db,{get(target,property){if(property==="batch")return async statements=>{
    if(++batches===2)await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(),originalCredentialId).run();
    return db.batch(statements);
  };const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;}});
  try{
    const result=await add(candidate.body,{overrideEnv:{...env,DB:racedDb}});assert.equal(result.status,401,JSON.stringify(result.data));
    assert.equal((await owner()).version,before);assert.equal(await auditCount(),count);
    assert.equal(await db.prepare("SELECT id FROM credentials WHERE id=?1").bind(candidate.body.credential_id).first(),null);
  }finally{await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(originalCredentialId).run();}
});
test("active上限100的并发guard拒绝第101份，历史撤销行不占额度",async()=>{
  const count=(await db.prepare("SELECT COUNT(*) n FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL").bind(ownerId).first()).n;
  const ids=[];
  for(let i=count;i<100;i++){
    const id=randomUUID();ids.push(id);
    await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'fixture',?3,?4,?5)").bind(id,ownerId,hash(id),Date.now(),randomUUID()).run();
  }
  try{const result=await add((await device()).body);assert.equal(result.data.code,"OWNER_CREDENTIAL_LIMIT_REACHED");}
  finally{for(const id of ids)await db.prepare("DELETE FROM credentials WHERE id=?1").bind(id).run();}
});
test("正常rotation保留设备名称并递增Principal版本，不影响另一设备",async()=>{
  const candidate=await device("Rotate Laptop"),created=await add(candidate.body);assert.equal(created.status,200);
  const before=(await owner()).version,replacement=makeToken();
  const result=await request("/api/v1/admin/owner-credentials/rotate",{method:"POST",body:{new_credential_token:replacement},headers:{authorization:`Bearer ${candidate.token}`}});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.resource.device_name,"Rotate Laptop");
  assert.equal((await owner()).version,before+1);assert.equal((await request("/api/v1/me")).status,200);
  assert.equal((await request("/api/v1/me",{headers:{authorization:`Bearer ${replacement}`}})).status,200);
});
test("全失恢复拒绝过期active集合，成功后保留Passkey并使全部旧设备失效",async()=>{
  const meta=await db.prepare("SELECT m.*,p.version AS principal_version,p.display_name,s.preferred_api_origin,s.version AS origin_version FROM instance_meta m JOIN principals p ON p.id=m.owner_principal_id JOIN instance_origin_settings s ON s.singleton=m.singleton").first();
  const active=(await db.prepare("SELECT id FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL ORDER BY id").bind(ownerId).all()).results.map(row=>row.id);
  const plan={operation_id:randomUUID(),credential_id:randomUUID(),event_id:randomUUID(),observed:{...meta,active_credential_ids:active}};
  const candidate=await device();assert.equal((await add(candidate.body)).status,200);
  const recoveredToken=makeToken(),metadata={token_prefix:recoveredToken.split("_")[2],token_digest:hash(recoveredToken)};
  const apply=async p=>db.batch(buildOwnerRecoveryBatch(p,metadata,Date.now()).map(s=>db.prepare(s.sql).bind(...s.params)));
  await apply(plan);
  assert.equal(await db.prepare("SELECT id FROM credentials WHERE id=?1").bind(plan.credential_id).first(),null);
  plan.observed.principal_version=(await owner()).version;
  plan.observed.active_credential_ids=(await db.prepare("SELECT id FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL ORDER BY id").bind(ownerId).all()).results.map(row=>row.id);
  await apply(plan);
  assert.equal((await request("/api/v1/me")).status,401);
  assert.equal((await request("/api/v1/me",{headers:{authorization:`Bearer ${candidate.token}`}})).status,401);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL").bind(ownerId).first()).n,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM web_authenticators WHERE principal_id=?1 AND revoked_at IS NULL").bind(ownerId).first()).n,1);
  ownerToken=recoveredToken;assert.equal((await request("/api/v1/me")).status,200);
});
test("两台设备并发互相撤销只成功一个操作，不会撤销双方",async()=>{
  const first=await device("First");assert.equal((await add(first.body)).status,200);
  const second=await device("Second");assert.equal((await add(second.body)).status,200);
  const version=(await owner()).version;
  const results=await Promise.all([
    revoke(second.body.credential_id,version,{headers:{authorization:`Bearer ${first.token}`}}),
    revoke(first.body.credential_id,version,{headers:{authorization:`Bearer ${second.token}`}}),
  ]);
  assert.equal(results.filter(result=>result.status===200).length,1,JSON.stringify(results));
  assert.ok(results.some(result=>[401,409].includes(result.status)),JSON.stringify(results));
  const active=await db.prepare("SELECT COUNT(*) n FROM credentials WHERE id IN (?1,?2) AND revoked_at IS NULL").bind(first.body.credential_id,second.body.credential_id).first();
  assert.equal(active.n,1);assert.equal((await owner()).version,version+1);
});
test("全失恢复发生在添加的认证和原子写之间，旧设备不能留下新权限或重放批准",async()=>{
  const meta=await db.prepare("SELECT m.*,p.version AS principal_version,p.display_name,s.preferred_api_origin,s.version AS origin_version FROM instance_meta m JOIN principals p ON p.id=m.owner_principal_id JOIN instance_origin_settings s ON s.singleton=m.singleton").first();
  const active=(await db.prepare("SELECT id FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL ORDER BY id").bind(ownerId).all()).results.map(row=>row.id);
  const plan={operation_id:randomUUID(),credential_id:randomUUID(),event_id:randomUUID(),observed:{...meta,active_credential_ids:active}};
  const replacement=makeToken(),metadata={token_prefix:replacement.split("_")[2],token_digest:hash(replacement)};
  const candidate=await device(),count=await auditCount();let batches=0;
  const racedDb=new Proxy(db,{get(target,property){if(property==="batch")return async statements=>{
    if(++batches===2)await db.batch(buildOwnerRecoveryBatch(plan,metadata,Date.now()).map(s=>db.prepare(s.sql).bind(...s.params)));
    return db.batch(statements);
  };const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;}});
  const result=await add(candidate.body,{overrideEnv:{...env,DB:racedDb}});assert.equal(result.status,401,JSON.stringify(result.data));
  assert.equal(await auditCount(),count);assert.equal((await owner()).version,meta.principal_version);
  assert.equal(await db.prepare("SELECT id FROM credentials WHERE id=?1").bind(candidate.body.credential_id).first(),null);
  assert.equal((await add(added.body,{key:added.key})).status,401);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL").bind(ownerId).first()).n,1);
  ownerToken=replacement;assert.equal((await request("/api/v1/me")).status,200);
});

const currentCredential = async () => (await request("/api/v1/me")).data.credential.id;
const activeCredentials = async () => (await db.prepare("SELECT id FROM credentials WHERE principal_id=?1 AND revoked_at IS NULL ORDER BY id").bind(ownerId).all()).results.map(row=>row.id);
async function passkeySession() {
  const passkey=await db.prepare("SELECT id FROM web_authenticators WHERE principal_id=?1 AND revoked_at IS NULL LIMIT 1").bind(ownerId).first();
  return {...await session("web_authenticator",passkey.id),sourceId:passkey.id};
}

test("Owner admin Cookie 批准与 Passkey Cookie 撤销支持幂等并记录非秘密审计来源",async()=>{
  const currentId=await currentCredential(),agentSession=await session("credential",currentId),passkey=await passkeySession();
  const candidate=await device("网页批准电脑"),key=randomUUID();
  const result=await add(candidate.body,{headers:agentSession.headers,key});
  assert.equal(result.status,200,JSON.stringify(result.data));
  const replay=await add(candidate.body,{headers:agentSession.headers,key});
  assert.equal(replay.data.idempotent_replay,true);assert.deepEqual(replay.data.resource,result.data.resource);
  const event=await db.prepare("SELECT actor_principal_id,actor_credential_id,payload_json FROM events WHERE type='owner.device-added' AND subject_id=?1").bind(candidate.body.credential_id).first();
  assert.equal(event.actor_principal_id,ownerId);assert.equal(event.actor_credential_id,currentId);
  const payload=JSON.parse(event.payload_json);
  assert.equal(payload.actor_session_id,agentSession.id);assert.deepEqual(payload.authentication_source,{kind:"credential",id:currentId});
  const surfaces=JSON.stringify([result.data,event,replay.data]);
  for(const secret of [candidate.token,candidate.body.token_digest,agentSession.token])assert.ok(!surfaces.includes(secret));
  assert.equal((await request("/api/v1/me",{headers:{authorization:`Bearer ${candidate.token}`}})).status,200);

  const list=(await request(`/api/v1/admin/principals/${ownerId}/credentials`,{headers:agentSession.headers})).data.items;
  assert.deepEqual(list.find(row=>row.id===currentId).allowed_actions,["rename_owner_device"]);
  assert.deepEqual(list.find(row=>row.id===candidate.body.credential_id).allowed_actions,["revoke_owner_device","rename_owner_device"]);
  const detail=(await request(`/api/v1/admin/principals/${ownerId}`,{headers:agentSession.headers})).data;
  assert.deepEqual(detail.credentials.find(row=>row.id===candidate.body.credential_id).allowed_actions,["revoke_owner_device","rename_owner_device"]);
  const passkeyList=(await request(`/api/v1/admin/principals/${ownerId}/credentials`,{headers:passkey.headers})).data.items;
  assert.deepEqual(passkeyList.find(row=>row.id===currentId).allowed_actions,["revoke_owner_device","rename_owner_device"]);
  assert.equal((await revoke(currentId,(await owner()).version,{headers:agentSession.headers})).status,403);
  assert.equal((await request(`/api/v1/admin/credentials/${candidate.body.credential_id}?expected_version=1`,{method:"DELETE",headers:passkey.headers})).status,403);
  assert.equal((await request("/api/v1/admin/owner-credentials/rotate",{method:"POST",headers:passkey.headers,body:{new_credential_token:makeToken()}})).status,401);

  const revokeKey=randomUUID(),version=(await owner()).version;
  const revoked=await revoke(candidate.body.credential_id,version,{headers:passkey.headers,key:revokeKey});
  assert.equal(revoked.status,200,JSON.stringify(revoked.data));
  const revokeReplay=await revoke(candidate.body.credential_id,version,{headers:passkey.headers,key:revokeKey});
  assert.equal(revokeReplay.data.idempotent_replay,true);assert.deepEqual(revokeReplay.data.resource,revoked.data.resource);
  const revokeEvent=await db.prepare("SELECT actor_credential_id,payload_json FROM events WHERE type='owner.device-revoked' AND subject_id=?1").bind(candidate.body.credential_id).first();
  assert.equal(revokeEvent.actor_credential_id,null);
  assert.equal(JSON.parse(revokeEvent.payload_json).actor_session_id,passkey.id);
  assert.deepEqual(JSON.parse(revokeEvent.payload_json).authentication_source,{kind:"web_authenticator",id:passkey.sourceId});
  assert.equal((await request("/api/v1/me",{headers:agentSession.headers})).status,200);
  assert.equal((await request("/api/v1/me",{headers:passkey.headers})).status,200);
  const finalList=(await request(`/api/v1/admin/principals/${ownerId}/credentials`,{headers:passkey.headers})).data.items;
  assert.ok(finalList.every(row=>row.revoked_at===null ? JSON.stringify(row.allowed_actions)===JSON.stringify(["rename_owner_device"]) : row.allowed_actions.length===0));
});

test("Cookie 新增和撤销均强制同源 CSRF，Bearer 维持现有无需 CSRF 语义",async()=>{
  const cookie=await passkeySession(),candidate=await device("CSRF target");
  assert.equal((await add(candidate.body)).status,200);
  const next=await device(),version=(await owner()).version,before=await auditCount();
  const missingHeader={...cookie.headers},missingOrigin={...cookie.headers};
  delete missingHeader["x-csrf-token"];delete missingOrigin.origin;
  const invalidHeaders=[missingHeader,missingOrigin,{...cookie.headers,origin:"https://other.example.test"},{...cookie.headers,"x-csrf-token":"D".repeat(32)},{...cookie.headers,cookie:`cfkanban_session=${cookie.token}`}];
  for(const headers of invalidHeaders){
    assert.equal((await add(next.body,{headers})).status,403);
    assert.equal((await revoke(candidate.body.credential_id,version,{headers})).status,403);
  }
  assert.equal(await auditCount(),before);assert.equal((await owner()).version,version);
  assert.equal((await revoke(candidate.body.credential_id,version)).status,200);
});

test("两个 Passkey Session 并发撤销仅余的两份 API Credential 后必须保留一份",async()=>{
  const originalId=await currentCredential(),candidate=await device("并发剩余设备");
  assert.equal((await add(candidate.body)).status,200);
  const [first,second]=await Promise.all([passkeySession(),passkeySession()]),version=(await owner()).version;
  const results=await Promise.all([
    revoke(originalId,version,{headers:first.headers}),
    revoke(candidate.body.credential_id,version,{headers:second.headers}),
  ]);
  assert.equal(results.filter(result=>result.status===200).length,1,JSON.stringify(results));
  assert.equal(results.filter(result=>result.status===409).length,1,JSON.stringify(results));
  const active=await activeCredentials();assert.equal(active.length,1);
  if(active[0]===candidate.body.credential_id)ownerToken=candidate.token;
  assert.equal((await revoke(active[0],(await owner()).version,{headers:first.headers})).status,403);
  assert.equal((await activeCredentials()).length,1);
});

test("独立 Passkey 不能在零 API Credential 状态添加设备，也不能在提交竞态中绕过限制",async()=>{
  const cookie=await passkeySession(),candidate=await device(),active=await activeCredentials(),before=(await owner()).version,count=await auditCount();
  const revokeAll=()=>db.prepare("UPDATE credentials SET revoked_at=?1 WHERE principal_id=?2 AND revoked_at IS NULL").bind(Date.now(),ownerId).run();
  const restore=async()=>{for(const id of active)await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(id).run();};
  try{
    await revokeAll();
    assert.equal((await request("/api/v1/me",{headers:cookie.headers})).status,200);
    assert.equal((await add(candidate.body,{headers:cookie.headers})).status,403);
  }finally{await restore();}
  let batches=0;
  const racedDb=new Proxy(db,{get(target,property){if(property==="batch")return async statements=>{
    if(++batches===2)await revokeAll();
    return db.batch(statements);
  };const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;}});
  try{
    const result=await add(candidate.body,{headers:cookie.headers,overrideEnv:{...env,DB:racedDb}});
    assert.equal(result.status,403,JSON.stringify(result.data));
    assert.equal((await owner()).version,before);assert.equal(await auditCount(),count);
    assert.equal(await db.prepare("SELECT id FROM credentials WHERE id=?1").bind(candidate.body.credential_id).first(),null);
  }finally{await restore();}
});

test("撤销提交前另一份凭据失效时，原子 guard 保护最后一份目标",async()=>{
  const cookie=await passkeySession(),currentId=await currentCredential(),candidate=await device();
  assert.equal((await add(candidate.body)).status,200);
  const version=(await owner()).version,count=await auditCount();let batches=0;
  const racedDb=new Proxy(db,{get(target,property){if(property==="batch")return async statements=>{
    if(++batches===2)await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(),currentId).run();
    return db.batch(statements);
  };const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;}});
  try{
    const result=await revoke(candidate.body.credential_id,version,{headers:cookie.headers,overrideEnv:{...env,DB:racedDb}});
    assert.equal(result.status,403,JSON.stringify(result.data));
    assert.equal((await owner()).version,version);assert.equal(await auditCount(),count);
    assert.deepEqual(await activeCredentials(),[candidate.body.credential_id]);
  }finally{await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(currentId).run();}
  assert.equal((await revoke(candidate.body.credential_id,version)).status,200);
});

test("Cookie 来源、Session 过期和管理范围在原子提交前漂移时不留下新增权限",async()=>{
  const candidate=await device(),count=await auditCount(),before=(await owner()).version,currentId=await currentCredential();
  const cases=[
    {name:"session revoke",status:401,change:cookie=>db.prepare("UPDATE web_sessions SET revoked_at=?1 WHERE id=?2").bind(Date.now(),cookie.id).run()},
    {name:"session expire",status:401,change:cookie=>db.prepare("UPDATE web_sessions SET created_at=0,expires_at=1 WHERE id=?1").bind(cookie.id).run()},
    {name:"session scope",status:403,change:cookie=>db.prepare("UPDATE web_sessions SET target_kind='project_selection',target_json=?1 WHERE id=?2").bind(JSON.stringify({kind:"project_selection",entry_path:"/app"}),cookie.id).run()},
    {name:"passkey revoke",status:401,change:cookie=>db.prepare("UPDATE web_authenticators SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(Date.now(),ownerId,cookie.sourceId).run(),restore:cookie=>db.prepare("UPDATE web_authenticators SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(cookie.sourceId).run()},
    {name:"credential source revoke",status:401,create:()=>session("credential",currentId),change:()=>db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(),currentId).run(),restore:()=>db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(currentId).run()},
  ];
  for(const item of cases){
    const cookie=await (item.create??passkeySession)();let batches=0;
    const racedDb=new Proxy(db,{get(target,property){if(property==="batch")return async statements=>{
      if(++batches===2)await item.change(cookie);
      return db.batch(statements);
    };const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;}});
    try{
      const result=await add(candidate.body,{headers:cookie.headers,overrideEnv:{...env,DB:racedDb}});
      assert.equal(result.status,item.status,`${item.name}: ${JSON.stringify(result.data)}`);
      assert.equal((await owner()).version,before,item.name);assert.equal(await auditCount(),count,item.name);
      assert.equal(await db.prepare("SELECT id FROM credentials WHERE id=?1").bind(candidate.body.credential_id).first(),null);
    }finally{await item.restore?.(cookie);}
  }
});

test("Cookie 已成功批准在认证来源撤销后不能幂等重放，审计失败保持原子回滚",async()=>{
  const cookie=await passkeySession(),candidate=await device(),key=randomUUID();
  assert.equal((await add(candidate.body,{headers:cookie.headers,key})).status,200);
  await db.prepare("UPDATE web_sessions SET revoked_at=?1 WHERE id=?2").bind(Date.now(),cookie.id).run();
  assert.equal((await add(candidate.body,{headers:cookie.headers,key})).status,401);
  assert.equal((await revoke(candidate.body.credential_id,(await owner()).version)).status,200);
  const freshCookie=await passkeySession(),next=await device(),before=(await owner()).version,count=await auditCount();
  await db.prepare("CREATE TRIGGER owner_web_device_test_reject BEFORE INSERT ON events WHEN NEW.type='owner.device-added' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
  try{
    assert.equal((await add(next.body,{headers:freshCookie.headers})).status,503);
    assert.equal((await owner()).version,before);assert.equal(await auditCount(),count);
    assert.equal(await db.prepare("SELECT id FROM credentials WHERE id=?1").bind(next.body.credential_id).first(),null);
  }finally{await db.prepare("DROP TRIGGER owner_web_device_test_reject").run();}
});

test("Cookie 撤销审计失败回滚目标及其派生 Session 与 Principal 版本",async()=>{
  const cookie=await passkeySession(),candidate=await device();
  assert.equal((await add(candidate.body)).status,200);
  const targetSession=await session("credential",candidate.body.credential_id),version=(await owner()).version,count=await auditCount();
  await db.prepare("CREATE TRIGGER owner_web_revoke_test_reject BEFORE INSERT ON events WHEN NEW.type='owner.device-revoked' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
  try{
    assert.equal((await revoke(candidate.body.credential_id,version,{headers:cookie.headers})).status,503);
    assert.equal((await owner()).version,version);assert.equal(await auditCount(),count);
    assert.equal((await request("/api/v1/me",{headers:{authorization:`Bearer ${candidate.token}`}})).status,200);
    assert.equal((await request("/api/v1/me",{headers:targetSession.headers})).status,200);
  }finally{await db.prepare("DROP TRIGGER owner_web_revoke_test_reject").run();}
  assert.equal((await revoke(candidate.body.credential_id,version,{headers:cookie.headers})).status,200);
});


test("为最后一份当前 Owner Credential 补名保留 secret、身份、会话和授权，幂等结果独立于后续改名",async()=>{
  const id=await currentCredential(),cookie=await session("credential",id),passkey=await passkeySession();
  const before=await db.prepare("SELECT * FROM credentials WHERE id=?1").bind(id).first();
  const me=(await request("/api/v1/me")).data,version=me.version,key=randomUUID(),count=await auditCount();
  const changed=await rename(id,"  工作电脑 💻  ",version,{key});
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  assert.equal(changed.data.resource.device_name,"工作电脑 💻");assert.equal(changed.data.resource.principal_version,version+1);
  const after=await db.prepare("SELECT * FROM credentials WHERE id=?1").bind(id).first();
  for(const field of ["id","principal_id","token_prefix","token_digest","issued_at","revoked_at","revoke_reason"])assert.equal(after[field],before[field],field);
  for(const headers of [{authorization:`Bearer ${ownerToken}`},cookie.headers,passkey.headers]){
    const current=await request("/api/v1/me",{headers});assert.equal(current.status,200);
    assert.equal(current.data.principal_id,ownerId);assert.equal(current.data.is_owner,true);
  }
  const replay=await rename(id,"工作电脑 💻",version,{key});
  assert.equal(replay.data.idempotent_replay,true);assert.deepEqual(replay.data.resource,changed.data.resource);
  assert.equal((await rename(id,"其他名称",version,{key})).data.code,"IDEMPOTENCY_CONFLICT");
  assert.equal((await rename(id,"旧版本名称",version)).data.code,"VERSION_CONFLICT");
  assert.equal(await auditCount(),count+1);
  const second=await rename(id,"新的名称",version+1,{headers:cookie.headers});assert.equal(second.status,200);
  assert.deepEqual((await rename(id,"工作电脑 💻",version,{key})).data.resource,changed.data.resource);
  const list=(await request(`/api/v1/admin/principals/${ownerId}/credentials`)).data.items;
  assert.equal(list.find(row=>row.id===id).device_name,"新的名称");
  const event=await db.prepare("SELECT actor_credential_id,payload_json FROM events WHERE type='owner.device-renamed' ORDER BY sequence DESC LIMIT 1").first();
  assert.equal(event.actor_credential_id,id);assert.equal(JSON.parse(event.payload_json).actor_session_id,cookie.id);
  const surfaces=JSON.stringify([changed.data,replay.data,event]);
  for(const secret of [ownerToken,before.token_digest,cookie.token])assert.ok(!surfaces.includes(secret));
});

test("改名复用名称校验并拒绝越权、未知或撤销目标及缺失幂等键",async()=>{
  const id=await currentCredential(),version=(await owner()).version,count=await auditCount();
  const credential=await db.prepare("SELECT token_digest FROM credentials WHERE id=?1").bind(id).first();
  for(const name of [null,"","  ","机".repeat(81),"work\u0000name","work\u202ename",ownerToken,credential.token_digest])assert.equal((await rename(id,name,version)).status,400);
  assert.equal((await rename(id,"valid",version,{key:null})).status,400);
  assert.equal((await request(`/api/v1/admin/owner-credentials/${id}/rename`,{method:"POST",body:{device_name:"valid",expected_version:version,extra:true}})).status,400);
  assert.equal((await rename(randomUUID(),"valid",version)).status,404);
  assert.equal((await rename(actors[0].credentialId,"valid",version)).status,403);
  assert.equal((await rename(added.body.credential_id,"valid",version)).data.code,"CREDENTIAL_ALREADY_REVOKED");
  assert.equal((await rename(id,"valid",version,{headers:{}})).status,401);
  for(const actor of actors){
    assert.equal((await rename(id,"valid",version,{headers:{authorization:`Bearer ${actor.token}`}})).status,403);
    const cookie=await session("credential",actor.credentialId,"admin",{kind:"admin",entry_path:"/app/admin",section:"access"},actor.id);
    assert.equal((await rename(id,"valid",version,{headers:cookie.headers})).status,403);
  }
  const narrow=await session("credential",id,"project_selection",{kind:"project_selection",entry_path:"/app"});
  assert.equal((await rename(id,"valid",version,{headers:narrow.headers})).status,403);
  const cookie=await passkeySession(),missing={...cookie.headers};delete missing["x-csrf-token"];
  for(const headers of [missing,{...cookie.headers,origin:"https://other.example"}])assert.equal((await rename(id,"valid",version,{headers})).status,403);
  assert.equal(await auditCount(),count);assert.equal((await owner()).version,version);
  const accepted=await rename(id,"💻".repeat(80),version,{headers:cookie.headers});assert.equal(accepted.status,200,JSON.stringify(accepted.data));
  const event=await db.prepare("SELECT actor_credential_id,payload_json FROM events WHERE type='owner.device-renamed' ORDER BY sequence DESC LIMIT 1").first();
  assert.equal(event.actor_credential_id,null);assert.deepEqual(JSON.parse(event.payload_json).authentication_source,{kind:"web_authenticator",id:cookie.sourceId});
});

test("改名与其他设备操作共享 Principal CAS，正常轮换保留改名",async()=>{
  const candidate=await device("before rename");assert.equal((await add(candidate.body)).status,200);
  const version=(await owner()).version,id=candidate.body.credential_id,currentId=await currentCredential();
  const results=await Promise.all([rename(id,"after rename",version),rename(currentId,"parallel name",version)]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  if(results[0].status!==200)assert.equal((await rename(id,"after rename",(await owner()).version)).status,200);
  const replacement=makeToken();
  const rotated=await request("/api/v1/admin/owner-credentials/rotate",{method:"POST",body:{new_credential_token:replacement},headers:{authorization:`Bearer ${candidate.token}`}});
  assert.equal(rotated.status,200);assert.equal(rotated.data.resource.device_name,"after rename");
  assert.equal((await request("/api/v1/me")).status,200);
});

test("改名提交成功但响应读回丢失后原请求恢复一次结果与审计",async()=>{
  const id=await currentCredential(),version=(await owner()).version,key=randomUUID(),count=await auditCount();let failed=false;
  const interruptedDb=new Proxy(db,{get(target,property){
    if(property==="prepare")return sql=>{
      const statement=db.prepare(sql);
      if(sql.includes("SELECT operation_snapshot_json")&&!failed)return new Proxy(statement,{get(stmt,method){
        if(method==="bind")return(...values)=>{const bound=stmt.bind(...values);return new Proxy(bound,{get(item,action){
          if(action==="first")return async()=>{failed=true;throw new Error("synthetic lost readback");};
          const value=Reflect.get(item,action,item);return typeof value==="function"?value.bind(item):value;
        }});};
        const value=Reflect.get(stmt,method,stmt);return typeof value==="function"?value.bind(stmt):value;
      }});
      return statement;
    };
    const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
  }});
  const unknown=await rename(id,"恢复后名称",version,{key,overrideEnv:{...env,DB:interruptedDb}});
  assert.equal(unknown.status,503,JSON.stringify(unknown.data));assert.equal((await owner()).version,version+1);
  const recovered=await rename(id,"恢复后名称",version,{key});
  assert.equal(recovered.status,200,JSON.stringify(recovered.data));assert.equal(recovered.data.idempotent_replay,true);
  assert.equal(recovered.data.resource.device_name,"恢复后名称");assert.equal(await auditCount(),count+1);
});

test("改名审计失败回滚名称与版本，提交前撤销目标或认证来源时原子拒绝",async()=>{
  const id=await currentCredential(),version=(await owner()).version,count=await auditCount();
  const original=(await db.prepare("SELECT device_name FROM credentials WHERE id=?1").bind(id).first()).device_name;
  await db.prepare("CREATE TRIGGER owner_rename_test_reject BEFORE INSERT ON events WHEN NEW.type='owner.device-renamed' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
  try{assert.equal((await rename(id,"failed audit",version)).status,503);}
  finally{await db.prepare("DROP TRIGGER owner_rename_test_reject").run();}
  assert.equal((await owner()).version,version);assert.equal(await auditCount(),count);
  assert.equal((await db.prepare("SELECT device_name FROM credentials WHERE id=?1").bind(id).first()).device_name,original);
  for(const kind of ["target","session scope","session revoked"]){
    const cookie=await passkeySession();let batches=0;
    const racedDb=new Proxy(db,{get(target,property){if(property==="batch")return async statements=>{
      if(++batches===2){
        if(kind==="target")await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(),id).run();
        else if(kind==="session scope")await db.prepare("UPDATE web_sessions SET target_kind='project_selection',target_json=?1 WHERE id=?2").bind(JSON.stringify({kind:"project_selection",entry_path:"/app"}),cookie.id).run();
        else await db.prepare("UPDATE web_sessions SET revoked_at=?1 WHERE id=?2").bind(Date.now(),cookie.id).run();
      }
      return db.batch(statements);
    };const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;}});
    try{
      const result=await rename(id,"race",version,{headers:cookie.headers,overrideEnv:{...env,DB:racedDb}});
      assert.equal(result.status,kind==="target"?409:kind==="session scope"?403:401,JSON.stringify(result.data));
      assert.equal((await owner()).version,version);assert.equal(await auditCount(),count);
      assert.equal((await db.prepare("SELECT device_name FROM credentials WHERE id=?1").bind(id).first()).device_name,original);
    }finally{if(kind==="target")await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(id).run();}
  }
});
