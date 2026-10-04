import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { COMMANDS } from '../src/catalog.mjs';
import { exitCode } from '../src/main.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';
import { dispatch } from '../../skill-runtime/src/cli.mjs';
import { redeemInvitation, redeemPublicJoin, rotateOwnerCredential } from '../../skill-runtime/src/credential-operations.mjs';
import { createPendingCredential, loadPendingCredentialSecret } from '../../skill-runtime/src/state.mjs';

const command=name=>COMMANDS.find(entry=>entry.name===name);
const directory=f=>path.join(f.stateRoot,'instances',f.instanceId,'cli-operations');
const recordFile=(f,id)=>path.join(directory(f),`${id}.json`);
const pendingFile=f=>path.join(directory(f),'pending.json');
const readRecord=async(f,id)=>JSON.parse(await readFile(recordFile(f,id),'utf8'));
function fakeFetch(f) {
  return async url=>{url=new URL(url);assert.equal(url.origin,f.origin);return Response.json(url.pathname==='/.well-known/cfkanban-instance.json'?f.discovery:f.me(f.credential));};
}

test('a pre-write invitation rejection keeps its failure, releases the gate and hides capability input',async t=> {
  const f=await createMcpStateFixture(t);const operationId=randomUUID();let calls=0;
  const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),dispatchImpl:async()=>{calls++;return {ok:true,status:200};}});
  const result=await runtime.execute(command('join invite'),{instanceId:f.instanceId,redeemAs:'current_principal',operationId,capabilityInput:'sensitive invalid invitation'});
  assert.equal(result.error.code,'CLI_INVALID_INVITE');assert.equal(exitCode(result),2);assert.equal(calls,0);
  const record=await readRecord(f,operationId);assert.equal(record.phase,'rejected');assert.deepEqual(record.result,result);
  assert.equal(JSON.stringify(record).includes('sensitive invalid invitation'),false);
  await assert.rejects(readFile(pendingFile(f)),{code:'ENOENT'});
  const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(recovered.error.code,result.error.code);assert.equal(exitCode(recovered),2);assert.equal(calls,0);
  await runtime.execute(command('join public'),{instanceId:f.instanceId,publicId:randomUUID(),role:'reader',redeemAs:'current_principal'});assert.equal(calls,1);
  delete record.result;await writeFile(recordFile(f,operationId),JSON.stringify(record),{mode:0o600});
  const legacy=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(legacy.error.code,'CLI_REJECTED_RESULT_UNAVAILABLE');assert.notEqual(exitCode(legacy),0);
});

test('a retained nested helper rejection cannot become a successful recovery',async t=> {
  const f=await createMcpStateFixture(t);const operationId=randomUUID();let calls=0;
  const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),dispatchImpl:async()=>{calls++;return {operation:{ok:false,status:403,error:{code:'CAPABILITY_DENIED',category:'authorization',source:'service'}}};}});
  const first=await runtime.execute(command('join public'),{instanceId:f.instanceId,publicId:randomUUID(),role:'reader',redeemAs:'current_principal',operationId});
  assert.notEqual(exitCode(first),0);await assert.rejects(readFile(pendingFile(f)),{code:'ENOENT'});
  const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(recovered.ok,false);assert.equal(recovered.error.code,'CAPABILITY_DENIED');assert.equal(exitCode(recovered),exitCode(first));assert.equal(calls,1);
});

test('a local error after dispatch and a later permission denial preserve the original unknown write',async t=> {
  const f=await createMcpStateFixture(t);const operationId=randomUUID();let calls=0,posts=0;
  const fetchImpl=async(url,options={})=>{if(options.method==='POST'){posts++;return Response.json({});}return fakeFetch(f)(url);};
  const runtime=createCliRuntime({...f,fetchImpl,dispatchImpl:async(name,input)=> {
    calls++;if(calls===1){await input.fetchImpl(`${f.origin}/api/v1/public-joins/${randomUUID()}/redeem`,{method:'POST'});throw Object.assign(new Error('Do not expose response contents'),{code:'CLI_INVALID_RESPONSE'});}
    return {operation:{ok:false,status:403,error:{code:'CAPABILITY_DENIED',category:'authorization',source:'service'}}};
  }});
  const input={instanceId:f.instanceId,publicId:randomUUID(),role:'reader',redeemAs:'current_principal',operationId};
  const first=await runtime.execute(command('join public'),input);assert.equal(first.outcome_unknown,true);assert.equal(posts,1);
  const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});assert.equal(recovered.outcome_unknown,true);
  assert.equal((await readRecord(f,operationId)).phase,'unknown');assert.equal(JSON.parse(await readFile(pendingFile(f),'utf8')).operation_id,operationId);
  await assert.rejects(runtime.execute(command('join public'),{...input,operationId:randomUUID()}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});
});

for(const scenario of [
  {name:'workspace administrator remove',field:'administrator_id',resource:{revoked_at:1},input:f=>({workspace_id:f.workspaceId,expected_version:1})},
  {name:'owner device rename',field:'credential_id',resource:{device_name:'Renamed'},input:()=>({device_name:'Renamed',expected_version:1})},
  {name:'admin notification withdraw',field:'notification_id',resource:{withdrawn_at:1},input:()=>({expected_version:1})},
])test(`post-write ${scenario.name} readback finds the target beyond page one`,async t=> {
  const f=await createMcpStateFixture(t);const id=randomUUID();let writes=0;const readbacks=[];
  const resource={id,version:2,...scenario.resource};
  const requestImpl=async options=> {
    if(options.method!=='GET'){writes++;return {ok:true,status:200,data:{resource}};}
    const url=new URL(options.apiPath,f.origin);if(writes)readbacks.push(url.searchParams.get('cursor'));
    const page=Number(url.searchParams.get('cursor')??0);return {ok:true,status:200,data:{items:page===2?[resource]:[{id:randomUUID(),version:1}],next_cursor:page<2?String(page+1):null}};
  };
  const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl});
  const result=await runtime.execute(command(scenario.name),{instanceId:f.instanceId,[scenario.field]:id,...scenario.input(f)});
  assert.equal(result.operation.phase,'verified');assert.equal(writes,1);assert.deepEqual(readbacks,[null,'1','2']);await assert.rejects(readFile(pendingFile(f)),{code:'ENOENT'});
});

test('bounded committed readback resumes at its cursor without repeating a mutation',async t=> {
  const f=await createMcpStateFixture(t);const id=randomUUID(),operationId=randomUUID();let writes=0;const readbacks=[];
  const resource={id,version:2,withdrawn_at:1};
  const requestImpl=async options=> {
    if(options.method!=='GET'){writes++;return {ok:true,status:200,data:{resource}};}
    const page=Number(new URL(options.apiPath,f.origin).searchParams.get('cursor')??0);if(writes)readbacks.push(page);
    return {ok:true,status:200,data:{items:page===12?[resource]:[],next_cursor:page<12?String(page+1):null}};
  };
  const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl});
  const first=await runtime.execute(command('admin notification withdraw'),{instanceId:f.instanceId,notification_id:id,expected_version:1,operationId});
  assert.equal(first.committed_unverified,true);assert.equal(first.readback.error.code,'CLI_READBACK_PAGE_LIMIT');assert.equal(readbacks.length,10);
  assert.equal((await readRecord(f,operationId)).readback_checkpoint.cursor,'10');
  const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(recovered.operation.phase,'verified');assert.deepEqual(readbacks,Array.from({length:13},(_,i)=>i));assert.equal(writes,1);
  await assert.rejects(readFile(pendingFile(f)),{code:'ENOENT'});
});

test('invalid list cursors leave a committed write recoverable without another mutation',async t=> {
  const f=await createMcpStateFixture(t);const id=randomUUID(),operationId=randomUUID();let writes=0,cycle=true;
  const resource={id,version:2,withdrawn_at:1};
  const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f),requestImpl:async options=> {
    if(options.method!=='GET'){writes++;return {ok:true,status:200,data:{resource}};}
    return {ok:true,status:200,data:cycle?{items:[],next_cursor:'same-cursor'}:{items:[resource],next_cursor:null}};
  }});
  const first=await runtime.execute(command('admin notification withdraw'),{instanceId:f.instanceId,notification_id:id,expected_version:1,operationId});
  assert.equal(first.committed_unverified,true);assert.equal(first.readback.error.code,'CLI_READBACK_CURSOR_INVALID');
  cycle=false;const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(recovered.operation.phase,'verified');assert.equal(writes,1);
});

test('shared join helpers bind the same credential snapshot and trusted origin before sending',async t=> {
  const f=await createMcpStateFixture(t);let calls=0;const fetchImpl=async()=>{calls++;throw new Error('Unexpected network request');};
  for(const redeem of [redeemInvitation,redeemPublicJoin]) {
    const input={stateRoot:f.stateRoot,instanceId:f.instanceId,redeemAs:'current_principal',inviteCode:'fixture-code',publicId:randomUUID(),role:'reader',idempotencyKey:'fixture-key',expectedPrincipalId:f.principalId,fetchImpl};
    await assert.rejects(redeem({...input,expectedCredentialId:randomUUID()}),{code:'CREDENTIAL_BINDING_MISMATCH'});
    await assert.rejects(redeem({...input,expectedPrincipalId:randomUUID(),expectedCredentialId:f.credential.credential_id}),{code:'PRINCIPAL_BINDING_MISMATCH'});
    await assert.rejects(redeem({...input,expectedCredentialId:f.credential.credential_id,expectedApiOrigin:'https://different.invalid'}),{code:'TRUSTED_ORIGIN_BINDING_MISMATCH'});
  }
  assert.equal(calls,0);
});

test('Owner rotation checks the complete pending token binding before replay',async t=> {
  const f=await createMcpStateFixture(t);const operationId=randomUUID(),idempotencyKey=randomUUID();let calls=0;
  await createPendingCredential({...f,persistenceConfirmed:true,principalId:f.principalId,purpose:'owner_rotation',operationId,idempotencyKey});
  const {metadata}=await loadPendingCredentialSecret(f);
  await assert.rejects(rotateOwnerCredential({...f,expectedPrincipalId:f.principalId,expectedCredentialId:f.credential.credential_id,expectedApiOrigin:f.origin,expectedOperationId:operationId,expectedIdempotencyKey:idempotencyKey,expectedPendingFingerprint:metadata.fingerprint,expectedPendingTokenDigest:'0'.repeat(64),fetchImpl:async()=>{calls++;}}),{code:'STATE_PENDING_CONFLICT'});
  assert.equal(calls,0);
});

test('a promoted Owner credential alone cannot prove the retained rotation committed',async t=> {
  const f=await createMcpStateFixture(t);const operationId=randomUUID(),replacementId=randomUUID();let reads=0;
  const fetchImpl=async(url,options={})=> {
    url=new URL(url);assert.equal(url.origin,f.origin);reads++;
    if(url.pathname==='/.well-known/cfkanban-instance.json')return Response.json(f.discovery);
    if(options.method==='POST') {
      const {metadata}=await loadPendingCredentialSecret(f);
      return Response.json({resource:{id:replacementId,principal_id:f.principalId,fingerprint:metadata.fingerprint,revoked_credential_id:f.credential.credential_id}});
    }
    const pending=await loadPendingCredentialSecret(f).catch(()=>null);
    return Response.json({...f.me(pending?{...pending.metadata,credential_id:replacementId}:f.credential),is_owner:true});
  };
  const runtime=createCliRuntime({...f,fetchImpl,dispatchImpl:async(name,input)=> {
    // The fixture deliberately owns an isolated temporary HOME.
    const result=await dispatch(name,{...input,...(name==='credential prepare'?{persistenceConfirmed:true}:{})});
    return name==='owner rotate-credential'?{...result,operation:{ok:false,status:0,error:{code:'PLATFORM_UNAVAILABLE',category:'platform_failure',source:'client_transport'}}}:result;
  }});
  const first=await runtime.execute(command('owner rotate'),{instanceId:f.instanceId,operationId});assert.equal(first.outcome_unknown,true);
  const previousReads=reads;const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(recovered.outcome_unknown,true);assert.equal(recovered.error.code,'CLI_ROTATION_COMMIT_EVIDENCE_REQUIRED');assert.equal(reads,previousReads);
  assert.equal((await readRecord(f,operationId)).phase,'unknown');assert.equal(JSON.parse(await readFile(pendingFile(f),'utf8')).operation_id,operationId);
});

test('a committed Owner rotation with failed verification keeps pending state until exact replay verifies',async t=> {
  const f=await createMcpStateFixture(t);const operationId=randomUUID(),replacementId=randomUUID();let posts=0,oldMe=0,denyVerification=true,pending;
  const fetchImpl=async(url,options={})=> {
    url=new URL(url);assert.equal(url.origin,f.origin);
    if(url.pathname==='/.well-known/cfkanban-instance.json')return Response.json(f.discovery);
    if(options.method==='POST') {
      posts++;pending??=await loadPendingCredentialSecret(f);
      assert.ok(JSON.parse(options.body).new_credential_token===pending.token,'Replay must use the original pending Credential');
      assert.equal(new Headers(options.headers).get('idempotency-key'),`cli-${operationId}`);
      return Response.json({resource:{id:replacementId,principal_id:f.principalId,fingerprint:pending.metadata.fingerprint,revoked_credential_id:f.credential.credential_id}});
    }
    if(pending&&new Headers(options.headers).get('authorization')===`Bearer ${pending.token}`) {
      if(denyVerification){const requestId=randomUUID();return Response.json({code:'CAPABILITY_DENIED',category:'authorization',source:'service',message:'Fixture refusal',recovery:'verify_current_permissions',request_id:requestId,retryable:false,details:{}},{status:403,headers:{'x-request-id':requestId}});}
      return Response.json({...f.me({...pending.metadata,credential_id:replacementId}),is_owner:true});
    }
    oldMe++;assert.equal(posts,0,'Recovery must not authenticate the revoked original Credential');
    return Response.json({...f.me(f.credential),is_owner:true});
  };
  const runtime=createCliRuntime({...f,fetchImpl,dispatchImpl:(name,input)=>dispatch(name,{...input,...(name==='credential prepare'?{persistenceConfirmed:true}:{})})});
  const first=await runtime.execute(command('owner rotate'),{instanceId:f.instanceId,operationId});
  assert.equal(first.committed_unverified,true);assert.equal(first.outcome_unknown,true);assert.equal(first.operation.ok,true);assert.equal(first.verification.status,403);
  assert.equal((await readRecord(f,operationId)).phase,'unknown');assert.equal(JSON.parse(await readFile(pendingFile(f),'utf8')).operation_id,operationId);
  await assert.rejects(runtime.execute(command('join public'),{instanceId:f.instanceId,publicId:randomUUID(),role:'reader',redeemAs:'current_principal'}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});
  denyVerification=false;const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(recovered.operation.ok,true);assert.equal(recovered.verification.credential_id,replacementId);assert.equal(posts,2);assert.equal(oldMe,1);
  await assert.rejects(readFile(pendingFile(f)),{code:'ENOENT'});
  const again=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(again.operation.phase,'verified');assert.equal(posts,2);assert.equal(oldMe,1);
});

test('unconfirmed temporary HOME rejects Owner prepare before mutation without leaving a recovery gate',async t=> {
  const f=await createMcpStateFixture(t);const operationId=randomUUID();
  const runtime=createCliRuntime({...f,fetchImpl:fakeFetch(f)});
  const first=await runtime.execute(command('owner rotate'),{instanceId:f.instanceId,operationId});
  assert.equal(first.ok,false);assert.equal(first.error.code,'NON_PERSISTENT_HOME_UNCONFIRMED');assert.equal(first.outcome_unknown,undefined);
  assert.equal((await readRecord(f,operationId)).phase,'rejected');await assert.rejects(readFile(pendingFile(f)),{code:'ENOENT'});
  const recovered=await runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId});
  assert.equal(recovered.error.code,first.error.code);assert.notEqual(exitCode(recovered),0);
});
