import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { initializeStateRoot, validatePrivatePath } from '../../skill-runtime/src/state.mjs';
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, ensurePrivateDirectory, readJson } from '../../skill-runtime/src/utils.mjs';
import { toolError } from '../../skill-runtime/src/errors.mjs';
import { capturedRunner } from './process.mjs';
import { executeCloudflareAuthAction } from '../../skill-runtime/src/tool-runtime.mjs';

export async function openAuthenticationTerminal() {
  try {return await open(process.platform==='win32'?'CONOUT$':'/dev/tty','w');}
  catch {throw toolError('CLI_AUTH_TTY_REQUIRED','Device authorization requires a real terminal; complete the authorized official Wrangler login manually, then use deploy auth resolve and deploy account verify');}
}

export function authenticationDeviceRunner(signal,terminal) {
  return async(executable,args,options)=> {
    let buffer='',delivered=false,deliveryFailed=false;let writing=Promise.resolve();
    const onOutput=chunk=> {
      buffer=(buffer+chunk).slice(-65536).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
      if(delivered)return;
      const challenge=/To authorize[^\n]*, please visit:\s+(https:\/\/[^\s]+)\s+and enter the code:\s+([A-Z0-9-]{6,32})\b/.exec(buffer);
      if(!challenge)return;
      const url=new URL(challenge[1]);
      if(url.origin!=='https://dash.cloudflare.com'||url.username||url.password||url.hash||url.search||url.href.length>4096)throw toolError('CLI_AUTH_CHALLENGE_REJECTED','The device authorization challenge does not belong to the verified Cloudflare authorization host');
      delivered=true;
      writing=terminal.write(`\nCloudflare 授权 / authorization\n${url.href}\nCode / 代码: ${challenge[2]}\n`).catch(()=>{deliveryFailed=true;});
      buffer='';
    };
    const result=await capturedRunner(signal,{onOutput})(executable,args,options);await writing;
    return {...result,...(!delivered||deliveryFailed?{code:null}:{}),stdout:'',stderr:''};
  };
}

export async function applyAuthentication(input,{helper,authAction,acquireLock,home,stateRoot,signal,openAuthTerminal=openAuthenticationTerminal}) {
  const plan=input.plan;const digest=canonicalDigest(plan);
  if(plan?.kind!=='cloudflare_oauth_login'||input.authorization?.task_id!==plan.task_id||input.authorization?.plan_digest!==digest||Object.keys(input.authorization).some(key=>!['task_id','plan_digest','external_authentication'].includes(key)))throw toolError('CLI_PLAN_AUTHORIZATION_REQUIRED','Provide task and digest authorization for the exact Cloudflare authentication plan');
  const external=input.authorization.external_authentication;
  if(external&&(!external||typeof external!=='object'||Object.keys(external).some(key=>!['source','profile_name','account_id','completed_action_ids'].includes(key))||external.source!=='official_wrangler_manual_login'||external.profile_name!==plan.profile.name||!input.accountId||external.account_id!==input.accountId||JSON.stringify(external.completed_action_ids)!==JSON.stringify(plan.actions?.map(action=>action.id))))throw toolError('CLI_AUTH_EXTERNAL_COMPLETION_INVALID','External completion must identify the exact frozen profile, explicitly selected account and authorized action sequence');
  const loginIndex=plan.actions?.findIndex(action=>action.id==='oauth_login');
  if(!Number.isSafeInteger(loginIndex)||loginIndex<0)throw toolError('CLI_AUTH_PLAN_INVALID','Use a complete frozen Cloudflare authentication plan');
  await executeCloudflareAuthAction({plan,actionId:'oauth_login',completedActionIds:plan.actions.slice(0,loginIndex).map(action=>action.id),authorizedTaskId:plan.task_id,authorizedPlanDigest:digest,runner:async()=>({code:0})});
  if(['WRANGLER_AUTH_DOMAIN','WRANGLER_AUTH_URL','WRANGLER_TOKEN_URL','WRANGLER_REVOKE_URL','WRANGLER_API_ENVIRONMENT'].some(name=>process.env[name]))throw toolError('CLI_AUTH_ENDPOINT_OVERRIDE_REJECTED','The frozen authentication plan permits the official production Cloudflare authorization endpoints only');
  await initializeStateRoot({home,stateRoot,persistenceConfirmed:input.persistenceConfirmed});
  const directory=path.join(stateRoot,'cli-auth');await assertNoSymlinkPath(directory,stateRoot);await ensurePrivateDirectory(directory);
  const file=path.join(directory,`${digest}.json`),pendingFile=path.join(directory,'pending.json'),lockFile=path.join(directory,'write.lock');
  for(const target of [file,pendingFile,lockFile])await assertNoSymlinkPath(target,stateRoot);
  const lock=await acquireLock(lockFile,true);let terminal;
  try {
    const pending=await readJson(pendingFile,{allowMissing:true});
    if(pending&&pending.plan_digest!==digest)throw toolError('CLI_AUTH_RECOVERY_REQUIRED','Inspect the original authentication plan before another authentication change',{plan_digest:pending.plan_digest});
    const existing=await readJson(file,{allowMissing:true});if(existing)await validatePrivatePath(file,'file');
    const record=existing??{schema_version:1,plan_digest:digest,plan,context_directory:input.contextDirectory,completed_action_ids:[],phase:'prepared'};
    if(record.plan_digest!==digest||record.context_directory!==input.contextDirectory)throw toolError('CLI_AUTH_PLAN_DRIFT','Resume with the original frozen plan and private context directory');
    if(record.phase==='running')record.phase='unknown';
    const wranglerExecutable=plan.wrangler.executable,profileName=plan.profile.name;
    const inspect=()=>helper('runtime inspect-cloudflare-auth',{wranglerExecutable,profileName,attachmentStorage:plan.oauth.attachment_storage});
    const resolve=()=>helper('runtime resolve-cloudflare-auth',{wranglerExecutable,contextDirectory:input.contextDirectory,selectedProfile:profileName});
    const accountReadback=accountId=>helper('runtime wrangler-account-readback',{wranglerExecutable,accountId,cloudflareProfile:profileName});
    const verifyExternal=async(inspection,resolution)=> {
      const accountId=record.phase==='externally_verified'?record.account_id:external.account_id;
      if(input.accountId&&input.accountId!==accountId||inspection.safe_to_plan!==true||inspection.version!==plan.wrangler.version||inspection.profile?.name!==profileName||inspection.profile.exists!==true||inspection.keyring?.persisted_enabled!==true||!resolution.candidates?.some(candidate=>candidate.account_id===accountId&&candidate.profile===profileName))throw toolError('CLI_AUTH_EXTERNAL_READBACK_REJECTED','The exact external profile, keyring preference and selected account could not be verified');
      const account=await accountReadback(accountId);
      record.phase='externally_verified';record.account_id=accountId;record.external_resolution={source:'official_wrangler_manual_login',profile_name:profileName,account_id:accountId,original_action_commit_unproven:true};
      await atomicWriteJson(file,record);await rm(pendingFile,{force:true});
      return {ok:true,data:{plan_digest:digest,completed_action_ids:record.completed_action_ids,external_resolution:record.external_resolution,current_authentication_verified:true,inspection,account,resource_writes:false}};
    };
    if(record.phase==='externally_verified')return verifyExternal(await inspect(),await resolve());
    if(record.phase==='unknown') {
      await atomicWriteJson(file,record);
      const inspection=await inspect();const resolution=await resolve();
      if(external)return verifyExternal(inspection,resolution);
      return {ok:false,status:0,outcome_unknown:true,error:{code:'CLI_AUTH_OUTCOME_UNKNOWN',category:'platform_failure',source:'client_runtime',recovery:'inspect_auth_and_complete_official_login_manually'},data:{plan_digest:digest,completed_action_ids:record.completed_action_ids,uncertain_action:record.action_id,inspection,resolution,authentication_completed:false,authentication_action_replayed:false}};
    }
    if(external)throw toolError('CLI_AUTH_EXTERNAL_COMPLETION_NOT_APPLICABLE','External completion applies only to the retained uncertain authentication action');
    if(plan.oauth.mode==='default_profile_device'&&!record.completed_action_ids.includes('oauth_login'))terminal=await openAuthTerminal();
    for(const action of plan.actions??[]) {
      if(record.completed_action_ids.includes(action.id))continue;
      const current=await inspect();const expectedKeyring=record.completed_action_ids.includes('enable_keyring')?true:plan.keyring.persisted_previously_enabled;
      if(current.safe_to_plan!==true||current.version!==plan.wrangler.version||current.profile?.name!==profileName||current.profile.exists!==(plan.profile.operation==='reauthenticate')||current.keyring?.persisted_enabled!==expectedKeyring)throw toolError('CLI_AUTH_PREFLIGHT_DRIFT','Wrangler version, profile or keyring state changed from the frozen authentication plan; create a new plan after inspecting the retained operation');
      record.phase='running';record.action_id=action.id;
      await atomicWriteJson(file,record);await atomicWriteJson(pendingFile,{schema_version:1,plan_digest:digest});
      try {await authAction({plan,actionId:action.id,completedActionIds:record.completed_action_ids,authorizedTaskId:plan.task_id,authorizedPlanDigest:digest},terminal&&action.id==='oauth_login'?authenticationDeviceRunner(signal,terminal):null);}
      catch(error) {record.phase='unknown';await atomicWriteJson(file,record);return {ok:false,status:0,outcome_unknown:true,error:{code:error.code??'CLI_AUTH_OUTCOME_UNKNOWN',category:'platform_failure',source:'client_runtime',recovery:'resume_same_plan_readback_before_any_login'},data:{plan_digest:digest,uncertain_action:action.id,authentication_completed:false,completed_action_ids:record.completed_action_ids}};}
      record.completed_action_ids.push(action.id);record.phase='prepared';delete record.action_id;await atomicWriteJson(file,record);
    }
    record.phase='actions_completed';await atomicWriteJson(file,record);
    const inspected=await inspect(),resolved=await resolve();const selected=resolved.status==='resolved'&&resolved.selected?.profile===profileName&&resolved.candidates?.length===1?resolved.selected.account_id:null;const accountId=input.accountId??selected;
    if(!accountId||!resolved.candidates?.some(candidate=>candidate.account_id===accountId&&candidate.profile===profileName))return {ok:false,status:400,error:{code:'CLI_CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED',category:'validation',source:'client_runtime',recovery:'select_exact_account_then_verify'},data:{authentication_completed:true,plan_digest:digest,completed_action_ids:record.completed_action_ids,resolution:resolved}};
    const account=await accountReadback(accountId);
    record.phase='verified';record.account_id=accountId;await atomicWriteJson(file,record);await rm(pendingFile,{force:true});
    return {ok:true,data:{plan_digest:digest,completed_action_ids:record.completed_action_ids,inspection:inspected,account,resource_writes:false}};
  } finally {await terminal?.close();await lock.close();await rm(lockFile);}
}
