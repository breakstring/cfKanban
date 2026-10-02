import { PANEL_PROTOCOL, uuid, scopeFailureCode, isSessionReference } from './shared.mjs';
import { checkpointState, validateCheckpoint } from './checkpoint.mjs';

export const items = value => Array.isArray(value) ? value : value?.items ?? value?.statuses ?? [];
export const nextCursor = value => value?.next_cursor ?? value?.continuation?.next_cursor ?? null;
export const recoveryId = value => { try { return uuid(value, 'recovery identity'); } catch { return null; } };
export const sessionReference = value => isSessionReference(value) ? value : null;
export const ISSUE_COLLECTION_LIMIT = 1000;
const COLLECTION_BYTES = 1_048_576;
const MAX_COLLECTION_PAGES = 40;
const fields = (value, names) => Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, structuredClone(value[name])]));
const summary = value => ({ ...fields(value, ['id', 'identifier', 'title', 'version', 'priority', 'is_blocked']), status: fields(value.status, ['key', 'display_name']), assignee: value.assignee ? fields(value.assignee, ['id', 'principal_id', 'display_name', 'available']) : null, allowed_actions: Array.isArray(value.allowed_actions) ? [...value.allowed_actions] : [] });
function mergeRows(previous, incoming) {
  const result = new Map();
  for (const value of [...previous, ...incoming]) {
    const row = summary(value);
    const existing = result.get(row.identifier);
    if (!existing || row.version > existing.version) result.set(row.identifier, row);
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
    this.state = { candidates: [], identity: null, workspaces: [], projects: [], binding: null, view: initialView === 'list' ? 'list' : 'board', board: null, page: null, issue: null, comments: [], comment_cursor: null, filters: { assignment: 'all', status: '', priority: '' }, busy: 0, error: null, pending: null, source_session_id: null, session_context_changed: false, workspace_scope: null, scope_instance_id: null, scope_mode: 'manual', scope_targets: [], scope_next_offset: null };
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
    if (Object.hasOwn(update, 'binding') && this.state.binding?.binding_id !== update.binding?.binding_id) update = { assignees: [], assignee_cursor: null, assignees_has_more: false, ...update };
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
  collectionRequest(key, operation) {
    if (this.collectionFlights.has(key)) return this.collectionFlights.get(key);
    const request = operation().finally(() => { if (this.collectionFlights.get(key) === request) this.collectionFlights.delete(key); });
    this.collectionFlights.set(key, request);
    return request;
  }
  async request(endpoint, input, channel = endpoint, matches = () => true) {
    const revision = (this.revisions.get(channel) ?? 0) + 1;
    this.revisions.set(channel, revision);
    this.patch({ busy: this.state.busy + 1, error: null });
    const requestSignal = AbortSignal.any([this.signal, AbortSignal.timeout(this.requestTimeoutMs)]);
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
      const current = !this.signal.aborted && this.revisions.get(channel) === revision && matches();
      if (current && !result.ok) this.patch({ error: result.error });
      return { result, current };
    } catch {
      const result = { ok: false, outcome_unknown: ['mutate', 'recover'].includes(endpoint), error: { code: 'PANEL_REQUEST_UNCERTAIN', message: 'Request interrupted. Retain the original operation for explicit recovery.' } };
      if (!this.signal.aborted && this.revisions.get(channel) === revision && matches()) this.patch({ error: result.error });
      return { result, current: false };
    } finally { removeAbort(); this.patch({ busy: Math.max(0, this.state.busy - 1) }); }
  }
  canChangeBinding() { return !this.state.pending && !this.state.session_context_changed; }
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
  async selectInstance(instance_id) {
    if (!this.canChangeBinding()) return;
    if (this.state.scope_instance_id && instance_id !== this.state.scope_instance_id) { this.patch({ error: { code: 'PANEL_SCOPE_DENIED' } }); return; }
    this.patch({ identity: null, workspaces: [], projects: [], binding: null, page: null, board: null, issue: null, pending: null });
    const { result, current } = await this.request('identity', { instance_id });
    if (current && result.ok) this.patch({ identity: result.data });
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
  async bind(project_id) {
    if (!this.canChangeBinding()) return;
    const { result, current } = await this.request('bind', { ...this.identityInput(), workspace_id: this.state.workspace_id, project_id });
    if (current && result.ok) { this.patch({ binding: result.data, issue: null, page: null, board: null }); await this.refresh(); }
  }
  async unbind() {
    if (!this.canChangeBinding()) return false;
    if (this.state.binding) { const { result } = await this.request('unbind', { binding_id: this.state.binding.binding_id }); if (!result.ok) return false; }
    this.patch({ binding: null, page: null, board: null, issue: null, scope_mode: 'manual' });
    await this.loadCandidates();
    return true;
  }
  async refresh(cursor) {
    if (!this.state.binding) return;
    if (this.state.view === 'board') return this.refreshBoard();
    if (cursor && (cursor !== nextCursor(this.state.page) || this.state.page?.capacity_reached)) return;
    if (!cursor) this.invalidateCollections();
    const revision = this.collectionRevision;
    const key = `${revision}:list:${cursor ?? ''}`;
    if (cursor && this.collectionCursors.has(key)) { this.patch({ error: { code: 'PANEL_PAGINATION_STALLED' } }); return; }
    return this.collectionRequest(key, async () => {
      const { result, current } = await this.request('list', { binding_id: this.state.binding.binding_id, ...this.state.filters, ...(cursor ? { cursor } : {}) }, 'list', () => revision === this.collectionRevision && this.state.view === 'list');
      if (current && result.ok) {
        const merged = mergeRows(cursor ? items(this.state.page) : [], items(result.data));
        const pages = (cursor ? this.collectionPages.get('list') ?? 0 : 0) + 1;
        const page = { items: merged, next_cursor: nextCursor(result.data), capacity_reached: Boolean(nextCursor(result.data) && (merged.length >= ISSUE_COLLECTION_LIMIT || pages >= MAX_COLLECTION_PAGES)) };
        if (merged.length > ISSUE_COLLECTION_LIMIT || !this.collectionFits({ page })) {
          if (this.state.page) this.patch({ page: { ...this.state.page, capacity_reached: true } });
          else this.patch({ error: { code: 'PANEL_CONTEXT_TOO_LARGE' } });
          return { ok: false, error: { code: this.state.page ? 'PANEL_CAPACITY' : 'PANEL_CONTEXT_TOO_LARGE' } };
        } else {
          this.collectionPages.set('list', pages);
          if (cursor) this.collectionCursors.add(key);
          this.patch({ page });
        }
      }
      return result;
    });
  }
  async setView(view) { if (!['list', 'board'].includes(view) || !this.canChangeBinding()) return; this.patch({ view, page: null, board: null }); await this.refresh(); }
  async refreshBoard(status_key, cursor) {
    if (!this.state.binding || this.state.view !== 'board') return;
    const { assignment, priority, status } = this.state.filters;
    if (status_key && status && status_key !== status) return;
    const selectedStatus = status_key || status;
    const original = this.state.board?.columns.find(row => row.key === status_key);
    if (cursor && (cursor !== original?.next_cursor || original.capacity_reached)) return;
    if (!cursor) this.invalidateCollections();
    const revision = this.collectionRevision;
    const key = `${revision}:board:${selectedStatus ?? 'all'}:${cursor ?? ''}`;
    if (cursor && this.collectionCursors.has(key)) { this.patch({ error: { code: 'PANEL_PAGINATION_STALLED' } }); return; }
    return this.collectionRequest(key, async () => {
      const { result, current } = await this.request('board', { binding_id: this.state.binding.binding_id, assignment, priority, ...(selectedStatus ? { status_key: selectedStatus } : {}), ...(cursor ? { cursor } : {}) }, `board:${selectedStatus ?? 'all'}`, () => revision === this.collectionRevision && this.state.view === 'board');
      if (current && result.ok) {
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
          this.patch({ board });
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
  loadedIssue(identifier) { return [...items(this.state.page), ...(this.state.board?.columns ?? []).flatMap(column => column.items)].find(row => row.identifier === identifier); }
  async quickUpdate(identifier, change) {
    if (!this.canChangeBinding() || this.state.pending) return;
    const subject = this.loadedIssue(identifier);
    if (!subject?.allowed_actions?.includes('update') || change.status_key === 'done') return;
    return this.mutate('update', change, false, subject);
  }
  async openIssue(identifier) {
    const sameIssue = this.state.issue?.identifier === identifier;
    if (!sameIssue && (this.state.pending)) return;
    this.patch({ ...(sameIssue ? {} : { issue: null, comments: [] }) });
    const { result, current } = await this.request('detail', { binding_id: this.state.binding.binding_id, identifier });
    if (current && result.ok) {
      this.patch({ issue: result.data, comments: result.data.comments ?? [], comment_cursor: null, comments_has_more: Boolean(result.data.comment_continuation) });

    }
  }
  async comments() {
    const identifier = this.state.issue.identifier;
    const { result, current } = await this.request('comments', { binding_id: this.state.binding.binding_id, identifier, ...(this.state.comment_cursor ? { cursor: this.state.comment_cursor } : {}) });
    if (current && result.ok && this.state.issue?.identifier === identifier) {
      const comments = [...new Map([...this.state.comments, ...items(result.data)].map(row => [row.id, row])).values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      this.patch({ comments, comment_cursor: nextCursor(result.data), comments_has_more: Boolean(nextCursor(result.data)) });
    }
  }
  async mutate(operation, change, recover = false, subject = this.state.issue) {
    if (!recover && (this.state.pending || this.state.session_context_changed)) return;
    const pending = recover ? this.state.pending : { binding_id: this.state.binding.binding_id, identifier: subject.identifier, expected_version: subject.version, operation, change, idempotency_key: this.makeKey() };
    if (!pending) return;
    this.patch({ pending });
    const { result } = await this.request(recover ? 'recover' : 'mutate', pending, 'write');
    const recovery = result.outcome_unknown || result.panel?.recovery_required || ['PANEL_REQUEST_UNCERTAIN', 'PANEL_OPERATION_PENDING'].includes(result.error?.code) || (recover && !result.ok && result.panel?.original_settled !== true);
    this.patch({ pending: recovery ? pending : null, ...(result.panel?.readback && this.state.issue?.identifier === pending.identifier ? { issue: result.panel.readback, comments: result.panel.readback.comments ?? [], comment_cursor: null, comments_has_more: Boolean(result.panel.readback.comment_continuation) } : {}) });
    if (result.ok && !recovery) await this.refresh();
    return result;
  }
}

export const PanelController = WorkbenchController;
