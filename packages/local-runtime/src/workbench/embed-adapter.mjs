import { EMBED_PROTOCOL, emptySnapshot, parseActionMessage, parseRenderedMessage, parseRenderTarget, parseSnapshotMessage, sameRenderTarget, snapshotRenderTarget } from '../../../../apps/web/src/embedded/protocol.ts';
import { readIssueHierarchy } from '../../../../apps/web/src/lib/issue-hierarchy.ts';
import { resolveLocalePreference } from '../../../../apps/web/src/lib/locale-preference.ts';
import { canonical, STATUSES, canCreateIssue } from './shared.mjs';
import { items, nextCursor, recoveryId, sessionReference } from './controller.mjs';

export const FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
const errorCodes = new Set(['PANEL_ONLINE_PENDING', 'PANEL_FRAME_RELOADED', 'PANEL_BINDING_EXPIRED', 'PANEL_CAPACITY', 'PANEL_CONTEXT_TOO_LARGE', 'PANEL_FOUNDATION_UNAVAILABLE', 'PANEL_EXECUTION_UNAVAILABLE', 'PANEL_HANDOFF_UNCERTAIN', 'PANEL_IDENTITY_CHANGED', 'PANEL_INVALID_INPUT', 'PANEL_KEY_REUSED', 'PANEL_LOCAL_HOST_REQUIRED', 'PANEL_OPERATION_PENDING', 'PANEL_PERMISSION_DENIED', 'PANEL_PREVIEW_EXPIRED', 'PANEL_RECOVERY_UNAVAILABLE', 'PANEL_REQUEST_UNCERTAIN', 'PANEL_SCOPE_DENIED', 'PANEL_SCOPE_TARGET_UNAVAILABLE', 'PANEL_SCOPE_UNAVAILABLE', 'PANEL_SESSION_UNAVAILABLE', 'PANEL_SESSION_CONTEXT_CHANGED', 'PANEL_VERSION_CONFLICT', 'PANEL_VERSION_MISMATCH', 'PANEL_WORKSPACE_CHANGED', 'MCP_LOCAL_STATE_UNAVAILABLE', 'MCP_PRINCIPAL_BINDING_MISMATCH', 'UNAUTHORIZED', 'FORBIDDEN', 'CAPABILITY_DENIED', 'NOT_FOUND', 'RATE_LIMITED', 'PLATFORM_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT', 'VERSION_CONFLICT', 'LABEL_ALREADY_ATTACHED', 'LABEL_NOT_ATTACHED', 'ISSUE_LABEL_LIMIT_REACHED', 'VALIDATION_ERROR', 'INPUT_VALIDATION_FAILED']);
const scopeCodes = new Set(['PANEL_SCOPE_PERMISSION_DENIED', 'PANEL_SCOPE_IDENTITY_CHANGED', 'PANEL_SCOPE_CREDENTIAL_UNAVAILABLE', 'PANEL_SCOPE_STALE', 'PANEL_SCOPE_TARGET_UNAVAILABLE', 'PANEL_SCOPE_HOST_UNAVAILABLE']);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key])).map(key => [key, value[key]]));
const resource = value => pick(value, ['id', 'instance_id', 'principal_id', 'display_name', 'title', 'name', 'trusted_api_origin', 'available']);
const identity = value => value ? { instance: resource(value.instance), principal: resource(value.principal) } : null;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const rows = value => Array.isArray(value) ? value : [];
const completion = value => value && typeof value === 'object' ? { ...pick(value, ['summary']), verification: strings(value.verification), artifacts: rows(value.artifacts).map(row => pick(row, ['kind', 'value'])), follow_ups: strings(value.follow_ups) } : undefined;
const labels = value => rows(value).map(row => pick(row, ['id', 'name']));
const issue = value => value ? { ...pick(value, ['id', 'identifier', 'title', 'body', 'version', 'priority', 'is_blocked']), ...(readIssueHierarchy(value.hierarchy) ? { hierarchy: readIssueHierarchy(value.hierarchy) } : {}), status: pick(value.status, ['key', 'display_name']), assignee: value.assignee ? resource(value.assignee) : null, labels: labels(value.labels), allowed_actions: strings(value.allowed_actions) } : null;
const comment = value => ({ ...pick(value, ['id', 'body', 'created_at', 'kind']), author: resource(value.author), ...(value.completion ? { completion: completion(value.completion) } : {}) });
const publicError = value => value ? { code: value.code === 'PANEL_PAGINATION_STALLED' || errorCodes.has(value.code) ? value.code : 'PANEL_REQUEST_UNCERTAIN' } : null;
export const scopeTargetId = value => `${value.instance_id}/${value.workspace_id}/${value.project_id}`;
const unavailable = (code = 'PANEL_INVALID_INPUT', outcome_unknown = false) => ({ ok: false, error: { code }, ...(outcome_unknown ? { outcome_unknown: true } : {}) });
const principal = state => state.binding?.identity?.principal ?? state.identity?.principal;
const preferredLocale = (state, fallback) => ['en', 'zh-CN'].includes(principal(state)?.locale) ? principal(state).locale : typeof fallback === 'string' ? resolveLocalePreference(null, [fallback]) : undefined;

export function projectSnapshot(state, sourceSessionId, fallbackLocale) {
  const writer = Boolean(state.binding && state.issue && strings(state.issue.allowed_actions).includes('update'));
  const pending = state.pending ? pick(state.pending, ['identifier', 'expected_version', 'operation']) : null;
  const workspaceId = state.binding?.project?.workspace_id ?? state.workspace_id;
  const locale = preferredLocale(state, fallbackLocale);
  return {
    ...(locale ? { locale } : {}), theme: principal(state)?.theme === 'blue' ? 'blue' : 'orange',
    candidates: rows(state.candidates).map(resource), identity: identity(state.identity), workspaces: rows(state.workspaces).map(resource), projects: rows(state.projects).map(resource),
    ...(workspaceId ? { workspace_id: workspaceId } : {}), workspace_has_more: Boolean(state.workspace_cursor), project_has_more: Boolean(state.project_cursor),
    project_menu_groups: rows(state.project_menu_groups).map(group => ({ workspace: resource(group.workspace), projects: rows(group.projects).map(resource), has_more: Boolean(group.project_cursor), error: publicError(group.error) })), project_menu_has_more: Boolean(state.project_menu_cursor), project_menu_error: publicError(state.project_menu_error),
    binding: state.binding ? { project: resource(state.binding.project), identity: identity(state.binding.identity), statuses: rows(items(state.binding.statuses)).map(value => pick(value, ['key', 'display_name'])) } : null,
    page: state.page ? { items: rows(items(state.page)).map(value => { const { body, ...row } = issue(value); return row; }), next_cursor: nextCursor(state.page) ? 'available' : null, capacity_reached: Boolean(state.page.capacity_reached) } : null,
    view: state.view, expanded_groups: state.expanded_groups ?? ['backlog'], board: state.binding ? { columns: STATUSES.filter(key => !state.filters.status || key === state.filters.status).map(key => {
      const column = state.board?.columns.find(column => column.key === key);
      const loading = state.group_states?.[key]?.loading ?? false;
      return { key, display_name: column?.display_name ?? items(state.binding.statuses).find(status => status.key === key)?.display_name ?? key, items: rows(column?.items).map(value => { const { body, ...row } = issue(value); return row; }), has_more: Boolean(column?.next_cursor), capacity_reached: Boolean(column?.capacity_reached), loaded: Boolean(column), loading, error: publicError(state.group_states?.[key]?.error) };
    }) } : null,
    assignees: rows(state.assignees).map(row => pick(row, ['id', 'principal_id', 'display_name'])), assignees_has_more: Boolean(state.assignees_has_more),
    labels: labels(state.labels), labels_has_more: Boolean(state.labels_has_more),
    issue: issue(state.issue), comments: rows(state.comments).map(comment), comments_has_more: Boolean(state.comments_has_more),
    filters: { assignment: state.filters.assignment, status: state.filters.status, priority: state.filters.priority }, busy: state.busy, error: publicError(state.error), pending,
    source_session_id: sessionReference(sourceSessionId), session_context_changed: Boolean(state.session_context_changed),
    workspace_scope: state.workspace_scope ? { status: state.workspace_scope.status } : null, scope_mode: state.scope_mode,
    scope_targets: rows(state.scope_targets).map(row => ({ id: scopeTargetId(row), ...pick(row, ['display_name', 'project_id']), available: Boolean(row.available), ...(row.available ? {} : { unavailability: scopeCodes.has(row.unavailability) ? row.unavailability : 'PANEL_SCOPE_TARGET_UNAVAILABLE' }) })),
    scope_next_offset: state.scope_next_offset, ...(scopeCodes.has(state.scope_fallback) ? { scope_fallback: state.scope_fallback } : {}),
    capabilities: { update: writer, comment: writer, complete: writer && state.issue?.status?.key !== 'done', create: canCreateIssue(principal(state), { ...state.binding, workspace_id: workspaceId }) },
    notice: 'single_user_local_host',
  };
}

export function connectOwnedFrame(frame, locale, channelFactory = () => new MessageChannel()) {
  if (!frame?.contentWindow) return null;
  const channel = channelFactory();
  frame.contentWindow.postMessage({ type: 'cfkanban.embed.connect', protocol: EMBED_PROTOCOL, locale }, '*', [channel.port2]);
  return channel.port1;
}

export class WorkbenchAdapter {
  constructor(controller, sourceSessionId = null, _navigate, { now = Date.now, receiptLimit = 256 } = {}) {
    this.controller = controller;
    this.sourceSessionId = sourceSessionId;
    this.now = now;
    this.receiptLimit = receiptLimit;
    this.receipts = new Map();
    this.attempts = [];
    this.running = false;
    this.disposed = false;
    this.renderWaiter = null;
    this.port = null;
    this.frameConnected = false;
    this.frameBlocked = false;
    this.locale = undefined;
    this.unsubscribe = controller.subscribe(() => this.publish());
    this.removeCollectionValidator = controller.addCollectionValidator?.(state => Boolean(parseSnapshotMessage({ type: 'snapshot', state: projectSnapshot(state, this.sourceSessionId, this.locale) })));
    this.onAbort = () => this.dispose();
    controller.signal.addEventListener('abort', this.onAbort, { once: true });
  }
  frameLoaded(frame, locale, channelFactory) {
    if (this.disposed || this.controller.signal.aborted) return false;
    if (this.frameConnected || this.frameBlocked) {
      this.frameBlocked = true;
      this.finishRendered(unavailable('PANEL_FRAME_RELOADED'));
      this.port?.close();
      this.port = null;
      this.controller.patch({ error: { code: 'PANEL_FRAME_RELOADED' } });
      return false;
    }
    this.locale = resolveLocalePreference(null, [locale]);
    const port = connectOwnedFrame(frame, preferredLocale(this.controller.state, this.locale), channelFactory);
    if (!port) return false;
    this.frameConnected = true;
    this.attach(port);
    return true;
  }
  setLocale(locale) { this.locale = resolveLocalePreference(null, [locale]); this.publish(); }
  attach(port) {
    if (this.port) this.finishRendered(unavailable('PANEL_RENDER_UNAVAILABLE'));
    this.port?.close();
    if (this.disposed || this.controller.signal.aborted || this.frameBlocked) { port.close(); return; }
    this.port = port;
    port.onmessage = event => { if (this.port === port) void this.receive(event.data); };
    port.start();
    this.publish();
  }
  snapshotMessage() {
    let message;
    try { message = { type: 'snapshot', state: projectSnapshot(this.controller.state, this.sourceSessionId, this.locale) }; }
    catch { message = null; }
    const locale = preferredLocale(this.controller.state, this.locale);
    return message && parseSnapshotMessage(message) ? message : { type: 'snapshot', state: { ...emptySnapshot(), ...(locale ? { locale } : {}), error: { code: 'PANEL_CONTEXT_TOO_LARGE' } } };
  }
  publish() {
    if (this.disposed || this.controller.signal.aborted || (!this.port && !this.renderWaiter)) return;
    const message = this.snapshotMessage();
    if (this.renderWaiter && !sameRenderTarget(snapshotRenderTarget(message.state), this.renderWaiter.target)) this.finishRendered(unavailable('PANEL_RENDER_TARGET_CHANGED'));
    if (!this.port) return;
    try {
      this.port.postMessage(message);
      const waiter = this.renderWaiter;
      if (!waiter) return;
      // 每份新快照都有新挑战；上一份快照的迟到确认不能完成当前等待。
      waiter.id = crypto.randomUUID();
      this.port.postMessage({ type: 'render_check', id: waiter.id, target: waiter.target });
    } catch { this.finishRendered(unavailable('PANEL_RENDER_UNAVAILABLE')); }
  }
  waitForRendered(target, { signal, timeoutMs = 5000 } = {}) {
    const parsedTarget = parseRenderTarget(target);
    if (!parsedTarget || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) return Promise.resolve(unavailable('PANEL_INVALID_INPUT'));
    if (this.disposed || this.controller.signal.aborted || this.frameBlocked) return Promise.resolve(unavailable('PANEL_RENDER_UNAVAILABLE'));
    if (signal?.aborted) return Promise.resolve(unavailable('PANEL_RENDER_ABORTED'));
    this.finishRendered(unavailable('PANEL_RENDER_REPLACED'));
    if (!sameRenderTarget(snapshotRenderTarget(this.snapshotMessage().state), parsedTarget)) return Promise.resolve(unavailable('PANEL_RENDER_TARGET_CHANGED'));
    return new Promise(resolve => {
      const waiter = { target: parsedTarget, resolve, id: null, signal, timer: null, abort: null };
      this.renderWaiter = waiter;
      waiter.abort = () => this.finishRendered(unavailable('PANEL_RENDER_ABORTED'), waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      waiter.timer = setTimeout(() => this.finishRendered(unavailable('PANEL_RENDER_TIMEOUT'), waiter), timeoutMs);
      this.publish();
    });
  }
  finishRendered(result, waiter = this.renderWaiter) {
    if (!waiter || waiter !== this.renderWaiter) return;
    this.renderWaiter = null;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (waiter.id && !result.ok) {
      try { this.port?.postMessage({ type: 'render_cancel', id: waiter.id }); } catch {}
    }
    waiter.resolve(result);
  }
  receiveRendered(message) {
    const waiter = this.renderWaiter;
    if (!waiter || message.id !== waiter.id || !sameRenderTarget(message.target, waiter.target)) return;
    if (!sameRenderTarget(snapshotRenderTarget(this.snapshotMessage().state), waiter.target)) {
      this.finishRendered(unavailable('PANEL_RENDER_TARGET_CHANGED'), waiter);
      return;
    }
    this.finishRendered({ ok: true, target: waiter.target, receipt_id: waiter.id }, waiter);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.finishRendered(unavailable('PANEL_RENDER_UNAVAILABLE'));
    this.port?.close();
    this.port = null;
    this.unsubscribe();
    this.removeCollectionValidator?.();
    this.controller.signal.removeEventListener('abort', this.onAbort);
  }
  async receive(raw) {
    if (this.disposed || this.controller.signal.aborted || this.frameBlocked) return;
    const rendered = parseRenderedMessage(raw);
    if (rendered) { this.receiveRendered(rendered); return; }
    if (raw?.type === 'rendered') return;
    const time = this.now();
    this.attempts = this.attempts.filter(at => time - at < 10_000);
    if (this.attempts.length >= 30) {
      const result = unavailable('RATE_LIMITED');
      const id = recoveryId(raw?.id);
      if (id) this.port?.postMessage({ type: 'result', id, result });
      return result;
    }
    this.attempts.push(time);
    const message = parseActionMessage(raw);
    if (!message) {
      const id = recoveryId(raw?.id);
      if (id) this.port?.postMessage({ type: 'result', id, result: unavailable() });
      return;
    }
    const send = result => { if (!this.controller.signal.aborted) this.port?.postMessage({ type: 'result', id: message.id, result }); return result; };
    const fingerprint = canonical({ action: message.action, payload: message.payload });
    const previous = this.receipts.get(message.id);
    if (previous) return send(previous.fingerprint !== fingerprint ? unavailable('PANEL_KEY_REUSED') : previous.result ?? unavailable('PANEL_OPERATION_PENDING', true));
    if (this.running || this.controller.state.busy) return send(unavailable('PANEL_OPERATION_PENDING'));
    if (this.receipts.size >= this.receiptLimit) {
      const evictable = [...this.receipts].find(([, value]) => value.result && !value.retain);
      if (evictable) this.receipts.delete(evictable[0]);
      else return send(unavailable('PANEL_CAPACITY'));
    }
    const receipt = { fingerprint, result: null, retain: ['mutate', 'quick_update', 'create_issue', 'set_locale', 'recover'].includes(message.action) };
    this.receipts.set(message.id, receipt);
    this.running = true;
    try {
      const operation = await this.dispatch(message.action, message.payload);
      const explicit = operation && typeof operation.ok === 'boolean';
      const error = publicError(explicit ? operation.error : this.controller.state.error);
      const unknown = explicit ? operation.outcome_unknown || operation.panel?.recovery_required || (operation.ok === false && Boolean(this.controller.state.pending)) : Boolean(this.controller.state.pending);
      receipt.result = { ok: explicit ? operation.ok : !error, ...(error ? { error } : {}), ...(unknown ? { outcome_unknown: true } : {}) };
    } catch {
      receipt.result = unavailable('PANEL_INVALID_INPUT');
    } finally { this.running = false; }
    this.publish();
    return send(receipt.result);
  }
  require(condition) { if (!condition) throw new Error('Unavailable embedded action'); }
  async dispatch(action, p) {
    const c = this.controller;
    const s = c.state;
    const changeable = c.canChangeBinding() && !s.busy;
    const bound = Boolean(s.binding);
    const clean = !s.pending && !s.session_context_changed;
    const currentIssue = bound && s.issue;
    const writer = currentIssue && strings(s.issue.allowed_actions).includes('update') && clean;
    switch (action) {
      case 'scope_retry': this.require(changeable && s.scope_mode === 'suggested'); return c.loadScopeTargets();
      case 'scope_page': this.require(changeable && s.scope_mode === 'suggested' && (!p.next || s.scope_next_offset !== null)); return c.loadScopeTargets(p.next ? s.scope_next_offset : 0);
      case 'scope_bind': { this.require(changeable && s.scope_mode === 'suggested'); const target = s.scope_targets.find(row => scopeTargetId(row) === p.target_id && row.available); this.require(target); return c.bindScope(target); }
      case 'manual': this.require(changeable); return c.useManual();
      case 'select_instance': this.require(changeable && s.candidates.some(row => row.instance_id === p.instance_id)); return c.selectInstance(p.instance_id);
      case 'workspaces': this.require(changeable && s.identity && (!p.next || s.workspace_cursor)); return c.loadWorkspaces(p.next ? s.workspace_cursor : undefined);
      case 'select_workspace': this.require(changeable && s.identity && (p.next ? s.workspace_id === p.workspace_id && s.project_cursor : s.workspaces.some(row => row.id === p.workspace_id))); return c.selectWorkspace(p.workspace_id, p.next ? s.project_cursor : undefined);
      case 'bind': this.require(changeable && s.identity && s.workspace_id && s.projects.some(row => row.id === p.project_id)); return c.bind(p.project_id);
      case 'project_menu': this.require(changeable && bound && (p.workspace_id ? rows(s.project_menu_groups).some(group => group.workspace.id === p.workspace_id && (!p.next || group.project_cursor)) : !p.next || s.project_menu_cursor)); return c.projectMenu(p.workspace_id, p.next);
      case 'project_switch': this.require(changeable && bound && rows(s.project_menu_groups).some(group => group.workspace.id === p.workspace_id && rows(group.projects).some(project => project.id === p.project_id))); return c.switchProject(p.workspace_id, p.project_id);
      case 'unbind': this.require(changeable); return c.unbind();
      case 'filters': this.require(bound && clean && ['all', 'mine'].includes(p.assignment)); return c.filter(p);
      case 'view': this.require(bound && clean && ['list', 'board'].includes(p.mode)); return c.setView(p.mode);
      case 'board_group': this.require(bound && clean && c.eligibleStatuses().includes(p.status_key)); return c.toggleGroup(p.status_key, p.expanded);
      case 'board_page': this.require(bound && c.eligibleStatuses().includes(p.status_key) && (!p.next || rows(s.board?.columns).some(column => column.key === p.status_key && column.next_cursor && !column.capacity_reached))); return c.boardPage(p.status_key, p.next);
      case 'assignees': this.require(bound && (!p.next || s.assignee_cursor)); return c.loadAssignees(p.next);
      case 'labels': this.require(bound && (!p.next || s.label_cursor)); return c.loadLabels(p.next);
      case 'set_locale': this.require(bound && clean); return c.setLocale(p.locale);
      case 'quick_update': { const subject = c.loadedIssue(p.identifier); this.require(bound && clean && subject && strings(subject.allowed_actions).includes('update') && p.change.status_key !== 'done' && (p.change.assignee_principal_id == null || rows(s.assignees).some(row => row.principal_id === p.change.assignee_principal_id))); return c.quickUpdate(p.identifier, p.change); }
      case 'create_issue': this.require(bound && clean && canCreateIssue(s.binding.identity.principal, { ...s.binding, workspace_id: s.workspace_id })); return c.mutate('create', p.change);
      case 'page': this.require(bound && !p.next); return c.refresh();
      case 'open_issue': this.require(bound && (s.issue?.identifier === p.identifier || (clean && [...items(s.page), ...rows(s.board?.columns).flatMap(column => rows(column.items))].some(row => row.identifier === p.identifier || row.hierarchy?.parents?.some(parent => parent.identifier === p.identifier && parent.project_id === s.binding.project.id))))); return c.openIssue(p.identifier);
      case 'issue_back': this.require(currentIssue && clean); return c.patch({ issue: null });
      case 'comments': this.require(currentIssue && s.comments_has_more); return c.comments();
      case 'mutate': this.require(writer && (p.operation !== 'complete' || s.issue.status.key !== 'done') && p.change.status_key !== 'done');
        if (p.operation === 'label_add') this.require(rows(s.labels).some(row => row.id === p.change.label_id) && !rows(s.issue.labels).some(row => row.id === p.change.label_id));
        if (p.operation === 'label_remove') this.require(rows(s.issue.labels).some(row => row.id === p.change.label_id));
        return c.mutate(p.operation, p.change);
      case 'recover': this.require(s.pending); return c.mutate(null, null, true);
      default: throw new Error('Unknown embedded action');
    }
  }
}

export const EmbedAdapter = WorkbenchAdapter;
