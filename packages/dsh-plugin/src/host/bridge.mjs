import { WorkbenchBridge, OnlineBroker } from '../../../local-runtime/src/workbench/index.mjs';
import { PanelError, record, uuid, identifier } from '../shared/panel.mjs';
export { assertLocalHost } from '../../../local-runtime/src/workbench/bridge.mjs';

export class PanelBridge extends WorkbenchBridge {
  constructor(options) {
    super({ ...options, sessionContext: options.dsh ?? options.sessionContext });
    this.online = new OnlineBroker({ bridge: this, ...(options.openOnline ? { openOnline: options.openOnline } : {}) });
    this.activeBusiness = 0;
  }
  hasPending(binding) {
    return super.hasPending(binding) || Boolean(this.online?.hasPending() && (!binding || this.bindings.get(this.online.snapshot().pending_target?.binding_id) === binding));
  }
  dispose() { this.online?.dispose(); super.dispose(); }
  async dispatch(endpoint, input, signal) {
    if (endpoint === 'online_state') { record(input, []); return { ok: true, status: 200, data: this.online.snapshot() }; }
    if (endpoint === 'open_online' || endpoint === 'ack_online') {
      record(input, ['binding_id', 'identifier', 'receipt_id', ...(endpoint === 'open_online' ? ['recover'] : [])], ['binding_id', 'receipt_id', ...(endpoint === 'open_online' ? ['recover'] : [])]);
      uuid(input.binding_id, 'binding_id');
      uuid(input.receipt_id, 'receipt_id');
      if (input.identifier !== undefined) identifier(input.identifier);
      if (endpoint === 'ack_online') return { ...this.online.acknowledge(input), online: this.online.snapshot() };
      if (typeof input.recover !== 'boolean') throw new PanelError('PANEL_INVALID_INPUT', 'Invalid online recovery flag.');
      if (this.activeBusiness || [...this.bindings.values()].some(binding => super.hasPending(binding))) return { ok: false, error: { code: 'PANEL_OPERATION_PENDING' }, online: this.online.snapshot() };
      if (!this.online.hasPending()) {
        try { this.binding(input); }
        catch (error) { if (!(error instanceof PanelError)) throw error; return { ok: false, error: { code: error.code }, online: this.online.snapshot() }; }
      }
      const selected = { binding_id: input.binding_id, ...(input.identifier ? { identifier: input.identifier } : {}) };
      const result = await this.online.open(selected, { signal, receiptId: input.receipt_id, recover: input.recover });
      return { ...result, online: this.online.snapshot() };
    }
    if (!this.online.allows(endpoint, input)) return { ok: false, status: 409, error: { code: 'PANEL_ONLINE_PENDING' }, online: this.online.snapshot() };
    const business = ['mutate', 'recover', 'bind', 'bind_scope', 'unbind'].includes(endpoint);
    if (business) this.activeBusiness++;
    try { return await super.dispatch(endpoint, input, signal); }
    finally { if (business) this.activeBusiness--; }
  }
}
