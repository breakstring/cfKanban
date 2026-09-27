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
const auditCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('owner.device-added','owner.device-revoked')").first()).n;
async function session(sourceKind,sourceId,targetKind="admin",target={kind:"admin",entry_path:"/app/admin",section:"overview"}) {
  const token=randomBytes(32).toString("base64url"),id=randomUUID(),now=Date.now();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")
    .bind(id,hash(token),ownerId,sourceKind,sourceId,targetKind,JSON.stringify(target),now+3600000,now).run();
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

test("历史凭据名称为空；未认证、参与者、局部管理员及全部 Owner Web Session 均不能添加/撤销",async()=>{
  const body=(await device()).body;
  const list=(await request(`/api/v1/admin/principals/${ownerId}/credentials`)).data;
  assert.equal(list.items[0].device_name,null);
  assert.equal((await add(body,{headers:{}})).status,401);
  for(const actor of actors){
    const headers={authorization:`Bearer ${actor.token}`};
    assert.equal((await add(body,{headers})).status,403,actor.role);
    assert.equal((await revoke(originalCredentialId,1,{headers})).status,403,actor.role);
  }
  const cookie=await session("credential",originalCredentialId);
  assert.equal((await request("/api/v1/me",{headers:cookie.headers})).status,200);
  assert.equal((await add(body,{headers:cookie.headers})).status,403);
  assert.equal((await revoke(originalCredentialId,1,{headers:cookie.headers})).status,403);
  const project=await db.prepare("SELECT id,workspace_id FROM projects LIMIT 1").first();
  const scoped=await session("credential",originalCredentialId,"project",{kind:"project",workspace_id:project.workspace_id,project_id:project.id,entry_path:`/app/w/${project.workspace_id}/p/${project.id}`});
  assert.equal((await request("/api/v1/me",{headers:scoped.headers})).status,200);
  assert.equal((await add(body,{headers:scoped.headers})).status,403);
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
  assert.equal((await add((await device()).body,{headers:passkeySession.headers})).status,403);
  assert.equal((await revoke(added.body.credential_id,version,{headers:passkeySession.headers})).status,403);
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
