import { randomUUID } from 'node:crypto';
import { PANEL_PROTOCOL, PanelError, record, uuid, identifier, boundedText, canonical, STATUSES, PRIORITIES, scopeFailureCode, canCreateIssue, milestoneSummary } from './shared.mjs';
import { readWorkspaceScope } from './scope.mjs';
import { validateCheckpoint } from './checkpoint.mjs';

const ok = data => ({ ok: true, status: 200, data });
const fail = (code, message, details = {}) => ({ ok: false, status: 400, error: { code, message, details } });
const operationPending = operation => operation.running || !operation.settled || (operation.result?.ok && !operation.readback);
const operationResult = (operation, result, readback = operation.readback ?? null) => ({ ...result, panel: { readback, recovery_required: !operation.settled || (operation.stage === 'sent' && !readback), original_settled: operation.settled, write_stage: operation.stage, idempotency_key: operation.original.idempotency_key } });
const dataOf = result => {
  if (!result?.ok) throw new PanelError(result?.error?.code ?? 'PANEL_FOUNDATION_UNAVAILABLE', result?.error?.message ?? 'cfKanban foundation is unavailable.', result?.error?.details ?? {});
  return result.data;
};

export function assertLocalHost({ singleUserLocal, webHost, hasWebServer, operator }, peer) {
  if (singleUserLocal !== true || !operator || peer !== operator || (hasWebServer && webHost !== '127.0.0.1')) {
    throw new PanelError('PANEL_LOCAL_HOST_REQUIRED', 'Use an explicitly enabled single-user local runtime. Remote and multi-user Hosts are unsupported.');
  }
}

export class WorkbenchBridge {
  constructor({ createFacade, host, sessionContext, directory, directoryReader, scopeReader = readWorkspaceScope, now = Date.now, timeoutMs = 30000 }) {
    this.createFacade = createFacade;
    this.host = host;
    this.sessions = sessionContext;
    this.directory = directory;
    this.directoryReader = directoryReader;
    this.scopeReader = scopeReader;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.bindings = new Map();
    this.replacement = null;
    this.lifetime = new AbortController();
  }

  dispose() {
    this.lifetime.abort();
    this.bindings.clear();
    this.replacement = null;
  }

  async call(endpoint, payload, signal, peer) {
    try {
      assertLocalHost(this.host, peer);
      const input = record(payload, ['protocol', 'input'], ['protocol', 'input']);
      if (input.protocol !== PANEL_PROTOCOL) throw new PanelError('PANEL_VERSION_MISMATCH', 'Rebuild or reinstall the matching cfKanban panel and foundation.');
      const combined = AbortSignal.any([signal ?? new AbortController().signal, this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)]);
      combined.throwIfAborted();
      return await this.dispatch(endpoint, input.input, combined);
    } catch (error) {
      if (error instanceof PanelError) return { ...fail(error.code, error.message, error.details), ...((error.details.outcome_unknown || (endpoint === 'recover' && error.code === 'PANEL_BINDING_EXPIRED')) ? { outcome_unknown: true } : {}) };
      return { ...fail('PANEL_REQUEST_UNCERTAIN', 'Request interrupted or unavailable. A write may have committed; retain its original key and recover explicitly.'), ...(['mutate', 'recover'].includes(endpoint) ? { outcome_unknown: true } : {}) };
    }
  }

  facade(binding) {
    const value = this.createFacade(binding ? { binding: { instance_id: binding.instance_id, expected_principal_id: binding.principal_id, project_ids: [binding.project_id] } } : undefined);
    if (!value || typeof value.callTool !== 'function') throw new PanelError('PANEL_FOUNDATION_UNAVAILABLE', 'Install the matching cfKanban MCP foundation in this Host environment.');
    return value;
  }

  binding(input) {
    uuid(input.binding_id, 'binding_id');
    const binding = this.bindings.get(input.binding_id);
    if (!binding || (this.now() - binding.created > 8 * 60 * 60 * 1000 && !this.hasPending(binding))) throw new PanelError('PANEL_BINDING_EXPIRED', 'Select and verify your Instance, Principal and Project again.');
    if (this.replacement?.next === input.binding_id) {
      this.requireCleanReplacement();
      // 新引用的首次请求证明客户端已经收到绑定；旧引用请求不能确认交付。
      this.bindings.delete(this.replacement.previous);
      this.replacement = null;
    }
    return binding;
  }

  requireCleanReplacement() {
    if (this.replacement && [this.replacement.previous, this.replacement.next].some(id => { const binding = this.bindings.get(id); return binding && this.hasPending(binding); })) throw new PanelError('PANEL_OPERATION_PENDING', 'Resolve the retained operation before changing the binding.');
  }

  discardUnconfirmedReplacement() {
    if (!this.replacement) return;
    this.requireCleanReplacement();
    this.bindings.delete(this.replacement.next);
    this.replacement = null;
  }

  hasPending(binding) {
    if (!binding) return [...this.bindings.values()].some(value => this.hasPending(value));
    return [...binding.operations.values()].some(operationPending);
  }

  acceptsCheckpoint(value) {
    const checkpoint = validateCheckpoint(value);
    if (!checkpoint) return false;
    const pending = [...this.bindings].flatMap(([binding_id, binding]) => [...binding.operations.values()].filter(operationPending).map(operation => ({ binding_id, operation })));
    if (!pending.length) return true;
    if (pending.length !== 1 || checkpoint.state.binding?.binding_id !== pending[0].binding_id || !checkpoint.state.pending) return false;
    return canonical(checkpoint.state.pending) === canonical(pending[0].operation.original);
  }

  async tool(binding, name, args, signal) {
    const result = await this.facade(binding).callTool(name, { instance_id: binding.instance_id, ...args }, { signal });
    if (name === 'cfkanban_issues_get' && result.ok && result.data?.project?.id !== binding.project_id) throw new PanelError('PANEL_SCOPE_DENIED', 'The Issue is outside the bound Project.');
    return result;
  }

  async discovery(input, name, args, signal) {
    uuid(input.instance_id, 'instance_id');
    uuid(input.expected_principal_id, 'expected_principal_id');
    const binding = { instance_id: input.instance_id, principal_id: input.expected_principal_id, project_id: args.project_id };
    const facade = this.createFacade({ binding: { instance_id: binding.instance_id, expected_principal_id: binding.principal_id, project_ids: args.project_id ? [args.project_id] : [] } });
    return facade.callTool(name, { instance_id: input.instance_id, ...args }, { signal });
  }

  async rowPermissions(binding, signal) {
    const identity = dataOf(await this.tool(binding, 'cfkanban_connection_inspect', {}, signal));
    const principal = identity.principal;
    return { identity, writer: principal?.is_owner === true || principal?.grants?.some(grant => grant.workspace_id === binding.workspace_id && grant.project_id === binding.project_id && ['owner', 'writer'].includes(grant.role)) };
  }

  rowActions(rows, writer) {
    return rows.map(row => ({ ...row, allowed_actions: ['read', ...(writer && !row.deleted_at ? ['update'] : [])] }));
  }

  async dispatch(endpoint, input, signal) {
    if (endpoint === 'workspace_scope') {
      record(input, []);
      return ok(await this.workspaceScope(signal));
    }
    if (endpoint === 'session_scope') {
      record(input, ['session_id'], ['session_id']);
      return ok(await this.sessionScope(input.session_id, signal));
    }
    if (endpoint === 'scope_targets') {
      record(input, ['session_id', 'instance_id', 'offset']);
      if (input.instance_id !== undefined) uuid(input.instance_id, 'instance_id');
      const scope = input.session_id === undefined ? await this.workspaceScope(signal) : await this.sessionScope(input.session_id, signal);
      if (scope.status !== 'configured') throw new PanelError('PANEL_SCOPE_UNAVAILABLE', 'The Workspace recommendation is unavailable. Select a Project manually.');
      const targets = scope.targets.filter(target => input.instance_id === undefined || target.instance_id === input.instance_id);
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > targets.length) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid recommendation page.');
      const page = targets.slice(offset, offset + 8);
      const items = await Promise.all(page.map(async target => {
        try {
          const identity = dataOf(await this.facade().callTool('cfkanban_connection_inspect', { instance_id: target.instance_id }, { signal }));
          const binding = { ...target, principal_id: identity.principal?.principal_id ?? identity.principal?.id };
          uuid(binding.principal_id, 'principal');
          const project = dataOf(await this.tool(binding, 'cfkanban_projects_get', { workspace_id: target.workspace_id, project_id: target.project_id }, signal));
          return { ...target, display_name: project.display_name, available: true };
        } catch (error) { return { ...target, available: false, unavailability: scopeFailureCode(error.code) }; }
      }));
      return ok({ items, next_offset: offset + page.length < targets.length ? offset + page.length : null });
    }
    if (endpoint === 'bind_scope') {
      record(input, ['session_id', 'target'], ['target']);
      record(input.target, ['instance_id', 'workspace_id', 'project_id'], ['instance_id', 'workspace_id', 'project_id']);
      Object.entries(input.target).forEach(([key, value]) => uuid(value, key));
      const scope = input.session_id === undefined ? await this.workspaceScope(signal) : await this.sessionScope(input.session_id, signal);
      if (scope.status !== 'configured' || !scope.targets.some(target => canonical(target) === canonical(input.target))) throw new PanelError('PANEL_SCOPE_TARGET_UNAVAILABLE', 'The selected Project is no longer recommended by this Workspace. Select it manually.');
      const identity = dataOf(await this.facade().callTool('cfkanban_connection_inspect', { instance_id: input.target.instance_id }, { signal }));
      const principal_id = identity.principal?.principal_id ?? identity.principal?.id;
      uuid(principal_id, 'principal');
      return this.dispatch('bind', { ...input.target, expected_principal_id: principal_id }, signal);
    }
    if (endpoint === 'connections') {
      record(input, []);
      return this.facade().callTool('cfkanban_connection_inspect', {}, { signal });
    }
    if (endpoint === 'identity') {
      record(input, ['instance_id'], ['instance_id']);
      uuid(input.instance_id, 'instance_id');
      return this.facade().callTool('cfkanban_connection_inspect', input, { signal });
    }
    if (endpoint === 'workspaces' || endpoint === 'projects') {
      record(input, ['instance_id', 'expected_principal_id', 'workspace_id', 'cursor', 'limit'], ['instance_id', 'expected_principal_id', ...(endpoint === 'projects' ? ['workspace_id'] : [])]);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid discovery page size.');
      const args = { limit };
      if (input.cursor !== undefined) args.cursor = boundedText(input.cursor, 4096, 'cursor');
      if (endpoint === 'projects') args.workspace_id = uuid(input.workspace_id, 'workspace_id');
      return this.discovery(input, endpoint === 'projects' ? 'cfkanban_projects_list' : 'cfkanban_workspaces_list', args, signal);
    }
    if (endpoint === 'bind') {
      record(input, ['instance_id', 'expected_principal_id', 'workspace_id', 'project_id', 'replace_binding_id'], ['instance_id', 'expected_principal_id', 'workspace_id', 'project_id']);
      Object.entries(input).forEach(([key, value]) => uuid(value, key));
      const previous = input.replace_binding_id ? this.binding({ binding_id: input.replace_binding_id }) : null;
      if (previous && (previous.instance_id !== input.instance_id || previous.principal_id !== input.expected_principal_id)) throw new PanelError('PANEL_SCOPE_DENIED', 'Project switching must retain the verified identity.');
      if (previous && this.hasPending(previous)) throw new PanelError('PANEL_OPERATION_PENDING', 'Resolve the retained operation before changing the binding.');
      this.requireCleanReplacement();
      if (this.bindings.size - Number(Boolean(this.replacement)) >= 128) throw new PanelError('PANEL_CAPACITY', 'Close and restart this panel Host before binding more Projects.');
      const binding = { instance_id: input.instance_id, principal_id: input.expected_principal_id, project_id: input.project_id, workspace_id: input.workspace_id, created: this.now(), operations: new Map() };
      const identity = dataOf(await this.tool(binding, 'cfkanban_connection_inspect', {}, signal));
      if ((identity.principal?.principal_id ?? identity.principal?.id) !== binding.principal_id) throw new PanelError('PANEL_IDENTITY_CHANGED', 'The Host identity changed. Select it again.');
      const project = dataOf(await this.tool(binding, 'cfkanban_projects_get', { workspace_id: binding.workspace_id, project_id: binding.project_id }, signal));
      const statuses = dataOf(await this.tool(binding, 'cfkanban_statuses_list', { workspace_id: binding.workspace_id, project_id: binding.project_id }, signal));
      binding.statuses = [...new Map((Array.isArray(statuses) ? statuses : statuses.items ?? statuses.statuses ?? []).filter(row => STATUSES.includes(row.key)).map(row => [row.key, row])).values()].slice(0, STATUSES.length);
      binding.trusted_api_origin = identity.instance?.trusted_api_origin;
      const binding_id = randomUUID();
      signal.throwIfAborted();
      if (previous && this.bindings.get(input.replace_binding_id) !== previous) throw new PanelError('PANEL_BINDING_EXPIRED', 'The previous Project binding is no longer available.');
      if (previous && this.hasPending(previous)) throw new PanelError('PANEL_OPERATION_PENDING', 'Resolve the retained operation before changing the binding.');
      this.requireCleanReplacement();
      if (this.bindings.size - Number(Boolean(this.replacement)) >= 128) throw new PanelError('PANEL_CAPACITY', 'Close and restart this panel Host before binding more Projects.');
      this.discardUnconfirmedReplacement();
      this.bindings.set(binding_id, binding);
      if (previous) this.replacement = { previous: input.replace_binding_id, next: binding_id };
      return ok({ binding_id, identity, project, statuses, local_only: true });
    }
    if (endpoint === 'unbind') {
      record(input, ['binding_id'], ['binding_id']);
      const binding = this.binding(input);
      if (this.hasPending(binding)) throw new PanelError('PANEL_OPERATION_PENDING', 'Resolve the retained operation before changing the binding.', { outcome_unknown: true });
      if (this.replacement?.previous === input.binding_id) this.discardUnconfirmedReplacement();
      this.bindings.delete(input.binding_id);
      return ok({ unbound: true });
    }
    if (endpoint === 'list') {
      record(input, ['binding_id', 'status', 'priority', 'assignment', 'cursor'], ['binding_id']);
      const binding = this.binding(input);
      const args = { project_ids: [binding.project_id], limit: 25 };
      if (input.status) { if (!STATUSES.includes(input.status)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid status.'); args.status = [input.status]; }
      if (input.priority) { if (!PRIORITIES.includes(input.priority)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid priority.'); args.priority = [input.priority]; }
      if (input.assignment === 'mine') args.assignee = [binding.principal_id];
      else if (input.assignment !== undefined && input.assignment !== 'all') throw new PanelError('PANEL_INVALID_INPUT', 'Invalid assignment.');
      if (input.cursor) args.cursor = boundedText(input.cursor, 4096, 'cursor');
      const { identity, writer } = await this.rowPermissions(binding, signal);
      const page = await this.tool(binding, 'cfkanban_issues_list', args, signal);
      if (!page.ok) return page;
      return { ...page, data: { ...page.data, items: this.rowActions(page.data.items ?? [], writer), identity } };
    }
    if (endpoint === 'board') {
      record(input, ['binding_id', 'status_key', 'priority', 'assignment', 'cursor'], ['binding_id']);
      const binding = this.binding(input);
      const columns = binding.statuses;
      const selected = input.status_key === undefined ? columns : columns.filter(row => row.key === input.status_key);
      if (!selected.length || (input.status_key !== undefined && !STATUSES.includes(input.status_key)) || (input.cursor !== undefined && input.status_key === undefined)) throw new PanelError('PANEL_INVALID_INPUT', 'Select a current Project status for column pagination.');
      const args = { project_ids: [binding.project_id], limit: 25 };
      if (input.priority) { if (!PRIORITIES.includes(input.priority)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid priority.'); args.priority = [input.priority]; }
      if (input.assignment === 'mine') args.assignee = [binding.principal_id];
      else if (input.assignment !== undefined && input.assignment !== 'all') throw new PanelError('PANEL_INVALID_INPUT', 'Invalid assignment.');
      if (input.cursor !== undefined) args.cursor = boundedText(input.cursor, 4096, 'cursor');
      const result = [];
      const { identity, writer } = await this.rowPermissions(binding, signal);
      for (const column of selected) {
        const page = dataOf(await this.tool(binding, 'cfkanban_issues_list', { ...args, status: [column.key] }, signal));
        result.push({ key: column.key, display_name: column.display_name, items: this.rowActions(Array.isArray(page) ? page : page.items ?? [], writer), next_cursor: page.next_cursor ?? page.continuation?.next_cursor ?? null });
      }
      return ok({ columns: result, identity });
    }
    if (endpoint === 'assignees' || endpoint === 'labels' || endpoint === 'milestones') {
      record(input, ['binding_id', 'cursor'], ['binding_id']);
      const binding = this.binding(input);
      const result = await this.tool(binding, endpoint === 'labels' ? 'cfkanban_labels_list' : endpoint === 'milestones' ? 'cfkanban_milestones_list' : 'cfkanban_assignees_list', { workspace_id: binding.workspace_id, project_id: binding.project_id, limit: 20, ...(input.cursor === undefined ? {} : { cursor: boundedText(input.cursor, 4096, 'cursor') }) }, signal);
      if (endpoint === 'milestones' && result.ok) {
        const scope = result.data?.resolved_scope;
        const candidates = Array.isArray(result.data) ? result.data : result.data?.items;
        if (!Array.isArray(candidates)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid milestone candidates.');
        for (const row of candidates) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid milestone candidate.');
          milestoneSummary(row);
        }
        if ((scope?.project_id !== undefined && scope.project_id !== binding.project_id)
          || (scope?.workspace_id !== undefined && scope.workspace_id !== binding.workspace_id)
          || candidates.some(row => row.project_id !== undefined && row.project_id !== binding.project_id || row.workspace_id !== undefined && row.workspace_id !== binding.workspace_id)) {
          throw new PanelError('PANEL_SCOPE_DENIED', 'The milestones are outside the bound Project.');
        }
      }
      return result;
    }
    if (endpoint === 'detail' || endpoint === 'comments') {
      record(input, ['binding_id', 'identifier', 'cursor'], ['binding_id', 'identifier']);
      const binding = this.binding(input);
      const args = { identifier: identifier(input.identifier) };
      if (endpoint === 'comments') { args.limit = 25; if (input.cursor) args.cursor = boundedText(input.cursor, 4096, 'cursor'); }
      if (endpoint === 'comments') return this.tool(binding, 'cfkanban_comments_list', args, signal);
      const identity = dataOf(await this.tool(binding, 'cfkanban_connection_inspect', {}, signal));
      const detail = await this.tool(binding, 'cfkanban_issues_get', args, signal);
      return detail.ok ? { ...detail, data: { ...detail.data, identity } } : detail;
    }
    if (endpoint === 'mutate' || endpoint === 'recover') return this.mutate(endpoint, input, signal);
    throw new PanelError('PANEL_UNKNOWN_OPERATION', 'This panel operation is unavailable.');
  }

  async sessionScope(sessionId, signal) {
    if (!this.sessions) throw new PanelError('PANEL_SESSION_UNAVAILABLE', 'This runtime has no Session context.');
    boundedText(sessionId, 128, 'Session');
    const workspace = this.sessions.workspaces().find(row => row.sessionIds.includes(sessionId));
    if (!workspace) throw new PanelError('PANEL_SESSION_UNAVAILABLE', 'Open an accessible Session before reading its Workspace recommendation.');
    const verified = await this.verifySession(workspace.id, sessionId, signal);
    const scope = await this.scopeReader({ workspacePath: verified.path }, { signal });
    return { ...scope, source: 'workspace', source_session_id: sessionId, source_workspace_id: workspace.id };
  }

  async workspaceScope(signal) {
    const scope = this.directoryReader ? await this.directoryReader({ signal }) : await this.scopeReader({ workspacePath: this.directory }, { signal });
    return { ...scope, source: 'directory' };
  }

  async verifiedTarget(binding_id, signal, identifierValue) {
    const binding = this.binding({ binding_id });
    const identity = dataOf(await this.tool(binding, 'cfkanban_connection_inspect', {}, signal));
    dataOf(await this.tool(binding, 'cfkanban_projects_get', { workspace_id: binding.workspace_id, project_id: binding.project_id }, signal));
    if (identifierValue !== undefined) dataOf(await this.tool(binding, 'cfkanban_issues_get', { identifier: identifier(identifierValue) }, signal));
    return { instance_id: binding.instance_id, principal_id: binding.principal_id, workspace_id: binding.workspace_id, project_id: binding.project_id, trusted_api_origin: identity.instance?.trusted_api_origin, ...(identifierValue === undefined ? {} : { identifier: identifierValue }) };
  }

  async mutate(endpoint, input, signal) {
    record(input, ['binding_id', 'identifier', 'operation', 'expected_version', 'idempotency_key', 'change'], ['binding_id', 'operation', 'idempotency_key', 'change']);
    const binding = this.binding(input);
    const profile = input.operation === 'set_locale';
    const create = input.operation === 'create';
    if (profile || create) { if (Object.hasOwn(input, 'identifier') || create && Object.hasOwn(input, 'expected_version')) throw new PanelError('PANEL_INVALID_INPUT', 'This operation does not accept an Issue identifier or creation version.'); }
    else identifier(input.identifier);
    uuid(input.idempotency_key, 'idempotency_key');
    if (!create && (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid version.');
    const change = input.change;
    let name;
    if (profile) {
      record(change, ['locale'], ['locale']);
      if (!['en', 'zh-CN'].includes(change.locale)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid language preference.');
      name = 'cfkanban_profile_locale_set';
    } else if (input.operation === 'update' || create) {
      record(change, create ? ['title', 'body', 'status_key', 'priority_key'] : ['title', 'body', 'status_key', 'priority_key', 'assignee_principal_id', 'milestone_id'], create ? ['title'] : []);
      if (!Object.keys(change).length || (change.status_key !== undefined && (!STATUSES.includes(change.status_key) || change.status_key === 'done')) || (change.priority_key !== undefined && !PRIORITIES.includes(change.priority_key))) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid Issue change.');
      if (change.assignee_principal_id !== undefined && change.assignee_principal_id !== null) uuid(change.assignee_principal_id, 'assignee');
      if (change.milestone_id !== undefined && change.milestone_id !== null) uuid(change.milestone_id, 'milestone');
      if (change.title !== undefined) boundedText(change.title, 256, 'title');
      if (change.body !== undefined && (typeof change.body !== 'string' || new TextEncoder().encode(change.body).length > 65_536)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid Issue body.');
      name = create ? 'cfkanban_issues_create' : 'cfkanban_issues_update';
    } else if (['label_add', 'label_remove'].includes(input.operation)) {
      record(change, ['label_id'], ['label_id']);
      uuid(change.label_id, 'label');
      name = input.operation === 'label_add' ? 'cfkanban_issues_labels_add' : 'cfkanban_issues_labels_remove';
    } else if (input.operation === 'comment') {
      record(change, ['body'], ['body']);
      boundedText(change.body, 32768, 'comment');
      name = 'cfkanban_comments_create';
    } else if (input.operation === 'complete') {
      record(change, ['summary', 'verification', 'artifacts', 'follow_ups'], ['summary']);
      boundedText(change.summary, 8192, 'summary', true);
      for (const key of ['verification', 'follow_ups']) if (change[key] !== undefined && (!Array.isArray(change[key]) || change[key].length > 50 || change[key].some(value => typeof value !== 'string' || value.length > (key === 'follow_ups' ? 2048 : 1024)))) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid completion evidence.');
      if (change.artifacts !== undefined && (!Array.isArray(change.artifacts) || change.artifacts.length > 50)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid artifacts.');
      for (const artifact of change.artifacts ?? []) { record(artifact, ['kind', 'value'], ['kind', 'value']); if (!['url', 'commit', 'path', 'other'].includes(artifact.kind)) throw new PanelError('PANEL_INVALID_INPUT', 'Invalid artifact kind.'); boundedText(artifact.value, 2048, 'artifact'); }
      name = 'cfkanban_issues_complete';
    } else throw new PanelError('PANEL_INVALID_INPUT', 'Invalid operation.');
    const args = { ...(profile ? {} : create ? { workspace_id: binding.workspace_id, project_id: binding.project_id } : { identifier: input.identifier }), idempotency_key: input.idempotency_key, ...(input.operation === 'update' ? { expected_version: input.expected_version, changes: change } : create || input.operation === 'comment' ? change : { expected_version: input.expected_version, ...change }) };
    const readCurrent = async () => {
      if (!create) return this.tool(binding, profile ? 'cfkanban_connection_inspect' : 'cfkanban_issues_get', profile ? {} : { identifier: input.identifier }, signal);
      const identity = await this.tool(binding, 'cfkanban_connection_inspect', {}, signal);
      if (!identity.ok) return identity;
      const project = await this.tool(binding, 'cfkanban_projects_get', { workspace_id: binding.workspace_id, project_id: binding.project_id }, signal);
      if (!project.ok) return project;
      const createdIdentifier = operation?.result?.ok ? operation.result.data?.resource?.identifier : null;
      if (createdIdentifier) return this.tool(binding, 'cfkanban_issues_get', { identifier: identifier(createdIdentifier) }, signal);
      return { ...project, data: { ...project.data, allowed_actions: canCreateIssue(identity.data.principal, binding) ? ['create_issue'] : [] } };
    };
    const fingerprint = canonical({ name, args });
    let operation = binding.operations.get(input.idempotency_key);
    if (operation && (operation.fingerprint !== fingerprint || canonical(operation.original) !== canonical(input))) throw new PanelError('PANEL_KEY_REUSED', 'The original key belongs to a different operation.');
    if (endpoint === 'recover' && !operation) throw new PanelError('PANEL_RECOVERY_UNAVAILABLE', 'This Host no longer holds the original operation. Inspect the Issue before acting again.', { outcome_unknown: true });
    if (!operation) {
      if (binding.operations.size >= 64) {
        const settled = [...binding.operations].find(([, item]) => !operationPending(item));
        if (!settled) throw new PanelError('PANEL_CAPACITY', 'Resolve pending operations before starting another write.');
        binding.operations.delete(settled[0]);
      }
      // 预读也会被 pagehide/超时取消；先保留完整原请求，才能证明未发送并显式恢复。
      operation = { fingerprint, original: structuredClone(input), args: structuredClone(args), name, stage: 'not_sent', settled: false };
      binding.operations.set(input.idempotency_key, operation);
    }
    if (operation.running) throw new PanelError('PANEL_OPERATION_PENDING', 'This operation is already running.');
    if (operation.settled && operation.result) {
      const current = await readCurrent();
      if (!current.ok) return operation.stage === 'not_sent' ? operationResult(operation, current, null) : current;
      operation.readback = current.data;
      operation.result = operationResult(operation, operation.result);
      return operation.result;
    }
    operation.running = true;
    try {
      const original = operation.original;
      if (operation.stage === 'not_sent') {
        try {
          signal.throwIfAborted();
          const preflight = await readCurrent();
          signal.throwIfAborted();
          if (!preflight.ok) {
            operation.settled = preflight.status >= 400 && preflight.status < 500 && !preflight.outcome_unknown;
            operation.result = operationResult(operation, { ...preflight, outcome_unknown: false });
            return operation.result;
          }
          const resource = profile ? preflight.data.principal : preflight.data;
          if (profile && (resource?.principal_id ?? resource?.id) !== binding.principal_id) throw new PanelError('PANEL_IDENTITY_CHANGED', 'The Host identity changed. Select it again.');
          if (!profile && !resource.allowed_actions?.includes(create ? 'create_issue' : 'update')) throw new PanelError('PANEL_PERMISSION_DENIED', 'Refresh the resource and verify writer permission.');
          if (!create && original.operation !== 'comment' && resource?.version !== original.expected_version) throw new PanelError('PANEL_VERSION_CONFLICT', 'The resource changed. Refresh and review it before starting another operation.', { current_version: resource?.version });
        } catch (error) {
          operation.settled = error instanceof PanelError && ['PANEL_PERMISSION_DENIED', 'PANEL_VERSION_CONFLICT', 'PANEL_SCOPE_DENIED'].includes(error.code);
          operation.result = operationResult(operation, operation.settled ? fail(error.code, error.message, error.details) : fail('PANEL_REQUEST_UNCERTAIN', 'Permission pre-read interrupted or unavailable. No write was sent; recover the original request explicitly.'));
          return operation.result;
        }
      } else if (endpoint === 'recover') {
        const current = await readCurrent();
        if (!current.ok) return current;
      }
      signal.throwIfAborted();
      // 标记后视为可能发送；任何中断都只能沿原参数/key核实，不推断远端未提交。
      operation.stage = 'sent';
      delete operation.readback;
      const result = await this.tool(binding, operation.name, operation.args, signal);
      operation.result = result;
      operation.settled = result.ok || (endpoint === 'mutate' && result.status >= 400 && result.status < 500 && !result.outcome_unknown);
      const readback = await readCurrent();
      if (readback.ok) operation.readback = readback.data;
      operation.result = operationResult(operation, result, readback.ok ? readback.data : null);
      return operation.result;
    } finally { operation.running = false; }
  }

  async verifySession(workspaceId, sessionId, signal) {
    const workspace = this.sessions?.workspace(workspaceId);
    if (!workspace || !workspace.sessionIds.includes(sessionId)) throw new PanelError('PANEL_SESSION_UNAVAILABLE', 'Select an accessible Session in the explicit Workspace.');
    const inspection = await this.sessions.inspect(sessionId, signal);
    if (inspection.meta?.cwd !== workspace.path) throw new PanelError('PANEL_WORKSPACE_CHANGED', 'The Session no longer belongs to the selected Workspace.');
    return workspace;
  }
}

export const PanelBridge = WorkbenchBridge;
