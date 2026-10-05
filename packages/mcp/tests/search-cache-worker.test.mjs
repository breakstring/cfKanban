import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

async function fixture(t) {
  const homeDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cfkanban-search-worker-')));
  const stateRoot = path.join(homeDirectory, '.cfkanban');
  const identity = { instance_id: randomUUID(), principal_id: randomUUID(), trusted_api_origin: 'https://search.example.test', origin_version: 1 };
  const project = { id: randomUUID(), display_name: 'Plugin', workspace: { id: randomUUID(), display_name: 'Development' }, revision: 0, cursor: 'snapshot:0' };
  const document = { id: randomUUID(), project_id: project.id, number: 600, title: '安全的标题', revision: 0 };
  const workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); await rm(homeDirectory, { recursive: true, force: true }); });
  async function connect() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    const worker = new Worker(new URL('../src/search-cache-worker.mjs', import.meta.url), {
      workerData: { identity, homeDirectory, stateRoot }, stdout: true, stderr: true,
      execArgv: (major === 22 && minor < 13) || (major === 23 && minor < 4) ? ['--experimental-sqlite'] : [],
    });
    workers.push(worker);
    worker.stdout.resume(); worker.stderr.resume();
    let id = 0;
    const pending = new Map();
    const ready = new Promise((resolve, reject) => {
      worker.on('message', message => {
        if (Object.hasOwn(message, 'ready')) { if (message.ready) resolve(); else reject(new Error('Worker unavailable')); return; }
        const operation = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) operation.reject(new Error(message.error)); else operation.resolve(message.result);
      });
      worker.on('error', reject);
    });
    await ready;
    return (command, args = {}) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject }); worker.postMessage({ id, command, ...args });
    });
  }
  const connectConfigured = async () => {
    const call = await connect();
    const token = await call('acquire', { owner: randomUUID(), now: 1000, duration: 1000 });
    await call('configure', { token, now: 1001, status: { projection_version: 1, epoch: 'epoch', scope_key: 'scope', projects: [project] } });
    await call('begin', { token, now: 1002, project_id: project.id, cursor: project.cursor });
    return { call, token };
  };
  return { connect, connectConfigured, project, document };
}

test('page mutation and cursor commit roll back together, and repeated pages fail CAS', async t => {
  const f = await fixture(t);
  const { call, token } = await f.connectConfigured();
  const args = { token, now: 1003, project_id: f.project.id, phase: 'snapshot', expected_cursor: 'snapshot:0' };
  await assert.rejects(call('apply', { ...args, page: { items: [{ ...f.document, title: '不能半写入', revision: 5 }, { ...f.document, id: randomUUID(), number: -1 }], has_more: false, next_cursor: 'delta:1' } }));
  assert.equal((await call('search', { query: { kind: 'title', text: '写入' } })).warming, true);
  await call('apply', { ...args, page: { items: [f.document], has_more: false, next_cursor: 'delta:1' } });
  await assert.rejects(call('apply', { ...args, page: { items: [], has_more: false, next_cursor: 'delta:2' } }), /SEARCH_CURSOR_CONFLICT/);
  assert.equal((await call('search', { query: { kind: 'title', text: '标题' } })).warming, true);
  await call('apply', { token, now: 1004, project_id: f.project.id, phase: 'changes', expected_cursor: 'delta:1', page: { items: [], has_more: false, next_cursor: 'delta:2', revision: 0 } });
  const result = await call('search', { query: { kind: 'identifier', identifier: 'CFK-600' } });
  assert.equal(result.items[0].title, f.document.title);
});

test('expired lease fencing blocks a delayed writer after a new owner resumes its committed cursor', async t => {
  const f = await fixture(t);
  const { call: old, token: oldToken } = await f.connectConfigured();
  const current = await f.connect();
  const token = await current('acquire', { owner: randomUUID(), now: 3000, duration: 1000 });
  assert.ok(token.fence > oldToken.fence);
  await assert.rejects(old('apply', { token: oldToken, now: 3001, project_id: f.project.id, phase: 'snapshot', expected_cursor: 'snapshot:0', page: { items: [{ ...f.document, title: '过期写入' }], has_more: false, next_cursor: 'delta:bad' } }), /SEARCH_LEASE_LOST/);
  await old('release', { token: oldToken });
  await current('configure', { token, now: 3002, status: { projection_version: 1, epoch: 'epoch', scope_key: 'scope', projects: [f.project] } });
  const plan = await current('begin', { token, now: 3003, project_id: f.project.id, cursor: 'unused-new-head' });
  assert.equal(plan.cursor, 'snapshot:0');
  await current('apply', { token, now: 3004, project_id: f.project.id, phase: 'snapshot', expected_cursor: plan.cursor, page: { items: [f.document], has_more: false, next_cursor: 'delta:1' } });
  await current('apply', { token, now: 3005, project_id: f.project.id, phase: 'changes', expected_cursor: 'delta:1', page: { items: [], has_more: false, next_cursor: 'delta:2', revision: 0 } });
  assert.equal((await current('search', { query: { kind: 'identifier', identifier: 'CFK-600' } })).items[0].title, f.document.title);
});
