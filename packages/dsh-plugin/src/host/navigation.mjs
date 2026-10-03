import { randomUUID } from 'node:crypto';
import { assertLocalHost } from './bridge.mjs';
import { PANEL_PROTOCOL, PanelError, record, uuid, identifier, boundedText, canonical } from '../shared/panel.mjs';

export const NAVIGATION_ENDPOINTS = Object.freeze(['navigation_subscribe', 'navigation_ack', 'navigation_unsubscribe']);
const result = data => ({ ok: true, status: 200, data });
const messages = {
  PANEL_NAVIGATION_SESSION_REQUIRED: 'Open this tool from an Agent Session with an active cfKanban client.',
  PANEL_NAVIGATION_CLIENT_UNAVAILABLE: 'The calling Session has no active foreground cfKanban client.',
  PANEL_NAVIGATION_CLIENT_AMBIGUOUS: 'More than one foreground client is showing this Session. Keep one client active and retry.',
  PANEL_NAVIGATION_PENDING: 'A navigation request is already pending for this Session.',
  PANEL_NAVIGATION_TIMEOUT: 'The sidebar did not confirm the requested view before the deadline.',
  PANEL_NAVIGATION_CANCELLED: 'The navigation request was cancelled.',
  PANEL_NAVIGATION_UNAVAILABLE: 'The cfKanban navigation service is unavailable.',
  PANEL_NAVIGATION_ACK_MISMATCH: 'The sidebar did not confirm the exact requested target.',
  PANEL_NAVIGATION_REQUEST_EXPIRED: 'This navigation request is no longer active.',
  PANEL_NAVIGATION_INVALID_INPUT: 'The navigation request contains invalid fields.',
  PANEL_NAVIGATION_CLIENT_FAILED: 'The sidebar could not render the requested view.',
};
const failure = code => ({ ok: false, error: { code, message: messages[code] ?? 'The requested view was refused. Verify the connection, identity and target permissions.' } });
const errorCode = error => error instanceof PanelError && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'PANEL_NAVIGATION_UNAVAILABLE';
const dataOf = value => { if (!value?.ok) throw new PanelError(value?.error?.code ?? 'PANEL_NAVIGATION_UNAVAILABLE'); return value.data; };

export function navigationTarget(value) {
  record(value, ['instance_id', 'workspace_id', 'project_id', 'identifier'], ['instance_id', 'workspace_id', 'project_id']);
  const target = Object.fromEntries(['instance_id', 'workspace_id', 'project_id'].map(key => [key, uuid(value[key], key)]));
  if (value.identifier !== undefined) target.identifier = identifier(value.identifier);
  return target;
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class PanelNavigation {
  constructor({ bridge, timeoutMs = 30000, preflightMs = 15000, now = Date.now, makeId = randomUUID }) {
    this.bridge = bridge;
    this.timeoutMs = timeoutMs;
    this.preflightMs = preflightMs;
    this.now = now;
    this.makeId = makeId;
    this.subscriptions = new Map();
    this.pending = new Map();
    this.lifetime = new AbortController();
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    this.lifetime.abort();
    for (const operation of this.pending.values()) operation.finish(failure('PANEL_NAVIGATION_UNAVAILABLE'));
    for (const subscribers of this.subscriptions.values()) for (const subscription of [...subscribers.values()]) subscription.finish(failure('PANEL_NAVIGATION_UNAVAILABLE'));
    this.subscriptions.clear();
  }

  async verifySession(sessionId, signal) {
    boundedText(sessionId, 128, 'Session');
    const workspace = this.bridge.sessions?.workspaces().find(row => row.sessionIds.includes(sessionId));
    if (!workspace) throw new PanelError('PANEL_NAVIGATION_SESSION_REQUIRED');
    await this.bridge.verifySession(workspace.id, sessionId, signal);
  }

  async call(endpoint, payload, signal, peer) {
    try {
      assertLocalHost(this.bridge.host, peer);
      if (this.disposed) return failure('PANEL_NAVIGATION_UNAVAILABLE');
      record(payload, ['protocol', 'input'], ['protocol', 'input']);
      if (payload.protocol !== PANEL_PROTOCOL) throw new PanelError('PANEL_VERSION_MISMATCH');
      const input = payload.input;
      record(input, ['session_id', 'client_id', ...(endpoint === 'navigation_ack' ? ['request_id', 'result'] : [])], ['session_id', 'client_id', ...(endpoint === 'navigation_ack' ? ['request_id', 'result'] : [])]);
      boundedText(input.session_id, 128, 'Session');
      uuid(input.client_id, 'client_id');
      if (endpoint === 'navigation_subscribe') {
        if (!signal || signal.aborted) return failure('PANEL_NAVIGATION_CANCELLED');
        signal = AbortSignal.any([signal, this.lifetime.signal]);
        await withAbort(this.verifySession(input.session_id, signal), signal);
        return await this.subscribe(input, signal);
      }
      if (endpoint === 'navigation_unsubscribe') {
        this.subscriptions.get(input.session_id)?.get(input.client_id)?.finish(failure('PANEL_NAVIGATION_CANCELLED'));
        const operation = this.pending.get(input.session_id);
        if (operation?.clientId === input.client_id) operation.finish(failure('PANEL_NAVIGATION_CLIENT_UNAVAILABLE'));
        return result({ unsubscribed: true });
      }
      if (endpoint === 'navigation_ack') return this.acknowledge(input);
      return failure('PANEL_NAVIGATION_INVALID_INPUT');
    } catch (error) { return failure(signal?.aborted ? 'PANEL_NAVIGATION_CANCELLED' : errorCode(error)); }
  }

  subscribe({ session_id: sessionId, client_id: clientId }, signal) {
    if (signal.aborted || this.disposed) return failure('PANEL_NAVIGATION_CANCELLED');
    let subscribers = this.subscriptions.get(sessionId);
    if (!subscribers) {
      if (this.subscriptions.size >= 64) return failure('PANEL_CAPACITY');
      this.subscriptions.set(sessionId, subscribers = new Map());
    }
    if (subscribers.has(clientId) || subscribers.size >= 8) return failure('PANEL_NAVIGATION_CLIENT_AMBIGUOUS');
    return new Promise(resolve => {
      const finish = value => {
        if (subscribers.get(clientId) !== subscription) return;
        subscribers.delete(clientId);
        if (!subscribers.size) this.subscriptions.delete(sessionId);
        signal.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = () => {
        finish(failure('PANEL_NAVIGATION_CANCELLED'));
        const operation = this.pending.get(sessionId);
        if (operation?.clientId === clientId) operation.finish(failure('PANEL_NAVIGATION_CLIENT_UNAVAILABLE'));
      };
      const subscription = { finish };
      subscribers.set(clientId, subscription);
      signal.addEventListener('abort', abort, { once: true });
      const operation = this.pending.get(sessionId);
      if (operation && (subscribers.size !== 1 || operation.clientId !== clientId)) operation.finish(failure('PANEL_NAVIGATION_CLIENT_AMBIGUOUS'));
    });
  }

  currentClient(sessionId) {
    const subscribers = this.subscriptions.get(sessionId);
    if (!subscribers?.size) throw new PanelError('PANEL_NAVIGATION_CLIENT_UNAVAILABLE');
    if (subscribers.size !== 1) throw new PanelError('PANEL_NAVIGATION_CLIENT_AMBIGUOUS');
    return [...subscribers.entries()][0];
  }

  async preflight(target, signal) {
    const identity = dataOf(await this.bridge.call('identity', { protocol: PANEL_PROTOCOL, input: { instance_id: target.instance_id } }, signal, this.bridge.host.operator));
    const principalId = uuid(identity.principal?.principal_id ?? identity.principal?.id, 'principal_id');
    const binding = { ...target, principal_id: principalId };
    dataOf(await this.bridge.tool(binding, 'cfkanban_projects_get', { workspace_id: target.workspace_id, project_id: target.project_id }, signal));
    if (target.identifier) dataOf(await this.bridge.tool(binding, 'cfkanban_issues_get', { identifier: target.identifier }, signal));
    signal.throwIfAborted();
    return principalId;
  }

  async open(input, exec) {
    let target, sessionId, clientId;
    try {
      assertLocalHost(this.bridge.host, this.bridge.host.operator);
      if (this.disposed) return failure('PANEL_NAVIGATION_UNAVAILABLE');
      target = navigationTarget(input);
      sessionId = exec?.agent?.session?.id;
      if (!sessionId) return failure('PANEL_NAVIGATION_SESSION_REQUIRED');
      boundedText(sessionId, 128, 'Session');
      if (exec.signal?.aborted) return failure('PANEL_NAVIGATION_CANCELLED');
      if (this.pending.has(sessionId)) return failure('PANEL_NAVIGATION_PENDING');
      [clientId] = this.currentClient(sessionId);
    } catch (error) { return failure(errorCode(error)); }
    const lifetime = new AbortController();
    const requestId = this.makeId();
    const expiresAt = this.now() + this.timeoutMs;
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    const cancel = () => operation.finish(failure('PANEL_NAVIGATION_CANCELLED'));
    const timer = setTimeout(() => operation.finish(failure('PANEL_NAVIGATION_TIMEOUT')), this.timeoutMs);
    const operation = {
      requestId, clientId, target, expiresAt, sent: false,
      finish: value => {
        if (this.pending.get(sessionId) !== operation) return;
        this.pending.delete(sessionId);
        clearTimeout(timer);
        exec.signal?.removeEventListener('abort', cancel);
        lifetime.abort();
        resolve(value);
      },
    };
    this.pending.set(sessionId, operation);
    exec.signal?.addEventListener('abort', cancel, { once: true });
    const preflightDeadline = AbortSignal.timeout(Math.min(this.preflightMs, this.timeoutMs));
    const signal = AbortSignal.any([lifetime.signal, preflightDeadline]);
    try {
      await withAbort(this.verifySession(sessionId, signal), signal);
      const principalId = await withAbort(this.preflight(target, signal), signal);
      if (this.pending.get(sessionId) !== operation) return completion;
      const [currentId, subscriber] = this.currentClient(sessionId);
      if (currentId !== clientId) throw new PanelError('PANEL_NAVIGATION_CLIENT_UNAVAILABLE');
      operation.sent = true;
      subscriber.finish(result({ request_id: requestId, session_id: sessionId, target, expected_principal_id: principalId, expires_at: expiresAt }));
    } catch (error) {
      operation.finish(failure(preflightDeadline.aborted ? 'PANEL_NAVIGATION_TIMEOUT' : errorCode(error)));
    }
    return completion;
  }

  acknowledge(input) {
    uuid(input.request_id, 'request_id');
    const operation = this.pending.get(input.session_id);
    if (!operation || !operation.sent || operation.requestId !== input.request_id || operation.clientId !== input.client_id) return failure('PANEL_NAVIGATION_REQUEST_EXPIRED');
    if (this.now() >= operation.expiresAt) {
      operation.finish(failure('PANEL_NAVIGATION_TIMEOUT'));
      return failure('PANEL_NAVIGATION_REQUEST_EXPIRED');
    }
    try {
      record(input.result, ['ok', 'target', 'error'], ['ok']);
      if (input.result.ok === false) {
        record(input.result, ['ok', 'error'], ['ok', 'error']);
        record(input.result.error, ['code'], ['code']);
        const code = input.result.error.code;
        operation.finish(failure(typeof code === 'string' && /^PANEL_[A-Z0-9_]{1,70}$/.test(code) ? code : 'PANEL_NAVIGATION_CLIENT_FAILED'));
        return result({ acknowledged: true });
      }
      record(input.result, ['ok', 'target'], ['ok', 'target']);
      const [clientId] = this.currentClient(input.session_id);
      if (input.result.ok !== true || clientId !== input.client_id || canonical(navigationTarget(input.result.target)) !== canonical(operation.target)) throw new PanelError('PANEL_NAVIGATION_ACK_MISMATCH');
      operation.finish({ ok: true, opened: true, surface: 'sidebar', target: operation.target });
      return result({ acknowledged: true });
    } catch (error) {
      const code = ['PANEL_NAVIGATION_CLIENT_UNAVAILABLE', 'PANEL_NAVIGATION_CLIENT_AMBIGUOUS'].includes(error.code) ? error.code : 'PANEL_NAVIGATION_ACK_MISMATCH';
      operation.finish(failure(code));
      return failure(code);
    }
  }
}
