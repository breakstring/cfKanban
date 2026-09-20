import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverOwnerRecoveryCandidates } from '../../packages/skill-runtime/src/owner-recovery-discovery.mjs';

const json = (result, status = 200) => new Response(JSON.stringify({ success: status === 200, result }), { status });
function fixture(kinds) {
  const entries = kinds.map((kind, index) => ({ kind, name: `service-${index}`, databaseId: randomUUID(), instanceId: randomUUID(), owner: randomUUID(), version: randomUUID(), origin: `https://service-${index}.invalid` }));
  const calls = [];
  const input = {
    accountId: 'isolated-account', wranglerExecutable: '/mock/wrangler', cloudflareProfile: 'isolated', environment: {},
    tokenRunner: async () => ({ stdout: JSON.stringify({ type: 'oauth', token: 'never-output-secret' }) }),
    runner: async (_, args) => {
      let result;
      if (args[0] === 'd1') result = entries.map(entry => ({ name: `${entry.name}-db`, uuid: entry.databaseId }));
      else {
        const entry = entries.find(entry => entry.name === args[args.indexOf('--name') + 1]); assert.ok(entry);
        if (args[0] === 'deployments') result = { id: randomUUID(), versions: [{ version_id: entry.version, percentage: 100 }], created_on: '2026-09-20T00:00:00Z' };
        else if (args[0] === 'versions') result = { id: entry.version, resources: { bindings: [{ name: 'DB', type: 'd1', database_id: entry.databaseId }] } };
        else assert.fail('unexpected Wrangler command');
      }
      return { code: 0, stdout: JSON.stringify(result), stderr: '' };
    },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url); calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body });
      if (parsed.origin !== 'https://api.cloudflare.com') {
        const entry = entries.find(entry => entry.origin === parsed.origin); assert.ok(entry);
        const body = { instance_id: entry.instanceId, observed_origin: entry.origin, preferred_api_origin: entry.origin, origin_version: 1, service_version: '1.0.0', schema_version: 1 };
        if (parsed.pathname.includes('.well-known')) return new Response(JSON.stringify({ ...body, discovery_version: 1 }), { headers: { 'content-type': 'application/json' } });
        assert.equal(parsed.pathname, '/healthz'); return new Response(JSON.stringify({ ...body, d1: 'reachable' }), { headers: { 'content-type': 'application/json' } });
      }
      const endpoint = parsed.pathname.split('/isolated-account')[1];
      if (endpoint === '/workers/scripts') return json(entries.map(entry => ({ id: entry.name, secret_annotation: 'unrelated-inventory' })));
      const worker = entries.find(entry => endpoint === `/workers/scripts/${entry.name}/settings`);
      if (worker) {
        if (worker.kind === 'denied') return json({ secret: 'hidden-error' }, 403);
        const bindings = worker.kind === 'no-db' ? [] : [{ type: 'd1', name: 'DB', ...(worker.kind === 'database-id-binding' ? { database_id: worker.databaseId } : { id: worker.databaseId }) }];
        if (worker.kind === 'multi-db') bindings.push({ type: 'd1', name: 'OTHER', id: randomUUID() });
        return json({ bindings, secret_configuration: 'hidden-config' });
      }
      const entry = entries.find(entry => endpoint.startsWith(`/d1/database/${entry.databaseId}`)); assert.ok(entry);
      if (!endpoint.endsWith('/query')) return json({ name: `${entry.name}-db`, uuid: entry.databaseId });
      const { batch } = JSON.parse(options.body); assert.equal(batch.length, 1); assert.match(batch[0].sql, /^SELECT /);
      const sql = batch[0].sql;
      let rows;
      if (sql.includes('sqlite_master')) rows = entry.kind === 'foreign-db' ? [] : (entry.kind === 'partial-schema' ? ['instance_meta'] : ['instance_meta', 'principals', 'instance_origin_settings', 'credentials']).map(name => ({ name }));
      else rows = [{ instance_id: entry.kind === 'bad-marker' ? 'wrong' : entry.instanceId, owner_principal_id: entry.owner, display_name: 'Original Owner', service_version: '1.0.0', schema_version: 1, principal_version: 1, origin_version: 1, preferred_api_origin: entry.origin, ...(sql.includes('active_count') ? { active_count: 1, active_ids: JSON.stringify(['11111111-1111-4111-8111-111111111111']) } : {}) }];
      return json([{ success: true, results: rows }]);
    },
  };
  return { input, entries, calls };
}

test('排除非 cfKanban，不按 Worker 名称筛选，候选输出不含凭据与库存', async () => {
  const f = fixture(['no-db', 'foreign-db', 'valid']);
  const result = await discoverOwnerRecoveryCandidates(f.input);
  assert.equal(result.status, 'single_candidate', JSON.stringify(result)); assert.equal(result.excluded_count, 2);
  assert.equal(result.candidates[0].target.workerName, 'service-2');
  assert.equal(result.candidates[0].owner_principal_id, f.entries[2].owner);
  for (const secret of ['never-output-secret', 'unrelated-inventory', 'hidden-config', 'active_credential_ids', '11111111-1111-4111-8111-111111111111', 'service-0']) assert.ok(!JSON.stringify(result).includes(secret));
  const foreignQueries = f.calls.filter(call => call.url.includes(f.entries[1].databaseId) && call.body);
  assert.equal(foreignQueries.length, 1); assert.match(foreignQueries[0].body, /sqlite_master/);
});

test('多个有效实例要求选择', async () => {
  const result = await discoverOwnerRecoveryCandidates(fixture(['valid', 'valid']).input);
  assert.equal(result.status, 'selection_required'); assert.equal(result.candidates.length, 2);
});

test('权限失败、多 D1 和坏 marker 不被误排为无关实例', async () => {
  const result = await discoverOwnerRecoveryCandidates(fixture(['valid', 'denied', 'multi-db', 'bad-marker']).input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.candidates.length, 1); assert.equal(result.excluded_count, 0); assert.equal(result.unresolved.length, 3);
  assert.equal(result.unresolved[0].reason, 'OWNER_RECOVERY_DISCOVERY_CONTROL_FAILED');
  assert.ok(!JSON.stringify(result).includes('hidden-error'));
});

test('显式 Worker 范围不枚举其他资源，无候选与未完成可区分', async () => {
  const f = fixture(['no-db', 'valid']); f.input.workerNames = ['service-0'];
  const result = await discoverOwnerRecoveryCandidates(f.input);
  assert.equal(result.status, 'no_candidates'); assert.equal(f.calls.length, 1);
  assert.equal((await discoverOwnerRecoveryCandidates(fixture(['denied']).input)).status, 'incomplete');
});

test('资源数量和响应体超限均停止，不截断选择', async () => {
  await assert.rejects(discoverOwnerRecoveryCandidates(fixture(Array(101).fill('no-db')).input), { code: 'OWNER_RECOVERY_DISCOVERY_LIMIT' });
  const f = fixture([]); f.input.fetchImpl = async () => json([{ id: 'one', extra: 'x'.repeat(65536) }]);
  await assert.rejects(discoverOwnerRecoveryCandidates(f.input), { code: 'OWNER_RECOVERY_DISCOVERY_CONTROL_READBACK_INVALID' });
});

test('失败或不一致的公开校验不产生有效候选', async () => {
  const f = fixture(['valid']); const original = f.input.fetchImpl;
  f.input.fetchImpl = async (url, options) => String(url).endsWith('/healthz') ? new Response(JSON.stringify({ d1: 'unreachable' })) : original(url, options);
  const result = await discoverOwnerRecoveryCandidates(f.input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.candidates.length, 0); assert.equal(result.excluded_count, 0);
});


test('其他 Worker 的字母大小写与下划线不影响有效实例发现', async () => {
  const f = fixture(['no-db', 'valid']); f.entries[0].name = 'Other_App-2026';
  const result = await discoverOwnerRecoveryCandidates(f.input);
  assert.equal(result.status, 'single_candidate'); assert.equal(result.excluded_count, 1);
  assert.equal(result.candidates[0].target.workerName, 'service-1');
  assert.ok(f.calls.some(call => call.url.endsWith('/Other_App-2026/settings')));
});

test('存在 instance_meta 但缺其他必要表必须报告未确认', async () => {
  const f = fixture(['partial-schema', 'valid']);
  const result = await discoverOwnerRecoveryCandidates(f.input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.excluded_count, 0);
  assert.deepEqual(result.unresolved, [{ worker_name: 'service-0', reason: 'OWNER_RECOVERY_DISCOVERY_INCOMPLETE_SCHEMA' }]);
  const partialQueries = f.calls.filter(call => call.url.includes(f.entries[0].databaseId) && call.body);
  assert.equal(partialQueries.length, 1); assert.match(partialQueries[0].body, /sqlite_master/);
});

test('发现前验证 contextDirectory 私有权限和路径，不读取无效路径下的认证', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cfkanban-discovery-')));
  const linked = `${root}-link`;
  t.after(async () => { await rm(linked, { force: true }); await rm(root, { recursive: true, force: true }); });
  const f = fixture(['no-db']); delete f.input.cloudflareProfile; f.input.contextDirectory = root;
  let tokenCalls = 0; const tokenRunner = f.input.tokenRunner;
  f.input.tokenRunner = async (...args) => { tokenCalls++; return tokenRunner(...args); };
  await chmod(root, 0o755);
  await assert.rejects(discoverOwnerRecoveryCandidates(f.input), { code: 'STATE_PERMISSION_DRIFT' });
  assert.equal(tokenCalls, 0); assert.equal(f.calls.length, 0);
  await chmod(root, 0o700); await symlink(root, linked); f.input.contextDirectory = linked;
  await assert.rejects(discoverOwnerRecoveryCandidates(f.input), { code: 'STATE_SYMLINK_REJECTED' });
  assert.equal(tokenCalls, 0); assert.equal(f.calls.length, 0);
  f.input.contextDirectory = root;
  assert.equal((await discoverOwnerRecoveryCandidates(f.input)).status, 'no_candidates');
  assert.ok(tokenCalls > 0);
});

test('settings 的 D1 id 和 database_id 两种返回格式都能完成核验', async () => {
  const result = await discoverOwnerRecoveryCandidates(fixture(['valid', 'database-id-binding']).input);
  assert.equal(result.status, 'selection_required'); assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.unresolved, []);
});
