import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveStateRoot } from '../../skill-runtime/src/paths.mjs';
import { requireUuid, requireHttpsOrigin } from '../../skill-runtime/src/utils.mjs';

const failure = code => ({ ok: false, error: { code } });
const resetCodes = new Set(['CURSOR_EXPIRED', 'SEARCH_INDEX_RESET', 'SEARCH_INDEX_RESET_REQUIRED', 'SEARCH_CURSOR_EXPIRED', 'INVALID_CURSOR', 'CURSOR_SCOPE_MISMATCH', 'SEARCH_CURSOR_SCOPE_MISMATCH']);

function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('MCP_REQUEST_CANCELLED'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('MCP_REQUEST_CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function identityRecord(value) {
  if (!Number.isSafeInteger(value?.origin_version) || value.origin_version < 1) throw new Error('Invalid search index origin version');
  return {
    instance_id: requireUuid(value?.instance_id, 'instance_id'),
    principal_id: requireUuid(value?.principal_id, 'principal_id'),
    trusted_api_origin: requireHttpsOrigin(value?.trusted_api_origin, 'trusted_api_origin'),
    origin_version: value.origin_version,
  };
}

function sqliteExecArgv(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return (major === 22 && minor < 13) || (major === 23 && minor < 4) ? ['--experimental-sqlite'] : [];
}

class IndexWorker {
  constructor(options) {
    this.sequence = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL('./search-cache-worker.mjs', import.meta.url), {
      workerData: options, execArgv: sqliteExecArgv(), stdout: true, stderr: true,
    });
    // Worker diagnostics must never enter the MCP JSON-RPC stdout stream.
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const readyTimer = setTimeout(() => this.rejectReady(new Error('MCP_SEARCH_INDEX_UNAVAILABLE')), 15_000);
    readyTimer.unref();
    this.ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
    this.worker.on('message', message => {
      if (Object.hasOwn(message, 'ready')) {
        if (message.ready) this.resolveReady(); else this.rejectReady(new Error(message.error ?? 'MCP_SEARCH_INDEX_UNAVAILABLE'));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    const failed = () => {
      this.closed = true;
      this.rejectReady(new Error('MCP_SEARCH_INDEX_UNAVAILABLE'));
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('MCP_SEARCH_INDEX_UNAVAILABLE'));
      }
      this.pending.clear();
    };
    this.worker.on('error', failed);
    this.worker.on('exit', failed);
    this.ready.catch(() => this.worker.terminate());
  }

  async call(command, args = {}, { signal } = {}) {
    await withSignal(this.ready, signal);
    if (this.closed) throw new Error('MCP_SEARCH_INDEX_UNAVAILABLE');
    const id = ++this.sequence;
    return withSignal(new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP_SEARCH_INDEX_UNAVAILABLE'));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, command, ...args });
    }), signal);
  }

  async close() { this.closed = true; await this.worker.terminate(); }
}

export class PersistentSearchIndex {
  constructor({ facade, stateRoot, homeDirectory = os.homedir(), syncIntervalMs = 30_000,
    idleTimeoutMs = 300_000, hintDelayMs = 250, requestTimeoutMs = 15_000, leaseDurationMs = 30_000,
    maxDocuments = 200_000, maxIndexBytes = 100 * 1024 * 1024, syncBudgetMs = 60_000, maxPagesPerCycle = 100, now = Date.now, random = Math.random } = {}) {
    if (!facade) throw new Error('Search index requires the safe MCP facade');
    this.facade = facade;
    this.homeDirectory = homeDirectory;
    this.stateRoot = stateRoot ?? resolveStateRoot({ home: homeDirectory });
    this.syncIntervalMs = syncIntervalMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.hintDelayMs = hintDelayMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.leaseDurationMs = leaseDurationMs;
    this.now = now;
    this.random = random;
    this.maxDocuments = maxDocuments;
    this.maxIndexBytes = maxIndexBytes;
    this.syncBudgetMs = syncBudgetMs;
    this.maxPagesPerCycle = maxPagesPerCycle;
    this.workers = new Map();
    this.indexErrors = new Map();
    this.activity = new Map();
    this.syncs = new Map();
    this.controller = new AbortController();
  }

  async identity(instanceId, signal) {
    const result = await this.facade.inspectSearchIdentity({ instance_id: instanceId }, { signal });
    if (!result.ok) return result;
    const identity = identityRecord(result.data);
    if (identity.instance_id !== instanceId) throw new Error('Invalid search index identity');
    return { ok: true, identity };
  }

  worker(identity) {
    const key = JSON.stringify(identity);
    for (const [oldKey, oldWorker] of this.workers) {
      const old = JSON.parse(oldKey);
      if (oldKey !== key && old.instance_id === identity.instance_id && old.principal_id === identity.principal_id) {
        this.workers.delete(oldKey);
        void oldWorker.close().catch(() => undefined);
      }
    }
    let worker = this.workers.get(key);
    if (worker?.closed) { this.workers.delete(key); worker = null; }
    if (!worker) {
      worker = new IndexWorker({ identity, stateRoot: path.resolve(this.stateRoot), homeDirectory: path.resolve(this.homeDirectory),
        maxDocuments: this.maxDocuments, maxIndexBytes: this.maxIndexBytes });
      this.workers.set(key, worker);
    }
    return worker;
  }

  activityFor(instanceId) {
    let activity = this.activity.get(instanceId);
    if (!activity) {
      activity = { lastActive: this.now(), lastSync: -Infinity, timer: null, failures: 0, hintPending: false, retryAt: 0 };
      this.activity.set(instanceId, activity);
    }
    return activity;
  }

  touch(instanceId) {
    const activity = this.activityFor(instanceId);
    const resumed = this.now() - activity.lastActive >= this.idleTimeoutMs;
    activity.lastActive = this.now();
    if (resumed || activity.lastSync + this.syncIntervalMs <= this.now()) this.schedule(instanceId, 0);
    return activity;
  }

  schedule(instanceId, delay) {
    if (this.disposed) return;
    const activity = this.activity.get(instanceId);
    if (!activity) return;
    const due = Math.max(this.now() + delay, activity.retryAt);
    if (activity.timer && activity.due <= due && activity.due >= activity.retryAt) return;
    clearTimeout(activity.timer);
    activity.due = due;
    activity.timer = setTimeout(() => {
      activity.timer = null;
      if (this.now() - activity.lastActive >= this.idleTimeoutMs) return;
      void this.synchronize({ instance_id: instanceId }).catch(() => undefined);
    }, Math.min(2_147_483_647, Math.max(0, due - this.now())));
    activity.timer.unref();
  }

  start({ instance_id }) { this.hint({ instance_id }); }

  hint({ instance_id }) {
    if (this.disposed) return;
    try { requireUuid(instance_id, 'instance_id'); } catch { return; }
    const activity = this.touch(instance_id);
    activity.hintPending = true;
    this.schedule(instance_id, this.hintDelayMs);
  }

  async search({ instance_id, query }, { signal } = {}) {
    if (this.disposed) return failure('MCP_SEARCH_INDEX_UNAVAILABLE');
    if (signal?.aborted) return failure('MCP_REQUEST_CANCELLED');
    try {
      const current = await withSignal(this.identity(instance_id, signal), signal);
      if (!current.ok) return current;
      const worker = this.worker(current.identity);
      const result = await worker.call('search', { query }, { signal });
      this.touch(instance_id);
      if (signal?.aborted) return failure('MCP_REQUEST_CANCELLED');
      const error = this.indexErrors.get(JSON.stringify(current.identity));
      if (error && (result.warming || error.blockAll)) return failure(error.code);
      return result.warming ? failure('MCP_SEARCH_INDEX_WARMING')
        : { ok: true, data: { items: result.items }, reference_identity: current.identity };
    } catch (error) { return failure(['MCP_SEARCH_INDEX_CAPACITY_EXCEEDED', 'MCP_REQUEST_CANCELLED'].includes(error.message) ? error.message : 'MCP_SEARCH_INDEX_UNAVAILABLE'); }
  }

  async request(method, args, identity) {
    const deadline = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = AbortSignal.any([this.controller.signal, deadline]);
    const result = await this.facade[method](args, { signal });
    if (result.ok && JSON.stringify(identityRecord(result.reference_identity)) !== JSON.stringify(identity)) throw new Error('SEARCH_IDENTITY_CHANGED');
    return result;
  }

  synchronize({ instance_id }) {
    if (this.disposed) return Promise.resolve(false);
    const existing = this.syncs.get(instance_id);
    if (existing) return existing;
    const activity = this.activityFor(instance_id);
    if (this.now() < activity.retryAt) {
      this.schedule(instance_id, 0);
      return Promise.resolve(false);
    }
    clearTimeout(activity.timer);
    activity.timer = null;
    activity.hintPending = false;
    const operation = this.synchronizeInstance(instance_id).finally(() => this.syncs.delete(instance_id));
    this.syncs.set(instance_id, operation);
    return operation;
  }

  async synchronizeInstance(instanceId) {
    let worker, token, identity;
    let success = false;
    const cycleStarted = this.now();
    let pages = 0;
    let paused = false;
    let retryAfterAt = 0;
    const remember = result => {
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(result?.error?.code ?? '') ? result.error.code : 'MCP_SEARCH_INDEX_UNAVAILABLE';
      if (identity) this.indexErrors.set(JSON.stringify(identity), { code, blockAll: code === 'MCP_SEARCH_INDEX_CAPACITY_EXCEEDED' });
      const seconds = result?.error?.retry_after_seconds;
      if (Number.isSafeInteger(seconds) && seconds >= 0) retryAfterAt = Math.max(retryAfterAt, this.now() + Math.min(seconds, Number.MAX_SAFE_INTEGER / 1000) * 1000);
    };
    try {
      const current = await this.identity(instanceId, this.controller.signal);
      if (!current.ok) { remember(current); return false; }
      identity = current.identity;
      worker = this.worker(identity);
      token = await worker.call('acquire', { owner: randomUUID(), now: this.now(), duration: this.leaseDurationMs });
      if (!token) return false;
      const statusResult = await this.request('readSearchStatus', { instance_id: instanceId }, identity);
      if (!statusResult.ok) {
        remember(statusResult);
        if ([401, 403].includes(statusResult.status)) await worker.call('clear', { token, now: this.now() });
        return false;
      }
      const projects = await worker.call('configure', { status: statusResult.data, token, now: this.now() });
      for (const project of projects) {
        if (!project.scope_changed && project.active_cursor && !project.pending_cursor && project.active_revision === project.revision) continue;
        let plan = await worker.call('begin', { project_id: project.id, cursor: project.cursor, token, now: this.now() });
        let reset = false;
        for (let pageNumber = 0; pageNumber < 100_000; pageNumber++) {
          if (this.disposed || (this.activity.has(instanceId) && this.now() - this.activity.get(instanceId).lastActive >= this.idleTimeoutMs)) return false;
          if (pages >= this.maxPagesPerCycle || this.now() - cycleStarted >= this.syncBudgetMs) {
            success = true;
            paused = true;
            return false;
          }
          const method = plan.phase === 'snapshot' ? 'readSearchSnapshot' : 'readSearchChanges';
          const args = { instance_id: instanceId, project_id: project.id, limit: 100,
            ...(plan.phase === 'snapshot' ? { cursor: plan.cursor } : { after: plan.cursor }) };
          const result = await this.request(method, args, identity);
          if (!result.ok) {
            remember(result);
            if ([401, 403].includes(result.status)) await worker.call('clear', { token, now: this.now() });
            if (!reset && resetCodes.has(result.error?.code)) {
              const refreshed = await this.request('readSearchStatus', { instance_id: instanceId }, identity);
              if (!refreshed.ok) { remember(refreshed); return false; }
              await worker.call('configure', { status: refreshed.data, token, now: this.now() });
              const head = refreshed.data.projects.find(item => item.id === project.id);
              if (!head) break;
              plan = await worker.call('begin', { project_id: project.id, cursor: head.cursor, reset: true, token, now: this.now() });
              reset = true;
              continue;
            }
            return false;
          }
          const next = await worker.call('apply', { project_id: project.id, phase: plan.phase, expected_cursor: plan.cursor,
            page: result.data, token, now: this.now() });
          pages++;
          if (next.complete) break;
          if (next.cursor === plan.cursor && next.phase === plan.phase) throw new Error('Search index cursor did not advance');
          plan = next;
          if (pageNumber === 99_999) throw new Error('Search index sync exceeded its page bound');
        }
      }
      success = true;
      this.indexErrors.delete(JSON.stringify(identity));
      return true;
    } catch (error) {
      if (identity && error.message === 'MCP_SEARCH_INDEX_CAPACITY_EXCEEDED') remember({ error: { code: error.message } });
      return false;
    }
    finally {
      if (token) await worker.call('release', { token }).catch(() => undefined);
      const activity = this.activity.get(instanceId);
      if (activity) {
        activity.lastSync = this.now();
        activity.failures = success ? 0 : Math.min(activity.failures + 1, 4);
        const backoff = this.syncIntervalMs * (2 ** activity.failures);
        activity.retryAt = success ? 0 : Math.max(retryAfterAt, this.now() + backoff) + Math.floor(backoff * 0.2 * this.random());
        this.schedule(instanceId, activity.hintPending ? this.hintDelayMs : paused ? Math.min(1000, this.syncIntervalMs) : this.syncIntervalMs);
      }
    }
  }

  async dispose() {
    this.disposed = true;
    this.controller.abort();
    for (const activity of this.activity.values()) clearTimeout(activity.timer);
    await Promise.allSettled([...this.syncs.values()]);
    await Promise.allSettled([...this.workers.values()].map(worker => worker.close()));
    this.workers.clear();
  }
}
