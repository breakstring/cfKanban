import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { COMMANDS } from '../src/catalog.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { recordFirstDeploymentLedger } from '../src/workflows.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';
import { appendJournalEvent, authorizeJournal, createJournal } from '../../skill-runtime/src/journal.mjs';
import { canonicalDigest } from '../../skill-runtime/src/utils.mjs';
import { treeDigest } from '../../skill-runtime/src/skill-update.mjs';
const command=name=>COMMANDS.find(entry=>entry.name===name);
function fetchFixture(fixture) {return async(url)=>{url=new URL(url);assert.equal(url.origin,fixture.origin);return Response.json(url.pathname==='/.well-known/cfkanban-instance.json'?fixture.discovery:fixture.me(fixture.credential));};}
test('board partial readback retains original step and recovers without recreating either container',async t=> {
  const f=await createMcpStateFixture(t);const workspaceId=randomUUID(),projectId=randomUUID();let failReadback=true;const posts=[];
  const requestImpl=async options=> {
    if(options.method==='POST') {posts.push(options);return {ok:true,status:201,data:{resource:{id:options.apiPath.endsWith('/projects')?projectId:workspaceId,version:1}}};}
    if(options.apiPath.endsWith(projectId)&&failReadback)return {ok:false,status:503,error:{code:'PLATFORM_UNAVAILABLE',category:'platform_failure',source:'client_transport'}};
    return {ok:true,status:200,data:{id:options.apiPath.endsWith(projectId)?projectId:workspaceId,version:1}};
  };
  const options={...f,fetchImpl:fetchFixture(f),requestImpl};
  const result=await createCliRuntime(options).execute(command('board create'),{instanceId:f.instanceId,workspaceName:'One workspace',projectName:'One project'});assert.equal(result.outcome_unknown,true);assert.equal(posts.length,2);
  failReadback=false;
  const recovered=await createCliRuntime(options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:result.recovery.operation_id});assert.equal(recovered.ok,true);assert.equal(posts.length,2);assert.equal(recovered.data.project.id,projectId);
});
test('known committed capability delivery failure never re-delivers and releases the unknown-write gate',async t=> {
  const f=await createMcpStateFixture(t);let calls=0;
  const dispatchImpl=async()=>{calls++;throw Object.assign(new Error('Never expose failure text'),{code:'CLIPBOARD_DELIVERY_FAILED_AFTER_COMMIT',details:{committed:true,invitation_id:randomUUID(),expires_at:'2026-10-04T12:00:00Z',recovery:'revoke_or_expire_then_create_a_replacement'}});};
  const runtime=createCliRuntime({...f,fetchImpl:fetchFixture(f),dispatchImpl});
  const result=await runtime.execute(command('invite create'),{instanceId:f.instanceId,body:{kind:'project',project_grants:[{project_id:f.projectId,role:'reader'}]}});assert.equal(result.committed,true);assert.equal(result.outcome_unknown,undefined);assert.equal(calls,1);
  assert.rejects(readFile(path.join(f.stateRoot,'instances',f.instanceId,'cli-operations/pending.json')));
  const device=command('owner device verify');assert.equal(device.effect,'write');
  const operationId=randomUUID();await writeFile(path.join(f.stateRoot,'instances',f.instanceId,'cli-operations/pending.json'),JSON.stringify({operation_id:operationId}),{mode:0o600});
  await assert.rejects(runtime.execute(device,{instanceId:f.instanceId}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});assert.equal(calls,1);
});
test('a fresh home can discover and explicitly register an instance without credentials',async t=> {
  const home=await mkdtemp(path.join(os.tmpdir(),'cfkanban-cli-empty-'));t.after(()=>rm(home,{recursive:true,force:true}));const instanceId=randomUUID();const origin='https://first-use.invalid';
  const runtime=createCliRuntime({home,fetchImpl:async(url,options)=> {assert.equal(new Headers(options.headers).get('authorization'),null);return Response.json({discovery_version:1,instance_id:instanceId,observed_origin:origin,preferred_api_origin:origin,origin_version:1});}});
  const discovered=await runtime.execute(command('connection discover'),{origin});assert.equal(discovered.data.instance_id,instanceId);
  const added=await runtime.execute(command('connection add'),{instanceId,trustedApiOrigin:origin,persistenceConfirmed:true});assert.equal(added.instance_id,instanceId);
  const privateMetadata=JSON.parse(await readFile(path.join(home,'.cfkanban','instances',instanceId,'instance.json'),'utf8'));assert.equal(privateMetadata.trusted_api_origin,origin);
});
test('a later CAS conflict or permission denial cannot settle an original unknown write',async t=> {
  const f=await createMcpStateFixture(t);let status=0;
  const requestImpl=async options=>options.method==='GET'?{ok:true,status:200,data:{identifier:'CFK-21',version:3}}:{ok:false,status,error:{code:status===409?'VERSION_CONFLICT':status===403?'CAPABILITY_DENIED':'PLATFORM_UNAVAILABLE',category:status===409?'conflict':status===403?'authorization':'platform_failure',source:'service'}};
  const options={...f,fetchImpl:fetchFixture(f),requestImpl};const first=await createCliRuntime(options).execute(command('issue update'),{instanceId:f.instanceId,identifier:'CFK-21',title:'Original'});assert.equal(first.outcome_unknown,true);
  for(const response of [409,403]) {status=response;const restored=await createCliRuntime(options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.recovery.operation_id});assert.equal(restored.outcome_unknown,true);assert.equal(restored.error.category,response===409?'conflict':'authorization');await assert.rejects(createCliRuntime(options).execute(command('issue update'),{instanceId:f.instanceId,identifier:'CFK-21',title:'Replacement'}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});}
});
test('a readback older than the committed resource stays unverified and is never re-created',async t=> {
  const f=await createMcpStateFixture(t);let version=1,posts=0;
  const requestImpl=async options=>{if(options.method==='POST'){posts++;return {ok:true,status:201,data:{resource:{identifier:'CFK-22',version:2}}};}return {ok:true,status:200,data:{identifier:'CFK-22',version}};};
  const options={...f,fetchImpl:fetchFixture(f),requestImpl};const first=await createCliRuntime(options).execute(command('issue create'),{instanceId:f.instanceId,workspace_id:f.workspaceId,project_id:f.projectId,title:'Readback'});assert.equal(first.committed_unverified,true);
  version=2;const recovered=await createCliRuntime(options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.recovery.operation_id});assert.equal(recovered.operation.phase,'verified');assert.equal(posts,1);
});
test('an unknown usage refresh performs only bounded snapshot reads during recovery',async t=> {
  const f=await createMcpStateFixture(t);let posts=0;
  const requestImpl=async options=>options.method==='GET'?{ok:true,status:200,data:{configured:true}}:(posts++,{ok:false,status:0,error:{category:'platform_failure',source:'client_transport'}});
  const options={...f,fetchImpl:fetchFixture(f),requestImpl};const first=await createCliRuntime(options).execute(command('admin usage show'),{instanceId:f.instanceId,mode:'manual'});assert.equal(first.outcome_unknown,true);
  const recovered=await createCliRuntime(options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.recovery.operation_id});assert.equal(recovered.outcome_unknown,true);assert.equal(recovered.readback.ok,true);assert.equal(posts,1);
});

async function ledgerFixture(t) {
  const f=await createMcpStateFixture(t);const operationId=randomUUID(),databaseId=randomUUID();const bundle=path.join(f.home,'service/versions/1.0.0/bundle');
  const manifest={manifest_version:1,migrations:[{sequence:1,name:'0001_initial.sql',sha256:'a'.repeat(64),classification:'bootstrap',reentry:'ledger_only',expected_artifacts:{tables:['fixture_one'],indexes:[]}},{sequence:2,name:'0002_next.sql',sha256:'b'.repeat(64),classification:'backward_compatible',reentry:'ledger_only',expected_artifacts:{tables:['fixture_two'],indexes:[]}}]};
  for(const [file,content]of Object.entries({'dist/index.js':'','contracts/openapi.json':'{}','migrations/manifest.json':JSON.stringify(manifest),'release/deployment/migration-readback.sql':'SELECT 1','wrangler-config-schema.json':'{}','wrangler.template.json':'{}'})) {await mkdir(path.dirname(path.join(bundle,file)),{recursive:true});await writeFile(path.join(bundle,file),content);}
  await mkdir(path.join(bundle,'apps/web/dist'),{recursive:true});
  await writeFile(path.join(path.dirname(bundle),'.cfkanban-release.json'),JSON.stringify({schema_version:1,kind:'service_deployment_bundle',version:'1.0.0',artifact_sha256:'c'.repeat(64),publisher:'https://publisher.invalid',source:'https://publisher.invalid/service.zip',bundle_path:bundle,bundle_tree_digest:await treeDigest(bundle)}));
  const plan={kind:'strict_zero_deploy',task_id:'test-task',operation_id:operationId,target:{instance_id:f.instanceId,cloudflare_account_id:'isolated-account'},resources:{worker:{name:'isolated-worker'},d1:{name:'isolated-d1'}},release:{service_bundle_version:'1.0.0',service_bundle_sha256:'c'.repeat(64)}};
  const input={...f,instanceId:f.instanceId,operationId,taskId:plan.task_id,plan};await createJournal(input);await authorizeJournal({...input,planDigest:canonicalDigest(plan)});
  const readback={ledger:[],schema:{tables:['fixture_one','fixture_two'],indexes:[]},result_set_count:2};
  const events=[{type:'cli_first_deploy_absence_verified',worker_name:'isolated-worker',d1_name:'isolated-d1'},{type:'command_finished',action:'create_d1',exit_code:0},{type:'cli_created_d1_verified',database_id:databaseId,d1_name:'isolated-d1',account_id:'isolated-account'},{type:'wrangler_config_written',service_bundle_root:bundle,d1_database_id:databaseId},{type:'command_finished',action:'apply_non_destructive_migrations',exit_code:0},{type:'command_finished',action:'migration_ledger_readback',exit_code:0,migration_readback:readback}];
  for(const event of events)await appendJournalEvent({...input,event});
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE cfkanban_migration_ledger(sequence INTEGER PRIMARY KEY,name TEXT UNIQUE,sha256 TEXT,classification TEXT,reentry TEXT,operation_id TEXT,applied_at INTEGER)');
  const helper=async(name,data)=> {
    assert.equal(name,'deploy wrangler-action');
    if(data.action==='record_migration_checksum') {const sql=await readFile(data.migrationRecordSqlPath,'utf8');assert.doesNotMatch(sql,/\b(?:BEGIN|COMMIT|ROLLBACK)\b/);db.exec(sql);}
    else {assert.equal(data.action,'migration_ledger_readback');readback.ledger=db.prepare('SELECT * FROM cfkanban_migration_ledger ORDER BY sequence').all();await appendJournalEvent({...input,event:{type:'command_finished',action:'migration_ledger_readback',exit_code:0,migration_readback:readback}});}
    return {command_succeeded:true};
  };
  return {...input,manifest,readback,helper,shared:{},bundle,db};
}
test('first-deploy checksum initialization uses verified new-D1 evidence and insert-only SQL',async t=> {
  const f=await ledgerFixture(t);await recordFirstDeploymentLedger(f);assert.equal(f.db.prepare('SELECT count(*) AS n FROM cfkanban_migration_ledger').get().n,2);
  const rows=f.db.prepare('SELECT * FROM cfkanban_migration_ledger').all();assert.ok(rows.every(row=>row.operation_id===f.operationId));await recordFirstDeploymentLedger(f);assert.deepEqual(f.db.prepare('SELECT * FROM cfkanban_migration_ledger').all(),rows);
});
test('first-deploy checksum initialization rejects stale readback and modified immutable bundles',async t=> {
  const f=await ledgerFixture(t);await assert.rejects(recordFirstDeploymentLedger({...f,readback:{...f.readback,schema:{tables:[],indexes:[]}}}),{code:'CLI_INITIAL_LEDGER_READBACK_REQUIRED'});
  await writeFile(path.join(f.bundle,'dist/index.js'),'modified');await assert.rejects(recordFirstDeploymentLedger(f),{code:'LOCAL_SERVICE_BUNDLE_MODIFIED'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM cfkanban_migration_ledger').get().n,0);
});
