import { randomUUID } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { API_COMMANDS } from './catalog.mjs';
import { toolError } from '../../skill-runtime/src/errors.mjs';
import { appendJournalEvent, assertJournalAuthorization } from '../../skill-runtime/src/journal.mjs';
import { getInstancePaths, loadCurrentCredentialSecret, validatePrivatePath } from '../../skill-runtime/src/state.mjs';
import { assertNoSymlinkPath, atomicWritePrivateText, canonicalDigest, readJson, requireHttpsOrigin, sha256Bytes } from '../../skill-runtime/src/utils.mjs';
import { reconcileMigrationState } from '../../skill-runtime/src/migrations.mjs';
import { assertReleaseMatchesPlan } from '../../skill-runtime/src/deployment-finalize.mjs';
import { fetchDiscovery, validateDiscovery } from '../../skill-runtime/src/rebind.mjs';
import { trustedApiRequest } from '../../skill-runtime/src/transport.mjs';
import { verifyInstalledServiceBundle } from '../../skill-runtime/src/service-bundle.mjs';
import { createCloudflareControlClient } from '../../skill-runtime/src/cloudflare-control.mjs';
import { inspectCliInstallation, installCliLauncher, rollbackCliRelease, uninstallCliLauncher } from '../../skill-runtime/src/cli-install.mjs';
import { applyAuthentication } from './auth.mjs';

const apiCommand=name=>API_COMMANDS.find(command=>command.name===name);
function assertAuthorization(input) {
  const authorization=input.authorization;
  if(!authorization||Object.keys(authorization).some(key=>!['task_id','operation_id','instance_id','plan_digest'].includes(key))||authorization.task_id!==input.taskId||authorization.operation_id!==input.operationId||authorization.instance_id!==input.instanceId||authorization.plan_digest!==canonicalDigest(input.plan)) throw toolError('CLI_PLAN_AUTHORIZATION_REQUIRED','Provide authorization bound to the exact task, instance, operation and frozen plan digest; blanket --yes is unsupported');
}
export async function runWorkflow(name,input,context) {
  const {helper,api}=context;
  if(name.startsWith('cli-')) {
    const functions={'cli-status':inspectCliInstallation,'cli-install':installCliLauncher,'cli-rollback':rollbackCliRelease,'cli-uninstall':uninstallCliLauncher};
    return functions[name]({...input,releaseRoot:path.join(context.stateRoot,'skill-releases')});
  }
  if(name==='issue-reopen') return api(apiCommand('issue update'),{instanceId:input.instanceId,identifier:input.identifier,status_key:input.statusKey??'todo',expected_version:input.expectedVersion,operationId:input.operationId,idempotencyKey:input.idempotencyKey});
  if(name==='owner-rotate') {
    const operationId=input.operationId??randomUUID();
    await helper('credential prepare',{instanceId:input.instanceId,operationId,idempotencyKey:input.idempotencyKey??`cli-${operationId}`,purpose:'owner_rotation'});
    return helper('owner rotate-credential',{instanceId:input.instanceId});
  }
  if(name==='join-invite'||name==='join-public') {
    const operationId=input.operationId??randomUUID(); const key=input.idempotencyKey??`cli-${operationId}`;
    const mode=input.redeemAs??'current_principal';
    if(mode!=='current_principal') await helper('credential prepare',{instanceId:input.instanceId,operationId,idempotencyKey:key,purpose:mode==='recovery'?'principal_recovery':'new_principal',persistenceConfirmed:input.persistenceConfirmed});
    if(name==='join-public') return helper('public-join redeem',{instanceId:input.instanceId,publicId:input.publicId,role:input.role,redeemAs:mode,displayName:input.displayName,idempotencyKey:key});
    let url; try { url=new URL(input.capabilityInput); } catch { throw toolError('CLI_INVALID_INVITE','The secure stdin input must be one invitation URL'); }
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/invite'||!url.searchParams.get('code')) throw toolError('CLI_INVALID_INVITE','The secure stdin input must be one HTTPS invitation URL');
    const state=await helper('state inspect',{instanceId:input.instanceId});
    if(url.origin!==state.instance?.trusted_api_origin&&url.origin!==state.trusted_api_origin) throw toolError('CLI_INVITE_ORIGIN_MISMATCH','The invitation belongs to a different trusted instance');
    return helper('invite redeem',{instanceId:input.instanceId,inviteCode:url.searchParams.get('code'),redeemAs:mode,displayName:input.displayName,idempotencyKey:key});
  }
  if(name==='board-create') {
    if(!input.workspaceName||!input.projectName) throw toolError('CLI_BOARD_NAMES_REQUIRED','Provide both Workspace and Project display names');
    const operationId=input.operationId??randomUUID();
    const stepId=suffix=>{const digest=canonicalDigest(`${operationId}-${suffix}`);return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;};
    const workspace=await api(apiCommand('workspace create'),{instanceId:input.instanceId,display_name:input.workspaceName,operationId:stepId('workspace'),idempotencyKey:`${operationId}-workspace`});
    if(!workspace.ok||workspace.outcome_unknown||workspace.committed_unverified) return workspace;
    const resource=workspace.data?.resource??workspace.data?.workspace??workspace.data;
    const project=await api(apiCommand('project create'),{instanceId:input.instanceId,workspace_id:resource.id,display_name:input.projectName,operationId:stepId('project'),idempotencyKey:`${operationId}-project`});
    return {ok:project.ok===true,status:project.status,data:{workspace:workspace.readback?.data??resource,project:project.readback?.data??project.data},steps:{workspace,project},partial_commit:!project.ok||project.outcome_unknown||project.committed_unverified,...(project.outcome_unknown?{outcome_unknown:true}:{}),...(project.committed_unverified?{committed_unverified:true}:{}),...(project.recovery?{recovery:project.recovery}:{})};
  }
  if(name==='auth-apply') {
    return applyAuthentication(input,context);
  }
  if(name==='deploy-apply') return applyDeployment(input,context);
  throw toolError('CLI_UNKNOWN_WORKFLOW','Unknown public workflow');
}

async function verifyUpgradeConnection(input,{stateRoot,fetchImpl}) {
  const {plan,instanceId,apiOrigin}=input;
  const paths=getInstancePaths({stateRoot,instanceId});
  await assertNoSymlinkPath(paths.instanceMetadata,stateRoot);
  await validatePrivatePath(stateRoot,'directory');
  await validatePrivatePath(paths.instanceRoot,'directory');
  await validatePrivatePath(paths.instanceMetadata,'file');
  const instance=await readJson(paths.instanceMetadata);
  if(plan.instance_id!==instanceId||plan.target.instance_id!==instanceId||instance.instance_id!==instanceId||apiOrigin!==plan.target.api_origin||apiOrigin!==instance.trusted_api_origin||!Number.isSafeInteger(instance.origin_version)||instance.origin_version<1)throw toolError('CLI_DEPLOYMENT_ORIGIN_DRIFT','Upgrade must preserve the exact frozen origin and valid origin version of the existing trusted instance');
  const discovery=validateDiscovery(await fetchDiscovery(apiOrigin,fetchImpl),apiOrigin);
  if(discovery.instance_id!==instanceId||discovery.preferred_api_origin!==apiOrigin||discovery.origin_version<1||discovery.origin_version<instance.origin_version)throw toolError('CLI_UPGRADE_DISCOVERY_MISMATCH','The existing trusted origin no longer confirms this exact instance');
  await validatePrivatePath(paths.credentialsRoot,'directory');
  await assertNoSymlinkPath(paths.currentMetadata,stateRoot);
  await assertNoSymlinkPath(paths.currentSecret,stateRoot);
  await validatePrivatePath(paths.currentMetadata,'file');
  const credential=await loadCurrentCredentialSecret({stateRoot,instanceId});
  const metadata=credential.metadata,owner=plan.owner;
  if(metadata.instance_id!==instanceId||metadata.state!=='current'||metadata.principal_id!==owner?.principal_id||metadata.credential_id!==owner?.credential_id||metadata.fingerprint!==owner?.credential_fingerprint)throw toolError('CLI_UPGRADE_OWNER_MISMATCH','The current private Owner Credential differs from the frozen upgrade plan');
  const readback=async apiPath=> {
    const response=await trustedApiRequest({stateRoot,instanceId,apiPath,expectedApiOrigin:apiOrigin,authorizationToken:credential.token,fetchImpl});
    if(!response.ok)throw toolError('DEPLOYMENT_READBACK_FAILED','Upgrade preflight did not receive a direct JSON success response',{apiPath,status:response.status});
    return response.data;
  };
  const [meta,me]=await Promise.all([
    readback('/api/v1/meta'),
    readback('/api/v1/me'),
  ]);
  if(meta.instance_id!==instanceId||meta.observed_origin!==apiOrigin||meta.preferred_api_origin!==apiOrigin||meta.origin_version!==discovery.origin_version||meta.principal?.id!==owner.principal_id||meta.principal?.is_owner!==true||me.id!==owner.principal_id||me.principal_id!==owner.principal_id||me.display_name!==owner.display_name||me.is_owner!==true||me.credential?.id!==owner.credential_id||me.credential?.fingerprint!==owner.credential_fingerprint)throw toolError('CLI_UPGRADE_OWNER_MISMATCH','Authenticated readback does not confirm the exact existing instance, Owner and Credential');
  await appendJournalEvent({...input,stateRoot,event:{type:'cli_upgrade_trusted_origin_verified',api_origin:apiOrigin,instance_id:instanceId,origin_version:discovery.origin_version,principal_id:owner.principal_id,credential_id:owner.credential_id}});
}
const workersDevOrigin=(plan,account)=> {
  if(!/^[a-z0-9-]+$/.test(account?.subdomain??''))throw toolError('CLI_DEPLOYMENT_ORIGIN_UNPROVEN','Cloudflare did not prove the exact account workers.dev subdomain');
  return `https://${plan.resources.worker.name}.${account.subdomain}.workers.dev`;
};
async function applyDeployment(input,{helper,stateRoot,fetchImpl,tokenRunner}) {
  const plan=input.plan; input={...input,instanceId:input.instanceId??plan?.target?.instance_id??plan?.evidence?.instance_id,operationId:input.operationId??plan?.operation_id,taskId:input.taskId??plan?.task_id};
  assertAuthorization(input);
  if(!['strict_zero_deploy','deployed_instance_upgrade','deployment_attachment','owner_credential_recovery'].includes(plan.kind)) throw toolError('CLI_UNSUPPORTED_PLAN','This public workflow does not support that plan kind');
  await helper('journal create',input); await helper('journal authorize',{...input,planDigest:canonicalDigest(plan)});
  const journalFile=path.join(getInstancePaths({stateRoot,instanceId:input.instanceId}).journalsRoot,`${input.operationId}.json`);
  const lockFile=`${journalFile}.cli.lock`; await assertNoSymlinkPath(lockFile,stateRoot); let lock;
  try { lock=await open(lockFile,'wx',0o600); } catch { throw toolError('CLI_DEPLOYMENT_LOCKED','Another process may be running this deployment; verify it stopped before removing its private lock'); }
  try {
    if(plan.kind==='deployment_attachment') return helper('deployment attach',input);
    if(plan.kind==='owner_credential_recovery') return helper('owner-recovery execute',input);
    if(!input.apiOrigin&&plan.kind==='deployed_instance_upgrade')input={...input,apiOrigin:plan.target.api_origin};
    if(!input.apiOrigin) throw toolError('CLI_DEPLOYMENT_ORIGIN_REQUIRED','Provide the exact deployed API origin for bootstrap and final readback');
    input={...input,apiOrigin:requireHttpsOrigin(input.apiOrigin)};
    if(plan.kind==='deployed_instance_upgrade')await verifyUpgradeConnection(input,{stateRoot,fetchImpl});
    const verified=await helper('release verify',input); const {service}=assertReleaseMatchesPlan(verified,plan);
    await verifyInstalledServiceBundle({bundleRoot:input.serviceBundleRoot,expectedVersion:service.version,expectedSha256:service.sha256,expectedPublisher:verified.manifest.publisher.canonical_origin,expectedSource:service.url??service.source});
    const cloud={wranglerExecutable:input.wranglerExecutable,accountId:plan.target.cloudflare_account_id,cloudflareProfile:plan.target.cloudflare_profile,contextDirectory:plan.target.cloudflare_auth_context_directory,fetchImpl};
    await helper('runtime wrangler-account-readback',cloud);
    let routingControl;
    if(plan.kind==='strict_zero_deploy') {
      routingControl=await createCloudflareControlClient({...cloud,tokenRunner},'/workers',{errorPrefix:'CLI_ROUTING',resourceLabel:'Worker routing'});
      if(input.apiOrigin!==workersDevOrigin(plan,await routingControl('/subdomain')))throw toolError('CLI_DEPLOYMENT_ORIGIN_UNPROVEN','First deployment requires the exact workers.dev hostname proven for this account and Worker');
    }
    const journal=()=>readJson(journalFile); const finished=async action=>(await journal()).events.findLast(event=>event.type==='command_finished'&&event.action===action)?.exit_code===0;
    const started=async action=>(await journal()).events.some(event=>event.type==='command_started'&&event.action===action);
    const action=async(name,extra={})=>helper('deploy wrangler-action',{...input,action:name,...extra});
    let d1=await helper('runtime d1-resource-readback',{...cloud,d1Name:plan.resources.d1.name});
    if(plan.kind==='strict_zero_deploy') {
      if(!await started('create_d1')) {
        const worker=await helper('runtime worker-resource-readback',{...cloud,workerName:plan.resources.worker.name});
        if(d1.status!=='absent'||worker.status!=='absent') throw toolError('CLI_DEPLOYMENT_RESOURCE_PRESENT','First deployment requires both exact resource names to be absent');
        await appendJournalEvent({stateRoot,...input,event:{type:'cli_first_deploy_absence_verified',account_id:cloud.accountId,d1_name:plan.resources.d1.name,worker_name:plan.resources.worker.name}});
        await action('create_d1'); d1=await helper('runtime d1-resource-readback',{...cloud,d1Name:plan.resources.d1.name});
        if(d1.status!=='present')throw toolError('CLI_DEPLOYMENT_D1_MISSING','Exact D1 readback is required after creation');
        await appendJournalEvent({stateRoot,...input,event:{type:'cli_created_d1_verified',database_id:d1.database_id,d1_name:plan.resources.d1.name,account_id:cloud.accountId}});
      } else if(!await finished('create_d1')) throw toolError('CLI_D1_CREATE_OUTCOME_UNKNOWN','D1 creation was not confirmed; a present same-name database cannot be adopted after an uncertain create');
      if(d1.status!=='present') throw toolError('CLI_DEPLOYMENT_D1_MISSING','The created D1 must be read back by exact name');
      const created=(await journal()).events.findLast(event=>event.type==='cli_created_d1_verified');
      if(!created||created.database_id!==d1.database_id||created.d1_name!==plan.resources.d1.name)throw toolError('CLI_D1_CREATE_IDENTITY_UNVERIFIED','The exact created D1 UUID is missing or changed; do not adopt a same-name replacement');
    } else if(d1.database_id!==plan.resources.d1.database_id) throw toolError('CLI_DEPLOYMENT_RESOURCE_DRIFT','The exact D1 UUID changed');
    let event=(await journal()).events.findLast(event=>event.type==='wrangler_config_written');
    if(event&&event.d1_database_id!==d1.database_id)throw toolError('CLI_DEPLOYMENT_RESOURCE_DRIFT','Fresh D1 UUID differs from the frozen config');
    const config=event?{wrangler_config_path:event.config_path}:await helper('deployment write-wrangler-config',{...input,d1DatabaseId:d1.database_id});
    const configPath=config.wrangler_config_path; const bundle=input.serviceBundleRoot;
    const shared={configPath,migrationReadbackSqlPath:path.join(bundle,'release/deployment/migration-readback.sql'),migrationLedgerSchemaSqlPath:path.join(bundle,'release/deployment/migration-ledger.sql')};
    const manifest=await readJson(path.join(bundle,'migrations/manifest.json'));
    if(plan.kind==='strict_zero_deploy') {
      if(!await finished('initialize_migration_checksum_ledger')) await action('initialize_migration_checksum_ledger',shared);
      if(!await finished('apply_non_destructive_migrations')) {
        if(await started('apply_non_destructive_migrations')) throw toolError('CLI_MIGRATION_OUTCOME_UNKNOWN','Migration execution was interrupted; inspect bounded remote schema/ledger evidence before any further apply');
        await action('apply_non_destructive_migrations',shared);
      }
      await action('migration_ledger_readback',shared);
      const readback=(await journal()).events.findLast(event=>event.migration_readback)?.migration_readback;
      await recordFirstDeploymentLedger({...input,stateRoot,manifest,readback,configPath,helper,shared});
    } else {
      await action('migration_ledger_readback',shared);
      for(const migration of plan.migrations.ordered) {
        let readback=(await journal()).events.findLast(event=>event.migration_readback)?.migration_readback;
        let state=reconcileMigrationState({manifest,ledger:readback.ledger,schema:readback.schema});
        const observed=state.migrations.find(entry=>entry.sequence===migration.sequence);
        if(observed?.state==='applied') continue;
        if(observed?.state==='pending') await action('apply_migration',{...shared,migrationName:migration.name,migrationSqlPath:path.join(bundle,'migrations',migration.name)});
        await action('migration_ledger_readback',shared);
        const recovery=await helper('migrations assess-ledger-recovery',{...input,migrationManifestPath:path.join(bundle,'migrations/manifest.json')});
        if(recovery.safe_to_record_missing_checksum) { const sql=await helper('migrations write-ledger-record-sql',{...input,migration,migrationManifestPath:path.join(bundle,'migrations/manifest.json')}); await action('record_migration_checksum',{...shared,migrationName:migration.name,migrationRecordSqlPath:sql.migration_record_sql_path}); await action('migration_ledger_readback',shared); }
      }
    }
    const finalReadback=(await journal()).events.findLast(event=>event.migration_readback)?.migration_readback;
    const state=reconcileMigrationState({manifest,ledger:finalReadback.ledger,schema:finalReadback.schema});
    if(!state.safe_to_continue||state.migrations.some(entry=>entry.state!=='applied')) throw toolError('CLI_MIGRATION_STATE_UNSAFE','Migration ledger/schema readback is incomplete or drifted');
    if(plan.resources.r2) await helper('deployment provision-r2-storage',input);
    if(!await finished('validate_worker_bundle')) await action('validate_worker_bundle',shared);
    if(!await finished('deploy_worker_and_static_assets')) {
      if(await started('deploy_worker_and_static_assets')) { if(plan.current?.provenance!=='remote_observed') throw toolError('CLI_WORKER_DEPLOY_OUTCOME_UNKNOWN','Worker deployment was interrupted; inspect exact remote deployment evidence before another attempt'); await action('worker_deployment_readback',shared); }
      else { if(plan.kind==='strict_zero_deploy'&&(await helper('runtime worker-resource-readback',{...cloud,workerName:plan.resources.worker.name})).status!=='absent') throw toolError('CLI_WORKER_RESOURCE_PRESENT','Worker appeared before first deployment'); await action('deploy_worker_and_static_assets',shared); }
    }
    await action('worker_deployment_readback',shared);
    if(plan.kind==='strict_zero_deploy') {
      const [account,subdomain]=await Promise.all([routingControl('/subdomain'),routingControl(`/scripts/${plan.resources.worker.name}/subdomain`)]);
      if(subdomain?.enabled!==true||input.apiOrigin!==workersDevOrigin(plan,account))throw toolError('CLI_DEPLOYMENT_ORIGIN_UNPROVEN','The API origin must be the exact enabled workers.dev hostname proven by Cloudflare for this account and Worker');
      await appendJournalEvent({stateRoot,...input,event:{type:'cli_workers_dev_origin_verified',api_origin:input.apiOrigin,worker_name:plan.resources.worker.name,account_id:cloud.accountId}});
      await helper('deployment prepare-owner-credential',input);
      const sql=await helper('bootstrap write-owner-sql',{...input,configPath,preferredApiOrigin:input.apiOrigin});
      if(!await finished('bootstrap_owner')) { if(await started('bootstrap_owner')) { const recovery=await action('owner_bootstrap_readback',{...shared,bootstrapSqlPath:sql.bootstrap_sql_path}); if(!recovery.owner_bootstrap_readback.safe_to_retry) return helper('deployment finalize-owner',{...input,configPath}); } await action('bootstrap_owner',{...shared,bootstrapSqlPath:sql.bootstrap_sql_path}); }
      return helper('deployment finalize-owner',{...input,configPath});
    }
    return helper('deployment finalize-upgrade',{...input,configPath});
  } finally { await lock.close(); await rm(lockFile); }
}

export async function recordFirstDeploymentLedger(input) {
  const {stateRoot,instanceId,operationId,taskId,plan,manifest,readback,helper,shared}=input;
  const journal=await assertJournalAuthorization(input);
  if(plan.kind!=='strict_zero_deploy'||!journal.events.some(event=>event.type==='cli_first_deploy_absence_verified'&&event.d1_name===plan.resources.d1.name&&event.worker_name===plan.resources.worker.name)||!journal.events.some(event=>event.type==='command_finished'&&event.action==='create_d1'&&event.exit_code===0)||!journal.events.some(event=>event.type==='command_finished'&&event.action==='apply_non_destructive_migrations'&&event.exit_code===0)) throw toolError('CLI_INITIAL_LEDGER_AUTHORIZATION_REQUIRED','Initial checksum recording requires the same authorized first deployment and confirmed new-D1 migration apply');
  const config=journal.events.findLast(event=>event.type==='wrangler_config_written');
  const created=journal.events.findLast(event=>event.type==='cli_created_d1_verified');
  const latestReadback=journal.events.findLastIndex(event=>event.type==='command_finished'&&event.action==='migration_ledger_readback'&&event.exit_code===0);
  const latestApply=journal.events.findLastIndex(event=>event.type==='command_finished'&&event.action==='apply_non_destructive_migrations'&&event.exit_code===0);
  if(!config||!created||created.database_id!==config.d1_database_id||created.d1_name!==plan.resources.d1.name||created.account_id!==plan.target.cloudflare_account_id||latestReadback<=latestApply||canonicalDigest(journal.events[latestReadback].migration_readback)!==canonicalDigest(readback))throw toolError('CLI_INITIAL_LEDGER_READBACK_REQUIRED','Use the exact created D1 UUID and fresh same-journal bounded migration readback after confirmed migration apply');
  const receipt=await readJson(path.join(path.dirname(config.service_bundle_root),'.cfkanban-release.json'));
  await verifyInstalledServiceBundle({bundleRoot:config.service_bundle_root,expectedVersion:plan.release.service_bundle_version,expectedSha256:plan.release.service_bundle_sha256,expectedPublisher:receipt.publisher,expectedSource:receipt.source});
  const frozenManifest=await readJson(path.join(config.service_bundle_root,'migrations/manifest.json'));
  if(canonicalDigest(frozenManifest)!==canonicalDigest(manifest))throw toolError('CLI_INITIAL_LEDGER_MANIFEST_DRIFT','Use the exact manifest from the verified immutable Service bundle');
  const state=reconcileMigrationState({manifest,ledger:readback.ledger,schema:readback.schema});
  if(state.unknown_ledger_rows.length||state.migrations.some(entry=>entry.state!=='applied'&&!(entry.reason==='schema_present_ledger_missing'||entry.reason==='uninitialized_data_ledger_missing'))) throw toolError('CLI_INITIAL_LEDGER_SCHEMA_DRIFT','Every migration must have complete verified schema artifacts from the same new database');
  const paths=getInstancePaths({stateRoot,instanceId});
  for(const migration of manifest.migrations) {
    if(state.migrations.find(entry=>entry.sequence===migration.sequence)?.state==='applied') continue;
    if(migration.destructive||!Number.isSafeInteger(migration.sequence)||!/^[a-f0-9]{64}$/.test(migration.sha256)||!/^[-A-Za-z0-9_.]+$/.test(migration.name)||!/^[-A-Za-z0-9_.]+$/.test(migration.reentry)||!/^[-A-Za-z0-9_]+$/.test(migration.classification)) throw toolError('CLI_INITIAL_LEDGER_MANIFEST_INVALID','Migration metadata is unsafe');
    const file=path.join(paths.journalsRoot,`${operationId}.migration-${migration.sequence}.sql`);
    const sql=`INSERT INTO cfkanban_migration_ledger (sequence,name,sha256,classification,reentry,operation_id,applied_at) SELECT ${migration.sequence},'${migration.name}','${migration.sha256}','${migration.classification}','${migration.reentry}','${operationId}',${Date.now()} WHERE NOT EXISTS (SELECT 1 FROM cfkanban_migration_ledger WHERE sequence=${migration.sequence} OR name='${migration.name}');\n`;
    await atomicWritePrivateText(file,sql);
    await appendJournalEvent({stateRoot,instanceId,operationId,event:{type:'migration_record_sql_written',migration_record_sql_path:file,migration_record_sql_sha256:sha256Bytes(await readFile(file)),migration:{sequence:migration.sequence,name:migration.name,sha256:migration.sha256},source:'same_new_database_complete_schema'}});
    await helper('deploy wrangler-action',{...input,action:'record_migration_checksum',...shared,migrationName:migration.name,migrationRecordSqlPath:file});
    await helper('deploy wrangler-action',{...input,action:'migration_ledger_readback',...shared});
  }
}
