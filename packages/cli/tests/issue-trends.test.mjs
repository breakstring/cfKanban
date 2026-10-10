import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { API_COMMANDS } from '../src/catalog.mjs';
import { parseArguments } from '../src/parser.mjs';
import { createContextResolver } from '../src/context.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';

const command = name => API_COMMANDS.find(item => item.name === name);
const authenticatedFetch = f => async url => {
  assert.equal(url.origin, f.origin);
  if (url.pathname === '/.well-known/cfkanban-instance.json') return Response.json(f.discovery);
  if (url.pathname === '/api/v1/me') return Response.json(f.me(f.credential));
  assert.fail(`Unexpected fixture route ${url.pathname}`);
};

test('CLI trend commands accept only bounded date and explicit scope selectors', async () => {
  const id = randomUUID();
  const parsed = await parseArguments(['issue', 'trends', '--days', '30', '--milestone', id]);
  assert.equal(parsed.command.operation, 'getProjectIssueTrends');
  assert.deepEqual(parsed.input, { days: 30, milestone: id });
  const workspace = await parseArguments(['workspace', 'issue', 'trends', '--project', id, '--project', randomUUID(), '--days', '365']);
  assert.equal(workspace.command.operation, 'getWorkspaceIssueTrends');
  assert.equal(workspace.input.project.length, 2);
  for (const value of ['0', '366', '2.5']) await assert.rejects(parseArguments(['issue', 'trends', '--days', value]), { code: 'CLI_INVALID_ARGUMENT' });
  for (const [flag, value] of [['status', 'done'], ['cursor', 'next'], ['milestone', 'none']]) await assert.rejects(parseArguments(['issue', 'trends', `--${flag}`, value]));
});

test('Workspace trend context fills Workspace but does not inherit a repository Project filter', async t => {
  const f = await createMcpStateFixture(t);
  const scopeInspector = async () => ({ scope_directory: f.home, git: { status: 'repository', root: f.home }, scope: { targets: [{ instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId }] } });
  const resolver = createContextResolver({ ...f, directory: f.home, scopeInspector, read: async (_instance, apiPath) => ({ ok: true, data: { id: apiPath.endsWith(f.workspaceId) ? f.workspaceId : f.projectId, workspace_id: f.workspaceId } }) });
  const result = await resolver.resolve(command('workspace issue trends'), { days: 30 });
  assert.deepEqual(result.input, { days: 30, instanceId: f.instanceId, workspace_id: f.workspaceId });
  assert.equal(result.input.project, undefined);
});

test('CLI checks trend support and forwards UTC window, milestone and repeated Workspace Projects', async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const data = { points: [{ date: '2026-10-10', completed: 2, unfinished: null }] };
  const runtime = createCliRuntime({ ...f, fetchImpl: authenticatedFetch(f), requestImpl: async request => {
    calls.push(request);
    return { ok: true, status: 200, data: request.apiPath === '/api/v1/meta' ? { capabilities: { issue_trends: true } } : data };
  } });
  const milestone = randomUUID();
  const target = { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId };
  assert.deepEqual((await runtime.execute(command('issue trends'), { ...target, days: 90, milestone })).data, data);
  assert.equal(calls[0].apiPath, '/api/v1/meta');
  const projectUrl = new URL(calls[1].apiPath, f.origin);
  assert.equal(projectUrl.pathname, `/api/v1/workspaces/${f.workspaceId}/projects/${f.projectId}/issues/trends`);
  assert.equal(projectUrl.searchParams.get('days'), '90');
  assert.equal(projectUrl.searchParams.get('milestone'), milestone);
  const project = [f.projectId, randomUUID()];
  await runtime.execute(command('workspace issue trends'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project, days: 1 });
  assert.deepEqual(new URL(calls.at(-1).apiPath, f.origin).searchParams.getAll('project'), project);
  assert.ok(calls.every(request => request.method === 'GET' && request.body === undefined && request.idempotencyKey === undefined));
});

test('CLI unsupported trends stop without ordinary Issue-page fallback', async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const runtime = createCliRuntime({ ...f, fetchImpl: authenticatedFetch(f), requestImpl: async request => {
    calls.push(request.apiPath);
    return { ok: true, status: 200, data: { capabilities: {} } };
  } });
  await assert.rejects(runtime.execute(command('issue trends'), { instanceId: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId }), { code: 'CLI_ISSUE_TRENDS_UNSUPPORTED' });
  assert.deepEqual(calls, ['/api/v1/meta']);
});
