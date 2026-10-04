import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { COMMANDS } from '../src/catalog.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { authenticationDeviceRunner } from '../src/auth.mjs';
import { createCloudflareAuthPlan } from '../../skill-runtime/src/tool-runtime.mjs';
import { buildWranglerAccountProbe } from '../../skill-runtime/src/deploy.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';
const command=COMMANDS.find(entry=>entry.name==='deploy auth apply');
function inputFor(f,{mode='named_profile_browser',taskId='isolated-auth'}={}) {
  const preflight={safe_to_plan:true,blockers:[],executable:'/fixture/wrangler',version:'4.127.1',platform:process.platform,required_scopes_available:['account:read','user:read','workers_scripts:write','d1:write'],keyring:{persisted_enabled:false},profile:{exists:false,name:mode==='named_profile_browser'?'isolated-profile':'default'},capabilities:{named_profiles:true,device_flow:true}};
  const {plan,plan_digest}=createCloudflareAuthPlan({taskId,mode,preflight});
  return {plan,authorization:{task_id:taskId,plan_digest},contextDirectory:path.join(f.stateRoot,'auth-context'),persistenceConfirmed:true};
}
function readback(name,input,actions=[]) {
  if(name==='runtime inspect-cloudflare-auth')return {version:'4.127.1',profile:{name:input.profileName,exists:actions.includes('oauth_login')},keyring:{persisted_enabled:actions.includes('enable_keyring')},safe_to_plan:true};
  if(name==='runtime resolve-cloudflare-auth')return {status:'account_selection_required',candidates:[{account_id:'exact-one',profile:input.selectedProfile},{account_id:'exact-two',profile:input.selectedProfile}],selected:null};
  if(name==='runtime wrangler-account-readback'){const probe=buildWranglerAccountProbe({...input,environment:{}});assert.equal(probe.profile,input.cloudflareProfile);assert.equal(probe.context_directory,null);return {account_id:'exact-one',verified:true};}
  throw Error('Unexpected helper');
}
test('authentication journals completed actions and resumes account selection without another OAuth write',async t=> {
  const f=await createMcpStateFixture(t);const input=inputFor(f);const actions=[];
  const dispatchImpl=async(name,data)=>{if(name==='runtime cloudflare-auth-action'){actions.push(data.actionId);return {action_completed:true};}return readback(name,data,actions);};
  const options={...f,dispatchImpl};const first=await createCliRuntime(options).execute(command,input);assert.equal(first.error.code,'CLI_CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED');
  const second=await createCliRuntime(options).execute(command,{...input,accountId:'exact-one'});assert.equal(second.ok,true);assert.deepEqual(actions,['enable_keyring','oauth_login']);
  const record=JSON.parse(await readFile(path.join(f.stateRoot,'cli-auth',`${input.authorization.plan_digest}.json`),'utf8'));assert.equal(record.phase,'verified');assert.equal(record.account_id,'exact-one');
});
test('unknown OAuth resumes readback only and blocks a different authentication plan',async t=> {
  const f=await createMcpStateFixture(t);const input=inputFor(f);const actions=[];
  const dispatchImpl=async(name,data)=>{if(name==='runtime cloudflare-auth-action'){actions.push(data.actionId);if(data.actionId==='oauth_login')throw Object.assign(Error('Must not leak device codes'),{code:'WRANGLER_AUTH_ACTION_FAILED'});return {action_completed:true};}return readback(name,data,actions);};
  const options={...f,dispatchImpl};const first=await createCliRuntime(options).execute(command,input);assert.equal(first.outcome_unknown,true);
  const second=await createCliRuntime(options).execute(command,input);assert.equal(second.outcome_unknown,true);assert.equal(second.data.authentication_completed,false);assert.equal(second.data.authentication_action_replayed,false);assert.deepEqual(actions,['enable_keyring','oauth_login']);
  await assert.rejects(createCliRuntime(options).execute(command,inputFor(f,{taskId:'another-plan'})),{code:'CLI_AUTH_RECOVERY_REQUIRED'});
  const externallyCompleted={...input,accountId:'exact-one',authorization:{...input.authorization,external_authentication:{source:'official_wrangler_manual_login',profile_name:input.plan.profile.name,account_id:'exact-one',completed_action_ids:input.plan.actions.map(action=>action.id)}}};
  const continued=await createCliRuntime(options).execute(command,externallyCompleted);assert.equal(continued.ok,true);assert.equal(continued.data.current_authentication_verified,true);assert.equal(continued.data.external_resolution.original_action_commit_unproven,true);assert.deepEqual(actions,['enable_keyring','oauth_login']);
  const retained=JSON.parse(await readFile(path.join(f.stateRoot,'cli-auth',`${input.authorization.plan_digest}.json`),'utf8'));assert.equal(retained.phase,'externally_verified');assert.deepEqual(retained.completed_action_ids,['enable_keyring']);
  await assert.rejects(readFile(path.join(f.stateRoot,'cli-auth/pending.json')),{code:'ENOENT'});
  const repeated=await createCliRuntime(options).execute(command,input);assert.equal(repeated.ok,true);assert.deepEqual(actions,['enable_keyring','oauth_login']);
});
test('device authentication rejects a missing dedicated terminal before any auth action',async t=> {
  const f=await createMcpStateFixture(t);let writes=0;
  const runtime=createCliRuntime({...f,dispatchImpl:async(name,data)=>{if(name==='runtime inspect-cloudflare-auth')return readback(name,data);writes++;},openAuthTerminal:async()=>{throw Object.assign(Error('No native terminal'),{code:'CLI_AUTH_TTY_REQUIRED'});}});
  await assert.rejects(runtime.execute(command,inputFor(f,{mode:'default_profile_device'})),{code:'CLI_AUTH_TTY_REQUIRED'});assert.equal(writes,0);
});
test('device challenge goes only to the dedicated terminal and rejects other authorization origins',async()=> {
  const delivered=[];const terminal={write:async value=>{delivered.push(value);}};const runner=authenticationDeviceRunner(new AbortController().signal,terminal);
  const challenge='To authorize Wrangler, please visit:\n\n https://dash.cloudflare.com/oauth2/device\n\nand enter the code:\n\n ABCD-EFGH\n';
  const result=await runner(process.execPath,['-e',`process.stdout.write(${JSON.stringify(challenge)});process.stderr.write('secret-output-must-be-hidden');`],{});
  assert.equal(result.code,0);assert.equal(result.stdout,'');assert.equal(result.stderr,'');assert.equal(delivered.length,1);assert.match(delivered[0],/ABCD-EFGH/);assert.doesNotMatch(delivered[0],/secret-output/);
  const rejected=await runner(process.execPath,['-e',`process.stdout.write(${JSON.stringify(challenge.replace('dash.cloudflare.com','attacker.invalid'))});setTimeout(()=>{},10000);`],{});assert.equal(rejected.code,null);assert.equal(delivered.length,1);
});
