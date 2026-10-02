import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadLocalArtifacts } from '../src/artifacts.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'cfkanban-local-artifacts-'));
  const version = '1.8.0-rc.1';
  await mkdir(path.join(artifactRoot, 'embedded'));
  const html = Buffer.from('<!doctype html><html><body>Fixture</body></html>');
  const payload = { 'server.mjs': 'export const server=true;', 'launcher.mjs': 'export const launcher=true;', 'browser.mjs': 'export const browser=true;', 'workbench.mjs': 'export const workbench=true;', 'THIRD_PARTY_NOTICES.txt': 'Fixture licenses', 'embedded/embedded.html': html, 'embedded/embedded-build.json': JSON.stringify({ schema_version: 1, release_version: version, protocol: 1, entry: 'embedded.html', sha256: sha256(html), size_bytes: html.length }) };
  const files = {};
  for (const [file, value] of Object.entries(payload)) { const bytes = Buffer.from(value); await writeFile(path.join(artifactRoot, file), bytes); files[file] = { sha256: sha256(bytes), size_bytes: bytes.length }; }
  const metadata = { schema_version: 1, release_version: version, protocol: 1, node_range: '>=22.12.0', files };
  await writeFile(path.join(artifactRoot, 'build-metadata.json'), JSON.stringify(metadata));
  return { artifactRoot, version, metadata, cleanup: () => rm(artifactRoot, { recursive: true, force: true }) };
}
test('launcher validates every fixed prebuilt file and exact release metadata without compiling or downloading', async () => {
  const f = await fixture();
  try {
    const result = await loadLocalArtifacts(f);
    assert.match(result.html, /Fixture/);
    assert.match(result.browserScript, /browser/);
    await assert.rejects(loadLocalArtifacts({ ...f, version: '1.8.0' }), { code: 'LOCAL_ARTIFACT_INVALID' });
    await writeFile(path.join(f.artifactRoot, 'browser.mjs'), 'tampered');
    await assert.rejects(loadLocalArtifacts(f), { code: 'LOCAL_ARTIFACT_INVALID' });
  } finally { await f.cleanup(); }
});
test('artifact metadata cannot add paths, omit the shared workbench, or follow a script symlink', async () => {
  for (const mode of ['extra', 'missing', 'symlink']) {
    const f = await fixture();
    try {
      if (mode === 'extra') f.metadata.files['../outside'] = { sha256: '0'.repeat(64), size_bytes: 0 };
      if (mode === 'missing') delete f.metadata.files['workbench.mjs'];
      if (mode === 'symlink') {
        const bytes = await readFile(path.join(f.artifactRoot, 'browser.mjs'));
        await writeFile(path.join(f.artifactRoot, 'other.mjs'), bytes);
        await rm(path.join(f.artifactRoot, 'browser.mjs'));
        await symlink(path.join(f.artifactRoot, 'other.mjs'), path.join(f.artifactRoot, 'browser.mjs'));
      }
      await writeFile(path.join(f.artifactRoot, 'build-metadata.json'), JSON.stringify(f.metadata));
      await assert.rejects(loadLocalArtifacts(f), { code: 'LOCAL_ARTIFACT_INVALID' });
    } finally { await f.cleanup(); }
  }
});
