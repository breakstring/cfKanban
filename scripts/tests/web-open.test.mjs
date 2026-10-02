import assert from 'node:assert/strict';
import test from 'node:test';
import { openWeb } from '../../packages/skill-runtime/src/web-open.mjs';
import { getCommandCatalog } from '../../packages/skill-runtime/src/cli.mjs';

test('web open defaults to local and preserves exact caller context without online fallback', async () => {
  const input = { directory: '/a project with spaces', instanceId: 'exact-instance', target: { kind: 'issue', identifier: 'CFK-42' }, delivery: 'host_browser', onRelayReady() {} };
  const calls = [];
  const localLauncher = async () => ({ openLocalWorkbench: async options => { calls.push(options); return { ok: true, mode: 'local' }; } });
  const onlineLauncher = () => { throw Error('Must not select online implicitly'); };
  assert.equal((await openWeb(input, { localLauncher, onlineLauncher })).mode, 'local');
  assert.deepEqual(calls, [input]);
  await assert.rejects(openWeb(input, { localLauncher: async () => { throw Error('Missing build'); }, onlineLauncher }), /Missing build/);
});

test('local management and sensitive online-only options reject before launcher starts', async () => {
  const localLauncher = () => { throw Error('Must reject before launcher'); };
  for (const target of [{ kind: 'admin', section: 'overview' }, { kind: 'workspace', workspace_id: 'id' }]) await assert.rejects(openWeb({ directory: '/project', target }, { localLauncher }), e => e.code === 'LOCAL_TARGET_UNSUPPORTED');
  for (const extra of [{ token: 'must-reject' }, { stateRoot: '/other' }, { idempotencyKey: 'key' }, { sensitiveOutputAcknowledgement: 'ack' }]) await assert.rejects(openWeb({ directory: '/project', ...extra }, { localLauncher }), e => e.code === 'INVALID_WEB_OPEN_INPUT');
});

test('explicit online delegates dedicated delivery and requires stable key', async () => {
  const input = { mode: 'online', instanceId: 'exact-instance', target: { kind: 'admin', section: 'overview' }, delivery: 'system_browser', idempotencyKey: 'stable-key' };
  let received;
  await openWeb(input, { localLauncher: () => { throw Error('Must not start local'); }, onlineLauncher: async options => { received = options; return { ok: true }; } });
  assert.equal(received.instanceId, input.instanceId);
  assert.equal(received.target, input.target);
  assert.equal(received.idempotencyKey, input.idempotencyKey);
  await assert.rejects(openWeb({ ...input, idempotencyKey: undefined }), e => e.code === 'INVALID_INPUT');
  for (const surface of ['daily', 'admin']) assert.ok(getCommandCatalog({ surface }).commands.some(c => c.name === 'web open'));
  assert.ok(!getCommandCatalog({ surface: 'deploy' }).commands.some(c => c.name === 'web open'));
});
