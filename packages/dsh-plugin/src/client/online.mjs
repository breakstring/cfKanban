import { record, uuid, identifier, canonical } from '../shared/panel.mjs';

function target(value) {
  record(value, ['binding_id', 'identifier'], ['binding_id']);
  uuid(value.binding_id, 'binding_id');
  if (value.identifier !== undefined) identifier(value.identifier);
  return structuredClone(value);
}

export class OnlinePanelController {
  constructor(controller, makeReceiptId = () => crypto.randomUUID()) {
    this.controller = controller;
    this.listeners = new Set();
    this.state = { ready: false, active: false, running: false, pending_target: null, receipt_id: null, phase: null, error: null };
    this.knownResult = null;
    this.retained = null;
    this.makeReceiptId = makeReceiptId;
    this.unsubscribe = controller.subscribeOnline(value => this.hostState(value));
    this.onAbort = () => this.dispose();
    controller.signal.addEventListener('abort', this.onAbort, { once: true });
  }
  getSnapshot = () => this.state;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  get blocked() { return this.controller.signal.aborted || !this.state.ready || this.state.active || this.state.running || Boolean(this.state.pending_target); }
  patch(value) {
    if (this.controller.signal.aborted) return;
    this.state = { ...this.state, ...value };
    this.listeners.forEach(listener => listener());
  }
  hostState(value) {
    try {
      record(value, ['running', 'pending_target', 'receipt_id'], ['running', 'pending_target', 'receipt_id']);
      if (typeof value.running !== 'boolean') throw new Error();
      const pending_target = value.pending_target === null ? null : target(value.pending_target);
      if (pending_target) uuid(value.receipt_id, 'receipt_id');
      else if (value.receipt_id !== null) throw new Error();
      if (this.retained && (this.retained.receipt_id !== value.receipt_id || canonical(this.retained.target) !== canonical(pending_target))) {
        if (!pending_target && this.knownResult?.receipt_id === this.retained.receipt_id) this.retained = null;
        else { this.patch({ ready: true, running: value.running, error: 'PANEL_ONLINE_RECOVERY_UNAVAILABLE' }); return true; }
      }
      this.retained = pending_target ? { target: pending_target, receipt_id: value.receipt_id } : null;
      this.patch({ ready: true, running: value.running, pending_target, receipt_id: value.receipt_id });
      return true;
    } catch { this.patch({ ready: false, error: 'PANEL_ONLINE_UNAVAILABLE' }); return false; }
  }
  async initialize() {
    const { result } = await this.controller.request('online_state', {});
    if (result.ok && this.hostState(result.data)) return true;
    this.patch({ error: 'PANEL_ONLINE_UNAVAILABLE' });
    return false;
  }
  async open() {
    if (this.controller.signal.aborted || this.state.active || this.state.running || this.controller.state.busy || this.controller.state.pending) return;
    if (!this.state.ready) { await this.initialize(); return; }
    const previous = this.retained;
    if (previous) {
      if (!await this.initialize()) return;
      if (!this.retained) {
        if (this.knownResult?.receipt_id === previous.receipt_id) { const result = this.knownResult.result; this.patch({ phase: result.ok && result.delivery?.delivered ? 'delivered' : 'failed', error: null }); return result; }
        this.patch({ pending_target: previous.target, receipt_id: previous.receipt_id, error: 'PANEL_ONLINE_RECOVERY_UNAVAILABLE' });
        return { ok: false, outcome_unknown: true };
      }
      if (this.state.error === 'PANEL_ONLINE_RECOVERY_UNAVAILABLE') {
        return { ok: false, outcome_unknown: true };
      }
    }
    const binding = this.controller.state.binding;
    const selected = previous?.target ?? (binding ? { binding_id: binding.binding_id, ...(this.controller.state.issue ? { identifier: this.controller.state.issue.identifier } : {}) } : null);
    if (!selected) return;
    const receipt_id = previous?.receipt_id ?? uuid(this.makeReceiptId(), 'receipt_id');
    if (!previous) this.knownResult = null;
    this.retained = { target: selected, receipt_id };
    this.patch({ active: true, error: null, phase: null, pending_target: selected, receipt_id });
    try {
      const { result } = await this.controller.request('open_online', { ...selected, receipt_id, recover: Boolean(previous) });
      if (!previous && result.error?.code === 'LOCAL_PENDING_OPERATION' && result.online?.receipt_id && result.online.receipt_id !== receipt_id) {
        this.retained = null;
        this.hostState(result.online);
      }
      if (result.outcome_unknown || !result.online) {
        this.patch({ error: 'PANEL_ONLINE_UNCERTAIN' });
        return { ...result, outcome_unknown: true };
      }
      this.knownResult = { receipt_id, result };
      this.hostState(result.online);
      this.patch({ phase: result.ok && result.delivery?.delivered ? 'delivered' : 'failed', error: null });
      // 确认只表达父层已收到已知结果；确认丢响应后先读账本，不能新建投递。
      if (result.online.receipt_id === receipt_id) await this.controller.request('ack_online', { ...selected, receipt_id });
      return result;
    } finally { this.patch({ active: false }); }
  }
  dispose() { this.unsubscribe(); this.listeners.clear(); this.controller.signal.removeEventListener('abort', this.onAbort); }
}
