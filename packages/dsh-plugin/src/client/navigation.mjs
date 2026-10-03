import { PANEL_CHANNEL, PANEL_NAMESPACE, PANEL_PROTOCOL, PANEL_KIND, record, uuid, identifier } from '../shared/panel.mjs';

const failure = code => ({ ok: false, error: { code } });
const aborted = signal => { if (signal.aborted) throw new Error('Navigation canceled'); };
const principalId = identity => identity?.principal?.principal_id ?? identity?.principal?.id;
const bindingMatches = (binding, target, principal, workspaceId) => binding?.identity?.instance?.instance_id === target.instance_id
  && principalId(binding.identity) === principal && binding.project?.id === target.project_id
  && (binding.project?.workspace_id ?? workspaceId) === target.workspace_id;

export function navigationRequest(value) {
  record(value, ['request_id', 'session_id', 'target', 'expected_principal_id', 'expires_at'], ['request_id', 'session_id', 'target', 'expected_principal_id', 'expires_at']);
  uuid(value.request_id, 'request');
  uuid(value.expected_principal_id, 'principal');
  if (typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 128 || !Number.isFinite(value.expires_at)) throw new Error('Invalid navigation');
  record(value.target, ['instance_id', 'workspace_id', 'project_id', 'identifier'], ['instance_id', 'workspace_id', 'project_id']);
  for (const key of ['instance_id', 'workspace_id', 'project_id']) uuid(value.target[key], key);
  if (value.target.identifier !== undefined) identifier(value.target.identifier);
  return structuredClone(value);
}

// Only the header's live Session can receive requests. The body claims one
// in-memory request, never a target reconstructed from saved tab parameters.
export class PanelNavigation {
  constructor(rpc, sidebar, { document = globalThis.document, makeId = () => crypto.randomUUID() } = {}) {
    this.rpc = rpc;
    this.sidebar = sidebar;
    this.document = document;
    this.makeId = makeId;
    this.requests = new Map();
  }
  call(endpoint, input, signal) {
    return this.rpc.call(PANEL_CHANNEL, `${PANEL_NAMESPACE}/${endpoint}`, { protocol: PANEL_PROTOCOL, input }, signal);
  }
  current(sessionId) {
    if (this.document?.visibilityState === 'hidden') return false;
    return this.sidebar.commandTarget()?.sessionId === sessionId;
  }
  connect(sessionId) {
    let active = null;
    let disposed = false;
    const stop = () => {
      if (!active) return;
      const { clientId, lifetime } = active;
      active = null;
      lifetime.abort();
      for (const [id, held] of this.requests) if (held.clientId === clientId) this.requests.delete(id);
      void this.call('navigation_unsubscribe', { session_id: sessionId, client_id: clientId }, AbortSignal.timeout(3000)).catch(() => {});
    };
    const start = () => {
      if (disposed || active || this.document?.visibilityState === 'hidden') return;
      // 可见性恢复后使用新代际，避免迟到的取消请求终止新订阅。
      const clientId = this.makeId();
      const lifetime = new AbortController();
      const connection = { clientId, lifetime };
      active = connection;
      const receive = async () => {
        try {
          while (!lifetime.signal.aborted) {
            const wire = await this.call('navigation_subscribe', { session_id: sessionId, client_id: clientId }, lifetime.signal);
            aborted(lifetime.signal);
            if (!wire.ok || !wire.value?.ok) break;
            const request = navigationRequest(wire.value.data);
            if (request.session_id !== sessionId) break;
            // Re-arm the Host subscription immediately; processing does not
            // create a gap in the client's lifetime or another browser owner.
            void this.deliver(request, clientId, lifetime.signal);
          }
        } catch { /* A lost subscription is unavailable, not an open result. */ }
        finally { if (active === connection) stop(); }
      };
      void receive();
    };
    const update = () => { if (this.document?.visibilityState !== 'hidden') start(); else stop(); };
    this.document?.addEventListener('visibilitychange', update);
    this.document?.defaultView?.addEventListener('focus', update);
    start();
    return () => {
      disposed = true;
      this.document?.removeEventListener('visibilitychange', update);
      this.document?.defaultView?.removeEventListener('focus', update);
      stop();
    };
  }
  async deliver(request, clientId, lifetime) {
    let result = failure('PANEL_NAVIGATION_UNAVAILABLE');
    const remaining = request.expires_at - Date.now();
    if (remaining <= 0 || remaining > 60_000) return;
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(remaining)]);
    try {
      aborted(signal);
      const target = this.sidebar.commandTarget();
      if (!this.current(request.session_id) || target?.sessionId !== request.session_id || !this.sidebar.isTargetCurrent(target)) throw new Error('Session changed');
      result = await new Promise(resolve => {
        const finish = value => { signal.removeEventListener('abort', onAbort); this.requests.delete(request.request_id); resolve(value); };
        const onAbort = () => finish(failure('PANEL_NAVIGATION_CANCELED'));
        this.requests.set(request.request_id, { request, clientId, signal, finish, claimed: false });
        signal.addEventListener('abort', onAbort, { once: true });
        try { this.sidebar.openTab(PANEL_KIND, { params: { navigation_request_id: request.request_id } }); }
        catch { finish(failure('PANEL_NAVIGATION_UNAVAILABLE')); }
      });
      if (!this.current(request.session_id)) result = failure('PANEL_NAVIGATION_CANCELED');
    } catch { /* Exact caller Session is no longer visible. */ }
    if (!signal.aborted) await this.call('navigation_ack', { session_id: request.session_id, client_id: clientId, request_id: request.request_id, result }, signal).catch(() => {});
  }
  has(requestId, sessionId) {
    const held = this.requests.get(requestId);
    return Boolean(held && !held.signal.aborted && held.request.session_id === sessionId);
  }
  claim(requestId, sessionId) {
    const held = this.requests.get(requestId);
    if (!held || held.claimed || held.signal.aborted || held.request.session_id !== sessionId) return null;
    held.claimed = true;
    return held;
  }
}

export async function navigateWorkbench({ controller, online, adapter, request, signal, isCurrent }) {
  const { target, expected_principal_id } = request;
  const guard = () => {
    aborted(signal);
    if (!isCurrent() || controller.signal.aborted) throw new Error('Session changed');
  };
  if (online.blocked || controller.state.busy || controller.state.pending || adapter.running || !controller.canChangeBinding()) return failure('PANEL_NAVIGATION_BUSY');
  adapter.running = true;
  try {
    guard();
    const binding = controller.state.binding;
    if (binding && !bindingMatches(binding, target, expected_principal_id, controller.state.workspace_id)) {
      const { result } = await controller.request('unbind', { binding_id: binding.binding_id }, undefined, undefined, signal);
      guard();
      if (!result.ok) return failure(result.error?.code ?? 'PANEL_NAVIGATION_BUSY');
      controller.patch({ binding: null, issue: null, page: null, board: null });
    }
    if (!controller.state.binding) {
      // Directory scope is a recommendation; an explicit verified target can
      // select another authorized project without rewriting that scope file.
      controller.patch({ scope_instance_id: null, scope_mode: 'manual' });
      await controller.selectInstance(target.instance_id, signal);
      guard();
      if (principalId(controller.state.identity) !== expected_principal_id) return failure('PANEL_IDENTITY_CHANGED');
      controller.patch({ workspace_id: target.workspace_id, filters: { assignment: 'all', status: '', priority: '' } });
      await controller.bind(target.project_id, signal);
      guard();
    }
    if (controller.state.error) return failure(controller.state.error.code);
    const actual = controller.state.binding;
    if (!bindingMatches(actual, target, expected_principal_id, controller.state.workspace_id)) return failure('PANEL_NAVIGATION_TARGET_MISMATCH');
    if (target.identifier) await controller.openIssue(target.identifier, signal);
    else { controller.patch({ issue: null, comments: [] }); await controller.refresh(undefined, signal); }
    guard();
    if (controller.state.error) return failure(controller.state.error.code);
    const rendered = await adapter.waitForRendered({ ...target, principal_id: expected_principal_id }, { signal, timeoutMs: Math.max(1, request.expires_at - Date.now()) });
    guard();
    return rendered.ok ? { ok: true, target } : failure(rendered.error?.code ?? 'PANEL_NAVIGATION_UNCONFIRMED');
  } catch { return failure('PANEL_NAVIGATION_CANCELED'); }
  finally { adapter.running = false; }
}
