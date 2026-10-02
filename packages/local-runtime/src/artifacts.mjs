import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalRuntimeError } from './errors.mjs';

const FILES = ['server.mjs', 'launcher.mjs', 'browser.mjs', 'workbench.mjs', 'THIRD_PARTY_NOTICES.txt', 'embedded/embedded.html', 'embedded/embedded-build.json'];
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export function defaultArtifactRoot() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(directory) === 'src' ? path.resolve(directory, '../dist') : directory;
}
async function regularFile(root, relative) {
  let current = root;
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() || stat.size > MAX_ARTIFACT_BYTES : !stat.isDirectory())) throw new LocalRuntimeError('LOCAL_ARTIFACT_INVALID');
  }
  return readFile(current);
}
export async function loadLocalArtifacts({ artifactRoot = defaultArtifactRoot(), version } = {}) {
  try {
    const rootStat = await lstat(artifactRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new LocalRuntimeError('LOCAL_ARTIFACT_INVALID');
    const metadata = JSON.parse(await regularFile(artifactRoot, 'build-metadata.json'));
    if (metadata.schema_version !== 1 || metadata.protocol !== 1 || metadata.node_range !== '>=22.12.0' || metadata.release_version !== version
      || !metadata.files || Object.keys(metadata.files).length !== FILES.length || Object.keys(metadata.files).some(file => !FILES.includes(file))) throw new LocalRuntimeError('LOCAL_ARTIFACT_INVALID');
    const files = new Map();
    for (const file of FILES) {
      const expected = metadata.files[file];
      const bytes = await regularFile(artifactRoot, file);
      if (!expected || expected.size_bytes !== bytes.length || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? '') || expected.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new LocalRuntimeError('LOCAL_ARTIFACT_INVALID');
      files.set(file, bytes);
    }
    const embedded = JSON.parse(files.get('embedded/embedded-build.json'));
    const html = files.get('embedded/embedded.html');
    if (embedded.schema_version !== 1 || embedded.protocol !== 1 || embedded.entry !== 'embedded.html' || embedded.release_version !== version || embedded.size_bytes !== html.length || embedded.sha256 !== createHash('sha256').update(html).digest('hex')) throw new LocalRuntimeError('LOCAL_ARTIFACT_INVALID');
    return { html: html.toString('utf8'), browserScript: files.get('browser.mjs').toString('utf8'), metadata };
  } catch { throw new LocalRuntimeError('LOCAL_ARTIFACT_INVALID'); }
}
