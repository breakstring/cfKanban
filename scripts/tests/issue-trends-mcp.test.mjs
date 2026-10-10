import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMcpFacade } from '../../packages/skill-runtime/src/mcp-facade.mjs';
import { createMcpStateFixture } from './mcp-fixture.mjs';

const trendTool = 'cfkanban_project_issue_trends';
const workspaceTool = 'cfkanban_workspace_issue_trends';
function adapter(fixture, handler, options = {}) {
  return createMcpFacade({ ...fixture, ...options, fetchImpl: async (url, request) => {
    assert.equal(url.origin, fixture.origin);
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'manual');
    if (url.pathname === '/.well-known/cfkanban-instance.json') return Response.json(fixture.discovery);
    if (url.pathname === '/api/v1/me') return Response.json(fixture.me(fixture.credential));
    return handler(url, request);
  } });
}

test('MCP trend reads forward only bounded date/scope selection and preserve unavailable points', async t => {
  const f = await createMcpStateFixture(t);
  f.discovery.capabilities = { issue_trends: true };
  const calls = [];
  const resultData = { timezone: 'UTC', points: [{ date: '2026-10-10', unfinished: null, completed: 2 }], scope: { project_ids: [f.projectId] } };
  const facade = adapter(f, url => { calls.push(url); return Response.json(resultData); });
  const milestone = randomUUID();
  const target = { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId };
  const result = await facade.callTool(trendTool, { ...target, days: 365, milestone });
  assert.deepEqual(result.data, resultData);
  assert.equal(result.data.points[0].unfinished, null);
  assert.equal(calls[0].pathname, `/api/v1/workspaces/${f.workspaceId}/projects/${f.projectId}/issues/trends`);
  assert.deepEqual([...calls[0].searchParams], [['days', '365'], ['milestone', milestone]]);
  const other = randomUUID();
  await facade.callTool(workspaceTool, { instance_id: f.instanceId, workspace_id: f.workspaceId, project_ids: [f.projectId, other], days: 1 });
  assert.equal(calls[1].pathname, `/api/v1/workspaces/${f.workspaceId}/issues/trends`);
  assert.deepEqual(calls[1].searchParams.getAll('project'), [f.projectId, other]);
  await facade.callTool(workspaceTool, { instance_id: f.instanceId, workspace_id: f.workspaceId });
  assert.equal(calls[2].search, '');
});

test('missing trend capability stops before any trend or Issue-list request', async t => {
  const f = await createMcpStateFixture(t);
  let calls = 0;
  const facade = adapter(f, () => { calls++; assert.fail('No history fallback is allowed'); });
  const result = await facade.callTool(trendTool, { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId });
  assert.equal(result.error.code, 'MCP_ISSUE_TRENDS_UNSUPPORTED');
  assert.equal(calls, 0);
});

test('bound Workspace trend reads project only its binding and reject foreign scope', async t => {
  const f = await createMcpStateFixture(t);
  f.discovery.capabilities = { issue_trends: true };
  const calls = [];
  const facade = adapter(f, url => { calls.push(url); return Response.json({ points: [] }); }, { binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] } });
  const target = { instance_id: f.instanceId, workspace_id: f.workspaceId };
  assert.equal((await facade.callTool(workspaceTool, target)).ok, true);
  assert.deepEqual(calls[0].searchParams.getAll('project'), [f.projectId]);
  const foreign = randomUUID();
  assert.equal((await facade.callTool(workspaceTool, { ...target, project_ids: [foreign] })).error.code, 'MCP_PROJECT_BINDING_MISMATCH');
  assert.equal((await facade.callTool(trendTool, { ...target, project_id: foreign })).error.code, 'MCP_PROJECT_BINDING_MISMATCH');
  assert.equal(calls.length, 1);
});

test('trend schemas reject filters, invalid windows and oversized scope before network', async () => {
  const facade = createMcpFacade({ fetchImpl: () => assert.fail('Invalid schema must not reach network') });
  const target = { instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() };
  for (const extension of [{ days: 0 }, { days: 366 }, { days: 1.5 }, { status: ['done'] }, { milestone: 'none' }, { cursor: 'page' }]) {
    assert.equal((await facade.callTool(trendTool, { ...target, ...extension })).error.code, 'MCP_INVALID_ARGUMENTS');
  }
  const { project_id: _project, ...workspace } = target;
  for (const project_ids of [[], Array.from({ length: 101 }, () => randomUUID()), [target.project_id, target.project_id]]) {
    assert.equal((await facade.callTool(workspaceTool, { ...workspace, project_ids })).error.code, 'MCP_INVALID_ARGUMENTS');
  }
});
