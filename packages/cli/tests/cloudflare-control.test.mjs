import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { COMMANDS } from '../src/catalog.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { exitCode } from '../src/main.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';

const base='/api/v1/admin/cloudflare';
const command=name=>{const found=COMMANDS.find(entry=>entry.name===name);assert.ok(found,name);return found;};
const ok=data=>({ok:true,status:200,data});
const write=resource=>ok({resource,event_cursor:1,idempotent_replay:false});
async function isolatedCliFixture(t,requestImpl) {
  const f=await createMcpStateFixture(t);
  const options={...f,requestImpl,fetchImpl:async url=>{url=new URL(url);assert.equal(url.origin,f.origin);return Response.json(url.pathname==='/.well-known/cfkanban-instance.json'?f.discovery:f.me(f.credential));}};
  return {...f,options,runtime:createCliRuntime(options)};
}
const record=async(f,id)=>JSON.parse(await readFile(path.join(f.stateRoot,'instances',f.instanceId,'cli-operations',`${id}.json`),'utf8'));
const plan=(id,version=5)=>({plan_id:id,kind:'rate_limit',version,baseline_version_id:randomUUID(),baseline_deployment_id:randomUUID(),target:{worker_name:'test-worker'},before:{limit:300},after:{limit:400},created_at:'2026-10-07T00:00:00.000Z'});
const operation=(id,status='verified',version=6)=>({operation_id:id,kind:'rate_limit',status,version,result_version_id:null,deployment_id:null,failure_class:status==='failed'?'permission_denied':null});

for(const name of ['admin cloudflare zone','admin cloudflare verify'])test(`${name} reads control before and after and freezes the initial CAS`,async t=>{
  const calls=[],zone=randomUUID();let changed=false;
  const f=await isolatedCliFixture(t,async options=>{calls.push(options);if(options.method==='GET'){assert.equal(options.apiPath,base);return ok({version:changed?5:4,target:{zone_id:zone}});}changed=true;return write({version:5,target:{zone_id:zone}});});
  const result=await f.runtime.execute(command(name),{instanceId:f.instanceId,...(name.endsWith('zone')?{zone_id:zone}:{})});
  assert.equal(result.operation.phase,'verified');assert.deepEqual(calls.map(call=>call.method),['GET',name.endsWith('zone')?'PATCH':'POST','GET']);
  assert.equal(calls[1].apiPath,name.endsWith('zone')?`${base}/settings`:`${base}/verify`);assert.deepEqual(calls[1].body,name.endsWith('zone')?{zone_id:zone,expected_version:4}:{});
});

for(const scenario of [
  {name:'admin rate-limits',path:'rate-limits',kind:'rate_limit',input:{scope:'instance',limit:400,period_seconds:60}},
  {name:'admin cloudflare configuration',path:'configuration',kind:'configuration',input:{settings:{history_enabled:true}}},
])test(`${scenario.kind} plan exact readback and apply use the frozen version rather than later control`,async t=>{
  const planId=randomUUID(),operationId=randomUUID(),frozen=plan(planId),calls=[];
  frozen.kind=scenario.kind;
  const f=await isolatedCliFixture(t,async options=>{
    calls.push(options);
    if(options.method==='GET'&&options.apiPath===base)return ok({version:4});
    if(options.apiPath===`${base}/${scenario.path}/plan`)return write(frozen);
    if(options.method==='GET'&&options.apiPath===`${base}/plans/${planId}`)return ok(frozen);
    if(options.apiPath===`${base}/${scenario.path}/apply`)return write(operation(operationId));
    assert.equal(options.apiPath,`${base}/operations/${operationId}`);return ok(operation(operationId));
  });
  const planned=await f.runtime.execute(command(scenario.kind==='configuration'?'admin cloudflare configuration-plan':'admin rate-limits plan'),{instanceId:f.instanceId,...scenario.input});
  assert.equal(planned.operation.phase,'verified');assert.equal(calls[1].body.expected_version,4);assert.equal(planned.data.resource.version,5);
  const applied=await f.runtime.execute(command(scenario.kind==='configuration'?'admin cloudflare configuration-apply':'admin rate-limits apply'),{instanceId:f.instanceId,plan_id:planId});
  assert.equal(applied.operation.phase,'verified');assert.equal(applied.cloudflare_status,'verified');assert.equal(calls.find(call=>call.apiPath.endsWith('/apply')).body.expected_version,5);
  assert.deepEqual(calls.slice(3).map(call=>call.apiPath),[`${base}/plans/${planId}`,`${base}/${scenario.path}/apply`,`${base}/operations/${operationId}`]);
});

test('mismatched frozen plan or impossible plan version stays unverified and retries only GET',async t=>{
  const planId=randomUUID(),frozen=plan(planId),calls=[];let mismatch=true;
  const f=await isolatedCliFixture(t,async options=>{calls.push(options);if(options.method==='POST')return write(frozen);if(options.apiPath===base)return ok({version:4});return ok({...frozen,...(mismatch?{after:{limit:500}}:{})});});
  const result=await f.runtime.execute(command('admin rate-limits plan'),{instanceId:f.instanceId,scope:'instance',limit:400,period_seconds:60});
  assert.equal(result.committed_unverified,true);mismatch=false;
  const recovered=await f.runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId:result.recovery.operation_id});assert.equal(recovered.operation.phase,'verified');assert.equal(calls.filter(call=>call.method==='POST').length,1);
  const second=await isolatedCliFixture(t,async options=>options.apiPath===base?ok({version:4}):options.method==='POST'?write({...frozen,version:7}):ok({...frozen,version:7}));
  assert.equal((await second.runtime.execute(command('admin rate-limits plan'),{instanceId:second.instanceId,scope:'instance',limit:400,period_seconds:60})).committed_unverified,true);
});

for(const status of ['pending','unknown'])test(`Cloudflare ${status} is never reported as applied, and safe verification preserves original intent`,async t=>{
  const planId=randomUUID(),cloudId=randomUUID(),calls=[];let current=status;
  const f=await isolatedCliFixture(t,async options=>{
    calls.push(options);
    if(options.apiPath===`${base}/plans/${planId}`)return ok(plan(planId));
    if(options.apiPath===`${base}/rate-limits/apply`)return write(operation(cloudId,current));
    if(options.apiPath.endsWith('/verify')){assert.equal(options.method,'POST');assert.deepEqual(options.body,{});current='verified';return write(operation(cloudId,current,7));}
    assert.equal(options.apiPath,`${base}/operations/${cloudId}`);return ok(operation(cloudId,current,current==='verified'?7:6));
  });
  const first=await f.runtime.execute(command('admin rate-limits apply'),{instanceId:f.instanceId,plan_id:planId});
  assert.equal(first.cloudflare_status,status);assert.equal(first.operation.phase,'committed_unverified');assert.equal(first.committed_unverified,true);assert.equal(exitCode(first),6);assert.equal(first.recovery.command,'admin cloudflare verify-operation');
  const retained=await record(f,first.operation.operation_id);
  await assert.rejects(f.runtime.execute(command('admin rate-limits apply'),{instanceId:f.instanceId,plan_id:randomUUID()}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});
  await assert.rejects(f.runtime.execute(command('admin cloudflare verify-operation'),{instanceId:f.instanceId,operation_id:randomUUID()}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});
  const verified=await f.runtime.execute(command('admin cloudflare verify-operation'),{instanceId:f.instanceId,operation_id:cloudId});
  assert.equal(verified.cloudflare_status,'verified');assert.equal(verified.operation.phase,'verified');
  const after=await record(f,first.operation.operation_id);assert.deepEqual(after.request,retained.request);assert.equal(after.idempotency_key,retained.idempotency_key);assert.deepEqual(after.identity,retained.identity);
  assert.equal(calls.filter(call=>call.apiPath.endsWith('/apply')).length,1);assert.equal(calls.filter(call=>call.apiPath.endsWith('/verify')).length,1);assert.ok(calls.every(call=>['GET','POST'].includes(call.method)));
});

for(const status of ['pending','unknown'])for(const keys of ['generated','explicit'])test(`completed ${status} verification allows a new ${keys} key without repeating apply`,async t=>{
  const planId=randomUUID(),cloudId=randomUUID(),calls=[],snapshots=new Map();let ready=false,current=operation(cloudId,status),providerWrites=0;
  const f=await isolatedCliFixture(t,async options=>{
    calls.push(options);
    if(options.apiPath===`${base}/plans/${planId}`)return ok(plan(planId));
    if(options.apiPath.endsWith('/apply')){providerWrites++;return write(current);}
    if(options.apiPath.endsWith('/verify')){
      if(!snapshots.has(options.idempotencyKey)){current=operation(cloudId,ready?'verified':status,6+snapshots.size+1);snapshots.set(options.idempotencyKey,current);}
      return write(snapshots.get(options.idempotencyKey));
    }
    assert.equal(options.apiPath,`${base}/operations/${cloudId}`);return ok(current);
  });
  const applied=await f.runtime.execute(command('admin rate-limits apply'),{instanceId:f.instanceId,plan_id:planId});
  const before=await record(f,applied.operation.operation_id);
  const first=await f.runtime.execute(command('admin cloudflare verify-operation'),{instanceId:f.instanceId,operation_id:cloudId,...(keys==='explicit'?{idempotencyKey:'verify-first-round'}:{})});
  assert.equal(first.cloudflare_status,status);assert.equal(first.operation.phase,'committed_unverified');assert.equal(exitCode(first),6);
  ready=true;
  const verified=await createCliRuntime(f.options).execute(command('admin cloudflare verify-operation'),{instanceId:f.instanceId,operation_id:cloudId,...(keys==='explicit'?{idempotencyKey:'verify-second-round'}:{})});
  assert.equal(verified.cloudflare_status,'verified');assert.equal(verified.operation.phase,'verified');
  const verifies=calls.filter(call=>call.apiPath.endsWith('/verify'));assert.equal(verifies.length,2);assert.notEqual(verifies[0].idempotencyKey,verifies[1].idempotencyKey);
  if(keys==='explicit')assert.deepEqual(verifies.map(call=>call.idempotencyKey),['verify-first-round','verify-second-round']);
  const after=await record(f,applied.operation.operation_id);assert.deepEqual(after.request,before.request);assert.equal(after.idempotency_key,before.idempotency_key);assert.deepEqual(after.identity,before.identity);
  assert.equal(providerWrites,1);assert.equal(calls.filter(call=>call.apiPath.endsWith('/apply')).length,1);
});

for(const failure of ['response','interruption'])for(const entry of ['operation recover','admin cloudflare verify-operation','admin rate-limits apply'])test(`verification ${failure} resumes the original key via ${entry}, without repeating apply`,async t=>{
  const planId=randomUUID(),cloudId=randomUUID(),calls=[],snapshots=new Map();let lost=true,current=operation(cloudId,'unknown'),providerWrites=0;
  const f=await isolatedCliFixture(t,async options=>{
    calls.push(options);
    if(options.apiPath===`${base}/plans/${planId}`)return ok(plan(planId));
    if(options.apiPath.endsWith('/apply')){providerWrites++;return write(current);}
    if(options.apiPath.endsWith('/verify')){
      if(!snapshots.has(options.idempotencyKey)){current=operation(cloudId,'verified',7);snapshots.set(options.idempotencyKey,current);}
      if(lost&&failure==='interruption')throw new Error('Verification interrupted after commit');
      return lost?{ok:false,status:0,error:{category:'platform_failure',source:'client_transport'}}:write(snapshots.get(options.idempotencyKey));
    }
    assert.equal(options.apiPath,`${base}/operations/${cloudId}`);return ok(current);
  });
  const applyInput={instanceId:f.instanceId,plan_id:planId,operationId:randomUUID()},applied=await f.runtime.execute(command('admin rate-limits apply'),applyInput),before=await record(f,applied.operation.operation_id);
  const verify=()=>f.runtime.execute(command('admin cloudflare verify-operation'),{instanceId:f.instanceId,operation_id:cloudId,idempotencyKey:'verify-retained-round'});
  if(failure==='interruption')await assert.rejects(verify(),/Verification interrupted after commit/);
  else assert.equal((await verify()).outcome_unknown,true);
  const pending=await record(f,applied.operation.operation_id);assert.equal(pending.phase,'unknown');
  lost=false;
  const recoveryInput=entry==='admin rate-limits apply'?applyInput:{instanceId:f.instanceId,...(entry==='operation recover'?{operationId:applied.operation.operation_id}:{operation_id:cloudId,idempotencyKey:'verify-replacement-round'})};
  const recovered=await createCliRuntime(f.options).execute(command(entry),recoveryInput);
  assert.equal(recovered.cloudflare_status,'verified');assert.equal(recovered.operation.phase,'verified');
  const verifies=calls.filter(call=>call.apiPath.endsWith('/verify'));assert.equal(verifies.length,2);assert.deepEqual(verifies.map(call=>call.idempotencyKey),['verify-retained-round','verify-retained-round']);assert.deepEqual(verifies[0].body,verifies[1].body);
  const after=await record(f,applied.operation.operation_id);assert.deepEqual(after.cloudflare_verification,pending.cloudflare_verification);assert.deepEqual(after.request,before.request);assert.equal(after.idempotency_key,before.idempotency_key);assert.deepEqual(after.identity,before.identity);
  assert.equal(providerWrites,1);assert.equal(calls.filter(call=>call.apiPath.endsWith('/apply')).length,1);assert.equal(snapshots.size,1);
});

test('confirmed Cloudflare failure stays terminal and unlocks only a new explicit operation',async t=>{
  const planId=randomUUID(),cloudId=randomUUID(),calls=[],newPlan=plan(randomUUID(),7);
  const f=await isolatedCliFixture(t,async options=>{
    calls.push(options);
    if(options.apiPath===`${base}/plans/${planId}`)return ok(plan(planId));
    if(options.apiPath.endsWith('/apply'))return write(operation(cloudId,'failed'));
    if(options.apiPath===`${base}/operations/${cloudId}`)return ok(operation(cloudId,'failed'));
    if(options.apiPath===base)return ok({version:6});
    if(options.apiPath.endsWith('/plan'))return write(newPlan);
    assert.equal(options.apiPath,`${base}/plans/${newPlan.plan_id}`);return ok(newPlan);
  });
  const first=await f.runtime.execute(command('admin rate-limits apply'),{instanceId:f.instanceId,plan_id:planId});
  assert.equal(first.cloudflare_status,'failed');assert.equal(first.operation.phase,'failed');assert.notEqual(exitCode(first),0);
  const before=await record(f,first.operation.operation_id);
  const recovered=await f.runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.operation.operation_id});assert.equal(recovered.operation.phase,'failed');assert.equal(recovered.cloudflare_status,'failed');assert.notEqual(exitCode(recovered),0);assert.equal(calls.filter(call=>call.method==='POST').length,1);
  const next=await f.runtime.execute(command('admin rate-limits plan'),{instanceId:f.instanceId,scope:'instance',limit:450,period_seconds:60});assert.equal(next.operation.phase,'verified');
  const after=await record(f,first.operation.operation_id);assert.deepEqual(after.request,before.request);assert.equal(after.idempotency_key,before.idempotency_key);assert.deepEqual(after.identity,before.identity);
});

test('unknown apply replays only original request and key; HTTP-unknown does not authorize verify-only',async t=>{
  const planId=randomUUID(),cloudId=randomUUID(),calls=[];let lost=true,providerWrites=0;const keys=new Set();
  const f=await isolatedCliFixture(t,async options=>{
    calls.push(options);if(options.apiPath===`${base}/plans/${planId}`)return ok(plan(planId));
    if(options.apiPath.endsWith('/apply')){if(!keys.has(options.idempotencyKey)){keys.add(options.idempotencyKey);providerWrites++;}return lost?{ok:false,status:0,error:{category:'platform_failure',source:'client_transport'}}:write(operation(cloudId));}
    assert.equal(options.apiPath,`${base}/operations/${cloudId}`);return ok(operation(cloudId));
  });
  const first=await f.runtime.execute(command('admin rate-limits apply'),{instanceId:f.instanceId,plan_id:planId});assert.equal(first.outcome_unknown,true);
  await assert.rejects(f.runtime.execute(command('admin cloudflare verify-operation'),{instanceId:f.instanceId,operation_id:cloudId}),{code:'CLI_PENDING_WRITE_RECOVERY_REQUIRED'});
  lost=false;const recovered=await createCliRuntime(f.options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.recovery.operation_id});assert.equal(recovered.cloudflare_status,'verified');
  const applies=calls.filter(call=>call.apiPath.endsWith('/apply'));assert.equal(applies.length,2);assert.equal(providerWrites,1);assert.equal(applies[0].idempotencyKey,applies[1].idempotencyKey);assert.deepEqual(applies[0].body,applies[1].body);
});

test('verify-only rejects identity drift before any verification POST',async t=>{
  const planId=randomUUID(),cloudId=randomUUID(),calls=[];
  const f=await isolatedCliFixture(t,async options=>{calls.push(options);return options.apiPath.includes('/plans/')?ok(plan(planId)):options.method==='POST'?write(operation(cloudId,'unknown')):ok(operation(cloudId,'unknown'));});
  await f.runtime.execute(command('admin rate-limits apply'),{instanceId:f.instanceId,plan_id:planId});
  const credential=await f.rotate(),changed=createCliRuntime({...f.options,fetchImpl:async url=>Response.json(new URL(url).pathname==='/.well-known/cfkanban-instance.json'?f.discovery:f.me(credential))});
  await assert.rejects(changed.execute(command('admin cloudflare verify-operation'),{instanceId:f.instanceId,operation_id:cloudId}),{code:'CLI_RECOVERY_IDENTITY_CHANGED'});assert.equal(calls.filter(call=>call.apiPath.endsWith('/verify')).length,0);
});

test('history recovery reads the requested UTC day with real zero and unknown values, without another collect',async t=>{
  const day='2026-10-06',calls=[],item={day,collected_at:'2026-10-07T00:00:00.000Z',complete_day:true,metrics:[{key:'d1_rows_read',value:0},{key:'workers_requests',value:null}]};
  const f=await isolatedCliFixture(t,async options=>{calls.push(options);if(options.method==='POST')return {ok:false,status:0,error:{category:'platform_failure',source:'client_transport'}};assert.equal(options.apiPath,'/api/v1/admin/usage/history?days=7');return ok({items:[{...item,day:'2026-10-05'},item],missing_days:['2026-10-04']});});
  const first=await f.runtime.execute(command('admin usage collect'),{instanceId:f.instanceId,day});assert.equal(first.outcome_unknown,true);
  const recovered=await createCliRuntime(f.options).execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.recovery.operation_id});assert.equal(recovered.outcome_unknown,true);assert.equal(calls.filter(call=>call.method==='POST').length,1);
  const observed=recovered.readback.data.items.find(value=>value.day===day);assert.equal(observed.metrics[0].value,0);assert.equal(observed.metrics[1].value,null);
});

test('known history capture requires exact-day readback and does not accept an unrelated day',async t=>{
  const day='2026-10-06',item={day,collected_at:'2026-10-07T00:00:00.000Z',complete_day:true,metrics:[{key:'d1_rows_read',value:null}]};let collected=false,wrong=true,posts=0;
  const f=await isolatedCliFixture(t,async options=>{if(options.method==='POST'){posts++;collected=true;return ok({items:[item]});}return ok({items:collected?[{...item,day:wrong?'2026-10-05':day}]:[]});});
  const first=await f.runtime.execute(command('admin usage collect'),{instanceId:f.instanceId,day});assert.equal(first.committed_unverified,true);wrong=false;
  const recovered=await f.runtime.execute(command('operation recover'),{instanceId:f.instanceId,operationId:first.recovery.operation_id});assert.equal(recovered.operation.phase,'verified');assert.equal(posts,1);assert.equal(recovered.readback.data.items[0].metrics[0].value,null);
});
