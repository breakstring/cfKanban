import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMcpFacade } from '../../packages/skill-runtime/src/mcp-facade.mjs';
import { createMcpStateFixture } from './mcp-fixture.mjs';

const serviceFetch = (fixture, handler) => async (url, options) => {
  assert.equal(url.origin, fixture.origin);
  assert.equal(options.redirect, 'manual');
  if (url.pathname === '/.well-known/cfkanban-instance.json') return Response.json(fixture.discovery);
  if (url.pathname === '/api/v1/me') return Response.json(fixture.me(fixture.credential));
  return handler(url, options);
};

test('MCP forwards milestone creation, explicit null membership and bounded filters', async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const facade = createMcpFacade({ ...f, fetchImpl: serviceFetch(f, (url, options) => {
    calls.push({ url, options });
    return Response.json({ items: [], resource: { id: randomUUID() } });
  }) });
  const created = await facade.callTool('cfkanban_milestones_create', { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId, title: '阶段', due_date: null, idempotency_key: 'create-goal' });
  assert.equal(created.ok, true);
  assert.equal(new Headers(calls.at(-1).options.headers).get('idempotency-key'), 'create-goal');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { title: '阶段', due_date: null });
  await facade.callTool('cfkanban_issues_update', { instance_id: f.instanceId, identifier: 'CFK-1', expected_version: 2, changes: { milestone_id: null }, idempotency_key: 'remove-goal' });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { expected_version: 2, milestone_id: null });
  await facade.callTool('cfkanban_issues_list', { instance_id: f.instanceId, project_ids: [f.projectId], milestone: 'none', limit: 7 });
  assert.equal(calls.at(-1).url.searchParams.get('milestone'), 'none');
  assert.equal(calls.at(-1).url.searchParams.get('limit'), '7');
});

test('bound milestone tools reject a foreign Project before any write', async t => {
  const f = await createMcpStateFixture(t);
  let writes = 0;
  const facade = createMcpFacade({ ...f, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] }, fetchImpl: serviceFetch(f, (_url, options) => {
    if (options.method !== 'GET') writes++;
    return Response.json({ id: randomUUID(), project_id: randomUUID() });
  }) });
  const result = await facade.callTool('cfkanban_milestones_update', { instance_id: f.instanceId, milestone_id: randomUUID(), expected_version: 1, changes: { status_key: 'closed' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MCP_PROJECT_BINDING_MISMATCH');
  assert.equal(writes, 0);
});

test('unknown milestone PATCH retains CAS request without suggesting automatic replay', async t => {
  const f = await createMcpStateFixture(t);
  let requests = 0;
  const facade = createMcpFacade({ ...f, fetchImpl: serviceFetch(f, () => {
    requests++;
    return Response.json({ code: 'PLATFORM_UNAVAILABLE', category: 'platform_failure', source: 'service', recovery: 'retry_later', message: 'Unavailable', retryable: true, request_id: randomUUID(), details: {} }, { status: 503 });
  }) });
  const input = { instance_id: f.instanceId, milestone_id: randomUUID(), expected_version: 3, changes: { due_date: null } };
  const result = await facade.callTool('cfkanban_milestones_update', input);
  assert.equal(result.outcome_unknown, true);
  assert.deepEqual(result.recovery_request.arguments, input);
  assert.equal(result.recovery_request.next_action, 'read_back_and_verify_original_operation');
  assert.equal(requests, 1);
});
