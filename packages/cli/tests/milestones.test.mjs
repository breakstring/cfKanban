import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { API_COMMANDS } from '../src/catalog.mjs';
import { parseArguments } from '../src/parser.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';

const command = name => API_COMMANDS.find(entry => entry.name === name);
const authenticatedFetch = fixture => async (url, options) => {
  assert.equal(url.origin, fixture.origin);
  assert.equal(options.signal instanceof AbortSignal, true);
  if (url.pathname === '/.well-known/cfkanban-instance.json') return Response.json(fixture.discovery);
  if (url.pathname === '/api/v1/me') return Response.json(fixture.me(fixture.credential));
  assert.fail('Unexpected fixture request');
};

test('Issue membership is nullable and milestone filters remain scalar across all public queries', async () => {
  const id = randomUUID();
  const removed = await parseArguments(['issue', 'update', '--instance', id, '--identifier', 'CFK-1', '--expected-version', '4', '--milestone-id', 'null']);
  assert.equal(removed.input.milestone_id, null);
  for (const words of [['issue', 'list'], ['issue', 'counts'], ['issue', 'candidates']]) {
    const required = words[1] === 'candidates' ? ['--assignment', 'unassigned'] : words[1] === 'counts' ? ['--workspace-id', id, '--project-id', id] : [];
    const parsed = await parseArguments([...words, '--instance', id, '--milestone', 'none', ...required]);
    assert.equal(parsed.input.milestone, 'none');
  }
  await assert.rejects(parseArguments(['milestone', 'update', '--instance', id, '--milestone-id', id, '--expected-version', '1', '--status-key', 'closed', '--idempotency-key', 'unsupported']), { code: 'CLI_UNKNOWN_OPTION' });
});

test('milestone creation reads back its exact resource and closing uses CAS-only', async t => {
  const fixture = await createMcpStateFixture(t);
  const id = randomUUID();
  const calls = [];
  let resource = { id, title: '交付目标', due_date: null, status_key: 'open', version: 1 };
  const runtime = createCliRuntime({ ...fixture, fetchImpl: authenticatedFetch(fixture), requestImpl: async options => {
    calls.push(options);
    if (options.method === 'POST') return { ok: true, status: 200, data: { resource } };
    if (options.method === 'PATCH') {
      assert.equal(options.body.expected_version, 1);
      assert.equal(options.idempotencyKey, undefined);
      resource = { ...resource, status_key: options.body.status_key, version: 2 };
      return { ok: true, status: 200, data: { resource } };
    }
    return { ok: true, status: 200, data: resource };
  } });
  const created = await runtime.execute(command('milestone create'), { instanceId: fixture.instanceId, workspace_id: fixture.workspaceId, project_id: fixture.projectId, title: resource.title, idempotencyKey: 'milestone-create-key' });
  assert.equal(created.operation.phase, 'verified');
  assert.equal(calls.at(-1).apiPath, `/api/v1/milestones/${id}`);
  assert.equal(calls.find(call => call.method === 'POST').idempotencyKey, 'milestone-create-key');
  const closed = await runtime.execute(command('milestone update'), { instanceId: fixture.instanceId, milestone_id: id, expected_version: 1, status_key: 'closed' });
  assert.equal(closed.operation.phase, 'verified');
  assert.equal(closed.operation.write_contract, 'cas');
  assert.equal(closed.readback.data.status_key, 'closed');
});
