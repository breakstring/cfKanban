import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from '../src/parser.mjs';
import { createCliRuntime } from '../src/runtime.mjs';
import { createMcpStateFixture } from '../../../scripts/tests/mcp-fixture.mjs';

test('public Issue list, Project list, candidates and counts expose the same optional typed mode', async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const runtime = createCliRuntime({ ...f, scopeInspector: () => assert.fail('Explicit Project must not resolve repository scope'),
    fetchImpl: async url => {
      url = new URL(url);
      if (url.pathname === '/.well-known/cfkanban-instance.json') return Response.json(f.discovery);
      if (url.pathname === '/api/v1/me') return Response.json(f.me(f.credential));
      throw new Error('Unexpected fixture request');
    }, requestImpl: async options => { calls.push(options); return { ok: true, status: 200, data: { items: [], has_more: false, next_cursor: null } }; } });
  const cases = [
    ['issue','list','--project',f.projectId],
    ['project','issue','list','--workspace-id',f.workspaceId,'--project-id',f.projectId],
    ['issue','candidates','--project',f.projectId,'--assignment','mine'],
    ['issue','counts','--workspace-id',f.workspaceId,'--project-id',f.projectId],
  ];
  for (const argv of cases) {
    const typed = await parseArguments([...argv,'--instance',f.instanceId,'--q-mode','typed','--q','62']);
    assert.equal(typed.input.q_mode,'typed'); assert.equal(typed.command.effect,'read');
    await runtime.execute(typed.command,typed.input);
    const request = calls.at(-1); const url = new URL(request.apiPath,f.origin);
    assert.equal(request.method,'GET'); assert.equal(url.searchParams.get('q_mode'),'typed'); assert.equal(url.searchParams.get('q'),'62');
    const legacy = await parseArguments([...argv,'--instance',f.instanceId,'--q','62']);
    await runtime.execute(legacy.command,legacy.input);
    assert.equal(new URL(calls.at(-1).apiPath,f.origin).searchParams.has('q_mode'),false);
    await assert.rejects(parseArguments([...argv,'--instance',f.instanceId,'--q-mode','legacy','--q','62']),{code:'CLI_INVALID_ARGUMENT'});
  }
});
