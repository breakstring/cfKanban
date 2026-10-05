import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { IconSchema } from '@modelcontextprotocol/sdk/types.js';

let workbenchModule;
async function workbenchExports() {
  if (!workbenchModule) {
    const output = await build({ entryPoints: [fileURLToPath(new URL('../src/workbench.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.svg': 'text' } });
    workbenchModule = import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  }
  return workbenchModule;
}
const ok = data => ({ ok: true, status: 200, data });
const fail = (code, status = 403, outcome_unknown = false) => ({ ok: false, status, error: { code }, ...(outcome_unknown ? { outcome_unknown: true } : {}) });
const action = (action, payload = {}) => ({ type: 'action', id: randomUUID(), action, payload });
const viewIdOf = result => result._meta['cfkanban/viewId'];
const snapshotOf = result => result._meta['cfkanban/snapshot'].state;
const call = (workbench, viewId, message, signal) => workbench.callTool('cfkanban_workbench_action', { view_id: viewId, message }, { signal });

function fixture({ reader = false, unknown = false, unknownCreate = false } = {}) {
  const ids = { instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), principal_id: randomUUID() };
  let principal = { id: ids.principal_id, principal_id: ids.principal_id, display_name: 'Isolated fixture', version: 1, locale: 'en', theme: 'orange', grants: [{ workspace_id: ids.workspace_id, project_id: ids.project_id, role: reader ? 'reader' : 'writer' }] };
  let issue = { id: randomUUID(), identifier: 'CFK-1', title: 'Fixture issue', body: 'Untrusted fixture business text', version: 3, priority: 'none', status: { key: 'todo', display_name: 'Todo' }, project: { id: ids.project_id }, workspace: { id: ids.workspace_id }, allowed_actions: reader ? ['read'] : ['read', 'update'], labels: [], comments: [], hidden_fixture_field: 'PRIVATE_FIXTURE_MARKER' };
  const calls = [], receipts = new Map();
  let commits = 0, creations = 0, hook;
  const createFacade = config => ({ callTool: async (name, args, { signal } = {}) => {
    calls.push({ name, args: structuredClone(args), config: structuredClone(config), signal });
    if (hook) { const value = await hook(name, args, signal); if (value !== undefined) return value; }
    signal?.throwIfAborted();
    const bound = config?.binding;
    if (bound && (bound.instance_id !== ids.instance_id || bound.expected_principal_id !== principal.principal_id)) return fail('MCP_PRINCIPAL_BINDING_MISMATCH', 0);
    if (bound?.project_ids.length && name !== 'cfkanban_connection_inspect' && bound.project_ids[0] !== ids.project_id) return fail('MCP_PROJECT_BINDING_MISMATCH', 0);
    if (name === 'cfkanban_connection_inspect') return args.instance_id ? ok({ instance: { instance_id: ids.instance_id, trusted_api_origin: 'https://isolated.fixture.invalid' }, principal: structuredClone(principal), hidden_fixture_field: 'PRIVATE_FIXTURE_MARKER' }) : ok({ candidates: [{ instance_id: ids.instance_id, trusted_api_origin: 'https://isolated.fixture.invalid' }] });
    if (name === 'cfkanban_workspaces_list') return ok({ items: [{ id: ids.workspace_id, display_name: 'Fixture workspace' }] });
    if (name === 'cfkanban_projects_list') return ok({ items: [{ id: ids.project_id, display_name: 'Fixture project' }] });
    if (name === 'cfkanban_projects_get') return ok({ id: ids.project_id, workspace_id: ids.workspace_id, display_name: 'Fixture project' });
    if (name === 'cfkanban_statuses_list') return ok({ items: ['backlog', 'todo', 'in_progress', 'done', 'canceled'].map(key => ({ key, display_name: key })) });
    if (name === 'cfkanban_issues_list') return ok({ items: args.status.includes(issue.status.key) ? [structuredClone(issue)] : [] });
    if (name === 'cfkanban_issues_get') return ok(structuredClone(issue));
    if (name === 'cfkanban_issues_create') {
      if (receipts.has(args.idempotency_key)) return receipts.get(args.idempotency_key);
      if (principal.grants[0].role === 'reader') return fail('CAPABILITY_DENIED');
      creations++;
      issue = { ...issue, id: randomUUID(), identifier: 'CFK-2', title: args.title, body: args.body ?? '', priority: args.priority_key ?? 'none', status: { key: args.status_key ?? 'backlog' }, version: 1 };
      const result = ok({ resource: structuredClone(issue) });
      receipts.set(args.idempotency_key, result);
      if (unknownCreate) { unknownCreate = false; return fail('NETWORK_ERROR', 0, true); }
      return result;
    }
    if (name === 'cfkanban_issues_update') {
      if (receipts.has(args.idempotency_key)) return receipts.get(args.idempotency_key);
      if (!issue.allowed_actions.includes('update')) return fail('CAPABILITY_DENIED');
      if (args.expected_version !== issue.version) return fail('VERSION_CONFLICT', 409);
      commits++;
      issue = { ...issue, version: issue.version + 1, ...(args.changes.priority_key ? { priority: args.changes.priority_key } : {}), ...(args.changes.title === undefined ? {} : { title: args.changes.title }), ...(args.changes.body === undefined ? {} : { body: args.changes.body }) };
      const result = ok({ resource: structuredClone(issue) });
      receipts.set(args.idempotency_key, result);
      if (unknown) { unknown = false; return fail('NETWORK_ERROR', 0, true); }
      return result;
    }
    return ok({ items: [] });
  } });
  return { ids, calls, createFacade, get issue() { return issue; }, get commits() { return commits; }, get creations() { return creations; }, drift() { principal = { ...principal, id: randomUUID(), principal_id: randomUUID() }; }, revoke() { issue = { ...issue, allowed_actions: ['read'] }; }, conflict() { issue = { ...issue, version: issue.version + 1 }; }, intercept(value) { hook = value; } };
}
async function boundView(workbench, f) {
  const opened = await workbench.callTool('cfkanban_workbench_open', {});
  const viewId = viewIdOf(opened);
  for (const message of [action('select_instance', { instance_id: f.ids.instance_id }), action('workspaces'), action('select_workspace', { workspace_id: f.ids.workspace_id }), action('bind', { project_id: f.ids.project_id }), action('open_issue', { identifier: 'CFK-1' })]) assert.equal((await call(workbench, viewId, message)).structuredContent.ok, true);
  return viewId;
}

test('entrypoints strictly validate inputs, expose UI state only in metadata and isolate every view', async t => {
  const { McpWorkbench, workbenchTools } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade, version: 'fixture-version' });
  t.after(() => workbench.dispose());
  const tools = workbenchTools('fixture-version');
  assert.deepEqual(tools[0]._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  assert.deepEqual(tools[1]._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['target', 'recommended_targets', 'repository_key']);
  assert.deepEqual(tools[0].inputSchema.properties.target.required, ['instance_id', 'workspace_id', 'project_id']);
  assert.match(tools[0].inputSchema.properties.target.properties.identifier.pattern, /CFK/);
  assert.equal(Object.hasOwn(tools[0].inputSchema.properties.recommended_targets.items.properties, 'identifier'), false);
  assert.deepEqual(tools[1].inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.ok(tools.slice(2).every(tool => JSON.stringify(tool._meta.ui.visibility) === '["app"]'));
  assert.equal((await workbench.callTool('cfkanban_workbench_open', { project_id: f.ids.project_id })).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  const opened = await workbench.callTool('cfkanban_workbench_open', {}), other = await workbench.callTool('cfkanban_workbench_open', {});
  assert.match(viewIdOf(opened), /^[0-9a-f-]{36}$/);
  assert.notEqual(viewIdOf(opened), viewIdOf(other));
  assert.deepEqual(opened.structuredContent, { ok: true, protocol: 1, version: 'fixture-version' });
  assert.equal(opened.content[0].text, JSON.stringify(opened.structuredContent));
  assert.equal(snapshotOf(opened).scope_mode, 'manual');
  assert.equal(snapshotOf(opened).source_session_id, null);
  assert.equal(snapshotOf(opened).identity.principal.principal_id, f.ids.principal_id);
  assert.equal(snapshotOf(opened).binding.project.id, f.ids.project_id);
  assert.equal(snapshotOf(opened).workspaces.length, 1);
  assert.ok(f.calls.every(row => !/_(create|update|complete|delete)$/.test(row.name)));
  const one = await call(workbench, viewIdOf(opened), action('select_workspace', { workspace_id: f.ids.workspace_id }));
  assert.equal(snapshotOf(one).projects.length, 1);
  assert.equal(snapshotOf(await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewIdOf(other) })).binding.project.id, f.ids.project_id);
  assert.doesNotMatch(JSON.stringify(one), /PRIVATE_FIXTURE_MARKER|binding_id|idempotency_key/);
  assert.doesNotMatch(JSON.stringify(one.structuredContent), /Fixture|principal|instance|viewId|snapshot/);
});

test('a single validated connection opens an accessible Project automatically; connection ambiguity is preserved', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const count of [0, 1, 2]) {
    const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
    t.after(() => workbench.dispose());
    f.intercept((name, args) => name === 'cfkanban_connection_inspect' && !args.instance_id ? ok({ candidates: Array.from({ length: count }, (_, index) => ({ instance_id: index ? randomUUID() : f.ids.instance_id, trusted_api_origin: 'https://isolated.fixture.invalid' })) }) : undefined);
    const state = snapshotOf(await workbench.callTool('cfkanban_workbench_open', {}));
    assert.equal(Boolean(state.identity), count === 1);
    assert.equal(state.workspaces.length, count === 1 ? 1 : 0);
    assert.equal(Boolean(state.binding), count === 1);
    assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_get'), count === 1);
    assert.equal(f.calls.some(row => row.name === 'cfkanban_connection_inspect' && row.args.instance_id), count === 1);
  }
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  f.intercept((name, args) => name === 'cfkanban_connection_inspect' && args.instance_id ? fail('UNAUTHORIZED') : undefined);
  const state = snapshotOf(await workbench.callTool('cfkanban_workbench_open', {}));
  assert.equal(state.identity, null);
  assert.equal(state.error.code, 'UNAUTHORIZED');
  assert.equal(f.calls.some(row => row.name === 'cfkanban_workspaces_list'), false);
});

test('global opens an accessible default and remembers only verified target IDs, while conversation views remain separate', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), saved = [];
  let reads = 0;
  const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { reads++; return null; }, async save(target) { saved.push(structuredClone(target)); return true; } } });
  t.after(() => workbench.dispose());
  const global = await workbench.callTool('cfkanban_workbench_global_open', {});
  assert.equal(snapshotOf(global).binding.project.id, f.ids.project_id);
  assert.deepEqual(saved, [f.ids]);
  assert.equal(reads, 1);
  assert.equal(f.calls.some(row => /_(create|update|complete)$/.test(row.name)), false);
  const conversation = await workbench.callTool('cfkanban_workbench_open', {});
  assert.equal(snapshotOf(conversation).binding.project.id, f.ids.project_id);
  assert.notEqual(viewIdOf(conversation), viewIdOf(global));
  assert.equal(reads, 1);
  await call(workbench, viewIdOf(conversation), action('select_workspace', { workspace_id: f.ids.workspace_id }));
  await call(workbench, viewIdOf(conversation), action('bind', { project_id: f.ids.project_id }));
  assert.equal(saved.length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /view_id|binding_id|snapshot|Credential|key/);
});

test('thread opens an explicit or first accessible repository Project and never writes business data', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const mode of ['explicit', 'recommended', 'denied-first']) {
    const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
    t.after(() => workbench.dispose());
    const target = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id };
    const unavailable = { ...target, project_id: randomUUID() };
    f.intercept((name, args) => name === 'cfkanban_projects_get' && args.project_id === unavailable.project_id ? fail('FORBIDDEN') : undefined);
    const args = mode === 'explicit' ? { target } : { recommended_targets: mode === 'denied-first' ? [unavailable, target] : [target] };
    const result = await workbench.callTool('cfkanban_workbench_open', args);
    assert.equal(snapshotOf(result).binding.project.id, target.project_id);
    assert.equal(snapshotOf(result).source_session_id, null);
    assert.equal(f.calls.some(row => /_(create|update|complete|delete)$/.test(row.name)), false);
    assert.equal(snapshotOf(result).error, null);
  }
});

test('an explicit Issue target loads detail before the initial snapshot and remembers only its verified Project', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const reader of [false, true]) {
    const f = fixture({ reader }), saved = [], key = 'e'.repeat(64);
    const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async save(target, repositoryKey) { saved.push({ target, repositoryKey }); return true; } } });
    t.after(() => workbench.dispose());
    const target = { instance_id: f.ids.instance_id.toUpperCase(), workspace_id: f.ids.workspace_id.toUpperCase(), project_id: f.ids.project_id.toUpperCase(), identifier: 'CFK-1' };
    const opened = await workbench.callTool('cfkanban_workbench_open', { target, repository_key: key });
    const state = snapshotOf(opened);
    assert.equal(opened.structuredContent.ok, true);
    assert.equal(state.issue.identifier, target.identifier);
    assert.equal(state.issue.body, f.issue.body);
    assert.deepEqual(state.issue.allowed_actions, reader ? ['read'] : ['read', 'update']);
    assert.equal(state.binding.project.id, f.ids.project_id);
    assert.deepEqual(saved, [{ target: f.ids, repositoryKey: key }]);
    const detail = f.calls.filter(row => row.name === 'cfkanban_issues_get');
    assert.equal(detail.length, 1);
    assert.deepEqual(detail[0].args, { instance_id: f.ids.instance_id, identifier: target.identifier });
    assert.deepEqual(detail[0].config.binding, { instance_id: f.ids.instance_id, expected_principal_id: f.ids.principal_id, project_ids: [f.ids.project_id] });
    assert.ok(f.calls.every(row => !/_(create|update|complete|delete)$/.test(row.name)));
    assert.doesNotMatch(JSON.stringify(opened), /PRIVATE_FIXTURE_MARKER|binding_id|idempotency_key/);
    assert.doesNotMatch(JSON.stringify(opened.structuredContent), /Fixture|CFK-1|body|principal/);
    const back = await call(workbench, viewIdOf(opened), action('issue_back'));
    assert.equal(snapshotOf(back).issue, null);
    const count = f.calls.length;
    const refreshed = await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewIdOf(opened) });
    assert.equal(snapshotOf(refreshed).issue, null);
    assert.equal(f.calls.length, count, 'snapshot refresh must not replay the initial Issue navigation');
  }
});

test('explicit Issue failures retain structured diagnostics and cannot display a different or inaccessible Issue', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const mode of ['forbidden', 'deleted', 'project', 'workspace', 'identifier', 'identity']) {
    const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
    t.after(() => workbench.dispose());
    const target = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id, identifier: 'CFK-1' };
    f.intercept(name => {
      if (name !== 'cfkanban_issues_get') return;
      if (mode === 'forbidden') return fail('FORBIDDEN');
      if (mode === 'deleted') return fail('NOT_FOUND', 404);
      if (mode === 'identity') { f.drift(); return; }
      return ok({ ...f.issue, title: 'UNRELATED_PRIVATE_DETAIL', body: 'UNRELATED_PRIVATE_DETAIL',
        ...(mode === 'project' ? { project: { id: randomUUID() } } : {}),
        ...(mode === 'workspace' ? { workspace: { id: randomUUID() } } : {}),
        ...(mode === 'identifier' ? { identifier: 'CFK-2' } : {}),
      });
    });
    const result = await workbench.callTool('cfkanban_workbench_open', { target });
    const expected = mode === 'forbidden' ? 'FORBIDDEN' : mode === 'deleted' ? 'NOT_FOUND' : mode === 'identity' ? 'MCP_PRINCIPAL_BINDING_MISMATCH' : 'PANEL_SCOPE_DENIED';
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, expected);
    assert.equal(snapshotOf(result).error.code, expected);
    assert.equal(snapshotOf(result).issue, null);
    assert.deepEqual(snapshotOf(result).comments, []);
    assert.equal(snapshotOf(result).binding.project.id, target.project_id);
    assert.ok(workbench.views.has(viewIdOf(result)), 'failed detail navigation retains its verified view');
    assert.doesNotMatch(JSON.stringify(result), /UNRELATED_PRIVATE_DETAIL/);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_projects_get').length, 1);
    assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_list'), false);
  }
});

test('an explicit Issue target does not read detail when its Project binding fails', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  f.intercept(name => name === 'cfkanban_projects_get' ? fail('FORBIDDEN') : undefined);
  const result = await workbench.callTool('cfkanban_workbench_open', { target: { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id, identifier: 'CFK-1' } });
  assert.equal(result.structuredContent.error.code, 'FORBIDDEN');
  assert.equal(snapshotOf(result).binding, null);
  assert.equal(snapshotOf(result).issue, null);
  assert.equal(f.calls.some(row => row.name === 'cfkanban_issues_get' || row.name === 'cfkanban_projects_list'), false);
});

test('Issue target arguments require an explicit Project and reject malformed identifiers before reads', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const project = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id };
  const malformed = ['', 'CFK-', 'CFK-0', 'CFK-01', 'cfk-1', 'ABC-1', 'CFK-1\n', 'CFK-9007199254740992', 'CFK-1000000000000000', 'https://isolated.fixture.invalid/app/issues/CFK-1', null, 1, undefined];
  for (const value of malformed) assert.equal((await workbench.callTool('cfkanban_workbench_open', { target: { ...project, identifier: value } })).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  for (const args of [{ identifier: 'CFK-1' }, { target: { identifier: 'CFK-1' } }, { recommended_targets: [{ ...project, identifier: 'CFK-1' }] }, { repository_key: 'a'.repeat(64), identifier: 'CFK-1' }]) {
    assert.equal((await workbench.callTool('cfkanban_workbench_open', args)).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  }
  assert.equal((await workbench.callTool('cfkanban_workbench_global_open', { target: { ...project, identifier: 'CFK-1' } })).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  assert.equal(f.calls.length, 0);
  assert.equal(workbench.views.size, 0);
});

test('cancelling an initial Issue read aborts its actual I/O and releases only that unfinished view', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const other = viewIdOf(await workbench.callTool('cfkanban_workbench_open', {}));
  let reached, readSignal;
  const started = new Promise(resolve => { reached = resolve; });
  f.intercept((name, _args, signal) => {
    if (name !== 'cfkanban_issues_get') return;
    readSignal = signal; reached();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const cancel = new AbortController(), request = workbench.callTool('cfkanban_workbench_open', { target: { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id, identifier: 'CFK-1' } }, { signal: cancel.signal });
  await started;
  const unfinished = [...workbench.views.keys()].find(id => id !== other);
  assert.equal((await workbench.callTool('cfkanban_workbench_release', { view_id: unfinished })).structuredContent.error.code, 'PANEL_OPERATION_PENDING');
  cancel.abort();
  const result = await request;
  assert.equal(readSignal.aborted, true);
  assert.equal(result.structuredContent.error.code, 'PANEL_REQUEST_UNCERTAIN');
  assert.equal(result._meta, undefined);
  assert.equal(workbench.views.size, 1);
  assert.equal(workbench.views.has(other), true);
});

test('explicit and repository failures retain their diagnostic and do not choose an unrelated default', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const mode of ['explicit-denied', 'recommended-unavailable']) {
    const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
    t.after(() => workbench.dispose());
    const target = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: randomUUID() };
    const code = mode === 'explicit-denied' ? 'FORBIDDEN' : 'NETWORK_ERROR';
    f.intercept((name, args) => name === 'cfkanban_projects_get' && args.project_id === target.project_id ? fail(code) : undefined);
    const args = mode === 'explicit-denied' ? { target } : { recommended_targets: [target, { ...target, project_id: f.ids.project_id }] };
    const state = snapshotOf(await workbench.callTool('cfkanban_workbench_open', args));
    assert.equal(state.binding, null);
    assert.equal(state.error.code, mode === 'explicit-denied' ? code : 'PANEL_REQUEST_UNCERTAIN');
    assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_get' && row.args.project_id === f.ids.project_id), false);
    assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_list'), false);
  }
});

test('repository memory is independent of global and other repositories; explicit targets take precedence', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), key = 'a'.repeat(64), otherKey = 'b'.repeat(64), reads = [], saves = [];
  const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load(k) { reads.push(k); return k === key ? f.ids : null; }, async save(value, k) { saves.push({ value, key: k }); return true; } } });
  t.after(() => workbench.dispose());
  const target = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id };
  const unavailable = { ...target, project_id: randomUUID() };
  f.intercept((name, args) => name === 'cfkanban_projects_get' && args.project_id === unavailable.project_id ? fail('FORBIDDEN') : undefined);
  const remembered = snapshotOf(await workbench.callTool('cfkanban_workbench_open', { recommended_targets: [unavailable], repository_key: key }));
  assert.equal(remembered.binding.project.id, target.project_id);
  assert.deepEqual(reads, [key]);
  assert.deepEqual(saves, [{ value: f.ids, key }]);
  const other = snapshotOf(await workbench.callTool('cfkanban_workbench_open', { recommended_targets: [target], repository_key: otherKey }));
  assert.equal(other.binding.project.id, target.project_id);
  assert.deepEqual(reads, [key, otherKey]);
  const explicit = snapshotOf(await workbench.callTool('cfkanban_workbench_open', { target: unavailable, repository_key: key }));
  assert.equal(explicit.binding, null);
  assert.equal(explicit.error.code, 'FORBIDDEN');
  assert.deepEqual(reads, [key, otherKey]);
  assert.equal(saves.length, 2);
});

test('repository memory reverifies Principal and falls back only for a stale Project under the same identity', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const mode of ['stale-project', 'changed-identity']) {
    const f = fixture(), target = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id }, saved = [];
    const remembered = mode === 'stale-project' ? { ...f.ids, project_id: randomUUID() } : { ...f.ids, principal_id: randomUUID() };
    f.intercept((name, args) => name === 'cfkanban_projects_get' && args.project_id === remembered.project_id && mode === 'stale-project' ? fail('NOT_FOUND', 404) : undefined);
    const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { return remembered; }, async save(value) { saved.push(value); return true; } } });
    t.after(() => workbench.dispose());
    const state = snapshotOf(await workbench.callTool('cfkanban_workbench_open', { recommended_targets: [target], repository_key: 'c'.repeat(64) }));
    if (mode === 'stale-project') { assert.equal(state.binding.project.id, target.project_id); assert.deepEqual(saved, [f.ids]); }
    else { assert.equal(state.binding, null); assert.equal(state.error.code, 'PANEL_IDENTITY_CHANGED'); assert.deepEqual(saved, []); assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_get'), false); }
  }
});

test('a repository key without associations restores its own memory or opens and remembers an accessible default', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const remembered of [false, true]) {
    const f = fixture(), key = 'd'.repeat(64), saved = [], reads = [];
    const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load(k) { reads.push(k); return remembered ? f.ids : null; }, async save(value, k) { saved.push({ value, key: k }); return true; } } });
    t.after(() => workbench.dispose());
    const state = snapshotOf(await workbench.callTool('cfkanban_workbench_open', { repository_key: key }));
    assert.equal(state.binding.project.id, f.ids.project_id);
    assert.deepEqual(reads, [key]);
    assert.deepEqual(saved, [{ value: f.ids, key }]);
  }
});

test('mixed-case repository UUIDs cannot bypass Principal pinning between recommended Projects', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const denied = { instance_id: f.ids.instance_id.toUpperCase(), workspace_id: f.ids.workspace_id.toUpperCase(), project_id: randomUUID().toUpperCase() };
  const target = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id };
  let identityReads = 0;
  f.intercept((name, args) => {
    if (name === 'cfkanban_connection_inspect' && args.instance_id && ++identityReads === 3) f.drift();
    if (name === 'cfkanban_projects_get' && args.project_id === denied.project_id.toLowerCase()) return fail('FORBIDDEN');
  });
  const state = snapshotOf(await workbench.callTool('cfkanban_workbench_open', { recommended_targets: [denied, target] }));
  assert.equal(state.binding, null);
  assert.equal(state.error.code, 'PANEL_IDENTITY_CHANGED');
  assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_get' && row.args.project_id === target.project_id), false);
});

test('thread target inputs reject paths, extra fields, duplicates, oversized lists and invalid preference keys before reads', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const target = { instance_id: f.ids.instance_id, workspace_id: f.ids.workspace_id, project_id: f.ids.project_id };
  for (const args of [{ directory: '/arbitrary' }, { target: { ...target, directory: '/arbitrary' } }, { target: { ...target, project_id: 'invalid' } }, { target, recommended_targets: [target] }, { recommended_targets: [] }, { recommended_targets: [target, target] }, { recommended_targets: Array.from({ length: 51 }, () => ({ ...target, project_id: randomUUID() })) }, { target, repository_key: '../global' }, { target, repository_key: 'a'.repeat(64) + '\n' }]) {
    assert.equal((await workbench.callTool('cfkanban_workbench_open', args)).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  }
  assert.equal((await workbench.callTool('cfkanban_workbench_global_open', { target })).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  assert.equal(f.calls.length, 0);
  assert.equal(workbench.views.size, 0);
});

test('global restores the exact accessible Project even with multiple connections and does not persist a denied target', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), saved = [];
  f.intercept((name, args) => name === 'cfkanban_connection_inspect' && !args.instance_id ? ok({ candidates: [{ instance_id: randomUUID() }, { instance_id: f.ids.instance_id }] }) : undefined);
  const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { return f.ids; }, async save(target) { saved.push(target); return true; } } });
  t.after(() => workbench.dispose());
  const opened = await workbench.callTool('cfkanban_workbench_global_open', {});
  assert.equal(snapshotOf(opened).binding.project.id, f.ids.project_id);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_projects_list').length, 1);
  assert.equal(f.calls.find(row => row.name === 'cfkanban_projects_get').args.project_id, f.ids.project_id);
  assert.deepEqual(saved, [f.ids]);
  const stale = { ...f.ids, project_id: randomUUID() };
  f.intercept((name, args) => name === 'cfkanban_projects_get' && args.project_id === stale.project_id ? fail('NOT_FOUND', 404) : undefined);
  const fallback = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { return stale; }, async save(target) { saved.push(target); return true; } } });
  t.after(() => fallback.dispose());
  assert.equal(snapshotOf(await fallback.callTool('cfkanban_workbench_global_open', {})).binding.project.id, f.ids.project_id);
  assert.deepEqual(saved, [f.ids, f.ids]);
});

test('global preserves identity drift and network diagnostics and asks for an unknown multi-connection choice', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const mode of ['drift', 'network', 'multiple']) {
    const f = fixture(), saved = [];
    if (mode === 'drift') f.drift();
    if (mode === 'network') f.intercept(name => name === 'cfkanban_projects_get' ? fail('NETWORK_ERROR', 0) : undefined);
    if (mode === 'multiple') f.intercept((name, args) => name === 'cfkanban_connection_inspect' && !args.instance_id ? ok({ candidates: [{ instance_id: f.ids.instance_id }, { instance_id: randomUUID() }] }) : undefined);
    const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { return mode === 'multiple' ? null : f.ids; }, async save(target) { saved.push(target); return true; } } });
    t.after(() => workbench.dispose());
    const state = snapshotOf(await workbench.callTool('cfkanban_workbench_global_open', {}));
    assert.equal(state.binding, null);
    assert.equal(state.error?.code, mode === 'drift' ? 'PANEL_IDENTITY_CHANGED' : mode === 'network' ? 'PANEL_REQUEST_UNCERTAIN' : undefined);
    assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_list'), mode === 'network');
    assert.deepEqual(saved, []);
  }
});

test('choosing a connection immediately binds an accessible Project within the global or repository preference scope', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const mode of ['global', 'repository', 'conversation']) {
    const f = fixture(), reads = [], saves = [], key = 'e'.repeat(64);
    f.intercept((name, args) => name === 'cfkanban_connection_inspect' && !args.instance_id ? ok({ candidates: [{ instance_id: f.ids.instance_id }, { instance_id: randomUUID() }] }) : undefined);
    const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load(k) { reads.push(k); return null; }, async save(target, k) { saves.push({ target, key: k }); return true; } } });
    t.after(() => workbench.dispose());
    const opened = await workbench.callTool(mode === 'global' ? 'cfkanban_workbench_global_open' : 'cfkanban_workbench_open', mode === 'repository' ? { repository_key: key } : {});
    assert.equal(snapshotOf(opened).binding, null);
    const selected = await call(workbench, viewIdOf(opened), action('select_instance', { instance_id: f.ids.instance_id }));
    assert.equal(selected.structuredContent.ok, true);
    assert.equal(snapshotOf(selected).binding.project.id, f.ids.project_id);
    assert.equal(snapshotOf(selected).binding.identity.principal.principal_id, f.ids.principal_id);
    assert.equal(snapshotOf(selected).error, null);
    assert.deepEqual(reads, mode === 'global' ? [undefined, undefined] : mode === 'repository' ? [key, key] : []);
    assert.deepEqual(saves, mode === 'conversation' ? [] : [{ target: f.ids, key: mode === 'repository' ? key : undefined }]);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_projects_get').length, 1);
    assert.ok(f.calls.every(row => !/_(create|update|complete|delete)$/.test(row.name)));
    assert.deepEqual(selected._meta['cfkanban/actionReceipt'].result, { ok: true });
  }
});

test('manual connection selection restores only that connection’s saved Project and preserves Principal and network diagnostics', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const mode of ['saved', 'other-instance', 'not-found', 'forbidden', 'drift', 'network']) {
    const f = fixture(), saved = [];
    let remembered = null;
    const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { return remembered; }, async save(target) { saved.push(target); return true; } } });
    t.after(() => workbench.dispose());
    const unavailable = randomUUID();
    f.intercept((name, args) => {
      if (name === 'cfkanban_connection_inspect' && !args.instance_id) return ok({ candidates: [{ instance_id: f.ids.instance_id }, { instance_id: randomUUID() }] });
      if (name === 'cfkanban_projects_get' && args.project_id === unavailable) return fail(mode === 'not-found' ? 'NOT_FOUND' : mode === 'forbidden' ? 'FORBIDDEN' : 'NETWORK_ERROR', mode === 'not-found' ? 404 : mode === 'forbidden' ? 403 : 0);
    });
    const opened = await workbench.callTool('cfkanban_workbench_global_open', {});
    remembered = { ...f.ids, ...(mode === 'other-instance' ? { instance_id: randomUUID(), principal_id: randomUUID(), project_id: unavailable } : mode === 'drift' ? { principal_id: randomUUID() } : ['not-found', 'forbidden', 'network'].includes(mode) ? { project_id: unavailable } : {}) };
    const result = await call(workbench, viewIdOf(opened), action('select_instance', { instance_id: f.ids.instance_id }));
    const state = snapshotOf(result);
    if (mode === 'drift' || mode === 'network') {
      assert.equal(result.structuredContent.ok, false);
      assert.equal(state.binding, null);
      assert.equal(state.error.code, mode === 'drift' ? 'PANEL_IDENTITY_CHANGED' : 'PANEL_REQUEST_UNCERTAIN');
      assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_get' && row.args.project_id === f.ids.project_id), false);
      assert.equal(f.calls.filter(row => row.name === 'cfkanban_workspaces_list').length, 0);
      assert.deepEqual(saved, []);
    } else {
      assert.equal(result.structuredContent.ok, true);
      assert.equal(state.binding.project.id, f.ids.project_id);
      assert.deepEqual(saved, [f.ids]);
      assert.equal(f.calls.some(row => row.name === 'cfkanban_projects_get' && row.args.project_id === unavailable), ['not-found', 'forbidden'].includes(mode));
      assert.equal(f.calls.filter(row => row.name === 'cfkanban_workspaces_list').length, mode === 'saved' ? 0 : 1);
    }
    assert.ok(f.calls.every(row => !/_(create|update|complete|delete)$/.test(row.name)));
  }
});

test('manual connection selection keeps its receipt pending until automatic binding completes and does not repeat reads or binding', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), saved = [];
  let start, settle;
  const started = new Promise(resolve => { start = resolve; });
  f.intercept((name, args) => {
    if (name === 'cfkanban_connection_inspect' && !args.instance_id) return ok({ candidates: [{ instance_id: f.ids.instance_id }, { instance_id: randomUUID() }] });
    if (name === 'cfkanban_projects_get') { start(); return new Promise(resolve => { settle = resolve; }); }
  });
  const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { return null; }, async save(target) { saved.push(target); return true; } } });
  t.after(() => workbench.dispose());
  const viewId = viewIdOf(await workbench.callTool('cfkanban_workbench_global_open', {}));
  const message = action('select_instance', { instance_id: f.ids.instance_id });
  const running = call(workbench, viewId, message);
  await started;
  const before = f.calls.length;
  const inFlight = await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId, action_id: message.id });
  assert.equal(inFlight._meta['cfkanban/actionReceipt'].result, null);
  assert.equal(snapshotOf(inFlight).binding, null);
  assert.deepEqual((await call(workbench, viewId, message)).structuredContent.error, { code: 'PANEL_OPERATION_PENDING' });
  assert.equal((await workbench.callTool('cfkanban_workbench_release', { view_id: viewId })).structuredContent.error.code, 'PANEL_OPERATION_PENDING');
  assert.equal(f.calls.length, before);
  settle(ok({ id: f.ids.project_id, workspace_id: f.ids.workspace_id, display_name: 'Fixture project' }));
  const completed = await running;
  assert.equal(completed.structuredContent.ok, true);
  assert.equal(snapshotOf(completed).binding.project.id, f.ids.project_id);
  assert.deepEqual(completed._meta['cfkanban/actionReceipt'].result, { ok: true });
  const after = f.calls.length, duplicate = await call(workbench, viewId, message);
  assert.equal(duplicate.structuredContent.ok, true);
  assert.deepEqual(snapshotOf(duplicate).binding, snapshotOf(completed).binding);
  assert.equal(f.calls.length, after);
  assert.deepEqual(saved, [f.ids]);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_projects_get').length, 1);
  assert.ok(f.calls.every(row => !/_(create|update|complete|delete)$/.test(row.name)));
});

test('cancelling automatic Project binding retains a failed selection receipt without remembering or rebinding its target', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), saved = [];
  let start;
  const started = new Promise(resolve => { start = resolve; });
  f.intercept((name, args, signal) => {
    if (name === 'cfkanban_connection_inspect' && !args.instance_id) return ok({ candidates: [{ instance_id: f.ids.instance_id }, { instance_id: randomUUID() }] });
    if (name === 'cfkanban_projects_get') { start(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
  });
  const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { return null; }, async save(target) { saved.push(target); return true; } } });
  t.after(() => workbench.dispose());
  const viewId = viewIdOf(await workbench.callTool('cfkanban_workbench_global_open', {}));
  const cancel = new AbortController(), message = action('select_instance', { instance_id: f.ids.instance_id });
  const running = call(workbench, viewId, message, cancel.signal);
  await started;
  cancel.abort();
  const canceled = await running;
  assert.equal(canceled.structuredContent.ok, false);
  assert.equal(canceled.structuredContent.error.code, 'PANEL_REQUEST_UNCERTAIN');
  assert.equal(snapshotOf(canceled).binding, null);
  assert.equal(snapshotOf(canceled).identity.principal.principal_id, f.ids.principal_id);
  assert.deepEqual(saved, []);
  assert.equal(workbench.views.size, 1);
  const before = f.calls.length;
  const duplicate = await call(workbench, viewId, message);
  assert.equal(duplicate.structuredContent.ok, false);
  assert.equal(duplicate.structuredContent.error.code, 'PANEL_REQUEST_UNCERTAIN');
  assert.equal(f.calls.length, before);
  assert.deepEqual(duplicate._meta['cfkanban/actionReceipt'].result, canceled._meta['cfkanban/actionReceipt'].result);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_projects_get').length, 1);
  assert.ok(f.calls.every(row => !/_(create|update|complete|delete)$/.test(row.name)));
});

test('an uncertain write rejects connection selection before reading preferences or changing the binding', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture({ unknownCreate: true });
  let reads = 0;
  const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { reads++; return null; }, async save() { return true; } } });
  t.after(() => workbench.dispose());
  const viewId = viewIdOf(await workbench.callTool('cfkanban_workbench_global_open', {}));
  const created = await call(workbench, viewId, action('create_issue', { change: { title: 'Pending fixture' } }));
  assert.equal(created.structuredContent.outcome_unknown, true);
  const binding = snapshotOf(created).binding, before = f.calls.length;
  const result = await call(workbench, viewId, action('select_instance', { instance_id: f.ids.instance_id }));
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'PANEL_INVALID_INPUT');
  assert.equal(snapshotOf(result).pending.operation, 'create');
  assert.deepEqual(snapshotOf(result).binding, binding);
  assert.equal(reads, 1);
  assert.equal(f.calls.length, before);
  assert.equal(f.creations, 1);
});

test('global preference failures and an empty accessible list preserve a usable picker', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const empty of [false, true]) {
    const f = fixture();
    if (empty) f.intercept(name => name === 'cfkanban_projects_list' ? ok({ items: [] }) : undefined);
    const workbench = new McpWorkbench({ createFacade: f.createFacade, preferences: { async load() { throw new Error('unavailable'); }, async save() { return false; } } });
    t.after(() => workbench.dispose());
    const state = snapshotOf(await workbench.callTool('cfkanban_workbench_global_open', {}));
    assert.equal(Boolean(state.binding), !empty);
    assert.equal(state.error, null);
    assert.equal(state.identity.principal.principal_id, f.ids.principal_id);
  }
});

test('entrypoint advertises a bundled monochrome navigation SVG without a host filesystem or network dependency', async () => {
  const { workbenchTools } = await workbenchExports();
  const [icon] = workbenchTools('fixture-version')[0].icons;
  assert.deepEqual(IconSchema.parse(icon), icon);
  assert.equal(icon.mimeType, 'image/svg+xml');
  assert.deepEqual(icon.sizes, ['20x20']);
  assert.match(icon.src, /^data:image\/svg\+xml;base64,/);
  const image = Buffer.from(icon.src.slice('data:image/svg+xml;base64,'.length), 'base64');
  assert.deepEqual(image, await readFile(new URL('../../../apps/web/src/assets/cfkanban-mark.svg', import.meta.url)));
  const svg = image.toString('utf8');
  assert.match(svg, /viewBox="0 0 20 20"/);
  assert.match(svg, /fill="none" stroke="currentColor"/);
  assert.match(svg, /stroke-width="1\.333" stroke-linecap="round" stroke-linejoin="round"/);
  assert.doesNotMatch(svg, /<(?:image|text|filter|script|foreignObject)\b|(?:href|style)=|url\(/i);
});

test('app-only annotations never authorize calls; stale view IDs and unknown or private input fields are rejected', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const viewId = viewIdOf(await workbench.callTool('cfkanban_workbench_open', {}));
  const before = f.calls.length;
  for (const [args, code] of [[{}, 'MCP_APP_VIEW_ID_MISSING'], [{ view_id: 'wrong' }, 'MCP_APP_VIEW_ID_INVALID'], [{ view_id: null }, 'MCP_APP_VIEW_ID_INVALID'], [{ view_id: viewId.slice(0, -1) + '!' }, 'MCP_APP_VIEW_ID_INVALID']]) assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', args)).structuredContent.error.code, code);
  for (const args of [{ viewId }, { stateRoot: '/arbitrary' }, { instance_id: f.ids.instance_id }]) assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId, ...args })).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', {}, { meta: { 'cfkanban/viewId': viewId } })).structuredContent.error.code, 'MCP_APP_VIEW_ID_MISSING');
  assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', { view_id: randomUUID() })).structuredContent.error.code, 'PANEL_BINDING_EXPIRED');
  for (const message of [action('bind', { project_id: f.ids.project_id, binding_id: randomUUID() }), action('mutate', { operation: 'update', expected_version: 1, idempotency_key: 'client-key', change: { priority_key: 'high' } }), action('unknown'), { ...action('manual'), session_id: randomUUID() }]) assert.equal((await call(workbench, viewId, message)).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  assert.equal(f.calls.length, before);
  assert.equal((await workbench.callTool('cfkanban_workbench_release', { view_id: viewId })).structuredContent.ok, true);
  assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId })).structuredContent.error.code, 'PANEL_BINDING_EXPIRED');
});

test('bound identity drift, reader permission and displayed CAS prevent unauthorized writes', async t => {
  const { McpWorkbench } = await workbenchExports();
  for (const scenario of ['drift', 'reader', 'revoke', 'conflict']) {
    const f = fixture({ reader: scenario === 'reader' }), workbench = new McpWorkbench({ createFacade: f.createFacade });
    t.after(() => workbench.dispose());
    const viewId = await boundView(workbench, f);
    if (scenario !== 'reader') f[scenario]();
    const result = await call(workbench, viewId, action('mutate', { operation: 'update', change: { priority_key: 'high' } }));
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, { drift: 'MCP_PRINCIPAL_BINDING_MISMATCH', reader: 'PANEL_INVALID_INPUT', revoke: 'PANEL_PERMISSION_DENIED', conflict: 'PANEL_VERSION_CONFLICT' }[scenario]);
    assert.equal(f.commits, 0);
    assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 0);
    assert.ok(f.calls.filter(row => row.name === 'cfkanban_issues_get').every(row => row.config.binding.expected_principal_id === f.ids.principal_id && row.config.binding.project_ids[0] === f.ids.project_id));
  }
});

test('duplicate action receipts and explicit recovery retain one original write key; pending views cannot release or expire', async t => {
  const { McpWorkbench } = await workbenchExports();
  let time = 0;
  const f = fixture({ unknown: true }), workbench = new McpWorkbench({ createFacade: f.createFacade, now: () => time, idleMs: 100, maxViews: 2 });
  t.after(() => workbench.dispose());
  const viewId = await boundView(workbench, f), message = action('mutate', { operation: 'update', change: { priority_key: 'high' } });
  const result = await call(workbench, viewId, message);
  assert.equal(result.structuredContent.outcome_unknown, true);
  assert.equal(snapshotOf(result).pending.operation, 'update');
  assert.doesNotMatch(JSON.stringify(result), /binding_id|idempotency_key|PRIVATE_FIXTURE_MARKER/);
  assert.equal(f.commits, 1);
  await call(workbench, viewId, message);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_update').length, 1);
  assert.equal((await call(workbench, viewId, { ...message, payload: { operation: 'update', change: { priority_key: 'low' } } })).structuredContent.error.code, 'PANEL_KEY_REUSED');
  const release = () => workbench.callTool('cfkanban_workbench_release', { view_id: viewId });
  assert.equal((await release()).structuredContent.outcome_unknown, true);
  const idle = viewIdOf(await workbench.callTool('cfkanban_workbench_open', {}));
  time = 200;
  assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', { view_id: idle })).structuredContent.error.code, 'PANEL_BINDING_EXPIRED');
  assert.ok(snapshotOf(await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId })).pending);
  assert.equal((await release()).structuredContent.error.code, 'PANEL_OPERATION_PENDING');
  const recovered = await call(workbench, viewId, action('recover'));
  assert.equal(recovered.structuredContent.ok, true);
  assert.equal(snapshotOf(recovered).pending, null);
  const writes = f.calls.filter(row => row.name === 'cfkanban_issues_update');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].args, writes[0].args);
  assert.equal(f.commits, 1);
  assert.equal((await release()).structuredContent.ok, true);
});

test('create and body edits use one original operation, and uncertain creation recovers without a replacement Issue', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture({ unknownCreate: true }), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const viewId = await boundView(workbench, f);
  const message = action('create_issue', { change: { title: 'Created from workbench', body: '**Raw Markdown**', priority_key: 'high' } });
  const result = await call(workbench, viewId, message);
  assert.equal(result.structuredContent.outcome_unknown, true);
  assert.equal(snapshotOf(result).pending.operation, 'create');
  assert.equal(f.creations, 1);
  await call(workbench, viewId, message);
  assert.equal(f.calls.filter(row => row.name === 'cfkanban_issues_create').length, 1);
  assert.equal((await call(workbench, viewId, action('recover'))).structuredContent.ok, true);
  const writes = f.calls.filter(row => row.name === 'cfkanban_issues_create');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].args, writes[0].args);
  assert.equal(writes[0].args.project_id, f.ids.project_id);
  assert.equal(writes[0].args.workspace_id, f.ids.workspace_id);
  assert.equal(writes[0].args.expected_version, undefined);
  assert.equal(writes[0].args.identifier, undefined);
  assert.equal(f.creations, 1);
  const edit = await call(workbench, viewId, action('mutate', { operation: 'update', change: { title: 'Edited title', body: '' } }));
  assert.equal(edit.structuredContent.ok, true);
  assert.equal(snapshotOf(edit).issue.title, 'Edited title');
  assert.equal(snapshotOf(edit).issue.body, '');
  assert.equal(f.commits, 1);
  assert.doesNotMatch(JSON.stringify(edit), /binding_id|idempotency_key|PRIVATE_FIXTURE_MARKER/);
  const reader = fixture({ reader: true }), readWorkbench = new McpWorkbench({ createFacade: reader.createFacade });
  t.after(() => readWorkbench.dispose());
  const readHandle = await boundView(readWorkbench, reader);
  assert.equal((await call(readWorkbench, readHandle, action('create_issue', { change: { title: 'Denied' } }))).structuredContent.ok, false);
  assert.equal(reader.creations, 0);
});

test('cancellation reaches the facade without disposing the view or replacing an in-flight action signal', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const viewId = await boundView(workbench, f);
  let reached, observed;
  const started = new Promise(resolve => { reached = resolve; });
  f.intercept((name, _args, signal) => {
    if (name !== 'cfkanban_issues_update') return;
    observed = signal;
    reached();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const cancel = new AbortController(), message = action('mutate', { operation: 'update', change: { priority_key: 'high' } });
  const pending = call(workbench, viewId, message, cancel.signal);
  await started;
  const other = new AbortController();
  const duplicate = await call(workbench, viewId, message, other.signal);
  assert.equal(duplicate.structuredContent.error.code, 'PANEL_OPERATION_PENDING');
  other.abort();
  assert.equal(observed.aborted, false);
  assert.equal((await workbench.callTool('cfkanban_workbench_release', { view_id: viewId })).structuredContent.error.code, 'PANEL_OPERATION_PENDING');
  cancel.abort();
  assert.equal((await pending).structuredContent.outcome_unknown, true);
  assert.equal(observed.aborted, true);
  assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId })).structuredContent.ok, true);
  assert.ok(snapshotOf(await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId })).pending);
  assert.equal(workbench.views.size, 1);
});

test('snapshot action receipts distinguish in-flight and settled writes and remain isolated per view', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const viewId = await boundView(workbench, f);
  const other = viewIdOf(await workbench.callTool('cfkanban_workbench_open', {}));
  let reached, finish;
  const started = new Promise(resolve => { reached = resolve; });
  const delayed = new Promise(resolve => { finish = resolve; });
  f.intercept((name) => {
    if (name !== 'cfkanban_issues_create') return;
    reached();
    return delayed;
  });
  const message = action('create_issue', { change: { title: 'Delayed creation' } });
  const request = call(workbench, viewId, message);
  await started;
  const snapshot = viewId => workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId, action_id: message.id });
  const inFlight = await snapshot(viewId);
  assert.deepEqual(inFlight._meta['cfkanban/actionReceipt'], { id: message.id, result: null });
  assert.deepEqual((await snapshot(other))._meta['cfkanban/actionReceipt'], { id: message.id, result: null });
  assert.equal(snapshotOf(inFlight).pending.operation, 'create');
  finish();
  const result = await request;
  assert.deepEqual(result._meta['cfkanban/actionReceipt'], { id: message.id, result: { ok: true } });
  const settled = await snapshot(viewId);
  assert.equal(snapshotOf(settled).pending, null);
  assert.deepEqual(settled._meta['cfkanban/actionReceipt'], { id: message.id, result: { ok: true } });
  assert.deepEqual((await snapshot(other))._meta['cfkanban/actionReceipt'], { id: message.id, result: null });
  assert.equal(f.creations, 1);
  assert.doesNotMatch(JSON.stringify(settled._meta['cfkanban/actionReceipt']), /fingerprint|change|idempotency_key|binding_id|Delayed creation/);
  assert.doesNotMatch(JSON.stringify(settled.structuredContent), /actionReceipt|actionId|Delayed creation/);
  for (const invalid of ['', 'client-key', 123, null]) assert.equal((await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId, action_id: invalid })).structuredContent.error.code, 'MCP_INVALID_ARGUMENTS');
  const absent = await workbench.callTool('cfkanban_workbench_snapshot', { view_id: viewId, action_id: randomUUID() });
  assert.equal(absent._meta['cfkanban/actionReceipt'].result, null);
});

test('capacity is bounded and disposal is idempotent and aborts every live facade request', async () => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade, maxViews: 1 });
  const viewId = viewIdOf(await workbench.callTool('cfkanban_workbench_open', {}));
  assert.equal((await workbench.callTool('cfkanban_workbench_open', {})).structuredContent.error.code, 'PANEL_CAPACITY');
  let reached, signal;
  const started = new Promise(resolve => { reached = resolve; });
  f.intercept((name, args, incoming) => {
    if (name !== 'cfkanban_connection_inspect' || !args.instance_id) return;
    signal = incoming; reached();
    return new Promise((_, reject) => incoming.addEventListener('abort', () => reject(incoming.reason), { once: true }));
  });
  const running = call(workbench, viewId, action('select_instance', { instance_id: f.ids.instance_id }));
  await started;
  workbench.dispose(); workbench.dispose();
  await running;
  assert.equal(signal.aborted, true);
  assert.equal(workbench.views.size, 0);
  assert.equal((await workbench.callTool('cfkanban_workbench_open', {})).structuredContent.error.code, 'PANEL_BINDING_EXPIRED');
});

test('cancelled discovery reports failure, preserves its view and never stores a successful receipt', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  const viewId = viewIdOf(await workbench.callTool('cfkanban_workbench_open', {}));
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  f.intercept((name, args, signal) => {
    if (name !== 'cfkanban_connection_inspect' || !args.instance_id) return;
    reached();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const cancel = new AbortController(), message = action('select_instance', { instance_id: f.ids.instance_id });
  const request = call(workbench, viewId, message, cancel.signal);
  await started; cancel.abort();
  const result = await request;
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'PANEL_REQUEST_UNCERTAIN');
  assert.equal(snapshotOf(result).identity, null);
  assert.equal(workbench.views.size, 1);
  const calls = f.calls.length;
  assert.equal((await call(workbench, viewId, message)).structuredContent.ok, false);
  assert.equal(f.calls.length, calls);
  f.intercept(undefined);
  assert.equal((await call(workbench, viewId, action('select_instance', { instance_id: f.ids.instance_id }))).structuredContent.ok, true);
});

test('cancelled entrypoint discovery releases its unbound view without returning a viewId', async t => {
  const { McpWorkbench } = await workbenchExports();
  const f = fixture(), workbench = new McpWorkbench({ createFacade: f.createFacade });
  t.after(() => workbench.dispose());
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  f.intercept((name, _args, signal) => {
    if (name !== 'cfkanban_connection_inspect') return;
    reached();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const cancel = new AbortController(), request = workbench.callTool('cfkanban_workbench_open', {}, { signal: cancel.signal });
  await started; cancel.abort();
  const result = await request;
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result._meta, undefined);
  assert.equal(workbench.views.size, 0);
});

test('official MCP resources and tools preserve metadata, restrict the resource URI and clean up at transport close', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cfkanban-mcp-ui-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, 'server.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], outfile: entry, bundle: true, format: 'esm', platform: 'node', loader: { '.svg': 'text' }, banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" } });
  const { createCfKanbanMcpServer } = await import(pathToFileURL(entry).href);
  const f = fixture();
  const hints = [];
  const searchIndex = { start() {}, hint(value) { hints.push(value); }, dispose() {} };
  const server = createCfKanbanMcpServer({ facade: { listTools: () => [], callTool: async () => fail('MCP_TOOL_NOT_FOUND', 0) }, createFacade: f.createFacade, searchIndex, uiHtml: '<!doctype html><title>Fixture UI</title>' });
  const client = new Client({ name: 'isolated-ui-fixture', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 6);
  const uri = tools[0]._meta.ui.resourceUri;
  assert.equal(uri, `ui://cfkanban/workbench/source/${createHash('sha256').update('<!doctype html><title>Fixture UI</title>').digest('hex')}/index.html`);
  assert.deepEqual(tools[0]._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  assert.equal((await client.listResources()).resources[0].uri, uri);
  const resource = (await client.readResource({ uri })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.equal(resource.text, '<!doctype html><title>Fixture UI</title>');
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
  assert.deepEqual(resource._meta.ui.permissions, { clipboardWrite: {} });
  assert.deepEqual(resource._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' });
  for (const invalid of ['file:///etc/passwd', 'ui://cfkanban/workbench/other/index.html', uri + '?path=/arbitrary']) await assert.rejects(client.readResource({ uri: invalid }), /Unknown cfKanban resource/);
  const opened = await client.callTool({ name: 'cfkanban_workbench_open', arguments: {} });
  assert.match(viewIdOf(opened), /^[0-9a-f-]{36}$/);
  assert.equal((await client.callTool({ name: 'cfkanban_workbench_snapshot', arguments: { view_id: viewIdOf(opened) } })).structuredContent.ok, true);
  const perform = message => client.callTool({ name: 'cfkanban_workbench_action', arguments: { view_id: viewIdOf(opened), message } });
  assert.equal((await perform(action('create_issue', { change: { title: 'New workbench Issue' } }))).structuredContent.ok, true);
  assert.equal((await perform(action('quick_update', { identifier: f.issue.identifier, change: { title: 'Updated workbench title' } }))).structuredContent.ok, true);
  assert.equal((await perform(action('quick_update', { identifier: f.issue.identifier, change: { body: 'Updated body' } }))).structuredContent.ok, true);
  assert.equal((await perform(action('open_issue', { identifier: f.issue.identifier }))).structuredContent.ok, true);
  assert.equal((await perform(action('mutate', { operation: 'comment', change: { body: 'Added comment' } }))).structuredContent.ok, true);
  f.revoke();
  assert.equal((await perform(action('quick_update', { identifier: f.issue.identifier, change: { title: 'Refused title' } }))).structuredContent.ok, false);
  assert.deepEqual(hints, [{ instance_id: f.ids.instance_id }, { instance_id: f.ids.instance_id }], 'workbench writes must reach the same search hint hook as ordinary MCP tools');
  await client.close();
  await server.close();
});
