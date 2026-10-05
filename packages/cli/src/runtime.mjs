import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRequest, trustedApiRequest } from '../../skill-runtime/src/transport.mjs';
import { createMcpFacade } from '../../skill-runtime/src/mcp-facade.mjs';
import { getInstancePaths, initializeStateRoot, loadCurrentCredentialSecret, loadPendingCredentialSecret, validatePrivatePath } from '../../skill-runtime/src/state.mjs';
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, ensurePrivateDirectory, pathType, readJson, requireHttpsOrigin, requireUuid } from '../../skill-runtime/src/utils.mjs';
import { resolveStateRoot } from '../../skill-runtime/src/paths.mjs';
import { toolError, serializeError } from '../../skill-runtime/src/errors.mjs';
import { dispatch } from '../../skill-runtime/src/cli.mjs';
import { API_COMMANDS } from './catalog.mjs';
import { assertNoSecrets, matches, supportsServiceIdempotency, validateCommandInput } from './parser.mjs';
import { createContextResolver } from './context.mjs';
import { inspectScopeDirectory } from '../../skill-runtime/src/scope.mjs';
import { runWorkflow } from './workflows.mjs';
import { loadCanonicalLauncher, openWeb } from '../../skill-runtime/src/web-open.mjs';
import { createBrowserLaunchAndDeliver } from '../../skill-runtime/src/capability-delivery.mjs';
import { fetchDiscovery, validateDiscovery } from '../../skill-runtime/src/rebind.mjs';
import { capturedRunner } from './process.mjs';

const pick=(input,keys)=>Object.fromEntries(keys.filter(key=>input[key]!==undefined).map(key=>[key,input[key]]));
const encodePath=(template,input)=>template.replace(/\{([^}]+)\}/g,(_,field)=>encodeURIComponent(input[field]));
function readbackPath(command,input,result) {
  const base=encodePath(command.apiPath.replace(/\/commands\/[^/]+$/,''),input);
  const special={updateProjectStatusName:encodePath('/api/v1/workspaces/{workspace_id}/projects/{project_id}/statuses',input),acknowledgeNotification:'/api/v1/me/notifications?pending=false&limit=50',withdrawNotification:'/api/v1/admin/notifications?limit=50',revokeWorkspaceAdministrator:base.replace(/\/administrators\/[^/]+$/,'/administrators'),revokeProjectAdministrator:base.replace(/\/administrators\/[^/]+$/,'/administrators'),revokeMyPasskey:'/api/v1/me/passkeys',revokePrincipalPasskey:input.principal_id?`/api/v1/admin/principals/${encodeURIComponent(input.principal_id)}`:null,renameOwnerDeviceCredential:input.principal_id?`/api/v1/admin/principals/${encodeURIComponent(input.principal_id)}/credentials`:null,refreshUsage:'/api/v1/admin/usage'};
  if(Object.hasOwn(special,command.operation))return special[command.operation];
  if(command.method==='DELETE'&&command.operation==='revokeCredential'&&input.principal_id)return `/api/v1/admin/principals/${encodeURIComponent(input.principal_id)}/credentials`;
  const direct=command.apiPath.replace(/\/commands\/[^/]+$/,'');
  const entity=result?.data?.resource??result?.data?.issue??result?.data?.workspace??result?.data?.project??result?.data?.comment??result?.data?.label??result?.data?.relation??result?.data?.grant??result?.data?.notification??result?.data;
  if(command.operation==='createIssue'&&entity?.identifier) return `/api/v1/issues/${encodeURIComponent(entity.identifier)}`;
  const byOperation={createWorkspace:'/api/v1/workspaces/',createProject:encodePath('/api/v1/workspaces/{workspace_id}/projects/',input),createComment:'/api/v1/comments/',createLabel:'/api/v1/labels/',createIssueRelation:'/api/v1/relations/',createProjectGrant:'/api/v1/admin/grants/'};
  if(byOperation[command.operation]&&entity?.id) return `${byOperation[command.operation]}${encodeURIComponent(entity.id)}`;
  if(API_COMMANDS.some(entry=>entry.method==='GET'&&entry.apiPath===direct)) return encodePath(direct,input);
  const list=API_COMMANDS.find(entry=>entry.method==='GET'&&entry.apiPath===command.apiPath);
  return list?encodePath(list.apiPath,input):null;
}
function bodyFor(command,input) { return command.body?pick(input,Object.keys(command.body.properties??{})):undefined; }
function requestFor(command,input) {
  const query=new URLSearchParams();
  for(const parameter of command.parameters.filter(entry=>entry.in==='query')) {
    const inputValue=input[parameter.name === 'allow_unfiltered' ? 'allowUnfiltered' : parameter.name];
    for(const value of (Array.isArray(inputValue)?inputValue:[inputValue])) if(value!==undefined) query.append(parameter.name,String(value));
  }
  return {method:command.method,apiPath:`${encodePath(command.apiPath,input)}${query.size?`?${query}`:''}`,body:bodyFor(command,input)};
}
function versionOf(result) { return result?.data?.resource?.version??result?.data?.version??result?.data?.project?.version??result?.data?.issue?.version; }
function targetMatches(command,input,result,readback) {
  if(command.operation==='updateProjectStatusName')return (readback.data?.items??readback.data?.statuses??[]).some(item=>(item.status_key??item.key)===input.status_key&&item.display_name===input.display_name);
  const resource=result?.data?.resource??result?.data;const expected=resource?.identifier??resource?.id??input.identifier??input.comment_id??input.label_id??input.relation_id??input.attachment_id??input.notification_id??input.administrator_id??input.credential_id??input.passkey_id;
  if(!expected)return true;
  const data=readback.data;const candidates=[data,data?.resource,...(data?.items??[]),...(data?.statuses??[]),...(data?.passkeys??[]),...(data?.credentials??[])].filter(Boolean);
  const found=candidates.find(candidate=>(candidate.identifier??candidate.id??candidate.notification_id)===expected);
  if(found) {
    if(Number.isSafeInteger(resource?.version)&&(!Number.isSafeInteger(found.version)||found.version<resource.version))return false;
    if(/^revoke/.test(command.operation))return found.revoked_at!==undefined&&found.revoked_at!==null;
    if(command.operation==='withdrawNotification')return found.withdrawn_at!==undefined&&found.withdrawn_at!==null;
    return true;
  }
  if(command.operation==='revokePrincipalPasskey'&&data?.passkeys_has_more===false)return true;
  if(command.operation==='revokeMyPasskey'&&data?.has_more===false&&!data?.next_cursor)return true;
  return false;
}
export const redactOutput=value=>typeof value==='string'?value.replace(/cfk_v1_[a-f0-9]{16}_[A-Za-z0-9_-]{43}|cf[il]_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}/g,'[REDACTED]'):Array.isArray(value)?value.map(redactOutput):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,redactOutput(entry)])):value;
export function createCliRuntime({home=os.homedir(),stateRoot=resolveStateRoot({home}),directory=process.cwd(),scopeInspector=inspectScopeDirectory,fetchImpl:baseFetch=globalThis.fetch,requestImpl=apiRequest,dispatchImpl=dispatch,now=()=>Date.now(),signal=new AbortController().signal,openAuthTerminal}={}) {
  const operationContext=new AsyncLocalStorage();
  const markWriteStarted=()=>{const context=operationContext.getStore();if(context)context.writeStarted=true;};
  const fetchImpl=(url,options={})=>{if(!['GET','HEAD'].includes((options.method??'GET').toUpperCase()))markWriteStarted();return baseFetch(url,{...options,signal:options.signal?AbortSignal.any([options.signal,signal]):signal});};
  const operationRunner=options=>{const run=capturedRunner(signal,options);return (...args)=>{markWriteStarted();return run(...args);};};
  const checkCancelled=()=>{if(signal.aborted)throw toolError('CLI_OPERATION_CANCELLED','Operation cancelled; recover any retained write before another mutation');};
  const gateContext=new AsyncLocalStorage();
  const helper=async(name,input)=> {
    checkCancelled();
    const context=operationContext.getStore();
    if(name==='credential prepare'&&input.purpose==='owner_rotation'&&context?.record.command.workflow==='owner-rotate')input={...input,principalId:context.record.identity.principal_id};
    if(['invite redeem','public-join redeem'].includes(name)&&input.redeemAs==='current_principal'&&context?.record.identity)input={...input,expectedPrincipalId:context.record.identity.principal_id,expectedCredentialId:context.record.identity.credential_id,expectedApiOrigin:context.record.identity.origin};
    if(name==='owner rotate-credential'&&context?.record.command.workflow==='owner-rotate')input={...input,expectedPrincipalId:context.record.identity.principal_id,expectedCredentialId:context.record.identity.credential_id,expectedApiOrigin:context.record.identity.origin,expectedOperationId:context.record.operation_id,expectedIdempotencyKey:context.record.idempotency_key,expectedPendingFingerprint:context.record.rotation_pending?.fingerprint,expectedPendingTokenDigest:context.record.rotation_pending?.token_digest};
    if(name==='web open') {
      const publicInput=pick(input,['mode','directory','instanceId','target','delivery','sensitiveOutputAcknowledgement','onRelayReady',...(input.mode==='online'?['idempotencyKey']:[])]);
      if(publicInput.mode!=='online'&&!publicInput.directory)publicInput.directory=directory;
      return openWeb(publicInput,{onlineLauncher:input=>createBrowserLaunchAndDeliver({...input,stateRoot,fetchImpl,signal,expectedPrincipalId:context?.record.identity?.principal_id}),localLauncher:async()=> {
        const paths=[fileURLToPath(new URL('../../../',import.meta.url)),fileURLToPath(new URL('../',import.meta.url))];
        let root=null;
        for(const candidate of paths) {try {const declaration=await readJson(path.join(candidate,'release/version.json'));if(declaration.version) {root=candidate;break;}}catch {}}
        if(!root)throw toolError('LOCAL_RUNTIME_UNVERIFIED','The CLI must run from a verified canonical bundle');
        return loadCanonicalLauncher({projectionRoot:root,home,stateRoot});
      }});
    }
    const result=await dispatchImpl(name,{...input,home,stateRoot,fetchImpl,...(/^(?:deploy wrangler-action|runtime .*readback|runtime (?:cloudflare-auth-action|inspect-cloudflare-auth|resolve-cloudflare-auth)|owner-recovery |deployment inspect-existing)/.test(name)?{runner:operationRunner()}:{})});
    if(name==='credential prepare'&&input.purpose==='owner_rotation'&&context?.record.command.workflow==='owner-rotate') {
      const {metadata}=await loadPendingCredentialSecret({stateRoot,instanceId:input.instanceId});
      const binding=pick(metadata,['instance_id','principal_id','credential_id','credential_id_binding','operation_id','idempotency_key','purpose','fingerprint','token_digest']);
      if(binding.operation_id!==context.record.operation_id||binding.idempotency_key!==context.record.idempotency_key||binding.principal_id!==context.record.identity.principal_id||binding.purpose!=='owner_rotation'||context.record.rotation_pending&&canonicalDigest(binding)!==canonicalDigest(context.record.rotation_pending))throw toolError('CLI_RECOVERY_PENDING_CHANGED','Restore the pending Credential bound to the original Owner rotation');
      context.record.rotation_pending=binding;await atomicWriteJson(context.file,context.record);
    }
    return result;
  };
  const connection=async instanceId=> {
    const id=requireUuid(instanceId,'instance_id');
    const view=await createMcpFacade({home,stateRoot,fetchImpl}).callTool('cfkanban_connection_inspect',{instance_id:id});
    if(!view.ok) throw Object.assign(toolError('CLI_CONNECTION_REJECTED','Verify the selected instance and identity'),{result:view});
    const {metadata}=await loadCurrentCredentialSecret({stateRoot,instanceId:id});
    return {instance_id:id,principal_id:metadata.principal_id,credential_id:metadata.credential_id,origin:view.data.instance.trusted_api_origin};
  };
  const request=(identity,input)=>{checkCancelled();if(input.method!=='GET'&&input.method!=='HEAD')markWriteStarted();return requestImpl({...input,stateRoot,instanceId:identity.instance_id,expectedPrincipalId:identity.principal_id,expectedCredentialId:identity.credential_id,expectedApiOrigin:identity.origin,fetchImpl,signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)])});};
  const markPending=async(instanceId,operationId)=>atomicWriteJson(path.join(getInstancePaths({stateRoot,instanceId}).instanceRoot,'cli-operations','pending.json'),{schema_version:1,instance_id:instanceId,operation_id:operationId});
  const acquireLock=async(file,recover=false)=> {
    try {const handle=await open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid}));await handle.sync();return handle;}catch(error) {
      if(error.code!=='EEXIST')throw error;
      if(recover) {
        const claimFile=`${file}.recovery`;let claim;try {claim=await open(claimFile,'wx',0o600);await claim.writeFile(JSON.stringify({pid:process.pid}));await claim.sync();}catch {throw toolError('CLI_RECOVERY_LOCKED','Another recovery process may be using this lock');}
        try {await validatePrivatePath(file,'file');const old=await readJson(file);if(Number.isSafeInteger(old.pid)&&old.pid>0) {let stopped=false;try {process.kill(old.pid,0);}catch(error) {stopped=error.code==='ESRCH';}if(stopped) {await rm(file);return await acquireLock(file,false);}}}finally {await claim.close();await rm(claimFile);}
      }
      throw toolError('CLI_INSTANCE_WRITE_LOCKED','Another CLI process may be running; recover the retained operation after it stops');
    }
  };
  const gate=async(instanceId,operationId,callback)=> {
    if(gateContext.getStore()===instanceId)return callback();
    const paths=getInstancePaths({stateRoot,instanceId}); await assertNoSymlinkPath(paths.instanceRoot,home); await validatePrivatePath(paths.instanceRoot,'directory');
    const directory=path.join(paths.instanceRoot,'cli-operations');await assertNoSymlinkPath(directory,stateRoot);await ensurePrivateDirectory(directory);
    const pendingFile=path.join(directory,'pending.json');const lockFile=path.join(directory,'write.lock');await assertNoSymlinkPath(pendingFile,stateRoot);await assertNoSymlinkPath(lockFile,stateRoot);
    const lock=await acquireLock(lockFile,operationId!==undefined);
    try {
      const pending=await readJson(pendingFile,{allowMissing:true});
      if(pending&&pending.operation_id!==operationId)throw toolError('CLI_PENDING_WRITE_RECOVERY_REQUIRED','Recover the retained unknown write before starting another write or switching identity',{instance_id:instanceId,operation_id:pending.operation_id});
      const result=await gateContext.run(instanceId,callback);
      if(result.outcome_unknown||result.committed_unverified)await atomicWriteJson(pendingFile,{schema_version:1,instance_id:instanceId,operation_id:result.recovery?.operation_id??operationId});
      else await rm(pendingFile,{force:true});
      return result;
    }finally {await lock.close();await rm(lockFile);}
  };
  const operationPath=async(instanceId,operationId)=> {
    const paths=getInstancePaths({stateRoot,instanceId});
    await assertNoSymlinkPath(paths.instanceRoot,home); await validatePrivatePath(paths.instanceRoot,'directory');
    const directory=path.join(paths.instanceRoot,'cli-operations'); await assertNoSymlinkPath(directory,stateRoot); await ensurePrivateDirectory(directory); await validatePrivatePath(directory,'directory');
    return path.join(directory,`${requireUuid(operationId,'operation_id')}.json`);
  };
  const withRecord=async(instanceId,operationId,callback)=> {
    const file=await operationPath(instanceId,operationId); await assertNoSymlinkPath(file,stateRoot);
    const lockFile=`${file}.lock`; let lock;
    lock=await acquireLock(lockFile,true);
    try { return await callback(file,await readJson(file,{allowMissing:true})); } finally { await lock.close(); await rm(lockFile); }
  };
  const readbackFor=async(record,target,result)=> {
    const url=new URL(target,'https://readback.invalid');
    const deleted=record.command.method==='DELETE'&&['deleteIssue','deleteComment','deleteLabel','deleteRelation','deleteAttachment','deleteWorkspace','deleteProject'].includes(record.command.operation);
    if(deleted)url.searchParams.set('deleted','only');
    const list=API_COMMANDS.find(command=>command.method==='GET'&&encodePath(command.apiPath,record.input)===url.pathname);
    const paginated=list?.parameters.some(parameter=>parameter.in==='query'&&parameter.name==='cursor');
    const limit=list?.parameters.find(parameter=>parameter.in==='query'&&parameter.name==='limit')?.schema.maximum;
    if(paginated&&limit&&!url.searchParams.has('limit'))url.searchParams.set('limit',String(limit));
    if(record.readback_checkpoint?.target===target)url.searchParams.set('cursor',record.readback_checkpoint.cursor);
    const cursors=new Set();
    if(url.searchParams.has('cursor'))cursors.add(url.searchParams.get('cursor'));
    for(let page=0;page<10;page++) {
      const readback=await request(record.identity,{method:'GET',apiPath:url.pathname+url.search});
      delete record.readback_checkpoint;
      if(!readback.ok||targetMatches(record.command,record.input,result,readback)||!paginated||!readback.data?.next_cursor)return readback;
      const next=readback.data.next_cursor;
      if(typeof next!=='string'||cursors.has(next))return {ok:false,status:0,error:{code:'CLI_READBACK_CURSOR_INVALID',category:'platform_failure',source:'client_runtime',recovery:'recover_original_operation'}};
      cursors.add(next);url.searchParams.set('cursor',next);
      record.readback_checkpoint={target,cursor:next};
    }
    return {ok:false,status:0,error:{code:'CLI_READBACK_PAGE_LIMIT',category:'platform_failure',source:'client_runtime',recovery:'recover_original_operation'},pages_read:10};
  };
  const finish=async(file,record,result,{recovering=false}={})=> {
    const unknown=!result.ok&&(recovering||result.status===0||result.status>=500);
    if(unknown) { record.phase='unknown'; await atomicWriteJson(file,record); return {...result,outcome_unknown:true,recovery:{command:'operation recover',instance_id:record.identity.instance_id,operation_id:record.operation_id,...(record.idempotency_key?{idempotency_key:record.idempotency_key}:{}),write_contract:record.command.write_contract}}; }
    if(!result.ok) { record.phase='rejected'; record.result=result; await atomicWriteJson(file,record); return result; }
    record.phase='committed'; record.result=result;
    const target=readbackPath(record.command,record.input,result);
      if(target) {
        let readback;try {readback=await readbackFor(record,target,result);}catch {readback={ok:false,status:0,error:{code:'CLI_READBACK_INTERRUPTED',category:'platform_failure',source:'client_runtime',recovery:'recover_original_operation'}};}
        const purged=record.command.operation.startsWith('purge')&&readback.status===404&&readback.error?.category==='not_found'&&readback.error?.source==='service';
        if(!purged&&(!readback.ok||!targetMatches(record.command,record.input,result,readback))) { await atomicWriteJson(file,record); return {...result,committed_unverified:true,readback,recovery:{command:'operation recover',instance_id:record.identity.instance_id,operation_id:record.operation_id}}; } record.readback=readback;
      } else {await atomicWriteJson(file,record);return {...result,committed_unverified:true,recovery:{command:'operation recover',instance_id:record.identity.instance_id,operation_id:record.operation_id},error:{code:'CLI_READBACK_PATH_UNAVAILABLE',category:'platform_failure',source:'client_runtime',recovery:'inspect_remote_operation_evidence'}};}
    record.phase='verified'; await atomicWriteJson(file,record);
    return {...result,readback:record.readback??null,operation:{operation_id:record.operation_id,...(record.idempotency_key?{idempotency_key:record.idempotency_key}:{}),write_contract:record.command.write_contract,phase:record.phase}};
  };
  const recover=async input=>gate(input.instanceId,input.operationId,()=>withRecord(input.instanceId,input.operationId,async(file,record)=> {
    if(!record) throw toolError('CLI_OPERATION_NOT_FOUND','No retained operation exists');
    if(record.kind==='helper'&&record.command.workflow==='owner-rotate')return recoverOwnerRotation(file,record,input);
    const identity=record.identity?await connection(input.instanceId):null;
    if(record.identity&&canonicalDigest(identity)!==canonicalDigest(record.identity)) throw toolError('CLI_RECOVERY_IDENTITY_CHANGED','Restore the original connection and Credential before recovering this operation');
    if(record.phase==='verified'||record.phase==='rejected'||record.phase==='committed_delivery_failed') return terminalResult(record);
    if(record.kind==='helper') {
      if(now()-record.created_at_ms>=23*60*60*1000)throw toolError('CLI_RECOVERY_WINDOW_EXPIRED','The safe replay window expired; inspect retained and remote evidence');
      if(record.capability_digest&&canonicalDigest(input.capabilityInput)!==record.capability_digest)throw toolError('CLI_RECOVERY_CAPABILITY_REQUIRED','Reprovide the original invitation through --capability-stdin');
      const retained={...record.input,...(record.capability_digest?{capabilityInput:input.capabilityInput}:{})};
      return helperFinish(file,record,()=>executeBare(record.command,{...retained,onRelayReady:input.onRelayReady}),{recovering:true});
    }
    if(record.phase==='committed') return finish(file,record,record.result);
    const target=readbackPath(record.command,record.input,record.result);
    const readback=target?await request(identity,{method:'GET',apiPath:target}):null;
    if(record.command.write_contract==='cache-refresh'){record.phase='unknown';await atomicWriteJson(file,record);return {ok:false,status:0,outcome_unknown:true,readback,error:{code:'CLI_CACHE_REFRESH_OUTCOME_UNKNOWN',category:'platform_failure',source:'client_runtime',recovery:'inspect_usage_readback_without_repeating_refresh'},recovery:{command:'operation recover',instance_id:record.identity.instance_id,operation_id:record.operation_id,write_contract:record.command.write_contract}};}
    if(now()-record.created_at_ms>=23*60*60*1000) throw toolError('CLI_RECOVERY_WINDOW_EXPIRED','The safe replay window expired; inspect the retained operation and remote audit evidence without creating a replacement write');
    return finish(file,record,await request(identity,{...record.request,idempotencyKey:record.idempotency_key}),{recovering:true});
  }));
  const api=async(command,input)=> {
    const identity=await connection(input.instanceId);
    if(command.method==='GET') {
      if(['listIssues','listIssueCandidates','getSearchIndexStatus'].includes(command.operation)) {
        if(!input.project) {
          const detected=await scopeInspector({directory:input.directory??directory});
          const targets=detected.scope?.targets?.filter(target=>target.instance_id===input.instanceId)??[];
          if(targets.length)input={...input,project:targets.map(target=>target.project_id)};
          else if(input.allowUnfiltered!==true)throw toolError('CLI_EXPLICIT_SCOPE_REQUIRED','Supply --project, associate this directory, or explicitly use --allow-unfiltered true');
        }
      }
      return request(identity,requestFor(command,input));
    }
    const operationId=input.operationId??randomUUID(); const supportsIdempotency=supportsServiceIdempotency(command);
    if(input.idempotencyKey!==undefined&&!supportsIdempotency)throw toolError('CLI_INVALID_ARGUMENT','This Service operation uses CAS without a server Idempotency-Key contract');
    const key=supportsIdempotency?(input.idempotencyKey??`cli-${operationId}`):undefined;
    return gate(input.instanceId,operationId,()=>withRecord(input.instanceId,operationId,async(file,existing)=> {
      if(existing) {
        if(canonicalDigest(existing.original_input)!==canonicalDigest(input)||canonicalDigest(existing.identity)!==canonicalDigest(identity))throw toolError('CLI_OPERATION_EXISTS','Use operation recover with the retained operation; do not submit a fresh write');
        if(existing.phase==='verified'||existing.phase==='rejected')return {...existing.result,readback:existing.readback,operation:{operation_id:operationId,phase:existing.phase}};
        if(now()-existing.created_at_ms>=23*60*60*1000)throw toolError('CLI_RECOVERY_WINDOW_EXPIRED','Inspect the retained operation and remote evidence');
        if(existing.phase==='committed')return finish(file,existing,existing.result);
        const target=readbackPath(existing.command,existing.input,existing.result);const readback=target?await request(identity,{method:'GET',apiPath:target}):null;
        if(existing.command.write_contract==='cache-refresh'){existing.phase='unknown';await atomicWriteJson(file,existing);return {ok:false,status:0,outcome_unknown:true,readback,error:{code:'CLI_CACHE_REFRESH_OUTCOME_UNKNOWN',category:'platform_failure',source:'client_runtime',recovery:'inspect_usage_readback_without_repeating_refresh'},recovery:{command:'operation recover',instance_id:identity.instance_id,operation_id:operationId,write_contract:existing.command.write_contract}};}
        return finish(file,existing,await request(identity,{...existing.request,idempotencyKey:existing.idempotency_key}),{recovering:true});
      }
      const frozen={...input,...(command.operation==='renameOwnerDeviceCredential'?{principal_id:identity.principal_id}:{})};
      const base=readbackPath(command,frozen,null);
      let current=null;
      if(base) { const restore=command.operation.startsWith('restore');const purge=command.operation.startsWith('purge');current=await request(identity,{method:'GET',apiPath:`${base}${restore?'?deleted=only':purge?'/purge-preview':''}`}); if(!current.ok) return current; }
      const items=current?.data?.items??current?.data?.statuses??[];
      const currentItem=items.find(item=>item.id===(frozen.credential_id??frozen.administrator_id??frozen.notification_id??frozen.passkey_id)||item.key===frozen.status_key);
      if(currentItem)current={...current,data:currentItem};
      const fields=[...(command.parameters??[]).filter(entry=>entry.name.endsWith('expected_version')).map(entry=>entry.name),...Object.keys(command.body?.properties??{}).filter(name=>name.endsWith('expected_version'))];
      for(const field of fields) {
        if(frozen[field]!==undefined) continue;
        if(field==='expected_version'&&Number.isSafeInteger(versionOf(current))) frozen[field]=versionOf(current);
        else if(field==='source_expected_version'&&(frozen.identifier||current?.data?.source?.identifier)) { const source=await request(identity,{method:'GET',apiPath:`/api/v1/issues/${encodeURIComponent(frozen.identifier??current.data.source.identifier)}`}); if(!source.ok) return source; frozen[field]=versionOf(source); }
        else if(field==='target_expected_version'&&(frozen.target_identifier||current?.data?.target?.identifier)) { const target=await request(identity,{method:'GET',apiPath:`/api/v1/issues/${encodeURIComponent(frozen.target_identifier??current.data.target.identifier)}`}); if(!target.ok) return target; frozen[field]=versionOf(target); }
        else throw toolError('CLI_EXPECTED_VERSION_REQUIRED',`Supply the current ${field}; this operation has no unambiguous automatic CAS source`);
      }
      const body=bodyFor(command,frozen); if(body&&!matches(command.body,body)) throw toolError('CLI_INVALID_ARGUMENT','The request body does not satisfy the public API contract');
      assertNoSecrets(frozen);
      const requestData=requestFor(command,frozen);
      const record={schema_version:1,operation_id:operationId,identity,command,input:frozen,original_input:input,request:requestData,idempotency_key:key,created_at_ms:now(),phase:'prepared'};
      await atomicWriteJson(file,record);
      await markPending(input.instanceId,operationId);
      return finish(file,record,await request(identity,{...requestData,idempotencyKey:key}));
    }));
  };
  const unknown=result=>result?.outcome_unknown||result?.committed_unverified||result?.ok===false&&(result.status===0||result.status>=500)||result?.operation&&unknown(result.operation)||result?.verification&&unknown(result.verification)||Object.values(result?.steps??{}).some(unknown);
  const failed=result=>result?.ok===false||result?.operation?.ok===false||result?.verification?.ok===false||Object.values(result?.steps??{}).some(failed);
  const terminalResult=record=> {
    const result=record.result??{ok:false,status:0,error:{code:'CLI_REJECTED_RESULT_UNAVAILABLE',category:'platform_failure',source:'client_runtime',recovery:'inspect_original_rejection'}};
    const rejection=failed(result)?{ok:false,error:result.error??result.operation?.error??result.verification?.error,status:result.status??result.operation?.status??result.verification?.status}:{};
    return {...result,...rejection,readback:record.readback??null,operation:{operation_id:record.operation_id,phase:record.phase}};
  };
  const rotationVerified=(record,result)=> {
    const resource=result?.operation?.data?.resource;const verification=result?.verification;
    return result?.operation?.ok===true&&verification?.ok===true&&verification.is_owner===true
      &&resource?.revoked_credential_id===record.identity.credential_id&&resource.principal_id===record.identity.principal_id
      &&resource.id===verification.credential_id&&verification.principal_id===record.identity.principal_id
      &&resource.fingerprint===record.rotation_pending?.fingerprint&&verification.credential_fingerprint===record.rotation_pending?.fingerprint;
  };
  const helperFinish=async(file,record,invoke,{recovering=false}={})=> {
    const context={file,record,writeStarted:false};
    let result;
    try {result=await operationContext.run(context,invoke);}catch(error) {
      if(error.details?.committed===true) {record.phase='committed_delivery_failed';record.result={ok:false,status:503,committed:true,error:{code:error.code,category:'platform_failure',source:'client_runtime',recovery:error.details.recovery},data:pick(error.details,['invitation_id','launch_id','expires_at']),one_time_capability_hidden:true};await atomicWriteJson(file,record);return record.result;}
      const beforeWrite=!recovering&&!context.writeStarted&&error.code!=='CLI_OPERATION_CANCELLED'&&(/^(?:INVALID_|CLI_|STATE_|LOCAL_|NON_PERSISTENT_HOME_UNCONFIRMED|BROWSER_DELIVERY_UNAVAILABLE|CLIPBOARD_DELIVERY_UNAVAILABLE|PLAN_|ARTIFACT_|COMMAND_)/.test(error.code??'')||/BINDING_MISMATCH$/.test(error.code??''));
      const category=beforeWrite?/CONFLICT|DRIFT|CHANGED|LOCKED|BINDING_MISMATCH/.test(error.code??'')?'conflict':/^(?:INVALID_|CLI_(?:INVALID|UNKNOWN|MISSING|INPUT|SECRET|CAPABILITY)|ABSOLUTE_)/.test(error.code??'')?'validation':'platform_failure':'platform_failure';
      const code=beforeWrite&&typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)?error.code:serializeError(error).error.code;
      result={ok:false,status:beforeWrite?category==='conflict'?409:400:0,error:{code,category,source:'client_runtime',recovery:beforeWrite?'review_input_before_retry':'recover_original_operation'}};
      if(beforeWrite) {record.phase='rejected';record.result=result;await atomicWriteJson(file,record);return result;}
    }
    if(result?.operation?.ok===true&&result?.verification?.ok===false)result={...result,committed_unverified:true};
    if(record.command.workflow==='owner-rotate'&&!failed(result)&&!unknown(result)&&!rotationVerified(record,result))result={...result,ok:false,outcome_unknown:true,error:{code:'CLI_ROTATION_EVIDENCE_MISMATCH',category:'platform_failure',source:'client_runtime',recovery:'inspect_original_rotation_evidence'}};
    if(unknown(result)||recovering&&failed(result)) {record.phase='unknown';if(record.command.workflow==='owner-rotate')record.result=result;await atomicWriteJson(file,record);return {...result,outcome_unknown:true,recovery:{command:'operation recover',instance_id:record.instance_id,operation_id:record.operation_id,idempotency_key:record.idempotency_key}};}
    record.phase=failed(result)?'rejected':'verified'; record.result=['invite create','web open'].includes(record.command.name)&&!failed(result)?{ok:true,data:{delivery_already_attempted:true,one_time_capability_hidden:true}}:JSON.parse(JSON.stringify(result,(_,value)=>typeof value==='function'||value instanceof Promise?undefined:value));await atomicWriteJson(file,record);
    return result;
  };
  const recoverOwnerRotation=async(file,record,input)=> {
    const paths=getInstancePaths({stateRoot,instanceId:input.instanceId});
    await assertNoSymlinkPath(paths.instanceMetadata,stateRoot);await validatePrivatePath(paths.instanceMetadata,'file');
    const metadata=await readJson(paths.instanceMetadata);const {metadata:current}=await loadCurrentCredentialSecret({stateRoot,instanceId:input.instanceId});
    if(!record.identity||current.principal_id!==record.identity.principal_id||requireHttpsOrigin(metadata.trusted_api_origin)!==record.identity.origin)throw toolError('CLI_RECOVERY_IDENTITY_CHANGED','Restore the original Owner and trusted origin before recovering this rotation');
    if(current.credential_id!==record.identity.credential_id) {
      const binding=record.rotation_pending;
      if(!binding||current.operation_id!==record.operation_id||current.idempotency_key!==record.idempotency_key||current.purpose!=='owner_rotation'||current.fingerprint!==binding.fingerprint||current.token_digest!==binding.token_digest)throw toolError('CLI_RECOVERY_IDENTITY_CHANGED','The current Credential does not belong to the original Owner rotation');
      if(!rotationVerified(record,record.result)) {record.phase='unknown';await atomicWriteJson(file,record);return {ok:false,status:0,outcome_unknown:true,error:{code:'CLI_ROTATION_COMMIT_EVIDENCE_REQUIRED',category:'platform_failure',source:'client_runtime',recovery:'inspect_original_rotation_evidence'},recovery:{command:'operation recover',instance_id:input.instanceId,operation_id:record.operation_id}};}
      const identity=await connection(input.instanceId);
      if(identity.credential_id!==record.result.verification.credential_id)throw toolError('CLI_RECOVERY_IDENTITY_CHANGED','Restore the verified replacement Credential before recovering this rotation');
      record.phase='verified';await atomicWriteJson(file,record);return terminalResult(record);
    }
    if(record.phase==='rejected')return terminalResult(record);
    if(now()-record.created_at_ms>=23*60*60*1000)throw toolError('CLI_RECOVERY_WINDOW_EXPIRED','Inspect original rotation evidence after the safe replay window');
    if(record.rotation_pending) {
      const {metadata:pending}=await loadPendingCredentialSecret({stateRoot,instanceId:input.instanceId});
      const binding=pick(pending,['instance_id','principal_id','credential_id','credential_id_binding','operation_id','idempotency_key','purpose','fingerprint','token_digest']);
      if(canonicalDigest(binding)!==canonicalDigest(record.rotation_pending))throw toolError('CLI_RECOVERY_PENDING_CHANGED','Restore the pending Credential bound to the original Owner rotation');
    } else if(record.phase!=='prepared')throw toolError('CLI_RECOVERY_PENDING_CHANGED','The original rotation has no verified pending binding');
    return helperFinish(file,record,()=>executeBare(record.command,record.input),{recovering:true});
  };
  const executeBare=async(command,input)=> {
    if(command.apiPath) return api(command,input);
    if(command.name==='connection list') return createMcpFacade({home,stateRoot,fetchImpl}).callTool('cfkanban_connection_inspect',{});
    if(command.workflow==='connection-discover') {const origin=requireHttpsOrigin(input.origin);return {ok:true,status:200,data:validateDiscovery(await fetchDiscovery(origin,fetchImpl),origin),saved:false};}
    if(command.workflow==='instance-health'||command.workflow==='instance-contract')return trustedApiRequest({home,stateRoot,instanceId:input.instanceId,apiPath:command.workflow==='instance-health'?'/healthz':'/openapi.json',fetchImpl});
    if(command.name==='connection add') {
      const origin=requireHttpsOrigin(input.trustedApiOrigin);const current=await readJson(getInstancePaths({stateRoot,instanceId:input.instanceId}).instanceMetadata,{allowMissing:true});
      if(current&&current.trusted_api_origin!==origin)throw toolError('CLI_ORIGIN_REBIND_REQUIRED','Changing an existing trusted origin requires the verified origin migration flow');
      const response=await fetchImpl(new URL('/.well-known/cfkanban-instance.json',origin),{method:'GET',redirect:'error',signal:AbortSignal.timeout(15_000)});
      if(!response.ok)throw toolError('CLI_DISCOVERY_REJECTED','The selected instance discovery could not be verified');const discovery=validateDiscovery(await response.json(),origin);
      if(discovery.instance_id!==input.instanceId||discovery.preferred_api_origin!==origin)throw toolError('CLI_DISCOVERY_INSTANCE_MISMATCH','The selected origin is not this exact instance');
      return helper(command.helper,{...input,originVersion:discovery.origin_version});
    }
    if(command.workflow==='operation-show') {
      const file=await operationPath(input.instanceId,input.operationId); await assertNoSymlinkPath(file,stateRoot); await validatePrivatePath(file,'file'); const record=await readJson(file);
      return {ok:true,status:200,data:{operation_id:record.operation_id,phase:record.phase,identity:record.identity,command:record.command.name,idempotency_key:record.idempotency_key,created_at:new Date(record.created_at_ms).toISOString(),request_digest:canonicalDigest(record.request)}};
    }
    if(command.workflow==='operation-recover') return recover(input);
    if(command.workflow) return runWorkflow(command.workflow,input,{helper,api,connection,execute,home,stateRoot,fetchImpl,signal,acquireLock,openAuthTerminal,tokenRunner:operationRunner({maxBytes:64*1024,timeoutMs:30000}),authAction:async(input,runner)=>{markWriteStarted();return dispatchImpl('runtime cloudflare-auth-action',{...input,home,stateRoot,fetchImpl,runner:runner??operationRunner()});}});
    return helper(command.helper,input);
  };
  const contextResolver=createContextResolver({home,stateRoot,directory,scopeInspector,read:async(instanceId,apiPath)=>request(await connection(instanceId),{method:'GET',apiPath})});
  const executeResolved=async(command,input)=> {
    if(command.apiPath||command.workflow==='issue-reopen'||command.workflow==='operation-recover'||command.workflow==='operation-show'||command.effect==='read'||command.effect==='plan'||!input.instanceId||command.workflow==='deploy-apply')return executeBare(command,input);
    const operationId=input.operationId??randomUUID();input={...input,operationId,idempotencyKey:input.idempotencyKey??`cli-${operationId}`};
    if(['connection add','owner device prepare'].includes(command.name)&&await pathType(getInstancePaths({stateRoot,instanceId:input.instanceId}).instanceRoot)==='missing') {await initializeStateRoot({home,stateRoot,persistenceConfirmed:input.persistenceConfirmed});await ensurePrivateDirectory(getInstancePaths({stateRoot,instanceId:input.instanceId}).instanceRoot);}
    return gate(input.instanceId,operationId,()=>withRecord(input.instanceId,operationId,async(file,existing)=> {
      if(existing)throw toolError('CLI_OPERATION_EXISTS','Recover the retained operation instead of creating a replacement');
      let identity=null;
      const join=['join invite','join public'].includes(command.name);
      if(join&&(input.redeemAs??'current_principal')==='current_principal'||!join&&!['connection add','owner device prepare','owner device verify','identity verify','identity discard-pending','owner device restore-previous'].includes(command.name))identity=await connection(input.instanceId);
      const {onRelayReady,capabilityInput,...ordinary}=input; const record={schema_version:1,kind:'helper',operation_id:operationId,instance_id:input.instanceId,identity,command,input:ordinary,idempotency_key:input.idempotencyKey,created_at_ms:now(),phase:'prepared',...(capabilityInput?{capability_digest:canonicalDigest(capabilityInput)}:{})};
      await atomicWriteJson(file,record);await markPending(input.instanceId,operationId);return helperFinish(file,record,()=>executeBare(command,input));
    }));
  };
  const execute=async(command,input,{select=null}={})=> {
    checkCancelled();
    validateCommandInput(command,input,{allowContext:true});
    if(command.workflow?.startsWith('context-'))return contextResolver.run(command.workflow.slice('context-'.length),input,{select});
    if(command.name==='scope inspect'&&!input.directory)input={...input,directory};
    if(command.name==='scope show'&&!input.repoRoot)input={...input,repoRoot:(await scopeInspector({directory})).scope_directory};
    const resolved=await contextResolver.resolve(command,input,{select});
    validateCommandInput(command,resolved.input);
    const result=await executeResolved(command,resolved.input);
    if(!resolved.resolved_context||!Object.values(resolved.resolved_context.sources).some(source=>source!=='explicit'))return result;
    // Local Web results carry non-enumerable lifecycle handles; preserve them when adding diagnostics.
    const decorated=Object.defineProperties({},Object.getOwnPropertyDescriptors(result));
    decorated.resolved_context=resolved.resolved_context;
    return decorated;
  };
  return {execute,api,helper,connection};
}
