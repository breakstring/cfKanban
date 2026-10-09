import { randomUUID } from 'node:crypto';
import { WorkbenchBridge } from '../../local-runtime/src/workbench/bridge.mjs';
import { WorkbenchController } from '../../local-runtime/src/workbench/controller.mjs';
import { WorkbenchAdapter } from '../../local-runtime/src/workbench/embed-adapter.mjs';
import { parseActionMessage } from '../../../apps/web/src/embedded/protocol.ts';
import cfKanbanNavSvg from '../../../apps/web/src/assets/cfkanban-mark.svg';

export const VIEW_ID_META = 'cfkanban/viewId';
export const SNAPSHOT_META = 'cfkanban/snapshot';
export const ACTION_RECEIPT_META = 'cfkanban/actionReceipt';
export const WORKBENCH_TOOL_NAMES = Object.freeze(['cfkanban_workbench_open', 'cfkanban_workbench_global_open', 'cfkanban_workbench_snapshot', 'cfkanban_workbench_action', 'cfkanban_workbench_release']);
export const WORKBENCH_MIME = 'text/html;profile=mcp-app';
const IDLE_MS = 8 * 60 * 60 * 1000;
const emptyObject = { type: 'object', properties: {}, required: [], additionalProperties: false };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const uuid = { ...text(36), pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' };
const identifier = { ...text(64), pattern: '^[A-Z][A-Z0-9]{1,11}-[1-9][0-9]{0,14}$' };
const targetSchema = object({ instance_id: uuid, workspace_id: uuid, project_id: uuid });
const initialIdentifier = { ...text(19), pattern: '^CFK-[1-9][0-9]{0,14}$' };
const explicitTargetSchema = object({ ...targetSchema.properties, identifier: initialIdentifier }, targetSchema.required);
const repositoryKeySchema = { type: 'string', pattern: '^[0-9a-f]{64}$', minLength: 64, maxLength: 64 };
const threadOpenSchema = { ...object({ target: explicitTargetSchema, recommended_targets: { type: 'array', items: targetSchema, minItems: 1, maxItems: 50, uniqueItems: true }, repository_key: repositoryKeySchema }, []), not: { required: ['target', 'recommended_targets'] } };
const enumeration = values => ({ type: 'string', enum: values });
const statuses = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
const priorities = ['none', 'low', 'medium', 'high', 'urgent'];
const next = object({ next: { type: 'boolean' } });
const issueFields = { title: text(256), body: text(65536, 0), status_key: enumeration(statuses.filter(key => key !== 'done')), priority_key: enumeration(priorities) };
const change = { ...object({ ...issueFields, assignee_principal_id: { anyOf: [uuid, { type: 'null' }] }, milestone_id: { anyOf: [uuid, { type: 'null' }] } }, []), minProperties: 1 };
const stringList = maxLength => ({ type: 'array', items: text(maxLength), maxItems: 50 });
const payloads = {
  scope_retry: emptyObject, scope_page: next, scope_bind: object({ target_id: text(160) }), manual: emptyObject,
  select_instance: object({ instance_id: uuid }), workspaces: object({ next: { type: 'boolean' } }, []),
  select_workspace: object({ workspace_id: uuid, next: { type: 'boolean' } }, ['workspace_id']), bind: object({ project_id: uuid }), unbind: emptyObject,
  project_menu: object({ workspace_id: uuid, next: { type: 'boolean' } }, []), project_switch: object({ workspace_id: uuid, project_id: uuid }),
  filters: object({ assignment: enumeration(['all', 'mine', 'unassigned']), status: enumeration(['', ...statuses]), priority: enumeration(['', ...priorities]) }),
  page: next, view: object({ mode: enumeration(['list', 'board']) }), board_page: object({ status_key: enumeration(statuses), next: { type: 'boolean' } }),
  board_group: object({ status_key: enumeration(statuses), expanded: { type: 'boolean' } }), assignees: next, labels: next, milestones: next,
  set_locale: object({ locale: enumeration(['en', 'zh-CN']) }), quick_update: object({ identifier, change }), create_issue: object({ change: object(issueFields, ['title']) }), open_issue: object({ identifier }), issue_back: emptyObject, comments: emptyObject,
  mutate: { oneOf: [
    object({ operation: { const: 'update' }, change }),
    object({ operation: enumeration(['label_add', 'label_remove']), change: object({ label_id: uuid }) }),
    object({ operation: { const: 'comment' }, change: object({ body: text(32768) }) }),
    object({ operation: { const: 'complete' }, change: object({ summary: text(8192, 0), verification: stringList(1024), follow_ups: stringList(2048), artifacts: { type: 'array', maxItems: 50, items: object({ kind: enumeration(['commit', 'other', 'path', 'url']), value: text(2048) }) } }, ['summary']) }),
  ] },
  recover: emptyObject,
};
const actionSchema = { oneOf: Object.entries(payloads).map(([action, payload]) => object({ type: { const: 'action' }, id: uuid, action: { const: action }, payload })) };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactEmpty = value => plain(value) && Object.keys(value).length === 0;
const validUuid = value => typeof value === 'string' && value.length === 36 && new RegExp(uuid.pattern).test(value);
const validTarget = value => plain(value) && Object.keys(value).length === 3 && ['instance_id', 'workspace_id', 'project_id'].every(key => Object.hasOwn(value, key) && validUuid(value[key]));
const validExplicitTarget = value => plain(value) && Object.keys(value).every(key => ['instance_id', 'workspace_id', 'project_id', 'identifier'].includes(key))
  && validTarget(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'identifier')))
  && (!Object.hasOwn(value, 'identifier') || typeof value.identifier === 'string' && value.identifier.length <= initialIdentifier.maxLength && new RegExp(initialIdentifier.pattern).test(value.identifier) && Number.isSafeInteger(Number(value.identifier.slice(4))));
const canonicalTarget = value => Object.fromEntries(['instance_id', 'workspace_id', 'project_id'].map(key => [key, value[key].toLowerCase()]));
function validThreadOpen(value) {
  if (!plain(value) || Object.keys(value).some(key => !['target', 'recommended_targets', 'repository_key'].includes(key))) return false;
  if (Object.hasOwn(value, 'repository_key') && (typeof value.repository_key !== 'string' || value.repository_key.length !== 64 || !/^[0-9a-f]{64}$/.test(value.repository_key))) return false;
  if (Object.hasOwn(value, 'target')) return !Object.hasOwn(value, 'recommended_targets') && validExplicitTarget(value.target);
  if (!Object.hasOwn(value, 'recommended_targets')) return true;
  const targets = value.recommended_targets;
  return Array.isArray(targets) && targets.length > 0 && targets.length <= 50 && targets.every(validTarget)
    && new Set(targets.map(target => ['instance_id', 'workspace_id', 'project_id'].map(key => target[key].toLowerCase()).join(':'))).size === targets.length;
}
const failure = (code, outcome_unknown = false) => ({ ok: false, error: { code }, ...(outcome_unknown ? { outcome_unknown: true } : {}) });
const cfKanbanNavIcon = `data:image/svg+xml;base64,${Buffer.from(cfKanbanNavSvg, 'utf8').toString('base64')}`;

export const workbenchResourceUri = (version, revision = 'source') => `ui://cfkanban/workbench/${encodeURIComponent(version)}/${encodeURIComponent(revision)}/index.html`;
export function workbenchTools(version, revision) {
  const resourceUri = workbenchResourceUri(version, revision);
  return [
    ...WORKBENCH_TOOL_NAMES.slice(0, 2).map((name, index) => ({ name, title: 'cfKanban', description: index ? 'Open a global cfKanban workbench. Reverify the remembered identity and Project or select an accessible default; opening does not write business data.' : 'Open an isolated cfKanban conversation workbench. Supply an explicit or saved directory target, or recommended_targets resolved by the Agent from the current repository. To open an exact Issue detail, supply target with verified instance_id, workspace_id, project_id and identifier; an Issue never selects a default or recommended Project. Optional repository_key from scope inspection restores and remembers only this repository\'s last Project. Otherwise open an accessible default. Identities and access are reverified; opening does not write business data.', icons: [{ src: cfKanbanNavIcon, mimeType: 'image/svg+xml', sizes: ['20x20'] }], inputSchema: index ? emptyObject : threadOpenSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: { ui: { resourceUri }, 'openai/ui': { entrypoints: [{ type: index ? 'global' : 'thread' }] } } })),
    ...WORKBENCH_TOOL_NAMES.slice(2).map((name, index) => ({ name, description: ['Read a view snapshot and optional action receipt.', 'Perform one validated workbench UI action; uncertain writes retain their original request for explicit recovery.', 'Release a view only when no request or uncertain operation remains.'][index], inputSchema: index === 1 ? object({ view_id: uuid, message: actionSchema }) : index === 0 ? object({ view_id: uuid, action_id: uuid }, ['view_id']) : object({ view_id: uuid }), annotations: { readOnlyHint: index === 0, destructiveHint: false, idempotentHint: true, openWorldHint: index === 1 }, _meta: { ui: { visibility: ['app'] } } })),
  ];
}

class McpWorkbenchController extends WorkbenchController {
  async request(endpoint, input, channel, matches, signal) {
    const signals = [signal, this.callerSignal].filter(Boolean);
    return super.request(endpoint, input, channel, matches, signals.length ? AbortSignal.any(signals) : undefined);
  }
}

class McpWorkbenchAdapter extends WorkbenchAdapter {
  constructor(controller, selectProject, options) {
    super(controller, null, undefined, options);
    this.selectProject = selectProject;
  }
  async dispatch(action, payload) {
    const result = await super.dispatch(action, payload);
    if (action === 'select_instance') await this.selectProject(payload.instance_id);
    return result;
  }
}

export class McpWorkbench {
  constructor({ createFacade, preferences, version = 'source', now = Date.now, maxViews = 128, idleMs = IDLE_MS } = {}) {
    if (typeof createFacade !== 'function' || !Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > 128 || !Number.isFinite(idleMs) || idleMs < 1 || idleMs > IDLE_MS) throw new Error('Invalid trusted workbench options');
    this.createFacade = createFacade;
    this.preferences = preferences;
    this.version = version;
    this.now = now;
    this.maxViews = maxViews;
    this.idleMs = idleMs;
    this.views = new Map();
    this.disposed = false;
  }
  pending(view) { return Boolean(view.controller.state.pending) || view.bridge.hasPending(); }
  busy(view) { return view.running || view.adapter.running || view.controller.state.busy > 0; }
  disposeView(viewId, view) {
    view.adapter.dispose();
    view.controller.dispose();
    view.bridge.dispose();
    view.lifetime.abort();
    this.views.delete(viewId);
  }
  prune() {
    for (const [viewId, view] of this.views) if (this.now() - view.touched >= this.idleMs && !this.busy(view) && !this.pending(view)) this.disposeView(viewId, view);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [viewId, view] of this.views) this.disposeView(viewId, view);
  }
  result(result, view, viewId, actionId) {
    const publicResult = { ok: result?.ok === true, protocol: 1, version: this.version, ...(result?.error?.code ? { error: { code: result.error.code } } : {}), ...(result?.outcome_unknown ? { outcome_unknown: true } : {}) };
    const receipt = view && actionId ? view.adapter.receipts.get(actionId)?.result : null;
    const actionReceipt = actionId ? { id: actionId, result: receipt ? { ok: receipt.ok === true, ...(receipt.error?.code ? { error: { code: receipt.error.code } } : {}), ...(receipt.outcome_unknown ? { outcome_unknown: true } : {}) } : null } : null;
    return { content: [{ type: 'text', text: JSON.stringify(publicResult) }], structuredContent: publicResult, isError: !publicResult.ok, ...(view ? { _meta: { ...(viewId ? { [VIEW_ID_META]: viewId } : {}), [SNAPSHOT_META]: view.adapter.snapshotMessage(), ...(actionReceipt ? { [ACTION_RECEIPT_META]: actionReceipt } : {}) } } : {}) };
  }
  async withCaller(view, signal, operation) {
    view.running = true;
    view.controller.callerSignal = signal;
    try { return await operation(); }
    finally { view.controller.callerSignal = undefined; view.running = false; }
  }
  async rememberProject(view) {
    if (!view.global && !view.repository_key || view.controller.state.error || !this.preferences) return;
    const binding = view.bridge.bindings.get(view.controller.state.binding?.binding_id);
    if (!binding) return;
    const target = { instance_id: binding.instance_id, principal_id: binding.principal_id, workspace_id: binding.workspace_id, project_id: binding.project_id };
    const fingerprint = JSON.stringify(target);
    if (fingerprint === view.savedTarget) return;
    try { if (await this.preferences.save(target, view.repository_key)) view.savedTarget = fingerprint; } catch { /* 偏好失败不影响已验证的工作台。 */ }
  }
  async openTarget(controller, target, signal, expectedPrincipal) {
    controller.patch({ scope_instance_id: target.instance_id });
    await controller.selectInstance(target.instance_id, signal);
    if (!controller.state.identity || controller.state.error || signal?.aborted) return;
    if (expectedPrincipal && controller.identityInput().expected_principal_id !== expectedPrincipal) {
      controller.patch({ error: { code: 'PANEL_IDENTITY_CHANGED' } });
      return;
    }
    controller.patch({ workspace_id: target.workspace_id });
    await controller.bind(target.project_id, signal);
    if (!target.identifier || !controller.state.binding || controller.state.error || signal?.aborted) return;
    await controller.openIssue(target.identifier, signal);
    if (controller.state.error || signal?.aborted) return;
    const issue = controller.state.issue;
    if (issue?.identifier !== target.identifier || issue?.project?.id !== target.project_id || issue?.workspace?.id !== target.workspace_id) {
      controller.patch({ issue: null, comments: [], error: { code: 'PANEL_SCOPE_DENIED' } });
    }
  }
  async selectThreadProject(view, initial, signal) {
    const controller = view.controller;
    if (initial.target) {
      await this.openTarget(controller, initial.target, signal);
      await this.rememberProject(view);
      return;
    }
    const remembered = view.repository_key ? await this.preferences?.load(view.repository_key).catch(() => null) : null;
    let pinned;
    if (remembered) {
      await controller.loadCandidates();
      if (controller.state.error || signal?.aborted) return;
      if (controller.state.candidates.some(candidate => candidate.instance_id === remembered.instance_id)) {
        await this.openTarget(controller, remembered, signal, remembered.principal_id);
        if (controller.state.binding) { await this.rememberProject(view); return; }
        if (!['NOT_FOUND', 'FORBIDDEN', 'PANEL_SCOPE_DENIED', 'PANEL_PERMISSION_DENIED'].includes(controller.state.error?.code)) return;
        pinned = remembered;
      }
    }
    if (!initial.recommended_targets) {
      if (pinned) controller.patch({ error: null });
      else {
        await controller.bootstrap(null);
        if (!controller.state.error && !controller.state.identity && controller.state.candidates.length === 1) {
          await controller.selectInstance(controller.state.candidates[0].instance_id, signal);
          if (controller.state.identity) await controller.loadWorkspaces();
        }
      }
      await this.selectGlobalProject(view, null, signal);
      return;
    }
    const principals = new Map(pinned ? [[pinned.instance_id, pinned.principal_id]] : []);
    for (const target of initial.recommended_targets) {
      if (pinned && target.instance_id !== pinned.instance_id) continue;
      await this.openTarget(controller, target, signal, principals.get(target.instance_id));
      if (controller.state.identity) principals.set(target.instance_id, controller.identityInput().expected_principal_id);
      if (controller.state.binding) { await this.rememberProject(view); return; }
      if (signal?.aborted || !['NOT_FOUND', 'FORBIDDEN', 'PANEL_SCOPE_DENIED', 'PANEL_PERMISSION_DENIED'].includes(controller.state.error?.code)) return;
    }
  }
  async selectGlobalProject(view, remembered, signal) {
    const controller = view.controller;
    if (!controller.state.identity || controller.state.error || signal?.aborted) return;
    const identity = controller.identityInput();
    if (remembered && identity.instance_id === remembered.instance_id && identity.expected_principal_id !== remembered.principal_id) {
      controller.patch({ error: { code: 'PANEL_IDENTITY_CHANGED' } });
      return;
    }
    if (remembered && identity.instance_id === remembered.instance_id && identity.expected_principal_id === remembered.principal_id) {
      await controller.selectWorkspace(remembered.workspace_id);
      if (!controller.state.error) await controller.bind(remembered.project_id, signal);
      if (signal?.aborted) return;
      if (controller.state.binding) { await this.rememberProject(view); return; }
      // 只有目标失效或无权访问允许选新目标；认证漂移和网络错误保留诊断。
      if (!['NOT_FOUND', 'FORBIDDEN', 'PANEL_SCOPE_DENIED', 'PANEL_PERMISSION_DENIED'].includes(controller.state.error?.code)) return;
      controller.patch({ error: null });
    }
    if (!controller.state.workspaces.length) await controller.loadWorkspaces();
    if (controller.state.error || signal?.aborted) return;
    for (const workspace of controller.state.workspaces.slice(0, 8)) {
      await controller.selectWorkspace(workspace.id ?? workspace.workspace_id);
      if (controller.state.error || signal?.aborted) return;
      const project = controller.state.projects[0];
      if (!project) continue;
      await controller.bind(project.id ?? project.project_id, signal);
      if (signal?.aborted) return;
      if (controller.state.binding) { await this.rememberProject(view); return; }
      if (controller.state.error) return;
    }
  }
  async selectInstanceProject(view, instanceId, signal) {
    const controller = view.controller;
    if (!controller.state.identity || controller.state.error || !controller.canChangeBinding() || signal?.aborted) return;
    if (controller.identityInput().instance_id !== instanceId) {
      controller.patch({ error: { code: 'PANEL_IDENTITY_CHANGED' } });
      return;
    }
    const remembered = view.global || view.repository_key ? await this.preferences?.load(view.repository_key).catch(() => null) : null;
    await this.selectGlobalProject(view, remembered?.instance_id === instanceId ? remembered : null, signal);
  }
  async open(signal, global = false, initial = {}) {
    this.prune();
    if (this.views.size >= this.maxViews) return this.result(failure('PANEL_CAPACITY'));
    if (signal?.aborted) return this.result(failure('PANEL_REQUEST_UNCERTAIN'));
    const operator = {};
    const lifetime = new AbortController();
    const recommendations = initial.recommended_targets;
    // Agent 解析的稳定 ID 只是当前视图的推荐，不能让 MCP 进程读取客户端路径或据此授权。
    const directoryReader = async () => recommendations ? { status: 'configured', code: 'SCOPE_CONFIGURED', targets: structuredClone(recommendations) } : { status: 'unavailable', code: 'SCOPE_WORKSPACE_UNAVAILABLE', targets: [] };
    const bridge = new WorkbenchBridge({ createFacade: this.createFacade, host: { singleUserLocal: true, hasWebServer: false, operator }, directoryReader, now: this.now });
    const controller = new McpWorkbenchController({ call: async (endpoint, payload, requestSignal) => ({ ok: true, value: await bridge.call(endpoint, payload, requestSignal, operator) }) }, lifetime.signal);
    const adapter = new McpWorkbenchAdapter(controller, instanceId => this.selectInstanceProject(view, instanceId, controller.callerSignal), { now: this.now });
    const view = { bridge, controller, adapter, lifetime, touched: this.now(), running: false, global, repository_key: initial.repository_key, savedTarget: null };
    let viewId;
    // 此 UUID 只路由到当前进程中的对象，身份与权限仍由私有绑定和 Service 验证。
    do { viewId = randomUUID(); } while (this.views.has(viewId));
    this.views.set(viewId, view);
    try {
      await this.withCaller(view, signal, async () => {
        if (initial.target || recommendations || initial.repository_key) {
          await this.selectThreadProject(view, initial, signal);
          return;
        }
        await controller.bootstrap(null);
        const remembered = global ? await this.preferences?.load().catch(() => null) : null;
        const candidates = controller.state.candidates;
        const preferred = remembered && candidates.find(candidate => candidate.instance_id === remembered.instance_id);
        if (!controller.state.error && !controller.state.identity && (preferred || candidates.length === 1)) {
          await controller.selectInstance(preferred?.instance_id ?? candidates[0].instance_id, signal);
          if (controller.state.identity) await controller.loadWorkspaces();
        }
        await this.selectGlobalProject(view, remembered, signal);
      });
    }
    catch { controller.patch({ error: { code: 'PANEL_REQUEST_UNCERTAIN' } }); }
    if (this.disposed) return this.result(failure('PANEL_REQUEST_UNCERTAIN'));
    if (signal?.aborted) {
      this.disposeView(viewId, view);
      return this.result(failure('PANEL_REQUEST_UNCERTAIN'));
    }
    return this.result(initial.target?.identifier && controller.state.error ? failure(controller.state.error.code) : { ok: true }, view, viewId);
  }
  async callTool(name, args = {}, { signal } = {}) {
    if (!WORKBENCH_TOOL_NAMES.includes(name)) return null;
    if (this.disposed) return this.result(failure('PANEL_BINDING_EXPIRED'));
    if (name === WORKBENCH_TOOL_NAMES[0]) {
      if (!validThreadOpen(args)) return this.result(failure('MCP_INVALID_ARGUMENTS'));
      const initial = { ...args, ...(args.target ? { target: { ...canonicalTarget(args.target), ...(args.target.identifier ? { identifier: args.target.identifier } : {}) } } : {}), ...(args.recommended_targets ? { recommended_targets: args.recommended_targets.map(canonicalTarget) } : {}) };
      return this.open(signal, false, initial);
    }
    if (name === WORKBENCH_TOOL_NAMES[1]) return exactEmpty(args) ? this.open(signal, true) : this.result(failure('MCP_INVALID_ARGUMENTS'));
    const isAction = name === 'cfkanban_workbench_action';
    const isSnapshot = name === 'cfkanban_workbench_snapshot';
    const allowed = isAction ? ['view_id', 'message'] : isSnapshot ? ['view_id', 'action_id'] : ['view_id'];
    if (!plain(args) || Object.keys(args).some(key => !allowed.includes(key)) || isAction && !parseActionMessage(args.message)) return this.result(failure('MCP_INVALID_ARGUMENTS'));
    const actionId = isSnapshot && Object.hasOwn(args, 'action_id') ? args.action_id : undefined;
    if (actionId !== undefined && !validUuid(actionId) || isSnapshot && Object.hasOwn(args, 'action_id') && actionId === undefined) return this.result(failure('MCP_INVALID_ARGUMENTS'));
    this.prune();
    const viewId = args.view_id;
    if (viewId === undefined) return this.result(failure('MCP_APP_VIEW_ID_MISSING'));
    if (!validUuid(viewId)) return this.result(failure('MCP_APP_VIEW_ID_INVALID'));
    const view = this.views.get(viewId);
    if (!view) return this.result(failure('PANEL_BINDING_EXPIRED'));
    view.touched = this.now();
    if (isSnapshot) return this.result({ ok: true }, view, undefined, actionId);
    if (name === 'cfkanban_workbench_release') {
      if (this.busy(view) || this.pending(view)) return this.result(failure('PANEL_OPERATION_PENDING', this.pending(view)), view);
      this.disposeView(viewId, view);
      return this.result({ ok: true });
    }
    let result;
    if (view.running) result = view.adapter.running || view.controller.state.busy > 0 ? await view.adapter.receive(args.message) : failure('PANEL_OPERATION_PENDING');
    else {
      if (signal?.aborted) return this.result(failure('PANEL_REQUEST_UNCERTAIN'), view, undefined, args.message.id);
      result = await this.withCaller(view, signal, () => view.adapter.receive(args.message));
      if (signal?.aborted && !result?.outcome_unknown) {
        const receipt = view.adapter.receipts.get(args.message.id);
        const canceled = failure('PANEL_REQUEST_UNCERTAIN', this.pending(view));
        if (receipt?.result === result) receipt.result = canceled;
        result = canceled;
        view.controller.patch({ error: canceled.error });
      }
    }
    if (result?.ok && ['bind', 'scope_bind', 'project_switch'].includes(args.message.action)) await this.rememberProject(view);
    return this.result(result ?? failure('PANEL_INVALID_INPUT'), view, undefined, args.message.id);
  }
}
