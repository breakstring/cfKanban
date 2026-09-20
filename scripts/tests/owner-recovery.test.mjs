import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnerRecoveryPlan, executeOwnerRecovery, inspectOwnerRecovery, buildOwnerRecoveryBatch } from '../../packages/skill-runtime/src/owner-recovery.mjs';
import { serializeError } from '../../packages/skill-runtime/src/errors.mjs';
import { dispatch } from '../../packages/skill-runtime/src/cli.mjs';
import { createJournal, authorizeJournal } from '../../packages/skill-runtime/src/journal.mjs';
import { createPendingCredential, getInstancePaths, loadPendingCredentialSecret, loadCurrentCredentialSecret, initializeStateRoot } from '../../packages/skill-runtime/src/state.mjs';

// 全部控制面、公开端点和认证请求均由本地 SQLite fixture 接管，绝不访问真实网络或用户凭据。
const hash = value => createHash('sha256').update(value).digest('hex');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cfkanban-owner-recovery-'));
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  t.after(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  const instanceId = randomUUID(), owner = randomUUID(), databaseId = randomUUID(), versionId = randomUUID();
  const origin = 'https://recovery.invalid';
  db.prepare('INSERT INTO principals(id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)').run(owner, 'Original Owner');
  db.prepare('INSERT INTO instance_meta VALUES (1, ?, ?, ?, 1, 1)').run(instanceId, owner, '1.0.0');
  db.prepare('INSERT INTO instance_origin_settings(singleton, preferred_api_origin, updated_at, updated_by_principal_id) VALUES (1, ?, 1, ?)').run(origin, owner);
  const addCredential = () => { const id = randomUUID(); db.prepare('INSERT INTO credentials(id, principal_id, token_prefix, token_digest, issued_at, created_operation_id) VALUES (?, ?, ?, ?, 1, ?)').run(id, owner, 'old', hash(id), randomUUID()); return id; };
  const old = [addCredential(), addCredential()];
  db.prepare("INSERT INTO web_authenticators(id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,created_operation_id) VALUES(?,?,?,'key',-7,'user',0,0,'recovery.invalid',1,?)").run(randomUUID(), owner, randomUUID(), randomUUID());
  db.prepare("INSERT INTO workspaces(id,key,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?,'sample','Business data',1,1,?,?,?)").run(randomUUID(), owner, owner, randomUUID());
  const f = { db, owner, old, addCredential, argv: [], writes: 0, loseResponse: false, rejectAuth: false, beforeWrite: null, failStatement: false, bindingId: databaseId };
  const input = {
    home, stateRoot: path.join(home, '.cfkanban'), persistenceConfirmed: true, instanceId,
    accountId: 'isolated-account', databaseId, workerName: 'isolated-worker', d1Name: 'isolated-db',
    apiOrigin: origin, wranglerExecutable: '/mock/wrangler', cloudflareProfile: 'isolated', environment: {}, taskId: 'isolated-test',
    runner: async (executable, args) => {
      f.argv.push([executable, ...args]);
      let value;
      if (args[0] === 'd1') value = [{ name: 'isolated-db', uuid: databaseId }];
      else if (args[0] === 'deployments') value = { id: randomUUID(), versions: [{ version_id: versionId, percentage: 100 }], created_on: '2026-09-20T00:00:00Z' };
      else if (args[0] === 'versions') value = { id: versionId, resources: { bindings: [{ type: 'd1', name: 'DB', database_id: f.bindingId }] } };
      else assert.fail('Unexpected mock Wrangler command');
      return { code: 0, stdout: JSON.stringify(value), stderr: '' };
    },
    tokenRunner: async (executable, args) => { f.argv.push([executable, ...args]); return { stdout: JSON.stringify({ type: 'oauth', token: 'mock-control-secret' }) }; },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.origin === 'https://api.cloudflare.com') {
        assert.equal(parsed.pathname, `/client/v4/accounts/isolated-account/d1/database/${databaseId}/query`);
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer mock-control-secret');
        const { batch } = JSON.parse(options.body);
        const writing = batch.length > 1;
        if (writing) { f.writes++; f.beforeWrite?.(); }
        const result = [];
        db.exec('BEGIN');
        try {
          for (const [index, statement] of batch.entries()) {
            if (writing && f.failStatement && index === 2) throw new Error('injected transaction failure');
            const prepared = db.prepare(statement.sql);
            const params = Object.fromEntries(statement.params.map((value, i) => [String(i + 1), value]));
            result.push({ success: true, results: prepared.all(params) });
          }
          db.exec('COMMIT');
        } catch { db.exec('ROLLBACK'); return json({ success: false, errors: [{ code: 999 }] }, 400); }
        if (writing && f.loseResponse) { f.loseResponse = false; throw new Error('lost response'); }
        return json({ success: true, result });
      }
      assert.equal(parsed.origin, origin);
      const base = { instance_id: instanceId, observed_origin: origin, preferred_api_origin: origin, origin_version: 1, service_version: '1.0.0', schema_version: 1 };
      if (parsed.pathname === '/.well-known/cfkanban-instance.json') return json({ ...base, discovery_version: 1 });
      if (parsed.pathname === '/healthz') return json({ ...base, d1: 'reachable' });
      assert.ok(['/api/v1/meta', '/api/v1/me'].includes(parsed.pathname));
      const token = new Headers(options.headers).get('authorization')?.replace(/^Bearer /, '');
      const credential = db.prepare('SELECT * FROM credentials WHERE token_digest = ? AND revoked_at IS NULL').get(hash(token ?? ''));
      if (!credential || f.rejectAuth) return json({}, 401);
      return json(parsed.pathname.endsWith('/meta') ? { ...base, principal: { id: owner, is_owner: true } } : { id: owner, principal_id: owner, is_owner: true, credential: { id: credential.id, fingerprint: `cfk_v1_${credential.token_prefix}_…` } });
    },
  };
  f.input = input;
  f.prepare = async (authorize = true) => {
    const { plan, plan_digest } = await createOwnerRecoveryPlan(input);
    f.plan = plan;
    f.execution = { ...input, plan, operationId: plan.operation_id };
    await initializeStateRoot(input);
    await createJournal(f.execution);
    if (authorize) await authorizeJournal({ ...f.execution, planDigest: plan_digest });
    return plan;
  };
  f.execute = () => executeOwnerRecovery(f.execution);
  f.count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return f;
}

test('恢复同一 Owner、撤销全部旧 API 凭据并保留 Passkey 和业务数据；输出与 argv 不含秘密', async t => {
  const f = await fixture(t); await f.prepare();
  const output = await f.execute();
  assert.equal(output.owner_principal_id, f.owner);
  assert.equal(f.count('principals'), 1);
  assert.equal(f.count('workspaces'), 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM web_authenticators WHERE revoked_at IS NULL').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM credentials WHERE revoked_at IS NOT NULL').get().n, 2);
  assert.equal(f.count('events'), 1);
  const credential = await loadCurrentCredentialSecret(f.input);
  for (const surface of [JSON.stringify(output), JSON.stringify(f.argv)]) {
    assert.ok(!surface.includes(credential.token)); assert.ok(!surface.includes(credential.metadata.token_digest)); assert.ok(!surface.includes('mock-control-secret'));
  }
  assert.equal(buildOwnerRecoveryBatch(f.plan, credential.metadata, 123).length, 4);
});

test('未授权 journal 不创建凭据、不写云端', async t => {
  const f = await fixture(t); await f.prepare(false);
  await assert.rejects(f.execute(), { code: 'PLAN_NOT_AUTHORIZED' }); assert.equal(f.writes, 0);
});

test('篡改 plan 后原授权失效', async t => {
  const f = await fixture(t); await f.prepare(); f.plan.observed.display_name = 'tampered';
  await assert.rejects(f.execute(), { code: 'PLAN_NOT_AUTHORIZED' }); assert.equal(f.writes, 0);
});

test('恢复计划展示并绑定准确的本地秘密保存路径', async t => {
  const f = await fixture(t); await f.prepare();
  const paths = getInstancePaths(f.input);
  assert.equal(f.plan.credential_storage.pending_secret, paths.pendingSecret);
  assert.equal(f.plan.credential_storage.current_secret, paths.currentSecret);
  f.execution.stateRoot = path.join(f.input.home, 'another-private-root');
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_PLAN_INVALID' });
  assert.equal(f.writes, 0);
});

for (const field of ['instance', 'owner', 'origin', 'binding']) test(`拒绝 ${field} 漂移`, async t => {
  const f = await fixture(t); await f.prepare();
  if (field === 'instance') f.db.prepare('UPDATE instance_meta SET instance_id = ?').run(randomUUID());
  if (field === 'owner') { const id = randomUUID(); f.db.prepare("INSERT INTO principals(id,display_name,created_at,updated_at) VALUES(?,'Other',1,1)").run(id); f.db.prepare('UPDATE instance_meta SET owner_principal_id = ?').run(id); }
  if (field === 'origin') f.db.exec("UPDATE instance_origin_settings SET preferred_api_origin = 'https://other.invalid'");
  if (field === 'binding') f.bindingId = randomUUID();
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_DRIFT' }); assert.equal(f.writes, 0);
});

test('事务后段失败会回滚新凭据与旧凭据撤销', async t => {
  const f = await fixture(t); await f.prepare(); f.failStatement = true;
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_CONTROL_FAILED' });
  assert.equal(f.count('credentials'), 2); assert.equal(f.count('events'), 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM credentials WHERE revoked_at IS NULL').get().n, 2);
});

test('响应丢失后复用原 secret 和 operation，读回提交而不重复审计', async t => {
  const f = await fixture(t); await f.prepare(); f.loseResponse = true;
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_CONTROL_UNAVAILABLE' });
  const pending = await loadPendingCredentialSecret(f.input);
  await f.execute();
  assert.equal((await loadCurrentCredentialSecret(f.input)).token, pending.token);
  assert.equal(f.writes, 1); assert.equal(f.count('events'), 1);
});

test('云端成功但认证最终化失败后能够继续同一恢复', async t => {
  const f = await fixture(t); await f.prepare(); f.rejectAuth = true;
  await assert.rejects(f.execute(), { code: 'DEPLOYMENT_READBACK_FAILED' });
  f.rejectAuth = false; await f.execute(); assert.equal(f.writes, 1);
});

test('已 promote 但 receipt 写入失败后能够恢复', async t => {
  const f = await fixture(t); await f.prepare();
  const paths = getInstancePaths(f.input);
  const obstacle = path.join(paths.receiptsRoot, `${f.plan.operation_id}.owner-recovery.json`);
  await mkdir(obstacle, { recursive: true, mode: 0o700 });
  await assert.rejects(f.execute());
  const current = await loadCurrentCredentialSecret(f.input);
  await rm(obstacle, { recursive: true }); await f.execute();
  assert.equal((await loadCurrentCredentialSecret(f.input)).token, current.token); assert.equal(f.writes, 1);
});

test('preflight 之后并发签发使原子 guard 拒绝，不撤销新凭据', async t => {
  const f = await fixture(t); await f.prepare(); f.beforeWrite = f.addCredential;
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_NOT_COMMITTED' });
  assert.equal(f.count('credentials'), 3); assert.equal(f.count('events'), 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM credentials WHERE revoked_at IS NULL').get().n, 3);
});

test('部分提交证据必须停止并保留 pending secret', async t => {
  const f = await fixture(t); await f.prepare(); f.loseResponse = true;
  await assert.rejects(f.execute());
  f.db.prepare('DELETE FROM operation_commits WHERE operation_id = ?').run(f.plan.operation_id);
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_PARTIAL_OR_CONFLICT' });
  assert.ok((await loadPendingCredentialSecret(f.input)).token); assert.equal(f.writes, 1);
});

test('只读 inspect 不生成凭据或修改 D1', async t => {
  const f = await fixture(t); const evidence = await inspectOwnerRecovery(f.input);
  assert.equal(evidence.observed.owner_principal_id, f.owner); assert.equal(f.writes, 0); assert.equal(f.count('credentials'), 2);
});

test('提升后 pending secret 已删而 metadata 残留时复用 current 并完成清理', async t => {
  const f = await fixture(t); await f.prepare(); await f.execute();
  const paths = getInstancePaths(f.input);
  const current = await loadCurrentCredentialSecret(f.input);
  await writeFile(paths.pendingMetadata, JSON.stringify({ ...current.metadata, state: 'pending' }), { mode: 0o600 });
  await f.execute();
  assert.equal((await loadCurrentCredentialSecret(f.input)).token, current.token);
  await assert.rejects(access(paths.pendingMetadata), { code: 'ENOENT' });
  assert.equal(f.writes, 1); assert.equal(f.count('events'), 1);
});

test('旧 current metadata 尚在但 secret 已丢失时可以恢复同一 Owner', async t => {
  const f = await fixture(t); await f.prepare(); await f.execute();
  const previous = await loadCurrentCredentialSecret(f.input);
  await rm(getInstancePaths(f.input).currentSecret);
  await f.prepare(); await f.execute();
  const current = await loadCurrentCredentialSecret(f.input);
  assert.equal(current.metadata.principal_id, f.owner);
  assert.notEqual(current.token, previous.token);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM credentials WHERE revoked_at IS NULL').get().n, 1);
});

test('仍有 current secret 时拒绝新全失恢复，保留原凭据', async t => {
  const f = await fixture(t); await f.prepare(); await f.execute();
  const current = await loadCurrentCredentialSecret(f.input);
  await f.prepare();
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_CURRENT_EXISTS' });
  assert.equal((await loadCurrentCredentialSecret(f.input)).token, current.token);
  assert.equal(f.writes, 1);
});

test('另一个 pending operation 阻止恢复且不覆盖秘密', async t => {
  const f = await fixture(t); await f.prepare();
  await createPendingCredential({ ...f.input, principalId: f.owner, operationId: randomUUID() });
  const pending = await loadPendingCredentialSecret(f.input);
  await assert.rejects(f.execute(), { code: 'STATE_PENDING_CONFLICT' });
  assert.equal((await loadPendingCredentialSecret(f.input)).token, pending.token);
  assert.equal(f.writes, 0);
});

test('权限扩大后的 pending metadata 在控制面写入前被拒绝', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.prepare(); f.failStatement = true;
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_CONTROL_FAILED' });
  await chmod(getInstancePaths(f.input).pendingMetadata, 0o644);
  f.failStatement = false;
  await assert.rejects(f.execute(), { code: 'STATE_PERMISSION_DRIFT' });
  assert.equal(f.writes, 1); assert.equal(f.count('credentials'), 2);
});

test('pending metadata 符号链接被拒绝且不触碰链接目标', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.prepare(); f.failStatement = true;
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_CONTROL_FAILED' });
  const paths = getInstancePaths(f.input);
  const original = await readFile(paths.pendingMetadata, 'utf8');
  const target = path.join(f.input.home, 'outside-metadata.json');
  await writeFile(target, original, { mode: 0o600 });
  await rm(paths.pendingMetadata); await symlink(target, paths.pendingMetadata);
  await assert.rejects(f.execute(), { code: 'STATE_SYMLINK_REJECTED' });
  assert.equal(await readFile(target, 'utf8'), original); assert.equal(f.writes, 1);
});

test('原子回滚后沿用同一 secret 重试成功，不产生重复审计', async t => {
  const f = await fixture(t); await f.prepare(); f.failStatement = true;
  await assert.rejects(f.execute(), { code: 'OWNER_RECOVERY_CONTROL_FAILED' });
  const pending = await loadPendingCredentialSecret(f.input);
  f.failStatement = false; await f.execute();
  assert.equal((await loadCurrentCredentialSecret(f.input)).token, pending.token);
  assert.equal(f.count('credentials'), 3); assert.equal(f.count('events'), 1); assert.equal(f.writes, 2);
});

test('deploy 命令面从完整本地状态丢失走到可用 current Credential', async t => {
  const f = await fixture(t); const surface = { surface: 'deploy' };
  await assert.rejects(access(f.input.stateRoot), { code: 'ENOENT' });
  await dispatch('owner-recovery inspect', f.input, surface);
  const { plan, plan_digest } = await dispatch('plan owner-recovery', f.input, surface);
  await assert.rejects(access(f.input.stateRoot), { code: 'ENOENT' });
  const input = { ...f.input, plan, operationId: plan.operation_id };
  await dispatch('journal create', input, surface);
  await dispatch('journal authorize', { ...input, planDigest: plan_digest }, surface);
  const output = await dispatch('owner-recovery execute', input, surface);
  assert.equal(output.state, 'current');
  const credential = await loadCurrentCredentialSecret(f.input);
  assert.equal(f.db.prepare('SELECT principal_id FROM credentials WHERE token_digest = ? AND revoked_at IS NULL').get(hash(credential.token)).principal_id, f.owner);
  assert.ok(f.argv.every(([, command]) => ['d1', 'versions', 'deployments', 'auth'].includes(command)));
});

test('全部 migration 至 schema 7 后恢复兼容且保留业务数据', async t => {
  const f = await fixture(t);
  for (const name of ['0002_container_purge', '0003_container_uuid', '0004_issue_attachments', '0005_attachment_schema_version', '0006_usage_statistics', '0007_attachment_settings']) {
    f.db.exec(await readFile(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  const fetch = f.input.fetchImpl;
  f.input.fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (new URL(url).origin !== f.input.apiOrigin) return response;
    const body = await response.json();
    if ('schema_version' in body) body.schema_version = 7;
    return json(body, response.status);
  };
  await f.prepare(); await f.execute();
  assert.equal(f.plan.observed.schema_version, 7);
  assert.equal(f.count('workspaces'), 1); assert.equal(f.count('web_authenticators'), 1);
});

for (const failure of ['response', 'exception']) test(`Cloudflare ${failure} 回显秘密时序列化错误不泄露凭据或 SQL 参数`, async t => {
  const f = await fixture(t); await f.prepare();
  const fetch = f.execution.fetchImpl;
  f.execution.fetchImpl = async (url, options) => {
    if (new URL(url).origin === 'https://api.cloudflare.com' && JSON.parse(options.body).batch.length > 1) {
      const pending = await loadPendingCredentialSecret(f.input);
      const sensitive = `${pending.token} mock-control-secret ${options.body}`;
      if (failure === 'exception') throw new Error(sensitive);
      return json({ success: false, errors: [{ code: 999, message: sensitive }], echoed: sensitive }, 400);
    }
    return fetch(url, options);
  };
  let caught;
  try { await f.execute(); } catch (error) { caught = error; }
  assert.ok(caught);
  const pending = await loadPendingCredentialSecret(f.input);
  const output = JSON.stringify(serializeError(caught));
  for (const sensitive of [pending.token, pending.metadata.token_digest, 'mock-control-secret', 'INSERT INTO credentials']) assert.ok(!output.includes(sensitive));
  assert.equal(f.count('credentials'), 2); assert.equal(f.count('events'), 0);
});
