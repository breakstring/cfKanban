import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { COMMANDS } from '../src/catalog.mjs';
import { createContextResolver } from '../src/context.mjs';
import { parseArguments } from '../src/parser.mjs';
import { createWorkbenchPreferences } from '../../mcp/src/workbench-preferences.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { inspectScopeDirectory, SCOPE_FILE_NAME } from '../../skill-runtime/src/scope.mjs';
import { createPendingCredential, promotePendingCredential, putInstanceMetadata } from '../../skill-runtime/src/state.mjs';
import { canonicalDigest } from '../../skill-runtime/src/utils.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';

const execFileAsync = promisify(execFile);
const command = name => {
  const result = COMMANDS.find(entry => entry.name === name);
  assert.ok(result, `Missing command: ${name}`);
  return result;
};
const target = f => ({ instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId });
const anotherProject = (f, workspace_id = f.workspaceId) => ({ instance_id: f.instanceId, workspace_id, project_id: randomUUID() });
const requestTarget = options => {
  const match = options.apiPath.match(/^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/issues/);
  return { instance_id: options.instanceId, workspace_id: match?.[1], project_id: match?.[2] };
};
const webTarget = entry => ({ kind: 'project', workspace_id: entry.workspace_id, project_id: entry.project_id });
const resolver = (f, overrides = {}) => createContextResolver({
  home: f.home, stateRoot: f.stateRoot, directory: f.repository, scopeInspector: f.scopeInspector,
  read: (instanceId, apiPath) => f.requestImpl({ instanceId, apiPath, method: 'GET' }), ...overrides,
});
const savedFile = (f, scopeDirectory) => path.join(f.stateRoot, 'cli-contexts', `${canonicalDigest({ directory: scopeDirectory })}.json`);

async function repositoryFixture(t, { targets, initialize = true } = {}) {
  const f = await createMcpStateFixture(t);
  const repository = path.join(f.home, 'repository');
  await mkdir(repository);
  const emptyConfig = path.join(f.home, 'empty-git-config');
  await writeFile(emptyConfig, '');
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key))),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd, args) => execFileAsync('git', args, { cwd, env: environment, shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
  if (initialize) await git(repository, ['-c', 'init.defaultBranch=main', 'init']);
  const state = { targets: targets?.(f) ?? [target(f)], calls: [], fetchCalls: [], connections: new Map([[f.origin, f]]), response: null, committed: null };
  const saveScope = async (entries = state.targets, directory = repository) => writeFile(path.join(directory, SCOPE_FILE_NAME), JSON.stringify({ schema_version: 2, targets: entries }));
  await saveScope();
  const fetchImpl = async (url, options) => {
    url = new URL(url);
    state.fetchCalls.push(url.pathname);
    const connection = state.connections.get(url.origin);
    assert.ok(connection, 'Fetch escaped the registered fake origins');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname === '/.well-known/cfkanban-instance.json') return Response.json(connection.discovery);
    if (url.pathname === '/api/v1/me') return Response.json({ ...connection.me(connection.credential), grants: state.targets.filter(entry => entry.instance_id === connection.instanceId).map(entry => ({ ...entry, role: 'writer' })) });
    assert.fail(`Unexpected fixture fetch: ${url.pathname}`);
  };
  const requestImpl = async options => {
    state.calls.push(options);
    const custom = await state.response?.(options);
    if (custom) return custom;
    const url = new URL(options.apiPath, f.origin);
    const success = data => ({ ok: true, status: 200, data });
    if (options.method === 'POST' && /^\/api\/v1\/workspaces\/[^/]+\/projects\/[^/]+\/issues$/.test(url.pathname)) {
      state.committed = { identifier: 'CFK-1', ...requestTarget(options), title: options.body.title, version: 1 };
      return { ok: true, status: 201, data: { resource: state.committed } };
    }
    assert.equal(options.method, 'GET', `Unexpected fixture mutation: ${options.method} ${url.pathname}`);
    if (url.pathname === '/api/v1/meta') return success({ instance_id: options.instanceId, api_version: '0.1.0', schema_version: 19 });
    if (url.pathname === '/api/v1/me') return success(f.me(f.credential));
    if (url.pathname === '/api/v1/workspaces') return success({ items: [...new Set(state.targets.filter(entry => entry.instance_id === options.instanceId).map(entry => entry.workspace_id))].map(id => ({ id, version: 1 })), next_cursor: null });
    const project = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)$/);
    if (project) {
      const selected = state.targets.find(entry => entry.project_id === project[2]);
      return success({ id: project[2], workspace_id: selected?.workspace_id ?? project[1], version: 1 });
    }
    const projects = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/projects$/);
    if (projects) return success({ items: state.targets.filter(entry => entry.instance_id === options.instanceId && entry.workspace_id === projects[1]).map(entry => ({ id: entry.project_id, workspace_id: entry.workspace_id, version: 1 })), next_cursor: null });
    const workspace = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)$/);
    if (workspace) return success({ id: workspace[1], version: 1 });
    if (url.pathname === '/api/v1/issues' || /^\/api\/v1\/workspaces\/[^/]+\/projects\/[^/]+\/issues$/.test(url.pathname)) return success({ items: state.committed ? [state.committed] : [], next_cursor: null });
    if (url.pathname === '/api/v1/issues/CFK-1') return success(state.committed ?? { identifier: 'CFK-1', version: 1 });
    assert.fail(`Unexpected fixture request: ${url.pathname}`);
  };
  const scopeInspector = input => inspectScopeDirectory(input, { environment });
  const runtime = overrides => createCliRuntime({ ...f, directory: repository, fetchImpl, requestImpl, scopeInspector, ...overrides });
  return { ...f, repository, git, state, saveScope, runtime, scopeInspector, fetchImpl, requestImpl };
}

async function addConnection(f) {
  const instanceId = randomUUID();
  const principalId = randomUUID();
  const credentialId = randomUUID();
  const origin = `https://${instanceId}.context-fixture.invalid`;
  await putInstanceMetadata({ home: f.home, stateRoot: f.stateRoot, persistenceConfirmed: true, instanceId, trustedApiOrigin: origin, originVersion: 1 });
  const pending = await createPendingCredential({ home: f.home, stateRoot: f.stateRoot, persistenceConfirmed: true, instanceId, principalId, credentialId, purpose: 'owner_bootstrap', operationId: randomUUID(), idempotencyKey: randomUUID() });
  const credential = await promotePendingCredential({ stateRoot: f.stateRoot, instanceId, principalId, credentialId, fingerprint: pending.fingerprint });
  const connection = {
    instanceId, origin, credential,
    discovery: { discovery_version: 1, instance_id: instanceId, observed_origin: origin, preferred_api_origin: origin, origin_version: 1 },
    me: metadata => ({ ...f.me(metadata), id: principalId, principal_id: principalId }),
  };
  f.state.connections.set(origin, connection);
  const entry = { instance_id: instanceId, workspace_id: randomUUID(), project_id: randomUUID() };
  f.state.targets.push(entry);
  return entry;
}

async function snapshot(directory) {
  const entries = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      const name = path.relative(directory, file);
      if (entry.isDirectory()) { entries.push([name, 'directory']); await visit(file); }
      else entries.push([name, createHash('sha256').update(await readFile(file)).digest('hex')]);
    }
  }
  await visit(directory);
  return entries;
}

function assertSelection(error, kind, entries) {
  assert.equal(error.code, 'CLI_CONTEXT_SELECTION_REQUIRED');
  assert.equal(error.details.kind, kind);
  assert.deepEqual(new Set(error.details.candidates.map(entry => entry[`${kind}_id`])), new Set(entries.map(entry => entry[`${kind}_id`])));
  assert.ok(error.details.next_commands.length > 0);
  return true;
}

test('repository roots, subdirectories, nested repositories and linked worktrees resolve their own scope without writes', async t => {
  const f = await repositoryFixture(t);
  const subdirectory = path.join(f.repository, 'src');
  const nested = path.join(f.repository, 'nested');
  const worktree = path.join(f.home, 'worktree');
  await mkdir(subdirectory);
  await mkdir(nested);
  await f.git(nested, ['-c', 'init.defaultBranch=main', 'init']);
  await f.git(f.repository, ['-c', 'user.name=ContextFixture', '-c', 'user.email=context-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
  await f.git(f.repository, ['worktree', 'add', '-b', 'context-fixture', worktree]);
  const nestedTarget = anotherProject(f);
  const worktreeTarget = anotherProject(f);
  const decoy = anotherProject(f);
  f.state.targets.push(nestedTarget, worktreeTarget);
  await f.saveScope([target(f)]);
  await f.saveScope([decoy], subdirectory);
  await f.saveScope([nestedTarget], nested);
  await f.saveScope([worktreeTarget], worktree);
  const beforeRepository = await snapshot(f.repository);
  const beforeWorktree = await snapshot(worktree);
  for (const [directory, expected, root] of [[f.repository, target(f), f.repository], [subdirectory, target(f), f.repository], [nested, nestedTarget, nested], [worktree, worktreeTarget, worktree]]) {
    const result = await f.runtime({ directory }).execute(command('issue create'), { title: 'Repository target' });
    assert.equal(result.operation.phase, 'verified');
    const post = f.state.calls.filter(call => call.method === 'POST').at(-1);
    assert.deepEqual(requestTarget(post), expected);
    assert.equal(result.resolved_context.scope_directory, await realpath(root));
    assert.deepEqual(result.resolved_context.sources, { instance: 'repository', workspace: 'repository', project: 'repository' });
  }
  assert.deepEqual(await snapshot(f.repository), beforeRepository);
  assert.deepEqual(await snapshot(worktree), beforeWorktree);
});

test('multiple repository projects deduplicate instance and workspace and preserve issue list aggregation', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const select = () => assert.fail('An already unique instance or workspace must not prompt for a project');
  const runtime = f.runtime();
  const info = await runtime.execute(command('instance info'), {}, { select });
  assert.equal(info.resolved_context.instance_id, f.instanceId);
  assert.equal(info.resolved_context.project_id, null);
  const projects = await runtime.execute(command('project list'), {}, { select });
  assert.equal(projects.resolved_context.workspace_id, f.workspaceId);
  assert.equal(projects.resolved_context.project_id, null);
  const listed = await runtime.execute(command('issue list'), {}, { select });
  const request = f.state.calls.findLast(call => new URL(call.apiPath, f.origin).pathname === '/api/v1/issues');
  assert.deepEqual(new Set(new URL(request.apiPath, f.origin).searchParams.getAll('project')), new Set(f.state.targets.map(entry => entry.project_id)));
  assert.equal(listed.resolved_context.project_id, null);
  assert.equal(f.state.calls.some(call => call.method !== 'GET'), false);
});

test('issue aggregation spans repository workspaces while workspace-scoped commands require an exact choice', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f, randomUUID())] });
  const runtime = f.runtime();
  const listed = await runtime.execute(command('issue list'), {}, { select: () => assert.fail('Aggregate query must not select one workspace') });
  const request = f.state.calls.findLast(call => new URL(call.apiPath, f.origin).pathname === '/api/v1/issues');
  assert.deepEqual(new Set(new URL(request.apiPath, f.origin).searchParams.getAll('project')), new Set(f.state.targets.map(entry => entry.project_id)));
  assert.equal(listed.resolved_context.workspace_id, null);
  assert.equal(listed.resolved_context.project_id, null);
  await assert.rejects(runtime.execute(command('project list'), {}), error => assertSelection(error, 'workspace', f.state.targets));
});

test('search index status uses repository project filters and never broadens an unassociated directory implicitly', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f, randomUUID())] });
  f.state.response = options => new URL(options.apiPath, f.origin).pathname === '/api/v1/search-index/status' ? { ok: true, status: 200, data: { projects: [] } } : null;
  const listed = await f.runtime().execute(command('search-index status'), {});
  const request = f.state.calls.findLast(call => new URL(call.apiPath, f.origin).pathname === '/api/v1/search-index/status');
  assert.deepEqual(new Set(new URL(request.apiPath, f.origin).searchParams.getAll('project')), new Set(f.state.targets.map(entry => entry.project_id)));
  assert.deepEqual(new Set(listed.resolved_context.project_ids), new Set(f.state.targets.map(entry => entry.project_id)));
  await f.saveScope([]);
  f.state.calls.length = 0;
  await assert.rejects(f.runtime().execute(command('search-index status'), { instanceId: f.instanceId }), { code: 'CLI_EXPLICIT_SCOPE_REQUIRED' });
  assert.equal(f.state.calls.length, 0);
  const parsed = await parseArguments(['search-index','status','--instance',f.instanceId,'--allow-unfiltered','true']);
  assert.equal(parsed.input.allowUnfiltered, true);
  await f.runtime().execute(parsed.command, parsed.input);
  const broad = new URL(f.state.calls.at(-1).apiPath, f.origin);
  assert.equal(broad.searchParams.get('allow_unfiltered'), 'true');
  assert.deepEqual(broad.searchParams.getAll('project'), []);
});

test('ambiguous project creation gives stable candidates and explicit next commands before writing', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  await assert.rejects(f.runtime().execute(command('issue create'), { title: 'Do not guess' }), error => assertSelection(error, 'project', f.state.targets));
  assert.equal(f.state.calls.some(call => call.method === 'POST'), false);
});

test('interactive selection uses the returned candidate and rejects a candidate outside the offered scope', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const chosen = f.state.targets[1];
  const result = await f.runtime().execute(command('issue create'), { title: 'Selected project' }, { select: async details => {
    assert.equal(details.kind, 'project');
    assert.deepEqual(new Set(details.candidates.map(entry => entry.project_id)), new Set(f.state.targets.map(entry => entry.project_id)));
    assert.ok(details.next_commands.length);
    return details.candidates.find(entry => entry.project_id === chosen.project_id);
  } });
  assert.equal(result.operation.phase, 'verified');
  assert.equal(requestTarget(f.state.calls.find(call => call.method === 'POST')).project_id, chosen.project_id);
  f.state.calls.length = 0;
  await assert.rejects(f.runtime().execute(command('issue create'), { title: 'Forged selection' }, { select: () => anotherProject(f) }), { code: 'CLI_CONTEXT_SELECTION_REQUIRED' });
  assert.equal(f.state.calls.some(call => call.method === 'POST'), false);
});

test('explicit project derives its related workspace and does not combine IDs from different repository targets', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f, randomUUID())] });
  const selected = f.state.targets[1];
  const result = await f.runtime().execute(command('issue create'), { project_id: selected.project_id, title: 'Related workspace' });
  const post = f.state.calls.find(call => call.method === 'POST');
  assert.deepEqual(requestTarget(post), selected);
  assert.equal(result.resolved_context.sources.project, 'explicit');
  f.state.calls.length = 0;
  await assert.rejects(f.runtime().execute(command('issue create'), { workspace_id: f.workspaceId, project_id: selected.project_id, title: 'Conflicting IDs' }), { code: 'CLI_CONTEXT_CONFLICT' });
  assert.equal(f.state.calls.some(call => call.method === 'POST'), false);
});

test('fully explicit API targets skip repository inspection', async t => {
  const f = await repositoryFixture(t);
  const explicit = await addConnection(f);
  const result = await f.runtime({ scopeInspector: () => assert.fail('Explicit target inspected repository') }).execute(command('issue create'), { instanceId: explicit.instance_id, workspace_id: explicit.workspace_id, project_id: explicit.project_id, title: 'Explicit target' });
  assert.equal(result.operation.phase, 'verified');
  assert.equal(requestTarget(f.state.calls.find(call => call.method === 'POST')).project_id, explicit.project_id);
  assert.equal(result.resolved_context, undefined, 'Fully explicit commands preserve their existing result shape');
});

test('a different explicit instance resolves only that instance resources rather than borrowing repository project IDs', async t => {
  const f = await repositoryFixture(t);
  const explicit = await addConnection(f);
  const result = await f.runtime().execute(command('issue create'), { instanceId: explicit.instance_id, title: 'Other instance' });
  assert.equal(result.operation.phase, 'verified');
  assert.deepEqual(requestTarget(f.state.calls.find(call => call.method === 'POST')), explicit);
  assert.equal(result.resolved_context.sources.instance, 'explicit');
  assert.equal(result.resolved_context.sources.workspace, 'service_unique');
  assert.equal(result.resolved_context.sources.project, 'service_unique');
  assert.ok(f.state.calls.every(call => call.instanceId === explicit.instance_id));
});

test('context show describes all repository targets without forcing a project choice', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const before = await snapshot(f.repository);
  const result = await f.runtime().execute(command('context show'), {}, { select: () => assert.fail('Diagnostic context should not prompt') });
  assert.equal(result.data.resolved_context.instance_id, f.instanceId);
  assert.equal(result.data.resolved_context.workspace_id, f.workspaceId);
  assert.equal(result.data.resolved_context.project_id, null);
  assert.deepEqual(result.data.repo_targets, f.state.targets);
  assert.equal(result.data.git.status, 'repository');
  assert.equal(result.data.workbench_context_key, canonicalDigest({ directory: await realpath(f.repository) }));
  assert.deepEqual(await snapshot(f.repository), before);
});

test('Codex repository recommendation does not replace explicitly saved CLI context', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const key = canonicalDigest({ directory: await realpath(f.repository) });
  const preferences = createWorkbenchPreferences({ homeDirectory: await realpath(f.home), stateRoot: await realpath(f.stateRoot) });
  const recommended = { ...f.state.targets[1], principal_id: f.principalId };
  assert.equal(await preferences.save(recommended, key), true);
  const shown = await f.runtime().execute(command('context show'), {});
  assert.equal(shown.data.workbench_context_key, key);
  assert.equal(shown.data.resolved_context.project_id, null);
  assert.equal(shown.data.saved_context, null);
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId });
  const saved = await f.runtime().execute(command('context show'), {});
  assert.equal(saved.data.resolved_context.project_id, f.projectId);
  assert.deepEqual(await preferences.load(key), recommended);
});

test('context show passes through the inspector key and uses null outside a confirmed repository', async t => {
  const f = await repositoryFixture(t), key = 'c'.repeat(64);
  const scopeInspector = async input => ({ ...await f.scopeInspector(input), workbench_context_key: key });
  const shown = await f.runtime({ scopeInspector }).execute(command('context show'), {});
  assert.equal(shown.data.workbench_context_key, key);
  const outside = path.join(f.home, 'outside-repository');
  await mkdir(outside);
  const unassociated = await f.runtime({ directory: outside }).execute(command('context show'), {});
  assert.equal(unassociated.data.git.status, 'not_repository');
  assert.equal(unassociated.data.workbench_context_key, null);
});

test('context use persists only private directory selection across runtimes and clear restores ambiguity', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const subdirectory = path.join(f.repository, 'src');
  await mkdir(subdirectory);
  const before = await snapshot(f.repository);
  const chosen = f.state.targets[1];
  const used = await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: chosen.workspace_id, project_id: chosen.project_id, directory: subdirectory });
  assert.equal(used.ok, true);
  const privateDirectory = path.join(f.stateRoot, 'cli-contexts');
  assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
  for (const file of await readdir(privateDirectory)) assert.equal((await stat(path.join(privateDirectory, file))).mode & 0o777, 0o600);
  const shown = await f.runtime({ directory: subdirectory }).execute(command('context show'), {});
  assert.equal(shown.data.resolved_context.project_id, chosen.project_id);
  assert.equal(shown.data.resolved_context.sources.project, 'saved_directory');
  const created = await f.runtime().execute(command('issue create'), { title: 'Saved directory target' });
  assert.equal(created.resolved_context.project_id, chosen.project_id);
  assert.equal(requestTarget(f.state.calls.find(call => call.method === 'POST')).project_id, chosen.project_id);
  const overridden = await f.runtime().execute(command('issue create'), { project_id: f.projectId, title: 'Explicit override of saved target' });
  assert.equal(overridden.resolved_context.project_id, f.projectId);
  assert.equal(overridden.resolved_context.sources.project, 'explicit');
  assert.equal(requestTarget(f.state.calls.filter(call => call.method === 'POST').at(-1)).project_id, f.projectId);
  await f.runtime().execute(command('context clear'), {});
  const cleared = await f.runtime().execute(command('context show'), {});
  assert.equal(cleared.data.resolved_context.project_id, null);
  await assert.rejects(f.runtime().execute(command('issue create'), { title: 'No saved selection' }), error => assertSelection(error, 'project', f.state.targets));
  assert.deepEqual(await snapshot(f.repository), before);
});

test('removed directory selection fails closed rather than changing project or broadening issue list', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const chosen = f.state.targets[1];
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: chosen.workspace_id, project_id: chosen.project_id });
  await f.saveScope([target(f)]);
  f.state.calls.length = 0;
  for (const name of ['issue create', 'issue list']) await assert.rejects(f.runtime().execute(command(name), name === 'issue create' ? { title: 'Stale selection' } : {}), { code: 'CLI_CONTEXT_STALE' });
  assert.equal(f.state.calls.length, 0);
});

test('directory defaults do not leak to a different repository and repository bindings override a global default', async t => {
  const f = await repositoryFixture(t);
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId });
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId, global: true });
  const other = path.join(f.home, 'other-repository');
  const outside = path.join(f.home, 'outside');
  await mkdir(other);
  await mkdir(outside);
  await f.git(other, ['-c', 'init.defaultBranch=main', 'init']);
  const otherTarget = anotherProject(f, randomUUID());
  f.state.targets.push(otherTarget);
  await f.saveScope([otherTarget], other);
  const otherResult = await f.runtime({ directory: other }).execute(command('issue create'), { title: 'Other repository' });
  assert.equal(otherResult.resolved_context.project_id, otherTarget.project_id);
  assert.equal(otherResult.resolved_context.sources.project, 'repository');
  const globalResult = await f.runtime({ directory: outside }).execute(command('issue create'), { title: 'Global target' });
  assert.equal(globalResult.resolved_context.project_id, f.projectId);
  assert.equal(globalResult.resolved_context.sources.project, 'saved_global');
});

test('a single local registered connection is a safe instance fallback', async t => {
  const f = await repositoryFixture(t);
  await f.saveScope([]);
  const result = await f.runtime().execute(command('instance info'), {});
  assert.equal(result.resolved_context.instance_id, f.instanceId);
  assert.equal(result.resolved_context.sources.instance, 'local_connection');
});

test('local instance ambiguity retains metadata-only candidates before inspecting credentials', async t => {
  const f = await repositoryFixture(t);
  await f.saveScope([]);
  const otherId = randomUUID();
  await putInstanceMetadata({ home: f.home, stateRoot: f.stateRoot, persistenceConfirmed: true, instanceId: otherId, trustedApiOrigin: 'https://other-context-fixture.invalid', originVersion: 1 });
  await assert.rejects(f.runtime().execute(command('instance info'), {}), error => assertSelection(error, 'instance', [{ instance_id: f.instanceId }, { instance_id: otherId }]));
  assert.equal(f.state.fetchCalls.length, 0);
  assert.equal(f.state.calls.length, 0);
  const shown = await f.runtime().execute(command('context show'), {});
  assert.equal(shown.data.resolved_context.instance_id, null);
  assert.equal(f.state.fetchCalls.length, 0);
});

test('context use does not overwrite a saved target after Service denies target validation', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const input = entry => ({ instanceId: entry.instance_id, workspace_id: entry.workspace_id, project_id: entry.project_id });
  await f.runtime().execute(command('context use'), input(target(f)));
  const denied = f.state.targets[1];
  f.state.response = options => options.apiPath.includes(denied.project_id) ? { ok: false, status: 403, error: { code: 'CAPABILITY_DENIED', category: 'authorization', source: 'service' } } : null;
  await assert.rejects(f.runtime().execute(command('context use'), input(denied)), error => {
    assert.equal(error.code, 'CLI_CONTEXT_TARGET_REJECTED');
    assert.equal(error.result.status, 403);
    assert.equal(error.result.error.code, 'CAPABILITY_DENIED');
    return true;
  });
  const shown = await f.runtime().execute(command('context show'), {});
  assert.equal(shown.data.resolved_context.project_id, f.projectId);
});

test('unknown create recovery preserves original target and key after repository scope changes', async t => {
  const f = await repositoryFixture(t);
  let drop = true;
  f.state.response = options => {
    if (options.method !== 'POST') return null;
    f.state.committed = { identifier: 'CFK-1', ...requestTarget(options), title: options.body.title, version: 1 };
    if (drop) return { ok: false, status: 0, error: { code: 'PLATFORM_UNAVAILABLE', category: 'platform_failure', source: 'client_transport' } };
    return { ok: true, status: 201, data: { resource: f.state.committed, idempotent_replay: true } };
  };
  const original = await f.runtime().execute(command('issue create'), { title: 'Original target', idempotencyKey: 'retained-context-key' });
  assert.equal(original.outcome_unknown, true);
  const changed = anotherProject(f, randomUUID());
  f.state.targets.push(changed);
  await f.saveScope([changed]);
  drop = false;
  const result = await f.runtime({ scopeInspector: () => assert.fail('Recovery must not reparse repository context') }).execute(command('operation recover'), { instanceId: f.instanceId, operationId: original.recovery.operation_id }, { select: () => assert.fail('Recovery must not choose a new target') });
  assert.equal(result.operation.phase, 'verified');
  const attempts = f.state.calls.filter(call => call.method === 'POST');
  assert.equal(attempts.length, 2);
  assert.equal(requestTarget(attempts[0]).project_id, f.projectId);
  assert.deepEqual(attempts[1].body, attempts[0].body);
  assert.equal(attempts[1].apiPath, attempts[0].apiPath);
  assert.equal(attempts[1].idempotencyKey, 'retained-context-key');
  assert.equal(attempts[1].instanceId, attempts[0].instanceId);
});

test('Owner, upgrade plans and permanent purge require explicit risk targets before inspecting context', async t => {
  const f = await repositoryFixture(t);
  const runtime = f.runtime({
    scopeInspector: () => assert.fail('Risk target was inferred from repository'),
    dispatchImpl: () => assert.fail('Invalid risk target reached a helper'),
  });
  for (const [name, input] of [
    ['owner rotate', {}],
    ['deploy upgrade plan', {}],
    ['workspace purge', { instanceId: f.instanceId }],
    ['project purge', { instanceId: f.instanceId, workspace_id: f.workspaceId }],
  ]) await assert.rejects(runtime.execute(command(name), input, { select: () => assert.fail('Risk target prompted for selection') }), { code: 'CLI_MISSING_ARGUMENT' });
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.fetchCalls.length, 0);
});

test('Web target resolution uses a single repository project and a persisted project choice', async t => {
  const f = await repositoryFixture(t);
  const single = await resolver(f).resolve(command('web open'), {});
  assert.equal(single.input.instanceId, f.instanceId);
  assert.deepEqual(single.input.target, webTarget(target(f)));
  const chosen = anotherProject(f);
  f.state.targets.push(chosen);
  await f.saveScope();
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: chosen.workspace_id, project_id: chosen.project_id });
  const saved = await resolver(f).resolve(command('web open'), {});
  assert.deepEqual(saved.input.target, webTarget(chosen));
  assert.equal(saved.resolved_context.sources.project, 'saved_directory');
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
});

test('Web target resolution rejects machine ambiguity and accepts the exact interactive candidate', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  await assert.rejects(resolver(f).resolve(command('web open'), {}), error => assertSelection(error, 'project', f.state.targets));
  const chosen = f.state.targets[1];
  const selected = await resolver(f).resolve(command('web open'), {}, { select: details => {
    assert.equal(details.kind, 'project');
    return details.candidates.find(candidate => candidate.project_id === chosen.project_id);
  } });
  assert.equal(selected.input.instanceId, chosen.instance_id);
  assert.deepEqual(selected.input.target, webTarget(chosen));
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
});

test('explicit Web target derives its instance and refuses conflicting workspace or project aliases', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f, randomUUID())] });
  const chosen = f.state.targets[1];
  const selected = await resolver(f).resolve(command('web open'), { target: webTarget(chosen) });
  assert.equal(selected.input.instanceId, chosen.instance_id);
  assert.deepEqual(selected.input.target, webTarget(chosen));
  for (const input of [
    { target: webTarget(chosen), workspace_id: f.workspaceId },
    { target: webTarget(chosen), project_id: f.projectId },
    { instanceId: f.instanceId, target: webTarget(chosen), workspace_id: f.workspaceId },
  ]) await assert.rejects(resolver(f).resolve(command('web open'), input), { code: 'CLI_CONTEXT_CONFLICT' });
});

test('unknown or unavailable directory inspection never falls back to the local connection', async t => {
  const f = await repositoryFixture(t);
  for (const status of ['unknown', 'unavailable']) {
    const scopeInspector = async () => ({ directory: f.repository, scope_directory: f.repository, scope_file: path.join(f.repository, SCOPE_FILE_NAME), scope: null, git: { status, root: null } });
    await assert.rejects(f.runtime({ scopeInspector }).execute(command('instance info'), {}), { code: 'CLI_CONTEXT_UNAVAILABLE' });
    await assert.rejects(resolver(f, { scopeInspector }).resolve(command('web open'), {}), { code: 'CLI_CONTEXT_UNAVAILABLE' });
    const diagnostic = await f.runtime({ scopeInspector }).execute(command('context show'), {});
    assert.equal(diagnostic.data.workbench_context_key, null);
  }
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.fetchCalls.length, 0);
  const explicit = await resolver(f, { scopeInspector: () => assert.fail('Complete explicit Web target requires no Git') }).resolve(command('web open'), { instanceId: f.instanceId, target: webTarget(target(f)) });
  assert.deepEqual(explicit.input.target, webTarget(target(f)));
});

test('context clear removes a malformed directory record before resolving fresh repository scope', async t => {
  const f = await repositoryFixture(t);
  const used = await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId });
  const file = savedFile(f, used.resolved_context.scope_directory);
  await writeFile(file, JSON.stringify({ schema_version: 99 }), { mode: 0o600 });
  await assert.rejects(f.runtime().execute(command('context show'), {}), { code: 'CLI_CONTEXT_STALE' });
  const cleared = await f.runtime().execute(command('context clear'), {});
  assert.equal(cleared.data.cleared, true);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  const resolved = await f.runtime().execute(command('issue create'), { title: 'After clearing invalid context' });
  assert.equal(resolved.resolved_context.project_id, f.projectId);
  assert.equal(resolved.resolved_context.sources.project, 'repository');
});

test('instance and workspace defaults persist only the explicitly selected granularity', async t => {
  const f = await repositoryFixture(t);
  const instance = await f.runtime().execute(command('context use'), { instanceId: f.instanceId });
  const instanceRecord = JSON.parse(await readFile(savedFile(f, instance.resolved_context.scope_directory), 'utf8'));
  assert.deepEqual(instanceRecord.target, { instance_id: f.instanceId, workspace_id: null, project_id: null });
  assert.equal(instance.data.resolved_context.project_id, null);
  assert.equal(instance.data.resolved_context.workspace_id, null);
  const workspace = await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: f.workspaceId });
  const workspaceRecord = JSON.parse(await readFile(savedFile(f, workspace.resolved_context.scope_directory), 'utf8'));
  assert.deepEqual(workspaceRecord.target, { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: null });
  assert.equal(workspace.data.resolved_context.project_id, null);
  const another = anotherProject(f);
  f.state.targets.push(another);
  await f.saveScope();
  await assert.rejects(f.runtime().execute(command('issue create'), { title: 'Workspace default leaves project choice open' }), error => assertSelection(error, 'project', f.state.targets));
});

test('global show and clear operate on the global default while preserving the directory selection', async t => {
  const f = await repositoryFixture(t, { targets: f => [target(f), anotherProject(f)] });
  const local = f.state.targets[1];
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: local.workspace_id, project_id: local.project_id });
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId, global: true });
  const shown = await f.runtime().execute(command('context show'), { global: true });
  assert.equal(shown.data.resolved_context.project_id, f.projectId);
  assert.equal(shown.data.resolved_context.sources.project, 'saved_global');
  assert.equal(shown.data.workbench_context_key, null);
  await f.runtime().execute(command('context clear'), { global: true });
  await assert.rejects(stat(path.join(f.stateRoot, 'cli-contexts', 'global.json')), { code: 'ENOENT' });
  const directory = await f.runtime().execute(command('context show'), {});
  assert.equal(directory.data.resolved_context.project_id, local.project_id);
  assert.equal(directory.data.resolved_context.sources.project, 'saved_directory');
});

test('a malformed unrelated global record cannot interfere with pinned repository scope and can be cleared', async t => {
  const f = await repositoryFixture(t);
  await f.runtime().execute(command('context use'), { instanceId: f.instanceId, global: true });
  const file = path.join(f.stateRoot, 'cli-contexts', 'global.json');
  await writeFile(file, JSON.stringify({ schema_version: 99 }), { mode: 0o600 });
  const resolved = await f.runtime().execute(command('issue create'), { title: 'Repository ignores unrelated broken global state' });
  assert.equal(resolved.resolved_context.project_id, f.projectId);
  assert.equal(resolved.resolved_context.sources.instance, 'repository');
  await assert.rejects(f.runtime().execute(command('context show'), { global: true }), { code: 'CLI_CONTEXT_STALE' });
  await f.runtime().execute(command('context clear'), { global: true });
  const shown = await f.runtime().execute(command('context show'), {});
  assert.equal(shown.data.resolved_context.project_id, f.projectId);
});

test('global defaults remain inspectable and editable when current repository scope is malformed', async t => {
  const f = await repositoryFixture(t);
  const scopeFile = path.join(f.repository, SCOPE_FILE_NAME);
  await writeFile(scopeFile, JSON.stringify({ schema_version: 99 }));
  const runtime = f.runtime({ scopeInspector: () => assert.fail('Global defaults must not depend on current Git or repository scope') });
  await runtime.execute(command('context use'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId, global: true });
  const shown = await runtime.execute(command('context show'), { global: true });
  assert.equal(shown.data.resolved_context.project_id, f.projectId);
  assert.equal(shown.data.resolved_context.sources.project, 'saved_global');
  const cleared = await runtime.execute(command('context clear'), { global: true });
  assert.equal(cleared.data.cleared, true);
  await assert.rejects(stat(path.join(f.stateRoot, 'cli-contexts', 'global.json')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(scopeFile, 'utf8')), { schema_version: 99 });
});
