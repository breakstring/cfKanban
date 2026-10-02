import { randomUUID } from 'node:crypto';
import { createBrowserLaunchAndDeliver } from '../../skill-runtime/src/capability-delivery.mjs';
import { canonical, identifier, record, uuid } from './workbench/shared.mjs';
import { LocalRuntimeError, failure } from './errors.mjs';

const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'LOCAL_ONLINE_FAILED';
const MAX_RECEIPTS = 128;
const publicResult = value => value?.ok === true
  ? { ok: true, delivery: { channel: 'system_browser', delivered: value.delivery?.delivered === true } }
  : { ok: false, error: { code: safeCode(value?.error?.code) }, ...(value?.outcome_unknown ? { outcome_unknown: true } : {}) };

export function createOnlineOpener({ deliver = createBrowserLaunchAndDeliver, requestTimeoutMs = 15_000 } = {}) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15_000) throw new LocalRuntimeError('LOCAL_INVALID_OPTIONS');
  return async ({ bridge, bindingId, identifier, idempotencyKey, signal }) => {
    try { uuid(idempotencyKey, 'original key'); } catch { return failure('LOCAL_INVALID_INPUT'); }
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs);
    let target;
    try { requestSignal.throwIfAborted(); target = await bridge.verifiedTarget(bindingId, requestSignal, identifier); requestSignal.throwIfAborted(); }
    catch { return failure('LOCAL_ONLINE_TARGET_UNAVAILABLE'); }
    try {
      const result = await deliver({ instanceId: target.instance_id, expectedPrincipalId: target.principal_id, target: identifier ? { kind: 'issue', identifier: target.identifier } : { kind: 'project', workspace_id: target.workspace_id, project_id: target.project_id }, idempotencyKey, delivery: 'system_browser', signal: requestSignal });
      // client_transport 的失败不能证明 POST 未提交，不能只依赖 HTTP status。
      const unknown = result.status === 0 || result.status >= 500 || result.error?.source === 'client_transport' || result.outcome_unknown;
      return { ...publicResult(result), ...(!result.ok && unknown ? { outcome_unknown: true } : {}) };
    } catch (error) { return error?.details?.committed === true ? { ok: true, delivery: { channel: 'system_browser', delivered: false } } : failure('LOCAL_ONLINE_FAILED', true); }
  };
}

function waitForOperation(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export class OnlineBroker {
  #bridge;
  #openOnline;
  #timeoutMs;
  #receipt = null;
  #usedReceiptIds = new Set();
  #running = false;
  #disposed = false;
  #lifetime = new AbortController();
  #listeners = new Set();

  constructor({ bridge, openOnline = createOnlineOpener(), requestTimeoutMs = 45_000 }) {
    if (!bridge || typeof openOnline !== 'function' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) throw new LocalRuntimeError('LOCAL_INVALID_OPTIONS');
    this.#bridge = bridge;
    this.#openOnline = openOnline;
    this.#timeoutMs = requestTimeoutMs;
  }

  snapshot() { return { running: this.#running, pending_target: this.#receipt ? structuredClone(this.#receipt.target) : null, receipt_id: this.#receipt?.id ?? null }; }
  hasPending() { return Boolean(this.#running || this.#receipt); }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #publish() { for (const listener of this.#listeners) { try { listener(this.snapshot()); } catch {} } }
  allows(endpoint, input) {
    if (!this.hasPending()) return true;
    return ['list', 'board', 'assignees', 'detail', 'comments'].includes(endpoint) && input?.binding_id === this.#receipt?.target.binding_id;
  }
  acceptsCheckpoint(checkpoint) { return !this.hasPending() || checkpoint?.state?.binding?.binding_id === this.#receipt?.target.binding_id; }

  async open(value, { signal, receiptId, recover = false } = {}) {
    if (this.#disposed) return failure('LOCAL_SERVICE_CLOSED', this.hasPending());
    if (this.#running) return failure('LOCAL_OPERATION_PENDING');
    let target;
    try {
      record(value, ['binding_id', 'identifier'], ['binding_id']);
      uuid(value.binding_id, 'binding');
      if (value.identifier !== undefined) identifier(value.identifier);
      if (receiptId !== undefined) uuid(receiptId, 'receipt');
      if (typeof recover !== 'boolean') throw new Error();
      target = structuredClone(value);
    } catch { return failure('LOCAL_INVALID_INPUT'); }
    const fingerprint = canonical(target);
    if (recover && (!receiptId || this.#receipt?.id !== receiptId)) return failure('LOCAL_RECOVERY_UNAVAILABLE', true);
    if (this.#receipt && receiptId !== undefined && receiptId !== this.#receipt.id) return failure('LOCAL_PENDING_OPERATION', true);
    if (this.#receipt && this.#receipt.fingerprint !== fingerprint) return failure('LOCAL_PENDING_OPERATION', true);
    if (signal?.aborted) return failure('LOCAL_REQUEST_INTERRUPTED', this.hasPending());
    if (!this.#receipt) { try { this.#bridge.binding?.({ binding_id: target.binding_id }); } catch { return failure('LOCAL_ONLINE_TARGET_UNAVAILABLE'); } }
    if (!this.#receipt && this.#bridge.hasPending?.()) return failure('LOCAL_PENDING_OPERATION');
    const recovering = Boolean(this.#receipt);
    if (!this.#receipt) {
      const id = receiptId ?? randomUUID();
      if (this.#usedReceiptIds.has(id)) return failure('LOCAL_RECEIPT_REUSED');
      if (this.#usedReceiptIds.size >= MAX_RECEIPTS) return failure('LOCAL_RECEIPT_CAPACITY');
      // 不淘汰已用 generation，避免旧请求和迟到 ACK 命中新操作。
      this.#usedReceiptIds.add(id);
      this.#receipt = { target, fingerprint, id, key: randomUUID() };
    }
    const receipt = this.#receipt;
    const requestSignal = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.#timeoutMs)]);
    this.#running = true;
    this.#publish();
    try {
      if (receipt.result) {
        const verificationSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]);
        try { await waitForOperation(this.#bridge.verifiedTarget(receipt.target.binding_id, verificationSignal, receipt.target.identifier), verificationSignal); }
        catch { return failure('LOCAL_ONLINE_TARGET_UNAVAILABLE', true); }
        return structuredClone(receipt.result);
      }
      const operation = Promise.resolve().then(() => this.#openOnline({ bridge: this.#bridge, bindingId: receipt.target.binding_id, identifier: receipt.target.identifier, idempotencyKey: receipt.key, signal: requestSignal }));
      const result = publicResult(await waitForOperation(operation, requestSignal));
      const unresolved = result.outcome_unknown || (recovering && !result.ok);
      if (!unresolved) receipt.result = result;
      return unresolved ? { ...result, outcome_unknown: true } : result;
    } catch { return failure('LOCAL_REQUEST_INTERRUPTED', true); }
    finally { this.#running = false; this.#publish(); }
  }

  acknowledge(value) {
    if (this.#disposed) return failure('LOCAL_SERVICE_CLOSED', this.hasPending());
    let target;
    try { record(value, ['binding_id', 'identifier', 'receipt_id'], ['binding_id', 'receipt_id']); uuid(value.binding_id, 'binding'); uuid(value.receipt_id, 'receipt'); if (value.identifier !== undefined) identifier(value.identifier); target = { binding_id: value.binding_id, ...(value.identifier === undefined ? {} : { identifier: value.identifier }) }; }
    catch { return failure('LOCAL_INVALID_INPUT'); }
    if (!this.#receipt) return { ok: true };
    if (this.#running || !this.#receipt.result || this.#receipt.id !== value.receipt_id || this.#receipt.fingerprint !== canonical(target)) return failure('LOCAL_PENDING_OPERATION', true);
    this.#receipt = null;
    this.#publish();
    return { ok: true };
  }

  dispose() {
    const outcome_unknown = this.hasPending();
    this.#disposed = true;
    this.#lifetime.abort();
    this.#listeners.clear();
    return { outcome_unknown };
  }
}
