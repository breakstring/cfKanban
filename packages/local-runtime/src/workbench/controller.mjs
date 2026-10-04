import { PANEL_PROTOCOL, uuid, scopeFailureCode, isSessionReference } from './shared.mjs';
import { readIssueHierarchy } from '../../../../apps/web/src/lib/issue-hierarchy.ts';
import { checkpointState, validateCheckpoint } from './checkpoint.mjs';

export const items = value => Array.isArray(value) ? value : value?.items ?? value?.statuses ?? [];
export const nextCursor = value => value?.next_cursor ?? value?.continuation?.next_cursor ?? null;
export const recoveryId = value => { try { return uuid(value, 'recovery identity'); } catch { return null; } };
export const sessionReference = value => isSessionReference(value) ? value : null;
export const ISSUE_COLLECTION_LIMIT = 1000;
const COLLECTION_BYTES = 1_048_576;
const MAX_COLLECTION_PAGES = 40;
const fields = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, structuredClone(value[name])]));
const summary = value => ({ ...fields(value, ['id', 'identifier', 'title', 'version', 'priority', 'is_blocked']), ...(readIssueHierarchy(value.hierarchy) ? { hierarchy: readIssueHierarchy(value.hierarchy) } : {}), status: fields(value.status, ['key', 'display_name']), assignee: value.assignee ? fields(value.assignee, ['id', 'principal_id', 'display_name', 'available']) : null, allowed_actions: Array.isArray(value.allowed_actions) ? [...value.allowed_actions] : [] });
function mergeRows(previous, incoming) {
  const result = new Map();
  for (const value of [...previous, ...incoming]) {
    const row = summary(value);
    const existing = result.get(row.identifier);
    if (!existing || row.version >= existing.version) result.set(row.identifier, row);
  }
  return [...result.values()];
}

export class WorkbenchController {
  constructor(rpc, lifetime, makeKey = () => crypto.randomUUID(), { requestTimeoutMs = 45_000, initialView = 'board' } = {}) {
    this.rpc = rpc;
    this.makeKey = makeKey;
    this.requestTimeoutMs = requestTimeoutMs;
    this.lifetime = new AbortController();
    this.signal = AbortSignal.any([this.lifetime.signal, lifetime]);
    this.listeners = new Set();
    this.revisions = new Map();
    this.collectionRevision = 0;
    this.collectionFlights = new Map();
    this.collectionCursors = new Set();
    this.collectionPages = new Map();
    this.collectionValidators = new Set();
    this.labelRevision = 0;
    this.labelFlights = new Map();
    this.labelCursors = new Set();
    this.state = { candidates: [], identity: null, workspaces: [], projects: [], binding: null, view: initialView === 'list' ? 'list' : 'board', board: null, page: null, issue: null, comments: [], comment_cursor: null, labels: [], label_cursor: null, labels_has_more: false, filters: { assignment: 'all', status: '', priority: '' }, busy: 0, error: null, pending: null, source_session_id: null, session_context_changed: false, workspace_scope: null, scope_instance_id: null, scope_mode: 'manual', scope_targets: [], scope_next_offset: null };
  }
  getSnapshot = () => this.state;
  getCheckpoint() { return validateCheckpoint(checkpointState(this.state)); }
  async restoreCheckpoint(value) {
    const checkpoint = validateCheckpoint(value);
    if (!checkpoint) { this.patch({ error: { code: 'PANEL_INVALID_INPUT' } }); return false; }
    this.patch({ ...checkpoint.state, page: null, board: null, comments: [], busy: 0, error: null });
    if (this.state.binding) { await this.refresh(); if (this.state.issue) await this.openIssue(this.state.issue.identifier); }
    return true;
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  patch(update) {
    if (this.signal.aborted) return;
    if (Object.hasOwn(update, 'binding') && this.state.binding?.binding_id !== update.binding?.binding_id || Object.hasOwn(update, 'filters') || Object.hasOwn(update, 'view') || update.page === null || update.board === null) this.invalidateCollections();
    if (Object.hasOwn(update, 'binding') && this.state.binding?.binding_id !== update.binding?.binding_id) {
      this.labelRevision++; this.labelFlights.clear(); this.labelCursors.clear();
      update = { assignees: [], assignee_cursor: null, assignees_has_more: false, labels: [], label_cursor: null, labels_has_more: false, ...update };
    }
    this.state = { ...this.state, ...update }; this.listeners.forEach(listener => listener());
  }
  dispose() { this.lifetime.abort(); this.listeners.clear(); }
  invalidateCollections() { this.collectionRevision++; this.collectionFlights.clear(); this.collectionCursors.clear(); this.collectionPages.clear(); }
  addCollectionValidator(validator) { this.collectionValidators.add(validator); return () => this.collectionValidators.delete(validator); }
  collectionFits(update) {
    const state = { ...this.state, ...update };
    try { return new TextEncoder().encode(JSON.stringify({ page: state.page, board: state.board })).length <= COLLECTION_BYTES && [...this.collectionValidators].every(validate => validate(state)); }
    catch { return false; }
  }
  collectionRequest(key, operation, flights = this.collectionFlights) {
    if (flights.has(key)) return flights.get(key);
    const request = operation().finally(() => { if (flights.get(key) === request) flights.delete(key); });
    flights.set(key, request);
    return request;
  }
  async request(endpoint, input, channel = endpoint, matches = () => true, signal) {
    const revision = (this.revisions.get(channel) ?? 0) + 1;
    this.revisions.set(channel, revision);
    this.patch({ busy: this.state.busy + 1, error: null });
    const requestSignal = AbortSignal.any([this.signal, AbortSignal.timeout(this.requestTimeoutMs), ...(signal ? [signal] : [])]);
    let removeAbort = () => {};
    try {
      requestSignal.throwIfAborted();
      const interrupted = new Promise((_, reject) => {
        const onAbort = () => reject(requestSignal.reason);
        requestSignal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => requestSignal.removeEventListener('abort', onAbort);
      });
      const wire = await Promise.race([this.rpc.call(endpoint, { protocol: PANEL_PROTOCOL, input }, requestSignal), interrupted]);
      const result = wire.ok ? wire.value : { ok: false, error: wire.error, outcome_unknown: ['mutate', 'recover'].includes(endpoint) };
      const current = !requestSignal.aborted && this.revisions.get(channel) === revision && matches();
      if (current && !result.ok) this.patch({ error: result.error });
      return { result, current };
    } catch {
      const result = { ok: false, outcome_unknown: ['mutate', 'recover'].includes(endpoint), error: { code: 'PANEL_REQUEST_UNCERTAIN', message: 'Request interrupted. Retain the original operation for explicit recovery.' } };
      if (!this.signal.aborted && !signal?.aborted && this.revisions.get(channel) === revision && matches()) this.patch({ error: result.error });
      return { result, current: false };
    } finally { removeAbort(); this.patch({ busy: Math.max(0, this.state.busy - 1) }); }
  }
  canChangeBinding() { return !this.state.pending && !this.state.session_context_changed; }
  identityUpdate(identity) {
    if (!identity?.principal || !this.state.binding) return {};
    const current = this.state.binding.identity?.principal;
    const incoming = identity.principal;
    const principalId = value => value?.principal_id ?? value?.id;
    if (principalId(incoming) !== principalId(current)) return {};
    if (Number.isSafeInteger(current.version) && (!Number.isSafeInteger(incoming.version) || incoming.version < current.version)) return {};
    const principal = { ...incoming };
    for (const preference of ['theme', 'locale']) if (!Object.hasOwn(incoming, preference) && Object.hasOwn(current, preference)) principal[preference] = current[preference];
    const merged = { ...identity, principal };
    return { binding: { ...this.state.binding, identity: merged }, ...(this.state.identity ? { identity: merged } : {}) };
  }
  sessionContext(session_id) {
    if (this.state.source_session_id && this.state.source_session_id !== session_id) {
      this.patch({ session_context_changed: true, error: { code: 'PANEL_SESSION_CONTEXT_CHANGED', message: 'Open the original Session tab to retain and resolve its operations before changing context.' } });
      return false;
    }
    if (session_id) this.patch({ source_session_id: session_id });
    return true;
  }
  async bootstrap(session_id = null, initialContext) {
    if (!this.sessionContext(session_id) || !this.canChangeBinding() || this.state.binding) return;
    if (initialContext) {
      if (['list', 'board'].includes(initialContext.view)) this.patch({ view: initialContext.view });
      const target = initialContext.target;
      const instance_id = target?.instance_id ?? initialContext.instance_id;
      if (instance_id) {
        this.patch({ scope_instance_id: uuid(instance_id, 'initial instance') });
        if (target) {
          await this.selectInstance(this.state.scope_instance_id);
          if (!this.state.identity) return;
          this.patch({ workspace_id: uuid(target.workspace_id, 'initial workspace') });
          await this.bind(uuid(target.project_id, 'initial project'));
          if (this.state.binding && target.identifier) await this.openIssue(target.identifier);
          return;
        }
      }
    }
    {
      const { result, current } = await this.request(session_id ? 'session_scope' : 'workspace_scope', session_id ? { session_id } : {});
      if (current && result.ok) {
        const targets = (result.data.targets ?? []).filter(target => !this.state.scope_instance_id || target.instance_id === this.state.scope_instance_id);
        this.patch({ workspace_scope: { ...result.data, targets } });
        if (result.data.status === 'configured' && targets.length) {
          this.patch({ scope_mode: 'suggested' });
          if (targets.length === 1) await this.bindScope(targets[0]);
          else await this.loadScopeTargets();
          return;
        }
      } else if (!result.ok) this.patch({ scope_fallback: scopeFailureCode(result.error?.code) });
    }
    await this.useManual();
  }
  async loadCandidates() {
    const { result, current } = await this.request('connections', {});
    if (current && result.ok) this.patch({ candidates: (result.data.candidates ?? []).filter(candidate => !this.state.scope_instance_id || candidate.instance_id === this.state.scope_instance_id) });
  }
  async loadScopeTargets(offset) {
    if (!this.canChangeBinding()) return;
    const { result, current } = await this.request('scope_targets', { ...(this.state.source_session_id ? { session_id: this.state.source_session_id } : {}), ...(this.state.scope_instance_id ? { instance_id: this.state.scope_instance_id } : {}), ...(offset === undefined ? {} : { offset }) });
    if (current && result.ok) this.patch({ scope_targets: items(result.data), scope_next_offset: result.data.next_offset });
    else if (current) { this.patch({ scope_fallback: scopeFailureCode(result.error?.code) }); if (!this.state.binding) await this.useManual(); }
  }
  async bindScope(target) {
    if (!this.canChangeBinding()) return;
    const { instance_id, workspace_id, project_id } = target;
    if (this.state.scope_instance_id && instance_id !== this.state.scope_instance_id) { this.patch({ error: { code: 'PANEL_SCOPE_DENIED' } }); return; }
    const { result, current } = await this.request('bind_scope', { ...(this.state.source_session_id ? { session_id: this.state.source_session_id } : {}), target: { instance_id, workspace_id, project_id } });
    if (current && result.ok) { this.patch({ binding: result.data, issue: null, page: null, board: null }); await this.refresh(); }
    else if (current) { this.patch({ scope_fallback: scopeFailureCode(result.error?.code) }); if (!this.state.binding) await this.useManual(); }
  }
  async useManual() {
    if (!this.canChangeBinding()) return;
    if (this.state.binding) { await this.unbind(); return; }
    this.patch({ scope_mode: 'manual' });
    if (this.state.scope_instance_id) {
      await this.selectInstance(this.state.scope_instance_id);
      if (this.state.identity) await this.loadWorkspaces();
      return;
    }
    await this.loadCandidates();
  }
  async selectInstance(instance_id, signal) {
    if (signal?.aborted || !this.canChangeBinding()) return;
    if (this.state.scope_instance_id && instance_id !== this.state.scope_instance_id) { this.patch({ error: { code: 'PANEL_SCOPE_DENIED' } }); return; }
    this.patch({ identity: null, workspaces: [], projects: [], binding: null, page: null, board: null, issue: null, pending: null });
    const { result, current } = await this.request('identity', { instance_id }, undefined, undefined, signal);
    if (current && result.ok && !signal?.aborted) this.patch({ identity: result.data });
  }
  identityInput() { return { instance_id: this.state.identity.instance.instance_id, expected_principal_id: this.state.identity.principal.principal_id ?? this.state.identity.principal.id }; }
  async loadWorkspaces(cursor) {
    const { result, current } = await this.request('workspaces', { ...this.identityInput(), ...(cursor ? { cursor } : {}) });
    if (current && result.ok) this.patch({ workspaces: items(result.data), workspace_cursor: nextCursor(result.data) });
  }
  async selectWorkspace(workspace_id, cursor) {
    if (!this.canChangeBinding()) return;
    this.patch({ workspace_id, projects: [], binding: null, page: null, board: null, issue: null });
    const { result, current } = await this.request('projects', { ...this.identityInput(), workspace_id, ...(cursor ? { cursor } : {}) });
    if (current && result.ok) this.patch({ projects: items(result.data), project_cursor: nextCursor(result.data) });
  }
  async bind(project_id, signal) {
    if (signal?.aborted || !this.canChangeBinding()) return;
    const { result, current } = await this.request('bind', { ...this.identityInput(), workspace_id: this.state.workspace_id, project_id }, undefined, undefined, signal);
    if (current && result.ok && !signal?.aborted) { this.patch({ binding: result.data, issue: null, page: null, board: null }); await this.refresh(undefined, signal); }
  }
  async unbind() {
    if (!this.canChangeBinding()) return false;
    if (this.state.binding) { const { result } = await this.request('unbind', { binding_id: this.state.binding.binding_id }); if (!result.ok) return false; }
    this.patch({ binding: null, page: null, board: null, issue: null, scope_mode: 'manual' });
    await this.loadCandidates();
    return true;
  }
  async refresh(_cursor, signal) {
    return this.refreshBoard(undefined, undefined, signal);
  }
  async setView(view) { if (!['list', 'board'].includes(view) || !this.canChangeBinding()) return; this.patch({ view, page: null, board: null }); await this.refresh(); }
  async refreshBoard(status_key, cursor, signal) {
    if (signal?.aborted || !this.state.binding || !['list', 'board'].includes(this.state.view)) return;
    const view = this.state.view;
    const { assignment, priority, status } = this.state.filters;
    if (status_key && status && status_key !== status) return;
    const selectedStatus = status_key || status;
    const original = this.state.board?.columns.find(row => row.key === status_key);
    if (cursor && (cursor !== original?.next_cursor || original.capacity_reached)) return;
    if (!cursor) this.invalidateCollections();
    const revision = this.collectionRevision;
    const key = `${revision}:${view}:${selectedStatus ?? 'all'}:${cursor ?? ''}`;
    if (cursor && this.collectionCursors.has(key)) { this.patch({ error: { code: 'PANEL_PAGINATION_STALLED' } }); return; }
    return this.collectionRequest(key, async () => {
      const { result, current } = await this.request('board', { binding_id: this.state.binding.binding_id, assignment, priority, ...(selectedStatus ? { status_key: selectedStatus } : {}), ...(cursor ? { cursor } : {}) }, `${view}:${selectedStatus ?? 'all'}`, () => revision === this.collectionRevision && this.state.view === view, signal);
      if (current && result.ok && !signal?.aborted) {
        const updated = result.data.columns.map(column => {
          const previous = this.state.board?.columns.find(row => row.key === column.key);
          const merged = mergeRows(cursor ? previous?.items ?? [] : [], column.items);
          const pages = (cursor ? this.collectionPages.get(column.key) ?? 0 : 0) + 1;
          return { key: column.key, display_name: column.display_name, items: merged, next_cursor: nextCursor(column), capacity_reached: Boolean(nextCursor(column) && (merged.length >= ISSUE_COLLECTION_LIMIT || pages >= MAX_COLLECTION_PAGES)), pages };
        });
        const columns = status_key ? this.state.board.columns.map(column => updated.find(row => row.key === column.key) ?? column) : updated;
        const board = { columns: columns.map(column => {
          if (!Object.hasOwn(column, 'pages')) return column;
          const { pages, ...value } = column; return value;
        }) };
        if (updated.some(column => column.items.length > ISSUE_COLLECTION_LIMIT) || !this.collectionFits({ board })) {
          if (this.state.board) this.patch({ board: { columns: this.state.board.columns.map(column => !status_key || column.key === status_key ? { ...column, capacity_reached: true } : column) } });
          else this.patch({ error: { code: 'PANEL_CONTEXT_TOO_LARGE' } });
          return { ok: false, error: { code: this.state.board ? 'PANEL_CAPACITY' : 'PANEL_CONTEXT_TOO_LARGE' } };
        } else {
          updated.forEach(column => this.collectionPages.set(column.key, column.pages));
          if (cursor) this.collectionCursors.add(key);
          this.patch({ board, ...this.identityUpdate(result.data.identity) });
        }
      }
      return result;
    });
  }
  async boardPage(status_key, next) {
    const column = this.state.board?.columns.find(row => row.key === status_key);
    if (!column || (next && (!column.next_cursor || column.capacity_reached))) return;
    return this.refreshBoard(status_key, next ? column.next_cursor : undefined);
  }
  async filter(filters) { this.patch({ filters, page: null, board: null }); await this.refresh(); }
  async loadAssignees(next = false) {
    if (!this.state.binding || (next && !this.state.assignee_cursor)) return;
    const { result, current } = await this.request('assignees', { binding_id: this.state.binding.binding_id, ...(next ? { cursor: this.state.assignee_cursor } : {}) });
    if (current && result.ok) this.patch({ assignees: [...new Map([...(next ? this.state.assignees ?? [] : []), ...items(result.data)].map(row => [row.principal_id, row])).values()], assignee_cursor: nextCursor(result.data), assignees_has_more: Boolean(nextCursor(result.data)) });
    return result;
  }
  async loadLabels(next = false) {
    if (!this.state.binding || (next && !this.state.label_cursor)) return;
    const binding_id = this.state.binding.binding_id;
    const initialKey = `${binding_id}:labels:first`;
    if (this.labelFlights.has(initialKey)) return this.labelFlights.get(initialKey);
    if (next && this.state.labels.length >= ISSUE_COLLECTION_LIMIT) { const error = { code: 'PANEL_CAPACITY' }; this.patch({ error }); return { ok: false, error }; }
    if (!next) { this.labelRevision++; this.labelCursors.clear(); }
    const revision = this.labelRevision;
    const cursor = next ? this.state.label_cursor : undefined;
    const key = next ? `${binding_id}:${revision}:labels:${cursor}` : initialKey;
    if (next && this.labelCursors.has(key)) { const error = { code: 'PANEL_PAGINATION_STALLED' }; this.patch({ error }); return { ok: false, error }; }
    return this.collectionRequest(key, async () => {
      const { result, current } = await this.request('labels', { binding_id, ...(cursor ? { cursor } : {}) }, 'labels', () => this.state.binding?.binding_id === binding_id && this.labelRevision === revision);
      if (current && result.ok) {
        const labels = [...new Map([...(next ? this.state.labels : []), ...items(result.data)].map(row => [row.id, fields(row, ['id', 'name'])])).values()];
        const next_cursor = nextCursor(result.data);
        if (cursor && cursor === next_cursor) { const error = { code: 'PANEL_PAGINATION_STALLED' }; this.patch({ error }); return { ok: false, error }; }
        if (labels.length > ISSUE_COLLECTION_LIMIT || !this.collectionFits({ labels })) { const error = { code: 'PANEL_CAPACITY' }; this.patch({ error }); return { ok: false, error }; }
        if (next) this.labelCursors.add(key);
        this.patch({ labels, label_cursor: next_cursor, labels_has_more: Boolean(next_cursor) });
      }
      return result;
    }, this.labelFlights);
  }
  async setLocale(locale) {
    if (!this.state.binding || !this.canChangeBinding() || !['en', 'zh-CN'].includes(locale)) return;
    if (this.state.binding.identity.principal.locale === locale) return { ok: true, status: 200, data: { unchanged: true } };
    return this.mutate('set_locale', { locale });
  }
  loadedIssue(identifier) { return [...items(this.state.page), ...(this.state.board?.columns ?? []).flatMap(column => column.items)].find(row => row.identifier === identifier); }
  async quickUpdate(identifier, change) {
    if (!this.canChangeBinding() || this.state.pending) return;
    const subject = this.loadedIssue(identifier);
    if (!subject?.allowed_actions?.includes('update') || change.status_key === 'done') return;
    return this.mutate('update', change, false, subject);
  }
  async openIssue(identifier, signal) {
    if (signal?.aborted) return;
    const sameIssue = this.state.issue?.identifier === identifier;
    if (!sameIssue && (this.state.pending)) return;
    this.patch({ ...(sameIssue ? {} : { issue: null, comments: [] }) });
    const { result, current } = await this.request('detail', { binding_id: this.state.binding.binding_id, identifier }, undefined, undefined, signal);
    if (current && result.ok && !signal?.aborted) {
      const { identity, ...issue } = result.data;
      this.patch({ issue, comments: issue.comments ?? [], comment_cursor: null, comments_has_more: Boolean(issue.comment_continuation), ...this.identityUpdate(identity) });
    }
  }
  async comments(signal) {
    if (signal?.aborted) return;
    const identifier = this.state.issue.identifier;
    const { result, current } = await this.request('comments', { binding_id: this.state.binding.binding_id, identifier, ...(this.state.comment_cursor ? { cursor: this.state.comment_cursor } : {}) }, undefined, undefined, signal);
    if (current && result.ok && !signal?.aborted && this.state.issue?.identifier === identifier) {
      const comments = [...new Map([...this.state.comments, ...items(result.data)].map(row => [row.id, row])).values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      this.patch({ comments, comment_cursor: nextCursor(result.data), comments_has_more: Boolean(nextCursor(result.data)) });
    }
  }
  async mutate(operation, change, recover = false, subject = this.state.issue) {
    if (!recover && (this.state.pending || this.state.session_context_changed)) return;
    const pending = recover ? this.state.pending : { binding_id: this.state.binding.binding_id, ...(operation === 'set_locale' ? { expected_version: this.state.binding.identity.principal.version } : { identifier: subject.identifier, expected_version: subject.version }), operation, change, idempotency_key: this.makeKey() };
    if (!pending) return;
    this.patch({ pending });
    const { result } = await this.request(recover ? 'recover' : 'mutate', pending, 'write');
    const recovery = result.outcome_unknown || result.panel?.recovery_required || ['PANEL_REQUEST_UNCERTAIN', 'PANEL_OPERATION_PENDING'].includes(result.error?.code) || (recover && !result.ok && result.panel?.original_settled !== true);
    this.patch({ pending: recovery ? pending : null, ...(result.panel?.readback && pending.operation === 'set_locale' ? this.identityUpdate(result.panel.readback) : result.panel?.readback && this.state.issue?.identifier === pending.identifier ? { issue: result.panel.readback, comments: result.panel.readback.comments ?? [], comment_cursor: null, comments_has_more: Boolean(result.panel.readback.comment_continuation) } : {}) });
    if (result.ok && !recovery) await this.refresh();
    return result;
  }
}

export const PanelController = WorkbenchController;
