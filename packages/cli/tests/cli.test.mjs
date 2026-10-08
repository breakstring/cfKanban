import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { API_COMMANDS, COMMANDS } from '../src/catalog.mjs';
import { main, EXIT_CODES } from '../src/main.mjs';
import { commandFields, parseArguments } from '../src/parser.mjs';
import { createCliRuntime, redactOutput } from '../src/runtime.mjs';
import { runWorkflow, recordFirstDeploymentLedger } from '../src/workflows.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';
const command=name=>COMMANDS.find(entry=>entry.name===name);
const api=name=>API_COMMANDS.find(entry=>entry.name===name);
function fakeFetch(fixture) { return async(url,options)=> {url=new URL(url);assert.equal(url.origin,fixture.origin);assert.ok(options.signal instanceof AbortSignal);if(url.pathname==='/.well-known/cfkanban-instance.json')return Response.json(fixture.discovery);if(url.pathname==='/api/v1/me')return Response.json(fixture.me(fixture.credential));throw new Error('Unexpected fixture request');}; }
test('no argument and progressive bilingual help are offline and never read stdin',async()=> {
  for(const argv of [[],['howto'],['issue'],['issue','create','--help'],['--locale','zh-CN'],['--json']]) {
    let output='';const unread={async *[Symbol.asyncIterator](){throw new Error('Help read stdin');}};
    const code=await main(argv,{stdin:unread,stdout:{write:value=>output+=value},stderr:{write:()=>assert.fail('Unexpected error')},runtime:{execute:()=>assert.fail('Help reached runtime')}});
    assert.equal(code,0);assert.match(output,/cfkanban/);if(argv.includes('--json'))assert.equal(JSON.parse(output).result.offline,true);
  }
  assert.ok(COMMANDS.length>150);assert.equal(new Set(COMMANDS.map(entry=>entry.name)).size,COMMANDS.length);
  assert.deepEqual(EXIT_CODES,{success:0,validation:2,authentication:3,authorization:4,conflict:5,outcome_unknown:6,platform_failure:7,not_found:8});
});
test('strict flags, required fields and bounded input fail before any execution',async()=> {
  const id=randomUUID();
  for(const argv of [ ['--bogus','value','--help'],['issue','create','--instance',id],['issue','show','--instance',id,'--identifier','CFK-1','--identifier','CFK-2'],['issue','show','--instance',id,'--identifier','CFK-1','--yes','true'],['attachment','upload','--instance',id],['issue','create','--instance',id,'--workspace-id',id,'--project-id',id,'--title','x','--body-stdin','--input-stdin'] ])await assert.rejects(parseArguments(argv),error=>/^CLI_/.test(error.code));
  await assert.rejects(parseArguments(['issue','create','--instance',id,'--workspace-id',id,'--project-id',id,'--title','x','--body-file','oversize'],{fileRead:async()=> 'x'.repeat(300000)}),{code:'CLI_INPUT_TOO_LARGE'});
  const parsed=await parseArguments(['comment','create','--instance',id,'--identifier','CFK-1','--body-stdin'],{stdin:Readable.from(['## Evidence\n\n中文'])});assert.equal(parsed.input.body,'## Evidence\n\n中文');
  await assert.rejects(parseArguments(['join','invite','--instance',id,'--invite-code','secret']),{code:'CLI_UNKNOWN_OPTION'});
  const invite=await parseArguments(['join','invite','--instance',id,'--redeem-as','current_principal','--capability-stdin'],{stdin:Readable.from(['https://fixture.invalid/invite?code=opaque'])});assert.equal(invite.input.capabilityInput,'https://fixture.invalid/invite?code=opaque');
  await assert.rejects(parseArguments(['invite','create','--instance',id,'--input-stdin'],{stdin:Readable.from([JSON.stringify({body:{kind:'principal_recovery',token:'bad'}})])}),{code:'CLI_SECRET_INPUT_REJECTED'});
  const rawCapability=`cfi_v1_abcdefgh_${'A'.repeat(43)}`;await assert.rejects(parseArguments(['comment','create','--instance',id,'--identifier','CFK-1','--body',rawCapability]),{code:'CLI_SECRET_INPUT_REJECTED'});assert.equal(redactOutput({body:rawCapability}).body,'[REDACTED]');
  await assert.rejects(parseArguments(['issue','update','--instance',id,'--identifier','CFK-1','--title','Changed','--idempotency-key','unsupported']),{code:'CLI_UNKNOWN_OPTION'});
});
test('search index commands route bounded read-only metadata with explicit project cursors',async t=> {
  const f=await createMcpStateFixture(t);const calls=[];
  const runtime=createCliRuntime({...f,scopeInspector:()=>assert.fail('Explicit search targets inspected repository'),fetchImpl:fakeFetch(f),requestImpl:async options=>{calls.push(options);return {ok:true,status:200,data:{items:[],next_cursor:'next'}};}});
  const cases=[
    ['status','--project',f.projectId,'--project',f.workspaceId],
    ['snapshot','--project',f.projectId,'--cursor','opaque-snapshot','--limit','100'],
    ['changes','--project',f.projectId,'--after','opaque-delta','--limit','10'],
  ];
  for(const [action,...flags] of cases) {
    const parsed=await parseArguments(['search-index',action,'--instance',f.instanceId,...flags]);
    assert.equal(parsed.command.effect,'read');
    await runtime.execute(parsed.command,parsed.input);
    const call=calls.at(-1);const url=new URL(call.apiPath,f.origin);
    assert.equal(call.method,'GET');assert.equal(url.pathname,`/api/v1/search-index/${action}`);
    assert.deepEqual(url.searchParams.getAll('project'),action==='status'?[f.projectId,f.workspaceId]:[f.projectId]);
    if(action==='snapshot')assert.equal(url.searchParams.get('cursor'),'opaque-snapshot');
    if(action==='changes')assert.equal(url.searchParams.get('after'),'opaque-delta');
  }
  await assert.rejects(parseArguments(['search-index','snapshot','--instance',f.instanceId,'--cursor','cursor']),{code:'CLI_MISSING_ARGUMENT'});
  await assert.rejects(parseArguments(['search-index','changes','--instance',f.instanceId,'--project',f.projectId,'--after','cursor','--limit','101']),{code:'CLI_INVALID_ARGUMENT'});
  let output='';await main(['search-index','status','--help'],{stdout:{write:value=>output+=value},stderr:{write:()=>assert.fail('Unexpected help error')}});assert.match(output,/--allow-unfiltered/);
});
test('create reads the exact new resource; CAS writes freeze version and verify readback',async t=> {
  const f=await createMcpStateFixture(t);const calls=[];
  let version=4;const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl:async options=> {calls.push(options);if(options.method==='POST')return {ok:true,status:201,data:{resource:{identifier:'CFK-12',version:1}}};if(options.method==='PATCH'){version=5;return {ok:true,status:200,data:{resource:{identifier:'CFK-12',version:5}}};}return {ok:true,status:200,data:{identifier:'CFK-12',version}};}});
  const created=await runtime.execute(api('issue create'),{instanceId:f.instanceId,workspace_id:f.workspaceId,project_id:f.projectId,title:'Create'});assert.equal(created.operation.phase,'verified');assert.equal(calls.at(-1).apiPath,'/api/v1/issues/CFK-12');
  calls.length=0;
  const changed=await runtime.execute(api('issue update'),{instanceId:f.instanceId,identifier:'CFK-12',title:'Changed'});assert.equal(changed.operation.phase,'verified');assert.equal(calls.find(call=>call.method==='PATCH').body.expected_version,4);assert.equal(calls.find(call=>call.method==='PATCH').idempotencyKey,undefined);assert.equal(changed.operation.write_contract,'cas');
});
test('conditional and optional Service idempotency contracts expose keys without changing CAS-only commands',async()=> {
  const instanceId=randomUUID();const passkeyId=randomUUID();
  const cases=[
    ['profile update',['profile','update','--theme','blue'],'idempotent-cas'],
    ['passkey revoke',['passkey','revoke','--passkey-id',passkeyId],'csrf-idempotent-cas-delete'],
    ['admin homepage update',['admin','homepage','update','--notice-en','Approved','--notice-zh-cn','已授权'],'idempotent-cas'],
    ['admin attachment-capacity update',['admin','attachment-capacity','update','--limit-bytes','4096'],'idempotent-cas'],
  ];
  for(const [name,argv,mode] of cases) {
    assert.equal(api(name).write_contract,mode);assert.ok(commandFields(api(name))['idempotency-key']);
    const parsed=await parseArguments([...argv,'--instance',instanceId,'--expected-version','7','--idempotency-key','retained-key']);assert.equal(parsed.input.idempotencyKey,'retained-key');
  }
  for(const argv of [['admin','passkey','revoke','--passkey-id',passkeyId,'--principal-id',randomUUID()],['issue','reopen','--identifier','CFK-1','--status-key','todo']])await assert.rejects(parseArguments([...argv,'--instance',instanceId,'--idempotency-key','unsupported']),{code:'CLI_UNKNOWN_OPTION'});
});
test('profile, personal Passkey and Owner settings recover the exact server key and original CAS',async t=> {
  for(const name of ['profile update','passkey revoke','admin homepage update','admin attachment-capacity update'])await t.test(name,async t=> {
    const f=await createMcpStateFixture(t);const calls=[];const passkeyId=randomUUID();let drop=true;let committed=false;
    const input={instanceId:f.instanceId,idempotencyKey:`retained-${name.replaceAll(' ','-')}`,...({'profile update':{theme:'blue'},'passkey revoke':{passkey_id:passkeyId},'admin homepage update':{notice_en:'Approved',notice_zh_cn:'已授权'},'admin attachment-capacity update':{limit_bytes:4096}}[name])};
    const requestImpl=async options=> {
      calls.push(options);const resource={...(name==='profile update'?{id:f.principalId}:name==='passkey revoke'?{id:passkeyId,revoked_at:committed?123:null}:{}),version:committed?8:7};
      if(options.method==='GET')return {ok:true,status:200,data:name==='passkey revoke'?{items:[resource],has_more:false}:resource};
      committed=true;if(drop){drop=false;return {ok:false,status:0,error:{category:'platform_failure',code:'PLATFORM_UNAVAILABLE',source:'client_transport'}};}
      return {ok:true,status:200,data:{resource:{...resource,version:8},idempotent_replay:true}};
    };
    const options={...f,fetchImpl:fakeFetch(f),requestImpl};const first=await createCliRuntime(options).execute(api(name),input);assert.equal(first.outcome_unknown,true);
    const recovered=await createCliRuntime(options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.recovery.operation_id});assert.equal(recovered.operation.phase,'verified');assert.equal(recovered.operation.idempotency_key,input.idempotencyKey);
    const attempts=calls.filter(call=>call.method!=='GET');assert.equal(attempts.length,2);assert.equal(attempts[0].idempotencyKey,input.idempotencyKey);assert.equal(attempts[1].idempotencyKey,input.idempotencyKey);assert.deepEqual(attempts[1].body,attempts[0].body);assert.equal(attempts[1].apiPath,attempts[0].apiPath);
    if(name==='passkey revoke')assert.match(attempts[0].apiPath,/expected_version=7/);else assert.equal(attempts[0].body.expected_version,7);
    const record=JSON.parse(await readFile(path.join(f.stateRoot,'instances',f.instanceId,'cli-operations',`${first.recovery.operation_id}.json`),'utf8'));assert.equal(record.idempotency_key,input.idempotencyKey);assert.equal(record.phase,'verified');
  });
  const f=await createMcpStateFixture(t);let requests=0;const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl:async()=>{requests++;assert.fail('CAS-only key reached Service');}});
  await assert.rejects(runtime.execute(api('admin passkey revoke'),{instanceId:f.instanceId,passkey_id:randomUUID(),principal_id:f.principalId,idempotencyKey:'unsupported'}),{code:'CLI_INVALID_ARGUMENT'});
  await assert.rejects(runtime.execute(command('issue reopen'),{instanceId:f.instanceId,identifier:'CFK-1',statusKey:'todo',idempotencyKey:'unsupported'}),{code:'CLI_INVALID_ARGUMENT'});assert.equal(requests,0);
});
test('cross-process unknown write blocks new operation and recovers exact caller payload CAS and key',async t=> {
  const f=await createMcpStateFixture(t);const calls=[];let lose=true;
  const requestImpl=async options=> {calls.push(options);if(options.method==='POST')return lose?{ok:false,status:0,error:{category:'platform_failure',code:'PLATFORM_UNAVAILABLE',source:'client_transport'}}:{ok:true,status:200,data:{resource:{identifier:'CFK-9',version:3}}};return {ok:true,status:200,data:{identifier:'CFK-9',version:lose?2:3}};};
  const first=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl});const result=await first.execute(api('issue block'),{instanceId:f.instanceId,identifier:'CFK-9',reason:'Exact Markdown',idempotencyKey:'original-key'});assert.equal(result.outcome_unknown,true);
  const second=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl});const writes=calls.filter(call=>call.method==='POST').length;
  await assert.rejects(second.execute(api('issue update'),{instanceId:f.instanceId,identifier:'CFK-9',title:'Replacement'}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});assert.equal(calls.filter(call=>call.method==='POST').length,writes);
  await assert.rejects(second.execute(command('owner device restore-previous'),{instanceId:f.instanceId,expectedCurrentPrincipalId:f.principalId,expectedCurrentCredentialId:f.credential.credential_id}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});
  lose=false;const recovered=await second.execute(command('operation recover'),{instanceId:f.instanceId,operationId:result.recovery.operation_id});assert.equal(recovered.operation.phase,'verified');
  const attempts=calls.filter(call=>call.method==='POST');assert.equal(attempts.length,2);assert.deepEqual(attempts[0].body,attempts[1].body);assert.equal(attempts[0].idempotencyKey,attempts[1].idempotencyKey);
  const directory=path.join(f.stateRoot,'instances',f.instanceId,'cli-operations');for(const entry of await readdir(directory)){const raw=await readFile(path.join(directory,entry),'utf8');assert.doesNotMatch(raw,/cfk_v1_[a-f0-9]{16}_[A-Za-z0-9_-]{43}/);}
});
test('verified Cloudflare refusals remain terminal CLI decisions through the real transport',async t=> {
  for(const entry of [
    {category:'authorization',code:'FORBIDDEN',failureClass:'permission_denied',status:403},
    {category:'conflict',code:'VERSION_CONFLICT',failureClass:'target_mismatch',status:409},
  ])await t.test(String(entry.status),async t=> {
    const f=await createMcpStateFixture(t);const operationId=randomUUID();let writes=0;
    const fetchImpl=async(url,options)=> {
      url=new URL(url);assert.equal(url.origin,f.origin);
      if(url.pathname==='/.well-known/cfkanban-instance.json'||url.pathname==='/api/v1/me')return fakeFetch(f)(url,options);
      if(url.pathname==='/api/v1/admin/cloudflare')return Response.json({version:7});
      assert.equal(url.pathname,'/api/v1/admin/cloudflare/verify');assert.equal(options.method,'POST');writes++;
      const requestId=randomUUID();
      return Response.json({code:entry.code,category:entry.category,source:'cloudflare_platform',message:'Cloudflare control request could not be verified.',request_id:requestId,retryable:false,recovery:'request_owner',details:{component:'cloudflare-control',failure_class:entry.failureClass}},{status:entry.status,headers:{'x-request-id':requestId}});
    };
    const options={...f,fetchImpl};
    const result=await createCliRuntime(options).execute(api('admin cloudflare verify'),{instanceId:f.instanceId,operationId,idempotencyKey:'verified-refusal'});
    assert.equal(result.ok,false);assert.equal(result.status,entry.status);assert.equal(result.error.code,entry.code);assert.equal(result.error.category,entry.category);assert.equal(result.error.source,'cloudflare_platform');assert.equal(result.outcome_unknown,undefined);assert.equal(result.recovery,undefined);
    const record=JSON.parse(await readFile(path.join(f.stateRoot,'instances',f.instanceId,'cli-operations',`${operationId}.json`),'utf8'));assert.equal(record.phase,'rejected');
    const recovered=await createCliRuntime(options).execute(command('operation recover'),{instanceId:f.instanceId,operationId});assert.equal(recovered.status,entry.status);assert.equal(recovered.error.source,'cloudflare_platform');assert.equal(writes,1);
  });
});
test('an unverified Cloudflare refusal retains the original CLI request CAS and key for recovery',async t=> {
  const f=await createMcpStateFixture(t);const writes=[];const planId=randomUUID(),settings={history_enabled:true},plan={plan_id:planId,kind:'configuration',version:8,after:settings};let committed=false;let first=true;
  const fetchImpl=async(url,options)=> {
    url=new URL(url);assert.equal(url.origin,f.origin);
    if(url.pathname==='/.well-known/cfkanban-instance.json'||url.pathname==='/api/v1/me')return fakeFetch(f)(url,options);
    if(options.method==='GET'){if(url.pathname===`/api/v1/admin/cloudflare/plans/${planId}`)return Response.json(plan);assert.equal(url.pathname,'/api/v1/admin/cloudflare');return Response.json({version:committed?8:7});}
    assert.equal(options.method,'POST');assert.equal(url.pathname,'/api/v1/admin/cloudflare/configuration/plan');
    writes.push({path:url.pathname,body:JSON.parse(options.body),key:new Headers(options.headers).get('idempotency-key')});committed=true;
    if(first){first=false;return Response.json({code:'FORBIDDEN',category:'authorization',source:'cloudflare_platform',message:'Unverified outer response',request_id:randomUUID(),retryable:false,recovery:'request_owner',details:{}},{status:403});}
    return Response.json({resource:plan,idempotent_replay:true});
  };
  const options={...f,fetchImpl};const input={instanceId:f.instanceId,settings,idempotencyKey:'original-cloudflare-key'};
  const firstResult=await createCliRuntime(options).execute(api('admin cloudflare configuration-plan'),input);
  assert.equal(firstResult.status,503);assert.equal(firstResult.error.details.normalized_by,'client');assert.equal(firstResult.outcome_unknown,true);
  await assert.rejects(createCliRuntime(options).execute(api('admin cloudflare configuration-plan'),{instanceId:f.instanceId,settings:{history_enabled:false}}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});assert.equal(writes.length,1);
  const recovered=await createCliRuntime(options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:firstResult.recovery.operation_id});
  assert.equal(recovered.operation.phase,'verified');assert.equal(recovered.operation.idempotency_key,input.idempotencyKey);assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);assert.deepEqual(writes[0].body,{settings,expected_version:7});assert.equal(writes[0].key,input.idempotencyKey);
});
test('prepared crash evidence is retained and tombstone pre-read/after-read differs for restore and delete',async t=> {
  const f=await createMcpStateFixture(t);const calls=[];
  let version=2;const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl:async options=> {calls.push(options);if(options.method!=='GET')version++;return {ok:true,status:200,data:options.method==='GET'?{identifier:'CFK-3',version}:{resource:{identifier:'CFK-3',version}}};}});
  const restored=await runtime.execute(api('issue restore'),{instanceId:f.instanceId,identifier:'CFK-3'});assert.equal(restored.operation.phase,'verified');assert.equal(calls[0].apiPath,'/api/v1/issues/CFK-3?deleted=only');assert.equal(calls.at(-1).apiPath,'/api/v1/issues/CFK-3');
  calls.length=0;await runtime.execute(api('issue delete'),{instanceId:f.instanceId,identifier:'CFK-3'});assert.equal(calls.at(-1).apiPath,'/api/v1/issues/CFK-3?deleted=only');
  const operationId=randomUUID();const directory=path.join(f.stateRoot,'instances',f.instanceId,'cli-operations');await writeFile(path.join(directory,'pending.json'),JSON.stringify({operation_id:operationId}),{mode:0o600});
  await assert.rejects(runtime.execute(api('issue update'),{instanceId:f.instanceId,identifier:'CFK-3',title:'Another'}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});
});
test('helper writes retain key and private phase across invocations, without preserving capability input',async t=> {
  const f=await createMcpStateFixture(t);let fail=true;const calls=[];
  const dispatchImpl=async(name,input)=>{calls.push({name,input});return fail?{ok:false,status:503,error:{category:'platform_failure',code:'PLATFORM_UNAVAILABLE'}}:{ok:true,data:{uploaded:true}};};
  const options={...f,fetchImpl:fakeFetch(f),dispatchImpl};const first=createCliRuntime(options);
  const result=await first.execute(command('attachment upload'),{instanceId:f.instanceId,identifier:'CFK-3',filePath:'/explicit/file'});assert.equal(result.outcome_unknown,true);
  fail=false;const second=createCliRuntime(options);await second.execute(command('operation recover'),{instanceId:f.instanceId,operationId:result.recovery.operation_id});assert.equal(calls[0].input.idempotencyKey,calls[1].input.idempotencyKey);
});
test('cancellation reaches the actual transport and retains an in-flight write for recovery',async t=> {
  const f=await createMcpStateFixture(t);const controller=new AbortController();let signalled=false;
  const runtime=createCliRuntime({...f,signal:controller.signal,fetchImpl:fakeFetch(f),requestImpl:async options=>{assert.ok(options.signal instanceof AbortSignal);if(options.method==='PATCH'){controller.abort();signalled=options.signal.aborted;return {ok:false,status:0,error:{category:'platform_failure',code:'PLATFORM_UNAVAILABLE'}};}return {ok:true,status:200,data:{identifier:'CFK-1',version:1}};}});
  const result=await runtime.execute(api('issue update'),{instanceId:f.instanceId,identifier:'CFK-1',title:'Cancel'});assert.equal(signalled,true);assert.equal(result.outcome_unknown,true);assert.ok(result.recovery.operation_id);
});
test('multi-step board uses returned stable IDs; deployment rejects blanket or drifted authorization before helpers',async()=> {
  const workspaceId=randomUUID();const calls=[];
  const result=await runWorkflow('board-create',{instanceId:randomUUID(),workspaceName:'Workspace',projectName:'Project'},{api:async(command,input)=>{calls.push({command,input});return {ok:true,status:201,data:{resource:{id:workspaceId}},readback:{data:{id:workspaceId}}};}});
  assert.equal(result.ok,true);assert.equal(calls[1].input.workspace_id,workspaceId);assert.equal(calls[0].input.display_name,'Workspace');assert.notEqual(calls[0].input.operationId,calls[1].input.operationId);
  let invoked=false;await assert.rejects(runWorkflow('deploy-apply',{plan:{kind:'strict_zero_deploy',task_id:'task',operation_id:randomUUID(),target:{instance_id:randomUUID()}},authorization:{yes:true}},{helper:()=>{invoked=true;}}),{code:'CLI_PLAN_AUTHORIZATION_REQUIRED'});assert.equal(invoked,false);
});
test('first-deploy ledger initializer cannot baseline an existing unjournaled database',async t=> {
  const f=await createMcpStateFixture(t);await assert.rejects(recordFirstDeploymentLedger({...f,operationId:randomUUID(),taskId:'task',plan:{kind:'strict_zero_deploy'}}));
});
