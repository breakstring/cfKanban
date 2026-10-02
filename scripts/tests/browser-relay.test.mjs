import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserLaunchAndDeliver, relayToBrowser } from '../../packages/skill-runtime/src/capability-delivery.mjs';
import { apiRequest } from '../../packages/skill-runtime/src/transport.mjs';
import { getInstancePaths } from '../../packages/skill-runtime/src/state.mjs';
import { atomicWriteJson, readJson } from '../../packages/skill-runtime/src/utils.mjs';
import { randomUUID } from 'node:crypto';
import { createMcpStateFixture } from './mcp-fixture.mjs';

test('relay expires even when the host callback never resolves and closes its listener', async () => {
  let localUrl;
  await assert.rejects(relayToBrowser('https://example.test/app/launch?code=test', (url) => {
    localUrl = url;
    return new Promise(() => {});
  }, { timeoutMs: 30 }), (error) => error.code === 'BROWSER_OPEN_TIMEOUT');
  await assert.rejects(fetch(localUrl));
});

test('relay discloses the target at most once under concurrent requests', async () => {
  let responses;
  await relayToBrowser('https://example.test/app/launch?code=test', async (url) => {
    responses = await Promise.allSettled(Array.from({ length: 4 }, () => fetch(url, { redirect: 'manual' })));
  });
  assert.equal(responses.filter((r) => r.status === 'fulfilled' && r.value.status === 302).length, 1);
});

test('a bound browser launch rejects identity switching between readback and POST', async t => {
  const f = await createMcpStateFixture(t);
  let writes = 0;
  const fetchImpl = async (url, options) => {
    if (url.pathname === '/.well-known/cfkanban-instance.json') {
      const file = getInstancePaths(f).currentMetadata;
      await atomicWriteJson(file, { ...await readJson(file), principal_id: randomUUID() });
      return Response.json(f.discovery);
    }
    if (options.method === 'POST') writes++;
    throw new Error('An identity mismatch must not send a credential');
  };
  await assert.rejects(createBrowserLaunchAndDeliver({ ...f, expectedPrincipalId: f.principalId,
    target: { kind: 'project', workspace_id: f.workspaceId, project_id: f.projectId },
    idempotencyKey: randomUUID(), delivery: 'system_browser', browserOpener: { open() {} }, fetchImpl,
  }), error => error.code === 'PRINCIPAL_BINDING_MISMATCH');
  assert.equal(writes, 0);
});

test('a bound request accepts same-Principal credential rotation', async t => {
  const f = await createMcpStateFixture(t);
  await f.rotate();
  let reads = 0;
  const result = await apiRequest({ ...f, expectedPrincipalId: f.principalId, apiPath: '/api/v1/me',
    fetchImpl: async (_url, options) => { reads++; assert.match(new Headers(options.headers).get('authorization'), /^Bearer /); return Response.json({ principal_id: f.principalId }); },
  });
  assert.equal(result.ok, true);
  assert.equal(reads, 1);
});

test('authenticated API paths cannot normalize into a different origin', async t => {
  const f = await createMcpStateFixture(t);
  let sent = 0;
  const fetchImpl = async () => { sent++; throw new Error('Cross-origin request must be rejected'); };
  for (const apiPath of [
    '/\\outside.fixture.invalid/api',
    '/\t/outside.fixture.invalid/api',
    '/\r/outside.fixture.invalid/api',
    '/\n/outside.fixture.invalid/api',
    '//user:password@outside.fixture.invalid/api',
  ]) {
    await assert.rejects(apiRequest({ ...f, apiPath, fetchImpl }), error => error.code === 'INVALID_API_PATH');
  }
  assert.equal(sent, 0);
  const result = await apiRequest({ ...f, apiPath: '/api/v1/me?limit=20', fetchImpl: async url => {
    sent++;
    assert.equal(url.origin, f.origin);
    assert.equal(url.pathname, '/api/v1/me');
    assert.equal(url.search, '?limit=20');
    return Response.json({ principal_id: f.principalId });
  } });
  assert.equal(result.ok, true);
  assert.equal(sent, 1);
});
