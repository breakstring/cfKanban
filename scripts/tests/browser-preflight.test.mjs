import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightBrowser } from '../../packages/skill-runtime/src/browser-preflight.mjs';
import { safeBrowserFailureCode, toolError } from '../../packages/skill-runtime/src/errors.mjs';

test('probe serves a non-sensitive page and closes after a valid navigation', async () => {
  let url;
  const result = await preflightBrowser({ onRelayReady: async (event) => {
    assert.equal(event.classification, 'non_sensitive_connectivity_probe');
    url = event.local_url;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.match(await response.text(), /preflight OK/);
  } });
  assert.equal(result.reachable, true);
  assert.equal(result.remote_writes, false);
  assert.equal(result.browser_identity_verified, false);
  await assert.rejects(fetch(url));
});

test('probe rejects cross-site and Origin requests without consuming a later valid navigation', async () => {
  const result = await preflightBrowser({ onRelayReady: async ({ local_url }) => {
    assert.equal((await fetch(local_url, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 404);
    assert.equal((await fetch(local_url, { headers: { origin: 'https://example.test' } })).status, 404);
    assert.equal((await fetch(local_url, { method: 'POST' })).status, 404);
    assert.equal((await fetch(local_url)).status, 200);
  } });
  assert.equal(result.reachable, true);
  assert.equal(result.rejected_cross_site, true);
});

test('probe times out and closes even if the host callback never resolves', async () => {
  let url;
  const result = await preflightBrowser({ timeoutMs: 30, onRelayReady: ({ local_url }) => {
    url = local_url;
    return new Promise(() => {});
  } });
  assert.equal(result.reachable, false);
  assert.equal(result.cause_code, 'BROWSER_OPEN_TIMEOUT');
  await assert.rejects(fetch(url));
});

test('system probe uses the opener and returns only allowlisted failure codes', async () => {
  const success = await preflightBrowser({ delivery: 'system_browser', browserOpener: { open: (url) => fetch(url) } });
  assert.equal(success.reachable, true);
  for (const error of [toolError('DELIVERY_HELPER_FAILED', 'private error', { secret: 'hidden' }), Object.assign(new Error('private error'), { code: 'secret-code' })]) {
    const result = await preflightBrowser({ delivery: 'system_browser', browserOpener: { open: () => { throw error; } } });
    assert.equal(result.reachable, false);
    assert.equal(result.cause_code, safeBrowserFailureCode(error));
    assert.doesNotMatch(JSON.stringify(result), /private error|hidden|secret-code/);
  }
});
