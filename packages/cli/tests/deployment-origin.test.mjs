import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runWorkflow } from '../src/workflows.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';
import { appendJournalEvent, authorizeJournal, createJournal } from '../../skill-runtime/src/journal.mjs';
import { treeDigest } from '../../skill-runtime/src/skill-update.mjs';
import { canonicalDigest } from '../../skill-runtime/src/utils.mjs';

test('WAF target registration dispatches only its exactly authorized plan and journal',async()=> {
  const input={instanceId:randomUUID(),operationId:randomUUID(),taskId:'isolated-waf-target',plan:{kind:'cfkanban_waf_target',target:{hostname:'instance.invalid'}}};
  input.authorization={instance_id:input.instanceId,operation_id:input.operationId,task_id:input.taskId,plan_digest:canonicalDigest(input.plan)};
  const calls=[];
  const context={helper:async(name,value)=>{calls.push({name,value});return name==='waf-target apply'?{ok:true,registered:true}:{ok:true};}};
  await assert.rejects(runWorkflow('waf-target-apply',{...input,plan:{...input.plan,target:{hostname:'other.invalid'}}},context),{code:'CLI_PLAN_AUTHORIZATION_REQUIRED'});
  assert.equal(calls.length,0);
  assert.deepEqual(await runWorkflow('waf-target-apply',input,context),{ok:true,registered:true});
  assert.deepEqual(calls.map(call=>call.name),['journal create','journal authorize','waf-target apply']);
  assert.equal(calls[1].value.planDigest,input.authorization.plan_digest);
  assert.deepEqual(calls[2].value,input);
});

async function deploymentFixture(t,{origin='https://custom-instance.invalid',first=false}={}) {
  const state=await createMcpStateFixture(t,{origin});
  const operationId=randomUUID(),databaseId=randomUUID();
  const bundle=path.join(state.home,'service/versions/2.0.0/bundle');
  const migration={sequence:1,name:'0001_initial.sql',sha256:'a'.repeat(64),classification:'bootstrap',reentry:'ledger_only',expected_artifacts:{tables:['fixture_one'],indexes:[]}};
  const manifest={manifest_version:1,migrations:[migration]};
  for(const [file,content] of Object.entries({
    'dist/index.js':'export default {};','contracts/openapi.json':'{}',
    'migrations/manifest.json':JSON.stringify(manifest),
    'release/deployment/migration-readback.sql':'SELECT 1;',
    'release/deployment/migration-ledger.sql':'SELECT 1;',
    'wrangler-config-schema.json':'{}','wrangler.template.json':'{}',
  })) {
    await mkdir(path.dirname(path.join(bundle,file)),{recursive:true});
    await writeFile(path.join(bundle,file),content,{mode:0o600});
  }
  await mkdir(path.join(bundle,'apps/web/dist'),{recursive:true});
  const publisher='https://publisher.invalid',source=`${publisher}/service.zip`;
  await writeFile(path.join(path.dirname(bundle),'.cfkanban-release.json'),JSON.stringify({
    schema_version:1,kind:'service_deployment_bundle',version:'2.0.0',artifact_sha256:'c'.repeat(64),
    publisher,source,bundle_path:bundle,bundle_tree_digest:await treeDigest(bundle),
  }),{mode:0o600});
  const plan={
    kind:first?'strict_zero_deploy':'deployed_instance_upgrade',task_id:'isolated-upgrade',operation_id:operationId,instance_id:state.instanceId,
    target:{instance_id:state.instanceId,api_origin:origin,cloudflare_account_id:'isolated-account',cloudflare_profile:'isolated',cloudflare_auth_context_directory:null},
    owner:{principal_id:state.principalId,credential_id:state.credential.credential_id,credential_fingerprint:state.credential.fingerprint,display_name:'MCPFixture'},
    current:{provenance:'verified_receipt',schema_version:19},
    resources:{worker:{name:'isolated-worker'},d1:{name:'isolated-d1',database_id:databaseId}},
    release:{manifest_sha256:'d'.repeat(64),manifest_version:'2.0.0',service_bundle_version:'2.0.0',service_bundle_sha256:'c'.repeat(64)},
    migrations:{ordered:[]},
  };
  const verified={pointer:{manifest_sha256:plan.release.manifest_sha256},manifest:{release:{version:'2.0.0'},publisher:{canonical_origin:publisher}},artifacts:[{kind:'service_deployment_bundle',version:'2.0.0',sha256:'c'.repeat(64),url:source},{kind:'skill_bundle',version:'2.0.0',sha256:'b'.repeat(64)}]};
  const readback={ledger:[migration],schema:{tables:['fixture_one'],indexes:[]},result_set_count:2};
  const calls=[],requests=[];
  const mutable={created:!first,deployed:false,enabled:true,discovery:{...state.discovery},meta:{instance_id:state.instanceId,observed_origin:origin,preferred_api_origin:origin,origin_version:1,principal:{id:state.principalId,is_owner:true}},me:{...state.me(state.credential),is_owner:true}};
  const inputFor=(changes={})=> {
    const input={...state,operationId,taskId:plan.task_id,plan,serviceBundleRoot:bundle,wranglerExecutable:'/isolated/wrangler',apiOrigin:origin,...changes};
    input.authorization={task_id:input.taskId,operation_id:input.operationId,instance_id:input.instanceId,plan_digest:canonicalDigest(input.plan)};
    return input;
  };
  const fetchImpl=async(url,options)=> {
    url=new URL(url);
    const authenticated=new Headers(options.headers).has('authorization');
    requests.push({origin:url.origin,path:url.pathname,authenticated});
    if(url.origin==='https://api.cloudflare.com') {
      assert.equal(first,true,'Existing-instance upgrades must not use the first-deployment routing client');
      assert.equal(options.method,'GET');
      if(url.pathname.endsWith('/workers/subdomain'))return Response.json({success:true,result:{subdomain:'isolated'}});
      assert.equal(url.pathname,'/client/v4/accounts/isolated-account/workers/scripts/isolated-worker/subdomain');
      assert.equal(mutable.deployed,true,'Worker enabled status is checked only after its first deployment');
      return Response.json({success:true,result:{enabled:mutable.enabled}});
    }
    assert.equal(url.origin,origin,'No instance request may leave the current trusted origin');
    assert.equal(options.redirect,'manual');
    if(url.pathname==='/.well-known/cfkanban-instance.json') {assert.equal(authenticated,false);return Response.json(mutable.discovery);}
    assert.equal(authenticated,true);
    if(url.pathname==='/api/v1/meta')return Response.json(mutable.meta);
    assert.equal(url.pathname,'/api/v1/me');
    return Response.json(mutable.me);
  };
  const helper=async(name,input)=> {
    calls.push({name,...(input.action?{action:input.action}:{})});
    if(name==='journal create')return createJournal({...input,stateRoot:state.stateRoot});
    if(name==='journal authorize')return authorizeJournal({...input,stateRoot:state.stateRoot});
    if(name==='release verify')return verified;
    if(name==='runtime wrangler-account-readback')return {account_id:plan.target.cloudflare_account_id};
    if(name==='runtime d1-resource-readback')return {status:mutable.created?'present':'absent',database_id:databaseId};
    if(name==='runtime worker-resource-readback')return {status:mutable.deployed?'present':'absent'};
    if(name==='deployment write-wrangler-config') {
      const configPath=path.join(state.home,'isolated-wrangler.json');
      await appendJournalEvent({...input,stateRoot:state.stateRoot,event:{type:'wrangler_config_written',config_path:configPath,service_bundle_root:bundle,d1_database_id:databaseId}});
      return {wrangler_config_path:configPath};
    }
    if(name==='deploy wrangler-action') {
      await appendJournalEvent({...input,stateRoot:state.stateRoot,event:{type:'command_started',action:input.action}});
      if(input.action==='create_d1')mutable.created=true;
      if(input.action==='deploy_worker_and_static_assets')mutable.deployed=true;
      await appendJournalEvent({...input,stateRoot:state.stateRoot,event:{type:'command_finished',action:input.action,exit_code:0,...(input.action==='migration_ledger_readback'?{migration_readback:readback}:{})}});
      return {command_succeeded:true};
    }
    if(name==='deployment prepare-owner-credential')return {prepared:true};
    if(name==='bootstrap write-owner-sql')return {bootstrap_sql_path:path.join(state.home,'owner.sql')};
    if(name==='deployment finalize-upgrade'||name==='deployment finalize-owner') {
      assert.equal(input.apiOrigin,origin);
      return {ok:true,instance_id:state.instanceId,operation_id:operationId,api_origin:input.apiOrigin};
    }
    assert.fail(`Unexpected helper ${name}`);
  };
  const context={stateRoot:state.stateRoot,helper,fetchImpl,tokenRunner:async()=>({stdout:JSON.stringify({type:'oauth',token:'isolated-fixture-token'})})};
  const journalPath=path.join(state.stateRoot,'instances',state.instanceId,'journals',`${operationId}.json`);
  return {...state,plan,inputFor,context,calls,requests,mutable,journalPath};
}

test('custom-origin upgrade apply and resume preserve the exact trusted origin and original deployment',async t=> {
  const f=await deploymentFixture(t);
  const before=await readFile(path.join(f.stateRoot,'instances',f.instanceId,'instance.json'),'utf8');
  for(const input of [f.inputFor(),f.inputFor({apiOrigin:undefined})]) {
    const result=await runWorkflow('deploy-apply',input,f.context);
    assert.equal(result.ok,true);assert.equal(result.api_origin,f.origin);
  }
  assert.equal(f.calls.filter(call=>call.action==='deploy_worker_and_static_assets').length,1);
  assert.equal(f.calls.filter(call=>call.name==='deployment finalize-upgrade').length,2);
  assert.ok(f.requests.every(request=>request.origin===f.origin));
  assert.deepEqual(f.requests.map(request=>request.authenticated),[false,true,true,false,true,true]);
  assert.equal(await readFile(path.join(f.stateRoot,'instances',f.instanceId,'instance.json'),'utf8'),before);
  const journal=JSON.parse(await readFile(f.journalPath,'utf8'));
  assert.equal(journal.plan_digest,canonicalDigest(f.plan));
  assert.equal(journal.events.filter(event=>event.type==='cli_upgrade_trusted_origin_verified').length,2);
  await assert.rejects(readFile(`${f.journalPath}.cli.lock`),{code:'ENOENT'});
});

test('an existing default workers.dev instance upgrades through the same trusted-origin path',async t=> {
  const f=await deploymentFixture(t,{origin:'https://isolated-worker.isolated.workers.dev'});
  const result=await runWorkflow('deploy-apply',f.inputFor(),f.context);
  assert.equal(result.ok,true);assert.equal(result.api_origin,f.origin);
  assert.ok(f.requests.every(request=>request.origin===f.origin));
});

test('input and frozen-plan origin drift are rejected before any network or deployment action',async t=> {
  for(const drift of ['input','plan'])await t.test(drift,async t=> {
    const f=await deploymentFixture(t);
    const plan=drift==='plan'?{...f.plan,target:{...f.plan.target,api_origin:'https://replacement.invalid'}}:f.plan;
    await assert.rejects(runWorkflow('deploy-apply',f.inputFor({plan,apiOrigin:'https://replacement.invalid'}),f.context),{code:'CLI_DEPLOYMENT_ORIGIN_DRIFT'});
    assert.equal(f.requests.length,0);
    assert.deepEqual(f.calls.map(call=>call.name),['journal create','journal authorize']);
  });
});

test('an origin changed during credential-free discovery receives no Bearer and blocks deployment',async t=> {
  const f=await deploymentFixture(t);const fetchImpl=f.context.fetchImpl;
  f.context.fetchImpl=async(url,options)=> {
    const response=await fetchImpl(url,options);
    if(new URL(url).pathname==='/.well-known/cfkanban-instance.json') {
      const file=path.join(f.stateRoot,'instances',f.instanceId,'instance.json');
      const instance=JSON.parse(await readFile(file,'utf8'));
      await writeFile(file,JSON.stringify({...instance,trusted_api_origin:'https://replacement.invalid',origin_version:2}),{mode:0o600});
    }
    return response;
  };
  await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'TRUSTED_ORIGIN_BINDING_MISMATCH'});
  assert.deepEqual(f.requests,[{origin:f.origin,path:'/.well-known/cfkanban-instance.json',authenticated:false}]);
  assert.deepEqual(f.calls.map(call=>call.name),['journal create','journal authorize']);
});

test('a damaged private origin version is rejected before any request or cloud write',async t=> {
  for(const originVersion of [null,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1])await t.test(String(originVersion),async t=> {
    const f=await deploymentFixture(t);const file=path.join(f.stateRoot,'instances',f.instanceId,'instance.json');
    const instance=JSON.parse(await readFile(file,'utf8'));
    await writeFile(file,JSON.stringify({...instance,origin_version:originVersion}),{mode:0o600});
    await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'CLI_DEPLOYMENT_ORIGIN_DRIFT'});
    assert.equal(f.requests.length,0);
    assert.deepEqual(f.calls.map(call=>call.name),['journal create','journal authorize']);
  });
});

test('non-success authenticated readback keeps the deployment readback rejection contract',async t=> {
  const f=await deploymentFixture(t);const fetchImpl=f.context.fetchImpl;
  f.context.fetchImpl=async(url,options)=>new URL(url).pathname==='/api/v1/meta'?Response.json({error:{code:'PERMISSION_DENIED'}},{status:403}):fetchImpl(url,options);
  await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'DEPLOYMENT_READBACK_FAILED'});
  assert.ok(f.calls.every(call=>!call.action));
});

test('public discovery must confirm this instance before a Credential or cloud write is used',async t=> {
  for(const discovery of [{instance_id:randomUUID()},{preferred_api_origin:'https://replacement.invalid'},{origin_version:0}])await t.test(Object.keys(discovery)[0],async t=> {
    const f=await deploymentFixture(t);Object.assign(f.mutable.discovery,discovery);
    await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'CLI_UPGRADE_DISCOVERY_MISMATCH'});
    assert.deepEqual(f.requests.map(request=>request.authenticated),[false]);
    assert.ok(f.calls.every(call=>!call.action));
  });
});

test('a different frozen Credential or a revoked Owner is rejected before cloud writes',async t=> {
  await t.test('Credential snapshot',async t=> {
    const f=await deploymentFixture(t);const plan={...f.plan,owner:{...f.plan.owner,credential_id:randomUUID()}};
    await assert.rejects(runWorkflow('deploy-apply',f.inputFor({plan}),f.context),{code:'CLI_UPGRADE_OWNER_MISMATCH'});
    assert.deepEqual(f.requests.map(request=>request.authenticated),[false]);
    assert.ok(f.calls.every(call=>!call.action));
  });
  await t.test('live Owner',async t=> {
    const f=await deploymentFixture(t);f.mutable.me.is_owner=false;
    await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'CLI_UPGRADE_OWNER_MISMATCH'});
    assert.equal(f.calls.some(call=>call.name==='runtime wrangler-account-readback'),false);
    assert.ok(f.calls.every(call=>!call.action));
  });
});

test('upgrade checks private instance and Credential files before sending a Credential',{skip:process.platform==='win32'},async t=> {
  for(const file of ['instance.json','credentials/current.json'])await t.test(file,async t=> {
    const f=await deploymentFixture(t);
    await chmod(path.join(f.stateRoot,'instances',f.instanceId,file),0o644);
    await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'STATE_PERMISSION_DRIFT'});
    assert.ok(f.requests.every(request=>request.authenticated===false));
    assert.ok(f.calls.every(call=>!call.action));
  });
  await t.test('Credential metadata symlink',async t=> {
    const f=await deploymentFixture(t);const file=path.join(f.stateRoot,'instances',f.instanceId,'credentials/current.json');
    await rename(file,`${file}.target`);await symlink(`${file}.target`,file);
    await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'STATE_SYMLINK_REJECTED'});
    assert.ok(f.requests.every(request=>request.authenticated===false));
    assert.ok(f.calls.every(call=>!call.action));
  });
});

test('first deployment rejects an unproven hostname before creating cloud resources',async t=> {
  const f=await deploymentFixture(t,{first:true});
  await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'CLI_DEPLOYMENT_ORIGIN_UNPROVEN'});
  assert.equal(f.calls.some(call=>call.action),false);
  assert.equal(f.calls.some(call=>call.name==='deployment prepare-owner-credential'),false);
  assert.deepEqual(f.requests.map(request=>request.path),['/client/v4/accounts/isolated-account/workers/subdomain']);
});

test('first deployment proves account hostname before creation and Worker enabled status after deployment',async t=> {
  const f=await deploymentFixture(t,{first:true,origin:'https://isolated-worker.isolated.workers.dev'});
  const result=await runWorkflow('deploy-apply',f.inputFor(),f.context);
  assert.equal(result.ok,true);
  assert.equal(f.calls.filter(call=>call.action==='create_d1').length,1);
  assert.equal(f.calls.filter(call=>call.action==='deploy_worker_and_static_assets').length,1);
  assert.equal(f.calls.filter(call=>call.name==='deployment finalize-owner').length,1);
  assert.equal(f.requests.filter(request=>request.path.endsWith('/scripts/isolated-worker/subdomain')).length,1);
});

test('first deployment does not prepare an Owner Credential until the exact Worker origin is enabled',async t=> {
  const f=await deploymentFixture(t,{first:true,origin:'https://isolated-worker.isolated.workers.dev'});f.mutable.enabled=false;
  await assert.rejects(runWorkflow('deploy-apply',f.inputFor(),f.context),{code:'CLI_DEPLOYMENT_ORIGIN_UNPROVEN'});
  assert.equal(f.calls.filter(call=>call.action==='deploy_worker_and_static_assets').length,1);
  assert.equal(f.calls.some(call=>call.name==='deployment prepare-owner-credential'),false);
});
