import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachDeployment, createDeploymentAttachmentPlan, inspectDeploymentAttachment } from '../../packages/skill-runtime/src/deployment-attach.mjs';
import { createInstanceUpgradePlan } from '../../packages/skill-runtime/src/upgrade-plan.mjs';
import { executeWranglerAction } from '../../packages/skill-runtime/src/deploy.mjs';
import { assertPriorReceipt } from '../../packages/skill-runtime/src/instance-upgrade.mjs';
import { createJournal, authorizeJournal } from '../../packages/skill-runtime/src/journal.mjs';
import { createPendingCredential, loadPendingCredentialSecret, promotePendingCredential, putInstanceMetadata, getInstancePaths } from '../../packages/skill-runtime/src/state.mjs';
import { treeDigest } from '../../packages/skill-runtime/src/skill-update.mjs';
import { sha256Bytes, canonicalDigest } from '../../packages/skill-runtime/src/utils.mjs';

// Cloudflare 与应用请求全部由内存 SQLite 和严格端点 fixture 接管。
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function fixture(t, { credential = true, r2 = false, customDomain = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cfkanban-attach-'));
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  db.exec('CREATE TABLE cfkanban_migration_ledger(sequence INTEGER, name TEXT, sha256 TEXT, classification TEXT, reentry TEXT, operation_id TEXT, applied_at INTEGER)');
  t.after(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  const instanceId = randomUUID(), owner = randomUUID(), databaseId = randomUUID(), versionId = randomUUID(), deploymentId = randomUUID();
  const schemaVersion = r2 ? 6 : 1;
  const origin = customDomain ? 'https://board.invalid' : 'https://isolated-worker.isolated.workers.dev', publisher = 'https://publisher.invalid';
  const manifest = { manifest_version: 1, schema_version: schemaVersion, migrations: [{ sequence: 1, name: '0001_initial.sql', sha256: 'a'.repeat(64), classification: 'bootstrap', reentry: 'ledger_only', expected_artifacts: { tables: ['principals', 'credentials', 'instance_meta', 'instance_origin_settings'], indexes: [], columns: [] } }] };
  db.prepare('INSERT INTO principals(id,display_name,created_at,updated_at) VALUES (?, ?, 1, 1)').run(owner, 'Test Owner');
  db.prepare('INSERT INTO instance_meta VALUES (1, ?, ?, ?, ?, 1)').run(instanceId, owner, '0.1.0', schemaVersion);
  db.prepare('INSERT INTO instance_origin_settings(singleton,preferred_api_origin,updated_at,updated_by_principal_id) VALUES (1, ?, 1, ?)').run(origin, owner);
  db.prepare('INSERT INTO cfkanban_migration_ledger VALUES (1, ?, ?, ?, ?, ?, 1)').run('0001_initial.sql', 'a'.repeat(64), 'bootstrap', 'ledger_only', randomUUID());
  const version = '1.0.0', bundleRoot = path.join(home, 'service/versions', version, 'bundle');
  const files = { 'dist/index.js': '', 'contracts/openapi.json': '{}', 'migrations/manifest.json': JSON.stringify(manifest), 'release/deployment/migration-readback.sql': '', 'release/version.json': JSON.stringify({ version }), 'wrangler-config-schema.json': '{}', 'wrangler.template.json': '{}' };
  for (const [name, contents] of Object.entries(files)) { const filename = path.join(bundleRoot, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, contents); }
  await mkdir(path.join(bundleRoot, 'apps/web/dist'), { recursive: true });
  const source = `${publisher}/releases/1.0.0/service.zip`;
  await writeFile(path.join(path.dirname(bundleRoot), '.cfkanban-release.json'), JSON.stringify({ schema_version: 1, kind: 'service_deployment_bundle', version, artifact_sha256: 'b'.repeat(64), publisher, source, bundle_path: bundleRoot, bundle_tree_digest: await treeDigest(bundleRoot) }));
  const bindings = [
    { type: 'assets', name: 'ASSETS' }, { type: 'd1', name: 'DB', database_id: databaseId },
    ...[['INSTANCE', '1002'], ['PRINCIPAL', '1001'], ['UNAUTHENTICATED', '1003']].map(([name, id]) => ({ type: 'ratelimit', name: `${name}_RATE_LIMITER`, namespace_id: id })),
    ...[['INSTANCE_LIMIT', '300'], ['INSTANCE_PERIOD_SECONDS', '60'], ['PRINCIPAL_LIMIT', '120'], ['PRINCIPAL_PERIOD_SECONDS', '60'], ['UNAUTHENTICATED_SENSITIVE_LIMIT', '30'], ['UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS', '60']].map(([name, text]) => ({ type: 'plain_text', name: `RATE_LIMIT_${name}`, text })),
    ...(r2 ? [{ type: 'r2_bucket', name: 'ATTACHMENTS', bucket_name: 'test-attachments' }, { type: 'secret_text', name: 'USAGE_ANALYTICS_TOKEN', text: 'never-export-this' }, { type: 'plain_text', name: 'USAGE_ACCOUNT_ID', text: 'isolated-account' }] : []),
  ];
  const f = { db, bindings, owner, versionId, deploymentId, network: [], runnerCalls: [], routes: [], domains: customDomain ? [{ service: 'isolated-worker', environment: 'production', hostname: 'board.invalid' }] : [], domainInfo: null, release: version, ownerValid: true, r2MarkerInstance: instanceId };
  const input = { home, stateRoot: path.join(home, '.cfkanban'), persistenceConfirmed: true, instanceId, accountId: 'isolated-account', workerName: 'isolated-worker', d1Name: 'isolated-db', databaseId, apiOrigin: origin, cloudflareProfile: 'isolated', wranglerExecutable: '/mock/wrangler', environment: {}, taskId: 'attach-test', publisher,
    baselineBundle: { bundleRoot, version, sha256: 'b'.repeat(64), publisher, source },
    runner: async (executable, args) => {
      f.runnerCalls.push(args);
      if (args[0] === 'd1') return { code: 0, stdout: JSON.stringify([{ name: 'isolated-db', uuid: databaseId }]) };
      if (args[0] === 'deployments') return { code: 0, stdout: JSON.stringify({ id: f.deploymentId, versions: [{ version_id: f.versionId, percentage: 100 }], created_on: '2026-09-27T00:00:00Z' }) };
      if (args[0] === 'versions') return { code: 0, stdout: JSON.stringify({ id: f.versionId, resources: { bindings: f.bindings } }) };
      assert.fail('Unexpected Wrangler command');
    },
    tokenRunner: async () => ({ stdout: JSON.stringify({ type: 'oauth', token: 'control-only-secret' }) }),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url); f.network.push({ url: parsed.href, method: options.method });
      if (parsed.origin === 'https://api.cloudflare.com') {
        const suffix = parsed.pathname.replace('/client/v4/accounts/isolated-account', '');
        if (suffix === `/d1/database/${databaseId}/query`) {
          assert.equal(options.method, 'POST');
          const { batch } = JSON.parse(options.body);
          return json({ success: true, result: batch.map(statement => {
            assert.match(statement.sql.trim(), /^SELECT /u); assert.deepEqual(statement.params, []);
            return { success: true, results: db.prepare(statement.sql).all() };
          }) });
        }
        assert.equal(options.method, 'GET');
        const values = {
          '/workers/subdomain': { subdomain: 'isolated' }, '/workers/scripts/isolated-worker/subdomain': { enabled: true },
          '/workers/domains': f.domains, '/workers/services/isolated-worker/environments/production/routes': f.routes,
          '/workers/scripts/isolated-worker/schedules': { schedules: r2 ? [{ cron: '17 * * * *' }] : [] },
          '/r2/buckets/test-attachments': { name: 'test-attachments', storage_class: 'Standard' },
          '/r2/buckets/test-attachments/domains/managed': { enabled: false }, '/r2/buckets/test-attachments/domains/custom': { domains: [] },
          '/r2/buckets/test-attachments/objects/cfkanban-instance.json': { kind: 'cfkanban_attachment_storage', bucket_name: 'test-attachments', account_id: 'isolated-account', instance_id: f.r2MarkerInstance, operation_id: instanceId },
        };
        assert.ok(Object.hasOwn(values, suffix), `Unexpected control endpoint ${suffix}`);
        return json(suffix.includes('/objects/') ? values[suffix] : { success: true, result: values[suffix], ...(suffix === '/workers/domains' && f.domainInfo ? { result_info: f.domainInfo } : {}) });
      }
      assert.equal(parsed.origin, origin);
      const base = { instance_id: instanceId, observed_origin: origin, preferred_api_origin: origin, origin_version: 1, service_version: '0.1.0', release_version: f.release, schema_version: schemaVersion };
      if (parsed.pathname === '/.well-known/cfkanban-instance.json') { const { schema_version, ...discovery } = base; return json({ ...discovery, discovery_version: 1 }); }
      if (parsed.pathname === '/healthz') return json({ ...base, d1: 'reachable' });
      assert.ok(['/api/v1/me', '/api/v1/meta'].includes(parsed.pathname));
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${f.token}`);
      if (parsed.pathname === '/api/v1/me') return json({ id: owner, principal_id: owner, is_owner: f.ownerValid, credential: { id: f.credentialId, fingerprint: f.fingerprint } });
      return json({ ...base, principal: { id: owner, is_owner: f.ownerValid }, capabilities: { attachments: r2 } });
    },
  };
  if (credential) {
    await putInstanceMetadata({ ...input, trustedApiOrigin: origin, publisher });
    const id = randomUUID();
    await createPendingCredential({ ...input, principalId: owner, credentialId: id, operationId: randomUUID(), purpose: 'owner_bootstrap' });
    const pending = await loadPendingCredentialSecret(input);
    await promotePendingCredential({ ...input, principalId: owner, credentialId: id, fingerprint: pending.metadata.fingerprint });
    f.token = pending.token; f.credentialId = id; f.fingerprint = pending.metadata.fingerprint;
  }
  f.input = input;
  f.prepare = async (authorize = true) => {
    const result = await createDeploymentAttachmentPlan(input); f.plan = result.plan;
    f.execution = { ...input, plan: f.plan, operationId: f.plan.operation_id };
    await createJournal(f.execution); if (authorize) await authorizeJournal({ ...f.execution, planDigest: result.plan_digest });
  };
  return f;
}

test('已有Owner安全接入仅写本地登记，历史工件来源始终unknown，可重复读回', async t => {
  const f = await fixture(t); await f.prepare();
  const result = await attachDeployment(f.execution);
  assert.equal(result.kind, 'cfkanban_deployment_attachment_receipt');
  assert.equal(result.service_release.provenance, 'remote_observed'); assert.equal(result.service_release.service_bundle_sha256, null);
  assert.equal(result.service_release.manifest_sha256, null); assert.equal(result.service_release.service_bundle_source, null);
  assert.deepEqual(await attachDeployment(f.execution), result);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  const surfaces = JSON.stringify([result, f.plan, f.runnerCalls, f.network]);
  for (const secret of [f.token, sha256Bytes(f.token), 'control-only-secret']) assert.ok(!surfaces.includes(secret));
});

test('无本地凭据只能inspect且不初始化任何本地身份', async t => {
  const f = await fixture(t, { credential: false });
  assert.equal((await inspectDeploymentAttachment(f.input)).status, 'credential_required');
  await assert.rejects(createDeploymentAttachmentPlan(f.input), { code: 'DEPLOYMENT_ATTACH_OWNER_REQUIRED' });
  await assert.rejects(readFile(getInstancePaths(f.input).currentSecret), { code: 'ENOENT' });
  assert.ok(!f.network.some(call => call.url.includes('/api/v1/')));
});

test('计划未授权或digest被修改时不能落地登记', async t => {
  const f = await fixture(t); await f.prepare(false);
  await assert.rejects(attachDeployment(f.execution), { code: 'PLAN_NOT_AUTHORIZED' });
  await authorizeJournal({ ...f.execution, planDigest: canonicalDigest(f.plan) });
  f.plan.evidence.owner.display_name = 'tampered';
  await assert.rejects(attachDeployment(f.execution), { code: 'PLAN_NOT_AUTHORIZED' });
});

for (const drift of ['worker', 'schema', 'ledger', 'binding', 'owner', 'release', 'origin']) test(`拒绝 ${drift} 漂移`, async t => {
  const f = await fixture(t); await f.prepare();
  if (drift === 'worker') f.versionId = randomUUID();
  if (drift === 'schema') f.db.exec('DROP TABLE credentials');
  if (drift === 'ledger') f.db.exec("UPDATE cfkanban_migration_ledger SET sha256 = 'wrong'");
  if (drift === 'binding') f.bindings.push({ type: 'kv_namespace', name: 'UNKNOWN', value: 'secret' });
  if (drift === 'owner') f.ownerValid = false;
  if (drift === 'release') f.release = '1.1.0';
  if (drift === 'origin') f.input.apiOrigin = 'https://other.invalid';
  await assert.rejects(drift === 'origin' ? inspectDeploymentAttachment(f.input) : attachDeployment(f.execution));
  await assert.rejects(readFile(path.join(getInstancePaths(f.input).receiptsRoot, `${f.plan.operation_id}.attachment.json`)), { code: 'ENOENT' });
});

test('拒绝不明baseline、缺失migration历史与本地bundle被改写', async t => {
  const f = await fixture(t);
  f.db.exec('DELETE FROM cfkanban_migration_ledger');
  await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'DEPLOYMENT_ATTACH_MIGRATIONS_UNSAFE' });
  await writeFile(path.join(f.input.baselineBundle.bundleRoot, 'dist/index.js'), 'changed');
  await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'LOCAL_SERVICE_BUNDLE_MODIFIED' });
});

test('已有R2与usage可核验接入，拒绝其他Instance桶marker与非空routes', async t => {
  const f = await fixture(t, { r2: true });
  const result = await inspectDeploymentAttachment(f.input);
  assert.equal(result.resources.r2.instance_id, f.input.instanceId);
  assert.equal(result.usage_analytics.account_id, 'isolated-account');
  assert.ok(!JSON.stringify(result).includes('never-export-this'));
  f.r2MarkerInstance = randomUUID(); await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'R2_OWNERSHIP_REQUIRED' });
  f.r2MarkerInstance = f.input.instanceId; f.routes.push({ pattern: 'example.invalid/*' });
  await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'DEPLOYMENT_ATTACH_ROUTING_UNSUPPORTED' });
});

test('状态文件权限不安全时不读取凭据也不继续网络请求', async t => {
  if (process.platform === 'win32') return t.skip('POSIX mode fixture');
  const f = await fixture(t); await chmod(getInstancePaths(f.input).instanceMetadata, 0o644);
  await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'STATE_PERMISSION_DRIFT' });
  assert.equal(f.network.length, 0);
});

function upgradeInput(evidence) {
  return { taskId: 'upgrade-attached', instanceId: evidence.target.instanceId,
    cloudflare: { account_id: evidence.target.accountId, profile: evidence.target.cloudflareProfile, api_origin: evidence.target.apiOrigin },
    resources: { ...evidence.resources, workers_dev: true, custom_domain: null, routes: [], pages: false }, bindings: evidence.bindings, owner: evidence.owner,
    current: evidence.service_release,
    target: { publisher: evidence.publisher, manifest_version: '1.1.0', manifest_sha256: 'c'.repeat(64), service_bundle_version: '1.1.0', service_bundle_sha256: 'd'.repeat(64), service_bundle_source: `${evidence.publisher}/releases/1.1.0/service.zip`, service_api_version: '0.1.0', schema_version: 1, migration_manifest_sha256: evidence.migrations.manifest_sha256, compatibility: { node: '>=22', wrangler: '>=4', service_api: '>=0.1.0 <0.2.0', schema_version: 1 } },
    restorePoint: { required: false, verified: false, reason: 'No schema change' } };
}
test('unknown历史来源升级须显式确认并匹配attachment receipt当前Worker和Owner', async t => {
  const f = await fixture(t); await f.prepare(); const receipt = await attachDeployment(f.execution);
  const input = upgradeInput(f.plan.evidence);
  assert.throws(() => createInstanceUpgradePlan(input), { code: 'UNVERIFIED_CURRENT_SOURCE_CONFIRMATION_REQUIRED' });
  const plan = createInstanceUpgradePlan({ ...input, allow_unverified_current_source: true });
  assert.equal(plan.allow_unverified_current_source, true); assert.doesNotThrow(() => assertPriorReceipt(receipt, plan));
  assert.throws(() => assertPriorReceipt({ ...receipt, cloudflare: { ...receipt.cloudflare, worker: { ...receipt.cloudflare.worker, version_id: randomUUID() } } }, plan), { code: 'UPGRADE_PRIOR_RECEIPT_DRIFT' });
  assert.throws(() => createInstanceUpgradePlan({ ...input, allow_unverified_current_source: true, current: { ...input.current, service_bundle_sha256: 'e'.repeat(64) } }), { code: 'INVALID_UPGRADE_RELEASE' });
});


test('接入基线在实际升级发布前重新检查Worker，漂移时不执行部署', async t => {
  const f = await fixture(t); await f.prepare();
  const plan = createInstanceUpgradePlan({ ...upgradeInput(f.plan.evidence), allow_unverified_current_source: true });
  const input = { ...f.input, plan, taskId: plan.task_id, operationId: plan.operation_id };
  await createJournal(input); await authorizeJournal({ ...input, planDigest: canonicalDigest(plan) });
  f.versionId = randomUUID();
  await assert.rejects(executeWranglerAction({ ...input, action: 'deploy_worker_and_static_assets' }), { code: 'UPGRADE_WORKER_DRIFT' });
  assert.ok(!f.runnerCalls.some(args => args[0] === 'deploy'));
});

test('未解决的pending Credential阻止登记，不覆盖现有current', async t => {
  const f = await fixture(t);
  await createPendingCredential({ ...f.input, principalId: f.owner, credentialId: randomUUID(), operationId: randomUUID(), purpose: 'owner_bootstrap' });
  await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'STATE_PENDING_CONFLICT' });
});


test('自定义origin必须有控制面精确映射，分页不完整不能伪装成无域名', async t => {
  const f = await fixture(t, { customDomain: true });
  const evidence = await inspectDeploymentAttachment(f.input);
  assert.deepEqual(evidence.resources.routing.custom_domains, [{ hostname: 'board.invalid', environment: 'production' }]);
  f.domainInfo = { total_pages: 2, total_count: 2 };
  await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'DEPLOYMENT_ATTACH_ROUTING_INCOMPLETE' });
  f.domainInfo = null; f.domains[0].service = 'another-worker';
  await assert.rejects(inspectDeploymentAttachment(f.input), { code: 'DEPLOYMENT_ATTACH_ORIGIN_UNPROVEN' });
});
