import { WorkbenchController } from '../../../local-runtime/src/workbench/controller.mjs';
import { PANEL_CHANNEL, PANEL_NAMESPACE } from '../shared/panel.mjs';
export { items, nextCursor, recoveryId, sessionReference } from '../../../local-runtime/src/workbench/controller.mjs';

export class PanelController extends WorkbenchController {
  constructor(rpc, lifetime, makeKey, options = {}) {
    const listeners = new Set();
    super({ call: async (endpoint, payload, signal) => {
      const response = await rpc.call(PANEL_CHANNEL, `${PANEL_NAMESPACE}/${endpoint}`, payload, signal);
      if (!signal?.aborted && response?.value?.online) listeners.forEach(listener => listener(response.value.online));
      return response;
    } }, lifetime, makeKey, { initialView: 'list', ...options });
    this.onlineListeners = listeners;
  }
  subscribeOnline(listener) { this.onlineListeners.add(listener); return () => this.onlineListeners.delete(listener); }
  dispose() { this.onlineListeners.clear(); super.dispose(); }
}
