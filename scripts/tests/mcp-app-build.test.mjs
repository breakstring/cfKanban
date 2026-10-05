import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCP_BUILD_FILES, verifyMcpBuild } from '../lib/mcp-build.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cfkanban-ui-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = 'void 0;';
  const scriptHash = createHash('sha256').update(code).digest('base64');
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'"><style>body{margin:0}</style></head><body><script>${code}</script></body></html>`;
  const version = '1.9.1';
  const files = { 'server.mjs': 'export const server = true;', 'facade.mjs': 'export const facade = true;', 'workbench.html': html, 'mcp-app-build.json': JSON.stringify({ schema_version: 1, protocol: 1, entry: 'workbench.html', release_version: version, size_bytes: Buffer.byteLength(html), sha256: hash(html) }), 'THIRD_PARTY_NOTICES.txt': 'Fixture licenses' };
  const metadata = { schema_version: 1, name: 'cfkanban-mcp', release_version: version, node_range: '>=22.12.0', transport: 'stdio', entries: ['server.mjs', 'facade.mjs', 'workbench.html', 'mcp-app-build.json'].map(name => ({ path: name, size_bytes: Buffer.byteLength(files[name]), sha256: hash(files[name]) })), dependencies: [] };
  files['build-metadata.json'] = JSON.stringify(metadata);
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(root, name), value);
  return { root, version };
}

test('MCP UI artifact requires matching complete release, exact files and UI digest', async t => {
  const f = await fixture(t);
  assert.equal((await verifyMcpBuild({ outputDirectory: f.root, version: f.version })).release_version, f.version);
  await assert.rejects(verifyMcpBuild({ outputDirectory: f.root, version: '1.9.2' }));
  await writeFile(path.join(f.root, 'workbench.html'), 'tampered');
  await assert.rejects(verifyMcpBuild({ outputDirectory: f.root, version: f.version }));
  assert.equal(MCP_BUILD_FILES.length, 6);
});

test('MCP UI artifact rejects extra files and symlinked resources before packaging', async t => {
  const f = await fixture(t);
  const htmlPath = path.join(f.root, 'workbench.html');
  const original = await readFile(htmlPath);
  await writeFile(path.join(f.root, 'unverified.mjs'), 'extra');
  await assert.rejects(verifyMcpBuild({ outputDirectory: f.root, version: f.version }));
  await rm(path.join(f.root, 'unverified.mjs'));
  const external = path.join(f.root, '..', `${path.basename(f.root)}.html`);
  t.after(() => rm(external, { force: true }));
  await writeFile(external, original);
  await rm(htmlPath);
  await symlink(external, htmlPath);
  await assert.rejects(verifyMcpBuild({ outputDirectory: f.root, version: f.version }));
});
