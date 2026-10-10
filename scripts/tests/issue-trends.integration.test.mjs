import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { createMilestone } from "../../apps/worker/src/services/milestones.ts";
import { createIssue, deleteIssue, restoreIssue, updateIssue } from "../../apps/worker/src/services/issues.ts";
import { completeIssue } from "../../apps/worker/src/services/comments.ts";
import { getProjectIssueTrends, getWorkspaceIssueTrends } from "../../apps/worker/src/services/issue-trends.ts";
import { backfillIssueTrends } from "../../apps/worker/src/services/issue-trend-projection.ts";
import { getPurgePreview, purgeContainer } from "../../apps/worker/src/services/container-purge.ts";

// Wrangler harness 固定 localhost、persist:false 和全零D1 ID；不连接线上或加载线上凭据。
const server=createTestHarness({root:fileURLToPath(new URL('../../',import.meta.url)),workers:[{configPath:'wrangler.wp02-test.jsonc'}]});
const owner=randomUUID(), credential=randomUUID(), member=randomUUID(), memberCredential=randomUUID(), grant=randomUUID();
const workspace=randomUUID(), otherWorkspace=randomUUID(), project=randomUUID(), peer=randomUUID(), historical=randomUUID(), empty=randomUUID();
const token=`cfk_v1_trend_${'A'.repeat(43)}`, origin='https://trends.example.test';
const auth={kind:'bearer',isOwner:true,principalId:owner,credentialId:credential,credentialFingerprint:'synthetic',displayName:'TrendOwner',principalVersion:1};
const reader={...auth,isOwner:false,principalId:member,credentialId:memberCredential};
const request=(key=randomUUID())=>new Request(`${origin}/api/v1/test`,{method:'POST',headers:{'idempotency-key':key,authorization:`Bearer ${token}`}});
const url=(params={})=>{const value=new URL(`${origin}/api/v1/test`);for(const[key,items]of Object.entries(params))for(const item of Array.isArray(items)?items:[items])value.searchParams.append(key,item);return value;};
const code=value=>error=>error.code===value;
async function administrator(workspaceId=workspace,projectId=null){
  const existing=await db.prepare('SELECT id FROM scoped_administrator_grants WHERE principal_id=?1 AND workspace_id=?2 AND project_id IS ?3').bind(member,workspaceId,projectId).first();
  const id=existing?.id??randomUUID(),generation=randomUUID();
  if(existing===null)await db.prepare('INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,?4,?5,1,1,?6)').bind(id,member,workspaceId,projectId,generation,randomUUID()).run();
  else await db.prepare('UPDATE scoped_administrator_grants SET generation=?1,version=version+1,revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?2').bind(generation,id).run();
  return {...reader,managementGrants:[await db.prepare('SELECT * FROM scoped_administrator_grants WHERE id=?1').bind(id).first()]};
}
const revokeAdministrator=context=>db.prepare('UPDATE scoped_administrator_grants SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3').bind(now,owner,context.managementGrants[0].id).run();
let db, now, dayStart;
const at=offset=>dayStart+offset*86400000+43200000;
const projectTrends=(id=project,params={},context=auth,database=db)=>getProjectIssueTrends(database,context,workspace,id,url(params),now);
const workspaceTrends=(params={},context=auth,database=db)=>getWorkspaceIssueTrends(database,context,workspace,url(params),now);
const create=async(value={},id=project,time=now,key=randomUUID())=>(await createIssue(db,request(key),auth,workspace,id,{title:'Trend issue',...value},time)).resource;
const update=async(issue,value,time=now)=>(await updateIssue(db,auth,issue.identifier,value,issue.version,time)).resource;
const complete=async(issue,time=now,key=randomUUID())=>(await completeIssue(db,request(key),auth,issue.identifier,issue.version,{summary:'完成',verification:[],artifacts:[],follow_ups:[]},time)).resource;
before(async()=>{
  await server.listen();await server.getWorker().applyD1Migrations('DB');({DB:db}=await server.getWorker().getEnv());now=Date.now();dayStart=Date.parse(new Date(now).toISOString().slice(0,10));
  await bootstrapInstance(db,{instanceId:randomUUID(),operationId:randomUUID(),ownerPrincipalId:owner,ownerCredentialId:credential,ownerCredentialToken:token,ownerDisplayName:'TrendOwner',preferredApiOrigin:origin});
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'TrendReader','trendreader',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,1,?4)").bind(memberCredential,member,'b'.repeat(64),randomUUID()).run();
  for(const id of[workspace,otherWorkspace])await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Trend workspace',?2,?2,?3,?3,?4)").bind(id,at(-10),owner,randomUUID()).run();
  for(const id of[project,peer,historical,empty])await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Trend project',?3,?3,?4,?4,?5)").bind(id,workspace,at(-10),owner,randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)").bind(grant,member,project,randomUUID()).run();
});
after(()=>server.close());

test('stock and flow distinguish canceled, repeated completion, reopening, restore and optional milestone membership',async()=>{
  const m=(await createMilestone(db,request(),auth,workspace,project,{title:'Trend milestone'},at(-4))).resource;
  let a=await create({milestone_id:m.id,status_key:'todo'},project,at(-4));
  const key=randomUUID();const b=await create({status_key:'canceled'},project,at(-3),key);await create({status_key:'canceled'},project,at(-3),key);
  a=await complete(a,at(-3));a=await update(a,{status_key:'todo'},at(-2));a=await complete(a,at(-1));
  a=await update(a,{milestone_id:null},at(-1));a=(await deleteIssue(db,auth,a.identifier,a.version,at(-1))).resource;
  a=(await restoreIssue(db,request(),auth,a.identifier,a.version,now)).resource;
  const result=await projectTrends(project,{days:'5'});
  assert.deepEqual(result.points.map(({total,done,canceled,unfinished,created,completed,reopened})=>({total,done,canceled,unfinished,created,completed,reopened})),[
    {total:1,done:0,canceled:0,unfinished:1,created:1,completed:0,reopened:0},
    {total:2,done:1,canceled:1,unfinished:0,created:1,completed:1,reopened:0},
    {total:2,done:0,canceled:1,unfinished:1,created:0,completed:0,reopened:1},
    {total:1,done:0,canceled:1,unfinished:0,created:0,completed:1,reopened:0},
    {total:2,done:1,canceled:1,unfinished:0,created:0,completed:0,reopened:0},
  ]);
  const node=await projectTrends(project,{days:'5',milestone:m.id});
  assert.deepEqual(node.points.map(point=>[point.total,point.done,point.completed]),[[1,0,0],[1,1,1],[1,0,0],[0,0,1],[0,0,0]]);
  assert.deepEqual(node.scope.project_ids,[project]);assert.equal(node.scope.milestone_id,m.id);
  assert.equal(result.timezone,'UTC');assert.equal(result.projects[0].history_state,'complete');
  assert.equal((await projectTrends(empty,{days:'365'})).points.length,365);
  await assert.rejects(update(b,{status_key:'done'}),code('INVALID_TRANSITION'));
});
test('initial done is stock only; parent and child count independently',async()=>{
  const parentId=randomUUID();
  await db.prepare("INSERT INTO issues(id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Imported done','imported done','done',?3,?3,?4,?4,?5)").bind(parentId,peer,at(-1),owner,randomUUID()).run();
  await db.prepare("INSERT INTO events(id,stream,type,operation_id,event_index,authorized_via,workspace_id,project_id,subject_type,subject_id,payload_json,created_at) VALUES(?1,'domain','issue.created',?2,0,'deployment_owner',?3,?4,'issue',?5,?6,?7)").bind(randomUUID(),randomUUID(),workspace,peer,parentId,JSON.stringify({status_key:'done',milestone_id:null}),at(-1)).run();
  const parent={id:parentId},child=await create({},peer,now);
  await db.prepare("INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id) VALUES(?1,?2,'parent',?3,?4,?5,?5,?6,?7,?8)").bind(randomUUID(),workspace,child.id,parent.id,peer,now,owner,randomUUID()).run();
  const latest=(await projectTrends(peer,{days:'2'})).points.at(-1);assert.equal(latest.total,2);assert.equal(latest.done,1);assert.equal(latest.completed,0);assert.equal(latest.created,1);
});
test('workspace trends require management and include every active Project without Project selection',async()=>{
  await assert.rejects(workspaceTrends({days:'5'},reader),code('FORBIDDEN'));
  assert.deepEqual((await workspaceTrends({days:'5'})).scope.project_ids,[project,peer,historical,empty].sort());
  await assert.rejects(projectTrends(peer,{},reader),code('NOT_FOUND'));
  for(const selected of[project,[project,peer],[project,project],randomUUID()])await assert.rejects(workspaceTrends({project:selected}),code('VALIDATION_ERROR'));
  for(const params of[{days:'0'},{days:'366'},{days:['2','2']},{status:'done'},{milestone:'none'},{project:peer}])await assert.rejects(projectTrends(project,params),code('VALIDATION_ERROR'));
  await assert.rejects(workspaceTrends({milestone:randomUUID()}),code('VALIDATION_ERROR'));
  await assert.rejects(workspaceTrends({project:Array(101).fill(project)}),code('VALIDATION_ERROR'));
  const response=await server.fetch(`/api/v1/workspaces/${workspace}/projects/${project}/issues/trends?days=5`,{headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).points.length,5);
});
test('fixed project and workspace Sessions cannot expand their scope',async()=>{
  for(const kind of['project','workspace']){
    const sessionId=randomUUID(),target={kind,entry_path:kind==='project'?`/app/w/${workspace}/p/${project}`:`/app/manage?workspace=${workspace}`,workspace_id:workspace,...(kind==='project'?{project_id:project}:{})};
    await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at) VALUES(?1,?2,?3,'credential',?4,?5,?6,?7,?8)").bind(sessionId,kind==='project'?'c'.repeat(64):'d'.repeat(64),owner,credential,kind,JSON.stringify(target),now,now+28800000).run();
    const scoped={...auth,kind:'cookie',sessionId,targetKind:kind,target};
    if(kind==='project'){
      assert.ok((await projectTrends(project,{},scoped)).scope.project_ids.includes(project));
      await assert.rejects(workspaceTrends({},scoped),code('FORBIDDEN'));
    }else assert.equal((await workspaceTrends({},scoped)).scope.project_ids.length,4);
    await assert.rejects(getWorkspaceIssueTrends(db,scoped,otherWorkspace,url(),now),code('FORBIDDEN'));
    await db.prepare('UPDATE web_sessions SET revoked_at=?1 WHERE id=?2').bind(now,sessionId).run();
    await assert.rejects(workspaceTrends({},scoped),code('UNAUTHORIZED'));
  }
  const selected=await db.prepare('SELECT id,number FROM issues WHERE project_id=?1 AND deleted_at IS NULL LIMIT 1').bind(project).first();
  const target={kind:'issue',entry_path:`/app/issues/CFK-${selected.number}`,identifier:`CFK-${selected.number}`,issue_id:selected.id,project_id:project,workspace_id:workspace};
  const sessionId=randomUUID();await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at) VALUES(?1,?2,?3,'credential',?4,'issue',?5,?6,?7)").bind(sessionId,'e'.repeat(64),owner,credential,JSON.stringify(target),now,now+28800000).run();
  const issueScoped={...auth,kind:'cookie',sessionId,targetKind:'issue',target};
  await assert.rejects(projectTrends(project,{},issueScoped),code('NOT_FOUND'));
  await assert.rejects(workspaceTrends({},issueScoped),code('NOT_FOUND'));
});
test('workspace and project administrators resolve to writer with the same current permissions as effective grants',async()=>{
  for(const target of[peer,null]){
    const context=await administrator(workspace,target);
    assert.equal((await projectTrends(peer,{days:'1'},context)).points.at(-1).total,2);
    if(target===null)assert.deepEqual((await workspaceTrends({},context)).scope.project_ids,[project,peer,historical,empty].sort());
    else await assert.rejects(workspaceTrends({},context),code('FORBIDDEN'));
    await revokeAdministrator(context);
    await assert.rejects(projectTrends(peer,{},reader),code('NOT_FOUND'));
  }
});
test('empty Workspace supports Owner and Workspace administrators without direct Project grants',async()=>{
  const context=await administrator(otherWorkspace);
  for(const actor of[auth,context]){
    const result=await getWorkspaceIssueTrends(db,actor,otherWorkspace,url({days:'2'}),now);
    assert.deepEqual(result.scope.project_ids,[]);
    assert.ok(result.points.every(point=>Object.entries(point).every(([key,value])=>key==='date'||value===0)));
  }
  await revokeAdministrator(context);
  await assert.rejects(getWorkspaceIssueTrends(db,context,otherWorkspace,url(),now),code('NOT_FOUND'));
});
test('Workspace aggregates use management Session scope, including Project selection and Owner admin sessions',async()=>{
  const context=await administrator();
  try{for(const[kind,actor]of[['project',context],['workspace',context],['project_selection',context],['admin',auth]]){
    const sessionId=randomUUID(),target=kind==='admin'?{kind,entry_path:'/app/admin',section:'overview'}:kind==='project_selection'?{kind,entry_path:'/app'}:kind==='workspace'?{kind,entry_path:`/app/manage?workspace=${workspace}`,workspace_id:workspace}:{kind,entry_path:`/app/w/${workspace}/p/${project}`,workspace_id:workspace,project_id:project};
    await db.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at) VALUES(?1,?2,?3,'credential',?4,?5,?6,?7,?8)").bind(sessionId,randomUUID().replaceAll('-','').repeat(2),actor.principalId,actor.credentialId,kind,JSON.stringify(target),now,now+28800000).run();
    const scoped={...actor,kind:'cookie',sessionId,targetKind:kind,target};
    if(kind==='project')await assert.rejects(workspaceTrends({},scoped),code('FORBIDDEN'));
    else assert.equal((await workspaceTrends({},scoped)).scope.project_ids.length,4);
    await db.prepare('UPDATE web_sessions SET revoked_at=?1 WHERE id=?2').bind(now,sessionId).run();
  }}finally{await revokeAdministrator(context);}
});
function instrument(database,hook=async()=>{}){
  const queries=[],sqls=new WeakMap();const wrap=(statement,sql,values=[])=>{
    const proxy=new Proxy(statement,{get(target,key){if(key==='bind')return(...args)=>wrap(target.bind(...args),sql,args);
      if(['all','run','first'].includes(key))return async(...args)=>{await hook(sql,'before');const result=await target[key](...args);queries.push({sql,values,rows_read:result?.meta?.rows_read,rows_written:result?.meta?.rows_written});await hook(sql,'after');return result;};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});sqls.set(proxy,sql);return proxy;};
  return{queries,db:new Proxy(database,{get(target,key){if(key==='prepare')return sql=>wrap(target.prepare(sql),sql);if(key==='batch')return async statements=>{const result=await target.batch(statements);result.forEach((item,index)=>queries.push({sql:sqls.get(statements[index]),rows_read:item.meta.rows_read,rows_written:item.meta.rows_written}));return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}})};
}
test('credential, project Grant and container revocation are checked inside data SQL and after snapshot',async()=>{
  for(const [table,id,context,column]of[['credentials',memberCredential,reader,'revoked_at'],['project_grants',grant,reader,'revoked_at'],['projects',project,auth,'deleted_at'],['workspaces',workspace,auth,'deleted_at']]){
    for(const stage of['before','after']){
      let changed=false;const measured=instrument(db,async(sql,phase)=>{if(!changed&&phase===stage&&sql.includes('FROM issue_trend_days d')){changed=true;await db.prepare(`UPDATE ${table} SET ${column}=?1,${column==='revoked_at'?'revoked_by_principal_id':'deleted_by_principal_id'}=?3 WHERE id=?2`).bind(now,id,owner).run();}});
      try{await assert.rejects(projectTrends(project,{},context,measured.db),code(table==='credentials'?'UNAUTHORIZED':'NOT_FOUND'));assert.ok(changed);}
      finally{await db.prepare(`UPDATE ${table} SET ${column}=NULL,${column==='revoked_at'?'revoked_by_principal_id':'deleted_by_principal_id'}=NULL WHERE id=?1`).bind(id).run();}
    }
  }
});
test('Workspace management revocation and generation replacement fail closed during aggregate reads',async()=>{
  const context=await administrator(),grant=context.managementGrants[0];
  for(const change of['revocation','generation'])for(const stage of['before','after']){
    let changed=false;
    const measured=instrument(db,async(sql,phase)=>{
      if(changed||phase!==stage||!sql.includes('FROM issue_trend_days d'))return;
      changed=true;
      if(change==='revocation')await revokeAdministrator(context);
      else await db.prepare('UPDATE scoped_administrator_grants SET generation=?1,version=version+1 WHERE id=?2').bind(randomUUID(),grant.id).run();
    });
    try{
      await assert.rejects(workspaceTrends({},context,measured.db),error=>['NOT_FOUND','CURSOR_SCOPE_MISMATCH'].includes(error.code));
      assert.ok(changed);
    }finally{
      await db.prepare('UPDATE scoped_administrator_grants SET revoked_at=NULL,revoked_by_principal_id=NULL,generation=?1 WHERE id=?2').bind(grant.generation,grant.id).run();
    }
  }
  await revokeAdministrator(context);
});
test('Workspace authority is checked after the returned Project scope is resolved',async()=>{
  const context=await administrator();let candidates=0,changed=false;
  const measured=instrument(db,async(sql,stage)=>{
    if(stage==='after'&&sql.includes('idx_projects_workspace_purge_state')&&++candidates===2){
      changed=true;await revokeAdministrator(context);
    }
  });
  try{await assert.rejects(workspaceTrends({},context,measured.db),code('NOT_FOUND'));assert.ok(changed);}
  finally{await revokeAdministrator(context);}
});
test('Workspace aggregates exclude archived Projects and reject archives that race an empty read',async()=>{
  await db.prepare('UPDATE projects SET deleted_at=?1,deleted_by_principal_id=?2 WHERE id=?3').bind(now,owner,empty).run();
  try{assert.deepEqual((await workspaceTrends()).scope.project_ids,[project,peer,historical].sort());}
  finally{await db.prepare('UPDATE projects SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1').bind(empty).run();}
  for(const stage of['before','after']){
    let changed=false;
    const measured=instrument(db,async(sql,phase)=>{
      if(changed||phase!==stage||!sql.includes('FROM issue_trend_days d'))return;
      changed=true;await db.prepare('UPDATE workspaces SET deleted_at=?1,deleted_by_principal_id=?2 WHERE id=?3').bind(now,owner,otherWorkspace).run();
    });
    try{await assert.rejects(getWorkspaceIssueTrends(measured.db,auth,otherWorkspace,url(),now),code('NOT_FOUND'));assert.ok(changed);}
    finally{await db.prepare('UPDATE workspaces SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1').bind(otherWorkspace).run();}
  }
});
test('empty Workspace cannot be archived between final active and management checks',async()=>{
  const context=await administrator(otherWorkspace);
  try{for(const actor of[auth,context]){
    let managementChecks=0,changed=false;
    const measured=instrument(db,async(sql,stage)=>{
      if(stage==='before'&&sql.includes('control_workspace')&&!sql.includes('FROM issue_trend_days d')&&++managementChecks===2){
        changed=true;await db.prepare('UPDATE workspaces SET deleted_at=?1,deleted_by_principal_id=?2 WHERE id=?3').bind(now,owner,otherWorkspace).run();
      }
    });
    try{await assert.rejects(getWorkspaceIssueTrends(measured.db,actor,otherWorkspace,url(),now),code('NOT_FOUND'));assert.ok(changed);}
    finally{await db.prepare('UPDATE workspaces SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1').bind(otherWorkspace).run();}
  }}finally{await revokeAdministrator(context);}
});
test('workspace authorization costs stay local with many unrelated Workspace grants',async t=>{
  const context=await administrator();
  const before=instrument(db);await workspaceTrends({days:'1'},context,before.db);
  const samples=[];
  for(let index=0;index<250;index++){
    const id=randomUUID();samples.push(db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Unrelated cost',?3,?3,?4,?4,?5)").bind(id,otherWorkspace,now,owner,randomUUID()));
    samples.push(db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)").bind(randomUUID(),member,id,randomUUID()));
  }
  for(let index=0;index<samples.length;index+=80)await db.batch(samples.slice(index,index+80));
  const after=instrument(db);assert.deepEqual((await workspaceTrends({days:'1'},context,after.db)).scope.project_ids,[project,peer,historical,empty].sort());
  const scoped=queries=>queries.filter(item=>item.sql.includes('idx_projects_workspace_purge_state')).map(item=>item.rows_read);
  assert.ok(scoped(after.queries).every(value=>value<100));
  assert.ok(scoped(after.queries).every((value,index)=>value<=scoped(before.queries)[index]+4), 'index depth may change, but unrelated grants must not be scanned');
  await assert.rejects(getWorkspaceIssueTrends(db,auth,otherWorkspace,url(),now),code('VALIDATION_ERROR'));
  await revokeAdministrator(context);
  t.diagnostic(`Local workspace permission D1 evidence only: ${JSON.stringify({unrelated_grants:250,before_rows_read:scoped(before.queries),after_rows_read:scoped(after.queries)})}`);
});
test('new milestones have complete birth-date coverage while their Project history is pending',async()=>{
  await db.prepare("UPDATE issue_trend_projects SET pending_jobs=1,flow_from=date(?2,'+1 day') WHERE project_id=?1").bind(empty,new Date(now).toISOString().slice(0,10)).run();
  const m=(await createMilestone(db,request(),auth,workspace,empty,{title:'New pending milestone'},now)).resource;
  await create({milestone_id:m.id},empty,now);
  const result=await projectTrends(empty,{milestone:m.id,days:'5'});
  assert.equal(result.projects[0].history_state,'complete');assert.equal(result.points.at(-1).total,1);assert.equal(result.points.at(-1).created,1);
  assert.ok(result.points.slice(0,-1).every(point=>point.total===0&&point.created===0));
  await db.prepare('UPDATE issue_trend_projects SET pending_jobs=0 WHERE project_id=?1').bind(empty).run();
});
test('midnight writes are included in the same observed UTC day as the totals snapshot',async()=>{
  const id=randomUUID();await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Midnight',?3,?3,?4,?4,?5)").bind(id,workspace,at(-2),owner,randomUUID()).run();
  await create({},id,at(-1));let wrote=false;
  const observed=dayStart+86400000+1000,started=dayStart+86400000-1;
  const measured=instrument(db,async(sql,stage)=>{if(!wrote&&stage==='before'&&sql.includes('FROM issue_trend_days d')){wrote=true;await create({},id,dayStart+86400000+500);}});
  const result=await getProjectIssueTrends(measured.db,auth,workspace,id,url({days:'2'}),started,{snapshotTime:observed});
  assert.ok(wrote);assert.equal(result.observed_at,new Date(observed).toISOString());assert.equal(result.to_date,new Date(observed).toISOString().slice(0,10));
  assert.deepEqual(result.points.map(point=>[point.total,point.created]),[[1,0],[2,1]]);
});
test('legacy jobs backfill frozen snapshots alongside future writes, with bounded D1 pages and read-only readers',async t=>{
  let old=await create({},historical,at(-4));old=await complete(old,at(-2));
  const events=[];
  for(let index=0;index<1000;index++)events.push(db.prepare("INSERT INTO events(id,stream,type,operation_id,event_index,authorized_via,workspace_id,project_id,subject_type,subject_id,payload_json,created_at) VALUES(?1,'domain','issue.updated',?2,0,'deployment_owner',?3,?4,'issue',?5,?6,?7)")
    .bind(randomUUID(),randomUUID(),workspace,historical,index<105?old.id:randomUUID(),JSON.stringify({status_changed:false}),at(-1)));
  for(let index=0;index<events.length;index+=80)await db.batch(events.slice(index,index+80));
  await db.prepare('DELETE FROM issue_trend_days WHERE project_id=?1').bind(historical).run();
  await db.prepare(`INSERT INTO issue_trend_backfill(issue_id,project_id,cursor,status_key,milestone_id,active,created_at,last_date,oldest_date,ceiling_date)
    SELECT i.id,i.project_id,(SELECT MAX(sequence)+1 FROM events),i.status_key,i.milestone_id,1,i.created_at,?2,?2,?2 FROM issues i WHERE i.id=?1`).bind(old.id,new Date(now).toISOString().slice(0,10)).run();
  await db.prepare("UPDATE issue_trend_projects SET pending_jobs=1,stock_from=?2,flow_from=date(?2,'+1 day') WHERE project_id=?1").bind(historical,new Date(now).toISOString().slice(0,10)).run();
  const pending=await projectTrends(historical,{days:'5'});assert.equal(pending.projects[0].history_state,'pending');assert.equal(pending.points[0].total,null);assert.equal(pending.points.at(-1).total,1);assert.equal(pending.points.at(-1).completed,null);
  old=await update(old,{status_key:'todo'},now);
  const measured=instrument(db);const first=await backfillIssueTrends(measured.db);assert.equal(first.finished,0);
  const summary=await backfillIssueTrends(measured.db);assert.equal(summary.finished,1);
  const result=await projectTrends(historical,{days:'5'});assert.equal(result.projects[0].history_state,'complete');assert.deepEqual(result.points.map(point=>[point.total,point.done,point.created,point.completed,point.reopened]),[[1,0,1,0,0],[1,0,0,0,0],[1,1,0,1,0],[1,1,0,0,0],[1,0,0,0,1]]);
  const reads=instrument(db);await projectTrends(historical,{days:'365'},auth,reads.db);const query=reads.queries.find(item=>item.sql.includes('FROM issue_trend_days d'));
  assert.equal(query.rows_written,0);assert.ok(query.rows_read<100);assert.ok(!query.sql.includes('FROM events'));assert.ok(!query.sql.includes('FROM issues'));
  const pages=measured.queries.filter(item=>item.sql.includes('idx_events_issue_trend_history'));assert.ok(pages.every(page=>page.rows_read<=100&&page.rows_written===0));
  assert.equal(pages[0].rows_read,100);
  t.diagnostic(`Local workerd D1 evidence only: ${JSON.stringify({unrelated_events:895,trend_rows_read:query.rows_read,trend_rows_written:query.rows_written,backfill_event_rows_read:pages.map(page=>page.rows_read),batch_rows_written:measured.queries.filter(item=>item.rows_written>0).map(item=>item.rows_written)})}`);
});
test('purge removes projection history, cache and pending jobs atomically',async()=>{
  await db.prepare('UPDATE projects SET deleted_at=?1,deleted_by_principal_id=?2 WHERE id=?3').bind(now,owner,historical).run();
  const preview=await getPurgePreview(db,auth,workspace,historical,now);
  await purgeContainer(db,request(),auth,workspace,historical,preview.target.version,preview.target.display_name,preview.preview_digest,now);
  for(const table of['issue_trend_projects','issue_trend_totals','issue_trend_days','issue_trend_states','issue_trend_backfill'])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?1`).bind(historical).first()).n,0);
  await assert.rejects(projectTrends(historical),code('NOT_FOUND'));
});
