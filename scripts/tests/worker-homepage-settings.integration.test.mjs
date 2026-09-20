import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";

// Wrangler harness uses an isolated local D1; all tokens are synthetic fixture values.
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker();
const token = `cfk_v1_owner_${"A".repeat(43)}`;
const ownerId = randomUUID(), credentialId = randomUUID(), hash = value => createHash("sha256").update(value).digest("hex");
const actors = ["reader", "writer", "workspace_admin", "project_admin"].map((role, index) => ({role, id:randomUUID(), token:`cfk_v1_${role.replaceAll("_", "")}_${String.fromCharCode(66+index).repeat(43)}`}));
let env, db, workspace, project;
const endpoint = "/api/v1/admin/homepage-settings";
const discovery = "/.well-known/cfkanban-instance.json";
async function request(path, {method="GET", body, key=randomUUID(), headers={authorization:`Bearer ${token}`}, overrideEnv=env}={}) {
  const response=await fetchWorker(new Request(`https://settings.example.test${path}`, {method,headers:{...headers,...(key?{"idempotency-key":key}:{}),...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}),overrideEnv);
  return {status:response.status,data:await response.json(),response};
}
const settings = () => request(endpoint);
const patch = (body, extra={}) => request(endpoint,{method:"PATCH",body,...extra});
const auditCount = async () => (await db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='instance.homepage-settings-updated'").first()).count;
const notices = (version, en, zh=null) => ({expected_version:version,notice_en:en,notice_zh_cn:zh});
before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); env=await worker.getEnv(); db=env.DB;
  await bootstrapInstance(db,{instanceId:randomUUID(),operationId:randomUUID(),ownerCredentialId:credentialId,ownerCredentialToken:token,ownerDisplayName:"Settings_Owner",ownerPrincipalId:ownerId,preferredApiOrigin:"https://settings.example.test"});
  workspace=(await request("/api/v1/workspaces",{method:"POST",body:{display_name:"Settings"}})).data.resource;
  project=(await request(`/api/v1/workspaces/${workspace.id}/projects`,{method:"POST",body:{display_name:"Settings"}})).data.resource;
  for (const actor of actors) {
    const now=Date.now();
    await db.batch([
      db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?2,?3,?3)").bind(actor.id,actor.role,now),
      db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,?3,?4,?5,?6)").bind(randomUUID(),actor.id,actor.token.split("_")[2],hash(actor.token),now,randomUUID()),
    ]);
    if (actor.role.endsWith("admin")) {
      await db.prepare("INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,version,generation,created_at,updated_at,created_operation_id,last_operation_id) VALUES(?1,?2,?3,?4,1,?5,?6,?6,?7,?7)")
        .bind(randomUUID(),actor.id,workspace.id,actor.role==="project_admin"?project.id:null,randomUUID(),now,randomUUID()).run();
    } else {
      await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,?4,?5,?5,?6)").bind(randomUUID(),actor.id,project.id,actor.role,now,randomUUID()).run();
    }
  }
});
after(() => server.close());

test("首页配置缺省为空；公开发现仅包含两种文案并禁止缓存",async()=>{
  const result=await settings(); assert.equal(result.status,200); assert.equal(result.response.headers.get("cache-control"),"no-store");
  assert.deepEqual(result.data,{notice_en:null,notice_zh_cn:null,version:1});
  const publicResult=await request(discovery,{headers:{}}); assert.equal(publicResult.status,200);
  assert.equal(publicResult.response.headers.get("cache-control"),"no-store");
  assert.deepEqual(publicResult.data.homepage_notice,{en:null,"zh-CN":null});
  for (const forbidden of ["version","last_operation_id","owner_principal_id","credential"]) assert.ok(!(forbidden in publicResult.data));
});
test("只有唯一 Owner 的实例控制范围可读写，普通成员及两级管理员均拒绝",async()=>{
  assert.equal((await request(endpoint,{headers:{}})).status,401);
  for (const actor of actors) {
    const headers={authorization:`Bearer ${actor.token}`};
    assert.equal((await request(endpoint,{headers})).status,403,actor.role);
    assert.equal((await patch(notices(1,"denied"),{headers})).status,403,actor.role);
  }
  assert.equal(await auditCount(),0);
});
test("字段、长度、类型及幂等键验证拒绝无效输入",async()=>{
  for (const value of [0,-1,true,{},[],"😀".repeat(501),`\0${"x".repeat(500)}`]) {
    assert.equal((await patch(notices(1,value))).status,400);
    assert.equal((await patch(notices(1,null,value))).status,400);
  }
  for (const body of [{expected_version:1,notice_en:"x"},{expected_version:1,notice_zh_cn:"x"},notices(0,"x"),{...notices(1,"x"),extra:"bad"}]) assert.equal((await patch(body)).status,400);
  assert.equal((await patch(notices(1,"x"),{key:null})).status,400);
  assert.equal((await settings()).data.version,1);
});
test("Owner Cookie 写入要求 CSRF，幂等重放保留一次版本和安全审计",async()=>{
  const session="S".repeat(43),csrf="C".repeat(32),now=Date.now();
  await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES(?1,?2,?3,'credential',?4,'admin',?5,?6,?7)")
    .bind(randomUUID(),hash(session),ownerId,credentialId,JSON.stringify({kind:"admin",entry_path:"/app/admin",section:"overview"}),now+3600000,now).run();
  const cookie={cookie:`cfkanban_session=${session}; cfkanban_csrf=${csrf}`};
  assert.equal((await request(endpoint,{headers:cookie})).status,200);
  const body=notices(1,"  Public test  "," 公开测试 "),key=randomUUID();
  assert.equal((await patch(body,{headers:cookie})).status,403);
  assert.equal((await patch(body,{headers:{...cookie,origin:"https://attacker.example.test","x-csrf-token":csrf}})).status,403);
  const headers={...cookie,origin:"https://settings.example.test","x-csrf-token":csrf};
  const changed=await patch(body,{headers,key}); assert.equal(changed.status,200,JSON.stringify(changed.data));
  assert.deepEqual(changed.data.resource,{notice_en:"Public test",notice_zh_cn:"公开测试",version:2});
  const replay=await patch(body,{headers,key}); assert.equal(replay.data.idempotent_replay,true); assert.equal(replay.data.resource.version,2);
  assert.equal((await patch(notices(1,"other"),{headers,key})).data.code,"IDEMPOTENCY_CONFLICT");
  const audit=await db.prepare("SELECT * FROM events WHERE type='instance.homepage-settings-updated'").all();
  assert.equal(audit.results.length,1); assert.equal(audit.results[0].stream,"security"); assert.equal(audit.results[0].authorized_via,"deployment_owner");
  await db.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE token_digest=?2").bind(JSON.stringify({kind:"project",workspace_id:workspace.id,project_id:project.id,entry_path:`/app/w/${workspace.id}/p/${project.id}`}),hash(session)).run();
  assert.equal((await request(endpoint,{headers})).status,403);
  assert.equal((await patch(notices(2,"denied"),{headers})).status,403);
  assert.equal((await patch(body,{headers,key})).status,403);
});
test("CAS 并发仅允许一次更新，旧幂等响应不读取后续资源值",async()=>{
  const version=(await settings()).data.version,keys=[randomUUID(),randomUUID()],bodies=[notices(version,"first"),notices(version,"second")];
  const results=await Promise.all(bodies.map((body,index)=>patch(body,{key:keys[index]})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]); assert.equal(results.find(r=>r.status===409).data.code,"VERSION_CONFLICT");
  const winner=results.findIndex(r=>r.status===200);
  assert.equal((await settings()).data.version,version+1);
  assert.equal(await auditCount(),2);
  assert.equal((await patch(notices(version+1,"later"))).status,200);
  const replay=await patch(bodies[winner],{key:keys[winner]}); assert.equal(replay.data.idempotent_replay,true);
  assert.deepEqual(replay.data.resource,results[winner].data.resource);
  assert.equal(await auditCount(),3);
});
test("Unicode 上限可保存，纯文本不被解释，空字符串恢复默认",async()=>{
  let version=(await settings()).data.version;
  const en="😀".repeat(500),zh='<script>alert("x")</script> **文字**';
  const changed=await patch(notices(version,en,zh)); assert.equal(changed.status,200,JSON.stringify(changed.data));
  assert.deepEqual((await request(discovery,{headers:{}})).data.homepage_notice,{en,"zh-CN":zh});
  const cleared=await patch(notices(changed.data.resource.version," \n ",null)); assert.equal(cleared.status,200);
  assert.deepEqual((await request(discovery,{headers:{}})).data.homepage_notice,{en:null,"zh-CN":null});
});
test("安全事件失败使设置、版本和审计整个原子操作回滚",async()=>{
  const before=(await settings()).data,count=await auditCount();
  await db.prepare("CREATE TRIGGER homepage_test_reject BEFORE INSERT ON events WHEN NEW.type='instance.homepage-settings-updated' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
  try {
    const result=await patch(notices(before.version,"must roll back")); assert.ok(result.status>=500,JSON.stringify(result.data));
    assert.deepEqual((await settings()).data,before); assert.equal(await auditCount(),count);
  } finally { await db.prepare("DROP TRIGGER homepage_test_reject").run(); }
});
test("认证检查后撤销源凭据仍在原子写入时拒绝，不留下设置或审计",async()=>{
  const before=(await settings()).data,count=await auditCount();
  let batches=0;
  const racedDb=new Proxy(db,{get(target,property){
    if(property==="batch") return async statements=>{
      if(++batches===2) await db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(Date.now(),credentialId).run();
      return db.batch(statements);
    };
    const value=Reflect.get(target,property,target); return typeof value==="function"?value.bind(target):value;
  }});
  try {
    const result=await patch(notices(before.version,"revoked"),{overrideEnv:{...env,DB:racedDb}});
    assert.equal(result.status,401,JSON.stringify(result.data)); assert.equal(batches,2);
    assert.deepEqual(await db.prepare("SELECT notice_en,notice_zh_cn,version FROM homepage_settings WHERE singleton=1").first(),before);
    assert.equal(await auditCount(),count);
  } finally { await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(credentialId).run(); }
});
