import assert from 'node:assert/strict';
import test from 'node:test';
import { assertGenericApiPathIsNonSensitive, createBrowserLaunchAndDeliver, guardedApiRequest, relayToBrowser } from '../../packages/skill-runtime/src/capability-delivery.mjs';
import { apiRequest } from '../../packages/skill-runtime/src/transport.mjs';
import { getInstancePaths } from '../../packages/skill-runtime/src/state.mjs';
import { atomicWriteJson, readJson } from '../../packages/skill-runtime/src/utils.mjs';
import { randomUUID } from 'node:crypto';
import { createMcpStateFixture } from './mcp-fixture.mjs';
import { dispatch } from '../../packages/skill-runtime/src/cli.mjs';
import { retainPendingWaf } from '../../packages/skill-runtime/src/waf-pending.mjs';

test('Cloudflare secret input cannot enter generic API requests, including normalized paths', async () => {
  let sent = 0;
  for (const apiPath of [
    '/api/v1/admin/cloudflare/secrets',
    '/api/v1/admin/cloudflare/secrets/',
    '/api/v1/admin/cloudflare/secrets?source=owner',
    '/api/v1/admin/cloudflare/%73ecrets',
    '/api/v1/admin/cloudflare/ignored/../secrets',
  ]) {
    await assert.rejects(guardedApiRequest({ method: 'post', apiPath, body: { kind: 'connection', token: 'synthetic-browser-input-only', expected_version: 1 }, fetchImpl: async () => { sent++; } }), error => {
      assert.equal(error.code, 'SENSITIVE_DELIVERY_REQUIRED');
      assert.equal(error.details.settings_path, '/app/admin');
      return true;
    });
  }
  assert.equal(sent, 0);
  assert.doesNotThrow(() => assertGenericApiPathIsNonSensitive({ method: 'GET', apiPath: '/api/v1/admin/cloudflare' }));
  assert.doesNotThrow(() => assertGenericApiPathIsNonSensitive({ method: 'POST', apiPath: '/api/v1/admin/cloudflare/rate-limits/plan' }));
});
test('安全 runtime CLI 的统一 Secret 请求在普通参数入口被拒绝，错误只指向管理概览', async () => {
  await assert.rejects(dispatch('api request', { method: 'POST', apiPath: '/api/v1/admin/cloudflare/secrets', body: { kind: 'connection', token: 'synthetic-input-must-not-leak', expected_version: 1 } }), error => {
    assert.equal(error.code, 'SENSITIVE_DELIVERY_REQUIRED'); assert.equal(error.details.settings_path, '/app/admin');
    assert.ok(!JSON.stringify(error).includes('synthetic-input-must-not-leak')); return true;
  });
});

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

test('internal WAF origin proofs cannot enter ordinary API input or operation journals', async () => {
  let writes=0;
  for(const apiPath of ['/.well-known/cfkanban-waf-proof','/.well-known/cfkanban-waf-proof/','/.well-known/%63fkanban-waf-proof','/.well-known/ignored/../cfkanban-waf-proof'])for(const method of ['GET','POST']) {
    await assert.rejects(guardedApiRequest({method,apiPath,body:{nonce:'transient-proof-must-not-enter-output'},fetchImpl:async()=>{writes++;}}),error=>{assert.equal(error.code,'INTERNAL_SERVICE_PROOF_REQUIRED');assert.ok(!JSON.stringify(error).includes('transient-proof-must-not-enter-output'));return true;});
  }
  assert.equal(writes,0);
});

test('ordinary Skill mutations cannot bypass the retained deployment WAF intent',async t=> {
  const f=await createMcpStateFixture(t);
  await retainPendingWaf(f,{operation_id:randomUUID(),kind:'isolated-original-waf-plan'});
  let sent=0;
  for(const apiPath of ['/api/v1/admin/cloudflare/waf/plan','/api/v1/admin/cloudflare/waf/apply','/api/v1/admin/cloudflare/%77af/target-binding','/api/v1/admin/cloudflare/ignored/../settings','/api/v1/admin/instance-origin']) {
    await assert.rejects(guardedApiRequest({...f,method:'POST',apiPath,fetchImpl:async()=>{sent++;}}),{code:'WAF_PENDING_OPERATION_REQUIRED'});
  }
  assert.equal(sent,0);
  const readPaths=[];
  const result=await guardedApiRequest({...f,method:'GET',apiPath:'/api/v1/admin/cloudflare/waf',fetchImpl:async(url,options)=>{sent++;assert.equal(options.method,'GET');readPaths.push(new URL(url).pathname);return Response.json({status:'unverified'});}});
  assert.equal(result.ok,true);assert.equal(readPaths.filter(value=>value==='/api/v1/admin/cloudflare/waf').length,1);
});
