import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preflightBrowser } from '../../skill-runtime/src/browser-preflight.mjs';
import { openLocalWorkbench } from '../src/launcher.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('host handoff keeps the probe tab available for a single-use authenticated local view', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfkanban-local-handoff-'));
  let runtime;
  t.after(async () => { await runtime?.close({ force: true }); await rm(directory, { recursive: true, force: true }); });
  const artifactRoot = path.join(directory, 'artifacts');
  await mkdir(path.join(artifactRoot, 'embedded'), { recursive: true });
  const version = JSON.parse(await readFile(new URL('../../../release/version.json', import.meta.url), 'utf8')).version;
  const html = Buffer.from('<!doctype html><html><body>Isolated workbench fixture</body></html>');
  const payload = {
    'server.mjs': 'export const fixture=true;', 'launcher.mjs': 'export const fixture=true;',
    'browser.mjs': 'export const fixture=true;', 'workbench.mjs': 'export const fixture=true;',
    'THIRD_PARTY_NOTICES.txt': 'Fixture licenses', 'embedded/embedded.html': html,
    'embedded/embedded-build.json': JSON.stringify({ schema_version: 1, release_version: version, protocol: 1, entry: 'embedded.html', sha256: sha256(html), size_bytes: html.length }),
  };
  const files = {};
  for (const [file, value] of Object.entries(payload)) {
    const bytes = Buffer.from(value);
    await writeFile(path.join(artifactRoot, file), bytes);
    files[file] = { sha256: sha256(bytes), size_bytes: bytes.length };
  }
  await writeFile(path.join(artifactRoot, 'build-metadata.json'), JSON.stringify({ schema_version: 1, release_version: version, protocol: 1, node_range: '>=22.12.0', files }));

  // 以导航请求模拟宿主保留的标签；不启动真实浏览器，也不把 HTTP 成功视为浏览器身份核验。
  const tab = { currentUrl: null, async navigate(url) { this.currentUrl = url; return fetch(url, { redirect: 'manual', headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }); } };
  const probe = await preflightBrowser({ onRelayReady: async event => {
    assert.equal(event.navigation_hint, 'retain_probe_tab');
    assert.match(await (await tab.navigate(event.local_url)).text(), /preflight OK/);
  } });
  assert.equal(probe.reachable, true);
  assert.equal(probe.browser_identity_verified, false);
  const probeUrl = tab.currentUrl;
  await assert.rejects(fetch(probeUrl));
  let launchUrl;
  let navigation;
  runtime = await openLocalWorkbench({ directory, artifactRoot, delivery: 'host_browser',
    createBridge: () => ({ hasPending: () => false, dispose() {} }),
    onRelayReady: async event => {
      assert.equal(event.navigation_hint, 'reuse_verified_probe_tab');
      assert.equal(event.expires_in_seconds, 60);
      assert.equal(event.classification, 'local_one_time_browser_handoff');
      assert.equal(tab.currentUrl, probeUrl);
      launchUrl = event.local_url;
      navigation = tab.navigate(launchUrl);
      await navigation;
    },
  });
  const response = await navigation;
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const viewUrl = new URL(response.headers.get('location'), launchUrl);
  const page = await fetch(viewUrl, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Isolated workbench fixture/);
  assert.equal((await fetch(launchUrl, { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(viewUrl)).status, 401);
  assert.equal(runtime.delivered, true);
  assert.doesNotMatch(JSON.stringify(runtime), /\/launch\/|\/probe|local_url|127\.0\.0\.1/);
});
