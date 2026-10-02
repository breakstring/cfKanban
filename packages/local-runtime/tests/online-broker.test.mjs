import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { OnlineBroker, createOnlineOpener } from '../src/online-broker.mjs';

const target = () => ({ binding_id: randomUUID(), identifier: 'CFK-548' });
const bridge = () => ({ hasPending: () => false, verifiedTarget: async () => ({}) });

test('broker rejects unknown fields and exposes only cloned non-secret target and receipt metadata', async () => {
  let calls = 0;
  const broker = new OnlineBroker({ bridge: bridge(), openOnline: async () => { calls++; return { ok: false, outcome_unknown: true, sensitive_output: 'never-return', error: { code: 'PLATFORM_UNAVAILABLE', message: 'secret', details: { token: 'secret' } } }; } });
  for (const value of [{ ...target(), url: 'https://evil.invalid' }, { binding_id: 'not-a-uuid' }, { ...target(), identifier: 'https://evil.invalid' }]) assert.equal((await broker.open(value)).error.code, 'LOCAL_INVALID_INPUT');
  assert.equal(calls, 0);
  const input = target();
  const result = await broker.open(input);
  assert.deepEqual(Object.keys(result).sort(), ['error', 'ok', 'outcome_unknown']);
  assert.deepEqual(result.error, { code: 'PLATFORM_UNAVAILABLE' });
  const snapshot = broker.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['pending_target', 'receipt_id', 'running']);
  snapshot.pending_target.binding_id = randomUUID();
  assert.deepEqual(broker.snapshot().pending_target, input);
  assert.equal(JSON.stringify({ snapshot, result }).includes('secret'), false);
  assert.equal((await broker.open(input, { receiptId: ['bad'] })).error.code, 'LOCAL_INVALID_INPUT');
  broker.dispose();
});

test('unknown recovery keeps one private key and known replay performs fresh verification without another launch', async () => {
  const requests = [];
  let verifications = 0;
  const broker = new OnlineBroker({ bridge: { hasPending: () => false, verifiedTarget: async () => { verifications++; } }, openOnline: async input => {
    requests.push(input);
    if (requests.length === 1) return { ok: false, outcome_unknown: true };
    if (requests.length === 2) return { ok: false, error: { code: 'FORBIDDEN' } };
    return { ok: true, delivery: { delivered: true }, launch_url: 'secret' };
  } });
  const input = target();
  const receiptId = randomUUID();
  assert.equal((await broker.open(input, { receiptId })).outcome_unknown, true);
  assert.notEqual(requests[0].idempotencyKey, receiptId);
  assert.equal(broker.acknowledge({ ...input, receipt_id: receiptId }).outcome_unknown, true);
  assert.equal((await broker.open(input, { receiptId, recover: true })).outcome_unknown, true);
  assert.equal((await broker.open(input, { receiptId, recover: true })).ok, true);
  assert.equal(broker.hasPending(), true);
  assert.equal(broker.allows('unbind', input), false);
  assert.equal(broker.allows('detail', input), true);
  assert.equal(broker.allows('detail', { binding_id: randomUUID() }), false);
  assert.equal(broker.acceptsCheckpoint({ state: { binding: { binding_id: input.binding_id } } }), true);
  assert.equal(broker.acceptsCheckpoint({ state: { binding: { binding_id: randomUUID() } } }), false);
  const cached = await broker.open(input, { receiptId, recover: true });
  assert.equal(cached.ok, true);
  assert.equal(verifications, 1);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(request => request.idempotencyKey)).size, 1);
  assert.deepEqual(broker.acknowledge({ ...input, receipt_id: receiptId }), { ok: true });
  assert.equal(broker.hasPending(), false);
  assert.equal((await broker.open(input, { receiptId, recover: true })).error.code, 'LOCAL_RECOVERY_UNAVAILABLE');
  assert.equal(requests.length, 3);
  broker.dispose();
});

test('late acknowledgement and recovery from an older generation cannot clear or replay a newer receipt', async () => {
  let calls = 0;
  const broker = new OnlineBroker({ bridge: bridge(), openOnline: async () => { calls++; return { ok: true, delivery: { delivered: true } }; } });
  const input = target();
  const oldId = randomUUID();
  const nextId = randomUUID();
  await broker.open(input, { receiptId: oldId });
  assert.equal(broker.acknowledge({ ...input, receipt_id: oldId }).ok, true);
  await broker.open(input, { receiptId: nextId });
  assert.equal(broker.acknowledge({ ...input, receipt_id: oldId }).ok, false);
  assert.equal((await broker.open(input, { receiptId: oldId, recover: true })).ok, false);
  assert.equal(broker.snapshot().receipt_id, nextId);
  assert.equal(calls, 2);
  assert.equal(broker.acknowledge({ ...input, receipt_id: nextId }).ok, true);
  broker.dispose();
});

test('known receipt remains recoverable when current identity verification fails without launching again', async () => {
  let allowed = true;
  let calls = 0;
  const broker = new OnlineBroker({ bridge: { hasPending: () => false, verifiedTarget: async () => { if (!allowed) throw new Error('Current Principal changed'); } }, openOnline: async () => { calls++; return { ok: true, delivery: { delivered: false } }; } });
  const input = target();
  const receiptId = randomUUID();
  await broker.open(input, { receiptId });
  allowed = false;
  assert.equal((await broker.open(input, { receiptId, recover: true })).outcome_unknown, true);
  assert.equal(broker.snapshot().receipt_id, receiptId);
  allowed = true;
  assert.equal((await broker.open(input, { receiptId, recover: true })).ok, true);
  assert.equal(calls, 1);
  broker.dispose();
});

test('broker serializes calls, aborts once, ignores late outcomes and disposes without replay', async () => {
  let finish;
  const requests = [];
  const broker = new OnlineBroker({ bridge: bridge(), openOnline: async input => { requests.push(input); return new Promise(resolve => { finish = resolve; }); } });
  const input = target();
  const receiptId = randomUUID();
  const abort = new AbortController();
  const original = broker.open(input, { receiptId, signal: abort.signal });
  await Promise.resolve();
  assert.equal((await broker.open(input, { receiptId, recover: true })).error.code, 'LOCAL_OPERATION_PENDING');
  abort.abort();
  assert.equal((await original).outcome_unknown, true);
  assert.equal(requests[0].signal.aborted, true);
  finish({ ok: true, delivery: { delivered: true } });
  await Promise.resolve();
  assert.equal(broker.acknowledge({ ...input, receipt_id: receiptId }).ok, false);
  assert.equal(broker.snapshot().receipt_id, receiptId);
  assert.deepEqual(broker.dispose(), { outcome_unknown: true });
  assert.equal((await broker.open(input, { receiptId, recover: true })).error.code, 'LOCAL_SERVICE_CLOSED');
  assert.equal(requests.length, 1);
});

test('separate view brokers do not share keys or receipt generations and cannot open during an atomic write', async () => {
  const requests = [];
  const create = () => new OnlineBroker({ bridge: bridge(), openOnline: async input => { requests.push(input); return { ok: false, outcome_unknown: true }; } });
  const a = create();
  const b = create();
  const input = target();
  await a.open(input); await b.open(input);
  assert.notEqual(a.snapshot().receipt_id, b.snapshot().receipt_id);
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
  const writing = new OnlineBroker({ bridge: { hasPending: () => true }, openOnline: async () => { throw new Error('Must not execute'); } });
  assert.equal((await writing.open(input)).error.code, 'LOCAL_PENDING_OPERATION');
  assert.equal(writing.hasPending(), false);
  a.dispose(); b.dispose(); writing.dispose();
});

test('shared real online opener binds the current Principal and exact verified target inside the broker', async () => {
  const data = { instance_id: randomUUID(), principal_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), identifier: 'CFK-548' };
  let delivered;
  const input = target();
  const opener = createOnlineOpener({ deliver: async args => { delivered = args; return { ok: true, delivery: { delivered: true }, sensitive_output: 'must-not-return' }; } });
  const broker = new OnlineBroker({ bridge: { hasPending: () => false, verifiedTarget: async (binding, signal, identifier) => { assert.equal(binding, input.binding_id); assert.equal(identifier, input.identifier); assert.equal(signal.aborted, false); return data; } }, openOnline: opener });
  const result = await broker.open(input);
  assert.equal(delivered.expectedPrincipalId, data.principal_id);
  assert.deepEqual(delivered.target, { kind: 'issue', identifier: data.identifier });
  assert.deepEqual(result, { ok: true, delivery: { channel: 'system_browser', delivered: true } });
  assert.equal(delivered.signal.aborted, false);
  broker.dispose();
});

test('creating an online receipt cannot make a previously expired binding appear pending and renew its lease', async () => {
  let calls = 0;
  const broker = new OnlineBroker({ bridge: { hasPending: () => false, binding: () => { throw new Error('Binding expired'); } }, openOnline: async () => { calls++; return { ok: true }; } });
  assert.equal((await broker.open(target())).error.code, 'LOCAL_ONLINE_TARGET_UNAVAILABLE');
  assert.equal(broker.hasPending(), false);
  assert.equal(calls, 0);
  broker.dispose();
});

test('acknowledged generations cannot be reused and the bounded generation history never evicts them', async () => {
  let calls = 0;
  const broker = new OnlineBroker({ bridge: bridge(), openOnline: async () => { calls++; return { ok: true }; } });
  const input = target();
  const oldId = randomUUID();
  await broker.open(input, { receiptId: oldId });
  assert.equal(broker.acknowledge({ ...input, receipt_id: oldId }).ok, true);
  assert.equal((await broker.open(input, { receiptId: oldId })).error.code, 'LOCAL_RECEIPT_REUSED');
  assert.equal(broker.hasPending(), false);
  assert.equal(calls, 1);
  const nextId = randomUUID();
  await broker.open(input, { receiptId: nextId });
  assert.equal((await broker.open(input, { receiptId: oldId })).ok, false);
  assert.equal(broker.acknowledge({ ...input, receipt_id: oldId }).ok, false);
  assert.equal(broker.snapshot().receipt_id, nextId);
  assert.equal(calls, 2);
  assert.equal(broker.acknowledge({ ...input, receipt_id: nextId }).ok, true);
  for (let i = 2; i < 128; i++) {
    const id = randomUUID();
    assert.equal((await broker.open(input, { receiptId: id })).ok, true);
    assert.equal(broker.acknowledge({ ...input, receipt_id: id }).ok, true);
  }
  assert.equal((await broker.open(input, { receiptId: oldId })).error.code, 'LOCAL_RECEIPT_REUSED');
  assert.equal((await broker.open(input, { receiptId: randomUUID() })).error.code, 'LOCAL_RECEIPT_CAPACITY');
  assert.equal(broker.hasPending(), false);
  assert.equal(calls, 128);
  broker.dispose();
});
