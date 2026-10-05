import { rm } from 'node:fs/promises';
import path from 'node:path';
import { inspectScopeDirectory } from '../../skill-runtime/src/scope.mjs';
import { resolveWebInstance } from '../../skill-runtime/src/web-resolve.mjs';
import { validatePrivatePath } from '../../skill-runtime/src/state.mjs';
import { assertNoSymlinkPath, atomicWriteJson, canonicalDigest, pathType, readJson, requireUuid } from '../../skill-runtime/src/utils.mjs';
import { toolError } from '../../skill-runtime/src/errors.mjs';
import { commandFields } from './parser.mjs';

const issueQueries = new Set(['listIssues', 'listIssueCandidates']);
const unique = (items, field) => [...new Map(items.filter(item => item[field]).map(item => [item[field], item])).values()];
const compatible = (target, input) => (!input.instanceId || target.instance_id === input.instanceId)
  && (!input.workspace_id || target.workspace_id === input.workspace_id)
  && (!input.project_id || target.project_id === input.project_id);
const targetCompatible = (left, right) => ['instance_id', 'workspace_id', 'project_id'].every(field => !left[field] || !right[field] || left[field] === right[field]);

export function createContextResolver({ home, stateRoot, directory = process.cwd(), scopeInspector = inspectScopeDirectory, read }) {
  const contextRoot = path.join(stateRoot, 'cli-contexts');
  const privateBoundary = async () => {
    const relative = path.relative(path.resolve(home), path.resolve(stateRoot));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw toolError('UNSAFE_STATE_PATH', 'Context state must be a private child of home');
    await assertNoSymlinkPath(contextRoot, home);
    if (await pathType(stateRoot) !== 'missing') await validatePrivatePath(stateRoot, 'directory');
    if (await pathType(contextRoot) !== 'missing') await validatePrivatePath(contextRoot, 'directory');
  };
  const contextFile = (scopeDirectory, global) => path.join(contextRoot, global ? 'global.json' : `${canonicalDigest({ directory: scopeDirectory })}.json`);
  const readSaved = async (scopeDirectory, global = false) => {
    await privateBoundary();
    const file = contextFile(scopeDirectory, global);
    await assertNoSymlinkPath(file, home);
    if (await pathType(file) === 'missing') return null;
    await validatePrivatePath(file, 'file');
    const record = await readJson(file);
    if (record?.schema_version !== 1 || !record.target || record.scope_directory !== (global ? null : scopeDirectory)) throw toolError('CLI_CONTEXT_STALE', 'The saved context is invalid; clear it and select a target again');
    const target = Object.fromEntries(['instance_id', 'workspace_id', 'project_id'].map(field => [field, record.target[field] == null ? null : requireUuid(record.target[field], field)]));
    if (!target.instance_id || target.project_id && !target.workspace_id) throw toolError('CLI_CONTEXT_STALE', 'The saved context is incomplete');
    return target;
  };
  const inspect = async input => {
    const requestedDirectory = path.resolve(input.directory ?? directory);
    const detected = input.global ? { directory: requestedDirectory, scope_directory: requestedDirectory, scope_file: null, scope: null, git: { status: 'not_inspected', root: null } }
      : await scopeInspector({ directory: requestedDirectory });
    const local = input.global ? null : await readSaved(detected.scope_directory);
    // A global default outside this repository is irrelevant and must not interfere with its pinned targets.
    const global = !(detected.scope?.targets?.length) && !local || input.global ? await readSaved(detected.scope_directory, true) : null;
    return { detected, local, global };
  };
  const nextCommands = (name, kind, candidates) => candidates.map(target => `${name.startsWith('context ') ? 'cfkanban context use' : `cfkanban ${name}`} --instance ${target.instance_id}${kind !== 'instance' && target.workspace_id ? ` --workspace-id ${target.workspace_id}` : ''}${kind === 'project' ? ` --project-id ${target.project_id}` : ''}`);
  const choose = async (kind, candidates, name, select) => {
    if (candidates.length === 1) return candidates[0];
    const details = { kind, candidates, next_commands: nextCommands(name, kind, candidates) };
    if (!candidates.length) throw toolError('CLI_CONTEXT_UNAVAILABLE', 'No target is available; inspect connections or provide explicit scope', details);
    if (!select) throw toolError('CLI_CONTEXT_SELECTION_REQUIRED', 'Select an exact target from the available candidates', details);
    const selected = await select(details);
    const match = selected && candidates.find(candidate => canonicalDigest(candidate) === canonicalDigest(selected));
    if (!selected) throw toolError('CLI_SELECTION_CANCELLED', 'No candidate was selected');
    if (!match) throw toolError('CLI_CONTEXT_SELECTION_REQUIRED', 'Choose one of the provided candidates', details);
    return match;
  };
  const readTarget = async (instanceId, apiPath) => {
    const result = await read(instanceId, apiPath);
    if (!result.ok) throw Object.assign(toolError('CLI_CONTEXT_TARGET_REJECTED', 'The selected scope could not be verified'), { result });
    const data = result.data?.resource ?? result.data;
    const project = apiPath.match(/^\/api\/v1\/workspaces\/([^/?]+)\/projects\/([^/?]+)$/);
    if (project && (data?.id !== project[2] || data.workspace_id !== project[1])) throw toolError('CLI_CONTEXT_CONFLICT', 'The project does not belong to the selected workspace');
    const workspace = apiPath.match(/^\/api\/v1\/workspaces\/([^/?]+)$/);
    if (workspace && data?.id !== workspace[1]) throw toolError('CLI_CONTEXT_CONFLICT', 'The workspace response does not match the selected target');
    return data;
  };
  const list = async (instanceId, apiPath, workspaceId = null) => {
    const items = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor) query.set('cursor', cursor);
      const data = await readTarget(instanceId, `${apiPath}?${query}`);
      if (!Array.isArray(data?.items)) throw toolError('CLI_CONTEXT_UNAVAILABLE', 'The target list has an invalid response');
      for (const item of data.items) items.push({ instance_id: instanceId, ...(workspaceId ? { workspace_id: workspaceId, project_id: requireUuid(item.id, 'project_id') } : { workspace_id: requireUuid(item.id, 'workspace_id') }), display_name: item.display_name });
      if (!data.next_cursor) return items;
      if (typeof data.next_cursor !== 'string' || cursors.has(data.next_cursor)) throw toolError('CLI_CONTEXT_UNAVAILABLE', 'The candidate cursor is invalid; provide an explicit target');
      cursor = data.next_cursor; cursors.add(cursor);
    }
    throw toolError('CLI_CONTEXT_CANDIDATE_LIMIT', 'Too many candidates; provide an explicit workspace or project UUID');
  };
  const describe = (input, sources = {}, detected = null, origin = null) => ({
    instance_id: input.instanceId ?? null, workspace_id: input.workspace_id ?? null, project_id: input.project_id ?? null,
    source: Object.values(sources).find(source => source !== 'explicit') ?? 'explicit', sources,
    ...(origin ? { trusted_api_origin: origin } : {}), ...(detected ? { scope_directory: detected.scope_directory } : {}),
  });

  async function resolveTargets(original, { level = 'instance', select = null, name = 'context use', diagnostic = false, requireRepoMatch = false, forceInspect = false, query = false } = {}) {
    const input = { ...original };
    const sources = {};
    for (const [field, key] of [['instanceId', 'instance'], ['workspace_id', 'workspace'], ['project_id', 'project']]) if (input[field]) { requireUuid(input[field], field); sources[key] = 'explicit'; }
    const complete = input.instanceId && (level === 'instance' || input.workspace_id && (level !== 'project' || input.project_id));
    if (complete && !forceInspect && !query) return { input, resolved_context: describe(input, sources) };
    const { detected, local, global } = await inspect(input);
    if (['unknown', 'unavailable'].includes(detected.git.status)) {
      if (diagnostic) return { input, resolved_context: describe(input, sources, detected), detected, local, global, status: 'directory_unavailable' };
      throw toolError('CLI_CONTEXT_UNAVAILABLE', 'The working directory could not be inspected; use explicit IDs or make Git available', { git_status: detected.git.status });
    }
    const repository = input.global ? [] : detected.scope?.targets ?? [];
    let targets = repository.filter(target => compatible(target, input));
    if (requireRepoMatch && repository.length && !targets.length) throw toolError('CLI_CONTEXT_CONFLICT', 'The selected directory context is outside its repository scope');
    let saved = input.global ? global : local;
    let savedSource = input.global ? 'saved_global' : 'saved_directory';
    if (saved && compatible(saved, input)) {
      if (repository.length && !repository.some(target => targetCompatible(target, saved))) throw toolError('CLI_CONTEXT_STALE', 'The saved directory target is no longer associated; clear the context or select an explicit target');
    } else saved = null;
    if (!saved && !repository.length && global && compatible(global, input)) { saved = global; savedSource = 'saved_global'; }
    if (saved && targets.length) targets = targets.filter(target => targetCompatible(target, saved));
    const candidateIds = unique(targets, 'instance_id');
    if (!input.instanceId && saved) { input.instanceId = saved.instance_id; sources.instance = savedSource; }
    let instance;
    if (!input.instanceId && candidateIds.length) {
      const candidates = [];
      for (const target of candidateIds) {
        const result = await resolveWebInstance({ home, stateRoot, instanceId: target.instance_id, requireCurrentCredential: false });
        candidates.push(result.instance ?? result.candidates[0]);
      }
      if (diagnostic && candidates.length !== 1) return { input, resolved_context: describe(input, sources, detected), detected, local, global, status: 'selection_required', candidates };
      instance = await choose('instance', candidates, name, select);
      input.instanceId = instance.instance_id; sources.instance = 'repository';
    }
    const registered = await resolveWebInstance({ home, stateRoot, instanceId: input.instanceId ?? null, requireCurrentCredential: false });
    if (!input.instanceId) {
      if (diagnostic && registered.candidates.length !== 1) return { input, resolved_context: describe(input, sources, detected), detected, local, global, status: 'selection_required', candidates: registered.candidates };
      instance = await choose('instance', registered.candidates, name, select);
      input.instanceId = instance.instance_id; sources.instance = 'local_connection';
    } else instance = registered.instance ?? registered.candidates[0];
    if (!instance?.trusted_api_origin) throw toolError('CLI_CONTEXT_UNAVAILABLE', 'The selected instance has no registered trusted origin; inspect the connection', { kind: 'instance', candidates: instance ? [instance] : [], next_commands: ['cfkanban connection list'] });
    targets = targets.filter(target => target.instance_id === input.instanceId);
    if (saved && saved.instance_id !== input.instanceId) saved = null;
    for (const [field, key] of [['workspace_id', 'workspace'], ['project_id', 'project']]) {
      if (!input[field] && saved?.[field]) { input[field] = saved[field]; sources[key] = savedSource; }
      if (!input[field]) {
        const candidates = unique(targets, field);
        if (candidates.length === 1) { input[field] = candidates[0][field]; sources[key] = 'repository'; }
      }
    }
    if (level !== 'instance' && !input.workspace_id && !diagnostic) {
      const candidates = unique(targets, 'workspace_id');
      const available = candidates.length ? candidates : await list(input.instanceId, '/api/v1/workspaces');
      const chosen = await choose('workspace', available, name, select);
      input.workspace_id = chosen.workspace_id; sources.workspace = candidates.length ? 'repository' : 'service_unique';
    }
    if (input.workspace_id) targets = targets.filter(target => target.workspace_id === input.workspace_id);
    if (level === 'project' && !input.project_id && !diagnostic) {
      let candidates = unique(targets, 'project_id');
      if (candidates.length) {
        if (candidates.length > 20) throw toolError('CLI_CONTEXT_CANDIDATE_LIMIT', 'Too many repository targets; provide an explicit project');
        candidates = await Promise.all(candidates.map(async target => ({ ...target, display_name: (await readTarget(input.instanceId, `/api/v1/workspaces/${target.workspace_id}/projects/${target.project_id}`))?.display_name, trusted_api_origin: instance.trusted_api_origin })));
      } else candidates = await list(input.instanceId, `/api/v1/workspaces/${input.workspace_id}/projects`, input.workspace_id);
      const chosen = await choose('project', candidates, name, select);
      input.project_id = chosen.project_id; sources.project = targets.length ? 'repository' : 'service_unique';
    }
    if (input.project_id && !diagnostic && (level === 'project' || saved?.project_id)) await readTarget(input.instanceId, `/api/v1/workspaces/${input.workspace_id}/projects/${input.project_id}`);
    else if (input.workspace_id && !diagnostic && level === 'workspace') await readTarget(input.instanceId, `/api/v1/workspaces/${input.workspace_id}`);
    if (query && !input.project) {
      const projects = saved?.project_id ? targets.filter(target => target.project_id === saved.project_id) : targets;
      if (projects.length) {
        if (projects.length > 20) throw toolError('CLI_CONTEXT_CANDIDATE_LIMIT', 'Issue queries support at most 20 project filters; provide explicit filters');
        await Promise.all(projects.map(target => readTarget(input.instanceId, `/api/v1/workspaces/${target.workspace_id}/projects/${target.project_id}`)));
        input.project = [...new Set(projects.map(target => target.project_id))];
      } else if (saved?.project_id) input.project = [saved.project_id];
      else if (input.allowUnfiltered !== true) throw toolError('CLI_EXPLICIT_SCOPE_REQUIRED', 'Supply --project, associate this directory, or explicitly use --allow-unfiltered true');
    }
    return { input, resolved_context: { ...describe(input, sources, detected, instance.trusted_api_origin), ...(query && input.project ? { project_ids: input.project } : {}) }, detected, local, global, status: 'resolved' };
  }

  const resolve = async (command, input, options = {}) => {
    if (command.name === 'web open' && input.target) {
      if ((input.workspace_id || input.project_id) && (input.target.kind !== 'project'
        || input.workspace_id && input.workspace_id !== input.target.workspace_id
        || input.project_id && input.project_id !== input.target.project_id)) throw toolError('CLI_CONTEXT_CONFLICT', 'Choose a single consistent board target');
    }
    if (command.name === 'web open' && !input.target) {
      const resolved = await resolveTargets(input, { ...options, name: command.name, level: 'project' });
      return { ...resolved, input: { ...input, instanceId: resolved.input.instanceId, target: { kind: 'project', workspace_id: resolved.input.workspace_id, project_id: resolved.input.project_id } } };
    }
    const contextual = Object.values(commandFields(command)).filter(field => field.required && field.contextual);
    const level = contextual.some(field => field.name === 'project_id') ? 'project' : contextual.some(field => field.name === 'workspace_id') ? 'workspace' : 'instance';
    const query = issueQueries.has(command.operation) && !input.project;
    if (!contextual.length && !query) return { input, resolved_context: input.instanceId ? describe(input, { instance: 'explicit' }) : null };
    const selectionInput = command.name === 'web open' && input.target?.kind === 'project' ? { ...input, workspace_id: input.target.workspace_id, project_id: input.target.project_id } : input;
    const resolved = await resolveTargets(selectionInput, { ...options, name: command.name, level, query });
    // Only fields used by this operation enter its request/journal; diagnostics may describe a narrower repository context.
    const filled = { ...input };
    for (const field of contextual) if (filled[field.name] === undefined) filled[field.name] = resolved.input[field.name];
    if (query && resolved.input.project) filled.project = resolved.input.project;
    return { ...resolved, input: filled };
  };
  const run = async (action, input, { select = null } = {}) => {
    if (input.global !== undefined && typeof input.global !== 'boolean') throw toolError('CLI_INVALID_ARGUMENT', '--global accepts true or false');
    if (action === 'clear') {
      const detected = input.global ? { scope_directory: path.resolve(input.directory ?? directory), git: { status: 'not_inspected' } } : await scopeInspector({ directory: input.directory ?? directory });
      await privateBoundary();
      if (['unknown', 'unavailable'].includes(detected.git.status) && !input.global) throw toolError('CLI_CONTEXT_UNAVAILABLE', 'The working directory could not be inspected');
      const file = contextFile(detected.scope_directory, input.global === true);
      await assertNoSymlinkPath(file, home);
      if (await pathType(file) !== 'missing') await validatePrivatePath(file, 'file');
      await rm(file, { force: true });
      return { ok: true, status: 200, data: { cleared: true, global: input.global === true, scope_directory: detected.scope_directory } };
    }
    const level = action === 'show' ? 'instance' : input.project_id ? 'project' : input.workspace_id ? 'workspace' : input.instanceId ? 'instance' : 'project';
    const resolved = await resolveTargets(input, { level, select, name: `context ${action}`, diagnostic: action === 'show', requireRepoMatch: action === 'use' && !input.global, forceInspect: true });
    if (action === 'use') {
      await privateBoundary();
      await validatePrivatePath(stateRoot, 'directory');
      const relative = path.relative(resolved.detected.scope_directory, stateRoot);
      if (resolved.detected.git.status === 'repository' && (!relative || !relative.startsWith('..') && !path.isAbsolute(relative))) throw toolError('UNSAFE_STATE_PATH', 'Context private state must not be stored inside this repository');
      const target = { instance_id: resolved.resolved_context.instance_id, workspace_id: level === 'instance' ? null : resolved.resolved_context.workspace_id, project_id: level === 'project' ? resolved.resolved_context.project_id : null };
      await atomicWriteJson(contextFile(resolved.detected.scope_directory, input.global === true), { schema_version: 1, scope_directory: input.global ? null : resolved.detected.scope_directory, target });
      resolved.resolved_context = { ...resolved.resolved_context, ...target };
    }
    return { ok: true, status: 200, resolved_context: resolved.resolved_context, data: {
      resolved_context: resolved.resolved_context, status: resolved.status, git: resolved.detected.git,
      workbench_context_key: resolved.detected.workbench_context_key ?? null,
      scope_file: resolved.detected.scope_file, repo_targets: resolved.detected.scope?.targets ?? [],
      saved_context: input.global ? resolved.global : resolved.local, global_context: resolved.global,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}), ...(action === 'use' ? { saved: true, global: input.global === true } : {}),
    } };
  };
  return { resolve, run };
}
