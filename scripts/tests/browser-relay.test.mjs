import assert from 'node:assert/strict';
import test from 'node:test';
import { relayToBrowser } from '../../packages/skill-runtime/src/capability-delivery.mjs';

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
